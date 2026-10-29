/* ==========================================================================
   Ion optics engine: operator.js
   Discrete Laplace operator on one grid level, scaled by h^2: regular rows
   (planar 5-point; cylindrical finite volume with faces at r_{j+-1/2}; the axis
   row (phi_E + phi_W + 4 phi_N)/6), and a compact list of irregular nodes
   (cut arms, Neumann/mirror ghosts, dropped off-lattice arms) with
   Shortley-Weller coefficients. Every coefficient is positive and
   diag = sum of the arm coefficients, so the matrix is an M-matrix.
   Basis, voltage and custom boundary set-ups; red-black kernels; residual.

   Poisson term (optional, off by default): an analytic charge density
   rho(x, y) in C/m^3 is sampled at the cell centres and averaged onto the
   nodes with the volumes of each node's dual cell; the h^2-scaled source
   f = h^2 rho / eps0 (V) enters the same rows, diag phi_P - sum c_d phi_d = f_P,
   so that -lap(phi) = rho / eps0. The particular solution with every
   electrode at 0 V is the "charge basis" (CHARGE_BASIS) and adds to the
   voltage superposition (uniqueness: Griffiths, Introduction to
   Electrodynamics, 4th ed., sections 2.3 and 3.1).

   Sources: Shortley & Weller, J. Appl. Phys. 9, 334 (1938); Hageman & Young,
   Applied Iterative Methods (Academic Press, 1981), ch. 9 (red-black
   ordering); finite-volume axisymmetric Laplacian: Trottenberg, Oosterlee &
   Schueller, Multigrid (Academic Press, 2001), section 5.6; Poisson source in
   relaxation: Press, Teukolsky, Vetterling & Flannery, Numerical Recipes,
   3rd ed. (2007), section 20.5.
   ========================================================================== */
import { FLAG, CUT_EXTERIOR, makeGrid, rasterize } from './raster.js';
import { parseExpr, EngineError } from './expr.js';
import { EPS0 } from './constants.js';

const ARM_NODE = 0, ARM_CUT = 1, ARM_DROP = 2, ARM_NONE = 3, ARM_GHOST = 4;

/** Pseudo electrode index of the space-charge particular solution: solveBasis(H, CHARGE_BASIS) (weight 1 in the DC channel). */
export const CHARGE_BASIS = -1;
/** rho / eps0 with rho in C/m^3 and eps0 in F/m is V/m^2; the grid works in mm, so the Poisson term is scaled by 1e-6 (V/mm^2). */
const RHO_UNIT = 1e-6;

/**
 * Nodal Poisson source of a level-0 operator from an analytic charge density (C/m^3; names: the parameters and
 * x, y, z = 0, r = y). The density is evaluated once per cell centre and averaged onto each free node with the volume
 * weights of the node's dual cell: planar, the four cells equally; cylindrical j >= 1, the cells above and below
 * weighted r_j + h/4 and r_j - h/4; on the axis, the two cells above. f_P = h^2 rho_P 1e-6 / eps0 in V.
 * @param {object} op level-0 Operator
 * @param {string} expr charge-density expression
 * @param {object} [paramValues] parameter values by name
 * @returns {Float64Array|null} length N (0 at fixed and exterior nodes); null when the density is identically zero
 */
export function chargeSource(op, expr, paramValues = {}) {
    if (typeof expr !== 'string' || !expr.trim()) return null;
    const ex = parseExpr(expr.trim());
    const g = op.grid, nx = op.nx, ny = op.ny, h = g.h, x0 = g.x0, y0 = g.y0, cyl = op.cyl;
    const ncx = nx - 1, ncy = ny - 1;
    const vars = Object.create(null);
    if (paramValues) for (const name of Object.keys(paramValues)) vars[name] = paramValues[name];
    vars.z = 0;
    const rho = new Float64Array(ncx * ncy);
    let any = false;
    for (let j = 0; j < ncy; j++) {
        const y = y0 + (j + 0.5) * h;
        vars.y = y; vars.r = y;
        for (let i = 0; i < ncx; i++) {
            vars.x = x0 + (i + 0.5) * h;
            const v = ex.evaluate(vars);
            if (!Number.isFinite(v)) throw new EngineError('E_NOT_FINITE', `The charge density is not finite at (${vars.x}, ${y}).`, 'domain.charge');
            rho[j * ncx + i] = v;
            if (v !== 0) any = true;
        }
    }
    if (!any) return null;
    const f = new Float64Array(op.N), mask = op.mask;
    const C = h * h * RHO_UNIT / EPS0;
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            if (mask[k] === 1) continue;
            let s = 0, w = 0;
            for (let cj = j - 1; cj <= j; cj++) {
                if (cj < 0 || cj >= ncy) continue;
                const wj = cyl ? (cj === j ? j + 0.25 : j - 0.25) : 1;   // r_{j +- 1/4} / h; the axis (j = 0) sees only the cells above
                for (let ci = i - 1; ci <= i; ci++) {
                    if (ci < 0 || ci >= ncx) continue;
                    s += wj * rho[cj * ncx + ci]; w += wj;
                }
            }
            f[k] = w > 0 ? C * s / w : 0;
        }
    }
    return f;
}

/**
 * Operators of every multigrid level, each rasterised from the exact geometry at its own spacing.
 * Coarsening stops below minNodesPerDir nodes in x or y, at <= minFree free nodes, or at maxLevels.
 * opts.raster0 reuses an existing level-0 raster.
 * @param {object} geometry compiled geometry
 * @param {object} resolved resolved project (domain, electrodes, solver.boundary)
 * @param {{boundary?: 'subgrid'|'staircase', maxLevels?: number, minNodesPerDir?: number, minFree?: number, snapTheta?: number, raster0?: object}} [opts]
 * @returns {object[]} Operator[] (index 0 = fine level)
 */
export function buildHierarchy(geometry, resolved, opts = {}) {
    const boundary = opts.boundary || (resolved && resolved.solver && resolved.solver.boundary) || 'subgrid';
    const maxLevels = opts.maxLevels || 8, minNodesPerDir = opts.minNodesPerDir || 5;
    const minFree = opts.minFree === undefined ? 1000 : opts.minFree;
    const snapTheta = opts.snapTheta === undefined ? 1e-3 : opts.snapTheta;
    const dom = resolved.domain;
    const H = [];
    for (let l = 0; l < maxLevels; l++) {
        const grid = makeGrid(dom, l);
        if (l > 0 && (grid.nx < minNodesPerDir || grid.ny < minNodesPerDir)) break;
        const r = l === 0 && opts.raster0 ? opts.raster0 : rasterize(geometry, grid, resolved, { boundary, snapTheta });
        H.push(buildOperator(r));
        if (r.stats.free <= minFree) break;
    }
    // Poisson source (level 0 only; coarse levels solve corrections). Off unless the domain carries a charge density.
    if (H.length && dom && typeof dom.charge === 'string' && dom.charge.trim()) H[0].source = chargeSource(H[0], dom.charge, resolved.paramValues || {});
    return H;
}

/**
 * Build the operator of one rasterised level.
 * @param {object} raster
 * @returns {object} Operator
 */
export function buildOperator(raster) {
    const g = raster.grid, nx = g.nx, ny = g.ny, N = g.N, cyl = g.type === 'cyl2d';
    const rowW = new Float64Array(ny), rowN = new Float64Array(ny), rowS = new Float64Array(ny), rowD = new Float64Array(ny), rowInvD = new Float64Array(ny);
    for (let j = 0; j < ny; j++) {
        rowW[j] = 1;
        if (!cyl) { rowN[j] = 1; rowS[j] = 1; rowD[j] = 4; } else if (j === 0) { rowN[j] = 4; rowS[j] = 0; rowD[j] = 6; } else { rowN[j] = 1 + 1 / (2 * j); rowS[j] = 1 - 1 / (2 * j); rowD[j] = 4; }
        rowInvD[j] = 1 / rowD[j];
    }
    const cls = raster.cls, flags = raster.flags;
    const mask = new Uint8Array(N);
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            if (cls[k] !== -1) { mask[k] = 1; continue; }
            const border = i === 0 || i === nx - 1 || j === ny - 1 || (j === 0 && !cyl);
            mask[k] = (border || (flags[k] & FLAG.IRREG)) ? 2 : 0;
            if (!border && i + 1 < nx && i > 0 && j + 1 < ny && (cls[k + 1] === -2 || cls[k - 1] === -2 || cls[k + nx] === -2 || (j > 0 && cls[k - nx] === -2))) mask[k] = 2;
        }
    }
    // irregular list
    let count = 0;
    for (let k = 0; k < N; k++) if (mask[k] === 2) count++;
    const node = new Int32Array(count), nb = new Int32Array(4 * count), c = new Float64Array(4 * count), diag = new Float64Array(count), cutElec = new Int16Array(4 * count);
    const cuts = raster.cuts;
    // per-node cut lookup (cuts are sorted by node, then direction)
    let cp = 0;
    const th = new Float64Array(4), kind = new Uint8Array(4), el = new Int16Array(4), nbi = new Int32Array(4);
    const edges = g.edges;
    let nRed = 0;
    let m = 0;
    for (let k = 0; k < N; k++) {
        if (mask[k] !== 2) continue;
        const i = k % nx, j = (k - i) / nx;
        th[0] = th[1] = th[2] = th[3] = 1;
        el[0] = el[1] = el[2] = el[3] = -1;
        nbi[0] = k + 1; nbi[1] = k - 1; nbi[2] = k + nx; nbi[3] = k - nx;
        kind[0] = i + 1 <= nx - 1 ? ARM_NODE : ARM_GHOST;
        kind[1] = i - 1 >= 0 ? ARM_NODE : ARM_GHOST;
        kind[2] = j + 1 <= ny - 1 ? ARM_NODE : ARM_GHOST;
        kind[3] = j - 1 >= 0 ? ARM_NODE : (cyl ? ARM_NONE : ARM_GHOST);
        while (cp < cuts.count && cuts.node[cp] < k) cp++;
        while (cp < cuts.count && cuts.node[cp] === k) {
            const d = cuts.dir[cp];
            if (!(cyl && j === 0 && d === 3)) { kind[d] = ARM_CUT; th[d] = cuts.theta[cp]; el[d] = cuts.elec[cp]; }
            cp++;
        }
        for (let d = 0; d < 4; d++) if (kind[d] === ARM_NODE && cls[nbi[d]] === -2) kind[d] = ARM_DROP;
        // ghosts mirror the opposite (inward) arm, including its theta and value
        for (let d = 0; d < 4; d++) {
            if (kind[d] !== ARM_GHOST) continue;
            const o = d ^ 1;
            const edgeKey = d === 0 ? 'xmax' : d === 1 ? 'xmin' : d === 2 ? 'ymax' : 'ymin';
            const bc = edges[edgeKey] ? edges[edgeKey].bc : 'neumann';
            if (bc !== 'neumann' && bc !== 'axis') {
                // a free node on a Dirichlet edge cannot occur; treat the missing arm as a mirror for safety
            }
            if (kind[o] === ARM_NODE) { kind[d] = ARM_NODE; nbi[d] = nbi[o]; th[d] = th[o]; } else if (kind[o] === ARM_CUT) { kind[d] = ARM_CUT; th[d] = th[o]; el[d] = el[o]; } else { kind[d] = ARM_DROP; th[d] = 1; }
        }
        const tE = th[0], tW = th[1], tN = th[2], tS = th[3];
        let cE = 2 / (tE * (tE + tW)), cW = 2 / (tW * (tE + tW)), cN, cS;
        if (!cyl) { cN = 2 / (tN * (tN + tS)); cS = 2 / (tS * (tN + tS)); } else if (j === 0) { cN = 4 / (tN * tN); cS = 0; } else { cN = (2 + tS / j) / (tN * (tN + tS)); cS = (2 - tN / j) / (tS * (tN + tS)); }
        const cc = [cE, cW, cN, cS];
        let dg = 0;
        const m4 = 4 * m;
        for (let d = 0; d < 4; d++) {
            let cd = cc[d];
            if (kind[d] === ARM_DROP || kind[d] === ARM_NONE) cd = 0;
            c[m4 + d] = cd;
            nb[m4 + d] = kind[d] === ARM_NODE ? nbi[d] : -1;
            cutElec[m4 + d] = kind[d] === ARM_CUT ? el[d] : -1;
            dg += cd;
        }
        diag[m] = dg;
        node[m] = k;
        if (((i + j) & 1) === 0) nRed++;
        m++;
    }
    const red = new Int32Array(nRed), black = new Int32Array(count - nRed);
    let r = 0, b = 0;
    for (let q = 0; q < count; q++) { const k = node[q], i = k % nx, j = (k - i) / nx; if (((i + j) & 1) === 0) red[r++] = q; else black[b++] = q; }
    return {
        grid: g, raster, cyl, nx, ny, N, level: g.level, h: g.h,
        rowW, rowN, rowS, rowD, rowInvD, mask,
        irr: { count, node, nb, c, diag, cutElec, red, black },
        source: null,   // Poisson source by node (level 0, h^2 scaling, V), set by buildHierarchy when the domain has a charge density
    };
}

/**
 * Right-hand side array for the irregular nodes of `op`.
 * @param {object} op Operator
 * @returns {Float64Array} length op.irr.count
 */
export function newRhs(op) { return new Float64Array(op.irr.count); }

/**
 * Set fixed values and cut right-hand sides for basis k (electrode k at 1 V, everything else 0; mixed
 * weights included). Free nodes are set to 0.
 * @param {object} op Operator
 * @param {number} k electrode index
 * @param {Float64Array} u length N
 * @param {Float64Array} b length op.irr.count
 */
export function basisSetup(op, k, u, b) {
    const N = op.N, cls = op.raster.cls, mix = op.raster.mix;
    if (k < 0) { u.fill(0); b.fill(0); return; }   // the charge basis: every electrode and edge at 0 V
    for (let q = 0; q < N; q++) u[q] = cls[q] === k ? 1 : 0;
    for (let q = 0; q < mix.count; q++) {
        let v = 0;
        if (mix.e[2 * q] === k) v += mix.w[2 * q];
        if (mix.e[2 * q + 1] === k) v += mix.w[2 * q + 1];
        u[mix.node[q]] = v;
    }
    const irr = op.irr;
    for (let m = 0; m < irr.count; m++) {
        let s = 0;
        const m4 = 4 * m;
        for (let d = 0; d < 4; d++) if (irr.cutElec[m4 + d] === k) s += irr.c[m4 + d];
        b[m] = s;
    }
}

/**
 * Fixed values and cut right-hand sides for electrode voltages volts[e] (gnd = 0).
 * @param {object} op Operator
 * @param {ArrayLike<number>} volts by electrode index
 * @param {Float64Array} u length N
 * @param {Float64Array} b length op.irr.count
 */
export function voltageSetup(op, volts, u, b) {
    const N = op.N, cls = op.raster.cls, mix = op.raster.mix;
    const V = (e) => (e >= 0 && e < volts.length ? (+volts[e] || 0) : 0);
    for (let q = 0; q < N; q++) { const e = cls[q]; u[q] = e >= 0 ? V(e) : 0; }
    for (let q = 0; q < mix.count; q++) u[mix.node[q]] = mix.w[2 * q] * V(mix.e[2 * q]) + mix.w[2 * q + 1] * V(mix.e[2 * q + 1]);
    const irr = op.irr;
    for (let m = 0; m < irr.count; m++) {
        let s = 0;
        const m4 = 4 * m;
        for (let d = 0; d < 4; d++) { const e = irr.cutElec[m4 + d]; if (e >= 0) s += irr.c[m4 + d] * V(e); }
        b[m] = s;
    }
}

/**
 * Boundary values from a function: fixed nodes take valueAt(x, y), cut arms valueAt(cut point).
 * Used by the exactness tests on harmonic polynomials.
 * @param {object} op Operator
 * @param {(x: number, y: number) => number} valueAt
 * @param {Float64Array} u length N
 * @param {Float64Array} b length op.irr.count
 */
export function customBoundarySetup(op, valueAt, u, b) {
    const g = op.grid, nx = op.nx, N = op.N, h = g.h, cls = op.raster.cls;
    for (let k = 0; k < N; k++) {
        const i = k % nx, j = (k - i) / nx;
        u[k] = cls[k] >= 0 ? valueAt(g.x0 + i * h, g.y0 + j * h) : 0;
    }
    const irr = op.irr, cuts = op.raster.cuts;
    // theta per cut arm from the raster (cuts sorted by node then direction)
    let cp = 0;
    for (let m = 0; m < irr.count; m++) {
        const k = irr.node[m], i = k % nx, j = (k - i) / nx, x = g.x0 + i * h, y = g.y0 + j * h;
        const th = [1, 1, 1, 1];
        while (cp < cuts.count && cuts.node[cp] < k) cp++;
        while (cp < cuts.count && cuts.node[cp] === k) { th[cuts.dir[cp]] = cuts.theta[cp]; cp++; }
        let s = 0;
        const m4 = 4 * m;
        for (let d = 0; d < 4; d++) {
            if (irr.cutElec[m4 + d] === -1) continue;
            let t = th[d], dd = d;
            if (t === 1 && th[d ^ 1] !== 1 && (d === 0 ? i === nx - 1 : d === 1 ? i === 0 : d === 2 ? j === op.ny - 1 : j === 0)) { t = th[d ^ 1]; dd = d ^ 1; }   // ghost of a cut arm
            const px = x + (dd === 0 ? t * h : dd === 1 ? -t * h : 0), py = y + (dd === 2 ? t * h : dd === 3 ? -t * h : 0);
            s += irr.c[m4 + d] * valueAt(px, py);
        }
        b[m] = s;
    }
}

// ---------------------------------------------------------------- kernels
/**
 * One colour of red-black Gauss-Seidel (omega = 1) without a source term: regular rows, then irregular nodes.
 * @param {object} op Operator
 * @param {Float64Array} u iterate
 * @param {Float64Array|null} b cut right-hand side (irregular positions)
 * @param {0|1} col colour (i + j) & 1
 */
export function gsColor(op, u, b, col) {
    const nx = op.nx, ny = op.ny, mask = op.mask, rN = op.rowN, rS = op.rowS, rI = op.rowInvD;
    if (op.cyl) {
        const i0 = ((1 + col) & 1) === 0 ? 1 : 2;
        for (let i = i0, k = i0; i < nx - 1; i += 2, k += 2) if (mask[k] === 0) u[k] = (u[k - 1] + u[k + 1] + 4 * u[k + nx]) * (1 / 6);
    }
    for (let j = 1; j < ny - 1; j++) {
        const n = rN[j], s = rS[j], inv = rI[j], i0 = ((1 + j + col) & 1) === 0 ? 1 : 2;
        for (let i = i0, k = j * nx + i0; i < nx - 1; i += 2, k += 2) {
            if (mask[k] !== 0) continue;
            u[k] = (u[k - 1] + u[k + 1] + n * u[k + nx] + s * u[k - nx]) * inv;
        }
    }
    irrColor(op, u, b, null, col, 1, null);
}
/**
 * One colour of red-black Gauss-Seidel (omega = 1) with a source f (coarse corrections, preconditioner).
 * @param {object} op Operator
 * @param {Float64Array} u iterate
 * @param {Float64Array|null} b cut right-hand side
 * @param {Float64Array} f source by node (h^2 scaling)
 * @param {0|1} col
 */
export function gsColorF(op, u, b, f, col) {
    const nx = op.nx, ny = op.ny, mask = op.mask, rN = op.rowN, rS = op.rowS, rI = op.rowInvD;
    if (op.cyl) {
        const i0 = ((1 + col) & 1) === 0 ? 1 : 2;
        for (let i = i0, k = i0; i < nx - 1; i += 2, k += 2) if (mask[k] === 0) u[k] = (u[k - 1] + u[k + 1] + 4 * u[k + nx] + f[k]) * (1 / 6);
    }
    for (let j = 1; j < ny - 1; j++) {
        const n = rN[j], s = rS[j], inv = rI[j], i0 = ((1 + j + col) & 1) === 0 ? 1 : 2;
        for (let i = i0, k = j * nx + i0; i < nx - 1; i += 2, k += 2) {
            if (mask[k] !== 0) continue;
            u[k] = (u[k - 1] + u[k + 1] + n * u[k + nx] + s * u[k - nx] + f[k]) * inv;
        }
    }
    irrColor(op, u, b, f, col, 1, null);
}
/**
 * One colour of SOR with relaxation omega; acc collects max |change| and the sum of squared changes.
 * @param {object} op Operator
 * @param {Float64Array} u iterate
 * @param {Float64Array|null} b cut right-hand side
 * @param {Float64Array|null} f source by node
 * @param {0|1} col
 * @param {number} omega
 * @param {Float64Array} acc [max |change|, sum of squares], accumulated
 */
export function sorColor(op, u, b, f, col, omega, acc) {
    const nx = op.nx, ny = op.ny, mask = op.mask, rN = op.rowN, rS = op.rowS, rI = op.rowInvD;
    let mx = acc[0], s2 = acc[1];
    if (op.cyl) {
        const i0 = ((1 + col) & 1) === 0 ? 1 : 2;
        for (let i = i0, k = i0; i < nx - 1; i += 2, k += 2) {
            if (mask[k] !== 0) continue;
            const ub = (u[k - 1] + u[k + 1] + 4 * u[k + nx] + (f !== null ? f[k] : 0)) * (1 / 6);
            const d = omega * (ub - u[k]);
            u[k] += d;
            const a = d < 0 ? -d : d;
            if (a > mx) mx = a;
            s2 += d * d;
        }
    }
    for (let j = 1; j < ny - 1; j++) {
        const n = rN[j], s = rS[j], inv = rI[j], i0 = ((1 + j + col) & 1) === 0 ? 1 : 2;
        if (f === null) {
            for (let i = i0, k = j * nx + i0; i < nx - 1; i += 2, k += 2) {
                if (mask[k] !== 0) continue;
                const d = omega * ((u[k - 1] + u[k + 1] + n * u[k + nx] + s * u[k - nx]) * inv - u[k]);
                u[k] += d;
                const a = d < 0 ? -d : d;
                if (a > mx) mx = a;
                s2 += d * d;
            }
        } else {
            for (let i = i0, k = j * nx + i0; i < nx - 1; i += 2, k += 2) {
                if (mask[k] !== 0) continue;
                const d = omega * ((u[k - 1] + u[k + 1] + n * u[k + nx] + s * u[k - nx] + f[k]) * inv - u[k]);
                u[k] += d;
                const a = d < 0 ? -d : d;
                if (a > mx) mx = a;
                s2 += d * d;
            }
        }
    }
    acc[0] = mx; acc[1] = s2;
    irrColor(op, u, b, f, col, omega, acc);
}
/**
 * Irregular nodes of one colour; b indexed by irregular position, f by node.
 * @param {object} op Operator
 * @param {Float64Array} u
 * @param {Float64Array|null} b
 * @param {Float64Array|null} f
 * @param {0|1} col
 * @param {number} omega
 * @param {Float64Array|null} acc
 */
export function irrColor(op, u, b, f, col, omega, acc) {
    const irr = op.irr, list = col === 0 ? irr.red : irr.black, node = irr.node, nb = irr.nb, c = irr.c, dg = irr.diag;
    let mx = acc ? acc[0] : 0, s2 = acc ? acc[1] : 0;
    for (let q = 0; q < list.length; q++) {
        const m = list[q], k = node[m], m4 = 4 * m;
        let s = b !== null ? b[m] : 0;
        if (f !== null) s += f[k];
        let t = nb[m4]; if (t >= 0) s += c[m4] * u[t];
        t = nb[m4 + 1]; if (t >= 0) s += c[m4 + 1] * u[t];
        t = nb[m4 + 2]; if (t >= 0) s += c[m4 + 2] * u[t];
        t = nb[m4 + 3]; if (t >= 0) s += c[m4 + 3] * u[t];
        const d = omega * (s / dg[m] - u[k]);
        u[k] += d;
        if (acc) { const a = d < 0 ? -d : d; if (a > mx) mx = a; s2 += d * d; }
    }
    if (acc) { acc[0] = mx; acc[1] = s2; }
}

/**
 * Residual r = b + f + sum(c u_nb) - diag u at free nodes (0 at fixed nodes) into `r` (may be null).
 * @param {object} op Operator
 * @param {Float64Array} u
 * @param {Float64Array|null} b
 * @param {Float64Array|null} f
 * @param {Float64Array|null} r output by node, or null
 * @returns {number} max |r| / diag (V)
 */
export function residualInto(op, u, b, f, r) {
    const nx = op.nx, ny = op.ny, mask = op.mask, rN = op.rowN, rS = op.rowS, rD = op.rowD, rI = op.rowInvD;
    let mx = 0;
    if (r !== null) r.fill(0);
    if (op.cyl) {
        for (let i = 1, k = 1; i < nx - 1; i++, k++) {
            if (mask[k] !== 0) continue;
            const v = u[k - 1] + u[k + 1] + 4 * u[k + nx] + (f !== null ? f[k] : 0) - 6 * u[k];
            if (r !== null) r[k] = v;
            const a = (v < 0 ? -v : v) * (1 / 6);
            if (a > mx) mx = a;
        }
    }
    for (let j = 1; j < ny - 1; j++) {
        const n = rN[j], s = rS[j], D = rD[j], inv = rI[j];
        for (let i = 1, k = j * nx + 1; i < nx - 1; i++, k++) {
            if (mask[k] !== 0) continue;
            const v = u[k - 1] + u[k + 1] + n * u[k + nx] + s * u[k - nx] + (f !== null ? f[k] : 0) - D * u[k];
            if (r !== null) r[k] = v;
            const a = (v < 0 ? -v : v) * inv;
            if (a > mx) mx = a;
        }
    }
    const irr = op.irr, node = irr.node, nb = irr.nb, c = irr.c, dg = irr.diag;
    for (let m = 0; m < irr.count; m++) {
        const k = node[m], m4 = 4 * m;
        let s = (b !== null ? b[m] : 0) + (f !== null ? f[k] : 0) - dg[m] * u[k];
        let t = nb[m4]; if (t >= 0) s += c[m4] * u[t];
        t = nb[m4 + 1]; if (t >= 0) s += c[m4 + 1] * u[t];
        t = nb[m4 + 2]; if (t >= 0) s += c[m4 + 2] * u[t];
        t = nb[m4 + 3]; if (t >= 0) s += c[m4 + 3] * u[t];
        if (r !== null) r[k] = s;
        const a = (s < 0 ? -s : s) / dg[m];
        if (a > mx) mx = a;
    }
    return mx;
}

/**
 * Max over free nodes of |r| / diag (V).
 * @param {object} op Operator
 * @param {Float64Array} u
 * @param {Float64Array|null} b
 * @param {Float64Array|null} [f]
 * @returns {number}
 */
export function residualMax(op, u, b, f = null) { return residualInto(op, u, b || null, f, null); }

/**
 * y = A x on free nodes (homogeneous: x must be 0 at fixed nodes); y = 0 at fixed nodes.
 * @param {object} op Operator
 * @param {Float64Array} x
 * @param {Float64Array} y output
 */
export function applyA(op, x, y) {
    const nx = op.nx, ny = op.ny, mask = op.mask, rN = op.rowN, rS = op.rowS, rD = op.rowD;
    y.fill(0);
    if (op.cyl) for (let i = 1, k = 1; i < nx - 1; i++, k++) if (mask[k] === 0) y[k] = 6 * x[k] - (x[k - 1] + x[k + 1] + 4 * x[k + nx]);
    for (let j = 1; j < ny - 1; j++) {
        const n = rN[j], s = rS[j], D = rD[j];
        for (let i = 1, k = j * nx + 1; i < nx - 1; i++, k++) {
            if (mask[k] !== 0) continue;
            y[k] = D * x[k] - (x[k - 1] + x[k + 1] + n * x[k + nx] + s * x[k - nx]);
        }
    }
    const irr = op.irr, node = irr.node, nb = irr.nb, c = irr.c, dg = irr.diag;
    for (let m = 0; m < irr.count; m++) {
        const k = node[m], m4 = 4 * m;
        let s = dg[m] * x[k];
        let t = nb[m4]; if (t >= 0) s -= c[m4] * x[t];
        t = nb[m4 + 1]; if (t >= 0) s -= c[m4 + 1] * x[t];
        t = nb[m4 + 2]; if (t >= 0) s -= c[m4 + 2] * x[t];
        t = nb[m4 + 3]; if (t >= 0) s -= c[m4 + 3] * x[t];
        y[k] = s;
    }
}

export { CUT_EXTERIOR };
