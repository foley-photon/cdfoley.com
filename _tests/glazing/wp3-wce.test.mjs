// V1 and V1c (glazing beta build spec, section 5.3): Windows-CalcEngine regressions. The records are parsed from
// the shipped, unmodified spectralSampleData.cpp with GlazingProducts.parseWCECpp, turned into products with
// productFromRecord, resampled by GlazingEngine.imported and integrated with the ASTM E891 weights. References are
// the EXPECT_NEAR values of the Windows-CalcEngine unit tests at commit 1dedefaf88dd10c7820d920a2ded6e486f1fc672,
// folder src/MultiLayerOptics/tst/units/ (facts, typed in here with the file name of each test):
//   MultiPaneSpecular_2191_102_FullSpectrum.unit.cpp, MultiPaneSpecular_6046.unit.cpp,
//   MultiPaneSpecular_NFRC913.unit.cpp, MultiPaneSpecular_21467.unit.cpp,
//   NFRC_5439_SB70XL_Colors_MultiPaneSpecular_FullSpectrum.unit.cpp.
// The remaining differences (up to 3e-4) come from integrating on the engine's 5 nm grid rather than on WCE's
// wavelength set. Run: node --test "_tests/glazing/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, ROOT } from './helpers/load.mjs';

const ctx = load(['assets/js/glazing-weights.js', 'assets/js/glazing-engine.js', 'assets/js/glazing-solar-e891.js',
    'assets/js/glazing-products.js']);
const E = ctx.GlazingEngine, P = ctx.GlazingProducts, Wt = ctx.GlazingWeights, S891 = ctx.GlazingSolarE891.solarE891;
const CPP = 'wce/spectralSampleData.cpp';
const recs = P.parseWCECpp(fs.readFileSync(path.join(ROOT, 'assets/data/glazing/lbnl', CPP), 'utf8'));
// Thickness from each WCE test; it does not enter the optics.
const product = (record, mm) => P.productFromRecord({ id: 'test-' + record, name: record, manufacturer: 'test', igdbId: 0,
    type: 'coated', coatedSide: null, thicknessMm: mm, file: CPP, record }, recs[record], { base: 'lbnl/', files: [] });
const av = a => E.avg(a, S891);

function near(label, got, exp, tol) {
    assert.ok(Math.abs(got - exp) <= tol, `${label}: got ${got.toFixed(6)}, WCE ${exp}, tolerance ${tol}`);
}

test('V1.1 NFRC_2191 (3.0 mm, flipped) + NFRC_102 (3.048 mm): T, Rf, Rb, A1, A2', () => {
    const s = E.system([E.imported(product('NFRC_2191', 3.0), true), E.imported(product('NFRC_102', 3.048), false)]);
    near('T', av(s.T), 0.586491727, 5e-4);
    near('Rf', av(s.Rf), 0.229786798, 5e-4);
    near('Rb', av(s.Rb), 0.190210295, 5e-4);
    near('A1', av(s.A[0]), 0.127688243, 3e-4);
    near('A2', av(s.A[1]), 0.0560332311, 3e-4);
    // Prototype values printed in the spec (4 decimals).
    near('T vs prototype', av(s.T), 0.5862, 6e-5);
    near('Rf vs prototype', av(s.Rf), 0.2301, 6e-5);
});

const MONO = [
    ['V1.2', 'NFRC_6046', 5.66, [0.383209772, 0.285971675, 0.449239729, 0.330818553]],
    ['V1.3', 'NFRC_913', 4.7752, [0.513398587, 0.0550761015, 0.0550761015, 0.431525312]],
    ['V1.4', 'NFRC_21467', 3.0, [0.857620132, 0.108847554, 0.114567521, 0.0335323147]]
];
for (const [label, record, mm, ref] of MONO) {
    test(`${label} ${record} (${mm} mm, monolithic): T, Rf, Rb, A`, () => {
        const s = E.system([E.imported(product(record, mm), false)]);
        near('T', av(s.T), ref[0], 5e-4);
        near('Rf', av(s.Rf), ref[1], 5e-4);
        near('Rb', av(s.Rb), ref[2], 5e-4);
        near('A', av(s.A[0]), ref[3], 5e-4);
    });
}

// V1c: CIELAB of NFRC_5439 (monolithic) with the D65 and CIE 1964 10° tables of the WCE standardData.cpp (shipped
// unmodified under _scripts/data/wce/), binned exactly like the engine's weights (5 nm bins, 0.25 nm sub-steps,
// linear interpolation, zero outside the table) and substituted for GlazingWeights.X/Y/Z inside this test only.
function series(src, name) {
    const at = src.search(new RegExp('CSeries\\s+' + name + '\\s*\\(\\s*\\)'));
    assert.ok(at >= 0, 'standardData.cpp: no ' + name + '()');
    const body = src.slice(at, src.indexOf('}}', at) + 2);
    const out = [...body.matchAll(/\{\s*([0-9.]+)\s*,\s*([-+0-9.eE]+)\s*\}/g)].map(m => [Number(m[1]) * 1000, Number(m[2])]);
    assert.ok(out.length > 50, name + ': ' + out.length + ' points');
    return out;
}
function interp(t, x) {
    if (x < t[0][0] || x > t[t.length - 1][0]) return 0;
    let lo = 0, hi = t.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m][0] <= x) lo = m; else hi = m; }
    return t[lo][1] + (x - t[lo][0]) / (t[hi][0] - t[lo][0]) * (t[hi][1] - t[lo][1]);
}
const binned = fn => Array.from(E.LAM, c => { let s = 0; for (let x = c - 2.5 + 0.125; x < c + 2.5; x += 0.25) s += fn(x) * 0.25; return s; });

test('V1c NFRC_5439 monolithic color (D65, CIE 1964 10°) against WCE', () => {
    const src = fs.readFileSync(path.join(ROOT, '_scripts/data/wce/standardData.cpp'), 'utf8');
    const D65 = series(src, 'solarRadiation'), X = series(src, 'ASTM_E308_1964_X'), Y = series(src, 'ASTM_E308_1964_Y'), Z = series(src, 'ASTM_E308_1964_Z');
    const wx = binned(x => interp(D65, x) * interp(X, x)), wy = binned(x => interp(D65, x) * interp(Y, x)), wz = binned(x => interp(D65, x) * interp(Z, x));
    const ky = wy.reduce((a, b) => a + b, 0);
    const layer = E.imported(product('NFRC_5439', 6.0), false);
    const save = { X: Wt.X, Y: Wt.Y, Z: Wt.Z };
    let cT, cR;
    try {
        Wt.X = wx.map(v => v / ky); Wt.Y = wy.map(v => v / ky); Wt.Z = wz.map(v => v / ky);
        cT = E.color(layer.T); cR = E.color(layer.Rf);
    } finally { Object.assign(Wt, save); }
    console.log(`  V1c T L*a*b* ${cT.L.toFixed(3)} ${cT.a.toFixed(3)} ${cT.b.toFixed(3)} (WCE 87.8126 -3.3694 4.0317); ` +
        `Rf ${cR.L.toFixed(3)} ${cR.a.toFixed(3)} ${cR.b.toFixed(3)} (WCE 33.2046 -2.7642 -6.1874)`);
    near('T L*', cT.L, 87.8126, 0.1); near('T a*', cT.a, -3.3694, 0.3); near('T b*', cT.b, 4.0317, 0.3);
    near('Rf L*', cR.L, 33.2046, 0.1); near('Rf a*', cR.a, -2.7642, 0.3); near('Rf b*', cR.b, -6.1874, 0.3);
    // The shipped weights are back in place: the engine's own D65 / 2° color differs from the 10° one.
    assert.ok(Math.abs(E.color(layer.T).a - cT.a) > 1e-6);
});
