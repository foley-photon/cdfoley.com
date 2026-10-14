/* ==========================================================================
   Ion optics engine: trace.js
   Particle tracer: equations of motion, integrators, events and energy
   diagnostics (specification §3.7-§3.9, §3.11(1)).

   Equations of motion in proper velocity w = γv (relativistic) or v:
   dx/dt = w/γ, dw/dt = K_ACC(q/m)(E + (w/γ) × B), γ = √(1 + |w|²/c²)
   (Jackson, Classical Electrodynamics, 3rd ed., §12.1).

   Integrators:
   - Dormand-Prince 5(4) with FSAL and Hairer's continuous extension:
     Dormand & Prince, J. Comput. Appl. Math. 6, 19 (1980); Hairer, Nørsett
     & Wanner, Solving Ordinary Differential Equations I, 2nd ed., §II.4-II.6
     (step-size control, dense output).
   - Signed, gyrophase-exact relativistic Boris push: Boris, Proc. 4th Conf.
     Numer. Simul. Plasmas (1970); Qin et al., Phys. Plasmas 20, 084503
     (2013); Zenitani & Umeda, Phys. Plasmas 25, 112110 (2018). Leapfrog
     restarts use exact half-step velocity updates.
   - Classical Runge-Kutta 4 (tests).
   Events are located on the dense path of each accepted step: electrode hits
   on short chords with bisection, test planes by the Illinois variant of
   regula falsi (Dowell & Jarratt, BIT 11, 168 (1971)) with a golden-section
   check for tangent double crossings (Kiefer, Proc. AMS 4, 502 (1953)).
   Mesh transmission uses counter-based random numbers (rng.js), so results
   never depend on batching.
   Physics plug-ins (off by default; improvement plan, package WP-F): Stokes
   drag a −= (v − v_gas)/τ, τ = K_mob M/(K_ACC |q|) (spec §3.12), and
   hard-sphere collisions with a background gas (gas.js): a per-particle
   exponential collision budget is spent at the rate ν(v) = n σ ⟨g⟩ along each
   step (trapezoid of the start and end rates); the step that would exhaust it
   is shortened to end at the collision, which then changes the velocity;
   steps are capped at 1/(10 ν). Budget and partner come from one counter-based
   stream per particle id, so results stay independent of batching.
   ========================================================================== */
import { K_ACC, C_MMUS, properSpeedFromKE, speedFromKE } from './constants.js';
import { uniform01 } from './rng.js';
import { createGasModel, gasStream } from './gas.js';
import {
    P_STRIDE, P_ID, P_SRC, P_SPECIES, P_MASS, P_CHARGE, P_T0, P_X, P_Y, P_Z, P_WX, P_WY, P_WZ, P_KE,
    S_STRIDE, S_ID, S_STATUS, S_WHERE, S_T, S_X, S_Y, S_Z, S_VX, S_VY, S_VZ, S_KE, S_TOF, S_STEPS, S_PATH,
    S_DE_END, S_DE_MAX, S_WORK, S_NCROSS, S_TBAND, S_FLAGS, S_SRC, S_SPECIES, S_KE0, S_T0,
    C_STRIDE, C_ID, C_PLANE, C_T, C_X, C_Y, C_Z, C_VX, C_VY, C_VZ, C_KE, C_DIR, C_K, C_KIND, C_ELEC,
    STATUS, EDGE, FLAG,
} from './layout.js';
import { qualityPreset } from './integrate.js';

const INV_C2 = 1 / (C_MMUS * C_MMUS);
const UC2 = C_MMUS * C_MMUS / K_ACC;          // eV per u (rest energy)
const TWO_PI = 2 * Math.PI;
const MESH_A = 0x7f4a7c15;                       // RNG stream for mesh transmission rolls
const GOLD = 0.3819660112501051;                 // 2 − golden ratio
const MAX_PLANE_ROWS = 1000;                     // crossings kept per particle and plane ('all'), at most
const MAX_MESH_ROWS = 1000;                      // mesh crossings kept per particle, at most
/** Crossing rows a whole run may keep ('all' planes and meshes); the per-particle cap is min(1000, floor(budget / n)). */
export const CROSS_BUDGET = 2e6;
/** Per-particle cap on 'all'-plane and mesh rows for a run of n particles (the same in every chunk of the run). */
export function crossCapFor(n) { return Math.max(1, Math.min(MAX_PLANE_ROWS, Math.floor(CROSS_BUDGET / Math.max(1, n)))); }
const MAX_SAMPLES = 1024;

// Dormand-Prince 5(4) tableau (Appendix A)
const c2 = 1 / 5, c3 = 3 / 10, c4 = 4 / 5, c5 = 8 / 9;
const a21 = 1 / 5, a31 = 3 / 40, a32 = 9 / 40, a41 = 44 / 45, a42 = -56 / 15, a43 = 32 / 9,
    a51 = 19372 / 6561, a52 = -25360 / 2187, a53 = 64448 / 6561, a54 = -212 / 729,
    a61 = 9017 / 3168, a62 = -355 / 33, a63 = 46732 / 5247, a64 = 49 / 176, a65 = -5103 / 18656;
const b1 = 35 / 384, b3 = 500 / 1113, b4 = 125 / 192, b5 = -2187 / 6784, b6 = 11 / 84;
const e1 = 71 / 57600, e3 = -71 / 16695, e4 = 71 / 1920, e5 = -17253 / 339200, e6 = 22 / 525, e7 = -1 / 40;
const d1 = -12715105075 / 11282082432, d3 = 87487479700 / 32700410799, d4 = -10690763975 / 1880347072,
    d5 = 701980252875 / 199316789632, d6 = -1453857185 / 822651844, d7 = 69997945 / 29380423;

// event kinds and tie priorities (lower first at equal τ): non-terminating, then hit, absorbed, exit, detector
const EV_PLANE = 0, EV_MESH = 1, EV_HIT = 2, EV_ABSORB = 3, EV_EXIT = 4, EV_DRIFT = 5, EV_DETECT = 6;
const EV_PRIO = [0, 0, 1, 2, 3, 3, 4];
const EV_CAP = 512;

const INTEG_RK45 = 0, INTEG_BORIS = 1, INTEG_RK4 = 2;

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const posNum = (v, d) => (typeof v === 'number' && v > 0 && Number.isFinite(v) ? v : d);

// ---------------------------------------------------------------- DP45 stage combinations (unrolled, module level so they inline)
function dpStage1(Y, YT, h, K0) {
    const p = h * a21;
    YT[0] = Y[0] + p * K0[0]; YT[1] = Y[1] + p * K0[1]; YT[2] = Y[2] + p * K0[2];
    YT[3] = Y[3] + p * K0[3]; YT[4] = Y[4] + p * K0[4]; YT[5] = Y[5] + p * K0[5];
}
function dpStage2(Y, YT, h, K0, K1) {
    const p = h * a31, q = h * a32;
    YT[0] = Y[0] + p * K0[0] + q * K1[0]; YT[1] = Y[1] + p * K0[1] + q * K1[1]; YT[2] = Y[2] + p * K0[2] + q * K1[2];
    YT[3] = Y[3] + p * K0[3] + q * K1[3]; YT[4] = Y[4] + p * K0[4] + q * K1[4]; YT[5] = Y[5] + p * K0[5] + q * K1[5];
}
function dpStage3(Y, YT, h, K0, K1, K2) {
    const p = h * a41, q = h * a42, r = h * a43;
    YT[0] = Y[0] + p * K0[0] + q * K1[0] + r * K2[0]; YT[1] = Y[1] + p * K0[1] + q * K1[1] + r * K2[1];
    YT[2] = Y[2] + p * K0[2] + q * K1[2] + r * K2[2]; YT[3] = Y[3] + p * K0[3] + q * K1[3] + r * K2[3];
    YT[4] = Y[4] + p * K0[4] + q * K1[4] + r * K2[4]; YT[5] = Y[5] + p * K0[5] + q * K1[5] + r * K2[5];
}
function dpStage4(Y, YT, h, K0, K1, K2, K3) {
    const p = h * a51, q = h * a52, r = h * a53, s = h * a54;
    YT[0] = Y[0] + p * K0[0] + q * K1[0] + r * K2[0] + s * K3[0]; YT[1] = Y[1] + p * K0[1] + q * K1[1] + r * K2[1] + s * K3[1];
    YT[2] = Y[2] + p * K0[2] + q * K1[2] + r * K2[2] + s * K3[2]; YT[3] = Y[3] + p * K0[3] + q * K1[3] + r * K2[3] + s * K3[3];
    YT[4] = Y[4] + p * K0[4] + q * K1[4] + r * K2[4] + s * K3[4]; YT[5] = Y[5] + p * K0[5] + q * K1[5] + r * K2[5] + s * K3[5];
}
function dpStage5(Y, YT, h, K0, K1, K2, K3, K4) {
    const p = h * a61, q = h * a62, r = h * a63, s = h * a64, u = h * a65;
    YT[0] = Y[0] + p * K0[0] + q * K1[0] + r * K2[0] + s * K3[0] + u * K4[0]; YT[1] = Y[1] + p * K0[1] + q * K1[1] + r * K2[1] + s * K3[1] + u * K4[1];
    YT[2] = Y[2] + p * K0[2] + q * K1[2] + r * K2[2] + s * K3[2] + u * K4[2]; YT[3] = Y[3] + p * K0[3] + q * K1[3] + r * K2[3] + s * K3[3] + u * K4[3];
    YT[4] = Y[4] + p * K0[4] + q * K1[4] + r * K2[4] + s * K3[4] + u * K4[4]; YT[5] = Y[5] + p * K0[5] + q * K1[5] + r * K2[5] + s * K3[5] + u * K4[5];
}
function dpSolution(Y, YN, h, K0, K2, K3, K4, K5) {
    const p = h * b1, r = h * b3, s = h * b4, u = h * b5, v = h * b6;
    YN[0] = Y[0] + p * K0[0] + r * K2[0] + s * K3[0] + u * K4[0] + v * K5[0]; YN[1] = Y[1] + p * K0[1] + r * K2[1] + s * K3[1] + u * K4[1] + v * K5[1];
    YN[2] = Y[2] + p * K0[2] + r * K2[2] + s * K3[2] + u * K4[2] + v * K5[2]; YN[3] = Y[3] + p * K0[3] + r * K2[3] + s * K3[3] + u * K4[3] + v * K5[3];
    YN[4] = Y[4] + p * K0[4] + r * K2[4] + s * K3[4] + u * K4[4] + v * K5[4]; YN[5] = Y[5] + p * K0[5] + r * K2[5] + s * K3[5] + u * K4[5] + v * K5[5];
}
/** Squared norms of the embedded error estimate: position part into ERR2[0], proper-velocity part into ERR2[1]. */
function dpError2(h, K0, K2, K3, K4, K5, K6, ERR2) {
    const p = h * e1, r = h * e3, s = h * e4, u = h * e5, v = h * e6, w = h * e7;
    const x0 = p * K0[0] + r * K2[0] + s * K3[0] + u * K4[0] + v * K5[0] + w * K6[0];
    const x1 = p * K0[1] + r * K2[1] + s * K3[1] + u * K4[1] + v * K5[1] + w * K6[1];
    const x2 = p * K0[2] + r * K2[2] + s * K3[2] + u * K4[2] + v * K5[2] + w * K6[2];
    const x3 = p * K0[3] + r * K2[3] + s * K3[3] + u * K4[3] + v * K5[3] + w * K6[3];
    const x4 = p * K0[4] + r * K2[4] + s * K3[4] + u * K4[4] + v * K5[4] + w * K6[4];
    const x5 = p * K0[5] + r * K2[5] + s * K3[5] + u * K4[5] + v * K5[5] + w * K6[5];
    ERR2[0] = x0 * x0 + x1 * x1 + x2 * x2; ERR2[1] = x3 * x3 + x4 * x4 + x5 * x5;
}

// indices of the tracer's typed state arrays
const V_T = 0, V_PATH = 1, V_WORK = 2, V_DEMAX = 3, V_KE = 4, V_STEP = 5, V_PDT = 6, V_TBAND = 7, V_DRIFT = 8, V_E0 = 9,
    V_MINSEG = 10, V_LX = 11, V_LY = 12, V_LZ = 13, V_LT = 14, V_LDX = 15, V_LDY = 16, V_LDZ = 17,
    V_VB = 18, V_HLIM = 19, V_PLIM = 20, V_REACH = 21, V_NUS = 22 /* gas collision rate at the step start */, V_GASB = 23 /* collision budget left */;
const QX = 0, QY = 1, QZ = 2, QVX = 3, QVY = 4, QVZ = 5, QWX = 6, QWY = 7, QWZ = 8;
const HX0 = 0, HY0 = 1, HZ0 = 2, HVX0 = 3, HVY0 = 4, HVZ0 = 5, HX1 = 6, HY1 = 7, HZ1 = 8, HVX1 = 9, HVY1 = 10, HVZ1 = 11;
const FEX = 0, FEY = 1, FEZ = 2, FPHI = 3, FBX = 4, FBY = 5, FBZ = 6;

/**
 * Builds traceParticles options from a resolved project (helper for pipeline.js and the worker).
 * `overrides` are shallow-merged (its `record` is merged into the record settings).
 * @param {object} resolved @param {object} [overrides]
 * @returns {object} options for traceParticles
 */
export function traceOptions(resolved, overrides = {}) {
    const r = resolved || {};
    const tr = r.tracer || {};
    const q = tr.q || (tr.quality === 'custom' && tr.custom ? tr.custom : qualityPreset(tr.quality));
    const rec = r.recording || {};
    const trj = rec.trajectories || {};
    const base = {
        integrator: tr.integrator || 'auto',
        rtol: q.rtol, maxStepCells: q.maxStepCells, nearStepCells: q.nearStepCells,
        rfStepsPerPeriod: q.rfStepsPerPeriod, borisStepsPerGyration: q.borisStepsPerGyration, dt: q.dt || null,
        relativistic: tr.relativistic !== false,
        tMax: num(tr.tMax, 1000), maxSteps: num(tr.maxSteps, 500000), maxDrift: num(tr.maxDrift, 10000),
        planes: Array.isArray(rec.planes) ? rec.planes : [],
        beyond: (r.domain && r.domain.beyond) || {},
        seed: num(tr.seed, 1),
        record: {
            trajectories: trj.store !== false, maxPoints: posNum(trj.maxPoints, 2000),
            markersDt: rec.timeMarkers && rec.timeMarkers.dt > 0 ? rec.timeMarkers.dt : null,
        },
        energyCheck: true,
        drag: tr.drag || null,
        gas: tr.gas || null,
    };
    const out = { ...base, ...overrides };
    out.record = { ...base.record, ...(overrides.record || {}) };
    return out;
}

function normalizeOptions(opts) {
    const o = opts || {};
    const q = qualityPreset(o.quality || 'normal');
    const maxStepCells = Math.min(1, posNum(o.maxStepCells, q.maxStepCells));
    const nearStepCells = Math.min(maxStepCells, posNum(o.nearStepCells, q.nearStepCells));
    const rec = o.record || {};
    const integ = o.integrator === 'rk45' || o.integrator === 'dp45' ? 'rk45' : (o.integrator === 'boris' || o.integrator === 'rk4' ? o.integrator : 'auto');
    const minSeg = num(rec.minSegCells, 0.5);
    return {
        integrator: integ,
        rtol: posNum(o.rtol, q.rtol),
        maxStepCells, nearStepCells,
        rfStepsPerPeriod: posNum(o.rfStepsPerPeriod, q.rfStepsPerPeriod),
        borisStepsPerGyration: posNum(o.borisStepsPerGyration, q.borisStepsPerGyration),
        dt: posNum(o.dt, 0),
        relativistic: o.relativistic !== false,
        tMax: posNum(o.tMax, 1000),
        maxSteps: Math.max(1, Math.floor(posNum(o.maxSteps, 500000))),
        maxDrift: posNum(o.maxDrift, 10000),
        planes: Array.isArray(o.planes) ? o.planes : [],
        beyond: o.beyond || {},
        seed: num(o.seed, 1),
        record: {
            trajectories: rec.trajectories !== false,
            maxPoints: Math.max(2, Math.floor(posNum(rec.maxPoints, 2000))),
            pointBudget: Math.max(2, Math.floor(posNum(rec.pointBudget, 2e6))),
            minSegCells: minSeg >= 0 ? minSeg : 0.5,
            maxTurnDeg: posNum(rec.maxTurnDeg, 2),
            everyStep: !!rec.everyStep,
            markersDt: posNum(rec.markersDt, 0),
            crossCap: posNum(rec.crossCap, MAX_PLANE_ROWS),
        },
        energyCheck: o.energyCheck !== false,
        drag: o.drag && o.drag.type === 'stokes' && o.drag.mobility > 0 ? o.drag : null,
        // hard-sphere gas: off when absent, disabled, or at zero pressure
        gas: o.gas && o.gas.enabled !== false && o.gas.pressure > 0 && o.gas.temperature > 0 && o.gas.mass > 0 && o.gas.diameter > 0 ? o.gas : null,
        i0: typeof o.i0 === 'number' ? o.i0 : null,
        debugRegions: !!o.debugRegions,
    };
}

/** Compiles recording planes into flat arrays. */
function compilePlanes(list, h) {
    const n = list.length;
    const P = {
        n, kind: new Int8Array(n), at: new Float64Array(n), p0x: new Float64Array(n), p0y: new Float64Array(n), p0z: new Float64Array(n),
        nx: new Float64Array(n), ny: new Float64Array(n), ux: new Float64Array(n), uy: new Float64Array(n), len: new Float64Array(n),
        term: new Uint8Array(n), side: new Int8Array(n), all: new Uint8Array(n),
        aMin: new Float64Array(n), aMax: new Float64Array(n), bMin: new Float64Array(n), bMax: new Float64Array(n), rad: new Float64Array(n),
        tolS: 1e-9 * h,
    };
    // sphere: a spherical test surface g = |P − center| − at (radius `at`, center [x, y, z]); forward = outward
    const KIND = { x: 0, y: 1, z: 2, r: 3, segment: 4, sphere: 5 };
    for (let i = 0; i < n; i++) {
        const pl = list[i] || {};
        const k = KIND[pl.kind] !== undefined ? KIND[pl.kind] : 0;
        P.kind[i] = k;
        P.at[i] = num(pl.at, 0);
        if (k === 4) {
            const p0 = pl.p0 || [0, 0], p1 = pl.p1 || [1, 0];
            const x0 = num(p0[0], 0), y0 = num(p0[1], 0), dx = num(p1[0], 1) - x0, dy = num(p1[1], 0) - y0;
            const L = Math.sqrt(dx * dx + dy * dy) || 1;
            P.p0x[i] = x0; P.p0y[i] = y0; P.ux[i] = dx / L; P.uy[i] = dy / L; P.len[i] = L;
            P.nx[i] = dy / L; P.ny[i] = -dx / L;   // (p1 − p0) rotated −90°
        } else if (k === 5) {
            const c = Array.isArray(pl.center) ? pl.center : [0, 0, 0];
            P.p0x[i] = num(c[0], 0); P.p0y[i] = num(c[1], 0); P.p0z[i] = num(c[2], 0);
        }
        P.term[i] = pl.terminate ? 1 : 0;
        P.side[i] = pl.side === 'forward' ? 1 : (pl.side === 'backward' ? 2 : 0);
        P.all[i] = pl.record === 'all' ? 1 : 0;
        const lim = pl.limits || null;
        const la = lim && Array.isArray(lim.a) ? lim.a : null, lb = lim && Array.isArray(lim.b) ? lim.b : null;
        P.aMin[i] = la ? num(la[0], -Infinity) : -Infinity; P.aMax[i] = la ? num(la[1], Infinity) : Infinity;
        P.bMin[i] = lb ? num(lb[0], -Infinity) : -Infinity; P.bMax[i] = lb ? num(lb[1], Infinity) : Infinity;
        P.rad[i] = pl.radius > 0 ? pl.radius : Infinity;
    }
    return P;
}

/**
 * Whether a crossing of compiled plane i at (x, y, z) in direction dir (+1 forward, −1 backward) passes the side,
 * extent, limits and radius filters. The limit coordinates (a, b) are: x plane (y, z); y plane (x, z); z plane (x, y);
 * r plane (x, −); sphere (axial offset from the center, distance from the center's x axis); segment (distance along
 * the segment from p0, z when planar). One definition for both tracers (trace.js and coulomb.js).
 */
function acceptCrossing(P, cyl, i, x, y, z, dir) {
    const sd = P.side[i];
    if ((sd === 1 && dir < 0) || (sd === 2 && dir > 0)) return false;
    let a = 0, b = 0, r2 = 0;
    switch (P.kind[i]) {
        case 0: a = y; b = z; r2 = y * y + z * z; break;
        case 1: a = x; b = z; r2 = x * x + z * z; break;
        case 2: a = x; b = y; r2 = x * x + y * y; break;
        case 3: a = x; b = NaN; r2 = 0; break;
        case 5: {   // a = axial offset from the center, b = distance from the center's x axis; no radius filter
            const dy = y - P.p0y[i], dz = z - P.p0z[i];
            a = x - P.p0x[i]; b = Math.sqrt(dy * dy + dz * dz); r2 = 0;
            break;
        }
        default: {
            const r = cyl ? Math.sqrt(y * y + z * z) : y;
            a = (x - P.p0x[i]) * P.ux[i] + (r - P.p0y[i]) * P.uy[i];
            if (a < -P.tolS || a > P.len[i] + P.tolS) return false;
            b = cyl ? NaN : z; r2 = 0;
        }
    }
    if (a < P.aMin[i] || a > P.aMax[i]) return false;
    if (b === b && (b < P.bMin[i] || b > P.bMax[i])) return false;
    if (P.rad[i] < Infinity && r2 > P.rad[i] * P.rad[i]) return false;
    return true;
}

/**
 * Crossing filter of a list of recording planes (the one the tracer applies): accept(i, x, y, z, dir) → boolean.
 * @param {object[]} planes recording planes (resolved) @param {number} h grid cell (mm) @param {boolean} cyl cylindrical model
 * @returns {(i: number, x: number, y: number, z: number, dir: number) => boolean}
 */
export function planeAcceptor(planes, h, cyl) {
    const P = compilePlanes(Array.isArray(planes) ? planes : [], h > 0 ? h : 1);
    const c = !!cyl;
    return (i, x, y, z, dir) => acceptCrossing(P, c, i, x, y, z, dir);
}

/**
 * Traces particles through a FieldModel.
 * @param {object} model FieldModel (fieldmodel.js)
 * @param {Float64Array} particles P_STRIDE rows (particles.js generate)
 * @param {object} [opts] see specification §2.3; extras: quality, i0, debugRegions
 * @param {{ shouldStop?: () => boolean, onProgress?: (p: { done: number, total: number }) => void, progressEveryMs?: number }} [hooks]
 * @returns {{ n: number, i0: number, summary: Float64Array, crossings: Float64Array, nCross: number,
 *   traj: { offsets: Uint32Array, pts: Float32Array } | null, markers: Float32Array | null,
 *   stats: { steps: number, rejects: number, evals: number, ms: number, edgeSplits: number, regionViolations: number } }}
 *   traj.offsets[i] is the index (in points of 4 floats) of particle i's first point.
 */
export function traceParticles(model, particles, opts = {}, hooks = {}) {
    const t0ms = performance.now();
    const o = normalizeOptions(opts);
    const n = particles ? Math.floor(particles.length / P_STRIDE) : 0;
    const tracer = createTracer(model, o, n);
    const stop = hooks && typeof hooks.shouldStop === 'function' ? hooks.shouldStop : null;
    const onProgress = hooks && typeof hooks.onProgress === 'function' ? hooks.onProgress : null;
    const every = hooks && hooks.progressEveryMs > 0 ? hooks.progressEveryMs : 100;
    tracer.setStop(stop);
    let cancelled = false, last = t0ms;
    for (let p = 0; p < n; p++) {
        if (!cancelled && stop !== null && stop()) cancelled = true;
        if (cancelled) { tracer.cancelRow(particles, p); continue; }
        if (!tracer.traceOne(particles, p)) cancelled = true;
        if (onProgress !== null) {
            const now = performance.now();
            if (now - last >= every) { last = now; onProgress({ done: p + 1, total: n }); }
        }
    }
    const i0 = o.i0 !== null ? o.i0 : (n > 0 ? particles[P_ID] : 0);
    const res = tracer.finish(i0);
    res.stats.ms = performance.now() - t0ms;
    if (cancelled) res.cancelled = true;
    return res;
}

function createTracer(model, o, nTotal) {
    const h = model.h > 0 ? model.h : 1;
    const hasB = !!model.hasB;
    const hasRegions = !!model.hasRegions;
    const hitsOn = !!model.hasGeometry;
    const td = !!model.timeDependent;
    const minPeriod = model.minPeriod > 0 ? model.minPeriod : Infinity;
    const rfCap = minPeriod < Infinity ? minPeriod / o.rfStepsPerPeriod : Infinity;
    const bMax = hasB && model.bMax > 0 ? model.bMax : 0;
    const rel = o.relativistic;
    const cyl = !!model.cyl;
    const box = model.box || { xmin: -Infinity, xmax: Infinity, ymin: -Infinity, ymax: Infinity, zmin: -Infinity, zmax: Infinity };
    const transp = model.transparent || new Uint8Array(0);
    const transm = model.transmission || new Float64Array(0);
    const nElec = transp.length;
    const vSpan = model.vSpan > 0 ? model.vSpan : 0;
    const eThr = model.interp === 'linear' ? 1e-4 : 1e-6;
    const maxStepLen = o.maxStepCells * h, nearStepLen = o.nearStepCells * h;
    const rtol = o.rtol, tMax = o.tMax, maxSteps = o.maxSteps, maxDrift = o.maxDrift, seed = o.seed;
    const rtol2 = rtol * rtol, invRtolH2 = 1 / (rtol * h * rtol * h);
    const beyond = o.beyond;
    const energyCheck = o.energyCheck;
    const dragOn = o.drag !== null;
    const gasOn = o.gas !== null;
    const gasModel = gasOn ? createGasModel(o.gas) : null;
    const integrateDrift = hasB || dragOn || gasOn;   // outside the grid: integrate (B, drag or gas) or straight-line drift
    const KMOB = dragOn ? 1e-4 * o.drag.mobility : 0;
    const gasV = dragOn && Array.isArray(o.drag.gasVelocity) ? o.drag.gasVelocity.map((v) => num(v, 0)) : [0, 0, 0];
    const debugRegions = o.debugRegions && hasRegions;

    // planes
    const PL = compilePlanes(o.planes, h);
    const nP = PL.n;
    const pKind = PL.kind, pAt = PL.at, pP0x = PL.p0x, pP0y = PL.p0y, pP0z = PL.p0z, pNx = PL.nx, pNy = PL.ny;
    const pTerm = PL.term, pAll = PL.all;
    const gS = new Float64Array(nP), gE = new Float64Array(nP), pCount = new Int32Array(nP);
    const GS = new Float64Array(MAX_SAMPLES + 1);

    // recording
    const recTraj = o.record.trajectories;
    const everyStep = o.record.everyStep;
    const markersDt = o.record.markersDt;
    const markersOn = markersDt > 0;
    const perCap = Math.max(2, Math.min(o.record.maxPoints, Math.floor(o.record.pointBudget / Math.max(1, nTotal))));
    // rows per particle on each 'all' plane and on meshes (record.crossCap from the run's size; at most 1000)
    const crossCap = Math.max(1, Math.min(MAX_PLANE_ROWS, Math.floor(o.record.crossCap || MAX_PLANE_ROWS)));
    const meshCap = Math.max(1, Math.min(MAX_MESH_ROWS, Math.floor(o.record.crossCap || MAX_MESH_ROWS)));
    let cDropped = 0;   // crossing rows not kept because of the caps
    const minSeg0 = o.record.minSegCells * h;
    const cosTurn = Math.cos(o.record.maxTurnDeg * Math.PI / 180);

    // outputs
    const summary = new Float64Array(nTotal * S_STRIDE);
    let cross = new Float64Array(C_STRIDE * 64), nCross = 0;
    let trajPts = recTraj ? new Float32Array(4 * 1024) : null, nTrajPts = 0;
    const trajOff = recTraj ? new Uint32Array(nTotal + 1) : null;
    let marks = markersOn ? new Float32Array(5 * 256) : null, nMarks = 0;
    let cSteps = 0, cRejects = 0, cEvals = 0, cSplits = 0, cViol = 0, cColl = 0;
    let stopFn = null;

    // scratch
    const Y = new Float64Array(6), YN = new Float64Array(6), YT = new Float64Array(6);
    const K0 = new Float64Array(6), K6 = new Float64Array(6), ERR2 = new Float64Array(2);
    const K1 = new Float64Array(6), K2 = new Float64Array(6), K3 = new Float64Array(6), K4 = new Float64Array(6), K5 = new Float64Array(6);
    const PW = new Float64Array(7), PH = new Float64Array(7), WH = new Int8Array(7);
    const ef = new Float64Array(4), bf = new Float64Array(3);
    const PT = new Float64Array(4), PQ = new Float64Array(4);   // [t, x, y, z] arguments of the vector entry points
    const mEv = typeof model.Ev === 'function' ? model.Ev : (P, out, sg, lf) => model.E(P[0], P[1], P[2], P[3], out, sg, lf);
    const mBv = typeof model.Bv === 'function' ? model.Bv : (P, out, sg) => model.B(P[1], P[2], P[3], out, sg);
    const mInsideV = typeof model.insideV === 'function' ? model.insideV : (P) => model.inside(P[1], P[2], P[3]);
    const mNearV = typeof model.nearV === 'function' ? model.nearV : (P) => model.near(P[1], P[2], P[3]);
    const mRegionV = typeof model.regionSigV === 'function' ? model.regionSigV : (P) => model.regionSig(P[1], P[2], P[3]);
    const R1 = new Float64Array(6), R2 = new Float64Array(6), R3 = new Float64Array(6), R4 = new Float64Array(6), R5 = new Float64Array(6);
    const SX = new Float64Array(MAX_SAMPLES + 1), SY = new Float64Array(MAX_SAMPLES + 1), SZ = new Float64Array(MAX_SAMPLES + 1), ST = new Float64Array(MAX_SAMPLES + 1);
    let nSamp = 0;
    const evT = new Float64Array(EV_CAP), evKind = new Int8Array(EV_CAP), evIdx = new Int32Array(EV_CAP), evDir = new Int8Array(EV_CAP), evK = new Int32Array(EV_CAP);
    const evOrder = new Int32Array(EV_CAP);
    let nEv = 0;
    const DR = new Float64Array(2);
    // Boris scratch
    const WHf = new Float64Array(3), WNf = new Float64Array(3), WSf = new Float64Array(3);
    // trajectory buffer of the current particle
    let tbuf = recTraj ? new Float64Array(4 * Math.min(perCap, 4096)) : null;
    let tn = 0;

    // path of the current step: mode 0 dense DP45 (lazy), 1 cubic Hermite
    let pathMode = 0, denseReady = true;
    // hot doubles live in typed arrays: a double written to a closure variable would be re-boxed on every write
    const V = new Float64Array(24);   // per-particle scalars (V_* indices)
    const Q = new Float64Array(9);    // last path query: position, velocity, proper velocity
    const HM = new Float64Array(12);  // cubic Hermite path data of the current step
    const FB = new Float64Array(7);   // Boris: fields at the current point

    // per-particle state
    let pid = 0, pSrc = 0, pSpec = 0, pMass = 1, pQ = 0, kqm = 0, pT0 = 0, tEnd = 0, ke0 = 0, w1eV = 1, w1eV2 = 1, absQM = 0;
    let steps = 0, flags = 0, nCrossP = 0;
    let meshCount = 0, meshRows = 0, insideMesh = false, drifting = false;
    let nearS = false, nextMarkK = 0, invTau = 0;
    let outRow = 0;
    let firstStep = true, endInside = true;
    let gasS = null, gasRng = null;   // gas: species constants and the particle's random stream

    function setStop(fn) { stopFn = fn; }

    // ------------------------------------------------------------------ gas collisions (gas.js)
    /** Collision rate ν (1/µs) from the velocity components A[a..a+2]. */
    function gasRate(A, a) { return gasModel.rate(gasS, A[a], A[a + 1], A[a + 2]); }
    /**
     * Fraction τ of a step of length dt at which the collision budget E is spent, with the rate linear in time from
     * nuS to nuE (∫ν dt = dt(nuS τ + ½(nuE − nuS)τ²) = E; called only when the whole step spends at least E).
     */
    function collisionTau(nuS, nuE, dt, E) {
        const a = 0.5 * (nuE - nuS) * dt, b = nuS * dt;
        let tau;
        if (Math.abs(a) <= 1e-12 * Math.max(b, 1e-300)) tau = b > 0 ? E / b : 1;
        else { const disc = Math.max(0, b * b + 4 * a * E); tau = 2 * E / (b + Math.sqrt(disc)); }
        return tau > 1 ? 1 : (tau < 1e-9 ? 1e-9 : tau);
    }
    /** Applies one collision to the current state Y (proper velocity Y[3..5]) and draws the next budget. */
    function applyCollision() {
        gasModel.collide(gasS, gasRng, Y, 3, rel);
        V[V_KE] = keOfW(Y[3], Y[4], Y[5]);
        V[V_GASB] = gasModel.budget(gasRng);
        cColl++;
        const ig = rel ? 1 / Math.sqrt(1 + (Y[3] * Y[3] + Y[4] * Y[4] + Y[5] * Y[5]) * INV_C2) : 1;
        recordPoint(Y[0], Y[1], Y[2], V[V_T], Y[3] * ig, Y[4] * ig, Y[5] * ig, true);   // the kink in the trajectory
    }

    // ------------------------------------------------------------------ buffers
    function pushCross(plane, kind, elec, dir, k, tAbs) {
        if ((nCross + 1) * C_STRIDE > cross.length) { const nb = new Float64Array(cross.length * 2); nb.set(cross); cross = nb; }
        const c = nCross * C_STRIDE;
        cross[c + C_ID] = pid; cross[c + C_PLANE] = plane; cross[c + C_T] = tAbs;
        cross[c + C_X] = Q[QX]; cross[c + C_Y] = Q[QY]; cross[c + C_Z] = Q[QZ];
        cross[c + C_VX] = Q[QVX]; cross[c + C_VY] = Q[QVY]; cross[c + C_VZ] = Q[QVZ];
        cross[c + C_KE] = keOfW(Q[QWX], Q[QWY], Q[QWZ]);
        cross[c + C_DIR] = dir; cross[c + C_K] = k; cross[c + C_KIND] = kind; cross[c + C_ELEC] = elec;
        nCross++; nCrossP++;
    }
    function pushMarker(tm, x, y, z) {
        if ((nMarks + 1) * 5 > marks.length) { const nb = new Float32Array(marks.length * 2); nb.set(marks); marks = nb; }
        const c = nMarks * 5;
        marks[c] = pid; marks[c + 1] = tm; marks[c + 2] = x; marks[c + 3] = y; marks[c + 4] = z;
        nMarks++;
    }

    // ------------------------------------------------------------------ physics helpers
    function keOfW(wx, wy, wz) {
        const w2 = wx * wx + wy * wy + wz * wz;
        if (!rel) return pMass * w2 / (2 * K_ACC);
        const u2 = w2 * INV_C2;
        return u2 / (Math.sqrt(1 + u2) + 1) * pMass * UC2;
    }

    /** Derivative of the state s at time PT[0] into k; records E·v, φ and the cell type of the stage. */
    function deriv(s, k, stage, sig, left) {
        const w0 = s[3], w1 = s[4], w2 = s[5];
        const ig = rel ? 1 / Math.sqrt(1 + (w0 * w0 + w1 * w1 + w2 * w2) * INV_C2) : 1;
        const v0 = w0 * ig, v1 = w1 * ig, v2 = w2 * ig;
        PT[1] = s[0]; PT[2] = s[1]; PT[3] = s[2];
        const where = mEv(PT, ef, sig, left);
        const ex = ef[0], ey = ef[1], ez = ef[2];
        let fx = ex, fy = ey, fz = ez;
        if (hasB) {
            mBv(PT, bf, sig);
            fx += v1 * bf[2] - v2 * bf[1];
            fy += v2 * bf[0] - v0 * bf[2];
            fz += v0 * bf[1] - v1 * bf[0];
        }
        k[0] = v0; k[1] = v1; k[2] = v2;
        k[3] = kqm * fx; k[4] = kqm * fy; k[5] = kqm * fz;
        if (dragOn) {
            k[3] -= (v0 - gasV[0]) * invTau; k[4] -= (v1 - gasV[1]) * invTau; k[5] -= (v2 - gasV[2]) * invTau;
        }
        PW[stage] = ex * v0 + ey * v1 + ez * v2;
        PH[stage] = ef[3];
        WH[stage] = where;
        cEvals++;
    }

    /** Distance-based step cap: largest dt whose distance under constant acceleration stays ≤ s. */
    function capDist(v, a, s) {
        const den = v + Math.sqrt(v * v + 2 * a * s);
        return den > 0 ? 2 * s / den : Infinity;
    }
    function gyroCap(gamma, perGyration) {
        if (!(bMax > 0) || absQM === 0) return Infinity;
        return TWO_PI * gamma / (K_ACC * absQM * bMax) / perGyration;
    }
    /** near() at A[0..2] (A = Y or YN). */
    function nearA(A) { if (!hitsOn) return false; PQ[1] = A[0]; PQ[2] = A[1]; PQ[3] = A[2]; return !!mNearV(PQ); }
    function insideA(A) { PQ[1] = A[0]; PQ[2] = A[1]; PQ[3] = A[2]; return mInsideV(PQ); }
    function regionA(A) { PQ[1] = A[0]; PQ[2] = A[1]; PQ[3] = A[2]; return mRegionV(PQ); }
    /** regionSig at the last path query point. */
    function regionQ() { PQ[1] = Q[QX]; PQ[2] = Q[QY]; PQ[3] = Q[QZ]; return mRegionV(PQ); }
    function insideQ() { PQ[1] = Q[QX]; PQ[2] = Q[QY]; PQ[3] = Q[QZ]; return mInsideV(PQ); }

    // ------------------------------------------------------------------ path of the current step
    function ensurePath() {
        if (denseReady) return;
        denseReady = true;
        const dt = V[V_PDT];
        for (let i = 0; i < 6; i++) {
            const r1 = Y[i], r2 = YN[i] - Y[i], r3 = dt * K0[i] - r2, r4 = r2 - dt * K6[i] - r3;
            R1[i] = r1; R2[i] = r2; R3[i] = r3; R4[i] = r4;
            R5[i] = dt * (d1 * K0[i] + d3 * K2[i] + d4 * K3[i] + d5 * K4[i] + d6 * K5[i] + d7 * K6[i]);
        }
    }
    /** Cubic Hermite path from (Y, A[a..a+2]·fa) to (YN, B[b..b+2]·fb) over V[V_PDT]. */
    function prepHermite(A, a, fa, B, b, fb) {
        pathMode = 1; denseReady = true;
        HM[HX0] = Y[0]; HM[HY0] = Y[1]; HM[HZ0] = Y[2]; HM[HVX0] = A[a] * fa; HM[HVY0] = A[a + 1] * fa; HM[HVZ0] = A[a + 2] * fa;
        HM[HX1] = YN[0]; HM[HY1] = YN[1]; HM[HZ1] = YN[2]; HM[HVX1] = B[b] * fb; HM[HVY1] = B[b + 1] * fb; HM[HVZ1] = B[b + 2] * fb;
    }
    /** Position on the path at τ into (qx, qy, qz). Call ensurePath() first. */
    function pathPos(tau) {
        if (pathMode === 0) {
            const t1 = 1 - tau;
            Q[QX] = R1[0] + tau * (R2[0] + t1 * (R3[0] + tau * (R4[0] + t1 * R5[0])));
            Q[QY] = R1[1] + tau * (R2[1] + t1 * (R3[1] + tau * (R4[1] + t1 * R5[1])));
            Q[QZ] = R1[2] + tau * (R2[2] + t1 * (R3[2] + tau * (R4[2] + t1 * R5[2])));
        } else {
            const s = tau, s2 = s * s, s3 = s2 * s, dt = V[V_PDT];
            const h00 = 2 * s3 - 3 * s2 + 1, h10 = (s3 - 2 * s2 + s) * dt, h01 = -2 * s3 + 3 * s2, h11 = (s3 - s2) * dt;
            Q[QX] = h00 * HM[HX0] + h10 * HM[HVX0] + h01 * HM[HX1] + h11 * HM[HVX1];
            Q[QY] = h00 * HM[HY0] + h10 * HM[HVY0] + h01 * HM[HY1] + h11 * HM[HVY1];
            Q[QZ] = h00 * HM[HZ0] + h10 * HM[HVZ0] + h01 * HM[HZ1] + h11 * HM[HVZ1];
        }
    }
    /** Position, velocity and proper velocity on the path at τ. */
    function pathAt(tau) {
        if (pathMode === 0) {
            const t1 = 1 - tau;
            Q[QX] = R1[0] + tau * (R2[0] + t1 * (R3[0] + tau * (R4[0] + t1 * R5[0])));
            Q[QY] = R1[1] + tau * (R2[1] + t1 * (R3[1] + tau * (R4[1] + t1 * R5[1])));
            Q[QZ] = R1[2] + tau * (R2[2] + t1 * (R3[2] + tau * (R4[2] + t1 * R5[2])));
            Q[QWX] = R1[3] + tau * (R2[3] + t1 * (R3[3] + tau * (R4[3] + t1 * R5[3])));
            Q[QWY] = R1[4] + tau * (R2[4] + t1 * (R3[4] + tau * (R4[4] + t1 * R5[4])));
            Q[QWZ] = R1[5] + tau * (R2[5] + t1 * (R3[5] + tau * (R4[5] + t1 * R5[5])));
            const ig = rel ? 1 / Math.sqrt(1 + (Q[QWX] * Q[QWX] + Q[QWY] * Q[QWY] + Q[QWZ] * Q[QWZ]) * INV_C2) : 1;
            Q[QVX] = Q[QWX] * ig; Q[QVY] = Q[QWY] * ig; Q[QVZ] = Q[QWZ] * ig;
        } else {
            pathPos(tau);
            const s = tau, s2 = s * s, dt = V[V_PDT];
            const g00 = (6 * s2 - 6 * s) / dt, g10 = 3 * s2 - 4 * s + 1, g01 = (-6 * s2 + 6 * s) / dt, g11 = 3 * s2 - 2 * s;
            Q[QVX] = g00 * HM[HX0] + g10 * HM[HVX0] + g01 * HM[HX1] + g11 * HM[HVX1];
            Q[QVY] = g00 * HM[HY0] + g10 * HM[HVY0] + g01 * HM[HY1] + g11 * HM[HVY1];
            Q[QVZ] = g00 * HM[HZ0] + g10 * HM[HVZ0] + g01 * HM[HZ1] + g11 * HM[HVZ1];
            if (rel) {
                const b2 = Math.min((Q[QVX] * Q[QVX] + Q[QVY] * Q[QVY] + Q[QVZ] * Q[QVZ]) * INV_C2, 1 - 1e-16);
                const g = 1 / Math.sqrt(1 - b2);
                Q[QWX] = Q[QVX] * g; Q[QWY] = Q[QVY] * g; Q[QWZ] = Q[QVZ] * g;
            } else { Q[QWX] = Q[QVX]; Q[QWY] = Q[QVY]; Q[QWZ] = Q[QVZ]; }
        }
    }

    // ------------------------------------------------------------------ trajectory recording
    function keepPoint(x, y, z, tt) {
        if (tn >= perCap) {
            // drop every other point, keep both ends, double the spacing
            let j = 1;
            for (let i = 2; i < tn - 1; i += 2, j++) { const s = 4 * i, d = 4 * j; tbuf[d] = tbuf[s]; tbuf[d + 1] = tbuf[s + 1]; tbuf[d + 2] = tbuf[s + 2]; tbuf[d + 3] = tbuf[s + 3]; }
            const s = 4 * (tn - 1), d = 4 * j;
            tbuf[d] = tbuf[s]; tbuf[d + 1] = tbuf[s + 1]; tbuf[d + 2] = tbuf[s + 2]; tbuf[d + 3] = tbuf[s + 3];
            tn = j + 1;
            V[V_MINSEG] = V[V_MINSEG] > 0 ? 2 * V[V_MINSEG] : 0.5 * h;
        }
        if (4 * (tn + 1) > tbuf.length) { const nb = new Float64Array(Math.min(4 * perCap, tbuf.length * 2)); nb.set(tbuf); tbuf = nb; }
        const d = 4 * tn;
        tbuf[d] = x; tbuf[d + 1] = y; tbuf[d + 2] = z; tbuf[d + 3] = tt;
        tn++;
        V[V_LX] = x; V[V_LY] = y; V[V_LZ] = z; V[V_LT] = tt;
    }
    function recordPoint(x, y, z, tt, vx, vy, vz, force) {
        if (!recTraj) return;
        if (tn > 0 && tt === V[V_LT] && x === V[V_LX] && y === V[V_LY] && z === V[V_LZ]) return;   // the same point again
        const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
        const dx = sp > 0 ? vx / sp : 0, dy = sp > 0 ? vy / sp : 0, dz = sp > 0 ? vz / sp : 0;
        if (!force && !everyStep) {
            const ax = x - V[V_LX], ay = y - V[V_LY], az = z - V[V_LZ];
            const far = ax * ax + ay * ay + az * az >= V[V_MINSEG] * V[V_MINSEG];
            const turned = dx * V[V_LDX] + dy * V[V_LDY] + dz * V[V_LDZ] < cosTurn;
            if (!far && !turned) return;
        }
        keepPoint(x, y, z, tt);
        V[V_LDX] = dx; V[V_LDY] = dy; V[V_LDZ] = dz;
    }
    /** recordPoint for a step end: position Y, time V[V_T], velocity A[a..a+2]. */
    function recordStep(A, a) {
        if (!recTraj) return;
        const x = Y[0], y = Y[1], z = Y[2], vx = A[a], vy = A[a + 1], vz = A[a + 2];
        if (!everyStep) {
            const ax = x - V[V_LX], ay = y - V[V_LY], az = z - V[V_LZ], ms = V[V_MINSEG];
            const v2 = vx * vx + vy * vy + vz * vz;
            const dot = vx * V[V_LDX] + vy * V[V_LDY] + vz * V[V_LDZ];
            // kept if far enough from the last kept point or turned by more than maxTurnDeg
            if (ax * ax + ay * ay + az * az < ms * ms && !(dot < cosTurn * Math.sqrt(v2))) return;
        }
        recordPoint(x, y, z, V[V_T], vx, vy, vz, true);
    }
    function flushTrajectory(p) {
        if (!recTraj) return;
        if (4 * (nTrajPts + tn) > trajPts.length) {
            let len = trajPts.length * 2;
            while (len < 4 * (nTrajPts + tn)) len *= 2;
            const nb = new Float32Array(len); nb.set(trajPts.subarray(0, 4 * nTrajPts)); trajPts = nb;
        }
        const base = 4 * nTrajPts;
        for (let i = 0; i < 4 * tn; i++) trajPts[base + i] = tbuf[i];
        nTrajPts += tn;
        trajOff[p + 1] = nTrajPts;
    }

    // ------------------------------------------------------------------ planes
    function planeG(i, x, y, z) {
        switch (pKind[i]) {
            case 0: return x - pAt[i];
            case 1: return y - pAt[i];
            case 2: return z - pAt[i];
            case 3: return Math.sqrt(y * y + z * z) - pAt[i];
            case 5: { const dx = x - pP0x[i], dy = y - pP0y[i], dz = z - pP0z[i]; return Math.sqrt(dx * dx + dy * dy + dz * dz) - pAt[i]; }
            default: {
                const r = cyl ? Math.sqrt(y * y + z * z) : y;
                return (x - pP0x[i]) * pNx[i] + (r - pP0y[i]) * pNy[i];
            }
        }
    }
    function planeGdot(i, x, y, z, vx, vy, vz) {
        switch (pKind[i]) {
            case 0: return vx;
            case 1: return vy;
            case 2: return vz;
            case 3: { const r = Math.sqrt(y * y + z * z); return r > 0 ? (y * vy + z * vz) / r : Math.sqrt(vy * vy + vz * vz); }
            case 5: {
                const dx = x - pP0x[i], dy = y - pP0y[i], dz = z - pP0z[i], d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                return d > 0 ? (dx * vx + dy * vy + dz * vz) / d : Math.sqrt(vx * vx + vy * vy + vz * vz);
            }
            default: {
                let vr = vy;
                if (cyl) { const r = Math.sqrt(y * y + z * z); vr = r > 0 ? (y * vy + z * vz) / r : Math.sqrt(vy * vy + vz * vz); }
                return vx * pNx[i] + vr * pNy[i];
            }
        }
    }
    /** Whether a crossing at (x, y, z) in direction dir passes the side, extent, limits and radius filters. */
    function planeAccept(i, x, y, z, dir) { return acceptCrossing(PL, cyl, i, x, y, z, dir); }
    /** Root of g_i on the path between ta (ga) and tb (gb) with opposite sides (Illinois). */
    function planeRoot(i, ta, ga, tb, gb) {
        let side = 0;
        const posB = gb > 0;
        for (let it = 0; it < 100; it++) {
            if (tb - ta <= 1e-12) break;
            let tc = (ta * gb - tb * ga) / (gb - ga);
            if (!(tc > ta && tc < tb)) tc = 0.5 * (ta + tb);
            pathPos(tc);
            const gc = planeG(i, Q[QX], Q[QY], Q[QZ]);
            if (gc === 0) return tc;
            if ((gc > 0) === posB) {
                tb = tc; gb = gc;
                if (side === -1) ga *= 0.5;
                side = -1;
            } else {
                ta = tc; ga = gc;
                if (side === 1) gb *= 0.5;
                side = 1;
            }
        }
        return 0.5 * (ta + tb);
    }

    // ------------------------------------------------------------------ events
    function addEv(kind, tau, idx, dir, k) {
        if (nEv >= EV_CAP) return;
        evT[nEv] = tau; evKind[nEv] = kind; evIdx[nEv] = idx; evDir[nEv] = dir; evK[nEv] = k;
        nEv++;
    }
    function sortEvents() {
        for (let i = 0; i < nEv; i++) evOrder[i] = i;
        for (let i = 1; i < nEv; i++) {
            const a = evOrder[i];
            let j = i - 1;
            while (j >= 0) {
                const b = evOrder[j];
                if (evT[b] > evT[a] || (evT[b] === evT[a] && EV_PRIO[evKind[b]] > EV_PRIO[evKind[a]])) { evOrder[j + 1] = b; j--; } else break;
            }
            evOrder[j + 1] = a;
        }
    }

    /** Samples of the path at τ_m = m/M, m = 0..M (end points exact). */
    function makeSamples(M) {
        if (M > MAX_SAMPLES) M = MAX_SAMPLES;
        nSamp = M;
        SX[0] = Y[0]; SY[0] = Y[1]; SZ[0] = Y[2]; ST[0] = 0;
        for (let m = 1; m < M; m++) { const tau = m / M; pathPos(tau); SX[m] = Q[QX]; SY[m] = Q[QY]; SZ[m] = Q[QZ]; ST[m] = tau; }
        SX[M] = YN[0]; SY[M] = YN[1]; SZ[M] = YN[2]; ST[M] = 1;
    }

    function isSolidFor(own, hitElec) {
        if (own < 0) return false;
        if (hitElec >= 0 && hitElec < nElec && transp[hitElec] === 1) return true;
        return !(own < nElec && transp[own] === 1);
    }

    /** Electrode hits and mesh crossings on the sampled path up to tauLimit (§3.9(2)). */
    function hitScan() {
        const tauLimit = V[V_HLIM], stepLen = V[V_STEP];
        const M = nSamp;
        let skipT = insideMesh;
        let m = 1, tauA = 0, ax = SX[0], ay = SY[0], az = SZ[0];
        if (firstStep && stepLen > 0) {   // emission from a surface: the birth test covers the first 1e-6 cell
            tauA = Math.min(1, 1e-6 * h / stepLen);
            pathPos(tauA); ax = Q[QX]; ay = Q[QY]; az = Q[QZ];
            while (m <= M && ST[m] <= tauA) m++;
        }
        let guard = 0;
        while (m <= M) {
            if (tauA >= tauLimit) return;
            const tauB = ST[m], bx = SX[m], by = SY[m], bz = SZ[m];
            const r = model.firstHit(ax, ay, az, bx, by, bz, skipT);
            if (r === null) { tauA = tauB; ax = bx; ay = by; az = bz; m++; continue; }
            const e = r.electrode;
            const u = Math.min(1, Math.max(0, r.u));
            const tauC = tauA + u * (tauB - tauA);
            let tauHit, elec = e;
            // an inside sample on the curved path?
            let tauIn = -1;
            pathPos(tauC);
            let own = model.ownerAt(Q[QX], Q[QY], Q[QZ]);
            if (isSolidFor(own, e)) tauIn = tauC;
            else { own = model.ownerAt(bx, by, bz); if (isSolidFor(own, e)) tauIn = tauB; }
            if (tauIn >= 0) {
                let lo = tauA, hi = tauIn, ownHi = own;
                for (let it = 0; it < 60; it++) {
                    if ((hi - lo) * stepLen < 1e-9) break;
                    const mid = 0.5 * (lo + hi);
                    pathPos(mid);
                    const ow = model.ownerAt(Q[QX], Q[QY], Q[QZ]);
                    if (isSolidFor(ow, e)) { hi = mid; ownHi = ow; } else lo = mid;
                }
                tauHit = hi; elec = ownHi;
            } else {
                // zero-thickness piece (free just past the chord hit) or a chord grazing a solid?
                const cx = bx - ax, cy = by - ay, cz = bz - az;
                const L = Math.sqrt(cx * cx + cy * cy + cz * cz);
                const u2 = Math.min(1, u + (L > 0 ? 1e-6 * h / L : 1));
                const ow = model.ownerAt(ax + u2 * cx, ay + u2 * cy, az + u2 * cz);
                if (isSolidFor(ow, e)) { tauA = tauB; ax = bx; ay = by; az = bz; m++; continue; }   // grazing a solid: miss
                let lo = tauA, hi = tauB;
                for (let it = 0; it < 60; it++) {
                    if ((hi - lo) * stepLen < 1e-9) break;
                    const mid = 0.5 * (lo + hi);
                    pathPos(mid);
                    if (model.firstHit(ax, ay, az, Q[QX], Q[QY], Q[QZ], skipT) !== null) hi = mid; else lo = mid;
                }
                tauHit = hi;
            }
            if (tauHit > tauLimit) return;
            if (elec < 0) elec = e;
            if (elec >= 0 && elec < nElec && transp[elec] === 1) {
                meshCount++;
                const pass = uniform01(seed, MESH_A, pid, meshCount) < transm[elec];
                addEv(pass ? EV_MESH : EV_ABSORB, tauHit, elec, 0, meshCount);
                if (!pass) return;
                const dTau = stepLen > 0 ? Math.max(1e-12, 1e-7 * h / stepLen) : 1e-12;
                const tauR = tauHit + dTau;
                if (tauR >= 1 || ++guard > 200) return;
                pathPos(tauR);
                ax = Q[QX]; ay = Q[QY]; az = Q[QZ]; tauA = tauR;
                const ow = model.ownerAt(ax, ay, az);
                if (ow >= 0 && ow < nElec && transp[ow] === 1) { skipT = true; insideMesh = true; }
                while (m <= M && ST[m] <= tauA) m++;
                continue;
            }
            addEv(EV_HIT, tauHit, elec, 0, 0);
            return;
        }
    }

    function planeCandidate(i, tau, dir, tauLimit) {
        if (tau > tauLimit) return;
        if (firstStep && tau <= 1e-12) return;   // a τ = 0 crossing on the first step is ignored
        pathPos(tau);
        if (!planeAccept(i, Q[QX], Q[QY], Q[QZ], dir)) return;
        const c = ++pCount[i];
        if (pTerm[i] === 1) { if (c === 1) addEv(EV_DETECT, tau, i, dir, c); return; }
        if (pAll[i] === 1 ? c <= crossCap : c === 1) addEv(EV_PLANE, tau, i, dir, c);
        else if (pAll[i] === 1) cDropped++;
    }

    /** Plane crossings on the current step; quick rejection when a plane is out of reach. */
    function planeScan() {
        const tauLimit = V[V_PLIM], reach = V[V_REACH], x1 = YN[0], y1 = YN[1], z1 = YN[2];
        for (let i = 0; i < nP; i++) {
            const g0 = gS[i], g1 = planeG(i, x1, y1, z1);
            gE[i] = g1;
            if ((g0 > 0) === (g1 > 0) && Math.abs(g0) > reach && Math.abs(g1) > reach) continue;
            ensurePath();
            if (nSamp === 0) makeSamples(4);
            const M = nSamp;
            GS[0] = g0;
            for (let m = 1; m < M; m++) GS[m] = planeG(i, SX[m], SY[m], SZ[m]);
            GS[M] = g1;
            for (let m = 1; m <= M; m++) {
                const ta = ST[m - 1], tb = ST[m];
                if (ta >= tauLimit) break;
                const ga = GS[m - 1], gb = GS[m];
                if ((ga > 0) !== (gb > 0)) {
                    planeCandidate(i, planeRoot(i, ta, ga, tb, gb), gb > 0 ? 1 : -1, tauLimit);
                    continue;
                }
                // tangent double crossing inside this interval?
                const dx = SX[m] - SX[m - 1], dy = SY[m] - SY[m - 1], dz = SZ[m] - SZ[m - 1];
                const sub = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (Math.min(Math.abs(ga), Math.abs(gb)) > 1.5 * sub) continue;
                const sg = ga > 0 ? 1 : -1;
                pathAt(ta);
                const da = planeGdot(i, Q[QX], Q[QY], Q[QZ], Q[QVX], Q[QVY], Q[QVZ]);
                pathAt(tb);
                const db = planeGdot(i, Q[QX], Q[QY], Q[QZ], Q[QVX], Q[QVY], Q[QVZ]);
                if (!(sg * da < 0 && sg * db > 0)) continue;
                // golden-section minimum of sg·g on [ta, tb]
                let lo = ta, hi = tb;
                let xa = lo + GOLD * (hi - lo), xb = hi - GOLD * (hi - lo);
                pathPos(xa); let fa = sg * planeG(i, Q[QX], Q[QY], Q[QZ]);
                pathPos(xb); let fb = sg * planeG(i, Q[QX], Q[QY], Q[QZ]);
                for (let it = 0; it < 80 && hi - lo > 1e-13; it++) {
                    if ((sg > 0 && Math.min(fa, fb) <= 0) || (sg < 0 && Math.min(fa, fb) < 0)) break;
                    if (fa < fb) { hi = xb; xb = xa; fb = fa; xa = lo + GOLD * (hi - lo); pathPos(xa); fa = sg * planeG(i, Q[QX], Q[QY], Q[QZ]); }
                    else { lo = xa; xa = xb; fa = fb; xb = hi - GOLD * (hi - lo); pathPos(xb); fb = sg * planeG(i, Q[QX], Q[QY], Q[QZ]); }
                }
                const tm = fa < fb ? xa : xb, fm = fa < fb ? fa : fb;
                if (!(sg > 0 ? fm <= 0 : fm < 0)) continue;
                const gm = sg * fm;
                planeCandidate(i, planeRoot(i, ta, ga, tm, gm), gm > 0 ? 1 : -1, tauLimit);
                planeCandidate(i, planeRoot(i, tm, gm, tb, gb), gb > 0 ? 1 : -1, tauLimit);
            }
        }
    }

    /** Exit point of the step (first outside parameter) by bisection on model.inside. */
    function exitTau(stepLen) {
        let lo = 0, hi = 1;
        for (let it = 0; it < 80; it++) {
            if ((hi - lo) * stepLen < 1e-12) break;
            const mid = 0.5 * (lo + hi);
            pathPos(mid);
            if (insideQ()) lo = mid; else hi = mid;
        }
        return hi;
    }

    function faceCode(x, y, z) {
        if (typeof model.faceOf === 'function') return model.faceOf(x, y, z);
        if (x < box.xmin) return EDGE.XMIN;
        if (x > box.xmax) return EDGE.XMAX;
        if (cyl) return EDGE.RMAX;
        if (y < box.ymin) return EDGE.YMIN;
        return EDGE.YMAX;
    }
    function driftAllowed(code) {
        const key = typeof model.beyondKey === 'function' ? model.beyondKey(code)
            : (code === EDGE.XMIN ? 'xmin' : code === EDGE.XMAX ? 'xmax' : code === EDGE.YMIN ? 'ymin' : 'ymax');
        return beyond[key] === 'drift';
    }

    /**
     * Events of an accepted step. Returns −1 if the particle survives the whole step, else the
     * index of the event that ends or interrupts it (terminating event or straight-line drift start).
     */
    function stepEvents() {
        const tS = V[V_T], dtS = V[V_PDT], x0 = Y[0], y0 = Y[1], z0 = Y[2], x1 = YN[0], y1 = YN[1], z1 = YN[2], speedBound = V[V_VB];
        nEv = 0; nSamp = 0;
        const cx = x1 - x0, cy = y1 - y0, cz = z1 - z0;
        const stepLen = Math.sqrt(cx * cx + cy * cy + cz * cz);
        V[V_STEP] = stepLen;
        const insideS = !drifting;
        const insideE = endInside;
        let hitLimit = 1, planeLimit = 1;
        if (insideS && !insideE) {
            ensurePath();
            const te = exitTau(stepLen);
            pathPos(te);
            const code = faceCode(Q[QX], Q[QY], Q[QZ]);
            const drift = driftAllowed(code);
            addEv(drift ? EV_DRIFT : EV_EXIT, te, code, 0, 0);
            hitLimit = te;
            if (!(drift && integrateDrift)) planeLimit = te;
        }
        const nearE = insideE ? nearA(YN) : false;
        if (hitsOn && insideS && (nearS || nearE)) {
            ensurePath();
            let M = Math.ceil(stepLen / (0.125 * h));
            if (!(M >= 4)) M = 4;
            makeSamples(M);
            V[V_HLIM] = hitLimit;
            hitScan();
        }
        nearS = nearE;
        if (nP > 0) { V[V_PLIM] = planeLimit; V[V_REACH] = 1.25 * Math.max(stepLen, speedBound * dtS) + 1e-12; planeScan(); }
        if (nEv === 0) return -1;
        sortEvents();
        for (let j = 0; j < nEv; j++) {
            const e = evOrder[j], kind = evKind[e], tau = evT[e];
            if (kind === EV_PLANE) {
                pathAt(tau); pushCross(evIdx[e], 0, -1, evDir[e], evK[e], tS + tau * dtS);
                recordPoint(Q[QX], Q[QY], Q[QZ], tS + tau * dtS, Q[QVX], Q[QVY], Q[QVZ], true);
                continue;
            }
            if (kind === EV_MESH) {
                pathAt(tau);
                if (meshRows < meshCap) { meshRows++; pushCross(-1, 1, evIdx[e], 0, evK[e], tS + tau * dtS); } else cDropped++;
                recordPoint(Q[QX], Q[QY], Q[QZ], tS + tau * dtS, Q[QVX], Q[QVY], Q[QVZ], true);
                continue;
            }
            if (kind === EV_DRIFT && integrateDrift) { drifting = true; continue; }
            return e;
        }
        return -1;
    }

    // ------------------------------------------------------------------ particle end
    function writeSummary(status, where, tt, x, y, z, vx, vy, vz, wx, wy, wz) {
        const r = outRow;
        const ke = keOfW(wx, wy, wz);
        summary[r + S_ID] = pid; summary[r + S_STATUS] = status; summary[r + S_WHERE] = where;
        summary[r + S_T] = tt; summary[r + S_X] = x; summary[r + S_Y] = y; summary[r + S_Z] = z;
        summary[r + S_VX] = vx; summary[r + S_VY] = vy; summary[r + S_VZ] = vz;
        summary[r + S_KE] = ke; summary[r + S_TOF] = tt - pT0; summary[r + S_STEPS] = steps; summary[r + S_PATH] = V[V_PATH];
        let dEnd = NaN;
        if (V[V_E0] === V[V_E0] && status !== STATUS.BORN_INSIDE && status !== STATUS.NUM_ERROR && status !== STATUS.CANCELLED) {
            const phi = model.potential(tt, x, y, z);
            dEnd = ke + pQ * phi - V[V_E0];
            if (energyCheck && dEnd === dEnd && Math.abs(dEnd) > eThr * Math.max(ke0, Math.abs(pQ) * vSpan)) flags |= FLAG.ENERGY_WARN;
        }
        summary[r + S_DE_END] = dEnd; summary[r + S_DE_MAX] = V[V_E0] === V[V_E0] ? V[V_DEMAX] : NaN;
        summary[r + S_WORK] = V[V_WORK]; summary[r + S_NCROSS] = nCrossP; summary[r + S_TBAND] = V[V_TBAND]; summary[r + S_FLAGS] = flags;
        summary[r + S_SRC] = pSrc; summary[r + S_SPECIES] = pSpec; summary[r + S_KE0] = ke0; summary[r + S_T0] = pT0;
    }

    /** Markers inside [tS, tS + τEnd·dt] from a Hermite path. */
    function markersOnPath(tS, dtS, tauEnd) {
        const tLim = tS + tauEnd * dtS;
        for (;;) {
            const tm = pT0 + nextMarkK * markersDt;
            if (tm > tLim) break;
            if (tm >= tS) { pathPos(dtS > 0 ? (tm - tS) / dtS : 0); pushMarker(tm, Q[QX], Q[QY], Q[QZ]); }
            nextMarkK++;
        }
    }

    /** Ends the particle at τ of the current step path. */
    function endOnPath(status, where, tau, tS, dtS, x0, y0, z0) {
        pathAt(tau);
        const tt = tS + tau * dtS;
        const dx = Q[QX] - x0, dy = Q[QY] - y0, dz = Q[QZ] - z0;
        V[V_PATH] += Math.sqrt(dx * dx + dy * dy + dz * dz);
        const ex = Q[QX], ey = Q[QY], ez = Q[QZ], evx = Q[QVX], evy = Q[QVY], evz = Q[QVZ], ewx = Q[QWX], ewy = Q[QWY], ewz = Q[QWZ];
        if (markersOn && pathMode === 1) markersOnPath(tS, dtS, tau);
        recordPoint(ex, ey, ez, tt, evx, evy, evz, true);
        writeSummary(status, where, tt, ex, ey, ez, evx, evy, evz, ewx, ewy, ewz);
    }

    /** Ends the particle at its current state (Y, t). */
    function endHere(status, where) {
        const ig = rel ? 1 / Math.sqrt(1 + (Y[3] * Y[3] + Y[4] * Y[4] + Y[5] * Y[5]) * INV_C2) : 1;
        const vx = Y[3] * ig, vy = Y[4] * ig, vz = Y[5] * ig;
        recordPoint(Y[0], Y[1], Y[2], V[V_T], vx, vy, vz, true);
        writeSummary(status, where, V[V_T], Y[0], Y[1], Y[2], vx, vy, vz, Y[3], Y[4], Y[5]);
    }

    /** Handles the terminating (or straight-drift-starting) event e of the current step. */
    function handleEvent(e, tS, dtS, x0, y0, z0) {
        const kind = evKind[e], tau = evT[e];
        if (kind === EV_HIT) { endOnPath(STATUS.HIT, evIdx[e], tau, tS, dtS, x0, y0, z0); return; }
        if (kind === EV_ABSORB) {
            pathAt(tau);
            if (meshRows < meshCap) { meshRows++; pushCross(-1, 1, evIdx[e], 0, evK[e], tS + tau * dtS); } else cDropped++;
            endOnPath(STATUS.ABSORBED, evIdx[e], tau, tS, dtS, x0, y0, z0);
            return;
        }
        if (kind === EV_DETECT) {
            pathAt(tau);
            pushCross(evIdx[e], 0, -1, evDir[e], evK[e], tS + tau * dtS);
            endOnPath(STATUS.DETECTED, evIdx[e], tau, tS, dtS, x0, y0, z0);
            return;
        }
        if (kind === EV_EXIT) { endOnPath(STATUS.EXIT, evIdx[e], tau, tS, dtS, x0, y0, z0); return; }
        // EV_DRIFT without B or drag: straight-line drift from the exit point
        pathAt(tau);
        const tt = tS + tau * dtS;
        const dx = Q[QX] - x0, dy = Q[QY] - y0, dz = Q[QZ] - z0;
        V[V_PATH] += Math.sqrt(dx * dx + dy * dy + dz * dz);
        const px = Q[QX], py = Q[QY], pz = Q[QZ], vx = Q[QVX], vy = Q[QVY], vz = Q[QVZ], wx = Q[QWX], wy = Q[QWY], wz = Q[QWZ];
        if (markersOn && pathMode === 1) markersOnPath(tS, dtS, tau);
        recordPoint(px, py, pz, tt, vx, vy, vz, true);
        driftAnalytic(tt, px, py, pz, vx, vy, vz, wx, wy, wz);
    }

    // ------------------------------------------------------------------ field-free drift outside the grid (§3.9(7))
    function driftAnalytic(tS, px, py, pz, vx, vy, vz, wx, wy, wz) {
        drifting = true;
        const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
        const sTime = tEnd - tS;
        const sDrift = sp > 0 ? Math.max(0, maxDrift - V[V_DRIFT]) / sp : Infinity;
        const sEnd = Math.min(sTime, sDrift);
        nEv = 0;
        for (let i = 0; i < nP; i++) {
            const nr = driftRoots(i, px, py, pz, vx, vy, vz);
            for (let r = 0; r < nr; r++) {
                const s = DR[r];
                if (!(s > 1e-15 * (1 + sEnd)) || s > sEnd) continue;
                const x = px + vx * s, y = py + vy * s, z = pz + vz * s;
                const dir = planeGdot(i, x, y, z, vx, vy, vz) > 0 ? 1 : -1;
                if (!planeAccept(i, x, y, z, dir)) continue;
                addEv(pTerm[i] === 1 ? EV_DETECT : EV_PLANE, s, i, dir, 0);
            }
        }
        sortEvents();
        let sStop = sEnd, stopEv = -1;
        Q[QVX] = vx; Q[QVY] = vy; Q[QVZ] = vz; Q[QWX] = wx; Q[QWY] = wy; Q[QWZ] = wz;
        for (let j = 0; j < nEv; j++) {
            const e = evOrder[j], i = evIdx[e], s = evT[e];
            const c = ++pCount[i];
            Q[QX] = px + vx * s; Q[QY] = py + vy * s; Q[QZ] = pz + vz * s;
            if (evKind[e] === EV_DETECT) {
                if (c === 1) { pushCross(i, 0, -1, evDir[e], c, tS + s); sStop = s; stopEv = e; break; }
                continue;
            }
            if (pAll[i] === 1 ? c <= crossCap : c === 1) {
                pushCross(i, 0, -1, evDir[e], c, tS + s);
                recordPoint(Q[QX], Q[QY], Q[QZ], tS + s, vx, vy, vz, true);
            }
        }
        if (markersOn) {
            for (;;) {
                const tm = pT0 + nextMarkK * markersDt;
                if (tm > tS + sStop) break;
                if (tm >= tS) { const s = tm - tS; pushMarker(tm, px + vx * s, py + vy * s, pz + vz * s); }
                nextMarkK++;
            }
        }
        const fx = px + vx * sStop, fy = py + vy * sStop, fz = pz + vz * sStop;
        V[V_PATH] += sp * sStop; V[V_DRIFT] += sp * sStop;
        recordPoint(fx, fy, fz, tS + sStop, vx, vy, vz, true);
        let status, where;
        if (stopEv >= 0) { status = STATUS.DETECTED; where = evIdx[stopEv]; }
        else if (sDrift <= sTime) { status = STATUS.DRIFT_END; where = EDGE.DRIFT_LIMIT; }
        else { status = STATUS.TMAX; where = -1; }
        writeSummary(status, where, tS + sStop, fx, fy, fz, vx, vy, vz, wx, wy, wz);
    }
    /** Roots s of plane i along the line p + v s (any sign); returns their number (in DR, ascending). */
    function driftRoots(i, px, py, pz, vx, vy, vz) {
        let nr = 0;
        const lin = (g0, dg) => { if (dg !== 0) { DR[0] = -g0 / dg; nr = 1; } };
        const quad = (A, B, C, check) => {
            if (Math.abs(A) < 1e-300) { if (B !== 0) { const s = -C / B; if (check(s)) DR[nr++] = s; } return; }
            const disc = B * B - 4 * A * C;
            if (!(disc > 0)) return;
            const sq = Math.sqrt(disc), qq = -0.5 * (B + (B >= 0 ? sq : -sq));
            let s1 = qq / A, s2 = qq !== 0 ? C / qq : -B / A - s1;
            if (s1 > s2) { const tmp = s1; s1 = s2; s2 = tmp; }
            if (check(s1)) DR[nr++] = s1;
            if (check(s2)) DR[nr++] = s2;
        };
        switch (pKind[i]) {
            case 0: lin(px - pAt[i], vx); break;
            case 1: lin(py - pAt[i], vy); break;
            case 2: lin(pz - pAt[i], vz); break;
            case 3: quad(vy * vy + vz * vz, 2 * (py * vy + pz * vz), py * py + pz * pz - pAt[i] * pAt[i], () => true); break;
            case 5: {
                const dx = px - pP0x[i], dy = py - pP0y[i], dz = pz - pP0z[i];
                quad(vx * vx + vy * vy + vz * vz, 2 * (dx * vx + dy * vy + dz * vz), dx * dx + dy * dy + dz * dz - pAt[i] * pAt[i], () => true);
                break;
            }
            default: {
                const nx = pNx[i], ny = pNy[i];
                if (!cyl) { lin((px - pP0x[i]) * nx + (py - pP0y[i]) * ny, vx * nx + vy * ny); break; }
                if (Math.abs(ny) < 1e-15) { lin((px - pP0x[i]) * nx, vx * nx); break; }
                // on the plane ρ(s) = α + β s; and ρ(s)² = |p⊥ + v⊥ s|²
                const al = pP0y[i] - (px - pP0x[i]) * nx / ny, be = -vx * nx / ny;
                quad(vy * vy + vz * vz - be * be, 2 * (py * vy + pz * vz) - 2 * al * be, py * py + pz * pz - al * al, (s) => al + be * s >= 0);
            }
        }
        return nr;
    }

    // ------------------------------------------------------------------ commit helpers
    function afterStepCommon() {
        const dl = V[V_STEP];
        V[V_PATH] += dl;
        if (drifting) { V[V_DRIFT] += dl; if (endInside) drifting = false; }
        for (let i = 0; i < nP; i++) gS[i] = gE[i];
        if (insideMesh) { const ow = model.ownerAt(Y[0], Y[1], Y[2]); insideMesh = ow >= 0 && ow < nElec && transp[ow] === 1; }
    }

    /** Last inside parameter of a step that ends outside the domain (0 if the start is already on the face). */
    function lastInside() {
        ensurePath();
        const dx = YN[0] - Y[0], dy = YN[1] - Y[1], dz = YN[2] - Y[2];
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
        let lo = 0, hi = 1;
        for (let it = 0; it < 80; it++) {
            if ((hi - lo) * L < 1e-12) break;
            const mid = 0.5 * (lo + hi);
            pathPos(mid);
            if (insideQ()) lo = mid; else hi = mid;
        }
        return lo * L > 1e-9 * h ? lo : 0;
    }

    // ------------------------------------------------------------------ DP45 particle loop
    function runRK45() {
        let sig = hasRegions ? regionA(Y) : -1;
        let fsal = true, noGrow = false, forced = 0, forcedKind = 0, iter = 0;
        PT[0] = V[V_T]; deriv(Y, K0, 0, sig, false);
        let dt;
        {
            const v = Math.sqrt(K0[0] * K0[0] + K0[1] * K0[1] + K0[2] * K0[2]);
            const a = Math.sqrt(K0[3] * K0[3] + K0[4] * K0[4] + K0[5] * K0[5]);
            dt = Math.min(v > 0 ? 0.05 * h / v : Infinity, a > 0 ? Math.sqrt(0.1 * h / a) : Infinity);
        }
        for (;;) {
            if (V[V_T] >= tEnd) { endHere(STATUS.TMAX, -1); return true; }
            if (steps >= maxSteps) { endHere(STATUS.STEPS, -1); return true; }
            if (stopFn !== null && (++iter & 4095) === 0 && stopFn()) { endHere(STATUS.CANCELLED, -1); return false; }
            if (!fsal) { PT[0] = V[V_T]; deriv(Y, K0, 0, sig, false); fsal = true; }
            const v = Math.sqrt(K0[0] * K0[0] + K0[1] * K0[1] + K0[2] * K0[2]);
            const a = Math.sqrt(K0[3] * K0[3] + K0[4] * K0[4] + K0[5] * K0[5]);
            let dtTry, tLand = tEnd, landing = false, landBreak = false, landMark = false, edgeStep = false, exitLand = false, collLand = false;
            if (gasOn) V[V_NUS] = gasRate(K0, 0);
            if (forced > 0) {
                dtTry = forced; forced = 0;
                if (forcedKind === 1) edgeStep = true; else if (forcedKind === 3) collLand = true; else exitLand = true;
                forcedKind = 0;
            } else {
                let cap = capDist(v, a, nearS ? nearStepLen : maxStepLen);
                if (cap > rfCap) cap = rfCap;
                if (bMax > 0) {
                    const gam = rel ? Math.sqrt(1 + (Y[3] * Y[3] + Y[4] * Y[4] + Y[5] * Y[5]) * INV_C2) : 1;
                    const gc = gyroCap(gam, 32);
                    if (cap > gc) cap = gc;
                }
                if (gasOn && V[V_NUS] > 0) { const gc = 0.1 / V[V_NUS]; if (cap > gc) cap = gc; }   // a tenth of the mean free time
                dtTry = dt < cap ? dt : cap;
                let tb = Infinity, tm = Infinity;
                if (td) tb = model.nextBreak(V[V_T], V[V_T] + dtTry);
                if (markersOn) tm = pT0 + nextMarkK * markersDt;
                if (tb < tLand) tLand = tb;
                if (tm < tLand) tLand = tm;
                if (V[V_T] + dtTry >= tLand) { dtTry = tLand - V[V_T]; landing = true; landBreak = tb === tLand; landMark = tm === tLand; }
            }
            if (!(dtTry > 0)) {
                if (landing && tLand === V[V_T]) {   // a landing time equal to the current time (marker on a break)
                    if (landMark) { pushMarker(V[V_T], Y[0], Y[1], Y[2]); nextMarkK++; }
                    continue;
                }
                endHere(STATUS.NUM_ERROR, -1); return true;
            }
            const tE = landing ? tLand : V[V_T] + dtTry;
            dpStage1(Y, YT, dtTry, K0);
            PT[0] = V[V_T] + c2 * dtTry; deriv(YT, K1, 1, sig, false);
            dpStage2(Y, YT, dtTry, K0, K1);
            PT[0] = V[V_T] + c3 * dtTry; deriv(YT, K2, 2, sig, false);
            dpStage3(Y, YT, dtTry, K0, K1, K2);
            PT[0] = V[V_T] + c4 * dtTry; deriv(YT, K3, 3, sig, false);
            dpStage4(Y, YT, dtTry, K0, K1, K2, K3);
            PT[0] = V[V_T] + c5 * dtTry; deriv(YT, K4, 4, sig, false);
            dpStage5(Y, YT, dtTry, K0, K1, K2, K3, K4);
            PT[0] = tE; deriv(YT, K5, 5, sig, landBreak);
            dpSolution(Y, YN, dtTry, K0, K2, K3, K4, K5);
            PT[0] = tE; deriv(YN, K6, 6, sig, landBreak);
            dpError2(dtTry, K0, K2, K3, K4, K5, K6, ERR2);
            const wn2 = Y[3] * Y[3] + Y[4] * Y[4] + Y[5] * Y[5], wn12 = YN[3] * YN[3] + YN[4] * YN[4] + YN[5] * YN[5];
            let wsc2 = wn2 > wn12 ? wn2 : wn12; if (wsc2 < w1eV2) wsc2 = w1eV2;
            const ep2 = ERR2[0] * invRtolH2, ew2 = ERR2[1] / (rtol2 * wsc2);
            const err2 = ep2 > ew2 ? ep2 : ew2;
            const err = Math.sqrt(err2);
            if (!(err <= 1)) {
                if (err !== err) { endHere(STATUS.NUM_ERROR, -1); return true; }
                cRejects++;
                let f = 0.9 * Math.pow(err2, -0.125); if (f < 0.1) f = 0.1;
                dt = dtTry * f; noGrow = true;
                if (dt < 1e-12 * capDist(v, a, h)) { flags |= FLAG.STEP_FLOOR; endHere(STATUS.NUM_ERROR, -1); return true; }
                continue;
            }
            pathMode = 0; V[V_PDT] = dtTry; denseReady = false;
            // magnet and field-box edges: no step integrates across one (§3.9(5))
            if (hasRegions) {
                ensurePath();
                let bad = -1, tauOk = 0;
                for (let m = 1; m <= 4; m++) {
                    if (m === 4 && edgeStep) break;
                    const tau = 0.25 * m;
                    if (m === 4) { Q[QX] = YN[0]; Q[QY] = YN[1]; Q[QZ] = YN[2]; } else pathPos(tau);
                    if (regionQ() !== sig) { bad = m; break; }
                    tauOk = tau;
                }
                if (bad > 0) {
                    let lo = tauOk, hi = 0.25 * bad;
                    for (let it = 0; it < 52; it++) { const mid = 0.5 * (lo + hi); pathPos(mid); if (regionQ() !== sig) hi = mid; else lo = mid; }
                    forced = dtTry * Math.max(hi, 1e-9) * (1 + 1e-9); forcedKind = 1;
                    cSplits++;
                    continue;
                }
                if (debugRegions) {
                    for (let m = 1; m < 32; m++) { pathPos(m / 32); if (regionQ() !== sig) { cViol++; break; } }
                }
            }
            // a step leaving the domain is first shortened to end on the face (no stage in the field-free exterior)
            endInside = insideA(YN);
            if (!drifting && !exitLand && !edgeStep && !endInside) {
                const tauIn = lastInside();
                if (tauIn > 0) { forced = dtTry * tauIn; forcedKind = 2; continue; }
            }
            // gas: spend the collision budget along the step; a step that exhausts it is shortened to end at the collision
            let collide = false;
            if (gasOn) {
                if (collLand) collide = true;
                else {
                    const nuE = gasRate(K6, 0), dE = 0.5 * (V[V_NUS] + nuE) * dtTry;
                    if (dE >= V[V_GASB]) {
                        const tau = collisionTau(V[V_NUS], nuE, dtTry, V[V_GASB]);
                        if (tau < 1 - 1e-9) { forced = dtTry * tau; forcedKind = 3; continue; }
                        collide = true;
                    } else V[V_GASB] -= dE;
                }
            }
            // accepted
            steps++; cSteps++;
            const x0 = Y[0], y0 = Y[1], z0 = Y[2];
            const vb = Math.max(v, Math.sqrt(K6[0] * K6[0] + K6[1] * K6[1] + K6[2] * K6[2]));
            V[V_VB] = vb;
            const ev = stepEvents();
            if (ev >= 0) { handleEvent(ev, V[V_T], dtTry, x0, y0, z0); return true; }
            firstStep = false;
            if (WH[0] === 1) { V[V_TBAND] += dtTry; flags |= FLAG.ENTERED_BOUNDARY; }
            const keS = V[V_KE], keE = keOfW(YN[3], YN[4], YN[5]);
            V[V_KE] = keE;
            V[V_WORK] += Math.abs(keE - keS - pQ * dtTry * (b1 * PW[0] + b3 * PW[2] + b4 * PW[3] + b5 * PW[4] + b6 * PW[5]));
            if (V[V_E0] === V[V_E0]) { const d = Math.abs(keE + pQ * PH[6] - V[V_E0]); if (d > V[V_DEMAX]) V[V_DEMAX] = d; }
            Y[0] = YN[0]; Y[1] = YN[1]; Y[2] = YN[2]; Y[3] = YN[3]; Y[4] = YN[4]; Y[5] = YN[5];
            K0[0] = K6[0]; K0[1] = K6[1]; K0[2] = K6[2]; K0[3] = K6[3]; K0[4] = K6[4]; K0[5] = K6[5];
            PW[0] = PW[6]; PH[0] = PH[6]; WH[0] = WH[6];
            V[V_T] = landing ? tLand : V[V_T] + dtTry;
            afterStepCommon();
            if (landMark) { pushMarker(V[V_T], Y[0], Y[1], Y[2]); nextMarkK++; }
            if (landBreak) fsal = false;
            if (edgeStep) { sig = regionA(Y); fsal = false; }
            recordStep(K0, 0);
            if (collide) { applyCollision(); fsal = false; }   // the velocity changed: new derivative, new step caps
            if (drifting && V[V_DRIFT] >= maxDrift) { endHere(STATUS.DRIFT_END, EDGE.DRIFT_LIMIT); return true; }
            let fac = err2 < 3.5e-8 ? 5 : 0.9 * Math.pow(err2, -0.1);   // 0.9·err^(−1/5) ≥ 5 below err = 1.9e-4
            if (fac > 5) fac = 5; else if (fac < 0.2) fac = 0.2;
            if (noGrow && fac > 1) fac = 1;
            noGrow = false;
            let dn = dtTry * fac;
            if ((landing || edgeStep || exitLand || collLand) && dn < dt) dn = dt;
            dt = dn;
        }
    }

    // ------------------------------------------------------------------ RK4 particle loop (tests)
    /** Region check on the current Hermite path: returns τ* (first changed parameter) or −1. */
    function regionCheckHermite(sig, edgeStep) {
        let bad = -1, tauOk = 0;
        for (let m = 1; m <= 4; m++) {
            if (m === 4 && edgeStep) break;
            const tau = 0.25 * m;
            if (m === 4) { Q[QX] = HM[HX1]; Q[QY] = HM[HY1]; Q[QZ] = HM[HZ1]; } else pathPos(tau);
            if (regionQ() !== sig) { bad = m; break; }
            tauOk = tau;
        }
        if (bad < 0) {
            if (debugRegions) for (let m = 1; m < 32; m++) { pathPos(m / 32); if (regionQ() !== sig) { cViol++; break; } }
            return -1;
        }
        let lo = tauOk, hi = 0.25 * bad;
        for (let it = 0; it < 52; it++) { const mid = 0.5 * (lo + hi); pathPos(mid); if (regionQ() !== sig) hi = mid; else lo = mid; }
        return hi;
    }

    function runRK4() {
        let sig = hasRegions ? regionA(Y) : -1;
        let forced = 0, forcedKind = 0, fsal = false, iter = 0;
        for (;;) {
            if (V[V_T] >= tEnd) { endHere(STATUS.TMAX, -1); return true; }
            if (steps >= maxSteps) { endHere(STATUS.STEPS, -1); return true; }
            if (stopFn !== null && (++iter & 4095) === 0 && stopFn()) { endHere(STATUS.CANCELLED, -1); return false; }
            if (!fsal) { PT[0] = V[V_T]; deriv(Y, K0, 0, sig, false); fsal = true; }
            const v = Math.sqrt(K0[0] * K0[0] + K0[1] * K0[1] + K0[2] * K0[2]);
            const a = Math.sqrt(K0[3] * K0[3] + K0[4] * K0[4] + K0[5] * K0[5]);
            let dtS, tLand = tEnd, landing = false, landBreak = false, edgeStep = false, exitLand = false;
            if (forced > 0) { dtS = forced; forced = 0; if (forcedKind === 1) edgeStep = true; else exitLand = true; forcedKind = 0; } else {
                const s = nearS ? nearStepLen : maxStepLen;
                if (o.dt > 0) dtS = o.dt;
                else { const den = Math.max(v, Math.sqrt(2 * s * a)); dtS = den > 0 ? s / den : Infinity; }
                if (dtS > rfCap) dtS = rfCap;
                let tb = Infinity;
                if (td) tb = model.nextBreak(V[V_T], V[V_T] + dtS);
                if (tb < tLand) tLand = tb;
                if (V[V_T] + dtS >= tLand) { dtS = tLand - V[V_T]; landing = true; landBreak = tb === tLand; }
            }
            if (!(dtS > 0)) { endHere(STATUS.NUM_ERROR, -1); return true; }
            const tE = landing ? tLand : V[V_T] + dtS, hdt = 0.5 * dtS;
            for (let i = 0; i < 6; i++) YT[i] = Y[i] + hdt * K0[i];
            PT[0] = V[V_T] + hdt; deriv(YT, K1, 1, sig, false);
            for (let i = 0; i < 6; i++) YT[i] = Y[i] + hdt * K1[i];
            PT[0] = V[V_T] + hdt; deriv(YT, K2, 2, sig, false);
            for (let i = 0; i < 6; i++) YT[i] = Y[i] + dtS * K2[i];
            PT[0] = tE; deriv(YT, K3, 3, sig, landBreak);
            for (let i = 0; i < 6; i++) YN[i] = Y[i] + dtS / 6 * (K0[i] + 2 * K1[i] + 2 * K2[i] + K3[i]);
            if (!(YN[0] === YN[0] && YN[1] === YN[1] && YN[2] === YN[2] && YN[3] === YN[3] && YN[4] === YN[4] && YN[5] === YN[5])) { endHere(STATUS.NUM_ERROR, -1); return true; }
            PT[0] = tE; deriv(YN, K6, 6, sig, landBreak);
            V[V_PDT] = dtS; prepHermite(K0, 0, 1, K6, 0, 1);
            if (hasRegions) {
                const tauBad = regionCheckHermite(sig, edgeStep);
                if (tauBad > 0) { forced = dtS * Math.max(tauBad, 1e-9) * (1 + 1e-9); forcedKind = 1; cSplits++; continue; }
            }
            endInside = insideA(YN);
            if (!drifting && !exitLand && !edgeStep && !endInside) {
                const tauIn = lastInside();
                if (tauIn > 0) { forced = dtS * tauIn; forcedKind = 2; continue; }
            }
            steps++; cSteps++;
            const x0 = Y[0], y0 = Y[1], z0 = Y[2];
            V[V_VB] = Math.max(v, Math.sqrt(K6[0] * K6[0] + K6[1] * K6[1] + K6[2] * K6[2]));
            const ev = stepEvents();
            if (ev >= 0) { handleEvent(ev, V[V_T], dtS, x0, y0, z0); return true; }
            firstStep = false;
            if (markersOn) markersOnPath(V[V_T], dtS, 1);
            if (WH[0] === 1) { V[V_TBAND] += dtS; flags |= FLAG.ENTERED_BOUNDARY; }
            const keS = V[V_KE], keE = keOfW(YN[3], YN[4], YN[5]);
            V[V_KE] = keE;
            V[V_WORK] += Math.abs(keE - keS - pQ * dtS * 0.5 * (PW[0] + PW[6]));
            if (V[V_E0] === V[V_E0]) { const d = Math.abs(keE + pQ * PH[6] - V[V_E0]); if (d > V[V_DEMAX]) V[V_DEMAX] = d; }
            Y[0] = YN[0]; Y[1] = YN[1]; Y[2] = YN[2]; Y[3] = YN[3]; Y[4] = YN[4]; Y[5] = YN[5];
            K0[0] = K6[0]; K0[1] = K6[1]; K0[2] = K6[2]; K0[3] = K6[3]; K0[4] = K6[4]; K0[5] = K6[5];
            PW[0] = PW[6]; PH[0] = PH[6]; WH[0] = WH[6];
            V[V_T] = landing ? tLand : V[V_T] + dtS;
            afterStepCommon();
            if (landBreak) fsal = false;
            if (edgeStep) { sig = regionA(Y); fsal = false; }
            recordStep(K0, 0);
            if (drifting && V[V_DRIFT] >= maxDrift) { endHere(STATUS.DRIFT_END, EDGE.DRIFT_LIMIT); return true; }
        }
    }

    // ------------------------------------------------------------------ Boris particle loop
    let fwhere = 0;
    /** Fields at a point into (fex.., fbx..); sig ≥ 0 freezes the field regions, left takes waveform left limits. */
    function fieldsAt(A, sig, left) {
        PT[1] = A[0]; PT[2] = A[1]; PT[3] = A[2];
        fwhere = mEv(PT, ef, sig, left);
        FB[FEX] = ef[0]; FB[FEY] = ef[1]; FB[FEZ] = ef[2]; FB[FPHI] = ef[3];
        if (hasB) { mBv(PT, bf, sig); FB[FBX] = bf[0]; FB[FBY] = bf[1]; FB[FBZ] = bf[2]; } else { FB[FBX] = 0; FB[FBY] = 0; FB[FBZ] = 0; }
        cEvals++;
    }
    /** Boris velocity update of w over the signed time tau: half kick, exact-angle rotation, half kick. */
    function borisVel(w, ex, ey, ez, bx, by, bz, tau) {
        const hk = 0.5 * tau * kqm;
        let w0 = w[0] + hk * ex, w1 = w[1] + hk * ey, w2 = w[2] + hk * ez;
        if (bx !== 0 || by !== 0 || bz !== 0) {
            const ig = rel ? 1 / Math.sqrt(1 + (w0 * w0 + w1 * w1 + w2 * w2) * INV_C2) : 1;
            const ox = kqm * bx * ig, oy = kqm * by * ig, oz = kqm * bz * ig;
            const om = Math.sqrt(ox * ox + oy * oy + oz * oz);
            if (om > 0) {
                const tf = Math.tan(0.5 * om * tau) / om;
                const tx = ox * tf, ty = oy * tf, tz = oz * tf;
                const sf = 2 / (1 + tx * tx + ty * ty + tz * tz), sx = tx * sf, sy = ty * sf, sz = tz * sf;
                const px = w0 + (w1 * tz - w2 * ty), py = w1 + (w2 * tx - w0 * tz), pz = w2 + (w0 * ty - w1 * tx);
                w0 += py * sz - pz * sy; w1 += pz * sx - px * sz; w2 += px * sy - py * sx;
            }
        }
        w[0] = w0 + hk * ex; w[1] = w1 + hk * ey; w[2] = w2 + hk * ez;
    }
    function borisCap(v, a) {
        if (o.dt > 0) return o.dt;
        let c = capDist(v, a, nearS ? nearStepLen : maxStepLen);
        if (c > rfCap) c = rfCap;
        if (bMax > 0 && absQM > 0) {
            const gam = rel ? Math.sqrt(1 + (Y[3] * Y[3] + Y[4] * Y[4] + Y[5] * Y[5]) * INV_C2) : 1;
            const tg = gyroCap(gam, o.borisStepsPerGyration);
            if (c > tg) c = tg;
        }
        return c;
    }
    /**
     * Boris leapfrog. State: x_n and the synchronised w_n in Y, the half-step velocity w_{n−½} in WHf and the
     * fields at x_n. The leapfrog is restarted (half step back from w_n) whenever dt changes: landing on a time,
     * a step shortened at a field edge, a changed step cap. At a field edge or a waveform breakpoint the
     * synchronising half step at the end of a step uses the field that acted during the step (frozen region
     * signature, waveform left limit) and the next step starts with the field beyond it. Step times are
     * t_restart + k·dt, so long runs do not accumulate rounding.
     */
    function runBoris() {
        flags |= FLAG.BORIS;
        let sig = hasRegions ? regionA(Y) : -1;
        PT[0] = V[V_T]; fieldsAt(Y, -1, false);
        let ex0 = FB[FEX], ey0 = FB[FEY], ez0 = FB[FEZ], bx0 = FB[FBX], by0 = FB[FBY], bz0 = FB[FBZ], where0 = fwhere;
        let dtB = 0, restart = true, iter = 0, tB0 = V[V_T], kB = 0;
        for (;;) {
            if (V[V_T] >= tEnd) { endHere(STATUS.TMAX, -1); return true; }
            if (steps >= maxSteps) { endHere(STATUS.STEPS, -1); return true; }
            if (stopFn !== null && (++iter & 4095) === 0 && stopFn()) { endHere(STATUS.CANCELLED, -1); return false; }
            const ig = rel ? 1 / Math.sqrt(1 + (Y[3] * Y[3] + Y[4] * Y[4] + Y[5] * Y[5]) * INV_C2) : 1;
            const v0 = Math.sqrt(Y[3] * Y[3] + Y[4] * Y[4] + Y[5] * Y[5]) * ig;
            const a0 = Math.abs(kqm) * Math.sqrt(ex0 * ex0 + ey0 * ey0 + ez0 * ez0);
            const capNow = borisCap(v0, a0);
            if (dtB === 0 || dtB > 1.25 * capNow || (o.dt <= 0 && dtB < 0.5 * capNow)) { dtB = capNow; restart = true; }
            if (!(dtB < Infinity)) { dtB = tEnd - V[V_T]; restart = true; }
            if (restart) { tB0 = V[V_T]; kB = 0; }
            let dtS = dtB, tLand = tEnd, landing = false, landBreak = false;
            if (td) { const tb = model.nextBreak(V[V_T], V[V_T] + dtB); if (tb < tLand) { tLand = tb; landBreak = true; } }
            if (V[V_T] + dtB >= tLand - 1e-9 * dtB) { dtS = tLand - V[V_T]; landing = true; restart = true; } else landBreak = false;
            if (!(dtS > 0)) { endHere(STATUS.NUM_ERROR, -1); return true; }
            let tE = landing ? tLand : tB0 + (kB + 1) * dtB;
            if (!landing) dtS = tE - V[V_T];
            let edged = false;
            for (let pass = 0; pass < 2; pass++) {
                if (restart) {   // leapfrog (re)start from the synchronised velocity
                    WHf[0] = Y[3]; WHf[1] = Y[4]; WHf[2] = Y[5];
                    borisVel(WHf, ex0, ey0, ez0, bx0, by0, bz0, -0.5 * dtS);
                    restart = false;
                }
                WNf[0] = WHf[0]; WNf[1] = WHf[1]; WNf[2] = WHf[2];
                borisVel(WNf, ex0, ey0, ez0, bx0, by0, bz0, dtS);
                const igh = rel ? 1 / Math.sqrt(1 + (WNf[0] * WNf[0] + WNf[1] * WNf[1] + WNf[2] * WNf[2]) * INV_C2) : 1;
                YN[0] = Y[0] + dtS * WNf[0] * igh; YN[1] = Y[1] + dtS * WNf[1] * igh; YN[2] = Y[2] + dtS * WNf[2] * igh;
                // synchronising half step with the field of this step (old side of an edge, left limit at a break)
                PT[0] = tE; fieldsAt(YN, edged ? sig : -1, landBreak);
                WSf[0] = WNf[0]; WSf[1] = WNf[1]; WSf[2] = WNf[2];
                borisVel(WSf, FB[FEX], FB[FEY], FB[FEZ], FB[FBX], FB[FBY], FB[FBZ], 0.5 * dtS);
                YN[3] = WSf[0]; YN[4] = WSf[1]; YN[5] = WSf[2];
                if (!(YN[0] === YN[0] && YN[1] === YN[1] && YN[2] === YN[2] && YN[3] === YN[3] && YN[4] === YN[4] && YN[5] === YN[5])) { endHere(STATUS.NUM_ERROR, -1); return true; }
                const ig1 = rel ? 1 / Math.sqrt(1 + (YN[3] * YN[3] + YN[4] * YN[4] + YN[5] * YN[5]) * INV_C2) : 1;
                V[V_PDT] = dtS; prepHermite(Y, 3, ig, YN, 3, ig1);
                if (pass === 0 && hasRegions) {
                    const tauBad = regionCheckHermite(sig, false);
                    if (tauBad > 0) {
                        dtS = dtS * Math.max(tauBad, 1e-9) * (1 + 1e-9);
                        tE = V[V_T] + dtS;
                        landing = false; landBreak = false; restart = true; edged = true; cSplits++;
                        continue;
                    }
                }
                break;
            }
            endInside = insideA(YN);
            // power at the step end with the field that acted during the step (work sum), then the field beyond
            const p1 = FB[FEX] * HM[HVX1] + FB[FEY] * HM[HVY1] + FB[FEZ] * HM[HVZ1], phiEnd = FB[FPHI];
            if (edged || landBreak) { PT[0] = tE; fieldsAt(YN, -1, false); }
            steps++; cSteps++;
            const x0 = Y[0], y0 = Y[1], z0 = Y[2];
            V[V_VB] = Math.max(v0, Math.sqrt(HM[HVX1] * HM[HVX1] + HM[HVY1] * HM[HVY1] + HM[HVZ1] * HM[HVZ1]));
            const ev = stepEvents();
            if (ev >= 0) { handleEvent(ev, V[V_T], dtS, x0, y0, z0); return true; }
            firstStep = false;
            if (markersOn) markersOnPath(V[V_T], dtS, 1);
            if (where0 === 1) { V[V_TBAND] += dtS; flags |= FLAG.ENTERED_BOUNDARY; }
            const keS = V[V_KE], keE = keOfW(YN[3], YN[4], YN[5]);
            V[V_KE] = keE;
            const p0 = ex0 * HM[HVX0] + ey0 * HM[HVY0] + ez0 * HM[HVZ0];
            V[V_WORK] += Math.abs(keE - keS - pQ * dtS * 0.5 * (p0 + p1));
            if (V[V_E0] === V[V_E0]) { const d = Math.abs(keE + pQ * phiEnd - V[V_E0]); if (d > V[V_DEMAX]) V[V_DEMAX] = d; }
            for (let i = 0; i < 6; i++) Y[i] = YN[i];
            WHf[0] = WNf[0]; WHf[1] = WNf[1]; WHf[2] = WNf[2];
            ex0 = FB[FEX]; ey0 = FB[FEY]; ez0 = FB[FEZ]; bx0 = FB[FBX]; by0 = FB[FBY]; bz0 = FB[FBZ]; where0 = fwhere;
            V[V_T] = tE; kB++;
            afterStepCommon();
            if (hasRegions) { const s2 = regionA(Y); if (s2 !== sig) { sig = s2; restart = true; } }
            if (landing || edged) restart = true;
            recordStep(HM, HVX1);
            if (drifting && V[V_DRIFT] >= maxDrift) { endHere(STATUS.DRIFT_END, EDGE.DRIFT_LIMIT); return true; }
        }
    }

    // ------------------------------------------------------------------ one particle
    function resetParticle(P, p) {
        const b = p * P_STRIDE;
        outRow = p * S_STRIDE;
        pid = P[b + P_ID]; pSrc = P[b + P_SRC]; pSpec = P[b + P_SPECIES]; pMass = P[b + P_MASS]; pQ = P[b + P_CHARGE];
        pT0 = P[b + P_T0]; ke0 = P[b + P_KE];
        Y[0] = P[b + P_X]; Y[1] = P[b + P_Y]; Y[2] = P[b + P_Z]; Y[3] = P[b + P_WX]; Y[4] = P[b + P_WY]; Y[5] = P[b + P_WZ];
        V[V_T] = pT0; tEnd = pT0 + tMax; steps = 0; V[V_PATH] = 0; V[V_TBAND] = 0; flags = (rel ? FLAG.RELATIVISTIC : 0) | (td ? FLAG.TD_FIELDS : 0);
        V[V_E0] = NaN; V[V_DEMAX] = 0; V[V_WORK] = 0; nCrossP = 0; meshCount = 0; meshRows = 0; insideMesh = false; drifting = false; V[V_DRIFT] = 0;
        nextMarkK = 0; firstStep = true; nearS = false;
        for (let i = 0; i < nP; i++) pCount[i] = 0;
        tn = 0; V[V_MINSEG] = minSeg0; V[V_LT] = NaN; V[V_LDX] = 0; V[V_LDY] = 0; V[V_LDZ] = 0;
        kqm = pMass > 0 ? K_ACC * pQ / pMass : 0;
        absQM = pMass > 0 ? Math.abs(pQ / pMass) : 0;
        w1eV = rel ? properSpeedFromKE(1, pMass > 0 ? pMass : 1) : speedFromKE(1, pMass > 0 ? pMass : 1, false);
        w1eV2 = w1eV * w1eV;
        invTau = dragOn && pMass > 0 && pQ !== 0 ? K_ACC * Math.abs(pQ) / (KMOB * pMass) : 0;
        if (gasOn) {
            gasS = gasModel.species(pMass > 0 ? pMass : 1);
            gasRng = gasStream(seed, pid);
            V[V_GASB] = gasModel.budget(gasRng); V[V_NUS] = 0;
        }
    }

    function integrate() {
        V[V_KE] = keOfW(Y[3], Y[4], Y[5]);
        let integ = o.integrator === 'boris' ? INTEG_BORIS : (o.integrator === 'rk4' ? INTEG_RK4 : INTEG_RK45);
        // auto: Boris only without an electric field; with exact gyrophase its E×B drift is slow by θ²/12 (θ = |Ω|dt)
        if (o.integrator === 'auto' && bMax > 0 && absQM > 0 && model.hasE === false) {
            const gam = rel ? Math.sqrt(1 + (Y[3] * Y[3] + Y[4] * Y[4] + Y[5] * Y[5]) * INV_C2) : 1;
            if (tMax / (TWO_PI * gam / (K_ACC * absQM * bMax)) > 50) integ = INTEG_BORIS;
        }
        if ((dragOn || gasOn) && integ === INTEG_BORIS) integ = INTEG_RK45;   // drag and collisions live in the DP45 loop
        if (gasOn && integ === INTEG_RK4) integ = INTEG_RK45;
        if (integ === INTEG_BORIS) return runBoris();
        if (integ === INTEG_RK4) return runRK4();
        return runRK45();
    }

    function traceOne(P, p) {
        resetParticle(P, p);
        if (recTraj) trajOff[p] = nTrajPts;
        let ok = true;
        const finite = Y[0] === Y[0] && Y[1] === Y[1] && Y[2] === Y[2] && Y[3] === Y[3] && Y[4] === Y[4] && Y[5] === Y[5] && pT0 === pT0;
        const ig0 = rel ? 1 / Math.sqrt(1 + (Y[3] * Y[3] + Y[4] * Y[4] + Y[5] * Y[5]) * INV_C2) : 1;
        const vx = Y[3] * ig0, vy = Y[4] * ig0, vz = Y[5] * ig0;
        if (!finite || !(pMass > 0)) {
            writeSummary(STATUS.NUM_ERROR, -1, V[V_T], Y[0], Y[1], Y[2], vx, vy, vz, Y[3], Y[4], Y[5]);
            if (recTraj) trajOff[p + 1] = nTrajPts;
            return true;
        }
        if (!td && !dragOn && !gasOn) V[V_E0] = keOfW(Y[3], Y[4], Y[5]) + pQ * model.potential(V[V_T], Y[0], Y[1], Y[2]);
        recordPoint(Y[0], Y[1], Y[2], V[V_T], vx, vy, vz, true);
        if (markersOn) { pushMarker(V[V_T], Y[0], Y[1], Y[2]); nextMarkK = 1; }
        for (let i = 0; i < nP; i++) gS[i] = planeG(i, Y[0], Y[1], Y[2]);
        if (!insideA(Y)) {
            const code = faceCode(Y[0], Y[1], Y[2]);
            if (!driftAllowed(code)) writeSummary(STATUS.EXIT, code, V[V_T], Y[0], Y[1], Y[2], vx, vy, vz, Y[3], Y[4], Y[5]);
            else if (!integrateDrift) driftAnalytic(V[V_T], Y[0], Y[1], Y[2], vx, vy, vz, Y[3], Y[4], Y[5]);
            else { drifting = true; ok = integrate(); }
        } else {
            let born = -1;
            if (hitsOn) {
                const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
                const s = sp > 0 ? 1e-6 * h / sp : 0;
                const own = model.ownerAt(Y[0] + s * vx, Y[1] + s * vy, Y[2] + s * vz);
                if (own >= 0) {
                    if (own < nElec && transp[own] === 1) insideMesh = true;
                    else born = own;
                }
            }
            if (born >= 0) writeSummary(STATUS.BORN_INSIDE, born, V[V_T], Y[0], Y[1], Y[2], vx, vy, vz, Y[3], Y[4], Y[5]);
            else { nearS = nearA(Y); ok = integrate(); }
        }
        if (recTraj) flushTrajectory(p);
        return ok;
    }

    function cancelRow(P, p) {
        resetParticle(P, p);
        if (recTraj) trajOff[p] = nTrajPts;
        const ig = rel ? 1 / Math.sqrt(1 + (Y[3] * Y[3] + Y[4] * Y[4] + Y[5] * Y[5]) * INV_C2) : 1;
        writeSummary(STATUS.CANCELLED, -1, V[V_T], Y[0], Y[1], Y[2], Y[3] * ig, Y[4] * ig, Y[5] * ig, Y[3], Y[4], Y[5]);
        if (recTraj) trajOff[p + 1] = nTrajPts;
    }

    function finish(i0) {
        const crossings = cross.slice(0, nCross * C_STRIDE);
        const traj = recTraj ? { offsets: trajOff, pts: trajPts.slice(0, 4 * nTrajPts) } : null;
        const markers = markersOn ? marks.slice(0, 5 * nMarks) : null;
        const stats = { steps: cSteps, rejects: cRejects, evals: cEvals, ms: 0, edgeSplits: cSplits, regionViolations: cViol, crossDropped: cDropped, collisions: cColl };
        return { n: nTotal, i0, summary, crossings, nCross, traj, markers, stats };
    }

    return { traceOne, cancelRow, finish, setStop };
}

/**
 * Concatenates partial results (any order) into one result in index order.
 * @param {Array<object>} parts TraceResult objects
 * @returns {object} TraceResult
 */
export function mergeResults(parts) {
    const list = (parts || []).filter(Boolean).slice().sort((a, b) => a.i0 - b.i0);
    let n = 0, nc = 0, np = 0, nm = 0, anyTraj = false, anyMarkers = false;
    for (const r of list) {
        n += r.n; nc += r.nCross;
        if (r.traj) { anyTraj = true; np += r.traj.pts.length / 4; }
        if (r.markers) { anyMarkers = true; nm += r.markers.length; }
    }
    const summary = new Float64Array(n * S_STRIDE), crossings = new Float64Array(nc * C_STRIDE);
    const offsets = anyTraj ? new Uint32Array(n + 1) : null, pts = anyTraj ? new Float32Array(4 * np) : null;
    const markers = anyMarkers ? new Float32Array(nm) : null;
    const stats = { steps: 0, rejects: 0, evals: 0, ms: 0, edgeSplits: 0, regionViolations: 0, crossDropped: 0, collisions: 0 };
    let ip = 0, ic = 0, it = 0, im = 0;
    for (const r of list) {
        summary.set(r.summary.subarray(0, r.n * S_STRIDE), ip * S_STRIDE);
        crossings.set(r.crossings.subarray(0, r.nCross * C_STRIDE), ic * C_STRIDE);
        if (anyTraj) {
            if (r.traj) {
                for (let i = 0; i < r.n; i++) offsets[ip + i] = it + r.traj.offsets[i];
                pts.set(r.traj.pts, 4 * it);
                it += r.traj.pts.length / 4;
            } else for (let i = 0; i < r.n; i++) offsets[ip + i] = it;
            offsets[ip + r.n] = it;
        }
        if (anyMarkers && r.markers) { markers.set(r.markers, im); im += r.markers.length; }
        for (const k of Object.keys(stats)) if (r.stats && typeof r.stats[k] === 'number') stats[k] += r.stats[k];
        if (r.stats && r.stats.lockstep) stats.lockstep = true;   // a space-charge batch (coulomb.js): steps are common steps
        ip += r.n; ic += r.nCross;
    }
    return { n, i0: list.length ? list[0].i0 : 0, summary, crossings, nCross: nc, traj: anyTraj ? { offsets, pts } : null, markers, stats };
}

/**
 * The ArrayBuffers of a result, for postMessage transfer lists (each listed once).
 * @param {object} result @returns {ArrayBuffer[]}
 */
export function resultTransferables(result) {
    const out = [];
    const add = (a) => { if (a && a.buffer instanceof ArrayBuffer && !out.includes(a.buffer)) out.push(a.buffer); };
    if (!result) return out;
    add(result.summary); add(result.crossings); add(result.markers);
    if (result.traj) { add(result.traj.offsets); add(result.traj.pts); }
    return out;
}
