// WP5 contract (spec 2.9, 2.15, 4.1, 4.4, 5.4 rule 3): exported names, signatures, result shapes, and the page rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as storeM from '../../beta/conductance/js/ui/store.js';
import * as formatM from '../../beta/conductance/js/ui/format.js';
import * as urlM from '../../beta/conductance/js/ui/url-state.js';
import * as schM from '../../beta/conductance/js/ui/schematic.js';
import * as compM from '../../beta/conductance/js/ui/components-ui.js';
import * as stM from '../../beta/conductance/js/ui/selftest-ui.js';
import { analyze } from '../../beta/conductance/js/engine/network.js';

const read = (p) => readFileSync(new URL('../../beta/conductance/' + p, import.meta.url), 'utf8');
const UI = ['app.js', 'store.js', 'format.js', 'url-state.js', 'components-ui.js', 'schematic.js', 'selftest-ui.js'];

test('store.js (spec 2.15)', () => {
    assert.equal(typeof storeM.createStore, 'function');
    assert.equal(typeof storeM.currentGas, 'function');
    assert.deepEqual({ ...storeM.store.get() }, { gas: 'N2', T: 293.15, custom: null, Cd: null, lu: 'mm', su: 'L/s', pu: 'mbar' });
    const s = storeM.createStore({ a: 1 });
    const seen = [];
    const off = s.subscribe((st, keys) => seen.push([st.a, keys]));
    assert.equal(s.set({ a: 1 }), false);
    assert.equal(s.set({ a: 2, b: 3 }), true);
    off();
    s.set({ a: 4 });
    assert.deepEqual(seen, [[2, ['a', 'b']]]);
    const G = storeM.currentGas({ gas: 'air', T: 293.15, custom: null, Cd: null });
    assert.ok(Math.abs(G.vbar - 462.911) < 1e-3);
    assert.throws(() => storeM.currentGas({ gas: 'custom', T: 293.15, custom: { M: -1 }, Cd: null }), RangeError);
});

test('format.js (spec 2.15)', () => {
    for (const [name, len] of [['toSI', 3], ['fromSI', 3], ['fmt', 2], ['fmtPct', 1], ['fmtNum', 1], ['fmtCI', 4], ['parseInput', 1], ['setCalc', 1]]) {
        assert.equal(typeof formatM[name], 'function', name);
        assert.equal(formatM[name].length, len, name);
    }
    assert.deepEqual([...formatM.UNITS.length], ['mm', 'cm', 'm', 'in', 'µm']);
    assert.deepEqual([...formatM.UNITS.speed], ['L/s', 'm³/h', 'L/min', 'cfm', 'm³/s']);
    assert.deepEqual([...formatM.UNITS.pressure], ['Pa', 'mbar', 'Torr', 'mTorr', 'µbar', 'atm']);
    assert.deepEqual([...formatM.UNITS.pv], ['Pa·m³/s', 'mbar·L/s', 'Torr·L/s', 'sccm']);
    assert.deepEqual([...formatM.UNITS.temperature], ['°C', 'K', '°F']);
    assert.equal(typeof formatM.fmt('speed', 0.1), 'string');
});

test('url-state.js (spec 2.9)', () => {
    for (const n of ['encode', 'decode', 'encodeItems', 'decodeItems', 'encodeNumber', 'defaultState']) assert.equal(typeof urlM[n], 'function', n);
    const d = urlM.decode('');
    assert.deepEqual(Object.keys(d).sort(), ['kind', 'notice', 'state']);
    assert.deepEqual(Object.keys(d.state).sort(), ['model', 'tab', 'units']);
    assert.deepEqual(Object.keys(d.state.model).sort(), ['Cd', 'bc', 'gas', 'items', 'range']);
    assert.equal(typeof urlM.encode(d.state), 'string');
    assert.equal(urlM.BAD_LINK_NOTE, 'This link could not be read, so the default example is shown.');
});

test('schematic.js (spec 4.4)', () => {
    assert.equal(typeof schM.renderSchematic, 'function');
    assert.equal(schM.renderSchematic.length, 1);
    const m = compM.presetModel(0), a = analyze(m);
    const r = schM.renderSchematic(a, { mode: 'scale', basis: 'op', fmtLen: (x) => x * 1000 + ' mm', items: m.items });
    assert.deepEqual(Object.keys(r).filter((k) => k !== 'desc').sort(), ['height', 'items', 'svg', 'width']);
    assert.ok(r.svg.startsWith('<svg') && r.svg.endsWith('</svg>'));
    assert.ok(Number.isInteger(r.width) && Number.isInteger(r.height));
    for (const it of r.items) assert.deepEqual(Object.keys(it).sort(), ['path', 'x0', 'x1']);
});

test('components-ui.js and selftest-ui.js export mount and their pure helpers', () => {
    assert.equal(typeof compM.mount, 'function');
    assert.equal(compM.mount.length, 1);
    for (const n of ['presetModel', 'insertItem', 'removeItem', 'moveItem', 'duplicateItem', 'addBranch', 'removeBranch', 'addToBranch', 'setBoundary',
        'flagSentence', 'checksFor', 'bandBadge', 'elementsCSV', 'mcStatusLine']) assert.equal(typeof compM[n], 'function', n);
    assert.equal(typeof stM.mount, 'function');
    for (const n of ['casesFor', 'summaryLine', 'deviceLine', 'toCSV', 'toJSON', 'fileName']) assert.equal(typeof stM[n], 'function', n);
});

test('app.js: APP_NAME, the shared runner and the worker probe (source check; app.js needs a DOM)', () => {
    const src = read('js/ui/app.js');
    assert.ok(src.includes("export const APP_NAME = 'Conductance Lab';"));
    assert.ok(/export function getRunner\(\)/.test(src));
    assert.ok(/export function probeWorkers\(/.test(src));
    assert.ok(src.includes("new Worker(new URL('../workers/tpmc-worker.js', import.meta.url), { type: 'module' })"));
    assert.ok(src.includes("import('./cad-ui.js')") && src.includes("import('./selftest-ui.js')"));
    assert.ok(src.includes("'#' + encode(") && src.includes("history.replaceState(null, '', lastHash)"));
    assert.ok(!/location\.hash\s*=/.test(src));
});

test('page rules (H1, H4, H5, H13, §4.1)', () => {
    const html = read('index.html');
    assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">'));
    for (const bad of ['rel="canonical"', 'og:', 'application/ld+json', 'data-out=']) assert.ok(!html.includes(bad), bad);
    assert.ok(html.includes('<strong>Beta: not yet validated by the author.</strong>'));
    assert.ok(html.includes('href="mailto:foley.photon@gmail.com"'));
    assert.ok(html.includes('<body data-section="beta">'));
    assert.ok(html.indexOf('type="importmap"') < html.indexOf('rel="modulepreload"'));
    assert.ok(html.indexOf('type="importmap"') < html.indexOf('type="module"'));
    assert.equal((html.match(/rel="modulepreload"/g) || []).length, 13);
    for (const src of html.matchAll(/<script[^>]+src="([^"]+)"/g)) assert.ok(/^(\/assets\/|\.\/js\/|https:\/\/cdnjs\.cloudflare\.com\/)/.test(src[1]), src[1]);
    for (const row of html.matchAll(/<div class="result(?: [^"]*)?"[^>]*>/g)) assert.ok(/\bhidden\b/.test(row[0]), row[0]);
    // the working name appears in exactly the title, the h1 and the breadcrumb (plus APP_NAME in app.js)
    assert.ok(html.includes('<title>Conductance Lab (beta) | Casey D. Foley, PhD</title>'));
    assert.ok(html.includes('<h1>Conductance Lab <span class="badge badge-warn">BETA</span></h1>'));
    assert.ok(html.includes('<li aria-current="page">Conductance Lab</li>'));
    assert.equal((html.match(/Conductance Lab/g) || []).length, 3);
    assert.ok(html.includes('<article class="prose cl-prose" id="how">'));
    for (const id of ['tab-components', 'tab-cad', 'tab-selftest', 'cad-root', 'selftest-root']) assert.ok(html.includes(`id="${id}"`), id);
});

test('no console calls in WP5 code; no colour literals in conductance.css', () => {
    for (const f of UI) assert.ok(!/\bconsole\s*\./.test(read('js/ui/' + f)), f);
    const css = read('conductance.css').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'hex');
    assert.ok(!/\b(rgb|rgba|hsl|hsla)\(/.test(css), 'functional colour');
    assert.ok(!/:\s*(white|black|red|blue|green|gray|grey)\b/.test(css), 'named colour');
});
