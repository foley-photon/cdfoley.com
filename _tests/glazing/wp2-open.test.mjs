// WP2: the open material model, assets/js/glazing-open.js (glazing beta build spec 2.4, 7.3), plus V2a through
// GlazingOpen.pane and V2b (spec 5.3). Measured records are read from the unmodified LBNL files shipped under
// assets/data/glazing/lbnl/ with the test-only reader of helpers/records.mjs and resampled in memory only.
// Low-iron reference: EnergyPlus WindowGlassMaterials.idf, "LOW IRON 5MM" (Tv 0.910, Ts 0.889; facts quoted
// with citation, the file is not shipped). Run: node --test "_tests/glazing/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, ROOT } from './helpers/load.mjs';
import { readIGDB, asProduct, LBNL } from './helpers/records.mjs';

const ctx = load.open();
const E = ctx.GlazingEngine, O = ctx.GlazingOpen, M = ctx.GlazingMaterials, C = ctx.GlazingCoatings, TMM = ctx.GlazingTMM;
const E891 = { solar: ctx.GlazingSolarE891.solarE891 };
const PUB = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/data/glazing/published.json'), 'utf8'));
const BTU = 5.678263, pct = x => 100 * x;

test('API: label, GLASS, COATINGS, functions, and registration as model "open"', () => {
    assert.equal(O.label, 'Open data (Rubin glass, thin-film coatings)');
    assert.deepEqual(Object.keys(O.GLASS), ['clear', 'lowiron', 'green', 'grey', 'bronze']);
    const labels = { clear: 'Clear float (Rubin 1985)', lowiron: 'Low-iron (Rubin 1985)', green: 'Green tint (Rubin 1985)',
        grey: 'Gray tint (Rubin 1985)', bronze: 'Bronze tint (Rubin 1985)' };
    for (const k of Object.keys(labels)) {
        assert.equal(O.GLASS[k].label, labels[k]);
        assert.ok(M.materials[O.GLASS[k].mat], k + ' material');
    }
    assert.equal(O.COATINGS, C.coatings);
    for (const f of ['pane', 'stackPane', 'film', 'glass', 'material', 'epsFromSilver']) assert.equal(typeof O[f], 'function', f);
    assert.equal(E.MODELS.open, O);
    assert.equal(ctx.window.GlazingOpen, O);
});

test('pane: layer shape, t = mm/1000, k = 1, spectra in [0, 1], identical through GlazingEngine.pane(..., "open")', () => {
    for (const g of Object.keys(O.GLASS)) for (const c of ['none', 'hard', 'single', 'double', 'triple']) for (const side of ['front', 'back']) {
        const L = O.pane(g, 4.7, c, side), V = E.pane(g, 4.7, c, side, 'open');
        assert.deepEqual(Object.keys(L).sort(), ['Rb', 'Rf', 'T', 'eb', 'ef', 'k', 't']);
        assert.equal(L.t, 4.7 / 1000); assert.equal(L.k, 1);
        for (const q of ['T', 'Rf', 'Rb']) {
            assert.equal(L[q].length, 441); assert.equal(Object.prototype.toString.call(L[q]), '[object Float64Array]');
            for (let i = 0; i < 441; i++) {
                assert.ok(L[q][i] >= 0 && L[q][i] <= 1, `${g} ${c} ${side} ${q}[${i}]`);
                assert.ok(Object.is(L[q][i], V[q][i]));
            }
        }
        for (let i = 0; i < 441; i++) assert.ok(L.T[i] + Math.max(L.Rf[i], L.Rb[i]) <= 1 + 1e-12);
        assert.equal(L.ef, V.ef); assert.equal(L.eb, V.eb);
    }
});

test('emissivity: the coated face gets the coating eps, the other face 0.84', () => {
    for (const c of ['hard', 'single', 'double', 'triple']) {
        const eps = C.coatings[c].eps;
        assert.ok(eps > 0 && eps < 0.3, c + ' eps ' + eps);
        const f = O.pane('clear', 6, c, 'front'), b = O.pane('clear', 6, c, 'back');
        assert.equal(f.ef, eps); assert.equal(f.eb, 0.84);
        assert.equal(b.ef, 0.84); assert.equal(b.eb, eps);
        // The coated face reflects the infrared: front side → Rf, back side → Rb (at 2.5 µm).
        assert.ok(f.Rf[440] > f.Rb[440] && b.Rb[440] > b.Rf[440]);
    }
    const bare = O.pane('clear', 6, 'none', 'back');
    assert.equal(bare.ef, 0.84); assert.equal(bare.eb, 0.84);
    assert.equal(E.EPS_GLASS, 0.84);
});

test('films are cached per coating and glass; the glass optics once per glass type', () => {
    const c2 = load.open(), O2 = c2.GlazingOpen, T2 = c2.GlazingTMM, real = T2.filmSpectra;
    let calls = 0;
    T2.filmSpectra = function () { calls++; return real.apply(this, arguments); };
    O2.pane('clear', 6, 'double', 'back'); O2.pane('clear', 3, 'double', 'front'); O2.pane('clear', 10, 'double', 'back');
    assert.equal(calls, 1, 'one film for double on clear');
    O2.pane('lowiron', 6, 'double', 'back'); assert.equal(calls, 2, 'a second glass type is a second film');
    O2.pane('clear', 6, 'single', 'back'); O2.pane('clear', 6, 'single', 'front'); assert.equal(calls, 3);
    O2.pane('green', 6, 'none', 'front'); assert.equal(calls, 3, 'no film for a bare pane');
    O2.stackPane('clear', 6, C.coatings.single.layers, 0.07, 'back'); O2.stackPane('clear', 6, C.coatings.single.layers, 0.07, 'back');
    assert.equal(calls, 5, 'stackPane without a cache key always computes the film');
    O2.stackPane('clear', 6, C.coatings.single.layers, 0.07, 'back', 'custom1'); O2.stackPane('clear', 4, C.coatings.single.layers, 0.05, 'front', 'custom1');
    assert.equal(calls, 6, 'stackPane with a cache key computes it once');
    assert.equal(O2.glass('clear'), O2.glass('clear'));
    T2.filmSpectra = real;
});

test('unknown keys throw "glazing-open.js: unknown ..."', () => {
    assert.throws(() => O.pane('pink', 6, 'none', 'front'), { message: 'glazing-open.js: unknown glass pink' });
    assert.throws(() => O.pane('clear', 6, 'quad', 'front'), { message: 'glazing-open.js: unknown coating quad' });
    assert.throws(() => E.pane('clear', 6, 'quad', 'back', 'open'), { message: 'glazing-open.js: unknown coating quad' });
    assert.throws(() => O.glass('toString'), { message: 'glazing-open.js: unknown glass toString' });
    assert.throws(() => O.material('Unobtainium'), { message: 'glazing-open.js: unknown material Unobtainium' });
    assert.throws(() => O.film([{ m: 'Au', d: 10 }], 'clear'), { message: 'glazing-open.js: unknown material Au' });
    assert.throws(() => O.stackPane('clear', 6, [{ m: 'ZnO', d: 30 }], 0.1, 'back'), { message: 'glazing-open.js: unknown material ZnO' });
});

test('missing dependencies throw the load-order message; the coatings file is optional', () => {
    const msg = { message: 'glazing-open.js: load glazing-engine.js, glazing-materials.js and glazing-tmm.js first' };
    assert.throws(() => load(['assets/js/glazing-weights.js', 'assets/js/glazing-engine.js', 'assets/js/glazing-open.js']), msg);
    assert.throws(() => load(['assets/js/glazing-materials.js', 'assets/js/glazing-tmm.js', 'assets/js/glazing-open.js']), msg);
    assert.throws(() => load(['assets/js/glazing-weights.js', 'assets/js/glazing-engine.js', 'assets/js/glazing-materials.js', 'assets/js/glazing-open.js']), msg);
    const c = load(['assets/js/glazing-weights.js', 'assets/js/glazing-engine.js', 'assets/js/glazing-materials.js', 'assets/js/glazing-tmm.js', 'assets/js/glazing-open.js']);
    assert.equal(c.GlazingEngine.MODELS.open, c.GlazingOpen);
    assert.throws(() => c.GlazingOpen.pane('clear', 6, 'single', 'back'), { message: 'glazing-open.js: unknown coating single' });
    assert.equal(c.GlazingOpen.pane('clear', 6, 'none', 'back').T.length, 441);
});

test('glass(): n, R0 and alpha (1/mm) = 4πk·1e6/λ from glazing-materials.js', () => {
    for (const key of Object.keys(O.GLASS)) {
        const g = O.glass(key), m = M.materials[O.GLASS[key].mat];
        for (let i = 0; i < 441; i++) {
            const n = m.n[i], k = m.k ? m.k[i] : 0;
            assert.equal(g.n[i], n);
            assert.ok(Math.abs(g.R0[i] - ((n - 1) ** 2 + k * k) / ((n + 1) ** 2 + k * k)) < 1e-16);
            assert.ok(Math.abs(g.alpha[i] - 4 * Math.PI * k * 1e6 / E.LAM[i]) <= 1e-12 * g.alpha[i]);
        }
    }
    // τ = exp(−alpha·d): the bare pane equals the incoherent slab formula.
    const g = O.glass('green'), L = O.pane('green', 5, 'none', 'front');
    for (let i = 0; i < 441; i += 13) {
        const t = Math.exp(-g.alpha[i] * 5), r = g.R0[i], den = 1 - r * r * t * t;
        assert.ok(Math.abs(L.T[i] - (1 - r) ** 2 * t / den) < 1e-15);
    }
    // The tints transmit less visible light than clear, and clear less than low-iron.
    const vt = k => E.evaluate([O.pane(k, 6, 'none', 'front')], [], 1).Tvis;
    assert.ok(vt('lowiron') > vt('clear') && vt('clear') > vt('green') && vt('clear') > vt('grey') && vt('clear') > vt('bronze'));
});

test('stackPane and film: an explicit stack equals the named coating', () => {
    const c = C.coatings.triple, a = O.pane('lowiron', 6, 'triple', 'back'), b = O.stackPane('lowiron', 6, c.layers, c.eps, 'back');
    for (const q of ['T', 'Rf', 'Rb']) for (let i = 0; i < 441; i++) assert.ok(Object.is(a[q][i], b[q][i]));
    assert.equal(a.eb, b.eb);
    const f = O.film(c.layers, 'lowiron'), g = O.glass('lowiron');
    const ref = TMM.filmSpectra(c.layers.map(L => ({ n: M.materials[L.m].n, k: M.materials[L.m].k, d: L.d })), E.LAM, g.n);
    for (const q of ['Tc', 'Rc', 'Rg']) for (let i = 0; i < 441; i++) assert.ok(Object.is(f[q][i], ref[q][i]));
    // Explicit optical constants ({ n, k, d }) are accepted too.
    const ex = O.film([{ n: M.materials.Ag.n, k: M.materials.Ag.k, d: 10 }], 'clear'), named = O.film([{ m: 'Ag', d: 10 }], 'clear');
    for (let i = 0; i < 441; i++) assert.ok(Object.is(ex.Tc[i], named.Tc[i]));
});

test('epsFromSilver: Rs = 7.2e-8 Ω·m / t, en = 4y/(2+y)², eh by the EN 12898 ratio table', () => {
    const table = [[0.03, 1.22], [0.05, 1.18], [0.1, 1.14], [0.2, 1.10], [0.3, 1.06], [0.4, 1.03], [0.5, 1.00], [0.6, 0.98], [0.7, 0.96], [0.8, 0.95], [0.89, 0.94]];
    const ratio = en => {
        if (en <= table[0][0]) return table[0][1];
        if (en >= table[table.length - 1][0]) return table[table.length - 1][1];
        for (let i = 1; i < table.length; i++) if (en <= table[i][0]) return table[i - 1][1] + (en - table[i - 1][0]) / (table[i][0] - table[i - 1][0]) * (table[i][1] - table[i - 1][1]);
    };
    let prev = Infinity;
    for (const t of [5, 8.72, 12, 24.66, 45.59, 60]) {
        const r = O.epsFromSilver(t), rs = 7.2e-8 / (t * 1e-9), y = 376.730313 / rs, en = 4 * y / (2 + y) ** 2;
        assert.ok(Math.abs(r.rs - rs) < 1e-12 * rs && Math.abs(r.en - en) < 1e-15);
        assert.ok(Math.abs(r.eh - en * ratio(en)) < 1e-12, `${t} nm: eh ${r.eh}`);
        assert.ok(r.eh < prev); prev = r.eh;
    }
    // The three calibrated silver stacks are within about ±30 % of their U-inferred emissivity.
    for (const c of ['single', 'double', 'triple']) {
        const ag = C.coatings[c].layers.filter(L => L.m === 'Ag').reduce((a, L) => a + L.d, 0), r = O.epsFromSilver(ag);
        assert.ok(Math.abs(r.eh / C.coatings[c].eps - 1) < 0.35, `${c}: ${r.eh.toFixed(4)} vs ${C.coatings[c].eps}`);
    }
    // With glazing-products.js loaded (page order), its hemispherical() (the same table, spec 2.7.3) is used.
    const c2 = load(load.FILES.open.concat(['assets/js/glazing-products.js']));
    assert.equal(typeof c2.GlazingProducts.hemispherical, 'function');
    for (const t of [3, 8, 20, 40]) assert.ok(Math.abs(c2.GlazingOpen.epsFromSilver(t).eh - O.epsFromSilver(t).eh) < 1e-12, t + ' nm');
    assert.throws(() => O.epsFromSilver(0), /positive/);
});

// ── V2a through GlazingOpen.pane (spec 5.3) ──────────────────────────────────────────────────────────────
const V2A_TOL = { Tvis: 0.3, Tsol: 1.0, Rvis: 0.3, Tuv: 4.0 };
for (const [id, file] of [[102, 'pywincalc/CLEAR_3.DAT'], [103, 'pywincalc/CLEAR_6.DAT'], [9803, 'pywincalc/CLEAR5.LOF']]) {
    test(`V2a IGDB ${id} (${file}) through GlazingOpen.pane, G173 and E891`, t => {
        const rec = readIGDB(LBNL + file), meas = E.imported(asProduct(rec.rows, rec.thickness, rec.ef, rec.eb));
        const rubin = O.pane('clear', rec.thickness, 'none', 'front');
        for (const [name, opts] of [['G173', undefined], ['E891', E891]]) {
            const g = E.evaluate([rubin], [], 1, opts), m = E.evaluate([meas], [], 1, opts);
            for (const q of Object.keys(V2A_TOL)) {
                const d = pct(g[q]) - pct(m[q]);
                t.diagnostic(`${id} ${name} ${q}: open ${pct(g[q]).toFixed(2)}, measured ${pct(m[q]).toFixed(2)}`);
                assert.ok(Math.abs(d) <= V2A_TOL[q], `${id} ${name} ${q}: ${d.toFixed(3)} (tolerance ${V2A_TOL[q]})`);
            }
        }
    });
}
test('V2a low-iron 5 mm (G173) against EnergyPlus "LOW IRON 5MM" (Tv 0.910, Ts 0.889)', () => {
    const r = E.evaluate([O.pane('lowiron', 5, 'none', 'front')], [], 1);
    assert.ok(Math.abs(r.Tvis - 0.910) <= 0.005, 'Tvis ' + r.Tvis);
    assert.ok(Math.abs(r.Tsol - 0.889) <= 0.015, 'Tsol ' + r.Tsol);
});

// ── V2b: clear double glazing against datasheets (spec 5.3, glass-check tolerances of 5.2) ───────────────
const V2B = { 'card-3-clear': { Uair: 0.481, Uar: 0.456, VT: 81.4, SHGC: 0.770, Rout: 14.8 },
    'card-6-clear': { Uair: 0.474, Uar: 0.449, VT: 78.2, SHGC: 0.706, Rout: 14.2 },
    'vitro-6-clear': { Uair: 0.474, Uar: 0.449, VT: 78.2, SHGC: 0.706, Rout: 14.2 } };
function build(row, fill) {
    const L = row.panes.map(p => E.pane(p.glass, p.mm, p.coat || 'none', p.side || 'front', 'open'));
    return E.evaluate(L, row.gaps.map(w => ({ fill, width: w / 1000 })), 1, E891);
}
for (const id of Object.keys(V2B)) {
    test('V2b ' + id + ': open clear double glazing within the glass-check tolerances', t => {
        const row = PUB.rows.find(r => r.id === id);
        assert.equal(row.class, 'clear');
        const a = build(row, 'air'), r = build(row, 'argon');
        const got = { Uair: a.U / BTU, Uar: r.U / BTU, VT: pct(a.Tvis), SHGC: a.SHGC, Rout: pct(a.Rvis) };
        const tol = { Uair: 0.01, Uar: 0.01, VT: 2.0, SHGC: 0.03, Rout: 1.0 };
        for (const q of Object.keys(tol)) {
            t.diagnostic(`${id} ${q}: open ${got[q].toFixed(3)}, published ${row[q]}`);
            assert.ok(Math.abs(got[q] - row[q]) <= tol[q] + 1e-12, `${id} ${q}: ${got[q]} vs ${row[q]} (tolerance ${tol[q]})`);
        }
        // The prototype values of spec 5.3 to their printed precision. U within 0.0025: the audited engine on main
        // (ISO 15099 gas mixtures, indoor film temperature) lowers these U-factors by up to 0.0016 (0.4721 against 0.4735).
        const p = V2B[id];
        assert.ok(Math.abs(got.VT - p.VT) < 0.051 && Math.abs(got.Rout - p.Rout) < 0.051 && Math.abs(got.SHGC - p.SHGC) < 0.0006);
        assert.ok(Math.abs(got.Uair - p.Uair) < 0.0025 && Math.abs(got.Uar - p.Uar) < 0.0025, `U ${got.Uair}, ${got.Uar}`);
        // Report only: UV and the exterior color.
        t.diagnostic(`${id} report: UV ${pct(a.Tuv).toFixed(1)} (published ${row.UV ?? '-'}), exterior a*, b* ${a.colorR.a.toFixed(1)}, ${a.colorR.b.toFixed(1)}`);
    });
}

// ── Soft performance report (printed, not asserted) ──────────────────────────────────────────────────────
test('performance report: median of 20 uncached triple films and 100 double-IGU evaluate() calls', t => {
    const med = a => a.sort((x, y) => x - y)[a.length >> 1];
    const triple = C.coatings.triple.layers, film = [], ev = [];
    for (let i = 0; i < 20; i++) { const t0 = performance.now(); O.film(triple, 'clear'); film.push(performance.now() - t0); }
    const L = [E.pane('clear', 6, 'double', 'back', 'open'), E.pane('clear', 6, 'none', 'front', 'open')], gaps = [{ fill: 'argon', width: 0.0127 }];
    for (let i = 0; i < 100; i++) { const t0 = performance.now(); E.evaluate(L, gaps, 1, E891); ev.push(performance.now() - t0); }
    const L3 = [E.pane('clear', 3, 'triple', 'back', 'open'), E.pane('clear', 3, 'none', 'front', 'open'), E.pane('clear', 3, 'single', 'front', 'open')];
    const ev3 = [];
    for (let i = 0; i < 50; i++) { const t0 = performance.now(); E.evaluate(L3, [{ fill: 'argon', width: 0.0127 }, { fill: 'argon', width: 0.0127 }], 1, E891); ev3.push(performance.now() - t0); }
    const msg = `uncached 10-layer film ${med(film).toFixed(2)} ms (budget 3); double-IGU evaluate ${med(ev).toFixed(2)} ms, triple ${med(ev3).toFixed(2)} ms (budget 2)`;
    t.diagnostic(msg);
    console.log('  [wp2 performance] ' + msg);
});
