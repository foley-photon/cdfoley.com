// V11 (WP4): classic = live parity. For eight configurations, GlazingBeta.evaluateModels with view 'classic' and
// the E891 spectrum must give E.evaluate results Object.is-equal to the live page's own construction
// (tools/glazing-performance/index.html: E.pane(g, t, c, side) and E.evaluate(layers, gaps, H) with its gap
// objects, copied below). Spec 5.3, V11.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers/load.mjs';

const ctx = load.all();
const E = ctx.GlazingEngine, B = ctx.GlazingBeta;

// The live page's construction (copied from its compute()).
function live(v) {
    const np = parseInt(v.np, 10), layers = [], gaps = [];
    for (let i = 1; i <= np; i++) {
        const gsel = v['p' + i + 'g'], side = v['p' + i + 's'];
        layers.push(E.pane(gsel, parseFloat(v['p' + i + 't']), v['p' + i + 'c'], side));
        if (i < np) {
            const fill = v['g' + i + 'f'], vac = fill === 'vacuum';
            gaps.push({ fill, width: vac ? 0.0003 : v['g' + i + 'w'], pillarSpacing: v['g' + i + 'ps'], pillarRadius: v['g' + i + 'pd'] / 2 });
        }
    }
    return E.evaluate(layers, gaps, v.H, { solar: ctx.GlazingSolarE891.solarE891 });
}

const base = {
    view: 'classic', sol: 'e891', H: 1,
    p1g: 'clear', p1t: '6', p1c: 'none', p1s: 'front', p2g: 'clear', p2t: '6', p2c: 'none', p2s: 'front', p3g: 'clear', p3t: '6', p3c: 'none', p3s: 'front',
    g1f: 'argon', g1w: 0.0127, g1ps: 0.025, g1pd: 0.0005, g2f: 'argon', g2w: 0.0127, g2ps: 0.025, g2pd: 0.0005
};
const CONFIGS = {
    'single 3 mm clear': { np: '1', p1t: '3' },
    'single 6 mm clear': { np: '1' },
    'single 6 mm low-iron': { np: '1', p1g: 'lowiron' },
    'double 3/12.7 air/3 clear': { np: '2', p1t: '3', p2t: '3', g1f: 'air' },
    'live default: 6 mm double silver #2 / 12.7 argon / 6': { np: '2', p1c: 'double', p1s: 'back' },
    '3 mm single silver #2 / 12.7 air / 3': { np: '2', p1t: '3', p2t: '3', p1c: 'single', p1s: 'back', g1f: 'air' },
    'triple 3/12.7 krypton/3/12.7 krypton/3, double silver #2 and #5': { np: '3', p1t: '3', p2t: '3', p3t: '3', p1c: 'double', p1s: 'back', p3c: 'double', p3s: 'front', g1f: 'krypton', g2f: 'krypton' },
    'vacuum 4 mm single silver #2, 25 mm pillars of 0.5 mm': { np: '2', p1t: '4', p2t: '4', p1c: 'single', p1s: 'back', g1f: 'vacuum' }
};

// Every number reachable from an evaluate() result, with its path.
function flatten(x, p = '', out = []) {
    if (typeof x === 'number') out.push([p, x]);
    else if (x && typeof x === 'object') {
        if (ArrayBuffer.isView(x) || Array.isArray(x)) for (let i = 0; i < x.length; i++) flatten(x[i], p + '[' + i + ']', out);
        else for (const k of Object.keys(x).sort()) flatten(x[k], p + '.' + k, out);
    }
    return out;
}

test('classic model with E891 is bitwise identical to the live page for 8 configurations', () => {
    let total = 0;
    const deps = { E, open: true, P: ctx.GlazingProducts, solarE891: ctx.GlazingSolarE891.solarE891, getProduct: () => undefined, getImport: () => undefined };
    for (const [name, o] of Object.entries(CONFIGS)) {
        const v = Object.assign({}, base, o);
        const { state, errors } = B.readState(v);
        assert.equal(errors.length, 0, name);
        const res = B.evaluateModels(state, deps);
        assert.equal(res.open, null, name);
        assert.ok(res.classic, name);
        const a = flatten(res.classic.r), b = flatten(live(v));
        assert.equal(a.length, b.length, name);
        assert.ok(a.length > 1500, name + ': ' + a.length + ' numbers');
        for (let i = 0; i < a.length; i++) {
            assert.equal(a[i][0], b[i][0]);
            if (!Object.is(a[i][1], b[i][1])) assert.fail(`${name}: ${a[i][0]} ${a[i][1]} vs ${b[i][1]}`);
        }
        total += a.length;
    }
    assert.ok(total > 15000, 'numbers compared: ' + total);
});

test('the side-by-side view leaves the classic column unchanged', () => {
    const deps = { E, open: true, P: ctx.GlazingProducts, solarE891: ctx.GlazingSolarE891.solarE891, getProduct: () => undefined, getImport: () => undefined };
    const v = Object.assign({}, base, CONFIGS['live default: 6 mm double silver #2 / 12.7 argon / 6'], { view: 'both' });
    const res = B.evaluateModels(B.readState(v).state, deps);
    assert.ok(res.open);
    const a = flatten(res.classic.r), b = flatten(live(v));
    assert.ok(a.every((x, i) => Object.is(x[1], b[i][1])));
});
