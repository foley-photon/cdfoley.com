// Network of a pumping line (spec 2.7, 3.5): expansion of the items into nodes and edges (Haefer-consistent),
// the linear (molecular) solve, Newton on ln p with backtracking and pressure continuation, the operating-point
// analysis, the error band of the molecular formula result and the pressure sweeps. Pure module, SI units.
// Robustness beyond the design reference (lines whose conductances span many decades, caps that bind at ppm drops):
// cancellation-free GTH elimination for every linear solve, analytic edge derivatives (flow.js), Newton steps scaled
// as a whole, a line search at a fixed flow scale with each node's rounding floor taken off its residual, line flows
// read from the best-resolved section of the line, and iteration budgets so that a failure is quick.

import { gasState, meanFreePath, temperatureWarning, waterSaturation } from './gas.js';
import { coreChokeP, edgeFlow, edgeDerivs, edgeLimit, edgeG, pumpSc } from './flow.js';
import { compileItem, mergeItems, validateModel, describeItem, apertureOverlap, apertureOverlapRadius } from './elements.js';

const PI = Math.PI, SQRT_PI = Math.sqrt(PI);
const P_MOL = 1e-9, P_SMALL = 1e-12;
const fmtSpeed = (s) => String(Number((s * 1000).toPrecision(4))) + ' L/s';

/**
 * Expands items (top level of a Model) into { nodes, edges, elems, pump, last, junctions } (spec 3.5.3).
 * Node 0 is the chamber. Extra fields: elemItems (the merged item of each element), runs (number of series runs
 * between plenums; each Compiled element gets its run index in e.run), pumpRun (the run of the pump-inlet edge) and
 * sections (the series sections of the line, each a list of runs: a top-level run, or the branches of a parallel
 * group). Throws RangeError for items that do not compile, a misplaced pump or a pump faster than its molecular
 * orifice limit. pumpWider: false, true (the pump inlet reaches beyond the last outlet) or 'rod' (the last element is
 * an annulus whose bore takes the whole pump inlet, so only its rod end face shades the inlet).
 */
export function buildNetwork(items, G) {
    if (!Array.isArray(items)) throw new RangeError('The line has no element list.');
    const nodes = [{ plenum: true }], edges = [], elems = [], elemItems = [], groups = [];
    const newNode = () => nodes.push({ plenum: false }) - 1;
    let node = 0, prev = null, pump = null, pumpPrev = null, junctions = 0, prevGeom = false;
    let run = 0, runs = 1;   // series runs between plenums: every element of a run carries the same flow

    // Compile a run of merged entries and decide its edges, starting from the outlet section `pv` (null = plenum).
    // pv = { Aout, reOut, ap }: the area, equivalent radius and shape of the opening the gas leaves through. Openings
    // are coaxial; where the next inlet only partly overlaps it, the gas contracts to the overlap (an orifice edge,
    // flag 'partial-overlap'); where they do not overlap at all, nothing can pass and the model is refused.
    const plan = (merged, pathOf, pv, runIndex) => {
        const list = [];
        for (const { item, paths } of merged) {
            const e = compileItem(item, G);
            e.path = pathOf(paths[0]);
            e.run = runIndex;
            e.mergedFrom = paths.length > 1 ? paths.slice() : null;
            e.junction = null;
            if (e.mergedFrom) e.flags.push('merged');
            const specs = [];
            let apOut = e.apOut, aOut = e.aperture ? e.Ain : e.Aout, reOut = e.reOut;
            if (!pv) specs.push({ k: 'orif', Ato: e.Ain, reTo: e.reIn, Afrom: Infinity, reFrom: Infinity });
            else {
                const Aov = apertureOverlap(pv.ap, e.apIn), Amin = Math.min(pv.Aout, e.Ain);
                if (!(Aov > 1e-9 * Amin)) {
                    const err = new RangeError('This element does not overlap the opening before it (a rod, a bore or a slot blocks it), so no gas can pass. Check the diameters and sizes.');
                    err.path = e.path;
                    throw err;
                }
                const ring = (ap) => (ap.kind === 'ring' ? ap.ri / ap.ro : 0);
                const sameAp = JSON.stringify(pv.ap) === JSON.stringify(e.apIn);
                if (Aov < Amin * (1 - 1e-9)) {
                    specs.push({ k: 'orif', Ato: Aov, reTo: apertureOverlapRadius(pv.ap, e.apIn, Aov), Afrom: pv.Aout, reFrom: pv.reOut });
                    e.flags.push('partial-overlap');
                    e.junction = { kind: 'partial', overlap: Aov / Amin, ring: Math.max(ring(pv.ap), ring(e.apIn)) };
                    if (e.aperture) { aOut = Aov; reOut = apertureOverlapRadius(pv.ap, e.apIn, Aov); apOut = clipAperture(pv.ap, e.apIn); }
                } else {
                    if (e.Ain < pv.Aout * (1 - 1e-9)) specs.push({ k: 'orif', Ato: e.Ain, reTo: e.reIn, Afrom: pv.Aout, reFrom: pv.reOut });
                    if (!sameAp && (pv.ap.kind === 'ring' || e.apIn.kind === 'ring')) e.junction = { kind: 'ring', ring: Math.max(ring(pv.ap), ring(e.apIn)) };
                }
            }
            if (!e.aperture) {
                const core = { k: 'core', kv: e.kv, Cm: e.Cm, s: e.s, Aout: e.Aout };
                if (e.zc) core.zc = e.zc;
                specs.push(core);
            }
            if (!specs.length) { e.noEffect = true; e.flags.push('no-effect'); e.junction = null; } else pv = { Aout: aOut, reOut, ap: apOut };
            list.push({ e, item, specs });
        }
        return { list, pv };
    };
    // Add the planned edges from node `start`; the last edge of the run ends on `end` when given.
    const emit = (list, start, end) => {
        let n = start, lastEff = -1;
        list.forEach((x, k) => { if (x.specs.length) lastEff = k; });
        list.forEach(({ e, item, specs }, k) => {
            const ei = elems.push(e) - 1;
            elemItems.push(item);
            e.nodeIn = n;
            specs.forEach((sp, j) => {
                const b = (end !== null && k === lastEff && j === specs.length - 1) ? end : newNode();
                edges.push(sp.k === 'orif'
                    ? { k: 'orif', a: n, b, Ato: sp.Ato, reTo: sp.reTo, Afrom: sp.Afrom, reFrom: sp.reFrom, el: ei }
                    : Object.assign({ k: 'core', a: n, b, kv: sp.kv, Cm: sp.Cm, s: sp.s, Aout: sp.Aout, el: ei }, sp.zc ? { zc: sp.zc } : {}));
                n = b;
            });
            e.nodeOut = n;
        });
        return n;
    };

    const top = mergeItems(items);
    top.forEach(({ item: it, paths }, k) => {
        if (it.t === 'chamber') { nodes[node].plenum = true; prev = null; prevGeom = false; run = runs++; return; }
        if (it.t === 'pump') {
            if (k !== top.length - 1) throw new RangeError('The pump must be the last element.');
            pump = { S: it.S, A: PI * it.d * it.d / 4, re: it.d / 2, attached: prev !== null, prevAout: prev ? prev.Aout : null };
            pumpPrev = prev;
            return;
        }
        if (it.t === 'parallel') {
            nodes[node].plenum = true;
            const inNode = node, outNode = newNode(), branchRuns = [];
            nodes[outNode].plenum = true;
            it.branches.forEach((br, bi) => {
                branchRuns.push(runs);
                const { list } = plan(mergeItems(br), (j) => `${paths[0]}.${bi}.${j}`, null, runs++);
                emit(list, inNode, outNode);
                junctions += Math.max(0, list.filter((x) => !x.e.noEffect).length - 1);
            });
            groups.push(branchRuns);
            node = outNode; prev = null; prevGeom = false; run = runs++;
            return;
        }
        const { list, pv } = plan([{ item: it, paths }], String, prev, run);
        node = emit(list, node, null);
        prev = pv;
        if (!list[0].e.noEffect) { if (prevGeom) junctions++; prevGeom = true; }
    });
    let pumpWider = false;
    if (pump && pump.attached) {
        const pAp = { kind: 'disc', r: pump.re }, Aov = apertureOverlap(pumpPrev.ap, pAp);
        if (!(Aov > 1e-9 * Math.min(pump.A, pumpPrev.Aout))) {
            const err = new RangeError('The pump inlet does not overlap the outlet of the last element, so no gas can reach the pump. Check the pump bore.');
            err.path = String(items.length - 1);
            throw err;
        }
        if (Aov < pumpPrev.Aout * (1 - 1e-9)) {
            const b = newNode();
            edges.push({ k: 'orif', a: node, b, Ato: Aov, reTo: apertureOverlapRadius(pumpPrev.ap, pAp, Aov), Afrom: pumpPrev.Aout, reFrom: pumpPrev.reOut, el: -1 });
            node = b;
        }
        pumpWider = pump.A > Aov * (1 + 1e-9);
        // an annulus that ends on a pump of its own bore: the pump inlet is not wider, the rod's end face shades it
        if (pumpWider && pumpPrev.ap.kind === 'ring' && pumpPrev.ap.ro >= pump.re * (1 - 1e-9)) pumpWider = 'rod';
    }
    if (pump) {
        const lim = pump.A * G.vbar / 4;
        if (!(pump.S < lim)) throw new RangeError(`Pumping speed exceeds the molecular-flow maximum for this inlet bore: S ≤ ${fmtSpeed(lim)}.`);
    }
    // Sections in series, each carrying the whole flow: every top-level run that has edges, and every parallel group.
    const used = new Uint8Array(runs), inGroup = new Uint8Array(runs);
    for (const e of edges) used[e.el >= 0 ? elems[e.el].run : run] = 1;
    for (const g of groups) for (const r of g) inGroup[r] = 1;
    const sections = [];
    for (let r = 0; r < runs; r++) if (used[r] && !inGroup[r]) sections.push([r]);
    sections.push(...groups);
    return { nodes, edges, elems, pump, last: node, junctions, elemItems, runs, pumpRun: run, sections, pumpWider };
}

// The overlap of two coaxial openings as an opening (exact for discs, rings and rectangles; a rectangle clipped to
// the disc's bounding square otherwise, which is only used to test the next junction).
function clipAperture(p, q) {
    const ring = (x) => (x.kind === 'disc' ? { ri: 0, ro: x.r } : { ri: x.ri, ro: x.ro });
    if (p.kind !== 'rect' && q.kind !== 'rect') {
        const a = ring(p), b = ring(q), ro = Math.min(a.ro, b.ro), ri = Math.max(a.ri, b.ri);
        return ri > 0 ? { kind: 'ring', ri, ro } : { kind: 'disc', r: ro };
    }
    if (p.kind === 'rect' && q.kind === 'rect') return { kind: 'rect', a: Math.min(p.a, q.a), b: Math.min(p.b, q.b) };
    const rc = p.kind === 'rect' ? p : q, rd = ring(p.kind === 'rect' ? q : p);
    return { kind: 'rect', a: Math.min(rc.a, 2 * rd.ro), b: Math.min(rc.b, 2 * rd.ro) };
}

// Solves M x = r for a network matrix M (dense, row-major m x m, overwritten): positive diagonal, non-positive
// off-diagonal entries, and column sums c[j] >= 0 (the conductance of column j to fixed nodes and the pump; c is
// overwritten). Gaussian elimination in the Grassmann-Taksar-Heyman form: every pivot is recomputed as c[k] plus the
// off-diagonal weights of its column, and the c[j] are updated by addition, so the elimination never subtracts and
// keeps full componentwise accuracy however widely the conductances spread. (Spec 3.5.5 names partial pivoting, which
// is only normwise stable: a chain whose conductances span 20 decades comes out with pressures of -3e15.) The order is
// natural: these matrices need no pivoting. Returns r = x.
function gthSolve(M, c, r, m) {
    for (let k = 0; k < m; k++) {
        const rowK = k * m;
        let D = c[k];
        for (let i = k + 1; i < m; i++) D -= M[i * m + k];
        M[rowK + k] = D;
        const ck = c[k] / D;
        for (let j = k + 1; j < m; j++) c[j] -= ck * M[rowK + j];
        const rk = r[k];
        for (let i = k + 1; i < m; i++) {
            const w = M[i * m + k];
            if (w === 0) continue;
            const f = -w / D, rowI = i * m;
            for (let j = k + 1; j < m; j++) M[rowI + j] += f * M[rowK + j];
            r[i] += f * rk;
        }
    }
    for (let k = m - 1; k >= 0; k--) {
        const rowK = k * m;
        let s = r[k];
        for (let j = k + 1; j < m; j++) s -= M[rowK + j] * r[j];
        r[k] = s / M[rowK + k];
    }
    return r;
}

/** Node pressures of the linear network with edge conductances gEdge[k], a pump conductance gPump at the last node and fixed: Map(node -> p). */
export function linearSolve(net, gEdge, gPump, fixed) {
    const n = net.nodes.length, idx = new Int32Array(n).fill(-1);
    let m = 0;
    for (let i = 0; i < n; i++) if (!fixed.has(i)) idx[i] = m++;
    const A = new Float64Array(m * m), b = new Float64Array(m), c = new Float64Array(m);
    net.edges.forEach((e, k) => {
        const g = gEdge[k], ia = idx[e.a], ib = idx[e.b];
        if (ia >= 0) { A[ia * m + ia] += g; if (ib >= 0) A[ia * m + ib] -= g; else { b[ia] += g * fixed.get(e.b); c[ia] += g; } }
        if (ib >= 0) { A[ib * m + ib] += g; if (ia >= 0) A[ib * m + ia] -= g; else { b[ib] += g * fixed.get(e.a); c[ib] += g; } }
    });
    if (gPump && idx[net.last] >= 0) { A[idx[net.last] * m + idx[net.last]] += gPump; c[idx[net.last]] += gPump; }
    if (m) gthSolve(A, c, b, m);
    const p = new Float64Array(n);
    for (const [k, v] of fixed) p[k] = v;
    for (let i = 0; i < n; i++) if (idx[i] >= 0) p[i] = b[idx[i]];
    return p;
}

// Flow of every series run (from its best-resolved edge: the largest pressure drop relative to the pressure) and the
// line flow Q (Pa m^3/s) from the best-resolved section (a top-level run or a parallel group; resolution of a group
// = that of its worst branch). Every section carries the whole flow, so in exact arithmetic any one gives Q; the best
// one avoids sections whose drops are a few ulps of the pressure. flowOf(edge, k) is the flow of edge k at p.
function lineFlows(net, p, flowOf) {
    const best = new Float64Array(net.runs).fill(-1), q = new Float64Array(net.runs);
    net.edges.forEach((e, k) => {
        const r = e.el >= 0 ? net.elems[e.el].run : net.pumpRun, pa = p[e.a], pb = p[e.b];
        const d = Math.abs(pa - pb) / (Math.max(pa, pb) || 1e-300);
        if (d > best[r]) { best[r] = d; q[r] = flowOf(e, k); }
    });
    let Q = 0, res = -Infinity;
    for (const s of net.sections) {
        let worst = Infinity, sum = 0;
        for (const r of s) { if (best[r] < worst) worst = best[r]; sum += q[r]; }
        if (worst > res) { res = worst; Q = sum; }
    }
    return { q, Q };
}

// Line flow (Pa m^3/s) at node pressures p.
function throughput(net, p, G) {
    return lineFlows(net, p, (e) => edgeFlow(e, p[e.a], p[e.b], G)).Q;
}

// Partial derivatives [dQ/dpa, dQ/dpb] of an edge flow (flow.js edgeDerivs, analytic for every edge kind).
function partials(e, pa, pb, G) {
    const d = edgeDerivs(e, pa, pb, G);
    return [d[1], d[2]];
}

// Rounding floor of a node balance, per unit of its flow sensitivity sum |dQ/dp| p over its edges: an element whose
// drop is a few ulps of the pressure cannot carry a flow resolved better than this (16 ulps of margin).
const NOISE = 16 * 2.220446049250313e-16;

// Newton on u = ln p of the free nodes at boundary conditions bc, at most maxIt iterations; p is updated in place.
// Returns { ok, nrm, it }. nrm = max over free nodes of max(0, |F_j| - floor_j)/q_s: the plain criterion of spec 3.5.5
// (max|F|/q_s, converged at 1e-11, usable at 1e-9) with each node's rounding floor taken off its residual.
// polish: after converging, refine towards the plain criterion as far as rounding allows (final continuation step).
function newton(net, G, bc, p, maxIt = 60, polish = false) {
    const n = net.nodes.length, dpMode = bc.mode === 'dp';
    p[0] = bc.p0;
    if (dpMode) p[net.last] = bc.p1;
    const idx = new Int32Array(n).fill(-1), free = [];
    for (let i = 1; i < n; i++) if (!(dpMode && i === net.last)) { idx[i] = free.length; free.push(i); }
    const m = free.length;
    if (!m) return { ok: true, nrm: 0, it: 0 };
    const usePump = !dpMode && net.pump !== null;
    const F = new Float64Array(n), Fr = new Float64Array(m), fl = new Float64Array(n), nu = new Float64Array(m);
    let plain = 0, qsNow = 1;
    // Residual at pp: fills Fr, sets the plain norm max|F|/q_s (q_s: the largest edge or pump flow at pp) and returns
    // nrm with the scale q_s, or with a given fixed scale (a line search compares its trial points at the scale of
    // the starting point, so that the merit function does not move with q_s).
    const resid = (pp, scale = 0) => {
        F.fill(0);
        let qs = 0;
        for (const e of net.edges) {
            const q = edgeFlow(e, pp[e.a], pp[e.b], G);
            F[e.a] -= q; F[e.b] += q;
            const aq = Math.abs(q);
            if (aq > qs) qs = aq;
        }
        if (usePump) { const q = pp[net.last] * pumpSc(net.pump, pp[net.last], G); F[net.last] -= q; if (q > qs) qs = q; }
        qs = qs || 1e-300;
        qsNow = qs;
        let mx = 0, mr = 0;
        for (let j = 0; j < m; j++) {
            const v = Math.abs(Fr[j] = F[free[j]]);
            if (v > mx) mx = v;
            if (v - nu[j] > mr) mr = v - nu[j];
        }
        plain = mx / qs;
        return mr / (scale || qs);
    };
    // M = -dF/du (u = ln p), which has the sign pattern of a conductance matrix: column sums cx >= 0 (conductance to
    // the fixed nodes and the pump), solved by gthSolve. fl: flow sensitivity of every node, for its rounding floor.
    const M = new Float64Array(m * m), cx = new Float64Array(m), du = new Float64Array(m), pOld = new Float64Array(n);
    const assemble = () => {
        M.fill(0); cx.fill(0); fl.fill(0);
        for (const e of net.edges) {
            const pa = p[e.a], pb = p[e.b], [da, db] = partials(e, pa, pb, G), ia = idx[e.a], ib = idx[e.b], ga = da * pa, gb = db * pb;
            if (ia >= 0) { M[ia * m + ia] += ga; if (ib >= 0) M[ia * m + ib] += gb; else cx[ia] += ga; }
            if (ib >= 0) { M[ib * m + ib] -= gb; if (ia >= 0) M[ib * m + ia] -= ga; else cx[ib] -= gb; }
            const c = Math.abs(ga) + Math.abs(gb);
            fl[e.a] += c; fl[e.b] += c;
        }
        if (usePump && idx[net.last] >= 0) {
            const i = idx[net.last], pl = p[net.last], h = pl * 1e-7;
            const d = ((pl + h) * pumpSc(net.pump, pl + h, G) - (pl - h) * pumpSc(net.pump, pl - h, G)) / (2 * h);
            M[i * m + i] += d * pl;
            cx[i] += d * pl;
            fl[net.last] += 2 * Math.abs(d) * pl;
        }
        for (let j = 0; j < m; j++) nu[j] = NOISE * fl[free[j]];
    };
    let nrm = resid(p), it = 0;
    if (plain > 1e-11) { assemble(); nrm = resid(p); }
    while (it < maxIt && nrm > 1e-11) {
        du.set(Fr);
        gthSolve(M, cx, du, m);
        pOld.set(p);
        const scale = qsNow;
        // the step is limited to |du| <= 2 by scaling it as a whole: clamping components one by one would change its
        // direction and break the balance of nodes joined by large conductances, which move together
        let big = 0;
        for (let j = 0; j < m; j++) if (Math.abs(du[j]) > big) big = Math.abs(du[j]);
        let lam = big > 2 ? 2 / big : 1, ok = false;
        for (let ls = 0; ls < 30; ls++) {
            for (let j = 0; j < m; j++) { const v = free[j]; p[v] = pOld[v] * Math.exp(lam * du[j]); }
            const n2 = resid(p, scale);
            if (n2 < nrm * (1 - 1e-4 * lam)) { nrm = n2; ok = true; break; }
            lam /= 2;
        }
        if (!ok) { p.set(pOld); break; }
        it++;
        if (plain <= 1e-11) { nrm = Math.min(nrm, plain); break; }
        assemble();
        nrm = resid(p);
    }
    if (polish && nrm <= 1e-11 && it < maxIt) {
        // Converged within the rounding floors: up to three more full steps while the plain imbalance keeps falling,
        // so that every node balances to its last few ulps (the operating point that is reported)
        const keep = Float64Array.from(p);
        assemble();
        nrm = resid(p);
        for (let k = 0; k < 3 && plain > 1e-11 && it < maxIt; k++) {
            const before = plain;
            du.set(Fr);
            gthSolve(M, cx, du, m);
            pOld.set(p);
            for (let j = 0; j < m; j++) { const v = free[j]; p[v] = pOld[v] * Math.exp(du[j]); }
            resid(p);
            if (!(plain < before)) { p.set(pOld); break; }
            it++;
            assemble();
            nrm = resid(p);
        }
        nrm = resid(p);
        if (nrm > 1e-11) { p.set(keep); nrm = resid(p); }
    }
    return { ok: nrm <= 1e-9, nrm, it };
}

function molecularStart(net, G, bc) {
    const gE = net.edges.map((e) => edgeG(e, P_SMALL, G)), fixed = new Map([[0, bc.p0]]);
    if (bc.mode === 'dp') fixed.set(net.last, bc.p1);
    return linearSolve(net, gE, bc.mode !== 'dp' && net.pump ? pumpSc(net.pump, P_SMALL, G) : 0, fixed);
}

// Newton iterations one solveAt may spend in all: a normal solve from 1e-3 Pa to 1e7 Pa takes about 50 steps of 1 to
// 5 iterations, and an iteration costs about n^3/3 operations, so a pathological model fails in well under a second
// instead of freezing the page.
const iterationBudget = (net) => Math.max(400, Math.min(1500, Math.floor(2e9 / net.nodes.length ** 3)));

/**
 * Operating point at bc = { mode: 'pump', p0 } | { mode: 'dp', p0, p1 } by continuation from the molecular
 * solution (spec 3.5.5): boundary pressures scaled from k0 = min(1, 1e-3 Pa/p0) to 1 in factors of 10^0.2, with
 * 2..64 substeps on failure. guess (node pressures at chamber pressure pFrom) starts from a previous solution.
 * Returns { p, converged, iterations, maxIterations } (maxIterations: most Newton iterations of any step).
 * opts.budget caps the Newton iterations of the whole call (default 400 to 1500, less for large networks).
 */
export function solveAt(net, G, bc, guess = null, pFrom = null, opts = {}) {
    const scale = (k) => (bc.mode === 'dp' ? { mode: 'dp', p0: bc.p0 * k, p1: bc.p1 * k } : { mode: bc.mode, p0: bc.p0 * k });
    const budget = opts.budget ?? iterationBudget(net);
    let iterations = 0, maxIterations = 0;
    // one Newton call; the call at the target itself (k = 1) also polishes its result
    const run = (k, p) => {
        if (iterations >= budget) return { ok: false, nrm: Infinity, it: 0 };
        const r = newton(net, G, k === 1 ? bc : scale(k), p, Math.min(60, budget - iterations), k === 1);
        iterations += r.it;
        if (r.it > maxIterations) maxIterations = r.it;
        return r;
    };
    let k0, p;
    if (guess && pFrom > 0) {
        p = Float64Array.from(guess);
        k0 = pFrom / bc.p0;
        if (k0 >= 1) { for (let i = 0; i < p.length; i++) p[i] /= k0; k0 = 1; }
    } else {
        k0 = Math.min(1, 1e-3 / bc.p0);
        p = molecularStart(net, G, scale(k0));
        run(k0, p);
    }
    let k = k0;
    const step = Math.pow(10, 0.2);
    while (k < 1) {
        const kn = Math.min(1, k * step), pTry = Float64Array.from(p);
        for (let i = 0; i < pTry.length; i++) pTry[i] *= kn / k;
        if (run(kn, pTry).ok) p = pTry;
        else {
            let ok = false;
            for (let sub = 2; sub <= 64 && !ok; sub *= 2) {
                const q = Float64Array.from(p);
                let kk = k;
                ok = true;
                for (let s = 1; s <= sub; s++) {
                    const k2 = s === sub ? kn : k * Math.pow(kn / k, s / sub);
                    for (let i = 0; i < q.length; i++) q[i] *= k2 / kk;
                    kk = k2;
                    if (!run(k2, q).ok) { ok = false; break; }
                }
                if (ok) p = q;
            }
            if (!ok) return { p, converged: false, iterations, maxIterations };
        }
        k = kn;
    }
    if (k0 >= 1 && !run(1, p).ok) return { p, converged: false, iterations, maxIterations };
    return { p, converged: true, iterations, maxIterations };
}

// Molecular limit of a network: line conductance with the last node at p0/2, and S_eff with the pump sink.
function molLimit(net, G) {
    const gE = net.edges.map((e) => edgeG(e, P_SMALL, G));
    const qOut = (p) => lineFlows(net, p, (e, k) => gE[k] * (p[e.a] - p[e.b])).Q;
    let Cline = Infinity, pLine = null, Seff = null, pMol = null;
    if (net.last !== 0) {
        pLine = linearSolve(net, gE, 0, new Map([[0, P_MOL], [net.last, P_MOL / 2]]));
        Cline = qOut(pLine) / (P_MOL / 2);
    }
    if (net.pump) {
        const sc = pumpSc(net.pump, P_SMALL, G);
        pMol = linearSolve(net, gE, sc, new Map([[0, P_MOL]]));
        Seff = net.last === 0 ? sc : qOut(pMol) / P_MOL;
    }
    return { Cline, Seff, pMol, pLine };
}

/** Molecular-flow limit of a line (spec 3.5.5 step 6): { Cline, Seff, pMol, pLine } (Seff and pMol null without a pump). */
export function molecularLimit(items, G) {
    return molLimit(buildNetwork(items, G), G);
}

const pctText = (x) => {
    const s = (Math.round(Math.abs(x) * 1000) / 10).toFixed(1) + ' %';
    return x < 0 ? '−' + s : x > 0 ? '+' + s : s;
};

// ---------------------------------------------------------------- line of sight across short elements (v2.3)
// Haefer's theorem assumes the gas is fully mixed at every junction. Across a short element between openings of
// different shape it is not: gas from a narrow opening lands on a rod end face or a plate in line of sight (the formula
// is high, by up to tens of percent), or flies straight from one narrow opening into an aligned one (the formula is
// low). For each tube, cone, rectangular duct of aspect 0.2 or more (as the round duct of the same area) or annulus of a run, a diffuse
// view-factor (radiosity) solve of the piece between the opening before it and the opening after it, with the rod and
// step faces re-emitting, gives the piece's transmission for gas entering by the cosine law. Its resistance minus the
// Haefer resistance of the same piece (entrance, core, contraction) estimates the junction error.

// Flux between coaxial parallel discs of radii a and b at distance h, over pi: a² F(a → b), symmetric in a and b.
function discFlux(a, b, h) {
    if (!(a > 0) || !(b > 0)) return 0;
    if (!(h > 1e-12 * Math.max(a, b))) return Math.min(a, b) ** 2;
    const x = 1 + (h * h + b * b) / (a * a), q = (b / a) ** 2;
    return a * a * 2 * q / (x + Math.sqrt(Math.max(x * x - 4 * q, 0)));
}

// Transmission from opening S (plane z = 0) to opening T (plane z = L) of a tube or cone of radii r0 → r1; S and T
// are { ri, ro } (ri = 0 for a disc) inside the bore at their plane. Plane faces outside S and T, and the wall in 16
// bands, re-emit diffusely; a molecule ends when it leaves through T or back through S. Exact view factors between
// coaxial rings and wall bands follow from disc-to-disc factors (a band and the section behind it radiate through
// the section ahead of it as that section would).
export function gapTransmission(S, T, r0, r1, L) {
    const K = 16, P = [], rad = (z) => r0 + (r1 - r0) * z / L;
    const plane = (side, open, R) => {
        const add = (a1, a2, sink) => P.push({ side, a1, a2, area: a2 * a2 - a1 * a1, sink });
        const reflect = (a1, a2) => {
            for (let k = 0; k < 3; k++) add(Math.sqrt(a1 * a1 + (a2 * a2 - a1 * a1) * k / 3), Math.sqrt(a1 * a1 + (a2 * a2 - a1 * a1) * (k + 1) / 3), false);
        };
        if (open.ri > 0) reflect(0, open.ri);
        add(open.ri, open.ro, true);
        if (open.ro < R * (1 - 1e-9)) reflect(open.ro, R);
    };
    plane(0, S, r0);
    plane(1, T, r1);
    for (let k = 0; k < K; k++) {
        const z1 = L * (1 - Math.cos(PI * k / K)) / 2, z2 = L * (1 - Math.cos(PI * (k + 1) / K)) / 2, ra = rad(z1), rb = rad(z2);
        P.push({ side: 2, z1, z2, area: (ra + rb) * Math.hypot(z2 - z1, rb - ra), sink: false });
    }
    const n = P.length, iS = P.findIndex((p) => p.sink && p.side === 0), iT = P.findIndex((p) => p.sink && p.side === 1);
    const thru = (p, z) => { const h = p.side === 0 ? z : L - z, r = rad(z); return discFlux(p.a2, r, h) - discFlux(p.a1, r, h); };
    const sec = (za, zb) => discFlux(rad(za), rad(zb), Math.abs(zb - za));
    const flux = (p, q) => {   // p before q in the list: planes first, then the bands in order
        if (q.side !== 2) return discFlux(p.a2, q.a2, L) - discFlux(p.a1, q.a2, L) - discFlux(p.a2, q.a1, L) + discFlux(p.a1, q.a1, L);
        if (p.side === 0) return thru(p, q.z1) - thru(p, q.z2);
        if (p.side === 1) return thru(p, q.z2) - thru(p, q.z1);
        return sec(p.z2, q.z1) - sec(p.z1, q.z1) - sec(p.z2, q.z2) + sec(p.z1, q.z2);
    };
    const Fx = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        if (P[i].side === P[j].side && P[i].side !== 2) continue;   // faces of one plane do not see each other
        Fx[i][j] = Fx[j][i] = Math.max(0, flux(P[i], P[j]));
    }
    const row = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < n; j++) s += Fx[i][j];
        if (P[i].side === 2) { Fx[i][i] = Math.max(0, P[i].area - s); s += Fx[i][i]; }
        row[i] = s;
    }
    // x_r: re-emissions of reflecting patch r per molecule entering through S; x_r = F(S → r) + Σ x_c F(c → r)
    const refl = [];
    for (let i = 0; i < n; i++) if (!P[i].sink) refl.push(i);
    const m = refl.length, M = refl.map((i, r) => {
        const a = new Float64Array(m + 1);
        refl.forEach((j, c) => { a[c] = (r === c ? 1 : 0) - Fx[j][i] / row[j]; });
        a[m] = Fx[iS][i] / row[iS];
        return a;
    });
    for (let c = 0; c < m; c++) {
        let piv = c;
        for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
        [M[c], M[piv]] = [M[piv], M[c]];
        for (let r = c + 1; r < m; r++) { const f = M[r][c] / M[c][c]; if (f) for (let k = c; k <= m; k++) M[r][k] -= f * M[c][k]; }
    }
    const x = new Float64Array(m);
    for (let r = m - 1; r >= 0; r--) { let s = M[r][m]; for (let k = r + 1; k < m; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
    let PT = Fx[iS][iT] / row[iS];
    refl.forEach((i, r) => { PT += x[r] * Fx[i][iT] / row[i]; });
    return PT;
}

// A coaxial opening as a ring { ri, ro }; a rectangle of aspect at least 0.2 as the disc of the same area; null for a
// flatter rectangle (not modelled).
const ringOf = (x) => (x.kind === 'disc' ? { ri: 0, ro: x.r } : x.kind === 'ring' ? { ri: x.ri, ro: x.ro }
    : Math.min(x.a, x.b) >= 0.2 * Math.max(x.a, x.b) ? { ri: 0, ro: Math.sqrt(x.a * x.b / PI) } : null);
const ringMeet = (a, b) => (a && b ? { ri: Math.max(a.ri, b.ri), ro: Math.min(a.ro, b.ro) } : null);

/**
 * Line-of-sight estimate of the Haefer error of each series run: { lo, hi } = the summed resistance increases
 * (formula high) and decreases (formula low) of the run's pieces, over the run's molecular resistance; the largest of
 * the runs. Resistances are in units of 4/v̄ (1/area).
 */
export function lineOfSight(net) {
    let lo = 0, hi = 0;
    for (let run = 0; run < net.runs; run++) {
        const els = net.elems.filter((e) => e.run === run && !e.noEffect);
        if (els.length < 2) continue;
        let rho = 0;
        for (const ed of net.edges) {
            if (ed.el < 0 || net.elems[ed.el].run !== run) continue;
            if (ed.k === 'orif') rho += 1 / ed.Ato - (Number.isFinite(ed.Afrom) ? 1 / ed.Afrom : 0);
            else { const e = net.elems[ed.el]; rho += (1 - e.alpha) / (e.alpha * e.Ain); }
        }
        let dLo = 0, dHi = 0;
        els.forEach((e, k) => {
            const bore0 = ringOf(e.apIn), bore1 = ringOf(e.apOut);
            if (!(e.length > 0) || !bore0 || !bore1 || !(e.t === 'tube' || e.t === 'cone' || e.t === 'rect' || e.t === 'annulus')) return;
            // the openings at both ends: this element's, cut by the elements that touch it (thin orifices included)
            let S = bore0, T = bore1;
            for (let i = k - 1; i >= 0; i--) { S = ringMeet(ringOf(els[i].apOut), S); if (els[i].length > 0) break; }
            for (let i = k + 1; i < els.length; i++) { T = ringMeet(T, ringOf(els[i].apIn)); if (els[i].length > 0) break; }
            if (!S || !T || !(S.ro > S.ri) || !(T.ro > T.ri)) return;
            const r0 = bore0.ro, r1 = bore1.ro, ann = e.t === 'annulus';
            if (e.length > 10 * Math.max(r0, r1)) return;
            // an annulus counts only as the open space between two ring openings that hide its (thinner) rod
            if (ann && !(bore0.ri <= 0.9 * Math.min(S.ri, T.ri))) return;
            if (!ann && S.ri === 0 && T.ri === 0 && S.ro >= r0 * (1 - 1e-9) && T.ro >= r1 * (1 - 1e-9)) return;
            const AS = S.ro ** 2 - S.ri ** 2, AT = T.ro ** 2 - T.ri ** 2, A0 = r0 * r0, A1 = r1 * r1;
            // Haefer's piece: entrance into S, core (normalised by the same view-factor model), contraction into T
            const core = ann ? PI * (1 - e.alpha) / (e.alpha * e.Ain) : 1 / (A0 * gapTransmission(bore0, bore1, r0, r1, e.length)) - 1 / A0;
            const Aout = ann ? e.Aout / PI : A1;
            const dR = (1 / (AS * gapTransmission(S, T, r0, r1, e.length)) - (1 / AS + core + Math.max(0, 1 / AT - 1 / Aout))) / PI;
            if (dR > 0 && !ann) dLo += dR;
            else if (dR < 0) dHi -= dR;
        });
        if (rho > 0) { lo = Math.max(lo, dLo / rho); hi = Math.max(hi, dHi / rho); }
    }
    return { lo, hi };
}

/**
 * Error band of the molecular formula result (spec 3.5.6, v2.3): { lo, hi, junctions, note }. Haefer's theorem
 * usually underestimates, so hi grows by 3.5 % per junction. Where the gas meets a rod end face (a junction into or
 * out of an annulus that is not the same annulus), lo widens by 10 % · min(1, e/0.75) and hi by 5 % · min(1, e/0.75)
 * each (e = R_i/R_o). Where the next opening only partly overlaps the previous one, lo widens by at least 10 %, or by
 * the blocked fraction of the opening. Across short elements the line-of-sight estimate (lineOfSight) widens lo and
 * hi by 1.5 times its resistance change: chain Monte Carlo of 185 scan lines (cones, orifices and tubes in front of
 * rods, aligned ring gaps and narrow openings) and 240 random lines put the exact value from 68 % below to 59 % above
 * the formula there.
 */
export function errorBand(net, pumpAttached) {
    const acc = net.elems.reduce((m, e) => Math.max(m, e.accuracy || 0), 0);
    const pumpTerm = pumpAttached ? 0.01 : 0, j = net.junctions;
    let ringTerm = 0, ringHi = 0, partTerm = 0, partHi = 0;
    for (const e of net.elems) {
        const J = e.junction;
        if (!J) continue;
        if (J.kind === 'partial') { partTerm += Math.max(0.1, 1 - J.overlap); partHi += 0.05; }
        if (J.ring > 0) { ringTerm += 0.1 * Math.min(1, J.ring / 0.75); ringHi += 0.05 * Math.min(1, J.ring / 0.75); }
    }
    const los = lineOfSight(net);
    const gapLo = los.lo > 0 ? 1 - 1 / (1 + 1.5 * los.lo) : 0;
    const gapHi = los.hi > 0 ? Math.min(0.75, 1 / Math.max(1 - 1.5 * los.hi, 1e-9) - 1) : 0;
    const hi = Math.min(0.25, 0.035 * j + acc + pumpTerm + partHi + ringHi) + gapHi;
    const lo = -Math.min(gapLo > 0 ? 0.99 : 0.9, acc + pumpTerm + ringTerm + partTerm + gapLo);
    let note = lo === 0 && hi === 0
        ? 'The molecular formula value is exact for this line (no junctions and no tabulated element).'
        : `Exact molecular value expected between ${pctText(lo)} and ${pctText(hi)} of the formula value (Haefer/Oatley, ${j} junction${j === 1 ? '' : 's'}).`;
    if (partTerm > 0) note += ' Openings that only partly overlap make the formula uncertain: use the Monte Carlo check.';
    else if (gapLo >= 0.05 || gapHi >= 0.05) note += ' Across a short element, gas from one opening flies straight onto a rod end face or a plate, or into the next narrow opening, which the formula does not see: use the Monte Carlo check.';
    else if (ringTerm > 0) note += ' At a rod end face the formula can be several percent high or low.';
    return { lo, hi, junctions: j, note };
}

const regimeOf = (Kn) => (Kn > 0.5 ? 'molecular' : Kn > 0.01 ? 'transitional' : 'viscous');

function edgesByElement(net) {
    const by = net.elems.map(() => []);
    for (const e of net.edges) if (e.el >= 0) by[e.el].push(e);
    return by;
}

// Index of the element with the largest pressure drop in node pressures p (-1 without elements).
function controlling(net, p) {
    let best = -1, bestDp = -Infinity;
    net.elems.forEach((e, i) => { const d = p[e.nodeIn] - p[e.nodeOut]; if (d > bestDp) { bestDp = d; best = i; } });
    return best;
}

function readGas(model) {
    return gasState(model.gas.id, model.gas.T, model.gas.custom ?? null, model.Cd ?? null);
}

function analyzeValid(model) {
    const G = readGas(model), net = buildNetwork(model.items, G);
    const pumpMode = model.bc.mode === 'pump';
    const bc = pumpMode ? { mode: 'pump', p0: model.bc.p0 } : { mode: 'dp', p0: model.bc.p0, p1: model.bc.p1 };
    const p0 = bc.p0, r = solveAt(net, G, bc), p = r.p;
    const pN = pumpMode ? p[net.last] : bc.p1;
    const flows = lineFlows(net, p, (e) => edgeFlow(e, p[e.a], p[e.b], G));
    const Q = net.last === 0 && net.pump ? p0 * pumpSc(net.pump, p0, G) : flows.Q;
    const mol = molLimit(net, G);
    const band = errorBand(net, pumpMode && !!net.pump && net.pump.attached);
    const base = pumpMode ? p0 : p0 - bc.p1;
    const pm = pumpMode ? mol.pMol : mol.pLine, baseMol = pumpMode ? P_MOL : P_MOL / 2;
    const byEl = edgesByElement(net), whole = new Uint8Array(net.runs);
    for (const s of net.sections) if (s.length === 1) whole[s[0]] = 1;
    // each element's conductance in the line at the molecular limit, to tell how far the operating point departs from it
    let molQ = null;
    if (pm) { const gE = net.edges.map((e) => edgeG(e, P_SMALL, G)); molQ = lineFlows(net, pm, (e, k) => gE[k] * (pm[e.a] - pm[e.b])); }
    const elements = net.elems.map((e, i) => {
        const pIn = p[e.nodeIn], pOut = p[e.nodeOut], dp = pIn - pOut, pMean = (pIn + pOut) / 2, mine = byEl[i];
        const Qel = whole[e.run] ? Q : flows.q[e.run];   // the element's flow: the line flow, or its branch's flow
        const Kn = meanFreePath(G, pMean) / e.Dh, cont = Kn <= 0.5;
        const Re = cont && mine.length ? Math.abs(Qel) * e.Dh / (G.Rs * G.T * e.Amin * G.eta) : null;
        const core = mine.find((x) => x.k === 'core');
        let Ma = null;
        if (cont && core) Ma = Math.abs(Qel) / (Math.max(p[core.b], coreChokeP(core, p[core.a], G)) * e.Aout * G.c);
        const lims = mine.map((x) => {
            const l = edgeLimit(x, p[x.a], p[x.b], G);
            return l === 'inertial' && (p[x.a] - p[x.b]) < 0.1 * dp ? 'none' : l;
        });
        const limit = lims.find((x) => x === 'choked' || x === 'choked-exit') || lims.find((x) => x !== 'none') || 'none';
        const flags = [];
        for (const l of lims) if (l !== 'none' && !flags.includes(l)) flags.push(l);
        if (Re !== null && Re > 2300) flags.push('turbulent');
        if (Ma !== null && Ma > 0.3 && Kn <= 0.01) flags.push('compressible');
        if (!e.aperture && e.length / e.Dh < 1 && Kn < 0.01) flags.push('short-element');
        for (const f of e.flags) if (!flags.includes(f)) flags.push(f);
        const Cop = dp > 1e-12 * pIn ? Qel / dp : null;
        // Kn > 0.5 is labelled transitional instead of molecular when the element's operating conductance already
        // differs from its molecular-limit value in the same line by more than 2 % (an orifice at Kn = 1.3 is 9 % up)
        let regime = regimeOf(Kn);
        if (regime === 'molecular' && Cop !== null && molQ) {
            const dpm = pm[e.nodeIn] - pm[e.nodeOut], qm = whole[e.run] ? molQ.Q : molQ.q[e.run];
            if (dpm > 1e-12 * pm[e.nodeIn] && Math.abs(Cop / (qm / dpm) - 1) > 0.02) regime = 'transitional';
        }
        return {
            path: e.path, t: e.t, label: e.label, describe: describeItem(net.elemItems[i]),
            alpha: e.alpha, Cmol: e.Cmol, Cop, dp, share: dp / base, pIn, pOut, pMean,
            Kn, Re, Ma, regime, limit, accuracy: e.accuracy, flags, notes: e.notes.slice(),
            mergedFrom: e.mergedFrom, Leq: e.Leq,
        };
    });
    const shareMol = net.elems.map((e) => (pm ? (pm[e.nodeIn] - pm[e.nodeOut]) / baseMol : 0));
    let pump = null;
    if (pumpMode && net.pump) {
        const inlet = net.edges.find((e) => e.el === -1);
        const pEnd = inlet ? p[inlet.a] : pN, pEndMol = inlet ? mol.pMol[inlet.a] : mol.pMol[net.last];
        pump = { S: net.pump.S, Sc: pumpSc(net.pump, pN, G), pIn: pN, share: pEnd / p0, shareMol: pEndMol / P_MOL, fraction: Q / p0 / net.pump.S };
    }
    const ci = controlling(net, p);
    const regime = ci >= 0 ? elements[ci].regime
        : regimeOf(meanFreePath(G, p0) / (net.pump ? 2 * net.pump.re : 1));
    const warnings = [];
    const tw = temperatureWarning(G.T);
    if (tw) warnings.push(tw);
    if (pumpMode && net.pumpWider) warnings.push(net.pumpWider === 'rod' ? 'pump-rod' : 'pump-wider');
    if (G.id === 'H2O' && G.T <= 373.15) {
        let pMax = p0;
        for (const v of p) if (v > pMax) pMax = v;
        if (pMax > waterSaturation(G.T)) warnings.push('water-condenses');
    }
    return {
        ok: true, errors: [], warnings, gas: G, bc,
        Q, Seff: pumpMode ? Q / p0 : null, Cline: net.last === 0 ? Infinity : Q / (p0 - pN), pN,
        mol: { Cline: mol.Cline, Seff: pumpMode ? mol.Seff : null, band },
        regime, converged: r.converged, iterations: r.iterations,
        elements, pump, shareMol,
    };
}

/**
 * Analysis of a Model at its operating point (spec 2.7 AnalysisResult; Appendix C). Never throws: an invalid
 * model gives { ok: false, errors: [{ path, field, message }], warnings: [] }.
 */
export function analyze(model) {
    let errors;
    try { errors = validateModel(model); } catch (err) { errors = [{ path: '', field: null, message: String(err && err.message || err) }]; }
    if (errors.length) return { ok: false, errors, warnings: [] };
    try {
        return analyzeValid(model);
    } catch (err) {
        return { ok: false, errors: [{ path: err && typeof err.path === 'string' ? err.path : '', field: null, message: err instanceof RangeError ? err.message : 'The calculation failed for this model.' }], warnings: [] };
    }
}

/**
 * Pressure sweep (spec 3.5.7). kind 'Seff' (pump mode: chamber pressure), 'dp' (two-pressure mode: upstream pressure
 * at fixed p1/p0) or 'C' (small-signal line conductance against mean pressure, without the pump sink).
 * opts = { n = 61, pMin, pMax } (defaults from model.range, else 1e-6 to 1.2e5 Pa). Throws RangeError for an invalid model.
 */
export function sweep(model, kind, opts = {}) {
    const errors = validateModel(model);
    if (errors.length) throw new RangeError(errors[0].message);
    if (kind !== 'Seff' && kind !== 'dp' && kind !== 'C') throw new RangeError(`Unknown sweep "${kind}".`);
    const pumpMode = model.bc.mode === 'pump';
    if (kind === 'Seff' && !pumpMode) throw new RangeError('The pumping-speed sweep needs a chamber-to-pump line.');
    if (kind === 'dp' && pumpMode) throw new RangeError('The two-pressure sweep needs a line between two pressures.');
    const n = Math.max(1, Math.round(opts.n ?? 61));
    const pMin = opts.pMin ?? model.range?.pMin ?? 1e-6, pMax = opts.pMax ?? model.range?.pMax ?? 1.2e5;
    if (!(pMin > 0 && pMax >= pMin)) throw new RangeError('The sweep range must run from a lower to a higher pressure.');
    const G = readGas(model), net = buildNetwork(model.items, G), mol = molLimit(net, G);
    const x = new Float64Array(n), y = new Float64Array(n), converged = new Uint8Array(n), regime = new Array(n);
    for (let k = 0; k < n; k++) x[k] = n === 1 ? pMin : pMin * Math.pow(pMax / pMin, k / (n - 1));
    // Regime of the element with the largest drop in p; at pressure pAxis (C sweep) or at its own mean pressure.
    const regimeAt = (p, pAxis, atAxis) => {
        const i = controlling(net, p);
        if (i < 0) return regimeOf(meanFreePath(G, pAxis) / (net.pump ? 2 * net.pump.re : 1));
        const e = net.elems[i];
        return regimeOf(meanFreePath(G, atAxis ? pAxis : (p[e.nodeIn] + p[e.nodeOut]) / 2) / e.Dh);
    };
    let ymol;
    if (kind === 'C') {
        ymol = mol.Cline;
        for (let k = 0; k < n; k++) {
            converged[k] = 1;
            if (net.last === 0) { y[k] = Infinity; regime[k] = regimeAt([x[k]], x[k], true); continue; }
            const gE = net.edges.map((e) => edgeG(e, x[k], G));
            const pl = linearSolve(net, gE, 0, new Map([[0, 1], [net.last, 0]]));
            y[k] = lineFlows(net, pl, (e, j) => gE[j] * (pl[e.a] - pl[e.b])).Q;
            regime[k] = regimeAt(pl, x[k], true);
        }
    } else {
        ymol = kind === 'Seff' ? mol.Seff : mol.Cline;
        const ratio = kind === 'dp' ? model.bc.p1 / model.bc.p0 : 0;
        // Newton iterations for the whole sweep (a normal one needs a few per point): once spent, the remaining points
        // get one short attempt each, so a pathological model gives gaps instead of a frozen page
        const per = iterationBudget(net);
        let guess = null, pFrom = null, left = 4 * per;
        for (let k = 0; k < n; k++) {
            const p0 = x[k], bc = kind === 'dp' ? { mode: 'dp', p0, p1: p0 * ratio } : { mode: 'pump', p0 };
            const budget = () => ({ budget: Math.max(60, Math.min(per, left)) });
            let r = guess ? solveAt(net, G, bc, guess, pFrom, budget()) : solveAt(net, G, bc, null, null, budget());
            left -= r.iterations;
            if (!r.converged && guess && left > 0) { r = solveAt(net, G, bc, null, null, budget()); left -= r.iterations; }
            if (r.converged) {
                const Q = net.last === 0 && net.pump ? p0 * pumpSc(net.pump, p0, G) : throughput(net, r.p, G);
                y[k] = kind === 'dp' ? Q / (p0 - bc.p1) : Q / p0;
                converged[k] = 1;
                guess = r.p; pFrom = p0;
            } else {
                y[k] = NaN;
            }
            regime[k] = regimeAt(r.p, p0, false);
        }
    }
    // Kn marks of the element with the largest molecular-limit share
    let knMarks = { kn05: null, kn001: null };
    const pm = kind === 'Seff' ? mol.pMol : mol.pLine;
    const ci = pm ? controlling(net, pm) : -1;
    if (ci >= 0) {
        const at = (Kn) => { const v = (SQRT_PI / 2) * G.eta * G.vm / (Kn * net.elems[ci].Dh); return v >= x[0] && v <= x[n - 1] ? v : null; };
        knMarks = { kn05: at(0.5), kn001: at(0.01) };
    }
    return { kind, x, y, ymol, regime, converged, knMarks };
}
