// Glazing beta: runs the page's validation runner (beta/glazing/selftest.js, cases V1 to V6 of the build
// specification, section 5) in Node and prints one table: one line per check (ok / FAIL, label, got, expected,
// tolerance) and a summary per group. Report-only quantities (the hard-coat transmission rows) are printed as
// "info" with --verbose and never pass or fail. Exits 1 on any failure, or when a full run does not count the
// specification's 237 checks (the Node prototype's 243 minus the 6 Node-only V1c checks, which run in
// wp3-wce.test.mjs).
//
//   node _tests/glazing/run-validation.mjs [--group=V1|V2|V3|V4|V5|V6] [--verbose]
//
// The scripts load in the page's order (helpers/load.mjs), and the shipped files are read from
// assets/data/glazing/ exactly as the page fetches them. Our own code.
import fs from 'node:fs';
import path from 'node:path';
import { load, ROOT } from './helpers/load.mjs';

const EXPECTED_TOTAL = 237;
const args = process.argv.slice(2);
let group = null, verbose = false;
for (const a of args) {
    if (a === '--verbose') verbose = true;
    else if (a.startsWith('--group=')) group = a.slice(8).toUpperCase();
    else { console.error('run-validation.mjs: unknown argument ' + a + ' (use --group=V1..V6 and --verbose)'); process.exit(2); }
}

const ctx = load.all();
const ST = ctx.GlazingSelfTest;
if (group && !ST.GROUPS.includes(group)) { console.error('run-validation.mjs: unknown group ' + group + ' (one of ' + ST.GROUPS.join(', ') + ')'); process.exit(2); }

const DATA = path.join(ROOT, 'assets/data/glazing');
const json = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const run = await ST.run({
    E: ctx.GlazingEngine, O: ctx.GlazingOpen, P: ctx.GlazingProducts, B: ctx.GlazingBeta,
    published: json('published.json'), manifest: json('manifest.json'), solarE891: ctx.GlazingSolarE891.solarE891,
    loadBytes: p => fs.promises.readFile(path.join(DATA, p))
});

const num = x => typeof x === 'number' ? (Number.isInteger(x) ? String(x) : String(+x.toPrecision(6))) : String(x);
const pad = (s, n) => s.length >= n ? s : s + ' '.repeat(n - s.length);
const groups = run.groups.filter(g => !group || g.id === group);
let pass = 0, fail = 0, infos = 0;
const out = [];
for (const g of groups) {
    out.push('');
    out.push(g.id + '  ' + (ST.LABELS && ST.LABELS[g.id] ? ST.LABELS[g.id] : g.label || ''));
    for (const it of g.items) {
        if (it.info) { infos++; if (!verbose) continue; }
        const mark = it.info ? 'info' : it.ok ? 'ok  ' : 'FAIL';
        const tol = it.info ? 'report only' : '± ' + num(it.tol);
        out.push('  ' + mark + '  ' + pad(it.label, 72) + '  got ' + pad(num(it.got), 12) + '  expected ' + pad(num(it.exp), 12) + '  ' + tol);
    }
    out.push('  ' + g.id + ': ' + g.pass + ' passed, ' + g.fail + ' failed' + (g.items.some(i => i.info) ? ', ' + g.items.filter(i => i.info).length + ' report-only' : ''));
    pass += g.pass; fail += g.fail;
}
out.push('');
out.push('Summary: ' + groups.map(g => g.id + ' ' + g.pass + '/' + (g.pass + g.fail)).join(', '));
out.push('Total: ' + pass + ' passed, ' + fail + ' failed' + (infos ? ', ' + infos + ' report-only' : '') + ' (' + Math.round(run.ms) + ' ms)');
let bad = fail > 0;
if (!group && pass + fail !== EXPECTED_TOTAL) {
    out.push('Expected ' + EXPECTED_TOTAL + ' checks in a full run, counted ' + (pass + fail) + '.');
    bad = true;
}
console.log(out.join('\n'));
process.exit(bad ? 1 : 0);
