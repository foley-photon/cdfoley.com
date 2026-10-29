// Viridis colour scale and legend helpers for the CAD tab's pressure map (spec §4.5, §7.5). Pure: no DOM, no three.
// This is the one module allowed to hold colour literals (H10): viridis is the same in light and dark mode.
//
// The anchors are viridis (CC0, by Stéfan van der Walt and Nathaniel Smith) sampled at t = k/15 from matplotlib
// 3.10; between anchors the colour is interpolated linearly in sRGB.

export const VIRIDIS_ANCHORS = ['#440154', '#481a6c', '#472f7d', '#414487', '#39568c', '#31688e', '#2a788e', '#23888e',
                                '#1f988b', '#22a884', '#35b779', '#54c568', '#7ad151', '#a5db36', '#d2e21b', '#fde725'];

const N_SEG = VIRIDIS_ANCHORS.length - 1;          // 15 segments

/** '#rrggbb' or '#rgb' → [r, g, b] (0–255), or null when the text is not a hex colour. */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const ANCHORS = VIRIDIS_ANCHORS.map(hexToRgb);

/**
 * Viridis colour at t ∈ [0, 1] (clamped) as [r, g, b] with values 0–255 (not rounded, so the lightness rises
 * monotonically; 8-bit rounding would add steps of about 0.1 L*). t = k/15 returns anchor k exactly.
 * NaN gives [NaN, NaN, NaN].
 */
export function viridis(t) {
  if (Number.isNaN(t)) return [NaN, NaN, NaN];
  const x = Math.min(1, Math.max(0, t)) * N_SEG;
  let i = Math.floor(x);
  let f = x - i;
  // t = k/15 can land a hair below k after the multiplication; snap to the anchor
  if (f > 1 - 1e-9) { i += 1; f = 0; }
  if (f < 1e-9) f = 0;
  if (i >= N_SEG) return ANCHORS[N_SEG].slice();
  const a = ANCHORS[i], b = ANCHORS[i + 1];
  if (f === 0) return a.slice();
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * Log scale for p/p_in values (§4.5): min = 10^⌊log₁₀(smallest positive value)⌋ (never below `floor`), max = 1.
 * Each value maps to t = (log₁₀ v − log₁₀ min)/(log₁₀ max − log₁₀ min), clamped to [0, 1]; zeros and negative values
 * map to 0 (the bottom of the scale) and NaN or infinite values stay NaN (no data). With no positive finite value,
 * min and max are NaN, every t is NaN and there are no ticks. ticks are the decades from min to max.
 */
export function logScale(values, { floor = 1e-12 } = {}) {
  const n = values ? values.length : 0;
  const t = new Float32Array(n);
  const fl = floor > 0 && Number.isFinite(floor) ? floor : 1e-12;
  let lo = Infinity;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v > 0 && v < Infinity && v < lo) lo = v;
  }
  if (!(lo < Infinity)) {
    t.fill(NaN);
    return { t, min: NaN, max: NaN, ticks: [] };
  }
  const max = 1;
  let e = Math.floor(Math.log10(Math.max(lo, fl)) + 1e-9);
  if (e >= 0) e = -1;                                   // a single value at (or above) 1 still gets one decade
  const min = Number('1e' + e);                         // correctly rounded decade (10 ** −5 is not)
  const lmin = e, span = 0 - e;                         // log10(max) = 0
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isNaN(v) || v === Infinity || v === -Infinity) { t[i] = NaN; continue; }
    if (!(v > 0)) { t[i] = 0; continue; }
    const x = (Math.log10(v) - lmin) / span;
    t[i] = x < 0 ? 0 : x > 1 ? 1 : x;
  }
  return { t, min, max, ticks: decadeTicks(min, max) };
}

/** Decades 10^k with min ≤ 10^k ≤ max (min and max positive). */
export function decadeTicks(min, max) {
  if (!(min > 0) || !(max >= min)) return [];
  const out = [];
  const a = Math.ceil(Math.log10(min) - 1e-9), b = Math.floor(Math.log10(max) + 1e-9);
  for (let k = a; k <= b; k++) out.push(Number('1e' + k));
  return out;
}

/** Position of a value on a log legend bar running from min (0) to max (1). */
export function tickPosition(v, min, max) {
  if (!(v > 0 && min > 0 && max > min)) return NaN;
  return (Math.log10(v) - Math.log10(min)) / (Math.log10(max) - Math.log10(min));
}

const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };

/** A decade as legend text: 1 → '1', 0.1 → '0.1', 0.01 → '0.01', 1e-3 → '10⁻³'. */
export function formatDecade(v) {
  if (!(v > 0)) return '';
  const e = Math.round(Math.log10(v));
  if (e >= 0 && e <= 3) return String(10 ** e);
  if (e === -1) return '0.1';
  if (e === -2) return '0.01';
  return '10' + String(e).split('').map((c) => SUP[c] || c).join('');
}

/** CSS gradient of the colour bar, from t = 0 (left) to 1 (right). */
export function viridisGradient(direction = 'to right') {
  const stops = VIRIDIS_ANCHORS.map((c, k) => c + ' ' + (100 * k / N_SEG).toFixed(2) + '%');
  return 'linear-gradient(' + direction + ', ' + stops.join(', ') + ')';
}

/** Legend description of a log scale: { gradient, ticks: [{ value, pos, label }] } (pos 0–1 along the bar). */
export function legendTicks(scale) {
  if (!scale || !(scale.min > 0)) return { gradient: viridisGradient(), ticks: [] };
  return {
    gradient: viridisGradient(),
    ticks: scale.ticks.map((v) => ({ value: v, pos: tickPosition(v, scale.min, scale.max), label: formatDecade(v) })),
  };
}

const LIN = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/** sRGB component (0–1) → linear light (0–1), through the 8-bit table (exact for 8-bit colours). */
export function srgbToLinear(c) {
  if (!(c > 0)) return 0;
  if (c >= 1) return 1;
  return LIN[Math.round(c * 255)];
}

/**
 * Per-triangle sRGB colours (Float32Array 3·n, components 0–1) for a scale's t values; NaN t gives NaN colours
 * (drawn as "not enough hits" by the viewer).
 */
export function colorsFromT(t) {
  const n = t.length, out = new Float32Array(3 * n);
  const lut = new Float32Array(3 * 1024);
  for (let k = 0; k < 1024; k++) {
    const c = viridis(k / 1023);
    lut[3 * k] = c[0] / 255; lut[3 * k + 1] = c[1] / 255; lut[3 * k + 2] = c[2] / 255;
  }
  for (let i = 0; i < n; i++) {
    const v = t[i];
    if (Number.isNaN(v)) { out[3 * i] = NaN; out[3 * i + 1] = NaN; out[3 * i + 2] = NaN; continue; }
    const k = 3 * Math.round(Math.min(1, Math.max(0, v)) * 1023);
    out[3 * i] = lut[k]; out[3 * i + 1] = lut[k + 1]; out[3 * i + 2] = lut[k + 2];
  }
  return out;
}
