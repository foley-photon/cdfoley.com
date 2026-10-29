// WP5: display units and formatting (spec 2.15, 7.6 acceptance 2), checked against the site's real calc.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as F from '../../beta/conductance/js/ui/format.js';
import { store } from '../../beta/conductance/js/ui/store.js';

// calc.js is a browser IIFE; run it in a sandbox with the few globals it touches at load time.
function loadCalc() {
    const src = readFileSync(new URL('../../assets/js/calc.js', import.meta.url), 'utf8');
    const sandbox = { window: { addEventListener() {}, removeEventListener() {} }, document: { addEventListener() {}, querySelectorAll: () => [] }, navigator: {}, location: { hash: '' }, history: {}, Math, Number, String, parseFloat, parseInt, isFinite, isNaN, URLSearchParams };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox.window.Calc;
}
const Calc = loadCalc();
const CALC_DIM = { length: 'length', speed: 'throughput', pressure: 'pressure', temperature: 'temperature' };
const rel = (a, b) => Math.abs(a / b - 1);

test('unit conversions match Calc.toSI and Calc.fromSI, with and without Calc', () => {
    for (const calc of [Calc, null]) {
        F.setCalc(calc);
        for (const [dim, units] of Object.entries(F.UNITS)) {
            if (dim === 'pv') continue;
            for (const u of units) {
                for (const x of [1e-6, 0.37, 20, 1234.5]) {
                    const si = Calc.toSI(CALC_DIM[dim], u, x);
                    assert.ok(rel(F.toSI(dim, u, x), si) < 1e-14, `${dim} ${u} toSI`);
                    assert.ok(rel(F.fromSI(dim, u, si), Calc.fromSI(CALC_DIM[dim], u, si)) < 1e-14, `${dim} ${u} fromSI`);
                    assert.ok(Math.abs(F.fromSI(dim, u, F.toSI(dim, u, x)) - x) <= 1e-12 * (dim === 'temperature' ? 500 : Math.abs(x)), `${dim} ${u} round trip`);
                }
            }
        }
    }
    F.setCalc(Calc);
    assert.throws(() => F.toSI('length', 'furlong', 1), RangeError);
});

test('pv units and sccm', () => {
    assert.equal(F.fromSI('pv', 'Pa·m³/s', 2), 2);
    assert.ok(rel(F.fromSI('pv', 'mbar·L/s', 1), 10) < 1e-15);
    assert.ok(rel(F.fromSI('pv', 'Torr·L/s', 1), 1 / (101325 / 760 * 1e-3)) < 1e-15);
    const Q = 1.7e-3;
    // spec: Q·592.17·273.15/293.15 (592.17 is the spec's rounding of 60e6/101325 = 592.154)
    assert.ok(rel(F.fromSI('pv', 'sccm', Q, 293.15), Q * 592.17 * 273.15 / 293.15) < 5e-5);
    assert.ok(rel(F.fromSI('pv', 'sccm', Q, 293.15), Q * (60e6 / 101325) * 273.15 / 293.15) < 1e-14);
    assert.ok(rel(F.toSI('pv', 'sccm', F.fromSI('pv', 'sccm', Q, 400), 400), Q) < 1e-14);
    assert.ok(rel(F.fromSI('pv', 'sccm', Q, 273.15), Q * 592.154) < 1e-5);
});

test('numbers use Calc.fmt.num rules; the fallback agrees', () => {
    const xs = [0, 1, -2.5, 138.457, 0.001234567, 1.234567e-5, 99999.4, 123456, -7.1e-9, 1e-3, NaN, Infinity, -Infinity];
    for (const sig of [2, 3, 4, 6]) {
        for (const x of xs) {
            F.setCalc(Calc);
            const a = F.fmtNum(x, sig);
            assert.equal(a, Calc.fmt.num(x, sig));
            F.setCalc(null);
            assert.equal(F.fmtNum(x, sig), a, `fallback ${x} ${sig}`);
        }
    }
    F.setCalc(Calc);
    assert.equal(F.fmtNum(1.234567e-5, 4), '1.235 × 10⁻⁵');
    assert.equal(F.fmtPct(0.46152), '46.2 %');
    assert.equal(F.fmtSignedPct(-0.013), '−1.3 %');
    assert.equal(F.fmtSignedPct(0.084), '+8.4 %');
});

test('fmt uses the store units and the documented defaults', () => {
    F.setCalc(Calc);
    store.set({ lu: 'mm', su: 'L/s', pu: 'mbar' });
    assert.equal(F.fmt('speed', 0.13846), '138.5 L/s');
    assert.equal(F.fmt('length', 0.1), '100 mm');
    assert.equal(F.fmt('pressure', 1e-4), '1 × 10⁻⁶ mbar');
    assert.equal(F.fmt('pv', 1.3846e-5), '1.385 × 10⁻⁴ mbar·L/s');
    assert.equal(F.fmt('temperature', 293.15), '20 °C');
    assert.equal(F.fmt('speed', 0.13846, { unit: 'm³/h' }), '498.5 m³/h');
    store.set({ su: 'cfm' });
    assert.equal(F.fmt('speed', 0.0004719474432), '1 cfm');
    store.set({ su: 'L/s' });
    assert.equal(F.fmt('speed', Infinity), '∞');
    assert.equal(F.fmt('speed', NaN), '—');
});

test('fmtCI rounds the value to the precision of the half-width', () => {
    F.setCalc(Calc);
    assert.equal(F.fmtCI(0.13803, 0.13772, 0.13834, 'speed'), '138.0 ± 0.3 L/s');
    assert.equal(F.fmtCI(0.13803, 0.13787, 0.13819, 'speed'), '138.03 ± 0.16 L/s');
    assert.equal(F.fmtCI(0.26524, 0.26482, 0.26566), '0.2652 ± 0.0004');
    assert.equal(F.fmtCI(1500, 1000, 2000), '1500 ± 500');
    assert.equal(F.fmtCI(1, 0.5, 2), '1.0 (0.5–2.0)');
    assert.equal(F.fmtCI(0.5, 0.5, 0.5, 'speed'), '500 L/s');
    assert.ok(/× 10/.test(F.fmtCI(1.2e-9, 1.1e-9, 1.3e-9)));
});

test('parseInput is Calc.parseNum (decimal comma, ×10^, Unicode minus); editText gives ASCII', () => {
    for (const calc of [Calc, null]) {
        F.setCalc(calc);
        assert.equal(F.parseInput('1,5'), 1.5);
        assert.equal(F.parseInput('1×10^-3'), 1e-3);
        assert.equal(F.parseInput('−2e5'), -2e5);
        assert.equal(F.parseInput(' 12 '), 12);
        assert.ok(Number.isNaN(F.parseInput('1,2,3,4')));
        assert.ok(Number.isNaN(F.parseInput('abc')));
        assert.ok(Number.isNaN(F.parseInput('')));
        assert.equal(F.editText(1e-6), '1e-6');
        assert.equal(F.editText(100), '100');
        assert.equal(F.editText(0.009722222), '0.00972222');
    }
    F.setCalc(Calc);
});

// ---- v2.2 fix round 1: the throughput unit follows the pressure unit
test('throughput is shown in the unit family of the chosen pressure unit', () => {
    const want = { mbar: 'mbar·L/s', Pa: 'Pa·m³/s', Torr: 'Torr·L/s', mTorr: 'Torr·L/s' };
    for (const [pu, u] of Object.entries(want)) { store.set({ pu }); assert.equal(F.defaultUnit('pv'), u, pu); }
    store.set({ pu: 'Pa' });
    assert.match(F.fmt('pv', 1.5), /Pa·m³\/s$/);
    store.set({ pu: 'mbar' });
});
