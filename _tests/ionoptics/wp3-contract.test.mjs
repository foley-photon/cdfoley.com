// WP3 contract (milestone M1): every platform export of spec §2.2–§2.5 exists with its signature and returns
// structurally valid results. Run: node --test "_tests/ionoptics/wp3-*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as version from '../../beta/ion-optics/js/engine/version.js';
import * as expr from '../../beta/ion-optics/js/engine/expr.js';
import * as schema from '../../beta/ion-optics/js/engine/schema.js';
import * as hash from '../../beta/ion-optics/js/engine/hash.js';
import * as io from '../../beta/ion-optics/js/engine/io.js';
import * as pipeline from '../../beta/ion-optics/js/engine/pipeline.js';
import * as core from '../../beta/ion-optics/js/engine/worker-core.js';
import * as storeMod from '../../beta/ion-optics/js/ui/store.js';
import * as poolMod from '../../beta/ion-optics/js/ui/pool.js';
import * as jobsMod from '../../beta/ion-optics/js/ui/jobs.js';
import * as persist from '../../beta/ion-optics/js/ui/persist.js';

const root = new URL('../../beta/ion-optics/', import.meta.url);
const fn = (f, n) => { assert.equal(typeof f, 'function'); if (n !== undefined) assert.ok(f.length <= n, `arity ${f.length} > ${n}`); };

/** A tiny planar project: one electrode, two particles, a detector (solves and runs in a few ms). */
function tiny() {
    const p = schema.newProject('planar2d');
    p.domain.x = [0, 10]; p.domain.y = [-5, 5]; p.domain.cell = 0.5;
    p.domain.edges.xmin = { bc: 'dirichlet', electrode: 'hv' };
    p.domain.edges.ymin = { bc: 'neumann' }; p.domain.edges.ymax = { bc: 'neumann' };
    p.electrodes.push({ id: 'hv', name: 'HV', kind: 'solid', v: 100, wave: null, color: '#2563eb' });
    p.sources.push({ ...schema.defaults('source', 'planar2d'), count: 2, position: { type: 'point', p: [1, 0, 0] }, energy: { type: 'mono', ke: 1 } });
    p.recording.planes.push({ ...schema.defaults('plane'), at: 9, terminate: true });
    return p;
}

test('package.json and the worker shell', () => {
    assert.deepEqual(JSON.parse(readFileSync(new URL('package.json', root), 'utf8')), { private: true, type: 'module' });
    const shell = readFileSync(new URL('js/workers/engine-worker.js', root), 'utf8');
    assert.match(shell, /import \{ createHandler \} from '\.\.\/engine\/worker-core\.js';/);
    assert.match(shell, /self\.onmessage = \(e\) => handle\(e\.data\);/);
    assert.ok(shell.split('\n').filter((l) => l.trim()).length <= 5, 'the worker shell is about five lines');
});

test('version.js', () => {
    assert.equal(version.PRODUCT_NAME, 'Ion Optics Workbench');
    assert.match(version.ENGINE_VERSION, /^\d+\.\d+\.\d+$/);
    assert.equal(version.PROTOCOL_VERSION, 1);
    assert.equal(version.PROJECT_FORMAT, 'ion-optics-project');
});

test('expr.js', () => {
    fn(expr.parseExpr, 1); fn(expr.evaluateParams, 1);
    const e = expr.parseExpr('2*a + 1');
    assert.deepEqual([...e.deps], ['a']);
    assert.equal(e.evaluate({ a: 3 }), 7);
    const r = expr.evaluateParams([{ name: 'a', value: 2 }, { name: 'b', value: 'a^2' }]);
    assert.deepEqual({ ...r.values }, { a: 2, b: 4 });
    assert.deepEqual(r.errors, []);
    assert.throws(() => expr.parseExpr('1 +'), (err) => err.name === 'EngineError' && err.code === 'E_BAD_PROJECT' && typeof err.detail.column === 'number');
});

test('schema.js', () => {
    assert.equal(schema.SCHEMA_VERSION, 1);
    assert.equal(typeof schema.META, 'object');
    for (const k of ['domain', 'electrode', 'shape', 'source', 'plane', 'tracer', 'solver']) assert.ok(Array.isArray(schema.META[k]) && schema.META[k].length, k);
    for (const d of schema.META.electrode) for (const key of ['key', 'label', 'dim', 'kind', 'help']) assert.ok(key in d, `${d.key}.${key}`);
    fn(schema.defaults, 2); fn(schema.newProject, 1); fn(schema.migrate, 1); fn(schema.validate, 2); fn(schema.resolve, 2);
    const p = schema.newProject('cyl2d');
    assert.equal(p.format, 'ion-optics-project'); assert.equal(p.version, 1);
    assert.deepEqual(p.electrodes[0], { id: 'gnd', name: 'Ground', ground: true, color: '#64748b' });
    const v = schema.validate(p);
    assert.deepEqual(Object.keys(v).sort(), ['errors', 'warnings']);
    assert.deepEqual(v.errors, []);
    const r = schema.resolve(tiny());
    assert.deepEqual(r.errors, []);
    const R = r.resolved;
    for (const k of ['h', 'nx', 'ny', 'N']) assert.equal(typeof R.domain[k], 'number', `domain.${k}`);
    for (const k of ['index', 'dc', 'terms', 'transparent']) assert.ok(k in R.electrodes[1], `electrodes[1].${k}`);
    assert.equal(R.electrodes[1].dc, 100);
    for (const k of ['index', 'count', 'firstId']) assert.equal(typeof R.sources[0][k], 'number', `sources[0].${k}`);
    assert.equal(R.particleCount, 2);
    assert.equal(typeof R.tracer.q.rtol, 'number');
    assert.equal(typeof R.paramValues, 'object');
    const bad = schema.resolve({ ...tiny(), domain: { ...tiny().domain, cell: -1 } });
    assert.equal(bad.resolved, null);
    assert.ok(bad.errors.some((e) => e.path === 'domain.cell' && typeof e.code === 'string' && typeof e.message === 'string'));
    assert.equal(new schema.EngineError('E_INTERNAL', 'x').name, 'EngineError');
});

test('hash.js', () => {
    fn(hash.canonicalJSON); fn(hash.hash64, 1); fn(hash.geomKey, 1); fn(hash.fieldKey, 2); fn(hash.runKey, 2);
    assert.equal(hash.canonicalJSON({ b: 1, a: [1, 2] }), '{"a":[1,2],"b":1}');
    assert.match(hash.hash64('abc'), /^[0-9a-f]{16}$/);
    const R = schema.resolve(tiny()).resolved;
    const g = hash.geomKey(R), f = hash.fieldKey(R, g), r = hash.runKey(R, f);
    for (const k of [g, f, r]) assert.equal(typeof k, 'string');
    assert.equal(hash.fieldKey(R), f);
    assert.equal(hash.runKey(R), r);
});

test('io.js', async () => {
    fn(io.toCSV, 2); fn(io.runToCSV, 3); fn(io.encodeShare, 1); fn(io.decodeShare, 1);
    assert.equal(io.toCSV(['a', 'b'], [[1, 'x,y']]), 'a,b\r\n1,"x,y"\r\n');
    const p = tiny();
    const link = await io.encodeShare(p);
    assert.match(link, /^pj?=[A-Za-z0-9_-]+$/);
    const back = await io.decodeShare('#' + link);
    assert.equal(hash.canonicalJSON(back), hash.canonicalJSON(p));
});

test('pipeline.js and worker-core.js', () => {
    for (const k of ['resolveOrThrow', 'prepare', 'solveProject', 'buildField', 'traceProject', 'runProject']) fn(pipeline[k]);
    fn(core.createHandler, 1);
    const out = pipeline.runProject(tiny());
    for (const k of ['resolved', 'solved', 'field', 'result', 'summary', 'timings']) assert.ok(k in out, k);
    assert.ok(out.solved.bases instanceof Map && out.solved.bases.get(1) instanceof Float64Array);
    assert.ok(Array.isArray(out.solved.stats) && out.solved.stats[0].converged);
    assert.ok(out.field.model && typeof out.field.model.E === 'function');
    assert.equal(out.result.n, 2);
    assert.ok(out.result.summary instanceof Float64Array);
    assert.equal(out.summary.launched, 2);
    const posted = [];
    const handle = core.createHandler({ post: (m, t) => posted.push([m, t]) });
    handle({ v: 1, type: 'hello', id: 'h' });
    assert.deepEqual(posted[0][0], { v: 1, type: 'hello', id: 'h', engine: version.ENGINE_VERSION, protocol: 1 });
});

test('store.js', () => {
    fn(storeMod.createStore, 2);
    const s = storeMod.createStore(tiny(), { mobile: false });
    for (const k of ['get', 'update', 'replaceProject', 'undo', 'redo', 'canUndo', 'canRedo', 'select', 'setUi', 'setSolve', 'setSolution', 'setField', 'setRun', 'pinRun', 'unpinRun', 'on']) fn(s[k]);
    for (const k of ['project', 'resolved', 'issues', 'keys', 'selection']) assert.ok(k in s, k);
    const st = s.get();
    for (const k of ['project', 'resolved', 'issues', 'keys', 'selection', 'solve', 'solution', 'field', 'run', 'runs', 'ui']) assert.ok(k in st, k);
    assert.equal(st.solve.status, 'none'); assert.equal(st.run.status, 'none');
    const off = s.on('project', () => {});
    assert.equal(typeof off, 'function');
});

test('pool.js and jobs.js', () => {
    fn(poolMod.createPool, 1); fn(jobsMod.createJobs, 4);
    const pool = poolMod.createPool({ size: 2, inline: true, inlineFactory: () => (msg) => {} });
    for (const k of ['exec', 'broadcast', 'holding', 'cancel', 'terminate']) fn(pool[k]);
    assert.equal(pool.size, 2);
    assert.ok(pool.ready && typeof pool.ready.then === 'function');
    assert.equal(typeof pool.versionOk, 'boolean');
    const store = storeMod.createStore(tiny(), { mobile: false });
    const jobs = jobsMod.createJobs(store, pool, null, { autoStart: false, mobile: false });
    for (const k of ['estimate', 'solve', 'cancelSolve', 'run', 'cancelRun', 'ensureSolution', 'ensureField', 'traceBatch', 'withTemporaryProject', 'runBenchmarks', 'cancelBenchmarks', 'on']) fn(jobs[k]);
    const e = jobs.estimate();
    for (const k of ['nodes', 'levels', 'bases', 'memMB', 'solveMs', 'runMs', 'warnings']) assert.ok(k in e, k);
    assert.equal(e.nodes, 21 * 21); assert.equal(e.bases, 1);
    jobs.destroy(); pool.terminate();
});

test('persist.js', () => {
    for (const k of ['loadInitial', 'autosave', 'recent', 'pushRecent', 'prefs', 'setPrefs', 'shareLink', 'downloadProject', 'readProjectFile']) fn(persist[k]);
    assert.equal(typeof persist.basisCache, 'object');
    for (const k of ['get', 'put', 'clear']) fn(persist.basisCache[k]);
    assert.equal(persist.KEYS.autosave, 'ionopt.autosave.v1');
    assert.equal(persist.KEYS.recent, 'ionopt.recent.v1');
});
