/* ==========================================================================
   Ion optics engine: waveform.js
   Electrode voltage waveforms V_k(t) = v_k + Σ terms, grouped into time
   channels for superposition: φ(t) = φ0 + Σ_c f_c(t)·φ_c with
   φ0 = Σ_k dc_k φ_k and φ_c = Σ_k amp_{k,c} φ_k, where φ_k is the 1 V basis
   field of electrode k (Laplace superposition, e.g. Jackson, Classical
   Electrodynamics, 3rd ed., §1.13). Terms that differ only in amplitude share
   a channel, so a quadrupole driven ±V cos Ωt is one channel.

   Terms (V, µs, MHz, degrees):
     cos   amp·cos(2π f t + phase)
     pulse trapezoid 0 → amp → 0 (start t0, rise, width, fall), repeating every
           `period` when period ≥ rise + width + fall (for all t)
     table piecewise linear through points [[t, v]...]; constant beyond the
           ends; with `period`, one period is [t_first, t_first + period): the
           table, then the last value held until the period wraps.
   Pulses and tables are piecewise linear in t; their corners are reported by
   nextBreak() so the tracer lands steps on them exactly (minPeriod = ∞).
   ========================================================================== */

const MAX_CHANNELS = 7;

function engineError(code, message, detail) {
    const e = new Error(message); e.name = 'EngineError'; e.code = code;
    if (detail !== undefined) e.detail = detail;
    return e;
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Terms of a resolved electrode (resolved.terms, else wave.terms). */
function termsOf(e) {
    if (!e) return [];
    if (Array.isArray(e.terms)) return e.terms;
    if (e.wave && Array.isArray(e.wave.terms)) return e.wave.terms;
    return [];
}

/**
 * @typedef {{ kind: string, value: (t: number) => number, valueLeft: (t: number) => number,
 *   nextBreak: (t0: number, t1: number) => number, period: number, minPeriod: number }} TimeFn
 */

/** cos(2π f t + phase), unit amplitude. @returns {TimeFn} */
export function cosFn(freq, phaseDeg = 0) {
    const w = 2 * Math.PI * freq, ph = phaseDeg * Math.PI / 180, T = 1 / Math.abs(freq);
    const value = (t) => Math.cos(w * t + ph);
    return { kind: 'cos', freq, phase: phaseDeg, value, valueLeft: value, nextBreak: () => Infinity, period: T, minPeriod: T };
}

/** Trapezoid pulse with unit amplitude. @returns {TimeFn} */
export function pulseFn(t0, rise, width, fall, period = null) {
    rise = Math.max(0, num(rise)); width = Math.max(0, num(width)); fall = Math.max(0, num(fall)); t0 = num(t0);
    const b1 = rise, b2 = rise + width, b3 = rise + width + fall;
    const P = (typeof period === 'number' && period > 0 && period >= b3) ? period : Infinity;
    const periodic = P < Infinity;
    const local = (t) => {
        let s = t - t0;
        if (periodic) { s %= P; if (s < 0) s += P; }
        return s;
    };
    const value = (t) => {   // right-continuous
        const s = local(t);
        if (s < 0) return 0;
        if (s < b1) return s / rise;
        if (s < b2) return 1;
        if (s < b3) return 1 - (s - b2) / fall;
        return 0;
    };
    const valueLeft = (t) => {   // left limit
        let s = local(t);
        if (periodic && s === 0) s = P;   // end of the previous period
        if (s <= 0) return 0;
        if (s <= b1) return s / rise;
        if (s <= b2) return 1;
        if (s <= b3) return 1 - (s - b2) / fall;
        return 0;
    };
    const corners = [0, b1, b2, b3].filter((v, i, a) => a.indexOf(v) === i);
    const nextBreak = (ta, tb) => {
        if (!periodic) {
            for (const c of corners) { const tc = t0 + c; if (tc > ta && tc <= tb) return tc; }
            return Infinity;
        }
        let k = Math.floor((ta - t0) / P) - 1;
        for (let guard = 0; guard < 1e6; guard++, k++) {
            const base = t0 + k * P;
            if (base > tb) break;
            for (const c of corners) { const tc = base + c; if (tc > ta && tc <= tb) return tc; }
        }
        return Infinity;
    };
    return { kind: 'pulse', value, valueLeft, nextBreak, period: P, minPeriod: Infinity };
}

/** Piecewise-linear table (already normalised). @returns {TimeFn} */
export function tableFn(points, period = null) {
    const n = points.length;
    const ts = new Float64Array(n), vs = new Float64Array(n);
    for (let i = 0; i < n; i++) { ts[i] = num(points[i][0]); vs[i] = num(points[i][1]); }
    const tFirst = ts[0], tLast = ts[n - 1];
    const P = (typeof period === 'number' && period > 0) ? Math.max(period, tLast - tFirst) : Infinity;
    const periodic = P < Infinity && n > 0;
    // index of the segment [ts[i], ts[i+1]] containing s (tFirst ≤ s ≤ tLast)
    const seg = (s) => {
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= s) lo = mid; else hi = mid; }
        return lo;
    };
    const interp = (s) => {
        if (n === 1) return vs[0];
        const i = seg(s), dt = ts[i + 1] - ts[i];
        return dt > 0 ? vs[i] + (vs[i + 1] - vs[i]) * (s - ts[i]) / dt : vs[i + 1];
    };
    const value = (t) => {
        if (n === 0) return 0;
        let s = t;
        if (periodic) { s = (t - tFirst) % P; if (s < 0) s += P; s += tFirst; }
        if (s <= tFirst) return vs[0];
        if (s >= tLast) return vs[n - 1];
        return interp(s);
    };
    const valueLeft = (t) => {
        if (n === 0) return 0;
        if (periodic) {
            let s = (t - tFirst) % P; if (s < 0) s += P;
            if (s === 0) return vs[n - 1];   // left limit at a period boundary: the held last value
            s += tFirst;
            if (s >= tLast) return vs[n - 1];
            return interp(s);
        }
        if (t <= tFirst) return vs[0];
        if (t >= tLast) return vs[n - 1];
        return interp(t);
    };
    const nextBreak = (ta, tb) => {
        if (n === 0) return Infinity;
        if (!periodic) {
            // first knot > ta
            if (ta >= tLast) return Infinity;
            let i = ta < tFirst ? 0 : seg(ta) + 1;
            while (i < n && ts[i] <= ta) i++;
            return i < n && ts[i] <= tb ? ts[i] : Infinity;
        }
        // knots of period k are ts[i] + k·P; ts[0] + k·P is also the wrap point (held last value → first value)
        let k = Math.floor((ta - tFirst) / P) - 1;
        for (let guard = 0; guard < 1e6; guard++, k++) {
            const base = k * P;
            if (tFirst + base > tb) break;
            for (let i = 0; i < n; i++) { const tc = ts[i] + base; if (tc > ta && tc <= tb) return tc; }
        }
        return Infinity;
    };
    return { kind: 'table', value, valueLeft, nextBreak, period: P, minPeriod: Infinity };
}

/**
 * Canonical form of a term: { key, amp, make() → TimeFn } or { dc } for constant terms.
 * Phase is folded into [0°, 180°) by flipping the amplitude sign.
 */
function canonical(term) {
    const type = term && term.type;
    if (type === 'cos') {
        let amp = num(term.amp), f = num(term.freq), p = num(term.phase);
        if (f === 0) return { dc: amp * Math.cos(p * Math.PI / 180) };
        if (f < 0) { f = -f; p = -p; }
        p = ((p % 360) + 360) % 360;
        if (p >= 180) { p -= 180; amp = -amp; }
        const key = 'cos|' + f + '|' + p;
        return { key, amp, make: () => cosFn(f, p) };
    }
    if (type === 'pulse') {
        const per = (typeof term.period === 'number' && term.period > 0) ? term.period : null;
        const key = 'pulse|' + num(term.t0) + '|' + num(term.rise) + '|' + num(term.width) + '|' + num(term.fall) + '|' + per;
        return { key, amp: num(term.amp), make: () => pulseFn(num(term.t0), num(term.rise), num(term.width), num(term.fall), per) };
    }
    if (type === 'table') {
        const pts = Array.isArray(term.points) ? term.points : [];
        let scale = 0;
        for (const p of pts) { const v = num(p[1]); if (Math.abs(v) > Math.abs(scale)) scale = v; }
        if (scale === 0 || pts.length === 0) return { dc: 0 };
        const norm = pts.map((p) => [num(p[0]), num(p[1]) / scale]);
        const per = (typeof term.period === 'number' && term.period > 0) ? term.period : null;
        const key = 'table|' + per + '|' + norm.map((p) => p[0] + ':' + p[1]).join(',');
        return { key, amp: scale, make: () => tableFn(norm, per) };
    }
    return { dc: 0 };
}

/**
 * DC vector and time channels of the resolved electrodes (index = position; gnd = 0 is always 0 V).
 * @param {Array<object>} resolvedElectrodes
 * @returns {{ dc: Float64Array, channels: Array<{ key: string, amp: Float64Array, fn: TimeFn }> }}
 */
export function timeFunctions(resolvedElectrodes) {
    const list = resolvedElectrodes || [];
    const nE = list.length;
    const dc = new Float64Array(nE);
    const channels = [], byKey = new Map();
    for (let k = 0; k < nE; k++) {
        const e = list[k];
        if (!e || k === 0 || e.ground) continue;
        dc[k] = num(e.dc, num(e.v));
        for (const term of termsOf(e)) {
            const c = canonical(term);
            if (c.dc !== undefined) { dc[k] += c.dc; continue; }
            if (c.amp === 0) continue;
            let ch = byKey.get(c.key);
            if (!ch) {
                if (channels.length >= MAX_CHANNELS) throw engineError('E_UNSUPPORTED', 'More than ' + MAX_CHANNELS + ' distinct waveform shapes (time channels).', { key: c.key });
                ch = { key: c.key, amp: new Float64Array(nE), fn: c.make() };
                byKey.set(c.key, ch); channels.push(ch);
            }
            ch.amp[k] += c.amp;
        }
    }
    return { dc, channels };
}

/**
 * Samples V(t) of one electrode on [t0, t1]: n uniform points plus every breakpoint
 * (a jump gives two samples at the same t: left and right values).
 * @returns {{ t: Float64Array, v: Float64Array }}
 */
export function sampleWave(resolvedElectrode, t0, t1, n) {
    const e = resolvedElectrode || {};
    const base = num(e.dc, num(e.v));
    let dcAdd = 0;
    const parts = [];
    for (const term of termsOf(e)) {
        const c = canonical(term);
        if (c.dc !== undefined) dcAdd += c.dc;
        else if (c.amp !== 0) parts.push({ amp: c.amp, fn: c.make() });
    }
    const v0 = base + dcAdd;
    const evalAt = (t, left) => { let v = v0; for (const p of parts) v += p.amp * (left ? p.fn.valueLeft(t) : p.fn.value(t)); return v; };
    n = Math.max(2, Math.floor(num(n, 200)));
    if (!(t1 > t0)) t1 = t0 + 1;
    const ts = [];
    for (let i = 0; i < n; i++) ts.push({ t: t0 + (t1 - t0) * i / (n - 1), brk: false });
    for (const p of parts) {
        let t = t0, guard = 0;
        for (;;) {
            const b = p.fn.nextBreak(t, t1);
            if (!(b < Infinity) || guard++ > 20000) break;
            ts.push({ t: b, brk: true }); t = b;
        }
    }
    ts.sort((a, b) => a.t - b.t || (a.brk ? -1 : 1));   // a breakpoint first at equal times
    const outT = [], outV = [];
    let last = -Infinity;
    for (const s of ts) {
        if (s.t === last) continue;   // a breakpoint at this time already gave both sides
        if (s.brk) {
            const vl = evalAt(s.t, true), vr = evalAt(s.t, false);
            if (vl !== vr && s.t > t0) { outT.push(s.t); outV.push(vl); }
            outT.push(s.t); outV.push(vr);
        } else {
            outT.push(s.t); outV.push(evalAt(s.t, false));
        }
        last = s.t;
    }
    return { t: Float64Array.from(outT), v: Float64Array.from(outV) };
}
