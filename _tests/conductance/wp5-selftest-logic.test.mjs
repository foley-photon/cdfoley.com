// WP5: Self-test helpers (spec 4.6, 7.6 acceptance 5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { casesFor, summaryLine, deviceLine, browserName, fileName, toCSV, toJSON, refText, valueText, verdict, CSV_HEAD, GROUPS, INTRO }
    from '../../beta/conductance/js/ui/selftest-ui.js';
import { FORMULA_CASES } from '../../beta/conductance/js/engine/validation-formulas.js';
import { MC_CASES } from '../../beta/conductance/js/engine/validation-mc.js';
import { runCases } from '../../beta/conductance/js/engine/validation.js';
import { setCalc } from '../../beta/conductance/js/ui/format.js';

setCalc(null);
const row = (o) => ({ id: 'x', group: 'formula', title: 'T', source: { label: 'S', url: 'https://example.org' }, ref: 1, refSigma: 0, unit: '',
    value: 1, sigma: 0, dev: 0, devText: '0 %', tolText: '±0.1 %', pass: true, caught: null, ms: 1.2, ...o });

test('case selection: formula, quick Monte Carlo and full; Node-only cases are skipped', () => {
    assert.equal(casesFor('formula', FORMULA_CASES, MC_CASES).length, FORMULA_CASES.length);
    const quick = casesFor('quick', FORMULA_CASES, MC_CASES);
    assert.ok(quick.length > 0 && quick.every((c) => c.quick && !c.nodeOnly && c.group !== 'formula'));
    assert.ok(quick.some((c) => c.id === 'mesh-elbow33') && quick.some((c) => c.id === 'neg-sampler-asin'));
    const full = casesFor('full', FORMULA_CASES, MC_CASES);
    assert.equal(full.length, FORMULA_CASES.length + MC_CASES.filter((c) => !c.nodeOnly).length);
    assert.ok(!full.some((c) => c.id === 'neg-leaky-mesh'));
    for (const c of full) assert.ok(GROUPS.some(([g]) => g === c.group), c.id);
    assert.ok(INTRO.startsWith('These checks compare this tool with published values (Matuda, JPCRD, Livesey, NASA TN D-2330, CERN-2007-003, Leybold)'));
});

test('summary counts from real formula rows', async () => {
    const rows = await runCases(FORMULA_CASES, {}, null);
    const nForm = rows.filter((r) => r.group === 'formula').length, nNeg = rows.filter((r) => r.group === 'negative').length;
    assert.equal(summaryLine(rows), `${nForm} of ${nForm} formula checks passed · negative controls caught ${nNeg} of ${nNeg}.`);
    const mixed = [row({ id: 'a' }), row({ id: 'b', pass: false }), row({ id: 'c', group: 'chain-mc', sigma: 0.001 }), row({ id: 'd', group: 'mesh-mc', pass: false }),
        row({ id: 'e', group: 'negative', caught: true, pass: true }), row({ id: 'f', group: 'negative', caught: false, pass: false }), row({ id: 'g', stopped: true })];
    assert.equal(summaryLine(mixed), '1 of 2 formula checks passed · 1 of 2 Monte Carlo checks passed · negative controls caught 1 of 2.');
    assert.equal(summaryLine([]), 'No checks have run yet.');
    assert.deepEqual(verdict(mixed[1]), { text: 'FAIL', cls: 'badge badge-bad' });
    assert.deepEqual(verdict(mixed[4]), { text: 'caught', cls: 'badge badge-ok' });
    assert.deepEqual(verdict(mixed[5]), { text: 'missed', cls: 'badge badge-bad' });
    assert.equal(verdict(mixed[6]).text, 'stopped');
});

test('value and reference texts', () => {
    assert.equal(refText(row({ ref: 0.26524, refSigma: 0.00021 })), '0.26524 (σ 0.00021)');
    assert.equal(refText(row({ ref: 188, unit: 'L/s' })), '188 L/s');
    assert.equal(valueText(row({ value: 0.191121, sigma: 0.00028 })), '0.1911 ± 0.0006');
    assert.equal(valueText(row({ value: 11.572777, unit: 'L/s' })), '11.5728 L/s');
    assert.equal(valueText(row({ value: NaN })), '—');
});

test('device line, browser names and the file name', () => {
    const d = new Date(2026, 9, 12, 14, 3);
    assert.equal(deviceLine({ workers: 8, browser: 'Microsoft Edge 141', date: d }), '8 workers · Microsoft Edge 141 · run 2026-10-12 14:03');
    assert.equal(deviceLine({ workers: 1, browser: 'Firefox 140', date: d }), '1 worker · Firefox 140 · run 2026-10-12 14:03');
    assert.equal(fileName(d), 'conductance-selftest-20261012.json');
    assert.equal(browserName('', [{ brand: 'Not=A?Brand', version: '24' }, { brand: 'Microsoft Edge', version: '141' }, { brand: 'Chromium', version: '141' }]), 'Microsoft Edge 141');
    assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'), 'Firefox 140');
    assert.equal(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15'), 'Safari 18');
    assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'), 'Microsoft Edge 141');
});

test('CSV and JSON export formats', async () => {
    const rows = (await runCases(FORMULA_CASES.slice(0, 3), {}, null)).concat([row({ id: 'q"x', title: 'A, "quoted" title', group: 'chain-mc', value: 0.5, sigma: 0.001 })]);
    const csv = toCSV(rows).trim().split('\n');
    assert.equal(csv[0], CSV_HEAD.join(','));
    assert.equal(csv.length, rows.length + 1);
    assert.ok(csv[1].startsWith('orifice-air,formula,'), csv[1]);
    assert.ok(csv[1].includes(',11.57,0,11.5727'), csv[1]);
    assert.ok(csv[1].endsWith(',PASS,0') || /,PASS,\d+$/.test(csv[1]), csv[1]);
    assert.ok(csv[4].startsWith('"q""x",chain-mc,"A, ""quoted"" title"'), csv[4]);
    const j = JSON.parse(toJSON(rows, '8 workers · Edge 141 · run 2026-10-12 14:03'));
    assert.equal(j.format, 'cdfoley-conductance-selftest');
    assert.equal(j.version, 1);
    assert.equal(j.device, '8 workers · Edge 141 · run 2026-10-12 14:03');
    assert.equal(j.rows.length, rows.length);
    assert.equal(j.summary, summaryLine(rows));
    for (const k of ['id', 'group', 'title', 'source', 'ref', 'refSigma', 'value', 'sigma', 'unit', 'dev', 'devText', 'tolText', 'pass', 'caught', 'result', 'ms']) assert.ok(k in j.rows[0], k);
    assert.equal(j.rows[0].result, 'PASS');
    const bad = JSON.parse(toJSON([row({ value: NaN, dev: NaN })], null));
    assert.equal(bad.rows[0].value, null);
});

// ---- v2.2 fix round 1: a stopped suite says so in the summary and in the JSON
test('summary and JSON of a stopped run name the checks that did not run', () => {
    const rows = [{ id: 'a', group: 'formula', pass: true }, { id: 'b', group: 'chain-mc', pass: true }, { id: 'c', group: 'chain-mc', stopped: true }];
    const stop = { done: 2, total: 9 };
    assert.equal(summaryLine(rows, stop), '1 of 1 formula checks passed · 1 of 1 Monte Carlo checks passed · stopped after 2 of 9 checks; the checks not listed did not run.');
    assert.equal(summaryLine(rows), '1 of 1 formula checks passed · 1 of 1 Monte Carlo checks passed.');
    const j = JSON.parse(toJSON(rows, 'device', stop));
    assert.deepEqual(j.stopped, stop);
    assert.match(j.summary, /stopped after 2 of 9/);
    assert.equal(JSON.parse(toJSON(rows, 'device')).stopped, null);
});
