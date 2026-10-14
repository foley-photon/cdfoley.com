/* ==========================================================================
   Ion optics engine: fieldanalysis.js
   Analysis of solved fields: Gauss-law charge on a discrete contour around
   each electrode, the capacitance matrix from the 1 V basis solutions, the
   potential of floating (isolated) conductors from C·V = Q, induced charge
   and current on an electrode by the Shockley–Ramo theorem (the 1 V basis
   solutions are the weighting potentials), amplitude spectra of sampled
   signals, and multipole coefficients of the potential on a circle (planar,
   Fourier series) or on a sphere (cylindrical, Legendre series).

   Discrete Gauss law. On the regular part of the grid the five-point
   (planar) and finite-volume (cylindrical) difference operators conserve
   flux: with the face weights of the dual (control-volume) mesh, the sum of
   (φ_P − φ_Q)·w over the faces leaving any set of regular free nodes is zero.
   The flux through a closed contour drawn between electrodes therefore does
   not depend on where the contour runs, as long as it stays in regular
   cells. Every grid node is assigned to its nearest electrode (a
   breadth-first search from the electrode surfaces, which places the
   contours midway between electrodes), and the flux through the boundary of
   an electrode's region is its charge, Q = ε0 ∮ E·dA. Planar models give the
   charge per metre of depth; mirror planes multiply the result so that it
   covers the whole electrode including its mirror images. Because every
   face flux is added to one region and subtracted from the other, the
   charges of one field sum to zero by construction; that sum is not an
   accuracy check (the reciprocity of the capacitance matrix is one).

   Space charge. A charge density ρ (domain.charge) induces charge on the
   electrodes as well. By Green's reciprocity theorem the charge on
   electrode i is Q_i = −∫ρ φ_i dV, φ_i its unit solution (Jackson §1.13;
   Griffiths, problem 3.50), evaluated over the free cells (cell-centered ρ,
   bilinear φ_i; r-weighted in cylindrical models); the ground takes the rest,
   so that all conductors together carry −∫ρ dV. These charges add to C·V and
   enter the floating-conductor condition C·V = Q − Q_ρ.

   Anti-mirror planes (domain.antimirror). The potential is odd across the
   plane, so the evaluators fold it with the sign flipped (φ and the
   tangential field change sign, the normal field does not). The 1 V basis
   fields of such a model are odd-mode solutions (each electrode at +1 V,
   its image at −1 V): they give the charges of that antisymmetric
   configuration (the plane's own share is reported apart from the ground),
   but not the capacitance matrix or the weighting potentials of the full
   system, which also need the even-mode solutions; those tools refuse.

   Sources: Griffiths, Introduction to Electrodynamics, 4th ed. (2017), §2.2
   (Gauss's law), §2.5.4 (capacitance), §3.4 (multipole expansion); Jackson,
   Classical Electrodynamics, 3rd ed. (1999), §1.11 (coefficients of
   capacitance), §1.13 (Green's reciprocation), §3.3 (Legendre expansion of
   axially symmetric potentials); Shockley, J. Appl. Phys. 9, 635 (1938) and
   Ramo, Proc. IRE 27, 584 (1939) (induced charge and current); Cooley &
   Tukey, Math. Comput. 19, 297 (1965) (fast Fourier transform); Harris,
   Proc. IEEE 66, 51 (1978) (the Hann window and its spectral response);
   Golub & Welsch, Math. Comp. 23, 221 (1969) (Gauss quadrature nodes as the
   eigenvalues of the Jacobi matrix, weights from the eigenvectors);
   Abramowitz & Stegun, Handbook of Mathematical Functions (1964), ch. 8 and
   ch. 22 (Legendre polynomials and their recurrence).
   ========================================================================== */
import { createFieldGrid, combine } from './field.js';
import { FLAG } from './raster.js';
import { EPS0, E_CHARGE } from './constants.js';
import { parseExpr } from './expr.js';
import { chargeSource, CHARGE_BASIS } from './operator.js';
import { S_STRIDE, S_ID, S_SRC, S_SPECIES, M_STRIDE, T_STRIDE } from './layout.js';

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const TWO_PI = 2 * Math.PI;

/** Error with an engine code (schema.EngineError has the same shape). */
function fail(code, message) {
    const e = new Error(message);
    e.name = 'EngineError';
    e.code = code;
    return e;
}

function growI32(a, n) { if (n <= a.length) return a; const b = new Int32Array(Math.max(n, 2 * a.length)); b.set(a); return b; }
function growI16(a, n) { if (n <= a.length) return a; const b = new Int16Array(Math.max(n, 2 * a.length)); b.set(a); return b; }
function growF64(a, n) { if (n <= a.length) return a; const b = new Float64Array(Math.max(n, 2 * a.length)); b.set(a); return b; }

// ====================================================================== charge partition and Gauss flux

/**
 * Assigns every grid node to its nearest electrode and lists the faces of the dual mesh that separate two
 * electrodes' regions (the discrete contours). Depends on the geometry only, so one partition serves every
 * potential field on the same grid.
 *
 * Face weights: planar w = L_f/h (1 inside, 1/2 along a Neumann or mirror edge), so that Σ w·(φ_P − φ_Q) is the
 * line integral of E_n in volts (per metre of depth); cylindrical w = 2π r_f L_f/h in mm (the axis row has the
 * disc-shaped control volume of the finite-volume operator, r_f = h/8), so that the sum is ∮E·dA in V·mm.
 * A sub-cell electrode surface between two nodes (a cut arm at distance θh) is a face from the node to that
 * electrode with weight w/θ.
 * The nodes of an anti-mirror plane are fixed at 0 V like the ground but are not part of it: they form a region of
 * their own with the label `plane` (= nE; −1 without anti-mirror planes), so that the charge the plane takes (the
 * field lines to the image half) is reported apart from the ground's.
 *
 * @param {object} raster0 level-0 raster (grid, cls, flags, cuts, stats)
 * @returns {{ nx: number, ny: number, N: number, h: number, cyl: boolean, nE: number, mirrorFactor: number,
 *   antimirror: { x: boolean, y: boolean }, plane: number,
 *   label: Int16Array, fixedNode: Int32Array, regionNodes: Int32Array, unlabeled: number,
 *   faces: { count: number, p: Int32Array, q: Int32Array, w: Float64Array, e: Int16Array, a: Int16Array, b: Int16Array, irregular: number } }}
 *   regionNodes has one more entry (the plane's) when `plane` ≥ 0.
 */
export function chargePartition(raster0) {
    const g = raster0.grid, nx = g.nx, ny = g.ny, N = nx * ny, h = g.h, cyl = g.type === 'cyl2d';
    const cls = raster0.cls, flags = raster0.flags;
    const E = g.edges || {};
    const isNeu = (k) => !!(E[k] && (E[k].bc === 'neumann' || E[k].bc === 'axis'));
    const neuX0 = isNeu('xmin'), neuX1 = isNeu('xmax'), neuY0 = cyl || isNeu('ymin'), neuY1 = isNeu('ymax');
    const mirror = g.mirror || {};
    const mirrorFactor = (mirror.x ? 2 : 1) * (!cyl && mirror.y ? 2 : 1);

    // cut arms per node: bit d set (0 +x, 1 −x, 2 +y, 3 −y), theta and electrode per (node, direction)
    const cuts = raster0.cuts || { count: 0 };
    const cutMask = new Uint8Array(N);
    const cutRow = new Int32Array(N).fill(-1);
    let nRows = 0;
    for (let q = 0; q < cuts.count; q++) { const k = cuts.node[q]; if (cutRow[k] < 0) cutRow[k] = nRows++; }
    const armTh = new Float64Array(4 * Math.max(1, nRows)).fill(1), armEl = new Int16Array(4 * Math.max(1, nRows)).fill(-1);
    for (let q = 0; q < cuts.count; q++) {
        const k = cuts.node[q], d = cuts.dir[q], r = cutRow[k];
        cutMask[k] |= 1 << d; armTh[4 * r + d] = cuts.theta[q]; armEl[4 * r + d] = cuts.elec[q];
    }
    let nE = Math.max(1, (raster0.stats && raster0.stats.nElectrodes) || 1);
    for (let k = 0; k < N; k++) if (cls[k] + 1 > nE) nE = cls[k] + 1;
    for (let q = 0; q < cuts.count; q++) if (cuts.elec[q] + 1 > nE) nE = cuts.elec[q] + 1;
    // anti-mirror plane nodes (fixed at 0 V, flagged by the raster) get a label of their own
    const am = g.antimirror || {};
    const amOn = !!(am.x || am.y);
    const PLANE = amOn ? nE : -1;

    // ---- labels by breadth-first search from the electrode surfaces (fixed nodes and nodes with a cut arm)
    const label = new Int16Array(N).fill(-1);
    const fixedNode = new Int32Array(nE).fill(-1);
    const queue = new Int32Array(N);
    let qh = 0, qt = 0;
    for (let k = 0; k < N; k++) {
        const c = cls[k];
        if (c >= 0) {
            const onPlane = amOn && c === 0 && (flags[k] & FLAG.ANTIMIRROR) !== 0;
            label[k] = onPlane ? PLANE : c; queue[qt++] = k;
            if (!onPlane && fixedNode[c] < 0 && !(flags[k] & FLAG.MIXED)) fixedNode[c] = k;
        } else if (c === -1 && cutMask[k] !== 0) {
            const r = cutRow[k];
            let best = -1, bt = Infinity;
            for (let d = 0; d < 4; d++) {
                if (!((cutMask[k] >> d) & 1)) continue;
                const e = armEl[4 * r + d];
                if (e >= 0 && armTh[4 * r + d] < bt) { bt = armTh[4 * r + d]; best = e; }
            }
            if (best >= 0) { label[k] = best; queue[qt++] = k; }
        }
    }
    while (qh < qt) {
        const k = queue[qh++], lab = label[k], m = cutMask[k];
        const i = k % nx, j = (k - i) / nx;
        if (i + 1 < nx && !(m & 1)) { const q = k + 1; if (cls[q] === -1 && label[q] < 0 && !(cutMask[q] & 2)) { label[q] = lab; queue[qt++] = q; } }
        if (i > 0 && !(m & 2)) { const q = k - 1; if (cls[q] === -1 && label[q] < 0 && !(cutMask[q] & 1)) { label[q] = lab; queue[qt++] = q; } }
        if (j + 1 < ny && !(m & 4)) { const q = k + nx; if (cls[q] === -1 && label[q] < 0 && !(cutMask[q] & 8)) { label[q] = lab; queue[qt++] = q; } }
        if (j > 0 && !(m & 8)) { const q = k - nx; if (cls[q] === -1 && label[q] < 0 && !(cutMask[q] & 4)) { label[q] = lab; queue[qt++] = q; } }
    }
    const regionNodes = new Int32Array(nE + (amOn ? 1 : 0));
    let unlabeled = 0;
    for (let k = 0; k < N; k++) { const l = label[k]; if (l >= 0) regionNodes[l]++; else if (cls[k] === -1) unlabeled++; }

    // ---- faces of the dual mesh between regions
    const depthX = (j) => {   // face between (i, j) and (i + 1, j): extent of the dual cell in y (× 2πr in cyl2d)
        if (!cyl) return ((j === 0 && neuY0) || (j === ny - 1 && neuY1)) ? 0.5 : 1;
        if (j === 0) return TWO_PI * h / 8;
        if (j === ny - 1 && neuY1) return TWO_PI * h * (j / 2 - 1 / 8);
        return TWO_PI * j * h;
    };
    const depthY = (i, j) => {   // face between (i, j) and (i, j + 1): extent of the dual cell in x (× 2πr in cyl2d)
        const half = ((i === 0 && neuX0) || (i === nx - 1 && neuX1)) ? 0.5 : 1;
        return cyl ? TWO_PI * (j + 0.5) * h * half : half;
    };
    let fp = new Int32Array(1024), fq = new Int32Array(1024), fw = new Float64Array(1024), fe = new Int16Array(1024), fa = new Int16Array(1024), fb = new Int16Array(1024);
    let nf = 0, irregular = 0;
    const push = (p, q, w, e, a, b, irr) => {
        if (nf >= fp.length) { const n2 = 2 * fp.length; fp = growI32(fp, n2); fq = growI32(fq, n2); fw = growF64(fw, n2); fe = growI16(fe, n2); fa = growI16(fa, n2); fb = growI16(fb, n2); }
        fp[nf] = p; fq[nf] = q; fw[nf] = w; fe[nf] = e; fa[nf] = a; fb[nf] = b; nf++;
        if (irr) irregular++;
    };
    for (let k = 0; k < N; k++) {
        const a = label[k];
        if (a < 0) continue;
        const i = k % nx, j = (k - i) / nx, m = cutMask[k];
        const r = m ? cutRow[k] : -1;
        // cut faces: this node's sub-cell surfaces of other electrodes
        if (m) {
            for (let d = 0; d < 4; d++) {
                if (!((m >> d) & 1)) continue;
                const e = armEl[4 * r + d], th = armTh[4 * r + d];
                if (e < 0 || e === a || !(th > 0)) continue;
                push(k, -1, (d < 2 ? depthX(j) : depthY(i, j)) / th, e, a, e, true);
            }
        }
        // regular faces towards +x and +y (each face once); the plane and the ground are both 0 V, so a face between
        // their fixed nodes carries nothing
        if (i + 1 < nx && !(m & 1)) {
            const q = k + 1, b = label[q];
            if (b >= 0 && b !== a && !(cutMask[q] & 2) && !zeroPair(a, b, k, q)) push(k, q, depthX(j), -1, a, b, (m | cutMask[q]) !== 0 || cls[k] >= 0 || cls[q] >= 0);
        }
        if (j + 1 < ny && !(m & 4)) {
            const q = k + nx, b = label[q];
            if (b >= 0 && b !== a && !(cutMask[q] & 8) && !zeroPair(a, b, k, q)) push(k, q, depthY(i, j), -1, a, b, (m | cutMask[q]) !== 0 || cls[k] >= 0 || cls[q] >= 0);
        }
    }
    function zeroPair(a, b, k, q) { return amOn && cls[k] === 0 && cls[q] === 0 && (a === PLANE || b === PLANE); }
    const faces = { count: nf, p: fp.slice(0, nf), q: fq.slice(0, nf), w: fw.slice(0, nf), e: fe.slice(0, nf), a: fa.slice(0, nf), b: fb.slice(0, nf), irregular };
    return { nx, ny, N, h, cyl, nE, mirrorFactor, antimirror: { x: !!am.x, y: !cyl && !!am.y }, plane: PLANE, neumann: { x0: neuX0, x1: neuX1, y0: neuY0, y1: neuY1 },
        label, fixedNode, regionNodes, unlabeled, faces };
}

/**
 * Charge on every electrode for one potential field by Gauss's law on the discrete contours of a partition.
 * `cutValues[e]` is the potential of electrode e in this field (needed only for sub-cell surfaces); by default it is
 * read from a fixed node of the electrode. Planar: coulomb per metre of depth; cylindrical: coulomb. Mirror
 * images are included.
 * @param {object} part from chargePartition
 * @param {Float64Array} phi nodal potential (length N)
 * @param {ArrayLike<number>|null} [cutValues]
 * @returns {{ flux: Float64Array, charge: Float64Array, total: number, plane: number, unit: 'C/m'|'C' }}
 *   flux = Σ w·Δφ per region (V or V·mm; the anti-mirror plane's region last); charge per electrode; plane = the
 *   charge on the anti-mirror plane (0 without one); total = Σ charge (zero by construction, or −plane).
 */
export function gaussCharges(part, phi, cutValues = null) {
    const nE = part.nE, F = part.faces, P = part.plane >= 0 ? part.plane : -1;
    const flux = new Float64Array(nE + (P >= 0 ? 1 : 0));
    let cv = cutValues;
    if (!cv) {
        cv = new Float64Array(nE);
        for (let e = 0; e < nE; e++) { const k = part.fixedNode[e]; cv[e] = k >= 0 ? phi[k] : 0; }
    }
    for (let f = 0; f < F.count; f++) {
        const p = F.p[f], q = F.q[f];
        const d = q >= 0 ? (phi[p] - phi[q]) * F.w[f] : (phi[p] - (+cv[F.e[f]] || 0)) * F.w[f];
        flux[F.a[f]] += d;
        flux[F.b[f]] -= d;
    }
    const scale = EPS0 * part.mirrorFactor * (part.cyl ? 1e-3 : 1);
    const charge = new Float64Array(nE);
    let total = 0;
    for (let e = 0; e < nE; e++) { charge[e] = flux[e] * scale; total += charge[e]; }
    return { flux, charge, total, plane: P >= 0 ? flux[P] * scale : 0, unit: part.cyl ? 'C' : 'C/m' };
}

/** Why the full-system capacitance matrix and weighting potentials are not available on an anti-mirror model. */
export const ANTIMIRROR_NOTE = 'This model has an anti-mirror plane, so its 1 V basis fields are odd-mode solutions (the electrode at +1 V and its image at −1 V). '
    + 'They give the charges of that antisymmetric configuration, but neither the capacitance matrix nor the weighting potentials of the full device, '
    + 'which also need the even-mode solutions: solve the full domain (or use a mirror plane where the device is symmetric) for those.';

/**
 * Capacitance matrix C_ij = charge on electrode i when electrode j is at 1 V and every other at 0 V, from the basis
 * solutions (Map electrode → φ). The column of an electrode without a basis (the ground, index 0) follows from
 * Σ_j C_ij = 0 (all conductors at the same potential give no field) when it is the only one missing.
 * Diagnostics: the reciprocity error max |C_ij − C_ji| / max |C| (the exact matrix is symmetric; the discrete one is
 * symmetric up to the Shortley–Weller cut cells), which measures discretization error, and the largest column sum
 * relative to max |C|, which is zero by construction (round-off only; not an accuracy check).
 * Anti-mirror models: the bases are odd-mode solutions, so the matrix is not C of the full device and the call throws
 * E_UNSUPPORTED (ANTIMIRROR_NOTE) unless opts.allowOddMode; then it returns the odd-mode coefficients (mode 'odd': the
 * charges of the antisymmetric configuration, Q = C·V), the anti-mirror plane's charge per volt of each electrode
 * (planeRow) and the derived column by reciprocity (C_i0 = C_0i; C_00 is unknown, NaN, and never needed with the
 * ground at 0 V).
 * @param {object} part from chargePartition
 * @param {Map<number, Float64Array>} bases
 * @param {{ allowOddMode?: boolean }} [opts]
 * @returns {{ n: number, C: Float64Array, unit: 'F/m'|'F', derived: number, missing: number[], columnSum: number, asymmetry: number,
 *   mode: 'full'|'odd', planeRow: Float64Array|null }}
 */
export function capacitanceMatrix(part, bases, { allowOddMode = false } = {}) {
    const nE = part.nE;
    const odd = part.plane >= 0;
    if (odd && !allowOddMode) throw fail('E_UNSUPPORTED', ANTIMIRROR_NOTE);
    const C = new Float64Array(nE * nE).fill(NaN);
    const planeRow = odd ? new Float64Array(nE).fill(NaN) : null;
    const have = new Uint8Array(nE);
    for (const [k, phi] of bases) {
        // electrode bases only: a charge basis (k < 0, the Poisson particular solution) carries space charge, not electrode charge
        if (!(k >= 0 && k < nE) || !phi) continue;
        const cv = new Float64Array(nE);
        cv[k] = 1;
        const g = gaussCharges(part, phi, cv), q = g.charge;
        for (let i = 0; i < nE; i++) C[i * nE + k] = q[i];
        if (odd) planeRow[k] = g.plane;
        have[k] = 1;
    }
    const missing = [];
    for (let j = 0; j < nE; j++) if (!have[j]) missing.push(j);
    let derived = -1;
    if (missing.length === 1) {
        derived = missing[0];
        for (let i = 0; i < nE; i++) {
            if (odd) { C[i * nE + derived] = i === derived ? NaN : C[derived * nE + i]; continue; }   // reciprocity
            let s = 0;
            for (let j = 0; j < nE; j++) if (j !== derived) s += C[i * nE + j];
            C[i * nE + derived] = -s;
        }
    }
    let cmax = 0, asym = 0, colSum = 0;
    for (let i = 0; i < nE; i++) for (let j = 0; j < nE; j++) { const v = Math.abs(C[i * nE + j]); if (v > cmax) cmax = v; }
    for (let j = 0; j < nE; j++) {
        let s = 0;
        for (let i = 0; i < nE; i++) s += C[i * nE + j];
        if (Math.abs(s) > colSum) colSum = Math.abs(s);
        for (let i = j + 1; i < nE; i++) { const d = Math.abs(C[i * nE + j] - C[j * nE + i]); if (d > asym) asym = d; }
    }
    return { n: nE, C, unit: part.cyl ? 'F' : 'F/m', derived, missing, columnSum: cmax > 0 ? colSum / cmax : 0, asymmetry: cmax > 0 ? asym / cmax : 0,
        mode: odd ? 'odd' : 'full', planeRow };
}

/** Solves A x = b (dense, n ≤ a few dozen) by Gaussian elimination with partial pivoting; null if singular. */
function solveDense(A, b, n) {
    const M = Float64Array.from(A), x = Float64Array.from(b);
    for (let c = 0; c < n; c++) {
        let piv = c, best = Math.abs(M[c * n + c]);
        for (let r = c + 1; r < n; r++) { const v = Math.abs(M[r * n + c]); if (v > best) { best = v; piv = r; } }
        if (!(best > 0)) return null;
        if (piv !== c) {
            for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[piv * n + k]; M[piv * n + k] = t; }
            const t = x[c]; x[c] = x[piv]; x[piv] = t;
        }
        for (let r = c + 1; r < n; r++) {
            const f = M[r * n + c] / M[c * n + c];
            if (f === 0) continue;
            for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
            x[r] -= f * x[c];
        }
    }
    for (let r = n - 1; r >= 0; r--) {
        let s = x[r];
        for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
        x[r] = s / M[r * n + r];
    }
    return x;
}

/**
 * Potentials of floating (isolated) conductors from C·V = Q: the floating electrodes carry the given total charge
 * (0 for an uncharged isolated conductor) and the others are held at `volts`.
 * With a space-charge density, opts.induced holds the charge it induces on every electrode at 0 V (Q_ρ from
 * spaceChargeCharges): the floating rows then solve C·V = Q − Q_ρ, and the returned charges are C·V + Q_ρ.
 * Terms with a zero voltage are skipped, so an unknown entry of C (NaN) that multiplies 0 V does not spoil the sums.
 * @param {{ n: number, C: Float64Array }} cm capacitance matrix
 * @param {ArrayLike<number>} volts known potentials by electrode index (floating entries are ignored)
 * @param {Array<number|{ index: number, charge?: number }>} floating electrodes to float, charge in the matrix's units (C or C/m)
 * @param {{ induced?: ArrayLike<number>|null }} [opts]
 * @returns {{ ok: boolean, volts: Float64Array, charges: Float64Array, induced: Float64Array|null, solved: Array<{ index: number, v: number, charge: number }> }}
 */
export function floatingPotentials(cm, volts, floating, { induced = null } = {}) {
    const n = cm.n, C = cm.C;
    const V = new Float64Array(n);
    for (let i = 0; i < n; i++) V[i] = num(volts[i]);
    const Qr = induced ? Float64Array.from({ length: n }, (_, i) => num(induced[i])) : null;
    const F = (floating || []).map((f) => (typeof f === 'number' ? { index: f, charge: 0 } : { index: num(f && f.index, -1), charge: num(f && f.charge) }))
        .filter((f, i, arr) => f.index >= 0 && f.index < n && arr.findIndex((g) => g.index === f.index) === i);
    const m = F.length;
    let ok = true;
    if (m > 0) {
        const isF = new Uint8Array(n);
        for (const f of F) isF[f.index] = 1;
        const A = new Float64Array(m * m), b = new Float64Array(m);
        for (let r = 0; r < m; r++) {
            const i = F[r].index;
            let s = F[r].charge - (Qr ? Qr[i] : 0);
            for (let j = 0; j < n; j++) if (!isF[j] && V[j] !== 0) s -= C[i * n + j] * V[j];
            b[r] = s;
            for (let c = 0; c < m; c++) A[r * m + c] = C[i * n + F[c].index];
        }
        const x = solveDense(A, b, m);
        if (!x || Array.from(x).some((v) => !Number.isFinite(v))) ok = false;
        else for (let r = 0; r < m; r++) V[F[r].index] = x[r];
    }
    const Q = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < n; j++) if (V[j] !== 0) s += C[i * n + j] * V[j];
        Q[i] = Qr ? s + Qr[i] : s;
    }
    return { ok, volts: V, charges: Q, induced: Qr, solved: F.map((f) => ({ index: f.index, v: ok ? V[f.index] : NaN, charge: f.charge })) };
}

/** True when a solution (its level-0 grid) or a resolved domain has an anti-mirror plane. */
export function antimirrorOf(solution, resolved = null) {
    const g = solution && solution.raster0 && solution.raster0.grid;
    if (g && g.antimirror) return !!(g.antimirror.x || g.antimirror.y);
    const d = resolved && resolved.domain;
    if (!d || !d.antimirror) return false;
    const m = d.mirror || {}, cyl = d.type === 'cyl2d';
    return !!((d.antimirror.x && !m.x) || (!cyl && d.antimirror.y && !m.y));
}

/** Dual-cell (control-volume) weight of node (i, j) consistent with the partition's face weights: area/h² (planar) or volume/h² in mm (cylindrical). */
function dualWeight(part, i, j) {
    const nb = part.neumann || {}, nx = part.nx, ny = part.ny, h = part.h;
    const hx = (i === 0 && nb.x0) || (i === nx - 1 && nb.x1) ? 0.5 : 1;
    if (!part.cyl) return hx * ((j === 0 && nb.y0) || (j === ny - 1 && nb.y1) ? 0.5 : 1);
    if (j === 0) return hx * TWO_PI * h / 8;
    if (j === ny - 1 && nb.y1) return hx * TWO_PI * h * (j / 2 - 1 / 8);
    return hx * TWO_PI * j * h;
}

/**
 * Nodal Poisson source f = h²ρ·1e-6/ε0 (V) of a solution's level-0 grid, exactly as the solver built it
 * (operator.chargeSource); null without a charge density.
 * @param {{ raster0: object }} solution @param {object} resolved
 */
export function poissonSource(solution, resolved) {
    const d = resolved && resolved.domain;
    if (!d || typeof d.charge !== 'string' || !d.charge.trim()) return null;
    const r = solution.raster0, g = r.grid, N = g.nx * g.ny, mask = new Uint8Array(N);
    for (let k = 0; k < N; k++) mask[k] = r.cls[k] !== -1 ? 1 : 0;
    return chargeSource({ grid: g, nx: g.nx, ny: g.ny, cyl: g.type === 'cyl2d', N, mask }, d.charge, resolved.paramValues || {});
}

/**
 * Charges induced on the conductors by the domain's space-charge density (domain.charge, C/m³) with every electrode at
 * 0 V. By Green's reciprocity the charge on electrode i is Q_i = −∫ρ φ_i dV, φ_i its unit solution (basis): the integral
 * runs over the grid cells whose center lies in free space (outside every electrode; without a compiled geometry, the
 * cells with a free corner), with ρ at the cell center and the cell average of the bilinear φ_i (r-weighted in
 * cylindrical models), which is second-order accurate. The ground takes the rest, so that the conductors together carry
 * −∫ρ dV (`space` is ∫ρ dV); on an anti-mirror model the plane takes its share from Gauss's law (below) first.
 * As a cross-check (`gauss`) every region's charge also follows from Gauss's law on the charge basis φ_ρ minus the space
 * charge enclosed by its contour; that estimate misses the half cells next to the electrodes and is first order, so the
 * two differ by the discretization error. Planar: per metre of depth; mirror images included (as gaussCharges).
 * @param {object} part from chargePartition (same raster)
 * @param {{ raster0: object, geometry?: object|null, bases: Map<number, Float64Array> }} solution
 * @param {object} resolved resolved project (domain.charge, paramValues)
 * @returns {null | { charge: Float64Array, plane: number, space: number, unit: 'C/m'|'C', cells: number, gauss: Float64Array|null, planeGauss: number }}
 *   null without a charge density; charge[i] is the charge induced on electrode i (ground included).
 */
export function spaceChargeCharges(part, solution, resolved) {
    const d = resolved && resolved.domain;
    const src = d && typeof d.charge === 'string' ? d.charge.trim() : '';
    if (!src) return null;
    const raster0 = solution.raster0, g = raster0.grid, nx = g.nx, ny = g.ny, h = g.h, x0 = g.x0, y0 = g.y0, cyl = g.type === 'cyl2d';
    const cls = raster0.cls, nE = part.nE;
    const ex = parseExpr(src);
    const vars = Object.create(null);
    const pv = resolved.paramValues || {};
    for (const name of Object.keys(pv)) vars[name] = pv[name];
    vars.z = 0;
    const geo = solution.geometry && typeof solution.geometry.classify === 'function' ? solution.geometry : null;
    const ks = [], phis = [];
    for (const [k, phi] of solution.bases || []) if (k >= 1 && k < nE && phi) { ks.push(k); phis.push(phi); }
    const acc = new Float64Array(ks.length);
    let space = 0, cells = 0;
    for (let j = 0; j < ny - 1; j++) {
        const yc = y0 + (j + 0.5) * h, rj = y0 + j * h;
        // cell average of a bilinear φ: cA·(bottom edge mean) + cB·(top edge mean); in cylindrical models r-weighted,
        // ∫₀¹ (A(1 − t) + B t)(r_j + t h) dt / (r_j + h/2)
        const cA = cyl ? (rj / 2 + h / 6) / (rj + h / 2) : 0.5, cB = cyl ? (rj / 2 + h / 3) / (rj + h / 2) : 0.5;
        const vol = cyl ? TWO_PI * yc : 1;   // cell volume / h² (mm in cylindrical models)
        vars.y = yc; vars.r = yc;
        for (let i = 0; i < nx - 1; i++) {
            const k00 = j * nx + i, k10 = k00 + 1, k01 = k00 + nx, k11 = k01 + 1;
            const xc = x0 + (i + 0.5) * h;
            if (geo) { if (geo.classify(xc, yc) >= 0) continue; }
            else if (cls[k00] !== -1 && cls[k10] !== -1 && cls[k01] !== -1 && cls[k11] !== -1) continue;
            vars.x = xc;
            const rho = ex.evaluate(vars);
            if (!Number.isFinite(rho)) throw fail('E_NOT_FINITE', `The charge density is not finite at (${xc}, ${yc}).`);
            if (rho === 0) continue;
            const q = rho * vol;
            space += q; cells++;
            for (let m = 0; m < ks.length; m++) {
                const p = phis[m];
                acc[m] += q * (cA * 0.5 * (p[k00] + p[k10]) + cB * 0.5 * (p[k01] + p[k11]));
            }
        }
    }
    const s = h * h * (cyl ? 1e-9 : 1e-6) * part.mirrorFactor;   // C (cylindrical) or C/m (planar)
    const charge = new Float64Array(nE);
    let sumE = 0;
    for (let m = 0; m < ks.length; m++) { charge[ks[m]] = -acc[m] * s; sumE += charge[ks[m]]; }
    // Gauss's law on the charge basis minus the enclosed space charge (first order; the anti-mirror plane's share)
    let gauss = null, planeGauss = 0;
    const phiRho = solution.bases ? solution.bases.get(CHARGE_BASIS) : null;
    if (phiRho) {
        const f = poissonSource(solution, resolved);
        const gq = gaussCharges(part, phiRho, new Float64Array(nE));
        const enc = new Float64Array(nE + 1);
        if (f) {
            for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
                const k = j * nx + i, l = part.label[k];
                if (l < 0 || cls[k] !== -1 || f[k] === 0) continue;
                enc[l === part.plane ? nE : l] += f[k] * dualWeight(part, i, j);
            }
        }
        const sc = EPS0 * part.mirrorFactor * (part.cyl ? 1e-3 : 1);
        gauss = new Float64Array(nE);
        for (let e = 0; e < nE; e++) gauss[e] = gq.charge[e] - enc[e] * sc;
        planeGauss = part.plane >= 0 ? gq.plane - enc[nE] * sc : 0;
    }
    const plane = part.plane >= 0 ? planeGauss : 0;
    charge[0] = -space * s - sumE - plane;
    return { charge, plane, space: space * s, unit: part.cyl ? 'C' : 'C/m', cells, gauss, planeGauss };
}

// ====================================================================== potential evaluators

/**
 * Evaluates one or more nodal potentials anywhere in the model (plane and 3D coordinates) with the same C¹
 * interpolant the particles see, folding mirrored halves and the cylindrical mapping like the field model.
 * Across a mirror plane the potential is even (the normal field flips); across an anti-mirror plane it is odd (φ and
 * the tangential field flip, the normal field does not), as in fieldmodel.js.
 * channels: [{ phi: Float64Array(N), cut: ArrayLike(nE) | null }], cut = the electrode potentials of that field
 * (needed at sub-cell surfaces: 1 at the own electrode for a basis, the voltages for a combined potential).
 * @param {{ raster0: object, geometry?: object|null, domain?: object|null, channels: Array<{ phi: Float64Array, cut?: ArrayLike<number>|null }>, interp?: 'cubic'|'linear' }} spec
 * @returns {{ nChannels: number, cyl: boolean, mirror: { x: boolean, y: boolean }, antimirror: { x: boolean, y: boolean }, h: number, bounds: object, interp: string,
 *   evalPlane(x: number, y: number, out: Float64Array): number, eval3(x: number, y: number, z: number, out: Float64Array): number,
 *   potential(c: number, x: number, y: number, z?: number): number, field(c: number, x: number, y: number, z: number, out3: Float64Array): Float64Array, bytes(): number }}
 */
export function createPotentialEvaluator({ raster0, geometry = null, domain = null, channels, interp = 'cubic' }) {
    if (!raster0 || !raster0.grid) throw fail('E_UNSUPPORTED', 'A level-0 raster is needed to evaluate potentials.');
    if (!Array.isArray(channels) || channels.length === 0) throw fail('E_UNSUPPORTED', 'No potential to evaluate.');
    const grid = createFieldGrid(raster0, geometry, { interp });
    grid.setChannels(channels.map((c) => c.phi), channels.map((c) => c.cut || null));
    const g = raster0.grid, cyl = g.type === 'cyl2d';
    const mirror = (domain && domain.mirror) || g.mirror || {};
    const anti = (domain && domain.antimirror) || g.antimirror || {};
    const mx = !!mirror.x, my = !cyl && !!mirror.y;
    const amx = !mx && !!anti.x, amy = !cyl && !my && !!anti.y;
    const fx = mx || amx, fy = my || amy;   // folded axes
    const C = channels.length;
    const buf = new Float64Array(3 * C), tmp = new Float64Array(4 * C);
    /** Plane coordinates (x, y or x, ρ): out = φ, E_x, E_y per channel (mirror signs restored); returns the cell type. */
    function evalPlane(x, y, out) {
        const nX = fx && x < 0, nY = fy && y < 0;
        const where = grid.evalChannels(nX ? -x : x, nY ? -y : y, out);
        if (nX || nY) {
            // sign of φ (odd reflections) and of each field component (times the reflection of its own axis)
            const sP = (amx && nX ? -1 : 1) * (amy && nY ? -1 : 1), sX = nX ? -sP : sP, sY = nY ? -sP : sP;
            for (let c = 0; c < C; c++) { out[3 * c] *= sP; out[3 * c + 1] *= sX; out[3 * c + 2] *= sY; }
        }
        return where;
    }
    /** 3D point: out = φ, E_x, E_y, E_z per channel (E = −∇φ per unit of the channel); returns the cell type (3 = outside). */
    function eval3(x, y, z, out) {
        const nX = fx && x < 0;
        let Y, rho = 0, nY = false;
        if (cyl) { rho = Math.sqrt(y * y + z * z); Y = rho; } else { nY = fy && y < 0; Y = nY ? -y : y; }
        const where = grid.evalChannels(nX ? -x : x, Y, buf);
        const sP = (amx && nX ? -1 : 1) * (amy && nY ? -1 : 1), sX = nX ? -sP : sP, sY = nY ? -sP : sP;
        for (let c = 0; c < C; c++) {
            const ex = sX * buf[3 * c + 1], ey = buf[3 * c + 2];
            out[4 * c] = sP * buf[3 * c]; out[4 * c + 1] = ex;
            if (cyl) {
                if (rho >= 1e-12) { const s = sP * ey / rho; out[4 * c + 2] = s * y; out[4 * c + 3] = s * z; } else { out[4 * c + 2] = 0; out[4 * c + 3] = 0; }
            } else { out[4 * c + 2] = sY * ey; out[4 * c + 3] = 0; }
        }
        return where;
    }
    function potential(c, x, y, z = 0) { eval3(x, y, z, tmp); return tmp[4 * c]; }
    function field(c, x, y, z, out3) { eval3(x, y, z, tmp); out3[0] = tmp[4 * c + 1]; out3[1] = tmp[4 * c + 2]; out3[2] = tmp[4 * c + 3]; return out3; }
    return { nChannels: C, cyl, mirror: { x: mx, y: my }, antimirror: { x: amx, y: amy }, h: g.h, bounds: grid.bounds, interp: grid.interp, evalPlane, eval3, potential, field, bytes: () => grid.bytes() };
}

/**
 * Weighting potentials of the given electrodes (their 1 V basis solutions) as an evaluator with one channel per
 * electrode; `ev.electrodes` lists them and `ev.channelOf(k)` gives the channel of electrode k (−1 if absent).
 * @param {{ raster0: object, geometry?: object, bases: Map<number, Float64Array> }} solution
 * @param {object} resolved resolved project (electrodes, domain)
 * @param {number[]} electrodes electrode indices
 * @param {{ interp?: 'cubic'|'linear' }} [opts]
 * @throws {EngineError} E_UNSUPPORTED on anti-mirror models (ANTIMIRROR_NOTE): their bases are odd-mode solutions,
 *   not weighting potentials
 */
export function weightingPotentials(solution, resolved, electrodes, { interp = 'cubic' } = {}) {
    if (antimirrorOf(solution, resolved)) throw fail('E_UNSUPPORTED', ANTIMIRROR_NOTE);
    const nE = Math.max(1, resolved && resolved.electrodes ? resolved.electrodes.length : 1, (solution.raster0.stats && solution.raster0.stats.nElectrodes) || 1);
    const ks = (electrodes || []).filter((k) => solution.bases && solution.bases.has(k));
    if (!ks.length) throw fail('E_UNSUPPORTED', 'None of the requested electrodes has a solved basis field.');
    const channels = ks.map((k) => { const cut = new Float64Array(nE); cut[k] = 1; return { phi: solution.bases.get(k), cut }; });
    const ev = createPotentialEvaluator({ raster0: solution.raster0, geometry: solution.geometry || null, domain: resolved ? resolved.domain : null, channels, interp });
    ev.electrodes = ks;
    ev.channelOf = (k) => ks.indexOf(k);
    return ev;
}

/**
 * Evaluator of one combined potential Σ_k V_k φ_k (cut values = the voltages).
 * @param {{ raster0: object, geometry?: object, bases: Map<number, Float64Array> }} solution
 * @param {object} resolved
 * @param {ArrayLike<number>} volts by electrode index
 * @param {{ interp?: 'cubic'|'linear' }} [opts]
 */
export function voltageEvaluator(solution, resolved, volts, { interp = 'cubic' } = {}) {
    const N = solution.raster0.grid.N;
    const phi = combine(solution.bases, volts, N);
    const nE = Math.max(volts.length, resolved && resolved.electrodes ? resolved.electrodes.length : 0);
    const cut = new Float64Array(nE);
    for (let e = 0; e < volts.length; e++) cut[e] = +volts[e] || 0;
    return createPotentialEvaluator({ raster0: solution.raster0, geometry: solution.geometry || null, domain: resolved ? resolved.domain : null, channels: [{ phi, cut }], interp });
}

/** (x, y) → φ_c at a plane point (the sampler the multipole functions take). */
export function potentialSampler(ev, c = 0) {
    const out = new Float64Array(3 * ev.nChannels);
    return (x, y) => { ev.evalPlane(x, y, out); return out[3 * c]; };
}

// ====================================================================== Shockley–Ramo induced charge and current

/**
 * Induced charge Q_k = −q φ_k(x) (coulomb) on the electrode of channel c for a particle of charge chargeE (e) at (x, y, z);
 * NaN outside the model. On the electrode itself φ_k = 1 and Q_k = −q: the particle's charge has arrived.
 */
export function inducedCharge(ev, c, chargeE, x, y, z = 0) {
    return -chargeE * E_CHARGE * ev.potential(c, x, y, z);
}

const E3 = new Float64Array(3);
/**
 * Induced current i_k = q v·E_w (ampere) with the weighting field E_w = −∇φ_k (1/mm) and v in mm/µs (Ramo's theorem).
 * Equals dQ_k/dt along the trajectory.
 */
export function inducedCurrent(ev, c, chargeE, x, y, z, vx, vy, vz) {
    ev.field(c, x, y, z, E3);
    return chargeE * E_CHARGE * (vx * E3[0] + vy * E3[1] + vz * E3[2]) * 1e6;
}

/** Derivative of y(t) on a (possibly non-uniform) grid: three-point Lagrange formula, one-sided at the ends. */
export function differentiate(t, y) {
    const n = t.length, out = new Float64Array(n);
    if (n < 2) return out;
    for (let i = 0; i < n; i++) {
        if (i === 0) { const d = t[1] - t[0]; out[0] = d !== 0 ? (y[1] - y[0]) / d : 0; continue; }
        if (i === n - 1) { const d = t[i] - t[i - 1]; out[i] = d !== 0 ? (y[i] - y[i - 1]) / d : 0; continue; }
        const t0 = t[i - 1], t1 = t[i], t2 = t[i + 1];
        const d01 = t0 - t1, d02 = t0 - t2, d12 = t1 - t2;
        if (d01 === 0 || d02 === 0 || d12 === 0) { out[i] = (y[i + 1] - y[i - 1]) / ((t2 - t0) || 1); continue; }
        out[i] = y[i - 1] * d12 / (d01 * d02) + y[i] * (d12 - d01) / (d01 * d12) * -1 + y[i + 1] * d01 / (d02 * d12) * -1;
    }
    return out;
}

/**
 * Induced charge and current along a sampled path { t, x, y, z, vx?, vy?, vz? } (µs, mm, mm/µs). The current comes
 * from Ramo's theorem when velocities are given, else from the time derivative of the charge samples.
 * @returns {{ t: Float64Array, charge: Float64Array, current: Float64Array, method: 'velocity'|'difference', n: number }}
 */
export function inducedSeries(ev, c, chargeE, path) {
    const n = path.t.length;
    const t = Float64Array.from(path.t), Q = new Float64Array(n);
    const hasV = path.vx && path.vy && path.vz && path.vx.length === n;
    const I = hasV ? new Float64Array(n) : null;
    for (let i = 0; i < n; i++) {
        const x = path.x[i], y = path.y[i], z = path.z ? path.z[i] : 0;
        Q[i] = inducedCharge(ev, c, chargeE, x, y, z);
        if (hasV) I[i] = inducedCurrent(ev, c, chargeE, x, y, z, path.vx[i], path.vy[i], path.vz[i]);
    }
    let current;
    if (hasV) current = I;
    else { current = differentiate(t, Q); for (let i = 0; i < n; i++) current[i] *= 1e6; }   // C/µs → A
    return { t, charge: Q, current, method: hasV ? 'velocity' : 'difference', n };
}

/** Linear interpolation of a series onto a grid: 0 before the first sample, the last value after the last one. */
function resampleHold(ts, ys, grid, out) {
    const n = ts.length;
    let j = 0;
    for (let i = 0; i < grid.length; i++) {
        const tt = grid[i];
        if (n === 0 || tt < ts[0]) continue;
        if (tt >= ts[n - 1]) { out[i] += ys[n - 1]; continue; }
        while (j < n - 2 && ts[j + 1] <= tt) j++;
        const d = ts[j + 1] - ts[j];
        out[i] += d > 0 ? ys[j] + (ys[j + 1] - ys[j]) * (tt - ts[j]) / d : ys[j];
    }
}

/**
 * Induced charge and current on the electrode of channel c from a run: per particle from its time markers
 * (uniform sampling, preferred) or its stored trajectory points, and the total over all selected particles on a
 * common uniform time grid (a particle contributes 0 before its birth and keeps its final value after it ends:
 * on an electrode the weighting potential is 0 or 1, so the charge has arrived or left).
 * @param {object} ev evaluator from weightingPotentials
 * @param {number} c channel
 * @param {object} result TraceResult (summary, markers, traj)
 * @param {object} resolved resolved project (species charges)
 * @param {{ source?: 'auto'|'markers'|'trajectories', ids?: number[]|null, maxSeries?: number, maxTotalSamples?: number }} [opts]
 * @returns {{ source: string, particles: Array<{ id: number, chargeE: number, t: Float64Array, charge: Float64Array, current: Float64Array, n: number, method: string }>,
 *   total: null | { t: Float64Array, charge: Float64Array, current: Float64Array, dt: number, n: number }, count: number, dt: number|null, skipped: number }}
 */
export function inducedFromResult(ev, c, result, resolved, { source = 'auto', ids = null, maxSeries = Infinity, maxTotalSamples = 16384 } = {}) {
    const S = result.summary, n = result.n | 0;
    const want = ids ? new Set(ids) : null;
    const chargeOf = (i) => {
        const o = i * S_STRIDE;
        const src = resolved && resolved.sources ? resolved.sources[S[o + S_SRC] | 0] : null;
        const sp = src && Array.isArray(src.species) ? src.species[S[o + S_SPECIES] | 0] : null;
        return sp && Number.isFinite(sp.charge) ? sp.charge : 1;
    };
    const hasMarkers = !!(result.markers && result.markers.length >= M_STRIDE);
    const hasTraj = !!(result.traj && result.traj.pts && result.traj.offsets);
    let src = source === 'auto' ? (hasMarkers ? 'markers' : (hasTraj ? 'trajectories' : 'none')) : source;
    if (src === 'markers' && !hasMarkers) src = 'none';
    if (src === 'trajectories' && !hasTraj) src = 'none';
    const particles = [];
    let skipped = 0;
    if (src === 'markers') {
        const M = result.markers, byId = new Map();
        for (let k = 0; k + M_STRIDE - 1 < M.length; k += M_STRIDE) {
            const id = M[k];
            if (want && !want.has(id)) continue;
            let a = byId.get(id);
            if (!a) { a = { t: [], x: [], y: [], z: [] }; byId.set(id, a); }
            a.t.push(M[k + 1]); a.x.push(M[k + 2]); a.y.push(M[k + 3]); a.z.push(M[k + 4]);
        }
        for (let i = 0; i < n; i++) {
            const id = S[i * S_STRIDE + S_ID];
            const a = byId.get(id);
            if (!a) continue;
            if (particles.length >= maxSeries) { skipped++; continue; }
            const qE = chargeOf(i);
            particles.push({ id, chargeE: qE, ...inducedSeries(ev, c, qE, a) });
        }
    } else if (src === 'trajectories') {
        const off = result.traj.offsets, P = result.traj.pts;
        for (let i = 0; i < n; i++) {
            const id = S[i * S_STRIDE + S_ID];
            if (want && !want.has(id)) continue;
            const a0 = off[i], a1 = off[i + 1];
            if (a1 - a0 < 2) continue;
            if (particles.length >= maxSeries) { skipped++; continue; }
            const m = a1 - a0, t = new Float64Array(m), x = new Float64Array(m), y = new Float64Array(m), z = new Float64Array(m);
            for (let k = 0; k < m; k++) { const b = T_STRIDE * (a0 + k); x[k] = P[b]; y[k] = P[b + 1]; z[k] = P[b + 2]; t[k] = P[b + 3]; }
            const qE = chargeOf(i);
            particles.push({ id, chargeE: qE, ...inducedSeries(ev, c, qE, { t, x, y, z }) });
        }
    }
    let total = null, dt = null;
    if (particles.length) {
        let tMin = Infinity, tMax = -Infinity, nAll = 0, best = null;
        for (const p of particles) {
            if (p.n === 0) continue;
            tMin = Math.min(tMin, p.t[0]); tMax = Math.max(tMax, p.t[p.n - 1]);
            if (p.n >= 2 && (!best || p.n > best.n)) best = p;
            nAll += p.n;
        }
        // markers share one interval: its mean spacing over the longest series averages out the single-precision rounding of the stored times
        if (src === 'markers' && best && best.t[best.n - 1] > best.t[0]) dt = (best.t[best.n - 1] - best.t[0]) / (best.n - 1);
        else dt = (tMax - tMin) / Math.max(1, Math.min(maxTotalSamples, nAll) - 1);
        if (!(dt > 0) || !(tMax > tMin)) dt = 1;
        let m = Math.floor((tMax - tMin) / dt + 1e-9) + 1;
        if (m > maxTotalSamples) { m = maxTotalSamples; dt = (tMax - tMin) / (m - 1); }
        const t = new Float64Array(m), Q = new Float64Array(m), I = new Float64Array(m);
        for (let i = 0; i < m; i++) t[i] = tMin + i * dt;
        for (const p of particles) { resampleHold(p.t, p.charge, t, Q); resampleHold(p.t, p.current, t, I); }
        total = { t, charge: Q, current: I, dt, n: m };
    }
    return { source: src, particles, total, count: particles.length, dt, skipped };
}

// ====================================================================== spectra

/**
 * In-place radix-2 Cooley–Tukey FFT (forward, unnormalised); the length must be a power of two.
 * @param {Float64Array} re @param {Float64Array} im
 */
export function fft(re, im) {
    const n = re.length;
    if (n < 2 || (n & (n - 1)) !== 0 || im.length !== n) throw fail('E_UNSUPPORTED', 'The FFT length must be a power of two.');
    for (let i = 1, j = 0; i < n; i++) {   // bit reversal
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -TWO_PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k, b = a + len / 2;
                const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr; im[b] = im[a] - ti;
                re[a] += tr; im[a] += ti;
                const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
            }
        }
    }
}

/**
 * Single-sided amplitude spectrum of a uniformly sampled signal y(t) (t in µs → frequencies in MHz): the first
 * 2^m samples, mean removed, a Hann window by default (amplitudes scaled so that a sinusoid at a bin center keeps
 * its amplitude), and the peak refined from the three bins a₋, a₀, a₊ around the maximum with the window's own
 * response. For a tone δ bins from bin k the Hann magnitudes are proportional to |sinc(δ − m)|/|1 − (δ − m)²|
 * (Harris 1978), so a₊/a₀ = (1 + δ)/(2 − δ) and a₋/a₀ = (1 − δ)/(2 + δ), which give exactly
 * δ = 2(a₊ − a₋)/(a₋ + 2a₀ + a₊) and the amplitude a₀(1 − δ²)/sinc(δ); without a window (|sinc| response)
 * δ = ±a±/(a₀ + a±) toward the larger neighbor and the amplitude a₀/sinc(δ). For a clean tone the peak is then
 * exact to about 1e-9 bin and 1e-8 in amplitude at 1024 samples; other components and noise limit it in practice.
 * @param {ArrayLike<number>} t @param {ArrayLike<number>} y
 * @param {{ window?: 'hann'|'none', detrend?: boolean }} [opts]
 * @returns {{ n: number, dt: number, df: number, freq: Float64Array, amp: Float64Array, peak: { bin: number, freq: number, amp: number, offset: number }, window: string }}
 *   peak.offset is δ in bins (|δ| ≤ 1/2).
 */
export function spectrum(t, y, { window = 'hann', detrend = true } = {}) {
    const nIn = Math.min(t.length, y.length);
    if (nIn < 4) throw fail('E_UNSUPPORTED', 'At least four samples are needed for a spectrum.');
    const dt = (t[nIn - 1] - t[0]) / (nIn - 1);
    if (!(dt > 0)) throw fail('E_UNSUPPORTED', 'The samples must increase in time.');
    let worst = 0;
    for (let i = 0; i < nIn; i++) { const d = Math.abs(t[i] - (t[0] + i * dt)); if (d > worst) worst = d; }
    if (worst > 1e-6 * (t[nIn - 1] - t[0])) throw fail('E_UNSUPPORTED', 'The samples are not uniform in time; use time markers for a spectrum.');
    let n = 1;
    while (n * 2 <= nIn) n *= 2;
    const re = new Float64Array(n), im = new Float64Array(n);
    let mean = 0;
    if (detrend) { for (let i = 0; i < n; i++) mean += y[i]; mean /= n; }
    let wsum = 0;
    for (let i = 0; i < n; i++) {
        const w = window === 'hann' ? 0.5 * (1 - Math.cos(TWO_PI * i / n)) : 1;
        re[i] = (y[i] - mean) * w;
        wsum += w;
    }
    fft(re, im);
    const half = n / 2;
    const freq = new Float64Array(half), amp = new Float64Array(half);
    const df = 1 / (n * dt);
    for (let j = 0; j < half; j++) { freq[j] = j * df; amp[j] = (j === 0 ? 1 : 2) * Math.sqrt(re[j] * re[j] + im[j] * im[j]) / wsum; }
    let jb = 1;
    for (let j = 2; j < half; j++) if (amp[j] > amp[jb]) jb = j;
    let fPeak = freq[jb], aPeak = amp[jb], off = 0;
    if (jb > 0 && jb + 1 < half) {
        const am = amp[jb - 1], a0 = amp[jb], ap = amp[jb + 1];
        let d = 0;
        if (window === 'hann') { const den = am + 2 * a0 + ap; d = den > 0 ? 2 * (ap - am) / den : 0; }
        else if (ap >= am) d = a0 + ap > 0 ? ap / (a0 + ap) : 0;
        else d = a0 + am > 0 ? -am / (a0 + am) : 0;
        d = Math.max(-0.5, Math.min(0.5, d));
        const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
        off = d; fPeak = (jb + d) * df;
        aPeak = window === 'hann' ? a0 * (1 - d * d) / sinc : a0 / sinc;
    }
    return { n, dt, df, freq, amp, peak: { bin: jb, freq: fPeak, amp: aPeak, offset: off }, window: window === 'hann' ? 'hann' : 'none' };
}

// ====================================================================== multipole coefficients

/** Legendre polynomial P_n(x) by the three-term recurrence. */
export function legendreP(n, x) {
    if (n === 0) return 1;
    let p0 = 1, p1 = x;
    for (let k = 1; k < n; k++) { const p2 = ((2 * k + 1) * x * p1 - k * p0) / (k + 1); p0 = p1; p1 = p2; }
    return p1;
}

/**
 * Gauss–Legendre nodes and weights on [−1, 1] from the Golub–Welsch characterization (Math. Comp. 23, 221 (1969)):
 * the nodes are the eigenvalues of the symmetric tridiagonal Jacobi matrix J of the Legendre three-term recurrence
 * (zero diagonal, off-diagonal β_k = k/√(4k² − 1), k = 1 … n − 1), and each weight is μ₀ = ∫dx = 2 times the squared
 * first component of the normalized eigenvector. Eigenvalues: bisection on Sturm counts (the number of negative
 * pivots d₀ = −λ, d_k = −λ − β_k²/d_{k−1} of J − λI is the number of eigenvalues below λ). Eigenvectors: the one of λ
 * is (q₀(λ), …, q_{n−1}(λ)) with the orthonormal polynomials of the same recurrence (q₀ = 1/√2,
 * β_{k+1} q_{k+1} = λ q_k − β_k q_{k−1}), so the weight is μ₀ q₀²/Σ q_k² = 1/Σ q_k². The rule is symmetric, so only
 * the nonnegative nodes are computed (an odd rule has the node 0 exactly).
 * @param {number} n number of nodes (≥ 1)
 * @returns {{ x: Float64Array, w: Float64Array }} ascending nodes and their weights
 */
export function gaussLegendre(n) {
    n = Math.max(1, Math.floor(n));
    const x = new Float64Array(n), w = new Float64Array(n);
    const beta = new Float64Array(n), beta2 = new Float64Array(n);
    for (let k = 1; k < n; k++) { beta2[k] = k * k / (4 * k * k - 1); beta[k] = Math.sqrt(beta2[k]); }
    /** Sturm count: eigenvalues of J below lam. */
    const below = (lam) => {
        let d = -lam, count = d < 0 ? 1 : 0;
        for (let k = 1; k < n; k++) {
            d = -lam - beta2[k] / (d !== 0 ? d : 1e-300);
            if (d < 0) count++;
        }
        return count;
    };
    /** Christoffel number of a node: 1/Σ q_k(lam)². */
    const weightAt = (lam) => {
        let qPrev = 0, q = Math.SQRT1_2, s = 0.5;   // q₀² = 1/μ₀ exactly
        for (let k = 0; k + 1 < n; k++) {
            const qNext = (lam * q - (k > 0 ? beta[k] * qPrev : 0)) / beta[k + 1];
            qPrev = q; q = qNext; s += q * q;
        }
        return 1 / s;
    };
    const half = n >> 1;
    if (n % 2 === 1) { x[half] = 0; w[half] = weightAt(0); }
    // the m-th smallest eigenvalue (ascending index m) for the upper half, m = n − half … n − 1, all in (0, 1)
    for (let m = n - half; m < n; m++) {
        let lo = 0, hi = 1;
        for (let it = 0; it < 200; it++) {
            const mid = 0.5 * (lo + hi);
            if (mid <= lo || mid >= hi) break;
            if (below(mid) > m) hi = mid; else lo = mid;
        }
        const lam = 0.5 * (lo + hi);
        x[m] = lam; x[n - 1 - m] = -lam;
        w[m] = weightAt(lam); w[n - 1 - m] = w[m];
    }
    return { x, w };
}

/**
 * Fourier multipole coefficients of a planar potential on the circle of radius R about (cx, cy):
 * φ(r, θ) = a₀ + Σ_{n≥1} (r/r0)^n (a_n cos nθ + b_n sin nθ), θ from +x. The sampler gives φ(x, y) in plane
 * coordinates (mirrored halves are folded by the evaluator's sampler). A quadrupole with its rods at ±V on the
 * reference radius r0 has a₂ = V.
 * @param {(x: number, y: number) => number} phiAt
 * @param {{ cx?: number, cy?: number, R: number, r0?: number, nMax?: number, samples?: number }} opts
 * @returns {{ kind: 'circle', cx: number, cy: number, R: number, r0: number, nMax: number, samples: number, a: Float64Array, b: Float64Array, c: Float64Array, phase: Float64Array, residual: number, theta: Float64Array, phi: Float64Array }}
 */
export function multipoleCircle(phiAt, { cx = 0, cy = 0, R, r0 = R, nMax = 12, samples = 360 } = {}) {
    if (!(R > 0) || !(r0 > 0)) throw fail('E_UNSUPPORTED', 'The sampling and reference radii must be positive.');
    const M = Math.max(8, Math.floor(samples));
    const nM = Math.max(0, Math.min(Math.floor(nMax), (M >> 1) - 1));
    const theta = new Float64Array(M), phi = new Float64Array(M);
    let bad = 0;
    for (let m = 0; m < M; m++) {
        const th = TWO_PI * m / M;
        theta[m] = th;
        const v = phiAt(cx + R * Math.cos(th), cy + R * Math.sin(th));
        phi[m] = v;
        if (!Number.isFinite(v)) bad++;
    }
    if (bad) throw fail('E_UNSUPPORTED', `${bad} of ${M} sample points lie outside the solved domain; move the circle or shrink it.`);
    const a = new Float64Array(nM + 1), b = new Float64Array(nM + 1), c = new Float64Array(nM + 1), phase = new Float64Array(nM + 1);
    for (let n = 0; n <= nM; n++) {
        let sa = 0, sb = 0;
        for (let m = 0; m < M; m++) { sa += phi[m] * Math.cos(n * theta[m]); sb += phi[m] * Math.sin(n * theta[m]); }
        const scale = (n === 0 ? 1 : 2) / M / Math.pow(R / r0, n);
        a[n] = sa * scale; b[n] = n === 0 ? 0 : sb * scale;
        c[n] = Math.hypot(a[n], b[n]);
        phase[n] = n === 0 ? 0 : Math.atan2(b[n], a[n]) * 180 / Math.PI;
    }
    let res = 0;
    for (let m = 0; m < M; m++) {
        let s = a[0];
        for (let n = 1; n <= nM; n++) { const rn = Math.pow(R / r0, n); s += rn * (a[n] * Math.cos(n * theta[m]) + b[n] * Math.sin(n * theta[m])); }
        res += (phi[m] - s) * (phi[m] - s);
    }
    return { kind: 'circle', cx, cy, R, r0, nMax: nM, samples: M, a, b, c, phase, residual: Math.sqrt(res / M), theta, phi };
}

/**
 * Legendre multipole coefficients of an axially symmetric potential on the sphere of radius R about the axis point
 * (cx, 0): φ(r, θ) = Σ_n c_n (r/r0)^n P_n(cos θ), θ the polar angle from +x. Sampled at Gauss–Legendre nodes in
 * cos θ (exact projection for polynomial content up to degree 2·samples − 1). The sampler gives φ(x, ρ).
 * @param {(x: number, rho: number) => number} phiAt
 * @param {{ cx?: number, R: number, r0?: number, nMax?: number, samples?: number }} opts
 * @returns {{ kind: 'sphere', cx: number, R: number, r0: number, nMax: number, samples: number, c: Float64Array, residual: number, mu: Float64Array, phi: Float64Array }}
 */
export function multipoleSphere(phiAt, { cx = 0, R, r0 = R, nMax = 12, samples = 64 } = {}) {
    if (!(R > 0) || !(r0 > 0)) throw fail('E_UNSUPPORTED', 'The sampling and reference radii must be positive.');
    const M = Math.max(8, Math.floor(samples));
    const nM = Math.max(0, Math.min(Math.floor(nMax), M - 2));
    const gl = gaussLegendre(M);
    const phi = new Float64Array(M);
    let bad = 0;
    for (let i = 0; i < M; i++) {
        const mu = gl.x[i];
        const v = phiAt(cx + R * mu, R * Math.sqrt(Math.max(0, 1 - mu * mu)));
        phi[i] = v;
        if (!Number.isFinite(v)) bad++;
    }
    if (bad) throw fail('E_UNSUPPORTED', `${bad} of ${M} sample points lie outside the solved domain; move the sphere or shrink it.`);
    const c = new Float64Array(nM + 1);
    for (let n = 0; n <= nM; n++) {
        let s = 0;
        for (let i = 0; i < M; i++) s += gl.w[i] * phi[i] * legendreP(n, gl.x[i]);
        c[n] = s * (2 * n + 1) / 2 / Math.pow(R / r0, n);
    }
    let res = 0;
    for (let i = 0; i < M; i++) {
        let s = 0;
        for (let n = 0; n <= nM; n++) s += c[n] * Math.pow(R / r0, n) * legendreP(n, gl.x[i]);
        res += gl.w[i] * (phi[i] - s) * (phi[i] - s);
    }
    return { kind: 'sphere', cx, R, r0, nMax: nM, samples: M, c, residual: Math.sqrt(res / 2), mu: gl.x, phi };
}
