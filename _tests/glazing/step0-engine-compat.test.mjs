// V7, engine compatibility (glazing beta build spec, sections 3 and 5.3). The edits E1-E4 to
// assets/js/glazing-engine.js are additive: with the new arguments omitted, the committed engine gives results
// bitwise identical (Object.is) to the engine before the edits. The pre-edit engine is rebuilt from the
// committed file with revert(), never taken from a stored copy, so this test keeps working after the engine
// changes upstream (spec 3.4). Run: node --test "_tests/glazing/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, ROOT } from './helpers/load.mjs';
import { EDITS, apply, revert } from './helpers/engine-edits.mjs';

const WEIGHTS = 'assets/js/glazing-weights.js', ENGINE = 'assets/js/glazing-engine.js';
const committed = fs.readFileSync(path.join(ROOT, ENGINE), 'utf8').replace(/\r\n/g, '\n');
const count = (s, x) => s.split(x).length - 1;

// Each engine gets its own fresh context, as on two separate pages.
const edited = () => load([WEIGHTS, ENGINE]).GlazingEngine;
const original = () => load([WEIGHTS, { file: ENGINE + ' (reverted)', code: revert(committed) }]).GlazingEngine;

// Walk two results in parallel: every number must be Object.is-equal, and the shapes must match.
function comparer() {
    const st = { numbers: 0, diffs: [] };
    function diff(at, a, b) { if (st.diffs.length < 10) st.diffs.push(at + ': ' + String(a) + ' vs ' + String(b)); else st.diffs.push(''); }
    function same(x, y, at) {
        if (typeof x === 'number') { st.numbers++; if (!Object.is(x, y)) diff(at, x, y); return; }
        if (x === null || typeof x !== 'object') { if (!Object.is(x, y)) diff(at, x, y); return; }
        if (y === null || typeof y !== 'object') { diff(at, 'object', y); return; }
        if (typeof x.length === 'number') {
            if (typeof y.length !== 'number' || x.length !== y.length) { diff(at + '.length', x.length, y.length); return; }
            for (let i = 0; i < x.length; i++) {
                const a = x[i];
                if (typeof a === 'number') { st.numbers++; if (!Object.is(a, y[i])) diff(at + '[' + i + ']', a, y[i]); }
                else same(a, y[i], at + '[' + i + ']');
            }
            return;
        }
        const kx = Object.keys(x).sort().join(), ky = Object.keys(y).sort().join();
        if (kx !== ky) { diff(at + ' keys', kx, ky); return; }
        for (const k of Object.keys(x)) same(x[k], y[k], at + '.' + k);
    }
    return { same, st };
}

test('V7.1 E1-E4 are exact edits: each anchor found once, apply and revert are inverse', () => {
    const orig = revert(committed);
    for (const e of EDITS) {
        assert.equal(count(orig, e.before), 1, e.id + ': anchor must occur exactly once in the pre-edit engine');
        assert.equal(count(committed, e.after), 1, e.id + ': edited text must occur exactly once in the committed engine');
    }
    assert.equal(revert(apply(orig)), orig, 'revert(apply(x)) === x');
    assert.equal(apply(orig), committed, 'apply(revert(committed)) === committed');
    assert.throws(() => apply(committed), /anchor found 0 times/, 'the edits cannot be applied twice');
});

test('V7.2 classic results are bitwise identical: 440 configurations, an imported product, the low-e page path', (t) => {
    const A = original(), B = edited();
    const { same, st } = comparer();
    const glasses = ['clear', 'lowiron'], coats = ['none', 'hard', 'single', 'double', 'triple'];
    const fills = ['air', 'argon', 'krypton', 'xenon', 'vacuum'];
    let cfg = 0;
    for (const np of [1, 2, 3]) for (const g of glasses) for (const c of coats) for (const side of ['front', 'back'])
        for (const fill of (np > 1 ? fills : ['air'])) for (const H of [1, 0.5]) {
            const mm = [3, 6, 4][cfg % 3];
            const mk = E => { const L = []; for (let i = 0; i < np; i++) L.push(E.pane(g, mm, i === 0 ? c : 'none', side)); return L; };
            const gaps = [];
            for (let i = 0; i < np - 1; i++) gaps.push({ fill, width: fill === 'vacuum' ? 0.0003 : 0.0127, pillarSpacing: 0.025, pillarRadius: 0.00025 });
            same(A.evaluate(mk(A), gaps, H), B.evaluate(mk(B), gaps, H), 'cfg' + cfg + ' (' + [np, g, c, side, fill, H].join(' ') + ')');
            cfg++;
        }
    assert.equal(cfg, 440, 'configuration count');
    // An imported product (synthetic spectra, not IGDB data), flipped, in a double unit.
    const prod = { wl: [300, 500, 1000, 2500], T: [0.1, 0.8, 0.6, 0.3], Rf: [0.1, 0.08, 0.2, 0.5], Rb: [0.1, 0.09, 0.3, 0.6], ef: 0.84, eb: 0.05, thickness: 4, k: 1 };
    const gapI = [{ fill: 'argon', width: 0.0127 }];
    same(A.evaluate([A.imported(prod, true), A.pane('clear', 4)], gapI, 1), B.evaluate([B.imported(prod, true), B.pane('clear', 4)], gapI, 1), 'imported');
    // tools/low-e-sheet-resistance: E.thermal(L, [{ fill, width: 0.0127 }], E.CONDITIONS.winter, null, 1)
    for (const eb of [0.84, 0.2, 0.05, 0.01]) for (const fill of ['air', 'argon']) {
        const L = [{ ef: 0.84, eb, t: 0.006, k: 1 }, { ef: 0.84, eb: 0.84, t: 0.006, k: 1 }];
        same(A.thermal(L, [{ fill, width: 0.0127 }], A.CONDITIONS.winter, null, 1), B.thermal(L, [{ fill, width: 0.0127 }], B.CONDITIONS.winter, null, 1), 'low-e page eb ' + eb + ' ' + fill);
    }
    t.diagnostic('configurations ' + cfg + ', numbers compared ' + st.numbers + ', differences ' + st.diffs.length);
    assert.ok(st.numbers > 1e6, 'expected over a million numbers compared, got ' + st.numbers);
    assert.deepEqual(st.diffs, [], 'every number must be Object.is-equal');
});

test('V7.3 API surface: every old key kept, new keys exactly registerModel and MODELS', () => {
    const A = original(), B = edited();
    const ka = Object.keys(A), kb = Object.keys(B);
    for (const k of ka) assert.ok(kb.includes(k), 'old key ' + k + ' is still exported');
    assert.deepEqual(kb.filter(k => !ka.includes(k)).sort(), ['MODELS', 'registerModel']);
    assert.equal(typeof B.registerModel, 'function');
    assert.equal(Object.keys(B.MODELS).length, 0, 'no model is registered by the engine itself');
});

test('V7.4 errors: model not loaded, wrong solar weight count, reserved model name', () => {
    const B = edited();
    assert.throws(() => B.pane('clear', 6, 'single', 'back', 'open'), { message: 'GlazingEngine: material model "open" is not loaded' });
    assert.throws(() => B.evaluate([B.pane('clear', 3)], [], 1, { solar: [1, 2, 3] }), { message: 'GlazingEngine: opts.solar must have 441 weights' });
    assert.throws(() => B.registerModel('classic', { pane() { return null; } }), { message: 'GlazingEngine: invalid material model "classic"' });
    assert.throws(() => B.registerModel('x', {}), { message: 'GlazingEngine: invalid material model "x"' });
    assert.throws(() => B.registerModel('', { pane() { return null; } }), /invalid material model/);
});

test('V7.5 the new arguments behave as spec 3.2 says', () => {
    const A = original(), B = edited();
    const { same, st } = comparer();
    // 'classic' is the same as omitting the model
    for (const [g, mm, c, side] of [['clear', 6, 'double', 'back'], ['lowiron', 3, 'hard', 'front'], ['clear', 4, 'none', 'front']])
        same(A.pane(g, mm, c, side), B.pane(g, mm, c, side, 'classic'), 'pane ' + [g, mm, c, side].join(' '));
    // opts without solar, or with the default G173 weights, is the same as omitting opts
    const ctxW = load([WEIGHTS]).GlazingWeights;
    const mkA = () => [A.pane('clear', 6, 'double', 'back'), A.pane('clear', 6)];
    const mkB = () => [B.pane('clear', 6, 'double', 'back'), B.pane('clear', 6)];
    const gaps = [{ fill: 'argon', width: 0.0127 }];
    const ref = A.evaluate(mkA(), gaps, 1);
    same(ref, B.evaluate(mkB(), gaps, 1, {}), 'opts {}');
    same(ref, B.evaluate(mkB(), gaps, 1, { solar: Array.from(ctxW.solar) }), 'opts G173');
    assert.deepEqual(st.diffs, []);
    // other weights change only the solar-weighted quantities (and SHGC, through the absorbed solar)
    const flat = new Array(441).fill(1 / 441), r = B.evaluate(mkB(), gaps, 1, { solar: flat });
    const meanT = Array.from(r.sys.T).reduce((s, v) => s + v / 441, 0);
    assert.ok(Math.abs(r.Tsol - meanT) < 1e-12, 'Tsol uses opts.solar');
    assert.notEqual(r.Tsol, ref.Tsol); assert.notEqual(r.Tuv, ref.Tuv); assert.notEqual(r.SHGC, ref.SHGC);
    assert.ok(Object.is(r.U, ref.U) && Object.is(r.Tvis, ref.Tvis) && Object.is(r.Rvis, ref.Rvis), 'U and visible quantities do not depend on the solar weights');
    // a registered model receives the four pane arguments
    const C = edited(), calls = [];
    const fake = { pane(...args) { calls.push(args); return C.pane('clear', 3); } };
    C.registerModel('test', fake);
    assert.equal(C.MODELS.test, fake);
    C.pane('lowiron', 5, 'single', 'back', 'test');
    assert.deepEqual(calls, [['lowiron', 5, 'single', 'back']]);
});
