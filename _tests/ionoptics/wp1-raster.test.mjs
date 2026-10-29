// WP1 raster (spec 3.2, 3.4.2, 7.2 acceptance 2): exact cuts on every level for a 0.3-cell plate and an
// off-node line, node classes equal classify(), snapping, exact ramp weights, exterior nodes and far-edge
// cuts on off-lattice levels, sub-cell primitives, cell types and the near band.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileGeometry } from '../../beta/ion-optics/js/engine/geometry.js';
import { makeGrid, rasterize, FLAG, CELL } from '../../beta/ion-optics/js/engine/raster.js';
import { buildHierarchy } from '../../beta/ion-optics/js/engine/operator.js';

const ELS = [{ id: 'gnd' }, { id: 'a', name: 'A' }, { id: 'b', name: 'B', kind: 'grid' }];

function thinFixture() {
    // h = 0.5; 101 x-intervals and 31 r-intervals: far edges fall off the coarse lattices
    return {
        domain: { type: 'cyl2d', h: 0.5, cell: 0.5, x: [-20, 30.5], y: [0, 15.5], nx: 102, ny: 32,
            edges: { xmin: { bc: 'dirichlet', electrode: 'gnd' }, xmax: { bc: 'dirichlet', electrode: 'a' }, ymin: { bc: 'axis' }, ymax: { bc: 'neumann' } } },
        electrodes: ELS,
        shapes: [
            { type: 'plate', electrode: 'a', x: 0.15, t: 0.15, rHole: 4, rOut: 15.5 },             // 0.3 cell, between nodes 0 and 0.5
            { type: 'polyline', electrode: 'b', points: [[10.13, 2.07], [14.31, 12.7]] },          // off-node, oblique
        ],
    };
}
const nodeXY = (g, k) => { const i = k % g.nx, j = (k - i) / g.nx; return [g.x0 + i * g.h, g.y0 + j * g.h, i, j]; };

test('a 0.3-cell plate and an off-node line give exact cuts on every level', () => {
    const res = thinFixture();
    const geo = compileGeometry(res);
    const H = buildHierarchy(geo, res, { maxLevels: 5, minFree: 0, minNodesPerDir: 3 });
    assert.ok(H.length >= 4, `levels ${H.length}`);
    const P0 = 0.075, P1 = 0.225, A = [10.13, 2.07], B = [14.31, 12.7];
    const distToLine = (x, y) => { const ex = B[0] - A[0], ey = B[1] - A[1], L = Math.hypot(ex, ey); const s = Math.max(0, Math.min(L, ((x - A[0]) * ex + (y - A[1]) * ey) / L)); return Math.hypot(x - A[0] - s * ex / L, y - A[1] - s * ey / L); };
    for (const op of H) {
        const r = op.raster, g = r.grid, cuts = r.cuts;
        let plateCuts = 0, lineCuts = 0;
        for (let q = 0; q < cuts.count; q++) {
            const [x, y] = nodeXY(g, cuts.node[q]);
            const d = cuts.dir[q], th = cuts.theta[q], e = cuts.elec[q];
            assert.ok(th > 0 && th <= 1, 'theta in (0, 1]');
            const cx = x + (d === 0 ? th * g.h : d === 1 ? -th * g.h : 0), cy = y + (d === 2 ? th * g.h : d === 3 ? -th * g.h : 0);
            if (e === 1 && (d === 0 || d === 1) && Math.abs(cy) <= 15.5 && cy >= 4 - 1e-9 && Math.abs(cx - 0.15) < g.h) {
                plateCuts++;
                const face = d === 0 ? P0 : P1;
                assert.ok(Math.abs(cx - face) < 1e-8, `level ${g.level}: plate cut at x = ${cx}, face ${face}`);
            }
            if (e === 2) { lineCuts++; assert.ok(distToLine(cx, cy) < 1e-8, `level ${g.level}: line cut off the line by ${distToLine(cx, cy)}`); }
        }
        assert.ok(plateCuts >= 2, `level ${g.level}: plate cuts ${plateCuts}`);
        assert.ok(lineCuts >= 2, `level ${g.level}: line cuts ${lineCuts}`);
    }
});

test('node classes equal classify() on every level (rows decide; edges and snapped nodes excepted)', () => {
    for (const res of [thinFixture(), {
        domain: { type: 'planar2d', h: 0.25, x: [-6, 6.5], y: [-4, 4.25], nx: 51, ny: 34, edges: {} },
        electrodes: ELS,
        shapes: [
            { type: 'annulus', electrode: 'a', cx: 0.1, cy: 0.2, rIn: 1.03, rOut: 2.71, a0: 20, a1: 300 },
            { type: 'polygon', electrode: 'b', points: [[2, -3], [5.5, -2.2], [4.1, 3.3], [3, 0.1]] },
            { type: 'circle', electrode: null, cx: 4, cy: -1, r: 0.77 },
            { type: 'quadric', electrode: 'a', A: 1, B: -1, C: 1, cx: -4, cy: 0, clip: [-6, -4, -4, 4] },
            { type: 'polyline', electrode: 'a', points: [[-3, -3.5], [3, -3.5], [3.5, 3.9]] },
        ] }]) {
        const geo = compileGeometry(res);
        const H = buildHierarchy(geo, res, { maxLevels: 5, minFree: 0, minNodesPerDir: 3 });
        for (const op of H) {
            const r = op.raster, g = r.grid;
            let checked = 0;
            for (let k = 0; k < g.N; k++) {
                const [x, y, i, j] = nodeXY(g, k);
                if (x > g.xEnd + 1e-9 || y > g.yEnd + 1e-9) { assert.equal(r.cls[k], -2); assert.ok(r.flags[k] & FLAG.EXTERIOR); continue; }
                if (r.flags[k] & FLAG.SNAPPED) continue;
                const onEdge = i === 0 || j === 0 || Math.abs(x - g.xEnd) < 1e-9 || Math.abs(y - g.yEnd) < 1e-9;
                const c = geo.classify(x, y);
                if (onEdge && c === -1) continue;   // edge class (Dirichlet) or free (Neumann/axis)
                assert.equal(r.cls[k], c, `level ${g.level} node (${i}, ${j}) at (${x}, ${y})`);
                checked++;
            }
            assert.ok(checked > 0);
        }
    }
});

test('exterior nodes and far-edge cuts on off-lattice levels', () => {
    const res = thinFixture();
    const geo = compileGeometry(res);
    const H = buildHierarchy(geo, res, { maxLevels: 4, minFree: 0, minNodesPerDir: 3 });
    for (const op of H.slice(1)) {
        const r = op.raster, g = r.grid;
        assert.ok(g.offX > 0 && g.offY > 0, `level ${g.level} is off-lattice in x and y`);
        const iLast = Math.floor((g.xEnd - g.x0) / g.h + 1e-9), jLast = Math.floor((g.yEnd - g.y0) / g.h + 1e-9);
        assert.ok(iLast < g.nx - 1 && jLast < g.ny - 1);
        let edgeCuts = 0;
        for (let q = 0; q < r.cuts.count; q++) {
            if (r.cuts.elec[q] !== -3) continue;
            const [x, , i] = nodeXY(g, r.cuts.node[q]);
            assert.equal(r.cuts.dir[q], 0, 'Dirichlet far edge only on xmax (ymax is Neumann)');
            assert.equal(i, iLast);
            assert.ok(Math.abs(r.cuts.theta[q] * g.h - (g.xEnd - x)) < 1e-9);
            edgeCuts++;
        }
        assert.ok(edgeCuts > 0, `level ${g.level} xmax cuts`);
        for (let i = 0; i <= iLast; i++) {
            const k = jLast * g.nx + i;
            if (r.cls[k] !== -1) continue;
            assert.ok(r.flags[k] & FLAG.IRREG, 'Neumann far edge: the outward arm is dropped (irregular)');
            for (let q = 0; q < r.cuts.count; q++) if (r.cuts.node[q] === k && r.cuts.dir[q] === 2) assert.notEqual(r.cuts.elec[q], -3);
        }
        // the operator drops the outward arm: coefficient 0 on N for those nodes
        const irr = op.irr;
        let dropped = 0;
        for (let m = 0; m < irr.count; m++) {
            const k = irr.node[m], i = k % g.nx, j = (k - i) / g.nx;
            if (j === jLast && r.cls[k + g.nx] === -2 && irr.cutElec[4 * m + 2] === -1) { assert.equal(irr.c[4 * m + 2], 0); dropped++; }
        }
        assert.ok(dropped > 0);
    }
});

test('snapping fixes nodes within 1e-3 cell and re-links their neighbours', () => {
    const res = {
        domain: { type: 'planar2d', h: 1, x: [0, 12], y: [0, 6], nx: 13, ny: 7, edges: {} },
        electrodes: ELS,
        shapes: [{ type: 'box', electrode: 'a', x0: 5 + 2e-4, x1: 8, y0: 1, y1: 5 },       // left face 2e-4 cell right of x = 5
            { type: 'box', electrode: 'b', x0: 10 - 2e-4, x1: 11, y0: 1, y1: 5 }],          // left face 2e-4 cell left of x = 10
    };
    const geo = compileGeometry(res);
    const r = rasterize(geo, makeGrid(res.domain, 0), res, { snapTheta: 1e-3 });
    const g = r.grid;
    for (let j = 1; j <= 5; j++) {
        const k5 = j * g.nx + 5, k4 = k5 - 1, k10 = j * g.nx + 10, k9 = k10 - 1;
        assert.ok(r.flags[k5] & FLAG.SNAPPED, `node (5, ${j}) snapped`);
        assert.equal(r.cls[k5], 1);
        assert.equal(r.cls[k4], -1);
        assert.ok(!(r.flags[k4] & FLAG.IRREG), 'its west neighbour links regularly to the snapped node');
        assert.equal(r.cls[k10], 2, 'node x = 10 lies inside the second box');
        assert.ok(!(r.flags[k10] & FLAG.SNAPPED));
        const cut9 = [...Array(r.cuts.count).keys()].find((q) => r.cuts.node[q] === k9 && r.cuts.dir[q] === 0);
        assert.ok(cut9 !== undefined && Math.abs(r.cuts.theta[cut9] - (1 - 2e-4)) < 1e-8, 'cut at theta = 1 - 2e-4');
    }
    assert.ok(r.stats.snapped >= 5);
});

test('Dirichlet profile edges: exact ramp weights, 0.5/0.5 junctions, x-edge wins at corners', () => {
    const res = {
        domain: { type: 'planar2d', h: 0.5, x: [-4, 4], y: [-2, 2], nx: 17, ny: 9,
            edges: {
                xmin: { bc: 'dirichlet', electrode: 'gnd' }, xmax: { bc: 'neumann' },
                ymin: { bc: 'profile', segments: [{ from: -4, to: 0, electrode: 'a' }, { from: 0, to: 4, electrode: 'b' }] },
                ymax: { bc: 'profile', segments: [{ from: -4, to: -1, electrode: 'a' }, { from: -1, to: 1, ramp: ['a', 'b'] }, { from: 1, to: 4, electrode: 'b' }] },
            } },
        electrodes: ELS, shapes: [],
    };
    const geo = compileGeometry(res);
    const r = rasterize(geo, makeGrid(res.domain, 0), res, {});
    const g = r.grid;
    const mixAt = (k) => { for (let m = 0; m < r.mix.count; m++) if (r.mix.node[m] === k) return { e: [r.mix.e[2 * m], r.mix.e[2 * m + 1]], w: [r.mix.w[2 * m], r.mix.w[2 * m + 1]] }; return null; };
    const top = (x) => (g.ny - 1) * g.nx + Math.round((x - g.x0) / g.h), bottom = (x) => Math.round((x - g.x0) / g.h);
    const weight = (mx, e) => (mx.e[0] === e ? mx.w[0] : 0) + (mx.e[1] === e ? mx.w[1] : 0);
    for (const x of [-0.5, 0, 0.5]) {
        const f = (x + 1) / 2, mx = mixAt(top(x));
        assert.ok(mx && (r.flags[top(x)] & FLAG.MIXED), `ramp node x = ${x}`);
        assert.equal(weight(mx, 1), 1 - f);
        assert.equal(weight(mx, 2), f);
    }
    assert.equal(mixAt(top(-1)), null); assert.equal(r.cls[top(-1)], 1);
    assert.equal(mixAt(top(1)), null); assert.equal(r.cls[top(1)], 2);
    const j0 = mixAt(bottom(0));
    assert.ok(j0 && weight(j0, 1) === 0.5 && weight(j0, 2) === 0.5, 'junction of two electrodes: 0.5/0.5');
    assert.equal(r.cls[bottom(-2)], 1);
    assert.equal(r.cls[bottom(2)], 2);
    // corners: x-edge (Dirichlet gnd) wins at xmin; Neumann xmax loses to the profile
    assert.equal(r.cls[0], 0); assert.equal(r.cls[(g.ny - 1) * g.nx], 0);
    assert.equal(r.cls[g.nx - 1], 2); assert.equal(r.cls[g.N - 1], 2);
    // free nodes on the Neumann edge are flagged
    assert.ok(r.flags[2 * g.nx + g.nx - 1] & FLAG.NEUMANN_EDGE);
});

test('cell types, sub-cell primitives, mesh rows and the near band', () => {
    const res = {
        domain: { type: 'planar2d', h: 0.5, x: [-10, 10], y: [-6, 6], nx: 41, ny: 25, edges: { xmin: { bc: 'neumann' }, xmax: { bc: 'neumann' }, ymin: { bc: 'neumann' }, ymax: { bc: 'neumann' } } },
        electrodes: ELS,
        shapes: [
            { type: 'circle', electrode: 'a', cx: -6.25, cy: 2.25, r: 0.1 },                 // sub-cell rod
            { type: 'box', electrode: 'a', x0: -4, x1: -1, y0: -4, y1: -1 },                  // node-aligned solid
            { type: 'polyline', electrode: 'b', points: [[1, 0], [9, 0]] },                    // mesh on a node row
            { type: 'polyline', electrode: 'b', points: [[1, 3.2], [9, 3.2]] },                // mesh between rows
        ],
    };
    const geo = compileGeometry(res);
    const r = rasterize(geo, makeGrid(res.domain, 0), res, {});
    const g = r.grid, ncx = g.nx - 1, ncy = g.ny - 1;
    const cellOf = (x, y) => Math.floor((y - g.y0) / g.h) * ncx + Math.floor((x - g.x0) / g.h);
    const rod = cellOf(-6.25, 2.25);
    assert.equal(r.cellType[rod], CELL.BOUNDARY); assert.equal(r.cellVis[rod], 1);
    assert.equal(r.cellType[cellOf(-6.75, 2.25)], CELL.REGULAR);
    assert.equal(r.cellType[cellOf(-2.6, -2.6)], CELL.SOLID);
    assert.equal(r.cellType[cellOf(-4.25, -2.6)], CELL.BOUNDARY);
    assert.equal(r.cellVis[cellOf(-4.25, -2.6)], 0, 'node-aligned faces need no visibility tests');
    assert.equal(r.cellType[cellOf(5.1, 0.2)], CELL.BOUNDARY); assert.equal(r.cellVis[cellOf(5.1, 0.2)], 0);
    assert.equal(r.cellType[cellOf(5.1, -0.2)], CELL.BOUNDARY); assert.equal(r.cellVis[cellOf(5.1, -0.2)], 0);
    assert.equal(r.cellType[cellOf(5.1, 3.1)], CELL.BOUNDARY); assert.equal(r.cellVis[cellOf(5.1, 3.1)], 1, 'off-node mesh: partly painted cell edges');
    assert.equal(r.cellType[cellOf(5.1, 1.6)], CELL.REGULAR);
    // near = BOUNDARY dilated by one cell (8-neighbourhood)
    for (let j = 0; j < ncy; j++) for (let i = 0; i < ncx; i++) {
        let expect = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= ncx || jj >= ncy) continue;
            if (r.cellType[jj * ncx + ii] === CELL.BOUNDARY) expect = 1;
        }
        assert.equal(r.near[j * ncx + i], expect, `near at cell (${i}, ${j})`);
    }
    // staircase mode: same classes, no cuts
    const rs = rasterize(geo, makeGrid(res.domain, 0), res, { boundary: 'staircase' });
    assert.equal(rs.cuts.count, 0);
    assert.deepEqual([...rs.cls], [...r.cls]);
    assert.ok(r.cuts.count > 0);
});
