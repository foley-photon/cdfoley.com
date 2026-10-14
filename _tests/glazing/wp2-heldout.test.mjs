// WP2: V6 (glazing beta build spec 5.3): the open generic coatings against held-out measured records of the
// same class that the calibration never saw. Generic coating on #2 of the record's own substrate and thickness;
// the measured record with its coating on #2; a Rubin clear partner; 12.7 mm gap; E891 weights; H = 1 m.
// The records are read from the unmodified LBNL files shipped under assets/data/glazing/lbnl/ with the
// test-only readers of helpers/records.mjs (independent of glazing-products.js) and resampled in memory only.
// Emissivities: the file header when it has one (9923), otherwise computed here from the record's infrared
// spectrum (5-40 µm, Planck weighting at 283 K, trapezoid rule, EN 12898 normal-to-hemispherical ratios),
// an implementation independent of WP3's irEmissivity. Run: node --test "_tests/glazing/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers/load.mjs';
import { readIGDB, readWCE, asProduct, LBNL } from './helpers/records.mjs';

const ctx = load.open();
const E = ctx.GlazingEngine, O = ctx.GlazingOpen;
const E891 = { solar: ctx.GlazingSolarE891.solarE891 };
const BTU = 5.678263;

// Hemispherical emissivity of one face of a WCE record [[µm, Tf, Tb, Rf, Rb]].
const EN12898 = [[0.03, 1.22], [0.05, 1.18], [0.1, 1.14], [0.2, 1.10], [0.3, 1.06], [0.4, 1.03], [0.5, 1.00], [0.6, 0.98], [0.7, 0.96], [0.8, 0.95], [0.89, 0.94]];
function hemi(en) {
    const t = EN12898;
    if (en <= t[0][0]) return en * t[0][1];
    if (en >= t[t.length - 1][0]) return en * t[t.length - 1][1];
    for (let i = 1; i < t.length; i++) if (en <= t[i][0]) return en * (t[i - 1][1] + (en - t[i - 1][0]) / (t[i][0] - t[i - 1][0]) * (t[i][1] - t[i - 1][1]));
}
function emissivity(rows, face) {
    const planck = um => 1 / (um ** 5 * (Math.exp(14387.77 / (um * 283)) - 1));
    const pts = rows.filter(r => r[0] >= 5 - 1e-9 && r[0] <= 40 + 1e-9).map(r => [r[0], 1 - r[1] - (face === 'back' ? r[4] : r[3])]);
    let num = 0, den = 0;
    for (let i = 1; i < pts.length; i++) {
        const [x0, e0] = pts[i - 1], [x1, e1] = pts[i], b0 = planck(x0), b1 = planck(x1), dx = x1 - x0;
        num += 0.5 * dx * (e0 * b0 + e1 * b1); den += 0.5 * dx * (b0 + b1);
    }
    const eh = hemi(num / den);
    return eh > 0.5 ? 0.84 : eh;
}

const wce = readWCE(LBNL + 'wce/spectralSampleData.cpp');
const ea = readIGDB(LBNL + 'pywincalc/LOW-E_5.LOF');

test('infrared emissivities of the WCE records (spec A.6: 2191 0.0651, 6046 0.0379, 5439 0.0171 on the back face)', () => {
    for (const [id, exp] of [['NFRC_2191', 0.0651], ['NFRC_6046', 0.0379], ['NFRC_5439', 0.0171]]) {
        assert.ok(Math.abs(emissivity(wce[id], 'back') - exp) <= 0.0005, id + ' ' + emissivity(wce[id], 'back'));
        assert.equal(emissivity(wce[id], 'front'), 0.84, id + ' front face is uncoated');
    }
    assert.ok(Math.abs(ea.ef - 0.1579693) < 1e-9, 'LOW-E_5.LOF header front emissivity');
});

// [class, measured layer (coating on #2), generic substrate, mm, partner mm, RMS tolerance, prototype values of 5.3]
const CASES = [
    { cls: 'single', id: 2191, glass: 'clear', mm: 3.0, partner: 3, rmsTol: 3,
      meas: () => E.imported(asProduct(wce.NFRC_2191, 3.0, 0.84, emissivity(wce.NFRC_2191, 'back')), false) },
    { cls: 'double', id: 6046, glass: 'clear', mm: 5.66, partner: 6, rmsTol: 3,
      meas: () => E.imported(asProduct(wce.NFRC_6046, 5.66, 0.84, emissivity(wce.NFRC_6046, 'back')), false) },
    { cls: 'triple', id: 5439, glass: 'lowiron', mm: 6.0, partner: 6, rmsTol: 3,
      meas: () => E.imported(asProduct(wce.NFRC_5439, 6.0, 0.84, emissivity(wce.NFRC_5439, 'back')), false) },
    // 9923 is coated on its front face: flipped, so the coating faces indoors (#2).
    { cls: 'hard', id: 9923, glass: 'clear', mm: ea.thickness, partner: ea.thickness, rmsTol: 9,
      meas: () => E.imported(asProduct(ea.rows, ea.thickness, ea.ef, ea.eb), true) }
];

for (const c of CASES) {
    test(`V6 ${c.cls}: generic open coating vs measured IGDB ${c.id} (${c.glass}, ${c.mm} mm, partner ${c.partner} mm)`, t => {
        const meas = c.meas(), gen = E.pane(c.glass, c.mm, c.cls, 'back', 'open');
        assert.ok(meas.eb < 0.2 && meas.ef === 0.84, 'measured coating on the back face (#2)');
        let s = 0, n = 0;
        for (let i = 0; i < E.LAM.length; i++) if (E.LAM[i] >= 450) { s += (gen.T[i] - meas.T[i]) ** 2; n++; }
        const rms = 100 * Math.sqrt(s / n);
        t.diagnostic(`${c.cls}: spectral RMS of T, 450-2500 nm: ${rms.toFixed(2)} points (tolerance ${c.rmsTol})`);
        assert.ok(rms <= c.rmsTol, `RMS ${rms}`);
        const P = O.pane('clear', c.partner, 'none', 'front');
        const res = {};
        for (const fill of ['air', 'argon']) {
            const g = E.evaluate([gen, P], [{ fill, width: 0.0127 }], 1, E891), m = E.evaluate([meas, P], [{ fill, width: 0.0127 }], 1, E891);
            res[fill] = { g, m };
            t.diagnostic(`${c.cls} U ${fill}: open ${(g.U / BTU).toFixed(3)}, measured ${(m.U / BTU).toFixed(3)}`);
            assert.ok(Math.abs(g.U - m.U) / BTU <= 0.01, `U ${fill}`);
        }
        const { g, m } = res.air;
        const checks = [['VT', 100 * g.Tvis, 100 * m.Tvis, 2.0], ['SHGC', g.SHGC, m.SHGC, 0.03], ['Rout', 100 * g.Rvis, 100 * m.Rvis, 2.5],
            ['Rext a*', g.colorR.a, m.colorR.a, 5.5], ['Rext b*', g.colorR.b, m.colorR.b, 5.5]];
        for (const [q, go, me, tol] of checks) {
            t.diagnostic(`${c.cls} ${q}: open ${go.toFixed(3)}, measured ${me.toFixed(3)} (tolerance ${tol})`);
            assert.ok(Math.abs(go - me) <= tol, `${c.cls} ${q}: open ${go}, measured ${me}`);
        }
    });
}

test('V6 context: the classic coatings miss the same records by more (spectral RMS of T)', t => {
    for (const c of CASES) {
        const meas = c.meas(), gen = E.pane(c.glass === 'lowiron' ? 'lowiron' : 'clear', c.mm, c.cls, 'back');
        let s = 0, n = 0;
        for (let i = 0; i < E.LAM.length; i++) if (E.LAM[i] >= 450) { s += (gen.T[i] - meas.T[i]) ** 2; n++; }
        t.diagnostic(`${c.cls}: classic RMS ${(100 * Math.sqrt(s / n)).toFixed(1)} points`);
    }
});
