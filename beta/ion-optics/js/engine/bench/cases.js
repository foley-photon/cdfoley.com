/* ==========================================================================
   Ion optics engine: bench/cases.js
   The validation suite (specification §5 and the round-2 plan §2): 55 gates,
   7 informational cases and 2 planned ones, one registry for Node and the
   in-browser Benchmarks panel. Every case builds its own project (never a preset, so a preset
   edit cannot move a gate) and runs it through the real pipeline:
   resolve → geometry → raster → solve → field → model → trace → analysis.

   Methods per case are documented in BENCHMARKS[i].description; reference
   values and their open-literature sources are in targets.js. Numerical
   helpers: Kåsa circle fit (Kåsa, IEEE Trans. Instrum. Meas. IM-25, 8
   (1976)); focus angles from the sign change of the radial separation of a
   ±α ray pair (e.g. Hughes & Rojansky, Phys. Rev. 34, 284 (1929)); secular
   frequency from the stroboscopic recurrence x_{k+1} + x_{k−1} =
   2cos(πβ)x_k (Floquet theory, NIST DLMF §28.2); observed order of accuracy
   p = log₂(e_h/e_{h/2}).
   ========================================================================== */
import * as pipeline from '../pipeline.js';
import { ENGINE_VERSION, PROJECT_FORMAT } from '../version.js';
import {
    P_STRIDE, S_STRIDE, S_ID, S_STATUS, S_X, S_Y, S_Z, S_VX, S_VY, S_VZ, S_KE, S_TOF, S_STEPS, S_PATH, S_DE_END, S_WORK, S_SRC, S_SPECIES, S_KE0,
    C_STRIDE, C_ID, C_PLANE, C_T, C_X, C_Y, C_Z, C_VX, C_VY, C_VZ, C_DIR, C_KIND, STATUS, STATUS_NAMES,
} from '../layout.js';
import { K_ACC, ME_U, ME_EV, C_MMUS, MU0, E_CHARGE, EPS0, cyclotron, speedFromKE } from '../constants.js';
import * as exact from '../exact.js';
import { lensProperties, particleRow } from '../lensprops.js';
import { planeRows, waist } from '../analysis.js';
import * as FA from '../fieldanalysis.js';
import { compileGeometry } from '../geometry.js';
import { buildHierarchy, customBoundarySetup, basisSetup, newRhs, CHARGE_BASIS } from '../operator.js';
import { solveBasis, solveVoltages, multigridSolve, carreSOR } from '../solve.js';
import { createFieldGrid } from '../field.js';
import { createFieldModel } from '../fieldmodel.js';
import { loopField } from '../magnet.js';
import { mergeResults } from '../trace.js';
import { coulombEnergy } from '../coulomb.js';
import { createGasModel, meanRelativeSpeed } from '../gas.js';
import { uniform01 } from '../rng.js';
import { TARGETS, SHORT_REFS } from './targets.js';

const DEG = Math.PI / 180;
const now = () => performance.now();
const META_TIME = '2026-10-12T00:00:00Z';
const COLORS = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#dc2626', '#0891b2', '#ca8a04', '#db2777'];

// ====================================================================== project builders
const ED = (electrode) => ({ bc: 'dirichlet', electrode });
const NEU = { bc: 'neumann' };
const AXIS = { bc: 'axis' };
const profile = (segments) => ({ bc: 'profile', segments });
const seg = (from, to, electrode) => ({ from, to, electrode });
const ramp = (from, to, a, b) => ({ from, to, ramp: [a, b] });
const sp = (label, mass, charge = 1) => ({ label, mass, charge, fraction: 1 });
const pt = (x, y, z = 0) => ({ type: 'point', p: [x, y, z] });
const dir = (x, y, z = 0) => ({ type: 'fixed', dir: [x, y, z] });
const mono = (ke) => ({ type: 'mono', ke });
const fan = (axis, from, to, n, normal = [0, 0, 1]) => ({ type: 'fan', axis, normal, from, to, n });

/** Electrode with an optional waveform: el(id, v, { kind, transmission, terms }). */
function el(id, v = 0, { kind = 'solid', transmission = 1, terms = null, name = null } = {}) {
    const e = { id, name: name || id, kind, v, wave: terms ? { terms } : null, color: '#64748b' };
    if (kind === 'grid') e.transmission = transmission;
    return e;
}

function source(id, { species, position, direction, energy, time = { type: 'fixed', t: 0 }, sampling = 'grid', count = 1, seed = 1, name = null }) {
    return { id, name: name || id, enabled: true, color: 'auto', count, sampling, seed, species, position, direction, energy, time };
}

function plane(id, kind, at, { terminate = false, side = 'both', record = 'first', limits = null, radius = null, p0 = null, p1 = null, name = null } = {}) {
    const p = { id, name: name || id, kind, limits, radius, terminate, side, record };
    if (kind === 'segment') { p.p0 = p0; p.p1 = p1; } else p.at = at;
    return p;
}

/** Tracer settings ('custom' quality): DP45 at rtol 1e-10 unless stated (§5.2). */
function tracer({ rtol = 1e-10, integrator = 'rk45', relativistic = false, tMax = 1000, maxSteps = 500000, maxStepCells = 0.5, nearStepCells = 0.1,
    rfStepsPerPeriod = 32, borisStepsPerGyration = 128, interp = 'cubic', maxDrift = 10000 } = {}) {
    return { integrator, quality: 'custom', custom: { rtol, maxStepCells, nearStepCells: Math.min(nearStepCells, maxStepCells), rfStepsPerPeriod, borisStepsPerGyration },
        fieldInterp: interp, relativistic, tMax, maxSteps, maxDrift, drag: null };
}

/**
 * A complete version-1 project (schema §2.2) for a benchmark setup.
 * o: { cell, x, y, edges, mirror, beyond, electrodes, shapes, magnets, ideal, sources, planes, markers, store, maxPoints, tracer, boundary, notes }
 */
function proj(name, type, o) {
    const cyl = type === 'cyl2d';
    const edges = {
        xmin: ED('gnd'), xmax: ED('gnd'), ymin: cyl ? AXIS : ED('gnd'), ymax: ED('gnd'), ...(o.edges || {}),
    };
    const W = o.x[1] - o.x[0], H = o.y[1] - o.y[0];
    const scale = Math.max(0.05, Math.min(900 / W, 420 / (cyl ? 2 * H : H)));
    return {
        format: PROJECT_FORMAT, version: 1,
        meta: { name, notes: o.notes || '', created: META_TIME, modified: META_TIME, engine: ENGINE_VERSION },
        params: o.params || [],
        domain: { type, cell: o.cell, x: o.x.slice(), y: o.y.slice(), edges,
            mirror: { x: !!(o.mirror && o.mirror.x), y: !!(o.mirror && o.mirror.y) },
            antimirror: { x: !!(o.antimirror && o.antimirror.x), y: !!(o.antimirror && o.antimirror.y) },
            charge: o.charge || '',
            beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop', ...(o.beyond || {}) } },
        electrodes: [{ id: 'gnd', name: 'Ground', ground: true, color: '#64748b' }, ...(o.electrodes || []).map((e, i) => ({ ...e, color: COLORS[i % COLORS.length] }))],
        shapes: (o.shapes || []).map((s, i) => ({ id: 's' + (i + 1), enabled: true, locked: false, ...s })),
        magnets: o.magnets || [], idealFields: o.ideal || [],
        sources: o.sources || [],
        recording: { planes: o.planes || [], trajectories: { store: o.store !== false, maxPoints: o.maxPoints || 2000 }, timeMarkers: o.markers ? { dt: o.markers } : null },
        tracer: o.tracer || tracer(),
        solver: { boundary: o.boundary || 'subgrid', method: 'auto', tol: 1e-12, maxCycles: 60, maxIterations: 200, maxSweeps: 100000 },
        analysis: { lens: o.lens || null, scan: null, optimize: null, waist: null },
        view: { center: [0.5 * (o.x[0] + o.x[1]), cyl ? 0 : 0.5 * (o.y[0] + o.y[1])], scale: +scale.toPrecision(3), displayTime: 0, projection: 'xy', colormap: 'auto', contourLevels: null,
            layers: { potential: true, contours: 20, field: false, electrodes: true, trajectories: 'source', planes: true, hits: true, grid: 'auto', mirror: true, markers: false } },
    };
}

const clone = (v) => JSON.parse(JSON.stringify(v));
function variant(p, fn) { const q = clone(p); fn(q); return q; }
function setV(p, id, v) { const e = p.electrodes.find((x) => x.id === id); e.v = v; return p; }

// ====================================================================== pipeline helpers
function resolveP(p) { return pipeline.resolveOrThrow(p); }
function solveP(resolved, opts = {}) { return pipeline.solveProject(resolved, opts); }
function fieldP(resolved, solved) { return pipeline.buildField(resolved, solved); }
function traceP(resolved, field, range = {}) { return pipeline.traceProject(resolved, field, range); }
/** resolve → solve → field → trace. */
function runAll(p, { overrides = {}, particles = null } = {}) {
    const resolved = resolveP(p);
    const solved = solveP(resolved);
    const field = fieldP(resolved, solved);
    const result = traceP(resolved, field, particles ? { particles, overrides } : { overrides });
    return { resolved, solved, field, result };
}
/** Solves once and builds the fields of several voltage variants of one geometry. */
function solveVariants(base, variants) {
    const r0 = resolveP(base);
    const solved = solveP(r0);
    return variants.map((v) => { const r = resolveP(v); return { resolved: r, solved, field: fieldP(r, solved) }; });
}

// small LRU of solved fields shared by related cases (S1 → T7, S2 → T8, L3 → L4) in one process
const MEMO = new Map();
function memo(key, make) {
    if (MEMO.has(key)) { const v = MEMO.get(key); MEMO.delete(key); MEMO.set(key, v); return v; }
    const v = make();
    MEMO.set(key, v);
    while (MEMO.size > 3) MEMO.delete(MEMO.keys().next().value);
    return v;
}
async function memoAsync(key, make) {
    if (MEMO.has(key)) return MEMO.get(key);
    const v = await make();
    MEMO.set(key, v);
    while (MEMO.size > 3) MEMO.delete(MEMO.keys().next().value);
    return v;
}

function solveInfo(solved) {
    const st = solved && solved.stats ? solved.stats : [];
    return st.map((s) => ({ electrode: s.k, path: (s.path || []).join(' → '), cycles: s.cycles, iterations: s.iterations, sweeps: s.sweeps, estErr: s.estErr, ms: Math.round(s.ms || 0), converged: s.converged }));
}
function gridInfo(resolved, solved) {
    const d = resolved.domain;
    return { nodes: d.N, nx: d.nx, ny: d.ny, cell: d.h, solves: solveInfo(solved) };
}

// ---------------------------------------------------------------- result access
function rowOfId(result, id) {
    const S = result.summary;
    for (let i = 0; i < result.n; i++) if (S[i * S_STRIDE + S_ID] === id) return i * S_STRIDE;
    return -1;
}
function rowsWhere(result, pred) {
    const out = [];
    for (let i = 0; i < result.n; i++) if (pred(result.summary, i * S_STRIDE)) out.push(i * S_STRIDE);
    return out;
}
function statusCount(result, status) { return rowsWhere(result, (S, o) => S[o + S_STATUS] === status).length; }
/** Crossing rows of a plane: [{ id, t, x, y, z, vx, vy, vz }]. */
function crossings(result, planeIdx) {
    const C = result.crossings, out = [];
    for (let c = 0; c < result.nCross; c++) {
        const b = c * C_STRIDE;
        if (C[b + C_KIND] !== 0 || C[b + C_PLANE] !== planeIdx) continue;
        out.push({ id: C[b + C_ID], t: C[b + C_T], x: C[b + C_X], y: C[b + C_Y], z: C[b + C_Z], vx: C[b + C_VX], vy: C[b + C_VY] });
    }
    return out;
}
/** Trajectory points of particle index i as { x, y, z, t } arrays (Float32 storage). */
function trajectory(result, i) {
    const tr = result.traj;
    if (!tr) return null;
    const a = tr.offsets[i], b = tr.offsets[i + 1], P = tr.pts;
    const x = [], y = [], z = [], t = [];
    for (let k = a; k < b; k++) { x.push(P[4 * k]); y.push(P[4 * k + 1]); z.push(P[4 * k + 2]); t.push(P[4 * k + 3]); }
    return { x, y, z, t };
}
/** Markers of particle id: { t, x, y, z } arrays. */
function markersOf(result, id) {
    const M = result.markers, out = { t: [], x: [], y: [], z: [] };
    if (!M) return out;
    for (let k = 0; k + 4 < M.length; k += 5) if (M[k] === id) { out.t.push(M[k + 1]); out.x.push(M[k + 2]); out.y.push(M[k + 3]); out.z.push(M[k + 4]); }
    return out;
}

// ---------------------------------------------------------------- checks
function digitsTol(s) {
    // half a unit in the last printed digit; exponent notation ('9.61306401e-20') counts the mantissa's decimals
    const [mant, exp = '0'] = String(s).replace(/^[-+]/, '').toLowerCase().split('e');
    const i = mant.indexOf('.');
    return 0.5 * Math.pow(10, Number(exp) - (i < 0 ? 0 : mant.length - i - 1));
}
/**
 * One check row: { label, target, value, unit, tol, tolKind, deviation, pass }.
 * digits: target is the printed reference string (tol = half a unit in its last digit); abs: |value − target| ≤ tol;
 * rel: |value/target − 1| ≤ tol; bracket: tol = [lo, hi] on value (or equality of strings).
 */
function check(label, value, target, tolKind, tol = null, unit = '', extra = null) {
    let deviation = NaN, pass = false;
    if (tolKind === 'bracket' && typeof value === 'string') {
        pass = value === target; deviation = pass ? 0 : 1;
    } else {
        const tv = typeof target === 'string' ? Number(target) : target;
        if (tolKind === 'digits') { tol = digitsTol(target); deviation = value - tv; pass = Math.abs(deviation) <= tol * (1 + 1e-9); }
        else if (tolKind === 'abs') { deviation = value - tv; pass = Math.abs(deviation) <= tol; }
        else if (tolKind === 'rel') { deviation = value / tv - 1; pass = Math.abs(deviation) <= tol; }
        else if (tolKind === 'bracket') { deviation = Number.isFinite(tv) ? value - tv : NaN; pass = value >= tol[0] && value <= tol[1]; }
        if (typeof value !== 'number' || !Number.isFinite(value)) pass = false;
    }
    return { label, target, value, unit, tol, tolKind, deviation, pass, ...(extra || {}) };
}

/**
 * Comparison with the unrounded exact value (beside a digits check against the printed one, whose rounding uses up most of
 * its half-digit tolerance): relative tolerance EXACT_TOL[id] (≥ 2× the calibrated deviation), so the gate still catches
 * regressions far smaller than the printed precision.
 */
// calibrated deviations (quick = full): K1 1.1e-15, K2 0, K3 4.0e-9, K7 1.9e-11, K9 7.6e-10, T1 5.0e-8, T13 2.2e-16
const EXACT_TOL = { K1: 1e-12, K2: 1e-12, K3: 2e-8, K7: 1e-10, K9: 3e-9, T1: 2e-7, T13: 1e-12 };
function exactCheck(id, label, value, exactValue, unit) { return check(`${label} vs the unrounded exact value`, value, exactValue, 'rel', EXACT_TOL[id], unit); }

// ---------------------------------------------------------------- numerical helpers
function solve3(A, b) {
    const M = A.map((r, i) => [...r, b[i]]);
    for (let i = 0; i < 3; i++) {
        let p = i;
        for (let k = i + 1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
        [M[i], M[p]] = [M[p], M[i]];
        for (let k = i + 1; k < 3; k++) { const f = M[k][i] / M[i][i]; for (let q = i; q < 4; q++) M[k][q] -= f * M[i][q]; }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) { let s = M[i][3]; for (let q = i + 1; q < 3; q++) s -= M[i][q] * x[q]; x[i] = s / M[i][i]; }
    return x;
}
/** Kåsa algebraic circle fit: { cx, cy, r }. */
function kasa(xs, ys) {
    const n = xs.length;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    let suu = 0, svv = 0, suv = 0, su = 0, sv = 0, suz = 0, svz = 0, sz = 0;
    for (let i = 0; i < n; i++) {
        const u = xs[i] - mx, v = ys[i] - my, z = u * u + v * v;
        suu += u * u; svv += v * v; suv += u * v; su += u; sv += v; suz += u * z; svz += v * z; sz += z;
    }
    const [D, E, F] = solve3([[suu, suv, su], [suv, svv, sv], [su, sv, n]], [-suz, -svz, -sz]);
    const cu = -D / 2, cv = -E / 2;
    return { cx: cu + mx, cy: cv + my, r: Math.sqrt(cu * cu + cv * cv - F) };
}
/** Value at x of the cubic (or lower) Lagrange polynomial through the ≤ 4 samples nearest to x. */
function lagrange(xs, ys, x) {
    const n = xs.length;
    if (n === 0) return NaN;
    let i0 = 0;
    while (i0 < n - 1 && xs[i0 + 1] < x) i0++;
    let a = Math.max(0, i0 - 1), b = Math.min(n - 1, a + 3);
    a = Math.max(0, b - 3);
    let s = 0;
    for (let i = a; i <= b; i++) {
        let w = 1;
        for (let j = a; j <= b; j++) if (j !== i) w *= (x - xs[j]) / (xs[i] - xs[j]);
        s += w * ys[i];
    }
    return s;
}
/** Root of fa(θ) − fb(θ) for two sampled curves (sorted θ), by bisection on cubic interpolants within [lo, hi]. */
function crossingAngle(sa, sb, lo, hi) {
    const f = (t) => lagrange(sa.t, sa.r, t) - lagrange(sb.t, sb.r, t);
    // scan for a sign change on a fine grid, then bisect
    const n = 200;
    let tPrev = lo, fPrev = f(lo);
    for (let k = 1; k <= n; k++) {
        const t = lo + (hi - lo) * k / n, ft = f(t);
        if (fPrev === 0) return tPrev;
        if ((ft > 0) !== (fPrev > 0)) {
            let a = tPrev, b = t, fa = fPrev;
            for (let it = 0; it < 80; it++) {
                const m = 0.5 * (a + b), fm = f(m);
                if ((fm > 0) === (fa > 0)) { a = m; fa = fm; } else b = m;
            }
            return 0.5 * (a + b);
        }
        tPrev = t; fPrev = ft;
    }
    return NaN;
}
/** Deterministic uniform random numbers (mulberry32) for case set-ups. */
function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const maxAbsDiff = (a, b) => { let m = 0; for (let k = 0; k < a.length; k++) { const d = Math.abs(a[k] - b[k]); if (d > m) m = d; } return m; };

// ====================================================================== the cases
const T = (id) => TARGETS[id] || { values: {}, units: {} };
const CASES = {};

// ---------------------------------------------------------------- K: kinematics and magnetics
function k1Project() {
    return proj('K1 Uniform-field transit', 'planar2d', {
        cell: 0.5, x: [0, 10], y: [-2, 2],
        edges: { xmin: ED('plate'), xmax: ED('gnd'), ymin: NEU, ymax: NEU },
        electrodes: [el('plate', 1000, { name: 'Plate 1000 V' })],
        sources: [source('b1', { name: 'm/z 100 at rest and at 10 eV', species: [sp('m/z 100', 100)], position: pt(0, 0), direction: dir(1, 0), energy: { type: 'list', values: [0, 10] }, count: 2 })],
        planes: [plane('det', 'x', 10, { terminate: true, side: 'forward', name: 'Detector' })],
        tracer: tracer(),
    });
}
CASES.K1 = {
    project: () => k1Project(),
    run() {
        const { resolved, solved, result } = runAll(k1Project());
        const v = T('K1').values;
        const o0 = rowsWhere(result, (S, o) => S[o + S_KE0] === 0)[0], o10 = rowsWhere(result, (S, o) => S[o + S_KE0] === 10)[0];
        const S = result.summary;
        return {
            checks: [
                check('Transit time from rest', S[o0 + S_TOF], v.tRest, 'digits', null, 'µs'),
                check('Final speed from rest', Math.hypot(S[o0 + S_VX], S[o0 + S_VY], S[o0 + S_VZ]), v.vRest, 'digits', null, 'mm/µs'),
                check('Transit time, 10 eV start', S[o10 + S_TOF], v.t10, 'digits', null, 'µs'),
                exactCheck('K1', 'Transit time from rest', S[o0 + S_TOF], exact.uniformTransit({ gapMm: 10, dV: 1000, massU: 100 }).tUs, 'µs'),
                exactCheck('K1', 'Final speed from rest', Math.hypot(S[o0 + S_VX], S[o0 + S_VY], S[o0 + S_VZ]), exact.uniformTransit({ gapMm: 10, dV: 1000, massU: 100 }).vMMus, 'mm/µs'),
                exactCheck('K1', 'Transit time, 10 eV start', S[o10 + S_TOF], exact.uniformTransit({ gapMm: 10, dV: 1000, massU: 100, ke0EV: 10 }).tUs, 'µs'),
            ],
            details: { ...gridInfo(resolved, solved), steps: [S[o0 + S_STEPS], S[o10 + S_STEPS]] },
        };
    },
};

function k2Project() {
    const masses = [['1.00782503207 u', 1.00782503207], ['28 u', 28], ['100 u', 100], ['1000 u', 1000]];
    return proj('K2 1 m drift at 1000 eV', 'planar2d', {
        cell: 0.5, x: [0, 10], y: [-5, 5], beyond: { xmax: 'drift' },
        sources: [source('b1', { name: 'Four masses', species: masses.map(([l, m]) => sp(l, m)), position: pt(0, 0), direction: dir(1, 0), energy: mono(1000), count: 4 })],
        planes: [plane('det', 'x', 1000, { terminate: true, side: 'forward', name: 'Detector at 1 m' })],
        tracer: tracer(),
    });
}
CASES.K2 = {
    project: () => k2Project(),
    run() {
        const { resolved, solved, result } = runAll(k2Project());
        const v = T('K2').values, keys = ['m1', 'm28', 'm100', 'm1000'], labels = ['1.00782503207 u', '28 u', '100 u', '1000 u'];
        const S = result.summary;
        const checks = keys.map((k, sIdx) => {
            const o = rowsWhere(result, (SS, oo) => SS[oo + S_SPECIES] === sIdx)[0];
            return check(`Drift time, ${labels[sIdx]}`, o === undefined ? NaN : S[o + S_TOF], v[k], 'digits', null, 'µs');
        });
        [1.00782503207, 28, 100, 1000].forEach((m, sIdx) => {
            const o = rowsWhere(result, (SS, oo) => SS[oo + S_SPECIES] === sIdx)[0];
            checks.push(exactCheck('K2', `Drift time, ${labels[sIdx]}`, o === undefined ? NaN : S[o + S_TOF], exact.driftTime(1000, 1000, m), 'µs'));
        });
        return { checks, details: { ...gridInfo(resolved, solved), status: keys.map((_, i) => STATUS_NAMES[S[i * S_STRIDE + S_STATUS]]) } };
    },
};

/** Gyration set-up: start at the origin along +x in a uniform B along z. */
function gyroProject(name, { mass, charge, ke, B, relativistic, integrator = 'rk45', rtol = 1e-11, periods = 2.2, markers = 256, cell = null, steps = 128, everyStep = false }) {
    const cy = cyclotron(mass, charge, B, ke, relativistic);
    const r = cy.radiusMM, Tp = 1 / cy.freqMHz;
    const side = charge * B > 0 ? -1 : 1;   // centre at (0, side·r)
    const h = cell || Math.max(0.5, Math.round(r / 50));
    const span = Math.ceil((r * 1.1) / h) * h;
    const y0 = side < 0 ? -2 * span - 2 * h : -2 * h, y1 = side < 0 ? 2 * h : 2 * span + 2 * h;
    return {
        project: proj(name, 'planar2d', {
            cell: h, x: [-span, span], y: [y0, y1],
            magnets: [{ id: 'm1', name: 'Uniform B', enabled: true, type: 'uniform', B: [0, 0, B] }],
            sources: [source('b1', { species: [sp(charge < 0 ? 'electron' : `m ${mass}`, mass, charge)], position: pt(0, 0), direction: dir(1, 0), energy: mono(ke) })],
            planes: [plane('rev', 'x', 0, { side: 'forward', record: 'all', name: 'Revolution counter' })],
            markers: Tp / markers, maxPoints: everyStep ? 100000 : 2000,
            tracer: tracer({ rtol, integrator, relativistic, tMax: periods * Tp, maxStepCells: integrator === 'boris' ? 1 : 0.5, borisStepsPerGyration: steps }),
        }),
        r, Tp, side,
    };
}
function gyroFit(setup, { everyStep = false } = {}) {
    const overrides = everyStep ? { record: { everyStep: true, maxPoints: 1e6 } } : {};
    const { resolved, result } = runAll(setup.project, { overrides });
    const id = result.summary[S_ID];
    let pts;
    if (everyStep) { const tr = trajectory(result, 0); pts = { x: tr.x, y: tr.y }; } else pts = markersOf(result, id);
    const fit = kasa(pts.x, pts.y);
    const cr = crossings(result, 0).map((c) => c.t);
    const period = cr.length >= 2 ? cr[cr.length - 1] - cr[cr.length - 2] : (cr.length ? cr[0] : NaN);
    return { fit, period, n: pts.x.length, resolved, result, steps: result.summary[S_STEPS] };
}
CASES.K3 = {
    project: () => gyroProject('K3 Gyration (a): 100 u, 1 keV, 0.5 T', { mass: 100, charge: 1, ke: 1000, B: 0.5, relativistic: false }).project,
    run(level, ctx) {
        const v = T('K3').values;
        const a = gyroFit(gyroProject('K3a', { mass: 100, charge: 1, ke: 1000, B: 0.5, relativistic: false }));
        progress(ctx, 0.25, 'K3 (a)');
        const b = gyroFit(gyroProject('K3b', { mass: ME_U, charge: -1, ke: 100, B: 1e-3, relativistic: false }));
        const c = gyroFit(gyroProject('K3c', { mass: ME_U, charge: -1, ke: 100, B: 1e-3, relativistic: true }));
        progress(ctx, 0.6, 'K3 (b), (c)');
        const bs = gyroProject('K3 Boris', { mass: 100, charge: 1, ke: 1000, B: 0.5, relativistic: false, integrator: 'boris', cell: 5, steps: 128 });
        const bo = gyroFit(bs, { everyStep: true });
        const theta = 2 * Math.PI / 128;
        const rDiscrete = bs.r * (theta / 2) / Math.sin(theta / 2);
        return {
            checks: [
                check('(a) radius, 100 u, 1 keV, 0.5 T', a.fit.r, v.rA, 'digits', null, 'mm'),
                check('(a) cyclotron frequency', 1000 / a.period, v.fA, 'digits', null, 'kHz'),
                check('(b) radius, electron 100 eV, 1 mT (nonrelativistic)', b.fit.r, v.rB, 'digits', null, 'mm'),
                check('(b) cyclotron frequency', 1 / b.period, v.fB, 'digits', null, 'MHz'),
                check('(c) radius, relativistic', c.fit.r, v.rC, 'digits', null, 'mm'),
                check('(c) cyclotron frequency, relativistic', 1 / c.period, v.fC, 'digits', null, 'MHz'),
                exactCheck('K3', '(a) radius', a.fit.r, cyclotron(100, 1, 0.5, 1000, false).radiusMM, 'mm'),
                exactCheck('K3', '(a) cyclotron frequency', 1000 / a.period, 1000 * cyclotron(100, 1, 0.5, 1000, false).freqMHz, 'kHz'),
                exactCheck('K3', '(b) radius', b.fit.r, cyclotron(ME_U, -1, 1e-3, 100, false).radiusMM, 'mm'),
                exactCheck('K3', '(b) cyclotron frequency', 1 / b.period, cyclotron(ME_U, -1, 1e-3, 100, false).freqMHz, 'MHz'),
                exactCheck('K3', '(c) radius', c.fit.r, cyclotron(ME_U, -1, 1e-3, 100, true).radiusMM, 'mm'),
                exactCheck('K3', '(c) cyclotron frequency', 1 / c.period, cyclotron(ME_U, -1, 1e-3, 100, true).freqMHz, 'MHz'),
                check('Boris, 128 steps per gyration: radius', bo.fit.r, bs.r, 'rel', 2.5e-4, 'mm'),
                check('Boris: step positions on the discrete circle r·(θ/2)/sin(θ/2)', bo.fit.r, rDiscrete, 'rel', 1e-6, 'mm'),
            ],
            details: { markers: [a.n, b.n, c.n], steps: [a.steps, b.steps, c.steps, bo.steps], borisPoints: bo.n },
        };
    },
};

CASES.K4 = {
    project: () => gyroProject('K4 Gyration sense: ion in B = +z', { mass: 100, charge: 1, ke: 1000, B: 0.5, relativistic: false, periods: 0.75, markers: 64 }).project,
    run() {
        const checks = [];
        const runs = [];
        for (const integrator of ['rk45', 'boris']) {
            for (const [label, mass, charge, ke, B, want] of [['ion', 100, 1, 1000, 0.5, -1], ['electron', ME_U, -1, 100, 1e-3, 1]]) {
                const s = gyroProject(`K4 ${label}`, { mass, charge, ke, B, relativistic: false, integrator, periods: 0.75, markers: 64, cell: integrator === 'boris' ? null : null });
                const g = gyroFit(s);
                const val = g.fit.cy / s.r;
                runs.push({ integrator, label, cx: g.fit.cx, cy: g.fit.cy, r: s.r });
                checks.push(check(`${integrator === 'rk45' ? 'Dormand–Prince' : 'Boris'}, ${label}: center y / r`, val, want, 'bracket', want < 0 ? [-1.001, -0.999] : [0.999, 1.001], ''));
            }
        }
        return { checks, details: { runs } };
    },
};

/** Fan of segment planes from a centre at travelled angles φ_k (planar). ψ(φ) gives the polar angle about the centre. */
function anglePlanes(prefix, centre, phis, psiOf, rIn, rOut) {
    return phis.map((phi, k) => {
        const p = psiOf(phi) * DEG, c = Math.cos(p), s = Math.sin(p);
        return plane(`${prefix}${k}`, 'segment', null, { p0: [centre[0] + rIn * c, centre[1] + rIn * s], p1: [centre[0] + rOut * c, centre[1] + rOut * s], side: 'both', name: `${phi}°` });
    });
}
/** Radial distances from `centre` of the crossings of planes [first, first + n) by particle id, as { t: φ, r }. */
function radialSamples(result, id, centre, phis, first = 0) {
    const t = [], r = [];
    for (let k = 0; k < phis.length; k++) {
        const c = crossings(result, first + k).find((q) => q.id === id);
        if (c) { t.push(phis[k]); r.push(Math.hypot(c.x - centre[0], c.y - centre[1])); }
    }
    return { t, r };
}

function k5Setup() {
    const cy = cyclotron(100, 1, 0.5, 1000, false), r0 = cy.radiusMM, Tp = 1 / cy.freqMHz;
    const C0 = [0, -r0];
    const phis = []; for (let p = 170; p <= 190.001; p += 2.5) phis.push(+p.toFixed(1));
    const mrad = 1e-3 / DEG;
    const p = proj('K5 180° homogeneous-field focus', 'planar2d', {
        cell: 2, x: [-100, 100], y: [-190, 10],
        magnets: [{ id: 'm1', name: 'Uniform B', enabled: true, type: 'uniform', B: [0, 0, 0.5] }],
        sources: [source('b1', { name: '0 and ±1 mrad', species: [sp('m 100', 100)], position: pt(0, 0), direction: fan([1, 0, 0], -mrad, mrad, 3), energy: mono(1000), count: 3 })],
        planes: anglePlanes('a', C0, phis, (phi) => 90 - phi, 0.9 * r0, 1.1 * r0),
        tracer: tracer({ rtol: 1e-11, tMax: 0.6 * Tp }),
    });
    return { project: p, C0, phis, r0 };
}
CASES.K5 = {
    project: () => k5Setup().project,
    run() {
        const s = k5Setup();
        const { result } = runAll(s.project);
        const a = radialSamples(result, 0, s.C0, s.phis), b = radialSamples(result, 2, s.C0, s.phis);
        const ang = crossingAngle(a, b, 170, 190);
        return { checks: [check('Focus angle of the ±1 mrad rays', ang, 180, 'abs', 0.005, '°')], details: { samples: a.t.length, steps: result.summary[S_STEPS] } };
    },
};

function k6Setup(phiDeg) {
    const r = 100, l = r / Math.tan(phiDeg / 2 * DEG);
    const mrad = 0.5e-3 / DEG;
    const ph = phiDeg * DEG, Pe = [r * Math.cos(ph), r * Math.sin(ph)], t = [-Math.sin(ph), Math.cos(ph)], n = [Math.cos(ph), Math.sin(ph)];
    const c = [Pe[0] + 0.5 * l * t[0], Pe[1] + 0.5 * l * t[1]];
    const p = proj(`K6 Sector imaging, φ = ${phiDeg}°`, 'planar2d', {
        cell: 2, x: [-200, 200], y: [-200, 200],
        magnets: [{ id: 'm1', name: 'Sector', enabled: true, type: 'region', B: [0, 0, -0.455286], region: { type: 'annulus', cx: 0, cy: 0, rIn: 50, rOut: 150, a0: 0, a1: phiDeg } }],
        sources: [source('b1', { name: '0 and ±0.5 mrad', species: [sp('m 100', 100)], position: pt(r, -l), direction: fan([0, 1, 0], -mrad, mrad, 3), energy: mono(1000), count: 3 })],
        planes: [plane('after', 'segment', null, { p0: [c[0] - 15 * n[0], c[1] - 15 * n[1]], p1: [c[0] + 15 * n[0], c[1] + 15 * n[1]], terminate: true, name: 'After the exit edge' })],
        tracer: tracer(),
    });
    return { project: p, Pe, t, l };
}
CASES.K6 = {
    project: () => k6Setup(90).project,
    run(level, ctx) {
        const v = T('K6').values, checks = [], details = {};
        for (const [phi, key] of [[90, 'l90'], [60, 'l60']]) {
            const s = k6Setup(phi);
            const { result } = runAll(s.project, { overrides: { debugRegions: true } });
            const cr = crossings(result, 0);
            const A = cr.find((q) => q.id === 0), B = cr.find((q) => q.id === 2);
            let lp = NaN;
            if (A && B) {
                const det = A.vx * (-B.vy) - A.vy * (-B.vx);
                const s1 = ((B.x - A.x) * (-B.vy) - (B.y - A.y) * (-B.vx)) / det;
                const X = [A.x + s1 * A.vx, A.y + s1 * A.vy];
                lp = (X[0] - s.Pe[0]) * s.t[0] + (X[1] - s.Pe[1]) * s.t[1];
            }
            checks.push(check(`Image distance l′, φ = ${phi}°`, lp, Number(v[key]), 'rel', 2e-4, 'mm'));
            checks.push(check(`Accepted steps across a magnet edge, φ = ${phi}°`, result.stats.regionViolations || 0, 0, 'abs', 0, ''));
            details[`phi${phi}`] = { edgeSplits: result.stats.edgeSplits, steps: result.stats.steps };
            progress(ctx, 0.5, `K6 φ = ${phi}°`);
        }
        return { checks, details };
    },
};

function capacitorProject(name, terms, { masses, tMax, rtol }) {
    return proj(name, 'planar2d', {
        cell: 1, x: [-10, 200], y: [-5, 5],
        edges: { xmin: ED('drive'), xmax: ED('gnd'), ymin: NEU, ymax: NEU },
        electrodes: [el('drive', 0, { terms, name: 'Driven plate' })],
        sources: [source('b1', { name: 'At rest at x = 0', species: masses.map((m) => sp(`${m} u`, m)), position: pt(0, 0), direction: dir(1, 0), energy: mono(0), count: masses.length })],
        tracer: tracer({ rtol, tMax }),
    });
}
const k7Project = () => capacitorProject('K7 RF uniform field', [{ type: 'cos', amp: 21000, freq: 1, phase: -90 }], { masses: [10, 100, 1000], tMax: 0.5, rtol: 1e-10 });
CASES.K7 = {
    project: k7Project,
    run() {
        const { resolved, solved, result } = runAll(k7Project());
        const v = T('K7').values, keys = ['m10', 'm100', 'm1000'], S = result.summary;
        const checks = keys.map((k, i) => {
            const o = rowsWhere(result, (SS, oo) => SS[oo + S_SPECIES] === i)[0];
            return check(`Position at 0.5 µs, ${[10, 100, 1000][i]} u`, S[o + S_X], v[k], 'digits', null, 'mm');
        });
        [10, 100, 1000].forEach((m, i) => {
            const o = rowsWhere(result, (SS, oo) => SS[oo + S_SPECIES] === i)[0];
            checks.push(exactCheck('K7', `Position at 0.5 µs, ${m} u`, S[o + S_X], exact.rfUniformDisplacement({ e0VMm: 100, freqMHz: 1, massU: m, tUs: 0.5 }), 'mm'));
        });
        return { checks, details: { ...gridInfo(resolved, solved), status: [0, 1, 2].map((i) => STATUS_NAMES[S[i * S_STRIDE + S_STATUS]]) } };
    },
};
const PULSE = { t0: 0.2, rise: 0.1, width: 10, fall: 0.1 };
const k8Project = () => capacitorProject('K8 Pulse breakpoints', [{ type: 'pulse', amp: 2100, ...PULSE, period: null }], { masses: [100], tMax: 1.0, rtol: 1e-12 });
CASES.K8 = {
    project: k8Project,
    run() {
        const { result } = runAll(k8Project());
        const ref = exact.pulseRampPosition({ e0VMm: 2100 / 210, ...PULSE, massU: 100, tUs: 1.0 });
        return { checks: [check('Position at 1.0 µs', result.summary[S_X], ref, 'rel', 1e-9, 'mm')], details: { reference: ref, steps: result.summary[S_STEPS] } };
    },
};

CASES.K9 = {
    project: () => gyroProject('K9 Relativistic electron, KE = mₑc², 0.1 T', { mass: ME_U, charge: -1, ke: ME_EV, B: 0.1, relativistic: true, periods: 1.2 }).project,
    run() {
        const s = gyroProject('K9', { mass: ME_U, charge: -1, ke: ME_EV, B: 0.1, relativistic: true, periods: 1.2 });
        const g = gyroFit(s);
        const S = g.result.summary, v = T('K9').values;
        const gamma = 1 + S[S_KE] / ME_EV;
        const beta = Math.hypot(S[S_VX], S[S_VY], S[S_VZ]) / C_MMUS;
        return {
            checks: [
                check('Lorentz factor γ', gamma, v.gamma, 'digits', null, ''),
                check('Speed β = v/c', beta, v.beta, 'digits', null, ''),
                check('Radius of gyration', g.fit.r, v.r, 'digits', null, 'mm'),
                exactCheck('K9', 'Lorentz factor γ', gamma, 2, ''),
                exactCheck('K9', 'Speed β = v/c', beta, Math.sqrt(3) / 2, ''),
                exactCheck('K9', 'Radius of gyration', g.fit.r, cyclotron(ME_U, -1, 0.1, ME_EV, true).radiusMM, 'mm'),
            ],
            details: { steps: g.steps, markers: g.n },
        };
    },
};

// ---------------------------------------------------------------- S: field solutions
function s1Project(level) {
    const h = level === 'full' ? 0.1 : 0.2;
    return proj('S1 Coaxial cylinders', 'planar2d', {
        cell: h, x: [0, 22], y: [0, 22], mirror: { x: true, y: true },
        edges: { xmin: NEU, ymin: NEU, xmax: ED('gnd'), ymax: ED('gnd') },
        electrodes: [el('inner', 100, { name: 'Inner cylinder' })],
        shapes: [{ type: 'circle', electrode: 'inner', cx: 0, cy: 0, r: 10 }, { type: 'annulus', electrode: 'gnd', cx: 0, cy: 0, rIn: 20, rOut: 32, a0: 0, a1: 360 }],
    });
}
function s1Field(level) {
    return memo(`S1:${level}`, () => { const resolved = resolveP(s1Project(level)); const solved = solveP(resolved); return { resolved, solved, field: fieldP(resolved, solved) }; });
}
CASES.S1 = {
    project: s1Project,
    run(level) {
        const { resolved, solved, field } = s1Field(level);
        const v = T('S1').values, tolV = level === 'full' ? 1e-3 : 3e-3, tolE = level === 'full' ? 2e-5 : 5e-5;
        const e4 = new Float64Array(4), checks = [];
        for (const r of [12.5, 15, 17.5]) for (const a of [0, 30, 45]) {
            field.model.E(0, r * Math.cos(a * DEG), r * Math.sin(a * DEG), 0, e4);
            checks.push(check(`V(r = ${r} mm, ${a}°)`, e4[3], Number(v[r]), 'abs', tolV, 'V'));
        }
        for (const a of [0, 30, 45]) {
            field.model.E(0, 15 * Math.cos(a * DEG), 15 * Math.sin(a * DEG), 0, e4);
            checks.push(check(`|E(r = 15 mm, ${a}°)|`, Math.hypot(e4[0], e4[1], e4[2]), Number(v.E15), 'rel', tolE, 'V/mm'));
        }
        return { checks, details: gridInfo(resolved, solved) };
    },
};

function s2Project(level) {
    const h = level === 'full' ? 0.5 : 1;
    return proj('S2 Concentric spheres', 'cyl2d', {
        cell: h, x: [0, 125], y: [0, 125], mirror: { x: true },
        edges: { xmin: NEU, xmax: ED('outer'), ymax: ED('outer') },
        electrodes: [el('inner', 500, { name: 'Inner sphere' }), el('outer', '-1000/3', { name: 'Outer sphere' })],
        shapes: [{ type: 'circle', electrode: 'inner', cx: 0, cy: 0, r: 80 }, { type: 'annulus', electrode: 'outer', cx: 0, cy: 0, rIn: 120, rOut: 180, a0: 0, a1: 360 }],
    });
}
function s2Field(level) {
    return memo(`S2:${level}`, () => { const resolved = resolveP(s2Project(level)); const solved = solveP(resolved); return { resolved, solved, field: fieldP(resolved, solved) }; });
}
CASES.S2 = {
    project: s2Project,
    run(level) {
        const { resolved, solved, field } = s2Field(level);
        const tolV = level === 'full' ? 0.01 : 0.04, tolE = level === 'full' ? 1.5e-5 : 5e-5;
        const e4 = new Float64Array(4), checks = [];
        for (const r of [90, 100, 110]) for (const a of [10, 45, 80]) {
            field.model.E(0, r * Math.cos(a * DEG), r * Math.sin(a * DEG), 0, e4);
            const ref = exact.sphereV(r, { R1: 80, R2: 120, V1: 500, V2: -1000 / 3 });
            checks.push(check(`V(r = ${r} mm, polar ${a}°)`, e4[3], Math.abs(ref) < 1e-9 ? 0 : ref, 'abs', tolV, 'V'));
        }
        for (const a of [10, 45, 80]) {
            field.model.E(0, 100 * Math.cos(a * DEG), 100 * Math.sin(a * DEG), 0, e4);
            checks.push(check(`|E(r = 100 mm, polar ${a}°)|`, Math.hypot(e4[0], e4[1], e4[2]), 20, 'rel', tolE, 'V/mm'));
        }
        return { checks, details: gridInfo(resolved, solved) };
    },
};

function s3Project(level) {
    const h = level === 'full' ? 1 / 80 : 1 / 40;
    return proj('S3 Two-tube axial potential, zero gap', 'cyl2d', {
        cell: h, x: [-8, 8], y: [0, 1],
        edges: { xmin: ED('gnd'), xmax: ED('B'), ymax: profile([seg(-8, 0, 'gnd'), seg(0, 8, 'B')]) },
        electrodes: [el('B', 1, { name: 'Tube 2 (1 V)' })],
        notes: 'Tube radius R = 1 mm; the tube wall is the top edge (0 V | 1 V, zero gap).',
    });
}
CASES.S3 = {
    project: s3Project,
    run(level) {
        const { resolved, solved, field } = (() => { const resolved = resolveP(s3Project(level)); const solved = solveP(resolved); return { resolved, solved, field: fieldP(resolved, solved) }; })();
        const v = T('S3').values, tol = level === 'full' ? 4e-5 : 1.5e-4;
        const checks = [], series = { label: 'Axial potential error', xLabel: 'z/D', yLabel: 'error (V/V)', x: [], y: [] };
        for (const zD of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.5, 2.0]) {
            const phi = field.model.potential(0, -2 * zD, 0, 0);
            const key = String(zD === 1 ? '1.0' : zD === 2 ? '2.0' : zD);
            const target = v[key] !== undefined ? v[key] : v[zD];
            checks.push(check(`φ on the axis, z/D = ${zD} into tube 1`, phi, Number(target), 'abs', tol, 'V/V'));
            series.x.push(zD); series.y.push(phi - Number(target));
        }
        return { checks, details: gridInfo(resolved, solved), series: [series] };
    },
};

function s4Project(level) {
    const h = level === 'full' ? 1 / 80 : 1 / 40;
    return proj('S4 Two-tube lens, 0.1D gap (NBS deep gap)', 'cyl2d', {
        cell: h, x: [-7, 7], y: [0, 3.5],
        edges: { xmin: ED('gnd'), xmax: ED('B'), ymax: profile([seg(-7, -0.1, 'gnd'), ramp(-0.1, 0.1, 'gnd', 'B'), seg(0.1, 7, 'B')]) },
        electrodes: [el('B', 1, { name: 'Tube 2 (1 V)' })],
        shapes: [{ type: 'box', electrode: 'gnd', x0: -7, x1: -0.1, y0: 1, y1: 3.5 }, { type: 'box', electrode: 'B', x0: 0.1, x1: 7, y0: 1, y1: 3.5 }],
        notes: 'R = 1 mm, D = 2 mm, gap 0.1D; the deep gap is closed by a linear ramp at r = 3.5 mm.',
    });
}
function s4Solved(level) {
    return memo(`S4:${level}`, () => { const resolved = resolveP(s4Project(level)); return { resolved, solved: solveP(resolved) }; });
}
CASES.S4 = {
    project: s4Project,
    run(level) {
        const { resolved, solved } = s4Solved(level);
        const field = fieldP(resolved, solved);
        const v = T('S4').values;
        const checks = [];
        for (const zD of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0]) {
            const phi = field.model.potential(0, -2 * zD, 0, 0);
            const target = Number(v[zD === 1 ? '1.0' : zD] !== undefined ? v[zD === 1 ? '1.0' : zD] : v[zD]);
            checks.push(check(`φ on the axis, z/D = ${zD} into tube 1`, phi, target, 'abs', 2e-4, 'V/V'));
        }
        return { checks, details: gridInfo(resolved, solved) };
    },
};

function s5Project(R) {
    return proj(`S5 Zero-gap einzel lens, R = ${R} cells`, 'cyl2d', {
        cell: 1 / R, x: [-8, 8], y: [0, 1],
        edges: { xmin: ED('O'), xmax: ED('O'), ymax: profile([seg(-8, -0.5, 'O'), seg(-0.5, 0.5, 'C'), seg(0.5, 8, 'O')]) },
        electrodes: [el('O', 1, { name: 'Outer tubes (1 V)' }), el('C', 9, { name: 'Center tube (9 V)' })],
        notes: 'R = 1 mm, A/D = 0.5, kinetic-potential ratio 9.',
    });
}
function s5Error(R) {
    const resolved = resolveP(s5Project(R));
    const solved = solveP(resolved);
    const field = fieldP(resolved, solved);
    const phi = field.channels[0].phi, nx = resolved.domain.nx, h = resolved.domain.h;
    let e = 0;
    for (let i = 0; i < nx; i++) {
        const z = -8 + i * h;
        if (Math.abs(Math.abs(z) - 0.5) < 0.06) continue;
        e = Math.max(e, Math.abs(phi[i] - exact.einzelAxial(z, 9, 0.5)));
    }
    return e;
}
CASES.S5 = {
    project: () => s5Project(40),
    run(level, ctx) {
        const Rs = level === 'full' ? [20, 40, 80] : [20, 40];
        const errs = Rs.map((R, i) => { const e = s5Error(R); progress(ctx, (i + 1) / Rs.length, `S5 R = ${R}`); return e; });
        const checks = [];
        for (let i = 1; i < Rs.length; i++) checks.push(check(`Observed order, R = ${Rs[i - 1]} → ${Rs[i]}`, Math.log2(errs[i - 1] / errs[i]), 2, 'bracket', [1.8, 2.3], ''));
        return { checks, details: { R: Rs, maxAxialError: errs } };
    },
};

const S6_ELS = [el('a', 0), el('b', 0), el('c', 0)];
function s6Planar() {
    return proj('S6 Harmonic quadratic, planar', 'planar2d', {
        cell: 0.25, x: [-8, 8], y: [-8, 8], electrodes: S6_ELS,
        shapes: [
            { type: 'circle', electrode: 'a', cx: -3.03, cy: 2.11, r: 1.7 },
            { type: 'annulus', electrode: 'b', cx: 3.07, cy: -2.02, rIn: 1.13, rOut: 2.31, a0: 30, a1: 250 },
            { type: 'polygon', electrode: 'c', points: [[1.01, 3.03], [5.12, 4.07], [4.01, 7.11], [1.53, 6.04]] },
            { type: 'polyline', electrode: 'a', points: [[-6.1, -6.3], [-2.2, -4.15]] },
        ],
        notes: 'Boundary values are set from 1 + 0.3x − 0.2y + 0.05(x² − y²) + 0.02xy by the benchmark (not by electrode voltages).',
    });
}
function s6Cyl() {
    return proj('S6 Harmonic quadratic, cylindrical', 'cyl2d', {
        cell: 0.25, x: [-3, 13], y: [0, 8], edges: { xmin: NEU }, electrodes: S6_ELS,
        shapes: [
            { type: 'circle', electrode: 'a', cx: 4.03, cy: 4.11, r: 1.31 },
            { type: 'annulus', electrode: 'b', cx: 8.06, cy: 0, rIn: 1.21, rOut: 2.23, a0: 0, a1: 120 },
            { type: 'polygon', electrode: 'c', points: [[0.07, 5.02], [2.13, 5.51], [1.24, 7.33]] },
            { type: 'circle', electrode: 'c', cx: -3, cy: 3.04, r: 0.62 },
        ],
        notes: 'Boundary values from 1 + 0.3x + 0.05(x² − ρ²/2); x = −3 is a Neumann edge (∂φ/∂x = 0 there).',
    });
}
function s6Error(p, q) {
    const resolved = resolveP(p);
    const geo = compileGeometry(resolved);
    const H = buildHierarchy(geo, resolved, {});
    const op = H[0], g = op.grid;
    const err = (u) => { let e = 0; for (let k = 0; k < op.N; k++) { if (op.mask[k] === 1) continue; const i = k % g.nx, j = (k - i) / g.nx; e = Math.max(e, Math.abs(u[k] - q(g.x0 + i * g.h, g.y0 + j * g.h))); } return e; };
    const u = new Float64Array(op.N), b = new Float64Array(op.irr.count);
    customBoundarySetup(op, q, u, b);
    let scale = 0;
    for (let k = 0; k < op.N; k++) scale = Math.max(scale, Math.abs(u[k]));
    const st = multigridSolve(H, u, b, { tol: 1e-12, scale, maxCycles: 100 });
    const u2 = new Float64Array(op.N), b2 = new Float64Array(op.irr.count);
    customBoundarySetup(op, q, u2, b2);
    const st2 = carreSOR(op, u2, b2, { tol: 1e-12, scale });
    return { mg: err(u), sor: err(u2), converged: st.converged && st2.converged, cuts: op.raster.cuts.count, irregular: op.irr.count, cycles: st.cycles, sweeps: st2.sweeps };
}
CASES.S6 = {
    project: () => s6Planar(),
    run() {
        const qp = (x, y) => 1 + 0.3 * x - 0.2 * y + 0.05 * (x * x - y * y) + 0.02 * x * y;
        const qc = (x, y) => 1 + 0.3 * x + 0.05 * (x * x - y * y / 2);
        const P = s6Error(s6Planar(), qp), Cc = s6Error(s6Cyl(), qc);
        return {
            checks: [
                check('Planar, multigrid: max |φ − exact|', P.mg, 0, 'abs', 1e-9, 'V'),
                check('Planar, adaptive SOR: max |φ − exact|', P.sor, 0, 'abs', 1e-9, 'V'),
                check('Cylindrical (axis, Neumann edge), multigrid', Cc.mg, 0, 'abs', 1e-9, 'V'),
                check('Cylindrical (axis, Neumann edge), adaptive SOR', Cc.sor, 0, 'abs', 1e-9, 'V'),
            ],
            details: { planar: P, cylindrical: Cc },
        };
    },
};

function einzelThinProject() {
    return proj('S7/S8 Thin-wall einzel lens', 'cyl2d', {
        cell: 1, x: [-128, 128], y: [0, 48],
        edges: { xmin: ED('a'), xmax: ED('c'), ymax: profile([seg(-128, -20, 'a'), ramp(-20, 20, 'a', 'c'), seg(20, 128, 'c')]) },
        electrodes: [el('a', 0, { name: 'Tube a' }), el('b', 0, { name: 'Tube b' }), el('c', 0, { name: 'Tube c' })],
        shapes: [
            { type: 'tube', electrode: 'a', x0: -120, x1: -10.5, rIn: 20.3, rOut: 20.7 },
            { type: 'tube', electrode: 'b', x0: -8.5, x1: 8.5, rIn: 20.3, rOut: 20.7 },
            { type: 'tube', electrode: 'c', x0: 10.5, x1: 120, rIn: 20.3, rOut: 20.7 },
        ],
        notes: 'Walls 0.4 cell thick between nodes; ramp-closed top edge.',
    });
}
function s9Project() {
    return proj('S8/S9 Thin-plate two-aperture lens (404 × 98)', 'cyl2d', {
        cell: 1, x: [-200, 203], y: [0, 97],
        edges: { xmin: ED('A'), xmax: ED('B'), ymax: NEU },
        electrodes: [el('A', 0, { name: 'Plate A' }), el('B', 0, { name: 'Plate B' })],
        shapes: [{ type: 'box', electrode: 'A', x0: -9.65, x1: -9.35, y0: 16, y1: 97 }, { type: 'box', electrode: 'B', x0: 8.5, x1: 9.5, y0: 16, y1: 97 }],
        notes: 'Plate A is 0.3 cell thick between nodes, plate B 1 cell thick off the coarse lattice; 403 and 97 intervals put the far edges off the coarse lattices.',
    });
}
function hierarchyOf(p) {
    const resolved = resolveP(p);
    const geo = compileGeometry(resolved);
    return { resolved, H: buildHierarchy(geo, resolved, {}) };
}
CASES.S7 = {
    project: () => einzelThinProject(),
    run() {
        const { H } = hierarchyOf(einzelThinProject());
        const bases = new Map();
        for (const k of [1, 2, 3]) bases.set(k, solveBasis(H, k, { tol: 1e-12 }).phi);
        const r = rng(7), checks = [];
        for (let trial = 0; trial < 3; trial++) {
            const V = [0, 2000 * r() - 1000, 2000 * r() - 1000, 2000 * r() - 1000];
            const { phi } = solveVoltages(H, V, { tol: 1e-12 });
            const sum = new Float64Array(phi.length);
            for (const k of [1, 2, 3]) { const bk = bases.get(k); for (let q = 0; q < sum.length; q++) sum[q] += V[k] * bk[q]; }
            const vmax = Math.max(...V.map(Math.abs));
            checks.push(check(`Trial ${trial + 1}: max |Σ V_k φ_k − φ_direct| / max|V|`, maxAbsDiff(sum, phi) / vmax, 0, 'abs', 1e-9, 'V/V', { voltages: V.slice(1).map((x) => +x.toFixed(3)) }));
        }
        return { checks, details: { nodes: H[0].N, levels: H.length, mixedNodes: H[0].raster.mix.count } };
    },
};
CASES.S8 = {
    project: () => einzelThinProject(),
    run(level, ctx) {
        const checks = [], details = {};
        for (const [name, make, ks] of [['thin-wall einzel', einzelThinProject, [1, 2, 3]], ['thin-plate two-aperture lens', s9Project, [1, 2]]]) {
            const { H } = hierarchyOf(make());
            for (const k of ks) {
                const sol = {}, paths = {};
                for (const method of ['multigrid', 'krylov', 'sor']) {
                    const { phi, stats } = solveBasis(H, k, { method, tol: 1e-10 });
                    sol[method] = phi; paths[method] = (stats.path || []).join(' → ') + (stats.converged ? '' : ' (not converged)');
                }
                const d = Math.max(maxAbsDiff(sol.multigrid, sol.krylov), maxAbsDiff(sol.multigrid, sol.sor), maxAbsDiff(sol.krylov, sol.sor));
                checks.push(check(`${name}, basis ${k}: largest difference between the three methods`, d, 0, 'abs', 1e-9, 'V/V'));
                details[`${name} ${k}`] = paths;
            }
            progress(ctx, 0.5, `S8 ${name}`);
        }
        return { checks, details };
    },
};
CASES.S9 = {
    project: () => s9Project(),
    run() {
        const { H } = hierarchyOf(s9Project());
        const checks = [];
        const perLevel = H.map((op) => { const el2 = op.raster.cuts.elec; let a = 0, b = 0; for (let q = 0; q < el2.length; q++) { if (el2[q] === 1) a++; else if (el2[q] === 2) b++; } return [a, b]; });
        checks.push(check('Levels with plate cuts of both electrodes', perLevel.filter(([a, b]) => a > 0 && b > 0).length, H.length, 'bracket', [H.length, H.length], ''));
        checks.push(check('Coarse levels with both far edges off the lattice', H.slice(1).filter((op) => op.grid.offX > 0 && op.grid.offY > 0).length, H.length - 1, 'bracket', [H.length - 1, H.length - 1], ''));
        const contraction = [];
        for (const k of [1, 2]) {
            const op = H[0], u = new Float64Array(op.N), b = newRhs(op);
            basisSetup(op, k, u, b);
            const st = multigridSolve(H, u, b, { tol: 1e-10, allowSwitch: true });
            const hst = st.history || [];
            const mean = hst.length > 1 ? Math.pow(hst[hst.length - 1] / hst[0], 1 / (hst.length - 1)) : NaN;
            contraction.push(mean);
            checks.push(check(`Basis ${k}: mean contraction per multigrid cycle`, mean, 0.35, 'bracket', [0, 0.35], '/cycle'));
            const auto = solveBasis(H, k, { tol: 1e-12 }), sor = solveBasis(H, k, { method: 'sor', tol: 1e-10 });
            checks.push(check(`Basis ${k}: automatic method path`, (auto.stats.path || []).join(' → '), 'multigrid', 'bracket'));
            checks.push(check(`Basis ${k}: automatic vs SOR`, maxAbsDiff(auto.phi, sor.phi), 0, 'abs', 1e-9, 'V/V'));
        }
        return { checks, details: { levels: H.length, cutsPerLevel: perLevel, contraction } };
    },
};

function s10Project(a, boundary) {
    const h = 80 / a, L = 128;
    return proj(`S10 Concentric spheres, a = ${a} cells (${boundary})`, 'cyl2d', {
        cell: h, x: [0, L], y: [0, L], mirror: { x: true }, boundary,
        edges: { xmin: NEU, xmax: ED('out'), ymax: ED('out') },
        electrodes: [el('in', 500, { name: 'Inner sphere' }), el('out', '-1000/3', { name: 'Outer sphere' })],
        shapes: [{ type: 'circle', electrode: 'in', cx: 0, cy: 0, r: 80 }, { type: 'annulus', electrode: 'out', cx: 0, cy: 0, rIn: 120, rOut: 200, a0: 0, a1: 360 }],
    });
}
function s10Error(a, boundary) {
    const resolved = resolveP(s10Project(a, boundary));
    const solved = solveP(resolved);
    const field = fieldP(resolved, solved);
    const phi = field.channels[0].phi, cls = solved.raster0.cls, n = resolved.domain.nx, h = resolved.domain.h;
    let e = 0;
    for (let k = 0; k < phi.length; k++) {
        if (cls[k] !== -1) continue;
        const i = k % n, j = (k - i) / n, r = Math.hypot(i * h, j * h);
        if (r <= 80 || r >= 120) continue;
        e = Math.max(e, Math.abs(phi[k] - (200000 / r - 2000)));
    }
    return e;
}
CASES.S10 = {
    project: () => s10Project(40, 'subgrid'),
    run(level) {
        const as = level === 'full' ? [20, 40, 80] : [20, 40];
        const e = as.map((a) => s10Error(a, 'subgrid'));
        const checks = [];
        for (let i = 1; i < as.length; i++) checks.push(check(`Shortley–Weller order, a = ${as[i - 1]} → ${as[i]} cells`, Math.log2(e[i - 1] / e[i]), 2, 'bracket', [1.8, 2.3], ''));
        const st = [20, 40].map((a) => s10Error(a, 'staircase'));
        return { checks, details: { a: as, maxError: e, staircase: { a: [20, 40], maxError: st, order: Math.log2(st[0] / st[1]) } } };
    },
};

// ---------------------------------------------------------------- T: trajectories in solved fields
function t1Project() {
    return proj('T1 Mirror through a node-aligned mesh', 'planar2d', {
        cell: 0.25, x: [-10, 70], y: [-10, 22],
        edges: { xmin: NEU, xmax: NEU, ymin: ED('gnd'), ymax: ED('back') },
        electrodes: [el('mesh', 0, { kind: 'grid', transmission: 1, name: 'Mesh (0 V)' }), el('back', 1000, { name: 'Back plate' })],
        shapes: [{ type: 'polyline', electrode: 'mesh', points: [[-10, 0], [70, 0]] }, { type: 'box', electrode: 'back', x0: -10, x1: 70, y0: 20, y1: 22 }],
        sources: [source('b1', { name: '30°–60° fan', species: [sp('m 100', 100)], position: pt(0, 1e-6), direction: fan([1, 0, 0], 30, 60, 7), energy: mono(1000), count: 7 })],
        planes: [plane('ret', 'y', 0, { side: 'backward', name: 'Mesh plane (return crossing)' }), plane('det', 'y', -5, { terminate: true, name: 'Detector' })],
        tracer: tracer(),
    });
}
/** Apex of a ballistic arc from the three trajectory points around the maximum of y (exact for a uniform field). */
function apexY(tr) {
    let k = 0;
    for (let i = 1; i < tr.y.length; i++) if (tr.y[i] > tr.y[k]) k = i;
    if (k === 0 || k === tr.y.length - 1) return tr.y[k];
    const t0 = tr.t[k - 1] - tr.t[k], t2 = tr.t[k + 1] - tr.t[k], y0 = tr.y[k - 1], y1 = tr.y[k], y2 = tr.y[k + 1];
    // y = a t² + b t + y1 through (t0, y0), (0, y1), (t2, y2)
    const a = ((y0 - y1) / t0 - (y2 - y1) / t2) / (t0 - t2), b = (y0 - y1) / t0 - a * t0;
    return y1 - b * b / (4 * a);
}
CASES.T1 = {
    project: t1Project,
    run() {
        const { resolved, solved, result } = runAll(t1Project(), { overrides: { record: { everyStep: true, maxPoints: 1e6 } } });
        const v = T('T1').values, ret = crossings(result, 0);
        const xr = (id) => { const c = ret.find((q) => q.id === id); return c ? c.x : NaN; };
        return {
            checks: [
                check('Range at 30°', xr(0), v.r30, 'digits', null, 'mm'),
                check('Range at 45°', xr(3), v.r45, 'digits', null, 'mm'),
                check('Range at 60°', xr(6), v.r60, 'digits', null, 'mm'),
                check('Depth at 45°', apexY(trajectory(result, 3)), v.depth, 'digits', null, 'mm'),
                exactCheck('T1', 'Range at 30°', xr(0), exact.mirrorRange(20, 1000, 1000, 30), 'mm'),
                exactCheck('T1', 'Range at 45°', xr(3), exact.mirrorRange(20, 1000, 1000, 45), 'mm'),
                exactCheck('T1', 'Range at 60°', xr(6), exact.mirrorRange(20, 1000, 1000, 60), 'mm'),
                exactCheck('T1', 'Depth at 45°', apexY(trajectory(result, 3)), exact.mirrorDepth(20, 1000, 1000, 45), 'mm'),
            ],
            details: { ...gridInfo(resolved, solved), status: [0, 3, 6].map((i) => STATUS_NAMES[result.summary[i * S_STRIDE + S_STATUS]]) },
        };
    },
};

function t2Project(which) {
    const a = which === 'a';
    const h = a ? 0.25 : 0.28, x1 = a ? 30 : 30.24, y = a ? [-5, 5] : [-4.9, 4.9];
    return proj(`T2 Exit-mesh energy (${a ? 'mesh on a node column' : 'mesh between nodes'})`, 'planar2d', {
        cell: h, x: [0, x1], y,
        edges: { xmin: ED('rep'), xmax: ED('gnd'), ymin: NEU, ymax: NEU },
        electrodes: [el('rep', 600, { name: 'Repeller edge' }), el('mesh', 0, { kind: 'grid', transmission: 1, name: 'Exit mesh' })],
        shapes: [{ type: 'polyline', electrode: 'mesh', points: [[6, y[0]], [6, y[1]]] }],
        sources: [source('b1', { name: 'At rest 5 mm before the mesh', species: [sp('m 100', 100)], position: pt(1, 0), direction: dir(1, 0), energy: mono(0) })],
        planes: [plane('det', 'x', 21, { terminate: true, side: 'forward', name: '15 mm after the mesh' })],
        tracer: tracer(),
    });
}
CASES.T2 = {
    project: () => t2Project('a'),
    run() {
        const checks = [], details = {};
        for (const w of ['a', 'b']) {
            const { result } = runAll(t2Project(w));
            const S = result.summary;
            checks.push(check(`(${w}) kinetic energy after the mesh`, S[S_STATUS] === STATUS.DETECTED ? S[S_KE] : NaN, 500, 'rel', 1e-6, 'eV'));
            details[w] = { status: STATUS_NAMES[S[S_STATUS]], steps: S[S_STEPS] };
        }
        return { checks, details };
    },
};

function t3Project() {
    const s0 = 5;
    return proj('T3 Wiley–McLaren space focus', 'planar2d', {
        cell: 0.25, x: [0, 30], y: [-5, 5],
        edges: { xmin: ED('rep'), xmax: ED('gnd'), ymin: NEU, ymax: NEU },
        electrodes: [el('rep', 1000, { name: 'Repeller (100 V/mm)' }), el('mesh', 0, { kind: 'grid', transmission: 1, name: 'Exit mesh' })],
        shapes: [{ type: 'polyline', electrode: 'mesh', points: [[10, -5], [10, 5]] }],
        sources: [source('b1', { name: 's₀(1 ∓ 1e-3), s₀', species: [sp('m 100', 100)], position: { type: 'list', points: [[10 - s0 * (1 - 1e-3), 0, 0], [10 - s0, 0, 0], [10 - s0 * (1 + 1e-3), 0, 0]] }, direction: dir(1, 0), energy: mono(0), count: 3 })],
        planes: [plane('det', 'x', 10 + 2 * s0, { terminate: true, side: 'forward', name: 'Detector at 2s₀' })],
        tracer: tracer({ rtol: 1e-12 }),
    });
}
CASES.T3 = {
    project: t3Project,
    run() {
        const { result } = runAll(t3Project());
        const S = result.summary, t = [0, 1, 2].map((i) => S[i * S_STRIDE + S_TOF]);
        const d = (t[2] - t[0]) / (2e-3 * t[1]);
        return { checks: [check('∂lnT/∂lns at s₀ (space focus)', d, 0, 'abs', 1e-4, '')], details: { tof: t } };
    },
};

function t4Project() {
    return proj('T4 Reflectron energy focus', 'planar2d', {
        cell: 0.5, x: [-10, 300], y: [-10, 10],
        edges: { xmin: ED('gnd'), xmax: ED('back'), ymin: profile([seg(-10, 100, 'gnd'), ramp(100, 300, 'gnd', 'back')]), ymax: profile([seg(-10, 100, 'gnd'), ramp(100, 300, 'gnd', 'back')]) },
        electrodes: [el('mesh', 0, { kind: 'grid', transmission: 1, name: 'Mirror mesh' }), el('back', 4000, { name: 'Back plate' })],
        shapes: [{ type: 'polyline', electrode: 'mesh', points: [[100, -10], [100, 10]] }],
        sources: [source('b1', { name: 'KE 1000(1 ∓ 1e-3) eV', species: [sp('m 100', 100)], position: pt(0, 0), direction: dir(1, 0), energy: { type: 'list', values: [999, 1000, 1001] }, count: 3 })],
        planes: [plane('det', 'x', 0, { terminate: true, side: 'backward', name: 'Detector (return)' })],
        tracer: tracer({ rtol: 1e-12 }),
    });
}
CASES.T4 = {
    project: t4Project,
    run() {
        const { result } = runAll(t4Project());
        const S = result.summary, t = [0, 1, 2].map((i) => S[i * S_STRIDE + S_TOF]);
        const d = (t[2] - t[0]) / (2e-3 * t[1]);
        return { checks: [check('∂lnT/∂lnK at L = 4·d_pen (energy focus)', d, 0, 'abs', 1e-4, '')], details: { tof: t, status: [0, 1, 2].map((i) => STATUS_NAMES[S[i * S_STRIDE + S_STATUS]]) } };
    },
};

const T5_XS = -8 + 2 / 40;
const T5_START = [[T5_XS, 0.05, 0], [T5_XS, 0.1, 0], [T5_XS, 0.2, 0], [T5_XS, 0.3, 0], [T5_XS, 0.4, 0], [T5_XS, 0.5, 0], [T5_XS, 0.2, 0], [T5_XS, 0.1, 0.15]];
function t5Project(rtol = 1e-10) {
    return proj('T5 Energy conservation, zero-gap einzel (ratio 9)', 'cyl2d', {
        cell: 1 / 40, x: [-8, 8], y: [0, 1],
        edges: { xmin: ED('gnd'), xmax: ED('gnd'), ymax: profile([seg(-8, -0.5, 'gnd'), seg(-0.5, 0.5, 'C'), seg(0.5, 8, 'gnd')]) },
        electrodes: [el('C', -8000, { name: 'Center tube' })],
        sources: [
            source('mer', { name: 'Meridional rays', species: [sp('m 100', 100)], position: { type: 'list', points: T5_START.slice(0, 6) }, direction: dir(1, 0, 0), energy: mono(1000), count: 6 }),
            source('sk1', { name: 'Skew ray 1', species: [sp('m 100', 100)], position: pt(...T5_START[6]), direction: dir(1, 0, 0.004), energy: mono(1000) }),
            source('sk2', { name: 'Skew ray 2', species: [sp('m 100', 100)], position: pt(...T5_START[7]), direction: dir(1, -0.002, 0.003), energy: mono(1000) }),
        ],
        planes: [plane('det', 'x', 3.5, { terminate: true, side: 'forward', name: 'End plane' })],
        tracer: tracer({ rtol }),
        notes: 'R = 1 mm, outer tubes grounded, center tube −8000 V: kinetic-potential ratio 9 for 1000 eV ions.',
    });
}
function t5Field() {
    return memo('T5', () => { const resolved = resolveP(t5Project()); const solved = solveP(resolved); return { resolved, solved, field: fieldP(resolved, solved) }; });
}
CASES.T5 = {
    project: () => t5Project(),
    run() {
        const { resolved, solved, field } = t5Field();
        const result = traceP(resolved, field, {});
        const S = result.summary;
        let de = 0, w = 0, det = 0;
        for (let i = 0; i < result.n; i++) {
            const o = i * S_STRIDE;
            if (S[o + S_STATUS] === STATUS.DETECTED) det++;
            de = Math.max(de, Math.abs(S[o + S_DE_END]) / 1000);
            w = Math.max(w, S[o + S_WORK] / 1000);
        }
        return {
            checks: [
                check('Rays reaching the end plane', det, result.n, 'bracket', [result.n, result.n], ''),
                check('max |ΔE_end| / KE', de, 0, 'abs', 2e-6, ''),
                check('max accumulated work error / KE', w, 0, 'abs', 2e-6, ''),
            ],
            details: { ...gridInfo(resolved, solved), steps: Array.from({ length: result.n }, (_, i) => S[i * S_STRIDE + S_STEPS]) },
        };
    },
};
CASES.T6 = {
    project: () => t5Project(1e-12),
    run() {
        const { resolved, field } = t5Field();
        const fwd = traceP(resolved, field, { overrides: { rtol: 1e-12 } });
        const S = fwd.summary, n = fwd.n;
        const rows = new Float64Array(n * P_STRIDE);
        for (let i = 0; i < n; i++) {
            const o = i * S_STRIDE;
            const v = Math.hypot(S[o + S_VX], S[o + S_VY], S[o + S_VZ]);
            particleRow(rows, i, { id: i, mass: 100, charge: 1, ke: S[o + S_KE], p: [S[o + S_X], S[o + S_Y], S[o + S_Z]], d: [-S[o + S_VX] / v, -S[o + S_VY] / v, -S[o + S_VZ] / v], relativistic: false });
        }
        const back = traceP(resolved, field, { particles: rows, overrides: { rtol: 1e-12, planes: [plane('start', 'x', T5_XS, { terminate: true, side: 'backward' })] } });
        let dr = 0, ok = 0;
        for (let i = 0; i < n; i++) {
            const o = rowOfId(back, i);
            if (back.summary[o + S_STATUS] === STATUS.DETECTED) ok++;
            dr = Math.max(dr, Math.hypot(back.summary[o + S_Y] - T5_START[i][1], back.summary[o + S_Z] - T5_START[i][2]));
        }
        return { checks: [check('Rays traced back to the start plane', ok, n, 'bracket', [n, n], ''), check('max distance from the start point', dr, 0, 'abs', 1e-6, 'R')], details: { rays: n } };
    },
};

const T7_THETAS = Array.from({ length: 15 }, (_, k) => 120 + k);
function t7Project(level) {
    const p = s1Project(level);
    p.meta.name = 'T7 127° cylindrical analyzer';
    const mrad = 1e-3 / DEG;
    p.sources = [source('b1', { name: '0 and ±1 mrad', species: [sp('q −1, 1 u', 1, -1)], position: pt(15, 0), direction: fan([0, 1, 0], -mrad, mrad, 3), energy: mono(100 / (2 * Math.LN2)), count: 3 })];
    p.recording.planes = anglePlanes('a', [0, 0], T7_THETAS, (phi) => phi, 10.5, 19.5);
    p.tracer = tracer({ rtol: 1e-11, tMax: 0.32 });
    return p;
}
CASES.T7 = {
    project: t7Project,
    run(level) {
        const { field } = s1Field(level);
        const resolved = resolveP(t7Project(level));
        const result = traceP(resolved, field, { overrides: { record: { everyStep: true, maxPoints: 1e6 } } });
        const a = radialSamples(result, 0, [0, 0], T7_THETAS), b = radialSamples(result, 2, [0, 0], T7_THETAS);
        const ang = crossingAngle(a, b, 120, 134);
        const tr = trajectory(result, 1);
        let dr = 0;
        for (let i = 0; i < tr.x.length; i++) {
            const th = Math.atan2(tr.y[i], tr.x[i]) / DEG;
            if (th >= 0 && th <= 180 / Math.SQRT2) dr = Math.max(dr, Math.abs(Math.hypot(tr.x[i], tr.y[i]) - 15));
        }
        const full = level === 'full';
        return {
            checks: [
                check('Focus angle of the ±1 mrad rays', ang, 180 / Math.SQRT2, 'abs', full ? 0.002 : 0.003, '°'),
                check('Central ray: max |r − r₀| over 127°', dr, 0, 'abs', full ? 3e-4 : 1e-3, 'mm'),
            ],
            details: { cell: resolved.domain.h, steps: result.summary[S_STRIDE + S_STEPS] },
        };
    },
};

const T8_THETAS = Array.from({ length: 9 }, (_, k) => 172 + 2 * k);
function t8Project(level) {
    const p = s2Project(level);
    p.meta.name = 'T8 180° spherical analyzer';
    const mrad = 1e-3 / DEG;
    p.sources = [source('b1', { name: '0 and ±1 mrad', species: [sp('q −1, 1 u', 1, -1)], position: pt(0, 100), direction: fan([1, 0, 0], -mrad, mrad, 3), energy: mono(1000), count: 3 })];
    p.recording.planes = T8_THETAS.map((th, k) => plane(`x${k}`, 'x', 100 * Math.sin(th * DEG), { record: 'all', name: `${th}°` }));
    p.tracer = tracer({ rtol: 1e-10, tMax: 0.76 });
    return p;
}
function polarSamples(result, id, nPlanes) {
    const t = [], r = [];
    for (let k = 0; k < nPlanes; k++) {
        for (const c of crossings(result, k)) {
            if (c.id !== id || !(c.y < 0)) continue;
            let th = Math.atan2(c.x, c.y) / DEG;
            if (th < 0) th += 360;
            t.push(th); r.push(Math.hypot(c.x, c.y));
        }
    }
    const idx = t.map((_, i) => i).sort((p, q) => t[p] - t[q]);
    return { t: idx.map((i) => t[i]), r: idx.map((i) => r[i]) };
}
CASES.T8 = {
    project: t8Project,
    run(level) {
        const { field } = s2Field(level);
        const resolved = resolveP(t8Project(level));
        const result = traceP(resolved, field, { overrides: { record: { everyStep: true, maxPoints: 1e6 } } });
        const a = polarSamples(result, 0, T8_THETAS.length), b = polarSamples(result, 2, T8_THETAS.length);
        const ang = crossingAngle(a, b, 173, 187);
        const tr = trajectory(result, 1);
        let dr = 0;
        for (let i = 0; i < tr.x.length; i++) {
            let th = Math.atan2(tr.x[i], tr.y[i]) / DEG;
            if (th < -1) th += 360;
            if (th >= 0 && th <= 180) dr = Math.max(dr, Math.abs(Math.hypot(tr.x[i], tr.y[i], tr.z[i]) - 100));
        }
        const full = level === 'full';
        return {
            checks: [
                check('Focus angle of the ±1 mrad rays', ang, 180, 'abs', full ? 0.008 : 0.03, '°'),
                check('Central ray: max |r − r₀| over 180°', dr, 0, 'abs', full ? 1e-3 : 4e-3, 'mm'),
            ],
            details: { cell: resolved.domain.h, samples: [a.t.length, b.t.length], steps: result.summary[S_STRIDE + S_STEPS] },
        };
    },
};

// ---- RF quadrupole (T9, T10) and ideal quadrupole (T11)
const RF_F = 1.1, R0Q = 4;
function quadProject(level, V, { sources = [], planes = [], markers = null, tMax = 1000, name = 'Solved quadrupole', cell = null } = {}) {
    return proj(name, 'planar2d', {
        cell: cell || (level === 'full' ? 0.05 : 0.1), x: [0, 14], y: [0, 14], mirror: { x: true, y: true },
        edges: { xmin: NEU, ymin: NEU, xmax: ED('gnd'), ymax: ED('gnd') },
        electrodes: [el('rodsX', 0, { terms: [{ type: 'cos', amp: -V, freq: RF_F, phase: 0 }], name: 'x rods' }), el('rodsY', 0, { terms: [{ type: 'cos', amp: V, freq: RF_F, phase: 0 }], name: 'y rods' })],
        shapes: [{ type: 'quadric', electrode: 'rodsX', A: 1, B: -1, C: R0Q * R0Q, cx: 0, cy: 0, clip: [0, 11.2, 0, 11.2] },
            { type: 'quadric', electrode: 'rodsY', A: -1, B: 1, C: R0Q * R0Q, cx: 0, cy: 0, clip: [0, 11.2, 0, 11.2] }],
        sources, planes, markers,
        tracer: tracer({ tMax, rfStepsPerPeriod: 64 }),
        notes: 'Hyperbolic rods r₀ = 4 mm (quarter domain with mirrors); rods at ±(−V cos Ωt), 1.1 MHz.',
    });
}
const vForQ = (q, m = 100) => exact.qmfVoltages({ massU: m, r0: R0Q, freqMHz: RF_F, a: 0, q }).V;
function t9Project(level, q) {
    const Tp = 1 / RF_F;
    return quadProject(level, vForQ(q), {
        name: `T9 Secular frequency, q = ${q}`,
        sources: [source('b1', { name: 'At rest at x = y = 0.1r₀', species: [sp('m 100', 100)], position: pt(0.1 * R0Q, 0.1 * R0Q), direction: dir(1, 0), energy: mono(0) })],
        markers: Tp, tMax: 400.5 * Tp,
    });
}
/** β from the stroboscopic recurrence x_{k+1} + x_{k−1} = 2cos(πβ)x_k. */
function strobeBeta(xs) {
    let num = 0, den = 0;
    for (let i = 1; i < xs.length - 1; i++) { num += xs[i] * (xs[i + 1] + xs[i - 1]); den += xs[i] * xs[i]; }
    return Math.acos(Math.max(-1, Math.min(1, num / den / 2))) / Math.PI;
}
CASES.T9 = {
    project: (level) => t9Project(level, 0.5),
    run(level, ctx) {
        const qs = [0.2, 0.5, 0.8];
        const vars = solveVariants(t9Project(level, qs[0]), qs.map((q) => t9Project(level, q)));
        // A2 from the difference basis on the x axis, x ≤ 0.4 r0: d(x) = A2 (x/r0)² + A6 (x/r0)⁶
        const { solved, resolved } = vars[0];
        const bx = solved.bases.get(1), by = solved.bases.get(2), h = resolved.domain.h;
        let s11 = 0, s12 = 0, s22 = 0, b1 = 0, b2 = 0;
        for (let i = 0; i * h <= 0.4 * R0Q + 1e-12; i++) {
            const u = (i * h / R0Q) ** 2, w = u * u * u, d = bx[i] - by[i];
            s11 += u * u; s12 += u * w; s22 += w * w; b1 += u * d; b2 += w * d;
        }
        const det = s11 * s22 - s12 * s12, A2 = (b1 * s22 - b2 * s12) / det, A6 = (s11 * b2 - s12 * b1) / det;
        const checks = [], details = { A2, A6 };
        vars.forEach((vv, k) => {
            const result = traceP(vv.resolved, vv.field, {});
            const m = markersOf(result, result.summary[S_ID]);
            const ref = exact.mathieu.beta(0, qs[k] * A2);
            checks.push(check(`q = ${qs[k]}: β from x`, strobeBeta(m.x), ref, 'rel', 1e-5, ''));
            checks.push(check(`q = ${qs[k]}: β from y`, strobeBeta(m.y), ref, 'rel', 1e-5, ''));
            details[`q${qs[k]}`] = { markers: m.x.length, status: STATUS_NAMES[result.summary[S_STATUS]], steps: result.summary[S_STEPS] };
            progress(ctx, (k + 1) / 3, `T9 q = ${qs[k]}`);
        });
        return { checks, details };
    },
};

function t10Project(q) {
    const Tp = 1 / RF_F, xl = 0.9 * R0Q;
    return quadProject('quick', vForQ(q), {
        name: `T10 Stability edge, q = ${q}`, cell: 0.1,
        sources: [source('b1', { name: '0.05r₀ at rest, 16 RF phases', species: [sp('m 100', 100)], position: pt(0.05 * R0Q, 0), direction: dir(1, 0), energy: mono(0), time: { type: 'rfPhase', freq: RF_F, n: 16 }, count: 16 })],
        planes: [plane('xp', 'x', xl, { name: '+0.9 r₀' }), plane('xm', 'x', -xl, { name: '−0.9 r₀' })],
        tMax: 200 * Tp,
    });
}
function lostCount(result, nPlanes = 2) {
    const crossed = new Set();
    for (let k = 0; k < nPlanes; k++) for (const c of crossings(result, k)) crossed.add(c.id);
    let lost = 0;
    for (let i = 0; i < result.n; i++) { const o = i * S_STRIDE; if (result.summary[o + S_STATUS] !== STATUS.TMAX || crossed.has(result.summary[o + S_ID])) lost++; }
    return lost;
}
CASES.T10 = {
    project: () => t10Project(0.89),
    run(level, ctx) {
        const vars = solveVariants(t10Project(0.89), [t10Project(0.89), t10Project(0.93)]);
        const r89 = traceP(vars[0].resolved, vars[0].field, {});
        progress(ctx, 0.5, 'T10 q = 0.89');
        const r93 = traceP(vars[1].resolved, vars[1].field, {});
        const l89 = lostCount(r89), l93 = lostCount(r93);
        return {
            checks: [
                check('q = 0.89: ions beyond 0.9r₀ or lost (of 16)', l89, 0, 'bracket', [0, 0], ''),
                check('q = 0.93: ions lost (of 16)', l93, 16, 'bracket', [16, 16], ''),
            ],
            details: { q089: { tmax: statusCount(r89, STATUS.TMAX) }, q093: { hit: statusCount(r93, STATUS.HIT), exit: statusCount(r93, STATUS.EXIT) } },
        };
    },
};

function t11Project(a, q) {
    const { U, V } = exact.qmfVoltages({ massU: 100, r0: R0Q, freqMHz: RF_F, a, q });
    return proj(`T11 Ideal quadrupole, (a, q) = (${a}, ${q})`, 'planar2d', {
        cell: 0.5, x: [-20, 20], y: [-20, 20],
        ideal: [{ id: 'f1', enabled: true, type: 'quadrupole2d', center: [0, 0], r0: R0Q, U, V, freq: RF_F, phase: 0 }],
        sources: [source('b1', { name: '0.05r₀ at rest, 16 RF phases', species: [sp('m/z 100', 100)], position: pt(0.05 * R0Q, 0.05 * R0Q), direction: dir(1, 0), energy: mono(0), time: { type: 'rfPhase', freq: RF_F, n: 16 }, count: 16 })],
        tracer: tracer({ tMax: 200 / RF_F, rfStepsPerPeriod: 64 }),
        notes: 'Ideal quadrupole field; the box (±5r₀) catches unstable ions.',
    });
}
CASES.T11 = {
    project: () => t11Project(0.230, 0.706),
    run(level, ctx) {
        const st = runAll(t11Project(0.230, 0.706)).result;
        progress(ctx, 0.4, 'T11 stable point');
        const un = runAll(t11Project(0.244, 0.706)).result;
        const v = T('T11').values;
        const ap = exact.mathieu.apexPoint(), q0 = exact.mathieu.edgeA0();
        const Vq = exact.qmfVoltages({ massU: 100, r0: R0Q, freqMHz: RF_F, a: 0, q: q0 }).V;
        const apx = exact.qmfVoltages({ massU: 100, r0: R0Q, freqMHz: RF_F, a: ap.a, q: ap.q });
        return {
            checks: [
                check('(0.230, 0.706): ions stable for 200 cycles (of 16)', statusCount(st, STATUS.TMAX), 16, 'bracket', [16, 16], ''),
                check('(0.244, 0.706): ions lost within 200 cycles (of 16)', un.n - statusCount(un, STATUS.TMAX), 16, 'bracket', [16, 16], ''),
                check('V at q* = 0.908046 (m/z 100, r₀ 4 mm, 1.1 MHz)', Vq, v.Vq, 'digits', null, 'V'),
                check('Apex U', apx.U, v.U, 'digits', null, 'V'),
                check('Apex V', apx.V, v.V, 'digits', null, 'V'),
            ],
            details: { apex: ap, qEdge: q0 },
        };
    },
};

function t12Project() {
    return proj('T12 Paul-trap low-mass cut-off', 'cyl2d', {
        cell: 0.1, x: [0, 15], y: [0, 15], mirror: { x: true },
        edges: { xmin: NEU, xmax: ED('gnd'), ymax: ED('gnd') },
        electrodes: [el('ring', 0, { terms: [{ type: 'cos', amp: 500, freq: 1.0, phase: 0 }], name: 'Ring electrode' })],
        shapes: [{ type: 'quadric', electrode: 'ring', A: -2, B: 1, C: 49.985, cx: 0, cy: 0, clip: [0, 15, 0, 15] },
            { type: 'quadric', electrode: 'gnd', A: 2, B: -1, C: 50, cx: 0, cy: 0, clip: [0, 15, 0, 15] }],
        sources: [source('b1', { name: '16 RF phases per mass', species: [sp('m 120', 120), sp('m 100', 100)], position: pt(0.1, 0), direction: dir(1, 0), energy: mono(0), time: { type: 'rfPhase', freq: 1.0, n: 16 }, count: 32 })],
        tracer: tracer({ tMax: 200, rfStepsPerPeriod: 64 }),
        notes: 'Hyperbolic ring (r₀ 7.07 mm) and grounded end caps (z₀ 5 mm), mirrored at x = 0; ring 500 V at 1 MHz.',
    });
}
CASES.T12 = {
    project: t12Project,
    run() {
        const { result } = runAll(t12Project());
        const S = result.summary;
        let trapped120 = 0, lost100 = 0;
        for (let i = 0; i < result.n; i++) {
            const o = i * S_STRIDE, tmax = S[o + S_STATUS] === STATUS.TMAX;
            if (S[o + S_SPECIES] === 0 && tmax) trapped120++;
            if (S[o + S_SPECIES] === 1 && !tmax) lost100++;
        }
        return {
            checks: [
                check('m 120 trapped for 200 cycles (of 16)', trapped120, 16, 'bracket', [16, 16], ''),
                check('m 100 lost (of 16)', lost100, 16, 'bracket', [16, 16], ''),
                check('Low-mass cut-off |q_z| = 0.908', exact.paulLMCO({ r0: 7.07, z0: 5, freqMHz: 1, v0: 500 }), T('T12').values.lmco, 'digits', null, 'u'),
            ],
            details: { status: Object.fromEntries(STATUS_NAMES.map((nm, k) => [nm, statusCount(result, k)]).filter(([, c]) => c > 0)) },
        };
    },
};

function loopMag(id, x, turns) { return { id, name: `Loop at x = ${x} mm`, enabled: true, type: 'loop', center: [x, 0, 0], normal: [1, 0, 0], radius: 100, turns, current: 1 }; }
function t13Project(single = false) {
    return proj(single ? 'T13 Single current loop' : 'T13 Helmholtz pair', 'cyl2d', {
        cell: 1, x: [-100, 100], y: [0, 60],
        magnets: single ? [loopMag('m1', 0, 1)] : [loopMag('m1', -50, 100), loopMag('m2', 50, 100)],
        notes: single ? 'One loop, R 100 mm, 1 A, centered at the origin.' : 'N 100, 1 A, R 100 mm at x = ±50 mm.',
    });
}
CASES.T13 = {
    project: () => t13Project(false),
    run() {
        const v = T('T13').values, b3 = new Float64Array(3), o2 = new Float64Array(2);
        const hz = (() => { const r = resolveP(t13Project(false)); const f = fieldP(r, solveP(r)); f.model.B(0, 0, 0, b3); return Math.hypot(b3[0], b3[1], b3[2]); })();
        const sz = (() => { const r = resolveP(t13Project(true)); const f = fieldP(r, solveP(r)); f.model.B(50, 0, 0, b3); return Math.hypot(b3[0], b3[1], b3[2]); })();
        loopField(100, 1, 100, 0, 50, o2);
        const hzLoop = 2 * Math.hypot(o2[0], o2[1]);
        loopField(100, 1, 1, 0, 50, o2);
        const szLoop = Math.hypot(o2[0], o2[1]);
        return {
            checks: [
                check('Helmholtz pair, B at the center (field model)', hz * 1e3, v.helmholtz, 'digits', null, 'mT'),
                check('Helmholtz pair, B at the center (loopField)', hzLoop * 1e3, v.helmholtz, 'digits', null, 'mT'),
                check('Single loop, B on the axis at 50 mm (field model)', sz * 1e6, v.loop, 'digits', null, 'µT'),
                check('Single loop, B on the axis at 50 mm (loopField)', szLoop * 1e6, v.loop, 'digits', null, 'µT'),
                // on the axis B = μ₀NIa²/(2(a² + z²)^(3/2)) (a = 0.1 m, z = 0.05 m)
                exactCheck('T13', 'Helmholtz pair, B at the center (field model)', hz * 1e3, 2 * 1e3 * MU0 * 100 * 0.01 / (2 * Math.pow(0.0125, 1.5)), 'mT'),
                exactCheck('T13', 'Single loop, B on the axis at 50 mm (field model)', sz * 1e6, 1e6 * MU0 * 0.01 / (2 * Math.pow(0.0125, 1.5)), 'µT'),
            ],
            details: {},
        };
    },
};

function vmiProject(level) {
    const h = level === 'full' ? 0.25 : 0.5;
    return proj('T14 Velocity-map imaging lens', 'cyl2d', {
        cell: h, x: [-5, 155], y: [0, 50], beyond: { xmax: 'drift' },
        electrodes: [el('rep', 3000, { name: 'Repeller' }), el('ext', 2085, { name: 'Extractor (0.695·Vrep)' })],
        shapes: [{ type: 'plate', electrode: 'rep', x: -0.5, t: 1, rHole: 0, rOut: 40 }, { type: 'plate', electrode: 'ext', x: 15.5, t: 1, rHole: 10, rOut: 40 },
            { type: 'plate', electrode: 'gnd', x: 30.5, t: 1, rHole: 10, rOut: 40 }],
        sources: [source('b1', { name: 'O⁺, 1 and 2 eV', species: [sp('O+', 15.995)], position: { type: 'rect', center: [7.5, 0, 0], u: [1, 0, 0], v: [0, 1, 0], halfU: 0.5, halfV: 1.0, n: [3, 5] },
            direction: fan([1, 0, 0], 0, 330, 12), energy: { type: 'list', values: [1, 2] }, count: 360 })],
        planes: [plane('det', 'x', 400, { terminate: true, radius: 45, name: 'Detector at 400 mm' })],
        tracer: tracer({ rtol: 1e-8, relativistic: true }),
        notes: 'Generic dimensions in the style of Eppink & Parker (1997), not from the paper.',
    });
}
const sameBits = (a, b, n = a.length) => {
    if (!a || !b || a.length < n || b.length < n) return false;
    const ua = new Uint8Array(a.buffer, a.byteOffset, n * a.BYTES_PER_ELEMENT), ub = new Uint8Array(b.buffer, b.byteOffset, n * b.BYTES_PER_ELEMENT);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
};
function sameResult(a, b) {
    if (a.n !== b.n || a.nCross !== b.nCross) return false;
    if (!sameBits(a.summary, b.summary, a.n * S_STRIDE)) return false;
    if (!sameBits(a.crossings, b.crossings, a.nCross * C_STRIDE)) return false;
    if (!!a.traj !== !!b.traj) return false;
    if (a.traj && (!sameBits(a.traj.offsets, b.traj.offsets) || !sameBits(a.traj.pts, b.traj.pts, a.traj.offsets[a.n] * 4))) return false;
    return true;
}
/** FNV-1a digest (hex) of the summary and crossing rows, for comparisons across workers. */
export function resultDigest(r) {
    let h = 0x811c9dc5;
    const feed = (arr, n) => { const u = new Uint8Array(arr.buffer, arr.byteOffset, n * arr.BYTES_PER_ELEMENT); for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193); } };
    feed(r.summary, r.n * S_STRIDE);
    feed(r.crossings, r.nCross * C_STRIDE);
    return (h >>> 0).toString(16).padStart(8, '0');
}
CASES.T14 = {
    project: vmiProject,
    run(level, ctx) {
        const resolved = resolveP(vmiProject(level));
        const solved = solveP(resolved);
        const field = fieldP(resolved, solved);
        const n = resolved.particleCount;
        const ref = traceP(resolved, field, { i0: 0, i1: n, total: n });
        const checks = [];
        for (const chunk of [1, 7, 64]) {
            const parts = [];
            for (let a = 0; a < n; a += chunk) parts.push(traceP(resolved, field, { i0: a, i1: Math.min(n, a + chunk), total: n }));
            // merge in a shuffled order: mergeResults must restore index order
            const merged = mergeResults(parts.slice().reverse());
            checks.push(check(`Chunks of ${chunk} vs one chunk`, sameResult(ref, merged) ? 'identical' : 'different', 'identical', 'bracket'));
            progress(ctx, 0.25 + 0.25 * checks.length, `T14 chunks of ${chunk}`);
        }
        return { checks, details: { particles: n, detected: statusCount(ref, STATUS.DETECTED), digest: resultDigest(ref), steps: ref.stats.steps } };
    },
};

function t15Project(which) {
    const common = { cell: 0.5, x: [-25, 25], y: [-12, 12], tracer: tracer({ rtol: 1e-10 }) };
    if (which === 'a') {
        return proj('T15 (a) Ray onto a plate inclined at 30°', 'planar2d', { ...common,
            shapes: [{ type: 'box', electrode: 'gnd', x0: -1, x1: 1, y0: -5, y1: 5, transform: { translate: [0, 0], rotate: 30, about: [0, 0], mirror: 'none' } }],
            sources: [source('b1', { species: [sp('m 100', 100)], position: pt(-20, 1), direction: dir(1, 0), energy: mono(1000) })] });
    }
    if (which === 'b') {
        return proj('T15 (b) 0.2-cell plate at 45°, 100 random rays', 'planar2d', { ...common,
            shapes: [{ type: 'box', electrode: 'gnd', x0: -0.05, x1: 0.05, y0: -10, y1: 10, transform: { translate: [0, 0], rotate: 45, about: [0, 0], mirror: 'none' } }],
            sources: [source('b1', { species: [sp('m 100', 100)], position: { type: 'line', p0: [-20, -4, 0], p1: [-20, 4, 0] }, direction: fan([1, 0, 0], -5, 5, 1), energy: mono(1000), sampling: 'random', count: 100, seed: 15 })] });
    }
    return proj('T15 (c) Zero-thickness line, 10⁴ random rays', 'planar2d', { ...common,
        shapes: [{ type: 'polyline', electrode: 'gnd', points: [[0, -6], [2, 6]] }],
        sources: [source('b1', { species: [sp('m 100', 100)], position: { type: 'line', p0: [-10, -5, 0], p1: [-10, 5, 0] }, direction: fan([1, 0, 0], -5, 5, 1), energy: mono(1000), sampling: 'random', count: 10000, seed: 16 })],
        store: false });
}
CASES.T15 = {
    project: () => t15Project('a'),
    run(level, ctx) {
        const ra = runAll(t15Project('a')).result;
        const xa = (-1 - 1 * Math.sin(30 * DEG)) / Math.cos(30 * DEG);
        const dA = ra.summary[S_STATUS] === STATUS.HIT ? Math.hypot(ra.summary[S_X] - xa, ra.summary[S_Y] - 1) : NaN;
        const rb = runAll(t15Project('b')).result;
        progress(ctx, 0.3, 'T15 (b)');
        const rc = runAll(t15Project('c'), { overrides: { record: { trajectories: false } } }).result;
        return {
            checks: [
                check('(a) distance of the hit from the analytic intersection', dA, 0, 'abs', 1e-8, 'mm'),
                check('(b) misses among 100 random rays on a 0.2-cell plate at 45°', rb.n - statusCount(rb, STATUS.HIT), 0, 'bracket', [0, 0], ''),
                check('(c) misses among 10⁴ random rays on a zero-thickness line', rc.n - statusCount(rc, STATUS.HIT), 0, 'bracket', [0, 0], ''),
            ],
            details: { a: { x: ra.summary[S_X], y: ra.summary[S_Y], ref: [xa, 1] }, b: rb.n, c: rc.n, cSteps: rc.stats.steps },
        };
    },
};

// ---------------------------------------------------------------- L: lens properties
const KE_LEFT = 1000;
const lensTrace = (resolved, field) => async (parts, opts) => traceP(resolved, field, { particles: parts, overrides: opts });
const lensSpec = (resolved, side = 'both', extra = {}) => {
    const d = resolved.domain, h = d.h, x0 = d.x[0], x1 = d.x[1];
    return { refX: 0, D: 2, xStart: x0 + 2 * h, xEnd: x1 - 2 * h, mass: 100, charge: 1, keLeft: KE_LEFT, side, relativistic: false, rtol: 1e-11, maxStepCells: 0.5, ...extra };
};
const lensOf = (x0, x1, h, side = 'both') => ({ refX: 0, D: 2, xStart: x0 + 2 * h, xEnd: x1 - 2 * h, mass: 100, charge: 1, keLeft: KE_LEFT, heights: [0.02, 0.03, 0.04, 0.05, 0.06, 0.08], side });
/** Electrode voltage giving a kinetic-potential ratio V2/V1 for 1000 eV ions (+1 e) entering at 0 V. */
const vForRatio = (ratio) => -(ratio - 1) * KE_LEFT;

function l1Project(level, ratio = 5) {
    const R = level === 'full' ? 64 : 32, h = 1 / R;
    return proj(`L1 Two-tube lens, zero gap, V2/V1 = ${ratio}`, 'cyl2d', {
        cell: h, x: [-8, 8], y: [0, 1],
        edges: { xmin: ED('gnd'), xmax: ED('B'), ymax: profile([seg(-8, 0, 'gnd'), seg(0, 8, 'B')]) },
        electrodes: [el('B', vForRatio(ratio), { name: 'Tube 2' })],
        lens: lensOf(-8, 8, h),
        notes: 'R = 1 mm (D = 2 mm); 1000 eV ions of 100 u; tube 2 at −(V2/V1 − 1)·1000 V.',
    });
}
async function lensVariants(base, makeVariant, ratios, side, solvedIn = null) {
    const r0 = resolveP(base);
    const solved = solvedIn || solveP(r0);
    const out = [];
    for (const ratio of ratios) {
        const resolved = resolveP(makeVariant(ratio));
        const field = fieldP(resolved, solved);
        const lp = await lensProperties(lensSpec(resolved, side), field.model, lensTrace(resolved, field));
        out.push({ ratio, lp });
    }
    return { solved, resolved: r0, out };
}
const lensRaw = (lp) => ({ F1: lp.F1, F2: lp.F2, f1: lp.f1, f2: lp.f2, H1: lp.H1, H2: lp.H2, identity: lp.identity, warnings: lp.warnings.map((w) => w.code) });
CASES.L1 = {
    project: (level) => l1Project(level, 5),
    async run(level, ctx) {
        const full = level === 'full', tol = full ? 3e-4 : 1e-3, tolId = full ? 5e-5 : 3e-4;
        const { resolved, solved, out } = await lensVariants(l1Project(level, 5), (r) => l1Project(level, r), [2, 5, 10, 20], 'both');
        const checks = [], details = { ...gridInfo(resolved, solved), lens: {} };
        for (const { ratio, lp } of out) {
            const ex = exact.twoTubeExact(ratio);
            for (const k of ['F1', 'F2', 'f1', 'f2']) checks.push(check(`V2/V1 = ${ratio}: ${k}/D`, lp[k], ex[k], 'rel', tol, 'D'));
            checks.push(check(`V2/V1 = ${ratio}: identity |f1/f2|·√(V2/V1) − 1`, lp.identity, 0, 'abs', tolId, ''));
            details.lens[ratio] = lensRaw(lp);
        }
        progress(ctx, 1, 'L1');
        return { checks, details };
    },
};

function l2Project(level, ratio = 9) {
    const R = level === 'full' ? 80 : 40, h = 1 / R;
    return proj(`L2 Einzel lens, zero gap, A/D 0.5, V2/V1 = ${ratio}`, 'cyl2d', {
        cell: h, x: [-8, 8], y: [0, 1],
        edges: { xmin: ED('gnd'), xmax: ED('gnd'), ymax: profile([seg(-8, -0.5, 'gnd'), seg(-0.5, 0.5, 'C'), seg(0.5, 8, 'gnd')]) },
        electrodes: [el('C', vForRatio(ratio), { name: 'Center tube' })],
        lens: lensOf(-8, 8, h, 'right'),
        notes: 'R = 1 mm, A/D = 0.5, zero gaps; 1000 eV ions of 100 u; center tube at −(V2/V1 − 1)·1000 V.',
    });
}
CASES.L2 = {
    project: (level) => l2Project(level, 9),
    async run(level) {
        const tol = level === 'full' ? 2e-4 : 6e-4;
        const ratios = [-0.5, 0, 0.8, 2, 9];
        const { resolved, solved, out } = await lensVariants(l2Project(level, 9), (r) => l2Project(level, r), ratios, 'right');
        const checks = [], details = { ...gridInfo(resolved, solved), lens: {} };
        for (const { ratio, lp } of out) {
            checks.push(check(`V2/V1 = ${ratio}: f/D`, lp.f2, exact.einzelExact(ratio, 0.5).f, 'rel', tol, 'D'));
            details.lens[ratio] = lensRaw(lp);
        }
        return { checks, details };
    },
};

function l3Project(level, ratio = 5) {
    const p = s4Project(level);
    p.meta.name = `L3 Two-tube lens, 0.1D gap (NBS geometry), V2/V1 = ${ratio}`;
    setV(p, 'B', vForRatio(ratio));
    p.analysis.lens = lensOf(-7, 7, p.domain.cell);
    p.meta.notes = 'R = 1 mm (D = 2 mm), 0.1D gap; 1000 eV ions of 100 u; tube 2 at −(V2/V1 − 1)·1000 V.';
    return p;
}
const L3_RATIOS = [2, 5, 10, 20, 40, 100];
function l3Lens(level) {
    return memoAsync(`L3lens:${level}`, async () => {
        const { solved } = s4Solved(level);
        return lensVariants(l3Project(level, 5), (r) => l3Project(level, r), L3_RATIOS, 'both', solved);
    });
}
CASES.L3 = {
    project: (level) => l3Project(level, 5),
    async run(level) {
        const { resolved, solved, out } = await l3Lens(level);
        const ref = T('L3').values, checks = [], details = { ...gridInfo(resolved, solved), lens: {} };
        for (const { ratio, lp } of out) {
            for (const k of ['F1', 'F2', 'f1', 'f2']) {
                const r = ref[ratio][k];
                checks.push(check(`V2/V1 = ${ratio}: ${k}/D`, lp[k], r, 'abs', Math.max(0.0035 * Math.abs(r), 0.003), 'D'));
            }
            details.lens[ratio] = lensRaw(lp);
        }
        return { checks, details, series: [{ label: 'F2*(T), V2/V1 = 5', xLabel: '(T/D)²', yLabel: 'F2*/D', x: out[1].lp.raw.T.map((t) => (t / 2) ** 2), y: out[1].lp.raw.F2s }] };
    },
};
CASES.L4 = {
    project: (level) => l3Project(level, 5),
    async run(level) {
        const { out } = await l3Lens(level);
        const checks = out.map(({ ratio, lp }) => check(`V2/V1 = ${ratio}: |f1/f2|·√(V2/V1) − 1`, lp.identity, 0, 'abs', ratio >= 100 ? 4e-4 : (level === 'full' ? 1e-4 : 2e-4), ''));
        return { checks, details: { identity: Object.fromEntries(out.map(({ ratio, lp }) => [ratio, lp.identity])) } };
    },
};

function l5Project(level, ratio = 9) {
    const h = 1 / 40;
    return proj(`L5 Einzel lens with 0.1D gaps, V2/V1 = ${ratio}`, 'cyl2d', {
        cell: h, x: [-8, 8], y: [0, 1],
        edges: { xmin: ED('gnd'), xmax: ED('gnd'), ymax: profile([seg(-8, -0.6, 'gnd'), ramp(-0.6, -0.4, 'gnd', 'C'), seg(-0.4, 0.4, 'C'), ramp(0.4, 0.6, 'C', 'gnd'), seg(0.6, 8, 'gnd')]) },
        electrodes: [el('C', vForRatio(ratio), { name: 'Center tube' })],
        lens: lensOf(-8, 8, h, 'right'),
        notes: 'Assumed geometry A/D 0.5, G/D 0.1 with linear-ramp gaps (thin walls at r = R).',
    });
}
CASES.L5 = {
    project: (level) => l5Project(level, 9),
    async run(level) {
        const ratios = [-0.5, 0, 0.8, 2, 9], ref = T('L5').values;
        const { out } = await lensVariants(l5Project(level, 9), (r) => l5Project(level, r), ratios, 'right');
        const checks = out.map(({ ratio, lp }) => check(`V2/V1 = ${ratio}: f/D`, lp.f2, ref[ratio], 'rel', 0.02, 'D'));
        return { checks, details: { note: 'Informational; the published geometry is not stated.' } };
    },
};

function l6Project(level, AD, ratio = 10) {
    const R = level === 'full' ? 32 : 16, h = 1 / R, xa = AD;   // A = AD·D, D = 2 → x = ±A/2 = ±AD
    return proj(`L6 Two-aperture lens, A/D ${AD}, V2/V1 = ${ratio}`, 'cyl2d', {
        cell: h, x: [-16, 16], y: [0, 10],
        edges: { xmin: ED('gnd'), xmax: ED('A2'), ymax: profile([seg(-16, -xa, 'gnd'), ramp(-xa, xa, 'gnd', 'A2'), seg(xa, 16, 'A2')]) },
        electrodes: [el('A2', vForRatio(ratio), { name: 'Aperture 2' })],
        shapes: [{ type: 'polyline', electrode: 'gnd', points: [[-xa, 1], [-xa, 10]] }, { type: 'polyline', electrode: 'A2', points: [[xa, 1], [xa, 10]] }],
        lens: lensOf(-16, 16, h, 'right'),
        notes: 'Equal zero-thickness apertures of diameter D = 2 mm; ramp closure at r = 5D.',
    });
}
CASES.L6 = {
    project: (level) => l6Project(level, 0.5, 10),
    async run(level, ctx) {
        const ratios = [0.5, 2, 10, 40, 90], ref = T('L6').values, checks = [];
        for (const AD of [0.5, 1.0]) {
            const { out } = await lensVariants(l6Project(level, AD, 10), (r) => l6Project(level, AD, r), ratios, 'right');
            for (const { ratio, lp } of out) {
                const r = ref[AD === 1 ? '1' : '0.5'][ratio];
                checks.push(check(`A/D ${AD}, V2/V1 = ${ratio}: f2/D`, lp.f2, r, 'bracket', [1.025 * r, 1.065 * r], 'D', { deviation: lp.f2 / r - 1 }));
            }
            progress(ctx, AD === 1 ? 1 : 0.5, `L6 A/D ${AD}`);
        }
        return { checks, details: { note: 'Informational: our zero-thickness model runs +3 to +6% above the table; the difference grows with resolution (a model difference, not an error).' } };
    },
};

function l7Project() {
    return proj('L7 Davisson–Calbick aperture', 'cyl2d', {
        cell: 0.05, x: [-10, 10], y: [0, 10],
        edges: { xmin: ED('gnd'), xmax: ED('R'), ymax: profile([seg(-10, 0, 'gnd'), ramp(0, 10, 'gnd', 'R')]) },
        electrodes: [el('R', -500, { name: 'Accelerating electrode' })],
        shapes: [{ type: 'polyline', electrode: 'gnd', points: [[0, 1], [0, 10]] }],
        sources: [source('b1', { name: 'Paraxial rays', species: [sp('m 100', 100)], position: { type: 'list', points: [[-9.8, 0.05, 0], [-9.8, 0.1, 0], [-9.8, 0.2, 0]] }, direction: dir(1, 0), energy: mono(1000), count: 3 })],
        planes: [plane('before', 'x', -5, { name: 'Before' }), plane('after', 'x', 5, { name: 'After' }), plane('det', 'x', 9.8, { terminate: true, side: 'forward', name: 'End' })],
        tracer: tracer({ rtol: 1e-10 }),
        notes: '1 mm hole in a grounded plate; field-free on the left, 50 V/mm accelerating on the right; 1000 eV ions.',
    });
}
CASES.L7 = {
    project: l7Project,
    run() {
        const { result } = runAll(l7Project());
        const vx = speedFromKE(1000, 100, false), ys = [], fs = [];
        const before = crossings(result, 0), after = crossings(result, 1);
        for (let i = 0; i < 3; i++) {
            const b = before.find((c) => c.id === i), a = after.find((c) => c.id === i);
            if (!a || !b) continue;
            const dvy = a.vy - b.vy;
            ys.push(b.y); fs.push(-b.y * vx / dvy);
        }
        // paraxial limit of f(y) = f0 + c·y²
        let f0 = NaN;
        if (fs.length >= 2) {
            const n = fs.length, u = ys.map((y) => y * y);
            const mu = u.reduce((s, x) => s + x, 0) / n, mf = fs.reduce((s, x) => s + x, 0) / n;
            let suu = 0, suf = 0;
            for (let i = 0; i < n; i++) { suu += (u[i] - mu) ** 2; suf += (u[i] - mu) * (fs[i] - mf); }
            f0 = mf - (suu > 0 ? suf / suu : 0) * mu;
        }
        return { checks: [check('Thin-lens focal length 4V/(E2 − E1)', f0, 80, 'rel', 0.1, 'mm')], details: { heights: ys, f: fs } };
    },
};

// ====================================================================== round 2 (improvement plan §2): K3d, K6b, S11, S12, T8b, T16, T18, T20, L8, L9, D1, D2, I1
/** Angle (degrees) between two plane vectors. */
const angleBetween = (a, b) => Math.atan2(Math.abs(a[0] * b[1] - a[1] * b[0]), a[0] * b[0] + a[1] * b[1]) / DEG;
/** Composite Simpson rule on [a, b] with n (even) intervals. */
function simpson(f, a, b, n) {
    const h = (b - a) / n;
    let s = f(a) + f(b);
    for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * f(a + i * h);
    return s * h / 3;
}
/** Root of f on [lo, hi] (one sign change) by bisection. */
function bisect(f, lo, hi, it = 200) {
    let flo = f(lo);
    for (let k = 0; k < it; k++) {
        const m = 0.5 * (lo + hi), fm = f(m);
        if ((fm > 0) === (flo > 0)) { lo = m; flo = fm; } else hi = m;
    }
    return 0.5 * (lo + hi);
}
/** max |r − r₀| over the stored trajectory of particle i (r about the origin). */
function maxRadialDeviation(result, i, r0) {
    const tr = trajectory(result, i);
    let dr = 0;
    for (let k = 0; k < tr.x.length; k++) dr = Math.max(dr, Math.abs(Math.hypot(tr.x[k], tr.y[k], tr.z[k]) - r0));
    return dr;
}

// ---- K3d: ICR cell, 2000 u at 1 eV in 3 T and 6 T (study B7)
const k3dSetup = (B) => gyroProject(`K3d ICR cell, 2000 u, 1 eV, ${B} T`, { mass: 2000, charge: 1, ke: 1, B, relativistic: false });
CASES.K3d = {
    project: () => k3dSetup(3).project,
    run(level, ctx) {
        const v = T('K3d').values;
        const runs = [3, 6].map((B) => {
            const s = k3dSetup(B), g = gyroFit(s), cy = cyclotron(2000, 1, B, 1, false), cr = crossings(g.result, 0);
            let yMax = 0;
            for (const c of cr) yMax = Math.max(yMax, Math.abs(c.y));
            progress(ctx, B / 6, `K3d ${B} T`);
            return { B, fkHz: 1000 / g.period, r: g.fit.r, cy, yMax, steps: g.steps, markers: g.n, crossings: cr.length };
        });
        const [a, b] = runs;
        return {
            checks: [
                check('Cyclotron frequency at 3 T vs the published 23.03417 kHz', a.fkHz, v.f3, 'rel', 1e-6, 'kHz'),
                check('Cyclotron frequency at 3 T, f = qB/(2πm)', a.fkHz, 1000 * a.cy.freqMHz, 'rel', 1e-9, 'kHz'),
                check('Radius at 3 T, r = mv/(qB)', a.r, a.cy.radiusMM, 'rel', 1e-7, 'mm'),
                check('Frequency ratio 6 T : 3 T', b.fkHz / a.fkHz, 2, 'rel', 1e-9, ''),
                check('Radius ratio 3 T : 6 T', a.r / b.r, 2, 'rel', 1e-7, ''),
                check('Crossings land on the plane x = 0: max |y| at 3 T', a.yMax, 0, 'abs', 1e-8, 'mm'),
            ],
            details: { cell: k3dSetup(3).project.domain.cell, runs: runs.map((q) => ({ B: q.B, fkHz: q.fkHz, r: q.r, steps: q.steps, markers: q.markers, crossings: q.crossings })) },
        };
    },
};

// ---- K6b: hard-edge sector at r = 25 mm, 90°, object 25 mm before the edge (study B10; Liebl eqs. 3.7–3.8)
function k6bSetup(phiDeg = 90, r = 25) {
    const l = r / Math.tan(phiDeg / 2 * DEG), mrad = 0.5e-3 / DEG;
    const ph = phiDeg * DEG, Pe = [r * Math.cos(ph), r * Math.sin(ph)], t = [-Math.sin(ph), Math.cos(ph)], n = [Math.cos(ph), Math.sin(ph)];
    const c = [Pe[0] + 0.5 * l * t[0], Pe[1] + 0.5 * l * t[1]];
    const B = -0.455286 * 100 / r;   // r = 25 mm for 100 u at 1 keV
    const p = proj(`K6b Sector imaging, r = ${r} mm, φ = ${phiDeg}°`, 'planar2d', {
        cell: r / 50, x: [-2 * r, 2 * r], y: [-2 * r, 2 * r],
        magnets: [{ id: 'm1', name: 'Sector', enabled: true, type: 'region', B: [0, 0, B], region: { type: 'annulus', cx: 0, cy: 0, rIn: 0.5 * r, rOut: 1.5 * r, a0: 0, a1: phiDeg } }],
        sources: [source('b1', { name: '0 and ±0.5 mrad', species: [sp('m 100', 100)], position: pt(r, -l), direction: fan([0, 1, 0], -mrad, mrad, 3), energy: mono(1000), count: 3 })],
        planes: [plane('after', 'segment', null, { p0: [c[0] - 0.15 * r * n[0], c[1] - 0.15 * r * n[1]], p1: [c[0] + 0.15 * r * n[0], c[1] + 0.15 * r * n[1]], terminate: true, name: 'After the exit edge' })],
        tracer: tracer(),
    });
    return { project: p, Pe, t, l, B, object: [r, -l] };
}
/** Image of a sector from the exit asymptotes of the first and third ray: point X and distance l′ along the exit tangent. */
function sectorImage(result, s) {
    const cr = crossings(result, 0), A = cr.find((q) => q.id === 0), Bq = cr.find((q) => q.id === 2);
    if (!A || !Bq) return { lp: NaN, X: [NaN, NaN] };
    const det = A.vx * (-Bq.vy) - A.vy * (-Bq.vx);
    const s1 = ((Bq.x - A.x) * (-Bq.vy) - (Bq.y - A.y) * (-Bq.vx)) / det;
    const X = [A.x + s1 * A.vx, A.y + s1 * A.vy];
    return { lp: (X[0] - s.Pe[0]) * s.t[0] + (X[1] - s.Pe[1]) * s.t[1], X };
}
CASES.K6b = {
    project: () => k6bSetup().project,
    run() {
        const s = k6bSetup();
        const { result } = runAll(s.project, { overrides: { debugRegions: true } });
        const { lp, X } = sectorImage(result, s);
        const v = T('K6b').values;
        return {
            checks: [
                check('Image distance l′ after the exit edge', lp, v.l, 'rel', 2e-4, 'mm'),
                check('Barber\'s rule: angle object–center–image', angleBetween(s.object, X), v.barber, 'abs', 1e-3, '°'),
                check('Accepted steps across a magnet edge', result.stats.regionViolations || 0, 0, 'abs', 0, ''),
            ],
            details: { B: s.B, object: s.object, image: X, edgeSplits: result.stats.edgeSplits, steps: result.stats.steps },
        };
    },
};

// ---- S11: tilted plates (study B15): a linear potential reproduced with sub-grid cuts
const S11_SLOPE = 0.05, S11_GAP = 20;
function s11Project(level, boundary = 'subgrid') {
    const s = S11_SLOPE, dy = S11_GAP / Math.cos(Math.atan(s));
    const x0 = 0, x1 = 80, y0 = -5, y1 = 29;
    const lower = (x) => s * x, upper = (x) => s * x + dy;
    return proj(`S11 Tilted plates (${boundary})`, 'planar2d', {
        cell: level === 'full' ? 0.5 : 1, x: [x0, x1], y: [y0, y1], boundary,
        edges: { xmin: profile([seg(y0, lower(x0), 'gnd'), ramp(lower(x0), upper(x0), 'gnd', 'top'), seg(upper(x0), y1, 'top')]),
            xmax: profile([seg(y0, lower(x1), 'gnd'), ramp(lower(x1), upper(x1), 'gnd', 'top'), seg(upper(x1), y1, 'top')]), ymin: ED('gnd'), ymax: ED('top') },
        electrodes: [el('top', 0.1, { name: 'Upper plate (0.1 V)' })],
        shapes: [{ type: 'polygon', electrode: 'gnd', points: [[x0 - 10, lower(x0 - 10)], [x1 + 10, lower(x1 + 10)], [x1 + 10, -30], [x0 - 10, -30]] },
            { type: 'polygon', electrode: 'top', points: [[x0 - 10, upper(x0 - 10)], [x1 + 10, upper(x1 + 10)], [x1 + 10, 60], [x0 - 10, 60]] }],
        notes: 'Plates at slope 0.05 (2.86°), 20 mm apart; the side edges carry the exact linear ramp between the plates.',
    });
}
function s11Error(level, boundary) {
    const s = S11_SLOPE, al = Math.atan(s), dy = S11_GAP / Math.cos(al);
    const resolved = resolveP(s11Project(level, boundary)), solved = solveP(resolved), field = fieldP(resolved, solved);
    const phi = field.channels[0].phi, cls = solved.raster0.cls, nx = resolved.domain.nx, h = resolved.domain.h, x0 = resolved.domain.x[0], y0 = resolved.domain.y[0];
    const exactV = (x, y) => 0.1 * (y - s * x) * Math.cos(al) / S11_GAP;
    let nodal = 0, free = 0;
    for (let k = 0; k < phi.length; k++) {
        if (cls[k] !== -1) continue;
        const i = k % nx, j = (k - i) / nx, x = x0 + i * h, y = y0 + j * h;
        if (y <= s * x || y >= s * x + dy) continue;
        nodal = Math.max(nodal, Math.abs(phi[k] - exactV(x, y))); free++;
    }
    let mid = 0;
    for (let x = 10; x <= 70; x += 0.5) { const y = s * x + 0.5 * dy; mid = Math.max(mid, Math.abs(field.model.potential(0, x, y, 0) - exactV(x, y))); }
    return { nodal, mid, free, cuts: solved.raster0.cuts.count, nodes: resolved.domain.N, cell: h, solves: solveInfo(solved) };
}
CASES.S11 = {
    project: (level) => s11Project(level),
    run(level, ctx) {
        const sub = s11Error(level, 'subgrid');
        progress(ctx, 0.6, 'S11 staircase');
        const st = s11Error(level, 'staircase');
        return {
            checks: [
                check('Sub-grid cuts: max |φ − exact| at the free nodes between the plates', sub.nodal, 0, 'abs', 1e-9, 'V'),
                check('Sub-grid cuts: max |φ − exact| along the mid-plane (interpolated)', sub.mid, 0, 'abs', 1e-9, 'V'),
            ],
            details: { subgrid: sub, staircase: { nodal: st.nodal, mid: st.mid, note: 'For information: a few 1e-3 V near the plates and about 1e-4 V at mid-gap, as in the concept study.' } },
        };
    },
};

// ---- S12: mesh sweep on the Einzel lens (study B14): waist position at cell 0.5, 0.25, 0.125 (0.0625) mm
function s12Project(h) {
    return proj(`S12 Einzel lens, mesh sweep, cell ${h} mm`, 'cyl2d', {
        cell: h, x: [-60, 140], y: [0, 16], beyond: { xmax: 'drift' },
        electrodes: [el('outer', 0, { name: 'Outer tubes' }), el('centre', 850, { name: 'Center tube (850 V)' })],
        shapes: [{ type: 'tube', electrode: 'outer', x0: -55, x1: -6, rIn: 10, rOut: 11 }, { type: 'tube', electrode: 'centre', x0: -4, x1: 4, rIn: 10, rOut: 11 },
            { type: 'tube', electrode: 'outer', x0: 6, x1: 55, rIn: 10, rOut: 11 }],
        sources: [source('b1', { name: 'Parallel beam', species: [sp('m/z 100', 100)], position: { type: 'line', p0: [-52, -3, 0], p1: [-52, 3, 0], n: 21 }, direction: dir(1, 0), energy: mono(1000), count: 21 })],
        planes: [plane('img', 'x', 135, { terminate: true, side: 'forward', name: 'Image plane' })],
        tracer: tracer({ rtol: 1e-10 }),
        notes: 'The geometry of the Einzel preset (D 20 mm, 0.1 D gaps, A/D 0.5, center tube 850 V); DP45 at rtol 1e-10, nonrelativistic.',
    });
}
CASES.S12 = {
    project: () => s12Project(0.25),
    run(level, ctx) {
        const hs = level === 'full' ? [0.5, 0.25, 0.125, 0.0625] : [0.5, 0.25, 0.125];
        const runs = hs.map((h, i) => {
            const { resolved, solved, result } = runAll(s12Project(h));
            const w = waist(planeRows(result, 0, { side: 'forward' }), 'x');
            progress(ctx, (i + 1) / hs.length, `S12 cell ${h}`);
            return { h, waist: w.position, rms: w.rms, detected: statusCount(result, STATUS.DETECTED), nodes: resolved.domain.N, cycles: solveInfo(solved).map((q) => q.cycles) };
        });
        const checks = [], richardson = [];
        for (const r of runs) checks.push(check(`Rays reaching the image plane at cell ${r.h} mm (of 21)`, r.detected, 21, 'bracket', [21, 21], ''));
        for (let i = 2; i < runs.length; i++) {
            const w1 = runs[i - 2].waist, w2 = runs[i - 1].waist, w3 = runs[i].waist, d1 = w2 - w1, d2 = w3 - w2;
            const p = Math.log2(d1 / d2), wR = w2 + d1 / (Math.pow(2, p) - 1);
            checks.push(check(`Observed order of the waist position, cells ${runs[i - 2].h} → ${runs[i - 1].h} → ${runs[i].h} mm`, p, 2, 'bracket', [1.2, 2.5], ''));
            checks.push(check(`Waist at cell ${runs[i].h} mm between the ${runs[i - 1].h} mm value and its Richardson extrapolation (fraction of the way)`, d2 / (wR - w2), 0.5, 'bracket', [0, 1], ''));
            richardson.push({ cells: [runs[i - 2].h, runs[i - 1].h, runs[i].h], order: p, extrapolated: wR, secondOrderEstimate: w2 + d1 / 3 });
        }
        checks.push(check('Waist position at cell 0.25 mm vs the preset expectation 78.9 ± 2 mm', runs[1].waist, Number(T('S12').values.waist), 'abs', 2, 'mm'));
        return { checks, details: { runs, richardson }, series: [{ label: 'Waist position vs cell size', xLabel: 'cell (mm)', yLabel: 'waist x (mm)', x: runs.map((r) => r.h), y: runs.map((r) => r.waist) }] };
    },
};

// ---- T8b: Kepler-orbit family in the spherical capacitor (study B15; Zouros et al. 2007)
const T8B_RADII = [82, 85, 90, 100, 110, 115, 118];
function t8bProject(level, radii = T8B_RADII, relativistic = false) {
    const p = s2Project(level);
    p.meta.name = `T8b Spherical capacitor, tangential electron orbits${relativistic ? ' (relativistic)' : ''}`;
    p.sources = radii.map((r0) => source(`e${r0}`, { name: `e⁻ at r₀ = ${r0} mm`, species: [sp('electron', ME_U, -1)], position: pt(0, r0), direction: dir(1, 0), energy: mono(1e5 / r0) }));
    p.recording.planes = [plane('back', 'x', 0, { terminate: true, side: 'backward', name: 'Return to x = 0 (180°)' })];
    p.tracer = tracer({ rtol: 1e-10, tMax: 0.1, relativistic });
    p.meta.notes = 'S2 field; electrons with KE = 10⁵/r₀ eV launched tangentially at (0, r₀) orbit on circles.';
    return p;
}
/** Inner turning radius of a relativistic electron launched tangentially at r₀ with kinetic energy ke in the S2 field (energy and angular momentum). */
function relativisticApsis(r0, ke) {
    const g0 = 1 + ke / ME_EV, pc0 = Math.sqrt(g0 * g0 - 1) * ME_EV, q = -1;
    const phi = (r) => exact.sphereV(r, { R1: 80, R2: 120, V1: 500, V2: -1000 / 3 });
    const Etot = g0 * ME_EV + q * phi(r0);
    return bisect((r) => (Etot - q * phi(r)) ** 2 - ME_EV * ME_EV - (pc0 * r0 / r) ** 2, 0.98 * r0, r0 - 1e-4);
}
CASES.T8b = {
    project: (level) => t8bProject(level),
    run(level, ctx) {
        const full = level === 'full';
        const { field } = s2Field(level);
        const resolved = resolveP(t8bProject(level));
        const result = traceP(resolved, field, { overrides: { record: { everyStep: true, maxPoints: 1e6 } } });
        progress(ctx, 0.7, 'T8b relativistic orbit');
        const resRel = traceP(resolveP(t8bProject(level, [100], true)), field, { overrides: { record: { everyStep: true, maxPoints: 1e6 } } });
        const tolMid = full ? 2e-3 : 8e-3, tolEdge = full ? 2.5e-3 : 1e-2;
        const checks = [], deviations = {};
        T8B_RADII.forEach((r0, i) => {
            const dr = maxRadialDeviation(result, i, r0);
            deviations[r0] = dr;
            checks.push(check(`r₀ = ${r0} mm: max |r − r₀| over 180°`, dr, 0, 'abs', r0 === 82 || r0 === 118 ? tolEdge : tolMid, 'mm'));
        });
        checks.push(check('Electrons completing the half turn to x = 0 (of 7)', statusCount(result, STATUS.DETECTED), 7, 'bracket', [7, 7], ''));
        const apsis = relativisticApsis(100, 1000), drRel = maxRadialDeviation(resRel, 0, 100);
        checks.push(check('Relativistic orbit at r₀ = 100 mm: inward dip max |r − r₀| vs the closed-form apsis', drRel, 100 - apsis, 'abs', tolMid, 'mm'));
        return {
            checks,
            details: { cell: resolved.domain.h, deviations, steps: T8B_RADII.map((_, i) => result.summary[i * S_STRIDE + S_STEPS]), relativistic: { maxDr: drRel, apsis, shift: 100 - apsis, status: STATUS_NAMES[resRel.summary[S_STATUS]] } },
        };
    },
};

// ---- T16: spherical test surface (study B3): plane kind 'sphere', inside the grid and in the analytic drift
function t16Project(part = 'a') {
    const ke = 100 * 4 / (2 * K_ACC);   // 100 u at exactly 2 mm/µs
    const drift = part === 'b', ext = drift ? 3 : 12;
    return proj(`T16 Spherical test surface (${drift ? 'field-free drift beyond a small grid' : 'inside the grid'})`, 'cyl2d', {
        cell: 0.5, x: [-ext, ext], y: [0, ext], beyond: drift ? { xmin: 'drift', xmax: 'drift', ymax: 'drift' } : {},
        sources: [source('b1', { name: 'Cone of 60° half-angle, 50 rays', species: [sp('m 100', 100)], position: pt(0, 0), direction: { type: 'cone', axis: [1, 0, 0], halfAngle: 60, fill: 'solid', n: 50 }, energy: mono(ke), count: 50 })],
        planes: [{ id: 'sph', name: 'Sphere R = 10.5 mm', kind: 'sphere', at: 10.5, center: [0, 0, 0], limits: null, radius: null, terminate: true, side: 'forward', record: 'first' }],
        tracer: tracer({ rtol: 1e-10, tMax: 20 }),
        notes: 'No electrodes: straight paths at 2 mm/µs; every ray reaches the sphere at 5.25 µs.',
    });
}
CASES.T16 = {
    project: () => t16Project('a'),
    run(level, ctx) {
        const v = T('T16').values, checks = [], details = {};
        for (const part of ['a', 'b']) {
            const { resolved, result } = runAll(t16Project(part));
            const S = result.summary, C = result.crossings;
            let tMin = Infinity, tMax = -Infinity, rDev = 0, notOutward = 0;
            for (let i = 0; i < result.n; i++) {
                const o = i * S_STRIDE;
                tMin = Math.min(tMin, S[o + S_TOF]); tMax = Math.max(tMax, S[o + S_TOF]);
                rDev = Math.max(rDev, Math.abs(Math.hypot(S[o + S_X], S[o + S_Y], S[o + S_Z]) - v.R));
            }
            for (let c = 0; c < result.nCross; c++) if (!(C[c * C_STRIDE + C_DIR] > 0)) notOutward++;
            const where = part === 'a' ? 'inside the grid' : 'in the drift beyond the grid';
            checks.push(check(`(${part}) rays detected on the sphere ${where} (of 50)`, statusCount(result, STATUS.DETECTED), 50, 'bracket', [50, 50], ''));
            checks.push(check(`(${part}) earliest crossing time`, tMin, v.t, 'rel', 1e-9, 'µs'));
            checks.push(check(`(${part}) latest crossing time`, tMax, v.t, 'rel', 1e-9, 'µs'));
            checks.push(check(`(${part}) max |r − R| at the crossings`, rDev, 0, 'abs', 1e-9, 'mm'));
            checks.push(check(`(${part}) crossings not outward`, notOutward, 0, 'bracket', [0, 0], ''));
            details[part] = { nodes: resolved.domain.N, steps: result.stats.steps, crossings: result.nCross };
            progress(ctx, part === 'a' ? 0.5 : 1, `T16 (${part})`);
        }
        return { checks, details };
    },
};

// ---- T18: pseudopotential well depth of the Paul trap (study B6; Dehmelt 1967, March 1997)
const T18_V = 500, T18_F = 1.0, T18_R0SQ = 49.985, T18_Z0SQ = 25;
const t18qz = (m) => 8 * K_ACC * T18_V / (m * (T18_R0SQ + 2 * T18_Z0SQ) * (2 * Math.PI * T18_F) ** 2);
const t18Dz = (m) => t18qz(m) * T18_V / 8;   // eV for a singly charged ion; D̄_r = D̄_z/2
/** Launch plan per (mass, direction): energies as factors of D̄, RF phases, and the factors gated as all trapped / all lost. */
const T18_PLAN = [
    { m: 3000, ax: 'z', factors: [0.8, 0.9, 0.95, 1.0, 1.05, 1.2], n: 8, trapped: 0.8, lost: 1.2 },
    { m: 3000, ax: 'r', factors: [0.8, 0.9, 0.95, 1.0, 1.05, 1.2], n: 8, trapped: 0.8, lost: 1.2 },
    { m: 300, ax: 'z', factors: [0.4, 1.3], n: 16, trapped: 0.4, lost: 1.3 },
    { m: 300, ax: 'r', factors: [0.4, 1.3], n: 16, trapped: 0.4, lost: 1.3 },
    { m: 120, ax: 'z', factors: [0.05, 1.3], n: 16, trapped: 0.05, lost: 1.3 },
    { m: 120, ax: 'r', factors: [0.3, 1.3], n: 16, trapped: 0.3, lost: 1.3 },
];
const t18Depth = (g) => (g.ax === 'z' ? t18Dz(g.m) : t18Dz(g.m) / 2);
function t18Project(level) {
    const nMul = level === 'full' ? 2 : 1;
    return proj('T18 Paul trap, pseudopotential well depth', 'cyl2d', {
        cell: 0.1, x: [0, 15], y: [0, 15], mirror: { x: true },
        edges: { xmin: NEU, xmax: ED('gnd'), ymax: ED('gnd') },
        electrodes: [el('ring', 0, { terms: [{ type: 'cos', amp: T18_V, freq: T18_F, phase: 0 }], name: 'Ring electrode' })],
        shapes: [{ type: 'quadric', electrode: 'ring', A: -2, B: 1, C: T18_R0SQ, cx: 0, cy: 0, clip: [0, 15, 0, 14.5] },
            { type: 'quadric', electrode: 'gnd', A: 2, B: -1, C: 2 * T18_Z0SQ, cx: 0, cy: 0, clip: [0, 15, 0, 15] }],
        sources: T18_PLAN.map((g) => source(`m${g.m}${g.ax}`, { name: `m ${g.m} along ${g.ax} (q_z ${t18qz(g.m).toFixed(3)})`, species: [sp(`m ${g.m}`, g.m)], position: pt(0, 0),
            direction: g.ax === 'z' ? dir(1, 0) : dir(0, 1), energy: { type: 'list', values: g.factors.map((f) => f * t18Depth(g)) },
            time: { type: 'rfPhase', freq: T18_F, n: g.n * nMul }, count: g.factors.length * g.n * nMul })),
        tracer: tracer({ tMax: 120, rfStepsPerPeriod: 64 }),
        notes: 'P9 geometry: hyperbolic ring (r₀ 7.07 mm) and grounded end caps (z₀ 5 mm), ring 500 V at 1 MHz; ions start at the center with energies around the Dehmelt depth D̄_z = q_z V/8, D̄_r = D̄_z/2.',
    });
}
CASES.T18 = {
    project: (level) => t18Project(level),
    run(level) {
        const nMul = level === 'full' ? 2 : 1;
        const { resolved, result } = runAll(t18Project(level));
        const S = result.summary;
        const lostAt = (si, e) => {
            let lost = 0, n = 0;
            for (let i = 0; i < result.n; i++) {
                const o = i * S_STRIDE;
                if (S[o + S_SRC] !== si || Math.abs(S[o + S_KE0] - e) > 1e-9 * e) continue;
                n++;
                if (S[o + S_STATUS] !== STATUS.TMAX) lost++;
            }
            return { lost, n };
        };
        const checks = [], details = { qz: {}, depthEV: {}, lostPerFactor: {}, thresholds: {} }, thr = {};
        T18_PLAN.forEach((g, si) => {
            const D = t18Depth(g), key = `m${g.m} ${g.ax}`, nPh = g.n * nMul;
            details.qz[g.m] = t18qz(g.m); details.depthEV[key] = D;
            const table = g.factors.map((f) => ({ f, ...lostAt(si, f * D) }));
            details.lostPerFactor[key] = table.map((r) => `${r.f} D̄: ${r.lost}/${r.n}`).join(', ');
            const tr = table.find((r) => r.f === g.trapped), lo = table.find((r) => r.f === g.lost);
            checks.push(check(`m ${g.m} (q_z ${t18qz(g.m).toFixed(3)}), KE ${g.trapped} D̄_${g.ax} along ${g.ax}: ions lost (of ${nPh})`, tr.lost, 0, 'bracket', [0, 0], ''));
            checks.push(check(`m ${g.m}, KE ${g.lost} D̄_${g.ax} along ${g.ax}: ions lost (of ${nPh})`, lo.lost, nPh, 'bracket', [nPh, nPh], ''));
            if (g.m === 3000) {
                const fTrapped = Math.max(...table.filter((r) => r.lost === 0).map((r) => r.f)), fLost = Math.min(...table.filter((r) => r.lost === r.n).map((r) => r.f));
                thr[g.ax] = 0.5 * (fTrapped + fLost) * D;
                details.thresholds[key] = { allTrappedUpTo: fTrapped, allLostFrom: fLost, thresholdEV: thr[g.ax] };
                checks.push(check(`Adiabatic ion m 3000: escape threshold along ${g.ax} in units of D̄_${g.ax}`, thr[g.ax] / D, 1, 'bracket', [0.85, 1.05], ''));
            }
        });
        checks.push(check('Adiabatic ion: threshold ratio z : r (D̄_z/D̄_r = 2 for r₀² = 2z₀²)', thr.z / thr.r, 2, 'bracket', [1.8, 2.2], ''));
        return { checks, details: { ...details, nodes: resolved.domain.N, ions: result.n, steps: result.stats.steps } };
    },
};

// ---- T20: orbits in a logarithmic field (study B17; Kingdon 1923)
const T20_K = 3492.34, T20_A = 4, T20_B = 20, T20_KE = T20_K / 2, T20_KE3 = T20_KE - 800;
function t20Project(level) {
    const Va = T20_K * Math.log(T20_B / T20_A);
    return proj('T20 Logarithmic-field orbits', 'planar2d', {
        cell: level === 'full' ? 0.1 : 0.2, x: [0, 22], y: [0, 22], mirror: { x: true, y: true },
        edges: { xmin: NEU, ymin: NEU, xmax: ED('gnd'), ymax: ED('gnd') },
        electrodes: [el('inner', Va, { name: 'Inner cylinder' })],
        shapes: [{ type: 'circle', electrode: 'inner', cx: 0, cy: 0, r: T20_A }, { type: 'annulus', electrode: 'gnd', cx: 0, cy: 0, rIn: T20_B, rOut: 32, a0: 0, a1: 360 }],
        sources: [source('c10', { name: 'Circular orbit at 10 mm', species: [sp('q −1, 1 u', 1, -1)], position: pt(10, 0), direction: dir(0, 1), energy: mono(T20_KE) }),
            source('c15', { name: 'Circular orbit at 15 mm', species: [sp('q −1, 1 u', 1, -1)], position: pt(15, 0), direction: dir(0, 1), energy: mono(T20_KE) }),
            source('p10', { name: 'Bound orbit from 10 mm, 800 eV less', species: [sp('q −1, 1 u', 1, -1)], position: pt(10, 0), direction: dir(0, 1), energy: mono(T20_KE3) })],
        planes: [plane('turn', 'y', 0, { side: 'forward', record: 'all', name: 'Full turns' })],
        tracer: tracer({ rtol: 1e-11, tMax: 0.4 }),
        notes: `k = ${T20_K} V: inner radius 4 mm at ${Va.toFixed(2)} V, outer 20 mm at 0 V; the circular-orbit energy k/2 = ${T20_KE} eV is the same at every radius.`,
    });
}
CASES.T20 = {
    project: t20Project,
    run(level) {
        const full = level === 'full';
        const { resolved, solved, result } = runAll(t20Project(level), { overrides: { record: { everyStep: true, maxPoints: 1e6 } } });
        const S = result.summary, tol = full ? 4e-4 : 1.5e-3;
        const checks = [], details = { ...gridInfo(resolved, solved), orbits: {} };
        const turns = (i) => crossings(result, 0).filter((c) => c.id === i);
        for (const [i, r0] of [[0, 10], [1, 15]]) {
            const cr = turns(i), t720 = cr.length >= 2 ? cr[1].t : Infinity, tr = trajectory(result, i);
            let dr = 0;
            for (let k = 0; k < tr.x.length && tr.t[k] <= t720; k++) dr = Math.max(dr, Math.abs(Math.hypot(tr.x[k], tr.y[k]) - r0));
            checks.push(check(`Circular orbit at ${r0} mm: full turns within 0.4 µs`, cr.length, 2, 'bracket', [2, 4], ''));
            checks.push(check(`Circular orbit at ${r0} mm: max |r − r₀| over 720°`, dr, 0, 'abs', tol, 'mm'));
            details.orbits[r0] = { turns: cr.length, t720, maxDr: dr, steps: S[i * S_STRIDE + S_STEPS] };
        }
        // third ion: apsides from energy and angular-momentum conservation, KE₀(r₀/r)² + k·ln(r/r₀) = KE₀
        const tr = trajectory(result, 2);
        let rMin = Infinity, rMax = 0;
        for (let k = 0; k < tr.x.length; k++) { const r = Math.hypot(tr.x[k], tr.y[k]); rMin = Math.min(rMin, r); rMax = Math.max(rMax, r); }
        const uMin = bisect((u) => T20_KE3 * (1 / (u * u) - 1) + T20_K * Math.log(u), 0.3, 0.999);
        checks.push(check('Bound orbit (946.17 eV from 10 mm): survives 0.4 µs without hitting an electrode', STATUS_NAMES[S[2 * S_STRIDE + S_STATUS]], 'TMAX', 'bracket'));
        checks.push(check('Bound orbit: inner apsis r_min vs the closed form', rMin, 10 * uMin, 'abs', full ? 5e-4 : 2e-3, 'mm'));
        checks.push(check('Bound orbit: outer apsis r_max = launch radius', rMax, 10, 'abs', 2e-4, 'mm'));
        details.orbits.bound = { rMin, rMax, rMinExact: 10 * uMin, turns: turns(2).length, steps: S[2 * S_STRIDE + S_STEPS] };
        return { checks, details };
    },
};

// ---- L8: Newton's rule and spherical aberration of the two-tube lens (study B1; Heddle ch. 1)
const L8_HEIGHTS = [1e-4, 0.01, 0.05, 0.1, 0.2, 0.4], L8_XO = -80, L8_D = 20;
function l8Project(level) {
    const h = level === 'full' ? 0.125 : 0.25;
    return proj(`L8 Two-tube lens (NBS geometry), Newton's rule, cell ${h} mm`, 'cyl2d', {
        cell: h, x: [-90, 70], y: [0, 35], beyond: { xmax: 'drift' },
        edges: { xmin: ED('T1'), xmax: ED('T2'), ymax: profile([seg(-90, -1, 'T1'), ramp(-1, 1, 'T1', 'T2'), seg(1, 70, 'T2')]) },
        electrodes: [el('T1', 0, { name: 'Tube 1' }), el('T2', -4000, { name: 'Tube 2 (−4000 V)' })],
        shapes: [{ type: 'box', electrode: 'T1', x0: -90, x1: -1, y0: 10, y1: 35 }, { type: 'box', electrode: 'T2', x0: 1, x1: 70, y0: 10, y1: 35 }],
        sources: L8_HEIGHTS.map((hD, i) => source(`h${i}`, { name: `Ray aimed at ${hD} D`, species: [sp('Ar⁺', 39.962)], position: pt(L8_XO, 0), direction: dir(1, hD * L8_D / -L8_XO), energy: mono(1000) })),
        planes: [plane('axis', 'y', 0, { terminate: true, side: 'backward', name: 'Axis crossing (image)' })],
        tracer: tracer({ rtol: 1e-11 }),
        lens: { refX: 0, D: L8_D, xStart: -89.5, xEnd: 69.5, mass: 39.962, charge: 1, keLeft: 1000, heights: [0.02, 0.03, 0.04, 0.05, 0.06, 0.08], side: 'both' },
        notes: 'The two-tube preset: D 20 mm, 0.1 D deep gap, V2/V1 = 5 for 1000 eV Ar⁺; an axial object at x = −80 mm is imaged beyond the grid (field-free drift).',
    });
}
CASES.L8 = {
    project: l8Project,
    async run(level, ctx) {
        const p = l8Project(level);
        const resolved = resolveP(p), solved = solveP(resolved), field = fieldP(resolved, solved);
        const lp = await lensProperties({ ...p.analysis.lens, relativistic: false, rtol: 1e-11, maxStepCells: 0.5 }, field.model, lensTrace(resolved, field));
        progress(ctx, 0.6, 'L8 rays');
        const result = traceP(resolved, field, { overrides: { record: { trajectories: false } } });
        const S = result.summary, mm = lp.raw.mm, pObj = L8_XO - mm.F1;
        const xi = L8_HEIGHTS.map((_, i) => {
            const o = rowsWhere(result, (SS, oo) => SS[oo + S_SRC] === i)[0];
            return o === undefined || S[o + S_STATUS] !== STATUS.DETECTED ? NaN : S[o + S_X];
        });
        const ratio = xi.map((x) => pObj * (x - mm.F2) / (mm.f1 * mm.f2));
        let outOfOrder = 0;
        for (let i = 1; i < xi.length; i++) if (!(xi[i] < xi[i - 1])) outOfOrder++;
        const ref = T('L3').values[5];
        return {
            checks: [
                check('Rays reaching the axis crossing (of 6)', statusCount(result, STATUS.DETECTED), 6, 'bracket', [6, 6], ''),
                check('Newton\'s rule pq/(f1 f2) for the ray at 1e-4 D', ratio[0], 1, 'abs', 2e-4, ''),
                check('Newton\'s rule pq/(f1 f2) for the ray at 0.01 D', ratio[1], 1, 'abs', 2e-3, ''),
                check('Image position decreases with ray height (spherical aberration): pairs out of order', outOfOrder, 0, 'bracket', [0, 0], ''),
                check('Aberration scales as h²: (1 − ratio at 0.1 D)/(1 − ratio at 0.05 D)', (1 - ratio[3]) / (1 - ratio[2]), 4, 'bracket', [3.6, 4.3], ''),
            ],
            details: { ...gridInfo(resolved, solved), cardinalMm: mm, identity: lp.identity, heightsD: L8_HEIGHTS, imageX: xi, newtonRatio: ratio,
                newtonImage: mm.F2 + mm.f1 * mm.f2 / pObj, newtonImageDiChio: (ref.F2 + ref.f1 * ref.f2 / (L8_XO / L8_D - ref.F1)) * L8_D },
            series: [{ label: 'Image position vs ray height', xLabel: 'height (D)', yLabel: 'x_i (mm)', x: L8_HEIGHTS, y: xi }],
        };
    },
};

// ---- L9: weak-lens (Picht) formula for the einzel lens (plan §2.2)
function l9Project(level, ratio = 1.05) {
    const R = level === 'full' ? 80 : 40, h = 1 / R;
    return proj(`L9 Einzel lens, A/D 0.5, G/D 0.1, V2/V1 = ${ratio}`, 'cyl2d', {
        cell: h, x: [-8, 8], y: [0, 1],
        edges: { xmin: ED('gnd'), xmax: ED('gnd'), ymax: profile([seg(-8, -0.6, 'gnd'), ramp(-0.6, -0.4, 'gnd', 'C'), seg(-0.4, 0.4, 'C'), ramp(0.4, 0.6, 'C', 'gnd'), seg(0.6, 8, 'gnd')]) },
        electrodes: [el('C', vForRatio(ratio), { name: 'Center tube' })],
        lens: lensOf(-8, 8, h, 'right'),
        notes: 'R = 1 mm, A/D 0.5, G/D 0.1 with linear-ramp gaps (thin walls at r = R); weak excitation.',
    });
}
/** Weak-lens (Picht) focal length in units of D from an axial kinetic potential V(ζ) and its derivative on ζ = z/R: 1/f = (3/16)∫(V′/V)² dz. */
function weakLensF(V, dV) {
    const I = simpson((z) => { const d = dV(z) / V(z); return d * d; }, -7.9, 7.9, 3160);
    return 16 / (3 * I) / 2;
}
CASES.L9 = {
    project: (level) => l9Project(level, 1.05),
    async run(level, ctx) {
        const base = resolveP(l9Project(level, 1.05)), solved = solveP(base);
        const checks = [], details = { ...gridInfo(base, solved), lens: {} }, e4 = new Float64Array(4);
        for (const ratio of [1.05, 1.1]) {
            const resolved = resolveP(l9Project(level, ratio)), field = fieldP(resolved, solved);
            const lp = await lensProperties(lensSpec(resolved, 'right'), field.model, lensTrace(resolved, field));
            const Vs = (z) => { field.model.E(0, z, 0, 0, e4); return KE_LEFT - e4[3]; };
            const dVs = (z) => { field.model.E(0, z, 0, 0, e4); return e4[0]; };
            const fSolved = weakLensF(Vs, dVs);
            const dz = 1e-4;
            const fBessel = weakLensF((z) => exact.einzelAxial(z, ratio, 0.5), (z) => (exact.einzelAxial(z + dz, ratio, 0.5) - exact.einzelAxial(z - dz, ratio, 0.5)) / (2 * dz));
            const strong = ratio > 1.07;
            checks.push(check(`V2/V1 = ${ratio}: f/D vs the weak-lens integral on the zero-gap Bessel-series potential`, lp.f2, fBessel, 'rel', strong ? 3.5e-2 : 2.5e-2, 'D'));
            checks.push(check(`V2/V1 = ${ratio}: f/D vs the weak-lens integral on the solved axial potential`, lp.f2, fSolved, 'rel', strong ? 2e-3 : 1.5e-3, 'D'));
            details.lens[ratio] = { ...lensRaw(lp), weakLensSolved: fSolved, weakLensBessel: fBessel, exactZeroGap: exact.einzelExact(ratio, 0.5).f };
            progress(ctx, strong ? 1 : 0.5, `L9 ratio ${ratio}`);
        }
        return { checks, details };
    },
};

// ---- D1: mobility-limited drag (study B18; Mason & McDaniel 1988)
const D1_K = 2, D1_M = 100, D1_E = 24, D1_KMOB = 1e-4 * D1_K, D1_TAU = D1_KMOB * D1_M / K_ACC;
function d1Project(which = 'field') {
    const drag = (gasVelocity) => ({ type: 'stokes', mobility: D1_K, gasVelocity });
    if (which === 'field') {
        return proj('D1 Mobility drag in a uniform field', 'planar2d', {
            cell: 0.5, x: [0, 10], y: [-2, 2],
            edges: { xmin: ED('plate'), xmax: ED('gnd'), ymin: NEU, ymax: NEU },
            electrodes: [el('plate', 240, { name: 'Plate 240 V (24 V/mm)' })],
            sources: [source('b1', { name: 'From rest', species: [sp('m 100', 100)], position: pt(1, 0), direction: dir(1, 0), energy: mono(0) })],
            tracer: { ...tracer({ rtol: 1e-10, tMax: 50 * D1_TAU }), drag: drag([0, 0, 0]) },
            notes: 'K = 2 cm²/(V s): τ = Km/q = 2.07e-4 µs; terminal velocity KE = 4.8e-3 mm/µs.',
        });
    }
    const nTau = which === 'gas20' ? 20 : 5;
    return proj(`D1 Drag toward a gas moving at 100 mm/µs (${nTau}τ)`, 'planar2d', {
        cell: 0.5, x: [-5, 5], y: [-2, 2],
        sources: [source('b1', { name: 'From rest', species: [sp('m 100', 100)], position: pt(0, 0), direction: dir(1, 0), energy: mono(0) })],
        tracer: { ...tracer({ rtol: 1e-10, tMax: nTau * D1_TAU }), drag: drag([100, 0, 0]) },
        notes: 'Grounded box, no field: the ion relaxes to the gas velocity as 1 − exp(−t/τ).',
    });
}
CASES.D1 = {
    project: () => d1Project('field'),
    run(level, ctx) {
        const f = runAll(d1Project('field')).result.summary;
        progress(ctx, 0.4, 'D1 moving gas');
        const g5 = runAll(d1Project('gas5')).result.summary, g20 = runAll(d1Project('gas20')).result.summary;
        const vt = D1_KMOB * D1_E, dRelax = vt * D1_TAU;
        return {
            checks: [
                check('Terminal velocity v_t = KE after 50τ', f[S_VX], vt, 'rel', 1e-6, 'mm/µs'),
                check('Relaxation distance v_t·t − Δx = (m/q)EK²', vt * 50 * D1_TAU - (f[S_X] - 1), dRelax * (1 - Math.exp(-50)), 'rel', 1e-6, 'mm'),
                check('Speed after 5τ toward a gas at 100 mm/µs: v_gas(1 − e⁻⁵)', g5[S_VX], 100 * (1 - Math.exp(-5)), 'rel', 1e-8, 'mm/µs'),
                check('Speed after 20τ: the gas speed', g20[S_VX], 100, 'rel', 1e-6, 'mm/µs'),
            ],
            details: { tau: D1_TAU, vt, relaxationDistance: dRelax, steps: [f[S_STEPS], g5[S_STEPS], g20[S_STEPS]], status: [f, g5, g20].map((S) => STATUS_NAMES[S[S_STATUS]]) },
        };
    },
};

// ---- D2: ion-mobility drift cell (study B20; Gillig et al. 2000)
const D2_K0 = 4.31, D2_K = D2_K0 * (760 / 1) * (298 / 273.15), D2_M = 720, D2_E = 5, D2_KMOB = 1e-4 * D2_K, D2_TAU = D2_KMOB * D2_M / K_ACC;
function d2Project(tMax = 60) {
    return proj(`D2 Ion-mobility drift cell (${tMax} µs)`, 'planar2d', {
        cell: 1, x: [0, 160], y: [-5, 5],
        edges: { xmin: ED('plate'), xmax: ED('gnd'), ymin: NEU, ymax: NEU },
        electrodes: [el('plate', 800, { name: 'Plate 800 V (5 V/mm)' })],
        sources: [source('b1', { name: 'From rest', species: [sp('m 720', 720)], position: pt(2, 0), direction: dir(1, 0), energy: mono(0) })],
        tracer: { ...tracer({ rtol: 1e-10, tMax }), drag: { type: 'stokes', mobility: D2_K, gasVelocity: [0, 0, 0] } },
        notes: 'K = K₀(760/p)(T/273.15) = 3573.6 cm²/(V s) at 1 torr and 298 K (K₀ 4.31); damping q/(mK) = 0.375 µs⁻¹.',
    });
}
CASES.D2 = {
    project: () => d2Project(60),
    run(level, ctx) {
        const v = T('D2').values;
        const S60 = runAll(d2Project(60)).result.summary;
        progress(ctx, 0.5, 'D2 2 µs');
        const S2 = runAll(d2Project(2)).result.summary;
        const vt = D2_KMOB * D2_E, damping = 1 / D2_TAU;
        const dampMeasured = -Math.log(1 - S2[S_VX] / vt) / 2;
        return {
            checks: [
                check('Reduced mobility K₀ 4.31 → K at 1 torr, 298 K', D2_K, v.K, 'digits', null, 'cm²/(V·s)'),
                check('Drift velocity KE after 60 µs', S60[S_VX], v.vt, 'digits', null, 'mm/µs'),
                check('Drift velocity after 60 µs vs the closed form', S60[S_VX], vt * (1 - Math.exp(-60 / D2_TAU)), 'rel', 1e-6, 'mm/µs'),
                check('Damping constant q/(mK) from the velocity after 2 µs', dampMeasured, v.damping, 'digits', null, '1/µs'),
                check('Damping constant vs the closed form', dampMeasured, damping, 'rel', 1e-8, '1/µs'),
            ],
            details: { K: D2_K, tau: D2_TAU, vt, x60: S60[S_X], steps: [S60[S_STEPS], S2[S_STEPS]] },
        };
    },
};

// ---- I1 (informational): octupole ion guide with round rods (study B5; Gerlich 1992)
const I1_R0 = 4, I1_ROD = 0.355 * I1_R0, I1_RC = I1_R0 + I1_ROD;
function i1Project() {
    return proj('I1 Octupole ion guide, round rods', 'planar2d', {
        cell: I1_R0 / 40, x: [0, 9], y: [0, 9], mirror: { x: true, y: true },
        edges: { xmin: NEU, ymin: NEU, xmax: ED('gnd'), ymax: ED('gnd') },
        electrodes: [el('pos', 1, { name: '+V rods' }), el('neg', -1, { name: '−V rods' })],
        shapes: [{ type: 'circle', electrode: 'pos', cx: I1_RC, cy: 0, r: I1_ROD }, { type: 'circle', electrode: 'neg', cx: I1_RC * Math.SQRT1_2, cy: I1_RC * Math.SQRT1_2, r: I1_ROD },
            { type: 'circle', electrode: 'pos', cx: 0, cy: I1_RC, r: I1_ROD }],
        notes: 'r₀ = 4 mm; eight rods of radius 0.355 r₀ at 1.355 r₀ (three in the quarter with mirrors), alternately ±1 V; grounded enclosure at 9 mm.',
    });
}
CASES.I1 = {
    project: i1Project,
    run() {
        const resolved = resolveP(i1Project()), solved = solveP(resolved), field = fieldP(resolved, solved);
        /** Fourier projection of the solved potential on the circle r = frac·r₀ and the largest deviation from the ideal octupole. */
        const coef = (frac) => {
            const r = frac * I1_R0, n = 720, A = new Map();
            let eMax = 0;
            for (let i = 0; i < n; i++) {
                const th = 2 * Math.PI * i / n, x = r * Math.cos(th), y = r * Math.sin(th);
                const phi = field.model.potential(0, x, y, 0);
                eMax = Math.max(eMax, Math.abs(phi - (x ** 4 + y ** 4 - 6 * x * x * y * y) / I1_R0 ** 4));
                for (const m of [0, 4, 8, 12, 20]) A.set(m, (A.get(m) || 0) + phi * Math.cos(m * th) * (m ? 2 : 1) / n);
            }
            const norm = (m) => A.get(m) / Math.pow(frac, m);
            return { r, relDev: eMax / Math.pow(frac, 4), A4: norm(4), A12overA4: norm(12) / norm(4), A20overA4: norm(20) / norm(4), A0: A.get(0), A8: norm(8) };
        };
        const c5 = coef(0.5), c8 = coef(0.8);
        return {
            checks: [
                check('max |φ − V(x⁴ + y⁴ − 6x²y²)/r₀⁴| on r = 0.5 r₀, relative to V(r/r₀)⁴', c5.relDev, 0, 'abs', 0.01, ''),
                check('Octupole coefficient A4 (Fourier projection on r = 0.5 r₀)', c5.A4, 1, 'abs', 0.02, ''),
                check('Twelve-pole admixture |A12/A4| (projection on r = 0.8 r₀)', Math.abs(c8.A12overA4), 0, 'abs', 0.02, ''),
            ],
            details: { ...gridInfo(resolved, solved), at05r0: c5, at08r0: c8, note: 'Informational; the study\'s q₄ = 3.59 and η = 0.38 need its unstated V and m.' },
        };
    },
};

// ====================================================================== round 2b: S13 on the Poisson term (operator.js CHARGE_BASIS), after WP-G's handoff H3
function s13Sphere(level) {
    const h = level === 'full' ? 0.125 : 0.25;   // a = 40 / 80 cells per radius
    return proj('S13 Charged sphere in a grounded sphere', 'cyl2d', {
        cell: h, x: [0, 24], y: [0, 24], mirror: { x: true }, edges: { xmin: NEU, xmax: ED('gnd'), ymax: ED('gnd') },
        params: [{ name: 'rho0', value: 1e-6, dim: 'none', note: 'charge density, C/m³' }, { name: 'a', value: 10, dim: 'length', note: 'charged radius' }],
        charge: 'rho0*min(1, floor(a/hypot(x, r)))',
        shapes: [{ type: 'annulus', electrode: 'gnd', cx: 0, cy: 0, rIn: 20, rOut: 28, a0: 0, a1: 360 }],
        notes: 'Uniform charge density 1 µC/m³ inside r = 10 mm, grounded sphere of 20 mm; the Poisson term is sampled at the cell centers.',
    });
}
function s13Box(level) {
    const n = level === 'full' ? 128 : 64;
    return proj('S13 Sinusoidal charge in a grounded box', 'planar2d', {
        cell: 32 / n, x: [0, 32], y: [0, 32],
        params: [{ name: 'rho0', value: 1e-6, dim: 'none' }, { name: 'L', value: 32, dim: 'length' }], charge: 'rho0*sin(180*x/L)*sin(180*y/L)',
        notes: 'ρ₀ sin(πx/L) sin(πy/L) in a grounded 32 mm box: separable closed form.',
    });
}
/** The particular solution of the charge density (every electrode and Dirichlet edge at 0 V) as a field model. */
function s13Field(p) {
    const resolved = resolveP(p);
    const geo = compileGeometry(resolved), H = buildHierarchy(geo, resolved, {});
    const { phi, stats } = solveBasis(H, CHARGE_BASIS, { tol: 1e-12 });
    const grid = createFieldGrid(H[0].raster, geo, { interp: 'cubic' });
    grid.setChannels([phi], [new Float64Array(resolved.electrodes.length)]);
    return { resolved, stats, nodes: H[0].N, model: createFieldModel({ resolved, grid, raster0: H[0].raster, geometry: geo }) };
}
CASES.S13 = {
    project: (level) => s13Sphere(level),
    run(level, ctx) {
        const full = level === 'full', checks = [], e4 = new Float64Array(4);
        const S = s13Field(s13Sphere(level));
        const a = 0.01, R = 0.02, rho0 = 1e-6, Q = 4 / 3 * Math.PI * a ** 3 * rho0, kQ = Q / (4 * Math.PI * EPS0);
        const phiEx = (r) => (r >= a ? kQ * (1 / r - 1 / R) : kQ * (1 / a - 1 / R) + rho0 * (a * a - r * r) / (6 * EPS0));
        const eEx = (r) => (r >= a ? kQ / (r * r) : rho0 * r / (3 * EPS0)) * 1e-3;
        const phi0 = phiEx(0);
        for (const r of [0, 5, 7.5, 12.5, 15, 17.5]) for (const th of [10, 45, 80]) {
            S.model.E(0, r * Math.cos(th * DEG), r * Math.sin(th * DEG), 0, e4);
            checks.push(check(`Sphere: V(r = ${r} mm, polar ${th}°)`, e4[3], phiEx(r * 1e-3), 'abs', (full ? 1e-3 : 2e-3) * phi0, 'V'));
            if (r > 0) checks.push(check(`Sphere: |E(r = ${r} mm, polar ${th}°)|`, Math.hypot(e4[0], e4[1], e4[2]), eEx(r * 1e-3), 'rel', full ? 1e-3 : (r > 10 ? 3e-3 : 2e-3), 'V/mm'));
        }
        progress(ctx, 0.6, 'S13 box');
        const B = s13Field(s13Box(level));
        const phiB = rho0 / (EPS0 * Math.PI * Math.PI * (2 / (0.032 * 0.032)));
        for (const [x, y] of [[16, 16], [8, 8], [8, 24], [24, 12], [4, 28]]) {
            B.model.E(0, x, y, 0, e4);
            checks.push(check(`Box: V(${x}, ${y} mm)`, e4[3], phiB * Math.sin(Math.PI * x / 32) * Math.sin(Math.PI * y / 32), 'abs', (full ? 2.5e-4 : 1e-3) * phiB, 'V'));
        }
        return { checks, details: { sphere: { nodes: S.nodes, path: (S.stats.path || []).join(' → '), phi0 }, box: { nodes: B.nodes, path: (B.stats.path || []).join(' → '), phiMax: phiB } } };
    },
};

// ====================================================================== round 2b: cases on the field-analysis helpers (fieldanalysis.js): P4, T17, T19, I3
// ---- P4: capacitance by Gauss flux on the S1 and S2 fields (promoted from planned)
CASES.P4 = {
    project: (level) => s2Project(level),
    run(level, ctx) {
        const v = T('P4').values;
        const s1 = s1Field(level), s2 = s2Field(level);
        const part1 = FA.chargePartition(s1.solved.raster0), cm1 = FA.capacitanceMatrix(part1, s1.solved.bases);
        progress(ctx, 0.5, 'P4 spheres');
        const part2 = FA.chargePartition(s2.solved.raster0), cm2 = FA.capacitanceMatrix(part2, s2.solved.bases);
        const coax = cm1.C[1 * cm1.n + 1] * 1e12, sph = -cm2.C[1 * cm2.n + 2] * 1e12;
        const coaxRef = 2 * Math.PI * EPS0 / Math.log(2) * 1e12, sphRef = 4 * Math.PI * EPS0 / (1 / 0.08 - 1 / 0.12) * 1e12;
        const volts = [0, 500, -1000 / 3];
        let Q = 0;
        for (let j = 0; j < cm2.n; j++) Q += cm2.C[1 * cm2.n + j] * volts[j];
        const qRef = 4 * Math.PI * EPS0 * (500 + 1000 / 3) / (1 / 0.08 - 1 / 0.12);
        return {
            checks: [
                check('Coaxial cylinders a 10, b 20 mm: capacitance per length 2πε₀/ln(b/a)', coax, coaxRef, 'rel', 1e-4, 'pF/m'),
                check('Coaxial cylinders vs the printed 80.2607 pF/m', coax, v.coax, 'digits', null, 'pF/m'),
                check('Concentric spheres 80/120 mm: mutual capacitance 4πε₀/(1/R₁ − 1/R₂)', sph, sphRef, 'rel', 1e-4, 'pF'),
                check('Concentric spheres vs the printed 26.7036 pF', sph, v.sphere, 'rel', 1e-4, 'pF'),
                check('Charge on the inner sphere at +500 / −333.333 V from C·V', Q, qRef, 'rel', 1e-4, 'C'),
                check('Spheres: reciprocity max |C_ij − C_ji| / max |C|', cm2.asymmetry, 0, 'abs', 1e-9, ''),
                // (the column sums of C vanish by construction of the contours, so they are not checked)
            ],
            details: {
                coax: { cell: s1.resolved.domain.h, C: Array.from(cm1.C), unit: cm1.unit, irregularFaces: part1.faces.irregular, asymmetry: cm1.asymmetry },
                spheres: { cell: s2.resolved.domain.h, C: Array.from(cm2.C), unit: cm2.unit, irregularFaces: part2.faces.irregular, chargeC: Q, studyChargeC: 2.2253e-8 },
            },
        };
    },
};

// ---- T17: round-rod quadrupoles (Dayton et al. 1954; Denison 1971): multipoles on r = 0.5 r₀ and the stability edge
function t17Project(level, { rr = 1.1468 * R0Q, cage = 3.54 * R0Q, V = 0, sources = [], planes = [], tMax = 1000, cell = null } = {}) {
    const h = cell || (level === 'full' ? R0Q / 50 : R0Q / 25), size = cage ? Math.ceil((cage + 1) / h) * h : 24;
    const shapes = [{ type: 'circle', electrode: 'rodsX', cx: R0Q + rr, cy: 0, r: rr }, { type: 'circle', electrode: 'rodsY', cx: 0, cy: R0Q + rr, r: rr }];
    if (cage) shapes.push({ type: 'annulus', electrode: 'gnd', cx: 0, cy: 0, rIn: cage, rOut: cage + 5, a0: 0, a1: 360 });
    return proj(`T17 Round-rod quadrupole (rods ${+(rr / R0Q).toFixed(4)} r₀${cage ? `, cage ${+(cage / R0Q).toFixed(2)} r₀` : ', grounded box'})`, 'planar2d', {
        cell: h, x: [0, size], y: [0, size], mirror: { x: true, y: true },
        edges: { xmin: NEU, ymin: NEU, xmax: ED('gnd'), ymax: ED('gnd') },
        electrodes: [el('rodsX', 0, { terms: V ? [{ type: 'cos', amp: -V, freq: RF_F, phase: 0 }] : null, name: 'x rods' }), el('rodsY', 0, { terms: V ? [{ type: 'cos', amp: V, freq: RF_F, phase: 0 }] : null, name: 'y rods' })],
        shapes, sources, planes, tracer: tracer({ tMax, rfStepsPerPeriod: 64 }),
        notes: 'r₀ = 4 mm, quarter domain with mirrors; round rods approximate the hyperbolic quadrupole field (a₂ ≈ 1.0029 with the Denison cage).',
    });
}
/** Fourier multipoles of the ±1 V rod potential on r = 0.5 r₀. */
function t17Multipoles(level, geom) {
    const resolved = resolveP(t17Project(level, geom)), solved = solveP(resolved);
    const m = FA.multipoleCircle(FA.potentialSampler(FA.voltageEvaluator(solved, resolved, [0, 1, -1])), { cx: 0, cy: 0, R: 0.5 * R0Q, r0: R0Q, nMax: 10, samples: 360 });
    const odd = Math.max(...[1, 3, 4, 5, 7, 8, 9].map((n) => Math.abs(m.a[n])), ...Array.from(m.b).map(Math.abs));
    return { a2: m.a[2], a6: m.a[6], a10: m.a[10], a6overA2: m.a[6] / m.a[2], odd, residual: m.residual, cell: resolved.domain.h, nodes: resolved.domain.N };
}
CASES.T17 = {
    project: (level) => t17Project(level),
    run(level, ctx) {
        const v = T('T17').values;
        const den = t17Multipoles(level, {}), day = t17Multipoles(level, { rr: 1.148 * R0Q, cage: 0 });
        progress(ctx, 0.3, 'T17 stability edge');
        // stability edge in the caged geometry: ions at rest 0.01 r₀ off axis, 16 RF phases, 200 cycles (effective q = a₂·q)
        const qStar = exact.mathieu.edgeA0(), Tp = 1 / RF_F;
        const edge = (qf) => t17Project('quick', { V: exact.qmfVoltages({ massU: 100, r0: R0Q, freqMHz: RF_F, a: 0, q: qf * qStar }).V,
            sources: [source('b1', { name: '0.01 r₀ at rest, 16 RF phases', species: [sp('m 100', 100)], position: pt(0.01 * R0Q, 0), direction: dir(1, 0), energy: mono(0), time: { type: 'rfPhase', freq: RF_F, n: 16 }, count: 16 })],
            planes: [plane('xp', 'x', 0.9 * R0Q, { name: '+0.9 r₀' }), plane('xm', 'x', -0.9 * R0Q, { name: '−0.9 r₀' })], tMax: 200 * Tp });
        const vars = solveVariants(edge(0.99), [edge(0.99), edge(1.01)]);
        const lost = vars.map((vv) => lostCount(traceP(vv.resolved, vv.field, {})));
        return {
            checks: [
                check('Denison rods (1.1468 r₀, cage 3.54 r₀): quadrupole coefficient a₂ on r = 0.5 r₀', den.a2, v.a2, 'abs', 6e-3, ''),
                check('Denison rods: a₂ vs the cell-converged value of this engine (r₀/100 cells)', den.a2, v.a2Converged, 'abs', 5e-4, ''),
                check('Denison rods: 12-pole admixture |a₆/a₂|', Math.abs(den.a6overA2), 0, 'abs', 3e-3, ''),
                check('Denison rods: odd and sine coefficients (fourfold symmetry)', den.odd, 0, 'abs', 1e-9, ''),
                check('Dayton rods (1.148 r₀, no cage): quadrupole coefficient a₂', day.a2, v.a2, 'abs', 6e-3, ''),
                check('Dayton rods: 12-pole admixture |a₆/a₂|', Math.abs(day.a6overA2), 0, 'abs', 3e-3, ''),
                check('Stability edge: ions at nominal q = 0.99 q* beyond 0.9 r₀ or lost (of 16)', lost[0], 0, 'bracket', [0, 0], ''),
                check('Stability edge: ions at nominal q = 1.01 q* lost (of 16)', lost[1], 16, 'bracket', [16, 16], ''),
            ],
            details: { denison: den, dayton: day, qStar, edgeNote: 'The effective Mathieu parameter is a₂·q, so the nominal edge sits at q*/a₂ = 0.9971 q*.' },
        };
    },
};

// ---- T19: induced charge and current (Shockley 1938; Ramo 1939), the study's B8
const T19_B = -4.7688984e-3, T19_KE = 2;
function t19Project() {
    const Tp = 1 / cyclotron(ME_U, -1, Math.abs(T19_B), T19_KE, false).freqMHz;
    return proj('T19 Induced charge and current (Shockley–Ramo)', 'planar2d', {
        cell: 0.25, x: [-3, 3], y: [0, 10], edges: { xmin: NEU, xmax: NEU, ymin: ED('A'), ymax: ED('gnd') },
        electrodes: [el('A', 0, { name: 'Plate A (y = 0, 0 V)' })],
        magnets: [{ id: 'm1', name: 'Uniform B', enabled: true, type: 'uniform', B: [0, 0, T19_B] }],
        sources: [source('e1', { name: 'Electron 1', species: [sp('electron', ME_U, -1)], position: pt(0, 5), direction: dir(1, 0), energy: mono(T19_KE) }),
            source('e2', { name: 'Electron 2, 180° apart', species: [sp('electron', ME_U, -1)], position: pt(0, 3), direction: dir(-1, 0), energy: mono(T19_KE) })],
        planes: [plane('py4', 'y', 4, { record: 'all', name: 'y = 4 (peak-current points)' })],
        markers: Tp / 64, maxPoints: 5000,
        tracer: tracer({ rtol: 1e-11, tMax: 32 * Tp }),
        notes: 'Plates at y = 0 (electrode A, weighting potential 1 − y/10) and y = 10 (ground); 2 eV electrons circle (r = 1 mm) about (0, 4) in −4.7688984 mT ẑ.',
    });
}
CASES.T19 = {
    project: t19Project,
    run() {
        const v = T('T19').values;
        const { resolved, solved, result } = runAll(t19Project());
        const cy = cyclotron(ME_U, -1, Math.abs(T19_B), T19_KE, false), vel = speedFromKE(T19_KE, ME_U, false);
        const ev = FA.weightingPotentials(solved, resolved, [1]), c = ev.channelOf(1);
        const mk = markersOf(result, 0), fit = kasa(mk.x, mk.y);
        const C = result.crossings;
        let qMin = Infinity, qMax = -Infinity, iMin = Infinity, iMax = -Infinity, n = 0;
        for (let k = 0; k < result.nCross; k++) {
            const b = k * C_STRIDE;
            if (C[b + C_ID] !== 0 || C[b + C_KIND] !== 0) continue;
            n++;
            const Q = FA.inducedCharge(ev, c, -1, C[b + C_X], C[b + C_Y], C[b + C_Z]);
            const I = Math.abs(FA.inducedCurrent(ev, c, -1, C[b + C_X], C[b + C_Y], C[b + C_Z], C[b + C_VX], C[b + C_VY], C[b + C_VZ]));
            qMin = Math.min(qMin, Q); qMax = Math.max(qMax, Q); iMin = Math.min(iMin, I); iMax = Math.max(iMax, I);
        }
        const qRef = 0.6 * E_CHARGE, iRef = E_CHARGE * vel * 1e3 * 100;   // q·v·E_w with v in m/s and E_w = 1/(10 mm) = 100 /m
        const ind = FA.inducedFromResult(ev, c, result, resolved, { source: 'markers' });
        const Qt = ind.total.charge, It = ind.total.current;
        let qlo = Infinity, qhi = -Infinity, iTot = 0, qMean = 0;
        for (let k = 0; k < Qt.length; k++) { qlo = Math.min(qlo, Qt[k]); qhi = Math.max(qhi, Qt[k]); iTot = Math.max(iTot, Math.abs(It[k])); qMean += Qt[k] / Qt.length; }
        const spec = FA.spectrum(ind.particles[0].t, ind.particles[0].charge);
        return {
            checks: [
                check('Orbit radius (Kåsa fit of the markers)', fit.r, '1.000', 'digits', null, 'mm'),
                check('Orbit radius vs r = mv/(qB)', fit.r, cy.radiusMM, 'rel', 1e-7, 'mm'),
                check('Speed of the 2 eV electron vs the published 838.76201 mm/µs', vel, v.v, 'rel', 1e-5, 'mm/µs'),
                check('Induced charge on A at y = 4: smallest of the crossings vs 0.6 e', qMin, qRef, 'rel', 1e-9, 'C'),
                check('Induced charge on A at y = 4: largest of the crossings vs 0.6 e', qMax, qRef, 'rel', 1e-9, 'C'),
                check('Induced charge vs the published 9.61306401e-20 C', qMax, v.Q, 'rel', 1e-5, 'C'),
                check('Peak induced current q·v·E_w: smallest of the crossings', iMin, iRef, 'rel', 1e-8, 'A'),
                check('Peak induced current q·v·E_w: largest of the crossings', iMax, iRef, 'rel', 1e-8, 'A'),
                check('Peak induced current vs the published 1.3438459e-11 A', iMax, v.i, 'rel', 1e-5, 'A'),
                check('Two electrons 180° apart: total induced charge constant, (max − min)/mean', (qhi - qlo) / qMean, 0, 'abs', 1e-6, ''),
                check('Two electrons 180° apart: total induced current / one electron\'s peak', iTot / iRef, 0, 'abs', 1e-5, ''),
                check('Spectrum of one electron\'s induced charge peaks at the cyclotron frequency', spec.peak.freq, cy.freqMHz, 'rel', 1e-6, 'MHz'),
            ],
            details: { crossingsAtY4: n, markers: mk.x.length, period: 1 / cy.freqMHz, center: [fit.cx, fit.cy], totalChargeMeanC: qMean, markerSamples: ind.total.n, steps: result.stats.steps,
                note: 'References from CODATA 2022 constants; the study\'s printed values use older constants (4.5e-6 higher speed and current).' },
        };
    },
};

// ---- I3 (informational): Legendre multipoles of the truncated hyperbolic trap (Barlow et al. 2001)
const I3_R0 = Math.sqrt(49.985);
function i3Project() {
    return proj('I3 Trap multipoles (Legendre coefficients)', 'cyl2d', {
        cell: 0.075, x: [0, 15], y: [0, 15], mirror: { x: true },
        edges: { xmin: NEU, xmax: ED('gnd'), ymax: ED('gnd') },
        electrodes: [el('ring', 1, { name: 'Ring (1 V)' })],
        shapes: [{ type: 'quadric', electrode: 'ring', A: -2, B: 1, C: 49.985, cx: 0, cy: 0, clip: [0, 15, 0, 14.5] }, { type: 'quadric', electrode: 'gnd', A: 2, B: -1, C: 50, cx: 0, cy: 0, clip: [0, 15, 0, 15] }],
        notes: 'The P9 trap (r₀ 7.07, z₀ 5 mm, hyperbolic surfaces to 15 mm) with the ring at 1 V; Legendre coefficients on a sphere of radius 4 mm about the center, normalized to r₀ (ideal: c₀ = 0.5, c₂ = −1).',
    });
}
CASES.I3 = {
    project: i3Project,
    run() {
        const v = T('I3').values;
        const resolved = resolveP(i3Project()), solved = solveP(resolved);
        const m = FA.multipoleSphere(FA.potentialSampler(FA.voltageEvaluator(solved, resolved, [0, 1])), { cx: 0, R: 4, r0: I3_R0, nMax: 8, samples: 64 });
        const odd = Math.max(...[1, 3, 5, 7].map((n) => Math.abs(m.c[n])));
        return {
            checks: [
                check('Quadrupole coefficient c₂ (normalized to r₀) vs the study\'s −1.001', m.c[2], v.C2, 'abs', 3e-3, ''),
                check('Monopole c₀ vs the ideal 0.5', m.c[0], 0.5, 'abs', 5e-3, ''),
                check('Odd coefficients (mirror symmetry)', odd, 0, 'abs', 1e-6, ''),
            ],
            details: { ...gridInfo(resolved, solved), r0: I3_R0, R: 4, c: Array.from(m.c), residual: m.residual,
                study: { C0: 0.49969, C2: -1.00113, C4: 1.05e-3, C6: 1.24e-3, stretched: { C4: -1.52e-2, C6: -6.9e-3 } },
                note: 'Informational: our electrodes follow the hyperbolae to 15 mm, so c₄ and c₆ are 1e-5 and 1e-6 against the study\'s 1e-3 for its (unstated) truncation; compare with Casey\'s run 5.' },
        };
    },
};

// ---------------------------------------------------------------- P2 (gate): two protons from rest 1 µm apart, through the pipeline (tracer.spaceCharge)
const P2_MP = 1.0072764665789;
function p2Project() {
    return proj('P2 Two protons from rest', 'planar2d', {
        cell: 1, x: [-500, 500], y: [-500, 500], store: false,
        sources: [{ id: 'b1', name: 'Two protons', enabled: true, color: 'auto', type: 'rows', weight: 1, species: [], velocity: false,
            rows: [[P2_MP, 1, -0.0005, 0, 0, 1, 0, 0, 0, 0], [P2_MP, 1, 0.0005, 0, 0, 1, 0, 0, 0, 0]] }],
        tracer: { ...tracer({ tMax: 300 }), quality: 'fine', custom: null, spaceCharge: { enabled: true, model: 'coulomb', softening: 1e-7, maxParticles: 2000, factor: 1 } },
        notes: 'Direct pair force (space-charge onset estimator): k e²/(2·1 µm) = 0.719982 meV per proton once far apart.',
    });
}
CASES.P2 = {
    project: () => p2Project(),
    run() {
        const out = runAll(p2Project());
        const S = out.result.summary;
        const xs = [S[S_X], S[S_Y], S[S_Z], S[S_STRIDE + S_X], S[S_STRIDE + S_Y], S[S_STRIDE + S_Z]];
        const U = coulombEnergy(xs, [1, 1], 1e-7), U0 = coulombEnergy([-0.0005, 0, 0, 0.0005, 0, 0], [1, 1], 1e-7);
        return {
            checks: [
                check('Asymptotic energy per proton KE + U/2', (S[S_KE] + U / 2) * 1e3, '0.719982', 'digits', null, 'meV'),
                check('Energy conservation (KE₁ + KE₂ + U)/U₀', (S[S_KE] + S[S_STRIDE + S_KE] + U) / U0, 1, 'rel', 1e-6, ''),
                check('Symmetric separation x₁ + x₂', S[S_X] + S[S_STRIDE + S_X], 0, 'abs', 1e-9, 'mm'),
            ],
            details: { U0meV: U0 * 1e3, x: [S[S_X], S[S_STRIDE + S_X]], steps: out.result.stats.steps, lockstep: out.result.stats.lockstep },
        };
    },
};

// ---------------------------------------------------------------- I2 (info): B12 space-charge beam spread, 1 eV electrons, R₀ 3 mm, tan θ 0.3, 3.47e-13 C over 0.1 µs
function i2Project(level) {
    const N = level === 'full' ? 1000 : 250, eps = level === 'full' ? 0.1 : 0.25, Qtot = 3.47e-13, R0 = 3, F = R0 / 0.3;
    const rows = [];
    for (let i = 0; i < N; i++) {
        const r = R0 * Math.sqrt(uniform01(11, 1, i, 1)), phi = 2 * Math.PI * uniform01(11, 1, i, 2), t0 = 0.1 * uniform01(11, 1, i, 3);
        const y = r * Math.cos(phi), z = r * Math.sin(phi), d = Math.hypot(F, y, z);
        rows.push([ME_U, -1, 0, y, z, F / d, -y / d, -z / d, 1, t0]);
    }
    const planes = [];
    for (let x = 2; x <= 16 + 1e-9; x += 0.5) planes.push(plane('p' + planes.length, 'x', +x.toFixed(3), { side: 'forward' }));
    return proj('I2 Space-charge beam spread (B12)', 'planar2d', {
        cell: 2, x: [-5, 100], y: [-20, 20], store: false, planes,
        sources: [{ id: 'b1', name: 'Converging electron beam', enabled: true, color: 'auto', type: 'rows', weight: 1, species: [], velocity: false, rows }],
        tracer: { ...tracer({ tMax: 2 }), quality: 'normal', custom: null, spaceCharge: { enabled: true, model: 'coulomb', softening: eps, maxParticles: 2000, factor: Qtot / E_CHARGE / N } },
    });
}
CASES.I2 = {
    project: (level) => i2Project(level),
    run(level) {
        const p = i2Project(level);
        const out = runAll(p);
        const nP = p.recording.planes.length;
        const env = [];
        for (let k = 0; k < nP; k++) {
            let n = 0, sy = 0, sz = 0, syy = 0, szz = 0;
            for (let c = 0; c < out.result.nCross; c++) {
                const b = c * C_STRIDE;
                if (out.result.crossings[b + C_KIND] !== 0 || out.result.crossings[b + C_PLANE] !== k) continue;
                const y = out.result.crossings[b + C_Y], z = out.result.crossings[b + C_Z];
                n++; sy += y; sz += z; syy += y * y; szz += z * z;
            }
            env.push(n < 2 ? NaN : Math.sqrt(2 * (syy / n - (sy / n) ** 2 + szz / n - (sz / n) ** 2)));
        }
        let rMin = Infinity, xMin = NaN;
        env.forEach((e, k) => { if (e < rMin) { rMin = e; xMin = p.recording.planes[k].at; } });
        return {
            checks: [check('Minimum envelope radius √2·r_rms (band 1.28 mm ± 25 %)', rMin, 1.28, 'bracket', [0.96, 1.6], 'mm'),
                check('Waist position (before the geometric focus at 10 mm)', xMin, 8, 'bracket', [5, 12], 'mm')],
            details: { envelope: env, planesX: p.recording.planes.map((q) => q.at), laminar: 1.2748 },
            series: [{ label: 'envelope radius', x: p.recording.planes.map((q) => q.at), y: env, xLabel: 'x (mm)', yLabel: 'R (mm)' }],
        };
    },
};

// ---------------------------------------------------------------- I4 (info): hard-sphere mean free path, 200 u (15 Å) at 24 eV in He (2 Å), 4 mTorr, 275 K
const I4_GAS = { enabled: true, model: 'hardSphere', pressure: 4e-3 * 101325 / 760, temperature: 275, mass: 4.002602, diameter: 2, ionDiameter: 15, velocity: [0, 0, 0] };
function i4Project(n = 2000, tMax = 1.3) {
    return proj('I4 Hard-sphere mean free path', 'planar2d', {
        cell: 1, x: [-100, 100], y: [-100, 100], store: false,
        sources: [source('b1', { name: '200 u at 24 eV', species: [sp('200 u', 200)], position: pt(0, 0), direction: dir(1, 0), energy: mono(24), count: n, sampling: 'random' })],
        tracer: { ...tracer({ rtol: 1e-8, tMax }), quality: 'normal', custom: null, gas: I4_GAS },
    });
}
CASES.I4 = {
    project: () => i4Project(),
    run() {
        const m = createGasModel(I4_GAS), spc = m.species(200), v0 = speedFromKE(24, 200, false);
        const lam0 = 1 / spc.nSigma, lamKin = v0 / (spc.nSigma * meanRelativeSpeed(v0, m.cmp));
        const out = runAll(i4Project(2000, 2 * lam0 / v0));
        let path = 0; for (let i = 0; i < out.result.n; i++) path += out.result.summary[i * S_STRIDE + S_PATH];
        const lam = path / out.result.stats.collisions;
        return {
            checks: [check('Mean free path Σpath/Σcollisions vs 1/(nσ) = kT/(π d² p)', lam, lam0, 'rel', 0.05, 'mm'),
                check('… vs the kinetic-theory value v/(nσ⟨g⟩) at 24 eV', lam, lamKin, 'rel', 0.05, 'mm')],
            details: { collisions: out.result.stats.collisions, lambdaFast: lam0, lambdaKinetic: lamKin, n: m.n * 1e9 },
        };
    },
};

// ====================================================================== registry and runner
const ref = (id) => (TARGETS[id] ? { text: TARGETS[id].source.text, url: TARGETS[id].source.url, short: SHORT_REFS[id] || TARGETS[id].source.text } : { text: '', url: '', short: '' });
const lv = (quickSetup, quickTol, fullSetup = quickSetup, fullTol = quickTol) => ({ quick: { setup: quickSetup, tolerance: quickTol }, full: { setup: fullSetup, tolerance: fullTol } });
function B(id, group, title, kind, description, levels, timeoutMs = 60000) {
    return Object.freeze({ id, group, title, kind, description, reference: Object.freeze(ref(id)), levels: Object.freeze(levels), timeoutMs });
}

/** The 64 validation cases: 55 gates (K 11, S 13, T 21, L 6, D 2, P 2), 7 informational (L5–L7, I1–I4), 2 planned (P1, P3). */
export const BENCHMARKS = Object.freeze([
    B('K1', 'K', 'Uniform-field transit', 'gate', 'Planar capacitor x ∈ [0, 10] mm, cell 0.5, 1000 V; 100 u, +1 e from rest and with 10 eV along the field; detector at x = 10; nonrelativistic.', lv('cell 0.5 mm', 'half a unit in the last digit')),
    B('K2', 'K', '1 m drift at 1000 eV', 'gate', 'Grounded box, field-free drift beyond the domain to a detector at x = 1000 mm; four masses; nonrelativistic.', lv('cell 0.5 mm', 'half a unit in the last digit')),
    B('K3', 'K', 'Gyration radius and frequency', 'gate', 'Uniform B; Kåsa circle fit to markers every T/256 and the period from an all-crossings plane: (a) 100 u, 1 keV, 0.5 T; (b) electron, 100 eV, 1 mT, nonrelativistic; (c) the same, relativistic; Boris at 128 steps per gyration on (a).', lv('DP45 rtol 1e-11', 'digits; Boris 2.5e-4 and 1e-6 on the discrete circle')),
    B('K3d', 'K', 'ICR cell: cyclotron frequency and radius', 'gate', 'Uniform 3 T, 2000 u at 1 eV, nonrelativistic: period from the x = 0 crossings and radius from a Kåsa fit of markers every T/256; at 6 T the frequency doubles and the radius halves; the crossings land on the plane.', lv('DP45 rtol 1e-11, cell 0.5 mm', 'rel 1e-6 (printed value), 1e-9 (closed form); landing 1e-8 mm')),
    B('K4', 'K', 'Gyration sense', 'gate', 'B = +z, start at the origin along +x; ion and electron; Dormand–Prince and Boris; the center must be at (0, −r) for the ion and (0, +r) for the electron.', lv('—', 'exact sign')),
    B('K5', 'K', '180° homogeneous-field focus', 'gate', '0.5 T, 100 u, 1 keV, rays at 0 and ±1 mrad, rtol 1e-11; focus angle from the radial separation of the ±1 mrad rays on planes about the center of the central orbit.', lv('—', '±0.005°')),
    B('K6', 'K', 'Hard-edge sector imaging', 'gate', 'Annular sector r 50–150 mm, B = −0.455286 T ẑ, φ = 90° and 60°, object at r/tan(φ/2), ±0.5 mrad; image distance from the intersection of the exit asymptotes; no accepted step may change the region signature.', lv('—', 'rel 2e-4; 0 violations')),
    B('K6b', 'K', 'Sector imaging at r = 25 mm', 'gate', 'Hard-edged 90° sector r 12.5–37.5 mm, B = −1.821144 T ẑ, object 25 mm before the entrance edge, ±0.5 mrad: image 25 mm after the exit edge (l = l′ = r/tan 45°) and Barber\'s rule; no accepted step crosses the magnet edge.', lv('cell 0.5 mm', 'rel 2e-4; 1e-3°; 0 violations')),
    B('K7', 'K', 'RF uniform field', 'gate', 'Capacitor x ∈ [−10, 200] mm, cell 1; plate 21000 V cos(Ωt − 90°) at 1 MHz (E = 100 sin Ωt V/mm); at rest at x = 0; position at 0.5 µs; nonrelativistic.', lv('cell 1 mm', 'half a unit in the last digit')),
    B('K8', 'K', 'Pulse breakpoints', 'gate', 'Same capacitor; trapezoidal pulse 2100 V (t0 0.2, rise 0.1, width 10, fall 0.1 µs); 100 u; position at 1.0 µs; rtol 1e-12; steps land on the pulse corners.', lv('cell 1 mm', 'rel 1e-9')),
    B('K9', 'K', 'Relativistic electron, KE = mₑc²', 'gate', 'Electron with kinetic energy mₑc² in 0.1 T: γ, β and the radius of gyration.', lv('—', 'half a unit in the last digit')),
    B('S1', 'S', 'Coaxial cylinders', 'gate', 'Planar quarter domain [0, 22]² with mirrors; r ≤ 10 mm at 100 V, annulus 20–32 mm at 0 V; potential at 9 points and |E| at r = 15 mm through the field model.', lv('cell 0.2 mm', 'ΔV 3e-3 V; |E| rel 5e-5', 'cell 0.1 mm', 'ΔV 1e-3 V; |E| rel 2e-5')),
    B('S2', 'S', 'Concentric spheres', 'gate', 'Cylindrical domain [0, 125]², mirrored at x = 0; sphere r ≤ 80 mm at +500 V, shell 120–180 mm and far edges at −333.333 V; potential at r 90, 100, 110 mm (polar 10°, 45°, 80°) and |E(100)|.', lv('cell 1 mm', 'ΔV 0.04 V; |E| rel 5e-5', 'cell 0.5 mm', 'ΔV 0.01 V; |E| rel 1.5e-5')),
    B('S3', 'S', 'Two-tube axial potential, zero gap', 'gate', 'R = 1 mm, x ∈ [−8, 8], tube wall as a profile edge (0 V | 1 V, junction node 0.5/0.5); axial potential at z/D 0.1–2.0 against the NBS table.', lv('R/40', 'abs 1.5e-4', 'R/80', 'abs 4e-5')),
    B('S4', 'S', 'Two-tube, 0.1D gap, NBS deep gap', 'gate', 'R = 1 mm, x ∈ [−7, 7], r ∈ [0, 3.5]; boxes x ≤ −0.1 and x ≥ 0.1 for r ≥ 1; top edge closed by a linear ramp over the gap.', lv('R/40', 'abs 2e-4', 'R/80', 'abs 2e-4')),
    B('S5', 'S', 'Observed order, zero-gap einzel', 'gate', 'A/D 0.5, ratio 9; maximum axial error against the exact series (|z/R ∓ 0.5| ≥ 0.06) at R = 20 and 40 (and 80) cells; p = log₂(e_R/e_2R).', lv('R 20, 40', 'p ∈ [1.8, 2.3]', 'R 20, 40, 80', 'p ∈ [1.8, 2.3]')),
    B('S6', 'S', 'Exact on harmonic quadratics', 'gate', 'Curved Shortley–Weller boundaries (circle, annulus sector, polygon, line), a Neumann edge and the axis; boundary values from a harmonic quadratic; multigrid and SOR at tolerance 1e-12.', lv('cell 0.25 mm', '≤ 1e-9 V')),
    B('S7', 'S', 'Superposition', 'gate', 'Three-electrode thin-wall einzel lens with a ramp edge; Σ V_k φ_k against a direct solve for three random voltage sets; tolerance 1e-12.', lv('—', '≤ 1e-9·max|V|')),
    B('S8', 'S', 'Solver agreement', 'gate', 'Thin-wall einzel lens and thin-plate two-aperture lens; forced multigrid, MG-BiCGSTAB and adaptive SOR (tolerance 1e-10) agree.', lv('—', '≤ 1e-9 V/V')),
    B('S9', 'S', 'Thin features, off-lattice multigrid', 'gate', 'Cylindrical 404 × 98 two-aperture fixture: plates 0.3 cell thick between nodes and 1 cell off-lattice; far Dirichlet and Neumann edges off the coarse lattice: cuts on every level, automatic solve without fallback, mean contraction, agreement with SOR.', lv('—', 'contraction ≤ 0.35/cycle; ≤ 1e-9 vs SOR')),
    B('S10', 'S', 'Shortley–Weller order on spheres', 'gate', 'Concentric spheres with the inner radius resolved by 20, 40 (80) cells; maximum error between the spheres; staircase order shown for information.', lv('a = 20, 40 cells', 'p ∈ [1.8, 2.3]', 'a = 20, 40, 80 cells', 'p ∈ [1.8, 2.3]')),
    B('S11', 'S', 'Tilted plates: sub-grid cuts vs staircase', 'gate', 'Two plates at slope 0.05 (2.86°), 20 mm apart at 0 and 0.1 V, closed by exact linear ramps on the side edges: the potential is linear in the distance from the plates. Largest error at the free nodes and along the mid-plane with Shortley–Weller cuts; the staircase error is reported for information.', lv('cell 1 mm', '≤ 1e-9 V', 'cell 0.5 mm', '≤ 1e-9 V')),
    B('S12', 'S', 'Mesh sweep: waist of the Einzel lens', 'gate', 'The Einzel preset geometry (D 20 mm, 0.1 D gaps, center tube 850 V, 21 rays at 1000 eV) solved at cell 0.5, 0.25, 0.125 (and 0.0625) mm: observed order of the waist position ≥ 1.2 and monotone convergence toward the Richardson extrapolation with the observed order.', lv('cells 0.5, 0.25, 0.125 mm', 'order ∈ [1.2, 2.5]; bracket', 'cells 0.5 … 0.0625 mm', 'order ∈ [1.2, 2.5]; bracket'), 120000),
    B('S13', 'S', 'Poisson term: charged sphere and sinusoidal box', 'gate', 'Uniformly charged sphere (a = 10 mm, ρ₀ = 1 µC/m³) inside a grounded sphere (R = 20 mm), cylindrical, mirrored at x = 0: potential at r 0–17.5 mm (polar 10°, 45°, 80°) and |E| against the closed form; ρ₀ sin(πx/L) sin(πy/L) in a grounded 32 mm box against the separable solution. The step density is sampled at the cell centers (first order at the surface), hence 40 and 80 cells per radius.', lv('a = 40 cells; box 64 cells', 'ΔV 2e-3 φ(0); |E| rel 3e-3; box 1e-3 φ_max', 'a = 80 cells; box 128 cells', 'ΔV 1e-3 φ(0); |E| rel 1e-3; box 2.5e-4 φ_max')),
    B('T1', 'T', 'Mirror through a node-aligned mesh', 'gate', 'Parallel-plate mirror entered through a mesh on a node row (cell 0.25 mm), +1000 V back plate 20 mm away, 1000 eV at 30°/45°/60°; range from the return crossing of y = 0, depth from the apex.', lv('cell 0.25 mm', 'half a unit in the last digit')),
    B('T2', 'T', 'Exit-mesh energy', 'gate', '600 V repeller edge, 6 mm gap to a mesh (a) on a node column, (b) zero-thickness between nodes; from rest 5 mm before the mesh; kinetic energy 15 mm after it.', lv('cells 0.25 and 0.28 mm', 'rel 1e-6')),
    B('T3', 'T', 'Wiley–McLaren space focus', 'gate', '100 V/mm source field, mesh exit, s₀ = 5 mm (1 ± 1e-3), detector 2s₀ after the mesh, rtol 1e-12: ∂lnT/∂lns at s₀.', lv('cell 0.25 mm', '≤ 1e-4')),
    B('T4', 'T', 'Reflectron energy focus', 'gate', 'Drift 0–100 mm, mesh at 100 mm, uniform mirror 100–300 mm from ramp edges and a 4000 V back plate (d_pen 50 mm, L 200 mm); KE 1000(1 ± 1e-3) eV: ∂lnT/∂lnK.', lv('cell 0.5 mm', '≤ 1e-4')),
    B('T5', 'T', 'Energy conservation', 'gate', 'Zero-gap einzel lens (A/D 0.5, ratio 9), R = 40 cells; meridional rays r₀ = 0.05–0.5R and two skew rays; endpoint energy error and accumulated work error.', lv('R/40', '≤ 2e-6 of KE')),
    B('T6', 'T', 'Time reversal', 'gate', 'Same lens, rtol 1e-12; each ray reversed at the exit plane and traced back to the start plane.', lv('R/40', '≤ 1e-6·R')),
    B('T7', 'T', '127° cylindrical analyzer', 'gate', 'S1 field; q −1, 1 u, 72.1348 eV on r₀ = 15 mm, nonrelativistic, rtol 1e-11; focus of the ±1 mrad rays on radial planes; radius of the central ray over 127°.', lv('S1 cell 0.2 mm', '±0.003°; |Δr| ≤ 1e-3 mm', 'S1 cell 0.1 mm', '±0.002°; |Δr| ≤ 3e-4 mm')),
    B('T8', 'T', '180° spherical analyzer', 'gate', 'S2 field; q −1, 1 u, 1000 eV on r₀ = 100 mm from (0, 100) along +x; focus of the ±1 mrad rays; radius of the central ray over 180°.', lv('S2 cell 1 mm', '±0.03°; |Δr| ≤ 4e-3 mm', 'S2 cell 0.5 mm', '±0.008°; |Δr| ≤ 1e-3 mm')),
    B('T8b', 'T', 'Kepler orbits in the spherical capacitor', 'gate', 'S2 field; electrons launched tangentially at r₀ 82, 85, 90, 100, 110, 115, 118 mm with 10⁵/r₀ eV, nonrelativistic: constant radius over 180° (every step recorded); the relativistic orbit at r₀ 100 dips inward by the closed-form 0.196 mm.', lv('S2 cell 1 mm', '|Δr| ≤ 8e-3 mm (82 and 118: 1e-2)', 'S2 cell 0.5 mm', '|Δr| ≤ 2e-3 mm (82 and 118: 2.5e-3)')),
    B('T9', 'T', 'Secular frequency, solved quadrupole', 'gate', 'Quarter domain [0, 14]² with mirrors, hyperbolic quadric rods r₀ = 4 mm; RF only at 1.1 MHz; 100 u at rest at x = y = 0.1r₀; markers once per period for 400 periods; β from the stroboscopic recurrence against the Floquet β(q·A₂), A₂ fitted on the solved axis potential; q = 0.2, 0.5, 0.8.', lv('cell 0.1 mm', 'rel 1e-5', 'cell 0.05 mm', 'rel 1e-5'), 120000),
    B('T10', 'T', 'Stability edge, solved quadrupole', 'gate', 'Same rods; 0.05r₀ at rest, 16 RF phases, 200 cycles: q = 0.89 stays below 0.9r₀, q = 0.93 is lost.', lv('cell 0.1 mm', 'bracket'), 120000),
    B('T11', 'T', 'Apex and mass-filter voltages', 'gate', 'Ideal quadrupole; 16 RF phases, 200 cycles: (a, q) = (0.230, 0.706) stable, (0.244, 0.706) unstable; voltages for m/z 100, r₀ 4 mm, 1.1 MHz at q* and at the apex.', lv('—', 'bracket; half a unit in the last digit'), 120000),
    B('T12', 'T', 'Paul-trap cut-off, solved trap', 'gate', 'Hyperbolic ring and end caps (r₀ 7.07, z₀ 5 mm), ring 500 V at 1 MHz; per mass 16 ions at rest 0.1 mm off center along the axis, one per RF phase; 200 cycles: m 120 trapped, m 100 lost.', lv('cell 0.1 mm', 'bracket'), 120000),
    B('T13', 'T', 'Helmholtz pair and single loop', 'gate', 'N 100, 1 A, R 100 mm at x = ±50 mm through loopField and the field model; one loop on its axis 50 mm from the center.', lv('—', 'half a unit in the last digit')),
    B('T14', 'T', 'Determinism', 'gate', 'Velocity-map-imaging lens (360 particles) traced in one chunk and in chunks of 1, 7 and 64 particles, merged in index order: the summary and crossing rows must be bit-for-bit identical.', lv('cell 0.5 mm', 'bitwise', 'cell 0.25 mm', 'bitwise'), 120000),
    B('T15', 'T', 'Hit precision', 'gate', '(a) ray onto a plate inclined at 30°: hit point against the analytic intersection; (b) 0.2-cell plate at 45°, 100 random rays; (c) zero-thickness line, 10⁴ random rays: every hit found.', lv('cell 0.5 mm', '(a) ≤ 1e-8 mm; (b), (c) 0 misses'), 120000),
    B('T16', 'T', 'Spherical test surface', 'gate', 'Field-free cylindrical domain; 50 rays of 100 u at 2 mm/µs in a 60° cone from the origin cross a sphere of radius 10.5 mm at 5.25 µs: (a) inside the grid, (b) in the analytic drift beyond a small grid.', lv('cell 0.5 mm', 'rel 1e-9; |r − R| ≤ 1e-9 mm')),
    B('T17', 'T', 'Round-rod quadrupole: multipoles and stability edge', 'gate', 'Rods of 1.1468 r₀ in a cage of 3.54 r₀ (Denison 1971) and 1.148 r₀ without a cage (Dayton et al. 1954), quarter with mirrors: Fourier coefficients of the ±1 V potential on r = 0.5 r₀ (a₂ within 1 ± 6e-3 and equal to this engine\'s cell-converged 1.00287 ± 5e-4; |a₆/a₂| ≤ 3e-3; no odd or sine terms); in the caged field 16 ions from 0.01 r₀ stay below 0.9 r₀ for 200 cycles at nominal q = 0.99 q* and are all lost at 1.01 q*.', lv('cell r₀/25', 'a₂ ± 6e-3 and ± 5e-4; |a₆/a₂| ≤ 3e-3; bracket', 'cell r₀/50 (edge: r₀/25)', 'a₂ ± 6e-3 and ± 5e-4; |a₆/a₂| ≤ 3e-3; bracket'), 120000),
    B('T18', 'T', 'Paul trap: pseudopotential well depth', 'gate', 'P9 trap; ions from the center along z and r with energies around D̄_z = q_z V/8 and D̄_r = D̄_z/2 over 8–16 RF phases: the adiabatic ion (m 3000, q_z 0.033) escapes between 0.85 and 1.05 D̄ in both directions with a threshold ratio of 2; at q_z 0.33 trapped at 0.4 D̄ and lost at 1.3 D̄; at q_z 0.815 trapped at 0.05 D̄_z and 0.3 D̄_r, lost at 1.3 D̄.', lv('cell 0.1 mm, 8 and 16 phases', 'bracket', 'cell 0.1 mm, 16 and 32 phases', 'bracket'), 180000),
    B('T19', 'T', 'Induced charge and current (Shockley–Ramo)', 'gate', 'Plates at y = 0 (electrode A) and y = 10 mm (ground); a 2 eV electron from (0, 5) along +x circles (r = 1.000 mm) in −4.7688984 mT ẑ: on the crossings of y = 4 (Float64 rows) the induced charge −q·φ_A is 0.6 e and the current q·v·E_w is 1.34385e-11 A, against CODATA 2022 closed forms (rel 1e-9 / 1e-8) and the published figures (rel 1e-5); two electrons 180° apart give a constant total charge and no net current (from time markers); the charge spectrum peaks at the cyclotron frequency.', lv('cell 0.25 mm, markers T/64, 32 periods', 'rel 1e-9 (charge), 1e-8 (current), 1e-5 (published); 1e-6 constancy'), 120000),
    B('T20', 'T', 'Orbits in a logarithmic field', 'gate', 'Coaxial field with k = 3492.34 V (inner 4 mm, outer 20 mm, planar quarter with mirrors); q −1, 1 u ions tangential at 10 and 15 mm with k/2 = 1746.17 eV stay circular over 720°; one at 10 mm with 800 eV less stays bound and swings between the closed-form inner apsis 5.7071 mm and 10 mm.', lv('cell 0.2 mm', '|Δr| ≤ 1.5e-3 mm; apsis 2e-3 mm', 'cell 0.1 mm', '|Δr| ≤ 4e-4 mm; apsis 5e-4 mm')),
    B('L1', 'L', 'Two-tube lens, zero gap', 'gate', 'S3-type geometry; lens tool (rays at 0.02–0.08D, T² + T⁴ fits) against the exact paraxial values for ratios 2, 5, 10, 20.', lv('R = 32 cells', 'rel 1e-3; identity 3e-4', 'R = 64 cells', 'rel 3e-4; identity 5e-5'), 120000),
    B('L2', 'L', 'Einzel lens, zero gap, A/D 0.5', 'gate', 'Three-segment wall profile; focal length f/D against the exact paraxial values for ratios −0.5, 0, 0.8, 2, 9.', lv('R = 40 cells', 'rel 6e-4', 'R = 80 cells', 'rel 2e-4'), 120000),
    B('L3', 'L', 'Two-tube lens, 0.1D gap, NBS geometry', 'gate', 'S4 geometry; F1, F2, f1, f2 for ratios 2, 5, 10, 20, 40, 100 against DiChio, Natali & Kuyatt (1974), Table I.', lv('R = 40 cells', 'max(0.35%·|ref|, 0.003 D)', 'R = 80 cells', 'max(0.35%·|ref|, 0.003 D)'), 180000),
    B('L4', 'L', 'Lagrange–Helmholtz identity', 'gate', '|f1/f2|·√(V2/V1) − 1 on the L3 rays.', lv('R = 40 cells', '2e-4 (ratio 100: 4e-4)', 'R = 80 cells', '1e-4 (ratio 100: 4e-4)'), 180000),
    B('L5', 'L', 'Einzel lens vs Adams & Read (1972)', 'info', 'Assumed geometry A/D 0.5, G/D 0.1 with linear-ramp gaps; f/D for ratios −0.5, 0, 0.8, 2, 9.', lv('R = 40 cells', 'band ±2%'), 120000),
    B('L6', 'L', 'Two-aperture lens vs Harting & Read (1976)', 'info', 'Zero-thickness apertures with a ramp closure at 5D; A/D 0.5 and 1.0; ratios 0.5, 2, 10, 40, 90; f2/D.', lv('R = 16 cells', 'band +2.5% to +6.5%', 'R = 32 cells', 'band +2.5% to +6.5%'), 240000),
    B('L7', 'L', 'Davisson–Calbick aperture', 'info', '1 mm hole between a field-free region and a 50 V/mm accelerating field at 1000 eV: thin-lens focal length 4V/(E2 − E1) = 80 mm.', lv('cell 0.05 mm', 'band ±10%'), 120000),
    B('L8', 'L', 'Newton\'s rule and spherical aberration', 'gate', 'Two-tube preset lens (D 20 mm, 0.1 D gap, V2/V1 = 5, 1000 eV Ar⁺): cardinal elements from the lens tool; rays from an axial object at x = −80 mm aimed at 1e-4, 0.01, 0.05, 0.1, 0.2, 0.4 D cross the axis in the drift beyond the grid; pq/(f1 f2) → 1 paraxially and the image moves inward as h².', lv('cell 0.25 mm', '2e-4 at 1e-4 D; 2e-3 at 0.01 D; h² ratio ∈ [3.6, 4.3]', 'cell 0.125 mm', '2e-4 at 1e-4 D; 2e-3 at 0.01 D; h² ratio ∈ [3.6, 4.3]'), 120000),
    B('L9', 'L', 'Weak-lens formula for the einzel lens', 'gate', 'Einzel lens A/D 0.5, G/D 0.1 at V2/V1 = 1.05 and 1.10: the lens tool\'s f against the Picht weak-lens integral 1/f = (3/16)∫(φ′/φ)² dz on the zero-gap Bessel-series potential (the gaps lengthen f by about 1.1%) and on the solved axial potential.', lv('R = 40 cells', 'rel 2.5% / 3.5% (series); 1.5e-3 / 2e-3 (solved)', 'R = 80 cells', 'rel 2.5% / 3.5% (series); 1.5e-3 / 2e-3 (solved)'), 120000),
    B('D1', 'D', 'Mobility drag: terminal velocity and relaxation', 'gate', '100 u with K = 2 cm²/(V s) in 24 V/mm from rest: terminal velocity KE = 4.8e-3 mm/µs after 50τ and relaxation distance v_t·τ = (m/q)EK² ≈ 1e-6 mm; with E = 0 and a gas moving at 100 mm/µs the ion reaches v_gas(1 − e⁻⁵) after 5τ and the gas speed after 20τ.', lv('cell 0.5 mm', 'rel 1e-6 (5τ: 1e-8)')),
    B('D2', 'D', 'Ion-mobility drift cell', 'gate', 'm/z 720 with K₀ 4.31 cm²/(V s) at 1 torr and 298 K (K = 3574) in a uniform 5 V/mm cell: damping constant q/(mK) = 0.375 µs⁻¹ from the velocity after 2 µs and drift velocity KE = 1.787 mm/µs after 60 µs.', lv('cell 1 mm', 'half a unit in the last digit; closed form rel 1e-6 and 1e-8')),
    B('I1', 'I', 'Octupole ion guide (round rods)', 'info', 'Eight rods of radius 0.355 r₀ (r₀ 4 mm) at ±1 V, planar quarter with mirrors, cell r₀/40: potential on r = 0.5 r₀ against V(x⁴ + y⁴ − 6x²y²)/r₀⁴ and the Fourier coefficients A4 and A12/A4.', lv('cell 0.1 mm', 'band ±1% of V(r/r₀)⁴; A4 ± 2%; |A12/A4| ≤ 2%')),
    B('I2', 'I', 'Space-charge beam spread (onset estimator)', 'info', 'Converging 1 eV electron beam, R₀ 3 mm, tan θ 0.3, 3.47e-13 C born over 0.1 µs (the perveance-limited current 38.6 µA·KE^1.5·tan²θ): minimum envelope radius √2·r_rms along x against the laminar envelope value R₀ exp(−tan²θ/2K) = 1.275 mm (plan: 1.28 ± 25 %). Quick: 250 macro-particles, ε 0.25 mm; full: 1000, ε 0.1 mm.', lv('250 particles, ε 0.25 mm', 'band 0.96–1.60 mm', '1000 particles, ε 0.1 mm', 'band 0.96–1.60 mm'), 180000),
    B('I3', 'I', 'Trap multipoles (Legendre coefficients)', 'info', 'The P9 hyperbolic trap (r₀ 7.07, z₀ 5 mm, surfaces to 15 mm) with the ring at 1 V, cell 0.075 mm: Legendre coefficients on a sphere of radius 4 mm about the center, normalized to r₀; c₂ against the study\'s −1.001 (band ±0.3%), c₀ against 0.5, odd coefficients ≤ 1e-6; c₄ and c₆ reported against the published 1.05e-3 and 1.24e-3 (the study\'s truncation is not stated).', lv('cell 0.075 mm (r₀ ≈ 94 cells)', 'band ±3e-3 (c₂), ±5e-3 (c₀); odd ≤ 1e-6')),
    B('I4', 'I', 'Hard-sphere mean free path', 'info', '2000 ions of 200 u (15 Å) at 24 eV in He (2 Å) at 4 mTorr, 275 K, traced over two mean free paths: Σpath/Σcollisions against 1/(nσ) = 3.14 mm and the kinetic-theory value v/(nσ⟨g⟩) = 3.06 mm.', lv('cell 1 mm', 'rel 5 %')),
    B('P1', 'P', 'Child–Langmuir diode', 'planned', '738.06 A/m² for 1000 V across 10 mm (electrons). Needs a Poisson (space-charge) solver.', lv('—', '—')),
    B('P2', 'P', 'Two protons from rest (space charge)', 'gate', 'Two protons released from rest 1 µm apart in a field-free box, traced with the direct pair force (tracer.spaceCharge, ε = 1e-7 mm, accuracy fine): the asymptotic energy per proton is k e²/(2 d) = 0.719982 meV; energy conservation and symmetry.', lv('cell 1 mm, pair step 0.005', 'half a unit in the last digit; rel 1e-6')),
    B('P3', 'P', '3D coax and spheres', 'planned', 'S1 and S2 on a three-dimensional grid (Phase 2).', lv('—', '—')),
    B('P4', 'P', 'Capacitance by Gauss flux', 'gate', 'Charge per electrode by Gauss\'s law on a contour between the electrodes of the S1 and S2 fields, capacitance matrix from the unit solutions: coax 2πε₀/ln 2 = 80.2607 pF/m (a 10, b 20 mm) and spheres 4πε₀/(1/R₁ − 1/R₂) = 26.7036 pF (80/120 mm); charge of the inner sphere from C·V; reciprocity of the matrix.', lv('S1 cell 0.2 mm, S2 cell 1 mm', 'rel 1e-4; digits (coax); 1e-9 (reciprocity)', 'S1 cell 0.1 mm, S2 cell 0.5 mm', 'rel 1e-4; digits (coax); 1e-9 (reciprocity)')),
]);

function progress(ctx, frac, msg) {
    if (ctx && typeof ctx.onProgress === 'function') { try { ctx.onProgress(frac, msg); } catch (e) { /* caller */ } }
}

/**
 * Runs one validation case.
 * @param {string} id @param {'quick'|'full'} [level] @param {{ onProgress?: (frac: number, msg: string) => void, log?: (level: string, msg: string) => void }} [ctx]
 * @returns {Promise<{ id: string, level: string, status: 'pass'|'fail'|'info'|'error', ms: number, engineVersion: string, checks: object[], details: object, series?: object[] }>}
 */
export async function runBenchmark(id, level = 'quick', ctx = {}) {
    const lvl = level === 'full' ? 'full' : 'quick';
    const def = BENCHMARKS.find((b) => b.id === id);
    const t0 = now();
    const base = { id, level: lvl, engineVersion: ENGINE_VERSION };
    if (!def) return { ...base, status: 'error', ms: 0, checks: [], details: { error: `Unknown case "${id}".` } };
    if (def.kind === 'planned') return { ...base, status: 'info', ms: 0, checks: [], details: { planned: true, note: def.description } };
    const c = CASES[id];
    if (!c) return { ...base, status: 'error', ms: 0, checks: [], details: { error: 'Not implemented.' } };
    try {
        progress(ctx, 0, `${id}: start`);
        const out = await c.run(lvl, ctx);
        const checks = out.checks || [];
        const ok = checks.length > 0 && checks.every((k) => k.pass);
        const status = def.kind === 'info' ? 'info' : (ok ? 'pass' : 'fail');
        progress(ctx, 1, `${id}: ${status}`);
        return { ...base, status, ms: now() - t0, checks, details: out.details || {}, ...(out.series ? { series: out.series } : {}) };
    } catch (e) {
        return { ...base, status: 'error', ms: now() - t0, checks: [], details: { error: e && e.message ? String(e.message) : String(e), code: e && e.code ? e.code : null } };
    }
}

/**
 * The project of a case ("Open setup"); null for planned cases. Multi-variant cases return their main variant.
 * @param {string} id @param {'quick'|'full'} [level]
 * @returns {object|null} Project
 */
export function caseProject(id, level = 'quick') {
    const c = CASES[id];
    if (!c || typeof c.project !== 'function') return null;
    const p = c.project(level === 'full' ? 'full' : 'quick');
    return p ? clone(p) : null;
}
