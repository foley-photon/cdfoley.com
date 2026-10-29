// Writes _tests/conductance/fixtures/golden-formulas.json from the design reference implementation
// (E:\Temp\cdfoley-work\design\cond-proto3\ref-molecular.mjs and ref-network.mjs; spec 3.4.3 and 5.2).
// WP1's engine must reproduce these values to 1e-7 (functions) and 1e-6 (preset analyses and sweeps).
// Usage: node _tests/conductance/tools/make-golden.mjs [--ref-dir=<folder with ref-molecular.mjs>]
// Only the design machine has the reference; the tests read the JSON and never import the reference.
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'fixtures', 'golden-formulas.json');
const argDir = process.argv.find((a) => a.startsWith('--ref-dir='));
const REF_DIR = argDir ? argDir.slice(10) : 'E:/Temp/cdfoley-work/design/cond-proto3';
const M = await import(pathToFileURL(path.join(REF_DIR, 'ref-molecular.mjs')).href);
const N = await import(pathToFileURL(path.join(REF_DIR, 'ref-network.mjs')).href);

const DEG = Math.PI / 180;
const sha = (f) => createHash('sha256').update(readFileSync(path.join(REF_DIR, f))).digest('hex');
const ev = (fn, args) => ({ args, value: fn(...args) });

// ---- inputs (spec 5.2): every function of 2.4 and 2.5 across, and beyond, each table's range
const TUBE_Y = [0, 1e-6, 1e-3, 0.02, 0.1, 0.25, 0.5, 0.9, 1, 1.7, 3, 5, 9.5, 20, 50, 120, 500, 1e4, 2.5e4, 1e6];
const SLOT_X = [0.01, 0.04, 0.05, 0.07, 0.1, 0.25, 0.6, 1, 1.3, 2.5, 4, 8, 13, 40, 120, 450, 1500, 8000, 1e4, 1e5];
const RECT_SL = [[1, 0.05], [1, 0.1], [1, 1], [1, 7], [1, 100], [1, 300], [0.5, 0.05], [0.5, 0.33], [0.5, 2], [0.5, 30], [0.5, 300],
    [0.3, 0.15], [0.3, 4.4], [0.3, 70], [0.25, 1], [0.2, 0.7], [0.2, 15], [0.125, 3], [0.1, 0.05], [0.1, 9], [0.1, 250],
    [0.0625, 0.4], [0.05, 25], [1 / 32, 1], [0.02, 0.2], [0.02, 120], [0.01, 5], [0.01, 300], [0.004, 50], [0.7, 12]];
const ANN_EL = [[0.05, 0.05], [0.05, 1], [0.05, 40], [0.1, 3], [0.25, 0.1], [0.25, 2], [0.3, 300], [0.4, 0.6], [0.5, 2], [0.5, 10],
    [0.5, 150], [0.6, 0.05], [0.6, 7], [0.75, 1], [0.75, 20], [0.8, 0.3], [0.85, 60], [0.9, 5], [0.9, 100], [0.92, 0.12],
    [0.95, 2], [0.95, 33], [0.96, 300], [0.975, 0.05], [0.975, 1], [0.975, 35], [0.975, 300], [0.99, 4], [0.2, 15], [0.7, 0.45]];
const CONE_BL = [[0.05, 3], [0.1, 0.5], [0.3, 20], [0.5, 100], [0.7, 250], [1, 0.05], [1.5, 6], [2, 2], [3, 40], [3.5, 500],
    [4, 0.3], [5, 1], [5, 16], [6, 120], [7.5, 9], [9, 0.08], [10, 1], [10, 4], [12, 300], [15, 0.7], [17, 25], [20, 2],
    [22, 60], [25, 0.2], [27, 5], [30, 4], [33, 150], [37.5, 1], [40, 11], [45, 1], [48, 0.4], [52.5, 3], [55, 400], [60, 4],
    [67, 0.12], [75, 2], [80, 30], [85, 0.6], [89, 1], [0, 7]];
const ELBOW_AB = [[1, 1], [1, 3], [1.2, 1.7], [1.5, 50], [2, 2], [2, 5], [5, 2], [2.5, 7], [3, 3], [4, 12], [5, 5], [7, 1.3],
    [10, 10], [15, 40], [20, 2], [33, 8], [50, 50], [60, 3], [100, 1], [100, 100]];
const DELTA = [0, 1e-4, 0.001, 0.003, 0.01, 0.03, 0.05, 0.1, 0.33, 0.5, 1, 1.4, 2.7, 5, 10, 20, 49, 50, 120, 1000];
const G_R = [[0.1, 0], [0.5, 0.05], [1, 0.3], [2, 0.5], [5, 0.7], [10, 0.9], [20, 0.95], [50, 1], [100, 0.2], [0.01, 0.99]];
const PSI_RG = [[0, 1.4], [0.3, 1.4], [0.5283, 1.4], [0.6, 1.4], [0.95, 1.4], [0.4, 5 / 3], [0.487, 5 / 3], [0.8, 5 / 3], [0.5, 1.29], [0.999, 1.33]];
const INV_A = [0.999, 0.95, 0.8, 0.6, 0.5, 0.3, 0.1, 0.03, 0.005, 1e-4];

const tube = (d, L) => ({ t: 'tube', d, L }), orif = (d) => ({ t: 'orifice', shape: 'circle', d });
// Appendix B presets (T = 293.15 K, default Cd, plot range 1e-6 to 1.2e5 Pa)
const PRESETS = {
    'turbo-dn100': { items: [tube(0.1, 0.2), { t: 'elbow', d: 0.1, A: 0.1, B: 0.1 }, { t: 'pump', S: 0.3, d: 0.1, label: 'Turbo' }], gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'pump', p0: 1e-4 }, range: { pMin: 1e-6, pMax: 1.2e5 } },
    'livesey-p100': { items: [tube(0.1, 0.2), { t: 'pump', S: 0.3, d: 0.1, label: 'Pump' }], gas: { id: 'air', T: 293.15, custom: null }, Cd: null, bc: { mode: 'pump', p0: 1e-4 }, range: { pMin: 1e-6, pMax: 1.2e5 } },
    'roughing-kf25': { items: [tube(0.025, 1), { t: 'pump', S: 0.009722222, d: 0.025, label: 'Rotary_vane' }], gas: { id: 'air', T: 293.15, custom: null }, Cd: null, bc: { mode: 'pump', p0: 100 }, range: { pMin: 1e-6, pMax: 1.2e5 } },
    'beamline': { items: [tube(0.04, 0.15), { t: 'bbox', C: 0.08, gasRef: 'N2', d: 0.04, label: 'Gate_valve' }, { t: 'cone', d1: 0.04, d2: 0.063, L: 0.05 }, { t: 'pump', S: 0.08, d: 0.063, label: 'Turbo' }], gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'pump', p0: 1e-5 }, range: { pMin: 1e-6, pMax: 1.2e5 } },
    'diff-aperture': { items: [orif(0.001)], gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'dp', p0: 10, p1: 0.01 }, range: { pMin: 1e-6, pMax: 1.2e5 } },
    'slit-seal': { items: [{ t: 'slit', h: 0.0001, w: 0.05, L: 0.01 }], gas: { id: 'air', T: 293.15, custom: null }, Cd: null, bc: { mode: 'dp', p0: 1e5, p1: 1000 }, range: { pMin: 1e-6, pMax: 1.2e5 } },
    'parallel': { items: [tube(0.05, 0.1), { t: 'parallel', branches: [[tube(0.02, 0.3)], [tube(0.03, 0.5), { t: 'elbow', d: 0.03, A: 0.05, B: 0.05 }]] }, { t: 'pump', S: 0.05, d: 0.05, label: 'Turbo' }], gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'pump', p0: 1e-4 }, range: { pMin: 1e-6, pMax: 1.2e5 } },
};

const out = {
    format: 'cdfoley-conductance-golden', version: 1, generated: new Date().toISOString().slice(0, 10),
    generator: '_tests/conductance/tools/make-golden.mjs',
    reference: { files: ['ref-molecular.mjs', 'ref-network.mjs'], sha256: { 'ref-molecular.mjs': sha('ref-molecular.mjs'), 'ref-network.mjs': sha('ref-network.mjs') } },
    tolerance: { functions: 1e-7, analyses: 1e-6 },
    functions: {
        tubeAlpha: TUBE_Y.map((y) => ev(M.tubeAlpha, [y])),
        tubeAlphaInverse: INV_A.map((a) => ev(M.tubeAlphaInverse, [a])),
        slotAlpha: SLOT_X.map((x) => ev(M.slotAlpha, [x])),
        rectAlpha: RECT_SL.map(([s, l]) => ev(M.rectAlpha, [s, 1, l * s])),               // a = s, b = 1, L = l a
        annulusAlpha: ANN_EL.map(([e, l]) => ev(M.annulusAlpha, [e, 1, l * (1 - e)])),     // Ri = e, Ro = 1, L = l (Ro - Ri)
        coneAlpha: CONE_BL.flatMap(([b, l], k) => {
            const R2 = 1 + l * Math.tan(b * DEG);
            return k % 2 ? [ev(M.coneAlpha, [R2, 1, l])] : [ev(M.coneAlpha, [1, R2, l])];  // alternate diverging / converging
        }),
        elbowAlpha: ELBOW_AB.map(([A, B]) => ev(M.elbowAlpha, [1, A, B])),
        Z: DELTA.map((d) => ev(N.Z, [d])),
        IZ: DELTA.map((d) => ev(N.IZ, [d])),
        GP: DELTA.map((d) => ev(N.GP, [d])),
        gOrifice: G_R.map((a) => ev(N.gOrifice, a)),
        psi: PSI_RG.map((a) => ev(N.psi, a)),
        nearFmA: [0, 0.05, 0.1, 0.3, 0.5, 0.7, 0.9, 0.95, 1, 1.2].map((r) => ev(N.nearFmA, [r])),
    },
    presets: {},
};
for (const [name, m] of Object.entries(PRESETS)) {
    const r = N.analyze(m), G = r.G;
    const mol = N.molecularLimit(m.items, G);
    const lineItems = m.items.filter((i) => i.t !== 'pump');
    const entry = {
        model: m,
        analyze: { Q: r.Q, Seff: r.Seff, Cline: r.Cline, pN: r.pN, shares: r.elements.map((e) => e.share), pumpShare: r.pumpShare, converged: r.converged, junctions: r.junctions },
        molecularLimit: { Cline: mol.Cline, Seff: mol.Seff },
        sweepC: Array.from(N.sweepC(lineItems, G, 1e-6, 1.2e5).y),
    };
    if (m.bc.mode === 'pump') {
        const s = N.sweepSeff(m.items, G, 1e-6, 1.2e5);
        entry.sweepSeff = Array.from(s.y);
        entry.sweepSeffConverged = s.converged.every((c) => c === 1);
    }
    out.presets[name] = entry;
}
// ---- deliberate improvements over the design reference (spec 3.4.3: recorded here and in the integration report)
// 1. Spec v2.1, 3.2.1: Berman's closed form is used up to y = 1e7 (the reference switches to the asymptote at 1e4,
//    where the asymptote is 4.7e-5 off). Only tubeAlpha entries above y = 1e4 and tubeAlphaInverse entries whose
//    result lies above y = 1e4 (alpha = 1e-4) change; no other golden input reaches y > 1e4.
const bermanClosed = (y) => {
    const s = Math.sqrt(y * y + 1), sm1 = y * y / (s + 1);
    const Nn = 2 * sm1 - y * y / (y + s), Dd = 4.5 * (y * s - Math.asinh(y));
    return s / (y + s) - Nn * Nn / Dd;
};
out.improvements = [];
for (const e of out.functions.tubeAlpha) {
    const y = e.args[0];
    if (y > 1e4 && y <= 1e7) {
        out.improvements.push({ fn: 'tubeAlpha', args: [y], reference: e.value, value: bermanClosed(y), why: 'spec v2.1 3.2.1: closed form up to y = 1e7' });
        e.value = bermanClosed(y);
    }
}
const tubeImproved = (y) => (y === 0 ? 1 : y > 1e7 ? (4 / (3 * y)) * (1 - 0.45515 * Math.log(y) / y) : bermanClosed(y));
for (const e of out.functions.tubeAlphaInverse) {
    if (!(e.value > 1e4)) continue;
    let lo = Math.log(1e-9), hi = Math.log(1e9);
    for (let k = 0; k < 200; k++) { const mid = 0.5 * (lo + hi); if (tubeImproved(Math.exp(mid)) > e.args[0]) lo = mid; else hi = mid; }
    const y = Math.exp(0.5 * (lo + hi));
    out.improvements.push({ fn: 'tubeAlphaInverse', args: e.args, reference: e.value, value: y, why: 'spec v2.1 3.2.1: closed form up to y = 1e7' });
    e.value = y;
}
// 2. Spec v2.2, 3.3.2: the rarefied part of a slot-like core (slit, rectangular duct, annulus) is capped by Sharipov's
//    plane-channel flow rate, which the reference does not have (it was 25-117 % high in transitional flow). Of the
//    presets only 'slit-seal' has such an element; its operating point and C sweep are taken from the engine (its
//    molecular limit is unchanged). The reference values are kept under `improvements`.
{
    const ENG = await import(pathToFileURL(path.join(HERE, '..', '..', '..', 'beta', 'conductance', 'js', 'engine', 'network.js')).href);
    const g = out.presets['slit-seal'], r = ENG.analyze(g.model), sc = ENG.sweep(g.model, 'C');
    const now = { Q: r.Q, Seff: r.Seff, Cline: r.Cline, pN: r.pN, shares: r.elements.map((e) => e.share), pumpShare: g.analyze.pumpShare, converged: r.converged, junctions: r.mol.band.junctions };
    out.improvements.push({ preset: 'slit-seal', reference: { analyze: g.analyze, sweepC: g.sweepC }, value: { analyze: now, sweepC: Array.from(sc.y) },
        why: 'spec v2.2 3.3.2: plane-channel cap of slot-like cores in transitional flow (Sharipov & Seleznev 1998, Table 3)' });
    g.analyze = now;
    g.sweepC = Array.from(sc.y);
}
const text = JSON.stringify(out, null, 1) + '\n';
writeFileSync(OUT, text);
const n = Object.values(out.functions).reduce((s, a) => s + a.length, 0);
process.stdout.write(`Wrote ${path.relative(process.cwd(), OUT)}: ${n} function values, ${Object.keys(out.presets).length} presets (${Buffer.byteLength(text)} bytes).\n`);
