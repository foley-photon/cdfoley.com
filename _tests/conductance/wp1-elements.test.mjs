// WP1 element registry, validation, compilation, merging and descriptions (spec 2.6, 3.2, 3.3, 3.5.1-3.5.2;
// acceptance 7.2.8: field-specific messages for every rule).
// Run: node --test "_tests/conductance/wp1-elements.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import * as EL from '../../beta/conductance/js/engine/elements.js';
import { gasState, GAS_IDS } from '../../beta/conductance/js/engine/gas.js';
import * as M from '../../beta/conductance/js/engine/molecular.js';

const N2 = gasState('N2', 293.15), AIR = gasState('air', 293.15);
const PI = Math.PI;
const rel = (a, b) => Math.abs(a / b - 1);
const fields = (errs) => errs.map((e) => e.field);
const msg = (errs) => errs.map((e) => e.message).join(' | ');
const model = (items, bc = { mode: 'pump', p0: 1e-4 }, gas = { id: 'N2', T: 293.15, custom: null }) => ({ items, gas, Cd: null, bc, range: { pMin: 1e-6, pMax: 1.2e5 } });
const pump = (S = 0.05, d = 0.05) => ({ t: 'pump', S, d, label: 'Turbo' });

test('ELEMENT_TYPES is the registry of spec 2.6 (labels, tokens, fields, defaults) and is frozen', () => {
    const want = {
        tube: ['Round tube', 'tube', ['d', 'L']], orifice: ['Thin orifice (plate)', 'orif', ['shape', 'd', 'w', 'h']],
        slit: ['Slit (narrow gap)', 'slit', ['h', 'w', 'L']], rect: ['Rectangular duct', 'rect', ['a', 'b', 'L']],
        annulus: ['Annulus (tube with a rod)', 'ann', ['di', 'do', 'L']], cone: ['Cone or reducer', 'cone', ['d1', 'd2', 'L']],
        elbow: ['90° elbow (mitered)', 'elbow', ['d', 'A', 'B']], bbox: ['Black box (datasheet conductance)', 'bbox', ['C', 'gasRef', 'd', 'label']],
        chamber: ['Chamber (large volume)', 'chamber', []], parallel: ['Parallel branches', 'par', []], pump: ['Pump', 'pump', ['S', 'd', 'label']],
    };
    assert.deepEqual(Object.keys(EL.ELEMENT_TYPES), Object.keys(want));
    for (const [t, [label, token, keys]] of Object.entries(want)) {
        const def = EL.ELEMENT_TYPES[t];
        assert.equal(def.label, label);
        assert.equal(def.token, token);
        assert.deepEqual(def.fields.map((f) => f.key), keys);
        for (const f of def.fields) {
            assert.ok(['number', 'select', 'text'].includes(f.kind));
            if (f.kind === 'number') assert.ok(['length', 'speed'].includes(f.dim) && typeof f.label === 'string');
            if (f.kind === 'text') assert.equal(f.maxLength, 40);
        }
    }
    assert.deepEqual(EL.ELEMENT_TYPES.orifice.fields[1].when, { shape: 'circle' });
    assert.deepEqual(EL.ELEMENT_TYPES.orifice.fields[2].when, { shape: 'rect' });
    assert.deepEqual([...EL.ELEMENT_TYPES.bbox.fields[1].options], [...GAS_IDS]);
    assert.deepEqual(EL.ELEMENT_TYPES.pump.defaults, { S: 0.08, d: 0.063, label: 'Turbo' });
    assert.ok(Object.isFrozen(EL.ELEMENT_TYPES.parallel.defaults.branches[0][0]));
});

test('defaultItem returns an independent copy with t and the defaults', () => {
    const a = EL.defaultItem('parallel'), b = EL.defaultItem('parallel');
    assert.deepEqual(a, { t: 'parallel', branches: [[{ t: 'tube', d: 0.016, L: 0.1 }], [{ t: 'tube', d: 0.016, L: 0.2 }]] });
    a.branches[0][0].d = 1;
    assert.equal(b.branches[0][0].d, 0.016);
    assert.deepEqual(EL.defaultItem('orifice'), { t: 'orifice', shape: 'circle', d: 0.01, w: 0.02, h: 0.002 });
    for (const t of Object.keys(EL.ELEMENT_TYPES)) assert.deepEqual(EL.validateItem(EL.defaultItem(t), { G: N2, where: 'top', isLast: t === 'pump' }), [], t);
    assert.throws(() => EL.defaultItem('valve'), RangeError);
});

test('validateItem: every number field must be a positive number, with a field-specific message', () => {
    for (const [t, def] of Object.entries(EL.ELEMENT_TYPES)) {
        for (const f of def.fields.filter((x) => x.kind === 'number')) {
            for (const bad of [0, -1, NaN, Infinity, '3', null, undefined]) {
                const item = { ...EL.defaultItem(t), [f.key]: bad };
                if (f.when) Object.assign(item, f.when);
                const errs = EL.validateItem(item, { G: N2, where: 'top', isLast: true });
                assert.ok(errs.some((e) => e.field === f.key && e.message === `${f.label} must be a positive number.`), `${t}.${f.key} = ${bad}: ${msg(errs)}`);
            }
        }
    }
    // only the fields of the chosen orifice shape are checked
    assert.deepEqual(EL.validateItem({ t: 'orifice', shape: 'circle', d: 0.01 }, {}), []);
    assert.deepEqual(EL.validateItem({ t: 'orifice', shape: 'rect', w: 0.01, h: 0.001 }, {}), []);
    assert.deepEqual(fields(EL.validateItem({ t: 'orifice', shape: 'rect', d: 0.01 }, {})), ['w', 'h']);
});

test('validateItem: selects, text, unknown types and the type-specific rules', () => {
    const v = (item, ctx = { G: N2, where: 'top', isLast: false }) => EL.validateItem(item, ctx);
    assert.deepEqual(fields(v({ t: 'orifice', shape: 'oval', d: 0.01 })), ['shape']);
    assert.deepEqual(fields(v({ t: 'bbox', C: 0.01, gasRef: 'Xe', d: 0.04, label: 'V' })), ['gasRef']);
    assert.deepEqual(fields(v({ t: 'bbox', C: 0.01, gasRef: 'N2', d: 0.04, label: 'x'.repeat(41) })), ['label']);
    assert.deepEqual(fields(v({ t: 'bbox', C: 0.01, gasRef: 'N2', d: 0.04 })), []);
    assert.deepEqual(v({ t: 'valve' }), [{ field: 't', message: 'Unknown element type.' }]);
    assert.deepEqual(v(null), [{ field: 't', message: 'Unknown element type.' }]);
    // annulus rod thinner than the bore
    assert.deepEqual(v({ t: 'annulus', di: 0.04, do: 0.04, L: 0.1 }), [{ field: 'di', message: 'The rod must be thinner than the bore.' }]);
    // cone: flat step
    assert.deepEqual(v({ t: 'cone', d1: 0.04, d2: 0.1, L: 0.0005 }), [{ field: 'L', message: 'This is a flat step, not a cone: use a thin orifice or a chamber.' }]);
    assert.deepEqual(v({ t: 'cone', d1: 0.04, d2: 0.1, L: 0.001 }), []);
    // elbow legs at least the bore radius, formatted by fmtLen
    assert.deepEqual(v({ t: 'elbow', d: 0.025, A: 0.01, B: 0.0125 }), [{ field: 'A', message: 'Each elbow leg must be at least the bore radius (12.5 mm).' }]);
    assert.deepEqual(fields(v({ t: 'elbow', d: 0.025, A: 0.01, B: 0.01 })), ['A', 'B']);
    assert.match(msg(EL.validateItem({ t: 'elbow', d: 0.0254, A: 0.001, B: 0.1 }, { fmtLen: (m) => `${(m / 0.0254).toFixed(2)} in` })), /\(0\.50 in\)/);
    // black box at or above the orifice limit of its bore
    const lim = PI * 0.04 * 0.04 / 4 * N2.vbar / 4;
    assert.deepEqual(fields(v({ t: 'bbox', C: lim * 0.9989, gasRef: 'N2', d: 0.04 })), []);
    const big = v({ t: 'bbox', C: lim, gasRef: 'N2', d: 0.04 });
    assert.deepEqual(fields(big), ['C']);
    assert.match(big[0].message, /^The datasheet conductance is at or above the orifice limit for this bore \(\d+(\.\d+)? L\/s\); check the value or the bore\.$/);
    // parallel group structure
    const tube = { t: 'tube', d: 0.01, L: 0.1 };
    assert.deepEqual(v({ t: 'parallel', branches: [[tube]] }), [{ field: 'branches', message: 'A parallel group needs 2 to 4 branches.' }]);
    assert.deepEqual(fields(v({ t: 'parallel', branches: [[tube], [tube], [tube], [tube], [tube]] })), ['branches']);
    assert.deepEqual(v({ t: 'parallel', branches: [[tube], []] }), [{ field: 'branches', message: 'Each branch needs 1 to 6 elements.' }]);
    assert.deepEqual(fields(v({ t: 'parallel', branches: [[tube], Array(7).fill(tube)] })), ['branches']);
    assert.deepEqual(v({ t: 'parallel', branches: [[tube], [tube, tube, tube, tube, tube, tube]] }), []);
    // branches hold only geometric items and black boxes
    for (const t of ['chamber', 'pump', 'parallel']) {
        assert.deepEqual(EL.validateItem(EL.defaultItem(t), { where: 'branch', isLast: true }), [{ field: null, message: 'Branches may not contain chambers, pumps or parallel groups.' }]);
    }
    for (const t of ['tube', 'orifice', 'slit', 'rect', 'annulus', 'cone', 'elbow', 'bbox']) assert.deepEqual(EL.validateItem(EL.defaultItem(t), { where: 'branch' }), []);
    // pump: last element, below the molecular orifice limit
    assert.deepEqual(v(pump()), [{ field: null, message: 'The pump must be the last element.' }]);
    assert.deepEqual(v(pump(), { G: N2, isLast: true }), []);
    const plim = PI * 0.05 * 0.05 / 4 * N2.vbar / 4;
    const fast = v({ t: 'pump', S: plim, d: 0.05 }, { G: N2, isLast: true });
    assert.deepEqual(fields(fast), ['S']);
    assert.match(fast[0].message, /^Pumping speed exceeds the molecular-flow maximum for this inlet bore: S ≤ [\d.]+ L\/s\.$/);
    assert.deepEqual(v({ t: 'pump', S: plim, d: 0.05 }, { isLast: true }), [], 'without a gas the speed limit is not checked');
});

test('validateModel covers the structural rules of spec 3.5.1 with paths and fields', () => {
    const tube = { t: 'tube', d: 0.05, L: 0.1 };
    const has = (m, path, field, re) => {
        const errs = EL.validateModel(m);
        assert.ok(errs.some((e) => e.path === path && e.field === field && re.test(e.message)), `expected ${path}/${field} ${re}: ${JSON.stringify(errs)}`);
    };
    assert.deepEqual(EL.validateModel(model([tube, pump()])), []);
    has(model([pump(), tube]), '0', null, /^The pump must be the last element\.$/);
    has(model([tube, pump(), pump()]), '1', null, /^The pump must be the last element\.$/);
    has(model([tube]), '', 'items', /^Add a pump as the last element\.$/);
    has(model([tube, pump()], { mode: 'dp', p0: 10, p1: 1 }), '1', null, /^A pump can only be used in chamber-to-pump mode\.$/);
    has(model([tube], { mode: 'dp', p0: 10, p1: 10 }), 'bc', 'p1', /^The outlet pressure must be below the inlet pressure\.$/);
    has(model([tube], { mode: 'dp', p0: 10, p1: 20 }), 'bc', 'p1', /^The outlet pressure must be below the inlet pressure\.$/);
    has(model([{ t: 'chamber' }], { mode: 'dp', p0: 10, p1: 1 }), '', 'items', /^Add at least one element between the two pressures\.$/);
    has(model([...Array(40).fill(tube), pump()]), '', 'items', /^A line can have at most 40 elements\.$/);
    assert.deepEqual(EL.validateModel(model([...Array(39).fill(tube), pump()])), []);
    has(model([tube, pump()], { mode: 'pump', p0: 1e-11 }), 'bc', 'p0', /between 1e-10 Pa and 1e7 Pa/);
    has(model([tube, pump()], { mode: 'pump', p0: 2e7 }), 'bc', 'p0', /between 1e-10 Pa and 1e7 Pa/);
    has(model([tube], { mode: 'dp', p0: 10, p1: 1e-11 }), 'bc', 'p1', /between 1e-10 Pa and 1e7 Pa/);
    has(model([tube, pump()], { mode: 'vent', p0: 1 }), 'bc', 'mode', /^Choose /);
    has(model([tube, pump(5)]), '1', 'S', /^Pumping speed exceeds the molecular-flow maximum/);
    has(model([tube, pump()], undefined, { id: 'N2', T: 10, custom: null }), 'gas', 'T', /temperature/);
    has(model([tube, pump()], undefined, { id: 'custom', T: 300, custom: { M: 0.03, eta20: 1e-5, omega: 0.7, gamma: 2, Cd: 0.8 } }), 'gas', 'gamma', /γ/);
    has({ ...model([tube, pump()]), Cd: 1.5 }, 'gas', 'Cd', /discharge coefficient/);
    has({ ...model([tube, pump()]), range: { pMin: 1e3, pMax: 1 } }, 'range', 'pMin', /plot range/);
    has(model([{ t: 'parallel', branches: [[tube], [tube, { t: 'chamber' }]] }, pump()]), '0.1.1', null, /^Branches may not contain/);
    has(model([{ t: 'parallel', branches: [[tube], [{ t: 'tube', d: -1, L: 1 }]] }, pump()]), '0.1.0', 'd', /^Inner diameter must be a positive number\.$/);
    has(model([tube, { t: 'elbow', d: 0.05, A: 0.01, B: 0.1 }, pump()]), '1', 'A', /bore radius \(25 mm\)/);
    assert.deepEqual(EL.validateModel(null), [{ path: '', field: 'items', message: 'The model has no element list.' }]);
    assert.deepEqual(EL.validateModel({ items: 'tube' }), [{ path: '', field: 'items', message: 'The model has no element list.' }]);
    for (const e of EL.validateModel(model([pump(), { t: 'cone', d1: 1, d2: 2, L: 1e-6 }], { mode: 'dp', p0: 1, p1: 2 }))) {
        assert.ok(/^[A-Z].*\.$/.test(e.message), `not a sentence: ${e.message}`);
    }
});

test('compileItem: areas, radii, laminar coefficients, reference lengths and molecular data for every type', () => {
    const t = EL.compileItem({ t: 'tube', d: 0.04, L: 0.2 }, N2);
    assert.ok(rel(t.Ain, PI * 0.02 ** 2) < 1e-15 && t.Aout === t.Ain && t.reIn === 0.02 && t.rref === 0.02 && t.Dh === 0.04 && t.length === 0.2);
    assert.ok(rel(t.kv, PI * 0.02 ** 4 / (8 * N2.eta * 0.2)) < 1e-15);
    assert.equal(t.alpha, M.tubeAlpha(5));
    assert.ok(rel(t.Cmol, t.Ain * N2.vbar / 4 * t.alpha) < 1e-15);
    assert.ok(rel(t.Cm, t.Ain * N2.vbar / 4 * t.alpha / (1 - t.alpha)) < 1e-15);
    assert.ok(rel(t.s, N2.eta * N2.vm / 0.02) < 1e-15);
    assert.equal(t.accuracy, 0.001);
    assert.equal(t.aperture, false);
    assert.equal(t.noEffect, false);
    assert.equal(t.mergedFrom, null);
    const o = EL.compileItem({ t: 'orifice', shape: 'rect', w: 0.02, h: 0.002 }, N2);
    assert.ok(o.aperture && o.alpha === 1 && rel(o.Ain, 4e-5) < 1e-15 && rel(o.reIn, 0.02 * 0.002 / 0.022) < 1e-15 && o.length === 0 && o.accuracy === 0);
    assert.equal(o.kv, null);
    const sq = EL.compileItem({ t: 'rect', a: 0.01, b: 0.01, L: 0.1 }, N2);
    assert.ok(rel(sq.kv * N2.eta * 0.1 / 0.01 ** 4, 0.0351443) < 2e-6, 'square duct constant');
    const sl = EL.compileItem({ t: 'slit', h: 0.0005, w: 0.02, L: 0.01 }, N2), rr = EL.compileItem({ t: 'rect', a: 0.02, b: 0.0005, L: 0.01 }, N2);
    assert.ok(rel(sl.kv, rr.kv) < 1e-15 && sl.alpha === rr.alpha && rel(sl.rref, 0.0005 * 0.02 / 0.0205) < 1e-15);
    assert.ok(rel(sl.kv, 0.02 * 0.0005 ** 3 / (12 * N2.eta * 0.01) * (1 - 0.630 * 0.0005 / 0.02)) < 1e-3, 'wide-slot limit');
    const an = EL.compileItem({ t: 'annulus', di: 0.01, do: 0.04, L: 0.1 }, N2), k = 0.25;
    assert.ok(rel(an.kv, PI * 0.02 ** 4 / (8 * N2.eta * 0.1) * (1 - k ** 4 - (1 - k * k) ** 2 / Math.log(1 / k))) < 1e-15);
    assert.ok(rel(an.rref, 0.015) < 1e-15 && rel(an.Dh, 0.03) < 1e-15 && an.accuracy === 0.005);
    const co = EL.compileItem({ t: 'cone', d1: 0.063, d2: 0.04, L: 0.05 }, N2);
    const R1 = 0.0315, R2 = 0.02, kk = (R2 - R1) / 0.05;
    assert.ok(rel(co.kv, PI / (8 * N2.eta) / ((1 / (3 * kk)) * (1 / R1 ** 3 - 1 / R2 ** 3))) < 1e-14);
    assert.ok(rel(co.rref, Math.cbrt(0.05 / ((1 / (2 * kk)) * (1 / R1 ** 2 - 1 / R2 ** 2)))) < 1e-14);
    assert.ok(co.Ain > co.Aout && rel(co.Amin, PI * R2 * R2) < 1e-15 && co.alpha === M.coneAlpha(R1, R2, 0.05));
    const flat = EL.compileItem({ t: 'cone', d1: 0.04, d2: 0.04, L: 0.2 }, N2);
    assert.ok(rel(flat.kv, t.kv) < 1e-12 && rel(flat.rref, 0.02) < 1e-12 && flat.alpha === t.alpha);
    const el = EL.compileItem({ t: 'elbow', d: 0.1, A: 0.3, B: 0.1 }, N2);
    assert.ok(Math.abs(el.alpha - 0.21781) < 5e-6 && el.length === 0.4 && rel(el.kv, PI * 0.05 ** 4 / (8 * N2.eta * 0.4)) < 1e-15);
    assert.deepEqual(EL.compileItem({ t: 'elbow', d: 0.02, A: 0.01, B: 1.2 }, N2).flags, ['extrapolated']);
});

test('compileItem: black box becomes an equivalent tube (spec 3.2.7, Appendix B preset 4: L_eq 35.7 mm)', () => {
    const bb = EL.compileItem({ t: 'bbox', C: 0.08, gasRef: 'N2', d: 0.04, label: 'Gate_valve' }, N2);
    assert.ok(Math.abs(bb.Leq * 1e3 - 35.7) < 0.05, `L_eq ${bb.Leq}`);
    assert.ok(rel(bb.Cmol, 0.08) < 1e-12, 'molecular conductance exact by construction');
    assert.equal(bb.length, bb.Leq);
    assert.deepEqual(bb.flags, ['viscous-estimate']);
    assert.deepEqual(bb.notes, ['equivalent-tube']);
    assert.equal(bb.label, 'Gate_valve');
    assert.equal(bb.accuracy, 0);
    // datasheet value for N2 at 293.15 K, scaled by vbar to another gas and temperature
    const He = gasState('He', 350), bbHe = EL.compileItem({ t: 'bbox', C: 0.08, gasRef: 'N2', d: 0.04 }, He);
    assert.ok(rel(bbHe.Cmol, 0.08 * He.vbar / N2.vbar) < 1e-12);
    assert.ok(rel(bbHe.Leq, bb.Leq) < 1e-12, 'the equivalent length does not depend on the gas');
    assert.throws(() => EL.compileItem({ t: 'bbox', C: 1, gasRef: 'N2', d: 0.04 }, N2), /orifice limit for this bore/);
});

test('compileItem refuses non-geometric and invalid items with a RangeError sentence', () => {
    for (const it of [{ t: 'chamber' }, EL.defaultItem('pump'), EL.defaultItem('parallel'), { t: 'tube', d: 0.01, L: 0 }, { t: 'elbow', d: 0.1, A: 0.01, B: 0.1 }]) {
        assert.throws(() => EL.compileItem(it, N2), (e) => e instanceof RangeError && /\.$/.test(e.message));
    }
});

test('mergeItems merges same-section runs and reports the merged paths (spec 3.5.2)', () => {
    const tube = (d, L) => ({ t: 'tube', d, L }), elbow = (d, A, B) => ({ t: 'elbow', d, A, B });
    assert.deepEqual(EL.mergeItems([tube(0.1, 0.2), tube(0.1, 0.3)]), [{ item: tube(0.1, 0.5), paths: [0, 1] }]);
    assert.deepEqual(EL.mergeItems([tube(0.1, 0.2), elbow(0.1, 0.1, 0.1)]), [{ item: elbow(0.1, 0.30000000000000004, 0.1), paths: [0, 1] }]);
    assert.deepEqual(EL.mergeItems([elbow(0.1, 0.1, 0.1), tube(0.1, 0.2)]), [{ item: elbow(0.1, 0.1, 0.30000000000000004), paths: [0, 1] }]);
    const m = EL.mergeItems([tube(1, 0.5), elbow(1, 0.5, 0.5), tube(1, 0.5)]);
    assert.deepEqual(m, [{ item: elbow(1, 1, 1), paths: [0, 1, 2] }]);
    assert.ok(Math.abs(M.elbowAlpha(0.5, 1, 1) - 0.35134) < 5e-6, 'spec example: elbow(2R, 2R) alpha 0.35134');
    assert.deepEqual(EL.mergeItems([{ t: 'rect', a: 0.01, b: 0.03, L: 0.1 }, { t: 'rect', a: 0.03, b: 0.01, L: 0.2 }]).map((x) => x.paths), [[0, 1]]);
    assert.deepEqual(EL.mergeItems([{ t: 'slit', h: 1e-4, w: 0.05, L: 0.01 }, { t: 'slit', h: 1e-4, w: 0.05, L: 0.02 }])[0].item.L, 0.03);
    assert.deepEqual(EL.mergeItems([{ t: 'annulus', di: 0.01, do: 0.04, L: 0.1 }, { t: 'annulus', di: 0.01, do: 0.04, L: 0.1 }]).length, 1);
    // not merged
    for (const items of [[elbow(0.1, 0.1, 0.1), elbow(0.1, 0.1, 0.1)], [tube(0.1, 0.1), tube(0.1000001, 0.1)], [tube(0.1, 0.1), { t: 'chamber' }, tube(0.1, 0.1)],
        [tube(0.1, 0.1), { t: 'cone', d1: 0.1, d2: 0.1, L: 0.1 }], [{ t: 'rect', a: 0.01, b: 0.03, L: 0.1 }, { t: 'slit', h: 0.01, w: 0.03, L: 0.1 }],
        [tube(0.1, 0.1), { t: 'orifice', shape: 'circle', d: 0.1 }, tube(0.1, 0.1)]]) {
        assert.equal(EL.mergeItems(items).length, items.length, JSON.stringify(items));
    }
    // equal to 1e-9 relative counts as the same section
    assert.equal(EL.mergeItems([tube(0.1, 0.1), tube(0.1 * (1 + 5e-10), 0.1)]).length, 1);
    const input = [tube(0.1, 0.2), tube(0.1, 0.3)];
    EL.mergeItems(input);
    assert.deepEqual(input, [tube(0.1, 0.2), tube(0.1, 0.3)], 'inputs are not modified');
});

test('describeItem gives short summaries with the unit once', () => {
    assert.equal(EL.describeItem({ t: 'tube', d: 0.04, L: 0.2 }), 'Tube Ø40 × 200 mm');
    assert.equal(EL.describeItem({ t: 'elbow', d: 0.1, A: 0.3, B: 0.1 }), 'Elbow Ø100, legs 300/100 mm');
    assert.equal(EL.describeItem({ t: 'orifice', shape: 'circle', d: 0.001 }), 'Orifice Ø1 mm');
    assert.equal(EL.describeItem({ t: 'orifice', shape: 'rect', w: 0.02, h: 0.002 }), 'Orifice 20 × 2 mm');
    assert.equal(EL.describeItem({ t: 'slit', h: 0.0001, w: 0.05, L: 0.01 }), 'Slit 0.1 × 50, depth 10 mm');
    assert.equal(EL.describeItem({ t: 'rect', a: 0.01, b: 0.03, L: 0.1 }), 'Duct 10 × 30 × 100 mm');
    assert.equal(EL.describeItem({ t: 'annulus', di: 0.01, do: 0.04, L: 0.1 }), 'Annulus Ø40/Ø10 × 100 mm');
    assert.equal(EL.describeItem({ t: 'cone', d1: 0.04, d2: 0.063, L: 0.05 }), 'Cone Ø40 → Ø63 × 50 mm');
    assert.equal(EL.describeItem({ t: 'bbox', C: 0.08, gasRef: 'N2', d: 0.04, label: 'Gate_valve' }), 'Gate valve: 80 L/s (N2), Ø40 mm');
    assert.equal(EL.describeItem({ t: 'pump', S: 0.3, d: 0.1, label: 'Turbo' }), 'Turbo: 300 L/s, inlet Ø100 mm');
    assert.equal(EL.describeItem({ t: 'chamber' }), 'Chamber');
    assert.equal(EL.describeItem(EL.defaultItem('parallel')), 'Parallel group, 2 branches');
    const inch = (m) => `${(m / 0.0254).toFixed(2)} in`;
    assert.equal(EL.describeItem({ t: 'tube', d: 0.0254, L: 0.254 }, inch), 'Tube Ø1.00 × 10.00 in');
    const mixed = (m) => (m < 0.1 ? `${m * 1000} mm` : `${m} m`);
    assert.equal(EL.describeItem({ t: 'tube', d: 0.04, L: 2 }, mixed), 'Tube Ø40 mm × 2 m');
    assert.equal(EL.describeItem({ t: 'tube', d: 0.04, L: 0.2 }, (m) => `${m * 1000} mm`), 'Tube Ø40 × 200 mm');
});
