// V2a, Rubin glass against measured clear IGDB records (glazing beta build spec, section 5.3 V2a). The glass
// slab is built here straight from assets/js/glazing-materials.js with the formulas of spec 2.3 (no film):
//   R0 = |N - 1|^2 / |N + 1|^2,  tau = exp(-4 pi k d / lambda),
//   T = (1 - R0)^2 tau / (1 - R0^2 tau^2),  R = R0 + (1 - R0)^2 R0 tau^2 / (1 - R0^2 tau^2),
// and evaluated monolithic with the engine. The measured records are read from the unmodified LBNL files
// shipped under assets/data/glazing/lbnl/ with the test-only reader of helpers/records.mjs (independent of
// glazing-products.js) and resampled by GlazingEngine.imported, in memory only.
// Low-iron reference: EnergyPlus WindowGlassMaterials.idf, "LOW IRON 5MM" (Tv 0.910, Ts 0.889; two published
// numbers quoted as facts, the file is not shipped). Run: node --test "_tests/glazing/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers/load.mjs';
import { readIGDB, asProduct, LBNL } from './helpers/records.mjs';

const ctx = load(['assets/js/glazing-weights.js', 'assets/js/glazing-engine.js', 'assets/js/glazing-materials.js',
    'assets/js/glazing-solar-e891.js']);
const E = ctx.GlazingEngine, M = ctx.GlazingMaterials, E891 = { solar: ctx.GlazingSolarE891.solarE891 };
const SPECTRA = { G173: undefined, E891 };

function slab(id, mm) {
    const m = M.materials[id], N = E.LAM.length;
    assert.equal(N, 441);
    const T = new Float64Array(N), R = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        const n = m.n[i], k = m.k ? m.k[i] : 0;
        const R0 = ((n - 1) * (n - 1) + k * k) / ((n + 1) * (n + 1) + k * k);
        const tau = Math.exp(-4 * Math.PI * k * (mm * 1e6) / E.LAM[i]);       // d in nm
        const den = 1 - R0 * R0 * tau * tau;
        T[i] = (1 - R0) * (1 - R0) * tau / den;
        R[i] = R0 + (1 - R0) * (1 - R0) * R0 * tau * tau / den;
    }
    return { T, Rf: R, Rb: R, ef: E.EPS_GLASS, eb: E.EPS_GLASS, t: mm / 1000, k: 1.0 };
}
const mono = (layer, opts) => E.evaluate([layer], [], 1, opts);
const pct = x => 100 * x;

// Spec 5.3 V2a: tolerances, and the prototype values (Rubin vs measured) to their printed precision.
const TOL = { Tvis: 0.3, Tsol: 1.0, Rvis: 0.3, Tuv: 4.0 };
const CASES = [
    { id: 102, file: 'pywincalc/CLEAR_3.DAT', mm: 3.048,
      proto: { Tvis: [89.88, 89.93], Rvis: [8.13, 8.26], G173: { Tsol: [84.15, 83.60], Tuv: [73.3, 70.9] }, E891: { Tsol: [83.94, 83.38], Tuv: [74.3, 72.0] } } },
    { id: 103, file: 'pywincalc/CLEAR_6.DAT', mm: 5.715,
      proto: { Tvis: [88.32, 88.36], Rvis: [8.00, 8.04], G173: { Tsol: [78.30, 77.50], Tuv: [65.0, 62.1] }, E891: { Tsol: [77.89, 77.06], Tuv: [66.3, 63.4] } } },
    { id: 9803, file: 'pywincalc/CLEAR5.LOF', mm: 4.699,
      proto: { Tvis: [88.91, 88.83], Rvis: [8.05, 8.20], G173: { Tsol: [80.44, 79.97], Tuv: [67.8, 65.1] }, E891: { Tsol: [80.11, 79.64], Tuv: [69.0, 66.4] } } }
];

for (const c of CASES) {
    test('V2a IGDB ' + c.id + ' (' + c.file + ', ' + c.mm + ' mm): Rubin clear glass within tolerance', () => {
        const rec = readIGDB(LBNL + c.file);
        assert.ok(Math.abs(rec.thickness - c.mm) < 1e-9, 'record thickness ' + rec.thickness);
        const measured = E.imported(asProduct(rec.rows, rec.thickness, rec.ef, rec.eb));
        const rubin = slab('glass_clear', rec.thickness);
        for (const [name, opts] of Object.entries(SPECTRA)) {
            const g = mono(rubin, opts), m = mono(measured, opts);
            for (const q of ['Tvis', 'Tsol', 'Rvis', 'Tuv']) {
                const d = pct(g[q]) - pct(m[q]);
                assert.ok(Math.abs(d) <= TOL[q], `${c.id} ${name} ${q}: Rubin ${pct(g[q]).toFixed(2)} vs measured ${pct(m[q]).toFixed(2)} (tolerance ${TOL[q]})`);
                // Regression against the prototype values printed in the spec (two decimals, or one for Tuv).
                const p = q === 'Tvis' || q === 'Rvis' ? c.proto[q] : c.proto[name][q];
                const half = q === 'Tuv' ? 0.06 : 0.006;                        // half a printed digit, plus margin
                assert.ok(Math.abs(pct(g[q]) - p[0]) <= half + 1e-9, `${c.id} ${name} ${q} Rubin ${pct(g[q])} vs printed ${p[0]}`);
                assert.ok(Math.abs(pct(m[q]) - p[1]) <= half + 1e-9, `${c.id} ${name} ${q} measured ${pct(m[q])} vs printed ${p[1]}`);
            }
            // Visible quantities do not depend on the solar weighting.
            if (opts) { assert.equal(g.Tvis, mono(rubin).Tvis); assert.equal(g.Rvis, mono(rubin).Rvis); }
        }
    });
}

test('V2a low-iron 5 mm (G173) against EnergyPlus LOW IRON 5MM', () => {
    const g = mono(slab('glass_lowiron', 5));
    assert.ok(Math.abs(g.Tvis - 0.910) <= 0.005, 'Tvis ' + g.Tvis);
    assert.ok(Math.abs(g.Tsol - 0.889) <= 0.015, 'Tsol ' + g.Tsol);
    assert.ok(Math.abs(g.Tvis - 0.9102) <= 0.00005 && Math.abs(g.Tsol - 0.8878) <= 0.00005, 'prototype 0.9102 / 0.8878');
});

test('V2a sanity: tints absorb more than clear, low-iron less; the slab conserves energy', () => {
    const tv = id => mono(slab(id, 6)).Tvis, ts = id => mono(slab(id, 6)).Tsol;
    assert.ok(tv('glass_lowiron') > tv('glass_clear'));
    for (const t of ['glass_green', 'glass_grey', 'glass_bronze']) assert.ok(tv(t) < tv('glass_clear') && ts(t) < ts('glass_clear'), t);
    for (const id of ['glass_clear', 'glass_lowiron', 'glass_green', 'glass_grey', 'glass_bronze']) {
        const s = slab(id, 6);
        for (let i = 0; i < 441; i++) assert.ok(s.T[i] >= 0 && s.Rf[i] > 0 && s.T[i] + s.Rf[i] <= 1 + 1e-12, id + ' ' + E.LAM[i]);
    }
    // k = 0 limit: a lossless slab has T + R = 1 (spec 2.3 formulas).
    const n = 1.52, R0 = ((n - 1) / (n + 1)) ** 2;
    assert.ok(Math.abs((1 - R0) ** 2 / (1 - R0 * R0) + R0 + (1 - R0) ** 2 * R0 / (1 - R0 * R0) - 1) < 1e-15);
});
