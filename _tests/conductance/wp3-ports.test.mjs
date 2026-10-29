// WP3 acceptance 5: ports and the Monte Carlo scene (spec §3.6.4 steps 4–8, §2.12, §2.16).
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBuiltin, BUILTINS } from '../../beta/conductance/js/engine/testgeom.js';
import { prepareMesh, regionFrom } from '../../beta/conductance/js/engine/mesh.js';
import { buildScene, autoPorts } from '../../beta/conductance/js/engine/ports.js';
import { parseSTL, writeBinarySTL } from '../../beta/conductance/js/io/stl.js';
import { makeTracer } from '../../beta/conductance/js/engine/bvh.js';
import { gasState } from '../../beta/conductance/js/engine/gas.js';

const N2 = gasState('N2', 293.15), AIR = gasState('air', 293.15);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const r9 = (v) => v.map((x) => Math.round(x * 1e9) / 1e9 + 0);
const PUBLIC = ['tube', 'elbow', 'cone', 'annulus', 'rect'];
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// closed cylinder: wall of n sides (area-preserving radius) plus two fan discs, normals outward
function closedCylinder(R = 0.02, L = 0.06, n = 64, m = 12) {
  const Rp = R * Math.sqrt(2 * Math.PI / (n * Math.sin(2 * Math.PI / n)));
  const P = (k, z) => [Rp * Math.cos(2 * Math.PI * (k % n) / n), Rp * Math.sin(2 * Math.PI * (k % n) / n), z];
  const t = [];
  for (let j = 0; j < m; j++) for (let k = 0; k < n; k++) { const z0 = L * j / m, z1 = L * (j + 1) / m; t.push([P(k, z0), P(k + 1, z0), P(k + 1, z1)], [P(k, z0), P(k + 1, z1), P(k, z1)]); }
  const wall = t.length;
  for (let k = 0; k < n; k++) t.push([[0, 0, 0], P(k + 1, 0), P(k, 0)]);          // z = 0, normal −z
  for (let k = 0; k < n; k++) t.push([[0, 0, L], P(k, L), P(k + 1, L)]);          // z = L, normal +z
  return { positions: Float32Array.from(t.flat(2)), wall, n };
}
// the inside of a port: a ray along its inward normal hits the mesh, the opposite ray escapes
function insideCheck(scene) {
  const trace = makeTracer(scene), out = new Float64Array(1);
  for (const p of scene.ports) {
    const s = p.slots[0], o = 9 * s;
    const c = [0, 1, 2].map((k) => (scene.tri[o + k] + scene.tri[o + 3 + k] + scene.tri[o + 6 + k]) / 3);
    assert.ok(trace(c[0], c[1], c[2], p.inward[0], p.inward[1], p.inward[2], s, out) >= 0, p.name + ': inward ray hits the part');
    assert.equal(trace(c[0], c[1], c[2], -p.inward[0], -p.inward[1], -p.inward[2], s, out), -1, p.name + ': outward ray escapes');
  }
}

test('all five public built-ins give their two openings with the right roles; the annulus ends have one hole each', () => {
  for (const name of PUBLIC) {
    const b = prepareBuiltin(name);
    assert.equal(b.suggestedPorts.length, 2, name);
    assert.deepEqual(b.suggestedPorts.map((p) => [p.id, p.name, p.role, p.kind, p.stick, p.speed]), [[0, 'Inlet', 'inlet', 'loop', 1, null], [1, 'Outlet', 'outlet', 'loop', 1, null]], name);
    // the detected openings (without the built-in's suggestions) are the same loops: larger = inlet, then the other
    const auto = autoPorts(b.prep.mesh, b.prep.report);
    assert.equal(auto.length, 2, name);
    assert.deepEqual(auto.map((p) => p.role), ['inlet', 'outlet']);
    assert.deepEqual(new Set(auto.map((p) => JSON.stringify(p.loops))), new Set(b.suggestedPorts.map((p) => JSON.stringify(p.loops))), name);
    const holes = b.suggestedPorts.map((p) => p.loops[0].length - 1);
    assert.deepEqual(holes, name === 'annulus' ? [1, 1] : [0, 0], name);
  }
  // the cone's inlet is its small end (the reference is referred to it); the auto rule would pick the large end
  const cone = prepareBuiltin('cone');
  const loops = cone.prep.report.loops;
  assert.ok(loops[cone.suggestedPorts[0].loops[0][0]].area < loops[cone.suggestedPorts[1].loops[0][0]].area);
  assert.equal(autoPorts(cone.prep.mesh, cone.prep.report)[0].loops[0][0], cone.suggestedPorts[1].loops[0][0]);
  // the pump built-in names a pump port with a speed
  const pt = prepareBuiltin('pumpTube');
  assert.deepEqual(pt.suggestedPorts.map((p) => [p.role, p.stick, p.speed]), [['inlet', 1, null], ['pump', null, 0.3]]);
});

test('inward normals point into the gas, for every built-in (signed-volume rule)', () => {
  for (const name of Object.keys(BUILTINS)) {
    const b = prepareBuiltin(name);
    const { scene } = buildScene(b.prep.mesh, b.suggestedPorts, name === 'pumpTube' ? AIR : N2);
    assert.equal(scene.ports.length, 2);
    const [a, c] = scene.ports;
    // the other opening lies on the inward side of each
    const d = [0, 1, 2].map((k) => c.centroid[k] - a.centroid[k]);
    assert.ok(dot(a.inward, d) > 0 && dot(c.inward, d) < 0, name);
    for (const p of scene.ports) assert.ok(Math.abs(Math.hypot(...p.inward) - 1) < 1e-12);
    insideCheck(scene);
  }
  const t = buildScene(prepareBuiltin('tube').prep.mesh, prepareBuiltin('tube').suggestedPorts, N2).scene;
  assert.deepEqual(t.ports.map((p) => r9(p.inward)), [[0, 0, 1], [0, 0, -1]]);
  const e = buildScene(prepareBuiltin('elbow').prep.mesh, prepareBuiltin('elbow').suggestedPorts, N2).scene;
  assert.deepEqual(e.ports.map((p) => r9(p.inward)), [[0, 0, 1], [-1, 0, 0]]);
});

test('inward normals by casting rays when the winding is inconsistent, and the tie message', () => {
  const b = prepareBuiltin('elbow');
  const pos = b.positions.slice();
  const R = rng(5);
  for (let t = 0; t < pos.length / 9; t++) if (R() < 0.3) for (let k = 0; k < 3; k++) { const x = pos[9 * t + 3 + k]; pos[9 * t + 3 + k] = pos[9 * t + 6 + k]; pos[9 * t + 6 + k] = x; }
  const p = prepareMesh(pos);
  assert.equal(p.report.windingConsistent, false);
  const { scene } = buildScene(p.mesh, p.autoPorts, N2);
  assert.deepEqual(scene.ports.map((q) => r9(q.inward)), [[0, 0, 1], [-1, 0, 0]]);
  insideCheck(scene);
  // a lone flat square: no side has more of the part than the other
  const sheet = prepareMesh(Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]));
  assert.equal(sheet.autoPorts.length, 1);
  assert.throws(() => buildScene(sheet.mesh, sheet.autoPorts, N2), /^RangeError: Cannot tell which side of opening "Inlet" is inside\. Close the mesh or check the normals\.$/);
});

test('region selection on the flat end of a closed cylinder returns exactly the end-cap triangles', () => {
  const cyl = closedCylinder();
  const p = prepareMesh(cyl.positions);
  assert.equal(p.report.closed, true);
  assert.equal(p.report.windingConsistent, true);
  assert.deepEqual(p.autoPorts, []);
  const r0 = regionFrom(p.mesh, cyl.wall + 5);
  assert.deepEqual(Array.from(r0.tris), Array.from({ length: cyl.n }, (_, k) => cyl.wall + k));
  assert.ok(Math.abs(r0.area / (Math.PI * 0.02 ** 2) - 1) < 1e-6);
  assert.ok(Math.abs(Math.abs(r0.plane.n[2]) - 1) < 1e-12 && Math.abs(r0.plane.d) < 1e-12);
  const r1 = regionFrom(p.mesh, cyl.wall + cyl.n + 17);
  assert.deepEqual(Array.from(r1.tris), Array.from({ length: cyl.n }, (_, k) => cyl.wall + cyl.n + k));
  // the two regions as inlet and outlet: inward normals into the cylinder, no caps
  const ports = [
    { id: 3, name: 'In', kind: 'region', loops: null, tris: r0.tris, role: 'inlet', stick: 1, speed: null },
    { id: 7, name: 'Out', kind: 'region', loops: null, tris: r1.tris, role: 'outlet', stick: 1, speed: null },
  ];
  const s = buildScene(p.mesh, ports, N2);
  assert.equal(s.capPositions.length, 0);
  assert.deepEqual(s.scene.ports.map((q) => [q.id, q.name, r9(q.inward)]), [[3, 'In', [0, 0, 1]], [7, 'Out', [0, 0, -1]]]);
  for (let t = 0; t < s.triPort.length; t++) {
    const want = t >= cyl.wall && t < cyl.wall + cyl.n ? 3 : t >= cyl.wall + cyl.n ? 7 : -1;
    if (s.triPort[t] !== want) assert.fail('triPort[' + t + '] = ' + s.triPort[t]);
  }
  insideCheck(s.scene);
});

test('the scene of a built-in: caps after the mesh, port indices and ids, areas and emission tables', () => {
  const b = prepareBuiltin('annulus');
  const nT = b.prep.report.nTri;
  const ports = b.suggestedPorts.map((p, k) => ({ ...p, id: 10 + k }));
  const { scene, capPositions, triPort } = buildScene(b.prep.mesh, ports, N2);
  const nCap = capPositions.length / 9;
  assert.equal(scene.nTri, nT + nCap);
  assert.equal(nCap, 2 * (64 + 64), 'an annulus end of 64 + 64 vertices needs 128 cap triangles');
  for (let s = 0; s < scene.nTri; s++) {
    const i = scene.origTri[s];
    const want = i < nT ? -1 : (i < nT + nCap / 2 ? 0 : 1);
    if (scene.port[s] !== want) assert.fail('slot ' + s + ' port ' + scene.port[s]);
    if (triPort[i] !== (want < 0 ? -1 : 10 + want)) assert.fail('triPort');
    if (i >= nT) for (let k = 0; k < 9; k++) if (scene.tri[9 * s + k] !== capPositions[9 * (i - nT) + k]) assert.fail('cap coordinates');
  }
  const ring = Math.PI * (0.02 ** 2 - 0.01 ** 2);
  for (const p of scene.ports) {
    assert.ok(Math.abs(p.area / ring - 1) < 1e-6, 'annulus area ' + p.area);
    assert.equal(p.slots.length, nCap / 2);
    for (let j = 1; j < p.cdf.length; j++) assert.ok(p.cdf[j] > p.cdf[j - 1]);
    assert.ok(Math.abs(p.cdf[p.cdf.length - 1] - p.area) <= 1e-15 * p.area);
    assert.equal(p.stick, 1);
  }
  assert.deepEqual(scene.ports.map((p) => p.id), [10, 11]);
  // signed volume of the capped scene = the gas volume
  let v6 = 0;
  for (let s = 0; s < scene.nTri; s++) {
    const o = 9 * s, T = scene.tri;
    v6 += T[o] * (T[o + 4] * T[o + 8] - T[o + 5] * T[o + 7]) + T[o + 1] * (T[o + 5] * T[o + 6] - T[o + 3] * T[o + 8]) + T[o + 2] * (T[o + 3] * T[o + 7] - T[o + 4] * T[o + 6]);
  }
  assert.ok(Math.abs(v6 / 6 / (ring * 0.02) - 1) < 1e-5);
  // a closed opening is capped as a wall: listed in triPort, not in the scene ports
  const closed = buildScene(b.prep.mesh, [ports[0], { ...ports[1], role: 'closed' }], N2);
  assert.equal(closed.scene.ports.length, 1);
  assert.equal(closed.scene.nTri, scene.nTri);
  assert.equal(closed.triPort.filter((x) => x === 11).length, nCap / 2);
  let walls = 0;
  for (let s = 0; s < closed.scene.nTri; s++) if (closed.scene.origTri[s] >= nT && closed.scene.port[s] < 0) walls++;
  assert.equal(walls, nCap / 2);
});

test('rays from inside the capped elbow never escape (watertight caps)', () => {
  const b = prepareBuiltin('elbow');
  const { scene } = buildScene(b.prep.mesh, b.suggestedPorts, N2);
  const trace = makeTracer(scene), out = new Float64Array(1), R = rng(9);
  let miss = 0;
  for (let i = 0; i < 20000; i++) {
    // points inside leg 0 (r < 15 mm, 5 mm < z < 35 mm), random directions
    const r = 0.015 * Math.sqrt(R()), a = 2 * Math.PI * R(), z = 0.005 + 0.03 * R();
    const u = 2 * R() - 1, ph = 2 * Math.PI * R(), q = Math.sqrt(1 - u * u);
    if (trace(r * Math.cos(a), r * Math.sin(a), z, q * Math.cos(ph), q * Math.sin(ph), u, -1, out) < 0) miss++;
  }
  assert.equal(miss, 0);
});

test('pump ports: speed → sticking coefficient with the gas; the limits are enforced', () => {
  const b = prepareBuiltin('pumpTube');
  const air = buildScene(b.prep.mesh, b.suggestedPorts, AIR).scene;
  const A = air.ports[1].area;
  assert.ok(Math.abs(air.ports[1].stick - 0.3 / (A * AIR.vbar / 4)) < 1e-15);
  assert.ok(Math.abs(air.ports[1].stick - 0.33006) < 5e-6, 'Appendix B.3: 0.33006 for air');
  const he = buildScene(b.prep.mesh, b.suggestedPorts, gasState('He', 293.15)).scene;
  assert.ok(he.ports[1].stick < air.ports[1].stick, 'the same speed is a smaller sticking coefficient for a faster gas');
  const byStick = buildScene(b.prep.mesh, b.suggestedPorts.map((p) => (p.role === 'pump' ? { ...p, speed: null, stick: 0.25 } : p))).scene;
  assert.equal(byStick.ports[1].stick, 0.25);
  assert.throws(() => buildScene(b.prep.mesh, b.suggestedPorts), /The gas data are needed/);
  assert.throws(() => buildScene(b.prep.mesh, b.suggestedPorts.map((p) => (p.role === 'pump' ? { ...p, speed: 1.0 } : p)), AIR),
    /^RangeError: The pumping speed of "Pump" \(1000 L\/s\) is above the molecular-flow maximum of its opening \(908\.9 L\/s\)\.$/);
  assert.throws(() => buildScene(b.prep.mesh, b.suggestedPorts.map((p) => (p.role === 'pump' ? { ...p, speed: null, stick: 1.5 } : p))), /must be above 0 and at most 1/);
});

test('port lists are checked: every opening needs a role, loops and triangles belong to one port', () => {
  const b = prepareBuiltin('tube');
  const [i, o] = b.suggestedPorts;
  assert.throws(() => buildScene(b.prep.mesh, [i], N2), /An opening has no role yet \(edge loop 1\)/);
  assert.throws(() => buildScene(b.prep.mesh, [i, { ...o, loops: [[0]] }], N2), /Edge loop 0 belongs to two openings/);
  assert.throws(() => buildScene(b.prep.mesh, [i, { ...o, id: 0 }], N2), /Two openings have the id 0/);
  assert.throws(() => buildScene(b.prep.mesh, [i, { ...o, loops: [[5]] }], N2), /refers to edge loop 5, which does not exist/);
  assert.throws(() => buildScene(b.prep.mesh, [i, { ...o, role: 'exit' }], N2), /needs a role/);
  assert.throws(() => buildScene(b.prep.mesh, [i, o, { id: 5, name: 'R', kind: 'region', loops: null, tris: [0, 0], role: 'outlet', stick: 1, speed: null }], N2), /Triangle 0 belongs to two openings/);
  assert.throws(() => buildScene(b.prep.mesh, [i, o, { id: 5, name: 'R', kind: 'region', loops: null, tris: [1e9], role: 'outlet', stick: 1, speed: null }], N2), /refers to triangle 1000000000/);
  assert.throws(() => buildScene(b.prep.mesh, [i, { ...o, kind: 'blob' }], N2), /must be an edge loop or a selected region/);
  assert.throws(() => buildScene(b.prep.mesh, [i, { ...o, id: 40000 }], N2), /id from 0 to 32767/);
  assert.throws(() => buildScene(null, [], N2), /no prepared mesh/);
});

test('a scene built from an STL round trip equals the built-in scene except for vertex order', () => {
  const canon = (scene) => {
    const list = [];
    for (let s = 0; s < scene.nTri; s++) {
      const v = [0, 1, 2].map((k) => Array.from(scene.tri.subarray(9 * s + 3 * k, 9 * s + 3 * k + 3)).join(','));
      const r = v.indexOf([...v].sort()[0]);
      list.push([v[r], v[(r + 1) % 3], v[(r + 2) % 3], scene.port[s]].join(';'));
    }
    return list.sort();
  };
  const portsOf = (scene) => scene.ports.map((p) => ({ id: p.id, name: p.name, role: p.role, stick: p.stick, area: p.area, inward: p.inward, centroid: p.centroid }));
  for (const name of ['elbow', 'annulus']) {
    const b = prepareBuiltin(name);
    const A = buildScene(b.prep.mesh, b.suggestedPorts, N2).scene;
    const parsed = parseSTL(writeBinarySTL(b.positions));                 // metres
    const p = prepareMesh(parsed.positions);
    const B = buildScene(p.mesh, p.autoPorts, N2).scene;
    assert.equal(B.nTri, A.nTri, name);
    assert.deepEqual(B.bbox, A.bbox);
    assert.deepEqual(portsOf(B), portsOf(A), name);
    assert.deepEqual(canon(B), canon(A), name);
  }
  // in millimetres (as a user file): the same to single precision
  const b = prepareBuiltin('elbow');
  const A = buildScene(b.prep.mesh, b.suggestedPorts, N2).scene;
  const mm = parseSTL(writeBinarySTL(b.positions.map((x) => x * 1000)));
  const m = new Float32Array(mm.positions.length);
  for (let k = 0; k < m.length; k++) m[k] = mm.positions[k] * 0.001;
  const p = prepareMesh(m);
  const B = buildScene(p.mesh, p.autoPorts, N2).scene;
  assert.equal(B.nTri, A.nTri);
  B.ports.forEach((q, k) => {
    assert.equal(q.role, A.ports[k].role);
    assert.ok(Math.abs(q.area / A.ports[k].area - 1) < 1e-6);
    assert.ok(dot(q.inward, A.ports[k].inward) > 1 - 1e-9);
  });
});
