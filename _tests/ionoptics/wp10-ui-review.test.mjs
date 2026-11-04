// Review fixes in the UI (round 10): species waists that lie apart are listed instead of their mean (Summary, canvas
// description, Compare); a waist that is not reported says why; per-species TOF with significant zeros; the default
// tuned variable is a voltage; share links carry no query string; a pending clipboard call times out; space charge
// alone does not skip the energy check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waistSplit, compareTable } from '../../beta/ion-optics/js/ui/analysis-jobs.js';
import { sigFig, noWaistText, energyUncheckedReason } from '../../beta/ion-optics/js/ui/panels/results.js';
import { pinSummary } from '../../beta/ion-optics/js/ui/panels/compare.js';
import { tuneDefaultIndex, variableOptions } from '../../beta/ion-optics/js/ui/panels/scan.js';
import * as P from '../../beta/ion-optics/js/ui/persist.js';
import { presetById } from '../../beta/ion-optics/js/presets/index.js';

const split = { ok: true, axis: 'x', position: 175.4, rms: 0.088, spread: 193, groups: [{ label: 'm/z 100', n: 21, position: 78.91, rms: 0.11 }, { label: 'e⁻', n: 21, position: 272, rms: 0.05 }] };
const together = { ok: true, axis: 'x', position: 78.9, rms: 0.1, spread: 0.02, groups: [{ label: 'a', n: 5, position: 78.89, rms: 0.1 }, { label: 'b', n: 5, position: 78.91, rms: 0.1 }] };

test('species waists further apart than the rms radius are split; one species or close waists are not', () => {
    assert.equal(waistSplit(split), true);
    assert.equal(waistSplit(together), false);
    assert.equal(waistSplit({ ...split, groups: split.groups.slice(0, 1) }), false);
    assert.equal(waistSplit({ ...split, ok: false }), false);
    assert.equal(waistSplit(null), false);
    // a pin stored before `spread` was kept: the spread follows from the groups
    const { spread, ...old } = split;
    assert.equal(waistSplit(old), true);
});

test('Compare: a split waist gives one row per species and no mean position', () => {
    const t = compareTable([{ metrics: { launched: 42, transmission: 1, waist: split, planes: [] } }, { metrics: { launched: 21, transmission: 1, waist: { ...together, groups: together.groups.slice(0, 1) }, planes: [] } }]);
    const row = (k) => t.rows[t.keys.indexOf(k)];
    assert.ok(Number.isNaN(row('waist:pos')[1]) && row('waist:pos')[2] === 78.9);
    assert.equal(row('waist:m/z 100:pos')[1], 78.91);
    assert.equal(row('waist:e⁻:pos')[1], 272);
    assert.match(pinSummary({ launched: 42, transmission: 1, waist: split, planes: [] }), /species waists at different positions/);
    assert.doesNotMatch(pinSummary({ launched: 42, transmission: 1, waist: split, planes: [] }), /175/);
});

test('Summary texts: the reason for a missing waist; significant zeros of times of flight', () => {
    assert.equal(noWaistText('the rays pass through a field between the plane and the waist'), 'No waist reported: the rays pass through a field between the plane and the waist. The Lens tab gives the asymptotic focus.');
    assert.match(noWaistText('parallel beam: the rms size hardly changes'), /^No waist reported: parallel beam/);
    assert.equal(sigFig(32), '32.000');
    assert.equal(sigFig(4.39123456), '4.3912');
    assert.equal(sigFig(0.0098031234), '0.0098031');
    assert.equal(sigFig(-2.5), '−2.5000');
    assert.equal(sigFig(NaN), '—');
});

test('energy check: space charge alone no longer counts as a reason it was skipped (engine 0.2.2 checks those runs)', () => {
    const sc = { tracer: { spaceCharge: { enabled: true } } };
    assert.match(energyUncheckedReason(sc), /outside the grid/);
    assert.doesNotMatch(energyUncheckedReason(sc), /space charge/);
    assert.match(energyUncheckedReason({ tracer: { drag: { enabled: true }, spaceCharge: { enabled: true } } }), /Stokes drag \(a physics plug-in is on\)/);
});

test('Scan & tune: the tuned variable defaults to the first voltage parameter (Einzel: Vc, not the geometry D)', () => {
    const p = presetById('einzel').build();
    assert.equal(variableOptions(p)[tuneDefaultIndex(p)].label, 'Parameter Vc');
    const q = presetById('einzel').build(); q.params = q.params.filter((x) => x.name !== 'Vc');
    assert.equal(variableOptions(q)[tuneDefaultIndex(q)].kind, 'electrode');
});

test('share links: origin and path only (no ?debug or tracking parameters)', async () => {
    P.configurePersist({ location: () => ({ hash: '', pathname: '/beta/ion-optics/', search: '?debug&utm_source=x', origin: 'https://example.test', href: 'https://example.test/beta/ion-optics/?debug&utm_source=x' }) });
    const link = await P.shareLink(presetById('einzel').build());
    assert.ok(link.url.startsWith('https://example.test/beta/ion-optics/#p='), link.url.slice(0, 60));
    P.configurePersist({ location: () => ({ origin: 'null', href: 'file:///x/index.html?debug#old' }) });
    assert.ok((await P.shareLink(presetById('einzel').build())).url.startsWith('file:///x/index.html#p='));
});

test('copyText: a clipboard call that never settles counts as failed after the timeout', async (t) => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: () => new Promise(() => {}) } }, configurable: true });
    t.after(() => { if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator; });
    const { copyText } = await import('../../beta/ion-optics/js/ui/dom.js');
    const t0 = performance.now();
    const ok = await copyText('x', { timeoutMs: 50 });
    assert.equal(ok, false);
    assert.ok(performance.now() - t0 < 1000);
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: () => Promise.resolve() } }, configurable: true });
    assert.equal(await copyText('x', { timeoutMs: 50 }), true);
});
