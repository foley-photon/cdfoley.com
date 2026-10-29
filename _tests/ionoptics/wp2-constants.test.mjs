// WP2 constants: CODATA 2022 inputs, derived constants computed at load time, §2.1.2 spot values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../beta/ion-optics/js/engine/constants.js';

/** |value − ref| within max(rel·|ref|, half a unit in the last printed digit of ref). */
function near(value, ref, rel = 1e-9, msg = '') {
    const s = String(ref);
    const dec = s.includes('e') ? 0 : (s.split('.')[1] || '').length;
    const tol = Math.max(rel * Math.abs(ref), s.includes('e') ? 0 : 0.5 * 10 ** -dec);
    assert.ok(Math.abs(value - ref) <= tol, `${msg} ${value} vs ${ref} (tol ${tol})`);
}
const relEq = (a, b, rel, msg = '') => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg} ${a} vs ${b} (rel ${Math.abs(a / b - 1)})`);

test('CODATA 2022 inputs and derived constants', () => {
    assert.equal(C.E_CHARGE, 1.602176634e-19);
    assert.equal(C.AMU_KG, 1.66053906892e-27);
    assert.equal(C.ME_KG, 9.1093837139e-31);
    assert.equal(C.C_MMUS, 299792.458);
    relEq(C.K_ACC, 96.48533202185, 1e-12, 'K_ACC');
    relEq(C.K_ACC, C.E_CHARGE / C.AMU_KG * 1e-6, 0, 'K_ACC computed');
    relEq(C.ME_U, 5.4857990904271e-4, 1e-12, 'ME_U');
    relEq(C.UC2_EV, 931494103.72, 1e-10, 'UC2_EV');
    relEq(C.MU0_4PI_MM, 1e-4, 1e-9, 'MU0_4PI_MM');
    // the research JSON's speed constant 13.891386 is wrong in the 7th digit; the computed one is 13.8913881...
    relEq(Math.sqrt(2 * C.K_ACC), 13.8913881252, 1e-11, 'sqrt(2K)');
});

test('spot value: transit of 10 mm at 1000 V from rest (100 u)', () => {
    const a = C.K_ACC * 1 / 100 * (1000 / 10);
    const t = Math.sqrt(2 * 10 / a);
    near(t, 0.4552860566, 1e-9, 'transit');
    near(C.speedFromKE(1000, 100, false), 43.9284263, 1e-9, 'final speed');
    // with 10 eV along +x
    const v0 = C.speedFromKE(10, 100, false);
    near((-v0 + Math.sqrt(v0 * v0 + 2 * a * 10)) / a, 0.4120282184, 1e-9, 'transit from 10 eV');
});

test('spot values: 1 m drift at 1000 eV', () => {
    const refs = [[1.00782503207, 2.28531950], [28, 12.0457368], [100, 22.7643028], [1000, 71.9870463]];
    for (const [m, ref] of refs) near(1000 / C.speedFromKE(1000, m, false), ref, 1e-9, 'drift m=' + m);
    // nonrelativistic speed = 13.8913881·sqrt(KE/m)
    relEq(C.speedFromKE(1000, 100, false), 13.8913881252 * Math.sqrt(10), 1e-11, 'speed constant');
});

test('spot values: cyclotron radius and frequency', () => {
    const a = C.cyclotron(100, 1, 0.5, 1000, false);
    near(a.radiusMM, 91.0572113, 1e-9, 'r(100 u, 1 keV, 0.5 T)');
    near(a.freqMHz * 1e6, 76780.5876, 1e-9, 'f Hz');
    const b = C.cyclotron(C.ME_U, -1, 1e-3, 100, false);
    near(b.radiusMM, 33.7212992, 1e-9, 'electron r nonrel');
    near(b.freqMHz, 27.9924898, 1e-9, 'electron f nonrel');
    const c = C.cyclotron(C.ME_U, -1, 1e-3, 100, true);
    near(c.radiusMM, 33.7229490, 1e-9, 'electron r rel');
    near(c.freqMHz, 27.9870129, 1e-9, 'electron f rel');
    // K9: KE = me c², 0.1 T: γ = 2, β = √3/2, r = γ m v/(|q| B)
    const ke = C.ME_U * C.UC2_EV;
    const k9 = C.cyclotron(C.ME_U, -1, 0.1, ke, true);
    near(k9.radiusMM, 29.523, 1e-9, 'K9 radius');
    relEq(C.speedFromKE(ke, C.ME_U, true) / C.C_MMUS, Math.sqrt(3) / 2, 1e-13, 'K9 beta');
});

test('relativistic kinematics: round trips and limits', () => {
    for (const [ke, m] of [[1e-3, 100], [1000, 100], [1e5, C.ME_U], [5e6, C.ME_U], [1e9, 1.0072764665789]]) {
        const w = C.properSpeedFromKE(ke, m);
        relEq(C.keFromProper(w, 0, 0, m, true), ke, 1e-13, 'KE round trip');
        const g = C.gammaFromProper(0, w, 0);
        relEq(g, 1 + ke / (m * C.UC2_EV), 1e-14, 'gamma');
        relEq(C.speedFromKE(ke, m, true), w / g, 1e-13, 'v = w/γ');
        assert.ok(C.speedFromKE(ke, m, true) < C.C_MMUS);
    }
    // the nonrelativistic limit
    relEq(C.speedFromKE(1, 100, true), C.speedFromKE(1, 100, false), 1e-8, 'low-energy limit');
    relEq(C.keFromProper(3, 4, 0, 100, false), 100 * 25 / (2 * C.K_ACC), 1e-15, 'nonrel KE');
    assert.equal(C.speedFromKE(0, 100, true), 0);
    assert.equal(C.properSpeedFromKE(-1, 100), 0);
});
