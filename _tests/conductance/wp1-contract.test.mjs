// WP1 contract (spec 2.1-2.8, 5.4.3, 7.2 M1): every WP1 export exists with its documented arity and returns
// structurally valid results on a minimal input; the engine files stay pure (H7, H8, H13).
// Run: node --test "_tests/conductance/wp1-contract.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as GAS from '../../beta/conductance/js/engine/gas.js';
import * as INTERP from '../../beta/conductance/js/engine/interp.js';
import * as TABLES from '../../beta/conductance/js/engine/tables.js';
import * as MOL from '../../beta/conductance/js/engine/molecular.js';
import * as FLOW from '../../beta/conductance/js/engine/flow.js';
import * as EL from '../../beta/conductance/js/engine/elements.js';
import * as NET from '../../beta/conductance/js/engine/network.js';
import * as VAL from '../../beta/conductance/js/engine/validation.js';
import * as VF from '../../beta/conductance/js/engine/validation-formulas.js';

const ENGINE = new URL('../../beta/conductance/js/engine/', import.meta.url);
const WP1_FILES = ['gas.js', 'interp.js', 'tables.js', 'molecular.js', 'flow.js', 'elements.js', 'network.js', 'validation.js', 'validation-formulas.js'];

const FUNCTIONS = [
    [GAS, 'gasState', 2], [GAS, 'meanFreePath', 2], [GAS, 'rarefaction', 3], [GAS, 'orificeC', 2], [GAS, 'temperatureWarning', 1], [GAS, 'waterSaturation', 1],
    [INTERP, 'pchipSlopes', 2], [INTERP, 'makePchip', 2], [INTERP, 'findInterval', 2], [INTERP, 'fitTail3', 2], [INTERP, 'makeQTable', 1], [INTERP, 'makeKappaCone', 1],
    [MOL, 'tubeAlpha', 1], [MOL, 'tubeAlphaInverse', 1], [MOL, 'slotAlpha', 1], [MOL, 'rectAlpha', 3], [MOL, 'annulusAlpha', 3], [MOL, 'coneDivAlpha', 2],
    [MOL, 'coneAlpha', 3], [MOL, 'elbowAlpha', 3], [MOL, 'bermanSlotAlpha', 1], [MOL, 'bermanAnnulusAlpha', 3], [MOL, 'molecularInfo', 2],
    [FLOW, 'Z', 1], [FLOW, 'IZ', 1], [FLOW, 'GP', 1], [FLOW, 'nearFmA', 1], [FLOW, 'gOrifice', 2], [FLOW, 'psi', 2], [FLOW, 'rStar', 1],
    [FLOW, 'coreChokeP', 3], [FLOW, 'edgeFlow', 4], [FLOW, 'edgeDerivs', 4], [FLOW, 'edgeLimit', 4], [FLOW, 'edgeG', 3], [FLOW, 'pumpSc', 3],
    [EL, 'defaultItem', 1], [EL, 'validateItem', 2], [EL, 'validateModel', 1], [EL, 'compileItem', 2], [EL, 'mergeItems', 1], [EL, 'describeItem', 2],
    [NET, 'buildNetwork', 2], [NET, 'linearSolve', 4], [NET, 'solveAt', 3], [NET, 'analyze', 1], [NET, 'sweep', 2], [NET, 'molecularLimit', 2], [NET, 'errorBand', 2],
    [VAL, 'evaluate', 2], [VAL, 'runCases', 4], [VAL, 'summarize', 1],
];

test('every documented WP1 function exists with its arity', () => {
    for (const [mod, name, arity] of FUNCTIONS) {
        assert.equal(typeof mod[name], 'function', `${name} is not exported`);
        assert.equal(mod[name].length, arity, `${name}.length`);
    }
});

test('documented constants and tables are exported', () => {
    assert.equal(GAS.R_GAS, 8.314462618);
    assert.equal(GAS.T_REF, 293.15);
    assert.deepEqual([...GAS.GAS_IDS], ['N2', 'air', 'He', 'H2', 'Ar', 'H2O', 'CO2']);
    assert.deepEqual(Object.keys(GAS.GASES), [...GAS.GAS_IDS]);
    for (const g of Object.values(GAS.GASES)) assert.deepEqual(Object.keys(g).sort(), ['Cd', 'M', 'assumedCd', 'eta20', 'gamma', 'name', 'omega']);
    for (const k of ['COLS_L', 'TUBE_IE', 'SLOT', 'RECT', 'ANNULUS', 'CONE', 'ELBOW', 'GP_SHARIPOV', 'ORIFICE_A', 'FACETING', 'CLAUSING_PROFILE_LR20', 'TABLE_SOURCES']) {
        assert.ok(TABLES[k] && typeof TABLES[k] === 'object', `tables.js lacks ${k}`);
        assert.ok(Object.isFrozen(TABLES[k]), `${k} is not frozen`);
    }
    assert.ok(EL.ELEMENT_TYPES && Object.isFrozen(EL.ELEMENT_TYPES));
    assert.ok(Array.isArray(VF.FORMULA_CASES) && VF.FORMULA_CASES.length > 0);
});

test('GasState, interpolators and molecular functions return the documented shapes', () => {
    const G = GAS.gasState('N2', 293.15);
    assert.deepEqual(Object.keys(G), ['id', 'name', 'M', 'T', 'Rs', 'eta', 'vbar', 'vm', 'c', 'gamma', 'Cd']);
    assert.ok(INTERP.pchipSlopes([0, 1, 2], [0, 1, 4]) instanceof Float64Array);
    assert.equal(typeof INTERP.makePchip([0, 1], [0, 1]), 'function');
    assert.equal(INTERP.findInterval([0, 1, 2, 3], 1.5), 1);
    assert.equal(typeof INTERP.fitTail3([20, 50, 100], [1, 1.1, 1.2]), 'function');
    const qt = INTERP.makeQTable({ rows: TABLES.RECT.rows, cols: TABLES.COLS_L, alpha: TABLES.RECT.alpha });
    assert.equal(typeof qt(0.5, 2), 'number');
    const kc = INTERP.makeKappaCone({ rows: TABLES.CONE.rows, cols: TABLES.COLS_L, alpha: TABLES.CONE.alpha, tubeAlpha: MOL.tubeAlpha });
    assert.equal(typeof kc(10, 2), 'number');
    for (const v of [MOL.tubeAlpha(2), MOL.slotAlpha(2), MOL.rectAlpha(1, 2, 3), MOL.annulusAlpha(0.5, 1, 1), MOL.coneDivAlpha(10, 2),
        MOL.coneAlpha(1, 2, 3), MOL.elbowAlpha(1, 2, 3), MOL.bermanSlotAlpha(2), MOL.bermanAnnulusAlpha(0.5, 1, 1)]) {
        assert.ok(v > 0 && v <= 1);
    }
    assert.ok(MOL.tubeAlphaInverse(0.5) > 0);
    assert.deepEqual(Object.keys(MOL.molecularInfo('tube', { d: 0.04, L: 0.2 })), ['accuracy', 'source', 'extrapolated']);
});

test('flow functions, edges and the network return the documented shapes', () => {
    const G = GAS.gasState('N2', 293.15);
    const net = NET.buildNetwork([{ t: 'tube', d: 0.04, L: 0.2 }, { t: 'pump', S: 0.05, d: 0.04, label: 'Turbo' }], G);
    assert.deepEqual(Object.keys(net).slice(0, 6), ['nodes', 'edges', 'elems', 'pump', 'last', 'junctions']);
    assert.deepEqual(Object.keys(net.pump), ['S', 'A', 're', 'attached', 'prevAout']);
    const [orif, core] = net.edges;
    assert.deepEqual(Object.keys(orif), ['k', 'a', 'b', 'Ato', 'reTo', 'Afrom', 'reFrom', 'el']);
    assert.deepEqual(Object.keys(core), ['k', 'a', 'b', 'kv', 'Cm', 's', 'Aout', 'el']);
    for (const k of ['t', 'label', 'path', 'Ain', 'Aout', 'reIn', 'reOut', 'aperture', 'alpha', 'Cmol', 'kv', 'Cm', 's', 'rref', 'Dh', 'Amin',
        'length', 'accuracy', 'mergedFrom', 'noEffect', 'flags', 'notes']) assert.ok(k in net.elems[0], `Compiled lacks ${k}`);
    const d = FLOW.edgeDerivs(core, 2, 1, G);
    assert.equal(d.length, 3);
    assert.ok(['none', 'inertial', 'choked', 'choked-exit'].includes(FLOW.edgeLimit(orif, 2, 1, G)));
    assert.ok(FLOW.edgeG(core, 1, G) > 0 && FLOW.pumpSc(net.pump, 1, G) > 0 && FLOW.coreChokeP(core, 1e5, G) > 0);
    const p = NET.linearSolve(net, net.edges.map((e) => FLOW.edgeG(e, 1e-9, G)), 0, new Map([[0, 1], [net.last, 0]]));
    assert.ok(p instanceof Float64Array && p.length === net.nodes.length);
    const s = NET.solveAt(net, G, { mode: 'pump', p0: 1 });
    assert.ok(s.p instanceof Float64Array && typeof s.converged === 'boolean' && Number.isInteger(s.iterations));
    const ml = NET.molecularLimit([{ t: 'tube', d: 0.04, L: 0.2 }, { t: 'pump', S: 0.05, d: 0.04 }], G);
    assert.deepEqual(Object.keys(ml), ['Cline', 'Seff', 'pMol', 'pLine']);
    assert.deepEqual(Object.keys(NET.errorBand(net, true)), ['lo', 'hi', 'junctions', 'note']);
});

const MODEL = {
    items: [{ t: 'tube', d: 0.1, L: 0.2 }, { t: 'elbow', d: 0.1, A: 0.1, B: 0.1 }, { t: 'pump', S: 0.3, d: 0.1, label: 'Turbo' }],
    gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'pump', p0: 1e-4 }, range: { pMin: 1e-6, pMax: 1.2e5 },
};

test('analyze returns the full AnalysisResult shape (spec 2.7, Appendix C)', () => {
    const r = NET.analyze(MODEL);
    assert.deepEqual(Object.keys(r), ['ok', 'errors', 'warnings', 'gas', 'bc', 'Q', 'Seff', 'Cline', 'pN', 'mol', 'regime', 'converged',
        'iterations', 'elements', 'pump', 'shareMol']);
    assert.deepEqual(Object.keys(r.mol), ['Cline', 'Seff', 'band']);
    assert.deepEqual(Object.keys(r.mol.band), ['lo', 'hi', 'junctions', 'note']);
    assert.deepEqual(Object.keys(r.elements[0]), ['path', 't', 'label', 'describe', 'alpha', 'Cmol', 'Cop', 'dp', 'share', 'pIn', 'pOut', 'pMean',
        'Kn', 'Re', 'Ma', 'regime', 'limit', 'accuracy', 'flags', 'notes', 'mergedFrom', 'Leq']);
    assert.deepEqual(Object.keys(r.pump), ['S', 'Sc', 'pIn', 'share', 'shareMol', 'fraction']);
    assert.equal(r.shareMol.length, r.elements.length);
    const bad = NET.analyze({ ...MODEL, bc: { mode: 'pump', p0: -1 } });
    assert.deepEqual(Object.keys(bad), ['ok', 'errors', 'warnings']);
    assert.equal(bad.ok, false);
    assert.deepEqual(Object.keys(bad.errors[0]), ['path', 'field', 'message']);
});

test('sweep returns the SweepResult shape for every kind', () => {
    for (const kind of ['Seff', 'C']) {
        const s = NET.sweep(MODEL, kind, { n: 5 });
        assert.deepEqual(Object.keys(s), ['kind', 'x', 'y', 'ymol', 'regime', 'converged', 'knMarks']);
        assert.ok(s.x instanceof Float64Array && s.y instanceof Float64Array && s.converged instanceof Uint8Array);
        assert.equal(s.regime.length, 5);
        assert.deepEqual(Object.keys(s.knMarks), ['kn05', 'kn001']);
    }
    const dp = NET.sweep({ ...MODEL, items: [{ t: 'tube', d: 0.01, L: 0.1 }], bc: { mode: 'dp', p0: 10, p1: 1 } }, 'dp', { n: 3 });
    assert.equal(dp.kind, 'dp');
});

test('element registry helpers return the documented shapes', () => {
    assert.deepEqual(EL.defaultItem('tube'), { t: 'tube', d: 0.04, L: 0.2 });
    assert.deepEqual(EL.validateItem(EL.defaultItem('tube'), { G: GAS.gasState('N2', 293.15), where: 'top', isLast: false }), []);
    assert.deepEqual(EL.validateModel(MODEL), []);
    assert.deepEqual(EL.mergeItems([{ t: 'tube', d: 1, L: 1 }]), [{ item: { t: 'tube', d: 1, L: 1 }, paths: [0] }]);
    assert.equal(typeof EL.describeItem(EL.defaultItem('cone')), 'string');
});

test('validation runner returns Rows and summaries (spec 2.8)', async () => {
    const cases = VF.FORMULA_CASES.slice(0, 5);
    for (const c of VF.FORMULA_CASES) {
        for (const k of ['id', 'group', 'title', 'source', 'ref', 'refSigma', 'tol', 'quick', 'run']) assert.ok(k in c, `${c.id} lacks ${k}`);
        assert.ok(['formula', 'negative'].includes(c.group));
    }
    const seen = [];
    const rows = await VAL.runCases(cases, { mc: null }, (row) => seen.push(row.id), undefined);
    assert.deepEqual(seen, cases.map((c) => c.id));
    for (const k of ['id', 'group', 'title', 'source', 'ref', 'value', 'sigma', 'dev', 'devText', 'tolText', 'pass', 'caught', 'ms']) assert.ok(k in rows[0], `Row lacks ${k}`);
    const s = VAL.summarize(rows);
    assert.deepEqual(Object.keys(s), ['formula', 'mc', 'negative']);
    assert.deepEqual(s.formula, [5, 5]);
});

test('engine files are pure ES modules: relative .js imports, no DOM, no console (H7, H8, H13)', () => {
    for (const f of WP1_FILES) {
        const src = readFileSync(new URL(f, ENGINE), 'utf8');
        const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
            assert.ok(m[1].startsWith('./') && m[1].endsWith('.js'), `${f}: import "${m[1]}" is not a relative .js specifier`);
        }
        assert.ok(!/\bimport\s*\(/.test(code), `${f}: dynamic import`);
        for (const word of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'Calc', 'Plot', 'console', 'require']) {
            assert.ok(!new RegExp(`\\b${word}\\b`).test(code), `${f} mentions ${word}`);
        }
        assert.ok(!/\bexport\s+default\b/.test(code), `${f}: default export`);
    }
});
