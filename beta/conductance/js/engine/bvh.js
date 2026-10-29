// Flat bounding-volume hierarchy and watertight closest-hit ray tracing (spec §2.12, §3.6.3). Ported from our
// design prototype cond-proto/mesh-proto.mjs; algorithms from the open literature:
//   - binned SAH build: I. Wald, "On fast construction of SAH-based bounding volume hierarchies" (2007);
//   - watertight ray/triangle test: S. Woop, C. Benthin and I. Wald, JCGT 2(1), 2013;
//   - conservative slab test with t_max·(1 + 2γ₃): T. Ize, "Robust BVH ray traversal", JCGT 2(2), 2013.
// Layout: depth-first, so the left child of node i is i + 1. meta[2i] = right child (inner) or first slot (leaf);
// meta[2i + 1] = leaf count (> 0) or −(split axis + 1) (inner). Boxes are Float32, rounded outward.
// Pure module: no DOM; runs in the page, in workers and in Node (H7, H8).

const DEPTH_LIMIT = 200;
const EPS53 = 1.1102230246251565e-16;                 // 2⁻⁵³
const GAMMA3 = 3 * EPS53 / (1 - 3 * EPS53);
const ERR = 1 + 2 * GAMMA3;

function f32down(x) { return Math.fround(x - (Math.abs(x) * 1.2e-7 + 1e-38)); }
function f32up(x) { return Math.fround(x + (Math.abs(x) * 1.2e-7 + 1e-38)); }

/**
 * Builds the BVH of a triangle soup tri (Float32Array, 9 numbers per triangle).
 * opts = { leafSize: 4, bins: 12 }. Returns { order: Uint32Array (slot → triangle), box: Float32Array (6 per node),
 * meta: Int32Array (2 per node), depth, nodes }. Throws RangeError when the tree would be deeper than 200 levels.
 */
export function buildBVH(tri, opts = { leafSize: 4, bins: 12 }) {
  const leafSize = Math.max(1, (opts && opts.leafSize) || 4), NB = Math.max(2, (opts && opts.bins) || 12);
  const MAX_DEPTH = Math.min(DEPTH_LIMIT, (opts && opts.maxDepth) || DEPTH_LIMIT);   // maxDepth: tests only
  const n = Math.floor(tri.length / 9);
  if (!(n > 0)) throw new RangeError('The mesh has no triangles.');
  if (n > 0x7fffffff / 2) throw new RangeError('The mesh is too large to trace.');
  const bmin = new Float64Array(3 * n), bmax = new Float64Array(3 * n), cen = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const o = 9 * i;
    for (let k = 0; k < 3; k++) {
      const a = tri[o + k], b = tri[o + 3 + k], c = tri[o + 6 + k];
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) throw new RangeError('The mesh has a vertex that is not a finite number.');
      bmin[3 * i + k] = Math.min(a, b, c);
      bmax[3 * i + k] = Math.max(a, b, c);
      cen[3 * i + k] = (a + b + c) / 3;
    }
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const cap = 2 * n;
  const box = new Float32Array(6 * cap), meta = new Int32Array(2 * cap);
  // task stack: start, end, rightOf (parent whose right child this is, or −1), depth
  const ts = new Int32Array(4 * (MAX_DEPTH + 8) * 2);
  let tsp = 0, nodes = 0, maxDepth = 0;
  const cnt = new Int32Array(NB), bb = new Float64Array(6 * NB);
  const lA = new Float64Array(NB), lN = new Int32Array(NB);
  const push = (s, e, rightOf, depth) => {
    if (tsp + 4 > ts.length) throw new RangeError('The mesh is too degenerate to trace (BVH depth > 200).');
    ts[tsp++] = s; ts[tsp++] = e; ts[tsp++] = rightOf; ts[tsp++] = depth;
  };
  push(0, n, -1, 0);
  while (tsp > 0) {
    const depth = ts[--tsp], rightOf = ts[--tsp], e = ts[--tsp], s = ts[--tsp];
    if (depth > MAX_DEPTH) throw new RangeError('The mesh is too degenerate to trace (BVH depth > 200).');
    if (depth > maxDepth) maxDepth = depth;
    const node = nodes++;
    if (rightOf >= 0) meta[2 * rightOf] = node;
    // node bounds and centroid bounds
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let j = s; j < e; j++) {
      const i3 = 3 * order[j];
      if (bmin[i3] < x0) x0 = bmin[i3]; if (bmin[i3 + 1] < y0) y0 = bmin[i3 + 1]; if (bmin[i3 + 2] < z0) z0 = bmin[i3 + 2];
      if (bmax[i3] > x1) x1 = bmax[i3]; if (bmax[i3 + 1] > y1) y1 = bmax[i3 + 1]; if (bmax[i3 + 2] > z1) z1 = bmax[i3 + 2];
      const a = cen[i3], b = cen[i3 + 1], c = cen[i3 + 2];
      if (a < cx0) cx0 = a; if (a > cx1) cx1 = a;
      if (b < cy0) cy0 = b; if (b > cy1) cy1 = b;
      if (c < cz0) cz0 = c; if (c > cz1) cz1 = c;
    }
    const b6 = 6 * node;
    box[b6] = f32down(x0); box[b6 + 1] = f32down(y0); box[b6 + 2] = f32down(z0);
    box[b6 + 3] = f32up(x1); box[b6 + 4] = f32up(y1); box[b6 + 5] = f32up(z1);
    const m = e - s;
    if (m <= leafSize) { meta[2 * node] = s; meta[2 * node + 1] = m; continue; }
    // binned SAH over centroids
    let bestCost = Infinity, bestAxis = -1, bestSplit = -1;
    const cmin = [cx0, cy0, cz0], cext = [cx1 - cx0, cy1 - cy0, cz1 - cz0];
    for (let ax = 0; ax < 3; ax++) {
      const ext = cext[ax];
      if (!(ext > 0)) continue;
      const c0 = cmin[ax], sc = NB / ext;
      cnt.fill(0);
      for (let k = 0; k < NB; k++) { bb[6 * k] = bb[6 * k + 1] = bb[6 * k + 2] = Infinity; bb[6 * k + 3] = bb[6 * k + 4] = bb[6 * k + 5] = -Infinity; }
      for (let j = s; j < e; j++) {
        const i = order[j], i3 = 3 * i;
        let k = Math.floor((cen[i3 + ax] - c0) * sc);
        if (k >= NB) k = NB - 1; else if (k < 0) k = 0;
        cnt[k]++;
        const q = 6 * k;
        if (bmin[i3] < bb[q]) bb[q] = bmin[i3]; if (bmin[i3 + 1] < bb[q + 1]) bb[q + 1] = bmin[i3 + 1]; if (bmin[i3 + 2] < bb[q + 2]) bb[q + 2] = bmin[i3 + 2];
        if (bmax[i3] > bb[q + 3]) bb[q + 3] = bmax[i3]; if (bmax[i3 + 1] > bb[q + 4]) bb[q + 4] = bmax[i3 + 1]; if (bmax[i3 + 2] > bb[q + 5]) bb[q + 5] = bmax[i3 + 2];
      }
      // left sweep: area and count of bins 0..k
      let ax0 = Infinity, ay0 = Infinity, az0 = Infinity, ax1 = -Infinity, ay1 = -Infinity, az1 = -Infinity, nl = 0;
      for (let k = 0; k < NB - 1; k++) {
        const q = 6 * k;
        if (cnt[k]) {
          if (bb[q] < ax0) ax0 = bb[q]; if (bb[q + 1] < ay0) ay0 = bb[q + 1]; if (bb[q + 2] < az0) az0 = bb[q + 2];
          if (bb[q + 3] > ax1) ax1 = bb[q + 3]; if (bb[q + 4] > ay1) ay1 = bb[q + 4]; if (bb[q + 5] > az1) az1 = bb[q + 5];
        }
        nl += cnt[k]; lN[k] = nl;
        const dx = ax1 - ax0, dy = ay1 - ay0, dz = az1 - az0;
        lA[k] = nl ? 2 * (dx * dy + dy * dz + dz * dx) : 0;
      }
      // right sweep and cost
      ax0 = ay0 = az0 = Infinity; ax1 = ay1 = az1 = -Infinity;
      let nr = 0;
      for (let k = NB - 1; k >= 1; k--) {
        const q = 6 * k;
        if (cnt[k]) {
          if (bb[q] < ax0) ax0 = bb[q]; if (bb[q + 1] < ay0) ay0 = bb[q + 1]; if (bb[q + 2] < az0) az0 = bb[q + 2];
          if (bb[q + 3] > ax1) ax1 = bb[q + 3]; if (bb[q + 4] > ay1) ay1 = bb[q + 4]; if (bb[q + 5] > az1) az1 = bb[q + 5];
        }
        nr += cnt[k];
        const nlk = lN[k - 1];
        if (!nlk || !nr) continue;
        const dx = ax1 - ax0, dy = ay1 - ay0, dz = az1 - az0;
        const cost = nlk * lA[k - 1] + nr * 2 * (dx * dy + dy * dz + dz * dx);
        if (cost < bestCost) { bestCost = cost; bestAxis = ax; bestSplit = k; }   // left = bins < k
      }
    }
    let mid = -1, splitAxis = bestAxis;
    if (bestAxis >= 0) {
      const c0 = cmin[bestAxis], sc = NB / cext[bestAxis];
      let i = s, j = e - 1;
      while (i <= j) {
        let k = Math.floor((cen[3 * order[i] + bestAxis] - c0) * sc);
        if (k >= NB) k = NB - 1; else if (k < 0) k = 0;
        if (k < bestSplit) i++;
        else { const t = order[i]; order[i] = order[j]; order[j] = t; j--; }
      }
      mid = i;
    }
    if (mid <= s || mid >= e) {
      // degenerate: split at the median index, on the longest axis of the node box
      mid = s + (m >> 1);
      const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
      splitAxis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    }
    meta[2 * node + 1] = -(splitAxis + 1);
    push(mid, e, node, depth + 1);      // right: processed after the whole left subtree
    push(s, mid, -1, depth + 1);        // left: next node index = node + 1
  }
  return { order, box: box.slice(0, 6 * nodes), meta: meta.slice(0, 2 * nodes), depth: maxDepth, nodes };
}

/**
 * Closest-hit tracer of a MeshScene (scene.tri in slot order, scene.box, scene.meta).
 * Returns trace(ox, oy, oz, dx, dy, dz, skipSlot, out) → slot | −1, with out[0] = t (Infinity on a miss).
 * The ray direction need not be normalized; t is in units of |d|.
 * Traversal: at an inner node both children's boxes are slab-tested; the walk descends into the nearer child (by
 * entry distance) and stacks the farther one with its entry distance, which is skipped when it lies beyond the best
 * hit found meanwhile. Boxes whose slab interval is empty, behind the origin or beyond the best hit are never entered.
 */
export function makeTracer(scene) {
  const box = scene.box, meta = scene.meta, T = scene.tri;
  const stackN = new Int32Array(256), stackT = new Float64Array(256);
  return function trace(ox, oy, oz, dx, dy, dz, skip, out) {
    // Woop–Benthin–Wald ray set-up: kz = dominant axis, kx and ky cyclic, swapped when d_kz < 0
    const adx = Math.abs(dx), ady = Math.abs(dy), adz = Math.abs(dz);
    let kz = adx > ady ? (adx > adz ? 0 : 2) : (ady > adz ? 1 : 2);
    let kx = kz === 2 ? 0 : kz + 1, ky = kx === 2 ? 0 : kx + 1;
    const dkz = kz === 0 ? dx : kz === 1 ? dy : dz;
    if (dkz < 0) { const t = kx; kx = ky; ky = t; }
    const dkx = kx === 0 ? dx : kx === 1 ? dy : dz, dky = ky === 0 ? dx : ky === 1 ? dy : dz;
    const okx = kx === 0 ? ox : kx === 1 ? oy : oz, oky = ky === 0 ? ox : ky === 1 ? oy : oz, okz = kz === 0 ? ox : kz === 1 ? oy : oz;
    const Sx = dkx / dkz, Sy = dky / dkz, Sz = 1 / dkz;
    // Slab offsets of the near and far box sides. They follow the sign of the reciprocal, so a component of −0
    // (1/−0 = −∞) is handled consistently. A slab whose bound gives 0·∞ = NaN (a zero component on a box face)
    // does not restrict the ray: every comparison with NaN is false, so the updates below skip it.
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    const xn = ix < 0 ? 3 : 0, xf = 3 - xn, yn = iy < 0 ? 4 : 1, yf = 5 - yn, zn = iz < 0 ? 5 : 2, zf = 7 - zn;
    let tBest = Infinity, hit = -1, sp = 0, nd = 0;
    {
      let tmin = -Infinity, tmax = Infinity;
      const a0 = (box[xn] - ox) * ix, a1 = (box[xf] - ox) * ix;
      if (a0 > tmin) tmin = a0;
      if (a1 < tmax) tmax = a1;
      const b0 = (box[yn] - oy) * iy, b1 = (box[yf] - oy) * iy;
      if (b0 > tmin) tmin = b0;
      if (b1 < tmax) tmax = b1;
      const c0 = (box[zn] - oz) * iz, c1 = (box[zf] - oz) * iz;
      if (c0 > tmin) tmin = c0;
      if (c1 < tmax) tmax = c1;
      if (!(tmin <= tmax * ERR && tmax >= 0)) { out[0] = Infinity; return -1; }
    }
    for (;;) {
      const m0 = meta[2 * nd], m1 = meta[2 * nd + 1];
      if (m1 > 0) {
        for (let s = m0, end = m0 + m1; s < end; s++) {
          if (s === skip) continue;
          const o = 9 * s;
          const Az0 = T[o + kz] - okz, Bz0 = T[o + 3 + kz] - okz, Cz0 = T[o + 6 + kz] - okz;
          const Ax = T[o + kx] - okx - Sx * Az0, Ay = T[o + ky] - oky - Sy * Az0;
          const Bx = T[o + 3 + kx] - okx - Sx * Bz0, By = T[o + 3 + ky] - oky - Sy * Bz0;
          const Cx = T[o + 6 + kx] - okx - Sx * Cz0, Cy = T[o + 6 + ky] - oky - Sy * Cz0;
          const U = Cx * By - Cy * Bx, V = Ax * Cy - Ay * Cx, W = Bx * Ay - By * Ax;
          if ((U < 0 || V < 0 || W < 0) && (U > 0 || V > 0 || W > 0)) continue;
          const det = U + V + W;
          if (det === 0) continue;
          const t = (U * (Sz * Az0) + V * (Sz * Bz0) + W * (Sz * Cz0)) / det;
          if (t > 0 && t < tBest) { tBest = t; hit = s; }
        }
      } else {
        // entry distances of both children (NaN when the ray misses the box, or enters it beyond the best hit);
        // t_max is widened by 1 + 2γ₃ (Ize 2013)
        const l = nd + 1, r = m0;
        let b = 6 * l, tl, tr;
        {
          let tmin = -Infinity, tmax = Infinity;
          const a0 = (box[b + xn] - ox) * ix, a1 = (box[b + xf] - ox) * ix;
          if (a0 > tmin) tmin = a0;
          if (a1 < tmax) tmax = a1;
          const b0 = (box[b + yn] - oy) * iy, b1 = (box[b + yf] - oy) * iy;
          if (b0 > tmin) tmin = b0;
          if (b1 < tmax) tmax = b1;
          const c0 = (box[b + zn] - oz) * iz, c1 = (box[b + zf] - oz) * iz;
          if (c0 > tmin) tmin = c0;
          if (c1 < tmax) tmax = c1;
          tl = (tmin <= tmax * ERR && tmax >= 0 && tmin <= tBest) ? tmin : NaN;
        }
        b = 6 * r;
        {
          let tmin = -Infinity, tmax = Infinity;
          const a0 = (box[b + xn] - ox) * ix, a1 = (box[b + xf] - ox) * ix;
          if (a0 > tmin) tmin = a0;
          if (a1 < tmax) tmax = a1;
          const b0 = (box[b + yn] - oy) * iy, b1 = (box[b + yf] - oy) * iy;
          if (b0 > tmin) tmin = b0;
          if (b1 < tmax) tmax = b1;
          const c0 = (box[b + zn] - oz) * iz, c1 = (box[b + zf] - oz) * iz;
          if (c0 > tmin) tmin = c0;
          if (c1 < tmax) tmax = c1;
          tr = (tmin <= tmax * ERR && tmax >= 0 && tmin <= tBest) ? tmin : NaN;
        }
        if (tl === tl) {                       // the left child is hit
          if (tr === tr) {
            if (tl <= tr) { stackN[sp] = r; stackT[sp++] = tr; nd = l; } else { stackN[sp] = l; stackT[sp++] = tl; nd = r; }
          } else nd = l;
          continue;
        }
        if (tr === tr) { nd = r; continue; }
      }
      // next stacked node that can still hold a closer hit
      let more = false;
      while (sp > 0) {
        if (stackT[--sp] <= tBest) { nd = stackN[sp]; more = true; break; }
      }
      if (!more) break;
    }
    out[0] = tBest;
    return hit;
  };
}

const TRACERS = new WeakMap();

/** Closest hit of the ray origin + t·dir (t > 0) on a MeshScene: { slot, t } or null. */
export function closestHit(scene, origin, dir) {
  let tr = TRACERS.get(scene);
  if (!tr) { tr = makeTracer(scene); TRACERS.set(scene, tr); }
  const out = new Float64Array(1);
  const s = tr(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], -1, out);
  return s < 0 ? null : { slot: s, t: out[0] };
}
