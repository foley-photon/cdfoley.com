// Mesh test-particle Monte Carlo (spec §2.12, §3.6.3) and its post-processing: wall pressure from hit density
// and the axial pressure profile (§3.6.6). Ported from our design prototype cond-proto/mesh-proto.mjs.
// Particles start uniformly on a port (area CDF, folded barycentric point), with a cosine direction about the
// port's inward normal; walls re-emit diffusely on the arrival side, so wall normals need no consistent
// orientation; a port absorbs with its sticking probability; a ray that hits nothing is a leak.
// Pure module: no DOM; runs in the page, in workers and in Node (H7, H8). SI units (metres).
import { makeRng, getSampler } from './rng.js';
import { buildBVH, makeTracer } from './bvh.js';

const MAX_PATH_POINTS = 200;

function findSlot(cdf, r) {
  let lo = 0, hi = cdf.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * Traces n particles launched from port `source` (§3.6.3).
 * opts = { source, n, seed, tally = null, paths = 0, maxBounces = 1e6, sampler = 'cosine' }.
 *   tally: Uint32Array(nTri), incremented in place (by slot) for every wall arrival.
 *   paths: number of particles whose polylines (xyz, at most 200 points) are recorded.
 * Returns { source, n, absorbed: Float64Array(nPorts), leaks, stuck, casts, paths: Float32Array[] };
 * n excludes stuck particles (bounce cap reached).
 */
export function runMeshBatch(scene, trace, { source, n, seed, tally = null, paths = 0, maxBounces = 1e6, sampler = 'cosine' }) {
  const ports = scene.ports, nP = ports.length;
  const P = ports[source];
  if (!P) throw new RangeError('Port ' + source + ' does not exist.');
  if (!(P.area > 0) || !P.slots || !P.slots.length) throw new RangeError('Opening ' + (P.name || source) + ' has no area to launch from.');
  const T = scene.tri, NR = scene.normal, port = scene.port;
  const dirFn = getSampler(sampler);
  const rng = makeRng(seed);
  const stick = new Float64Array(nP);
  for (let k = 0; k < nP; k++) stick[k] = ports[k].stick;
  const eps = 1e-9 * scene.diag;
  const out = new Float64Array(1), D = new Float64Array(3);
  const absorbed = new Float64Array(nP);
  const slots = P.slots, cdf = P.cdf, total = cdf[cdf.length - 1];
  const inx = P.inward[0], iny = P.inward[1], inz = P.inward[2];
  const maxB = maxBounces;
  const nPaths = Math.max(0, Math.min(paths | 0, n));
  const pathList = [];
  let leaks = 0, stuck = 0, casts = 0;
  n = Math.max(0, Math.floor(n));
  const pbuf = nPaths ? new Float32Array(3 * MAX_PATH_POINTS) : null;

  for (let p = 0; p < n; p++) {
    // ---- emission from the port: slot by area, uniform point by folding, cosine about the inward normal
    let s = slots[findSlot(cdf, rng() * total)];
    const o = 9 * s;
    let a = rng(), b = rng();
    if (a + b > 1) { a = 1 - a; b = 1 - b; }
    let x = T[o] + a * (T[o + 3] - T[o]) + b * (T[o + 6] - T[o]);
    let y = T[o + 1] + a * (T[o + 4] - T[o + 1]) + b * (T[o + 7] - T[o + 1]);
    let z = T[o + 2] + a * (T[o + 5] - T[o + 2]) + b * (T[o + 8] - T[o + 2]);
    dirFn(rng, inx, iny, inz, D);
    let dx = D[0], dy = D[1], dz = D[2];
    const rec = p < nPaths;
    let np = 0;
    if (rec) { pbuf[0] = x; pbuf[1] = y; pbuf[2] = z; np = 1; }
    x += eps * inx; y += eps * iny; z += eps * inz;
    for (let bounce = 0; ; bounce++) {
      if (bounce > maxB) { stuck++; break; }
      casts++;
      const h = trace(x, y, z, dx, dy, dz, s, out);
      if (h < 0) {
        leaks++;
        if (rec && np < MAX_PATH_POINTS) { const L = scene.diag; pbuf[3 * np] = x + L * dx; pbuf[3 * np + 1] = y + L * dy; pbuf[3 * np + 2] = z + L * dz; np++; }
        break;
      }
      const t = out[0];
      x += t * dx; y += t * dy; z += t * dz;
      if (rec && np < MAX_PATH_POINTS) { pbuf[3 * np] = x; pbuf[3 * np + 1] = y; pbuf[3 * np + 2] = z; np++; }
      const pid = port[h];
      if (pid >= 0) {
        const st = stick[pid];
        if (st >= 1 || (st > 0 && rng() < st)) { absorbed[pid]++; break; }
      } else if (tally) tally[h]++;
      // diffuse re-emission on the arrival side
      let mx = NR[3 * h], my = NR[3 * h + 1], mz = NR[3 * h + 2];
      if (mx * dx + my * dy + mz * dz > 0) { mx = -mx; my = -my; mz = -mz; }
      dirFn(rng, mx, my, mz, D);
      dx = D[0]; dy = D[1]; dz = D[2];
      x += eps * mx; y += eps * my; z += eps * mz;
      s = h;
    }
    if (rec) pathList.push(pbuf.slice(0, 3 * np));
  }
  return { source, n: n - stuck, absorbed, leaks, stuck, casts, paths: pathList };
}

function launchNorm(scene, inletLaunches) {
  let norm = 0;
  for (const L of inletLaunches || []) {
    const P = scene.ports[L.port];
    if (P && P.area > 0 && L.n > 0) norm += L.n / P.area;
  }
  return norm;
}

/**
 * Wall pressure p/p_in by slot (§3.6.6): (h_t/A_t)/(Σ_i N_i/A_i) over the inlet ports i, for isothermal diffuse walls.
 * The sum is exact only for one inlet; the runner (v2.2) tallies the selected inlet's launches alone, so inletLaunches
 * has a single entry and the map is the pressure with that inlet at p_in and every other opening pumping.
 * inletLaunches: [{ port, n }]. Port slots get NaN. opts.regionsBySlot (Int32Array, region id per slot, −1 for none)
 * replaces each wall triangle's value by the area-weighted mean over its region ("Average over flat faces").
 */
export function wallPressure(scene, hitsBySlot, inletLaunches, opts = {}) {
  const n = scene.nTri, out = new Float64Array(n);
  const norm = launchNorm(scene, inletLaunches);
  const area = scene.area, port = scene.port;
  const reg = opts && opts.regionsBySlot;
  if (reg) {
    const hs = new Map(), as = new Map();
    for (let s = 0; s < n; s++) {
      if (port[s] >= 0 || reg[s] < 0) continue;
      hs.set(reg[s], (hs.get(reg[s]) || 0) + (hitsBySlot ? hitsBySlot[s] : 0));
      as.set(reg[s], (as.get(reg[s]) || 0) + area[s]);
    }
    for (let s = 0; s < n; s++) {
      if (port[s] >= 0) { out[s] = NaN; continue; }
      if (reg[s] >= 0) out[s] = norm > 0 ? hs.get(reg[s]) / (as.get(reg[s]) * norm) : NaN;
      else out[s] = norm > 0 && area[s] > 0 ? (hitsBySlot ? hitsBySlot[s] : 0) / (area[s] * norm) : NaN;
    }
    return out;
  }
  for (let s = 0; s < n; s++) {
    if (port[s] >= 0) { out[s] = NaN; continue; }
    out[s] = norm > 0 && area[s] > 0 ? (hitsBySlot ? hitsBySlot[s] : 0) / (area[s] * norm) : NaN;
  }
  return out;
}

function principalAxis(scene) {
  // area-weighted PCA of wall-triangle centroids
  const T = scene.tri, A = scene.area, port = scene.port, n = scene.nTri;
  let W = 0, mx = 0, my = 0, mz = 0;
  for (let s = 0; s < n; s++) {
    if (port[s] >= 0) continue;
    const o = 9 * s, w = A[s];
    mx += w * (T[o] + T[o + 3] + T[o + 6]) / 3; my += w * (T[o + 1] + T[o + 4] + T[o + 7]) / 3; mz += w * (T[o + 2] + T[o + 5] + T[o + 8]) / 3;
    W += w;
  }
  if (!(W > 0)) return { origin: [0, 0, 0], dir: [0, 0, 1] };
  mx /= W; my /= W; mz /= W;
  const C = [0, 0, 0, 0, 0, 0];   // xx, yy, zz, xy, xz, yz
  for (let s = 0; s < n; s++) {
    if (port[s] >= 0) continue;
    const o = 9 * s, w = A[s];
    const cx = (T[o] + T[o + 3] + T[o + 6]) / 3 - mx, cy = (T[o + 1] + T[o + 4] + T[o + 7]) / 3 - my, cz = (T[o + 2] + T[o + 5] + T[o + 8]) / 3 - mz;
    C[0] += w * cx * cx; C[1] += w * cy * cy; C[2] += w * cz * cz; C[3] += w * cx * cy; C[4] += w * cx * cz; C[5] += w * cy * cz;
  }
  // power iteration for the largest eigenvector
  let v = [1, 1, 1];
  for (let it = 0; it < 100; it++) {
    const nv = [C[0] * v[0] + C[3] * v[1] + C[4] * v[2], C[3] * v[0] + C[1] * v[1] + C[5] * v[2], C[4] * v[0] + C[5] * v[1] + C[2] * v[2]];
    const l = Math.hypot(nv[0], nv[1], nv[2]);
    if (!(l > 0)) break;
    v = [nv[0] / l, nv[1] / l, nv[2] / l];
  }
  return { origin: [mx, my, mz], dir: v };
}

/** Axis used by axialProfile: { origin, dir (unit), length, s0 } from the inlet to the outlet centroid, or principal. */
export function profileAxis(scene, axis = null) {
  if (axis && axis.origin && axis.dir) {
    const l = Math.hypot(axis.dir[0], axis.dir[1], axis.dir[2]);
    return { origin: axis.origin.slice(), dir: axis.dir.map((x) => x / l), length: axis.length ?? null, s0: axis.s0 ?? 0 };
  }
  if (axis && axis.from && axis.to) {
    const d = [axis.to[0] - axis.from[0], axis.to[1] - axis.from[1], axis.to[2] - axis.from[2]], l = Math.hypot(...d);
    return { origin: axis.from.slice(), dir: d.map((x) => x / l), length: l, s0: 0 };
  }
  const ports = scene.ports;
  const inlet = ports.find((p) => p.role === 'inlet');
  const outlet = ports.find((p) => p.role === 'outlet') || ports.find((p) => p.role === 'pump');
  if (inlet && outlet && inlet.centroid && outlet.centroid) {
    const d = [0, 1, 2].map((k) => outlet.centroid[k] - inlet.centroid[k]), l = Math.hypot(...d);
    if (l > 0) return { origin: inlet.centroid.slice(), dir: d.map((x) => x / l), length: l, s0: 0 };
  }
  const pa = principalAxis(scene);
  return { origin: pa.origin, dir: pa.dir, length: null, s0: null };
}

/**
 * Axial pressure profile (§3.6.6): bins of equal length along the axis, by wall-triangle centroid;
 * per bin p/p_in = Σh/(ΣA·Σ_i N_i/A_i) with a ±1.96/√Σh relative interval.
 * Returns { s (bin centres, m from the axis origin), value, lo, hi, hits, axis: { origin, dir, length, s0 } }.
 */
export function axialProfile(scene, hitsBySlot, inletLaunches, { bins = 40, axis = null } = {}) {
  const ax = profileAxis(scene, axis);
  const T = scene.tri, A = scene.area, port = scene.port, n = scene.nTri;
  const proj = new Float64Array(n);
  let pmin = Infinity, pmax = -Infinity;
  for (let s = 0; s < n; s++) {
    if (port[s] >= 0) continue;
    const o = 9 * s;
    const cx = (T[o] + T[o + 3] + T[o + 6]) / 3 - ax.origin[0], cy = (T[o + 1] + T[o + 4] + T[o + 7]) / 3 - ax.origin[1], cz = (T[o + 2] + T[o + 5] + T[o + 8]) / 3 - ax.origin[2];
    const t = cx * ax.dir[0] + cy * ax.dir[1] + cz * ax.dir[2];
    proj[s] = t;
    if (t < pmin) pmin = t;
    if (t > pmax) pmax = t;
  }
  let s0 = ax.s0, length = ax.length;
  if (s0 === null || length === null || !(length > 0)) { s0 = pmin; length = pmax - pmin; }
  const nb = Math.max(1, bins | 0);
  const H = new Float64Array(nb), AA = new Float64Array(nb);
  for (let s = 0; s < n; s++) {
    if (port[s] >= 0) continue;
    let k = length > 0 ? Math.floor((proj[s] - s0) / length * nb) : 0;
    if (k < 0) k = 0; else if (k >= nb) k = nb - 1;
    H[k] += hitsBySlot ? hitsBySlot[s] : 0;
    AA[k] += A[s];
  }
  const norm = launchNorm(scene, inletLaunches);
  const sOut = new Float64Array(nb), value = new Float64Array(nb), lo = new Float64Array(nb), hi = new Float64Array(nb);
  for (let k = 0; k < nb; k++) {
    sOut[k] = s0 + (k + 0.5) / nb * length;
    if (!(AA[k] > 0) || !(norm > 0)) { value[k] = lo[k] = hi[k] = NaN; continue; }
    const v = H[k] / (AA[k] * norm);
    value[k] = v;
    if (H[k] > 0) { const r = 1.96 / Math.sqrt(H[k]); lo[k] = v * Math.max(0, 1 - r); hi[k] = v * (1 + r); }
    else { lo[k] = 0; hi[k] = NaN; }
  }
  return { s: sOut, value, lo, hi, hits: H, axis: { origin: ax.origin, dir: ax.dir, length, s0 } };
}

// ---------------------------------------------------------------- scene helpers

/** Per-slot array from a per-prepared-triangle array (through scene.origTri). */
export function toSlotOrder(scene, arr, ArrayType = null) {
  const C = ArrayType || arr.constructor;
  const out = new C(scene.nTri);
  for (let s = 0; s < scene.nTri; s++) out[s] = arr[scene.origTri[s]];
  return out;
}

/** Per-prepared-triangle array from a per-slot array (through scene.origTri). */
export function toPreparedOrder(scene, arrBySlot, ArrayType = null) {
  const C = ArrayType || arrBySlot.constructor;
  const out = new C(scene.nTri);
  for (let s = 0; s < scene.nTri; s++) out[scene.origTri[s]] = arrBySlot[s];
  return out;
}

/**
 * A MeshScene (§2.12) from a triangle soup with given port ids, for tests and controls (the CAD tab builds its
 * scenes with ports.buildScene). tri: Float32Array(9n) in metres; triPort: Int16Array(n), −1 for walls;
 * ports: [{ id, name, role, stick, inward: [x, y, z] }] (index = port id). The port centroid is computed.
 */
export function makeScene(tri, triPort, ports) {
  const n = Math.floor(tri.length / 9);
  const bvh = buildBVH(tri);
  const T = new Float32Array(9 * n), port = new Int16Array(n), origTri = new Uint32Array(n);
  const normal = new Float32Array(3 * n), area = new Float64Array(n);
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let s = 0; s < n; s++) {
    const i = bvh.order[s];
    for (let k = 0; k < 9; k++) T[9 * s + k] = tri[9 * i + k];
    port[s] = triPort[i]; origTri[s] = i;
    const o = 9 * s;
    const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
    const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    area[s] = l / 2;
    if (l > 0) { normal[3 * s] = nx / l; normal[3 * s + 1] = ny / l; normal[3 * s + 2] = nz / l; }
    for (let v = 0; v < 3; v++) {
      const X = T[o + 3 * v], Y = T[o + 3 * v + 1], Z = T[o + 3 * v + 2];
      if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
    }
  }
  const outPorts = ports.map((p, k) => {
    const sl = [];
    for (let s = 0; s < n; s++) if (port[s] === k) sl.push(s);
    const slots = Uint32Array.from(sl), cdf = new Float64Array(sl.length);
    let tot = 0, cx = 0, cy = 0, cz = 0;
    sl.forEach((s, j) => {
      tot += area[s]; cdf[j] = tot;
      const o = 9 * s;
      cx += area[s] * (T[o] + T[o + 3] + T[o + 6]) / 3; cy += area[s] * (T[o + 1] + T[o + 4] + T[o + 7]) / 3; cz += area[s] * (T[o + 2] + T[o + 5] + T[o + 8]) / 3;
    });
    const l = Math.hypot(p.inward[0], p.inward[1], p.inward[2]);
    return {
      id: p.id ?? k, name: p.name || 'Opening ' + (k + 1), role: p.role, stick: p.stick ?? 1, area: tot,
      inward: [p.inward[0] / l, p.inward[1] / l, p.inward[2] / l],
      centroid: tot > 0 ? [cx / tot, cy / tot, cz / tot] : [0, 0, 0], slots, cdf,
    };
  });
  return {
    version: 1, nTri: n, tri: T, normal, area, port, origTri, box: bvh.box, meta: bvh.meta,
    diag: Math.hypot(x1 - x0, y1 - y0, z1 - z0), bbox: [x0, y0, z0, x1, y1, z1], ports: outPorts,
  };
}

/**
 * The same scene with some triangles removed (keep[slot] false), BVH rebuilt; used by the leaky-mesh control.
 * Triangle indices (origTri) refer to the original scene's prepared mesh.
 */
export function subsetScene(scene, keep) {
  const idx = [];
  for (let s = 0; s < scene.nTri; s++) if (keep[s]) idx.push(s);
  const tri = new Float32Array(9 * idx.length), triPort = new Int16Array(idx.length);
  idx.forEach((s, j) => { for (let k = 0; k < 9; k++) tri[9 * j + k] = scene.tri[9 * s + k]; triPort[j] = scene.port[s]; });
  const sc = makeScene(tri, triPort, scene.ports.map((p) => ({ id: p.id, name: p.name, role: p.role, stick: p.stick, inward: p.inward })));
  for (let s = 0; s < sc.nTri; s++) sc.origTri[s] = scene.origTri[idx[sc.origTri[s]]];
  return sc;
}
