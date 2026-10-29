// Round-2 integration: the cross-package wiring the integration lead applied (handoffs of WP-D, WP-E, WP-F, WP-G):
// weighted counts in summarize and the weighted histograms, grouped-blur classes of a frozen list, the optional
// schema keys (space-charge pair step, view stretch and relief), the Methods text of the plug-ins and the engine version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../beta/ion-optics/js/engine/schema.js';
import { summarize } from '../../beta/ion-optics/js/engine/analysis.js';
import { runProject } from '../../beta/ion-optics/js/engine/pipeline.js';
import { frozenSource } from '../../beta/ion-optics/js/engine/particles.js';
import { classIndex, groupedBlurMetric, planeSample } from '../../beta/ion-optics/js/engine/optimize.js';
import { ENGINE_VERSION } from '../../beta/ion-optics/js/engine/version.js';
import { sampleWeights, tofPeaks, methodsText } from '../../beta/ion-optics/js/ui/analysis-jobs.js';
import { displayHistogram } from '../../beta/ion-optics/js/ui/plots.js';
import { presetById } from '../../beta/ion-optics/js/presets/index.js';
import { einzel } from './fixtures/wp3/projects.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));

test('engine version 0.2.1 (round 2 fixes), and the help page shows it', async () => {
    assert.equal(ENGINE_VERSION, '0.2.1');
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../../beta/ion-optics/help/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes(`<span data-engine-version>${ENGINE_VERSION}</span>`));
});

test('summarize carries the weighted counts; sampleWeights and the weighted histograms follow the source weights', () => {
    const p = einzel();
    const r1 = runProject(p);
    const s1 = summarize(r1.result, r1.resolved);
    assert.ok(s1.weighted && s1.weighted.launched === s1.launched && s1.weighted.transmission === s1.transmission.overall, 'weight 1: weighted = counts');
    const k = r1.resolved.recording.planes.findIndex((q) => q.terminate);
    assert.equal(sampleWeights(r1.result, r1.resolved, planeSample(r1.result, r1.resolved, k).ids), null, 'no weights → plain counts');
    assert.equal(tofPeaks(r1.result, r1.resolved, k).weighted, false);
    const q = clone(p); q.sources[0].weight = 2.5;
    const r2 = runProject(q);
    const s2 = summarize(r2.result, r2.resolved);
    assert.equal(s2.weighted.launched, 2.5 * s2.launched);
    const ids = planeSample(r2.result, r2.resolved, k).ids;
    const w = sampleWeights(r2.result, r2.resolved, ids);
    assert.ok(w && w.length === ids.length && w.every((x) => x === 2.5));
    const t = tofPeaks(r2.result, r2.resolved, k);
    assert.equal(t.weighted, true);
    const total = t.hist.reduce((a, hh) => a + hh.counts.reduce((b, c) => b + c, 0), 0);
    assert.equal(total, 2.5 * t.n, 'TOF bars count Σw');
    const hh = displayHistogram([1, 2, 3, NaN, 4], 'x (mm)', { weights: [1, 2, 3, 100, 4] });
    assert.equal(hh.counts.reduce((a, b) => a + b, 0), 10, 'non-finite values drop with their weights');
});

test('a frozen grid source keeps its grouped blur: classes from the distinct directions and energies of the list', () => {
    const p = presetById('vmi').build();
    const r = runProject(p);
    const k = r.resolved.recording.planes.findIndex((q) => q.terminate);
    const b0 = groupedBlurMetric(r.result, r.resolved, k);
    const q = clone(p);
    q.sources = r.resolved.sources.map((s) => frozenSource(s, { relativistic: r.resolved.tracer.relativistic !== false }));
    const r2 = runProject(q);
    assert.ok(r2.resolved.sources.every((s) => s.type === 'rows'));
    assert.ok(Number.isFinite(b0) && b0 > 0);
    assert.equal(groupedBlurMetric(r2.result, r2.resolved, k), b0, 'the same groups, so the same blur');
    // a random source frozen to a list keeps one group (no repeated directions)
    const e = einzel(); e.sources[0] = { ...e.sources[0], sampling: 'random', count: 12, seed: 3 };
    const re = S.resolve(e).resolved;
    const f = clone(e); f.sources = re.sources.map((s) => frozenSource(s));
    const cls = classIndex(S.resolve(f).resolved);
    assert.ok([...cls.values()].every(([a, b]) => a === -1 && b === -1));
});

test('schema: optional space-charge pair step, the ion-diameter help, view stretch and relief', () => {
    const p = einzel();
    p.tracer.spaceCharge = { ...S.defaults('spaceCharge'), pairStep: 0.01 };
    let r = S.resolve(p);
    assert.deepEqual(r.errors, []);
    assert.equal(r.resolved.tracer.spaceCharge.pairStep, 0.01);
    p.tracer.spaceCharge.pairStep = null;
    r = S.resolve(p);
    assert.ok(!('pairStep' in r.resolved.tracer.spaceCharge), 'empty: the accuracy preset decides');
    p.tracer.spaceCharge.pairStep = 0.9;
    assert.ok(S.validate(p).errors.some((e) => e.path === 'tracer.spaceCharge.pairStep'));
    assert.ok(S.META.spaceCharge.some((f) => f.key === 'pairStep'));
    assert.match(S.META.gas.find((f) => f.key === 'ionDiameter').help, /1 g\/cm³/);
    const v = einzel(); v.view = { ...v.view, aspect: 8, relief: 2 };
    r = S.resolve(v);
    assert.deepEqual(r.errors, []);
    assert.equal(r.resolved.view.aspect, 8); assert.equal(r.resolved.view.relief, 2);
    assert.ok(S.META.view.some((f) => f.key === 'aspect') && S.META.view.some((f) => f.key === 'relief'));
});

test('Methods text names the plug-ins, the Poisson term, anti-mirror planes and particle lists', () => {
    const p = einzel();
    p.tracer.spaceCharge = S.defaults('spaceCharge');
    p.tracer.gas = S.defaults('gas');
    p.tracer.drag = { mobility: 2, gasVelocity: [0, 0, 0] };
    p.domain.charge = '1e-6';
    const r = S.resolve(p);
    assert.deepEqual(r.errors, []);
    const t = methodsText({ resolved: r.resolved }, { bench: null });
    for (const s of ['space-charge onset estimator', 'Hard-sphere collisions', 'Stokes drag', 'Poisson term']) assert.ok(t.includes(s), s);
    const base = methodsText({ resolved: S.resolve(einzel()).resolved }, { bench: null });
    for (const s of ['onset estimator', 'Hard-sphere', 'Stokes', 'Poisson', 'anti-mirrored']) assert.ok(!base.includes(s), `plain project: no "${s}"`);
    const q = einzel(); q.sources = S.resolve(q).resolved.sources.map((s) => frozenSource(s));
    q.sources[0].weight = 2;
    assert.match(methodsText({ resolved: S.resolve(q).resolved }, { bench: null }), /a list of 21 particles of m\/z 100 \(100 u, \+1 e\), weight 2\./);
});
