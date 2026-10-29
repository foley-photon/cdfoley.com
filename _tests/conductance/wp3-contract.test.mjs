// WP3 contract (spec §5.4 rule 3): every exported name of §2.10, §2.13 (prep protocol) and §2.16 exists with its
// documented signature and returns structurally valid results on a minimal input. Also checks the pure-module
// rules H7/H13 on the WP3 files (no bare imports, no DOM globals, no console output).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as stl from '../../beta/conductance/js/io/stl.js';
import * as obj from '../../beta/conductance/js/io/obj.js';
import * as project from '../../beta/conductance/js/io/project.js';
import * as profile2d from '../../beta/conductance/js/io/profile2d.js';
import * as mesh from '../../beta/conductance/js/engine/mesh.js';
import * as triangulate from '../../beta/conductance/js/engine/triangulate.js';
import * as ports from '../../beta/conductance/js/engine/ports.js';
import * as testgeom from '../../beta/conductance/js/engine/testgeom.js';
import * as prep from '../../beta/conductance/js/engine/prep-service.js';
import { gasState } from '../../beta/conductance/js/engine/gas.js';

const ROOT = new URL('../../beta/conductance/js/', import.meta.url);
const N2 = gasState('N2', 293.15);

// a tube of 8 sides, open at both ends (64 triangles), 9 numbers per triangle
function smallTube(n = 8, m = 4, R = 0.01, L = 0.04) {
  const P = (k, j) => [R * Math.cos(2 * Math.PI * k / n), R * Math.sin(2 * Math.PI * k / n), L * j / m];
  const out = [];
  for (let j = 0; j < m; j++) for (let k = 0; k < n; k++) {
    const a = P(k % n, j), b = P((k + 1) % n, j), c = P((k + 1) % n, j + 1), d = P(k % n, j + 1);
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return Float32Array.from(out);
}

const isPortSpec = (p) => {
  assert.deepEqual(Object.keys(p).sort(), ['id', 'kind', 'loops', 'name', 'role', 'speed', 'stick', 'tris']);
  assert.ok(Number.isInteger(p.id) && typeof p.name === 'string');
  assert.ok(p.kind === 'loop' || p.kind === 'region');
  assert.ok(['inlet', 'outlet', 'pump', 'closed'].includes(p.role));
};

test('io/stl.js: parseSTL(buffer) and writeBinarySTL(positions, header?)', () => {
  assert.equal(typeof stl.parseSTL, 'function');
  assert.equal(stl.parseSTL.length, 1);
  assert.equal(typeof stl.writeBinarySTL, 'function');
  assert.equal(stl.writeBinarySTL.length, 1);
  const buf = stl.writeBinarySTL(smallTube());
  assert.ok(buf instanceof ArrayBuffer);
  assert.equal(buf.byteLength, 84 + 50 * 64);
  const r = stl.parseSTL(buf);
  assert.ok(r.positions instanceof Float32Array);
  assert.equal(r.positions.length, 9 * 64);
  assert.equal(r.nTri, 64);
  assert.equal(r.format, 'stl-binary');
  assert.ok(Array.isArray(r.warnings));
});

test('io/obj.js: parseOBJ(text)', () => {
  assert.equal(obj.parseOBJ.length, 1);
  const r = obj.parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  assert.ok(r.positions instanceof Float32Array);
  assert.equal(r.nTri, 1);
  assert.ok(Array.isArray(r.groups) && Array.isArray(r.warnings));
  assert.deepEqual(r.groups, [{ name: 'default', start: 0, count: 1 }]);
});

test('engine/mesh.js: weldMesh, validateMesh, regionFrom, facetRegions, prepareMesh', () => {
  assert.equal(mesh.weldMesh.length, 1);
  assert.equal(mesh.validateMesh.length, 2);
  assert.equal(mesh.regionFrom.length, 2);
  assert.equal(mesh.facetRegions.length, 1);
  assert.equal(mesh.prepareMesh.length, 1);
  const w = mesh.weldMesh(smallTube());
  assert.deepEqual(Object.keys(w).sort(), ['degenerate', 'duplicate', 'merged', 'mesh', 'weldTol']);
  assert.ok(w.mesh.vertices instanceof Float64Array && w.mesh.tris instanceof Uint32Array);
  assert.equal(w.mesh.vertices.length, 3 * 40);
  assert.equal(w.mesh.tris.length, 3 * 64);
  const rep = mesh.validateMesh(w.mesh, w);
  for (const k of ['nTri', 'nVert', 'bbox', 'diag', 'weldTol', 'merged', 'degenerate', 'duplicate', 'boundaryEdges', 'nonManifoldEdges',
    'openChains', 'loops', 'closed', 'windingConsistent', 'signedVolume', 'faceting', 'severity', 'messages']) assert.ok(k in rep, k);
  assert.equal(rep.bbox.length, 6);
  assert.equal(rep.loops.length, 2);
  for (const l of rep.loops) {
    assert.deepEqual(Object.keys(l).sort(), ['area', 'centroid', 'circular', 'id', 'maxDev', 'normal', 'perimeter', 'planar', 'sides', 'vertices'].sort());
    assert.ok(l.vertices instanceof Uint32Array);
    assert.equal(l.centroid.length, 3);
    assert.equal(l.normal.length, 3);
  }
  assert.ok(['ok', 'warn', 'error'].includes(rep.severity));
  for (const m of rep.messages) { assert.ok(['ok', 'warn', 'error'].includes(m.level)); assert.equal(typeof m.code, 'string'); assert.equal(typeof m.text, 'string'); }
  for (const f of rep.faceting) assert.deepEqual(Object.keys(f).sort(), ['expectedErrorPct', 'loopId', 'sides']);
  const reg = mesh.regionFrom(w.mesh, 0);
  assert.ok(reg.tris instanceof Uint32Array && reg.tris.length >= 1);
  assert.equal(reg.plane.n.length, 3);
  assert.equal(typeof reg.plane.d, 'number');
  assert.ok(reg.area > 0);
  const fr = mesh.facetRegions(w.mesh);
  assert.ok(fr instanceof Int32Array && fr.length === 64);
  const p = mesh.prepareMesh(smallTube());
  assert.deepEqual(Object.keys(p).sort(), ['autoPorts', 'mesh', 'report']);
  assert.equal(p.autoPorts.length, 2);
  p.autoPorts.forEach(isPortSpec);
});

test('engine/triangulate.js: triangulatePolygon(outer, holes?)', () => {
  assert.equal(triangulate.triangulatePolygon.length, 1);
  const t = triangulate.triangulatePolygon(Float64Array.from([0, 0, 1, 0, 1, 1, 0, 1]));
  assert.ok(t instanceof Uint32Array);
  assert.equal(t.length, 6);
});

test('engine/ports.js: autoPorts(mesh, report) and buildScene(mesh, ports, G)', () => {
  assert.equal(ports.autoPorts.length, 2);
  assert.equal(ports.buildScene.length, 3);
  const p = mesh.prepareMesh(smallTube());
  const ap = ports.autoPorts(p.mesh, p.report);
  assert.equal(ap.length, 2);
  ap.forEach(isPortSpec);
  const r = ports.buildScene(p.mesh, ap, N2);
  assert.deepEqual(Object.keys(r).sort(), ['capPositions', 'scene', 'triPort']);
  const s = r.scene;
  assert.equal(s.version, 1);
  assert.equal(s.nTri, 64 + 12);
  assert.ok(s.tri instanceof Float32Array && s.tri.length === 9 * s.nTri);
  assert.ok(s.normal instanceof Float32Array && s.normal.length === 3 * s.nTri);
  assert.ok(s.area instanceof Float64Array && s.area.length === s.nTri);
  assert.ok(s.port instanceof Int16Array && s.port.length === s.nTri);
  assert.ok(s.origTri instanceof Uint32Array && s.origTri.length === s.nTri);
  assert.ok(s.box instanceof Float32Array && s.meta instanceof Int32Array);
  assert.ok(s.diag > 0 && s.bbox.length === 6);
  assert.equal(s.ports.length, 2);
  for (const sp of s.ports) {
    assert.deepEqual(Object.keys(sp).sort(), ['area', 'cdf', 'centroid', 'id', 'inward', 'name', 'role', 'slots', 'stick']);
    assert.ok(sp.slots instanceof Uint32Array && sp.cdf instanceof Float64Array && sp.slots.length === sp.cdf.length);
    assert.equal(sp.inward.length, 3);
    assert.equal(sp.centroid.length, 3);
  }
  assert.ok(r.capPositions instanceof Float32Array && r.capPositions.length === 9 * 12);
  assert.ok(r.triPort instanceof Int16Array && r.triPort.length === 64 + 12);
});

test('engine/testgeom.js: BUILTINS and makeBuiltin(name, params?)', () => {
  assert.equal(testgeom.makeBuiltin.length, 1);
  for (const name of ['tube', 'elbow', 'cone', 'annulus', 'rect', 'tube16', 'coneConv', 'pumpTube']) {
    const b = testgeom.BUILTINS[name];
    assert.ok(b, name);
    assert.equal(typeof b.label, 'string');
    assert.equal(typeof b.params, 'object');
    assert.deepEqual(Object.keys(b.reference).sort(), ['alpha', 'sigma', 'source']);
  }
  const b = testgeom.makeBuiltin('rect');
  assert.deepEqual(Object.keys(b).sort(), ['positions', 'reference', 'suggestedPorts']);
  assert.ok(b.positions instanceof Float32Array && b.positions.length % 9 === 0);
  assert.equal(b.suggestedPorts.length, 2);
  b.suggestedPorts.forEach(isPortSpec);
});

test('io/project.js: serializeProject, parseProject, toBase64, fromBase64', () => {
  assert.equal(project.serializeProject.length, 1);
  assert.equal(project.parseProject.length, 1);
  assert.equal(project.toBase64.length, 1);
  assert.equal(project.fromBase64.length, 2);
  assert.equal(project.toBase64(new Uint8Array([1, 2, 3])), 'AQID');
  assert.deepEqual(Array.from(project.fromBase64('AQID', Uint8Array)), [1, 2, 3]);
  const text = project.serializeProject({
    saved: '2026-10-12T10:00:00Z', units: { file: 'mm', scaleToMeters: 0.001 }, source: { kind: 'builtin', name: 'elbow', params: {} },
    mesh: null, weldTol: null, ports: [], conditions: { gas: 'N2', T: 293.15, custom: null },
    run: { target: 0.01, maxTime: 60, seed: 1, allocation: 'equal' }, results: null,
  });
  assert.equal(typeof text, 'string');
  const st = project.parseProject(text);
  for (const k of ['format', 'version', 'saved', 'units', 'source', 'mesh', 'weldTol', 'ports', 'conditions', 'run', 'results']) assert.ok(k in st, k);
  assert.equal(st.format, 'cdfoley-conductance-cad');
  assert.equal(st.version, 1);
});

test('io/profile2d.js: parseSVGProfile, parseDXFProfile, profileToItems', () => {
  assert.equal(profile2d.parseSVGProfile.length, 1);
  assert.equal(profile2d.parseDXFProfile.length, 1);
  assert.equal(profile2d.profileToItems.length, 2);
  const s = profile2d.parseSVGProfile('<svg viewBox="0 0 10 10"><polyline points="0,-2 10,-2"/></svg>');
  assert.ok(Array.isArray(s.paths) && s.paths[0] instanceof Float64Array);
  assert.ok(s.unitHint === null || s.unitHint === 'mm' || s.unitHint === 'in');
  assert.ok(Array.isArray(s.warnings));
  const d = profile2d.parseDXFProfile('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n1\n11\n5\n21\n1\n0\nENDSEC\n0\nEOF\n');
  assert.ok(Array.isArray(d.paths) && d.paths[0] instanceof Float64Array);
  const r = profile2d.profileToItems(s.paths, { scale: 0.001, axis: 'zero' });
  assert.ok(Array.isArray(r.items) && r.lathe instanceof Float64Array);
  assert.deepEqual(r.items, [{ t: 'tube', d: 0.004, L: 0.01 }]);
});

test('engine/prep-service.js: createService(post) answers the protocol of §2.13', () => {
  assert.equal(prep.createService.length, 1);
  const out = [];
  const svc = prep.createService((msg, transfer) => out.push({ msg, transfer }));
  assert.equal(typeof svc.onMessage, 'function');
  svc.onMessage({ type: 'parse', id: 1, name: 't.stl', buffer: stl.writeBinarySTL(smallTube()), format: 'auto', scale: 1 });
  svc.onMessage({ type: 'prepare', id: 2, weldTol: null });
  svc.onMessage({ type: 'region', id: 3, seedTri: 0 });
  svc.onMessage({ type: 'scene', id: 4, ports: out[1].msg.autoPorts });
  svc.onMessage({ type: 'export', id: 5 });
  svc.onMessage({ type: 'builtin', id: 6, name: 'rect', params: {} });
  svc.onMessage({ type: 'loadMesh', id: 7, vertices: out[4].msg.vertices, triangles: out[4].msg.triangles, weldTol: null });
  svc.onMessage({ type: 'nope', id: 8 });
  const types = out.map((o) => o.msg.type);
  assert.deepEqual(types, ['parsed', 'prepared', 'region', 'scene', 'exported', 'prepared', 'prepared', 'error']);
  const m = out.map((o) => o.msg);
  assert.deepEqual(Object.keys(m[0]).sort(), ['bbox', 'format', 'id', 'nTri', 'type', 'warnings']);
  assert.deepEqual(Object.keys(m[1]).sort(), ['autoPorts', 'id', 'positions', 'report', 'type']);
  assert.ok(m[1].positions instanceof Float32Array);
  assert.deepEqual(Object.keys(m[2]).sort(), ['area', 'id', 'plane', 'tris', 'type']);
  assert.deepEqual(Object.keys(m[3]).sort(), ['capPositions', 'id', 'ms', 'scene', 'triPort', 'type']);
  assert.deepEqual(Object.keys(m[4]).sort(), ['id', 'triangles', 'type', 'vertices']);
  assert.deepEqual(Object.keys(m[5]).sort(), ['autoPorts', 'id', 'positions', 'reference', 'report', 'type']);
  assert.deepEqual(Object.keys(m[7]).sort(), ['id', 'message', 'type']);
  assert.equal(m[7].id, 8);
  // transferable buffers are listed with the reply
  assert.ok(out[1].transfer.includes(m[1].positions.buffer));
  assert.ok(out[3].transfer.includes(m[3].scene.tri.buffer));
});

test('workers/prep-worker.js is the three-line wiring of §2.13', () => {
  const src = readFileSync(fileURLToPath(new URL('workers/prep-worker.js', ROOT)), 'utf8').trim().split(/\r?\n/);
  assert.equal(src.length, 3);
  assert.match(src[0], /^import \{ createService \} from '\.\.\/engine\/prep-service\.js';$/);
  assert.match(src[1], /createService\(\(msg, transfer\) => self\.postMessage\(msg, transfer/);
  assert.match(src[2], /^self\.onmessage = \(e\) => svc\.onMessage\(e\.data\);$/);
});

test('WP3 modules are pure: no bare imports, no DOM globals, no console output (H7, H13)', () => {
  const files = ['engine/mesh.js', 'engine/triangulate.js', 'engine/ports.js', 'engine/testgeom.js', 'engine/prep-service.js',
    'workers/prep-worker.js', 'io/stl.js', 'io/obj.js', 'io/project.js', 'io/profile2d.js'];
  for (const f of files) {
    const src = readFileSync(fileURLToPath(new URL(f, ROOT)), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
    for (const m of code.matchAll(/(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g)) {
      assert.ok(m[1].startsWith('./') || m[1].startsWith('../'), f + ' imports "' + m[1] + '"');
      assert.ok(m[1].endsWith('.js'), f + ' imports "' + m[1] + '" without the .js extension');
    }
    assert.doesNotMatch(code, /\bconsole\s*\./, f + ' uses console');
    assert.doesNotMatch(code, /\b(window|document|navigator|localStorage|Calc|Plot)\s*\./, f + ' touches a DOM global');
  }
});
