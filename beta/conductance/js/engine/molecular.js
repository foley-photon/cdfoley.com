// Molecular-flow transmission probabilities (spec 2.4, 3.2). Every function returns alpha in (0, 1] of the element
// between two large volumes, referred to its inlet area, so C = alpha A_in vbar / 4. Pure module.

import { COLS_L, SLOT, RECT, ANNULUS, CONE, ELBOW, TABLE_SOURCES } from './tables.js';
import { makePchip, makeQTable, makeKappaCone } from './interp.js';

const DEG = Math.PI / 180;

function need(cond, message) { if (!cond) throw new RangeError(message); }
const pos = (v) => Number.isFinite(v) && v > 0;
const nonneg = (v) => Number.isFinite(v) && v >= 0;

/**
 * Round tube, y = L/d >= 0: Berman's closed form (J. Appl. Phys. 36, 3356, 1965), asymptotic form above 1e7.
 * Spec v2.1: the closed form is evaluated up to y = 1e7, where it is still accurate to 6e-10 in double precision and
 * joins the asymptote to 8e-9. (v2.0 switched at 1e4, where the asymptote is 4.7e-5 off and tubeAlphaInverse
 * became ambiguous; integration step, golden values updated.)
 */
export function tubeAlpha(y) {
    need(nonneg(y), 'The tube length-to-diameter ratio must be zero or positive.');
    if (y === 0) return 1;
    if (y > 1e7) return (4 / (3 * y)) * (1 - 0.45515 * Math.log(y) / y);
    const s = Math.sqrt(y * y + 1), sm1 = y * y / (s + 1);
    const N = 2 * sm1 - y * y / (y + s), D = 4.5 * (y * s - Math.asinh(y));
    return s / (y + s) - N * N / D;
}

/**
 * y = L/d with tubeAlpha(y) = alpha, alpha in (0, 1]: bisection on ln y over [1e-9, 1e15], then two secant steps.
 * (v2.2: the range was [1e-9, 1e9], which clamped black boxes below alpha = 1.3e-9, e.g. 2e-7 L/s on a DN40 bore.)
 */
export function tubeAlphaInverse(alpha) {
    need(Number.isFinite(alpha) && alpha > 0 && alpha <= 1, 'The transmission probability must be above 0 and at most 1.');
    if (alpha === 1) return 0;
    let lo = Math.log(1e-9), hi = Math.log(1e15);
    for (let i = 0; i < 200; i++) {
        const m = 0.5 * (lo + hi);
        if (tubeAlpha(Math.exp(m)) > alpha) lo = m; else hi = m;
    }
    let y0 = Math.exp(lo), y1 = Math.exp(hi);
    for (let k = 0; k < 2; k++) {
        const f0 = tubeAlpha(y0) - alpha, f1 = tubeAlpha(y1) - alpha;
        if (f1 === f0) break;
        const y2 = y1 - f1 * (y1 - y0) / (f1 - f0);
        y0 = y1; y1 = y2;
    }
    return y1;
}

// ---- slot: integral-equation table, q = (1/alpha - 1)/x by PCHIP in ln x
const SX0 = SLOT.x[0], SXN = SLOT.x[SLOT.x.length - 1], SAN = SLOT.alpha[SLOT.alpha.length - 1];
const slotQ = makePchip(SLOT.x.map(Math.log), SLOT.alpha.map((a, i) => (1 / a - 1) / SLOT.x[i]));
const slotQ0 = slotQ(Math.log(SX0));

/** Infinitely wide slot, x = L/h >= 0 (SLOT table; spec 3.2.2). */
export function slotAlpha(x) {
    need(nonneg(x), 'The slot depth-to-gap ratio must be zero or positive.');
    if (x === 0) return 1;
    if (x < SX0) return 1 / (1 + slotQ0 * x);
    if (x > SXN) return SAN * (Math.log(x) / x) / (Math.log(SXN) / SXN);
    return 1 / (1 + slotQ(Math.log(x)) * x);
}

const rectT = makeQTable({ rows: RECT.rows, cols: COLS_L, alpha: RECT.alpha, special: { 0: slotAlpha } });
const annT = makeQTable({
    rows: ANNULUS.rows, cols: COLS_L, alpha: ANNULUS.alpha,
    special: { 0: (l) => tubeAlpha(l / 2), [ANNULUS.rows.length - 1]: slotAlpha },
});
const coneT = makeKappaCone({ rows: CONE.rows, cols: COLS_L, alpha: CONE.alpha, tubeAlpha });

/** Rectangular duct with sides a, b (any order) and length L (spec 3.2.3). */
export function rectAlpha(a, b, L) {
    need(pos(a) && pos(b), 'Both sides of a rectangular duct must be positive.');
    need(nonneg(L), 'The duct length must be zero or positive.');
    if (a > b) [a, b] = [b, a];
    return rectT(a / b, L / a);
}

/** Annulus: rod radius Ri (0 <= Ri < Ro), bore radius Ro, length L (spec 3.2.4). Ri = 0 is the tube. */
export function annulusAlpha(Ri, Ro, L) {
    need(pos(Ro) && nonneg(Ri) && Ri < Ro, 'An annulus needs 0 <= rod radius < bore radius.');
    need(nonneg(L), 'The annulus length must be zero or positive.');
    if (Ri === 0) return tubeAlpha(L / (2 * Ro));
    return annT(Ri / Ro, L / (Ro - Ri));
}

/** Diverging cone of half-angle betaDeg (0-90) and l = L/R_small, referred to the small end (spec 3.2.6). */
export function coneDivAlpha(betaDeg, l) {
    need(Number.isFinite(betaDeg) && betaDeg >= 0 && betaDeg <= 90, 'The cone half-angle must be between 0 and 90 degrees.');
    need(nonneg(l), 'The cone length must be zero or positive.');
    return coneT(betaDeg, l);
}

/** Cone or reducer from inlet radius R1 to outlet radius R2 over length L, inlet-referred, either direction. */
export function coneAlpha(R1, R2, L) {
    need(pos(R1) && pos(R2), 'Both cone radii must be positive.');
    need(nonneg(L), 'The cone length must be zero or positive.');
    if (Math.abs(R2 - R1) <= 1e-12 * Math.max(R1, R2)) return tubeAlpha(L / (2 * R1));
    const Rs = Math.min(R1, R2), Rl = Math.max(R1, R2), b = Math.atan((Rl - Rs) / L) / DEG;
    const a = coneT(b, L / Rs);
    return R1 <= R2 ? a : a * (R2 / R1) ** 2;
}

// ---- elbow: kappa(A/R, B/R) times the Oatley combination of the two legs
const LEGS = ELBOW.legs, LNLEG = LEGS.map(Math.log), LN_LO = LNLEG[0], LN_HI = LNLEG[LNLEG.length - 1];
const kapRows = ELBOW.kappa.map((r) => makePchip(LNLEG, r));

/** 90-degree mitered elbow of bore radius R with legs A and B measured to the axis intersection (spec 3.2.5). */
export function elbowAlpha(R, A, B) {
    need(pos(R) && pos(A) && pos(B), 'The elbow bore and both legs must be positive.');
    const cl = (v) => Math.min(Math.max(Math.log(v), LN_LO), LN_HI);
    const ys = kapRows.map((f) => f(cl(B / R)));
    const kap = makePchip(LNLEG, ys)(cl(A / R));
    const aA = tubeAlpha(A / (2 * R)), aB = tubeAlpha(B / (2 * R));
    return Math.min(1, kap / (1 / aA + 1 / aB - 1));
}

/** Berman's closed-form slot (Livesey eq. 2.28); self-test cross-check only. */
export function bermanSlotAlpha(x) {
    need(nonneg(x), 'The slot depth-to-gap ratio must be zero or positive.');
    const s = Math.sqrt(1 + x * x);
    if (x < 0.01) return 0.5 * (1 + s - x);
    const t = x - Math.asinh(x);
    return 0.5 * (1 + s - x) - 1.5 * t * t / (x * x * x + 3 * x * x + 4 - (x * x + 4) * s);
}

/** Berman's annulus fit (Livesey eq. 2.36), valid for L/(do - di) <= 50 and e <= 0.9; cross-check only. */
export function bermanAnnulusAlpha(Ri, Ro, L) {
    need(pos(Ro) && nonneg(Ri) && Ri < Ro, 'An annulus needs 0 <= rod radius < bore radius.');
    need(nonneg(L), 'The annulus length must be zero or positive.');
    const e = Ri / Ro, x = L / (2 * (Ro - Ri));
    const u = (0.0741 - 0.014 * e - 0.037 * e * e) / (1 - 0.918 * e + 0.05 * e * e);
    const v = (5.825 - 2.86 * e - 1.45 * e * e) / (1 + 0.56 * e - 1.28 * e * e);
    return 1 / (1 + x * (1 - 2 * u * Math.atan(2 * x / v)));
}

const SOURCE = {
    tube: 'Berman 1965 closed form (Livesey eq. 2.24); within 0.07 % of Matuda 2015',
    slit: TABLE_SOURCES.RECT, rect: TABLE_SOURCES.RECT, annulus: TABLE_SOURCES.ANNULUS, cone: TABLE_SOURCES.CONE,
    elbow: TABLE_SOURCES.ELBOW, orifice: 'Exact: thin orifice, alpha = 1',
    bbox: 'Datasheet conductance (exact in molecular flow by construction)',
};
const ACC = { tube: [0.001, 0.001], slit: [0.003, 0.008], rect: [0.003, 0.008], annulus: [0.005, 0.010], cone: [0.004, 0.010], elbow: [0.003, 0.010], orifice: [0, 0], bbox: [0, 0] };

/**
 * Accuracy label of an element's molecular alpha (spec 3.2.8). params uses the Item keys of that type
 * (tube {d, L}; slit {h, w, L}; rect {a, b, L}; annulus {di, do, L}; cone {d1, d2, L}; elbow {d, A, B}).
 * extrapolated: duct tails beyond l = 100 (slit, rect, annulus, cone) or elbow legs outside 1-50 bore radii.
 */
export function molecularInfo(type, params) {
    need(Object.prototype.hasOwnProperty.call(ACC, type), `No molecular model for element type "${type}".`);
    const p = params || {};
    let extrapolated = false;
    if (type === 'slit' || type === 'rect') {
        const a = type === 'slit' ? Math.min(p.h, p.w) : Math.min(p.a, p.b);
        extrapolated = p.L / a > 100;
    } else if (type === 'annulus') {
        extrapolated = p.L / ((p.do - p.di) / 2) > 100;
    } else if (type === 'cone') {
        extrapolated = p.L / (Math.min(p.d1, p.d2) / 2) > 100;
    } else if (type === 'elbow') {
        const R = p.d / 2;
        extrapolated = [p.A / R, p.B / R].some((v) => v < LEGS[0] || v > LEGS[LEGS.length - 1]);
    }
    const [acc, accX] = ACC[type];
    return { accuracy: extrapolated ? accX : acc, source: SOURCE[type], extrapolated };
}
