// Analytic coaxial-chain test-particle Monte Carlo (spec §2.11, §3.6.2). Ported from our design prototype
// cond-proto2/chain-proto.mjs: cells with analytic walls (cylinder, cone, annulus rod, rectangle planes, a 90°
// mitered elbow traced as two legs), junction plates, cosine emission, diffuse re-emission, and an outlet that
// absorbs with a sticking probability (a pump). Intersections use numerically stable quadratic roots.
// Each block is traced in normalized units (lengths divided by its largest transverse half-size): transmission
// probabilities are scale-free, and the tolerances below are then relative.
// Pure module: no DOM; runs in the page, in workers and in Node (H7, H8).
import { makeRng, getSampler } from './rng.js';

const TWO_PI = 2 * Math.PI;
const EPS = 1e-12;                       // smallest accepted root (normalized units)
const T_TUBE = 0, T_CONE = 1, T_ANN = 2, T_RECT = 3, T_ELBOW = 4;
const TYPE_CODE = { tube: T_TUBE, cone: T_CONE, annulus: T_ANN, rect: T_RECT, elbow: T_ELBOW };

// ---------------------------------------------------------------- apertures (centred on the axis)

/** True when (u, v) lies inside the aperture; a null aperture does not restrict. */
export function apInside(ap, u, v) {
  if (!ap) return true;
  if (ap.kind === 'disc') return u * u + v * v <= ap.r * ap.r;
  if (ap.kind === 'ring') { const q = u * u + v * v; return q <= ap.ro * ap.ro && q >= ap.ri * ap.ri; }
  return Math.abs(u) <= ap.a / 2 && Math.abs(v) <= ap.b / 2;
}

/** Area of an aperture (m² in the caller's units). */
export function apArea(ap) {
  if (ap.kind === 'disc') return Math.PI * ap.r * ap.r;
  if (ap.kind === 'ring') return Math.PI * (ap.ro * ap.ro - ap.ri * ap.ri);
  return ap.a * ap.b;
}

// area of { x² + y² ≤ r², 0 ≤ x ≤ X, 0 ≤ y ≤ Y }
function quarterDiscRect(r, X, Y) {
  X = Math.min(X, r); Y = Math.min(Y, r);
  if (!(X > 0) || !(Y > 0)) return 0;
  if (X * X + Y * Y <= r * r) return X * Y;
  const F = (x) => 0.5 * (x * Math.sqrt(Math.max(r * r - x * x, 0)) + r * r * Math.asin(Math.min(1, x / r)));
  const xc = Math.sqrt(Math.max(r * r - Y * Y, 0));
  return Y * xc + F(X) - F(xc);
}
function discRectArea(r, a, b) { return 4 * quarterDiscRect(r, a / 2, b / 2); }

/** Area of the intersection of two centred apertures (either may be null = no restriction). */
export function apIntersectArea(p, q) {
  if (!p && !q) return Infinity;
  if (!q) return apArea(p);
  if (!p) return apArea(q);
  if (p.kind === 'rect' && q.kind !== 'rect') [p, q] = [q, p];
  const ringOf = (x) => (x.kind === 'disc' ? { ri: 0, ro: x.r } : { ri: x.ri, ro: x.ro });
  if (p.kind !== 'rect' && q.kind !== 'rect') {
    const a = ringOf(p), b = ringOf(q);
    const ro = Math.min(a.ro, b.ro), ri = Math.max(a.ri, b.ri);
    return ro > ri ? Math.PI * (ro * ro - ri * ri) : 0;
  }
  if (p.kind === 'rect' && q.kind === 'rect') return Math.min(p.a, q.a) * Math.min(p.b, q.b);
  // p is a disc or ring, q a rectangle
  const a = ringOf(p);
  return discRectArea(a.ro, q.a, q.b) - (a.ri > 0 ? discRectArea(a.ri, q.a, q.b) : 0);
}

function scaleAp(ap, s) {
  if (!ap) return null;
  if (ap.kind === 'disc') return { kind: 'disc', r: ap.r * s };
  if (ap.kind === 'ring') return { kind: 'ring', ri: ap.ri * s, ro: ap.ro * s };
  if (ap.kind === 'rect') return { kind: 'rect', a: ap.a * s, b: ap.b * s };
  throw new RangeError('Unknown aperture kind "' + ap.kind + '".');
}
function apHalfSize(ap) {
  if (!ap) return 0;
  if (ap.kind === 'disc') return ap.r;
  if (ap.kind === 'ring') return ap.ro;
  return Math.max(ap.a, ap.b) / 2;
}

// ---------------------------------------------------------------- cells and blocks

/** Inlet and outlet apertures of a cell spec. */
export function cellApertures(c) {
  switch (c.type) {
    case 'tube': case 'elbow': return { apIn: { kind: 'disc', r: c.R }, apOut: { kind: 'disc', r: c.R } };
    case 'cone': return { apIn: { kind: 'disc', r: c.R1 }, apOut: { kind: 'disc', r: c.R2 } };
    case 'annulus': { const ap = { kind: 'ring', ri: c.Ri, ro: c.Ro }; return { apIn: ap, apOut: ap }; }
    case 'rect': { const ap = { kind: 'rect', a: c.a, b: c.b }; return { apIn: ap, apOut: ap }; }
    default: throw new RangeError('Unknown cell type "' + c.type + '".');
  }
}

/** Mirror image of a block, launched from its outlet (the geometry is the same; §2.11 reverseBlock). */
export function mirrorBlock(block) {
  if (block.outlet && !(block.outlet.stick >= 1)) {
    throw new RangeError('A block with a pump outlet cannot be launched from its outlet.');
  }
  const cells = block.cells.slice().reverse().map((c) => {
    if (c.type === 'cone') return { type: 'cone', R1: c.R2, R2: c.R1, L: c.L };
    if (c.type === 'elbow') return { type: 'elbow', R: c.R, A: c.B, B: c.A };
    return { ...c };
  });
  const n = block.cells.length, pl = block.plates || [];
  const plates = [];
  for (let j = 0; j <= n; j++) plates.push(pl[n - j] ? { ...pl[n - j] } : null);
  return { ...block, cells, plates, outlet: null, Ain: block.Aout, Aout: block.Ain, reversed: !block.reversed };
}

/**
 * A Block (§2.11) from cells, plates and an outlet, with A_in = area(P₀ ∩ apIn₀) and A_out = area(P_n ∩ apOut_last).
 * plates may be shorter than cells.length + 1 (missing entries are null).
 */
export function makeBlock({ id = 0, label = '', cells, plates = [], outlet = null, ...rest }) {
  const n = cells.length;
  const pl = [];
  for (let j = 0; j <= n; j++) pl.push(plates[j] || null);
  let Ain, Aout;
  if (n === 0) { Ain = Aout = apArea(pl[0]); }
  else {
    Ain = apIntersectArea(pl[0], cellApertures(cells[0]).apIn);
    Aout = apIntersectArea(pl[n], cellApertures(cells[n - 1]).apOut);
  }
  return { ...rest, id, label, cells: cells.map((c) => ({ ...c })), plates: pl, outlet: outlet ? { ...outlet } : null, Ain, Aout };
}

function compileChain(block) {
  const specs = block.cells || [];
  const n = specs.length;
  const platesIn = block.plates || [];
  if (n === 0 && !platesIn[0]) throw new RangeError('A block needs at least one cell or one aperture.');
  // scale: largest transverse half-size
  let H = 0;
  for (const c of specs) {
    const { apIn, apOut } = cellApertures(c);
    H = Math.max(H, apHalfSize(apIn), apHalfSize(apOut));
  }
  for (let j = 0; j <= n; j++) H = Math.max(H, apHalfSize(platesIn[j]));
  if (!(H > 0) || !Number.isFinite(H)) throw new RangeError('A block has no positive size.');
  const s = 1 / H;
  const pos = (x, what) => {
    if (!(x > 0) || !Number.isFinite(x)) throw new RangeError('Every ' + what + ' must be a positive length.');
    return x * s;
  };
  const cells = specs.map((c) => {
    const t = TYPE_CODE[c.type];
    if (t === undefined) throw new RangeError('Unknown cell type "' + c.type + '".');
    const k = { t, type: c.type, R: 0, R1: 0, R2: 0, kc: 0, Ri: 0, Ro: 0, ha: 0, hb: 0, A: 0, B: 0, L: 0, apIn: null, apOut: null };
    switch (t) {
      case T_TUBE: k.R = pos(c.R, 'radius'); k.L = pos(c.L, 'length'); break;
      case T_CONE: k.R1 = pos(c.R1, 'radius'); k.R2 = pos(c.R2, 'radius'); k.L = pos(c.L, 'length'); k.kc = (k.R2 - k.R1) / k.L; break;
      case T_ANN:
        k.Ro = pos(c.Ro, 'radius'); k.Ri = pos(c.Ri, 'radius'); k.L = pos(c.L, 'length');
        if (!(k.Ri < k.Ro)) throw new RangeError('The rod must be thinner than the bore.');
        break;
      case T_RECT: k.ha = pos(c.a, 'side') / 2; k.hb = pos(c.b, 'side') / 2; k.L = pos(c.L, 'length'); break;
      case T_ELBOW:
        k.R = pos(c.R, 'radius'); k.A = pos(c.A, 'leg'); k.B = pos(c.B, 'leg');
        if (k.A < k.R * (1 - 1e-12) || k.B < k.R * (1 - 1e-12)) throw new RangeError('Each elbow leg must be at least the bore radius.');
        break;
    }
    const ap = cellApertures(c);
    k.apIn = scaleAp(ap.apIn, s); k.apOut = scaleAp(ap.apOut, s);
    return k;
  });
  const plates = [];
  for (let j = 0; j <= n; j++) plates.push(scaleAp(platesIn[j] || null, s));
  // source region P₀ ∩ apIn₀: sample the smaller aperture, reject outside the other
  let srcA = plates[0], srcB = n ? cells[0].apIn : null;
  if (!srcA) { srcA = srcB; srcB = null; }
  else if (srcB && apArea(srcB) < apArea(srcA)) { const t = srcA; srcA = srcB; srcB = t; }
  const srcAreaN = apIntersectArea(srcA, srcB);
  // an empty source region would make the rejection loop spin forever
  if (!(srcAreaN > 0)) throw new RangeError('The opening at the start of this section is completely blocked, so no particle can enter it.');
  const stick = block.outlet ? block.outlet.stick : 1;
  if (!(stick >= 0 && stick <= 1)) throw new RangeError('The outlet sticking probability must be between 0 and 1.');
  return { n, cells, plates, stick, srcA, srcB, scale: s, srcArea: srcAreaN / (s * s) };
}

/**
 * Compiles a Block for tracing: frames, normalized apertures and the source sampler. The mirrored chain for
 * launches from the outlet is compiled lazily (cb.reversedChain()).
 */
export function compileBlock(block) {
  const fwd = compileChain(block);
  let rev = null;
  const cb = {
    block, fwd,
    reversible: !block.outlet || block.outlet.stick >= 1,
    reversedChain() {
      if (!this.reversible) throw new RangeError('A block with a pump outlet cannot be launched from its outlet.');
      if (!rev) rev = compileChain(mirrorBlock(block));
      return rev;
    },
  };
  return cb;
}

function sampleAperture(ap, rng, out) {
  if (ap.kind === 'rect') { out[0] = (rng() - 0.5) * ap.a; out[1] = (rng() - 0.5) * ap.b; return; }
  let r;
  if (ap.kind === 'disc') r = ap.r * Math.sqrt(rng());
  else r = Math.sqrt(ap.ri * ap.ri + rng() * (ap.ro * ap.ro - ap.ri * ap.ri));
  const ph = TWO_PI * rng();
  out[0] = r * Math.cos(ph); out[1] = r * Math.sin(ph);
}

/**
 * Traces n particles through a compiled block (§3.6.2).
 * opts = { reverse: false, sampler: 'cosine' | 'asin' | 'uniform', maxBounces: 1e7 }.
 * Returns { n, trans, back, stuck, casts, src }: n excludes stuck particles (bounce cap reached).
 */
export function runChainBlock(cb, n, seed, opts = {}) {
  const reverse = !!opts.reverse;
  const ch = reverse ? cb.reversedChain() : cb.fwd;
  const dirFn = getSampler(opts.sampler);
  const maxB = opts.maxBounces ?? 1e7;
  const rng = makeRng(seed);
  const D = new Float64Array(3), UV = new Float64Array(2);
  const cells = ch.cells, plates = ch.plates, nC = ch.n, stick = ch.stick;
  const lastPlate = plates[nC];
  let trans = 0, back = 0, stuck = 0, casts = 0;
  n = Math.max(0, Math.floor(n));

  if (nC === 0) {            // a lone aperture: every particle passes; a partial outlet absorbs with `stick`
    for (let p = 0; p < n; p++) { if (stick >= 1 || rng() < stick) trans++; else back++; }
    return { n, trans, back, stuck: 0, casts: 0, src: reverse ? 'out' : 'in' };
  }

  for (let p = 0; p < n; p++) {
    // ---- emission: uniform over P₀ ∩ apIn₀, cosine about +z
    for (;;) { sampleAperture(ch.srcA, rng, UV); if (apInside(ch.srcB, UV[0], UV[1])) break; }
    let px = UV[0], py = UV[1], pz = 0;
    dirFn(rng, 0, 0, 1, D);
    let dx = D[0], dy = D[1], dz = D[2];
    let ci = 0, c = cells[0], leg = 0;
    let done = false;
    for (let b = 0; ; b++) {
      if (b > maxB) { stuck++; break; }
      casts++;
      // ---- elbow leg from the position (robust at the miter plane)
      if (c.t === T_ELBOW) {
        const sd0 = px + pz - c.A, tiny = 1e-12 * (1 + c.A);
        leg = sd0 > tiny ? 1 : sd0 < -tiny ? 0 : (dx + dz > 0 ? 1 : 0);
      }
      // ---- wall
      let tw = Infinity, wk = 0;   // wk: which wall (annulus: 1 = rod; rect: 1 = x walls, 2 = y walls)
      switch (c.t) {
        case T_TUBE: {
          const A = dx * dx + dy * dy;
          if (A > 1e-300) {
            const B = px * dx + py * dy, C = px * px + py * py - c.R * c.R;
            const sq = Math.sqrt(Math.max(B * B - A * C, 0));
            tw = B > 0 ? -C / (B + sq) : (sq - B) / A;
            if (!(tw > 0)) tw = 0;
          }
          break;
        }
        case T_CONE: {
          const kc = c.kc, r0 = c.R1 + kc * pz;
          const A = dx * dx + dy * dy - kc * kc * dz * dz, B = px * dx + py * dy - r0 * kc * dz, C = px * px + py * py - r0 * r0;
          const disc = B * B - A * C;
          if (disc >= 0) {
            const sq = Math.sqrt(disc), q = -(B + (B >= 0 ? sq : -sq));
            const t1 = q / A, t2 = C / q;
            if (t1 > EPS && t1 < tw && c.R1 + kc * (pz + t1 * dz) > 0) tw = t1;
            if (t2 > EPS && t2 < tw && c.R1 + kc * (pz + t2 * dz) > 0) tw = t2;
          }
          break;
        }
        case T_ANN: {
          const A = dx * dx + dy * dy;
          if (A > 1e-300) {
            const B = px * dx + py * dy, C0 = px * px + py * py;
            const Co = C0 - c.Ro * c.Ro;
            const sq = Math.sqrt(Math.max(B * B - A * Co, 0));
            tw = B > 0 ? -Co / (B + sq) : (sq - B) / A;
            if (!(tw > 0)) tw = 0;
            if (B < 0) {
              const Ci = C0 - c.Ri * c.Ri, di = B * B - A * Ci;
              if (di >= 0) {
                let ti = Ci / (-B + Math.sqrt(di));
                if (!(ti > 0)) ti = 0;
                if (ti < tw) { tw = ti; wk = 1; }
              }
            }
          }
          break;
        }
        case T_RECT: {
          let tx = dx > 0 ? (c.ha - px) / dx : dx < 0 ? (-c.ha - px) / dx : Infinity;
          let ty = dy > 0 ? (c.hb - py) / dy : dy < 0 ? (-c.hb - py) / dy : Infinity;
          if (tx < 0) tx = 0;
          if (ty < 0) ty = 0;
          if (tx <= ty) { tw = tx; wk = 1; } else { tw = ty; wk = 2; }
          break;
        }
        case T_ELBOW: {
          const u = leg === 0 ? px : pz - c.A, du = leg === 0 ? dx : dz;
          const A = du * du + dy * dy;
          if (A > 1e-300) {
            const B = u * du + py * dy, C = u * u + py * py - c.R * c.R;
            const sq = Math.sqrt(Math.max(B * B - A * C, 0));
            tw = B > 0 ? -C / (B + sq) : (sq - B) / A;
            if (!(tw > 0)) tw = 0;
          }
          break;
        }
      }
      // ---- planes: miter (elbow), inlet z = 0, outlet
      let tm = Infinity, tin = Infinity, tout = Infinity;
      if (c.t === T_ELBOW) {
        const sd = dx + dz;
        if (leg === 0) {
          if (sd > 0) tm = Math.max(0, (c.A - px - pz) / sd);
          if (dz < 0) tin = Math.max(0, -pz / dz);
        } else {
          if (sd < 0) tm = Math.max(0, (c.A - px - pz) / sd);
          if (dx > 0) tout = Math.max(0, (c.B - px) / dx);
        }
      } else if (dz < 0) tin = Math.max(0, -pz / dz);
      else if (dz > 0) tout = Math.max(0, (c.L - pz) / dz);

      if (tw <= tm && tw <= tin && tw <= tout) {
        // ---- wall hit: move, project onto the surface, re-emit diffusely about the inward normal
        px += tw * dx; py += tw * dy; pz += tw * dz;
        let nx = 0, ny = 0, nz = 0;
        switch (c.t) {
          case T_TUBE: { const rr = Math.sqrt(px * px + py * py), f = c.R / rr; px *= f; py *= f; nx = -px / c.R; ny = -py / c.R; break; }
          case T_CONE: {
            const rz = c.R1 + c.kc * pz, rr = Math.sqrt(px * px + py * py), f = rz / rr;
            px *= f; py *= f;
            nx = -px; ny = -py; nz = rz * c.kc;
            const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz); nx *= l; ny *= l; nz *= l;
            break;
          }
          case T_ANN: {
            const rr = Math.sqrt(px * px + py * py);
            if (wk === 1) { const f = c.Ri / rr; px *= f; py *= f; nx = px / c.Ri; ny = py / c.Ri; }
            else { const f = c.Ro / rr; px *= f; py *= f; nx = -px / c.Ro; ny = -py / c.Ro; }
            break;
          }
          case T_RECT:
            if (wk === 1) { if (dx > 0) { px = c.ha; nx = -1; } else { px = -c.ha; nx = 1; } }
            else { if (dy > 0) { py = c.hb; ny = -1; } else { py = -c.hb; ny = 1; } }
            break;
          case T_ELBOW:
            if (leg === 0) { const rr = Math.sqrt(px * px + py * py), f = c.R / rr; px *= f; py *= f; nx = -px / c.R; ny = -py / c.R; }
            else {
              const w = pz - c.A, rr = Math.sqrt(w * w + py * py), f = c.R / rr;
              const ws = w * f; py *= f; pz = c.A + ws; ny = -py / c.R; nz = -ws / c.R;
            }
            break;
        }
        dirFn(rng, nx, ny, nz, D); dx = D[0]; dy = D[1]; dz = D[2];
        continue;
      }
      if (tm <= tin && tm <= tout) {
        // ---- miter crossing: the leg is re-derived from the position on the next step
        px += tm * dx; py += tm * dy; pz += tm * dz;
        continue;
      }
      if (tout <= tin) {
        // ---- outlet plane of cell ci
        let u, v, du, dv, dw;
        if (c.t === T_ELBOW) {
          py += tout * dy; pz += tout * dz; px = c.B;
          u = c.A - pz; v = py; du = -dz; dv = dy; dw = dx;
        } else {
          px += tout * dx; py += tout * dy; pz = c.L;
          u = px; v = py; du = dx; dv = dy; dw = dz;
        }
        if (ci === nC - 1) {
          if (apInside(lastPlate, u, v) && (stick >= 1 || rng() < stick)) { trans++; done = true; break; }
        } else {
          const nx = cells[ci + 1];
          if (apInside(plates[ci + 1], u, v) && apInside(nx.apIn, u, v)) {
            ci++; c = nx; leg = 0;
            px = u; py = v; pz = 0; dx = du; dy = dv; dz = dw;
            continue;
          }
        }
        // blocked by a plate or a step wall, or reflected by the pump: re-emit back into this cell
        if (c.t === T_ELBOW) dirFn(rng, -1, 0, 0, D); else dirFn(rng, 0, 0, -1, D);
        dx = D[0]; dy = D[1]; dz = D[2];
        continue;
      }
      // ---- inlet plane z = 0 of cell ci, moving backward
      px += tin * dx; py += tin * dy; pz = 0;
      if (ci === 0) {
        if (apInside(plates[0], px, py)) { back++; done = true; break; }
      } else {
        const pv = cells[ci - 1];
        if (apInside(plates[ci], px, py) && apInside(pv.apOut, px, py)) {
          const x = px, y = py;
          ci--; c = pv;
          if (pv.t === T_ELBOW) {
            // exit frame of an elbow: c_out = (B, 0, A), e_u = −z, e_v = y, n = x
            px = pv.B; py = y; pz = pv.A - x;
            const ndx = dz, ndz = -dx; dx = ndx; dz = ndz;
            leg = 1;
          } else {
            px = x; py = y; pz = pv.L;
          }
          continue;
        }
      }
      dirFn(rng, 0, 0, 1, D); dx = D[0]; dy = D[1]; dz = D[2];
    }
    if (!done) { /* stuck: excluded from n */ }
  }
  return { n: n - stuck, trans, back, stuck, casts, src: reverse ? 'out' : 'in' };
}
