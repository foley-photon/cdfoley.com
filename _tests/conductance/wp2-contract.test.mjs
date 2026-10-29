// WP2 contract (spec §2.11 to §2.14, §5.4 rule 3): every exported name exists with its documented arity, and
// returns structurally valid results on a minimal input. Also checks the purity rules H7/H13 on WP2's files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as rng from '../../beta/conductance/js/engine/rng.js';
import * as stats from '../../beta/conductance/js/engine/stats.js';
import * as scene from '../../beta/conductance/js/engine/chain-scene.js';
import * as chain from '../../beta/conductance/js/engine/chain-mc.js';
import * as bvh from '../../beta/conductance/js/engine/bvh.js';
import * as mesh from '../../beta/conductance/js/engine/mesh-mc.js';
import * as service from '../../beta/conductance/js/engine/tpmc-service.js';
import * as runner from '../../beta/conductance/js/engine/mc-runner.js';
import * as vmc from '../../beta/conductance/js/engine/validation-mc.js';
import * as nodeWorker from './node-worker.mjs';
import { gasState } from '../../beta/conductance/js/engine/gas.js';

const N2 = gasState('N2', 293.15);
const fn = (mod, name, len) => {
  assert.equal(typeof mod[name], 'function', name);
  if (len !== undefined) assert.equal(mod[name].length, len, `${name}.length`);
};
const has = (obj, keys, what) => { for (const k of keys) assert.ok(k in obj, `${what || 'object'} has ${k}`); };

test('§2.11 chain-scene.js and chain-mc.js', () => {
  fn(scene, 'chainPlan', 3); fn(scene, 'combinePlan', 3); fn(scene, 'reverseBlock', 1);
  fn(chain, 'compileBlock', 1); fn(chain, 'runChainBlock', 3);
  const plan = scene.chainPlan([{ t: 'tube', d: 0.04, L: 0.2 }, { t: 'pump', S: 0.05, d: 0.04, label: 'P' }], N2, { bc: { mode: 'pump', p0: 1e-4 } });
  has(plan, ['blocks', 'tree', 'kind', 'notes'], 'ChainPlan');
  assert.equal(plan.kind, 'Seff');
  const b = plan.blocks[0];
  has(b, ['id', 'label', 'cells', 'plates', 'outlet', 'Ain', 'Aout'], 'Block');
  assert.equal(b.plates.length, b.cells.length + 1);
  assert.ok(['block', 'pumpBlock', 'series', 'par', 'pump'].includes(plan.tree.k));
  assert.ok(Array.isArray(scene.chainPlan([], N2, { bc: { mode: 'dp' } }).unsupported));
  const cb = chain.compileBlock(b);
  const r = chain.runChainBlock(cb, 100, 1);
  assert.deepEqual(Object.keys(r).sort(), ['back', 'casts', 'n', 'src', 'stuck', 'trans']);
  assert.equal(r.src, 'in');
  const two = { ...b, outlet: null };
  assert.equal(chain.runChainBlock(chain.compileBlock(two), 10, 1, { reverse: true, sampler: 'cosine', maxBounces: 1e7 }).src, 'out');
  const c = scene.combinePlan(plan, [{ id: 0, in: { n: 100, trans: r.trans }, out: null }], N2);
  assert.deepEqual(Object.keys(c).sort(), ['ci95', 'kind', 'sigma', 'value']);
  assert.equal(c.ci95.length, 2);
  const rev = scene.reverseBlock(two);
  has(rev, ['id', 'label', 'cells', 'plates', 'outlet', 'Ain', 'Aout'], 'reversed Block');
});

test('§2.12 bvh.js and mesh-mc.js', () => {
  fn(bvh, 'buildBVH', 1); fn(bvh, 'makeTracer', 1); fn(bvh, 'closestHit', 3);
  fn(mesh, 'runMeshBatch', 3); fn(mesh, 'wallPressure', 3); fn(mesh, 'axialProfile', 3);
  // one tetrahedron-like closed box of 2 ports
  const P = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
  const tri = Float32Array.from(faces.flatMap((f) => f.flatMap((i) => P[i])));
  const B = bvh.buildBVH(tri, { leafSize: 4, bins: 12 });
  has(B, ['order', 'box', 'meta', 'depth'], 'BVH');
  assert.ok(B.order instanceof Uint32Array && B.box instanceof Float32Array && B.meta instanceof Int32Array);
  const sc = mesh.makeScene(tri, Int16Array.from([0, -1, -1, 1]), [{ role: 'inlet', stick: 1, inward: [0, 0, 1] }, { role: 'outlet', stick: 1, inward: [-1, -1, -1] }]);
  has(sc, ['version', 'nTri', 'tri', 'normal', 'area', 'port', 'origTri', 'box', 'meta', 'diag', 'bbox', 'ports'], 'MeshScene');
  assert.ok(sc.tri instanceof Float32Array && sc.normal instanceof Float32Array && sc.area instanceof Float64Array);
  assert.ok(sc.port instanceof Int16Array && sc.origTri instanceof Uint32Array);
  has(sc.ports[0], ['id', 'name', 'role', 'stick', 'area', 'inward', 'centroid', 'slots', 'cdf'], 'port');
  const trace = bvh.makeTracer(sc);
  assert.equal(trace.length, 8);
  const hit = bvh.closestHit(sc, [0.2, 0.2, 0.2], [0, 0, -1]);
  has(hit, ['slot', 't']);
  const r = mesh.runMeshBatch(sc, trace, { source: 0, n: 50, seed: 1, tally: new Uint32Array(4), paths: 2, maxBounces: 1e6, sampler: 'cosine' });
  assert.deepEqual(Object.keys(r).sort(), ['absorbed', 'casts', 'leaks', 'n', 'paths', 'source', 'stuck']);
  assert.ok(r.absorbed instanceof Float64Array && r.absorbed.length === 2);
  assert.ok(r.paths.every((p) => p instanceof Float32Array));
  const wp = mesh.wallPressure(sc, new Uint32Array(4).fill(3), [{ port: 0, n: 50 }]);
  assert.ok(wp instanceof Float64Array && wp.length === 4);
  const ap = mesh.axialProfile(sc, new Uint32Array(4), [{ port: 0, n: 50 }], { bins: 5 });
  has(ap, ['s', 'value', 'lo', 'hi', 'axis'], 'axial profile');
  assert.equal(ap.value.length, 5);
});

test('§2.13 tpmc-service.js and the worker files', () => {
  fn(service, 'createService', 1);
  const out = [];
  const svc = service.createService((m) => out.push(m));
  assert.equal(typeof svc.onMessage, 'function');
  svc.onMessage({ type: 'unload', job: 1 });
  assert.deepEqual(out[0], { type: 'unloaded', job: 1 });
  // the browser worker is three lines: import the service, create it, wire self.onmessage
  const src = readFileSync(new URL('../../beta/conductance/js/workers/tpmc-worker.js', import.meta.url), 'utf8').trim().split('\n');
  assert.equal(src.length, 3);
  assert.match(src[0], /^import \{ createService \} from '\.\.\/engine\/tpmc-service\.js';$/);
  assert.match(src[2], /^self\.onmessage = \(e\) => svc\.onMessage\(e\.data\);$/);
  fn(nodeWorker, 'createTpmcWorker', 0); fn(nodeWorker, 'createNodeRunner', 0); fn(nodeWorker, 'defaultWorkerCount', 0);
  assert.equal(typeof nodeWorker.NodeWorker, 'function');
});

test('§2.14 McRunner', async () => {
  assert.equal(typeof runner.McRunner, 'function');
  assert.equal(runner.McRunner.length, 1);
  const proto = runner.McRunner.prototype;
  assert.equal(proto.runChain.length, 3); assert.equal(proto.runMesh.length, 3);
  assert.equal(proto.stop.length, 0); assert.equal(proto.dispose.length, 0);
  assert.equal(typeof Object.getOwnPropertyDescriptor(proto, 'busy').get, 'function');
  const mc = nodeWorker.createNodeRunner({ workers: 1 });
  assert.equal(mc.busy, false);
  const plan = { blocks: [chain.makeBlock({ id: 0, cells: [{ type: 'tube', R: 1, L: 1 }] })], tree: { k: 'block', id: 0 }, kind: 'C', notes: [] };
  const r = await mc.runChain(plan, N2, { deterministic: true, fixedN: 2000, seed: 1 });
  has(r, ['value', 'sigma', 'ci95', 'kind', 'blocks', 'particles', 'casts', 'ms', 'stopped'], 'ChainMcResult');
  has(r.blocks[0], ['id', 'n', 'trans', 'back', 'stuck', 'casts', 'alpha', 'ci95'], 'ChainMcResult.blocks[]');
  const P = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
  const sc = mesh.makeScene(Float32Array.from(faces.flatMap((f) => f.flatMap((i) => P[i]))), Int16Array.from([0, -1, -1, 1]),
    [{ role: 'inlet', stick: 1, inward: [0, 0, 1] }, { role: 'outlet', stick: 1, inward: [-1, -1, -1] }]);
  const m = await mc.runMesh(sc, N2, { deterministic: true, fixedN: 2000, seed: 1, allocation: 'equal', tally: true, paths: 3, inletPort: 0, outletPort: 1 });
  has(m, ['ports', 'perSource', 'alpha', 'C', 'Seff', 'reciprocity', 'leaksPerMillion', 'stuck', 'hits', 'inletLaunches', 'paths', 'particles', 'casts', 'ms', 'stopped'], 'MeshMcResult');
  has(m.perSource[0], ['port', 'n', 'absorbed', 'leaks', 'stuck', 'casts'], 'perSource[]');
  has(m.alpha[0][1], ['value', 'lo', 'hi', 'sigma'], 'alpha[i][j]');
  has(m.C, ['value', 'sigma', 'ci95', 'i', 'j'], 'C');
  has(m.reciprocity[0], ['i', 'j', 'lhs', 'rhs', 'z', 'pass'], 'reciprocity[]');
  assert.ok(m.hits instanceof Uint32Array);
  mc.dispose();
});

test('§2.8 MC_CASES shape, and rng/stats exports', () => {
  assert.ok(Array.isArray(vmc.MC_CASES) && vmc.MC_CASES.length > 0 && Object.isFrozen(vmc.MC_CASES));
  for (const c of vmc.MC_CASES) {
    has(c, ['id', 'group', 'title', 'source', 'ref', 'refSigma', 'tol', 'quick', 'seed', 'n', 'run'], c.id);
    assert.ok(['chain-mc', 'mesh-mc', 'negative'].includes(c.group));
    has(c.source, ['label', 'url'], c.id + '.source');
    assert.equal(typeof c.run, 'function');
  }
  for (const name of ['mix32', 'splitmix32', 'makeRng', 'batchSeed', 'cosineDir', 'asinDir', 'uniformDir', 'getSampler']) fn(rng, name);
  fn(rng, 'batchSeed', 3);
  for (const name of ['binomial', 'wilson', 'inverseVariance', 'combineSeries', 'combineParallel', 'combineTree', 'stopReason', 'reciprocityZ', 'blockEstimate', 'summarizeMesh']) fn(stats, name);
});

test('WP2 engine files are pure: no DOM, no console, no bare imports (H7, H13)', () => {
  const files = ['rng.js', 'stats.js', 'chain-scene.js', 'chain-mc.js', 'bvh.js', 'mesh-mc.js', 'tpmc-service.js', 'mc-runner.js', 'validation-mc.js'];
  for (const f of files) {
    const src = readFileSync(new URL('../../beta/conductance/js/engine/' + f, import.meta.url), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/\bconsole\s*\./.test(code), f + ' uses console');
    assert.ok(!/\b(window|document|navigator|localStorage|Calc|Plot)\s*[.[]/.test(code), f + ' touches the page');
    for (const m of code.matchAll(/(?:import|from)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      assert.ok(m[1].startsWith('./') || m[1].startsWith('../'), `${f} imports ${m[1]}`);
      assert.ok(m[1].endsWith('.js'), `${f} imports ${m[1]} without .js`);
    }
    assert.ok(!/SharedArrayBuffer/.test(code), f + ' uses SharedArrayBuffer');
  }
});
