// WP5 contract (spec 2.3 WP5 part, 2.5 panel contract, 7.1 M1): every export exists with its signature and returns
// structurally valid results; the dock panels export meta and mount with the registry ids of main.js; pure panel
// helpers work on a recorded run fixture and the CSV columns are exactly those of spec 4.7.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as exact from '../../beta/ion-optics/js/engine/exact.js';
import * as lensprops from '../../beta/ion-optics/js/engine/lensprops.js';
import * as optimize from '../../beta/ion-optics/js/engine/optimize.js';
import { TARGETS } from '../../beta/ion-optics/js/engine/bench/targets.js';
import * as cases from '../../beta/ion-optics/js/engine/bench/cases.js';
import * as plots from '../../beta/ion-optics/js/ui/plots.js';
import * as aj from '../../beta/ion-optics/js/ui/analysis-jobs.js';
import { runToCSV } from '../../beta/ion-optics/js/engine/io.js';

const fn = (m, name, arity = null) => { assert.equal(typeof m[name], 'function', `${name} is a function`); if (arity !== null) assert.equal(m[name].length, arity, `${name} arity`); };

test('exact.js: signatures and finite results', () => {
    fn(exact, 'twoTubeAxial', 1); fn(exact, 'twoTubeExact'); fn(exact, 'einzelAxial'); fn(exact, 'einzelExact');
    for (const n of ['coaxV', 'sphereV', 'mirrorRange', 'mirrorDepth', 'uniformTransit', 'driftTime', 'rfUniformDisplacement', 'pulseRampPosition', 'qmfVoltages', 'paulLMCO', 'reflectronTof']) fn(exact, n);
    const t = exact.twoTubeExact(5);
    for (const k of ['F1', 'F2', 'f1', 'f2']) assert.ok(Number.isFinite(t[k]), k);
    const e = exact.einzelExact(9);
    assert.ok(Number.isFinite(e.f) && Number.isFinite(e.F));
    const M = exact.mathieu;
    for (const n of ['a0', 'b1', 'floquetTrace', 'beta', 'stable']) fn(M, n);
    assert.equal(M.qEdgeA0, 0.908046);
    assert.deepEqual({ ...M.apex }, { q: 0.70600, a: 0.23699 });
    const u = exact.uniformTransit({ gapMm: 10, dV: 1000, massU: 100, chargeE: 1 });
    assert.ok(u.tUs > 0 && u.vMMus > 0);
    const v = exact.qmfVoltages({ massU: 100, r0: 4, freqMHz: 1.1, a: 0.1, q: 0.5 });
    assert.ok(v.U > 0 && v.V > 0);
});

test('lensprops.js and optimize.js: async signatures', async () => {
    fn(lensprops, 'lensProperties', 3); fn(lensprops, 'imageOf', 2); fn(optimize, 'scan1D'); fn(optimize, 'nelderMead');
    assert.equal(lensprops.lensProperties.constructor.name, 'AsyncFunction');
    assert.equal(lensprops.imageOf.constructor.name, 'AsyncFunction');
    const s = await optimize.scan1D((x) => x * x, [1, 2]);
    assert.deepEqual(Object.keys(s).sort(), ['best', 'metrics', 'values']);
    const r = await optimize.nelderMead((x) => (x[0] - 1) ** 2, [0], { maxEval: 20 });
    for (const k of ['x', 'fx', 'nEval', 'history']) assert.ok(k in r, k);
    assert.equal(typeof optimize.evaluateMetric, 'function');
});

test('bench registry, targets and runner shapes', async () => {
    // the registry's size is asserted in wp5-benchmarks; here only its shape, and that every id is unique
    assert.ok(Array.isArray(cases.BENCHMARKS) && cases.BENCHMARKS.length >= 45);
    assert.equal(new Set(cases.BENCHMARKS.map((b) => b.id)).size, cases.BENCHMARKS.length, 'unique ids');
    for (const b of cases.BENCHMARKS) {
        for (const k of ['id', 'group', 'title', 'kind', 'description', 'reference', 'levels', 'timeoutMs']) assert.ok(k in b, `${b.id}.${k}`);
        assert.ok(['K', 'S', 'T', 'L', 'D', 'I', 'P'].includes(b.group), `${b.id} group ${b.group}`);
        assert.ok(['gate', 'info', 'planned'].includes(b.kind));
        const t = TARGETS[b.id];
        assert.ok(t && 'values' in t && 'units' in t && t.source && (t.source.url || (t.source.url === null && /closed form/.test(t.source.text))) && 'calibration' in t, `${b.id} target shape`);
    }
    fn(cases, 'runBenchmark'); fn(cases, 'caseProject');
    const r = await cases.runBenchmark('K1', 'quick');
    for (const k of ['id', 'level', 'status', 'ms', 'engineVersion', 'checks', 'details']) assert.ok(k in r, k);
    assert.equal(r.status, 'pass');
    for (const c of r.checks) for (const k of ['label', 'target', 'value', 'unit', 'tol', 'tolKind', 'deviation', 'pass']) assert.ok(k in c, `check.${k}`);
    assert.ok(['abs', 'rel', 'digits', 'bracket'].includes(r.checks[0].tolKind));
    assert.equal(cases.caseProject('P1'), null);
    assert.equal(cases.caseProject('K1').format, 'ion-optics-project');
});

const PANELS = [['results', 'summary'], ['hits', 'hits'], ['planes', 'planes'], ['tof', 'tof'], ['lens', 'lens'], ['profile', 'profile'], ['scan', 'scan'], ['compare', 'compare'], ['benchmarks', 'bench'], ['log', 'log']];
test('dock panels: meta { id, title, order } with the registry ids, and mount(el, ctx)', async () => {
    const orders = new Set();
    for (const [file, id] of PANELS) {
        const m = await import(`../../beta/ion-optics/js/ui/panels/${file}.js`);
        assert.equal(m.meta.id, id, `${file}.js id`);
        assert.ok(typeof m.meta.title === 'string' && m.meta.title.length);
        assert.ok(Number.isFinite(m.meta.order) && !orders.has(m.meta.order));
        orders.add(m.meta.order);
        assert.equal(typeof m.mount, 'function');
        assert.equal(m.mount.length, 2);
    }
    for (const n of ['chartBlock', 'linePlot', 'barsPlot', 'scatterPlot', 'heatmapPlot', 'dataTable', 'csvText', 'themeColors', 'onThemeChange']) fn(plots, n);
    for (const n of ['lensJob', 'imageJob', 'scanJob', 'optimizeJob', 'accuracyCheck', 'methodsText', 'profileData', 'runOverview']) fn(aj, n);
});

// ---- the recorded run fixture (fixtures/wp5/run-fixture.json): arrays stored as plain lists
function fixture() {
    const j = JSON.parse(readFileSync(new URL('./fixtures/wp5/run-fixture.json', import.meta.url), 'utf8'));
    const r = j.result;
    return { resolved: j.resolved, result: { ...r, summary: Float64Array.from(r.summary), crossings: Float64Array.from(r.crossings), traj: r.traj ? { offsets: Uint32Array.from(r.traj.offsets), pts: Float32Array.from(r.traj.pts) } : null, markers: r.markers ? Float32Array.from(r.markers) : null } };
}

test('CSV columns are exactly those of spec 4.7 (hits, crossings, trajectories, markers)', () => {
    const { resolved, result } = fixture();
    const head = (which) => runToCSV(result, which, resolved).split('\r\n')[0];
    assert.equal(head('hits'), 'id,source,species,mass_u,charge_e,t0_us,x0_mm,y0_mm,z0_mm,ke0_eV,status,where,t_us,tof_us,x_mm,y_mm,z_mm,vx_mm_us,vy_mm_us,vz_mm_us,ke_eV,dE_end_eV,dE_max_eV,work_eV,steps,path_mm');
    assert.equal(head('crossings'), 'id,plane,kind,k,dir,t_us,x_mm,y_mm,z_mm,vx_mm_us,vy_mm_us,vz_mm_us,ke_eV');
    assert.equal(head('trajectories'), 'id,t_us,x_mm,y_mm,z_mm');
    assert.equal(head('markers'), 'id,t_us,x_mm,y_mm,z_mm');
    assert.equal(runToCSV(result, 'hits', resolved).trim().split('\r\n').length, result.n + 1);
    // the chart CSV writer: RFC 4180 quoting and 10 significant digits
    assert.equal(plots.csvText(['a', 'b,c'], [[1 / 3, 'x"y']]), 'a,"b,c"\r\n0.3333333333,"x""y"\r\n');
});

test('pure panel helpers on the recorded run: overview, planes, TOF, hits rows, lens defaults, variables, report', async () => {
    const { resolved, result } = fixture();
    const ov = aj.runOverview(result, resolved);
    assert.equal(ov.summary.launched, result.n);
    assert.ok(ov.planes.length === resolved.recording.planes.length);
    const ps = aj.planeStats(result, resolved, 0);
    assert.ok(ps.n > 0 && Number.isFinite(ps.rmsRadius));
    const tp = aj.tofPeaks(result, resolved, 0);
    assert.ok(tp.peaks.length >= 1 && tp.hist.length === tp.peaks.length);
    const hits = await import('../../beta/ion-optics/js/ui/panels/hits.js');
    const all = hits.hitRows(result, resolved, {});
    assert.equal(all.length, result.n);
    const byTof = hits.hitRows(result, resolved, { sortKey: 'tof', sortDir: -1 });
    assert.equal(byTof.length, result.n);
    const lens = await import('../../beta/ion-optics/js/ui/panels/lens.js');
    const d = lens.lensDefaults({}, resolved);
    for (const k of ['refX', 'D', 'xStart', 'xEnd', 'mass', 'charge', 'keLeft', 'heights', 'side']) assert.ok(k in d, k);
    const scan = await import('../../beta/ion-optics/js/ui/panels/scan.js');
    assert.ok(scan.variableOptions({ params: [{ name: 'V' }], electrodes: [{ id: 'gnd', ground: true }, { id: 'e1' }], sources: [{ id: 'b1' }] }).length === 3);
    const bm = await import('../../beta/ion-optics/js/ui/panels/benchmarks.js');
    const k1 = await cases.runBenchmark('K1', 'quick');
    const md = bm.markdownReport([k1], { level: 'quick', env: 'Node' });
    assert.ok(md.includes('| K1 | Uniform-field transit | Pass |'));
    assert.equal(bm.summarise([k1]).passed, 1);
    const txt = aj.methodsText({ resolved, solve: { stats: [] } }, { bench: null });
    for (const w of ['grid', 'cell', 'Shortley–Weller', 'tolerance', 'superposition', 'Dormand–Prince', 'interpolation', 'relativistic', 'engine', 'validation suite']) assert.ok(txt.toLowerCase().includes(w.toLowerCase()), `Methods text mentions ${w}`);
});

test('linePlot drops a log axis that has no finite positive value (integration: the shared plotter drew a tick at NaN)', () => {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
    const saved = globalThis.window;
    globalThis.window = { Plot: { draw: (target, opts) => opts } };
    try {
        const allInfinite = plots.linePlot({ series: [{ x: [1, 2], y: [Infinity, Infinity] }], logY: true })({});
        assert.equal(allInfinite.y.log, false);
        const empty = plots.linePlot({ series: [], logY: true, logX: true })({});
        assert.equal(empty.y.log, false); assert.equal(empty.x.log, false);
        const normal = plots.linePlot({ series: [{ x: [1, 2, 3], y: [1e-3, Infinity, 1e-9] }], logY: true })({});
        assert.equal(normal.y.log, true);
    } finally {
        if (had) globalThis.window = saved; else delete globalThis.window;
    }
});
