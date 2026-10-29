// WP-C field analysis engine (improvement plan §4, WP-C): Gauss-flux charges and capacitance (P4: coaxial cylinders
// 80.2607 pF/m, concentric spheres 26.7036 pF at cell 1), floating conductors from C·V = Q (B13: 50 V midway),
// Shockley–Ramo induced charge and current from recorded trajectories (B8), spectra, and multipole coefficients on a
// circle (planar Fourier; T17 round rods) and a sphere (cylindrical Legendre). Also the "Charges & multipoles" panel
// module's pure helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pipeline from '../../beta/ion-optics/js/engine/pipeline.js';
import * as FA from '../../beta/ion-optics/js/engine/fieldanalysis.js';
import { EPS0, E_CHARGE, ME_U, K_ACC, speedFromKE } from '../../beta/ion-optics/js/engine/constants.js';
import { ENGINE_VERSION, PROJECT_FORMAT } from '../../beta/ion-optics/js/engine/version.js';
import { validate } from '../../beta/ion-optics/js/engine/schema.js';
import * as L from '../../beta/ion-optics/js/engine/layout.js';

const ED = (electrode) => ({ bc: 'dirichlet', electrode });
const NEU = { bc: 'neumann' };
const AXIS = { bc: 'axis' };
const META_TIME = '2026-10-14T00:00:00Z';
const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (tol ${tol})`);
const relClose = (a, b, tol, msg = '') => assert.ok(Math.abs(a / b - 1) <= tol, `${msg} ${a} vs ${b} (rel ${Math.abs(a / b - 1)}, tol ${tol})`);

function el(id, v = 0, extra = {}) { return { id, name: id, kind: 'solid', v, wave: null, color: '#64748b', ...extra }; }
/** A complete version-1 project for a test setup (the same shape as the benchmark registry's). */
function proj(name, type, o) {
    const cyl = type === 'cyl2d';
    const edges = { xmin: ED('gnd'), xmax: ED('gnd'), ymin: cyl ? AXIS : ED('gnd'), ymax: ED('gnd'), ...(o.edges || {}) };
    return {
        format: PROJECT_FORMAT, version: 1,
        meta: { name, notes: '', created: META_TIME, modified: META_TIME, engine: ENGINE_VERSION },
        params: [],
        domain: { type, cell: o.cell, x: o.x.slice(), y: o.y.slice(), edges, mirror: { x: !!(o.mirror && o.mirror.x), y: !!(o.mirror && o.mirror.y) },
            beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' } },
        electrodes: [{ id: 'gnd', name: 'Ground', ground: true, color: '#64748b' }, ...(o.electrodes || [])],
        shapes: (o.shapes || []).map((s, i) => ({ id: 's' + (i + 1), enabled: true, locked: false, ...s })),
        magnets: o.magnets || [], idealFields: [],
        sources: o.sources || [],
        recording: { planes: o.planes || [], trajectories: { store: true, maxPoints: o.maxPoints || 2000 }, timeMarkers: o.markers ? { dt: o.markers } : null },
        tracer: { integrator: 'rk45', quality: 'custom', custom: { rtol: 1e-11, maxStepCells: 0.5, nearStepCells: 0.1, rfStepsPerPeriod: 32, borisStepsPerGyration: 128 },
            fieldInterp: 'cubic', relativistic: false, tMax: o.tMax || 1000, maxSteps: 500000, maxDrift: 10000, drag: null },
        solver: { boundary: 'subgrid', method: 'auto', tol: 1e-12, maxCycles: 60, maxIterations: 200, maxSweeps: 100000 },
        analysis: { lens: null, scan: null, optimize: null, waist: null },
        view: { center: [0, 0], scale: 6, displayTime: 0, projection: 'xy', colormap: 'auto', contourLevels: null,
            layers: { potential: true, contours: 20, field: false, electrodes: true, trajectories: 'source', planes: true, hits: true, grid: 'auto', mirror: true, markers: false } },
    };
}
function solve(p) {
    assert.deepEqual(validate(p).errors, [], 'setup validates');
    const r = pipeline.resolveOrThrow(p);
    return { r, s: pipeline.solveProject(r) };
}

/** S1 geometry: coaxial cylinders a = 10, b = 20 mm, quarter domain with mirrors. */
const coax = (h) => proj('coax', 'planar2d', { cell: h, x: [0, 22], y: [0, 22], mirror: { x: true, y: true }, edges: { xmin: NEU, ymin: NEU },
    electrodes: [el('inner', 100)], shapes: [{ type: 'circle', electrode: 'inner', cx: 0, cy: 0, r: 10 }, { type: 'annulus', electrode: 'gnd', cx: 0, cy: 0, rIn: 20, rOut: 32, a0: 0, a1: 360 }] });
/** S2 geometry: concentric spheres 80 / 120 mm, cylindrical, mirrored at x = 0. */
const spheres = (h) => proj('spheres', 'cyl2d', { cell: h, x: [0, 125], y: [0, 125], mirror: { x: true }, edges: { xmin: NEU, xmax: ED('outer'), ymax: ED('outer') },
    electrodes: [el('inner', 500), el('outer', -1000 / 3)], shapes: [{ type: 'circle', electrode: 'inner', cx: 0, cy: 0, r: 80 }, { type: 'annulus', electrode: 'outer', cx: 0, cy: 0, rIn: 120, rOut: 180, a0: 0, a1: 360 }] });
const C_COAX = 2 * Math.PI * EPS0 / Math.log(2);                       // F/m
const C_SPHERE = 4 * Math.PI * EPS0 / (1 / 0.08 - 1 / 0.12);          // F

// ---------------------------------------------------------------- Gauss flux and capacitance (P4)
test('P4 coaxial cylinders: C = 80.2607 pF/m within 1e-3 at cell 1 (and better when finer); charge neutrality; symmetry', () => {
    close(C_COAX * 1e12, 80.2607, 5e-4, 'closed form');
    for (const [h, tol] of [[1, 1e-3], [0.2, 1e-5]]) {
        const { s } = solve(coax(h));
        const part = FA.chargePartition(s.raster0);
        assert.equal(part.unlabeled, 0);
        assert.equal(part.faces.irregular, 0, 'the contour stays in regular cells');
        assert.equal(part.mirrorFactor, 4);
        const cm = FA.capacitanceMatrix(part, s.bases);
        assert.equal(cm.n, 2);
        assert.equal(cm.unit, 'F/m');
        assert.equal(cm.derived, 0);
        relClose(cm.C[3], C_COAX, tol, `C11 at cell ${h}`);
        relClose(-cm.C[1], C_COAX, tol, `C01 at cell ${h}`);
        relClose(cm.C[0], C_COAX, tol, 'derived ground column');
        assert.ok(cm.columnSum <= 1e-12, `charge neutrality ${cm.columnSum}`);
        assert.ok(cm.asymmetry <= 1e-12, `reciprocity ${cm.asymmetry}`);
        // charges for the actual voltage: Q/L = C·V, positive on the inner conductor; the same from the display potential
        const q = FA.gaussCharges(part, s.bases.get(1));
        assert.equal(q.unit, 'C/m');
        relClose(q.charge[1], C_COAX, tol, 'basis charge');
        assert.ok(Math.abs(q.total) <= 1e-12 * Math.abs(q.charge[1]), 'total charge zero');
        const phi = new Float64Array(s.bases.get(1).length);
        for (let k = 0; k < phi.length; k++) phi[k] = 100 * s.bases.get(1)[k];
        const q2 = FA.gaussCharges(part, phi, [0, 100]);
        relClose(q2.charge[1], 100 * C_COAX, tol, 'charge at 100 V');
        const q3 = FA.gaussCharges(part, phi);   // cut values read from the fixed nodes
        close(q3.charge[1], q2.charge[1], 1e-25);
    }
});

test('P4 concentric spheres: C = 26.7036 pF within 1e-3 at cell 1; Q = 2.2253e-8 C at 500 / −333.33 V (B15)', () => {
    close(C_SPHERE * 1e12, 26.7036, 5e-4, 'closed form');
    const { r, s } = solve(spheres(1));
    const part = FA.chargePartition(s.raster0);
    assert.equal(part.cyl, true);
    assert.equal(part.mirrorFactor, 2);
    assert.equal(part.faces.irregular, 0);
    const cm = FA.capacitanceMatrix(part, s.bases);
    assert.equal(cm.unit, 'F');
    const n = cm.n;
    relClose(cm.C[1 * n + 1], C_SPHERE, 1e-3, 'C(inner, inner)');
    relClose(-cm.C[1 * n + 2], C_SPHERE, 1e-3, 'C(inner, outer)');
    relClose(cm.C[2 * n + 2], C_SPHERE, 1e-3, 'C(outer, outer)');
    assert.ok(Math.abs(cm.C[0 * n + 1]) < 1e-6 * C_SPHERE, 'the ground has no surface between the spheres');
    assert.ok(cm.asymmetry < 1e-9, `reciprocity ${cm.asymmetry}`);
    const volts = r.electrodes.map((e) => e.dc);
    const fp = FA.floatingPotentials(cm, volts, []);
    relClose(fp.charges[1], 2.225301e-8, 1e-3, 'charge on the inner sphere');
    close(fp.charges[1] + fp.charges[2], 0, 1e-9 * fp.charges[1]);
});

test('B13 floating conductor: a plate midway between 0 and 100 V floats at 50 ± 0.05 V; at a quarter of the gap 25 V; thick plate 23.684 V', () => {
    const cases = [
        ['midway line', [{ type: 'polyline', electrode: 'float', points: [[0, 10], [40, 10]] }], 50],
        ['midway box', [{ type: 'box', electrode: 'float', x0: 0, x1: 40, y0: 9.5, y1: 10.5 }], 50],
        ['line at y = 5', [{ type: 'polyline', electrode: 'float', points: [[0, 5], [40, 5]] }], 25],
        ['box 4.5–5.5', [{ type: 'box', electrode: 'float', x0: 0, x1: 40, y0: 4.5, y1: 5.5 }], 100 * 4.5 / 19],
    ];
    for (const [name, shapes, expect] of cases) {
        const { s } = solve(proj('floating', 'planar2d', { cell: 1, x: [0, 40], y: [0, 20], edges: { xmin: NEU, xmax: NEU, ymin: ED('gnd'), ymax: ED('top') }, electrodes: [el('top', 100), el('float', 0)], shapes }));
        const part = FA.chargePartition(s.raster0);
        const cm = FA.capacitanceMatrix(part, s.bases);
        const fp = FA.floatingPotentials(cm, [0, 100, 0], [{ index: 2, charge: 0 }]);
        assert.ok(fp.ok, name);
        close(fp.volts[2], expect, 0.05, name);
        close(fp.charges[2], 0, 1e-9 * Math.abs(fp.charges[1]), `${name}: the floating plate is uncharged`);
        assert.deepEqual(fp.solved.map((x) => x.index), [2]);
        // a charged floating plate moves away from the symmetric value in the right direction
        const fq = FA.floatingPotentials(cm, [0, 100, 0], [{ index: 2, charge: 1e-10 }]);
        assert.ok(fq.volts[2] > fp.volts[2], `${name}: positive charge raises the potential`);
        // two floating conductors: the plate and the top electrode with no charge → everything at 0 V
        const f2 = FA.floatingPotentials(cm, [0, 100, 0], [{ index: 1 }, { index: 2 }]);
        close(f2.volts[1], 0, 1e-9); close(f2.volts[2], 0, 1e-9);
    }
});

test('chargePartition: sub-cell plate (zero-thickness line) owns a region; faces list separates labels; cut faces counted', () => {
    const { s } = solve(proj('line', 'planar2d', { cell: 1, x: [0, 20], y: [0, 20], edges: { xmin: NEU, xmax: NEU }, electrodes: [el('line', 1)],
        shapes: [{ type: 'polyline', electrode: 'line', points: [[5, 10.3], [15, 10.3]] }] }));
    const part = FA.chargePartition(s.raster0);
    assert.ok(part.regionNodes[1] > 0, 'the line has a region although it holds no grid node');
    assert.equal(part.fixedNode[1], -1, 'no fixed node of the line');
    for (let f = 0; f < part.faces.count; f++) assert.notEqual(part.faces.a[f], part.faces.b[f]);
    const q = FA.gaussCharges(part, s.bases.get(1), [0, 1]);
    assert.ok(q.charge[1] > 0 && Math.abs(q.total) < 1e-12 * q.charge[1]);
    // the line's charge exceeds the two parallel-plate contributions ε0·L·(1/d_down + 1/d_up) per metre (fringe fields add to it)
    const est = EPS0 * 10 * (1 / 10.3 + 1 / 9.7);
    assert.ok(q.charge[1] > est && q.charge[1] < 3 * est, `line charge ${q.charge[1]} vs plate estimate ${est}`);
});

// ---------------------------------------------------------------- potential evaluators
test('createPotentialEvaluator folds mirrors and maps the cylindrical field; voltageEvaluator combines bases', () => {
    const { r, s } = solve(coax(0.5));
    const ev = FA.voltageEvaluator(s, r, [0, 100]);
    assert.equal(ev.nChannels, 1);
    assert.deepEqual(ev.mirror, { x: true, y: true });
    const out = new Float64Array(3);
    const exact = (x, y) => 100 * Math.log(20 / Math.hypot(x, y)) / Math.log(2);
    for (const [x, y] of [[12, 5], [-12, 5], [12, -5], [-12, -5]]) {
        ev.evalPlane(x, y, out);
        close(out[0], exact(x, y), 2e-3, `φ at (${x}, ${y})`);
        // E points outward from the inner conductor: E ∥ r̂ with the sign of the coordinates
        assert.ok(out[1] * x > 0 && out[2] * y > 0, `E direction at (${x}, ${y})`);
        close(ev.potential(0, x, y, 0), out[0], 1e-12);
    }
    assert.ok(Number.isNaN(ev.potential(0, 30, 30, 0)), 'NaN outside');
    // cylindrical: the spheres' field at a 3D point off the plane
    const sp = solve(spheres(1));
    const ev2 = FA.voltageEvaluator(sp.s, sp.r, sp.r.electrodes.map((e) => e.dc));
    const E3 = new Float64Array(3);
    const x = 30, y = 60, z = 80, rr = Math.hypot(x, y, z);
    close(ev2.potential(0, x, y, z), 200000 / rr - 2000, 0.05, 'φ at a 3D point');
    ev2.field(0, x, y, z, E3);
    const Emag = 200000 / (rr * rr);
    close(E3[0], Emag * x / rr, 3e-3 * Emag); close(E3[1], Emag * y / rr, 3e-3 * Emag); close(E3[2], Emag * z / rr, 3e-3 * Emag);
    ev2.field(0, -x, y, z, E3);
    close(E3[0], -Emag * x / rr, 3e-3 * Emag, 'mirror.x flips E_x');
});

// ---------------------------------------------------------------- Shockley–Ramo (B8)
const B8 = (() => {
    const B = -4.7688984e-3, ke = 2;
    const v = speedFromKE(ke, ME_U, false), w = K_ACC * (1 / ME_U) * Math.abs(B), T = 2 * Math.PI / w, rC = v / w;
    const electron = { label: 'e⁻', mass: ME_U, charge: -1, fraction: 1 };
    const src = (id, p, d) => ({ id, name: id, enabled: true, color: 'auto', count: 1, sampling: 'grid', seed: 1, species: [electron],
        position: { type: 'point', p }, direction: { type: 'fixed', dir: d }, energy: { type: 'mono', ke }, time: { type: 'fixed', t: 0 } });
    let cache = null;
    return {
        v, T, rC, iPeak: E_CHARGE * (v * 1e3) * 100, qPeak: 0.6 * E_CHARGE,
        run() {
            if (cache) return cache;
            // electrode A at y = 0 (weighting potential 1 − y/10), ground at y = 10; electron 2 eV from (0, 5) along +x circles
            // about (0, 4) with radius 1 mm; a second electron starts opposite on the same circle
            const p = proj('B8', 'planar2d', { cell: 0.25, x: [-3, 3], y: [0, 10], edges: { xmin: NEU, xmax: NEU, ymin: ED('A'), ymax: ED('gnd') },
                electrodes: [el('A', 0)], magnets: [{ id: 'm1', name: 'B', enabled: true, type: 'uniform', B: [0, 0, B] }],
                sources: [src('e1', [0, 5, 0], [1, 0, 0]), src('e2', [0, 3, 0], [-1, 0, 0])],
                planes: [{ id: 'py4', name: 'y = 4', kind: 'y', at: 4, limits: null, radius: null, terminate: false, side: 'both', record: 'all' }],
                markers: T / 64, tMax: 32 * T, maxPoints: 5000 });
            const { r, s } = solve(p);
            const f = pipeline.buildField(r, s);
            const res = pipeline.traceProject(r, f);
            cache = { r, s, f, res };
            return cache;
        },
    };
})();

test('B8 induced charge and current: Q_A = −q φ_A = 0.6 e and i = q v·E_w = 1.3438e-11 A at the peak-current points, rel 1e-6', () => {
    const { r, s, res } = B8.run();
    assert.equal(L.STATUS_NAMES[res.summary[L.S_STATUS]], 'TMAX');
    close(B8.rC, 1, 1e-5, 'radius 1 mm');
    const ev = FA.weightingPotentials(s, r, [1]);
    assert.deepEqual(ev.electrodes, [1]);
    const c = ev.channelOf(1);
    assert.equal(c, 0);
    assert.equal(ev.channelOf(7), -1);
    // the weighting potential is linear: exact
    close(ev.potential(c, 1.3, 4, 0), 0.6, 1e-12);
    close(ev.potential(c, -2, 7.5, 0), 0.25, 1e-12);
    const C = res.crossings;
    let n = 0;
    for (let k = 0; k < res.nCross; k++) {
        const b = k * L.C_STRIDE;
        if (C[b + L.C_ID] !== 0 || C[b + L.C_KIND] !== 0) continue;
        const x = C[b + L.C_X], y = C[b + L.C_Y], z = C[b + L.C_Z];
        const Q = FA.inducedCharge(ev, c, -1, x, y, z);
        const I = FA.inducedCurrent(ev, c, -1, x, y, z, C[b + L.C_VX], C[b + L.C_VY], C[b + L.C_VZ]);
        relClose(Q, B8.qPeak, 1e-6, 'Q at y = 4');
        relClose(Math.abs(I), B8.iPeak, 1e-6, 'peak current');
        assert.ok(Math.sign(I) === -Math.sign(C[b + L.C_VY]) * -1 || true);   // sign checked below from the geometry
        // moving towards A (v_y < 0) the induced positive charge on A grows: i > 0 for an electron
        assert.equal(Math.sign(I), Math.sign(-C[b + L.C_VY]), 'current sign: electron approaching A raises Q_A');
        n++;
    }
    assert.ok(n >= 60, `crossings of e1: ${n}`);
    // the closed-form values quoted by the concept study, 9.61306401e-20 C and 1.3438459e-11 A, use an older elementary charge and
    // electron mass: CODATA 2022 moves both in the sixth digit, so a 1e-6 gate must take its references from constants.js
    relClose(B8.qPeak, 9.61306401e-20, 1e-5, '0.6 e vs the quoted value');
    relClose(B8.iPeak, 1.3438459e-11, 1e-5, 'peak current vs the quoted value');
});

test('B8 from markers: two electrons 180° apart give a constant total charge and zero total current; spectrum at the cyclotron frequency', () => {
    const { r, s, res } = B8.run();
    const ev = FA.weightingPotentials(s, r, [1]);
    const ind = FA.inducedFromResult(ev, 0, res, r, { source: 'markers' });
    assert.equal(ind.source, 'markers');
    assert.equal(ind.count, 2);
    assert.ok(ind.total && ind.total.n >= 2048, `samples ${ind.total && ind.total.n}`);
    relClose(ind.total.dt, B8.T / 64, 1e-6, 'marker interval (single-precision marker times, averaged)');
    const tot = ind.total;
    let qMin = Infinity, qMax = -Infinity, iMax = 0;
    for (let i = 0; i < tot.n; i++) { qMin = Math.min(qMin, tot.charge[i]); qMax = Math.max(qMax, tot.charge[i]); iMax = Math.max(iMax, Math.abs(tot.current[i])); }
    close(qMin, 1.2 * E_CHARGE, 1e-6 * E_CHARGE, 'total charge 1.2 e');
    assert.ok((qMax - qMin) / (1.2 * E_CHARGE) < 1e-6, `constant total charge (spread ${(qMax - qMin) / (1.2 * E_CHARGE)})`);
    assert.ok(iMax < 1e-5 * B8.iPeak, `zero total current (${iMax} A)`);
    // one electron: charge between 0.5 e and 0.7 e, current by differences within the central-difference truncation (ωΔt)²/6
    const p1 = ind.particles[0];
    assert.equal(p1.method, 'difference');
    let q1Min = Infinity, q1Max = -Infinity, i1Max = 0;
    for (let i = 0; i < p1.n; i++) { q1Min = Math.min(q1Min, p1.charge[i]); q1Max = Math.max(q1Max, p1.charge[i]); i1Max = Math.max(i1Max, Math.abs(p1.current[i])); }
    close(q1Min, 0.5 * E_CHARGE, 1e-6 * E_CHARGE); close(q1Max, 0.7 * E_CHARGE, 1e-6 * E_CHARGE);
    relClose(i1Max, B8.iPeak, 3e-3, 'peak current by differences');
    const sp = FA.spectrum(p1.t, p1.current);
    assert.equal(sp.n, 2048);
    relClose(sp.peak.freq, 1 / B8.T, 1e-4, 'cyclotron frequency');
    relClose(sp.peak.amp, B8.iPeak, 3e-3, 'current amplitude');
    const spQ = FA.spectrum(p1.t, p1.charge);
    relClose(spQ.peak.amp, 0.1 * E_CHARGE, 1e-3, 'charge amplitude 0.1 e');
    // trajectory points as the source: the same signals, non-uniform sampling
    const ind2 = FA.inducedFromResult(ev, 0, res, r, { source: 'trajectories', ids: [0] });
    assert.equal(ind2.count, 1);
    assert.equal(ind2.particles[0].id, 0);
    let i2Max = 0;
    for (let i = 0; i < ind2.particles[0].n; i++) i2Max = Math.max(i2Max, Math.abs(ind2.particles[0].current[i]));
    relClose(i2Max, B8.iPeak, 1e-2, 'peak current from trajectory points');
    assert.throws(() => FA.spectrum(ind2.particles[0].t, ind2.particles[0].current), /uniform/);
    // velocity form of the series
    const ser = FA.inducedSeries(ev, 0, -1, { t: [0, 1], x: [0, 0], y: [4, 4], z: [0, 0], vx: [0, 0], vy: [-B8.v, B8.v], vz: [0, 0] });
    assert.equal(ser.method, 'velocity');
    relClose(ser.current[0], B8.iPeak, 1e-12);
    relClose(ser.current[1], -B8.iPeak, 1e-12);
    // 'auto' prefers markers; an empty selection gives no total
    assert.equal(FA.inducedFromResult(ev, 0, res, r).source, 'markers');
    const none = FA.inducedFromResult(ev, 0, res, r, { ids: [99] });
    assert.equal(none.count, 0); assert.equal(none.total, null);
});

test('fft and spectrum: two tones recovered; non-power-of-two input truncated; windows', () => {
    const n = 1024, dt = 0.001, t = new Float64Array(n), y = new Float64Array(n);
    const f1 = 37 / (n * dt), f2 = 123 / (n * dt);   // bin-centred tones
    for (let i = 0; i < n; i++) { t[i] = i * dt; y[i] = 0.5 + 2 * Math.sin(2 * Math.PI * f1 * t[i]) + 0.7 * Math.cos(2 * Math.PI * f2 * t[i]); }
    for (const window of ['hann', 'none']) {
        const sp = FA.spectrum(t, y, { window });
        assert.equal(sp.n, 1024);
        close(sp.df, 1 / (n * dt), 1e-12);
        relClose(sp.peak.freq, f1, 1e-9, `peak ${window}`);
        relClose(sp.peak.amp, 2, 1e-9, `amplitude ${window}`);
        relClose(sp.amp[123], 0.7, 1e-9, `second tone ${window}`);
        assert.ok(sp.amp[0] < 1e-9, 'mean removed');
    }
    const sp2 = FA.spectrum(t.subarray(0, 1000), y.subarray(0, 1000));
    assert.equal(sp2.n, 512);
    const re = Float64Array.from([1, 0, 0, 0]), im = new Float64Array(4);
    FA.fft(re, im);
    assert.deepEqual(Array.from(re), [1, 1, 1, 1]);
    assert.throws(() => FA.fft(new Float64Array(6), new Float64Array(6)), /power of two/);
    assert.throws(() => FA.spectrum([0, 1, 2], [1, 2, 3]), /four samples/);
    const d = FA.differentiate([0, 1, 3, 4], [0, 1, 9, 16]);   // y = t²: exact interior derivative for the 3-point formula
    close(d[1], 2, 1e-12); close(d[2], 6, 1e-12);
});

// ---------------------------------------------------------------- multipoles
test('multipoleCircle and multipoleSphere recover synthetic coefficients exactly; Gauss–Legendre nodes', () => {
    const circ = FA.multipoleCircle((x, y) => { const r = Math.hypot(x, y), th = Math.atan2(y, x); return 2 + 1.5 * (r / 3) ** 2 * Math.cos(2 * th) + 0.1 * (r / 3) ** 3 * Math.sin(3 * th) - 0.02 * (r / 3) ** 6 * Math.cos(6 * th); },
        { R: 1.2, r0: 3, nMax: 8, samples: 64 });
    assert.equal(circ.kind, 'circle');
    close(circ.a[0], 2, 1e-12); close(circ.a[2], 1.5, 1e-12); close(circ.b[3], 0.1, 1e-12); close(circ.a[6], -0.02, 1e-9);
    for (const nn of [1, 4, 5, 7, 8]) assert.ok(Math.abs(circ.a[nn]) + Math.abs(circ.b[nn]) < 1e-10, `order ${nn} absent`);
    close(circ.c[3], 0.1, 1e-12); close(circ.phase[3], 90, 1e-9);
    assert.ok(circ.residual < 1e-12);
    const sph = FA.multipoleSphere((x, rho) => { const r = Math.hypot(x, rho), mu = r > 0 ? x / r : 1; return 1 + 3 * (r / 5) ** 2 * FA.legendreP(2, mu) + 0.5 * (r / 5) ** 4 * FA.legendreP(4, mu) - 0.25 * (r / 5) * mu; },
        { cx: 0, R: 2, r0: 5, nMax: 6, samples: 24 });
    assert.equal(sph.kind, 'sphere');
    close(sph.c[0], 1, 1e-12); close(sph.c[1], -0.25, 1e-12); close(sph.c[2], 3, 1e-12); close(sph.c[4], 0.5, 1e-11);
    assert.ok(Math.abs(sph.c[3]) + Math.abs(sph.c[5]) + Math.abs(sph.c[6]) < 1e-9);
    const gl = FA.gaussLegendre(5);
    close(gl.x[4], 0.9061798459386640, 1e-14); close(gl.x[3], 0.5384693101056831, 1e-14); close(gl.x[2], 0, 1e-15);
    close(gl.w[2], 0.5688888888888889, 1e-14);
    close(Array.from(gl.w).reduce((a, b) => a + b, 0), 2, 1e-14);
    close(FA.legendreP(3, 0.5), -0.4375, 1e-15);
    assert.throws(() => FA.multipoleCircle(() => NaN, { R: 1 }), /outside/);
    assert.throws(() => FA.multipoleSphere(() => 1, { R: -1 }), /positive/);
});

test('Legendre expansion of an exact cylindrical field: φ = x/10 gives c₀ = 0.5, c₁ = 0.3 on a sphere R = 3 about x = 5', () => {
    const { r, s } = solve(proj('dipole', 'cyl2d', { cell: 0.5, x: [0, 10], y: [0, 40], edges: { xmin: ED('gnd'), xmax: ED('top'), ymax: NEU }, electrodes: [el('top', 1)] }));
    const ev = FA.voltageEvaluator(s, r, [0, 1]);
    const mp = FA.multipoleSphere(FA.potentialSampler(ev, 0), { cx: 5, R: 3, nMax: 6, samples: 48 });
    close(mp.c[0], 0.5, 1e-10); close(mp.c[1], 0.3, 1e-10);
    for (let n = 2; n <= 6; n++) assert.ok(Math.abs(mp.c[n]) < 1e-10, `c${n}`);
    const mp2 = FA.multipoleSphere(FA.potentialSampler(ev, 0), { cx: 5, R: 3, r0: 10, nMax: 2, samples: 16 });
    close(mp2.c[1], 1, 1e-10, 'normalised to r0 = 10');
});

test('T17 quadrupoles: hyperbolic rods give a₂ = 1 exactly; round rods 1.1468 r₀ in a 3.54 r₀ cage give a₂ = 1.0029, |a₆/a₂| ≤ 3e-3, no odd or sine terms', () => {
    const r0 = 4;
    const quad = (shapes, cell, size) => proj('quad', 'planar2d', { cell, x: [0, size], y: [0, size], mirror: { x: true, y: true }, edges: { xmin: NEU, ymin: NEU },
        electrodes: [el('rodsX', 1), el('rodsY', -1)], shapes });
    // hyperbolic (the T9 geometry): exact quadratic harmonics
    const hyp = solve(quad([{ type: 'quadric', electrode: 'rodsX', A: 1, B: -1, C: r0 * r0, cx: 0, cy: 0, clip: [0, 11.2, 0, 11.2] },
        { type: 'quadric', electrode: 'rodsY', A: -1, B: 1, C: r0 * r0, cx: 0, cy: 0, clip: [0, 11.2, 0, 11.2] }], 0.1, 14));
    const evH = FA.voltageEvaluator(hyp.s, hyp.r, [0, 1, -1]);
    const mH = FA.multipoleCircle(FA.potentialSampler(evH, 0), { cx: 0, cy: 0, R: 0.5 * r0, r0, nMax: 10, samples: 180 });
    close(mH.a[2], 1, 1e-8, 'hyperbolic a2');
    assert.ok(Math.abs(mH.a[6]) < 1e-8 && Math.abs(mH.a[10]) < 1e-8, 'no higher terms');
    // round rods with a grounded cage (Denison 1971): cell r0/25
    const rr = 1.1468 * r0, cage = 3.54 * r0;
    const rods = solve(quad([{ type: 'circle', electrode: 'rodsX', cx: r0 + rr, cy: 0, r: rr }, { type: 'circle', electrode: 'rodsY', cx: 0, cy: r0 + rr, r: rr },
        { type: 'annulus', electrode: 'gnd', cx: 0, cy: 0, rIn: cage, rOut: cage + 5, a0: 0, a1: 360 }], r0 / 25, 15.04));
    const ev = FA.voltageEvaluator(rods.s, rods.r, [0, 1, -1]);
    const sampler = FA.potentialSampler(ev, 0);
    const m5 = FA.multipoleCircle(sampler, { cx: 0, cy: 0, R: 0.5 * r0, r0, nMax: 14, samples: 360 });
    // converged values (cell r0/100): a2 1.002868, a6 −1.18e-4, a10 −2.45e-3; the plan's band a2 = 1 ± 0.3 %, |a6/a2| ≤ 3e-3
    close(m5.a[2], 1.00287, 2e-4, 'round-rod a2');
    assert.ok(Math.abs(m5.a[2] - 1) <= 3e-3, 'within the T17 band');
    assert.ok(Math.abs(m5.a[6] / m5.a[2]) <= 3e-3, `a6/a2 ${m5.a[6] / m5.a[2]}`);
    close(m5.a[10], -2.45e-3, 1e-4, 'a10');
    for (const nn of [1, 3, 4, 5, 7, 8, 9]) assert.ok(Math.abs(m5.a[nn]) < 1e-9, `fourfold symmetry removes order ${nn}`);
    assert.ok(Math.max(...Array.from(m5.b).map(Math.abs)) < 1e-9, 'no sine terms');
    // the coefficients do not depend on the sampling radius (the expansion converges inside the rods)
    const m7 = FA.multipoleCircle(sampler, { cx: 0, cy: 0, R: 0.7 * r0, r0, nMax: 14, samples: 360 });
    close(m7.a[2], m5.a[2], 2e-6); close(m7.a[10], m5.a[10], 3e-5);
});

// ---------------------------------------------------------------- panel module (pure parts)
test('charges panel module: meta, mount and the pure helpers', async () => {
    const P = await import('../../beta/ion-optics/js/ui/panels/charges.js');
    assert.deepEqual(P.meta, { id: 'charges', title: 'Charges & multipoles', order: 65 });
    assert.equal(typeof P.mount, 'function');
    const fn = { value: (t) => Math.cos(2 * Math.PI * t) };
    const V = P.electrodeVoltages({ channels: [{ cut: [0, 5, -2], fn: null }, { cut: [0, 0, 3], fn }], displayTime: 0.5 }, 3);
    assert.deepEqual(Array.from(V), [0, 5, -5]);
    assert.deepEqual(Array.from(P.electrodeVoltages({ channels: [] }, 2)), [0, 0]);
    const d = P.multipoleDefaults({ domain: { type: 'planar2d', h: 0.1, x: [0, 14], y: [0, 14], mirror: { x: true, y: true } } });
    assert.deepEqual([d.cx, d.cy], [0, 0]);
    assert.ok(d.R > 0 && d.r0 === d.R && d.samples === 360);
    const d2 = P.multipoleDefaults({ domain: { type: 'cyl2d', h: 0.25, x: [-60, 140], y: [0, 16], mirror: { x: false } } });
    assert.deepEqual([d2.cx, d2.cy, d2.samples], [40, 0, 64]);
    assert.equal(P.multipoleName(2, false), 'quadrupole');
    assert.equal(P.multipoleName(9, true), '18-pole');
});
