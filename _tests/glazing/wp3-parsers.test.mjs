// V8, part 2 (glazing beta build spec, section 5.3): the pure functions of assets/js/glazing-products.js and its
// loader's error paths. Importer inputs are the synthetic fixtures in _tests/glazing/fixtures/ (made-up numbers,
// never IGDB data) and a synthetic IGSDB record built below. Real IGDB data are read only from the shipped files.
// Run: node --test "_tests/glazing/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, ROOT } from './helpers/load.mjs';
import { readIGDB, LBNL } from './helpers/records.mjs';

const FILES = ['assets/js/glazing-weights.js', 'assets/js/glazing-engine.js', 'assets/js/glazing-products.js'];
const ctx = load(FILES);
const P = ctx.GlazingProducts, E = ctx.GlazingEngine;
const DATA = path.join(ROOT, 'assets/data/glazing');
const FIX = path.join(ROOT, '_tests/glazing/fixtures');
const fixture = name => fs.readFileSync(path.join(FIX, name), 'latin1');
const readData = p => fs.promises.readFile(path.join(DATA, p));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('fixtures are synthetic and say so on their first line', () => {
    for (const f of fs.readdirSync(FIX)) {
        assert.equal(fs.readFileSync(path.join(FIX, f), 'utf8').split(/\r?\n/)[0], '{ Synthetic test data, not from any database }', f);
    }
});

test('decode1252: 0x99 ™, 0xAE ®, 0x96 –, 0x80 €; ASCII and Latin-1 unchanged', () => {
    assert.equal(P.decode1252(Uint8Array.from([0x99, 0xAE, 0x96, 0x80])), '™®–€');
    assert.equal(P.decode1252(Uint8Array.from([0x41, 0x20, 0x7A, 0xE9, 0xFF])), 'A zéÿ');
    assert.equal(P.decode1252(Buffer.from([0x93, 0x94, 0x9F])), '“”Ÿ');   // a Node Buffer works too
    assert.equal(P.decode1252(new Uint8Array([0x99]).buffer), '™');                       // and an ArrayBuffer
    // The shipped CLEAR5.LOF names its product with 0x99.
    const text = P.decode1252(fs.readFileSync(path.join(DATA, 'lbnl/pywincalc/CLEAR5.LOF')));
    assert.ok(text.includes('{ Product Name: Optifloat™ Clear }'));
});

test('parseIGDBText: "Emis= 0.84 4.657817E-02" gives eb 0.04657817 (the live importer\'s exponent bug)', () => {
    const p = P.parseIGDBText(fixture('synthetic-exponent.txt'), 'synthetic-exponent.txt');
    assert.equal(p.ef, 0.84);
    assert.equal(p.eb, 0.04657817);
    assert.equal(p.efSource, 'header');
    assert.equal(p.ebSource, 'header');
    assert.equal(p.coatedSide, 'back');            // "Coated Side: Back" is read
    assert.equal(p.coatedSideSource, 'header');
    assert.equal(p.type, 'coated');
    assert.equal(p.name, 'Synthetic Coated Sample');
    assert.equal(p.manufacturer, 'Example Maker');
    assert.equal(p.igdbId, 99999);
    assert.equal(p.thickness, 4);
    assert.equal(p.k, 1);
    assert.equal(p.wl.length, 45);
    assert.equal(p.wl[0], 300);                    // microns from the units header, converted to nm
    near(p.wl[44], 2500, 1e-9, 'last wavelength');
    near(p.T[0], 0.82, 1e-12, 'T is a fraction');
    assert.equal(p.warnings.length, 0);
    assert.equal(p.source, null);
    assert.equal(p.fileName, 'synthetic-exponent.txt');
    // An ordinary engine layer comes out of it, and flipping swaps the faces.
    const L = P.layer(p, 'indoors', E), F = P.layer(p, 'outdoors', E);
    assert.equal(L.eb, 0.04657817);
    assert.equal(F.ef, 0.04657817);
    assert.equal(L.t, 0.004);
});

test('parseIGDBText: an emissivity of 4.66 gives 0.84 and a visible warning', () => {
    const p = P.parseIGDBText(fixture('synthetic-bad-emis.txt'), 'synthetic-bad-emis.txt');
    assert.equal(p.ef, 0.84);
    assert.equal(p.efSource, 'assumed');
    assert.equal(p.eb, 0.84);
    assert.equal(p.warnings.length, 1);
    assert.match(p.warnings[0], /Front emissivity 4\.66 is outside \(0, 1\]; using 0\.84/);
    assert.equal(p.coatedSide, 'front');
});

test('parseIGDBText: fewer than 20 rows, and a 500-1500 nm span, give clear errors', () => {
    assert.throws(() => P.parseIGDBText(fixture('synthetic-few-rows.txt'), 'synthetic-few-rows.txt'),
        e => /^synthetic-few-rows\.txt: found 12 data rows\. A spectral file needs at least 20 rows of four numbers: wavelength, T, Rfront, Rback\.$/.test(e.message));
    assert.throws(() => P.parseIGDBText(fixture('synthetic-narrow.txt'), 'synthetic-narrow.txt'),
        e => /^synthetic-narrow\.txt: the spectrum covers 500–1500 nm; it must span at least 400–2000 nm/.test(e.message));
    assert.throws(() => P.parseIGDBText('not a spectral file at all'), /found 0 data rows/);
    assert.throws(() => P.parseIGDBText(''), /found 0 data rows/);
});

test('parseIGDBText: nanometres and percent are detected (comma-separated, header-less user data)', () => {
    const p = P.parseIGDBText(fixture('synthetic-percent-nm.txt'), 'synthetic-percent-nm.txt');
    assert.equal(p.wl[0], 300);
    assert.equal(p.wl[p.wl.length - 1], 2500);
    near(p.T[0], 0.82, 1e-12, 'percent divided by 100');
    near(p.Rb[0], 0.06, 1e-12, 'Rb');
    assert.ok(p.warnings.some(w => /read as percent/.test(w)));
    // No emissivity in the file and no infrared rows: 0.84 assumed, with a warning because the back looks coated.
    assert.equal(p.ef, 0.84); assert.equal(p.eb, 0.84);
    assert.equal(p.efSource, 'assumed'); assert.equal(p.ebSource, 'assumed');
    assert.ok(p.warnings.some(w => /no back emissivity, but the back looks coated/.test(w)), p.warnings.join(' | '));
    assert.ok(!p.warnings.some(w => /front looks coated/.test(w)));
    assert.equal(p.thickness, 6);
    assert.ok(p.warnings.some(w => /no thickness; assumed 6 mm/.test(w)));
    assert.equal(p.coatedSide, null);
    assert.equal(p.name, 'synthetic-percent-nm.txt');
});

test('parseIGDBText: without an emissivity header, infrared rows give computed emissivities and the coated side', () => {
    const p = P.parseIGDBText(fixture('synthetic-ir.txt'), 'synthetic-ir.txt');
    assert.equal(p.efSource, 'computed');
    assert.equal(p.ebSource, 'computed');
    assert.equal(p.ef, 0.84);                      // 1 - 0.12 = 0.88 normal: an uncoated face by the 0.5 rule
    near(p.eb, 0.05 * 1.18, 1e-9, 'eb: 1 - 0.95 = 0.05 normal, x1.18 hemispherical');
    assert.equal(p.coatedSide, 'back');
    assert.equal(p.coatedSideSource, 'inferred');  // lower-emissivity face
    assert.ok(p.wl[p.wl.length - 1] <= 2500);      // infrared rows are not kept for the optics
    assert.equal(p.wl.length, 45);
});

function igsdb(over) {
    const rows = [];
    for (let i = 0; i <= 44; i++) {
        const w = 0.3 + i * 0.05, x = (w - 0.3) / 2.2;
        rows.push({ wavelength: w, T: 0.8 - 0.3 * x, Rf: 0.05 + 0.3 * x, Rb: 0.07 });
    }
    return Object.assign({
        _comment: 'Synthetic test data, not from any database',
        id: 1, name: 'Synthetic IGSDB Sample', nfrc_id: 12345, manufacturer_name: 'Example Maker', type: 'glazing', subtype: 'coated',
        coated_side: 'Front', measured_data: { is_specular: true, thickness: 5.5, emissivity_front: 0.035, emissivity_back: 0.84, conductivity: 1.0 },
        spectral_data: { spectral_data: rows }
    }, over);
}

test('parseIGSDBJSON: the IGSDB schema fields of spec 2.7.3', () => {
    const p = P.parseIGSDBJSON(JSON.stringify(igsdb()), 'sample.json');
    assert.equal(p.name, 'Synthetic IGSDB Sample');
    assert.equal(p.manufacturer, 'Example Maker');
    assert.equal(p.igdbId, 12345);
    assert.equal(p.thickness, 5.5);
    assert.equal(p.k, 1.0);
    assert.equal(p.ef, 0.035); assert.equal(p.efSource, 'header');
    assert.equal(p.eb, 0.84);
    assert.equal(p.coatedSide, 'front');
    assert.equal(p.type, 'coated');
    assert.equal(p.wl.length, 45);
    near(p.wl[0], 300, 1e-9, 'µm to nm');
    near(p.Rf[44], 0.35, 1e-12, 'Rf');
    // A one-element array (as some API listings return) works; missing spectra and bad JSON give messages.
    assert.equal(P.parseIGSDBJSON(JSON.stringify([igsdb()])).name, 'Synthetic IGSDB Sample');
    assert.throws(() => P.parseIGSDBJSON(JSON.stringify(igsdb({ spectral_data: null })), 'x.json'), { message: /^x\.json: no spectral_data\.spectral_data array found/ });
    assert.throws(() => P.parseIGSDBJSON('{ "name": ', 'x.json'), { message: /^x\.json: this is not valid JSON/ });
    // Without coated_side and with the emissivities only, the lower-emissivity face is taken as coated.
    const q = P.parseIGSDBJSON(JSON.stringify(igsdb({ coated_side: undefined, measured_data: { thickness: 3, emissivity_front: 0.84, emissivity_back: 0.1 } })));
    assert.equal(q.coatedSide, 'back');
    assert.equal(q.coatedSideSource, 'inferred');
    // coated_side "Neither" means no coating, whatever the emissivities.
    assert.equal(P.parseIGSDBJSON(JSON.stringify(igsdb({ coated_side: 'Neither' }))).coatedSide, null);
});

// ── Fix round 1 (synthetic data only) ──────────────────────────────────────────────────────────────────────
test('IGSDB JSON and header-less text in µm whose infrared rows reach 50 µm or beyond are read as µm', () => {
    for (const last of [40, 50, 60]) {
        const rows = igsdb().spectral_data.spectral_data.slice();
        for (let w = 5; w <= last; w += 5) rows.push({ wavelength: w, T: 0, Rf: 0.9, Rb: 0.1 });
        const p = P.parseIGSDBJSON(JSON.stringify(igsdb({ spectral_data: { spectral_data: rows }, measured_data: { thickness: 4 } })), 'x.json');
        near(p.wl[0], 300, 1e-9, last + ' µm: first wavelength');
        assert.equal(p.wl.length, 45);
        near(p.ef, 0.1 * 1.14, 1e-9, last + ' µm: front emissivity from the 5-40 µm rows');
    }
    let t = '{ Synthetic test data, not from any database }\n';
    for (let i = 0; i <= 44; i++) t += (0.3 + i * 0.05).toFixed(3) + ' 0.8 0.08 0.08\n';
    for (let w = 5; w <= 50; w += 5) t += w + ' 0 0.9 0.1\n';
    const q = P.parseIGDBText(t, 't.txt');
    near(q.wl[0], 300, 1e-9, 'text: µm'); assert.equal(q.wl.length, 45);
});

// Synthetic rows in nm, 300 to 2500 nm every 20 nm: f(nm) -> [T, Rf, Rb].
function synthText(f, lo = 300, hi = 2500) {
    let t = '{ Synthetic test data, not from any database }\n{ Thickness } 4\n';
    for (let nm = lo; nm <= hi; nm += 20) t += nm + ' ' + f(nm).join(' ') + '\n';
    return t;
}
test('import range checks: T or R outside 0 to 1, or T + R above 1, is rejected with the wavelength; small noise is clipped', () => {
    assert.throws(() => P.parseIGDBText(synthText(() => [1.2, 0.3, 0.3]), 'over1.txt'),
        e => /^over1\.txt: at 300 nm, T = 1\.2 is outside 0 to 1\. Give T and R as fractions \(0 to 1\) or as percent \(0 to 100\)/.test(e.message));
    assert.throws(() => P.parseIGDBText(synthText(() => [-0.2, 0.08, 0.08]), 'negative.txt'), e => /at 300 nm, T = −0\.2 is outside 0 to 1/.test(e.message));
    assert.throws(() => P.parseIGDBText(synthText(nm => [0.9, nm === 560 ? 0.6 : 0.08, 0.08]), 'sum.txt'),
        e => /^sum\.txt: at 560 nm, T \+ Rfront = 1\.5, more than 1/.test(e.message));
    // a dark product given in percent with every value at or below 1.5 cannot be read as fractions silently
    assert.throws(() => P.parseIGDBText(synthText(() => [1.2, 1.0, 1.0]), 'dark.txt'), /outside 0 to 1/);
    // noise: -0.003 and 1.003 are clipped; T + R up to 1.02 is reduced to 1, with warnings
    const p = P.parseIGDBText(synthText(nm => (nm === 400 ? [-0.003, 0.08, 0.08] : nm === 600 ? [0.9, 0.11, 0.05] : [0.8, 0.08, 0.08])), 'noise.txt');
    assert.equal(Math.min(...p.T), 0);
    const i600 = p.wl.indexOf(600);
    near(p.T[i600] + p.Rf[i600], 1, 1e-12, 'T + Rf reduced to 1');
    assert.ok(p.warnings.some(w => /^One value slightly outside 0 to 1/.test(w)), p.warnings.join(' | '));
    assert.ok(p.warnings.some(w => /^T \+ R exceeds 1 by up to 0\.01 at 1 point; R was reduced there/.test(w)), p.warnings.join(' | '));
    // the shipped LBNL files pass the checks unchanged (no clipping, no warnings about range)
    for (const f of ['CLEAR_3.DAT', 'CLEAR_6.DAT', 'CLEAR5.LOF', 'LOW-E_5.LOF', 'CSR42_3.afg']) {
        const q = P.parseIGDBText(P.decode1252(fs.readFileSync(path.join(DATA, 'lbnl/pywincalc', f))), f);
        assert.ok(!q.warnings.some(w => /clipped|exceeds 1|Data start|Data end/.test(w)), f + ': ' + q.warnings.join(' | '));
    }
});

test('imports that do not cover 300-2500 nm say what is extrapolated and keep their range', () => {
    const a = P.parseIGDBText(synthText(() => [0.8, 0.08, 0.08], 400, 2000), 'flat400.txt');
    assert.deepEqual(Array.from(a.range), [400, 2000]);
    assert.ok(a.warnings.some(w => /^Data start at 400 nm; .*UV transmittance is not available/.test(w)), a.warnings.join(' | '));
    assert.ok(a.warnings.some(w => /^Data end at 2000 nm; .*held constant to 2500 nm/.test(w)));
    const b = P.parseIGDBText(synthText(() => [0.8, 0.08, 0.08]), 'flat300.txt');
    assert.deepEqual(Array.from(b.range), [300, 2500]);
    assert.ok(!b.warnings.some(w => /Data start|Data end/.test(w)));
    // Fix round 2: 10 nm of slack at the long end (IGDB 913's last row at or below 2500 nm is 2494 nm)
    const c = P.parseIGDBText(synthText(() => [0.8, 0.08, 0.08], 300, 2480) + '2494 0.8 0.08 0.08\n', 'to2494.txt');
    assert.ok(!c.warnings.some(w => /Data end/.test(w)), c.warnings.join(' | '));
    const d = P.parseIGDBText(synthText(() => [0.8, 0.08, 0.08], 300, 2480), 'to2480.txt');
    assert.ok(d.warnings.some(w => /^Data end at 2480 nm/.test(w)), d.warnings.join(' | '));
});

test('parseWCECpp: the 17 records of the shipped spectralSampleData.cpp with the row counts of Appendix B', () => {
    const recs = P.parseWCECpp(fs.readFileSync(path.join(DATA, 'lbnl/wce/spectralSampleData.cpp'), 'utf8'));
    const want = { NFRC_102: [111, 0.3, 2.5], NFRC_103: [111, 0.3, 2.5], NFRC_913: [156, 0.305, 40], NFRC_1042: [496, 0.3, 40],
        NFRC_2191: [132, 0.3, 25], NFRC_2600: [441, 0.3, 2.5], NFRC_5439: [147, 0.3, 40], NFRC_6046: [147, 0.3, 40],
        NFRC_20243: [441, 0.3, 2.5], NFRC_21467: [462, 0.3, 25], NFRC_21515: [111, 0.3, 2.5], NFRC_31100: [441, 0.3, 2.5],
        NFRC_31111: [441, 0.3, 2.5], NFRC_VE348: [147, 0.3, 40], DirectDiffuse: [17, 0.3, 2.5], ILC2019_1: [441, 0.3, 2.5], ILC2019_2: [441, 0.3, 2.5] };
    assert.deepEqual(Object.keys(recs), Object.keys(want));
    for (const [k, [n, a, b]] of Object.entries(want)) {
        assert.equal(recs[k].length, n, k);
        assert.equal(recs[k][0][0], a, k);
        assert.equal(recs[k][n - 1][0], b, k);
        assert.equal(recs[k][0].length, 5, k);
    }
    // Rows are [µm, Tf, Tb, Rf, Rb] with fractions (no spectral values are copied into this public test).
    for (const k of ['NFRC_102', 'NFRC_2191', 'NFRC_5439']) assert.ok(recs[k].every(r => r.slice(1).every(v => v >= 0 && v <= 1)), k);
    // CRLF line endings would not change the result.
    const crlf = P.parseWCECpp(fs.readFileSync(path.join(DATA, 'lbnl/wce/spectralSampleData.cpp'), 'utf8').replace(/\n/g, '\r\n'));
    assert.equal(crlf.NFRC_5439.length, 147);
});

test('irEmissivity reproduces the two IGDB header values it can be compared with (within 0.005)', () => {
    const csr = readIGDB(LBNL + 'pywincalc/CSR42_3.afg'), ea = readIGDB(LBNL + 'pywincalc/LOW-E_5.LOF');
    const b1042 = P.irEmissivity(csr.rows, 'back'), f9923 = P.irEmissivity(ea.rows, 'front');
    near(b1042.eh, csr.eb, 0.005, '1042 back');      // 0.0437 vs header 0.04657817
    near(f9923.eh, ea.ef, 0.005, '9923 front');      // 0.1543 vs header 0.1579693
    near(b1042.eh, 0.0437, 0.00005, '1042 back vs the spec value');
    near(f9923.eh, 0.1543, 0.00005, '9923 front vs the spec value');
    assert.ok(P.irEmissivity(csr.rows, 'front').eh > 0.8);   // the uncoated face
    assert.equal(P.irEmissivity(csr.rows.filter(r => r[0] < 5), 'back'), null);
});

test('hemispherical: the EN 12898 ratio table, linear in en, x1.22 below 0.03 and x0.94 above 0.89', () => {
    near(P.hemispherical(0.02), 0.0244, 1e-12, '0.02');
    near(P.hemispherical(0.03), 0.0366, 1e-12, '0.03');
    near(P.hemispherical(0.04), 0.04 * 1.20, 1e-12, '0.04');
    near(P.hemispherical(0.1), 0.114, 1e-12, '0.1');
    near(P.hemispherical(0.5), 0.5, 1e-12, '0.5');
    near(P.hemispherical(0.89), 0.89 * 0.94, 1e-12, '0.89');
    near(P.hemispherical(0.95), 0.95 * 0.94, 1e-12, '0.95');
});

test('flipFor: all six combinations of coated side and coating faces', () => {
    const f = (side, faces) => P.flipFor({ coatedSide: side }, faces);
    assert.equal(f('back', 'outdoors'), true);
    assert.equal(f('back', 'indoors'), false);
    assert.equal(f('front', 'outdoors'), false);
    assert.equal(f('front', 'indoors'), true);
    assert.equal(f(null, 'outdoors'), false);
    assert.equal(f(null, 'indoors'), false);
});

// Spec 6.2 (a), text form: the template with the link markers dropped.
const TEMPLATE = '{name}, {manufacturerText}, IGDB {igdbId}. Spectral data from the International Glazing Database (IGDB), ' +
    'Copyright (c) 2011, The Regents of the University of California, through Lawrence Berkeley National Laboratory (subject to receipt of any ' +
    'required approvals from the U.S. Department of Energy). All rights reserved. Licensed under CC BY-ND 4.0. {supplierSentence} Source file: ' +
    '{fileName}, redistributed unmodified from LBNL {projectName}, which is distributed under a BSD-style license. The spectra are resampled to ' +
    'a 5 nm grid in your browser for this calculation only. Provided as is, without warranties; see section 5 of the license. Product names ' +
    'identify the products only and do not imply endorsement.';
const fill = v => TEMPLATE.replace(/\{(\w+)\}/g, (m, k) => v[k]).replace('4.0.  Source', '4.0. Source');

test('attribution: the 6.2 (a) template, filled in, for igdb-5439, igdb-102 and igdb-6046; HTML links and escaping', async () => {
    const c = load(FILES), Q = c.GlazingProducts;
    Q.configure({ base: '/assets/data/glazing/', loadBytes: readData });
    const m = await Q.loadManifest();
    const p5439 = await Q.loadProduct('igdb-5439'), p102 = await Q.loadProduct('igdb-102'), p6046 = await Q.loadProduct('igdb-6046');
    assert.equal(Q.attribution(p5439, m).text, fill({ name: 'Solarban® 70 glass, 6 mm', manufacturerText: 'Vitro Architectural Glass (formerly PPG)',
        igdbId: 5439, supplierSentence: 'Data submitted to the IGDB by the manufacturer.', fileName: 'spectralSampleData.cpp',
        projectName: 'Windows-CalcEngine (src/helper/optical/spectralSampleData.cpp)' }));
    assert.equal(Q.attribution(p102, m).text, fill({ name: 'Generic Clear Glass', manufacturerText: 'Generic', igdbId: 102,
        supplierSentence: 'Generic record of the IGDB.', fileName: 'CLEAR_3.DAT', projectName: 'pyWinCalc (examples/products)' }));
    assert.equal(Q.attribution(p6046, m).text, fill({ name: p6046.name, manufacturerText: 'manufacturer not given in the source', igdbId: 6046,
        supplierSentence: '', fileName: 'spectralSampleData.cpp', projectName: 'Windows-CalcEngine (src/helper/optical/spectralSampleData.cpp)' }));
    const html = Q.attribution(p102, m).html;
    assert.ok(html.includes('<a href="https://windows.lbl.gov/igdb-license" rel="noopener">International Glazing Database (IGDB)</a>'));
    assert.ok(html.includes('<a href="https://creativecommons.org/licenses/by-nd/4.0/" rel="noopener">CC BY-ND 4.0</a>'));
    assert.ok(html.includes('<a href="https://github.com/LBNL-ETA/pyWinCalc/blob/a55b86617ed36fb527a750a34d9a93bc9830512a/examples/products/CLEAR_3.DAT" rel="noopener">CLEAR_3.DAT</a>'));
    assert.ok(html.includes('<a href="/assets/data/glazing/lbnl/NOTICE.txt" rel="noopener">BSD-style license</a>'));
    assert.equal(html.replace(/<[^>]+>/g, ''), Q.attribution(p102, m).text);
    // Imported products: the 6.2 (a) import text; names are escaped in the HTML.
    const imp = Q.parseIGDBText(fixture('synthetic-exponent.txt'), 'synthetic-exponent.txt');
    imp.name = 'A <b> & "c"';
    const a = Q.attribution(imp, m);
    assert.equal(a.text, 'A <b> & "c", imported by you from synthetic-exponent.txt. It stays in this browser and is not uploaded. If it is an IGDB ' +
        'record: International Glazing Database (IGDB), Copyright (c) 2011, The Regents of the University of California, through Lawrence Berkeley ' +
        'National Laboratory; licensed under CC BY-ND 4.0.');
    assert.ok(a.html.startsWith('A &lt;b&gt; &amp; &quot;c&quot;, imported by you'));
    assert.ok(a.html.includes('<a href="https://creativecommons.org/licenses/by-nd/4.0/" rel="noopener">CC BY-ND 4.0</a>'));
});

test('loader: default fetch path, errors with the specified message, retry after a failure', async () => {
    const calls = [];
    let mode = 'status';
    const fetch = url => {
        calls.push(url);
        if (mode === 'status') return Promise.resolve({ ok: false, status: 404 });
        if (mode === 'network') return Promise.reject(new TypeError('Failed to fetch'));
        const p = url.replace(/^\/base\//, '');
        return fs.promises.readFile(path.join(DATA, p)).then(b => ({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) }));
    };
    const c = load(FILES, { fetch }), Q = c.GlazingProducts;
    Q.configure({ base: '/base/' });
    await assert.rejects(Q.loadManifest(), { message: 'Could not load manifest.json: 404. Check your connection and try again.' });
    assert.equal(calls[0], '/base/manifest.json');
    mode = 'network';
    await assert.rejects(Q.loadManifest(), { message: 'Could not load manifest.json: network error. Check your connection and try again.' });
    mode = 'ok';
    const m = await Q.loadManifest();
    assert.equal(m.products.length, 9);
    const p = await Q.loadProduct('igdb-9803');
    assert.equal(p.name, 'Optifloat™ Clear');
    assert.equal(calls[calls.length - 1], '/base/lbnl/pywincalc/CLEAR5.LOF');
    mode = 'status';
    await assert.rejects(Q.loadProduct('igdb-5439'), { message: 'Could not load spectralSampleData.cpp: 404. Check your connection and try again.' });
    mode = 'ok';
    assert.equal((await Q.loadProduct('igdb-5439')).igdbId, 5439);   // a failed load is not cached
    await assert.rejects(Q.loadProduct('igdb-0'), /Unknown product igdb-0/);
});

test('loader: verify checks each file\'s SHA-256 against the manifest (crypto.subtle)', async () => {
    const c = load(FILES, { crypto: globalThis.crypto }), Q = c.GlazingProducts;
    Q.configure({ base: '/assets/data/glazing/', loadBytes: readData, verify: true });
    assert.equal((await Q.loadProduct('igdb-102')).igdbId, 102);
    assert.equal((await Q.loadProduct('igdb-2191')).igdbId, 2191);
    Q.configure({
        verify: true,
        loadBytes: async p => {
            const b = Buffer.from(await readData(p));
            if (p.endsWith('CLEAR_6.DAT')) b[b.length - 2] ^= 1;   // a damaged copy, in memory only
            return b;
        }
    });
    await assert.rejects(Q.loadProduct('igdb-103'), { message: 'Could not load CLEAR_6.DAT: its SHA-256 does not match manifest.json.' });
    const plain = load(FILES).GlazingProducts;   // no crypto in this context
    plain.configure({ loadBytes: readData, verify: true });
    await assert.rejects(plain.loadProduct('igdb-102'), /no crypto\.subtle/);
});

test('layer() builds the engine layer through flipFor, and needs the engine', () => {
    const p = P.parseIGDBText(fixture('synthetic-exponent.txt'));
    const a = P.layer(p, 'outdoors'), b = E.imported(p, true);
    assert.deepEqual(Array.from(a.Rf), Array.from(b.Rf));
    assert.equal(a.ef, b.ef);
    const bare = load(['assets/js/glazing-products.js']).GlazingProducts;
    assert.throws(() => bare.layer(p, 'indoors'), /load glazing-engine\.js first/);
});
