// V11 (WP4): beta/glazing/selftest.js run in Node with a file loader: 237 checks, 0 failures (spec 4.10, 5.4).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, ROOT } from './helpers/load.mjs';

const ctx = load.all();
const DATA = path.join(ROOT, 'assets/data/glazing');
const json = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
function context(extra = {}) {
    const reads = [];
    return Object.assign({
        E: ctx.GlazingEngine, O: ctx.GlazingOpen, P: ctx.GlazingProducts, B: ctx.GlazingBeta,
        published: json('published.json'), manifest: json('manifest.json'), solarE891: ctx.GlazingSolarE891.solarE891,
        loadBytes: p => { reads.push(p); return fs.promises.readFile(path.join(DATA, p)); }, reads
    }, extra);
}

test('selftest.js: 237 checks, 0 failures, with the group counts of the specification', async () => {
    const c = context();
    const progress = [];
    const res = await ctx.GlazingSelfTest.run(c, p => progress.push(p.group));
    const by = Object.fromEntries(res.groups.map(g => [g.id, [g.pass, g.fail]]));
    const failed = res.groups.flatMap(g => g.items.filter(i => i.ok === false).map(i => `${g.id} ${i.label}: got ${i.got}, expected ${i.exp} ± ${i.tol}`));
    assert.equal(failed.length, 0, failed.join(String.fromCharCode(10)));
    assert.equal(res.fail, 0);
    assert.equal(res.pass, 237);
    // V1 17, V2 41, V3 42, V4 + V5 105 (61 + 44), V6 32: the prototype's 243 minus the 6 Node-only V1c checks.
    assert.deepEqual(JSON.parse(JSON.stringify(by)), { V1: [17, 0], V2: [41, 0], V3: [42, 0], V4: [61, 0], V5: [44, 0], V6: [32, 0] });
    assert.deepEqual(JSON.parse(JSON.stringify(res.groups.map(g => g.id))), JSON.parse(JSON.stringify(ctx.GlazingSelfTest.GROUPS)));
    assert.ok(progress.length >= 5);
    assert.ok(res.ms >= 0);
    // report-only items (hard-coat transmission) are listed but not counted
    const info = res.groups.flatMap(g => g.items.filter(i => i.info));
    assert.ok(info.length >= 16 && info.every(i => i.ok === null && i.tol === null));
    for (const g of res.groups) assert.equal(g.items.filter(i => !i.info).length, g.pass + g.fail);
    // it read only shipped files, each once: the 4 pyWinCalc files and the WCE file
    assert.deepEqual(c.reads.slice().sort(), ['lbnl/pywincalc/CLEAR5.LOF', 'lbnl/pywincalc/CLEAR_3.DAT', 'lbnl/pywincalc/CLEAR_6.DAT', 'lbnl/pywincalc/LOW-E_5.LOF', 'lbnl/wce/spectralSampleData.cpp']);
});

test('selftest.js: key values of the specification tables', async () => {
    const res = await ctx.GlazingSelfTest.run(context());
    const item = (g, re) => res.groups.find(x => x.id === g).items.find(i => re.test(i.label));
    assert.ok(Math.abs(item('V1', /2191.*: T$/).got - 0.5862) < 2e-4);
    assert.ok(Math.abs(item('V2', /IGDB 102 .*G173: Tvis/).got - 89.88) < 0.01);
    assert.ok(Math.abs(item('V3', /IGDB 5439 in vitro-6-sb70-s2: VT/).got - 63.7) < 0.06);
    assert.ok(Math.abs(item('V6', /^triple .*spectral RMS/).got - 1.88) < 0.05);
    const hardVT = item('V3', /IGDB 9923 in pilk-4-ea-s3: VT/);
    assert.ok(hardVT.info && Math.abs(hardVT.got - 74.1) < 0.06);
});

test('selftest.js: loads manifest and published values itself when ctx omits them; a failed file rejects with its message', async () => {
    const res = await ctx.GlazingSelfTest.run(context({ manifest: null, published: null }));
    assert.equal(res.pass, 237);
    await assert.rejects(ctx.GlazingSelfTest.run(context({ loadBytes: p => Promise.reject(new Error('Could not load ' + p.split('/').pop() + ': 404. Check your connection and try again.')) })),
        /Could not load .*: 404/);
});

test('selftest.js is environment-agnostic: no test helpers, no fetch, no DOM', () => {
    const src = fs.readFileSync(path.join(ROOT, 'beta/glazing/selftest.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // comments may cite the test files
    assert.ok(!/_tests|helpers\/|require\(|^\s*import\s|fetch\(|document\./m.test(code));
    assert.ok(/root\.GlazingSelfTest = api/.test(src) && /module\.exports = api/.test(src));
});

// The self-test compares U-factors in Btu/h·ft²·°F. Its unit constant is the page's one constant, read from
// GlazingBeta (GlazingUnits.BTU on the page, where glazing-units.js loads first), not a private copy.
test('selftest.js takes its unit constant from GlazingBeta; same 237 checks with the units module loaded as on the page', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'beta/glazing/selftest.js'), 'utf8');
    assert.ok(!/5\.678263/.test(src), 'no private Btu constant');
    assert.ok(/var BTU = B\.BTU;/.test(src));
    assert.equal(ctx.GlazingBeta.BTU, 5.678263);
    const ctx2 = load(['assets/js/glazing-units.js'].concat(load.FILES.all));
    assert.equal(ctx2.GlazingBeta.BTU, ctx2.GlazingUnits.BTU);
    assert.equal(ctx2.GlazingBeta.BTU, 5.678263);
    const reads = [];
    const run = (c, extra) => c.GlazingSelfTest.run(Object.assign({
        E: c.GlazingEngine, O: c.GlazingOpen, P: c.GlazingProducts, B: c.GlazingBeta,
        published: json('published.json'), manifest: json('manifest.json'), solarE891: c.GlazingSolarE891.solarE891,
        loadBytes: p => { reads.push(p); return fs.promises.readFile(path.join(DATA, p)); }
    }, extra));
    const a = await run(ctx), b = await run(ctx2);
    assert.equal(b.pass, 237); assert.equal(b.fail, 0);
    // every U-factor check gives the same number either way
    const items = r => r.groups.flatMap(g => g.items.map(i => [g.id, i.label, i.got, i.exp, i.tol, i.ok]));
    assert.deepEqual(JSON.parse(JSON.stringify(items(b))), JSON.parse(JSON.stringify(items(a))));
    assert.ok(items(b).filter(i => /\(Btu\)/.test(i[1])).length >= 10);
    // a different constant would move them: the checks really read B.BTU
    const B3 = Object.assign({}, ctx.GlazingBeta, { BTU: 5.678263 * 1.1 });
    const c3 = await run(ctx, { B: B3 });
    assert.ok(c3.fail > 0);
});
