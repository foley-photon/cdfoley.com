// Round-2 fix pass (engine): regression tests for the verifier findings fixed in the engine, the field analysis, the
// accuracy check and the help-side numbers. Each test names the finding it guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../../beta/ion-optics/js/engine/pipeline.js';
import * as FA from '../../beta/ion-optics/js/engine/fieldanalysis.js';
import * as S from '../../beta/ion-optics/js/engine/schema.js';
import * as io from '../../beta/ion-optics/js/engine/io.js';
import { projectKeys, geomContent, geomKey } from '../../beta/ion-optics/js/engine/hash.js';
import { traceCoulomb } from '../../beta/ion-optics/js/engine/coulomb.js';
import { createFieldModel } from '../../beta/ion-optics/js/engine/fieldmodel.js';
import { traceOptions, planeAcceptor } from '../../beta/ion-optics/js/engine/trace.js';
import { chargeScale } from '../../beta/ion-optics/js/engine/solve.js';
import { CHARGE_BASIS } from '../../beta/ion-optics/js/engine/operator.js';
import { classIndex, groupedBlurMetric } from '../../beta/ion-optics/js/engine/optimize.js';
import { frozenSource, sourceClasses } from '../../beta/ion-optics/js/engine/particles.js';
import { summarize } from '../../beta/ion-optics/js/engine/analysis.js';
import { EPS0 } from '../../beta/ion-optics/js/engine/constants.js';
import * as L from '../../beta/ion-optics/js/engine/layout.js';
import * as AJ from '../../beta/ion-optics/js/ui/analysis-jobs.js';
import { sampleSurface, makeProjector } from '../../beta/ion-optics/js/ui/render-surface.js';
import { einzel } from './fixtures/wp3/projects.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const relEq = (a, b, rel, msg = '') => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg}: ${a} vs ${b} (rel ${(a / b - 1).toExponential(2)})`);
const absEq = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (diff ${(a - b).toExponential(2)})`);
const SUM = (r, i, f) => r.summary[i * L.S_STRIDE + f];

// ---------------------------------------------------------------- a small project builder (planar or cylindrical boxes)
const ED = (electrode) => ({ bc: 'dirichlet', electrode });
const NEU = { bc: 'neumann' };
function proj(o) {
    const cyl = o.type === 'cyl2d';
    return {
        format: 'ion-optics-project', version: 1,
        meta: { name: o.name || 'fix test', notes: '', created: '2026-10-14T00:00:00Z', modified: '2026-10-14T00:00:00Z', engine: '0.2.0' },
        params: o.params || [],
        domain: { type: o.type || 'planar2d', cell: o.cell, x: o.x, y: o.y,
            edges: { xmin: ED('gnd'), xmax: ED('gnd'), ymin: cyl ? { bc: 'axis' } : ED('gnd'), ymax: ED('gnd'), ...(o.edges || {}) },
            mirror: { x: false, y: false, ...(o.mirror || {}) }, antimirror: { x: false, y: false, ...(o.antimirror || {}) }, charge: o.charge || '',
            beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' } },
        electrodes: [{ id: 'gnd', name: 'Ground', ground: true, color: '#64748b' }, ...(o.electrodes || [])],
        shapes: (o.shapes || []).map((s, i) => ({ id: 's' + (i + 1), enabled: true, locked: false, ...s })),
        magnets: o.magnets || [], idealFields: [], sources: o.sources || [],
        recording: { planes: o.planes || [], trajectories: { store: o.store !== false, maxPoints: 2000 }, timeMarkers: o.markers ? { dt: o.markers } : null },
        tracer: { integrator: 'auto', quality: 'normal', custom: null, fieldInterp: 'cubic', relativistic: false, tMax: o.tMax || 1000, maxSteps: 500000, maxDrift: 10000,
            drag: null, spaceCharge: o.spaceCharge || null, gas: null },
        solver: { boundary: 'subgrid', method: 'auto', tol: o.tol || 1e-12, maxCycles: 60, maxIterations: 200, maxSweeps: 100000 },
        analysis: { lens: null, scan: null, optimize: null, waist: null },
        view: { center: [0, 0], scale: 5, displayTime: 0, projection: 'xy', colormap: 'auto', contourLevels: null,
            layers: { potential: true, contours: 20, field: false, electrodes: true, trajectories: 'source', planes: true, hits: true, grid: 'auto', mirror: true, markers: false } },
    };
}
const el = (id, v = 0) => ({ id, name: id, kind: 'solid', v, wave: null, color: '#2563eb' });
function solveAll(p) {
    const resolved = PL.resolveOrThrow(p), solved = PL.solveProject(resolved);
    return { resolved, solved, field: PL.buildField(resolved, solved) };
}

// ================================================================ cache keys (code finding 1, high)
test('hash: the values of the parameters a charge density uses key the solution, so a changed ρ re-solves; no-parameter charges keep their key', () => {
    const mk = (v, extra = 1) => { const p = einzel(); p.domain.cell = 1; p.params.push({ name: 'rho0', value: v, dim: 'none' }, { name: 'other', value: extra, dim: 'none' }); p.domain.charge = 'rho0'; return p; };
    const a = projectKeys(S.resolve(mk(1e-5)).resolved), b = projectKeys(S.resolve(mk(5e-5)).resolved);
    assert.notEqual(a.geomKey, b.geomKey); assert.notEqual(a.fieldKey, b.fieldKey); assert.notEqual(a.runKey, b.runKey);
    assert.equal(geomKey(S.resolve(mk(1e-5, 1)).resolved), geomKey(S.resolve(mk(1e-5, 2)).resolved), 'a parameter the density does not use leaves the key');
    assert.deepEqual(geomContent(S.resolve(mk(1e-5)).resolved).d.charge, { e: 'rho0', p: { rho0: 1e-5 } });
    const plain = einzel(); plain.domain.charge = '1e-6';
    assert.equal(geomContent(S.resolve(plain).resolved).d.charge, '1e-6', 'a density without parameters is keyed by its text, as before');
    // Scan & tune: a ρ parameter now moves the geometry, so every scan point re-solves its charge basis
    const ctx = { engine: { schema: S, hash: { geomKey } } };
    assert.equal(AJ.variableMovesGeometry(ctx, mk(1e-5), { kind: 'param', id: 'rho0' }, 5e-5), true);
    assert.equal(AJ.variableMovesGeometry(ctx, mk(1e-5), { kind: 'param', id: 'Vc' }, 700), false, 'a voltage parameter still needs no solve');
});

// ================================================================ space-charge (lockstep) tracer (code findings 2, 6, 7; brief)
test('space-charge tracer with factor 0 equals the ordinary tracer: plane limits, time markers and thinned trajectories', () => {
    const base = einzel();
    base.domain.cell = 0.5;
    base.recording.planes[0].limits = { a: [-0.5, 0.5], b: null };
    base.recording.timeMarkers = { dt: 0.5 };
    base.recording.trajectories.maxPoints = 50;
    const sc = clone(base);
    sc.tracer.spaceCharge = { enabled: true, factor: 0 };
    const A = PL.runProject(base).result, B = PL.runProject(sc).result;
    assert.equal(B.stats.lockstep, true);
    const det = (r) => { const ids = []; for (let i = 0; i < r.n; i++) if (SUM(r, i, L.S_STATUS) === L.STATUS.DETECTED) ids.push(SUM(r, i, L.S_ID)); return ids.sort((x, y) => x - y); };
    assert.ok(det(A).length > 0 && det(A).length < A.n, 'the limits keep only part of the beam');
    assert.deepEqual(det(B), det(A), 'the lockstep tracer applies the plane limits');
    // time markers: same count, positions on the step's cubic path, grouped by particle in time order
    assert.ok(B.markers && B.markers.length === A.markers.length, `markers ${B.markers && B.markers.length / 5} vs ${A.markers.length / 5}`);
    const pos = new Map();
    for (let k = 0; k < A.markers.length; k += 5) pos.set(`${A.markers[k]}|${A.markers[k + 1].toFixed(4)}`, [A.markers[k + 2], A.markers[k + 3], A.markers[k + 4]]);
    let worst = 0;
    for (let k = 0; k < B.markers.length; k += 5) {
        const q = pos.get(`${B.markers[k]}|${B.markers[k + 1].toFixed(4)}`);
        assert.ok(q, `marker of particle ${B.markers[k]} at ${B.markers[k + 1]}`);
        // the rays the limits reject drift on to the 10 m drift limit: compare beyond the Float32 rounding of the stored positions
        const scale = Math.max(Math.abs(q[0]), Math.abs(q[1]), Math.abs(q[2]));
        worst = Math.max(worst, Math.hypot(q[0] - B.markers[k + 2], q[1] - B.markers[k + 3], q[2] - B.markers[k + 4]) / (1e-4 + 5e-7 * scale));
        if (k > 0 && B.markers[k] === B.markers[k - 5]) assert.ok(B.markers[k + 1] > B.markers[k - 4], 'time order within a particle');
        if (k > 0) assert.ok(B.markers[k] >= B.markers[k - 5], 'grouped by particle');
    }
    assert.ok(worst < 1, `marker positions agree within 1e-4 mm + 5e-7 of their size: worst ratio ${worst.toFixed(3)}`);
    // thinning keeps the early history: the largest gap between stored points is like the ordinary tracer's
    const gap = (r, i) => { let g = 0; const P = r.traj.pts; for (let k = r.traj.offsets[i] + 1; k < r.traj.offsets[i + 1]; k++) g = Math.max(g, Math.hypot(P[4 * k] - P[4 * k - 4], P[4 * k + 1] - P[4 * k - 3])); return g; };
    for (const i of [0, 10, 20]) assert.ok(gap(B, i) <= 1.5 * gap(A, i) + 1, `particle ${i}: largest gap ${gap(B, i).toFixed(1)} vs ${gap(A, i).toFixed(1)} mm`);
    assert.ok(B.traj.offsets[1] - B.traj.offsets[0] <= 50, 'the point cap holds');
    // one acceptance rule for both tracers
    const acc = planeAcceptor([{ kind: 'x', at: 0, limits: { a: [-1, 1], b: [0, 2] }, side: 'forward' }], 1, false);
    assert.equal(acc(0, 0, 0.5, 1, 1), true); assert.equal(acc(0, 0, 1.5, 1, 1), false); assert.equal(acc(0, 0, 0.5, 3, 1), false); assert.equal(acc(0, 0, 0.5, 1, -1), false);
});

test('space-charge tracer: per-source charge factors scale the partner charge (previews and accuracy subsets)', () => {
    const model = createFieldModel({ resolved: { domain: { type: 'planar2d', cell: 1, h: 1, x: [-500, 500], y: [-500, 500], nx: 1001, ny: 1001, mirror: { x: false, y: false }, beyond: {} }, electrodes: [{ id: 'gnd' }], magnets: [], idealFields: [] } });
    const mp = 1.0072764665789;
    const P = new Float64Array(2 * L.P_STRIDE);
    for (let i = 0; i < 2; i++) { const o = i * L.P_STRIDE; P[o + L.P_ID] = i; P[o + L.P_SRC] = i; P[o + L.P_MASS] = mp; P[o + L.P_CHARGE] = 1; P[o + L.P_X] = i ? 0.0005 : -0.0005; }
    const opts = { relativistic: false, tMax: 50, softening: 1e-7, pairStep: 0.02, record: { trajectories: false } };
    const f4 = traceCoulomb(model, P, { ...opts, factor: 4 }), s4 = traceCoulomb(model, P, { ...opts, factorBySource: [4, 4] });
    relEq(SUM(s4, 0, L.S_KE), SUM(f4, 0, L.S_KE), 1e-12, 'a factor of 4 for every source equals factor 4');
    const asym = traceCoulomb(model, P, { ...opts, factorBySource: [3, 1] });
    relEq(SUM(asym, 1, L.S_KE) / SUM(asym, 0, L.S_KE), 9, 1e-9, 'particle 1 feels its partner with factor 3: three times the speed');
    const r = S.resolve(proj({ cell: 1, x: [-5, 5], y: [-5, 5], spaceCharge: { enabled: true, factor: 2 } })).resolved;
    const co = PL.coulombOptions(r, traceOptions(r, { factorScale: [2, 0.5] }));
    assert.deepEqual(co.factorBySource, [2, 0.5]); assert.equal(co.factor, 2, 'the project factor stays; the array scales by source');
    assert.equal(PL.coulombOptions(r, traceOptions(r, { factorScale: 3 })).factor, 6); assert.equal(PL.coulombOptions(r, traceOptions(r, { factorScale: 3 })).factorBySource, null);
});

test('a charge density alone is an electric field: hasE (integrator choice) and the potential span include φ_ρ', () => {
    const p = einzel();
    p.domain.cell = 1;
    p.params.find((q) => q.name === 'Vc').value = 0;
    p.magnets = [{ id: 'm1', name: 'u', enabled: true, type: 'uniform', B: [0.05, 0, 0] }];
    const without = solveAll(p);
    assert.equal(without.field.model.hasE, false, 'all electrodes at 0 V and no charge: magnetic only, as before');
    p.domain.charge = '1e-5';
    const S1 = solveAll(p);
    let mx = 0;
    for (const v of S1.solved.bases.get(CHARGE_BASIS)) mx = Math.max(mx, v);
    assert.equal(S1.field.model.hasE, true);
    relEq(S1.field.model.vSpan, mx, 1e-12, 'the span covers the space-charge potential');
});

// ================================================================ field analysis: space charge (physics finding 3, code finding 3)
test('Charges with a charge density: Green reciprocity gives −ρdH/2 = −20 pC/m on each plate and the floating plate 5.64705 V', () => {
    const rho = 1e-6, d = 10, H = 4;
    for (const cell of [0.25, 0.5]) {
        const p = proj({ cell, x: [0, d], y: [0, H], edges: { xmin: ED('E1'), xmax: ED('gnd'), ymin: NEU, ymax: NEU }, electrodes: [el('E1', 0)],
            params: [{ name: 'rho0', value: rho, dim: 'none' }], charge: 'rho0' });
        const { resolved, solved } = solveAll(p);
        const part = FA.chargePartition(solved.raster0), cm = FA.capacitanceMatrix(part, solved.bases);
        const sc = FA.spaceChargeCharges(part, solved, resolved);
        absEq(sc.charge[1] * 1e12, -20, 1e-9, 'E1 (pC/m)'); absEq(sc.charge[0] * 1e12, -20, 1e-9, 'ground (pC/m)');
        absEq(sc.space * 1e12, 40, 1e-9, 'space charge ρdH');
        // the contour estimate (Gauss on φ_ρ minus the enclosed charge) misses the half cells next to the plates: first order
        absEq(sc.gauss[1] * 1e12, -20 + rho * (cell * 1e-3) * (H * 1e-3) / 2 * 1e12, 1e-6, 'Gauss estimate −ρ(d − h)H/2');
        const fl = FA.floatingPotentials(cm, [0, 0], [{ index: 1, charge: 0 }], { induced: sc.charge });
        relEq(fl.volts[1], rho * (d * 1e-3) ** 2 / (2 * EPS0), 1e-9, 'floating E1 (V)');
        const q = FA.floatingPotentials(cm, [0, 0], [], { induced: sc.charge });
        absEq((q.charges[0] + q.charges[1]) * 1e12, -40, 1e-9, 'the conductors carry minus the space charge');
    }
    // without a density there is nothing to add
    const plain = proj({ cell: 1, x: [0, 10], y: [0, 4], electrodes: [el('E1', 0)], edges: { xmin: ED('E1') } });
    const s0 = solveAll(plain);
    assert.equal(FA.spaceChargeCharges(FA.chargePartition(s0.solved.raster0), s0.solved, s0.resolved), null);
});

test('Charges with a charge density: the reciprocity charges converge, and the contour estimate approaches them at first order (cylindrical einzel)', () => {
    const at = (cell) => {
        const p = einzel();
        p.domain.cell = cell;
        p.params.push({ name: 'rho0', value: 1e-5, dim: 'none' });
        p.domain.charge = 'rho0';
        p.sources = [];
        const { resolved, solved } = solveAll(p);
        return FA.spaceChargeCharges(FA.chargePartition(solved.raster0), solved, resolved);
    };
    const c = at(0.5), f = at(0.25);
    for (let e = 0; e < 3; e++) {
        relEq(f.charge[e], c.charge[e], 2e-3, `electrode ${e}: reciprocity charge, cell 0.25 vs 0.5`);
        const r = (f.gauss[e] - f.charge[e]) / (c.gauss[e] - c.charge[e]);
        assert.ok(r > 0.35 && r < 0.65, `electrode ${e}: the contour estimate's gap halves with the cell (ratio ${r.toFixed(3)})`);
    }
    relEq(c.charge.reduce((a, b) => a + b, 0), -c.space, 1e-12, 'all conductors carry −∫ρ dV');
    assert.ok(c.space > 0 && c.charge.every((q) => q < 0), 'positive space charge induces negative charge everywhere');
});

// ================================================================ field analysis: anti-mirror planes (physics finding 1, code finding 4)
function deflector(half) {
    const shapes = [{ type: 'box', electrode: 'A', x0: -10, x1: 10, y0: 5, y1: 6 }];
    if (!half) shapes.push({ type: 'box', electrode: 'B', x0: -10, x1: 10, y0: -6, y1: -5 });
    return proj({ cell: 0.5, x: [-30, 30], y: half ? [0, 30] : [-30, 30], antimirror: { y: !!half }, tol: 1e-12,
        electrodes: half ? [el('A', 100)] : [el('A', 100), el('B', -100)], shapes });
}
test('anti-mirror models: the evaluator folds the odd half, multipoles about the plane work, and the full-system tools refuse', () => {
    const F = solveAll(deflector(false)), Hm = solveAll(deflector(true));
    const evF = FA.voltageEvaluator(F.solved, F.resolved, [0, 100, -100]), evH = FA.voltageEvaluator(Hm.solved, Hm.resolved, [0, 100]);
    for (const [x, y] of [[0, 3], [0, -3], [4, -1], [-7, -2.5], [12, -8]]) {
        absEq(evH.potential(0, x, y), evF.potential(0, x, y), 1e-8, `φ(${x}, ${y})`);
        const a = new Float64Array(3), b = new Float64Array(3);
        evH.field(0, x, y, 0, a); evF.field(0, x, y, 0, b);
        absEq(a[0], b[0], 1e-8, `E_x(${x}, ${y})`); absEq(a[1], b[1], 1e-8, `E_y(${x}, ${y})`);
    }
    const opts = { cx: 0, cy: 0, R: 2, r0: 2, nMax: 6, samples: 360 };
    const mH = FA.multipoleCircle(FA.potentialSampler(evH), opts), mF = FA.multipoleCircle(FA.potentialSampler(evF), opts);
    for (let n = 0; n <= 6; n++) { absEq(mH.a[n], mF.a[n], 1e-7, `a${n}`); absEq(mH.b[n], mF.b[n], 1e-7, `b${n}`); }
    assert.ok(Math.abs(mH.b[1]) > 1, 'the deflector is a dipole across the plane');
    // the 1 V bases are odd-mode solutions: no capacitance matrix and no weighting potentials of the full device
    const part = FA.chargePartition(Hm.solved.raster0);
    assert.ok(part.plane === part.nE && part.antimirror.y, 'the anti-mirror plane is a region of its own');
    assert.throws(() => FA.capacitanceMatrix(part, Hm.solved.bases), (e) => e.code === 'E_UNSUPPORTED' && /odd-mode/.test(e.message));
    assert.throws(() => FA.weightingPotentials(Hm.solved, Hm.resolved, [1]), (e) => e.code === 'E_UNSUPPORTED');
    assert.equal(FA.antimirrorOf(Hm.solved, Hm.resolved), true); assert.equal(FA.antimirrorOf(F.solved, F.resolved), false);
    // odd mode on request: the charge of plate A in the antisymmetric configuration is the full model's
    const cmH = FA.capacitanceMatrix(part, Hm.solved.bases, { allowOddMode: true });
    const cmF = FA.capacitanceMatrix(FA.chargePartition(F.solved.raster0), F.solved.bases);
    assert.equal(cmH.mode, 'odd'); assert.equal(cmF.mode, 'full');
    const qH = FA.floatingPotentials(cmH, [0, 100], []).charges, qF = FA.floatingPotentials(cmF, [0, 100, -100], []).charges;
    relEq(qH[1], qF[1], 2e-3, 'charge on plate A');
    relEq(cmH.C[1 * cmH.n + 1], cmF.C[1 * cmF.n + 1] - cmF.C[1 * cmF.n + 2], 2e-3, 'odd-mode coefficient C_AA − C_AB');
    assert.ok(Number.isFinite(cmH.planeRow[1]) && cmH.planeRow[1] < 0, 'the plane takes the image charge');
    absEq(qH[0] + qH[1] + cmH.planeRow[1] * 100, 0, 1e-6 * Math.abs(qH[1]), 'ground half, plate and plane balance');
    assert.ok(Math.abs(qH[0]) < 0.25 * Math.abs(qH[1]), 'the plane no longer counts as ground');
});

// ================================================================ Gauss–Legendre (clean room, code finding)
// Reference: Newton's method on P_n in 256-bit fixed-point arithmetic, weights 2/((1 − x²)P_n'(x)²) (A&S 25.4.29).
const SH = 256n, ONE = 1n << SH;
const fxp = (v) => {
    if (v === 0) return 0n;
    const sg = v < 0 ? -1n : 1n; let a = Math.abs(v), e = 0;
    while (a < 2 ** 52) { a *= 2; e++; } while (a >= 2 ** 53) { a /= 2; e--; }
    const m = BigInt(a), s = SH - BigInt(e);
    return sg * (s >= 0n ? m << s : m >> -s);
};
const mul = (a, b) => (a * b) >> SH, div = (a, b) => (a << SH) / b;
const toD = (a) => { const neg = a < 0n, b = neg ? -a : a, bits = b.toString(2).length, s = BigInt(Math.max(0, bits - 60)); const v = Number(b >> s) * 2 ** Number(s - SH); return neg ? -v : v; };
function legendreFx(n, x) { let p0 = ONE, p1 = x; for (let k = 1; k < n; k++) { const p2 = (BigInt(2 * k + 1) * mul(x, p1) - BigInt(k) * p0) / BigInt(k + 1); p0 = p1; p1 = p2; } return [p1, p0]; }
function glRef(n, x0) {
    let x = fxp(x0), dp = 0n;
    for (let it = 0; it < 6; it++) { const [pn, pm] = legendreFx(n, x); dp = div(BigInt(n) * (mul(x, pn) - pm), mul(x, x) - ONE); x -= div(pn, dp); }
    const [pn, pm] = legendreFx(n, x); dp = div(BigInt(n) * (mul(x, pn) - pm), mul(x, x) - ONE);
    return [toD(x), toD(div(2n * ONE, mul(ONE - mul(x, x), mul(dp, dp))))];
}
test('gaussLegendre (Golub–Welsch eigenvalues, Christoffel weights) matches a high-precision Newton reference to 1e-14 for n ≤ 64', () => {
    let wx = 0, ww = 0;
    for (let n = 2; n <= 64; n++) {
        const g = FA.gaussLegendre(n);
        for (let i = 0; i < n; i++) {
            const [xr, wr] = glRef(n, g.x[i]);
            wx = Math.max(wx, Math.abs(g.x[i] - xr)); ww = Math.max(ww, Math.abs(g.w[i] - wr));
            if (i > 0) assert.ok(g.x[i] > g.x[i - 1], 'ascending');
            assert.ok(g.x[i] === -g.x[n - 1 - i] && g.w[i] === g.w[n - 1 - i], `symmetric rule, n ${n}, node ${i}`);
        }
    }
    assert.ok(wx <= 1e-14 && ww <= 1e-14, `nodes ${wx.toExponential(2)}, weights ${ww.toExponential(2)}`);
    // closed forms (A&S 25.4.29 table) and exactness to degree 2n − 1
    const g1 = FA.gaussLegendre(1); assert.deepEqual([g1.x[0], g1.w[0]], [0, 2]);
    const g3 = FA.gaussLegendre(3);
    absEq(g3.x[2], Math.sqrt(3 / 5), 5e-16, 'n 3 node'); absEq(g3.w[1], 8 / 9, 5e-16, 'n 3 center weight'); absEq(g3.w[0], 5 / 9, 5e-16, 'n 3 weight');
    const g4 = FA.gaussLegendre(4);
    absEq(g4.x[3], Math.sqrt(3 / 7 + 2 / 7 * Math.sqrt(6 / 5)), 5e-16, 'n 4 outer node'); absEq(g4.w[3], (18 - Math.sqrt(30)) / 36, 5e-16, 'n 4 outer weight');
    const g40 = FA.gaussLegendre(40);
    for (let k = 0; k < 40; k++) { let s = 0; for (let i = 0; i < 40; i++) s += g40.w[i] * g40.x[i] ** (2 * k); absEq(s, 2 / (2 * k + 1), 2e-14, `∫x^${2 * k}`); }
});

// ================================================================ spectrum peak (physics finding 7)
test('spectrum: the peak of an off-bin tone is located from the window response (Hann and rectangular)', () => {
    const N = 1024, TWO_PI = 2 * Math.PI;
    for (const win of ['hann', 'none']) {
        let wf = 0, wa = 0;
        for (let k = 0; k <= 20; k++) {
            const off = -0.5 + k / 20, f0 = (N / 8 + off) / N;
            const t = new Float64Array(N), y = new Float64Array(N);
            for (let i = 0; i < N; i++) { t[i] = i; y[i] = 2.5 * Math.cos(TWO_PI * f0 * i + 0.7); }
            const sp = FA.spectrum(t, y, { window: win });
            wf = Math.max(wf, Math.abs(sp.peak.freq - f0) / sp.df); wa = Math.max(wa, Math.abs(sp.peak.amp / 2.5 - 1));
            assert.ok(Math.abs(sp.peak.offset) <= 0.5);
        }
        const tolF = win === 'hann' ? 1e-6 : 2e-3, tolA = win === 'hann' ? 1e-6 : 2e-3;
        assert.ok(wf < tolF && wa < tolA, `${win}: |Δf| ${wf.toExponential(2)} bin, |ΔA| ${wa.toExponential(2)}`);
    }
});

// ================================================================ solver: the charge scale (physics finding 6)
test('chargeScale bounds Neumann-edged problems and the solve re-scales to the computed potential: no false non-convergence', () => {
    // uniform ρ, Dirichlet at x = 0, Neumann elsewhere: φ peaks at f·L²/2 on the far edge
    const slab = proj({ cell: 0.5, x: [0, 20], y: [0, 4], edges: { xmin: ED('E1'), xmax: NEU, ymin: NEU, ymax: NEU }, electrodes: [el('E1', 0)], charge: '1e-6', tol: 1e-12 });
    const r = PL.resolveOrThrow(slab), sol = PL.solveProject(r), st = sol.stats.find((s) => s.k === CHARGE_BASIS);
    let mx = 0; for (const v of sol.bases.get(CHARGE_BASIS)) mx = Math.max(mx, Math.abs(v));
    relEq(st.scale, mx, 0.01, 'scale vs max |φ_ρ|');
    assert.equal(st.converged, true); assert.deepEqual(st.warnings, []);
    // a narrow beam in a long open tube: the bound is far above the potential, so the solve continues at the computed scale
    const beam = proj({ type: 'cyl2d', cell: 0.25, x: [0, 100], y: [0, 10], edges: { xmin: NEU, xmax: NEU }, charge: '1e-6*exp(-r*r)', tol: 1e-10 });
    const rb = PL.resolveOrThrow(beam), sb = PL.solveProject(rb), stb = sb.stats.find((s) => s.k === CHARGE_BASIS);
    let mb = 0; for (const v of sb.bases.get(CHARGE_BASIS)) mb = Math.max(mb, Math.abs(v));
    assert.equal(stb.rescaled, true); relEq(stb.scale, mb, 1e-6, 'the scale is the computed max |φ_ρ|'); assert.equal(stb.converged, true);
    // a box with Dirichlet edges all round keeps the earlier bound (n²/8 on the shorter side)
    const box = PL.resolveOrThrow(proj({ cell: 1, x: [0, 32], y: [0, 16], charge: '1e-6' }));
    const H = PL.solveProject(box, { keepHierarchy: true }).hierarchy;
    let m = 0; for (let k = 0; k < H[0].N; k++) if (H[0].mask[k] !== 1) m = Math.max(m, H[0].source[k]);
    relEq(chargeScale(H[0], H[0].source), m * 16 * 16 / 8, 1e-15, 'closed box');
});

// ================================================================ schema (code finding: charge probe; physics finding 4: anti-mirror with ρ)
test('schema: the charge density is probed at cell centers inside the domain, and an anti-mirror plane with a density warns', () => {
    const p = einzel(); p.domain.charge = '1e-6*sqrt(50-x)';
    const r = S.resolve(p);
    assert.ok(r.errors.some((e) => e.path === 'domain.charge' && e.code === 'E_NOT_FINITE' && /not finite at \(/.test(e.message)), JSON.stringify(r.errors));
    const ok = einzel(); ok.domain.charge = '1e-6*sqrt(141-x)';
    assert.deepEqual(S.resolve(ok).errors, []);
    const am = proj({ cell: 1, x: [-10, 10], y: [0, 10], antimirror: { y: true }, charge: '1e-6' });
    const ra = S.resolve(am);
    assert.deepEqual(ra.errors, []);
    assert.ok(ra.warnings.some((w) => w.code === 'W_CHARGE_ANTIMIRROR' && /−ρ/.test(w.message)));
    assert.ok(!S.resolve(proj({ cell: 1, x: [-10, 10], y: [0, 10], antimirror: { y: true } })).warnings.some((w) => w.code === 'W_CHARGE_ANTIMIRROR'));
    // a list's class indices: malformed ones are reported and ignored
    const bad = proj({ cell: 1, x: [-10, 10], y: [-10, 10], sources: [{ id: 'r', name: 'r', enabled: true, type: 'rows', rows: [[100, 1, 0, 0, 0, 1, 0, 0, 10, 0]], classes: [[0, 'x', 1]] }] });
    const rb = S.resolve(bad);
    assert.deepEqual(rb.errors, []); assert.ok(rb.warnings.some((w) => w.code === 'W_CLASSES'));
    assert.equal(rb.resolved.sources[0].classes, null);
});

test('particle CSV rejects an infinite mass or kinetic energy', () => {
    const head = 'mass_u,charge_e,x_mm,y_mm,z_mm,dx,dy,dz,ke_eV,t0_us\n';
    const r = io.parseParticlesCSV(head + 'inf,1,0,0,0,1,0,0,10,0\n100,1,0,0,0,1,0,0,Infinity,0\n100,1,0,0,0,1,0,0,10,0\n');
    assert.equal(r.rows.length, 1); assert.deepEqual(r.errors.map((e) => e.line), [2, 3]);
    const v = io.parseParticlesCSV('mass_u,charge_e,x_mm,y_mm,z_mm,vx_mm_us,vy_mm_us,vz_mm_us,ke_eV,t0_us\n100,1,0,0,0,1,0,0,inf,0\n');
    assert.equal(v.rows.length, 0); assert.equal(v.errors.length, 1);
});

// ================================================================ frozen lists keep their class indices (physics finding 5)
test('Freeze to list stores the class indices, so grouped metrics group exactly as the sampled source did', () => {
    const det = { id: 'det', name: 'det', kind: 'x', at: 50, limits: null, radius: null, terminate: true, side: 'both', record: 'first' };
    const src = (o) => ({ id: 'b', name: 'b', enabled: true, color: 'auto', seed: 3, species: [{ label: 'm', mass: 100, charge: 1, fraction: 1 }], time: { type: 'fixed', t: 0 }, ...o });
    const cases = [
        src({ sampling: 'grid', count: 5, position: { type: 'point', p: [0, 0, 0] }, direction: { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: -2, to: 2, n: 5 }, energy: { type: 'mono', ke: 100 } }),
        src({ sampling: 'random', count: 300, position: { type: 'disc', center: [0, 0, 0], normal: [1, 0, 0], radius: 1 }, direction: { type: 'cone', axis: [1, 0, 0], halfAngle: 3, fill: 'solid' }, energy: { type: 'list', values: [80, 100, 120] } }),
    ];
    for (const s of cases) {
        const p = proj({ cell: 1, x: [-10, 60], y: [-30, 30], edges: { xmin: NEU, xmax: NEU, ymin: NEU, ymax: NEU }, sources: [s], planes: [det], tMax: 100 });
        const A = solveAll(p), resA = PL.traceProject(A.resolved, A.field);
        const q = clone(p);
        q.sources = A.resolved.sources.map((x) => frozenSource(x, { relativistic: false }));
        assert.ok(q.sources[0].classes === 'random' || Array.isArray(q.sources[0].classes));
        assert.deepEqual(sourceClasses(S.resolve(q).resolved.sources[0]), q.sources[0].classes);
        const B = solveAll(q), resB = PL.traceProject(B.resolved, B.field);
        assert.deepEqual([...classIndex(B.resolved)], [...classIndex(A.resolved)], `${s.sampling}: class indices`);
        const m = { type: 'groupedBlur', plane: 'det' };
        assert.equal(groupedBlurMetric(resB, B.resolved, 0, m), groupedBlurMetric(resA, A.resolved, 0, m), `${s.sampling}: grouped blur bitwise`);
    }
});

// ================================================================ accuracy check, pins, methods text (code findings)
/** A synchronous stand-in for the jobs object: temporary projects solved and traced through the pipeline. */
function fakeCtx(project) {
    const resolved = S.resolve(project).resolved;
    return {
        store: { get: () => ({ project, resolved }) },
        jobs: {
            withTemporaryProject: async (p, fn) => {
                const r = PL.resolveOrThrow(p), solved = PL.solveProject(r), f = PL.buildField(r, solved);
                return fn({ resolved: r, estimate: () => null,
                    traceBatch: async ({ particles = null, range = null, overrides = {} } = {}) => (particles
                        ? PL.traceProject(r, f, { particles, overrides, total: particles.length / L.P_STRIDE })
                        : PL.traceProject(r, f, { i0: range[0], i1: range[1], overrides })) });
            },
        },
    };
}
test('accuracy check on a space-charge run: subsets keep each source\'s charge and the comparison run shortens the lockstep steps', async () => {
    const p = einzel();
    p.domain.cell = 1;
    p.sources[0].count = 21;
    p.sources.push({ ...clone(p.sources[0]), id: 'b2', name: 'second', count: 7, position: { type: 'line', p0: [-52, -1, 0], p1: [-52, 1, 0], n: 7 } });
    p.tracer.spaceCharge = { enabled: true, softening: 0.05, factor: 2e5 };
    const r = S.resolve(p).resolved;
    const sub = AJ.spaceChargeSubset(r, 10);
    assert.equal(sub.n, 10); assert.deepEqual(sub.scale, [21 / 5, 7 / 5]);
    assert.deepEqual(Array.from({ length: sub.n }, (_, i) => sub.particles[i * L.P_STRIDE + L.P_SRC]), [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
    const rep = await AJ.accuracyCheck(fakeCtx(p), { maxParticles: 10 });
    assert.equal(rep.tightening, 'steps'); assert.equal(rep.tightLabel, 'steps/√10'); assert.equal(rep.particles, 10);
    assert.ok(rep.notes.some((n) => /Space charge/.test(n)));
    const moved = rep.rows.filter((row) => Number.isFinite(row.dTol) && row.dTol !== 0);
    assert.ok(moved.length > 0, 'the shortened steps change the trajectories (the old rtol/100 run was identical)');
    // (a back-extrapolated waist of the diverging beam is ill-conditioned; the end points measure the step error)
    assert.ok(rep.endShift.rtol > 0 && rep.endShift.rtol < 1e-2 && rep.endShift.rtol < 0.1 * rep.endShift.grid,
        `end-point shift from the steps ${rep.endShift.rtol.toExponential(2)} mm (grid ${rep.endShift.grid.toExponential(2)} mm)`);
    const plain = einzel(); plain.domain.cell = 1;
    const rp = await AJ.accuracyCheck(fakeCtx(plain), { maxParticles: 5 });
    assert.equal(rp.tightening, 'rtol'); assert.equal(rp.particles, 5);
});

test('pins: an empty pin list removes the stored entry; the Methods text says "centers" and notes −ρ across an anti-mirror plane', () => {
    const map = new Map();
    const store = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
    map.set(AJ.PINS_STORAGE_KEY, '{"version":1,"pins":[]}');
    assert.equal(AJ.writePins([], store), true);
    assert.equal(store.getItem(AJ.PINS_STORAGE_KEY), null, 'nothing left for the startup probe to load');
    const p = einzel(); p.domain.charge = '1e-6';
    const text = AJ.methodsText({ resolved: S.resolve(p).resolved }, { bench: null });
    assert.match(text, /cell centers/); assert.doesNotMatch(text, /centres/);
    const am = proj({ cell: 1, x: [-10, 10], y: [0, 10], antimirror: { y: true }, charge: '1e-6' });
    assert.match(AJ.methodsText({ resolved: S.resolve(am).resolved }, { bench: null }), /image half carries −ρ/);
});

// ================================================================ summaries and the surface (user findings)
test('summaries say why energy conservation was not checked; the surface height scale has a floor', () => {
    const n = 2, S0 = new Float64Array(n * L.S_STRIDE);
    for (let i = 0; i < n; i++) { S0[i * L.S_STRIDE + L.S_DE_END] = NaN; S0[i * L.S_STRIDE + L.S_STATUS] = L.STATUS.TMAX; }
    const res = { n, summary: S0, crossings: new Float64Array(0), nCross: 0 };
    assert.equal(summarize(res, { tracer: { spaceCharge: { enabled: true } } }).energy.notChecked, 'plugins');
    assert.equal(summarize(res, { tracer: {} }).energy.notChecked, 'outside');
    S0[L.S_FLAGS] = L.FLAG.TD_FIELDS;
    assert.equal(summarize(res, { tracer: {} }).energy.notChecked, 'time');
    S0[L.S_DE_END] = 1e-9;
    assert.equal(summarize(res, { tracer: {} }).energy.notChecked, null);
    // a field near a zero of its drive: with the floor at the full span the relief is the span's, not stretched
    const phi = new Float64Array(9).fill(0); phi[4] = 3e-14;
    const surf = sampleSurface({ phi, nx: 3, ny: 3, x0: 0, y0: 0, h: 1 });
    const free = makeProjector(surf, {}), floored = makeProjector(surf, { zFloor: 500 });
    relEq(floored.zScale, free.zScale * 3e-14 / 500, 1e-9, 'height scale');
    assert.equal(makeProjector(surf, { zFloor: 1e-20 }).zScale, free.zScale, 'a floor below the range changes nothing');
});
