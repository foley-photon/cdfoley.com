// WP2 contract: every export of the particle engine exists with its signature and returns structurally valid results.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ENGINE = '../../beta/ion-optics/js/engine/';
const C = await import(ENGINE + 'constants.js');
const L = await import(ENGINE + 'layout.js');
const R = await import(ENGINE + 'rng.js');
const W = await import(ENGINE + 'waveform.js');
const M = await import(ENGINE + 'magnet.js');
const A = await import(ENGINE + 'analytic-fields.js');
const F = await import(ENGINE + 'fieldmodel.js');
const P = await import(ENGINE + 'particles.js');
const I = await import(ENGINE + 'integrate.js');
const T = await import(ENGINE + 'trace.js');
const Y = await import(ENGINE + 'analysis.js');
const CO = await import(ENGINE + 'coulomb.js');

function hasFn(mod, name, arity) {
    assert.equal(typeof mod[name], 'function', name + ' is a function');
    if (arity !== undefined) assert.ok(mod[name].length <= arity, name + ' declared parameters ≤ ' + arity);
}

test('constants.js exports (§2.1.2)', () => {
    for (const k of ['E_CHARGE', 'AMU_KG', 'ME_KG', 'C_MMUS', 'EPS0', 'MU0', 'K_ACC', 'ME_U', 'UC2_EV', 'MU0_4PI_MM']) assert.equal(typeof C[k], 'number', k);
    for (const [k, n] of [['speedFromKE', 3], ['properSpeedFromKE', 2], ['keFromProper', 5], ['gammaFromProper', 3], ['cyclotron', 5]]) hasFn(C, k, n);
    const cy = C.cyclotron(100, 1, 0.5, 1000, false);
    assert.equal(typeof cy.radiusMM, 'number'); assert.equal(typeof cy.freqMHz, 'number');
});

test('layout.js exports (§2.1.4)', () => {
    assert.equal(L.P_STRIDE, 16); assert.equal(L.S_STRIDE, 24); assert.equal(L.C_STRIDE, 14);
    const p = ['P_ID', 'P_SRC', 'P_SPECIES', 'P_MASS', 'P_CHARGE', 'P_T0', 'P_X', 'P_Y', 'P_Z', 'P_WX', 'P_WY', 'P_WZ', 'P_KE', 'P_C0', 'P_C1', 'P_C2'];
    p.forEach((k, i) => assert.equal(L[k], i, k));
    const s = ['S_ID', 'S_STATUS', 'S_WHERE', 'S_T', 'S_X', 'S_Y', 'S_Z', 'S_VX', 'S_VY', 'S_VZ', 'S_KE', 'S_TOF', 'S_STEPS', 'S_PATH', 'S_DE_END',
        'S_DE_MAX', 'S_WORK', 'S_NCROSS', 'S_TBAND', 'S_FLAGS', 'S_SRC', 'S_SPECIES', 'S_KE0', 'S_T0'];
    s.forEach((k, i) => assert.equal(L[k], i, k));
    const c = ['C_ID', 'C_PLANE', 'C_T', 'C_X', 'C_Y', 'C_Z', 'C_VX', 'C_VY', 'C_VZ', 'C_KE', 'C_DIR', 'C_K', 'C_KIND', 'C_ELEC'];
    c.forEach((k, i) => assert.equal(L[k], i, k));
    assert.deepEqual({ ...L.STATUS }, { FLYING: 0, HIT: 1, DETECTED: 2, EXIT: 3, TMAX: 4, STEPS: 5, ABSORBED: 6, DRIFT_END: 7, NUM_ERROR: 8, BORN_INSIDE: 9, CANCELLED: 10 });
    assert.deepEqual({ ...L.EDGE }, { XMIN: 0, XMAX: 1, YMIN: 2, YMAX: 3, ZMIN: 4, ZMAX: 5, RMAX: 6, DRIFT_LIMIT: 7 });
    assert.deepEqual({ ...L.FLAG }, { RELATIVISTIC: 1, ENTERED_BOUNDARY: 2, ENERGY_WARN: 4, TD_FIELDS: 8, BORIS: 16, STEP_FLOOR: 32 });
});

test('rng.js exports (§2.3)', () => {
    hasFn(R, 'hash32', 4); hasFn(R, 'uniform01', 4); hasFn(R, 'normal01', 4);
    assert.equal(typeof R.Stream, 'function');
    const s = new R.Stream(1, 2, 3);
    assert.equal(typeof s.next(), 'number'); assert.equal(typeof s.normal(), 'number');
    const h = R.hash32(1, 2, 3, 4);
    assert.ok(Number.isInteger(h) && h >= 0 && h < 2 ** 32);
});

test('waveform.js exports (§2.3)', () => {
    hasFn(W, 'timeFunctions', 1); hasFn(W, 'sampleWave', 4);
    const tf = W.timeFunctions([{ id: 'gnd', ground: true }, { v: 5, terms: [{ type: 'cos', amp: 2, freq: 1, phase: 0 }] }]);
    assert.ok(tf.dc instanceof Float64Array && tf.dc.length === 2);
    assert.equal(tf.channels.length, 1);
    const ch = tf.channels[0];
    assert.equal(typeof ch.key, 'string'); assert.ok(ch.amp instanceof Float64Array);
    for (const k of ['value', 'nextBreak']) assert.equal(typeof ch.fn[k], 'function');
    assert.equal(typeof ch.fn.period, 'number'); assert.equal(typeof ch.fn.minPeriod, 'number');
    const sw = W.sampleWave({ v: 1, terms: [] }, 0, 1, 5);
    assert.ok(sw.t instanceof Float64Array && sw.v instanceof Float64Array);
});

test('magnet.js exports (§2.3)', () => {
    hasFn(M, 'compileMagnets', 2); hasFn(M, 'loopField', 6); hasFn(M, 'ellipticKE', 1);
    const m = M.compileMagnets([{ type: 'uniform', B: [0, 0, 1] }], 'planar2d');
    for (const k of ['add', 'regionSig']) assert.equal(typeof m[k], 'function', k);
    assert.equal(typeof m.any, 'boolean'); assert.equal(typeof m.hasRegions, 'boolean'); assert.equal(typeof m.bMax, 'number');
    const out = [0, 0, 0]; m.add(0, 0, 0, out); assert.deepEqual(out, [0, 0, 1]);
    const ke = M.ellipticKE(0.5); assert.equal(ke.length, 2);
    const o2 = new Float64Array(2); M.loopField(10, 1, 1, 0, 0, o2); assert.ok(o2[1] > 0);
});

test('analytic-fields.js exports (§2.3)', () => {
    hasFn(A, 'compileIdealFields', 1); hasFn(A, 'analyticGrid', 1);
    assert.equal(A.compileIdealFields([]), null);
    const f = A.compileIdealFields([{ type: 'uniformE', E: [1, 0, 0] }]);
    for (const k of ['E', 'nextBreak']) assert.equal(typeof f[k], 'function', k);
    assert.equal(typeof f.timeDependent, 'boolean'); assert.equal(typeof f.minPeriod, 'number');
    const g = A.analyticGrid({ phi: (x) => -x, grad: () => [-1, 0], bounds: [0, 1, 0, 1], h: 0.1 });
    for (const k of ['setChannels', 'evalChannels', 'cellTypeAt', 'nearAt', 'nodal', 'bytes']) assert.equal(typeof g[k], 'function', k);
    for (const k of ['interp', 'cyl', 'nx', 'ny', 'h', 'x0', 'y0', 'bounds', 'nChannels']) assert.ok(k in g, k);
    const out = new Float64Array(3);
    assert.equal(g.evalChannels(0.5, 0.5, out), 0);
    assert.ok(Math.abs(out[1] - 1) < 1e-12);
});

test('fieldmodel.js exports (§2.3)', () => {
    hasFn(F, 'createFieldModel', 1);
    const model = F.createFieldModel({ resolved: { domain: { type: 'planar2d', cell: 1, h: 1, x: [0, 10], y: [0, 10], nx: 11, ny: 11 }, electrodes: [{ id: 'gnd' }], magnets: [], idealFields: [] } });
    for (const k of ['E', 'B', 'potential', 'inside', 'near', 'ownerAt', 'firstHit', 'regionSig', 'nextBreak']) assert.equal(typeof model[k], 'function', k);
    for (const k of ['cyl', 'h', 'timeDependent', 'hasB', 'box', 'minPeriod']) assert.ok(k in model, k);
    const e4 = new Float64Array(4);
    assert.equal(model.E(0, 5, 5, 0, e4), 0);
    assert.equal(model.E(0, 50, 5, 0, e4), 3);
    assert.ok(Number.isNaN(e4[3]));
});

test('particles.js exports (§2.3)', () => {
    assert.ok(Array.isArray(P.SPECIES) && P.SPECIES.length === 12);
    for (const s of P.SPECIES) { assert.equal(typeof s.mass, 'number'); assert.equal(typeof s.charge, 'number'); assert.equal(typeof s.label, 'string'); }
    hasFn(P, 'countParticles', 1); hasFn(P, 'generate', 4);
    const src = [{ count: 3, species: [{ mass: 100, charge: 1, fraction: 1 }], position: { type: 'point', p: [0, 0, 0] }, direction: { type: 'fixed', dir: [1, 0, 0] }, energy: { type: 'mono', ke: 10 }, time: { type: 'fixed', t: 0 } }];
    assert.equal(P.countParticles(src), 3);
    const rows = P.generate(src, 0, 3, { domainType: 'planar2d', relativistic: true });
    assert.ok(rows instanceof Float64Array && rows.length === 3 * L.P_STRIDE);
});

test('integrate.js exports (§2.3, Appendix A)', () => {
    for (const k of ['c', 'a', 'b', 'bStar', 'e', 'd']) assert.ok(Array.isArray(I.DP45[k]) || Object.isFrozen(I.DP45[k]), k);
    assert.equal(I.DP45.c.length, 7); assert.equal(I.DP45.b.length, 7); assert.equal(I.DP45.d.length, 7);
    hasFn(I, 'dp45Step', 7); hasFn(I, 'dp45Dense', 6); hasFn(I, 'borisPush', 6); hasFn(I, 'rk4Step', 6); hasFn(I, 'qualityPreset', 1);
    const q = I.qualityPreset('normal');
    assert.deepEqual(q, { rtol: 1e-8, maxStepCells: 0.5, nearStepCells: 0.1, rfStepsPerPeriod: 32, borisStepsPerGyration: 128 });
});

test('trace.js exports and TraceResult shape (§2.3)', () => {
    hasFn(T, 'traceParticles', 4); hasFn(T, 'mergeResults', 1); hasFn(T, 'resultTransferables', 1);
    const model = F.createFieldModel({ resolved: { domain: { type: 'planar2d', cell: 1, h: 1, x: [0, 10], y: [-5, 5], nx: 11, ny: 11 }, electrodes: [{ id: 'gnd' }], magnets: [], idealFields: [] } });
    const src = [{ count: 2, sampling: 'grid', species: [{ mass: 100, charge: 1, fraction: 1 }], position: { type: 'line', p0: [1, -1, 0], p1: [1, 1, 0], n: 2 }, direction: { type: 'fixed', dir: [1, 0, 0] }, energy: { type: 'mono', ke: 100 }, time: { type: 'fixed', t: 0 } }];
    const parts = P.generate(src, 0, 2, {});
    const r = T.traceParticles(model, parts, { planes: [{ kind: 'x', at: 5, terminate: false }], record: { trajectories: true, markersDt: 0.1 } });
    for (const k of ['n', 'i0', 'summary', 'crossings', 'nCross', 'traj', 'markers', 'stats']) assert.ok(k in r, k);
    assert.equal(r.n, 2); assert.equal(r.i0, 0);
    assert.ok(r.summary instanceof Float64Array && r.summary.length === 2 * L.S_STRIDE);
    assert.ok(r.crossings instanceof Float64Array && r.crossings.length === r.nCross * L.C_STRIDE);
    assert.equal(r.nCross, 2);
    assert.ok(r.traj.offsets instanceof Uint32Array && r.traj.offsets.length === 3);
    assert.ok(r.traj.pts instanceof Float32Array && r.traj.pts.length === 4 * r.traj.offsets[2]);
    assert.ok(r.markers instanceof Float32Array && r.markers.length % 5 === 0);
    for (const k of ['steps', 'rejects', 'evals', 'ms']) assert.equal(typeof r.stats[k], 'number', k);
    for (let i = 0; i < 2; i++) assert.equal(r.summary[i * L.S_STRIDE + L.S_STATUS], L.STATUS.EXIT);
    const merged = T.mergeResults([r]);
    assert.equal(merged.n, 2);
    const tr = T.resultTransferables(r);
    assert.ok(tr.length >= 3 && tr.every((b) => b instanceof ArrayBuffer));
});

test('analysis.js exports (§2.3)', () => {
    for (const [k, n] of [['summarize', 2], ['planeRows', 3], ['spotStats', 2], ['waist', 2], ['emittance', 3], ['histogram', 2], ['peakStats', 1], ['groupBy', 3], ['groupedSpots', 3], ['tofCalibration', 1]]) hasFn(Y, k, n);
    const h = Y.histogram([1, 2, 3], { bins: 2 });
    assert.ok(h.edges instanceof Float64Array && h.counts.length === 2);
    const ps = Y.peakStats([1, 2, 3]);
    for (const k of ['n', 'mean', 'std', 'fwhm', 'tPeak', 'resolvingPower']) assert.ok(k in ps, k);
});

test('coulomb.js exports (stretch, §2.3)', () => {
    hasFn(CO, 'traceCoulomb', 4);
    const model = F.createFieldModel({ resolved: { domain: { type: 'planar2d', cell: 1, h: 1, x: [-10, 10], y: [-10, 10], nx: 21, ny: 21 }, electrodes: [{ id: 'gnd' }], magnets: [], idealFields: [] } });
    const r = CO.traceCoulomb(model, new Float64Array(0), {});
    for (const k of ['n', 'i0', 'summary', 'crossings', 'nCross', 'traj', 'markers', 'stats']) assert.ok(k in r, k);
});
