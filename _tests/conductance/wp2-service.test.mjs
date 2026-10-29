// WP2: the worker-side TPMC service and its protocol (spec §2.13; §7.3 acceptance 6), driven in-process and through
// a real worker thread (node-worker.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../../beta/conductance/js/engine/tpmc-service.js';
import { makeBlock } from '../../beta/conductance/js/engine/chain-mc.js';
import { makeScene } from '../../beta/conductance/js/engine/mesh-mc.js';
import { NodeWorker, createTpmcWorker, TPMC_WORKER_URL, defaultWorkerCount } from './node-worker.mjs';

function capture() {
  const out = [];
  const svc = createService((msg, transfer) => out.push({ msg, transfer }));
  return { svc, out, last: () => out[out.length - 1].msg };
}
function tubeScene(n = 16, m = 20) {
  const R = 0.02, L = 0.1, tris = [], port = [];
  const P = (k, z) => [R * Math.cos(2 * Math.PI * k / n), R * Math.sin(2 * Math.PI * k / n), z];
  for (let j = 0; j < m; j++) {
    const z0 = L * j / m, z1 = L * (j + 1) / m;
    for (let k = 0; k < n; k++) { const a = P(k, z0), b = P(k + 1, z0), c = P(k + 1, z1), d = P(k, z1); tris.push([a, b, c], [a, c, d]); port.push(-1, -1); }
  }
  for (const [z, g] of [[0, 0], [L, 1]]) for (let k = 0; k < n; k++) { tris.push([[0, 0, z], P(k, z), P(k + 1, z)]); port.push(g); }
  const tri = new Float32Array(9 * tris.length);
  tris.forEach((t, i) => t.forEach((v, j) => v.forEach((x, k) => { tri[9 * i + 3 * j + k] = x; })));
  return makeScene(tri, Int16Array.from(port), [{ name: 'In', role: 'inlet', stick: 1, inward: [0, 0, 1] }, { name: 'Out', role: 'outlet', stick: 1, inward: [0, 0, -1] }]);
}
const tubeBlock = (id = 0) => makeBlock({ id, label: 'tube', cells: [{ type: 'tube', R: 1, L: 4 }] });

test('chain jobs: load, batches in both directions, determinism, unload', () => {
  const { svc, out, last } = capture();
  svc.onMessage({ type: 'load', job: 7, kind: 'chain', blocks: [tubeBlock(0), tubeBlock(3)] });
  assert.equal(last().type, 'loaded'); assert.equal(last().job, 7); assert.ok(last().ms >= 0);
  const batch = { type: 'batch', job: 7, seq: 0, block: 3, source: 'in', n: 3000, seed: 99, tally: false, paths: 0, sampler: 'cosine' };
  svc.onMessage(batch);
  const r = last();
  assert.deepEqual(Object.keys(r).sort(), ['absorbed', 'back', 'block', 'casts', 'job', 'leaks', 'ms', 'n', 'paths', 'seq', 'source', 'stuck', 'trans', 'type'].sort());
  assert.equal(r.type, 'result'); assert.equal(r.block, 3); assert.equal(r.source, 'in'); assert.equal(r.seq, 0);
  assert.equal(r.n + r.stuck, 3000); assert.equal(r.trans + r.back, r.n); assert.equal(r.leaks, 0); assert.equal(r.absorbed, null);
  svc.onMessage(batch);
  assert.deepEqual({ ...last(), ms: 0 }, { ...r, ms: 0 });          // same seed, same counts
  svc.onMessage({ ...batch, seq: 1, source: 'out' });
  assert.equal(last().source, 'out');
  svc.onMessage({ ...batch, block: 9 });
  assert.equal(last().type, 'error'); assert.match(last().message, /Block 9/); assert.equal(last().seq, 0);
  svc.onMessage({ type: 'unload', job: 7 });
  assert.deepEqual(last(), { type: 'unloaded', job: 7 });
  svc.onMessage(batch);
  assert.equal(last().type, 'error'); assert.equal(last().job, 7); assert.match(last().message, /not loaded/);
  assert.ok(out.every((o) => Array.isArray(o.transfer)));
});

test('errors become { type: "error" } messages with a readable sentence', () => {
  const { svc, last } = capture();
  svc.onMessage({ type: 'load', job: 1, kind: 'chain', blocks: [makeBlock({ cells: [{ type: 'elbow', R: 1, A: 0.2, B: 2 }] })] });
  assert.equal(last().type, 'error'); assert.equal(last().job, 1);
  assert.match(last().message, /^Each elbow leg must be at least the bore radius\.$/);
  svc.onMessage({ type: 'dance', job: 2 });
  assert.equal(last().type, 'error'); assert.match(last().message, /Unknown message type/);
  svc.onMessage(null);
  assert.equal(last().type, 'error');
  svc.onMessage({ type: 'load', job: 3, kind: 'mesh', scene: { nTri: 0 } });
  assert.match(last().message, /scene is incomplete/);
  svc.onMessage({ type: 'load', job: 4, kind: 'soup' });
  assert.match(last().message, /Unknown simulation kind/);
});

test('mesh jobs: inlet tallies, tally copies at most once a second, flush, launches', () => {
  const { svc, out, last } = capture();
  const scene = tubeScene();
  svc.onMessage({ type: 'load', job: 1, kind: 'mesh', scene });
  assert.equal(last().type, 'loaded');
  const b = { type: 'batch', job: 1, seq: 0, block: null, source: 0, n: 2000, seed: 5, tally: true, paths: 3, sampler: 'cosine' };
  svc.onMessage(b);
  const r1 = last();
  assert.equal(r1.type, 'result');
  assert.ok(r1.absorbed instanceof Float64Array && r1.absorbed.length === 2);
  assert.equal(r1.trans, null); assert.equal(r1.back, null);
  assert.ok(r1.hits instanceof Uint32Array && r1.hits.length === scene.nTri, 'the first result carries the tally');
  assert.deepEqual(r1.tallyLaunches, [2000, 0]);
  assert.equal(r1.paths.length, 3);
  const tr = out[out.length - 1].transfer;
  assert.ok(tr.includes(r1.hits.buffer) && r1.paths.every((p) => tr.includes(p.buffer)), 'paths and hits are transferred');
  svc.onMessage({ ...b, seq: 1, seed: 6, paths: 0 });
  const r2 = last();
  assert.equal(r2.hits, undefined, 'no second copy within 1000 ms');
  svc.onMessage({ ...b, seq: 2, seed: 7, source: 1 });            // outlet launches are not tallied
  svc.onMessage({ type: 'flush', job: 1 });
  const f = last();
  assert.equal(f.type, 'tally');
  assert.ok(f.hits instanceof Uint32Array);
  assert.deepEqual(f.launches, [4000, 0]);
  const wall1 = r1.casts - r1.absorbed[0] - r1.absorbed[1] - r1.leaks, wall2 = r2.casts - r2.absorbed[0] - r2.absorbed[1] - r2.leaks;
  assert.equal(f.hits.reduce((s, x) => s + x, 0), wall1 + wall2);
  // a new job replaces the old one
  svc.onMessage({ type: 'load', job: 2, kind: 'chain', blocks: [tubeBlock()] });
  svc.onMessage({ ...b, seq: 3 });
  assert.equal(last().type, 'error');
  svc.onMessage({ type: 'flush', job: 2 });
  assert.deepEqual(last(), { type: 'tally', job: 2, hits: null, launches: [] });
});

test('a real worker thread gives the same counts as the in-process service', async () => {
  assert.ok(TPMC_WORKER_URL.href.endsWith('/tpmc-node-worker.mjs'));
  assert.ok(defaultWorkerCount() >= 1 && defaultWorkerCount() <= 11);
  const scene = tubeScene();
  const { svc, last } = capture();
  svc.onMessage({ type: 'load', job: 1, kind: 'mesh', scene });
  const batch = { type: 'batch', job: 1, seq: 4, block: null, source: 0, n: 3000, seed: 11, tally: true, paths: 2, sampler: 'cosine' };
  svc.onMessage(batch);
  const local = last();
  const w = createTpmcWorker();
  assert.ok(w instanceof NodeWorker);
  const got = await new Promise((resolve, reject) => {
    const seen = [];
    w.onerror = (e) => reject(new Error(e.message));
    w.addEventListener('message', (e) => seen.push(e.data.type));
    w.onmessage = (e) => {
      if (e.data.type === 'loaded') w.postMessage(batch);
      else if (e.data.type === 'result') resolve({ r: e.data, seen });
    };
    w.postMessage({ type: 'load', job: 1, kind: 'mesh', scene });
  });
  await w.terminate();
  const r = got.r;
  assert.deepEqual(got.seen, ['loaded', 'result']);
  assert.ok(r.hits instanceof Uint32Array && r.paths[0] instanceof Float32Array && r.absorbed instanceof Float64Array);
  for (const k of ['n', 'leaks', 'stuck', 'casts', 'seq', 'source']) assert.equal(r[k], local[k], k);
  assert.deepEqual(Array.from(r.absorbed), Array.from(local.absorbed));
  assert.deepEqual(Array.from(r.hits), Array.from(local.hits));
  assert.deepEqual(r.paths.map((p) => Array.from(p)), local.paths.map((p) => Array.from(p)));
});

test('a worker thread that fails to start reports an error event', async () => {
  const bad = new NodeWorker(new URL('data:text/javascript,throw new Error("boom")'));
  const msg = await new Promise((resolve) => { bad.onerror = (e) => resolve(e.message); });
  await bad.terminate();
  assert.match(msg, /boom/);
});
