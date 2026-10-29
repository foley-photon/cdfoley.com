// WP4 acceptance 1 (spec §7.5): colormap.js — the 16 viridis anchors exactly at t = k/15, monotone lightness,
// logScale with zeros, NaN and single values, decade ticks, and the legend helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIRIDIS_ANCHORS, viridis, logScale, decadeTicks, tickPosition, formatDecade, viridisGradient, legendTicks,
  srgbToLinear, colorsFromT, hexToRgb,
} from '../../beta/conductance/js/ui/colormap.js';

// CIE L* of an sRGB colour (D65), for the lightness test
function lightness([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const Y = 0.2126729 * lin(r) + 0.7151522 * lin(g) + 0.0721750 * lin(b);
  return Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y;
}

test('viridis reproduces the 16 anchors exactly at t = k/15', () => {
  assert.equal(VIRIDIS_ANCHORS.length, 16);
  for (let k = 0; k < 16; k++) {
    assert.deepEqual(viridis(k / 15), hexToRgb(VIRIDIS_ANCHORS[k]), 'anchor ' + k);
  }
  assert.deepEqual(viridis(0), [0x44, 0x01, 0x54]);
  assert.deepEqual(viridis(1), [0xfd, 0xe7, 0x25]);
});

test('viridis clamps, interpolates linearly in sRGB and returns values in 0–255', () => {
  assert.deepEqual(viridis(-3), viridis(0));
  assert.deepEqual(viridis(7), viridis(1));
  const a = hexToRgb(VIRIDIS_ANCHORS[3]), b = hexToRgb(VIRIDIS_ANCHORS[4]);
  const mid = viridis(3.5 / 15);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(mid[i] - (a[i] + b[i]) / 2) <= 1e-9);
  for (let i = 0; i <= 1000; i++) {
    const c = viridis(i / 1000);
    for (const v of c) assert.ok(Number.isFinite(v) && v >= 0 && v <= 255);
  }
  assert.ok(viridis(NaN).every(Number.isNaN));
});

test('viridis is monotone in lightness (CIE L*)', () => {
  let prev = -Infinity;
  for (let i = 0; i <= 3000; i++) {
    const L = lightness(viridis(i / 3000));
    assert.ok(L > prev, 'L* does not rise at t = ' + i / 3000 + ': ' + prev + ' → ' + L);
    prev = L;
  }
  // and strictly increasing from anchor to anchor
  for (let k = 1; k < 16; k++) assert.ok(lightness(hexToRgb(VIRIDIS_ANCHORS[k])) > lightness(hexToRgb(VIRIDIS_ANCHORS[k - 1])));
});

test('logScale: min is the decade below the smallest value, max is 1, t is linear in log10', () => {
  const s = logScale([0.5, 0.02, 0.9, 1]);
  assert.equal(s.min, 0.01);
  assert.equal(s.max, 1);
  assert.deepEqual(s.ticks, [0.01, 0.1, 1]);
  const expect = (v) => (Math.log10(v) + 2) / 2;
  assert.ok(Math.abs(s.t[0] - expect(0.5)) < 1e-6);
  assert.ok(Math.abs(s.t[1] - expect(0.02)) < 1e-6);
  assert.equal(s.t[3], 1);
  assert.ok(s.t instanceof Float32Array);
});

test('logScale handles zeros, NaN, infinities, values above 1 and an exact decade', () => {
  const s = logScale([0, NaN, 0.001, 3, Infinity, -2]);
  assert.equal(s.min, 0.001);
  assert.equal(s.t[0], 0);                 // zero clamps to the bottom
  assert.ok(Number.isNaN(s.t[1]));         // NaN stays "no data"
  assert.equal(s.t[2], 0);                 // an exact decade sits at the bottom of its own decade
  assert.equal(s.t[3], 1);                 // above 1 clamps to the top
  assert.ok(Number.isNaN(s.t[4]));
  assert.equal(s.t[5], 0);
  assert.deepEqual(s.ticks, [0.001, 0.01, 0.1, 1]);
});

test('logScale with a single value, with all zeros and with no data', () => {
  const one = logScale([0.37]);
  assert.equal(one.min, 0.1);
  assert.equal(one.max, 1);
  assert.ok(Math.abs(one.t[0] - (Math.log10(0.37) + 1)) < 1e-6);
  const unity = logScale([1, 1, 1]);
  assert.equal(unity.min, 0.1);
  assert.deepEqual(Array.from(unity.t), [1, 1, 1]);
  const zeros = logScale([0, 0]);
  assert.ok(Number.isNaN(zeros.min));
  assert.deepEqual(zeros.ticks, []);
  assert.ok(Array.from(zeros.t).every(Number.isNaN));
  const empty = logScale([]);
  assert.equal(empty.t.length, 0);
  assert.deepEqual(empty.ticks, []);
  const floored = logScale([1e-15, 0.5], { floor: 1e-6 });
  assert.equal(floored.min, 1e-6);
  assert.equal(floored.t[0], 0);
});

test('legend ticks are decades', () => {
  const s = logScale([3.2e-5, 0.4]);
  assert.equal(s.min, 1e-5);
  assert.deepEqual(s.ticks, [1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1]);
  for (const t of s.ticks) assert.equal(Math.log10(t), Math.round(Math.log10(t)));
  assert.deepEqual(decadeTicks(0.003, 1), [0.01, 0.1, 1]);
  assert.deepEqual(decadeTicks(1e-7, 1e-7), [1e-7]);
  assert.deepEqual(decadeTicks(0, 1), []);
  const lg = legendTicks(s);
  assert.equal(lg.ticks.length, 6);
  assert.equal(lg.ticks[0].pos, 0);
  assert.equal(lg.ticks[5].pos, 1);
  assert.ok(Math.abs(lg.ticks[2].pos - 0.4) < 1e-12);
  assert.deepEqual(lg.ticks.map((t) => t.label), ['10⁻⁵', '10⁻⁴', '10⁻³', '0.01', '0.1', '1']);
  assert.equal(legendTicks(null).ticks.length, 0);
});

test('formatDecade, tickPosition, gradient and colour helpers', () => {
  assert.equal(formatDecade(1), '1');
  assert.equal(formatDecade(0.1), '0.1');
  assert.equal(formatDecade(1e-12), '10⁻¹²');
  assert.equal(formatDecade(1000), '1000');
  assert.equal(formatDecade(0), '');
  assert.ok(Math.abs(tickPosition(0.1, 0.001, 1) - 2 / 3) < 1e-12);
  assert.ok(Number.isNaN(tickPosition(0, 0.001, 1)));
  const g = viridisGradient();
  assert.ok(g.startsWith('linear-gradient(to right, #440154 0.00%'));
  assert.ok(g.includes('#fde725 100.00%'));
  for (const c of VIRIDIS_ANCHORS) assert.ok(g.includes(c));
  assert.equal(srgbToLinear(0), 0);
  assert.equal(srgbToLinear(1), 1);
  assert.ok(Math.abs(srgbToLinear(0.5) - 0.2140) < 2e-3);
  const rgb = colorsFromT(Float32Array.from([0, 1, NaN]));
  assert.deepEqual(Array.from(rgb.slice(0, 3), (x) => Math.round(x * 255)), [0x44, 0x01, 0x54]);
  assert.deepEqual(Array.from(rgb.slice(3, 6), (x) => Math.round(x * 255)), [0xfd, 0xe7, 0x25]);
  assert.ok(Number.isNaN(rgb[6]));
  assert.equal(hexToRgb('#abc').join(), '170,187,204');
  assert.equal(hexToRgb('nope'), null);
});
