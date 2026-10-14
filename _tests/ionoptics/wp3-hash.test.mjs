// WP3 acceptance (3): cache keys. geomKey is unchanged by voltage, colour, name, source and view edits and changed by
// shape, domain and edge edits; fieldKey changes with voltages, waveforms, mesh settings, magnets and interpolation;
// runKey with sources, tracer, recording and domain.beyond (spec §2.2.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from '../../beta/ion-optics/js/engine/schema.js';
import { canonicalJSON, hash64, geomKey, fieldKey, runKey, projectKeys, geomContent } from '../../beta/ion-optics/js/engine/hash.js';
import { ENGINE_VERSION } from '../../beta/ion-optics/js/engine/version.js';
import { einzel, rfQuadrupole, plateMirror } from './fixtures/wp3/projects.mjs';

function keysOf(p) {
    const r = resolve(p);
    assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
    return projectKeys(r.resolved);
}
/** Edits a copy of `make()` and reports which keys changed. */
function changed(make, edit) {
    const a = keysOf(make());
    const p = make();
    edit(p);
    const b = keysOf(p);
    return { g: a.geomKey !== b.geomKey, f: a.fieldKey !== b.fieldKey, r: a.runKey !== b.runKey };
}

test('canonicalJSON: sorted keys, shortest numbers, no whitespace, stable indentation', () => {
    assert.equal(canonicalJSON({ b: 1, a: { d: [1, 2.5, -0], c: 'x' } }), '{"a":{"c":"x","d":[1,2.5,0]},"b":1}');
    assert.equal(canonicalJSON({ x: NaN, y: Infinity, z: undefined, f() {}, n: null }), '{"n":null,"x":null,"y":null}');
    assert.equal(canonicalJSON([undefined, 1]), '[null,1]');
    assert.equal(canonicalJSON(new Float64Array([0.1, 3])), '[0.1,3]');
    assert.equal(canonicalJSON(0.1 + 0.2), '0.30000000000000004');
    assert.equal(canonicalJSON({ a: 1 }), canonicalJSON(JSON.parse('{"a":1.0}')));
    const p = einzel();
    const q = JSON.parse(JSON.stringify(p), (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v));
    assert.equal(canonicalJSON(q), canonicalJSON(p), 'key order does not matter');
    const ind = canonicalJSON({ b: [1, 2], a: { c: [[1, 2], [3, 4]] } }, 2);
    assert.equal(ind, '{\n  "a": {\n    "c": [[1, 2], [3, 4]]\n  },\n  "b": [1, 2]\n}');
    assert.deepEqual(JSON.parse(ind), { a: { c: [[1, 2], [3, 4]] }, b: [1, 2] });
});

test('hash64: 16 hex characters, deterministic, sensitive', () => {
    const h = hash64('ion optics');
    assert.match(h, /^[0-9a-f]{16}$/);
    assert.equal(hash64('ion optics'), h);
    assert.equal(hash64(''), hash64(''));
    const seen = new Set();
    for (let i = 0; i < 20000; i++) seen.add(hash64('k' + i));
    assert.equal(seen.size, 20000, 'no collisions on 20k short keys');
    // single-character changes flip about half the bits in each lane
    let bits = 0;
    for (let i = 0; i < 200; i++) {
        const a = BigInt('0x' + hash64('message ' + i)), b = BigInt('0x' + hash64('message ' + i + '.'));
        let x = a ^ b; while (x) { bits += Number(x & 1n); x >>= 1n; }
    }
    const mean = bits / 200;
    assert.ok(mean > 26 && mean < 38, `avalanche ${mean} of 64 bits`);
    assert.notEqual(hash64('ab'), hash64('ba'));
});

test('geomKey ignores voltages, colours, names, sources, recording, tracer, view and notes', () => {
    const cases = {
        'centre voltage (param)': (p) => { p.params[1].value = -8000; },
        'electrode voltage': (p) => { p.electrodes[1].v = 25; },
        'electrode waveform': (p) => { p.electrodes[2].wave = { terms: [{ type: 'cos', amp: 5, freq: 1, phase: 0 }] }; },
        'electrode kind and transmission': (p) => { p.electrodes[2].kind = 'grid'; p.electrodes[2].transmission = 0.5; },
        'electrode colour and name': (p) => { p.electrodes[1].color = '#000000'; p.electrodes[1].name = 'Renamed'; },
        'shape name and lock': (p) => { p.shapes[0].name = 'Tube A'; p.shapes[0].locked = true; },
        'shape id': (p) => { p.shapes[0].id = 'renamed'; },
        'project name and notes': (p) => { p.meta.name = 'Other'; p.meta.notes = 'n'; p.meta.modified = '2030-01-01T00:00:00Z'; },
        'source energy, count and position': (p) => { p.sources[0].energy.ke = 500; p.sources[0].position.n = 5; },
        'source colour and name': (p) => { p.sources[0].color = '#ff0000'; p.sources[0].name = 'x'; },
        'recording plane': (p) => { p.recording.planes[0].at = 120; },
        'tracer settings': (p) => { p.tracer.quality = 'fine'; p.tracer.fieldInterp = 'linear'; p.tracer.tMax = 5; },
        'beyond': (p) => { p.domain.beyond.xmax = 'stop'; },
        'view and layers': (p) => { p.view.center = [1, 2]; p.view.scale = 30; p.view.layers.contours = 5; },
        'analysis settings': (p) => { p.analysis.waist = null; p.analysis.lens = { refX: 0, D: 20, xStart: -50, xEnd: 130, mass: 100, charge: 1, keLeft: 1000 }; },
        'magnet added': (p) => { p.magnets.push({ id: 'm1', type: 'uniform', B: [0.001, 0, 0] }); },
        'ideal field added': (p) => { p.idealFields.push({ id: 'f1', type: 'uniformE', E: [1, 0, 0] }); },
        'unused parameter': (p) => { p.params.push({ name: 'unused', value: 3 }); },
    };
    for (const [name, edit] of Object.entries(cases)) assert.equal(changed(einzel, edit).g, false, name);
});

test('geomKey changes with shape, domain, edge and solver-boundary edits', () => {
    const cases = {
        'shape coordinate': (p) => { p.shapes[0].x0 = -56; },
        'shape via parameter': (p) => { p.params[0].value = 21; },
        'shape electrode': (p) => { p.shapes[1].electrode = 'outer'; },
        'shape made void': (p) => { p.shapes[1].electrode = null; },
        'shape disabled': (p) => { p.shapes[1].enabled = false; },
        'shape added': (p) => { p.shapes.push({ id: 's9', type: 'circle', electrode: 'gnd', cx: 100, cy: 5, r: 1 }); },
        'shape order': (p) => { p.shapes.reverse(); },
        'shape transform': (p) => { p.shapes[0].transform = { translate: [1, 0], rotate: 0, about: [0, 0], mirror: 'none' }; },
        'cell': (p) => { p.domain.cell = 0.5; },
        'extent': (p) => { p.domain.x = [-60, 150]; },
        'domain type': (p) => { p.domain.type = 'planar2d'; p.domain.y = [-16, 16]; p.domain.edges.ymin = { bc: 'dirichlet', electrode: 'gnd' }; },
        'edge electrode': (p) => { p.domain.edges.xmin = { bc: 'dirichlet', electrode: 'outer' }; },
        'edge condition': (p) => { p.domain.edges.ymax = { bc: 'neumann' }; },
        'edge profile': (p) => { p.domain.edges.ymax = { bc: 'profile', segments: [{ from: -60, to: 40, electrode: 'gnd' }, { from: 40, to: 140, electrode: 'outer' }] }; },
        'profile ramp': (p) => { p.domain.edges.ymax = { bc: 'profile', segments: [{ from: -60, to: 40, electrode: 'gnd' }, { from: 40, to: 140, ramp: ['gnd', 'outer'] }] }; },
        'electrode added': (p) => { p.electrodes.push({ id: 'extra', kind: 'solid', v: 0 }); },
        'electrode order': (p) => { p.electrodes = [p.electrodes[0], p.electrodes[2], p.electrodes[1]]; },
        'boundary method': (p) => { p.solver.boundary = 'staircase'; },
    };
    for (const [name, edit] of Object.entries(cases)) {
        const c = changed(einzel, edit);
        assert.equal(c.g, true, name);
        assert.equal(c.f && c.r, true, `${name}: the field and run follow`);
    }
    const mirrored = () => { const p = rfQuadrupole(); return p; };
    assert.equal(changed(mirrored, (p) => { p.domain.mirror.y = false; p.domain.edges.ymin = { bc: 'neumann' }; }).g, true, 'mirror');
    assert.ok(geomContent(resolve(einzel()).resolved).v === ENGINE_VERSION, 'the engine version is part of the geometry key');
});

test('fieldKey changes with voltages, waveforms, mesh settings, magnets, ideal fields and interpolation only', () => {
    const yes = {
        'voltage': (p) => { p.electrodes[1].v = 25; },
        'voltage via parameter': (p) => { p.params[1].value = 900; },
        'waveform added': (p) => { p.electrodes[2].wave = { terms: [{ type: 'cos', amp: 5, freq: 1, phase: 0 }] }; },
        'electrode kind': (p) => { p.electrodes[2].kind = 'grid'; },
        'magnet': (p) => { p.magnets.push({ id: 'm1', type: 'uniform', B: [0.001, 0, 0] }); },
        'ideal field': (p) => { p.idealFields.push({ id: 'f1', type: 'uniformE', E: [1, 0, 0] }); },
        'interpolation': (p) => { p.tracer.fieldInterp = 'linear'; },
    };
    for (const [name, edit] of Object.entries(yes)) { const c = changed(einzel, edit); assert.equal(c.g, false, name); assert.equal(c.f, true, name); assert.equal(c.r, true, `${name}: run follows`); }
    const tr = changed(plateMirror, (p) => { p.electrodes[1].transmission = 0.5; });
    assert.deepEqual(tr, { g: false, f: true, r: true }, 'mesh transmission');
    const wave = changed(rfQuadrupole, (p) => { p.params[0].value = 140; });
    assert.deepEqual(wave, { g: false, f: true, r: true }, 'RF amplitude');
    const freq = changed(rfQuadrupole, (p) => { p.electrodes[1].wave.terms[0].freq = 1.2; p.electrodes[2].wave.terms[0].freq = 1.2; });
    assert.deepEqual(freq, { g: false, f: true, r: true }, 'RF frequency');
    const no = {
        'source': (p) => { p.sources[0].energy.ke = 500; },
        'recording': (p) => { p.recording.planes[0].at = 120; },
        'tracer quality': (p) => { p.tracer.quality = 'fine'; },
        'names and colours': (p) => { p.electrodes[1].name = 'x'; p.electrodes[1].color = '#000000'; p.shapes[0].name = 'y'; },
        'view': (p) => { p.view.scale = 1; },
        'magnet name': () => {},
    };
    for (const [name, edit] of Object.entries(no)) assert.equal(changed(einzel, edit).f, false, name);
    const mag = () => { const p = einzel(); p.magnets.push({ id: 'm1', name: 'A', type: 'uniform', B: [0.001, 0, 0] }); return p; };
    assert.deepEqual(changed(mag, (p) => { p.magnets[0].name = 'B'; p.magnets[0].id = 'm2'; }), { g: false, f: false, r: false }, 'magnet name and id');
    assert.deepEqual(changed(mag, (p) => { p.magnets[0].enabled = false; }), { g: false, f: true, r: true }, 'magnet disabled');
});

test('runKey changes with sources, tracer, recording and beyond; not with names, colours or view', () => {
    const yes = {
        'source energy': (p) => { p.sources[0].energy.ke = 500; },
        'source count': (p) => { p.sources[0].position.n = 11; },
        'source seed': (p) => { p.sources[0].seed = 2; },
        'source species': (p) => { p.sources[0].species[0].mass = 40; },
        'source disabled': (p) => { p.sources[0].enabled = false; },
        'tracer quality': (p) => { p.tracer.quality = 'fine'; },
        'tracer time limit': (p) => { p.tracer.tMax = 5; },
        'relativistic': (p) => { p.tracer.relativistic = false; },
        'plane position': (p) => { p.recording.planes[0].at = 120; },
        'plane added': (p) => { p.recording.planes.push({ id: 'p2', kind: 'x', at: 0 }); },
        'trajectory storage': (p) => { p.recording.trajectories.maxPoints = 100; },
        'time markers': (p) => { p.recording.timeMarkers = { dt: 0.1 }; },
        'beyond': (p) => { p.domain.beyond.xmax = 'stop'; },
    };
    for (const [name, edit] of Object.entries(yes)) { const c = changed(einzel, edit); assert.deepEqual([c.g, c.f, c.r], [false, false, true], name); }
    const no = {
        'source name and colour': (p) => { p.sources[0].name = 'n'; p.sources[0].color = '#123456'; },
        'source id': (p) => { p.sources[0].id = 'renamed'; },
        'plane name': (p) => { p.recording.planes[0].name = 'Detector'; },
        'view': (p) => { p.view.center = [0, 5]; p.view.layers.trajectories = 'energy'; },
        'notes': (p) => { p.meta.notes = 'x'; },
        'analysis': (p) => { p.analysis.waist = null; },
        'equal value written differently': (p) => { p.params[0].value = '10*2'; },
    };
    for (const [name, edit] of Object.entries(no)) assert.deepEqual(changed(einzel, edit), { g: false, f: false, r: false }, name);
});

test('keys are chained: geomKey → fieldKey → runKey; defaults are equivalent to explicit arguments', () => {
    const R = resolve(einzel()).resolved;
    const g = geomKey(R), f = fieldKey(R, g), r = runKey(R, f);
    assert.deepEqual(projectKeys(R), { geomKey: g, fieldKey: f, runKey: r });
    assert.equal(fieldKey(R), f);
    assert.equal(runKey(R), r);
    assert.notEqual(fieldKey(R, 'gother'), f, 'fieldKey includes the geomKey');
    assert.notEqual(runKey(R, 'fother'), r, 'runKey includes the fieldKey');
    assert.match(g, /^g[0-9a-f]{16}$/); assert.match(f, /^f[0-9a-f]{16}$/); assert.match(r, /^r[0-9a-f]{16}$/);
    // the same project resolved twice (or from a structured clone) gives the same keys
    assert.deepEqual(projectKeys(structuredClone(R)), projectKeys(R));
    assert.deepEqual(keysOf(einzel()), projectKeys(R));
});
