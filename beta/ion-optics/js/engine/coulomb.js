/* ==========================================================================
   Ion optics engine: coulomb.js (space-charge onset estimator)
   Particle-particle Coulomb interaction by direct summation for small
   bunches (≤ 2000 particles), integrated in lockstep with classical
   Runge-Kutta 4 at the smallest per-particle step cap.

   a_i = K_ACC(q_i/m_i)(E + v_i × B) + K_C q_i Σ_j F q_j (x_i − x_j) / (m_i (|x_i − x_j|² + ε²)^{3/2}),
   K_C = e²/(4π ε0 u) in mm³/µs² (constants.js), ε the Plummer softening
   length (Aarseth, Gravitational N-Body Simulations, Cambridge (2003), §2),
   F the charge factor (each traced particle stands for F real ones; F
   multiplies the partner charge once per pair; opts.factorBySource scales F
   per source of the partner, for subsets that carry a whole run's charge).
   The pair time scale √((r² + ε²)^{3/2} / (K_C F |q_i q_j| (1/m_i + 1/m_j)))
   limits the common step. Interactions are electrostatic (quasistatic, no
   retardation) and the particles do not change the electrode charges:
   superposed pair forces are an estimator of the onset of space-charge
   effects (Reiser, Theory and Design of Charged Particle Beams, 2nd ed.
   (2008), ch. 4), not a self-consistent solution; near a
   space-charge-limited emitter they are order-of-magnitude only.
   Events are located on the straight chord of each step (linear in time):
   planes (with the same side, extent, limits and radius filters as
   trace.js), electrode hits and meshes, domain exits. Time markers lie on
   the cubic Hermite path of each step (end positions and velocities).
   Stored trajectories are thinned like trace.js: when a particle's buffer
   is full every other point is dropped (both ends kept) and the minimum
   spacing doubles. Particles born later join at their birth time;
   particles that stop leave the interaction.
   Plug-ins shared with trace.js: Stokes drag (spec §3.12) and hard-sphere gas
   collisions (gas.js; the collision budget is spent along the step and a
   collision is applied at the end of the step that exhausts it, the excess
   exposure carrying over, so the collision rate is exact; steps are capped at
   a tenth of the mean free time).
   ========================================================================== */
import { K_ACC, C_MMUS, K_COUL } from './constants.js';
import { uniform01 } from './rng.js';
import { createGasModel, gasStream } from './gas.js';
import { planeAcceptor } from './trace.js';
import {
    P_STRIDE, P_ID, P_SRC, P_SPECIES, P_MASS, P_CHARGE, P_T0, P_X, P_Y, P_Z, P_WX, P_WY, P_WZ, P_KE,
    S_STRIDE, S_ID, S_STATUS, S_WHERE, S_T, S_X, S_Y, S_Z, S_VX, S_VY, S_VZ, S_KE, S_TOF, S_STEPS, S_PATH,
    S_DE_END, S_DE_MAX, S_WORK, S_NCROSS, S_TBAND, S_FLAGS, S_SRC, S_SPECIES, S_KE0, S_T0,
    C_STRIDE, C_ID, C_PLANE, C_T, C_X, C_Y, C_Z, C_VX, C_VY, C_VZ, C_KE, C_DIR, C_K, C_KIND, C_ELEC,
    STATUS, EDGE, FLAG,
} from './layout.js';

const INV_C2 = 1 / (C_MMUS * C_MMUS);
const UC2 = C_MMUS * C_MMUS / K_ACC;
const MESH_A = 0x7f4a7c15;
/** Largest bunch the direct summation accepts (O(N²) per step). */
export const MAX_PARTICLES = 2000;
/** Default softening ε (mm) when none is given. */
export const DEFAULT_SOFTENING = 1e-4;

function engineError(code, message) { const e = new Error(message); e.name = 'EngineError'; e.code = code; return e; }
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const posNum = (v, d) => (typeof v === 'number' && v > 0 && Number.isFinite(v) ? v : d);

/**
 * Lockstep RK4 with direct Coulomb summation.
 * @param {object} model FieldModel
 * @param {Float64Array} particles P_STRIDE rows (≤ 2000)
 * @param {{ relativistic?: boolean, tMax?: number, maxSteps?: number, maxStepCells?: number, nearStepCells?: number,
 *   maxDrift?: number, planes?: object[], beyond?: object, seed?: number, softening?: number, factor?: number, pairStep?: number,
 *   factorBySource?: ArrayLike<number>|null,
 *   drag?: { type: 'stokes', mobility: number, gasVelocity?: number[] } | null, gas?: object | null,
 *   record?: { trajectories?: boolean, maxPoints?: number, minSegCells?: number, markersDt?: number|null }, i0?: number }} [opts]
 *   softening: ε in mm (default 1e-4); factor: charge multiplier of the partner in every pair (default 1);
 *   factorBySource: an extra multiplier of the partner's charge by its source index (P_SRC; missing entries 1), so that a
 *   subset of each source carries that source's whole charge;
 *   pairStep: the common step is at most pairStep × the smallest pair time scale (default 0.01);
 *   record.markersDt: time markers every markersDt µs from each particle's birth (as trace.js).
 * @param {{ shouldStop?: () => boolean, onProgress?: (p: { done: number, total: number }) => void, progressEveryMs?: number }} [hooks]
 * @returns {object} TraceResult (same layout as traceParticles; S_DE_END/S_DE_MAX are NaN, S_WORK 0)
 */
export function traceCoulomb(model, particles, opts = {}, hooks = {}) {
    const t0ms = performance.now();
    const n = particles ? Math.floor(particles.length / P_STRIDE) : 0;
    if (n > MAX_PARTICLES) throw engineError('E_UNSUPPORTED', 'Space-charge tracing is limited to ' + MAX_PARTICLES + ' particles.');
    const h = model.h > 0 ? model.h : 1;
    const rel = opts.relativistic !== false;
    const tMax = posNum(opts.tMax, 1000), maxSteps = Math.floor(posNum(opts.maxSteps, 500000)), maxDrift = posNum(opts.maxDrift, 10000);
    const sCell = Math.min(1, posNum(opts.maxStepCells, 0.5)) * h, sNear = Math.min(1, posNum(opts.nearStepCells, 0.1)) * h;
    const eps2 = Math.pow(posNum(opts.softening, DEFAULT_SOFTENING), 2);
    const factor = typeof opts.factor === 'number' && opts.factor >= 0 && Number.isFinite(opts.factor) ? opts.factor : 1;
    const KC = K_COUL * factor;
    const bySrc = opts.factorBySource && typeof opts.factorBySource.length === 'number' ? opts.factorBySource : null;
    const pairStep = posNum(opts.pairStep, 0.01);
    const seed = num(opts.seed, 1);
    const beyond = opts.beyond || {};
    const planes = Array.isArray(opts.planes) ? opts.planes : [];
    const nP = planes.length;
    const accept = planeAcceptor(planes, h, !!model.cyl);
    const rec = opts.record || {};
    const recTraj = rec.trajectories !== false;
    const maxPts = Math.max(2, Math.floor(posNum(rec.maxPoints, 2000)));
    const minSeg = Math.max(0, num(rec.minSegCells, 0.5)) * h;
    const markersDt = posNum(rec.markersDt, 0), markersOn = markersDt > 0;
    const stop = hooks && typeof hooks.shouldStop === 'function' ? hooks.shouldStop : null;
    const onProgress = hooks && typeof hooks.onProgress === 'function' ? hooks.onProgress : null;
    const progressEvery = hooks && hooks.progressEveryMs > 0 ? hooks.progressEveryMs : 100;
    const hasB = !!model.hasB, hitsOn = !!model.hasGeometry;
    const transp = model.transparent || new Uint8Array(0), transm = model.transmission || new Float64Array(0);
    // plug-ins
    const drag = opts.drag && opts.drag.type === 'stokes' && opts.drag.mobility > 0 ? opts.drag : null;
    const KMOB = drag ? 1e-4 * drag.mobility : 0;
    const gasV = drag && Array.isArray(drag.gasVelocity) ? drag.gasVelocity.map((v) => num(v, 0)) : [0, 0, 0];
    const gasOpt = opts.gas && opts.gas.enabled !== false && opts.gas.pressure > 0 && opts.gas.temperature > 0 && opts.gas.mass > 0 && opts.gas.diameter > 0 ? opts.gas : null;
    const gasModel = gasOpt ? createGasModel(gasOpt) : null;
    const gasOn = gasModel !== null;

    // state
    const X = new Float64Array(3 * n), W = new Float64Array(3 * n), M = new Float64Array(n), invM = new Float64Array(n), Qc = new Float64Array(n), T0 = new Float64Array(n);
    const X0 = new Float64Array(3 * n), W0 = new Float64Array(3 * n), XT = new Float64Array(3 * n), WT = new Float64Array(3 * n);
    const KX = [0, 1, 2, 3].map(() => new Float64Array(3 * n)), KW = [0, 1, 2, 3].map(() => new Float64Array(3 * n));
    const active = new Uint8Array(n), done = new Uint8Array(n);
    const steps = new Float64Array(n), path = new Float64Array(n), drift = new Float64Array(n), ncross = new Float64Array(n), meshCount = new Int32Array(n);
    const invTau = new Float64Array(n);
    const gasSp = gasOn ? new Array(n).fill(null) : null, gasRng = gasOn ? new Array(n).fill(null) : null;
    const gasBudget = gasOn ? new Float64Array(n) : null, gasNu = gasOn ? new Float64Array(n) : null;
    const pCount = new Int32Array(n * Math.max(1, nP));
    const summary = new Float64Array(n * S_STRIDE);
    const cross = [];
    const traj = recTraj ? Array.from({ length: n }, () => []) : null;
    const segMin = recTraj ? new Float64Array(n).fill(minSeg) : null;   // per-particle minimum spacing, doubled at each thinning
    const marks = markersOn ? Array.from({ length: n }, () => []) : null, markK = markersOn ? new Float64Array(n) : null;
    // partner charge with the per-source factor (null: every pair uses K_C·F·q_i·q_j as before)
    const QF = bySrc ? new Float64Array(n) : null;
    let pairMax = 0, evals = 0, totalSteps = 0, nDone = 0, nColl = 0;
    for (let i = 0; i < n; i++) {
        const b = i * P_STRIDE;
        M[i] = particles[b + P_MASS]; invM[i] = M[i] > 0 ? 1 / M[i] : 0; Qc[i] = particles[b + P_CHARGE]; T0[i] = particles[b + P_T0];
        if (QF) { const f = bySrc[particles[b + P_SRC]]; QF[i] = Qc[i] * (typeof f === 'number' && f >= 0 && Number.isFinite(f) ? f : 1); }
        for (let c = 0; c < 3; c++) { X[3 * i + c] = particles[b + P_X + c]; W[3 * i + c] = particles[b + P_WX + c]; }
        invTau[i] = drag && M[i] > 0 && Qc[i] !== 0 ? K_ACC * Math.abs(Qc[i]) / (KMOB * M[i]) : 0;
        if (gasOn) {
            gasSp[i] = gasModel.species(M[i] > 0 ? M[i] : 1);
            gasRng[i] = gasStream(seed, particles[b + P_ID]);
            gasBudget[i] = gasModel.budget(gasRng[i]);
        }
    }
    const PT = new Float64Array(4), ef = new Float64Array(4), bf = new Float64Array(3);
    const Ev = typeof model.Ev === 'function' ? model.Ev : (P, out, s, l) => model.E(P[0], P[1], P[2], P[3], out, s, l);
    const Bv = typeof model.Bv === 'function' ? model.Bv : (P, out, s) => model.B(P[1], P[2], P[3], out, s);

    const gamma = (wx, wy, wz) => (rel ? Math.sqrt(1 + (wx * wx + wy * wy + wz * wz) * INV_C2) : 1);
    function keOf(i, wx, wy, wz) {
        const w2 = wx * wx + wy * wy + wz * wz;
        if (!rel) return M[i] * w2 / (2 * K_ACC);
        const u2 = w2 * INV_C2;
        return u2 / (Math.sqrt(1 + u2) + 1) * M[i] * UC2;
    }
    function point(i, x, y, z, t, force) {
        if (!recTraj) return;
        const a = traj[i], k = a.length;
        if (!force && k >= 4) { const dx = x - a[k - 4], dy = y - a[k - 3], dz = z - a[k - 2], ms = segMin[i]; if (dx * dx + dy * dy + dz * dz < ms * ms) return; }
        const m = k >> 2;
        if (m >= maxPts) {
            // full: keep the even points and the last one (both ends), then double the minimum spacing (as trace.js)
            let j = 1;
            for (let s = 2; s < m - 1; s += 2, j++) { const d = 4 * j, o = 4 * s; a[d] = a[o]; a[d + 1] = a[o + 1]; a[d + 2] = a[o + 2]; a[d + 3] = a[o + 3]; }
            const d = 4 * j, o = 4 * (m - 1);
            a[d] = a[o]; a[d + 1] = a[o + 1]; a[d + 2] = a[o + 2]; a[d + 3] = a[o + 3];
            a.length = 4 * (j + 1);
            segMin[i] = segMin[i] > 0 ? 2 * segMin[i] : 0.5 * h;
        }
        a.push(x, y, z, t);
    }
    /** Time markers of particle i up to time tLim on the cubic Hermite path of the current step (start X0/V0 at T, end X/V1 after dt). */
    function stepMarkers(i, tS, dt, tLim, vx0, vy0, vz0, vx1, vy1, vz1) {
        const o = 3 * i, list = marks[i], id = particles[i * P_STRIDE + P_ID];
        for (;;) {
            const tm = T0[i] + markK[i] * markersDt;
            if (tm > tLim) break;
            if (tm >= tS) {
                const s = dt > 0 ? (tm - tS) / dt : 0, s2 = s * s, s3 = s2 * s;
                const h00 = 2 * s3 - 3 * s2 + 1, h10 = (s3 - 2 * s2 + s) * dt, h01 = -2 * s3 + 3 * s2, h11 = (s3 - s2) * dt;
                list.push(id, tm,
                    h00 * X0[o] + h10 * vx0 + h01 * X[o] + h11 * vx1,
                    h00 * X0[o + 1] + h10 * vy0 + h01 * X[o + 1] + h11 * vy1,
                    h00 * X0[o + 2] + h10 * vz0 + h01 * X[o + 2] + h11 * vz1);
            }
            markK[i]++;
        }
    }
    function finish(i, status, where, t, x, y, z, wx, wy, wz) {
        const g = gamma(wx, wy, wz), o = i * S_STRIDE, b = i * P_STRIDE;
        summary[o + S_ID] = particles[b + P_ID]; summary[o + S_STATUS] = status; summary[o + S_WHERE] = where; summary[o + S_T] = t;
        summary[o + S_X] = x; summary[o + S_Y] = y; summary[o + S_Z] = z; summary[o + S_VX] = wx / g; summary[o + S_VY] = wy / g; summary[o + S_VZ] = wz / g;
        summary[o + S_KE] = keOf(i, wx, wy, wz); summary[o + S_TOF] = t - T0[i]; summary[o + S_STEPS] = steps[i]; summary[o + S_PATH] = path[i];
        summary[o + S_DE_END] = NaN; summary[o + S_DE_MAX] = NaN; summary[o + S_WORK] = 0; summary[o + S_NCROSS] = ncross[i]; summary[o + S_TBAND] = 0;
        summary[o + S_FLAGS] = (rel ? FLAG.RELATIVISTIC : 0) | (model.timeDependent ? FLAG.TD_FIELDS : 0);
        summary[o + S_SRC] = particles[b + P_SRC]; summary[o + S_SPECIES] = particles[b + P_SPECIES]; summary[o + S_KE0] = particles[b + P_KE]; summary[o + S_T0] = T0[i];
        point(i, x, y, z, t, true);
        active[i] = 0; done[i] = 1; nDone++;
    }
    // event records of one particle's step and the chord point (position, proper velocity) at parameter u
    const EV_PLANE = 0, EV_MESH = 1, EV_HIT = 2, EV_ABSORB = 3, EV_EXIT = 4, EV_DETECT = 5;
    const EVN = 8 + 4 * nP;
    const evU = new Float64Array(EVN), evK = new Int8Array(EVN), evI = new Int32Array(EVN), evD = new Int8Array(EVN), evC = new Int32Array(EVN), evOrd = new Int32Array(EVN);
    let nEv = 0;
    function addEv(u, kind, idx, dir, k) {
        if (nEv >= EVN) return;
        evU[nEv] = u; evK[nEv] = kind; evI[nEv] = idx; evD[nEv] = dir; evC[nEv] = k; evOrd[nEv] = nEv; nEv++;
    }
    const QQ = new Float64Array(6);
    function chordAt(o, u) {
        QQ[0] = X0[o] + u * (X[o] - X0[o]); QQ[1] = X0[o + 1] + u * (X[o + 1] - X0[o + 1]); QQ[2] = X0[o + 2] + u * (X[o + 2] - X0[o + 2]);
        QQ[3] = W0[o] + u * (W[o] - W0[o]); QQ[4] = W0[o + 1] + u * (W[o + 1] - W0[o + 1]); QQ[5] = W0[o + 2] + u * (W[o + 2] - W0[o + 2]);
    }
    /** Crossing row at the chord point QQ. */
    function pushCross(i, plane, kind, elec, dir, k, t) {
        const g = gamma(QQ[3], QQ[4], QQ[5]);
        const row = new Float64Array(C_STRIDE);
        row[C_ID] = particles[i * P_STRIDE + P_ID]; row[C_PLANE] = plane; row[C_T] = t; row[C_X] = QQ[0]; row[C_Y] = QQ[1]; row[C_Z] = QQ[2];
        row[C_VX] = QQ[3] / g; row[C_VY] = QQ[4] / g; row[C_VZ] = QQ[5] / g; row[C_KE] = keOf(i, QQ[3], QQ[4], QQ[5]);
        row[C_DIR] = dir; row[C_K] = k; row[C_KIND] = kind; row[C_ELEC] = elec;
        cross.push(row); ncross[i]++;
    }
    function planeG(p, x, y, z) {
        switch (p.kind) {
            case 'y': return y - p.at;
            case 'z': return z - p.at;
            case 'r': return Math.sqrt(y * y + z * z) - p.at;
            case 'sphere': { const c = Array.isArray(p.center) ? p.center : [0, 0, 0], dx = x - num(c[0], 0), dy = y - num(c[1], 0), dz = z - num(c[2], 0); return Math.sqrt(dx * dx + dy * dy + dz * dz) - p.at; }
            case 'segment': { const r = model.cyl ? Math.sqrt(y * y + z * z) : y, dx = p.p1[0] - p.p0[0], dy = p.p1[1] - p.p0[1], L = Math.hypot(dx, dy) || 1; return ((x - p.p0[0]) * dy - (r - p.p0[1]) * dx) / L; }
            default: return x - p.at;
        }
    }
    /** Accelerations (dw/dt) at state (xs, ws) and time t into kw; dx/dt into kx. Coulomb over active particles. */
    function accel(t, xs, ws, kx, kw) {
        for (let i = 0; i < n; i++) {
            if (!active[i]) continue;
            const o = 3 * i, g = gamma(ws[o], ws[o + 1], ws[o + 2]);
            const vx = ws[o] / g, vy = ws[o + 1] / g, vz = ws[o + 2] / g;
            kx[o] = vx; kx[o + 1] = vy; kx[o + 2] = vz;
            PT[0] = t; PT[1] = xs[o]; PT[2] = xs[o + 1]; PT[3] = xs[o + 2];
            Ev(PT, ef, -1, false); evals++;
            let fx = ef[0], fy = ef[1], fz = ef[2];
            if (hasB) { Bv(PT, bf, -1); fx += vy * bf[2] - vz * bf[1]; fy += vz * bf[0] - vx * bf[2]; fz += vx * bf[1] - vy * bf[0]; }
            const k = K_ACC * Qc[i] * invM[i];
            kw[o] = k * fx; kw[o + 1] = k * fy; kw[o + 2] = k * fz;
            if (invTau[i] > 0) { kw[o] -= (vx - gasV[0]) * invTau[i]; kw[o + 1] -= (vy - gasV[1]) * invTau[i]; kw[o + 2] -= (vz - gasV[2]) * invTau[i]; }
        }
        if (QF !== null) { pairsBySource(xs, kw); return; }
        for (let i = 0; i < n; i++) {
            if (!active[i] || Qc[i] === 0) continue;
            const oi = 3 * i, xi = xs[oi], yi = xs[oi + 1], zi = xs[oi + 2], qi = KC * Qc[i], mi = invM[i];
            for (let j = i + 1; j < n; j++) {
                if (!active[j] || Qc[j] === 0) continue;
                const oj = 3 * j;
                const dx = xi - xs[oj], dy = yi - xs[oj + 1], dz = zi - xs[oj + 2];
                const d2 = dx * dx + dy * dy + dz * dz + eps2, d = Math.sqrt(d2), inv3 = 1 / (d2 * d);
                const qq = qi * Qc[j] * inv3;
                const fi = qq * mi, fj = qq * invM[j];
                kw[oi] += fi * dx; kw[oi + 1] += fi * dy; kw[oi + 2] += fi * dz;
                kw[oj] -= fj * dx; kw[oj + 1] -= fj * dy; kw[oj + 2] -= fj * dz;
                // |f_i| + |f_j| = |qq|(1/m_i + 1/m_j)/d³ is the inverse square of the pair time scale
                const r = (fi < 0 ? -fi : fi) + (fj < 0 ? -fj : fj);
                if (r > pairMax) pairMax = r;
            }
        }
    }
    /** Pair forces with per-source partner factors: particle i feels K_C·F·q_i·(f_j q_j), particle j feels K_C·F·q_j·(f_i q_i). */
    function pairsBySource(xs, kw) {
        for (let i = 0; i < n; i++) {
            if (!active[i] || Qc[i] === 0) continue;
            const oi = 3 * i, xi = xs[oi], yi = xs[oi + 1], zi = xs[oi + 2], qi = KC * Qc[i], qfi = KC * QF[i], mi = invM[i];
            for (let j = i + 1; j < n; j++) {
                if (!active[j] || Qc[j] === 0) continue;
                const oj = 3 * j;
                const dx = xi - xs[oj], dy = yi - xs[oj + 1], dz = zi - xs[oj + 2];
                const d2 = dx * dx + dy * dy + dz * dz + eps2, d = Math.sqrt(d2), inv3 = 1 / (d2 * d);
                const fi = qi * QF[j] * inv3 * mi, fj = qfi * Qc[j] * inv3 * invM[j];
                kw[oi] += fi * dx; kw[oi + 1] += fi * dy; kw[oi + 2] += fi * dz;
                kw[oj] -= fj * dx; kw[oj + 1] -= fj * dy; kw[oj + 2] -= fj * dz;
                const r = (fi < 0 ? -fi : fi) + (fj < 0 ? -fj : fj);
                if (r > pairMax) pairMax = r;
            }
        }
    }

    // birth: positions outside the domain or inside electrodes end immediately
    let T = Infinity;
    for (let i = 0; i < n; i++) if (T0[i] < T) T = T0[i];
    if (!(T < Infinity)) T = 0;
    const tStop = (i) => T0[i] + tMax;
    function activate(i) {
        const o = 3 * i;
        point(i, X[o], X[o + 1], X[o + 2], T0[i], true);
        if (!(M[i] > 0)) { finish(i, STATUS.NUM_ERROR, -1, T0[i], X[o], X[o + 1], X[o + 2], W[o], W[o + 1], W[o + 2]); return; }
        if (markersOn) { marks[i].push(particles[i * P_STRIDE + P_ID], T0[i], X[o], X[o + 1], X[o + 2]); markK[i] = 1; }
        if (!model.inside(X[o], X[o + 1], X[o + 2])) {
            const code = typeof model.faceOf === 'function' ? model.faceOf(X[o], X[o + 1], X[o + 2]) : EDGE.XMAX;
            const key = typeof model.beyondKey === 'function' ? model.beyondKey(code) : 'xmax';
            if (beyond[key] !== 'drift') { finish(i, STATUS.EXIT, code, T0[i], X[o], X[o + 1], X[o + 2], W[o], W[o + 1], W[o + 2]); return; }
        }
        if (hitsOn) {
            const g = gamma(W[o], W[o + 1], W[o + 2]), sp = Math.hypot(W[o], W[o + 1], W[o + 2]) / g, s = sp > 0 ? 1e-6 * h / sp : 0;
            const own = model.ownerAt(X[o] + s * W[o] / g, X[o + 1] + s * W[o + 1] / g, X[o + 2] + s * W[o + 2] / g);
            if (own >= 0 && !(own < transp.length && transp[own] === 1)) { finish(i, STATUS.BORN_INSIDE, own, T0[i], X[o], X[o + 1], X[o + 2], W[o], W[o + 1], W[o + 2]); return; }
        }
        active[i] = 1;
    }
    for (let i = 0; i < n; i++) if (T0[i] <= T) activate(i);

    let nSteps = 0, cancelled = false, lastProgress = t0ms;
    for (;;) {
        let nAct = 0, nextBirth = Infinity, nextStop = Infinity;
        for (let i = 0; i < n; i++) {
            if (active[i]) { nAct++; if (tStop(i) < nextStop) nextStop = tStop(i); } else if (!done[i] && T0[i] < nextBirth) nextBirth = T0[i];
        }
        if (nAct === 0) {
            if (nextBirth === Infinity) break;
            T = nextBirth;
            for (let i = 0; i < n; i++) if (!done[i] && !active[i] && T0[i] <= T) activate(i);
            continue;
        }
        if (nSteps >= maxSteps) { for (let i = 0; i < n; i++) if (active[i]) { const o = 3 * i; finish(i, STATUS.STEPS, -1, T, X[o], X[o + 1], X[o + 2], W[o], W[o + 1], W[o + 2]); } break; }
        if (stop !== null && stop()) { cancelled = true; break; }
        if (onProgress !== null) {
            const nowMs = performance.now();
            if (nowMs - lastProgress >= progressEvery) { lastProgress = nowMs; onProgress({ done: nDone, total: n }); }
        }
        // first stage gives the accelerations and the pair time scale for the step cap
        pairMax = 0;
        accel(T, X, W, KX[0], KW[0]);
        let dt = Infinity;
        for (let i = 0; i < n; i++) {
            if (!active[i]) continue;
            const o = 3 * i;
            const v = Math.hypot(KX[0][o], KX[0][o + 1], KX[0][o + 2]), a = Math.hypot(KW[0][o], KW[0][o + 1], KW[0][o + 2]);
            const s = hitsOn && model.near(X[o], X[o + 1], X[o + 2]) ? sNear : sCell;
            const den = Math.max(v, Math.sqrt(2 * s * a));
            if (den > 0 && s / den < dt) dt = s / den;
            if (invTau[i] > 0 && 0.1 / invTau[i] < dt) dt = 0.1 / invTau[i];   // drag: a tenth of the relaxation time (fixed-step RK4)
            if (gasOn) {
                const nu = gasModel.rate(gasSp[i], KX[0][o], KX[0][o + 1], KX[0][o + 2]);
                gasNu[i] = nu;
                if (nu > 0 && 0.1 / nu < dt) dt = 0.1 / nu;
            }
        }
        if (pairMax > 0) dt = Math.min(dt, pairStep / Math.sqrt(pairMax));
        if (model.minPeriod > 0 && model.minPeriod < Infinity) dt = Math.min(dt, model.minPeriod / 32);
        let tE = T + dt;
        if (nextBirth < tE) tE = nextBirth;
        if (nextStop < tE) tE = nextStop;
        if (model.timeDependent) { const tb = model.nextBreak(T, tE); if (tb < tE) tE = tb; }
        dt = tE - T;
        if (!(dt > 0)) dt = 1e-12;
        // RK4 stages
        X0.set(X); W0.set(W);
        const hdt = 0.5 * dt;
        for (let s = 1; s < 4; s++) {
            const f = s === 3 ? dt : hdt, kx = KX[s - 1], kw = KW[s - 1];
            for (let i = 0; i < n; i++) if (active[i]) for (let c = 3 * i; c < 3 * i + 3; c++) { XT[c] = X0[c] + f * kx[c]; WT[c] = W0[c] + f * kw[c]; }
            accel(T + f, XT, WT, KX[s], KW[s]);
        }
        for (let i = 0; i < n; i++) {
            if (!active[i]) continue;
            for (let c = 3 * i; c < 3 * i + 3; c++) {
                X[c] = X0[c] + dt / 6 * (KX[0][c] + 2 * KX[1][c] + 2 * KX[2][c] + KX[3][c]);
                W[c] = W0[c] + dt / 6 * (KW[0][c] + 2 * KW[1][c] + 2 * KW[2][c] + KW[3][c]);
            }
        }
        nSteps++; totalSteps++;
        const T1 = T + dt;
        // events on each particle's chord (linear in time); preallocated records, no allocation per step
        for (let i = 0; i < n; i++) {
            if (!active[i]) continue;
            const o = 3 * i;
            steps[i]++;
            const ax = X0[o], ay = X0[o + 1], az = X0[o + 2], bx = X[o], by = X[o + 1], bz = X[o + 2];
            if (!(bx === bx && by === by && bz === bz && W[o] === W[o])) { finish(i, STATUS.NUM_ERROR, -1, T1, ax, ay, az, W0[o], W0[o + 1], W0[o + 2]); continue; }
            nEv = 0;
            // exit
            const inS = model.inside(ax, ay, az), inE = model.inside(bx, by, bz);
            if (inS && !inE) {
                let lo = 0, hi = 1;
                for (let it = 0; it < 60; it++) { const mid = 0.5 * (lo + hi); if (model.inside(ax + mid * (bx - ax), ay + mid * (by - ay), az + mid * (bz - az))) lo = mid; else hi = mid; }
                const code = typeof model.faceOf === 'function' ? model.faceOf(ax + hi * (bx - ax), ay + hi * (by - ay), az + hi * (bz - az)) : EDGE.XMAX;
                const key = typeof model.beyondKey === 'function' ? model.beyondKey(code) : 'xmax';
                if (beyond[key] !== 'drift') addEv(hi, EV_EXIT, code, 0, 0);
            }
            // electrode hits and meshes on the chord
            if (hitsOn && inS && (model.near(ax, ay, az) || model.near(bx, by, bz))) {
                const r = model.firstHit(ax, ay, az, bx, by, bz, false);
                if (r !== null) {
                    const e = r.electrode;
                    if (e >= 0 && e < transp.length && transp[e] === 1) {
                        meshCount[i]++;
                        const pass = uniform01(seed, MESH_A, particles[i * P_STRIDE + P_ID], meshCount[i]) < transm[e];
                        addEv(r.u, pass ? EV_MESH : EV_ABSORB, e, 0, meshCount[i]);
                    } else addEv(r.u, EV_HIT, e, 0, 0);
                }
            }
            // planes
            for (let pi = 0; pi < nP; pi++) {
                const p = planes[pi], ga = planeG(p, ax, ay, az), gb = planeG(p, bx, by, bz);
                if ((ga > 0) === (gb > 0)) continue;
                const u = ga === gb ? 0 : ga / (ga - gb);
                if (steps[i] === 1 && u <= 1e-12) continue;
                chordAt(o, u);
                const dir = gb > 0 ? 1 : -1;
                if (!accept(pi, QQ[0], QQ[1], QQ[2], dir)) continue;
                const c = ++pCount[i * nP + pi];
                addEv(u, p.terminate ? EV_DETECT : EV_PLANE, pi, dir, c);
            }
            // process in chord order (insertion sort on the few events)
            for (let a = 1; a < nEv; a++) { const v = evOrd[a]; let b = a - 1; while (b >= 0 && evU[evOrd[b]] > evU[v]) { evOrd[b + 1] = evOrd[b]; b--; } evOrd[b + 1] = v; }
            if (markersOn) {
                // markers up to the first event that ends the particle (or the step end)
                let uEnd = 1;
                for (let a = 0; a < nEv; a++) {
                    const e = evOrd[a], kind = evK[e];
                    if (kind === EV_PLANE || kind === EV_MESH || (kind === EV_DETECT && evC[e] !== 1)) continue;
                    uEnd = evU[e]; break;
                }
                const g1 = gamma(W[o], W[o + 1], W[o + 2]);
                stepMarkers(i, T, dt, T + uEnd * dt, KX[0][o], KX[0][o + 1], KX[0][o + 2], W[o] / g1, W[o + 1] / g1, W[o + 2] / g1);
            }
            let ended = false;
            for (let a = 0; a < nEv; a++) {
                const e = evOrd[a], u = evU[e], kind = evK[e], idx = evI[e], k = evC[e];
                chordAt(o, u);
                const te = T + u * dt;
                if (kind === EV_PLANE) { if (planes[idx].record === 'all' ? k <= 1000 : k === 1) pushCross(i, idx, 0, -1, evD[e], k, te); continue; }
                if (kind === EV_MESH) { pushCross(i, -1, 1, idx, 0, k, te); continue; }
                path[i] += u * Math.hypot(bx - ax, by - ay, bz - az);
                if (kind === EV_DETECT) { if (k === 1) { pushCross(i, idx, 0, -1, evD[e], k, te); finish(i, STATUS.DETECTED, idx, te, QQ[0], QQ[1], QQ[2], QQ[3], QQ[4], QQ[5]); ended = true; break; } continue; }
                if (kind === EV_ABSORB) { pushCross(i, -1, 1, idx, 0, k, te); finish(i, STATUS.ABSORBED, idx, te, QQ[0], QQ[1], QQ[2], QQ[3], QQ[4], QQ[5]); ended = true; break; }
                if (kind === EV_HIT) { finish(i, STATUS.HIT, idx, te, QQ[0], QQ[1], QQ[2], QQ[3], QQ[4], QQ[5]); ended = true; break; }
                finish(i, STATUS.EXIT, idx, te, QQ[0], QQ[1], QQ[2], QQ[3], QQ[4], QQ[5]); ended = true; break;
            }
            if (ended) continue;
            const dl = Math.hypot(bx - ax, by - ay, bz - az);
            path[i] += dl;
            if (!inE) { drift[i] += dl; if (drift[i] >= maxDrift) { finish(i, STATUS.DRIFT_END, EDGE.DRIFT_LIMIT, T1, bx, by, bz, W[o], W[o + 1], W[o + 2]); continue; } }
            point(i, bx, by, bz, T1, false);
            if (gasOn) {
                // spend the collision budget (trapezoid of the start and end rates); the excess carries over, so the rate is exact
                const g1 = gamma(W[o], W[o + 1], W[o + 2]);
                const nuE = gasModel.rate(gasSp[i], W[o] / g1, W[o + 1] / g1, W[o + 2] / g1);
                gasBudget[i] -= 0.5 * (gasNu[i] + nuE) * dt;
                if (gasBudget[i] <= 0) {
                    gasModel.collide(gasSp[i], gasRng[i], W, o, rel);
                    gasBudget[i] += gasModel.budget(gasRng[i]);
                    nColl++;
                    point(i, bx, by, bz, T1, true);
                }
            }
            if (T1 >= tStop(i)) finish(i, STATUS.TMAX, -1, T1, bx, by, bz, W[o], W[o + 1], W[o + 2]);
        }
        T = T1;
        for (let i = 0; i < n; i++) if (!done[i] && !active[i] && T0[i] <= T) activate(i);
    }
    for (let i = 0; i < n; i++) if (!done[i]) { const o = 3 * i; finish(i, STATUS.CANCELLED, -1, active[i] ? T : T0[i], X[o], X[o + 1], X[o + 2], W[o], W[o + 1], W[o + 2]); }

    const crossings = new Float64Array(cross.length * C_STRIDE);
    cross.sort((a, b) => a[C_ID] - b[C_ID] || a[C_T] - b[C_T]);
    cross.forEach((row, k) => crossings.set(row, k * C_STRIDE));
    let trajOut = null;
    if (recTraj) {
        const offsets = new Uint32Array(n + 1);
        let tot = 0;
        for (let i = 0; i < n; i++) { offsets[i] = tot; tot += traj[i].length / 4; }
        offsets[n] = tot;
        const pts = new Float32Array(4 * tot);
        for (let i = 0; i < n; i++) pts.set(traj[i], 4 * offsets[i]);
        trajOut = { offsets, pts };
    }
    // markers grouped by particle in batch order (each particle's in time order), as trace.js writes them
    let markers = null;
    if (markersOn) {
        let tot = 0;
        for (let i = 0; i < n; i++) tot += marks[i].length;
        markers = new Float32Array(tot);
        for (let i = 0, o = 0; i < n; i++) { markers.set(marks[i], o); o += marks[i].length; }
    }
    const res = { n, i0: typeof opts.i0 === 'number' ? opts.i0 : (n > 0 ? particles[P_ID] : 0), summary, crossings, nCross: cross.length, traj: trajOut, markers,
        stats: { steps: totalSteps, rejects: 0, evals, ms: performance.now() - t0ms, edgeSplits: 0, regionViolations: 0, crossDropped: 0, collisions: nColl, lockstep: true } };
    if (cancelled) res.cancelled = true;
    return res;
}

/** Electrostatic interaction energy (eV) of a set of point charges with softening ε (mm): Σ_{i<j} q_i q_j e²/(4π ε0 √(r² + ε²)). */
export function coulombEnergy(xs, qs, softening = DEFAULT_SOFTENING) {
    const n = qs.length, eps2 = softening * softening;
    let u = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const dx = xs[3 * i] - xs[3 * j], dy = xs[3 * i + 1] - xs[3 * j + 1], dz = xs[3 * i + 2] - xs[3 * j + 2];
        u += qs[i] * qs[j] / Math.sqrt(dx * dx + dy * dy + dz * dz + eps2);
    }
    return u * K_COUL / K_ACC;
}
