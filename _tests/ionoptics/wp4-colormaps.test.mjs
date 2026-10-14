// WP4 colour maps: published endpoints, monotonic lightness for the sequential maps, a light neutral centre for
// the diverging map, and the automatic choice (diverging centred on 0 V when the potential spans both signs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CM = await import('../../beta/ion-optics/js/ui/colormaps.js');

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const at = (lut, i) => [lut[3 * i], lut[3 * i + 1], lut[3 * i + 2]];

test('endpoints of every map', () => {
    assert.deepEqual(at(CM.getLut('viridis'), 0), hex('#440154'));
    assert.deepEqual(at(CM.getLut('viridis'), 255), hex('#fde725'));
    assert.deepEqual(at(CM.getLut('cividis'), 0), hex('#00204d'));
    assert.deepEqual(at(CM.getLut('cividis'), 255), hex('#ffea46'));
    assert.deepEqual(at(CM.getLut('diverging'), 0), [59, 76, 192]);
    assert.deepEqual(at(CM.getLut('diverging'), 255), [180, 4, 38]);
    assert.deepEqual(at(CM.getLut('gray'), 0), hex('#141414'));
    assert.deepEqual(at(CM.getLut('gray'), 255), hex('#f2f2f2'));
    for (const name of CM.COLORMAP_NAMES) assert.equal(CM.getLut(name).length, 768);
});

test('sequential maps have monotonically increasing lightness', () => {
    for (const name of ['viridis', 'cividis', 'gray']) {
        let prev = -Infinity, minStep = Infinity;
        for (let i = 0; i <= 1000; i++) {
            const L = CM.lightness(...CM.rgbAtExact(name, i / 1000));
            assert.ok(L > prev, `${name}: L* not increasing at t = ${i / 1000} (${prev} → ${L})`);
            minStep = Math.min(minStep, L - prev);
            prev = L;
        }
        assert.ok(minStep > 0, name);
        // the 256-entry table (rounded to bytes) never decreases by more than rounding
        const lut = CM.getLut(name);
        for (let i = 1; i < 256; i++) assert.ok(CM.lightness(...at(lut, i)) >= CM.lightness(...at(lut, i - 1)) - 0.3, `${name} table at ${i}`);
    }
});

test('the diverging map rises to a light neutral centre and falls again (Moreland 2009)', () => {
    const Ls = [];
    for (let i = 0; i <= 200; i++) Ls.push(CM.lightness(...CM.rgbAtExact('diverging', i / 200)));
    const k = Ls.indexOf(Math.max(...Ls));
    assert.ok(Math.abs(k - 100) <= 2, `peak at ${k / 200}`);
    for (let i = 1; i <= k; i++) assert.ok(Ls[i] >= Ls[i - 1] - 1e-9, `rising at ${i}`);
    for (let i = k + 1; i <= 200; i++) assert.ok(Ls[i] <= Ls[i - 1] + 1e-9, `falling at ${i}`);
    const mid = CM.rgbAtExact('diverging', 0.5);
    const [L, a, b] = CM.rgbToLab(...mid);
    assert.ok(L > 85, `centre lightness ${L}`);
    assert.ok(Math.hypot(a, b) < 6, `centre chroma ${Math.hypot(a, b)}`);
});

test('Lab and Msh conversions round-trip (7-digit sRGB matrices: within 0.001 of a level)', () => {
    for (const rgb of [[0, 0, 0], [255, 255, 255], [59, 76, 192], [180, 4, 38], [12, 200, 99], [250, 128, 3]]) {
        const lab = CM.rgbToLab(...rgb);
        const back = CM.labToRgb(...lab);
        for (let c = 0; c < 3; c++) assert.ok(Math.abs(back[c] - rgb[c]) < 1e-3, `${rgb} via Lab: ${back}`);
        const msh = CM.rgbToMsh(...rgb);
        const b2 = CM.mshToRgb(...msh);
        for (let c = 0; c < 3; c++) assert.ok(Math.abs(b2[c] - rgb[c]) < 1e-3, `${rgb} via Msh: ${b2}`);
    }
});

test('automatic map choice and normalisation', () => {
    assert.equal(CM.chooseMap('auto', -100, 850), 'diverging');
    assert.equal(CM.chooseMap('auto', 0, 850), 'viridis');
    assert.equal(CM.chooseMap('auto', -2000, 0), 'viridis');
    assert.equal(CM.chooseMap('cividis', -1, 1), 'cividis');
    const d = CM.normalizer('diverging', -100, 850);
    assert.equal(d.lo, -850); assert.equal(d.hi, 850);
    assert.equal(d.t(0), 0.5, '0 V maps to the white centre');
    const v = CM.normalizer('viridis', 0, 850);
    assert.equal(v.t(0), 0); assert.equal(v.t(850), 1);
    const flat = CM.normalizer('viridis', 5, 5);
    assert.ok(flat.hi > flat.lo);
    const stops = CM.legendStops('viridis', 0, 10);
    assert.equal(stops.length, 5);
    assert.equal(stops[4].value, 10);
    assert.deepEqual(CM.rgbAt('viridis', NaN), at(CM.getLut('viridis'), 128));
    assert.equal(CM.cssRgb([1.2, 2.6, 3], 0.5), 'rgba(1, 3, 3, 0.5)');
});
