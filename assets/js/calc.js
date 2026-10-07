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

    /* ── Physical constants (CODATA 2018; SI-exact where defined) ───────── */
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
        Eh: 4.3597447222071e-18,       // J (Hartree)
        Rinf: 10973731.568160,         // 1/m
        u: 1.66053906660e-27,          // kg (atomic mass unit)
        me: 9.1093837015e-31,          // kg
        eps0: 8.8541878128e-12,        // F/m
        a0: 5.29177210903e-11,         // m (Bohr radius)
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
        pressure:    { 'Pa': 1, 'kPa': 1e3, 'MPa': 1e6, 'mbar': 100, 'bar': 1e5, 'µbar': 0.1, 'Torr': K.torr, 'mTorr': K.torr / 1000, 'atm': K.atm, 'psi': 6894.757293168, 'inHg': 3386.389 },
        fluence:     { 'J/m²': 1, 'mJ/cm²': 10, 'J/cm²': 1e4 },
        irradiance:  { 'W/m²': 1, 'W/cm²': 1e4, 'kW/cm²': 1e7, 'MW/cm²': 1e10, 'GW/cm²': 1e13, 'TW/cm²': 1e16 },
        throughput:  { 'L/s': 1e-3, 'm³/h': 1 / 3600, 'm³/s': 1, 'L/min': 1e-3 / 60, 'cfm': 4.719474432e-4 },
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
    function parseNum(s) {
        if (s === null || s === undefined) return NaN;
        s = String(s).trim();
        if (!s) return NaN;
        s = s.replace(/[−‒–]/g, '-').replace(/\s+/g, '');
        if (s.indexOf(',') !== -1) {
            // "1,234,567.8" → thousands separators; "1,5" / "0,25" → decimal comma; anything else is ambiguous
            if (/^[-+]?\d{1,3}(,\d{3})+(\.\d*)?([eE][-+]?\d+)?$/.test(s)) s = s.replace(/,/g, '');
            else if (/^[-+]?\d*,\d+([eE][-+]?\d+)?$/.test(s)) s = s.replace(',', '.');
            else return NaN;
        }
        s = s.replace(/(?:[×x*]|×)10\^?([-+]?\d+)$/i, 'e$1');
        s = s.replace(/E/g, 'e');
        if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(s)) return NaN;
        return parseFloat(s);
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
            if (x === null || x === undefined || isNaN(x)) return '—';
            if (!isFinite(x)) return x > 0 ? '∞' : '−∞';
            if (x === 0) return '0';
            var a = Math.abs(x);
            var out = (a >= 1e-3 && a < 1e5) ? plainDecimal(x, sig) : fmt.sci(x, sig);
            return out.replace(/^-/, '−');
        },
        // always scientific: 1.234 × 10⁸ (falls back to plain for 10⁰…10²)
        sci: function (x, sig) {
            sig = sig || 4;
            if (x === null || x === undefined || isNaN(x)) return '—';
            if (!isFinite(x)) return x > 0 ? '∞' : '−∞';
            if (x === 0) return '0';
            var s = x.toExponential(sig - 1).split('e');
            var m = trimNum(s[0]), e = parseInt(s[1], 10);
            if (e >= 0 && e <= 2) return plainDecimal(x, sig).replace(/^-/, '−');
            return (m.replace(/^-/, '−')) + ' × 10' + sup(e);
        },
        // SI prefix: fmt.si(2.5e-6, 'm') → "2.5 µm"
        si: function (x, unit, sig, opts) {
            sig = sig || 4; opts = opts || {};
            if (x === null || x === undefined || isNaN(x)) return '—';
            if (!isFinite(x)) return (x > 0 ? '∞ ' : '−∞ ') + unit;
            if (x === 0) return '0 ' + unit;
            var P = { '-18': 'a', '-15': 'f', '-12': 'p', '-9': 'n', '-6': 'µ', '-3': 'm', '0': '', '3': 'k', '6': 'M', '9': 'G', '12': 'T', '15': 'P' };
            var lo = opts.min !== undefined ? opts.min : -15, hi = opts.max !== undefined ? opts.max : 15;
            var e3 = Math.floor(Math.log10(Math.abs(x)) / 3) * 3;
            e3 = Math.max(lo, Math.min(hi, e3));
            var m = roundSig(x / Math.pow(10, e3), sig);
            if (Math.abs(m) >= 1000 && e3 + 3 <= hi) { e3 += 3; m = roundSig(x / Math.pow(10, e3), sig); }
            var mantissa = (Math.abs(m) >= 1e-3 && Math.abs(m) < 1e5) ? plainDecimal(m, sig) : fmt.sci(m, sig);
            return mantissa.replace(/^-/, '−') + ' ' + P[String(e3)] + unit;
        },
        // value in a specific unit of a dimension: fmt.unit(0.0021, 'length', 'mm') → "2.1 mm"
        unit: function (x, dim, unit, sig) { return fmt.num(fromSI(dim, unit, x), sig) + (unit ? ' ' + unit : ''); },
        pct: function (frac, sig) { return fmt.num(frac * 100, sig || 4) + ' %'; },
        // editable ASCII form for converter inputs: 1064, 0.0012, 1.1654e-19
        plain: function (x, sig) {
            sig = sig || 6;
            if (!isFinite(x)) return '';
            if (x === 0) return '0';
            var a = Math.abs(x);
            if (a >= 1e-4 && a < 1e7) return plainDecimal(x, sig);
            var s = x.toExponential(sig - 1).split('e');
            return trimNum(s[0]) + 'e' + s[1].replace('+', '');
        }
    };

    /* ── Math helpers ───────────────────────────────────────────────────── */
    // erfc with fractional error < 1.2e-7 everywhere (Numerical Recipes erfcc)
    function erfc(x) {
        var z = Math.abs(x), t = 1 / (1 + 0.5 * z);
        var r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
            t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
        return x >= 0 ? r : 2 - r;
    }
    function erf(x) { return 1 - erfc(x); }
    function normCdf(z) { return 0.5 * erfc(-z / Math.SQRT2); }
    // Acklam's inverse normal CDF (relative error < 1.2e-9)
    function normInv(p) {
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
    function parseList(text) {
        return String(text || '').split(/[\s,;]+/).map(parseNum).filter(function (x) { return isFinite(x); });
    }

    /* ── Errors ─────────────────────────────────────────────────────────── */
    function CalcError(message, field) { this.message = message; this.field = field; }
    function fail(message, field) { return new CalcError(message, field); }

    /* ── Clipboard ──────────────────────────────────────────────────────── */
    function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) { /* ignore */ }
        ta.remove();
        return Promise.resolve();
    }
    function flash(elm, cls, text) {
        var old = elm.textContent;
        elm.classList.add(cls);
        if (text) elm.textContent = text;
        setTimeout(function () { elm.classList.remove(cls); if (text) elm.textContent = old; }, 1100);
    }
    document.addEventListener('click', function (e) {
        var v = e.target.closest('.result-value');
        if (v && v.textContent.trim() && v.textContent.trim() !== '—') {
            copyText(v.textContent.trim().replace(/−/g, '-')).then(function () { flash(v, 'copied'); });
        }
        var share = e.target.closest('[data-action="share"]');
        if (share) { copyText(location.href).then(function () { flash(share, 'copied', 'Link copied'); }); }
    });

    /* ── Hash state ─────────────────────────────────────────────────────── */
    function readHash() {
        var h = location.hash.replace(/^#/, '');
        if (!h || h.indexOf('=') === -1) return null;
        try { return new URLSearchParams(h); } catch (e) { return null; }
    }
    var hashWriters = [];
    function writeHash() {
        var p = new URLSearchParams();
        hashWriters.forEach(function (w) { w(p); });
        var s = p.toString();
        history.replaceState(null, '', s ? '#' + s : location.pathname + location.search);
    }

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

        root.querySelectorAll('select[data-dim]').forEach(function (sel) {
            initUnitSelect(sel);
            if (!sel.name) {
                var box = sel.closest('.input-unit');
                var inp = box && box.querySelector('input[name]');
                if (inp) { sel.name = inp.name + '_u'; inp.dataset.unitSelect = sel.name; }
            }
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
            controls().forEach(function (c) {
                if (!(c.name in s)) return;
                if (c.type === 'radio') c.checked = c.value === s[c.name];
                else if (c.type === 'checkbox') c.checked = s[c.name] === '1';
                else c.value = s[c.name];
                if (c.matches('select[data-dim]')) c.dataset.prev = c.value;
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

        hashWriters.push(function (p) {
            var s = getState(), changed = false;
            Object.keys(s).forEach(function (k) { if (s[k] !== defaults[k]) changed = true; });
            if (!changed) return;
            Object.keys(s).forEach(function (k) { p.set(prefix + k, s[k]); });
        });

        function unitOf(input) {
            var name = input.dataset.unitSelect;
            var sel = name ? root.querySelector('select[name="' + name + '"]') : null;
            return sel ? { dim: sel.dataset.dim, unit: sel.value } : null;
        }

        function read() {
            var v = { $raw: {}, $unit: {} };
            var errors = [];
            controls().forEach(function (c) {
                c.removeAttribute('aria-invalid');
                if (c.matches('select[data-dim]')) return;
                if (c.type === 'radio') { if (c.checked) v[c.name] = c.value; return; }
                if (c.type === 'checkbox') { v[c.name] = c.checked; return; }
                if (c.tagName === 'SELECT' || c.tagName === 'TEXTAREA' || c.dataset.text !== undefined) { v[c.name] = c.value; return; }
                var raw = c.value; v.$raw[c.name] = raw;
                var x = parseNum(raw);
                var label = labelFor(c);
                var Label = label.charAt(0).toUpperCase() + label.slice(1);
                if (isNaN(x)) {
                    if (raw.trim() === '' && c.dataset.optional !== undefined) { v[c.name] = NaN; return; }
                    errors.push(fail(raw.trim() === '' ? 'Enter a value for ' + label + '.' : '“' + raw + '” is not a number (' + label + ').', c.name));
                    return;
                }
                var u = unitOf(c);
                if (u) { v.$unit[c.name] = u.unit; x = toSI(u.dim, u.unit, x); }
                if (c.dataset.positive !== undefined && !(x > 0)) errors.push(fail(Label + ' must be greater than zero.', c.name));
                if (c.dataset.nonneg !== undefined && x < 0) errors.push(fail(Label + ' cannot be negative.', c.name));
                if (c.dataset.min !== undefined && x < parseFloat(c.dataset.min)) errors.push(fail(Label + ' must be at least ' + c.dataset.min + '.', c.name));
                if (c.dataset.max !== undefined && x > parseFloat(c.dataset.max)) errors.push(fail(Label + ' must be at most ' + c.dataset.max + '.', c.name));
                v[c.name] = x;
            });
            if (errors.length) throw errors[0];
            return v;
        }

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

        function run(fromUser) {
            var v, r;
            try {
                v = read();
                r = opts.compute(v) || {};
                errBox.classList.remove('show'); errBox.textContent = '';
            } catch (err) {
                if (!(err instanceof CalcError)) { console.error(err); err = fail('Calculation error: ' + err.message); }
                errBox.textContent = err.message; errBox.classList.add('show');
                if (err.field) {
                    var bad = root.querySelector('[name="' + err.field + '"]');
                    if (bad) bad.setAttribute('aria-invalid', 'true');
                }
                clearOutputs();
                if (opts.onError) opts.onError(err);
                return;
            }
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
            if (opts.after) opts.after(v, r);
            if (fromUser) writeHash();
        }

        var pending = 0;
        function schedule() { cancelAnimationFrame(pending); pending = requestAnimationFrame(function () { run(true); }); }

        root.addEventListener('input', function (e) { if (!e.target.matches('select[data-dim]')) schedule(); });
        root.addEventListener('change', function (e) {
            var sel = e.target;
            if (sel.matches('select[data-dim]')) {
                // keep the physical quantity constant when the unit changes
                var inp = root.querySelector('input[data-unit-select="' + sel.name + '"]');
                var x = inp ? parseNum(inp.value) : NaN;
                if (inp && isFinite(x) && sel.dataset.prev) {
                    var si = toSI(sel.dataset.dim, sel.dataset.prev, x);
                    inp.value = fmt.plain(fromSI(sel.dataset.dim, sel.value, si), 6);
                }
                sel.dataset.prev = sel.value;
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

        function markSource(n) {
            names.forEach(function (k) { var box = inputs[k].closest('.input-unit'); if (box) box.classList.toggle('source', k === n); });
        }
        function update(n, fromUser) {
            var x = parseNum(inputs[n].value);
            names.forEach(function (k) { inputs[k].removeAttribute('aria-invalid'); });
            if (!isFinite(x) || (opts.positive !== false && !(x > 0))) {
                if (inputs[n].value.trim() !== '') {
                    inputs[n].setAttribute('aria-invalid', 'true');
                    if (errBox) { errBox.textContent = opts.positive !== false ? 'Enter a positive number.' : 'Enter a number.'; errBox.classList.add('show'); }
                }
                return;
            }
            var base = opts.fields[n].to(x);
            var msg = opts.validate ? opts.validate(base, n) : null;   // optional domain check on the base value
            if (msg || !isFinite(base)) {
                inputs[n].setAttribute('aria-invalid', 'true');
                if (errBox) { errBox.textContent = msg || 'That value is out of range.'; errBox.classList.add('show'); }
                return;
            }
            if (errBox) errBox.classList.remove('show');
            names.forEach(function (k) {
                if (k === n) return;
                inputs[k].value = fmt.plain(opts.fields[k].from(base), sig);
            });
            source = n; markSource(n);
            if (opts.after) opts.after(base, n);
            if (fromUser) { edited = true; writeHash(); }
        }
        names.forEach(function (n) {
            inputs[n].addEventListener('input', function () { update(n, true); });
            inputs[n].addEventListener('focus', function () { inputs[n].select(); });
        });
        var h = readHash(), started = false;
        if (h) h.forEach(function (val, key) {
            if (started || (prefix && key.indexOf(prefix) !== 0)) return;
            var k = key.slice(prefix.length);
            if (inputs[k]) { inputs[k].value = val; update(k, false); started = true; edited = true; }
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
