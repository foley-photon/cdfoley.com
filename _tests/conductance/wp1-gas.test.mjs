// WP1 gas data and kinetic helpers (spec 2.1, 3.1).
// Run: node --test "_tests/conductance/wp1-gas.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import * as GAS from '../../beta/conductance/js/engine/gas.js';

const { gasState, GASES, GAS_IDS } = GAS;
const rel = (a, b) => Math.abs(a / b - 1);

test('gas table matches spec 3.1 (M in kg/mol, eta20 in Pa s) and is frozen', () => {
    const table = {
        N2: ['Nitrogen', 28.0134, 17.57, 0.74, 1.40, 0.824, false],
        air: ['Dry air', 28.9647, 18.13, 0.77, 1.40, 0.82, true],
        He: ['Helium', 4.002602, 19.6, 0.66, 5 / 3, 0.81, true],
        H2: ['Hydrogen', 2.01588, 8.8, 0.67, 1.41, 0.82, true],
        Ar: ['Argon', 39.948, 22.3, 0.81, 5 / 3, 0.812, false],
        H2O: ['Water vapor', 18.01528, 9.55, 1.06, 1.33, 0.83, true],
        CO2: ['Carbon dioxide', 44.0095, 14.7, 0.93, 1.29, 0.83, false],
    };
    assert.deepEqual(Object.keys(GASES), Object.keys(table));
    for (const [id, [name, M, eta, omega, gamma, Cd, assumed]] of Object.entries(table)) {
        const g = GASES[id];
        assert.equal(g.name, name);
        assert.ok(rel(g.M, M * 1e-3) < 1e-15, `${id} M`);
        assert.ok(rel(g.eta20, eta * 1e-6) < 1e-15, `${id} eta20`);
        assert.equal(g.omega, omega);
        assert.equal(g.gamma, gamma);
        assert.equal(g.Cd, Cd);
        assert.equal(g.assumedCd, assumed);
    }
    assert.ok(Object.isFrozen(GASES) && Object.isFrozen(GASES.N2) && Object.isFrozen(GAS_IDS));
    assert.throws(() => { GASES.N2.M = 1; }, TypeError);
});

test('gasState derives Rs, eta(T), vbar, vm and c (Appendix C values for N2)', () => {
    const G = gasState('N2', 293.15);
    assert.equal(G.id, 'N2');
    assert.equal(G.name, 'Nitrogen');
    assert.ok(rel(G.Rs, 296.80) < 2e-5);
    assert.ok(rel(G.eta, 1.757e-5) < 1e-12);
    assert.ok(rel(G.vbar, 470.705) < 2e-6);
    assert.ok(rel(G.vm, 417.152) < 2e-6);
    assert.ok(rel(G.c, 349.01) < 2e-5);
    assert.equal(G.gamma, 1.4);
    assert.equal(G.Cd, 0.824);
    for (const id of GAS_IDS) {
        for (const T of [20, 77, 293.15, 600, 3000]) {
            const g = gasState(id, T), s = GASES[id];
            assert.ok(rel(g.Rs, GAS.R_GAS / s.M) < 1e-15);
            assert.ok(rel(g.eta, s.eta20 * Math.pow(T / 293.15, s.omega)) < 1e-14);
            assert.ok(rel(g.vbar, Math.sqrt(8 * g.Rs * T / Math.PI)) < 1e-15);
            assert.ok(rel(g.vm, Math.sqrt(2 * g.Rs * T)) < 1e-15);
            assert.ok(rel(g.c, Math.sqrt(s.gamma * g.Rs * T)) < 1e-15);
        }
    }
});

test('check values of spec 3.1: air orifice 11.5728 L/s per cm², mean free path 6.5915 mm at 1 Pa, delta = 67.2 d[cm] p[mbar]', () => {
    const air = gasState('air', 293.15);
    assert.ok(Math.abs(air.vbar - 462.911) < 5e-4);
    assert.ok(Math.abs(GAS.orificeC(air, 1e-4) * 1e3 - 11.5728) < 5e-5);
    assert.ok(Math.abs(GAS.meanFreePath(air, 1) * 1e3 - 6.5915) < 5e-5);
    // delta for r = d/2 with d = 1 cm and p = 1 mbar
    assert.ok(Math.abs(GAS.rarefaction(air, 0.005, 100) - 67.2) < 0.05);
    assert.ok(rel(GAS.meanFreePath(air, 1), (Math.sqrt(Math.PI) / 2) * air.eta * air.vm) < 1e-15);
});

test('water vapor viscosity follows the IAPWS fit (9.551 µPa s at 293.15 K, 12.34 at 373.15 K)', () => {
    assert.ok(Math.abs(gasState('H2O', 293.15).eta * 1e6 - 9.551) < 0.002);
    assert.ok(Math.abs(gasState('H2O', 373.15).eta * 1e6 - 12.34) < 0.012);
});

test('custom gases and the discharge-coefficient override', () => {
    const custom = { M: 0.032, eta20: 20.4e-6, omega: 0.77, gamma: 1.4, Cd: 0.8 };
    const G = gasState('custom', 300, custom);
    assert.equal(G.id, 'custom');
    assert.equal(G.name, 'Custom gas');
    assert.equal(G.M, 0.032);
    assert.equal(G.Cd, 0.8);
    assert.equal(gasState('custom', 300, custom, 0.95).Cd, 0.95);
    assert.equal(gasState('Ar', 300, null, 0.6).Cd, 0.6);
    assert.equal(gasState('Ar', 300, null, null).Cd, 0.812);
});

test('gasState throws a RangeError with a field for every invalid input', () => {
    const custom = { M: 0.032, eta20: 20.4e-6, omega: 0.77, gamma: 1.4, Cd: 0.8 };
    const bad = [
        [() => gasState('N2', 19.9), 'T'], [() => gasState('N2', 3000.1), 'T'], [() => gasState('N2', NaN), 'T'], [() => gasState('N2', '300'), 'T'],
        [() => gasState('Xe', 300), 'id'], [() => gasState('custom', 300), 'M'], [() => gasState('custom', 300, null), 'M'],
        [() => gasState('custom', 300, { ...custom, M: 0 }), 'M'], [() => gasState('custom', 300, { ...custom, eta20: -1 }), 'eta20'],
        [() => gasState('custom', 300, { ...custom, omega: Infinity }), 'omega'], [() => gasState('custom', 300, { ...custom, gamma: 1 }), 'gamma'],
        [() => gasState('custom', 300, { ...custom, gamma: 1.68 }), 'gamma'], [() => gasState('custom', 300, { ...custom, Cd: 1.2 }), 'Cd'],
        [() => gasState('custom', 300, { ...custom, Cd: 'x' }), 'Cd'], [() => gasState('N2', 300, null, 0), 'Cd'], [() => gasState('N2', 300, null, 1.0001), 'Cd'],
        [() => gasState('N2', 300, null, NaN), 'Cd'],
    ];
    for (const [fn, field] of bad) {
        assert.throws(fn, (err) => err instanceof RangeError && err.field === field && /\.$/.test(err.message), `expected RangeError on ${field}`);
    }
    assert.doesNotThrow(() => gasState('He', 20));
    assert.doesNotThrow(() => gasState('custom', 3000, { ...custom, gamma: 1.67, Cd: 1 }));
});

test('temperatureWarning flags 200-600 K limits and waterSaturation follows Magnus', () => {
    assert.equal(GAS.temperatureWarning(199.9), 'temperature-range');
    assert.equal(GAS.temperatureWarning(200), null);
    assert.equal(GAS.temperatureWarning(600), null);
    assert.equal(GAS.temperatureWarning(600.1), 'temperature-range');
    assert.ok(Math.abs(GAS.waterSaturation(273.15) - 610.94) < 1e-9);
    // within 1 % of steam tables up to 60 °C (2339 Pa at 20 °C, 12352 Pa at 50 °C, 19946 Pa at 60 °C)
    for (const [t, p] of [[20, 2339.2], [50, 12352], [60, 19946]]) assert.ok(rel(GAS.waterSaturation(273.15 + t), p) < 0.01, `${t} °C`);
});
