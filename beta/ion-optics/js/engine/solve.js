/* ==========================================================================
   Ion optics engine: solve.js
   Laplace solves on a level hierarchy: geometric multigrid V(2,2) with
   red-black Gauss-Seidel smoothing, full weighting and bilinear
   interpolation on off-lattice levels; multigrid-preconditioned BiCGSTAB;
   Carre's adaptive red-black SOR. `auto` runs multigrid and falls back
   automatically. Stop rule: estimated algebraic error <= tol and scaled
   residual <= 10 tol.

   Sources: Briggs, Henson & McCormick, A Multigrid Tutorial, 2nd ed. (SIAM,
   2000); Trottenberg, Oosterlee & Schueller, Multigrid (Academic Press,
   2001); van der Vorst, SIAM J. Sci. Stat. Comput. 13, 631 (1992)
   (BiCGSTAB); Carre, Comput. J. 4, 73 (1961) and Hageman & Young, Applied
   Iterative Methods (Academic Press, 1981), ch. 9 (adaptive SOR).
   ========================================================================== */
import { gsColor, gsColorF, sorColor, residualInto, applyA, basisSetup, voltageSetup, newRhs } from './operator.js';

const DEFAULTS = { method: 'auto', tol: 1e-10, maxCycles: 60, maxIterations: 200, maxSweeps: 100000, initial: null, timeLimitMs: Infinity };

function engineError(code, message, detail) {
    const e = new Error(message);
    e.name = 'EngineError'; e.code = code;
    if (detail !== undefined) e.detail = detail;
    return e;
}

/**
 * Optimal SOR factor of the bounding box with its edge conditions (spec 3.4.4).
 * @param {object} grid
 */
export function omegaBox(grid) {
    const e = grid.edges || {};
    const kind = (k) => { const bc = e[k] && e[k].bc; return bc === 'neumann' ? 'N' : bc === 'axis' ? 'A' : 'D'; };
    const kappa = (a, b, L) => {
        if (a === 'D' && b === 'D') return Math.PI / L;
        if (a === 'N' && b === 'N') return 0;
        return Math.PI / (2 * L);
    };
    const Lx = Math.max(1, grid.nx - 1), Ly = Math.max(1, grid.ny - 1);
    const kx = kappa(kind('xmin'), kind('xmax'), Lx);
    let ky;
    if (grid.type === 'cyl2d') ky = kind('ymax') === 'N' ? 0 : 2.4048 / Ly;
    else ky = kappa(kind('ymin'), kind('ymax'), Ly);
    const rho = 0.5 * (Math.cos(kx) + Math.cos(ky));
    const w = 2 / (1 + Math.sqrt(Math.max(0, 1 - rho * rho)));
    return Math.min(w, 1.99);
}

// per-operator work arrays
function work(op) {
    if (!op._w) op._w = { e: new Float64Array(op.N), f: new Float64Array(op.N), r: new Float64Array(op.N) };
    return op._w;
}

// ---------------------------------------------------------------- transfer operators
function restrictFW(opf, rf, opc, fc) {
    const gf = opf.grid, nxf = opf.nx, nyf = opf.ny, nxc = opc.nx, nyc = opc.ny, maskc = opc.mask;
    const E = gf.edges;
    const reflX0 = E.xmin.bc === 'neumann', reflY0 = E.ymin.bc === 'neumann' || E.ymin.bc === 'axis';
    const xFarOn = Math.abs(gf.x0 + (nxf - 1) * gf.h - gf.xEnd) <= 1e-7 * gf.h, yFarOn = Math.abs(gf.y0 + (nyf - 1) * gf.h - gf.yEnd) <= 1e-7 * gf.h;
    const reflX1 = xFarOn && E.xmax.bc === 'neumann', reflY1 = yFarOn && E.ymax.bc === 'neumann';
    const R = (i, j) => {
        if (i < 0) { if (!reflX0) return 0; i = -i; } else if (i > nxf - 1) { if (!reflX1) return 0; i = 2 * (nxf - 1) - i; }
        if (j < 0) { if (!reflY0) return 0; j = -j; } else if (j > nyf - 1) { if (!reflY1) return 0; j = 2 * (nyf - 1) - j; }
        if (i < 0 || i > nxf - 1 || j < 0 || j > nyf - 1) return 0;
        return rf[j * nxf + i];
    };
    for (let J = 0; J < nyc; J++) {
        const j = 2 * J;
        const interiorJ = j >= 1 && j + 1 <= nyf - 1;
        for (let I = 0; I < nxc; I++) {
            const kc = J * nxc + I;
            if (maskc[kc] === 1) { fc[kc] = 0; continue; }
            const i = 2 * I;
            let s;
            if (interiorJ && i >= 1 && i + 1 <= nxf - 1) {
                const k = j * nxf + i;
                s = 4 * rf[k] + 2 * (rf[k - 1] + rf[k + 1] + rf[k - nxf] + rf[k + nxf]) + rf[k - nxf - 1] + rf[k - nxf + 1] + rf[k + nxf - 1] + rf[k + nxf + 1];
            } else {
                s = 4 * R(i, j) + 2 * (R(i - 1, j) + R(i + 1, j) + R(i, j - 1) + R(i, j + 1)) + R(i - 1, j - 1) + R(i + 1, j - 1) + R(i - 1, j + 1) + R(i + 1, j + 1);
            }
            fc[kc] = 0.25 * s;   // (1,2,1)x(1,2,1)/16 times 4 for the h^2 scaling
        }
    }
}
function prolongAdd(opc, ec, opf, uf) {
    const nxf = opf.nx, nyf = opf.ny, nxc = opc.nx, maskf = opf.mask;
    for (let j = 0; j < nyf; j++) {
        const J = j >> 1, aj = j & 1, r0 = J * nxc, r1 = r0 + nxc, base = j * nxf;
        if (!aj) {
            for (let i = 0; i < nxf; i++) {
                const k = base + i;
                if (maskf[k] === 1) continue;
                const I = i >> 1;
                uf[k] += (i & 1) ? 0.5 * (ec[r0 + I] + ec[r0 + I + 1]) : ec[r0 + I];
            }
        } else {
            for (let i = 0; i < nxf; i++) {
                const k = base + i;
                if (maskf[k] === 1) continue;
                const I = i >> 1;
                uf[k] += (i & 1) ? 0.25 * (ec[r0 + I] + ec[r0 + I + 1] + ec[r1 + I] + ec[r1 + I + 1]) : 0.5 * (ec[r0 + I] + ec[r1 + I]);
            }
        }
    }
}

const ACC = new Float64Array(2);
function coarsestSolve(op, u, b, f) {
    if (op._wbox === undefined) op._wbox = omegaBox(op.grid);
    const w = op._wbox;
    let first = -1;
    for (let s = 0; s < 500; s++) {
        ACC[0] = 0; ACC[1] = 0;
        sorColor(op, u, b, f, 0, w, ACC);
        sorColor(op, u, b, f, 1, w, ACC);
        const d = ACC[0];
        if (s === 0) first = d;
        if (!(d > 1e-3 * first)) break;
    }
}
function smooth(op, u, b, f, col) { if (f === null) gsColor(op, u, b, col); else gsColorF(op, u, b, f, col); }
function vcycle(H, l, u, b, f) {
    const op = H[l];
    if (l === H.length - 1) { coarsestSolve(op, u, b, f); return; }
    smooth(op, u, b, f, 0); smooth(op, u, b, f, 1);
    smooth(op, u, b, f, 0); smooth(op, u, b, f, 1);
    const W = work(op);
    residualInto(op, u, b, f, W.r);
    const opc = H[l + 1], Wc = work(opc);
    restrictFW(op, W.r, opc, Wc.f);
    Wc.e.fill(0);
    vcycle(H, l + 1, Wc.e, null, Wc.f);
    prolongAdd(opc, Wc.e, op, u);
    smooth(op, u, b, f, 1); smooth(op, u, b, f, 0);
    smooth(op, u, b, f, 1); smooth(op, u, b, f, 0);
}

// ---------------------------------------------------------------- shared stop rule
function rateOf(hist, k) {   // k = 1-based index of the latest entry
    if (k >= 4) return Math.pow(hist[k - 1] / hist[k - 4], 1 / 3);
    if (k >= 2) return hist[k - 1] / hist[k - 2];
    return NaN;
}
function estimateErr(delta, rho, floor) {
    if (delta <= floor) return delta;
    if (!(rho < 1)) return Infinity;
    return delta * rho / (1 - rho);
}
function maxAbsDiff(a, b) {
    let m = 0;
    for (let k = 0; k < a.length; k++) { const d = a[k] - b[k]; const ad = d < 0 ? -d : d; if (ad > m || ad !== ad) m = ad !== ad ? NaN : ad; if (m !== m) return NaN; }
    return m;
}
function scaledMax(op, r) {
    const nx = op.nx, ny = op.ny, mask = op.mask, rI = op.rowInvD;
    let mx = 0;
    for (let j = 0; j < ny; j++) {
        const inv = rI[j];
        for (let i = 0, k = j * nx; i < nx; i++, k++) { if (mask[k] !== 0) continue; const a = (r[k] < 0 ? -r[k] : r[k]) * inv; if (a > mx) mx = a; }
    }
    const irr = op.irr;
    for (let m = 0; m < irr.count; m++) { const v = r[irr.node[m]]; const a = (v < 0 ? -v : v) / irr.diag[m]; if (a > mx) mx = a; }
    return mx;
}

function makeReporter(hooks, startMs) {
    const every = hooks && hooks.progressEveryMs !== undefined ? hooks.progressEveryMs : 100;
    let last = -Infinity, e0 = NaN;
    return {
        tick(info, tol) {
            if (hooks && typeof hooks.shouldStop === 'function' && hooks.shouldStop()) throw engineError('E_CANCELLED', 'Solve cancelled.');
            if (!hooks || typeof hooks.onProgress !== 'function') return;
            const now = performance.now();
            if (now - last < every) return;
            last = now;
            if (!(e0 > 0) && Number.isFinite(info.estErr)) e0 = info.estErr;
            let frac = 0;
            if (e0 > 0 && Number.isFinite(info.estErr) && e0 > tol) frac = Math.min(1, Math.max(0, Math.log(e0 / Math.max(info.estErr, 1e-300)) / Math.log(e0 / tol)));
            hooks.onProgress({ phase: 'solve', frac, ms: now - startMs, ...info });
        },
    };
}
function normOpts(opts) {
    const o = { ...DEFAULTS, ...(opts || {}) };
    o.tol = Math.max(1e-12, Number.isFinite(o.tol) && o.tol > 0 ? o.tol : 1e-10);
    if (!(o.scale > 0)) o.scale = 1;
    o.tolAbs = o.tol * o.scale;
    return o;
}

// ---------------------------------------------------------------- multigrid
/**
 * Multigrid V(2,2) cycles on the hierarchy; u holds the solution (fixed values set), b the level-0 cut RHS.
 * With opts.allowSwitch the stage gives up early per spec 3.4.5 (switchReason set).
 * @param {object[]} H Operator hierarchy (index 0 = fine level)
 * @param {Float64Array} u solution, fixed values set (updated in place)
 * @param {Float64Array} b level-0 cut right-hand side
 * @param {{tol?: number, scale?: number, maxCycles?: number, maxIterations?: number, maxSweeps?: number, timeLimitMs?: number}} [opts]
 * @param {{onProgress?: Function, progressEveryMs?: number, shouldStop?: Function}} [hooks]
 * @returns {object} stage statistics (SolveStats fields plus switchReason)
 */
export function multigridSolve(H, u, b, opts = {}, hooks = {}) {
    const o = normOpts(opts), op = H[0], tol = o.tolAbs, t0 = performance.now();
    const rep = makeReporter(hooks, t0);
    const W = work(op);
    if (!W.prev) W.prev = new Float64Array(op.N);
    const prev = W.prev, hist = [];
    let minDelta = Infinity, est = Infinity, res = Infinity, rho = NaN, converged = false, switchReason = null, cycle = 0;
    const floor = Math.max(1e-3 * tol, 1.5e-14 * o.scale);
    for (cycle = 1; cycle <= o.maxCycles; cycle++) {
        prev.set(u);
        vcycle(H, 0, u, b, null);
        const delta = maxAbsDiff(u, prev);
        if (!(delta === delta) || !Number.isFinite(delta)) { switchReason = 'nan'; break; }
        hist.push(delta);
        rho = rateOf(hist, cycle);
        est = estimateErr(delta, rho, floor);
        if (est <= tol) { res = residualInto(op, u, b, null, null); if (res <= 10 * tol) { converged = true; break; } }
        if (o.allowSwitch) {
            if (cycle >= 4 && rho > 0.5) { switchReason = 'slow'; break; }
            if (cycle >= 2 && rho >= 1 && delta > floor) { switchReason = 'stalled'; break; }
            if (delta > 10 * minDelta) { switchReason = 'growing'; break; }
        }
        if (delta < minDelta) minDelta = delta;
        if (performance.now() - t0 > o.timeLimitMs) { switchReason = 'time'; break; }
        rep.tick({ cycle, iteration: 0, sweep: 0, estErr: est, scaledResidual: res, omega: 1 }, tol);
    }
    if (!converged && !switchReason) switchReason = 'maxCycles';
    if (!Number.isFinite(res)) res = residualInto(op, u, b, null, null);
    return { method: 'multigrid', path: ['multigrid'], levels: H.length, cycles: Math.min(cycle, o.maxCycles), iterations: 0, sweeps: 0, omega: 1, rho, estErr: est, scaledResidual: res,
        converged, switchReason, ms: performance.now() - t0, history: hist };
}

// ---------------------------------------------------------------- BiCGSTAB
/**
 * MG-preconditioned BiCGSTAB (van der Vorst 1992), right preconditioning by one V(2,2) cycle from zero.
 * @param {object[]} H Operator hierarchy (index 0 = fine level)
 * @param {Float64Array} u solution, fixed values set (updated in place)
 * @param {Float64Array} b level-0 cut right-hand side
 * @param {{tol?: number, scale?: number, maxCycles?: number, maxIterations?: number, maxSweeps?: number, timeLimitMs?: number}} [opts]
 * @param {{onProgress?: Function, progressEveryMs?: number, shouldStop?: Function}} [hooks]
 * @returns {object} stage statistics (SolveStats fields plus switchReason)
 */
export function bicgstabMG(H, u, b, opts = {}, hooks = {}) {
    const o = normOpts(opts), op = H[0], N = op.N, tol = o.tolAbs, t0 = performance.now();
    const rep = makeReporter(hooks, t0);
    const r = new Float64Array(N), rh = new Float64Array(N), p = new Float64Array(N), v = new Float64Array(N), t = new Float64Array(N), ph = new Float64Array(N), sh = new Float64Array(N);
    const precond = (src, dst) => { dst.fill(0); vcycle(H, 0, dst, null, src); };
    const dot = (a, c) => { let s = 0; for (let k = 0; k < N; k++) s += a[k] * c[k]; return s; };
    residualInto(op, u, b, null, r);
    rh.set(r);
    let rho = 1, alpha = 1, omega = 1, it = 0, breakdowns = 0, est = Infinity, res = scaledMax(op, r), bestRes = res, sinceBest = 0, converged = false, switchReason = null, rate = NaN;
    const hist = [];
    const floor = Math.max(1e-3 * tol, 1.5e-14 * o.scale);
    if (res === 0) converged = true;
    for (it = 1; !converged && it <= o.maxIterations; it++) {
        const rhoN = dot(rh, r);
        const nr = Math.sqrt(dot(r, r)), nrh = Math.sqrt(dot(rh, rh));
        if (nr === 0) { converged = true; break; }
        if (!(Math.abs(rhoN) > 1e-300 * Math.max(1e-300, nr * nrh))) {
            if (++breakdowns > 3) { switchReason = 'breakdown'; break; }
            rh.set(r); rho = 1; alpha = 1; omega = 1; p.fill(0); v.fill(0); it--; continue;
        }
        const beta = (rhoN / rho) * (alpha / omega);
        for (let k = 0; k < N; k++) p[k] = r[k] + beta * (p[k] - omega * v[k]);
        precond(p, ph);
        applyA(op, ph, v);
        const rv = dot(rh, v);
        if (!(Math.abs(rv) > 1e-300 * Math.max(1e-300, nrh * Math.sqrt(dot(v, v))))) {
            if (++breakdowns > 3) { switchReason = 'breakdown'; break; }
            rh.set(r); rho = 1; alpha = 1; omega = 1; p.fill(0); v.fill(0); it--; continue;
        }
        alpha = rhoN / rv;
        for (let k = 0; k < N; k++) r[k] -= alpha * v[k];          // r now holds s
        precond(r, sh);
        applyA(op, sh, t);
        const tt = dot(t, t);
        if (!(tt > 1e-300)) {
            // s is (numerically) zero: accept the half step
            let dmax = 0;
            for (let k = 0; k < N; k++) { const d = alpha * ph[k]; u[k] += d; const a = d < 0 ? -d : d; if (a > dmax) dmax = a; }
            hist.push(dmax);
            res = residualInto(op, u, b, null, null);
            if (res <= 10 * tol) { converged = true; est = dmax; break; }
            if (++breakdowns > 3) { switchReason = 'breakdown'; break; }
            residualInto(op, u, b, null, r); rh.set(r); rho = 1; alpha = 1; omega = 1; p.fill(0); v.fill(0);
            continue;
        }
        omega = dot(t, r) / tt;
        let dmax = 0;
        for (let k = 0; k < N; k++) {
            const d = alpha * ph[k] + omega * sh[k];
            u[k] += d;
            const a = d < 0 ? -d : d;
            if (a > dmax) dmax = a;
            r[k] -= omega * t[k];
        }
        rho = rhoN;
        if (!(dmax === dmax)) { switchReason = 'nan'; break; }
        hist.push(dmax);
        rate = rateOf(hist, hist.length);
        est = estimateErr(dmax, rate, floor);
        res = scaledMax(op, r);
        if (est <= tol && res <= 10 * tol) {
            const trueRes = residualInto(op, u, b, null, null);
            if (trueRes <= 10 * tol) { res = trueRes; converged = true; break; }
            residualInto(op, u, b, null, r);   // recursive residual drifted: restart from the true one
        }
        if (res < bestRes) { bestRes = res; sinceBest = 0; } else if (++sinceBest >= 20) { switchReason = 'stagnation'; break; }
        if (performance.now() - t0 > o.timeLimitMs) { switchReason = 'time'; break; }
        rep.tick({ cycle: 0, iteration: it, sweep: 0, estErr: est, scaledResidual: res, omega: 1 }, tol);
    }
    if (!converged && !switchReason) switchReason = 'maxIterations';
    return { method: 'krylov', path: ['krylov'], levels: H.length, cycles: 0, iterations: Math.min(it, o.maxIterations), sweeps: 0, omega: 1, rho: rate, estErr: est,
        scaledResidual: converged ? res : residualInto(op, u, b, null, null), converged, switchReason, ms: performance.now() - t0, history: hist };
}

// ---------------------------------------------------------------- Carre adaptive SOR
/**
 * Carre / Hageman-Young adaptive red-black SOR on one operator (spec 3.4.4).
 * opts.adapt = false keeps opts.omega fixed (same stop rule; used to compare against fixed factors).
 * @param {object} op level-0 Operator
 * @param {Float64Array} u solution, fixed values set (updated in place)
 * @param {Float64Array} b cut right-hand side
 * @param {{tol?: number, scale?: number, maxSweeps?: number, timeLimitMs?: number, adapt?: boolean, omega?: number}} [opts]
 * @param {{onProgress?: Function, progressEveryMs?: number, shouldStop?: Function}} [hooks]
 * @returns {object} stage statistics (SolveStats fields plus switchReason, updates)
 */
export function carreSOR(op, u, b, opts = {}, hooks = {}) {
    const o = normOpts(opts), tol = o.tolAbs, t0 = performance.now();
    const rep = makeReporter(hooks, t0);
    const wBox = omegaBox(op.grid);
    const adapt = o.adapt !== false;
    const wCap = adapt ? Math.min(1.995, wBox + 0.25 * (2 - wBox)) : 0;
    let w = adapt ? 1 + 0.5 * (wBox - 1) : Math.min(1.999, Math.max(0.1, +o.omega || wBox));
    if (!adapt) o.maxSweeps = Math.max(1, o.maxSweeps);
    const win = new Float64Array(64);
    let nWin = 0;   // ratios since the last update, ring buffer of the last 64
    const push = (q) => { win[nWin % 64] = q; nWin++; };
    const last = (m, i) => win[(nWin - m + i) % 64];
    let prevNorm = NaN, sweeps = 0, sinceUpdate = 0, updates = 0, guarded = false, lambda = NaN, est = Infinity, res = Infinity, converged = false, bestEst = Infinity, lastGain = 0, stagnated = false, timedOut = false;
    const acc = new Float64Array(2), dmh = new Float64Array(32);
    const roundoff0 = 1.5e-14 * o.scale;
    while (sweeps < o.maxSweeps) {
        acc[0] = 0; acc[1] = 0;
        sorColor(op, u, b, null, 0, w, acc);
        sorColor(op, u, b, null, 1, w, acc);
        sweeps++; sinceUpdate++;
        const dmax = acc[0], d2 = Math.sqrt(acc[1]);
        if (!(dmax === dmax)) throw engineError('E_NAN', 'The SOR iteration produced NaN.');
        dmh[(sweeps - 1) & 31] = dmax;
        if (prevNorm > 0) push(d2 / prevNorm);
        prevNorm = d2;
        // stabilised ratio over the last 8
        let stable = false;
        lambda = NaN;
        if (nWin >= 8) {
            let mn = Infinity, mx = -Infinity, lp = 0;
            for (let i = 0; i < 8; i++) { const q = last(8, i); if (q < mn) mn = q; if (q > mx) mx = q; lp += Math.log(q); }
            if (mx < 1 && mx - mn < 0.003 * mx) { stable = true; lambda = Math.exp(lp / 8); }
        }
        if (stable && sinceUpdate >= 10 && lambda > Math.pow(w - 1, 0.75) && w < wCap) {
            const mu2 = Math.min(1 - 1e-12, (lambda + w - 1) * (lambda + w - 1) / (lambda * w * w));
            const wn = Math.min(wCap, 2 / (1 + Math.sqrt(1 - mu2)));
            if (wn > w) { w = wn; updates++; sinceUpdate = 0; nWin = 0; continue; }
        }
        // Stop estimate. Safeguards beyond spec 3.4.4: the SOR spectral radius is never below |omega - 1|
        // (Kahan 1958), and without stabilised ratios the amplitude is the largest change of the last 32
        // sweeps, because above the optimal factor the changes beat and a trough understates the error.
        let amp32 = 0;
        for (let i = 0, nh = sweeps < 32 ? sweeps : 32; i < nh; i++) { const d = dmh[(sweeps - 1 - i) & 31]; if (d > amp32) amp32 = d; }
        let lam = lambda, amp = dmax, g = NaN;
        if (!stable) {
            lam = NaN; amp = amp32;
            if (nWin >= 32) {
                let lp = 0;
                for (let i = 0; i < 32; i++) lp += Math.log(last(32, i));
                g = Math.exp(lp / 32);
                if (g < 1) lam = g;
            }
        }
        if (lam < w - 1) lam = w - 1;
        est = lam < 1 ? amp * lam / (1 - lam) : Infinity;
        if (sweeps >= 32 && amp32 <= roundoff0 && amp32 < est) est = amp32;   // changes at round-off for 32 sweeps
        if (est <= tol) { res = residualInto(op, u, b, null, null); if (res <= 10 * tol) { converged = true; break; } }
        // stagnation: the honest estimate has not halved for max(1000, sweeps/4) sweeps (round-off plateau,
        // typically when omega is close to 2 and tol is near 1e-12); stop instead of running to maxSweeps
        if (est < 0.5 * bestEst) { bestEst = est; lastGain = sweeps; } else if (sweeps - lastGain > Math.max(1000, sweeps >> 2)) { stagnated = true; break; }
        if (adapt && !guarded && updates === 0 && sweeps >= o.maxSweeps / 4) { guarded = true; w = wBox; nWin = 0; sinceUpdate = 0; }
        if (performance.now() - t0 > o.timeLimitMs) { timedOut = true; break; }
        rep.tick({ cycle: 0, iteration: 0, sweep: sweeps, estErr: est, scaledResidual: res, omega: w }, tol);
    }
    if (!Number.isFinite(res) || !converged) res = residualInto(op, u, b, null, null);
    if (!converged && bestEst < est) est = bestEst;
    return { method: 'sor', path: ['sor'], levels: 1, cycles: 0, iterations: 0, sweeps, omega: w, rho: lambda, estErr: est, scaledResidual: res, converged,
        switchReason: converged ? null : (timedOut ? 'time' : stagnated ? 'stagnation' : 'maxSweeps'), ms: performance.now() - t0, updates };
}

// ---------------------------------------------------------------- chain
function sanitize(op, u, scale) {
    // a diverged iterate is reset to zero at free nodes before the next stage
    const mask = op.mask;
    let bad = false;
    for (let k = 0; k < op.N; k++) { if (mask[k] === 1) continue; const v = u[k]; if (!(v === v) || Math.abs(v) > 1e3 * scale) { bad = true; break; } }
    if (bad) for (let k = 0; k < op.N; k++) if (mask[k] !== 1) u[k] = 0;
    return bad;
}
function runChain(H, u, b, opts, hooks) {
    const o = normOpts(opts), t0 = performance.now(), op = H[0];
    const method = o.method || 'auto';
    const path = [], warnings = [];
    const deadline = t0 + o.timeLimitMs;
    const left = () => ({ ...o, timeLimitMs: Math.max(0, deadline - performance.now()) });   // one time limit for the whole chain
    let st = null, cycles = 0, iterations = 0, sweeps = 0;
    const merge = (s) => { cycles += s.cycles || 0; iterations += s.iterations || 0; sweeps += s.sweeps || 0; path.push(s.method); st = s; };
    if (method === 'sor' || (method === 'auto' && H.length < 3)) merge(carreSOR(op, u, b, left(), hooks));
    else if (method === 'multigrid') merge(multigridSolve(H, u, b, { ...left(), allowSwitch: false }, hooks));
    else if (method === 'krylov') merge(bicgstabMG(H, u, b, left(), hooks));
    else {
        merge(multigridSolve(H, u, b, { ...left(), allowSwitch: true }, hooks));
        if (!st.converged && st.switchReason !== 'time') {
            if (sanitize(op, u, o.scale)) warnings.push({ code: 'W_SOLVER_RESET', message: 'Multigrid diverged; the next stage restarted from zero.' });
            merge(bicgstabMG(H, u, b, left(), hooks));
            if (!st.converged && st.switchReason !== 'time') {
                if (sanitize(op, u, o.scale)) warnings.push({ code: 'W_SOLVER_RESET', message: 'BiCGSTAB diverged; SOR restarted from zero.' });
                merge(carreSOR(op, u, b, left(), hooks));
            }
        }
    }
    if (st.switchReason === 'time') warnings.push({ code: 'W_TIME_LIMIT', message: 'The solve stopped at its time limit.' });
    if (!st.converged) warnings.push({ code: 'W_NOT_CONVERGED', message: `The field solve did not converge (${path.join(' → ')}).` });
    const r = op.raster.stats;
    return { method: st.method, path, levels: H.length, cycles, iterations, sweeps, omega: st.omega, rho: st.rho, estErr: st.estErr, scaledResidual: st.scaledResidual,
        converged: st.converged, ms: performance.now() - t0, nodes: op.N, free: r.free, irregular: r.irregular, warnings };
}

/**
 * Basis field of electrode k (1 V on k, 0 on every other electrode and edge).
 * @param {object[]} H Operator hierarchy
 * @param {number} k electrode index (>= 1)
 * @param {{method?: 'auto'|'multigrid'|'krylov'|'sor', tol?: number, maxCycles?: number, maxIterations?: number, maxSweeps?: number, initial?: Float64Array|null, timeLimitMs?: number}} [opts]
 * @param {{onProgress?: Function, progressEveryMs?: number, shouldStop?: Function}} [hooks]
 * @returns {{phi: Float64Array, stats: object}} SolveStats
 */
export function solveBasis(H, k, opts = {}, hooks = {}) {
    const op = H[0], u = new Float64Array(op.N), b = newRhs(op);
    basisSetup(op, k, u, b);
    if (opts.initial) { const mask = op.mask, ini = opts.initial; for (let q = 0; q < op.N; q++) if (mask[q] !== 1) u[q] = ini[q]; }
    const stats = runChain(H, u, b, { ...opts, scale: 1 }, hooks);
    return { phi: u, stats };
}

/**
 * Direct solve with electrode voltages volts[e] (tests, single-shot use); tol is per volt of max |V|.
 * @param {object[]} H Operator hierarchy
 * @param {ArrayLike<number>} volts by electrode index (gnd = 0)
 * @param {object} [opts] as solveBasis
 * @param {object} [hooks] as solveBasis
 * @returns {{phi: Float64Array, stats: object}}
 */
export function solveVoltages(H, volts, opts = {}, hooks = {}) {
    const op = H[0], u = new Float64Array(op.N), b = newRhs(op);
    voltageSetup(op, volts, u, b);
    let scale = 0;
    for (let e = 0; e < volts.length; e++) scale = Math.max(scale, Math.abs(+volts[e] || 0));
    if (opts.initial) { const mask = op.mask, ini = opts.initial; for (let q = 0; q < op.N; q++) if (mask[q] !== 1) u[q] = ini[q]; }
    if (scale === 0) {
        const r = op.raster.stats;
        return { phi: u, stats: { method: 'none', path: [], levels: H.length, cycles: 0, iterations: 0, sweeps: 0, omega: 1, rho: 0, estErr: 0, scaledResidual: 0, converged: true, ms: 0, nodes: op.N, free: r.free, irregular: r.irregular, warnings: [] } };
    }
    const stats = runChain(H, u, b, { ...opts, scale }, hooks);
    return { phi: u, stats };
}

/**
 * Solve-cost estimate before a job (spec 6): multigrid ~ 20 cycles x 12 sweeps, SOR ~ 1.3 max(nx, ny) sweeps,
 * 4.5 ns per node and sweep. The constants are calibrated at integration through opts (cycles, nsPerNode,
 * sorSweepsPerSide); measured on Node 24 the multigrid default is about 3x pessimistic, the SOR one about 1.4x.
 * @param {{nx: number, ny: number}} size
 * @param {number} nBases
 * @param {{maxLevels?: number, minNodesPerDir?: number, minFree?: number, nsPerNode?: number, cycles?: number, sorSweepsPerSide?: number}} [opts]
 * @returns {{levels: number, msPerBasis: number, msTotal: number, bytesPerSolveWorker: number}}
 */
export function estimate({ nx, ny }, nBases = 1, opts = {}) {
    const maxLevels = opts.maxLevels || 8, minDir = opts.minNodesPerDir || 5, minFree = opts.minFree === undefined ? 1000 : opts.minFree;
    const ns = opts.nsPerNode || 4.5, cyc = opts.cycles || 20, sps = opts.sorSweepsPerSide || 1.3;
    const N = nx * ny;
    let levels = 1, n = N;
    for (let l = 1; l < maxLevels; l++) {
        if (n <= minFree) break;
        const s = 2 ** l, cx = Math.ceil((nx - 1) / s) + 1, cy = Math.ceil((ny - 1) / s) + 1;
        if (cx < minDir || cy < minDir) break;
        levels++; n = cx * cy;
    }
    const msPerBasis = levels >= 3 ? cyc * 12 * ns * 1e-6 * N * 1.34 : sps * Math.max(nx, ny) * ns * 1e-6 * N;
    return { levels, msPerBasis, msTotal: msPerBasis * Math.max(0, nBases), bytesPerSolveWorker: 100 * N };
}
