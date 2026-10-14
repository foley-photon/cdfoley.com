// Worker-side message handler of the test-particle Monte Carlo (spec §2.13). The worker file wires it to
// self.postMessage / self.onmessage; Node tests drive it directly or through _tests/conductance/node-worker.mjs.
//
//   main → worker                                                        worker → main
//   { type: 'load', job, kind: 'chain', blocks }                         { type: 'loaded', job, ms }
//   { type: 'load', job, kind: 'mesh', scene }                           { type: 'loaded', job, ms }
//   { type: 'batch', job, seq, block, source, n, seed, tally, paths,     { type: 'result', job, seq, block, source, n,
//     sampler, maxBounces }                                                absorbed, trans, back, leaks, stuck, casts,
//                                                                          ms, paths, hits?, tallyLaunches? }
//   { type: 'flush', job }                                               { type: 'tally', job, hits, launches }
//   { type: 'unload', job }                                              { type: 'unloaded', job }
//   (any exception)                                                      { type: 'error', job, seq, message }
//
// For mesh jobs the service keeps a cumulative Uint32Array(nTri) tally of wall hits from inlet-port launches and
// the matching cumulative launch counts per port; a result carries a transferred copy of both (`hits`,
// `tallyLaunches`) when at least 1000 ms have passed since the last copy. Result `n` excludes stuck particles.
// Pure module: no DOM, no bare imports (H7).
import { compileBlock, runChainBlock } from './chain-mc.js';
import { makeTracer } from './bvh.js';
import { runMeshBatch } from './mesh-mc.js';

const TALLY_INTERVAL_MS = 1000;
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const errText = (err) => (err && err.message ? err.message : String(err));

/** Creates a service; post(msg, transfer) sends a message to the main thread. Returns { onMessage(msg) }. */
export function createService(post) {
  const jobs = new Map();

  function load(msg) {
    const t0 = now();
    for (const k of [...jobs.keys()]) if (k !== msg.job) jobs.delete(k);   // one job at a time per worker
    if (msg.kind === 'chain') {
      const blocks = new Map();
      for (const b of msg.blocks || []) blocks.set(b.id, compileBlock(b));
      jobs.set(msg.job, { kind: 'chain', blocks });
    } else if (msg.kind === 'mesh') {
      const scene = msg.scene;
      if (!scene || !(scene.nTri > 0) || !scene.tri || !scene.box || !scene.meta || !Array.isArray(scene.ports)) {
        throw new RangeError('The simulation scene is incomplete.');
      }
      jobs.set(msg.job, {
        kind: 'mesh', scene, trace: makeTracer(scene),
        tally: new Uint32Array(scene.nTri), launches: new Float64Array(scene.ports.length),
        lastSent: -Infinity, dirty: false,
      });
    } else {
      throw new RangeError('Unknown simulation kind "' + msg.kind + '".');
    }
    post({ type: 'loaded', job: msg.job, ms: now() - t0 }, []);
  }

  function batch(msg) {
    const J = jobs.get(msg.job);
    if (!J) throw new RangeError('The simulation data are not loaded in this worker (job ' + msg.job + ').');
    const t0 = now();
    if (J.kind === 'chain') {
      const cb = J.blocks.get(msg.block);
      if (!cb) throw new RangeError('Block ' + msg.block + ' is not loaded.');
      const r = runChainBlock(cb, msg.n, msg.seed, {
        reverse: msg.source === 'out', sampler: msg.sampler || 'cosine', maxBounces: msg.maxBounces ?? 1e7,
      });
      post({
        type: 'result', job: msg.job, seq: msg.seq, block: msg.block, source: msg.source, n: r.n,
        absorbed: null, trans: r.trans, back: r.back, leaks: 0, stuck: r.stuck, casts: r.casts,
        ms: now() - t0, paths: [],
      }, []);
      return;
    }
    const scene = J.scene, src = msg.source;
    const P = scene.ports[src];
    if (!P) throw new RangeError('Port ' + src + ' does not exist.');
    const useTally = msg.tally !== false && P.role === 'inlet';
    const r = runMeshBatch(scene, J.trace, {
      source: src, n: msg.n, seed: msg.seed, tally: useTally ? J.tally : null, paths: msg.paths | 0,
      maxBounces: msg.maxBounces ?? 1e6, sampler: msg.sampler || 'cosine',
    });
    if (useTally) { J.launches[src] += r.n + r.stuck; J.dirty = true; }
    const res = {
      type: 'result', job: msg.job, seq: msg.seq, block: msg.block ?? null, source: src, n: r.n,
      absorbed: r.absorbed, trans: null, back: null, leaks: r.leaks, stuck: r.stuck, casts: r.casts,
      ms: now() - t0, paths: r.paths,
    };
    const transfer = r.paths.map((p) => p.buffer);
    const t = now();
    if (J.dirty && t - J.lastSent >= TALLY_INTERVAL_MS) {
      res.hits = J.tally.slice();
      res.tallyLaunches = Array.from(J.launches);
      transfer.push(res.hits.buffer);
      J.lastSent = t;
      J.dirty = false;
    }
    post(res, transfer);
  }

  function flush(msg) {
    const J = jobs.get(msg.job);
    if (!J || J.kind !== 'mesh') { post({ type: 'tally', job: msg.job, hits: null, launches: [] }, []); return; }
    const hits = J.tally.slice();
    J.lastSent = now(); J.dirty = false;
    post({ type: 'tally', job: msg.job, hits, launches: Array.from(J.launches) }, [hits.buffer]);
  }

  function onMessage(msg) {
    try {
      if (!msg || typeof msg !== 'object') throw new RangeError('Empty message.');
      switch (msg.type) {
        case 'load': load(msg); break;
        case 'batch': batch(msg); break;
        case 'flush': flush(msg); break;
        case 'unload': jobs.delete(msg.job); post({ type: 'unloaded', job: msg.job }, []); break;
        default: throw new RangeError('Unknown message type "' + msg.type + '".');
      }
    } catch (err) {
      post({ type: 'error', job: msg && msg.job, seq: msg && msg.seq, message: errText(err) }, []);
    }
  }

  return { onMessage };
}
