// WP3 acceptance 4: ear clipping with holes (spec §3.6.4 step 5): exact total area, no overlaps, input winding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { triangulatePolygon } from '../../beta/conductance/js/engine/triangulate.js';

function circle(n, r, cx = 0, cy = 0, cw = false, phase = 0) {
  const a = new Float64Array(2 * n);
  for (let k = 0; k < n; k++) { const t = phase + (cw ? -1 : 1) * 2 * Math.PI * k / n; a[2 * k] = cx + r * Math.cos(t); a[2 * k + 1] = cy + r * Math.sin(t); }
  return a;
}
const signedArea = (p) => { let s = 0; const n = p.length / 2; for (let i = 0, j = n - 1; i < n; j = i++) s += (p[2 * j] - p[2 * i]) * (p[2 * j + 1] + p[2 * i + 1]); return s / 2; };
function concat(outer, holes) {
  const all = new Float64Array(outer.length + holes.reduce((s, h) => s + h.length, 0));
  all.set(outer); let o = outer.length;
  for (const h of holes) { all.set(h, o); o += h.length; }
  return all;
}
function tris(all, idx) {
  const out = [];
  for (let k = 0; k < idx.length; k += 3) out.push([0, 1, 2].map((j) => [all[2 * idx[k + j]], all[2 * idx[k + j] + 1]]));
  return out;
}
const triArea = (t) => ((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[1][1] - t[0][1]) * (t[2][0] - t[0][0])) / 2;
// interiors overlap: no separating axis among the six edge normals (touching along an edge or a corner is fine)
function overlap(A, B, eps) {
  for (const T of [A, B]) {
    for (let i = 0; i < 3; i++) {
      const p = T[i], q = T[(i + 1) % 3], nx = q[1] - p[1], ny = p[0] - q[0], len = Math.hypot(nx, ny);
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const v of A) { const d = nx * v[0] + ny * v[1]; amin = Math.min(amin, d); amax = Math.max(amax, d); }
      for (const v of B) { const d = nx * v[0] + ny * v[1]; bmin = Math.min(bmin, d); bmax = Math.max(bmax, d); }
      if (amax <= bmin + eps * len || bmax <= amin + eps * len) return false;
    }
  }
  return true;
}
// checks a triangulation: count, exact area, winding, every vertex used, and (optionally) no overlaps
function check(outer, holes = [], { pairwise = true } = {}) {
  const idx = triangulatePolygon(outer, holes);
  const all = concat(outer, holes), T = tris(all, idx);
  const nTotal = all.length / 2;
  assert.equal(T.length, nTotal + 2 * holes.length - 2, 'n + 2h − 2 triangles');
  const expect = Math.abs(signedArea(outer)) - holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
  const sgn = Math.sign(signedArea(outer));
  let sum = 0;
  for (const t of T) { const a = triArea(t); assert.ok(sgn * a > 0, 'every triangle has the winding of the outer loop'); sum += Math.abs(a); }
  assert.ok(Math.abs(sum - expect) <= 1e-12 * expect, 'area ' + sum + ' vs ' + expect);
  const used = new Set(idx);
  assert.equal(used.size, nTotal, 'every vertex is used, so caps meet the mesh edge to edge');
  if (pairwise) {
    let size = 0;
    for (let k = 0; k < all.length; k++) size = Math.max(size, Math.abs(all[k]));
    for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) if (overlap(T[i], T[j], 1e-9 * size)) assert.fail('triangles ' + i + ' and ' + j + ' overlap');
  }
  return idx;
}
function reversed(p) {
  const r = new Float64Array(p.length), n = p.length / 2;
  for (let k = 0; k < n; k++) { r[2 * k] = p[2 * (n - 1 - k)]; r[2 * k + 1] = p[2 * (n - 1 - k) + 1]; }
  return r;
}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('a 2000-vertex circle (and a clockwise one) triangulate with the exact area', () => {
  check(circle(2000, 1), [], { pairwise: false });
  check(circle(2000, 0.05, 1, 2, true), [], { pairwise: false });
  check(circle(64, 1));
});

test('an L-shape (whose diagonal runs through the reflex corner) triangulates without overlaps', () => {
  check(Float64Array.from([0, 0, 2, 0, 2, 1, 1, 1, 1, 2, 0, 2]));
  check(Float64Array.from([0, 0, 0, 2, 1, 2, 1, 1, 2, 1, 2, 0]));       // clockwise
  check(Float64Array.from([0, 0, 3, 0, 3, 1, 1, 1, 1, 3, 0, 3]));
});

test('an annulus of 64 + 64 vertices and a polygon with 3 holes', () => {
  check(circle(64, 1), [circle(64, 0.5)]);
  check(circle(64, 1), [circle(64, 0.5, 0, 0, true)]);                   // hole given clockwise
  check(circle(64, 0.02, 0, 0, true), [circle(64, 0.01)]);               // outer clockwise, small coordinates
  check(circle(48, 1), [circle(12, 0.2, 0.45, 0), circle(12, 0.2, -0.4, 0.15, true, 0.3), circle(10, 0.15, 0, -0.5)]);
  check(circle(400, 1), [circle(60, 0.2, 0.45, 0), circle(60, 0.2, -0.4, 0.15), circle(60, 0.15, 0, -0.5)], { pairwise: false });
});

test('holes whose rightmost vertices share the ray, and a hole touching the axis of an earlier bridge', () => {
  // two holes at the same height: the second bridge may land on the first one's copy of the outer vertex
  check(circle(32, 1), [circle(8, 0.15, -0.5, 0), circle(8, 0.15, 0.3, 0)]);
  check(circle(32, 1), [circle(8, 0.15, 0.3, 0), circle(8, 0.15, 0.3, 0.5), circle(8, 0.15, 0.3, -0.5)]);
  // square outer with collinear vertices on its sides (as the rect built-in's end loops) and a square hole
  const sq = (a, g, cw = false) => {
    const p = [];
    for (let i = 0; i < g; i++) p.push(-a + 2 * a * i / g, -a);
    for (let i = 0; i < g; i++) p.push(a, -a + 2 * a * i / g);
    for (let i = 0; i < g; i++) p.push(a - 2 * a * i / g, a);
    for (let i = 0; i < g; i++) p.push(-a, a - 2 * a * i / g);
    const f = Float64Array.from(p);
    if (!cw) return f;
    const r = new Float64Array(f.length);
    for (let k = 0; k < f.length / 2; k++) { r[2 * k] = f[f.length - 2 - 2 * k]; r[2 * k + 1] = f[f.length - 1 - 2 * k]; }
    return r;
  };
  check(sq(1, 16));
  check(sq(1, 8), [sq(0.3, 4, true)]);
});

test('random star-shaped polygons with holes: exact area, no overlaps, input winding', () => {
  const R = rng(20261013);
  for (let trial = 0; trial < 200; trial++) {
    const n = 8 + Math.floor(R() * 40);
    const outer = new Float64Array(2 * n);
    for (let k = 0; k < n; k++) { const t = 2 * Math.PI * (k + 0.3 * R()) / n, r = 0.35 + 0.65 * R(); outer[2 * k] = r * Math.cos(t); outer[2 * k + 1] = r * Math.sin(t); }
    const holes = [];
    const nh = Math.floor(R() * 3);
    for (let h = 0; h < nh; h++) holes.push(circle(5 + Math.floor(R() * 6), 0.08, (h - 1) * 0.25, 0.1 * (R() - 0.5), R() < 0.5, R()));
    check(trial % 2 ? outer : reversed(outer), holes);
  }
});

test('degenerate inputs end cleanly', () => {
  assert.equal(triangulatePolygon(Float64Array.from([0, 0, 1, 0])).length, 0);
  assert.equal(triangulatePolygon(Float64Array.from([0, 0, 1, 0, 2, 0])).length, 0, 'zero area');
  assert.equal(triangulatePolygon(new Float64Array(0)).length, 0);
  const t = triangulatePolygon(Float64Array.from([0, 0, 1, 0, 1, 0, 1, 1, 0, 1]));    // a repeated vertex
  assert.ok(t.length % 3 === 0 && t.length >= 6);
});
