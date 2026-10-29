// WP3 acceptance (2): schema — newProject and every defaults(kind) validate; one WP3 fixture per preset type validates
// and resolves; invalid fixtures give path-specific errors; limits; unknown keys kept; save → load → save byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../beta/ion-optics/js/engine/schema.js';
import { serializeProject, parseProject } from '../../beta/ion-optics/js/engine/io.js';
import { FIXTURES, einzel, reflectron, rfQuadrupole, vmi, magneticSector, twoTube } from './fixtures/wp3/projects.mjs';

const clone = (v) => structuredClone(v);
const codesAt = (issues, path) => issues.filter((e) => e.path === path).map((e) => e.code);
/** Applies `mutate` to a copy of `base` and asserts an error with `code` at `path`; returns the issues. */
function expectError(base, mutate, path, code, opts = {}) {
    const p = clone(base);
    mutate(p);
    const r = S.resolve(p, opts);
    assert.equal(r.resolved, null, `expected errors for ${path}`);
    const at = codesAt(r.errors, path);
    assert.ok(at.includes(code), `${path}: expected ${code}, got ${JSON.stringify(r.errors.slice(0, 5))}`);
    const v = S.validate(p, opts);
    assert.deepEqual(v.errors, r.errors, 'validate and resolve agree');
    return r;
}

test('newProject validates for both domain types', () => {
    for (const t of ['cyl2d', 'planar2d']) {
        const p = S.newProject(t);
        const v = S.validate(p);
        assert.deepEqual(v.errors, [], t);
        assert.deepEqual(v.warnings, [], t);
        const r = S.resolve(p);
        assert.equal(r.resolved.domain.type, t);
        assert.equal(r.resolved.particleCount, 0);
        assert.equal(r.resolved.electrodes.length, 1);
    }
});

test('every defaults(kind) validates in context', () => {
    for (const t of ['cyl2d', 'planar2d']) {
        const ok = (p, what) => { const v = S.validate(p); assert.deepEqual(v.errors, [], `${t} ${what}: ${JSON.stringify(v.errors)}`); };
        const base = () => S.newProject(t);
        // whole objects
        for (const kind of ['project']) ok(S.defaults(kind, t), kind);
        for (const kind of ['meta', 'domain', 'recording', 'tracer', 'solver', 'analysis', 'view']) { const p = base(); p[kind] = S.defaults(kind, t); ok(p, kind); }
        // electrodes, terms, waves
        { const p = base(); p.electrodes.push(S.defaults('electrode', t)); ok(p, 'electrode'); }
        { const p = base(); p.electrodes[0] = S.defaults('gnd', t); ok(p, 'gnd'); }
        for (const term of ['cos', 'pulse', 'table']) { const p = base(); p.electrodes.push({ ...S.defaults('electrode', t), wave: { terms: [S.defaults(`term.${term}`, t)] } }); ok(p, `term.${term}`); }
        { const p = base(); p.electrodes.push({ ...S.defaults('electrode', t), wave: S.defaults('wave', t) }); ok(p, 'wave'); }
        // params and sliders
        { const p = base(); p.params.push({ ...S.defaults('param', t), slider: S.defaults('slider', t) }); ok(p, 'param'); }
        // edges and profile segments
        { const p = base(); p.domain.edges.xmax = S.defaults('edge', t); ok(p, 'edge'); }
        { const p = base(); const s = S.defaults('segment', t); p.domain.edges.ymax = { bc: 'profile', segments: [{ ...s, from: p.domain.x[0], to: p.domain.x[1] }] }; ok(p, 'segment'); }
        // shapes with and without transforms
        for (const st of S.ENUMS.shapeType) {
            const p = base(); p.shapes.push(S.defaults(st, t)); ok(p, st);
            const q = base(); q.shapes.push({ ...S.defaults(`shape.${st}`, t), transform: S.defaults('transform', t) }); ok(q, `shape.${st}+transform`);
        }
        // magnets, regions, ideal fields
        for (const m of ['uniform', 'region', 'loop']) { const p = base(); p.magnets.push(S.defaults(`magnet.${m}`, t)); ok(p, `magnet.${m}`); }
        for (const g of ['box', 'polygon', 'annulus']) { const p = base(); p.magnets.push({ ...S.defaults('magnet.region', t), region: S.defaults(`region.${g}`, t) }); ok(p, `region.${g}`); }
        for (const f of S.ENUMS.idealType) { const p = base(); p.idealFields.push(S.defaults(`ideal.${f}`, t)); ok(p, `ideal.${f}`); }
        { const p = base(); p.idealFields.push(S.defaults('idealField', t)); ok(p, 'idealField'); }
        // sources and every card type
        { const p = base(); p.sources.push(S.defaults('source', t)); ok(p, 'source'); }
        { const p = base(); p.sources.push({ ...S.defaults('source', t), species: [S.defaults('species', t)] }); ok(p, 'species'); }
        for (const [card, types] of [['position', S.ENUMS.positionType], ['direction', S.ENUMS.directionType], ['energy', S.ENUMS.energyType], ['time', S.ENUMS.timeType]]) {
            for (const ty of types) { const p = base(); p.sources.push({ ...S.defaults('source', t), [card]: S.defaults(`${card}.${ty}`, t) }); ok(p, `${card}.${ty}`); }
        }
        // recording
        { const p = base(); p.recording.planes.push(S.defaults('plane', t)); p.recording.trajectories = S.defaults('trajectories', t); p.recording.timeMarkers = S.defaults('timeMarkers', t); ok(p, 'plane'); }
        // tracer options
        { const p = base(); p.tracer = { ...S.defaults('tracer', t), quality: 'custom', custom: S.defaults('custom', t), drag: S.defaults('drag', t) }; ok(p, 'custom'); }
        // analysis settings (soft: never errors, also no warnings with valid references)
        { const p = base(); p.analysis = { lens: S.defaults('lens', t), scan: S.defaults('scan', t), optimize: S.defaults('optimize', t), waist: S.defaults('waist', t) }; ok(p, 'analysis'); }
        { const p = base(); p.view = { ...S.defaults('view', t), layers: S.defaults('layers', t) }; ok(p, 'layers'); }
        assert.throws(() => S.defaults('nonsense', t), (e) => e.code === 'E_INTERNAL');
    }
});

test('META describes every object type with valid descriptors', () => {
    const KINDS = ['number', 'int', 'bool', 'select', 'text', 'textarea', 'color', 'electrode', 'vec2', 'vec3', 'vec4', 'range2', 'points', 'list'];
    for (const [type, list] of Object.entries(S.META)) {
        assert.ok(Array.isArray(list) && list.length, type);
        for (const d of list) {
            assert.equal(typeof d.key, 'string', `${type}`);
            assert.equal(typeof d.label, 'string', `${type}.${d.key}`);
            assert.ok(KINDS.includes(d.kind), `${type}.${d.key}: ${d.kind}`);
            assert.equal(typeof d.dim, 'string', `${type}.${d.key}`);
            assert.equal(typeof d.help, 'string', `${type}.${d.key}`);
            if (d.kind === 'select' && d.options) for (const o of d.options) assert.ok('value' in o && typeof o.label === 'string', `${type}.${d.key}`);
            if (d.kind === 'points') assert.ok(Array.isArray(d.dims) && d.dims.length === d.size, `${type}.${d.key}`);
        }
    }
    for (const st of S.ENUMS.shapeType) assert.ok(S.META[`shape.${st}`], st);
    for (const ty of S.ENUMS.positionType) assert.ok(S.META[`position.${ty}`], ty);
    for (const ty of S.ENUMS.idealType) assert.ok(S.META[`ideal.${ty}`], ty);
    // every descriptor of a shape type names a field its defaults() carry
    for (const st of S.ENUMS.shapeType) for (const d of S.META[`shape.${st}`]) assert.ok(d.key in S.defaults(st), `${st}.${d.key}`);
    for (const ty of S.ENUMS.positionType) for (const d of S.META[`position.${ty}`]) assert.ok(d.key in S.defaults(`position.${ty}`), `position.${ty}.${d.key}`);
    for (const d of S.META.electrode) assert.ok(d.key === 'transmission' || d.key in S.defaults('electrode'), d.key);
});

test('one fixture per preset type validates and resolves', () => {
    assert.equal(Object.keys(FIXTURES).length, 11);
    for (const [id, make] of Object.entries(FIXTURES)) {
        const p = make();
        const before = JSON.stringify(p);
        const v = S.validate(p);
        assert.deepEqual(v.errors, [], `${id}: ${JSON.stringify(v.errors)}`);
        const { resolved: R, errors } = S.resolve(p);
        assert.deepEqual(errors, [], id);
        const d = R.domain;
        assert.equal(d.nx, Math.round((p.domain.x[1] - p.domain.x[0]) / p.domain.cell) + 1, id);
        assert.equal(d.N, d.nx * d.ny, id);
        assert.equal(d.h, p.domain.cell, id);
        R.electrodes.forEach((e, i) => { assert.equal(e.index, i); assert.equal(typeof e.dc, 'number'); assert.ok(Array.isArray(e.terms)); assert.equal(typeof e.transparent, 'boolean'); });
        for (const s of R.shapes) assert.ok(Number.isInteger(s.electrodeIndex) && s.electrodeIndex >= -1 && s.electrodeIndex < R.electrodes.length, id);
        let first = 0;
        R.sources.forEach((s, k) => { assert.equal(s.index, k); assert.equal(s.firstId, first); first += s.count; });
        assert.equal(R.particleCount, first, id);
        for (const k of ['rtol', 'maxStepCells', 'nearStepCells', 'rfStepsPerPeriod', 'borisStepsPerGyration']) assert.equal(typeof R.tracer.q[k], 'number', `${id} q.${k}`);
        assert.equal(typeof R.paramValues, 'object');
        // the project is never modified by validation or resolution
        assert.equal(JSON.stringify(p), before, id);
    }
});

test('resolution evaluates expressions, ids, counts and channels', () => {
    const R = S.resolve(einzel()).resolved;
    assert.deepEqual(R.paramValues, { D: 20, Vc: 850 });
    assert.deepEqual(R.shapes.map((s) => [s.x0, s.x1, s.rIn, s.rOut, s.electrodeIndex]), [[-55, -6, 10, 11, 1], [-4, 4, 10, 11, 2], [6, 55, 10, 11, 1]]);
    assert.deepEqual(R.electrodes.map((e) => e.dc), [0, 0, 850]);
    assert.equal(R.domain.edges.xmin.electrodeIndex, 0);
    assert.equal(R.particleCount, 21);
    assert.deepEqual(R.tracer.q, { rtol: 1e-8, maxStepCells: 0.5, nearStepCells: 0.1, rfStepsPerPeriod: 32, borisStepsPerGyration: 128 });
    const V = S.resolve(vmi()).resolved;
    assert.equal(V.particleCount, 1 * 15 * 12 * 2, 'grid sampling: species × positions × directions × energies × times');
    assert.ok(Math.abs(V.electrodes[2].dc - 0.695 * 3000) < 1e-9);
    const Q = S.resolve(rfQuadrupole()).resolved;
    assert.equal(Q.channelCount, 1, 'X rods −V cos Ωt and Y rods +V cos Ωt share one channel');
    assert.ok(Math.abs(Q.electrodes[1].dc - 0.15945 * 136.783) < 1e-12);
    assert.equal(Q.electrodes[1].terms[0].amp, -136.783);
    const Rf = S.resolve(reflectron()).resolved;
    assert.deepEqual(Rf.electrodes.map((e) => e.transparent), [false, false, true, true, false]);
    assert.deepEqual(Rf.domain.edges.ymax.segments.map((s) => s.rampIndex || s.electrodeIndex), [0, [0, 4], 4]);
    const T = S.resolve(twoTube()).resolved;
    assert.deepEqual(T.domain.edges.ymax.segments.map((s) => [s.from, s.to]), [[-90, -1], [-1, 1], [1, 70]]);
    const M = S.resolve(magneticSector()).resolved;
    assert.equal(M.electrodes.length, 1);
    assert.deepEqual(M.magnets[0].B, [0, 0, -0.455286]);
});

test('extents that are not whole cells are rounded in the resolved project only (W_EXTENT_ROUNDED)', () => {
    const p = S.newProject('planar2d');
    p.domain.x = [0, 10.1]; p.domain.y = [-1, 1.02]; p.domain.cell = 0.25;
    const r = S.resolve(p);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.resolved.domain.x, [0, 10]);
    assert.ok(Math.abs(r.resolved.domain.y[1] - 1) < 1e-12);
    assert.deepEqual(codesAt(r.warnings, 'domain.x'), ['W_EXTENT_ROUNDED']);
    assert.deepEqual(codesAt(r.warnings, 'domain.y'), ['W_EXTENT_ROUNDED']);
    assert.deepEqual(p.domain.x, [0, 10.1], 'the project is unchanged');
    p.domain.x = [0, 10 + 1e-9]; p.domain.y = [-1, 1];
    assert.deepEqual(S.resolve(p).warnings, [], 'sub-1e-6-cell differences are not rounded');
});

test('invalid fixtures give path-specific errors', () => {
    const E = einzel();
    expectError(E, (p) => { p.shapes[1].electrode = 'nope'; }, 'shapes[1].electrode', 'E_REF');
    expectError(E, (p) => { p.shapes[0].x1 = '-0.3*D +'; }, 'shapes[0].x1', 'E_EXPR_SYNTAX');
    expectError(E, (p) => { p.shapes[0].x1 = 'Q*2'; }, 'shapes[0].x1', 'E_EXPR_UNKNOWN');
    expectError(E, (p) => { p.shapes[2].rOut = 5; }, 'shapes[2].rOut', 'E_RANGE');
    expectError(E, (p) => { p.shapes[0].type = 'blob'; }, 'shapes[0].type', 'E_ENUM');
    expectError(E, (p) => { p.shapes[1].id = 's1'; }, 'shapes[1].id', 'E_DUPLICATE_ID');
    expectError(E, (p) => { delete p.shapes[0].electrode; }, 'shapes[0].electrode', 'E_REQUIRED');
    expectError(E, (p) => { p.domain.cell = 0; }, 'domain.cell', 'E_RANGE');
    expectError(E, (p) => { p.domain.cell = '-1'; }, 'domain.cell', 'E_RANGE');
    expectError(E, (p) => { p.domain.x = [10, 0]; }, 'domain.x', 'E_RANGE');
    expectError(E, (p) => { p.domain.y = [1, 16]; }, 'domain.y[0]', 'E_DOMAIN_AXIS');
    expectError(E, (p) => { p.domain.type = 'planar3d'; }, 'domain.type', 'E_UNSUPPORTED');
    expectError(E, (p) => { p.domain.edges.ymin = { bc: 'dirichlet', electrode: 'gnd' }; }, 'domain.edges.ymin.bc', 'E_EDGE');
    expectError(E, (p) => { p.domain.edges.xmax = { bc: 'axis' }; }, 'domain.edges.xmax.bc', 'E_EDGE');
    expectError(E, (p) => { p.domain.edges.xmin = { bc: 'dirichlet', electrode: 'nope' }; }, 'domain.edges.xmin.electrode', 'E_REF');
    expectError(E, (p) => { p.domain.edges.ymax = { bc: 'profile', segments: [{ from: -60, to: 0, electrode: 'gnd' }, { from: 1, to: 140, electrode: 'outer' }] }; }, 'domain.edges.ymax.segments', 'E_PROFILE');
    expectError(E, (p) => { p.domain.edges.ymax = { bc: 'profile', segments: [{ from: -60, to: 140, ramp: ['gnd'] }] }; }, 'domain.edges.ymax.segments[0].ramp', 'E_TYPE');
    expectError(E, (p) => { p.domain.mirror = { x: true, y: false }; }, 'domain.x[0]', 'E_MIRROR');
    expectError(E, (p) => { p.domain.mirror = { x: true, y: false }; p.domain.x = [0, 140]; }, 'domain.edges.xmin.bc', 'E_MIRROR');
    expectError(E, (p) => { p.domain.mirror = { x: false, y: true }; }, 'domain.mirror.y', 'E_MIRROR');
    expectError(E, (p) => { p.domain.beyond.xmax = 'teleport'; }, 'domain.beyond.xmax', 'E_ENUM');
    expectError(E, (p) => { p.electrodes[0].id = 'ground'; }, 'electrodes[0]', 'E_GND');
    expectError(E, (p) => { p.electrodes[2].id = 'outer'; }, 'electrodes[2].id', 'E_DUPLICATE_ID');
    expectError(E, (p) => { p.electrodes[2].id = 'bad id!'; }, 'electrodes[2].id', 'E_ID');
    expectError(E, (p) => { p.electrodes[1].ground = true; }, 'electrodes[1]', 'E_GND');
    expectError(E, (p) => { p.electrodes[2].kind = 'grid'; p.electrodes[2].transmission = 1.5; }, 'electrodes[2].transmission', 'E_RANGE');
    expectError(E, (p) => { p.electrodes[2].wave = { terms: [{ type: 'cos', amp: 10, freq: -1 }] }; }, 'electrodes[2].wave.terms[0].freq', 'E_RANGE');
    expectError(E, (p) => { p.electrodes[2].wave = { terms: [{ type: 'table', points: [[0, 0], [0, 1]] }] }; }, 'electrodes[2].wave.terms[0].points[1][0]', 'E_RANGE');
    expectError(E, (p) => { p.sources[0].species[0].mass = 0; }, 'sources[0].species[0].mass', 'E_RANGE');
    expectError(E, (p) => { p.sources[0].species[0].charge = 0; }, 'sources[0].species[0].charge', 'E_RANGE');
    expectError(E, (p) => { p.sources[0].position.type = 'blob'; }, 'sources[0].position.type', 'E_ENUM');
    expectError(E, (p) => { p.sources[0].position.n = 2.5; }, 'sources[0].position.n', 'E_NOT_INTEGER');
    expectError(E, (p) => { p.sources[0].direction = { type: 'fixed', dir: [0, 0, 0] }; }, 'sources[0].direction.dir', 'E_RANGE');
    expectError(E, (p) => { p.sources[0].energy = { type: 'gaussian', mean: 100, fwhm: 1 }; }, 'sources[0].energy.type', 'E_SAMPLING');
    expectError(E, (p) => { p.sources[0].sampling = 'random'; p.sources[0].count = -1; }, 'sources[0].count', 'E_RANGE');
    expectError(magneticSector(), (p) => { p.recording.planes[0].kind = 'r'; }, 'recording.planes[0].kind', 'E_ENUM');   // r planes need cyl2d
    expectError(E, (p) => { p.recording.planes[0].kind = 'r'; p.recording.planes[0].at = 0; }, 'recording.planes[0].at', 'E_RANGE');
    expectError(E, (p) => { p.recording.planes[0].side = 'up'; }, 'recording.planes[0].side', 'E_ENUM');
    expectError(E, (p) => { p.tracer.quality = 'custom'; p.tracer.custom = { maxStepCells: 2 }; }, 'tracer.custom.maxStepCells', 'E_RANGE');
    expectError(E, (p) => { p.tracer.quality = 'custom'; p.tracer.custom = { maxStepCells: 0.2, nearStepCells: 0.5 }; }, 'tracer.custom.nearStepCells', 'E_RANGE');
    expectError(E, (p) => { p.tracer.maxSteps = 0; }, 'tracer.maxSteps', 'E_RANGE');
    expectError(E, (p) => { p.solver.tol = 0; }, 'solver.tol', 'E_RANGE');
    expectError(E, (p) => { p.solver.method = 'magic'; }, 'solver.method', 'E_ENUM');
    expectError(E, (p) => { p.params[1].value = 'Vc + 1'; }, 'params[1].value', 'E_PARAM_CYCLE');
    expectError(E, (p) => { p.params.push({ name: 'D', value: 1 }); }, 'params[2].name', 'E_PARAM_DUPLICATE');
    expectError(E, (p) => { p.version = 2; }, 'version', 'E_VERSION');
    expectError(E, (p) => { p.magnets.push({ id: 'm1', type: 'region', B: [0, 0, 1], region: { type: 'box', x0: 0, x1: 1, y0: 0, y1: 1 } }); }, 'magnets[0].B', 'E_REGION_AXIAL');
    expectError(E, (p) => { p.magnets.push({ id: 'm1', type: 'loop', center: [0, 0, 0], normal: [1, 0, 0], radius: 0, current: 1 }); }, 'magnets[0].radius', 'E_RANGE');
    expectError(E, (p) => { p.idealFields.push({ id: 'f1', type: 'coax', a: 5, b: 2 }); }, 'idealFields[0].b', 'E_RANGE');
    expectError(rfQuadrupole(), (p) => { p.shapes[0].transform = { rotate: 45 }; }, 'shapes[0].transform.rotate', 'E_QUADRIC_ROTATION');
    expectError(rfQuadrupole(), (p) => { p.shapes[0].clip = [0, 1, 2, 1]; }, 'shapes[0].clip', 'E_RANGE');
    // not a project at all
    for (const bad of [null, 42, 'x', [1]]) { const r = S.resolve(bad); assert.equal(r.resolved, null); assert.equal(r.errors[0].code, 'E_BAD_PROJECT'); }
    const fr = S.resolve({ ...einzel(), format: 'something-else' });
    assert.deepEqual([fr.errors[0].path, fr.errors[0].code], ['format', 'E_BAD_PROJECT']);
});

test('more than seven waveform shapes (time channels) are refused', () => {
    const p = einzel();
    for (let k = 0; k < 8; k++) p.electrodes.push({ id: `rf${k}`, name: `RF ${k}`, kind: 'solid', v: 0, wave: { terms: [{ type: 'cos', amp: 10, freq: 1 + k, phase: 0 }] }, color: '#2563eb' });
    const r = S.resolve(p);
    assert.ok(codesAt(r.errors, 'electrodes').includes('E_CHANNELS'));
    p.electrodes.pop();
    assert.deepEqual(S.resolve(p).errors, []);
    assert.equal(S.resolve(p).resolved.channelCount, 7);
});

test('disabled items are dropped, and their errors are only warnings', () => {
    const p = einzel();
    p.shapes.unshift({ id: 's0', type: 'box', electrode: 'nope', x0: 0, x1: 1, y0: 0, y1: 1, enabled: false });
    p.sources.unshift({ ...S.defaults('source'), id: 'b0', enabled: false, count: 5 });
    const r = S.resolve(p);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(codesAt(r.warnings, 'shapes[0].electrode'), ['E_REF']);
    assert.equal(r.resolved.shapes.length, 3);
    assert.equal(r.resolved.shapes[0].srcIndex, 1);
    assert.equal(S.projectPath(r.resolved, 'shapes[0].x1'), 'shapes[1].x1');
    assert.equal(S.projectPath(r.resolved, 'domain.cell'), 'domain.cell');
    assert.equal(r.resolved.particleCount, 21);
    assert.equal(r.resolved.sources[0].firstId, 0);
});

test('limits (desktop and phone)', () => {
    const big = (cell) => { const p = S.newProject('planar2d'); p.domain.x = [0, 100]; p.domain.y = [0, 100]; p.domain.cell = cell; return p; };
    expectError(big(0.04), () => {}, 'domain.cell', 'E_GRID_TOO_LARGE');                 // 2501² = 6.3M nodes
    assert.ok(codesAt(S.resolve(big(0.08)).warnings, 'domain.cell').includes('W_GRID_LARGE'));   // 1.56M: warn
    assert.deepEqual(S.resolve(big(0.08)).errors, []);
    expectError(big(0.12), () => {}, 'domain.cell', 'E_GRID_TOO_LARGE', { mobile: true });   // 835² = 0.7M > 4e5
    const parts = (n) => { const p = einzel(); p.sources[0] = { ...p.sources[0], sampling: 'random', count: n }; return p; };
    expectError(parts(1e6 + 1), () => {}, 'sources', 'E_LIMIT');
    assert.deepEqual(S.resolve(parts(1e6)).errors, []);
    expectError(parts(2e4 + 1), () => {}, 'sources', 'E_LIMIT', { mobile: true });
    const E = einzel();
    expectError(E, (p) => { for (let k = 0; k < 30; k++) p.electrodes.push({ id: `e${k}`, kind: 'solid', v: 0 }); }, 'electrodes', 'E_LIMIT');
    expectError(E, (p) => { for (let k = 0; k < 1998; k++) p.shapes.push({ id: `x${k}`, type: 'circle', electrode: 'gnd', cx: 0, cy: 14, r: 0.1 }); }, 'shapes', 'E_LIMIT');
    expectError(E, (p) => { for (let k = 0; k < 50; k++) p.sources.push({ ...S.defaults('source'), id: `q${k}`, count: 1 }); }, 'sources', 'E_LIMIT');
    expectError(E, (p) => { for (let k = 0; k < 32; k++) p.recording.planes.push({ ...S.defaults('plane'), id: `pl${k}` }); }, 'recording.planes', 'E_LIMIT');
    expectError(E, (p) => { for (let k = 0; k < 33; k++) p.magnets.push({ id: `m${k}`, type: 'uniform', B: [0.001, 0, 0] }); }, 'magnets', 'E_LIMIT');
    expectError(E, (p) => { for (let k = 0; k < 501; k++) p.params.push({ name: `p${k}`, value: k }); }, 'params', 'E_LIMIT');
    // trajectory points beyond the budget: a warning, not an error
    const w = S.resolve(parts(2000));
    assert.ok(codesAt(w.warnings, 'recording.trajectories.maxPoints').includes('W_TRAJ_THINNED'));
    assert.equal(w.resolved.limits.pointBudget, 2e6);
    assert.equal(S.resolve(einzel(), { mobile: true }).resolved.limits.mobile, true);
});

test('integer fields accept expressions that evaluate to integers', () => {
    const p = einzel();
    p.params.push({ name: 'n', value: 7 });
    p.sources[0].position.n = '3*n';
    assert.equal(S.resolve(p).resolved.particleCount, 21);
    p.sources[0].position.n = 'n/2';
    expectError(p, () => {}, 'sources[0].position.n', 'E_NOT_INTEGER');
    const q = einzel();
    q.sources[0].sampling = 'random'; q.sources[0].count = '2*5';
    assert.equal(S.resolve(q).resolved.particleCount, 10);
});

test('unknown keys are kept, and save → load → save is byte-identical', () => {
    for (const [id, make] of Object.entries(FIXTURES)) {
        const p = make();
        p.custom = { note: 'keep me', list: [1, 2] };
        p.shapes.forEach((s) => { s.myTag = id; });
        p.domain.extra = true;
        const r = S.resolve(p);
        assert.deepEqual(r.errors, [], id);
        assert.deepEqual(r.resolved.custom, { note: 'keep me', list: [1, 2] }, id);
        assert.ok(r.resolved.shapes.every((s) => s.myTag === id), id);
        assert.equal(r.resolved.domain.extra, true, id);
        const text = serializeProject(p);
        const back = parseProject(text);
        assert.deepEqual(back, S.migrate(p), id);
        assert.equal(serializeProject(back), text, `${id}: save → load → save`);
        assert.equal(back.custom.note, 'keep me');
    }
});

test('migrate fills missing sections; foreign formats are refused', () => {
    const m = S.migrate({ domain: { type: 'planar2d', cell: 1, x: [0, 10], y: [0, 10] } });
    assert.equal(m.format, 'ion-optics-project');
    assert.equal(m.version, 1);
    for (const k of ['meta', 'params', 'electrodes', 'shapes', 'magnets', 'idealFields', 'sources', 'recording', 'tracer', 'solver', 'analysis', 'view']) assert.ok(k in m, k);
    assert.equal(m.electrodes[0].id, 'gnd');
    assert.deepEqual(S.validate(m).errors, []);
    assert.throws(() => S.migrate({ format: 'other' }), (e) => e.code === 'E_BAD_PROJECT');
    const src = einzel();
    const copy = S.migrate(src);
    copy.shapes[0].x0 = 999;
    assert.equal(src.shapes[0].x0, -55, 'migrate returns a copy');
});

test('getPath / setPath / nextId helpers', () => {
    const p = einzel();
    assert.equal(S.getPath(p, 'shapes[1].x1'), '0.2*D');
    assert.equal(S.getPath(p, 'domain.edges.ymax.bc'), 'dirichlet');
    assert.equal(S.getPath(p, 'shapes[9].x1'), undefined);
    S.setPath(p, 'domain.mirror.x', true);
    assert.equal(p.domain.mirror.x, true);
    S.setPath(p, 'analysis.lens.D', 20);
    assert.equal(p.analysis.lens.D, 20);
    assert.throws(() => S.setPath(p, '__proto__.polluted', 1), (e) => e.code === 'E_BAD_PROJECT');
    assert.equal({}.polluted, undefined);
    assert.equal(S.nextId(p.shapes, 's'), 's4');
    assert.equal(S.nextId([], 'e'), 'e1');
});

test('robustness: corrupted projects never break resolve(), and accepted ones feed the engine', async () => {
    const G = await import('../../beta/ion-optics/js/engine/geometry.js');
    const RA = await import('../../beta/ion-optics/js/engine/raster.js');
    const PA = await import('../../beta/ion-optics/js/engine/particles.js');
    const WF = await import('../../beta/ion-optics/js/engine/waveform.js');
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const WEIRD = [null, undefined, {}, [], 'x', '', '1/0', 'sin(', -1, 0, NaN, Infinity, -Infinity, 1e308, true, [1], [[1, 2]], { a: 1 }, '__proto__', [null, null], -0, 2 ** 53, 'gnd', [1, 2, 3, 4, 5]];
    const paths = (o, base = '', out = []) => {
        if (o && typeof o === 'object') for (const k of Object.keys(o)) { const p = Array.isArray(o) ? `${base}[${k}]` : (base ? `${base}.${k}` : k); out.push(p); paths(o[k], p, out); }
        return out;
    };
    const ids = Object.keys(FIXTURES);
    let accepted = 0;
    for (let it = 0; it < 1500; it++) {
        const p = FIXTURES[pick(ids)]();
        const all = paths(p);
        for (let j = 1 + Math.floor(rnd() * 3); j > 0; j--) { try { S.setPath(p, pick(all), structuredClone(pick(WEIRD))); } catch (e) { /* prototype paths are refused */ } }
        const r = S.resolve(p);
        for (const e of [...r.errors, ...r.warnings]) {
            assert.ok(typeof e.path === 'string' && typeof e.code === 'string' && typeof e.message === 'string', JSON.stringify(e));
            assert.notEqual(e.code, 'E_INTERNAL', e.message);
        }
        assert.deepEqual(S.validate(p).errors, r.errors);
        if (!r.resolved) continue;
        accepted++;
        const R = r.resolved;
        assert.ok(R.domain.N > 0 && R.domain.N <= 4e6 && Number.isInteger(R.domain.nx) && Number.isInteger(R.domain.ny));
        const g = G.compileGeometry(R);
        RA.makeGrid(R.domain, 0);
        PA.generate(R.sources, 0, Math.min(R.particleCount, 10), { domainType: R.domain.type, relativistic: true });
        WF.timeFunctions(R.electrodes);
        if (R.domain.N <= 30000) RA.rasterize(g, RA.makeGrid(R.domain, 0), R, { boundary: R.solver.boundary });
    }
    assert.ok(accepted > 30, `${accepted} corrupted projects were still valid (the accepted branch must be exercised)`);
});
