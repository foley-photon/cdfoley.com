// Triangulation of a simple polygon with holes by ear clipping (spec §3.6.4 step 5), written from D. Eberly,
// "Triangulation by Ear Clipping" (Geometric Tools, 2002):
//   1. the outer loop is taken counterclockwise and the holes clockwise;
//   2. holes are merged into the outer loop one at a time, rightmost hole first: from the hole's rightmost vertex M
//      a ray in +x finds the nearest edge; the endpoint P of that edge with the larger x is the candidate, unless
//      a reflex vertex lies inside triangle (M, I, P), in which case the one making the smallest angle with the ray
//      is used; the bridge M–P is mutually visible, and the loop continues P → M → hole → M → P;
//   3. ears (convex vertices whose triangle holds no non-convex vertex, tested against the non-convex vertices only;
//      a vertex on the ear's edges also blocks it unless it is a copy of one of the ear's corners) are clipped until
//      three vertices remain. Loops of a few thousand vertices take O(n²) at worst; convex loops take O(n).
// Near-collinear vertices (|sin θ| ≤ 1e-10) count as non-convex, so no zero-area triangle is made from them; if no
// ear is found (a degenerate or self-touching input) the most convex vertex is clipped so the method always ends.
// Pure module: no DOM; runs in the page, in workers and in Node (H7, H8).

/**
 * Triangulates the polygon `outer` (Float64Array x0, y0, x1, y1, …) with `holes` (array of the same).
 * Returns indices into the concatenation [outer, ...holes] (3 per triangle) as a Uint32Array; every triangle has
 * the winding of `outer`. Holes may be given in either orientation.
 */
export function triangulatePolygon(outer, holes = []) {
  const nOuter = Math.floor((outer ? outer.length : 0) / 2);
  if (nOuter < 3) return new Uint32Array(0);
  const holeList = (holes || []).filter((h) => h && h.length >= 6);
  let total = nOuter;
  const holeOffset = [];
  for (const h of holes || []) { holeOffset.push(total); total += Math.floor((h ? h.length : 0) / 2); }
  const X = new Float64Array(total), Y = new Float64Array(total);
  for (let i = 0; i < nOuter; i++) { X[i] = outer[2 * i]; Y[i] = outer[2 * i + 1]; }
  (holes || []).forEach((h, k) => {
    const m = Math.floor((h ? h.length : 0) / 2), o = holeOffset[k];
    for (let i = 0; i < m; i++) { X[o + i] = h[2 * i]; Y[o + i] = h[2 * i + 1]; }
  });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < total; i++) {
    if (X[i] < minX) minX = X[i]; if (X[i] > maxX) maxX = X[i];
    if (Y[i] < minY) minY = Y[i]; if (Y[i] > maxY) maxY = Y[i];
  }
  const eps = 1e-14 * ((maxX - minX) ** 2 + (maxY - minY) ** 2);

  const signedArea = (o, m) => {
    let s = 0;
    for (let i = 0, j = m - 1; i < m; j = i++) s += (X[o + j] - X[o + i]) * (Y[o + j] + Y[o + i]);
    return s / 2;
  };
  const outerArea = signedArea(0, nOuter);
  if (!(outerArea !== 0)) return new Uint32Array(0);
  const flip = outerArea < 0;

  // doubly linked ring of nodes; id[k] = index into X, Y (bridges duplicate two vertices per hole)
  const cap = total + 2 * holeList.length + 2;
  const nx = new Int32Array(cap), pv = new Int32Array(cap), id = new Int32Array(cap);
  let nNodes = 0;
  const ring = (indices) => {
    const first = nNodes;
    for (let k = 0; k < indices.length; k++) { id[nNodes] = indices[k]; nNodes++; }
    for (let k = 0; k < indices.length; k++) {
      const a = first + k;
      nx[a] = first + (k + 1) % indices.length;
      pv[a] = first + (k + indices.length - 1) % indices.length;
    }
    return first;
  };
  const seq = (o, m, reverse) => { const a = []; for (let i = 0; i < m; i++) a.push(o + (reverse ? m - 1 - i : i)); return a; };
  let start = ring(seq(0, nOuter, flip));
  let count = nOuter;

  const orient = (a, b, c) => (X[id[b]] - X[id[a]]) * (Y[id[c]] - Y[id[a]]) - (Y[id[b]] - Y[id[a]]) * (X[id[c]] - X[id[a]]);
  const orientXY = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const convex = (k) => {
    const a = pv[k], c = nx[k];
    const o = orient(a, k, c);
    if (!(o > 0)) return false;
    const l1 = (X[id[k]] - X[id[a]]) ** 2 + (Y[id[k]] - Y[id[a]]) ** 2;
    const l2 = (X[id[c]] - X[id[k]]) ** 2 + (Y[id[c]] - Y[id[k]]) ** 2;
    return o * o > 1e-20 * l1 * l2;
  };

  // ---- merge holes (CW), rightmost first
  const hs = [];
  (holes || []).forEach((h, k) => {
    const m = Math.floor((h ? h.length : 0) / 2);
    if (m < 3) return;
    const o = holeOffset[k], a = signedArea(o, m);
    if (!(a !== 0)) return;
    let right = o;
    for (let i = o + 1; i < o + m; i++) if (X[i] > X[right] || (X[i] === X[right] && Y[i] < Y[right])) right = i;
    hs.push({ o, m, reverse: a > 0, right });
  });
  hs.sort((p, q) => X[q.right] - X[p.right]);

  const locallyInside = (r, mx, my) => {
    const a = pv[r], b = nx[r];
    const rx = X[id[r]], ry = Y[id[r]];
    if (orient(a, r, b) >= 0) {
      return orientXY(rx, ry, X[id[b]], Y[id[b]], mx, my) >= 0 && orientXY(rx, ry, mx, my, X[id[a]], Y[id[a]]) >= 0;
    }
    return orientXY(rx, ry, X[id[a]], Y[id[a]], mx, my) <= 0 || orientXY(rx, ry, mx, my, X[id[b]], Y[id[b]]) <= 0;
  };

  for (const h of hs) {
    const first = ring(seq(h.o, h.m, h.reverse));
    let M = first;
    for (let k = first; k < first + h.m; k++) if (id[k] === h.right) { M = k; break; }
    const mx = X[id[M]], my = Y[id[M]];
    // nearest crossing of the ray from M in +x with an upward edge (interior on its left)
    let bestX = Infinity, edgeA = -1, p = start;
    do {
      const q = nx[p];
      const ay = Y[id[p]], by = Y[id[q]];
      if (ay <= my && by >= my && ay < by) {
        const ax = X[id[p]], bx = X[id[q]];
        const x = ax + (my - ay) * (bx - ax) / (by - ay);
        if (x >= mx && x < bestX) { bestX = x; edgeA = p; }
      }
      p = q;
    } while (p !== start);
    let P;
    if (edgeA < 0) {
      // no crossing (inconsistent input): the nearest vertex of the loop
      let bd = Infinity;
      P = start;
      p = start;
      do { const d = (X[id[p]] - mx) ** 2 + (Y[id[p]] - my) ** 2; if (d < bd) { bd = d; P = p; } p = nx[p]; } while (p !== start);
    } else {
      const a = edgeA, b = nx[a];
      if (Y[id[a]] === my && X[id[a]] === bestX) P = a;
      else if (Y[id[b]] === my && X[id[b]] === bestX) P = b;
      else P = X[id[a]] > X[id[b]] ? a : b;
      const ix = bestX, iy = my, px = X[id[P]], py = Y[id[P]];
      if (!(px === ix && py === iy)) {
        // reflex vertices inside triangle (M, I, P): take the one closest in angle to the ray
        const sgn = orientXY(mx, my, ix, iy, px, py) >= 0 ? 1 : -1;
        let bestTan = Infinity, bestD = Infinity, best = -1;
        p = start;
        do {
          if (p !== P) {
            const vx = X[id[p]], vy = Y[id[p]];
            if (vx > mx && !(vx === px && vy === py) && orient(pv[p], p, nx[p]) <= 0
              && sgn * orientXY(mx, my, ix, iy, vx, vy) >= 0 && sgn * orientXY(ix, iy, px, py, vx, vy) >= 0
              && sgn * orientXY(px, py, mx, my, vx, vy) >= 0) {
              const tan = Math.abs(vy - my) / (vx - mx), d = (vx - mx) ** 2 + (vy - my) ** 2;
              if (tan < bestTan || (tan === bestTan && d < bestD)) { bestTan = tan; bestD = d; best = p; }
            }
          }
          p = nx[p];
        } while (p !== start);
        if (best >= 0) P = best;
      }
      // a vertex may appear twice (an earlier bridge): use the copy whose wedge contains the bridge
      const px2 = X[id[P]], py2 = Y[id[P]];
      if (!locallyInside(P, mx, my)) {
        p = start;
        do {
          if (p !== P && X[id[p]] === px2 && Y[id[p]] === py2 && locallyInside(p, mx, my)) { P = p; break; }
          p = nx[p];
        } while (p !== start);
      }
    }
    // splice: P → M → hole … → M' → P' → (old next of P)
    const M2 = nNodes++, P2 = nNodes++;
    id[M2] = id[M]; id[P2] = id[P];
    const Pn = nx[P], Mp = pv[M];
    nx[P] = M; pv[M] = P;
    nx[Mp] = M2; pv[M2] = Mp;
    nx[M2] = P2; pv[P2] = M2;
    nx[P2] = Pn; pv[Pn] = P2;
    count += h.m + 2;
  }

  // ---- ear clipping
  const out = [];
  const emit = (a, b, c) => {
    if (!(orient(a, b, c) > 0)) return;
    if (flip) out.push(id[a], id[c], id[b]); else out.push(id[a], id[b], id[c]);
  };
  // non-convex nodes, kept in a compact list
  const isNC = new Uint8Array(nNodes), pos = new Int32Array(nNodes).fill(-1), nc = [];
  const setNC = (k, on) => {
    if (on && pos[k] < 0) { pos[k] = nc.length; nc.push(k); isNC[k] = 1; } else if (!on && pos[k] >= 0) {
      const last = nc.pop();
      if (last !== k) { nc[pos[k]] = last; pos[last] = pos[k]; }
      pos[k] = -1; isNC[k] = 0;
    }
  };
  {
    let p = start;
    do { if (!convex(p)) setNC(p, true); p = nx[p]; } while (p !== start);
  }
  // An ear may not hold a non-convex vertex inside it or on its edges; copies of its own corners (bridge
  // duplicates) do not count. (A strictly-inside test alone accepts an ear whose diagonal runs through a reflex
  // vertex, which then lets a later ear overlap the outside of the polygon.)
  const isEar = (k) => {
    const a = pv[k], c = nx[k];
    const ax = X[id[a]], ay = Y[id[a]], bx = X[id[k]], by = Y[id[k]], cx = X[id[c]], cy = Y[id[c]];
    for (let j = 0; j < nc.length; j++) {
      const r = nc[j];
      if (r === a || r === c || r === k) continue;
      const rx = X[id[r]], ry = Y[id[r]];
      if ((rx === ax && ry === ay) || (rx === bx && ry === by) || (rx === cx && ry === cy)) continue;
      if (orientXY(ax, ay, bx, by, rx, ry) >= -eps && orientXY(bx, by, cx, cy, rx, ry) >= -eps && orientXY(cx, cy, ax, ay, rx, ry) >= -eps) return false;
    }
    return true;
  };
  const remove = (k) => {
    const a = pv[k], c = nx[k];
    nx[a] = c; pv[c] = a;
    setNC(k, false);
    if (k === start) start = c;
    count--;
    setNC(a, !convex(a));
    setNC(c, !convex(c));
    return c;
  };
  let k = start, stall = 0;
  while (count > 3) {
    if (!isNC[k] && isEar(k)) {
      emit(pv[k], k, nx[k]);
      k = remove(k);
      stall = 0;
      continue;
    }
    k = nx[k];
    if (++stall > count) {
      // no ear: clip the most convex vertex (degenerate or self-touching input)
      let best = k, bestO = -Infinity, p = k;
      do { const o = orient(pv[p], p, nx[p]); if (o > bestO) { bestO = o; best = p; } p = nx[p]; } while (p !== k);
      emit(pv[best], best, nx[best]);
      k = remove(best);
      stall = 0;
    }
  }
  if (count === 3) emit(pv[k], k, nx[k]);
  return Uint32Array.from(out);
}
