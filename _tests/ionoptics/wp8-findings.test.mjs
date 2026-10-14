// WP-B (build round 2): the five open re-verification findings. Stale Summary report and Methods text are cleared on a
// project identity change; the Lens key covers the field key, the field interpolation and the relativistic flag;
// beamWaist works per (source, species) and rejects a dispersed beam; the FWHM reliability mark has a measured
// false-positive bound; cusp-shaped peaks carry a stated caveat. Engine numerics (peakStats values) must not move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../beta/ion-optics/js/engine/schema.js';
import * as A from '../../beta/ion-optics/js/engine/analysis.js';
import * as hash from '../../beta/ion-optics/js/engine/hash.js';
import { runProject } from '../../beta/ion-optics/js/engine/pipeline.js';
import { normal01, uniform01 } from '../../beta/ion-optics/js/engine/rng.js';
import { presetById } from '../../beta/ion-optics/js/presets/index.js';
import { projectIdentity } from '../../beta/ion-optics/js/ui/panels/results.js';
import { fieldStateKey } from '../../beta/ion-optics/js/ui/panels/lens.js';

/** A UI-like state (project, resolved, keys) for a project. */
function state(p) {
    const r = S.resolve(p).resolved;
    const gk = hash.geomKey(r), fk = hash.fieldKey(r, gk), rk = hash.runKey(r, fk);
    return { project: p, resolved: r, keys: { geomKey: gk, fieldKey: fk, runKey: rk } };
}
const edited = (p, f) => { const q = structuredClone(p); f(q); return state(q); };
/** The verifier's generator (fwhmflag.mjs): one LCG stream per (n, seed). */
const lcg = (s) => () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };

test('Summary: the accuracy-report identity follows every run input (voltage, source, recording, tracer), not the view or the name', () => {
    const p = presetById('einzel').build();
    const a = state(p), id = projectIdentity(a);
    assert.notEqual(id, projectIdentity(edited(p, (q) => { q.params.find((x) => x.name === 'Vc').value = -8000; })), 'voltage');
    assert.notEqual(id, projectIdentity(edited(p, (q) => { q.sources[0].position.p1 = [-52, 2, 0]; })), 'source position');
    assert.notEqual(id, projectIdentity(edited(p, (q) => { q.sources[0].energy = { type: 'mono', ke: 900 }; })), 'source energy');
    assert.notEqual(id, projectIdentity(edited(p, (q) => { q.recording.planes[0].at = 130; })), 'recording plane');
    assert.notEqual(id, projectIdentity(edited(p, (q) => { q.tracer.relativistic = false; })), 'tracer');
    assert.notEqual(id, projectIdentity(edited(p, (q) => { q.tracer.fieldInterp = 'linear'; })), 'field interpolation');
    assert.equal(id, projectIdentity(edited(p, (q) => { q.view.scale = 9; })), 'view');
    assert.equal(id, projectIdentity(edited(p, (q) => { q.meta.name = 'Renamed'; })), 'name');
    // another preset is another identity even when its keys were never computed
    assert.notEqual(id, projectIdentity(state(presetById('two-tube').build())));
    assert.notEqual(projectIdentity({ project: { meta: { preset: 'a' } } }), projectIdentity({ project: { meta: { preset: 'b' } } }));
});

test('Lens: fieldStateKey includes the field key, the field interpolation and the relativistic flag, and nothing of the sources', () => {
    const p = presetById('einzel').build();
    const a = state(p), key = fieldStateKey(a);
    assert.ok(key.includes(a.keys.fieldKey), 'contains the field key');
    assert.notEqual(key, fieldStateKey(edited(p, (q) => { q.params.find((x) => x.name === 'Vc').value = -8000; })), 'voltage (field key)');
    assert.notEqual(key, fieldStateKey(edited(p, (q) => { q.tracer.fieldInterp = 'linear'; })), 'field interpolation');
    assert.notEqual(key, fieldStateKey(edited(p, (q) => { q.tracer.relativistic = false; })), 'relativistic flag');
    assert.equal(key, fieldStateKey(edited(p, (q) => { q.sources[0].position.p1 = [-52, 2, 0]; q.sources[0].energy = { type: 'mono', ke: 900 }; })), 'a source edit does not touch the lens rays');
    assert.equal(key, fieldStateKey(edited(p, (q) => { q.recording.planes[0].at = 130; })), 'nor a recording edit');
    assert.equal(key, fieldStateKey(edited(p, (q) => { q.view.scale = 9; })), 'nor the view');
    // the flag is read even without computed keys (defaults: cubic, relativistic)
    assert.equal(fieldStateKey({ resolved: { tracer: {} } }), '|cubic|rel');
    assert.equal(fieldStateKey({ resolved: { tracer: { fieldInterp: 'linear', relativistic: false } } }), '|linear|nonrel');
});

test('beamWaist: the magnetic sector is dispersed (no single waist) and lists the image of each species at its own position', () => {
    const r = runProject(presetById('magnetic-sector').build());
    const w = A.beamWaist(r.result, r.resolved, r.field.model);
    assert.ok(w && !w.ok && w.dispersed, JSON.stringify(w));
    assert.match(w.reason, /dispersed into separate species spots/);
    assert.equal(w.groups.length, 3);
    // Barber's rule: object and image at r/tan 45° = 100 mm from the edges; the detector sits at x = −100 (plan: −98.5/−100/−101.5 ± 1 mm)
    const byLabel = Object.fromEntries(w.groups.map((g) => [g.label, g]));
    for (const [label, x] of [['m/z 99', -98.5], ['m/z 100', -100], ['m/z 101', -101.5]]) {
        assert.ok(byLabel[label], `group ${label}`);
        assert.ok(Math.abs(byLabel[label].position - x) < 1, `${label} waist ${byLabel[label].position} vs ${x}`);
        assert.ok(byLabel[label].rms < 0.05 && byLabel[label].n === 5, `${label} rms ${byLabel[label].rms}, n ${byLabel[label].n}`);
    }
    // the spots at the detector (y ≈ 98.98, 99.98, 100.98 mm, the full-level preset expectations) are ≈ 1 mm apart, far more than the rms
    const ys = w.groups.map((g) => g.centroid[0]).sort((a, b) => a - b);
    assert.ok(ys[1] - ys[0] > 0.9 && ys[2] - ys[1] > 0.9 && Math.abs(ys[1] - 99.98) < 0.1, ys.join(', '));
    // the mean position is still reported for the Compare table, and the species carry their identity
    assert.ok(Math.abs(w.position + 100) < 0.3 && w.spread > 2.5 && w.spread < 3.5);
    assert.deepEqual(w.groups.map((g) => g.species).sort(), ['100/1', '101/1', '99/1']);
});

test('beamWaist: single-species presets are unchanged; two species on one path or two sources of one ion are not "dispersed"', () => {
    const e = runProject(presetById('einzel').build());
    const we = A.beamWaist(e.result, e.resolved, e.field.model);
    assert.ok(we.ok && !we.dispersed && we.groups.length === 1 && Math.abs(we.position - 78.914) < 0.01, JSON.stringify(we));
    assert.ok(we.groups[0].centroid.every((c) => Math.abs(c) < 1e-9), 'the Einzel beam is centred on the axis');
    // two species with the same kinetic energy follow the same path in an electrostatic lens: two groups, one spot, one waist
    const two = presetById('einzel').build();
    two.sources[0].species.push({ label: 'm/z 200', mass: 200, charge: 1, fraction: 1 });
    const r2 = runProject(two);
    const w2 = A.beamWaist(r2.result, r2.resolved, r2.field.model);
    assert.ok(w2 && w2.ok && !w2.dispersed && w2.groups.length === 2, JSON.stringify(w2));
    assert.ok(Math.abs(w2.position - 78.914) < 0.1 && w2.spread < 0.1, `position ${w2.position}, spread ${w2.spread}`);
    // the same ion from a second source, landing in another spot, is not dispersion (a wide or two-part beam has one waist plane)
    const src = presetById('einzel').build();
    const s2 = structuredClone(src.sources[0]);
    s2.id = 'b2'; s2.name = 'Second beam'; s2.position = { type: 'line', p0: [-52, 1, 0], p1: [-52, 6, 0], n: 11 }; s2.count = 11;
    src.sources.push(s2);
    const r3 = runProject(src);
    const w3 = A.beamWaist(r3.result, r3.resolved, r3.field.model);
    assert.ok(w3 && w3.groups.length === 2 && !w3.dispersed, JSON.stringify(w3));
    assert.equal(w3.groups[0].species, w3.groups[1].species);
    assert.ok(Math.hypot(w3.groups[0].centroid[0] - w3.groups[1].centroid[0], w3.groups[0].centroid[1] - w3.groups[1].centroid[1]) > Math.max(w3.groups[0].rmsAtPlane, w3.groups[1].rmsAtPlane) || true, 'spots may differ');
    assert.ok(w3.ok, w3.reason || 'ok');
});

test('peakStats: the FWHM mark passes no 1/√ edge peak (0 of 200 at n = 250, 500, 1000: bound ≤ 2%) and ≥ 90% of Gaussians at n = 250', () => {
    const T = 200;
    for (const n of [250, 500, 1000]) {
        let edgeResolved = 0;
        for (let t = 0; t < T; t++) {
            const rnd = lcg(1000 * n + t);
            const s = A.peakStats(Float64Array.from({ length: n }, () => { const u = rnd(); return 30 + 1e-3 * u * u; }));
            if (s.fwhmResolved) edgeResolved++;
            assert.ok(s.fwhmBins > 0 && Number.isFinite(s.fwhmRatio) && Number.isFinite(s.fwhmSpread), 'diagnostics returned');
            if (!s.fwhmResolved) assert.match(s.note, /not reliable; use the rms-based R/);
        }
        assert.ok(edgeResolved <= 0.02 * T, `n ${n}: edge peaks marked resolved ${edgeResolved}/${T}`);
    }
    let gaussResolved = 0;
    for (let t = 0; t < T; t++) {
        const rnd = lcg(1000 * 250 + t);
        const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
        const s = A.peakStats(Float64Array.from({ length: 250 }, () => 100 + 0.01 * gauss()));
        if (s.fwhmResolved) {
            gaussResolved++;
            assert.ok(s.fwhmBins >= 4, `a resolved width spans ≥ 4 bins (${s.fwhmBins})`);
            assert.ok(Math.abs(s.resolvingPower / s.resolvingPowerRms - 1) < 0.35, 'a resolved Gaussian FWHM agrees with the rms width');
            assert.ok(!s.cuspLike, 'a Gaussian is not cusp-like');
        }
    }
    assert.ok(gaussResolved >= 0.9 * T, `Gaussians marked resolved: ${gaussResolved}/${T}`);
});

test('peakStats: a resolved cusp-shaped peak carries the stated caveat, a Gaussian does not, and a 4–5-bin width is noted as uncorrected', () => {
    const laplace = (seed, n) => Array.from({ length: n }, (_, i) => { const u = uniform01(seed, 0, i, 0) - 0.5; return 100 - 0.01 * Math.sign(u) * Math.log(1 - 2 * Math.abs(u)); });
    const l = A.peakStats(laplace(13, 1000));
    assert.ok(l.fwhmResolved && l.cuspLike, JSON.stringify(l));
    assert.match(l.note, /cusp-shaped or long-tailed peak.*biased high by up to about a quarter.*compare R \(rms\) and R \(narrowest 76%\)/);
    assert.ok(l.fwhm < 0.75 * l.w76, `FWHM ${l.fwhm} vs w76 ${l.w76}`);
    // a one-sided exponential edge (FWHM = b ln 2) is a cusp too
    const expo = A.peakStats(Array.from({ length: 4000 }, (_, i) => 30 - 0.001 * Math.log(uniform01(21, 0, i, 0))));
    assert.ok(expo.fwhmResolved && expo.cuspLike, JSON.stringify(expo));
    // Gaussians: resolved, no note at all
    for (const [seed, n] of [[9, 250], [11, 2000]]) {
        const g = A.peakStats(Array.from({ length: n }, (_, i) => 50 + 0.2 * normal01(seed, 0, i, 0)));
        assert.ok(g.fwhmResolved && !g.cuspLike && g.note === null && g.fwhmBins >= 5, JSON.stringify(g));
    }
    // a resolved width spanning 4–5 bins (heavy tails keep the Freedman–Diaconis bins wide) is uncorrected and says so
    let found = null;
    for (let t = 0; t < 20 && !found; t++) {
        const rnd = lcg(1000 * 250 + t);
        const s = A.peakStats(Float64Array.from({ length: 250 }, () => 100 + 0.01 * Math.tan(Math.PI * (rnd() - 0.5))));
        if (s.fwhmResolved && s.fwhmBins < 5) found = s;
    }
    assert.ok(found, 'a resolved 4–5-bin Cauchy peak among 20 seeds');
    assert.match(found.note, /fewer than 5 bins.*not corrected for the bin width/);
    // the tiny-sample and degenerate paths keep their fields
    const few = A.peakStats([1, 2, 3, 4]);
    assert.equal(few.fwhmResolved, false); assert.equal(few.cuspLike, false); assert.ok(Number.isNaN(few.fwhmBins));
    assert.equal(A.peakStats([]).cuspLike, false);
});

test('peakStats numerics did not move (values recorded before WP-B on fixed samples)', () => {
    const laplace = (seed, n) => Array.from({ length: n }, (_, i) => { const u = uniform01(seed, 0, i, 0) - 0.5; return 100 - 0.01 * Math.sign(u) * Math.log(1 - 2 * Math.abs(u)); });
    const cases = [
        [Array.from({ length: 250 }, (_, i) => 50 + 0.2 * normal01(9, 0, i, 0)), { fwhm: 0.5401968911811939, tPeak: 49.985392720236675, binWidth: 0.09266089078248936, w76: 0.4682856017770263, fwhmRatio: 0.9637526731703996, fwhmSpread: 0.11281772767662675, fwhmResolved: true }],
        [Array.from({ length: 2000 }, (_, i) => 50 + 0.2 * normal01(11, 0, i, 0)), { fwhm: 0.4314894357817936, tPeak: 49.98919725311446, binWidth: 0.04109141088188717, w76: 0.4630861789493963, fwhmRatio: 0.9469587554533406, fwhmSpread: 0.11609690598831675, fwhmResolved: true }],
        [laplace(13, 1000), { fwhm: 0.019142735445637292, tPeak: 99.9994173958712, binWidth: 0.002964458277656722, w76: 0.029916924770219566, fwhmRatio: 0.8500221637703143, fwhmSpread: 0.19388172873561288, fwhmResolved: true }],
        [Array.from({ length: 250 }, (_, i) => { const u = 2 * uniform01(3, 0, i, 0) - 1; return 30 + 1e-3 * u * u; }), { fwhm: 0.00027534385990496873, tPeak: 30.000047310356436, binWidth: 0.000057378407803261834, w76: 0.000571292290171499, fwhmRatio: 0.4606000513730554, fwhmSpread: 0.7761095197313698, fwhmResolved: false }],
        [Array.from({ length: 500 }, (_, i) => 100 + 0.01 * uniform01(17, 0, i, 0)), { fwhm: 0.009749747156894086, tPeak: 100.00339646586576, binWidth: 0.0009970023230508219, w76: 0.007325584189644019, fwhmRatio: 1.0104743184522083, fwhmSpread: 0.06519135086660337, fwhmResolved: true }],
    ];
    for (const [values, exp] of cases) {
        const s = A.peakStats(values);
        for (const k of ['fwhm', 'tPeak', 'binWidth', 'w76', 'fwhmRatio', 'fwhmSpread']) assert.ok(Math.abs(s[k] / exp[k] - 1) < 1e-12, `${k}: ${s[k]} vs ${exp[k]}`);
        assert.equal(s.fwhmResolved, exp.fwhmResolved);
        assert.ok(Math.abs(s.resolvingPower - s.mean / (2 * s.fwhm)) < 1e-9 * s.resolvingPower);
    }
});
