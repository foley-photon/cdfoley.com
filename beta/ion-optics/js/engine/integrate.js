/* ==========================================================================
   Ion optics engine: integrate.js
   Generic integrators for the equations of motion and their tests.

   Dormand-Prince 5(4) with FSAL: Dormand & Prince, J. Comput. Appl. Math. 6,
   19 (1980). Continuous extension (dense output of order 4/5): Hairer,
   Nørsett & Wanner, Solving Ordinary Differential Equations I, 2nd ed.,
   §II.6 (the "contd5" coefficients). Classical Runge-Kutta 4.
   Boris push with exact gyration phase (tan correction) and relativistic
   proper velocity: Boris, Proc. 4th Conf. Numer. Simul. Plasmas (1970);
   Qin et al., Phys. Plasmas 20, 084503 (2013); Zenitani & Umeda, Phys.
   Plasmas 25, 112110 (2018).

   The production tracer (trace.js) inlines the same tableau for its 6-component
   state; these exported routines are the reference implementation.
   ========================================================================== */
import { K_ACC, C_MMUS } from './constants.js';

const C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];
const A = [[], [1 / 5], [3 / 40, 9 / 40], [44 / 45, -56 / 15, 32 / 9],
    [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
    [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
    [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84]];
const B = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0];
const BS = [5179 / 57600, 0, 7571 / 16695, 393 / 640, -92097 / 339200, 187 / 2100, 1 / 40];
const E = [71 / 57600, 0, -71 / 16695, 71 / 1920, -17253 / 339200, 22 / 525, -1 / 40];
const D = [-12715105075 / 11282082432, 0, 87487479700 / 32700410799, -10690763975 / 1880347072,
    701980252875 / 199316789632, -1453857185 / 822651844, 69997945 / 29380423];

/** Dormand-Prince 5(4) tableau (Appendix A of the specification). */
export const DP45 = Object.freeze({
    c: Object.freeze(C.slice()), a: Object.freeze(A.map((r) => Object.freeze(r.slice()))),
    b: Object.freeze(B.slice()), bStar: Object.freeze(BS.slice()), e: Object.freeze(E.slice()), d: Object.freeze(D.slice()),
});

/**
 * One Dormand-Prince 5(4) step of y' = f(t, y). f(t, y, dydt) writes the derivative.
 * On entry k[0] must hold f(t, y) (first-same-as-last); on return k[6] = f(t + dt, yNew),
 * yNew is the 5th-order solution and errVec = dt·Σ (b_i − b*_i) k_i.
 * @param {(t: number, y: Float64Array, dydt: Float64Array) => void} f @param {number} t @param {Float64Array} y @param {number} dt
 * @param {Float64Array[]} k seven stage arrays @param {Float64Array} yNew @param {Float64Array} errVec
 */
export function dp45Step(f, t, y, dt, k, yNew, errVec) {
    const n = y.length;
    for (let s = 1; s < 7; s++) {
        const as = A[s];
        for (let i = 0; i < n; i++) {
            let acc = 0;
            for (let j = 0; j < s; j++) acc += as[j] * k[j][i];
            yNew[i] = y[i] + dt * acc;
        }
        f(t + C[s] * dt, yNew, k[s]);
    }
    if (errVec) {
        for (let i = 0; i < n; i++) {
            let acc = 0;
            for (let j = 0; j < 7; j++) acc += E[j] * k[j][i];
            errVec[i] = dt * acc;
        }
    }
}

/**
 * Hairer's continuous extension of a DP45 step from y0 (θ = 0) to y1 (θ = 1).
 * @param {number} theta @param {Float64Array} y0 @param {Float64Array} y1 @param {Float64Array[]} k @param {number} dt @param {Float64Array} out
 */
export function dp45Dense(theta, y0, y1, k, dt, out) {
    const n = y0.length, th1 = 1 - theta;
    for (let i = 0; i < n; i++) {
        const r1 = y0[i], r2 = y1[i] - y0[i], r3 = dt * k[0][i] - r2, r4 = r2 - dt * k[6][i] - r3;
        let s5 = 0;
        for (let j = 0; j < 7; j++) s5 += D[j] * k[j][i];
        const r5 = dt * s5;
        out[i] = r1 + theta * (r2 + th1 * (r3 + theta * (r4 + th1 * r5)));
    }
    return out;
}

/**
 * Classical Runge-Kutta 4 step. k: at least four stage arrays; yNew is also used as scratch.
 */
export function rk4Step(f, t, y, dt, k, yNew) {
    const n = y.length, k0 = k[0], k1 = k[1], k2 = k[2], k3 = k[3];
    f(t, y, k0);
    for (let i = 0; i < n; i++) yNew[i] = y[i] + 0.5 * dt * k0[i];
    f(t + 0.5 * dt, yNew, k1);
    for (let i = 0; i < n; i++) yNew[i] = y[i] + 0.5 * dt * k1[i];
    f(t + 0.5 * dt, yNew, k2);
    for (let i = 0; i < n; i++) yNew[i] = y[i] + dt * k2[i];
    f(t + dt, yNew, k3);
    for (let i = 0; i < n; i++) yNew[i] = y[i] + dt / 6 * (k0[i] + 2 * k1[i] + 2 * k2[i] + k3[i]);
}

/**
 * Rotates w (3-vector) about the signed angular-velocity vector Ω (rad/µs) over time tau with the
 * exact angle |Ω|·tau (Boris tan correction). Writes into w.
 */
export function borisRotate(w, ox, oy, oz, tau) {
    const om = Math.sqrt(ox * ox + oy * oy + oz * oz);
    if (!(om > 0)) return w;
    const tf = Math.tan(0.5 * om * tau) / om;
    const tx = ox * tf, ty = oy * tf, tz = oz * tf;
    const sf = 2 / (1 + tx * tx + ty * ty + tz * tz), sx = tx * sf, sy = ty * sf, sz = tz * sf;
    const w0 = w[0], w1 = w[1], w2 = w[2];
    const px = w0 + (w1 * tz - w2 * ty), py = w1 + (w2 * tx - w0 * tz), pz = w2 + (w0 * ty - w1 * tx);
    w[0] = w0 + (py * sz - pz * sy); w[1] = w1 + (pz * sx - px * sz); w[2] = w2 + (px * sy - py * sx);
    return w;
}

/**
 * One Boris step: state.w is the proper velocity at t − dt/2, state.x the position at t; E3 (V/mm) and
 * B3 (T) are taken at state.x. Advances to w(t + dt/2), x(t + dt). qOverM in e/u (K_ACC applied here).
 * Ω = K_ACC(q/m)B/γ⁻ is a signed vector, rotation angle |Ω|dt exact.
 * @param {{ x: Float64Array|number[], w: Float64Array|number[] }} state
 */
export function borisPush(state, dt, E3, B3, qOverM, relativistic) {
    const x = state.x, w = state.w, kq = K_ACC * qOverM, h = 0.5 * dt * kq;
    w[0] += h * E3[0]; w[1] += h * E3[1]; w[2] += h * E3[2];
    const ig = relativistic ? 1 / Math.sqrt(1 + (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]) / (C_MMUS * C_MMUS)) : 1;
    borisRotate(w, kq * B3[0] * ig, kq * B3[1] * ig, kq * B3[2] * ig, dt);
    w[0] += h * E3[0]; w[1] += h * E3[1]; w[2] += h * E3[2];
    const ig2 = relativistic ? 1 / Math.sqrt(1 + (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]) / (C_MMUS * C_MMUS)) : 1;
    x[0] += dt * w[0] * ig2; x[1] += dt * w[1] * ig2; x[2] += dt * w[2] * ig2;
    return state;
}

const PRESETS = Object.freeze({
    draft: Object.freeze({ rtol: 1e-6, maxStepCells: 1.0, nearStepCells: 0.25, rfStepsPerPeriod: 24, borisStepsPerGyration: 64 }),
    normal: Object.freeze({ rtol: 1e-8, maxStepCells: 0.5, nearStepCells: 0.1, rfStepsPerPeriod: 32, borisStepsPerGyration: 128 }),
    fine: Object.freeze({ rtol: 1e-10, maxStepCells: 0.25, nearStepCells: 0.05, rfStepsPerPeriod: 64, borisStepsPerGyration: 256 }),
});

/**
 * Trajectory-accuracy preset numbers ('draft' | 'normal' | 'fine'; anything else gives 'normal').
 * @returns {{ rtol: number, maxStepCells: number, nearStepCells: number, rfStepsPerPeriod: number, borisStepsPerGyration: number }}
 */
export function qualityPreset(name) {
    return { ...(PRESETS[name] || PRESETS.normal) };
}
