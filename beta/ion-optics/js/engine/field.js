/* ==========================================================================
   Ion optics engine: field.js
   Superposition of basis fields and the 2D field interpolant used by the
   particle code.

   REGULAR cells, `cubic` (default): C1 bicubic Hermite potential from nodal
   (phi, phi_x, phi_y, phi_xy); the force is minus its exact gradient, so the
   field is conservative and smooth across cells. Nodal derivatives are
   4th-order central where five free, uncut nodes allow, else 2nd-order
   central, else the Shortley-Weller 3-point formula with the cut value.
   BOUNDARY cells (both modes) and `linear` mode: bilinear nodal E with
   same-side extrapolation: corners hidden behind an electrode (or fixed) are
   replaced by values extrapolated from the visible side, so the field never
   blends across an electrode or a mesh. SOLID cells: E = 0 and phi = the
   electrode value. Outside the grid: E = 0 and phi = NaN.

   Sources: bicubic Hermite interpolation (Press, Teukolsky, Vetterling &
   Flannery, Numerical Recipes, 3rd ed. (2007), section 3.6); finite
   differences on non-uniform arms (Shortley & Weller, J. Appl. Phys. 9, 334
   (1938)); 4th-order central differences (Fornberg, Math. Comput. 51, 699
   (1988)).
   ========================================================================== */
import { CELL } from './raster.js';

/**
 * Weighted sum of basis fields, k ascending: out = sum_k w_k phi_k.
 * @param {Map<number, Float64Array>} bases
 * @param {ArrayLike<number>|Map<number, number>|function} weights indexed by electrode
 * @param {number} N
 * @param {Float64Array} out
 */
export function combine(bases, weights, N, out = new Float64Array(N)) {
    out.fill(0);
    const keys = [...bases.keys()].sort((a, b) => a - b);
    const wOf = typeof weights === 'function' ? weights : (weights instanceof Map ? (k) => weights.get(k) : (k) => weights[k]);
    for (const k of keys) {
        const w = +wOf(k) || 0;
        if (w === 0) continue;
        const b = bases.get(k);
        for (let q = 0; q < N; q++) out[q] += w * b[q];
    }
    return out;
}

const CORNER_DI = [0, 1, 0, 1], CORNER_DJ = [0, 0, 1, 1];
// extrapolation partners: for invisible corner q, adjacent corners a with the link direction a -> w (0 E, 1 W, 2 N, 3 S)
const ADJ_A = [[1, 2], [0, 3], [0, 3], [1, 2]];
const ADJ_D = [[0, 2], [1, 2], [3, 0], [3, 1]];
const DIAG = [3, 2, 1, 0];
const DDI = [1, -1, 0, 0], DDJ = [0, 0, 1, -1];

/**
 * Field interpolant on the level-0 raster.
 * @param {object} raster0 level-0 raster
 * @param {object} geometry compiled geometry (visibility tests, owners)
 * @param {{interp?: 'cubic'|'linear'}} opts
 */
export function createFieldGrid(raster0, geometry, opts = {}) {
    const interp = opts.interp === 'linear' ? 'linear' : 'cubic';
    const cubic = interp === 'cubic';
    const g = raster0.grid, nx = g.nx, ny = g.ny, N = nx * ny, h = g.h, x0 = g.x0, y0 = g.y0, ih = 1 / h;
    const cyl = g.type === 'cyl2d';
    const cls = raster0.cls, cellType = raster0.cellType, cellVis = raster0.cellVis, nearArr = raster0.near;
    const nE = Math.max(1, geometry ? geometry.nElectrodes : (raster0.stats && raster0.stats.nElectrodes) || 1);
    const E = g.edges || {};
    const neuX0 = E.xmin && E.xmin.bc === 'neumann', neuX1 = E.xmax && E.xmax.bc === 'neumann';
    const neuY0 = cyl || (E.ymin && E.ymin.bc === 'neumann'), neuY1 = E.ymax && E.ymax.bc === 'neumann';
    const mirX = !!(g.mirror && g.mirror.x), mirY = !cyl && !!(g.mirror && g.mirror.y);
    const x1 = x0 + (nx - 1) * h, y1 = y0 + (ny - 1) * h;
    const tolN = 1e-9;

    // cut arms per node
    const cutMask = new Uint8Array(N);
    const cuts = raster0.cuts;
    const cutRow = new Int32Array(N).fill(-1);
    let nRows = 0;
    for (let q = 0; q < cuts.count; q++) { const k = cuts.node[q]; if (cutRow[k] < 0) cutRow[k] = nRows++; }
    const armTh = new Float64Array(4 * Math.max(1, nRows)).fill(1), armEl = new Int16Array(4 * Math.max(1, nRows)).fill(-1);
    for (let q = 0; q < cuts.count; q++) {
        const k = cuts.node[q], d = cuts.dir[q], r = cutRow[k];
        cutMask[k] |= 1 << d; armTh[4 * r + d] = cuts.theta[q]; armEl[4 * r + d] = cuts.elec[q];
    }

    let C = 0, D = new Float64Array(0), CV = new Float64Array(nE);
    const cellPrims = new Map();

    // ---- index helpers with mirror ghosts
    const gx = (i) => (i < 0 ? (neuX0 ? -i : -1) : i > nx - 1 ? (neuX1 ? 2 * (nx - 1) - i : -1) : i);
    const gy = (j) => (j < 0 ? (neuY0 ? -j : -1) : j > ny - 1 ? (neuY1 ? 2 * (ny - 1) - j : -1) : j);
    // arm of node k in direction d, seen through ghosts: returns {cut, th, el, nb}
    const ARM = { cut: false, th: 1, el: -1, nb: -1 };
    function arm(i, j, d) {
        const k = j * nx + i;
        let di = DDI[d], dj = DDJ[d];
        let ii = i + di, jj = j + dj, dd = d;
        if (ii < 0 || ii > nx - 1 || jj < 0 || jj > ny - 1) {
            // ghost: mirror of the opposite arm
            const gi = di !== 0 ? gx(ii) : ii, gj = dj !== 0 ? gy(jj) : jj;
            if (gi < 0 || gj < 0) { ARM.cut = false; ARM.th = 1; ARM.el = -1; ARM.nb = -1; return ARM; }
            dd = d ^ 1; ii = gi; jj = gj;
        }
        if (cutMask[k] & (1 << dd)) { const r = cutRow[k]; ARM.cut = true; ARM.th = armTh[4 * r + dd]; ARM.el = armEl[4 * r + dd]; ARM.nb = -1; } else { ARM.cut = false; ARM.th = 1; ARM.el = -1; ARM.nb = jj * nx + ii; }
        return ARM;
    }
    const linkCutX = (j, a, b) => (cutMask[j * nx + (a < b ? a : b)] & 1) !== 0;   // E bit of the left node
    const linkCutY = (i, a, b) => (cutMask[(a < b ? a : b) * nx + i] & 4) !== 0;   // N bit of the lower node
    function ok4x(i, j) {
        const r = j * nx;
        const im2 = gx(i - 2), im1 = gx(i - 1), ip1 = gx(i + 1), ip2 = gx(i + 2);
        if (im2 < 0 || im1 < 0 || ip1 < 0 || ip2 < 0) return false;
        if (cls[r + im2] !== -1 || cls[r + im1] !== -1 || cls[r + ip1] !== -1 || cls[r + ip2] !== -1) return false;
        return !linkCutX(j, im2, im1) && !linkCutX(j, im1, i) && !linkCutX(j, i, ip1) && !linkCutX(j, ip1, ip2);
    }
    function ok4y(i, j) {
        const jm2 = gy(j - 2), jm1 = gy(j - 1), jp1 = gy(j + 1), jp2 = gy(j + 2);
        if (jm2 < 0 || jm1 < 0 || jp1 < 0 || jp2 < 0) return false;
        if (cls[jm2 * nx + i] !== -1 || cls[jm1 * nx + i] !== -1 || cls[jp1 * nx + i] !== -1 || cls[jp2 * nx + i] !== -1) return false;
        return !linkCutY(i, jm2, jm1) && !linkCutY(i, jm1, j) && !linkCutY(i, j, jp1) && !linkCutY(i, jp1, jp2);
    }

    // ---- stencil choice per node (geometry only), so setChannels is a tight loop
    // xCode/yCode: 0 fixed or zero, 1 4th-order direct, 2 central direct, 3 general (ghosts, cut arms)
    // xyCode: 0 zero, 1 4th-order direct, 2 central direct, 3 general
    const xCode = new Uint8Array(N), yCode = new Uint8Array(N), xyCode = new Uint8Array(N);
    const genX = [], genY = [], genXY = [];
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            if (cls[k] !== -1) continue;
            const inX = i >= 2 && i <= nx - 3, inY = j >= 2 && j <= ny - 3;
            const m = cutMask[k];
            if (ok4x(i, j)) { if (inX) xCode[k] = 1; else { xCode[k] = 3; genX.push(k); } } else if (!(m & 3) && i >= 1 && i <= nx - 2) xCode[k] = 2; else { xCode[k] = 3; genX.push(k); }
            if (cyl && j === 0) yCode[k] = 0;
            else if (ok4y(i, j)) { if (inY) yCode[k] = 1; else { yCode[k] = 3; genY.push(k); } } else if (!(m & 12) && j >= 1 && j <= ny - 2) yCode[k] = 2; else { yCode[k] = 3; genY.push(k); }
            if ((cyl && j === 0) || (mirY && j === 0) || (mirX && i === 0)) xyCode[k] = 0;
            else if (xCode[k] === 1) xyCode[k] = 1;
            else if (i >= 1 && i <= nx - 2 && cls[k + 1] === -1 && cls[k - 1] === -1 && !(m & 3) && xCode[k] !== 3) xyCode[k] = 2;
            else { xyCode[k] = 3; genXY.push(k); }
        }
    }
    const GX = Int32Array.from(genX), GY = Int32Array.from(genY), GXY = Int32Array.from(genXY);
    genX.length = 0; genY.length = 0; genXY.length = 0;
    const cutVal = (a, cvo) => (a.el >= 0 ? CV[cvo + a.el] : 0);

    function setChannels(phis, cutValues) {
        const nC = phis.length;
        if (nC !== C || D.length !== 4 * N * nC) { C = nC; D = new Float64Array(4 * N * C); }
        if (CV.length !== C * nE) CV = new Float64Array(Math.max(1, C * nE));
        const st = 4 * C;
        for (let ch = 0; ch < C; ch++) {
            const cv = cutValues && cutValues[ch];
            for (let e = 0; e < nE; e++) CV[ch * nE + e] = cv ? (+cv[e] || 0) : 0;
            const u = phis[ch];
            const cvo = ch * nE;
            // pass 1: phi, phi_x h, phi_y h (differences in node units carry the factor h)
            for (let k = 0, o = 4 * ch; k < N; k++, o += st) {
                D[o] = u[k];
                const xc = xCode[k];
                if (xc === 1) D[o + 1] = (-u[k + 2] + 8 * (u[k + 1] - u[k - 1]) + u[k - 2]) * (1 / 12);
                else if (xc === 2) D[o + 1] = 0.5 * (u[k + 1] - u[k - 1]);
                else D[o + 1] = 0;
                const yc = yCode[k];
                if (yc === 1) D[o + 2] = (-u[k + 2 * nx] + 8 * (u[k + nx] - u[k - nx]) + u[k - 2 * nx]) * (1 / 12);
                else if (yc === 2) D[o + 2] = 0.5 * (u[k + nx] - u[k - nx]);
                else D[o + 2] = 0;
                D[o + 3] = 0;
            }
            for (let q = 0; q < GX.length; q++) {
                const k = GX[q], i = k % nx, j = (k - i) / nx, uP = u[k];
                let px;
                if (ok4x(i, j)) { const r = j * nx; px = (-u[r + gx(i + 2)] + 8 * u[r + gx(i + 1)] - 8 * u[r + gx(i - 1)] + u[r + gx(i - 2)]) / 12; } else {
                    const aE = arm(i, j, 0), cE = aE.cut, tE = aE.th, vE = cE ? cutVal(aE, cvo) : (aE.nb >= 0 ? u[aE.nb] : uP);
                    const aW = arm(i, j, 1), cW = aW.cut, tW = aW.th, vW = cW ? cutVal(aW, cvo) : (aW.nb >= 0 ? u[aW.nb] : uP);
                    px = (!cE && !cW) ? 0.5 * (vE - vW) : (tW * tW * (vE - uP) + tE * tE * (uP - vW)) / (tE * tW * (tE + tW));
                }
                D[(k * C + ch) * 4 + 1] = px;
            }
            for (let q = 0; q < GY.length; q++) {
                const k = GY[q], i = k % nx, j = (k - i) / nx, uP = u[k];
                let py;
                if (ok4y(i, j)) py = (-u[gy(j + 2) * nx + i] + 8 * u[gy(j + 1) * nx + i] - 8 * u[gy(j - 1) * nx + i] + u[gy(j - 2) * nx + i]) / 12;
                else {
                    const aN = arm(i, j, 2), cN = aN.cut, tN = aN.th, vN = cN ? cutVal(aN, cvo) : (aN.nb >= 0 ? u[aN.nb] : uP);
                    const aS = arm(i, j, 3), cS = aS.cut, tS = aS.th, vS = cS ? cutVal(aS, cvo) : (aS.nb >= 0 ? u[aS.nb] : uP);
                    py = (!cN && !cS) ? 0.5 * (vN - vS) : (tS * tS * (vN - uP) + tN * tN * (uP - vS)) / (tN * tS * (tN + tS));
                }
                D[(k * C + ch) * 4 + 2] = py;
            }
            // pass 2: phi_xy h^2 = x-difference of (phi_y h), same stencil choice
            for (let k = 0, o = 4 * ch; k < N; k++, o += st) {
                const c = xyCode[k];
                if (c === 1) D[o + 3] = (-D[o + 2 + 2 * st] + 8 * (D[o + 2 + st] - D[o + 2 - st]) + D[o + 2 - 2 * st]) * (1 / 12);
                else if (c === 2) D[o + 3] = 0.5 * (D[o + 2 + st] - D[o + 2 - st]);
            }
            const PY = (k) => D[(k * C + ch) * 4 + 2];
            for (let q = 0; q < GXY.length; q++) {
                const k = GXY[q], i = k % nx, j = (k - i) / nx, r = j * nx;
                let pxy = 0;
                if (ok4x(i, j)) pxy = (-PY(r + gx(i + 2)) + 8 * PY(r + gx(i + 1)) - 8 * PY(r + gx(i - 1)) + PY(r + gx(i - 2))) / 12;
                else {
                    const ip1 = gx(i + 1), im1 = gx(i - 1), ip2 = gx(i + 2), im2 = gx(i - 2);
                    const fE = ip1 >= 0 && cls[r + ip1] === -1 && !linkCutX(j, i, ip1);
                    const fW = im1 >= 0 && cls[r + im1] === -1 && !linkCutX(j, im1, i);
                    if (fE && fW) pxy = 0.5 * (PY(r + ip1) - PY(r + im1));
                    else if (fE && ip2 >= 0 && cls[r + ip2] === -1 && !linkCutX(j, ip1, ip2)) pxy = 0.5 * (-3 * PY(k) + 4 * PY(r + ip1) - PY(r + ip2));
                    else if (fW && im2 >= 0 && cls[r + im2] === -1 && !linkCutX(j, im2, im1)) pxy = 0.5 * (3 * PY(k) - 4 * PY(r + im1) + PY(r + im2));
                }
                D[(k * C + ch) * 4 + 3] = pxy;
            }
        }
        api.nChannels = C;
    }

    // ---- evaluation
    const FV = new Float64Array(12);   // corner values (phi, Ex, Ey) x 4 for one channel
    const VISX = new Float64Array(4), VISY = new Float64Array(4);
    function outside(out) {
        for (let ch = 0; ch < C; ch++) { out[3 * ch] = NaN; out[3 * ch + 1] = 0; out[3 * ch + 2] = 0; }
        return CELL.EXTERIOR;
    }
    function blocked(c, px, py, qx, qy) {
        let list = cellPrims.get(c);
        if (list === undefined) {
            const i = c % (nx - 1), j = (c - i) / (nx - 1);
            const bx0 = x0 + i * h, by0 = y0 + j * h;
            list = geometry ? geometry.primsInBox(bx0 - 1e-6 * h, by0 - 1e-6 * h, bx0 + h * (1 + 1e-6), by0 + h * (1 + 1e-6)) : new Int32Array(0);
            cellPrims.set(c, list);
        }
        if (list.length === 0) return false;
        return geometry.segmentBlocked(list, list.length, px, py, qx, qy);
    }
    function hermite(i, j, s, t, out) {
        const s2 = s * s, s3 = s2 * s, t2 = t * t, t3 = t2 * t;
        const H0s = 2 * s3 - 3 * s2 + 1, H1s = 3 * s2 - 2 * s3, G0s = s3 - 2 * s2 + s, G1s = s3 - s2;
        const dH0s = 6 * s2 - 6 * s, dG0s = 3 * s2 - 4 * s + 1, dG1s = 3 * s2 - 2 * s;
        const H0t = 2 * t3 - 3 * t2 + 1, H1t = 3 * t2 - 2 * t3, G0t = t3 - 2 * t2 + t, G1t = t3 - t2;
        const dH0t = 6 * t2 - 6 * t, dG0t = 3 * t2 - 4 * t + 1, dG1t = 3 * t2 - 2 * t;
        const k00 = j * nx + i, step = 4 * C;
        for (let ch = 0; ch < C; ch++) {
            const a = (k00 * C + ch) * 4, b = a + step, c2 = a + nx * step, d = c2 + step;
            const f00 = D[a], x00 = D[a + 1], y00 = D[a + 2], z00 = D[a + 3];
            const f10 = D[b], x10 = D[b + 1], y10 = D[b + 2], z10 = D[b + 3];
            const f01 = D[c2], x01 = D[c2 + 1], y01 = D[c2 + 2], z01 = D[c2 + 3];
            const f11 = D[d], x11 = D[d + 1], y11 = D[d + 2], z11 = D[d + 3];
            // combine in s first for t-rows 0 and 1
            const A0 = f00 * H0s + f10 * H1s + x00 * G0s + x10 * G1s;     // phi(s, row 0)
            const A1 = f01 * H0s + f11 * H1s + x01 * G0s + x11 * G1s;
            const B0 = y00 * H0s + y10 * H1s + z00 * G0s + z10 * G1s;     // phi_y h (s, row 0)
            const B1 = y01 * H0s + y11 * H1s + z01 * G0s + z11 * G1s;
            const dA0 = (f10 - f00) * -dH0s + x00 * dG0s + x10 * dG1s;   // d/ds, using dH1 = -dH0
            const dA1 = (f11 - f01) * -dH0s + x01 * dG0s + x11 * dG1s;
            const dB0 = (y10 - y00) * -dH0s + z00 * dG0s + z10 * dG1s;
            const dB1 = (y11 - y01) * -dH0s + z01 * dG0s + z11 * dG1s;
            out[3 * ch] = A0 * H0t + A1 * H1t + B0 * G0t + B1 * G1t;
            out[3 * ch + 1] = -(dA0 * H0t + dA1 * H1t + dB0 * G0t + dB1 * G1t) * ih;
            out[3 * ch + 2] = -((A1 - A0) * -dH0t + B0 * dG0t + B1 * dG1t) * ih;
        }
    }
    function bilinear(i, j, s, t, out) {
        const k00 = j * nx + i, step = 4 * C;
        const w00 = (1 - s) * (1 - t), w10 = s * (1 - t), w01 = (1 - s) * t, w11 = s * t;
        for (let ch = 0; ch < C; ch++) {
            const a = (k00 * C + ch) * 4, b = a + step, c2 = a + nx * step, d = c2 + step;
            out[3 * ch] = w00 * D[a] + w10 * D[b] + w01 * D[c2] + w11 * D[d];
            out[3 * ch + 1] = -(w00 * D[a + 1] + w10 * D[b + 1] + w01 * D[c2 + 1] + w11 * D[d + 1]) * ih;
            out[3 * ch + 2] = -(w00 * D[a + 2] + w10 * D[b + 2] + w01 * D[c2 + 2] + w11 * D[d + 2]) * ih;
        }
    }
    function boundaryCell(i, j, s, t, x, y, c, out) {
        const k00 = j * nx + i;
        let vis = 0;
        const cv = cellVis[c] !== 0;
        for (let q = 0; q < 4; q++) {
            const k = k00 + CORNER_DI[q] + CORNER_DJ[q] * nx;
            if (cls[k] !== -1) continue;
            if (cv) {
                const qx = x0 + (i + CORNER_DI[q]) * h, qy = y0 + (j + CORNER_DJ[q]) * h;
                if (blocked(c, x, y, qx, qy)) continue;
            }
            vis |= 1 << q;
        }
        const w00 = (1 - s) * (1 - t), w10 = s * (1 - t), w01 = (1 - s) * t, w11 = s * t;
        if (vis === 0) {
            const owner = geometry ? geometry.classify(x, y) : -1;
            for (let ch = 0; ch < C; ch++) {
                let phi;
                if (owner >= 0) phi = CV[ch * nE + owner];
                else {
                    const a = (k00 * C + ch) * 4, b = a + 4 * C, c2 = a + nx * 4 * C, d = c2 + 4 * C;
                    phi = w00 * D[a] + w10 * D[b] + w01 * D[c2] + w11 * D[d];
                }
                out[3 * ch] = phi; out[3 * ch + 1] = 0; out[3 * ch + 2] = 0;
            }
            return;
        }
        for (let ch = 0; ch < C; ch++) {
            let emax = 0;
            for (let q = 0; q < 4; q++) {
                if (!(vis & (1 << q))) continue;
                const k = k00 + CORNER_DI[q] + CORNER_DJ[q] * nx, o = (k * C + ch) * 4;
                FV[3 * q] = D[o]; FV[3 * q + 1] = -D[o + 1] * ih; FV[3 * q + 2] = -D[o + 2] * ih;
                const e2 = FV[3 * q + 1] * FV[3 * q + 1] + FV[3 * q + 2] * FV[3 * q + 2];
                if (e2 > emax) emax = e2;
            }
            emax = Math.sqrt(emax);
            for (let q = 0; q < 4; q++) {
                if (vis & (1 << q)) continue;
                let n = 0, sp = 0, sx = 0, sy = 0;
                for (let r = 0; r < 2; r++) {
                    const a = ADJ_A[q][r];
                    if (!(vis & (1 << a))) continue;
                    const ai = i + CORNER_DI[a], aj = j + CORNER_DJ[a], ka = aj * nx + ai, d = ADJ_D[q][r];
                    const wi = ai + DDI[d], wj = aj + DDJ[d];
                    const oa = (ka * C + ch) * 4;
                    const pa = D[oa], ex = -D[oa + 1] * ih, ey = -D[oa + 2] * ih;
                    if (wi >= 0 && wi < nx && wj >= 0 && wj < ny && cls[wj * nx + wi] === -1 && !(cutMask[ka] & (1 << d))) {
                        const ow = ((wj * nx + wi) * C + ch) * 4;
                        sp += 2 * pa - D[ow]; sx += 2 * ex + D[ow + 1] * ih; sy += 2 * ey + D[ow + 2] * ih;
                    } else {
                        // no usable w: continue a's own field (phi along a's gradient), exact for linear fields
                        sp += pa - (ex * (CORNER_DI[q] - CORNER_DI[a]) + ey * (CORNER_DJ[q] - CORNER_DJ[a])) * h; sx += ex; sy += ey;
                    }
                    n++;
                }
                if (n === 0) {
                    // only the diagonal corner is visible: continue its field the same way
                    const dq = DIAG[q];
                    FV[3 * q] = FV[3 * dq] - (FV[3 * dq + 1] * (CORNER_DI[q] - CORNER_DI[dq]) + FV[3 * dq + 2] * (CORNER_DJ[q] - CORNER_DJ[dq])) * h;
                    FV[3 * q + 1] = FV[3 * dq + 1]; FV[3 * q + 2] = FV[3 * dq + 2];
                } else {
                    FV[3 * q] = sp / n; FV[3 * q + 1] = sx / n; FV[3 * q + 2] = sy / n;
                }
                const em = Math.sqrt(FV[3 * q + 1] * FV[3 * q + 1] + FV[3 * q + 2] * FV[3 * q + 2]);
                if (em > 2 * emax && em > 0) { const f = 2 * emax / em; FV[3 * q + 1] *= f; FV[3 * q + 2] *= f; }
            }
            out[3 * ch] = w00 * FV[0] + w10 * FV[3] + w01 * FV[6] + w11 * FV[9];
            out[3 * ch + 1] = w00 * FV[1] + w10 * FV[4] + w01 * FV[7] + w11 * FV[10];
            out[3 * ch + 2] = w00 * FV[2] + w10 * FV[5] + w01 * FV[8] + w11 * FV[11];
        }
    }

    function evalChannels(x, y, out) {
        const fx = (x - x0) * ih, fy = (y - y0) * ih;
        if (!(fx >= -tolN && fx <= nx - 1 + tolN && fy >= -tolN && fy <= ny - 1 + tolN)) return outside(out);
        let i = Math.floor(fx), j = Math.floor(fy);
        if (i < 0) i = 0; else if (i > nx - 2) i = nx - 2;
        if (j < 0) j = 0; else if (j > ny - 2) j = ny - 2;
        const s = fx - i, t = fy - j, c = j * (nx - 1) + i;
        const ct = cellType[c];
        if (ct === CELL.REGULAR) {
            if (cubic) hermite(i, j, s, t, out); else bilinear(i, j, s, t, out);
            return CELL.REGULAR;
        }
        if (ct === CELL.SOLID) {
            const e = cls[j * nx + i];
            for (let ch = 0; ch < C; ch++) { out[3 * ch] = e >= 0 ? CV[ch * nE + e] : 0; out[3 * ch + 1] = 0; out[3 * ch + 2] = 0; }
            return CELL.SOLID;
        }
        boundaryCell(i, j, s, t, x, y, c, out);
        return CELL.BOUNDARY;
    }
    function cellIndex(x, y) {
        const fx = (x - x0) * ih, fy = (y - y0) * ih;
        if (!(fx >= -tolN && fx <= nx - 1 + tolN && fy >= -tolN && fy <= ny - 1 + tolN)) return -1;
        let i = Math.floor(fx), j = Math.floor(fy);
        if (i < 0) i = 0; else if (i > nx - 2) i = nx - 2;
        if (j < 0) j = 0; else if (j > ny - 2) j = ny - 2;
        return j * (nx - 1) + i;
    }
    function cellTypeAt(x, y) { const c = cellIndex(x, y); return c < 0 ? CELL.EXTERIOR : cellType[c]; }
    function nearAt(x, y) { const c = cellIndex(x, y); return c < 0 ? 0 : nearArr[c]; }
    function nodal(k, ch = 0) {
        if (C === 0) return { phi: NaN, px: 0, py: 0, pxy: 0 };
        const o = (k * C + ch) * 4;
        return { phi: D[o], px: D[o + 1] * ih, py: D[o + 2] * ih, pxy: D[o + 3] * ih * ih };
    }
    function bytes() { return D.byteLength + cutMask.byteLength + cutRow.byteLength + armTh.byteLength + armEl.byteLength + CV.byteLength; }

    const api = {
        interp, cyl, nx, ny, h, x0, y0, bounds: { x0, x1, y0, y1 }, nChannels: 0, raster: raster0,
        setChannels, evalChannels, cellTypeAt, nearAt, nodal, bytes,
    };
    return api;
}
