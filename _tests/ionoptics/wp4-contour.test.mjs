// WP4 equipotentials: marching squares gives closed contours on a circular potential, open ones on a linear one,
// resolves saddles, skips NaN and masked nodes, and chooses round levels (spec §4.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const C = await import('../../beta/ion-optics/js/ui/contour.js');

function grid(nx, ny, x0, y0, h, f) {
    const v = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) v[j * nx + i] = f(x0 + i * h, y0 + j * h);
    return v;
}
function area(pts) {
    let a = 0;
    const n = pts.length / 2;
    for (let k = 0; k < n; k++) { const j = (k + 1) % n; a += pts[2 * k] * pts[2 * j + 1] - pts[2 * j] * pts[2 * k + 1]; }
    return Math.abs(a) / 2;
}

test('circular potential: one closed contour per level, on the right circle', () => {
    const h = 0.05, n = 201, x0 = -5, y0 = -5;
    const v = grid(n, n, x0, y0, h, (x, y) => Math.hypot(x, y));     // φ = r
    for (const R of [0.7, 1.3, 2.5, 3.9, 4.6]) {
        const lines = C.marchingSquares(v, n, n, R, { x0, y0, h });
        assert.equal(lines.length, 1, `level ${R}: one polyline`);
        const L = lines[0];
        assert.equal(L.closed, true, `level ${R}: closed`);
        let maxErr = 0;
        for (let k = 0; k < L.pts.length; k += 2) maxErr = Math.max(maxErr, Math.abs(Math.hypot(L.pts[k], L.pts[k + 1]) - R));
        assert.ok(maxErr < 0.25 * h * h / R + 1e-9, `level ${R}: radius error ${maxErr}`);
        const relA = Math.abs(area(L.pts) / (Math.PI * R * R) - 1);
        assert.ok(relA < 2e-3, `level ${R}: area error ${relA}`);
        // first and last points are distinct (closure is implied)
        assert.ok(Math.hypot(L.pts[0] - L.pts[L.pts.length - 2], L.pts[1] - L.pts[L.pts.length - 1]) > 0);
    }
});

test('a circle cut by the grid edge is open', () => {
    const h = 0.1, nx = 51, ny = 26;   // upper half only: y from 0 to 2.5
    const v = grid(nx, ny, -2.5, 0, h, (x, y) => Math.hypot(x, y));
    const lines = C.marchingSquares(v, nx, ny, 1.5, { x0: -2.5, y0: 0, h });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].closed, false);
    const p = lines[0].pts;
    assert.ok(Math.abs(p[1]) < 1e-12 && Math.abs(p[p.length - 1]) < 1e-12, 'both ends on y = 0');
});

test('linear potential gives straight open lines across the grid', () => {
    const h = 0.25, nx = 41, ny = 21;
    const v = grid(nx, ny, 0, 0, h, (x, y) => 2 * x + y);
    const lines = C.marchingSquares(v, nx, ny, 7.3, { x0: 0, y0: 0, h });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].closed, false);
    for (let k = 0; k < lines[0].pts.length; k += 2) assert.ok(Math.abs(2 * lines[0].pts[k] + lines[0].pts[k + 1] - 7.3) < 1e-12);
});

test('saddles are resolved by the cell-centre average; NaN and masked nodes are skipped', () => {
    // φ = x·y has a saddle at the origin; level 0.04 gives two hyperbola branches
    const h = 0.1, n = 21;
    const v = grid(n, n, -1, -1, h, (x, y) => x * y);
    const lines = C.marchingSquares(v, n, n, 0.04, { x0: -1, y0: -1, h });
    assert.equal(lines.length, 2);
    for (const L of lines) for (let k = 0; k < L.pts.length; k += 2) assert.ok(L.pts[k] * L.pts[k + 1] > 0, 'branches in quadrants I and III');
    // a NaN hole splits nothing but removes the segments that touch it
    const w = grid(n, n, -1, -1, h, (x, y) => Math.hypot(x, y));
    w[10 * n + 15] = NaN;
    const ln = C.marchingSquares(w, n, n, 0.5, { x0: -1, y0: -1, h });
    assert.ok(ln.length >= 1);
    for (const L of ln) for (let k = 0; k < L.pts.length; k += 2) assert.ok(Number.isFinite(L.pts[k]) && Number.isFinite(L.pts[k + 1]));
    const mask = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (Math.hypot(-1 + i * h, -1 + j * h) < 0.3) mask[j * n + i] = 1;
    assert.equal(C.marchingSquares(w, n, n, 0.2, { x0: -1, y0: -1, h, mask }).length, 0, 'contours inside the mask vanish');
});

test('round contour levels strictly between the extremes; every fifth is major', () => {
    const L = C.contourLevels(0, 850, 20);
    assert.ok(L.levels.length >= 10 && L.levels.length <= 40);
    for (const v of L.levels) assert.ok(v > 0 && v < 850);
    const step = L.step;
    assert.ok([1, 2, 2.5, 5].some((m) => Math.abs(step / Math.pow(10, Math.floor(Math.log10(step))) - m) < 1e-9), `round step ${step}`);
    L.levels.forEach((v, k) => assert.equal(L.major[k], Math.abs(Math.round(v / step) % 5) === 0));
    const N = C.contourLevels(-1, 1, 9, { nice: false });
    assert.equal(N.levels.length, 9);
    assert.ok(Math.abs(N.levels[4]) < 1e-15);
    assert.deepEqual(C.contourLevels(3, 3, 10).levels, []);
});

test('contourSet, decimation and polyline helpers', () => {
    const h = 0.1, n = 41;
    const v = grid(n, n, -2, -2, h, (x, y) => x * x + y * y);
    const set = C.contourSet(v, n, n, [0.25, 1, 2.25], { x0: -2, y0: -2, h }, [false, true, false]);
    assert.equal(set.length, 3);
    assert.equal(set[1].major, true);
    for (const s of set) assert.equal(s.lines.length, 1);
    const d = C.decimate2(v, n, n, h);
    assert.equal(d.nx, 21); assert.equal(d.ny, 21); assert.equal(d.h, 2 * h);
    assert.equal(d.values[0], v[0]);
    const square = Float64Array.from([0, 0, 1, 0, 1, 1, 0, 1]);
    assert.equal(C.polylineLength(square, true), 4);
    assert.equal(C.polylineLength(square, false), 3);
    const m = C.pointAlong(square, 0.5);
    assert.ok(Math.abs(m.x - 1) < 1e-12 && Math.abs(m.y - 0.5) < 1e-12);
});
