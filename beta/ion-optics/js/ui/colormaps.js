/* ==========================================================================
   Ion optics UI: colormaps.js
   Colour maps for the potential and field layers.
   - diverging: blue–white–red "cool to warm" map built by interpolation in
     Msh space, Moreland, "Diverging Color Maps for Scientific Visualization",
     ISVC 2009 (endpoints RGB (59, 76, 192) and (180, 4, 38)).
   - viridis: perceptually uniform sequential map by van der Walt & Smith
     (matplotlib, 2015; CC0), represented by its 11 published sample colours
     and interpolated linearly between them.
   - cividis: colour-vision-deficiency-friendly map, Nuñez, Anderton &
     Renslow, PLoS ONE 13, e0199239 (2018), 10 sample colours.
   - gray: linear grey ramp.
   Colour science: sRGB (IEC 61966-2-1) with D65 white, CIE 1976 L*a*b*.
   Pure module: no DOM, usable in Node tests.
   ========================================================================== */

/** Names in the order offered by the UI ('auto' picks diverging or viridis). */
export const COLORMAP_NAMES = Object.freeze(['diverging', 'viridis', 'cividis', 'gray']);

const STOPS = {
    viridis: ['440154', '482576', '414487', '35608d', '2a788e', '21908c', '22a884', '43bf71', '7ad151', 'bbdf27', 'fde725'],
    cividis: ['00204d', '00336f', '39486b', '575c6d', '707173', '8a8779', 'a69d75', 'c4b56c', 'e4cf5b', 'ffea46'],
    gray: ['141414', 'f2f2f2'],
};
const COOL = [59, 76, 192], WARM = [180, 4, 38];

// ---------------------------------------------------------------- colour science
const XN = 0.95047, YN = 1.0, ZN = 1.08883;
const D = 6 / 29;
function toLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function fromLinear(c) {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, v * 255));
}
function fLab(t) { return t > D * D * D ? Math.cbrt(t) : t / (3 * D * D) + 4 / 29; }
function fInv(t) { return t > D ? t * t * t : 3 * D * D * (t - 4 / 29); }

/** sRGB 0–255 → CIE L*a*b* (D65). */
export function rgbToLab(r, g, b) {
    const R = toLinear(r), G = toLinear(g), B = toLinear(b);
    const X = 0.4124564 * R + 0.3575761 * G + 0.1804375 * B;
    const Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
    const Z = 0.0193339 * R + 0.1191920 * G + 0.9503041 * B;
    const fx = fLab(X / XN), fy = fLab(Y / YN), fz = fLab(Z / ZN);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE L*a*b* (D65) → sRGB 0–255 (clamped, unrounded). */
export function labToRgb(L, a, b) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const X = XN * fInv(fx), Y = YN * fInv(fy), Z = ZN * fInv(fz);
    const R = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
    const G = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
    const B = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
    return [fromLinear(R), fromLinear(G), fromLinear(B)];
}

/** CIE L* (0–100) of an sRGB colour. */
export function lightness(r, g, b) { return rgbToLab(r, g, b)[0]; }

/** sRGB → Msh (Moreland 2009). */
export function rgbToMsh(r, g, b) {
    const [L, a, bb] = rgbToLab(r, g, b);
    const M = Math.sqrt(L * L + a * a + bb * bb);
    const s = M > 0 ? Math.acos(Math.max(-1, Math.min(1, L / M))) : 0;
    const hh = Math.atan2(bb, a);
    return [M, s, hh];
}

/** Msh → sRGB 0–255. */
export function mshToRgb(M, s, hh) {
    const L = M * Math.cos(s), a = M * Math.sin(s) * Math.cos(hh), b = M * Math.sin(s) * Math.sin(hh);
    return labToRgb(L, a, b);
}

function adjustHue(msh, mUnsat) {
    const [M, s, hh] = msh;
    if (M >= mUnsat) return hh;
    const spin = s * Math.sqrt(mUnsat * mUnsat - M * M) / (M * Math.sin(s));
    return hh > -Math.PI / 3 ? hh + spin : hh - spin;
}

/** Moreland's diverging interpolation between two sRGB colours, t in [0, 1]. */
export function divergingAt(rgb1, rgb2, t) {
    let m1 = rgbToMsh(...rgb1), m2 = rgbToMsh(...rgb2);
    let x = t;
    if (m1[1] > 0.05 && m2[1] > 0.05 && Math.abs(m1[2] - m2[2]) > Math.PI / 3) {
        const mMid = Math.max(m1[0], m2[0], 88);
        if (x < 0.5) { m2 = [mMid, 0, 0]; x = 2 * x; } else { m1 = [mMid, 0, 0]; x = 2 * x - 1; }
    }
    if (m1[1] < 0.05 && m2[1] > 0.05) m1 = [m1[0], m1[1], adjustHue(m2, m1[0])];
    else if (m2[1] < 0.05 && m1[1] > 0.05) m2 = [m2[0], m2[1], adjustHue(m1, m2[0])];
    const M = (1 - x) * m1[0] + x * m2[0], s = (1 - x) * m1[1] + x * m2[1], hh = (1 - x) * m1[2] + x * m2[2];
    return mshToRgb(M, s, hh);
}

function hex(s) { return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]; }

const LUTS = new Map();

/**
 * 256-entry lookup table (r, g, b triplets) of a colour map.
 * @param {string} name one of COLORMAP_NAMES
 * @returns {Uint8ClampedArray} length 768
 */
export function getLut(name) {
    const key = COLORMAP_NAMES.includes(name) ? name : 'viridis';
    let lut = LUTS.get(key);
    if (lut) return lut;
    lut = new Uint8ClampedArray(768);
    if (key === 'diverging') {
        for (let i = 0; i < 256; i++) {
            const c = i === 0 ? COOL : i === 255 ? WARM : divergingAt(COOL, WARM, i / 255);
            lut[3 * i] = Math.round(c[0]); lut[3 * i + 1] = Math.round(c[1]); lut[3 * i + 2] = Math.round(c[2]);
        }
    } else {
        const st = STOPS[key].map(hex), n = st.length - 1;
        for (let i = 0; i < 256; i++) {
            const x = (i / 255) * n, k = Math.min(n - 1, Math.floor(x)), f = x - k;
            for (let c = 0; c < 3; c++) lut[3 * i + c] = Math.round(st[k][c] + f * (st[k + 1][c] - st[k][c]));
        }
    }
    LUTS.set(key, lut);
    return lut;
}

/**
 * Unrounded colour at t ∈ [0, 1] (the definition the 256-entry table samples).
 * @returns {number[]} [r, g, b] in 0–255
 */
export function rgbAtExact(name, t) {
    const key = COLORMAP_NAMES.includes(name) ? name : 'viridis';
    const x = Math.max(0, Math.min(1, t));
    if (key === 'diverging') return x === 0 ? COOL.slice() : x === 1 ? WARM.slice() : divergingAt(COOL, WARM, x);
    const st = STOPS[key].map(hex), n = st.length - 1;
    const y = x * n, k = Math.min(n - 1, Math.floor(y)), f = y - k;
    return [0, 1, 2].map((c) => st[k][c] + f * (st[k + 1][c] - st[k][c]));
}

/** Colour at t ∈ [0, 1] (clamped; NaN → middle). */
export function rgbAt(name, t) {
    const lut = getLut(name);
    const i = t !== t ? 128 : Math.max(0, Math.min(255, Math.round(t * 255)));
    return [lut[3 * i], lut[3 * i + 1], lut[3 * i + 2]];
}

/** CSS rgb() string. */
export function cssRgb(rgb, alpha = 1) {
    const [r, g, b] = rgb.map((v) => Math.round(v));
    return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Resolves the view setting ('auto' or a name) for a potential range: diverging centred on 0 V
 * when the range spans both signs, viridis otherwise.
 */
export function chooseMap(setting, vmin, vmax) {
    if (setting && setting !== 'auto' && COLORMAP_NAMES.includes(setting)) return setting;
    return vmin < 0 && vmax > 0 ? 'diverging' : 'viridis';
}

/**
 * Maps values to t ∈ [0, 1]. The diverging map is symmetric about 0 (0 V → white middle);
 * the others map [vmin, vmax] linearly.
 * @returns {{ name: string, lo: number, hi: number, t: (v: number) => number }}
 */
export function normalizer(name, vmin, vmax) {
    let lo = vmin, hi = vmax;
    if (name === 'diverging') { const a = Math.max(Math.abs(vmin), Math.abs(vmax)) || 1; lo = -a; hi = a; }
    if (!(hi > lo)) { lo -= 0.5; hi += 0.5; }
    const span = hi - lo;
    return { name, lo, hi, t: (v) => (v - lo) / span };
}

/** Five evenly spaced legend stops: [{ t, value, rgb }]. */
export function legendStops(name, lo, hi, n = 5) {
    const out = [];
    for (let i = 0; i < n; i++) { const t = i / (n - 1); out.push({ t, value: lo + t * (hi - lo), rgb: rgbAt(name, t) }); }
    return out;
}
