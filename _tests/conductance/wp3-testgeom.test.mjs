// WP3: built-in test geometries (spec §7.4, Appendix B.2): construction, watertightness, orientation, dimensions
// and the embedded reference values (checked against fixtures/validation-cases-v2.json and the spec).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUILTINS, DEFAULT_BUILTIN, makeBuiltin, prepareBuiltin } from '../../beta/conductance/js/engine/testgeom.js';
import { parseSTL } from '../../beta/conductance/js/io/stl.js';
import { gasState } from '../../beta/conductance/js/engine/gas.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL('./fixtures/' + name, import.meta.url)));
const CASES = JSON.parse(fixture('validation-cases-v2.json').toString('utf8'));
const ap = (R, n = 64) => R * Math.sqrt(2 * Math.PI / (n * Math.sin(2 * Math.PI / n)));
const close = (a, b, rel, msg) => assert.ok(Math.abs(a / b - 1) <= rel, (msg || '') + ' ' + a + ' vs ' + b);

const EXPECT = {
  // name: [triangles, loops, gas volume (m³), bbox]
  tube: [2 * 64 * 102, 2, Math.PI * 0.02 ** 2 * 0.2, [-ap(0.02), -ap(0.02), 0, ap(0.02), ap(0.02), 0.2]],
  elbow: [2 * 64 * (31 + 31), 2, Math.PI * 0.02 ** 2 * 0.12, [-ap(0.02), -ap(0.02), 0, 0.06, ap(0.02), 0.06 + ap(0.02)]],
  cone: [2 * 64 * 16, 2, Math.PI / 3 * 0.04 * (0.02 ** 2 + 0.02 * 0.034559 + 0.034559 ** 2), null],
  annulus: [2 * 64 * 10 + 2 * 64 * 20, 4, Math.PI * (0.02 ** 2 - 0.01 ** 2) * 0.02, null],
  rect: [4 * 16 * 16 * 2, 2, 0.02 ** 3, [-0.01, -0.01, 0, 0.01, 0.01, 0.02]],
  tube16: [2 * 16 * 25, 2, 8 * 0.02 ** 2 * Math.sin(Math.PI / 8) * 0.2, [-0.02, -0.02, 0, 0.02, 0.02, 0.2]],
  coneConv: [2 * 64 * 64, 2, Math.PI / 3 * 0.08 * (0.02 ** 2 + 0.02 * (0.02 - 0.08 * Math.tan(10 * Math.PI / 180)) + (0.02 - 0.08 * Math.tan(10 * Math.PI / 180)) ** 2), null],
  pumpTube: [2 * 64 * 41, 2, Math.PI * 0.05 ** 2 * 0.2, null],
};

test('every built-in is watertight apart from its openings, wound outwards, with the expected size and volume', () => {
  assert.deepEqual(Object.keys(BUILTINS), Object.keys(EXPECT));
  assert.equal(DEFAULT_BUILTIN, 'elbow');
  for (const [name, [nTri, nLoops, vol, bbox]] of Object.entries(EXPECT)) {
    const b = prepareBuiltin(name);
    const r = b.prep.report;
    assert.ok(b.positions instanceof Float32Array, name);
    assert.equal(r.nTri, nTri, name + ' triangles');
    assert.equal(b.positions.length, 9 * nTri, name + ': no triangle was dropped as degenerate or duplicate');
    assert.equal(r.degenerate + r.duplicate + r.merged, 0, name);
    assert.equal(r.nonManifoldEdges, 0, name);
    assert.equal(r.openChains, 0, name);
    assert.equal(r.windingConsistent, true, name);
    assert.equal(r.loops.length, nLoops, name + ' loops');
    assert.ok(r.loops.every((l) => l.planar && l.maxDev < 1e-9), name + ': flat openings');
    close(r.signedVolume, vol, name === 'cone' || name === 'coneConv' ? 2e-3 : 1e-5, name + ' volume (positive = normals out of the gas)');
    if (bbox) bbox.forEach((x, k) => assert.ok(Math.abs(r.bbox[k] - x) < 1e-6, name + ' bbox ' + k + ': ' + r.bbox[k] + ' vs ' + x));
    assert.ok(r.severity === 'ok' || (name === 'tube16' && r.severity === 'warn'), name + ' ' + r.severity);
  }
});

test('round openings have the area-preserving radius; the 16-gon tube is inscribed', () => {
  const area = (name, k) => { const b = prepareBuiltin(name); return b.prep.report.loops[b.suggestedPorts[k].loops[0][0]].area; };
  close(area('tube', 0), Math.PI * 0.02 ** 2, 1e-6, 'tube inlet');
  close(area('elbow', 1), Math.PI * 0.02 ** 2, 1e-6, 'elbow outlet');
  close(area('cone', 0), Math.PI * 0.02 ** 2, 1e-6, 'cone small end');
  close(area('cone', 1), Math.PI * (0.02 + 0.04 * Math.tan(20 * Math.PI / 180)) ** 2, 1e-6, 'cone large end');
  close(area('pumpTube', 0), Math.PI * 0.05 ** 2, 1e-6, 'pump tube');
  close(area('tube16', 0), 8 * 0.02 ** 2 * Math.sin(Math.PI / 8), 1e-6, '16-gon');
  close(area('rect', 0), 0.02 ** 2, 1e-6, 'duct');
  const an = prepareBuiltin('annulus'), L = an.prep.report.loops;
  close(L[an.suggestedPorts[0].loops[0][0]].area - L[an.suggestedPorts[0].loops[0][1]].area, Math.PI * (0.02 ** 2 - 0.01 ** 2), 1e-6, 'annulus ring');
  // circumferential and axial segments of the tube are about equally long
  const t = prepareBuiltin('tube').prep.report;
  assert.equal(t.loops[0].sides, 64);
  const seg = 2 * Math.PI * 0.02 / 64, axial = 0.2 / ((t.nTri / 2) / 64);
  assert.ok(Math.abs(axial / seg - 1) < 0.02);
});

test('the elbow is mitered: both legs end on the plane x + z = A with shared seam vertices', () => {
  const b = prepareBuiltin('elbow');
  const V = b.prep.mesh.vertices;
  let onMiter = 0;
  for (let i = 0; i < V.length; i += 3) if (Math.abs(V[i] + V[i + 2] - 0.06) < 1e-7) onMiter++;
  assert.equal(onMiter, 64, 'exactly one ring of 64 vertices on the miter plane, used by both legs');
  // legs: inlet face at z = 0, outlet face at x = B
  const [inl, outl] = b.suggestedPorts.map((p) => b.prep.report.loops[p.loops[0][0]]);
  assert.ok(Math.abs(inl.centroid[2]) < 1e-12 && Math.abs(Math.abs(inl.normal[2]) - 1) < 1e-12);
  assert.ok(Math.abs(outl.centroid[0] - 0.06) < 1e-7 && Math.abs(Math.abs(outl.normal[0]) - 1) < 1e-12);
  assert.ok(Math.abs(outl.centroid[2] - 0.06) < 1e-7);
  // other legs and bores
  const e2 = prepareBuiltin('elbow', { d: 0.1, A: 0.1, B: 0.3 }).prep.report;
  assert.equal(e2.loops.length, 2);
  assert.ok(Math.abs(e2.bbox[3] - 0.3) < 1e-7);
  assert.throws(() => makeBuiltin('elbow', { A: 0.02 }), /^RangeError: Each elbow leg must be longer than the bore radius \(20\.02 mm\)\.$/);
});

test('reference values are those of Appendix B.2 and of the validation fixture, and only for the default sizes', () => {
  const tp = CASES.tpmc_reference_cases_this_work;
  const want = {
    tube: [CASES.tube_this_work_L_over_R['10'], 0],
    elbow: [0.26524, 0.00021],
    cone: [CASES.cone_this_work['cone beta=20 L/R1=2'].alpha, CASES.cone_this_work['cone beta=20 L/R1=2'].sigma],
    annulus: [tp['annulus Ri/Ro=0.5 L/gap=2'].alpha, tp['annulus Ri/Ro=0.5 L/gap=2'].sigma],
    rect: [tp['rect b/a=1 L/a=1'].alpha, tp['rect b/a=1 L/a=1'].sigma],
    coneConv: [tp['cone beta=-10 L/R1=4'].alpha, tp['cone beta=-10 L/R1=4'].sigma],
  };
  for (const [name, [a, s]] of Object.entries(want)) {
    const r = makeBuiltin(name).reference;
    assert.equal(r.alpha, a, name);
    assert.equal(r.sigma, s, name);
    assert.ok(typeof r.source === 'string' && r.source.length > 10);
    assert.deepEqual(BUILTINS[name].reference, r);
  }
  // the pump tube: 188.0 ± 0.3 L/s of air at 20 °C (Livesey p. 100) as a transmission probability
  const S = CASES.series_examples.livesey_pump_S300_tube_d100_l200.S_n_tpmc_this_work;
  const air = gasState('air', 293.15), C0 = Math.PI * 0.05 ** 2 * air.vbar / 4;
  const r = makeBuiltin('pumpTube').reference;
  close(r.alpha * C0 * 1000, S[0], 1e-5, 'pump tube S_eff');
  close(r.sigma * C0 * 1000, S[1], 1e-5, 'pump tube sigma');
  // 16-gon: 3.51 % less conductance than the round tube
  const f16 = CASES.faceting_ngon_tube_this_work['L/R=10']['n=16'];
  const r16 = makeBuiltin('tube16').reference;
  close(r16.alpha * 8 * Math.sin(Math.PI / 8), 0.1909424 * Math.PI * (1 + f16 / 100), 1e-12, '16-gon');
  assert.equal(makeBuiltin('tube', { L: 0.4 }).reference, null);
  assert.equal(makeBuiltin('tube', { d: 0.04, L: 0.2 }).reference.alpha, 0.1909424);
  assert.equal(makeBuiltin('tube', { m: 3 }).reference, null);
});

test('parameters override the defaults; unknown names and bad sizes are refused', () => {
  const long = makeBuiltin('tube', { d: 0.04, L: 0.4 });
  let z1 = 0;
  for (let i = 2; i < long.positions.length; i += 3) z1 = Math.max(z1, long.positions[i]);
  assert.ok(Math.abs(z1 - 0.4) < 1e-7);
  assert.deepEqual(BUILTINS.tube.params, { d: 0.04, L: 0.2, n: 64 });
  assert.ok(Object.isFrozen(BUILTINS) && Object.isFrozen(BUILTINS.tube.params));
  assert.deepEqual(['tube16', 'coneConv', 'pumpTube'].map((n) => BUILTINS[n].testOnly), [true, true, true]);
  assert.ok(PUBLIC().every((n) => !BUILTINS[n].testOnly));
  assert.throws(() => makeBuiltin('sphere'), /There is no built-in geometry called "sphere"/);
  assert.throws(() => makeBuiltin('tube', { d: -1 }), /"d" must be a number above 0/);
  assert.throws(() => makeBuiltin('tube', { n: 6.5 }), /"n" must be a whole number/);
  assert.throws(() => makeBuiltin('annulus', { Ri: 0.03 }), /rod must be thinner than the bore/);
  // deterministic
  assert.deepEqual(makeBuiltin('cone').positions, makeBuiltin('cone').positions);
});

test('the elbow fixture for the manual checklist is the built-in elbow in millimetres', () => {
  const e = makeBuiltin('elbow');
  const mm = new Float32Array(e.positions.length);
  for (let i = 0; i < mm.length; i++) mm[i] = e.positions[i] * 1000;
  const buf = fixture('wp3/elbow-dn40-mm.stl');
  const r = parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.deepEqual(r.positions, mm);
});

function PUBLIC() { return ['tube', 'elbow', 'cone', 'annulus', 'rect']; }
