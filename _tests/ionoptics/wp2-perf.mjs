// WP2 performance check (spec §6, §7.3(8)): DP45 steps per second through the FieldModel and tracer with
//   (1) a uniform ideal field (no grid)                 target ≥ 1.5 M steps/s
//   (2) a one-channel bicubic Hermite grid (REGULAR)    target ≥ 0.4 M steps/s
//   (3) a one-channel bilinear nodal-E grid             target ≥ 1.0 M steps/s
// The grids are local formula-free FieldGrid implementations with the same per-cell arithmetic as the
// production evaluator (field.js, WP1), so this measures the particle engine. When WP1's field.js is
// importable the script also reports the production FieldGrid on an electrode-free domain.
// Usage: node _tests/ionoptics/wp2-perf.mjs [--quick]   (prints a table; exit code 1 if a target is missed)
import { createFieldModel } from '../../beta/ion-optics/js/engine/fieldmodel.js';
import { traceParticles } from '../../beta/ion-optics/js/engine/trace.js';
import * as L from '../../beta/ion-optics/js/engine/layout.js';
import { speedFromKE } from '../../beta/ion-optics/js/engine/constants.js';

const quick = process.argv.includes('--quick');
const NP = quick ? 120 : 300;

// harmonic test potential φ = A sin(kx) cosh(ky)
const A = 50, K = 2 * Math.PI / 100;
const phiF = (x, y) => A * Math.sin(K * x) * Math.cosh(K * y);
const gx = (x, y) => A * K * Math.cos(K * x) * Math.cosh(K * y);
const gy = (x, y) => A * K * Math.sin(K * x) * Math.sinh(K * y);
const gxy = (x, y) => A * K * K * Math.cos(K * x) * Math.sinh(K * y);

const X0 = 0, X1 = 400, Y0 = -50, Y1 = 50, H = 0.5;
const NX = Math.round((X1 - X0) / H) + 1, NY = Math.round((Y1 - Y0) / H) + 1;

/** One-channel FieldGrid over all-REGULAR cells. mode 'cubic' (Hermite of nodal φ, φx, φy, φxy) or 'linear' (bilinear nodal E). */
function localGrid(mode) {
    const N = NX * NY, D = new Float64Array(4 * N);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
        const x = X0 + i * H, y = Y0 + j * H, o = 4 * (j * NX + i);
        if (mode === 'cubic') { D[o] = phiF(x, y); D[o + 1] = H * gx(x, y); D[o + 2] = H * gy(x, y); D[o + 3] = H * H * gxy(x, y); }
        else { D[o] = phiF(x, y); D[o + 1] = -gx(x, y); D[o + 2] = -gy(x, y); }
    }
    const ih = 1 / H;
    function evalChannels(x, y, out) {
        const fx = (x - X0) * ih, fy = (y - Y0) * ih;
        if (!(fx >= 0 && fx <= NX - 1 && fy >= 0 && fy <= NY - 1)) { out[0] = NaN; out[1] = 0; out[2] = 0; return 3; }
        let i = Math.floor(fx), j = Math.floor(fy);
        if (i > NX - 2) i = NX - 2; if (j > NY - 2) j = NY - 2;
        const s = fx - i, t = fy - j, k = j * NX + i;
        const o00 = 4 * k, o10 = o00 + 4, o01 = o00 + 4 * NX, o11 = o01 + 4;
        if (mode === 'linear') {
            const w00 = (1 - s) * (1 - t), w10 = s * (1 - t), w01 = (1 - s) * t, w11 = s * t;
            out[0] = w00 * D[o00] + w10 * D[o10] + w01 * D[o01] + w11 * D[o11];
            out[1] = w00 * D[o00 + 1] + w10 * D[o10 + 1] + w01 * D[o01 + 1] + w11 * D[o11 + 1];
            out[2] = w00 * D[o00 + 2] + w10 * D[o10 + 2] + w01 * D[o01 + 2] + w11 * D[o11 + 2];
            return 0;
        }
        const s2 = s * s, s3 = s2 * s, t2 = t * t, t3 = t2 * t;
        const a0 = 2 * s3 - 3 * s2 + 1, a1 = -2 * s3 + 3 * s2, b0 = s3 - 2 * s2 + s, b1 = s3 - s2;
        const da0 = 6 * s2 - 6 * s, da1 = -da0, db0 = 3 * s2 - 4 * s + 1, db1 = 3 * s2 - 2 * s;
        const c0 = 2 * t3 - 3 * t2 + 1, c1 = -2 * t3 + 3 * t2, e0 = t3 - 2 * t2 + t, e1 = t3 - t2;
        const dc0 = 6 * t2 - 6 * t, dc1 = -dc0, de0 = 3 * t2 - 4 * t + 1, de1 = 3 * t2 - 2 * t;
        const f00 = D[o00], X00 = D[o00 + 1], Y00 = D[o00 + 2], Z00 = D[o00 + 3];
        const f10 = D[o10], X10 = D[o10 + 1], Y10 = D[o10 + 2], Z10 = D[o10 + 3];
        const f01 = D[o01], X01 = D[o01 + 1], Y01 = D[o01 + 2], Z01 = D[o01 + 3];
        const f11 = D[o11], X11 = D[o11 + 1], Y11 = D[o11 + 2], Z11 = D[o11 + 3];
        // collapse along s first
        const P0 = a0 * f00 + b0 * X00 + a1 * f10 + b1 * X10, P1 = a0 * f01 + b0 * X01 + a1 * f11 + b1 * X11;
        const Q0 = a0 * Y00 + b0 * Z00 + a1 * Y10 + b1 * Z10, Q1 = a0 * Y01 + b0 * Z01 + a1 * Y11 + b1 * Z11;
        const dP0 = da0 * f00 + db0 * X00 + da1 * f10 + db1 * X10, dP1 = da0 * f01 + db0 * X01 + da1 * f11 + db1 * X11;
        const dQ0 = da0 * Y00 + db0 * Z00 + da1 * Y10 + db1 * Z10, dQ1 = da0 * Y01 + db0 * Z01 + da1 * Y11 + db1 * Z11;
        out[0] = c0 * P0 + e0 * Q0 + c1 * P1 + e1 * Q1;
        out[1] = -(c0 * dP0 + e0 * dQ0 + c1 * dP1 + e1 * dQ1) * ih;
        out[2] = -(dc0 * P0 + de0 * Q0 + dc1 * P1 + de1 * Q1) * ih;
        return 0;
    }
    return {
        interp: mode, cyl: false, nx: NX, ny: NY, h: H, x0: X0, y0: Y0, bounds: { x0: X0, x1: X1, y0: Y0, y1: Y1 }, nChannels: 1,
        setChannels() {}, evalChannels, cellTypeAt: () => 0, nearAt: () => 0, nodal: () => null, bytes: () => D.byteLength,
    };
}

function particles(n) {
    const P = new Float64Array(n * L.P_STRIDE), v = speedFromKE(1000, 100, true) / Math.sqrt(1 - (speedFromKE(1000, 100, true) / 299792.458) ** 2);
    for (let i = 0; i < n; i++) {
        const o = i * L.P_STRIDE;
        P[o + L.P_ID] = i; P[o + L.P_MASS] = 100; P[o + L.P_CHARGE] = 1; P[o + L.P_X] = 1; P[o + L.P_Y] = -20 + 40 * (i + 0.5) / n;
        P[o + L.P_WX] = v; P[o + L.P_KE] = 1000;
    }
    return P;
}

const resolved = (ideal) => ({ domain: { type: 'planar2d', cell: H, h: H, x: [X0, X1], y: [Y0, Y1], nx: NX, ny: NY, mirror: { x: false, y: false } },
    electrodes: [{ id: 'gnd' }], magnets: [], idealFields: ideal });
const opts = { integrator: 'rk45', quality: 'normal', planes: [{ kind: 'x', at: 399, terminate: true }], record: { trajectories: true, maxPoints: 2000 } };

function measure(name, model, target) {
    const P = particles(NP);
    traceParticles(model, particles(20), opts);   // warm-up (JIT)
    let best = 0, steps = 0;
    for (let rep = 0; rep < 3; rep++) {
        const r = traceParticles(model, P, opts);
        let det = 0;
        for (let i = 0; i < NP; i++) if (r.summary[i * L.S_STRIDE + L.S_STATUS] === L.STATUS.DETECTED) det++;
        if (det !== NP) throw new Error(name + ': only ' + det + ' of ' + NP + ' detected');
        steps = r.stats.steps;
        best = Math.max(best, r.stats.steps / r.stats.ms / 1e3);
    }
    const pass = target === null ? null : best >= target;
    console.log(`${name.padEnd(46)} ${best.toFixed(2).padStart(6)} M steps/s   target ${target === null ? ' (info)' : '≥ ' + target.toFixed(1)}   ${steps} steps/run   ${pass === null ? 'info' : pass ? 'PASS' : 'FAIL'}`);
    return pass !== false;
}

console.log(`WP2 tracer performance, Node ${process.version}, ${NP} particles × ~${Math.round(398 / (0.5 * H))} steps (DP45, quality normal, trajectories stored)`);
let ok = true;
ok = measure('uniform ideal field (no grid)', createFieldModel({ resolved: resolved([{ type: 'uniformE', E: [0, 0.4, 0] }]) }), 1.5) && ok;
ok = measure('one-channel Hermite grid (cubic, REGULAR cells)', createFieldModel({ resolved: resolved([]), grid: localGrid('cubic') }), 0.4) && ok;
ok = measure('one-channel bilinear nodal-E grid (linear)', createFieldModel({ resolved: resolved([]), grid: localGrid('linear') }), 1.0) && ok;

// optional: the production FieldGrid (WP1) on an electrode-free domain with the same potential set as boundary values
try {
    const F = await import('../../beta/ion-optics/js/engine/field.js');
    const R = await import('../../beta/ion-optics/js/engine/raster.js');
    const G = await import('../../beta/ion-optics/js/engine/geometry.js');
    const res = { ...resolved([]), shapes: [], sources: [], domain: { ...resolved([]).domain, edges: { xmin: { bc: 'dirichlet', electrode: 'gnd' }, xmax: { bc: 'dirichlet', electrode: 'gnd' }, ymin: { bc: 'dirichlet', electrode: 'gnd' }, ymax: { bc: 'dirichlet', electrode: 'gnd' } } } };
    const geometry = G.compileGeometry(res);
    const raster0 = R.rasterize(geometry, R.makeGrid(res.domain, 0), res, { boundary: 'subgrid', snapTheta: 1e-3 });
    for (const interp of ['cubic', 'linear']) {
        const grid = F.createFieldGrid(raster0, geometry, { interp });
        const phi = new Float64Array(NX * NY);
        for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) phi[j * NX + i] = phiF(X0 + i * H, Y0 + j * H);
        grid.setChannels([phi], [new Float64Array(1)]);
        measure(`production FieldGrid (${interp}), info`, createFieldModel({ resolved: res, grid, raster0, geometry }), null);
    }
} catch (e) {
    console.log('production FieldGrid (WP1) not measured: ' + (e && e.message ? e.message.split('\n')[0] : e));
}
if (!ok) process.exitCode = 1;
