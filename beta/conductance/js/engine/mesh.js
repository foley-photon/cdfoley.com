// Mesh preparation (spec §2.16, §3.6.4): welding, topology, the validation report, boundary loops (the openings),
// coplanar regions and the automatic grouping of loops into ports.
//
//   weldMesh       hash the vertices on a grid of cell size weldTol (default 1e-6 × the bounding-box diagonal),
//                  merge vertices within the tolerance (27 neighbouring cells), drop degenerate triangles (area
//                  < 1e-12·diag², or two equal indices) and exact duplicates (the same three indices in any order).
//   validateMesh   edge map from sorted vertex pairs; boundary (1 triangle), manifold (2) and non-manifold (> 2)
//                  edges; consistent winding; boundary loops chained vertex to vertex (Newell's method for the
//                  plane, maxDev for planarity); signed volume Σ v0·(v1 × v2)/6 after capping each loop; faceting
//                  check of circular loops against the FACETING table; messages and a severity.
//   regionFrom     flood fill across manifold edges from a seed triangle within angleDeg of its plane.
//   prepareMesh    weld + validate + automatic ports.
//
// A Mesh is { vertices: Float64Array (xyz per vertex, metres), tris: Uint32Array (3 per triangle) }; meshes made
// here also carry weldTol. Triangle order is kept ("prepared order"): the triangles that survive the clean-up keep
// their input order, and vertices are numbered in order of first use. Loop ids follow the triangle order, so the
// same triangles in the same order always give the same loops, whatever the vertex numbering.
// Pure module: no DOM; runs in the page, in workers and in Node (H7, H8). SI units (metres).
import { FACETING } from './tables.js';

const COS_HALF_DEG = Math.cos(0.5 * Math.PI / 180);
const TOPO = new WeakMap();    // mesh → topology
const LOOPS = new WeakMap();   // mesh → raw boundary loops and open chains
const PROPS = new WeakMap();   // mesh → Map(weldTol → loop properties)

function fail(message) { throw new RangeError(message); }
const defaultFmtLen = (m) => (m * 1000).toPrecision(4) + ' mm';
const MINUS = '−';

function pow2(n) { let s = 16; while (s < n) s *= 2; return s; }

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
function hashNum(h, x) {
  F64[0] = x + 0;                          // −0 and +0 hash alike
  h = Math.imul(h ^ U32[0], 0x9e3779b1);
  h = Math.imul(h ^ U32[1], 0x85ebca6b);
  return h ^ (h >>> 15);
}

// half-edge h = 3t + k runs from tris[h] to tris[next(h)]
const nextHe = (h) => (h % 3 === 2 ? h - 2 : h + 1);
const heEnd = (tris, h) => tris[nextHe(h)];

// ---------------------------------------------------------------- weld

/**
 * Welds a triangle soup (positions in metres, 9 numbers per triangle).
 * Returns { mesh: { vertices, tris, weldTol }, merged, degenerate, duplicate, weldTol }:
 *   merged      distinct input positions that were merged into another one (closer than weldTol);
 *   degenerate  triangles dropped for two equal vertices or an area below 1e-12·diag²;
 *   duplicate   triangles dropped because they repeat the three vertices of an earlier one (any order).
 * weldTol null or undefined means 1e-6 × the bounding-box diagonal; 0 merges only identical positions.
 */
export function weldMesh(positions, weldTol = null) {
  const P = positions;
  if (!P || typeof P.length !== 'number') fail('The mesh positions must be an array of numbers.');
  const n9 = P.length;
  if (n9 === 0) fail('The mesh has no triangles.');
  if (n9 % 9 !== 0) fail('The triangle list has ' + n9 + ' numbers, which is not a multiple of 9.');
  const nIn = n9 / 9, nInst = 3 * nIn;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n9; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) fail('Vertex ' + (i / 3 + 1) + ' is not a finite number.');
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const diag = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  if (!(diag > 0)) fail('The mesh has no extent: all its vertices coincide.');
  let tol;
  if (weldTol === null || weldTol === undefined) tol = 1e-6 * diag;
  else {
    tol = Number(weldTol);
    if (!(Number.isFinite(tol) && tol >= 0)) fail('The merge tolerance must be zero or a positive length.');
  }

  // pass 1: identical positions → unique ids
  const size1 = pow2(2 * nInst), mask1 = size1 - 1;
  const head1 = new Int32Array(size1).fill(-1), next1 = new Int32Array(nInst);
  const UX = new Float64Array(3 * nInst), uid = new Int32Array(nInst);
  let U = 0;
  for (let i = 0; i < nInst; i++) {
    const x = P[3 * i] + 0, y = P[3 * i + 1] + 0, z = P[3 * i + 2] + 0;
    const h = hashNum(hashNum(hashNum(0x2545f491, x), y), z) & mask1;
    let u = head1[h];
    while (u >= 0 && !(UX[3 * u] === x && UX[3 * u + 1] === y && UX[3 * u + 2] === z)) u = next1[u];
    if (u < 0) {
      u = U++;
      UX[3 * u] = x; UX[3 * u + 1] = y; UX[3 * u + 2] = z;
      next1[u] = head1[h]; head1[h] = u;
    }
    uid[i] = u;
  }

  // pass 2: positions within the tolerance → welded vertices (the first position seen represents the group)
  const wid = new Int32Array(U);
  let WX, V = 0;
  if (tol > 0) {
    WX = new Float64Array(3 * U);
    const inv = 1 / tol, tol2 = tol * tol;
    const size2 = pow2(2 * U), mask2 = size2 - 1;
    const head2 = new Int32Array(size2).fill(-1), next2 = new Int32Array(U);
    const cell = (ix, iy, iz) => (Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663) ^ Math.imul(iz | 0, 83492791)) & mask2;
    for (let u = 0; u < U; u++) {
      const x = UX[3 * u], y = UX[3 * u + 1], z = UX[3 * u + 2];
      const ix = Math.floor((x - x0) * inv), iy = Math.floor((y - y0) * inv), iz = Math.floor((z - z0) * inv);
      let best = -1, bestD = Infinity;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            for (let w = head2[cell(ix + dx, iy + dy, iz + dz)]; w >= 0; w = next2[w]) {
              const ex = WX[3 * w] - x, ey = WX[3 * w + 1] - y, ez = WX[3 * w + 2] - z;
              const d2 = ex * ex + ey * ey + ez * ez;
              if (d2 <= tol2 && d2 < bestD) { bestD = d2; best = w; }
            }
          }
        }
      }
      if (best < 0) {
        best = V++;
        WX[3 * best] = x; WX[3 * best + 1] = y; WX[3 * best + 2] = z;
        const h = cell(ix, iy, iz);
        next2[best] = head2[h]; head2[h] = best;
      }
      wid[u] = best;
    }
  } else {
    WX = UX;
    V = U;
    for (let u = 0; u < U; u++) wid[u] = u;
  }

  // triangles: drop degenerate ones and duplicates, keep the order of the rest
  const areaMin2 = (1e-12 * diag * diag) ** 2 * 4;        // |cross|² threshold (|cross| = 2·area)
  const size3 = pow2(2 * nIn), mask3 = size3 - 1;
  const head3 = new Int32Array(size3).fill(-1), next3 = new Int32Array(nIn);
  const keyS = new Uint32Array(3 * nIn), keep = new Uint32Array(3 * nIn);
  let nT = 0, degenerate = 0, duplicate = 0;
  for (let t = 0; t < nIn; t++) {
    const a = wid[uid[3 * t]], b = wid[uid[3 * t + 1]], c = wid[uid[3 * t + 2]];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    const ux = WX[3 * b] - WX[3 * a], uy = WX[3 * b + 1] - WX[3 * a + 1], uz = WX[3 * b + 2] - WX[3 * a + 2];
    const vx = WX[3 * c] - WX[3 * a], vy = WX[3 * c + 1] - WX[3 * a + 1], vz = WX[3 * c + 2] - WX[3 * a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (!(cx * cx + cy * cy + cz * cz >= areaMin2)) { degenerate++; continue; }
    let s0 = a, s1 = b, s2 = c, tmp;
    if (s0 > s1) { tmp = s0; s0 = s1; s1 = tmp; }
    if (s1 > s2) { tmp = s1; s1 = s2; s2 = tmp; }
    if (s0 > s1) { tmp = s0; s0 = s1; s1 = tmp; }
    const h = (Math.imul(s0, 0x9e3779b1) ^ Math.imul(s1, 0x85ebca6b) ^ Math.imul(s2, 0xc2b2ae35)) & mask3;
    let q = head3[h];
    while (q >= 0 && !(keyS[3 * q] === s0 && keyS[3 * q + 1] === s1 && keyS[3 * q + 2] === s2)) q = next3[q];
    if (q >= 0) { duplicate++; continue; }
    keyS[3 * nT] = s0; keyS[3 * nT + 1] = s1; keyS[3 * nT + 2] = s2;
    next3[nT] = head3[h]; head3[h] = nT;
    keep[3 * nT] = a; keep[3 * nT + 1] = b; keep[3 * nT + 2] = c;
    nT++;
  }
  if (!nT) fail('No triangles are left after removing degenerate and duplicate ones.');
  // vertices numbered in order of first use
  const remap = new Int32Array(V).fill(-1);
  const tris = new Uint32Array(3 * nT);
  let nV = 0;
  for (let k = 0; k < 3 * nT; k++) {
    const w = keep[k];
    let r = remap[w];
    if (r < 0) r = remap[w] = nV++;
    tris[k] = r;
  }
  const vertices = new Float64Array(3 * nV);
  for (let w = 0; w < V; w++) {
    const r = remap[w];
    if (r >= 0) { vertices[3 * r] = WX[3 * w]; vertices[3 * r + 1] = WX[3 * w + 1]; vertices[3 * r + 2] = WX[3 * w + 2]; }
  }
  return { mesh: { vertices, tris, weldTol: tol }, merged: U - V, degenerate, duplicate, weldTol: tol };
}

// ---------------------------------------------------------------- topology

function checkMesh(mesh) {
  if (!mesh || !mesh.vertices || !mesh.tris || typeof mesh.tris.length !== 'number' || mesh.tris.length % 3 !== 0) {
    fail('The mesh is incomplete (it needs vertices and triangles).');
  }
}

/**
 * Edge map of a mesh (cached per mesh object). Half-edge h = 3t + k runs from tris[h] to the next corner of t.
 * Returns { nT, nV, nE, heEdge (half-edge → edge), eLo, eHi, eCount (half-edges per edge), eStart, eHe (CSR list
 * of each edge's half-edges, in increasing order) }.
 */
export function meshTopology(mesh) {
  checkMesh(mesh);
  let T = TOPO.get(mesh);
  if (T) return T;
  const tris = mesh.tris, nT = tris.length / 3, nV = mesh.vertices.length / 3, nH = 3 * nT;
  for (let h = 0; h < nH; h++) if (!(tris[h] < nV)) fail('Triangle ' + (Math.floor(h / 3) + 1) + ' refers to a vertex that does not exist.');
  const start = new Int32Array(nV + 1);
  for (let h = 0; h < nH; h++) { const a = tris[h], b = heEnd(tris, h); start[(a < b ? a : b) + 1]++; }
  for (let v = 0; v < nV; v++) start[v + 1] += start[v];
  const cur = start.slice(0, nV);
  const bucket = new Int32Array(nH);
  for (let h = 0; h < nH; h++) { const a = tris[h], b = heEnd(tris, h); bucket[cur[a < b ? a : b]++] = h; }
  const heEdge = new Int32Array(nH);
  const eLo = new Int32Array(nH), eHi = new Int32Array(nH), eCount = new Int32Array(nH);
  let nE = 0;
  for (let v = 0; v < nV; v++) {
    const s = start[v], e = start[v + 1], m = e - s;
    if (!m) continue;
    const first = nE;
    if (m <= 24) {
      for (let j = s; j < e; j++) {
        const h = bucket[j], a = tris[h], b = heEnd(tris, h), hi = a === v ? b : a;
        let f = -1;
        for (let q = first; q < nE; q++) if (eHi[q] === hi) { f = q; break; }
        if (f < 0) { f = nE++; eLo[f] = v; eHi[f] = hi; }
        eCount[f]++;
        heEdge[h] = f;
      }
    } else {
      const keys = new Float64Array(m);
      for (let j = 0; j < m; j++) {
        const h = bucket[s + j], a = tris[h], b = heEnd(tris, h), hi = a === v ? b : a;
        keys[j] = hi * nH + h;
      }
      keys.sort();
      let prevHi = -1, f = -1;
      for (let j = 0; j < m; j++) {
        const hi = Math.floor(keys[j] / nH), h = keys[j] - hi * nH;
        if (hi !== prevHi) { f = nE++; eLo[f] = v; eHi[f] = hi; prevHi = hi; }
        eCount[f]++;
        heEdge[h] = f;
      }
    }
  }
  const eStart = new Int32Array(nE + 1);
  for (let h = 0; h < nH; h++) eStart[heEdge[h] + 1]++;
  for (let e = 0; e < nE; e++) eStart[e + 1] += eStart[e];
  const fillE = eStart.slice(0, nE);
  const eHe = new Int32Array(nH);
  for (let h = 0; h < nH; h++) eHe[fillE[heEdge[h]]++] = h;
  T = { nT, nV, nE, heEdge, eLo: eLo.slice(0, nE), eHi: eHi.slice(0, nE), eCount: eCount.slice(0, nE), eStart, eHe };
  TOPO.set(mesh, T);
  return T;
}

// The boundary half-edge that leaves the end vertex of boundary half-edge hIn, found by walking around that vertex
// through the triangles of hIn's fan (so loops that touch at one vertex stay separate). −1 when the walk meets a
// non-manifold edge or inconsistent winding.
function fanNext(T, tris, hIn) {
  const v = heEnd(tris, hIn), h0 = nextHe(hIn);
  let h = h0;
  for (let guard = 0; guard < T.eHe.length; guard++) {
    const e = T.heEdge[h], c = T.eCount[e];
    if (c === 1) return h;
    if (c !== 2) return -1;
    const s = T.eStart[e];
    const h2 = T.eHe[s] === h ? T.eHe[s + 1] : T.eHe[s];
    if (tris[h2] === v) return -1;
    h = nextHe(h2);
    if (h === h0) return -1;
  }
  return -1;
}

/**
 * Boundary loops and open chains of a mesh (cached per mesh object). Loops are found in triangle order: the first
 * boundary half-edge of the lowest-numbered triangle starts loop 0, and each loop follows its boundary half-edges.
 * Returns { loops: [{ vertices: Uint32Array, halfEdges: Int32Array }], openChains: [{ edges }] }.
 */
export function boundaryLoops(mesh) {
  let L = LOOPS.get(mesh);
  if (L) return L;
  const T = meshTopology(mesh), tris = mesh.tris, nH = 3 * T.nT;
  const isB = (h) => T.eCount[T.heEdge[h]] === 1;
  const cnt = new Int32Array(T.nV + 1);
  let nB = 0;
  for (let h = 0; h < nH; h++) if (isB(h)) { cnt[tris[h] + 1]++; cnt[heEnd(tris, h) + 1]++; nB++; }
  for (let v = 0; v < T.nV; v++) cnt[v + 1] += cnt[v];
  const fill = cnt.slice(0, T.nV), inc = new Int32Array(2 * nB);
  for (let h = 0; h < nH; h++) if (isB(h)) { inc[fill[tris[h]]++] = h; inc[fill[heEnd(tris, h)]++] = h; }
  const used = new Uint8Array(nH);
  const loops = [], openChains = [];
  for (let h0 = 0; h0 < nH; h0++) {
    if (used[h0] || !isB(h0)) continue;
    used[h0] = 1;
    const a = tris[h0];
    const vs = [a], hs = [h0];
    let cur = heEnd(tris, h0), last = h0, fwdLast = true, closed = false;
    for (let guard = 0; guard <= nB; guard++) {
      if (cur === a) { closed = true; break; }
      vs.push(cur);
      let nx = fwdLast ? fanNext(T, tris, last) : -1, fwd = true;
      if (nx >= 0 && (used[nx] || tris[nx] !== cur)) nx = -1;
      if (nx < 0) {
        for (let j = cnt[cur]; j < cnt[cur + 1]; j++) { const q = inc[j]; if (!used[q] && tris[q] === cur) { nx = q; break; } }
        if (nx < 0) {
          for (let j = cnt[cur]; j < cnt[cur + 1]; j++) { const q = inc[j]; if (!used[q]) { nx = q; fwd = false; break; } }
        }
      }
      if (nx < 0) break;
      used[nx] = 1;
      hs.push(nx);
      cur = fwd ? heEnd(tris, nx) : tris[nx];
      last = nx;
      fwdLast = fwd;
    }
    if (closed) {
      loops.push({ vertices: Uint32Array.from(vs), halfEdges: Int32Array.from(hs) });
    } else {
      // extend the open chain backwards from its start, so it is counted once
      let edges = hs.length, back = a;
      for (let guard = 0; guard <= nB; guard++) {
        let nx = -1;
        for (let j = cnt[back]; j < cnt[back + 1]; j++) { const q = inc[j]; if (!used[q]) { nx = q; break; } }
        if (nx < 0) break;
        used[nx] = 1;
        edges++;
        back = tris[nx] === back ? heEnd(tris, nx) : tris[nx];
      }
      openChains.push({ edges });
    }
  }
  L = { loops, openChains };
  LOOPS.set(mesh, L);
  return L;
}

// ---------------------------------------------------------------- loop geometry

// Geometry of one closed loop: Newell normal, area, centroid (vertex mean), planarity, circularity.
function loopGeometry(V, vs, weldTol) {
  const n = vs.length;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { const v = 3 * vs[i]; cx += V[v]; cy += V[v + 1]; cz += V[v + 2]; }
  cx /= n; cy /= n; cz /= n;
  let Nx = 0, Ny = 0, Nz = 0, perimeter = 0, rMax = 0, rSum = 0, rSum2 = 0;
  for (let i = 0; i < n; i++) {
    const p = 3 * vs[i], q = 3 * vs[(i + 1) % n];
    const ax = V[p] - cx, ay = V[p + 1] - cy, az = V[p + 2] - cz;
    const bx = V[q] - cx, by = V[q + 1] - cy, bz = V[q + 2] - cz;
    Nx += (ay - by) * (az + bz);
    Ny += (az - bz) * (ax + bx);
    Nz += (ax - bx) * (ay + by);
    perimeter += Math.hypot(bx - ax, by - ay, bz - az);
    const r = Math.hypot(ax, ay, az);
    rSum += r; rSum2 += r * r;
    if (r > rMax) rMax = r;
  }
  const nl = Math.hypot(Nx, Ny, Nz), area = nl / 2;
  const normal = nl > 0 ? [Nx / nl, Ny / nl, Nz / nl] : [0, 0, 0];
  let maxDev = 0;
  if (nl > 0) {
    for (let i = 0; i < n; i++) {
      const p = 3 * vs[i];
      const d = Math.abs((V[p] - cx) * normal[0] + (V[p + 1] - cy) * normal[1] + (V[p + 2] - cz) * normal[2]);
      if (d > maxDev) maxDev = d;
    }
  }
  const diameter = 2 * rMax;
  const tolPlane = Math.max(1e-3 * diameter, 10 * weldTol);
  const sliver = !(area > 1e-6 * perimeter * perimeter);
  const planar = !sliver && n >= 3 && maxDev <= tolPlane;
  const mean = rSum / n, sd = Math.sqrt(Math.max(rSum2 / n - mean * mean, 0));
  const circular = n >= 8 && mean > 0 && sd <= 0.01 * mean;
  return { normal, area, centroid: [cx, cy, cz], maxDev, perimeter, planar, sliver, circular, diameter, tolPlane };
}

/**
 * Properties of every boundary loop for a weld tolerance (cached): [{ id, vertices, planar, maxDev, area,
 * perimeter, centroid, normal, sides, circular, sliver, diameter, tolPlane }]. A sliver loop (area ≤ 1e-6 ×
 * perimeter², a T-junction or a crack) is never planar.
 */
export function loopProperties(mesh, weldTol = null) {
  const tol = Number.isFinite(weldTol) ? weldTol : (Number.isFinite(mesh.weldTol) ? mesh.weldTol : 1e-6 * meshDiag(mesh));
  let byTol = PROPS.get(mesh);
  if (!byTol) { byTol = new Map(); PROPS.set(mesh, byTol); }
  let out = byTol.get(tol);
  if (out) return out;
  const raw = boundaryLoops(mesh), V = mesh.vertices;
  out = raw.loops.map((lp, id) => {
    const g = loopGeometry(V, lp.vertices, tol);
    return {
      id, vertices: lp.vertices, planar: g.planar, maxDev: g.maxDev, area: g.area, perimeter: g.perimeter,
      centroid: g.centroid, normal: g.normal, sides: lp.vertices.length, circular: g.circular,
      sliver: g.sliver, diameter: g.diameter, tolPlane: g.tolPlane,
    };
  });
  byTol.set(tol, out);
  return out;
}

function meshBox(mesh) {
  const V = mesh.vertices;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < V.length; i += 3) {
    const x = V[i], y = V[i + 1], z = V[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return [x0, y0, z0, x1, y1, z1];
}

function meshDiag(mesh) {
  const b = meshBox(mesh);
  return Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
}

// 2D projection of a loop by dropping the dominant axis of a normal (exact for axis-aligned planes).
function dropAxis(normal) {
  const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2]);
  return az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
}

/** 2D coordinates (Float64Array x, y, …) of a loop's vertices projected along the dominant axis of `normal`. */
export function projectLoop(V, vs, normal) {
  const [i, j] = dropAxis(normal);
  const out = new Float64Array(2 * vs.length);
  for (let k = 0; k < vs.length; k++) { out[2 * k] = V[3 * vs[k] + i]; out[2 * k + 1] = V[3 * vs[k] + j]; }
  return out;
}

function pointInPolygon(px, py, poly) {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Groups coplanar loops into openings (§3.6.4 step 4): loops whose normals agree within 0.5° (either orientation)
 * and whose planes agree within the planar tolerance, one containing the other (point-in-polygon test of one
 * vertex in the projected plane). Loops at even nesting depth are outer loops; each gets the loops directly inside
 * it as holes. Only planar loops take part. Returns [{ loops: [outerId, ...holeIds], area, centroid, normal }],
 * largest area first (areas within 1e-6 count as equal; then by outer loop id).
 */
export function groupLoops(mesh, loops) {
  const V = mesh.vertices;
  const cand = loops.filter((l) => l.planar);
  const m = cand.length;
  const proj = cand.map((l) => projectLoop(V, l.vertices, l.normal));
  const vset = cand.map((l) => new Set(l.vertices));
  const tolOf = (l) => (Number.isFinite(l.tolPlane) ? l.tolPlane : 1e-3 * (l.perimeter / Math.PI));
  const contains = (i, j) => {                      // loop j lies inside loop i
    const A = cand[i], B = cand[j];
    if (!(A.area > B.area)) return false;
    const dot = A.normal[0] * B.normal[0] + A.normal[1] * B.normal[1] + A.normal[2] * B.normal[2];
    if (Math.abs(dot) < COS_HALF_DEG) return false;
    const off = Math.abs(A.normal[0] * (B.centroid[0] - A.centroid[0]) + A.normal[1] * (B.centroid[1] - A.centroid[1])
      + A.normal[2] * (B.centroid[2] - A.centroid[2]));
    if (off > Math.max(tolOf(A), tolOf(B))) return false;
    const [a0, a1] = dropAxis(A.normal);
    for (let k = 0; k < B.vertices.length; k++) {
      const v = B.vertices[k];
      if (vset[i].has(v)) continue;
      return pointInPolygon(V[3 * v + a0], V[3 * v + a1], proj[i]);
    }
    return false;
  };
  const depth = new Int32Array(m), parent = new Int32Array(m).fill(-1);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      if (i === j || !contains(i, j)) continue;
      depth[j]++;
      if (parent[j] < 0 || cand[i].area < cand[parent[j]].area) parent[j] = i;
    }
  }
  const groups = [];
  for (let i = 0; i < m; i++) {
    if (depth[i] % 2) continue;
    const holes = [];
    for (let j = 0; j < m; j++) if (depth[j] % 2 === 1 && parent[j] === i) holes.push(j);
    const area = cand[i].area - holes.reduce((s, j) => s + cand[j].area, 0);
    groups.push({ loops: [cand[i].id, ...holes.map((j) => cand[j].id)], area, centroid: cand[i].centroid.slice(), normal: cand[i].normal.slice() });
  }
  const amax = groups.reduce((s, g) => Math.max(s, g.area), 0);
  groups.sort((g, h) => (Math.abs(g.area - h.area) <= 1e-6 * amax ? g.loops[0] - h.loops[0] : h.area - g.area));
  return groups;
}

/**
 * Default ports of a prepared mesh (§3.6.4 step 8): one loop port per opening (outer loop plus its holes); the
 * largest opening is the inlet and the others are outlets. A closed solid has none. (ports.autoPorts wraps this.)
 */
export function autoPortsOf(mesh, report) {
  const tol = report && Number.isFinite(report.weldTol) ? report.weldTol : null;
  const groups = groupLoops(mesh, loopProperties(mesh, tol));
  const n = groups.length;
  return groups.map((g, k) => ({
    id: k, name: k === 0 ? 'Inlet' : (n === 2 ? 'Outlet' : 'Outlet ' + k), kind: 'loop', loops: [g.loops], tris: null,
    role: k === 0 ? 'inlet' : 'outlet', stick: 1, speed: null,
  }));
}

// ---------------------------------------------------------------- validation report

function expectedFacetingPct(sides) {
  const ns = FACETING.n, es = FACETING['L/R=10'];
  const x = Math.log2(sides);
  if (x <= Math.log2(ns[0])) return es[0];
  if (x >= Math.log2(ns[ns.length - 1])) return es[es.length - 1];
  for (let i = 0; i + 1 < ns.length; i++) {
    const a = Math.log2(ns[i]), b = Math.log2(ns[i + 1]);
    if (x === b) return es[i + 1];
    if (x < b) return Number((es[i] + (es[i + 1] - es[i]) * (x - a) / (b - a)).toFixed(6));
  }
  return es[es.length - 1];
}

const fmtPct = (p) => (p < 0 ? MINUS : '') + Math.abs(p).toFixed(1) + ' %';
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

/**
 * Validation report of a welded mesh (§2.13 MeshReport, §3.6.4 steps 2–3 and 9). weldInfo is weldMesh's result
 * (or { merged, degenerate, duplicate, weldTol }); weldInfo.fmtLen optionally formats lengths in messages.
 */
export function validateMesh(mesh, weldInfo) {
  checkMesh(mesh);
  const info = weldInfo || {};
  const fmtLen = typeof info.fmtLen === 'function' ? info.fmtLen : defaultFmtLen;
  const V = mesh.vertices, tris = mesh.tris;
  const bbox = meshBox(mesh);
  const diag = Math.hypot(bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]);
  const weldTol = Number.isFinite(info.weldTol) ? info.weldTol : (Number.isFinite(mesh.weldTol) ? mesh.weldTol : 1e-6 * diag);
  const T = meshTopology(mesh);
  const nT = T.nT, nV = T.nV;

  let boundaryEdges = 0, nonManifoldEdges = 0, inconsistent = 0;
  for (let e = 0; e < T.nE; e++) {
    const c = T.eCount[e];
    if (c === 1) boundaryEdges++;
    else if (c > 2) nonManifoldEdges++;
    else if (c === 2) {
      const s = T.eStart[e];
      if (tris[T.eHe[s]] === tris[T.eHe[s + 1]]) inconsistent++;
    }
  }
  const windingConsistent = inconsistent === 0;

  // non-manifold vertices: corners (t, v) joined across the edges at v; more than one group = separate surfaces
  const parent = new Int32Array(3 * nT);
  for (let c = 0; c < parent.length; c++) parent[c] = c;
  const find = (c) => { while (parent[c] !== c) { parent[c] = parent[parent[c]]; c = parent[c]; } return c; };
  const cornerOf = (t, v) => (tris[3 * t] === v ? 3 * t : tris[3 * t + 1] === v ? 3 * t + 1 : 3 * t + 2);
  for (let e = 0; e < T.nE; e++) {
    const s = T.eStart[e], f = T.eStart[e + 1];
    if (f - s < 2) continue;
    const t0 = Math.floor(T.eHe[s] / 3);
    for (const v of [T.eLo[e], T.eHi[e]]) {
      const r0 = find(cornerOf(t0, v));
      for (let q = s + 1; q < f; q++) {
        const r = find(cornerOf(Math.floor(T.eHe[q] / 3), v));
        if (r !== r0) parent[r] = r0;
      }
    }
  }
  const firstRoot = new Int32Array(nV).fill(-1), nmv = new Uint8Array(nV);
  let nonManifoldVertices = 0;
  for (let c = 0; c < 3 * nT; c++) {
    const v = tris[c], r = find(c);
    if (firstRoot[v] < 0) firstRoot[v] = r;
    else if (firstRoot[v] !== r && !nmv[v]) { nmv[v] = 1; nonManifoldVertices++; }
  }

  const raw = boundaryLoops(mesh);
  const props = loopProperties(mesh, weldTol);
  const loops = props.map((l) => ({
    id: l.id, vertices: l.vertices, planar: l.planar, maxDev: l.maxDev, area: l.area, perimeter: l.perimeter,
    centroid: l.centroid, normal: l.normal, sides: l.sides, circular: l.circular,
  }));

  // signed volume after capping each loop with a fan from its centroid (reversed loop order = consistent caps)
  const px = (bbox[0] + bbox[3]) / 2, py = (bbox[1] + bbox[4]) / 2, pz = (bbox[2] + bbox[5]) / 2;
  const triple = (ax, ay, az, bx, by, bz, cx, cy, cz) => ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  let vol6 = 0;
  for (let t = 0; t < nT; t++) {
    const a = 3 * tris[3 * t], b = 3 * tris[3 * t + 1], c = 3 * tris[3 * t + 2];
    vol6 += triple(V[a] - px, V[a + 1] - py, V[a + 2] - pz, V[b] - px, V[b + 1] - py, V[b + 2] - pz, V[c] - px, V[c + 1] - py, V[c + 2] - pz);
  }
  for (const l of props) {
    const cx = l.centroid[0] - px, cy = l.centroid[1] - py, cz = l.centroid[2] - pz, vs = l.vertices, n = vs.length;
    for (let i = 0; i < n; i++) {
      const a = 3 * vs[i], b = 3 * vs[(i + 1) % n];
      vol6 += triple(cx, cy, cz, V[b] - px, V[b + 1] - py, V[b + 2] - pz, V[a] - px, V[a + 1] - py, V[a + 2] - pz);
    }
  }
  const signedVolume = vol6 / 6;

  // openings (for numbering in messages) and faceting
  const groups = groupLoops(mesh, props);
  const openingOf = new Map(), holeOf = new Map();
  groups.forEach((g, k) => { openingOf.set(g.loops[0], k + 1); g.loops.slice(1).forEach((id) => holeOf.set(id, k + 1)); });
  const loopName = (id) => (openingOf.has(id) ? 'Opening ' + openingOf.get(id)
    : holeOf.has(id) ? 'The inner edge of opening ' + holeOf.get(id) : 'Edge loop ' + (id + 1));
  const faceting = [];
  const messages = [];
  const add = (level, code, text) => messages.push({ level, code, text });

  // ---- errors
  if (raw.openChains.length) {
    raw.openChains.slice(0, 5).forEach((c) => add('error', 'open-chain', 'Open edge chain (' + plural(c.edges, 'edge', 'edges') + ') that does not form a loop.'));
    if (raw.openChains.length > 5) add('error', 'open-chain', (raw.openChains.length - 5) + ' more open edge chains.');
  }
  const nonPlanar = props.filter((l) => !l.planar && !l.sliver);
  nonPlanar.slice(0, 5).forEach((l) => add('error', 'nonplanar', loopName(l.id) + ' is not flat (its edge departs from a plane by '
    + fmtLen(l.maxDev) + '), so it cannot be closed as an opening. Export the openings as flat faces.'));
  if (nonPlanar.length > 5) add('error', 'nonplanar', (nonPlanar.length - 5) + ' more edge loops are not flat.');

  // ---- warnings
  const ext = Math.max(bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]);
  if (ext < 1e-4 || ext > 10) add('warn', 'size', 'The model is ' + fmtLen(ext) + ' across. That looks too small or too large; check the unit.');
  if (nonManifoldEdges) add('warn', 'nonmanifold-edges', plural(nonManifoldEdges, 'edge is', 'edges are') + ' shared by more than two triangles (non-manifold). If these are internal or doubled faces, results may be wrong; check the mesh.');
  if (nonManifoldVertices) add('warn', 'nonmanifold-vertices', plural(nonManifoldVertices, 'vertex joins', 'vertices join') + ' surfaces that touch at a single point (non-manifold "bow-tie" vertices).');
  const slivers = props.filter((l) => l.sliver);
  if (slivers.length) add('warn', 't-junction', plural(slivers.length, 'edge loop encloses', 'edge loops enclose') + ' no area: vertices lie on the edges of neighbouring triangles (T-junctions) or the surface has a crack. Particles may leak there; export a watertight mesh.');
  if (!windingConsistent) add('warn', 'winding', plural(inconsistent, 'edge has', 'edges have') + ' triangles wound in opposite directions, so the inside of each opening is found by casting rays.');
  for (const l of props) {
    if (!l.circular) continue;
    const pct = expectedFacetingPct(l.sides);
    faceting.push({ loopId: l.id, sides: l.sides, expectedErrorPct: pct });
    if (l.sides < 64 && (openingOf.has(l.id) || holeOf.has(l.id))) {
      add('warn', 'faceting', loopName(l.id) + ' is a ' + l.sides + '-sided polygon, so expect about ' + fmtPct(pct)
        + ' conductance from faceting. Export with at least 64 segments per circle (about 0.1 rad angular deviation).');
    }
  }
  const big = props.filter((l) => l.sides > 20000).length;
  if (big) add('warn', 'large-loop', plural(big, 'edge loop has', 'edge loops have') + ' more than 20 000 vertices; closing them may take a few seconds.');
  if (info.degenerate) add('warn', 'degenerate', 'Removed ' + plural(info.degenerate, 'degenerate (zero-area) triangle', 'degenerate (zero-area) triangles') + '.');
  if (info.duplicate) add('warn', 'duplicate', 'Removed ' + plural(info.duplicate, 'duplicate triangle', 'duplicate triangles') + '.');

  // ---- ok
  if (info.merged) add('ok', 'merged', 'Merged ' + plural(info.merged, 'vertex', 'vertices') + ' closer than the merge tolerance (' + fmtLen(weldTol) + ').');
  if (!boundaryEdges && !nonManifoldEdges) add('ok', 'closed', 'The mesh is closed, so it has no openings: use Select region to choose the inlet and the outlet.');
  else if (groups.length) add('ok', 'openings', plural(groups.length, 'opening was', 'openings were') + ' found.');
  if (windingConsistent && !nonManifoldEdges && !raw.openChains.length) add('ok', 'winding-ok', 'The triangles are wound consistently.');

  const rank = { ok: 0, warn: 1, error: 2 };
  const top = messages.reduce((r, m) => Math.max(r, rank[m.level]), 0);
  return {
    nTri: nT, nVert: nV, bbox, diag, weldTol,
    merged: info.merged || 0, degenerate: info.degenerate || 0, duplicate: info.duplicate || 0,
    boundaryEdges, nonManifoldEdges, openChains: raw.openChains.length,
    loops, closed: boundaryEdges === 0 && nonManifoldEdges === 0, windingConsistent, signedVolume,
    faceting, severity: ['ok', 'warn', 'error'][top], messages,
  };
}

// ---------------------------------------------------------------- coplanar regions

function triPlane(V, tris, t) {
  const a = 3 * tris[3 * t], b = 3 * tris[3 * t + 1], c = 3 * tris[3 * t + 2];
  const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
  const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 0)) return null;
  const n = [nx / l, ny / l, nz / l];
  return { n, d: n[0] * V[a] + n[1] * V[a + 1] + n[2] * V[a + 2], area: l / 2 };
}

// Breadth-first flood fill from `seed` across manifold edges; returns the region's triangles (in visit order).
function flood(mesh, T, seed, cosTol, distTol, mark, value) {
  const V = mesh.vertices, tris = mesh.tris;
  const sp = triPlane(V, tris, seed);
  if (!sp) return [seed];
  const queue = [seed];
  mark[seed] = value;
  const accept = (t) => {
    const p = triPlane(V, tris, t);
    if (!p) return false;
    if (Math.abs(p.n[0] * sp.n[0] + p.n[1] * sp.n[1] + p.n[2] * sp.n[2]) < cosTol) return false;
    for (let k = 0; k < 3; k++) {
      const v = 3 * tris[3 * t + k];
      if (Math.abs(sp.n[0] * V[v] + sp.n[1] * V[v + 1] + sp.n[2] * V[v + 2] - sp.d) > distTol) return false;
    }
    return true;
  };
  for (let qi = 0; qi < queue.length; qi++) {
    const t = queue[qi];
    for (let k = 0; k < 3; k++) {
      const e = T.heEdge[3 * t + k];
      if (T.eCount[e] !== 2) continue;
      const s = T.eStart[e];
      const h2 = T.eHe[s] === 3 * t + k ? T.eHe[s + 1] : T.eHe[s];
      const u = Math.floor(h2 / 3);
      if (mark[u] !== -1) continue;
      if (!accept(u)) continue;
      mark[u] = value;
      queue.push(u);
    }
  }
  return queue;
}

/**
 * The coplanar region around triangle seedTri (§3.6.4 step 6): neighbours across manifold edges whose normal is
 * within angleDeg of the seed plane's normal (either orientation) and whose vertices lie within distTol
 * (default 1e-4·diag) of the seed plane. Returns { tris: Uint32Array (ascending), plane: { n, d }, area }.
 */
export function regionFrom(mesh, seedTri, angleDeg = 0.5, distTol = null) {
  const T = meshTopology(mesh);
  if (!(Number.isInteger(seedTri) && seedTri >= 0 && seedTri < T.nT)) fail('Pick a triangle of the mesh (triangle ' + seedTri + ' does not exist).');
  const ang = Number.isFinite(angleDeg) && angleDeg >= 0 ? angleDeg : 0.5;
  const dt = Number.isFinite(distTol) && distTol >= 0 ? distTol : 1e-4 * meshDiag(mesh);
  const mark = new Int32Array(T.nT).fill(-1);
  const list = flood(mesh, T, seedTri, Math.cos(ang * Math.PI / 180), dt, mark, 0);
  const tris = Uint32Array.from(list).sort();
  const V = mesh.vertices, seed = triPlane(V, mesh.tris, seedTri);
  let nx = 0, ny = 0, nz = 0, A = 0, cx = 0, cy = 0, cz = 0;
  for (const t of tris) {
    const p = triPlane(V, mesh.tris, t);
    if (!p) continue;
    const s = seed && p.n[0] * seed.n[0] + p.n[1] * seed.n[1] + p.n[2] * seed.n[2] < 0 ? -1 : 1;
    nx += s * p.area * p.n[0]; ny += s * p.area * p.n[1]; nz += s * p.area * p.n[2];
    A += p.area;
    for (let k = 0; k < 3; k++) {
      const v = 3 * mesh.tris[3 * t + k];
      cx += p.area * V[v] / 3; cy += p.area * V[v + 1] / 3; cz += p.area * V[v + 2] / 3;
    }
  }
  const l = Math.hypot(nx, ny, nz);
  const n = l > 0 ? [nx / l, ny / l, nz / l] : (seed ? seed.n : [0, 0, 1]);
  const d = A > 0 ? n[0] * cx / A + n[1] * cy / A + n[2] * cz / A : 0;
  return { tris, plane: { n, d }, area: A };
}

/** Coplanar region id of every triangle (same flood fill as regionFrom, seeds in triangle order). */
export function facetRegions(mesh, angleDeg = 0.5) {
  const T = meshTopology(mesh);
  const ang = Number.isFinite(angleDeg) && angleDeg >= 0 ? angleDeg : 0.5;
  const cosTol = Math.cos(ang * Math.PI / 180), dt = 1e-4 * meshDiag(mesh);
  const mark = new Int32Array(T.nT).fill(-1);
  let r = 0;
  for (let t = 0; t < T.nT; t++) {
    if (mark[t] !== -1) continue;
    flood(mesh, T, t, cosTol, dt, mark, r);
    r++;
  }
  return mark;
}

// ---------------------------------------------------------------- one call

/** Weld + validate + automatic ports: { mesh, report, autoPorts }. */
export function prepareMesh(positions, weldTol = null) {
  const w = weldMesh(positions, weldTol);
  const report = validateMesh(w.mesh, w);
  return { mesh: w.mesh, report, autoPorts: autoPortsOf(w.mesh, report) };
}
