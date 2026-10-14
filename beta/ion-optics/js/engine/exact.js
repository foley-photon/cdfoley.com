/* ==========================================================================
   Ion optics engine: exact.js
   Exact and semi-analytic reference values for the validation suite and the
   analysis tools (specification §2.3 WP5, §5.4).

   - Zero-gap coaxial tubes of radius R (thin walls): on-axis potential
     S(ζ), ζ = z/R, from the Bessel series S = 1 − Σ exp(−j_n ζ)/(j_n J₁(j_n))
     over the zeros j_n of J₀ (ζ ≥ 0.25) and from the integral
     S = ½ + (1/π)∫₀^∞ sin(kζ)/(k I₀(k)) dk (|ζ| < 0.25, Simpson, k ≤ 40);
     S(−ζ) = 1 − S(ζ). Natali, DiChio, Uva & Kuyatt, J. Res. NBS 76A, 27
     (1972), Table 2; Read, J. Phys. E 2, 165 (1969); Bessel functions:
     Abramowitz & Stegun 9.1.21 (Bessel's integral), 9.5.12 (McMahon's
     expansion for the zeros of J₀), 9.6.12 (I₀ series).
   - Paraxial focal properties from the nonrelativistic paraxial ray equation
     r″ = −φ′r′/(2φ) − φ″r/(4φ) (e.g. Harting & Read, Electrostatic Lenses
     (1976), ch. 1) by RK4 with step 0.005R; signs as in DiChio, Natali &
     Kuyatt, Rev. Sci. Instrum. 45, 559 (1974): F1, H1, f1 negative to the
     left of the reference plane.
   - Mathieu equation u″ + (a − 2q cos 2ξ)u = 0: characteristic values a₀(q),
     b₁(q) by Sturm-sequence bisection on the symmetric tridiagonal
     Fourier matrices (McLachlan, Theory and Application of Mathieu
     Functions (1947), ch. 3); Floquet trace of the monodromy matrix over
     ξ ∈ [0, π] by RK4; quadrupole stability (Dawson, Quadrupole Mass
     Spectrometry (1976); Paul, Rev. Mod. Phys. 62, 531 (1990)).
   - Kinematics in uniform fields, field-free drift, ideal mirrors and
     reflectrons (Wiley & McLaren, Rev. Sci. Instrum. 26, 1150 (1955);
     Mamyrin et al., Sov. Phys. JETP 37, 45 (1973)); coaxial and spherical
     capacitors (e.g. Jackson, Classical Electrodynamics, 3rd ed., ch. 1).
   Units: mm, µs, V, eV, u, e, MHz (spec §2.1.1); nonrelativistic.
   ========================================================================== */
import { K_ACC } from './constants.js';

const PI = Math.PI;

// ---------------------------------------------------------------- Bessel functions
/** J_n(x) by the trapezoid rule on Bessel's integral (1/π)∫₀^π cos(nt − x sin t) dt (A&S 9.1.21). */
function besselJ(n, x, N = 1200) {
    const h = PI / N;
    let s = 0.5 * (1 + Math.cos(n * PI));
    for (let i = 1; i < N; i++) { const t = i * h; s += Math.cos(n * t - x * Math.sin(t)); }
    return s * h / PI;
}

/** Modified Bessel I₀(x) by its power series (A&S 9.6.12). */
function besselI0(x) {
    let s = 1, t = 1;
    for (let k = 1; k < 500; k++) {
        t *= (x / 2) * (x / 2) / (k * k);
        s += t;
        if (t < 1e-17 * s) break;
    }
    return s;
}

const NZ = 140;            // zeros of J0 in the series
const KMAX = 40, NK = 8000; // Simpson integral for |ζ| < 0.25
const ZSWITCH = 0.25;
let BES = null;
/** Zeros of J₀ (Newton from McMahon's expansion), J₁ at the zeros, and the Simpson nodes of the integral form. */
function bessel() {
    if (BES) return BES;
    const zeros = new Float64Array(NZ), j1 = new Float64Array(NZ);
    for (let n = 1; n <= NZ; n++) {
        const b = (n - 0.25) * PI;
        let x = b + 1 / (8 * b) - 124 / (3 * (8 * b) ** 3);
        for (let it = 0; it < 6; it++) x += besselJ(0, x) / besselJ(1, x);   // J0' = −J1
        zeros[n - 1] = x;
        j1[n - 1] = besselJ(1, x);
    }
    const hk = KMAX / NK, kk = new Float64Array(NK + 1), gk = new Float64Array(NK + 1);
    for (let i = 0; i <= NK; i++) {
        kk[i] = i * hk;
        gk[i] = hk / 3 * (i === 0 || i === NK ? 1 : (i % 2 ? 4 : 2)) / besselI0(i * hk);
    }
    BES = { zeros, j1, kk, gk };
    return BES;
}

// S(ζ), S′(ζ), S″(ζ) for ζ ≥ 0: series for ζ ≥ 0.25, integral below
function sPos(z) {
    const B = bessel();
    if (z >= ZSWITCH) {
        let s = 1;
        for (let n = 0; n < NZ; n++) s -= Math.exp(-B.zeros[n] * z) / (B.zeros[n] * B.j1[n]);
        return s;
    }
    let s = 0;
    for (let i = 0; i <= NK; i++) { const k = B.kk[i]; s += B.gk[i] * (k === 0 ? z : Math.sin(k * z) / k); }
    return 0.5 + s / PI;
}
function s1Pos(z) {
    const B = bessel();
    let s = 0;
    if (z >= ZSWITCH) { for (let n = 0; n < NZ; n++) s += Math.exp(-B.zeros[n] * z) / B.j1[n]; return s; }
    for (let i = 0; i <= NK; i++) s += B.gk[i] * Math.cos(B.kk[i] * z);
    return s / PI;
}
function s2Pos(z) {
    const B = bessel();
    let s = 0;
    if (z >= ZSWITCH) { for (let n = 0; n < NZ; n++) s -= B.zeros[n] * Math.exp(-B.zeros[n] * z) / B.j1[n]; return s; }
    for (let i = 0; i <= NK; i++) s -= B.gk[i] * B.kk[i] * Math.sin(B.kk[i] * z);
    return s / PI;
}
/** S(ζ): axial potential of two zero-gap tubes, 0 V for ζ → −∞ and 1 V for ζ → +∞ (ζ = z/R). */
function S(z) { return z >= 0 ? sPos(z) : 1 - sPos(-z); }

// ---------------------------------------------------------------- tabulated S for the paraxial rays
const DZ = 0.0025, ZMAX = 30, MZ = Math.round(ZMAX / DZ);
let TAB = null;
function table() {
    if (TAB) return TAB;
    const s = new Float64Array(MZ + 1), s1 = new Float64Array(MZ + 1), s2 = new Float64Array(MZ + 1);
    for (let i = 0; i <= MZ; i++) { const z = i * DZ; s[i] = sPos(z); s1[i] = s1Pos(z); s2[i] = s2Pos(z); }
    TAB = { s, s1, s2 };
    return TAB;
}
const tS = (T, i) => (i >= 0 ? T.s[i] : 1 - T.s[-i]);
const tS1 = (T, i) => T.s1[i < 0 ? -i : i];
const tS2 = (T, i) => (i >= 0 ? T.s2[i] : -T.s2[-i]);

/**
 * Paraxial ray r = 1, r′ = 0 at ζ = −span through the axial potential vfun(i) → [V, V′, V″] at ζ = i·DZ
 * (classical RK4, step 2·DZ = 0.005R). Returns [r, r′, ζ_end].
 */
function paraxial(vfun, span) {
    const n0 = Math.round(span / DZ), h = 2 * DZ;
    let r = 1, rp = 0;
    const f = (i, rr, rrp, out) => { const v = vfun(i); out[0] = rrp; out[1] = -(v[1] / (2 * v[0])) * rrp - (v[2] / (4 * v[0])) * rr; };
    const k1 = [0, 0], k2 = [0, 0], k3 = [0, 0], k4 = [0, 0];
    for (let i = -n0; i < n0; i += 2) {
        f(i, r, rp, k1);
        f(i + 1, r + h / 2 * k1[0], rp + h / 2 * k1[1], k2);
        f(i + 1, r + h / 2 * k2[0], rp + h / 2 * k2[1], k3);
        f(i + 2, r + h * k3[0], rp + h * k3[1], k4);
        r += h / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
        rp += h / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    }
    return [r, rp, n0 * DZ];
}

/**
 * Axial potential of two zero-gap tubes of radius R: 0 V on the left (z < 0), 1 V on the right.
 * @param {number} zOverR z/R measured from the gap
 * @returns {number} φ(z)/V₂
 */
export function twoTubeAxial(zOverR) { return S(zOverR); }

/**
 * Paraxial focal properties of two zero-gap thin-wall tubes (diameter D), kinetic-potential ratio V2/V1,
 * in units of D from the gap, DiChio signs (F1, H1, f1 < 0 to the left; f2 > 0 converging).
 * @param {number} ratio V2/V1 (kinetic potentials)
 * @returns {{ F1: number, F2: number, f1: number, f2: number, H1: number, H2: number }}
 */
export function twoTubeExact(ratio, span = 14) {
    const T = table();
    const v = [0, 0, 0];
    const fwd = (i) => { v[0] = 1 + (ratio - 1) * tS(T, i); v[1] = (ratio - 1) * tS1(T, i); v[2] = (ratio - 1) * tS2(T, i); return v; };
    const [r, rp, ze] = paraxial(fwd, span);
    const f2 = -1 / rp, F2 = ze - r / rp;
    const rev = (i) => { v[0] = 1 + (ratio - 1) * tS(T, -i); v[1] = -(ratio - 1) * tS1(T, -i); v[2] = (ratio - 1) * tS2(T, -i); return v; };
    const [r2, rp2] = paraxial(rev, span);
    const f1 = -1 / rp2, F1 = ze - r2 / rp2;
    const out = { F1: -F1 / 2, F2: F2 / 2, f1: -f1 / 2, f2: f2 / 2 };
    out.H1 = out.F1 - out.f1;
    out.H2 = out.F2 - out.f2;
    return out;
}

/**
 * Axial potential of a zero-gap three-tube (einzel) lens: outer tubes at V1 = 1, centre tube of length A at V2 = ratio,
 * V = V1 + (V2 − V1)[S(ζ + a) − S(ζ − a)], a = A/D (the gaps at z = ±A/2 = ±(A/D)·R).
 * @param {number} zOverR @param {number} ratio V2/V1 @param {number} [AoverD]
 * @returns {number} V(z)/V1
 */
export function einzelAxial(zOverR, ratio, AoverD = 0.5) {
    return 1 + (ratio - 1) * (S(zOverR + AoverD) - S(zOverR - AoverD));
}

/**
 * Paraxial focal length and focal point (from the lens centre) of the zero-gap einzel lens, units of D.
 * @param {number} ratio V2/V1 (kinetic potentials, centre over outer) @param {number} [AoverD]
 * @returns {{ f: number, F: number }}
 */
export function einzelExact(ratio, AoverD = 0.5, span = 14) {
    const T = table();
    const off = Math.round(AoverD / DZ);
    const v = [0, 0, 0];
    const vf = (i) => {
        v[0] = 1 + (ratio - 1) * (tS(T, i + off) - tS(T, i - off));
        v[1] = (ratio - 1) * (tS1(T, i + off) - tS1(T, i - off));
        v[2] = (ratio - 1) * (tS2(T, i + off) - tS2(T, i - off));
        return v;
    };
    const [r, rp, ze] = paraxial(vf, span);
    return { f: -1 / rp / 2, F: (ze - r / rp) / 2 };
}

// ---------------------------------------------------------------- Mathieu equation
const MATHIEU_N = 40;
/** Number of eigenvalues below x of the symmetric tridiagonal matrix (diag d, off-diagonal e). */
function countBelow(d, e, x) {
    let cnt = 0, dprev = 1;
    for (let i = 0; i < d.length; i++) {
        let dc = d[i] - x - (i > 0 ? e[i - 1] * e[i - 1] / dprev : 0);
        if (dc === 0) dc = -1e-300;
        if (dc < 0) cnt++;
        dprev = dc;
    }
    return cnt;
}
function smallestEig(d, e) {
    let lo = -1e3, hi = 1e3;
    for (let it = 0; it < 200; it++) {
        const mid = 0.5 * (lo + hi);
        if (countBelow(d, e, mid) >= 1) hi = mid; else lo = mid;
        if (hi - lo < 1e-15 * Math.max(1, Math.abs(mid))) break;
    }
    return 0.5 * (lo + hi);
}
/** a₀(q): characteristic value of ce₀ (even, period π). */
function a0(q) {
    const d = new Float64Array(MATHIEU_N), e = new Float64Array(MATHIEU_N - 1);
    for (let r = 0; r < MATHIEU_N; r++) d[r] = (2 * r) * (2 * r);
    e[0] = Math.SQRT2 * q;
    for (let r = 1; r < MATHIEU_N - 1; r++) e[r] = q;
    return smallestEig(d, e);
}
/** b₁(q): characteristic value of se₁ (odd, period 2π). */
function b1(q) {
    const d = new Float64Array(MATHIEU_N), e = new Float64Array(MATHIEU_N - 1);
    d[0] = 1 - q;
    for (let r = 1; r < MATHIEU_N; r++) d[r] = (2 * r + 1) * (2 * r + 1);
    for (let r = 0; r < MATHIEU_N - 1; r++) e[r] = q;
    return smallestEig(d, e);
}
/**
 * Trace Δ = y₁(π) + y₂′(π) of the monodromy matrix of u″ + (a − 2q cos 2ξ)u = 0 (RK4, n steps over [0, π]).
 * The motion is stable for |Δ| < 2, with Δ = 2 cos(πβ).
 */
function floquetTrace(a, q, n = 4000) {
    const h = PI / n;
    const run = (x0, v0) => {
        let x = x0, v = v0, t = 0;
        for (let i = 0; i < n; i++) {
            const c0 = a - 2 * q * Math.cos(2 * t), c1 = a - 2 * q * Math.cos(2 * (t + h / 2)), c2 = a - 2 * q * Math.cos(2 * (t + h));
            const k1x = v, k1v = -c0 * x;
            const k2x = v + h / 2 * k1v, k2v = -c1 * (x + h / 2 * k1x);
            const k3x = v + h / 2 * k2v, k3v = -c1 * (x + h / 2 * k2x);
            const k4x = v + h * k3v, k4v = -c2 * (x + h * k3x);
            x += h / 6 * (k1x + 2 * k2x + 2 * k3x + k4x);
            v += h / 6 * (k1v + 2 * k2v + 2 * k3v + k4v);
            t += h;
        }
        return [x, v];
    };
    const [x1] = run(1, 0), [, v2] = run(0, 1);
    return x1 + v2;
}
/** Characteristic exponent β ∈ [0, 1] of the first stability region (NaN when unstable). */
function beta(a, q) {
    const tr = floquetTrace(a, q);
    return Math.abs(tr) <= 2 ? Math.acos(tr / 2) / PI : NaN;
}
/** Quadrupole stability: both the x equation (a, q) and the y equation (−a, −q) are stable. */
function stable(a, q) {
    return Math.abs(floquetTrace(a, q)) < 2 && Math.abs(floquetTrace(-a, -q)) < 2;
}
function bisect(f, lo, hi, it = 100) {
    let flo = f(lo);
    for (let i = 0; i < it; i++) {
        const mid = 0.5 * (lo + hi), fm = f(mid);
        if ((fm > 0) === (flo > 0)) { lo = mid; flo = fm; } else hi = mid;
    }
    return 0.5 * (lo + hi);
}
/** q where b₁(q) = 0: the a = 0 edge of the first stability region (0.908046). */
function edgeA0() { return bisect(b1, 0.8, 1.0); }
/** Apex of the first quadrupole stability region, b₁(q) = −a₀(q): { q: 0.70600, a: 0.23699 }. */
function apexPoint() {
    const q = bisect((x) => b1(x) + a0(x), 0.6, 0.8);
    return { q, a: b1(q) };
}

/**
 * Mathieu-equation helpers. a0(q), b1(q): characteristic values; floquetTrace(a, q): Δ = 2cos(πβ);
 * beta(a, q); stable(a, q) for a quadrupole (x and y); qEdgeA0 and apex: the published constants;
 * edgeA0() and apexPoint() recompute them.
 */
export const mathieu = Object.freeze({
    a0, b1, floquetTrace, beta, stable, edgeA0, apexPoint,
    qEdgeA0: 0.908046,
    apex: Object.freeze({ q: 0.70600, a: 0.23699 }),
});

// ---------------------------------------------------------------- capacitors, mirrors, kinematics
/** Coaxial cylinders: potential at radius r. */
export function coaxV(r, { a, b, Va, Vb }) { return Va + (Vb - Va) * Math.log(r / a) / Math.log(b / a); }

/** Concentric spheres: potential A/r + B at radius r. */
export function sphereV(r, { R1, R2, V1, V2 }) {
    const A = (V1 - V2) / (1 / R1 - 1 / R2), B = V1 - A / R1;
    return A / r + B;
}

/** Parallel-plate mirror (gap d, retarding voltage V, entry angle θ to the plates): range 2d(KE/qV)sin 2θ. */
export function mirrorRange(dMm, keEV, retardV, thetaDeg) { return 2 * dMm * (keEV / retardV) * Math.sin(2 * thetaDeg * PI / 180); }

/** Parallel-plate mirror: maximum penetration depth d(KE/qV)sin²θ. */
export function mirrorDepth(dMm, keEV, retardV, thetaDeg) { const s = Math.sin(thetaDeg * PI / 180); return dMm * (keEV / retardV) * s * s; }

/** Speed (mm/µs) of a particle of kinetic energy keEV (eV) and mass massU (u), nonrelativistic. */
function speed(keEV, massU) { return Math.sqrt(2 * K_ACC * keEV / massU); }

/**
 * Transit of a uniform gap: start with ke0EV along the field, accelerated through dV over gapMm.
 * @returns {{ tUs: number, vMMus: number }}
 */
export function uniformTransit({ gapMm, dV, massU, chargeE = 1, ke0EV = 0 }) {
    const a = K_ACC * (chargeE / massU) * (dV / gapMm);
    const v0 = speed(ke0EV, massU);
    const v = Math.sqrt(v0 * v0 + 2 * a * gapMm);
    return { tUs: 2 * gapMm / (v0 + v), vMMus: v };
}

/** Field-free drift time (µs) over lMm at keEV for massU. */
export function driftTime(lMm, keEV, massU) { return lMm / speed(keEV, massU); }

/**
 * Uniform field E(t) = E0 sin(Ωt), particle at rest at t = 0: x(t) = (a0/Ω²)(Ωt − sin Ωt), a0 = K(q/m)E0.
 * @returns {number} displacement in mm
 */
export function rfUniformDisplacement({ e0VMm, freqMHz, massU, chargeE = 1, tUs }) {
    const a0v = K_ACC * (chargeE / massU) * e0VMm, w = 2 * PI * freqMHz;
    return a0v / (w * w) * (w * tUs - Math.sin(w * tUs));
}

/**
 * Uniform field switched by a trapezoidal pulse (0 before t0, linear rise, flat width, linear fall, 0 after),
 * particle at rest at x = 0 at t = 0: x(t) = a0∫₀^t (t − s)g(s) ds, integrated exactly piece by piece.
 * @returns {number} position in mm at tUs
 */
export function pulseRampPosition({ e0VMm, t0, rise, width, fall, massU, chargeE = 1, tUs }) {
    const a0v = K_ACC * (chargeE / massU) * e0VMm;
    const knots = [[t0, 0], [t0 + rise, 1], [t0 + rise + width, 1], [t0 + rise + width + fall, 0]];
    let x = 0;
    for (let p = 0; p < 3; p++) {
        const [sa, ga] = knots[p], [sb, gb] = knots[p + 1];
        if (!(sb > sa) || tUs <= sa) continue;
        const m = (gb - ga) / (sb - sa);
        const U = Math.min(tUs, sb) - sa, T = tUs - sa;
        // ∫0^U (T − u)(ga + m u) du
        x += ga * (T * U - U * U / 2) + m * (T * U * U / 2 - U * U * U / 3);
    }
    return a0v * x;
}

/**
 * Quadrupole mass filter voltages for a stability point (a, q): rods at ±(U − V cos Ωt),
 * a = 8KzU/(m r0² Ω²), q = 4KzV/(m r0² Ω²).
 * @returns {{ U: number, V: number }}
 */
export function qmfVoltages({ massU, r0, freqMHz, a, q, chargeE = 1 }) {
    const w = 2 * PI * freqMHz, k = massU * r0 * r0 * w * w / (K_ACC * chargeE);
    return { U: a * k / 8, V: q * k / 4 };
}

/**
 * Low-mass cut-off of a Paul trap (ring at V0 cos Ωt, endcaps grounded): |q_z| = 8KzV0/(m(r0² + 2z0²)Ω²) = 0.908046.
 * @returns {number} mass in u
 */
export function paulLMCO({ r0, z0, freqMHz, v0, chargeE = 1 }) {
    const w = 2 * PI * freqMHz;
    return 8 * K_ACC * chargeE * v0 / (mathieu.qEdgeA0 * (r0 * r0 + 2 * z0 * z0) * w * w);
}

/**
 * One-dimensional time of flight of a single-stage reflectron: uniform source field eSrcVMm over sMm (start with
 * ke0EV along the axis), field-free drift outMm, ideal uniform mirror eMirrorVMm (in and out), drift backMm.
 * @returns {number} µs
 */
export function reflectronTof({ massU, chargeE = 1, sMm, eSrcVMm, outMm, backMm, eMirrorVMm, ke0EV = 0 }) {
    const a1 = K_ACC * (chargeE / massU) * eSrcVMm;
    const v0 = speed(ke0EV, massU);
    const v1 = Math.sqrt(v0 * v0 + 2 * a1 * sMm);
    const tAcc = (v1 - v0) / a1;
    const a2 = K_ACC * (chargeE / massU) * eMirrorVMm;
    return tAcc + outMm / v1 + 2 * v1 / a2 + backMm / v1;
}
