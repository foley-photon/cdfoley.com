// Built-in test geometries of the CAD tab (spec §7.4, Appendix B.2). Every round cross-section is an n-gon
// (n = 64 by default) with the area-preserving radius R_p = R·√(2π/(n·sin(2π/n))), so the polygon has the area of
// the round tube; axial segments are about as long as the circumferential ones (2πR/n). All walls are wound with
// their normals pointing out of the gas, and shared seams reuse the same computed vertices, so each mesh is
// watertight by construction and only its openings are open. Positions are in metres (Float32Array, 9 numbers
// per triangle). The suggested ports name each built-in's own roles (for the cone, the small end is the inlet,
// as its reference value is referred to the small end).
// Pure module: no DOM; runs in the page, in workers and in Node (H7, H8).
import { prepareMesh } from './mesh.js';

const TWO_PI = 2 * Math.PI;
const DEG = Math.PI / 180;
const apFactor = (n) => Math.sqrt(TWO_PI / (n * Math.sin(TWO_PI / n)));

function fail(message) { throw new RangeError(message); }

const REF = {
  tube: { alpha: 0.1909424, sigma: 0, source: 'Integral equation (this work; equals Matuda 2015, Table 1), L/R = 10' },
  elbow: { alpha: 0.26524, sigma: 0.00021, source: 'TPMC of this work (90° elbow, A = B = 3R, 4.6·10⁶ particles); formula 0.26486' },
  cone: { alpha: 0.837679, sigma: 0.0003687450243176171, source: 'TPMC (research): cone β = 20°, L/R₁ = 2, referred to the small end; NASA TN D-2330: 0.834' },
  annulus: { alpha: 0.52877, sigma: 0.00035, source: 'TPMC (research): annulus Ri/Ro = 0.5, L/gap = 2; Berman 0.5295' },
  rect: { alpha: 0.53622, sigma: 0.00035, source: 'TPMC (research): square duct, L/a = 1; Santeler & Boeckmann 0.5363' },
  // test-only geometries
  tube16: {
    // C_16gon = (1 − 0.0351)·C_round, referred to the 16-gon's own area (16/2)·R²·sin(2π/16)
    alpha: 0.1909424 * (Math.PI / (8 * Math.sin(TWO_PI / 16))) * (1 - 0.0351), sigma: 0,
    source: 'Faceting study of this work (research §3.6): an inscribed 16-gon tube, L/R = 10, conducts 3.51 % less than the round tube',
  },
  coneConv: { alpha: 0.04941, sigma: 0.00015, source: 'TPMC (research): converging cone β = −10°, L/R₁ = 4, referred to the large end' },
  pumpTube: {
    // S_eff = 188.0 ± 0.3 L/s of air at 20 °C with a 300 L/s pump: alpha = S/(A·vbar/4), vbar(air, 293.15 K) = 462.911 m/s
    alpha: 0.188 / (Math.PI * 0.05 * 0.05 * 462.911 / 4), sigma: 0.0003 / (Math.PI * 0.05 * 0.05 * 462.911 / 4),
    source: 'Livesey (1998) p. 100: 188 L/s for a 300 L/s pump on this tube (air, 20 °C); TPMC of this work 188.0 ± 0.3 L/s',
  },
};

/** The built-in geometries: name → { label, params (metres), reference: { alpha, sigma, source }, testOnly? }. */
export const BUILTINS = Object.freeze({
  tube: Object.freeze({ label: 'Tube Ø40 × 200 mm', params: Object.freeze({ d: 0.04, L: 0.2, n: 64 }), reference: Object.freeze(REF.tube) }),
  elbow: Object.freeze({ label: '90° elbow, Ø40 mm, legs 60 mm', params: Object.freeze({ d: 0.04, A: 0.06, B: 0.06, n: 64 }), reference: Object.freeze(REF.elbow) }),
  cone: Object.freeze({ label: 'Cone Ø40 to Ø69.1 mm, 40 mm long (20°)', params: Object.freeze({ R1: 0.02, R2: 0.02 + 0.04 * Math.tan(20 * DEG), L: 0.04, n: 64 }), reference: Object.freeze(REF.cone) }),
  annulus: Object.freeze({ label: 'Annulus: Ø40 mm bore, Ø20 mm rod, 20 mm long', params: Object.freeze({ Ro: 0.02, Ri: 0.01, L: 0.02, n: 64 }), reference: Object.freeze(REF.annulus) }),
  rect: Object.freeze({ label: 'Square duct 20 × 20 × 20 mm', params: Object.freeze({ a: 0.02, b: 0.02, L: 0.02, grid: 16 }), reference: Object.freeze(REF.rect) }),
  tube16: Object.freeze({ label: 'Tube with 16 flat sides (inscribed), L/R = 10', params: Object.freeze({ d: 0.04, L: 0.2, n: 16 }), reference: Object.freeze(REF.tube16), testOnly: true }),
  coneConv: Object.freeze({ label: 'Converging cone β = −10°, L/R₁ = 4', params: Object.freeze({ R1: 0.02, R2: 0.02 + 0.08 * Math.tan(-10 * DEG), L: 0.08, n: 64 }), reference: Object.freeze(REF.coneConv), testOnly: true }),
  pumpTube: Object.freeze({ label: 'Tube Ø100 × 200 mm on a 300 L/s pump', params: Object.freeze({ d: 0.1, L: 0.2, n: 64, speed: 0.3 }), reference: Object.freeze(REF.pumpTube), testOnly: true }),
});

/** The built-in the CAD tab loads first. */
export const DEFAULT_BUILTIN = 'elbow';

// ---------------------------------------------------------------- mesh writers

function soup() {
  const a = [];
  return {
    tri(p, q, r) { a.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]); },
    done() { return Float32Array.from(a); },
  };
}

function circle(n) {
  const c = new Float64Array(n), s = new Float64Array(n);
  for (let k = 0; k < n; k++) { c[k] = Math.cos(TWO_PI * k / n); s[k] = Math.sin(TWO_PI * k / n); }
  return { c, s };
}

// Quads between consecutive rings ring[j][k] (k mod n), two triangles each; outward when the rings run
// counterclockwise about the flow direction and j increases along it; `flip` reverses the winding.
function band(out, rings, flip = false) {
  const n = rings[0].length;
  for (let j = 0; j + 1 < rings.length; j++) {
    const r0 = rings[j], r1 = rings[j + 1];
    for (let k = 0; k < n; k++) {
      const a = r0[k], b = r0[(k + 1) % n], c = r1[(k + 1) % n], d = r1[k];
      if (flip) { out.tri(a, c, b); out.tri(a, d, c); } else { out.tri(a, b, c); out.tri(a, c, d); }
    }
  }
}

const segCount = (len, R, n) => Math.max(1, Math.round(len / (TWO_PI * R / n)));

function num(params, key, defaults, { min = 0, integer = false } = {}) {
  const v = params[key] === undefined ? defaults[key] : params[key];
  if (!(typeof v === 'number' && Number.isFinite(v) && v > min) || (integer && !Number.isInteger(v))) {
    fail('The built-in parameter "' + key + '" must be a ' + (integer ? 'whole number' : 'number') + ' above ' + min + '.');
  }
  return v;
}

function tubeRings(R, L, n, ap) {
  const Rp = ap ? R * apFactor(n) : R, { c, s } = circle(n);
  const m = segCount(L, R, n), rings = [];
  for (let j = 0; j <= m; j++) {
    const z = L * (j / m), ring = [];
    for (let k = 0; k < n; k++) ring.push([Rp * c[k], Rp * s[k], z]);
    rings.push(ring);
  }
  return rings;
}

const GEN = {
  tube(p, d) {
    const D = num(p, 'd', d), L = num(p, 'L', d), n = num(p, 'n', d, { min: 2, integer: true });
    const out = soup();
    band(out, tubeRings(D / 2, L, n, true));
    return { positions: out.done(), hints: [{ name: 'Inlet', role: 'inlet', at: [0, 0, 0] }, { name: 'Outlet', role: 'outlet', at: [0, 0, L] }] };
  },
  tube16(p, d) {
    const D = num(p, 'd', d), L = num(p, 'L', d), n = num(p, 'n', d, { min: 2, integer: true });
    const out = soup();
    band(out, tubeRings(D / 2, L, n, false));
    return { positions: out.done(), hints: [{ name: 'Inlet', role: 'inlet', at: [0, 0, 0] }, { name: 'Outlet', role: 'outlet', at: [0, 0, L] }] };
  },
  pumpTube(p, d) {
    const D = num(p, 'd', d), L = num(p, 'L', d), n = num(p, 'n', d, { min: 2, integer: true }), S = num(p, 'speed', d);
    const out = soup();
    band(out, tubeRings(D / 2, L, n, true));
    return { positions: out.done(), hints: [{ name: 'Inlet', role: 'inlet', at: [0, 0, 0] }, { name: 'Pump', role: 'pump', at: [0, 0, L], speed: S }] };
  },
  elbow(p, d) {
    const D = num(p, 'd', d), A = num(p, 'A', d), B = num(p, 'B', d), n = num(p, 'n', d, { min: 2, integer: true });
    const R = D / 2, Rp = R * apFactor(n), { c, s } = circle(n);
    if (!(A > Rp && B > Rp)) fail('Each elbow leg must be longer than the bore radius (' + (Rp * 1000).toPrecision(4) + ' mm).');
    // leg 0 along +z from z = 0 to the miter plane x + z = A; leg 1 along +x from the miter plane to x = B
    const seam = [];
    for (let k = 0; k < n; k++) seam.push([Rp * c[k], Rp * s[k], A - Rp * c[k]]);
    const m0 = segCount(A, R, n), m1 = segCount(B, R, n);
    const leg0 = [];
    for (let j = 0; j < m0; j++) {
      const ring = [];
      for (let k = 0; k < n; k++) ring.push([Rp * c[k], Rp * s[k], (A - Rp * c[k]) * (j / m0)]);
      leg0.push(ring);
    }
    leg0.push(seam);
    const leg1 = [seam];
    for (let j = 1; j <= m1; j++) {
      const ring = [];
      for (let k = 0; k < n; k++) ring.push([Rp * c[k] + (B - Rp * c[k]) * (j / m1), Rp * s[k], A - Rp * c[k]]);
      leg1.push(ring);
    }
    const out = soup();
    band(out, leg0);
    band(out, leg1);
    return { positions: out.done(), hints: [{ name: 'Inlet', role: 'inlet', at: [0, 0, 0] }, { name: 'Outlet', role: 'outlet', at: [B, 0, A] }] };
  },
  cone(p, d) {
    const R1 = num(p, 'R1', d), R2 = num(p, 'R2', d), L = num(p, 'L', d), n = num(p, 'n', d, { min: 2, integer: true });
    const f = apFactor(n), { c, s } = circle(n);
    const slant = Math.hypot(L, R2 - R1), m = segCount(slant, (R1 + R2) / 2, n), rings = [];
    for (let j = 0; j <= m; j++) {
      const t = j / m, r = f * (R1 + (R2 - R1) * t), z = L * t, ring = [];
      for (let k = 0; k < n; k++) ring.push([r * c[k], r * s[k], z]);
      rings.push(ring);
    }
    const out = soup();
    band(out, rings);
    return { positions: out.done(), hints: [{ name: 'Inlet', role: 'inlet', at: [0, 0, 0] }, { name: 'Outlet', role: 'outlet', at: [0, 0, L] }] };
  },
  annulus(p, d) {
    const Ro = num(p, 'Ro', d), Ri = num(p, 'Ri', d), L = num(p, 'L', d), n = num(p, 'n', d, { min: 2, integer: true });
    if (!(Ri < Ro)) fail('The rod must be thinner than the bore.');
    const out = soup();
    band(out, tubeRings(Ro, L, n, true));
    band(out, tubeRings(Ri, L, n, true), true);          // the rod: normals towards the axis (out of the gas)
    return { positions: out.done(), hints: [{ name: 'Inlet', role: 'inlet', at: [0, 0, 0] }, { name: 'Outlet', role: 'outlet', at: [0, 0, L] }] };
  },
  coneConv(p, d) { return GEN.cone(p, d); },
  rect(p, d) {
    const a = num(p, 'a', d), b = num(p, 'b', d), L = num(p, 'L', d), g = num(p, 'grid', d, { min: 0, integer: true });
    // the perimeter, counterclockwise seen from +z, g segments per side; then g segments along z
    const ring = [];
    for (let i = 0; i < g; i++) ring.push([-a / 2 + a * (i / g), -b / 2]);
    for (let i = 0; i < g; i++) ring.push([a / 2, -b / 2 + b * (i / g)]);
    for (let i = 0; i < g; i++) ring.push([a / 2 - a * (i / g), b / 2]);
    for (let i = 0; i < g; i++) ring.push([-a / 2, b / 2 - b * (i / g)]);
    const rings = [];
    for (let j = 0; j <= g; j++) rings.push(ring.map(([x, y]) => [x, y, L * (j / g)]));
    const out = soup();
    band(out, rings);
    return { positions: out.done(), hints: [{ name: 'Inlet', role: 'inlet', at: [0, 0, 0] }, { name: 'Outlet', role: 'outlet', at: [0, 0, L] }] };
  },
};

function sameParams(params, defaults) {
  for (const k of Object.keys(params || {})) {
    const v = params[k], d = defaults[k];
    if (d === undefined) return false;
    if (!(typeof v === 'number' && Math.abs(v - d) <= 1e-12 * Math.max(1, Math.abs(d)))) return false;
  }
  return true;
}

/**
 * A built-in with its prepared mesh: { positions, prep: { mesh, report, autoPorts }, suggestedPorts, reference }.
 * The suggested ports are the detected openings with the built-in's own names and roles (loop ids refer to
 * prep.report.loops). The reference is null when the parameters differ from the defaults.
 */
export function prepareBuiltin(name, params = {}) {
  if (!Object.prototype.hasOwnProperty.call(BUILTINS, name)) fail('There is no built-in geometry called "' + name + '".');
  const def = BUILTINS[name];
  const p = params && typeof params === 'object' ? params : {};
  const g = GEN[name](p, def.params);
  const prep = prepareMesh(g.positions);
  const auto = prep.autoPorts;
  if (auto.length !== g.hints.length) fail('The built-in "' + name + '" did not produce ' + g.hints.length + ' openings (internal error).');
  // match each hint to the detected opening whose outer loop centroid is nearest
  const loops = prep.report.loops;
  const taken = new Set();
  const suggestedPorts = g.hints.map((h, k) => {
    let best = -1, bestD = Infinity;
    auto.forEach((ap, j) => {
      if (taken.has(j)) return;
      const c = loops[ap.loops[0][0]].centroid;
      const dd = (c[0] - h.at[0]) ** 2 + (c[1] - h.at[1]) ** 2 + (c[2] - h.at[2]) ** 2;
      if (dd < bestD) { bestD = dd; best = j; }
    });
    taken.add(best);
    const isPump = h.role === 'pump';
    return {
      id: k, name: h.name, kind: 'loop', loops: auto[best].loops.map((grp) => grp.slice()), tris: null, role: h.role,
      stick: isPump ? null : 1, speed: isPump ? h.speed : null,
    };
  });
  const reference = sameParams(p, def.params) ? { ...def.reference } : null;
  return { positions: g.positions, prep, suggestedPorts, reference };
}

/**
 * A built-in geometry (§7.4): { positions: Float32Array (metres), suggestedPorts: PortSpec[], reference }.
 * params override the defaults in BUILTINS[name].params (metres); the reference is null for non-default params.
 */
export function makeBuiltin(name, params = {}) {
  const b = prepareBuiltin(name, params);
  return { positions: b.positions, suggestedPorts: b.suggestedPorts, reference: b.reference };
}
