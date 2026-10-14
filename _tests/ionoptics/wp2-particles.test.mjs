// WP2 particle sources: species, counts, grid classes, batch invariance, random-distribution moments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPECIES, countParticles, generate } from '../../beta/ion-optics/js/engine/particles.js';
import * as L from '../../beta/ion-optics/js/engine/layout.js';
import { ME_U, properSpeedFromKE, speedFromKE } from '../../beta/ion-optics/js/engine/constants.js';

const DEG = Math.PI / 180;
const relEq = (a, b, rel, msg = '') => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg} ${a} vs ${b}`);

function src(over) {
    return {
        id: 's', enabled: true, count: 10, sampling: 'random', seed: 1,
        species: [{ label: 'm100', mass: 100, charge: 1, fraction: 1 }],
        position: { type: 'point', p: [0, 0, 0] }, direction: { type: 'fixed', dir: [1, 0, 0] },
        energy: { type: 'mono', ke: 100 }, time: { type: 'fixed', t: 0 }, ...over,
    };
}
const rows = (P) => Array.from({ length: P.length / L.P_STRIDE }, (_, i) => P.subarray(i * L.P_STRIDE, (i + 1) * L.P_STRIDE));
function moments(values) {
    let s = 0, s2 = 0;
    for (const v of values) { s += v; s2 += v * v; }
    const n = values.length, m = s / n;
    return { n, mean: m, var: s2 / n - m * m };
}
/** mean within 3σ/√n of the expected mean, given the expected standard deviation. */
function meanOk(values, mu, sigma, msg) {
    const { n, mean } = moments(values);
    assert.ok(Math.abs(mean - mu) <= 3 * sigma / Math.sqrt(n) + 1e-15, `${msg}: mean ${mean} vs ${mu} (3σ/√n = ${3 * sigma / Math.sqrt(n)})`);
}

test('species table: AME2020 atomic mass − electron mass; e⁻ and H⁺', () => {
    const by = Object.fromEntries(SPECIES.map((s) => [s.id, s]));
    assert.equal(by['e-'].mass, ME_U); assert.equal(by['e-'].charge, -1);
    assert.equal(by['H+'].mass, 1.0072764665789);
    relEq(by['He+'].mass, 4.00260325413 - ME_U, 1e-15);
    relEq(by['Ar+'].mass, 39.9623831237 - ME_U, 1e-15);
    relEq(by['N2+'].mass, 2 * 14.00307400425 - ME_U, 1e-15);
    relEq(by['C60+'].mass, 720 - ME_U, 1e-15);
    for (const s of SPECIES) if (s.id !== 'e-') assert.equal(s.charge, 1);
    assert.deepEqual(SPECIES.map((s) => s.id), ['e-', 'H+', 'He+', 'C+', 'N+', 'O+', 'N2+', 'O2+', 'Ar+', 'Kr+', 'Xe+', 'C60+']);
});

test('counts: random = count; grid = species × positions × directions × energies × times; disabled = 0', () => {
    const g = src({
        sampling: 'grid', species: [{ mass: 100, charge: 1 }, { mass: 101, charge: 1 }],
        position: { type: 'line', p0: [0, -1, 0], p1: [0, 1, 0], n: 3 },
        direction: { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: -10, to: 20, n: 4 },
        energy: { type: 'uniform', min: 10, max: 20, n: 2 }, time: { type: 'list', values: [0, 0.5] },
    });
    assert.equal(countParticles([g]), 2 * 3 * 4 * 2 * 2);
    assert.equal(countParticles([src({ count: 17 }), g, src({ enabled: false, count: 5 })]), 17 + 96);
    const rect = src({ sampling: 'grid', position: { type: 'rect', center: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], halfU: 1, halfV: 2, n: [3, 5] } });
    assert.equal(countParticles([rect]), 15);
});

test('grid sampling: class indices, inclusive end points, species slowest', () => {
    const g = src({
        sampling: 'grid', species: [{ mass: 100, charge: 1 }, { mass: 101, charge: 1 }],
        position: { type: 'line', p0: [0, -1, 0], p1: [0, 1, 0], n: 3 },
        direction: { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: -10, to: 20, n: 4 },
        energy: { type: 'uniform', min: 10, max: 20, n: 2 }, time: { type: 'list', values: [0, 0.5] },
    });
    const P = rows(generate([g], 0, 96, { relativistic: false }));
    let k = 0;
    for (let s = 0; s < 2; s++) for (let ip = 0; ip < 3; ip++) for (let id = 0; id < 4; id++) for (let ie = 0; ie < 2; ie++) for (let it = 0; it < 2; it++, k++) {
        const r = P[k];
        assert.equal(r[L.P_ID], k); assert.equal(r[L.P_SPECIES], s); assert.equal(r[L.P_MASS], 100 + s);
        assert.equal(r[L.P_C0], ip); assert.equal(r[L.P_C1], id); assert.equal(r[L.P_C2], ie);
        relEq(r[L.P_Y] + 2, -1 + ip + 2, 1e-15, 'line points include the ends');
        const ang = Math.atan2(r[L.P_WY], r[L.P_WX]) / DEG;
        assert.ok(Math.abs(ang - (-10 + 10 * id)) < 1e-12, 'fan angles inclusive ' + ang);
        assert.equal(r[L.P_KE], 10 + 10 * ie);
        assert.equal(r[L.P_T0], 0.5 * it);
        relEq(Math.hypot(r[L.P_WX], r[L.P_WY], r[L.P_WZ]), speedFromKE(r[L.P_KE], r[L.P_MASS], false), 1e-14, '|w|');
    }
    // rfPhase grid: k/(n f); disc grid: Vogel spiral inside R; cone grid: Fibonacci cap within the half angle
    const t = rows(generate([src({ sampling: 'grid', time: { type: 'rfPhase', freq: 2, n: 4 } })], 0, 4, {}));
    assert.deepEqual(t.map((r) => r[L.P_T0]), [0, 0.125, 0.25, 0.375]);
    const d = rows(generate([src({ sampling: 'grid', position: { type: 'disc', center: [1, 0, 0], normal: [1, 0, 0], radius: 2, n: 50 } })], 0, 50, {}));
    for (const r of d) { assert.equal(r[L.P_X], 1); assert.ok(Math.hypot(r[L.P_Y], r[L.P_Z]) <= 2); }
    const c = rows(generate([src({ sampling: 'grid', direction: { type: 'cone', axis: [0, 0, 1], halfAngle: 15, n: 40 } })], 0, 40, {}));
    for (const r of c) assert.ok(r[L.P_WZ] / Math.hypot(r[L.P_WX], r[L.P_WY], r[L.P_WZ]) >= Math.cos(15 * DEG) - 1e-12);
    // random sampling stores −1 class indices
    const rr = rows(generate([src({})], 0, 3, {}));
    for (const r of rr) { assert.equal(r[L.P_C0], -1); assert.equal(r[L.P_C1], -1); assert.equal(r[L.P_C2], -1); }
});

test('batch invariance: identical rows for batch sizes 1, 7, 64', () => {
    const sources = [
        src({ count: 150, seed: 7, species: [{ mass: 90, charge: 1, fraction: 1 }, { mass: 100, charge: 1, fraction: 2 }, { mass: 110, charge: 2, fraction: 1 }],
            position: { type: 'gaussian', center: [1, 2, 3], sigma: [0.1, 0.2, 0.3] }, direction: { type: 'isotropic', axis: [0, 1, 0], beta: 1.5 },
            energy: { type: 'gaussian', mean: 5, fwhm: 2 }, time: { type: 'rfPhase', freq: 1.1 } }),
        src({ id: 'g', sampling: 'grid', position: { type: 'line', p0: [0, 0, 0], p1: [0, 1, 0], n: 5 }, direction: { type: 'cone', axis: [1, 1, 0], halfAngle: 10, fill: 'lambert', n: 7 },
            energy: { type: 'list', values: [1, 2, 3] } }),
        src({ id: 'r', count: 77, seed: 3, position: { type: 'disc', center: [0, 0, 0], normal: [0, 0, 1], radius: 2 }, direction: { type: 'fan', axis: [0, 1, 0], normal: [0, 0, 1], from: -30, to: 30 },
            energy: { type: 'uniform', min: 1, max: 3 }, time: { type: 'uniform', t0: 0, t1: 2 } }),
    ];
    const N = countParticles(sources);
    assert.equal(N, 150 + 105 + 77);
    const all = generate(sources, 0, N, { relativistic: true });
    for (const B of [1, 7, 64]) {
        const parts = [];
        for (let i0 = 0; i0 < N; i0 += B) parts.push(generate(sources, i0, Math.min(N, i0 + B), { relativistic: true }));
        const cat = new Float64Array(N * L.P_STRIDE);
        let o = 0;
        for (const p of parts) { cat.set(p, o); o += p.length; }
        assert.deepEqual(cat, all, 'batch size ' + B);
    }
    // a range in the middle equals the corresponding slice; firstId offsets are honoured
    assert.deepEqual(generate(sources, 140, 160, { relativistic: true }), all.subarray(140 * L.P_STRIDE, 160 * L.P_STRIDE));
    const shifted = sources.map((s, i) => ({ ...s, index: i, firstId: [0, 150, 255][i] + 1000 }));
    const sh = generate(shifted, 1000, 1000 + N, { relativistic: true });
    for (let i = 0; i < N; i++) {
        for (let c = 1; c < L.P_STRIDE; c++) assert.equal(sh[i * L.P_STRIDE + c], all[i * L.P_STRIDE + c]);
        assert.equal(sh[i * L.P_STRIDE + L.P_ID], all[i * L.P_STRIDE + L.P_ID] + 1000);
    }
});

test('species apportioned by largest remainder and interleaved', () => {
    const sp = [{ mass: 1, charge: 1, fraction: 1 }, { mass: 2, charge: 1, fraction: 2 }, { mass: 3, charge: 1, fraction: 7 }];
    const count = (N) => { const c = [0, 0, 0]; for (const r of rows(generate([src({ count: N, species: sp })], 0, N, {}))) c[r[L.P_SPECIES]]++; return c; };
    assert.deepEqual(count(10), [1, 2, 7]);
    assert.deepEqual(count(11), [1, 2, 8]);
    assert.deepEqual(count(1000), [100, 200, 700]);
    // any prefix holds the species in proportion (live previews use the first n particles)
    const P = rows(generate([src({ count: 1000, species: sp })], 0, 100, {}));
    const c = [0, 0, 0]; for (const r of P) c[r[L.P_SPECIES]]++;
    assert.ok(Math.abs(c[0] - 10) <= 2 && Math.abs(c[1] - 20) <= 2 && Math.abs(c[2] - 70) <= 2, 'prefix ' + c);
    for (const r of P) assert.equal(r[L.P_MASS], r[L.P_SPECIES] + 1);
});

test('random positions: moments within 3σ/√n', () => {
    const n = 20000;
    const get = (pos, i0 = 0) => rows(generate([src({ count: n, seed: 5, position: pos })], i0, n, {}));
    const line = get({ type: 'line', p0: [0, -2, 1], p1: [4, 2, 1] });
    meanOk(line.map((r) => r[L.P_X]), 2, 4 / Math.sqrt(12), 'line x');
    meanOk(line.map((r) => (r[L.P_X] - 2) ** 2), 16 / 12, Math.sqrt(4 ** 4 / 80 - (16 / 12) ** 2), 'line var');
    for (const r of line) { relEq(r[L.P_Y], r[L.P_X] - 2, 1e-12, 'on the line'); assert.equal(r[L.P_Z], 1); }
    const disc = get({ type: 'disc', center: [0, 0, 5], normal: [0, 0, 1], radius: 3 });
    meanOk(disc.map((r) => r[L.P_X] ** 2 + r[L.P_Y] ** 2), 4.5, 9 / Math.sqrt(12), 'disc r²');
    meanOk(disc.map((r) => r[L.P_X]), 0, 3 / 2, 'disc x');
    for (const r of disc) { assert.equal(r[L.P_Z], 5); assert.ok(r[L.P_X] ** 2 + r[L.P_Y] ** 2 <= 9 + 1e-12); }
    const rect = get({ type: 'rect', center: [1, 1, 1], u: [0, 1, 0], v: [0, 0, 1], halfU: 2, halfV: 0.5 });
    meanOk(rect.map((r) => (r[L.P_Y] - 1) ** 2), 4 / 3, Math.sqrt(16 / 5 - 16 / 9), 'rect u²');
    meanOk(rect.map((r) => (r[L.P_Z] - 1) ** 2), 0.25 / 3, Math.sqrt(0.0625 / 5 - 0.0625 / 9), 'rect v²');
    const gauss = get({ type: 'gaussian', center: [0, 0, 0], sigma: [0.5, 0, 2] });
    // ±4σ truncation: variance factor 1 − 8φ(4)/erf(4/√2)
    const phi4 = Math.exp(-8) / Math.sqrt(2 * Math.PI), vf = 1 - 8 * phi4 / 0.9999366575163338;
    meanOk(gauss.map((r) => r[L.P_X] ** 2), 0.25 * vf, 0.25 * Math.sqrt(2), 'gaussian x²');
    meanOk(gauss.map((r) => r[L.P_Z] ** 2), 4 * vf, 4 * Math.sqrt(2), 'gaussian z²');
    for (const r of gauss) { assert.equal(r[L.P_Y], 0); assert.ok(Math.abs(r[L.P_X]) <= 2 && Math.abs(r[L.P_Z]) <= 8); }
});

test('random directions: moments within 3σ/√n; unit vectors; rotated onto the axis', () => {
    const n = 20000;
    const get = (dir) => rows(generate([src({ count: n, seed: 9, direction: dir })], 0, n, {})).map((r) => {
        const w = Math.hypot(r[L.P_WX], r[L.P_WY], r[L.P_WZ]);
        relEq(w, speedFromKE(100, 100, true) / Math.sqrt(1 - (speedFromKE(100, 100, true) / 299792.458) ** 2), 1e-12, '|w|');
        return [r[L.P_WX] / w, r[L.P_WY] / w, r[L.P_WZ] / w];
    });
    const a = 20 * DEG, ca = Math.cos(a);
    const solid = get({ type: 'cone', axis: [0, 1, 0], halfAngle: 20, fill: 'solid' });
    meanOk(solid.map((d) => d[1]), (1 + ca) / 2, (1 - ca) / Math.sqrt(12), 'cone solid cosθ');
    meanOk(solid.map((d) => d[0]), 0, Math.sin(a), 'cone solid x');
    const ang = get({ type: 'cone', axis: [0, 0, -1], halfAngle: 20, fill: 'angle' });
    meanOk(ang.map((d) => Math.acos(Math.min(1, -d[2]))), a / 2, a / Math.sqrt(12), 'cone angle θ');
    const lam = get({ type: 'cone', axis: [1, 0, 0], halfAngle: 20, fill: 'lambert' });
    const s2 = Math.sin(a) ** 2;
    meanOk(lam.map((d) => 1 - d[0] * d[0]), s2 / 2, s2 / Math.sqrt(12), 'lambert sin²θ');
    for (const beta of [0, 1.5, -0.8]) {
        const iso = get({ type: 'isotropic', axis: [0, 0, 1], beta });
        meanOk(iso.map((d) => 0.5 * (3 * d[2] * d[2] - 1)), beta / 5, 0.5, 'isotropic P2 β=' + beta);
        meanOk(iso.map((d) => d[2]), 0, 1 / Math.sqrt(3), 'isotropic cosθ β=' + beta);
    }
    const fan = get({ type: 'fan', axis: [0, 1, 0], normal: [0, 0, 1], from: -30, to: 50 });
    meanOk(fan.map((d) => Math.atan2(-d[0], d[1]) / DEG), 10, 80 / Math.sqrt(12), 'fan angle');
    for (const d of fan) assert.ok(Math.abs(d[2]) < 1e-15, 'fan stays in its plane');
    const fixed = get({ type: 'fixed', dir: [3, 4, 0] });
    assert.deepEqual(fixed[0].map((v) => +v.toFixed(15)), [0.6, 0.8, 0]);
});

test('random energies and times: moments within 3σ/√n', () => {
    const n = 20000;
    const get = (over) => rows(generate([src({ count: n, seed: 2, ...over })], 0, n, { relativistic: false }));
    const eu = get({ energy: { type: 'uniform', min: 2, max: 6 } });
    meanOk(eu.map((r) => r[L.P_KE]), 4, 4 / Math.sqrt(12), 'uniform KE');
    for (const r of eu) relEq(Math.hypot(r[L.P_WX], r[L.P_WY], r[L.P_WZ]), speedFromKE(r[L.P_KE], 100, false), 1e-14, 'nonrel |w|');
    const eg = get({ energy: { type: 'gaussian', mean: 10, fwhm: 2.354820045 } });
    meanOk(eg.map((r) => r[L.P_KE]), 10, 1, 'gaussian KE mean');
    meanOk(eg.map((r) => (r[L.P_KE] - 10) ** 2), 0.99893, Math.sqrt(2), 'gaussian KE variance');
    for (const r of eg) assert.ok(r[L.P_KE] > 0 && Math.abs(r[L.P_KE] - 10) <= 4 + 1e-9);
    const tu = get({ time: { type: 'uniform', t0: -1, t1: 3 } });
    meanOk(tu.map((r) => r[L.P_T0]), 1, 4 / Math.sqrt(12), 'uniform t0');
    const rf = get({ time: { type: 'rfPhase', freq: 1.1 } });
    meanOk(rf.map((r) => r[L.P_T0]), 0.5 / 1.1, 1 / (1.1 * Math.sqrt(12)), 'rf phase');
    for (const r of rf) assert.ok(r[L.P_T0] >= 0 && r[L.P_T0] < 1 / 1.1);
    const ls = get({ energy: { type: 'list', values: [1, 2, 4] } });
    meanOk(ls.map((r) => r[L.P_KE]), 7 / 3, Math.sqrt(14 / 9), 'list KE');
    // relativistic flag: |w| = proper speed
    const rel = rows(generate([src({ count: 3, species: [{ mass: ME_U, charge: -1 }], energy: { type: 'mono', ke: 511e3 } })], 0, 3, { relativistic: true }));
    for (const r of rel) relEq(Math.hypot(r[L.P_WX], r[L.P_WY], r[L.P_WZ]), properSpeedFromKE(511e3, ME_U), 1e-14, 'relativistic |w|');
});
