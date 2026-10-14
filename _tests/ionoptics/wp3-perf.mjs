// WP3 acceptance (10): runProject(einzel) ≤ 1.5 s in Node, and jobs' estimate within 2× of measured times on every
// preset type. Single thread: estimates for one worker against pipeline timings (best of `--reps`, default 3).
// Solve: the estimate shown before solving. Run: the estimate after the live preview of the same field (measured steps
// per particle and step rate, as jobs.estimate() does); the cold run estimate is printed for information.
// Jobs shorter than 20 ms pass within 20 ms (timer noise). Uses the WP3 fixtures and, when present, the WP6 presets.
//   node _tests/ionoptics/wp3-perf.mjs [--only einzel,vmi] [--reps 3] [--json E:/Temp/cdfoley-work/design/wp3/perf.json]
import { writeFileSync } from 'node:fs';
import * as PL from '../../beta/ion-optics/js/engine/pipeline.js';
import { resolve } from '../../beta/ion-optics/js/engine/schema.js';
import { encodeShare } from '../../beta/ion-optics/js/engine/io.js';
import { generate } from '../../beta/ion-optics/js/engine/particles.js';
import { estimateProject, stepsPerParticle } from '../../beta/ion-optics/js/ui/jobs.js';
import { FIXTURES, einzel } from './fixtures/wp3/projects.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const only = arg('--only', null) ? arg('--only').split(',') : null;
const reps = Math.max(1, +arg('--reps', 3));
const jsonOut = arg('--json', null);
const FLOOR_MS = 20;
const within = (est, meas) => (Math.abs(est - meas) <= FLOOR_MS) || (est <= 2 * meas && meas <= 2 * est);

// projects: WP3 fixtures, plus WP6 presets when the presets package exists
const projects = Object.entries(FIXTURES).map(([id, make]) => ({ id: `fixture:${id}`, make }));
try {
    const mod = await import('../../beta/ion-optics/js/presets/index.js');
    for (const p of mod.PRESETS || []) projects.push({ id: `preset:${p.id}`, make: () => p.build() });
} catch (e) { /* presets not built yet */ }

let fail = 0;
const rows = [];

// 1. runProject(einzel)
let best = Infinity, timings = null;
for (let k = 0; k < 3; k++) { const t0 = performance.now(); const o = PL.runProject(einzel()); const ms = performance.now() - t0; if (ms < best) { best = ms; timings = o.timings; } }
const okRun = best <= 1500;
if (!okRun) fail++;
console.log(`runProject(einzel): ${best.toFixed(0)} ms (solve ${timings.solveMs.toFixed(0)}, field ${timings.fieldMs.toFixed(0)}, trace ${timings.traceMs.toFixed(0)}) budget 1500 ms ${okRun ? 'PASS' : 'FAIL'}`);

// 2. estimates
console.log('\nproject                       nodes  K    n | solve meas  est  ratio | run meas preview ratio | cold  ratio | link chars | status');
for (const { id, make } of projects) {
    if (only && !only.some((o) => id.endsWith(':' + o))) continue;
    const project = make();
    const r = resolve(project).resolved;
    if (!r) { console.log(`${id}: does not resolve`); fail++; continue; }
    let m = null;
    for (let k = 0; k < reps; k++) {
        const t0 = performance.now();
        const solved = PL.solveProject(r);
        const t1 = performance.now();
        const fld = PL.buildField(r, solved);
        const t2 = performance.now();
        const res = PL.traceProject(r, fld);
        const t3 = performance.now();
        // the live preview: the first n particles of each source
        const per = Math.max(4, Math.min(200, Math.floor(40000 / stepsPerParticle(r))));
        const parts = [];
        for (const s of r.sources) { const c = Math.min(per, s.count); if (c > 0) parts.push(generate(r.sources, s.firstId, s.firstId + c, { domainType: r.domain.type, relativistic: r.tracer.relativistic !== false })); }
        const rowsP = new Float64Array(parts.reduce((a, b) => a + b.length, 0));
        let o = 0; for (const x of parts) { rowsP.set(x, o); o += x.length; }
        const pv = PL.traceProject(r, fld, { particles: rowsP });
        const cur = { solve: t1 - t0, field: t2 - t1, run: t3 - t2, pvSteps: pv.stats.steps, pvN: pv.n, pvMs: pv.stats.ms };
        if (!m || cur.solve + cur.run < m.solve + m.run) m = cur;
    }
    const cold = estimateProject(r, { workers: 1 });
    const afterPreview = estimateProject(r, { workers: 1, measured: m.pvN > 0 ? { stepsPerParticle: m.pvSteps / m.pvN, stepsPerSec: m.pvMs > 0 ? m.pvSteps / m.pvMs * 1000 : 0 } : null });
    const link = (await encodeShare(project)).length + 1;
    const okS = within(cold.solveMs, m.solve), okR = r.particleCount === 0 || within(afterPreview.runMs, m.run), okL = link <= 4096;
    if (!okS || !okR || !okL) fail++;
    const row = { id, nodes: r.domain.N, bases: r.electrodes.length - 1, particles: r.particleCount, solveMs: m.solve, solveEst: cold.solveMs, runMs: m.run, runEst: afterPreview.runMs,
        runEstCold: cold.runMs, linkChars: link, pass: okS && okR && okL };
    rows.push(row);
    const ratio = (a, b) => (b > 0 ? (a / b).toFixed(2) : '-');
    console.log(`${id.padEnd(28)} ${String(row.nodes).padStart(7)} ${String(row.bases).padStart(2)} ${String(row.particles).padStart(4)} | ${m.solve.toFixed(0).padStart(5)} ${cold.solveMs.toFixed(0).padStart(5)} ${ratio(cold.solveMs, m.solve).padStart(5)} | ${m.run.toFixed(0).padStart(6)} ${afterPreview.runMs.toFixed(0).padStart(6)} ${ratio(afterPreview.runMs, m.run).padStart(5)} | ${cold.runMs.toFixed(0).padStart(5)} ${ratio(cold.runMs, m.run).padStart(5)} | ${String(link).padStart(5)} | ${row.pass ? 'PASS' : 'FAIL'}${okS ? '' : ' solve'}${okR ? '' : ' run'}${okL ? '' : ' link'}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ date: new Date().toISOString(), runProjectEinzelMs: best, rows }, null, 2));
console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
process.exit(fail ? 1 : 0);
