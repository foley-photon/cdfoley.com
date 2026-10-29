/* Named glazing products and the spectral-file importer for the open-data glazing calculator (beta).
   - Parsers for IGDB text files (as exported by LBNL Optics / WINDOW and shipped in LBNL pyWinCalc), IGSDB product
     JSON, and the C++ initializer records of LBNL Windows-CalcEngine spectralSampleData.cpp. Our own code; no
     third-party code is included.
   - Infrared emissivity of a face from a record's 5-40 µm data: normal emissivity by Planck weighting at 283 K
     (trapezoid rule), converted to hemispherical emissivity with the ratio table of EN 12898.
   - A loader for the unmodified LBNL files under /assets/data/glazing/lbnl/ (listed in manifest.json), and the
     CC BY-ND 4.0 attribution text shown with every result that uses International Glazing Database data.
   The pure functions take no DOM and run in Node; the loader uses fetch() unless a byte loader is injected. */
(function (root) {
    'use strict';

    var NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
    var IS_NUM = new RegExp('^' + NUM + '$');
    var EPS_GLASS = 0.84;
    var MAX_NM = 2500;

    /* ── Text decoding ─────────────────────────────────────────────────── */
    // windows-1252: 0x80-0x9F differ from Latin-1 (Node's TextDecoder maps 0x99 to U+0099, not "™").
    var CP1252 = [0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
        0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178];
    function bytesOf(b) {
        if (b == null) throw new Error('glazing-products.js: no bytes');
        if (typeof b.byteLength === 'number' && typeof b.length !== 'number') return new Uint8Array(b);   // ArrayBuffer
        return b;   // Uint8Array, Node Buffer (from any realm) or a plain array of byte values
    }
    function decode1252(bytes) {
        var b = bytesOf(bytes), out = [], CH = 8192;
        for (var i = 0; i < b.length; i += CH) {
            var codes = [];
            for (var j = i, end = Math.min(b.length, i + CH); j < end; j++) {
                var c = b[j] & 0xFF;
                codes.push(c >= 0x80 && c <= 0x9F ? CP1252[c - 0x80] : c);
            }
            out.push(String.fromCharCode.apply(null, codes));
        }
        return out.join('');
    }
    function decodeUTF8(bytes) {
        var b = bytesOf(bytes);
        if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(b instanceof Uint8Array ? b : Uint8Array.from(b));
        return decode1252(b);   // the C++ file and the manifest are ASCII, where both decodings agree
    }

    /* ── Emissivity ────────────────────────────────────────────────────── */
    // EN 12898 ratio eh/en as a function of en, interpolated linearly; x1.22 below 0.03, x0.94 above 0.89.
    var EN12898 = [[0.03, 1.22], [0.05, 1.18], [0.1, 1.14], [0.2, 1.10], [0.3, 1.06], [0.4, 1.03], [0.5, 1.00], [0.6, 0.98], [0.7, 0.96], [0.8, 0.95], [0.89, 0.94]];
    function hemispherical(en) {
        var t = EN12898;
        if (en <= t[0][0]) return en * t[0][1];
        for (var i = 1; i < t.length; i++) {
            if (en <= t[i][0]) {
                var f = (en - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
                return en * (t[i - 1][1] + f * (t[i][1] - t[i - 1][1]));
            }
        }
        return en * t[t.length - 1][1];
    }
    // rows: [[wavelength µm, T, Rf, Rb], ...]; face 'front' | 'back'. Returns { en, eh }, or null without 5-40 µm data.
    function irEmissivity(rows, face) {
        var ir = (rows || []).filter(function (r) { return r[0] >= 5 && r[0] <= 40; })
            .sort(function (a, b) { return a[0] - b[0]; });
        if (ir.length < 3) return null;
        var C2 = 0.014387769;   // second radiation constant, m·K
        function planck(um) { var l = um * 1e-6; return 1 / (Math.pow(l, 5) * (Math.exp(C2 / (l * 283)) - 1)); }
        var col = face === 'back' ? 3 : 2, num = 0, den = 0;
        for (var i = 1; i < ir.length; i++) {
            var a = ir[i - 1], b = ir[i], dl = b[0] - a[0];
            var ea = 1 - a[1] - a[col], eb = 1 - b[1] - b[col], wa = planck(a[0]), wb = planck(b[0]);
            num += 0.5 * (ea * wa + eb * wb) * dl;
            den += 0.5 * (wa + wb) * dl;
        }
        if (!(den > 0)) return null;
        var en = num / den;
        return { en: en, eh: hemispherical(en) };
    }
    // A face whose computed hemispherical emissivity exceeds 0.5 is uncoated glass and gets 0.84.
    function faceEps(ir) {
        if (!ir) return { v: EPS_GLASS, src: 'assumed' };
        return { v: ir.eh > 0.5 ? EPS_GLASS : ir.eh, src: 'computed', raw: ir.eh };
    }

    /* ── Parsers ───────────────────────────────────────────────────────── */
    function headerNum(text, key) {
        var m = text.match(new RegExp('\\{\\s*' + key + '\\s*\\}\\s*(' + NUM + ')', 'i'));
        return m ? parseFloat(m[1]) : NaN;
    }
    function headerText(text, key) {
        var m = text.match(new RegExp('\\{[^}\\n]*?\\b' + key + '\\s*:\\s*([^}\\n]*)', 'i'));
        return m ? m[1].trim() : '';
    }
    function sideOf(s) {
        s = String(s || '').trim().toLowerCase();
        return s === 'front' || s === 'back' ? s : null;
    }
    function baseName(f) { return String(f || '').split(/[\\/]/).pop(); }
    function prefix(file) { return file ? file + ': ' : ''; }

    // IGDB text: "{ key } value" header lines, then rows "wavelength T Rfront Rback". Throws Error(userMessage).
    function parseIGDBText(text, fname) {
        text = String(text == null ? '' : text);
        var file = fname ? baseName(fname) : '';
        var em = text.match(new RegExp('Emis\\s*=\\s*(' + NUM + ')[\\s,;]+(' + NUM + ')', 'i'));
        var units = /\{\s*(?:Units\s*,\s*)?Wavelength Units\s*\}\s*SI\s+Microns/i.test(text) ? 'um' : null;
        var nfrc = headerText(text, 'NFRC ID').match(/^\d+/);
        var sideText = headerText(text, 'Coated Side');
        var type = headerText(text, 'Type').toLowerCase();
        var pts = [], other = 0;
        text.split(/\r\n|\r|\n/).forEach(function (line) {
            if (/[{}]/.test(line)) return;
            var s = line.trim();
            if (!s) return;
            var tok = s.split(/[\s,;]+/);
            if (tok.every(function (t) { return IS_NUM.test(t); })) {
                if (tok.length === 4) pts.push(tok.map(parseFloat)); else other++;
            }
        });
        if (pts.length < 20) {
            throw new Error(prefix(file) + 'found ' + pts.length + ' data row' + (pts.length === 1 ? '' : 's') +
                (other ? ' (and ' + other + ' numeric row' + (other === 1 ? '' : 's') + ' without exactly four numbers)' : '') +
                '. A spectral file needs at least 20 rows of four numbers: wavelength, T, Rfront, Rback.');
        }
        return finish(pts, {
            name: headerText(text, 'Product Name') || file || 'Imported product',
            manufacturer: headerText(text, 'Manufacturer'),
            igdbId: nfrc ? +nfrc[0] : null,
            thickness: headerNum(text, 'Thickness'), k: headerNum(text, 'Conductivity'),
            ef: em ? parseFloat(em[1]) : NaN, eb: em ? parseFloat(em[2]) : NaN,
            coatedSide: sideOf(sideText), sideKnown: /^(front|back|neither)$/i.test(sideText),
            type: type === 'coated' || type === 'monolithic' ? type : '',
            units: units, fileName: file || null
        });
    }

    // IGSDB product record (JSON), field names from the IGSDB OpenAPI schema. Throws Error(userMessage).
    function parseIGSDBJSON(text, fname) {
        var file = fname ? baseName(fname) : '', j;
        try { j = typeof text === 'string' ? JSON.parse(text) : text; }
        catch (e) { throw new Error(prefix(file) + 'this is not valid JSON (' + e.message + ').'); }
        if (Array.isArray(j)) {
            if (j.length !== 1) throw new Error(prefix(file) + 'expected one IGSDB product, found ' + j.length + '.');
            j = j[0];
        }
        if (!j || typeof j !== 'object') throw new Error(prefix(file) + 'expected an IGSDB product record.');
        var sd = j.spectral_data, rows = sd && Array.isArray(sd.spectral_data) ? sd.spectral_data : (Array.isArray(sd) ? sd : null);
        if (!rows) throw new Error(prefix(file) + 'no spectral_data.spectral_data array found. Only IGSDB records with spectral data can be used.');
        var pts = [];
        rows.forEach(function (r) {
            if (!r || r.wavelength == null || r.T == null || r.Rf == null || r.Rb == null) return;
            var p = [+r.wavelength, +r.T, +r.Rf, +r.Rb];
            if (p.every(isFinite)) pts.push(p);
        });
        if (pts.length < 20) throw new Error(prefix(file) + 'found ' + pts.length + ' usable spectral points; at least 20 are needed (wavelength, T, Rf, Rb).');
        var md = j.measured_data || {}, side = String(j.coated_side || '');
        function num(v) { return v != null && v !== '' && isFinite(+v) ? +v : NaN; }
        return finish(pts, {
            name: String(j.name || '').trim() || file || 'Imported product',
            manufacturer: String(j.manufacturer_name || '').trim(),
            igdbId: isNaN(num(j.nfrc_id)) ? null : num(j.nfrc_id),
            thickness: num(md.thickness), k: num(md.conductivity),
            ef: num(md.emissivity_front), eb: num(md.emissivity_back),
            coatedSide: sideOf(side), sideKnown: /^(front|back|neither)$/i.test(side),
            type: String(j.subtype || '').toLowerCase() === 'coated' ? 'coated' : '',
            // The IGSDB schema gives wavelengths in µm; finish() detects µm from the first wavelength (below 10), which
            // also reads a non-schema export in nm correctly.
            units: null, fileName: file || null
        });
    }

    // Common tail of both import parsers: units, range checks, emissivities, coated side.
    function nmText(um) { return String(Math.round(um * 1e4) / 10); }
    function finish(pts, meta) {
        pts.sort(function (a, b) { return a[0] - b[0]; });
        // µm when the file says so, or when the data start below 10 (a spectrum in nm starts near 300; one in µm near
        // 0.3, and its infrared rows may run to 50 µm or beyond).
        var micron = meta.units === 'um' || pts[0][0] < 10;
        var pct = pts.some(function (p) { return p[1] > 1.5 || p[2] > 1.5 || p[3] > 1.5; }), s = pct ? 0.01 : 1;
        var all = [], last = -Infinity;
        pts.forEach(function (p) {
            var um = micron ? p[0] : p[0] / 1000;
            if (um > last) { all.push([um, p[1] * s, p[2] * s, p[3] * s]); last = um; }   // a repeated wavelength keeps its first row
        });
        var lo = all[0][0] * 1000, hi = all[all.length - 1][0] * 1000;
        if (lo > 400 + 1e-6 || hi < 2000 - 1e-6) {
            throw new Error(prefix(meta.fileName) + 'the spectrum covers ' + Math.round(lo) + '–' + Math.round(hi) +
                ' nm; it must span at least 400–2000 nm (the calculator uses 300–2500 nm).');
        }
        // Physical range: T, Rfront and Rback are fractions from 0 to 1 (a little measurement noise is allowed and
        // clipped), and T + R cannot exceed 1 by more than noise.
        var NOISE = 0.005, SUM_MAX = 1.02, clipped = 0, sumFixed = 0, sumWorst = 0;
        var unitHint = pct ? ' The values were read as percent.' : ' Give T and R as fractions (0 to 1) or as percent (0 to 100), the same for every row.';
        all.forEach(function (r) {
            for (var c = 1; c <= 3; c++) {
                if (!isFinite(r[c]) || r[c] < -NOISE || r[c] > 1 + NOISE) {
                    throw new Error(prefix(meta.fileName) + 'at ' + nmText(r[0]) + ' nm, ' + ['T', 'Rfront', 'Rback'][c - 1] + ' = ' +
                        String(Math.round(r[c] * 1e4) / 1e4).replace('-', '−') + ' is outside 0 to 1.' + unitHint);
                }
                if (r[c] < 0 || r[c] > 1) { r[c] = Math.min(1, Math.max(0, r[c])); clipped++; }
            }
            for (var k = 2; k <= 3; k++) {
                var sum = r[1] + r[k];
                if (sum > SUM_MAX) {
                    throw new Error(prefix(meta.fileName) + 'at ' + nmText(r[0]) + ' nm, T + ' + (k === 2 ? 'Rfront' : 'Rback') + ' = ' +
                        (Math.round(sum * 1e4) / 1e4) + ', more than 1: transmitted and reflected light cannot exceed the incident light.' + unitHint);
                }
                if (sum > 1) { sumWorst = Math.max(sumWorst, sum - 1); r[k] = 1 - r[1]; sumFixed++; }
            }
        });
        var warn = [];
        if (pct) warn.push('Values above 1.5 were read as percent and divided by 100.');
        if (clipped) warn.push(clipped === 1 ? 'One value slightly outside 0 to 1 (measurement noise) was clipped to that range.'
            : clipped + ' values slightly outside 0 to 1 (measurement noise) were clipped to that range.');
        if (sumFixed) warn.push('T + R exceeds 1 by up to ' + (Math.round(sumWorst * 1e4) / 1e4) + ' at ' + sumFixed + ' point' + (sumFixed === 1 ? '' : 's') +
            '; R was reduced there so that the absorptance is not negative.');
        // The engine holds the end values constant outside the data (down to 300 nm and up to 2500 nm); 5 nm of slack at
        // the short end and 10 nm at the long end (a record sampled to 2494 nm, like IGDB 913, is complete).
        var range = [lo, Math.min(hi, MAX_NM)];
        if (lo > 305 + 1e-6) {
            warn.push('Data start at ' + Math.round(lo) + ' nm; below that the ' + Math.round(lo) + ' nm values are held constant, so ' +
                'UV transmittance is not available and solar values are approximate.');
        }
        if (hi < MAX_NM - 10 - 1e-6) {
            warn.push('Data end at ' + Math.round(hi) + ' nm; above that the ' + Math.round(hi) + ' nm values are held constant to 2500 nm, so solar values are approximate.');
        }
        function eps(v, face) {
            if (isNaN(v)) return faceEps(irEmissivity(all, face));   // not in the file: from 5-40 µm data if present, else 0.84
            if (!(v > 0 && v <= 1)) {
                warn.push((face === 'front' ? 'Front' : 'Back') + ' emissivity ' + v + ' is outside (0, 1]; using 0.84.');
                return { v: EPS_GLASS, src: 'assumed' };
            }
            return { v: v, src: 'header' };
        }
        var F = eps(meta.ef, 'front'), B = eps(meta.eb, 'back');
        var opt = all.filter(function (r) { return r[0] * 1000 <= MAX_NM + 1e-6; });
        // A missing emissivity on a face that looks coated (R above 0.3 at 2 µm) is worth a warning.
        var r2 = at2um(opt);
        if (F.src === 'assumed' && isNaN(meta.ef) && r2 && r2[0] > 0.3) warn.push('The file gives no front emissivity, but the front looks coated (R ' + r2[0].toFixed(2) + ' at 2 µm); assumed 0.84.');
        if (B.src === 'assumed' && isNaN(meta.eb) && r2 && r2[1] > 0.3) warn.push('The file gives no back emissivity, but the back looks coated (R ' + r2[1].toFixed(2) + ' at 2 µm); assumed 0.84.');
        // Without a Coated Side header, the face with the lower emissivity is the coated one.
        var side = meta.coatedSide, sideSrc = side ? 'header' : null;
        if (!side && !meta.sideKnown && Math.abs(F.v - B.v) > 1e-9 && Math.min(F.v, B.v) < 0.5) {
            side = F.v < B.v ? 'front' : 'back'; sideSrc = 'inferred';
        }
        var thickness = meta.thickness > 0 ? meta.thickness : 6;
        if (!(meta.thickness > 0)) warn.push('The file gives no thickness; assumed 6 mm.');
        var p = {
            id: null, name: meta.name, manufacturer: meta.manufacturer || '', igdbId: meta.igdbId,
            type: meta.type || (side ? 'coated' : 'monolithic'), coatedSide: side, coatedSideSource: sideSrc, 'class': null,
            thickness: thickness, k: meta.k > 0 ? meta.k : 1.0,
            ef: F.v, eb: B.v, efSource: F.src, ebSource: B.src, warnings: warn,
            wl: opt.map(function (r) { return r[0] * 1000; }),
            T: opt.map(function (r) { return r[1]; }), Rf: opt.map(function (r) { return r[2]; }), Rb: opt.map(function (r) { return r[3]; }),
            points: opt.length, range: range, fileName: meta.fileName, source: null
        };
        if (F.raw != null) p.efComputed = F.raw;
        if (B.raw != null) p.ebComputed = B.raw;
        return p;
    }
    function at2um(rows) {
        var best = null, d = Infinity;
        rows.forEach(function (r) { var x = Math.abs(r[0] - 2); if (x < d) { d = x; best = r; } });
        return best && d <= 0.1 ? [best[2], best[3]] : null;
    }

    // Windows-CalcEngine spectralSampleData.cpp: functions "CSpectralSampleData> NAME()" whose bodies list
    // {wl, {Tf, Tb, Rf, Rb}, {...}} rows, wavelengths in µm. Each body runs to the next function header.
    function parseWCECpp(text) {
        text = String(text);
        var head = /CSpectralSampleData>\s+(\w+)\s*\(\s*\)/g, starts = [], m;
        while ((m = head.exec(text))) starts.push({ name: m[1], from: head.lastIndex, at: m.index });
        var out = {};
        starts.forEach(function (s, i) {
            var body = text.slice(s.from, i + 1 < starts.length ? starts[i + 1].at : text.length);
            var row = new RegExp('\\{\\s*(' + NUM + ')\\s*,\\s*\\{\\s*(' + NUM + ')\\s*,\\s*(' + NUM + ')\\s*,\\s*(' + NUM + ')\\s*,\\s*(' + NUM + ')\\s*\\}', 'g');
            var rows = [], r;
            while ((r = row.exec(body))) rows.push([+r[1], +r[2], +r[3], +r[4], +r[5]]);
            out[s.name] = rows;
        });
        return out;
    }

    /* ── Products ──────────────────────────────────────────────────────── */
    function fileEntry(manifest, path) {
        var files = (manifest && manifest.files) || [];
        for (var i = 0; i < files.length; i++) if (files[i].path === path) return files[i];
        return null;
    }
    function srcInfo(entry, manifest) {
        var f = fileEntry(manifest, entry.file);
        return {
            file: entry.file, record: entry.record || null,
            url: cfg.base + ((manifest && manifest.base) || 'lbnl/') + entry.file,
            upstream: f ? f.upstream : null, licenses: f ? (f.licenses || []).slice() : []
        };
    }
    // Identification comes from the manifest ("as identified by the source"); spectra and header values from the file.
    function fromEntry(entry, p, manifest) {
        p.id = entry.id;
        p.name = entry.name;
        p.manufacturer = entry.manufacturer;
        p.igdbId = entry.igdbId;
        p.type = entry.type;
        p.coatedSide = entry.coatedSide || null;
        p.coatedSideSource = p.coatedSide ? 'manifest' : null;
        p['class'] = entry['class'] || null;
        if (entry.thicknessMm > 0) p.thickness = entry.thicknessMm;
        p.fileName = baseName(entry.file);
        p.source = srcInfo(entry, manifest);
        return p;
    }
    // Manifest entry + WCE rows [[µm, Tf, Tb, Rf, Rb], ...] -> Product. Emissivities come from the 5-40 µm data.
    function productFromRecord(entry, rows, manifest) {
        if (!rows || !rows.length) throw new Error('glazing-products.js: no rows for ' + (entry && entry.record));
        var r4 = rows.map(function (r) { return [r[0], r[1], r[3], r[4]]; });
        var F = faceEps(irEmissivity(r4, 'front')), B = faceEps(irEmissivity(r4, 'back'));
        var opt = rows.filter(function (r) { return r[0] <= MAX_NM / 1000 + 1e-9; });
        var p = {
            id: null, name: '', manufacturer: '', igdbId: null, type: null, coatedSide: null, 'class': null,
            thickness: NaN, k: 1.0, ef: F.v, eb: B.v, efSource: F.src, ebSource: B.src, warnings: [],
            wl: opt.map(function (r) { return r[0] * 1000; }),
            T: opt.map(function (r) { return r[1]; }), Rf: opt.map(function (r) { return r[3]; }), Rb: opt.map(function (r) { return r[4]; }),
            points: opt.length, fileName: null, source: null
        };
        if (F.raw != null) p.efComputed = F.raw;
        if (B.raw != null) p.ebComputed = B.raw;
        return fromEntry(entry, p, manifest || state.manifest);
    }

    // coatingFaces: 'outdoors' | 'indoors', the user's choice. Returns the `flipped` argument of GlazingEngine.imported.
    function flipFor(product, coatingFaces) {
        var side = product && product.coatedSide;
        if (side === 'back') return coatingFaces === 'outdoors';
        if (side === 'front') return coatingFaces === 'indoors';
        return false;
    }
    function layer(product, coatingFaces, E) {
        E = E || root.GlazingEngine;
        if (!E || typeof E.imported !== 'function') throw new Error('glazing-products.js: load glazing-engine.js first');
        return E.imported(product, flipFor(product, coatingFaces));
    }

    /* ── Attribution (spec 6.2 a) ──────────────────────────────────────── */
    var IGDB_URL = 'https://windows.lbl.gov/igdb-license', CC_URL = 'https://creativecommons.org/licenses/by-nd/4.0/';
    var COPY = 'Copyright (c) 2011, The Regents of the University of California, through Lawrence Berkeley National Laboratory';
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function given(m) { return !!m && !/not given/i.test(m); }
    // parts: strings (plain text) or [text, href] pairs; the text form drops the links.
    function render(parts) {
        var text = '', html = '';
        parts.forEach(function (p) {
            if (Array.isArray(p)) { text += p[0]; html += '<a href="' + esc(p[1]) + '" rel="noopener">' + esc(p[0]) + '</a>'; }
            else { text += p; html += esc(p); }
        });
        return { text: text, html: html };
    }
    function attribution(product, manifest) {
        if (!product) return { text: '', html: '' };
        manifest = manifest || state.manifest;
        if (!product.source) {
            return render([product.name + ', imported by you from ' + (product.fileName || 'your file') + '. It stays in this browser and is not uploaded. ' +
                'If it is an IGDB record: International Glazing Database (IGDB), ' + COPY + '; licensed under ', ['CC BY-ND 4.0', CC_URL], '.']);
        }
        var m = product.manufacturer;
        var supplier = m === 'Generic' ? 'Generic record of the IGDB.' : given(m) ? 'Data submitted to the IGDB by the manufacturer.' : '';
        var file = product.source.file || '';
        var project = /^wce\//.test(file) ? 'Windows-CalcEngine (src/helper/optical/spectralSampleData.cpp)' : 'pyWinCalc (examples/products)';
        var fe = fileEntry(manifest, file), upstream = (fe && fe.upstream) || product.source.upstream || '';
        var notice = cfg.base + ((manifest && manifest.base) || 'lbnl/') + 'NOTICE.txt';
        return render([
            product.name + ', ' + (given(m) ? m : 'manufacturer not given in the source') + ', IGDB ' + product.igdbId + '. Spectral data from the ',
            ['International Glazing Database (IGDB)', IGDB_URL],
            ', ' + COPY + ' (subject to receipt of any required approvals from the U.S. Department of Energy). All rights reserved. Licensed under ',
            ['CC BY-ND 4.0', CC_URL],
            '. ' + (supplier ? supplier + ' ' : '') + 'Source file: ',
            upstream ? [baseName(file), upstream] : baseName(file),
            ', redistributed unmodified from LBNL ' + project + ', which is distributed under a ',
            ['BSD-style license', notice],
            '. The spectra are resampled to a 5 nm grid in your browser for this calculation only. Provided as is, without warranties; ' +
            'see section 5 of the license. Product names identify the products only and do not imply endorsement.'
        ]);
    }

    /* ── Loading ───────────────────────────────────────────────────────── */
    var cfg = { base: '/assets/data/glazing/', loadBytes: null, verify: false };
    var state = freshState();
    function freshState() { return { manifest: null, manifestP: null, files: {}, records: {}, products: {} }; }

    function defaultLoadBytes(path) {
        var name = baseName(path);
        function fail(what) { return new Error('Could not load ' + name + ': ' + what + '. Check your connection and try again.'); }
        if (typeof fetch !== 'function') return Promise.reject(fail('no fetch() in this environment'));
        return fetch(cfg.base + path).then(function (r) {
            if (!r.ok) throw fail(r.status);
            return r.arrayBuffer();
        }, function () { throw fail('network error'); }).then(function (buf) { return new Uint8Array(buf); });
    }
    // configure({ base, loadBytes, verify }): loadBytes(path) gets a path relative to base and returns bytes (or a
    // promise of bytes). Every call clears the caches.
    function configure(o) {
        o = o || {};
        if (o.base != null) cfg.base = String(o.base);
        if (o.loadBytes !== undefined) cfg.loadBytes = typeof o.loadBytes === 'function' ? o.loadBytes : null;
        if (o.verify !== undefined) cfg.verify = !!o.verify;
        state = freshState();
        return { base: cfg.base, verify: cfg.verify, injected: !!cfg.loadBytes };
    }
    function getBytes(path) {
        var f = cfg.loadBytes || defaultLoadBytes;
        return Promise.resolve().then(function () { return f(path); }).then(function (b) {
            if (b == null) throw new Error('Could not load ' + baseName(path) + ': empty response. Check your connection and try again.');
            return typeof b === 'string' ? b : bytesOf(b);
        });
    }
    function cached(obj, key, make) {
        if (!obj[key]) {
            var p = make();
            obj[key] = p;
            p.catch(function () { if (obj[key] === p) delete obj[key]; });   // a failed load may be retried
        }
        return obj[key];
    }
    function loadManifest() {
        if (state.manifest) return Promise.resolve(state.manifest);
        var s = state;
        return cached(s, 'manifestP', function () {
            return getBytes('manifest.json').then(function (b) {
                var m = JSON.parse(typeof b === 'string' ? b : decodeUTF8(b));
                if (!m || !Array.isArray(m.products) || !Array.isArray(m.files)) throw new Error('manifest.json: unexpected content.');
                s.manifest = m;
                return m;
            });
        });
    }
    function hex(buf) {
        var a = new Uint8Array(buf), out = '';
        for (var i = 0; i < a.length; i++) out += (a[i] < 16 ? '0' : '') + a[i].toString(16);
        return out;
    }
    function verifyBytes(b, entry, path) {
        if (!cfg.verify || !entry || !entry.sha256) return Promise.resolve(b);
        var name = baseName(path), subtle = root.crypto && root.crypto.subtle;
        if (!subtle) return Promise.reject(new Error('Could not verify ' + name + ': this browser has no crypto.subtle.'));
        if (typeof b === 'string') return Promise.reject(new Error('Could not verify ' + name + ': expected bytes.'));
        var u8 = b instanceof Uint8Array ? b : Uint8Array.from(b);
        return subtle.digest('SHA-256', u8).then(function (d) {
            if (hex(d) !== String(entry.sha256).toLowerCase()) throw new Error('Could not load ' + name + ': its SHA-256 does not match manifest.json.');
            return b;
        });
    }
    // Each file is read once; the parsed WCE records are cached per file, and products per id.
    function loadFile(manifest, file) {
        return cached(state.files, file, function () {
            var path = (manifest.base || 'lbnl/') + file;
            return getBytes(path).then(function (b) { return verifyBytes(b, fileEntry(manifest, file), path); });
        });
    }
    function wceRecords(manifest, file) {
        return cached(state.records, file, function () {
            return loadFile(manifest, file).then(function (b) { return parseWCECpp(typeof b === 'string' ? b : decodeUTF8(b)); });
        });
    }
    function loadProduct(id) {
        return cached(state.products, id, function () {
            return loadManifest().then(function (m) {
                var entry = null;
                for (var i = 0; i < m.products.length; i++) if (m.products[i].id === id) entry = m.products[i];
                if (!entry) throw new Error('Unknown product ' + id + '.');
                var fe = fileEntry(m, entry.file);
                if (!fe) throw new Error('manifest.json: product ' + id + ' names a file that is not listed (' + entry.file + ').');
                if (fe.format === 'wce-cpp') {
                    return wceRecords(m, entry.file).then(function (recs) {
                        if (!recs[entry.record]) throw new Error('Record ' + entry.record + ' was not found in ' + baseName(entry.file) + '.');
                        return productFromRecord(entry, recs[entry.record], m);
                    });
                }
                return loadFile(m, entry.file).then(function (b) {
                    return fromEntry(entry, parseIGDBText(typeof b === 'string' ? b : decode1252(b), entry.file), m);
                });
            });
        });
    }

    var api = {
        EPS_GLASS: EPS_GLASS, EN12898: EN12898,
        EPS_SOURCE_LABELS: { header: 'from the file header', computed: "computed from the record's infrared spectrum", assumed: 'assumed 0.84' },
        // pure
        decode1252: decode1252, parseIGDBText: parseIGDBText, parseIGSDBJSON: parseIGSDBJSON, parseWCECpp: parseWCECpp,
        irEmissivity: irEmissivity, hemispherical: hemispherical, productFromRecord: productFromRecord,
        flipFor: flipFor, layer: layer, attribution: attribution,
        // loading
        configure: configure, loadManifest: loadManifest, loadProduct: loadProduct
    };
    root.GlazingProducts = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
