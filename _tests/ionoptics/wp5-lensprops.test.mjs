// WP5 lensprops.js (spec 3.11(3), 7.6 acceptance 2): the DiChio construction is exact for an ideal thin lens; on an
// analytic field phi(x, rho) = V(x) − rho² V''/4 + rho⁴ V''''/64 built from the exact zero-gap two-tube potential the
// lens tool reproduces twoTubeExact to 1e-5; the image finder agrees with Newton's lens equation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lensProperties, imageOf, fitEven, particleRow, LENS_HEIGHTS } from '../../beta/ion-optics/js/engine/lensprops.js';
import { twoTubeExact } from '../../beta/ion-optics/js/engine/exact.js';
import { analyticGrid } from '../../beta/ion-optics/js/engine/analytic-fields.js';
import { createFieldModel } from '../../beta/ion-optics/js/engine/fieldmodel.js';
import { traceParticles } from '../../beta/ion-optics/js/engine/trace.js';
import { P_STRIDE, P_ID, P_X, P_Y, P_WX, P_WY, S_STRIDE, S_ID, S_STATUS, S_WHERE, S_X, S_Y, S_Z, S_VX, S_VY, S_VZ, STATUS } from '../../beta/ion-optics/js/engine/layout.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (|diff| ${Math.abs(a - b)})`);

test('fitEven recovers c0 + c2 u + c4 u² exactly and degrades gracefully with few distinct heights', () => {
    const Ts = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08].map((t) => t * 2);
    const f = (T) => 1.25 - 3 * (T / 2) ** 2 + 40 * (T / 2) ** 4;
    const c = fitEven(Ts, Ts.map(f), 2);
    near(c[0], 1.25, 1e-12, 'c0'); near(c[1], -3, 1e-9, 'c2'); near(c[2], 40, 1e-6, 'c4');
    const two = fitEven([0.1, -0.1, 0.2], [5, 5, 6], 1);
    near(two[0], 5 - 1 / 3, 1e-12, 'two distinct heights: linear in u');
    assert.ok(Number.isNaN(fitEven([], [], 1)[0]));
});

test('ideal thin lens (stub tracer): F, H and f from the asymptotes are exact, signs per DiChio', async () => {
    const f = 7, xs = -20, xe = 25;   // thin lens of focal length f at x = 0
    const traceFn = async (parts, opts) => {
        const n = parts.length / P_STRIDE, S = new Float64Array(n * S_STRIDE);
        for (let i = 0; i < n; i++) {
            const o = i * P_STRIDE, s = i * S_STRIDE, T = parts[o + P_Y], right = parts[o + P_WX] > 0;
            const slope = right ? -T / f : T / f;           // after the lens (direction of travel along ∓x)
            const xEnd = right ? opts.planes[0].at : opts.planes[1].at;
            const y = T + slope * xEnd;                      // slope = dy/dx on either side
            S[s + S_ID] = parts[o + P_ID]; S[s + S_STATUS] = STATUS.DETECTED; S[s + S_WHERE] = right ? 0 : 1;
            S[s + S_X] = xEnd; S[s + S_Y] = y; S[s + S_VX] = right ? 1 : -1; S[s + S_VY] = right ? slope : -slope;
        }
        return { n, summary: S, crossings: new Float64Array(0), nCross: 0 };
    };
    const r = await lensProperties({ refX: 0, D: 2, xStart: xs, xEnd: xe, mass: 100, charge: 1, keLeft: 1000, relativistic: false }, null, traceFn);
    near(r.F2, f / 2, 1e-12, 'F2'); near(r.H2, 0, 1e-12, 'H2'); near(r.f2, f / 2, 1e-12, 'f2');
    near(r.F1, -f / 2, 1e-12, 'F1'); near(r.H1, 0, 1e-12, 'H1'); near(r.f1, -f / 2, 1e-12, 'f1');
    near(r.identity, 0, 1e-12, 'identity (same energy both sides)');
    assert.equal(r.raw.T.length, LENS_HEIGHTS.length);
    assert.deepEqual(r.warnings, []);
});

// ---- analytic two-tube field: tabulated S^(n), n = 0..8, Taylor-evaluated (error ~1e-11)
function besselJ(n, x, N = 1200) { const h = Math.PI / N; let s = 0.5 * (1 + Math.cos(n * Math.PI)); for (let i = 1; i < N; i++) { const t = i * h; s += Math.cos(n * t - x * Math.sin(t)); } return s * h / Math.PI; }
function besselI0(x) { let s = 1, t = 1; for (let k = 1; k < 500; k++) { t *= (x / 2) * (x / 2) / (k * k); s += t; if (t < 1e-17 * s) break; } return s; }
const NDER = 9, DZ = 0.0025, ZMAX = 10, NZ = Math.round(ZMAX / DZ);
const TAB = (() => {
    const zeros = [], j1 = [];
    for (let n = 1; n <= 140; n++) { const b = (n - 0.25) * Math.PI; let x = b + 1 / (8 * b) - 124 / (3 * (8 * b) ** 3); for (let it = 0; it < 6; it++) x += besselJ(0, x) / besselJ(1, x); zeros.push(x); j1.push(besselJ(1, x)); }
    const NK = 8000, hk = 40 / NK, w = [], kk = [];
    for (let i = 0; i <= NK; i++) { kk.push(i * hk); w.push(hk / 3 * (i === 0 || i === NK ? 1 : (i % 2 ? 4 : 2)) / besselI0(i * hk)); }
    const tab = Array.from({ length: NDER }, () => new Float64Array(NZ + 1));
    for (let i = 0; i <= NZ; i++) {
        const z = i * DZ;
        if (z >= 0.25) {
            let s0 = 1;
            const acc = new Float64Array(NDER);
            for (let m = 0; m < zeros.length; m++) {
                const j = zeros[m], e = Math.exp(-j * z) / j1[m];
                s0 -= e / j;
                let p = 1;
                for (let n = 1; n < NDER; n++) { acc[n] += (n % 2 ? 1 : -1) * p * e; p *= j; }
            }
            tab[0][i] = s0;
            for (let n = 1; n < NDER; n++) tab[n][i] = acc[n];
        } else {
            const acc = new Float64Array(NDER);
            for (let q = 0; q <= NK; q++) {
                const k = kk[q], u = k * z, c = Math.cos(u), s = Math.sin(u);
                acc[0] += w[q] * (k === 0 ? z : s / k);
                let p = 1;
                for (let n = 1; n < NDER; n++) { const d = [c, -s, -c, s][(n - 1) % 4]; acc[n] += w[q] * p * d; p *= k; }
            }
            tab[0][i] = 0.5 + acc[0] / Math.PI;
            for (let n = 1; n < NDER; n++) tab[n][i] = acc[n] / Math.PI;
        }
    }
    return tab;
})();
/** S^(n)(z) for n ≤ 5 by a cubic Taylor step from the nearest table node; S(−z) = 1 − S(z). */
function Sder(n, z) {
    const neg = z < 0, a = neg ? -z : z;
    const i = Math.min(NZ, Math.round(a / DZ)), d = a - i * DZ;
    let v = TAB[n][i] + TAB[n + 1][i] * d + TAB[n + 2][i] * d * d / 2 + TAB[n + 3][i] * d * d * d / 6;
    if (n === 0) return neg ? 1 - v : v;
    return neg && n % 2 === 0 ? -v : v;   // odd derivatives are even functions of z
}
function twoTubeModel(ratio, KE = 1000) {
    const dV = (ratio - 1) * KE;        // kinetic potential V(x) = KE + dV·S(x); electric potential φ = KE − V for q = +1
    const D = (n, x) => dV * Sder(n, x);
    const phi = (x, r) => -(D(0, x) - r * r * D(2, x) / 4 + r ** 4 * D(4, x) / 64);
    const grad = (x, r, out) => {
        out[0] = -(D(1, x) - r * r * D(3, x) / 4 + r ** 4 * D(5, x) / 64);
        out[1] = -(-r * D(2, x) / 2 + r ** 3 * D(4, x) / 16);
        return out;
    };
    const h = 1 / 64;
    const grid = analyticGrid({ phi, grad, bounds: { x0: -8, x1: 8, y0: 0, y1: 1 }, h, cyl: true });
    return createFieldModel({ resolved: { domain: { type: 'cyl2d', h, cell: h, x: [-8, 8], y: [0, 1], nx: 1025, ny: 65, mirror: {} } }, grid });
}

test('the tabulated analytic potential reproduces S and its derivatives (consistency of the test field)', () => {
    near(Sder(0, 0.1) + Sder(0, -0.1), 1, 1e-12, 'odd symmetry');
    for (const z of [-1.3, -0.2, 0.12, 0.6, 2.2]) {
        const e = 1e-5;
        near((Sder(0, z + e) - Sder(0, z - e)) / (2 * e), Sder(1, z), 1e-7, `S′ at ${z}`);
        near((Sder(1, z + e) - Sder(1, z - e)) / (2 * e), Sder(2, z), 1e-6, `S″ at ${z}`);
    }
});

for (const ratio of [5, 10]) {
    test(`lensProperties on the analytic zero-gap two-tube field reproduces twoTubeExact to 1e-5 (V2/V1 = ${ratio})`, async () => {
        const model = twoTubeModel(ratio);
        const traceFn = async (parts, opts) => traceParticles(model, parts, opts);
        const r = await lensProperties({ refX: 0, D: 2, xStart: -7.9, xEnd: 7.9, mass: 100, charge: 1, keLeft: 1000, relativistic: false }, model, traceFn);
        const ex = twoTubeExact(ratio);
        for (const k of ['F1', 'F2', 'f1', 'f2', 'H1', 'H2']) near(r[k], ex[k], 1e-5 * Math.max(1, Math.abs(ex[k])), k);
        near(r.identity, 0, 1e-5, 'identity');
        near(r.raw.keRight, 1000 * ratio, 1e-7 * 1000 * ratio, 'kinetic energy on the right (the ends are field-free to ~1e-8)');
        assert.deepEqual(r.warnings, []);
        assert.ok(r.a2 < 0, 'spherical aberration pulls F2 toward the lens');
    });
}

test('imageOf: image position and magnification agree with Newton\'s equation from the cardinal elements', async () => {
    const ratio = 5, model = twoTubeModel(ratio);
    const traceFn = async (parts, opts) => traceParticles(model, parts, opts);
    const ex = twoTubeExact(ratio);
    const xo = -7.9;
    const im = await imageOf({ objectX: xo, mass: 100, charge: 1, ke: 1000, angles: [-0.25, 0.25, -0.5, 0.5], xEnd: 7.9, relativistic: false }, traceFn);
    // Newton (units of D from the gap): (xo − F1)(xi − F2) = f1·f2; M = −f1/(xo − F1)
    const xoD = xo / 2, xiD = ex.F2 + ex.f1 * ex.f2 / (xoD - ex.F1), M = -ex.f1 / (xoD - ex.F1);
    near(im.imageX, 2 * xiD, 2e-3, 'image position (mm)');
    near(im.magnification, M, 1e-4, 'magnification');
    assert.ok(im.rms < 1e-3, `rms at the image ${im.rms}`);
    assert.equal(im.rays.filter((x) => x.lost).length, 0);
});

test('particleRow builds proper velocities for the requested direction and energy', () => {
    const out = new Float64Array(P_STRIDE);
    particleRow(out, 0, { id: 3, mass: 100, charge: 1, ke: 1000, p: [1, 2, 3], d: [0, 2, 0], relativistic: false });
    near(out[P_WY], Math.sqrt(2 * 96.48533202185 * 1000 / 100), 1e-9, 'speed');
    near(out[P_WX], 0, 0, 'direction'); near(out[P_X], 1, 0, 'x');
});
