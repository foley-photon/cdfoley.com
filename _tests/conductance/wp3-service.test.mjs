// WP3: the prep-worker protocol (spec §2.13): the service driven directly, and the real workers/prep-worker.js
// running in a worker thread (with a minimal `self` shim), so structured cloning and transfers are exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createService } from '../../beta/conductance/js/engine/prep-service.js';
import { writeBinarySTL } from '../../beta/conductance/js/io/stl.js';
import { makeBuiltin, prepareBuiltin } from '../../beta/conductance/js/engine/testgeom.js';
import { gasState } from '../../beta/conductance/js/engine/gas.js';

const N2 = gasState('N2', 293.15), AIR = gasState('air', 293.15);
const fx = (name) => { const b = readFileSync(fileURLToPath(new URL('./fixtures/wp3/' + name, import.meta.url))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
function harness() {
  const out = [];
  const svc = createService((msg, transfer) => out.push({ msg, transfer }));
  const send = (msg) => { const n = out.length; svc.onMessage(msg); assert.equal(out.length, n + 1, 'exactly one reply'); return out[n]; };
  return { send, out };
}

test('parse → prepare → region → scene → export, for a user STL in millimetres', () => {
  const { send } = harness();
  const parsed = send({ type: 'parse', id: 'a', name: 'elbow-dn40-mm.stl', buffer: fx('elbow-dn40-mm.stl'), format: 'auto', scale: 0.001 }).msg;
  assert.equal(parsed.type, 'parsed');
  assert.equal(parsed.id, 'a');
  assert.equal(parsed.nTri, 7936);
  assert.equal(parsed.format, 'stl-binary');
  const [x0, y0, z0, x1, y1, z1] = parsed.bbox;
  assert.ok(Math.abs(x1 - 0.06) < 1e-7 && Math.abs(z0) < 1e-9 && Math.abs(y1 - y0 - 0.040032) < 1e-5 && Math.abs(z1 - 0.080016) < 1e-5 && x0 < 0);
  const prep = send({ type: 'prepare', id: 'b', weldTol: null });
  assert.equal(prep.msg.type, 'prepared');
  assert.ok(prep.msg.positions instanceof Float32Array && prep.msg.positions.length === 9 * 7936);
  assert.deepEqual(prep.transfer, [prep.msg.positions.buffer]);
  assert.equal(prep.msg.report.loops.length, 2);
  assert.equal(prep.msg.report.severity, 'ok');
  assert.deepEqual(prep.msg.autoPorts.map((p) => p.role), ['inlet', 'outlet']);
  // the prepared triangles are the file's triangles (in metres), in the file's order
  const b = makeBuiltin('elbow');
  for (let i = 0; i < 90; i++) assert.ok(Math.abs(prep.msg.positions[i] - b.positions[i]) < 1e-9);
  const reg = send({ type: 'region', id: 'c', seedTri: 0 });
  assert.equal(reg.msg.type, 'region');
  assert.ok(reg.msg.tris instanceof Uint32Array && reg.msg.tris.length === 62);
  assert.deepEqual(reg.transfer, [reg.msg.tris.buffer]);
  const sc = send({ type: 'scene', id: 'd', ports: prep.msg.autoPorts, G: N2 });
  assert.equal(sc.msg.type, 'scene');
  assert.equal(sc.msg.scene.nTri, 7936 + 124);
  assert.equal(sc.msg.capPositions.length, 9 * 124);
  assert.equal(sc.msg.triPort.length, 7936 + 124);
  assert.ok(sc.msg.ms >= 0);
  const bufs = sc.transfer;
  assert.equal(new Set(bufs).size, bufs.length, 'no buffer is listed twice');
  for (const a of [sc.msg.scene.tri, sc.msg.scene.box, sc.msg.scene.meta, sc.msg.capPositions, sc.msg.triPort, sc.msg.scene.ports[0].slots]) assert.ok(bufs.includes(a.buffer));
  const ex = send({ type: 'export', id: 'e' });
  assert.equal(ex.msg.type, 'exported');
  assert.ok(ex.msg.vertices instanceof Float32Array && ex.msg.triangles instanceof Uint32Array);
  assert.equal(ex.msg.triangles.length, 3 * 7936);
  // a different unit re-scales the last file without sending it again
  const again = send({ type: 'parse', id: 'f', scale: 0.0254 }).msg;
  assert.ok(Math.abs(again.bbox[3] / 0.06 - 25.4) < 1e-4);
  const inch = send({ type: 'prepare', id: 'g', weldTol: null }).msg;
  assert.ok(Math.abs(inch.report.bbox[3] - 60 * 0.0254) < 1e-6);
  const mm = send({ type: 'prepare', id: 'h', weldTol: null, scale: 0.001 }).msg;
  assert.ok(Math.abs(mm.report.bbox[3] - 0.06) < 1e-7);
});

test('ASCII STL and OBJ files, by name or by content; a region port joins the scene', () => {
  const { send } = harness();
  assert.equal(send({ type: 'parse', id: 1, name: 'cube.STL', buffer: fx('cube-ascii.stl'), format: 'auto', scale: 1 }).msg.format, 'stl-ascii');
  assert.equal(send({ type: 'parse', id: 2, name: 'model', buffer: fx('cube-quads.obj'), format: 'auto', scale: 1 }).msg.format, 'obj');
  assert.equal(send({ type: 'parse', id: 3, name: 'x.bin', buffer: fx('cube-messy.stl'), format: 'stl', scale: 1 }).msg.format, 'stl-ascii');
  const p = send({ type: 'prepare', id: 4, weldTol: null }).msg;
  assert.equal(p.report.closed, true);
  assert.deepEqual(p.autoPorts, []);
  // a closed solid: two faces picked as regions become the openings
  const r0 = send({ type: 'region', id: 5, seedTri: 0 }).msg, r1 = send({ type: 'region', id: 6, seedTri: 2 }).msg;
  assert.deepEqual(Array.from(r0.tris), [0, 1]);
  assert.deepEqual(Array.from(r1.tris), [2, 3]);
  assert.ok(Math.abs(r0.area - 1) < 1e-12);
  const ports = [
    { id: 0, name: 'Bottom', kind: 'region', loops: null, tris: r0.tris, role: 'inlet', stick: 1, speed: null },
    { id: 1, name: 'Top', kind: 'region', loops: null, tris: r1.tris, role: 'outlet', stick: 1, speed: null },
  ];
  const sc = send({ type: 'scene', id: 7, ports }).msg;
  assert.equal(sc.type, 'scene');
  assert.deepEqual(sc.scene.ports.map((q) => q.inward.map((x) => Math.round(x) + 0)), [[0, 0, 1], [0, 0, -1]]);
  assert.deepEqual(Array.from(sc.triPort.subarray(0, 4)), [0, 0, 1, 1]);
});

test('built-ins answer with their suggested ports and reference; loadMesh restores a saved mesh', () => {
  const { send } = harness();
  const b = send({ type: 'builtin', id: 1, name: 'pumpTube', params: {} }).msg;
  assert.equal(b.type, 'prepared');
  assert.deepEqual(b.autoPorts.map((p) => [p.name, p.role, p.speed]), [['Inlet', 'inlet', null], ['Pump', 'pump', 0.3]]);
  assert.equal(b.reference.sigma > 0, true);
  const sc = send({ type: 'scene', id: 2, ports: b.autoPorts, G: AIR }).msg;
  assert.ok(Math.abs(sc.scene.ports[1].stick - 0.33006) < 5e-6);
  const noGas = send({ type: 'scene', id: 3, ports: b.autoPorts }).msg;
  assert.equal(noGas.type, 'error');
  assert.match(noGas.message, /The gas data are needed/);
  const def = send({ type: 'builtin', id: 4, name: 'elbow' }).msg;
  assert.equal(def.reference.alpha, 0.26524);
  assert.equal(send({ type: 'builtin', id: 5, name: 'tube', params: { L: 0.4 } }).msg.reference, null);
  const ex = send({ type: 'export', id: 6 }).msg;
  const back = send({ type: 'loadMesh', id: 7, vertices: ex.vertices, triangles: ex.triangles, weldTol: null }).msg;
  assert.equal(back.type, 'prepared');
  assert.deepEqual(back.positions, prepareBuiltin('tube', { L: 0.4 }).positions);
});

test('failures come back as { type: "error", id, message } and leave the state usable', () => {
  const { send } = harness();
  const err = (msg, re) => { const r = send(msg).msg; assert.equal(r.type, 'error'); assert.equal(r.id, msg ? msg.id : null); assert.match(r.message, re); };
  err({ type: 'prepare', id: 1, weldTol: null }, /^Load a file first\.$/);
  err({ type: 'parse', id: 2, scale: 0.001 }, /^Load a file first\.$/);
  err({ type: 'region', id: 3, seedTri: 0 }, /^Load a model first\.$/);
  err({ type: 'scene', id: 4, ports: [] }, /^Load a model first\.$/);
  err({ type: 'export', id: 5 }, /^Load a model first\.$/);
  err({ type: 'parse', id: 6, name: 'broken.stl', buffer: new ArrayBuffer(84), format: 'auto', scale: 0.001 }, /contains no triangles/);
  err({ type: 'parse', id: 7, name: 'bad.obj', buffer: fx('bad-index.obj'), format: 'auto', scale: 0.001 }, /^Line 6: face index 9/);
  err({ type: 'builtin', id: 8, name: 'teapot', params: {} }, /no built-in geometry called "teapot"/);
  err({ type: 'unknown', id: 9 }, /^Unknown request "unknown"\.$/);
  err(null, /Unknown request/);
  assert.equal(send({ type: 'builtin', id: 10, name: 'rect', params: {} }).msg.type, 'prepared');
  err({ type: 'region', id: 11, seedTri: 99999 }, /^That face closes an opening; pick a face of the model itself\.$/);
  err({ type: 'region', id: 11, seedTri: -1 }, /does not exist/);
  err({ type: 'scene', id: 12, ports: [{ id: 0, name: 'A', kind: 'loop', loops: [[0]], tris: null, role: 'inlet', stick: 1, speed: null }] }, /no role yet/);
  err({ type: 'parse', id: 13, name: 'x.stl', buffer: fx('cube-ascii.stl'), format: 'auto', scale: 0 }, /Pick the unit/);
  assert.equal(send({ type: 'region', id: 14, seedTri: 0 }).msg.type, 'region', 'the built-in is still loaded');
});

test('the real prep-worker.js in a worker thread: builtin and scene messages round-trip with transfers', async () => {
  const url = new URL('../../beta/conductance/js/workers/prep-worker.js', import.meta.url).href;
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t), onmessage: null };
    parentPort.on('message', (data) => { if (typeof self.onmessage === 'function') self.onmessage({ data }); });
    import(workerData.url).then(() => parentPort.postMessage({ type: 'ready' }), (e) => parentPort.postMessage({ type: 'fatal', message: String(e) }));
  `;
  const w = new Worker(code, { eval: true, workerData: { url } });
  const queue = [], waiting = [];
  w.on('message', (m) => { if (waiting.length) waiting.shift()(m); else queue.push(m); });
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiting.push(r)));
  try {
    assert.equal((await next()).type, 'ready');
    w.postMessage({ type: 'builtin', id: 1, name: 'elbow', params: {} });
    const prep = await next();
    assert.equal(prep.type, 'prepared');
    assert.ok(prep.positions instanceof Float32Array && prep.positions.length === 9 * 7936);
    assert.equal(prep.report.loops[0].vertices instanceof Uint32Array, true);
    assert.equal(prep.reference.alpha, 0.26524);
    w.postMessage({ type: 'scene', id: 2, ports: prep.autoPorts, G: N2 });
    const sc = await next();
    assert.equal(sc.type, 'scene');
    assert.ok(sc.scene.tri instanceof Float32Array && sc.scene.box instanceof Float32Array && sc.scene.meta instanceof Int32Array);
    assert.ok(sc.scene.ports[0].slots instanceof Uint32Array && sc.scene.ports[0].cdf instanceof Float64Array);
    assert.equal(sc.scene.nTri, 8060);
    w.postMessage({ type: 'region', id: 3, seedTri: -1 });
    const e = await next();
    assert.deepEqual([e.type, e.id], ['error', 3]);
  } finally {
    await w.terminate();
  }
});
