/* Glazing Performance Calculator (open-data beta): pure page logic, window.GlazingBeta.
   No DOM, no Calc, no fetch: every function takes its dependencies explicitly, so the Node tests can run it.
   It maps the form state to engine layers for the classic model (glazing-engine.js) and the open-data model
   (glazing-open.js), runs both, and turns the results into comparison rows, tables, tiles, swatches, the
   cross-section drawing and the published-datasheet comparison. The thermal and optical physics are the engine's
   (ISO 15099 center of glass, NFRC 100/200); this file only assembles configurations and formats results.
   Our own code; the cross-section drawing is a port of the live glazing page's. */
(function (root) {
    'use strict';

    var BTU = 5.678263;   // W/m²·K per Btu/h·ft²·°F

    var THICK = [2.5, 3, 4, 5, 6, 8, 10, 12, 15, 19];
    var GENERIC = {
        clear:   { label: 'Clear float', classic: true },
        lowiron: { label: 'Low-iron',    classic: true },
        green:   { label: 'Green tint',  classic: false },
        grey:    { label: 'Gray tint',   classic: false },
        bronze:  { label: 'Bronze tint', classic: false }
    };
    var COAT_LABELS = { none: 'None', hard: 'Pyrolytic hard coat', single: 'Single silver', double: 'Double silver', triple: 'Triple silver' };

    // Tolerance table of spec 5.2 (and the case tolerances of 5.3, read by selftest.js). null = report only.
    // Units: VT, R, UV, Tsol in percent points; SHGC as a fraction; U in Btu/h·ft²·°F; color in CIELAB units.
    var TOL = {
        glass:     { VT: 2.0, Rout: 1.0, Rin: null, SHGC: 0.03, U: 0.01, UV: null, Tsol: null },
        calibrate: { VT: 1.0, R: 2.0, Rtriple: 2.5, SHGC: 0.015, U: 0.01, UV: 3, Tsol: 2.5 },
        check:     { VT: 2.0, R: 2.5, SHGC: 0.02, U: 0.015, UV: 5, Tsol: 3 },
        hardReport: ['VT', 'SHGC', 'UV', 'Tsol'],          // 2011 sheet vs the measured product (spec 2.6.5)
        measured:  { VT: 1.0, R: 1.0, Rwide: 2.0, SHGC: 0.015, U: 0.01, UV: 2, Tsol: null },
        measuredRwide: ['igdb-5439', 'igdb-9923'],          // ±2.0 for Solarban 70 and Energy Advantage
        window: { Ra: [-3.0, 1.5], Rb: [-5.0, 1.5], margin: 0.3 },   // neutral exterior color window, IGU calibration rows
        v1: { TR: 5e-4, A: 3e-4 },
        v2a: { Tvis: 0.3, Tsol: 1.0, Rvis: 0.3, Tuv: 4.0, lowironTvis: 0.005, lowironTsol: 0.015 },
        v6: { rms: 3, rmsHard: 9, VT: 2.0, SHGC: 0.03, Rout: 2.5, color: 5.5, U: 0.01 }
    };

    function escDefault(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
    }
    function num(x, sig, fmt) {
        if (fmt && fmt.num) return fmt.num(x, sig);
        if (x == null || isNaN(x)) return 'n/a';
        if (x === 0) return '0';
        var r = Number(x.toPrecision(sig || 3));
        return String(r).replace(/^-/, '−');
    }

    /* ── Options of the glass selects ──────────────────────────────────── */
    function mmLabel(mm) { return String(Number(Number(mm).toFixed(2))); }
    function productLabel(p) {
        if (p.manufacturer === 'Generic') return p.name + ', ' + mmLabel(p.thicknessMm) + ' mm (IGDB ' + p.igdbId + ')';
        if (!p.manufacturer || /not given/i.test(p.manufacturer)) return p.name;
        return p.name + ' (' + p.manufacturer + ', IGDB ' + p.igdbId + ')';
    }
    // keep (optional): a value that must exist as an option without being marked selected, such as the glass a shared
    // link names. Calc takes the form's defaults from the 'selected' attributes, so those stay at the pane default.
    function glassOptionsHTML(selected, manifest, imports, esc, keep) {
        esc = esc || escDefault;
        function opt(value, label, disabled) {
            return '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + (disabled ? ' disabled' : '') + '>' + esc(label) + '</option>';
        }
        var h = '<optgroup label="Generic glass">' + Object.keys(GENERIC).map(function (k) { return opt(k, GENERIC[k].label); }).join('') + '</optgroup>';
        h += '<optgroup label="Measured products (IGDB)">';
        if (manifest && manifest.products && manifest.products.length) {
            h += manifest.products.map(function (p) { return opt('prod:' + p.id, productLabel(p)); }).join('');
        } else {
            h += '<option value="" disabled>Measured products could not load</option>';
        }
        h += '</optgroup>';
        var imps = (imports || []).map(function (p) { return opt('imp:' + p.id, p.name || 'Imported product'); });
        // A shared link (or a removed import) can name an import this browser does not have: keep it selectable, so the
        // calculator can say so instead of silently switching the pane to another glass.
        [selected, keep].forEach(function (x, j) {
            var sel = String(x == null ? '' : x);
            if (j === 1 && sel === String(selected == null ? '' : selected)) return;
            if (sel.indexOf('imp:') === 0 && !(imports || []).some(function (p) { return 'imp:' + p.id === sel; })) {
                imps.push(opt(sel, 'Imported product (not in this browser)'));
            }
        });
        if (imps.length) h += '<optgroup label="Your imported products">' + imps.join('') + '</optgroup>';
        return h;
    }

    /* ── Form state ────────────────────────────────────────────────────── */
    // Plausible input ranges (the ISO 15099 correlations are meant for real windows): glazing height and gas gap, in m.
    var RANGE = { H: [0.1, 10], gap: [0.001, 0.1] };
    // v: Calc values (lengths in m). Returns { state, errors: [{ msg, field }] }. fills (optional): the engine's fill
    // keys (Object.keys(GlazingEngine.FILLS)); when given, an unknown fill is an error.
    function readState(v, fills) {
        var errors = [];
        var np = parseInt(v.np, 10);
        if (!(np >= 1 && np <= 3)) { errors.push({ msg: 'Choose 1, 2 or 3 panes.', field: 'np' }); np = 2; }
        if (typeof v.H === 'number' && v.H > 0 && (v.H < RANGE.H[0] - 1e-12 || v.H > RANGE.H[1] + 1e-12)) {
            errors.push({ msg: 'Glazing height must be between 0.1 and 10 m (the convection correlations are for real windows).', field: 'H' });
        }
        var view = v.view === 'open' || v.view === 'classic' ? v.view : 'both';
        var state = { np: np, H: v.H, view: view, solar: v.sol === 'g173' ? 'G173' : 'E891', panes: [], gaps: [] };
        for (var i = 1; i <= np; i++) {
            var g = String(v['p' + i + 'g'] == null ? '' : v['p' + i + 'g']);
            var pane = { i: i, src: 'generic', glass: null, id: null, mm: parseFloat(v['p' + i + 't']), coat: v['p' + i + 'c'] == null ? 'none' : String(v['p' + i + 'c']),
                faces: v['p' + i + 's'] === 'front' ? 'outdoors' : 'indoors' };
            if (g.indexOf('prod:') === 0) { pane.src = 'product'; pane.id = g.slice(5); }
            else if (g.indexOf('imp:') === 0) { pane.src = 'import'; pane.id = g.slice(4); }
            else if (GENERIC[g]) { pane.glass = g; }
            else errors.push({ msg: g ? 'Unknown glass for pane ' + i + '.' : 'Choose a glass for pane ' + i + '.', field: 'p' + i + 'g' });
            if (pane.src === 'generic') {
                // A select set to a value it does not offer (a stale or hand-edited link) reads as ''.
                if (THICK.indexOf(pane.mm) < 0) errors.push({ msg: 'Choose a thickness for pane ' + i + '.', field: 'p' + i + 't' });
                if (!COAT_LABELS[pane.coat]) errors.push({ msg: 'Choose a coating for pane ' + i + '.', field: 'p' + i + 'c' });
                else if (pane.coat !== 'none' && v['p' + i + 's'] !== 'front' && v['p' + i + 's'] !== 'back') {
                    errors.push({ msg: 'Choose which way the coating faces for pane ' + i + '.', field: 'p' + i + 's' });
                }
            }
            state.panes.push(pane);
            if (i < np) {
                var fill = v['g' + i + 'f'], vac = fill === 'vacuum';
                if (fills && fills.indexOf(fill) < 0) errors.push({ msg: 'Choose a fill for gap ' + i + '.', field: 'g' + i + 'f' });
                if (vac && !(v['g' + i + 'pd'] < v['g' + i + 'ps'])) errors.push({ msg: 'Pillar diameter must be smaller than the spacing.', field: 'g' + i + 'pd' });
                var w = v['g' + i + 'w'];
                if (!vac && typeof w === 'number' && w > 0 && (w < RANGE.gap[0] - 1e-12 || w > RANGE.gap[1] + 1e-12)) {
                    errors.push({ msg: 'Gap ' + i + ' width must be between 1 and 100 mm.', field: 'g' + i + 'w' });
                }
                state.gaps.push({ fill: fill, width: vac ? 0.0003 : v['g' + i + 'w'], pillarSpacing: v['g' + i + 'ps'], pillarRadius: v['g' + i + 'pd'] / 2 });
            }
        }
        return { state: state, errors: errors };
    }

    /* ── Layers and runs ───────────────────────────────────────────────── */
    function buildLayers(state, model, deps) {
        var E = deps.E, out = { layers: [], gaps: state.gaps, coat: [], pending: [], unavailable: null };
        for (var j = 0; j < state.panes.length; j++) {
            var p = state.panes[j], layer;
            if (p.src === 'generic') {
                if (model === 'classic' && !GENERIC[p.glass].classic) {
                    out.unavailable = 'The classic model has no ' + GENERIC[p.glass].label.toLowerCase() + ' glass; choose clear or low-iron to compare.';
                    return out;
                }
                var side = p.faces === 'outdoors' ? 'front' : 'back';
                layer = model === 'open' ? E.pane(p.glass, p.mm, p.coat, side, 'open') : E.pane(p.glass, p.mm, p.coat, side);
                out.coat.push(p.coat !== 'none' && p.faces === 'outdoors', p.coat !== 'none' && p.faces === 'indoors');
            } else {
                var prod = p.src === 'product' ? deps.getProduct(p.id) : deps.getImport(p.id);
                if (!prod) {
                    var key = p.src === 'import' ? 'imp:' + p.id : p.id;
                    if (out.pending.indexOf(key) < 0) out.pending.push(key);
                    out.layers.push(null); out.coat.push(false, false);
                    continue;
                }
                layer = E.imported(prod, deps.P.flipFor(prod, p.faces));
                out.coat.push(layer.ef < 0.5, layer.eb < 0.5);
            }
            out.layers.push(layer);
        }
        return out;
    }

    // Measured or imported panes whose data do not cover 300-2500 nm: the engine holds the end values constant outside
    // the data, so UV (data starting above 305 nm) and the solar quantities are not measured there.
    function importNotes(state, deps) {
        var out = { notes: [], uvUnavailable: false };
        state.panes.forEach(function (p) {
            if (p.src === 'generic') return;
            var prod = p.src === 'product' ? deps.getProduct(p.id) : deps.getImport(p.id);
            if (!prod || !prod.wl || !prod.wl.length) return;
            var lo = prod.wl[0], hi = prod.wl[prod.wl.length - 1];
            if (lo > 305 + 1e-6) out.uvUnavailable = true;
            // Slack: 5 nm at the short end (IGDB 913 starts at 305 nm), 10 nm at the long end (913's last row at or below
            // 2500 nm is 2494 nm); the solar weight held constant over so little is negligible.
            if (lo > 305 + 1e-6 || hi < 2490 - 1e-6) {
                out.notes.push('Pane ' + p.i + ': the ' + (p.src === 'import' ? 'imported' : 'measured') + ' data cover ' + Math.round(lo) + '–' + Math.round(hi) +
                    ' nm; outside that range the end values are held constant, so ' + (lo > 305 + 1e-6 ? 'UV transmittance is not available and ' : '') +
                    'the solar quantities are approximate.');
            }
        });
        return out;
    }

    function evaluateModels(state, deps) {
        var E = deps.E, opts = state.solar === 'E891' ? { solar: deps.solarE891 } : undefined;
        var res = { classic: null, open: null, pending: [], notes: [] };
        var view = state.view;
        if (!deps.open && view !== 'classic') {
            res.notes.push('The open-data model is not available here; the classic model is shown.');
            view = 'classic';
        }
        var want = view === 'both' ? ['classic', 'open'] : [view];
        want.forEach(function (model) {
            var b = buildLayers(state, model, deps);
            if (b.unavailable) { res.notes.push(b.unavailable); return; }
            if (b.pending.length) { b.pending.forEach(function (id) { if (res.pending.indexOf(id) < 0) res.pending.push(id); }); return; }
            res[model] = { r: E.evaluate(b.layers, b.gaps, state.H, opts), layers: b.layers, gaps: b.gaps, coat: b.coat };
        });
        if (view === 'both') {
            state.panes.forEach(function (p) {
                if (p.src !== 'generic') res.notes.push('Pane ' + p.i + ' uses measured data, so it is identical in both models.');
            });
        }
        var imp = importNotes(state, deps);
        res.uvUnavailable = imp.uvUnavailable;
        imp.notes.forEach(function (n) { res.notes.push(n); });
        res.notes.push(state.solar === 'E891'
            ? 'Solar weighting: ASTM E891 direct normal, the spectrum of LBNL’s NFRC calculations.'
            : 'Solar weighting: ASTM G173 direct + circumsolar, as in the current calculator.');
        return res;
    }

    // Ultraviolet transmittance as manufacturers' datasheets compute it in LBNL WINDOW (NFRC standard
    // W5_NFRC_2003.std, method TUV): the ASTM E891 source spectrum on its own wavelength points from 310 to 380 nm,
    // trapezoidal rule. T: a spectrum on the engine grid (300 + 5i nm); table: GlazingSolarE891.tuvTable,
    // [[nm, E], ...]. This is the quantity datasheets publish as "UV"; the results table's "UV transmittance
    // (300–380 nm)" is the engine's 5 nm bin average, a different (and slightly larger) number.
    function tuvNFRC(T, table) {
        if (!T || !table || table.length < 2) return NaN;
        function at(nm) {
            var x = (nm - 300) / 5, i = Math.floor(x + 1e-9), f = x - i;
            if (i < 0) return T[0];
            if (i >= T.length - 1) return T[T.length - 1];
            return f < 1e-9 ? T[i] : T[i] + f * (T[i + 1] - T[i]);
        }
        var num = 0, den = 0;
        for (var j = 1; j < table.length; j++) {
            var a = table[j - 1], b = table[j], dl = b[0] - a[0];
            num += 0.5 * (at(a[0]) * a[1] + at(b[0]) * b[1]) * dl;
            den += 0.5 * (a[1] + b[1]) * dl;
        }
        return num / den;
    }

    function dewPoint(T, rh) { var a = 17.62, b = 243.12, g = Math.log(rh) + a * T / (b + T); return b * g / (a - g); }

    function metrics(r, np) {
        var Uip = r.U / BTU;
        return {
            U: r.U, Uip: Uip, SHGC: r.SHGC, VT: r.Tvis, Rvis: r.Rvis, RvisIn: r.RvisIn,
            Tsol: r.Tsol, Rsol: r.Rsol, RsolIn: r.RsolIn, Asol: r.Asol.slice(), Tuv: r.Tuv,
            LSG: r.Tvis / r.SHGC, Rip: 1 / Uip, Rsi: 1 / r.U,
            Tin: r.winter.temps[2 * np - 1] - 273.15, dew50: dewPoint(21, 0.5)
        };
    }

    var ROWS = [
        ['U', 'U-factor (W/m²·K)', 'num'], ['Uip', 'U-factor (Btu/h·ft²·°F)', 'num'], ['SHGC', 'SHGC', 'num'],
        ['VT', 'Visible transmittance', 'pct'], ['Rvis', 'Visible reflectance, outside', 'pct'], ['RvisIn', 'Visible reflectance, inside', 'pct'],
        ['Tsol', 'Solar transmittance', 'pct'], ['Rsol', 'Solar reflectance, outside', 'pct'], ['RsolIn', 'Solar reflectance, inside', 'pct'],
        ['Asol', 'Solar absorptance', 'pct'], ['Tuv', 'UV transmittance (300–380 nm)', 'pct'], ['LSG', 'Light-to-solar gain', 'num'],
        ['Rip', 'R-value (h·ft²·°F/Btu)', 'num'], ['Tin', 'Indoor glass temperature, winter (°C)', 'num']
    ];
    function comparisonRows(mc, mo) {
        var out = [], any = mc || mo;
        if (!any) return out;
        ROWS.forEach(function (d) {
            var key = d[0], label = d[1], kind = d[2], k = kind === 'pct' ? 100 : 1;
            function push(key2, label2, c, o) {
                var cv = c == null ? null : c * k, ov = o == null ? null : o * k;
                out.push({ key: key2, label: label2, c: cv, o: ov, d: cv != null && ov != null ? ov - cv : null, kind: kind });
            }
            if (key === 'Asol') {
                var n = any.Asol.length;
                for (var i = 0; i < n; i++) push('A' + (i + 1), label + ', pane ' + (i + 1), mc ? mc.Asol[i] : null, mo ? mo.Asol[i] : null);
            } else {
                push(key, label, mc ? mc[key] : null, mo ? mo[key] : null);
            }
        });
        return out;
    }

    // Δ with a sign and fixed decimals (3 for U and SHGC, 2 otherwise; percent quantities in points).
    var DELTA_DEC = { U: 3, Uip: 3, SHGC: 3 };
    function signed(x, key) {
        if (x == null || isNaN(x)) return 'n/a';
        var dec = DELTA_DEC[key] || 2, s = Math.abs(x).toFixed(dec);
        if (Number(s) === 0) return '0';
        return (x > 0 ? '+' : '−') + s;
    }
    // 3 significant figures with trailing zeros kept (0.400, 34.0 %), so a column's decimals line up; true minus sign.
    function sig3(x, fmt) {
        var a = Math.abs(x);
        if (a === 0) return '0';
        var s = a >= 1e3 && a < 1e5 ? x.toFixed(0) : a >= 1e-3 && a < 1e3 ? x.toPrecision(3) : null;
        return s == null ? num(x, 3, fmt) : s.replace(/^-/, '−');
    }
    function cell(x, kind, fmt) {
        if (x == null || isNaN(x)) return 'n/a';
        return sig3(x, fmt) + (kind === 'pct' ? ' %' : '');
    }
    function tableHTML(rows, view, fmt) {
        var both = view === 'both';
        var h = '<table class="cmp"><caption>' + (both ? 'Performance by material model (Δ = open − classic; percent quantities in points)'
            : view === 'open' ? 'Performance, open-data model' : 'Performance, classic model') + '</caption><thead><tr><th scope="col">Quantity</th>';
        h += both ? '<th scope="col">Classic</th><th scope="col">Open data</th><th scope="col">Δ</th>' : '<th scope="col">' + (view === 'open' ? 'Open data' : 'Classic') + '</th>';
        h += '</tr></thead><tbody>';
        rows.forEach(function (r) {
            h += '<tr><th scope="row">' + r.label + '</th>';
            if (both) h += '<td>' + cell(r.c, r.kind, fmt) + '</td><td>' + cell(r.o, r.kind, fmt) + '</td><td>' + (r.d == null ? 'n/a' : signed(r.d, r.key) + (r.kind === 'pct' ? ' pt' : '')) + '</td>';
            else h += '<td>' + cell(view === 'open' ? r.o : r.c, r.kind, fmt) + '</td>';
            h += '</tr>';
        });
        return h + '</tbody></table>';
    }

    var KPIS = [['U', 'U-factor, W/m²·K', 1, ''], ['Uip', 'U-factor, Btu/h·ft²·°F', 1, ''], ['SHGC', 'SHGC', 1, ''], ['VT', 'Visible transmittance', 100, ' %']];
    function kpiHTML(mc, mo, view, fmt) {
        return KPIS.map(function (k) {
            function val(m) { return m ? num(m[k[0]] * k[2], 3, fmt) + k[3] : 'n/a'; }
            var big, small = '';
            if (view === 'both') { big = val(mo); small = '<small>classic ' + val(mc) + '</small>'; }
            else big = val(view === 'open' ? mo : mc);
            return '<div class="kpi"><b>' + big + '</b>' + small + '<span>' + k[1] + '</span></div>';
        }).join('');
    }

    function swatchesHTML(rc, ro, view, fmt) {
        function sw(c, label) {
            return '<span class="sw"><i style="background:rgb(' + c.rgb.join(',') + ')"></i><span>' + label + '<br>L* ' + num(c.L, 3, fmt) +
                ', a* ' + num(c.a, 2, fmt) + ', b* ' + num(c.b, 2, fmt) + '</span></span>';
        }
        function group(r, title) {
            if (!r) return '';
            return '<div class="sw-group">' + (title ? '<span class="sw-title">' + title + '</span>' : '') +
                sw(r.colorT, 'Transmitted') + sw(r.colorR, 'Reflected, outside') + sw(r.colorRin, 'Reflected, inside') + '</div>';
        }
        if (view === 'both') return group(ro, 'Open data') + group(rc, 'Classic');
        return group(view === 'open' ? ro : rc, '');
    }

    /* ── Cross-section (port of the live page's drawing) ───────────────── */
    function xsecSVG(np, layers, gaps, temps, coat, fillLabels, esc) {
        esc = esc || escDefault;
        var W = 480, H = 228, x0 = 84, x1 = W - 84, top = 50, bot = 190;   // narrow enough that the labels stay legible on a phone
        var disp = [];
        for (var i = 0; i < np; i++) {
            disp.push({ kind: 'pane', w: Math.max(layers[i].t * 1000, 2) });
            if (i < np - 1) disp.push({ kind: 'gap', w: gaps[i].fill === 'vacuum' ? 2.5 : Math.max(gaps[i].width * 1000, 3), g: gaps[i] });
        }
        var tot = disp.reduce(function (a, d) { return a + d.w; }, 0), k = (x1 - x0) / tot;
        var x = x0, g = '';
        var sx = [];
        g += '<text class="lbl" x="' + (x0 - 14) + '" y="' + (top - 26) + '" text-anchor="end">Outdoors</text>';
        g += '<text class="lbl" x="' + (x1 + 14) + '" y="' + (top - 26) + '">Indoors</text>';
        g += '<path class="sun" d="M20 70 L' + (x0 - 12) + ' 110"/><path class="sunh" d="M' + (x0 - 12) + ' 110 l-11 -2 l6 -8 z"/><circle class="sunh" cx="18" cy="66" r="7"/>';
        disp.forEach(function (d) {
            var w = d.w * k;
            if (d.kind === 'pane') {
                g += '<rect class="glass" x="' + x + '" y="' + top + '" width="' + w + '" height="' + (bot - top) + '"/>';
                sx.push(x, x + w);
            } else {
                var vac = d.g.fill === 'vacuum';
                g += '<rect class="' + (vac ? 'vac' : 'gapf') + '" x="' + x + '" y="' + top + '" width="' + w + '" height="' + (bot - top) + '"/>';
                if (vac) [-62, -36, 36, 62].forEach(function (dy) { g += '<rect class="pillar" x="' + (x + w / 2 - 1.5) + '" y="' + ((top + bot) / 2 + dy - 1.5) + '" width="3" height="3"/>'; });   // clear of the label
                var fl = String((fillLabels && fillLabels[d.g.fill]) || d.g.fill);
                g += '<text class="lbl-s" transform="translate(' + (x + w / 2 + 4) + ',' + ((top + bot) / 2) + ') rotate(-90)" text-anchor="middle">' +
                    (vac ? 'vacuum' : esc((Math.round(d.g.width * 1e4) / 10) + ' mm ' + fl.split(' ')[0].toLowerCase())) + '</text>';
            }
            x += w;
        });
        sx.forEach(function (xs, i) {
            g += '<text class="lbl-s" x="' + xs + '" y="' + (top - 6) + '" text-anchor="middle">#' + (i + 1) + '</text>';
            if (coat[i]) g += '<line class="coat" x1="' + xs + '" y1="' + top + '" x2="' + xs + '" y2="' + bot + '"/>';
            if (temps) g += '<text class="lbl-t" x="' + xs + '" y="' + (bot + 16 + (i % 2) * 14) + '" text-anchor="middle">' + String(Math.round((temps[i] - 273.15) * 10) / 10).replace('-', '−') + '°</text>';
        });
        return '<svg viewBox="0 0 ' + W + ' ' + H + '">' + g + '</svg>';
    }

    /* ── Attribution ───────────────────────────────────────────────────── */
    function attributionHTML(productsUsed, manifest, P) {
        var seen = {}, out = [];
        (productsUsed || []).forEach(function (p) {
            if (!p) return;
            var key = (p.source ? 'prod:' : 'imp:') + (p.id || p.name);
            if (seen[key]) return;
            seen[key] = true;
            var a = P.attribution(p, manifest);
            if (a && a.html) out.push('<p>' + a.html + '</p>');
        });
        return out.join('');
    }

    /* ── Published datasheets ──────────────────────────────────────────── */
    var GROUPS = [['clear', 'Clear glass'], ['hard', 'Hard coat'], ['single', 'Single silver'], ['double', 'Double silver'], ['triple', 'Triple silver'], ['mixed', 'Mixed triple']];
    var ROLE_LABEL = { calibrate: 'calibration', check: 'held out' };
    var SRC_SHORT = { 'cardinal-cg09': 'Cardinal', 'cardinal-loe180': 'Cardinal', 'vitro-igu-2026': 'Vitro', 'pilkington-ea-2011': 'Pilkington' };
    var DEFAULT_ROW = 'vitro-6-sb60-s2';
    function makeup(row) {
        var parts = [];
        row.panes.forEach(function (p, i) { parts.push(String(p.mm)); if (i < row.gaps.length) parts.push(String(row.gaps[i])); });
        return parts.join('/');
    }
    function rowLabel(row) {
        var role = ROLE_LABEL[row.role] || 'glass check';
        var surf = [];
        row.panes.forEach(function (p, i) { if (p.coat) surf.push(2 * i + (p.side === 'front' ? 1 : 2)); });
        var name = row.product || ((SRC_SHORT[row.src] || 'Manufacturer') + ' clear / clear');
        if (row.panes.length === 1) return name + ', ' + makeup(row) + ' mm monolithic (' + role + ')';
        return name + (surf.length === 1 ? ' on #' + surf[0] : '') + ', ' + makeup(row) + ' mm (' + role + ')';
    }
    function datasheetOptionsHTML(published, selected, esc) {
        esc = esc || escDefault;
        selected = selected || DEFAULT_ROW;
        var rows = (published && published.rows) || [];
        return GROUPS.map(function (g) {
            var rs = rows.filter(function (r) { return r.class === g[0]; });
            if (!rs.length) return '';
            return '<optgroup label="' + g[1] + '">' + rs.map(function (r) {
                return '<option value="' + esc(r.id) + '"' + (r.id === selected ? ' selected' : '') + '>' + esc(rowLabel(r)) + '</option>';
            }).join('') + '</optgroup>';
        }).join('');
    }

    var MKEYS = [
        ['VT', 'Visible transmittance (%)'], ['Rout', 'Visible reflectance, outside (%)'], ['Rin', 'Visible reflectance, inside (%)'],
        ['SHGC', 'SHGC'], ['Uair', 'U-factor, air (Btu/h·ft²·°F)'], ['Uar', 'U-factor, 90 % argon (Btu/h·ft²·°F)'],
        ['U', 'U-factor, monolithic (Btu/h·ft²·°F)'], ['UV', 'UV transmittance, 310–380 nm (%)'], ['Tsol', 'Solar transmittance (%)']
    ];
    function rKey(key) { return key === 'Rout' || key === 'Rin' ? 'R' : key === 'Uair' || key === 'Uar' ? 'U' : key; }
    // Tolerance of a published quantity for the generic (open / classic) columns: { tol, report }.
    function tolFor(row, key) {
        var k = rKey(key), t;
        if (!row.role) { t = TOL.glass[key] !== undefined ? TOL.glass[key] : TOL.glass[k]; return { tol: t == null ? null : t, report: t == null }; }
        if (row.class === 'hard' && TOL.hardReport.indexOf(key) >= 0) return { tol: null, report: true };
        var T = TOL[row.role] || TOL.check;
        t = k === 'R' && row.role === 'calibrate' && row.class === 'triple' ? T.Rtriple : T[k];
        return { tol: t == null ? null : t, report: t == null };
    }
    // Tolerance for the measured-record column (spec 5.2, last row).
    function tolMeasuredFor(row, key) {
        var k = rKey(key), M = TOL.measured, t;
        if (row.class === 'hard' && TOL.hardReport.indexOf(key) >= 0) return { tol: null, report: true };
        t = k === 'R' ? (TOL.measuredRwide.indexOf(row.igdb) >= 0 ? M.Rwide : M.R) : M[k];
        return { tol: t == null ? null : t, report: t == null };
    }
    function pick(a, r, key, tuvTable) {
        switch (key) {
            case 'VT': return 100 * a.Tvis;
            case 'Rout': return 100 * a.Rvis;
            case 'Rin': return 100 * a.RvisIn;
            case 'SHGC': return a.SHGC;
            case 'Uair': case 'U': return a.U / BTU;
            case 'Uar': return r ? r.U / BTU : null;
            case 'UV': return 100 * tuvNFRC(a.sys.T, tuvTable);   // WINDOW's TUV, as the datasheets compute it
            case 'Tsol': return 100 * a.Tsol;
        }
        return null;
    }
    function datasheetCompare(row, deps) {
        var E = deps.E, P = deps.P, opts = { solar: deps.solarE891 };
        var tuvTable = deps.tuvTable || (root.GlazingSolarE891 && root.GlazingSolarE891.tuvTable);
        var gapsFor = function (fill) { return row.gaps.map(function (w) { return { fill: fill, width: w / 1000 }; }); };
        var mono = row.panes.length === 1;
        function run(L) {
            if (!L) return null;
            var a = E.evaluate(L, gapsFor('air'), 1, opts);
            var r = mono ? null : E.evaluate(L, gapsFor('argon'), 1, opts);
            return { a: a, r: r };
        }
        var out = { metrics: [], colors: { open: null, classic: null, measured: null }, pending: [], notes: [] };
        var runs = {};
        runs.classic = run(row.panes.map(function (p) { return E.pane(p.glass, p.mm, p.coat || 'none', p.side || 'front'); }));
        if (deps.open) runs.open = run(row.panes.map(function (p) { return E.pane(p.glass, p.mm, p.coat || 'none', p.side || 'front', 'open'); }));
        else { runs.open = null; out.notes.push('The open-data model is not available here.'); }
        runs.measured = null;
        if (row.igdb) {
            var prod = deps.getProduct(row.igdb);
            if (!prod) out.pending.push(row.igdb);
            else if (deps.open) {
                runs.measured = run(row.panes.map(function (p) {
                    return p.coat ? E.imported(prod, P.flipFor(prod, p.side === 'front' ? 'outdoors' : 'indoors')) : E.pane(p.glass, p.mm, 'none', 'front', 'open');
                }));
            }
        }
        MKEYS.forEach(function (d) {
            var key = d[0];
            if (row[key] == null) return;
            var t = tolFor(row, key), tm = tolMeasuredFor(row, key);
            function v(x) { return x ? pick(x.a, x.r, key, tuvTable) : null; }
            out.metrics.push({ key: key, label: d[1], pub: row[key], open: v(runs.open), classic: v(runs.classic), measured: v(runs.measured),
                tol: t.tol, report: t.report, tolMeasured: tm.tol, reportMeasured: tm.report });
        });
        ['open', 'classic', 'measured'].forEach(function (k) { out.colors[k] = runs[k] ? runs[k].a.colorR : null; });
        return out;
    }

    function formValuesFor(row) {
        var o = { np: String(row.panes.length), H: '1', H_u: 'm' };
        // Defaults first, for the panes and gaps the row does not use (they may hold anything, even invalid text).
        for (var d = 1; d <= 3; d++) {
            o['p' + d + 'g'] = 'clear'; o['p' + d + 't'] = '6'; o['p' + d + 'c'] = 'none'; o['p' + d + 's'] = 'front';
            if (d < 3) { o['g' + d + 'f'] = 'argon'; o['g' + d + 'w'] = '12.7'; o['g' + d + 'w_u'] = 'mm'; o['g' + d + 'ps'] = '25'; o['g' + d + 'pd'] = '0.5'; }
        }
        row.panes.forEach(function (p, k) {
            var i = k + 1;
            o['p' + i + 'g'] = p.glass;
            o['p' + i + 't'] = String(p.mm);
            o['p' + i + 'c'] = p.coat || 'none';
            o['p' + i + 's'] = p.side || 'front';
        });
        row.gaps.forEach(function (w, k) {
            var i = k + 1;
            o['g' + i + 'f'] = 'argon';
            o['g' + i + 'w'] = String(w);
            o['g' + i + 'w_u'] = 'mm';
        });
        return o;
    }

    function status(delta, tol) {
        if (tol == null || delta == null || !isFinite(delta)) return 'info';
        var a = Math.abs(delta);
        if (a <= tol + 1e-12) return 'ok';
        if (a <= 2 * tol + 1e-12) return 'warn';
        return 'bad';
    }

    var api = {
        THICK: THICK, GENERIC: GENERIC, COAT_LABELS: COAT_LABELS, TOL: TOL, BTU: BTU, DEFAULT_ROW: DEFAULT_ROW,
        glassOptionsHTML: glassOptionsHTML, productLabel: productLabel,
        readState: readState, buildLayers: buildLayers, evaluateModels: evaluateModels,
        metrics: metrics, comparisonRows: comparisonRows, tableHTML: tableHTML, kpiHTML: kpiHTML, swatchesHTML: swatchesHTML,
        xsecSVG: xsecSVG, attributionHTML: attributionHTML, tuvNFRC: tuvNFRC,
        datasheetOptionsHTML: datasheetOptionsHTML, rowLabel: rowLabel, datasheetCompare: datasheetCompare,
        tolFor: tolFor, tolMeasuredFor: tolMeasuredFor, formValuesFor: formValuesFor, status: status,
        dewPoint: dewPoint, esc: escDefault, RANGE: RANGE, importNotes: importNotes
    };
    root.GlazingBeta = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
