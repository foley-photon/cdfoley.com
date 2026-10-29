/* ==========================================================================
   Ion optics UI: render-surface.js
   The potential-energy surface: the displayed potential, signed by the
   particle polarity (q·φ in eV per unit charge, so wells read as wells),
   drawn over the 2D cross-section as an isometric height map (a relief
   plot of a scalar field over a plane). sampleSurface() thins the solved
   grid to at most MAX_SAMPLES × MAX_SAMPLES nodes and mirrors them across
   the axis or the mirror planes; makeProjector() maps world points to the
   picture plane for an azimuth, an elevation, a relief factor and the
   vertical stretch (the height scale has an optional floor, so a field near
   a zero of its drive is drawn nearly flat instead of at full relief);
   rasterSurface() paints the quads back to front into an ImageData with flat
   Lambert shading and mesh lines on every k-th sample row and column, in
   software (deterministic, no GPU); heightAt() interpolates the surface
   height at a world point so trajectories and replay dots can be draped on
   it. Pure functions: nothing here uses the DOM.
   ========================================================================== */

/** Sample cap per grid direction (the mirrored half is added on top). */
export const MAX_SAMPLES = 200;

/** Light direction in picture space (right-handed: u right, w into the picture, Z up), unit length. */
const LIGHT = normalize3(-0.45, -0.55, 0.72);

function normalize3(x, y, z) { const n = Math.hypot(x, y, z) || 1; return [x / n, y / n, z / n]; }

/**
 * Indices of at most `maxN` samples of 0 … n − 1, always including both ends, evenly stepped in between.
 * @returns {Int32Array}
 */
export function sampleIndices(n, maxN = MAX_SAMPLES) {
    if (n <= 1) return Int32Array.from([0]);
    if (n <= maxN) { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; }
    const step = Math.ceil((n - 1) / (maxN - 1));
    const out = [];
    for (let i = 0; i < n - 1; i += step) out.push(i);
    out.push(n - 1);
    return Int32Array.from(out);
}

/**
 * Thins the displayed potential to a sample grid and mirrors it where the model is symmetric.
 * @param {{ phi: ArrayLike<number>, nx: number, ny: number, x0: number, y0: number, h: number, cls?: ArrayLike<number>|null,
 *   mirrorX?: boolean, mirrorY?: boolean, sign?: number }} src  cls: raster node classes (≥ 0 = fixed to that electrode)
 * @param {number} [maxN]
 * @returns {{ nsx: number, nsy: number, xs: Float64Array, ys: Float64Array, z: Float32Array, owner: Int16Array,
 *   zmin: number, zmax: number, sign: number, half: { nsx: number, nsy: number, xs: Float64Array, ys: Float64Array, z: Float32Array },
 *   mirrorX: boolean, mirrorY: boolean }}
 *   z[j · nsx + i] = sign · φ(xs[i], ys[j]); owner[j · nsx + i] = electrode index of a fixed node, −1 otherwise.
 *   `half` is the unmirrored sample grid (for heightAt).
 */
export function sampleSurface(src, maxN = MAX_SAMPLES) {
    const { phi, nx, ny, x0, y0, h } = src;
    const sign = src.sign < 0 ? -1 : 1;
    const cls = src.cls || null;
    const ix = sampleIndices(nx, maxN), iy = sampleIndices(ny, maxN);
    const hx = ix.length, hy = iy.length;
    const hxs = new Float64Array(hx), hys = new Float64Array(hy), hz = new Float32Array(hx * hy), how = new Int16Array(hx * hy);
    for (let a = 0; a < hx; a++) hxs[a] = x0 + ix[a] * h;
    for (let b = 0; b < hy; b++) hys[b] = y0 + iy[b] * h;
    let zmin = Infinity, zmax = -Infinity;
    for (let b = 0; b < hy; b++) {
        const row = iy[b] * nx;
        for (let a = 0; a < hx; a++) {
            const k = row + ix[a];
            let v = phi[k];
            v = v === v ? sign * v : 0;
            hz[b * hx + a] = v;
            how[b * hx + a] = cls && cls[k] >= 0 ? cls[k] : -1;
            if (v < zmin) zmin = v;
            if (v > zmax) zmax = v;
        }
    }
    if (!(zmin <= zmax)) { zmin = 0; zmax = 0; }
    const half = { nsx: hx, nsy: hy, xs: hxs, ys: hys, z: hz };
    // mirrored copies: the solved half-plane holds y ≥ 0 (and x ≥ 0 for mirror.x); the sample on the plane is shared
    // an anti-mirror plane (oddX/oddY) reflects the geometry too, but the potential changes sign across it
    const mirrorX = !!src.mirrorX, mirrorY = !!src.mirrorY, oddX = !!src.oddX, oddY = !!src.oddY;
    const colMap = mirrorX ? mirrorIndex(hxs) : null, rowMap = mirrorY ? mirrorIndex(hys) : null;
    const nsx = colMap ? colMap.n : hx, nsy = rowMap ? rowMap.n : hy;
    const xs = new Float64Array(nsx), ys = new Float64Array(nsy);
    for (let a = 0; a < nsx; a++) xs[a] = colMap ? colMap.sign[a] * hxs[colMap.idx[a]] : hxs[a];
    for (let b = 0; b < nsy; b++) ys[b] = rowMap ? rowMap.sign[b] * hys[rowMap.idx[b]] : hys[b];
    let z = hz, owner = how;
    if (colMap || rowMap) {
        z = new Float32Array(nsx * nsy); owner = new Int16Array(nsx * nsy);
        for (let b = 0; b < nsy; b++) {
            const sb = rowMap ? rowMap.idx[b] : b;
            const fy = rowMap && oddY && rowMap.sign[b] < 0 ? -1 : 1;
            for (let a = 0; a < nsx; a++) {
                const sa = colMap ? colMap.idx[a] : a;
                const f = colMap && oddX && colMap.sign[a] < 0 ? -fy : fy;
                z[b * nsx + a] = f * hz[sb * hx + sa];
                owner[b * nsx + a] = how[sb * hx + sa];
            }
        }
        if ((oddX && colMap) || (oddY && rowMap)) { const a = Math.max(-zmin, zmax); zmin = -a; zmax = a; }
    }
    return { nsx, nsy, xs, ys, z, owner, zmin, zmax, sign, half, mirrorX, mirrorY, oddX, oddY };
}

/** Sample order of a mirrored axis: −coords reversed (skipping a sample on the plane), then the originals. */
function mirrorIndex(coords) {
    const n0 = coords.length;
    const onPlane = Math.abs(coords[0]) < 1e-12;
    const neg = [];
    for (let k = n0 - 1; k >= (onPlane ? 1 : 0); k--) neg.push(k);
    const idx = new Int32Array(neg.length + n0), sign = new Int8Array(neg.length + n0);
    neg.forEach((k, q) => { idx[q] = k; sign[q] = -1; });
    for (let k = 0; k < n0; k++) { idx[neg.length + k] = k; sign[neg.length + k] = 1; }
    return { n: idx.length, idx, sign };
}

/**
 * Surface height (signed potential energy, eV per e) at a world point by bilinear interpolation of the sample grid;
 * NaN outside the sampled domain. Mirrored models are evaluated at |x| or |y| (with the sign flipped across an anti-mirror plane).
 */
export function heightAt(surf, x, y) {
    const H = surf.half;
    let f = 1;
    if (surf.mirrorX && x < 0) { x = -x; if (surf.oddX) f = -f; }
    if (surf.mirrorY && y < 0) { y = -y; if (surf.oddY) f = -f; }
    const { xs, ys, nsx, nsy, z } = H;
    if (!(x >= xs[0] && x <= xs[nsx - 1] && y >= ys[0] && y <= ys[nsy - 1])) return NaN;
    const i = cellOf(xs, x), j = cellOf(ys, y);
    const tx = xs[i + 1] > xs[i] ? (x - xs[i]) / (xs[i + 1] - xs[i]) : 0;
    const ty = ys[j + 1] > ys[j] ? (y - ys[j]) / (ys[j + 1] - ys[j]) : 0;
    const k = j * nsx + i;
    const z00 = z[k], z10 = z[k + 1], z01 = z[k + nsx], z11 = z[k + nsx + 1];
    return f * ((1 - ty) * ((1 - tx) * z00 + tx * z10) + ty * ((1 - tx) * z01 + tx * z11));
}
/** Index i with coords[i] ≤ v < coords[i + 1] (clamped to the last cell); the coordinates are evenly stepped except the last. */
function cellOf(coords, v) {
    const n = coords.length;
    if (n < 2) return 0;
    const step = coords[1] - coords[0];
    let i = step > 0 ? Math.floor((v - coords[0]) / step) : 0;
    if (i > n - 2) i = n - 2;
    if (i < 0) i = 0;
    while (i > 0 && coords[i] > v) i--;
    while (i < n - 2 && coords[i + 1] <= v) i++;
    return i;
}

/**
 * Projection of world points (x, y in mm; z in eV per e) onto the picture plane (u right, v up, in mm) for an
 * azimuth and an elevation in degrees. `relief` scales the height so that the full range of the surface is
 * 0.3 · relief of the larger domain extent; `aspect` is the view's vertical stretch (y × aspect). `zFloor` (eV per e,
 * default 0) is the smallest range the height scale assumes: pass the potential-energy span the field can reach (for
 * example |q|·the model's vSpan over the RF period), so a surface whose present range is tiny (an RF drive near zero)
 * is drawn nearly flat at that scale instead of being stretched to full relief.
 * @returns {{ project(x, y, z): number[], dirs: { x: number[], y: number[], z: number[] }, zScale: number,
 *   center: number[], bbox(): { u0, u1, v0, v1 }, normal(dx1, dy1, dz1, dx2, dy2, dz2): number }}
 *   dirs are the picture-plane directions of the +x, +y and +z axes (unit world steps). `normal` gives the Lambert
 *   brightness of a facet spanned by two world vectors (used by the raster).
 */
export function makeProjector(surf, { az = -30, el = 35, relief = 1, aspect = 1, zFloor = 0 } = {}) {
    const a = az * Math.PI / 180, e = Math.max(2, Math.min(89, el)) * Math.PI / 180;
    const ca = Math.cos(a), sa = Math.sin(a), ce = Math.cos(e), se = Math.sin(e);
    const xExt = surf.xs[surf.nsx - 1] - surf.xs[0], yExt = (surf.ys[surf.nsy - 1] - surf.ys[0]) * aspect;
    const zRange = Math.max(surf.zmax - surf.zmin, zFloor > 0 && Number.isFinite(zFloor) ? zFloor : 0);
    const L = Math.max(xExt, yExt, 1e-9);
    const zScale = zRange > 0 ? 0.3 * Math.max(0, relief) * L / zRange : 0;
    const xmid = (surf.xs[0] + surf.xs[surf.nsx - 1]) / 2, ymid = (surf.ys[0] + surf.ys[surf.nsy - 1]) / 2, zmid = (surf.zmin + surf.zmax) / 2;
    const ay = aspect;
    function project(x, y, z) {
        const X = x - xmid, Yw = (y - ymid) * ay, Z = (z - zmid) * zScale;
        const xr = X * ca - Yw * sa, yr = X * sa + Yw * ca;
        return [xr, yr * se + Z * ce, yr * ce - Z * se];   // u, v, depth (larger = farther)
    }
    // picture-plane directions of unit world steps
    const dirs = { x: [ca, sa * se], y: [-sa * ay, ca * se * ay], z: [0, ce * zScale] };
    function normal(dx1, dy1, dz1, dx2, dy2, dz2) {
        // facet vectors in rotated space (xr, yr, Z); upward normal; brightness from the fixed light
        const ax = dx1 * ca - dy1 * ay * sa, ayr = dx1 * sa + dy1 * ay * ca, az1 = dz1 * zScale;
        const bx = dx2 * ca - dy2 * ay * sa, byr = dx2 * sa + dy2 * ay * ca, bz = dz2 * zScale;
        let nx = ayr * bz - az1 * byr, ny = az1 * bx - ax * bz, nz = ax * byr - ayr * bx;
        if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const n = Math.hypot(nx, ny, nz) || 1;
        const lam = (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / n;
        return 0.58 + 0.42 * (lam > 0 ? lam : 0);
    }
    function bbox() {
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        const zs = [surf.zmin, surf.zmax];
        for (const x of [surf.xs[0], surf.xs[surf.nsx - 1]]) for (const y of [surf.ys[0], surf.ys[surf.nsy - 1]]) for (const z of zs) {
            const [u, v] = project(x, y, z);
            if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
        }
        return { u0, u1, v0, v1 };
    }
    return { project, dirs, zScale, center: [xmid, ymid, zmid], bbox, normal, az, el, ca, sa, ce, se, aspect: ay };
}

/** Parses '#rgb' or '#rrggbb' into [r, g, b]; null otherwise. */
export function hexRgb(col) {
    if (typeof col !== 'string') return null;
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(col.trim());
    if (!m) return null;
    let s = m[1];
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

/**
 * Paints the surface into `img` (an ImageData, or any { width, height, data: Uint8ClampedArray }).
 * px, py: device-pixel picture coordinates of the nsx · nsy samples (Float32Array, from the projector and the view).
 * opts: { lut: Uint8ClampedArray (768), lo, hi (value → LUT range), projector, electrodeRgb(k) → [r, g, b] | null,
 *        meshEvery (sample rows and columns between mesh lines, 0 = none), alpha (0–255) }
 * Quads are drawn back to front in grid order (rows and columns from far to near), each flat-shaded with the Lambert
 * brightness of its facet; quads whose four corners are fixed to one electrode take that electrode's colour.
 * @returns {{ quads: number, pixels: number }}
 */
export function rasterSurface(surf, px, py, img, opts) {
    const { nsx, nsy, z, owner, xs, ys } = surf;
    const { lut, lo, hi, projector } = opts;
    const meshEvery = opts.meshEvery === undefined ? Math.max(1, Math.ceil(Math.max(nsx, nsy) / 40)) : opts.meshEvery;
    const alpha = opts.alpha === undefined ? 255 : opts.alpha;
    const W = img.width, H = img.height;
    const buf = new Uint32Array(img.data.buffer, img.data.byteOffset, img.data.length >> 2);
    const inv = hi > lo ? 255 / (hi - lo) : 0;
    const elecRgb = typeof opts.electrodeRgb === 'function' ? opts.electrodeRgb : () => null;
    const elecCache = new Map();
    // order: far rows and columns first (see makeProjector: yr = X·sa + Yw·ca grows away from the viewer)
    const { ca, sa } = projector;
    const dx = nsx > 1 ? Math.abs(xs[1] - xs[0]) : 1, dy = nsy > 1 ? Math.abs(ys[1] - ys[0]) * projector.aspect : 1;
    const rowsOuter = Math.abs(ca) * dy >= Math.abs(sa) * dx;
    const jFar = ca >= 0 ? nsy - 2 : 0, jStep = ca >= 0 ? -1 : 1;
    const iFar = sa >= 0 ? nsx - 2 : 0, iStep = sa >= 0 ? -1 : 1;
    const le = isLittleEndian();
    let quads = 0, pixels = 0;
    const tri = new Float64Array(6);
    const outer = rowsOuter ? nsy - 1 : nsx - 1, inner = rowsOuter ? nsx - 1 : nsy - 1;
    for (let o = 0; o < outer; o++) {
        for (let q = 0; q < inner; q++) {
            const j = rowsOuter ? jFar + o * jStep : jFar + q * jStep;
            const i = rowsOuter ? iFar + q * iStep : iFar + o * iStep;
            const k00 = j * nsx + i, k10 = k00 + 1, k01 = k00 + nsx, k11 = k01 + 1;
            const x0 = px[k00], y0 = py[k00], x1 = px[k10], y1 = py[k10], x2 = px[k11], y2 = py[k11], x3 = px[k01], y3 = py[k01];
            // clip whole quads outside the buffer
            const minx = Math.min(x0, x1, x2, x3), maxx = Math.max(x0, x1, x2, x3), miny = Math.min(y0, y1, y2, y3), maxy = Math.max(y0, y1, y2, y3);
            if (maxx < 0 || minx > W || maxy < 0 || miny > H || !(minx === minx && miny === miny)) continue;
            // colour: electrode plateau or the map at the mean height, shaded by the facet normal
            const zm = 0.25 * (z[k00] + z[k10] + z[k01] + z[k11]);
            let r, g, b;
            const ow = owner[k00];
            if (ow >= 0 && owner[k10] === ow && owner[k01] === ow && owner[k11] === ow) {
                let c = elecCache.get(ow);
                if (c === undefined) { c = elecRgb(ow) || null; elecCache.set(ow, c); }
                if (c) { r = c[0]; g = c[1]; b = c[2]; } else { const t = clampByte((zm - lo) * inv); r = lut[3 * t]; g = lut[3 * t + 1]; b = lut[3 * t + 2]; }
            } else {
                const t = clampByte((zm - lo) * inv);
                r = lut[3 * t]; g = lut[3 * t + 1]; b = lut[3 * t + 2];
            }
            const br = projector.normal(xs[i + 1] - xs[i], 0, z[k10] - z[k00], 0, ys[j + 1] - ys[j], z[k01] - z[k00]);
            const col = packRgba(r * br, g * br, b * br, alpha, le);
            // two triangles
            tri[0] = x0; tri[1] = y0; tri[2] = x1; tri[3] = y1; tri[4] = x2; tri[5] = y2;
            pixels += fillTriangle(buf, W, H, tri, col);
            tri[2] = x2; tri[3] = y2; tri[4] = x3; tri[5] = y3;
            pixels += fillTriangle(buf, W, H, tri, col);
            // mesh lines on the quad's own edges (the far ones; nearer quads overdraw them later)
            if (meshEvery > 0) {
                const mcol = packRgba(r * br * 0.55, g * br * 0.55, b * br * 0.55, alpha, le);
                if (j % meshEvery === 0) drawLine(buf, W, H, x0, y0, x1, y1, mcol);
                if (i % meshEvery === 0) drawLine(buf, W, H, x0, y0, x3, y3, mcol);
                if (j === nsy - 2 && (nsy - 1) % meshEvery === 0) drawLine(buf, W, H, x3, y3, x2, y2, mcol);
                if (i === nsx - 2 && (nsx - 1) % meshEvery === 0) drawLine(buf, W, H, x1, y1, x2, y2, mcol);
            }
            quads++;
        }
    }
    return { quads, pixels };
}

let LE = null;
function isLittleEndian() {
    if (LE === null) { const u8 = new Uint8Array(new Uint32Array([1]).buffer); LE = u8[0] === 1; }
    return LE;
}
function clampByte(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }
function packRgba(r, g, b, a, le) {
    const R = clampByte(r), G = clampByte(g), B = clampByte(b), A = clampByte(a);
    return le ? ((A << 24) | (B << 16) | (G << 8) | R) >>> 0 : ((R << 24) | (G << 16) | (B << 8) | A) >>> 0;
}

/** Scanline fill of a triangle (device pixels; pixel centres at integers + 0.5). Returns the pixels written. */
function fillTriangle(buf, W, H, t, col) {
    let ax = t[0], ay = t[1], bx = t[2], by = t[3], cx = t[4], cy = t[5];
    // sort by y
    if (ay > by) { let s = ax; ax = bx; bx = s; s = ay; ay = by; by = s; }
    if (by > cy) { let s = bx; bx = cx; cx = s; s = by; by = cy; cy = s; }
    if (ay > by) { let s = ax; ax = bx; bx = s; s = ay; ay = by; by = s; }
    const yStart = Math.max(0, Math.ceil(ay - 0.5)), yEnd = Math.min(H - 1, Math.floor(cy - 0.5));
    if (yEnd < yStart) {
        // thinner than a pixel row: still mark the span so steep walls do not vanish
        const yy = Math.round((ay + cy) / 2 - 0.5);
        if (yy < 0 || yy >= H) return 0;
        return span(buf, W, yy, Math.min(ax, bx, cx), Math.max(ax, bx, cx), col);
    }
    let n = 0;
    const dAC = cy > ay ? (cx - ax) / (cy - ay) : 0;
    const dAB = by > ay ? (bx - ax) / (by - ay) : 0;
    const dBC = cy > by ? (cx - bx) / (cy - by) : 0;
    for (let yy = yStart; yy <= yEnd; yy++) {
        const yc = yy + 0.5;
        const xa = ax + (yc - ay) * dAC;
        const xb = yc < by ? ax + (yc - ay) * dAB : bx + (yc - by) * dBC;
        n += span(buf, W, yy, xa < xb ? xa : xb, xa < xb ? xb : xa, col);
    }
    return n;
}
function span(buf, W, yy, xl, xr, col) {
    let i0 = Math.ceil(xl - 0.5), i1 = Math.floor(xr - 0.5);
    if (i1 < i0) { i0 = Math.round((xl + xr) / 2 - 0.5); i1 = i0; }
    if (i0 < 0) i0 = 0;
    if (i1 > W - 1) i1 = W - 1;
    if (i1 < i0) return 0;
    const row = yy * W;
    buf.fill(col, row + i0, row + i1 + 1);
    return i1 - i0 + 1;
}
/** Bresenham line in device pixels. */
function drawLine(buf, W, H, x0, y0, x1, y1, col) {
    let ix0 = Math.round(x0 - 0.5), iy0 = Math.round(y0 - 0.5);
    const ix1 = Math.round(x1 - 0.5), iy1 = Math.round(y1 - 0.5);
    const dx = Math.abs(ix1 - ix0), dy = -Math.abs(iy1 - iy0);
    const sx = ix0 < ix1 ? 1 : -1, sy = iy0 < iy1 ? 1 : -1;
    let err = dx + dy;
    if (dx + Math.abs(dy) > 4 * (W + H)) return;
    for (;;) {
        if (ix0 >= 0 && ix0 < W && iy0 >= 0 && iy0 < H) buf[iy0 * W + ix0] = col;
        if (ix0 === ix1 && iy0 === iy1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; ix0 += sx; }
        if (e2 <= dx) { err += dx; iy0 += sy; }
    }
}

/**
 * Picture coordinates of every sample for a projector and a picture→device mapping.
 * toDevice(u, v) → [X, Y] in device pixels.
 * @returns {{ px: Float32Array, py: Float32Array }}
 */
export function projectSamples(surf, projector, toDevice) {
    const { nsx, nsy, xs, ys, z } = surf;
    const px = new Float32Array(nsx * nsy), py = new Float32Array(nsx * nsy);
    for (let j = 0; j < nsy; j++) {
        const y = ys[j];
        for (let i = 0; i < nsx; i++) {
            const k = j * nsx + i;
            const [u, v] = projector.project(xs[i], y, z[k]);
            const d = toDevice(u, v);
            px[k] = d[0]; py[k] = d[1];
        }
    }
    return { px, py };
}

/**
 * Charge polarity of a run from the resolved sources: the sign of the fraction-weighted charge of the enabled
 * sources' species (+1 when there are none).
 */
export function polaritySign(resolved) {
    const srcs = resolved && Array.isArray(resolved.sources) ? resolved.sources : [];
    let sum = 0;
    for (const s of srcs) {
        if (!s || s.enabled === false) continue;
        const n = typeof s.n === 'number' && s.n > 0 ? s.n : 1;
        const sp = Array.isArray(s.species) && s.species.length ? s.species : [{ charge: 1, fraction: 1 }];
        for (const q of sp) {
            const c = typeof q.charge === 'number' ? q.charge : 1;
            const f = typeof q.fraction === 'number' && q.fraction > 0 ? q.fraction : 1;
            sum += n * f * Math.sign(c || 1);
        }
    }
    return sum < 0 ? -1 : 1;
}
