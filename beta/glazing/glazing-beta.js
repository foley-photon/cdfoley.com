/* Glazing Performance Calculator (open-data beta): page controller.
   Builds the pane and gap cards, runs the main calculator (Calc id 'glzb') with the classic and open-data
   material models side by side, draws the spectra, and wires the datasheet comparison (Calc id 'cmp'), the
   coatings panel, the self-test and the importer. The physics is in glazing-engine.js and glazing-open.js; the
   pure page logic is in beta-core.js (window.GlazingBeta). Our own code. */
document.addEventListener('DOMContentLoaded', function () {
    'use strict';
    var E = window.GlazingEngine, Wt = window.GlazingWeights, B = window.GlazingBeta, P = window.GlazingProducts;
    if (!E || !B || !window.Calc || !P) return;
    var fmt = Calc.fmt;
    var $ = function (id) { return document.getElementById(id); };
    var qa = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
    var esc = B.esc;
    var DATA = '/assets/data/glazing/';
    var IMP_KEY = 'glz-beta-imports';

    // 1. Models
    // The open model also needs its calibrated coatings (glazing-coatings.js); without them every coated pane would fail.
    var openOK = !!(window.GlazingOpen && E.MODELS && E.MODELS.open && window.GlazingCoatings && GlazingCoatings.coatings &&
        Object.keys(GlazingCoatings.coatings).length && GlazingOpen.COATINGS && Object.keys(GlazingOpen.COATINGS).length);
    var O = openOK ? window.GlazingOpen : null;
    var S891 = window.GlazingSolarE891 && window.GlazingSolarE891.solarE891;
    if (!openOK) {
        $('open-err').hidden = false;
        $('view-classic').checked = true;
        ['view-both', 'view-open'].forEach(function (id) { $(id).disabled = true; });
    }
    if (!S891) {
        var so = $('sol');
        so.querySelector('option[value="e891"]').disabled = true;
        so.value = 'g173';
    }
    if (/[?&]verify=1(&|$)/.test(location.search)) P.configure({ verify: true });

    var manifest = null, published = null;
    var products = {}, productErr = {}, loading = {};
    // Saved imports: keep only entries the calculator can use (a damaged or old-format entry must not break the page).
    function finiteArray(a, n) {
        if (!Array.isArray(a) || a.length !== n) return false;
        for (var i = 0; i < n; i++) if (typeof a[i] !== 'number' || !isFinite(a[i])) return false;
        return true;
    }
    function validImport(p) {
        if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) return false;
        if (!(typeof p.thickness === 'number' && isFinite(p.thickness) && p.thickness > 0)) return false;
        if (!(p.ef > 0 && p.ef <= 1 && p.eb > 0 && p.eb <= 1)) return false;
        var n = Array.isArray(p.wl) ? p.wl.length : 0;
        if (n < 20 || !finiteArray(p.wl, n) || !finiteArray(p.T, n) || !finiteArray(p.Rf, n) || !finiteArray(p.Rb, n)) return false;
        for (var i = 1; i < n; i++) if (!(p.wl[i] > p.wl[i - 1])) return false;
        return true;
    }
    var imports = [], droppedImports = 0, rawImports = null;
    try { rawImports = localStorage.getItem(IMP_KEY); } catch (e) { rawImports = null; }   // storage blocked: no imports
    if (rawImports) {
        var stored = null;
        try { stored = JSON.parse(rawImports); } catch (e) { stored = null; }
        if (Array.isArray(stored)) {
            imports = stored.filter(validImport);
            droppedImports = stored.length - imports.length;
        } else droppedImports = 1;
        if (droppedImports) saveImports();   // keep only what can be read
    }
    // Returns false when the browser would not store the list (storage full or blocked): imports then last for this visit.
    function saveImports() { try { localStorage.setItem(IMP_KEY, JSON.stringify(imports)); return true; } catch (e) { return false; } }
    function findImport(id) { for (var i = 0; i < imports.length; i++) if (imports[i].id === id) return imports[i]; return undefined; }
    function entryOf(id) {
        var ps = (manifest && manifest.products) || [];
        for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
        return null;
    }
    var deps = {
        E: E, open: openOK, P: P, solarE891: S891,
        getProduct: function (id) { return products[id]; },
        getImport: function (id) { return findImport(id); }
    };

    function timeout(p, ms) {
        return Promise.race([p, new Promise(function (res, rej) { setTimeout(function () { rej(new Error('timed out')); }, ms); })]);
    }
    var manifestP = timeout(P.loadManifest(), 4000).then(function (m) { manifest = m; }, function () { manifest = null; });
    var publishedP = timeout(fetch(DATA + 'published.json').then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
    }), 4000).then(function (j) { published = j; }, function () { published = null; });

    Promise.all([manifestP, publishedP]).then(init);

    var calc = null, cmpCalc = null, lastRun = null;

    function init() {
        try { initMain(); } catch (err) {
            // Nothing saved in this browser may stop the calculator: drop the saved imports and start once more.
            if (imports.length && !init.retried) {
                init.retried = true; droppedImports += imports.length; imports = []; saveImports();
                $('stack').innerHTML = '';
                try { initMain(); } catch (err2) { startFailed(err2); return; }
            } else { startFailed(err); return; }
        }
        initCompare();
        renderCoatings();
        initSelfTest();
        initImporter();
    }
    function startFailed(err) {
        var box = document.querySelector('#glzb .calc-error');
        if (box) { box.textContent = 'The calculator could not start: ' + (err && err.message ? err.message : String(err)) + ' Reload the page to try again.'; box.classList.add('show'); }
    }
    function initMain() {
        var hash = hashValues('glzb.');
        buildStack(hash);
        // Show the right cards and fields for the state the link (or the defaults) will set, before Calc's first run.
        layout(Object.assign(formValues(), hash));
        calc = Calc.create({ id: 'glzb', form: '#glzb', outputs: '#glzb-out', compute: safe(compute), after: function () { drawPlot(); },
            // no valid result: remove the spectra of the last one, so a resize cannot redraw them (as the live page does)
            onError: function () { lastRun = null; clearPlot(); } });
        // A link may set a select to a value it does not offer, which leaves it blank: restore those defaults.
        var fixed = false;
        if (!$('sol').value) { $('sol').value = S891 ? 'e891' : 'g173'; fixed = true; }
        if (!qa('#glzb input[name="view"]').some(function (r) { return r.checked; })) { $(openOK ? 'view-both' : 'view-classic').checked = true; fixed = true; }
        for (var i = 1; i <= 3; i++) {
            if (!$('p' + i + 's').value) { $('p' + i + 's').value = DEF[i - 1].s; fixed = true; }
        }
        if (fixed) { layout(formValues()); calc.run(); }
        // Cards and fields follow the raw control values at once, even while some field is invalid.
        var form = $('glzb');
        ['input', 'change'].forEach(function (ev) { form.addEventListener(ev, function () { layout(formValues()); }); });
        window.addEventListener('resize', function () { clearTimeout(drawPlot.t); drawPlot.t = setTimeout(drawPlot, 150); });
    }
    // The prefix.* values of the URL hash, as Calc reads them.
    function hashValues(prefix) {
        var out = {}, h = location.hash.replace(/^#/, '');
        if (!h || h.indexOf('=') < 0) return out;
        try { new URLSearchParams(h).forEach(function (val, key) { if (key.indexOf(prefix) === 0) out[key.slice(prefix.length)] = val; }); } catch (e) { /* ignore */ }
        return out;
    }
    // The current select and radio values of the main form (all that layout() reads).
    function formValues() {
        var v = {};
        qa('#glzb select[name], #glzb input[name]').forEach(function (c) {
            if (c.type === 'radio') { if (c.checked) v[c.name] = c.value; }
            else if (c.tagName === 'SELECT') v[c.name] = c.value;
        });
        return v;
    }
    function clearPlot() {
        if (window.Plot && Plot.clear) { Plot.clear('#glzb-plot'); return; }
        var c = $('glzb-plot');
        if (c) { clearTimeout(c._plotT); c.innerHTML = ''; c._plot = null; }   // plot.js redraws on resize only while _plot is set
    }

    // compute() may throw only Calc.fail: Calc logs anything else with console.error.
    function safe(fn) {
        return function (v) {
            try { return fn(v); } catch (err) {
                if (err instanceof Calc.CalcError) throw err;
                throw Calc.fail('Calculation error: ' + (err && err.message ? err.message : String(err)));
            }
        };
    }

    /* ── Pane and gap cards ────────────────────────────────────────────── */
    var DEF = [{ g: 'clear', t: 6, c: 'double', s: 'back' }, { g: 'clear', t: 6, c: 'none', s: 'front' }, { g: 'clear', t: 6, c: 'none', s: 'front' }];
    function buildStack(hash) {
        hash = hash || {};
        var coatOptions = Object.keys(B.COAT_LABELS).map(function (k) { return '<option value="' + k + '">' + B.COAT_LABELS[k] + '</option>'; }).join('');
        var fillOptions = Object.keys(E.FILLS).map(function (k) { return '<option value="' + k + '"' + (k === 'argon' ? ' selected' : '') + '>' + esc(E.FILLS[k].label) + '</option>'; }).join('');
        var html = '';
        for (var i = 1; i <= 3; i++) {
            var d = DEF[i - 1];
            html += '<div class="gl-card" data-pane="' + i + '"><h3><span>Pane ' + i + (i === 1 ? ' (outdoors)' : '') + '</span></h3>' +
                '<p class="pane-info" data-pane-info="' + i + '"></p>' +
                '<div class="field"><label for="p' + i + 'g">Glass</label><select id="p' + i + 'g" name="p' + i + 'g" class="input">' + B.glassOptionsHTML(d.g, manifest, imports, esc, hash['p' + i + 'g']) + '</select></div>' +
                '<div class="field-row">' +
                  '<div class="field" data-gen="' + i + '"><label for="p' + i + 't">Thickness</label><select id="p' + i + 't" name="p' + i + 't" class="input">' +
                    B.THICK.map(function (t) { return '<option value="' + t + '"' + (t === d.t ? ' selected' : '') + '>' + t + ' mm</option>'; }).join('') + '</select></div>' +
                  '<div class="field" data-gen="' + i + '"><label for="p' + i + 'c">Low-e coating</label><select id="p' + i + 'c" name="p' + i + 'c" class="input">' +
                    coatOptions.replace('value="' + d.c + '"', 'value="' + d.c + '" selected') + '</select></div>' +
                  '<div class="field" data-faces="' + i + '"><label for="p' + i + 's">Coating faces</label><select id="p' + i + 's" name="p' + i + 's" class="input">' +
                    '<option value="front"' + (d.s === 'front' ? ' selected' : '') + '>Outdoors</option><option value="back"' + (d.s === 'back' ? ' selected' : '') + '>Indoors</option></select></div>' +
                '</div></div>';
            if (i < 3) {
                html += '<div class="gl-card gap" data-gap="' + i + '"><h3><span>Gap ' + i + '</span></h3><div class="field-row">' +
                    '<div class="field"><label for="g' + i + 'f">Fill</label><select id="g' + i + 'f" name="g' + i + 'f" class="input">' + fillOptions + '</select></div>' +
                    '<div class="field" data-gas="' + i + '"><label for="g' + i + 'w">Width</label><div class="input-unit"><input id="g' + i + 'w" name="g' + i + 'w" value="12.7" inputmode="decimal" data-positive data-label="gap width"><select data-dim="length" data-units="mm,in" data-default="mm"></select></div></div>' +
                    '<div class="field" data-vac="' + i + '"><label for="g' + i + 'ps">Pillar spacing</label><div class="input-unit"><input id="g' + i + 'ps" name="g' + i + 'ps" value="25" inputmode="decimal" data-positive data-label="pillar spacing"><select data-dim="length" data-units="mm" data-default="mm"></select></div></div>' +
                    '<div class="field" data-vac="' + i + '"><label for="g' + i + 'pd">Pillar diameter</label><div class="input-unit"><input id="g' + i + 'pd" name="g' + i + 'pd" value="0.5" inputmode="decimal" data-positive data-label="pillar diameter"><select data-dim="length" data-units="mm" data-default="mm"></select></div></div>' +
                    '</div></div>';
            }
        }
        $('stack').innerHTML = html;
    }
    function refreshSelects() {
        for (var i = 1; i <= 3; i++) {
            var sel = $('p' + i + 'g'), cur = sel.value;
            sel.innerHTML = B.glassOptionsHTML(cur, manifest, imports, esc);
            if (sel.value !== cur) sel.value = 'clear';
        }
    }

    function srcOf(g) { g = String(g || ''); return g.indexOf('prod:') === 0 ? 'product' : g.indexOf('imp:') === 0 ? 'import' : 'generic'; }
    function mmText(x) { return Number.isInteger(x) ? x.toFixed(1) : String(Math.round(x * 1e4) / 1e4); }
    function epsText(x) { return String(Math.round(x * 1e4) / 1e4); }
    var IMPORT_EPS = { header: 'from the file header', computed: "computed from the file's infrared data", assumed: 'assumed 0.84' };
    function epsSources(p, labels) {
        var a = labels[p.efSource] || p.efSource, b = labels[p.ebSource] || p.ebSource;
        return a === b ? a : 'front ' + a + ', back ' + b;
    }

    // Shows and hides cards and fields for the current values, and writes the info line of each pane.
    // Returns true when it switched a numeric input between validated and plain text (the caller then reads again).
    function layout(v) {
        var np = parseInt(v.np, 10) || 2, changed = false;
        for (var i = 1; i <= 3; i++) {
            document.querySelector('[data-pane="' + i + '"]').hidden = i > np;
            if (i < 3) document.querySelector('[data-gap="' + i + '"]').hidden = i >= np;
            var g = v['p' + i + 'g'], src = srcOf(g), id = src === 'generic' ? null : String(g).slice(src === 'product' ? 5 : 4);
            qa('[data-gen="' + i + '"]').forEach(function (el) { el.hidden = src !== 'generic'; });
            var p = src === 'product' ? products[id] : src === 'import' ? findImport(id) : null;
            var coated;
            if (src === 'generic') coated = v['p' + i + 'c'] !== 'none';
            else if (src === 'product') coated = !!((p && p.coatedSide) || (entryOf(id) && entryOf(id).coatedSide));
            else coated = !!(p && p.coatedSide);
            qa('[data-faces="' + i + '"]').forEach(function (el) { el.hidden = !coated; });
            var n0 = 2 * i - 1, surf = 'Surfaces #' + n0 + ' and #' + (n0 + 1), info;
            if (src === 'generic' && !B.GENERIC[g]) info = surf + ' · choose a glass';
            else if (src === 'generic') {
                var c = v['p' + i + 'c'];
                if (c === 'none' || !B.COAT_LABELS[c]) info = surf + ' · uncoated, ε 0.84';
                else {
                    var cl = B.GENERIC[g] && B.GENERIC[g].classic ? String(E.COATINGS[c].eps) : 'n/a for this glass';
                    info = surf + ' · ε of the coated face: classic ' + cl + (O && O.COATINGS[c] ? ', open ' + O.COATINGS[c].eps : '');
                }
            } else if (src === 'product') {
                var en = entryOf(id);
                if (!p) info = surf + ' · ' + (en ? 'IGDB ' + en.igdbId + ' · ' : '') + (productErr[id] ? 'could not load' : 'loading measured data…');
                else {
                    var m = p.manufacturer && !/not given/i.test(p.manufacturer) ? p.manufacturer : 'manufacturer not given in the source';
                    info = surf + ' · IGDB ' + p.igdbId + ' · ' + m + ' · ' + mmText(p.thickness) + ' mm · ε ' + epsText(p.ef) + ' / ' + epsText(p.eb) +
                        ' (' + epsSources(p, P.EPS_SOURCE_LABELS) + ') · data: IGDB, CC BY-ND 4.0 (see the attribution below the results)';
                }
            } else {
                info = !p ? surf + ' · this imported product is not in this browser'
                    : surf + ' · imported' + (p.igdbId ? ' · IGDB ' + p.igdbId : '') + ' · ' + mmText(p.thickness) + ' mm · ε ' + epsText(p.ef) + ' / ' + epsText(p.eb) +
                      ' (' + epsSources(p, IMPORT_EPS) + ')';
            }
            document.querySelector('[data-pane-info="' + i + '"]').textContent = info;
            if (i < 3) {
                var vac = v['g' + i + 'f'] === 'vacuum', gapShown = i < np;
                qa('[data-gas="' + i + '"]').forEach(function (el) { el.hidden = vac; });
                qa('[data-vac="' + i + '"]').forEach(function (el) { el.hidden = !vac; });
                // Calc validates every numeric input; a hidden one is read as plain text instead, so text left in a
                // field the unit no longer uses cannot block the result.
                [['g' + i + 'w', gapShown && !vac], ['g' + i + 'ps', gapShown && vac], ['g' + i + 'pd', gapShown && vac]].forEach(function (f) {
                    var inp = $(f[0]);
                    if (!inp) return;
                    var wantText = !f[1];
                    if ((inp.dataset.text !== undefined) !== wantText) {
                        changed = true;
                        if (wantText) inp.dataset.text = ''; else delete inp.dataset.text;
                    }
                });
            }
        }
        return changed;
    }

    /* ── Product loading ───────────────────────────────────────────────── */
    function productName(id) { var e = entryOf(id); return e ? e.name : id; }
    function startLoads(ids) {
        ids.forEach(function (id) {
            if (loading[id] || products[id] || productErr[id]) return;
            loading[id] = P.loadProduct(id).then(function (p) { products[id] = p; }, function (e) { productErr[id] = (e && e.message) || 'Could not load ' + productName(id) + '.'; })
                .then(function () {
                    delete loading[id];
                    if (!Object.keys(loading).length) { if (calc) calc.run(); if (cmpCalc) cmpCalc.run(); }
                });
        });
    }

    /* ── Main calculator ───────────────────────────────────────────────── */
    var lastGlass = {};
    function compute(v) {
        // A set() or Reset changes the values without input events: if that changed which inputs are validated, read again.
        if (layout(v) && calc) v = calc.read();
        var rs = B.readState(v, Object.keys(E.FILLS));
        if (rs.errors.length) throw Calc.fail(rs.errors[0].msg, rs.errors[0].field);
        var st = rs.state;
        if (!S891) st.solar = 'G173';
        st.panes.forEach(function (p) {
            // Choosing a product again after a failed download retries it (the error stays while the choice is unchanged).
            var g = v['p' + p.i + 'g'];
            if (p.src === 'product' && productErr[p.id] && lastGlass[p.i] !== g) delete productErr[p.id];
        });
        for (var gi = 1; gi <= 3; gi++) lastGlass[gi] = gi <= st.np ? v['p' + gi + 'g'] : null;
        st.panes.forEach(function (p) {
            if (p.src === 'product' && productErr[p.id]) throw Calc.fail(productErr[p.id], 'p' + p.i + 'g');
            if (p.src === 'import' && !findImport(p.id)) throw Calc.fail('Imported product for pane ' + p.i + ' is not in this browser. Load it below or choose another glass.', 'p' + p.i + 'g');
        });
        var cond = 'NFRC 100 / 200 · ASTM ' + st.solar;
        var res = B.evaluateModels(st, deps);
        if (res.pending.length) {
            startLoads(res.pending);
            lastRun = null;
            return {
                cond: cond, xsec: { html: '' }, notes: { html: '' }, swatches: { html: '' }, attrib: { html: '' },
                kpis: { html: ['U-factor, W/m²·K', 'U-factor, Btu/h·ft²·°F', 'SHGC', 'Visible transmittance'].map(function (l) { return '<div class="kpi"><b>…</b><span>' + l + '</span></div>'; }).join('') },
                table: { html: '<p class="muted">Loading measured data for ' + res.pending.map(function (id) { return esc(productName(id)); }).join(', ') + '…</p>' }
            };
        }
        var main = res.open || res.classic;
        if (!main) {
            var gi = 1;
            st.panes.forEach(function (p) { if (p.src === 'generic' && !B.GENERIC[p.glass].classic && gi === 1) gi = p.i; });
            throw Calc.fail(res.notes[0], 'p' + gi + 'g');
        }
        var view = st.view;
        if (!openOK) view = 'classic';
        var mc = res.classic ? B.metrics(res.classic.r, st.np) : null, mo = res.open ? B.metrics(res.open.r, st.np) : null;
        if (res.uvUnavailable) [mc, mo].forEach(function (m) { if (m) m.Tuv = null; });   // no measured data below 305 nm
        var mm = mo || mc;
        var notes = res.notes.slice();
        if (mm.Tin < mm.dew50) notes.push('Indoor glass temperature in winter (' + fmt.num(mm.Tin, 3) + ' °C) is below the dew point of 21 °C air at 50 % RH (' + fmt.num(mm.dew50, 3) + ' °C): condensation likely in humid rooms.');
        var fillLabels = {};
        Object.keys(E.FILLS).forEach(function (k) { fillLabels[k] = E.FILLS[k].label; });
        var used = [];
        st.panes.forEach(function (p) { if (p.src === 'product') used.push(products[p.id]); else if (p.src === 'import') used.push(findImport(p.id)); });
        lastRun = { res: res, st: st, view: view };
        return {
            cond: cond,
            xsec: { html: B.xsecSVG(st.np, main.layers, main.gaps, main.r.winter.temps, main.coat, fillLabels, esc) },
            kpis: { html: B.kpiHTML(mc, mo, view, fmt) },
            notes: { html: notes.map(function (n) { return '<p>' + esc(n) + '</p>'; }).join('') },
            table: { html: B.tableHTML(B.comparisonRows(mc, mo), view, fmt) },
            swatches: { html: B.swatchesHTML(res.classic && res.classic.r, res.open && res.open.r, view, fmt) },
            attrib: { html: B.attributionHTML(used, manifest, P) }
        };
    }

    function drawPlot() {
        if (!window.Plot) return;
        if (!lastRun) { clearPlot(); return; }   // an error or a product still loading: no stale spectra
        var res = lastRun.res, x = Array.from(E.LAM);
        var ws = lastRun.st.solar === 'E891' && S891 ? S891 : Wt.solar;
        var smax = Math.max.apply(null, ws);
        var series = [{ type: 'band', x: x, y: Array.from(ws, function (w) { return 100 * w / smax; }), y0: x.map(function () { return 0; }), color: 'var(--c2)' }];
        var pc = function (a) { return Array.from(a, function (t) { return 100 * t; }); };
        if (lastRun.view === 'both' && res.open && res.classic) {
            series.push(
                { type: 'line', x: x, y: pc(res.open.r.sys.T), label: 'Transmittance, open', color: 'var(--c1)' },
                { type: 'line', x: x, y: pc(res.classic.r.sys.T), label: 'Transmittance, classic', color: 'var(--c1)', dash: true },
                { type: 'line', x: x, y: pc(res.open.r.sys.Rf), label: 'Reflectance outside, open', color: 'var(--c5)' },
                { type: 'line', x: x, y: pc(res.classic.r.sys.Rf), label: 'Reflectance outside, classic', color: 'var(--c5)', dash: true });
        } else {
            var one = (lastRun.view === 'classic' ? res.classic : res.open) || res.open || res.classic, s = one.r.sys;
            series.push(
                { type: 'line', x: x, y: pc(s.T), label: 'Transmittance', color: 'var(--c1)' },
                { type: 'line', x: x, y: pc(s.Rf), label: 'Reflectance, outside', color: 'var(--c5)' },
                { type: 'line', x: x, y: pc(s.Rb), label: 'Reflectance, inside', color: 'var(--c4)', dash: true });
        }
        Plot.draw('#glzb-plot', {
            height: 300,
            x: { label: 'Wavelength (nm)', min: 300, max: 2500 },
            y: { label: 'Percent', min: 0, max: 100 },
            series: series,
            vlines: [{ x: 380, label: '380', color: 'var(--muted)' }, { x: 780, label: '780 nm', color: 'var(--muted)' }],
            hover: { format: function (xv, hits) { return fmt.num(xv, 4) + ' nm · ' + hits.filter(function (h) { return h.series.label; }).map(function (h) { return h.series.label + ' ' + fmt.num(h.y, 3) + ' %'; }).join(' · '); } }
        });
    }

    /* ── Compare with a published datasheet ────────────────────────────── */
    var rowsById = {};
    var MARK = { ok: '✓', warn: '!', bad: '✗', info: '' };
    function initCompare() {
        var sel = $('row');
        if (!published || !published.rows) {
            sel.innerHTML = '<option value="">Published values could not load</option>';
            sel.disabled = true; $('cmp-load').disabled = true;
            $('cmp-out').innerHTML = '<p class="muted">The published datasheet values could not load. Check your connection and reload the page.</p>';
            return;
        }
        published.rows.forEach(function (r) { rowsById[r.id] = r; });
        sel.innerHTML = B.datasheetOptionsHTML(published, B.DEFAULT_ROW, esc);
        cmpCalc = Calc.create({ id: 'cmp', form: '#cmp', outputs: '#cmp-out', compute: safe(compareCompute) });
        $('cmp-load').addEventListener('click', function () {
            var row = rowsById[sel.value];
            if (!row || !calc) return;
            var vals = B.formValuesFor(row);
            vals.sol = S891 ? 'e891' : 'g173';
            calc.set(vals);   // compute() rereads when the new layout changes which fields are validated
            var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            $('glzb').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        });
    }
    function srcLink(id) {
        var s = published.sources && published.sources[id];
        if (!s) return esc(id);
        return '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.title) + '</a>';
    }
    var FRACTION_KEYS = { SHGC: 1, Uair: 1, Uar: 1, U: 1 };   // SHGC and U: fractions / Btu; the rest percent
    function fv(key, x) {
        if (x == null || !isFinite(x)) return '—';
        return FRACTION_KEYS[key] ? x.toFixed(3) : x.toFixed(1);
    }
    // Published values as printed: SHGC and U to 0.01, VT, R, UV and Tsol in whole percent.
    function pubText(key, x) {
        if (typeof x !== 'number' || !isFinite(x)) return esc(String(x));
        return FRACTION_KEYS[key] ? x.toFixed(2) : x.toFixed(0);
    }
    function minus(x, dec) { return x.toFixed(dec).replace(/^-/, '−'); }
    function deltaCell(key, x, pub, tol, report) {
        if (x == null || !isFinite(x)) return '<td>—</td>';
        var d = x - pub, st = report ? 'info' : B.status(d, tol);
        var mag = Math.abs(d).toFixed(FRACTION_KEYS[key] ? 3 : 1);
        var ds = Number(mag) === 0 ? mag : (d > 0 ? '+' : '−') + mag;   // no "−0.0"
        var word = { ok: 'within tolerance', warn: 'within twice the tolerance', bad: 'outside twice the tolerance', info: 'report only' }[st];
        return '<td>' + fv(key, x) + '<small class="s-' + st + '" title="' + word + '">' + (MARK[st] ? MARK[st] + ' ' : '') + ds + (st === 'info' ? ' (report)' : '') + '</small></td>';
    }
    // The measured column's tolerances, from the same table the cells use (B.tolMeasuredFor through c.metrics).
    var HINT_NAMES = { VT: 'VT', R: 'reflectance', SHGC: 'SHGC', U: 'U', UV: 'UV', Tsol: 'solar transmittance' };
    function measuredHint(row, metrics) {
        var tol = [], rep = [], seen = {};
        metrics.forEach(function (m) {
            var k = m.key === 'Rout' || m.key === 'Rin' ? 'R' : m.key === 'Uair' || m.key === 'Uar' ? 'U' : m.key;
            if (seen[k]) return;
            seen[k] = true;
            if (m.reportMeasured) rep.push(HINT_NAMES[k] || k);
            else tol.push((HINT_NAMES[k] || k) + ' ± ' + (k === 'R' || k === 'VT' ? Number(m.tolMeasured).toFixed(1) : String(m.tolMeasured)));
        });
        var s = 'Measured-record tolerances follow the self-test (V3): ' + tol.join(', ');
        if (rep.length) s += '; ' + (rep.length > 1 ? rep.slice(0, -1).join(', ') + ' and ' + rep[rep.length - 1] + ' are' : rep[0] + ' is') + ' report only' +
            (row.class === 'hard' ? ' (the 2011 sheet differs from the measured product)' : '');
        return s + '.';
    }
    var lastRow = null;
    function compareCompute(v) {
        // Choosing a row again after its record failed to download retries the download.
        if (v.row !== lastRow && rowsById[v.row] && rowsById[v.row].igdb) delete productErr[rowsById[v.row].igdb];
        lastRow = v.row;
        var row = rowsById[v.row];
        if (!row) throw Calc.fail('Choose a published configuration.', 'row');
        if (!S891) throw Calc.fail('The ASTM E891 solar spectrum could not load, so the datasheet comparison is unavailable.', 'row');
        var measErr = row.igdb && productErr[row.igdb];
        var c = B.datasheetCompare(row, deps);
        if (c.pending.length && !measErr) startLoads(c.pending);
        var s = published.sources[row.src] || {};
        // Source
        var src = '<p>' + srcLink(row.src) + (row.page ? ', page ' + row.page : '') + (s.method ? '. ' + esc(s.method) : '') + (s.retrieved ? '. Retrieved ' + esc(s.retrieved) : '') + '.</p>';
        if (row.alsoIn && row.alsoIn.length) src += '<p>Also in: ' + row.alsoIn.map(srcLink).join('; ') + '.</p>';
        src += '<p>' + (row.role === 'calibrate' ? '<span class="badge badge-warn">Used to calibrate the open coating</span>'
            : row.role === 'check' ? '<span class="badge badge-ok">Held out: not used in the fit</span>'
            : '<span class="badge">Glass check: uncoated, not part of the coating fit</span>') + '</p>';
        ['notes', 'geometryNote', 'substrateNote', 'igdbNote'].forEach(function (k) { if (row[k]) src += '<p>' + esc(row[k]) + '</p>'; });
        // Table
        var ent = row.igdb ? entryOf(row.igdb) : null;
        var measHead = row.igdb ? 'Measured record' + (ent ? ' (IGDB ' + ent.igdbId + ')' : '') : 'Measured record';
        var h = '<table class="cmp"><caption>' + esc(B.rowLabel(row)) + ': published values against the models (Δ = model − published)</caption><thead><tr>' +
            '<th scope="col">Quantity</th><th scope="col">Published</th><th scope="col">Open generic</th><th scope="col">Classic generic</th><th scope="col">' + esc(measHead) + '</th></tr></thead><tbody>';
        c.metrics.forEach(function (m) {
            h += '<tr><th scope="row">' + esc(m.label) + '<small>' + (m.report ? 'report only' : '± ' + m.tol) + '</small></th><td>' + pubText(m.key, m.pub) + '</td>' +
                deltaCell(m.key, m.open, m.pub, m.tol, m.report) + deltaCell(m.key, m.classic, m.pub, m.tol, m.report);
            if (!row.igdb) h += '<td>—</td>';
            else if (measErr) h += '<td>could not load</td>';
            else if (m.measured == null) h += '<td>loading…</td>';
            else h += deltaCell(m.key, m.measured, m.pub, m.tolMeasured, m.reportMeasured);
            h += '</tr>';
        });
        h += '</tbody></table>';
        if (row.igdb) h += '<p class="hint">' + esc(measuredHint(row, c.metrics)) + '</p>';
        if (row.UV != null) h += '<p class="hint">UV transmittance is computed as LBNL WINDOW computes it for datasheets: weighted by the ASTM E891 spectrum from 310 to 380 nm.' +
            ' The results above list UV transmittance from 300 to 380 nm, a slightly larger number.</p>';
        if (row.igdb) {
            if (measErr) h += '<p class="s-bad">' + esc(measErr) + '</p>';
            else if (products[row.igdb]) h += '<div class="attrib">' + B.attributionHTML([products[row.igdb]], manifest, P) + '</div>';
        }
        // Color
        var col = '<p>Exterior reflected color (CIELAB, D65, 2° observer; air fill):</p><div class="swatches">';
        [['open', 'Open generic'], ['classic', 'Classic generic'], ['measured', 'Measured record']].forEach(function (k) {
            var cc = c.colors[k[0]];
            if (!cc) return;
            col += '<span class="sw"><i style="background:rgb(' + cc.rgb.join(',') + ')"></i><span>' + k[1] + '<br>a* ' + minus(cc.a, 1) + ', b* ' + minus(cc.b, 1) + '</span></span>';
        });
        col += '</div>';
        if (row.role === 'calibrate' && row.panes.length > 1 && c.colors.open) {
            var W = B.TOL.window, a = c.colors.open.a, b = c.colors.open.b;
            var inW = a >= W.Ra[0] - W.margin && a <= W.Ra[1] + W.margin && b >= W.Rb[0] - W.margin && b <= W.Rb[1] + W.margin;
            var strict = a >= W.Ra[0] && a <= W.Ra[1] && b >= W.Rb[0] && b <= W.Rb[1];
            col += '<p>The open coating\'s exterior color ' + (strict ? '<span class="s-ok">✓ is inside</span>' : inW ? '<span class="s-ok">✓ is within ' + W.margin + ' of</span>'
                : '<span class="s-bad">✗ is outside</span>') + ' the neutral window used in the calibration (a* ' + minus(W.Ra[0], 1) + ' to ' + minus(W.Ra[1], 1) +
                ', b* ' + minus(W.Rb[0], 1) + ' to ' + minus(W.Rb[1], 1) + ', with a tolerance of ' + W.margin + ').</p>';
        }
        if (row.appearance) {
            col += '<blockquote>“' + esc(row.appearance.quote.replace(/\.?$/, '.')) + '” ' + srcLink(row.appearance.src) + '</blockquote>';
        }
        if (row.epsPublished != null) col += '<p>Published emissivity: ' + row.epsPublished + (row.epsSrc ? ' (' + srcLink(row.epsSrc) + ')' : '') +
            '; the open hard coat uses ' + (O && O.COATINGS.hard ? O.COATINGS.hard.eps : 'n/a') + ', inferred from the published U-factors.</p>';
        return { cmpsrc: { html: src }, cmptable: { html: h }, cmpcolor: { html: col } };
    }

    /* ── How the open coatings are built ───────────────────────────────── */
    var MAT_COLOR = { TiO2: 'var(--c1)', Ag: 'var(--c2)', Si3N4: 'var(--c3)', Ni: 'var(--c4)', SiO2: 'var(--c5)', SnO2: 'var(--c6)', FTO: 'var(--c3)', FTO_rough: 'var(--c5)', Ti: 'var(--c4)' };
    var RES_KEYS = [['VT', 'VT (%)'], ['Rout', 'Rout (%)'], ['Rin', 'Rin (%)'], ['SHGC', 'SHGC'], ['Uair', 'U air'], ['Uar', 'U argon'], ['U', 'U (monolithic)'], ['UV', 'UV, 310–380 nm (%)'], ['Tsol', 'Tsol (%)']];
    function stackSVG(key, c, M) {
        var L = c.layers.filter(function (l) { return l.d > 0; });
        var tot = L.reduce(function (a, l) { return a + l.d; }, 0);
        var W = 600, H = 64, gx = 54, x = gx, avail = W - gx - 6, minW = 3;
        var widths = L.map(function (l) { return Math.max(minW, avail * l.d / tot); });
        var k = avail / widths.reduce(function (a, b) { return a + b; }, 0);
        var g = '<rect class="glass" x="2" y="14" width="' + (gx - 4) + '" height="34"/><text x="' + (gx / 2) + '" y="60" text-anchor="middle">glass</text>';
        L.forEach(function (l, i) {
            var w = widths[i] * k;
            g += '<rect x="' + x.toFixed(1) + '" y="14" width="' + w.toFixed(1) + '" height="34" fill="' + (MAT_COLOR[l.m] || 'var(--muted)') + '" fill-opacity="0.75"><title>' + esc(l.m + ' ' + l.d + ' nm') + '</title></rect>';
            if (w > 34) g += '<text x="' + (x + w / 2).toFixed(1) + '" y="10" text-anchor="middle">' + esc(l.m.replace('_rough', ' rough')) + '</text>';
            x += w;
        });
        var desc = c.label + ' coating, to scale from the glass outward: ' + L.map(function (l) { return l.m + ' ' + l.d + ' nm'; }).join(', ');
        return '<svg class="stack-bar" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(desc) + '">' + g + '</svg>';
    }
    function renderCoatings() {
        var box = $('coat-info'), C = window.GlazingCoatings, M = window.GlazingMaterials;
        if (!C || !C.coatings || !M || !M.materials) { box.innerHTML = '<p class="muted">The open-data coating files could not load.</p>'; return; }
        var h = '<p class="hint">Generated ' + esc(C.version || '') + ' with the ' + esc(C.solar || 'E891') + ' solar spectrum. Layers are listed from the glass outward; layers thinner than about 1 nm are drawn at a minimum width. Each stack is an effective model of a coating family, not a manufacturer\'s actual design.</p><div class="coat-grid">';
        ['hard', 'single', 'double', 'triple'].forEach(function (key) {
            var c = C.coatings[key];
            if (!c) return;
            h += '<div class="coat-card"><h3>' + esc(c.label) + '</h3>' + stackSVG(key, c, M);
            h += '<div class="cmp-wrap"><table class="cmp"><caption>Layers, from the glass outward</caption><thead><tr><th scope="col">#</th><th scope="col">Material</th><th scope="col">Thickness (nm)</th></tr></thead><tbody>';
            c.layers.forEach(function (l, i) {
                var mat = M.materials[l.m];
                h += '<tr><td>' + (i + 1) + '</td><th scope="row">' + esc(mat ? mat.label : l.m) + '</th><td>' + l.d.toFixed(2) + '</td></tr>';
            });
            h += '</tbody></table></div>';
            h += '<p>Coated-face emissivity ε = ' + c.eps + ', inferred ' + esc(c.epsFrom ? 'from the ' + c.epsFrom : '') + '.' +
                (c.silverNm > 0 ? ' Total silver: ' + c.silverNm.toFixed(2) + ' nm.' : '') + '</p>';
            var cal = (c.calibratedTo || []).map(function (id) { return rowsById[id]; }).filter(Boolean);
            if (cal.length) {
                h += '<p>Calibrated to: ' + cal.map(function (r) { return esc(B.rowLabel(r)); }).join('; ') + '.</p>';
                var keys = RES_KEYS.filter(function (k) { return cal.some(function (r) { return c.residuals[r.id] && c.residuals[r.id][k[0]]; }); });
                h += '<div class="cmp-wrap"><table class="cmp"><caption>Calibration residuals: model / published</caption><thead><tr><th scope="col">Quantity</th>' +
                    cal.map(function (r) { return '<th scope="col">' + esc(r.id) + '</th>'; }).join('') + '</tr></thead><tbody>';
                keys.forEach(function (k) {
                    h += '<tr><th scope="row">' + k[1] + '</th>' + cal.map(function (r) {
                        var x = c.residuals[r.id] && c.residuals[r.id][k[0]];
                        return '<td>' + (x ? fv(k[0], Number(x[0])).replace(/^-/, '−') + ' / ' + pubText(k[0], x[1]) : '—') + '</td>';
                    }).join('') + '</tr>';
                });
                h += '<tr><th scope="row">Exterior a*, b* (model)</th>' + cal.map(function (r) {
                    var x = c.residuals[r.id] && c.residuals[r.id].colorR;
                    return '<td>' + (x ? minus(Number(x[0]), 2) + ', ' + minus(Number(x[1]), 2) : '—') + '</td>';
                }).join('') + '</tr>';
                h += '</tbody></table></div>';
            } else if (c.calibratedTo) {
                h += '<p>Calibrated to: ' + c.calibratedTo.map(esc).join(', ') + '.</p>';
            }
            var k0 = E.COATINGS[key];
            if (k0) h += '<p>Classic model, for comparison: ε ' + k0.eps + '; a parametric reflectance curve (visible ' + Math.round(k0.Rv * 1000) / 10 + ' %, infrared ' +
                Math.round(k0.Rir * 100) + ' %, edge at ' + k0.lc + ' nm, width ' + k0.w + ' nm) with a matching absorptance.</p>';
            h += '</div>';
        });
        h += '</div><h3 class="gl-sec">Optical constants</h3><ul class="mat-list">';
        Object.keys(M.materials).forEach(function (id) {
            var m = M.materials[id];
            h += '<li><b>' + esc(m.label) + '</b> (' + esc(id) + '). ' + esc(m.ref || '') +
                (m.doi ? ', <a href="' + esc(m.doi) + '" target="_blank" rel="noopener">' + esc(m.doi.replace('https://doi.org/', 'doi:')) + '</a>' : '') +
                (m.src ? '. Source: <a href="' + esc(m.src) + '" target="_blank" rel="noopener">' + esc(/github\.com/.test(m.src) ? 'refractiveindex.info database file' : 'paper') + '</a>' : '') +
                '. License: ' + esc(m.license || '') + '.</li>';
        });
        h += '</ul>';
        box.innerHTML = h;
    }

    /* ── Self-test ─────────────────────────────────────────────────────── */
    function initSelfTest() {
        var btn = $('st-run'), out = $('st-out');
        var T = window.GlazingSelfTest;
        btn.addEventListener('click', function () {
            if (!T || !openOK) { out.innerHTML = '<p class="s-bad">The open-data model could not load, so the self-test cannot run.</p>'; return; }
            btn.disabled = true;
            out.innerHTML = '<p class="muted">Running…</p>';
            var ctx = {
                E: E, O: O, P: P, B: B, published: published, manifest: manifest, solarE891: S891, tuvTable: window.GlazingSolarE891 && GlazingSolarE891.tuvTable,
                loadBytes: function (path) {
                    var name = path.split('/').pop();
                    return fetch(DATA + path).then(function (r) {
                        if (!r.ok) throw new Error('Could not load ' + name + ': ' + r.status + '. Check your connection and try again.');
                        return r.arrayBuffer();
                    }, function () { throw new Error('Could not load ' + name + ': network error. Check your connection and try again.'); })
                        .then(function (b) { return new Uint8Array(b); });
                }
            };
            T.run(ctx, function (p) { out.innerHTML = '<p class="muted">Running… ' + esc(p.group) + ' done.</p>'; })
                .then(function (res) { out.innerHTML = selfTestHTML(res); }, function (e) {
                    out.innerHTML = '<p class="s-bad">The self-test could not run: ' + esc(e && e.message ? e.message : String(e)) + '</p>';
                })
                .then(function () { btn.disabled = false; });
        });
    }
    function show(x) {
        if (x == null) return '';
        if (typeof x === 'number') return fmt.num(x, 5);
        return esc(String(x));
    }
    function selfTestHTML(res) {
        var h = '<div class="st-summary">' + (res.fail ? '<span class="badge badge-bad">' + res.fail + ' failed</span> <span class="badge">' + res.pass + ' passed</span>'
            : '<span class="badge badge-ok">' + res.pass + ' passed</span>') + '<span>in ' + fmt.num(res.ms / 1000, 2) + ' s</span></div><ul class="st-groups">';
        res.groups.forEach(function (g) {
            h += '<li><details><summary><b>' + g.id + '</b> ' + esc(g.label) + ': ' + g.pass + ' passed' + (g.fail ? ', <span class="s-bad">' + g.fail + ' failed</span>' : ', 0 failed') + '</summary>' +
                '<div class="cmp-wrap"><table class="cmp"><caption>' + g.id + ' checks</caption><thead><tr><th scope="col">Check</th><th scope="col">Got</th><th scope="col">Expected</th><th scope="col">Tolerance</th><th scope="col">Result</th></tr></thead><tbody>';
            g.items.forEach(function (it) {
                var st = it.info ? 'info' : it.ok ? 'ok' : 'bad';
                h += '<tr><th scope="row">' + esc(it.label) + '</th><td>' + show(it.got) + '</td><td>' + show(it.exp) + '</td><td>' + (it.tol == null ? 'report' : '± ' + show(it.tol)) + '</td>' +
                    '<td class="s-' + st + '">' + (it.info ? 'report' : it.ok ? '✓ pass' : '✗ fail') + '</td></tr>';
            });
            h += '</tbody></table></div></details></li>';
        });
        return h + '</ul>';
    }

    /* ── Importer ──────────────────────────────────────────────────────── */
    function initImporter() {
        var msg = $('imp-msg');
        function say(ok, text) { msg.className = 'imp-msg ' + (ok ? 'ok' : 'bad'); msg.textContent = text; }
        function parse(text, fname) {
            text = String(text).replace(/^﻿/, '');
            var t = text.trim();
            if (t.charAt(0) === '{' && t.indexOf('"spectral_data"') >= 0) return P.parseIGSDBJSON(t, fname);
            return P.parseIGDBText(text, fname);
        }
        function add(text, fname) {
            try {
                var p = parse(text, fname || '');
                p.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                if (!p.name) p.name = fname || 'Imported product';
                if (!p.fileName) p.fileName = fname || 'pasted data';
                imports.push(p); var kept = saveImports(); refreshSelects(); renderList();
                say(true, 'Added ' + p.name + (kept ? '. Choose it in a pane’s glass list.' : ' for this visit only: this browser would not store it (storage full or blocked), so it will be gone after you leave. Choose it in a pane’s glass list.'));
                if (calc) calc.run();
            } catch (e) {
                say(false, 'Could not read ' + (fname || 'the data') + ': ' + (e && e.message ? e.message : String(e)).replace(/\.$/, '') + '.');
            }
        }
        function decode(bytes) {
            if (typeof TextDecoder !== 'undefined') {
                try {
                    var u = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
                    var t = u.trim();
                    if (t.charAt(0) === '{' || t.charAt(0) === '[') return u;   // valid UTF-8 JSON
                } catch (e) { /* not UTF-8: fall through to windows-1252 */ }
            }
            return P.decode1252(bytes);
        }
        $('imp-add').addEventListener('click', function () { add($('imp-text').value, ''); });
        $('imp-pick').addEventListener('click', function () { $('imp-file').click(); });   // a real button: reachable by keyboard
        if (droppedImports) say(false, droppedImports === 1 ? 'One saved import could not be read and was removed.' : droppedImports + ' saved imports could not be read and were removed.');
        $('imp-file').addEventListener('change', function (e) {
            Array.prototype.slice.call(e.target.files).forEach(function (f) {
                f.arrayBuffer().then(function (buf) { add(decode(new Uint8Array(buf)), f.name); }, function () { say(false, 'Could not read ' + f.name + '.'); });
            });
            e.target.value = '';
        });
        $('imp-list').addEventListener('click', function (e) {
            var b = e.target.closest('[data-del]');
            if (!b) return;
            imports = imports.filter(function (p) { return p.id !== b.dataset.del; });
            saveImports(); refreshSelects(); renderList();
            if (calc) calc.run();
        });
        renderList();
    }
    var SIDE_SRC = { header: 'from the file header', inferred: 'inferred: lower-emissivity face' };
    function renderList() {
        $('imp-list').innerHTML = imports.map(function (p) {
            var bits = [];
            if (p.manufacturer) bits.push(esc(p.manufacturer));
            if (p.igdbId) bits.push('IGDB ' + esc(p.igdbId));
            bits.push(esc(mmText(p.thickness)) + ' mm');
            bits.push('ε front ' + epsText(p.ef) + ' (' + (IMPORT_EPS[p.efSource] || esc(p.efSource)) + '), back ' + epsText(p.eb) + ' (' + (IMPORT_EPS[p.ebSource] || esc(p.ebSource)) + ')');
            bits.push(p.coatedSide ? 'coated ' + p.coatedSide + ' (' + (SIDE_SRC[p.coatedSideSource] || 'from the file') + ')' : 'uncoated');
            bits.push((p.points || (p.wl ? p.wl.length : 0)) + ' points');
            var warn = (p.warnings || []).map(function (w) { return '<small>' + esc(w) + '</small>'; }).join('');
            return '<li><span><b>' + esc(p.name) + '</b> · ' + bits.join(' · ') + warn + '</span><button type="button" class="btn btn-ghost btn-sm" data-del="' + esc(p.id) + '">Remove</button></li>';
        }).join('');
    }
});
