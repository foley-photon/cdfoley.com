// WP4 contract: every workbench UI file exists and loads without a DOM, the exports and the panel registry match
// the specification (§2.5, §4), the page shell follows §4.1 and H6/H8, the canvas editing helpers keep expressions,
// and with the real platform the Einzel preset solves, runs and is described as the specification says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../beta/ion-optics/', import.meta.url));
const UI = '../../beta/ion-optics/js/ui/';
// the development stand-in (js/ui/dev/mock-jobs.js) was deleted at integration (spec §7.8)
const WP4_FILES = ['index.html', 'css/app.css', ...['main', 'dom', 'units', 'forms', 'colormaps', 'contour', 'view2d', 'render-field', 'tools', 'shortcuts', 'a11y', 'mobile'].map((f) => `js/ui/${f}.js`),
    ...['toolbar', 'electrodes', 'shapes', 'params', 'particles', 'fields', 'recording', 'domain', 'inspector', 'statusbar'].map((f) => `js/ui/panels/${f}.js`)];

test('every WP4 file exists and every module loads without a DOM', async () => {
    for (const f of WP4_FILES) assert.ok(existsSync(ROOT + f), f);
    for (const f of WP4_FILES.filter((x) => x.endsWith('.js'))) {
        const m = await import('../../beta/ion-optics/' + f);
        assert.ok(Object.keys(m).length > 0, f + ' has exports');
    }
});

test('production code never writes to the console and never names a commercial package', () => {
    const bad = [String.fromCharCode(115, 105, 109, 105, 111, 110)];
    for (const f of WP4_FILES) {
        const src = readFileSync(ROOT + f, 'utf8');
        if (f.endsWith('.js')) assert.ok(!/\bconsole\s*\./.test(src), `${f} uses console`);
        for (const w of bad) assert.ok(!src.toLowerCase().includes(w), `${f} names an incumbent product`);
        assert.ok(!/\beval\s*\(|new Function\s*\(/.test(src), `${f} evaluates code`);
        // markup is written only from the constant icon table (user strings go through textContent)
        assert.ok(!/\binnerHTML\s*=(?!\s*P\[name\] \|\| P\.info;)/.test(src), `${f} writes innerHTML`);
    }
});

test('page shell (§4.1, H6, H8)', () => {
    const html = readFileSync(ROOT + 'index.html', 'utf8');
    assert.match(html, /<title>Ion Optics Workbench \(beta\)<\/title>/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(html, /<meta name="description" content="[^"]*Not yet validated by the author\.">/);
    assert.ok(!/rel="canonical"|property="og:|application\/ld\+json/.test(html), 'no canonical, OG or JSON-LD');
    assert.match(html, /<body data-section="beta">/);
    assert.match(html, /<a class="skip-link" href="#io-canvas">/);
    assert.match(html, /<p class="io-beta callout callout-warn" role="note"><strong>Beta: not yet validated by the author\.<\/strong>/);
    assert.match(html, /href="help\/#validation"/);
    assert.match(html, /Independent software written from the open literature\. Not affiliated with any commercial ion-optics package\./);
    assert.ok(html.indexOf('/assets/css/site.css') < html.indexOf('css/app.css') && html.indexOf('css/app.css') < html.indexOf('css/results.css') && html.indexOf('css/results.css') < html.indexOf('css/presets.css'));
    assert.match(html, /<script src="\/assets\/js\/site\.js"><\/script>/);
    assert.match(html, /<script defer src="\/assets\/js\/plot\.js"><\/script>/);
    assert.match(html, /<script type="module" src="js\/ui\/main\.js"><\/script>/);
    assert.ok(!/calc\.js/.test(html), 'no calc.js');
    assert.ok(!/data-out/.test(html), 'no data-out attribute');
    assert.match(html, /<canvas id="io-canvas"[^>]*tabindex="0"[^>]*role="img"[^>]*data-guide="canvas"/);
    assert.match(html, /<div id="io-live" class="visually-hidden" aria-live="polite">/);
    assert.match(html, /<div id="site-header"><\/div>/);
    assert.match(html, /<div id="site-footer"><\/div>/);
    // relative app URLs only (the folder may move)
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) if (m[1].startsWith('/')) assert.ok(m[1].startsWith('/assets/'), m[1]);
});

test('panel registry, context and coach-mark targets (§2.5)', async () => {
    const M = await import(UI + 'main.js');
    assert.deepEqual(M.RAIL_TABS.map((t) => t.id), ['electrodes', 'shapes', 'params', 'particles', 'fields', 'recording', 'domain']);
    const dock = Object.fromEntries(M.DOCK_PANELS.map((p) => [p.id, p.path]));
    assert.deepEqual(dock, {
        summary: './panels/results.js', hits: './panels/hits.js', planes: './panels/planes.js', tof: './panels/tof.js', lens: './panels/lens.js',
        profile: './panels/profile.js', scan: './panels/scan.js', compare: './panels/compare.js', bench: './panels/benchmarks.js', log: './panels/log.js',
    });
    assert.equal(M.DOCK_PANELS.find((p) => p.id === 'compare').planned, true);
    assert.equal(M.DOCK_PANELS.find((p) => p.id === 'scan').title, 'Scan & tune');
    assert.equal(M.DIALOG_MODULES.presets, './panels/presets.js');
    assert.equal(M.DIALOG_MODULES.guide, './panels/guide.js');
    for (const k of ['loadPlatform', 'createContext', 'openDialog', 'toast', 'announce', 'togglePopover']) assert.equal(typeof M[k], 'function', k);
    const platform = { schema: await import('../../beta/ion-optics/js/engine/schema.js'), hash: {}, io: {}, expr: {} };
    const ctx = M.createContext({ store: {}, jobs: {}, persist: {}, pool: null, view: {}, platform, ui: { announce: () => {}, toast: () => {}, openDialog: () => {} } });
    for (const k of ['store', 'jobs', 'persist', 'pool', 'view', 'ui', 'engine', 'plots']) assert.ok(k in ctx, k);
    for (const k of ['dom', 'units', 'forms', 'colormaps', 'announce', 'toast', 'openDialog']) assert.ok(ctx.ui[k], 'ui.' + k);
    for (const k of ['schema', 'hash', 'io', 'layout', 'constants', 'analysis', 'geometry', 'exact', 'lensprops', 'optimize']) assert.ok(k in ctx.engine, 'engine.' + k);
    assert.equal(typeof ctx.commit, 'function');
    // coach-mark targets
    const src = ['panels/toolbar.js', 'main.js', 'panels/electrodes.js'].map((f) => readFileSync(ROOT + 'js/ui/' + f, 'utf8')).join('\n');
    for (const g of ['toolbar:solve', 'toolbar:run', 'toolbar:live', 'toolbar:presets', 'toolbar:share', "'rail:'", "'dock:'", "'electrode:'"]) assert.ok(src.includes(g), g);
});

test('view API, layers and raster helpers', async () => {
    const V = await import(UI + 'view2d.js');
    assert.equal(typeof V.createView, 'function');
    assert.deepEqual({ ...V.DEFAULT_LAYERS }, { potential: true, contours: 20, field: false, electrodes: true, trajectories: 'source', planes: true, hits: true, grid: 'auto', mirror: true, markers: false });
    const rows = new Float64Array(24);
    assert.equal(V.summaryRows({ summary: rows }), rows);
    assert.equal(V.summaryRows({ summary: { launched: 1 }, rows }), rows);
    assert.equal(V.summaryRows({ summary: { launched: 1 } }), null);
    const RF = await import(UI + 'render-field.js');
    for (const t of [0, 0.25, 0.5, 0.9]) { const w = RF.cubicWeights(t); assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-15); }
    assert.deepEqual(RF.cubicWeights(0), [0, 1, 0, 0]);
    // view source declares the overlay API of §2.5
    const src = readFileSync(ROOT + 'js/ui/view2d.js', 'utf8');
    for (const k of ['addOverlay', 'removeOverlay', 'requestRender', 'worldToScreen', 'screenToWorld', 'fit', 'getBox', 'setDisplayTime', 'highlightParticle', 'on']) assert.match(src, new RegExp(`\\b${k}\\b`), k);
});

test('shortcut table covers §4.12', async () => {
    const S = await import(UI + 'shortcuts.js');
    const keys = S.SHORTCUTS.map((s) => s[0]).join(' | ');
    for (const k of ['S', 'R', 'L', 'Esc', 'V', 'H', 'B', 'T', 'C', 'P', 'M', 'Shift+P', 'Delete', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+D', 'Arrows', '[', '0', '+', '?']) assert.ok(keys.includes(k), k);
    assert.equal(S.inTextField({ nodeType: 1, tagName: 'INPUT', type: 'text' }), true);
    assert.equal(S.inTextField({ nodeType: 1, tagName: 'INPUT', type: 'checkbox' }), false);
    assert.equal(S.inTextField({ nodeType: 1, tagName: 'BUTTON' }), false);
});

test('canvas editing helpers: handles, moves, snapping, expressions kept', async () => {
    const T = await import(UI + 'tools.js');
    assert.deepEqual(T.TOOL_DEFS.map((t) => t.id), ['select', 'pan', 'box', 'tube', 'plate', 'disc', 'circle', 'annulus', 'polygon', 'line', 'quadric', 'source', 'plane', 'measure', 'probe']);
    // offsets merge into a trailing number and leave other expressions intact
    assert.equal(T.offsetExpr('D/2+1', 0.5), 'D/2+1.5');
    assert.equal(T.offsetExpr('D/2+1', -1), 'D/2');
    assert.equal(T.offsetExpr('-0.3*D', 1.25), '-0.3*D+1.25');
    assert.equal(T.offsetExpr('a-b*2', -0.5), 'a-b*2-0.5');
    assert.equal(T.offsetExpr('x*-2', 1), 'x*-2+1');
    assert.equal(T.offsetExpr('D', 0), 'D');
    // every shape type has handles, and each handle edit stays valid
    const shapes = {
        box: { type: 'box', x0: 0, x1: 10, y0: 2, y1: 5 }, tube: { type: 'tube', x0: -5, x1: 5, rIn: 10, rOut: 11 }, plate: { type: 'plate', x: 0, t: 1, rHole: 2, rOut: 10 },
        disc: { type: 'disc', x: 3, t: 1, r: 4 }, circle: { type: 'circle', cx: 1, cy: 2, r: 3 }, annulus: { type: 'annulus', cx: 0, cy: 0, rIn: 38, rOut: 40, a0: 0, a1: 127.28 },
        polygon: { type: 'polygon', points: [[0, 0], [4, 0], [2, 3]] }, polyline: { type: 'polyline', points: [[0, 0], [0, 5]] }, quadric: { type: 'quadric', A: 1, B: -1, C: 16, cx: 0, cy: 0, clip: [0, 11.2, 0, 11.2] },
    };
    for (const [type, s] of Object.entries(shapes)) {
        const H = T.shapeHandles(s);
        assert.ok(H.length >= 2, type);
        for (const hd of H) {
            const e = T.handleEdits(s, hd.id, hd.x + 0.7, hd.y + 0.3, { minSize: 1e-3 });
            assert.ok(e.size > 0, `${type}.${hd.id}`);
            const n = T.applyNumeric(s, e);
            if ('rIn' in n && 'rOut' in n) assert.ok(n.rIn < n.rOut, `${type}.${hd.id} radii ordered`);
            if ('x0' in n && 'x1' in n) assert.ok(n.x0 < n.x1, `${type}.${hd.id} x ordered`);
            if ('rHole' in n) assert.ok(n.rHole < n.rOut && n.t > 0);
        }
        const mv = T.applyNumeric(s, T.moveEdits(s, 2, 1));
        assert.notDeepEqual(mv, s, `${type} moves`);
    }
    // a drag of a parametric tube keeps its expressions (spec §4.5)
    const proj = { id: 's2', type: 'tube', electrode: 'centre', x0: '-0.2*D', x1: '0.2*D', rIn: 'D/2', rOut: 'D/2+1' };
    const res = { id: 's2', type: 'tube', x0: -4, x1: 4, rIn: 10, rOut: 11 };
    T.applyToProject(proj, res, T.moveEdits(res, 1.5, 0));
    assert.deepEqual([proj.x0, proj.x1, proj.rIn, proj.rOut], ['-0.2*D+1.5', '0.2*D+1.5', 'D/2', 'D/2+1']);
    T.applyToProject(proj, { ...res, rOut: 11 }, T.handleEdits(res, 'n', 0, 12));
    assert.equal(proj.rOut, 'D/2+2');
    // transformed shapes move through their translation
    const tr = { type: 'box', x0: 0, x1: 2, y0: 0, y1: 1, transform: { translate: [1, 0], rotate: 30, about: [0, 0], mirror: 'none' } };
    const e = T.moveEdits(tr, 0.5, -0.5);
    assert.deepEqual([...e.keys()], ['transform.translate[0]', 'transform.translate[1]']);
    const xf = T.makeTransform({ translate: [3, -1], rotate: 37, about: [1, 2], mirror: 'x' });
    for (const [x, y] of [[0, 0], [5, -2], [1.5, 7]]) { const [wx, wy] = T.toWorld(xf, x, y); const [lx, ly] = T.toLocal(xf, wx, wy); assert.ok(Math.hypot(lx - x, ly - y) < 1e-12); }
    // drags make the shape types the tools draw
    assert.deepEqual(T.shapeFromDrag('box', [0, 0], [10, 5]), { x0: 0, x1: 10, y0: 0, y1: 5 });
    assert.deepEqual(T.shapeFromDrag('tube', [-5, 10], [5, 11], { fold: true }), { x0: -5, x1: 5, rIn: 10, rOut: 11 });
    assert.equal(T.shapeFromDrag('plate', [0, 2], [0, 10], { fold: true, h: 0.25 }).rHole, 2);
    assert.equal(T.shapeFromDrag('circle', [0, 0], [3, 4]).r, 5);
    assert.equal(T.shapeFromDrag('box', [0, 0], [0, 5]), null);
    // snapping: vertices first, then the axis, edges, nodes or a decimal grid
    const opts = { scale: 20, dom: { x0: 0, y0: 0, h: 0.5 }, vertices: [3.02, 4.01], segments: [Float64Array.from([0, 10, 10, 10])], lines: [{ y: 0, kind: 'axis' }] };
    assert.deepEqual(T.snapPoint(3.1, 4.1, opts), { x: 3.02, y: 4.01, kind: 'vertex' });
    assert.equal(T.snapPoint(2.2, 0.1, opts).kind, 'axis');
    assert.equal(T.snapPoint(6.13, 9.9, opts).kind, 'edge');
    assert.deepEqual(T.snapPoint(6.13, 6.8, opts), { x: 6, y: 7, kind: 'node' });
    assert.deepEqual(T.snapPoint(6.13, 6.8, { scale: 2, dom: { x0: 0, y0: 0, h: 0.5 } }), { x: 5, y: 5, kind: 'grid' }, '5 mm grid at 2 px/mm');
    assert.deepEqual(T.snapPoint(6.13, 6.8, { scale: 7, dom: { x0: 0, y0: 0, h: 0.5 } }), { x: 6, y: 6, kind: 'grid' }, '2 mm grid at 7 px/mm');
    assert.equal(T.niceLength(37), 50);
});

test('the Einzel preset with the real platform: solve, run, describe, read out (§4.8, §4.12)', { timeout: 120000 }, async () => {
    const A = await import(UI + 'a11y.js');
    const SB = await import(UI + 'panels/statusbar.js');
    const TB = await import(UI + 'panels/toolbar.js');
    const { createStore } = await import(UI + 'store.js');
    const { createJobs } = await import(UI + 'jobs.js');
    const { presetById } = await import('../../beta/ion-optics/js/presets/index.js');
    const analysis = await import('../../beta/ion-optics/js/engine/analysis.js');
    // no worker pool: jobs runs the engine core on this thread, as the page does when module workers are unavailable
    const store = createStore(presetById('einzel').build(), { mobile: false });
    const jobs = createJobs(store, null, null, { mobile: false, autoSolveDelayMs: 0, previewDelayMs: 0 });
    try {
        const e = jobs.estimate();
        assert.equal(e.nodes, 801 * 65);
        assert.equal(e.bases, 2);
        const finished = () => { const r = store.get().run; return r.status === 'done' && r.result && !r.live; };
        for (let k = 0; k < 3000 && !finished(); k++) await new Promise((r) => setTimeout(r, 10));
        assert.ok(finished(), 'the platform solved and ran the preset by itself');
        checkEinzel(store.get());
    } finally { jobs.destroy(); jobs.pool.terminate(); }

    function checkEinzel(st) {
        assert.equal(st.solve.status, 'done');
        assert.equal(st.run.result.n, 21);
        assert.equal(A.canvasLabel(st, analysis), 'Einzel lens, cylindrical, 3 electrodes, 21 trajectories, waist at x = 78.9 mm, transmission 100%');
        const w = A.waistOf(st.run.result, st.resolved, analysis);
        assert.ok(Math.abs(w.position - 78.91) < 2, `waist ${w.position}`);
        const d = A.describeScene(st, analysis);
        for (const part of ['Einzel lens', 'cylindrically symmetric', 'Center tube at 850 V', '21 particles', 'transmission 100%', 'beam waist']) assert.ok(d.includes(part), part);
        // the summary object form of a run gives the same statistics
        const stats = A.runStats(st.run.result, st.resolved, analysis);
        assert.equal(stats.byStatus.DETECTED, 21);
        assert.equal(A.runStats({ ...st.run.result, summary: stats }, st.resolved, analysis), stats);
        // cursor read-out equals the field model exactly
        for (const [x, y] of [[10, 5], [-30, 2.5], [0.1, 9.9], [100, -3], [5, 0], [-3.9, 10.2]]) {
            const ro = SB.readoutAt(st, x, y, 0);
            const e4 = new Float64Array(4);
            st.field.model.E(0, x, y, 0, e4);
            assert.equal(ro.phi, e4[3]); assert.equal(ro.Ex, e4[0]); assert.equal(ro.Ey, e4[1]);
        }
        const inside = SB.readoutAt(st, 0, 10.5, 0);
        assert.equal(st.resolved.electrodes[inside.owner].id, 'centre');
        assert.equal(inside.phi, 850);
        assert.equal(SB.readoutAt(st, 500, 0, 0).inside, false);
        const mt = TB.methodsText(st);
        for (const part of ['801 × 65 nodes', 'Shortley–Weller', '2 basis fields', 'multigrid', 'Dormand–Prince', 'relativistic']) assert.ok(mt.includes(part), part);
    }
});
