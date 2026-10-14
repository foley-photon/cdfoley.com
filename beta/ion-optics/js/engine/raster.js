/* ==========================================================================
   Ion optics engine: raster.js
   Geometry to grid by exact interval painting along every grid row and
   column, on every multigrid level. One pass gives node classes, Dirichlet
   edge values (single or mixed weights), Shortley-Weller cut distances,
   level-0 cell types, the cells that need visibility tests and the band of
   cells near electrodes.

   Levels: spacing 2^l h on fine indices divisible by 2^l; coarse lattices may
   extend past the far edges (off-lattice levels): nodes beyond are exterior,
   a link crossing a Dirichlet far edge gets a cut at the edge, a link crossing
   a Neumann far edge is dropped.

   Sources: Shortley & Weller, J. Appl. Phys. 9, 334 (1938) (sub-grid boundary
   distances); Trottenberg, Oosterlee & Schueller, Multigrid (Academic Press,
   2001), ch. 5 (rediscretised coarse operators); Requicha, ACM Comput. Surv.
   12, 437 (1980) (ordered constructive solid geometry).
   ========================================================================== */
import { newComposition } from './geometry.js';

/**
 * Raster node flags (bit set). ANTIMIRROR marks the 0 V nodes of an anti-mirror plane (odd symmetry, φ(−x) = −φ(x)):
 * fixed for the solver, free-space nodes with odd ghosts for the field interpolant.
 */
export const FLAG = { FIXED: 1, IRREG: 2, AXIS: 4, MIXED: 8, SNAPPED: 16, EXTERIOR: 32, NEUMANN_EDGE: 64, ANTIMIRROR: 128 };
/** Level-0 cell types. */
export const CELL = { REGULAR: 0, BOUNDARY: 1, SOLID: 2, EXTERIOR: 3 };
/** Cut-arm directions: 0 +x, 1 -x, 2 +y, 3 -y. */
export const DIR = { E: 0, W: 1, N: 2, S: 3 };
/** Cut electrode code of an off-lattice Dirichlet far edge (value 0 in coarse corrections). */
export const CUT_EXTERIOR = -3;

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const LINK_TOL = 1e-7;      // node units: pieces this close to a link end only touch it
const REGULAR_TOL = 1e-6;   // a cut this close to a fixed neighbour of the same class is a regular link

function normEdge(e, fallbackBc) {
    if (!e || typeof e !== 'object') return { bc: fallbackBc, electrode: 0, segments: null };
    const bc = e.bc || (e.segments ? 'profile' : fallbackBc);
    let electrode = e.electrodeIndex !== undefined ? e.electrodeIndex : e.electrode;
    if (electrode === undefined || electrode === null) electrode = 0;
    return { bc, electrode, segments: Array.isArray(e.segments) ? e.segments.map((s) => ({ ...s })) : null };
}

/**
 * Grid of multigrid level `level` for a resolved domain.
 * @param {object} dom resolved domain ({type, h|cell, x, y, nx?, ny?, edges, mirror})
 * @param {number} level
 */
export function makeGrid(dom, level = 0) {
    const type = dom.type === 'cyl2d' ? 'cyl2d' : 'planar2d';
    const cyl = type === 'cyl2d';
    const h0 = num(dom.h, num(dom.cell, 1));
    const x0 = num(dom.x && dom.x[0]);
    const y0 = cyl ? 0 : num(dom.y && dom.y[0]);
    const nx0 = typeof dom.nx === 'number' ? dom.nx : Math.round((num(dom.x && dom.x[1], x0) - x0) / h0) + 1;
    const ny0 = typeof dom.ny === 'number' ? dom.ny : Math.round((num(dom.y && dom.y[1], y0) - y0) / h0) + 1;
    const scale = 2 ** level, h = h0 * scale;
    const nx = Math.ceil((nx0 - 1) / scale) + 1, ny = Math.ceil((ny0 - 1) / scale) + 1;
    const xEnd = x0 + (nx0 - 1) * h0, yEnd = y0 + (ny0 - 1) * h0;
    const mirror = dom.mirror || {};
    const mx = !!mirror.x, my = !cyl && !!mirror.y;
    // anti-mirror planes (odd reflection): the plane is a grounded Dirichlet edge for the solver; a mirror on the same
    // plane wins (the schema refuses both)
    const anti = dom.antimirror || {};
    const amx = !mx && !!anti.x, amy = !cyl && !my && !!anti.y;
    const ed = dom.edges || {};
    const edges = { xmin: normEdge(ed.xmin, 'dirichlet'), xmax: normEdge(ed.xmax, 'dirichlet'), ymin: normEdge(ed.ymin, cyl ? 'axis' : 'dirichlet'), ymax: normEdge(ed.ymax, 'dirichlet') };
    if (mx) edges.xmin = { bc: 'neumann', electrode: 0, segments: null };
    if (my) edges.ymin = { bc: 'neumann', electrode: 0, segments: null };
    if (amx) edges.xmin = { bc: 'dirichlet', electrode: 0, segments: null };
    if (amy) edges.ymin = { bc: 'dirichlet', electrode: 0, segments: null };
    if (cyl) edges.ymin = { bc: 'axis', electrode: 0, segments: null };
    return {
        type, level, scale, h, h0, x0, y0, nx, ny, N: nx * ny, nx0, ny0, xEnd, yEnd,
        offX: (nx - 1) * h - (xEnd - x0), offY: (ny - 1) * h - (yEnd - y0), edges, mirror: { x: mx, y: my }, antimirror: { x: amx, y: amy },
    };
}

// growable typed list helpers
function growI32(a, n) { if (n <= a.length) return a; const b = new Int32Array(Math.max(n, 2 * a.length)); b.set(a); return b; }
function growF64(a, n) { if (n <= a.length) return a; const b = new Float64Array(Math.max(n, 2 * a.length)); b.set(a); return b; }
function growI16(a, n) { if (n <= a.length) return a; const b = new Int16Array(Math.max(n, 2 * a.length)); b.set(a); return b; }
function growU8(a, n) { if (n <= a.length) return a; const b = new Uint8Array(Math.max(n, 2 * a.length)); b.set(a); return b; }

/**
 * Rasterise the geometry on one grid level.
 * @param {object} geometry compiled geometry
 * @param {object} grid from makeGrid
 * @param {object} resolved resolved project (electrode ids for edges)
 * @param {{boundary?: 'subgrid'|'staircase', snapTheta?: number}} opts
 * @returns {object} Raster
 */
export function rasterize(geometry, grid, resolved, opts = {}) {
    const tStart = performance.now();
    const boundary = opts.boundary === 'staircase' ? 'staircase' : 'subgrid';
    const snapTheta = num(opts.snapTheta, 1e-3);
    const g = grid, nx = g.nx, ny = g.ny, N = g.N, h = g.h, x0 = g.x0, y0 = g.y0;
    const cyl = g.type === 'cyl2d', level0 = g.level === 0;
    const Lx = g.xEnd - x0, Ly = g.yEnd - y0;
    const nxIn = Math.min(nx, Math.floor(Lx / h + 1e-7) + 1), nyIn = Math.min(ny, Math.floor(Ly / h + 1e-7) + 1);
    const xFarOn = Math.abs(x0 + (nxIn - 1) * h - g.xEnd) <= 1e-7 * h, yFarOn = Math.abs(y0 + (nyIn - 1) * h - g.yEnd) <= 1e-7 * h;
    const cls = new Int16Array(N).fill(-1);
    const flags = new Uint8Array(N);
    const electrodes = (resolved && resolved.electrodes) || [];
    const nE = Math.max(1, geometry ? geometry.nElectrodes : electrodes.length);
    const idx = (e) => {
        if (typeof e === 'number') return e;
        if (e === null || e === undefined) return 0;
        for (let i = 0; i < electrodes.length; i++) if (electrodes[i] && electrodes[i].id === e) return typeof electrodes[i].index === 'number' ? electrodes[i].index : i;
        return 0;
    };
    const issues = [];

    // ---- exterior nodes (coarse levels)
    let nExterior = 0;
    if (nxIn < nx || nyIn < ny) {
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            if (i < nxIn && j < nyIn) continue;
            const k = j * nx + i;
            cls[k] = -2; flags[k] = FLAG.FIXED | FLAG.EXTERIOR; nExterior++;
        }
    }

    // ---- Dirichlet and profile edges (y-edges first; x-edges win at corners; Dirichlet beats Neumann)
    const mixMap = new Map();   // node -> [e0, w0, e1, w1]
    const edgeSpec = (key) => {
        const e = g.edges[key];
        if (e.bc === 'profile') {
            const segs = (e.segments || []).map((s) => {
                const ramp = s.rampIndex || s.ramp;
                if (Array.isArray(ramp)) return { from: num(s.from), to: num(s.to), ea: idx(ramp[0]), eb: idx(ramp[1]), ramp: true };
                return { from: num(s.from), to: num(s.to), ea: idx(s.electrodeIndex !== undefined ? s.electrodeIndex : s.electrode), eb: -1, ramp: false };
            }).sort((a, b) => a.from - b.from);
            return { bc: 'profile', segs };
        }
        return { bc: e.bc, single: idx(e.electrode) };
    };
    const ES = { xmin: edgeSpec('xmin'), xmax: edgeSpec('xmax'), ymin: edgeSpec('ymin'), ymax: edgeSpec('ymax') };
    const isDir = (s) => s.bc === 'dirichlet' || s.bc === 'profile';
    const isNeu = (s) => s.bc === 'neumann';
    const W4 = [0, 0, 0, 0];
    function profileAt(segs, s, tol) {
        // weights into W4 = [e0, w0, e1, w1]
        const acc = new Map();
        const addSeg = (sg, frac, wt) => {
            if (!sg.ramp) { acc.set(sg.ea, (acc.get(sg.ea) || 0) + wt); return; }
            const f = frac <= 0 ? 0 : frac >= 1 ? 1 : frac;
            if (f < 1) acc.set(sg.ea, (acc.get(sg.ea) || 0) + wt * (1 - f));
            if (f > 0) acc.set(sg.eb, (acc.get(sg.eb) || 0) + wt * f);
        };
        let found = [];
        for (const sg of segs) if (s >= sg.from - tol && s <= sg.to + tol) found.push(sg);
        if (!found.length) {   // outside the tiling: nearest segment
            let best = null, bd = Infinity;
            for (const sg of segs) { const d = s < sg.from ? sg.from - s : s - sg.to; if (d < bd) { bd = d; best = sg; } }
            if (best) found = [best];
        }
        if (found.length >= 2) {
            // junction: average the two segments' values at their touching ends
            const a = found[0], b = found[found.length - 1];
            addSeg(a, Math.abs(s - a.to) <= tol ? 1 : (s - a.from) / (a.to - a.from || 1), 0.5);
            addSeg(b, Math.abs(s - b.from) <= tol ? 0 : (s - b.from) / (b.to - b.from || 1), 0.5);
        } else if (found.length === 1) {
            const a = found[0];
            const frac = Math.abs(s - a.from) <= tol ? 0 : Math.abs(s - a.to) <= tol ? 1 : (s - a.from) / (a.to - a.from || 1);
            addSeg(a, frac, 1);
        } else acc.set(0, 1);
        const ent = [...acc.entries()].filter((x) => x[1] > 0).sort((p, q) => q[1] - p[1]);
        if (ent.length > 2) { const sum = ent[0][1] + ent[1][1]; ent.length = 2; ent[0][1] /= sum; ent[1][1] /= sum; }
        W4[0] = ent.length ? ent[0][0] : 0; W4[1] = ent.length ? ent[0][1] : 1;
        W4[2] = ent.length > 1 ? ent[1][0] : -1; W4[3] = ent.length > 1 ? ent[1][1] : 0;
        return W4;
    }
    const tolS = 1e-6 * g.h0;
    function setEdgeNode(k, spec, s) {
        if (spec.bc === 'profile') {
            const w = profileAt(spec.segs, s, tolS);
            cls[k] = w[0]; flags[k] = FLAG.FIXED;
            if (w[2] >= 0 && w[3] > 0) { flags[k] |= FLAG.MIXED; mixMap.set(k, [w[0], w[1], w[2], w[3]]); } else mixMap.delete(k);
        } else { cls[k] = spec.single; flags[k] = FLAG.FIXED; mixMap.delete(k); }
    }
    if (isDir(ES.ymin)) for (let i = 0; i < nxIn; i++) setEdgeNode(i, ES.ymin, x0 + i * h);
    if (yFarOn && isDir(ES.ymax)) for (let i = 0; i < nxIn; i++) setEdgeNode((nyIn - 1) * nx + i, ES.ymax, x0 + i * h);
    if (isDir(ES.xmin)) for (let j = 0; j < nyIn; j++) setEdgeNode(j * nx, ES.xmin, y0 + j * h);
    if (xFarOn && isDir(ES.xmax)) for (let j = 0; j < nyIn; j++) setEdgeNode(j * nx + nxIn - 1, ES.xmax, y0 + j * h);
    // anti-mirror planes: the plane nodes stay fixed at 0 V for the solver and are flagged so that the field
    // interpolant treats them as free-space nodes with odd ghosts; a shape that paints a plane node clears the flag
    // (it is then an ordinary electrode node)
    // (a plane node on a real Dirichlet edge, e.g. the corner at a grounded far edge, is a fixed node in the full model too)
    const amx = !!(g.antimirror && g.antimirror.x), amy = !!(g.antimirror && g.antimirror.y), anyAM = amx || amy;
    const dirX0 = isDir(ES.xmin) && !amx, dirX1 = xFarOn && isDir(ES.xmax), dirY0 = isDir(ES.ymin) && !amy, dirY1 = yFarOn && isDir(ES.ymax);
    if (amx) for (let j = 0; j < nyIn; j++) { if ((j === 0 && dirY0) || (j === nyIn - 1 && dirY1)) continue; flags[j * nx] |= FLAG.ANTIMIRROR; }
    if (amy) for (let i = 0; i < nxIn; i++) { if ((i === 0 && dirX0) || (i === nxIn - 1 && dirX1)) continue; flags[i] |= FLAG.ANTIMIRROR; }
    const freeOrPlane = (k) => cls[k] === -1 || (anyAM && (flags[k] & FLAG.ANTIMIRROR) !== 0);

    // ---- per-row and per-column compositions
    const prims = geometry ? geometry.prims : [];
    const nP = prims.length;
    const cand = new Int32Array(Math.max(1, nP));
    const comp = newComposition(64);
    let PA = new Float64Array(64), PB = new Float64Array(64);
    let cutN = 0, cutNode = new Int32Array(256), cutDir = new Uint8Array(256), cutTh = new Float64Array(256), cutEl = new Int16Array(256);
    function pushCut(k, d, th, e) {
        if (cutN >= cutNode.length) { const m = 2 * cutNode.length; cutNode = growI32(cutNode, m); cutDir = growU8(cutDir, m); cutTh = growF64(cutTh, m); cutEl = growI16(cutEl, m); }
        cutNode[cutN] = k; cutDir[cutN] = d; cutTh[cutN] = th; cutEl[cutN] = e; cutN++;
    }
    const doCuts = boundary === 'subgrid';
    // link codes (level 0): 0 none, 1 partial, 2 full
    const hCode = level0 ? new Uint8Array(Math.max(1, (nx - 1) * ny)) : null, hCls = level0 ? new Int16Array(Math.max(1, (nx - 1) * ny)) : null;
    const vCode = level0 ? new Uint8Array(Math.max(1, nx * (ny - 1))) : null, vCls = level0 ? new Int16Array(Math.max(1, nx * (ny - 1))) : null;
    function markLinks(code, clsArr, base, stride, nLinks, a, b, c) {
        // piece [a, b] (node units along the line) of class c over links m in [floor(a), floor(b)]
        let m0 = Math.floor(a), m1 = Math.floor(b);
        if (m0 < 0) m0 = 0;
        if (m1 > nLinks - 1) m1 = nLinks - 1;
        for (let m = m0; m <= m1; m++) {
            const idxL = base + m * stride;
            const lo = a > m ? a : m, hi = b < m + 1 ? b : m + 1;
            if (lo > hi) continue;
            let v;
            if (a <= m + LINK_TOL && b >= m + 1 - LINK_TOL) v = 2;
            else if (hi <= m + LINK_TOL && a <= m + LINK_TOL) continue;           // touches the start node only
            else if (lo >= m + 1 - LINK_TOL && b >= m + 1 - LINK_TOL) continue;  // touches the end node only
            else v = 1;
            if (v === 1) code[idxL] = 1;
            else if (code[idxL] === 0) { code[idxL] = 2; clsArr[idxL] = c; }
        }
    }

    // rows
    for (let j = 0; j < nyIn; j++) {
        const y = y0 + j * h;
        let nc = 0;
        for (let q = 0; q < nP; q++) { const p = prims[q]; if (y >= p.by0 && y <= p.by1 && p.bx1 >= x0 && p.bx0 <= g.xEnd) cand[nc++] = q; }
        let np = 0;
        if (nc > 0) {
            geometry.composeAmong(cand, nc, x0, y, Lx, 0, comp);
            np = comp.n;
            if (np > PA.length) { PA = growF64(PA, np); PB = growF64(PB, np); }
            const sc = Lx / h;
            for (let q = 0; q < np; q++) { PA[q] = comp.t0[q] * sc; PB[q] = comp.t1[q] * sc; }
        }
        const row = j * nx;
        if (np > 0) {
            // classes
            let q = 0;
            for (let i = 0; i < nxIn; i++) {
                while (q < np && PB[q] < i) q++;
                if (q >= np) break;
                if (PA[q] <= i) {
                    const k = row + i;
                    cls[k] = comp.cls[q]; flags[k] = FLAG.FIXED; mixMap.delete(k);
                }
            }
            if (level0) for (let q2 = 0; q2 < np; q2++) markLinks(hCode, hCls, j * (nx - 1), 1, nx - 1, PA[q2], PB[q2], comp.cls[q2]);
            // E/W cuts
            if (doCuts) {
                let qn = 0;   // first piece with PA > i
                for (let i = 0; i < nxIn; i++) {
                    const k = row + i;
                    while (qn < np && PA[qn] <= i) qn++;
                    if (!freeOrPlane(k)) continue;
                    if (qn < np) {
                        const th = PA[qn] - i;
                        if (th <= 1 + 1e-12) {
                            const c = comp.cls[qn];
                            if (!(th >= 1 - REGULAR_TOL && i + 1 < nxIn && cls[k + 1] === c)) pushCut(k, 0, th > 1 ? 1 : th, c);
                        }
                    }
                    const qp = qn - 1;   // last piece with PA <= i (it ends before i since node i is free)
                    if (qp >= 0) {
                        const th = i - PB[qp];
                        if (th <= 1 + 1e-12 && th >= -1e-12) {
                            const c = comp.cls[qp];
                            if (!(th >= 1 - REGULAR_TOL && i - 1 >= 0 && cls[k - 1] === c)) pushCut(k, 1, th < 0 ? 0 : (th > 1 ? 1 : th), c);
                        }
                    }
                }
            }
        }
    }
    // columns
    for (let i = 0; i < nxIn; i++) {
        const x = x0 + i * h;
        let nc = 0;
        for (let q = 0; q < nP; q++) { const p = prims[q]; if (x >= p.bx0 && x <= p.bx1 && p.by1 >= y0 && p.by0 <= g.yEnd) cand[nc++] = q; }
        if (nc === 0) continue;
        geometry.composeAmong(cand, nc, x, y0, 0, Ly, comp);
        const np = comp.n;
        if (np === 0) continue;
        if (np > PA.length) { PA = growF64(PA, np); PB = growF64(PB, np); }
        const sc = Ly / h;
        for (let q = 0; q < np; q++) { PA[q] = comp.t0[q] * sc; PB[q] = comp.t1[q] * sc; }
        if (level0) for (let q = 0; q < np; q++) markLinks(vCode, vCls, i, nx, ny - 1, PA[q], PB[q], comp.cls[q]);
        if (!doCuts) continue;
        let qn = 0;
        for (let j = 0; j < nyIn; j++) {
            const k = j * nx + i;
            while (qn < np && PA[qn] <= j) qn++;
            if (!freeOrPlane(k)) continue;
            const qp = qn - 1;
            if (qp >= 0 && PB[qp] >= j) { pushCut(k, 2, 0, comp.cls[qp]); continue; }   // column disagrees with the row: snap
            if (qn < np) {
                const th = PA[qn] - j;
                if (th <= 1 + 1e-12) {
                    const c = comp.cls[qn];
                    if (!(th >= 1 - REGULAR_TOL && j + 1 < nyIn && cls[k + nx] === c)) pushCut(k, 2, th > 1 ? 1 : th, c);
                }
            }
            if (qp >= 0 && !(cyl && j === 0)) {
                const th = j - PB[qp];
                if (th <= 1 + 1e-12) {
                    const c = comp.cls[qp];
                    if (!(th >= 1 - REGULAR_TOL && j - 1 >= 0 && cls[k - nx] === c)) pushCut(k, 3, th < 0 ? 0 : (th > 1 ? 1 : th), c);
                }
            }
        }
    }

    // ---- far-edge cuts on off-lattice levels
    if (!xFarOn && isDir(ES.xmax) && nxIn >= 1) {
        const i = nxIn - 1, th = (g.xEnd - (x0 + i * h)) / h;
        for (let j = 0; j < nyIn; j++) { const k = j * nx + i; if (cls[k] === -1) pushCut(k, 0, th, CUT_EXTERIOR); }
    }
    if (!yFarOn && isDir(ES.ymax) && nyIn >= 1) {
        const j = nyIn - 1, th = (g.yEnd - (y0 + j * h)) / h;
        for (let i = 0; i < nxIn; i++) { const k = j * nx + i; if (cls[k] === -1) pushCut(k, 2, th, CUT_EXTERIOR); }
    }

    // ---- merge cuts per (node, dir): keep the smallest theta; snap nodes with theta < snapTheta
    const order = new Int32Array(cutN);
    for (let c = 0; c < cutN; c++) order[c] = c;
    const keyOf = (c) => cutNode[c] * 4 + cutDir[c];
    order.sort((a, b) => (keyOf(a) - keyOf(b)) || (cutTh[a] - cutTh[b]));
    let snapped = 0;
    const farElec = (d) => (d === 0 ? (ES.xmax.single !== undefined ? ES.xmax.single : 0) : (ES.ymax.single !== undefined ? ES.ymax.single : 0));
    for (let r = 0; r < cutN; r++) {
        const c = order[r], k = cutNode[c];
        if (cutTh[c] < snapTheta && cls[k] === -1) {
            // the smallest theta of this node over all directions decides the class
            let best = c;
            for (let r2 = r; r2 < cutN && cutNode[order[r2]] === k; r2++) if (cutTh[order[r2]] < cutTh[best]) best = order[r2];
            for (let r2 = r - 1; r2 >= 0 && cutNode[order[r2]] === k; r2--) if (cutTh[order[r2]] < cutTh[best]) best = order[r2];
            const e = cutEl[best];
            cls[k] = e >= 0 ? e : farElec(cutDir[best]);
            flags[k] = FLAG.FIXED | FLAG.SNAPPED;
            snapped++;
        } else if (cutTh[c] < snapTheta && anyAM && (flags[k] & FLAG.ANTIMIRROR)) {
            flags[k] &= ~FLAG.ANTIMIRROR;   // an electrode surface passes through the plane node: an ordinary fixed node
        }
    }
    let nc2 = 0;
    const cNode = new Int32Array(cutN), cDir = new Uint8Array(cutN), cTh = new Float64Array(cutN), cEl = new Int16Array(cutN);
    let lastKey = -1;
    for (let r = 0; r < cutN; r++) {
        const c = order[r], k = cutNode[c];
        if (!freeOrPlane(k)) continue;
        const key = keyOf(c);
        if (key === lastKey) continue;   // a smaller theta for this arm was already kept
        lastKey = key;
        cNode[nc2] = k; cDir[nc2] = cutDir[c]; cTh[nc2] = cutTh[c]; cEl[nc2] = cutEl[c];
        if (cls[k] === -1) flags[k] |= FLAG.IRREG;
        nc2++;
    }
    const cuts = { count: nc2, node: cNode.slice(0, nc2), dir: cDir.slice(0, nc2), theta: cTh.slice(0, nc2), elec: cEl.slice(0, nc2) };

    // ---- edge flags
    if (cyl) for (let i = 0; i < nx; i++) flags[i] |= FLAG.AXIS;
    const markNeumann = (k) => { if (cls[k] === -1) flags[k] |= FLAG.NEUMANN_EDGE | FLAG.IRREG; };
    if (isNeu(ES.xmin)) for (let j = 0; j < nyIn; j++) markNeumann(j * nx);
    if (isNeu(ES.xmax)) {
        if (xFarOn) for (let j = 0; j < nyIn; j++) markNeumann(j * nx + nxIn - 1);
        else for (let j = 0; j < nyIn; j++) { const k = j * nx + nxIn - 1; if (cls[k] === -1) flags[k] |= FLAG.IRREG; }
    }
    if (isNeu(ES.ymin)) for (let i = 0; i < nxIn; i++) markNeumann(i);
    if (isNeu(ES.ymax)) {
        if (yFarOn) for (let i = 0; i < nxIn; i++) markNeumann((nyIn - 1) * nx + i);
        else for (let i = 0; i < nxIn; i++) { const k = (nyIn - 1) * nx + i; if (cls[k] === -1) flags[k] |= FLAG.IRREG; }
    }

    // ---- mixed list
    const mixNodes = [...mixMap.keys()].filter((k) => cls[k] >= 0 && (flags[k] & FLAG.MIXED)).sort((a, b) => a - b);
    const mix = { count: mixNodes.length, node: new Int32Array(mixNodes.length), e: new Int16Array(2 * mixNodes.length), w: new Float64Array(2 * mixNodes.length) };
    for (let m = 0; m < mixNodes.length; m++) {
        const k = mixNodes[m], v = mixMap.get(k);
        mix.node[m] = k; mix.e[2 * m] = v[0]; mix.w[2 * m] = v[1]; mix.e[2 * m + 1] = v[2]; mix.w[2 * m + 1] = v[3];
    }
    for (let k = 0; k < N; k++) if ((flags[k] & FLAG.MIXED) && !mixMap.has(k)) flags[k] &= ~FLAG.MIXED;

    // ---- level-0 cell types, visibility flags and the near band
    let cellType = null, cellVis = null, near = null;
    if (level0 && nx >= 2 && ny >= 2) {
        const nc = (nx - 1) * (ny - 1);
        cellType = new Uint8Array(nc); cellVis = new Uint8Array(nc); near = new Uint8Array(nc);
        const sub = new Uint8Array(nc);
        const markCellOf = (x, y, bit) => {
            const fi = (x - x0) / h, fj = (y - y0) / h;
            const i = Math.floor(fi), j = Math.floor(fj);
            if (i < 0 || j < 0 || i > nx - 2 || j > ny - 2) return;
            if (fi - i <= LINK_TOL || fi - i >= 1 - LINK_TOL || fj - j <= LINK_TOL || fj - j >= 1 - LINK_TOL) return;
            sub[j * (nx - 1) + i] |= bit;
        };
        for (const p of prims) {
            const bit = p.electrode >= 0 ? 1 : 2, b = p.bbox;
            const fi0 = (b.x0 - x0) / h, fi1 = (b.x1 - x0) / h, fj0 = (b.y0 - y0) / h, fj1 = (b.y1 - y0) / h;
            const i0 = Math.floor(fi0), j0 = Math.floor(fj0);
            if (i0 === Math.floor(fi1) && j0 === Math.floor(fj1) && fi0 - i0 > LINK_TOL && fi1 - i0 < 1 - LINK_TOL && fj0 - j0 > LINK_TOL && fj1 - j0 < 1 - LINK_TOL
                && i0 >= 0 && j0 >= 0 && i0 <= nx - 2 && j0 <= ny - 2) sub[j0 * (nx - 1) + i0] |= bit;
            if (p.pts) for (let v = 0; v < p.np; v++) markCellOf(p.pts[2 * v], p.pts[2 * v + 1], bit);
        }
        for (let j = 0; j < ny - 1; j++) {
            for (let i = 0; i < nx - 1; i++) {
                const c = j * (nx - 1) + i, k = j * nx + i;
                const c00 = cls[k], c10 = cls[k + 1], c01 = cls[k + nx], c11 = cls[k + nx + 1];
                const hb = j * (nx - 1) + i, ht = hb + (nx - 1), vl = j * nx + i, vr = vl + 1;
                const b = hCode[hb], t = hCode[ht], l = vCode[vl], r = vCode[vr];
                const s = sub[c];
                // anti-mirror plane nodes count as free space here: the cells along the plane stay REGULAR (Hermite)
                const allFree = anyAM ? (freeOrPlane(k) && freeOrPlane(k + 1) && freeOrPlane(k + nx) && freeOrPlane(k + nx + 1))
                    : (c00 === -1 && c10 === -1 && c01 === -1 && c11 === -1);
                if (allFree && (b | t | l | r) === 0 && !(s & 1)) { cellType[c] = CELL.REGULAR; continue; }
                if (c00 >= 0 && c00 === c10 && c00 === c01 && c00 === c11 && b === 2 && t === 2 && l === 2 && r === 2
                    && hCls[hb] === c00 && hCls[ht] === c00 && vCls[vl] === c00 && vCls[vr] === c00 && !(s & 2)
                    && !((flags[k] | flags[k + 1] | flags[k + nx] | flags[k + nx + 1]) & FLAG.MIXED)) { cellType[c] = CELL.SOLID; continue; }
                cellType[c] = CELL.BOUNDARY;
                cellVis[c] = (b === 1 || t === 1 || l === 1 || r === 1 || s !== 0) ? 1 : 0;
            }
        }
        // near = BOUNDARY cells dilated by one cell (8-neighbourhood), separable
        const ncx = nx - 1, ncy = ny - 1, tmp = new Uint8Array(nc);
        for (let j = 0; j < ncy; j++) {
            const o = j * ncx;
            for (let i = 0; i < ncx; i++) {
                if (cellType[o + i] !== CELL.BOUNDARY) continue;
                tmp[o + i] = 1;
                if (i > 0) tmp[o + i - 1] = 1;
                if (i + 1 < ncx) tmp[o + i + 1] = 1;
            }
        }
        for (let j = 0; j < ncy; j++) {
            const o = j * ncx;
            for (let i = 0; i < ncx; i++) {
                if (!tmp[o + i]) continue;
                near[o + i] = 1;
                if (j > 0) near[o + i - ncx] = 1;
                if (j + 1 < ncy) near[o + i + ncx] = 1;
            }
        }
        // electrodes that touch (fixed neighbours of different single classes)
        const pairs = new Set();
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            const k = j * nx + i, a = cls[k];
            if (a < 0 || (flags[k] & FLAG.MIXED)) continue;
            if (i + 1 < nx) { const bb = cls[k + 1]; if (bb >= 0 && bb !== a && !(flags[k + 1] & FLAG.MIXED)) pairs.add(Math.min(a, bb) * 65536 + Math.max(a, bb)); }
            if (j + 1 < ny) { const bb = cls[k + nx]; if (bb >= 0 && bb !== a && !(flags[k + nx] & FLAG.MIXED)) pairs.add(Math.min(a, bb) * 65536 + Math.max(a, bb)); }
        }
        const name = (e) => (electrodes[e] && (electrodes[e].name || electrodes[e].id)) || String(e);
        for (const key of pairs) {
            const a = Math.floor(key / 65536), b = key % 65536;
            issues.push({ path: `electrodes[${b}]`, code: 'W_SHORT', message: `Electrodes "${name(a)}" and "${name(b)}" touch (neighboring grid nodes): they short-circuit each other.` });
        }
    }

    // ---- stats
    let fixed = 0, free = 0, irregular = 0;
    for (let k = 0; k < N; k++) {
        const c = cls[k];
        if (c === -1) { free++; if (flags[k] & FLAG.IRREG) irregular++; } else if (c >= 0) fixed++;
    }
    const stats = { fixed, free, irregular, cuts: cuts.count, mixed: mix.count, snapped, exterior: nExterior, ms: performance.now() - tStart, issues, nElectrodes: nE };
    return { grid: g, cls, flags, cuts, mix, cellType, cellVis, near, stats, boundary };
}

/**
 * Pack a raster into a JSON-safe meta object and copies of its buffers (transferable).
 * @param {object} raster
 * @returns {{meta: object, buffers: ArrayBuffer[]}}
 */
export function packRaster(raster) {
    const names = ['cls', 'flags', 'cuts.node', 'cuts.dir', 'cuts.theta', 'cuts.elec', 'mix.node', 'mix.e', 'mix.w', 'cellType', 'cellVis', 'near'];
    const get = (r, n) => n.split('.').reduce((o, p) => (o ? o[p] : null), r);
    const present = [], types = [], buffers = [];
    for (const n of names) {
        const a = get(raster, n);
        if (!a) continue;
        present.push(n); types.push(a.constructor.name);
        buffers.push(a.slice().buffer);
    }
    const grid = { ...raster.grid, edges: JSON.parse(JSON.stringify(raster.grid.edges)), mirror: { ...raster.grid.mirror }, antimirror: { ...(raster.grid.antimirror || { x: false, y: false }) } };
    const meta = { grid, cutsCount: raster.cuts.count, mixCount: raster.mix.count, stats: JSON.parse(JSON.stringify(raster.stats)), boundary: raster.boundary, present, types };
    return { meta, buffers };
}

/**
 * Rebuild a raster from packRaster output.
 * @param {{meta: object, buffers: ArrayBuffer[]}} packed
 */
export function unpackRaster(packed) {
    const { meta, buffers } = packed;
    const T = { Int16Array, Uint8Array, Int32Array, Float64Array };
    const r = { grid: meta.grid, cls: null, flags: null, cuts: { count: meta.cutsCount }, mix: { count: meta.mixCount }, cellType: null, cellVis: null, near: null, stats: meta.stats, boundary: meta.boundary };
    meta.present.forEach((n, i) => {
        const a = new T[meta.types[i]](buffers[i]);
        const parts = n.split('.');
        if (parts.length === 1) r[n] = a; else r[parts[0]][parts[1]] = a;
    });
    if (!r.cuts.node) { r.cuts.node = new Int32Array(0); r.cuts.dir = new Uint8Array(0); r.cuts.theta = new Float64Array(0); r.cuts.elec = new Int16Array(0); }
    if (!r.mix.node) { r.mix.node = new Int32Array(0); r.mix.e = new Int16Array(0); r.mix.w = new Float64Array(0); }
    return r;
}
