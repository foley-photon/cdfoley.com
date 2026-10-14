// WP5: schematic SVG builder (spec 4.4, 7.6 acceptance 3). Snapshots live in fixtures/wp5/schematic-snapshots.json;
// regenerate deliberately with WP5_UPDATE_SNAPSHOTS=1 node --test _tests/conductance/wp5-schematic.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { renderSchematic, compressLength, defaultMode, shareStep, shareFill, largestBore, SHARE_MIX }
    from '../../beta/conductance/js/ui/schematic.js';
import { analyze } from '../../beta/conductance/js/engine/network.js';
import { decodeItems, DEFAULT_RANGE } from '../../beta/conductance/js/ui/url-state.js';

const SNAP = new URL('./fixtures/wp5/schematic-snapshots.json', import.meta.url);
const PRESETS = [   // Appendix B: gas, boundary, items
    ['N2', { mode: 'pump', p0: 1e-4 }, 'tube(d=0.1,L=0.2)elbow(d=0.1,A=0.1,B=0.1)pump(S=0.3,d=0.1,label=Turbo)'],
    ['air', { mode: 'pump', p0: 1e-4 }, 'tube(d=0.1,L=0.2)pump(S=0.3,d=0.1,label=Pump)'],
    ['air', { mode: 'pump', p0: 100 }, 'tube(d=0.025,L=1)pump(S=0.009722222,d=0.025,label=Rotary_vane)'],
    ['N2', { mode: 'pump', p0: 1e-5 }, 'tube(d=0.04,L=0.15)bbox(C=0.08,gasRef=N2,d=0.04,label=Gate_valve)cone(d1=0.04,d2=0.063,L=0.05)pump(S=0.08,d=0.063,label=Turbo)'],
    ['N2', { mode: 'dp', p0: 10, p1: 0.01 }, 'orif(shape=circle,d=0.001)'],
    ['air', { mode: 'dp', p0: 1e5, p1: 1e3 }, 'slit(h=0.0001,w=0.05,L=0.01)'],
    ['N2', { mode: 'pump', p0: 1e-4 }, 'tube(d=0.05,L=0.1)par(tube(d=0.02,L=0.3);tube(d=0.03,L=0.5)elbow(d=0.03,A=0.05,B=0.05))pump(S=0.05,d=0.05,label=Turbo)'],
];
const model = ([gas, bc, i]) => ({ items: decodeItems(i), gas: { id: gas, T: 293.15, custom: null }, Cd: null, bc, range: { ...DEFAULT_RANGE } });
const draw = (m, opts = {}) => { const a = analyze(m); assert.ok(a.ok, JSON.stringify(a.errors)); return renderSchematic(a, { items: m.items, ...opts }); };

test('snapshots: all 7 presets in both modes and both bases are deterministic', () => {
    const got = {};
    PRESETS.forEach((p, k) => {
        for (const mode of ['scale', 'compressed']) for (const basis of ['op', 'mol']) {
            const r1 = draw(model(p), { mode, basis }), r2 = draw(model(p), { mode, basis });
            assert.equal(r1.svg, r2.svg);
            got[`preset${k + 1}-${mode}-${basis}`] = r1.svg;
        }
    });
    if (process.env.WP5_UPDATE_SNAPSHOTS === '1') {
        mkdirSync(new URL('./fixtures/wp5/', import.meta.url), { recursive: true });
        writeFileSync(SNAP, JSON.stringify(got, null, 1) + '\n');
    }
    const want = JSON.parse(readFileSync(SNAP, 'utf8'));
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort());
    for (const k of Object.keys(want)) assert.equal(got[k], want[k], k);
});

test('every element type has a glyph, and the items map back to their paths', () => {
    const m = model(['N2', { mode: 'pump', p0: 1e-4 },
        'orif(shape=circle,d=0.03)tube(d=0.05,L=0.1)slit(h=0.002,w=0.02,L=0.05)rect(a=0.01,b=0.03,L=0.1)ann(di=0.01,do=0.04,L=0.1)'
        + 'cone(d1=0.04,d2=0.063,L=0.05)elbow(d=0.063,A=0.05,B=0.1)bbox(C=0.1,gasRef=N2,d=0.04,label=Valve)chamber()'
        + 'par(tube(d=0.016,L=0.1);tube(d=0.016,L=0.2)orif(shape=rect,w=0.01,h=0.005))pump(S=0.08,d=0.063,label=Turbo)']);
    const r = draw(m, { mode: 'scale' });
    const paths = r.items.map((x) => x.path);
    assert.deepEqual(paths, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9.0.0', '9.1.0', '9.1.1', '10']);
    for (const x of r.items) assert.ok(x.x1 >= x.x0, x.path);
    for (const cls of ['cl-sch-plate', 'cl-sch-rod', 'cl-sch-hatch', 'cl-sch-bend', 'cl-sch-bbox', 'cl-sch-plenum', 'cl-sch-bus', 'cl-sch-thin', 'cl-sch-pump-tri']) {
        assert.ok(r.svg.includes(`class="${cls}`) || r.svg.includes(` ${cls}"`), cls);
    }
    assert.ok(/<path class="cl-sch-shape" d="M[^"]+Z"/.test(r.svg), 'cone trapezoid');
    assert.ok(r.svg.includes('<circle class="cl-sch-shape"'), 'pump circle');
    // a two-pressure line ends in a downstream volume; a no-effect orifice is drawn as a dashed marker
    const dp = draw(model(['N2', { mode: 'dp', p0: 10, p1: 1 }, 'tube(d=0.01,L=0.1)orif(shape=circle,d=0.02)tube(d=0.01,L=0.1)']));
    assert.ok(dp.svg.includes('Downstream') && dp.svg.includes('p₂'));
    assert.ok(dp.svg.includes('cl-sch-noeffect'));
});

test('desc and element titles', () => {
    const r = draw(model(PRESETS[0]), { mode: 'scale', basis: 'op' });
    assert.ok(r.svg.includes('<desc id="cl-sch-desc">Pumping line of 2 elements and a pump; element 1, the elbow, takes 69 % of the total resistance.</desc>'));
    assert.ok(r.svg.includes('role="group" aria-labelledby="cl-sch-title" aria-describedby="cl-sch-desc"') && r.svg.includes('<title id="cl-sch-title">'));
    const titles = [...r.svg.matchAll(/<g class="cl-sch-el[^"]*" data-path="([^"]+)" tabindex="0" role="button" aria-label="([^"]+)"><title>([^<]+)<\/title>/g)];
    assert.equal(titles.length, 3);
    assert.deepEqual(titles.map((t) => t[1]), ['0', '1', '2']);
    assert.equal(titles[0][3], 'Element 1 (tube), merged for the calculation: 68.8 % of the total resistance at this pressure; C = 201.2 L/s');
    assert.equal(titles[2][3], 'Element 3 (pump): 31.2 % of the total resistance at this pressure; S = 300 L/s');
    const mol = draw(model(PRESETS[0]), { basis: 'mol' });
    assert.ok(mol.desc.endsWith('(molecular-flow limit).'));
    assert.ok(mol.svg.includes('in molecular flow; C = 201.3 L/s'));
    const dp = draw(model(PRESETS[5]));
    assert.equal(dp.desc, 'Line of 1 element between two pressures; element 1, the slit, takes 100 % of the total resistance.');
    const pumpHeavy = draw(model(PRESETS[2]));
    assert.ok(pumpHeavy.desc.includes(', and the pump 83 %'), pumpHeavy.desc);
    const par = draw(model(PRESETS[6]));
    assert.ok(par.desc.includes('element 2.1.1, the tube'), par.desc);
    // user labels are escaped
    const odd = draw(model(['N2', { mode: 'pump', p0: 1e-4 }, 'tube(d=0.05,L=0.1)pump(S=0.05,d=0.05,label=a)']), { fmtSpeed: () => '<b>&"' });
    assert.ok(!odd.svg.includes('<b>&"'));
});

test('no colour literals in the output', () => {
    for (const p of PRESETS) for (const mode of ['scale', 'compressed']) {
        const svg = draw(model(p), { mode }).svg;
        assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(svg.replace(/url\(#[a-z-]+\)/g, '')), 'hex colour');
        assert.ok(!/\b(rgb|rgba|hsl|hsla)\(/.test(svg), 'functional colour');
        assert.ok(!/(fill|stroke)="(?!url\(|none)[a-z]/i.test(svg), 'named colour attribute');
        for (const m of svg.matchAll(/style="([^"]*)"/g)) assert.ok(/^(fill: color-mix\(in srgb, var\(--c2\) \d+%, var\(--surface\)\)|max-width: \d+px; min-width: \d+px)$/.test(m[1]), m[1]);
    }
});

test('scales, compression and share steps', () => {
    assert.equal(compressLength(0.1, 0.1), 0.1);
    assert.equal(compressLength(0.3, 0.1), 0.3 + 0);
    assert.ok(Math.abs(compressLength(1.3, 0.1) - (0.3 + 0.1 * Math.log(11))) < 1e-15);
    assert.equal(defaultMode(decodeItems(PRESETS[0][2])), 'scale');                 // 0.4 m vs 12 × 0.1 m
    assert.equal(defaultMode(decodeItems(PRESETS[2][2])), 'compressed');            // 1 m vs 12 × 25 mm
    assert.equal(largestBore(decodeItems(PRESETS[3][2])), 0.063);
    assert.deepEqual([0, 0.05, 0.051, 0.15, 0.3, 0.31, 0.5, 0.9].map(shareStep), [0, 0, 1, 1, 2, 3, 3, 4]);
    assert.equal(shareFill(0.6), `fill: color-mix(in srgb, var(--c2) ${SHARE_MIX[4]}%, var(--surface))`);
    // to scale: the largest bore is 120 units tall and lengths use the same scale
    const r = draw(model(PRESETS[1]), { mode: 'scale' });
    assert.ok(r.svg.includes('height="120"'), 'bore drawn 120 tall');
    assert.equal(r.items[0].x1 - r.items[0].x0, 240);                               // 0.2 m at 1200 units/m
    const c = draw(model(PRESETS[2]), { mode: 'compressed' });
    assert.ok(c.svg.includes('cl-sch-break'));
});
