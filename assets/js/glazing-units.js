/* ==========================================================================
   cdfoley.com — glazing-units.js
   U-factor and R-value of glazing in SI and US units, window.GlazingUnits:
   the conversions, the text every page uses for a U/R pair, and the
   four-field converter panel of the glazing tools.

   U in W/m²·K and in Btu/h·ft²·°F; R = 1/U in m²·K/W (RSI) and in
   h·ft²·°F/Btu (the "R-4" of US practice). Everything converts through the
   full-precision U in W/m²·K; rounding happens only when text is written.

   R = 1/U of a glazing is a center-of-glass, air-to-air value: it includes
   the indoor and outdoor surface (air-film) resistances at the conditions
   U was calculated for. It is not the material-only R-value printed on
   insulation, and a whole window (frame and edge included) has a lower R.

   The conversions and the text helpers need nothing else (the Node tests
   load this file alone). mountConverter() needs calc.js and a document.
   ========================================================================== */
(function (root) {
    'use strict';

    // W/m²·K per Btu/h·ft²·°F. By definition the International Table Btu is 1055.05585262 J
    // (4186.8 J/kg·K × 0.45359237 kg/lb × 5/9 K/°F), the foot 0.3048 m (1 ft² = 0.09290304 m²), the hour 3600 s
    // and the Fahrenheit degree 5/9 K, so 1 Btu/h·ft²·°F = 1055.05585262 / (3600 × 0.09290304 × 5/9)
    // = 5.6782633… W/m²·K. Seven figures, the value the glazing pages and beta-core.js already use.
    var BTU = 5.678263;

    var UNIT = { U: 'W/m²·K', Uip: 'Btu/h·ft²·°F', Rsi: 'm²·K/W', Rip: 'h·ft²·°F/Btu' };

    /* ── Conversions ──────────────────────────────────────────────────── */
    // A U-factor or R-value is a positive, finite number. Anything else (zero, negative, NaN, ±Infinity, text)
    // converts to NaN, never to a number that looks like a result.
    function pos(x) { return typeof x === 'number' && x > 0 && isFinite(x) ? x : NaN; }

    // fromU(U in W/m²·K) → { U, Uip, Rsi, Rip }; all four are NaN unless all four are positive and finite
    function fromU(Usi) {
        var U = pos(Usi), q = { U: U, Uip: pos(U / BTU), Rsi: pos(1 / U), Rip: pos(BTU / U) };
        if (q.U !== q.U || q.Uip !== q.Uip || q.Rsi !== q.Rsi || q.Rip !== q.Rip) q = { U: NaN, Uip: NaN, Rsi: NaN, Rip: NaN };
        return q;
    }
    // each of the other three quantities → U in W/m²·K
    function fromUip(Uip) { return pos(pos(Uip) * BTU); }   // Btu/h·ft²·°F
    function fromRsi(Rsi) { return pos(1 / pos(Rsi)); }     // m²·K/W
    function fromRip(Rip) { return pos(BTU / pos(Rip)); }   // h·ft²·°F/Btu

    /* ── Text ─────────────────────────────────────────────────────────── */
    // num is the page's number formatter, Calc.fmt.num (x, significant figures) → text. Each number is rounded
    // from its own full-precision value, so the pair never shows a rounded value converted again.
    // format(1.36954, Calc.fmt.num) → { U: '1.37', Uip: '0.241', Rsi: '0.73', Rip: '4.15' }
    function format(Usi, num, sig) {
        var q = fromU(Usi);
        sig = sig || 3;
        return { U: num(q.U, sig), Uip: num(q.Uip, sig), Rsi: num(q.Rsi, sig), Rip: num(q.Rip, sig) };
    }
    // "1.37 W/m²·K (0.241 Btu/h·ft²·°F)"; "—" when there is no value
    function uText(Usi, num, sig) {
        if (!(pos(Usi) > 0)) return '—';
        var t = format(Usi, num, sig);
        return t.U + ' ' + UNIT.U + ' (' + t.Uip + ' ' + UNIT.Uip + ')';
    }
    // "R-4.15 (0.73 m²·K/W)": the US value in its usual "R-" form, then RSI
    function rText(Usi, num, sig) {
        if (!(pos(Usi) > 0)) return '—';
        var t = format(Usi, num, sig);
        return 'R-' + t.Rip + ' (' + t.Rsi + ' ' + UNIT.Rsi + ')';
    }

    /* ── Converter panel ──────────────────────────────────────────────── */
    // Four linked fields (input names u, uip, rip, rsi), each both input and output, in static page markup:
    //
    //   <section class="panel" id="ru-converter" aria-labelledby="ru-h">
    //     … <button type="button" data-action="reset" data-for="ru">Use the calculator result</button>
    //     <div class="calc-error" role="alert"></div>
    //     <div class="conv-grid" style="…two columns at most…"> four .field > .input-unit > input[name] + span.unit </div>
    //     <p class="hint" data-ru-status role="status">…</p>
    //   </section>
    //
    // var ru = GlazingUnits.mountConverter({ root: '#ru-converter', id: 'ru', sig: 4, label: '…' });   // all optional
    //   ru.follow(Usi)   after each successful calculation: the calculator's center-of-glass U in W/m²·K
    //   ru.clear()       when the calculation fails
    //   ru.get()         the U in W/m²·K behind the fields: the followed result, or the last entry that converted
    //                    (NaN when there is none); ru.held() → true once the user has typed
    //
    // The fields follow the calculator's result until the user types in one; then they hold the typed value until
    // "Use the calculator result" is pressed. The typing, the validation messages and the link are Calc.converter's:
    // a typed value is stored in the URL hash as ru.<field>=<text>, next to the calculators' own prefixed keys.
    // Following writes the fields directly and leaves Calc.converter unedited, so it never touches the hash.
    // The panel must sit outside the calculator's form, whose input events and named controls belong to Calc.create.
    var NAMES = ['u', 'uip', 'rip', 'rsi'];
    var KEY = { u: 'U', uip: 'Uip', rip: 'Rip', rsi: 'Rsi' };
    var UMIN = 1e-9, UMAX = 1e9;   // W/m²·K: far beyond any glazing; inside it all four values print as plain numbers

    function mountConverter(options) {
        options = options || {};
        var C = options.Calc || root.Calc;
        if (!C || !C.converter) throw new Error('GlazingUnits.mountConverter needs calc.js');
        var el = typeof options.root === 'string' ? document.querySelector(options.root) : options.root || document.getElementById('ru-converter');
        if (!el) throw new Error('GlazingUnits.mountConverter: converter markup not found');
        if (el.closest('form')) throw new Error('GlazingUnits.mountConverter: the converter must sit outside the calculator form');
        var id = options.id || 'ru', sig = options.sig || 4;
        var label = options.label || 'the calculator’s center-of-glass result';
        var inputs = {};
        NAMES.forEach(function (n) {
            inputs[n] = el.querySelector('input[name="' + n + '"]');
            if (!inputs[n]) throw new Error('GlazingUnits.mountConverter: no input named ' + n);
        });
        var errBox = el.querySelector('.calc-error'), status = el.querySelector('[data-ru-status]');
        var result = NaN;   // the calculator's U (W/m²·K); NaN while it has none

        function unmark() {
            NAMES.forEach(function (n) { var box = inputs[n].closest('.input-unit'); if (box) box.classList.remove('source'); });
        }
        // Start blank and unmarked, so a marked source field after Calc.converter starts means the link carried a value
        NAMES.forEach(function (n) { inputs[n].value = ''; });
        unmark();
        var conv = C.converter({
            root: el, id: id, sig: sig,
            initial: { field: 'u', value: '' },   // no value of its own: its reset button empties it, and show() fills it
            fields: {
                u:   { to: function (x) { return x; }, from: function (U) { return U; } },
                uip: { to: fromUip,                   from: function (U) { return U / BTU; } },
                rip: { to: fromRip,                   from: function (U) { return BTU / U; } },
                rsi: { to: fromRsi,                   from: function (U) { return 1 / U; } }
            },
            validate: function (U) { return U >= UMIN && U <= UMAX ? null : 'That value is out of range.'; }
        });
        var held = !!el.querySelector('.input-unit.source');   // a value from the link is held like a typed one

        function say() {
            if (!status) return;
            var t = held ? 'Showing the value you entered, not the calculator result. Press “Use the calculator result” to go back.'
                : result === result ? 'Showing ' + label + '. Type in any field to convert another value.'
                : 'There is no calculator result to show. Type in any field to convert a value.';
            if (status.textContent !== t) status.textContent = t;   // a live region: unchanged text is not announced again
        }
        // the followed result in all four fields, each rounded from the full-precision value; blank without a result
        function show() {
            var q = fromU(result);
            NAMES.forEach(function (n) { inputs[n].value = C.fmt.plain(q[KEY[n]], sig); });
            unmark();
            if (errBox) errBox.classList.remove('show');
            say();
        }
        // registered after Calc.converter's own listeners, so these run once it has converted (or reset) the fields
        NAMES.forEach(function (n) {
            inputs[n].addEventListener('input', function () { held = true; say(); });
        });
        // Calc.converter's reset empties the fields, forgets the edit and rewrites the link; then follow again
        document.querySelectorAll('[data-action="reset"][data-for="' + id + '"]').forEach(function (b) {
            b.addEventListener('click', function () { held = false; show(); });
        });
        if (held) say(); else show();   // show() also clears what a link value that did not convert left behind

        return {
            follow: function (Usi) { result = fromU(Usi).U; if (held) say(); else show(); },
            clear: function () { result = NaN; if (held) say(); else show(); },
            // while held, Calc.converter's source field is marked only once an entry has converted
            get: function () { return !held ? result : el.querySelector('.input-unit.source') ? pos(conv.get()) : NaN; },
            held: function () { return held; }
        };
    }

    var api = {
        BTU: BTU, UNIT: UNIT,
        fromU: fromU, fromUip: fromUip, fromRsi: fromRsi, fromRip: fromRip,
        format: format, uText: uText, rText: rText,
        mountConverter: mountConverter
    };
    root.GlazingUnits = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
