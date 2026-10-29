// WP5 optimize.js (spec 7.6 acceptance 3): bounded Nelder-Mead finds the Rosenbrock minimum within 1e-4 in <= 200
// evaluations without leaving the box; scan1D evaluates in order; the run metrics on synthetic TraceResults.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nelderMead, scan1D, scanValues, evaluateMetric, planeFrame, waistOf, rmsRadius, classIndex, METRICS } from '../../beta/ion-optics/js/engine/optimize.js';
import { resolve } from '../../beta/ion-optics/js/engine/schema.js';
import { S_STRIDE, S_ID, S_STATUS, S_WHERE, S_SRC, S_SPECIES, S_T0, S_TOF, C_STRIDE, C_ID, C_PLANE, C_T, C_X, C_Y, C_Z, C_VX, C_VY, C_VZ, C_KE, C_DIR, C_KIND, STATUS } from '../../beta/ion-optics/js/engine/layout.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const rosen = (x) => (1 - x[0]) ** 2 + 100 * (x[1] - x[0] * x[0]) ** 2;

test('Nelder-Mead: Rosenbrock minimum within 1e-4 in <= 200 evaluations, never outside the bounds', async () => {
    let outside = 0, calls = 0;
    const f = (x) => { calls++; if (x[0] < -2 || x[0] > 2 || x[1] < -2 || x[1] > 2) outside++; return rosen(x); };
    const r = await nelderMead(f, [-1.2, 1], { step: [0.1, 0.1], lower: [-2, -2], upper: [2, 2], maxEval: 200, ftol: 1e-14, xtol: 1e-7 });
    assert.equal(outside, 0);
    assert.ok(r.nEval <= 200 && calls === r.nEval, `${r.nEval} evaluations`);
    assert.ok(Math.hypot(r.x[0] - 1, r.x[1] - 1) < 1e-4, `x = ${r.x}`);
    assert.ok(r.history.length > 10 && r.history.every((h, i) => i === 0 || h.fx <= r.history[i - 1].fx), 'best-so-far history is monotonic');
});

test('Nelder-Mead: an active bound is respected and approached; async objectives and onIter work', async () => {
    let iters = 0;
    const f = async (x) => (x[0] - 3) ** 2 + (x[1] + 1) ** 2;   // minimum at (3, −1), outside x ≤ 2
    const r = await nelderMead(f, [0, 0], { step: [0.5, 0.5], lower: [-2, -2], upper: [2, 2], maxEval: 120, ftol: 1e-12, xtol: 1e-8 }, () => { iters++; });
    near(r.x[0], 2, 1e-5, 'x on the bound'); near(r.x[1], -1, 1e-4, 'y free');
    assert.ok(iters > 0 && r.nEval <= 120);
    // budget stop
    const b = await nelderMead(rosen, [-1.2, 1], { maxEval: 30 });
    assert.ok(b.nEval <= 30 && b.reason === 'maxEval');
});

test('Nelder-Mead treats NaN as +infinity and still returns the best point', async () => {
    const r = await nelderMead((x) => (x[0] < 0 ? NaN : (x[0] - 1) ** 2), [0.5], { step: [0.4], maxEval: 80, xtol: 1e-6, ftol: 1e-12 });
    near(r.x[0], 1, 1e-4, 'minimum');
});

test('scan1D evaluates in order, reports every point and the best for min and max goals', async () => {
    const seen = [];
    const vals = scanValues({ from: 0, to: 1, n: 11 });
    assert.equal(vals.length, 11); near(vals[10], 1, 0, 'end'); assert.deepEqual(scanValues({ list: [3, 1] }), [3, 1]);
    const r = await scan1D(async (v) => (v === 0.5 ? NaN : (v - 0.3) ** 2), vals, (i, v, m) => seen.push([i, v, m]));
    assert.deepEqual(seen.map((s) => s[0]), [...vals.keys()]);
    assert.ok(Number.isNaN(r.metrics[5]));
    near(r.best.value, 0.3, 1e-12, 'min'); assert.equal(r.best.index, 3);
    const rmax = await scan1D((v) => -((v - 0.7) ** 2), vals, null, { goal: 'max' });
    near(rmax.best.value, 0.7, 1e-12, 'max');
    let n = 0;
    const stopped = await scan1D(() => 1, vals, null, { shouldStop: () => ++n > 3 });
    assert.equal(stopped.metrics.length, 3);
});

// ---- a synthetic run: 4 particles crossing an x plane at 10 mm, 3 of them detected
function synthetic() {
    const project = {
        format: 'ion-optics-project', version: 1, meta: { name: 'metrics' }, params: [],
        domain: { type: 'planar2d', cell: 1, x: [0, 20], y: [-10, 10] },
        electrodes: [{ id: 'gnd', name: 'Ground', ground: true }], shapes: [], magnets: [], idealFields: [],
        sources: [{ id: 's1', name: 'grid', enabled: true, count: 4, sampling: 'grid', seed: 1, species: [{ label: 'A', mass: 100, charge: 1, fraction: 1 }],
            position: { type: 'point', p: [0, 0, 0] }, direction: { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: -1, to: 1, n: 2 },
            energy: { type: 'list', values: [10, 20] }, time: { type: 'fixed', t: 0 } }],
        recording: { planes: [{ id: 'det', name: 'det', kind: 'x', at: 10, terminate: true, side: 'both', record: 'first' }], trajectories: { store: false, maxPoints: 10 }, timeMarkers: null },
    };
    const r = resolve(project);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    const n = 4, S = new Float64Array(n * S_STRIDE), C = new Float64Array(n * C_STRIDE);
    // rays through (10, y) with slopes so that they meet at x = 14 (waist), y0 = ±1, ±2
    const ys = [-2, -1, 1, 2], tofs = [1.0, 1.1, 1.2, 1.3];
    for (let i = 0; i < n; i++) {
        const s = i * S_STRIDE;
        S[s + S_ID] = i; S[s + S_SRC] = 0; S[s + S_SPECIES] = 0; S[s + S_T0] = 0.5;
        S[s + S_STATUS] = i < 3 ? STATUS.DETECTED : STATUS.HIT; S[s + S_WHERE] = 0; S[s + S_TOF] = tofs[i];
        const c = i * C_STRIDE;
        C[c + C_ID] = i; C[c + C_PLANE] = 0; C[c + C_KIND] = 0; C[c + C_DIR] = 1; C[c + C_T] = 0.5 + tofs[i];
        C[c + C_X] = 10; C[c + C_Y] = ys[i]; C[c + C_Z] = 0; C[c + C_VX] = 4; C[c + C_VY] = -ys[i]; C[c + C_VZ] = 0; C[c + C_KE] = 100 + i;
    }
    return { resolved: r.resolved, result: { n, summary: S, crossings: C, nCross: n } };
}

test('metrics: transmission, spot rms, waist position, mean TOF, mean KE on a synthetic run', () => {
    const { resolved, result } = synthetic();
    near(evaluateMetric({ type: 'transmission', plane: 'det' }, result, resolved), 0.75, 1e-15, 'transmission');
    near(evaluateMetric({ type: 'transmission', plane: null }, result, resolved), 0.75, 1e-15, 'overall');
    assert.ok(Number.isNaN(evaluateMetric({ type: 'transmission', plane: 'det', species: 'B' }, result, resolved)), 'unknown species gives NaN');
    near(evaluateMetric({ type: 'spotRms', plane: 'det' }, result, resolved), Math.sqrt((4 + 1 + 1 + 4) / 4), 1e-12, 'spot rms');
    near(evaluateMetric({ type: 'waistPos', plane: 'det' }, result, resolved), 14, 1e-12, 'waist at the focus');
    near(evaluateMetric({ type: 'meanTof', plane: 'det' }, result, resolved), 1.15, 1e-12, 'mean TOF (crossing time − birth time)');
    near(evaluateMetric({ type: 'meanKE', plane: 'det' }, result, resolved), 101.5, 1e-12, 'mean KE');
    assert.ok(evaluateMetric({ type: 'tofFwhm', plane: 'det' }, result, resolved) > 0);
    assert.ok(Object.keys(METRICS).length === 8);
});

test('grouped blur groups by direction and energy class regenerated from the sources', () => {
    const { resolved, result } = synthetic();
    const cls = classIndex(resolved);
    assert.equal(cls.size, 4);
    // the 4 particles are 4 different (direction, energy) classes: each group has one ray, rms 0
    near(evaluateMetric({ type: 'groupedBlur', plane: 'det' }, result, resolved), 0, 1e-15, 'one ray per group');
});

test('plane frames, rms radius and the closed-form waist', () => {
    const fr = planeFrame({ kind: 'segment', p0: [0, 0], p1: [0, 2] });
    near(fr.n[0], 1, 1e-15, 'segment normal = (p1 − p0) rotated −90°');
    near(rmsRadius([1, -1], [0, 0]), 1, 1e-15, 'rms');
    const w = waistOf({ u: [1, -1], w: [0, 0], up: [-0.5, 0.5], wp: [0, 0] });
    near(w.offset, 2, 1e-15, 'waist 2 mm downstream'); near(w.rms, 0, 1e-15, 'point focus');
});
