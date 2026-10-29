// WP5: Components URL hash (spec 2.9, 7.6 acceptance 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, encodeNumber, encodeLabel, decodeItems, encodeItems, DEFAULT_HASH, BAD_LINK_NOTE, DEFAULT_RANGE }
    from '../../beta/conductance/js/ui/url-state.js';
import { ELEMENT_TYPES } from '../../beta/conductance/js/engine/elements.js';
import { GAS_IDS } from '../../beta/conductance/js/engine/gas.js';
import { makeRng as rngOf } from '../../beta/conductance/js/engine/rng.js';

// seeded generator of rng.js (spec 5.4): () => [0, 1)
const makeRng = (seed) => rngOf(seed);

const GEOM = ['tube', 'orifice', 'slit', 'rect', 'annulus', 'cone', 'elbow', 'bbox'];
const r7 = (x) => Number(x.toPrecision(7));

function randomItem(rng, type) {
    const len = () => r7(10 ** (rng() * 5 - 5) * (1 + rng()));      // 1e-5 … 2 m
    const it = { t: type };
    for (const f of ELEMENT_TYPES[type].fields) {
        if (f.when && !Object.entries(f.when).every(([k, v]) => it[k] === v)) continue;
        if (f.kind === 'number') it[f.key] = f.dim === 'speed' ? r7(10 ** (rng() * 6 - 5)) : len();
        else if (f.kind === 'select') it[f.key] = f.options[Math.floor(rng() * f.options.length)];
        else {
            const words = ['Turbo', 'Gate valve', 'V1', 'Trap-2', 'cryo.pump', 'Roots blower 3'];
            it[f.key] = words[Math.floor(rng() * words.length)];
        }
    }
    return it;
}

function randomModel(rng) {
    const pump = rng() < 0.6, items = [], n = 1 + Math.floor(rng() * 8);
    for (let k = 0; k < n; k++) {
        const u = rng();
        if (u < 0.08) items.push({ t: 'chamber' });
        else if (u < 0.2) {
            const nb = 2 + Math.floor(rng() * 3);
            items.push({ t: 'parallel', branches: Array.from({ length: nb }, () => Array.from({ length: 1 + Math.floor(rng() * 3) }, () => randomItem(rng, GEOM[Math.floor(rng() * GEOM.length)]))) });
        } else items.push(randomItem(rng, GEOM[Math.floor(rng() * GEOM.length)]));
    }
    if (pump) items.push(randomItem(rng, 'pump'));
    const custom = rng() < 0.2;
    const p0 = r7(10 ** (rng() * 12 - 7));
    return {
        tab: ['components', 'cad', 'selftest'][Math.floor(rng() * 3)],
        model: {
            items,
            gas: custom ? { id: 'custom', T: r7(200 + rng() * 300), custom: { M: r7(0.002 + rng() * 0.1), eta20: r7(1e-5 + rng() * 2e-5), omega: r7(0.5 + rng() * 0.5), gamma: r7(1.1 + rng() * 0.5), Cd: r7(0.5 + rng() * 0.5) } }
                : { id: GAS_IDS[Math.floor(rng() * GAS_IDS.length)], T: r7(100 + rng() * 500), custom: null },
            Cd: rng() < 0.3 ? r7(0.5 + rng() * 0.5) : null,
            bc: pump ? { mode: 'pump', p0 } : { mode: 'dp', p0, p1: r7(p0 * rng()) },
            range: rng() < 0.3 ? { pMin: r7(10 ** (-8 + rng() * 3)), pMax: r7(10 ** (3 + rng() * 3)) } : { ...DEFAULT_RANGE },
        },
        units: { lu: ['mm', 'cm', 'm', 'in'][Math.floor(rng() * 4)], su: ['L/s', 'm³/h', 'L/min', 'cfm'][Math.floor(rng() * 4)], pu: ['mbar', 'Pa', 'Torr', 'mTorr'][Math.floor(rng() * 4)] },
    };
}

test('500 random models round-trip: decode(encode(m)) equals m and encode(decode(h)) === h', () => {
    const rng = makeRng(20261013);
    for (let k = 0; k < 500; k++) {
        const s = randomModel(rng);
        const h = encode(s);
        const d = decode('#' + h);
        assert.equal(d.kind, 'model', h);
        assert.equal(d.notice, null);
        assert.deepEqual(d.state, s, h);
        assert.equal(encode(d.state), h);
    }
});

test('every element type appears in the round trip and in the grammar', () => {
    const items = [...GEOM.map((t) => randomItem(makeRng(7), t)), { t: 'chamber' },
        { t: 'parallel', branches: [[{ t: 'tube', d: 0.01, L: 0.1 }], [{ t: 'cone', d1: 0.01, d2: 0.02, L: 0.05 }, { t: 'bbox', C: 0.01, gasRef: 'Ar', d: 0.02, label: 'V' }]] },
        { t: 'pump', S: 0.1, d: 0.1, label: 'Turbo' }];
    const text = encodeItems(items);
    for (const d of Object.values(ELEMENT_TYPES)) assert.ok(text.includes(d.token + '('), d.token);
    assert.deepEqual(decodeItems(text), items);
});

test('the default and parallel examples of §2.9 decode to the Appendix B models', () => {
    const d = decode('#' + DEFAULT_HASH);
    assert.equal(d.kind, 'model');
    assert.deepEqual(d.state.model, {
        items: [{ t: 'tube', d: 0.1, L: 0.2 }, { t: 'elbow', d: 0.1, A: 0.1, B: 0.1 }, { t: 'pump', S: 0.3, d: 0.1, label: 'Turbo' }],
        gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'pump', p0: 1e-4 }, range: { pMin: 1e-6, pMax: 1.2e5 },
    });
    assert.deepEqual(d.state.units, { lu: 'mm', su: 'L/s', pu: 'mbar' });
    assert.equal(d.state.tab, 'components');
    const par = decode('#v=1&g=N2&T=293.15&bc=pump&p0=1e-4&lu=mm&su=L/s&pu=mbar&i=tube(d=0.05,L=0.1)par(tube(d=0.02,L=0.3);tube(d=0.03,L=0.5)elbow(d=0.03,A=0.05,B=0.05))pump(S=0.05,d=0.05,label=Turbo)');
    assert.deepEqual(par.state.model.items, [
        { t: 'tube', d: 0.05, L: 0.1 },
        { t: 'parallel', branches: [[{ t: 'tube', d: 0.02, L: 0.3 }], [{ t: 'tube', d: 0.03, L: 0.5 }, { t: 'elbow', d: 0.03, A: 0.05, B: 0.05 }]] },
        { t: 'pump', S: 0.05, d: 0.05, label: 'Turbo' },
    ]);
    // presets 3 to 6 of Appendix B
    assert.deepEqual(decodeItems('tube(d=0.025,L=1)pump(S=0.009722222,d=0.025,label=Rotary_vane)')[1], { t: 'pump', S: 0.009722222, d: 0.025, label: 'Rotary vane' });
    assert.deepEqual(decodeItems('orif(shape=circle,d=0.001)'), [{ t: 'orifice', shape: 'circle', d: 0.001 }]);
    assert.deepEqual(decodeItems('slit(h=0.0001,w=0.05,L=0.01)'), [{ t: 'slit', h: 0.0001, w: 0.05, L: 0.01 }]);
    assert.deepEqual(decodeItems('bbox(C=0.08,gasRef=N2,d=0.04,label=Gate_valve)'), [{ t: 'bbox', C: 0.08, gasRef: 'N2', d: 0.04, label: 'Gate valve' }]);
    const dp = decode('#v=1&g=N2&bc=dp&p0=10&p1=0.01&i=orif(shape=circle,d=0.001)');
    assert.deepEqual(dp.state.model.bc, { mode: 'dp', p0: 10, p1: 0.01 });
});

test('malformed hashes give the default model and the notice, without throwing', () => {
    const def = decode('').state;
    for (const h of ['#v=1&i=tube(d=0.1', '#v=2&i=tube()', '#x=1', '#v=1&i=tube(d=1))', '#v=1&i=par(tube();par(tube()))', '#v=1&i=(d=1)', '#v=1&i=tube(d=1;L=2)', '#%E0%A4%A&v=1&i=tube(']) {
        let d;
        assert.doesNotThrow(() => { d = decode(h); }, h);
        assert.equal(d.kind, 'bad', h);
        assert.equal(d.notice, BAD_LINK_NOTE);
        assert.deepEqual(d.state, def);
    }
    // anchors, empty hashes and tab-only links are not errors
    assert.equal(decode('#how').kind, 'anchor');
    assert.equal(decode('#how').notice, null);
    assert.equal(decode('').kind, 'empty');
    const t = decode('#tab=selftest');
    assert.equal(t.kind, 'tab');
    assert.equal(t.state.tab, 'selftest');
    // unknown keys, tokens and parameters are ignored; missing parameters take defaults; bad values are kept
    const u = decode('#v=1&zz=3&i=foo(a=1)tube(d=abc,L=-1,zz=3)');
    assert.equal(u.kind, 'model');
    assert.deepEqual(u.state.model.items, [{ t: 'tube', d: 0.04, L: -1 }]);
    assert.deepEqual(decode('#v=1&g=XYZ&lu=furlong&i=tube()').state.units.lu, 'mm');
    assert.equal(decode('#v=1&g=XYZ&i=tube()').state.model.gas.id, 'N2');
});

test('percent-encoded hashes decode', () => {
    const plain = decode('#' + DEFAULT_HASH).state;
    const enc = '#' + encodeURIComponent(DEFAULT_HASH);
    assert.deepEqual(decode(enc).state, plain);
    const partial = '#' + DEFAULT_HASH.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/,/g, '%2C');
    assert.deepEqual(decode(partial).state, plain);
    assert.deepEqual(decode('#v=1&su=m%C2%B3%2Fh&i=tube()').state.units.su, 'm³/h');
});

test('numbers and labels are written as specified', () => {
    assert.equal(encodeNumber(0.0005), '0.0005');
    assert.equal(encodeNumber(1.2e5), '120000');
    assert.equal(encodeNumber(1e-7), '1e-7');
    assert.equal(encodeNumber(1.23456789e21), '1.234568e21');
    assert.equal(encodeNumber(0.009722222222), '0.009722222');
    assert.equal(encodeLabel('Gate valve (DN40)'), 'Gate_valve_DN40');
    assert.equal(encodeLabel('x'.repeat(50)).length, 40);
});

test('a 40-item model stays under 4 kB', () => {
    const items = Array.from({ length: 39 }, (_, k) => (k % 2 ? { t: 'elbow', d: 0.0634567, A: 0.1234567, B: 0.2345678 } : { t: 'cone', d1: 0.0634567, d2: 0.1034567, L: 0.1234567 }));
    items.push({ t: 'pump', S: 0.3456789, d: 0.1034567, label: 'A_long_pump_label_of_forty_characters_x' });
    const h = encode({ tab: 'components', model: { items, gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'pump', p0: 1e-4 }, range: { ...DEFAULT_RANGE } }, units: { lu: 'mm', su: 'L/s', pu: 'mbar' } });
    assert.ok(h.length < 4096, String(h.length));
});
