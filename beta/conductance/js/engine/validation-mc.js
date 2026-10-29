// Monte Carlo validation cases (spec §2.8, §5.3): analytic-chain cases, mesh cases on the built-in geometries,
// and negative controls. Every reference number is embedded with its source (the browser cannot read _tests/);
// wp2-validation-data.test.mjs checks each one against fixtures/validation-cases-v2.json and the spec.
//
// Case = { id, group, title, source: { label, url }, ref, refSigma, tol, quick, seed, n, nQuick, unit,
//          catchRel?, nodeOnly?, refFrom?, run: async (ctx) => { value, sigma, pass?, caught? } }
// ctx = { mc: McRunner, quick: bool (use the quick N), n: number (optional override of N), onProgress?, geometry? }.
// All cases run deterministically: fixed job seed (20261012 + index in MC_CASES), fixed N and batches of 20 000,
// so a given JS engine always gives the same counts. Mesh cases load the geometry modules on first use.
import { gasState } from './gas.js';
import { makeBlock, mirrorBlock } from './chain-mc.js';
import { chainPlan } from './chain-scene.js';
import { subsetScene, axialProfile, toSlotOrder } from './mesh-mc.js';
import { binomial } from './stats.js';

const SEED0 = 20261012, BATCH = 20000;
const DEG = Math.PI / 180;
const URL_MATUDA = 'https://doi.org/10.3131/jvsj2.58.311';
const URL_LIVESEY = 'https://www.wiley-vch.de/en/areas-interest/engineering/foundations-of-vacuum-science-and-technology-978-0-471-17593-3';
const URL_HOW = '#how';

const SRC = {
  ie: { label: 'Integral equation (this work; equals Matuda 2015, Table 1)', url: URL_MATUDA },
  tpmc: { label: 'TPMC of this work (2·10⁶ particles)', url: URL_HOW },
  livesey: { label: 'Livesey (1998), Haefer example; TPMC of this work', url: URL_LIVESEY },
  liveseyPump: { label: 'Livesey (1998) p. 100: 188 L/s; TPMC of this work', url: URL_LIVESEY },
  preset: { label: 'Chain TPMC of this work (4·10⁶ particles), Appendix B', url: URL_HOW },
  identity: { label: 'Reciprocity A₁α₁₂ = A₂α₂₁ (exact identity)', url: URL_HOW },
  elbow33: { label: 'TPMC of this work (4.6·10⁶ particles)', url: URL_HOW },
  clausing: { label: 'Clausing q(z) for L/R = 20 (research §3.7)', url: URL_HOW },
  faceting: { label: 'Faceting study of this work (research §3.6)', url: URL_HOW },
  policy: { label: 'Leak policy of this tool (§3.6.3)', url: URL_HOW },
  sampler: { label: 'Integral equation (this work); wrong samplers off by +24 % and −16 % (research §3.1)', url: URL_HOW },
};

let N2 = null, AIR = null;
const gasN2 = () => (N2 || (N2 = gasState('N2', 293.15)));
const gasAir = () => (AIR || (AIR = gasState('air', 293.15)));

function pickN(ctx, c) {
  if (ctx && Number.isFinite(ctx.n) && ctx.n > 0) return Math.round(ctx.n);
  return ctx && ctx.quick && c.nQuick ? c.nQuick : c.n;
}
function detOpts(seed, N, ctx, extra = {}) {
  return {
    deterministic: true, fixedN: N, seed, batch: BATCH, maxTime: Infinity, maxParticles: Infinity,
    onProgress: ctx && typeof ctx.onProgress === 'function' ? ctx.onProgress : null, ...extra,
  };
}
function needRunner(ctx) {
  if (!ctx || !ctx.mc || typeof ctx.mc.runChain !== 'function') throw new Error('This check needs the Monte Carlo runner.');
  return ctx.mc;
}

const tube = (R, L) => ({ type: 'tube', R, L });
const disc = (r) => ({ kind: 'disc', r });

// ---------------------------------------------------------------- chain cases

function chainAlpha(id, title, ref, refSigma, source, nQuick, n, cells, plates, refFrom, sampler = 'cosine') {
  const c = {
    id, group: 'chain-mc', title, source, ref, refSigma, tol: { sigmas: 3 }, quick: true, nQuick, n, unit: '', refFrom,
  };
  c.run = async (ctx) => {
    const mc = needRunner(ctx);
    const plan = { blocks: [makeBlock({ id: 0, label: title, cells, plates })], tree: { k: 'block', id: 0 }, kind: 'C', notes: [] };
    const r = await mc.runChain(plan, gasN2(), detOpts(c.seed, pickN(ctx, c), ctx, { sampler }));
    return { value: r.blocks[0].alpha, sigma: r.blocks[0].sigmaAlpha };
  };
  return c;
}

function chainSpeed(id, title, ref, refSigma, plusRel, source, nQuick, n, gas, items, refFrom) {
  const c = {
    id, group: 'chain-mc', title, source, ref, refSigma, tol: plusRel ? { sigmas: 3, plusRel } : { sigmas: 3 },
    quick: true, nQuick, n, unit: 'L/s', refFrom,
  };
  c.run = async (ctx) => {
    const mc = needRunner(ctx);
    const G = gas === 'air' ? gasAir() : gasN2();
    const plan = chainPlan(items, G, { bc: { mode: 'pump', p0: 1e-4 } });
    if (plan.unsupported) throw new Error(plan.unsupported.join(' '));
    const r = await mc.runChain(plan, G, detOpts(c.seed, pickN(ctx, c), ctx));
    return { value: r.value * 1000, sigma: r.sigma * 1000 };
  };
  return c;
}

function coneRecip() {
  const cone = { type: 'cone', R1: 1, R2: 1 + 4 * Math.tan(-10 * DEG), L: 4 };
  const c = {
    id: 'mc-cone-recip', group: 'chain-mc', title: 'Converging cone β = −10°, L/R₁ = 4: reciprocity z-score of both directions',
    source: SRC.identity, ref: 0, refSigma: 0, tol: { abs: 3 }, quick: true, nQuick: 4e5, n: 3e6, unit: 'z',
    refFrom: { identity: 'reciprocity' },
  };
  c.run = async (ctx) => {
    const mc = needRunner(ctx);
    const N = pickN(ctx, c);
    const fwd = makeBlock({ id: 0, label: 'cone', cells: [cone], outlet: { stick: 1 } });
    const rev = { ...mirrorBlock({ ...fwd, outlet: null }), id: 0, outlet: { stick: 1 } };
    const one = async (block, seed) => {
      const plan = { blocks: [block], tree: { k: 'pumpBlock', id: 0 }, kind: 'C', notes: [] };
      const r = await mc.runChain(plan, gasN2(), detOpts(seed, N, ctx));
      const b = binomial(r.blocks[0].in.trans, r.blocks[0].in.n);
      return { a: b.p, s: b.sigma, A: block.Ain };
    };
    const f = await one(fwd, c.seed), b = await one(rev, (c.seed + 0x10000) >>> 0);
    const z = (f.A * f.a - b.A * b.a) / Math.sqrt((f.A * f.s) ** 2 + (b.A * b.s) ** 2);
    return { value: z, sigma: 0 };
  };
  return c;
}

// ---------------------------------------------------------------- mesh cases

// The geometry modules of WP3 (testgeom.js, mesh.js, ports.js, io/stl.js), loaded on first use. ctx.geometry, when
// given, replaces them (an object with makeBuiltin, prepareMesh, buildScene, parseSTL and writeBinarySTL): the WP2
// tests drive the mesh cases through stand-ins this way.
let geo = null;
async function geometry(ctx) {
  if (ctx && ctx.geometry) return ctx.geometry;
  if (!geo) {
    const [tg, mesh, ports, stl] = await Promise.all([import('./testgeom.js'), import('./mesh.js'), import('./ports.js'), import('../io/stl.js')]);
    geo = { ...tg, ...mesh, ...ports, ...stl };
  }
  return geo;
}

// Ports of a built-in: its suggested PortSpecs when they refer to openings of the prepared mesh (loop ids of the
// report, or region triangles); otherwise the detected ports with the suggested roles copied onto them.
function portsFor(prep, suggested) {
  const auto = Array.isArray(prep.autoPorts) ? prep.autoPorts : [];
  if (!Array.isArray(suggested) || !suggested.length) return auto;
  const loopIds = new Set(((prep.report && prep.report.loops) || []).map((l) => l.id));
  const complete = suggested.every((s) => (Array.isArray(s.loops) && s.loops.length && s.loops.flat().every((id) => loopIds.has(id)))
    || (s.tris && s.tris.length));
  if (complete || !auto.length) return suggested;
  const key = (p) => JSON.stringify(p.loops || null);
  return auto.map((p, k) => {
    const s = suggested.find((q) => key(q) === key(p)) || suggested[k];
    return s ? { ...p, role: s.role, stick: s.stick ?? p.stick, speed: s.speed ?? p.speed, name: s.name || p.name } : p;
  });
}

async function sceneFromPositions(ctx, positions, G, suggested = null, adjust = null) {
  const g = await geometry(ctx);
  const prep = g.prepareMesh(positions, null);
  let ports = portsFor(prep, suggested);
  if (adjust) ports = ports.map(adjust);
  return g.buildScene(prep.mesh, ports, G).scene;
}

async function builtinScene(ctx, name, G, params = {}, adjust = null) {
  const g = await geometry(ctx);
  const b = g.makeBuiltin(name, params);
  return { scene: await sceneFromPositions(ctx, b.positions, G, b.suggestedPorts, adjust), reference: b.reference, positions: b.positions };
}

// Largest extent of a triangle soup (m).
function extentOf(positions) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) { const x = positions[i + k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }
  }
  return Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

// Round tube along z as the built-ins are made (§7.4): n segments, area-preserving radius, axial segments about as
// long as the circumferential ones; open ends (the ports are detected by prepareMesh).
function tubePositions(R, L, n = 64) {
  const Rp = R * Math.sqrt(2 * Math.PI / (n * Math.sin(2 * Math.PI / n)));
  const m = Math.max(1, Math.round(L / (2 * Math.PI * R / n)));
  const out = new Float32Array(18 * n * m);
  const P = (k, j) => [Rp * Math.cos(2 * Math.PI * k / n), Rp * Math.sin(2 * Math.PI * k / n), L * j / m];
  let o = 0;
  const put = (p) => { out[o++] = p[0]; out[o++] = p[1]; out[o++] = p[2]; };
  for (let j = 0; j < m; j++) {
    for (let k = 0; k < n; k++) {
      const a = P(k, j), b = P(k + 1, j), c = P(k + 1, j + 1), d = P(k, j + 1);
      put(a); put(b); put(c); put(a); put(c); put(d);
    }
  }
  return out;
}

// The built-in tube with another length (mesh-profile20): makeBuiltin('tube', { d, L }) when testgeom.js takes
// those parameters, else the same construction made here and prepared by mesh.js.
async function longTubeScene(ctx, G, d, L) {
  const g = await geometry(ctx);
  let b = null;
  try { b = g.makeBuiltin('tube', { d, L }); } catch (_) { b = null; }
  if (b && Math.abs(extentOf(b.positions) / L - 1) < 0.01) return sceneFromPositions(ctx, b.positions, G, b.suggestedPorts);
  return sceneFromPositions(ctx, tubePositions(d / 2, L), G, null);
}

// conductance between the two stick-1 ports (both directions), referred to the inlet, or to the smaller opening
function meshAlphaOf(r, scene, G, referTo = 'inlet') {
  if (!r.C) throw new Error('The run gave no conductance.');
  const ports = scene.ports;
  let A = ports[r.C.i].area;
  if (referTo === 'small') A = Math.min(ports[r.C.i].area, ports[r.C.j].area);
  const C0 = A * G.vbar / 4;
  return { value: r.C.value / C0, sigma: r.C.sigma / C0 };
}

function meshAlpha(id, title, builtin, ref, refSigma, plusRel, source, nQuick, n, quick, refFrom, referTo = 'inlet') {
  const c = { id, group: 'mesh-mc', title, source, ref, refSigma, tol: { sigmas: 3, plusRel }, quick, nQuick, n, unit: '', refFrom };
  c.run = async (ctx) => {
    const mc = needRunner(ctx);
    const G = gasN2();
    const { scene } = await builtinScene(ctx, builtin, G);
    const r = await mc.runMesh(scene, G, detOpts(c.seed, pickN(ctx, c), ctx, { tally: false, paths: 0 }));
    return meshAlphaOf(r, scene, G, referTo);
  };
  return c;
}

const CLAUSING_Z = [0.025, 0.125, 0.275, 0.525, 0.775, 0.975];
const CLAUSING_Q = [0.9273, 0.832, 0.6973, 0.4782, 0.2583, 0.0727];

function meshProfile() {
  const c = {
    id: 'mesh-profile20', group: 'mesh-mc', title: 'Wall pressure along a tube L/R = 20 at 6 points: largest deviation beyond 3σ',
    source: SRC.clausing, ref: 0, refSigma: 0, tol: { abs: 0.006 }, quick: false, n: 1e6, unit: 'p/p_in',
    refFrom: { file: 'validation-cases-v2.json', path: ['profile_tube_L_over_R_20', 'clausing_q'] },
    clausing: { z: CLAUSING_Z, q: CLAUSING_Q },
  };
  c.run = async (ctx) => {
    const mc = needRunner(ctx);
    const G = gasN2();
    const scene = await longTubeScene(ctx, G, 0.04, 0.4);
    const r = await mc.runMesh(scene, G, detOpts(c.seed, pickN(ctx, c), ctx, { tally: true, paths: 0 }));
    if (!r.hits) throw new Error('The run returned no wall tally.');
    const prof = axialProfile(scene, toSlotOrder(scene, r.hits), r.inletLaunches, { bins: 20 });
    let worst = 0, ok = true;
    CLAUSING_Z.forEach((zl, k) => {
      const bin = Math.min(19, Math.floor(zl * 20));
      const v = prof.value[bin], sig = v / Math.sqrt(Math.max(prof.hits[bin], 1));
      const excess = Math.abs(v - CLAUSING_Q[k]) - 3 * sig;
      if (!(excess <= 0.006)) ok = false;
      worst = Math.max(worst, excess);
    });
    return { value: worst, sigma: 0, pass: ok };
  };
  return c;
}

function meshFaceting() {
  const c = {
    id: 'mesh-faceting16', group: 'mesh-mc', title: 'Inscribed 16-gon tube L/R = 10: conductance error against the round tube',
    source: SRC.faceting, ref: -3.51, refSigma: 0, tol: { sigmas: 3, plusAbs: 0.5 }, quick: false, n: 1e6, unit: '%',
    refFrom: { file: 'validation-cases-v2.json', path: ['faceting_ngon_tube_this_work', 'L/R=10', 'n=16'] },
  };
  c.run = async (ctx) => {
    const mc = needRunner(ctx);
    const G = gasN2();
    const { scene } = await builtinScene(ctx, 'tube16', G);
    const r = await mc.runMesh(scene, G, detOpts(c.seed, pickN(ctx, c), ctx, { tally: false, paths: 0 }));
    const A = scene.ports[r.C.i].area, nSides = 16;
    const R = Math.sqrt(2 * A / (nSides * Math.sin(2 * Math.PI / nSides)));
    const Cround = 0.1909424 * Math.PI * R * R * G.vbar / 4;
    return { value: (r.C.value / Cround - 1) * 100, sigma: r.C.sigma / Cround * 100 };
  };
  return c;
}

function meshLeaks() {
  const c = {
    id: 'mesh-leaks', group: 'mesh-mc', title: 'Built-in elbow, 10⁶ particles: leaks per million rays',
    source: SRC.policy, ref: 0, refSigma: 0, tol: { abs: 1 }, quick: false, n: 1e6, unit: 'per 10⁶',
    refFrom: { policy: 'leaks' },
  };
  c.run = async (ctx) => {
    const mc = needRunner(ctx);
    const G = gasN2();
    const { scene } = await builtinScene(ctx, 'elbow', G);
    const r = await mc.runMesh(scene, G, detOpts(c.seed, pickN(ctx, c), ctx, { tally: false, paths: 0 }));
    return { value: r.leaksPerMillion, sigma: 0 };
  };
  return c;
}

function meshRecipCone() {
  const c = {
    id: 'mesh-recip-cone', group: 'mesh-mc', title: 'Converging cone mesh β = −10°, L/R₁ = 4: reciprocity z-score',
    source: SRC.identity, ref: 0, refSigma: 0, tol: { abs: 3 }, quick: false, n: 1e6, unit: 'z',
    refFrom: { identity: 'reciprocity' },
  };
  c.run = async (ctx) => {
    const mc = needRunner(ctx);
    const G = gasN2();
    const { scene } = await builtinScene(ctx, 'coneConv', G);
    const r = await mc.runMesh(scene, G, detOpts(c.seed, pickN(ctx, c), ctx, { tally: false, paths: 0 }));
    if (!r.reciprocity.length) throw new Error('Both openings must launch particles.');
    return { value: r.reciprocity[0].z, sigma: 0 };
  };
  return c;
}

function meshStlRoundtrip() {
  const c = {
    id: 'mesh-stl-roundtrip', group: 'mesh-mc', title: 'Built-in elbow → binary STL (mm) → parse → prepare: α difference from the built-in',
    source: SRC.elbow33, ref: 0, refSigma: 0, tol: { sigmas: 3 }, quick: false, n: 1e6, unit: '',
    refFrom: { identity: 'roundtrip' },
  };
  c.run = async (ctx) => {
    const mc = needRunner(ctx);
    const G = gasN2(), g = await geometry(ctx);
    const N = pickN(ctx, c);
    const b = await builtinScene(ctx, 'elbow', G);
    const mm = new Float32Array(b.positions.length);
    for (let i = 0; i < mm.length; i++) mm[i] = b.positions[i] * 1000;
    const parsed = g.parseSTL(g.writeBinarySTL(mm));
    const m = new Float32Array(parsed.positions.length);
    for (let i = 0; i < m.length; i++) m[i] = parsed.positions[i] * 0.001;
    const scene2 = await sceneFromPositions(ctx, m, G);
    const r1 = await mc.runMesh(b.scene, G, detOpts(c.seed, N, ctx, { tally: false, paths: 0 }));
    const r2 = await mc.runMesh(scene2, G, detOpts((c.seed + 0x10000) >>> 0, N, ctx, { tally: false, paths: 0 }));
    const a1 = meshAlphaOf(r1, b.scene, G), a2 = meshAlphaOf(r2, scene2, G);
    return { value: a2.value - a1.value, sigma: Math.hypot(a1.sigma, a2.sigma) };
  };
  return c;
}

function meshPump() {
  const c = {
    id: 'mesh-pump', group: 'mesh-mc', title: 'Tube Ø100 × 200 mm mesh on a 300 L/s pump port (air): S_eff',
    source: SRC.liveseyPump, ref: 188.0, refSigma: 0.3, tol: { sigmas: 3, plusRel: 0.004 }, quick: false, n: 1e6, unit: 'L/s',
    refFrom: { file: 'validation-cases-v2.json', path: ['series_examples', 'livesey_pump_S300_tube_d100_l200', 'S_n_tpmc_this_work'] },
  };
  c.run = async (ctx) => {
    const mc = needRunner(ctx);
    const G = gasAir();
    // the pump port pumps 300 L/s of air whatever the built-in's default (buildScene converts speed to sticking)
    const pump300 = (p) => (p.role === 'pump' ? { ...p, speed: 0.3, stick: null } : p);
    const { scene } = await builtinScene(ctx, 'pumpTube', G, {}, pump300);
    const r = await mc.runMesh(scene, G, detOpts(c.seed, pickN(ctx, c), ctx, { tally: false, paths: 0 }));
    if (!r.Seff) throw new Error('The scene has no pump port.');
    return { value: r.Seff.value * 1000, sigma: r.Seff.sigma * 1000 };
  };
  return c;
}

// ---------------------------------------------------------------- negative controls

function negSampler(id, sampler, title) {
  const c = {
    id, group: 'negative', title, source: SRC.sampler, ref: 0.5142305, refSigma: 0, tol: null, catchRel: 0.05,
    quick: true, n: 1e5, unit: '', refFrom: { file: 'validation-cases-v2.json', path: ['tube_this_work_L_over_R', '2'] },
  };
  c.run = async (ctx) => {
    const mc = needRunner(ctx);
    const plan = { blocks: [makeBlock({ id: 0, label: 'tube L/R = 2', cells: [tube(1, 2)] })], tree: { k: 'block', id: 0 }, kind: 'C', notes: [] };
    const r = await mc.runChain(plan, gasN2(), detOpts(c.seed, pickN(ctx, c), ctx, { sampler }));
    return { value: r.blocks[0].alpha, sigma: r.blocks[0].sigmaAlpha };
  };
  return c;
}

function negLeakyMesh() {
  const c = {
    id: 'neg-leaky-mesh', group: 'negative', title: 'Built-in tube with 1 % of its wall triangles deleted: the leak stop must trigger',
    // reference: the stop limit of 100 leaks per million rays; caught when the run stops with the leak message
    source: SRC.policy, ref: 100, refSigma: 0, tol: null, catchRel: 0, quick: false, nodeOnly: true, n: 2e5, unit: 'per 10⁶',
    refFrom: { policy: 'leaks' },
  };
  c.run = async (ctx) => {
    const mc = needRunner(ctx);
    const G = gasN2();
    const { scene } = await builtinScene(ctx, 'tube', G);
    const keep = new Uint8Array(scene.nTri);
    let wall = 0;
    for (let s = 0; s < scene.nTri; s++) { keep[s] = 1; if (scene.port[s] < 0 && wall++ % 100 === 50) keep[s] = 0; }
    const leaky = subsetScene(scene, keep);
    try {
      const r = await mc.runMesh(leaky, G, detOpts(c.seed, pickN(ctx, c), ctx, { tally: false, paths: 0 }));
      return { value: r.leaksPerMillion, sigma: 0, caught: false };
    } catch (err) {
      if (err && err.code === 'leaks') return { value: err.partial ? err.partial.leaksPerMillion : NaN, sigma: 0, caught: true };
      throw err;
    }
  };
  return c;
}

// ---------------------------------------------------------------- the list

const TP = 'tpmc_reference_cases_this_work';
const fx = (...path) => ({ file: 'validation-cases-v2.json', path });

const LIST = [
  chainAlpha('mc-tube10', 'Tube L/R = 10', 0.1909424, 0, SRC.ie, 3e5, 2e6, [tube(1, 10)], [], fx('tube_this_work_L_over_R', '10')),
  chainAlpha('mc-orifice-tube', 'Plate r = 0.5 in front of a tube R = 1, L = 8', 0.54546, 0.00035, SRC.tpmc, 2e5, 2e6,
    [tube(1, 8)], [disc(0.5)], fx(TP, 'orifice r=0.5 + tube R=1 L=8')),
  chainAlpha('mc-tpt', 'Tube R 1, L 1 | plate r 0.5 | tube R 1, L 1', 0.21433, 0.00029, SRC.tpmc, 3e5, 2e6,
    [tube(1, 1), tube(1, 1)], [null, disc(0.5)], fx(TP, 'tube R1 L1 | plate r0.5 | tube R1 L1')),
  chainAlpha('mc-contraction', 'Contraction: tube R 2, L 4 → tube R 1, L 4', 0.08445, 0.0002, SRC.tpmc, 6e5, 4e6,
    [tube(2, 4), tube(1, 4)], [], fx(TP, 'contraction R2L4 -> R1L4')),
  chainAlpha('mc-expansion', 'Expansion: tube R 1, L 4 → tube R 2, L 4', 0.33916, 0.00033, SRC.tpmc, 2e5, 2e6,
    [tube(1, 4), tube(2, 4)], [], fx(TP, 'expansion R1L4 -> R2L4')),
  chainAlpha('mc-livesey-15-25-20', 'Livesey example: tubes Ø15, Ø25, Ø20 mm with l/d = 2', 0.22678, 0.0003, SRC.livesey, 3e5, 2e6,
    [tube(7.5, 30), tube(12.5, 50), tube(10, 40)], [], fx('series_examples', 'livesey_haefer_15_25_20mm_l_over_d_2', 'alpha_tpmc_this_work')),
  chainAlpha('mc-elbow22', '90° elbow R 1, legs A = B = 2', 0.35147, 0.00034, SRC.tpmc, 2e5, 2e6,
    [{ type: 'elbow', R: 1, A: 2, B: 2 }], [], fx(TP, 'elbow90 R=1 A=B=2')),
  chainAlpha('mc-elbow25', '90° elbow R 1, legs A 2, B 5', 0.239884, 0.0004270124899156932, SRC.tpmc, 3e5, 2e6,
    [{ type: 'elbow', R: 1, A: 2, B: 5 }], [], fx('elbow90_asym_this_work', 'A=2,B=5')),
  chainAlpha('mc-merge', 'Tube 1 + elbow (1, 1) + tube 1, traced as separate cells (= elbow 2, 2)', 0.35147, 0.00034, SRC.tpmc, 2e5, 2e6,
    [tube(1, 1), { type: 'elbow', R: 1, A: 1, B: 1 }, tube(1, 1)], [], fx(TP, 'elbow90 R=1 A=B=2')),
  chainAlpha('mc-cone20', 'Diverging cone β = 20°, L/R₁ = 2', 0.837679, 0.0003687450243176171, SRC.tpmc, 1e5, 1e6,
    [{ type: 'cone', R1: 1, R2: 1 + 2 * Math.tan(20 * DEG), L: 2 }], [], fx('cone_this_work', 'cone beta=20 L/R1=2')),
  coneRecip(),
  chainAlpha('mc-annulus', 'Annulus Ri/Ro = 0.5, L/gap = 2', 0.52877, 0.00035, SRC.tpmc, 2e5, 2e6,
    [{ type: 'annulus', Ri: 0.5, Ro: 1, L: 1 }], [], fx(TP, 'annulus Ri/Ro=0.5 L/gap=2')),
  chainAlpha('mc-rect', 'Square duct 1 × 1, L = 1', 0.53622, 0.00035, SRC.tpmc, 2e5, 2e6,
    [{ type: 'rect', a: 1, b: 1, L: 1 }], [], fx(TP, 'rect b/a=1 L/a=1')),
  chainSpeed('mc-livesey-pump', 'Pump 300 L/s on a tube Ø100 × 200 mm (air): S_eff', 188.0, 0.3, 0.002, SRC.liveseyPump, 3e5, 3e6, 'air',
    [{ t: 'tube', d: 0.1, L: 0.2 }, { t: 'pump', S: 0.3, d: 0.1, label: 'Pump' }],
    fx('series_examples', 'livesey_pump_S300_tube_d100_l200', 'S_n_tpmc_this_work')),
  chainSpeed('mc-preset-turbo', 'Preset 1, turbo on a DN100 line: S_eff', 138.03, 0.16, 0, SRC.preset, 3e5, 3e6, 'N2',
    [{ t: 'tube', d: 0.1, L: 0.2 }, { t: 'elbow', d: 0.1, A: 0.1, B: 0.1 }, { t: 'pump', S: 0.3, d: 0.1, label: 'Turbo' }],
    { spec: 'Appendix B.1, preset 1' }),
  chainSpeed('mc-preset-beamline', 'Preset 4, beamline with a valve and a reducer: S_eff', 22.14, 0.03, 0, SRC.preset, 3e5, 3e6, 'N2',
    [{ t: 'tube', d: 0.04, L: 0.15 }, { t: 'bbox', C: 0.08, gasRef: 'N2', d: 0.04, label: 'Gate_valve' }, { t: 'cone', d1: 0.04, d2: 0.063, L: 0.05 },
      { t: 'pump', S: 0.08, d: 0.063, label: 'Turbo' }], { spec: 'Appendix B.1, preset 4' }),
  meshAlpha('mesh-tube10', 'Mesh: tube Ø40 × 200 mm (64 segments)', 'tube', 0.1909424, 0, 0.003, SRC.ie, 2e5, 1e6, true,
    fx('tube_this_work_L_over_R', '10')),
  meshAlpha('mesh-elbow33', 'Mesh: 90° elbow Ø40 mm, legs 60 mm (the default built-in)', 'elbow', 0.26524, 0.00021, 0.003, SRC.elbow33, 2e5, 1e6, true,
    { spec: 'Appendix B.2, elbow' }),
  meshAlpha('mesh-cone20', 'Mesh: cone R₁ 20, R₂ 34.559, L 40 mm (β = 20°)', 'cone', 0.837679, 0.0003687450243176171, 0.003, SRC.tpmc, 1e5, 5e5, false,
    fx('cone_this_work', 'cone beta=20 L/R1=2'), 'small'),
  meshAlpha('mesh-annulus', 'Mesh: annulus Ro 20, Ri 10, L 20 mm', 'annulus', 0.52877, 0.00035, 0.004, SRC.tpmc, 1e5, 5e5, false,
    fx(TP, 'annulus Ri/Ro=0.5 L/gap=2')),
  meshAlpha('mesh-rect', 'Mesh: duct 20 × 20 × 20 mm', 'rect', 0.53622, 0.00035, 0.001, SRC.tpmc, 1e5, 5e5, false,
    fx(TP, 'rect b/a=1 L/a=1')),
  meshProfile(),
  meshFaceting(),
  meshLeaks(),
  meshRecipCone(),
  meshStlRoundtrip(),
  meshPump(),
  negSampler('neg-sampler-asin', 'asin', 'Wrong sampler θ = asin ξ on a tube L/R = 2 must be caught'),
  negSampler('neg-sampler-uniform', 'uniform', 'Wrong sampler (uniform hemisphere) on a tube L/R = 2 must be caught'),
  negLeakyMesh(),
];
LIST.forEach((c, i) => { c.seed = SEED0 + i; });

/** The Monte Carlo validation cases (§5.3), in table order. */
export const MC_CASES = Object.freeze(LIST);
