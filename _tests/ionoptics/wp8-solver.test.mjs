// WP-G solver extensions (improvement plan §4, package WP-G): G1 anti-mirror planes (Dirichlet 0 on the plane for the
// solver, odd reflection in the field grid and the field model) and G2 the Poisson term from an analytic charge density
// (cell-centred, averaged onto the nodes with the dual-cell volumes; the "charge basis" CHARGE_BASIS). Every default is
// off, so projects without `antimirror` or `charge` are untouched (the existing suites and bench.mjs prove that).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as pipeline from '../../beta/ion-optics/js/engine/pipeline.js';
import { ENGINE_VERSION, PROJECT_FORMAT } from '../../beta/ion-optics/js/engine/version.js';
import { compileGeometry } from '../../beta/ion-optics/js/engine/geometry.js';
import { makeGrid, rasterize, packRaster, unpackRaster, FLAG, CELL } from '../../beta/ion-optics/js/engine/raster.js';
import { buildHierarchy, basisSetup, newRhs, chargeSource, CHARGE_BASIS } from '../../beta/ion-optics/js/engine/operator.js';
import { solveBasis, solveVoltages, solveCharge, chargeScale } from '../../beta/ion-optics/js/engine/solve.js';
import { createFieldGrid } from '../../beta/ion-optics/js/engine/field.js';
import { createFieldModel } from '../../beta/ion-optics/js/engine/fieldmodel.js';
import { compileMagnets } from '../../beta/ion-optics/js/engine/magnet.js';
import { EPS0 } from '../../beta/ion-optics/js/engine/constants.js';

const DEG = Math.PI / 180;
const ED = (electrode) => ({ bc: 'dirichlet', electrode });
const NEU = { bc: 'neumann' };
const maxAbs = (a) => { let m = 0; for (const v of a) { const x = Math.abs(v); if (x > m) m = x; } return m; };

/** A complete project (schema-valid) in the style of the benchmark registry. */
function proj(name, type, o) {
    const cyl = type === 'cyl2d';
    return {
        format: PROJECT_FORMAT, version: 1,
        meta: { name, notes: '', created: '2026-10-14T00:00:00Z', modified: '2026-10-14T00:00:00Z', engine: ENGINE_VERSION },
        params: o.params || [],
        domain: { type, cell: o.cell, x: o.x.slice(), y: o.y.slice(),
            edges: { xmin: ED('gnd'), xmax: ED('gnd'), ymin: cyl ? { bc: 'axis' } : ED('gnd'), ymax: ED('gnd'), ...(o.edges || {}) },
            mirror: { x: !!(o.mirror && o.mirror.x), y: !!(o.mirror && o.mirror.y) },
            antimirror: { x: !!(o.antimirror && o.antimirror.x), y: !!(o.antimirror && o.antimirror.y) },
            charge: o.charge || '',
            beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' } },
        electrodes: [{ id: 'gnd', name: 'Ground', ground: true, color: '#64748b' }, ...(o.electrodes || [])],
        shapes: (o.shapes || []).map((s, i) => ({ id: 's' + (i + 1), enabled: true, locked: false, ...s })),
        magnets: [], idealFields: [], sources: [],
        recording: { planes: [], trajectories: { store: false, maxPoints: 2000 }, timeMarkers: null },
        tracer: { integrator: 'rk45', quality: 'normal', custom: null, fieldInterp: 'cubic', relativistic: false, tMax: 1000, maxSteps: 500000, maxDrift: 10000, drag: null },
        solver: { boundary: 'subgrid', method: 'auto', tol: 1e-12, maxCycles: 60, maxIterations: 200, maxSweeps: 100000 },
        analysis: { lens: null, scan: null, optimize: null, waist: null },
        view: { center: [0, 0], scale: 10, displayTime: 0, projection: 'xy', colormap: 'auto', contourLevels: null,
            layers: { potential: true, contours: 20, field: false, electrodes: true, trajectories: 'source', planes: true, hits: true, grid: 'auto', mirror: true, markers: false } },
    };
}
const el = (id, v) => ({ id, name: id, kind: 'solid', v, wave: null, color: '#2563eb' });
function build(p) {
    const resolved = pipeline.resolveOrThrow(p);
    const solved = pipeline.solveProject(resolved);
    return { resolved, solved, field: pipeline.buildField(resolved, solved) };
}
/** A resolved-level fixture for the engine modules (no schema): domain with h, nx, ny, mirror, antimirror, charge. */
function fixture({ type = 'planar2d', h, x, y, edges = {}, mirror = {}, antimirror = {}, charge = '', paramValues = {}, electrodes = [{ id: 'gnd' }], shapes = [] }) {
    return {
        domain: { type, h, cell: h, x, y, nx: Math.round((x[1] - x[0]) / h) + 1, ny: Math.round((y[1] - y[0]) / h) + 1, edges,
            mirror: { x: !!mirror.x, y: !!mirror.y }, antimirror: { x: !!antimirror.x, y: !!antimirror.y }, charge },
        paramValues, electrodes, shapes, magnets: [], idealFields: [], solver: { boundary: 'subgrid' },
    };
}
/** Solve the charge basis of a fixture and wrap it in a field grid and model (the pipeline's DC channel after the handoff). */
function chargeField(res, opts = {}) {
    const geo = compileGeometry(res);
    const H = buildHierarchy(geo, res, {});
    const { phi, stats } = solveBasis(H, CHARGE_BASIS, { tol: 1e-12, ...opts });
    const grid = createFieldGrid(H[0].raster, geo, { interp: 'cubic' });
    grid.setChannels([phi], [new Float64Array(res.electrodes.length)]);
    const model = createFieldModel({ resolved: res, grid, raster0: H[0].raster, geometry: geo });
    return { geo, H, phi, stats, grid, model };
}

// ---------------------------------------------------------------- G1 anti-mirror planes
const HEX = { R: 10, A: 3, L: 20, h: 0.25, V: 100 };
const rod = (deg, e, R = HEX.R, A = HEX.A) => ({ type: 'circle', electrode: e, cx: +(R * Math.cos(deg * DEG)).toFixed(12), cy: +(R * Math.sin(deg * DEG)).toFixed(12), r: A });
// hexapole φ ∝ r³cos 3θ: odd in x (anti-mirror), even in y (mirror); rods alternate ±V at 0°, 60°, …
const hexFull = () => proj('Hexapole, full', 'planar2d', { cell: HEX.h, x: [-HEX.L, HEX.L], y: [-HEX.L, HEX.L], electrodes: [el('p', HEX.V), el('m', -HEX.V)],
    shapes: [rod(0, 'p'), rod(60, 'm'), rod(120, 'p'), rod(180, 'm'), rod(240, 'p'), rod(300, 'm')] });
const hexQuarter = () => proj('Hexapole, quarter', 'planar2d', { cell: HEX.h, x: [0, HEX.L], y: [0, HEX.L], mirror: { y: true }, antimirror: { x: true },
    edges: { xmin: ED('gnd'), ymin: NEU }, electrodes: [el('p', HEX.V), el('m', -HEX.V)], shapes: [rod(0, 'p'), rod(60, 'm')] });
let hexCache = null;
const hex = () => hexCache || (hexCache = { F: build(hexFull()), Q: build(hexQuarter()) });

test('G1 hexapole: the quarter model (anti-mirror x, mirror y) equals the full model to 1e-9 (nodes, φ and E everywhere)', () => {
    const { F, Q } = hex();
    assert.ok(F.solved.stats.every((s) => s.converged) && Q.solved.stats.every((s) => s.converged));
    const { V, L, h } = HEX;
    // nodal potentials of the DC channel (the quarter's node (i, j) is the full model's (i + L/h, j + L/h))
    const pf = F.field.channels[0].phi, pq = Q.field.channels[0].phi;
    const nxf = F.resolved.domain.nx, nxq = Q.resolved.domain.nx, nyq = Q.resolved.domain.ny, off = Math.round(L / h);
    let dn = 0, plane = 0;
    for (let j = 0; j < nyq; j++) for (let i = 0; i < nxq; i++) {
        dn = Math.max(dn, Math.abs(pq[j * nxq + i] - pf[(j + off) * nxf + i + off]));
        if (i === 0) plane = Math.max(plane, Math.abs(pf[(j + off) * nxf + off]));
    }
    assert.ok(dn <= 1e-9 * V, `nodal difference ${dn} V`);
    assert.ok(plane <= 1e-9 * V, `the full model is zero on the plane: ${plane}`);
    // the cells along the plane are REGULAR (Hermite) except the one at the grounded far edge
    const ct = Q.solved.raster0.cellType, ncx = nxq - 1;
    for (let j = 0; j < nyq - 2; j++) assert.equal(ct[j * ncx], CELL.REGULAR, `cell (0, ${j})`);
    assert.equal(ct[(nyq - 2) * ncx], CELL.BOUNDARY);
    // field model: φ and E at 160 × 160 points over all four quadrants, including BOUNDARY cells next to the rods
    const e1 = new Float64Array(4), e2 = new Float64Array(4);
    let dphi = 0, dE = 0, eMax = 0, n = 0, nBoundary = 0;
    for (let a = 0; a < 160; a++) for (let b = 0; b < 160; b++) {
        const x = -L + (a + 0.37) * 2 * L / 160, y = -L + (b + 0.61) * 2 * L / 160;
        const w1 = F.field.model.E(0, x, y, 0, e1), w2 = Q.field.model.E(0, x, y, 0, e2);
        assert.equal(w2, w1, `where at (${x}, ${y})`);
        if (w1 >= 2) continue;
        n++;
        if (w1 === 1) nBoundary++;
        dphi = Math.max(dphi, Math.abs(e1[3] - e2[3]));
        dE = Math.max(dE, Math.abs(e1[0] - e2[0]), Math.abs(e1[1] - e2[1]), Math.abs(e1[2] - e2[2]));
        eMax = Math.max(eMax, Math.hypot(e1[0], e1[1]));
    }
    assert.ok(n > 20000 && nBoundary > 500, `${n} points, ${nBoundary} in boundary cells`);
    assert.ok(dphi <= 1e-9 * V, `max |Δφ| ${dphi} V`);
    assert.ok(dE <= 1e-9 * eMax, `max |ΔE| ${dE} of ${eMax} V/mm`);
});

test('G1 model geometry: odd symmetry, folded box, beyond keys, hits through the plane on the image electrode', () => {
    const { Q } = hex();
    const m = Q.field.model, e1 = new Float64Array(4), e2 = new Float64Array(4);
    assert.deepEqual(m.antimirror, { x: true, y: false });
    assert.deepEqual(m.mirror, { x: false, y: true });
    for (const [x, y] of [[3.3, 7.1], [12.4, 0.2], [0.05, 15], [9.9, 9.9]]) {
        const w1 = m.E(0, x, y, 0, e1), w2 = m.E(0, -x, y, 0, e2);
        assert.equal(w1, w2);
        if (w1 >= 2) continue;
        assert.equal(e2[3], -e1[3], 'φ odd'); assert.equal(e2[0], e1[0], 'E_x even'); assert.equal(e2[1], -e1[1], 'E_y odd');
        const w3 = m.E(0, x, -y, 0, e2);   // the mirror plane y = 0: φ even, E_y odd
        assert.equal(w3, w1); assert.equal(e2[3], e1[3]); assert.equal(e2[1], -e1[1]);
    }
    assert.deepEqual([m.box.xmin, m.box.xmax, m.box.ymin, m.box.ymax], [-20, 20, -20, 20]);
    assert.ok(m.inside(-19.9, -19.9, 5) && !m.inside(-20.1, 0, 0));
    assert.equal(m.beyondKey(0), 'xmax');   // EDGE.XMIN maps to the far edge through the plane
    // a chord crossing the plane hits the image of rod 'p' (the rod at 180°, which carries −V): same entry parameter as the full model
    const hq = m.firstHit(-15, 0.5, 0, -5, 0.5, 0), hf = hex().F.field.model.firstHit(-15, 0.5, 0, -5, 0.5, 0);
    assert.ok(hq && hf);
    assert.equal(hq.u, hf.u, 'same entry parameter as the full model');
    assert.ok(Math.abs(hq.u - (15 - 10 - Math.sqrt(9 - 0.25)) / 10) <= 1e-9, `u ${hq.u} (the geometry places hits within 1e-9 cell)`);
    assert.equal(hq.electrode, 1, 'reported as the electrode whose image it is');
    assert.equal(m.ownerAt(-10, 0.5, 0), 1);
    assert.equal(m.potential(0, -10.5, 1.2, 0), -m.potential(0, 10.5, 1.2, 0));
});

test('G1 cyl2d anti-mirror x: two tubes at ±V (odd in x) in a grounded pipe; the half model equals the full one in 3D', () => {
    const V = 50, h = 0.5;
    const full = build(proj('Odd tubes, full', 'cyl2d', { cell: h, x: [-30, 30], y: [0, 20], electrodes: [el('p', V), el('m', -V)],
        shapes: [{ type: 'tube', electrode: 'p', x0: 5, x1: 15, rIn: 10, rOut: 12 }, { type: 'tube', electrode: 'm', x0: -15, x1: -5, rIn: 10, rOut: 12 }] }));
    const half = build(proj('Odd tubes, half', 'cyl2d', { cell: h, x: [0, 30], y: [0, 20], antimirror: { x: true }, electrodes: [el('p', V), el('m', -V)],
        shapes: [{ type: 'tube', electrode: 'p', x0: 5, x1: 15, rIn: 10, rOut: 12 }] }));
    const e1 = new Float64Array(4), e2 = new Float64Array(4);
    let d = 0, eMax = 0, n = 0;
    for (let a = 0; a < 90; a++) for (let b = 0; b < 40; b++) {
        const x = -29 + a * 58 / 89, rr = 0.1 + b * 19.7 / 39, ang = (a * 7 + b * 3) * 0.1;
        const y = rr * Math.cos(ang), z = rr * Math.sin(ang);
        const w1 = full.field.model.E(0, x, y, z, e1), w2 = half.field.model.E(0, x, y, z, e2);
        assert.equal(w2, w1);
        if (w1 >= 2) continue;
        n++;
        for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(e1[c] - e2[c]) / (c === 3 ? V : 1));
        eMax = Math.max(eMax, Math.hypot(e1[0], e1[1], e1[2]));
    }
    assert.ok(n > 2500);
    assert.ok(d <= 1e-9 * Math.max(1, eMax), `max relative difference ${d}`);
    half.field.model.E(0, -10, 3, 4, e2); full.field.model.E(0, -10, 3, 4, e1);
    assert.ok(Math.abs(e1[3] - e2[3]) <= 1e-9 * V && e2[3] < -1, 'the image tube is at −V');
});

test('G1 raster: plane nodes stay fixed at 0 V and carry FLAG.ANTIMIRROR except on real Dirichlet edges; painting clears it; pack round trip', () => {
    const res = fixture({ h: 0.5, x: [0, 10], y: [0, 8], edges: { ymin: NEU }, mirror: { y: true }, antimirror: { x: true },
        electrodes: [{ id: 'gnd' }, { id: 'a' }], shapes: [{ type: 'box', electrode: 'gnd', x0: -1, x1: 1.2, y0: 3, y1: 4 }, { type: 'circle', electrode: 'a', cx: 6, cy: 2, r: 1.3 }] });
    const grid = makeGrid(res.domain, 0);
    assert.deepEqual(grid.antimirror, { x: true, y: false });
    assert.deepEqual(grid.mirror, { x: false, y: true });
    assert.equal(grid.edges.xmin.bc, 'dirichlet');
    const geo = compileGeometry(res);
    const r = rasterize(geo, grid, res, {});
    const nx = grid.nx, ny = grid.ny;
    let flagged = 0;
    for (let j = 0; j < ny; j++) {
        const k = j * nx, y = j * grid.h;
        assert.equal(r.cls[k], 0, 'plane nodes are grounded');
        const inBox = y >= 3 && y <= 4, top = j === ny - 1;
        assert.equal((r.flags[k] & FLAG.ANTIMIRROR) !== 0, !inBox && !top, `node (0, ${j})`);
        if (r.flags[k] & FLAG.ANTIMIRROR) flagged++;
    }
    assert.equal(flagged, ny - 1 - 3);
    for (let j = 0; j < ny; j++) for (let i = 1; i < nx; i++) assert.equal(r.flags[j * nx + i] & FLAG.ANTIMIRROR, 0, 'only the plane is flagged');
    // cells along the plane: REGULAR away from the box and the far edge, BOUNDARY at them
    const ct = r.cellType, ncx = nx - 1;
    assert.equal(ct[0], CELL.REGULAR); assert.equal(ct[2 * ncx], CELL.REGULAR); assert.equal(ct[4 * ncx], CELL.REGULAR); assert.equal(ct[(ny - 2) * ncx], CELL.BOUNDARY);
    assert.equal(ct[5 * ncx], CELL.BOUNDARY, 'the cell below y = 3 touches the grounded box');
    assert.equal(ct[6 * ncx], CELL.SOLID, 'the cell inside the box (y 3–3.5) is solid: the painted plane nodes are ordinary electrode nodes');
    assert.equal(ct[8 * ncx], CELL.BOUNDARY, 'the cell above y = 4 touches the grounded box');
    // the hierarchy keeps the solver untouched: plane nodes are mask 1 (fixed), no source
    const H = buildHierarchy(geo, res, {});
    for (let j = 0; j < ny; j++) assert.equal(H[0].mask[j * nx], 1);
    assert.equal(H[0].source, null);
    const back = unpackRaster(packRaster(r));
    assert.deepEqual(back.grid.antimirror, { x: true, y: false });
    assert.deepEqual([...back.flags], [...r.flags]);
    // without anti-mirror nothing is flagged and the grid says so
    const plain = fixture({ h: 0.5, x: [0, 10], y: [0, 8], edges: { ymin: NEU }, mirror: { y: true } });
    const rp = rasterize(compileGeometry(plain), makeGrid(plain.domain, 0), plain, {});
    assert.deepEqual(rp.grid.antimirror, { x: false, y: false });
    assert.ok([...rp.flags].every((f) => !(f & FLAG.ANTIMIRROR)));
    // a mirror on the same plane wins (the schema refuses the combination)
    assert.deepEqual(makeGrid({ ...plain.domain, mirror: { x: true, y: false }, antimirror: { x: true, y: false } }, 0).antimirror, { x: false, y: false });
});

// ---------------------------------------------------------------- G2 Poisson term
const RHO_C = (h) => h * h * 1e-6 / EPS0;   // f = h² ρ 1e-6 / ε0 (V) for ρ in C/m³

test('G2 charge source: cell-centred sampling, dual-cell volume weights (planar, cylindrical, axis), zero at fixed nodes', () => {
    const h = 0.5;
    const pl = fixture({ h, x: [0, 10], y: [0, 6], edges: { ymin: NEU, ymax: NEU }, charge: 'rho0', paramValues: { rho0: 2e-6 }, electrodes: [{ id: 'gnd' }, { id: 'a' }], shapes: [{ type: 'circle', electrode: 'a', cx: 5, cy: 3, r: 1.2 }] });
    const Hp = buildHierarchy(compileGeometry(pl), pl, {});
    const fp = Hp[0].source, op = Hp[0];
    assert.ok(fp instanceof Float64Array && fp.length === op.N);
    for (let k = 0; k < op.N; k++) {
        if (op.mask[k] === 1) assert.equal(fp[k], 0);
        else assert.ok(Math.abs(fp[k] - 2e-6 * RHO_C(h)) <= 1e-15 * 2e-6 * RHO_C(h), `uniform density, node ${k}: ${fp[k]}`);
    }
    // linear density (C/m³ as written): the average of the four cell centres is the node value
    const lin = chargeSource(op, 'x - 2*y + 1', {});
    const C = RHO_C(h);
    for (let j = 1; j < op.ny - 1; j++) for (let i = 1; i < op.nx - 1; i++) {
        const k = j * op.nx + i;
        if (op.mask[k] === 1) continue;
        assert.ok(Math.abs(lin[k] - C * (i * h - 2 * j * h + 1)) <= 1e-12 * C, `node (${i}, ${j})`);
    }
    // cylindrical weights r_j ± h/4: rho = r gives r_j + h²/(8 r_j) for j ≥ 1 and h/2 on the axis
    const cy = fixture({ type: 'cyl2d', h, x: [0, 10], y: [0, 6], edges: { xmin: NEU, xmax: NEU, ymin: { bc: 'axis' } }, charge: 'r' });
    const Hc = buildHierarchy(compileGeometry(cy), cy, {});
    const fc = Hc[0].source, oc = Hc[0];
    for (let j = 0; j < oc.ny - 1; j++) {
        const k = j * oc.nx + 3, rj = j * h;
        assert.ok(oc.mask[k] !== 1);
        const want = j === 0 ? h / 2 : rj + h * h / (8 * rj);
        assert.ok(Math.abs(fc[k] - C * want) <= 1e-12 * C, `cyl node row ${j}: ${fc[k]} vs ${C * want}`);
    }
    // identically zero, empty and missing densities give no source; the charge basis set-up is all zeros
    assert.equal(chargeSource(op, '0*x', {}), null);
    assert.equal(chargeSource(op, '   ', {}), null);
    const H0 = buildHierarchy(compileGeometry(pl), { ...pl, domain: { ...pl.domain, charge: '' } }, {});
    assert.equal(H0[0].source, null);
    const u = new Float64Array(op.N).fill(3), b = newRhs(op).fill(2);
    basisSetup(op, CHARGE_BASIS, u, b);
    assert.ok(u.every((v) => v === 0) && b.every((v) => v === 0));
    assert.throws(() => chargeSource(op, '1/(x - 0.25)', {}), (e) => e.code === 'E_NOT_FINITE');
});

test('G2 exact cases: uniform charge between grounded planes and in a grounded cylinder (quadratics) to 1e-9', () => {
    const rho0 = 1e-6, h = 0.5, d = 10;
    // planar slab: Neumann top and bottom, grounded x = 0 and x = d; φ = ρ0 x (d − x) / (2 ε0)
    const slab = fixture({ h, x: [0, d], y: [0, 4], edges: { ymin: NEU, ymax: NEU }, charge: 'rho0', paramValues: { rho0 } });
    const { H, phi, stats } = chargeField(slab);
    assert.ok(stats.converged && stats.source === true && stats.scale > 0, JSON.stringify(stats.path));
    const g = H[0].grid;
    let err = 0, vmax = 0;
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
        const x = i * h * 1e-3, ex = rho0 * x * (d * 1e-3 - x) / (2 * EPS0);
        err = Math.max(err, Math.abs(phi[j * g.nx + i] - ex)); vmax = Math.max(vmax, ex);
    }
    assert.ok(vmax > 1 && err <= 1e-9 * vmax, `slab: max error ${err} of ${vmax} V`);
    // grounded cylinder of radius R, uniform charge, Neumann ends: φ = ρ0 (R² − r²) / (4 ε0); the axis row and the FV weights are exact
    const R = 8;
    const cyl = fixture({ type: 'cyl2d', h, x: [0, 6], y: [0, R], edges: { xmin: NEU, xmax: NEU, ymin: { bc: 'axis' }, ymax: ED(0) }, charge: 'rho0', paramValues: { rho0 } });
    const c = chargeField(cyl);
    const gc = c.H[0].grid;
    let errc = 0, vmaxc = 0;
    for (let j = 0; j < gc.ny; j++) for (let i = 0; i < gc.nx; i++) {
        const r = j * h * 1e-3, ex = rho0 * ((R * 1e-3) ** 2 - r * r) / (4 * EPS0);
        errc = Math.max(errc, Math.abs(c.phi[j * gc.nx + i] - ex)); vmaxc = Math.max(vmaxc, ex);
    }
    assert.ok(errc <= 1e-9 * vmaxc, `cylinder: max error ${errc} of ${vmaxc} V`);
    // the field model reproduces E = ρ0 r / (2 ε0) radially (Hermite on a quadratic) and the sign: a positive charge pushes outward
    const e4 = new Float64Array(4);
    c.model.E(0, 3, 2.1, -2.8, e4);
    const rr = Math.hypot(2.1, -2.8), Er = rho0 * rr * 1e-3 / (2 * EPS0) * 1e-3;
    assert.ok(Math.abs(e4[1] - Er * 2.1 / rr) <= 1e-9 * Er && Math.abs(e4[2] - Er * -2.8 / rr) <= 1e-9 * Er && Math.abs(e4[0]) <= 1e-9 * Er, `E (${e4[0]}, ${e4[1]}, ${e4[2]}) vs E_ρ ${Er}`);
    assert.ok(e4[3] > 0);
});

function sinusoidBox(n) {
    const Lb = 32, h = Lb / n;
    return fixture({ h, x: [0, Lb], y: [0, Lb], charge: 'rho0*sin(180*x/L)*sin(180*y/L)', paramValues: { rho0: 1e-6, L: Lb } });
}
const SIN_PHI0 = 1e-6 / (EPS0 * Math.PI * Math.PI * 2 / (0.032 * 0.032));   // 5.859 V
function sinusoidError(n) {
    const res = sinusoidBox(n);
    const { H, phi, stats, model } = chargeField(res);
    const g = H[0].grid;
    let err = 0;
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) err = Math.max(err, Math.abs(phi[j * g.nx + i] - SIN_PHI0 * Math.sin(Math.PI * i / n) * Math.sin(Math.PI * j / n)));
    const e4 = new Float64Array(4);
    let eErr = 0, eMax = 0;
    for (let q = 0; q < 1500; q++) {
        const x = 2 + 28 * ((q * 0.618033) % 1), y = 2 + 28 * ((q * 0.381966) % 1);
        assert.equal(model.E(0, x, y, 0, e4), CELL.REGULAR);
        const ex = -SIN_PHI0 * (Math.PI / 32) * Math.cos(Math.PI * x / 32) * Math.sin(Math.PI * y / 32), ey = -SIN_PHI0 * (Math.PI / 32) * Math.sin(Math.PI * x / 32) * Math.cos(Math.PI * y / 32);
        eErr = Math.max(eErr, Math.abs(e4[0] - ex), Math.abs(e4[1] - ey)); eMax = Math.max(eMax, Math.hypot(ex, ey));
    }
    return { rel: err / SIN_PHI0, eRel: eErr / eMax, stats, H };
}

test('G2 sinusoidal charge in a grounded box: 1e-3 relative at 64 cells, second order, forced solvers agree', () => {
    const r32 = sinusoidError(32), r64 = sinusoidError(64), r128 = sinusoidError(128);
    assert.ok(r64.rel <= 1e-3, `64 cells: relative error ${r64.rel}`);
    assert.ok(r64.eRel <= 1e-3, `64 cells: E relative error ${r64.eRel}`);
    assert.ok(r128.rel <= 2.5e-4 && r128.eRel <= 2.5e-4, `128 cells: ${r128.rel}, E ${r128.eRel}`);
    const p1 = Math.log2(r32.rel / r64.rel), p2 = Math.log2(r64.rel / r128.rel);
    assert.ok(p1 >= 1.9 && p1 <= 2.1 && p2 >= 1.9 && p2 <= 2.1, `orders ${p1}, ${p2}`);
    assert.deepEqual(r128.stats.path, ['multigrid']);
    assert.ok(r128.stats.converged && r128.stats.estErr <= 1e-12 * r128.stats.scale);
    // multigrid, MG-BiCGSTAB and adaptive SOR solve the same Poisson system
    const H = r128.H, sol = {};
    for (const method of ['multigrid', 'krylov', 'sor']) {
        const s = solveCharge(H, { method, tol: 1e-10 });
        assert.ok(s.stats.converged, method);
        assert.deepEqual(s.stats.path, [method]);
        sol[method] = s.phi;
    }
    const d = (a, b) => { let m = 0; for (let k = 0; k < a.length; k++) m = Math.max(m, Math.abs(a[k] - b[k])); return m; };
    const worst = Math.max(d(sol.multigrid, sol.krylov), d(sol.multigrid, sol.sor), d(sol.krylov, sol.sor));
    assert.ok(worst <= 1e-9 * SIN_PHI0, `methods differ by ${worst} V`);
    // chargeScale bounds the potential (comparison principle) within a small factor
    const sc = chargeScale(H[0], H[0].source);
    assert.ok(sc >= SIN_PHI0 && sc <= 4 * SIN_PHI0, `scale ${sc} vs max ${SIN_PHI0}`);
});

test('G2 superposition with space charge: the direct solve equals Σ V_k φ_k + φ_ρ (1e-9); charge: false excludes the term', () => {
    const res = fixture({ h: 0.5, x: [0, 32], y: [0, 32], charge: 'rho0*sin(180*x/L)*sin(180*y/L)', paramValues: { rho0: 1e-6, L: 32 },
        electrodes: [{ id: 'gnd' }, { id: 'a' }, { id: 'b' }], shapes: [{ type: 'circle', electrode: 'a', cx: 8.3, cy: 21.1, r: 2.2 }, { type: 'box', electrode: 'b', x0: 20.2, x1: 24.7, y0: 6.1, y1: 7.3 }] });
    const geo = compileGeometry(res), H = buildHierarchy(geo, res, {});
    const b1 = solveBasis(H, 1, { tol: 1e-12 }).phi, b2 = solveBasis(H, 2, { tol: 1e-12 }).phi, bc = solveBasis(H, CHARGE_BASIS, { tol: 1e-12 }).phi;
    assert.ok(maxAbs(bc) > 1, 'the particular solution is a few volts');
    const V = [0, 3, -7];
    const d = solveVoltages(H, V, { tol: 1e-12 }), d0 = solveVoltages(H, V, { tol: 1e-12, charge: false }), dz = solveVoltages(H, [0, 0, 0], { tol: 1e-12 });
    let m = 0, m0 = 0, mz = 0;
    for (let k = 0; k < d.phi.length; k++) {
        m = Math.max(m, Math.abs(d.phi[k] - (3 * b1[k] - 7 * b2[k] + bc[k])));
        m0 = Math.max(m0, Math.abs(d0.phi[k] - (3 * b1[k] - 7 * b2[k])));
        mz = Math.max(mz, Math.abs(dz.phi[k] - bc[k]));
    }
    const scale = 7 + maxAbs(bc);
    assert.ok(m <= 1e-9 * scale, `with charge: ${m}`);
    assert.ok(m0 <= 1e-9 * scale, `without charge: ${m0}`);
    assert.ok(mz <= 1e-9 * scale, `zero voltages give the particular solution: ${mz}`);
    // a hierarchy without a source: the charge basis is zero with method 'none', and solveBasis(k) is unaffected
    const plain = { ...res, domain: { ...res.domain, charge: '' } };
    const Hp = buildHierarchy(compileGeometry(plain), plain, {});
    const z = solveBasis(Hp, CHARGE_BASIS, {});
    assert.equal(z.stats.method, 'none'); assert.equal(z.stats.source, false); assert.ok(z.phi.every((v) => v === 0));
    const b1p = solveBasis(Hp, 1, { tol: 1e-12 }).phi;
    assert.deepEqual([...b1p], [...b1], 'electrode bases do not depend on the charge');
});

/** S13 fixture: uniformly charged sphere (radius a, ρ0) inside a grounded sphere (R), cyl2d, mirrored at x = 0. */
function chargedSphere(h) {
    const a = 10, Rg = 20, rho0 = 1e-6, Ld = 24;
    const res = fixture({ type: 'cyl2d', h, x: [0, Ld], y: [0, Ld], edges: { xmin: NEU, xmax: ED(0), ymin: { bc: 'axis' }, ymax: ED(0) }, mirror: { x: true },
        charge: 'rho0*min(1, floor(a/hypot(x, r)))', paramValues: { rho0, a },
        shapes: [{ type: 'annulus', electrode: 'gnd', cx: 0, cy: 0, rIn: Rg, rOut: Rg + 8, a0: 0, a1: 360 }] });
    const am = a * 1e-3, Rm = Rg * 1e-3, Q = 4 / 3 * Math.PI * am ** 3 * rho0, kQ = Q / (4 * Math.PI * EPS0);
    const phiEx = (r) => { const rm = r * 1e-3; return rm >= am ? kQ * (1 / rm - 1 / Rm) : kQ * (1 / am - 1 / Rm) + rho0 * (am * am - rm * rm) / (6 * EPS0); };
    const eEx = (r) => { const rm = r * 1e-3; return (rm >= am ? kQ / (rm * rm) : rho0 * rm / (3 * EPS0)) * 1e-3; };
    const { model, stats } = chargeField(res);
    const e4 = new Float64Array(4), phi0 = phiEx(0);
    let pErr = 0, eOut = 0, eIn = 0;
    for (const r of [0, 2.5, 5, 7.5, 12.5, 15, 17.5]) for (const th of [10, 45, 80]) {
        model.E(0, r * Math.cos(th * DEG), r * Math.sin(th * DEG), 0, e4);
        pErr = Math.max(pErr, Math.abs(e4[3] - phiEx(r)) / phi0);
        if (r === 0) continue;
        const de = Math.abs(Math.hypot(e4[0], e4[1], e4[2]) - eEx(r)) / eEx(r);
        if (r > a) eOut = Math.max(eOut, de); else eIn = Math.max(eIn, de);
    }
    return { pErr, eOut, eIn, phi0, stats };
}

test('S13 uniformly charged sphere in a grounded sphere (cyl2d): φ to 2e-3 of φ(0) at 40 cells per radius, 1e-3 at 80; |E| inside and out', () => {
    const q = chargedSphere(0.25), f = chargedSphere(0.125);
    assert.ok(q.stats.converged && f.stats.converged);
    assert.ok(Math.abs(q.phi0 - 3.7647) < 1e-3, `φ(0) = ${q.phi0} V`);
    assert.ok(q.pErr <= 2e-3, `a = 40 cells: φ error ${q.pErr} of φ(0)`);
    assert.ok(q.eOut <= 3e-3 && q.eIn <= 2e-3, `a = 40 cells: |E| errors ${q.eOut} (outside), ${q.eIn} (inside)`);
    assert.ok(f.pErr <= 1e-3, `a = 80 cells: φ error ${f.pErr} of φ(0)`);
    assert.ok(f.eOut <= 1e-3 && f.eIn <= 1e-3, `a = 80 cells: |E| errors ${f.eOut} (outside), ${f.eIn} (inside)`);
    assert.ok(f.pErr < q.pErr && f.eOut < q.eOut, 'the finer grid is more accurate');
});

test('G1 + G2: an odd-odd charge on the quarter domain with two anti-mirror planes equals the full box (1e-9) and the closed form', () => {
    // ρ = ρ0 sin(πx/L) sin(πy/L) on [−L, L]²: odd in x and y; the exact φ has the same form
    const Lb = 32, n = 128, h = 2 * Lb / n;
    const full = fixture({ h, x: [-Lb, Lb], y: [-Lb, Lb], charge: 'rho0*sin(180*x/L)*sin(180*y/L)', paramValues: { rho0: 1e-6, L: Lb } });
    const quarter = fixture({ h, x: [0, Lb], y: [0, Lb], antimirror: { x: true, y: true }, charge: 'rho0*sin(180*x/L)*sin(180*y/L)', paramValues: { rho0: 1e-6, L: Lb } });
    const F = chargeField(full), Q = chargeField(quarter);
    assert.deepEqual(Q.H[0].grid.antimirror, { x: true, y: true });
    const gq = Q.H[0].grid, gf = F.H[0].grid, off = n / 2;
    let dn = 0, ex = 0;
    for (let j = 0; j < gq.ny; j++) for (let i = 0; i < gq.nx; i++) {
        const pq = Q.phi[j * gq.nx + i];
        dn = Math.max(dn, Math.abs(pq - F.phi[(j + off) * gf.nx + i + off]));
        ex = Math.max(ex, Math.abs(pq - SIN_PHI0 * Math.sin(Math.PI * i * h / Lb) * Math.sin(Math.PI * j * h / Lb)));
    }
    assert.ok(dn <= 1e-9 * SIN_PHI0, `quarter vs full: ${dn} V`);
    assert.ok(ex <= 1e-3 * SIN_PHI0 && ex > 1e-6, `vs closed form: ${ex} V (the discretisation error of 64 cells)`);
    // the models agree in every quadrant, the odd symmetry included
    const e1 = new Float64Array(4), e2 = new Float64Array(4);
    let d = 0;
    for (const [x, y] of [[5.3, 7.1], [-5.3, 7.1], [5.3, -7.1], [-5.3, -7.1], [-0.1, 20.4], [30.9, -0.07], [-13, -22]]) {
        assert.equal(F.model.E(0, x, y, 0, e1), Q.model.E(0, x, y, 0, e2));
        for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(e1[c] - e2[c]));
    }
    assert.ok(d <= 1e-9 * SIN_PHI0, `field difference ${d}`);
    Q.model.E(0, -5.3, -7.1, 0, e2); Q.model.E(0, 5.3, 7.1, 0, e1);
    assert.equal(e2[3], e1[3]); assert.equal(e2[0], -e1[0]); assert.equal(e2[1], -e1[1]);
});

// ---------------------------------------------------------------- G3 pole pieces (magnetic scalar potential)
const DIPOLE = (boundary = 'neumann') => ({ id: 'd', type: 'poles', enabled: true, boundary,
    pieces: [{ region: { type: 'box', x0: -10, x1: 10, y0: 5, y1: 8 }, psi: 1 }, { region: { type: 'box', x0: -10, x1: 10, y0: -8, y1: -5 }, psi: -1 }] });
const magDomain = (type, h, x, y, extra = {}) => ({ type, h, cell: h, x, y, nx: Math.round((x[1] - x[0]) / h) + 1, ny: Math.round((y[1] - y[0]) / h) + 1,
    mirror: { x: false, y: false }, antimirror: { x: false, y: false }, ...extra });
const magModel = (domain, magnets) => createFieldModel({ resolved: { domain, electrodes: [{ id: 'gnd' }], magnets, idealFields: [] } });

test('G3 pole pieces: planar dipole gap B = ΔΨ/gap to 1e-3 mid-gap (exact for the 1D gap); zero inside the iron and outside the grid; fringing', () => {
    const model = magModel(magDomain('planar2d', 0.5, [-10, 10], [-10, 10]), [DIPOLE()]);
    assert.ok(model.hasB && !model.hasRegions && !model.timeDependent);
    assert.deepEqual(model.warnings, []);
    const b = new Float64Array(3);
    for (const [x, y] of [[0, 0], [-7.3, 2.1], [8.8, -4.6], [3, 4.9], [-9.9, -4.95]]) {
        model.B(x, y, 0.7, b);
        assert.ok(Math.abs(b[1] + 0.2) <= 1e-3 * 0.2, `|B| = ΔΨ/gap at (${x}, ${y}): ${[...b]}`);
        assert.ok(Math.abs(b[1] + 0.2) <= 1e-9 && Math.abs(b[0]) <= 1e-9 && b[2] === 0, `the 1D gap is reproduced exactly: ${[...b]}`);
    }
    assert.ok(Math.abs(model.bMax - 0.2) <= 1e-6, `bMax ${model.bMax}`);
    model.B(0, 6.5, 0, b); assert.deepEqual([...b], [0, 0, 0], 'inside a piece');
    model.B(0, 12, 0, b); assert.deepEqual([...b], [0, 0, 0], 'outside the grid');
    // through compileMagnets directly: the contract shape, and no grid means no field (with a warning)
    const mc = compileMagnets([DIPOLE()], 'planar2d', magDomain('planar2d', 0.5, [-10, 10], [-10, 10]));
    assert.equal(mc.nPoles, 1); assert.ok(mc.any && mc.poles[0].stats.converged && mc.poles[0].nodes === 41 * 41);
    const o = [0, 0, 0]; mc.add(1, 1, 0, o); assert.ok(Math.abs(o[1] + 0.2) <= 1e-9);
    const m0 = compileMagnets([DIPOLE()], 'planar2d');
    assert.equal(m0.any, false); assert.equal(m0.warnings[0].code, 'W_POLES_NO_GRID');
    // a wider domain with ψ = 0 on the open edges: fringing lowers the mid-gap field and adds a longitudinal component past the pole ends
    const wide = magModel(magDomain('planar2d', 0.5, [-30, 30], [-30, 30]), [DIPOLE('zero')]);
    wide.B(0, 0, 0, b);
    assert.ok(b[1] < -0.15 && b[1] > -0.2, `fringing: mid-gap B_y ${b[1]}`);
    const bx = [];
    for (const x of [8, 10, 12, 14]) { wide.B(x, 3, 0, b); bx.push(b[0]); }
    assert.ok(Math.abs(bx[2]) > 1e-3 && Math.abs(bx[3]) > 1e-3, `fringe field past the pole end: B_x ${bx}`);
    wide.B(12, 3, 0, b); const bxUp = b[0]; wide.B(12, -3, 0, b);
    assert.ok(Math.sign(b[0]) === -Math.sign(bxUp), 'the fringe component is odd across the gap centre (the focusing fringe of an inclined edge)');
});

test('G3 pole pieces in cyl2d: coaxial poles give B_ρ = ΔΨ/(r ln(b/a)) mapped to (y, z); constant ψ inside the bore; symmetry planes', () => {
    const h = 0.125;
    const coax = [{ id: 'c', type: 'poles', boundary: 'neumann', pieces: [{ region: { type: 'box', x0: -5, x1: 5, y0: 5, y1: 8 }, psi: 1 }, { region: { type: 'box', x0: -5, x1: 5, y0: 12, y1: 15 }, psi: 0 }] }];
    const model = magModel(magDomain('cyl2d', h, [-5, 5], [0, 20]), coax);
    const b = new Float64Array(3);
    const Br = (r) => 1 / (r * Math.log(12 / 8));   // ψ = ln(12/r)/ln(1.5) in the gap
    for (const [x, y, z] of [[0, 10, 0], [2.2, 6, 8], [-3.1, -7.07, 7.07], [1, 0, 9], [4.9, 8.7, -5.3]]) {
        model.B(x, y, z, b);
        const r = Math.hypot(y, z), br = Br(r);
        assert.ok(Math.abs(b[1] - br * y / r) <= 1e-3 * br && Math.abs(b[2] - br * z / r) <= 1e-3 * br && Math.abs(b[0]) <= 1e-3 * br, `B at r ${r}: ${[...b]} vs B_ρ ${br}`);
    }
    model.B(0, 3, 0, b); assert.ok(Math.hypot(b[0], b[1], b[2]) <= 1e-9, 'constant ψ inside the bore');
    model.B(0, 17, 0, b); assert.ok(Math.hypot(b[0], b[1], b[2]) <= 1e-9, 'ψ = 0 beyond the outer piece');
    // bMax is the largest |∇ψ| over the free nodes: the first free row above the inner piece, r = 8 + h
    assert.ok(Math.abs(model.bMax - Br(8 + h)) <= 1e-3 * Br(8 + h), `bMax ${model.bMax} vs ${Br(8 + h)} at the first free node above the inner piece`);
    // the half dipole on y ≥ 0 with an anti-mirror plane (ψ odd in y) gives the full gap field, even in y
    const half = magModel(magDomain('planar2d', 0.5, [-10, 10], [0, 10], { antimirror: { x: false, y: true } }),
        [{ id: 'd', type: 'poles', boundary: 'neumann', pieces: [{ region: { type: 'box', x0: -10, x1: 10, y0: 5, y1: 8 }, psi: 1 }] }]);
    half.B(1, 2, 0, b); const by = b[1]; half.B(1, -2, 0, b);
    assert.ok(Math.abs(by + 0.2) <= 1e-9 && Math.abs(b[1] + 0.2) <= 1e-9, `anti-mirror y: B_y even, ${by} / ${b[1]}`);
    // a quadrant of a dipole with mirror x (ψ even in x): B_y even in x
    const quad = magModel(magDomain('planar2d', 0.5, [0, 10], [0, 10], { mirror: { x: true, y: false }, antimirror: { x: false, y: true } }),
        [{ id: 'd', type: 'poles', boundary: 'neumann', pieces: [{ region: { type: 'box', x0: 0, x1: 10, y0: 5, y1: 8 }, psi: 1 }] }]);
    quad.B(-4, -2, 0, b);
    assert.ok(Math.abs(b[1] + 0.2) <= 1e-9 && Math.abs(b[0]) <= 1e-9, `quadrant model: ${[...b]}`);
});
