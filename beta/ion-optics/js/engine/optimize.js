/* ==========================================================================
   Ion optics engine: optimize.js
   One-dimensional scans, bounded Nelder–Mead minimisation and the run
   metrics they optimise (specification §2.3 WP5, §2.2.2 analysis, §4.7).

   - Nelder & Mead, Comput. J. 7, 308 (1965), with the standard coefficients
     (reflection 1, expansion 2, contraction ½, shrink ½) and the
     inside/outside contraction rules of Lagarias, Reeds, Wright & Wright,
     SIAM J. Optim. 9, 112 (1998); bounds are enforced by projecting every
     trial point onto the box, so no evaluation leaves it.
   - Metrics on a TraceResult: transmission, rms spot radius, waist position
     (straight-line continuation of the rays at a field-free plane, minimum of
     the quadratic rms size, e.g. Wollnik, Optics of Charged Particles (1987)),
     mean time of flight, TOF FWHM and resolving power t̄/(2·FWHM) (Wiley &
     McLaren, Rev. Sci. Instrum. 26, 1150 (1955)), mean kinetic energy and
     the grouped blur of velocity-map images (§3.11(6); Eppink & Parker,
     Rev. Sci. Instrum. 68, 3477 (1997)).
   The objective and evaluation functions may be asynchronous.
   ========================================================================== */
import { C_STRIDE, C_ID, C_PLANE, C_T, C_X, C_Y, C_Z, C_VX, C_VY, C_VZ, C_KE, C_DIR, C_KIND,
    S_STRIDE, S_ID, S_STATUS, S_WHERE, S_SRC, S_SPECIES, S_T0, STATUS, P_STRIDE, P_ID, P_C1, P_C2 } from './layout.js';
import { peakStats } from './analysis.js';
import { generate } from './particles.js';

/** Metric types with their labels and units (spec §2.2.2 analysis.metric). */
export const METRICS = Object.freeze({
    transmission: { label: 'Transmission', unit: '', goal: 'max' },
    spotRms: { label: 'Spot rms', unit: 'mm', goal: 'min' },
    waistPos: { label: 'Waist position', unit: 'mm', goal: 'min' },
    meanTof: { label: 'Mean TOF', unit: 'µs', goal: 'min' },
    tofFwhm: { label: 'TOF width (2.3548σ)', unit: 'µs', goal: 'min' },
    resolvingPower: { label: 'Resolving power t/(2·2.3548σ)', unit: '', goal: 'max' },
    meanKE: { label: 'Mean kinetic energy', unit: 'eV', goal: 'max' },
    groupedBlur: { label: 'Grouped blur', unit: 'mm', goal: 'min' },
});

/**
 * Evaluates evalFn at each value in order (awaiting each). onPoint(index, value, metric) after each point.
 * opts.goal 'min' (default) or 'max' selects `best` (non-finite metrics are skipped).
 * @param {(v: number) => (number|Promise<number>)} evalFn @param {number[]} values
 * @returns {Promise<{ values: number[], metrics: number[], best: { index: number, value: number, metric: number } | null }>}
 */
export async function scan1D(evalFn, values, onPoint = null, { goal = 'min', shouldStop = null } = {}) {
    const vals = Array.from(values), metrics = [];
    let best = null;
    for (let i = 0; i < vals.length; i++) {
        if (shouldStop && shouldStop()) break;
        const v = vals[i];
        let mtr = await evalFn(v);
        if (typeof mtr !== 'number') mtr = NaN;
        metrics.push(mtr);
        if (Number.isFinite(mtr) && (best === null || (goal === 'max' ? mtr > best.metric : mtr < best.metric))) best = { index: i, value: v, metric: mtr };
        if (onPoint) onPoint(i, v, mtr);
    }
    return { values: vals.slice(0, metrics.length), metrics, best };
}

/** Values of a scan specification { from, to, n } or { list }. */
export function scanValues(spec) {
    if (!spec) return [];
    if (Array.isArray(spec.list)) return spec.list.slice();
    const n = Math.max(1, Math.round(spec.n || 1));
    if (n === 1) return [spec.from];
    const out = [];
    for (let i = 0; i < n; i++) out.push(spec.from + (spec.to - spec.from) * i / (n - 1));
    return out;
}

/**
 * Bounded Nelder–Mead minimisation.
 * opts: step (initial simplex offsets, default 5% of |x0| or 0.00025), lower, upper (arrays), maxEval = 60,
 * ftol = 1e-6 and xtol = 1e-6 (absolute spreads of the simplex values and vertices), shouldStop().
 * Trial points are projected onto the box. When the simplex converges with budget left, the best point is probed
 * along each coordinate (O'Neill, Appl. Stat. 20, 338 (1971), AS 47); a lower probe restarts the search from it,
 * which also frees simplices that collapsed onto a bound.
 * onIter({ iter, nEval, x, fx, simplex, values }) after every iteration.
 * @param {(x: number[]) => (number|Promise<number>)} f @param {number[]} x0
 * @returns {Promise<{ x: number[], fx: number, nEval: number, history: Array<{ nEval: number, x: number[], fx: number }>, converged: boolean, reason: string, restarts: number }>}
 */
export async function nelderMead(f, x0, { step = null, lower = null, upper = null, maxEval = 60, ftol = 1e-6, xtol = 1e-6, shouldStop = null } = {}, onIter = null) {
    const n = x0.length;
    const lo = lower ? lower.map((v) => (Number.isFinite(v) ? v : -Infinity)) : new Array(n).fill(-Infinity);
    const hi = upper ? upper.map((v) => (Number.isFinite(v) ? v : Infinity)) : new Array(n).fill(Infinity);
    const clampV = (x) => x.map((v, i) => Math.min(hi[i], Math.max(lo[i], v)));
    const history = [];
    let nEval = 0, iter = 0, bestX = clampV(x0.slice()), bestF = Infinity;
    const evalF = async (x) => {
        nEval++;
        let v = await f(x.slice());
        if (typeof v !== 'number' || Number.isNaN(v)) v = Infinity;
        if (v < bestF) { bestF = v; bestX = x.slice(); }
        return v;
    };
    const st0 = step ? step.slice() : x0.map((v) => (v !== 0 ? 0.05 * Math.abs(v) : 0.00025));
    let start = clampV(x0.slice()), st = st0.slice();
    let reason = 'maxEval', converged = false, restarts = 0;
    for (;;) {
        // ---- one Nelder–Mead search from `start`
        const pts = [start.slice()];
        for (let i = 0; i < n; i++) {
            const x = start.slice();
            x[i] = x[i] + st[i];
            let c = clampV(x);
            if (c[i] === start[i]) { x[i] = start[i] - st[i]; c = clampV(x); }
            pts.push(c);
        }
        const vals = [];
        for (const p of pts) {
            if (nEval >= maxEval) break;
            vals.push(await evalF(p));
        }
        if (vals.length < pts.length) { reason = 'maxEval'; break; }
        const order = () => {
            const idx = pts.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
            const p2 = idx.map((i) => pts[i]), v2 = idx.map((i) => vals[i]);
            for (let i = 0; i <= n; i++) { pts[i] = p2[i]; vals[i] = v2[i]; }
        };
        let done = false;
        for (;;) {
            order();
            iter++;
            history.push({ nEval, x: bestX.slice(), fx: bestF });
            if (onIter) onIter({ iter, nEval, x: bestX.slice(), fx: bestF, simplex: pts.map((p) => p.slice()), values: vals.slice() });
            let fs = 0, xs = 0;
            for (let i = 1; i <= n; i++) {
                fs = Math.max(fs, Math.abs(vals[i] - vals[0]));
                for (let j = 0; j < n; j++) xs = Math.max(xs, Math.abs(pts[i][j] - pts[0][j]));
            }
            if (fs <= ftol && xs <= xtol) { reason = 'tolerance'; break; }
            if (nEval >= maxEval) { reason = 'maxEval'; done = true; break; }
            if (shouldStop && shouldStop()) { reason = 'stopped'; done = true; break; }
            const xc = new Array(n).fill(0);
            for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) xc[j] += pts[i][j] / n;
            const w = pts[n];
            const along = (t) => clampV(xc.map((c, j) => c + t * (c - w[j])));
            const xr = along(1), fr = await evalF(xr);
            if (fr < vals[0]) {
                if (nEval >= maxEval) { pts[n] = xr; vals[n] = fr; continue; }
                const xe = along(2), fe = await evalF(xe);
                if (fe < fr) { pts[n] = xe; vals[n] = fe; } else { pts[n] = xr; vals[n] = fr; }
            } else if (fr < vals[n - 1]) {
                pts[n] = xr; vals[n] = fr;
            } else {
                if (nEval >= maxEval) { if (fr < vals[n]) { pts[n] = xr; vals[n] = fr; } continue; }
                let accepted = false;
                if (fr < vals[n]) {
                    const xo = along(0.5), fo = await evalF(xo);
                    if (fo <= fr) { pts[n] = xo; vals[n] = fo; accepted = true; }
                } else {
                    const xi = along(-0.5), fi = await evalF(xi);
                    if (fi < vals[n]) { pts[n] = xi; vals[n] = fi; accepted = true; }
                }
                if (!accepted) {
                    for (let i = 1; i <= n; i++) {
                        if (nEval >= maxEval) break;
                        pts[i] = clampV(pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j])));
                        vals[i] = await evalF(pts[i]);
                    }
                }
            }
        }
        if (done) break;
        // ---- converged: probe the best point along each coordinate (AS 47); restart from a lower probe
        const fBefore = bestF, xBest = bestX.slice();
        let improved = false;
        for (let j = 0; j < n && !improved; j++) {
            const d = Math.max(10 * xtol, 1e-3 * Math.abs(st0[j]));
            for (const sgn of [1, -1]) {
                if (nEval >= maxEval) break;
                const x = xBest.slice();
                x[j] += sgn * d;
                const c = clampV(x);
                if (c[j] === xBest[j]) continue;
                const v = await evalF(c);
                if (v < fBefore - ftol * 1e-3) { improved = true; break; }
            }
        }
        if (!improved || restarts >= 5 || nEval >= maxEval) { converged = !improved; reason = improved ? 'maxEval' : 'tolerance'; break; }
        restarts++;
        start = bestX.slice();
        st = st0.map((v) => v / (2 * restarts));
    }
    history.push({ nEval, x: bestX.slice(), fx: bestF });
    return { x: bestX.slice(), fx: bestF, nEval, history, converged, reason, restarts };
}

// ---------------------------------------------------------------- metrics on a run
const AX = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Orthonormal frame of a recording plane: n (forward normal), u and w (in-plane), origin. */
export function planeFrame(plane) {
    const k = plane ? plane.kind : 'x';
    if (k === 'y') return { n: AX.y, u: AX.x, w: AX.z, origin: [0, plane.at || 0, 0], axes: ['x', 'z'], axis: 'y' };
    if (k === 'z') return { n: AX.z, u: AX.x, w: AX.y, origin: [0, 0, plane.at || 0], axes: ['x', 'y'], axis: 'z' };
    if (k === 'segment') {
        const p0 = plane.p0 || [0, 0], p1 = plane.p1 || [1, 0];
        const dx = p1[0] - p0[0], dy = p1[1] - p0[1], L = Math.hypot(dx, dy) || 1;
        return { n: [dy / L, -dx / L, 0], u: [dx / L, dy / L, 0], w: AX.z, origin: [p0[0], p0[1], 0], axes: ['a', 'z'], axis: 'n' };
    }
    if (k === 'r') return { n: AX.y, u: AX.x, w: AX.z, origin: [0, 0, 0], axes: ['x', 'z'], axis: 'r' };
    return { n: AX.x, u: AX.y, w: AX.z, origin: [plane ? plane.at || 0 : 0, 0, 0], axes: ['y', 'z'], axis: 'x' };
}

/** Index of a plane by id (or −1). */
export function planeIndex(resolved, id) {
    const planes = (resolved && resolved.recording && resolved.recording.planes) || [];
    if (id === null || id === undefined) {
        const t = planes.findIndex((p) => p.terminate);
        return t >= 0 ? t : (planes.length ? 0 : -1);
    }
    return planes.findIndex((p) => p.id === id);
}

/** Summary-row offsets by particle id. */
function summaryIndex(result) {
    const map = new Map(), S = result.summary;
    for (let i = 0; i < result.n; i++) map.set(S[i * S_STRIDE + S_ID], i * S_STRIDE);
    return map;
}

/** Filter predicate on summary offsets from a metric's source id and species label. */
function particleFilter(resolved, metric) {
    if (!metric || (metric.source == null && metric.species == null)) return null;
    const sources = (resolved && resolved.sources) || [];
    const srcIdx = metric.source != null ? sources.findIndex((s) => s.id === metric.source) : -1;
    return (S, o) => {
        const s = S[o + S_SRC], sp = S[o + S_SPECIES];
        if (metric.source != null && s !== srcIdx) return false;
        if (metric.species != null) {
            const src = sources[s];
            const spec = src && src.species ? src.species[sp] : null;
            if (!spec || spec.label !== metric.species) return false;
        }
        return true;
    };
}

/**
 * Crossing rows of a plane with derived columns: positions (u, w) in the plane frame, slopes u′, w′ along n,
 * time of flight (crossing time − birth time), kinetic energy, ids.
 */
export function planeSample(result, resolved, planeIdx, metric = null, { side = null } = {}) {
    const planes = (resolved && resolved.recording && resolved.recording.planes) || [];
    const plane = planes[planeIdx];
    const fr = planeFrame(plane);
    const S = result.summary, C = result.crossings, nc = result.nCross;
    const sidx = summaryIndex(result);
    const filt = particleFilter(resolved, metric);
    const sd = side || (plane && plane.side) || 'both';
    const out = { u: [], w: [], up: [], wp: [], tof: [], ke: [], ids: [], x: [], y: [], z: [], frame: fr, plane };
    const seen = new Set();
    for (let c = 0; c < nc; c++) {
        const b = c * C_STRIDE;
        if (C[b + C_KIND] !== 0 || C[b + C_PLANE] !== planeIdx) continue;
        if (sd === 'forward' && !(C[b + C_DIR] > 0)) continue;
        if (sd === 'backward' && !(C[b + C_DIR] < 0)) continue;
        const id = C[b + C_ID];
        const o = sidx.get(id);
        if (o === undefined) continue;
        if (filt && !filt(S, o)) continue;
        if (seen.has(id)) continue;        // first crossing per particle
        seen.add(id);
        const px = C[b + C_X] - fr.origin[0], py = C[b + C_Y] - fr.origin[1], pz = C[b + C_Z] - fr.origin[2];
        const vx = C[b + C_VX], vy = C[b + C_VY], vz = C[b + C_VZ];
        const vn = vx * fr.n[0] + vy * fr.n[1] + vz * fr.n[2];
        out.u.push(px * fr.u[0] + py * fr.u[1] + pz * fr.u[2]);
        out.w.push(px * fr.w[0] + py * fr.w[1] + pz * fr.w[2]);
        out.up.push(vn !== 0 ? (vx * fr.u[0] + vy * fr.u[1] + vz * fr.u[2]) / vn : NaN);
        out.wp.push(vn !== 0 ? (vx * fr.w[0] + vy * fr.w[1] + vz * fr.w[2]) / vn : NaN);
        out.tof.push(C[b + C_T] - S[o + S_T0]);
        out.ke.push(C[b + C_KE]);
        out.ids.push(id);
        out.x.push(C[b + C_X]); out.y.push(C[b + C_Y]); out.z.push(C[b + C_Z]);
    }
    return out;
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

/** rms radius about the centroid of (u, w). */
export function rmsRadius(u, w) {
    const n = u.length;
    if (!n) return NaN;
    const mu = mean(u), mw = mean(w);
    let s = 0;
    for (let i = 0; i < n; i++) s += (u[i] - mu) * (u[i] - mu) + (w[i] - mw) * (w[i] - mw);
    return Math.sqrt(s / n);
}

/** Closed-form waist of straight-line continued rays: offset s* along n from the plane and the rms there. */
export function waistOf(sample) {
    const { u, w, up, wp } = sample;
    const U = [], W = [], Up = [], Wp = [];
    for (let i = 0; i < u.length; i++) if (Number.isFinite(up[i]) && Number.isFinite(wp[i])) { U.push(u[i]); W.push(w[i]); Up.push(up[i]); Wp.push(wp[i]); }
    const n = U.length;
    if (!n) return { offset: NaN, rms: NaN, rmsAtPlane: NaN, n: 0 };
    const mu = mean(U), mw = mean(W), mup = mean(Up), mwp = mean(Wp);
    let A = 0, B = 0, C = 0;
    for (let i = 0; i < n; i++) {
        const du = U[i] - mu, dw = W[i] - mw, dup = Up[i] - mup, dwp = Wp[i] - mwp;
        A += du * du + dw * dw; B += du * dup + dw * dwp; C += dup * dup + dwp * dwp;
    }
    A /= n; B /= n; C /= n;
    const s = C > 0 ? -B / C : 0;
    return { offset: s, rms: Math.sqrt(Math.max(0, A + 2 * B * s + C * s * s)), rmsAtPlane: Math.sqrt(A), n };
}

/**
 * Value of a metric { type, plane, species?, source? } on a run. Transmission counts DETECTED particles on the
 * plane (all detectors when plane is null) among the particles selected by source/species.
 * @param {object} metric @param {object} result TraceResult @param {object} resolved
 * @returns {number}
 */
export function evaluateMetric(metric, result, resolved) {
    if (!metric || !result) return NaN;
    const type = metric.type || 'transmission';
    const S = result.summary;
    const filt = particleFilter(resolved, metric);
    if (type === 'transmission') {
        const pi = metric.plane != null ? planeIndex(resolved, metric.plane) : -1;
        let n = 0, d = 0;
        for (let i = 0; i < result.n; i++) {
            const o = i * S_STRIDE;
            if (filt && !filt(S, o)) continue;
            n++;
            if (S[o + S_STATUS] === STATUS.DETECTED && (pi < 0 || S[o + S_WHERE] === pi)) d++;
        }
        return n ? d / n : NaN;
    }
    const pi = planeIndex(resolved, metric.plane);
    if (pi < 0) return NaN;
    if (type === 'groupedBlur') return groupedBlurMetric(result, resolved, pi, metric);
    const smp = planeSample(result, resolved, pi, metric);
    switch (type) {
        case 'spotRms': return rmsRadius(smp.u, smp.w);
        case 'waistPos': {
            const wst = waistOf(smp);
            const fr = smp.frame;
            if (smp.plane && (smp.plane.kind === 'x' || smp.plane.kind === 'y' || smp.plane.kind === 'z')) return (smp.plane.at || 0) + wst.offset;
            return wst.offset + (fr.origin[0] * fr.n[0] + fr.origin[1] * fr.n[1]);
        }
        case 'meanTof': return mean(smp.tof);
        // rms-based widths: a half-maximum width follows the bin width on peaks with a steep edge, so scans and tuning would chase noise
        case 'tofFwhm': return smp.tof.length >= 2 ? 2 * Math.sqrt(2 * Math.LN2) * peakStats(smp.tof).std : NaN;
        case 'resolvingPower': return smp.tof.length >= 2 ? peakStats(smp.tof).resolvingPowerRms : NaN;
        case 'meanKE': return mean(smp.ke);
        default: return NaN;
    }
}

/**
 * Grouped blur (§3.11(6)): rows grouped by (source, species, direction class, energy class); rms radius of each group
 * about its centroid in the plane's (u, w) coordinates; √(mean of the squared group rms).
 */
export function groupedBlurMetric(result, resolved, planeIdx, metric = null) {
    const smp = planeSample(result, resolved, planeIdx, metric);
    if (!smp.ids.length) return NaN;
    const cls = classIndex(resolved);
    const S = result.summary, sidx = summaryIndex(result);
    const groups = new Map();
    for (let i = 0; i < smp.ids.length; i++) {
        const id = smp.ids[i], o = sidx.get(id);
        const c = cls.get(id) || [-1, -1];
        const key = `${S[o + S_SRC]}:${S[o + S_SPECIES]}:${c[0]}:${c[1]}`;
        let g = groups.get(key);
        if (!g) { g = { u: [], w: [] }; groups.set(key, g); }
        g.u.push(smp.u[i]); g.w.push(smp.w[i]);
    }
    let s = 0, m = 0;
    for (const g of groups.values()) { const r = rmsRadius(g.u, g.w); if (Number.isFinite(r)) { s += r * r; m++; } }
    return m ? Math.sqrt(s / m) : NaN;
}

/** Direction and energy class indices per particle id, regenerated from the sources (counter-based, so exact). */
export function classIndex(resolved) {
    const out = new Map();
    if (!resolved || !resolved.sources || !resolved.particleCount) return out;
    const rows = generate(resolved.sources, 0, resolved.particleCount, { domainType: resolved.domain && resolved.domain.type, relativistic: !resolved.tracer || resolved.tracer.relativistic !== false });
    for (let i = 0; i * P_STRIDE < rows.length; i++) out.set(rows[i * P_STRIDE + P_ID], [rows[i * P_STRIDE + P_C1], rows[i * P_STRIDE + P_C2]]);
    return out;
}
