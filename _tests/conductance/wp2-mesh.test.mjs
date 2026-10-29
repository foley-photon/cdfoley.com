// WP2: mesh Monte Carlo, wall pressure and axial profile (spec §2.12, §3.6.3, §3.6.5, §3.6.6; §7.3 acceptance 5).
// Meshes are built locally (as WP3's testgeom.js will: 64 segments, area-preserving radius) until WP3 lands;
// with WP3 present the same cases run on the real built-ins through MC_CASES (run-validation.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runMeshBatch, wallPressure, axialProfile, profileAxis, toSlotOrder, toPreparedOrder, makeScene, subsetScene,
} from '../../beta/conductance/js/engine/mesh-mc.js';
import { makeTracer } from '../../beta/conductance/js/engine/bvh.js';
import { gasState } from '../../beta/conductance/js/engine/gas.js';
import { createNodeRunner } from './node-worker.mjs';
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

const N2 = gasState('N2', 293.15), AIR = gasState('air', 293.15);
const areaR = (R, n) => R * Math.sqrt(2 * Math.PI / (n * Math.sin(2 * Math.PI / n)));
function soup(tris) {
  const tri = new Float32Array(9 * tris.length);
  tris.forEach((t, i) => { for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) tri[9 * i + 3 * v + k] = t[v][k]; });
  return tri;
}
function tubeMesh(R, L, { n = 64, areaPreserving = true, m = null } = {}) {
  const Rp = areaPreserving ? areaR(R, n) : R, segs = m || Math.max(1, Math.round(L / (2 * Math.PI * R / n)));
  const P = (k, z) => [Rp * Math.cos(2 * Math.PI * k / n), Rp * Math.sin(2 * Math.PI * k / n), z];
  const tris = [], port = [];
  for (let j = 0; j < segs; j++) {
    const z0 = L * j / segs, z1 = L * (j + 1) / segs;
    for (let k = 0; k < n; k++) { const a = P(k, z0), b = P(k + 1, z0), c = P(k + 1, z1), d = P(k, z1); tris.push([a, b, c], [a, c, d]); port.push(-1, -1); }
  }
  for (const [z, g] of [[0, 0], [L, 1]]) for (let k = 0; k < n; k++) { tris.push([[0, 0, z], P(k, z), P(k + 1, z)]); port.push(g); }
  return { tri: soup(tris), triPort: Int16Array.from(port) };
}
function boxMesh(a, b, L, g = 16) {
  // walls and end faces as g × g grids of two triangles per cell; end faces are ports 0 (z = 0) and 1 (z = L)
  const tris = [], port = [];
  const face = (O, U, V, p) => {
    for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
      const P = (s, t) => [0, 1, 2].map((k) => O[k] + U[k] * s / g + V[k] * t / g);
      const p00 = P(i, j), p10 = P(i + 1, j), p11 = P(i + 1, j + 1), p01 = P(i, j + 1);
      tris.push([p00, p10, p11], [p00, p11, p01]); port.push(p, p);
    }
  };
  const x0 = -a / 2, y0 = -b / 2;
  face([x0, y0, 0], [a, 0, 0], [0, 0, L], -1);
  face([x0, -y0, 0], [a, 0, 0], [0, 0, L], -1);
  face([x0, y0, 0], [0, b, 0], [0, 0, L], -1);
  face([-x0, y0, 0], [0, b, 0], [0, 0, L], -1);
  face([x0, y0, 0], [a, 0, 0], [0, b, 0], 0);
  face([x0, y0, L], [a, 0, 0], [0, b, 0], 1);
  return { tri: soup(tris), triPort: Int16Array.from(port) };
}
const twoPorts = (r0, r1, s1 = 1) => [{ name: 'Inlet', role: r0, stick: 1, inward: [0, 0, 1] }, { name: 'Outlet', role: r1, stick: s1, inward: [0, 0, -1] }];
const det = (seed, N, extra = {}) => ({ deterministic: true, fixedN: N, seed, batch: 20000, maxTime: Infinity, maxParticles: Infinity, tally: false, paths: 0, ...extra });

let mc = null;
test.before(async () => { await acquireThreads(); mc = createNodeRunner({ workers: 3 }); });
test.after(() => { mc.dispose(); releaseThreads(); });

test('runMeshBatch bookkeeping: casts = wall arrivals + absorbed + leaks; paths start on the inlet', () => {
  const { tri, triPort } = tubeMesh(0.02, 0.2);
  const sc = makeScene(tri, triPort, twoPorts('inlet', 'outlet'));
  assert.equal(sc.version, 1);
  assert.equal(sc.ports.length, 2);
  assert.ok(Math.abs(sc.ports[0].area / (Math.PI * 0.02 ** 2) - 1) < 1e-6, 'area-preserving inlet');
  const tally = new Uint32Array(sc.nTri);
  const r = runMeshBatch(sc, makeTracer(sc), { source: 0, n: 5000, seed: 3, tally, paths: 5 });
  assert.equal(r.source, 0);
  assert.equal(r.stuck, 0);
  assert.equal(r.n, 5000);
  const absorbed = r.absorbed[0] + r.absorbed[1];
  assert.equal(absorbed + r.leaks, r.n);
  const wallHits = tally.reduce((s, x) => s + x, 0);
  assert.equal(r.casts, wallHits + absorbed + r.leaks);
  for (let s = 0; s < sc.nTri; s++) if (sc.port[s] >= 0) assert.equal(tally[s], 0);
  assert.equal(r.paths.length, 5);
  for (const p of r.paths) {
    assert.ok(p instanceof Float32Array && p.length % 3 === 0 && p.length >= 6 && p.length <= 600);
    assert.ok(Math.abs(p[2]) < 1e-9);                         // starts on the inlet disc (z = 0)
    const zEnd = p[p.length - 1];
    assert.ok(Math.abs(zEnd) < 1e-6 || Math.abs(zEnd - 0.2) < 1e-6);
  }
  assert.deepEqual(runMeshBatch(sc, makeTracer(sc), { source: 0, n: 200, seed: 9 }).absorbed, runMeshBatch(sc, makeTracer(sc), { source: 0, n: 200, seed: 9 }).absorbed);
  assert.throws(() => runMeshBatch(sc, makeTracer(sc), { source: 5, n: 1, seed: 1 }), RangeError);
});

test('mesh tube Ø40 × 200 mm (L/R = 10) matches 0.1909424 within 3σ + 0.3 %', async () => {
  const { tri, triPort } = tubeMesh(0.02, 0.2);
  const sc = makeScene(tri, triPort, twoPorts('inlet', 'outlet'));
  const r = await mc.runMesh(sc, N2, det(20261028, 4e5));
  const C0 = sc.ports[0].area * N2.vbar / 4, a = r.C.value / C0, s = r.C.sigma / C0;
  assert.ok(Math.abs(a - 0.1909424) <= 3 * s + 0.003 * 0.1909424, `alpha ${a} ± ${s}`);
  assert.equal(r.leaks, 0);
  assert.equal(r.reciprocity.length, 1);
  assert.ok(Math.abs(r.reciprocity[0].z) <= 3);
});

test('mesh square duct 20 × 20 × 20 mm matches 0.53622 ± 0.00035 within 3σ + 0.1 %', async () => {
  const { tri, triPort } = boxMesh(0.02, 0.02, 0.02, 16);
  const sc = makeScene(tri, triPort, twoPorts('inlet', 'outlet'));
  const r = await mc.runMesh(sc, N2, det(20261029, 4e5));
  const C0 = sc.ports[0].area * N2.vbar / 4, a = r.C.value / C0, s = r.C.sigma / C0;
  assert.ok(Math.abs(a - 0.53622) <= 3 * Math.hypot(s, 0.00035) + 0.001 * 0.53622, `alpha ${a} ± ${s}`);
});

test('inscribed 16-gon tube L/R = 10 loses 3.51 % against the round tube (within 3σ + 0.5 %)', async () => {
  const R = 0.02;
  const { tri, triPort } = tubeMesh(R, 0.2, { n: 16, areaPreserving: false, m: 200 });
  const sc = makeScene(tri, triPort, twoPorts('inlet', 'outlet'));
  const r = await mc.runMesh(sc, N2, det(20261030, 1e6));
  const Cround = 0.1909424 * Math.PI * R * R * N2.vbar / 4;
  const v = (r.C.value / Cround - 1) * 100, s = r.C.sigma / Cround * 100;
  assert.ok(Math.abs(v - -3.51) <= 3 * s + 0.5, `faceting error ${v} % ± ${s}`);
});

test('wall pressure along a tube L/R = 20 follows Clausing q(z) within 0.006 + 3σ', async () => {
  const L = 0.4;
  const { tri, triPort } = tubeMesh(0.02, L, { m: 200 });
  const sc = makeScene(tri, triPort, twoPorts('inlet', 'outlet'));
  const r = await mc.runMesh(sc, N2, det(20261031, 4e5, { tally: true }));
  assert.ok(r.hits instanceof Uint32Array && r.hits.length === sc.nTri);
  assert.equal(r.inletLaunches.length, 1);
  assert.equal(r.inletLaunches[0].port, 0);
  assert.equal(r.inletLaunches[0].n, r.perSource.find((p) => p.port === 0).n);
  const bySlot = toSlotOrder(sc, r.hits);
  const prof = axialProfile(sc, bySlot, r.inletLaunches, { bins: 20 });
  assert.equal(prof.value.length, 20);
  assert.ok(Math.abs(prof.axis.length / L - 1) < 1e-6);   // centroids come from Float32 vertices
  const z = [0.025, 0.125, 0.275, 0.525, 0.775, 0.975], q = [0.9273, 0.832, 0.6973, 0.4782, 0.2583, 0.0727];
  z.forEach((zl, k) => {
    const bin = Math.floor(zl * 20);
    assert.ok(Math.abs(prof.s[bin] / L - zl) < 1e-6);
    const v = prof.value[bin], sig = v / Math.sqrt(prof.hits[bin]);
    assert.ok(Math.abs(v - q[k]) <= 0.006 + 3 * sig, `z/L ${zl}: ${v} vs ${q[k]}`);
    assert.ok(prof.lo[bin] < v && prof.hi[bin] > v);
  });
  // per-triangle wall pressure averages to the same profile; ports are NaN
  const p = wallPressure(sc, bySlot, r.inletLaunches);
  let nanPorts = 0;
  for (let s = 0; s < sc.nTri; s++) if (sc.port[s] >= 0) { assert.ok(Number.isNaN(p[s])); nanPorts++; }
  assert.equal(nanPorts, 128);
  // region averaging over all walls gives one value: Σh/(ΣA·norm)
  const reg = new Int32Array(sc.nTri).fill(0);
  const pr = wallPressure(sc, bySlot, r.inletLaunches, { regionsBySlot: reg });
  let H = 0, A = 0;
  for (let s = 0; s < sc.nTri; s++) if (sc.port[s] < 0) { H += bySlot[s]; A += sc.area[s]; }
  const norm = r.inletLaunches[0].n / sc.ports[0].area;
  const wall = [...Array(sc.nTri).keys()].find((s) => sc.port[s] < 0);
  assert.ok(Math.abs(pr[wall] / (H / (A * norm)) - 1) < 1e-12);
});

test('pump port on a tube Ø100 × 200 mm (air, 300 L/s): S_eff = 188.0 ± 0.3 L/s within 3σ + 0.4 %', async () => {
  const { tri, triPort } = tubeMesh(0.05, 0.2);
  const A = Math.PI * 0.05 ** 2, stick = 0.3 / (A * AIR.vbar / 4);
  const sc = makeScene(tri, triPort, [{ name: 'Inlet', role: 'inlet', stick: 1, inward: [0, 0, 1] }, { name: 'Pump', role: 'pump', stick, inward: [0, 0, -1] }]);
  const r = await mc.runMesh(sc, AIR, det(20261032, 3e5));
  assert.equal(r.C, null);
  assert.equal(r.perSource.length, 1);                   // pump ports never launch
  const S = r.Seff.value * 1000, s = r.Seff.sigma * 1000;
  assert.ok(Math.abs(S - 188.0) <= 3 * Math.hypot(s, 0.3) + 0.004 * 188, `S_eff ${S} ± ${s}`);
  assert.equal(r.reciprocity.length, 0);
});

test('a leaky mesh stops the run with the leak message', async () => {
  const { tri, triPort } = tubeMesh(0.02, 0.2);
  const sc = makeScene(tri, triPort, twoPorts('inlet', 'outlet'));
  const keep = new Uint8Array(sc.nTri);
  let w = 0;
  for (let s = 0; s < sc.nTri; s++) { keep[s] = 1; if (sc.port[s] < 0 && w++ % 100 === 50) keep[s] = 0; }
  const leaky = subsetScene(sc, keep);
  assert.equal(leaky.nTri, sc.nTri - Math.ceil((sc.nTri - 128 - 50) / 100));
  await assert.rejects(mc.runMesh(leaky, N2, det(5, 2e5)), (err) => {
    assert.equal(err.code, 'leaks');
    assert.match(err.message, /^Particles are escaping through a gap in the mesh \([0-9.e+]+ per million rays\)\. Check the open edges listed in the mesh report\.$/);
    assert.ok(err.partial && err.partial.leaksPerMillion > 100 && err.partial.casts >= 1e5);
    return true;
  });
  assert.equal(mc.busy, false);
});

test('scene helpers: slot/prepared order round trip, subset keeps triangle ids, default profile axis', () => {
  const { tri, triPort } = tubeMesh(0.02, 0.1, { n: 16 });
  const sc = makeScene(tri, triPort, twoPorts('inlet', 'outlet'));
  const prepared = Float64Array.from({ length: sc.nTri }, (_, i) => i * 1.5);
  const slots = toSlotOrder(sc, prepared);
  for (let s = 0; s < sc.nTri; s++) assert.equal(slots[s], sc.origTri[s] * 1.5);
  assert.deepEqual(toPreparedOrder(sc, slots), prepared);
  const keep = new Uint8Array(sc.nTri).fill(1);
  keep[0] = 0; keep[5] = 0;
  const sub = subsetScene(sc, keep);
  assert.equal(sub.nTri, sc.nTri - 2);
  const ids = new Set(sub.origTri);
  assert.ok(!ids.has(sc.origTri[0]) && !ids.has(sc.origTri[5]));
  const ax = profileAxis(sc);
  assert.deepEqual(ax.dir.map((x) => Math.round(x * 1e9) / 1e9 + 0), [0, 0, 1]);
  assert.ok(Math.abs(ax.length / 0.1 - 1) < 1e-6);
  const given = profileAxis(sc, { from: [0, 0, 0], to: [0, 0, 2] });
  assert.equal(given.length, 2);
  const noOutlet = { ...sc, ports: sc.ports.map((p) => ({ ...p, role: 'inlet' })) };
  const pa = profileAxis(noOutlet);
  assert.ok(Math.abs(Math.abs(pa.dir[2]) - 1) < 1e-6, 'principal axis of a tube is its axis');
});

// ---------------------------------------------------------------- the mesh validation cases on stand-in geometry
// Stand-ins for WP3's modules with the interface of §2.16 (makeBuiltin, prepareMesh, buildScene, parseSTL,
// writeBinarySTL), so that every mesh case of MC_CASES runs end to end before WP3 lands. The built-ins follow §7.4
// (64 segments, area-preserving radii, axial segments about as long as the circumferential ones) and include their
// end caps; each cap belongs to an opening loop. prepareMesh recognises the stand-in meshes (and, for the STL round
// trip of the elbow, finds the caps on the planes z = z_min and x = x_max).
const STAND_IN = new WeakMap();   // positions → { loopOf: Int16Array, loops: [{ id, inward }], ports: number[][][] }

function shapeOf(tris, loopOf, loops, ports) {
  const positions = soup(tris);
  STAND_IN.set(positions, { loopOf: Int16Array.from(loopOf), loops, ports });
  return positions;
}
function revolved(rings, n, { areaPreserving = true } = {}) {
  // rings: [{ r, z }] along the axis; caps are fans at both ends (loop 0 at the first ring, loop 1 at the last)
  const P = (r, z, k) => { const rp = areaPreserving ? areaR(r, n) : r; return [rp * Math.cos(2 * Math.PI * k / n), rp * Math.sin(2 * Math.PI * k / n), z]; };
  const tris = [], loopOf = [];
  for (let j = 0; j + 1 < rings.length; j++) {
    for (let k = 0; k < n; k++) {
      const a = P(rings[j].r, rings[j].z, k), b = P(rings[j].r, rings[j].z, k + 1), c = P(rings[j + 1].r, rings[j + 1].z, k + 1), d = P(rings[j + 1].r, rings[j + 1].z, k);
      tris.push([a, b, c], [a, c, d]); loopOf.push(-1, -1);
    }
  }
  const last = rings[rings.length - 1];
  for (let k = 0; k < n; k++) { tris.push([[0, 0, rings[0].z], P(rings[0].r, rings[0].z, k), P(rings[0].r, rings[0].z, k + 1)]); loopOf.push(0); }
  for (let k = 0; k < n; k++) { tris.push([[0, 0, last.z], P(last.r, last.z, k), P(last.r, last.z, k + 1)]); loopOf.push(1); }
  return { tris, loopOf };
}
function ringsOf(R1, R2, L, n) {
  const ds = 2 * Math.PI * Math.min(R1, R2) / n, m = Math.max(1, Math.round(Math.hypot(L, R2 - R1) / ds));
  return Array.from({ length: m + 1 }, (_, j) => ({ r: R1 + (R2 - R1) * j / m, z: L * j / m }));
}
function elbowMeshCapped(R = 0.02, A = 0.06, B = 0.06, n = 64) {
  const Rp = areaR(R, n), ds = 2 * Math.PI * R / n;
  const m0 = Math.max(1, Math.round(A / ds)), m1 = Math.max(1, Math.round(B / ds));
  const c = (k) => Math.cos(2 * Math.PI * k / n), s = (k) => Math.sin(2 * Math.PI * k / n);
  const leg0 = (k, j) => [Rp * c(k), Rp * s(k), (A - Rp * c(k)) * j / m0];
  const leg1 = (k, j) => { const x0 = Rp * c(k); return [x0 + (B - x0) * j / m1, Rp * s(k), A - Rp * c(k)]; };
  const tris = [], loopOf = [];
  for (const [g, m] of [[leg0, m0], [leg1, m1]]) {
    for (let j = 0; j < m; j++) for (let k = 0; k < n; k++) {
      const a = g(k, j), b = g(k + 1, j), cc = g(k + 1, j + 1), d = g(k, j + 1);
      tris.push([a, b, cc], [a, cc, d]); loopOf.push(-1, -1);
    }
  }
  for (let k = 0; k < n; k++) { tris.push([[0, 0, 0], leg0(k, 0), leg0(k + 1, 0)]); loopOf.push(0); }
  for (let k = 0; k < n; k++) { tris.push([[B, 0, A], leg1(k, m1), leg1(k + 1, m1)]); loopOf.push(1); }
  return { tris, loopOf };
}
function boxShape(a, b, L, g = 16) {
  const { tri, triPort } = boxMesh(a, b, L, g);
  const tris = [];
  for (let t = 0; t < triPort.length; t++) tris.push([0, 1, 2].map((v) => [tri[9 * t + 3 * v], tri[9 * t + 3 * v + 1], tri[9 * t + 3 * v + 2]]));
  return { tris, loopOf: Array.from(triPort) };
}
function annulusShape(ro, ri, L, n = 64) {
  const Ro = areaR(ro, n), Ri = areaR(ri, n), m = Math.max(1, Math.round(L / (2 * Math.PI * ri / n)));
  const P = (r, z, k) => [r * Math.cos(2 * Math.PI * k / n), r * Math.sin(2 * Math.PI * k / n), z];
  const tris = [], loopOf = [];
  for (let j = 0; j < m; j++) {
    const z0 = L * j / m, z1 = L * (j + 1) / m;
    for (let k = 0; k < n; k++) for (const r of [Ro, Ri]) {
      tris.push([P(r, z0, k), P(r, z0, k + 1), P(r, z1, k + 1)], [P(r, z0, k), P(r, z1, k + 1), P(r, z1, k)]); loopOf.push(-1, -1);
    }
  }
  for (const [z, loop] of [[0, 0], [L, 2]]) {
    for (let k = 0; k < n; k++) {
      tris.push([P(Ri, z, k), P(Ro, z, k), P(Ro, z, k + 1)], [P(Ri, z, k), P(Ro, z, k + 1), P(Ri, z, k + 1)]); loopOf.push(loop, loop);
    }
  }
  return { tris, loopOf };
}
const twoLoops = [{ id: 0, inward: [0, 0, 1] }, { id: 1, inward: [0, 0, -1] }];
const ends = [[[0]], [[1]]];
const BUILT = {
  tube: (p) => [revolved(ringsOf((p.d ?? 0.04) / 2, (p.d ?? 0.04) / 2, p.L ?? 0.2, 64), 64), twoLoops, ends, { alpha: 0.1909424, sigma: 0 }],
  tube16: () => [revolved(ringsOf(0.02, 0.02, 0.2, 16), 16, { areaPreserving: false }), twoLoops, ends, { alpha: 0.18425, sigma: 0 }],
  cone: () => [revolved(ringsOf(0.02, 0.02 + 0.04 * Math.tan(20 * Math.PI / 180), 0.04, 64), 64), twoLoops, ends, { alpha: 0.837679, sigma: 0.00037 }],
  coneConv: () => [revolved(ringsOf(0.02, 0.02 + 0.08 * Math.tan(-10 * Math.PI / 180), 0.08, 64), 64), twoLoops, ends, { alpha: 0.04941, sigma: 0.00015 }],
  pumpTube: () => [revolved(ringsOf(0.05, 0.05, 0.2, 64), 64), twoLoops, ends, { alpha: 188 / 908, sigma: 0.3 / 908 }],
  elbow: () => [elbowMeshCapped(), [{ id: 0, inward: [0, 0, 1] }, { id: 1, inward: [-1, 0, 0] }], ends, { alpha: 0.26524, sigma: 0.00021 }],
  annulus: () => [annulusShape(0.02, 0.01, 0.02), [{ id: 0, inward: [0, 0, 1] }, { id: 1, inward: [0, 0, 1] }, { id: 2, inward: [0, 0, -1] }, { id: 3, inward: [0, 0, -1] }],
    [[[0, 1]], [[2, 3]]], { alpha: 0.52877, sigma: 0.00035 }],
  rect: () => [boxShape(0.02, 0.02, 0.02), twoLoops, ends, { alpha: 0.53622, sigma: 0.00035 }],
};

const standInGeometry = {
  makeBuiltin(name, params = {}) {
    const [shape, loops, ports, reference] = BUILT[name](params);
    const positions = shapeOf(shape.tris, shape.loopOf, loops, ports);
    const roles = name === 'pumpTube' ? ['inlet', 'pump'] : ['inlet', 'outlet'];
    const suggestedPorts = ports.map((lp, k) => ({
      id: k, name: k ? 'Outlet' : 'Inlet', kind: 'loop', loops: lp, tris: null, role: roles[k], stick: roles[k] === 'pump' ? 0.5 : 1, speed: null,
    }));
    return { positions, suggestedPorts, reference };
  },
  prepareMesh(positions) {
    let info = STAND_IN.get(positions);
    if (!info) {
      // a parsed copy of the elbow: caps on z = z_min (inlet) and x = x_max (outlet)
      const n = positions.length / 9, loopOf = new Int16Array(n).fill(-1);
      let zmin = Infinity, xmax = -Infinity;
      for (let i = 0; i < positions.length; i += 3) { zmin = Math.min(zmin, positions[i + 2]); xmax = Math.max(xmax, positions[i]); }
      for (let t = 0; t < n; t++) {
        const on = (k, v) => [0, 1, 2].every((q) => Math.abs(positions[9 * t + 3 * q + k] - v) < 1e-9);
        if (on(2, zmin)) loopOf[t] = 0; else if (on(0, xmax)) loopOf[t] = 1;
      }
      info = { loopOf, loops: [{ id: 0, inward: [0, 0, 1] }, { id: 1, inward: [-1, 0, 0] }], ports: ends };
    }
    const autoPorts = info.ports.map((lp, k) => ({ id: k, name: 'Opening ' + (k + 1), kind: 'loop', loops: lp, tris: null, role: k ? 'outlet' : 'inlet', stick: 1, speed: null }));
    return { mesh: { positions, ...info }, report: { loops: info.loops.map((l) => ({ id: l.id })) }, autoPorts };
  },
  buildScene(mesh, ports, G) {
    const P = mesh.positions, n = P.length / 9, triPort = new Int16Array(n).fill(-1), specs = [];
    for (const p of ports) {
      if (p.role === 'closed') continue;
      const ids = new Set(p.loops.flat()), k = specs.length;
      let area = 0;
      for (let t = 0; t < n; t++) {
        if (!ids.has(mesh.loopOf[t])) continue;
        triPort[t] = k;
        const o = 9 * t;
        const e1 = [P[o + 3] - P[o], P[o + 4] - P[o + 1], P[o + 5] - P[o + 2]], e2 = [P[o + 6] - P[o], P[o + 7] - P[o + 1], P[o + 8] - P[o + 2]];
        area += Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
      }
      const stick = p.role === 'pump' && p.speed != null ? p.speed / (area * G.vbar / 4) : (p.stick ?? 1);
      if (stick > 1) throw new RangeError('The pumping speed is above the molecular-flow maximum of the opening.');
      specs.push({ id: p.id, name: p.name, role: p.role, stick, inward: mesh.loops.find((l) => l.id === p.loops[0][0]).inward });
    }
    return { scene: makeScene(P, triPort, specs), capPositions: new Float32Array(0), triPort };
  },
  writeBinarySTL(positions) {
    const n = positions.length / 9, buf = new ArrayBuffer(84 + 50 * n), dv = new DataView(buf);
    dv.setUint32(80, n, true);
    for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) dv.setFloat32(84 + 50 * t + 12 + 4 * k, positions[9 * t + k], true);
    return buf;
  },
  parseSTL(buf) {
    const dv = new DataView(buf), n = dv.getUint32(80, true), positions = new Float32Array(9 * n);
    for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) positions[9 * t + k] = dv.getFloat32(84 + 50 * t + 12 + 4 * k, true);
    return { positions, nTri: n, format: 'stl-binary', warnings: [] };
  },
};

test('every mesh case of MC_CASES, and the leaky-mesh control, runs end to end on stand-in geometry (reduced N)', async () => {
  const { MC_CASES } = await import('../../beta/conductance/js/engine/validation-mc.js');
  const { evaluate } = await import('../../beta/conductance/js/engine/validation.js');
  const cases = MC_CASES.filter((c) => c.group === 'mesh-mc' || c.id === 'neg-leaky-mesh');
  assert.equal(cases.length, 12);
  for (const c of cases) {
    const n = c.id === 'neg-leaky-mesh' ? undefined : c.id === 'mesh-faceting16' ? 4e5 : 1.5e5;
    let outcome;
    try { outcome = await c.run({ mc, geometry: standInGeometry, n }); } catch (err) { outcome = { error: err.message }; }
    const row = evaluate(c, outcome);
    if (c.group === 'negative') assert.equal(row.caught, true, `${row.id} not caught: ${row.devText}`);
    else assert.equal(row.pass, true, `${row.id}: ${row.value} vs ${row.ref} (${row.devText}, ${row.tolText})`);
  }
  assert.equal(mc.busy, false);
});
