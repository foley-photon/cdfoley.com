// WP1 field (spec 3.6, 5.2, 7.2 acceptance 5 and 6): S1 and S2 at the quick tolerances through evalChannels,
// S10 boundary order, S3 and S4 axial potentials at R = 40 cells; quadratic potentials exact in REGULAR
// cells, linear potentials exact in BOUNDARY cells next to meshes and faces, E_rho/rho as rho -> 0, and a
// randomised check that the same-side rule never blends fields across an electrode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileGeometry } from '../../beta/ion-optics/js/engine/geometry.js';
import { makeGrid, rasterize, CELL } from '../../beta/ion-optics/js/engine/raster.js';
import { buildHierarchy } from '../../beta/ion-optics/js/engine/operator.js';
import { solveBasis } from '../../beta/ion-optics/js/engine/solve.js';
import { combine, createFieldGrid } from '../../beta/ion-optics/js/engine/field.js';

function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function solvedField(res, volts, interp = 'cubic', tol = 1e-12) {
    const geo = compileGeometry(res);
    const H = buildHierarchy(geo, res, {});
    const bases = new Map();
    for (let k = 1; k < res.electrodes.length; k++) {
        const { phi, stats } = solveBasis(H, k, { tol });
        assert.ok(stats.converged);
        bases.set(k, phi);
    }
    const phi = combine(bases, volts, H[0].N);
    const fg = createFieldGrid(H[0].raster, geo, { interp });
    fg.setChannels([phi], [Float64Array.from(volts)]);
    return { fg, geo, H, phi, bases };
}

test('S1 coax (quick, h 0.2): potential within 3e-3 V and |E(15)| within 5e-5 through evalChannels', () => {
    const h = 0.2, n = 111;
    const { fg } = solvedField({ domain: { type: 'planar2d', h, x: [0, 22], y: [0, 22], nx: n, ny: n, edges: { xmin: { bc: 'neumann' }, ymin: { bc: 'neumann' } }, mirror: { x: true, y: true } },
        electrodes: [{ id: 'gnd' }, { id: 'in' }], shapes: [{ type: 'circle', electrode: 'in', cx: 0, cy: 0, r: 10 }, { type: 'annulus', electrode: 'gnd', cx: 0, cy: 0, rIn: 20, rOut: 32 }] }, [0, 100]);
    const out = new Float64Array(3);
    const ref = { 12.5: 67.807191, 15: 41.503750, 17.5: 19.264508 };
    let dv = 0, de = 0;
    for (const r of [12.5, 15, 17.5]) for (const a of [0, 30, 45]) {
        const t = a * Math.PI / 180;
        fg.evalChannels(r * Math.cos(t), r * Math.sin(t), out);
        dv = Math.max(dv, Math.abs(out[0] - ref[r]));
        if (r === 15) de = Math.max(de, Math.abs(Math.hypot(out[1], out[2]) / 9.617967 - 1));
    }
    assert.ok(dv <= 3e-3, `max |dV| ${dv}`);
    assert.ok(de <= 5e-5, `|E| rel ${de}`);
});

test('S2 concentric spheres (quick, h 1): potential within 0.04 V and |E(100)| within 5e-5', () => {
    const h = 1, n = 126, V2 = -1000 / 3;
    const { fg } = solvedField({ domain: { type: 'cyl2d', h, x: [0, 125], y: [0, 125], nx: n, ny: n, edges: { xmin: { bc: 'neumann' }, xmax: { bc: 'dirichlet', electrode: 'out' }, ymax: { bc: 'dirichlet', electrode: 'out' } }, mirror: { x: true } },
        electrodes: [{ id: 'gnd' }, { id: 'in' }, { id: 'out' }], shapes: [{ type: 'circle', electrode: 'in', cx: 0, cy: 0, r: 80 }, { type: 'annulus', electrode: 'out', cx: 0, cy: 0, rIn: 120, rOut: 180 }] }, [0, 500, V2]);
    const out = new Float64Array(3);
    let dv = 0, de = 0;
    for (const r of [90, 100, 110]) for (const a of [10, 45, 80]) {
        const t = a * Math.PI / 180;
        fg.evalChannels(r * Math.cos(t), r * Math.sin(t), out);
        dv = Math.max(dv, Math.abs(out[0] - (200000 / r - 2000)));
        if (r === 100) de = Math.max(de, Math.abs(Math.hypot(out[1], out[2]) / 20 - 1));
    }
    assert.ok(dv <= 0.04, `max |dV| ${dv}`);
    assert.ok(de <= 5e-5, `|E| rel ${de}`);
});

function sphereError(a, boundary) {
    const h = 80 / a, L = 128, n = Math.round(L / h) + 1;
    const res = { domain: { type: 'cyl2d', h, x: [0, L], y: [0, L], nx: n, ny: n, edges: { xmin: { bc: 'neumann' }, xmax: { bc: 'dirichlet', electrode: 'out' }, ymax: { bc: 'dirichlet', electrode: 'out' } }, mirror: { x: true } },
        electrodes: [{ id: 'gnd' }, { id: 'in' }, { id: 'out' }], shapes: [{ type: 'circle', electrode: 'in', cx: 0, cy: 0, r: 80 }, { type: 'annulus', electrode: 'out', cx: 0, cy: 0, rIn: 120, rOut: 200 }],
        solver: { boundary } };
    const geo = compileGeometry(res);
    const H = buildHierarchy(geo, res, { boundary });
    const V = [0, 500, -1000 / 3];
    const phi = combine(new Map([[1, solveBasis(H, 1, { tol: 1e-12 }).phi], [2, solveBasis(H, 2, { tol: 1e-12 }).phi]]), V, H[0].N);
    let e = 0;
    for (let k = 0; k < phi.length; k++) {
        if (H[0].mask[k] === 1) continue;
        const i = k % n, j = (k - i) / n, r = Math.hypot(i * h, j * h);
        if (r <= 80 || r >= 120) continue;
        e = Math.max(e, Math.abs(phi[k] - (200000 / r - 2000)));
    }
    return e;
}
test('S10 Shortley-Weller order on spheres, a = 20, 40, 80 cells: p in [1.8, 2.3] (staircase as info)', () => {
    const e20 = sphereError(20, 'subgrid'), e40 = sphereError(40, 'subgrid'), e80 = sphereError(80, 'subgrid');
    const p1 = Math.log2(e20 / e40), p2 = Math.log2(e40 / e80);
    assert.ok(p1 >= 1.8 && p1 <= 2.3, `order 20->40: ${p1} (${e20}, ${e40})`);
    assert.ok(p2 >= 1.8 && p2 <= 2.3, `order 40->80: ${p2} (${e40}, ${e80})`);
    const s20 = sphereError(20, 'staircase'), s40 = sphereError(40, 'staircase');
    assert.ok(s20 > 10 * e20 && s40 > 10 * e40, `staircase is far worse (info: ${s20}, ${s40}, order ${Math.log2(s20 / s40).toFixed(2)})`);
});

// zero-gap two-tube axial potential: S(zeta) = 1 - sum exp(-j_n zeta) / (j_n J1(j_n)), zeta = z/R >= 0
function besselJ(n, x) {   // trapezoid rule on Bessel's integral (spectrally accurate for this periodic integrand)
    const M = Math.max(64, Math.ceil(x) + 64);
    let s = 0;
    for (let k = 0; k <= M; k++) { const t = Math.PI * k / M, w = (k === 0 || k === M) ? 0.5 : 1; s += w * Math.cos(n * t - x * Math.sin(t)); }
    return s / M;
}
const J0ZEROS = (() => {
    const z = [];
    for (let n = 1; n <= 140; n++) {
        let x = (n - 0.25) * Math.PI + 1 / (8 * (n - 0.25) * Math.PI);
        for (let it = 0; it < 30; it++) { const dx = besselJ(0, x) / besselJ(1, x); x += dx; if (Math.abs(dx) < 1e-15 * x) break; }
        z.push([x, besselJ(1, x)]);
    }
    return z;
})();
const twoTube = (zeta) => { let s = 0; for (const [j, J1] of J0ZEROS) s += Math.exp(-j * Math.abs(zeta)) / (j * J1); return zeta >= 0 ? 1 - s : s; };
// the same function from the integral form S = 1/2 + (1/pi) int_0^inf sin(k zeta) / (k I0(k)) dk (Simpson, k <= 40)
function besselI0(x) { let t = 1, s = 1; for (let m = 1; m < 200; m++) { t *= (x / (2 * m)) * (x / (2 * m)); s += t; if (t < 1e-17 * s) break; } return s; }
function twoTubeIntegral(zeta) {
    const K = 40, M = 8000, dk = K / M;
    const f = (k) => (k === 0 ? zeta : Math.sin(k * zeta) / (k * besselI0(k)));
    let s = f(0) + f(K);
    for (let i = 1; i < M; i++) s += (i % 2 ? 4 : 2) * f(i * dk);
    return 0.5 + s * dk / 3 / Math.PI;
}

test('S3 two-tube, zero gap, R = 40 cells: axial potential within 1.5e-4 of the Bessel series', () => {
    for (const z of [0.3, 0.6, 1.0, 2.0]) assert.ok(Math.abs(twoTube(z) - twoTubeIntegral(z)) < 1e-9, `series and integral agree at ${z}`);
    const n = 40, h = 1 / n;
    const res = { domain: { type: 'cyl2d', h, x: [-8, 8], y: [0, 1], nx: 641, ny: 41,
        edges: { xmin: { bc: 'dirichlet', electrode: 'A' }, xmax: { bc: 'dirichlet', electrode: 'B' }, ymin: { bc: 'axis' }, ymax: { bc: 'profile', segments: [{ from: -8, to: 0, electrode: 'A' }, { from: 0, to: 8, electrode: 'B' }] } } },
        electrodes: [{ id: 'gnd' }, { id: 'A' }, { id: 'B' }], shapes: [] };
    const { fg } = solvedField(res, [0, 0, 1]);
    const out = new Float64Array(3);
    let emax = 0;
    for (const zD of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.5, 2.0]) for (const s of [1, -1]) {
        const z = s * zD * 2;
        fg.evalChannels(z, 0, out);
        emax = Math.max(emax, Math.abs(out[0] - twoTube(z)));
    }
    assert.ok(emax <= 1.5e-4, `max axial error ${emax}`);
});

test('S5 observed order, zero-gap einzel (A/D 0.5, ratio 9), R = 20 and 40 cells: p in [1.8, 2.3]', () => {
    const exact = (z) => 1 + 8 * (twoTube(z + 0.5) - twoTube(z - 0.5));
    const err = (n) => {
        const h = 1 / n, nx = 16 * n + 1;
        const res = { domain: { type: 'cyl2d', h, x: [-8, 8], y: [0, 1], nx, ny: n + 1,
            edges: { xmin: { bc: 'dirichlet', electrode: 'o' }, xmax: { bc: 'dirichlet', electrode: 'o' }, ymin: { bc: 'axis' },
                ymax: { bc: 'profile', segments: [{ from: -8, to: -0.5, electrode: 'o' }, { from: -0.5, to: 0.5, electrode: 'c' }, { from: 0.5, to: 8, electrode: 'o' }] } } },
            electrodes: [{ id: 'gnd' }, { id: 'o' }, { id: 'c' }], shapes: [] };
        const { phi } = solvedField(res, [0, 1, 9]);
        let e = 0;
        for (let i = 0; i < nx; i++) {
            const z = -8 + i * h;
            if (Math.abs(Math.abs(z) - 0.5) < 0.06) continue;
            e = Math.max(e, Math.abs(phi[i] - exact(z)));
        }
        return e;
    };
    const e20 = err(20), e40 = err(40), p = Math.log2(e20 / e40);
    assert.ok(p >= 1.8 && p <= 2.3, `order ${p} (${e20}, ${e40})`);
});

test('S4 two-tube, 0.1D gap, NBS deep-gap geometry, R = 40 cells: within 2e-4 of the published table', () => {
    const n = 40, h = 1 / n;
    const res = { domain: { type: 'cyl2d', h, x: [-7, 7], y: [0, 3.5], nx: 561, ny: 141,
        edges: { xmin: { bc: 'dirichlet', electrode: 'A' }, xmax: { bc: 'dirichlet', electrode: 'B' }, ymin: { bc: 'axis' },
            ymax: { bc: 'profile', segments: [{ from: -7, to: -0.1, electrode: 'A' }, { from: -0.1, to: 0.1, ramp: ['A', 'B'] }, { from: 0.1, to: 7, electrode: 'B' }] } } },
        electrodes: [{ id: 'gnd' }, { id: 'A' }, { id: 'B' }],
        shapes: [{ type: 'box', electrode: 'A', x0: -7, x1: -0.1, y0: 1, y1: 3.5 }, { type: 'box', electrode: 'B', x0: 0.1, x1: 7, y0: 1, y1: 3.5 }] };
    const { fg } = solvedField(res, [0, 0, 1]);
    const NBS = [[0.1, 0.371399], [0.2, 0.259528], [0.3, 0.173079], [0.4, 0.111851], [0.5, 0.070897], [0.6, 0.044436], [0.8, 0.017178], [1.0, 0.006586]];
    const out = new Float64Array(3);
    let emax = 0;
    for (const [zD, ref] of NBS) { fg.evalChannels(-zD * 2, 0, out); emax = Math.max(emax, Math.abs(out[0] - ref)); }
    assert.ok(emax <= 2e-4, `max error ${emax}`);
});

// ---------------------------------------------------------------- synthetic nodal data
function fieldFrom(res, values, cutValues, interp = 'cubic') {
    const geo = compileGeometry(res);
    const r0 = rasterize(geo, makeGrid(res.domain, 0), res, {});
    const g = r0.grid, phi = new Float64Array(g.N);
    for (let k = 0; k < g.N; k++) { const i = k % g.nx, j = (k - i) / g.nx; phi[k] = values(g.x0 + i * g.h, g.y0 + j * g.h, r0.cls[k]); }
    const fg = createFieldGrid(r0, geo, { interp });
    fg.setChannels([phi], [Float64Array.from(cutValues)]);
    return { fg, r0, geo };
}

test('quadratic potentials are exact (1e-12) in REGULAR cells, planar and cylindrical', () => {
    const r = rng(11);
    for (const type of ['planar2d', 'cyl2d']) {
        const cyl = type === 'cyl2d';
        const [a, b, c, d, e, f] = [0.7, -1.3, 2.1, 0.37, -0.81, 0.44];
        const q = cyl ? (x, y) => a + b * x + d * x * x + f * y * y : (x, y) => a + b * x + c * y + d * x * x + e * x * y + f * y * y;
        const qx = cyl ? (x) => b + 2 * d * x : (x, y) => b + 2 * d * x + e * y;
        const qy = cyl ? (x, y) => 2 * f * y : (x, y) => c + e * x + 2 * f * y;
        const res = { domain: { type, h: 0.25, x: [-5, 5], y: cyl ? [0, 5] : [-5, 5], nx: 41, ny: cyl ? 21 : 41, edges: {} },
            electrodes: [{ id: 'gnd' }, { id: 'a' }], shapes: [{ type: 'box', electrode: 'a', x0: 1, x1: 2.5, y0: 1, y1: 2 }] };   // node-aligned: fixed nodes hold q
        for (const interp of ['cubic', 'linear']) {
            const { fg } = fieldFrom(res, (x, y) => q(x, y), [0, 0], interp);
            const out = new Float64Array(3);
            let n = 0, eP = 0, eE = 0;
            for (let s = 0; s < 4000; s++) {
                const x = -5 + 10 * r(), y = cyl ? 5 * r() : -5 + 10 * r();
                if (fg.evalChannels(x, y, out) !== CELL.REGULAR) continue;
                n++;
                eP = Math.max(eP, Math.abs(out[0] - q(x, y)));
                eE = Math.max(eE, Math.abs(out[1] + qx(x, y)), Math.abs(out[2] + qy(x, y)));
            }
            assert.ok(n > 1000);
            if (interp === 'cubic') assert.ok(eP <= 1e-12, `${type} ${interp}: potential error ${eP}`);
            assert.ok(eE <= 1e-12, `${type} ${interp}: field error ${eE}`);
        }
    }
});

function sideField(res, Vm, side, gA, gB, sd) {
    // potential Vm + g * signed distance, with slope gA on side A (sd > 0) and gB on side B
    return fieldFrom(res, (x, y, c) => (c >= 0 ? Vm : Vm + (sd(x, y) > 0 ? gA : gB) * sd(x, y)), [0, Vm], side);
}
test('linear potentials are exact in BOUNDARY cells next to a node-aligned mesh, an off-node mesh and planar faces', () => {
    const r = rng(5);
    const base = (shapes) => ({ domain: { type: 'planar2d', h: 0.5, x: [-10, 10], y: [-10, 10], nx: 41, ny: 41, edges: { xmin: { bc: 'neumann' }, xmax: { bc: 'neumann' }, ymin: { bc: 'neumann' }, ymax: { bc: 'neumann' } } },
        electrodes: [{ id: 'gnd' }, { id: 'm', kind: 'grid' }], shapes });
    const cases = [
        ['node-aligned mesh', base([{ type: 'polyline', electrode: 'm', points: [[-12, 0], [12, 0]] }]), (x, y) => y, true],
        ['off-node mesh', base([{ type: 'polyline', electrode: 'm', points: [[-12, 0.37], [12, 0.37]] }]), (x, y) => y - 0.37, true],
        ['off-node face', base([{ type: 'box', electrode: 'm', x0: 1.13, x1: 12, y0: -12, y1: 12 }]), (x) => 1.13 - x, false],
        ['oblique face', base([{ type: 'polygon', electrode: 'm', points: [[2, -12], [12, -12], [12, 12], [-2.4, 12]] }]), (x, y) => { const nx = 24, ny = 4.4, L = Math.hypot(nx, ny); return ((x - 2) * nx + (y + 12) * ny) / -L; }, false],
    ];
    for (const [name, res, sd, twoSided] of cases) {
        for (const interp of ['cubic', 'linear']) {
            const gA = 37.5, gB = -1234.5, Vm = 100;
            const { fg } = sideField(res, Vm, interp, gA, gB, sd);
            const out = new Float64Array(3), d = 1e-6;
            let n = 0, eP = 0, eE = 0;
            for (let s = 0; s < 30000; s++) {
                const x = -8 + 16 * r(), y = -8 + 16 * r();
                const dist = sd(x, y);
                if (Math.abs(dist) > 1.5 || Math.abs(dist) < 1e-6 || (!twoSided && dist < 0)) continue;   // faces: free side only
                if (fg.evalChannels(x, y, out) !== CELL.BOUNDARY) continue;
                const g = dist > 0 ? gA : gB;
                const ex = -g * (sd(x + d, y) - sd(x - d, y)) / (2 * d), ey = -g * (sd(x, y + d) - sd(x, y - d)) / (2 * d);
                n++;
                eP = Math.max(eP, Math.abs(out[0] - (Vm + g * dist)) / Math.abs(gB));
                eE = Math.max(eE, Math.hypot(out[1] - ex, out[2] - ey) / Math.abs(gB));
            }
            assert.ok(n > 150, `${name}: samples ${n}`);
            assert.ok(eP <= 1e-9, `${name} ${interp}: potential error ${eP} (relative to the larger slope)`);
            assert.ok(eE <= 1e-7, `${name} ${interp}: field error ${eE}`);
        }
    }
});

test('E_rho/rho is correct as rho -> 0 (cylindrical, both modes)', () => {
    const res = { domain: { type: 'cyl2d', h: 0.5, x: [-5, 5], y: [0, 5], nx: 21, ny: 11, edges: {} }, electrodes: [{ id: 'gnd' }], shapes: [] };
    for (const interp of ['cubic', 'linear']) {
        const { fg } = fieldFrom(res, (x, y) => x * x - y * y / 2, [0], interp);
        const out = new Float64Array(3);
        for (const rho of [0.3, 1e-2, 1e-4, 1e-7, 1e-10, 1e-13]) for (const x of [-1.7, 0.33, 2.25]) {
            fg.evalChannels(x, rho, out);
            assert.ok(Math.abs(out[2] / rho - 1) <= 1e-9, `${interp}: E_rho/rho at rho = ${rho}: ${out[2] / rho}`);
            assert.ok(Math.abs(out[1] + 2 * x) <= 1e-9);
        }
        fg.evalChannels(0.4, 0, out);
        assert.ok(out[2] === 0, 'E_rho = 0 on the axis');
    }
});

test('the same-side rule never blends fields across an electrode (random oblique meshes and thin plates)', () => {
    const r = rng(2024);
    let checked = 0;
    for (let trial = 0; trial < 40; trial++) {
        const ang = Math.PI * r(), cx = -2 + 4 * r(), cy = -2 + 4 * r(), ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux;
        const thick = r() < 0.5 ? 0 : 0.05 + 0.4 * r();
        const p0 = [cx - 30 * ux, cy - 30 * uy], p1 = [cx + 30 * ux, cy + 30 * uy];
        const shape = thick === 0 ? { type: 'polyline', electrode: 'm', points: [p0, p1] }
            : { type: 'polygon', electrode: 'm', points: [[p0[0] - thick / 2 * nx, p0[1] - thick / 2 * ny], [p1[0] - thick / 2 * nx, p1[1] - thick / 2 * ny], [p1[0] + thick / 2 * nx, p1[1] + thick / 2 * ny], [p0[0] + thick / 2 * nx, p0[1] + thick / 2 * ny]] };
        const res = { domain: { type: 'planar2d', h: 0.5, x: [-10, 10], y: [-10, 10], nx: 41, ny: 41, edges: { xmin: { bc: 'neumann' }, xmax: { bc: 'neumann' }, ymin: { bc: 'neumann' }, ymax: { bc: 'neumann' } } },
            electrodes: [{ id: 'gnd' }, { id: 'm' }], shapes: [shape] };
        const sd = (x, y) => { const s = (x - cx) * nx + (y - cy) * ny; return s > 0 ? s - thick / 2 : s + thick / 2; };
        const gA = 3 + 10 * r(), gB = 1e6, Vm = 50;
        const { fg } = fieldFrom(res, (x, y, c) => (c >= 0 ? Vm : Vm + (((x - cx) * nx + (y - cy) * ny) > 0 ? gA : gB) * sd(x, y)), [0, Vm], r() < 0.5 ? 'cubic' : 'linear');
        const out = new Float64Array(3);
        for (let s = 0; s < 1500; s++) {
            const x = -8 + 16 * r(), y = -8 + 16 * r(), dist = sd(x, y);
            if (!(dist > 1e-6 && dist < 1.2) || ((x - cx) * nx + (y - cy) * ny) <= 0) continue;
            if (fg.evalChannels(x, y, out) !== CELL.BOUNDARY) continue;
            checked++;
            assert.ok(Math.abs(out[0] - (Vm + gA * dist)) <= 1e-8 * gB, `trial ${trial}: potential ${out[0]} vs ${Vm + gA * dist}`);
            assert.ok(Math.hypot(out[1] + gA * nx, out[2] + gA * ny) <= 1e-6 * gB, `trial ${trial}: field (${out[1]}, ${out[2]})`);
        }
    }
    assert.ok(checked > 1000, `checked ${checked}`);
});

test('SOLID cells, outside points, channels and combine order', () => {
    const res = { domain: { type: 'planar2d', h: 0.5, x: [-5, 5], y: [-5, 5], nx: 21, ny: 21, edges: {} }, electrodes: [{ id: 'gnd' }, { id: 'a' }, { id: 'b' }],
        shapes: [{ type: 'box', electrode: 'a', x0: -3, x1: -1, y0: -3, y1: 3 }, { type: 'circle', electrode: 'b', cx: 2.6, cy: 0.3, r: 1.1 }] };
    const geo = compileGeometry(res);
    const H = buildHierarchy(geo, res, {});
    const b1 = solveBasis(H, 1).phi, b2 = solveBasis(H, 2).phi;
    const bases = new Map([[2, b2], [1, b1]]);
    const V = [0, 120, -45], W = [0, 3, 7];
    const p1 = combine(bases, V, H[0].N), p2 = combine(bases, W, H[0].N);
    for (let k = 0; k < p1.length; k++) assert.equal(p1[k], 0 + V[1] * b1[k] + V[2] * b2[k]);   // k ascending, bitwise
    assert.deepEqual([...combine(bases, new Map([[1, 120], [2, -45]]), H[0].N)], [...p1]);
    const fg2 = createFieldGrid(H[0].raster, geo, { interp: 'cubic' });
    fg2.setChannels([p1, p2], [Float64Array.from(V), Float64Array.from(W)]);
    const fa = createFieldGrid(H[0].raster, geo, { interp: 'cubic' }), fb = createFieldGrid(H[0].raster, geo, { interp: 'cubic' });
    fa.setChannels([p1], [Float64Array.from(V)]); fb.setChannels([p2], [Float64Array.from(W)]);
    const o2 = new Float64Array(6), oa = new Float64Array(3), ob = new Float64Array(3);
    const r = rng(3);
    for (let s = 0; s < 2000; s++) {
        const x = -5 + 10 * r(), y = -5 + 10 * r();
        const t = fg2.evalChannels(x, y, o2);
        assert.equal(fa.evalChannels(x, y, oa), t);
        fb.evalChannels(x, y, ob);
        for (let q = 0; q < 3; q++) { assert.equal(o2[q], oa[q]); assert.equal(o2[3 + q], ob[q]); }
        if (t === CELL.SOLID) { const e = geo.classify(x, y); assert.ok(o2[1] === 0 && o2[2] === 0 && o2[4] === 0 && o2[5] === 0); assert.equal(o2[0], V[e]); assert.equal(o2[3], W[e]); }
    }
    assert.equal(fg2.evalChannels(-2, 0, o2), CELL.SOLID);
    assert.equal(fg2.evalChannels(6, 0, o2), CELL.EXTERIOR);
    assert.ok(Number.isNaN(o2[0]) && Number.isNaN(o2[3]) && o2[1] === 0 && o2[5] === 0);
    assert.equal(fg2.nChannels, 2);
    const nd = fg2.nodal(10 * 21 + 18);
    assert.equal(nd.phi, p1[10 * 21 + 18]);
});
