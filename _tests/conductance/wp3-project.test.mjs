// WP3 acceptance 6: CAD project files (spec §2.10): save → open → save is byte-identical; stored results come
// back; malformed or wrong-version files fail with readable messages. Also the base64 helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeProject, parseProject, toBase64, fromBase64 } from '../../beta/conductance/js/io/project.js';
import { prepareBuiltin, makeBuiltin } from '../../beta/conductance/js/engine/testgeom.js';
import { createService } from '../../beta/conductance/js/engine/prep-service.js';

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function fileProject() {
  const b = prepareBuiltin('elbow');
  const m = b.prep.mesh;
  return {
    saved: '2026-10-12T10:00:00Z',
    units: { file: 'mm', scaleToMeters: 0.001 },
    source: { kind: 'file', name: 'elbow-dn40.stl', format: 'stl-binary' },
    mesh: { vertices: Float32Array.from(m.vertices), triangles: Uint32Array.from(m.tris) },
    weldTol: 1e-7,
    ports: [
      { ...b.suggestedPorts[0] },
      { id: 1, name: 'Pump', kind: 'region', loops: null, tris: Uint32Array.from([5, 6, 7, 70]), role: 'pump', stick: null, speed: 0.08 },
      { ...b.suggestedPorts[1], id: 2, role: 'closed' },
    ],
    conditions: { gas: 'custom', T: 300, custom: { M: 0.004, eta20: 1.96e-5, omega: 0.66, gamma: 1.6667, Cd: 0.81 } },
    run: { target: 0.003, maxTime: 60, seed: 20261012, allocation: 'favor-small' },
    results: {
      perSource: [{ port: 0, n: 123456, absorbed: [1, 32745, 0], leaks: 0, stuck: 2, casts: 1037000 }],
      hits: Uint32Array.from({ length: m.tris.length / 3 + 124 }, (_, i) => (i * 2654435761) >>> 20),
      ms: 4321.5, stopped: true,
    },
  };
}

test('save → open → save is byte-identical, in the documented layout', () => {
  const s1 = serializeProject(fileProject());
  const s2 = serializeProject(parseProject(s1));
  assert.equal(s2, s1);
  assert.equal(serializeProject(parseProject(s2)), s1);
  const j = JSON.parse(s1);
  assert.deepEqual(Object.keys(j), ['format', 'version', 'saved', 'units', 'source', 'mesh', 'weldTol', 'ports', 'conditions', 'run', 'results']);
  assert.equal(j.format, 'cdfoley-conductance-cad');
  assert.equal(j.version, 1);
  assert.deepEqual(Object.keys(j.mesh), ['nVert', 'nTri', 'vertices', 'triangles']);
  assert.deepEqual(Object.keys(j.ports[0]), ['id', 'name', 'kind', 'loops', 'role', 'stick', 'speed']);
  assert.deepEqual(Object.keys(j.ports[1]), ['id', 'name', 'kind', 'tris', 'role', 'stick', 'speed']);
  assert.equal(typeof j.ports[1].tris, 'string');
  assert.deepEqual(Object.keys(j.results), ['perSource', 'hits', 'ms', 'stopped']);
  assert.ok(s1.startsWith('{\n  "format": "cdfoley-conductance-cad",\n  "version": 1,\n'), 'two-space indentation');
  // a built-in project stores no mesh
  const bi = {
    saved: '2026-10-12T10:00:00Z', units: { file: 'mm', scaleToMeters: 0.001 }, source: { kind: 'builtin', name: 'elbow', params: { d: 0.04, A: 0.06, B: 0.06 } },
    mesh: null, weldTol: null, ports: makeBuiltin('elbow').suggestedPorts, conditions: { gas: 'N2', T: 293.15, custom: null },
    run: { target: 0.01, maxTime: null, seed: 1, allocation: 'equal' }, results: null,
  };
  const t1 = serializeProject(bi);
  assert.equal(serializeProject(parseProject(t1)), t1);
  const p = parseProject(t1);
  assert.equal(p.mesh, null);
  assert.equal(p.run.maxTime, null, 'unlimited time');
  assert.deepEqual(makeBuiltin(p.source.name, p.source.params).positions, makeBuiltin('elbow').positions);
  // without a saved time, the current time is written (UTC, whole seconds)
  assert.match(JSON.parse(serializeProject({ ...bi, saved: undefined })).saved, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('the stored mesh, ports and results are restored exactly', () => {
  const st = fileProject();
  const p = parseProject(serializeProject(st));
  assert.deepEqual(p.mesh.vertices, st.mesh.vertices);
  assert.deepEqual(p.mesh.triangles, st.mesh.triangles);
  assert.equal(p.mesh.nVert, st.mesh.vertices.length / 3);
  assert.equal(p.mesh.nTri, st.mesh.triangles.length / 3);
  assert.deepEqual(p.ports, [
    { ...st.ports[0], tris: null },
    { ...st.ports[1] },
    { ...st.ports[2], tris: null },
  ]);
  assert.ok(p.ports[1].tris instanceof Uint32Array);
  assert.deepEqual(p.results.perSource, st.results.perSource);
  assert.deepEqual(p.results.hits, st.results.hits);
  assert.ok(p.results.hits instanceof Uint32Array);
  assert.equal(p.results.ms, 4321.5);
  assert.equal(p.results.stopped, true);
  assert.deepEqual(p.conditions, st.conditions);
  assert.deepEqual(p.run, st.run);
  assert.deepEqual(p.units, st.units);
  assert.deepEqual(p.source, st.source);
  assert.equal(p.weldTol, 1e-7);
  // extra plain fields of the results are kept
  const withExtra = { ...st, results: { ...st.results, inletLaunches: [{ port: 0, n: 123456 }] } };
  const q = parseProject(serializeProject(withExtra));
  assert.deepEqual(q.results.inletLaunches, [{ port: 0, n: 123456 }]);
});

test('a saved mesh reloads (loadMesh) to the same prepared mesh, so stored loop ids stay valid', () => {
  const st = fileProject();
  const p = parseProject(serializeProject(st));
  const out = [];
  const svc = createService((m) => out.push(m));
  svc.onMessage({ type: 'loadMesh', id: 1, vertices: p.mesh.vertices, triangles: p.mesh.triangles, weldTol: p.weldTol });
  assert.equal(out[0].type, 'prepared');
  const b = prepareBuiltin('elbow');
  assert.equal(out[0].report.nTri, b.prep.report.nTri);
  assert.deepEqual(out[0].report.loops.map((l) => Array.from(l.vertices)), b.prep.report.loops.map((l) => Array.from(l.vertices)));
  assert.deepEqual(out[0].positions, b.positions);
});

test('malformed, foreign and wrong-version files fail with readable messages', () => {
  const good = JSON.parse(serializeProject(fileProject()));
  const bad = (mutate) => { const j = JSON.parse(JSON.stringify(good)); mutate(j); return JSON.stringify(j); };
  const cases = [
    ['{ not json', /^This file is not a Conductance Lab project \(it is not valid JSON\)\.$/],
    ['[]', /^This file is not a Conductance Lab CAD project\.$/],
    [bad((j) => { j.format = 'something-else'; }), /not a Conductance Lab CAD project/],
    [bad((j) => { j.version = 2; }), /^This project was saved by a newer version of Conductance Lab \(file version 2\); this page reads version 1\.$/],
    [bad((j) => { j.version = 'one'; }), /unknown version \(one\)/],
    [bad((j) => { j.units.scaleToMeters = 0; }), /no valid unit/],
    [bad((j) => { j.source.kind = 'cloud'; }), /where its geometry comes from/],
    [bad((j) => { j.mesh = null; }), /has no mesh/],
    [bad((j) => { j.mesh.nVert += 1; }), /should have \d+ vertices/],
    [bad((j) => { j.mesh.vertices = j.mesh.vertices.slice(0, -4) + '!!!!'; }), /damaged \(character "!" is not base64\)/],
    [bad((j) => { j.mesh.triangles = j.mesh.triangles.slice(1); }), /damaged/],
    [bad((j) => { j.mesh.triangles = toBase64(Uint32Array.from({ length: 3 * j.mesh.nTri }, () => 9e6)); }), /refers to a vertex that does not exist/],
    [bad((j) => { j.ports[0].role = 'exhaust'; }), /unknown role "exhaust"/],
    [bad((j) => { j.ports[1].id = 0; }), /missing or repeated id/],
    [bad((j) => { j.ports[0].loops = [[-1]]; }), /damaged edge loops/],
    [bad((j) => { j.ports[1].stick = 2; }), /sticking coefficient outside 0 to 1/],
    [bad((j) => { j.ports[1].speed = -1; }), /pumping speed that is not a positive number/],
    [bad((j) => { j.ports = {}; }), /no list of openings/],
    [bad((j) => { j.results.perSource[0].absorbed = 'x'; }), /stored results in the project file are damaged/],
    [bad((j) => { j.conditions.T = -5; }), /temperature in the project file is not valid/],
    [bad((j) => { j.weldTol = 'tiny'; }), /merge tolerance/],
  ];
  for (const [text, re] of cases) assert.throws(() => parseProject(text), (err) => err instanceof RangeError && re.test(err.message) && /[.)]$/.test(err.message), String(re));
  assert.throws(() => parseProject(42), /could not be read as text/);
  assert.throws(() => serializeProject(null), /no project to save/);
});

test('base64: RFC 4648 vectors, little-endian bytes, every typed array, and tens of megabytes without stack overflow', () => {
  const enc = (s) => toBase64(new TextEncoder().encode(s));
  assert.deepEqual(['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar'].map(enc), ['', 'Zg==', 'Zm8=', 'Zm9v', 'Zm9vYg==', 'Zm9vYmE=', 'Zm9vYmFy']);
  assert.equal(toBase64(new Uint32Array([0x01020304])), 'BAMCAQ==');
  assert.equal(toBase64(new Float32Array([1])), 'AACAPw==');
  const R = rng(3);
  for (let n = 0; n < 80; n++) {
    const bytes = Uint8Array.from({ length: n }, () => Math.floor(R() * 256));
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
    assert.deepEqual(fromBase64(toBase64(bytes), Uint8Array), bytes);
  }
  for (const T of [Float32Array, Float64Array, Uint32Array, Int32Array, Int16Array, Uint16Array]) {
    const a = T.from({ length: 101 }, () => (R() - 0.3) * 1000);
    assert.deepEqual(fromBase64(toBase64(a), T), a);
  }
  const sub = new Float64Array([1, 2, 3, 4]).subarray(1, 3);           // a view: only its own bytes
  assert.deepEqual(fromBase64(toBase64(sub), Float64Array), new Float64Array([2, 3]));
  const big = new Float32Array(3 * 1024 * 1024);                        // 12 MB
  for (let i = 0; i < big.length; i++) big[i] = i * 0.37;
  const text = toBase64(big);
  assert.equal(text.length, 4 * Math.ceil(big.byteLength / 3));
  assert.deepEqual(fromBase64(text, Float32Array), big);
  assert.throws(() => fromBase64('abc', Uint8Array), /bad base64 length/);
  assert.throws(() => fromBase64('AQID', Uint32Array), /whole numbers of 4-byte values/);
  assert.throws(() => fromBase64('A*==', Uint8Array), /not base64/);
  assert.throws(() => toBase64([1, 2, 3]), /Only typed arrays/);
});
