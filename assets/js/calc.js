/* ==========================================================================
   cdfoley.com — calc.js
   A small framework for live calculators. See tools/energy-converter and
   tools/focused-spot for reference usage.

   Markup conventions
   ------------------
   <form id="calc">                                   any element works as root
     <div class="field">
       <label for="wl">Wavelength <span class="sym">λ</span></label>
       <div class="input-unit">
         <input id="wl" name="wl" value="1064" inputmode="decimal">
         <select data-dim="length" data-units="nm,µm" data-default="nm"></select>
       </div>
     </div>
     <input name="m2" value="1.1" data-positive>       unitless (SI value = typed value)
     <input name="opt" data-optional>                    may be blank → NaN
     <select name="mode">…</select>                       plain select → string
   </form>
   <output data-out="w0"></output>                      filled from compute()'s return

   Calc.create({ form: '#calc', compute(v) { … return { w0: Calc.fmt.si(w0, 'm') }; }, after(v, r) {} })
     v.<name> is the SI value of each numeric input (unit select applied),
     the string value of selects/radios, or a boolean for checkboxes.
     Throw Calc.fail('message', 'fieldName') to show an inline error.
     Return null for an output to hide its .result row; a string sets text;
     a number is formatted with fmt.num; { html: '…' } sets innerHTML.
   ========================================================================== */
(function () {
    'use strict';

    /* ── Physical constants (CODATA 2022; SI-exact where defined) ───────── */
    var K = {
        c: 299792458,                  // m/s
        h: 6.62607015e-34,             // J·s
        hbar: 6.62607015e-34 / (2 * Math.PI),
        e: 1.602176634e-19,            // C
        kB: 1.380649e-23,              // J/K
        NA: 6.02214076e23,             // 1/mol
        R: 8.314462618,                // J/(mol·K)
        sigma: 5.670374419e-8,         // W/(m²·K⁴)
        wien: 2.897771955e-3,          // m·K
        Eh: 4.3597447222060e-18,       // J (Hartree)
        Rinf: 10973731.568157,         // 1/m
        u: 1.66053906892e-27,          // kg (atomic mass unit)
        me: 9.1093837139e-31,          // kg
        eps0: 8.8541878188e-12,        // F/m
        a0: 5.29177210544e-11,         // m (Bohr radius)
        cal: 4.184,                    // J (thermochemical calorie)
        atm: 101325,                   // Pa
        torr: 101325 / 760             // Pa
    };

    /* ── Units: factor to SI ────────────────────────────────────────────── */
    var UNITS = {
        length:      { 'pm': 1e-12, 'Å': 1e-10, 'nm': 1e-9, 'µm': 1e-6, 'mm': 1e-3, 'cm': 1e-2, 'm': 1, 'km': 1e3, 'in': 0.0254, 'mil': 2.54e-5, 'ft': 0.3048 },
        area:        { 'µm²': 1e-12, 'mm²': 1e-6, 'cm²': 1e-4, 'm²': 1, 'in²': 6.4516e-4 },
        volume:      { 'cm³': 1e-6, 'mL': 1e-6, 'L': 1e-3, 'm³': 1, 'in³': 1.6387064e-5, 'ft³': 0.028316846592 },
        time:        { 'fs': 1e-15, 'ps': 1e-12, 'ns': 1e-9, 'µs': 1e-6, 'ms': 1e-3, 's': 1, 'min': 60, 'h': 3600 },
        frequency:   { 'Hz': 1, 'kHz': 1e3, 'MHz': 1e6, 'GHz': 1e9, 'THz': 1e12 },
        power:       { 'nW': 1e-9, 'µW': 1e-6, 'mW': 1e-3, 'W': 1, 'kW': 1e3, 'MW': 1e6, 'GW': 1e9 },
        energy:      { 'fJ': 1e-15, 'pJ': 1e-12, 'nJ': 1e-9, 'µJ': 1e-6, 'mJ': 1e-3, 'J': 1 },
        angle:       { 'µrad': 1e-6, 'mrad': 1e-3, 'rad': 1, 'deg': Math.PI / 180, 'arcmin': Math.PI / 10800, 'arcsec': Math.PI / 648000 },
        speed:       { 'µm/s': 1e-6, 'mm/s': 1e-3, 'cm/s': 1e-2, 'm/s': 1, 'mm/min': 1e-3 / 60, 'm/min': 1 / 60, 'in/s': 0.0254, 'ft/min': 0.3048 / 60 },
        pressure:    { 'Pa': 1, 'kPa': 1e3, 'MPa': 1e6, 'mbar': 100, 'bar': 1e5, 'µbar': 0.1, 'Torr': K.torr, 'mTorr': K.torr / 1000, 'atm': K.atm, 'psi': 6894.757293168, 'inHg': 25.4 * 133.322387415 },
        fluence:     { 'J/m²': 1, 'mJ/cm²': 10, 'J/cm²': 1e4 },
        irradiance:  { 'W/m²': 1, 'W/cm²': 1e4, 'kW/cm²': 1e7, 'MW/cm²': 1e10, 'GW/cm²': 1e13, 'TW/cm²': 1e16 },
        throughput:  { 'L/s': 1e-3, 'm³/h': 1 / 3600, 'm³/s': 1, 'L/min': 1e-3 / 60, 'cfm': 4.719474432e-4 },
        outgassing:  { 'mbar·L/(s·cm²)': 1000, 'Torr·L/(s·cm²)': 10 * K.torr, 'Pa·m/s': 1 },
        diffusivity: { 'mm²/s': 1e-6, 'cm²/s': 1e-4, 'm²/s': 1 },
        mass:        { 'u': K.u, 'g': 1e-3, 'kg': 1 },
        temperature: { 'K': 1, '°C': 1, '°F': 1 },        // handled specially below
        ratio:       { '': 1, '%': 0.01, 'ppm': 1e-6 }
    };

    function toSI(dim, unit, x) {
        if (dim === 'temperature') {
            if (unit === '°C') return x + 273.15;
            if (unit === '°F') return (x - 32) * 5 / 9 + 273.15;
            return x;
        }
        var f = UNITS[dim] && UNITS[dim][unit];
        if (f === undefined) throw new Error('Unknown unit ' + unit + ' for ' + dim);
        return x * f;
    }
    function fromSI(dim, unit, x) {
        if (dim === 'temperature') {
            if (unit === '°C') return x - 273.15;
            if (unit === '°F') return (x - 273.15) * 9 / 5 + 32;
            return x;
        }
        return x / UNITS[dim][unit];
    }

    /* ── Number parsing & formatting ────────────────────────────────────── */
    // one comma followed by exactly three digits ("1,064", "-12,500") reads as thousands or as decimals
    var AMBIGUOUS_COMMA = /^[-+]?[1-9]\d{0,2},\d{3}([eE][-+]?\d+)?$/;
    var SUPD = { '⁻': '-', '⁺': '+', '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
    function normNum(s) {
        // "2,5 × 10^-3" → "2,5e-3" (before the comma rules, so a decimal comma works with ×10ⁿ too); a copied result
        // ("1.234 × 10⁻⁵", as fmt.sci writes it) has a superscript exponent, so that form is accepted too
        return String(s).trim().replace(/[−‒–]/g, '-').replace(/\s+/g, '')
            .replace(/[×x*]10([⁻⁺⁰¹²³⁴⁵⁶⁷⁸⁹]+)$/, function (m, e) { return 'e' + e.split('').map(function (c) { return SUPD[c]; }).join(''); })
            .replace(/[×x*]10\^?([-+]?\d+)$/i, 'e$1');
    }
    function parseNum(s) {
        if (s === null || s === undefined) return NaN;
        s = normNum(s);
        if (!s) return NaN;
        if (s.indexOf(',') !== -1) {
            // "1,234,567" / "1,234.5" → thousands separators; "1,5" / "0,532" / "1,0645" → decimal comma;
            // "1,064" is ambiguous and, like anything else, is rejected rather than guessed (see commaReadings)
            if (AMBIGUOUS_COMMA.test(s)) return NaN;
            if (/^[-+]?[1-9]\d{0,2}(,\d{3})+(\.\d*)?([eE][-+]?\d+)?$/.test(s)) s = s.replace(/,/g, '');
            else if (/^[-+]?\d*,\d+([eE][-+]?\d+)?$/.test(s)) s = s.replace(',', '.');
            else return NaN;
        }
        s = s.replace(/E/g, 'e');
        if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(s)) return NaN;
        return parseFloat(s);
    }
    // the readings of an ambiguous comma, for error messages: "1,064" → "1064 or 1.064 (decimal comma: 1,0640)",
    // since a decimal keypad in a comma locale has no "." key (otherwise null)
    function commaReadings(s) {
        s = normNum(s === null || s === undefined ? '' : s);
        if (!AMBIGUOUS_COMMA.test(s)) return null;
        var m = s.match(/^([^eE]*)(.*)$/);
        return s.replace(',', '') + ' or ' + s.replace(',', '.') + ' (decimal comma: ' + m[1] + '0' + m[2] + ')';
    }

    var SUP = { '-': '⁻', '+': '', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
    function sup(n) { return String(n).split('').map(function (c) { return SUP[c] !== undefined ? SUP[c] : c; }).join(''); }

    function roundSig(x, sig) {
        if (x === 0 || !isFinite(x)) return x;
        return parseFloat(x.toPrecision(sig));
    }
    function trimNum(str) {
        // "1.2300" → "1.23", "5.000" → "5"
        if (str.indexOf('.') === -1) return str;
        return str.replace(/\.?0+$/, '');
    }
    // plain decimal for moderate magnitudes; sig significant figures
    function plainDecimal(x, sig) {
        var r = roundSig(x, sig);
        var mag = Math.floor(Math.log10(Math.abs(r)));
        var decimals = Math.max(0, sig - 1 - mag);
        return trimNum(r.toFixed(Math.min(decimals, 20)));
    }

    var fmt = {
        // 1234.5 / 0.01234 / 1.234 × 10⁻⁵
        num: function (x, sig) {
            sig = sig || 4;
            if (typeof x !== 'number' || isNaN(x)) return '—';
            if (!isFinite(x)) return x > 0 ? '∞' : '−∞';
            if (x === 0) return '0';
            var a = Math.abs(x);
            var out = (a >= 1e-3 && a < 1e5) ? plainDecimal(x, sig) : fmt.sci(x, sig);
            return out.replace(/^-/, '−');
        },
        // always scientific: 1.234 × 10⁸ (falls back to plain for 10⁰…10²)
        sci: function (x, sig) {
            sig = sig || 4;
            if (typeof x !== 'number' || isNaN(x)) return '—';
            if (!isFinite(x)) return x > 0 ? '∞' : '−∞';
            if (x === 0) return '0';
            var s = x.toExponential(sig - 1).split('e');
            var m = trimNum(s[0]), e = parseInt(s[1], 10);
            if (e >= 0 && e <= 2) return plainDecimal(x, sig).replace(/^-/, '−');
            return (m.replace(/^-/, '−')) + '\u00a0×\u00a010' + sup(e);   // no-break spaces: a narrow result never wraps inside the number
        },
        // SI prefix: fmt.si(2.5e-6, 'm') → "2.5 µm"
        si: function (x, unit, sig, opts) {
            sig = sig || 4; opts = opts || {};
            if (typeof x !== 'number' || isNaN(x)) return '—';
            if (!isFinite(x)) return (x > 0 ? '∞ ' : '−∞ ') + unit;
            if (x === 0) return '0 ' + unit;
            var P = { '-18': 'a', '-15': 'f', '-12': 'p', '-9': 'n', '-6': 'µ', '-3': 'm', '0': '', '3': 'k', '6': 'M', '9': 'G', '12': 'T', '15': 'P' };
            var lo = opts.min !== undefined ? opts.min : -15, hi = opts.max !== undefined ? opts.max : 15;
            var e3 = Math.floor(Math.log10(Math.abs(x)) / 3) * 3;
            e3 = Math.max(lo, Math.min(hi, e3));
            var m = roundSig(x / Math.pow(10, e3), sig);
            if (Math.abs(m) >= 1000 && e3 + 3 <= hi) { e3 += 3; m = roundSig(x / Math.pow(10, e3), sig); }
            // beyond the prefix range (the clamp left a mantissa outside 0.001…99999) plain scientific notation
            // reads better than "5 × 10⁵ PW"
            if (Math.abs(m) < 1e-3 || Math.abs(m) >= 1e5) return fmt.sci(x, sig) + ' ' + unit;
            return plainDecimal(m, sig).replace(/^-/, '−') + ' ' + P[String(e3)] + unit;
        },
        // value in a specific unit of a dimension: fmt.unit(0.0021, 'length', 'mm') → "2.1 mm"
        unit: function (x, dim, unit, sig) { return fmt.num(fromSI(dim, unit, x), sig) + (unit ? ' ' + unit : ''); },
        pct: function (frac, sig) { return fmt.num(frac * 100, sig || 4) + ' %'; },
        // editable ASCII form for converter inputs: 1064, 0.0012, 1.1654e-19
        plain: function (x, sig) {
            sig = sig || 6;
            if (typeof x !== 'number' || !isFinite(x)) return '';
            if (x === 0) return '0';
            var a = Math.abs(x);
            if (a >= 1e-4 && a < 1e7) return plainDecimal(x, sig);
            var s = x.toExponential(sig - 1).split('e');
            return trimNum(s[0]) + 'e' + s[1].replace('+', '');
        }
    };

    /* ── Math helpers ───────────────────────────────────────────────────── */
    // erfc to about 3e-15 relative error for every x where the result is a normal double (tested against mpmath):
    // 1 − erf below x = 1 (erfc ≥ 0.157 there, so the subtraction costs no accuracy), Laplace's continued fraction
    // from x = 1 (modified Lentz, at most about 190 terms at x = 1, 57 at x = 2, 6 at x = 26). e^(−x²) is evaluated as
    // e^(−xh²)·e^(−(x−xh)(x+xh)) with xh = x rounded down to 1/16, so the large exponent is exact.
    function expMinusSq(x) { var xh = Math.floor(x * 16) / 16; return Math.exp(-xh * xh) * Math.exp(-(x - xh) * (x + xh)); }
    function erfc(x) {
        if (x !== x) return NaN;
        if (x < 0) return 2 - erfc(-x);
        if (x < 0.5) return 1 - erf(x);
        if (x < 1) {   // erf from its series of positive terms: 2/√π e^(−x²) Σ 2ⁿx^(2n+1)/(1·3·…·(2n+1))
            var x2 = x * x, term = x, s = x;
            for (var n = 1; n < 60 && term > 1e-17 * s; n++) { term *= 2 * x2 / (2 * n + 1); s += term; }
            return 1 - 2 / Math.sqrt(Math.PI) * expMinusSq(x) * s;
        }
        if (x > 27.3) return 0;   // below the smallest subnormal
        var f = x, C = x, D = 0, delta;   // x + (1/2)/(x + 1/(x + (3/2)/(x + 2/(x + …))))
        for (var k = 1; k < 5000; k++) {
            D = x + k / 2 * D; D = 1 / (D || 1e-300);
            C = x + k / 2 / C;
            delta = C * D; f *= delta;
            if (Math.abs(delta - 1) < 1e-16) break;
        }
        return expMinusSq(x) / (Math.sqrt(Math.PI) * f);
    }
    function erf(x) {
        // Maclaurin series near zero, where 1 − erfc(x) would lose the relative precision (and the sign)
        if (Math.abs(x) < 0.5) {
            var x2 = x * x, term = x, sum = x;
            for (var n = 1; n < 25; n++) { term *= -x2 / n; sum += term / (2 * n + 1); }
            return 2 / Math.sqrt(Math.PI) * sum;
        }
        return 1 - erfc(x);
    }
    function normCdf(z) { return 0.5 * erfc(-z / Math.SQRT2); }
    // inverse normal CDF: Acklam's rational approximation (relative error < 1.2e-9), polished by one Halley step on
    // normCdf to about 1e-15; the upper half uses Φ⁻¹(p) = −Φ⁻¹(1 − p), where 1 − p is exact
    function normInv(p) {
        if (p > 0.5 && p < 1) return -normInv(1 - p);
        var x = acklam(p);
        if (!(x > -37.5 && x < 37.5)) return x;   // ±Infinity, or near where exp(x²/2) overflows
        var e = normCdf(x) - p, u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
        return x - u / (1 + x * u / 2);
    }
    function acklam(p) {
        if (p <= 0) return -Infinity;
        if (p >= 1) return Infinity;
        var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
        var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
        var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
        var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
        var pl = 0.02425, q, r;
        if (p < pl) {
            q = Math.sqrt(-2 * Math.log(p));
            return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
        }
        if (p > 1 - pl) {
            q = Math.sqrt(-2 * Math.log(1 - p));
            return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
        }
        q = p - 0.5; r = q * q;
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    function linspace(a, b, n) { var out = []; for (var i = 0; i < n; i++) out.push(a + (b - a) * i / (n - 1)); return out; }
    function logspace(a, b, n) { var la = Math.log10(a), lb = Math.log10(b); return linspace(la, lb, n).map(function (x) { return Math.pow(10, x); }); }
    function mean(xs) { var s = 0; for (var i = 0; i < xs.length; i++) s += xs[i]; return s / xs.length; }
    function stdev(xs) { // sample standard deviation (n − 1)
        if (xs.length < 2) return NaN;
        var m = mean(xs), s = 0;
        for (var i = 0; i < xs.length; i++) s += (xs[i] - m) * (xs[i] - m);
        return Math.sqrt(s / (xs.length - 1));
    }
    // parse a pasted block of numbers (newline, comma, tab, or space separated)
    // With a field name, Calc.parseList(v.data, 'data') refuses, with an error on that field, what it would otherwise
    // split or drop and so shift every later value: a decimal comma ("12,04" reads as 12 and 4), a thousands
    // separator, text after the first number ("NA"), or an empty cell in a tab- or comma-separated paste.
    function parseList(text, field) {
        var str = String(text || '');
        if (field) checkList(str, field);
        return str.split(/[\s,;]+/).map(parseNum).filter(function (x) { return isFinite(x); });
    }
    function checkList(str, field) {
        var isNum = function (t) { return isFinite(parseNum(t)); }, i, m;
        // "1.064,5" (period as thousands separator, decimal comma) would be split at the comma: refuse it rather than guess
        if ((m = /(^|[\s;])([-+−]?\d{1,3}(?:\.\d{3})+,\d+)(?=,\s|[\s;]|$)/.exec(str)))
            throw fail('“' + m[2] + '” is ambiguous: use a period as the decimal mark and no thousands separators (1064.5, not 1.064,5).', field);
        // "1,200, 1,300" or "12,500\t13,200": a comma followed by exactly three digits is a thousands separator, a decimal
        // comma, or a separator between values; every reading but one splits or misreads the value, so refuse it
        if ((m = /(^|[\s;,])([-+−]?\d{1,3}(?:,\d{3})+)(?=,\s|[\s;]|$)/.exec(str)))
            throw fail('“' + m[2] + '” is ambiguous: a thousands separator, a decimal comma, or separate values. Remove thousands separators (1200, not 1,200), use a period as the decimal mark (1.2, not 1,2), and separate values with spaces, tabs, or new lines.', field);
        // a comma next to a space, or two commas in one run ("10,20,30"), shows that commas separate the values here
        if (/(^|[\s;])[-+−]?\d+,\d+(?=[\s;]|$)/.test(str) && !/\d\.\d/.test(str) && !/,\s|\s,|\d,\d+,/.test(str))
            throw fail('Use a period as the decimal mark (12.04, not 12,04). Separate values with spaces, tabs, commas, or new lines.', field);
        if (/(^|[\s;])[-+−]?\d{1,3}(,\d{3})+\.\d+(?=,\s|[\s;]|$)/.test(str))
            throw fail('Remove the thousands separators (1234.5, not 1,234.5). Commas separate values.', field);
        var toks = str.split(/[\s,;]+/).filter(Boolean), seen = false;   // text before the first number is a header
        for (i = 0; i < toks.length; i++) {
            if (isNum(toks[i])) seen = true;
            else if (seen) throw fail('“' + toks[i] + '” is not a number. Delete it or enter the value.', field);
        }
        // blank cells (a column no row uses, or blanks after the last value, are harmless)
        var rows = str.split(/\r?\n/).map(function (l) { return l.split(/[\t,;]/).map(function (c) { return c.trim(); }); })
            .filter(function (r) { return r.some(Boolean); }), used = [], cells = [];
        rows.forEach(function (r) { r.forEach(function (c, j) { if (c) used[j] = true; }); });
        rows.forEach(function (r) { r.forEach(function (c, j) { if (rows.length === 1 || used[j]) cells.push(c); }); });
        for (i = 0; i < cells.length && !isNum(cells[i]); i++) { /* skip a header */ }
        var gap = cells.indexOf('', i);
        if (i < cells.length && gap !== -1 && cells.slice(gap).some(Boolean)) throw fail('The pasted data contain an empty cell. Fill it in or delete it.', field);
    }

    /* ── Errors ─────────────────────────────────────────────────────────── */
    function CalcError(message, field) { this.message = message; this.field = field; }
    function fail(message, field) { return new CalcError(message, field); }
    // an invalid field points at the message box, so a screen reader reads the reason along with the field
    var errIds = 0;
    function markInvalid(c, box) {
        c.setAttribute('aria-invalid', 'true');
        if (!box) return;
        if (!box.id) box.id = 'calc-error-' + (++errIds);
        if (c._desc === undefined) c._desc = c.getAttribute('aria-describedby');
        c.setAttribute('aria-describedby', (c._desc ? c._desc + ' ' : '') + box.id);
    }
    function markValid(c) {
        c.removeAttribute('aria-invalid');
        if (c._desc === undefined) return;
        if (c._desc) c.setAttribute('aria-describedby', c._desc); else c.removeAttribute('aria-describedby');
        c._desc = undefined;
    }

    /* ── Clipboard ──────────────────────────────────────────────────────── */
    // resolves true when the text was copied and false when the browser refused (it never rejects)
    function copyText(text) {
        function legacy() {
            var ta = document.createElement('textarea'), prev = document.activeElement, ok = false;
            ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
            ta.remove();
            if (prev && prev.focus) prev.focus();
            return Promise.resolve(ok);
        }
        // the async API can still be refused (document not focused, permissions policy in a frame)
        if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(function () { return true; }, legacy);
        return legacy();
    }
    function flash(elm, cls, text) {
        if (elm._flashText === undefined) elm._flashText = elm.textContent;   // the resting text, even when clicked again mid-flash
        clearTimeout(elm._flashT);
        elm.classList.add(cls);
        if (text) elm.textContent = text;
        elm._flashT = setTimeout(function () {
            elm.classList.remove(cls);
            if (text) elm.textContent = elm._flashText;
            elm._flashText = undefined;
        }, 1100);
    }
    document.addEventListener('click', function (e) {
        var v = e.target.closest('.result-value');
        if (v && v.textContent.trim() && v.textContent.trim() !== '—') {
            copyText(v.textContent.trim().replace(/−/g, '-').replace(/\u00a0/g, ' ')).then(function (ok) { if (ok) flash(v, 'copied'); });
        }
        var share = e.target.closest('[data-action="share"]');
        if (share) {
            if (hashRetry) writeHash();   // a hash update the browser throttled is still pending
            copyText(location.href).then(function (ok) { if (ok) flash(share, 'copied', 'Link copied'); });
        }
    });
    // click-to-copy results are reachable from the keyboard too: every .result-value is a tab stop, and Enter or Space
    // copies it like a click does (run for the whole page once it has loaded, and again for each calculator's outputs)
    function focusable(root) {
        root.querySelectorAll('.result-value').forEach(function (o) {
            if (!o.hasAttribute('tabindex')) o.tabIndex = 0;
            if (!o.title) o.title = 'Copy value';
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { focusable(document); });
    else focusable(document);
    document.addEventListener('keydown', function (e) {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.result-value')) { e.preventDefault(); e.target.click(); }
    });

    /* ── Hash state ─────────────────────────────────────────────────────── */
    function readHash() {
        var h = location.hash.replace(/^#/, '');
        if (!h || h.indexOf('=') === -1) return null;
        try { return new URLSearchParams(h); } catch (e) { return null; }
    }
    var hashWriters = [], hashRetry = 0, hashFails = 0;
    function writeHash(retry) {
        clearTimeout(hashRetry); hashRetry = 0;
        if (retry !== true) hashFails = 0;   // each edit gets a fresh set of retries; only the timer's own retries use them up
        var p = new URLSearchParams();
        hashWriters.forEach(function (w) { w(p); });
        var s = p.toString();
        try { history.replaceState(null, '', s ? '#' + s : location.pathname + location.search); hashFails = 0; }
        catch (e) {   // Safari throws after 100 calls in 10 s (a held-down key): try again shortly so the link is not left stale
            if (++hashFails <= 20) hashRetry = setTimeout(function () { writeHash(true); }, 1000);
        }
    }
    // A link to this page opened in the tab that already shows it (a bookmark, an edited address, Back) changes only
    // the fragment, which does not reload the page: reload when the link describes a different state than the one shown.
    var hashCheckers = [];
    window.addEventListener('hashchange', function () {
        var h = readHash();   // null for an in-page anchor such as #references
        if (h && hashCheckers.some(function (differs) { return differs(h); })) location.reload();
    });

    /* ── Unit selects ───────────────────────────────────────────────────── */
    function initUnitSelect(sel) {
        var dim = sel.dataset.dim;
        if (!UNITS[dim]) throw new Error('Unknown dimension ' + dim);
        if (!sel.options.length) {
            var list = (sel.dataset.units || Object.keys(UNITS[dim]).join(',')).split(',');
            sel.innerHTML = list.map(function (u) {
                u = u.trim();
                return '<option value="' + u + '"' + (u === sel.dataset.default ? ' selected' : '') + '>' + (u || '—') + '</option>';
            }).join('');
        }
        sel.dataset.prev = sel.value;
        if (!sel.getAttribute('aria-label')) sel.setAttribute('aria-label', 'Unit');
    }

    /* ── Calculator ─────────────────────────────────────────────────────── */
    function create(opts) {
        var root = typeof opts.form === 'string' ? document.querySelector(opts.form) : opts.form;
        if (!root) throw new Error('Calc: form not found');
        var outRoot = opts.outputs ? (typeof opts.outputs === 'string' ? document.querySelector(opts.outputs) : opts.outputs) : document;
        var prefix = opts.id ? opts.id + '.' : '';
        if (root.tagName === 'FORM') root.addEventListener('submit', function (e) { e.preventDefault(); });
        focusable(outRoot);   // outputs added after the page loaded

        root.querySelectorAll('select[data-dim]').forEach(function (sel) {
            var named = sel.getAttribute('aria-label');
            initUnitSelect(sel);
            if (!sel.name) {
                var box = sel.closest('.input-unit');
                var inp = box && box.querySelector('input[name]');
                if (inp) { sel.name = inp.name + '_u'; inp.dataset.unitSelect = sel.name; }
            }
            // a screen reader names each unit list after its field ("Wavelength unit"), not just "Unit"
            var field = !named && sel.name && root.querySelector('input[data-unit-select="' + sel.name + '"]');
            if (field) { var l = labelFor(field); sel.setAttribute('aria-label', l.charAt(0).toUpperCase() + l.slice(1) + ' unit'); }
        });

        var controls = function () { return Array.prototype.slice.call(root.querySelectorAll('input[name], select[name], textarea[name]')); };
        var errBox = root.querySelector('.calc-error') || (opts.errorBox && document.querySelector(opts.errorBox));
        if (!errBox) {
            errBox = document.createElement('div');
            errBox.className = 'calc-error'; errBox.setAttribute('role', 'alert');
            root.insertBefore(errBox, root.firstChild);
        }

        function getState() {
            var s = {};
            controls().forEach(function (c) {
                if (c.type === 'radio') { if (c.checked) s[c.name] = c.value; }
                else if (c.type === 'checkbox') s[c.name] = c.checked ? '1' : '0';
                else s[c.name] = c.value;
            });
            return s;
        }
        function setState(s) {
            var all = controls();
            all.forEach(function (c) {
                if (!(c.name in s)) return;
                var val = s[c.name];
                c._exact = null;
                // a value the control does not offer (an edited or outdated link) keeps the current choice
                if (c.type === 'radio') {
                    if (!all.some(function (r) { return r.type === 'radio' && r.name === c.name && r.value === val; })) return;
                    c.checked = c.value === val;
                }
                else if (c.type === 'checkbox') c.checked = val === '1';
                else if (c.tagName === 'SELECT') {
                    if (!Array.prototype.some.call(c.options, function (o) { return o.value === val; })) return;
                    c.value = val;
                }
                else c.value = val;
                if (c.matches('select[data-dim]')) c.dataset.prev = c.value;
            });
            syncKeyboards();
        }
        // iOS's decimal keypad has no minus key: a temperature field gets the full keyboard while its unit is °C or °F
        function syncKeyboards() {
            root.querySelectorAll('select[data-dim="temperature"]').forEach(function (sel) {
                var inp = root.querySelector('input[data-unit-select="' + sel.name + '"]');
                if (!inp) return;
                if (inp._kb === undefined) inp._kb = inp.getAttribute('inputmode');
                if (inp._kb === 'decimal' || inp._kb === 'numeric') inp.setAttribute('inputmode', sel.value === 'K' ? inp._kb : 'text');
            });
        }
        var defaults = getState();

        var fromHash = readHash();
        if (fromHash) {
            var s = {};
            fromHash.forEach(function (val, key) {
                if (prefix && key.indexOf(prefix) !== 0) return;
                s[key.slice(prefix.length)] = val;
            });
            setState(s);
        }
        syncKeyboards();

        hashWriters.push(function (p) {
            var s = getState(), changed = false;
            Object.keys(s).forEach(function (k) { if (s[k] !== defaults[k]) changed = true; });
            if (!changed) return;
            Object.keys(s).forEach(function (k) { p.set(prefix + k, s[k]); });
        });
        hashCheckers.push(function (h) {   // the state a link describes is the defaults plus its own keys
            var want = {}, now = getState();
            Object.keys(defaults).forEach(function (k) { want[k] = defaults[k]; });
            h.forEach(function (val, key) { if (!prefix || key.indexOf(prefix) === 0) want[key.slice(prefix.length)] = val; });
            return Object.keys(now).some(function (k) { return k in want && want[k] !== now[k]; });
        });

        function unitOf(input) {
            var name = input.dataset.unitSelect;
            var sel = name ? root.querySelector('select[name="' + name + '"]') : null;
            return sel ? { dim: sel.dataset.dim, unit: sel.value } : null;
        }

        var skipped = [];   // fields the last read() let through because they sat in a hidden group
        function read() {
            var v = { $raw: {}, $unit: {} };
            var errors = [];
            skipped = [];
            controls().forEach(function (c) {
                markValid(c);
                if (c.matches('select[data-dim]')) return;
                if (c.type === 'radio') { if (c.checked) v[c.name] = c.value; return; }
                if (c.type === 'checkbox') { v[c.name] = c.checked; return; }
                if (c.tagName === 'SELECT' || c.tagName === 'TEXTAREA' || c.dataset.text !== undefined) { v[c.name] = c.value; return; }
                var raw = c.value; v.$raw[c.name] = raw;
                var x = parseNum(raw);
                var label = labelFor(c);
                var Label = label.charAt(0).toUpperCase() + label.slice(1);
                // a field in a hidden group (another mode) is not in use, so it never blocks: an invalid value reads as NaN
                var hidden = c.closest('[hidden]') !== null;
                var msg = null;
                if (isNaN(x)) {
                    if (raw.trim() === '' && c.dataset.optional !== undefined) { v[c.name] = NaN; return; }
                    // an exponent still being typed ("1e", "1.6e-") in the focused field is not an error yet: run() keeps
                    // the last results, and leaving the field (change) shows the message, as in Calc.converter
                    if (!hidden && c === document.activeElement && /\d[eE][-+]?$/.test(raw.trim())) {
                        var pend = fail('', c.name); pend.pending = true; errors.push(pend); return;
                    }
                    var both = commaReadings(raw);
                    msg = raw.trim() === '' ? 'Enter a value for ' + label + '.'
                        : both ? '“' + raw.trim() + '” is ambiguous (' + label + '): enter ' + both + '.'
                        : '“' + raw + '” is not a number (' + label + ').';
                } else {
                    var u = unitOf(c);
                    if (u) { v.$unit[c.name] = u.unit; x = toSI(u.dim, u.unit, x); }
                    if (!isFinite(x)) msg = Label + ' is out of range.';   // "1e400", or a unit conversion that overflows
                    else if (c.dataset.positive !== undefined && !(x > 0)) msg = Label + ' must be greater than zero.';
                    else if (c.dataset.nonneg !== undefined && x < 0) msg = Label + ' cannot be negative.';
                    else if (c.dataset.min !== undefined && x < parseFloat(c.dataset.min)) msg = Label + ' must be at least ' + c.dataset.min + '.';
                    else if (c.dataset.max !== undefined && x > parseFloat(c.dataset.max)) msg = Label + ' must be at most ' + c.dataset.max + '.';
                }
                if (msg && hidden) { v[c.name] = NaN; skipped.push(c); return; }
                if (msg) { errors.push(fail(msg, c.name)); return; }
                v[c.name] = x;
            });
            if (errors.length) throw errors.filter(function (e) { return !e.pending; })[0] || errors[0];   // a real error first
            return v;
        }
        // compute() may unhide a group (a mode switch) whose fields read() let through while hidden: check them now
        function revealed() { return skipped.some(function (c) { return c.closest('[hidden]') === null; }); }

        function labelFor(c) {
            if (c.dataset.label) return c.dataset.label;
            var l = c.id && root.querySelector('label[for="' + c.id + '"]');
            if (!l) { var f = c.closest('.field'); l = f && f.querySelector('label, .field-label'); }
            if (!l) return c.name;
            var t = l.cloneNode(true);
            t.querySelectorAll('.sym, .hint').forEach(function (n) { n.remove(); });
            return t.textContent.trim().toLowerCase();
        }

        function outputs() { return outRoot.querySelectorAll('[data-out]'); }
        function clearOutputs() { outputs().forEach(function (o) { o.textContent = '—'; }); }

        function run(fromUser, again) {
            var v, r;
            try {
                v = read();
                r = opts.compute(v) || {};
                errBox.classList.remove('show'); errBox.textContent = '';
            } catch (err) {
                // an exponent being typed: no message and the last results stay (outputs, plots, link) until it is complete
                if (err && err.pending) { errBox.classList.remove('show'); errBox.textContent = ''; return; }
                if (!again && revealed()) { run(fromUser, true); return; }
                if (!(err instanceof CalcError)) { console.error(err); err = fail('Calculation error: ' + err.message); }
                errBox.textContent = err.message; errBox.classList.add('show');
                if (err.field) {
                    var bad = root.querySelector('[name="' + err.field + '"]');
                    if (bad) markInvalid(bad, errBox);
                }
                clearOutputs();
                if (opts.onError) { try { opts.onError(err); } catch (e) { console.error(e); } }
                return;
            }
            if (!again && revealed()) { run(fromUser, true); return; }
            outputs().forEach(function (o) {
                var key = o.dataset.out;
                if (!(key in r)) return;
                var val = r[key];
                var row = o.closest('.result');
                if (val === null) { if (row) row.hidden = true; return; }
                if (row) row.hidden = false;
                if (typeof val === 'number') o.textContent = fmt.num(val);
                else if (val && typeof val === 'object' && 'html' in val) o.innerHTML = val.html;
                else o.textContent = val === undefined ? '—' : String(val);
            });
            // a failure while drawing (a plot) is logged; it must not stop the page from setting up or the link from updating
            if (opts.after) { try { opts.after(v, r); } catch (e) { console.error(e); } }
            if (fromUser) writeHash();
        }

        var pending = 0;
        function schedule() { cancelAnimationFrame(pending); pending = requestAnimationFrame(function () { run(true); }); }

        root.addEventListener('input', function (e) { if (!e.target.matches('select[data-dim]')) schedule(); });
        root.addEventListener('change', function (e) {
            var sel = e.target;
            if (sel.matches('select[data-dim]')) {
                // keep the physical quantity constant when the unit changes. While the text is unedited the exact
                // value is carried along, so switching back and forth (mm → in → mm) does not drift by the rounding
                var inp = root.querySelector('input[data-unit-select="' + sel.name + '"]');
                var x = inp ? parseNum(inp.value) : NaN;
                if (inp && isFinite(x) && sel.dataset.prev) {
                    var ex = inp._exact;
                    var si = ex && ex.text === inp.value && ex.unit === sel.dataset.prev ? ex.si : toSI(sel.dataset.dim, sel.dataset.prev, x);
                    inp.value = fmt.plain(fromSI(sel.dataset.dim, sel.value, si), 6);
                    inp._exact = { si: si, text: inp.value, unit: sel.value };
                }
                sel.dataset.prev = sel.value;
                syncKeyboards();
            }
            schedule();
        });

        document.querySelectorAll('[data-action="reset"]').forEach(function (b) {
            if ((b.dataset.for || '') !== (opts.id || '')) return;   // unscoped buttons belong to unnamed calculators
            b.addEventListener('click', function () { setState(defaults); run(false); writeHash(); });
        });

        run(false);
        return { run: function () { run(true); }, read: read, root: root, set: function (s) { setState(s); run(true); } };
    }

    /* ── Converter: every field is both input and output ────────────────── */
    // Calc.converter({ root, fields: { name: { to: x → base, from: base → x } }, sig, initial: { field, value },
    //                  id (optional: prefixes hash keys and scopes [data-action="reset"][data-for=id]),
    //                  positive (default true: inputs must be > 0), validate(base, sourceName) → error string | null,
    //                  after(base, sourceName) })
    function converter(opts) {
        var root = typeof opts.root === 'string' ? document.querySelector(opts.root) : opts.root;
        var sig = opts.sig || 6;
        var names = Object.keys(opts.fields);
        var inputs = {};
        names.forEach(function (n) { inputs[n] = root.querySelector('input[name="' + n + '"]'); });
        var errBox = root.querySelector('.calc-error');
        var source = opts.initial ? opts.initial.field : names[0];
        var defaultSource = source, defaultValue = opts.initial ? String(opts.initial.value) : inputs[source].value;
        var prefix = opts.id ? opts.id + '.' : '';
        var edited = false;
        // shares the URL hash with any Calc.create calculators on the same page
        hashWriters.push(function (p) { if (edited) p.set(prefix + source, inputs[source].value.trim()); });
        hashCheckers.push(function (h) {
            var want = '';
            h.forEach(function (val, key) {
                if (want || (prefix && key.indexOf(prefix) !== 0)) return;
                if (inputs[key.slice(prefix.length)]) want = key + '=' + val;
            });
            return want !== (edited ? prefix + source + '=' + inputs[source].value.trim() : '');
        });

        function markSource(n) {
            names.forEach(function (k) { var box = inputs[k].closest('.input-unit'); if (box) box.classList.toggle('source', k === n); });
        }
        // returns true when the value was converted
        function update(n, fromUser) {
            var raw = inputs[n].value.trim();
            var x = parseNum(raw);
            names.forEach(function (k) { markValid(inputs[k]); });
            if (!isFinite(x) || (opts.positive !== false && !(x > 0))) {
                // stay quiet while an exponent is still being typed ("1.6e", "1.6e-"); the other fields keep their values
                if (fromUser && /\d[eE][-+]?$/.test(raw)) { if (errBox) errBox.classList.remove('show'); return false; }
                if (raw !== '') {
                    markInvalid(inputs[n], errBox);
                    var both = commaReadings(raw);
                    if (errBox) {
                        errBox.textContent = both ? '“' + raw + '” is ambiguous: enter ' + both + '.'
                            : Math.abs(x) === Infinity ? 'That value is out of range.'
                            : isNaN(x) ? '“' + raw + '” is not a number.'
                            : opts.positive !== false ? 'Enter a positive number.' : 'Enter a number.';
                        errBox.classList.add('show');
                    }
                }
                return false;
            }
            var base = opts.fields[n].to(x);
            var msg = opts.validate ? opts.validate(base, n) : null;   // optional domain check on the base value
            if (msg || !isFinite(base)) {
                markInvalid(inputs[n], errBox);
                if (errBox) { errBox.textContent = msg || 'That value is out of range.'; errBox.classList.add('show'); }
                return false;
            }
            if (errBox) errBox.classList.remove('show');
            names.forEach(function (k) {
                if (k === n) return;
                inputs[k].value = fmt.plain(opts.fields[k].from(base), sig);
            });
            source = n; markSource(n);
            if (opts.after) { try { opts.after(base, n); } catch (e) { console.error(e); } }
            if (fromUser) { edited = true; writeHash(); }
            return true;
        }
        names.forEach(function (n) {
            inputs[n].addEventListener('input', function () { update(n, true); });
            inputs[n].addEventListener('focus', function () { inputs[n].select(); });
            // leaving a field with an unfinished exponent ("1.6e-") flags it, which typing it deliberately did not
            inputs[n].addEventListener('change', function () { if (/\d[eE][-+]?$/.test(inputs[n].value.trim())) update(n, false); });
        });
        var h = readHash(), started = false;
        if (h) h.forEach(function (val, key) {
            if (started || (prefix && key.indexOf(prefix) !== 0)) return;
            var k = key.slice(prefix.length);
            if (!inputs[k]) return;
            inputs[k].value = val;
            // a value that does not convert (an edited or truncated link) falls back to the default below, except an ambiguous
            // "1,064" (from a link made before such values were refused): it stays in its field with its message, as if typed
            if (update(k, false) || commaReadings(val)) { started = true; edited = true; source = k; markSource(k); }
        });
        if (!started) { inputs[source].value = defaultValue; update(source, false); }

        document.querySelectorAll('[data-action="reset"]').forEach(function (b) {
            if ((b.dataset.for || '') !== (opts.id || '')) return;   // unscoped buttons belong to unnamed calculators
            b.addEventListener('click', function () { inputs[defaultSource].value = defaultValue; update(defaultSource, false); edited = false; writeHash(); });
        });
        return {
            set: function (n, x) { inputs[n].value = fmt.plain(x, sig); update(n, true); },
            get: function () { return opts.fields[source].to(parseNum(inputs[source].value)); }
        };
    }

    window.Calc = {
        create: create, converter: converter, fail: fail, CalcError: CalcError,
        K: K, UNITS: UNITS, toSI: toSI, fromSI: fromSI,
        parseNum: parseNum, parseList: parseList, fmt: fmt, sup: sup, roundSig: roundSig,
        math: { erf: erf, erfc: erfc, normCdf: normCdf, normInv: normInv, linspace: linspace, logspace: logspace, mean: mean, stdev: stdev },
        copyText: copyText
    };
})();
