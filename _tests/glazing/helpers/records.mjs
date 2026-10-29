// Test-only readers for the LBNL files shipped under assets/data/glazing/lbnl/: the IGDB text files of
// pyWinCalc (examples/products) and the C++ records of Windows-CalcEngine spectralSampleData.cpp. They are
// deliberately independent of assets/js/glazing-products.js (WP3), so the V2 and V6 tests do not depend on the
// parsers that V8 tests. Real IGDB data are read only from the shipped files; nothing here writes a copy.
//
//   readIGDB(path)                 -> { thickness (mm), ef, eb, rows: [[µm, T, Rf, Rb], ...] }
//   readWCE(path)                  -> { NAME: [[µm, Tf, Tb, Rf, Rb], ...], ... }
//   asProduct(rows, mm, ef, eb)    -> { wl (nm), T, Rf, Rb, ef, eb, thickness: mm, k: 1 }, rows <= 2.5 µm only,
//                                     for GlazingEngine.imported(). Takes either row shape above.
// Paths are repo-relative (or absolute), for example readIGDB(LBNL + 'pywincalc/CLEAR_3.DAT').
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './load.mjs';

export const LBNL = 'assets/data/glazing/lbnl/';

const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
const IS_NUM = new RegExp('^' + NUM + '$');

// IGDB text file: "{ key } value" header lines, then rows "wavelength(µm) T Rfront Rback". Latin-1 decoding
// (the product names are windows-1252, but only numbers are read here).
export function readIGDB(file) {
    const text = fs.readFileSync(path.resolve(ROOT, file), 'latin1');
    const th = text.match(new RegExp('\\{\\s*Thickness\\s*\\}\\s*(' + NUM + ')'));
    const em = text.match(new RegExp('Emis=\\s*(' + NUM + ')[\\s,]+(' + NUM + ')'));
    if (!th || !em) throw new Error('readIGDB: no "{ Thickness }" or "Emis=" header in ' + file);
    if (!/\{\s*Units,\s*Wavelength Units\s*\}\s*SI\s+Microns/i.test(text)) throw new Error('readIGDB: expected wavelengths in microns in ' + file);
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
        if (/[{}]/.test(line)) continue;
        const tok = line.trim().split(/\s+/);
        if (tok.length === 4 && tok.every(t => IS_NUM.test(t))) rows.push(tok.map(Number));
    }
    if (rows.length < 20) throw new Error('readIGDB: only ' + rows.length + ' data rows in ' + file);
    return { thickness: Number(th[1]), ef: Number(em[1]), eb: Number(em[2]), rows };
}

// Windows-CalcEngine spectralSampleData.cpp: functions "CSpectralSampleData> NAME()" whose bodies list
// {wl, {Tf, Tb, Rf, Rb}, {...}} rows, wavelengths in µm. Each body runs to the next function header.
export function readWCE(file) {
    const text = fs.readFileSync(path.resolve(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
    const head = /CSpectralSampleData>\s+(\w+)\s*\(\s*\)/g, starts = [];
    let m;
    while ((m = head.exec(text))) starts.push({ name: m[1], from: head.lastIndex, at: m.index });
    if (!starts.length) throw new Error('readWCE: no CSpectralSampleData records in ' + file);
    const out = {};
    starts.forEach((s, i) => {
        const body = text.slice(s.from, i + 1 < starts.length ? starts[i + 1].at : text.length);
        const row = new RegExp('\\{\\s*(' + NUM + ')\\s*,\\s*\\{\\s*(' + NUM + ')\\s*,\\s*(' + NUM + ')\\s*,\\s*(' + NUM + ')\\s*,\\s*(' + NUM + ')\\s*\\}', 'g');
        const rows = [];
        let r;
        while ((r = row.exec(body))) rows.push([Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), Number(r[5])]);
        if (out[s.name]) throw new Error('readWCE: duplicate record ' + s.name);
        out[s.name] = rows;
    });
    return out;
}

// Engine product (GlazingEngine.imported) from either row shape: IGDB [µm, T, Rf, Rb] or WCE [µm, Tf, Tb, Rf, Rb].
export function asProduct(rows, mm, ef, eb) {
    const r = rows.filter(x => x[0] <= 2.5 + 1e-9);
    if (!r.length) throw new Error('asProduct: no rows at or below 2.5 µm');
    const wce = r[0].length >= 5;
    return {
        wl: r.map(x => x[0] * 1000),
        T: r.map(x => x[1]),
        Rf: r.map(x => (wce ? x[3] : x[2])),
        Rb: r.map(x => (wce ? x[4] : x[3])),
        ef, eb, thickness: mm, k: 1
    };
}
