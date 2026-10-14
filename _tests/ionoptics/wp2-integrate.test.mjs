// WP2 integrators: DP45 tableau, local orders 5/4, dense output, RK4 order 4, Boris exact phase and |w|.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DP45, dp45Step, dp45Dense, rk4Step, borisPush, qualityPreset } from '../../beta/ion-optics/js/engine/integrate.js';
import { K_ACC, C_MMUS } from '../../beta/ion-optics/js/engine/constants.js';

// forced pendulum: y1' = y2, y2' = −sin(y1) + 0.3 cos t
const f = (t, y, d) => { d[0] = y[1]; d[1] = -Math.sin(y[0]) + 0.3 * Math.cos(t); };
const newK = () => Array.from({ length: 7 }, () => new Float64Array(2));

function dpOne(t, y0, h) {
    const k = newK(), y5 = new Float64Array(2), err = new Float64Array(2);
    f(t, y0, k[0]);
    dp45Step(f, t, y0, h, k, y5, err);
    return { k, y5, y4: Float64Array.from(y5, (v, i) => v - err[i]), err };
}
/** Reference solution by many small DP45 steps. */
function reference(y0, T, n = 4000) {
    let y = Float64Array.from(y0), t = 0;
    const hh = T / n;
    for (let i = 0; i < n; i++) { y = dpOne(t, y, hh).y5; t += hh; }
    return y;
}
const order = (e1, e2) => Math.log2(e1 / e2);

test('tableau: row sums equal c, weights sum to 1, dense weights sum to 0, e = b − b*', () => {
    for (let i = 1; i < 7; i++) assert.ok(Math.abs(DP45.a[i].reduce((s, v) => s + v, 0) - DP45.c[i]) < 1e-14, 'row ' + i);
    assert.ok(Math.abs(DP45.b.reduce((s, v) => s + v, 0) - 1) < 1e-15);
    assert.ok(Math.abs(DP45.bStar.reduce((s, v) => s + v, 0) - 1) < 1e-15);
    assert.ok(Math.abs(DP45.d.reduce((s, v) => s + v, 0)) < 1e-14);
    for (let i = 0; i < 7; i++) assert.ok(Math.abs(DP45.e[i] - (DP45.b[i] - DP45.bStar[i])) < 1e-16, 'e' + i);
    assert.deepEqual([...DP45.a[6]], [...DP45.b].slice(0, 6), 'FSAL: the last stage is the 5th-order solution');
});

test('DP45 local error orders 5 (solution) and 4 (embedded)', () => {
    const y0 = Float64Array.from([1, 0]);
    const e5 = [], e4 = [];
    for (const h of [0.2, 0.1, 0.05]) {
        const s = dpOne(0, y0, h), ex = reference(y0, h);
        e5.push(Math.hypot(s.y5[0] - ex[0], s.y5[1] - ex[1]));
        e4.push(Math.hypot(s.y4[0] - ex[0], s.y4[1] - ex[1]));
    }
    for (let i = 0; i < 2; i++) {
        const p5 = order(e5[i], e5[i + 1]), p4 = order(e4[i], e4[i + 1]);
        assert.ok(p5 > 5.5 && p5 < 6.5, 'local order of y5 (h^6 local error): ' + p5);
        assert.ok(p4 > 4.5 && p4 < 5.5, 'local order of y4 (h^5 local error): ' + p4);
    }
});

test('Hairer dense output: dense(0) = y0, dense(1) = step end, interior local error O(h^5)', () => {
    const y0 = Float64Array.from([1, 0]);
    const out = new Float64Array(2);
    const errs = [];
    for (const h of [0.4, 0.2, 0.1]) {
        const s = dpOne(0, y0, h);
        dp45Dense(1, y0, s.y5, s.k, h, out);
        for (let i = 0; i < 2; i++) assert.ok(Math.abs(out[i] - s.y5[i]) <= 1e-15 * Math.max(1, Math.abs(s.y5[i])), 'dense(1)');
        dp45Dense(0, y0, s.y5, s.k, h, out);
        assert.deepEqual([...out], [...y0]);
        let worst = 0;
        for (const th of [0.25, 0.5, 0.75]) {
            dp45Dense(th, y0, s.y5, s.k, h, out);
            const ex = reference(y0, th * h, 2000);
            worst = Math.max(worst, Math.hypot(out[0] - ex[0], out[1] - ex[1]));
        }
        errs.push(worst);
    }
    for (let i = 0; i < 2; i++) {
        const p = order(errs[i], errs[i + 1]);
        assert.ok(p > 4.5 && p < 6.0, 'dense local order ' + p);
    }
    // a quintic polynomial solution is reproduced by the step; the dense output is exact for quartics
    const g = (t, y, d) => { d[0] = 4 * t ** 3; };
    const k = Array.from({ length: 7 }, () => new Float64Array(1)), y1 = new Float64Array(1), e = new Float64Array(1);
    g(0, [0], k[0]); dp45Step(g, 0, Float64Array.from([0]), 1, k, y1, e);
    assert.ok(Math.abs(y1[0] - 1) < 1e-14);
    const o1 = new Float64Array(1);
    dp45Dense(0.3, Float64Array.from([0]), y1, k, 1, o1);
    assert.ok(Math.abs(o1[0] - 0.3 ** 4) < 1e-14, 'quartic dense ' + o1[0]);
});

test('RK4: global order 4', () => {
    const y0 = Float64Array.from([1, 0]), T = 2;
    const ex = reference(y0, T, 8000);
    const errs = [];
    for (const n of [20, 40, 80]) {
        let y = Float64Array.from(y0), t = 0;
        const h = T / n, k = Array.from({ length: 4 }, () => new Float64Array(2)), yn = new Float64Array(2);
        for (let i = 0; i < n; i++) { rk4Step(f, t, y, h, k, yn); y = Float64Array.from(yn); t += h; }
        errs.push(Math.hypot(y[0] - ex[0], y[1] - ex[1]));
    }
    for (let i = 0; i < 2; i++) { const p = order(errs[i], errs[i + 1]); assert.ok(p > 3.7 && p < 4.3, 'RK4 order ' + p); }
});

test('Boris: exact gyration phase and |w| per step (1e-14), signed rotation, relativistic', () => {
    for (const [q, m, B, w0, rel] of [[1, 100, 0.5, 43.9, false], [-1, 5.48579909e-4, 1e-3, 5930, false], [-1, 5.48579909e-4, 0.1, 2e5, true], [2, 4, 1.3, 120, true]]) {
        const st = { x: Float64Array.from([0, 0, 0]), w: Float64Array.from([w0, 0, 0]) };
        const gam = rel ? Math.sqrt(1 + w0 * w0 / (C_MMUS * C_MMUS)) : 1;
        const omega = K_ACC * q / m * B / gam;   // signed, about +z
        const dt = 0.07 / Math.abs(omega);
        let ang = 0;
        for (let i = 0; i < 50; i++) {
            const a0 = Math.atan2(st.w[1], st.w[0]);
            borisPush(st, dt, [0, 0, 0], [0, 0, B], q / m, rel);
            const a1 = Math.atan2(st.w[1], st.w[0]);
            let d = a1 - a0; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
            // dw/dt = w × Ω: a positive ion in +z turns clockwise (negative angle)
            assert.ok(Math.abs(d + omega * dt) <= 1e-14 * Math.max(1, Math.abs(omega * dt)) + 1e-15, `phase per step ${d} vs ${-omega * dt}`);
            assert.ok(Math.abs(Math.hypot(st.w[0], st.w[1], st.w[2]) / w0 - 1) <= 1e-14, '|w| conserved');
            ang += d;
        }
        assert.ok(Math.abs(ang + 50 * omega * dt) < 1e-12 * Math.max(1, Math.abs(50 * omega * dt)));
    }
});

test('Boris identity: step positions on a circle of radius r·(θ/2)/sin(θ/2) (1e-9)', () => {
    const q = 1, m = 100, B = 0.5, v = 43.92842633690628;
    const om = K_ACC * q / m * B, r = v / om, T = 2 * Math.PI / om;
    const dt = T / 128, th = om * dt;
    const R = r * (th / 2) / Math.sin(th / 2);
    // start synchronised at the origin along +x; the leapfrog velocity is half a (clockwise) rotation back
    const st = { x: Float64Array.from([0, 0, 0]), w: Float64Array.from([v * Math.cos(0.5 * th), v * Math.sin(0.5 * th), 0]) };
    let worst = 0;
    for (let i = 0; i < 1280; i++) {
        borisPush(st, dt, [0, 0, 0], [0, 0, B], q / m, false);
        worst = Math.max(worst, Math.abs(Math.hypot(st.x[0], st.x[1] + R) / R - 1));
    }
    assert.ok(worst < 1e-9, 'identity deviation ' + worst);
    assert.ok(Math.abs(R / r - 1 - 1.0041e-4) < 2e-7, 'discrete circle is 1.0e-4 larger at 128 steps');
});

test('Boris in a pure E field: exact kick and leapfrog drift', () => {
    const st = { x: Float64Array.from([1, 2, 3]), w: Float64Array.from([0.5, 0, 0]) };
    borisPush(st, 0.1, [10, -4, 0], [0, 0, 0], 2 / 50, false);
    const k = K_ACC * 2 / 50;
    assert.ok(Math.abs(st.w[0] - (0.5 + k * 10 * 0.1)) < 1e-14);
    assert.ok(Math.abs(st.w[1] - (-k * 4 * 0.1)) < 1e-14);
    assert.ok(Math.abs(st.x[0] - (1 + 0.1 * st.w[0])) < 1e-14);
});

test('trajectory-accuracy presets (§3.8)', () => {
    assert.deepEqual(qualityPreset('draft'), { rtol: 1e-6, maxStepCells: 1.0, nearStepCells: 0.25, rfStepsPerPeriod: 24, borisStepsPerGyration: 64 });
    assert.deepEqual(qualityPreset('normal'), { rtol: 1e-8, maxStepCells: 0.5, nearStepCells: 0.1, rfStepsPerPeriod: 32, borisStepsPerGyration: 128 });
    assert.deepEqual(qualityPreset('fine'), { rtol: 1e-10, maxStepCells: 0.25, nearStepCells: 0.05, rfStepsPerPeriod: 64, borisStepsPerGyration: 256 });
    assert.deepEqual(qualityPreset('nonsense'), qualityPreset('normal'));
    const a = qualityPreset('fine'); a.rtol = 1; assert.equal(qualityPreset('fine').rtol, 1e-10, 'returns a copy');
});

test('auto integrator in crossed E and B follows the E×B drift (cycloid) to 1e-6; Boris is kept for pure magnetic fields', async () => {
    const { newProject } = await import('../../beta/ion-optics/js/engine/schema.js');
    const { runProject } = await import('../../beta/ion-optics/js/engine/pipeline.js');
    const L = await import('../../beta/ion-optics/js/engine/layout.js');
    const build = (withE) => {
        const p = newProject('planar2d');
        p.domain = { type: 'planar2d', cell: 5, x: [-50, 400], y: [-50, 50], edges: { xmin: { bc: 'neumann' }, xmax: { bc: 'neumann' }, ymin: { bc: 'neumann' }, ymax: { bc: 'neumann' } },
            mirror: { x: false, y: false }, beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' } };
        p.electrodes = [{ id: 'gnd', name: 'Ground', ground: true, color: '#64748b' }];
        p.shapes = [];
        p.idealFields = withE ? [{ id: 'f1', enabled: true, type: 'uniformE', E: [0, 1, 0], ref: [0, 0, 0], box: null }] : [];
        p.magnets = [{ id: 'm1', name: 'B', enabled: true, type: 'uniform', B: [0, 0, 1] }];
        const T = 2 * Math.PI / K_ACC;   // 1 u, +1 e, 1 T
        p.tracer = { ...p.tracer, integrator: 'auto', quality: 'normal', relativistic: false, tMax: 200.25 * T };
        p.recording = { planes: [], trajectories: { store: false, maxPoints: 2000 }, timeMarkers: null };
        p.sources = [{ id: 'b1', name: 'b', enabled: true, color: 'auto', count: 1, sampling: 'grid', seed: 1, species: [{ label: 'p', mass: 1, charge: 1, fraction: 1 }],
            position: { type: 'point', p: [0, 0, 0] }, direction: { type: 'fixed', dir: [1, 0, 0] }, energy: { type: withE ? 'mono' : 'mono', ke: withE ? 0 : 1 }, time: { type: 'fixed', t: 0 } }];
        return p;
    };
    const r = runProject(build(true));
    const s = r.result.summary, w = K_ACC, t = s[L.S_T];
    // from rest in E = 1 V/mm ŷ, B = 1 T ẑ: x = v_d (t − sin ωt/ω), v_d = E/B = 1 mm/µs
    const xe = t - Math.sin(w * t) / w;
    assert.ok(Math.abs(s[L.S_X] / xe - 1) < 1e-6, `drift x ${s[L.S_X]} vs ${xe}`);
    assert.equal(s[L.S_FLAGS] & L.FLAG.BORIS, 0, 'crossed fields keep DP45');
    const rb = runProject(build(false));
    assert.ok((rb.result.summary[L.S_FLAGS] & L.FLAG.BORIS) !== 0, 'pure magnetic field: auto picks Boris');
});
