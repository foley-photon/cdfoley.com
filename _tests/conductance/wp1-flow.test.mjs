// WP1 transitional and viscous flow laws (spec 2.5, 3.3; acceptance 7.2.6).
// Run: node --test "_tests/conductance/wp1-flow.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../../beta/conductance/js/engine/flow.js';
import { GP_SHARIPOV, ORIFICE_A } from '../../beta/conductance/js/engine/tables.js';
import { gasState } from '../../beta/conductance/js/engine/gas.js';
import { compileItem } from '../../beta/conductance/js/engine/elements.js';
import { analyze, sweep } from '../../beta/conductance/js/engine/network.js';

const G0 = 8 / (3 * Math.sqrt(Math.PI));
const rel = (a, b) => Math.abs(a / b - 1);
const N2 = gasState('N2', 293.15), AIR = gasState('air', 293.15);

function coreEdge(item, G) {
    const e = compileItem(item, G);
    return { k: 'core', a: 0, b: 1, kv: e.kv, Cm: e.Cm, s: e.s, Aout: e.Aout, el: 0 };
}
const entrance = (d) => ({ k: 'orif', a: 0, b: 1, Ato: Math.PI * d * d / 4, reTo: d / 2, Afrom: Infinity, reFrom: Infinity, el: 0 });
const contraction = (dTo, dFrom) => ({ k: 'orif', a: 0, b: 1, Ato: Math.PI * dTo * dTo / 4, reTo: dTo / 2, Afrom: Math.PI * dFrom * dFrom / 4, reFrom: dFrom / 2, el: 0 });

test('Z(delta): Z(0) = 1, reproduces Sharipov G_P at the nodes, continuous at 0.001 and 50, slip limit beyond', () => {
    assert.equal(F.Z(0), 1);
    assert.equal(F.Z(-1), 1);
    GP_SHARIPOV.delta.forEach((d, i) => {
        assert.ok(Math.abs(F.Z(d) - (GP_SHARIPOV.GP[i] - d / 4) / G0) < 1e-14, `delta ${d}`);
        assert.ok(rel(F.GP(d), GP_SHARIPOV.GP[i]) < 1e-14);
    });
    for (const d of [0.001, 50]) assert.ok(Math.abs(F.Z(d * (1 - 1e-12)) - F.Z(d * (1 + 1e-12))) < 1e-12);
    for (const d of [60, 200, 1e4]) assert.ok(rel(F.Z(d), (1.018 - 1.15 / d) / G0) < 1e-15);
    assert.ok(rel(F.GP(1e6), 1e6 / 4 + 1.018) < 1e-8);
    assert.ok(Math.abs(F.GP(0) - G0) < 1e-15);
});

// 10^5-step trapezoid of Z on [0, delta]: exact linear piece on [0, 0.001], log-spaced steps above
function trapezoidIZ(delta) {
    const d0 = Math.min(delta, 0.001);
    let s = d0 * (F.Z(0) + F.Z(d0)) / 2;
    if (delta > 0.001) {
        const n = 100000, r = Math.pow(delta / 0.001, 1 / n);
        let t0 = 0.001, z0 = F.Z(t0);
        for (let k = 1; k <= n; k++) { const t1 = k === n ? delta : t0 * r, z1 = F.Z(t1); s += (t1 - t0) * (z0 + z1) / 2; t0 = t1; z0 = z1; }
    }
    return s;
}

test('IZ agrees with a 10^5-step trapezoid integration of Z to 1e-7', () => {
    for (const d of [0.0004, 0.001, 0.0123, 0.2, 0.7, 1, 3.3, 17, 50, 80, 300, 1000]) {
        assert.ok(rel(F.IZ(d), trapezoidIZ(d)) < 1e-7, `delta ${d}: ${F.IZ(d)} vs ${trapezoidIZ(d)}`);
    }
    assert.equal(F.IZ(0), 0);
    // derivative of IZ is Z
    for (const d of [0.0005, 0.03, 2, 40, 500]) {
        const h = d * 1e-6;
        assert.ok(rel((F.IZ(d + h) - F.IZ(d - h)) / (2 * h), F.Z(d)) < 1e-7, `dIZ/dd at ${d}`);
    }
});

test('orifice helpers: A(r) piecewise linear and clamped, g(delta, r), r*, psi', () => {
    ORIFICE_A.r.forEach((r, i) => assert.ok(Math.abs(F.nearFmA(r) - ORIFICE_A.A[i]) < 1e-15));
    assert.ok(Math.abs(F.nearFmA(0.3) - (0.15 + 0.08 * 0.5)) < 1e-15);
    assert.equal(F.nearFmA(-1), 0.13);
    assert.equal(F.nearFmA(2), 0.342);
    assert.equal(F.gOrifice(0, 0.4), 1);
    assert.ok(Math.abs(F.gOrifice(1, 1) - 1.342) < 1e-15);
    assert.ok(rel(F.gOrifice(1000, 1), (2 / (3 * Math.sqrt(Math.PI))) * 1000) < 1e-15);
    assert.ok(Math.abs(F.rStar(1.4) - 0.5282817877) < 1e-10);
    assert.ok(Math.abs(F.psi(0, 1.4) - 0.68473146) < 1e-8);
    for (const g of [1.29, 1.4, 5 / 3]) {
        const rs = F.rStar(g);
        assert.ok(Math.abs(F.psi(rs * (1 + 1e-9), g) - F.psi(rs, g)) < 1e-6, `psi continuous at r* for gamma ${g}`);
        assert.equal(F.psi(1, g), 0);
        assert.equal(F.psi(0.01, g), F.psi(0, g));
    }
});

test('edgeFlow is antisymmetric to 1e-15 for core and orifice edges in every regime', () => {
    const edges = [coreEdge({ t: 'tube', d: 0.02, L: 0.5 }, N2), coreEdge({ t: 'rect', a: 0.001, b: 0.03, L: 0.02 }, N2), coreEdge({ t: 'cone', d1: 0.04, d2: 0.1, L: 0.1 }, N2),
        entrance(0.01), contraction(0.01, 0.03)];
    const ps = [1e-8, 3e-5, 0.02, 1.7, 90, 4e3, 1e5, 3e6];
    for (const e of edges) {
        for (const pa of ps) {
            for (const pb of ps) {
                const q1 = F.edgeFlow(e, pa, pb, N2), q2 = F.edgeFlow(e, pb, pa, N2);
                assert.ok(Math.abs(q1 + q2) <= 1e-15 * Math.abs(q1), `${e.k} ${pa} ${pb}`);
                if (pa > pb) assert.ok(q1 > 0);
            }
            assert.equal(F.edgeFlow(e, pa, pa, N2), 0);
        }
    }
});

// independent central difference with its own step
const numDeriv = (f, x, h) => (f(x + h) - f(x - h)) / (2 * h);

test('edgeDerivs agrees with central differences to 1e-5', () => {
    const cases = [
        [N2, coreEdge({ t: 'tube', d: 0.02, L: 0.5 }, N2), [[1e-6, 2e-7], [2, 0.5], [300, 290], [5e4, 4.9e4]]],
        [N2, coreEdge({ t: 'annulus', di: 0.01, do: 0.03, L: 0.2 }, N2), [[0.01, 0.003], [80, 10], [1e5, 9e4]]],
        [AIR, coreEdge({ t: 'slit', h: 0.0001, w: 0.05, L: 0.01 }, AIR), [[1e5, 1e3], [1e5, 6e4]]],   // the first point is exit-choked
        [N2, entrance(0.01), [[1e-3, 3e-4], [2, 1.3], [1e4, 9e3], [1e5, 1e3]]],                          // the last point is choked
        [N2, contraction(0.01, 0.03), [[0.5, 0.42], [3e3, 2.2e3]]],
    ];
    for (const [G, e, pts] of cases) {
        for (const [pa, pb] of pts) {
            const [q, da, db] = F.edgeDerivs(e, pa, pb, G);
            assert.equal(q, F.edgeFlow(e, pa, pb, G));
            const h = 1e-5 * Math.abs(pa - pb);
            const nda = numDeriv((x) => F.edgeFlow(e, x, pb, G), pa, h), ndb = numDeriv((x) => F.edgeFlow(e, pa, x, G), pb, h);
            const scale = Math.max(Math.abs(da), Math.abs(db));
            assert.ok(Math.abs(da - nda) <= 1e-5 * scale, `${e.k} dQ/dpa at ${pa}, ${pb}: ${da} vs ${nda}`);
            assert.ok(Math.abs(db - ndb) <= 1e-5 * scale, `${e.k} dQ/dpb at ${pa}, ${pb}: ${db} vs ${ndb}`);
        }
    }
    // unchoked cores use the analytic derivatives of spec 3.5.5
    const core = coreEdge({ t: 'tube', d: 0.02, L: 0.5 }, N2);
    const [, da, db] = F.edgeDerivs(core, 2, 0.5, N2);
    assert.equal(da, core.kv * 2 + core.Cm * F.Z(2 / core.s));
    assert.equal(db, -(core.kv * 0.5 + core.Cm * F.Z(0.5 / core.s)));
});

test('orifice derivatives stay exact at drops of a few ppm (inertial branch, where differences lose four digits)', () => {
    // a contraction into a 16.6 mm pump inlet in water vapor at 77 K: the isentropic cap binds at a drop of 1.4 ppm
    const H2O = gasState('H2O', 77), e = contraction(0.016559690441226252, 0.13071092867910764);
    const pa = 997.287660168, pb = 997.286228614;
    assert.equal(F.edgeLimit(e, pa, pb, H2O), 'inertial');
    const [q, da, db] = F.edgeDerivs(e, pa, pb, H2O);
    // the isentropic flow is homogeneous of degree one in (pa, pb): Euler's identity holds to rounding
    assert.ok(Math.abs(da * pa + db * pb - q) <= 1e-9 * q, `da pa + db pb = ${da * pa + db * pb} vs Q = ${q}`);
    // and each derivative matches a Richardson-extrapolated difference with steps of a few percent of the drop
    const dp = pa - pb, rich = (f, x, h) => (4 * numDeriv(f, x, h / 2) - numDeriv(f, x, h)) / 3;
    const nda = rich((x) => F.edgeFlow(e, x, pb, H2O), pa, 0.04 * dp), ndb = rich((x) => F.edgeFlow(e, pa, x, H2O), pb, 0.04 * dp);
    assert.ok(rel(da, nda) < 1e-6 && rel(db, ndb) < 1e-6, `${da} vs ${nda}, ${db} vs ${ndb}`);
    // the linear branch (entrance and contraction, near-free-molecular and Sampson branches of g): each derivative and
    // the uniform-shift derivative da pa + db pb (what moves a stiff line as a whole) against Richardson differences
    for (const [edge, pA] of [[entrance(0.01), 0.3], [entrance(0.01), 300], [contraction(0.01, 0.03), 0.3], [contraction(0.01, 0.03), 300]]) {
        const pB = pA * (1 - 1e-3), h = 2e-2 * (pA - pB);
        assert.equal(F.edgeLimit(edge, pA, pB, N2), 'none');
        const [, a2, b2] = F.edgeDerivs(edge, pA, pB, N2);
        const na = rich((x) => F.edgeFlow(edge, x, pB, N2), pA, h), nb = rich((x) => F.edgeFlow(edge, pA, x, N2), pB, h);
        assert.ok(rel(a2, na) < 1e-7 && rel(b2, nb) < 1e-7, `${edge.Afrom} at ${pA}: ${a2} vs ${na}, ${b2} vs ${nb}`);
        const shift = (s) => F.edgeFlow(edge, pA * s, pB * s, N2), ns = rich(shift, 1, 1e-2);
        assert.ok(Math.abs(a2 * pA + b2 * pB - ns) <= 1e-6 * a2 * pA, `${edge.Afrom} at ${pA}: shift ${a2 * pA + b2 * pB} vs ${ns}`);
    }
});

test('coreChokeP solves kv (pa^2 - pc^2)/2 = pc A_out sqrt(Rs T) to 1e-12', () => {
    for (const item of [{ t: 'tube', d: 0.02, L: 0.5 }, { t: 'slit', h: 0.0001, w: 0.05, L: 0.01 }, { t: 'cone', d1: 0.1, d2: 0.02, L: 0.3 }]) {
        const e = coreEdge(item, AIR), w = e.Aout * Math.sqrt(AIR.Rs * AIR.T), kv = e.kv;
        for (const pa of [1e-6, 1, 100, 1e4, 1e5, 1e7]) {
            const pc = F.coreChokeP(e, pa, AIR);
            assert.ok(pc > 0 && pc < pa);
            // independent root through u = pa - pc: (kv/2) u^2 - (kv pa + w) u + pa w = 0, smaller root, stable form
            const B = kv * pa + w, u = 2 * pa * w / (B + Math.sqrt(B * B - 2 * kv * pa * w));
            const ref = u < 0.5 * pa ? pa - u : kv * pa * pa / (Math.sqrt(w * w + kv * kv * pa * pa) + w);
            assert.ok(Math.abs(pc / ref - 1) <= 1e-12, `${item.t} root at ${pa}: ${pc} vs ${ref}`);
            // residual of the quadratic, factorized, where the root is well conditioned
            if (pa - pc > 1e-3 * pa) {
                const lhs = kv * (pa - pc) * (pa + pc) / 2, rhs = pc * w;
                assert.ok(Math.abs(lhs - rhs) <= 1e-12 * Math.max(lhs, rhs), `${item.t} residual at ${pa}`);
            }
        }
    }
});

test('edgeLimit reports choking and inertia only where the isentropic or exit limits bind', () => {
    const o = entrance(0.01);
    assert.equal(F.edgeLimit(o, 1e5, 10, N2), 'choked');
    assert.equal(F.edgeLimit(o, 1e5, 8e4, N2), 'inertial');
    assert.equal(F.edgeLimit(o, 1e-2, 1e-5, N2), 'none');
    assert.equal(F.edgeLimit(o, 10, 1e5, N2), 'choked');
    assert.equal(F.edgeLimit(o, 5, 5, N2), 'none');
    const c = coreEdge({ t: 'slit', h: 0.0001, w: 0.05, L: 0.01 }, AIR);
    assert.equal(F.edgeLimit(c, 1e5, 1e3, AIR), 'choked-exit');
    assert.equal(F.edgeLimit(c, 1e5, 9e4, AIR), 'none');
    assert.equal(F.edgeLimit(c, 1e-3, 1e-6, AIR), 'none');
});

test('edgeG is the small-signal limit of edgeFlow; pumpSc follows spec 3.5.4', () => {
    // where the isentropic cap cannot bind at a 2e-7 pressure difference, the difference quotient converges to edgeG
    for (const [e, ps] of [[coreEdge({ t: 'tube', d: 0.02, L: 0.5 }, N2), [1e-9, 0.1, 30, 1e5]], [entrance(0.01), [1e-9, 0.1, 30]], [contraction(0.01, 0.03), [1e-9, 0.1, 30]]]) {
        for (const p of ps) {
            const q = F.edgeFlow(e, p * (1 + 1e-7), p * (1 - 1e-7), N2) / (2e-7 * p);
            assert.ok(rel(F.edgeG(e, p, N2), q) < 1e-6, `${e.k} at ${p}`);
        }
    }
    // orifice edges: 1/R_lin with g(delta, 1) at any pressure (spec 3.5.7), also where the cap binds at finite dp
    for (const p of [1e-6, 1e3, 1e5, 1e7]) {
        const o = contraction(0.01, 0.03), k = p / (N2.eta * N2.vm);
        const R = 4 / (N2.vbar * o.Ato * F.gOrifice(o.reTo * k, 1)) - 4 / (N2.vbar * o.Afrom * F.gOrifice(o.reFrom * k, 1));
        assert.ok(rel(F.edgeG(o, p, N2), 1 / R) < 1e-13, `contraction at ${p}`);
    }
    const core = coreEdge({ t: 'tube', d: 0.02, L: 0.5 }, N2);
    assert.ok(rel(F.edgeG(core, 7, N2), core.kv * 7 + core.Cm * F.Z(7 / core.s)) < 1e-15);
    const A = Math.PI * 0.05 * 0.05 / 4;
    const detached = { S: 0.1, A, re: 0.025, attached: false }, attached = { ...detached, attached: true };
    for (const p of [1e-12, 1, 1e5]) assert.equal(F.pumpSc(detached, p, N2), 0.1);
    assert.ok(rel(F.pumpSc(attached, 1e-12, N2), 1 / (1 / 0.1 - 4 / (A * N2.vbar))) < 1e-9);
    assert.ok(rel(F.pumpSc(attached, 1e6, N2), 0.1) < 1e-3, 'S_c tends to S in viscous flow');
});

test('long-tube core reproduces Sharipov G_P to 8e-5 for delta = 0.01 to 200 (spec 3.3.2; 7.9e-5 at 0.01 with the v2.1 Berman closed form, a finite-length effect of L = 1e5 a)', () => {
    const a = 1e-3, L = 1e5 * a, core = coreEdge({ t: 'tube', d: 2 * a, L }, AIR), s = AIR.eta * AIR.vm / a;
    for (const d of [0.01, 0.1, 1, 10, 50, 200]) {
        const C = F.edgeG(core, d * s, AIR), Csh = Math.PI * a ** 3 * AIR.vm / (2 * L) * F.GP(d);
        assert.ok(rel(C, Csh) < 8e-5, `delta ${d}: ${C / Csh}`);
    }
});

test('viscous end corrections: short tube to 0.002 % of L + 3 pi R/8, long tube L/R = 200 gives 0.99420 (spec 3.3.3)', () => {
    const model = (d, L) => ({ items: [{ t: 'tube', d, L }], gas: { id: 'air', T: 293.15, custom: null }, Cd: null, bc: { mode: 'dp', p0: 1e5, p1: 5e4 } });
    const C = (d, L) => sweep(model(d, L), 'C', { n: 1, pMin: 1e5, pMax: 1e5 }).y[0];
    const R = 0.005, pm = 1e5, eta = AIR.eta;
    const short = C(2 * R, R), shortRef = Math.PI * R ** 4 * pm / (8 * eta * (R + 3 * Math.PI * R / 8));
    assert.ok(rel(short, shortRef) < 3e-5, `short tube ${short / shortRef - 1}`);
    const long = C(0.01, 1) / (Math.PI * 0.01 ** 4 * pm / (128 * eta * 1));
    assert.ok(Math.abs(long - 0.99420) < 5e-6, `long tube ratio ${long}`);
});

test('continuum orifice into vacuum gives Liepmann-like W: N2 1.4143, Ar 1.4781, CO2 1.3845 (spec 3.3.3)', () => {
    for (const [id, W] of [['N2', 1.4143], ['Ar', 1.4781], ['CO2', 1.3845]]) {
        const G = gasState(id, 293.15), a = 1e-3;
        const r = analyze({ items: [{ t: 'orifice', shape: 'circle', d: 2 * a }], gas: { id, T: 293.15, custom: null }, Cd: null, bc: { mode: 'dp', p0: 1e5, p1: 1 } });
        assert.ok(r.ok);
        assert.ok(Math.abs(r.Q / (Math.PI * a * a * G.vbar / 4 * 1e5) - W) < 5e-5, id);
        assert.equal(r.elements[0].limit, 'choked');
    }
});

// ---- v2.2 fix round 1: plane-channel cap of slot-like cores; exit choke only where the viscous term matters
test('channelF follows Sharipov Table 3 at its nodes and joins its limits continuously', () => {
    for (const [d, g] of [[0.01, 3.0489], [0.1, 2.0314], [1, 1.5389], [2, 1.5942], [10, 2.7638]]) assert.ok(rel(F.channelF(d), g - d / 6) < 1e-12, `delta ${d}`);
    assert.ok(rel(F.channelF(0.01 * (1 - 1e-9)), F.channelF(0.01)) < 1e-8 && rel(F.channelF(10 * (1 + 1e-9)), F.channelF(10)) < 1e-8);
    assert.ok(rel(F.channelF(1e6), 1.016) < 1e-6, 'slip limit');
    assert.ok(F.channelF(1e-6) > F.channelF(1e-3) && F.channelF(1e-3) > F.channelF(0.01), 'free-molecular logarithm');
});

test('cappedZ: Z is the smaller branch, IZ integrates it (also across the crossings), and slot cores use it', () => {
    const z = F.cappedZ(0.25, 1.1);
    for (const t of [1e-14, 1e-6, 0.03, 0.4, 1, 3, 30, 1e3, 1e10]) {
        const want = t <= 1e-12 ? Math.min(F.Z(1e-12), 0.25 * F.channelF(1.1e-12)) : t >= 1e9 ? Math.min(F.Z(1e9), 0.25 * F.channelF(1.1e9)) : Math.min(F.Z(t), 0.25 * F.channelF(1.1 * t));
        assert.ok(rel(z.Z(t), want) < 1e-12, `Z(${t})`);
    }
    for (const t of [1e-5, 0.02, 0.37, 0.9, 2.2, 7, 60, 4e4]) {
        const h = t * 1e-5, d = (z.IZ(t + h) - z.IZ(t - h)) / (2 * h);
        assert.ok(rel(d, z.Z(t)) < 2e-6, `dIZ/dt at ${t}: ${d} vs ${z.Z(t)}`);
    }
    // IZ against fine trapezoid integration in ln t from 1e-12
    let acc = z.IZ(1e-12), u0 = Math.log(1e-12);
    const n = 200000, u1 = Math.log(50);
    for (let k = 0; k < n; k++) {
        const a = u0 + (u1 - u0) * k / n, b = u0 + (u1 - u0) * (k + 1) / n;
        acc += 0.5 * (z.Z(Math.exp(a)) * Math.exp(a) + z.Z(Math.exp(b)) * Math.exp(b)) * (b - a);
    }
    assert.ok(rel(z.IZ(50), acc) < 1e-6, `IZ(50) ${z.IZ(50)} vs ${acc}`);
    assert.equal(F.cappedZ(0.25, 1.1), z, 'cached');
    // slits, ducts and annuli get the cap; tubes, cones, elbows and black boxes do not
    for (const it of [{ t: 'slit', h: 1e-4, w: 0.1, L: 0.1 }, { t: 'rect', a: 0.01, b: 0.03, L: 0.1 }, { t: 'annulus', di: 0.038, do: 0.04, L: 0.1 }]) assert.ok(compileItem(it, N2).zc, it.t);
    for (const it of [{ t: 'tube', d: 0.04, L: 0.2 }, { t: 'cone', d1: 0.04, d2: 0.063, L: 0.05 }, { t: 'elbow', d: 0.04, A: 0.05, B: 0.05 }]) assert.equal(compileItem(it, N2).zc, null, it.t);
});

test('a long wide slit follows the plane channel in transitional flow; molecular and viscous limits are unchanged', () => {
    const h = 1e-4, w = 0.1, L = 0.1, item = { t: 'slit', h, w, L };
    const m = (p) => ({ items: [item], gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'dp', p0: 2 * p, p1: p } });
    for (const [d, g] of [[0.1, 2.0314], [1, 1.5389], [10, 2.7638]]) {
        const p = d * N2.eta * N2.vm / h, y = sweep(m(p), 'C', { n: 1, pMin: p, pMax: p }).y[0];
        assert.ok(rel(y, w * h * h * N2.vm * g / (2 * L)) < 0.005, `delta ${d}: ${y}`);
    }
    const e = compileItem(item, N2), plain = { ...coreEdge(item, N2) }, capped = { ...plain, zc: e.zc };
    assert.ok(rel(F.edgeG(capped, 1e-9, N2), F.edgeG(plain, 1e-9, N2)) < 1e-6, 'molecular limit');
    assert.ok(rel(F.edgeG(capped, 1e6, N2), F.edgeG(plain, 1e6, N2)) < 0.01, 'viscous limit');
    assert.ok(F.edgeG(capped, 1 * N2.eta * N2.vm / h, N2) < 0.6 * F.edgeG(plain, 1 * N2.eta * N2.vm / h, N2), 'about half at delta = 1');
});

test('edgeLimit: no exit choke in molecular or near-molecular flow, even at a large pressure ratio', () => {
    const e = coreEdge({ t: 'tube', d: 0.01, L: 0.1 }, N2);
    assert.equal(F.edgeLimit(e, 1, 1e-3, N2), 'none');
    assert.equal(F.edgeLimit(e, 1e-4, 1e-9, N2), 'none');
    const s = coreEdge({ t: 'slit', h: 0.0001, w: 0.05, L: 0.01 }, AIR);
    assert.equal(F.edgeLimit(s, 1e5, 1e3, AIR), 'choked-exit');
});
