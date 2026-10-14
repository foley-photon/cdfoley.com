// WP2 FieldModel: 2D → 3D mapping, mirrors, cylindrical fields near the axis, time channels, ideal fields, magnets,
// region signatures and geometry queries (against analyticGrid and a hand-made geometry stub).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFieldModel } from '../../beta/ion-optics/js/engine/fieldmodel.js';
import { analyticGrid, compileIdealFields } from '../../beta/ion-optics/js/engine/analytic-fields.js';
import { timeFunctions, cosFn } from '../../beta/ion-optics/js/engine/waveform.js';
import { EDGE } from '../../beta/ion-optics/js/engine/layout.js';

const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);

function domain(type, h, x, y, extra = {}) {
    return { type, cell: h, h, x, y, nx: Math.round((x[1] - x[0]) / h) + 1, ny: Math.round((y[1] - y[0]) / h) + 1, mirror: { x: false, y: false }, beyond: {}, ...extra };
}
function resolvedOf(dom, more = {}) { return { domain: dom, electrodes: [{ id: 'gnd' }], magnets: [], idealFields: [], ...more }; }

/** Geometry stub: axis-aligned boxes (closed) and straight zero-thickness segments, CSG last wins. */
function stubGeometry(items, nElectrodes, transparentIdx = []) {
    const transparent = new Uint8Array(nElectrodes);
    for (const k of transparentIdx) transparent[k] = 1;
    const eps = 1e-12;
    const inside = (p, x, y) => p.kind === 'box'
        ? x >= p.x0 - eps && x <= p.x1 + eps && y >= p.y0 - eps && y <= p.y1 + eps
        : Math.abs((x - p.ax) * (p.by - p.ay) - (y - p.ay) * (p.bx - p.ax)) <= eps * Math.hypot(p.bx - p.ax, p.by - p.ay)
            && (x - p.ax) * (p.bx - p.ax) + (y - p.ay) * (p.by - p.ay) >= -eps && (x - p.bx) * (p.ax - p.bx) + (y - p.by) * (p.ay - p.by) >= -eps;
    function firstT(p, px, py, qx, qy) {
        const dx = qx - px, dy = qy - py;
        if (p.kind === 'box') {
            let t0 = 0, t1 = 1;
            for (const [o, d, lo, hi] of [[px, dx, p.x0, p.x1], [py, dy, p.y0, p.y1]]) {
                if (d === 0) { if (o < lo - eps || o > hi + eps) return null; continue; }
                let a = (lo - eps - o) / d, b = (hi + eps - o) / d;
                if (a > b) [a, b] = [b, a];
                t0 = Math.max(t0, a); t1 = Math.min(t1, b);
                if (t0 > t1) return null;
            }
            return t0;
        }
        const ex = p.bx - p.ax, ey = p.by - p.ay, den = dx * ey - dy * ex;
        if (den === 0) return null;
        const t = ((p.ax - px) * ey - (p.ay - py) * ex) / den, s = ((p.ax - px) * dy - (p.ay - py) * dx) / den;
        return t >= 0 && t <= 1 && s >= 0 && s <= 1 ? t : null;
    }
    return {
        nElectrodes, transparent, prims: items,
        classify(x, y) { let c = -1; for (const p of items) if (inside(p, x, y)) c = p.electrode; return c; },
        firstNonFree(px, py, qx, qy, skip = false) {
            let best = null;
            for (const p of items) {
                if (skip && transparent[p.electrode]) continue;
                const t = firstT(p, px, py, qx, qy);
                if (t !== null && (best === null || t < best.t)) best = { t, electrode: p.electrode, transparent: transparent[p.electrode] === 1 };
            }
            return best;
        },
    };
}

test('planar mirror.y and mirror.x: |y|, |x| evaluation with sign flips; box covers both halves', () => {
    // φ = x² y + 3x + 2y on the quarter domain (x, y ≥ 0); E = −∇φ
    const phi = (x, y) => x * x * y + 3 * x + 2 * y;
    const grad = (x, y) => [2 * x * y + 3, x * x + 2];
    const grid = analyticGrid({ phi, grad, bounds: [0, 10, 0, 10], h: 0.5 });
    const m = createFieldModel({ resolved: resolvedOf(domain('planar2d', 0.5, [0, 10], [0, 10], { mirror: { x: true, y: true } })), grid });
    const e = new Float64Array(4);
    for (const [x, y] of [[2, 3], [-2, 3], [2, -3], [-2, -3]]) {
        assert.equal(m.E(0, x, y, 7, e), 0);
        const g = grad(Math.abs(x), Math.abs(y));
        close(e[0], -g[0] * Math.sign(x), 1e-12, 'Ex'); close(e[1], -g[1] * Math.sign(y), 1e-12, 'Ey');
        assert.equal(e[2], 0, 'Ez = 0 in planar');
        close(e[3], phi(Math.abs(x), Math.abs(y)), 1e-12, 'φ');
    }
    assert.deepEqual([m.box.xmin, m.box.xmax, m.box.ymin, m.box.ymax], [-10, 10, -10, 10]);
    assert.ok(m.inside(-9.9, -9.9, 1e9) && !m.inside(-10.1, 0, 0));
    assert.equal(m.faceOf(-10.5, 0, 0), EDGE.XMIN); assert.equal(m.beyondKey(EDGE.XMIN), 'xmax');
    assert.equal(m.faceOf(0, -10.5, 0), EDGE.YMIN); assert.equal(m.beyondKey(EDGE.YMIN), 'ymax');
});

test('cyl2d mapping: E_y = E_ρ y/ρ, E_z = E_ρ z/ρ; finite and O(ρ) near the axis', () => {
    // harmonic in cylindrical coordinates: φ = x² − ρ²/2 (∇²φ = 2 − 2 = 0)
    const phi = (x, r) => x * x - r * r / 2;
    const grid = analyticGrid({ phi, grad: (x, r) => [2 * x, -r], bounds: [-10, 10, 0, 5], h: 0.25, cyl: true });
    const m = createFieldModel({ resolved: resolvedOf(domain('cyl2d', 0.25, [-10, 10], [0, 5])), grid });
    const e = new Float64Array(4);
    for (const [x, y, z] of [[1, 3, 4].map((v) => v * 0.5), [2, -1, 2], [-3, 0, -2], [0.5, 1e-7, 0], [0.5, 1e-13, 0], [0.5, 0, 0]]) {
        m.E(0, x, y, z, e);
        const r = Math.hypot(y, z);
        close(e[0], -2 * x, 1e-12, 'Ex');
        // E_ρ = +ρ, so E_y = y and E_z = z (exactly ρ → 0 too)
        close(e[1], r >= 1e-12 ? y : 0, 1e-12, 'Ey'); close(e[2], r >= 1e-12 ? z : 0, 1e-12, 'Ez');
        close(e[3], phi(x, r), 1e-12, 'φ');
    }
    assert.deepEqual([m.box.ymin, m.box.ymax, m.box.zmin, m.box.zmax, m.box.rmax], [-5, 5, -5, 5, 5]);
    assert.ok(m.inside(0, 3, 3.9) && !m.inside(0, 3, 4.1));
    assert.equal(m.faceOf(0, 4, 4), EDGE.RMAX);
    assert.ok(Number.isNaN(m.potential(0, 0, 4, 4)));
    m.E(0, 0, 4, 4, e);
    assert.deepEqual([...e.slice(0, 3)], [0, 0, 0]);
});

test('time channels: E(t) = E0 + Σ f_c(t) E_c; nChannels read from the grid at evaluation time', () => {
    // a grid with two channels: DC φ0 = −x (E0 = 1) and channel 1 φ1 = 2y (E1 = −2 ŷ)
    let nC = 0;
    const grid = {
        interp: 'cubic', cyl: false, nx: 11, ny: 11, h: 1, x0: 0, y0: 0, bounds: { x0: 0, x1: 10, y0: 0, y1: 10 },
        get nChannels() { return nC; }, setChannels() { nC = 2; },
        evalChannels(x, y, out) { out[0] = -x; out[1] = 1; out[2] = 0; out[3] = 2 * y; out[4] = 0; out[5] = -2; return 0; },
        cellTypeAt() { return 0; }, nearAt() { return 0; }, nodal() { return null; }, bytes() { return 0; },
    };
    const fn = cosFn(1.5, 0);
    const m = createFieldModel({ resolved: resolvedOf(domain('planar2d', 1, [0, 10], [0, 10])), grid, channelFns: [null, fn] });
    const e = new Float64Array(4);
    m.E(0, 3, 4, 0, e);
    assert.deepEqual([...e], [0, 0, 0, 0], 'no channels before setChannels');
    grid.setChannels();
    assert.equal(m.nChannels, 2);
    assert.ok(m.timeDependent);
    close(m.minPeriod, 1 / 1.5, 1e-15);
    for (const t of [0, 0.1, 0.37]) {
        m.E(t, 3, 4, 0, e);
        const f = Math.cos(2 * Math.PI * 1.5 * t);
        close(e[0], 1, 1e-14); close(e[1], -2 * f, 1e-14); close(e[3], -3 + 8 * f, 1e-13);
    }
    // through timeFunctions: K7 capacitor, V(t) = 21000 sin(2πt) on the xmin electrode
    const tf = timeFunctions([{ ground: true }, { v: 0, terms: [{ type: 'cos', amp: 21000, freq: 1, phase: -90 }] }]);
    const amp = tf.channels[0].amp[1];
    const g7 = analyticGrid({ phi: (x) => amp * (200 - x) / 210, grad: () => [-amp / 210, 0], bounds: [-10, 200, -5, 5], h: 1 });
    const m7 = createFieldModel({ resolved: resolvedOf(domain('planar2d', 1, [-10, 200], [-5, 5])), grid: g7, channelFns: [tf.channels[0].fn] });
    for (const t of [0.1, 0.25, 0.6]) { m7.E(t, 0, 0, 0, e); close(e[0], 100 * Math.sin(2 * Math.PI * t), 1e-10, 'K7 field'); }
});

test('ideal fields add to the grid field; boxes and outside behaviour', () => {
    const grid = analyticGrid({ phi: (x) => -x, grad: () => [-1, 0], bounds: [0, 10, -5, 5], h: 0.5 });
    const ideal = [
        { type: 'uniformE', E: [0, 2, 0], ref: [0, 0, 0] },
        { type: 'uniformE', E: [0, 0, 5], box: { min: [2, -1, -1], max: [4, 1, 1] } },
        { type: 'quadrupole2d', center: [5, 0], r0: 2, U: 1, V: 3, freq: 2, phase: 0 },
    ];
    const m = createFieldModel({ resolved: resolvedOf(domain('planar2d', 0.5, [0, 10], [-5, 5]), { idealFields: ideal }), grid });
    const e = new Float64Array(4);
    const t = 0.1, s = (1 - 3 * Math.cos(2 * Math.PI * 2 * t)) / 4;
    m.E(t, 6, 1, 0, e);
    close(e[0], 1 - 2 * s * 1, 1e-12, 'Ex'); close(e[1], 2 + 2 * s * 1, 1e-12, 'Ey'); close(e[2], 0, 1e-15);
    close(e[3], -6 - 2 * 1 + s * (1 - 1), 1e-12, 'φ');
    m.E(t, 3, 0, 0, e);
    close(e[2], 5, 1e-15, 'box field inside');
    assert.ok(m.timeDependent && m.hasRegions);
    close(m.minPeriod, 0.5, 1e-15);
    // region signature: the box bit sits above the magnet bits
    assert.equal(m.regionSig(3, 0, 0), 2 ** 32); assert.equal(m.regionSig(5, 0, 0), 0);
    // frozen signature: outside the box but evaluated with the inside signature
    m.E(t, 5, 0, 0, e, 2 ** 32); close(e[2], 5, 1e-15, 'frozen box membership');
    // outside the domain: no field at all, φ NaN
    m.E(t, 11, 0, 0, e); assert.deepEqual([e[0], e[1], e[2]], [0, 0, 0]); assert.ok(Number.isNaN(e[3]));
    // coax and sphere ideal fields
    const f = compileIdealFields([{ type: 'coax', center: [0, 0], a: 10, b: 20, Va: 100, Vb: 0 }, { type: 'sphere', center: [0, 0, 50], R1: 80, R2: 120, V1: 500, V2: -333.3333333333333 }]);
    const o = [0, 0, 0];
    const p = f.E(0, 12.5 * Math.cos(0.3), 12.5 * Math.sin(0.3), 50, o);
    // coax at r = 12.5 plus the sphere's inner electrode (r < R1 holds V1 = 500 V)
    close(p, 100 * Math.log(20 / 12.5) / Math.log(2) + 500, 1e-9, 'coax + sphere potentials');
    close(Math.hypot(o[0], o[1]), 100 / Math.log(2) / 12.5, 1e-12, 'coax |E|');
    const o2 = [0, 0, 0];
    const p2 = f.E(0, 0, 100, 50, o2);
    close(p2, 0 + 200000 / 100 - 2000, 1e-9, 'sphere V(100) (coax beyond b holds 0 V)');
    close(Math.hypot(o2[0], o2[1], o2[2]), 20, 1e-12, 'sphere |E(100)| = 20 V/mm');
});

test('magnets in the model: B everywhere (also outside the grid), frozen region signature', () => {
    const mags = [{ type: 'uniform', B: [0, 0, 0.1] }, { type: 'region', B: [0, 0, 1], region: { type: 'box', x0: 0, x1: 5, y0: -5, y1: 5 } }];
    const m = createFieldModel({ resolved: resolvedOf(domain('planar2d', 1, [-10, 10], [-10, 10]), { magnets: mags }) });
    const b = new Float64Array(3);
    m.B(100, 100, 0, b); assert.deepEqual([...b], [0, 0, 0.1]);
    m.B(2, 0, 0, b); assert.deepEqual([...b], [0, 0, 1.1]);
    m.B(2, 0, 0, b, 0); assert.deepEqual([...b], [0, 0, 0.1], 'frozen outside signature');
    assert.equal(m.regionSig(2, 0, 0), 1);
    assert.ok(m.hasB && m.hasRegions);
    close(m.bMax, 1.1, 1e-15);
});

test('geometry queries: ownerAt, firstHit on chords with mirror and axis splitting, near modes', () => {
    // plane geometry (x, ρ): a disc x ∈ [4, 5], ρ ≤ 1 (electrode 1), and a mesh line at x = 8 (electrode 2, transparent)
    const geo = stubGeometry([{ kind: 'box', electrode: 1, x0: 4, x1: 5, y0: 0, y1: 1 }, { kind: 'line', electrode: 2, ax: 8, ay: 0, bx: 8, by: 10 }], 3, [2]);
    const res = { domain: domain('cyl2d', 0.5, [0, 10], [0, 10]), electrodes: [{ id: 'gnd' }, { id: 'a' }, { id: 'm', kind: 'grid', transmission: 0.7 }], magnets: [], idealFields: [] };
    const m = createFieldModel({ resolved: res, geometry: geo });
    assert.equal(m.nearMode, 3, 'no grid or raster: every step tests hits');
    assert.ok(m.near(1, 1, 1));
    assert.equal(m.ownerAt(4.5, 0.3, -0.4), 1); assert.equal(m.ownerAt(4.5, 0.8, 0.8), -1);
    assert.deepEqual([...m.transparent], [0, 0, 1]); close(m.transmission[2], 0.7, 1e-15);
    // a skew chord through the disc region passing close to the axis: endpoints at ρ = 1.5 but the chord dips to ρ = 0.5
    const h1 = m.firstHit(4.5, 1.5, 0.5, 4.5, -1.5, 0.5);
    assert.ok(h1 !== null && h1.electrode === 1, 'axis split finds the disc');
    // the (x, ρ) image of each half-chord is joined straight, so u approximates the exact entry 0.2113 (the tracer bisects)
    assert.ok(h1.u > 0.2113 && h1.u < 0.3, 'entry parameter on the first half-chord ' + h1.u);
    assert.equal(m.firstHit(4.5, 1.5, 1.2, 4.5, -1.5, 1.2), null, 'chord passing ρ ≥ 1.2 misses');
    const h2 = m.firstHit(7, 3, 0, 9, 3, 0);
    assert.ok(h2 && h2.transparent && h2.electrode === 2); close(h2.u, 0.5, 1e-12);
    assert.equal(m.firstHit(7, 3, 0, 9, 3, 0, true), null, 'transparent pieces skipped on request');
    // planar mirror: a chord crossing y = 0 is split and folded
    const geo2 = stubGeometry([{ kind: 'box', electrode: 1, x0: 2, x1: 3, y0: 1, y1: 2 }], 2);
    const m2 = createFieldModel({ resolved: { domain: domain('planar2d', 0.5, [0, 10], [0, 10], { mirror: { x: false, y: true } }), electrodes: [{ id: 'gnd' }, { id: 'a' }], magnets: [], idealFields: [] }, geometry: geo2 });
    const h3 = m2.firstHit(2.5, 0.5, 0, 2.5, -3, 0);
    assert.ok(h3 && h3.electrode === 1);
    close(h3.u, 1.5 / 3.5, 1e-12, 'mirror image y ∈ [−2, −1] is hit at y = −1');
    assert.equal(m2.ownerAt(2.5, -1.5, 0), 1);
    // near from an analytic grid with a near() function
    const grid = analyticGrid({ phi: () => 0, bounds: [0, 10, 0, 10], h: 0.5, near: (x) => x > 3 && x < 6 });
    const m3 = createFieldModel({ resolved: res, geometry: geo, grid });
    assert.equal(m3.nearMode, 1);
    assert.ok(m3.near(4, 1, 0) && !m3.near(1, 1, 0) && !m3.near(4, 20, 0));
    // without geometry nothing is near and nothing is hit
    const m4 = createFieldModel({ resolved: res, grid });
    assert.equal(m4.near(4, 1, 0), false); assert.equal(m4.firstHit(0, 0, 0, 9, 0, 0), null); assert.equal(m4.ownerAt(4.5, 0, 0), -1);
});

test('no grid: zero field inside the domain plus ideal fields; potential span for the energy check', () => {
    const res = { domain: domain('planar2d', 1, [0, 10], [0, 10]), electrodes: [{ id: 'gnd' }, { id: 'a', v: 100, terms: [{ type: 'cos', amp: 50, freq: 1 }] }, { id: 'b', v: -20 }], magnets: [], idealFields: [] };
    const m = createFieldModel({ resolved: res });
    const e = new Float64Array(4);
    assert.equal(m.E(0, 5, 5, 0, e), 0);
    assert.deepEqual([...e], [0, 0, 0, 0]);
    assert.equal(m.vSpan, 150 + 20);
    assert.equal(m.nextBreak(0, 10), Infinity);
});
