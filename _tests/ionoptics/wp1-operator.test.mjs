// WP1 operator (spec 3.1, 3.3, 7.2 acceptance 3): diag = sum of the arm coefficients, positive coefficients,
// regular and axis row weights, Shortley-Weller coefficients against the formulas, and S6: harmonic
// quadratics reproduced to 1e-9 with curved sub-grid boundaries, a Neumann edge and the axis.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileGeometry } from '../../beta/ion-optics/js/engine/geometry.js';
import { buildHierarchy, basisSetup, voltageSetup, customBoundarySetup, residualMax } from '../../beta/ion-optics/js/engine/operator.js';
import { multigridSolve, carreSOR } from '../../beta/ion-optics/js/engine/solve.js';

const ELS = [{ id: 'gnd' }, { id: 'a' }, { id: 'b' }, { id: 'c' }];

function planarFixture() {
    return {
        domain: { type: 'planar2d', h: 0.25, x: [-8, 8], y: [-8, 8], nx: 65, ny: 65, edges: {} },
        electrodes: ELS,
        shapes: [
            { type: 'circle', electrode: 'a', cx: -3.03, cy: 2.11, r: 1.7 },
            { type: 'annulus', electrode: 'b', cx: 3.07, cy: -2.02, rIn: 1.13, rOut: 2.31, a0: 30, a1: 250 },
            { type: 'polygon', electrode: 'c', points: [[1.01, 3.03], [5.12, 4.07], [4.01, 7.11], [1.53, 6.04]] },
            { type: 'polyline', electrode: 'a', points: [[-6.1, -6.3], [-2.2, -4.15]] },
        ],
    };
}
function cylFixture() {
    return {
        domain: { type: 'cyl2d', h: 0.25, x: [-3, 13], y: [0, 8], nx: 65, ny: 33,
            edges: { xmin: { bc: 'neumann' }, xmax: { bc: 'dirichlet', electrode: 'gnd' }, ymin: { bc: 'axis' }, ymax: { bc: 'dirichlet', electrode: 'gnd' } } },
        electrodes: ELS,
        shapes: [
            { type: 'circle', electrode: 'a', cx: 4.03, cy: 4.11, r: 1.31 },                                // torus section
            { type: 'annulus', electrode: 'b', cx: 8.06, cy: 0, rIn: 1.21, rOut: 2.23, a0: 0, a1: 120 },     // spherical shell sector
            { type: 'polygon', electrode: 'c', points: [[0.07, 5.02], [2.13, 5.51], [1.24, 7.33]] },
            { type: 'circle', electrode: 'c', cx: -3, cy: 3.04, r: 0.62 },                                   // centred on the Neumann edge
        ],
    };
}

// independent coefficients from the spec formulas (3.1): theta per arm, ghosts mirror the inward arm
function expectedCoefficients(op, m) {
    const g = op.grid, r = op.raster, nx = g.nx, ny = g.ny, k = op.irr.node[m], i = k % nx, j = (k - i) / nx;
    const th = [1, 1, 1, 1], cut = [false, false, false, false];
    for (let q = 0; q < r.cuts.count; q++) if (r.cuts.node[q] === k) { th[r.cuts.dir[q]] = r.cuts.theta[q]; cut[r.cuts.dir[q]] = true; }
    const outside = [i === nx - 1, i === 0, j === ny - 1, j === 0];
    for (let d = 0; d < 4; d++) if (outside[d] && !(op.cyl && d === 3)) th[d] = th[d ^ 1];
    const [tE, tW, tN, tS] = th;
    const cE = 2 / (tE * (tE + tW)), cW = 2 / (tW * (tE + tW));
    let cN, cS;
    if (!op.cyl) { cN = 2 / (tN * (tN + tS)); cS = 2 / (tS * (tN + tS)); } else if (j === 0) { cN = 4 / (tN * tN); cS = 0; } else { cN = (2 + tS / j) / (tN * (tN + tS)); cS = (2 - tN / j) / (tS * (tN + tS)); }
    return [cE, cW, cN, cS];
}

test('diag equals the sum of the arm coefficients (1e-15); every coefficient is non-negative', () => {
    for (const res of [planarFixture(), cylFixture()]) {
        const geo = compileGeometry(res);
        const H = buildHierarchy(geo, res, { minFree: 0, minNodesPerDir: 3, maxLevels: 5 });
        for (const op of H) {
            const irr = op.irr;
            for (let m = 0; m < irr.count; m++) {
                let s = 0;
                for (let d = 0; d < 4; d++) { assert.ok(irr.c[4 * m + d] >= 0); s += irr.c[4 * m + d]; }
                assert.ok(Math.abs(irr.diag[m] - s) <= 1e-15 * irr.diag[m], `diag ${irr.diag[m]} vs ${s}`);
                assert.ok(irr.diag[m] > 0);
            }
        }
    }
});

test('regular and axis row weights per spec 3.1', () => {
    const geoP = compileGeometry(planarFixture()), [opP] = buildHierarchy(geoP, planarFixture(), { maxLevels: 1 });
    for (let j = 0; j < opP.ny; j++) assert.deepEqual([opP.rowW[j], opP.rowN[j], opP.rowS[j], opP.rowD[j]], [1, 1, 1, 4]);
    const geoC = compileGeometry(cylFixture()), [opC] = buildHierarchy(geoC, cylFixture(), { maxLevels: 1 });
    assert.deepEqual([opC.rowW[0], opC.rowN[0], opC.rowS[0], opC.rowD[0]], [1, 4, 0, 6]);
    for (let j = 1; j < opC.ny; j++) assert.deepEqual([opC.rowW[j], opC.rowN[j], opC.rowS[j], opC.rowD[j]], [1, 1 + 1 / (2 * j), 1 - 1 / (2 * j), 4]);
});

test('Shortley-Weller coefficients of every irregular node match the formulas', () => {
    for (const res of [planarFixture(), cylFixture()]) {
        const geo = compileGeometry(res);
        const [op] = buildHierarchy(geo, res, { maxLevels: 1 });
        let cutNodes = 0;
        for (let m = 0; m < op.irr.count; m++) {
            const ex = expectedCoefficients(op, m);
            for (let d = 0; d < 4; d++) {
                const got = op.irr.c[4 * m + d];
                if (got === 0 && op.irr.nb[4 * m + d] === -1 && op.irr.cutElec[4 * m + d] === -1) continue;   // no arm (axis)
                assert.ok(Math.abs(got - ex[d]) <= 1e-14 * ex[d], `node ${op.irr.node[m]} arm ${d}: ${got} vs ${ex[d]}`);
            }
            if (op.irr.cutElec[4 * m] >= 0 || op.irr.cutElec[4 * m + 1] >= 0 || op.irr.cutElec[4 * m + 2] >= 0 || op.irr.cutElec[4 * m + 3] >= 0) cutNodes++;
        }
        assert.ok(cutNodes > 50, `cut nodes ${cutNodes}`);
    }
});

function s6(res, q) {
    const geo = compileGeometry(res);
    const H = buildHierarchy(geo, res, {});
    const op = H[0], u = new Float64Array(op.N), b = new Float64Array(op.irr.count);
    customBoundarySetup(op, q, u, b);
    let scale = 0;
    for (let k = 0; k < op.N; k++) scale = Math.max(scale, Math.abs(u[k]));
    const st = multigridSolve(H, u, b, { tol: 1e-12, scale, maxCycles: 100 });
    assert.ok(st.converged, 'converged');
    const g = op.grid;
    let err = 0, n = 0;
    for (let k = 0; k < op.N; k++) {
        if (op.mask[k] === 1) continue;
        const i = k % g.nx, j = (k - i) / g.nx;
        err = Math.max(err, Math.abs(u[k] - q(g.x0 + i * g.h, g.y0 + j * g.h)));
        n++;
    }
    // the SOR fallback reproduces it too
    const u2 = new Float64Array(op.N), b2 = new Float64Array(op.irr.count);
    customBoundarySetup(op, q, u2, b2);
    const st2 = carreSOR(op, u2, b2, { tol: 1e-12, scale });
    assert.ok(st2.converged);
    let err2 = 0;
    for (let k = 0; k < op.N; k++) if (op.mask[k] !== 1) { const i = k % g.nx, j = (k - i) / g.nx; err2 = Math.max(err2, Math.abs(u2[k] - q(g.x0 + i * g.h, g.y0 + j * g.h))); }
    return { err, err2, n, cuts: op.raster.cuts.count, irregular: op.irr.count };
}

test('S6 planar: 1 + 0.3x - 0.2y + 0.05(x^2 - y^2) + 0.02xy reproduced to 1e-9 with curved SW boundaries', () => {
    const q = (x, y) => 1 + 0.3 * x - 0.2 * y + 0.05 * (x * x - y * y) + 0.02 * x * y;
    const r = s6(planarFixture(), q);
    assert.ok(r.cuts > 200);
    assert.ok(r.err <= 1e-9, `max error ${r.err}`);
    assert.ok(r.err2 <= 1e-9, `SOR max error ${r.err2}`);
});

test('S6 cylindrical: 1 + 0.3x + 0.05(x^2 - rho^2/2) reproduced to 1e-9 with the axis and a Neumann edge', () => {
    const q = (x, y) => 1 + 0.3 * x + 0.05 * (x * x - y * y / 2);
    const r = s6(cylFixture(), q);
    assert.ok(r.cuts > 100);
    assert.ok(r.err <= 1e-9, `max error ${r.err}`);
    assert.ok(r.err2 <= 1e-9, `SOR max error ${r.err2}`);
});

test('voltage set-up with a unit vector equals the basis set-up; mixed weights included', () => {
    const res = planarFixture();
    res.domain.edges = { ymax: { bc: 'profile', segments: [{ from: -8, to: -1, electrode: 'a' }, { from: -1, to: 1, ramp: ['a', 'b'] }, { from: 1, to: 8, electrode: 'b' }] } };
    const geo = compileGeometry(res);
    const [op] = buildHierarchy(geo, res, { maxLevels: 1 });
    assert.ok(op.raster.mix.count > 0);
    for (const k of [1, 2, 3]) {
        const u1 = new Float64Array(op.N), b1 = new Float64Array(op.irr.count), u2 = new Float64Array(op.N), b2 = new Float64Array(op.irr.count);
        basisSetup(op, k, u1, b1);
        const volts = [0, 0, 0, 0]; volts[k] = 1;
        voltageSetup(op, volts, u2, b2);
        assert.deepEqual([...u1], [...u2]);
        assert.deepEqual([...b1], [...b2]);
    }
    // superposition of the set-ups
    const V = [0, 3, -7, 11];
    const u = new Float64Array(op.N), b = new Float64Array(op.irr.count);
    voltageSetup(op, V, u, b);
    const us = new Float64Array(op.N), bs = new Float64Array(op.irr.count);
    for (const k of [1, 2, 3]) {
        const uk = new Float64Array(op.N), bk = new Float64Array(op.irr.count);
        basisSetup(op, k, uk, bk);
        for (let q = 0; q < op.N; q++) us[q] += V[k] * uk[q];
        for (let q = 0; q < bk.length; q++) bs[q] += V[k] * bk[q];
    }
    for (let q = 0; q < op.N; q++) assert.ok(Math.abs(us[q] - u[q]) <= 1e-12);
    for (let q = 0; q < b.length; q++) assert.ok(Math.abs(bs[q] - b[q]) <= 1e-12 * Math.max(1, Math.abs(b[q])));
    // residualMax of the zero-voltage problem with zero field is zero
    assert.equal(residualMax(op, new Float64Array(op.N), new Float64Array(op.irr.count)), 0);
});
