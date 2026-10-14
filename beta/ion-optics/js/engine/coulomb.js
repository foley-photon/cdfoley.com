/* ==========================================================================
   Ion optics engine: coulomb.js (stretch, P1b; non-gating)
   Particle-particle Coulomb interaction by direct summation for small
   bunches (≤ 2000 particles), integrated in lockstep with classical
   Runge-Kutta 4 at the smallest per-particle step cap.

   a_i = K_ACC(q_i/m_i)(E + v_i × B) + K_C q_i Σ_j q_j (x_i − x_j) / (m_i (|x_i − x_j|² + ε²)^{3/2}),
   K_C = e²/(4π ε0 u) in mm³/µs² (constants.js), ε = 1e-4 mm (Plummer softening;
   Aarseth, Gravitational N-Body Simulations, Cambridge (2003), §2). The pair
   time scale √((r² + ε²)^{3/2} / (K_C |q_i q_j| (1/m_i + 1/m_j))) limits the
   common step. Interactions are electrostatic (quasistatic, no retardation).
   Events are located on the straight chord of each step (linear in time):
   planes, electrode hits and meshes, domain exits. Particles born later join
   at their birth time; particles that stop leave the interaction.
   ========================================================================== */
import { K_ACC, C_MMUS, K_COUL } from './constants.js';
import { uniform01 } from './rng.js';
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
const MAX_PARTICLES = 2000;

function engineError(code, message) { const e = new Error(message); e.name = 'EngineError'; e.code = code; return e; }
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const posNum = (v, d) => (typeof v === 'number' && v > 0 && Number.isFinite(v) ? v : d);

/**
 * Lockstep RK4 with direct Coulomb summation.
 * @param {object} model FieldModel
 * @param {Float64Array} particles P_STRIDE rows (≤ 2000)
 * @param {{ relativistic?: boolean, tMax?: number, maxSteps?: number, maxStepCells?: number, nearStepCells?: number,
 *   maxDrift?: number, planes?: object[], beyond?: object, seed?: number, softening?: number, pairStep?: number,
 *   record?: { trajectories?: boolean, maxPoints?: number, minSegCells?: number }, i0?: number }} [opts]
 *   softening: ε in mm (default 1e-4); pairStep: the common step is at most pairStep × the smallest pair time scale (default 0.01).
 * @param {{ shouldStop?: () => boolean }} [hooks]
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
    const eps2 = Math.pow(posNum(opts.softening, 1e-4), 2);
    const pairStep = posNum(opts.pairStep, 0.01);
    const seed = num(opts.seed, 1);
    const beyond = opts.beyond || {};
    const planes = Array.isArray(opts.planes) ? opts.planes : [];
    const nP = planes.length;
    const rec = opts.record || {};
    const recTraj = rec.trajectories !== false;
    const maxPts = Math.max(2, Math.floor(posNum(rec.maxPoints, 2000)));
    const minSeg = Math.max(0, num(rec.minSegCells, 0.5)) * h;
    const stop = hooks && typeof hooks.shouldStop === 'function' ? hooks.shouldStop : null;
    const hasB = !!model.hasB, hitsOn = !!model.hasGeometry;
    const transp = model.transparent || new Uint8Array(0), transm = model.transmission || new Float64Array(0);

    // state
    const X = new Float64Array(3 * n), W = new Float64Array(3 * n), M = new Float64Array(n), Qc = new Float64Array(n), T0 = new Float64Array(n);
    const X0 = new Float64Array(3 * n), W0 = new Float64Array(3 * n), XT = new Float64Array(3 * n), WT = new Float64Array(3 * n);
    const KX = [0, 1, 2, 3].map(() => new Float64Array(3 * n)), KW = [0, 1, 2, 3].map(() => new Float64Array(3 * n));
    const active = new Uint8Array(n), done = new Uint8Array(n);
    const steps = new Float64Array(n), path = new Float64Array(n), drift = new Float64Array(n), ncross = new Float64Array(n), meshCount = new Int32Array(n);
    const pCount = new Int32Array(n * Math.max(1, nP));
    const summary = new Float64Array(n * S_STRIDE);
    const cross = [];
    const traj = recTraj ? Array.from({ length: n }, () => []) : null;
    let pairMin = Infinity, evals = 0, totalSteps = 0;
    for (let i = 0; i < n; i++) {
        const b = i * P_STRIDE;
        M[i] = particles[b + P_MASS]; Qc[i] = particles[b + P_CHARGE]; T0[i] = particles[b + P_T0];
        for (let c = 0; c < 3; c++) { X[3 * i + c] = particles[b + P_X + c]; W[3 * i + c] = particles[b + P_WX + c]; }
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
        if (!force && k >= 4) { const dx = x - a[k - 4], dy = y - a[k - 3], dz = z - a[k - 2]; if (dx * dx + dy * dy + dz * dz < minSeg * minSeg) return; }
        if (k >= 4 * maxPts) { for (let j = 1, o = 4; j < maxPts; j += 2, o += 4) { a[o] = a[4 * j]; a[o + 1] = a[4 * j + 1]; a[o + 2] = a[4 * j + 2]; a[o + 3] = a[4 * j + 3]; } a.length = 4 * Math.ceil(maxPts / 2); }
        a.push(x, y, z, t);
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
        active[i] = 0; done[i] = 1;
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
            case 'segment': { const r = model.cyl ? Math.sqrt(y * y + z * z) : y, dx = p.p1[0] - p.p0[0], dy = p.p1[1] - p.p0[1], L = Math.hypot(dx, dy) || 1; return ((x - p.p0[0]) * dy - (r - p.p0[1]) * dx) / L; }
            default: return x - p.at;
        }
    }
    function planeOk(p, x, y, z, dir) {
        if ((p.side === 'forward' && dir < 0) || (p.side === 'backward' && dir > 0)) return false;
        if (p.kind === 'segment') {
            const r = model.cyl ? Math.sqrt(y * y + z * z) : y, dx = p.p1[0] - p.p0[0], dy = p.p1[1] - p.p0[1], L2 = dx * dx + dy * dy;
            const s = ((x - p.p0[0]) * dx + (r - p.p0[1]) * dy) / L2;
            if (s < -1e-9 || s > 1 + 1e-9) return false;
        }
        if (p.radius > 0) {
            const r2 = p.kind === 'x' ? y * y + z * z : p.kind === 'y' ? x * x + z * z : p.kind === 'z' ? x * x + y * y : 0;
            if (r2 > p.radius * p.radius) return false;
        }
        return true;
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
            const k = K_ACC * Qc[i] / M[i];
            kw[o] = k * fx; kw[o + 1] = k * fy; kw[o + 2] = k * fz;
        }
        for (let i = 0; i < n; i++) {
            if (!active[i] || Qc[i] === 0) continue;
            const oi = 3 * i;
            for (let j = i + 1; j < n; j++) {
                if (!active[j] || Qc[j] === 0) continue;
                const oj = 3 * j;
                const dx = xs[oi] - xs[oj], dy = xs[oi + 1] - xs[oj + 1], dz = xs[oi + 2] - xs[oj + 2];
                const d2 = dx * dx + dy * dy + dz * dz + eps2, d = Math.sqrt(d2), inv3 = 1 / (d2 * d);
                const qq = K_COUL * Qc[i] * Qc[j];
                const fi = qq * inv3 / M[i], fj = qq * inv3 / M[j];
                kw[oi] += fi * dx; kw[oi + 1] += fi * dy; kw[oi + 2] += fi * dz;
                kw[oj] -= fj * dx; kw[oj + 1] -= fj * dy; kw[oj + 2] -= fj * dz;
                const tau2 = d2 * d / (Math.abs(qq) * (1 / M[i] + 1 / M[j]));
                if (tau2 < pairMin) pairMin = tau2;
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

    let nSteps = 0, cancelled = false;
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
        // first stage gives the accelerations and the pair time scale for the step cap
        pairMin = Infinity;
        accel(T, X, W, KX[0], KW[0]);
        let dt = Infinity;
        for (let i = 0; i < n; i++) {
            if (!active[i]) continue;
            const o = 3 * i;
            const v = Math.hypot(KX[0][o], KX[0][o + 1], KX[0][o + 2]), a = Math.hypot(KW[0][o], KW[0][o + 1], KW[0][o + 2]);
            const s = hitsOn && model.near(X[o], X[o + 1], X[o + 2]) ? sNear : sCell;
            const den = Math.max(v, Math.sqrt(2 * s * a));
            if (den > 0 && s / den < dt) dt = s / den;
        }
        if (pairMin < Infinity) dt = Math.min(dt, pairStep * Math.sqrt(pairMin));
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
                if (!planeOk(p, QQ[0], QQ[1], QQ[2], dir)) continue;
                const c = ++pCount[i * nP + pi];
                addEv(u, p.terminate ? EV_DETECT : EV_PLANE, pi, dir, c);
            }
            // process in chord order (insertion sort on the few events)
            for (let a = 1; a < nEv; a++) { const v = evOrd[a]; let b = a - 1; while (b >= 0 && evU[evOrd[b]] > evU[v]) { evOrd[b + 1] = evOrd[b]; b--; } evOrd[b + 1] = v; }
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
    const res = { n, i0: typeof opts.i0 === 'number' ? opts.i0 : (n > 0 ? particles[P_ID] : 0), summary, crossings, nCross: cross.length, traj: trajOut, markers: null,
        stats: { steps: totalSteps, rejects: 0, evals, ms: performance.now() - t0ms, edgeSplits: 0, regionViolations: 0 } };
    if (cancelled) res.cancelled = true;
    return res;
}

/** Electrostatic interaction energy (eV) of a set of point charges with softening ε (mm): Σ_{i<j} q_i q_j e²/(4π ε0 √(r² + ε²)). */
export function coulombEnergy(xs, qs, softening = 1e-4) {
    const n = qs.length, eps2 = softening * softening;
    let u = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const dx = xs[3 * i] - xs[3 * j], dy = xs[3 * i + 1] - xs[3 * j + 1], dz = xs[3 * i + 2] - xs[3 * j + 2];
        u += qs[i] * qs[j] / Math.sqrt(dx * dx + dy * dy + dz * dz + eps2);
    }
    return u * K_COUL / K_ACC;
}
