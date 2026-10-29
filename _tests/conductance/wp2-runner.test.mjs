// WP2: the main-thread runner (spec §2.14, §3.6.5; §7.3 acceptance 6): determinism across worker counts, stop,
// error propagation, tally summation, stopping rules, allocation and result shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { McRunner } from '../../beta/conductance/js/engine/mc-runner.js';
import { makeBlock } from '../../beta/conductance/js/engine/chain-mc.js';
import { chainPlan } from '../../beta/conductance/js/engine/chain-scene.js';
import { makeScene } from '../../beta/conductance/js/engine/mesh-mc.js';
import { gasState } from '../../beta/conductance/js/engine/gas.js';
import { createNodeRunner, createTpmcWorker } from './node-worker.mjs';
import { openSync, writeSync, closeSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// node --test runs files in parallel: the thread-heavy WP2 files (bvh, mesh, runner) take turns through a lock file
// in the OS temp folder, so WP2 never has more than 7 worker threads at a time (§5.4: ≤ 11 in the whole run).
const THREAD_LOCK = join(tmpdir(), 'cdfoley-conductance-wp2-threads.lock');
async function acquireThreads() {
  for (;;) {
    try { const fd = openSync(THREAD_LOCK, 'wx'); writeSync(fd, String(process.pid)); closeSync(fd); return; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const pid = Number(readFileSync(THREAD_LOCK, 'utf8'));
        let alive = pid > 0;
        if (alive) { try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; } }
        if (!alive || Date.now() - statSync(THREAD_LOCK).mtimeMs > 180000) unlinkSync(THREAD_LOCK);
      } catch (_) { /* released meanwhile */ }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
function releaseThreads() { try { if (Number(readFileSync(THREAD_LOCK, 'utf8')) === process.pid) unlinkSync(THREAD_LOCK); } catch (_) { /* gone */ } }
test.before(acquireThreads);
test.after(releaseThreads);

const N2 = gasState('N2', 293.15);
const tubePlan = (L = 10) => ({ blocks: [makeBlock({ id: 0, label: 'tube', cells: [{ type: 'tube', R: 1, L }] })], tree: { k: 'block', id: 0 }, kind: 'C', notes: [] });
const det = (seed, N, extra = {}) => ({ deterministic: true, fixedN: N, seed, batch: 20000, maxTime: Infinity, ...extra });

function coneMesh(R1, R2, L, n = 32, m = 40) {
  const tris = [], port = [];
  const P = (k, j) => { const z = L * j / m, r = R1 + (R2 - R1) * j / m; return [r * Math.cos(2 * Math.PI * k / n), r * Math.sin(2 * Math.PI * k / n), z]; };
  for (let j = 0; j < m; j++) for (let k = 0; k < n; k++) { const a = P(k, j), b = P(k + 1, j), c = P(k + 1, j + 1), d = P(k, j + 1); tris.push([a, b, c], [a, c, d]); port.push(-1, -1); }
  for (const [j, g] of [[0, 0], [m, 1]]) for (let k = 0; k < n; k++) { tris.push([[0, 0, L * j / m], P(k, j), P(k + 1, j)]); port.push(g); }
  const tri = new Float32Array(9 * tris.length);
  tris.forEach((t, i) => t.forEach((v, q) => v.forEach((x, k) => { tri[9 * i + 3 * q + k] = x; })));
  return makeScene(tri, Int16Array.from(port), [{ name: 'Inlet', role: 'inlet', stick: 1, inward: [0, 0, 1] }, { name: 'Outlet', role: 'outlet', stick: 1, inward: [0, 0, -1] }]);
}

test('deterministic runs give identical counts with 1, 2 and 7 workers (chain and mesh)', async () => {
  const scene = coneMesh(0.02, 0.012, 0.04);
  const chainRes = [], meshRes = [];
  for (const w of [1, 2, 7]) {
    const mc = createNodeRunner({ workers: w });
    const rc = await mc.runChain(tubePlan(), N2, det(20261012, 150000));
    chainRes.push(JSON.stringify(rc.blocks.map((b) => [b.in, b.out])) + rc.value);
    const rm = await mc.runMesh(scene, N2, det(20261012, 100000, { batch: 7000, tally: true, paths: 4 }));
    meshRes.push(JSON.stringify([rm.perSource, rm.C, Array.from(rm.hits), rm.inletLaunches, rm.paths.map((p) => Array.from(p))]));
    assert.equal(rc.reason, 'fixed'); assert.equal(rc.stopped, false);
    assert.equal(rc.particles, 150000);
    assert.equal(rm.particles, 100000);
    mc.dispose();
  }
  assert.equal(chainRes[1], chainRes[0]); assert.equal(chainRes[2], chainRes[0]);
  assert.equal(meshRes[1], meshRes[0]); assert.equal(meshRes[2], meshRes[0]);
});

test('stop() resolves within 300 ms with stopped: true, and the runner is reusable', async () => {
  const mc = createNodeRunner({ workers: 2 });
  for (const kind of ['chain', 'mesh']) {
    const p = kind === 'chain'
      ? mc.runChain(tubePlan(100), N2, { target: 1e-5, maxTime: 30 })
      : mc.runMesh(coneMesh(0.02, 0.01, 0.2), N2, { target: 1e-5, maxTime: 30 });
    assert.equal(mc.busy, true);
    await assert.rejects(mc.runChain(tubePlan(), N2, {}), /Another simulation is running \(Stop it first\)\./);
    await new Promise((r) => setTimeout(r, 400));
    const t0 = performance.now();
    mc.stop();
    const r = await p;
    assert.ok(performance.now() - t0 < 300, 'resolved in ' + (performance.now() - t0) + ' ms');
    assert.equal(r.stopped, true);
    assert.equal(r.reason, 'stopped');
    assert.ok(r.particles > 0);
    assert.equal(mc.busy, false);
  }
  const again = await mc.runChain(tubePlan(), N2, det(1, 20000));
  assert.equal(again.particles, 20000);
  mc.dispose();
});

test('errors propagate as rejections with readable messages', async () => {
  const mc = createNodeRunner({ workers: 2 });
  const bad = { blocks: [makeBlock({ id: 0, cells: [{ type: 'elbow', R: 1, A: 0.5, B: 3 }] })], tree: { k: 'block', id: 0 }, kind: 'C', notes: [] };
  await assert.rejects(mc.runChain(bad, N2, det(1, 1000)), /^Error: Each elbow leg must be at least the bore radius\.$/);
  assert.equal(mc.busy, false);
  await assert.rejects(mc.runChain({ unsupported: ['Add at least one element.'] }, N2, {}), /Add at least one element\./);
  await assert.rejects(mc.runChain(tubePlan(), null, {}), /gas state/);
  await assert.rejects(mc.runChain(tubePlan(), N2, { deterministic: true }), /fixedN/);
  const noOutlet = coneMesh(0.02, 0.01, 0.05);
  noOutlet.ports = noOutlet.ports.map((p) => ({ ...p, role: 'inlet' }));
  await assert.rejects(mc.runMesh(noOutlet, N2, {}), /Select an outlet or a pump/);
  const ok = await mc.runChain(tubePlan(), N2, det(2, 1000));
  assert.equal(ok.particles, 1000);
  mc.dispose();
  // a worker that cannot start
  const broken = new McRunner({ createWorker: () => { const w = createTpmcWorker(); setTimeout(() => w.onerror({ message: 'module workers are not supported' }), 10); return w; }, workers: 1 });
  await assert.rejects(broken.runChain(tubePlan(), N2, det(3, 1e6)), /^Error: The simulation worker failed: module workers are not supported$/);
  broken.dispose();
  assert.throws(() => new McRunner({}), TypeError);
});

test('per-worker tallies: the runner keeps the latest cumulative tally of each worker and sums them', async () => {
  const scene = coneMesh(0.02, 0.01, 0.05, 8, 4);
  const fakes = [];
  const factory = () => {
    const w = { onmessage: null, onerror: null, batches: 0, launched: 0, idx: fakes.length };
    const tallyOf = () => Uint32Array.from({ length: scene.nTri }, (_, s) => (w.idx + 1) * w.batches * (s + 1));
    w.postMessage = (m) => setTimeout(() => {
      if (m.type === 'load') w.onmessage({ data: { type: 'loaded', job: m.job, ms: 0 } });
      else if (m.type === 'batch') {
        w.batches++;
        if (m.source === 0) w.launched += m.n;
        const res = { type: 'result', job: m.job, seq: m.seq, block: null, source: m.source, n: m.n, absorbed: Float64Array.from([0, m.n]), trans: null, back: null, leaks: 0, stuck: 0, casts: m.n, ms: 1, paths: [] };
        if (w.batches % 2 === 1) { res.hits = tallyOf(); res.tallyLaunches = [w.launched, 0]; }   // a stale copy now and then
        w.onmessage({ data: res });
      } else if (m.type === 'flush') w.onmessage({ data: { type: 'tally', job: m.job, hits: tallyOf(), launches: [w.launched, 0] } });
    }, 0);
    w.terminate = () => {};
    fakes.push(w);
    return w;
  };
  const mc = new McRunner({ createWorker: factory, workers: 3 });
  const r = await mc.runMesh(scene, N2, det(9, 30000, { batch: 1000, tally: true }));
  const want = new Uint32Array(scene.nTri);
  for (let s = 0; s < scene.nTri; s++) for (const w of fakes) want[scene.origTri[s]] += (w.idx + 1) * w.batches * (s + 1);
  assert.deepEqual(Array.from(r.hits), Array.from(want));
  assert.deepEqual(r.inletLaunches, [{ port: 0, n: fakes.reduce((s, w) => s + w.launched, 0) }]);
  assert.equal(r.inletLaunches[0].n, 15000);
  assert.equal(fakes.reduce((s, w) => s + w.batches, 0), 30);
  mc.dispose();
});

test('adaptive chain run: the default preset reaches ±1 % and agrees with the reference 138.03 ± 0.16 L/s', async () => {
  const mc = createNodeRunner({ workers: 4 });
  const items = [{ t: 'tube', d: 0.1, L: 0.2 }, { t: 'elbow', d: 0.1, A: 0.1, B: 0.1 }, { t: 'pump', S: 0.3, d: 0.1, label: 'Turbo' }];
  const plan = chainPlan(items, N2, { bc: { mode: 'pump', p0: 1e-4 } });
  const progress = [];
  const r = await mc.runChain(plan, N2, { target: 0.01, maxTime: 20, seed: 4242, onProgress: (p) => progress.push(p) });
  assert.equal(r.reason, 'target');
  assert.equal(r.kind, 'Seff');
  assert.ok(1.96 * r.sigma / r.value <= 0.01);
  assert.ok(r.particles >= 1e4);
  assert.ok(Math.abs(r.value * 1000 - 138.03) <= 3 * Math.hypot(r.sigma * 1000, 0.16), `${r.value * 1000} ± ${r.sigma * 1000}`);
  assert.deepEqual(r.ci95, [r.value - 1.96 * r.sigma, r.value + 1.96 * r.sigma]);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].out, null);                     // pump blocks launch only from the inlet
  assert.equal(r.seed, 4242);
  const last = progress[progress.length - 1];
  assert.equal(last.final, true);
  for (const k of ['elapsed', 'particles', 'casts', 'castsPerSec', 'value', 'ci95', 'relHalfWidth', 'etaSeconds', 'history']) assert.ok(k in last, k);
  assert.ok(last.history.length >= 1 && last.history.every((h) => 'n' in h && 'value' in h && 'lo' in h && 'hi' in h));
  mc.dispose();
});

test('two-port chain blocks launch 90 % from the smaller end; limits stop the run', async () => {
  const mc = createNodeRunner({ workers: 2 });
  const contraction = { blocks: [makeBlock({ id: 0, cells: [{ type: 'tube', R: 2, L: 4 }, { type: 'tube', R: 1, L: 4 }] })], tree: { k: 'block', id: 0 }, kind: 'C', notes: [] };
  const r = await mc.runChain(contraction, N2, det(5, 100000));
  assert.equal(r.blocks[0].out.n, 90000);                 // the outlet is the smaller end
  assert.equal(r.blocks[0].in.n, 10000);
  assert.ok(Math.abs(r.blocks[0].alpha - 0.08445) < 4 * Math.hypot(r.blocks[0].sigmaAlpha, 0.0002));
  const rp = await mc.runChain(tubePlan(100), N2, { target: 1e-6, maxParticles: 50000, maxTime: 30 });
  assert.equal(rp.reason, 'particles');
  assert.equal(rp.particles, 50000);
  const t0 = performance.now();
  const rt = await mc.runChain(tubePlan(100), N2, { target: 1e-6, maxTime: 0.3 });
  assert.equal(rt.reason, 'time');
  assert.ok(performance.now() - t0 < 1500);
  mc.dispose();
});

test('deterministic fixedN is the total of the run, shared by the simulated blocks', async () => {
  const items = [{ t: 'tube', d: 0.05, L: 0.1 }, { t: 'parallel', branches: [[{ t: 'tube', d: 0.02, L: 0.3 }], [{ t: 'tube', d: 0.03, L: 0.5 }, { t: 'elbow', d: 0.03, A: 0.05, B: 0.05 }]] }, { t: 'pump', S: 0.05, d: 0.05, label: 'Turbo' }];
  const plan = chainPlan(items, N2, { bc: { mode: 'pump', p0: 1e-4 } });
  const mc = createNodeRunner({ workers: 2 });
  const r = await mc.runChain(plan, N2, det(20261012, 30001, { batch: 4000 }));
  assert.equal(r.particles, 30001);
  assert.deepEqual(r.blocks.map((b) => b.in.n + b.in.stuck + (b.out ? b.out.n + b.out.stuck : 0)), [10001, 10000, 10000]);
  assert.deepEqual(r.blocks.map((b) => b.in.n + b.in.stuck), [9001, 9000, 9000]);       // 90 % from the inlet (equal ends)
  assert.ok(Math.abs(r.value * 1000 - 6.1532) < 4 * Math.hypot(r.sigma * 1000, 0.007), `${r.value * 1000} ± ${r.sigma * 1000}`);
  mc.dispose();
});

test('the time limit ends a run whose batches never come back (short grace period)', async () => {
  const factory = () => {
    const w = { onmessage: null, onerror: null };
    w.postMessage = (m) => { if (m.type === 'load') setTimeout(() => w.onmessage({ data: { type: 'loaded', job: m.job, ms: 0 } }), 0); };
    w.terminate = () => {};
    return w;
  };
  const mc = new McRunner({ createWorker: factory, workers: 2 });
  const t0 = performance.now();
  const r = await mc.runChain(tubePlan(), N2, { target: 0.01, maxTime: 0.2 });
  const dt = performance.now() - t0;
  assert.equal(r.reason, 'time');
  assert.equal(r.stopped, false);
  assert.equal(r.particles, 0);
  assert.ok(dt >= 650 && dt < 1500, 'resolved after ' + dt + ' ms');
  assert.equal(mc.busy, false);
  mc.dispose();
});

test('pump ports only absorb, even with a sticking coefficient of 1', async () => {
  const scene = coneMesh(0.02, 0.02, 0.05, 16, 10);
  scene.ports = scene.ports.map((p, k) => (k === 1 ? { ...p, role: 'pump', stick: 1 } : p));
  const mc = createNodeRunner({ workers: 1 });
  const r = await mc.runMesh(scene, N2, det(3, 20000));
  assert.deepEqual(r.perSource.map((s) => s.port), [0]);
  assert.ok(r.Seff && r.Seff.value > 0);
  assert.equal(r.C, null);
  assert.equal(r.reciprocity.length, 0);
  mc.dispose();
});

test('exact-only plans resolve without workers', async () => {
  let created = 0;
  const mc = new McRunner({ createWorker: () => { created++; return createTpmcWorker(); }, workers: 2 });
  const plan = chainPlan([{ t: 'orifice', shape: 'circle', d: 0.001 }], N2, { bc: { mode: 'dp' } });
  const r = await mc.runChain(plan, N2, {});
  assert.equal(created, 0);
  assert.equal(r.particles, 0);
  assert.equal(r.sigma, 0);
  assert.ok(Math.abs(r.value - Math.PI * 0.0005 ** 2 * N2.vbar / 4) < 1e-18);
  assert.equal(r.reason, 'exact');
  mc.dispose();
});

test('mesh result shape, reciprocity, paths, and the favor-small allocation', async () => {
  const mc = createNodeRunner({ workers: 3 });
  const scene = coneMesh(0.02, 0.006, 0.08);
  const r = await mc.runMesh(scene, N2, { target: 0.01, maxTime: 20, seed: 77, paths: 12, tally: true });
  assert.equal(r.reason, 'target');
  for (const k of ['ports', 'perSource', 'alpha', 'C', 'Seff', 'reciprocity', 'leaksPerMillion', 'stuck', 'hits', 'inletLaunches', 'paths', 'particles', 'casts', 'ms', 'stopped']) assert.ok(k in r, k);
  assert.equal(r.ports.length, 2);
  assert.deepEqual(r.ports.map((p) => p.role), ['inlet', 'outlet']);
  assert.equal(r.alpha.length, 2); assert.equal(r.alpha[0].length, 2);
  assert.ok(r.alpha[0][1].lo <= r.alpha[0][1].value && r.alpha[0][1].value <= r.alpha[0][1].hi);
  assert.equal(r.Seff, null);
  assert.equal(r.C.i, 0); assert.equal(r.C.j, 1);
  assert.equal(r.reciprocity.length, 1);
  assert.ok(Math.abs(r.reciprocity[0].z) < 4);
  assert.equal(r.leaksPerMillion, 0);
  assert.ok(r.hits instanceof Uint32Array && r.hits.length === scene.nTri);
  assert.ok(r.paths.length <= 12 && r.paths.length > 0);
  // favor-small: after the pilot, 85 % of the batches go to the small end (here the outlet)
  const f = await mc.runMesh(scene, N2, { target: 0.005, maxTime: 20, seed: 78, allocation: 'favor-small', tally: false });
  const outN = f.perSource.find((p) => p.port === 1).n, inN = f.perSource.find((p) => p.port === 0).n;
  assert.ok(outN > 3 * inN, `outlet ${outN}, inlet ${inN}`);
  assert.ok(Math.abs(f.C.value - r.C.value) < 4 * Math.hypot(f.C.sigma, r.C.sigma));
  mc.dispose();
});

// ---- v2.2 fix round 1: with two inlets the wall tally comes from the selected inlet alone
test('mesh runs with two inlets tally the selected inlet only, so the map is that inlet\'s pressure field', async () => {
  const base = coneMesh(0.02, 0.02, 0.04);
  const scene = { ...base, ports: base.ports.map((p) => ({ ...p, role: 'inlet' })) };
  const mc = createNodeRunner({ workers: 2 });
  try {
    const r = await mc.runMesh(scene, N2, det(31, 60000, { batch: 10000, tally: true, inletPort: 0, outletPort: 1 }));
    assert.deepEqual(r.inletLaunches.map((l) => l.port), [0]);
    assert.equal(r.inletLaunches[0].n, r.perSource.find((s) => s.port === 0).n + r.perSource.find((s) => s.port === 0).stuck);
    // symmetric tube: the single-inlet field averages 1/2 over the wall (both inlets together would give 1)
    const { toSlotOrder, wallPressure } = await import('../../beta/conductance/js/engine/mesh-mc.js');
    const p = wallPressure(scene, toSlotOrder(scene, r.hits, Uint32Array), r.inletLaunches);
    let A = 0, P = 0;
    for (let s = 0; s < scene.nTri; s++) if (scene.port[s] < 0) { A += scene.area[s]; P += p[s] * scene.area[s]; }
    assert.ok(Math.abs(P / A - 0.5) < 0.03, `mean wall p/p_in ${P / A}`);
  } finally { mc.dispose(); }
});
