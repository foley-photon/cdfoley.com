// WP2: BVH build and watertight closest-hit tracing (spec §2.12, §3.6.3; §7.3 acceptance 4).
// Meshes are built locally here (the built-in tube and elbow follow the testgeom.js construction of §7.4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBVH, makeTracer, closestHit } from '../../beta/conductance/js/engine/bvh.js';
import { makeScene } from '../../beta/conductance/js/engine/mesh-mc.js';
import { makeRng } from '../../beta/conductance/js/engine/rng.js';
import { NodeWorker } from './node-worker.mjs';
import { openSync, writeSync, closeSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// node --test runs files in parallel: the thread-heavy WP2 files (bvh, mesh, runner) take turns through a lock file
// in the OS temp folder, so WP2 never has more than 7 worker threads at a time (§5.4: ≤ 11 in the whole run).
const THREAD_LOCK = join(tmpdir(), 'cdfoley-conductance-wp2-threads.lock');
async function acquireThreads() {
  for (;;) {
    try { const fd = openSync(THREAD_LOCK, 'wx'); writeSync(fd, String(process.pid)); closeSync(fd); return; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const pid = Number(readFileSync(THREAD_LOCK, 'utf8'));
        let alive = pid > 0;
        if (alive) { try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; } }
        if (!alive || Date.now() - statSync(THREAD_LOCK).mtimeMs > 180000) unlinkSync(THREAD_LOCK);
      } catch (_) { /* released meanwhile */ }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
function releaseThreads() { try { if (Number(readFileSync(THREAD_LOCK, 'utf8')) === process.pid) unlinkSync(THREAD_LOCK); } catch (_) { /* gone */ } }

// ---- local geometry (64 segments, area-preserving radius, axial segment ≈ circumferential segment)
const areaR = (R, n) => R * Math.sqrt(2 * Math.PI / (n * Math.sin(2 * Math.PI / n)));
function soup(tris) {
  const tri = new Float32Array(9 * tris.length);
  tris.forEach((t, i) => { for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) tri[9 * i + 3 * v + k] = t[v][k]; });
  return tri;
}
function tubeMesh(R = 0.02, L = 0.2, n = 64) {
  const Rp = areaR(R, n), m = Math.max(1, Math.round(L / (2 * Math.PI * R / n)));
  const P = (k, z) => [Rp * Math.cos(2 * Math.PI * k / n), Rp * Math.sin(2 * Math.PI * k / n), z];
  const tris = [], port = [];
  for (let j = 0; j < m; j++) {
    const z0 = L * j / m, z1 = L * (j + 1) / m;
    for (let k = 0; k < n; k++) { const a = P(k, z0), b = P(k + 1, z0), c = P(k + 1, z1), d = P(k, z1); tris.push([a, b, c], [a, c, d]); port.push(-1, -1); }
  }
  for (const [z, g] of [[0, 0], [L, 1]]) for (let k = 0; k < n; k++) { tris.push([[0, 0, z], P(k, z), P(k + 1, z)]); port.push(g); }
  return { tri: soup(tris), triPort: Int16Array.from(port) };
}
function elbowMesh(R = 0.02, A = 0.06, B = 0.06, n = 64) {
  const Rp = areaR(R, n), ds = 2 * Math.PI * R / n;
  const m0 = Math.max(1, Math.round(A / ds)), m1 = Math.max(1, Math.round(B / ds));
  const c = (k) => Math.cos(2 * Math.PI * k / n), s = (k) => Math.sin(2 * Math.PI * k / n);
  const leg0 = (k, j) => { const zt = A - Rp * c(k); return [Rp * c(k), Rp * s(k), zt * j / m0]; };
  const leg1 = (k, j) => { const x0 = Rp * c(k); return [x0 + (B - x0) * j / m1, Rp * s(k), A - Rp * c(k)]; };
  const tris = [], port = [];
  for (const [f, m] of [[leg0, m0], [leg1, m1]]) {
    for (let j = 0; j < m; j++) for (let k = 0; k < n; k++) {
      const a = f(k, j), b = f(k + 1, j), cc = f(k + 1, j + 1), d = f(k, j + 1);
      tris.push([a, b, cc], [a, cc, d]); port.push(-1, -1);
    }
  }
  for (let k = 0; k < n; k++) { tris.push([[0, 0, 0], leg0(k, 0), leg0(k + 1, 0)]); port.push(0); }
  for (let k = 0; k < n; k++) { tris.push([[B, 0, A], leg1(k, m1), leg1(k + 1, m1)]); port.push(1); }
  return { tri: soup(tris), triPort: Int16Array.from(port) };
}

// ---- independent brute force: bounding-sphere cull, then the watertight test written out again
function bruteForce(scene) {
  const T = scene.tri, n = scene.nTri, cx = new Float64Array(n), cy = new Float64Array(n), cz = new Float64Array(n), r2 = new Float64Array(n);
  for (let s = 0; s < n; s++) {
    const o = 9 * s;
    cx[s] = (T[o] + T[o + 3] + T[o + 6]) / 3; cy[s] = (T[o + 1] + T[o + 4] + T[o + 7]) / 3; cz[s] = (T[o + 2] + T[o + 5] + T[o + 8]) / 3;
    let r = 0;
    for (let v = 0; v < 3; v++) r = Math.max(r, Math.hypot(T[o + 3 * v] - cx[s], T[o + 3 * v + 1] - cy[s], T[o + 3 * v + 2] - cz[s]));
    r2[s] = (r * (1 + 1e-6) + 1e-12) ** 2;
  }
  return (o3, d3) => {
    const dl = Math.hypot(d3[0], d3[1], d3[2]), ux = d3[0] / dl, uy = d3[1] / dl, uz = d3[2] / dl;
    const ad = d3.map(Math.abs);
    let kz = ad[0] > ad[1] ? (ad[0] > ad[2] ? 0 : 2) : (ad[1] > ad[2] ? 1 : 2);
    let kx = (kz + 1) % 3, ky = (kx + 1) % 3;
    if (d3[kz] < 0) [kx, ky] = [ky, kx];
    const Sx = d3[kx] / d3[kz], Sy = d3[ky] / d3[kz], Sz = 1 / d3[kz];
    let best = Infinity, slot = -1;
    for (let s = 0; s < n; s++) {
      const wx = cx[s] - o3[0], wy = cy[s] - o3[1], wz = cz[s] - o3[2];
      const tp = wx * ux + wy * uy + wz * uz, w2 = wx * wx + wy * wy + wz * wz;
      if (tp < 0 ? w2 > r2[s] : w2 - tp * tp > r2[s]) continue;
      const o = 9 * s;
      const Az = T[o + kz] - o3[kz], Bz = T[o + 3 + kz] - o3[kz], Cz = T[o + 6 + kz] - o3[kz];
      const Ax = T[o + kx] - o3[kx] - Sx * Az, Ay = T[o + ky] - o3[ky] - Sy * Az;
      const Bx = T[o + 3 + kx] - o3[kx] - Sx * Bz, By = T[o + 3 + ky] - o3[ky] - Sy * Bz;
      const Cx = T[o + 6 + kx] - o3[kx] - Sx * Cz, Cy = T[o + 6 + ky] - o3[ky] - Sy * Cz;
      const U = Cx * By - Cy * Bx, V = Ax * Cy - Ay * Cx, W = Bx * Ay - By * Ax;
      if ((U < 0 || V < 0 || W < 0) && (U > 0 || V > 0 || W > 0)) continue;
      const det = U + V + W;
      if (det === 0) continue;
      const t = (U * (Sz * Az) + V * (Sz * Bz) + W * (Sz * Cz)) / det;
      if (t > 0 && t < best) { best = t; slot = s; }
    }
    return { slot, t: best };
  };
}

function compareRays(scene, nRays, seed, spread) {
  const bf = bruteForce(scene), rng = makeRng(seed), bb = scene.bbox;
  let hits = 0, mism = 0, first = '';
  for (let i = 0; i < nRays; i++) {
    const o = [0, 1, 2].map((k) => bb[k] + (bb[k + 3] - bb[k]) * (0.5 + spread * (rng() - 0.5)));
    const d = [2 * rng() - 1, 2 * rng() - 1, 2 * rng() - 1];
    const a = closestHit(scene, o, d), b = bf(o, d);
    if (b.slot >= 0) hits++;
    const ok = a === null ? b.slot < 0 : (a.slot === b.slot || a.t === b.t) && a.t === b.t;
    if (!ok) { mism++; if (!first) first = JSON.stringify({ o, d, a, b }); }
  }
  return { hits, mism, first };
}

test('BVH layout: every triangle once, leaves ≤ 4, left child = node + 1, boxes contain their triangles', () => {
  const { tri } = elbowMesh();
  const n = tri.length / 9;
  const b = buildBVH(tri);
  assert.equal(b.order.length, n);
  const seen = new Uint8Array(n);
  for (const i of b.order) { assert.equal(seen[i], 0); seen[i] = 1; }
  assert.equal(b.box.length, 6 * b.nodes);
  assert.equal(b.meta.length, 2 * b.nodes);
  assert.ok(b.depth > 0 && b.depth <= 200);
  let leafTris = 0;
  const visit = (nd, depth) => {
    const m0 = b.meta[2 * nd], m1 = b.meta[2 * nd + 1];
    const box = b.box.subarray(6 * nd, 6 * nd + 6);
    assert.ok(box instanceof Float32Array);
    const inBox = (s) => { const i = b.order[s]; for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) { const x = tri[9 * i + 3 * v + k]; if (x < box[k] || x > box[k + 3]) return false; } return true; };
    if (m1 > 0) {
      assert.ok(m1 <= 4);
      for (let s = m0; s < m0 + m1; s++) assert.ok(inBox(s));
      leafTris += m1;
      return;
    }
    assert.ok(m1 >= -3 && m1 <= -1);
    assert.ok(m0 > nd + 1 && m0 < b.nodes);
    visit(nd + 1, depth + 1); visit(m0, depth + 1);
  };
  visit(0, 0);
  assert.equal(leafTris, n);
  // boxes are rounded outward (strictly larger than the exact extent)
  let x0 = Infinity;
  for (let i = 0; i < n; i++) for (let v = 0; v < 3; v++) x0 = Math.min(x0, tri[9 * i + 3 * v]);
  assert.ok(b.box[0] < x0);
});

test('closestHit equals a brute-force closest hit for 10^5 random rays on the built-in elbow', () => {
  const { tri, triPort } = elbowMesh();
  const sc = makeScene(tri, triPort, [{ role: 'inlet', stick: 1, inward: [0, 0, 1] }, { role: 'outlet', stick: 1, inward: [-1, 0, 0] }]);
  const r = compareRays(sc, 1e5, 77, 1.2);
  assert.equal(r.mism, 0, r.first);
  assert.ok(r.hits > 5e4);
});

test('closestHit equals a brute-force closest hit for 10^5 random rays on a 10^4-triangle soup', () => {
  const rng = makeRng(4242), tris = [];
  for (let i = 0; i < 1e4; i++) {
    const c = [rng(), rng(), rng()];
    tris.push([0, 1, 2].map(() => c.map((x) => x + 0.1 * (rng() - 0.5))));
  }
  const tri = soup(tris);
  const sc = makeScene(tri, new Int16Array(1e4).fill(-1), []);
  const r = compareRays(sc, 1e5, 78, 1);
  assert.equal(r.mism, 0, r.first);
  assert.ok(r.hits > 5e4);
});

test('the tracer skips the slot it leaves from and reports misses', () => {
  const { tri, triPort } = tubeMesh();
  const sc = makeScene(tri, triPort, [{ role: 'inlet', stick: 1, inward: [0, 0, 1] }, { role: 'outlet', stick: 1, inward: [0, 0, -1] }]);
  const trace = makeTracer(sc), out = new Float64Array(1);
  const s = trace(0, 0, 0.1, 1, 0, 0, -1, out);
  assert.ok(s >= 0);
  const t = out[0];
  assert.ok(Math.abs(t - 0.02) < 0.001);
  // from the hit point, skipping its own slot, the ray along +x leaves the tube
  assert.equal(trace(t, 0, 0.1, 1, 0, 0, s, out), -1);
  assert.equal(out[0], Infinity);
  assert.equal(closestHit(sc, [1, 1, 1], [1, 0, 0]), null);
});

test('axis-aligned rays with zero and negative-zero components hit what a brute force hits', () => {
  const { tri, triPort } = tubeMesh();
  const sc = makeScene(tri, triPort, [{ role: 'inlet', stick: 1, inward: [0, 0, 1] }, { role: 'outlet', stick: 1, inward: [0, 0, -1] }]);
  const bf = bruteForce(sc);
  const rays = [
    [[0.001, 0.002, 0.1], [-0, 0, 1]], [[0.001, 0.002, 0.1], [-0, -0, -1]], [[0.001, 0.002, 0.1], [1, -0, -0]],
    [[0.001, 0.002, 0.1], [-0, -1, 0]], [[0, 0, 0.05], [0, 0, 1]], [[-0, -0, 0.05], [-0, -0, -1]],
  ];
  for (const [o, d] of rays) {
    const a = closestHit(sc, o, d), b = bf(o, d);
    assert.ok(a && b.slot >= 0, `ray ${JSON.stringify(o)} ${d.map((x) => (Object.is(x, -0) ? '-0' : x))} must hit`);
    assert.equal(a.t, b.t);
    const plus = closestHit(sc, o, d.map((x) => (x === 0 ? 0 : x)));
    assert.equal(plus.t, a.t);
  }
  // origins exactly on a node's box faces, rays along an axis: never a miss where the brute force hits
  const rng = makeRng(31);
  let checked = 0;
  for (let nd = 0; nd < sc.meta.length / 2 && checked < 2000; nd += 7) {
    const b = 6 * nd;
    for (const ax of [0, 1, 2]) {
      const o = [0, 1, 2].map((k) => sc.box[b + k] + rng() * (sc.box[b + 3 + k] - sc.box[b + k]));
      o[ax] = sc.box[b + ax];
      const d = [0, 0, 0];
      d[(ax + 1 + (rng() < 0.5 ? 0 : 1)) % 3] = rng() < 0.5 ? 1 : -1;
      const a = closestHit(sc, o, d), r = bf(o, d);
      assert.equal(a ? a.t : Infinity, r.t, `node ${nd} axis ${ax}`);
      checked++;
    }
  }
  assert.ok(checked > 500);
});

test('degenerate inputs build or fail with the depth message', () => {
  // all triangles coplanar
  const rng = makeRng(5), flat = [];
  for (let i = 0; i < 1000; i++) { const c = [rng(), rng()]; flat.push([[c[0], c[1], 0], [c[0] + 0.01, c[1], 0], [c[0], c[1] + 0.01, 0]]); }
  const b1 = buildBVH(soup(flat));
  assert.equal(b1.order.length, 1000);
  // 1000 copies of one triangle (no centroid extent: median splits)
  const same = Array.from({ length: 1000 }, () => [[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
  try {
    const b2 = buildBVH(soup(same));
    assert.equal(b2.order.length, 1000);
    assert.ok(b2.depth <= 200);
  } catch (err) {
    assert.match(err.message, /too degenerate to trace \(BVH depth > 200\)/);
  }
  // the depth guard itself
  assert.throws(() => buildBVH(soup(same), { leafSize: 1, bins: 12, maxDepth: 3 }), /The mesh is too degenerate to trace \(BVH depth > 200\)\./);
  assert.throws(() => buildBVH(new Float32Array(0)), RangeError);
  assert.throws(() => buildBVH(Float32Array.from([0, 0, 0, 1, 0, 0, NaN, 1, 0])), RangeError);
});

test('0 leaks in 10^7 casts inside the closed built-in tube (4 worker threads)', async () => {
  const { tri, triPort } = tubeMesh();
  // both end caps reflect (sticking 0), so every particle bounces until the cap of 10^5 bounces
  const sc = makeScene(tri, triPort, [{ role: 'inlet', stick: 0, inward: [0, 0, 1] }, { role: 'outlet', stick: 0, inward: [0, 0, -1] }]);
  await acquireThreads();
  let results;
  try {
    results = await Promise.all([0, 1, 2, 3].map((k) => new Promise((resolve, reject) => {
      const w = new NodeWorker();
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message)); };
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'loaded') w.postMessage({ type: 'batch', job: 1, seq: k, block: null, source: k % 2, n: 25, seed: 1000 + k, tally: false, paths: 0, sampler: 'cosine', maxBounces: 99999 });
        else if (m.type === 'result') { w.terminate(); resolve(m); }
        else if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); }
      };
      w.postMessage({ type: 'load', job: 1, kind: 'mesh', scene: sc });
    })));
  } finally {
    releaseThreads();
  }
  const casts = results.reduce((s, r) => s + r.casts, 0), leaks = results.reduce((s, r) => s + r.leaks, 0);
  assert.equal(casts, 1e7);
  assert.equal(leaks, 0);
  assert.equal(results.reduce((s, r) => s + r.stuck, 0), 100);
});
