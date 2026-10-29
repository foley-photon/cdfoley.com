// WP2 analysis: histograms, peak statistics, emittance, waist, spot and grouped statistics, summaries, TOF calibration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, planeRows, spotStats, waist, emittance, histogram, peakStats, groupBy, groupedSpots, groupedBlur, tofCalibration, detectedTimes }
    from '../../beta/ion-optics/js/engine/analysis.js';
import { normal01, uniform01 } from '../../beta/ion-optics/js/engine/rng.js';
import * as L from '../../beta/ion-optics/js/engine/layout.js';

const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);

/** Crossing rows from objects { id, plane, x, y, z, vx, vy, vz, dir, kind, t }. */
function crossRows(list) {
    const C = new Float64Array(list.length * L.C_STRIDE);
    list.forEach((r, i) => {
        const b = i * L.C_STRIDE;
        C[b + L.C_ID] = r.id ?? i; C[b + L.C_PLANE] = r.plane ?? 0; C[b + L.C_T] = r.t ?? 0;
        C[b + L.C_X] = r.x ?? 0; C[b + L.C_Y] = r.y ?? 0; C[b + L.C_Z] = r.z ?? 0;
        C[b + L.C_VX] = r.vx ?? 1; C[b + L.C_VY] = r.vy ?? 0; C[b + L.C_VZ] = r.vz ?? 0;
        C[b + L.C_KE] = r.ke ?? 0; C[b + L.C_DIR] = r.dir ?? 1; C[b + L.C_K] = 1; C[b + L.C_KIND] = r.kind ?? 0; C[b + L.C_ELEC] = r.elec ?? -1;
    });
    return C;
}
/** A stratified Gaussian sample (Box–Muller on a regular grid of (u1, u2)): very low noise. */
function stratifiedGaussian(mu, sigma, n1 = 200, n2 = 100) {
    const out = [];
    for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) {
        const u1 = (i + 0.5) / n1, u2 = (j + 0.5) / n2;
        out.push(mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
    }
    return out;
}

test('histogram: exact counts, edges, weights, range, max value in the last bin, auto bins ≥ 10', () => {
    const v = Array.from({ length: 20 }, (_, i) => i * 0.5);
    const h = histogram(v, { bins: 10, min: 0, max: 10 });
    assert.deepEqual([...h.counts], Array(10).fill(2));
    assert.deepEqual([...h.edges], Array.from({ length: 11 }, (_, k) => k));
    const h2 = histogram([0, 1, 2, 3, 10, 11, -1, NaN, Infinity], { bins: 5, min: 0, max: 10 });
    assert.deepEqual([...h2.counts], [2, 2, 0, 0, 1], 'outside values and non-finite values ignored, max included');
    const h3 = histogram([1, 2, 3], { bins: 2, min: 0, max: 4, weights: [0.5, 2, 10] });
    assert.deepEqual([...h3.counts], [0.5, 12]);
    const h4 = histogram(stratifiedGaussian(0, 1));
    assert.ok(h4.counts.length >= 10);
    assert.equal(h4.counts.reduce((a, b) => a + b, 0), 20000);
    // Freedman–Diaconis: width 2·IQR·n^(−1/3), IQR = 1.349σ
    const w = h4.edges[1] - h4.edges[0];
    close(w, 2 * 1.349 * Math.pow(20000, -1 / 3), 0.01, 'FD bin width');
    assert.equal(histogram([5, 5, 5]).counts.reduce((a, b) => a + b, 0), 3, 'degenerate range');
});

test('peakStats: Gaussian FWHM within 1% (stratified and random samples), R = t̄/(2·FWHM), few-value fallback', () => {
    const s = peakStats(stratifiedGaussian(50, 0.2));
    const fwhm = 0.2 * 2 * Math.sqrt(2 * Math.LN2);
    assert.ok(Math.abs(s.fwhm / fwhm - 1) < 0.01, 'FWHM ' + s.fwhm + ' vs ' + fwhm);
    close(s.mean, 50, 1e-6); close(s.std, 0.2, 2e-3); close(s.tPeak, 50, 0.01);
    close(s.resolvingPower, s.mean / (2 * s.fwhm), 1e-12);
    assert.equal(s.note, null);
    const rnd = [];
    for (let i = 0; i < 100000; i++) rnd.push(20 + 0.5 * normal01(4, 0, i, 0));
    const r = peakStats(rnd);
    assert.ok(Math.abs(r.fwhm / (0.5 * 2.354820045) - 1) < 0.01, 'random FWHM ' + r.fwhm);
    const few = peakStats([1, 2, 3, 4]);
    close(few.fwhm, 2.3548200450309493 * Math.sqrt(1.25), 1e-12); assert.ok(few.note.includes('2.3548'));
    assert.equal(peakStats([]).n, 0);
});

test('peakStats on an edge-peaked distribution: robust R values stable with the sample size, FWHM flagged as unresolved', () => {
    // t = 30 + 1e-3·u², u uniform in [−1, 1]: density ∝ 1/√(t − 30), a peak with a steep (integrable) edge and no finite half-maximum width
    const sample = (n, seed) => Array.from({ length: n }, (_, i) => { const u = 2 * uniform01(seed, 0, i, 0) - 1; return 30 + 1e-3 * u * u; });
    const small = peakStats(sample(250, 3)), large = peakStats(sample(2000, 5));
    for (const k of ['resolvingPowerRms', 'resolvingPower76']) {
        assert.ok(Math.abs(small[k] / large[k] - 1) < 0.1, `${k}: ${small[k]} (250) vs ${large[k]} (2000)`);
    }
    // exact: σ² = 1e-6·(1/5 − 1/9), so R_rms = 30/(2·2.3548·σ)
    close(large.resolvingPowerRms, 30 / (2 * 2.3548200450309493 * 1e-3 * Math.sqrt(1 / 5 - 1 / 9)), 0.05 * large.resolvingPowerRms, 'R_rms');
    assert.equal(small.fwhmResolved, false); assert.equal(large.fwhmResolved, false);
    assert.ok(/not reliable/.test(large.note), large.note);
    // a Gaussian of 250 values is resolved, its FWHM within 15% and both robust R values within 15% of t/(2·2.3548σ)
    const g = Array.from({ length: 250 }, (_, i) => 50 + 0.2 * normal01(9, 0, i, 0));
    const gs = peakStats(g);
    assert.equal(gs.fwhmResolved, true, gs.note);
    assert.ok(Math.abs(gs.fwhm / (0.2 * 2.3548200450309493) - 1) < 0.15, 'Gaussian FWHM ' + gs.fwhm);
    for (const k of ['resolvingPower', 'resolvingPowerRms', 'resolvingPower76']) assert.ok(Math.abs(gs[k] / (50 / (2 * 0.2 * 2.3548200450309493)) - 1) < 0.15, `${k} ${gs[k]}`);
});

test('emittance and Twiss parameters of an ellipse to 1e-12', () => {
    const eps = 3.5, alpha = -0.7, beta = 2.2, gamma = (1 + alpha * alpha) / beta;
    const N = 64, list = [];
    for (let k = 0; k < N; k++) {
        const ph = 2 * Math.PI * k / N;
        const u = Math.sqrt(beta * 2 * eps) * Math.cos(ph) + 1.5, up = -Math.sqrt(2 * eps / beta) * (alpha * Math.cos(ph) + Math.sin(ph)) + 0.25;
        list.push({ x: 100, y: u, vx: 2, vy: 2 * up / 1000, vz: 0 });
    }
    const e = emittance(crossRows(list), 'y');
    close(e.epsRms, eps, 1e-12 * eps, 'ε'); close(e.alpha, alpha, 1e-12, 'α'); close(e.beta, beta, 1e-12, 'β'); close(e.gamma, gamma, 1e-12, 'γ');
    close(e.meanU, 1.5, 1e-13); close(e.meanUp, 0.25, 1e-13);
    assert.equal(e.n, N);
});

test('waist: closed form equals a brute-force scan; rays through a point give zero rms there', () => {
    // rays converging to (x = 37, y = 0, z = 0) from the plane x = 10
    const list = [];
    for (let k = 0; k < 9; k++) {
        const sy = (k - 4) * 0.01, sz = ((k * 7) % 9 - 4) * 0.005;
        list.push({ x: 10, y: -sy * 27, z: -sz * 27, vx: 3, vy: 3 * sy, vz: 3 * sz });
    }
    const w = waist(crossRows(list), 'x');
    close(w.position, 37, 1e-9); close(w.rms, 0, 1e-9); assert.equal(w.planePosition, 10);
    // a beam with emittance: compare with a dense scan of the rms radius
    const b = [];
    for (let k = 0; k < 50; k++) b.push({ x: -5, y: Math.sin(k) * 2, z: Math.cos(3 * k), vx: 1, vy: -0.03 * Math.sin(k) + 0.004 * Math.cos(5 * k), vz: 0.01 * Math.sin(2 * k) - 0.02 * Math.cos(3 * k) });
    const wb = waist(crossRows(b), 'x');
    const rms = (x) => {
        const ys = b.map((r) => r.y + r.vy / r.vx * (x + 5)), zs = b.map((r) => r.z + r.vz / r.vx * (x + 5));
        const my = ys.reduce((a, c) => a + c, 0) / b.length, mz = zs.reduce((a, c) => a + c, 0) / b.length;
        return Math.sqrt(ys.reduce((a, c) => a + (c - my) ** 2, 0) / b.length + zs.reduce((a, c) => a + (c - mz) ** 2, 0) / b.length);
    };
    let best = Infinity, bx = 0;
    for (let x = -50; x <= 150; x += 0.001) { const r = rms(x); if (r < best) { best = r; bx = x; } }
    close(wb.position, bx, 2e-3); close(wb.rms, best, 1e-9);
    close(wb.rmsAtPlane, rms(-5), 1e-12);
});

test('spotStats, groupBy, groupedSpots and grouped blur', () => {
    const rows = crossRows([{ y: 1, z: 0 }, { y: 3, z: 0 }, { y: 2, z: 2 }, { y: 2, z: -2 }]);
    const s = spotStats(rows);
    close(s.cu, 2, 1e-15); close(s.cv, 0, 1e-15); close(s.rmsU, Math.sqrt(0.5), 1e-15); close(s.rmsV, Math.sqrt(2), 1e-15); close(s.rms, Math.sqrt(2.5), 1e-15);
    assert.deepEqual([s.minU, s.maxU, s.minV, s.maxV], [1, 3, -2, 2]);
    assert.ok(Number.isNaN(spotStats(new Float64Array(0)).rms));
    const g = crossRows([{ id: 0, y: 0, z: 0 }, { id: 1, y: 2, z: 0 }, { id: 2, y: 10, z: 10 }, { id: 3, y: 10, z: 14 }, { id: 4, y: 10, z: 12 }]);
    const key = (R, o) => (R[o + L.C_ID] < 2 ? 'a' : 'b');
    const groups = groupBy(g, key);
    assert.deepEqual([...groups.keys()], ['a', 'b']);
    assert.equal(groups.get('b').length, 3 * L.C_STRIDE);
    const spots = groupedSpots(g, key);
    assert.deepEqual(spots.map((p) => [p.key, p.n, p.cu, p.cv]), [['a', 2, 1, 0], ['b', 3, 10, 12]]);
    close(spots[0].rms, 1, 1e-15); close(spots[1].rms, Math.sqrt(8 / 3), 1e-14);
    close(groupedBlur(spots), Math.sqrt((1 + 8 / 3) / 2), 1e-14);
});

test('TOF calibration t = a·√(m/q) + b', () => {
    const pairs = [1, 4, 16, 50, 100].map((mq) => ({ mq, t: 2.5 * Math.sqrt(mq) + 0.3 }));
    const c = tofCalibration(pairs);
    close(c.a, 2.5, 1e-13); close(c.b, 0.3, 1e-12); close(c.r2, 1, 1e-14); assert.equal(c.n, 5);
    const c2 = tofCalibration([[100, 22.76], [101, 22.877], [200, 32.2]]);
    assert.ok(c2.r2 > 0.999 && c2.r2 <= 1);
    assert.ok(Number.isNaN(tofCalibration([[1, 2]]).a));
});

test('summarize, planeRows (side, plane, filters, meshes) and detectedTimes on a synthetic result', () => {
    const n = 6, Sm = new Float64Array(n * L.S_STRIDE);
    const set = (i, f, v) => { Sm[i * L.S_STRIDE + f] = v; };
    const spec = [
        [L.STATUS.DETECTED, 0, 0, 0, 1e-7, 5.1], [L.STATUS.DETECTED, 0, 0, 1, -3e-7, 5.3], [L.STATUS.HIT, 2, 0, 0, NaN, 1],
        [L.STATUS.ABSORBED, 3, 1, 0, 2e-6, 2], [L.STATUS.EXIT, L.EDGE.XMAX, 1, 0, 5e-8, 3], [L.STATUS.BORN_INSIDE, 2, 1, 1, NaN, 0],
    ];
    spec.forEach(([st, w, src, sp, dE, tof], i) => {
        set(i, L.S_ID, i); set(i, L.S_STATUS, st); set(i, L.S_WHERE, w); set(i, L.S_SRC, src); set(i, L.S_SPECIES, sp);
        set(i, L.S_DE_END, dE); set(i, L.S_KE0, 100); set(i, L.S_PATH, 10 * i); set(i, L.S_WORK, i * 1e-9); set(i, L.S_TOF, tof);
        set(i, L.S_FLAGS, i === 3 ? L.FLAG.ENERGY_WARN : 0);
    });
    const C = crossRows([
        { id: 0, plane: 0, y: 1, dir: 1 }, { id: 0, plane: 1, y: 2, dir: -1 }, { id: 1, plane: 0, y: 3, dir: 1 },
        { id: 1, plane: 1, y: 4, dir: 1 }, { id: 1, plane: 1, y: 5, dir: -1 }, { id: 3, plane: -1, kind: 1, elec: 3, y: 6 },
    ]);
    const result = { n, i0: 0, summary: Sm, crossings: C, nCross: 6, traj: null, markers: null, stats: {} };
    const resolved = {
        electrodes: [{ id: 'gnd', name: 'Ground' }, { id: 'a' }, { id: 'b', name: 'Cap' }, { id: 'm', name: 'Mesh' }],
        recording: { planes: [{ id: 'det', name: 'Detector', terminate: true }, { id: 'p', name: 'Monitor' }] },
        sources: [{ id: 's0', name: 'Beam', species: [{ label: 'm100', mass: 100, charge: 1 }, { label: 'm101', mass: 101, charge: 1 }] }, { id: 's1', species: [{ label: 'e' }, { label: 'f' }] }],
    };
    const s = summarize(result, resolved);
    assert.equal(s.launched, 6); assert.equal(s.traced, 6);
    assert.equal(s.byStatus.DETECTED, 2); assert.equal(s.byStatus.HIT, 1); assert.equal(s.byStatus.ABSORBED, 1); assert.equal(s.byStatus.EXIT, 1); assert.equal(s.byStatus.BORN_INSIDE, 1);
    assert.equal(s.byElectrode[2].hit, 1); assert.equal(s.byElectrode[2].bornInside, 1); assert.equal(s.byElectrode[3].absorbed, 1); assert.equal(s.byElectrode[2].name, 'Cap');
    assert.equal(s.byPlane[0].detected, 2); assert.equal(s.byPlane[0].crossings, 2); assert.equal(s.byPlane[1].crossings, 3); assert.equal(s.byPlane[1].particles, 2);
    assert.equal(s.bySource[0].launched, 3); assert.equal(s.bySource[0].detected, 2); assert.equal(s.bySource[1].byStatus.EXIT, 1);
    const m100 = s.bySpecies.find((r) => r.source === 0 && r.species === 0);
    assert.equal(m100.label, 'm100'); assert.equal(m100.launched, 2); close(m100.transmission, 0.5, 1e-15);
    close(s.transmission.overall, 2 / 6, 1e-15);
    assert.deepEqual(s.transmission.byPlane.map((p) => [p.id, p.detected]), [['det', 2]]);
    close(s.energy.maxEnd, 2e-6, 1e-20); close(s.energy.maxEndRel, 2e-8, 1e-22); close(s.energy.medianEnd, 2e-7, 1e-20);
    assert.equal(s.energy.maxPath, 50); close(s.energy.maxWork, 5e-9, 1e-22); assert.equal(s.energy.warned + s.energy.warnedHit, 1);
    // plane rows
    assert.equal(planeRows(result, 1).length / L.C_STRIDE, 3);
    assert.equal(planeRows(result, 1, { side: 'forward' }).length / L.C_STRIDE, 1);
    assert.equal(planeRows(result, 1, { side: 'backward' }).length / L.C_STRIDE, 2);
    const f = planeRows(result, 0, { filter: { species: 1 } });
    assert.equal(f.length / L.C_STRIDE, 1); assert.equal(f[L.C_ID], 1);
    assert.equal(planeRows(result, 1, { filter: (R, o) => R[o + L.C_Y] > 4 }).length / L.C_STRIDE, 1);
    const mesh = planeRows(result, -1);
    assert.equal(mesh.length / L.C_STRIDE, 1); assert.equal(mesh[L.C_ELEC], 3);
    assert.deepEqual([...detectedTimes(result, 0)], [5.1, 5.3]);
});
