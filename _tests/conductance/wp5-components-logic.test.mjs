// WP5: pure helpers of the Components tab (spec 4.2, 7.6 acceptance 4).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PRESETS, presetModel, insertItem, removeItem, moveItem, duplicateItem, addBranch, removeBranch, addToBranch, setBoundary,
    canMove, canRemove, canDuplicate, flagSentence, checksFor, FLAG_INFO, bandBadge, compareText, mcStatusLine, elementsCSV,
    noteWords, controllingIndex, parsePath, MAX_TOP,
} from '../../beta/conductance/js/ui/components-ui.js';
import { analyze } from '../../beta/conductance/js/engine/network.js';
import { validateModel } from '../../beta/conductance/js/engine/elements.js';
import { setCalc } from '../../beta/conductance/js/ui/format.js';

setCalc(null);   // the built-in Calc.fmt.num rules
const tube = (d = 0.04, L = 0.2) => ({ t: 'tube', d, L });
const pump = { t: 'pump', S: 0.08, d: 0.063, label: 'Turbo' };
const near = (a, b, tol) => Math.abs(a / b - 1) <= tol;

test('presets apply and reproduce Appendix B', () => {
    assert.equal(PRESETS.length, 7);
    assert.deepEqual(PRESETS.map((p) => p.label), ['Turbo on a DN100 line', 'Livesey p. 100', 'Roughing line (KF25)', 'Beamline: valve and reducer',
        'Differential aperture', 'Slit seal at atmosphere', 'Parallel branches']);
    const want = [   // S_eff or C (L/s), from Appendix B; tolerance 1e-4 against the 5-digit table
        { Seff: 138.46, Cline: 201.17, molSeff: 138.53 }, { Seff: 187.95, Cline: 323.92 }, { Seff: 8.1326, Cline: 48.93 },
        // v2.2: the slit seal is 0.6 % lower (0.6251 L/s, Q 61.88 before the plane-channel cap of slot-like cores)
        { Seff: 21.431, Cline: 27.109 }, { Cline: 0.10063, Q: 1.0053e-3 }, { Cline: 0.62109, Q: 61.487 }, { Seff: 6.1651, Cline: 7.0322 },
    ];
    PRESETS.forEach((p, k) => {
        const m = presetModel(k);
        assert.deepEqual(validateModel(m), [], p.label);
        assert.equal(m.gas.T, 293.15);
        assert.equal(m.Cd, null);
        assert.deepEqual(m.range, { pMin: 1e-6, pMax: 1.2e5 });
        const a = analyze(m), w = want[k];
        assert.ok(a.ok, p.label);
        if (w.Seff) assert.ok(near(a.Seff * 1000, w.Seff, 2e-4), `${p.label} Seff ${a.Seff * 1000}`);
        if (w.Cline) assert.ok(near(a.Cline * 1000, w.Cline, 2e-4), `${p.label} Cline ${a.Cline * 1000}`);
        if (w.Q) assert.ok(near(a.Q, w.Q, 2e-4), `${p.label} Q ${a.Q}`);
        if (w.molSeff) assert.ok(near(a.mol.Seff * 1000, w.molSeff, 2e-4));
    });
    // preset models are fresh copies
    const a = presetModel(0), b = presetModel(0);
    a.items[0].d = 1;
    assert.equal(b.items[0].d, 0.1);
});

test('card add, remove, move and duplicate keep the pump last', () => {
    let items = [tube(), pump];
    items = insertItem(items, 'elbow');
    assert.deepEqual(items.map((x) => x.t), ['tube', 'elbow', 'pump']);
    assert.equal(insertItem(items, 'pump'), items, 'no second pump from the menu');
    assert.equal(canMove(items, '1', 1), false, 'nothing moves below the pump');
    assert.equal(canMove(items, '2', -1), false, 'the pump does not move');
    assert.equal(canRemove(items, '2'), false);
    assert.equal(canDuplicate(items, '2'), false);
    assert.deepEqual(moveItem(items, '1', -1).map((x) => x.t), ['elbow', 'tube', 'pump']);
    assert.equal(moveItem(items, '1', 1), items);
    assert.deepEqual(duplicateItem(items, '0').map((x) => x.t), ['tube', 'tube', 'elbow', 'pump']);
    assert.deepEqual(removeItem(items, '0').map((x) => x.t), ['elbow', 'pump']);
    assert.equal(removeItem(items, '2'), items);
    // inputs are never mutated
    const snap = JSON.stringify(items);
    moveItem(items, '1', -1); duplicateItem(items, '0'); removeItem(items, '1'); insertItem(items, 'cone');
    assert.equal(JSON.stringify(items), snap);
    // without a pump, insertion appends
    assert.deepEqual(insertItem([tube()], 'orifice').map((x) => x.t), ['tube', 'orifice']);
    // the 40-item limit
    let many = [pump];
    for (let k = 0; k < 45; k++) many = insertItem(many, 'tube');
    assert.equal(many.length, MAX_TOP);
    assert.equal(many[many.length - 1].t, 'pump');
    assert.equal(canDuplicate(many, '0'), false);
});

test('parallel groups keep the branch rules', () => {
    let items = insertItem([pump], 'parallel');
    assert.equal(items[0].branches.length, 2);
    assert.equal(canRemove(items, '0.0.0'), false, 'the last element of a branch cannot be removed');
    assert.equal(removeBranch(items, 0, 0), items, 'at least 2 branches');
    items = addBranch(addBranch(items, 0), 0);
    assert.equal(items[0].branches.length, 4);
    assert.equal(addBranch(items, 0), items, 'at most 4 branches');
    items = removeBranch(items, 0, 3);
    assert.equal(items[0].branches.length, 3);
    for (const t of ['chamber', 'parallel', 'pump']) assert.equal(addToBranch(items, 0, 0, t), items, t);
    for (let k = 0; k < 8; k++) items = addToBranch(items, 0, 1, 'cone');
    assert.equal(items[0].branches[1].length, 6, 'at most 6 elements per branch');
    assert.equal(canDuplicate(items, '0.1.0'), false);
    assert.equal(canMove(items, '0.1.0', -1), false);
    assert.ok(canMove(items, '0.1.0', 1));
    const moved = moveItem(items, '0.1.0', 1);
    assert.equal(moved[0].branches[1][0].t, 'cone');
    assert.equal(moved[0].branches[1][1].t, 'tube');
    assert.ok(canRemove(items, '0.1.2'));
    assert.equal(removeItem(items, '0.1.2')[0].branches[1].length, 5);
    assert.deepEqual(parsePath('4.1.2'), { i: 4, b: 1, j: 2 });
    assert.deepEqual(parsePath('3'), { i: 3 });
    assert.deepEqual(validateModel({ ...presetModel(0), items }), []);
});

test('switching the boundary removes and restores the pump', () => {
    const items = [tube(), pump];
    const d = setBoundary(items, { mode: 'pump', p0: 10 }, 'dp');
    assert.deepEqual(d.items.map((x) => x.t), ['tube']);
    assert.deepEqual(d.bc, { mode: 'dp', p0: 10, p1: 0.01 });
    assert.deepEqual(d.memo, pump);
    const back = setBoundary(d.items, d.bc, 'pump', d.memo);
    assert.deepEqual(back.items, items);
    assert.deepEqual(back.bc, { mode: 'pump', p0: 10 });
    const fresh = setBoundary([tube()], { mode: 'dp', p0: 1, p1: 0.1 }, 'pump', null);
    assert.equal(fresh.items[1].t, 'pump');
    assert.equal(setBoundary(items, { mode: 'pump', p0: 1 }, 'pump').items, items);
});

test('every flag code of §4.2.4 maps to its sentence and level', () => {
    const want = {
        turbulent: ['warn', 'Turbulent in element 3 (Re = 2500): the laminar model overestimates the conductance.'],
        compressible: ['warn', 'Mach 0.87 at the outlet of element 3: compressibility reduces accuracy.'],
        choked: ['warn', 'Choked at the entrance of element 3: the flow is set by the upstream pressure, C_d and the area.'],
        'choked-exit': ['warn', 'Flow chokes at the outlet of element 3 (isothermal limit): the downstream pressure no longer matters.'],
        inertial: ['warn', 'Entrance loss of element 3 is dominated by inertia (Bernoulli), set by C_d.'],
        extrapolated: ['warn', 'Element 3 is outside the validated table range; accuracy about ±1 %.'],
        'short-element': ['warn', 'Element 3 is short (L < D_h) in viscous flow: entrance effects make this ±20 %.'],
        'viscous-estimate': ['ok', 'Black box 3 is modeled as an equivalent tube outside molecular flow.'],
        merged: ['ok', 'Elements 3 and 4 have the same bore and were combined into one for accuracy.'],
        'no-effect': ['ok', 'Orifice 3 is at least as large as the bore before it and has no effect.'],
        'water-condenses': ['bad', 'Water vapor above its saturation pressure (23.4 mbar at this temperature) would condense.'],
        'temperature-range': ['warn', 'The gas data are fitted near room temperature; outside 200 to 600 K the viscosity is extrapolated.'],
        transitional: ['ok', 'Transitional flow in element 3 (Kn = 0.042): accuracy ±3 % for long tubes, ±10 % otherwise.'],
        'partial-overlap': ['warn', 'The opening of element 3 only partly overlaps the one before it, so part of the gas meets a wall face. The formula treats this roughly and can be tens of percent high; use Verify by Monte Carlo.'],
        'pump-wider': ['warn', 'The pump inlet is wider than the outlet of the line. The result assumes the gas spreads over the whole pump inlet, as on the speed test dome; a line that ends right at the pump flange gets less. Add the adapter or the pump throat as an element for a closer value.'],
        'pump-rod': ['warn', 'The rod of element 3 ends at the pump inlet, so its end face shades part of the inlet. The result assumes the gas spreads over the whole pump inlet, as on the speed test dome. Add a short tube of the pump bore after the annulus for a closer value and to verify this line by Monte Carlo.'],
    };
    assert.deepEqual(Object.keys(FLAG_INFO).sort(), Object.keys(want).sort());
    for (const [code, [level, text]] of Object.entries(want)) {
        const c = flagSentence(code, { n: '3', merged: ['3', '4'], Re: 2500.4, Ma: 0.8671, Kn: 0.042, pSat: '23.4 mbar' });
        assert.equal(c.level, level, code);
        assert.equal(c.text, text, code);
        assert.ok(c.title.length > 3);
    }
    assert.equal(flagSentence('merged', { n: '1', merged: ['1', '2', '3'] }).text, 'Elements 1, 2 and 3 have the same bore and were combined into one for accuracy.');
    assert.equal(flagSentence('nonsense', {}), null);
});

test('checks come from the analysis, worst first', () => {
    const slit = analyze(presetModel(5));
    const c = checksFor(slit);
    assert.deepEqual(c.map((x) => x.code), ['inertial', 'choked-exit', 'compressible']);
    const water = analyze({ ...presetModel(5), gas: { id: 'H2O', T: 293.15, custom: null } });
    const cw = checksFor(water, { fmtP: (p) => (p / 100).toFixed(1) + ' mbar' });
    assert.equal(cw[0].code, 'water-condenses');
    assert.ok(cw[0].text.includes('(23.3 mbar at this temperature)'), cw[0].text);
    const hot = checksFor(analyze({ ...presetModel(0), gas: { id: 'N2', T: 700, custom: null } }));
    assert.ok(hot.some((x) => x.code === 'temperature-range'));
    const merged = checksFor(analyze(presetModel(6)));
    assert.equal(merged.find((x) => x.code === 'merged').text, 'Elements 2.2.1 and 2.2.2 have the same bore and were combined into one for accuracy.');
    const trans = checksFor(analyze({ ...presetModel(1), bc: { mode: 'pump', p0: 0.5 } }));
    assert.ok(trans.some((x) => x.code === 'transitional'), JSON.stringify(trans));
    assert.equal(checksFor(analyze(presetModel(1))).length, 0);
});

test('the band badge: within when the 95 % interval overlaps the band', () => {
    const band = { lo: -0.013, hi: 0.013 };
    const f = 138.53;
    let b = bandBadge({ value: 138.03, ci95: [137.72, 138.34] }, f, band);
    assert.ok(b.within);
    assert.equal(b.cls, 'badge badge-ok');
    assert.equal(b.text, 'Within the expected band (−1.3 % to +1.3 %)');
    assert.equal(b.note, '');
    assert.equal(compareText(b.diff), 'Monte Carlo is 0.36 % lower');
    b = bandBadge({ value: 145, ci95: [144.2, 145.8] }, f, band);
    assert.ok(!b.within);
    assert.equal(b.cls, 'badge badge-warn');
    assert.ok(b.text.startsWith('Outside the expected band'));
    assert.equal(b.note, 'The formula combines elements approximately. Trust the Monte Carlo value for this geometry.');
    // overlap at the edge counts; an exact result equal to the formula is within a zero-width band
    assert.ok(bandBadge({ value: 141, ci95: [140.33, 141.6] }, f, band).within);
    assert.ok(!bandBadge({ value: 141, ci95: [140.36, 141.6] }, f, band).within);
    assert.ok(bandBadge({ value: 0.092423, ci95: [0.092423, 0.092423] }, 0.0924230000000001, { lo: 0, hi: 0 }).within);
    // preset 4: MC 22.14 against 21.431 with the band −1.4 % … +8.4 %
    assert.ok(bandBadge({ value: 22.14, ci95: [22.08, 22.2] }, 21.431, { lo: -0.014, hi: 0.084 }).within);
    assert.equal(compareText(0.033), 'Monte Carlo is 3.3 % higher');
});

test('status line, CSV and table helpers', () => {
    assert.equal(mcStatusLine({ particles: 8e5, castsPerSec: 3.5e7, relHalfWidth: 0.016, etaSeconds: 0.6 }),
        '0.8 M particles · 35 M rays/s · ±1.6 % (95 %) · about 1 s left');
    assert.equal(mcStatusLine({ particles: 0 }), '0 M particles');
    const a = analyze(presetModel(0));
    const csv = elementsCSV(a).trim().split('\n');
    assert.equal(csv.length, 3);
    assert.ok(csv[0].startsWith('#,Element,alpha (molecular),C alone, molecular (m3/s)'.replace('C alone, molecular (m3/s)', '"C alone, molecular (m3/s)"')));
    assert.ok(csv[0].includes('(Pa)'));
    assert.ok(csv[1].startsWith('1,"Elbow Ø100, legs 300/100 mm",0.217814'), csv[1]);
    assert.ok(csv[2].startsWith('pump,'));
    assert.deepEqual(noteWords(a.elements[0]), ['merged']);
    assert.equal(controllingIndex(a), 0);
    assert.equal(controllingIndex({ elements: [] }), -1);
});

// ---- v2.2 fix round 1
test('band badge: the "trust the Monte Carlo value" advice only when the simulation itself simplifies nothing', () => {
    const band = { lo: -0.01, hi: 0.01 }, out = { value: 0.8, ci95: [0.79, 0.81] };
    assert.match(bandBadge(out, 1, band).note, /Trust the Monte Carlo value/);
    const b = bandBadge(out, 1, band, true);
    assert.equal(b.within, false);
    assert.ok(!/Trust/.test(b.note) && /exact for the simulated geometry/.test(b.note));
    assert.equal(bandBadge({ value: 1, ci95: [0.995, 1.005] }, 1, band, true).note, '');
});

test('pump row: no entrance-corrected speed in the C column; S_c goes to the notes; new flags have short words', () => {
    const a = analyze(presetModel(0)), csv = elementsCSV(a).trim().split('\n'), last = csv[csv.length - 1].split(',');
    assert.equal(last[0], 'pump');
    assert.equal(last[4], '', 'C here of the pump');
    assert.match(last[12], /^S_c = 0\.44\d+ m3\/s \(entrance-corrected\)$/);
    assert.deepEqual(noteWords({ flags: ['partial-overlap'], regime: 'molecular' }), ['partly blocked']);
    const w = analyze({ ...presetModel(0), items: [tube(0.04, 0.05), { t: 'pump', S: 0.3, d: 0.1, label: 'T' }] });
    assert.deepEqual(checksFor(w).map((c) => c.code), ['pump-wider']);
    // v2.3: an annulus of the pump's bore ending on the pump is reported as its rod, with the annulus's number
    const r = analyze({ ...presetModel(0), items: [tube(0.1, 0.1), { t: 'annulus', di: 0.01, do: 0.1, L: 0.2 }, { t: 'pump', S: 0.3, d: 0.1, label: 'T' }] });
    const rc = checksFor(r);
    assert.deepEqual(rc.map((c) => c.code), ['pump-rod']);
    assert.match(rc[0].text, /^The rod of element 2 ends at the pump inlet/);
});
