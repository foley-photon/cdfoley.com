/* ==========================================================================
   Ion optics UI: contour.js
   Equipotential lines by marching squares, the two-dimensional form of
   Lorensen & Cline's marching cubes (Computer Graphics 21(4), 163 (1987)):
   linear interpolation of crossings on cell edges, saddle cells resolved by
   the cell-centre average, and segments joined into polylines through their
   shared edges (closed loops are marked closed). Nodes with NaN values (or
   masked nodes) do not contribute; cells touching them are skipped.
   Pure module: no DOM, usable in Node tests.
   ========================================================================== */

// segment tables: for each case (bit 0 = (i,j), 1 = (i+1,j), 2 = (i+1,j+1), 3 = (i,j+1) at or above the level)
// edges: 0 bottom, 1 right, 2 top, 3 left
const CASES = [
    [], [3, 0], [0, 1], [3, 1], [1, 2], null, [0, 2], [3, 2],
    [2, 3], [0, 2], null, [1, 2], [1, 3], [0, 1], [3, 0], [],
];

/**
 * Nice contour levels strictly between vmin and vmax, about n of them, on a round step
 * (1, 2, 2.5 or 5 × 10^k). major[k] is true for every fifth level (multiples of 5 steps).
 * With nice = false: n evenly spaced levels vmin + k(vmax − vmin)/(n + 1).
 * @returns {{ levels: number[], major: boolean[], step: number }}
 */
export function contourLevels(vmin, vmax, n = 20, { nice = true } = {}) {
    const out = { levels: [], major: [], step: 0 };
    if (!(vmax > vmin) || !(n >= 1)) return out;
    const span = vmax - vmin;
    if (!nice) {
        const step = span / (n + 1);
        out.step = step;
        for (let k = 1; k <= n; k++) { out.levels.push(vmin + k * step); out.major.push(k % 5 === 0); }
        return out;
    }
    const raw = span / (n + 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    let best = null;
    for (const m of [0.5, 1, 2, 2.5, 5, 10]) {
        const step = m * mag;
        const k0 = Math.floor(vmin / step) + 1, k1 = Math.ceil(vmax / step) - 1;
        const count = Math.max(0, k1 - k0 + 1);
        const score = Math.abs(count - n) + (count > 2 * n ? 1e9 : 0);
        if (best === null || score < best.score) best = { step, k0, k1, score };
    }
    out.step = best.step;
    for (let k = best.k0; k <= best.k1; k++) {
        const v = parseFloat((k * best.step).toPrecision(12));
        if (v <= vmin || v >= vmax) continue;
        out.levels.push(v);
        out.major.push(k % 5 === 0);
    }
    return out;
}

/**
 * Marching squares for one level.
 * @param {ArrayLike<number>} values node values, index j·nx + i
 * @param {number} nx @param {number} ny
 * @param {number} level
 * @param {{ x0?: number, y0?: number, h?: number, mask?: Uint8Array|null }} [opts] mask[k] = 1 skips node k
 * @returns {Array<{ pts: Float64Array, closed: boolean }>} polylines in world coordinates (x0 + i h, y0 + j h)
 */
export function marchingSquares(values, nx, ny, level, { x0 = 0, y0 = 0, h = 1, mask = null } = {}) {
    // segment store: edge ids and endpoints
    let cap = 1024, nSeg = 0;
    let segE = new Float64Array(2 * cap);     // edge ids (exact integers)
    let segP = new Float64Array(4 * cap);     // x0, y0, x1, y1 in node units
    const grow = () => {
        cap *= 2;
        const e = new Float64Array(2 * cap); e.set(segE); segE = e;
        const p = new Float64Array(4 * cap); p.set(segP); segP = p;
    };
    const c = level;
    for (let j = 0; j < ny - 1; j++) {
        const r0 = j * nx, r1 = r0 + nx;
        for (let i = 0; i < nx - 1; i++) {
            const a = values[r0 + i], b = values[r0 + i + 1], d = values[r1 + i + 1], e = values[r1 + i];
            if (a !== a || b !== b || d !== d || e !== e) continue;
            if (mask !== null && (mask[r0 + i] | mask[r0 + i + 1] | mask[r1 + i + 1] | mask[r1 + i])) continue;
            const idx = (a >= c ? 1 : 0) | (b >= c ? 2 : 0) | (d >= c ? 4 : 0) | (e >= c ? 8 : 0);
            if (idx === 0 || idx === 15) continue;
            let pairs = CASES[idx];
            if (pairs === null) {
                const centre = 0.25 * (a + b + d + e) >= c;
                // case 5: (i,j) and (i+1,j+1) high; case 10: (i+1,j) and (i,j+1) high
                if (idx === 5) pairs = centre ? [3, 2, 0, 1] : [3, 0, 1, 2];
                else pairs = centre ? [0, 3, 1, 2] : [0, 1, 2, 3];
            }
            for (let q = 0; q < pairs.length; q += 2) {
                if (nSeg >= cap) grow();
                for (let s = 0; s < 2; s++) {
                    const ed = pairs[q + s];
                    let px, py, id;
                    if (ed === 0) { const t = (c - a) / (b - a); px = i + (t === t ? t : 0.5); py = j; id = 2 * (r0 + i); }
                    else if (ed === 1) { const t = (c - b) / (d - b); px = i + 1; py = j + (t === t ? t : 0.5); id = 2 * (r0 + i + 1) + 1; }
                    else if (ed === 2) { const t = (c - e) / (d - e); px = i + (t === t ? t : 0.5); py = j + 1; id = 2 * (r1 + i); }
                    else { const t = (c - a) / (e - a); px = i; py = j + (t === t ? t : 0.5); id = 2 * (r0 + i) + 1; }
                    segE[2 * nSeg + s] = id;
                    segP[4 * nSeg + 2 * s] = px; segP[4 * nSeg + 2 * s + 1] = py;
                }
                nSeg++;
            }
        }
    }
    return stitch(segE, segP, nSeg, x0, y0, h);
}

function stitch(segE, segP, nSeg, x0, y0, h) {
    // edge id → up to two segment ends (seg·2 + end)
    const ends = new Map();
    for (let s = 0; s < nSeg; s++) {
        for (let e = 0; e < 2; e++) {
            const id = segE[2 * s + e];
            const v = ends.get(id);
            if (v === undefined) ends.set(id, [2 * s + e]);
            else v.push(2 * s + e);
        }
    }
    const used = new Uint8Array(nSeg);
    const lines = [];
    const other = (endRef, id) => {
        const list = ends.get(id);
        if (!list) return -1;
        for (const r of list) if (r !== endRef && !used[r >> 1]) return r;
        return -1;
    };
    for (let s0 = 0; s0 < nSeg; s0++) {
        if (used[s0]) continue;
        used[s0] = 1;
        // walk forward from end 1 and backward from end 0
        const fwd = [segP[4 * s0 + 2], segP[4 * s0 + 3]];
        const bwd = [];
        let closed = false;
        let curEnd = 2 * s0 + 1;
        for (;;) {
            const id = segE[curEnd];
            const nxt = other(curEnd, id);
            if (nxt < 0) break;
            const sn = nxt >> 1, en = nxt & 1;
            used[sn] = 1;
            const far = en ^ 1;
            fwd.push(segP[4 * sn + 2 * far], segP[4 * sn + 2 * far + 1]);
            curEnd = 2 * sn + far;
        }
        // closed when the forward walk came back to segment s0's start edge
        if (segE[curEnd] === segE[2 * s0] && fwd.length > 4) {
            const list = ends.get(segE[2 * s0]);
            if (list && list.length >= 2) closed = true;
        }
        if (!closed) {
            curEnd = 2 * s0;
            for (;;) {
                const id = segE[curEnd];
                const nxt = other(curEnd, id);
                if (nxt < 0) break;
                const sn = nxt >> 1, en = nxt & 1;
                used[sn] = 1;
                const far = en ^ 1;
                bwd.push(segP[4 * sn + 2 * far + 1], segP[4 * sn + 2 * far]);   // y, x (reversed later)
                curEnd = 2 * sn + far;
            }
        }
        const pts = [];
        for (let k = bwd.length - 2; k >= 0; k -= 2) pts.push(bwd[k + 1], bwd[k]);
        pts.push(segP[4 * s0], segP[4 * s0 + 1]);
        for (let k = 0; k < fwd.length; k += 2) pts.push(fwd[k], fwd[k + 1]);
        if (closed) { pts.length -= 2; }   // the last point repeats the first
        // drop consecutive duplicates and convert to world coordinates
        const out = [];
        let lx = NaN, ly = NaN;
        for (let k = 0; k < pts.length; k += 2) {
            const x = pts[k], y = pts[k + 1];
            if (x === lx && y === ly) continue;
            out.push(x0 + x * h, y0 + y * h);
            lx = x; ly = y;
        }
        if (out.length >= 4) lines.push({ pts: Float64Array.from(out), closed });
    }
    return lines;
}

/**
 * Contours for several levels.
 * @returns {Array<{ level: number, major: boolean, lines: Array<{ pts: Float64Array, closed: boolean }> }>}
 */
export function contourSet(values, nx, ny, levels, opts = {}, major = null) {
    return levels.map((lv, k) => ({ level: lv, major: major ? !!major[k] : false, lines: marchingSquares(values, nx, ny, lv, opts) }));
}

/**
 * Every second node in each direction (for display above about 1M nodes).
 * @returns {{ values: Float64Array, nx: number, ny: number, h: number, mask: Uint8Array|null }}
 */
export function decimate2(values, nx, ny, h = 1, mask = null) {
    const mx = Math.floor((nx - 1) / 2) + 1, my = Math.floor((ny - 1) / 2) + 1;
    const out = new Float64Array(mx * my);
    const m2 = mask ? new Uint8Array(mx * my) : null;
    for (let j = 0; j < my; j++) for (let i = 0; i < mx; i++) {
        out[j * mx + i] = values[2 * j * nx + 2 * i];
        if (m2) m2[j * mx + i] = mask[2 * j * nx + 2 * i];
    }
    return { values: out, nx: mx, ny: my, h: 2 * h, mask: m2 };
}

/** Length of a polyline (for label placement). */
export function polylineLength(pts, closed = false) {
    let L = 0;
    for (let k = 2; k < pts.length; k += 2) L += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
    if (closed && pts.length >= 4) L += Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1]);
    return L;
}

/** Point and direction at arc-length fraction f ∈ [0, 1] of a polyline: { x, y, angle }. */
export function pointAlong(pts, f) {
    const total = polylineLength(pts, false);
    let target = Math.max(0, Math.min(1, f)) * total, acc = 0;
    for (let k = 2; k < pts.length; k += 2) {
        const dx = pts[k] - pts[k - 2], dy = pts[k + 1] - pts[k - 1], L = Math.hypot(dx, dy);
        if (acc + L >= target && L > 0) {
            const t = (target - acc) / L;
            return { x: pts[k - 2] + t * dx, y: pts[k - 1] + t * dy, angle: Math.atan2(dy, dx) };
        }
        acc += L;
    }
    return { x: pts[0], y: pts[1], angle: 0 };
}
