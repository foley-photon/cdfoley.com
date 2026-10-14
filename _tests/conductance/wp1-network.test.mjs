// WP1 network (spec 2.7, 3.5; acceptance 7.2.7): Haefer-consistent expansion, molecular solve, Newton with
// continuation on all presets from 1e-8 to 2e5 Pa, mass conservation, the AnalysisResult of Appendix C, the
// Appendix B values, sweeps, the error band and the performance limits.
// Run: node --test "_tests/conductance/wp1-network.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as N from '../../beta/conductance/js/engine/network.js';
import { edgeFlow, edgeG, pumpSc } from '../../beta/conductance/js/engine/flow.js';
import { gasState } from '../../beta/conductance/js/engine/gas.js';
import { compileItem } from '../../beta/conductance/js/engine/elements.js';

const GOLD = JSON.parse(readFileSync(new URL('./fixtures/golden-formulas.json', import.meta.url), 'utf8'));
const PRESETS = Object.fromEntries(Object.entries(GOLD.presets).map(([k, v]) => [k, v.model]));
const PI = Math.PI;
const rel = (a, b) => Math.abs(a / b - 1);
const N2 = gasState('N2', 293.15), AIR = gasState('air', 293.15);
const tube = (d, L) => ({ t: 'tube', d, L }), orif = (d) => ({ t: 'orifice', shape: 'circle', d });
const pump = (S, d, label = 'Pump') => ({ t: 'pump', S, d, label });
const gasOf = (m) => gasState(m.gas.id, m.gas.T, m.gas.custom, m.Cd);
const grid = (a, b, n) => Array.from({ length: n }, (_, k) => a * Math.pow(b / a, k / (n - 1)));
const lineAlpha = (items, Aref, G = AIR) => N.molecularLimit(items, G).Cline / (Aref * G.vbar / 4);

// Largest node imbalance relative to the largest edge or pump flow.
function imbalance(net, G, bc, p) {
    const F = new Float64Array(net.nodes.length);
    let qs = 0;
    for (const e of net.edges) { const q = edgeFlow(e, p[e.a], p[e.b], G); F[e.a] -= q; F[e.b] += q; qs = Math.max(qs, Math.abs(q)); }
    if (bc.mode === 'pump' && net.pump) { const q = p[net.last] * pumpSc(net.pump, p[net.last], G); F[net.last] -= q; qs = Math.max(qs, q); }
    let mx = 0;
    for (let i = 1; i < F.length; i++) if (!(bc.mode === 'dp' && i === net.last)) mx = Math.max(mx, Math.abs(F[i]));
    return mx / qs;
}

// Haefer's addition theorem in closed form for a series line (spec 3.5.3).
function haefer(items, G) {
    let R = 0, prevA = null;
    for (const it of items) {
        const e = compileItem(it, G);
        if (prevA === null) R += 4 / (e.Ain * G.vbar);
        else if (e.Ain < prevA * (1 - 1e-9)) R += (4 / G.vbar) * (1 / e.Ain - 1 / prevA);
        else if (e.aperture) continue;   // no effect
        if (!e.aperture) { R += (4 / (e.Ain * G.vbar)) * (1 / e.alpha - 1); prevA = e.Aout; } else prevA = e.Ain;
    }
    return 1 / R;
}

test('buildNetwork expands items into entrance, contraction and core edges (spec 3.5.3)', () => {
    const net = N.buildNetwork([tube(0.04, 0.1), tube(0.02, 0.1), tube(0.04, 0.1), orif(0.01), orif(0.03), { t: 'chamber' }, tube(0.02, 0.1), pump(0.005, 0.01)], N2);
    assert.deepEqual(net.edges.map((e) => e.k + (e.k === 'orif' ? (e.Afrom === Infinity ? '-entrance' : '-contraction') : '')), [
        'orif-entrance', 'core', 'orif-contraction', 'core', 'core', 'orif-contraction', 'orif-entrance', 'core', 'orif-contraction']);
    assert.deepEqual(net.edges.map((e) => e.el), [0, 0, 1, 1, 2, 3, 5, 5, -1]);
    for (let k = 1; k < net.edges.length; k++) assert.equal(net.edges[k].a, net.edges[k - 1].b, 'edges chain node to node');
    assert.equal(net.edges[0].a, 0);
    assert.equal(net.last, net.edges[net.edges.length - 1].b);
    assert.deepEqual(net.elems.map((e) => e.path), ['0', '1', '2', '3', '4', '6']);
    const [e3, e4] = [net.elems[3], net.elems[4]];
    assert.equal(e3.noEffect, false);
    assert.equal(e4.noEffect, true, 'an orifice larger than the bore before it has no effect');
    assert.ok(e4.flags.includes('no-effect'));
    assert.equal(e4.nodeIn, e4.nodeOut);
    assert.ok(net.nodes[net.elems[5].nodeIn].plenum, 'a chamber item makes a plenum');
    assert.deepEqual(Object.keys(net.pump), ['S', 'A', 're', 'attached', 'prevAout']);
    assert.ok(net.pump.S === 0.005 && net.pump.re === 0.005 && net.pump.attached === true);
    assert.ok(rel(net.pump.A, PI * 1e-4 / 4) < 1e-15 && rel(net.pump.prevAout, PI * 1e-4) < 1e-15);
    assert.equal(net.junctions, 3, 'three junctions before the chamber, none after it');
    // the contraction edge after the 0.04 tube into the orifice goes from the tube outlet area
    assert.ok(rel(net.edges[5].Afrom, PI * 0.0004) < 1e-15 && rel(net.edges[5].Ato, PI * 0.000025) < 1e-15);
});

test('buildNetwork: parallel groups between plenums, merged elements, detached pump, errors', () => {
    const items = [tube(0.05, 0.1), { t: 'parallel', branches: [[tube(0.02, 0.3)], [tube(0.03, 0.5), { t: 'elbow', d: 0.03, A: 0.05, B: 0.05 }], [tube(0.02, 0.1), orif(0.05)]] }, pump(0.05, 0.05)];
    const net = N.buildNetwork(items, N2);
    const inNode = net.elems[0].nodeOut, outNode = net.last;
    assert.ok(net.nodes[inNode].plenum && net.nodes[outNode].plenum);
    assert.deepEqual(net.elems.map((e) => e.path), ['0', '1.0.0', '1.1.0', '1.2.0', '1.2.1']);
    assert.deepEqual(net.elems[2].mergedFrom, [0, 1]);
    assert.deepEqual(net.elems[2].flags, ['merged']);
    for (const i of [1, 2, 3]) { assert.equal(net.elems[i].nodeIn, inNode); assert.equal(net.elems[i].nodeOut, outNode); }
    assert.ok(net.elems[4].noEffect && net.elems[4].nodeIn === outNode);
    assert.equal(net.pump.attached, false);
    assert.equal(net.pump.prevAout, null);
    assert.equal(net.junctions, 0);
    assert.throws(() => N.buildNetwork([pump(0.01, 0.05), tube(0.05, 0.1)], N2), /pump must be the last element/);
    assert.throws(() => N.buildNetwork([tube(0.05, 0.1), pump(10, 0.05)], N2), /^RangeError: Pumping speed exceeds the molecular-flow maximum for this inlet bore: S ≤ [\d.]+ L\/s\.$/);
    assert.throws(() => N.buildNetwork([{ t: 'tube', d: 0, L: 1 }], N2), RangeError);
});

test('molecular network equals Haefer\'s addition theorem and the design checks (spec 3.5.3)', () => {
    assert.ok(Math.abs(lineAlpha([orif(1), tube(2, 8)], PI * 0.25) - 0.53774) < 5e-6);
    assert.ok(Math.abs(lineAlpha([tube(2, 1), orif(1), tube(2, 1)], PI) - 0.20095) < 5e-6);
    assert.ok(Math.abs(lineAlpha([tube(4, 4), tube(2, 4)], 4 * PI) - 0.08222) < 5e-6);
    assert.ok(Math.abs(lineAlpha([tube(2, 4), tube(4, 4)], PI) - 0.32888) < 5e-6);
    assert.ok(Math.abs(lineAlpha([tube(15, 30), tube(25, 50), tube(20, 40)], PI * 7.5 ** 2) - 0.21406) < 5e-6);
    assert.ok(Math.abs(N.molecularLimit([tube(0.1, 0.2), pump(0.3, 0.1)], AIR).Seff * 1e3 - 188.02) < 0.005, 'Livesey 188 L/s');
    const lines = [
        [orif(0.01), tube(0.02, 0.08)], [tube(0.02, 0.01), orif(0.01), tube(0.02, 0.01)], [tube(0.04, 0.04), tube(0.02, 0.04)],
        // (v2.2: the annulus moved to the front; behind the 8 mm orifice its 10 mm rod blocked the line completely)
        [{ t: 'annulus', di: 0.01, do: 0.04, L: 0.06 }, { t: 'cone', d1: 0.04, d2: 0.063, L: 0.05 }, tube(0.063, 0.2), { t: 'rect', a: 0.01, b: 0.05, L: 0.1 }, orif(0.008), tube(0.04, 0.06)],
        [{ t: 'slit', h: 0.001, w: 0.02, L: 0.01 }, { t: 'elbow', d: 0.03, A: 0.05, B: 0.08 }, { t: 'cone', d1: 0.05, d2: 0.02, L: 0.1 }, { t: 'bbox', C: 0.02, gasRef: 'Ar', d: 0.02 }],
        [tube(0.02, 0.1), orif(0.03), tube(0.02, 0.1)],
    ];
    for (const items of lines) {
        const C = N.molecularLimit(items, N2).Cline, H = haefer(items, N2);
        assert.ok(rel(C, H) < 1e-10, `${JSON.stringify(items)}: ${C} vs ${H}`);
    }
});

test('linearSolve solves a conductance network exactly', () => {
    const net = N.buildNetwork([tube(0.04, 0.1), tube(0.02, 0.1)], N2);
    const g = net.edges.map((_, k) => k + 1);
    const p = N.linearSolve(net, g, 0, new Map([[0, 1], [net.last, 0]]));
    const Rtot = g.reduce((s, x) => s + 1 / x, 0);
    let q = 1 / Rtot, pp = 1;
    net.edges.forEach((e, k) => { assert.ok(Math.abs(p[e.a] - pp) < 1e-14); pp -= q / g[k]; });
    // with a pump conductance at the last node instead of a fixed pressure
    const p2 = N.linearSolve(net, g, 2, new Map([[0, 1]]));
    q = 1 / (Rtot + 0.5);
    assert.ok(Math.abs(p2[net.last] - q / 2) < 1e-14);
});

test('linearSolve keeps full relative accuracy when conductances span 20 decades (GTH elimination)', () => {
    // Gaussian elimination with partial pivoting returns pressures of -3e15 for this chain; GTH gets every node to 1e-15
    const g = [1e8, 1e-10, 3e5, 2e-3, 1e9, 5e-12, 7e2];
    const chain = { nodes: Array.from({ length: g.length + 1 }, () => ({ plenum: false })), edges: g.map((_, k) => ({ k: 'core', a: k, b: k + 1 })), last: g.length };
    const R = g.reduce((s, x) => s + 1 / x, 0), tail = (i) => g.slice(i).reduce((s, x) => s + 1 / x, 0);
    const p = N.linearSolve(chain, g, 0, new Map([[0, 1], [g.length, 0]]));
    for (let i = 1; i < g.length; i++) assert.ok(rel(p[i], tail(i) / R) < 1e-14, `node ${i}: ${p[i]} vs ${tail(i) / R}`);
    // the same chain drained by a pump conductance at its last node
    const gp = 4e-11, pp = N.linearSolve(chain, g, gp, new Map([[0, 1]]));
    for (let i = 1; i <= g.length; i++) assert.ok(rel(pp[i], (tail(i) + 1 / gp) / (R + 1 / gp)) < 1e-14, `pump node ${i}`);
    // a parallel pair of nodes: two branches of very different conductance between plenums
    const par = { nodes: Array.from({ length: 4 }, () => ({ plenum: false })), edges: [{ a: 0, b: 1 }, { a: 1, b: 3 }, { a: 0, b: 2 }, { a: 2, b: 3 }], last: 3 };
    const gq = [1e12, 1e-9, 2e-14, 3e10], pq = N.linearSolve(par, gq, 0, new Map([[0, 1], [3, 0]]));
    assert.ok(rel(pq[1], (1 / gq[1]) / (1 / gq[0] + 1 / gq[1])) < 1e-14 && rel(pq[2], (1 / gq[3]) / (1 / gq[2] + 1 / gq[3])) < 1e-14);
});

// Stiff lines found by fuzzing the solver (kept verbatim): conductances spanning 1e16 (m20), an isentropic cap that
// binds at a ppm drop at a pump inlet (sw1), a discharge coefficient of 0.014 that caps an orifice in molecular flow
// (m4), a choked orifice behind a 1e15 conductance ratio (m13), a parallel group 1e14 times more conductive than the
// slit after it (m37). Before the analytic orifice derivatives, GTH elimination and direction-preserving steps, every
// one of them failed to converge or gave a negative C sweep. (v2.2: two rods made thinner, m13's from 165 mm and
// m37's first from 55 mm to the 2.6 µm of its second: they blocked the bore before them completely, which the
// network now refuses.)
const STIFF = {
    sw1: { items: [{ t: 'cone', d1: 0.1881828637275163, d2: 0.04383664740306892, L: 0.014503062634629952 }, { t: 'chamber' }, { t: 'cone', d1: 0.16556023843131007, d2: 0.0017935680862044025, L: 0.9753702058180526 }, { t: 'elbow', d: 0.15743897406762228, A: 2.394066467091267, B: 0.32006708284143626 }, { t: 'orifice', shape: 'circle', d: 0.13071092867910764 }, { t: 'pump', S: 0.00005710402701550866, d: 0.016559690441226252, label: 'P' }], gas: { id: 'H2O', T: 77, custom: null }, Cd: null, bc: { mode: 'pump', p0: 0.9968673011243522 }, range: { pMin: 0.000001, pMax: 120000 } },
    m20: { items: [{ t: 'slit', h: 0.000015723138431129513, w: 0.00007056435883787423, L: 0.000007314573288304217 }, { t: 'tube', d: 0.9257685266500264, L: 0.000018244400396185588 }, { t: 'tube', d: 0.3015420281872327, L: 0.000022096453793667702 }, { t: 'rect', a: 0.00004522537015043919, b: 0.000005211610237061082, L: 0.00008309954840971517 }, { t: 'elbow', d: 0.0014121723097634952, A: 0.0019725190820458604, B: 0.026049886038371193 }, { t: 'bbox', C: 6.173956289871122e-11, gasRef: 'CO2', d: 0.00033346329411616604, label: 'BB' }, { t: 'slit', h: 0.00004488666787831167, w: 0.12407753873290397, L: 0.000007661721155903628 }, { t: 'pump', S: 0.00011506564883519714, d: 0.37341614790428734, label: 'P' }], gas: { id: 'H2', T: 400, custom: null }, Cd: null, bc: { mode: 'pump', p0: 0.4470892051288013 }, range: { pMin: 0.0002582480147852937, pMax: 12053.511438052159 } },
    m13: { items: [{ t: 'rect', a: 0.624100436572864, b: 0.16030691329360944, L: 0.584434281890497 }, { t: 'tube', d: 0.00007449475248110527, L: 0.04989774264765024 }, { t: 'rect', a: 0.06983891163209571, b: 0.002226444566722182, L: 0.0005823975981676357 }, { t: 'tube', d: 0.0005227018413146008, L: 0.023837137564581105 }, { t: 'rect', a: 0.003348053902751225, b: 0.0029017526779405215, L: 1.7077025071240772 }, { t: 'annulus', di: 0.00001, do: 0.682008765978972, L: 0.006471837222612491 }, { t: 'orifice', shape: 'circle', d: 0.0015726949583080357 }], gas: { id: 'He', T: 400, custom: null }, Cd: 0.08262346633747121, bc: { mode: 'dp', p0: 777810.3525306819, p1: 0.002525982126295991 }, range: { pMin: 4.273598428110541e-7, pMax: 9968687.303781966 } },
    m4: { items: [{ t: 'annulus', di: 0.0027778636450787497, do: 0.10951372845927845, L: 0.20984280066611935 }, { t: 'orifice', shape: 'circle', d: 0.034185521613622906 }, { t: 'rect', a: 0.011068465845980674, b: 0.0002399573954936573, L: 4.212311933281997 }, { t: 'slit', h: 0.025678385332704248, w: 0.20484967848354899, L: 0.1948940915892183 }, { t: 'orifice', shape: 'rect', w: 0.00017973524995176655, h: 0.0000018000011309958511 }, { t: 'pump', S: 9.277264572979787e-7, d: 0.0005306211423579112, label: 'P' }], gas: { id: 'Ar', T: 3000, custom: null }, Cd: 0.014206495270639517, bc: { mode: 'pump', p0: 501584.5891792682 }, range: { pMin: 3.7081530166348643e-9, pMax: 90112.74139769493 } },
    m37: { items: [{ t: 'parallel', branches: [[{ t: 'elbow', d: 0.00005827069293059393, A: 0.00042068174603482003, B: 0.008871318043804593 }], [{ t: 'tube', d: 0.007935962899712375, L: 0.0018901849139432872 }, { t: 'annulus', di: 0.000002609833521345306, do: 0.13079926658512833, L: 0.00043731478208685573 }, { t: 'annulus', di: 0.000002609833521345306, do: 0.0010998401648596124, L: 0.00035895698755479484 }]] }, { t: 'slit', h: 7.327347487105231e-8, w: 0.000017660829908402895, L: 0.0000022547888470813265 }, { t: 'pump', S: 0.019327122530840013, d: 0.01979758215074316, label: 'P' }], gas: { id: 'air', T: 400, custom: null }, Cd: null, bc: { mode: 'pump', p0: 2960.216425352459 }, range: { pMin: 0.00013354314449856843, pMax: 4422643.114053575 } },
};

test('stiff lines converge at every sweep point, conserve their flow and give positive C sweeps', () => {
    for (const [name, m] of Object.entries(STIFF)) {
        const r = N.analyze(m);
        assert.ok(r.ok && r.converged, `${name}: analyze`);
        assert.ok(Number.isFinite(r.Q) && r.Q > 0, `${name}: Q ${r.Q}`);
        if (m.bc.mode === 'pump') assert.ok(rel(r.Q, r.pN * r.pump.Sc) < 1e-9, `${name}: line flow ${r.Q} vs pump flow ${r.pN * r.pump.Sc}`);
        for (const e of r.elements) assert.ok(e.dp >= -1e-12 * e.pIn && e.pIn <= m.bc.p0 * (1 + 1e-12), `${name}: element ${e.path} pressures`);
        const op = N.sweep(m, m.bc.mode === 'pump' ? 'Seff' : 'dp');
        assert.ok(op.converged.every((c) => c === 1), `${name}: unconverged sweep points`);
        assert.ok([...op.y].every((v) => Number.isFinite(v) && v > 0), `${name}: operating sweep values`);
        const c = N.sweep(m, 'C');
        assert.ok([...c.y].every((v) => Number.isFinite(v) && v > 0), `${name}: C sweep values`);
        assert.ok(rel(N.sweep(m, 'C', { n: 1, pMin: 1e-10, pMax: 1e-10 }).y[0], r.mol.Cline) < 1e-6, `${name}: C sweep tends to C_mol`);
    }
});

test('solveAt stops at its Newton-iteration budget', () => {
    const m = PRESETS['roughing-kf25'], G = gasOf(m), net = N.buildNetwork(m.items, G);
    const full = N.solveAt(net, G, { mode: 'pump', p0: 1e5 });
    assert.ok(full.converged && full.iterations > 5);
    for (const budget of [0, 1, 5]) {
        const r = N.solveAt(net, G, { mode: 'pump', p0: 1e5 }, null, null, { budget });
        assert.equal(r.converged, false);
        assert.ok(r.iterations <= budget, `budget ${budget}: ${r.iterations} iterations`);
    }
    assert.ok(N.solveAt(net, G, { mode: 'pump', p0: 1e5 }, null, null, { budget: full.iterations }).converged);
});

const PRESSURES = grid(1e-8, 2e5, 121);

for (const [name, m] of Object.entries(PRESETS)) {
    test(`preset ${name}: converges at 121 pressures from 1e-8 to 2e5 Pa, <= 8 Newton iterations per step, mass conserved to 1e-10`, () => {
        const G = gasOf(m), net = N.buildNetwork(m.items, G), ratio = m.bc.mode === 'dp' ? m.bc.p1 / m.bc.p0 : 0;
        let worstIt = 0, worstImb = 0, guess = null, pFrom = null;
        for (const p0 of PRESSURES) {
            const bc = m.bc.mode === 'dp' ? { mode: 'dp', p0, p1: p0 * ratio } : { mode: 'pump', p0 };
            const fresh = N.solveAt(net, G, bc);
            assert.ok(fresh.converged, `${name}: no convergence at ${p0} Pa`);
            const cont = guess ? N.solveAt(net, G, bc, guess, pFrom) : fresh;
            assert.ok(cont.converged, `${name}: continuation failed at ${p0} Pa`);
            guess = cont.p; pFrom = p0;
            worstIt = Math.max(worstIt, fresh.maxIterations, cont.maxIterations);
            worstImb = Math.max(worstImb, imbalance(net, G, bc, fresh.p), imbalance(net, G, bc, cont.p));
        }
        assert.ok(worstIt <= 8, `${name}: ${worstIt} Newton iterations in one step`);
        assert.ok(worstImb <= 1e-10, `${name}: node imbalance ${worstImb}`);
    });
}

test('S_eff and the dp curves are monotone in p0 wherever the reference sweep is', () => {
    for (const [name, g] of Object.entries(GOLD.presets)) {
        const ref = g.sweepSeff;
        if (!ref) continue;
        const y = N.sweep(g.model, 'Seff').y;
        for (let k = 1; k < ref.length; k++) {
            const dr = ref[k] - ref[k - 1];
            if (Math.abs(dr) <= 1e-9 * Math.abs(ref[k])) continue;
            assert.equal(Math.sign(y[k] - y[k - 1]), Math.sign(dr), `${name} point ${k}`);
        }
    }
});

test('Appendix C: AnalysisResult of the default preset', () => {
    const r = N.analyze(PRESETS['turbo-dn100']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.gas.id, 'N2');
    assert.deepEqual(r.bc, { mode: 'pump', p0: 1e-4 });
    const near = (v, want, tol, what) => assert.ok(Math.abs(v / want - 1) <= tol, `${what}: ${v} vs ${want}`);
    near(r.Q, 1.3846e-5, 1e-4, 'Q'); near(r.Seff, 0.13846, 1e-4, 'Seff'); near(r.Cline, 0.20117, 1e-4, 'Cline'); near(r.pN, 3.117e-5, 2e-4, 'pN');
    near(r.mol.Cline, 0.20131, 1e-4, 'mol Cline'); near(r.mol.Seff, 0.13853, 1e-4, 'mol Seff');
    assert.ok(Math.abs(r.mol.band.lo + 0.013) < 1e-12 && Math.abs(r.mol.band.hi - 0.013) < 1e-12);
    assert.equal(r.mol.band.junctions, 0);
    assert.equal(r.mol.band.note, 'Exact molecular value expected between −1.3 % and +1.3 % of the formula value (Haefer/Oatley, 0 junctions).');
    assert.equal(r.regime, 'molecular');
    assert.equal(r.converged, true);
    assert.equal(r.elements.length, 1);
    const e = r.elements[0];
    assert.equal(e.path, '0'); assert.equal(e.t, 'elbow'); assert.equal(e.label, null); assert.equal(e.describe, 'Elbow Ø100, legs 300/100 mm');
    near(e.alpha, 0.21781, 2e-5, 'alpha'); near(e.Cmol, 0.20131, 1e-4, 'Cmol'); near(e.Cop, 0.20117, 1e-4, 'Cop'); near(e.dp, 6.883e-5, 2e-4, 'dp');
    near(e.share, 0.6883, 1e-4, 'share'); near(e.pIn, 1e-4, 1e-12, 'pIn'); near(e.pOut, 3.117e-5, 2e-4, 'pOut'); near(e.pMean, 6.5585e-5, 1e-4, 'pMean');
    near(e.Kn, 990, 1e-3, 'Kn');
    assert.equal(e.Re, null); assert.equal(e.Ma, null); assert.equal(e.regime, 'molecular'); assert.equal(e.limit, 'none'); assert.equal(e.accuracy, 0.003);
    assert.deepEqual(e.flags, ['merged']); assert.deepEqual(e.notes, []); assert.deepEqual(e.mergedFrom, [0, 1]); assert.equal(e.Leq, undefined);
    // Sc is S_c at the pump inlet pressure (spec 3.5.4); Appendix C quotes 0.44412, which is S_c at p0
    near(r.pump.Sc, 0.44416, 2e-5, 'Sc'); near(r.pump.Sc, 0.44412, 2e-4, 'Sc vs Appendix C');
    assert.equal(r.pump.S, 0.3); near(r.pump.pIn, 3.117e-5, 2e-4, 'pump pIn'); near(r.pump.share, 0.3117, 2e-4, 'pump share');
    near(r.pump.shareMol, 0.3119, 2e-4, 'pump shareMol'); near(r.pump.fraction, 0.4615, 2e-4, 'fraction');
    near(r.shareMol[0], 0.6881, 1e-4, 'shareMol');
    assert.ok(Math.abs(r.elements[0].share + r.pump.share - 1) < 1e-12);
});

test('Appendix B: formula results of the seven presets', () => {
    const L = 1e3, near = (v, want, tol, what) => assert.ok(Math.abs(v / want - 1) <= tol, `${what}: ${v} vs ${want}`);
    let r = N.analyze(PRESETS['livesey-p100']);
    near(r.Seff * L, 187.95, 3e-5, 'P2 Seff'); near(r.Cline * L, 323.92, 3e-5, 'P2 Cline'); near(r.mol.Seff * L, 188.02, 3e-5, 'P2 mol Seff'); near(r.mol.Cline * L, 324.10, 3e-5, 'P2 mol C');
    r = N.analyze(PRESETS['roughing-kf25']);
    near(r.Seff * L, 8.1326, 1e-5, 'P3 Seff'); near(r.Cline * L, 48.93, 1e-4, 'P3 Cline'); near(r.mol.Seff * L, 1.5425, 5e-5, 'P3 mol Seff'); near(r.mol.Cline * L, 1.7761, 5e-5, 'P3 mol C');
    assert.equal(r.regime, 'viscous'); near(r.elements[0].Kn, 0.0029, 0.02, 'P3 Kn'); near(r.elements[0].Re, 27, 0.02, 'P3 Re');
    r = N.analyze(PRESETS.beamline);
    near(r.Seff * L, 21.431, 3e-5, 'P4 Seff'); near(r.Cline * L, 27.109, 3e-5, 'P4 Cline'); near(r.mol.Seff * L, 21.431, 3e-5, 'P4 mol Seff');
    assert.ok(Math.abs(r.elements[1].Leq * 1e3 - 35.7) < 0.05); assert.equal(r.mol.band.junctions, 2);
    assert.ok(Math.abs(r.mol.band.lo + 0.014) < 1e-12 && Math.abs(r.mol.band.hi - 0.084) < 1e-12);
    assert.equal(r.mol.band.note, 'Exact molecular value expected between −1.4 % and +8.4 % of the formula value (Haefer/Oatley, 2 junctions).');
    r = N.analyze(PRESETS['diff-aperture']);
    near(r.Q, 1.0053e-3, 5e-5, 'P5 Q'); near(r.Cline * L, 0.10063, 5e-5, 'P5 C'); near(r.mol.Cline * L, 0.092423, 5e-5, 'P5 mol C');
    near(r.Cline / r.mol.Cline - 1, 0.089, 0.01, 'P5 above molecular'); assert.equal(r.Seff, null); assert.equal(r.pump, null); assert.equal(r.mol.Seff, null);
    r = N.analyze(PRESETS['slit-seal']);
    // v2.2: 61.88 and 0.6251 before the plane-channel cap of slot-like cores (spec 3.3.2), which lowers the slip term
    near(r.Q, 61.487, 1e-4, 'P6 Q'); near(r.Cline * L, 0.62109, 1e-4, 'P6 C'); near(r.mol.Cline * L, 0.026876, 5e-5, 'P6 mol C');
    assert.ok(r.elements[0].flags.includes('choked-exit')); assert.equal(r.elements[0].limit, 'choked-exit'); assert.equal(r.elements[0].regime, 'viscous');
    near(r.elements[0].Re, 1.6e3, 0.02, 'P6 Re');
    r = N.analyze(PRESETS.parallel);
    near(r.Seff * L, 6.1651, 2e-5, 'P7 Seff'); near(r.Cline * L, 7.0322, 2e-5, 'P7 Cline'); near(r.mol.Seff * L, 6.1663, 2e-5, 'P7 mol Seff'); near(r.mol.Cline * L, 7.0337, 2e-5, 'P7 mol C');
    assert.ok(Math.abs(r.mol.band.lo + 0.003) < 1e-12 && Math.abs(r.mol.band.hi - 0.003) < 1e-12);
    near(r.pump.Sc, 0.05, 1e-15, 'P7 detached pump');
    // shares: the two branches carry the same drop; top-level elements and the pump add to one
    near(r.elements[1].share, r.elements[2].share, 1e-12, 'branch shares');
    near(r.elements[0].share + r.elements[1].share + r.pump.share, 1, 1e-12, 'P7 share sum');
});

test('sweeps: Seff spot values of preset 1, the C sweep from C_mol into the viscous regime, Kn marks', () => {
    const m = PRESETS['turbo-dn100'];
    const s = N.sweep(m, 'Seff');
    assert.equal(s.kind, 'Seff');
    assert.equal(s.x.length, 61);
    assert.ok(rel(s.x[0], 1e-6) < 1e-15 && rel(s.x[60], 1.2e5) < 1e-12);
    [[0, 138.53], [20, 136.72], [30, 150.16], [40, 287.87], [50, 296.21], [60, 296.34]].forEach(([k, v]) => assert.ok(Math.abs(s.y[k] * 1e3 - v) < 0.006, `Seff[${k}]`));
    assert.ok(rel(s.ymol, 0.13853) < 1e-4);
    assert.equal(s.regime[0], 'molecular'); assert.equal(s.regime[60], 'viscous');
    const kn05 = (Math.sqrt(PI) / 2) * N2.eta * N2.vm / (0.5 * 0.1);
    assert.ok(rel(s.knMarks.kn05, kn05) < 1e-12 && rel(s.knMarks.kn001, kn05 * 50) < 1e-12);
    const c = N.sweep(m, 'C');
    // at 1e-6 Pa the line is molecular to about 1e-5 (Z and g differ from 1 by O(delta)); in the limit it is exact
    assert.ok(rel(c.y[0], c.ymol) < 1e-4 && rel(c.ymol, 0.20131) < 1e-4, 'C sweep starts at C_mol');
    assert.ok(rel(N.sweep(m, 'C', { n: 1, pMin: 1e-10, pMax: 1e-10 }).y[0], c.ymol) < 1e-8, 'and equals it in the limit');
    assert.ok(rel((c.y[60] / c.y[59]) / (c.x[60] / c.x[59]), 1) < 0.01, 'C grows in proportion to the mean pressure in viscous flow');
    assert.ok(c.converged.every((v) => v === 1));
    const dp = N.sweep(PRESETS['slit-seal'], 'dp', { n: 11 });
    assert.equal(dp.kind, 'dp');
    assert.ok(dp.converged.every((v) => v === 1));
    assert.ok(rel(dp.y[0], dp.ymol) < 1e-3, 'dp sweep starts at the molecular conductance');
    assert.throws(() => N.sweep(PRESETS['slit-seal'], 'Seff'), RangeError);
    assert.throws(() => N.sweep(m, 'dp'), RangeError);
    assert.throws(() => N.sweep(m, 'other'), RangeError);
    assert.throws(() => N.sweep({ ...m, bc: { mode: 'pump', p0: -1 } }, 'C'), RangeError);
});

test('pump-inlet contraction: shares add to one and the C sweep starts at C_mol', () => {
    const m = { items: [tube(0.1, 0.2), pump(0.1, 0.063)], gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'pump', p0: 1e-2 } };
    const r = N.analyze(m);
    assert.ok(r.ok);
    assert.ok(Math.abs(r.elements[0].share + r.pump.share - 1) < 1e-12);
    assert.ok(Math.abs(r.shareMol[0] + r.pump.shareMol - 1) < 1e-12);
    assert.ok(r.pump.pIn < r.elements[0].pOut, 'the pump inlet lies after the contraction');
    const c = N.sweep(m, 'C', { n: 3, pMin: 1e-10, pMax: 1 });
    assert.ok(rel(c.y[0], r.mol.Cline) < 1e-8);
});

test('pump directly on the chamber, invalid models, warnings and no-effect orifices', () => {
    const m = { items: [pump(0.1, 0.063)], gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'pump', p0: 1 } };
    const r = N.analyze(m);
    assert.ok(r.ok);
    assert.equal(r.Seff, 0.1); assert.equal(r.Cline, Infinity); assert.equal(r.pN, 1); assert.deepEqual(r.elements, []);
    assert.equal(r.pump.share, 1); assert.equal(r.pump.fraction, 1); assert.equal(r.mol.Seff, 0.1); assert.equal(r.mol.Cline, Infinity);
    assert.ok(N.sweep(m, 'C', { n: 2 }).y.every((v) => v === Infinity));
    const bad = N.analyze({ ...m, items: [tube(-1, 1), pump(0.1, 0.063)] });
    assert.equal(bad.ok, false);
    assert.equal(bad.errors[0].path, '0');
    assert.deepEqual(N.analyze(undefined).ok, false);
    const h2o = (p0, T) => N.analyze({ items: [tube(0.05, 0.5), pump(0.05, 0.05)], gas: { id: 'H2O', T, custom: null }, Cd: null, bc: { mode: 'pump', p0 } }).warnings;
    assert.deepEqual(h2o(3000, 293.15), ['water-condenses']);
    assert.deepEqual(h2o(1000, 293.15), []);
    assert.deepEqual(h2o(2e5, 400), [], 'the condensation check is skipped above 100 °C');
    assert.deepEqual(N.analyze({ ...m, gas: { id: 'N2', T: 150, custom: null } }).warnings, ['temperature-range']);
    const noEff = N.analyze({ ...m, items: [tube(0.02, 0.1), orif(0.03), tube(0.02, 0.1), pump(0.01, 0.02)] });
    assert.ok(noEff.ok);
    assert.ok(noEff.elements[1].flags.includes('no-effect') && noEff.elements[1].share === 0 && noEff.elements[1].Re === null);
    assert.equal(noEff.mol.band.junctions, 1);
});

test('errorBand follows spec 3.5.6 (0.035 per junction, accuracy, pump term, 25 % cap; v2.3 line-of-sight term)', () => {
    const G = N2;
    // v2.3: the line-of-sight estimate adds gapHi = min(0.75, 1/(1 - 1.5 x) - 1) to hi and gapLo = 1 - 1/(1 + 1.5 x) to lo
    const gapHi = (x) => (x > 0 ? Math.min(0.75, 1 / (1 - 1.5 * x) - 1) : 0), gapLo = (x) => (x > 0 ? 1 - 1 / (1 + 1.5 * x) : 0);
    const net0 = N.buildNetwork([tube(0.02, 0.1), { t: 'rect', a: 0.01, b: 0.012, L: 0.1 }, { t: 'cone', d1: 0.03, d2: 0.05, L: 0.1 }], G);
    const b0 = N.errorBand(net0, true), los0 = N.lineOfSight(net0);
    assert.equal(b0.junctions, 2);
    // the cone fed through the narrower duct transmits a little more than Haefer's mixed inlet (a fraction of a percent)
    assert.ok(los0.lo === 0 && los0.hi > 0 && los0.hi < 0.01, JSON.stringify(los0));
    assert.ok(Math.abs(b0.hi - (0.07 + 0.004 + 0.01 + gapHi(los0.hi))) < 1e-15 && Math.abs(b0.lo + 0.014) < 1e-15, JSON.stringify(b0));
    // v2.2/v2.3: a junction into or out of an annulus widens lo by 10 % and hi by 5 %, each times min(1, e/0.75)
    const netR = N.buildNetwork([tube(0.02, 0.1), { t: 'annulus', di: 0.012, do: 0.02, L: 0.1 }, tube(0.02, 0.1)], G);
    const bRing = N.errorBand(netR, false), losR = N.lineOfSight(netR);
    assert.equal(bRing.junctions, 2);
    assert.ok(Math.abs(bRing.lo + (0.005 + 2 * 0.1 * 0.6 / 0.75 + gapLo(losR.lo))) < 1e-12 && Math.abs(bRing.hi - (0.07 + 0.005 + 2 * 0.05 * 0.6 / 0.75 + gapHi(losR.hi))) < 1e-12, JSON.stringify(bRing));
    assert.match(bRing.note, /rod end face/);
    // a partial overlap widens lo by the blocked fraction (at least 10 %) and hi by 5 %, and is flagged
    const netP = N.buildNetwork([{ t: 'slit', h: 0.001, w: 0.05, L: 0.01 }, tube(0.02, 0.02)], G), bP = N.errorBand(netP, false);
    assert.ok(netP.elems[1].flags.includes('partial-overlap'));
    assert.ok(bP.lo < -0.55 && bP.lo > -0.65 && Math.abs(bP.hi - (0.035 + 0.003 + 0.05)) < 1e-12, JSON.stringify(bP));
    assert.match(bP.note, /partly overlap/);
    const many = Array.from({ length: 10 }, (_, k) => tube(0.02 + 0.002 * (k % 2), 0.05));
    const netM = N.buildNetwork(many, G), b1 = N.errorBand(netM, false);
    assert.equal(b1.junctions, 9);
    assert.equal(b1.hi, 0.25 + gapHi(N.lineOfSight(netM).hi));
    assert.match(b1.note, /^Exact molecular value expected between −0\.1 % and \+2\d\.\d % of the formula value \(Haefer\/Oatley, 9 junctions\)\.$/);
    assert.match(N.errorBand(N.buildNetwork([tube(0.02, 0.1), tube(0.03, 0.1)], G), false).note, /1 junction\)\.$/);
    // tubes of one bore and long tubes add nothing
    assert.deepEqual(N.lineOfSight(N.buildNetwork([tube(0.02, 0.1), orif(0.02), tube(0.02, 0.3)], G)), { lo: 0, hi: 0 });
});

// ---- v2.3 fix round 2: line of sight across short elements (rod end faces, plates, aligned narrow openings)
test('gapTransmission reproduces the tube and cone transmission probabilities', () => {
    const disc = (r) => ({ ri: 0, ro: r });
    for (const [y, ref] of [[0.25, 0.80127], [0.5, 0.67198], [1, 0.51423]]) {
        const p = N.gapTransmission(disc(1), disc(1), 1, 1, 2 * y);
        assert.ok(Math.abs(p / ref - 1) < 0.0015, `tube L/d ${y}: ${p} vs ${ref}`);
    }
    // cones from the tables (coneAlpha): R1 0.5 -> R2 1 over L 1, and the reverse
    assert.ok(Math.abs(N.gapTransmission(disc(0.5), disc(1), 0.5, 1, 1) / 0.89449 - 1) < 0.002);
    assert.ok(Math.abs(N.gapTransmission(disc(1), disc(0.5), 1, 0.5, 1) / 0.22362 - 1) < 0.002);
    // reciprocity A_S P(S -> T) = A_T P(T -> S) for a ring facing a narrow disc
    const a = N.gapTransmission({ ri: 0.5, ro: 1 }, disc(0.3), 1, 1, 0.4), b = N.gapTransmission(disc(0.3), { ri: 0.5, ro: 1 }, 1, 1, 0.4);
    assert.ok(Math.abs(0.75 * a / (0.09 * b) - 1) < 1e-6, `${0.75 * a} vs ${0.09 * b}`);
});

test('the error band covers chain Monte Carlo at rod end faces and aligned narrow openings (fix round 2)', () => {
    const g = { id: 'N2', T: 293.15, custom: null }, bc = { mode: 'dp', p0: 1e-4, p1: 5e-5 };
    const ann = (di, dd, L) => ({ t: 'annulus', di, do: dd, L }), cone = (d1, d2, L) => ({ t: 'cone', d1, d2, L });
    // chain Monte Carlo, 10^6 particles (N2, L/s): a cone into a rod (exact value 29 % and 17 % below the formula), a cone
    // after a tube (10 % below), aligned ring gaps (16 % and 13 % above), aligned plates 0.25 R apart (about 40 % above)
    const cases = [
        [[cone(0.02, 0.03, 0.005), ann(0.02, 0.03, 0.01)], 12.645],
        [[cone(0.024, 0.04, 0.01), ann(0.024, 0.04, 0.03)], 21.003],
        [[tube(0.02, 0.01), cone(0.02, 0.03, 0.01), ann(0.02, 0.03, 0.01)], 12.580],
        [[ann(0.016, 0.02, 0.002), tube(0.02, 0.002), ann(0.016, 0.02, 0.002)], 5.9295],
        [[ann(0.016, 0.02, 0.002), ann(0.01, 0.02, 0.002), ann(0.016, 0.02, 0.002)], 5.9362],
        [[orif(0.01), tube(0.02, 0.0025), orif(0.01)], null],
    ];
    for (const [items, mc] of cases) {
        const a = N.analyze({ items, gas: g, Cd: null, bc });
        assert.ok(a.ok, JSON.stringify(a.errors));
        if (mc === null) { assert.ok(a.mol.band.hi > 0.4, JSON.stringify(a.mol.band)); continue; }
        const dev = mc * 1e-3 / a.mol.Cline - 1;
        assert.ok(dev >= a.mol.band.lo && dev <= a.mol.band.hi, `${JSON.stringify(items)}: ${dev} in [${a.mol.band.lo}, ${a.mol.band.hi}]`);
    }
    const c1 = N.analyze({ items: cases[0][0], gas: g, Cd: null, bc });
    assert.match(c1.mol.band.note, /flies straight onto a rod end face.*use the Monte Carlo check\.$/);
});

// A 40-item line with two parallel groups and every element type
function bigModel(p0) {
    const items = [];
    const kinds = [tube(0.05, 0.2), { t: 'elbow', d: 0.05, A: 0.1, B: 0.1 }, { t: 'cone', d1: 0.05, d2: 0.04, L: 0.05 }, { t: 'rect', a: 0.02, b: 0.04, L: 0.1 },
        orif(0.015), { t: 'annulus', di: 0.01, do: 0.04, L: 0.08 }, { t: 'slit', h: 0.002, w: 0.04, L: 0.02 }, { t: 'bbox', C: 0.05, gasRef: 'N2', d: 0.04, label: 'Valve' }];
    for (let k = 0; items.length < 36; k++) items.push(kinds[k % kinds.length]);
    const branch = (d) => [tube(d, 0.1), { t: 'elbow', d, A: 0.05, B: 0.05 }, { t: 'cone', d1: d, d2: d * 1.5, L: 0.05 }, tube(d * 1.5, 0.1)];
    items.splice(10, 0, { t: 'parallel', branches: [branch(0.02), branch(0.025), [tube(0.01, 0.3)]] });
    items.splice(25, 0, { t: 'parallel', branches: [branch(0.03), [orif(0.01)], [{ t: 'slit', h: 0.001, w: 0.05, L: 0.01 }]] }, { t: 'chamber' });
    items.length = 39;
    items.push(pump(0.2, 0.05, 'Turbo'));
    return { items, gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'pump', p0 }, range: { pMin: 1e-6, pMax: 1.2e5 } };
}

const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
function timeIt(fn, runs) {
    fn();
    const t = [];
    for (let k = 0; k < runs; k++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); }
    return median(t);
}

test('performance: the 40-item model with two parallel groups solves at 1 bar within 250 ms; presets within 5 ms', () => {
    const m = bigModel(1e5);
    assert.equal(m.items.length, 40);
    assert.equal(m.items.filter((i) => i.t === 'parallel').length, 2);
    const r = N.analyze(m);
    assert.ok(r.ok, JSON.stringify(r.errors));
    assert.ok(r.converged);
    const ms = timeIt(() => N.analyze(m), 3);
    assert.ok(ms <= 250, `40-item model: ${ms.toFixed(1)} ms`);
    for (const [name, pm] of Object.entries(PRESETS)) {
        const t = timeIt(() => N.analyze(pm), 5);
        assert.ok(t <= 5, `${name}: ${t.toFixed(2)} ms`);
    }
});

// ---- v2.2 fix round 1: coaxial overlap, pump wider than the line, regime labels, no molecular exit choke
test('openings that do not overlap are refused with the element path; partial overlaps contract to the overlap', () => {
    const ann = { t: 'annulus', di: 0.01, do: 0.02, L: 0.01 };
    let r = N.analyze({ items: [orif(0.01), ann], gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'dp', p0: 1e-4, p1: 5e-5 } });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].path, '1');
    assert.match(r.errors[0].message, /does not overlap/);
    r = N.analyze({ items: [tube(0.008, 0.02), ann], gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'dp', p0: 1e-4, p1: 5e-5 } });
    assert.equal(r.ok, false);
    const net = N.buildNetwork([orif(0.012), ann], N2);
    const c = net.edges.find((e) => e.k === 'orif' && e.Afrom !== Infinity);
    assert.ok(rel(c.Ato, PI * (0.006 ** 2 - 0.005 ** 2)) < 1e-12 && rel(c.Afrom, PI * 0.006 ** 2) < 1e-12);
    assert.ok(net.elems[1].flags.includes('partial-overlap'));
    // the chain Monte Carlo of this line gives 3.357 L/s (N2): the formula is within its band
    const a = N.analyze({ items: [orif(0.012), ann], gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'dp', p0: 1e-4, p1: 5e-5 } });
    const dev = 3.357e-3 / a.mol.Cline - 1;
    assert.ok(dev >= a.mol.band.lo && dev <= a.mol.band.hi, `${dev} in [${a.mol.band.lo}, ${a.mol.band.hi}]`);
    // a pump that does not overlap the outlet is refused too
    const rp = N.analyze({ items: [ann, pump(0.001, 0.008)], gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'pump', p0: 1e-4 } });
    assert.equal(rp.ok, false);
    assert.match(rp.errors[0].message, /pump inlet does not overlap/);
});

test('a pump wider than the line is flagged; an adapter as an element clears the flag', () => {
    const g = { id: 'N2', T: 293.15, custom: null };
    const a = N.analyze({ items: [tube(0.04, 0.05), pump(0.3, 0.1)], gas: g, Cd: null, bc: { mode: 'pump', p0: 1e-4 } });
    assert.ok(a.ok && a.warnings.includes('pump-wider'));
    const b = N.analyze({ items: [tube(0.04, 0.05), { t: 'cone', d1: 0.04, d2: 0.1, L: 0.06 }, pump(0.3, 0.1)], gas: g, Cd: null, bc: { mode: 'pump', p0: 1e-4 } });
    assert.ok(b.ok && !b.warnings.includes('pump-wider'));
    const c = N.analyze(PRESETS['turbo-dn100']);
    assert.ok(!c.warnings.includes('pump-wider'));
});

test('regime: near-molecular departures are labelled transitional; no exit choke in molecular flow', () => {
    const r5 = N.analyze(PRESETS['diff-aperture']);
    assert.equal(r5.elements[0].regime, 'transitional');
    assert.equal(r5.regime, 'transitional');
    const t = N.analyze({ items: [tube(0.01, 0.1)], gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'dp', p0: 1, p1: 1e-3 } });
    assert.ok(t.elements[0].Kn > 0.5);
    assert.deepEqual(t.elements[0].flags, []);
    assert.equal(t.elements[0].limit, 'none');
    const m1 = N.analyze(PRESETS['turbo-dn100']);
    assert.equal(m1.regime, 'molecular');
    for (const p0 of [1e-4, 0.1]) {
        const lim = PI * 0.01 / 4 * N2.vbar / 4;
        const r = N.analyze({ items: [tube(0.1, 0.2), pump(0.99 * lim, 0.1)], gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'pump', p0 } });
        assert.ok(r.ok && !r.elements[0].flags.includes('choked-exit'), `p0 ${p0}: ${r.elements[0].flags}`);
    }
});
