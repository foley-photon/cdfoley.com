// Validation-suite runner (spec 1.3, 5.4):
//   node _tests/ionoptics/bench.mjs [--level quick|full] [--only K1,S3] [--json E:/path/bench.json] [--update-golden] [--verbose]
// Prints ID, value, reference, deviation, tolerance, status and time per case (the worst check of each case) and
// exits non-zero when a gate fails or errors. fixtures/wp5/bench-golden.json keeps every check value; values that
// moved by more than 1e-9 (relative) are reported as "changed". Nothing is written unless --json or --update-golden
// is given.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCHMARKS, runBenchmark } from '../../beta/ion-optics/js/engine/bench/cases.js';
import { ENGINE_VERSION } from '../../beta/ion-optics/js/engine/version.js';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolvePath(here, 'fixtures/wp5/bench-golden.json');

function args(argv) {
    const o = { level: process.env.IONOPTICS_LEVEL === 'full' ? 'full' : 'quick', only: null, json: null, updateGolden: false, verbose: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--level') o.level = argv[++i] === 'full' ? 'full' : 'quick';
        else if (a.startsWith('--level=')) o.level = a.slice(8) === 'full' ? 'full' : 'quick';
        else if (a === '--only') o.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
        else if (a.startsWith('--only=')) o.only = a.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
        else if (a === '--json') o.json = argv[++i];
        else if (a.startsWith('--json=')) o.json = a.slice(7);
        else if (a === '--update-golden') o.updateGolden = true;
        else if (a === '--verbose' || a === '-v') o.verbose = true;
    }
    return o;
}

const fmt = (v) => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return `[${v.map(fmt).join(', ')}]`;
    if (typeof v !== 'number') return String(v);
    if (!Number.isFinite(v)) return String(v);
    if (v === 0) return '0';
    const a = Math.abs(v);
    return a >= 1e-3 && a < 1e6 ? String(+v.toPrecision(8)) : v.toExponential(3);
};
const tolText = (c) => (c.tolKind === 'bracket' ? (Array.isArray(c.tol) ? `[${c.tol.map(fmt).join(', ')}]` : 'equal') : `${c.tolKind} ${fmt(c.tol)}`);
/** Ratio |deviation|/tolerance (Infinity for a failed bracket) used to pick the worst check of a case. */
function severity(c) {
    if (!c.pass) return Infinity;
    if (c.tolKind === 'bracket') return 0;
    const t = typeof c.tol === 'number' && c.tol > 0 ? c.tol : 0;
    return t > 0 && Number.isFinite(c.deviation) ? Math.abs(c.deviation) / t : 0;
}
export function worstCheck(r) {
    let w = null, ws = -1;
    for (const c of r.checks || []) { const s = severity(c); if (s > ws) { ws = s; w = c; } }
    return w;
}
function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

export function table(results) {
    const lines = [];
    lines.push(`${pad('ID', 5)}${pad('Status', 8)}${pad('Worst check', 52)}${pad('Value', 16)}${pad('Reference', 16)}${pad('Deviation', 12)}${pad('Tolerance', 22)}Time`);
    for (const r of results) {
        const w = worstCheck(r);
        const st = r.status === 'info' && r.details && r.details.planned ? 'planned' : r.status;
        lines.push(`${pad(r.id, 5)}${pad(st, 8)}${pad(w ? w.label : (r.details && r.details.error) || '', 52)}${pad(w ? fmt(w.value) : '', 16)}${pad(w ? fmt(w.target) : '', 16)}${pad(w ? fmt(w.deviation) : '', 12)}${pad(w ? tolText(w) : '', 22)}${(r.ms / 1000).toFixed(2)} s`);
    }
    return lines.join('\n');
}

function goldenOf(results, level, prev = {}) {
    const g = { engineVersion: ENGINE_VERSION, note: 'Check values of the validation suite; bench.mjs --update-golden rewrites the level that was run.', ...prev };
    g[level] = {};
    for (const r of results) {
        if (!r.checks || !r.checks.length) continue;
        g[level][r.id] = {};
        for (const c of r.checks) g[level][r.id][c.label] = typeof c.value === 'number' && !Number.isFinite(c.value) ? String(c.value) : c.value;
    }
    return g;
}
function compareGolden(results, level) {
    if (!existsSync(GOLDEN)) return { missing: true, changed: [] };
    const g = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    const lv = g[level] || {};
    const changed = [];
    for (const r of results) {
        const ref = lv[r.id];
        if (!ref) continue;
        for (const c of r.checks || []) {
            if (!(c.label in ref)) { changed.push({ id: r.id, label: c.label, before: undefined, now: c.value }); continue; }
            const b = ref[c.label], a = c.value;
            if (typeof a === 'number' && typeof b === 'number') {
                const rel = Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
                if (rel > 1e-9 && Math.abs(a - b) > 1e-300) changed.push({ id: r.id, label: c.label, before: b, now: a, rel });
            } else if (String(a) !== String(b)) changed.push({ id: r.id, label: c.label, before: b, now: a });
        }
    }
    return { missing: false, changed, engineVersion: g.engineVersion };
}

async function main() {
    const o = args(process.argv.slice(2));
    const list = BENCHMARKS.filter((b) => !o.only || o.only.includes(b.id));
    const results = [];
    const t0 = performance.now();
    for (const b of list) {
        const r = await runBenchmark(b.id, o.level, {});
        results.push(r);
        if (o.verbose) {
            process.stdout.write(`${r.id} ${r.status} ${(r.ms / 1000).toFixed(2)} s\n`);
            for (const c of r.checks) process.stdout.write(`    ${c.pass ? 'ok  ' : 'FAIL'} ${c.label}: ${fmt(c.value)} vs ${fmt(c.target)} (deviation ${fmt(c.deviation)}, ${tolText(c)})\n`);
        }
    }
    const total = (performance.now() - t0) / 1000;
    process.stdout.write(`Ion optics validation suite, level ${o.level}, engine ${ENGINE_VERSION}, Node ${process.version}, ${new Date().toISOString()}\n`);
    process.stdout.write(table(results) + '\n');
    const gates = results.filter((r) => BENCHMARKS.find((b) => b.id === r.id).kind === 'gate');
    const passed = gates.filter((r) => r.status === 'pass').length;
    process.stdout.write(`Gates: ${passed}/${gates.length} pass; info ${results.filter((r) => r.status === 'info' && !(r.details && r.details.planned)).length}; planned ${results.filter((r) => r.details && r.details.planned).length}; ${total.toFixed(1)} s\n`);
    const cmp = compareGolden(results, o.level);
    if (cmp.missing) process.stdout.write('No golden file yet (run with --update-golden to create it).\n');
    else if (cmp.changed.length) {
        process.stdout.write(`Changed against the golden file (> 1e-9 relative, golden engine ${cmp.engineVersion}):\n`);
        for (const c of cmp.changed) process.stdout.write(`    changed ${c.id} ${c.label}: ${fmt(c.before)} -> ${fmt(c.now)}${c.rel !== undefined ? ` (${c.rel.toExponential(2)})` : ''}\n`);
    } else process.stdout.write('All values equal the golden file.\n');
    if (o.updateGolden) {
        const prev = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {};
        mkdirSync(dirname(GOLDEN), { recursive: true });
        writeFileSync(GOLDEN, JSON.stringify(goldenOf(results, o.level, prev), null, 1) + '\n');
        process.stdout.write(`Golden values written to ${GOLDEN}\n`);
    }
    if (o.json) {
        const out = { suite: 'ion-optics-validation', level: o.level, engineVersion: ENGINE_VERSION, node: process.version, date: new Date().toISOString(), seconds: total, results };
        mkdirSync(dirname(resolvePath(o.json)), { recursive: true });
        writeFileSync(o.json, JSON.stringify(out, null, 1));
        process.stdout.write(`JSON written to ${o.json}\n`);
    }
    const failed = gates.some((r) => r.status !== 'pass');
    process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) main();
