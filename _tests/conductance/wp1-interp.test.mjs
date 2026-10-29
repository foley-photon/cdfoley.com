// WP1 interpolation machinery (spec 2.2, 3.4; acceptance 7.2.4): PCHIP reproduces nodes, stays monotone on
// monotone data (10^4 random sets) and matches SciPy's PchipInterpolator; q-tables, the cone kappa table and the
// three-point tail fit behave as specified.
// Run: node --test "_tests/conductance/wp1-interp.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pchipSlopes, makePchip, findInterval, fitTail3, makeQTable, makeKappaCone, coneBase } from '../../beta/conductance/js/engine/interp.js';
import { COLS_L, RECT, ANNULUS, CONE } from '../../beta/conductance/js/engine/tables.js';
import { tubeAlpha, slotAlpha } from '../../beta/conductance/js/engine/molecular.js';

const SCIPY = JSON.parse(readFileSync(new URL('./fixtures/wp1/pchip-scipy.json', import.meta.url), 'utf8'));

// mulberry32: small seeded generator local to this test file
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test('PCHIP reproduces its nodes exactly and is linear for two points and outside the nodes', () => {
    const x = [0.1, 0.4, 1, 1.7, 3, 8], y = [2, 1.5, 1.4, 0.2, 0.1, -3];
    const f = makePchip(x, y), d = pchipSlopes(x, y);
    x.forEach((xi, i) => assert.equal(f(xi), y[i]));
    const g = makePchip([1, 3], [2, 6]);
    for (const t of [-1, 1, 1.5, 2.9, 3, 10]) assert.ok(Math.abs(g(t) - (2 + 2 * (t - 1))) < 1e-14);
    assert.ok(Math.abs(f(0) - (y[0] + d[0] * (0 - x[0]))) < 1e-15);
    assert.ok(Math.abs(f(20) - (y[5] + d[5] * (20 - x[5]))) < 1e-12);
    assert.ok(Number.isNaN(f(NaN)));
});

test('PCHIP matches SciPy PchipInterpolator (fixture wp1/pchip-scipy.json, slopes and values)', () => {
    assert.ok(SCIPY.cases.length >= 3 && /PchipInterpolator/.test(SCIPY.generator));
    for (const c of SCIPY.cases) {
        const d = pchipSlopes(c.x, c.y), f = makePchip(c.x, c.y);
        const scale = Math.max(...c.y.map(Math.abs), 1);
        c.slopes.forEach((s, i) => assert.ok(Math.abs(d[i] - s) <= 1e-12 * Math.max(1, Math.abs(s)), `${c.name}: slope ${i} ${d[i]} vs ${s}`));
        c.t.forEach((t, k) => assert.ok(Math.abs(f(t) - c.value[k]) <= 1e-12 * scale, `${c.name}: f(${t}) = ${f(t)} vs ${c.value[k]}`));
    }
});

test('PCHIP is monotone on 10^4 random monotone data sets', () => {
    const r = rng(20261013);
    for (let set = 0; set < 10000; set++) {
        const n = 2 + Math.floor(r() * 11), sgn = r() < 0.5 ? 1 : -1;
        const x = [], y = [];
        let xv = r() * 10 - 5, yv = r() * 10 - 5;
        for (let i = 0; i < n; i++) {
            x.push(xv); y.push(yv);
            xv += 1e-3 + r() * (r() < 0.2 ? 20 : 1);
            yv += sgn * (r() < 0.25 ? 0 : r() * (r() < 0.2 ? 50 : 1));
        }
        const f = makePchip(x, y);
        let prev = f(x[0]);
        const m = 48;
        for (let k = 1; k <= m; k++) {
            const t = x[0] + (x[n - 1] - x[0]) * k / m;
            const v = f(t);
            assert.ok(sgn * (v - prev) >= -1e-12 * Math.max(1, Math.abs(v)), `set ${set}: not monotone at ${t}`);
            prev = v;
        }
    }
});

test('makePchip and pchipSlopes reject bad nodes', () => {
    assert.throws(() => makePchip([1], [1]), RangeError);
    assert.throws(() => makePchip([0, 1, 1], [1, 2, 3]), RangeError);
    assert.throws(() => makePchip([0, 2, 1], [1, 2, 3]), RangeError);
    assert.throws(() => makePchip([0, 1], [1, NaN]), RangeError);
    assert.throws(() => pchipSlopes([0, 1, 2], [1, 2]), RangeError);
});

test('findInterval returns x[i] <= t < x[i+1], clamped to [0, n-2]', () => {
    const x = [0, 1, 2, 5, 9];
    const cases = [[-3, 0], [0, 0], [0.5, 0], [1, 1], [1.99, 1], [2, 2], [4.9, 2], [5, 3], [8.9, 3], [9, 3], [100, 3], [NaN, 0]];
    for (const [t, i] of cases) assert.equal(findInterval(x, t), i, `t = ${t}`);
    assert.equal(findInterval([1, 2], 5), 0);
});

test('fitTail3 passes exactly through its three points and reproduces q = c0 + (c1 + c2 ln l)/l', () => {
    const exact = (l) => 0.75 + (0.4 - 0.37 * Math.log(l)) / l;
    const f = fitTail3([20, 50, 100], [exact(20), exact(50), exact(100)]);
    for (const l of [20, 50, 100, 300, 1e4]) assert.ok(Math.abs(f(l) / exact(l) - 1) < 1e-12);
    const g = fitTail3([20, 50, 100], [1.1, 1.2, 1.25]);
    assert.ok(Math.abs(g(20) - 1.1) < 1e-13 && Math.abs(g(50) - 1.2) < 1e-13 && Math.abs(g(100) - 1.25) < 1e-13);
    assert.throws(() => fitTail3([1, 2], [1, 2]), RangeError);
});

test('makeQTable reproduces table nodes, uses special rows, holds q below the first column and fits tails', () => {
    const rect = makeQTable({ rows: RECT.rows, cols: COLS_L, alpha: RECT.alpha, special: { 0: slotAlpha } });
    RECT.rows.forEach((s, i) => COLS_L.forEach((l, j) => {
        const want = i === 0 ? slotAlpha(l) : RECT.alpha[i][j];
        assert.ok(Math.abs(rect(s, l) / want - 1) < 1e-13, `row ${s} col ${l}`);
    }));
    assert.equal(rect(0.5, 0), 1);
    assert.equal(rect(0.5, -1), 1);
    // below l = 0.1: q held at its l = 0.1 value
    const q01 = (1 / RECT.alpha[5][0] - 1) / 0.1;
    assert.ok(Math.abs(rect(0.5, 0.02) - 1 / (1 + q01 * 0.02)) < 1e-14);
    // above l = 100: the three-point tail of each row
    const qs = [20, 50, 100].map((l, k) => (1 / RECT.alpha[6][7 + k] - 1) / l);
    const tail = fitTail3([20, 50, 100], qs);
    assert.ok(Math.abs(rect(1, 400) / (1 / (1 + tail(400) * 400)) - 1) < 1e-13);
    // annulus: tube and slot rows given by functions
    const ann = makeQTable({ rows: ANNULUS.rows, cols: COLS_L, alpha: ANNULUS.alpha, special: { 0: (l) => tubeAlpha(l / 2), 6: slotAlpha } });
    for (const l of [0.05, 3, 250]) {
        assert.ok(Math.abs(ann(0, l) / tubeAlpha(l / 2) - 1) < 1e-13);
        assert.ok(Math.abs(ann(1, l) / slotAlpha(l) - 1) < 1e-13);
    }
    // continuous at the column limits
    for (const l of [0.1, 100]) assert.ok(Math.abs(rect(0.3, l * (1 + 1e-9)) / rect(0.3, l * (1 - 1e-9)) - 1) < 1e-7);
});

test('makeKappaCone reproduces table nodes, the tube row, the flat row and is continuous at l = 0.1 and 100', () => {
    const cone = makeKappaCone({ rows: CONE.rows, cols: COLS_L, alpha: CONE.alpha, tubeAlpha });
    CONE.rows.forEach((b, i) => {
        if (b === 0 || b === 90) return;
        COLS_L.forEach((l, j) => assert.ok(Math.abs(cone(b, l) / CONE.alpha[i][j] - 1) < 1e-13, `beta ${b} l ${l}`));
    });
    for (const l of [0.01, 0.5, 7, 100, 400]) {
        assert.ok(Math.abs(cone(0, l) / tubeAlpha(l / 2) - 1) < 1e-13);
        assert.equal(cone(90, l), 1);
    }
    assert.equal(cone(30, 0), 1);
    for (const b of [0.3, 6, 33, 70]) {
        for (const l of [0.1, 100]) assert.ok(Math.abs(cone(b, l * (1 + 1e-9)) / cone(b, l * (1 - 1e-9)) - 1) < 1e-7, `beta ${b} at l ${l}`);
        assert.ok(Math.abs(cone(b, 1e-6) - 1) < 1e-5, 'alpha tends to 1 as l tends to 0');
    }
    // coneBase equals Dushman's 1/(1 + 3l/8) at beta = 0 (with l = L/R)
    for (const l of [0.2, 4, 90]) assert.ok(Math.abs(coneBase(0, l) - 1 / (1 + 3 * l / 8)) < 1e-14);
});
