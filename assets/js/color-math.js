/* ==========================================================================
   cdfoley.com — color-math.js
   Color-space conversions for the color tool. sRGB (IEC 61966-2-1) with a D65
   white point; CIE XYZ scaled so white Y = 1; CIELAB and LCh(ab) relative to
   D65 (2° observer); HSV, HSL, and CMYK as simple transforms of sRGB; color
   differences ΔE*ab (CIE 1976) and ΔE00 (CIEDE2000).
   ========================================================================== */
(function (root) {
    'use strict';
    var WHITE = [0.95047, 1.0, 1.08883];   // D65, 2°
    var M = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]];
    var MI = [[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]];
    function mul(m, v) { return [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]]; }
    function toLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    function toGamma(l) { var s = l < 0 ? -1 : 1; l = Math.abs(l); return s * (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055); }

    // sRGB components are 0–1 floats
    function rgbToXyz(rgb) { return mul(M, rgb.map(toLinear)); }
    function xyzToRgb(xyz) { return mul(MI, xyz).map(toGamma); }
    function inGamut(rgb, tol) { tol = tol || 1e-4; return rgb.every(function (c) { return c >= -tol && c <= 1 + tol; }); }
    function clip(rgb) { return rgb.map(function (c) { return Math.min(1, Math.max(0, c)); }); }

    var E = 216 / 24389, K = 24389 / 27;
    function f(t) { return t > E ? Math.cbrt(t) : (K * t + 16) / 116; }
    function finv(t) { var t3 = t * t * t; return t3 > E ? t3 : (116 * t - 16) / K; }
    function xyzToLab(xyz) {
        var fx = f(xyz[0] / WHITE[0]), fy = f(xyz[1] / WHITE[1]), fz = f(xyz[2] / WHITE[2]);
        return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
    }
    function labToXyz(lab) {
        var fy = (lab[0] + 16) / 116, fx = fy + lab[1] / 500, fz = fy - lab[2] / 200;
        return [WHITE[0] * finv(fx), WHITE[1] * (lab[0] > K * E ? fy * fy * fy : lab[0] / K), WHITE[2] * finv(fz)];
    }
    function labToLch(lab) { var h = Math.atan2(lab[2], lab[1]) * 180 / Math.PI; return [lab[0], Math.hypot(lab[1], lab[2]), h < 0 ? h + 360 : h]; }
    function lchToLab(lch) { var h = lch[2] * Math.PI / 180; return [lch[0], lch[1] * Math.cos(h), lch[1] * Math.sin(h)]; }
    function xyzToXyY(xyz) { var s = xyz[0] + xyz[1] + xyz[2]; return s > 0 ? [xyz[0] / s, xyz[1] / s, xyz[1]] : [0.3127, 0.3290, 0]; }
    function xyYToXyz(v) { return v[1] > 0 ? [v[0] * v[2] / v[1], v[2], (1 - v[0] - v[1]) * v[2] / v[1]] : [0, 0, 0]; }

    function rgbToHsv(rgb) {
        var r = rgb[0], g = rgb[1], b = rgb[2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
        if (d > 0) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h = h * 60; if (h < 0) h += 360;
        return [h, mx > 0 ? d / mx : 0, mx];
    }
    function hsvToRgb(hsv) {
        var h = ((hsv[0] % 360) + 360) % 360 / 60, s = hsv[1], v = hsv[2], c = v * s, x = c * (1 - Math.abs(h % 2 - 1)), m = v - c;
        var t = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
        return [t[0] + m, t[1] + m, t[2] + m];
    }
    function rgbToHsl(rgb) {
        var hsv = rgbToHsv(rgb), mx = Math.max.apply(null, rgb), mn = Math.min.apply(null, rgb), l = (mx + mn) / 2;
        var s = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
        return [hsv[0], s, l];
    }
    function hslToRgb(hsl) {
        var l = hsl[2], s = hsl[1], v = l + s * Math.min(l, 1 - l);
        return hsvToRgb([hsl[0], v > 0 ? 2 * (1 - l / v) : 0, v]);
    }
    function rgbToCmyk(rgb) {
        var k = 1 - Math.max.apply(null, rgb);
        if (k >= 1) return [0, 0, 0, 1];
        return [(1 - rgb[0] - k) / (1 - k), (1 - rgb[1] - k) / (1 - k), (1 - rgb[2] - k) / (1 - k), k];
    }
    function cmykToRgb(c) { return [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])]; }
    function rgbToHex(rgb) { return '#' + clip(rgb).map(function (c) { return ('0' + Math.round(c * 255).toString(16)).slice(-2); }).join('').toUpperCase(); }
    function hexToRgb(hex) {
        var h = String(hex).trim().replace(/^#/, '');
        if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map(function (c) { return c + c; }).join('');
        if (!/^[0-9a-f]{6}$/i.test(h)) return null;
        return [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16) / 255; });
    }

    function deltaE76(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
    // CIEDE2000 (Sharma, Wu & Dalal 2005), kL = kC = kH = 1
    function deltaE00(l1, l2) {
        var rad = Math.PI / 180, deg = 180 / Math.PI;
        var C1 = Math.hypot(l1[1], l1[2]), C2 = Math.hypot(l2[1], l2[2]), Cb = (C1 + C2) / 2;
        var G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
        var a1 = (1 + G) * l1[1], a2 = (1 + G) * l2[1];
        var c1 = Math.hypot(a1, l1[2]), c2 = Math.hypot(a2, l2[2]);
        var h1 = c1 === 0 ? 0 : (Math.atan2(l1[2], a1) * deg + 360) % 360, h2 = c2 === 0 ? 0 : (Math.atan2(l2[2], a2) * deg + 360) % 360;
        var dL = l2[0] - l1[0], dC = c2 - c1, dh = 0;
        if (c1 * c2 !== 0) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
        var dH = 2 * Math.sqrt(c1 * c2) * Math.sin(dh / 2 * rad);
        var Lb = (l1[0] + l2[0]) / 2, cb = (c1 + c2) / 2, hb = h1 + h2;
        if (c1 * c2 !== 0) { if (Math.abs(h1 - h2) <= 180) hb = (h1 + h2) / 2; else hb = (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2; }
        var T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.20 * Math.cos((4 * hb - 63) * rad);
        var dTh = 30 * Math.exp(-Math.pow((hb - 275) / 25, 2));
        var Rc = 2 * Math.sqrt(Math.pow(cb, 7) / (Math.pow(cb, 7) + Math.pow(25, 7)));
        var Sl = 1 + 0.015 * Math.pow(Lb - 50, 2) / Math.sqrt(20 + Math.pow(Lb - 50, 2)), Sc = 1 + 0.045 * cb, Sh = 1 + 0.015 * cb * T;
        var Rt = -Math.sin(2 * dTh * rad) * Rc;
        return Math.sqrt(Math.pow(dL / Sl, 2) + Math.pow(dC / Sc, 2) + Math.pow(dH / Sh, 2) + Rt * (dC / Sc) * (dH / Sh));
    }

    var api = { WHITE: WHITE, toLinear: toLinear, toGamma: toGamma, rgbToXyz: rgbToXyz, xyzToRgb: xyzToRgb, inGamut: inGamut, clip: clip,
        xyzToLab: xyzToLab, labToXyz: labToXyz, labToLch: labToLch, lchToLab: lchToLab, xyzToXyY: xyzToXyY, xyYToXyz: xyYToXyz,
        rgbToHsv: rgbToHsv, hsvToRgb: hsvToRgb, rgbToHsl: rgbToHsl, hslToRgb: hslToRgb, rgbToCmyk: rgbToCmyk, cmykToRgb: cmykToRgb,
        rgbToHex: rgbToHex, hexToRgb: hexToRgb, deltaE76: deltaE76, deltaE00: deltaE00 };
    root.ColorMath = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
