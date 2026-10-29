// WP1 performance (spec 6, 3.6.5): rasterising all levels, one multigrid basis at 52k / 250k / 1M nodes, the
// SOR fallback at 250k, recombination + nodal derivatives at 250k with 4 bases, and field evaluations.
// Prints a table and exits non-zero when a budget is missed. Writes nothing.
// Run: node _tests/ionoptics/wp1-perf.mjs
import { compileGeometry } from '../../beta/ion-optics/js/engine/geometry.js';
import { makeGrid, rasterize, CELL } from '../../beta/ion-optics/js/engine/raster.js';
import { buildHierarchy } from '../../beta/ion-optics/js/engine/operator.js';
import { solveBasis } from '../../beta/ion-optics/js/engine/solve.js';
import { combine, createFieldGrid } from '../../beta/ion-optics/js/engine/field.js';

// a cylindrical lens column with 20 shapes: three tubes, six plates (some thinner than a cell), lines,
// rods, a polygon, a sector and a void; size scaled to the requested node count
function lensProject(targetN) {
    const h = Math.sqrt(200 * 50 / targetN);
    const nx = Math.round(200 / h) + 1, ny = Math.round(50 / h) + 1;
    const shapes = [
        { type: 'tube', electrode: 'a', x0: -95, x1: -12, rIn: 10, rOut: 12 },
        { type: 'tube', electrode: 'b', x0: -8, x1: 8, rIn: 10, rOut: 12 },
        { type: 'tube', electrode: 'a', x0: 12, x1: 95, rIn: 10, rOut: 12 },
    ];
    for (let q = 0; q < 6; q++) shapes.push({ type: 'plate', electrode: q % 2 ? 'a' : 'c', x: -60 + 24 * q + 0.37, t: 0.3 + 0.1 * q, rHole: 15 + q, rOut: 40 });
    for (let q = 0; q < 4; q++) shapes.push({ type: 'polyline', electrode: 'c', points: [[-50 + 30 * q + 0.13, 42], [-40 + 30 * q, 48.3]] });
    for (let q = 0; q < 3; q++) shapes.push({ type: 'circle', electrode: 'b', cx: -30 + 30 * q, cy: 30.2, r: 2.3 });
    shapes.push({ type: 'polygon', electrode: 'c', points: [[70, 20], [80, 20], [85, 30], [72, 33]] });
    shapes.push({ type: 'annulus', electrode: 'b', cx: 0, cy: 0, rIn: 44, rOut: 46, a0: 30, a1: 150 });
    shapes.push({ type: 'box', electrode: null, x0: -2, x1: 2, y0: 9, y1: 13 });
    shapes.push({ type: 'disc', electrode: 'a', x: 97, t: 1.5, r: 30 });
    return { domain: { type: 'cyl2d', h, cell: h, x: [-100, -100 + (nx - 1) * h], y: [0, (ny - 1) * h], nx, ny, edges: { xmin: { bc: 'dirichlet', electrode: 'gnd' }, xmax: { bc: 'dirichlet', electrode: 'gnd' }, ymin: { bc: 'axis' }, ymax: { bc: 'dirichlet', electrode: 'gnd' } } },
        electrodes: [{ id: 'gnd' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], shapes };
}
const rows = [];
function report(name, value, unit, budget, pass, note = '') { rows.push({ name, value, unit, budget, pass, note }); }
const best = (n, fn) => { let b = Infinity, first = NaN; for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(); const t = performance.now() - t0; if (i === 0) first = t; if (t < b) b = t; } return { best: b, first }; };

// ---- rasterise all levels, 250k nodes, 20 shapes
{
    const res = lensProject(250e3), geo = compileGeometry(res);
    const grids = [];
    for (let l = 0; l < 8; l++) { const g = makeGrid(res.domain, l); if (l > 0 && (g.nx < 5 || g.ny < 5)) break; grids.push(g); }
    let levels = 0;
    const t = best(8, () => { levels = 0; for (const g of grids) { const r = rasterize(geo, g, res, {}); levels++; if (r.stats.free <= 1000) break; } });
    report(`rasterise all levels (${res.domain.nx}x${res.domain.ny}, ${res.shapes.length} shapes, ${levels} levels)`, t.best, 'ms', 40, t.best <= 40, `first call ${t.first.toFixed(1)} ms`);
}
// ---- one basis by multigrid at 52k, 250k, 1M
for (const [N, budget] of [[52e3, 100], [250e3, 400], [1e6, 1500]]) {
    const res = lensProject(N), geo = compileGeometry(res);
    const H = buildHierarchy(geo, res, {});
    let st = null;
    const t = best(2, () => { st = solveBasis(H, 2, {}).stats; });
    report(`one basis, auto (${res.domain.nx}x${res.domain.ny} = ${(res.domain.nx * res.domain.ny / 1e3).toFixed(0)}k nodes)`, t.best, 'ms', budget, t.best <= budget && st.converged && st.path.length === 1,
        `${st.path.join('>')} ${st.cycles} cycles, est ${st.estErr.toExponential(1)}, ${H.length} levels`);
    if (N === 250e3) {
        const s = solveBasis(H, 2, { method: 'sor' }).stats;
        report(`SOR fallback (${(res.domain.nx * res.domain.ny / 1e3).toFixed(0)}k nodes)`, s.ms, 'ms', 4000, s.ms <= 4000 && s.converged, `${s.sweeps} sweeps, omega ${s.omega.toFixed(4)}`);
        // recombination of 4 bases + nodal derivatives of the display channel
        const bases = new Map();
        for (const k of [1, 2, 3, 4]) bases.set(k, solveBasis(H, k, { tol: 1e-8 }).phi);
        const fg = createFieldGrid(H[0].raster, geo, { interp: 'cubic' });
        const out = new Float64Array(H[0].N), V = [0, 120, -850, 33, 0];
        const tr = best(6, () => { combine(bases, V, out.length, out); fg.setChannels([out], [Float64Array.from(V)]); });
        report('recombine 4 bases + nodal derivatives (250k)', tr.best, 'ms', 15, tr.best <= 15, `first call ${tr.first.toFixed(1)} ms; createFieldGrid once per geometry`);
    }
    H.length = 0;
}
// ---- field evaluations, one channel
{
    const res = lensProject(52e3), geo = compileGeometry(res);
    const H = buildHierarchy(geo, res, {});
    const phi = combine(new Map([[1, solveBasis(H, 1).phi], [2, solveBasis(H, 2).phi], [3, solveBasis(H, 3).phi]]), [0, 0, 850, 120], H[0].N);
    const r0 = H[0].raster, g = r0.grid;
    // sample points by cell type
    const regular = [], visCells = [];
    for (let c = 0; c < r0.cellType.length; c++) {
        if (r0.cellType[c] === CELL.REGULAR && regular.length < 4096) regular.push(c);
        if (r0.cellType[c] === CELL.BOUNDARY && r0.cellVis[c] === 1 && visCells.length < 4096) visCells.push(c);
    }
    const toPts = (cells) => { const p = new Float64Array(2 * 4096); for (let q = 0; q < 4096; q++) { const c = cells[(q * 2654435761 >>> 0) % cells.length], i = c % (g.nx - 1), j = (c - i) / (g.nx - 1); p[2 * q] = g.x0 + (i + 0.13 + 0.74 * ((q * 0.618) % 1)) * g.h; p[2 * q + 1] = g.y0 + (j + 0.13 + 0.74 * ((q * 0.382) % 1)) * g.h; } return p; };
    const pr = toPts(regular), pv = toPts(visCells);
    const rate = (fg, pts, M) => { const o = new Float64Array(3); let s = 0; const run = () => { for (let m = 0; m < M; m++) { const q = m & 4095; fg.evalChannels(pts[2 * q], pts[2 * q + 1], o); s += o[1]; } }; run(); const t0 = performance.now(); run(); return M / (performance.now() - t0) / 1e3; };
    for (const [interp, target] of [['cubic', 2], ['linear', 6]]) {
        const fg = createFieldGrid(r0, geo, { interp });
        fg.setChannels([phi], [Float64Array.from([0, 0, 850, 120, 0])]);
        const rr = rate(fg, pr, 2e6), rv = rate(fg, pv, 5e5);
        report(`evaluations, REGULAR cells, ${interp}`, rr, 'M/s', target, rr >= target, '');
        report(`evaluations, visibility-tested cells, ${interp}`, rv, 'M/s', target / 5, rv >= target / 5, `${(rr / rv).toFixed(1)}x slower than this run's REGULAR rate`);
    }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`WP1 performance, Node ${process.version}, ${new Date().toISOString()}`);
console.log(pad('check', 66) + pad('measured', 14) + pad('budget', 14) + 'status');
let fail = 0;
for (const r of rows) {
    const cmp = r.unit === 'M/s' ? '>=' : '<=';
    console.log(pad(r.name, 66) + pad(`${r.value.toFixed(r.unit === 'M/s' ? 2 : 1)} ${r.unit}`, 14) + pad(`${cmp} ${r.budget} ${r.unit}`, 14) + (r.pass ? 'pass' : 'FAIL') + (r.note ? `  (${r.note})` : ''));
    if (!r.pass) fail++;
}
if (fail) { console.log(`${fail} budget(s) missed`); process.exitCode = 1; }
