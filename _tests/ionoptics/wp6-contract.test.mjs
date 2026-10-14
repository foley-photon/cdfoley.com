// WP6 contract and solo acceptance (spec §4.13, §4.14, §2.5, §7.7): preset modules and registry, valid projects,
// well-formed expectations, guides that target existing data-guide attributes, thumbnails from geometry outlines,
// the dialog modules' exports, the import rule for presets, and the help page contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as presetsIndex from '../../beta/ion-optics/js/presets/index.js';
import * as schema from '../../beta/ion-optics/js/engine/schema.js';
import * as geometry from '../../beta/ion-optics/js/engine/geometry.js';
import * as pipeline from '../../beta/ion-optics/js/engine/pipeline.js';
import * as io from '../../beta/ion-optics/js/engine/io.js';
import * as gallery from '../../beta/ion-optics/js/ui/panels/presets.js';
import * as guide from '../../beta/ion-optics/js/ui/panels/guide.js';
import { PRODUCT_NAME } from '../../beta/ion-optics/js/engine/version.js';

const { PRESETS, presetById, TAGS, DEFAULT_PRESET } = presetsIndex;
const APP = new URL('../../beta/ion-optics/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, APP), 'utf8');
const ENGINE = { schema, geometry };
const IDS = ['einzel', 'two-tube', 'aperture-lens', 'plate-mirror', 'cda-127', 'hemisphere', 'reflectron', 'rf-quadrupole', 'paul-trap', 'magnetic-sector', 'vmi'];
const METRICS = new Set(['transmission', 'statusFraction', 'detectedCount', 'waist', 'axisCrossing', 'energyError', 'fieldMagnitude', 'radiusRange', 'fanCrossing',
    'dispersion', 'planeCoord', 'planeSpread', 'trajectoryMax', 'meanTof', 'resolvingPower', 'peakSeparation', 'ringRadius', 'ringRatio', 'ringWidth', 'groupedBlur',
    'lens', 'imageX', 'scanOptimum', 'blurRatio']);
const BRITISH = /\b(colour\w*|centre\w*|centred|analyser\w*|analyse[sd]?|modelled|modelling|travelling|neighbour\w*|behaviour\w*|metres?|millimetres?|labelled|optimis\w*|organis\w*|favour\w*|grey)\b/i;

// ---------------------------------------------------------------- registry and module shape
test('presets/index.js exports the registry', () => {
    assert.ok(Array.isArray(PRESETS) && Object.isFrozen(PRESETS));
    assert.equal(typeof presetById, 'function');
    assert.deepEqual(PRESETS.map((p) => p.id), IDS, 'the eleven presets of §4.14 in gallery order');
    assert.equal(presetById('einzel'), PRESETS[0]);
    assert.equal(presetById('nope'), null);
    assert.equal(DEFAULT_PRESET, 'einzel');
    for (const p of PRESETS) for (const t of p.tags) assert.ok(TAGS[t], `${p.id}: tag ${t} has a label`);
});

test('every preset module has the §4.14 shape', () => {
    const orders = new Set();
    for (const p of PRESETS) {
        assert.ok(Object.isFrozen(p), `${p.id} frozen`);
        assert.match(p.id, /^[a-z0-9-]+$/);
        for (const k of ['title', 'blurb', 'tryThis']) assert.ok(typeof p[k] === 'string' && p[k].length > 5, `${p.id}.${k}`);
        assert.ok(Number.isInteger(p.order) && !orders.has(p.order), `${p.id}.order unique`);
        orders.add(p.order);
        assert.ok(p.domainType === 'cyl2d' || p.domainType === 'planar2d', `${p.id}.domainType`);
        assert.ok(Array.isArray(p.tags) && p.tags.length > 0, `${p.id}.tags`);
        assert.equal(typeof p.build, 'function');
        assert.ok(Array.isArray(p.expect) && p.expect.length > 0, `${p.id}.expect`);
        assert.ok(p.guide === null || typeof p.guide === 'object', `${p.id}.guide`);
    }
});

// ---------------------------------------------------------------- projects
test('every preset builds a fresh, valid project within the size limits', () => {
    for (const p of PRESETS) {
        const a = p.build(), b = p.build();
        assert.notEqual(a, b, `${p.id}: build() returns a new object`);
        a.params.push({ name: 'zz', value: 1, dim: 'none' });
        assert.ok(!b.params.some((q) => q.name === 'zz'), `${p.id}: projects share no state`);
        const proj = p.build();
        const v = schema.validate(proj);
        assert.deepEqual(v.errors, [], `${p.id}: ${v.errors.map((e) => e.path + ' ' + e.message).join('; ')}`);
        const r = schema.resolve(proj);
        assert.deepEqual(r.errors, [], `${p.id} resolves`);
        assert.deepEqual(r.warnings.map((w) => w.code), [], `${p.id}: no schema warnings`);
        assert.equal(proj.meta.preset, p.id);
        assert.ok(proj.meta.name && proj.meta.notes && proj.meta.notes.length > 100, `${p.id}: name and notes`);
        assert.equal(proj.domain.type, p.domainType);
        assert.ok(r.resolved.domain.N <= 210000, `${p.id}: ${r.resolved.domain.N} nodes ≤ 210k`);
        assert.ok(r.resolved.particleCount > 0 && r.resolved.particleCount <= 1000, `${p.id}: particle count`);
        for (const e of proj.electrodes) assert.match(e.color, /^#[0-9a-f]{6}$/i, `${p.id}: electrode ${e.id} colour`);
        assert.equal(JSON.stringify(JSON.parse(JSON.stringify(proj))), JSON.stringify(proj), `${p.id}: plain JSON`);
    }
});

test('preset share links stay under 4 kB (spec §4.10)', async () => {
    for (const p of PRESETS) {
        const link = await io.encodeShare(p.build());
        assert.ok(link.length <= 4096, `${p.id}: ${link.length} characters`);
        const back = await io.decodeShare('#' + link);
        assert.equal(back.meta.preset, p.id);
    }
});

test('presets raise no geometry warnings (shorts, thin or buried shapes, clipped axis)', () => {
    for (const p of PRESETS) {
        const r = pipeline.resolveOrThrow(p.build());
        const { warnings } = pipeline.prepare(r);
        assert.deepEqual(warnings.map((w) => `${w.code} ${w.path || ''}`), [], p.id);
    }
});

test('the default project is the Einzel lens of §2.2.1', () => {
    const p = presetById('einzel').build();
    assert.deepEqual(p.params.map((q) => [q.name, q.value]), [['D', 20], ['Vc', 850]]);
    assert.deepEqual([p.domain.cell, p.domain.x, p.domain.y], [0.25, [-60, 140], [0, 16]]);
    assert.deepEqual(p.electrodes.map((e) => [e.id, e.v]), [['gnd', undefined], ['outer', 0], ['centre', 'Vc']]);
    assert.deepEqual(p.shapes.map((s) => [s.x0, s.x1, s.rIn, s.rOut]), [[-55, '-0.3*D', 'D/2', 'D/2+1'], ['-0.2*D', '0.2*D', 'D/2', 'D/2+1'], ['0.3*D', 55, 'D/2', 'D/2+1']]);
    assert.equal(p.sources[0].count, 21);
    assert.equal(p.recording.planes[0].at, 135);
});

// ---------------------------------------------------------------- expectations
test('expectations are well-formed data with design-phase and re-measured values', () => {
    for (const p of PRESETS) {
        const ids = new Set();
        for (const c of p.expect) {
            assert.ok(typeof c.id === 'string' && !ids.has(c.id), `${p.id}: check id ${c.id} unique`);
            ids.add(c.id);
            assert.ok(typeof c.label === 'string' && c.label.length > 3, `${p.id}.${c.id}: label`);
            assert.ok(METRICS.has(c.metric), `${p.id}.${c.id}: known metric ${c.metric}`);
            const hasBound = c.info === true || c.min !== undefined || c.max !== undefined || ((c.tol !== undefined || c.rel !== undefined) && (c.target !== undefined || c.reference !== undefined));
            assert.ok(hasBound, `${p.id}.${c.id}: a tolerance, a bound or info`);
            assert.ok('check' in c, `${p.id}.${c.id}: design-phase value (may be null)`);
            assert.ok(c.measured !== null && c.measured !== undefined, `${p.id}.${c.id}: re-measured value stored`);
            if (c.target === null) assert.ok(typeof c.measured === 'number', `${p.id}.${c.id}: a recorded target`);
        }
    }
    // spec §4.14 tolerances that the presets carry
    const ck = (pid, cid) => presetById(pid).expect.find((c) => c.id === cid);
    assert.deepEqual([ck('einzel', 'waist').target, ck('einzel', 'waist').tol], [78.9, 2]);
    assert.deepEqual([ck('einzel', 'focus').target, ck('einzel', 'focus').tol], [91.7, 1.5]);
    assert.deepEqual([ck('cda-127', 'field').target, ck('cda-127', 'field').tol], [4, 0.01]);
    assert.deepEqual([ck('hemisphere', 'dispersion').target, ck('hemisphere', 'dispersion').tol], [2, 0.1]);
    assert.deepEqual([ck('magnetic-sector', 'spread100').max, ck('vmi', 'best').min, ck('vmi', 'best').max], [0.1, 0.685, 0.705]);
    assert.equal(ck('rf-quadrupole', 'pass100').min, 0.9);
    assert.equal(ck('reflectron', 'R100').min, 500);
});

// ---------------------------------------------------------------- guides
function wp4Targets() {
    const main = read('js/ui/main.js'), toolbar = read('js/ui/panels/toolbar.js'), electrodes = read('js/ui/panels/electrodes.js'), page = read('index.html');
    const block = (name) => { const i = main.indexOf(`export const ${name}`); return main.slice(i, main.indexOf(']);', i)); };
    const rail = [...block('RAIL_TABS').matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]);
    const dock = [...block('DOCK_PANELS').matchAll(/\{ id: '([a-z]+)'[^}]*\}/g)].filter((m) => !/planned: true/.test(m[0])).map((m) => m[1]);
    return {
        rail: main.includes("guide: 'rail:' + t.id") ? rail : [],
        dock: main.includes("guide: 'dock:' + p.id") ? dock : [],
        toolbar: [...toolbar.matchAll(/guide: 'toolbar:([a-z]+)'/g)].map((m) => m[1]),
        electrode: electrodes.includes("guide: 'electrode:' + id"),
        canvas: /data-guide="canvas"/.test(page),
    };
}

test('guides: Einzel 3 steps, RF quadrupole 2, VMI 2, reflectron 1; valid specs', () => {
    const steps = Object.fromEntries(PRESETS.map((p) => [p.id, p.guide ? p.guide.steps.length : 0]));
    assert.deepEqual(steps, { einzel: 3, 'two-tube': 0, 'aperture-lens': 0, 'plate-mirror': 0, 'cda-127': 0, hemisphere: 0, reflectron: 1, 'rf-quadrupole': 2, 'paul-trap': 0, 'magnetic-sector': 0, vmi: 2 });
    for (const p of PRESETS) if (p.guide) assert.deepEqual(guide.validateGuide(p.guide), [], p.id);
    assert.deepEqual(guide.guideTargets(presetById('einzel').guide), ['electrode:centre', 'rail:electrodes', 'dock:lens', 'toolbar:presets']);
    assert.ok(guide.validateGuide({ id: 'x', steps: [{ target: 'nowhere', title: 't', text: 'x' }] }).length > 0, 'bad targets are rejected');
});

test('guide steps target data-guide attributes that the workbench creates', () => {
    const t = wp4Targets();
    assert.ok(t.rail.length >= 7 && t.dock.length >= 9 && t.toolbar.includes('presets') && t.electrode && t.canvas, 'workbench targets found');
    for (const p of PRESETS) {
        if (!p.guide) continue;
        const proj = p.build();
        for (const target of guide.guideTargets(p.guide)) {
            const [kind, id] = target.split(':');
            if (kind === 'rail') assert.ok(t.rail.includes(id), `${p.id}: rail tab ${id}`);
            else if (kind === 'dock') assert.ok(t.dock.includes(id), `${p.id}: dock tab ${id}`);
            else if (kind === 'toolbar') assert.ok(t.toolbar.includes(id), `${p.id}: toolbar ${id}`);
            else if (kind === 'electrode') assert.ok(t.electrode && proj.electrodes.some((e) => e.id === id && !e.ground), `${p.id}: electrode ${id}`);
            else assert.equal(target, 'canvas');
        }
        // steps that point into a rail panel open that tab first
        for (const s of p.guide.steps) if (s.target.startsWith('electrode:')) assert.equal(s.open && s.open.rail, 'electrodes', `${p.id}: opens the Electrodes tab`);
    }
});

// ---------------------------------------------------------------- dialogs and thumbnails
test('the gallery and guide modules export the §2.5 dialog API', () => {
    assert.equal(typeof gallery.openGallery, 'function');
    assert.equal(gallery.openGallery.length, 1, 'openGallery(ctx, { firstVisit })');
    assert.equal(typeof gallery.presetThumbnail, 'function');
    assert.deepEqual(Object.keys(gallery.meta).sort(), ['id', 'order', 'title']);
    assert.equal(typeof guide.startGuide, 'function');
    assert.equal(guide.startGuide.length, 2, 'startGuide(ctx, guideSpec)');
    assert.equal(typeof guide.stopGuide, 'function');
});

test('thumbnails are drawn from geometry.outlines()', () => {
    for (const p of PRESETS) {
        const svg = gallery.presetThumbnail(p, ENGINE);
        assert.match(svg, /^<svg [^>]*viewBox="0 0 240 120"/, p.id);
        assert.ok(!/NaN|undefined|Infinity/.test(svg), `${p.id}: finite coordinates`);
        const r = schema.resolve(p.build()).resolved;
        const outlines = geometry.compileGeometry(r).outlines(2);
        const box = gallery.thumbnailBox(r);
        const images = 1 + (box.mx ? 1 : 0) + (box.my ? 1 : 0) + (box.mx && box.my ? 1 : 0);
        const shapes = (svg.match(/class="io-thumb-(el|void|line[^"]*)"/g) || []).length;
        assert.equal(shapes, outlines.length * images, `${p.id}: one path per outline and mirror image`);
        if (r.magnets.length) assert.ok(svg.includes('io-thumb-magnet'), `${p.id}: magnet region drawn`);
        for (const e of r.electrodes.slice(1)) assert.ok(svg.includes(`stroke="${e.color}"`), `${p.id}: electrode ${e.id} in its colour`);
        assert.equal(gallery.presetThumbnail(p, ENGINE), svg, 'cached');
    }
});

// ---------------------------------------------------------------- import rule and wording
test('preset modules import only engine/schema.js (and the registry its presets)', () => {
    const dir = new URL('js/presets/', APP);
    for (const f of readdirSync(fileURLToPath(dir))) {
        const src = readFileSync(new URL(f, dir), 'utf8');
        const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
        for (const i of imports) {
            if (f === 'index.js') assert.match(i, /^\.\/[a-z0-9-]+\.js$/, `index.js imports ${i}`);
            else assert.equal(i, '../engine/schema.js', `${f} imports ${i}`);
        }
        assert.ok(!/\bimport\s*\(/.test(src), `${f}: no dynamic imports`);
    }
});

test('visible preset and guide text uses American spelling', () => {
    for (const p of PRESETS) {
        const proj = p.build();
        const texts = [p.title, p.blurb, p.tryThis, proj.meta.name, proj.meta.notes, ...p.expect.map((c) => c.label + ' ' + (c.note || '')),
            ...proj.electrodes.map((e) => e.name), ...proj.sources.map((s) => s.name), ...proj.recording.planes.map((q) => q.name),
            ...(p.guide ? [p.guide.title, ...p.guide.steps.flatMap((s) => [s.title, s.text])] : [])];
        for (const t of texts) assert.ok(!BRITISH.test(t || ''), `${p.id}: "${(t || '').match(BRITISH)}" in "${t}"`);
    }
});

// ---------------------------------------------------------------- help page (§4.13, H6, H8)
test('the help page meets the page contract', () => {
    const html = read('help/index.html');
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.ok(!/rel="canonical"|property="og:|application\/ld\+json|twitter:/.test(html), 'no canonical, OG or JSON-LD');
    assert.ok(!/data-out/.test(html) && !/calc\.js/.test(html), 'no data-out, no calc.js');
    assert.match(html, /<div id="site-header"><\/div>/);
    assert.match(html, /<div id="site-footer"><\/div>/);
    assert.match(html, /href="\/assets\/css\/site\.css"/);
    assert.match(html, /<script src="\/assets\/js\/site\.js"><\/script>/);
    assert.match(html, /<body data-section="beta">/);
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(text, / Beta: not yet validated by the author\. /, 'the beta notice');
    assert.ok(text.includes('Independent software written from the open literature. Not affiliated with any commercial ion-optics package.'), 'the independence line');
    // the name appears only in <title>; the visible name comes from PRODUCT_NAME
    assert.equal(html.split(PRODUCT_NAME).length - 1, 1, 'product name only in <title>');
    assert.match(html, new RegExp(`<title>${PRODUCT_NAME} \\(beta\\)`));
    assert.match(html, /data-product-name/);
    for (const id of ['quick-start', 'units', 'geometry', 'accuracy', 'methods', 'validation', 'shortcuts', 'limitations', 'privacy', 'about', 'references']) {
        assert.match(html, new RegExp(`<h2 id="${id}"`), `section ${id}`);
    }
    const gates = [...Array(9)].map((_, i) => `K${i + 1}`).concat([...Array(10)].map((_, i) => `S${i + 1}`), [...Array(15)].map((_, i) => `T${i + 1}`), ['L1', 'L2', 'L3', 'L4']);
    assert.equal(gates.length, 38);
    for (const g of [...gates, 'L5', 'L6', 'L7', 'P1', 'P2', 'P3', 'P4']) assert.match(html, new RegExp(`<td class="io-id">${g}( |<)`), `case ${g} listed`);
    for (const topic of ['cubic', 'linear', 'accuracy check', 'cells across the aperture radius', 'quasistatic', 'no space charge', 'fringe fields', 'drifts on', 'is uploaded']) {
        assert.ok(text.toLowerCase().includes(topic), `help mentions "${topic}"`);
    }
    // links: site assets absolute, everything inside the app relative
    const abs = [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
    for (const a of abs) assert.match(a, /^\/assets\//, `absolute link ${a}`);
    assert.match(html, /href="\.\.\/"/, 'link back to the simulator');
    assert.ok(!BRITISH.test(text), `British spelling "${(text.match(BRITISH) || [])[0]}" on the help page`);
});

test('presets.css follows the site look (tokens, io- prefix)', () => {
    const css = read('css/presets.css');
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(noComments), 'colours only from CSS variables');
    for (const m of noComments.matchAll(/(^|[\s,}])\.([a-z][\w-]*)/g)) assert.ok(/^io-/.test(m[2]) || ['chip', 'btn', 'badge', 'icon-btn'].includes(m[2]), `class .${m[2]} has the io- prefix`);
});
