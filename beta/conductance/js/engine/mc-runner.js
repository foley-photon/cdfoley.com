// Main-thread Monte Carlo runner (spec §2.14, §3.6.5): a pool of TPMC workers, batching, allocation, stopping
// rules, tallies and results. DOM-free: the worker factory is injected (browser module workers, or Node threads
// through _tests/conductance/node-worker.mjs). One run at a time.
//
// opts (both kinds): { target: 0.01, maxTime: 60 (s; Infinity or null = unlimited), maxParticles: 1e9,
//   seed: (Date.now() >>> 0), deterministic: false, fixedN: null, batch: 20000, onProgress, sampler: 'cosine',
//   maxBounces }; mesh opts add { allocation: 'equal' | 'favor-small', tally: true, paths: 40, inletPort, outletPort }.
// Deterministic runs use fixed batches of `batch` and a fixed total particle count `fixedN` (shared equally by the
// simulated chain blocks, or by the launching ports of a mesh run), so the counts do not depend on the number of
// workers. Interactive runs size their batches to about 200 ms and stop on the target, the time or the particles.
import { batchSeed, sourceKeyOf } from './rng.js';
import {
  Z95, ci95, relHalfWidth, stopReason, etaSeconds, blockEstimate, combineTree, isExactBlock, canReverse,
  summarizeMesh, defaultPorts, MIN_PARTICLES,
} from './stats.js';

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const FIRST_BATCH = 2000, MIN_BATCH = 500, MAX_BATCH = 2e6, BATCH_MS = 200, PROGRESS_MS = 100;
const HISTORY_MAX = 1000, LEAK_LIMIT_PER_MILLION = 100, LEAK_MIN_CASTS = 1e5, SCENE_MEMORY = 200e6, TIME_GRACE_MS = 500;

function sceneBytes(scene) {
  let b = 0;
  for (const k of ['tri', 'normal', 'area', 'port', 'origTri', 'box', 'meta']) if (scene[k] && scene[k].byteLength) b += scene[k].byteLength;
  for (const p of scene.ports || []) b += (p.slots ? p.slots.byteLength : 0) + (p.cdf ? p.cdf.byteLength : 0);
  return b;
}

function pumpBlockIds(node, out = new Set()) {
  if (!node) return out;
  if (node.k === 'pumpBlock') out.add(node.id);
  for (const c of node.parts || node.branches || []) pumpBlockIds(c, out);
  return out;
}

function thinHistory(h) {
  if (h.length <= HISTORY_MAX) return h;
  return h.filter((_, i) => i % 2 === 0 || i === h.length - 1);
}

export class McRunner {
  /** createWorker() → Worker-like { postMessage, onmessage, onerror, terminate }; workers = threads to use. */
  constructor(options) {
    const { createWorker, workers = 1 } = options || {};
    if (typeof createWorker !== 'function') throw new TypeError('McRunner needs a createWorker function.');
    this._create = createWorker;
    this._nWorkers = Math.max(1, Math.min(64, Math.floor(workers) || 1));
    this._pool = [];
    this._run = null;
    this._job = 0;
  }

  /** True while a run is active. */
  get busy() { return !!this._run; }

  /** Number of workers a run may use. */
  get workers() { return this._nWorkers; }

  /** Runs a ChainPlan (§2.11) and resolves with a ChainMcResult. */
  runChain(plan, G, opts) { return this._start('chain', plan, G, opts || {}); }

  /** Runs a MeshScene (§2.12) and resolves with a MeshMcResult. */
  runMesh(scene, G, opts) { return this._start('mesh', scene, G, opts || {}); }

  /** Stops dispatching; the run resolves at once with the data so far and stopped: true. */
  stop() {
    const run = this._run;
    if (run && !run.done) this._finish(run, 'stopped');
  }

  /** Terminates the workers (a running job is stopped first). */
  dispose() {
    this.stop();
    for (const s of this._pool) { s.alive = false; try { s.w.terminate(); } catch (_) { /* already gone */ } }
    this._pool = [];
  }

  // ------------------------------------------------------------------ set-up

  _start(kind, subject, G, opts) {
    if (this._run) return Promise.reject(new Error('Another simulation is running (Stop it first).'));
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    let run;
    try {
      run = kind === 'chain' ? this._setupChain(subject, G, opts) : this._setupMesh(subject, G, opts);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return promise;
    }
    Object.assign(run, { resolve, reject, done: false, stopping: null, t0: now(), lastProgress: -Infinity, history: [] });
    this._run = run;
    if (run.nothing) { this._finish(run, 'exact'); return promise; }
    let slots;
    try { slots = this._workersFor(run.nUse); } catch (err) { this._fail(run, err); return promise; }
    run.slots = slots;
    if (Number.isFinite(run.opts.maxTime) && run.opts.maxTime >= 0) {
      run.timer = setTimeout(() => {
        if (run.done) return;
        run.stopping = run.stopping || 'time';
        if (run.inflight.size === 0) this._complete(run);
        // batches still in flight get a short grace period; then the run ends with the data so far
        if (!run.done) run.graceTimer = setTimeout(() => { if (!run.done) this._finish(run, run.stopping || 'time'); }, TIME_GRACE_MS);
      }, run.opts.maxTime * 1000);
    }
    for (const s of slots) {
      if (typeof s.w.ref === 'function') s.w.ref();
      s.loaded = null;
      const msg = run.kind === 'chain'
        ? { type: 'load', job: run.job, kind: 'chain', blocks: run.units.map((u) => u.block) }
        : { type: 'load', job: run.job, kind: 'mesh', scene: run.scene };
      try { s.w.postMessage(msg); } catch (err) { this._fail(run, err); return promise; }
    }
    return promise;
  }

  _normOpts(opts) {
    const o = {
      target: 0.01, maxTime: 60, maxParticles: 1e9, seed: (Date.now() >>> 0), deterministic: false, fixedN: null,
      batch: 20000, onProgress: null, sampler: 'cosine', maxBounces: null,
      allocation: 'equal', tally: true, paths: 40, inletPort: null, outletPort: null,
    };
    for (const [k, v] of Object.entries(opts || {})) if (v !== undefined) o[k] = v;
    if (o.maxTime === null) o.maxTime = Infinity;
    if (!(o.maxParticles > 0)) o.maxParticles = Infinity;
    o.seed = Number.isFinite(o.seed) ? o.seed >>> 0 : (Date.now() >>> 0);
    o.batch = Math.max(1, Math.floor(o.batch) || 20000);
    if (o.deterministic && !(o.fixedN > 0)) throw new RangeError('A deterministic run needs a particle count (fixedN).');
    return o;
  }

  _setupChain(plan, G, opts) {
    if (!plan || plan.unsupported) throw new RangeError(plan && plan.unsupported ? plan.unsupported.join(' ') : 'There is no simulation plan.');
    if (!Array.isArray(plan.blocks) || !plan.tree) throw new RangeError('The simulation plan is not valid.');
    if (!G || !(G.vbar > 0)) throw new RangeError('The gas state is not valid.');
    const o = this._normOpts(opts);
    const pumpIds = pumpBlockIds(plan.tree);
    const units = [];
    for (const block of plan.blocks) {
      if (isExactBlock(block)) continue;
      const twoWay = canReverse(block) && !pumpIds.has(block.id);
      const dirs = [{ source: 'in', frac: 1 }];
      if (twoWay) {
        const outFirst = block.Aout < block.Ain;       // launch mostly from the smaller end
        dirs[0].frac = outFirst ? 0.1 : 0.9;
        dirs.push({ source: 'out', frac: outFirst ? 0.9 : 0.1 });
      }
      for (const d of dirs) Object.assign(d, { key: sourceKeyOf(d.source), n: 0, trans: 0, back: 0, stuck: 0, casts: 0, launched: 0, inflight: 0, batches: 0, rate: 0 });
      units.push({ id: block.id, block, dirs, byDir: Object.fromEntries(dirs.map((d) => [d.source, d])) });
    }
    const run = {
      kind: 'chain', job: ++this._job, opts: o, G, plan, units, unitById: new Map(units.map((u) => [u.id, u])),
      seq: 0, inflight: new Map(), particles: 0, casts: 0, inflightParticles: 0, remaining: Infinity, queue: null,
      nothing: units.length === 0, nUse: this._nWorkers, leaks: 0, stuck: 0,
    };
    if (o.deterministic) {
      // fixedN particles in total, shared equally by the simulated blocks and split 90/10 between the ends of a
      // two-port block; the batch list (and so every seed) depends only on the plan, fixedN, batch and seed
      const q = [], total = Math.round(o.fixedN), per = Math.floor(total / Math.max(units.length, 1));
      for (const [ui, u] of units.entries()) {
        let left = per + (ui < total - per * units.length ? 1 : 0);
        const nUnit = left;
        u.dirs.forEach((d, k) => {
          const nDir = k === u.dirs.length - 1 ? left : Math.round(nUnit * d.frac);
          left -= nDir;
          for (let done = 0; done < nDir; done += o.batch) q.push({ unit: u, dir: d, n: Math.min(o.batch, nDir - done) });
        });
      }
      q.forEach((b) => { b.seq = run.seq++; b.seed = batchSeed(o.seed, b.dir.key, b.seq); });
      run.queue = q;
    }
    return run;
  }

  _setupMesh(scene, G, opts) {
    if (!scene || !(scene.nTri > 0) || !Array.isArray(scene.ports)) throw new RangeError('There is no scene to simulate.');
    if (!G || !(G.vbar > 0)) throw new RangeError('The gas state is not valid.');
    const o = this._normOpts(opts);
    const ports = scene.ports, nP = ports.length;
    const { iIn, jOut, jPump } = defaultPorts(ports, o.inletPort, o.outletPort);
    if (iIn === null || !ports[iIn]) throw new RangeError('Select an inlet and an outlet.');
    if ((jOut === null || jOut === iIn) && jPump === null) throw new RangeError('Select an outlet or a pump as well as the inlet.');
    for (const p of ports) {
      if (!(p.stick >= 0 && p.stick <= 1)) throw new RangeError('Opening "' + (p.name || '') + '" has a sticking coefficient outside 0 to 1.');
      if (!(p.area > 0)) throw new RangeError('Opening "' + (p.name || '') + '" has no area.');
    }
    // launching ports: the inlet, and every other perfect opening (stick 1); pump ports only absorb (§3.6.5)
    const srcIdx = ports.map((p, k) => k).filter((k) => k === iIn || (ports[k].stick >= 1 && ports[k].role !== 'pump'));
    const sources = srcIdx.map((k) => ({
      port: k, key: k, absorbed: new Float64Array(nP), n: 0, leaks: 0, stuck: 0, casts: 0, launched: 0, inflight: 0,
      batches: 0, rate: 0, inlet: ports[k].role === 'inlet',
    }));
    const bytes = sceneBytes(scene);
    const nUse = Math.max(1, Math.min(this._nWorkers, Math.floor(SCENE_MEMORY / Math.max(bytes, 1))));
    const run = {
      kind: 'mesh', job: ++this._job, opts: o, G, scene, sources, bySource: new Map(sources.map((s) => [s.port, s])),
      ports: { iIn, jOut, jPump }, seq: 0, inflight: new Map(), particles: 0, casts: 0, leaks: 0, stuck: 0,
      inflightParticles: 0, remaining: Infinity, queue: null, nothing: false, nUse, tallies: new Map(),
      paths: [], pathsRequested: 0, dispatches: 0, newTally: false,
    };
    if (o.deterministic) {
      const per = Math.floor(o.fixedN / sources.length), extra = Math.round(o.fixedN) - per * sources.length;
      const need = sources.map((s, k) => per + (k < extra ? 1 : 0));
      const q = [];
      for (let round = 0; need.some((x) => x > 0); round++) {
        sources.forEach((s, k) => {
          if (need[k] <= 0) return;
          const n = Math.min(o.batch, need[k]);
          need[k] -= n;
          q.push({ unit: null, dir: s, n });
        });
      }
      q.forEach((b) => {
        b.seq = run.seq++; b.seed = batchSeed(o.seed, b.dir.key, b.seq);
        b.paths = 0;
        if (b.dir.inlet && run.pathsRequested < o.paths) { b.paths = Math.min(o.paths - run.pathsRequested, b.n); run.pathsRequested += b.paths; }
      });
      run.queue = q;
    }
    return run;
  }

  _workersFor(n) {
    this._pool = this._pool.filter((s) => s.alive);
    while (this._pool.length < n) {
      const w = this._create();
      const slot = { w, alive: true, loaded: null };
      w.onmessage = (e) => this._onMessage(slot, e ? e.data : null);
      w.onerror = (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        this._onWorkerError(slot, e);
      };
      this._pool.push(slot);
    }
    return this._pool.slice(0, n);
  }

  // ------------------------------------------------------------------ messages

  _onWorkerError(slot, e) {
    slot.alive = false;
    try { slot.w.terminate(); } catch (_) { /* gone */ }
    const run = this._run;
    if (run && !run.done && run.slots && run.slots.includes(slot)) {
      const m = e && e.message ? e.message : 'unknown error';
      this._fail(run, new Error('The simulation worker failed: ' + m));
    }
  }

  _onMessage(slot, msg) {
    const run = this._run;
    if (!msg || !run || run.done || msg.job !== run.job) return;
    switch (msg.type) {
      case 'loaded':
        slot.loaded = run.job;
        if (!run.stopping) this._dispatch(run, slot);
        else if (run.inflight.size === 0) this._complete(run);
        break;
      case 'result':
        this._onResult(run, slot, msg);
        break;
      case 'tally':
        if (msg.hits) run.tallies.set(slot, { hits: msg.hits, launches: msg.launches || [] });
        if (run.flushWait) { run.flushWait.delete(slot); if (run.flushWait.size === 0) this._finish(run, run.stopping || 'fixed'); }
        break;
      case 'error':
        this._fail(run, new Error(msg.message || 'The simulation failed.'));
        break;
      default:
        break;
    }
  }

  _onResult(run, slot, msg) {
    const b = run.inflight.get(slot);
    run.inflight.delete(slot);
    if (!b || b.seq !== msg.seq) return;
    const d = b.dir;
    d.inflight -= b.n; run.inflightParticles -= b.n;
    const launched = msg.n + msg.stuck;
    d.n += msg.n; d.stuck += msg.stuck; d.casts += msg.casts; d.launched += launched; d.batches++;
    if (msg.ms > 0) { const r = launched / Math.max(msg.ms, 0.5); d.rate = d.rate ? 0.5 * d.rate + 0.5 * r : r; }
    run.particles += launched; run.casts += msg.casts; run.stuck += msg.stuck;
    if (run.kind === 'chain') {
      d.trans += msg.trans; d.back += msg.back;
    } else {
      for (let j = 0; j < d.absorbed.length; j++) d.absorbed[j] += msg.absorbed[j] || 0;
      d.leaks += msg.leaks; run.leaks += msg.leaks;
      if (msg.hits) { run.tallies.set(slot, { hits: msg.hits, launches: msg.tallyLaunches || [] }); run.newTally = true; }
      if (msg.paths && msg.paths.length) for (const p of msg.paths) if (run.paths.length < run.opts.paths) run.paths.push(p);
      if (run.casts >= LEAK_MIN_CASTS && run.leaks / run.casts * 1e6 > LEAK_LIMIT_PER_MILLION) {
        const perM = run.leaks / run.casts * 1e6;
        const err = new Error('Particles are escaping through a gap in the mesh (' + perM.toPrecision(3) + ' per million rays). Check the open edges listed in the mesh report.');
        err.code = 'leaks';
        err.partial = this._result(run, 'leaks');
        this._fail(run, err);
        return;
      }
    }
    // stopping
    const est = this._estimate(run);
    const elapsed = (now() - run.t0) / 1000;
    if (!run.stopping) {
      if (run.queue) {
        if (run.particles >= run.opts.maxParticles) run.stopping = 'particles';
      } else {
        run.stopping = stopReason({
          value: est.value, sigma: est.sigma, particles: run.particles, counts: est.counts, elapsed,
          target: run.opts.target, maxTime: run.opts.maxTime, maxParticles: run.opts.maxParticles,
        });
        const rhw = relHalfWidth(est.value, est.sigma);
        run.remaining = rhw > run.opts.target && run.opts.target > 0 && Number.isFinite(rhw) && run.particles >= MIN_PARTICLES
          ? run.particles * ((rhw / run.opts.target) ** 2 - 1) : Infinity;
      }
    }
    this._progress(run, est, false);
    if (run.stopping) { if (run.inflight.size === 0) this._complete(run); return; }
    this._dispatch(run, slot);
    if (run.queue && run.queue.length === 0 && run.inflight.size === 0) { run.stopping = 'fixed'; this._complete(run); }
  }

  // ------------------------------------------------------------------ dispatch

  _dispatch(run, slot) {
    if (run.done || run.stopping || slot.loaded !== run.job || run.inflight.has(slot)) return;
    let b;
    if (run.queue) {
      b = run.queue.shift();
      if (!b) { if (run.inflight.size === 0) { run.stopping = 'fixed'; this._complete(run); } return; }
    } else {
      if (run.opts.maxParticles - run.particles - run.inflightParticles < 1) return;   // the rest is in flight
      b = run.kind === 'chain' ? this._pickChain(run) : this._pickMesh(run);
      if (!b) return;
      b.seq = run.seq++;
      b.seed = batchSeed(run.opts.seed, b.dir.key, b.seq);
    }
    b.dir.inflight += b.n; run.inflightParticles += b.n;
    run.inflight.set(slot, b);
    const o = run.opts;
    const msg = {
      type: 'batch', job: run.job, seq: b.seq, block: run.kind === 'chain' ? b.unit.id : null,
      source: run.kind === 'chain' ? b.dir.source : b.dir.port, n: b.n, seed: b.seed,
      // wall hits are tallied from the selected inlet only: p_t/p_in = (h_t/A_t)/(N_in/A_in) is then exact for that
      // inlet at p_in with every other opening pumping (summing tallies of several inlets mis-normalized the map)
      tally: run.kind === 'mesh' ? o.tally !== false && b.dir.port === run.ports.iIn : false, paths: b.paths || 0, sampler: o.sampler || 'cosine',
    };
    if (o.maxBounces) msg.maxBounces = o.maxBounces;
    try { slot.w.postMessage(msg); } catch (err) { this._fail(run, err); }
  }

  _batchSize(run, d) {
    let n = d.rate > 0 ? Math.round(BATCH_MS * d.rate) : FIRST_BATCH;
    n = Math.max(MIN_BATCH, Math.min(MAX_BATCH, n));
    if (Number.isFinite(run.remaining)) n = Math.min(n, Math.max(MIN_BATCH, Math.ceil(1.2 * run.remaining / run.slots.length)));
    const left = run.opts.maxParticles - run.particles - run.inflightParticles;
    if (Number.isFinite(left)) n = Math.min(n, Math.max(1, Math.floor(left)));
    return n;
  }

  _pickChain(run) {
    const units = run.units;
    // pilot: every direction gets one batch before any allocation by variance
    for (const u of units) for (const d of u.dirs) if (d.launched + d.inflight === 0) return { unit: u, dir: d, n: this._batchSize(run, d) };
    let best = null, bestScore = -1;
    if (units.length === 1) best = units[0];
    else {
      const vbar = run.G.vbar;
      const ests = new Map(units.map((u) => [u.id, blockEstimate(u.block, { in: u.byDir.in, out: u.byDir.out || null }, vbar)]));
      const leaf = (scale) => (node) => {
        const u = run.unitById.get(node.id);
        if (!u) return blockEstimate(run.plan.blocks.find((x) => x.id === node.id), null, vbar);
        const e = ests.get(node.id);
        return { value: e.value * (scale && scale.id === node.id ? scale.f : 1), sigma: e.sigma };
      };
      const X = combineTree(run.plan.tree, leaf(null)).value;
      for (const u of units) {
        const e = ests.get(u.id);
        const launched = u.dirs.reduce((s, d) => s + d.launched, 0), total = launched + u.dirs.reduce((s, d) => s + d.inflight, 0);
        if (!(launched > 0) || !(e.value > 0) || !(e.sigma > 0)) { if (bestScore < 0) { best = u; bestScore = 0; } continue; }
        const h = 1e-6;
        const dX = (combineTree(run.plan.tree, leaf({ id: u.id, f: 1 + h })).value - X) / (e.value * h);
        const cpp = Math.max(1, u.dirs.reduce((s, d) => s + d.casts, 0) / launched);
        const score = dX * dX * e.sigma * e.sigma * launched / (total * total) / cpp;
        if (score > bestScore) { bestScore = score; best = u; }
      }
    }
    // direction with the largest deficit against its share
    const total = best.dirs.reduce((s, d) => s + d.launched + d.inflight, 0);
    let dir = best.dirs[0], deficit = -Infinity;
    for (const d of best.dirs) { const x = d.frac * total - (d.launched + d.inflight); if (x > deficit) { deficit = x; dir = d; } }
    return { unit: best, dir, n: this._batchSize(run, dir) };
  }

  _pickMesh(run) {
    const S = run.sources, o = run.opts;
    let src = null;
    const pilot = S.find((s) => s.launched + s.inflight === 0);
    if (pilot) src = pilot;
    else if (o.allocation === 'favor-small' && S.length > 1 && S.every((s) => s.batches >= 2)) {
      // 85 % of batches to the port with the smallest A_k²·α_k(1 − α_k)·cost_k, the rest to the others
      const { iIn, jOut, jPump } = run.ports, partner = (k) => (k === iIn ? (jPump !== null ? jPump : jOut) : iIn);
      let fav = null, bestC = Infinity;
      for (const s of S) {
        const j = partner(s.port);
        if (j === null || !(s.n > 0)) continue;
        const a = s.absorbed[j] / s.n, A = run.scene.ports[s.port].area, cost = Math.max(1, s.casts / Math.max(s.launched, 1));
        const c = A * A * Math.max(a * (1 - a), 1 / s.n) * cost;
        if (c < bestC) { bestC = c; fav = s; }
      }
      const k = run.dispatches++ % 20;
      if (fav && k < 17) src = fav;
      else {
        const others = S.filter((s) => s !== fav);
        src = others.reduce((m, s) => (s.launched + s.inflight < m.launched + m.inflight ? s : m), others[0] || S[0]);
      }
    } else {
      src = S.reduce((m, s) => (s.launched + s.inflight < m.launched + m.inflight ? s : m), S[0]);
    }
    const n = this._batchSize(run, src);
    let paths = 0;
    if (src.inlet && run.pathsRequested < o.paths) { paths = Math.min(o.paths - run.pathsRequested, n); run.pathsRequested += paths; }
    return { unit: null, dir: src, n, paths };
  }

  // ------------------------------------------------------------------ estimates and results

  _estimate(run) {
    if (run.kind === 'chain') {
      const vbar = run.G.vbar;
      let counts = Infinity;
      const leaf = (node) => {
        const u = run.unitById.get(node.id);
        const block = u ? u.block : run.plan.blocks.find((x) => x.id === node.id);
        const e = blockEstimate(block, u ? { in: u.byDir.in, out: u.byDir.out || null } : null, vbar);
        if (u) counts = Math.min(counts, e.counts);
        return { value: e.value, sigma: e.sigma };
      };
      const r = combineTree(run.plan.tree, leaf);
      return { value: r.value, sigma: r.sigma, counts: Number.isFinite(counts) ? counts : 0 };
    }
    const sum = summarizeMesh(run.scene.ports, run.sources, run.G.vbar, { inletPort: run.ports.iIn, outletPort: run.opts.outletPort });
    const p = sum.primary;
    return { value: p ? p.value : NaN, sigma: p ? p.sigma : NaN, counts: sum.counts, summary: sum };
  }

  _summedTally(run) {
    if (!run.tallies.size) return null;
    const n = run.scene.nTri, bySlot = new Uint32Array(n), launches = new Float64Array(run.scene.ports.length);
    for (const t of run.tallies.values()) {
      for (let s = 0; s < n; s++) bySlot[s] += t.hits[s];
      (t.launches || []).forEach((x, k) => { launches[k] += x; });
    }
    const hits = new Uint32Array(n), orig = run.scene.origTri;
    for (let s = 0; s < n; s++) hits[orig ? orig[s] : s] = bySlot[s];
    const inletLaunches = [];
    run.scene.ports.forEach((p, k) => { if (p.role === 'inlet' && launches[k] > 0) inletLaunches.push({ port: k, n: launches[k] }); });
    return { hits, inletLaunches };
  }

  _result(run, reason) {
    const ms = now() - run.t0;
    const stopped = reason === 'stopped';
    if (run.kind === 'chain') {
      const vbar = run.G.vbar;
      const blocks = run.plan.blocks.map((block) => {
        const u = run.unitById.get(block.id);
        const e = blockEstimate(block, u ? { in: u.byDir.in, out: u.byDir.out || null } : null, vbar);
        const dirOut = (d) => (d ? { n: d.n, trans: d.trans, back: d.back, stuck: d.stuck, casts: d.casts } : null);
        const din = u ? u.byDir.in : null, dout = u ? u.byDir.out || null : null;
        const sum = (k) => (din ? din[k] : 0) + (dout ? dout[k] : 0);
        return {
          id: block.id, label: block.label, exact: e.exact,
          n: sum('n'), trans: sum('trans'), back: sum('back'), stuck: sum('stuck'), casts: sum('casts'),
          alpha: e.alpha, sigmaAlpha: e.sigmaAlpha, ci95: ci95(e.alpha, e.sigmaAlpha),
          C: e.value, sigma: e.sigma, in: dirOut(din), out: dirOut(dout),
        };
      });
      const est = this._estimate(run);
      return {
        value: est.value, sigma: est.sigma, ci95: ci95(est.value, est.sigma), kind: run.plan.kind, blocks,
        particles: run.particles, casts: run.casts, ms, stopped, reason, seed: run.opts.seed,
      };
    }
    const sc = run.scene, est = this._estimate(run), sum = est.summary;
    const tally = this._summedTally(run);
    return {
      ports: sc.ports.map((p, k) => ({ index: k, id: p.id, name: p.name, role: p.role, stick: p.stick, area: p.area })),
      perSource: run.sources.map((s) => ({ port: s.port, n: s.n, absorbed: Array.from(s.absorbed), leaks: s.leaks, stuck: s.stuck, casts: s.casts })),
      alpha: sum.alpha, C: sum.C, Seff: sum.Seff, reciprocity: sum.reciprocity,
      inletPort: sum.inletPort, outletPort: sum.outletPort, pumpPort: sum.pumpPort,
      leaksPerMillion: run.casts > 0 ? run.leaks / run.casts * 1e6 : 0, leaks: run.leaks, stuck: run.stuck,
      hits: tally ? tally.hits : null, inletLaunches: tally ? tally.inletLaunches : [],
      paths: run.paths, particles: run.particles, casts: run.casts, ms, stopped, reason, seed: run.opts.seed,
    };
  }

  _progress(run, est, final) {
    const fn = run.opts.onProgress;
    if (typeof fn !== 'function') return;
    const t = now();
    if (!final && t - run.lastProgress < PROGRESS_MS) return;
    run.lastProgress = t;
    const elapsed = (t - run.t0) / 1000;
    const value = est.value, sigma = est.sigma, rhw = relHalfWidth(value, sigma);
    const ci = ci95(value, sigma);
    if (Number.isFinite(value)) {
      run.history.push({ n: run.particles, value, lo: ci[0], hi: ci[1] });
      run.history = thinHistory(run.history);
    }
    const rate = elapsed > 0 ? run.particles / elapsed : 0;
    const p = {
      kind: run.kind, elapsed, particles: run.particles, casts: run.casts, castsPerSec: elapsed > 0 ? run.casts / elapsed : 0,
      value, sigma, ci95: ci, relHalfWidth: rhw,
      etaSeconds: run.queue ? null : etaSeconds({ particles: run.particles, rhw, target: run.opts.target, rate }),
      history: run.history.slice(), final: !!final,
    };
    if (run.kind === 'mesh') {
      p.partial = est.summary;
      p.leaksPerMillion = run.casts > 0 ? run.leaks / run.casts * 1e6 : 0;
      if (run.newTally || final) {
        const tally = this._summedTally(run);
        if (tally) { p.hits = tally.hits; p.inletLaunches = tally.inletLaunches; }
        run.newTally = false;
      }
      if (final) p.paths = run.paths;
    }
    try { fn(p); } catch (_) { /* a progress callback must not break the run */ }
  }

  // ------------------------------------------------------------------ completion

  _complete(run) {
    if (run.done || run.flushWait) return;
    if (run.kind === 'mesh' && run.opts.tally !== false && run.slots && run.slots.length) {
      run.flushWait = new Set(run.slots.filter((s) => s.alive && s.loaded === run.job));
      if (run.flushWait.size) {
        for (const s of run.flushWait) { try { s.w.postMessage({ type: 'flush', job: run.job }); } catch (err) { this._fail(run, err); return; } }
        return;
      }
    }
    this._finish(run, run.stopping || 'fixed');
  }

  _release(run) {
    run.done = true;
    if (run.timer) clearTimeout(run.timer);
    if (run.graceTimer) clearTimeout(run.graceTimer);
    for (const s of run.slots || []) {
      if (!s.alive) continue;
      try { s.w.postMessage({ type: 'unload', job: run.job }); } catch (_) { /* gone */ }
      if (typeof s.w.unref === 'function') s.w.unref();
    }
    if (this._run === run) this._run = null;
  }

  _finish(run, reason) {
    if (run.done) return;
    let result;
    try { result = this._result(run, reason); } catch (err) { this._fail(run, err); return; }
    this._progress(run, this._estimate(run), true);
    this._release(run);
    run.resolve(result);
  }

  _fail(run, err) {
    if (run.done) return;
    this._release(run);
    run.reject(err instanceof Error ? err : new Error(String(err)));
  }
}
