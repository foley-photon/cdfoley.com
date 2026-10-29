// WP3 pipeline.js: resolve → geometry → raster → solve → field → trace → summary through the real WP1/WP2 engine.
// Acceptance (10, first half): runProject(einzel) ≤ 1.5 s in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../../beta/ion-optics/js/engine/pipeline.js';
import { resolve } from '../../beta/ion-optics/js/engine/schema.js';
import { mergeResults } from '../../beta/ion-optics/js/engine/trace.js';
import { combine } from '../../beta/ion-optics/js/engine/field.js';
import { generate } from '../../beta/ion-optics/js/engine/particles.js';
import { S_STRIDE, S_STATUS, STATUS } from '../../beta/ion-optics/js/engine/layout.js';
import { einzel, rfQuadrupole, magneticSector, plateMirror, reflectron } from './fixtures/wp3/projects.mjs';

const R = (p) => resolve(p).resolved;
function sameF64(a, b, what) {
    assert.equal(a.length, b.length, what);
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) assert.fail(`${what}: differs at ${i}: ${a[i]} vs ${b[i]}`);
}
function sameResult(a, b, what) {
    assert.equal(a.n, b.n, what);
    sameF64(a.summary, b.summary, `${what} summary`);
    sameF64(a.crossings.subarray(0, a.nCross * 14), b.crossings.subarray(0, b.nCross * 14), `${what} crossings`);
    if (a.traj || b.traj) { sameF64(a.traj.offsets, b.traj.offsets, `${what} offsets`); sameF64(a.traj.pts, b.traj.pts, `${what} points`); }
}

let EINZEL = null;   // one solve shared by the tests below
function einzelSolved() {
    if (!EINZEL) { const r = R(einzel()); EINZEL = { r, solved: PL.solveProject(r) }; }
    return EINZEL;
}

test('resolveOrThrow throws E_BAD_PROJECT with every issue; resolved projects pass through', () => {
    const p = einzel();
    p.domain.cell = 0; p.shapes[0].electrode = 'nope';
    assert.throws(() => PL.resolveOrThrow(p), (e) => {
        assert.equal(e.code, 'E_BAD_PROJECT');
        assert.ok(e.message.startsWith('domain.cell: '));
        assert.deepEqual(e.detail.errors.map((x) => x.path).sort(), ['domain.cell', 'shapes[0].electrode']);
        return true;
    });
    const r = PL.resolveOrThrow(einzel());
    assert.equal(PL.resolveOrThrow(r), r);
    assert.deepEqual(r.issues.warnings, []);
});

test('prepare: geometry, level-0 raster and geometry warnings with project paths', () => {
    const p = reflectron();
    p.shapes.unshift({ id: 'off', type: 'box', electrode: 'gnd', x0: 0, x1: 1, y0: 0, y1: 1, enabled: false });
    const r = R(p);
    const prep = PL.prepare(r);
    assert.equal(prep.raster0.grid.N, r.domain.N);
    assert.equal(typeof prep.geometry.classify, 'function');
    assert.ok(prep.warnings.length > 0, 'the full-height meshes touch the grounded y-edges (W_SHORT)');
    for (const w of prep.warnings) if (w.path && w.path.startsWith('shapes[')) assert.ok(!w.path.startsWith('shapes[0]'), `paths refer to the project (disabled shape 0 skipped): ${w.path}`);
});

test('solveProject: one basis per non-ground electrode, progress, cancellation, subsets', () => {
    const { r, solved } = einzelSolved();
    assert.deepEqual([...solved.bases.keys()], [1, 2]);
    for (const [k, phi] of solved.bases) { assert.equal(phi.length, r.domain.N, `basis ${k}`); assert.ok(phi.some((v) => Math.abs(v - 1) < 1e-12), 'fixed nodes at 1 V'); }
    assert.deepEqual(solved.stats.map((s) => [s.k, s.converged, s.path[0]]), [[1, true, 'multigrid'], [2, true, 'multigrid']]);
    const seen = [], got = [];
    const sub = PL.solveProject(r, { electrodes: [2], tol: 1e-8 }, { onProgress: (p) => seen.push(p), onBasis: (k) => got.push(k), progressEveryMs: 0 });
    assert.deepEqual([...sub.bases.keys()], [2]);
    assert.deepEqual(got, [2]);
    assert.ok(seen.length > 0 && seen.every((p) => p.phase === 'solve' && p.k === 2 && p.frac >= 0 && p.frac <= 1));
    let calls = 0;
    assert.throws(() => PL.solveProject(r, {}, { shouldStop: () => ++calls > 3 }), (e) => e.code === 'E_CANCELLED');
    const none = PL.solveProject(R(magneticSector()));
    assert.equal(none.bases.size, 0);
    assert.ok(none.raster0 && none.geometry);
});

test('buildField: channels, display potential and the no-solve case', () => {
    const { r, solved } = einzelSolved();
    const f = PL.buildField(r, solved);
    assert.equal(f.channels.length, 1, 'DC only');
    sameF64(f.channels[0].phi, combine(solved.bases, Float64Array.from([0, 0, 850]), r.domain.N), 'φ0 = Σ dc_k φ_k');
    sameF64(PL.displayPotential(f, 0), f.channels[0].phi, 'display potential at t = 0');
    const out = new Float64Array(10);
    const E = new Float64Array(4);
    f.model.E(0, 0, 5, 0, E);
    assert.ok(Number.isFinite(E[3]) && Math.abs(E[3]) <= 850);
    assert.notEqual(PL.displayPotential(f, 0, out), out, 'a wrong-sized output is replaced');
    // RF: one time channel beside DC; φ(t) = φ0 + f(t)·φ1
    const q = R(rfQuadrupole());
    const fq = PL.buildField(q, PL.solveProject(q));
    assert.equal(fq.channels.length, 2);
    const t = 0.1, w = fq.channels[1].fn.value(t);
    const d = PL.displayPotential(fq, t);
    for (let i = 0; i < d.length; i += 97) assert.ok(Math.abs(d[i] - (fq.channels[0].phi[i] + w * fq.channels[1].phi[i])) < 1e-12);
    // nothing to solve: no grid, magnets still act
    const m = R(magneticSector());
    const fm = PL.buildField(m, PL.solveProject(m));
    assert.equal(fm.grid, null);
    assert.equal(PL.displayPotential(fm, 0), null);
    const B = new Float64Array(3);
    fm.model.B(100, 10, 0, B);
    assert.ok(Math.abs(B[2] + 0.455286) < 1e-12, 'inside the sector');
});

test('a solid electrode turned into a mesh keeps the geometry key but the field model sees the mesh', () => {
    const { solved } = einzelSolved();
    const p = einzel();
    p.electrodes[2].kind = 'grid'; p.electrodes[2].transmission = 1;
    const r2 = R(p);
    assert.equal(solved.geometry.transparent[2], 0);
    const f = PL.buildField(r2, solved);
    assert.equal(f.geometry.transparent[2], 1, 'recompiled with mesh flags');
    assert.equal(f.model.transparent[2], 1);
    assert.notEqual(f.geometry, solved.geometry);
    const same = PL.buildField(einzelSolved().r, solved);
    assert.equal(same.geometry, solved.geometry, 'unchanged flags reuse the cached geometry');
    assert.ok(PL.geometryMatches(solved.geometry, einzelSolved().r));
    assert.ok(!PL.geometryMatches(solved.geometry, r2));
});

test('traceProject: chunks merged in index order equal one pass, bitwise', () => {
    const r = R(plateMirror());
    const f = PL.buildField(r, PL.solveProject(r));
    const all = PL.traceProject(r, f);
    assert.equal(all.n, r.particleCount);
    const parts = [[4, 7], [0, 2], [2, 4]].map(([a, b]) => PL.traceProject(r, f, { i0: a, i1: b }));
    sameResult(mergeResults(parts), all, 'ranges');
    const rows = generate(r.sources, 0, r.particleCount, { domainType: r.domain.type, relativistic: true });
    sameResult(PL.traceProject(r, f, { particles: rows }), all, 'particle rows');
    let polled = 0;
    const stopped = PL.traceProject(r, f, {}, { shouldStop: () => ++polled > 2 });
    let nCancelled = 0;
    for (let i = 0; i < stopped.n; i++) if (stopped.summary[i * S_STRIDE + S_STATUS] === STATUS.CANCELLED) nCancelled++;
    assert.ok(nCancelled > 0, 'shouldStop cancels the remaining particles');
});

test('a voltage change reuses the bases: superposition equals a fresh solve, bitwise', () => {
    const { solved } = einzelSolved();
    const p = einzel();
    p.params[1].value = -8000;
    const fresh = PL.runProject(p);
    const r2 = R(p);
    const reused = PL.traceProject(r2, PL.buildField(r2, solved));
    sameResult(reused, fresh.result, 'reused bases');
    assert.ok(fresh.summary.byStatus.DETECTED === 21);
});

test('runProject(einzel) takes at most 1.5 s and detects all 21 rays', () => {
    let best = Infinity, out = null;
    for (let k = 0; k < 2; k++) {
        const t0 = performance.now();
        out = PL.runProject(einzel());
        best = Math.min(best, performance.now() - t0);
    }
    assert.ok(best <= 1500, `runProject(einzel) ${best.toFixed(0)} ms`);
    for (const k of ['resolveMs', 'solveMs', 'fieldMs', 'traceMs', 'summaryMs', 'totalMs']) assert.equal(typeof out.timings[k], 'number', k);
    assert.equal(out.summary.launched, 21);
    assert.equal(out.summary.byStatus.DETECTED, 21);
    assert.equal(out.summary.transmission.overall, 1);
    assert.ok(out.summary.energy.maxEndRel < 1e-6, `energy ${out.summary.energy.maxEndRel}`);
    console.log(`# runProject(einzel): ${best.toFixed(0)} ms (solve ${out.timings.solveMs.toFixed(0)}, field ${out.timings.fieldMs.toFixed(0)}, trace ${out.timings.traceMs.toFixed(0)})`);
});

test('runProject accepts solver overrides and run overrides', () => {
    const out = PL.runProject(plateMirror(), { solver: { method: 'sor', tol: 1e-8 }, overrides: { record: { everyStep: true } } });
    assert.deepEqual(out.solved.stats.map((s) => s.method), ['sor', 'sor']);
    assert.equal(out.summary.byStatus.DETECTED, 7);
    assert.ok(out.result.traj.pts.length / 4 >= out.result.stats.steps, 'every step recorded');
    assert.equal(PL.solverOptions(R(plateMirror()), { tol: 1e-6 }).tol, 1e-6);
    assert.deepEqual(PL.basisElectrodes(R(reflectron())), [1, 2, 3, 4]);
});
