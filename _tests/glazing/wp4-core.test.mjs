// V11 (WP4): page logic of beta/glazing/beta-core.js, and page hygiene. Spec sections 4.4, 4.13, 5.3 (V11).
// Real IGDB data are read only from the shipped files under assets/data/glazing/lbnl/; nothing is copied here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, ROOT } from './helpers/load.mjs';
import { tuvWindow } from './helpers/tuv.mjs';

const ctx = load.all();
const E = ctx.GlazingEngine, B = ctx.GlazingBeta, P = ctx.GlazingProducts, O = ctx.GlazingOpen;
const S891 = ctx.GlazingSolarE891.solarE891;
const PUB = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/data/glazing/published.json'), 'utf8'));
const BTU = 5.678263;
const plain = x => JSON.parse(JSON.stringify(x));   // values from the vm context belong to another realm
P.configure({ loadBytes: p => fs.promises.readFile(path.join(ROOT, 'assets/data/glazing', p)) });
const manifest = await P.loadManifest();
const products = {};
for (const id of ['igdb-2191', 'igdb-5439', 'igdb-9923', 'igdb-1042']) products[id] = await P.loadProduct(id);
const deps = (extra = {}) => Object.assign({ E, open: true, P, solarE891: S891, getProduct: id => products[id], getImport: () => undefined }, extra);

// Calc-like values for a form state: lengths in m, selects as strings.
function values(o = {}) {
    const v = {
        view: 'both', sol: 'e891', np: '2', H: 1,
        p1g: 'clear', p1t: '6', p1c: 'double', p1s: 'back',
        p2g: 'clear', p2t: '6', p2c: 'none', p2s: 'front',
        p3g: 'clear', p3t: '6', p3c: 'none', p3s: 'front',
        g1f: 'argon', g1w: 0.0127, g1ps: 0.025, g1pd: 0.0005,
        g2f: 'argon', g2w: 0.0127, g2ps: 0.025, g2pd: 0.0005
    };
    return Object.assign(v, o);
}
// formValuesFor() output -> Calc values (what Calc.read() returns after calc.set()).
function fromForm(f) {
    const v = values();
    for (const [k, x] of Object.entries(f)) {
        if (/_u$/.test(k)) continue;
        if (/^g\dw$/.test(k)) v[k] = parseFloat(x) / (f[k + '_u'] === 'mm' ? 1000 : 1);
        else if (k === 'H') v.H = parseFloat(x) / (f.H_u === 'mm' ? 1000 : 1);
        else v[k] = x;
    }
    return v;
}

test('constants: thickness list, generic glasses, coating labels and the 5.2 tolerance table', () => {
    assert.deepEqual(Array.from(B.THICK), [2.5, 3, 4, 5, 6, 8, 10, 12, 15, 19]);
    assert.deepEqual(Object.keys(B.GENERIC), ['clear', 'lowiron', 'green', 'grey', 'bronze']);
    assert.deepEqual(Object.keys(B.GENERIC).filter(k => B.GENERIC[k].classic), ['clear', 'lowiron']);
    assert.deepEqual(Object.keys(B.COAT_LABELS), ['none', 'hard', 'single', 'double', 'triple']);
    const T = B.TOL;
    assert.deepEqual([T.glass.VT, T.glass.Rout, T.glass.SHGC, T.glass.U], [2.0, 1.0, 0.03, 0.01]);
    assert.deepEqual([T.calibrate.VT, T.calibrate.R, T.calibrate.Rtriple, T.calibrate.SHGC, T.calibrate.U, T.calibrate.UV, T.calibrate.Tsol], [1.0, 2.0, 2.5, 0.015, 0.01, 3, 2.5]);
    assert.deepEqual([T.check.VT, T.check.R, T.check.SHGC, T.check.U, T.check.UV, T.check.Tsol], [2.0, 2.5, 0.02, 0.015, 5, 3]);
    assert.deepEqual([T.measured.VT, T.measured.R, T.measured.Rwide, T.measured.SHGC, T.measured.U, T.measured.UV], [1.0, 1.0, 2.0, 0.015, 0.01, 2]);
    // generic columns of a hard-coat row: VT, SHGC, UV, Tsol report only
    const ea = PUB.rows.find(r => r.id === 'pilk-4-ea-s3');
    for (const k of ['VT', 'SHGC', 'UV', 'Tsol']) assert.equal(B.tolFor(ea, k).report, true, k);
    assert.equal(B.tolFor(ea, 'Rout').tol, 2.0);
    assert.equal(B.tolFor(PUB.rows.find(r => r.id === 'card-3-loe366-s2'), 'Rin').tol, 2.5);
    assert.equal(B.tolFor(PUB.rows.find(r => r.id === 'card-3-clear'), 'Rin').report, true);
    assert.equal(B.tolMeasuredFor(PUB.rows.find(r => r.id === 'vitro-6-sb70-s2'), 'Rout').tol, 2.0);
    assert.equal(B.tolMeasuredFor(PUB.rows.find(r => r.id === 'card-3-loe180-s3'), 'Rout').tol, 1.0);
});

test('readState: defaults, vacuum width, pillar error, product and import panes', () => {
    const { state, errors } = B.readState(values());
    assert.equal(errors.length, 0);
    assert.equal(state.np, 2); assert.equal(state.H, 1); assert.equal(state.view, 'both'); assert.equal(state.solar, 'E891');
    assert.equal(state.panes.length, 2);
    assert.deepEqual({ ...state.panes[0] }, { i: 1, src: 'generic', glass: 'clear', id: null, mm: 6, coat: 'double', faces: 'indoors' });
    assert.equal(state.panes[1].faces, 'outdoors');
    assert.deepEqual({ ...state.gaps[0] }, { fill: 'argon', width: 0.0127, pillarSpacing: 0.025, pillarRadius: 0.00025 });
    assert.equal(B.readState(values({ sol: 'g173' })).state.solar, 'G173');

    const vac = B.readState(values({ g1f: 'vacuum' })).state;
    assert.equal(vac.gaps[0].width, 0.0003);
    const bad = B.readState(values({ g1f: 'vacuum', g1pd: 0.025 }));
    assert.deepEqual(plain(bad.errors), [{ msg: 'Pillar diameter must be smaller than the spacing.', field: 'g1pd' }]);
    // a hidden gap is not checked (only np - 1 gaps exist)
    assert.equal(B.readState(values({ g2f: 'vacuum', g2pd: 1 })).errors.length, 0);

    const prod = B.readState(values({ np: '3', p2g: 'prod:igdb-2191', p3g: 'imp:abc' })).state;
    assert.equal(prod.panes[1].src, 'product'); assert.equal(prod.panes[1].id, 'igdb-2191');
    assert.equal(prod.panes[2].src, 'import'); assert.equal(prod.panes[2].id, 'abc');
    assert.equal(B.readState(values({ p1g: '' })).errors[0].field, 'p1g');
});

test('buildLayers: tint unavailable in the classic model; pending products; a loaded product is identical in both models', () => {
    const st = B.readState(values({ p2g: 'green' })).state;
    const c = B.buildLayers(st, 'classic', deps());
    assert.equal(c.unavailable, 'The classic model has no green tint glass; choose clear or low-iron to compare.');
    const o = B.buildLayers(st, 'open', deps());
    assert.equal(o.unavailable, null); assert.equal(o.layers.length, 2);

    const pend = B.buildLayers(B.readState(values({ p1g: 'prod:igdb-5439' })).state, 'open', deps({ getProduct: () => undefined }));
    assert.deepEqual(Array.from(pend.pending), ['igdb-5439']);

    const s2 = B.readState(values({ p1g: 'prod:igdb-2191', p1s: 'back' })).state;
    const a = B.buildLayers(s2, 'classic', deps()), b = B.buildLayers(s2, 'open', deps());
    for (const k of ['T', 'Rf', 'Rb']) assert.deepEqual(Array.from(a.layers[0][k]), Array.from(b.layers[0][k]));
    assert.equal(a.layers[0].ef, b.layers[0].ef); assert.equal(a.layers[0].eb, b.layers[0].eb);
    // coating faces indoors: LoE 180 (coated back) is not flipped, so the coating is on #2
    assert.deepEqual(Array.from(a.coat), [false, true, false, false]);
    const flipped = B.buildLayers(B.readState(values({ p1g: 'prod:igdb-2191', p1s: 'front' })).state, 'open', deps());
    assert.deepEqual(Array.from(flipped.coat), [true, false, false, false]);
    // generic surface flags
    assert.deepEqual(Array.from(B.buildLayers(B.readState(values()).state, 'open', deps()).coat), [false, true, false, false]);
});

test('evaluateModels: views, solar weighting, notes and pending ids', () => {
    const st = B.readState(values()).state;
    const r = B.evaluateModels(st, deps());
    assert.ok(r.classic && r.open);
    const L = st.panes.map(p => E.pane(p.glass, p.mm, p.coat, p.faces === 'outdoors' ? 'front' : 'back', 'open'));
    const ref = E.evaluate(L, st.gaps, 1, { solar: S891 });
    assert.ok(Object.is(r.open.r.SHGC, ref.SHGC) && Object.is(r.open.r.U, ref.U));
    assert.ok(r.notes.some(n => /ASTM E891/.test(n)));
    assert.equal(B.evaluateModels({ ...st, view: 'open' }, deps()).classic, null);
    assert.equal(B.evaluateModels({ ...st, view: 'classic' }, deps()).open, null);
    const noOpen = B.evaluateModels(st, deps({ open: false }));
    assert.equal(noOpen.open, null); assert.ok(noOpen.classic);
    assert.ok(noOpen.notes.some(n => /not available/.test(n)));
    const g = B.evaluateModels({ ...st, solar: 'G173' }, deps());
    assert.ok(g.notes.some(n => /G173/.test(n)));
    assert.ok(Object.is(g.classic.r.Tsol, E.evaluate(B.buildLayers(st, 'classic', deps()).layers, st.gaps, 1).Tsol));
    const tint = B.evaluateModels(B.readState(values({ p2g: 'bronze' })).state, deps());
    assert.equal(tint.classic, null); assert.ok(tint.open);
    assert.ok(tint.notes.some(n => /bronze tint/.test(n)));
    const pend = B.evaluateModels(B.readState(values({ p1g: 'prod:igdb-6046', p2g: 'prod:igdb-6046' })).state, deps({ getProduct: () => undefined }));
    assert.deepEqual(Array.from(pend.pending), ['igdb-6046']);
    assert.equal(pend.open, null); assert.equal(pend.classic, null);
    const meas = B.evaluateModels(B.readState(values({ p1g: 'prod:igdb-2191' })).state, deps());
    assert.ok(meas.notes.some(n => /Pane 1 uses measured data/.test(n)));
});

test('metrics, comparisonRows, tableHTML, kpiHTML, swatchesHTML: live formulas, no NaN, undefined or dashes', () => {
    const st = B.readState(values({ np: '3', p3c: 'single', p3s: 'front' })).state;
    const r = B.evaluateModels(st, deps());
    const mc = B.metrics(r.classic.r, 3), mo = B.metrics(r.open.r, 3);
    assert.equal(mc.Uip, r.classic.r.U / BTU);
    assert.equal(mc.LSG, r.classic.r.Tvis / r.classic.r.SHGC);
    assert.equal(mc.Tin, r.classic.r.winter.temps[5] - 273.15);
    assert.ok(Math.abs(mc.dew50 - 10.2) < 0.05, 'dew point of 21 °C at 50 % RH is about 10.2 °C');
    const rows = B.comparisonRows(mc, mo);
    assert.deepEqual(plain(rows.map(x => x.key)), ['U', 'Uip', 'SHGC', 'VT', 'Rvis', 'RvisIn', 'Tsol', 'Rsol', 'RsolIn', 'A1', 'A2', 'A3', 'Tuv', 'LSG', 'Rip', 'Tin']);
    const vt = rows.find(x => x.key === 'VT');
    assert.equal(vt.c, 100 * mc.VT); assert.equal(vt.o, 100 * mo.VT); assert.equal(vt.d, vt.o - vt.c); assert.equal(vt.kind, 'pct');
    const fmt = { num: (x, s) => Number(x).toPrecision(s || 4) };
    for (const view of ['both', 'open', 'classic']) {
        for (const h of [B.tableHTML(rows, view, fmt), B.kpiHTML(mc, mo, view, fmt), B.swatchesHTML(r.classic.r, r.open.r, view, fmt)]) {
            assert.ok(!/NaN|undefined|—/.test(h), view + ': ' + h.slice(0, 120));
        }
    }
    const t = B.tableHTML(rows, 'both', fmt);
    assert.ok(/^<table class="cmp"><caption>/.test(t));
    assert.ok(t.includes('<th scope="col">Classic</th><th scope="col">Open data</th><th scope="col">Δ</th>'));
    assert.equal((B.kpiHTML(mc, mo, 'both', fmt).match(/class="kpi"/g) || []).length, 4);
    assert.ok(B.kpiHTML(mc, mo, 'both', fmt).includes('<small>classic '));
    assert.ok(!B.kpiHTML(mc, mo, 'open', fmt).includes('<small>'));
    // with the classic column unavailable, cells say n/a rather than a blank
    const one = B.tableHTML(B.comparisonRows(null, mo), 'both', fmt);
    assert.ok(one.includes('n/a') && !/NaN|undefined/.test(one));
});

test('xsecSVG and glassOptionsHTML', () => {
    const st = B.readState(values({ g1f: 'vacuum' })).state;
    const r = B.evaluateModels(st, deps());
    const labels = Object.fromEntries(Object.keys(E.FILLS).map(k => [k, E.FILLS[k].label]));
    const svg = B.xsecSVG(2, r.open.layers, r.open.gaps, r.open.r.winter.temps, r.open.coat, labels);
    assert.ok(svg.startsWith('<svg viewBox="0 0 480 228">'));   // the live page's phone-legible geometry (audit, main)
    assert.equal((svg.match(/class="coat"/g) || []).length, 1);
    assert.ok(svg.includes('>vacuum<') && svg.includes('class="pillar"') && svg.includes('#4'));
    assert.ok(!/NaN|undefined/.test(svg));
    const svg2 = B.xsecSVG(2, r.open.layers, [{ fill: 'krypton', width: 0.0127 }], null, r.open.coat, labels);
    assert.ok(svg2.includes('12.7 mm krypton'));

    const evil = [{ id: 'x1', name: 'A<b>&"c"' }];
    const h = B.glassOptionsHTML('imp:x1', manifest, evil);
    assert.ok(h.includes('A&lt;b&gt;&amp;&quot;c&quot;') && !h.includes('A<b>'));
    assert.ok(h.includes('value="imp:x1" selected'));
    assert.ok(h.includes('<optgroup label="Generic glass">') && h.includes('<optgroup label="Measured products (IGDB)">') && h.includes('<optgroup label="Your imported products">'));
    assert.ok(h.includes('>Generic Clear Glass, 3.05 mm (IGDB 102)<'));
    assert.ok(h.includes('>LoE 180 on 3mm Clear (Cardinal Glass Industries, IGDB 2191)<'));
    assert.equal((h.match(/value="prod:/g) || []).length, 9);
    const none = B.glassOptionsHTML('clear', null, []);
    assert.ok(none.includes('Measured products could not load') && !none.includes('imported'));
    assert.ok(none.includes('value="clear" selected'));
});

test('formValuesFor followed by readState reproduces the panes and gaps of all 19 rows', () => {
    assert.equal(PUB.rows.length, 19);
    for (const row of PUB.rows) {
        const f = B.formValuesFor(row);
        assert.equal(f.np, String(row.panes.length));
        const { state, errors } = B.readState(fromForm(f));
        assert.equal(errors.length, 0, row.id);
        assert.equal(state.panes.length, row.panes.length);
        row.panes.forEach((p, k) => {
            const s = state.panes[k];
            assert.ok(B.THICK.includes(p.mm), row.id + ' thickness is in THICK');
            assert.equal(s.src, 'generic'); assert.equal(s.glass, p.glass); assert.equal(s.mm, p.mm); assert.equal(s.coat, p.coat || 'none');
            if (p.coat) assert.equal(s.faces, p.side === 'front' ? 'outdoors' : 'indoors', row.id);
        });
        assert.deepEqual(plain(state.gaps.map(g => [g.fill, Math.round(g.width * 1e7) / 1e4])), row.gaps.map(w => ['argon', w]), row.id);
        assert.equal(state.H, 1);
    }
});

// Appendix A.2 (published / open / classic): VT, SHGC, Rout, U air (mono: U), exterior a*, b* open / classic.
// Fix round 1: recalibrating with the datasheets' UV method (WINDOW's TUV) moved the single-silver stack, so the
// open exterior b* of the three LoE-180 rows (-2.4, -3.3, -3.8 in A.2) and the open Rout of card-3tri-366-180 (16.5)
// are pinned to the recalibrated values.
const A2 = {
    'card-3-clear': [81.4, 82.2, 0.770, 0.784, 14.8, 14.8, 0.481, 0.481, [-1.1, -0.8], [-0.4, -0.7]],
    'card-6-clear': [78.2, 79.6, 0.706, 0.729, 14.2, 14.3, 0.473, 0.473, [-2.0, -1.0], [-0.8, -0.8]],
    'vitro-6-clear': [78.2, 79.6, 0.706, 0.729, 14.2, 14.3, 0.473, 0.473, [-2.0, -1.0], [-0.8, -0.8]],
    'card-3-loe180-s3': [78.6, 74.9, 0.681, 0.627, 14.6, 16.9, 0.308, 0.297, [1.6, -2.6], [1.6, 0.0]],
    'card-3-loe180-s2': [78.6, 74.9, 0.648, 0.582, 14.6, 16.5, 0.308, 0.297, [1.2, -3.5], [1.5, 0.3]],
    'card-3tri-loe180': [69.2, 62.6, 0.561, 0.483, 19.6, 22.6, 0.195, 0.187, [1.4, -4.1], [1.6, 0.8]],
    'card-6-loe180-s2': [75.6, 72.5, 0.600, 0.550, 14.1, 16.0, 0.304, 0.294, [0.2, -3.5], [1.1, 0.2]],
    'card-3-loe272-s2': [72.4, 76.1, 0.412, 0.376, 10.6, 12.4, 0.298, 0.292, [-2.3, -5.0], [3.3, -8.0]],
    'card-6-loe272-s2': [69.6, 73.8, 0.398, 0.372, 10.2, 12.1, 0.294, 0.289, [-3.0, -5.0], [2.9, -8.0]],
    'vitro-6-sb60-s2': [69.6, 73.8, 0.398, 0.372, 10.2, 12.1, 0.294, 0.289, [-3.0, -5.0], [2.9, -8.0]],
    'vitro-6-sb70-s2': [65.0, 71.6, 0.277, 0.315, 13.1, 12.8, 0.288, 0.285, [-2.0, -5.1], [5.2, -9.0]],
    'card-3-loe366-s2': [65.6, 71.9, 0.278, 0.318, 13.0, 12.6, 0.291, 0.288, [-2.3, -5.1], [5.0, -9.0]],
    'card-6-loe366-s2': [63.1, 69.7, 0.278, 0.318, 12.6, 12.3, 0.288, 0.285, [-3.1, -5.0], [4.5, -9.0]],
    'card-3tri-272-180': [63.6, 63.4, 0.369, 0.330, 14.8, 18.6, 0.192, 0.186, [-1.1, -5.7], [2.8, -4.4]],
    'card-3tri-366-180': [57.6, 60.0, 0.251, 0.281, 16.3, 18.2, 0.189, 0.184, [-2.4, -5.2], [3.9, -5.4]],
    'pilk-4-ea-s3': [73.3, 76.2, 0.707, 0.722, 16.7, 16.2, 0.336, 0.332, [1.5, 1.6], [0.4, -2.6]],
    'pilk-4-ea-s2': [73.3, 76.2, 0.639, 0.697, 15.6, 16.0, 0.336, 0.332, [1.1, 1.5], [0.3, -2.4]],
    'pilk-4-ea-mono': [81.3, 84.1, 0.719, 0.772, 10.2, 10.2, 0.655, 0.647, [3.3, 2.8], [1.3, -3.7]],
    'pilk-4-ea-s2s4': [66.9, 71.5, 0.592, 0.649, 17.0, 17.5, 0.264, 0.259, [2.5, 2.9], [0.9, -3.6]]
};

test('datasheetCompare: all 19 rows equal an independent construction (1e-12) and match Appendix A.2', () => {
    const near = (a, b, tol, msg) => assert.ok(a != null && Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
    for (const row of PUB.rows) {
        const c = B.datasheetCompare(row, deps());
        const keys = ['VT', 'Rout', 'Rin', 'SHGC', 'Uair', 'Uar', 'U', 'UV', 'Tsol'].filter(k => row[k] != null);
        assert.deepEqual(plain(c.metrics.map(m => m.key)), keys, row.id);
        const gaps = fill => row.gaps.map(w => ({ fill, width: w / 1000 }));
        const builds = {
            open: row.panes.map(p => E.pane(p.glass, p.mm, p.coat || 'none', p.side || 'front', 'open')),
            classic: row.panes.map(p => E.pane(p.glass, p.mm, p.coat || 'none', p.side || 'front'))
        };
        if (row.igdb) {
            assert.equal(c.pending.length, 0);
            const pr = products[row.igdb];
            builds.measured = row.panes.map(p => p.coat ? E.imported(pr, P.flipFor(pr, p.side === 'front' ? 'outdoors' : 'indoors')) : O.pane(p.glass, p.mm, 'none', 'front'));
        }
        for (const [col, L] of Object.entries(builds)) {
            const a = E.evaluate(L, gaps('air'), 1, { solar: S891 }), r = E.evaluate(L, gaps('argon'), 1, { solar: S891 });
            const exp = { VT: 100 * a.Tvis, Rout: 100 * a.Rvis, Rin: 100 * a.RvisIn, SHGC: a.SHGC, Uair: a.U / BTU, U: a.U / BTU, Uar: r.U / BTU, UV: 100 * tuvWindow(a.sys.T), Tsol: 100 * a.Tsol };
            for (const m of c.metrics) near(m[col], exp[m.key], 1e-12, `${row.id} ${col} ${m.key}`);
            near(c.colors[col].a, a.colorR.a, 1e-12, row.id + ' color');
        }
        if (!row.igdb) { assert.equal(c.colors.measured, null); assert.ok(c.metrics.every(m => m.measured == null)); }
        for (const m of c.metrics) { const t = B.tolFor(row, m.key); assert.equal(m.tol, t.tol); assert.equal(m.report, t.report); }

        // Appendix A.2. The classic optics are unchanged, so VT, SHGC, Rout and color match to the printed precision.
        // U depends on the thermal model: A.2 was computed with the pre-audit engine, and the audited engine on main
        // (ISO 15099 gas mixtures, indoor film temperature and turbulent correlation, pillar spreading resistance)
        // moves U by up to 0.0034 (the monolithic row; 0.0016 on IGUs), so U is held to 0.004 in both columns.
        // The open optics may differ by one unit in the last printed digit, because each recalibration moves the
        // stacks slightly (WP2 with the pre-audit engine, INT with the audited one; spec 7.3, A.5).
        const x = A2[row.id], g = k => c.metrics.find(m => m.key === k);
        const u = g('Uair') || g('U');
        near(g('VT').classic, x[1], 0.05 + 1e-9, row.id + ' classic VT');
        near(g('SHGC').classic, x[3], 0.0005 + 1e-9, row.id + ' classic SHGC');
        near(g('Rout').classic, x[5], 0.05 + 1e-9, row.id + ' classic Rout');
        near(u.classic, x[7], 0.004, row.id + ' classic U');
        near(c.colors.classic.a, x[9][0], 0.05 + 1e-9, row.id + ' classic a*'); near(c.colors.classic.b, x[9][1], 0.05 + 1e-9, row.id + ' classic b*');
        near(g('VT').open, x[0], 0.15, row.id + ' open VT');
        near(g('SHGC').open, x[2], 0.0015, row.id + ' open SHGC');
        near(g('Rout').open, x[4], 0.15, row.id + ' open Rout');
        near(u.open, x[6], 0.004, row.id + ' open U');
        near(c.colors.open.a, x[8][0], 0.15, row.id + ' open a*'); near(c.colors.open.b, x[8][1], 0.15, row.id + ' open b*');
    }
    // a row with a measured record whose product is not loaded yet reports it as pending
    const sb70 = PUB.rows.find(r => r.id === 'vitro-6-sb70-s2');
    const pend = B.datasheetCompare(sb70, deps({ getProduct: () => undefined }));
    assert.deepEqual(Array.from(pend.pending), ['igdb-5439']);
    assert.ok(pend.metrics.every(m => m.measured == null && m.open != null));
});

test('datasheetOptionsHTML: optgroups, labels and the default row', () => {
    const h = B.datasheetOptionsHTML(PUB);
    assert.deepEqual(plain([...h.matchAll(/<optgroup label="([^"]+)"/g)].map(m => m[1])), ['Clear glass', 'Hard coat', 'Single silver', 'Double silver', 'Triple silver', 'Mixed triple']);
    assert.equal((h.match(/<option /g) || []).length, 19);
    assert.ok(h.includes('value="vitro-6-sb60-s2" selected'));
    const label = id => B.rowLabel(PUB.rows.find(r => r.id === id));
    assert.equal(label('vitro-6-sb70-s2'), 'Vitro Solarban 70 on #2, 6/13/6 mm (held out)');
    assert.equal(label('card-3tri-loe180'), 'Cardinal LoE-180 / clear / LoE-180, 3/9.8/3/9.8/3 mm (held out)');
    assert.equal(label('pilk-4-ea-mono'), 'Pilkington Energy Advantage, 4 mm monolithic (calibration)');
    assert.equal(label('card-3-loe180-s3'), 'Cardinal LoE-180 on #3, 3/13/3 mm (calibration)');
    assert.ok(/\(glass check\)$/.test(label('card-3-clear')));
});

test('status thresholds', () => {
    assert.equal(B.status(0.5, 1), 'ok');
    assert.equal(B.status(-1, 1), 'ok');
    assert.equal(B.status(1.5, 1), 'warn');
    assert.equal(B.status(-2, 1), 'warn');
    assert.equal(B.status(2.01, 1), 'bad');
    assert.equal(B.status(0.1, null), 'info');
    assert.equal(B.status(NaN, 1), 'info');
});

test('attributionHTML: one paragraph per product, 6.2 (a) wording, imports included', () => {
    const h = B.attributionHTML([products['igdb-5439'], products['igdb-5439'], products['igdb-2191']], manifest, P);
    assert.equal((h.match(/<p>/g) || []).length, 2);
    assert.ok(h.includes('Licensed under <a href="https://creativecommons.org/licenses/by-nd/4.0/"'));
    assert.ok(h.includes('do not imply endorsement'));
    const imp = { id: 'u1', name: 'My glass', fileName: 'mine.txt', source: null };
    assert.ok(B.attributionHTML([imp], manifest, P).includes('imported by you from mine.txt'));
    assert.equal(B.attributionHTML([], manifest, P), '');
});

/* ── Hygiene (text checks on files) ─────────────────────────────────── */
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PAGE = read('beta/glazing/index.html');

test('hygiene: beta page head, notice, no indexing tags, local links exist', () => {
    assert.ok(PAGE.includes('<meta name="robots" content="noindex, nofollow">'));
    assert.ok(PAGE.includes('<strong>Beta: not yet validated by the author.</strong>'));
    for (const bad of ['rel="canonical"', 'og:', 'twitter:', 'application/ld+json', 'data-section']) assert.ok(!PAGE.includes(bad), bad);
    assert.ok(PAGE.includes('<title>Glazing Performance Calculator (Open-Data Beta) | Casey D. Foley, PhD</title>'));
    const locals = [...PAGE.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m => m[1]).filter(u => !/^(https?:)?\/\//.test(u) && !u.startsWith('mailto:'));
    assert.ok(locals.length > 15);
    for (const u of locals) {
        const p = u.startsWith('/') ? u.slice(1) : path.posix.join('beta/glazing', u);
        const cand = [p, path.posix.join(p, 'index.html')];
        assert.ok(cand.some(c => fs.existsSync(path.join(ROOT, c)) && fs.statSync(path.join(ROOT, c)).isFile()), 'missing ' + u);
    }
    // script order of spec section 1
    const scripts = [...PAGE.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]).filter(s => !s.startsWith('http'));
    assert.deepEqual(scripts, ['/assets/js/site.js', '/assets/js/calc.js', '/assets/js/plot.js', '/assets/js/glazing-weights.js', '/assets/js/glazing-engine.js',
        '/assets/js/glazing-materials.js', '/assets/js/glazing-solar-e891.js', '/assets/js/glazing-tmm.js', '/assets/js/glazing-coatings.js', '/assets/js/glazing-open.js',
        '/assets/js/glazing-products.js', './beta-core.js', './selftest.js', './glazing-beta.js']);
    // external links open in a new tab with rel="noopener"
    for (const m of PAGE.matchAll(/<a [^>]*href="https?:[^"]+"[^>]*>/g)) assert.ok(/rel="noopener"/.test(m[0]), m[0]);
    // no export of spectra (G3): no download links or blob URLs in the page or its scripts
    for (const f of ['beta/glazing/index.html', 'beta/glazing/glazing-beta.js', 'beta/glazing/beta-core.js']) {
        const t = read(f);
        assert.ok(!/\bdownload=|createObjectURL|text\/csv/.test(t), f);
    }
    // the importer's file input has no accept attribute; imports use their own storage key
    assert.ok(/<input type="file" id="imp-file" multiple hidden[^>]*>/.test(PAGE));
    assert.ok(!/<input[^>]*id="imp-file"[^>]*\baccept=/.test(PAGE), 'no accept attribute');
    // the file picker opens from a real button, so it is reachable by keyboard (a <label> around a hidden input is not)
    assert.ok(/<button type="button"[^>]*id="imp-pick"[^>]*>Load file<\/button>/.test(PAGE));
    assert.ok(read('beta/glazing/glazing-beta.js').includes("$('imp-file').click()"));
    assert.ok(read('beta/glazing/glazing-beta.js').includes("'glz-beta-imports'"));
});

test('hygiene: no live page, registry or sitemap links to /beta/', () => {
    const files = ['sitemap.xml', 'assets/js/site.js', 'index.html', '404.html'];
    for (const dir of ['tools', 'learn', 'formulas', 'games']) {
        const walk = d => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).forEach(e => {
            const p = d + '/' + e.name;
            if (e.isDirectory()) walk(p); else if (/\.(html|js|json|xml)$/.test(e.name)) files.push(p);
        });
        if (fs.existsSync(path.join(ROOT, dir))) walk(dir);
    }
    assert.ok(files.length > 20);
    for (const f of files) {
        if (!fs.existsSync(path.join(ROOT, f))) continue;
        assert.ok(!/["'(]\/beta\/|cdfoley\.com\/beta\//.test(read(f)), f + ' links to /beta/');
    }
});

test('hygiene: beta/index.html is noindex and carries the 4.13 glazing card', () => {
    const idx = read('beta/index.html');
    assert.ok(idx.includes('<meta name="robots" content="noindex, nofollow">'));
    assert.ok(idx.includes('href="/beta/glazing/"'));
    // The card text of 4.13 is the coordinator's edit (this tool's builders do not edit beta/index.html). It is a hard
    // check: the old text called the coatings "measured" data, which they are not, and must not ship.
    const want = 'The glazing calculator with measured glass optical constants, thin-film low-e coatings calibrated to published datasheets, and nine measured IGDB products, side by side with the current model.';
    assert.ok(!idx.includes('openly licensed measured glass and coating data'), 'beta/index.html still has the old glazing card text (spec 4.13)');
    assert.ok(idx.includes('<h3>Glazing Performance (Open Data)</h3>'), 'beta/index.html: the glazing card title of spec 4.13 is missing');
    assert.ok(idx.includes(want), 'beta/index.html: the glazing card text of spec 4.13 is missing');
});

// ── Fix round 1 ─────────────────────────────────────────────────────────────────────────────────────────────
test('readState: stale or hand-edited links (blank or unknown thickness, coating, fill) and implausible sizes are errors', () => {
    const err = o => plain(B.readState(values(o), Object.keys(E.FILLS)).errors);
    assert.deepEqual(err({}), []);
    assert.deepEqual(err({ p1t: '' }), [{ msg: 'Choose a thickness for pane 1.', field: 'p1t' }]);
    assert.deepEqual(err({ p1t: '7' }), [{ msg: 'Choose a thickness for pane 1.', field: 'p1t' }]);
    assert.deepEqual(err({ p2c: '' }), [{ msg: 'Choose a coating for pane 2.', field: 'p2c' }]);
    assert.deepEqual(err({ g1f: '' }), [{ msg: 'Choose a fill for gap 1.', field: 'g1f' }]);
    assert.deepEqual(plain(B.readState(values({ g1f: '' })).errors), [], 'without the fill list the fill is not checked');
    assert.equal(err({ H: 1e-9 })[0].field, 'H');
    assert.equal(err({ H: 1000 })[0].field, 'H');
    assert.deepEqual(err({ H: 0.1 }), []); assert.deepEqual(err({ H: 10 }), []);
    assert.deepEqual(err({ g1w: 1e-6 }), [{ msg: 'Gap 1 width must be between 1 and 100 mm.', field: 'g1w' }]);
    assert.deepEqual(err({ g1w: 100 }), [{ msg: 'Gap 1 width must be between 1 and 100 mm.', field: 'g1w' }]);
    assert.deepEqual(err({ g1w: 0.001 }), []); assert.deepEqual(err({ g1w: 0.1 }), []);
    // a vacuum gap does not use the width field (hidden, read as text by the page)
    assert.deepEqual(err({ g1f: 'vacuum', g1w: 'abc' }), []);
    // products and imports have no thickness or coating fields
    assert.deepEqual(err({ p1g: 'prod:igdb-2191', p1t: '', p1c: '' }), []);
    // fix round 2: a coated pane whose 'Coating faces' value is blank or unknown is an error, not silently 'indoors'
    assert.deepEqual(err({ p1s: 'foo', p1c: 'single' }), [{ msg: 'Choose which way the coating faces for pane 1.', field: 'p1s' }]);
    assert.deepEqual(err({ p1s: '' }), [{ msg: 'Choose which way the coating faces for pane 1.', field: 'p1s' }]);
    assert.deepEqual(err({ p2s: '' }), [], 'an uncoated pane does not use the field');
    assert.equal(B.readState(values({ p1s: 'front' })).state.panes[0].faces, 'outdoors');
    assert.equal(B.readState(values({ p1s: 'back' })).state.panes[0].faces, 'indoors');
});

test('glassOptionsHTML keeps a missing import selectable; formValuesFor resets the panes and gaps a row does not use', () => {
    const h = B.glassOptionsHTML('imp:gone', manifest, [{ id: 'x1', name: 'Mine' }]);
    assert.ok(h.includes('<option value="imp:gone" selected>Imported product (not in this browser)</option>'));
    assert.ok(h.includes('value="imp:x1"'));
    assert.ok(!B.glassOptionsHTML('imp:x1', manifest, [{ id: 'x1', name: 'Mine' }]).includes('not in this browser'));
    // fix round 2: the value a link names is kept as an option without becoming the form's default (Calc reads its
    // defaults from the 'selected' attributes, and Reset returns to them)
    const k = B.glassOptionsHTML('clear', manifest, [], undefined, 'imp:zzz');
    assert.ok(k.includes('<option value="imp:zzz">Imported product (not in this browser)</option>'), k);
    assert.ok(k.includes('<option value="clear" selected>'));
    assert.equal((k.match(/ selected/g) || []).length, 1);
    const kp = B.glassOptionsHTML('clear', manifest, [], undefined, 'prod:igdb-2191');
    assert.ok(kp.includes('<option value="prod:igdb-2191">') && kp.includes('<option value="clear" selected>'));
    assert.equal((kp.match(/ selected/g) || []).length, 1);
    assert.equal((B.glassOptionsHTML('imp:zzz', manifest, [], undefined, 'imp:zzz').match(/imp:zzz/g) || []).length, 1, 'no duplicate option');
    const mono = B.formValuesFor(PUB.rows.find(r => r.id === 'pilk-4-ea-mono'));
    assert.equal(mono.np, '1');
    for (const i of [1, 2]) {
        assert.equal(mono['g' + i + 'w'], '12.7'); assert.equal(mono['g' + i + 'ps'], '25'); assert.equal(mono['g' + i + 'pd'], '0.5');
        assert.equal(mono['g' + i + 'f'], 'argon');
    }
    assert.equal(mono.p3c, 'none'); assert.equal(mono.p3t, '6');
    assert.equal(B.readState(fromForm(mono), Object.keys(E.FILLS)).errors.length, 0);
});

test('tuvNFRC is WINDOW\'s TUV (E891 points 310-380 nm, trapezoid) and differs from the engine\'s 300-380 nm bin average', () => {
    const table = ctx.GlazingSolarE891.tuvTable;
    assert.deepEqual(plain(table.map(p => p[0])), [310, 315, 320, 325, 330, 335, 340, 345, 350, 360, 370, 380]);
    const flat = new Float64Array(441).fill(0.42);
    assert.ok(Math.abs(B.tuvNFRC(flat, table) - 0.42) < 1e-15);
    for (const row of PUB.rows.filter(r => r.UV != null)) {
        const L = row.panes.map(p => E.pane(p.glass, p.mm, p.coat || 'none', p.side || 'front', 'open'));
        const a = E.evaluate(L, row.gaps.map(w => ({ fill: 'air', width: w / 1000 })), 1, { solar: S891 });
        const t = B.tuvNFRC(a.sys.T, table);
        assert.ok(Math.abs(t - tuvWindow(a.sys.T)) < 1e-14, row.id);
        assert.ok(a.Tuv > t, row.id + ': the bin average reads higher');
    }
});

test('importNotes: an import that starts above 305 nm has no UV transmittance; one that stops short of 2500 nm gets a note', async () => {
    const flat = (lo, hi) => {
        const wl = []; for (let x = lo; x <= hi; x += 10) wl.push(x);
        return { id: 'f', name: 'Flat', thickness: 4, ef: 0.84, eb: 0.84, wl, T: wl.map(() => 0.8), Rf: wl.map(() => 0.08), Rb: wl.map(() => 0.08) };
    };
    const run = imp => B.evaluateModels(B.readState(values({ np: '1', p1g: 'imp:f' })).state, deps({ getImport: () => imp }));
    const a = run(flat(400, 2000));
    assert.equal(a.uvUnavailable, true);
    assert.ok(a.notes.some(n => /Pane 1: the imported data cover 400–2000 nm.*UV transmittance is not available/.test(n)));
    const b = run(flat(300, 2000));
    assert.equal(b.uvUnavailable, false);
    assert.ok(b.notes.some(n => /cover 300–2000 nm/.test(n) && !/UV/.test(n)));
    const c = run(flat(300, 2500));
    assert.equal(c.uvUnavailable, false);
    assert.ok(!c.notes.some(n => /data cover/.test(n)));
    // the shipped products cover 300 (or 305) to 2500 (or 2494) nm: no note, for every one of the nine (fix round 2)
    for (const mp of manifest.products) {
        const prod = await P.loadProduct(mp.id);
        const p = B.evaluateModels(B.readState(values({ np: '1', p1g: 'prod:' + mp.id })).state, deps({ getProduct: () => prod }));
        assert.ok(!p.uvUnavailable && !p.notes.some(n => /data cover/.test(n)), mp.id + ': ' + p.notes.join(' | '));
    }
    // the page shows n/a for the UV row
    const mc = B.metrics(a.classic.r, 1), mo = B.metrics(a.open.r, 1);
    mc.Tuv = null; mo.Tuv = null;
    const fmt = { num: (x, s) => Number(x).toPrecision(s || 4) };
    assert.ok(/UV transmittance \(300–380 nm\)<\/th><td>n\/a<\/td><td>n\/a<\/td><td>n\/a<\/td>/.test(B.tableHTML(B.comparisonRows(mc, mo), 'both', fmt)));
});

test('tableHTML keeps trailing zeros (three significant figures) and uses a true minus sign', () => {
    const rows = [{ key: 'SHGC', label: 'SHGC', c: 0.4, o: 0.39996, d: -0.00004, kind: 'num' }, { key: 'Tsol', label: 'Solar', c: 34, o: 34.04, d: 0.04, kind: 'pct' },
        { key: 'Tin', label: 'T', c: -2.5, o: -2.54, d: -0.04, kind: 'num' }];
    const h = B.tableHTML(rows, 'both', { num: (x, s) => Number(x).toPrecision(s) });
    assert.ok(h.includes('<td>0.400</td><td>0.400</td>'));
    assert.ok(h.includes('<td>34.0 %</td><td>34.0 %</td>'));
    assert.ok(h.includes('<td>−2.50</td><td>−2.54</td>'));
});
