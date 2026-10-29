// WP3 acceptance 1: STL reading and writing (spec §7.4, §2.16).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSTL, writeBinarySTL } from '../../beta/conductance/js/io/stl.js';
import { prepareMesh } from '../../beta/conductance/js/engine/mesh.js';

const fx = (name) => readFileSync(fileURLToPath(new URL('./fixtures/wp3/' + name, import.meta.url)));
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// unit cube, outward normals (as in fixtures/wp3/cube-ascii.stl)
const P = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const CUBE = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];
const cube = () => Float32Array.from(CUBE.flatMap((t) => t.flatMap((i) => P[i])));
const textBuf = (s) => ab(Buffer.from(s, 'utf8'));
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('binary STL is recognised by its size 84 + 50·N even when the header starts with "solid"', () => {
  const buf = writeBinarySTL(cube());
  const bytes = new Uint8Array(buf);
  const head = 'solid cube exported by some CAD program';
  for (let k = 0; k < head.length; k++) bytes[k] = head.charCodeAt(k);
  const r = parseSTL(buf);
  assert.equal(r.format, 'stl-binary');
  assert.equal(r.nTri, 12);
  assert.deepEqual(Array.from(r.positions), Array.from(cube()));
  // our own writer never starts the header with "solid"
  const w = new Uint8Array(writeBinarySTL(cube(), 'solid model'));
  assert.notEqual(String.fromCharCode(...w.subarray(0, 5)), 'solid');
});

test('ASCII STL: facets with any whitespace, with or without normals, give the same triangles', () => {
  const a = parseSTL(ab(fx('cube-ascii.stl')));
  const b = parseSTL(ab(fx('cube-messy.stl')));          // no normals, tabs, CRLF, several keywords per line, 1.0e0
  for (const r of [a, b]) {
    assert.equal(r.format, 'stl-ascii');
    assert.equal(r.nTri, 12);
    assert.deepEqual(Array.from(r.positions), Array.from(cube()));
  }
  assert.deepEqual(a.warnings, []);
  const p = prepareMesh(b.positions);
  assert.equal(p.report.nVert, 8);
  assert.equal(p.report.closed, true);
  // a facet loop with four vertices is split into two triangles, with a warning
  const quad = parseSTL(textBuf('solid q\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 1 1 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid q\n'));
  assert.equal(quad.nTri, 2);
  assert.match(quad.warnings.join(' '), /more than three vertices/);
});

test('stored normals are ignored: the vertex order defines each triangle', () => {
  // flip every stored normal in a binary file
  const buf = writeBinarySTL(cube());
  const dv = new DataView(buf);
  for (let t = 0; t < 12; t++) for (let k = 0; k < 3; k++) dv.setFloat32(84 + 50 * t + 4 * k, -dv.getFloat32(84 + 50 * t + 4 * k, true), true);
  const r = parseSTL(buf);
  assert.deepEqual(Array.from(r.positions), Array.from(cube()));
  assert.match(r.warnings.join(' '), /^12 facet normals in the file point against the vertex order; the vertex order is used\.$/);
  const p = prepareMesh(r.positions);
  assert.ok(Math.abs(p.report.signedVolume - 1) < 1e-12, 'orientation comes from the vertex order');
  // the writer stores the unit normal of the vertex order
  const w = new DataView(writeBinarySTL(cube()));
  assert.deepEqual([w.getFloat32(84, true), w.getFloat32(88, true), w.getFloat32(92, true)], [0, 0, -1]);
  // ASCII with a wrong normal
  const t = parseSTL(textBuf('solid x\nfacet normal 0 0 -1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid\n'));
  assert.equal(t.warnings.length, 1);
  assert.deepEqual(Array.from(t.positions), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
});

test('empty, 0-triangle, truncated, non-finite and non-STL files fail with readable messages', () => {
  const sentence = (re) => (err) => err instanceof RangeError && re.test(err.message) && /[.]$/.test(err.message);
  assert.throws(() => parseSTL(new ArrayBuffer(0)), sentence(/empty/));
  const zero = new ArrayBuffer(84);
  assert.throws(() => parseSTL(zero), sentence(/contains no triangles/));
  assert.throws(() => parseSTL(textBuf('solid nothing\nendsolid nothing\n')), sentence(/contains no triangles/));
  const full = writeBinarySTL(cube());
  assert.throws(() => parseSTL(full.slice(0, 84 + 50 * 11 + 20)), sentence(/truncated: its header announces 12 triangles \(684 bytes\), but the file has 654 bytes/));
  const nan = writeBinarySTL(cube());
  new DataView(nan).setFloat32(84 + 50 * 4 + 12 + 4, NaN, true);
  assert.throws(() => parseSTL(nan), sentence(/Triangle 5 has a coordinate that is not a finite number/));
  const inf = writeBinarySTL(cube());
  new DataView(inf).setFloat32(84 + 12, Infinity, true);
  assert.throws(() => parseSTL(inf), sentence(/Triangle 1 has a coordinate that is not a finite number/));
  assert.throws(() => parseSTL(textBuf('solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 nan 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid\n')),
    sentence(/^Line 4: "nan" is not a number\.$/));
  assert.throws(() => parseSTL(textBuf('solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nendloop\nendfacet\nendsolid\n')),
    sentence(/^Line 6: a facet needs three vertices, but this one has 2\.$/));
  assert.throws(() => parseSTL(textBuf('solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0')), sentence(/ends in the middle/));
  assert.throws(() => parseSTL(textBuf('hello world, this is a text file and certainly not a stereolithography model at all, sorry')),
    sentence(/not an STL file/));
  assert.throws(() => parseSTL(textBuf('cube')), sentence(/not an STL file/));
  // extra bytes after the last triangle are reported, not fatal
  const padded = new Uint8Array(full.byteLength + 7);
  padded.set(new Uint8Array(full));
  const r = parseSTL(padded.buffer);
  assert.equal(r.nTri, 12);
  assert.match(r.warnings.join(' '), /7 extra bytes/);
});

test('binary write followed by parse is lossless (bit for bit), header included', () => {
  const R = rng(7);
  const n = 5000, pos = new Float32Array(9 * n);
  for (let i = 0; i < pos.length; i++) pos[i] = (R() - 0.5) * Math.pow(10, Math.floor(R() * 12) - 6);
  pos[0] = -0; pos[1] = 1e-38; pos[2] = 3.4e38;
  const buf = writeBinarySTL(pos, 'round trip test');
  assert.equal(buf.byteLength, 84 + 50 * n);
  assert.equal(String.fromCharCode(...new Uint8Array(buf, 0, 15)), 'round trip test');
  const r = parseSTL(buf);
  assert.equal(r.nTri, n);
  const a = new Uint32Array(pos.buffer), b = new Uint32Array(r.positions.buffer);
  assert.equal(b.length, a.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) assert.fail('word ' + i + ' differs');
  assert.throws(() => writeBinarySTL(new Float32Array(10)), RangeError);
});

test('a binary STL of 100 000 triangles parses in ≤ 300 ms', () => {
  const R = rng(11);
  const n = 100000, pos = new Float32Array(9 * n);
  for (let i = 0; i < pos.length; i++) pos[i] = R();
  const buf = writeBinarySTL(pos);
  parseSTL(buf);                                           // warm-up
  let best = Infinity;
  for (let k = 0; k < 3; k++) { const t0 = performance.now(); const r = parseSTL(buf); best = Math.min(best, performance.now() - t0); assert.equal(r.nTri, n); }
  assert.ok(best <= 300, 'parse took ' + best.toFixed(1) + ' ms');
});

test('the fixture elbow-dn40-mm.stl is the built-in elbow in millimetres', () => {
  const r = parseSTL(ab(fx('elbow-dn40-mm.stl')));
  assert.equal(r.format, 'stl-binary');
  assert.equal(r.nTri, 7936);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < r.positions.length; i += 3) { x0 = Math.min(x0, r.positions[i]); x1 = Math.max(x1, r.positions[i]); z0 = Math.min(z0, r.positions[i + 2]); z1 = Math.max(z1, r.positions[i + 2]); }
  assert.ok(Math.abs(x1 - 60) < 1e-4 && Math.abs(z0) < 1e-6, 'outlet face at x = 60 mm, inlet at z = 0');
  assert.ok(Math.abs(x0 + 20.016) < 0.01 && Math.abs(z1 - 80.016) < 0.01, 'bore Ø40 mm (area-preserving 64-gon)');
});
