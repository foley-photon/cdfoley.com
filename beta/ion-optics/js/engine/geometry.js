/* ==========================================================================
   Ion optics engine: geometry.js
   Shapes to exact primitives in plane coordinates ((x, y) planar, (x, rho)
   cylindrical), and exact classification of points and segments.

   Every primitive is a closed set grown by eps = 1e-9 h (points within eps of
   its boundary are inside). A segment P + tD, t in [0, 1], is classified by
   painting the exact parameter intervals of every primitive in CSG order:
   an electrode overwrites, a void erases, later shapes win. The same painter
   gives node classes, Shortley-Weller cut distances, cell types and particle
   hits, so a sub-cell plate can never be invisible to any of them.

   Sources: constructive solid geometry by ordered painting (Requicha, ACM
   Comput. Surv. 12, 437 (1980)); line clipping against slabs (Liang & Barsky,
   ACM Trans. Graph. 3, 1 (1984)); even-odd point in polygon (Shimrat, Commun.
   ACM 5, 434 (1962)); ray-quadric intersection with the stable quadratic
   formula (Press, Teukolsky, Vetterling & Flannery, Numerical Recipes, 3rd ed.
   (2007), section 5.6).
   ========================================================================== */

export const SHAPE_TYPES = ['box', 'tube', 'plate', 'disc', 'circle', 'annulus', 'polygon', 'polyline', 'quadric'];

const KR = 0, KC = 1, KA = 2, KP = 3, KL = 4, KQ = 5;
const KIND = ['rect', 'circle', 'annulus', 'polygon', 'polyline', 'quadric'];

// ---------------------------------------------------------------- doubles
// Adjacent doubles, used to make truncated pieces half-open so that every
// parameter belongs to at most one painted piece.
const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
const LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const LO = LE ? 0 : 1, HI = LE ? 1 : 0;

/**
 * Smallest double greater than x.
 * @param {number} x finite number
 * @returns {number}
 */
export function nextUp(x) {
    if (x !== x || x === Infinity) return x;
    if (x === 0) return Number.MIN_VALUE;
    F64[0] = x;
    if (x > 0) {
        if (U32[LO] === 0xFFFFFFFF) { U32[LO] = 0; U32[HI] = U32[HI] + 1; } else U32[LO] = U32[LO] + 1;
    } else if (U32[LO] === 0) { U32[LO] = 0xFFFFFFFF; U32[HI] = U32[HI] - 1; } else U32[LO] = U32[LO] - 1;
    return F64[0];
}
/**
 * Largest double smaller than x.
 * @param {number} x finite number
 * @returns {number}
 */
export function nextDown(x) { return -nextUp(-x); }

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ---------------------------------------------------------------- scratch
let IV = new Float64Array(512);          // final interval pairs of one primitive
let TS = new Float64Array(256);          // crossing parameters (polygons)
let TP = new Float64Array(1024);         // temporary interval pairs (polygons, polylines)
function growIV(n) { if (n > IV.length) { const a = new Float64Array(Math.max(n, 2 * IV.length)); a.set(IV); IV = a; } }
function growTS(n) { if (n > TS.length) { const a = new Float64Array(Math.max(n, 2 * TS.length)); a.set(TS); TS = a; } }
function growTP(n) { if (n > TP.length) { const a = new Float64Array(Math.max(n, 2 * TP.length)); a.set(TP); TP = a; } }

function sortScalars(a, n) {
    if (n > 48) { const s = a.subarray(0, n); s.sort(); return; }
    for (let i = 1; i < n; i++) {
        const v = a[i]; let j = i - 1;
        while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; }
        a[j + 1] = v;
    }
}
// sort n pairs (lo, hi) by lo, in place
function sortPairs(a, n) {
    for (let i = 1; i < n; i++) {
        const lo = a[2 * i], hi = a[2 * i + 1]; let j = i - 1;
        while (j >= 0 && a[2 * j] > lo) { a[2 * j + 2] = a[2 * j]; a[2 * j + 3] = a[2 * j + 1]; j--; }
        a[2 * j + 2] = lo; a[2 * j + 3] = hi;
    }
}
// merge sorted pairs in `src` (n pairs), clamp to [0, 1], write to `dst` at pair offset 0; returns count
function mergePairs(src, n, dst) {
    let m = 0, clo = 0, chi = -1, have = false;
    for (let i = 0; i < n; i++) {
        let lo = src[2 * i], hi = src[2 * i + 1];
        if (lo < 0) lo = 0;
        if (hi > 1) hi = 1;
        if (!(lo <= hi)) continue;
        if (!have) { clo = lo; chi = hi; have = true; continue; }
        if (lo <= chi) { if (hi > chi) chi = hi; } else { dst[2 * m] = clo; dst[2 * m + 1] = chi; m++; clo = lo; chi = hi; }
    }
    if (have) { dst[2 * m] = clo; dst[2 * m + 1] = chi; m++; }
    return m;
}

// ---------------------------------------------------------------- primitive helpers
// closed-disc interval of the line P + tD (unclamped); returns false when empty; result in DR
const DR = new Float64Array(2);
function discInterval(px, py, dx, dy, cx, cy, r2) {
    const a = dx * dx + dy * dy, wx = px - cx, wy = py - cy;
    if (a === 0) {
        if (wx * wx + wy * wy <= r2) { DR[0] = -Infinity; DR[1] = Infinity; return true; }
        return false;
    }
    const tc = -(wx * dx + wy * dy) / a;
    const qx = wx + tc * dx, qy = wy + tc * dy, dp2 = qx * qx + qy * qy;
    if (dp2 > r2) return false;
    const hw = Math.sqrt((r2 - dp2) / a);
    DR[0] = tc - hw; DR[1] = tc + hw;
    return true;
}
// half-plane c + g t >= -e: interval in HR; returns false when empty
const HR = new Float64Array(2);
function halfPlane(c, g, e) {
    if (g > 0) { HR[0] = (-e - c) / g; HR[1] = Infinity; return true; }
    if (g < 0) { HR[0] = -Infinity; HR[1] = (-e - c) / g; return true; }
    if (c >= -e) { HR[0] = -Infinity; HR[1] = Infinity; return true; }
    return false;
}

// capsule (all points within e of edge m) interval; edges stored 7 per edge: ax ay bx by ux uy len
const CR = new Float64Array(2);
function capsuleInterval(E, m, px, py, dx, dy, e, e2) {
    const o = 7 * m, ax = E[o], ay = E[o + 1], bx = E[o + 2], by = E[o + 3], ux = E[o + 4], uy = E[o + 5], len = E[o + 6];
    let lo = Infinity, hi = -Infinity;
    if (len > 0) {
        let r0 = -Infinity, r1 = Infinity, ok = true;
        const vx = px - ax, vy = py - ay;
        const s0 = vx * ux + vy * uy, sd = dx * ux + dy * uy;
        if (sd !== 0) {
            let t0 = -s0 / sd, t1 = (len - s0) / sd;
            if (t0 > t1) { const tt = t0; t0 = t1; t1 = tt; }
            if (t0 > r0) r0 = t0;
            if (t1 < r1) r1 = t1;
        } else if (s0 < 0 || s0 > len) ok = false;
        if (ok) {
            const q0 = vx * uy - vy * ux, qd = dx * uy - dy * ux;
            if (qd !== 0) {
                let t0 = (-e - q0) / qd, t1 = (e - q0) / qd;
                if (t0 > t1) { const tt = t0; t0 = t1; t1 = tt; }
                if (t0 > r0) r0 = t0;
                if (t1 < r1) r1 = t1;
            } else if (q0 < -e || q0 > e) ok = false;
        }
        if (ok && r0 <= r1) { lo = r0; hi = r1; }
    }
    if (discInterval(px, py, dx, dy, ax, ay, e2)) { if (DR[0] < lo) lo = DR[0]; if (DR[1] > hi) hi = DR[1]; }
    if (len > 0 && discInterval(px, py, dx, dy, bx, by, e2)) { if (DR[0] < lo) lo = DR[0]; if (DR[1] > hi) hi = DR[1]; }
    if (!(lo <= hi)) return false;
    CR[0] = lo; CR[1] = hi;
    return true;
}
function capsuleContains(E, m, x, y, e2) {
    const o = 7 * m, ax = E[o], ay = E[o + 1], ux = E[o + 4], uy = E[o + 5], len = E[o + 6];
    const vx = x - ax, vy = y - ay;
    const s = vx * ux + vy * uy;
    let d2;
    if (len <= 0 || s <= 0) d2 = vx * vx + vy * vy;
    else if (s >= len) { const wx = x - E[o + 2], wy = y - E[o + 3]; d2 = wx * wx + wy * wy; }
    else { const q = vx * uy - vy * ux; d2 = q * q; }
    return d2 <= e2;
}
function evenOdd(pts, n, x, y) {
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = pts[2 * i], yi = pts[2 * i + 1], xj = pts[2 * j], yj = pts[2 * j + 1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}
function buildEdges(pts, n, closed) {
    const ne = closed ? n : n - 1;
    const E = new Float64Array(7 * Math.max(0, ne));
    for (let m = 0; m < ne; m++) {
        const a = m, b = (m + 1) % n;
        const ax = pts[2 * a], ay = pts[2 * a + 1], bx = pts[2 * b], by = pts[2 * b + 1];
        const ex = bx - ax, ey = by - ay, len = Math.sqrt(ex * ex + ey * ey);
        const o = 7 * m;
        E[o] = ax; E[o + 1] = ay; E[o + 2] = bx; E[o + 3] = by;
        E[o + 4] = len > 0 ? ex / len : 0; E[o + 5] = len > 0 ? ey / len : 0; E[o + 6] = len;
    }
    return E;
}

// ---------------------------------------------------------------- contains / intervals
function containsOf(p, x, y) {
    const d = p.d;
    switch (p.k) {
        case KR: return x >= d[0] && x <= d[1] && y >= d[2] && y <= d[3];
        case KC: { const ux = x - d[0], uy = y - d[1]; return ux * ux + uy * uy <= d[3]; }
        case KA: {
            const ux = x - d[0], uy = y - d[1], r2 = ux * ux + uy * uy;
            if (r2 > d[3]) return false;
            if (d[2] > 0 && r2 < d[2]) return false;
            if (d[4] === 1) return true;
            const e = d[10];
            const s0 = d[6] * uy - d[7] * ux >= -e;   // left of the a0 ray direction
            const s1 = ux * d[9] - uy * d[8] >= -e;   // right of the a1 ray direction
            return d[5] === 1 ? (s0 || s1) : (s0 && s1);
        }
        case KP: {
            if (evenOdd(p.pts, p.np, x, y)) return true;
            const E = p.edges, ne = p.ne, e2 = p.e2;
            for (let m = 0; m < ne; m++) if (capsuleContains(E, m, x, y, e2)) return true;
            return false;
        }
        case KL: {
            const E = p.edges, ne = p.ne, e2 = p.e2;
            for (let m = 0; m < ne; m++) if (capsuleContains(E, m, x, y, e2)) return true;
            return false;
        }
        case KQ: {
            if (x < d[6] || x > d[7] || y < d[8] || y > d[9]) return false;
            const X = x - d[3], Y = y - d[4];
            return d[0] * X * X + d[1] * Y * Y - d[2] + d[5] >= 0;
        }
        default: return false;
    }
}

/**
 * Exact parameter intervals of P + tD (t in [0, 1]) inside primitive p, as sorted disjoint
 * closed pairs written to `out` from index 0. Returns the number of intervals.
 */
function intervalsOf(p, px, py, dx, dy, out) {
    const d = p.d;
    switch (p.k) {
        case KR: {
            let lo = 0, hi = 1;
            if (dx !== 0) {
                let a = (d[0] - px) / dx, b = (d[1] - px) / dx;
                if (a > b) { const t = a; a = b; b = t; }
                if (a > lo) lo = a;
                if (b < hi) hi = b;
            } else if (px < d[0] || px > d[1]) return 0;
            if (dy !== 0) {
                let a = (d[2] - py) / dy, b = (d[3] - py) / dy;
                if (a > b) { const t = a; a = b; b = t; }
                if (a > lo) lo = a;
                if (b < hi) hi = b;
            } else if (py < d[2] || py > d[3]) return 0;
            if (lo <= hi) { out[0] = lo; out[1] = hi; return 1; }
            return 0;
        }
        case KC: {
            if (!discInterval(px, py, dx, dy, d[0], d[1], d[3])) return 0;
            const lo = DR[0] > 0 ? DR[0] : 0, hi = DR[1] < 1 ? DR[1] : 1;
            if (lo <= hi) { out[0] = lo; out[1] = hi; return 1; }
            return 0;
        }
        case KA: return annulusIntervals(p, px, py, dx, dy, out);
        case KP: return polygonIntervals(p, px, py, dx, dy, out);
        case KL: return polylineIntervals(p, px, py, dx, dy, out);
        case KQ: return quadricIntervals(p, px, py, dx, dy, out);
        default: return 0;
    }
}

const RING = new Float64Array(4), WEDGE = new Float64Array(4);
function annulusIntervals(p, px, py, dx, dy, out) {
    const d = p.d, cx = d[0], cy = d[1];
    if (!discInterval(px, py, dx, dy, cx, cy, d[3])) return 0;
    const o0 = DR[0], o1 = DR[1];
    let nr = 0;
    if (d[2] > 0 && discInterval(px, py, dx, dy, cx, cy, d[2])) {
        const i0 = DR[0], i1 = DR[1];
        const a1 = i0 < o1 ? i0 : o1;
        if (o0 <= a1) { RING[0] = o0; RING[1] = a1; nr = 1; }
        const b0 = i1 > o0 ? i1 : o0;
        if (b0 <= o1) { RING[2 * nr] = b0; RING[2 * nr + 1] = o1; nr++; }
    } else { RING[0] = o0; RING[1] = o1; nr = 1; }
    let nw;
    if (d[4] === 1) { WEDGE[0] = -Infinity; WEDGE[1] = Infinity; nw = 1; } else {
        const e = d[10], wx = px - cx, wy = py - cy;
        const okA = halfPlane(d[6] * wy - d[7] * wx, d[6] * dy - d[7] * dx, e);
        const a0 = HR[0], a1 = HR[1];
        const okB = halfPlane(wx * d[9] - wy * d[8], dx * d[9] - dy * d[8], e);
        const b0 = HR[0], b1 = HR[1];
        if (d[5] === 1) {   // union of the two half-planes (span > 180 deg)
            nw = 0;
            if (okA && okB) {
                const l0 = a0 < b0 ? a0 : b0, l1 = a0 < b0 ? a1 : b1, r0 = a0 < b0 ? b0 : a0, r1 = a0 < b0 ? b1 : a1;
                if (r0 <= l1) { WEDGE[0] = l0; WEDGE[1] = l1 > r1 ? l1 : r1; nw = 1; } else { WEDGE[0] = l0; WEDGE[1] = l1; WEDGE[2] = r0; WEDGE[3] = r1; nw = 2; }
            } else if (okA) { WEDGE[0] = a0; WEDGE[1] = a1; nw = 1; } else if (okB) { WEDGE[0] = b0; WEDGE[1] = b1; nw = 1; }
        } else {            // intersection (span <= 180 deg)
            if (!okA || !okB) return 0;
            const l = a0 > b0 ? a0 : b0, h = a1 < b1 ? a1 : b1;
            if (!(l <= h)) return 0;
            WEDGE[0] = l; WEDGE[1] = h; nw = 1;
        }
    }
    let m = 0;
    for (let r = 0; r < nr; r++) {
        for (let w = 0; w < nw; w++) {
            let lo = RING[2 * r] > WEDGE[2 * w] ? RING[2 * r] : WEDGE[2 * w];
            let hi = RING[2 * r + 1] < WEDGE[2 * w + 1] ? RING[2 * r + 1] : WEDGE[2 * w + 1];
            if (lo < 0) lo = 0;
            if (hi > 1) hi = 1;
            if (lo <= hi) { out[2 * m] = lo; out[2 * m + 1] = hi; m++; }
        }
    }
    if (m > 1) { sortPairs(out, m); growTP(2 * m); for (let i = 0; i < 2 * m; i++) TP[i] = out[i]; m = mergePairs(TP, m, out); }
    return m;
}

function polygonIntervals(p, px, py, dx, dy, out) {
    const pts = p.pts, n = p.np, E = p.edges, ne = p.ne, e = p.eps, e2 = p.e2;
    const sx0 = (dx < 0 ? px + dx : px) - e, sx1 = (dx < 0 ? px : px + dx) + e;
    const sy0 = (dy < 0 ? py + dy : py) - e, sy1 = (dy < 0 ? py : py + dy) + e;
    // interior pieces: split at edge crossings, keep pieces whose midpoint is inside (even-odd)
    growTS(ne + 2);
    let nt = 0;
    TS[nt++] = 0; TS[nt++] = 1;
    for (let m = 0; m < ne; m++) {
        const o = 7 * m, ax = E[o], ay = E[o + 1], ex = E[o + 2] - ax, ey = E[o + 3] - ay;
        const den = dx * ey - dy * ex;
        if (den === 0) continue;
        const wx = ax - px, wy = ay - py;
        const t = (wx * ey - wy * ex) / den, s = (wx * dy - wy * dx) / den;
        if (s >= -1e-12 && s <= 1 + 1e-12 && t > 0 && t < 1) TS[nt++] = t;
    }
    sortScalars(TS, nt);
    growTP(2 * (nt + ne + 2));
    let np = 0;
    for (let k = 0; k + 1 < nt; k++) {
        const a = TS[k], b = TS[k + 1];
        if (!(b > a)) continue;
        const mid = 0.5 * (a + b);
        if (evenOdd(pts, n, px + mid * dx, py + mid * dy)) { TP[2 * np] = a; TP[2 * np + 1] = b; np++; }
    }
    // boundary capsules
    for (let m = 0; m < ne; m++) {
        const o = 7 * m;
        const ex0 = E[o] < E[o + 2] ? E[o] : E[o + 2], ex1 = E[o] < E[o + 2] ? E[o + 2] : E[o];
        const ey0 = E[o + 1] < E[o + 3] ? E[o + 1] : E[o + 3], ey1 = E[o + 1] < E[o + 3] ? E[o + 3] : E[o + 1];
        if (ex1 < sx0 || ex0 > sx1 || ey1 < sy0 || ey0 > sy1) continue;
        if (capsuleInterval(E, m, px, py, dx, dy, e, e2)) { TP[2 * np] = CR[0]; TP[2 * np + 1] = CR[1]; np++; }
    }
    if (np === 0) return 0;
    sortPairs(TP, np);
    return mergePairs(TP, np, out);
}

function polylineIntervals(p, px, py, dx, dy, out) {
    const E = p.edges, ne = p.ne, e = p.eps, e2 = p.e2;
    const sx0 = (dx < 0 ? px + dx : px) - e, sx1 = (dx < 0 ? px : px + dx) + e;
    const sy0 = (dy < 0 ? py + dy : py) - e, sy1 = (dy < 0 ? py : py + dy) + e;
    growTP(2 * (ne + 1));
    let np = 0;
    for (let m = 0; m < ne; m++) {
        const o = 7 * m;
        const ex0 = E[o] < E[o + 2] ? E[o] : E[o + 2], ex1 = E[o] < E[o + 2] ? E[o + 2] : E[o];
        const ey0 = E[o + 1] < E[o + 3] ? E[o + 1] : E[o + 3], ey1 = E[o + 1] < E[o + 3] ? E[o + 3] : E[o + 1];
        if (ex1 < sx0 || ex0 > sx1 || ey1 < sy0 || ey0 > sy1) continue;
        if (capsuleInterval(E, m, px, py, dx, dy, e, e2)) { TP[2 * np] = CR[0]; TP[2 * np + 1] = CR[1]; np++; }
    }
    if (np === 0) return 0;
    sortPairs(TP, np);
    return mergePairs(TP, np, out);
}

const QS = new Float64Array(4);
function quadricIntervals(p, px, py, dx, dy, out) {
    const d = p.d, A = d[0], B = d[1];
    // clip slab
    let lo = 0, hi = 1;
    if (dx !== 0) {
        let a = (d[6] - px) / dx, b = (d[7] - px) / dx;
        if (a > b) { const t = a; a = b; b = t; }
        if (a > lo) lo = a;
        if (b < hi) hi = b;
    } else if (px < d[6] || px > d[7]) return 0;
    if (dy !== 0) {
        let a = (d[8] - py) / dy, b = (d[9] - py) / dy;
        if (a > b) { const t = a; a = b; b = t; }
        if (a > lo) lo = a;
        if (b < hi) hi = b;
    } else if (py < d[8] || py > d[9]) return 0;
    if (!(lo <= hi)) return 0;
    const X0 = px - d[3], Y0 = py - d[4];
    const qa = A * dx * dx + B * dy * dy, qb = 2 * (A * X0 * dx + B * Y0 * dy), qc = A * X0 * X0 + B * Y0 * Y0 - d[2] + d[5];
    let ns = 0;   // solution set {g >= 0} as pairs in QS
    const scale = (Math.abs(A) + Math.abs(B)) * (dx * dx + dy * dy);
    if (Math.abs(qa) <= 1e-14 * scale) {
        if (qb > 0) { QS[0] = -qc / qb; QS[1] = Infinity; ns = 1; } else if (qb < 0) { QS[0] = -Infinity; QS[1] = -qc / qb; ns = 1; } else if (qc >= 0) { QS[0] = -Infinity; QS[1] = Infinity; ns = 1; }
    } else {
        const disc = qb * qb - 4 * qa * qc;
        if (disc <= 0) {
            if (qa > 0) { QS[0] = -Infinity; QS[1] = Infinity; ns = 1; } else if (disc === 0) { const r = -qb / (2 * qa); QS[0] = r; QS[1] = r; ns = 1; }
        } else {
            const sq = Math.sqrt(disc);
            const q = qb >= 0 ? -0.5 * (qb + sq) : -0.5 * (qb - sq);
            let r1 = q / qa, r2 = q !== 0 ? qc / q : r1;
            if (r1 > r2) { const t = r1; r1 = r2; r2 = t; }
            if (qa > 0) { QS[0] = -Infinity; QS[1] = r1; QS[2] = r2; QS[3] = Infinity; ns = 2; } else { QS[0] = r1; QS[1] = r2; ns = 1; }
        }
    }
    let m = 0;
    for (let s = 0; s < ns; s++) {
        const a = QS[2 * s] > lo ? QS[2 * s] : lo, b = QS[2 * s + 1] < hi ? QS[2 * s + 1] : hi;
        if (a <= b) { out[2 * m] = a; out[2 * m + 1] = b; m++; }
    }
    return m;
}

// ---------------------------------------------------------------- composition painter
/**
 * New empty Composition ({ n, t0, t1, cls }) with room for `cap` pieces; compose() grows it as needed.
 * @param {number} [cap]
 * @returns {{n: number, t0: Float64Array, t1: Float64Array, cls: Int32Array}}
 */
export function newComposition(cap = 64) {
    return { n: 0, t0: new Float64Array(cap), t1: new Float64Array(cap), cls: new Int32Array(cap) };
}
function growComp(out, need) {
    if (need <= out.t0.length) return;
    const cap = Math.max(need, 2 * out.t0.length);
    const a = new Float64Array(cap), b = new Float64Array(cap), c = new Int32Array(cap);
    a.set(out.t0.subarray(0, out.n)); b.set(out.t1.subarray(0, out.n)); c.set(out.cls.subarray(0, out.n));
    out.t0 = a; out.t1 = b; out.cls = c;
}
// paint [a, b] with class c (c < 0: erase)
function paint(out, a, b, c) {
    const n = out.n;
    let T0 = out.t0, T1 = out.t1, C = out.cls;
    let lo = 0;
    while (lo < n && T1[lo] < a) lo++;
    let hi = lo;
    while (hi < n && T0[hi] <= b) hi++;
    let keepL = false, keepR = false, l0 = 0, l1 = 0, lc = 0, r0 = 0, r1 = 0, rc = 0;
    if (lo < hi) {
        if (T0[lo] < a) { keepL = true; l0 = T0[lo]; l1 = nextDown(a); lc = C[lo]; }
        if (T1[hi - 1] > b) { keepR = true; r0 = nextUp(b); r1 = T1[hi - 1]; rc = C[hi - 1]; }
    }
    const nNew = (keepL ? 1 : 0) + (c >= 0 ? 1 : 0) + (keepR ? 1 : 0);
    const delta = nNew - (hi - lo);
    if (n + delta > T0.length) { growComp(out, n + delta + 8); T0 = out.t0; T1 = out.t1; C = out.cls; }
    if (delta !== 0 && hi < n) { T0.copyWithin(hi + delta, hi, n); T1.copyWithin(hi + delta, hi, n); C.copyWithin(hi + delta, hi, n); }
    let w = lo;
    if (keepL) { T0[w] = l0; T1[w] = l1; C[w] = lc; w++; }
    if (c >= 0) { T0[w] = a; T1[w] = b; C[w] = c; w++; }
    if (keepR) { T0[w] = r0; T1[w] = r1; C[w] = rc; w++; }
    out.n = n + delta;
}
function mergeSame(out) {
    const n = out.n, T0 = out.t0, T1 = out.t1, C = out.cls;
    if (n < 2) return;
    let w = 0;
    for (let q = 1; q < n; q++) {
        if (C[q] === C[w] && T0[q] <= nextUp(T1[w])) { if (T1[q] > T1[w]) T1[w] = T1[q]; } else { w++; T0[w] = T0[q]; T1[w] = T1[q]; C[w] = C[q]; }
    }
    out.n = w + 1;
}

// ---------------------------------------------------------------- shapes to primitives
function cosSinDeg(deg) {
    const r = ((deg % 360) + 360) % 360;
    const k = Math.round(r / 90);
    if (Math.abs(r - 90 * k) < 1e-12) { const kk = k % 4; return [[1, 0], [0, 1], [-1, 0], [0, -1]][kk]; }
    const a = deg * Math.PI / 180;
    return [Math.cos(a), Math.sin(a)];
}
function makeXf(tr) {
    if (!tr || typeof tr !== 'object') return null;
    const tx = num(tr.translate && tr.translate[0]), ty = num(tr.translate && tr.translate[1]);
    const rot = num(tr.rotate), ax = num(tr.about && tr.about[0]), ay = num(tr.about && tr.about[1]);
    const m = tr.mirror || 'none';
    const sx = (m === 'x' || m === 'xy') ? -1 : 1, sy = (m === 'y' || m === 'xy') ? -1 : 1;
    if (tx === 0 && ty === 0 && rot === 0 && sx === 1 && sy === 1) return null;
    const [c, s] = cosSinDeg(rot);
    const r = ((rot % 360) + 360) % 360, k90 = Math.round(r / 90);
    return { tx, ty, rot, ax, ay, sx, sy, c, s, rot90: Math.abs(r - 90 * k90) < 1e-9, k90: k90 % 4 };
}
function xfPoint(xf, x, y, out2) {
    if (!xf) { out2[0] = x; out2[1] = y; return out2; }
    const u = xf.sx * (x - xf.ax), v = xf.sy * (y - xf.ay);
    out2[0] = xf.ax + xf.c * u - xf.s * v + xf.tx;
    out2[1] = xf.ay + xf.s * u + xf.c * v + xf.ty;
    return out2;
}
function toPts(points) {
    if (!points) return new Float64Array(0);
    if (points instanceof Float64Array) return points.slice();
    if (Array.isArray(points) && points.length && Array.isArray(points[0])) {
        const a = new Float64Array(2 * points.length);
        for (let i = 0; i < points.length; i++) { a[2 * i] = num(points[i][0]); a[2 * i + 1] = num(points[i][1]); }
        return a;
    }
    const a = new Float64Array(points.length - (points.length & 1));
    for (let i = 0; i < a.length; i++) a[i] = num(points[i]);
    return a;
}

/**
 * Compile the resolved project's shapes into primitives (CSG order) with a bucket index.
 * @param {object} resolved resolved project (numbers everywhere)
 * @returns {object} Geometry
 */
export function compileGeometry(resolved) {
    const dom = (resolved && resolved.domain) || {};
    const type = dom.type === 'cyl2d' ? 'cyl2d' : 'planar2d';
    const cyl = type === 'cyl2d';
    const h = num(dom.h, num(dom.cell, 1)) || 1;
    const eps = 1e-9 * h, e2 = eps * eps;
    const electrodes = (resolved && resolved.electrodes) || [];
    const nElectrodes = Math.max(1, electrodes.length);
    const idMap = new Map();
    for (let i = 0; i < electrodes.length; i++) if (electrodes[i] && electrodes[i].id !== undefined) idMap.set(electrodes[i].id, typeof electrodes[i].index === 'number' ? electrodes[i].index : i);
    const transparent = new Uint8Array(nElectrodes);
    for (let i = 0; i < electrodes.length; i++) {
        const e = electrodes[i] || {};
        transparent[i] = (e.transparent === true || (e.transparent === undefined && e.kind === 'grid')) ? 1 : 0;
    }
    const mirror = dom.mirror || {};
    const mirrorY = !cyl && !!mirror.y;
    const X0 = Array.isArray(dom.x) ? num(dom.x[0]) : 0;
    const Y0 = cyl ? 0 : (Array.isArray(dom.y) ? num(dom.y[0]) : 0);
    const X1 = typeof dom.nx === 'number' ? X0 + (dom.nx - 1) * h : (Array.isArray(dom.x) ? num(dom.x[1], X0) : X0);
    const Y1 = typeof dom.ny === 'number' ? Y0 + (dom.ny - 1) * h : (Array.isArray(dom.y) ? num(dom.y[1], Y0) : Y0);

    const prims = [];
    const compileIssues = [];
    const shapes = (resolved && resolved.shapes) || [];
    const P2 = [0, 0];

    function finish(p) {
        p.contains = (x, y) => containsOf(p, x, y);
        p.intervals = (px, py, dx, dy, out) => intervalsOf(p, px, py, dx, dy, out);
        prims.push(p);
        return p;
    }
    function base(k, electrode, si, shape) {
        return { kind: KIND[k], k, electrode, shape: si, shapeId: shape && shape.id !== undefined ? shape.id : null, bbox: null, params: null,
            d: null, pts: null, np: 0, edges: null, ne: 0, eps, e2, bx0: 0, by0: 0, bx1: 0, by1: 0, contains: null, intervals: null };
    }
    function setBox(p, x0, y0, x1, y1) {
        p.bbox = { x0, y0, x1, y1 };
        p.bx0 = x0 - eps; p.by0 = y0 - eps; p.bx1 = x1 + eps; p.by1 = y1 + eps;
    }
    function addRect(el, si, shape, xf, x0, x1, y0, y1) {
        if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
        if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }
        if (xf && !xf.rot90) {
            const pts = new Float64Array(8);
            const cs = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
            for (let i = 0; i < 4; i++) { xfPoint(xf, cs[i][0], cs[i][1], P2); pts[2 * i] = P2[0]; pts[2 * i + 1] = P2[1]; }
            return addPoly(el, si, shape, null, pts, true);
        }
        if (xf) {
            xfPoint(xf, x0, y0, P2); const ax = P2[0], ay = P2[1];
            xfPoint(xf, x1, y1, P2); const bx = P2[0], by = P2[1];
            x0 = Math.min(ax, bx); x1 = Math.max(ax, bx); y0 = Math.min(ay, by); y1 = Math.max(ay, by);
        }
        const p = base(KR, el, si, shape);
        p.params = { x0, x1, y0, y1 };
        p.d = new Float64Array([x0 - eps, x1 + eps, y0 - eps, y1 + eps]);
        setBox(p, x0, y0, x1, y1);
        return finish(p);
    }
    function addCircle(el, si, shape, xf, cx, cy, r) {
        r = Math.abs(r);
        if (xf) { xfPoint(xf, cx, cy, P2); cx = P2[0]; cy = P2[1]; }
        const p = base(KC, el, si, shape);
        p.params = { cx, cy, r };
        p.d = new Float64Array([cx, cy, r, (r + eps) * (r + eps)]);
        setBox(p, cx - r, cy - r, cx + r, cy + r);
        return finish(p);
    }
    function addAnnulus(el, si, shape, xf, cx, cy, rIn, rOut, a0, a1) {
        rIn = Math.abs(rIn); rOut = Math.abs(rOut);
        if (rIn > rOut) { const t = rIn; rIn = rOut; rOut = t; }
        let span = a1 - a0;
        const full = span >= 360 - 1e-12;
        if (xf) {
            xfPoint(xf, cx, cy, P2); cx = P2[0]; cy = P2[1];
            if (xf.sx === -1 && xf.sy === 1) { const b0 = 180 - a1, b1 = 180 - a0; a0 = b0; a1 = b1; }
            else if (xf.sx === 1 && xf.sy === -1) { const b0 = -a1, b1 = -a0; a0 = b0; a1 = b1; }
            else if (xf.sx === -1 && xf.sy === -1) { a0 += 180; a1 += 180; }
            a0 += xf.rot; a1 += xf.rot;
        }
        span = a1 - a0;
        while (span <= 0) span += 360;
        const isFull = full || span >= 360 - 1e-12;
        const [u0x, u0y] = cosSinDeg(a0), [u1x, u1y] = cosSinDeg(a0 + span);
        const p = base(KA, el, si, shape);
        p.params = { cx, cy, rIn, rOut, a0, a1: a0 + (isFull ? 360 : span) };
        const rin = rIn - eps;
        p.d = new Float64Array([cx, cy, rin > 0 ? rin * rin : -1, (rOut + eps) * (rOut + eps), isFull ? 1 : 0, span > 180 ? 1 : 0, u0x, u0y, u1x, u1y, eps]);
        // bbox: full circle, or the sector's extreme points
        if (isFull) setBox(p, cx - rOut, cy - rOut, cx + rOut, cy + rOut);
        else {
            let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
            const add = (x, y) => { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; };
            for (const r of [rIn, rOut]) { add(cx + r * u0x, cy + r * u0y); add(cx + r * u1x, cy + r * u1y); }
            for (let q = Math.ceil(a0 / 90); 90 * q <= a0 + span; q++) { const [c, s] = cosSinDeg(90 * q); add(cx + rOut * c, cy + rOut * s); }
            setBox(p, bx0, by0, bx1, by1);
        }
        return finish(p);
    }
    function addPoly(el, si, shape, xf, pts, closed) {
        const n = pts.length >> 1;
        if (xf) for (let i = 0; i < n; i++) { xfPoint(xf, pts[2 * i], pts[2 * i + 1], P2); pts[2 * i] = P2[0]; pts[2 * i + 1] = P2[1]; }
        const p = base(closed ? KP : KL, el, si, shape);
        p.pts = pts; p.np = n;
        p.edges = buildEdges(pts, n, closed); p.ne = closed ? n : Math.max(0, n - 1);
        p.params = { points: pts };
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (let i = 0; i < n; i++) {
            const x = pts[2 * i], y = pts[2 * i + 1];
            if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
        }
        if (n === 0) { bx0 = by0 = bx1 = by1 = 0; }
        setBox(p, bx0, by0, bx1, by1);
        return finish(p);
    }
    function addQuadric(el, si, shape, xf, A, B, C, cx, cy, clip) {
        let cx0 = num(clip && clip[0], -1e30), cx1 = num(clip && clip[1], 1e30), cy0 = num(clip && clip[2], -1e30), cy1 = num(clip && clip[3], 1e30);
        if (cx0 > cx1) { const t = cx0; cx0 = cx1; cx1 = t; }
        if (cy0 > cy1) { const t = cy0; cy0 = cy1; cy1 = t; }
        if (xf) {
            if (!xf.rot90) compileIssues.push({ path: `shapes[${si}].transform.rotate`, code: 'W_QUADRIC_ROTATION', message: 'Quadrics accept only 90° rotations; the rotation was rounded to the nearest multiple of 90°.' });
            const k = xf.k90 & 3, rxf = { ...xf, ...(xf.rot90 ? {} : { c: [1, 0, -1, 0][k], s: [0, 1, 0, -1][k] }) };
            xfPoint(rxf, cx, cy, P2); const ncx = P2[0], ncy = P2[1];
            xfPoint(rxf, cx0, cy0, P2); const ax = P2[0], ay = P2[1];
            xfPoint(rxf, cx1, cy1, P2); const bx = P2[0], by = P2[1];
            cx0 = Math.min(ax, bx); cx1 = Math.max(ax, bx); cy0 = Math.min(ay, by); cy1 = Math.max(ay, by);
            cx = ncx; cy = ncy;
            if (k === 1 || k === 3) { const t = A; A = B; B = t; }
        }
        const p = base(KQ, el, si, shape);
        const mAB = Math.max(Math.abs(A), Math.abs(B));
        const epsQ = 2 * eps * Math.sqrt(mAB * Math.abs(C)) + eps * eps * mAB;
        p.params = { A, B, C, cx, cy, clip: [cx0, cx1, cy0, cy1] };
        p.d = new Float64Array([A, B, C, cx, cy, epsQ, cx0 - eps, cx1 + eps, cy0 - eps, cy1 + eps]);
        let bx0 = cx0, bx1 = cx1, by0 = cy0, by1 = cy1;
        if (A < 0 && B < 0 && C < 0) {   // bounded: |A|X^2 + |B|Y^2 <= -C
            const ex = Math.sqrt(-C / -A), ey = Math.sqrt(-C / -B);
            bx0 = Math.max(bx0, cx - ex); bx1 = Math.min(bx1, cx + ex); by0 = Math.max(by0, cy - ey); by1 = Math.min(by1, cy + ey);
        }
        if (bx0 > bx1 || by0 > by1) { bx0 = bx1 = cx0; by0 = by1 = cy0; }
        setBox(p, bx0, by0, bx1, by1);
        return finish(p);
    }

    for (let si = 0; si < shapes.length; si++) {
        const s = shapes[si];
        if (!s || s.enabled === false) continue;
        let el;
        if (typeof s.electrodeIndex === 'number') el = s.electrodeIndex;
        else if (s.electrode === null || s.electrode === undefined) el = -1;
        else if (typeof s.electrode === 'number') el = s.electrode;
        else {
            const k = idMap.get(s.electrode);
            if (k === undefined) { compileIssues.push({ path: `shapes[${si}].electrode`, code: 'E_UNKNOWN_ELECTRODE', message: `Unknown electrode "${s.electrode}"; the shape is ignored.` }); continue; }
            el = k;
        }
        if (el >= nElectrodes) { compileIssues.push({ path: `shapes[${si}].electrode`, code: 'E_UNKNOWN_ELECTRODE', message: 'Electrode index out of range; the shape is ignored.' }); continue; }
        const xf = makeXf(s.transform);
        switch (s.type) {
            case 'box': addRect(el, si, s, xf, num(s.x0), num(s.x1), num(s.y0), num(s.y1)); break;
            case 'tube': {
                const x0 = num(s.x0), x1 = num(s.x1), rIn = Math.abs(num(s.rIn)), rOut = Math.abs(num(s.rOut));
                addRect(el, si, s, xf, x0, x1, rIn, rOut);
                if (!cyl && !mirrorY) addRect(el, si, s, xf, x0, x1, -rOut, -rIn);
                break;
            }
            case 'plate': {
                const x = num(s.x), t = Math.abs(num(s.t)), rh = Math.abs(num(s.rHole)), ro = Math.abs(num(s.rOut));
                addRect(el, si, s, xf, x - t / 2, x + t / 2, rh, ro);
                if (!cyl && !mirrorY) addRect(el, si, s, xf, x - t / 2, x + t / 2, -ro, -rh);
                break;
            }
            case 'disc': {
                const x = num(s.x), t = Math.abs(num(s.t)), r = Math.abs(num(s.r));
                addRect(el, si, s, xf, x - t / 2, x + t / 2, (cyl || mirrorY) ? 0 : -r, r);
                break;
            }
            case 'circle': addCircle(el, si, s, xf, num(s.cx), num(s.cy), num(s.r)); break;
            case 'annulus': addAnnulus(el, si, s, xf, num(s.cx), num(s.cy), num(s.rIn), num(s.rOut), num(s.a0, 0), num(s.a1, 360)); break;
            case 'polygon': { const pts = toPts(s.points); if (pts.length >= 6) addPoly(el, si, s, xf, pts, true); else compileIssues.push({ path: `shapes[${si}].points`, code: 'E_BAD_SHAPE', message: 'A polygon needs at least 3 points.' }); break; }
            case 'polyline': { const pts = toPts(s.points); if (pts.length >= 4) addPoly(el, si, s, xf, pts, false); else compileIssues.push({ path: `shapes[${si}].points`, code: 'E_BAD_SHAPE', message: 'A line needs at least 2 points.' }); break; }
            case 'quadric': addQuadric(el, si, s, xf, num(s.A), num(s.B), num(s.C), num(s.cx), num(s.cy), s.clip); break;
            default: compileIssues.push({ path: `shapes[${si}].type`, code: 'E_UNSUPPORTED', message: `Unknown shape type "${s.type}".` });
        }
    }
    return makeGeometryObject({ type, cyl, h, eps, nElectrodes, transparent, prims, compileIssues, dom: { x0: X0, x1: X1, y0: Y0, y1: Y1 }, mirror: { x: !!mirror.x, y: mirrorY } });
}

// ---------------------------------------------------------------- geometry object
function makeGeometryObject({ type, cyl, h, eps, nElectrodes, transparent, prims, compileIssues, dom, mirror }) {
    const n = prims.length;
    let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
    for (const p of prims) { gx0 = Math.min(gx0, p.bbox.x0); gy0 = Math.min(gy0, p.bbox.y0); gx1 = Math.max(gx1, p.bbox.x1); gy1 = Math.max(gy1, p.bbox.y1); }
    if (n === 0) { gx0 = dom.x0; gx1 = dom.x1; gy0 = dom.y0; gy1 = dom.y1; }
    const bbox = { x0: gx0, y0: gy0, x1: gx1, y1: gy1 };
    const ALL = new Int32Array(n);
    for (let i = 0; i < n; i++) ALL[i] = i;

    // bucket index over the domain
    let IX0 = dom.x0, IX1 = dom.x1, IY0 = dom.y0, IY1 = dom.y1;
    if (!(IX1 > IX0)) { IX0 = gx0; IX1 = gx1; }
    if (!(IY1 > IY0)) { IY0 = gy0; IY1 = gy1; }
    if (!(IX1 > IX0) || !Number.isFinite(IX0) || !Number.isFinite(IX1)) { IX0 = -1; IX1 = 1; }
    if (!(IY1 > IY0) || !Number.isFinite(IY0) || !Number.isFinite(IY1)) { IY0 = -1; IY1 = 1; }
    const padX = 1e-6 * (IX1 - IX0), padY = 1e-6 * (IY1 - IY0);
    IX0 -= padX; IX1 += padX; IY0 -= padY; IY1 += padY;
    const nbx = Math.max(1, Math.min(64, Math.ceil((IX1 - IX0) / (8 * h)))), nby = Math.max(1, Math.min(64, Math.ceil((IY1 - IY0) / (8 * h))));
    const bw = (IX1 - IX0) / nbx, bh = (IY1 - IY0) / nby;
    const lists = [];
    for (let b = 0; b < nbx * nby; b++) lists.push([]);
    for (let q = 0; q < n; q++) {
        const p = prims[q];
        if (p.bx1 < IX0 || p.bx0 > IX1 || p.by1 < IY0 || p.by0 > IY1) continue;
        const i0 = Math.max(0, Math.floor((p.bx0 - IX0) / bw)), i1 = Math.min(nbx - 1, Math.floor((p.bx1 - IX0) / bw));
        const j0 = Math.max(0, Math.floor((p.by0 - IY0) / bh)), j1 = Math.min(nby - 1, Math.floor((p.by1 - IY0) / bh));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) lists[j * nbx + i].push(q);
    }
    const buckets = lists.map((l) => Int32Array.from(l));
    const stamp = new Int32Array(n);
    let gen = 0;
    let LIST = new Int32Array(Math.max(16, n));
    const SCR = newComposition(64);
    const SCR2 = newComposition(64);

    // candidate primitives whose bboxes meet box [x0, x1] x [y0, y1]; result in LIST, returns count (CSG order)
    function gather(x0, y0, x1, y1) {
        if (x0 < IX0 || x1 > IX1 || y0 < IY0 || y1 > IY1) {
            let m = 0;
            for (let q = 0; q < n; q++) { const p = prims[q]; if (p.bx1 < x0 || p.bx0 > x1 || p.by1 < y0 || p.by0 > y1) continue; LIST[m++] = q; }
            return m;
        }
        const i0 = Math.max(0, Math.floor((x0 - IX0) / bw)), i1 = Math.min(nbx - 1, Math.floor((x1 - IX0) / bw));
        const j0 = Math.max(0, Math.floor((y0 - IY0) / bh)), j1 = Math.min(nby - 1, Math.floor((y1 - IY0) / bh));
        if (i0 === i1 && j0 === j1) {
            const L = buckets[j0 * nbx + i0];
            let m = 0;
            for (let r = 0; r < L.length; r++) { const p = prims[L[r]]; if (p.bx1 < x0 || p.bx0 > x1 || p.by1 < y0 || p.by0 > y1) continue; LIST[m++] = L[r]; }
            return m;
        }
        gen++;
        if (gen > 0x3fffffff) { stamp.fill(0); gen = 1; }
        let m = 0;
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
            const L = buckets[j * nbx + i];
            for (let r = 0; r < L.length; r++) {
                const q = L[r];
                if (stamp[q] === gen) continue;
                stamp[q] = gen;
                const p = prims[q];
                if (p.bx1 < x0 || p.bx0 > x1 || p.by1 < y0 || p.by0 > y1) continue;
                LIST[m++] = q;
            }
        }
        sortScalarsInt(LIST, m);
        return m;
    }

    function composeAmong(list, nList, px, py, dx, dy, out) {
        out.n = 0;
        const sx0 = dx < 0 ? px + dx : px, sx1 = dx < 0 ? px : px + dx, sy0 = dy < 0 ? py + dy : py, sy1 = dy < 0 ? py : py + dy;
        for (let q = 0; q < nList; q++) {
            const p = prims[list[q]];
            if (p.bx1 < sx0 || p.bx0 > sx1 || p.by1 < sy0 || p.by0 > sy1) continue;
            if (2 * (p.ne + 4) > IV.length) growIV(2 * (p.ne + 4));
            const m = intervalsOf(p, px, py, dx, dy, IV);
            for (let r = 0; r < m; r++) paint(out, IV[2 * r], IV[2 * r + 1], p.electrode);
        }
        mergeSame(out);
        return out;
    }
    function compose(px, py, dx, dy, out) {
        if (!out) out = newComposition(16);
        const m = gather(Math.min(px, px + dx), Math.min(py, py + dy), Math.max(px, px + dx), Math.max(py, py + dy));
        return composeAmong(LIST, m, px, py, dx, dy, out);
    }
    function classify(x, y) {
        let L = ALL, m = n;
        if (x >= IX0 && x <= IX1 && y >= IY0 && y <= IY1) {
            const i = Math.min(nbx - 1, Math.floor((x - IX0) / bw)), j = Math.min(nby - 1, Math.floor((y - IY0) / bh));
            L = buckets[j * nbx + i]; m = L.length;
        }
        for (let q = m - 1; q >= 0; q--) {
            const p = prims[L[q]];
            if (x < p.bx0 || x > p.bx1 || y < p.by0 || y > p.by1) continue;
            if (containsOf(p, x, y)) return p.electrode;
        }
        return -1;
    }
    function firstNonFree(px, py, qx, qy, skipTransparent = false) {
        const c = compose(px, py, qx - px, qy - py, SCR);
        for (let q = 0; q < c.n; q++) {
            const e = c.cls[q];
            if (skipTransparent && transparent[e]) continue;
            const t = c.t0[q] > 0 ? c.t0[q] : 0;
            return { t, electrode: e, transparent: transparent[e] === 1 };
        }
        return null;
    }
    // true when the segment meets any non-free piece; `list` restricts the candidates (CSG order)
    function segmentBlocked(list, nList, px, py, qx, qy) {
        const dx = qx - px, dy = qy - py;
        let hasVoid = false;
        for (let q = 0; q < nList; q++) if (prims[list[q]].electrode < 0) { hasVoid = true; break; }
        if (!hasVoid) {
            // without voids any painted interval blocks: stop at the first one
            const sx0 = dx < 0 ? qx : px, sx1 = dx < 0 ? px : qx, sy0 = dy < 0 ? qy : py, sy1 = dy < 0 ? py : qy;
            for (let q = 0; q < nList; q++) {
                const p = prims[list[q]];
                if (p.bx1 < sx0 || p.bx0 > sx1 || p.by1 < sy0 || p.by0 > sy1) continue;
                if (2 * (p.ne + 4) > IV.length) growIV(2 * (p.ne + 4));
                if (intervalsOf(p, px, py, dx, dy, IV) > 0) return true;
            }
            return false;
        }
        const c = composeAmong(list, nList, px, py, dx, dy, SCR2);
        return c.n > 0;
    }
    function primsInBox(x0, y0, x1, y1) {
        const m = gather(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1));
        return LIST.slice(0, m);
    }
    function outlines(maxAngleDeg = 0.5) {
        const res = [];
        for (let q = 0; q < n; q++) for (const o of primOutlines(prims[q], maxAngleDeg, dom)) res.push({ prim: q, electrode: prims[q].electrode, closed: o.closed, pts: o.pts });
        return res;
    }
    function sortScalarsInt(a, m) {
        for (let i = 1; i < m; i++) { const v = a[i]; let j = i - 1; while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; } a[j + 1] = v; }
    }
    return {
        type, cyl, h, eps, nElectrodes, transparent, prims, bbox, domain: dom, mirror, issues: compileIssues,
        classify, compose, composeAmong, firstNonFree, segmentBlocked, outlines, primsInBox,
    };
}

// ---------------------------------------------------------------- outlines
function arcPts(cx, cy, r, a0, a1, maxAngleDeg) {
    const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / Math.max(1e-3, maxAngleDeg)) + 1);
    const pts = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
        const a = (a0 + (a1 - a0) * i / (n - 1)) * Math.PI / 180;
        pts[2 * i] = cx + r * Math.cos(a); pts[2 * i + 1] = cy + r * Math.sin(a);
    }
    return pts;
}
function concat(...arrs) {
    let len = 0;
    for (const a of arrs) len += a.length;
    const out = new Float64Array(len);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
}
function reversePts(a) {
    const n = a.length >> 1, out = new Float64Array(a.length);
    for (let i = 0; i < n; i++) { out[2 * i] = a[2 * (n - 1 - i)]; out[2 * i + 1] = a[2 * (n - 1 - i) + 1]; }
    return out;
}
function primOutlines(p, maxAngleDeg, dom) {
    const P = p.params;
    switch (p.k) {
        case KR: return [{ closed: true, pts: new Float64Array([P.x0, P.y0, P.x1, P.y0, P.x1, P.y1, P.x0, P.y1]) }];
        case KC: { const a = arcPts(P.cx, P.cy, P.r, 0, 360, maxAngleDeg); return [{ closed: true, pts: a.subarray(0, a.length - 2).slice() }]; }
        case KA: {
            const outer = arcPts(P.cx, P.cy, P.rOut, P.a0, P.a1, maxAngleDeg);
            if (P.rIn <= 0) {
                if (P.a1 - P.a0 >= 360 - 1e-12) return [{ closed: true, pts: outer.subarray(0, outer.length - 2).slice() }];
                return [{ closed: true, pts: concat(new Float64Array([P.cx, P.cy]), outer) }];
            }
            const inner = reversePts(arcPts(P.cx, P.cy, P.rIn, P.a0, P.a1, maxAngleDeg));
            return [{ closed: true, pts: concat(outer, inner) }];
        }
        case KP: return [{ closed: true, pts: p.pts.slice() }];
        case KL: return [{ closed: false, pts: p.pts.slice() }];
        case KQ: return quadricOutlines(p, dom);
        default: return [];
    }
}
// y-intervals of {g >= 0} at abscissa x inside the clip box [cx0, cx1, cy0, cy1]; returns pairs array
function quadricColumn(P, clip, x) {
    const [cx0, cx1, cy0, cy1] = clip;
    if (x < cx0 || x > cx1) return [];
    const X = x - P.cx, s = P.C - P.A * X * X;    // need B Y^2 >= s
    const res = [];
    const push = (a, b) => { const lo = Math.max(a, cy0), hi = Math.min(b, cy1); if (lo <= hi) res.push(lo, hi); };
    if (P.B > 0) {
        if (s <= 0) push(cy0, cy1);
        else { const w = Math.sqrt(s / P.B); push(cy0, P.cy - w); push(P.cy + w, cy1); }
    } else if (P.B < 0) {
        if (s <= 0) { const w = Math.sqrt(s / P.B); push(P.cy - w, P.cy + w); }
    } else if (s <= 0) push(cy0, cy1);
    return res;
}
function quadricOutlines(p, dom) {
    const P = p.params;
    // an unclipped quadric is drawn inside the domain (grown by 5%)
    const mx = dom ? 0.05 * Math.max(dom.x1 - dom.x0, dom.y1 - dom.y0) : 0;
    const clip = dom ? [Math.max(P.clip[0], dom.x0 - mx), Math.min(P.clip[1], dom.x1 + mx), Math.max(P.clip[2], dom.y0 - mx), Math.min(P.clip[3], dom.y1 + mx)] : P.clip;
    const [cx0, cx1, cy0, cy1] = clip;
    if (!(cx1 > cx0) || !(cy1 > cy0) || !Number.isFinite(cx0) || !Number.isFinite(cx1) || !Number.isFinite(cy0) || !Number.isFinite(cy1)) return [];
    const tolY = (cy1 - cy0) / 400;
    const xs = [], cols = [];
    const sample = (x) => quadricColumn(P, clip, x);
    function rec(xa, ca, xb, cb, depth) {
        let split = ca.length !== cb.length;
        if (!split) for (let i = 0; i < ca.length; i++) if (Math.abs(ca[i] - cb[i]) > tolY) { split = true; break; }
        if (split && depth < 14 && xb - xa > (cx1 - cx0) * 1e-6) {
            const xm = 0.5 * (xa + xb), cm = sample(xm);
            rec(xa, ca, xm, cm, depth + 1);
            xs.push(xm); cols.push(cm);
            rec(xm, cm, xb, cb, depth + 1);
        }
    }
    const N0 = 64;
    let xa = cx0, ca = sample(cx0);
    xs.push(xa); cols.push(ca);
    for (let k = 1; k <= N0; k++) {
        const xb = cx0 + (cx1 - cx0) * k / N0, cb = sample(xb);
        rec(xa, ca, xb, cb, 0);
        xs.push(xb); cols.push(cb);
        xa = xb; ca = cb;
    }
    // bands: runs of equal interval count
    const out = [];
    let k0 = 0;
    for (let k = 1; k <= xs.length; k++) {
        if (k < xs.length && cols[k].length === cols[k0].length) continue;
        const cnt = cols[k0].length >> 1;
        if (k - k0 >= 2) for (let b = 0; b < cnt; b++) {
            const pts = [];
            for (let q = k0; q < k; q++) pts.push(xs[q], cols[q][2 * b]);
            for (let q = k - 1; q >= k0; q--) pts.push(xs[q], cols[q][2 * b + 1]);
            out.push({ closed: true, pts: Float64Array.from(pts) });
        }
        k0 = k;
    }
    return out;
}

// ---------------------------------------------------------------- apertures
/** Accuracy advice for apertures resolved by few cells (measured: thin walls 1e-3 at 20 cells, 2e-4 at 40; sharp corners converge as h^(4/3)). */
export const APERTURE_ADVICE = 'lens results may be off by more than 1e-3. For thin-walled electrodes use ≥ 20 cells across the radius for about 1e-3 '
    + '(40 for about 2e-4, 80 for 1e-4); sharp electrode corners converge more slowly. The Accuracy check measures your geometry.';

/**
 * Hole radii of the apertures in a geometry (shared by the W_APERTURE_RES warning and the Domain tab): plate holes, tube bores,
 * untransformed cylindrical boxes off the axis, and any other non-void primitive (polyline, polygon, annulus, circle, transformed
 * box) that lies wholly off the axis (planar: wholly on one side of y = 0) and is no longer in x than its distance from the axis;
 * that distance (a polyline's smallest ρ) is the hole radius (planar: the half-gap of the slit).
 * @param {object} geometry compiled geometry @param {object} resolved resolved project
 * @returns {Array<{ shape: number, shapeId: string|null, key: string, r: number }>} one entry per shape (its smallest radius)
 */
export function apertureRadii(geometry, resolved) {
    const shapes = (resolved && resolved.shapes) || [];
    const cyl = geometry ? geometry.cyl : !!(resolved && resolved.domain && resolved.domain.type === 'cyl2d');
    const eps = geometry ? geometry.eps : 1e-9;
    const best = new Map();
    const put = (si, key, r) => {
        if (!(r > eps)) return;
        const old = best.get(si);
        if (!old || r < old.r) best.set(si, { shape: si, shapeId: shapes[si] && shapes[si].id !== undefined ? shapes[si].id : null, key, r });
    };
    const handled = new Set();
    for (let si = 0; si < shapes.length; si++) {
        const s = shapes[si];
        if (!s || s.enabled === false || s.electrode === null) continue;
        if (s.type === 'plate') { put(si, 'rHole', Math.abs(num(s.rHole))); handled.add(si); }
        else if (s.type === 'tube') { put(si, 'rIn', Math.abs(num(s.rIn))); handled.add(si); }
        else if (cyl && s.type === 'box' && !s.transform) { put(si, 'y0', Math.min(Math.abs(num(s.y0)), Math.abs(num(s.y1)))); handled.add(si); }
    }
    for (const p of (geometry && geometry.prims) || []) {
        if (p.electrode < 0 || p.k === KQ || handled.has(p.shape)) continue;
        const b = p.bbox, len = b.x1 - b.x0;
        let r = NaN;
        if (b.y0 > eps) r = b.y0;
        else if (!cyl && b.y1 < -eps) r = -b.y1;
        if (r > 0 && len <= r) put(p.shape, '', r);
    }
    return [...best.values()].sort((a, b) => a.shape - b.shape);
}

// ---------------------------------------------------------------- warnings
/**
 * Geometry warnings (spec 3.2(7)); clickable paths into the project.
 * @param {object} geometry compiled geometry
 * @param {object} resolved resolved project
 * @param {object|null} raster0 optional level-0 raster (for W_SHORT and empty electrodes)
 * @returns {Array<{path: string, code: string, message: string}>}
 */
export function geometryWarnings(geometry, resolved, raster0 = null) {
    const issues = [];
    const dom = (resolved && resolved.domain) || {};
    const h = num(dom.h, num(dom.cell, geometry.h));
    const D = geometry.domain;
    const cyl = geometry.cyl;
    const shapes = (resolved && resolved.shapes) || [];
    const prims = geometry.prims;
    const seen = new Set();
    const once = (key, issue) => { if (seen.has(key)) return; seen.add(key); issues.push(issue); };
    const sp = (p) => `shapes[${p.shape}]`;
    for (const iss of geometry.issues || []) issues.push(iss);

    // extents
    if (Array.isArray(dom.x) && Array.isArray(dom.y) && h > 0) {
        const fx = (num(dom.x[1]) - num(dom.x[0])) / h, fy = (num(dom.y[1]) - num(dom.y[0])) / h;
        if (Math.abs(fx - Math.round(fx)) > 1e-6) once('ext.x', { path: 'domain.x', code: 'W_EXTENT_ROUNDED', message: `The x extent is not a whole number of cells; the far edge moves to x = ${(num(dom.x[0]) + Math.round(fx) * h).toPrecision(8)}.` });
        if (Math.abs(fy - Math.round(fy)) > 1e-6) once('ext.y', { path: 'domain.y', code: 'W_EXTENT_ROUNDED', message: `The y extent is not a whole number of cells; the far edge moves to y = ${(num(dom.y[0]) + Math.round(fy) * h).toPrecision(8)}.` });
    }
    const mir = geometry.mirror || {};
    for (let q = 0; q < prims.length; q++) {
        const p = prims[q], b = p.bbox, path = sp(p);
        // sub-cell and thin features
        const w = b.x1 - b.x0, hh = b.y1 - b.y0;
        if (p.k !== KL) {
            const i0 = Math.floor((b.x0 - D.x0) / h), i1 = Math.floor((b.x1 - D.x0) / h), j0 = Math.floor((b.y0 - D.y0) / h), j1 = Math.floor((b.y1 - D.y0) / h);
            if (i0 === i1 && j0 === j1 && w > 0 && hh > 0) once('sub' + p.shape, { path, code: 'W_SUBCELL', message: 'This shape lies inside one cell; it is resolved only by the sub-cell boundary method.' });
            let thick = Math.min(w, hh);
            if (p.k === KA) thick = p.params.rOut - p.params.rIn;
            else if (p.k === KC) thick = 2 * p.params.r;
            else if (p.k === KP) {
                let area = 0, per = 0;
                for (let i = 0, j = p.np - 1; i < p.np; j = i++) { area += p.pts[2 * j] * p.pts[2 * i + 1] - p.pts[2 * i] * p.pts[2 * j + 1]; per += Math.hypot(p.pts[2 * i] - p.pts[2 * j], p.pts[2 * i + 1] - p.pts[2 * j + 1]); }
                thick = per > 0 ? Math.min(thick, 2 * Math.abs(area / 2) / per) : 0;
            }
            if (thick < 0.5 * h && p.electrode >= 0) once('thin' + p.shape, { path, code: 'W_THIN', message: `A feature is ${(thick / h).toFixed(2)} cells thick (< 0.5 cell); fields near it depend on the sub-cell boundary method.` });
        }
        // outside the domain
        const tol = 0.5 * h;
        const outX = b.x1 < D.x0 - tol || b.x0 > D.x1 + tol, outY = b.y1 < D.y0 - tol || b.y0 > D.y1 + tol;
        if (outX || outY) once('out' + p.shape, { path, code: 'W_OUTSIDE', message: 'This shape lies outside the domain: it has no field and no hits.' });
        else if ((b.x0 < D.x0 - tol && !mir.x) || b.x1 > D.x1 + tol || (!cyl && !mir.y && b.y0 < D.y0 - tol) || b.y1 > D.y1 + tol) once('out' + p.shape, { path, code: 'W_OUTSIDE', message: 'Part of this shape lies outside the domain; that part has no field and no hits.' });
        if (cyl && b.y0 < -geometry.eps) once('axis' + p.shape, { path, code: 'W_CLIPPED_AXIS', message: 'Part of this shape lies below the axis (r < 0); it is clipped.' });
        // crossing edges
        if (p.k === KP && polygonSelfIntersects(p.pts, p.np)) once('cross' + p.shape, { path: path + '.points', code: 'W_SELF_INTERSECT', message: 'The polygon crosses itself; its inside follows the even-odd rule.' });
    }
    // aperture resolution
    for (const a of apertureRadii(geometry, resolved)) {
        if (a.r < 16 * h) once('ap' + a.shape, { path: `shapes[${a.shape}]${a.key ? '.' + a.key : ''}`, code: 'W_APERTURE_RES', message: `The hole radius is ${(a.r / h).toFixed(1)} cells: ${APERTURE_ADVICE}` });
    }
    // electrodes without shapes or edges
    const electrodes = (resolved && resolved.electrodes) || [];
    const used = new Uint8Array(Math.max(1, electrodes.length));
    for (const p of prims) if (p.electrode >= 0 && p.electrode < used.length) used[p.electrode] = 1;
    const edges = dom.edges || {};
    const idx = (e) => {
        if (typeof e === 'number') return e;
        for (let i = 0; i < electrodes.length; i++) if (electrodes[i] && electrodes[i].id === e) return i;
        return -1;
    };
    for (const key of ['xmin', 'xmax', 'ymin', 'ymax']) {
        const ed = edges[key];
        if (!ed) continue;
        if (ed.electrodeIndex !== undefined) { const k = idx(ed.electrodeIndex); if (k >= 0) used[k] = 1; }
        if (ed.electrode !== undefined) { const k = idx(ed.electrode); if (k >= 0) used[k] = 1; }
        for (const sg of ed.segments || []) {
            for (const f of ['electrode', 'electrodeIndex']) if (sg[f] !== undefined) { const k = idx(sg[f]); if (k >= 0) used[k] = 1; }
            for (const f of ['ramp', 'rampIndex']) if (Array.isArray(sg[f])) for (const r of sg[f]) { const k = idx(r); if (k >= 0) used[k] = 1; }
        }
    }
    for (let i = 1; i < electrodes.length; i++) {
        if (!used[i]) once('empty' + i, { path: `electrodes[${i}]`, code: 'W_EMPTY_ELECTRODE', message: `Electrode "${(electrodes[i] && (electrodes[i].name || electrodes[i].id)) || i}" has no shapes or edges; it has no effect.` });
    }
    // buried shapes: sample the shape and look for a point where it is the last containing primitive
    const byShape = new Map();
    for (let q = 0; q < prims.length; q++) { const s = prims[q].shape; if (!byShape.has(s)) byShape.set(s, []); byShape.get(s).push(q); }
    for (const [si, qs] of byShape) {
        let visible = false, tested = 0;
        for (const q of qs) {
            const p = prims[q];
            for (const [x, y] of samplePrim(p, 6)) {
                tested++;
                if (lastContaining(geometry, x, y) === q) { visible = true; break; }
            }
            if (visible) break;
        }
        if (!visible && tested > 0) once('buried' + si, { path: `shapes[${si}]`, code: 'W_BURIED', message: 'This shape is hidden by later shapes ("later shapes win"); it has no effect.' });
    }
    // shorts between electrodes (needs node classes)
    if (raster0 && raster0.cls) for (const iss of shortIssues(raster0, electrodes)) issues.push(iss);
    if (raster0 && raster0.stats && Array.isArray(raster0.stats.issues)) for (const iss of raster0.stats.issues) if (iss.code !== 'W_SHORT') issues.push(iss);
    return issues;
}
function lastContaining(geometry, x, y) {
    const prims = geometry.prims, list = geometry.primsInBox(x, y, x, y);
    for (let r = list.length - 1; r >= 0; r--) {
        const q = list[r], p = prims[q];
        if (x < p.bx0 || x > p.bx1 || y < p.by0 || y > p.by1) continue;
        if (containsOf(p, x, y)) return q;
    }
    return -1;
}
function samplePrim(p, m) {
    const out = [];
    if (p.k === KL) {
        for (let e = 0; e < p.ne; e++) for (let k = 0; k <= m; k++) { const o = 7 * e, f = k / m; out.push([p.edges[o] + f * (p.edges[o + 2] - p.edges[o]), p.edges[o + 1] + f * (p.edges[o + 3] - p.edges[o + 1])]); }
        return out;
    }
    const b = p.bbox;
    for (let j = 0; j <= m; j++) for (let i = 0; i <= m; i++) {
        const x = b.x0 + (b.x1 - b.x0) * (i + 0.5) / (m + 1), y = b.y0 + (b.y1 - b.y0) * (j + 0.5) / (m + 1);
        if (containsOf(p, x, y)) out.push([x, y]);
    }
    if (!out.length) { const x = 0.5 * (b.x0 + b.x1), y = 0.5 * (b.y0 + b.y1); if (containsOf(p, x, y)) out.push([x, y]); }
    return out;
}
function polygonSelfIntersects(pts, n) {
    if (n < 4) return false;
    const seg = (i) => [pts[2 * i], pts[2 * i + 1], pts[2 * ((i + 1) % n)], pts[2 * ((i + 1) % n) + 1]];
    const orient = (ax, ay, bx, by, cx, cy) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    for (let i = 0; i < n; i++) {
        const [a1x, a1y, a2x, a2y] = seg(i);
        for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1) continue;
            const [b1x, b1y, b2x, b2y] = seg(j);
            const o1 = orient(a1x, a1y, a2x, a2y, b1x, b1y), o2 = orient(a1x, a1y, a2x, a2y, b2x, b2y);
            const o3 = orient(b1x, b1y, b2x, b2y, a1x, a1y), o4 = orient(b1x, b1y, b2x, b2y, a2x, a2y);
            if (o1 * o2 < 0 && o3 * o4 < 0) return true;
        }
    }
    return false;
}
function shortIssues(r, electrodes) {
    const g = r.grid, nx = g.nx, ny = g.ny, cls = r.cls, flags = r.flags;
    const pairs = new Map();
    const MIXED = 8;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i, a = cls[k];
        if (a < 0 || (flags[k] & MIXED)) continue;
        if (i + 1 < nx) { const b = cls[k + 1]; if (b >= 0 && b !== a && !(flags[k + 1] & MIXED)) pairs.set(Math.min(a, b) * 65536 + Math.max(a, b), true); }
        if (j + 1 < ny) { const b = cls[k + nx]; if (b >= 0 && b !== a && !(flags[k + nx] & MIXED)) pairs.set(Math.min(a, b) * 65536 + Math.max(a, b), true); }
    }
    const out = [];
    const name = (e) => (electrodes[e] && (electrodes[e].name || electrodes[e].id)) || String(e);
    for (const key of pairs.keys()) {
        const a = Math.floor(key / 65536), b = key % 65536;
        out.push({ path: `electrodes[${b}]`, code: 'W_SHORT', message: `Electrodes "${name(a)}" and "${name(b)}" touch (neighboring grid nodes): they short-circuit each other.` });
    }
    return out;
}
