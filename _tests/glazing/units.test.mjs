// U-factor and R-value conversions, assets/js/glazing-units.js (window.GlazingUnits): the Btu constant, the
// conversions among U (W/m²·K), U (Btu/h·ft²·°F), RSI (m²·K/W) and R (h·ft²·°F/Btu), the shared text of a U/R
// pair, and the converter panel. The panel is run against the real assets/js/calc.js on a small stand-in for
// the page (the elements and selectors the two scripts use, nothing more): it follows the calculator's result
// without touching the URL hash, holds a typed value under the ru. prefix, and goes back on request.
// Run: node --test _tests/glazing/units.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers/load.mjs';

const FILE = 'assets/js/glazing-units.js';
const G = load([FILE]).GlazingUnits;          // alone: the conversions and the text need no other script
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
const BAD = [0, -0, -1.4, NaN, Infinity, -Infinity, '1.4', null, undefined, {}, [2]];

/* ── A stand-in page: just what calc.js and glazing-units.js touch ─────────────────────────────────────── */
function element(tag, cls) {
    const on = {}, attrs = {}, classes = new Set(cls ? cls.split(' ') : []);
    return {
        tagName: tag, value: '', textContent: '', id: '', dataset: {}, parent: null,
        addEventListener(type, fn) { (on[type] = on[type] || []).push(fn); },
        fire(type) { (on[type] || []).forEach(fn => fn({ target: this })); },
        getAttribute: k => (k in attrs ? attrs[k] : null),
        setAttribute(k, v) { attrs[k] = String(v); },
        removeAttribute(k) { delete attrs[k]; },
        hasAttribute: k => k in attrs,
        classList: {
            add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
            toggle: (c, want) => { if (want) classes.add(c); else classes.delete(c); }
        },
        closest(sel) {
            if (sel === 'form') return null;
            if (sel === '.input-unit') return this.parent;
            throw new Error('stand-in page: closest(' + sel + ')');
        },
        select() {}
    };
}
// page(hash) → a context with Calc and GlazingUnits loaded, and the converter panel's elements
function page(hash) {
    const panel = element('SECTION', 'panel'), err = element('DIV', 'calc-error'), status = element('P', 'hint');
    const button = element('BUTTON'), inputs = {}, boxes = {};
    button.dataset.action = 'reset'; button.dataset.for = 'ru';
    for (const n of ['u', 'uip', 'rip', 'rsi']) {
        boxes[n] = element('DIV', 'input-unit');
        inputs[n] = element('INPUT'); inputs[n].name = n; inputs[n].parent = boxes[n];
    }
    panel.querySelector = sel => {
        const m = /^input\[name="(\w+)"\]$/.exec(sel);
        if (m) return inputs[m[1]] || null;
        if (sel === '.calc-error') return err;
        if (sel === '[data-ru-status]') return status;
        if (sel === '.input-unit.source') return Object.values(boxes).find(b => b.classList.contains('source')) || null;
        throw new Error('stand-in page: querySelector(' + sel + ')');
    };
    const location = { hash: hash || '', pathname: '/tools/glazing-performance/', search: '' };
    const writes = [];   // every history.replaceState, as the fragment it left
    const document = {
        readyState: 'complete', activeElement: null, addEventListener() {},
        getElementById: id => (id === 'ru-converter' ? panel : null),
        querySelector: sel => (sel === '#ru-converter' ? panel : null),
        querySelectorAll: sel => (sel === '.result-value' ? []
            : sel === '[data-action="reset"]' || sel === '[data-action="reset"][data-for="ru"]' ? [button]
            : (() => { throw new Error('stand-in page: querySelectorAll(' + sel + ')'); })())
    };
    const history = { replaceState(a, b, url) { location.hash = url.charAt(0) === '#' ? url : ''; writes.push(location.hash); } };
    const ctx = load(['assets/js/calc.js', FILE], { document, location, history, URLSearchParams, addEventListener() {} });
    const type = (n, text) => { inputs[n].value = text; inputs[n].fire('input'); };
    const shown = () => ['u', 'uip', 'rip', 'rsi'].map(n => inputs[n].value);
    return { ctx, panel, err, status, button, inputs, boxes, location, writes, type, shown, GU: ctx.GlazingUnits };
}
const num = page().ctx.Calc.fmt.num;   // the pages' number formatter

/* ── Constant ──────────────────────────────────────────────────────────────────────────────────────────── */
test('BTU is 5.678263 W/m²·K per Btu/h·ft²·°F, the definitions rounded to seven figures', () => {
    assert.equal(G.BTU, 5.678263);
    const btuIT = 4186.8 * 0.45359237 * 5 / 9;                      // J: IT calorie relation, the pound, the °F
    assert.ok(Math.abs(btuIT - 1055.05585262) < 1e-9, String(btuIT));
    const exact = btuIT / (3600 * 0.3048 * 0.3048 * 5 / 9);         // per hour, per square foot, per °F
    assert.ok(Math.abs(exact - G.BTU) < 5e-7, String(exact));
    assert.equal(Number(exact.toPrecision(7)), G.BTU);
    assert.equal(load(['beta/glazing/beta-core.js']).GlazingBeta.BTU, G.BTU);   // one constant on every page
});

/* ── Conversions ───────────────────────────────────────────────────────────────────────────────────────── */
test('known pairs', () => {
    const a = G.fromU(1.0);                                         // U 1.0 W/m²·K is R-5.678263
    assert.equal(a.U, 1); assert.equal(a.Rsi, 1); assert.equal(a.Rip, 5.678263);
    assert.ok(rel(a.Uip, 0.176110194261872) < 1e-13, String(a.Uip));
    const b = G.fromU(G.fromUip(0.25));                             // U 0.25 Btu/h·ft²·°F is R-4
    assert.equal(b.Rip, 4); assert.equal(b.Uip, 0.25);
    assert.ok(rel(b.U, 1.41956575) < 1e-15); assert.ok(rel(b.Rsi, 0.704440777047488) < 1e-13);
    const c = G.fromU(G.fromRsi(1));                                // RSI 1 is R-5.678263
    assert.equal(c.Rip, 5.678263); assert.equal(c.U, 1);
    assert.ok(rel(G.fromRip(4), 1.41956575) < 1e-15);               // R-4 is U 1.42 W/m²·K
    const d = G.fromU(1.36954);                                     // reference values from decimal arithmetic
    assert.ok(rel(d.Uip, 0.241189955449404) < 1e-13 && rel(d.Rsi, 0.730172174598770) < 1e-13 && rel(d.Rip, 4.14610964265374) < 1e-13);
    assert.ok(rel(G.fromU(5.8).Rip, 0.979010862068966) < 1e-13);           // single glass: about R-1
});

test('round trips among all four quantities agree to 1e-12', () => {
    const back = { U: x => x, Uip: G.fromUip, Rsi: G.fromRsi, Rip: G.fromRip };
    const keys = Object.keys(back);
    for (const U of [1e-6, 0.0123, 0.2, 0.4, 0.5678263, 1, 1.36954, 2.73, 5.8, 17, 1e6]) {
        const q = G.fromU(U);
        assert.deepEqual(Object.keys(q), keys);
        assert.ok(rel(q.U / q.Uip, G.BTU) < 1e-12 && rel(q.Rip / q.Rsi, G.BTU) < 1e-12, 'ratio at ' + U);
        assert.ok(rel(q.U * q.Rsi, 1) < 1e-12 && rel(q.Uip * q.Rip, 1) < 1e-12, 'R = 1/U at ' + U);
        for (const from of keys) {
            const q2 = G.fromU(back[from](q[from]));                // from each quantity to U, then to all four
            for (const to of keys) assert.ok(rel(q2[to], q[to]) < 1e-12, from + ' → ' + to + ' at U = ' + U);
        }
    }
});

test('zero, negative, non-finite and non-numeric inputs give NaN, never a number', () => {
    for (const x of BAD) {
        const q = G.fromU(x);
        for (const k of ['U', 'Uip', 'Rsi', 'Rip']) assert.ok(Number.isNaN(q[k]), 'fromU(' + String(x) + ').' + k);
        for (const f of ['fromUip', 'fromRsi', 'fromRip']) assert.ok(Number.isNaN(G[f](x)), f + '(' + String(x) + ')');
    }
    // values whose reciprocal or product leaves the range of a double
    for (const k of ['U', 'Uip', 'Rsi', 'Rip']) {
        assert.ok(Number.isNaN(G.fromU(5e-324)[k]), k + ' at 5e-324');
        assert.ok(Number.isNaN(G.fromU(1e-310)[k]), k + ' at 1e-310');
    }
    assert.ok(Number.isNaN(G.fromUip(1e308)) && Number.isNaN(G.fromRsi(1e-310)) && Number.isNaN(G.fromRip(5e-324)));
});

/* ── Text ──────────────────────────────────────────────────────────────────────────────────────────────── */
test('the shared text of a U/R pair', () => {
    assert.deepEqual({ ...G.UNIT }, { U: 'W/m²·K', Uip: 'Btu/h·ft²·°F', Rsi: 'm²·K/W', Rip: 'h·ft²·°F/Btu' });
    const U = 1.36954;
    assert.deepEqual({ ...G.format(U, num) }, { U: '1.37', Uip: '0.241', Rsi: '0.73', Rip: '4.15' });
    assert.equal(G.uText(U, num), '1.37 W/m²·K (0.241 Btu/h·ft²·°F)');
    assert.equal(G.rText(U, num), 'R-4.15 (0.73 m²·K/W)');
    assert.equal(G.uText(U, num, 4), '1.37 W/m²·K (0.2412 Btu/h·ft²·°F)');
    assert.equal(G.rText(U, num, 4), 'R-4.146 (0.7302 m²·K/W)');
    // each number comes from the full-precision U: 1/1.37 would print R-4.14
    assert.equal(num(G.BTU / 1.37, 3), '4.14');
    assert.equal(G.rText(1, num, 7), 'R-5.678263 (1 m²·K/W)');
    assert.equal(G.uText(G.fromUip(0.25), num), '1.42 W/m²·K (0.25 Btu/h·ft²·°F)');
    for (const x of BAD) { assert.equal(G.uText(x, num), '—'); assert.equal(G.rText(x, num), '—'); }
    const f = G.format(NaN, num);
    assert.deepEqual([f.U, f.Uip, f.Rsi, f.Rip], ['—', '—', '—', '—']);
});

/* ── Converter panel ───────────────────────────────────────────────────────────────────────────────────── */
test('alone, the script loads without calc.js or a document; mountConverter then says what it needs', () => {
    assert.throws(() => G.mountConverter(), /calc\.js/);
});

test('converter: follows the calculator result and leaves the URL hash alone', () => {
    const p = page(), ru = p.GU.mountConverter();
    assert.deepEqual(p.shown(), ['', '', '', '']);
    assert.match(p.status.textContent, /no calculator result/);
    assert.ok(Number.isNaN(ru.get()));
    ru.follow(1.36954);
    assert.deepEqual(p.shown(), ['1.37', '0.2412', '4.146', '0.7302']);   // each rounded from the full-precision value
    assert.match(p.status.textContent, /^Showing the calculator’s center-of-glass result\./);
    assert.equal(ru.get(), 1.36954); assert.equal(ru.held(), false);
    ru.follow(0.4);
    assert.deepEqual(p.shown(), ['0.4', '0.07044', '14.2', '2.5']);
    ru.clear();                                                           // the calculation failed
    assert.deepEqual(p.shown(), ['', '', '', '']);
    ru.follow(-1);                                                        // not a U-factor: the same as no result
    assert.deepEqual(p.shown(), ['', '', '', '']);
    ru.follow(2.73);
    assert.equal(p.inputs.u.value, '2.73');
    assert.deepEqual(p.writes, []); assert.equal(p.location.hash, '');
    assert.ok(!Object.values(p.boxes).some(b => b.classList.contains('source')));
});

test('converter: a typed value converts the other three, is held, and is stored as ru.<field>', () => {
    const p = page(), ru = p.GU.mountConverter();
    ru.follow(1.36954);
    p.type('rip', '4');
    assert.deepEqual(p.shown(), ['1.42', '0.25', '4', '0.7044']);
    assert.equal(p.location.hash, '#ru.rip=4');
    assert.equal(ru.held(), true);
    assert.ok(rel(ru.get(), 1.41956575) < 1e-15);
    assert.ok(p.boxes.rip.classList.contains('source'));
    assert.match(p.status.textContent, /^Showing the value you entered/);
    ru.follow(2.73); ru.clear(); ru.follow(0.4);                          // the calculator moves on: the entry stays
    assert.deepEqual(p.shown(), ['1.42', '0.25', '4', '0.7044']);
    assert.equal(p.location.hash, '#ru.rip=4');
    p.type('u', '1.0');
    assert.deepEqual(p.shown(), ['1.0', '0.1761', '5.678', '1']);
    assert.equal(p.location.hash, '#ru.u=1.0');
    p.type('uip', '0.25'); assert.equal(p.inputs.rip.value, '4');
    p.type('rsi', '1'); assert.equal(p.inputs.rip.value, '5.678');
    assert.equal(p.location.hash, '#ru.rsi=1');
});

test('converter: “Use the calculator result” goes back to following and drops the ru. key', () => {
    const p = page(), ru = p.GU.mountConverter();
    ru.follow(1.36954);
    p.type('rsi', '2');
    ru.follow(0.4);
    assert.equal(p.location.hash, '#ru.rsi=2');
    p.button.fire('click');
    assert.deepEqual(p.shown(), ['0.4', '0.07044', '14.2', '2.5']);     // the latest result, not the one before typing
    assert.equal(p.location.hash, '');
    assert.equal(ru.held(), false); assert.equal(ru.get(), 0.4);
    assert.ok(!Object.values(p.boxes).some(b => b.classList.contains('source')));
    const n = p.writes.length;
    ru.follow(1.36954);
    assert.equal(p.inputs.rip.value, '4.146');
    assert.equal(p.writes.length, n);
    // with no result to go back to, the fields empty
    p.type('u', '3'); ru.clear(); p.button.fire('click');
    assert.deepEqual(p.shown(), ['', '', '', '']);
    assert.match(p.status.textContent, /no calculator result/);
});

test('converter: a share link restores the typed value next to another calculator’s keys', () => {
    const p = page('#glz.np=3&ru.rsi=1&glz.p1t=4'), ru = p.GU.mountConverter();
    assert.deepEqual(p.shown(), ['1', '0.1761', '5.678', '1']);
    assert.equal(ru.held(), true); assert.equal(ru.get(), 1);
    ru.follow(1.36954);
    assert.deepEqual(p.shown(), ['1', '0.1761', '5.678', '1']);
    assert.deepEqual(p.writes, []);                                       // reading a link writes nothing
    p.button.fire('click');
    assert.equal(p.inputs.u.value, '1.37');
    // only its own prefix: a calculator's key with a field's name is not the converter's
    const q = page('#glz.u=3&rip=9&u=7'), rq = q.GU.mountConverter();
    assert.deepEqual(q.shown(), ['', '', '', '']); assert.equal(rq.held(), false);
});

test('converter: a link value that does not convert falls back to following, with no message left', () => {
    for (const h of ['#ru.rip=abc', '#ru.u=0', '#ru.rsi=-2', '#ru.uip=1e400', '#ru.u=1e12', '#ru.nope=3']) {
        const p = page(h), ru = p.GU.mountConverter();
        assert.deepEqual(p.shown(), ['', '', '', ''], h);
        assert.equal(ru.held(), false, h);
        assert.ok(!p.err.classList.contains('show'), h);
        assert.ok(!Object.values(p.inputs).some(i => i.getAttribute('aria-invalid')), h);
        ru.follow(1.36954);
        assert.equal(p.inputs.rip.value, '4.146', h);
        assert.deepEqual(p.writes, [], h);
    }
});

test('converter: invalid entries show the calc-error message, keep the other fields, and do not reach the link', () => {
    const p = page(), ru = p.GU.mountConverter();
    ru.follow(1.36954);
    const cases = [['0', /positive number/], ['-3', /positive number/], ['abc', /not a number/], ['1e400', /out of range/],
        ['1e12', /out of range/], ['1,064', /ambiguous/]];
    for (const [text, msg] of cases) {
        p.type('rip', text);
        assert.ok(p.err.classList.contains('show'), text);
        assert.match(p.err.textContent, msg, text);
        assert.equal(p.inputs.rip.getAttribute('aria-invalid'), 'true', text);
        assert.deepEqual(p.shown(), ['1.37', '0.2412', text, '0.7302'], text);
        assert.equal(p.location.hash, '', text);
        assert.equal(ru.held(), true, text);                              // the user is typing: the result must not overwrite it
        assert.ok(Number.isNaN(ru.get()), text);
    }
    ru.follow(0.4);
    assert.equal(p.inputs.rip.value, '1,064');
    p.type('rip', '4.2');                                                 // a valid entry clears the message
    assert.ok(!p.err.classList.contains('show'));
    assert.equal(p.inputs.rip.getAttribute('aria-invalid'), null);
    assert.equal(p.location.hash, '#ru.rip=4.2');
    p.type('rip', 'x');
    p.button.fire('click');                                               // and so does going back to the result
    assert.ok(!p.err.classList.contains('show'));
    assert.equal(p.inputs.rip.getAttribute('aria-invalid'), null);
    assert.deepEqual(p.shown(), ['0.4', '0.07044', '14.2', '2.5']);
});

test('converter: the markup is checked when it is mounted', () => {
    const p = page();
    assert.throws(() => p.GU.mountConverter({ root: '#missing' }), /markup not found/);
    p.panel.closest = () => ({});                                         // inside a form
    assert.throws(() => p.GU.mountConverter(), /outside the calculator form/);
    const q = page();
    delete q.inputs.rsi;
    assert.throws(() => q.GU.mountConverter(), /no input named rsi/);
    const r = page(), ru = r.GU.mountConverter({ label: 'the open-data model’s center-of-glass result', sig: 6 });
    ru.follow(1.36954);
    assert.deepEqual(r.shown(), ['1.36954', '0.24119', '4.14611', '0.730172']);
    assert.match(r.status.textContent, /^Showing the open-data model’s center-of-glass result\./);
});
