// Ports and the Monte Carlo scene (spec §2.12, §2.16, §3.6.4 steps 4–8). A port is either a set of boundary loops
// (an outer loop with its holes, capped by ear clipping in its own plane) or a region of mesh triangles picked in
// the viewer. Cap triangles are appended after the prepared mesh's triangles and wound against the mesh's boundary
// edges, so a consistently wound open mesh becomes a consistently wound closed one. buildScene then builds the BVH
// (bvh.buildBVH, WP2) and the MeshScene that mesh-mc.js traces.
//
// Inward normal of each port (§3.6.4 step 7):
//   - closed, consistently wound mesh after capping: the signed volume Σ v0·(v1 × v2)/6 fixes the orientation
//     (positive = outward normals); the inward normal is minus the port's outward normal;
//   - otherwise: 16 jittered rays from interior points of the port along +n and −n; the side whose rays hit the
//     mesh (beyond 1e-6·diag) more often is inside. A tie blocks the run with a readable message.
// Pure module: no DOM; runs in the page, in workers and in Node (H7, H8). SI units.
import { buildBVH, makeTracer } from './bvh.js';
import { triangulatePolygon } from './triangulate.js';
import { meshTopology, boundaryLoops, loopProperties, projectLoop, autoPortsOf } from './mesh.js';

const ROLES = ['inlet', 'outlet', 'pump', 'closed'];

function fail(message) { throw new RangeError(message); }
const portLabel = (p, i) => (p && typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'Opening ' + (i + 1));
const fmtSpeed = (s) => String(Number((s * 1000).toPrecision(4))) + ' L/s';

/**
 * Default ports of a prepared mesh: one loop port per opening (outer loop plus holes); the largest is the inlet,
 * the others are outlets (§3.6.4 step 8). A closed solid has none.
 */
export function autoPorts(mesh, report) {
  return autoPortsOf(mesh, report);
}

// Deterministic generator for the inside test: xorshift32 (G. Marsaglia, "Xorshift RNGs", J. Stat. Softw. 8(14),
// 2003), enough to jitter a few rays.
function rng32(seed) {
  let x = (seed >>> 0) || 0x9e3779b9;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/**
 * Builds the Monte Carlo scene of a prepared mesh with its ports (§2.12).
 *   ports: PortSpec[] ({ id, name, kind: 'loop' | 'region', loops, tris, role, stick, speed }); every flat boundary
 *          loop must belong to one port (role 'closed' makes it a wall).
 *   G:     GasState, needed only to turn a pump port's speed (m³/s) into stick = speed/(area·vbar/4).
 * Returns { scene: MeshScene, capPositions: Float32Array (cap triangles, 9 numbers each, after the mesh's
 * triangles), triPort: Int16Array (per triangle of mesh + caps: the PortSpec id, or −1 for walls) }.
 * In the scene, port[slot] is the index into scene.ports (closed ports are walls and are not listed).
 */
export function buildScene(mesh, ports, G) {
  if (!mesh || !mesh.vertices || !mesh.tris) fail('There is no prepared mesh.');
  if (!Array.isArray(ports)) fail('The openings must be given as a list.');
  const T = meshTopology(mesh);
  const V = mesh.vertices, tris = mesh.tris, nT = T.nT;
  const loops = loopProperties(mesh, Number.isFinite(mesh.weldTol) ? mesh.weldTol : null);
  const raw = boundaryLoops(mesh);
  const nL = loops.length;

  // ---- check the port list
  const ids = new Set();
  const loopOwner = new Int32Array(nL).fill(-1), triOwner = new Int32Array(nT).fill(-1);
  ports.forEach((p, pi) => {
    if (!p || typeof p !== 'object') fail('Opening ' + (pi + 1) + ' is not described.');
    const name = portLabel(p, pi);
    if (!(Number.isInteger(p.id) && p.id >= 0 && p.id <= 32767)) fail('Opening "' + name + '" needs a whole-number id from 0 to 32767.');
    if (ids.has(p.id)) fail('Two openings have the id ' + p.id + '.');
    ids.add(p.id);
    if (!ROLES.includes(p.role)) fail('Opening "' + name + '" needs a role: inlet, outlet, pump or closed.');
    if (p.kind === 'loop') {
      if (!Array.isArray(p.loops) || !p.loops.length) fail('Opening "' + name + '" lists no edge loops.');
      for (const grp of p.loops) {
        if (!grp || !(grp.length >= 1)) fail('Opening "' + name + '" has an empty group of edge loops.');
        for (let k = 0; k < grp.length; k++) {
          const lid = grp[k];
          if (!(Number.isInteger(lid) && lid >= 0 && lid < nL)) fail('Opening "' + name + '" refers to edge loop ' + lid + ', which does not exist.');
          if (!loops[lid].planar) fail('Opening "' + name + '" is not flat, so it cannot be closed with a cap.');
          if (loopOwner[lid] >= 0) fail('Edge loop ' + lid + ' belongs to two openings ("' + portLabel(ports[loopOwner[lid]], loopOwner[lid]) + '" and "' + name + '").');
          loopOwner[lid] = pi;
        }
      }
    } else if (p.kind === 'region') {
      const tl = p.tris;
      if (!tl || !(tl.length > 0)) fail('Opening "' + name + '" has no triangles.');
      for (let k = 0; k < tl.length; k++) {
        const t = tl[k];
        if (!(Number.isInteger(t) && t >= 0 && t < nT)) fail('Opening "' + name + '" refers to triangle ' + t + ', which does not exist.');
        if (triOwner[t] >= 0) fail('Triangle ' + t + ' belongs to two openings ("' + portLabel(ports[triOwner[t]], triOwner[t]) + '" and "' + name + '").');
        triOwner[t] = pi;
      }
    } else {
      fail('Opening "' + name + '" must be an edge loop or a selected region.');
    }
  });
  for (let l = 0; l < nL; l++) {
    if (loops[l].planar && loopOwner[l] < 0) fail('An opening has no role yet (edge loop ' + l + '). Give every opening a role; choose Closed to make it a wall.');
  }

  // ---- caps
  const capV = [], capOwner = [];
  ports.forEach((p, pi) => {
    if (p.kind !== 'loop') return;
    for (const grp of p.loops) {
      const outer = loops[grp[0]], nrm = outer.normal;
      const o2 = projectLoop(V, outer.vertices, nrm);
      const holes = grp.slice(1).map((lid) => projectLoop(V, loops[lid].vertices, nrm));
      const idx = triangulatePolygon(o2, holes);
      const map = [];
      for (const v of outer.vertices) map.push(v);
      for (const lid of grp.slice(1)) for (const v of loops[lid].vertices) map.push(v);
      const xy = new Float64Array(2 * map.length);
      xy.set(o2, 0);
      let off = o2.length;
      for (const h of holes) { xy.set(h, off); off += h.length; }
      const area2 = (pts) => { let s = 0; const n = pts.length / 2; for (let i = 0, j = n - 1; i < n; j = i++) s += (pts[2 * j] - pts[2 * i]) * (pts[2 * j + 1] + pts[2 * i + 1]); return Math.abs(s / 2); };
      const expect = area2(o2) - holes.reduce((s, h) => s + area2(h), 0);
      let got = 0;
      for (let k = 0; k < idx.length; k += 3) {
        const a = idx[k], b = idx[k + 1], c = idx[k + 2];
        got += Math.abs((xy[2 * b] - xy[2 * a]) * (xy[2 * c + 1] - xy[2 * a + 1]) - (xy[2 * b + 1] - xy[2 * a + 1]) * (xy[2 * c] - xy[2 * a])) / 2;
        capV.push(map[a], map[c], map[b]);            // reversed: against the mesh's boundary edges
        capOwner.push(pi);
      }
      if (!(Math.abs(got - expect) <= 1e-9 * area2(o2))) fail('Opening "' + portLabel(p, pi) + '" could not be closed: its edge crosses itself or its holes overlap.');
    }
  });

  // ---- one triangle list: the prepared mesh, then the caps
  const nCap = capOwner.length, nAll = nT + nCap;
  const soup = new Float32Array(9 * nAll);
  for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) { const v = 3 * tris[3 * t + k], o = 9 * t + 3 * k; soup[o] = V[v]; soup[o + 1] = V[v + 1]; soup[o + 2] = V[v + 2]; }
  for (let c = 0; c < nCap; c++) for (let k = 0; k < 3; k++) { const v = 3 * capV[3 * c + k], o = 9 * (nT + c) + 3 * k; soup[o] = V[v]; soup[o + 1] = V[v + 1]; soup[o + 2] = V[v + 2]; }
  const sceneIdx = new Int32Array(ports.length).fill(-1);
  let nP = 0;
  ports.forEach((p, pi) => { if (p.role !== 'closed') sceneIdx[pi] = nP++; });
  const triPort = new Int16Array(nAll).fill(-1), portOf = new Int16Array(nAll).fill(-1);
  for (let t = 0; t < nT; t++) if (triOwner[t] >= 0) { triPort[t] = ports[triOwner[t]].id; portOf[t] = sceneIdx[triOwner[t]]; }
  for (let c = 0; c < nCap; c++) { triPort[nT + c] = ports[capOwner[c]].id; portOf[nT + c] = sceneIdx[capOwner[c]]; }

  // ---- BVH and the scene arrays in slot order
  const bvh = buildBVH(soup);
  const tri = new Float32Array(9 * nAll), normal = new Float32Array(3 * nAll), area = new Float64Array(nAll);
  const port = new Int16Array(nAll), origTri = new Uint32Array(nAll);
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let s = 0; s < nAll; s++) {
    const i = bvh.order[s], o = 9 * s;
    for (let k = 0; k < 9; k++) tri[o + k] = soup[9 * i + k];
    origTri[s] = i;
    port[s] = portOf[i];
    const ux = tri[o + 3] - tri[o], uy = tri[o + 4] - tri[o + 1], uz = tri[o + 5] - tri[o + 2];
    const vx = tri[o + 6] - tri[o], vy = tri[o + 7] - tri[o + 1], vz = tri[o + 8] - tri[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    area[s] = l / 2;
    if (l > 0) { normal[3 * s] = nx / l; normal[3 * s + 1] = ny / l; normal[3 * s + 2] = nz / l; }
    for (let k = 0; k < 9; k += 3) {
      const X = tri[o + k], Y = tri[o + k + 1], Z = tri[o + k + 2];
      if (X < x0) x0 = X; if (X > x1) x1 = X;
      if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
      if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
    }
  }
  const diag = Math.hypot(x1 - x0, y1 - y0, z1 - z0);

  // ---- ports: slots, area CDF, centroid, oriented area vector
  const slotLists = Array.from({ length: nP }, () => []);
  for (let s = 0; s < nAll; s++) if (port[s] >= 0) slotLists[port[s]].push(s);
  const scenePorts = [], areaVec = [];
  ports.forEach((p, pi) => {
    const k = sceneIdx[pi];
    if (k < 0) return;
    const sl = slotLists[k];
    if (!sl.length) fail('Opening "' + portLabel(p, pi) + '" has no area.');
    const slots = Uint32Array.from(sl), cdf = new Float64Array(sl.length);
    let tot = 0, cx = 0, cy = 0, cz = 0, ax = 0, ay = 0, az = 0, ref = null;
    sl.forEach((s, j) => {
      tot += area[s];
      cdf[j] = tot;
      const o = 9 * s;
      cx += area[s] * (tri[o] + tri[o + 3] + tri[o + 6]) / 3;
      cy += area[s] * (tri[o + 1] + tri[o + 4] + tri[o + 7]) / 3;
      cz += area[s] * (tri[o + 2] + tri[o + 5] + tri[o + 8]) / 3;
      const nx = normal[3 * s], ny = normal[3 * s + 1], nz = normal[3 * s + 2];
      ax += area[s] * nx; ay += area[s] * ny; az += area[s] * nz;
      if (!ref && area[s] > 0) ref = [nx, ny, nz];
    });
    if (!(tot > 0)) fail('Opening "' + portLabel(p, pi) + '" has no area.');
    // plane normal for the inside test: the triangle normals aligned to the first one
    let px = 0, py = 0, pz = 0;
    for (const s of sl) {
      const nx = normal[3 * s], ny = normal[3 * s + 1], nz = normal[3 * s + 2];
      const sg = ref && nx * ref[0] + ny * ref[1] + nz * ref[2] < 0 ? -1 : 1;
      px += sg * area[s] * nx; py += sg * area[s] * ny; pz += sg * area[s] * nz;
    }
    const pl = Math.hypot(px, py, pz);
    areaVec.push({ oriented: [ax, ay, az], plane: pl > 0 ? [px / pl, py / pl, pz / pl] : [0, 0, 1] });
    scenePorts.push({
      id: p.id, name: portLabel(p, pi), role: p.role, stick: 1, area: tot, inward: [0, 0, 1],
      centroid: [cx / tot, cy / tot, cz / tot], slots, cdf,
    });
  });

  const scene = {
    version: 1, nTri: nAll, tri, normal, area, port, origTri, box: bvh.box, meta: bvh.meta,
    diag, bbox: [x0, y0, z0, x1, y1, z1], ports: scenePorts,
  };

  // ---- inward normals
  let consistent = raw.openChains.length === 0;
  for (let e = 0; e < T.nE && consistent; e++) {
    const c = T.eCount[e];
    if (c > 2) consistent = false;
    else if (c === 2) { const s = T.eStart[e]; if (tris[T.eHe[s]] === tris[T.eHe[s + 1]]) consistent = false; }
  }
  for (let l = 0; l < nL && consistent; l++) if (loopOwner[l] < 0) consistent = false;
  let sign = 0;
  if (consistent) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    let v6 = 0;
    for (let i = 0; i < nAll; i++) {
      const o = 9 * i;
      const ax = soup[o] - cx, ay = soup[o + 1] - cy, az = soup[o + 2] - cz;
      const bx = soup[o + 3] - cx, by = soup[o + 4] - cy, bz = soup[o + 5] - cz;
      const qx = soup[o + 6] - cx, qy = soup[o + 7] - cy, qz = soup[o + 8] - cz;
      v6 += ax * (by * qz - bz * qy) + ay * (bz * qx - bx * qz) + az * (bx * qy - by * qx);
    }
    if (Math.abs(v6) > 1e-9 * diag ** 3) sign = v6 > 0 ? 1 : -1;
  }
  if (sign) {
    scenePorts.forEach((sp, k) => {
      const a = areaVec[k].oriented, l = Math.hypot(a[0], a[1], a[2]);
      sp.inward = l > 0 ? [-sign * a[0] / l + 0, -sign * a[1] / l + 0, -sign * a[2] / l + 0] : areaVec[k].plane.slice();
    });
  } else if (scenePorts.length) {
    const trace = makeTracer(scene);
    const out = new Float64Array(1);
    const minT = 1e-6 * diag;
    const hits = (ox, oy, oz, dx, dy, dz, skip) => {
      for (let tries = 0; tries < 8; tries++) {
        const h = trace(ox, oy, oz, dx, dy, dz, skip, out);
        if (h < 0) return false;
        if (out[0] > minT) return true;
        ox += out[0] * dx; oy += out[0] * dy; oz += out[0] * dz;
        skip = h;
      }
      return false;
    };
    scenePorts.forEach((sp, k) => {
      const n = areaVec[k].plane, rnd = rng32(0x5eed + 7919 * k);
      let plus = 0, minus = 0;
      const total = sp.cdf[sp.cdf.length - 1];
      for (let r = 0; r < 16; r++) {
        const u = rnd() * total;
        let lo = 0, hi = sp.cdf.length - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (sp.cdf[m] < u) lo = m + 1; else hi = m; }
        const s = sp.slots[lo], o = 9 * s;
        // a uniform point of the triangle, pulled 10 % towards its centroid (away from the edges)
        let a = rnd(), b = rnd();
        if (a + b > 1) { a = 1 - a; b = 1 - b; }
        a = 0.9 * a + 0.1 / 3; b = 0.9 * b + 0.1 / 3;
        const ox = tri[o] + a * (tri[o + 3] - tri[o]) + b * (tri[o + 6] - tri[o]);
        const oy = tri[o + 1] + a * (tri[o + 4] - tri[o + 1]) + b * (tri[o + 7] - tri[o + 1]);
        const oz = tri[o + 2] + a * (tri[o + 5] - tri[o + 2]) + b * (tri[o + 8] - tri[o + 2]);
        for (const side of [1, -1]) {
          let dx, dy, dz;
          for (;;) {
            const zz = 2 * rnd() - 1, ph = 2 * Math.PI * rnd(), q = Math.sqrt(1 - zz * zz);
            dx = side * n[0] + 0.25 * q * Math.cos(ph); dy = side * n[1] + 0.25 * q * Math.sin(ph); dz = side * n[2] + 0.25 * zz;
            const l = Math.hypot(dx, dy, dz);
            dx /= l; dy /= l; dz /= l;
            if (side * (dx * n[0] + dy * n[1] + dz * n[2]) > 0.5) break;
          }
          if (hits(ox, oy, oz, dx, dy, dz, s)) { if (side > 0) plus++; else minus++; }
        }
      }
      if (plus === minus) fail('Cannot tell which side of opening "' + sp.name + '" is inside. Close the mesh or check the normals.');
      sp.inward = plus > minus ? n.map((x) => x + 0) : [-n[0] + 0, -n[1] + 0, -n[2] + 0];
    });
  }

  // ---- sticking coefficients
  ports.forEach((p, pi) => {
    const k = sceneIdx[pi];
    if (k < 0) return;
    const sp = scenePorts[k];
    if (p.role !== 'pump') { sp.stick = 1; return; }
    if (p.speed !== null && p.speed !== undefined) {
      const S = Number(p.speed);
      if (!(Number.isFinite(S) && S > 0)) fail('The pumping speed of "' + sp.name + '" must be a positive number.');
      if (!G || !(G.vbar > 0)) fail('The gas data are needed to turn the pumping speed of "' + sp.name + '" into a sticking coefficient.');
      const Smax = sp.area * G.vbar / 4, stick = S / Smax;
      if (stick > 1 + 1e-12) fail('The pumping speed of "' + sp.name + '" (' + fmtSpeed(S) + ') is above the molecular-flow maximum of its opening (' + fmtSpeed(Smax) + ').');
      sp.stick = Math.min(stick, 1);
    } else {
      const st = Number(p.stick);
      if (!(Number.isFinite(st) && st > 0 && st <= 1)) fail('The sticking coefficient of "' + sp.name + '" must be above 0 and at most 1.');
      sp.stick = st;
    }
  });

  return { scene, capPositions: soup.slice(9 * nT), triPort };
}
