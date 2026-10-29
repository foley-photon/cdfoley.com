// Runs the Conductance Lab validation cases in Node and prints the table (spec 5.1-5.3).
// Usage: node _tests/conductance/run-validation.mjs [--quick] [--group=formula|chain-mc|mesh-mc|negative] [--workers=N]
//   --group=formula   the formula cases of validation-formulas.js, with their three negative controls
//   --group=negative  every negative control (formula and Monte Carlo)
//   --quick           only cases marked quick, with the quick particle counts (the browser's quick set)
// Exit code: 0 when every case passes and every negative control is caught, 1 on any FAIL, 2 when requested
// Monte Carlo cases cannot run because the WP2 modules are missing.
import { FORMULA_CASES } from '../../beta/conductance/js/engine/validation-formulas.js';
import { runCases, summarize } from '../../beta/conductance/js/engine/validation.js';

const args = process.argv.slice(2);
const opt = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const quick = args.includes('--quick');
const group = opt('group');
const GROUPS = ['formula', 'chain-mc', 'mesh-mc', 'negative'];
if (group !== null && !GROUPS.includes(group)) {
    process.stderr.write(`Unknown group "${group}". Use one of: ${GROUPS.join(', ')}.\n`);
    process.exit(2);
}
const unknown = args.filter((a) => !(a === '--quick' || a.startsWith('--group=') || a.startsWith('--workers=')));
if (unknown.length) {
    process.stderr.write(`Unknown option ${unknown.join(' ')}. Usage: run-validation.mjs [--quick] [--group=...] [--workers=N]\n`);
    process.exit(2);
}

// Monte Carlo modules (WP2) are optional: --group=formula works without them.
let MC_CASES = null, createNodeRunner = null, mcMissing = null;
if (group !== 'formula') {
    try {
        ({ MC_CASES } = await import('../../beta/conductance/js/engine/validation-mc.js'));
        ({ createNodeRunner } = await import('./node-worker.mjs'));
        if (!Array.isArray(MC_CASES) || typeof createNodeRunner !== 'function') throw new Error('unexpected exports');
    } catch (err) {
        mcMissing = err && err.message ? err.message : String(err);
        MC_CASES = null;
    }
}

let cases;
if (group === 'formula') cases = FORMULA_CASES.slice();
else if (group === 'negative') cases = [...FORMULA_CASES, ...(MC_CASES || [])].filter((c) => c.group === 'negative');
else if (group) cases = (MC_CASES || []).filter((c) => c.group === group);
else cases = [...FORMULA_CASES, ...(MC_CASES || [])];
if (quick) cases = cases.filter((c) => c.quick);

const needsMc = (group === null || group === 'chain-mc' || group === 'mesh-mc' || group === 'negative');
if (needsMc && !MC_CASES) process.stdout.write(`Monte Carlo cases skipped: the WP2 modules could not be loaded (${mcMissing}).\n`);
if (!cases.length) {
    process.stdout.write('No validation cases selected.\n');
    process.exit(needsMc && !MC_CASES ? 2 : 0);
}

const usesMc = cases.some((c) => c.group === 'chain-mc' || c.group === 'mesh-mc' || (MC_CASES && MC_CASES.includes(c)));
const workers = Math.max(1, Math.min(11, Number(opt('workers')) || 4));
const mc = usesMc ? createNodeRunner({ workers }) : null;

const num = (v) => (Number.isFinite(v) ? (Math.abs(v) !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5) ? v.toExponential(5) : String(Number(v.toPrecision(6)))) : String(v));
const sig = (v) => (Number.isFinite(v) ? String(Number(v.toPrecision(2))) : String(v));
const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const cols = [['Result', 7], ['Group', 9], ['Id', 32], ['Reference', 22], ['This tool', 24], ['Deviation', 12], ['Tolerance', 30], ['ms', 8]];
process.stdout.write(`Conductance Lab validation${quick ? ' (quick set)' : ''}${group ? `, group ${group}` : ''}: ${cases.length} cases${mc ? `, ${workers} worker threads` : ''}\n\n`);
process.stdout.write(cols.map(([h, w]) => pad(h, w)).join(' ') + '\n' + cols.map(([, w]) => '-'.repeat(w)).join(' ') + '\n');

const t0 = performance.now();
let rows;
try {
    rows = await runCases(cases, { mc, quick }, (r) => {
        const result = r.group === 'negative' ? (r.caught ? 'caught' : 'MISSED') : (r.pass ? 'PASS' : 'FAIL');
        const ref = num(r.ref) + (r.refSigma ? ` ± ${sig(r.refSigma)}` : '');
        const val = num(r.value) + (r.sigma ? ` ± ${sig(2 * r.sigma)}` : '');
        const line = [result, r.group, r.id, ref, val, r.devText, r.tolText, r.ms.toFixed(1)];
        process.stdout.write(line.map((s, i) => pad(String(s), cols[i][1])).join(' ') + (r.unit ? `  [${r.unit}]` : '') + '\n');
    }, undefined);
} finally {
    if (mc) mc.dispose();
}
const s = summarize(rows);
const failed = rows.filter((r) => !r.pass);
process.stdout.write(`\n${s.formula[0]} of ${s.formula[1]} formula checks passed · ${s.mc[0]} of ${s.mc[1]} Monte Carlo checks passed · negative controls caught ${s.negative[0]} of ${s.negative[1]} · ${((performance.now() - t0) / 1000).toFixed(1)} s\n`);
if (failed.length) process.stdout.write(`FAILED: ${failed.map((r) => r.id).join(', ')}\n`);
process.exitCode = failed.length ? 1 : (needsMc && !MC_CASES ? 2 : 0);
