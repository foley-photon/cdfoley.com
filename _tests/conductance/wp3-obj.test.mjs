// WP3 acceptance 2: OBJ reading (spec §7.4, §2.16): polygons split into fans, negative indices, the v/vt/vn forms,
// groups and comments; a malformed index reports its line number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseOBJ } from '../../beta/conductance/js/io/obj.js';
import { prepareMesh } from '../../beta/conductance/js/engine/mesh.js';

const fx = (name) => readFileSync(fileURLToPath(new URL('./fixtures/wp3/' + name, import.meta.url)), 'utf8');
const P = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const tri = (pos, t) => Array.from(pos.subarray(9 * t, 9 * t + 9));
const sentence = (re) => (err) => err instanceof RangeError && re.test(err.message);

test('a cube of quads: fans, negative indices, v/vt/vn forms, groups, comments, continuation lines', () => {
  const r = parseOBJ(fx('cube-quads.obj'));
  assert.equal(r.nTri, 12);
  assert.equal(r.positions.length, 108);
  // f 1/1/1 4/2/1 3/1/1 2/2/1 → (1, 4, 3) and (1, 3, 2)
  assert.deepEqual(tri(r.positions, 0), [...P[0], ...P[3], ...P[2]]);
  assert.deepEqual(tri(r.positions, 1), [...P[0], ...P[2], ...P[1]]);
  // f -4//1 -3//1 -2//1 -1//1 after eight vertices → 5 6 7 8
  assert.deepEqual(tri(r.positions, 2), [...P[4], ...P[5], ...P[6]]);
  assert.deepEqual(tri(r.positions, 3), [...P[4], ...P[6], ...P[7]]);
  // "f 4 8 \" continued by "  7 3"
  assert.deepEqual(tri(r.positions, 6), [...P[3], ...P[7], ...P[6]]);
  assert.deepEqual(r.groups, [{ name: 'bottom', start: 0, count: 2 }, { name: 'top', start: 2, count: 2 }, { name: 'sides', start: 4, count: 8 }]);
  assert.deepEqual(r.warnings, ['6 polygons were split into triangles (fans).']);
  const p = prepareMesh(r.positions);
  assert.equal(p.report.nVert, 8);
  assert.equal(p.report.closed, true);
  assert.equal(p.report.windingConsistent, true);
  assert.ok(Math.abs(p.report.signedVolume - 1) < 1e-12);
});

test('a malformed face index reports its line number', () => {
  assert.throws(() => parseOBJ(fx('bad-index.obj')), sentence(/^Line 6: face index 9 refers to a vertex that does not exist \(the file has 4 vertices\)\.$/));
  const base = 'v 0 0 0\nv 1 0 0\nv 0 1 0\n';
  assert.throws(() => parseOBJ(base + 'f 1 2 x\n'), sentence(/^Line 4: "x" is not a valid face index\.$/));
  assert.throws(() => parseOBJ(base + 'f 1/1 2.5 3\n'), sentence(/^Line 4: "2\.5" is not a valid face index\.$/));
  assert.throws(() => parseOBJ(base + '\n# comment\nf 1 0 2\n'), sentence(/^Line 6: face index 0 is not valid/));
  assert.throws(() => parseOBJ(base + 'f -9 1 2\n'), sentence(/^Line 4: face index -9 refers to a vertex before the first one/));
  assert.throws(() => parseOBJ(base + 'f 1 2\n'), sentence(/^Line 4: a face needs at least three vertices\.$/));
  assert.throws(() => parseOBJ('v 0 0\n'), sentence(/^Line 1: a vertex needs three coordinates\.$/));
  assert.throws(() => parseOBJ('v 0 abc 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'), sentence(/^Line 1: "abc" is not a valid coordinate\.$/));
  assert.throws(() => parseOBJ(base), sentence(/has vertices but no faces/));
  assert.throws(() => parseOBJ(''), sentence(/contains no faces/));
});

test('CRLF, trailing comments, w coordinates, forward references and ignored statements', () => {
  const text = [
    '# made by hand', 'f 1 2 3 # faces may come before their vertices', 'v 0 0 0 1.0', 'v 1 0 0', 'v 0 1 0', 'vn 0 0 1', 'vp 0.5',
    's 1', 'usemtl x', 'l 1 2', 'p 3', 'cstype bezier', '',
  ].join('\r\n');
  const r = parseOBJ(text);
  assert.equal(r.nTri, 1);
  assert.deepEqual(Array.from(r.positions), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(r.groups, [{ name: 'default', start: 0, count: 1 }]);
  assert.deepEqual(r.warnings, ['2 point or line elements were ignored.']);
  // relative indices are counted at the face's position in the file
  const rel = parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\nv 5 5 5\nf -4 -3 -1\n');
  assert.deepEqual(Array.from(rel.positions.subarray(9, 18)), [0, 0, 0, 1, 0, 0, 5, 5, 5]);
  // bytes are accepted too
  assert.equal(parseOBJ(new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')).nTri, 1);
});

test('the open cube, bow-tie, fin and T-junction fixtures read as expected', () => {
  assert.equal(parseOBJ(fx('cube-open.obj')).nTri, 10);
  assert.equal(parseOBJ(fx('bowtie.obj')).nTri, 24);
  assert.equal(parseOBJ(fx('fin.obj')).nTri, 13);
  assert.equal(parseOBJ(fx('tjunction.obj')).nTri, 13);
});
