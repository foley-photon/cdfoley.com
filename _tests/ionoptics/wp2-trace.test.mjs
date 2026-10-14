// WP2 tracer: solo versions of K1–K9 (analytic fields), events (planes, hits, meshes, exits, drift), T15 hit precision,
// determinism across batch sizes, limits and diagnostics. Geometry comes from a hand-made stub (WP1-independent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceParticles, mergeResults, traceOptions } from '../../beta/ion-optics/js/engine/trace.js';
import { createFieldModel } from '../../beta/ion-optics/js/engine/fieldmodel.js';
import { analyticGrid } from '../../beta/ion-optics/js/engine/analytic-fields.js';
import { timeFunctions } from '../../beta/ion-optics/js/engine/waveform.js';
import { generate, countParticles } from '../../beta/ion-optics/js/engine/particles.js';
import { uniform01 } from '../../beta/ion-optics/js/engine/rng.js';
import * as L from '../../beta/ion-optics/js/engine/layout.js';
import { K_ACC, C_MMUS, ME_U, UC2_EV, speedFromKE, properSpeedFromKE, cyclotron } from '../../beta/ion-optics/js/engine/constants.js';
import { traceCoulomb, coulombEnergy } from '../../beta/ion-optics/js/engine/coulomb.js';

const { STATUS } = L;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- helpers
function dom(type, h, x, y, extra = {}) {
    return { type, cell: h, h, x, y, nx: Math.round((x[1] - x[0]) / h) + 1, ny: Math.round((y[1] - y[0]) / h) + 1, mirror: { x: false, y: false }, beyond: {}, ...extra };
}
function res(domain, more = {}) { return { domain, electrodes: [{ id: 'gnd' }], magnets: [], idealFields: [], ...more }; }
/** Particle rows: [{ m, q, p:[3], d:[3], ke, t0? }]; w from KE with the relativistic flag. */
function rowsOf(list, rel) {
    const P = new Float64Array(list.length * L.P_STRIDE);
    list.forEach((s, i) => {
        const o = i * L.P_STRIDE, n = Math.hypot(...s.d) || 1;
        const w = rel ? properSpeedFromKE(s.ke, s.m) : speedFromKE(s.ke, s.m, false);
        P[o + L.P_ID] = i; P[o + L.P_MASS] = s.m; P[o + L.P_CHARGE] = s.q; P[o + L.P_T0] = s.t0 || 0;
        P[o + L.P_X] = s.p[0]; P[o + L.P_Y] = s.p[1]; P[o + L.P_Z] = s.p[2];
        P[o + L.P_WX] = w * s.d[0] / n; P[o + L.P_WY] = w * s.d[1] / n; P[o + L.P_WZ] = w * s.d[2] / n; P[o + L.P_KE] = s.ke;
        P[o + L.P_C0] = -1; P[o + L.P_C1] = -1; P[o + L.P_C2] = -1;
    });
    return P;
}
const S = (r, i, f) => r.summary[i * L.S_STRIDE + f];
function crossings(r, plane = null) {
    const out = [];
    for (let c = 0; c < r.nCross; c++) {
        const b = c * L.C_STRIDE, row = r.crossings.subarray(b, b + L.C_STRIDE);
        if (plane === null || row[L.C_PLANE] === plane) out.push(row);
    }
    return out;
}
const relEq = (a, b, rel, msg = '') => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg}: ${a} vs ${b} (rel ${(a / b - 1).toExponential(2)})`);
const absEq = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (diff ${(a - b).toExponential(2)})`);
/** within half a unit in the last printed digit of ref */
function digits(value, ref, msg) {
    const s = String(ref), dec = (s.split('.')[1] || '').length;
    absEq(value, ref, 0.5 * 10 ** -dec, msg + ' (digits)');
}
/** Intersection of two lines p + s·d in the plane spanned by components (i, j). */
function intersect(p1, d1, p2, d2, i = 0, j = 1) {
    const den = d1[i] * d2[j] - d1[j] * d2[i];
    const s = ((p2[i] - p1[i]) * d2[j] - (p2[j] - p1[j]) * d2[i]) / den;
    return [p1[0] + s * d1[0], p1[1] + s * d1[1], p1[2] + s * d1[2]];
}

/** Geometry stub in plane coordinates: rotated rectangles (closed) and zero-thickness polylines; CSG last wins. */
function stubGeometry(items, nElectrodes, transparentIdx = []) {
    const transparent = new Uint8Array(nElectrodes);
    for (const k of transparentIdx) transparent[k] = 1;
    const eps = 1e-12;
    for (const p of items) if (p.kind === 'rect') { p.ux = Math.cos(p.ang * DEG); p.uy = Math.sin(p.ang * DEG); }
    function rectT(p, px, py, dx, dy) {
        const u0 = (px - p.cx) * p.ux + (py - p.cy) * p.uy, v0 = -(px - p.cx) * p.uy + (py - p.cy) * p.ux;
        const du = dx * p.ux + dy * p.uy, dv = -dx * p.uy + dy * p.ux;
        let t0 = 0, t1 = 1;
        for (const [o, d, hl] of [[u0, du, p.hu], [v0, dv, p.hv]]) {
            if (d === 0) { if (Math.abs(o) > hl + eps) return null; continue; }
            let a = (-hl - eps - o) / d, b = (hl + eps - o) / d;
            if (a > b) { const t = a; a = b; b = t; }
            if (a > t0) t0 = a; if (b < t1) t1 = b;
            if (t0 > t1) return null;
        }
        return t0;
    }
    function lineT(p, px, py, dx, dy) {
        let best = null;
        for (let k = 0; k + 1 < p.pts.length; k++) {
            const [ax, ay] = p.pts[k], [bx, by] = p.pts[k + 1], ex = bx - ax, ey = by - ay;
            const den = dx * ey - dy * ex;
            if (den === 0) continue;
            const t = ((ax - px) * ey - (ay - py) * ex) / den, s = ((ax - px) * dy - (ay - py) * dx) / den;
            if (t >= 0 && t <= 1 && s >= -1e-12 && s <= 1 + 1e-12 && (best === null || t < best)) best = t;
        }
        return best;
    }
    function contains(p, x, y) {
        if (p.kind === 'rect') {
            const u = (x - p.cx) * p.ux + (y - p.cy) * p.uy, v = -(x - p.cx) * p.uy + (y - p.cy) * p.ux;
            return Math.abs(u) <= p.hu + eps && Math.abs(v) <= p.hv + eps;
        }
        for (let k = 0; k + 1 < p.pts.length; k++) {
            const [ax, ay] = p.pts[k], [bx, by] = p.pts[k + 1], ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey;
            const s = ((x - ax) * ex + (y - ay) * ey) / L2;
            if (s >= 0 && s <= 1 && Math.abs((x - ax) * ey - (y - ay) * ex) / Math.sqrt(L2) <= eps) return true;
        }
        return false;
    }
    return {
        nElectrodes, transparent, prims: items,
        classify(x, y) { let c = -1; for (const p of items) if (contains(p, x, y)) c = p.electrode; return c; },
        firstNonFree(px, py, qx, qy, skip = false) {
            let best = null;
            for (const p of items) {
                if (skip && transparent[p.electrode]) continue;
                const t = p.kind === 'rect' ? rectT(p, px, py, qx - px, qy - py) : lineT(p, px, py, qx - px, qy - py);
                if (t !== null && (best === null || t < best.t)) best = { t, electrode: p.electrode, transparent: transparent[p.electrode] === 1 };
            }
            return best;
        },
    };
}

// ---------------------------------------------------------------- K1, K2: transit and drift
test('K1 uniform-field transit (analytic capacitor): TOF to 1e-10, plane time exact to 1e-12', () => {
    const grid = analyticGrid({ phi: (x) => 1000 * (1 - x / 10), grad: () => [-100, 0], bounds: [0, 10, -2, 2], h: 0.5 });
    const model = createFieldModel({ resolved: res(dom('planar2d', 0.5, [0, 10], [-2, 2])), grid });
    const r = traceParticles(model, rowsOf([{ m: 100, q: 1, p: [0, 0, 0], d: [1, 0, 0], ke: 0 }, { m: 100, q: 1, p: [0, 0, 0], d: [1, 0, 0], ke: 10 }], false),
        { integrator: 'rk45', rtol: 1e-10, relativistic: false, planes: [{ kind: 'x', at: 10, terminate: true }] });
    const a = K_ACC * 100 / 100, v0 = speedFromKE(10, 100, false);
    const exact = [Math.sqrt(20 / a), (-v0 + Math.sqrt(v0 * v0 + 20 * a)) / a];
    for (let i = 0; i < 2; i++) {
        assert.equal(S(r, i, L.S_STATUS), STATUS.DETECTED); assert.equal(S(r, i, L.S_WHERE), 0);
        relEq(S(r, i, L.S_TOF), exact[i], 1e-10, 'K1 TOF');
        relEq(crossings(r, 0)[i][L.C_T], exact[i], 1e-12, 'plane time');
        assert.ok(Math.abs(S(r, i, L.S_DE_END)) < 1e-9, 'energy closes at the detector');
    }
    digits(S(r, 0, L.S_TOF), 0.455286, 'K1 from rest'); digits(S(r, 0, L.S_VX), 43.9284, 'K1 speed'); digits(S(r, 1, L.S_TOF), 0.412028, 'K1 10 eV');
    relEq(S(r, 0, L.S_VX), Math.sqrt(2 * K_ACC * 1000 / 100), 1e-10, 'final speed');
});

test('plane time in an ideal uniform field is exact (1e-12), DP45 and RK4', () => {
    const model = createFieldModel({ resolved: res(dom('planar2d', 1, [0, 50], [-5, 5]), { idealFields: [{ type: 'uniformE', E: [37, 0, 0] }] }) });
    for (const integrator of ['rk45', 'rk4']) {
        const r = traceParticles(model, rowsOf([{ m: 7, q: 2, p: [0, 0, 0], d: [1, 0, 0], ke: 0 }], false),
            { integrator, rtol: 1e-6, relativistic: false, planes: [{ kind: 'x', at: 3.3 }, { kind: 'x', at: 41, terminate: true }] });
        const a = K_ACC * 2 / 7 * 37;
        relEq(crossings(r, 0)[0][L.C_T], Math.sqrt(2 * 3.3 / a), 1e-12, integrator + ' plane 3.3');
        relEq(S(r, 0, L.S_TOF), Math.sqrt(2 * 41 / a), 1e-12, integrator + ' detector 41');
        relEq(crossings(r, 0)[0][L.C_VX], Math.sqrt(2 * 3.3 * a), 1e-12, integrator + ' crossing speed');
    }
});

test('K2 1 m drift at 1000 eV: field-free drift beyond the grid, analytic plane crossing (1e-10)', () => {
    const model = createFieldModel({ resolved: res(dom('planar2d', 0.5, [0, 10], [-5, 5])) });
    const masses = [1.00782503207, 28, 100, 1000], refs = [2.28532, 12.04574, 22.7643, 71.98705];
    const r = traceParticles(model, rowsOf(masses.map((m) => ({ m, q: 1, p: [0, 0, 0], d: [1, 0, 0], ke: 1000 })), false),
        { rtol: 1e-10, relativistic: false, beyond: { xmax: 'drift' }, planes: [{ kind: 'x', at: 1000, terminate: true }], record: { trajectories: true } });
    masses.forEach((m, i) => {
        assert.equal(S(r, i, L.S_STATUS), STATUS.DETECTED);
        relEq(S(r, i, L.S_TOF), 1000 / speedFromKE(1000, m, false), 1e-10, 'K2 m=' + m);
        digits(S(r, i, L.S_TOF), refs[i], 'K2 m=' + m);
        relEq(S(r, i, L.S_PATH), 1000, 1e-12, 'path length');
        assert.ok(Number.isNaN(S(r, i, L.S_DE_END)), 'energy check not defined outside the grid');
    });
    // the drift adds only its end point after the exit point at x = 10
    const n0 = r.traj.offsets[1], p = r.traj.pts;
    absEq(p[4 * (n0 - 2)], 10, 1e-6, 'exit point kept'); absEq(p[4 * (n0 - 1)], 1000, 1e-3, 'detector point kept');
});

// ---------------------------------------------------------------- K3, K4, K5, K9: gyration
function gyroModel(B, h = 10) {
    return createFieldModel({ resolved: res(dom('planar2d', h, [-400, 400], [-400, 400]), { magnets: [{ type: 'uniform', B: [0, 0, B] }] }) });
}
/** Radius and period from an 'all' plane through the orbit centre (y = yc): x crossings alternate at xc ± r. */
function orbitFromPlane(r, i = 0) {
    const rows = crossings(r, 0).filter((c) => c[L.C_ID] === i);
    const fw = rows.filter((c) => c[L.C_DIR] > 0), bw = rows.filter((c) => c[L.C_DIR] < 0);
    return { radius: Math.abs(fw[0][L.C_X] - bw[0][L.C_X]) / 2, period: fw[1][L.C_T] - fw[0][L.C_T], rows };
}

test('K3 gyration (DP45, rtol 1e-11): radius and frequency to 1e-9; markers at T/256 fit the circle', () => {
    const cases = [
        { name: '(a) 100 u, 1 keV, 0.5 T', m: 100, q: 1, B: 0.5, ke: 1000, rel: false, ref: [91.0572, 0.0767806] },
        { name: '(b) e⁻ 100 eV, 1 mT', m: ME_U, q: -1, B: 1e-3, ke: 100, rel: false, ref: [33.7213, 27.99249] },
        { name: '(c) e⁻ 100 eV, 1 mT, relativistic', m: ME_U, q: -1, B: 1e-3, ke: 100, rel: true, ref: [33.7229, 27.98701] },
    ];
    for (const c of cases) {
        const cy = cyclotron(c.m, c.q, c.B, c.ke, c.rel), T = 1 / cy.freqMHz;
        const yc = -Math.sign(c.q) * cy.radiusMM;   // B = +z, start along +x
        const r = traceParticles(gyroModel(c.B), rowsOf([{ m: c.m, q: c.q, p: [0, 0, 0], d: [1, 0, 0], ke: c.ke }], c.rel),
            { integrator: 'rk45', rtol: 1e-11, maxStepCells: 1, relativistic: c.rel, tMax: 2.6 * T,
                planes: [{ kind: 'y', at: yc, record: 'all' }], record: { trajectories: false, markersDt: T / 256 } });
        const o = orbitFromPlane(r);
        relEq(o.radius, cy.radiusMM, 1e-9, c.name + ' radius'); relEq(1 / o.period, cy.freqMHz, 1e-9, c.name + ' frequency');
        digits(o.radius, c.ref[0], c.name + ' radius'); digits(1 / o.period, c.ref[1], c.name + ' frequency');
        // Kåsa algebraic circle fit to the markers (Float32 storage limits it to ~1e-7)
        const mk = r.markers, n = mk.length / 5;
        assert.ok(n >= 600, 'markers ' + n);
        let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0;
        for (let k = 0; k < n; k++) {
            const x = mk[5 * k + 2], y = mk[5 * k + 3], z = x * x + y * y;
            sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sz += z; sxz += x * z; syz += y * z;
        }
        // solve [sxx sxy sx; sxy syy sy; sx sy n] [A B C] = [sxz syz sz]; centre (A/2, B/2), r² = C + (A² + B²)/4
        const M = [[sxx, sxy, sx, sxz], [sxy, syy, sy, syz], [sx, sy, n, sz]];
        for (let i = 0; i < 3; i++) for (let k = i + 1; k < 3; k++) { const f = M[k][i] / M[i][i]; for (let j = i; j < 4; j++) M[k][j] -= f * M[i][j]; }
        const sol = [0, 0, 0];
        for (let i = 2; i >= 0; i--) { let s = M[i][3]; for (let j = i + 1; j < 3; j++) s -= M[i][j] * sol[j]; sol[i] = s / M[i][i]; }
        const rad = Math.sqrt(sol[2] + (sol[0] * sol[0] + sol[1] * sol[1]) / 4);
        relEq(rad, cy.radiusMM, 3e-7, c.name + ' Kåsa radius'); digits(rad, c.ref[0], c.name + ' Kåsa radius');
        absEq(sol[1] / 2, yc, 3e-5 * cy.radiusMM, 'centre y');
        // markers land on step ends exactly k·T/256 apart
        for (let k = 1; k < 5; k++) relEq(mk[5 * k + 1], k * T / 256, 1e-6, 'marker time');
    }
});

test('K3 Boris at 128 steps per gyration: |r/r_ref − 1| ≤ 2.5e-4 and the discrete-circle identity (1e-9)', () => {
    const cy = cyclotron(100, 1, 0.5, 1000, false), T = 1 / cy.freqMHz, r0 = cy.radiusMM;
    const th = 2 * Math.PI / 128, R = r0 * (th / 2) / Math.sin(th / 2);
    const r = traceParticles(gyroModel(0.5), rowsOf([{ m: 100, q: 1, p: [0, 0, 0], d: [1, 0, 0], ke: 1000 }], false),
        { integrator: 'boris', borisStepsPerGyration: 128, maxStepCells: 1, relativistic: false, tMax: 10 * T,
            planes: [{ kind: 'y', at: -r0, record: 'all' }], record: { trajectories: false } });
    assert.equal(S(r, 0, L.S_STATUS), STATUS.TMAX);
    assert.equal(S(r, 0, L.S_STEPS), 1280);
    assert.ok((S(r, 0, L.S_FLAGS) & L.FLAG.BORIS) !== 0);
    const o = orbitFromPlane(r);
    assert.ok(Math.abs(o.radius / r0 - 1) <= 2.5e-4, 'Boris radius ' + (o.radius / r0 - 1));
    relEq(o.radius, R, 1e-6, 'crossings on the discrete circle');
    relEq(1 / o.period, cy.freqMHz, 1e-9, 'Boris gyrophase is exact');
    const rf = Math.hypot(S(r, 0, L.S_X), S(r, 0, L.S_Y) + R);
    relEq(rf, R, 1e-9, 'final step position on the circle r(θ/2)/sin(θ/2)');
    relEq(S(r, 0, L.S_KE), 1000, 1e-13, 'energy conserved by the rotation');
});

test('K4 gyration sense: ion centre (0, −r), electron (0, +r); DP45 and Boris', () => {
    for (const integrator of ['rk45', 'boris']) {
        for (const [m, q, ke, B] of [[100, 1, 1000, 0.5], [ME_U, -1, 100, 1e-3]]) {
            const cy = cyclotron(m, q, B, ke, true), T = 1 / cy.freqMHz;
            const r = traceParticles(gyroModel(B, 50), rowsOf([{ m, q, p: [0, 0, 0], d: [1, 0, 0], ke }], true),
                { integrator, rtol: 1e-10, maxStepCells: 1, tMax: T / 2, borisStepsPerGyration: 256 });
            const y = S(r, 0, L.S_Y), x = S(r, 0, L.S_X);
            absEq(y, -2 * Math.sign(q) * cy.radiusMM, 2e-3 * cy.radiusMM, `${integrator} q=${q} half-turn y`);
            absEq(x, 0, 2e-3 * cy.radiusMM, `${integrator} q=${q} half-turn x`);
        }
    }
});

test('K5 180° homogeneous-field focus at ±1 mrad (DP45, rtol 1e-11): 180.000° ± 0.005°', () => {
    const cy = cyclotron(100, 1, 0.5, 1000, false), T = 1 / cy.freqMHz, r0 = cy.radiusMM;
    const rays = [-1e-3, 1e-3].map((a) => ({ m: 100, q: 1, p: [0, 0, 0], d: [Math.cos(a), Math.sin(a), 0], ke: 1000 }));
    const r = traceParticles(gyroModel(0.5), rowsOf(rays, false), { integrator: 'rk45', rtol: 1e-11, maxStepCells: 1, relativistic: false, tMax: 0.75 * T,
        planes: [{ kind: 'x', at: 0, record: 'all' }] });
    const c = [0, 1].map((i) => crossings(r, 0).find((row) => row[L.C_ID] === i && row[L.C_Y] < -r0));
    const Q = intersect([c[0][L.C_X], c[0][L.C_Y], 0], [c[0][L.C_VX], c[0][L.C_VY], 0], [c[1][L.C_X], c[1][L.C_Y], 0], [c[1][L.C_VX], c[1][L.C_VY], 0]);
    // P = origin is at 90° about the central-orbit centre (0, −r); the focus angle is the turn to Q
    const turn = 90 - Math.atan2(Q[1] + r0, Q[0]) / DEG;
    absEq(turn, 180, 0.005, 'focus angle');
    absEq(turn, 180, 1e-5, 'focus angle (solo precision)');
});

test('K9 relativistic electron with KE = mₑc² in 0.1 T: γ = 2, β = 0.866025, r = 29.523 mm', () => {
    const ke = ME_U * UC2_EV, cy = cyclotron(ME_U, -1, 0.1, ke, true), T = 1 / cy.freqMHz;
    const r = traceParticles(gyroModel(0.1, 5), rowsOf([{ m: ME_U, q: -1, p: [0, 0, 0], d: [1, 0, 0], ke }], true),
        { integrator: 'rk45', rtol: 1e-11, maxStepCells: 1, tMax: 2.2 * T, planes: [{ kind: 'y', at: cy.radiusMM, record: 'all' }] });
    const o = orbitFromPlane(r);
    relEq(o.radius, cy.radiusMM, 1e-9, 'radius'); digits(o.radius, 29.523, 'K9 radius');
    relEq(1 / o.period, cy.freqMHz, 1e-9, 'frequency');
    const v = Math.hypot(S(r, 0, L.S_VX), S(r, 0, L.S_VY), S(r, 0, L.S_VZ));
    digits(v / C_MMUS, 0.866025, 'β');
    relEq(1 / Math.sqrt(1 - (v / C_MMUS) ** 2), 2, 1e-10, 'γ');
    relEq(S(r, 0, L.S_KE), ke, 1e-10, 'KE conserved');
});

// ---------------------------------------------------------------- K6: hard-edged sector
function sectorRun(phiDeg, integrator, nrays = 2) {
    const Bz = -0.455286, rc = 100, lObj = rc / Math.tan(phiDeg / 2 * DEG);
    const model = createFieldModel({ resolved: res(dom('planar2d', 1, [-600, 600], [-600, 600]),
        { magnets: [{ type: 'region', B: [0, 0, Bz], region: { type: 'annulus', cx: 0, cy: 0, rIn: 50, rOut: 150, a0: 0, a1: phiDeg } }] }) });
    const angles = nrays === 2 ? [-5e-4, 5e-4] : [-5e-4, 0, 5e-4];
    const rays = angles.map((a) => ({ m: 100, q: 1, p: [rc, -lObj, 0], d: [-Math.sin(a), Math.cos(a), 0], ke: 1000 }));
    // a measuring segment perpendicular to the exit direction, 250 mm after the exit point
    const ex = [rc * Math.cos(phiDeg * DEG), rc * Math.sin(phiDeg * DEG)], ed = [-Math.sin(phiDeg * DEG), Math.cos(phiDeg * DEG)], en = [ed[1], -ed[0]];
    const c = [ex[0] + 250 * ed[0], ex[1] + 250 * ed[1]];
    const plane = { kind: 'segment', p0: [c[0] + 60 * en[0], c[1] + 60 * en[1]], p1: [c[0] - 60 * en[0], c[1] - 60 * en[1]], terminate: true };
    const r = traceParticles(model, rowsOf(rays, false), { integrator, rtol: 1e-11, maxStepCells: 1, relativistic: false, tMax: 50, planes: [plane], debugRegions: true, record: { trajectories: false } });
    const rows = crossings(r, 0);
    assert.equal(rows.length, rays.length, 'all rays detected');
    const Q = intersect([rows[0][L.C_X], rows[0][L.C_Y], 0], [rows[0][L.C_VX], rows[0][L.C_VY], 0], [rows[1][L.C_X], rows[1][L.C_Y], 0], [rows[1][L.C_VX], rows[1][L.C_VY], 0]);
    return { r, lImage: (Q[0] - ex[0]) * ed[0] + (Q[1] - ex[1]) * ed[1] };
}

test('K6 hard-edged sector imaging: l′ = 100.000 / 173.205 mm (rel 2e-4); no accepted step changes regionSig', () => {
    for (const [phi, ref] of [[90, 100], [60, 173.20508075688772]]) {
        const { r, lImage } = sectorRun(phi, 'rk45');
        relEq(lImage, ref, 2e-4, `K6 φ=${phi} DP45`);
        assert.equal(r.stats.regionViolations, 0, 'no step integrates across a field edge');
        assert.ok(r.stats.edgeSplits >= 4, 'each ray crosses two edges: ' + r.stats.edgeSplits);
    }
    // Boris restarts its leapfrog at the edges too
    const b = sectorRun(90, 'boris');
    relEq(b.lImage, 100, 2e-3, 'K6 Boris');
    assert.ok(b.r.stats.edgeSplits >= 4);
});

// ---------------------------------------------------------------- K7, K8: time-dependent fields
function capacitor(terms) {
    const tf = timeFunctions([{ ground: true }, { v: 0, terms }]);
    const amp = tf.channels[0].amp[1];
    const grid = analyticGrid({ phi: (x) => amp * (200 - x) / 210, grad: () => [-amp / 210, 0], bounds: [-10, 200, -5, 5], h: 1 });
    return createFieldModel({ resolved: res(dom('planar2d', 1, [-10, 200], [-5, 5])), grid, channelFns: [tf.channels[0].fn] });
}

test('K7 RF uniform field E = 100 sin Ωt: positions at 0.5 µs (1e-9; digits)', () => {
    const model = capacitor([{ type: 'cos', amp: 21000, freq: 1, phase: -90 }]);
    assert.ok(model.timeDependent);
    const masses = [10, 100, 1000], refs = [76.780588, 7.678059, 0.767806];
    const r = traceParticles(model, rowsOf(masses.map((m) => ({ m, q: 1, p: [0, 0, 0], d: [1, 0, 0], ke: 0 })), false),
        { rtol: 1e-12, relativistic: false, tMax: 0.5 });
    masses.forEach((m, i) => {
        assert.equal(S(r, i, L.S_STATUS), STATUS.TMAX);
        const W = 2 * Math.PI, exact = K_ACC / m * 100 * (0.5 / W - Math.sin(W * 0.5) / (W * W));
        relEq(S(r, i, L.S_X), exact, 1e-9, 'K7 m=' + m);
        digits(S(r, i, L.S_X), refs[i], 'K7 m=' + m);
        assert.ok(Number.isNaN(S(r, i, L.S_DE_END)), 'no energy check in time-dependent fields');
        assert.ok((S(r, i, L.S_FLAGS) & L.FLAG.TD_FIELDS) !== 0);
    });
});

test('K8 pulse breakpoints: steps land on the corners (rel 1e-9 at rtol 1e-12)', () => {
    const model = capacitor([{ type: 'pulse', amp: 2100, t0: 0.2, rise: 0.1, width: 10, fall: 0.1 }]);
    const r = traceParticles(model, rowsOf([{ m: 100, q: 1, p: [0, 0, 0], d: [1, 0, 0], ke: 0 }], false), { rtol: 1e-12, relativistic: false, tMax: 1.0 });
    const A = K_ACC / 100 * 10;   // E = 10 V/mm at full amplitude
    const exact = A * (Math.pow(0.1, 3) / (6 * 0.1) + (0.1 * 0.1 / (2 * 0.1)) * 0.7 + 0.7 * 0.7 / 2);
    relEq(S(r, 0, L.S_X), exact, 1e-9, 'K8 position at 1 µs');
    // a pulse with zero rise (a jump) is integrated exactly as well
    const jump = capacitor([{ type: 'pulse', amp: 2100, t0: 0.2, rise: 0, width: 10, fall: 0 }]);
    const rj = traceParticles(jump, rowsOf([{ m: 100, q: 1, p: [0, 0, 0], d: [1, 0, 0], ke: 0 }], false), { rtol: 1e-12, relativistic: false, tMax: 1.0 });
    relEq(S(rj, 0, L.S_X), A * 0.8 * 0.8 / 2, 1e-10, 'step pulse');
});

// ---------------------------------------------------------------- events with geometry
function stubModel(items, nE, transparentIdx = [], electrodes = null, more = {}) {
    const geo = stubGeometry(items, nE, transparentIdx);
    const el = electrodes || Array.from({ length: nE }, (_, k) => (k === 0 ? { id: 'gnd' } : { id: 'e' + k }));
    return createFieldModel({ resolved: { domain: dom('planar2d', 1, [-20, 20], [-20, 20]), electrodes: el, magnets: [], idealFields: [], ...more }, geometry: geo, ...(more.grid ? { grid: more.grid } : {}) });
}

test('T15(a): ray onto a 30° plate, hit point within 1e-8 mm of the analytic intersection', () => {
    const a = 60;   // long axis 60° from x, so the face normal is 30° from the ray
    const model = stubModel([{ kind: 'rect', electrode: 1, cx: 5, cy: 0, hu: 6, hv: 0.2, ang: a }], 2);
    const ys = [-3, -1.234567, 0, 0.5, 2.75];
    const r = traceParticles(model, rowsOf(ys.map((y) => ({ m: 100, q: 1, p: [-10, y, 0], d: [1, 0, 0], ke: 100 })), false), { relativistic: false });
    const sa = Math.sin(a * DEG), ca = Math.cos(a * DEG);
    ys.forEach((y, i) => {
        assert.equal(S(r, i, L.S_STATUS), STATUS.HIT); assert.equal(S(r, i, L.S_WHERE), 1);
        // entry face (p − c)·v̂ = +hv with v̂ = (−sin a, cos a)
        const x = 5 + (y * ca - 0.2) / sa;
        absEq(S(r, i, L.S_X), x, 1e-8, 'hit x'); absEq(S(r, i, L.S_Y), y, 1e-12, 'hit y');
        relEq(S(r, i, L.S_TOF), (x + 10) / speedFromKE(100, 100, false), 1e-9, 'hit time');
    });
});

test('T15(b): 0.2-cell plate at 45°, 100 random rays: 0 misses (near band from a grid, draft steps)', () => {
    const items = [{ kind: 'rect', electrode: 1, cx: 0, cy: 0, hu: 8, hv: 0.1, ang: 45 }];
    const dist = (x, y) => Math.abs(-x * Math.SQRT1_2 + y * Math.SQRT1_2);
    const grid = analyticGrid({ phi: () => 0, bounds: [-20, 20, -20, 20], h: 1, near: (x, y) => dist(x, y) < 2 });
    const model = stubModel(items, 2, [], null, { grid });
    assert.equal(model.nearMode, 1);
    const rays = [];
    for (let k = 0; k < 100; k++) {
        const y0 = -4 + 8 * uniform01(3, 1, k, 0), ang = (-40 + 80 * uniform01(3, 1, k, 1)) * DEG;
        // aim at a point on the plate, start 15 mm away
        const tx = (y0 + 4 * (uniform01(3, 1, k, 2) - 0.5)) * Math.SQRT1_2, ty = tx;
        rays.push({ m: 100, q: 1, p: [tx - 15 * Math.cos(ang), ty - 15 * Math.sin(ang), 0], d: [Math.cos(ang), Math.sin(ang), 0], ke: 100 });
    }
    const r = traceParticles(model, rowsOf(rays, false), { relativistic: false, maxStepCells: 1, nearStepCells: 0.25 });
    let miss = 0;
    for (let i = 0; i < 100; i++) if (!(S(r, i, L.S_STATUS) === STATUS.HIT && S(r, i, L.S_WHERE) === 1)) miss++;
    assert.equal(miss, 0, 'missed hits');
    for (let i = 0; i < 100; i++) assert.ok(dist(S(r, i, L.S_X), S(r, i, L.S_Y)) <= 0.1 + 1e-8, 'hit on the plate surface');
});

test('T15(c): zero-thickness polyline, 10⁴ rays: 0 misses', () => {
    const items = [{ kind: 'line', electrode: 1, pts: [[3, -12], [5, -3], [4, 0], [6, 4], [3, 12]] }];
    const grid = analyticGrid({ phi: () => 0, bounds: [-20, 20, -20, 20], h: 2, near: (x) => x > 0 && x < 9 });
    const model = stubModel(items, 2, [], null, { grid });
    const N = 10000, rays = [];
    for (let k = 0; k < N; k++) {
        const y0 = -8 + 16 * uniform01(5, 0, k, 0), ang = (-25 + 50 * uniform01(5, 0, k, 1)) * DEG;
        rays.push({ m: 100, q: 1, p: [-2, y0, 0], d: [Math.cos(ang), Math.sin(ang), 0], ke: 100 });
    }
    const r = traceParticles(model, rowsOf(rays, false), { relativistic: false, maxStepCells: 1, nearStepCells: 0.25, record: { trajectories: false } });
    let miss = 0;
    for (let i = 0; i < N; i++) if (S(r, i, L.S_STATUS) !== STATUS.HIT) miss++;
    assert.equal(miss, 0, 'missed polyline crossings');
});

test('mesh transmission 0.7 over 10⁴ rays within 3σ; mesh crossing rows; counter-based rolls', () => {
    const items = [{ kind: 'line', electrode: 1, pts: [[5, -15], [5, 15]] }];
    const electrodes = [{ id: 'gnd' }, { id: 'mesh', kind: 'grid', transmission: 0.7 }];
    const model = stubModel(items, 2, [1], electrodes);
    const N = 10000, rays = [];
    for (let k = 0; k < N; k++) rays.push({ m: 100, q: 1, p: [0, -10 + 20 * uniform01(9, 0, k, 0), 0], d: [1, 0, 0], ke: 100 });
    const opts = { relativistic: false, seed: 42, planes: [{ kind: 'x', at: 9, terminate: true }], record: { trajectories: false } };
    const r = traceParticles(model, rowsOf(rays, false), opts);
    let abs = 0, det = 0;
    for (let i = 0; i < N; i++) {
        const st = S(r, i, L.S_STATUS);
        if (st === STATUS.ABSORBED) { abs++; assert.equal(S(r, i, L.S_WHERE), 1); absEq(S(r, i, L.S_X), 5, 1e-9, 'absorbed on the mesh'); }
        else if (st === STATUS.DETECTED) det++;
    }
    assert.equal(abs + det, N);
    assert.ok(Math.abs(abs - 0.3 * N) <= 3 * Math.sqrt(N * 0.21), 'absorbed ' + abs);
    const mesh = crossings(r, -1);
    assert.equal(mesh.length, N, 'one mesh crossing row per ray');
    for (const c of mesh) { assert.equal(c[L.C_KIND], 1); assert.equal(c[L.C_ELEC], 1); assert.equal(c[L.C_K], 1); }
    // the roll for particle id and crossing 1 is uniform01(seed, 0x7f4a7c15, id, 1)
    for (let i = 0; i < 50; i++) assert.equal(S(r, i, L.S_STATUS) === STATUS.ABSORBED, uniform01(42, 0x7f4a7c15, i, 1) >= 0.7);
});

test('a plane crossing just before a hit is recorded first, then the hit ends the particle', () => {
    const model = stubModel([{ kind: 'rect', electrode: 1, cx: 5.5, cy: 0, hu: 0.5, hv: 5, ang: 0 }], 2);
    const r = traceParticles(model, rowsOf([{ m: 100, q: 1, p: [0, 0, 0], d: [1, 0.01, 0], ke: 100 }], false),
        { relativistic: false, maxStepCells: 1, nearStepCells: 1, planes: [{ kind: 'x', at: 4.9999 }, { kind: 'x', at: 5.0001 }] });
    assert.equal(S(r, 0, L.S_STATUS), STATUS.HIT);
    absEq(S(r, 0, L.S_X), 5, 1e-9, 'hit');
    const rows = crossings(r);
    assert.equal(rows.length, 1, 'only the plane before the electrode is crossed');
    assert.equal(rows[0][L.C_PLANE], 0);
    assert.ok(rows[0][L.C_T] < S(r, 0, L.S_T));
    assert.equal(S(r, 0, L.S_NCROSS), 1);
});

test('BORN_INSIDE; emission from a surface; sub-cell plate crossed in one step', () => {
    const model = stubModel([{ kind: 'rect', electrode: 1, cx: 0, cy: 0, hu: 1, hv: 1, ang: 0 }, { kind: 'rect', electrode: 2, cx: 8, cy: 0, hu: 0.05, hv: 5, ang: 0 }], 3);
    const r = traceParticles(model, rowsOf([
        { m: 100, q: 1, p: [0.5, 0, 0], d: [1, 0, 0], ke: 10 },
        { m: 100, q: 1, p: [1 + 1e-6, 0, 0], d: [1, 0, 0], ke: 10 },
        { m: 100, q: 1, p: [1 + 5e-7, 0, 0], d: [-1, 0, 0], ke: 10 },
    ], false), { relativistic: false, maxStepCells: 1, nearStepCells: 1 });
    assert.equal(S(r, 0, L.S_STATUS), STATUS.BORN_INSIDE); assert.equal(S(r, 0, L.S_WHERE), 1);
    assert.equal(S(r, 1, L.S_STATUS), STATUS.HIT); assert.equal(S(r, 1, L.S_WHERE), 2, 'leaves the surface and hits the thin plate');
    absEq(S(r, 1, L.S_X), 7.95, 1e-9, 'thin plate face');
    assert.equal(S(r, 2, L.S_STATUS), STATUS.BORN_INSIDE, 'moving into the surface from 5e-7 mm');
});

test('exit through a stop edge (EDGE code), drift edge, and particles born outside', () => {
    const model = createFieldModel({ resolved: res(dom('planar2d', 1, [0, 10], [-5, 5])) });
    const rays = [
        { m: 1, q: 1, p: [5, 0, 0], d: [0, 1, 0], ke: 10 },
        { m: 1, q: 1, p: [5, 0, 0], d: [-1, 0, 0], ke: 10 },
        { m: 1, q: 1, p: [5, 0, 0], d: [1, 0.2, 0], ke: 10 },
        { m: 1, q: 1, p: [20, 0, 0], d: [1, 0, 0], ke: 10 },
        { m: 1, q: 1, p: [-3, 0, 0], d: [1, 0, 0], ke: 10 },
    ];
    const r = traceParticles(model, rowsOf(rays, false), { relativistic: false, beyond: { xmax: 'drift' }, maxDrift: 100, planes: [] });
    assert.equal(S(r, 0, L.S_STATUS), STATUS.EXIT); assert.equal(S(r, 0, L.S_WHERE), L.EDGE.YMAX); absEq(S(r, 0, L.S_Y), 5, 1e-8, 'exit point');
    assert.equal(S(r, 1, L.S_STATUS), STATUS.EXIT); assert.equal(S(r, 1, L.S_WHERE), L.EDGE.XMIN); absEq(S(r, 1, L.S_X), 0, 1e-8, 'exit point');
    assert.equal(S(r, 2, L.S_STATUS), STATUS.DRIFT_END); assert.equal(S(r, 2, L.S_WHERE), L.EDGE.DRIFT_LIMIT);
    absEq(S(r, 2, L.S_X), 10 + 100 / Math.hypot(1, 0.2), 1e-8, 'drift ends after maxDrift mm');
    assert.equal(S(r, 3, L.S_STATUS), STATUS.DRIFT_END, 'born beyond a drift edge');
    assert.equal(S(r, 4, L.S_STATUS), STATUS.EXIT, 'born beyond a stop edge'); assert.equal(S(r, 4, L.S_STEPS), 0);
});

test('analytic drift crossings: x-plane with radius, cylinder (r) plane, segments (planar and cylindrical)', () => {
    // planar: plane x = 50 with radius 3 (a round detector), segment from (30, 10) to (30, −10)
    const mp = createFieldModel({ resolved: res(dom('planar2d', 1, [0, 10], [-5, 5])) });
    const rays = [{ m: 4, q: 1, p: [1, 0, 0], d: [1, 0.05, 0.02], ke: 50 }, { m: 4, q: 1, p: [1, 0, 0], d: [1, 0.1, 0], ke: 50 }];
    const planes = [{ kind: 'x', at: 50, radius: 3, terminate: true }, { kind: 'segment', p0: [30, 10], p1: [30, -10] }];
    const r = traceParticles(mp, rowsOf(rays, false), { relativistic: false, beyond: { xmax: 'drift' }, planes, maxDrift: 1000 });
    const v = speedFromKE(50, 4, false);
    const n0 = Math.hypot(1, 0.05, 0.02);
    assert.equal(S(r, 0, L.S_STATUS), STATUS.DETECTED);
    relEq(S(r, 0, L.S_TOF), 49 * n0 / v, 1e-12, 'detector time');
    absEq(S(r, 0, L.S_Y), 49 * 0.05, 1e-12, 'detector y'); absEq(S(r, 0, L.S_Z), 49 * 0.02, 1e-12, 'detector z');
    assert.equal(S(r, 1, L.S_STATUS), STATUS.DRIFT_END, 'outside the detector radius');
    const seg = crossings(r, 1);
    assert.equal(seg.length, 2);
    for (const c of seg) { absEq(c[L.C_X], 30, 1e-12, 'segment x'); assert.equal(c[L.C_DIR], -1, 'normal (p1 − p0) rotated −90° points to −x'); }
    // cylindrical: r-plane at ρ = 12 and a conical segment from (40, 30) to (60, 10) in (x, ρ), i.e. ρ = 70 − x
    const mc = createFieldModel({ resolved: res(dom('cyl2d', 1, [0, 10], [0, 5])) });
    const r2 = traceParticles(mc, rowsOf([{ m: 4, q: 1, p: [1, 0.5, 0], d: [1, 0.3, 0.4], ke: 50 }], false),
        { relativistic: false, beyond: { xmax: 'drift', ymax: 'drift' }, planes: [{ kind: 'r', at: 12 }, { kind: 'segment', p0: [40, 30], p1: [60, 10], terminate: true }], maxDrift: 1000 });
    const rc = crossings(r2, 0)[0];
    absEq(Math.hypot(rc[L.C_Y], rc[L.C_Z]), 12, 1e-9, 'cylinder crossing'); assert.equal(rc[L.C_DIR], 1);
    assert.equal(S(r2, 0, L.S_STATUS), STATUS.DETECTED);
    const x = S(r2, 0, L.S_X), rho = Math.hypot(S(r2, 0, L.S_Y), S(r2, 0, L.S_Z));
    absEq(rho, 70 - x, 1e-9, 'cone crossing ρ = 70 − x');
    assert.ok(x > 40 && x < 60);
    assert.equal(crossings(r2, 1)[0][L.C_DIR], -1, 'crossing against the segment normal');
});

test('tangent double crossing inside one step is found (golden-section check)', () => {
    const cy = cyclotron(100, 1, 0.5, 1000, false), r0 = cy.radiusMM, T = 1 / cy.freqMHz;
    // plane 1 µm above the lowest point of the orbit (y = −2r): the dip below it is ~0.85 mm long
    const r = traceParticles(gyroModel(0.5, 20), rowsOf([{ m: 100, q: 1, p: [0, 0, 0], d: [1, 0, 0], ke: 1000 }], false),
        { integrator: 'rk45', rtol: 1e-10, maxStepCells: 1, relativistic: false, tMax: 0.8 * T, planes: [{ kind: 'y', at: -2 * r0 + 1e-3, record: 'all' }] });
    const rows = crossings(r, 0);
    assert.equal(rows.length, 2, 'two crossings near the bottom of the orbit');
    assert.equal(rows[0][L.C_DIR], -1); assert.equal(rows[1][L.C_DIR], 1);
    // circle x² + (y + r)² = r² at y = −2r + δ; near tangency x is ~200× more sensitive than y to orbit errors
    const xc = Math.sqrt(2 * r0 * 1e-3 - 1e-6);
    absEq(rows[0][L.C_X], xc, 2e-5, 'first crossing x'); absEq(rows[1][L.C_X], -xc, 2e-5, 'second crossing x');
    for (const row of rows) absEq(row[L.C_Y], -2 * r0 + 1e-3, 1e-9, 'on the plane');
});

test('side, limits, record first/all filters on planes', () => {
    const model = createFieldModel({ resolved: res(dom('planar2d', 1, [-50, 50], [-50, 50]), { idealFields: [{ type: 'uniformE', E: [-10, 0, 0] }] }) });
    // a particle launched along +x turns back in the field: crosses x = 5 forward then backward
    const rays = [{ m: 10, q: 1, p: [0, 1, 0], d: [1, 0, 0], ke: 100 }, { m: 10, q: 1, p: [0, 4, 0], d: [1, 0, 0], ke: 100 }];
    const run = (pl) => traceParticles(model, rowsOf(rays, false), { relativistic: false, tMax: 10, planes: [pl], record: { trajectories: false } });
    assert.equal(run({ kind: 'x', at: 5, record: 'all' }).nCross, 4);
    assert.equal(run({ kind: 'x', at: 5, record: 'first' }).nCross, 2);
    const fw = run({ kind: 'x', at: 5, record: 'all', side: 'forward' });
    assert.equal(fw.nCross, 2); for (const c of crossings(fw)) assert.equal(c[L.C_DIR], 1);
    const bw = run({ kind: 'x', at: 5, record: 'all', side: 'backward' });
    assert.equal(bw.nCross, 2); for (const c of crossings(bw)) { assert.equal(c[L.C_DIR], -1); assert.equal(c[L.C_K], 1); }
    const lim = run({ kind: 'x', at: 5, record: 'all', limits: { a: [0, 2], b: null } });
    assert.equal(lim.nCross, 2); for (const c of crossings(lim)) assert.equal(c[L.C_ID], 0);
    const det = run({ kind: 'x', at: 5, terminate: true, side: 'backward' });
    for (let i = 0; i < 2; i++) { assert.equal(S(det, i, L.S_STATUS), STATUS.DETECTED); assert.ok(S(det, i, L.S_VX) < 0); }
});

// ---------------------------------------------------------------- determinism, limits, diagnostics
test('determinism: identical summaries, crossings and trajectories for batch sizes 1, 7, 64 (merged in index order)', () => {
    const items = [{ kind: 'rect', electrode: 1, cx: 12, cy: 0, hu: 0.5, hv: 3, ang: 10 }, { kind: 'line', electrode: 2, pts: [[6, -20], [6, 20]] }];
    const electrodes = [{ id: 'gnd' }, { id: 'stop' }, { id: 'mesh', kind: 'grid', transmission: 0.8 }];
    const grid = analyticGrid({ phi: (x, y) => 5 * Math.sin(0.2 * x) * Math.cosh(0.2 * y), grad: (x, y) => [Math.cos(0.2 * x) * Math.cosh(0.2 * y), Math.sin(0.2 * x) * Math.sinh(0.2 * y)], bounds: [-20, 20, -20, 20], h: 1 });
    const model = stubModel(items, 3, [2], electrodes, { grid });
    const sources = [{ id: 's', count: 150, sampling: 'random', seed: 3, species: [{ mass: 20, charge: 1, fraction: 1 }, { mass: 40, charge: 1, fraction: 1 }],
        position: { type: 'disc', center: [0, 0, 0], normal: [1, 0, 0], radius: 4 }, direction: { type: 'cone', axis: [1, 0, 0], halfAngle: 20 },
        energy: { type: 'uniform', min: 5, max: 15 }, time: { type: 'fixed', t: 0 } }];
    const N = countParticles(sources);
    const opts = { rtol: 1e-8, planes: [{ kind: 'x', at: 3, record: 'all' }, { kind: 'x', at: 18, terminate: true }], seed: 7, record: { trajectories: true, markersDt: 0.5 } };
    const whole = traceParticles(model, generate(sources, 0, N, {}), opts);
    for (const B of [1, 7, 64]) {
        const parts = [];
        for (let i0 = 0; i0 < N; i0 += B) parts.push(traceParticles(model, generate(sources, i0, Math.min(N, i0 + B), {}), opts));
        const m = mergeResults(parts.reverse());
        assert.deepEqual(m.summary, whole.summary, 'summary B=' + B);
        assert.deepEqual(m.crossings, whole.crossings, 'crossings B=' + B);
        assert.deepEqual(m.traj.offsets, whole.traj.offsets, 'offsets B=' + B);
        assert.deepEqual(m.traj.pts, whole.traj.pts, 'points B=' + B);
        assert.deepEqual(m.markers, whole.markers, 'markers B=' + B);
        assert.equal(m.stats.steps, whole.stats.steps);
    }
    const st = new Set(); for (let i = 0; i < N; i++) st.add(S(whole, i, L.S_STATUS));
    assert.ok(st.has(STATUS.HIT) && st.has(STATUS.DETECTED), 'the fixture exercises hits and detections');
});

test('limits: TMAX, STEPS, NUM_ERROR (NaN field) and CANCELLED', () => {
    const model = createFieldModel({ resolved: res(dom('planar2d', 1, [-1e4, 1e4], [-1e4, 1e4])) });
    const ray = [{ m: 100, q: 1, p: [0, 0, 0], d: [1, 0, 0], ke: 100 }];
    const r1 = traceParticles(model, rowsOf(ray, false), { relativistic: false, tMax: 0.7 });
    assert.equal(S(r1, 0, L.S_STATUS), STATUS.TMAX); assert.equal(S(r1, 0, L.S_T), 0.7);
    const r2 = traceParticles(model, rowsOf(ray, false), { relativistic: false, maxSteps: 25 });
    assert.equal(S(r2, 0, L.S_STATUS), STATUS.STEPS); assert.equal(S(r2, 0, L.S_STEPS), 25);
    const bad = analyticGrid({ phi: () => NaN, grad: () => [NaN, 0], bounds: [-10, 10, -10, 10], h: 1 });
    const mb = createFieldModel({ resolved: res(dom('planar2d', 1, [-10, 10], [-10, 10])), grid: bad });
    const r3 = traceParticles(mb, rowsOf(ray, false), { relativistic: false });
    assert.equal(S(r3, 0, L.S_STATUS), STATUS.NUM_ERROR);
    let calls = 0;
    const r4 = traceParticles(model, rowsOf([...ray, ...ray, ...ray], false), { relativistic: false, tMax: 0.01 }, { shouldStop: () => ++calls > 1 });
    assert.equal(S(r4, 0, L.S_STATUS), STATUS.TMAX);
    assert.equal(S(r4, 1, L.S_STATUS), STATUS.CANCELLED); assert.equal(S(r4, 2, L.S_STATUS), STATUS.CANCELLED);
    assert.ok(r4.cancelled);
    let prog = 0;
    traceParticles(model, rowsOf(ray, false), { relativistic: false, tMax: 0.01 }, { onProgress: () => prog++, progressEveryMs: 1e-9 });
    assert.ok(prog >= 1);
});

test('energy diagnostics: conservative field closes to ≪ 1e-6; a non-conservative field raises ENERGY_WARN; work sum', () => {
    // an einzel-like axisymmetric potential (exact gradient), skew rays
    const V = (x) => 400 * Math.exp(-x * x / 50);
    const phi = (x, r) => V(x) * (1 - r * r * (x * x / 625 - 1 / 25) / 4);
    const grad = (x, r) => {
        const dV = -2 * x / 50 * V(x), c = x * x / 625 - 1 / 25;
        return [dV * (1 - r * r * c / 4) - V(x) * r * r * (2 * x / 625) / 4, -V(x) * r * c / 2];
    };
    const grid = analyticGrid({ phi, grad, bounds: [-40, 40, 0, 10], h: 0.5, cyl: true });
    const model = createFieldModel({ resolved: res(dom('cyl2d', 0.5, [-40, 40], [0, 10]), { electrodes: [{ id: 'gnd' }, { id: 'c', v: 400 }] }), grid });
    const rays = [0.5, 2, 4].map((y) => ({ m: 100, q: 1, p: [-38, y, 0], d: [1, 0, 0.02], ke: 1000 }));
    const r = traceParticles(model, rowsOf(rays, true), { rtol: 1e-10, planes: [{ kind: 'x', at: 38, terminate: true }] });
    for (let i = 0; i < 3; i++) {
        assert.equal(S(r, i, L.S_STATUS), STATUS.DETECTED);
        assert.ok(Math.abs(S(r, i, L.S_DE_END)) / 1000 < 1e-9, 'endpoint energy ' + S(r, i, L.S_DE_END));
        assert.ok(S(r, i, L.S_DE_MAX) / 1000 < 1e-8, 'max energy deviation');
        assert.ok(S(r, i, L.S_WORK) / 1000 < 1e-8, 'work-energy sum ' + S(r, i, L.S_WORK));
        assert.equal(S(r, i, L.S_FLAGS) & L.FLAG.ENERGY_WARN, 0);
    }
    // a curl field E = (−y, x)·0.5 (no potential) pumps energy into a circulating ion
    const curl = analyticGrid({ phi: () => 0, grad: (x, y) => [0.5 * y, -0.5 * x], bounds: [-50, 50, -50, 50], h: 1 });
    const mc = createFieldModel({ resolved: res(dom('planar2d', 1, [-50, 50], [-50, 50]), { electrodes: [{ id: 'gnd' }, { id: 'a', v: 10 }] }), grid: curl });
    const rc = traceParticles(mc, rowsOf([{ m: 100, q: 1, p: [5, 0, 0], d: [0, 1, 0], ke: 10 }], false), { relativistic: false, tMax: 2 });
    assert.ok((S(rc, 0, L.S_FLAGS) & L.FLAG.ENERGY_WARN) !== 0, 'ENERGY_WARN for a non-conservative field');
    assert.ok(S(rc, 0, L.S_WORK) < 1e-6, 'the work sum still closes: the integrator is accurate, the field is not conservative');
});

test('trajectory recording: always keeps birth, events and end; per-particle cap with decimation', () => {
    const cy = cyclotron(100, 1, 0.5, 1000, false), T = 1 / cy.freqMHz;
    const ray = [{ m: 100, q: 1, p: [0, 0, 0], d: [1, 0, 0], ke: 1000 }];
    const all = traceParticles(gyroModel(0.5, 10), rowsOf(ray, false), { integrator: 'rk45', rtol: 1e-8, maxStepCells: 1, relativistic: false, tMax: 3 * T, record: { everyStep: true, maxPoints: 1e6 } });
    assert.equal(all.traj.offsets[1], S(all, 0, L.S_STEPS) + 1, 'everyStep: birth plus every step');
    const capped = traceParticles(gyroModel(0.5, 10), rowsOf(ray, false), { integrator: 'rk45', rtol: 1e-8, maxStepCells: 1, relativistic: false, tMax: 3 * T, record: { everyStep: true, maxPoints: 50 } });
    const n = capped.traj.offsets[1];
    assert.ok(n <= 50 && n >= 20, 'capped points ' + n);
    const p = capped.traj.pts;
    assert.deepEqual([p[0], p[1], p[3]], [0, 0, 0], 'birth kept');
    absEq(p[4 * (n - 1) + 3], 3 * T, 1e-5, 'end kept');
    // decimated trajectory points lie on the orbit
    for (let k = 0; k < n; k++) absEq(Math.hypot(p[4 * k], p[4 * k + 1] + cy.radiusMM), cy.radiusMM, 1e-4, 'on the orbit');
    const sparse = traceParticles(gyroModel(0.5, 10), rowsOf(ray, false), { integrator: 'rk45', rtol: 1e-8, maxStepCells: 1, relativistic: false, tMax: T, record: { minSegCells: 0.5, maxTurnDeg: 10 } });
    assert.ok(sparse.traj.offsets[1] < S(sparse, 0, L.S_STEPS), 'turn and distance filters thin the trajectory');
    const none = traceParticles(gyroModel(0.5, 10), rowsOf(ray, false), { integrator: 'rk45', relativistic: false, tMax: T, record: { trajectories: false } });
    assert.equal(none.traj, null); assert.equal(none.markers, null);
});

test('integrator choice: auto picks Boris for long magnetic runs (tMax/T_gyr > 50) and DP45 otherwise', () => {
    const cy = cyclotron(100, 1, 0.5, 1000, false), T = 1 / cy.freqMHz;
    const ray = [{ m: 100, q: 1, p: [0, 0, 0], d: [1, 0, 0], ke: 1000 }];
    const long = traceParticles(gyroModel(0.5, 10), rowsOf(ray, false), { relativistic: false, tMax: 60 * T, record: { trajectories: false } });
    assert.ok((S(long, 0, L.S_FLAGS) & L.FLAG.BORIS) !== 0);
    const short = traceParticles(gyroModel(0.5, 10), rowsOf(ray, false), { relativistic: false, tMax: 10 * T, record: { trajectories: false } });
    assert.equal(S(short, 0, L.S_FLAGS) & L.FLAG.BORIS, 0);
});

test('traceOptions builds tracer options from a resolved project', () => {
    const o = traceOptions({ tracer: { integrator: 'rk4', quality: 'fine', relativistic: false, tMax: 5, maxSteps: 9, maxDrift: 7 },
        recording: { planes: [{ kind: 'x', at: 1 }], trajectories: { store: false, maxPoints: 10 }, timeMarkers: { dt: 0.1 } }, domain: { beyond: { xmax: 'drift' } } }, { rtol: 1e-3, record: { everyStep: true } });
    assert.equal(o.integrator, 'rk4'); assert.equal(o.rtol, 1e-3); assert.equal(o.maxStepCells, 0.25); assert.equal(o.relativistic, false);
    assert.equal(o.tMax, 5); assert.equal(o.planes.length, 1); assert.equal(o.beyond.xmax, 'drift');
    assert.deepEqual(o.record, { trajectories: false, maxPoints: 10, markersDt: 0.1, everyStep: true });
});

// ---------------------------------------------------------------- stretch (P1b, non-gating): space charge and gas drag
test('stretch P2: two protons from rest 1 µm apart reach 0.719982 meV each (direct Coulomb, lockstep RK4)', () => {
    const model = createFieldModel({ resolved: res(dom('planar2d', 1, [-500, 500], [-500, 500])) });
    const mp = 1.0072764665789;
    const rays = [{ m: mp, q: 1, p: [-0.0005, 0, 0], d: [1, 0, 0], ke: 0 }, { m: mp, q: 1, p: [0.0005, 0, 0], d: [1, 0, 0], ke: 0 }];
    const eps = 1e-7;
    const r = traceCoulomb(model, rowsOf(rays, false), { tMax: 300, softening: eps, relativistic: false, pairStep: 0.005 });
    const xs = [0, 1].flatMap((i) => [S(r, i, L.S_X), S(r, i, L.S_Y), S(r, i, L.S_Z)]);
    const U = coulombEnergy(xs, [1, 1], eps), U0 = coulombEnergy([-0.0005, 0, 0, 0.0005, 0, 0], [1, 1], eps);
    relEq(U0, 1.439964e-3, 1e-6, 'initial interaction energy (eV)');
    relEq(S(r, 0, L.S_KE) + S(r, 1, L.S_KE) + U, U0, 1e-6, 'energy conserved');
    relEq(S(r, 0, L.S_KE) + U / 2, 0.719982e-3, 2e-6, 'asymptotic energy per proton');
    absEq(S(r, 0, L.S_X), -S(r, 1, L.S_X), 1e-9, 'symmetric');
    assert.equal(S(r, 0, L.S_STATUS), STATUS.TMAX);
    // with the default softening ε = 1e-4 mm the released energy is k e²/√(r0² + ε²): 0.5% lower
    const r2 = traceCoulomb(model, rowsOf(rays, false), { tMax: 300, relativistic: false });
    relEq(S(r2, 0, L.S_KE) + coulombEnergy([S(r2, 0, L.S_X), 0, 0, S(r2, 1, L.S_X), 0, 0], [1, 1]) / 2, 0.719982e-3 / Math.sqrt(1.01), 2e-5, 'softened');
    assert.throws(() => traceCoulomb(model, new Float64Array(2001 * L.P_STRIDE), {}), (e) => e.code === 'E_UNSUPPORTED');
});

test('stretch: Coulomb tracing records planes, hits and exits like the tracer', () => {
    const model = stubModel([{ kind: 'rect', electrode: 1, cx: 10, cy: 0, hu: 0.5, hv: 3, ang: 0 }], 2);
    const rays = [{ m: 100, q: 1, p: [0, 0, 0], d: [1, 0, 0], ke: 100 }, { m: 100, q: 1, p: [0, 6, 0], d: [1, 0, 0], ke: 100 }, { m: 100, q: 0, p: [0, -6, 0], d: [0, -1, 0], ke: 100 }];
    const r = traceCoulomb(model, rowsOf(rays, false), { relativistic: false, planes: [{ kind: 'x', at: 5 }, { kind: 'x', at: 15, terminate: true }] });
    assert.equal(S(r, 0, L.S_STATUS), STATUS.HIT); assert.equal(S(r, 0, L.S_WHERE), 1);
    assert.ok(Math.abs(S(r, 0, L.S_X) - 9.5) < 0.05, 'hit at the plate face ' + S(r, 0, L.S_X));
    assert.equal(S(r, 1, L.S_STATUS), STATUS.DETECTED); assert.equal(S(r, 1, L.S_WHERE), 1);
    assert.equal(S(r, 2, L.S_STATUS), STATUS.EXIT); assert.equal(S(r, 2, L.S_WHERE), L.EDGE.YMIN);
    const p5 = crossings(r, 0);
    assert.equal(p5.length, 2);
    for (const c of p5) absEq(c[L.C_X], 5, 1e-6, 'plane crossing');
    assert.ok(S(r, 1, L.S_Y) > 6, 'the two charged ions repel');
});

test('stretch: Stokes drag reaches the terminal velocity K_mob·E (1e-6)', () => {
    const model = createFieldModel({ resolved: res(dom('planar2d', 1, [-500, 500], [-500, 500]), { idealFields: [{ type: 'uniformE', E: [10, 0, 0] }] }) });
    for (const q of [1, -1]) {
        const r = traceParticles(model, rowsOf([{ m: 100, q, p: [0, 0, 0], d: [1, 0, 0], ke: 0 }], false),
            { relativistic: false, rtol: 1e-10, tMax: 20, drag: { type: 'stokes', mobility: 2, gasVelocity: [0, 0.001, 0] }, record: { trajectories: false } });
        relEq(S(r, 0, L.S_VX), q * 1e-4 * 2 * 10, 1e-6, 'terminal velocity q=' + q);
        absEq(S(r, 0, L.S_VY), 0.001, 1e-9, 'carried by the gas');
        assert.ok(Number.isNaN(S(r, 0, L.S_DE_END)), 'no energy check with drag');
    }
});
