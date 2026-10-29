// V8, part 1 (glazing beta build spec, section 5.3): the shipped LBNL files, manifest.json, NOTICE.txt, and the nine
// named products loaded through GlazingProducts.loadProduct with an injected byte loader (Node). The files under
// assets/data/glazing/lbnl/ are read as bytes and never copied or rewritten.
// Run: node --test "_tests/glazing/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { load, ROOT } from './helpers/load.mjs';

const DATA = path.join(ROOT, 'assets/data/glazing');
const LBNL = path.join(DATA, 'lbnl');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));

// Appendix B of the spec: bytes and SHA-256 of the pinned upstream files.
const PINNED = {
    'pywincalc/CLEAR_3.DAT': [4512, 'ffd6445dc2394dd26174e794a0d719a1ec1b17b8320d0ab7d8a3b6f4d990ab39'],
    'pywincalc/CLEAR_6.DAT': [4510, '33df6cc804cc55c9ddb268222a8ef9a6a6b65d9c205be2e857e7c0513e506967'],
    'pywincalc/CLEAR5.LOF': [13813, 'e8be8080d9008992baf9f1f271c9877f1cae2f7e6eb29c5572030ff4055875d5'],
    'pywincalc/LOW-E_5.LOF': [14695, '3be33fee007bfd502cd1663ea098c1b84f8c51ab107aa18711c25983bb232f27'],
    'pywincalc/CSR42_3.afg': [18462, '3bf8fdcd9dee42e7322e52b8518b6fcf70db727cecae8d2ce6f4e30e5925fd5e'],
    'pywincalc/LICENSE': [4487, 'a0c248fb5de9f5244ac75df2649903a396d7f1119aa82ad7420ee77403331440'],
    'wce/spectralSampleData.cpp': [354034, '592531c96c1e18ca3966f0e4d4934ef9af428bdd9869e7016f7966eaa6e690f9'],
    'wce/License.txt': [3428, 'a75c2e069b0b7cd9d03101800addee633c5bd34f1b688b9d6ac4ec6753e91929']
};
const PYWINCALC = 'a55b86617ed36fb527a750a34d9a93bc9830512a', WCE = '1dedefaf88dd10c7820d920a2ded6e486f1fc672';
// SHA-256 of the exact NOTICE.txt text of spec 6.3 (UTF-8, LF).
const NOTICE_SHA = '6b9d89fd5b512d17a69a3b959337c9666335802a8eea240d221c01e7b42380a7';

function walk(dir, rel = '') {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
        d.isDirectory() ? walk(path.join(dir, d.name), rel + d.name + '/') : [rel + d.name]);
}

test('V8 every shipped LBNL file has the pinned bytes and SHA-256, and nothing else is in lbnl/ but NOTICE.txt', () => {
    const onDisk = walk(LBNL).sort();
    assert.deepEqual(onDisk, Object.keys(PINNED).concat(['NOTICE.txt']).sort());
    for (const [rel, [bytes, hash]] of Object.entries(PINNED)) {
        const b = fs.readFileSync(path.join(LBNL, rel));
        assert.equal(b.length, bytes, rel + ' bytes');
        assert.equal(sha(b), hash, rel + ' sha256');
        assert.ok(!b.includes(13), rel + ' has CR bytes (core.autocrlf?)');
    }
});

test('V8 manifest.json: 8 files with the pinned hashes and full-commit upstream URLs, licenses resolve', () => {
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.base, 'lbnl/');
    assert.deepEqual(manifest.files.map(f => f.path), Object.keys(PINNED));
    for (const f of manifest.files) {
        const [bytes, hash] = PINNED[f.path];
        assert.equal(f.bytes, bytes, f.path);
        assert.equal(f.sha256, hash, f.path);
        assert.match(f.sha256, /^[0-9a-f]{64}$/);
        assert.ok(f.upstream.includes(f.path.startsWith('wce/') ? WCE : PYWINCALC), f.path + ' upstream ' + f.upstream);
        assert.ok(f.upstream.startsWith('https://github.com/LBNL-ETA/'), f.upstream);
        assert.ok(Array.isArray(f.licenses) && f.licenses.length, f.path);
        for (const k of f.licenses) assert.ok(manifest.licenses[k], f.path + ' license ' + k);
        assert.equal(f.format === 'license', /LICENSE|License\.txt/.test(f.path), f.path + ' format ' + f.format);
    }
    const igdb = manifest.licenses.igdb;
    assert.equal(igdb.name, 'CC BY-ND 4.0');
    assert.equal(igdb.url, 'https://creativecommons.org/licenses/by-nd/4.0/');
    assert.equal(igdb.terms, 'https://windows.lbl.gov/igdb-license');
    assert.equal(igdb.verified, '2026-10-12');
    assert.equal(igdb.notice, 'International Glazing Database (IGDB) Copyright (c) 2011, The Regents of the University of California, through Lawrence Berkeley National Laboratory (subject to receipt of any required approvals from the U.S. Department of Energy). All rights reserved.');
    assert.equal(manifest.licenses.pywincalc.file, 'lbnl/pywincalc/LICENSE');
    assert.equal(manifest.licenses.wce.file, 'lbnl/wce/License.txt');
    for (const l of [manifest.licenses.pywincalc, manifest.licenses.wce]) assert.ok(fs.existsSync(path.join(DATA, l.file)), l.file);
});

test('V8 manifest paths match the on-disk names exactly, including case (GitHub Pages is case-sensitive)', () => {
    for (const f of manifest.files) {
        const parts = f.path.split('/');
        let dir = LBNL;
        for (const p of parts) {
            assert.ok(fs.readdirSync(dir).includes(p), `${f.path}: "${p}" not found with this exact case in ${dir}`);
            dir = path.join(dir, p);
        }
    }
});

const ORDER = [
    // id, igdbId, file, record, thickness, coatedSide, class
    ['igdb-102', 102, 'pywincalc/CLEAR_3.DAT', undefined, 3.048, null, 'clear'],
    ['igdb-103', 103, 'pywincalc/CLEAR_6.DAT', undefined, 5.715, null, 'clear'],
    ['igdb-9803', 9803, 'pywincalc/CLEAR5.LOF', undefined, 4.699, null, 'clear'],
    ['igdb-913', 913, 'wce/spectralSampleData.cpp', 'NFRC_913', 4.7752, null, 'tint'],
    ['igdb-9923', 9923, 'pywincalc/LOW-E_5.LOF', undefined, 4.7244, 'front', 'hard'],
    ['igdb-2191', 2191, 'wce/spectralSampleData.cpp', 'NFRC_2191', 3.0, 'back', 'single'],
    ['igdb-1042', 1042, 'pywincalc/CSR42_3.afg', undefined, 3.18, 'back', 'lowe'],
    ['igdb-6046', 6046, 'wce/spectralSampleData.cpp', 'NFRC_6046', 5.66, 'back', 'double'],
    ['igdb-5439', 5439, 'wce/spectralSampleData.cpp', 'NFRC_5439', 6.0, 'back', 'triple']
];

test('V8 manifest.json: 9 products with unique ids, in display order, each naming a listed file', () => {
    const ids = manifest.products.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, ORDER.map(o => o[0]));
    const files = new Set(manifest.files.map(f => f.path));
    for (const [id, igdbId, file, record, mm, side, cls] of ORDER) {
        const p = manifest.products.find(x => x.id === id);
        assert.equal(p.igdbId, igdbId, id);
        assert.equal(p.file, file, id);
        assert.ok(files.has(p.file), id + ' file listed');
        assert.equal(p.record, record, id + ' record');
        assert.equal(p.thicknessMm, mm, id);
        assert.equal(p.coatedSide, side, id);
        assert.equal(p.type, side ? 'coated' : 'monolithic', id);
        assert.equal(p['class'], cls, id);
        for (const k of ['name', 'manufacturer', 'nameSource', 'thicknessSource']) assert.ok(typeof p[k] === 'string' && p[k].length, id + ' ' + k);
        assert.ok(p.emissivity && /^(header|ir)$/.test(p.emissivity.source), id + ' emissivity');
        assert.ok(!/NFRC/.test(p.name), id + ': the UI calls the identifier "IGDB ID", not NFRC');
    }
    const by = id => manifest.products.find(x => x.id === id);
    assert.deepEqual(by('igdb-5439').nameHistory.map(h => h.file), ['SB70XL Starphire_6.VTA', 'Solarban 70XL_6.VTA', 'Solarban 70_6.VTA']);
    assert.ok(by('igdb-6046').note && by('igdb-913').note);
    assert.equal(by('igdb-6046').manufacturer, 'not given in the source');
    assert.equal(by('igdb-9803').name, 'Optifloat™ Clear');
    assert.equal(by('igdb-9923').name, 'Energy Advantage™ Low-E');
    assert.equal(by('igdb-1042').name, 'Comfort Select R-42™ on Clear');
    assert.equal(by('igdb-5439').name, 'Solarban® 70 glass, 6 mm');
    assert.equal(by('igdb-2191').name, 'LoE 180 on 3mm Clear');
});

test('V8 NOTICE.txt equals the text of spec 6.3 (after LF normalization)', () => {
    const text = fs.readFileSync(path.join(LBNL, 'NOTICE.txt'), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(sha(Buffer.from(text, 'utf8')), NOTICE_SHA);
    assert.ok(text.startsWith('Glazing data redistributed with cdfoley.com\n'));
    assert.ok(text.endsWith('LBNL, by the University of California or by the U.S. Department of Energy.\n'));
    // Every shipped file and every offered record is named in it.
    for (const f of Object.keys(PINNED).filter(f => !/LICENSE|License/.test(f))) assert.ok(text.includes(f), f);
    for (const [, igdbId] of ORDER) assert.ok(new RegExp('^  ' + igdbId + ' ', 'm').test(text), 'record ' + igdbId);
});

test('V8 all nine products load (injected byte loader): spectra, thickness, coated side, emissivities', async () => {
    const ctx = load(['assets/js/glazing-weights.js', 'assets/js/glazing-engine.js', 'assets/js/glazing-products.js']);
    const P = ctx.GlazingProducts, reads = [];
    P.configure({ base: '/assets/data/glazing/', loadBytes: p => { reads.push(p); return fs.promises.readFile(path.join(DATA, p)); } });
    const EPS = {   // [ef, eb, efSource, ebSource, tolerance]
        'igdb-102': [0.84, 0.84, 'header', 'header', 0], 'igdb-103': [0.84, 0.84, 'header', 'header', 0],
        'igdb-9803': [0.84, 0.84, 'header', 'header', 0], 'igdb-913': [0.84, 0.84, 'computed', 'computed', 0],
        'igdb-9923': [0.1579693, 0.84, 'header', 'header', 0], 'igdb-2191': [0.84, 0.0651, 'computed', 'computed', 0.0005],
        'igdb-1042': [0.84, 0.04657817, 'header', 'header', 0], 'igdb-6046': [0.84, 0.0379, 'computed', 'computed', 0.0005],
        'igdb-5439': [0.84, 0.0171, 'computed', 'computed', 0.0005]
    };
    const products = await Promise.all(ORDER.map(o => P.loadProduct(o[0])));
    products.forEach((p, i) => {
        const [id, igdbId, file, , mm, side] = ORDER[i], m = manifest.products[i];
        assert.equal(p.id, id);
        assert.equal(p.igdbId, igdbId);
        assert.equal(p.name, m.name, id);
        assert.equal(p.manufacturer, m.manufacturer, id);
        assert.equal(p.thickness, mm, id);
        assert.equal(p.coatedSide, side, id);
        assert.equal(p.k, 1.0, id);
        assert.ok(p.wl.length >= 100, id + ' points ' + p.wl.length);
        assert.ok(p.wl[p.wl.length - 1] <= 2500 && p.wl[0] <= 305, id + ' range');
        for (let j = 1; j < p.wl.length; j++) assert.ok(p.wl[j] > p.wl[j - 1], id + ' ascending');
        for (const k of ['T', 'Rf', 'Rb']) {
            assert.equal(p[k].length, p.wl.length, id + ' ' + k);
            assert.ok(p[k].every(v => v >= 0 && v <= 1), id + ' ' + k + ' in [0, 1]');
        }
        const [ef, eb, efs, ebs, tol] = EPS[id];
        assert.ok(Math.abs(p.ef - ef) <= tol + 1e-12, `${id} ef ${p.ef}`);
        assert.ok(Math.abs(p.eb - eb) <= tol + 1e-12, `${id} eb ${p.eb}`);
        assert.equal(p.efSource, efs, id);
        assert.equal(p.ebSource, ebs, id);
        assert.equal(p.warnings.length, 0, id + ' warnings: ' + p.warnings.join(' | '));
        assert.equal(p.source.file, file);
        assert.equal(p.source.url, '/assets/data/glazing/lbnl/' + file);
        assert.equal(p.source.upstream, manifest.files.find(f => f.path === file).upstream);
        assert.ok(p.source.licenses.includes('igdb'));
    });
    // Each file is read once (the 354 kB WCE file once for its four products), plus the manifest.
    assert.deepEqual(reads.slice().sort(), ['lbnl/pywincalc/CLEAR5.LOF', 'lbnl/pywincalc/CLEAR_3.DAT', 'lbnl/pywincalc/CLEAR_6.DAT',
        'lbnl/pywincalc/CSR42_3.afg', 'lbnl/pywincalc/LOW-E_5.LOF', 'lbnl/wce/spectralSampleData.cpp', 'manifest.json']);
    // Products are cached per id.
    assert.equal(await P.loadProduct('igdb-2191'), products[5]);
    assert.equal(reads.length, 7);
    // 913: both faces compute to about 0.837, so both get 0.84 by the uncoated-face rule.
    assert.ok(Math.abs(products[3].efComputed - 0.837) < 0.0015 && Math.abs(products[3].ebComputed - 0.837) < 0.0015);
});
