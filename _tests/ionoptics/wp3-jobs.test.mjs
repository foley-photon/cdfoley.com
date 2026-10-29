// WP3 acceptance (7): with a fake Worker — cancel within 100 ms and recovery; superseded previews ignored;
// index-order merging; the estimator blocks over-budget jobs; withTemporaryProject leaves the store untouched.
// Also: version handshake, main-thread fallback, crashes, lost worker state, live mode, benchmarks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../beta/ion-optics/js/ui/store.js';
import { createPool } from '../../beta/ion-optics/js/ui/pool.js';
import { createJobs, estimateProject, stepsPerParticle, fixedFraction, multigridShape } from '../../beta/ion-optics/js/ui/jobs.js';
import { createHandler } from '../../beta/ion-optics/js/engine/worker-core.js';
import { resolve, newProject } from '../../beta/ion-optics/js/engine/schema.js';
import { runProject, traceProject, buildField } from '../../beta/ion-optics/js/engine/pipeline.js';
import { generate } from '../../beta/ion-optics/js/engine/particles.js';
import { S_STRIDE, S_ID } from '../../beta/ion-optics/js/engine/layout.js';
import { einzel, plateMirror, magneticSector, reflectron, rfQuadrupole } from './fixtures/wp3/projects.mjs';

// ---------------------------------------------------------------- fake Worker running the real worker core
/**
 * Worker stand-in: messages are structured-cloned with their transfer lists (buffers are detached like postMessage),
 * each message is handled in its own macrotask after `delay(msg)` ms. Options: crashOn(msg) → onerror instead of an
 * answer; silent → never answers hello; engineVersion → the version it claims in hello.
 */
function fakeWorkers(o = {}) {
    const reg = { made: 0, terminated: 0, live: new Set(), handled: [], received: [] };
    class FakeWorker {
        constructor(url, opts) {
            if (o.throwOnCreate) throw new Error('module workers are not supported');
            assert.equal(opts && opts.type, 'module');
            reg.made++; reg.live.add(this);
            this.onmessage = null; this.onerror = null; this.dead = false; this.inbox = []; this.busy = false;
            this.handle = createHandler({ post: (m, t) => this.reply(m, t) });
        }
        reply(m, t) {
            if (this.dead) return;
            const msg = o.engineVersion && m.type === 'hello' ? { ...m, engine: o.engineVersion } : m;
            const data = structuredClone(msg, { transfer: t || [] });
            setTimeout(() => { if (!this.dead && this.onmessage) this.onmessage({ data }); }, 0);
        }
        postMessage(m, t) {
            if (this.dead) return;
            reg.received.push(m.type);
            this.inbox.push(structuredClone(m, { transfer: t || [] }));
            this.pump();
        }
        pump() {
            if (this.busy || this.dead || !this.inbox.length) return;
            this.busy = true;
            const m = this.inbox.shift();
            this.timer = setTimeout(async () => {
                this.timer = null;
                if (this.dead) return;
                reg.handled.push(m.type);
                if (o.silent && m.type === 'hello') { this.busy = false; this.pump(); return; }
                if (o.crashOn && o.crashOn(m)) { if (this.onerror) this.onerror({ message: 'simulated crash' }); return; }
                await this.handle(m);
                this.busy = false;
                this.pump();
            }, o.delay ? o.delay(m) : 0);
        }
        terminate() { if (this.timer) clearTimeout(this.timer); if (!this.dead) { this.dead = true; reg.terminated++; reg.live.delete(this); } }
    }
    return { FakeWorker, reg };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 30000, what = 'condition') {
    const t0 = Date.now();
    while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(5); }
}
function once(emitter, evt, ms = 60000) {
    return new Promise((res, rej) => {
        const t = setTimeout(() => { off(); rej(new Error(`timeout waiting for ${evt}`)); }, ms);
        const off = emitter.on(evt, (p) => { clearTimeout(t); off(); res(p); });
    });
}
function setup(project, { size = 3, workers = {}, jobs: jo = {}, pool: po = {} } = {}) {
    const { FakeWorker, reg } = fakeWorkers(workers);
    const store = createStore(project, { mobile: false });
    const pool = createPool({ size, WorkerImpl: FakeWorker, helloTimeoutMs: 0, ...po });
    const jobs = createJobs(store, pool, null, { mobile: false, autoSolveDelayMs: 0, previewDelayMs: 0, ...jo });
    const done = () => { jobs.destroy(); pool.terminate(); };
    return { store, pool, jobs, reg, done };
}
function sameF64(a, b, what) {
    assert.equal(a.length, b.length, what);
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) assert.fail(`${what} differs at ${i}`);
}
const many = (n) => { const p = einzel(); p.sources[0].position.n = n; return p; };

test('automatic solve and run: bases solved one electrode per worker, chunks merged in index order, bitwise equal to runProject', { timeout: 120000 }, async () => {
    const p = many(100);
    const ref = runProject(p);
    // later chunks answer first: completion order is reversed
    const { store, jobs, reg, done } = setup(p, { workers: { delay: (m) => (m.type === 'trace' ? Math.max(0, 60 - m.range[0] / 2) : 0) } });
    try {
        const ran = await once(jobs, 'ran');
        const st = store.get();
        assert.equal(st.solve.status, 'done');
        assert.deepEqual(st.solve.stats.map((s) => s.k), [1, 2]);
        assert.equal(st.run.status, 'done');
        assert.equal(ran.n, 100);
        assert.equal(reg.handled.filter((t) => t === 'solve').length, 2, 'one solve job per electrode');
        assert.equal(reg.handled.filter((t) => t === 'trace').length, 7, 'chunks of clamp(ceil(100/(4·2)), 16, 512) = 16');
        const ids = []; for (let i = 0; i < ran.n; i++) ids.push(ran.summary[i * S_STRIDE + S_ID]);
        assert.deepEqual(ids, [...Array(100).keys()], 'index order');
        sameF64(ran.summary, ref.result.summary, 'summary rows');
        sameF64(ran.traj.pts, ref.result.traj.pts, 'trajectory points');
        sameF64(st.solution.bases.get(1), ref.solved.bases.get(1), 'basis 1');
        assert.equal(st.run.summary.launched, 100);
        assert.ok(st.field && st.field.displayPhi.length === st.resolved.domain.N, 'main-thread field and display potential');
        assert.equal(reg.handled.filter((t) => t === 'loadBases').length, 2, 'bases sent once to each trace worker');
    } finally { done(); }
});

test('Stop cancels a run within 100 ms, keeps finished chunks as partial, and the pool recovers', { timeout: 120000 }, async () => {
    const p = many(64);
    let slow = true;
    const { store, jobs, reg, pool, done } = setup(p, { workers: { delay: (m) => (m.type === 'trace' && slow ? (m.range[0] === 0 ? 0 : 10000) : 0) }, jobs: { autoStart: false } });
    try {
        assert.ok(await jobs.solve());
        const pr = jobs.run({ mode: 'full' });
        await until(() => reg.received.filter((t) => t === 'trace').length >= 3 && store.get().run.status === 'running', 30000, 'run started');
        await until(() => store.get().run.progress && store.get().run.progress.done >= 16, 5000, 'first chunk');   // others hang
        const t0 = performance.now();
        const before = reg.terminated;
        jobs.cancelRun();
        const res = await pr;
        const ms = performance.now() - t0;
        assert.ok(ms < 100, `cancelled in ${ms.toFixed(1)} ms`);
        assert.ok(reg.terminated > before, 'busy workers were terminated');
        assert.equal(store.get().run.status, 'partial');
        assert.ok(res.partial && res.n === 16, `finished chunk kept (${res.n} particles)`);
        // recovery: workers respawn lazily and the next run completes
        slow = false;
        const made = reg.made;
        const full = await jobs.run({ mode: 'full' });
        assert.equal(full.n, 64);
        assert.equal(store.get().run.status, 'done');
        assert.ok(reg.made > made, 'new workers were started');
        assert.equal(pool.stats().queued, 0);
    } finally { done(); }
});

test('cancelling a solve discards it; a later solve recovers', { timeout: 120000 }, async () => {
    let slow = true;
    const { store, jobs, reg, done } = setup(einzel(), { workers: { delay: (m) => (m.type === 'solve' && slow ? 10000 : 0) }, jobs: { autoStart: false } });
    try {
        const pr = jobs.solve();
        await until(() => store.get().solve.status === 'running' && reg.handled.length > 0, 5000, 'solve started');
        await sleep(20);
        const t0 = performance.now();
        jobs.cancelSolve();
        assert.equal(await pr, null);
        assert.ok(performance.now() - t0 < 100);
        assert.equal(store.get().solve.status, 'none');
        assert.equal(store.get().solution, null);
        slow = false;
        const sol = await jobs.solve();
        assert.ok(sol && sol.bases.size === 2);
        assert.equal(store.get().solve.status, 'done');
    } finally { done(); }
});

test('superseded live previews are ignored; queued ones are dropped', { timeout: 120000 }, async () => {
    const p = many(600);   // more than 500 particles: no automatic full run, live previews instead
    const traces = [];
    const { store, jobs, done } = setup(p, { size: 3, workers: { delay: (m) => { if (m.type === 'trace') { traces.push(m.id); return 150; } return 0; } } });
    try {
        const first = await once(jobs, 'preview');
        assert.ok(first.live && first.n === store.get().run.result.n);
        assert.ok(first.n <= 200);
        const seen = [];
        store.on('run', (st) => { if (st.run.result && st.run.live) seen.push(st.run.runKey); });
        // three quick voltage edits: the first preview starts, the second is dropped from the queue, the third wins
        const keys = [];
        for (const v of [700, 650, 600]) { store.update((q) => { q.params[1].value = v; }, { merge: 'v:centre' }); keys.push(store.get().keys.runKey); await sleep(40); }
        await until(() => store.get().run.live && store.get().run.runKey === keys[2] && store.get().run.status === 'done', 20000, 'latest preview');
        await sleep(400);
        assert.equal(store.get().run.runKey, keys[2], 'the latest edit wins');
        assert.ok(!seen.includes(keys[0]), 'the first preview finished after newer edits and was ignored');
        assert.equal(seen.at(-1), keys[2]);
        assert.ok(!seen.includes(keys[1]), 'the queued preview was superseded before it ran');
        const e = jobs.estimate();
        assert.equal(e.measured, true, 'after a preview the run estimate uses measured steps');
        assert.ok(Math.abs(e.stepsPerParticle - store.get().run.result.stats.steps / store.get().run.result.n) < 1e-9);
    } finally { done(); }
});

test('the estimator blocks over-budget jobs before any worker is asked', { timeout: 120000 }, async () => {
    // a desktop store with 9e5 nodes, phone jobs (limit 4e5)
    const p = newProject('planar2d');
    p.domain.x = [0, 949]; p.domain.y = [0, 949]; p.domain.cell = 1;
    p.electrodes.push({ id: 'a', kind: 'solid', v: 10 });
    p.shapes.push({ id: 's', type: 'box', electrode: 'a', x0: 400, x1: 500, y0: 400, y1: 500 });
    const { FakeWorker, reg } = fakeWorkers();
    const store = createStore(p, { mobile: false });
    const pool = createPool({ size: 2, WorkerImpl: FakeWorker, helloTimeoutMs: 0 });
    const jobs = createJobs(store, pool, null, { mobile: true, autoStart: false });
    try {
        assert.equal(await jobs.solve(), null);
        const s = store.get().solve;
        assert.deepEqual([s.status, s.error.code], ['error', 'E_GRID_TOO_LARGE']);
        assert.ok(!reg.handled.includes('solve'), 'no solve message was sent');
        assert.equal(await jobs.run({ mode: 'full' }), null);
        assert.ok(!reg.handled.includes('trace'));
        const e = jobs.estimate();
        assert.ok(e.blocked && e.blockedSolve && e.blockCode === 'E_GRID_TOO_LARGE');
        assert.ok(e.warnings.some((w) => w.code === 'E_GRID_TOO_LARGE' && String(w) === w.message));
    } finally { jobs.destroy(); pool.terminate(); }
    // memory: 4.0 M nodes with 31 bases does not fit 1.5 GB even with one solving worker
    const R = { domain: { nx: 1999, ny: 1999, N: 1999 * 1999, h: 1, x: [0, 1998], y: [0, 1998], type: 'planar2d', edges: {} }, electrodes: Array.from({ length: 32 }, (_, i) => ({ id: 'e' + i, dc: 0, terms: [] })),
        shapes: [], sources: [], particleCount: 0, tracer: { q: { maxStepCells: 0.5, rfStepsPerPeriod: 32 } }, recording: { planes: [], trajectories: { store: true, maxPoints: 2000 } }, solver: {} };
    const big = estimateProject(R, { workers: 7 });
    assert.ok(big.blockedSolve && big.blockCode === 'E_MEMORY', JSON.stringify([big.blockCode, big.solveMemMB]));
    // fewer bases fit with fewer solving workers
    const fewer = estimateProject({ ...R, electrodes: R.electrodes.slice(0, 11) }, { workers: 7 });
    assert.ok(!fewer.blocked && fewer.solveWorkers < 7 && fewer.solveWorkers >= 1, `solve workers ${fewer.solveWorkers}`);
    assert.ok(fewer.warnings.some((w) => w.code === 'W_MEMORY'));
    // particles: the phone limit
    const parts = resolve(many(21)).resolved;
    const lots = { ...parts, particleCount: 20001 };
    assert.equal(estimateProject(lots, { workers: 2, mobile: true }).blockCode, 'E_LIMIT');
    assert.equal(estimateProject(lots, { workers: 2 }).blocked, false);
});

test('withTemporaryProject solves and runs in isolation and leaves the store untouched', { timeout: 120000 }, async () => {
    const { store, jobs, done } = setup(einzel());
    try {
        await once(jobs, 'ran');
        const before = store.get();
        const snap = { project: before.project, resolved: before.resolved, solution: before.solution, field: before.field, run: before.run, solve: before.solve, keys: { ...before.keys }, undo: store.undoDepth() };
        const events = [];
        const offs = ['project', 'resolved', 'selection', 'solve', 'solution', 'field', 'run', 'runs', 'ui', 'error'].map((e) => store.on(e, () => events.push(e)));
        const tmpProject = plateMirror();
        const ref = runProject(tmpProject);
        const out = await jobs.withTemporaryProject(tmpProject, async ({ store: ts, jobs: tj }) => {
            assert.equal(ts.get().resolved.domain.type, 'planar2d');
            const sol = await tj.solve();
            assert.equal(sol.bases.size, 2);
            const f = await tj.ensureField();
            assert.ok(f.model && f.grid);
            const part = await tj.traceBatch({ range: [2, 5] });
            assert.equal(part.n, 3);
            const all = await tj.run();
            sameF64(all.summary, ref.result.summary, 'temporary run');
            return 'finished';
        });
        assert.equal(out, 'finished');
        offs.forEach((off) => off());
        assert.deepEqual(events, [], 'no store events');
        const after = store.get();
        for (const k of ['project', 'resolved', 'solution', 'field', 'run', 'solve']) assert.equal(after[k], snap[k], k);
        assert.deepEqual(after.keys, snap.keys);
        assert.equal(store.undoDepth(), snap.undo);
        // an invalid temporary project is refused before anything runs
        const bad = einzel(); bad.domain.cell = -1;
        await assert.rejects(jobs.withTemporaryProject(bad, async () => 1), (e) => e.code === 'E_BAD_PROJECT');
        // the store's own field is untouched and a store batch still works
        const batch = await jobs.traceBatch({ range: [0, 3] });
        assert.equal(batch.n, 3);
    } finally { done(); }
});

test('a worker with another engine version is refused and the page is told to reload', { timeout: 120000 }, async () => {
    const { store, jobs, pool, done } = setup(einzel(), { size: 2, workers: { engineVersion: '0.0.0-old' }, jobs: { autoStart: false } });
    try {
        const ver = once(jobs, 'versionMismatch', 5000);
        const st = await pool.ready;
        assert.equal(st.versionOk, false);
        await ver;
        assert.equal(pool.versionOk, false);
        await assert.rejects(pool.exec({ type: 'hello' }), (e) => e.code === 'E_VERSION' && /Reload to continue/.test(e.message));
        assert.equal(await jobs.solve(), null);
        assert.equal(store.get().solve.error.code, 'E_VERSION');
    } finally { done(); }
});

test('without module workers, or when hello takes too long, the core runs on the main thread', { timeout: 120000 }, async () => {
    for (const workers of [{ throwOnCreate: true }, { silent: true }]) {
        const { FakeWorker } = fakeWorkers(workers);
        const store = createStore(einzel(), { mobile: false });
        const pool = createPool({ size: 3, WorkerImpl: FakeWorker, helloTimeoutMs: 50 });
        const fallback = new Promise((res) => pool.on('fallback', res));
        const jobs = createJobs(store, pool, null, { mobile: false, autoSolveDelayMs: 0 });
        try {
            await fallback;
            assert.equal(pool.fallback, true);
            const ran = await once(jobs, 'ran');
            assert.equal(ran.n, 21);
            sameF64(ran.summary, runProject(einzel()).result.summary, 'inline core');
        } finally { jobs.destroy(); pool.terminate(); }
    }
    // no pool at all: jobs makes an inline one
    const store = createStore(einzel(), { mobile: false });
    const jobs = createJobs(store, null, null, { mobile: false, autoSolveDelayMs: 0 });
    try {
        const ran = await once(jobs, 'ran');
        assert.equal(ran.n, 21);
        assert.equal(jobs.pool.fallback, true);
    } finally { jobs.destroy(); jobs.pool.terminate(); }
});

test('a worker crash fails its job; the next job runs on a fresh worker', { timeout: 120000 }, async () => {
    let crash = true;
    const { store, jobs, reg, done } = setup(einzel(), { workers: { crashOn: (m) => crash && m.type === 'trace' } });
    try {
        await until(() => store.get().run.status === 'error', 30000, 'run error');
        assert.match(store.get().run.error.message, /stopped/);
        crash = false;
        const made = reg.made;
        const r = await jobs.run({ mode: 'full' });
        assert.equal(r.n, 21);
        assert.ok(reg.made > made);
    } finally { done(); }
});

test('a worker that lost its state is sent the set-up again', { timeout: 120000 }, async () => {
    const { store, jobs, reg, done } = setup(einzel());
    try {
        await once(jobs, 'ran');
        // wipe every worker's caches behind the pool's back
        for (const w of reg.live) w.handle({ v: 1, type: 'drop', all: true });
        const before = reg.handled.filter((t) => t === 'setField').length;
        const r = await jobs.run({ mode: 'full' });
        assert.equal(r.n, 21);
        assert.equal(store.get().run.status, 'done');
        assert.ok(reg.handled.filter((t) => t === 'setField').length > before, 'set-up was resent after the missing-state reply');
        // particle rows are transferred to the worker: the retry must send a copy, not the emptied buffer
        for (const w of reg.live) w.handle({ v: 1, type: 'drop', all: true });
        const R = store.get().resolved;
        const rows = generate(R.sources, 3, 9, { domainType: R.domain.type, relativistic: true });
        const expect = traceProject(R, buildField(R, store.get().solution), { particles: rows.slice(), total: rows.length / 16 });
        const got = await jobs.traceBatch({ particles: rows });
        assert.equal(got.n, 6);
        sameF64(got.summary, expect.summary, 'retried particle-row trace');
    } finally { done(); }
});

test('live mode, ensureField and display time', { timeout: 120000 }, async () => {
    const { store, jobs, done } = setup(rfQuadrupole(), { jobs: { autoStart: false } });
    try {
        assert.equal(await jobs.ensureField({ solve: false }), null, 'no solve without permission');
        const f = await jobs.ensureField();
        assert.ok(f && f.channels.length === 2);
        const phi0 = store.get().field.displayPhi;
        const f2 = await jobs.ensureField({ displayTime: 0.2 });
        assert.equal(f2.displayTime, 0.2);
        assert.notEqual(store.get().field.displayPhi, phi0, 'time-dependent fields recombine for the display time');
        jobs.setLive(false);
        assert.equal(store.get().ui.live, false);
        store.update((p) => { p.params[0].value = 140; });
        await sleep(100);
        assert.notEqual(store.get().run.status, 'running', 'no preview with live off');
        const pv = once(jobs, 'preview');
        jobs.setLive(true);
        const res = await pv;
        assert.ok(res.live && res.n > 0);
        const e = jobs.estimate();
        assert.equal(e.measured, true);
    } finally { done(); }
});

test('benchmarks run as low-priority jobs; failures become result rows', { timeout: 120000 }, async () => {
    const { jobs, done } = setup(magneticSector(), { size: 2, jobs: { autoStart: false } });
    try {
        const seen = [];
        const res = await jobs.runBenchmarks({ ids: ['K1', 'S1'], level: 'quick', onResult: (r) => seen.push(r.id) });
        assert.deepEqual(res.map((r) => r.id), ['K1', 'S1']);
        assert.deepEqual(seen.sort(), ['K1', 'S1']);
        for (const r of res) assert.ok(['pass', 'fail', 'info', 'error'].includes(r.status), r.status);
    } finally { done(); }
});

test('estimates: geometry-aware solve model, flight paths, preview sizes', { timeout: 120000 }, () => {
    const E = resolve(einzel()).resolved;
    const e = estimateProject(E, { workers: 1 });
    for (const k of ['nodes', 'levels', 'bases', 'memMB', 'solveMs', 'runMs', 'warnings']) assert.ok(k in e, k);
    assert.deepEqual([e.nodes, e.bases, e.levels], [52065, 2, 4]);
    assert.ok(e.solveMs > 20 && e.solveMs < 200, `solve ${e.solveMs}`);
    assert.ok(Math.abs(stepsPerParticle(E) - (135 + 52) / 0.125) < 1, 'beam to the detector at x = 135');
    assert.ok(fixedFraction(E) > 0.01 && fixedFraction(E) < 0.06);
    const T = resolve(rfQuadrupole()).resolved;
    assert.ok(fixedFraction(T) > 0.4 && fixedFraction(T) < 0.55, 'quadric rods cover about 46% of the quarter domain');
    assert.equal(multigridShape(T, fixedFraction(T)).levels, 3);
    // more workers: the bases are solved in parallel
    const two = estimateProject(E, { workers: 2 }).solveMs, one = e.solveMs;
    assert.ok(two < one && two > one / 2);
    // measured steps replace the heuristics
    const m = estimateProject(E, { workers: 1, measured: { stepsPerParticle: 3000, stepsPerSec: 1e6 } });
    assert.ok(m.measured && m.stepsPerParticle === 3000 && Math.abs(m.runMs - (5 + 21 * (3 + 0.3))) < 1e-6);
    // big runs ask for confirmation
    const R = resolve(reflectron()).resolved;
    assert.equal(estimateProject({ ...R, particleCount: 20000 }, { workers: 1 }).confirm, true);
});

test('undoing a geometry edit reuses the previous solution without a solve job', { timeout: 120000 }, async () => {
    const { store, jobs, reg, done } = setup(einzel());
    try {
        await once(jobs, 'ran');
        const g0 = store.get().keys.geomKey, s0 = store.get().solution;
        store.update((p) => { p.shapes[0].x0 = -54; });
        await once(jobs, 'ran');
        assert.notEqual(store.get().solution.geomKey, g0);
        const solves = reg.received.filter((t) => t === 'solve').length;
        store.undo();
        await once(jobs, 'ran');
        assert.equal(store.get().solution, s0, 'the earlier solution object is back');
        assert.equal(store.get().solve.status, 'done');
        assert.equal(reg.received.filter((t) => t === 'solve').length, solves, 'no solve job was sent');
        sameF64(store.get().run.result.summary, runProject(einzel()).result.summary, 'run on the reused bases');
    } finally { done(); }
});

test('a run superseded by a newer one does not report', { timeout: 120000 }, async () => {
    const { store, jobs, done } = setup(many(64), { workers: { delay: (m) => (m.type === 'trace' ? 100 : 0) }, jobs: { autoStart: false } });
    try {
        await jobs.solve();
        let ran = 0;
        jobs.on('ran', () => { ran++; });
        const a = jobs.run({ mode: 'full' });
        await sleep(20);
        const b = jobs.run({ mode: 'full' });
        const [ra, rb] = await Promise.all([a, b]);
        assert.ok(ra === null || ra.partial, 'the first run was cut short');
        assert.equal(rb.n, 64);
        assert.equal(ran, 1, 'one report, from the run that owns the state');
        assert.equal(store.get().run.status, 'done');
        assert.equal(store.get().run.result.runId, rb.runId);
    } finally { done(); }
});

test('a throttled progress update is published later, so a long pause never shows a stale count (integration)', { timeout: 120000 }, async () => {
    // the first chunk reports 8 of 16 particles 30 ms before its result (inside the 100 ms throttle window);
    // every other chunk hangs for 3 s, so only a trailing update can show the 16 finished particles
    class HoldingWorker {
        constructor() {
            this.onmessage = null; this.dead = false; this.q = Promise.resolve(); this.hold = null;
            this.handle = createHandler({ post: (m, t) => {
                if (this.dead) return;
                const d = structuredClone(m, { transfer: t || [] });
                if (this.hold && d.type === 'traceResult') { this.hold.push(d); return; }
                setTimeout(() => this.deliver(d), 0);
            } });
        }
        deliver(d) { if (!this.dead && this.onmessage) this.onmessage({ data: d }); }
        postMessage(m, t) {
            const msg = structuredClone(m, { transfer: t || [] });
            this.q = this.q.then(async () => {
                if (this.dead) return;
                if (msg.type === 'trace' && msg.range && msg.range[0] === 0) {
                    this.hold = [];
                    await this.handle(msg);
                    const held = this.hold; this.hold = null;
                    this.deliver({ v: 1, type: 'progress', id: msg.id, done: 8, total: 16 });
                    await sleep(30);
                    for (const d of held) this.deliver(d);
                    return;
                }
                if (msg.type === 'trace') await sleep(3000);
                if (!this.dead) await this.handle(msg);
            });
        }
        terminate() { this.dead = true; }
    }
    const store = createStore(many(64), { mobile: false });
    const pool = createPool({ size: 3, WorkerImpl: HoldingWorker, helloTimeoutMs: 0 });
    const jobs = createJobs(store, pool, null, { mobile: false, autoStart: false, autoSolveDelayMs: 0, previewDelayMs: 0 });
    try {
        assert.ok(await jobs.solve());
        const pr = jobs.run({ mode: 'full' });
        await until(() => store.get().run.progress && store.get().run.progress.done >= 16, 1500, 'the finished first chunk in the progress count');
        jobs.cancelRun();
        const res = await pr;
        assert.ok(res.partial && res.n === 16);
    } finally { jobs.destroy(); pool.terminate(); }
});

test('loading a project with the same geometry (the same preset again, a link, Recent) solves and runs it again (integration)', { timeout: 120000 }, async () => {
    const { store, jobs, reg, done } = setup(einzel());
    try {
        await once(jobs, 'ran');
        const solves = reg.received.filter((t) => t === 'solve').length;
        // replaceProject clears the solution and the run even though every key is unchanged
        const again = once(jobs, 'ran');
        store.replaceProject(einzel(), { label: 'Load preset' });
        assert.equal(store.get().solution, null);
        const ran = await again;
        assert.equal(ran.n, 21);
        assert.equal(store.get().solve.status, 'done');
        assert.equal(store.get().run.status, 'done');
        assert.equal(reg.received.filter((t) => t === 'solve').length, solves, 'the recent solution was reused, no solve job');
        // undoing the load returns to an equal project: its solution and run are current again, nothing is lost
        store.undo();
        await sleep(50);
        assert.ok(store.get().solution && store.get().solution.geomKey === store.get().keys.geomKey);
        assert.equal(store.get().run.status, 'done');
    } finally { done(); }
});
