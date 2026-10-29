// WP1 contract (spec 2.3, 7.2 M1): every WP1 export exists with its signature and returns structurally
// valid objects; engine purity (H5) and vocabulary (H1, H2) for the WP1 files.
// Run: node --test "_tests/ionoptics/wp1-*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as G from '../../beta/ion-optics/js/engine/geometry.js';
import * as R from '../../beta/ion-optics/js/engine/raster.js';
import * as O from '../../beta/ion-optics/js/engine/operator.js';
import * as S from '../../beta/ion-optics/js/engine/solve.js';
import * as F from '../../beta/ion-optics/js/engine/field.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, '../../beta/ion-optics/js/engine');
const WP1_FILES = ['geometry.js', 'raster.js', 'operator.js', 'solve.js', 'field.js'];

function smallProject(type = 'planar2d') {
    const cyl = type === 'cyl2d';
    return {
        domain: { type, cell: 0.5, h: 0.5, x: [-10, 10], y: cyl ? [0, 6] : [-6, 6], nx: 41, ny: cyl ? 13 : 25,
            edges: { xmin: { bc: 'dirichlet', electrode: 'gnd' }, xmax: { bc: 'dirichlet', electrode: 'gnd' }, ymin: cyl ? { bc: 'axis' } : { bc: 'dirichlet', electrode: 'gnd' }, ymax: { bc: 'dirichlet', electrode: 'gnd' } },
            mirror: { x: false, y: false } },
        electrodes: [{ id: 'gnd', name: 'Ground', ground: true }, { id: 'a', name: 'A', kind: 'solid', v: 100 }, { id: 'm', name: 'Mesh', kind: 'grid', transmission: 0.8, v: 0 }],
        shapes: [
            { id: 's1', type: 'tube', electrode: 'a', x0: -4, x1: 4, rIn: 3, rOut: 4 },
            { id: 's2', type: 'polyline', electrode: 'm', points: [[6.2, -5], [6.2, 5]] },
            { id: 's3', type: 'circle', electrode: 'a', cx: -7, cy: 1.5, r: 0.8 },
        ],
    };
}

test('WP1 exports exist with the documented arity', () => {
    assert.deepEqual(G.SHAPE_TYPES, ['box', 'tube', 'plate', 'disc', 'circle', 'annulus', 'polygon', 'polyline', 'quadric']);
    const fns = [
        [G, 'compileGeometry', 1], [G, 'geometryWarnings', 2],
        [R, 'makeGrid', 1], [R, 'rasterize', 3], [R, 'packRaster', 1], [R, 'unpackRaster', 1],
        [O, 'buildOperator', 1], [O, 'buildHierarchy', 2], [O, 'basisSetup', 4], [O, 'voltageSetup', 4], [O, 'customBoundarySetup', 4], [O, 'residualMax', 3],
        [S, 'solveBasis', 2], [S, 'solveVoltages', 2], [S, 'multigridSolve', 3], [S, 'bicgstabMG', 3], [S, 'carreSOR', 3], [S, 'omegaBox', 1], [S, 'estimate', 1],
        [F, 'combine', 3], [F, 'createFieldGrid', 2],
    ];
    for (const [mod, name, minArity] of fns) {
        assert.equal(typeof mod[name], 'function', name);
        assert.ok(mod[name].length >= minArity, `${name} arity ${mod[name].length} >= ${minArity}`);
    }
});

test('Geometry has the documented shape', () => {
    const res = smallProject();
    const g = G.compileGeometry(res);
    assert.equal(g.type, 'planar2d');
    assert.ok(g.eps > 0 && Math.abs(g.eps - 1e-9 * 0.5) < 1e-20);
    assert.equal(g.nElectrodes, 3);
    assert.ok(g.transparent instanceof Uint8Array);
    assert.deepEqual([...g.transparent], [0, 0, 1]);
    assert.ok(Array.isArray(g.prims) && g.prims.length === 4);   // tube = two rectangles in planar2d
    for (const p of g.prims) {
        assert.ok(['rect', 'circle', 'annulus', 'polygon', 'polyline', 'quadric'].includes(p.kind));
        assert.equal(typeof p.electrode, 'number');
        assert.ok(p.bbox && Number.isFinite(p.bbox.x0) && p.bbox.x1 >= p.bbox.x0);
        assert.equal(typeof p.contains, 'function');
        assert.equal(typeof p.intervals, 'function');
        assert.ok(p.params && typeof p.params === 'object');
    }
    assert.ok(g.bbox && g.bbox.x0 <= g.bbox.x1);
    assert.equal(g.classify(0, 3.5), 1);
    assert.equal(g.classify(0, 0), -1);
    assert.equal(g.classify(6.2, 0), 2);
    const comp = G.newComposition();
    const c = g.compose(-10, 3.5, 20, 0, comp);
    assert.equal(c, comp);
    assert.ok(c.n >= 1 && c.t0 instanceof Float64Array && c.t1 instanceof Float64Array && c.cls instanceof Int32Array);
    for (let q = 0; q < c.n; q++) assert.ok(c.t0[q] <= c.t1[q] && (q === 0 || c.t0[q] > c.t1[q - 1]));
    const hit = g.firstNonFree(0, 0, 10, 0);
    assert.ok(hit && hit.electrode === 2 && hit.transparent === true && Math.abs(hit.t - 0.62) < 1e-6);
    assert.equal(g.firstNonFree(0, 0, 10, 0, true), null);
    const outl = g.outlines();
    assert.ok(Array.isArray(outl) && outl.length >= 4);
    for (const o of outl) assert.ok(typeof o.prim === 'number' && typeof o.closed === 'boolean' && o.pts instanceof Float64Array && o.pts.length >= 4);
    const inBox = g.primsInBox(-1, 2.5, 1, 4.5);
    assert.ok(inBox instanceof Int32Array && inBox.length === 1);
    const w = G.geometryWarnings(g, res);
    assert.ok(Array.isArray(w));
    for (const iss of w) assert.ok(typeof iss.path === 'string' && typeof iss.code === 'string' && typeof iss.message === 'string');
});

test('Grid and Raster have the documented shape; pack/unpack round trip', () => {
    const res = smallProject('cyl2d');
    const g = G.compileGeometry(res);
    const grid = R.makeGrid(res.domain, 0);
    for (const k of ['type', 'level', 'scale', 'h', 'x0', 'y0', 'nx', 'ny', 'N', 'xEnd', 'yEnd', 'offX', 'offY', 'edges', 'mirror']) assert.ok(k in grid, k);
    assert.equal(grid.N, 41 * 13);
    const g2 = R.makeGrid(res.domain, 2);
    assert.equal(g2.nx, Math.ceil(40 / 4) + 1);
    assert.equal(g2.ny, Math.ceil(12 / 4) + 1);
    const r = R.rasterize(g, grid, res, { boundary: 'subgrid', snapTheta: 1e-3 });
    assert.ok(r.cls instanceof Int16Array && r.cls.length === grid.N);
    assert.ok(r.flags instanceof Uint8Array && r.flags.length === grid.N);
    for (const k of ['count', 'node', 'dir', 'theta', 'elec']) assert.ok(k in r.cuts, k);
    assert.ok(r.cuts.node instanceof Int32Array && r.cuts.dir instanceof Uint8Array && r.cuts.theta instanceof Float64Array && r.cuts.elec instanceof Int16Array);
    for (const k of ['count', 'node', 'e', 'w']) assert.ok(k in r.mix, k);
    const nc = (grid.nx - 1) * (grid.ny - 1);
    assert.ok(r.cellType instanceof Uint8Array && r.cellType.length === nc);
    assert.ok(r.cellVis instanceof Uint8Array && r.near instanceof Uint8Array);
    for (const k of ['fixed', 'free', 'irregular', 'cuts', 'mixed', 'snapped', 'exterior', 'ms', 'issues']) assert.ok(k in r.stats, k);
    const packed = R.packRaster(r);
    assert.ok(packed.meta && Array.isArray(packed.buffers) && packed.buffers.every((b) => b instanceof ArrayBuffer));
    JSON.stringify(packed.meta);
    const u = R.unpackRaster(structuredClone(packed));
    assert.deepEqual([...u.cls], [...r.cls]);
    assert.deepEqual([...u.cuts.theta], [...r.cuts.theta]);
    assert.deepEqual([...u.cellType], [...r.cellType]);
    assert.deepEqual([...u.near], [...r.near]);
    assert.equal(u.grid.nx, grid.nx);
    // the original raster keeps its buffers (packing copies)
    assert.equal(r.cls.length, grid.N);
});

test('Operator, hierarchy, solve and field have the documented shape', () => {
    const res = smallProject('cyl2d');
    const g = G.compileGeometry(res);
    const H = O.buildHierarchy(g, res, { boundary: 'subgrid', maxLevels: 8, minNodesPerDir: 5, minFree: 1000 });
    assert.ok(Array.isArray(H) && H.length >= 1);
    const op = H[0];
    for (const k of ['grid', 'raster', 'cyl', 'rowW', 'rowN', 'rowS', 'rowD', 'mask', 'irr']) assert.ok(k in op, k);
    assert.ok(op.mask instanceof Uint8Array && op.mask.length === op.grid.N);
    for (const k of ['count', 'node', 'nb', 'c', 'diag', 'cutElec', 'red', 'black']) assert.ok(k in op.irr, k);
    assert.equal(op.irr.nb.length, 4 * op.irr.count);
    assert.deepEqual([op.rowW[0], op.rowN[0], op.rowS[0], op.rowD[0]], [1, 4, 0, 6]);
    const u = new Float64Array(op.grid.N), b = new Float64Array(op.irr.count);
    O.basisSetup(op, 1, u, b);
    assert.ok(Number.isFinite(O.residualMax(op, u, b)));
    const { phi, stats } = S.solveBasis(H, 1, { method: 'auto', tol: 1e-10 });
    assert.ok(phi instanceof Float64Array && phi.length === op.grid.N);
    for (const k of ['method', 'path', 'levels', 'cycles', 'iterations', 'sweeps', 'omega', 'rho', 'estErr', 'scaledResidual', 'converged', 'ms', 'nodes', 'free', 'irregular', 'warnings']) assert.ok(k in stats, k);
    assert.equal(stats.converged, true);
    const sv = S.solveVoltages(H, [0, 100, 0], {});
    assert.ok(sv.phi instanceof Float64Array && sv.stats.converged);
    const w = S.omegaBox(op.grid);
    assert.ok(w > 1 && w < 2);
    const est = S.estimate({ nx: 801, ny: 65 }, 2, {});
    assert.ok(est.levels >= 3 && est.msPerBasis > 0 && est.bytesPerSolveWorker === 100 * 801 * 65);
    // field
    const bases = new Map([[1, phi], [2, S.solveBasis(H, 2).phi]]);
    const comb = F.combine(bases, [0, 100, 0], op.grid.N);
    assert.ok(comb instanceof Float64Array);
    const fg = F.createFieldGrid(op.raster, g, { interp: 'cubic' });
    for (const k of ['interp', 'cyl', 'nx', 'ny', 'h', 'x0', 'y0', 'bounds', 'nChannels', 'setChannels', 'evalChannels', 'cellTypeAt', 'nearAt', 'nodal', 'bytes']) assert.ok(k in fg, k);
    fg.setChannels([comb], [new Float64Array([0, 100, 0])]);
    assert.equal(fg.nChannels, 1);
    const out = new Float64Array(3);
    const ct = fg.evalChannels(0, 1, out);
    assert.ok([0, 1, 2].includes(ct) && Number.isFinite(out[0]) && Number.isFinite(out[1]) && Number.isFinite(out[2]));
    assert.equal(fg.evalChannels(100, 1, out), 3);
    assert.ok(Number.isNaN(out[0]) && out[1] === 0 && out[2] === 0);
    const nd = fg.nodal(5);
    for (const k of ['phi', 'px', 'py', 'pxy']) assert.ok(Number.isFinite(nd[k]), k);
    assert.ok(fg.bytes() > 0);
    assert.ok([0, 1].includes(fg.nearAt(0, 1)) && [0, 1, 2].includes(fg.cellTypeAt(0, 1)));
});

function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('WP1 engine files are pure (H5): no DOM, globals, timers, console, eval', () => {
    const banned = [/\bconsole\s*\./, /\bwindow\b/, /\bdocument\b/, /\bself\b/, /\bglobalThis\b/, /\bfetch\s*\(/, /\bsetTimeout\b/, /\bsetInterval\b/, /\brequestAnimationFrame\b/,
        /\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /\bSharedArrayBuffer\b/, /\bAtomics\b/, /\bprocess\./, /\brequire\s*\(/];
    for (const f of WP1_FILES) {
        const src = fs.readFileSync(path.join(ENGINE, f), 'utf8');
        const code = stripComments(src);
        for (const re of banned) assert.ok(!re.test(code), `${f} matches ${re}`);
        for (const m of code.matchAll(/^\s*import\s+[^'"]*['"]([^'"]+)['"]/gm)) assert.ok(/^\.\/[a-z-]+\.js$/.test(m[1]), `${f} imports ${m[1]}`);
        assert.ok(/^\/\* =+\s*\n\s*Ion optics engine: /.test(src), `${f} header`);
        assert.ok(/Sources?:/.test(src.slice(0, 2500)), `${f} names its sources`);
    }
});

test('WP1 files use the project vocabulary (H1, H2)', () => {
    const word = (codes) => String.fromCharCode(...codes);
    // commercial-package terms are built from character codes so this file never trips the clean-room scan
    const banned = [new RegExp(word([115, 105, 109, 105, 111, 110]), 'i'), /\brefine/i, new RegExp(word([102, 97, 115, 116, 32, 97, 100, 106, 117, 115, 116]), 'i'), /fly'?m\b/i, /\bsplat/i, /\bPA#/, /\bT\.Qual\b/, /\bFLY2\b/i, /\bIOB\b/];
    for (const f of WP1_FILES) {
        const src = fs.readFileSync(path.join(ENGINE, f), 'utf8');
        for (const re of banned) assert.ok(!re.test(src), `${f} matches ${re}`);
    }
    for (const f of fs.readdirSync(HERE).filter((x) => x.startsWith('wp1-'))) {
        const src = fs.readFileSync(path.join(HERE, f), 'utf8');
        assert.ok(!banned[0].test(src), f);
    }
});
