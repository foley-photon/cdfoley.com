/* Glazing Performance Calculator (open-data beta): validation runner, window.GlazingSelfTest.
   Runs the validation cases V1 to V6 of the build specification (section 5) against the shipped modules, in the
   browser (the "Self-test" panel) or in Node (_tests/glazing/run-validation.mjs). Environment-agnostic: every
   dependency comes in through ctx, and the shipped LBNL files are read with ctx.loadBytes and parsed with the
   page's own parsers (GlazingProducts). V1c (color regression) needs a file that is not published and runs in
   Node only (_tests/glazing/wp3-wce.test.mjs).
   References: Windows-CalcEngine unit tests at commit 1dedefa (src/MultiLayerOptics/tst/units/, expected
   values typed in as facts), measured IGDB records shipped unmodified under assets/data/glazing/lbnl/, the
   EnergyPlus "LOW IRON 5MM" values (Tv 0.910, Ts 0.889) and the published datasheet rows of published.json.
   Tolerances come from GlazingBeta.TOL (spec 5.2). Our own code. */
(function (root) {
    'use strict';

    var BTU = 5.678263;
    var GROUPS = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
    var LABELS = {
        V1: 'Windows-CalcEngine unit tests: measured records, ASTM E891 weighting',
        V2: 'Rubin glass against measured clear records; clear double glazing against datasheets',
        V3: 'Measured IGDB records in published datasheet configurations',
        V4: 'Open generic coatings against their calibration rows',
        V5: 'Open generic coatings against held-out datasheet rows',
        V6: 'Open generic coatings against held-out measured records of the same class'
    };
    var WCE_FILE = 'wce/spectralSampleData.cpp';
    // Expected values of the WCE unit tests (spec 5.3, V1).
    var V1_CASES = [
        { rec: 'NFRC_6046', mm: 5.66, file: 'MultiPaneSpecular_6046', x: [0.383209772, 0.285971675, 0.449239729, 0.330818553] },
        { rec: 'NFRC_913', mm: 4.7752, file: 'MultiPaneSpecular_NFRC913', x: [0.513398587, 0.0550761015, 0.0550761015, 0.431525312] },
        { rec: 'NFRC_21467', mm: 3.0, file: 'MultiPaneSpecular_21467', x: [0.857620132, 0.108847554, 0.114567521, 0.0335323147] }
    ];
    var V1_2191 = { T: 0.586491727, Rf: 0.229786798, Rb: 0.190210295, A1: 0.127688243, A2: 0.0560332311 };

    function now() { return (root.performance && root.performance.now) ? root.performance.now() : Date.now(); }
    function yieldNow() { return new Promise(function (r) { setTimeout(r, 0); }); }

    function run(ctx, onProgress) {
        var E = ctx.E, O = ctx.O, P = ctx.P, B = ctx.B, TOL = B.TOL, S891 = ctx.solarE891;
        var E891 = { solar: S891 };
        // Datasheet UV is WINDOW's TUV (E891 points 310-380 nm, trapezoid): GlazingBeta.tuvNFRC (V3, V4, V5).
        var TUV = ctx.tuvTable || (root.GlazingSolarE891 && root.GlazingSolarE891.tuvTable);
        function uv(r) { return 100 * B.tuvNFRC(r.sys.T, TUV); }
        var t0 = now();
        var groups = [], cur = null;
        var manifest = ctx.manifest, published = ctx.published;
        var bytesCache = {};

        function start(id) { cur = { id: id, label: LABELS[id], pass: 0, fail: 0, items: [] }; groups.push(cur); }
        function check(label, got, exp, tol) {
            var ok = isFinite(got) && Math.abs(got - exp) <= tol + 1e-12;
            if (ok) cur.pass++; else cur.fail++;
            cur.items.push({ label: label, got: got, exp: exp, tol: tol, ok: ok, info: false });
        }
        function info(label, got, exp) { cur.items.push({ label: label, got: got, exp: exp, tol: null, ok: null, info: true }); }

        function bytes(path) {
            if (!bytesCache[path]) bytesCache[path] = Promise.resolve(ctx.loadBytes(path));
            return bytesCache[path];
        }
        function text(path) {
            return bytes(path).then(function (b) { return typeof b === 'string' ? b : P.decode1252(b instanceof Uint8Array ? b : new Uint8Array(b)); });
        }
        function base() { return (manifest && manifest.base) || 'lbnl/'; }
        function entry(id) {
            var ps = manifest.products;
            for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
            throw new Error('Self-test: product ' + id + ' is not in manifest.json.');
        }

        var recs = null, prods = {};
        // A manifest product, built the way the page builds it: header file -> parseIGDBText, WCE record -> productFromRecord.
        function product(id) {
            if (prods[id]) return prods[id];
            var e = entry(id), p;
            if (e.record) p = P.productFromRecord(e, recs[e.record], manifest);
            else {
                p = P.parseIGDBText(textFiles[e.file], e.file);
                p.id = e.id; p.igdbId = e.igdbId; p.name = e.name; p.manufacturer = e.manufacturer;
                p.coatedSide = e.coatedSide || null;
                if (e.thicknessMm > 0) p.thickness = e.thicknessMm;
            }
            prods[id] = p;
            return p;
        }
        // A WCE record that is not a manifest product (102 and 21467 are used only by the unit-test cases).
        function record(rec, mm) {
            return P.productFromRecord({ id: 'wce-' + rec, name: rec, manufacturer: '', igdbId: null, type: 'monolithic', coatedSide: null,
                thicknessMm: mm, file: WCE_FILE, record: rec }, recs[rec], manifest);
        }
        var textFiles = {};
        function pct(x) { return 100 * x; }
        function faces(side) { return side === 'front' ? 'outdoors' : 'indoors'; }
        function gaps(row, fill) { return row.gaps.map(function (w) { return { fill: fill, width: w / 1000 }; }); }
        function step(id) {
            if (onProgress) { try { onProgress({ group: id, done: groups.length, total: GROUPS.length }); } catch (e) { /* ignore */ } }
            return yieldNow();
        }

        return Promise.resolve().then(function () {
            if (manifest) return manifest;
            return text('manifest.json').then(function (t) { manifest = JSON.parse(t); return manifest; });
        }).then(function () {
            if (published) return published;
            return text('published.json').then(function (t) { published = JSON.parse(t); return published; });
        }).then(function () {
            var files = ['pywincalc/CLEAR_3.DAT', 'pywincalc/CLEAR_6.DAT', 'pywincalc/CLEAR5.LOF', 'pywincalc/LOW-E_5.LOF'];
            return Promise.all(files.map(function (f) { return text(base() + f).then(function (t) { textFiles[f] = t; }); }))
                .then(function () { return text(base() + WCE_FILE); })
                .then(function (t) { recs = P.parseWCECpp(t); });
        }).then(function () {
            /* ── V1 ── */
            start('V1');
            var avg = function (a) { return E.avg(a, S891); };
            var s = E.system([E.imported(product('igdb-2191'), true), E.imported(record('NFRC_102', 3.048), false)]);
            var tag = 'NFRC_2191 (3.0 mm, flipped) + NFRC_102 (3.048 mm), MultiPaneSpecular_2191_102: ';
            check(tag + 'T', avg(s.T), V1_2191.T, TOL.v1.TR);
            check(tag + 'Rf', avg(s.Rf), V1_2191.Rf, TOL.v1.TR);
            check(tag + 'Rb', avg(s.Rb), V1_2191.Rb, TOL.v1.TR);
            check(tag + 'A1', avg(s.A[0]), V1_2191.A1, TOL.v1.A);
            check(tag + 'A2', avg(s.A[1]), V1_2191.A2, TOL.v1.A);
            V1_CASES.forEach(function (c) {
                var p = c.rec === 'NFRC_6046' ? product('igdb-6046') : c.rec === 'NFRC_913' ? product('igdb-913') : record(c.rec, c.mm);
                var m = E.system([E.imported(p, false)]), t = c.rec + ' (' + c.mm + ' mm), ' + c.file + ': ';
                check(t + 'T', avg(m.T), c.x[0], TOL.v1.TR);
                check(t + 'Rf', avg(m.Rf), c.x[1], TOL.v1.TR);
                check(t + 'Rb', avg(m.Rb), c.x[2], TOL.v1.TR);
                check(t + 'A', avg(m.A[0]), c.x[3], TOL.v1.TR);
            });
            return step('V1');
        }).then(function () {
            /* ── V2: V2a glass against measured clear records, V2b clear IGUs against datasheets ── */
            start('V2');
            var T2 = TOL.v2a;
            ['igdb-102', 'igdb-103', 'igdb-9803'].forEach(function (id) {
                var p = product(id), f = p.source ? p.source.file.split('/').pop() : id;
                [['G173', undefined], ['E891', E891]].forEach(function (w) {
                    var m = E.evaluate([E.imported(p, false)], [], 1, w[1]);
                    var g = E.evaluate([O.pane('clear', p.thickness, 'none', 'front')], [], 1, w[1]);
                    var t = 'Rubin clear ' + p.thickness + ' mm vs IGDB ' + p.igdbId + ' (' + f + '), ' + w[0] + ': ';
                    check(t + 'Tvis (%)', pct(g.Tvis), pct(m.Tvis), T2.Tvis);
                    check(t + 'Tsol (%)', pct(g.Tsol), pct(m.Tsol), T2.Tsol);
                    check(t + 'Rvis (%)', pct(g.Rvis), pct(m.Rvis), T2.Rvis);
                    check(t + 'Tuv (%)', pct(g.Tuv), pct(m.Tuv), T2.Tuv);
                });
            });
            var li = E.evaluate([O.pane('lowiron', 5, 'none', 'front')], [], 1);
            check('Rubin low-iron 5 mm vs EnergyPlus LOW IRON 5MM, G173: Tvis', li.Tvis, 0.910, T2.lowironTvis);
            check('Rubin low-iron 5 mm vs EnergyPlus LOW IRON 5MM, G173: Tsol', li.Tsol, 0.889, T2.lowironTsol);
            published.rows.filter(function (r) { return r.class === 'clear'; }).forEach(function (row) {
                var L = row.panes.map(function (p) { return E.pane(p.glass, p.mm, 'none', 'front', 'open'); });
                var a = E.evaluate(L, gaps(row, 'air'), 1, E891), r = E.evaluate(L, gaps(row, 'argon'), 1, E891), G = TOL.glass;
                var t = row.id + ' (open clear glass): ';
                check(t + 'U air (Btu)', a.U / BTU, row.Uair, G.U);
                check(t + 'U argon (Btu)', r.U / BTU, row.Uar, G.U);
                check(t + 'VT (%)', pct(a.Tvis), row.VT, G.VT);
                check(t + 'SHGC', a.SHGC, row.SHGC, G.SHGC);
                check(t + 'Rout (%)', pct(a.Rvis), row.Rout, G.Rout);
            });
            return step('V2');
        }).then(function () {
            /* ── V3: measured coated lites (flipped as the row requires) with Rubin clear partners ── */
            start('V3');
            published.rows.filter(function (r) { return !!r.igdb; }).forEach(function (row) {
                var p = product(row.igdb);
                var L = row.panes.map(function (q) {
                    // Partners take the row's thickness; for the 4 mm Energy Advantage rows the measured lite is 4.72 mm
                    // and its partner takes the measured thickness, as in the specification's V3 (WP3, prototype).
                    var mm = row.igdb === 'igdb-9923' ? p.thickness : q.mm;
                    return q.coat ? E.imported(p, P.flipFor(p, faces(q.side))) : O.pane('clear', mm, 'none', 'front');
                });
                var a = E.evaluate(L, gaps(row, 'air'), 1, E891), r = row.gaps.length ? E.evaluate(L, gaps(row, 'argon'), 1, E891) : null;
                var t = 'IGDB ' + p.igdbId + ' in ' + row.id + ': ';
                ['VT', 'Rout', 'Rin', 'SHGC', 'Uair', 'Uar', 'U', 'UV', 'Tsol'].forEach(function (key) {
                    if (row[key] == null) return;
                    var tm = B.tolMeasuredFor(row, key);
                    var got = key === 'VT' ? pct(a.Tvis) : key === 'Rout' ? pct(a.Rvis) : key === 'Rin' ? pct(a.RvisIn) : key === 'SHGC' ? a.SHGC
                        : key === 'Uair' || key === 'U' ? a.U / BTU : key === 'Uar' ? r.U / BTU : key === 'UV' ? uv(a) : pct(a.Tsol);
                    var lab = t + key + (key === 'U' ? ' (monolithic)' : '');
                    if (tm.report) info(lab, got, row[key]); else check(lab, got, row[key], tm.tol);
                });
            });
            return step('V3');
        }).then(function () {
            /* ── V4 and V5: open generic coatings against the published rows ── */
            ['calibrate', 'check'].forEach(function (role) {
                start(role === 'calibrate' ? 'V4' : 'V5');
                published.rows.filter(function (r) { return r.class !== 'clear' && r.role === role; }).forEach(function (row) {
                    var L = row.panes.map(function (p) { return E.pane(p.glass, p.mm, p.coat || 'none', p.side || 'front', 'open'); });
                    var a = E.evaluate(L, gaps(row, 'air'), 1, E891), r = row.gaps.length ? E.evaluate(L, gaps(row, 'argon'), 1, E891) : null;
                    var t = row.id + ': ';
                    ['VT', 'Rout', 'Rin', 'SHGC', 'Uair', 'Uar', 'UV', 'U', 'Tsol'].forEach(function (key) {
                        if (row[key] == null) return;
                        var tf = B.tolFor(row, key);
                        var got = key === 'VT' ? pct(a.Tvis) : key === 'Rout' ? pct(a.Rvis) : key === 'Rin' ? pct(a.RvisIn) : key === 'SHGC' ? a.SHGC
                            : key === 'Uair' || key === 'U' ? a.U / BTU : key === 'Uar' ? r.U / BTU : key === 'UV' ? uv(a) : pct(a.Tsol);
                        var lab = t + key + (key === 'U' ? ' (monolithic)' : '');
                        if (tf.report) info(lab, got, row[key]); else check(lab, got, row[key], tf.tol);
                    });
                    if (role === 'calibrate' && row.panes.length > 1) {
                        var W = TOL.window, ca = a.colorR.a, cb = a.colorR.b;
                        var inW = function (v, lim) { return isFinite(v) && v >= lim[0] - W.margin - 1e-12 && v <= lim[1] + W.margin + 1e-12; };
                        var ok = inW(ca, W.Ra) && inW(cb, W.Rb);   // one check, as counted by the specification (237)
                        if (ok) cur.pass++; else cur.fail++;
                        cur.items.push({ label: t + 'exterior reflected color inside the neutral window', got: 'a* ' + ca.toFixed(2) + ', b* ' + cb.toFixed(2),
                            exp: 'a* ' + W.Ra[0] + ' to ' + W.Ra[1] + ', b* ' + W.Rb[0] + ' to ' + W.Rb[1], tol: W.margin, ok: ok, info: false });
                    }
                });
            });
            return step('V5');
        }).then(function () {
            /* ── V6: generic coating on #2 vs the measured record on #2, 12.7 mm gap, Rubin clear partner ── */
            start('V6');
            var T6 = TOL.v6;
            [['single', 'igdb-2191', 'clear', 3], ['double', 'igdb-6046', 'clear', 6], ['triple', 'igdb-5439', 'lowiron', 6], ['hard', 'igdb-9923', 'clear', null]].forEach(function (c) {
                var cls = c[0], p = product(c[1]), mm = p.thickness, partner = c[3] == null ? p.thickness : c[3];
                var meas = E.imported(p, P.flipFor(p, 'indoors'));
                var gen = E.pane(c[2], mm, cls, 'back', 'open');
                var s = 0, n = 0;
                for (var i = 0; i < E.LAM.length; i++) if (E.LAM[i] >= 450) { s += Math.pow(gen.T[i] - meas.T[i], 2); n++; }
                var t = cls + ' (open, ' + c[2] + ' ' + mm + ' mm) vs IGDB ' + p.igdbId + ': ';
                check(t + 'spectral RMS of T, 450–2500 nm (points)', 100 * Math.sqrt(s / n), 0, cls === 'hard' ? T6.rmsHard : T6.rms);
                var Pn = O.pane('clear', partner, 'none', 'front');
                ['air', 'argon'].forEach(function (fill) {
                    var gp = [{ fill: fill, width: 0.0127 }];
                    var g = E.evaluate([gen, Pn], gp, 1, E891), m = E.evaluate([meas, Pn], gp, 1, E891);
                    if (fill === 'air') {
                        check(t + 'VT (%)', pct(g.Tvis), pct(m.Tvis), T6.VT);
                        check(t + 'SHGC', g.SHGC, m.SHGC, T6.SHGC);
                        check(t + 'Rout (%)', pct(g.Rvis), pct(m.Rvis), T6.Rout);
                        check(t + 'exterior a*', g.colorR.a, m.colorR.a, T6.color);
                        check(t + 'exterior b*', g.colorR.b, m.colorR.b, T6.color);
                    }
                    check(t + 'U ' + fill + ' (Btu)', g.U / BTU, m.U / BTU, T6.U);
                });
            });
            return step('V6');
        }).then(function () {
            var pass = 0, fail = 0;
            groups.forEach(function (g) { pass += g.pass; fail += g.fail; });
            return { groups: groups, pass: pass, fail: fail, ms: now() - t0 };
        });
    }

    var api = { GROUPS: GROUPS, LABELS: LABELS, run: run };
    root.GlazingSelfTest = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
