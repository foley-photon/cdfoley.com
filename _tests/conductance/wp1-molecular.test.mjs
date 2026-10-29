// WP1 molecular transmission probabilities (spec 2.4, 3.2; acceptance 7.2.5).
// Run: node --test "_tests/conductance/wp1-molecular.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../../beta/conductance/js/engine/molecular.js';
import { TUBE_IE, SLOT, RECT, ANNULUS, CONE, ELBOW, COLS_L, TABLE_SOURCES } from '../../beta/conductance/js/engine/tables.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/validation-cases-v2.json', import.meta.url), 'utf8'));
const DEG = Math.PI / 180;
const rel = (a, b) => Math.abs(a / b - 1);
const logGrid = (a, b, n) => Array.from({ length: n }, (_, k) => a * Math.pow(b / a, k / (n - 1)));

test('tubeAlpha: Berman within 0.07 % of Matuda and of the integral-equation table; 1 at zero length; decreasing', () => {
    assert.equal(M.tubeAlpha(0), 1);
    for (const [m, ref] of Object.entries(V.tube_exact_m_eq_L_over_D)) {
        if (m === 'source') continue;
        assert.ok(rel(M.tubeAlpha(+m), ref) < 0.0007, `L/D = ${m}`);
    }
    TUBE_IE.l.forEach((l, i) => assert.ok(rel(M.tubeAlpha(l / 2), TUBE_IE.alpha[i]) < 0.0007, `L/R = ${l}`));
    let prev = 1;
    for (const y of logGrid(1e-6, 1e4, 4000)) { const a = M.tubeAlpha(y); assert.ok(a < prev && a > 0); prev = a; }
    // long-tube limit 4/(3y)
    assert.ok(rel(M.tubeAlpha(1e6), 4 / 3e6) < 1e-5);
});

test('tubeAlphaInverse(tubeAlpha(y)) returns y to 1e-9 for y in [1e-6, 1e6]', () => {
    let worst = 0;
    for (const y of [...logGrid(1e-6, 1e6, 6001), ...logGrid(1e4 * (1 - 1e-4), 1e4 * (1 + 1e-4), 41)]) {
        worst = Math.max(worst, rel(M.tubeAlphaInverse(M.tubeAlpha(y)), y));
    }
    assert.ok(worst < 1e-9, `worst round trip ${worst}`);
    assert.equal(M.tubeAlphaInverse(1), 0);
    for (const a of [0, -0.1, 1.01, NaN]) assert.throws(() => M.tubeAlphaInverse(a), RangeError);
});

test('Berman tube: closed form to y = 1e7, asymptote above, joined to 1e-8 (spec v2.1, integration fix of 3.2.1)', () => {
    // high-precision values of Berman's closed form (60-digit decimal arithmetic, integration scratch berman.py)
    const EXACT = { 1e4: 1.33271190538671744e-4, 2.5e4: 5.33226562329242377e-5, 1e5: 1.33325966574193846e-5,
        1e6: 1.33332481513525327e-6, 1e7: 1.33333236638253035e-7 };
    for (const [y, a] of Object.entries(EXACT)) assert.ok(rel(M.tubeAlpha(+y), a) < 1e-9, `y = ${y}`);
    const below = M.tubeAlpha(1e7), above = M.tubeAlpha(1e7 * (1 + 1e-12));
    assert.ok(Math.abs(above / below - 1) < 1e-8, `jump ${above / below - 1}`);
    let prev = 1;
    for (const y of logGrid(1e3, 1e9, 3001)) { const a = M.tubeAlpha(y); assert.ok(a < prev && a > 0, `monotone at ${y}`); prev = a; }
});

test('slotAlpha reproduces the SLOT nodes, holds q below x = 0.05 and follows ln x/x above 1e4', () => {
    assert.equal(M.slotAlpha(0), 1);
    SLOT.x.forEach((x, i) => assert.ok(rel(M.slotAlpha(x), SLOT.alpha[i]) < 1e-14, `x = ${x}`));
    const q = (1 / SLOT.alpha[0] - 1) / 0.05;
    assert.ok(rel(M.slotAlpha(0.01), 1 / (1 + q * 0.01)) < 1e-15);
    const aN = SLOT.alpha[SLOT.alpha.length - 1];
    assert.ok(rel(M.slotAlpha(1e5), aN * (Math.log(1e5) / 1e5) / (Math.log(1e4) / 1e4)) < 1e-15);
    // within 0.002 % of the research's independent integral-equation values (measured worst 2.03e-5 at x = 4)
    for (const [x, ref] of Object.entries(V.slot_L_over_h.this_work_IE)) assert.ok(rel(M.slotAlpha(+x), ref) < 2.1e-5, `x = ${x}`);
    let prev = 1;
    for (const x of logGrid(1e-3, 1e5, 3000)) { const a = M.slotAlpha(x); assert.ok(a < prev); prev = a; }
});

test('rectAlpha: any side order, table nodes, slot limit and Santeler & Boeckmann within 0.09 %', () => {
    assert.ok(rel(M.rectAlpha(1, 3, 2), M.rectAlpha(3, 1, 2)) < 1e-15);
    RECT.rows.forEach((s, i) => {
        if (s === 0) return;
        COLS_L.forEach((l, j) => assert.ok(rel(M.rectAlpha(s, 1, l * s), RECT.alpha[i][j]) < 1e-13, `s ${s} l ${l}`));
    });
    for (const l of [0.1, 2, 100]) assert.ok(rel(M.rectAlpha(1e-7, 1, l * 1e-7), M.slotAlpha(l)) < 2e-6);
    for (const [k, ref] of Object.entries(V.rect_santeler_boeckmann_via_livesey_table2_6)) {
        if (k === 'source') continue;
        const [, ba, l] = k.match(/\(?(?:b\/a=)?([\d.]+),(?:l\/a=)?([\d.]+)\)/).map(Number);
        assert.ok(rel(M.rectAlpha(1, ba, l), ref) < 0.0009 + 1e-6, k);
    }
    assert.equal(M.rectAlpha(1, 2, 0), 1);
});

test('annulusAlpha: table nodes, tube and slot limits, Berman table within 0.21 %', () => {
    ANNULUS.rows.forEach((e, i) => {
        if (e === 0 || e === 1) return;
        COLS_L.forEach((l, j) => assert.ok(rel(M.annulusAlpha(e, 1, l * (1 - e)), ANNULUS.alpha[i][j]) < 1e-13, `e ${e} l ${l}`));
    });
    for (const l of [0.05, 1, 30, 300]) {
        assert.equal(M.annulusAlpha(0, 2, l), M.tubeAlpha(l / 4));
        assert.ok(rel(M.annulusAlpha(1e-9, 1, l), M.tubeAlpha(l / 2)) < 1e-8);
        assert.ok(rel(M.annulusAlpha(1 - 1e-7, 1, l * 1e-7), M.slotAlpha(l)) < 2e-6);
    }
    for (const [k, ref] of Object.entries(V.annulus_berman_via_livesey_table2_9_Ri_over_Ro_l_over_gap)) {
        const [, e, l] = k.match(/\(([\d.]+),([\d.]+)\)/).map(Number);
        assert.ok(rel(M.annulusAlpha(e, 1, l * (1 - e)), ref) < 0.0021, k);
    }
});

test('coneAlpha: reciprocity A1 alpha12 = A2 alpha21, table nodes, tube limit, NASA diverging values within 0.36 %', () => {
    for (const [R1, R2, L] of [[1, 2, 3], [0.3, 0.05, 0.4], [1, 1 + 4 * Math.tan(10 * DEG), 4], [2, 1, 300], [1, 1.0001, 5]]) {
        const lhs = R1 * R1 * M.coneAlpha(R1, R2, L), rhs = R2 * R2 * M.coneAlpha(R2, R1, L);
        assert.ok(rel(lhs, rhs) < 1e-14, `${R1} ${R2} ${L}`);
    }
    CONE.rows.forEach((b, i) => {
        if (b === 0 || b === 90) return;
        COLS_L.forEach((l, j) => assert.ok(rel(M.coneDivAlpha(b, l), CONE.alpha[i][j]) < 1e-13, `beta ${b} l ${l}`));
    });
    for (const l of [0.2, 5, 150]) {
        assert.equal(M.coneAlpha(1, 1, l), M.tubeAlpha(l / 2));
        assert.equal(M.coneDivAlpha(0, l), M.tubeAlpha(l / 2));
        assert.equal(M.coneDivAlpha(90, l), 1);
    }
    for (const k of ['(10,1)', '(20,2)', '(30,4)', '(45,1)']) {
        const [, b, l] = k.match(/\((-?[\d.]+),([\d.]+)\)/).map(Number);
        assert.ok(rel(M.coneAlpha(1, 1 + l * Math.tan(b * DEG), l), V.cone_nasa_tnd2330_table1a_beta_deg_L_over_R1[k]) < 0.0037, k);
    }
    // converging = diverging (small-end referred) times (R2/R1)^2
    assert.ok(rel(M.coneAlpha(2, 1, 3), M.coneDivAlpha(Math.atan(1 / 3) / DEG, 3) / 4) < 1e-15);
});

test('elbowAlpha: kappa table nodes reproduce the TPMC alphas, symmetric legs, clamped beyond 50 R', () => {
    const legs = ELBOW.legs;
    legs.forEach((A, i) => legs.forEach((B, j) => {
        assert.ok(rel(M.elbowAlpha(1, A, B), ELBOW.alpha[i][j]) < 1e-6, `A ${A} B ${B}`);
        assert.equal(M.elbowAlpha(1, A, B), M.elbowAlpha(1, B, A));
    }));
    for (const [A, B] of [[1.3, 7], [2.5, 33], [4, 12]]) assert.ok(rel(M.elbowAlpha(1, A, B), M.elbowAlpha(1, B, A)) < 5e-4);
    // scale invariance and clamping: kappa is held beyond 50 R (the Oatley legs still lengthen)
    assert.ok(rel(M.elbowAlpha(0.02, 0.06, 0.1), M.elbowAlpha(1, 3, 5)) < 1e-14);
    const oatley = (A, B) => 1 / (1 / M.tubeAlpha(A / 2) + 1 / M.tubeAlpha(B / 2) - 1);
    assert.ok(rel(M.elbowAlpha(1, 80, 3) / oatley(80, 3), M.elbowAlpha(1, 50, 3) / oatley(50, 3)) < 1e-14);
});

test('Berman cross-check formulas: slot within 0.105 % to x = 10 and 0.5 % to 1000; annulus within 1.2 % at the Berman points', () => {
    for (const x of logGrid(0.001, 10, 500)) assert.ok(rel(M.bermanSlotAlpha(x), M.slotAlpha(x)) < 0.00105, `x = ${x}`);
    for (const x of logGrid(10, 1000, 300)) assert.ok(rel(M.bermanSlotAlpha(x), M.slotAlpha(x)) < 0.005, `x = ${x}`);
    assert.ok(rel(M.bermanSlotAlpha(0.005), 0.5 * (1 + Math.sqrt(1 + 0.005 ** 2) - 0.005)) < 1e-15);
    for (const k of Object.keys(V.annulus_berman_via_livesey_table2_9_Ri_over_Ro_l_over_gap)) {
        const [, e, l] = k.match(/\(([\d.]+),([\d.]+)\)/).map(Number);
        assert.ok(rel(M.bermanAnnulusAlpha(e, 1, l * (1 - e)), M.annulusAlpha(e, 1, l * (1 - e))) < 0.012, k);
    }
    // over Berman's whole validity range (x = L/(do - di) <= 50, e <= 0.9) the fit stays within 1.7 % (measured 1.64 %)
    for (const e of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        for (const x of [0.25, 1, 2, 5, 10, 20, 30, 40, 50]) {
            assert.ok(rel(M.bermanAnnulusAlpha(e, 1, 2 * x * (1 - e)), M.annulusAlpha(e, 1, 2 * x * (1 - e))) < 0.017, `e ${e} x ${x}`);
        }
    }
});

test('molecularInfo gives the accuracy labels of spec 3.2.8 and the extrapolation flag', () => {
    const cases = [
        ['tube', { d: 0.04, L: 100 }, 0.001, false], ['slit', { h: 0.001, w: 0.05, L: 0.05 }, 0.003, false], ['slit', { h: 0.001, w: 0.05, L: 0.2 }, 0.008, true],
        ['rect', { a: 0.03, b: 0.01, L: 0.5 }, 0.003, false], ['rect', { a: 0.03, b: 0.01, L: 1.5 }, 0.008, true],
        ['annulus', { di: 0.02, do: 0.04, L: 0.5 }, 0.005, false], ['annulus', { di: 0.02, do: 0.04, L: 1.01 }, 0.010, true],
        ['cone', { d1: 0.04, d2: 0.02, L: 0.9 }, 0.004, false], ['cone', { d1: 0.04, d2: 0.02, L: 1.1 }, 0.010, true],
        ['elbow', { d: 0.04, A: 0.02, B: 1 }, 0.003, false], ['elbow', { d: 0.04, A: 0.02, B: 1.2 }, 0.010, true],
        ['elbow', { d: 0.04, A: 0.01, B: 0.1 }, 0.010, true], ['orifice', { shape: 'circle', d: 0.01 }, 0, false], ['bbox', { C: 0.1, d: 0.04 }, 0, false],
    ];
    for (const [type, p, acc, x] of cases) {
        const info = M.molecularInfo(type, p);
        assert.equal(info.accuracy, acc, `${type} accuracy`);
        assert.equal(info.extrapolated, x, `${type} extrapolated`);
        assert.ok(typeof info.source === 'string' && info.source.length > 5);
    }
    assert.equal(M.molecularInfo('rect', {}).source, TABLE_SOURCES.RECT);
    assert.throws(() => M.molecularInfo('chamber', {}), RangeError);
});

test('molecular functions throw RangeError for non-positive or non-finite dimensions', () => {
    const bad = [
        () => M.tubeAlpha(-1), () => M.tubeAlpha(NaN), () => M.tubeAlpha(Infinity), () => M.slotAlpha(-0.1),
        () => M.rectAlpha(0, 1, 1), () => M.rectAlpha(1, -1, 1), () => M.rectAlpha(1, 1, -1), () => M.annulusAlpha(1, 1, 1),
        () => M.annulusAlpha(-0.1, 1, 1), () => M.annulusAlpha(0.5, 0, 1), () => M.coneDivAlpha(-1, 1), () => M.coneDivAlpha(91, 1),
        () => M.coneDivAlpha(10, -1), () => M.coneAlpha(0, 1, 1), () => M.coneAlpha(1, 2, NaN), () => M.elbowAlpha(1, 0, 1),
        () => M.elbowAlpha(-1, 2, 2), () => M.bermanSlotAlpha(-1), () => M.bermanAnnulusAlpha(2, 1, 1),
    ];
    for (const fn of bad) assert.throws(fn, (e) => e instanceof RangeError && /\.$/.test(e.message));
});

// ---- v2.2 fix round 1: tubeAlphaInverse reaches far below alpha = 1.3e-9 (closed or nearly closed black boxes)
test('tubeAlphaInverse inverts down to alpha = 1e-14', () => {
    for (const a of [1e-9, 1e-10, 1e-11, 1e-14]) {
        const y = M.tubeAlphaInverse(a);
        assert.ok(Math.abs(M.tubeAlpha(y) / a - 1) < 1e-9, `alpha ${a}: y ${y}`);
    }
});
