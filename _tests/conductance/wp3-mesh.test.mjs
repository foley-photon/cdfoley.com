// WP3 acceptance 3 (weld and validate) and 7 (faceting report): spec §3.6.4, §2.13 MeshReport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { weldMesh, validateMesh, prepareMesh, facetRegions, regionFrom } from '../../beta/conductance/js/engine/mesh.js';
import { parseOBJ } from '../../beta/conductance/js/io/obj.js';

const fxObj = (name) => parseOBJ(readFileSync(fileURLToPath(new URL('./fixtures/wp3/' + name, import.meta.url)), 'utf8')).positions;
const P = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const CUBE = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];
const soup = (tris) => Float32Array.from(tris.flat(2));
const cubeTris = () => CUBE.map((t) => t.map((i) => P[i].slice()));
const codes = (rep) => rep.messages.map((m) => m.code);
const msg = (rep, code) => rep.messages.find((m) => m.code === code);

// open tube of n sides (vertices on radius R), m rings, along z
function polyTube(n, R = 0.02, L = 0.1, m = 10) {
  const Pt = (k, j) => [R * Math.cos(2 * Math.PI * (k % n) / n), R * Math.sin(2 * Math.PI * (k % n) / n), L * j / m];
  const t = [];
  for (let j = 0; j < m; j++) for (let k = 0; k < n; k++) t.push([Pt(k, j), Pt(k + 1, j), Pt(k + 1, j + 1)], [Pt(k, j), Pt(k + 1, j + 1), Pt(k, j + 1)]);
  return soup(t);
}

test('a cube of 12 triangles with repeated vertices welds to 8 vertices: closed, consistent, volume ±1', () => {
  const w = weldMesh(soup(cubeTris()));
  assert.equal(w.mesh.vertices.length / 3, 8);
  assert.equal(w.mesh.tris.length / 3, 12);
  assert.equal(w.merged, 0, 'identical positions are not "merged"');
  assert.equal(w.degenerate, 0);
  assert.equal(w.duplicate, 0);
  const rep = validateMesh(w.mesh, w);
  assert.equal(rep.nVert, 8);
  assert.equal(rep.nTri, 12);
  assert.equal(rep.closed, true);
  assert.equal(rep.windingConsistent, true);
  assert.equal(rep.boundaryEdges, 0);
  assert.equal(rep.nonManifoldEdges, 0);
  assert.equal(rep.openChains, 0);
  assert.deepEqual(rep.loops, []);
  assert.ok(Math.abs(rep.signedVolume - 1) < 1e-12);
  assert.deepEqual(rep.bbox, [0, 0, 0, 1, 1, 1]);
  assert.ok(Math.abs(rep.diag - Math.sqrt(3)) < 1e-15);
  assert.equal(rep.severity, 'ok');
  assert.ok(codes(rep).includes('closed'));
  // the same cube wound inside out
  const inv = prepareMesh(soup(cubeTris().map((t) => [t[0], t[2], t[1]])));
  assert.ok(Math.abs(inv.report.signedVolume + 1) < 1e-12);
  assert.equal(inv.report.windingConsistent, true);
  assert.deepEqual(inv.autoPorts, [], 'a closed solid has no automatic openings');
});

test('one flipped triangle makes the winding inconsistent (and is reported)', () => {
  const t = cubeTris();
  t[5] = [t[5][0], t[5][2], t[5][1]];
  const rep = prepareMesh(soup(t)).report;
  assert.equal(rep.windingConsistent, false);
  assert.equal(rep.closed, true);
  assert.match(msg(rep, 'winding').text, /^3 edges have triangles wound in opposite directions/);
  assert.equal(rep.severity, 'warn');
});

test('a cube with one face removed: 4 boundary edges and 1 planar loop', () => {
  const { report: rep, autoPorts } = prepareMesh(fxObj('cube-open.obj'));
  assert.equal(rep.boundaryEdges, 4);
  assert.equal(rep.closed, false);
  assert.equal(rep.loops.length, 1);
  const l = rep.loops[0];
  assert.equal(l.planar, true);
  assert.equal(l.maxDev, 0);
  assert.equal(l.sides, 4);
  assert.equal(l.circular, false);
  assert.ok(Math.abs(l.area - 1) < 1e-12);
  assert.ok(Math.abs(l.perimeter - 4) < 1e-12);
  assert.deepEqual(l.centroid, [0.5, 0.5, 1]);
  assert.deepEqual(l.normal.map(Math.abs), [0, 0, 1]);
  assert.deepEqual(Array.from(l.vertices).sort(), [4, 5, 6, 7].map((i) => Array.from(l.vertices).sort()[0] + i - 4).sort());
  assert.ok(Math.abs(rep.signedVolume - 1) < 1e-12, 'volume after capping the loop');
  assert.equal(autoPorts.length, 1);
  assert.equal(autoPorts[0].role, 'inlet');
  assert.ok(codes(rep).includes('openings'));
});

test('non-manifold fixtures are flagged: bow-tie vertex, fin edge (with its open chain), T-junction', () => {
  const bow = prepareMesh(fxObj('bowtie.obj')).report;
  assert.equal(bow.closed, true);
  assert.equal(bow.nonManifoldEdges, 0);
  assert.ok(Math.abs(bow.signedVolume - 2) < 1e-12);
  assert.equal(msg(bow, 'nonmanifold-vertices').level, 'warn');
  assert.match(msg(bow, 'nonmanifold-vertices').text, /^1 vertex joins surfaces that touch at a single point/);

  const fin = prepareMesh(fxObj('fin.obj')).report;
  assert.equal(fin.nonManifoldEdges, 1);
  assert.equal(fin.closed, false);
  assert.equal(fin.openChains, 1);
  assert.equal(msg(fin, 'nonmanifold-edges').level, 'warn');
  assert.equal(msg(fin, 'open-chain').text, 'Open edge chain (2 edges) that does not form a loop.');
  assert.equal(fin.severity, 'error');

  const tj = prepareMesh(fxObj('tjunction.obj'));
  assert.equal(tj.report.boundaryEdges, 3);
  assert.equal(tj.report.loops.length, 1);
  assert.equal(tj.report.loops[0].planar, false, 'a sliver loop is never an opening');
  assert.ok(tj.report.loops[0].area < 1e-12);
  assert.equal(msg(tj.report, 't-junction').level, 'warn');
  assert.match(msg(tj.report, 't-junction').text, /T-junctions/);
  assert.deepEqual(tj.autoPorts, []);
});

test('degenerate and duplicate triangles are dropped and counted', () => {
  const t = cubeTris();
  t.push(t[0].map((p) => p.slice()));                     // exact duplicate
  t.push([t[1][2], t[1][0], t[1][1]].map((p) => p.slice())); // duplicate in another order (and winding)
  t.push([[0, 0, 0], [0, 0, 0], [1, 1, 1]]);                // two equal vertices
  t.push([[0, 0, 0], [0.5, 0, 0], [1, 0, 0]]);              // zero area
  const w = weldMesh(soup(t));
  assert.equal(w.degenerate, 2);
  assert.equal(w.duplicate, 2);
  assert.equal(w.mesh.tris.length / 3, 12);
  assert.equal(w.mesh.vertices.length / 3, 8, 'unused vertices are removed');
  const rep = validateMesh(w.mesh, w);
  assert.equal(rep.degenerate, 2);
  assert.equal(rep.duplicate, 2);
  assert.equal(rep.closed, true);
  assert.equal(msg(rep, 'degenerate').text, 'Removed 2 degenerate (zero-area) triangles.');
  assert.equal(msg(rep, 'duplicate').text, 'Removed 2 duplicate triangles.');
  // the surviving triangles keep their order
  assert.deepEqual(Array.from(w.mesh.tris.subarray(0, 6)), [0, 1, 2, 0, 2, 3]);
});

test('the weld tolerance can be changed', () => {
  const t = cubeTris();
  t[3][1] = [1 + 1e-5, 1, 1];                              // one copy of the vertex (1, 1, 1) is 10 µm off
  const def = prepareMesh(soup(t));                        // default 1e-6 × diag ≈ 1.7 µm: not merged
  assert.ok(Math.abs(def.report.weldTol / (1e-6 * Math.hypot(1 + 1e-5, 1, 1)) - 1) < 1e-6, 'default: 1e-6 × the bounding-box diagonal');
  assert.equal(def.report.merged, 0);
  assert.equal(def.report.closed, false);
  assert.ok(def.report.boundaryEdges > 0);
  const wide = prepareMesh(soup(t), 1e-4);
  assert.equal(wide.report.weldTol, 1e-4);
  assert.equal(wide.report.merged, 1);
  assert.equal(wide.report.closed, true);
  assert.equal(wide.report.nVert, 8);
  assert.match(msg(wide.report, 'merged').text, /^Merged 1 vertex closer than the merge tolerance \(0\.1000 mm\)\.$/);
  const exact = weldMesh(soup(cubeTris()), 0);
  assert.equal(exact.mesh.vertices.length / 3, 8, 'tolerance 0 still joins identical positions');
  assert.throws(() => weldMesh(soup(cubeTris()), -1), RangeError);
  assert.throws(() => weldMesh(new Float32Array(10)), /not a multiple of 9/);
  assert.throws(() => weldMesh(Float32Array.from([0, 0, NaN, 1, 0, 0, 0, 1, 0])), /not a finite number/);
  assert.throws(() => weldMesh(new Float32Array(9)), /no extent/);
});

test('faceting: a 32-gon opening reports sides 32 and about −1.0 %; a 64-gon gives no warning', () => {
  const r32 = prepareMesh(polyTube(32)).report;
  assert.equal(r32.loops.length, 2);
  for (const l of r32.loops) { assert.equal(l.circular, true); assert.equal(l.sides, 32); }
  assert.deepEqual(r32.faceting.map((f) => [f.sides, f.expectedErrorPct]), [[32, -0.98], [32, -0.98]]);
  const fw = r32.messages.filter((m) => m.code === 'faceting');
  assert.equal(fw.length, 2);
  assert.equal(fw[0].level, 'warn');
  assert.equal(fw[0].text, 'Opening 1 is a 32-sided polygon, so expect about −1.0 % conductance from faceting. '
    + 'Export with at least 64 segments per circle (about 0.1 rad angular deviation).');
  const r64 = prepareMesh(polyTube(64)).report;
  assert.deepEqual(r64.faceting.map((f) => [f.sides, f.expectedErrorPct]), [[64, -0.31], [64, -0.31]]);
  assert.equal(r64.messages.filter((m) => m.code === 'faceting').length, 0);
  assert.equal(r64.severity, 'ok');
  // log-n interpolation between the table rows; a square opening is not a circle
  const r48 = prepareMesh(polyTube(48)).report;
  const e48 = r48.faceting[0].expectedErrorPct;
  assert.ok(e48 < -0.31 && e48 > -0.98);
  assert.ok(Math.abs(e48 - (-0.98 + (-0.31 + 0.98) * Math.log2(1.5))) < 1e-6);
  assert.deepEqual(prepareMesh(polyTube(4)).report.faceting, []);
});

test('non-flat openings and implausible sizes are reported', () => {
  // a bent quad: an open surface whose only edge loop is not flat
  const bent = soup([[[0, 0, 0], [1, 0, 0], [1, 1, 0.2]], [[0, 0, 0], [1, 1, 0.2], [0, 1, 0]]]);
  const rep = prepareMesh(bent).report;
  assert.equal(rep.loops.length, 1);
  assert.equal(rep.loops[0].planar, false);
  assert.ok(rep.loops[0].maxDev > 0.04);
  assert.equal(msg(rep, 'nonplanar').level, 'error');
  assert.equal(rep.severity, 'error');
  const tiny = prepareMesh(soup(cubeTris().map((t) => t.map((p) => p.map((x) => x * 1e-5))))).report;
  assert.match(msg(tiny, 'size').text, /That looks too small or too large; check the unit\.$/);
  const huge = prepareMesh(soup(cubeTris().map((t) => t.map((p) => p.map((x) => x * 20))))).report;
  assert.ok(msg(huge, 'size'));
});

test('coplanar regions: a cube has six, regionFrom stays on its face', () => {
  const p = prepareMesh(soup(cubeTris()));
  const fr = facetRegions(p.mesh);
  assert.deepEqual(Array.from(fr), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  const r = regionFrom(p.mesh, 9);
  assert.deepEqual(Array.from(r.tris), [8, 9]);
  assert.ok(Math.abs(r.area - 1) < 1e-12);
  assert.deepEqual(r.plane.n.map(Math.abs), [1, 0, 0]);
  assert.ok(Math.abs(Math.abs(r.plane.d)) < 1e-12);
  assert.throws(() => regionFrom(p.mesh, 12), RangeError);
  // a looser angle joins neighbouring faces of a coarse polygonal tube (45° apart; the 90° faces stop the fill)
  const tube = prepareMesh(polyTube(8)).mesh;
  assert.equal(regionFrom(tube, 0).tris.length, 20, 'one flat strip of the 8-sided tube (10 rings × 2 triangles)');
  assert.equal(regionFrom(tube, 0, 50, 1).tris.length, 60);
  assert.equal(regionFrom(tube, 0, 91, 1).tris.length, 160);
  assert.equal(regionFrom(tube, 0, 50, 1e-9).tris.length, 20, 'the distance tolerance applies too');
});

test('weld, validation and loop detection of 100 000 triangles take ≤ 600 ms', () => {
  const pos = polyTube(250, 0.02, 0.2, 200);              // 100 000 triangles
  assert.equal(pos.length / 9, 100000);
  prepareMesh(pos);                                       // warm-up
  let best = Infinity;
  for (let k = 0; k < 2; k++) { const t0 = performance.now(); const p = prepareMesh(pos); best = Math.min(best, performance.now() - t0); assert.equal(p.report.loops.length, 2); }
  assert.ok(best <= 600, 'prepareMesh took ' + best.toFixed(0) + ' ms');
});
