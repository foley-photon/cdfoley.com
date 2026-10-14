// WP4 units: parsing and formatting of values with units round-trip (spec §2.1.1, §4.3 "2 kV").
import { test } from 'node:test';
import assert from 'node:assert/strict';

const U = await import('../../beta/ion-optics/js/ui/units.js');

test('engine units per dimension (spec §2.1.1)', () => {
    const want = { length: 'mm', voltage: 'V', energy: 'eV', mass: 'u', charge: 'e', angle: '°', time: 'µs', freq: 'MHz', field: 'V/mm', flux: 'T', current: 'A', none: '' };
    for (const [d, u] of Object.entries(want)) assert.equal(U.unitOf(d), u, d);
    assert.equal(U.dimOf('efield'), 'field');
    assert.equal(U.dimOf('B'), 'flux');
    assert.equal(U.dimOf('frequency'), 'freq');
    assert.equal(U.dimOf('unknown-dim'), 'none');
});

test('numbers with units parse to engine units', () => {
    const cases = [
        ['2 kV', 'voltage', 2000], ['2kV', 'voltage', 2000], ['-850', 'voltage', -850], ['−850 V', 'voltage', -850], ['1.5 MV', 'voltage', 1.5e6], ['250 mV', 'voltage', 0.25],
        ['0.5mm', 'length', 0.5], ['3 cm', 'length', 30], ['2 m', 'length', 2000], ['25 µm', 'length', 0.025], ['25 um', 'length', 0.025], ['1 in', 'length', 25.4],
        ['1 keV', 'energy', 1000], ['10 meV', 'energy', 0.01], ['100', 'energy', 100],
        ['1 mT', 'flux', 1e-3], ['5 G', 'flux', 5e-4], ['0.5 T', 'flux', 0.5],
        ['1 kV/mm', 'field', 1000], ['100 V/cm', 'field', 10], ['1 MV/m', 'field', 1000],
        ['1.1 MHz', 'freq', 1.1], ['500 kHz', 'freq', 0.5], ['2 GHz', 'freq', 2000],
        ['3 ns', 'time', 0.003], ['2 ms', 'time', 2000], ['1e-2 s', 'time', 1e4],
        ['90 deg', 'angle', 90], ['1 mrad', 'angle', 0.18 / Math.PI], ['3 kDa', 'mass', 3000], ['2 mA', 'current', 0.002], ['50 %', 'none', 0.5],
        ['1e3', 'none', 1000], ['.25', 'length', 0.25], ['+4', 'length', 4],
    ];
    for (const [text, dim, v] of cases) {
        const q = U.parseQuantity(text, dim);
        assert.equal(q.kind, 'number', `${text} (${dim})`);
        assert.ok(Math.abs(q.value - v) <= 1e-12 * Math.max(1, Math.abs(v)), `${text} → ${q.value}, want ${v}`);
    }
    // 2.1 kV is exactly 2100 (binary noise removed)
    assert.equal(U.parseQuantity('2.1 kV', 'voltage').value, 2100);
    assert.equal(U.parseQuantity('0.3 cm', 'length').value, 3);
});

test('expressions are recognised, errors are explained', () => {
    for (const s of ['D/2+1', '-0.3*D', 'Vc', 'sqrt(2)*D', '(D)', '2*D', '10 - D', 'pi*r^2']) assert.equal(U.parseQuantity(s, 'length').kind, 'expr', s);
    assert.equal(U.isExpressionText('2*Vc', 'voltage'), true);
    assert.equal(U.isExpressionText('2 kV', 'voltage'), false);
    const bad = U.parseQuantity('5 parsecs', 'length');
    assert.equal(bad.kind, 'error');
    assert.match(bad.message, /Unknown unit/);
    assert.equal(U.parseQuantity('', 'length').kind, 'empty');
    assert.equal(U.parseQuantity('3 kV', 'length').kind, 'error', 'a voltage unit is not a length unit');
    // milli/mega must not be confused when the case is wrong
    assert.equal(U.unitFactor('voltage', 'mV'), 1e-3);
    assert.equal(U.unitFactor('voltage', 'MV'), 1e6);
    assert.equal(U.unitFactor('voltage', 'mv'), null);
    assert.equal(U.unitFactor('voltage', 'kv'), 1e3);
});

test('format → parse round trips in every unit of every dimension', () => {
    const vals = [0, 1, -1, 0.001234567891, 12.5, -850, 2100, 3.14159265358979, 1e-9, 6.02e23, -4.4e-7];
    for (const dim of Object.keys(U.DIMS)) {
        for (const unit of U.unitsOf(dim)) {
            for (const v of vals) {
                const text = U.formatQuantity(v, dim, { unit });
                const q = U.parseQuantity(text, dim);
                assert.equal(q.kind, 'number', `${dim} ${unit}: "${text}"`);
                assert.ok(Math.abs(q.value - v) <= 1e-11 * Math.max(Math.abs(v), 1e-300), `${dim} ${unit}: ${v} → "${text}" → ${q.value}`);
            }
        }
    }
});

test('formatNumber gives the shortest text that parses back (12 significant digits)', () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let k = 0; k < 2000; k++) {
        const v = (rnd() - 0.5) * Math.pow(10, Math.floor(rnd() * 24) - 12);
        const s = U.formatNumber(v);
        const back = Number(s);
        assert.ok(Math.abs(back - v) <= 5e-12 * Math.abs(v) + 1e-300, `${v} → ${s}`);
    }
    assert.equal(U.formatNumber(0.1 + 0.2), '0.3');
    assert.equal(U.formatNumber(-0), '0');
    assert.equal(U.formatNumber(-2.5, { display: true }), '−2.5');
});

test('pretty read-outs choose a prefix', () => {
    assert.equal(U.formatPretty(2000, 'voltage'), '2 kV');
    assert.equal(U.formatPretty(-0.25, 'voltage'), '−250 mV');
    assert.equal(U.formatPretty(0.5, 'length'), '500 µm');
    assert.equal(U.formatPretty(1500, 'length'), '1.5 m');
    assert.equal(U.formatPretty(0.0012, 'flux'), '1.2 mT');
    assert.equal(U.formatPretty(31.9, 'time'), '31.9 µs');
    assert.equal(U.formatPretty(0.45528, 'time', 4), '455.3 ns');
    assert.equal(U.formatPretty(76.78e-3, 'freq'), '76.78 kHz');
    assert.equal(U.formatPretty(NaN, 'voltage'), '—');
    assert.equal(U.convert(1, 'kV', 'V', 'voltage'), 1000);
    assert.ok(Number.isNaN(U.convert(1, 'kV', 'mm', 'voltage')));
});
