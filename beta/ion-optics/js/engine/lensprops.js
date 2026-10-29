/* ==========================================================================
   Ion optics engine: lensprops.js
   Cardinal elements of an electrostatic lens from traced rays and an image
   finder (specification §2.3 WP5, §3.11(3)).

   Method of DiChio, Natali & Kuyatt, Rev. Sci. Instrum. 45, 559 (1974):
   rays parallel to the axis at heights T in the field-free region on one
   side are traced through the lens into the field-free region on the other;
   the asymptote of each exit ray gives the focal point F*(T) (where it
   crosses the axis) and the principal plane H*(T) (where it reaches the
   entry height). F, H and f = F − H are fitted as c₀ + c₂(T/D)² + c₄(T/D)⁴
   by least squares and reported at T → 0 in units of D from a reference
   plane, negative to the left (f1 < 0, f2 > 0 for a converging lens).
   The Lagrange–Helmholtz relation f2/f1 = −n2/n1 with n ∝ momentum
   (√V nonrelativistically) gives the identity check |f1/f2|·(p2/p1) − 1
   (e.g. Harting & Read, Electrostatic Lenses (1976), ch. 1).
   The image finder traces rays from an axial object point and applies the
   same asymptote construction; the lateral magnification follows from the
   Lagrange–Helmholtz invariant y·p·α = const.
   Tracing is injected: traceFn(particles, opts) → Promise<TraceResult>.
   ========================================================================== */
import {
    P_STRIDE, P_ID, P_SRC, P_SPECIES, P_MASS, P_CHARGE, P_T0, P_X, P_Y, P_Z, P_WX, P_WY, P_WZ, P_KE, P_C0, P_C1, P_C2,
    S_STRIDE, S_ID, S_STATUS, S_WHERE, S_X, S_Y, S_Z, S_VX, S_VY, S_VZ, STATUS,
} from './layout.js';
import { properSpeedFromKE, K_ACC } from './constants.js';

/** Default ray heights in units of D. */
export const LENS_HEIGHTS = Object.freeze([0.02, 0.03, 0.04, 0.05, 0.06, 0.08]);

/**
 * Least-squares fit of values(T) = c0 + c2·u + c4·u², u = (T/D)², with as many terms as the points allow (≤ 3).
 * @param {number[]} Ts heights (mm) @param {number[]} vals @param {number} D
 * @returns {number[]} [c0, c2, c4] (missing terms are 0; NaN when there are no points)
 */
export function fitEven(Ts, vals, D = 1) {
    const us = [], ys = [];
    for (let i = 0; i < Ts.length; i++) {
        const v = vals[i];
        if (typeof v === 'number' && Number.isFinite(v)) { const t = Ts[i] / D; us.push(t * t); ys.push(v); }
    }
    const n = us.length;
    if (n === 0) return [NaN, 0, 0];
    const distinct = new Set(us).size;
    const m = Math.min(3, distinct);
    const A = [], b = [];
    for (let p = 0; p < m; p++) { A.push(new Array(m).fill(0)); b.push(0); }
    for (let i = 0; i < n; i++) {
        const row = [1, us[i], us[i] * us[i]];
        for (let p = 0; p < m; p++) { b[p] += row[p] * ys[i]; for (let q = 0; q < m; q++) A[p][q] += row[p] * row[q]; }
    }
    // Gaussian elimination with partial pivoting
    for (let i = 0; i < m; i++) {
        let piv = i;
        for (let k = i + 1; k < m; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
        [A[i], A[piv]] = [A[piv], A[i]]; [b[i], b[piv]] = [b[piv], b[i]];
        if (A[i][i] === 0) return [ys.reduce((s, v) => s + v, 0) / n, 0, 0];
        for (let k = i + 1; k < m; k++) {
            const f = A[k][i] / A[i][i];
            for (let q = i; q < m; q++) A[k][q] -= f * A[i][q];
            b[k] -= f * b[i];
        }
    }
    const x = new Array(m).fill(0);
    for (let i = m - 1; i >= 0; i--) {
        let s = b[i];
        for (let q = i + 1; q < m; q++) s -= A[i][q] * x[q];
        x[i] = s / A[i][i];
    }
    return [x[0], m > 1 ? x[1] : 0, m > 2 ? x[2] : 0];
}

/**
 * One particle row (P_STRIDE) at position p moving along unit direction d with kinetic energy ke.
 * @param {Float64Array} out @param {number} index
 */
export function particleRow(out, index, { id, mass, charge, ke, p, d, t0 = 0, relativistic = true, source = 0, species = 0 }) {
    const o = index * P_STRIDE;
    const w = relativistic ? properSpeedFromKE(ke, mass) : Math.sqrt(2 * K_ACC * ke / mass);
    const n = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) || 1;
    out[o + P_ID] = id; out[o + P_SRC] = source; out[o + P_SPECIES] = species; out[o + P_MASS] = mass; out[o + P_CHARGE] = charge;
    out[o + P_T0] = t0; out[o + P_X] = p[0]; out[o + P_Y] = p[1]; out[o + P_Z] = p[2];
    out[o + P_WX] = w * d[0] / n; out[o + P_WY] = w * d[1] / n; out[o + P_WZ] = w * d[2] / n;
    out[o + P_KE] = ke; out[o + P_C0] = -1; out[o + P_C1] = -1; out[o + P_C2] = -1;
    return out;
}

/** Summary row offset of particle id (or −1). */
function rowOf(result, id) {
    const S = result.summary;
    if (id < result.n && S[id * S_STRIDE + S_ID] === id) return id * S_STRIDE;
    for (let i = 0; i < result.n; i++) if (S[i * S_STRIDE + S_ID] === id) return i * S_STRIDE;
    return -1;
}

/** End state of a particle detected on plane `plane`: { x, y, z, vx, vy, vz } or null. */
function detectedState(result, id, plane) {
    const o = rowOf(result, id);
    if (o < 0) return null;
    const S = result.summary;
    if (S[o + S_STATUS] !== STATUS.DETECTED || S[o + S_WHERE] !== plane) return null;
    return { x: S[o + S_X], y: S[o + S_Y], z: S[o + S_Z], vx: S[o + S_VX], vy: S[o + S_VY], vz: S[o + S_VZ] };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Lens properties (DiChio 1974 protocol, §3.11(3)).
 * spec: { refX, D, xStart, xEnd, mass, charge, keLeft, heights = LENS_HEIGHTS (×D), side: 'both'|'left'|'right',
 *         relativistic = true, rtol = 1e-11, maxStepCells = 0.5 }
 * model: the FieldModel (potential at xStart and xEnd); traceFn(particles, opts) → Promise<TraceResult>.
 * @returns {Promise<{ F1: number, F2: number, f1: number, f2: number, H1: number, H2: number, identity: number, a2: number,
 *   raw: object, warnings: Array<{ code: string, message: string }> }>} lengths in units of D from refX
 */
export async function lensProperties(spec, model, traceFn) {
    const s = { refX: 0, heights: LENS_HEIGHTS, side: 'both', relativistic: true, rtol: 1e-11, maxStepCells: 0.5, ...spec };
    const D = s.D, q = s.charge, m = s.mass;
    const warnings = [];
    if (!(D > 0)) throw new Error('lensProperties: D must be positive');
    if (!(s.xEnd > s.xStart)) throw new Error('lensProperties: xEnd must lie to the right of xStart');
    const Ts = (s.heights || LENS_HEIGHTS).map((u) => u * D);
    const potAt = (x, y) => (model && typeof model.potential === 'function' ? model.potential(0, x, y, 0) : 0);
    const doRight = s.side !== 'left', doLeft = s.side !== 'right';
    const keRightOf = (T) => s.keLeft + q * (potAt(s.xStart, T) - potAt(s.xEnd, T));
    const keRight = keRightOf(0);
    if (!(keRight > 0)) warnings.push({ code: 'W_LENS_REFLECT', message: 'The particles do not reach the right side of the lens (kinetic energy ≤ 0 there).' });
    // field-free check at the ends
    if (model && typeof model.E === 'function') {
        const e4 = new Float64Array(4);
        const scale = Math.max(Math.abs(s.keLeft), Math.abs(keRight)) / Math.abs(q) / D;
        for (const x of [s.xStart, s.xEnd]) {
            model.E(0, x, 0, 0, e4);
            if (Math.abs(e4[0]) > 1e-4 * scale) warnings.push({ code: 'W_LENS_FIELD', message: `The axial field at x = ${x} mm is not negligible; move the ray start or end into a field-free region.` });
        }
    }
    const nT = Ts.length, nR = (doRight ? nT : 0) + (doLeft ? nT : 0);
    const parts = new Float64Array(nR * P_STRIDE);
    let k = 0;
    if (doRight) for (let i = 0; i < nT; i++, k++) particleRow(parts, k, { id: k, mass: m, charge: q, ke: s.keLeft, p: [s.xStart, Ts[i], 0], d: [1, 0, 0], relativistic: s.relativistic });
    if (doLeft) for (let i = 0; i < nT; i++, k++) particleRow(parts, k, { id: k, mass: m, charge: q, ke: keRightOf(Ts[i]), p: [s.xEnd, Ts[i], 0], d: [-1, 0, 0], relativistic: s.relativistic });
    const planes = [
        { id: 'lens-right', name: 'Lens right', kind: 'x', at: s.xEnd, limits: null, radius: null, terminate: true, side: 'forward', record: 'first' },
        { id: 'lens-left', name: 'Lens left', kind: 'x', at: s.xStart, limits: null, radius: null, terminate: true, side: 'backward', record: 'first' },
    ];
    const opts = { integrator: 'rk45', rtol: s.rtol, maxStepCells: s.maxStepCells, nearStepCells: Math.min(s.maxStepCells, s.nearStepCells || 0.1),
        relativistic: s.relativistic, planes, record: { trajectories: false }, energyCheck: true };
    const result = await traceFn(parts, opts);
    const raw = { T: Ts.slice(), F2s: [], H2s: [], f2s: [], F1s: [], H1s: [], f1s: [], lost: [] };
    const toD = (x) => (x - s.refX) / D;
    k = 0;
    if (doRight) {
        for (let i = 0; i < nT; i++, k++) {
            const st = detectedState(result, k, 0);
            if (!st || !(st.vx > 0) || st.vy === 0) { raw.F2s.push(NaN); raw.H2s.push(NaN); raw.f2s.push(NaN); raw.lost.push({ side: 'right', T: Ts[i] }); continue; }
            const yp = st.vy / st.vx;
            const F = st.x - st.y / yp, H = st.x + (Ts[i] - st.y) / yp;
            raw.F2s.push(toD(F)); raw.H2s.push(toD(H)); raw.f2s.push((F - H) / D);
        }
    }
    if (doLeft) {
        for (let i = 0; i < nT; i++, k++) {
            const st = detectedState(result, k, 1);
            if (!st || !(st.vx < 0) || st.vy === 0) { raw.F1s.push(NaN); raw.H1s.push(NaN); raw.f1s.push(NaN); raw.lost.push({ side: 'left', T: Ts[i] }); continue; }
            const yp = st.vy / st.vx;
            const F = st.x - st.y / yp, H = st.x + (Ts[i] - st.y) / yp;
            raw.F1s.push(toD(F)); raw.H1s.push(toD(H)); raw.f1s.push((F - H) / D);
        }
    }
    if (raw.lost.length) warnings.push({ code: 'W_LENS_LOST', message: `${raw.lost.length} lens ray${raw.lost.length === 1 ? '' : 's'} did not reach the far side; the fit uses the others.` });
    const fit = (vals) => (vals.length ? fitEven(Ts, vals, D) : [NaN, 0, 0]);
    const fits = { F2: fit(raw.F2s), H2: fit(raw.H2s), f2: fit(raw.f2s), F1: fit(raw.F1s), H1: fit(raw.H1s), f1: fit(raw.f1s) };
    const F2 = fits.F2[0], H2 = fits.H2[0], f2 = fits.f2[0], F1 = fits.F1[0], H1 = fits.H1[0], f1 = fits.f1[0];
    const pL = s.relativistic ? properSpeedFromKE(s.keLeft, m) : Math.sqrt(s.keLeft);
    const pR = keRight > 0 ? (s.relativistic ? properSpeedFromKE(keRight, m) : Math.sqrt(keRight)) : NaN;
    const identity = isNum(f1) && isNum(f2) && f2 !== 0 ? Math.abs(f1 / f2) * (pR / pL) - 1 : NaN;
    raw.fits = fits;
    raw.keRight = keRight;
    raw.mm = { F1: s.refX + F1 * D, F2: s.refX + F2 * D, H1: s.refX + H1 * D, H2: s.refX + H2 * D, f1: f1 * D, f2: f2 * D };
    raw.result = result;
    return { F1, F2, f1, f2, H1, H2, identity, a2: fits.F2[1], raw, warnings };
}

/**
 * Image of an axial object point: rays from (objectX, 0, 0) at the given angles (degrees, in the x–y plane) are traced to
 * the field-free plane x = xEnd; each exit asymptote crosses the axis at x_i. imageX = the paraxial limit of x_i
 * (fit in angle² when several angles are given), magnification M = (p_in·α_in)/(p_out·α_out) (Lagrange–Helmholtz),
 * rms = rms ray height at imageX.
 * spec: { objectX, mass, charge, ke, angles, xEnd, relativistic = true, rtol = 1e-10, maxStepCells = 0.5 }
 * @returns {Promise<{ imageX: number, magnification: number, rms: number, rays: object[], warnings: object[] }>}
 */
export async function imageOf(spec, traceFn) {
    const s = { relativistic: true, rtol: 1e-10, maxStepCells: 0.5, ...spec };
    const angles = (s.angles && s.angles.length ? s.angles : [-0.25, 0.25]).filter((a) => a !== 0);
    if (!isNum(s.xEnd)) throw new Error('imageOf: xEnd (a field-free plane after the lens) is required');
    const parts = new Float64Array(angles.length * P_STRIDE);
    angles.forEach((a, i) => {
        const r = a * Math.PI / 180;
        particleRow(parts, i, { id: i, mass: s.mass, charge: s.charge, ke: s.ke, p: [s.objectX, 0, 0], d: [Math.cos(r), Math.sin(r), 0], relativistic: s.relativistic });
    });
    const planes = [{ id: 'image-end', name: 'Image finder', kind: 'x', at: s.xEnd, limits: null, radius: null, terminate: true, side: 'forward', record: 'first' }];
    const result = await traceFn(parts, { integrator: 'rk45', rtol: s.rtol, maxStepCells: s.maxStepCells, relativistic: s.relativistic, planes, record: { trajectories: false } });
    const rays = [], warnings = [];
    const pIn = s.relativistic ? properSpeedFromKE(s.ke, s.mass) : Math.sqrt(2 * K_ACC * s.ke / s.mass);
    angles.forEach((a, i) => {
        const st = detectedState(result, i, 0);
        if (!st || !(st.vx > 0) || st.vy === 0) { rays.push({ angle: a, lost: true }); return; }
        const yp = st.vy / st.vx;
        const v2 = st.vx * st.vx + st.vy * st.vy + st.vz * st.vz;
        const vOut = Math.sqrt(v2);
        const C2 = 299792.458 * 299792.458;
        const pOut = s.relativistic ? vOut / Math.sqrt(1 - Math.min(v2 / C2, 1 - 1e-16)) : vOut;
        const aIn = Math.tan(a * Math.PI / 180);
        rays.push({ angle: a, x: st.x, y: st.y, slope: yp, crossing: st.x - st.y / yp, magnification: (pIn * aIn) / (pOut * yp) });
    });
    const ok = rays.filter((r) => !r.lost);
    if (ok.length < rays.length) warnings.push({ code: 'W_IMAGE_LOST', message: `${rays.length - ok.length} ray${rays.length - ok.length === 1 ? '' : 's'} did not reach x = ${s.xEnd} mm.` });
    if (!ok.length) return { imageX: NaN, magnification: NaN, rms: NaN, rays, warnings };
    const distinct = new Set(ok.map((r) => Math.abs(r.angle))).size;
    let imageX, magnification;
    if (distinct >= 2) {
        imageX = fitEven(ok.map((r) => r.angle), ok.map((r) => r.crossing), 1)[0];
        magnification = fitEven(ok.map((r) => r.angle), ok.map((r) => r.magnification), 1)[0];
    } else {
        imageX = ok.reduce((t, r) => t + r.crossing, 0) / ok.length;
        magnification = ok.reduce((t, r) => t + r.magnification, 0) / ok.length;
    }
    let ss = 0;
    for (const r of ok) { const y = r.y + r.slope * (imageX - r.x); ss += y * y; }
    return { imageX, magnification, rms: Math.sqrt(ss / ok.length), rays, warnings };
}
