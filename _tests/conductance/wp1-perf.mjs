// WP1 performance probe (spec 6; not part of node --test): engine size, analyze and sweep times per preset,
// recompute times for 10- and 40-element lines, the convergence survey of acceptance 7.2.7, the formula self-test and
// a seeded robustness survey of random lines far outside normal use.
// Usage: node _tests/conductance/wp1-perf.mjs        Exit code 1 if a budget row is exceeded.
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { analyze, sweep, buildNetwork, solveAt } from '../../beta/conductance/js/engine/network.js';
import { gasState } from '../../beta/conductance/js/engine/gas.js';
import { FORMULA_CASES } from '../../beta/conductance/js/engine/validation-formulas.js';
import { runCases, summarize } from '../../beta/conductance/js/engine/validation.js';

const GOLD = JSON.parse(readFileSync(new URL('./fixtures/golden-formulas.json', import.meta.url), 'utf8'));
const PRESETS = Object.fromEntries(Object.entries(GOLD.presets).map(([k, v]) => [k, v.model]));
const ENGINE = new URL('../../beta/conductance/js/engine/', import.meta.url);
const rows = [];
let over = 0;
const row = (what, value, budget, ok) => { rows.push([what, value, budget, ok === null ? '' : ok ? 'OK' : 'OVER']); if (ok === false) over++; };
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
function time(fn, runs = 7) {
    const t = [];
    for (let k = 0; k < runs; k++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); }
    return median(t);
}

// ---- first call in a fresh process (cold JIT): analyze + both sweeps of the default preset
{
    const m = PRESETS['turbo-dn100'];
    const t0 = performance.now();
    analyze(m); sweep(m, 'Seff'); sweep(m, 'C');
    const ms = performance.now() - t0;
    row('First full result, default preset, cold (analyze + 2 sweeps)', `${ms.toFixed(1)} ms`, '<= 300 ms desktop', ms <= 300);
}

// ---- engine size (Components-tab modules)
{
    const files = ['gas.js', 'interp.js', 'tables.js', 'molecular.js', 'flow.js', 'elements.js', 'network.js'];
    const bytes = files.reduce((s, f) => s + statSync(new URL(f, ENGINE)).size, 0), tables = statSync(new URL('tables.js', ENGINE)).size;
    const gz = files.reduce((s, f) => s + gzipSync(readFileSync(new URL(f, ENGINE))).length, 0);
    // informational: the budget is the Components-tab total (<= 140 kB with the UI), checked at integration
    row('Engine JS for the Components tab (7 modules)', `${(bytes / 1024).toFixed(1)} kB, ${(gz / 1024).toFixed(1)} kB gzip (tables ${(tables / 1024).toFixed(1)} kB)`, 'about 70 kB estimate (total 140 kB)', null);
    const vb = ['validation.js', 'validation-formulas.js'].reduce((s, f) => s + statSync(new URL(f, ENGINE)).size, 0);
    row('Self-test formula modules (lazy)', `${(vb / 1024).toFixed(1)} kB`, '', null);
}

// ---- per preset: analyze and the two sweeps
for (const [name, m] of Object.entries(PRESETS)) {
    const kind = m.bc.mode === 'pump' ? 'Seff' : 'dp';
    const ta = time(() => analyze(m)), ts = time(() => sweep(m, kind)), tc = time(() => sweep(m, 'C'));
    row(`${name}: analyze`, `${ta.toFixed(2)} ms`, '<= 5 ms (0.1-1 ms reference)', ta <= 5);
    row(`${name}: ${kind} sweep, 61 points`, `${ts.toFixed(2)} ms`, '0.3-4 ms reference', ts <= 10);
    row(`${name}: C sweep, 61 points`, `${tc.toFixed(2)} ms`, '0.3-4 ms reference', tc <= 10);
    row(`${name}: recompute (analyze + 2 sweeps)`, `${(ta + ts + tc).toFixed(2)} ms`, '<= 50 ms desktop', ta + ts + tc <= 50);
}

// ---- 10- and 40-element lines
const tube = (d, L) => ({ t: 'tube', d, L }), orif = (d) => ({ t: 'orifice', shape: 'circle', d });
function line(n, p0) {
    const kinds = [tube(0.05, 0.2), { t: 'elbow', d: 0.05, A: 0.1, B: 0.1 }, { t: 'cone', d1: 0.05, d2: 0.04, L: 0.05 }, { t: 'rect', a: 0.02, b: 0.04, L: 0.1 },
        orif(0.015), { t: 'annulus', di: 0.01, do: 0.04, L: 0.08 }, { t: 'slit', h: 0.002, w: 0.04, L: 0.02 }, { t: 'bbox', C: 0.05, gasRef: 'N2', d: 0.04, label: 'Valve' }];
    const items = [];
    for (let k = 0; items.length < n - 1; k++) items.push(kinds[k % kinds.length]);
    if (n >= 40) {
        const branch = (d) => [tube(d, 0.1), { t: 'elbow', d, A: 0.05, B: 0.05 }, { t: 'cone', d1: d, d2: d * 1.5, L: 0.05 }, tube(d * 1.5, 0.1)];
        items.splice(10, 1, { t: 'parallel', branches: [branch(0.02), branch(0.025), [tube(0.01, 0.3)]] });
        items.splice(25, 2, { t: 'parallel', branches: [branch(0.03), [orif(0.01)], [{ t: 'slit', h: 0.001, w: 0.05, L: 0.01 }]] }, { t: 'chamber' });
    }
    items.push({ t: 'pump', S: 0.2, d: 0.05, label: 'Turbo' });
    return { items, gas: { id: 'N2', T: 293.15, custom: null }, Cd: null, bc: { mode: 'pump', p0 }, range: { pMin: 1e-6, pMax: 1.2e5 } };
}
for (const [n, budget] of [[10, 50], [40, 400]]) {
    for (const p0 of [1e-4, 1e5]) {
        const m = line(n, p0);
        const r = analyze(m);
        if (!r.ok || !r.converged) { row(`${n}-item line at ${p0} Pa`, 'did not solve', '', false); continue; }
        const t = time(() => { analyze(m); sweep(m, 'Seff'); sweep(m, 'C'); }, 3);
        row(`${n}-item line at ${p0} Pa: recompute (analyze + 2 sweeps)`, `${t.toFixed(1)} ms`, `<= ${budget} ms desktop`, t <= budget);
    }
}
{
    const m = line(40, 1e5), t = time(() => analyze(m), 5);
    row('40-item line, two parallel groups, analyze at 1 bar', `${t.toFixed(1)} ms`, '<= 250 ms', t <= 250);
}

// ---- convergence survey: 7 presets x 121 pressures from 1e-8 to 2e5 Pa (fresh solves)
{
    const ps = Array.from({ length: 121 }, (_, k) => 1e-8 * Math.pow(2e5 / 1e-8, k / 120));
    let bad = 0, maxIt = 0, n = 0;
    const t0 = performance.now();
    for (const m of Object.values(PRESETS)) {
        const G = gasState(m.gas.id, m.gas.T), net = buildNetwork(m.items, G), ratio = m.bc.mode === 'dp' ? m.bc.p1 / m.bc.p0 : 0;
        for (const p0 of ps) {
            const r = solveAt(net, G, m.bc.mode === 'dp' ? { mode: 'dp', p0, p1: p0 * ratio } : { mode: 'pump', p0 });
            n++; if (!r.converged) bad++; maxIt = Math.max(maxIt, r.maxIterations);
        }
    }
    const ms = performance.now() - t0;
    row(`Convergence: ${n} fresh solves (7 presets x 121 pressures)`, `${bad} unconverged, max ${maxIt} iterations per step, ${ms.toFixed(0)} ms`, '0 unconverged, <= 8', bad === 0 && maxIt <= 8);
}

// ---- formula self-test
{
    const t0 = performance.now();
    const res = await runCases(FORMULA_CASES, {}, null, undefined);
    const ms = performance.now() - t0, s = summarize(res);
    row('Formula self-test (84 cases)', `${ms.toFixed(1)} ms; ${s.formula[0]}/${s.formula[1]} passed, ${s.negative[0]}/${s.negative[1]} caught`, '<= 1 s', ms <= 1000 && s.formula[0] === s.formula[1] && s.negative[0] === s.negative[1]);
}

// ---- robustness survey: seeded random lines far beyond normal use (10 µm to 1 m bores, 1 µm to 30 m lengths,
// 20 K to 3000 K, custom gases, Cd down to 0.01, 1e-10 to 1e7 Pa, up to 40 items with parallel groups)
{
    let a = 20261013 >>> 0;
    const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const lu = (lo, hi) => lo * Math.pow(hi / lo, r()), pick = (arr) => arr[Math.floor(r() * arr.length)];
    const IDS = ['N2', 'air', 'He', 'H2', 'Ar', 'H2O', 'CO2'];
    const geom = (dMax, G) => {
        const d = lu(1e-5, dMax);
        switch (pick(['tube', 'tube', 'orifice', 'slit', 'rect', 'annulus', 'cone', 'elbow', 'bbox'])) {
            case 'tube': return tube(d, lu(1e-6, 30));
            case 'orifice': return r() < 0.7 ? orif(d) : { t: 'orifice', shape: 'rect', w: d, h: d * lu(1e-3, 1) };
            case 'slit': return { t: 'slit', h: d * lu(1e-4, 1), w: d, L: lu(1e-6, 1) };
            case 'rect': return { t: 'rect', a: d, b: d * lu(0.01, 1), L: lu(1e-6, 10) };
            case 'annulus': return { t: 'annulus', di: d * lu(1e-3, 0.999), do: d, L: lu(1e-6, 5) };
            case 'cone': { const L = lu(1e-5, 5), d2 = lu(1e-5, dMax); return Math.atan(Math.abs(d2 - d) / 2 / L) * 180 / Math.PI > 89 ? tube(d, L) : { t: 'cone', d1: d, d2, L }; }
            case 'elbow': return { t: 'elbow', d, A: d / 2 * lu(1, 1000), B: d / 2 * lu(1, 1000) };
            default: { const id = pick(IDS); return { t: 'bbox', C: Math.PI * d * d / 4 * gasState(id, 293.15).vbar / 4 * lu(1e-6, 0.998), gasRef: id, d, label: 'BB' }; }
        }
    };
    let total = 0, unconv = 0, nonfinite = 0, worst = 0;
    const t0 = performance.now();
    while (total < 300) {
        const custom = r() < 0.15 ? { M: lu(1e-3, 0.3), eta20: lu(1e-6, 1e-4), omega: lu(0.3, 1.2), gamma: 1 + lu(0.001, 0.67), Cd: lu(0.05, 1) } : null;
        const id = custom ? 'custom' : pick(IDS), T = pick([293.15, 293.15, 20, 77, 400, 1000, 3000]), Cd = r() < 0.2 ? lu(0.01, 1) : null;
        const G = gasState(id, T, custom, Cd), items = [];
        const nTop = 1 + Math.floor(r() * (r() < 0.2 ? 39 : 8));
        for (let i = 0; i < nTop; i++) {
            const u = r();
            if (u < 0.06) items.push({ t: 'chamber' });
            else if (u < 0.16) items.push({ t: 'parallel', branches: Array.from({ length: 2 + Math.floor(r() * 3) }, () => Array.from({ length: 1 + Math.floor(r() * 6) }, () => geom(0.3, G))) });
            else items.push(geom(1, G));
        }
        const pumpMode = r() < 0.6, p0 = lu(1e-10, 1e7);
        let bc;
        if (pumpMode) { const dp = lu(1e-4, 1); items.push({ t: 'pump', S: Math.PI * dp * dp / 4 * G.vbar / 4 * lu(1e-6, 0.999), d: dp, label: 'P' }); bc = { mode: 'pump', p0 }; }
        else bc = { mode: 'dp', p0, p1: Math.max(1e-10, p0 * lu(1e-17, 0.9999)) };
        if (bc.p1 !== undefined && !(bc.p1 < bc.p0)) continue;
        const m = { items, gas: { id, T, custom }, Cd, bc, range: { pMin: lu(1e-10, 1e-3), pMax: lu(1e3, 1e7) } };
        const res = analyze(m);
        if (!res.ok) continue;
        total++;
        const t1 = performance.now();
        const s1 = sweep(m, pumpMode ? 'Seff' : 'dp'), s2 = sweep(m, 'C');
        worst = Math.max(worst, performance.now() - t1);
        if (!res.converged || s1.converged.some((c) => !c)) unconv++;
        if (!(Number.isFinite(res.Q) && res.Q > 0) || [...s2.y].some((v) => !(v > 0))) nonfinite++;
    }
    const ms = performance.now() - t0;
    row(`Robustness: ${total} random extreme lines (analyze + 2 sweeps)`, `${unconv} with unconverged points, ${nonfinite} with bad values; slowest sweeps ${worst.toFixed(0)} ms; ${(ms / 1000).toFixed(1)} s`, '0 and 0; no freeze', unconv === 0 && nonfinite === 0);
}

const w = [rows.reduce((m, r) => Math.max(m, r[0].length), 0), rows.reduce((m, r) => Math.max(m, r[1].length), 0), rows.reduce((m, r) => Math.max(m, r[2].length), 0)];
process.stdout.write(`WP1 performance (Node ${process.version}, ${new Date().toISOString().slice(0, 16)}Z)\n\n`);
for (const r of rows) process.stdout.write(`${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2].padEnd(w[2])}  ${r[3]}\n`);
process.stdout.write(`\n${over ? `${over} row(s) over budget` : 'All budget rows met'}.\n`);
process.exitCode = over ? 1 : 0;
