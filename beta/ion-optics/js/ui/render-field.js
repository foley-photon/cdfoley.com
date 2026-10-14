/* ==========================================================================
   Ion optics UI: render-field.js
   Raster layers of the canvas: the potential as an image at grid resolution
   (smoothed by the browser when scaled) or, above 4 px per cell, evaluated
   per screen pixel by bicubic convolution (Keys, IEEE Trans. ASSP 29, 1153
   (1981), a = −1/2); the field magnitude |E| on a log scale from central
   differences of the displayed potential (a picture only: particle forces
   come from the field model, never from this layer); and equipotential
   paths from contour.js, cached per field key, display time and levels and
   decimated 2× above one million nodes.
   ========================================================================== */
import { getLut, chooseMap, normalizer } from './colormaps.js';
import { contourLevels, marchingSquares, decimate2, polylineLength, pointAlong } from './contour.js';

const BIG = 1e6;

function makeCanvas(w, hgt) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w); c.height = Math.max(1, hgt);
    return c;
}

/**
 * Field layer cache for one view.
 * setSource() takes the displayed potential on the level-0 grid; the getters build lazily and cache.
 */
export function createFieldLayer() {
    let src = null;            // { key, phi, nx, ny, x0, y0, h, mirrorX, mirrorY, oddX?, oddY?, cyl }; odd = anti-mirror (φ changes sign)
    let range = null;          // { vmin, vmax }
    let img = null, imgKey = '', imgNeg = null, imgNegKey = '';
    let emagImg = null, emagKey = '';
    let cont = null, contKey = '';
    let bic = null, bicKey = '';

    function setSource(s) {
        if (!s || !s.phi) { src = null; range = null; return; }
        const changed = !src || s.key !== src.key || s.phi !== src.phi;
        src = s;
        if (changed) {
            let lo = Infinity, hi = -Infinity;
            const phi = s.phi;
            for (let k = 0; k < phi.length; k++) { const v = phi[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
            if (!(lo <= hi)) { lo = 0; hi = 0; }
            if (lo > 0) lo = Math.min(lo, 0);
            if (hi < 0) hi = Math.max(hi, 0);
            // an anti-mirrored half shows −φ, so the displayed range is symmetric
            if (s.oddX || s.oddY) { const a = Math.max(-lo, hi); lo = -a; hi = a; }
            range = { vmin: lo, vmax: hi };
        }
    }

    /** Colour map name, range and normaliser for a view setting. */
    function mapping(setting) {
        if (!range) return null;
        const name = chooseMap(setting, range.vmin, range.vmax);
        const nz = normalizer(name, range.vmin, range.vmax);
        return { name, lo: nz.lo, hi: nz.hi, vmin: range.vmin, vmax: range.vmax, t: nz.t };
    }

    /** nx × ny canvas of the potential (row 0 = top = highest j); sign −1 gives the image of −φ for an anti-mirrored half. */
    function potentialImage(setting, sign = 1) {
        if (!src) return null;
        const m = mapping(setting);
        const neg = sign < 0;
        const key = src.key + '|' + m.name + '|' + m.lo + '|' + m.hi + (neg ? '|neg' : '');
        if (!neg && img && imgKey === key) return { canvas: img, map: m };
        if (neg && imgNeg && imgNegKey === key) return { canvas: imgNeg, map: m };
        const { nx, ny, phi } = src;
        const old = neg ? imgNeg : img;
        const c = (old && old.width === nx && old.height === ny) ? old : makeCanvas(nx, ny);
        const ctx = c.getContext('2d');
        const id = ctx.createImageData(nx, ny);
        const d = id.data, lut = getLut(m.name);
        const inv = 255 / (m.hi - m.lo), lo = m.lo, sg = neg ? -1 : 1;
        for (let j = 0; j < ny; j++) {
            const row = (ny - 1 - j) * nx;
            for (let i = 0; i < nx; i++) {
                const v = sg * phi[j * nx + i];
                let q = v !== v ? 128 : Math.round((v - lo) * inv);
                q = q < 0 ? 0 : q > 255 ? 255 : q;
                const o = 4 * (row + i);
                d[o] = lut[3 * q]; d[o + 1] = lut[3 * q + 1]; d[o + 2] = lut[3 * q + 2]; d[o + 3] = 255;
            }
        }
        ctx.putImageData(id, 0, 0);
        if (neg) { imgNeg = c; imgNegKey = key; } else { img = c; imgKey = key; }
        return { canvas: c, map: m };
    }

    /** nx × ny canvas of log10 |E| (central differences; masked nodes transparent). */
    function emagImage(mask) {
        if (!src) return null;
        const key = src.key + '|emag';
        if (emagImg && emagKey === key) return emagImg;
        const { nx, ny, phi, h } = src;
        const N = nx * ny;
        const e = new Float32Array(N);
        let lo = Infinity, hi = -Infinity;
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            const im = i > 0 ? k - 1 : k, ip = i < nx - 1 ? k + 1 : k, jm = j > 0 ? k - nx : k, jp = j < ny - 1 ? k + nx : k;
            const ex = (phi[ip] - phi[im]) / (((ip - im) || 1) * h);
            const ey = (phi[jp] - phi[jm]) / (((jp - jm) / nx || 1) * h);
            const v = Math.sqrt(ex * ex + ey * ey);
            const lv = v > 0 ? Math.log10(v) : NaN;
            e[k] = lv;
            if (lv === lv && !(mask && mask[k])) { if (lv < lo) lo = lv; if (lv > hi) hi = lv; }
        }
        if (!(hi > lo)) { lo = (lo === Infinity ? 0 : lo) - 1; hi = lo + 2; }
        lo = Math.max(lo, hi - 4);    // four decades
        const c = makeCanvas(nx, ny), ctx = c.getContext('2d');
        const id = ctx.createImageData(nx, ny), d = id.data, lut = getLut('cividis');
        const inv = 255 / (hi - lo);
        for (let j = 0; j < ny; j++) {
            const row = (ny - 1 - j) * nx;
            for (let i = 0; i < nx; i++) {
                const k = j * nx + i, v = e[k], o = 4 * (row + i);
                if (v !== v || (mask && mask[k])) { d[o + 3] = 0; continue; }
                let q = Math.round((v - lo) * inv); q = q < 0 ? 0 : q > 255 ? 255 : q;
                d[o] = lut[3 * q]; d[o + 1] = lut[3 * q + 1]; d[o + 2] = lut[3 * q + 2]; d[o + 3] = 255;
            }
        }
        ctx.putImageData(id, 0, 0);
        emagImg = c; emagKey = key; emagImg.range = { lo, hi };
        return emagImg;
    }

    /**
     * Contour paths. spec: { count: number|false, levels: number[]|null }.
     * @returns {null | { levels: number[], items: Array<{ level, major, path: Path2D, labels: Array<{x, y, angle}> }> }}
     */
    function contours(spec) {
        if (!src || !range) return null;
        const count = spec && typeof spec.count === 'number' ? spec.count : 20;
        const user = spec && Array.isArray(spec.levels) && spec.levels.length ? spec.levels.filter((v) => typeof v === 'number' && Number.isFinite(v)) : null;
        if (!user && !(count > 0)) return null;
        const key = src.key + '|' + (user ? 'u' + user.join(',') : 'n' + count);
        if (cont && contKey === key) return cont;
        let lv;
        if (user) lv = { levels: user.slice().sort((a, b) => a - b), major: user.map((_, k) => k % 5 === 4) };
        else lv = contourLevels(range.vmin, range.vmax, count);
        let vals = src.phi, nx = src.nx, ny = src.ny, h = src.h;
        if (nx * ny > BIG) { const d = decimate2(vals, nx, ny, h); vals = d.values; nx = d.nx; ny = d.ny; h = d.h; }
        const items = [];
        const FR = [0.5, 0.25, 0.75, 0.375, 0.625, 0.125, 0.875];
        let nMajor = 0;
        for (let k = 0; k < lv.levels.length; k++) {
            const frac = lv.major[k] ? FR[nMajor++ % FR.length] : 0.5;
            const lines = marchingSquares(vals, nx, ny, lv.levels[k], { x0: src.x0, y0: src.y0, h });
            const path = typeof Path2D === 'function' ? new Path2D() : null;
            const labels = [];
            for (const ln of lines) {
                const p = ln.pts;
                if (path) {
                    path.moveTo(p[0], p[1]);
                    for (let q = 2; q < p.length; q += 2) path.lineTo(p[q], p[q + 1]);
                    if (ln.closed) path.closePath();
                }
                // stagger label positions between levels so nested equipotentials do not stack their labels
                if (lv.major[k] && polylineLength(p) > 8 * src.h) labels.push(pointAlong(p, frac));
            }
            items.push({ level: lv.levels[k], major: !!lv.major[k], path, labels, nLines: lines.length });
        }
        cont = { levels: lv.levels, items };
        contKey = key;
        return cont;
    }

    /**
     * Screen-resolution potential by bicubic convolution, for zoom above 4 px per cell.
     * view: { W, H, dpr, cx, cy, scale } (CSS px); returns a canvas of W·dpr × H·dpr pixels or null.
     */
    function bicubicImage(view, setting) {
        if (!src) return null;
        const m = mapping(setting);
        const pw = Math.round(view.W * view.dpr), ph = Math.round(view.H * view.dpr);
        if (pw * ph > 8e6) return null;
        const key = [src.key, m.name, m.lo, m.hi, view.cx, view.cy, view.scale, pw, ph, src.mirrorX, src.mirrorY, !!src.oddX, !!src.oddY].join('|');
        if (bic && bicKey === key) return bic;
        const c = (bic && bic.width === pw && bic.height === ph) ? bic : makeCanvas(pw, ph);
        const ctx = c.getContext('2d');
        const id = ctx.createImageData(pw, ph), d = id.data;
        const lut = getLut(m.name), inv = 255 / (m.hi - m.lo), lo = m.lo;
        const { nx, ny, x0, y0, h, phi, mirrorX, mirrorY } = src;
        const oddX = !!src.oddX, oddY = !!src.oddY;
        const s = view.scale * view.dpr, ih = 1 / h;
        const X1 = x0 + (nx - 1) * h, Y1 = y0 + (ny - 1) * h;
        const wx = new Float64Array(4), wy = new Float64Array(4);
        for (let py = 0; py < ph; py++) {
            let y = view.cy - (py + 0.5 - ph / 2) / s, sy = 1;
            if (mirrorY && y < 0) { y = -y; if (oddY) sy = -1; }
            const fy = (y - y0) * ih;
            if (!(y >= y0 - 0.5 * h && y <= Y1 + 0.5 * h)) continue;
            let j = Math.floor(fy); const ty = fy - j;
            keys(ty, wy);
            for (let px = 0; px < pw; px++) {
                let x = view.cx + (px + 0.5 - pw / 2) / s, sg = sy;
                if (mirrorX && x < 0) { x = -x; if (oddX) sg = -sg; }
                if (!(x >= x0 - 0.5 * h && x <= X1 + 0.5 * h)) continue;
                const fx = (x - x0) * ih;
                const i = Math.floor(fx), tx = fx - i;
                keys(tx, wx);
                let v = 0;
                for (let b = 0; b < 4; b++) {
                    let jj = j - 1 + b; jj = jj < 0 ? 0 : jj > ny - 1 ? ny - 1 : jj;
                    const row = jj * nx;
                    let acc = 0;
                    for (let a = 0; a < 4; a++) {
                        let ii = i - 1 + a; ii = ii < 0 ? 0 : ii > nx - 1 ? nx - 1 : ii;
                        acc += wx[a] * phi[row + ii];
                    }
                    v += wy[b] * acc;
                }
                v *= sg;
                let q = Math.round((v - lo) * inv); q = q < 0 ? 0 : q > 255 ? 255 : q;
                const o = 4 * (py * pw + px);
                d[o] = lut[3 * q]; d[o + 1] = lut[3 * q + 1]; d[o + 2] = lut[3 * q + 2]; d[o + 3] = 255;
            }
        }
        ctx.putImageData(id, 0, 0);
        bic = c; bicKey = key;
        return bic;
    }

    return {
        setSource, mapping, potentialImage, emagImage, contours, bicubicImage,
        get source() { return src; }, get range() { return range; },
        clear() { src = null; range = null; img = null; emagImg = null; cont = null; bic = null; imgKey = emagKey = contKey = bicKey = ''; },
    };
}

// Keys cubic convolution weights for offsets −1, 0, 1, 2 at fraction t (a = −0.5)
function keys(t, w) {
    const t2 = t * t, t3 = t2 * t;
    w[0] = -0.5 * t3 + t2 - 0.5 * t;
    w[1] = 1.5 * t3 - 2.5 * t2 + 1;
    w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
    w[3] = 0.5 * t3 - 0.5 * t2;
}

/** Exposed for tests: cubic convolution weights (sum to 1). */
export function cubicWeights(t) { const w = new Float64Array(4); keys(t, w); return Array.from(w); }
