// V3 (glazing beta build spec, section 5.3): measured IGDB records in the configurations of the published
// datasheet rows that name them (published.json `igdb`). The coated lite is the measured record, loaded with
// GlazingProducts.loadProduct from the unmodified shipped file and flipped by flipFor as the row requires; the
// uncoated partners are the open model's Rubin clear glass. Where the measured lite is thicker than the row's
// glass (Energy Advantage, 4.72 mm against 4 mm; the row's igdbNote), every pane takes the measured thickness, as
// in the design prototype. E891 weights, H = 1 m, air for the optics and the air U, 90 % argon for the argon U.
// Tolerances: spec 5.2, row "measured record in a datasheet configuration"; "report" quantities are printed only.
// Run: node --test "_tests/glazing/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, ROOT } from './helpers/load.mjs';
import { tuvWindow } from './helpers/tuv.mjs';

const ctx = load(load.FILES.open.concat(['assets/js/glazing-products.js']));
const E = ctx.GlazingEngine, O = ctx.GlazingOpen, P = ctx.GlazingProducts;
const S891 = { solar: ctx.GlazingSolarE891.solarE891 };
const BTU = 5.678263;
const PUB = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/data/glazing/published.json'), 'utf8'));
P.configure({ base: '/assets/data/glazing/', loadBytes: p => fs.promises.readFile(path.join(ROOT, 'assets/data/glazing', p)) });

// Quantities checked per record; R tolerance per record; everything else is reported.
const CHECK = {
    'igdb-2191': { VT: 1.0, Rout: 1.0, Rin: 1.0, SHGC: 0.015, Uair: 0.01, Uar: 0.01, UV: 2 },
    'igdb-5439': { VT: 1.0, Rout: 2.0, Rin: 2.0, SHGC: 0.015, Uair: 0.01, Uar: 0.01, UV: 2 },
    'igdb-9923': { Rout: 2.0, Rin: 2.0, Uair: 0.01, Uar: 0.01, U: 0.01 }
};
// Prototype values printed in the spec (5.3 V3), optical quantities only (thermal ones move with the live audit's
// engine fixes): [quantity, value, half of the last printed digit]. UV is WINDOW's TUV (E891 points 310-380 nm,
// trapezoid), as the datasheets compute it; the spec's 29.9 and 13.9 were the engine's 300-380 nm bin average.
// With the datasheets' method the measured LoE-180 record gives 29.0 and 13.2 against the published 29 and 13.
const PROTO = {
    'card-3-loe180-s3': [['VT', 78.8, 0.05], ['Rout', 14.5, 0.05], ['Rin', 15.3, 0.05], ['UV', 29.0, 0.05]],
    'card-3tri-loe180': [['VT', 69.4, 0.05], ['Rout', 20.2, 0.05], ['Rin', 20.2, 0.05], ['UV', 13.2, 0.05]],
    'vitro-6-sb70-s2': [['VT', 63.7, 0.05], ['Rout', 11.7, 0.05], ['Rin', 12.6, 0.05]],
    'pilk-4-ea-s3': [['VT', 74.1, 0.05], ['Tsol', 55.2, 0.05]]
};

function configure(row, prod) {
    const coated = row.panes.find(p => p.coat);
    const mmOf = p => (row.igdbNote && Math.abs(coated.mm - prod.thickness) > 0.1 ? prod.thickness : p.mm);
    return row.panes.map(p => p.coat
        ? P.layer(prod, p.side === 'front' ? 'outdoors' : 'indoors', E)
        : O.pane(p.glass, mmOf(p), 'none', 'front'));
}
function run(row, prod) {
    const L = configure(row, prod);
    const gaps = fill => row.gaps.map(w => ({ fill, width: w / 1000 }));
    const a = E.evaluate(L, gaps('air'), 1, S891), r = row.gaps.length ? E.evaluate(L, gaps('argon'), 1, S891) : null;
    const got = { VT: 100 * a.Tvis, Rout: 100 * a.Rvis, Rin: 100 * a.RvisIn, SHGC: a.SHGC, UV: 100 * tuvWindow(a.sys.T), Tsol: 100 * a.Tsol };
    if (row.gaps.length) { got.Uair = a.U / BTU; got.Uar = r.U / BTU; } else got.U = a.U / BTU;
    return got;
}

const ROWS = PUB.rows.filter(r => r.igdb);
test('V3 covers the eight published rows that name a measured record', () => {
    assert.deepEqual(ROWS.map(r => r.id).sort(), ['card-3-loe180-s2', 'card-3-loe180-s3', 'card-3tri-loe180', 'pilk-4-ea-mono',
        'pilk-4-ea-s2', 'pilk-4-ea-s2s4', 'pilk-4-ea-s3', 'vitro-6-sb70-s2']);
});

for (const row of ROWS) {
    test(`V3 ${row.id} with the measured record ${row.igdb}`, async () => {
        const prod = await P.loadProduct(row.igdb);
        const got = run(row, prod), tol = CHECK[row.igdb], lines = [], fails = [];
        for (const q of ['VT', 'Rout', 'Rin', 'SHGC', 'Uair', 'Uar', 'U', 'UV', 'Tsol']) {
            if (row[q] == null || got[q] == null) continue;
            const d = got[q] - row[q], dp = q === 'SHGC' || q[0] === 'U' && q !== 'UV' ? 3 : 1;
            const t = tol[q], line = `${q} ${got[q].toFixed(dp)} vs ${row[q]}` + (t == null ? ' (report)' : ` (±${t})`);
            lines.push(line);
            if (t != null && !(Math.abs(d) <= t + 1e-12)) fails.push(line);
        }
        console.log(`  ${row.id}: ` + lines.join('; '));
        assert.deepEqual(fails, [], row.id);
        for (const [q, v, h] of PROTO[row.id] || []) {
            assert.ok(Math.abs(got[q] - v) <= h + 1e-9, `${row.id} ${q} ${got[q].toFixed(3)} differs from the prototype's ${v}`);
        }
    });
}

test('V3 coated surfaces: flipFor puts the measured coating on the row\'s surface', async () => {
    const p2191 = await P.loadProduct('igdb-2191'), p9923 = await P.loadProduct('igdb-9923');
    assert.equal(p2191.coatedSide, 'back');
    assert.equal(p9923.coatedSide, 'front');
    // Coating faces indoors on a back-coated record: unflipped, so the low-e face stays on the layer's back.
    assert.ok(P.layer(p2191, 'indoors', E).eb < 0.1 && P.layer(p2191, 'indoors', E).ef > 0.8);
    assert.ok(P.layer(p2191, 'outdoors', E).ef < 0.1 && P.layer(p2191, 'outdoors', E).eb > 0.8);
    assert.ok(P.layer(p9923, 'outdoors', E).ef < 0.2 && P.layer(p9923, 'indoors', E).eb < 0.2);
});
