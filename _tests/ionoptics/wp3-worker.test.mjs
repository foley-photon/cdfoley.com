// WP3 acceptance (5): worker-core with stub engines answers every message, serialises errors and sends at most
// 10 progress messages per second. (9): the real engine-worker.js under node:worker_threads solves and traces the
// Einzel preset with correct transfer lists, bitwise equal to pipeline.runProject.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createHandler, DEFAULT_ENGINE } from '../../beta/ion-optics/js/engine/worker-core.js';
import { EngineError, resolve } from '../../beta/ion-optics/js/engine/schema.js';
import { projectKeys } from '../../beta/ion-optics/js/engine/hash.js';
import { ENGINE_VERSION } from '../../beta/ion-optics/js/engine/version.js';
import * as PL from '../../beta/ion-optics/js/engine/pipeline.js';
import { generate } from '../../beta/ion-optics/js/engine/particles.js';
import { einzel, magneticSector } from './fixtures/wp3/projects.mjs';

// ---------------------------------------------------------------- stub engine
const busy = (ms, fn) => { const t0 = performance.now(); let i = 0; while (performance.now() - t0 < ms) { if (fn) fn(i); i++; } };
/** Engine namespaces with the shapes worker-core and pipeline expect; each call is recorded. */
function stubEngine({ solveMs = 0, traceMs = 0, failSolve = null } = {}) {
    const calls = [];
    const rec = (name) => calls.push(name);
    const raster = (N) => ({ grid: { N, nx: N, ny: 1 }, cls: new Int16Array(N), near: new Uint8Array(N) });
    const engine = {
        schema: { resolve: (p) => ({ resolved: p, errors: [], warnings: [] }), projectPath: (r, p) => p },
        geometry: { compileGeometry: (r) => { rec('compileGeometry'); return { transparent: new Uint8Array(r.electrodes.length), nElectrodes: r.electrodes.length, prims: [] }; } },
        raster: {
            makeGrid: (d) => ({ N: d.N, nx: d.N, ny: 1 }),
            rasterize: (g, grid) => { rec('rasterize'); return raster(grid.N); },
            packRaster: (r) => ({ meta: { N: r.grid.N }, buffers: [r.cls.slice().buffer, r.near.slice().buffer] }),
            unpackRaster: (p) => { rec('unpackRaster'); return { ...raster(p.meta.N), cls: new Int16Array(p.buffers[0]) }; },
        },
        operator: { buildHierarchy: (g, r) => { rec('buildHierarchy'); return [{ raster: raster(r.domain.N) }]; } },
        solve: {
            solveBasis: (H, k, opts, hooks) => {
                rec(`solveBasis:${k}`);
                if (failSolve) throw failSolve;
                busy(solveMs, (i) => { if (hooks.onProgress) hooks.onProgress({ phase: 'multigrid', frac: Math.min(1, i / 1e5), cycle: i, estErr: 1 / (i + 1), scaledResidual: 0 }); });
                const phi = new Float64Array(H[0].raster.grid.N).fill(k);
                return { phi, stats: { method: 'multigrid', path: ['multigrid'], converged: true, cycles: 3, ms: solveMs } };
            },
        },
        field: {
            combine: (bases, w, N) => { const o = new Float64Array(N); for (const [k, phi] of bases) for (let i = 0; i < N; i++) o[i] += w[k] * phi[i]; return o; },
            createFieldGrid: () => ({ setChannels: () => rec('setChannels') }),
        },
        fieldmodel: { createFieldModel: (a) => { rec('createFieldModel'); return { stub: true, args: a }; } },
        waveform: { timeFunctions: (els) => ({ dc: Float64Array.from(els.map((e) => e.dc || 0)), channels: [] }) },
        particles: { generate: (s, i0, i1) => { const a = new Float64Array(16 * (i1 - i0)); for (let i = i0; i < i1; i++) a[16 * (i - i0)] = i; return a; } },
        trace: {
            traceOptions: (r, o) => ({ ...o }),
            traceParticles: (model, rows, opts, hooks) => {
                rec('traceParticles');
                const n = rows.length / 16;
                busy(traceMs, (i) => { if (hooks.onProgress) hooks.onProgress({ done: Math.min(n, i), total: n }); });
                const summary = new Float64Array(24 * n);
                for (let i = 0; i < n; i++) summary[24 * i] = rows[16 * i];
                return { n, i0: opts.i0 ?? (n ? rows[0] : 0), summary, crossings: new Float64Array(0), nCross: 0, traj: { offsets: new Uint32Array(n + 1), pts: new Float32Array(0) }, markers: null, stats: { steps: n, ms: traceMs } };
            },
            resultTransferables: (r) => [r.summary.buffer, r.crossings.buffer, r.traj.offsets.buffer, r.traj.pts.buffer],
        },
        analysis: { summarize: () => ({}) },
        loadBench: async () => ({
            runBenchmark: async (id, level, ctx) => { ctx.onProgress(0.5, 'half way'); ctx.log('info', `running ${id}`); return { id, level, status: 'pass', checks: [], engineVersion: ENGINE_VERSION }; },
        }),
    };
    return { engine, calls };
}
const RES = { electrodes: [{ id: 'gnd', dc: 0 }, { id: 'a', dc: 10 }, { id: 'b', dc: 20 }], domain: { N: 6 }, particleCount: 4, solver: {}, tracer: {} };
function harness(opts) {
    const { engine, calls } = stubEngine(opts);
    const out = [];
    const handle = createHandler({ post: (m, t) => out.push({ m, t: t || [], at: performance.now() }), engine });
    return { handle, out, calls, types: () => out.map((o) => o.m.type) };
}

test('hello answers with the engine and protocol versions', () => {
    const h = harness();
    h.handle({ v: 1, type: 'hello', id: 'h1' });
    assert.deepEqual(h.out[0].m, { v: 1, type: 'hello', id: 'h1', engine: ENGINE_VERSION, protocol: 1 });
    h.handle(null); h.handle(42);
    assert.equal(h.out.length, 1, 'non-objects are ignored');
});

test('solve, loadBases, setField, trace and drop answer with the protocol messages and transfer lists', () => {
    const h = harness();
    h.handle({ v: 1, type: 'solve', id: 's1', geomKey: 'g1', resolved: RES, electrodes: [1, 2], wantRaster: true });
    assert.deepEqual(h.types(), ['progress', 'raster', 'basis', 'basis', 'done']);
    const [prog, ras, b1, b2, done] = h.out.map((o) => o.m);
    assert.deepEqual([prog.id, prog.phase], ['s1', 'raster']);
    assert.deepEqual([ras.id, ras.geomKey, ras.packed.meta.N], ['s1', 'g1', 6]);
    assert.deepEqual(h.out[1].t, ras.packed.buffers, 'raster buffers transferred');
    assert.deepEqual([b1.k, b2.k, b1.geomKey, b1.stats.converged], [1, 2, 'g1', true]);
    assert.deepEqual(h.out[2].t, [b1.phi.buffer], 'basis transferred');
    assert.equal(done.id, 's1');
    // the hierarchy is cached by geomKey: a second job on the same geometry does not rebuild it
    h.handle({ v: 1, type: 'solve', id: 's2', geomKey: 'g1', resolved: RES, electrodes: [2] });
    assert.equal(h.calls.filter((c) => c === 'buildHierarchy').length, 1);
    h.handle({ v: 1, type: 'drop', hierarchy: 'g1' });
    h.handle({ v: 1, type: 'solve', id: 's3', geomKey: 'g1', resolved: RES, electrodes: [2] });
    assert.equal(h.calls.filter((c) => c === 'buildHierarchy').length, 2, 'drop {hierarchy: geomKey} frees it');
    h.out.length = 0;
    h.handle({ v: 1, type: 'loadBases', id: 'l1', geomKey: 'g1', packedRaster: ras.packed, bases: [{ k: 1, phi: b1.phi }, { k: 2, phi: b2.phi }] });
    assert.deepEqual(h.out[0].m, { v: 1, type: 'loaded', id: 'l1', geomKey: 'g1', bytes: 96 });
    h.handle({ v: 1, type: 'setField', id: 'f1', fieldKey: 'f1', runKey: 'r1', geomKey: 'g1', resolved: RES });
    const fr = h.out[1].m;
    assert.deepEqual([fr.type, fr.fieldKey, fr.runKey, typeof fr.ms], ['fieldReady', 'f1', 'r1', 'number']);
    h.handle({ v: 1, type: 'trace', id: 't1', fieldKey: 'f1', runKey: 'r1', range: [1, 3] });
    const tr = h.out[2].m;
    assert.deepEqual([tr.type, tr.id, tr.i0, tr.result.n], ['traceResult', 't1', 1, 2]);
    assert.deepEqual([...tr.result.summary.filter((_, i) => i % 24 === 0)], [1, 2]);
    assert.equal(h.out[2].t.length, 4, 'result buffers transferred');
    const rows = new Float64Array(16 * 2); rows[0] = 7; rows[16] = 8;
    h.handle({ v: 1, type: 'trace', id: 't2', fieldKey: 'f1', runKey: 'r1', particles: rows, overrides: { rtol: 1e-6 } });
    assert.deepEqual([h.out[3].m.i0, h.out[3].m.result.n], [7, 2]);
    // a second setField for the same field only updates the run settings
    const built = h.calls.filter((c) => c === 'createFieldModel').length;
    h.handle({ v: 1, type: 'setField', fieldKey: 'f1', runKey: 'r2', geomKey: 'g1', resolved: RES });
    assert.equal(h.calls.filter((c) => c === 'createFieldModel').length, built);
    // two fields at most (LRU)
    for (const k of ['f2', 'f3']) h.handle({ v: 1, type: 'setField', fieldKey: k, runKey: 'r' + k, geomKey: 'g1', resolved: RES });
    h.out.length = 0;
    h.handle({ v: 1, type: 'trace', id: 't3', fieldKey: 'f1', runKey: 'r2', range: [0, 1] });
    assert.deepEqual([h.out[0].m.type, h.out[0].m.code, h.out[0].m.detail], ['error', 'E_INTERNAL', { missing: 'field' }], 'evicted');
    h.handle({ v: 1, type: 'drop', fieldKey: 'f3' });
    h.handle({ v: 1, type: 'trace', id: 't4', fieldKey: 'f3', runKey: 'rf3', range: [0, 1] });
    assert.deepEqual(h.out[1].m.detail, { missing: 'field' }, 'dropped');
    h.handle({ v: 1, type: 'trace', id: 't5', fieldKey: 'f2', runKey: 'nope', range: [0, 1] });
    assert.deepEqual(h.out[2].m.detail, { missing: 'run' });
    assert.equal(h.out.length, 3, 'drop has no reply');
});

test('setField without held bases uses combined channels (rasterising locally when needed)', () => {
    const h = harness();
    h.handle({ v: 1, type: 'setField', id: 'f', fieldKey: 'f1', runKey: 'r1', geomKey: 'g9', resolved: RES, channels: [{ phi: new Float64Array(6).fill(3) }] });
    assert.equal(h.out[0].m.type, 'fieldReady');
    assert.ok(h.calls.includes('rasterize'), 'no loadBases: the worker rasterised the geometry itself');
    h.handle({ v: 1, type: 'setField', id: 'f', fieldKey: 'f2', runKey: 'r2', geomKey: 'g9', resolved: RES });
    assert.deepEqual([h.out[1].m.type, h.out[1].m.detail], ['error', { missing: 'bases' }], 'bases needed without channels');
    // a project with no electrode besides ground needs no bases
    const none = { ...RES, electrodes: [{ id: 'gnd', dc: 0 }] };
    h.handle({ v: 1, type: 'setField', id: 'f', fieldKey: 'f3', runKey: 'r3', geomKey: 'g8', resolved: none });
    assert.equal(h.out[2].m.type, 'fieldReady');
});

test('errors are serialised with code, message, stack, path and plain detail', async () => {
    const h = harness({ failSolve: new EngineError('E_NO_CONVERGENCE', 'No convergence.', 'domain.cell', { iterations: 5, fn: () => 1 }) });
    h.handle({ v: 1, type: 'solve', id: 's', geomKey: 'g', resolved: RES, electrodes: [1] });
    const e = h.out.find((o) => o.m.type === 'error').m;
    assert.deepEqual([e.v, e.id, e.code, e.message, e.path], [1, 's', 'E_NO_CONVERGENCE', 'No convergence.', 'domain.cell']);
    assert.deepEqual(e.detail, { iterations: 5 }, 'functions are dropped from detail');
    assert.match(e.stack, /EngineError|No convergence/);
    assert.doesNotThrow(() => structuredClone(e), 'error replies are cloneable');
    const g = harness({ failSolve: new TypeError('boom') });
    g.handle({ v: 1, type: 'solve', id: 7, geomKey: 'g', resolved: RES, electrodes: [1] });
    const ge = g.out.find((o) => o.m.type === 'error').m;
    assert.deepEqual([ge.id, ge.code, ge.message], [7, 'E_INTERNAL', 'boom']);
    g.handle({ v: 1, type: 'teleport', id: 'x' });
    assert.deepEqual([g.out.at(-1).m.code, g.out.at(-1).m.id], ['E_UNSUPPORTED', 'x']);
    g.handle({ v: 2, type: 'hello', id: 'y' });
    assert.deepEqual([g.out.at(-1).m.code, g.out.at(-1).m.id], ['E_VERSION', 'y']);
    g.handle({ v: 1, type: 'setField', id: 'z', fieldKey: 'f', runKey: 'r', geomKey: 'g' });
    assert.equal(g.out.at(-1).m.code, 'E_BAD_PROJECT');
    // bench: results, progress and log messages; a missing case module is E_UNSUPPORTED
    const b = harness();
    await b.handle({ v: 1, type: 'bench', id: 'b1', caseId: 'K1', level: 'quick' });
    assert.deepEqual(b.types(), ['progress', 'log', 'benchResult']);
    assert.deepEqual([b.out[0].m.frac, b.out[0].m.msg, b.out[1].m.level, b.out[2].m.result.status], [0.5, 'half way', 'info', 'pass']);
    const nb = createHandler({ post: (m) => b.out.push({ m }), engine: { ...stubEngine().engine, loadBench: async () => { throw new Error('404'); } } });
    await nb({ v: 1, type: 'bench', id: 'b2', caseId: 'K1' });
    assert.deepEqual([b.out.at(-1).m.type, b.out.at(-1).m.code], ['error', 'E_UNSUPPORTED']);
});

test('progress is limited to 10 messages per second per job', () => {
    const h = harness({ solveMs: 1050, traceMs: 1050 });
    h.handle({ v: 1, type: 'solve', id: 's', geomKey: 'g', resolved: RES, electrodes: [1] });
    const sp = h.out.filter((o) => o.m.type === 'progress');
    assert.ok(sp.length >= 8 && sp.length <= 12, `${sp.length} solve progress messages in about 1.05 s`);
    // ≥ 100 ms apart by the throttle's own clock; these timestamps are taken just after, so allow scheduling jitter
    for (let i = 2; i < sp.length; i++) assert.ok(sp[i].at - sp[i - 1].at >= 90, `about 100 ms apart after the forced first one (${(sp[i].at - sp[i - 1].at).toFixed(1)} ms)`);
    for (const p of sp.slice(1)) assert.deepEqual(Object.keys(p.m).sort(), ['cycle', 'estErr', 'frac', 'id', 'k', 'method', 'phase', 'scaledResidual', 'type', 'v']);
    h.out.length = 0;
    h.handle({ v: 1, type: 'loadBases', geomKey: 'g', packedRaster: null, bases: [{ k: 1, phi: new Float64Array(6) }] });
    h.handle({ v: 1, type: 'setField', fieldKey: 'f', runKey: 'r', geomKey: 'g', resolved: { ...RES, electrodes: RES.electrodes.slice(0, 2) } });
    h.handle({ v: 1, type: 'trace', id: 't', fieldKey: 'f', runKey: 'r', range: [0, 4] });
    const tp = h.out.filter((o) => o.m.type === 'progress');
    assert.ok(tp.length >= 9 && tp.length <= 11, `${tp.length} trace progress messages`);
    assert.deepEqual(Object.keys(tp[0].m).sort(), ['done', 'id', 'total', 'type', 'v']);
});

test('the default engine is the real one, with the benchmark loader', () => {
    for (const k of ['schema', 'hash', 'geometry', 'raster', 'operator', 'solve', 'field', 'fieldmodel', 'waveform', 'particles', 'trace', 'analysis']) assert.equal(typeof DEFAULT_ENGINE[k], 'object', k);
    assert.equal(typeof DEFAULT_ENGINE.loadBench, 'function');
});

// ---------------------------------------------------------------- the real worker under worker_threads
function spawn() {
    const w = new Worker(new URL('./worker-shim.mjs', import.meta.url), { workerData: { checkTransfers: true } });
    const inbox = [];
    let wake = null;
    w.on('message', (m) => { inbox.push(m); if (wake) { const f = wake; wake = null; f(); } });
    w.on('error', (e) => { inbox.push({ type: 'crash', message: String(e) }); if (wake) { const f = wake; wake = null; f(); } });
    const next = async (pred, ms = 60000) => {
        const t0 = Date.now();
        for (;;) {
            const i = inbox.findIndex(pred);
            if (i >= 0) return inbox.splice(i, 1)[0];
            if (Date.now() - t0 > ms) throw new Error('timeout waiting for a worker message');
            await new Promise((res) => { wake = res; setTimeout(res, 200); });
        }
    };
    return { w, inbox, next, take: (pred) => { const out = inbox.filter(pred); for (const m of out) inbox.splice(inbox.indexOf(m), 1); return out; } };
}
function same(a, b, what) {
    assert.equal(a.length, b.length, what);
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) assert.fail(`${what} differs at ${i}`);
}

test('real engine worker: one solve and one trace of the Einzel preset, bitwise equal to runProject', async () => {
    const ref = PL.runProject(einzel());
    const r = resolve(einzel()).resolved;
    const keys = projectKeys(r);
    const { w, next, take } = spawn();
    try {
        w.postMessage({ v: 1, type: 'hello', id: 'h' });
        const hello = await next((m) => m.type === 'hello');
        assert.deepEqual([hello.engine, hello.protocol], [ENGINE_VERSION, 1]);
        // solve: raster once, one basis per electrode, all transferred
        w.postMessage({ v: 1, type: 'solve', id: 1, geomKey: keys.geomKey, resolved: r, electrodes: [1, 2], wantRaster: true });
        const done = await next((m) => (m.type === 'done' || m.type === 'error') && m.id === 1);
        assert.equal(done.type, 'done', done.message);
        const ras = take((m) => m.type === 'raster'), bases = take((m) => m.type === 'basis');
        assert.equal(ras.length, 1);
        assert.deepEqual(bases.map((b) => b.k), [1, 2]);
        assert.ok(take((m) => m.type === 'progress' && m.id === 1).length >= 1);
        const tx = take((m) => m.type === '__transfer');
        for (const t of tx.filter((x) => x.of === 'raster' || x.of === 'basis')) {
            assert.equal(t.unlisted, 0, `${t.of}: every large buffer is in the transfer list`);
            assert.ok(t.listed >= 1 && t.detached, `${t.of}: transferred, not copied`);
        }
        assert.equal(tx.filter((x) => x.of === 'basis').length, 2);
        for (const b of bases) same(b.phi, ref.solved.bases.get(b.k), `basis ${b.k}`);
        // loadBases (copies), setField, trace by range
        w.postMessage({ v: 1, type: 'loadBases', geomKey: keys.geomKey, packedRaster: ras[0].packed, bases: bases.map((b) => ({ k: b.k, phi: b.phi })) });
        const loaded = await next((m) => m.type === 'loaded' || m.type === 'error');
        assert.deepEqual([loaded.type, loaded.bytes], ['loaded', 2 * 8 * r.domain.N]);
        assert.equal(bases[0].phi.length, r.domain.N, 'loadBases copies: main keeps its bases');
        w.postMessage({ v: 1, type: 'setField', fieldKey: keys.fieldKey, runKey: keys.runKey, geomKey: keys.geomKey, resolved: r });
        assert.equal((await next((m) => m.type === 'fieldReady' || m.type === 'error')).type, 'fieldReady');
        w.postMessage({ v: 1, type: 'trace', id: 2, fieldKey: keys.fieldKey, runKey: keys.runKey, range: [0, r.particleCount] });
        const tr = await next((m) => (m.type === 'traceResult' || m.type === 'error') && m.id === 2);
        assert.equal(tr.type, 'traceResult', tr.message);
        const tt = await next((m) => m.type === '__transfer' && m.of === 'traceResult');
        assert.ok(tt.listed >= 3 && tt.detached && tt.unlisted === 0, 'trace result transferred');
        assert.equal(tr.i0, 0);
        same(tr.result.summary, ref.result.summary, 'summary rows');
        same(tr.result.traj.offsets, ref.result.traj.offsets, 'trajectory offsets');
        same(tr.result.traj.pts, ref.result.traj.pts, 'trajectory points');
        same(tr.result.crossings.subarray(0, tr.result.nCross * 14), ref.result.crossings.subarray(0, ref.result.nCross * 14), 'crossings');
        // trace with particle rows transferred from the main side
        const rows = generate(r.sources, 5, 12, { domainType: r.domain.type, relativistic: true });
        const expect = PL.traceProject(r, ref.field, { particles: rows.slice(), total: r.particleCount });
        w.postMessage({ v: 1, type: 'trace', id: 3, fieldKey: keys.fieldKey, runKey: keys.runKey, particles: rows, total: r.particleCount }, [rows.buffer]);
        assert.equal(rows.length, 0, 'the particle rows were transferred');
        const tp = await next((m) => (m.type === 'traceResult' || m.type === 'error') && m.id === 3);
        assert.equal(tp.i0, 5);
        same(tp.result.summary, expect.summary, 'particle-row trace');
        // errors: unknown field
        w.postMessage({ v: 1, type: 'trace', id: 4, fieldKey: 'fnone', runKey: keys.runKey, range: [0, 1] });
        const er = await next((m) => m.type === 'error' && m.id === 4);
        assert.deepEqual([er.code, er.detail], ['E_INTERNAL', { missing: 'field' }]);
        // channels instead of bases (bases too large to hold): after a full drop the worker rasterises itself
        w.postMessage({ v: 1, type: 'drop', all: true });
        w.postMessage({ v: 1, type: 'setField', fieldKey: keys.fieldKey, runKey: keys.runKey, geomKey: keys.geomKey, resolved: r, channels: ref.field.channels.map((c) => ({ phi: c.phi })) });
        assert.equal((await next((m) => m.type === 'fieldReady' || m.type === 'error')).type, 'fieldReady');
        w.postMessage({ v: 1, type: 'trace', id: 5, fieldKey: keys.fieldKey, runKey: keys.runKey, range: [0, r.particleCount] });
        const tc = await next((m) => (m.type === 'traceResult' || m.type === 'error') && m.id === 5);
        same(tc.result.summary, ref.result.summary, 'trace from combined channels');
    } finally {
        await w.terminate();
    }
});

test('real engine worker: a project with nothing to solve, and a benchmark request', async () => {
    const r = resolve(magneticSector()).resolved;
    const keys = projectKeys(r);
    const ref = PL.runProject(magneticSector());
    const { w, next, take } = spawn();
    try {
        w.postMessage({ v: 1, type: 'solve', id: 1, geomKey: keys.geomKey, resolved: r, electrodes: [], wantRaster: true });
        await next((m) => m.type === 'done' && m.id === 1);
        assert.equal(take((m) => m.type === 'raster').length, 1);
        assert.equal(take((m) => m.type === 'basis').length, 0);
        w.postMessage({ v: 1, type: 'setField', fieldKey: keys.fieldKey, runKey: keys.runKey, geomKey: keys.geomKey, resolved: r });
        assert.equal((await next((m) => m.type === 'fieldReady' || m.type === 'error')).type, 'fieldReady');
        w.postMessage({ v: 1, type: 'trace', id: 2, fieldKey: keys.fieldKey, runKey: keys.runKey, range: [0, r.particleCount] });
        const tr = await next((m) => (m.type === 'traceResult' || m.type === 'error') && m.id === 2);
        same(tr.result.summary, ref.result.summary, 'magnetic sector');
        // benchmarks: the case module is WP5's (benchResult when present, else E_UNSUPPORTED)
        w.postMessage({ v: 1, type: 'bench', id: 3, caseId: 'K1', level: 'quick' });
        const b = await next((m) => (m.type === 'benchResult' || m.type === 'error') && m.id === 3, 120000);
        if (b.type === 'error') assert.equal(b.code, 'E_UNSUPPORTED');
        else assert.equal(b.result.id, 'K1');
    } finally {
        await w.terminate();
    }
});
