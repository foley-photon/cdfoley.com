// CAD tab of Conductance Lab (spec §4.5, §7.5): load an STL or OBJ (or a built-in), check the mesh, assign the
// openings, run the mesh Monte Carlo on the shared McRunner and show the transmission matrix, conductance,
// reciprocity, pressure map, trajectories and plots.
//
//   mount(root, { store, format, getRunner, openInComponents }) → { controller, dispose() }
//
// Layers (all in this file):
//   1. Pure helpers, exported for tests (Node): run-enable rule, stick ↔ speed, clearing rules, counts → C and
//      S_eff, matrix and number formatting, pressure-map colours, coplanar patches, status and reference lines.
//   2. CadController: DOM-free state machine over the prep-worker protocol (§2.13, WP3), McRunner.runMesh (§2.14,
//      WP2) and the project file (§2.10, WP3). Tests drive it with a stub prep worker and a stub runner.
//   3. mount(): the markup, event wiring and rendering, the three.js viewer (loaded on demand) and the plots.
// P2: a 2D axisymmetric profile (SVG or DXF, io/profile2d.js) becomes a Components item list that is shown as a lathe,
// simulated exactly by the analytic chain Monte Carlo (McRunner.runChain) or opened in the Components tab.
// SI units throughout (§2.0); display units come from the store and format.js (WP5). No console output (H13).
import { gasState } from '../engine/gas.js';
import { summarizeMesh } from '../engine/stats.js';
import { axialProfile } from '../engine/mesh-mc.js';
import { CLAUSING_PROFILE_LR20 } from '../engine/tables.js';
import { serializeProject, parseProject } from '../io/project.js';
import { parseSVGProfile, parseDXFProfile, profileToItems } from '../io/profile2d.js';
import { chainPlan, combinePlan } from '../engine/chain-scene.js';
import { buildNetwork, molecularLimit, errorBand } from '../engine/network.js';
import { describeItem } from '../engine/elements.js';
import { logScale, colorsFromT, legendTicks } from './colormap.js';

// ==================================================================================================================
// 1. Constants and pure helpers
// ==================================================================================================================

export const BUILTIN_CHIPS = Object.freeze([
  { name: 'tube', label: 'Tube', title: 'Tube Ø40 × 200 mm' },
  { name: 'elbow', label: 'Elbow', title: '90° elbow, Ø40 mm, legs 60 mm' },
  { name: 'cone', label: 'Cone', title: 'Cone Ø40 to Ø69.1 mm, 40 mm long (20°)' },
  { name: 'annulus', label: 'Annulus', title: 'Annulus: Ø40 mm bore, Ø20 mm rod, 20 mm long' },
  { name: 'rect', label: 'Rect duct', title: 'Square duct 20 × 20 × 20 mm' },
]);

/** Human name of a model source: the built-in's description (default parameters), else the file or built-in name. */
export function sourceTitle(source) {
  if (!source) return 'no model';
  if (source.kind === 'builtin') {
    const b = BUILTIN_CHIPS.find((x) => x.name === source.name);
    const custom = source.params && Object.keys(source.params).length > 0;
    return b && !custom ? b.title : 'built-in ' + source.name;
  }
  return source.label || source.name || 'model';
}
export const DEFAULT_BUILTIN = 'elbow';
export const FILE_UNITS = Object.freeze({ mm: 1e-3, cm: 1e-2, m: 1, in: 0.0254, 'µm': 1e-6 });
export const ROLES = Object.freeze(['inlet', 'outlet', 'pump', 'closed']);
export const ROLE_LABELS = Object.freeze({ inlet: 'Inlet', outlet: 'Outlet', pump: 'Pump', closed: 'Closed' });
export const ROLE_TOKENS = Object.freeze({ inlet: '--c3', outlet: '--c1', pump: '--c4', closed: '--muted' });
export const SELECTION_TOKEN = '--c2';
export const SELECTION_ID = -2;                 // triPort value of a pending selection in the view
export const TARGETS = Object.freeze([0.03, 0.01, 0.003]);
export const MAX_TIMES = Object.freeze([10, 60, 300, Infinity]);
export const TRI_CAP_DESKTOP = 250000;
export const TRI_CAP_PHONE = 100000;
export const MIN_HITS = 10;                     // fewer wall hits than this: "not enough hits" (§3.6.6)
export const SCENE_MEMORY = 200e6;              // bytes of scene per run, shared by the workers (§6)
export const PATCH_CELLS = 40;                  // "Average over flat faces" patch size: 1/40 of the diagonal
const MINUS = '−';
const NBSP = ' ';

const isFiniteNum = (x) => typeof x === 'number' && Number.isFinite(x);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const minus = (s) => String(s).replace(/^-/, MINUS).replace(/e-/, 'e' + MINUS);

/** Molecular-flow maximum pumping speed of an opening, A·v̄/4 (m³/s). */
export function maxSpeed(area, G) { return area * G.vbar / 4; }
/** Sticking coefficient of a pump port for a speed S (m³/s): S/(A·v̄/4). */
export function stickFromSpeed(S, area, G) { return S / maxSpeed(area, G); }
/** Speed (m³/s) of a pump port with sticking coefficient `stick`: stick·A·v̄/4. */
export function speedFromStick(stick, area, G) { return stick * maxSpeed(area, G); }

/** Area of a port (m²): loop ports from the report's loops (outer minus holes), region ports from their own area. */
export function portArea(port, report) {
  if (!port) return NaN;
  if (port.kind === 'region') return isFiniteNum(port.area) ? port.area : NaN;
  if (!report || !Array.isArray(report.loops) || !Array.isArray(port.loops)) return isFiniteNum(port.area) ? port.area : NaN;
  const byId = new Map(report.loops.map((l) => [l.id, l]));
  let a = 0;
  for (const group of port.loops) {
    const ids = Array.isArray(group) || ArrayBuffer.isView(group) ? Array.from(group) : [group];
    ids.forEach((id, k) => { const l = byId.get(id); if (l) a += (k === 0 ? 1 : -1) * Math.abs(l.area); });
  }
  return a > 0 ? a : NaN;
}

/** Loop ids used by loop ports. */
function coveredLoops(ports) {
  const s = new Set();
  for (const p of ports || []) {
    if (p.kind !== 'loop' || !Array.isArray(p.loops)) continue;
    for (const g of p.loops) for (const id of (Array.isArray(g) || ArrayBuffer.isView(g) ? g : [g])) s.add(Number(id));
  }
  return s;
}

/**
 * Pump-port check: null when fine, else a sentence. A pump given by speed must not exceed A·v̄/4; a pump given by
 * sticking coefficient needs 0 < stick ≤ 1.
 */
export function pumpProblem(port, area, G) {
  if (!port || port.role !== 'pump') return null;
  const name = '"' + (port.name || 'Pump') + '"';
  if (port.pumpBy === 'stick' || (port.speed === null || port.speed === undefined)) {
    const st = port.stick;
    if (!(isFiniteNum(st) && st > 0 && st <= 1)) return 'The sticking coefficient of ' + name + ' must be above 0 and at most 1.';
    return null;
  }
  const S = port.speed;
  if (!(isFiniteNum(S) && S > 0)) return 'The pumping speed of ' + name + ' must be a positive number.';
  if (G && isFiniteNum(area) && area > 0 && S > maxSpeed(area, G) * (1 + 1e-12)) {
    return 'The pumping speed of ' + name + ' is above the molecular-flow maximum of its opening.';
  }
  return null;
}

/**
 * Run-enable rule (§4.5): Run needs a prepared model, no error-level mesh message, a role for every flat opening,
 * at least one inlet and at least one outlet or pump, valid pump settings, valid gas data, a built scene and an idle
 * runner. s = { phase, report, ports, G, gasError, sceneError, scenePending, runnerBusy, running }.
 * Returns { ok, reason } where reason says what is missing (for the button title and the status line).
 */
export function runEnable(s) {
  const no = (reason) => ({ ok: false, reason });
  if (!s || s.phase === 'empty' || !s.report) return no('Load a model or choose a built-in geometry.');
  if (s.phase === 'loading') return no('Preparing the mesh…');
  if (s.running) return no('A simulation is running.');
  const errors = (s.report.messages || []).filter((m) => m.level === 'error');
  if (errors.length || s.report.severity === 'error') return no('Fix the mesh errors listed under Mesh check first.');
  const ports = s.ports || [];
  const covered = coveredLoops(ports);
  const loose = (s.report.loops || []).filter((l) => l.planar && !covered.has(Number(l.id)));
  if (loose.length) return no('Every opening needs a role: ' + plural(loose.length, 'flat opening has', 'flat openings have') + ' none. Press Auto-detect.');
  const inlets = ports.filter((p) => p.role === 'inlet');
  const sinks = ports.filter((p) => p.role === 'outlet' || p.role === 'pump');
  if (!inlets.length && !sinks.length) return no('Select an inlet and an outlet.');
  if (!inlets.length) return no('Select an inlet as well as the outlet.');
  if (!sinks.length) return no('Select an outlet or a pump as well as the inlet.');
  if (s.gasError) return no('Paused: fix the gas data above.');
  for (const p of ports) {
    const msg = pumpProblem(p, portArea(p, s.report), s.G);
    if (msg) return no(msg);
  }
  if (s.sceneError) return no(s.sceneError);
  if (s.scenePending || !s.sceneReady) return no('Preparing the openings…');
  if (s.runnerBusy) return no('Another simulation is running (Stop it first)');
  return { ok: true, reason: '' };
}

/**
 * Clearing rules (§4.5) for a change after a run: 'clear' (the stored counts no longer describe the model),
 * 'recompute' (only the gas or temperature changed: C and S_eff are recomputed from the counts) or 'keep'.
 *   kind: 'role' | 'pump' | 'region' | 'geometry' | 'units' | 'weld' | 'gas' | 'name' | 'display' | 'run-options'
 *   ctx:  { builtin: bool (units only change the displayed numbers of a built-in),
 *           pumpBySpeed: bool (a pump given by speed has a gas-dependent sticking coefficient) }
 */
export function changeEffect(kind, ctx = {}) {
  switch (kind) {
    case 'role': case 'pump': case 'region': case 'geometry': case 'weld': return 'clear';
    case 'units': return ctx.builtin ? 'keep' : 'clear';
    case 'gas': return ctx.pumpBySpeed ? 'clear' : 'recompute';
    default: return 'keep';
  }
}

/**
 * Transmission matrix, conductance, S_eff and reciprocity from stored counts for a gas (stats.summarizeMesh, so the
 * numbers match the runner's). ports: the scene's ports [{ role, stick, area }]; perSource: [{ port, n, absorbed }].
 */
export function summarizeCounts(ports, perSource, G, { inletPort = null, outletPort = null } = {}) {
  return summarizeMesh(ports, perSource, G.vbar, { inletPort, outletPort });
}

/** Number of decimals that shows 4 significant digits of x (at least 1, at most 8). */
function decimalsFor(x) {
  if (!(x > 0)) return 4;
  return Math.max(1, Math.min(8, 3 - Math.floor(Math.log10(x) + 1e-12)));
}

/** α with 4 significant digits ('0.2653', '0.001234', '1.000', '0'). */
export function fmtAlpha(x) {
  if (!isFiniteNum(x)) return '–';
  if (x === 0) return '0';
  if (x < 1e-6) return minus(x.toExponential(3));
  return x.toFixed(decimalsFor(x));
}

/** α and its 95 % interval: '0.2653 (0.2641–0.2666)', bounds with the value's decimals. */
export function fmtAlphaCI(value, lo, hi) {
  if (!isFiniteNum(value)) return '–';
  if (value === 0 && !(hi > 0)) return '0';
  if (value > 0 && value < 1e-6) return minus(value.toExponential(3)) + ' (' + minus(lo.toExponential(2)) + '–' + minus(hi.toExponential(2)) + ')';
  // no counts: '0 (0–0.0003000)', the upper bound with 4 significant digits
  if (value === 0) return '0 (0–' + (hi < 1e-6 ? minus(hi.toExponential(3)) : hi.toFixed(decimalsFor(hi))) + ')';
  const d = decimalsFor(value);
  return value.toFixed(d) + ' (' + Math.max(0, lo).toFixed(d) + '–' + hi.toFixed(d) + ')';
}

/** Integer with spaces between thousands from 10 000 up ('8192', '250 000'). */
export function fmtInt(n) {
  if (!isFiniteNum(n)) return '–';
  const s = String(Math.round(Math.abs(n)));
  const g = s.length > 4 ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : s;
  return (n < 0 ? MINUS : '') + g;
}

/** Large counts: '850', '12.3 k', '0.15 M', '35 M'. */
export function fmtCount(n) {
  if (!isFiniteNum(n)) return '–';
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 1e5) return Number((n / 1e3).toPrecision(3)) + ' k';
  return Number((n / 1e6).toPrecision(2)) + ' M';
}

/** Seconds as '0.48 s', '12 s', '2 min 05 s'. */
export function fmtSeconds(s) {
  if (!isFiniteNum(s)) return '–';
  if (s < 10) return Number(s.toPrecision(2)) + ' s';
  if (s < 120) return Math.round(s) + ' s';
  const m = Math.floor(s / 60), r = Math.round(s - 60 * m);
  return m + ' min ' + String(r).padStart(2, '0') + ' s';
}

/** Relative half-width as '±1.6 %'. */
export function fmtRel(r) {
  if (!isFiniteNum(r)) return '±– %';
  const p = 100 * r;
  return '±' + (p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2)) + ' %';
}

/** Signed percentage '+0.12 %', '−1.3 %'. */
export function fmtSignedPct(frac, digits = 2) {
  if (!isFiniteNum(frac)) return '–';
  const p = 100 * frac;
  return (p < 0 ? MINUS : '+') + Math.abs(p).toFixed(digits) + ' %';
}

/**
 * Transmission-matrix table: launching ports as rows ("from opening"), every scene port as a column ("to
 * opening"), plus leaks and stuck. summary = summarizeCounts(...) (alpha rows of { value, lo, hi }).
 * Returns { columns: [name, …], rows: [{ port, from, cells: [text, …], leaks, stuck, n }] }.
 */
export function formatMatrix(summary, ports, perSource) {
  const names = ports.map((p, k) => p.name || 'Opening ' + (k + 1));
  const rows = [];
  const bySource = new Map();
  for (const s of perSource || []) {
    const r = bySource.get(s.port) || { leaks: 0, stuck: 0, n: 0 };
    r.leaks += s.leaks || 0; r.stuck += s.stuck || 0; r.n += s.n || 0;
    bySource.set(s.port, r);
  }
  (summary && summary.alpha ? summary.alpha : []).forEach((row, i) => {
    if (!row) return;
    const extra = bySource.get(i) || { leaks: 0, stuck: 0, n: 0 };
    rows.push({
      port: i, from: names[i],
      cells: row.map((c) => fmtAlphaCI(c.value, c.lo, c.hi)),
      leaks: fmtInt(extra.leaks), stuck: fmtInt(extra.stuck), n: extra.n,
    });
  });
  return { columns: names, rows };
}

/** Bounding-box line (§3.6.7): '150.0 × 40.0 × 40.0 mm · 8192 triangles' (bbox in metres, unit a FILE_UNITS key). */
export function bboxText(bbox, unit, nTri) {
  if (!bbox || bbox.length < 6) return '';
  const s = FILE_UNITS[unit] || 1e-3;
  const d = [bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]].map((x) => Math.abs(x) / s);
  const mx = Math.max(...d);
  const dec = mx > 0 ? Math.max(1, Math.min(6, 3 - Math.floor(Math.log10(mx) + 1e-12))) : 1;
  return d.map((x) => x.toFixed(dec)).join(' × ') + ' ' + unit + ' · ' + fmtInt(nTri) + ' ' + (nTri === 1 ? 'triangle' : 'triangles');
}

/** Size line of a profile: '140.0 mm long, Ø69.12 mm · 2 elements' (bbox [−r, −r, z0, r, r, z1] in metres). */
export function profileBboxText(bbox, unit, nItems) {
  const sc = FILE_UNITS[unit] || 1e-3;
  const L = (bbox[5] - bbox[2]) / sc, D = (bbox[3] - bbox[0]) / sc;
  const dec = (x) => (x > 0 ? Math.max(1, Math.min(6, 3 - Math.floor(Math.log10(x) + 1e-12))) : 1);
  return L.toFixed(dec(L)) + ' ' + unit + ' long, Ø' + D.toFixed(dec(D)) + ' ' + unit + ' · ' + plural(nItems, 'element', 'elements');
}

/** Size-plausibility warning (§3.6.7) for a bounding box in metres: '' or the sentence. */
export function sizeWarning(bbox) {
  if (!bbox || bbox.length < 6) return '';
  const ext = Math.max(bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]);
  return ext < 1e-4 || ext > 10 ? 'That looks too small or too large; check the unit.' : '';
}

/** Triangle cap (§4.5, §6): null when fine, else the refusal sentence. */
export function triangleCapMessage(nTri, phone) {
  const cap = phone ? TRI_CAP_PHONE : TRI_CAP_DESKTOP;
  if (!(nTri > cap)) return null;
  return phone
    ? 'This model has ' + fmtInt(nTri) + ' triangles; phones are limited to 100' + NBSP + '000. Use a desktop browser or reduce the mesh.'
    : 'This model has ' + fmtInt(nTri) + ' triangles; the limit is 250' + NBSP + '000. Reduce the mesh and load it again.';
}

/** Seed field: blank → null (random); a non-negative integer below 2³² → that number; anything else → NaN. */
export function parseSeed(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (!/^\d{1,10}$/.test(t)) return NaN;
  const v = Number(t);
  return v <= 0xffffffff ? v : NaN;
}

/** Worker count shown as "auto" (§2.14): clamp(cores − 1, 1, 8), or 2 at phone width; mesh runs are also limited by memory. */
export function autoWorkers(cores, phone, sceneBytes = 0) {
  let n = phone ? 2 : Math.max(1, Math.min(8, (cores || 4) - 1));
  if (sceneBytes > 0) n = Math.max(1, Math.min(n, Math.floor(SCENE_MEMORY / sceneBytes)));
  return n;
}

/** Bytes of a scene's typed arrays (for the memory-limited worker count). */
export function sceneBytes(scene) {
  if (!scene) return 0;
  let b = 0;
  for (const k of ['tri', 'normal', 'area', 'port', 'origTri', 'box', 'meta']) if (scene[k] && scene[k].byteLength) b += scene[k].byteLength;
  for (const p of scene.ports || []) b += (p.slots ? p.slots.byteLength : 0) + (p.cdf ? p.cdf.byteLength : 0);
  return b;
}

/**
 * Status line of a running or finished run (§4.5): '0.8 M particles · 35 M rays/s · ±1.6 % (95 %) · about 1 s left'.
 */
export function statusLine(p, { target = 0.01 } = {}) {
  if (!p) return '';
  const parts = [fmtCount(p.particles) + ' particles'];
  if (p.castsPerSec > 0) parts.push(fmtCount(p.castsPerSec) + ' rays/s');
  if (isFiniteNum(p.relHalfWidth)) parts.push(fmtRel(p.relHalfWidth) + ' (95 %)');
  if (!p.final) {
    if (isFiniteNum(p.etaSeconds) && p.etaSeconds > 0.5) parts.push('about ' + fmtSeconds(p.etaSeconds) + ' left');
    else if (isFiniteNum(p.relHalfWidth) && p.relHalfWidth <= target) parts.push('finishing');
  }
  return parts.join(' · ');
}

/** Progress fraction (0–1) toward the target or the time limit, whichever is nearer. */
export function progressFraction(p, { target = 0.01, maxTime = 60 } = {}) {
  if (!p) return 0;
  let f = 0;
  if (isFiniteNum(p.relHalfWidth) && p.relHalfWidth > 0 && target > 0) f = Math.max(f, Math.min(1, (target / p.relHalfWidth) ** 2));
  if (isFiniteNum(maxTime) && maxTime > 0 && isFiniteNum(p.elapsed)) f = Math.max(f, Math.min(1, p.elapsed / maxTime));
  if (isFiniteNum(p.etaSeconds) && isFiniteNum(p.elapsed) && p.elapsed + p.etaSeconds > 0) f = Math.max(f, p.elapsed / (p.elapsed + p.etaSeconds));
  return p.final ? 1 : Math.min(0.99, f);
}

/**
 * Comparison with a built-in's reference α (§4.5): 'Reference α = 0.26524 ± 0.00021 (source); this run differs by
 * +0.12 % (1.1σ).' alpha and sigma are the run's α referred to the reference opening.
 */
/** The reference row: { value: the reference α ± σ, note: this run's α and its deviation } (v2.2). */
export function referenceRow(ref, alpha, sigma) {
  if (!ref || !isFiniteNum(ref.alpha)) return { value: '', note: '' };
  const value = ref.alpha + (ref.sigma > 0 ? ' ± ' + Number(ref.sigma.toPrecision(2)) : '');
  const src = ref.source ? 'Reference: ' + ref.source + '. ' : '';
  if (!isFiniteNum(alpha)) return { value, note: src.trim() };
  const dev = alpha / ref.alpha - 1, s = Math.hypot(isFiniteNum(sigma) ? sigma : 0, ref.sigma > 0 ? ref.sigma : 0);
  const z = s > 0 ? Math.abs(alpha - ref.alpha) / s : NaN;
  return { value, note: src + 'This run: ' + fmtAlpha(alpha) + ', ' + fmtSignedPct(dev) + (isFiniteNum(z) ? ' (' + z.toFixed(1) + 'σ)' : '') + '.' };
}

export function referenceLine(ref, alpha, sigma) {
  if (!ref || !isFiniteNum(ref.alpha)) return '';
  const refTxt = 'Reference α = ' + ref.alpha + (ref.sigma > 0 ? ' ± ' + Number(ref.sigma.toPrecision(2)) : '') + (ref.source ? ' (' + ref.source + ')' : '');
  if (!isFiniteNum(alpha)) return refTxt + '.';
  const dev = alpha / ref.alpha - 1;
  const s = Math.hypot(isFiniteNum(sigma) ? sigma : 0, ref.sigma > 0 ? ref.sigma : 0);
  const z = s > 0 ? Math.abs(alpha - ref.alpha) / s : NaN;
  return refTxt + '; this run differs by ' + fmtSignedPct(dev) + (isFiniteNum(z) ? ' (' + z.toFixed(1) + 'σ)' : '') + '.';
}

/** Triangle areas (m², Float64Array) of a non-indexed position array. */
export function triangleAreas(positions) {
  const n = Math.floor(positions.length / 9), A = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const o = 9 * t;
    const ux = positions[o + 3] - positions[o], uy = positions[o + 4] - positions[o + 1], uz = positions[o + 5] - positions[o + 2];
    const vx = positions[o + 6] - positions[o], vy = positions[o + 7] - positions[o + 1], vz = positions[o + 8] - positions[o + 2];
    A[t] = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return A;
}

/**
 * Coplanar patches for "Average over flat faces" (§3.6.6). Triangles are joined across shared edges (vertices
 * matched by exact coordinates) while their normals stay within angleDeg of the region's first triangle (either
 * orientation) and their vertices within 1e-4·diag of its plane, as in mesh.js; each coplanar region is then cut by
 * a grid of `cells` cells across the diagonal, so a long flat strip (a facet of a tube) keeps its gradient along
 * the flow. Returns an Int32Array of patch ids per triangle (−1 for degenerate triangles).
 */
export function trianglePatches(positions, { angleDeg = 0.5, cells = PATCH_CELLS } = {}) {
  const nT = Math.floor(positions.length / 9), nV = 3 * nT;
  const out = new Int32Array(nT).fill(-1);
  if (!nT) return out;
  // vertex ids by exact coordinates (−0 and +0 are the same point)
  const f32 = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  const bits = new Uint32Array(f32.buffer, f32.byteOffset, nV * 3);
  const key = (i) => (bits[i] === 0x80000000 ? 0 : bits[i]);
  let cap = 1; while (cap < 2 * nV) cap <<= 1;
  const mask = cap - 1, table = new Int32Array(cap).fill(-1), vid = new Int32Array(nV);
  let nIds = 0;
  for (let v = 0; v < nV; v++) {
    const a = key(3 * v), b = key(3 * v + 1), c = key(3 * v + 2);
    let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d)) >>> 0;
    h = (h ^ (h >>> 15)) & mask;
    for (;;) {
      const w = table[h];
      if (w < 0) { table[h] = v; vid[v] = nIds++; break; }
      if (key(3 * w) === a && key(3 * w + 1) === b && key(3 * w + 2) === c) { vid[v] = vid[w]; break; }
      h = (h + 1) & mask;
    }
  }
  // manifold edge neighbours
  let ecap = 1; while (ecap < 2 * nV) ecap <<= 1;
  const emask = ecap - 1, eA = new Int32Array(ecap).fill(-1), eB = new Int32Array(ecap), eT = new Int32Array(ecap), eN = new Int32Array(ecap);
  const nbr = new Int32Array(nV).fill(-1);
  for (let t = 0; t < nT; t++) {
    for (let e = 0; e < 3; e++) {
      let a = vid[3 * t + e], b = vid[3 * t + ((e + 1) % 3)];
      if (a === b) continue;
      if (a > b) { const x = a; a = b; b = x; }
      let h = ((Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77)) >>> 0) & emask;
      for (;;) {
        if (eA[h] < 0) { eA[h] = a; eB[h] = b; eT[h] = 3 * t + e; eN[h] = 1; break; }
        if (eA[h] === a && eB[h] === b) {
          eN[h]++;
          if (eN[h] === 2) { const he = eT[h]; nbr[he] = t; nbr[3 * t + e] = (he / 3) | 0; }
          else { nbr[eT[h]] = -1; nbr[3 * t + e] = -1; }       // non-manifold: no joining across this edge
          break;
        }
        h = (h + 1) & emask;
      }
    }
  }
  // planes
  const N = new Float64Array(3 * nT), D = new Float64Array(nT);
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < nV; i++) {
    const x = f32[3 * i], y = f32[3 * i + 1], z = f32[3 * i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const diag = Math.hypot(x1 - x0, y1 - y0, z1 - z0) || 1;
  const ok = new Uint8Array(nT);
  for (let t = 0; t < nT; t++) {
    const o = 9 * t;
    const ux = f32[o + 3] - f32[o], uy = f32[o + 4] - f32[o + 1], uz = f32[o + 5] - f32[o + 2];
    const vx = f32[o + 6] - f32[o], vy = f32[o + 7] - f32[o + 1], vz = f32[o + 8] - f32[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
    if (!(l > 0)) continue;
    ok[t] = 1;
    N[3 * t] = nx / l; N[3 * t + 1] = ny / l; N[3 * t + 2] = nz / l;
    D[t] = (nx * f32[o] + ny * f32[o + 1] + nz * f32[o + 2]) / l;
  }
  const cosTol = Math.cos(angleDeg * Math.PI / 180), distTol = 1e-4 * diag;
  const region = new Int32Array(nT).fill(-1), queue = new Int32Array(nT);
  let nReg = 0;
  for (let seed = 0; seed < nT; seed++) {
    if (!ok[seed] || region[seed] >= 0) continue;
    const r = nReg++, sx = N[3 * seed], sy = N[3 * seed + 1], sz = N[3 * seed + 2], sd = D[seed];
    let qh = 0, qt = 0;
    queue[qt++] = seed; region[seed] = r;
    while (qh < qt) {
      const t = queue[qh++];
      for (let e = 0; e < 3; e++) {
        const u = nbr[3 * t + e];
        if (u < 0 || region[u] >= 0 || !ok[u]) continue;
        if (Math.abs(N[3 * u] * sx + N[3 * u + 1] * sy + N[3 * u + 2] * sz) < cosTol) continue;
        const o = 9 * u;
        let inPlane = true;
        for (let k = 0; k < 3 && inPlane; k++) {
          if (Math.abs(sx * f32[o + 3 * k] + sy * f32[o + 3 * k + 1] + sz * f32[o + 3 * k + 2] - sd) > distTol) inPlane = false;
        }
        if (!inPlane) continue;
        region[u] = r;
        queue[qt++] = u;
      }
    }
  }
  // cut each region by the grid
  const cell = diag / Math.max(1, cells), nc = Math.max(1, cells) + 2;
  const ids = new Map();
  for (let t = 0; t < nT; t++) {
    if (region[t] < 0) continue;
    const o = 9 * t;
    const cxp = (f32[o] + f32[o + 3] + f32[o + 6]) / 3, cyp = (f32[o + 1] + f32[o + 4] + f32[o + 7]) / 3, czp = (f32[o + 2] + f32[o + 5] + f32[o + 8]) / 3;
    const ix = Math.min(nc - 1, Math.max(0, Math.floor((cxp - x0) / cell)));
    const iy = Math.min(nc - 1, Math.max(0, Math.floor((cyp - y0) / cell)));
    const iz = Math.min(nc - 1, Math.max(0, Math.floor((czp - z0) / cell)));
    const k = ((region[t] * nc + ix) * nc + iy) * nc + iz;
    let id = ids.get(k);
    if (id === undefined) { id = ids.size; ids.set(k, id); }
    out[t] = id;
  }
  return out;
}

/**
 * Wall pressure p/p_in per triangle (§3.6.6) in prepared order (mesh + caps): p_t = (h_t/A_t)/(Σ_i N_i/A_i) over the
 * inlet ports. Only wall triangles (triPort −1) get values; with `patches` each value is the patch's Σh/ΣA. Values
 * with fewer than minHits hits (in the triangle, or in its patch) are NaN ("not enough hits").
 *   hits: per triangle (prepared order); areas: per triangle (m²); inletLaunches: [{ port, n }];
 *   portAreas: area per scene port index.
 * Returns { p: Float64Array, valid: count, norm }.
 */
export function wallPressureValues({ hits, areas, triPort, inletLaunches, portAreas, patches = null, minHits = MIN_HITS }) {
  const n = areas.length, p = new Float64Array(n).fill(NaN);
  let norm = 0;
  for (const l of inletLaunches || []) { const A = portAreas[l.port]; if (A > 0 && l.n > 0) norm += l.n / A; }
  if (!(norm > 0) || !hits) return { p, valid: 0, norm };
  let valid = 0;
  const wall = (t) => !triPort || triPort[t] === -1;
  if (patches) {
    const H = new Map(), AA = new Map();
    for (let t = 0; t < n; t++) {
      const id = patches[t];
      if (!wall(t) || id < 0) continue;
      H.set(id, (H.get(id) || 0) + (hits[t] || 0));
      AA.set(id, (AA.get(id) || 0) + areas[t]);
    }
    for (let t = 0; t < n; t++) {
      if (!wall(t)) continue;
      const id = patches[t];
      const h = id >= 0 ? H.get(id) : (hits[t] || 0), A = id >= 0 ? AA.get(id) : areas[t];
      if (h >= minHits && A > 0) { p[t] = h / (A * norm); valid++; }
    }
  } else {
    for (let t = 0; t < n; t++) {
      if (!wall(t)) continue;
      const h = hits[t] || 0;
      if (h >= minHits && areas[t] > 0) { p[t] = h / (areas[t] * norm); valid++; }
    }
  }
  return { p, valid, norm };
}

/** Pressure-map colours: { rgb (Float32Array 3·n, NaN = not enough hits), scale (logScale) }. */
export function pressureColors(p) {
  const scale = logScale(p, { floor: 1e-9 });
  return { rgb: colorsFromT(scale.t), scale };
}

/** True when the passage bends (inlet and outlet axes differ by more than 10°): the axial profile is only indicative. */
export function isBent(scene, inletPort, outletPort) {
  const a = scene && scene.ports && scene.ports[inletPort], b = scene && scene.ports && scene.ports[outletPort];
  if (!a || !b || !a.inward || !b.inward) return false;
  const d = -(a.inward[0] * b.inward[0] + a.inward[1] * b.inward[1] + a.inward[2] * b.inward[2]);
  return d < Math.cos(10 * Math.PI / 180);
}

/** Clausing's wall profile (CLAUSING_PROFILE_LR20) for a built-in tube with L/R = 20, else null. */
export function clausingOverlay(source) {
  if (!source || source.kind !== 'builtin' || source.name !== 'tube') return null;
  const P = source.params || {};
  const d = isFiniteNum(P.d) ? P.d : 0.04, L = isFiniteNum(P.L) ? P.L : 0.2;
  if (Math.abs(L / (d / 2) - 20) > 1e-6) return null;
  return { zOverL: Array.from(CLAUSING_PROFILE_LR20.z_over_L), value: Array.from(CLAUSING_PROFILE_LR20.p_over_pin) };
}

// ------------------------------------------------------------------ 2D profiles (P2, §3.6.8)

/** 'svg' or 'dxf' from a file name, else from the text. */
export function profileFormat(name, text) {
  if (/\.svg$/i.test(name || '')) return 'svg';
  if (/\.dxf$/i.test(name || '')) return 'dxf';
  return /<svg[\s>]/i.test(String(text || '').slice(0, 4096)) ? 'svg' : 'dxf';
}

/** Metres per drawing unit: the file's own unit when it states one ('mm' or 'in'), else the unit select's. */
export function profileScale(unitHint, unit) {
  if (unitHint === 'mm') return 1e-3;
  if (unitHint === 'in') return 0.0254;
  return FILE_UNITS[unit] || 1e-3;
}

/**
 * Display mesh of a profile's lathe (profile2d: (r, z) pairs in metres, NaN pairs between the outer wall and each
 * inner body), revolved about the z axis with `segments` facets. The ends become caps: the inlet (port 0) at the
 * first point of the outer wall and the outlet (port 1) at its last, as rings when a rod reaches the end.
 * Returns { positions: Float32Array (9 per triangle), triPort: Int16Array, inletArea, outletArea }.
 */
export function latheMesh(lathe, segments = 64) {
  const chains = [];
  let cur = [];
  for (let i = 0; i + 1 < (lathe ? lathe.length : 0); i += 2) {
    const r = lathe[i], z = lathe[i + 1];
    if (!Number.isFinite(r) || !Number.isFinite(z)) { if (cur.length) chains.push(cur); cur = []; continue; }
    cur.push([Math.max(0, r), z]);
  }
  if (cur.length) chains.push(cur);
  const out = [], port = [];
  const n = Math.max(8, segments | 0);
  const cs = Array.from({ length: n + 1 }, (_, k) => (k === n ? [1, 0] : [Math.cos(2 * Math.PI * k / n), Math.sin(2 * Math.PI * k / n)]));   // the seam closes exactly
  const P = (r, z, k) => [r * cs[k][0], r * cs[k][1], z];
  const tri = (a, b, c, id) => { out.push(...a, ...b, ...c); port.push(id); };
  for (const ch of chains) {
    for (let j = 0; j + 1 < ch.length; j++) {
      const [r0, z0] = ch[j], [r1, z1] = ch[j + 1];
      if (r0 === 0 && r1 === 0) continue;
      for (let k = 0; k < n; k++) {
        const a = P(r0, z0, k), b = P(r0, z0, k + 1), c = P(r1, z1, k + 1), d = P(r1, z1, k);
        if (r0 > 0) tri(a, b, c, -1);
        if (r1 > 0) tri(a, c, d, -1);
      }
    }
  }
  const outer = chains[0] || [];
  const tol = 1e-9 + 1e-6 * Math.abs((outer.length ? outer[outer.length - 1][1] - outer[0][1] : 0));
  // the rod radius at an end, if an inner body reaches it
  const rodAt = (z) => {
    let ri = 0;
    for (const ch of chains.slice(1)) for (const e of [ch[0], ch[ch.length - 1]]) if (Math.abs(e[1] - z) <= tol) ri = Math.max(ri, e[0]);
    return ri;
  };
  const cap = (end, id) => {
    if (!end) return 0;
    const [ro, z] = end, ri = Math.min(rodAt(z), ro);
    for (let k = 0; k < n; k++) {
      if (ri > 0) { tri(P(ri, z, k), P(ro, z, k), P(ro, z, k + 1), id); tri(P(ri, z, k), P(ro, z, k + 1), P(ri, z, k + 1), id); }
      else tri([0, 0, z], P(ro, z, k), P(ro, z, k + 1), id);
    }
    return Math.PI * (ro * ro - ri * ri);
  };
  const inletArea = cap(outer[0], 0), outletArea = cap(outer[outer.length - 1], 1);
  return { positions: Float32Array.from(out), triPort: Int16Array.from(port), inletArea, outletArea };
}

/** The scene's inlet and outlet (or pump) indices, as the runner picks them (first of each role). */
export function scenePortIndices(scene) {
  const ports = (scene && scene.ports) || [];
  const find = (role) => { const k = ports.findIndex((p) => p.role === role); return k < 0 ? null : k; };
  const inlet = find('inlet');
  let outlet = find('outlet');
  const pump = find('pump');
  if (outlet === null) outlet = pump;
  return { inlet, outlet, pump };
}

/** PortSpec list for the prep worker: pump speeds are converted to sticking coefficients with the current gas. */
export function portSpecsForScene(ports, report, G) {
  return ports.map((p) => {
    let stick = p.role === 'closed' ? null : 1, speed = null;
    if (p.role === 'pump') {
      if (p.pumpBy === 'stick' || !isFiniteNum(p.speed)) stick = p.stick;
      else {
        const A = portArea(p, report);
        stick = G && A > 0 ? Math.min(1, stickFromSpeed(p.speed, A, G)) : null;
        if (stick === null) speed = p.speed;
      }
    }
    return {
      id: p.id, name: p.name, kind: p.kind, loops: p.kind === 'loop' ? p.loops : null,
      tris: p.kind === 'region' ? p.tris : null, role: p.role, stick, speed,
    };
  });
}

/** PortSpec list for the project file: pumps keep the user's choice (speed or sticking coefficient). */
export function portSpecsForProject(ports) {
  return ports.map((p) => ({
    id: p.id, name: p.name, kind: p.kind, loops: p.kind === 'loop' ? p.loops : null,
    tris: p.kind === 'region' ? p.tris : null, role: p.role,
    stick: p.role === 'pump' ? (p.pumpBy === 'stick' ? p.stick : null) : (p.role === 'closed' ? null : 1),
    speed: p.role === 'pump' && p.pumpBy !== 'stick' ? p.speed : null,
  }));
}

/** UI port from a PortSpec (from the prep worker or a project file). */
export function uiPort(spec, k) {
  const pumpBy = spec.role === 'pump' && (spec.speed === null || spec.speed === undefined) && isFiniteNum(spec.stick) ? 'stick' : 'speed';
  return {
    id: Number.isInteger(spec.id) ? spec.id : k, name: typeof spec.name === 'string' && spec.name ? spec.name : 'Opening ' + (k + 1),
    kind: spec.kind === 'region' ? 'region' : 'loop',
    loops: spec.loops ? spec.loops.map((g) => (Array.isArray(g) || ArrayBuffer.isView(g) ? Array.from(g) : g)) : null,
    tris: spec.tris ? (spec.tris instanceof Uint32Array ? spec.tris : Uint32Array.from(spec.tris)) : null,
    area: isFiniteNum(spec.area) ? spec.area : undefined,
    role: ROLES.includes(spec.role) ? spec.role : 'outlet',
    stick: isFiniteNum(spec.stick) ? spec.stick : (spec.role === 'pump' ? null : 1),
    speed: isFiniteNum(spec.speed) ? spec.speed : null,
    pumpBy,
  };
}

/** Key of the conditions that change v̄ (gas, temperature, custom gas). */
export function gasKey(s) {
  return JSON.stringify([s && s.gas, s && s.T, s && s.custom]);
}

/** GasState of store values (gas.gasState; throws RangeError for invalid custom data). */
export function gasFromSettings(s) {
  return gasState(s.gas || 'N2', isFiniteNum(s.T) ? s.T : 293.15, s.gas === 'custom' ? s.custom : null, s.Cd ?? null);
}

/** Copy of a Float32Array that is the concatenation of a and b. */
function concatF32(a, b) {
  const out = new Float32Array(a.length + (b ? b.length : 0));
  out.set(a, 0);
  if (b) out.set(b, a.length);
  return out;
}

function sameArray(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return false;
  return true;
}

// ==================================================================================================================
// 2. Prep-worker client and the DOM-free controller
// ==================================================================================================================

/**
 * Request/reply client over the prep worker (§2.13): request(msg, transfer) → Promise<reply>; { type: 'error' }
 * replies reject with the worker's message. Works with any Worker-like object { postMessage, onmessage, onerror }.
 */
export function createPrepClient(worker) {
  let next = 1;
  const pending = new Map();
  let broken = null;
  worker.onmessage = (e) => {
    const m = e && e.data;
    if (!m || !pending.has(m.id)) return;
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message || 'The geometry worker failed.'));
    else p.resolve(m);
  };
  worker.onerror = (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    broken = 'The geometry worker could not run' + (e && e.message ? ' (' + e.message + ')' : '') + '. Reload the page, or use a current Chrome, Edge, Firefox or Safari.';
    for (const p of pending.values()) p.reject(new Error(broken));
    pending.clear();
  };
  return {
    request(msg, transfer = []) {
      if (broken) return Promise.reject(new Error(broken));
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { worker.postMessage({ ...msg, id }, transfer); } catch (err) { pending.delete(id); reject(err); }
      });
    },
    dispose() { for (const p of pending.values()) p.reject(new Error('The CAD tab was closed.')); pending.clear(); try { worker.terminate(); } catch (_) { /* gone */ } },
  };
}

/**
 * DOM-free state of the CAD tab. options: { prep (createPrepClient result), getRunner (→ McRunner or a Promise of
 * one), settings() (→ store values { gas, T, custom, Cd, lu, su, pu }), phone (bool), debounceMs }.
 * Listeners get a Set of change tags: 'model', 'ports', 'scene', 'pending', 'results', 'progress', 'run',
 * 'message', 'gas'.
 */
export class CadController {
  constructor({ prep, getRunner, settings, phone = false, debounceMs = 60 }) {
    this.prep = prep;
    this.getRunner = getRunner;
    this.settings = typeof settings === 'function' ? settings : () => ({ gas: 'N2', T: 293.15, custom: null, Cd: null });
    this.phone = !!phone;
    this.debounceMs = debounceMs;
    this.listeners = new Set();
    this.gen = 0;              // model generation: replies for an older model are ignored
    this.sceneSeq = 0;
    this.sceneTimer = null;
    this.runToken = 0;
    this.runner = null;
    this.s = {
      phase: 'empty', source: null, unit: 'mm', file: null, parsed: null,
      prepared: null, report: null, reference: null, referencePortId: null, defaultPorts: [],
      ports: [], pending: null, selecting: false,
      scene: null, capPositions: null, triPort: null, allPositions: null, sceneReady: false, scenePending: false, sceneError: null, sceneMs: null,
      results: null, live: null, running: false, stopping: false,
      runOpts: { target: 0.01, maxTime: 60, seed: '', favorSmall: false, trajectories: !phone },
      message: null, gasError: null, G: null, gasKey: null,
      areas: null, patches: null,
      profile: null, profileTriPort: null,
    };
    this.readGas();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(...tags) { const t = new Set(tags); for (const fn of this.listeners) { try { fn(t, this.s); } catch (_) { /* a listener must not break the controller */ } } }

  get state() { return this.s; }

  setMessage(level, text) { this.s.message = text ? { level, text } : null; this.emit('message'); }

  // ---------------------------------------------------------------- gas
  readGas() {
    const st = this.settings() || {};
    try {
      this.s.G = gasFromSettings(st);
      this.s.gasError = null;
    } catch (err) {
      this.s.gasError = err && err.message ? err.message : 'The gas data are not valid.';
    }
    this.s.gasKey = gasKey(st);
    return this.s.G;
  }

  /** The store changed: a new gas or temperature recomputes C from the counts, or clears them (§4.5). */
  conditionsChanged() {
    const before = this.s.gasKey;
    this.readGas();
    if (this.s.gasKey === before && !this.s.gasError) { this.emit('gas'); return; }
    const pumpBySpeed = this.s.ports.some((p) => p.role === 'pump' && p.pumpBy !== 'stick');
    if (this.s.gasError) { this.emit('gas', 'results'); return; }
    if (pumpBySpeed) this.scheduleScene();       // the sticking coefficient follows the gas
    if (this.s.running) { this.s.gasChangedDuringRun = true; this.emit('gas'); return; }
    const effect = changeEffect('gas', { pumpBySpeed });
    if (this.s.results && effect === 'clear') this.clearResults('The pump’s sticking coefficient depends on the gas; run again for the new gas.');
    else if (this.s.results) this.recompute();
    this.emit('gas', 'results');
  }

  recompute() {
    const r = this.s.results;
    if (!r || !this.s.G) return;
    if (r.kind === 'chain') {
      const c = combinePlan(r.plan, r.blocks, this.s.G);
      Object.assign(r, { value: c.value, sigma: c.sigma, ci95: c.ci95, G: this.s.G, formula: profileFormula(r.items, this.s.G) });
      return;
    }
    r.summary = summarizeCounts(r.ports, r.perSource, this.s.G, { inletPort: r.inletPort, outletPort: r.outletPort });
    r.G = this.s.G;
  }

  clearResults(note = null) {
    if (!this.s.results && !this.s.live) return;
    this.s.results = null;
    this.s.live = null;
    this.s.clearedNote = note;
    this.emit('results');
  }

  // ---------------------------------------------------------------- loading
  beginLoad() {
    this.gen++;
    this.cancelScene();
    Object.assign(this.s, {
      phase: 'loading', prepared: null, report: null, reference: null, referencePortId: null, ports: [], defaultPorts: [],
      pending: null, selecting: false, scene: null, capPositions: null, triPort: null, allPositions: null,
      sceneReady: false, scenePending: false, sceneError: null, areas: null, patches: null, message: null,
      profile: null, profileTriPort: null,
    });
    this.s.results = null; this.s.live = null; this.s.clearedNote = null;
    this.emit('model', 'ports', 'scene', 'pending', 'results', 'message');
    return this.gen;
  }

  failLoad(gen, err) {
    if (gen !== this.gen) return;
    this.s.phase = this.s.prepared ? 'ready' : 'empty';
    this.setMessage('error', err && err.message ? err.message : String(err));
    this.emit('model');
  }

  acceptPrepared(gen, reply, { ports = null, reference = null } = {}) {
    if (gen !== this.gen) return false;
    const report = reply.report || null;
    this.s.prepared = { positions: reply.positions, nTri: report ? report.nTri : Math.floor(reply.positions.length / 9) };
    this.s.report = report;
    this.s.reference = reference ?? reply.reference ?? null;
    const defaults = (reply.suggestedPorts || reply.autoPorts || []).map(uiPort);
    this.s.defaultPorts = defaults;
    this.s.ports = (ports || defaults).map((p, k) => ({ ...uiPort(p, k) }));
    for (const p of this.s.ports) if (p.kind === 'loop') p.area = portArea(p, report);
    const refPort = defaults.find((p) => p.role === 'inlet');
    this.s.referencePortId = refPort ? refPort.id : null;
    this.s.phase = 'ready';
    this.s.allPositions = reply.positions;
    this.s.triPort = null;
    this.emit('model', 'ports', 'scene');
    this.scheduleScene(0);
    return true;
  }

  /** Loads a built-in geometry (§7.4) through the prep worker. */
  async loadBuiltin(name, params = {}) {
    if (this.s.running) return;
    const gen = this.beginLoad();
    this.s.source = { kind: 'builtin', name, params: { ...params } };
    this.s.file = null; this.s.parsed = null; this.s.projectMesh = null;
    try {
      const reply = await this.prep.request({ type: 'builtin', name, params });
      if (reply.label && this.s.source && gen === this.gen) this.s.source.label = reply.label;
      this.acceptPrepared(gen, reply);
    } catch (err) { this.failLoad(gen, err); }
  }

  /** Loads an STL or OBJ: { name, buffer (ArrayBuffer) } or a File/Blob with a name. */
  async loadFile(file) {
    if (this.s.running) return;
    const gen = this.beginLoad();
    try {
      const buffer = file.buffer instanceof ArrayBuffer ? file.buffer : await file.arrayBuffer();
      if (gen !== this.gen) return;
      this.s.file = { name: file.name || 'model', buffer };
      this.s.projectMesh = null;
      this.s.source = { kind: 'file', name: file.name || 'model', format: '' };
      await this.parseAndPrepare(gen);
    } catch (err) { this.failLoad(gen, err); }
  }

  async parseAndPrepare(gen, weldTol = null) {
    const f = this.s.file;
    const scale = FILE_UNITS[this.s.unit] || 1e-3;
    const copy = f.buffer.slice(0);
    const parsed = await this.prep.request({ type: 'parse', name: f.name, buffer: copy, format: 'auto', scale }, [copy]);
    if (gen !== this.gen) return;
    this.s.parsed = { nTri: parsed.nTri, format: parsed.format, warnings: parsed.warnings || [], bbox: parsed.bbox };
    if (this.s.source && this.s.source.kind === 'file') this.s.source.format = parsed.format || '';
    const capMsg = triangleCapMessage(parsed.nTri, this.phone);
    if (capMsg) { this.s.phase = 'empty'; this.s.source = null; this.setMessage('error', capMsg); this.emit('model'); return; }
    const reply = await this.prep.request({ type: 'prepare', weldTol: weldTol ?? null });
    this.acceptPrepared(gen, reply);
    const warn = (parsed.warnings || []).join(' ');
    if (warn && gen === this.gen) this.setMessage('warn', warn);
  }

  /** File unit (§4.5): rescales a loaded file (clearing results); for a built-in it only changes the shown numbers. */
  async setUnit(unit) {
    if (!FILE_UNITS[unit] || this.s.running) return;
    const was = this.s.unit;
    if (unit === was) return;
    this.s.unit = unit;
    const src = this.s.source;
    if (src && src.kind === 'profile' && this.s.profile) {
      if (this.s.profile.unitHint) { this.emit('model'); return; }     // the drawing states its own unit
      this.convertProfile();
    } else if (src && src.kind === 'file' && this.s.file) {
      const gen = this.beginLoad();
      try { await this.parseAndPrepare(gen); } catch (err) { this.failLoad(gen, err); }
    } else if (src && src.kind === 'file' && this.s.projectMesh) {
      // a mesh from a project is stored in metres: reinterpret its numbers in the new unit
      const f = FILE_UNITS[unit] / FILE_UNITS[was];
      const m = this.s.projectMesh;
      const vertices = new Float32Array(m.vertices.length);
      for (let i = 0; i < vertices.length; i++) vertices[i] = m.vertices[i] * f;
      this.s.projectMesh = { vertices, triangles: m.triangles };
      const gen = this.beginLoad();
      try {
        const reply = await this.prep.request({ type: 'loadMesh', vertices: vertices.slice(), triangles: m.triangles.slice(), weldTol: null });
        this.acceptPrepared(gen, reply);
      } catch (err) { this.failLoad(gen, err); }
    } else this.emit('model');     // a built-in keeps its size: only the shown numbers change
  }

  /** Re-checks a loaded file with a new merge tolerance (m; null = default). */
  async setWeldTol(weldTol) {
    if (this.s.running || !this.s.source || this.s.source.kind !== 'file') return;
    const gen = this.beginLoad();
    try {
      if (this.s.file) await this.parseAndPrepare(gen, weldTol);
      else if (this.s.projectMesh) {
        const m = this.s.projectMesh;
        const reply = await this.prep.request({ type: 'loadMesh', vertices: m.vertices.slice(), triangles: m.triangles.slice(), weldTol });
        this.acceptPrepared(gen, reply);
      }
    } catch (err) { this.failLoad(gen, err); }
  }

  // ---------------------------------------------------------------- 2D profiles (P2)
  /** Loads an SVG or DXF axisymmetric profile: { name, text } or a File (§3.6.8). */
  async loadProfile(file) {
    if (this.s.running) return;
    const gen = this.beginLoad();
    try {
      const text = typeof file.text === 'string' ? file.text : await file.text();
      if (gen !== this.gen) return;
      const name = file.name || 'profile';
      const format = profileFormat(name, text);
      const parsed = format === 'svg' ? parseSVGProfile(text) : parseDXFProfile(text);
      this.s.source = { kind: 'profile', name, format };
      this.s.file = null; this.s.projectMesh = null;
      this.s.profile = { name, format, paths: parsed.paths, unitHint: parsed.unitHint || null, warnings: parsed.warnings || [], axis: 'min', items: null, lathe: null };
      if (parsed.unitHint) this.s.unit = parsed.unitHint;
      this.convertProfile(gen);
    } catch (err) {
      this.s.source = null; this.s.profile = null;
      this.failLoad(gen, err);
    }
  }

  /** Profile → items and lathe with the current unit and axis; clears results (the geometry changed). */
  convertProfile(gen = this.gen) {
    const pf = this.s.profile;
    if (!pf || gen !== this.gen) return;
    this.s.results = null; this.s.live = null;
    try {
      const { items, lathe } = profileToItems(pf.paths, { scale: profileScale(pf.unitHint, this.s.unit), axis: pf.axis });
      const m = latheMesh(lathe, 64);
      pf.items = items; pf.lathe = lathe; pf.inletArea = m.inletArea; pf.outletArea = m.outletArea; pf.error = null;
      let z0 = Infinity, z1 = -Infinity, rmax = 0;
      for (let i = 0; i + 1 < lathe.length; i += 2) if (Number.isFinite(lathe[i])) { z0 = Math.min(z0, lathe[i + 1]); z1 = Math.max(z1, lathe[i + 1]); rmax = Math.max(rmax, lathe[i]); }
      pf.bbox = [-rmax, -rmax, z0, rmax, rmax, z1];
      this.s.allPositions = m.positions;
      this.s.profileTriPort = m.triPort;
      this.s.phase = 'profile';
      this.setMessage(pf.warnings.length ? 'warn' : null, pf.warnings.length ? pf.warnings.join(' ') : null);
    } catch (err) {
      pf.items = null; pf.lathe = null; pf.error = err && err.message ? err.message : String(err);
      this.s.allPositions = null; this.s.profileTriPort = null;
      this.s.phase = 'profile';
      this.setMessage('error', pf.error);
    }
    this.emit('model', 'ports', 'scene', 'results');
  }

  /** Axis of the drawing: 'min' (the lowest r) or 'zero' (y = 0). */
  setProfileAxis(axis) {
    const pf = this.s.profile;
    if (!pf || this.s.running || (axis !== 'min' && axis !== 'zero') || pf.axis === axis) return;
    pf.axis = axis;
    this.convertProfile();
  }

  /** Simulates the profile exactly with the analytic chain Monte Carlo (§3.6.2), as a line between two pressures. */
  async runProfile(opts = {}) {
    Object.assign(this.s.runOpts, opts);
    let runner;
    try { runner = await this.resolveRunner(); } catch (err) { this.setMessage('error', err && err.message ? err.message : String(err)); return; }
    const en = this.enableState(!!(runner && runner.busy));
    if (!en.ok) { this.setMessage(runner && runner.busy ? 'warn' : 'error', en.reason); return; }
    const o = this.s.runOpts, seed = parseSeed(o.seed);
    if (Number.isNaN(seed)) { this.setMessage('error', 'The seed must be a whole number from 0 to 4294967295, or blank for a random seed.'); return; }
    const pf = this.s.profile, G = this.s.G;
    const plan = chainPlan(pf.items, G, { bc: { mode: 'dp', p0: 1, p1: 0 } });
    if (plan.unsupported) { this.setMessage('error', plan.unsupported.join(' ')); return; }
    const token = ++this.runToken;
    Object.assign(this.s, { running: true, stopping: false, results: null, clearedNote: null, message: null });
    this.s.live = { progress: null, history: [], started: Date.now() };
    this.emit('run', 'results', 'message');
    let result = null, error = null;
    try {
      result = await runner.runChain(plan, G, {
        target: o.target, maxTime: Number.isFinite(o.maxTime) ? o.maxTime : null, seed: seed === null ? (Date.now() >>> 0) : seed,
        onProgress: (p) => {
          if (token !== this.runToken || !this.s.live) return;
          this.s.live.progress = p;
          if (p.history) this.s.live.history = p.history;
          this.emit('progress');
        },
      });
    } catch (err) { error = err; }
    if (token !== this.runToken) return;
    const history = this.s.live ? this.s.live.history : [];
    this.s.running = false; this.s.stopping = false; this.s.live = null;
    if (error) this.setMessage('error', error.message || String(error));
    else {
      this.s.results = {
        kind: 'chain', plan, items: pf.items, blocks: result.blocks, value: result.value, sigma: result.sigma, ci95: result.ci95,
        particles: result.particles || 0, casts: result.casts || 0, ms: result.ms || 0, stopped: !!result.stopped,
        reason: result.reason || (result.stopped ? 'stopped' : null), seed: result.seed ?? null, history, target: o.target,
        G: this.s.G, formula: profileFormula(pf.items, this.s.G), ports: [], perSource: [], leaksPerMillion: 0, stuck: 0,
      };
      if (this.s.gasKey !== null) this.recompute();
    }
    this.emit('run', 'results');
  }

  // ---------------------------------------------------------------- ports
  portById(id) { return this.s.ports.find((p) => p.id === id) || null; }

  changePorts(kind) {
    if (this.s.results && changeEffect(kind) === 'clear') this.clearResults();
    this.emit('ports');
    this.scheduleScene();
  }

  setRole(id, role) {
    const p = this.portById(id);
    if (!p || !ROLES.includes(role) || p.role === role || this.s.running) return;
    p.role = role;
    if (role === 'pump' && !(isFiniteNum(p.speed) && p.speed > 0)) {
      // a new pump starts as a perfect one (sticking coefficient 1, S = A·v̄/4) until a speed is entered
      p.pumpBy = 'stick';
      if (!(p.stick > 0 && p.stick <= 1)) p.stick = 1;
    }
    this.changePorts('role');
  }

  setName(id, name) {
    const p = this.portById(id);
    if (!p) return;
    p.name = String(name || '').slice(0, 60) || p.name;
    this.emit('ports');
    if (this.s.results) {
      for (const sp of this.s.results.ports) if (sp.id === id) sp.name = p.name;
      this.emit('results');
    }
  }

  /** Pump given by speed (m³/s) or by sticking coefficient. */
  setPump(id, { by, speed, stick } = {}) {
    const p = this.portById(id);
    if (!p || this.s.running) return;
    const G = this.s.G, A = portArea(p, this.s.report);
    if (by && by !== p.pumpBy) {
      // keep the same physical pump when switching between the two inputs
      if (by === 'stick' && isFiniteNum(p.speed) && G && A > 0) p.stick = Math.min(1, stickFromSpeed(p.speed, A, G));
      if (by === 'speed' && isFiniteNum(p.stick) && G && A > 0) p.speed = speedFromStick(p.stick, A, G);
      p.pumpBy = by;
    }
    if (speed !== undefined) p.speed = isFiniteNum(speed) ? speed : NaN;
    if (stick !== undefined) p.stick = isFiniteNum(stick) ? stick : NaN;
    this.changePorts('pump');
  }

  /** Restores the detected (or built-in) openings and roles. */
  autoDetect() {
    if (this.s.running || !this.s.prepared) return;
    this.s.ports = this.s.defaultPorts.map((p, k) => ({ ...uiPort(p, k), area: p.kind === 'loop' ? portArea(p, this.s.report) : p.area }));
    this.s.pending = null;
    this.changePorts('region');
    this.emit('pending');
  }

  setSelecting(on) { this.s.selecting = !!on; if (!on) this.s.pending = null; this.emit('pending'); }

  /** A click in the view while selecting: asks the prep worker for the coplanar region around the triangle. */
  async pickRegion(tri) {
    if (!this.s.selecting || this.s.running || !this.s.prepared || !Number.isInteger(tri) || tri < 0) return;
    if (tri >= this.s.prepared.nTri) { this.setMessage('info', 'That face is already an opening.'); return; }
    const owner = this.s.ports.find((p) => p.kind === 'region' && p.tris && p.tris.includes(tri));
    if (owner) { this.setMessage('info', 'That face is already part of "' + owner.name + '".'); return; }
    const gen = this.gen;
    try {
      const r = await this.prep.request({ type: 'region', seedTri: tri, angleDeg: 0.5, distTol: null });
      if (gen !== this.gen || !this.s.selecting) return;
      const tris = r.tris instanceof Uint32Array ? r.tris : Uint32Array.from(r.tris || []);
      const taken = new Set();
      for (const p of this.s.ports) if (p.kind === 'region' && p.tris) for (const t of p.tris) taken.add(t);
      if (tris.some((t) => taken.has(t))) { this.setMessage('info', 'That face overlaps an opening that is already defined.'); return; }
      this.s.pending = { tris, plane: r.plane, area: r.area, seedTri: tri };
      this.setMessage(null, null);
      this.emit('pending');
    } catch (err) {
      if (gen === this.gen) this.setMessage('error', err.message);
    }
  }

  /** Adds the pending selection as a region opening (inlet if there is none yet, else outlet). */
  addPending() {
    const pd = this.s.pending;
    if (!pd || this.s.running) return null;
    const id = this.s.ports.reduce((m, p) => Math.max(m, p.id), -1) + 1;
    const hasInlet = this.s.ports.some((p) => p.role === 'inlet');
    const n = this.s.ports.length + 1;
    const port = { id, name: 'Opening ' + n, kind: 'region', loops: null, tris: pd.tris, area: pd.area, role: hasInlet ? 'outlet' : 'inlet', stick: 1, speed: null, pumpBy: 'speed' };
    this.s.ports.push(port);
    this.s.pending = null;
    this.emit('pending');
    this.changePorts('region');
    return port;
  }

  cancelPending() { this.s.pending = null; this.emit('pending'); }

  removePort(id) {
    const k = this.s.ports.findIndex((p) => p.id === id);
    if (k < 0 || this.s.ports[k].kind !== 'region' || this.s.running) return;
    this.s.ports.splice(k, 1);
    this.changePorts('region');
  }

  // ---------------------------------------------------------------- scene
  cancelScene() { if (this.sceneTimer) { clearTimeout(this.sceneTimer); this.sceneTimer = null; } this.sceneSeq++; }

  scheduleScene(delay = this.debounceMs) {
    if (!this.s.prepared) return;
    if (this.sceneTimer) clearTimeout(this.sceneTimer);
    this.s.scenePending = true;
    this.s.sceneReady = false;
    this.sceneTimer = setTimeout(() => { this.sceneTimer = null; this.buildScene(); }, delay);
  }

  /** Asks the prep worker for the MeshScene of the current ports; resolves when it is in place (or failed). */
  async buildScene() {
    if (!this.s.prepared) return;
    const seq = ++this.sceneSeq, gen = this.gen;
    this.s.scenePending = true;
    const specs = portSpecsForScene(this.s.ports, this.s.report, this.s.G);
    const t0 = Date.now();
    try {
      const r = await this.prep.request({ type: 'scene', ports: specs });
      if (seq !== this.sceneSeq || gen !== this.gen) return;
      const caps = r.capPositions || new Float32Array(0);
      if (!this.s.allPositions || this.s.allPositions === this.s.prepared.positions || !sameArray(caps, this.s.capPositions)) {
        this.s.allPositions = concatF32(this.s.prepared.positions, caps);
        this.s.areas = null;
        this.s.patches = null;
      }
      this.s.capPositions = caps;
      this.s.scene = r.scene;
      this.s.triPort = r.triPort instanceof Int16Array ? r.triPort : Int16Array.from(r.triPort || []);
      this.s.sceneMs = r.ms ?? (Date.now() - t0);
      this.s.sceneError = null;
      this.s.sceneReady = true;
      this.s.scenePending = false;
      for (const sp of r.scene.ports || []) {
        const p = this.portById(sp.id);
        if (p && sp.area > 0) p.area = sp.area;
      }
      this.emit('scene', 'ports');
    } catch (err) {
      if (seq !== this.sceneSeq || gen !== this.gen) return;
      this.s.scene = null;
      this.s.sceneReady = false;
      this.s.scenePending = false;
      this.s.sceneError = err && err.message ? err.message : String(err);
      this.emit('scene', 'ports');
    }
  }

  /** Waits for a pending scene build (used before a run). */
  async sceneSettled() {
    if (this.sceneTimer) { clearTimeout(this.sceneTimer); this.sceneTimer = null; await this.buildScene(); }
    for (let i = 0; i < 400 && this.s.scenePending; i++) await new Promise((r) => setTimeout(r, 25));
  }

  /** triPort for the view: the scene's, plus region ports not yet in the scene and the pending selection (−2). */
  viewTriPort() {
    const all = this.s.allPositions;
    if (!all) return null;
    if (this.s.phase === 'profile') return this.s.profileTriPort;
    const n = Math.floor(all.length / 9);
    const base = this.s.triPort && this.s.triPort.length === n ? Int16Array.from(this.s.triPort) : new Int16Array(n).fill(-1);
    if (!(this.s.triPort && this.s.triPort.length === n)) {
      for (const p of this.s.ports) if (p.kind === 'region' && p.tris) for (const t of p.tris) if (t < n) base[t] = p.id;
    } else {
      // region ports added or removed since the scene was built
      const ids = new Set(this.s.ports.map((p) => p.id));
      for (let t = 0; t < n; t++) if (base[t] >= 0 && !ids.has(base[t])) base[t] = -1;
      for (const p of this.s.ports) if (p.kind === 'region' && p.tris) for (const t of p.tris) if (t < n) base[t] = p.id;
    }
    if (this.s.pending) for (const t of this.s.pending.tris) if (t < n) base[t] = SELECTION_ID;
    return base;
  }

  viewPortColors() {
    if (this.s.phase === 'profile') return { 0: ROLE_TOKENS.inlet, 1: ROLE_TOKENS.outlet };
    const c = {};
    for (const p of this.s.ports) c[p.id] = ROLE_TOKENS[p.role] || ROLE_TOKENS.outlet;
    if (this.s.pending) c[SELECTION_ID] = SELECTION_TOKEN;
    return c;
  }

  // ---------------------------------------------------------------- run
  enableState(runnerBusy = false) {
    if (this.s.phase === 'profile') {
      const pf = this.s.profile;
      if (this.s.running) return { ok: false, reason: 'A simulation is running.' };
      if (!pf || !pf.items) return { ok: false, reason: pf && pf.error ? pf.error : 'Load a 2D profile.' };
      if (this.s.gasError) return { ok: false, reason: 'Paused: fix the gas data above.' };
      if (runnerBusy) return { ok: false, reason: 'Another simulation is running (Stop it first)' };
      return { ok: true, reason: '' };
    }
    return runEnable({
      phase: this.s.phase, report: this.s.report, ports: this.s.ports, G: this.s.G, gasError: this.s.gasError,
      sceneError: this.s.sceneError, scenePending: this.s.scenePending, sceneReady: this.s.sceneReady,
      runnerBusy, running: this.s.running,
    });
  }

  async resolveRunner() {
    if (this.runner) return this.runner;
    const r = await this.getRunner();
    this.runner = r;
    return r;
  }

  /** Starts a run (§4.5). Resolves when it ends; the state carries the results or the message. */
  async run(opts = {}) {
    if (this.s.running) return;
    if (this.s.phase === 'profile') return this.runProfile(opts);
    Object.assign(this.s.runOpts, opts);
    await this.sceneSettled();
    let runner;
    try { runner = await this.resolveRunner(); } catch (err) { this.setMessage('error', err && err.message ? err.message : String(err)); return; }
    const en = this.enableState(!!(runner && runner.busy));
    if (!en.ok) { this.setMessage(runner && runner.busy ? 'warn' : 'error', en.reason); return; }
    const o = this.s.runOpts;
    const seed = parseSeed(o.seed);
    if (Number.isNaN(seed)) { this.setMessage('error', 'The seed must be a whole number from 0 to 4294967295, or blank for a random seed.'); return; }
    const scene = this.s.scene, G = this.s.G;
    const idx = scenePortIndices(scene);
    const token = ++this.runToken;
    this.s.running = true;
    this.s.stopping = false;
    this.s.gasChangedDuringRun = false;
    this.s.results = null;
    this.s.clearedNote = null;
    this.s.live = { progress: null, history: [], hits: null, inletLaunches: null, started: Date.now() };
    this.s.message = null;
    const runGas = this.s.gasKey;
    this.emit('run', 'results', 'message');
    const runOpts = {
      target: o.target, maxTime: Number.isFinite(o.maxTime) ? o.maxTime : null,
      seed: seed === null ? (Date.now() >>> 0) : seed, allocation: o.favorSmall ? 'favor-small' : 'equal',
      tally: true, paths: o.trajectories === false ? 0 : 40, inletPort: idx.inlet, outletPort: idx.outlet,
      onProgress: (p) => {
        if (token !== this.runToken || !this.s.live) return;
        this.s.live.progress = p;
        if (p.history) this.s.live.history = p.history;
        if (p.hits) { this.s.live.hits = p.hits; this.s.live.inletLaunches = p.inletLaunches; this.s.live.hitsVersion = (this.s.live.hitsVersion || 0) + 1; }
        this.emit('progress');
      },
    };
    let result = null, error = null;
    try { result = await runner.runMesh(scene, G, runOpts); } catch (err) { error = err; }
    if (token !== this.runToken) return;
    this.s.running = false;
    this.s.stopping = false;
    const history = this.s.live ? this.s.live.history : [];
    if (error) {
      if (error.partial) this.acceptResult(error.partial, { history, reason: error.code || 'error', scene });
      this.setMessage('error', error.message || String(error));
    } else {
      this.acceptResult(result, { history, scene });
    }
    if (this.s.results && this.s.gasChangedDuringRun && runGas !== this.s.gasKey) {
      const pumpBySpeed = this.s.ports.some((p) => p.role === 'pump' && p.pumpBy !== 'stick');
      if (pumpBySpeed) this.clearResults('The gas changed during the run, and the pump’s sticking coefficient depends on it; run again.');
      else this.recompute();
    }
    this.s.live = null;
    this.emit('run', 'results');
  }

  acceptResult(r, { history = [], reason = null, scene = this.s.scene } = {}) {
    if (!r) return;
    const ports = (r.ports && r.ports.length ? r.ports : (scene ? scene.ports : [])).map((p, k) => ({
      index: k, id: p.id, name: p.name, role: p.role, stick: p.stick, area: p.area,
    }));
    const G = this.s.G;
    const res = {
      ports, perSource: (r.perSource || []).map((s) => ({ ...s, absorbed: Array.from(s.absorbed || []) })),
      inletPort: r.inletPort ?? scenePortIndices(scene).inlet, outletPort: r.outletPort ?? scenePortIndices(scene).outlet,
      pumpPort: r.pumpPort ?? null,
      hits: r.hits || null, inletLaunches: r.inletLaunches || [], paths: r.paths || [],
      particles: r.particles || 0, casts: r.casts || 0, ms: r.ms || 0, stopped: !!r.stopped,
      reason: reason || r.reason || (r.stopped ? 'stopped' : null), leaks: r.leaks || 0, stuck: r.stuck || 0,
      leaksPerMillion: r.leaksPerMillion ?? (r.casts > 0 ? (r.leaks || 0) / r.casts * 1e6 : 0), seed: r.seed ?? null,
      history: history || [], target: this.s.runOpts.target, G, summary: null, version: (this.s.results ? this.s.results.version : 0) + 1,
    };
    if (G) res.summary = summarizeCounts(ports, res.perSource, G, { inletPort: res.inletPort, outletPort: res.outletPort });
    this.s.results = res;
  }

  stop() {
    if (!this.s.running || !this.runner) return;
    this.s.stopping = true;
    this.emit('run');
    try { this.runner.stop(); } catch (_) { /* the run resolves anyway */ }
  }

  // ---------------------------------------------------------------- derived data for the view
  /** Pressure map of the current results or live tallies: { rgb, scale, valid } or null. */
  pressureMap({ average = true, live = false } = {}) {
    const all = this.s.allPositions;
    if (!all) return null;
    const src = live && this.s.live && this.s.live.hits ? { hits: this.s.live.hits, inletLaunches: this.s.live.inletLaunches } : this.s.results;
    if (!src || !src.hits || !this.s.scene || this.s.phase === 'profile') return null;
    const n = Math.floor(all.length / 9);
    if (src.hits.length !== n) return null;
    if (!this.s.areas) this.s.areas = triangleAreas(all);
    if (average && !this.s.patches) this.s.patches = trianglePatches(all);
    const portAreas = (this.s.scene.ports || []).map((p) => p.area);
    const triPort = this.s.triPort && this.s.triPort.length === n ? this.s.triPort : null;
    const { p, valid } = wallPressureValues({ hits: src.hits, areas: this.s.areas, triPort, inletLaunches: src.inletLaunches, portAreas, patches: average ? this.s.patches : null });
    const { rgb, scale } = pressureColors(p);
    return { rgb, scale, valid, p };
  }

  /** Axial profile of the current results (or live tallies): { s, value, lo, hi, axis, bent, clausing } or null. */
  axial({ live = false } = {}) {
    const scene = this.s.phase === 'profile' ? null : this.s.scene;
    const src = live && this.s.live && this.s.live.hits ? { hits: this.s.live.hits, inletLaunches: this.s.live.inletLaunches } : this.s.results;
    if (!scene || !src || !src.hits || !scene.origTri || src.hits.length !== scene.nTri) return null;
    const bySlot = new Float64Array(scene.nTri);
    for (let s = 0; s < scene.nTri; s++) bySlot[s] = src.hits[scene.origTri[s]];
    const idx = scenePortIndices(scene);
    let prof;
    try { prof = axialProfile(scene, bySlot, src.inletLaunches || [], { bins: 40 }); } catch (_) { return null; }
    return { ...prof, bent: isBent(scene, idx.inlet, idx.outlet), clausing: clausingOverlay(this.s.source) };
  }

  /** Run α referred to the built-in's reference opening, with σ: { alpha, sigma } or null. */
  referenceAlpha() {
    const r = this.s.results, ref = this.s.reference;
    if (!r || r.kind === 'chain' || !r.summary || !ref || !r.G) return null;
    const prim = r.summary.C || r.summary.Seff;
    if (!prim) return null;
    const refPort = r.ports.find((p) => p.id === this.s.referencePortId) || r.ports[r.inletPort];
    if (!refPort || !(refPort.area > 0)) return null;
    const q = refPort.area * r.G.vbar / 4;
    return { alpha: prim.value / q, sigma: prim.sigma / q, C: prim };
  }

  // ---------------------------------------------------------------- project files
  /** Project JSON (§2.10) of the current state. */
  async exportProject() {
    const s = this.s;
    if (s.source && s.source.kind === 'profile') throw new RangeError('A 2D profile is not saved as a project; keep the SVG or DXF file, or open it in the Components tab and share the link.');
    if (!s.source || !s.prepared) throw new RangeError('There is no model to save.');
    let mesh = null;
    if (s.source.kind === 'file') {
      if (s.projectMesh) mesh = { vertices: s.projectMesh.vertices, triangles: s.projectMesh.triangles };
      else {
        const r = await this.prep.request({ type: 'export' });
        mesh = { vertices: r.vertices, triangles: r.triangles };
      }
    }
    const st = this.settings() || {};
    const r = s.results;
    const results = r ? {
      perSource: r.perSource.map((p) => ({ port: p.port, n: p.n, absorbed: Array.from(p.absorbed), leaks: p.leaks || 0, stuck: p.stuck || 0, casts: p.casts || 0 })),
      hits: r.hits || null, ms: r.ms, stopped: r.stopped,
      particles: r.particles, casts: r.casts, leaks: r.leaks, stuck: r.stuck, reason: r.reason, seed: r.seed,
      inletPort: r.inletPort, outletPort: r.outletPort,
      inletLaunches: (r.inletLaunches || []).map((l) => ({ port: l.port, n: l.n })),
      history: thinHistory(r.history || [], 200).map((h) => ({ n: h.n, value: h.value, lo: h.lo, hi: h.hi })),
    } : null;
    return serializeProject({
      units: { file: s.unit, scaleToMeters: FILE_UNITS[s.unit] },
      source: s.source.kind === 'builtin' ? { kind: 'builtin', name: s.source.name, params: s.source.params || {} } : { kind: 'file', name: s.source.name, format: s.source.format || '' },
      mesh,
      weldTol: s.source.kind === 'file' && s.report ? s.report.weldTol : null,
      ports: portSpecsForProject(s.ports),
      conditions: { gas: st.gas || 'N2', T: isFiniteNum(st.T) ? st.T : 293.15, custom: st.gas === 'custom' ? st.custom || null : null },
      run: { target: s.runOpts.target, maxTime: Number.isFinite(s.runOpts.maxTime) ? s.runOpts.maxTime : null, seed: parseSeed(s.runOpts.seed) ?? null, allocation: s.runOpts.favorSmall ? 'favor-small' : 'equal' },
      results,
    });
  }

  /**
   * Opens a project (§2.10): regenerates or reloads the mesh, restores the openings, run options and stored results
   * (shown without re-running). applyConditions(conditions) lets the page set the shared gas and temperature.
   */
  async openProject(text, { applyConditions = null } = {}) {
    if (this.s.running) return;
    let pj;
    try { pj = parseProject(text); } catch (err) { this.setMessage('error', err.message); return; }
    const unit = Object.keys(FILE_UNITS).find((u) => Math.abs(FILE_UNITS[u] / pj.units.scaleToMeters - 1) < 1e-9) || (FILE_UNITS[pj.units.file] ? pj.units.file : 'mm');
    if (applyConditions && pj.conditions) { try { applyConditions(pj.conditions); } catch (_) { /* the page keeps its own */ } }
    this.readGas();
    const gen = this.beginLoad();
    this.s.unit = unit;
    const run = pj.run || {};
    this.s.runOpts = {
      target: TARGETS.includes(run.target) ? run.target : 0.01,
      maxTime: run.maxTime === null ? Infinity : (MAX_TIMES.includes(run.maxTime) ? run.maxTime : 60),
      seed: isFiniteNum(run.seed) ? String(run.seed) : '', favorSmall: run.allocation === 'favor-small',
      trajectories: this.s.runOpts.trajectories !== false,
    };
    try {
      let reply;
      if (pj.source.kind === 'builtin') {
        this.s.source = { kind: 'builtin', name: pj.source.name, params: pj.source.params || {} };
        this.s.file = null; this.s.projectMesh = null;
        reply = await this.prep.request({ type: 'builtin', name: pj.source.name, params: pj.source.params || {} });
      } else {
        this.s.source = { kind: 'file', name: pj.source.name || 'model', format: pj.source.format || '' };
        this.s.file = null;
        this.s.projectMesh = { vertices: pj.mesh.vertices, triangles: pj.mesh.triangles };
        reply = await this.prep.request({ type: 'loadMesh', vertices: pj.mesh.vertices.slice(), triangles: pj.mesh.triangles.slice(), weldTol: pj.weldTol });
      }
      if (!this.acceptPrepared(gen, reply, { ports: pj.ports.map(uiPort) })) return;
      // the defaults stay the detected openings, so Auto-detect still works
      await this.sceneSettled();
      if (gen !== this.gen) return;
      if (pj.results && this.s.scene) {
        const R = pj.results;
        const scene = this.s.scene;
        const idx = scenePortIndices(scene);
        const inletLaunches = Array.isArray(R.inletLaunches) && R.inletLaunches.length ? R.inletLaunches
          : R.perSource.filter((p) => scene.ports[p.port] && scene.ports[p.port].role === 'inlet').map((p) => ({ port: p.port, n: p.n + (p.stuck || 0) }));
        this.acceptResult({
          perSource: R.perSource, hits: R.hits || null, inletLaunches, paths: [], particles: R.particles ?? R.perSource.reduce((a, p) => a + p.n + (p.stuck || 0), 0),
          casts: R.casts ?? R.perSource.reduce((a, p) => a + (p.casts || 0), 0), ms: R.ms ?? 0, stopped: !!R.stopped,
          reason: R.reason || null, leaks: R.leaks ?? R.perSource.reduce((a, p) => a + (p.leaks || 0), 0), stuck: R.stuck ?? R.perSource.reduce((a, p) => a + (p.stuck || 0), 0),
          seed: R.seed ?? null, inletPort: Number.isInteger(R.inletPort) ? R.inletPort : idx.inlet, outletPort: Number.isInteger(R.outletPort) ? R.outletPort : idx.outlet,
        }, { history: Array.isArray(R.history) ? R.history : [], scene });
        this.s.results.fromProject = true;
        this.emit('results');
      }
      this.emit('model', 'run');
    } catch (err) { this.failLoad(gen, err); }
  }

  dispose() {
    this.cancelScene();
    this.listeners.clear();
    this.runToken++;
  }
}

/**
 * Molecular formula value of a profile's items (Haefer/Oatley network, WP1) with its error band, for comparison with
 * the exact chain Monte Carlo: { C, band: { lo, hi, note } } or null when the formula cannot be evaluated.
 */
export function profileFormula(items, G) {
  if (!items || !G) return null;
  try {
    const C = molecularLimit(items, G).Cline;
    let band = null;
    try { band = errorBand(buildNetwork(items, G), false); } catch (_) { band = null; }
    return Number.isFinite(C) && C > 0 ? { C, band } : null;
  } catch (_) { return null; }
}

function thinHistory(h, max) {
  if (h.length <= max) return h.slice();
  const out = [], step = (h.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(h[Math.round(i * step)]);
  return out;
}

// ==================================================================================================================
// 3. The tab: markup, wiring, rendering
// ==================================================================================================================

const TEMPLATE = `
<div class="cl-cad">
  <div class="cl-cad-toolbar" role="group" aria-label="Model">
    <label class="btn btn-secondary cl-cad-file">Load STL or OBJ<input type="file" class="visually-hidden" accept=".stl,.obj,model/stl,model/obj" data-el="file"></label>
    <label class="btn btn-ghost btn-sm cl-cad-file">Load 2D profile (SVG/DXF)<input type="file" class="visually-hidden" accept=".svg,.dxf,image/svg+xml" data-el="profile"></label>
    <div class="chip-row cl-cad-builtins" role="group" aria-label="Built-in test geometries" data-el="builtins"></div>
    <label class="cl-cad-unit"><span>Unit</span> <select class="input" data-el="unit" aria-label="Unit of the file"></select></label>
    <span class="cl-cad-bbox" data-el="bbox"></span>
    <span class="cl-cad-files">
      <button type="button" class="btn btn-ghost btn-sm" data-el="save">Save project</button>
      <label class="btn btn-ghost btn-sm cl-cad-file">Open project<input type="file" class="visually-hidden" accept=".json,application/json" data-el="open"></label>
    </span>
  </div>
  <p class="hint cl-cad-advice">Export the gas volume as a closed solid, or the inner walls only. Use at least 64 segments per circle. Monte Carlo here is free-molecular flow only (no gas–gas collisions).</p>
  <div class="calc-error" role="alert" data-el="error"></div>
  <p class="cl-cad-note" data-el="note" hidden></p>
  <div class="cl-cad-grid">
    <div class="cl-cad-side">
      <section class="panel" data-el="meshPanel">
        <div class="panel-head"><h3>Mesh check</h3><span class="badge" data-el="meshBadge" hidden></span></div>
        <div class="panel-body">
          <p class="hint" data-el="meshEmpty">Load a model or pick a built-in geometry.</p>
          <ul class="cl-cad-checks" data-el="checks"></ul>
          <ul class="cl-cad-messages" data-el="messages"></ul>
          <details class="cl-cad-advanced" data-el="advanced" hidden>
            <summary>Advanced</summary>
            <div class="field">
              <label data-el="weldLabel">Merge tolerance</label>
              <div class="input-unit"><input type="text" inputmode="decimal" data-el="weld" spellcheck="false"><span class="unit" data-el="weldUnit">mm</span></div>
              <div class="hint">Vertices closer than this are merged before the mesh is checked. Blank uses 10⁻⁶ of the model’s diagonal.</div>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" data-el="weldApply">Check again</button>
          </details>
        </div>
      </section>
      <section class="panel" data-el="portsPanel">
        <div class="panel-head"><h3>Openings</h3>
          <div class="btn-row">
            <button type="button" class="btn btn-ghost btn-sm" data-el="auto">Auto-detect</button>
            <button type="button" class="btn btn-ghost btn-sm" data-el="select" aria-pressed="false">Select region</button>
          </div>
        </div>
        <div class="panel-body">
          <p class="hint" data-el="portsEmpty">No openings yet.</p>
          <div class="cl-cad-profile" data-el="profileBox" hidden>
            <p class="hint">The left end of the drawing is the inlet and the right end the outlet. The passage is revolved about the axis into exact surfaces.</p>
            <div class="field">
              <label data-for="profileAxis">Axis</label>
              <select class="input" data-el="profileAxis"><option value="min">The lowest line of the drawing</option><option value="zero">The line y = 0</option></select>
            </div>
            <ol class="cl-cad-items" data-el="profileItems"></ol>
            <button type="button" class="btn btn-secondary btn-sm" data-el="profileOpen">Open in Components</button>
          </div>
          <div class="cl-ports" data-el="ports"></div>
          <p class="hint" data-el="selectHint" hidden>Click a flat face in the view to select it (for a closed solid, click the end faces).</p>
          <div class="cl-cad-pending" data-el="pending" hidden>
            <span class="cl-port-swatch cl-swatch-select" aria-hidden="true"></span>
            <span data-el="pendingText"></span>
            <button type="button" class="btn btn-primary btn-sm" data-el="pendingAdd">Add as opening</button>
            <button type="button" class="btn btn-ghost btn-sm" data-el="pendingCancel">Cancel</button>
          </div>
        </div>
      </section>
      <section class="panel" data-el="runPanel">
        <div class="panel-head"><h3>Run</h3></div>
        <div class="panel-body">
          <div class="field-row">
            <div class="field"><label data-for="target">Target precision (95 %)</label><select class="input" data-el="target"></select></div>
            <div class="field"><label data-for="maxTime">Maximum time</label><select class="input" data-el="maxTime"></select></div>
          </div>
          <div class="field-row">
            <div class="field"><label data-for="workers">Workers</label><output class="cl-cad-output" data-el="workers">auto</output></div>
            <div class="field"><label data-for="seed">Seed</label><input type="text" class="input" inputmode="numeric" placeholder="random" spellcheck="false" data-el="seed"></div>
          </div>
          <label class="cl-cad-check"><input type="checkbox" data-el="favor"> Launch mostly from the smaller opening</label>
          <div class="btn-row cl-cad-runrow">
            <button type="button" class="btn btn-primary" data-el="run">Run Monte Carlo</button>
            <button type="button" class="btn btn-secondary" data-el="stop" disabled>Stop</button>
          </div>
          <progress class="cl-cad-progress" max="1" value="0" data-el="progress" hidden></progress>
          <p class="cl-cad-status" aria-live="polite" data-el="status"></p>
        </div>
      </section>
    </div>
    <section class="panel cl-cad-view" data-el="viewPanel">
      <div class="panel-head"><h3>3D view</h3><span class="hint cl-cad-viewhint" data-el="viewHint">Drag to rotate, right-drag or Shift+drag to pan, wheel to zoom.</span></div>
      <div class="cl-cad-viewbar" role="group" aria-label="View options">
        <button type="button" class="btn btn-ghost btn-sm" data-el="reset">Reset view</button>
        <label class="visually-hidden" data-for="viewDir">View direction</label>
        <select class="input cl-cad-small" data-el="viewDir"></select>
        <div class="seg" role="radiogroup" aria-label="Display" data-el="displaySeg"></div>
        <label class="cl-cad-check"><input type="checkbox" data-el="wire"> Wireframe</label>
        <label class="cl-cad-check"><input type="checkbox" data-el="paths"> Trajectories</label>
        <label class="cl-cad-check"><input type="checkbox" data-el="average" checked> Average over flat faces</label>
        <span class="cl-cad-clip">
          <label data-for="clipAxis">Clip</label>
          <select class="input cl-cad-small" data-el="clipAxis"></select>
          <input type="range" min="0" max="100" step="1" value="50" data-el="clipPos" aria-label="Clip plane position" disabled>
          <label class="cl-cad-check"><input type="checkbox" data-el="clipFlip" disabled> Flip</label>
        </span>
      </div>
      <div class="cl-viewer" data-el="viewer"><p class="hint cl-viewer-msg" data-el="viewerMsg">Loading the 3D view…</p></div>
      <div class="cl-cad-legend" data-el="legend"></div>
    </section>
  </div>
  <section class="panel cl-cad-results" data-el="resultsPanel">
    <div class="panel-head"><h3>Results</h3><span class="badge" data-el="resultBadge" hidden></span></div>
    <div class="panel-body">
      <p class="hint" data-el="resultsEmpty">Run the simulation to see the transmission matrix, the conductance and the pressure map.</p>
      <div class="results" data-el="rows">
        <div class="result primary" hidden aria-live="polite" data-row="primary"><span class="result-label"></span><span class="result-value"></span><span class="result-note"></span></div>
        <div class="result" hidden data-row="alpha"><span class="result-label"></span><span class="result-value"></span><span class="result-note"></span></div>
        <div class="result" hidden data-row="reference"><span class="result-label">Built-in reference</span><span class="result-value"></span><span class="result-note"></span></div>
      </div>
      <div data-el="matrixBlock" hidden>
        <h4 class="cl-cad-h4">Transmission matrix</h4>
        <p class="hint">Probability that a particle entering through the row’s opening leaves through the column’s opening, with its 95 % interval.</p>
        <div class="cl-matrix-scroll"><table class="cl-matrix" data-el="matrix"></table></div>
      </div>
      <div data-el="recipBlock" hidden>
        <h4 class="cl-cad-h4">Reciprocity</h4>
        <div class="cl-matrix-scroll"><table class="cl-matrix" data-el="recip"></table></div>
        <p class="hint" data-el="recipNote"></p>
      </div>
      <div data-el="statsBlock" hidden>
        <h4 class="cl-cad-h4">Run statistics</h4>
        <div class="results cl-cad-stats" data-el="stats"></div>
      </div>
    </div>
  </section>
  <div class="grid grid-2 cl-cad-plots">
    <section class="panel"><div class="panel-head"><h3>Convergence</h3></div><div class="panel-body"><div class="cl-cad-plot" data-el="convPlot"></div><p class="hint" data-el="convNote">The estimate and its 95 % interval against the number of particles.</p></div></section>
    <section class="panel"><div class="panel-head"><h3>Pressure along the axis</h3></div><div class="panel-body"><div class="cl-cad-plot" data-el="axialPlot"></div><p class="hint" data-el="axialNote">Wall pressure relative to the inlet, from the hit density on the walls (isothermal, diffuse walls).</p></div></section>
  </div>
</div>`;

const VIEW_DIRS = [['iso', 'Iso'], ['+x', '+X'], ['-x', '−X'], ['+y', '+Y'], ['-y', '−Y'], ['+z', '+Z'], ['-z', '−Z']];
const CHECK_HELP = {
  openings: ['Openings', 'Open edges that form flat loops become openings, closed by flat caps. A closed solid has none: select its end faces as regions.', 'If an opening is missing, check that the model is exported as the gas volume or the inner walls.'],
  winding: ['Winding', 'Neighbouring triangles should be wound the same way. If they are not, the inside of each opening is found by casting rays instead.', 'Re-export the model, or recalculate the normals in the CAD program.'],
  chains: ['Open edge chains', 'Open edges that do not close into a loop leave a gap that particles can escape through.', 'Close the gap in the CAD program, or raise the merge tolerance under Advanced if the gap is a rounding error.'],
  nonmanifold: ['Non-manifold edges', 'Edges shared by more than two triangles mean internal or doubled faces.', 'Remove internal faces and export a single closed surface.'],
  degenerate: ['Degenerate or duplicate triangles', 'Zero-area and repeated triangles are removed before tracing.', 'Usually harmless; many of them suggest a poor export.'],
  merged: ['Merged vertices', 'Vertices closer than the merge tolerance are joined, so separate facets share edges.', 'Change the tolerance under Advanced if parts that should touch stay apart.'],
  faceting: ['Faceting', 'A round opening exported as a polygon is a little smaller than the circle, which lowers the conductance (−1 % at 32 sides).', 'Export with at least 64 segments per circle (about 0.1 rad angular deviation).'],
};

const STAT_ROWS = [['status', 'Status'], ['particles', 'Particles'], ['rays', 'Rays'], ['rate', 'Rays per second'], ['elapsed', 'Elapsed time'], ['leaks', 'Leaks per million rays'], ['stuck', 'Stuck particles']];

/** Display helpers over format.js (WP5) with plain fallbacks. */
function makeDisplay(format, store) {
  const st = () => (store && typeof store.get === 'function' ? store.get() : {}) || {};
  const f = format || {};
  const su = () => st().su || 'L/s';
  const lu = () => st().lu || 'mm';
  const call = (fn, args, fallback) => {
    if (typeof fn !== 'function') return fallback();
    try { const v = fn(...args); return v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v)) ? fallback() : v; } catch (_) { return fallback(); }
  };
  const speedValue = (x) => call(f.fromSI, ['speed', su(), x], () => x * 1000);
  const lengthPerUnit = () => call(f.toSI, ['length', lu(), 1], () => FILE_UNITS[lu()] || 1e-3);
  const sig = (x, n = 4) => (Number.isFinite(x) ? minus(String(Number(x.toPrecision(n)))) : '–');
  return {
    su, lu,
    speed: (x) => call(f.fmt, ['speed', x], () => sig(x * 1000) + ' L/s'),
    speedValue,
    speedToSI: (x) => call(f.toSI, ['speed', su(), x], () => x / 1000),
    speedCI: (lo, hi) => {
      // both bounds with the same number of decimals ('43.90–44.42 L/s')
      const a = speedValue(lo), b = speedValue(hi), m = Math.max(Math.abs(a), Math.abs(b));
      if (!(m >= 1e-3 && m < 1e6)) return sig(a) + '–' + sig(b) + ' ' + su();
      const d = Math.max(0, Math.min(8, 3 - Math.floor(Math.log10(m) + 1e-12)));
      return minus(a.toFixed(d)) + '–' + minus(b.toFixed(d)) + ' ' + su();
    },
    parse: (text) => call(f.parseInput, [text], () => parseFloat(String(text).replace(',', '.'))),
    temp: (T) => call(f.fmt, ['temperature', T], () => sig(T - 273.15, 3) + ' °C'),
    lengthValue: (m) => m / lengthPerUnit(),
    lengthToSI: (x) => x * lengthPerUnit(),
    length: (m) => sig(m / lengthPerUnit()) + ' ' + lu(),
    area: (m2) => { const k = lengthPerUnit(); return sig(m2 / (k * k)) + ' ' + lu() + '²'; },
    sig,
  };
}

function el(tag, attrs = {}, text = null) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.setAttribute('style', v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  if (text !== null) n.textContent = text;
  return n;
}

function fillSelect(sel, options, value) {
  sel.textContent = '';
  for (const [v, label] of options) {
    const o = el('option', { value: String(v) }, label);
    if (String(v) === String(value)) o.selected = true;
    sel.appendChild(o);
  }
}

function setRow(row, label, value, note = '') {
  if (!row) return;
  row.querySelector('.result-label').textContent = label;
  row.querySelector('.result-value').textContent = value;
  const n = row.querySelector('.result-note');
  if (n) { n.textContent = note; n.hidden = !note; }
  row.hidden = false;
}

function tableFrom(table, head, rows) {
  table.textContent = '';
  const thead = el('thead'), tr = el('tr');
  head.forEach((h, k) => tr.appendChild(el('th', { scope: 'col', class: k === 0 ? null : 'num' }, h)));
  thead.appendChild(tr);
  const tbody = el('tbody');
  for (const r of rows) {
    const row = el('tr');
    r.forEach((c, k) => {
      if (k === 0) row.appendChild(el('th', { scope: 'row' }, c));
      else if (c && typeof c === 'object' && c.node) { const td = el('td', { class: 'num' }); td.appendChild(c.node); row.appendChild(td); }
      else row.appendChild(el('td', { class: 'num' }, c));
    });
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
}

/** Mounts the CAD tab into root (§2.15). ctx = { store, format, getRunner, openInComponents, createPrepWorker? }. */
export function mount(root, ctx = {}) {
  const store = ctx.store && typeof ctx.store.get === 'function' ? ctx.store : (ctx.store && ctx.store.store) || null;
  const phone = typeof matchMedia === 'function' && matchMedia('(max-width: 860px)').matches;
  const D = makeDisplay(ctx.format, store);
  const settings = () => (store ? store.get() : {}) || {};
  const createWorker = typeof ctx.createPrepWorker === 'function'
    ? ctx.createPrepWorker
    : () => new Worker(new URL('../workers/prep-worker.js', import.meta.url), { type: 'module' });
  let prep;
  try { prep = createPrepClient(createWorker()); } catch (err) {
    prep = { request: () => Promise.reject(new Error('This browser cannot run the geometry worker (module workers are not supported). Use a current Chrome, Edge, Firefox or Safari.')), dispose() {} };
  }
  const getRunner = typeof ctx.getRunner === 'function' ? ctx.getRunner : () => { throw new Error('The simulation is not available on this page.'); };
  const c = new CadController({ prep, getRunner, settings, phone });

  root.textContent = '';
  const wrap = document.createElement('div');
  wrap.innerHTML = TEMPLATE;
  const top = wrap.firstElementChild;
  root.appendChild(top);
  const uid = 'cad' + Math.random().toString(36).slice(2, 8);
  const E = {};
  top.querySelectorAll('[data-el]').forEach((n) => { E[n.dataset.el] = n; if (!n.id) n.id = uid + '-' + n.dataset.el; });
  top.querySelectorAll('label[data-for]').forEach((l) => { const t = E[l.dataset.for]; if (t) l.htmlFor = t.id; });
  E.weldLabel.htmlFor = E.weld.id;
  const rows = {};
  top.querySelectorAll('[data-row]').forEach((n) => { rows[n.dataset.row] = n; });

  // ---------------------------------------------------------------- static controls
  for (const b of BUILTIN_CHIPS) {
    const chip = el('button', { type: 'button', class: 'chip', 'data-builtin': b.name, 'aria-pressed': 'false', title: b.title }, b.label);
    E.builtins.appendChild(chip);
  }
  fillSelect(E.unit, Object.keys(FILE_UNITS).map((u) => [u, u]), c.state.unit);
  fillSelect(E.target, TARGETS.map((t) => [t, '±' + (100 * t) + ' %']), c.state.runOpts.target);
  fillSelect(E.maxTime, MAX_TIMES.map((t) => [Number.isFinite(t) ? t : 'inf', !Number.isFinite(t) ? 'Unlimited' : t >= 120 ? (t / 60) + ' min' : t + ' s']), c.state.runOpts.maxTime);
  fillSelect(E.viewDir, VIEW_DIRS, 'iso');
  fillSelect(E.clipAxis, [['off', 'Off'], ['x', 'X'], ['y', 'Y'], ['z', 'Z']], 'off');
  const segName = uid + '-display';
  for (const [v, label] of [['surfaces', 'Surfaces'], ['pressure', 'Pressure map']]) {
    const id = uid + '-display-' + v;
    const input = el('input', { type: 'radio', name: segName, id, value: v });
    if (v === 'surfaces') input.checked = true;
    E.displaySeg.append(input, el('label', { for: id }, label));
  }
  E.paths.checked = !phone;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4;

  const view = { mode: 'surfaces', wireframe: false, paths: !phone, average: true, clipAxis: null, clipPos: 0.5, clipFlip: false };
  let viewer = null, viewerState = { positions: null };
  let lastColors = 0, lastRender = 0, lastConv = 0, trailing = null, lastHitsVersion = -1, convTrailing = null;
  let disposed = false;

  // ---------------------------------------------------------------- viewer
  function viewerMessage(text) {
    E.viewerMsg.textContent = text;
    E.viewerMsg.hidden = !text;
  }

  function syncMesh() {
    if (!viewer || !viewer.webgl) return;
    const s = c.state;
    if (!s.allPositions) {
      // a profile that could not be converted: clear the view instead of showing the previous model
      if (s.phase === 'profile' && viewerState.positions) { viewer.setMesh(new Float32Array(0), new Int16Array(0), {}); viewer.setPaths([]); viewerState.positions = null; }
      return;
    }
    viewer.setMesh(s.allPositions, c.viewTriPort(), c.viewPortColors());
    if (viewerState.positions !== s.allPositions) {
      viewerState.positions = s.allPositions;
      viewer.setColors(null);
      viewer.setPaths([]);
      lastHitsVersion = -1;
    }
    updateAria();
  }

  function syncColors(force = false) {
    if (!viewer || !viewer.webgl) { renderLegend(null); return; }
    if (view.mode !== 'pressure') { viewer.setColors(null); renderLegend(null); return; }
    const live = c.state.running;
    const map = c.pressureMap({ average: view.average, live });
    if (!map) { viewer.setColors(null); renderLegend({ empty: true }); return; }
    viewer.setColors(map.rgb);
    renderLegend(map.scale);
    lastColors = performance.now();
    void force;
  }

  function syncPaths() {
    if (!viewer || !viewer.webgl) return;
    const r = c.state.results;
    viewer.setPaths(r && r.paths ? r.paths : []);
    viewer.setDisplay({ paths: view.paths });
  }

  function onPick(hit) {
    if (!c.state.selecting) return;
    if (!hit) return;
    c.pickRegion(hit.tri);
  }

  function updateAria() {
    if (!viewer || !viewer.canvas) return;
    const s = c.state;
    const name = sourceTitle(s.source);
    const ports = s.phase === 'profile' ? ['inlet (left end)', 'outlet (right end)'] : s.ports.map((p) => p.name + ' (' + ROLE_LABELS[p.role].toLowerCase() + ')');
    viewer.canvas.setAttribute('aria-label', '3D view of ' + name + (ports.length ? '; openings: ' + ports.join(', ') : '; no openings') + '.');
    viewer.canvas.setAttribute('aria-describedby', E.viewHint.id);
  }

  import('./viewer3d.js')
    .then((m) => m.createViewer(E.viewer, { onPick }))
    .then((v) => {
      if (disposed) { v.dispose(); return; }
      viewer = v;
      viewerMessage(v.webgl ? '' : '');
      if (v.webgl) { E.viewerMsg.hidden = true; syncMesh(); syncColors(); syncPaths(); applyViewOptions(); }
      else { E.viewerMsg.hidden = true; disableViewControls(true); }
    })
    .catch(() => {
      viewerMessage('The 3D viewer could not be loaded (no connection to cdnjs.cloudflare.com). The simulation still runs; results appear below.');
      disableViewControls(true);
    });

  function disableViewControls(off) {
    for (const k of ['reset', 'viewDir', 'wire', 'paths', 'average', 'clipAxis', 'clipPos', 'clipFlip']) E[k].disabled = off;
    E.displaySeg.querySelectorAll('input').forEach((i) => { i.disabled = off; });
  }

  function applyViewOptions() {
    if (!viewer || !viewer.webgl) return;
    const tooBig = c.state.allPositions && c.state.allPositions.length / 9 > 150000;
    E.wire.disabled = !!tooBig;
    if (tooBig) { E.wire.checked = false; view.wireframe = false; }
    viewer.setDisplay({ wireframe: view.wireframe, paths: view.paths });
    viewer.setClip(view.clipAxis, view.clipPos, view.clipFlip);
  }

  // ---------------------------------------------------------------- legend
  function renderLegend(scale) {
    const L = E.legend;
    L.textContent = '';
    if (view.mode === 'pressure') {
      if (!scale || scale.empty || !(scale.min > 0)) {
        L.appendChild(el('span', { class: 'hint' }, c.state.phase === 'profile' ? 'There is no pressure map for a 2D profile: it is simulated with exact surfaces.' : c.state.results || c.state.running ? 'Not enough wall hits yet for a pressure map.' : 'Run the simulation to see the wall pressure.'));
        return;
      }
      const lg = legendTicks(scale);
      const box = el('div', { class: 'cl-legend-pressure' });
      box.appendChild(el('span', { class: 'cl-legend-title' }, 'p/p_in (log scale)'));
      const barWrap = el('div', { class: 'cl-legend-barwrap' });
      barWrap.appendChild(el('div', { class: 'cl-legend-bar', style: 'background: ' + lg.gradient, role: 'img', 'aria-label': 'Colour scale from ' + lg.ticks.map((t) => t.label).join(' to ') }));
      const ticks = el('div', { class: 'cl-legend-ticks', 'aria-hidden': 'true' });
      for (const t of lg.ticks) ticks.appendChild(el('span', { style: 'left: ' + (100 * t.pos).toFixed(2) + '%' }, t.label));
      barWrap.appendChild(ticks);
      box.appendChild(barWrap);
      const nd = el('span', { class: 'cl-legend-item' });
      nd.append(el('span', { class: 'cl-port-swatch cl-swatch-nodata', 'aria-hidden': 'true' }), document.createTextNode('not enough hits'));
      box.appendChild(nd);
      // the map is tallied from the selected inlet only (v2.2): say so when there are several inlets
      const inlets = c.state.ports.filter((p) => p.role === 'inlet');
      if (inlets.length > 1) {
        const r = c.state.results, sp = r && r.ports && r.inletPort !== null && r.inletPort !== undefined ? r.ports[r.inletPort] : null;
        box.appendChild(el('span', { class: 'hint' }, 'Gas entering through ' + (sp ? '"' + sp.name + '"' : 'the first inlet') + ' only, with every other opening pumping.'));
      }
      L.appendChild(box);
      return;
    }
    const roles = c.state.phase === 'profile' ? ['inlet', 'outlet'] : [...new Set(c.state.ports.map((p) => p.role))];
    const items = roles.map((r) => [ROLE_TOKENS[r], ROLE_LABELS[r]]);
    items.push(['--border-strong', 'Walls']);
    if (c.state.pending) items.push([SELECTION_TOKEN, 'Selection']);
    for (const [tok, label] of items) {
      const it = el('span', { class: 'cl-legend-item' });
      it.append(el('span', { class: 'cl-port-swatch', style: 'background: var(' + tok + ')', 'aria-hidden': 'true' }), document.createTextNode(label));
      L.appendChild(it);
    }
  }

  // ---------------------------------------------------------------- message, toolbar, mesh check
  function renderMessage() {
    const m = c.state.message;
    E.error.textContent = m && m.level === 'error' ? m.text : '';
    E.error.classList.toggle('show', !!(m && m.level === 'error'));
    E.note.textContent = m && m.level !== 'error' ? m.text : '';
    E.note.hidden = !(m && m.level !== 'error');
    E.note.classList.toggle('cl-cad-note-warn', !!(m && m.level === 'warn'));
  }

  function renderToolbar() {
    const s = c.state;
    E.builtins.querySelectorAll('[data-builtin]').forEach((b) => {
      b.setAttribute('aria-pressed', String(!!(s.source && s.source.kind === 'builtin' && s.source.name === b.dataset.builtin)));
    });
    if (E.unit.value !== s.unit) E.unit.value = s.unit;
    const pf = s.phase === 'profile' ? s.profile : null;
    const bb = pf ? pf.bbox || null : s.report ? s.report.bbox : null;
    let text = s.phase === 'loading' ? 'Preparing the mesh…'
      : pf ? (bb && pf.items ? profileBboxText(bb, s.unit, pf.items.length) : '2D profile')
        : bb ? bboxText(bb, s.unit, s.report.nTri) : '';
    const warn = bb ? sizeWarning(bb) : '';
    E.bbox.textContent = text + (warn ? ' · ' + warn : '');
    E.bbox.classList.toggle('cl-cad-bbox-warn', !!warn);
    const busy = s.running || s.phase === 'loading';
    E.file.disabled = s.running; E.open.disabled = s.running; E.unit.disabled = s.running || !!(pf && pf.unitHint);
    E.profile.disabled = s.running;
    E.builtins.querySelectorAll('button').forEach((b) => { b.disabled = s.running; });
    E.save.disabled = busy || !s.prepared || s.phase === 'profile';
    E.save.title = s.phase === 'profile' ? 'A 2D profile is not saved as a project; keep the drawing.' : '';
  }

  function badge(level, text) { return el('span', { class: 'badge ' + (level === 'ok' ? 'badge-ok' : level === 'warn' ? 'badge-warn' : level === 'error' ? 'badge-bad' : '') }, text); }

  function renderMeshCheck() {
    const s = c.state, R = s.report;
    E.checks.textContent = '';
    E.messages.textContent = '';
    E.meshEmpty.textContent = s.phase === 'profile' ? 'A 2D profile is revolved into exact surfaces, so there is no mesh to check.' : 'Load a model or pick a built-in geometry.';
    E.meshEmpty.hidden = !!R;
    E.meshBadge.hidden = !R;
    E.advanced.hidden = !(R && s.source && s.source.kind === 'file');
    if (!R) return;
    E.meshBadge.className = 'badge ' + (R.severity === 'error' ? 'badge-bad' : R.severity === 'warn' ? 'badge-warn' : 'badge-ok');
    E.meshBadge.textContent = R.severity === 'error' ? 'Errors' : R.severity === 'warn' ? 'Warnings' : 'OK';
    const nOpen = s.defaultPorts.length;
    const circ = (R.faceting || []).filter((f) => Number.isFinite(f.sides));
    const minSides = circ.length ? Math.min(...circ.map((f) => f.sides)) : null;
    const worstFacet = circ.length ? circ.reduce((a, f) => (f.sides < a.sides ? f : a), circ[0]) : null;
    const checks = [
      ['openings', R.closed ? 'warn' : 'ok', R.closed ? 'Closed solid: select the inlet and outlet faces' : plural(nOpen, 'opening', 'openings') + ' (' + fmtInt(R.boundaryEdges) + ' open edges)'],
      ['winding', R.windingConsistent ? 'ok' : 'warn', R.windingConsistent ? 'Consistent' : 'Inconsistent'],
      ['chains', R.openChains ? 'error' : 'ok', R.openChains ? fmtInt(R.openChains) + ' open' : 'None'],
      ['nonmanifold', R.nonManifoldEdges ? 'warn' : 'ok', R.nonManifoldEdges ? fmtInt(R.nonManifoldEdges) : 'None'],
      ['degenerate', R.degenerate || R.duplicate ? 'warn' : 'ok', R.degenerate || R.duplicate ? fmtInt(R.degenerate) + ' + ' + fmtInt(R.duplicate) + ' removed' : 'None'],
      ['merged', 'ok', fmtInt(R.merged || 0)],
      ['faceting', minSides === null ? 'ok' : minSides < 64 ? 'warn' : 'ok', minSides === null ? 'No round openings' : minSides + ' sides' + (worstFacet && Number.isFinite(worstFacet.expectedErrorPct) ? ' (about ' + fmtSignedPct(worstFacet.expectedErrorPct / 100, 1) + ')' : '')],
    ];
    for (const [key, level, value] of checks) {
      const [title, what, fix] = CHECK_HELP[key];
      const li = el('li', { class: 'cl-cad-check-item' });
      const d = el('details');
      const sum = el('summary');
      sum.append(el('span', { class: 'cl-cad-check-title' }, title), badge(level, value));
      d.appendChild(sum);
      d.appendChild(el('p', { class: 'hint' }, what + ' ' + fix));
      li.appendChild(d);
      E.checks.appendChild(li);
    }
    for (const m of R.messages || []) {
      if (m.level === 'ok') continue;
      const li = el('li', { class: 'cl-cad-msg cl-cad-msg-' + m.level });
      li.append(el('span', { class: 'cl-cad-msg-icon', 'aria-hidden': 'true' }, m.level === 'error' ? '✕' : '!'), el('span', { class: 'visually-hidden' }, m.level === 'error' ? 'Error: ' : 'Warning: '), document.createTextNode(m.text));
      E.messages.appendChild(li);
    }
    if (document.activeElement !== E.weld) E.weld.value = Number.isFinite(R.weldTol) ? D.sig(D.lengthValue(R.weldTol), 3) : '';
    E.weldUnit.textContent = D.lu();
  }

  // ---------------------------------------------------------------- openings
  let portsKey = '';
  function renderPorts() {
    const s = c.state;
    const key = JSON.stringify([s.ports.map((p) => [p.id, p.kind, p.role, p.pumpBy]), s.running, D.su(), D.lu()]);
    const prof = s.phase === 'profile';
    E.profileBox.hidden = !prof;
    if (prof) renderProfile();
    E.portsEmpty.hidden = prof || s.ports.length > 0 || !s.report;
    E.portsEmpty.textContent = s.report && s.report.closed ? 'This mesh is closed: use Select region and click the inlet and outlet faces.' : 'No openings yet.';
    E.auto.disabled = s.running || !s.prepared || prof;
    E.select.disabled = s.running || !s.prepared || prof;
    E.select.setAttribute('aria-pressed', String(!!s.selecting));
    E.select.classList.toggle('cl-cad-toggle-on', !!s.selecting);
    E.selectHint.hidden = !s.selecting;
    if (key !== portsKey) {
      portsKey = key;
      // keep keyboard focus on the same control of the same opening across the rebuild (spec 4.7: openings can be
      // assigned from this list without picking, so a role change must not drop focus to the page)
      const act = document.activeElement, actRow = act && E.ports.contains(act) ? act.closest('[data-port]') : null;
      const focusAt = actRow ? [actRow.dataset.port, [...actRow.querySelectorAll('input, select, button')].indexOf(act)] : null;
      E.ports.textContent = '';
      s.ports.forEach((p, k) => E.ports.appendChild(portRow(p, k)));
      if (focusAt) {
        const row = E.ports.querySelector('[data-port="' + focusAt[0] + '"]');
        const ctl = row ? row.querySelectorAll('input, select, button')[focusAt[1]] : null;
        if (ctl && !ctl.disabled) ctl.focus(); else if (row) { const first = row.querySelector('select, input'); if (first) first.focus(); }
      }
    }
    // live texts (areas, conversions) without rebuilding the rows
    for (const p of s.ports) {
      const row = E.ports.querySelector('[data-port="' + p.id + '"]');
      if (!row) continue;
      const area = portArea(p, s.report);
      row.querySelector('.cl-port-area').textContent = Number.isFinite(area) ? D.area(area) : '';
      const nameIn = row.querySelector('.cl-port-name');
      if (document.activeElement !== nameIn && nameIn.value !== p.name) nameIn.value = p.name;
      if (p.role === 'pump') updatePumpText(row, p, area);
    }
    renderPending();
  }

  function renderProfile() {
    const s = c.state, pf = s.profile;
    E.profileAxis.value = pf ? pf.axis : 'min';
    E.profileAxis.disabled = s.running || !pf;
    E.profileItems.textContent = '';
    const fmtLen = (m) => D.sig(D.lengthValue(m)) + ' ' + D.lu();
    for (const it of (pf && pf.items) || []) {
      let text;
      try { text = describeItem(it, fmtLen); } catch (_) { text = it.t; }
      E.profileItems.appendChild(el('li', {}, text));
    }
    E.profileOpen.disabled = !(pf && pf.items && pf.items.length) || typeof ctx.openInComponents !== 'function';
  }

  function portRow(p, k) {
    const s = c.state;
    const row = el('div', { class: 'cl-port', 'data-port': String(p.id) });
    const head = el('div', { class: 'cl-port-head' });
    head.appendChild(el('span', { class: 'cl-port-swatch', style: 'background: var(' + (ROLE_TOKENS[p.role] || '--c1') + ')', 'aria-hidden': 'true' }));
    const name = el('input', { type: 'text', class: 'input cl-port-name', 'aria-label': 'Name of opening ' + (k + 1), maxlength: '60', spellcheck: 'false' });
    name.value = p.name;
    name.addEventListener('change', () => c.setName(p.id, name.value));
    head.appendChild(name);
    head.appendChild(el('span', { class: 'cl-port-area' }));
    const role = el('select', { class: 'input cl-port-role', 'aria-label': 'Role of opening ' + (k + 1) });
    fillSelect(role, ROLES.map((r) => [r, ROLE_LABELS[r]]), p.role);
    role.disabled = s.running;
    role.addEventListener('change', () => c.setRole(p.id, role.value));
    head.appendChild(role);
    if (p.kind === 'region') {
      const rm = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': 'Remove opening ' + (k + 1) }, 'Remove');
      rm.disabled = s.running;
      rm.addEventListener('click', () => c.removePort(p.id));
      head.appendChild(rm);
    }
    row.appendChild(head);
    if (p.role === 'pump') {
      const pump = el('div', { class: 'cl-port-pump' });
      const seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Pump given by' });
      for (const [v, label] of [['speed', 'Speed'], ['stick', 'Sticking']]) {
        const id = uid + '-pump-' + p.id + '-' + v;
        const input = el('input', { type: 'radio', name: uid + '-pump-' + p.id, id, value: v });
        input.checked = (p.pumpBy === 'stick') === (v === 'stick');
        input.disabled = s.running;
        input.addEventListener('change', () => { if (input.checked) c.setPump(p.id, { by: v }); });
        seg.append(input, el('label', { for: id }, label));
      }
      pump.appendChild(seg);
      const box = el('div', { class: 'input-unit cl-port-value' });
      const inp = el('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': p.pumpBy === 'stick' ? 'Sticking coefficient of opening ' + (k + 1) : 'Pumping speed of opening ' + (k + 1) });
      inp.disabled = s.running;
      inp.value = p.pumpBy === 'stick' ? (Number.isFinite(p.stick) ? String(Number(p.stick.toPrecision(4))) : '') : (Number.isFinite(p.speed) ? D.sig(D.speedValue(p.speed)) : '');
      inp.addEventListener('change', () => {
        const x = D.parse(inp.value);
        if (p.pumpBy === 'stick') c.setPump(p.id, { stick: x });
        else c.setPump(p.id, { speed: Number.isFinite(x) ? D.speedToSI(x) : NaN });
      });
      box.appendChild(inp);
      box.appendChild(el('span', { class: 'unit' }, p.pumpBy === 'stick' ? '0–1' : D.su()));
      pump.appendChild(box);
      pump.appendChild(el('p', { class: 'hint cl-port-conv' }));
      row.appendChild(pump);
    }
    return row;
  }

  function updatePumpText(row, p, area) {
    const G = c.state.G, out = row.querySelector('.cl-port-conv');
    if (!out) return;
    const inp = row.querySelector('.cl-port-value input');
    const problem = pumpProblem(p, area, G);
    if (inp) inp.setAttribute('aria-invalid', problem ? 'true' : 'false');
    if (!G || !(area > 0)) { out.textContent = problem || ''; return; }
    const Smax = maxSpeed(area, G);
    let text;
    if (p.pumpBy === 'stick') text = Number.isFinite(p.stick) ? '= ' + D.speed(speedFromStick(p.stick, area, G)) + ' for ' + G.name + '. ' : '';
    else text = Number.isFinite(p.speed) ? '= sticking coefficient ' + String(Number(stickFromSpeed(p.speed, area, G).toPrecision(4))) + '. ' : '';
    out.textContent = (problem ? problem + ' ' : text) + 'Maximum for this opening: ' + D.speed(Smax) + ' (molecular orifice limit). Use the speed for this gas.';
  }

  function renderPending() {
    const pd = c.state.pending;
    E.pending.hidden = !pd;
    if (pd) E.pendingText.textContent = 'Selected flat face: ' + fmtInt(pd.tris.length) + ' triangles, ' + D.area(pd.area) + '.';
  }

  // ---------------------------------------------------------------- run panel
  function runnerBusyElsewhere() {
    const r = c.runner;
    return !!(r && r.busy && !c.state.running);
  }

  /** Workers a mesh run will use: the shared runner's count (or the "auto" rule before it exists), limited by memory (§6). */
  function workerCount(bytes) {
    const r = c.runner;
    const base = r && Number.isFinite(r.workers) && r.workers > 0 ? r.workers : autoWorkers(cores, phone);
    return bytes > 0 ? Math.max(1, Math.min(base, Math.floor(SCENE_MEMORY / bytes))) : base;
  }

  function renderRun() {
    const s = c.state;
    const busyElsewhere = runnerBusyElsewhere();
    const en = c.enableState(busyElsewhere);
    E.run.disabled = !en.ok;
    E.run.title = en.ok ? '' : en.reason;
    E.run.textContent = busyElsewhere ? 'Another simulation is running (Stop it first)' : s.phase === 'profile' ? 'Simulate exactly (axisymmetric)' : 'Run Monte Carlo';
    E.stop.disabled = !s.running || s.stopping;
    for (const k of ['target', 'maxTime', 'seed', 'favor']) E[k].disabled = s.running;
    E.favor.disabled = s.running || s.phase === 'profile';
    const bytes = s.phase === 'profile' ? 0 : sceneBytes(s.scene);
    E.workers.textContent = 'auto (' + workerCount(bytes) + ')';
    E.progress.hidden = !s.running && !s.results;
    if (s.running && s.live && s.live.progress) {
      E.progress.value = progressFraction(s.live.progress, s.runOpts);
      E.status.textContent = (s.stopping ? 'Stopping… ' : '') + statusLine(s.live.progress, s.runOpts);
    } else if (s.running) {
      E.progress.value = 0;
      E.status.textContent = 'Starting the workers…';
    } else if (s.results) {
      E.progress.value = 1;
      E.status.textContent = finishText(s.results);
    } else {
      E.progress.value = 0;
      E.status.textContent = en.ok ? (s.clearedNote || 'Ready to run.') : en.reason;
    }
  }

  function finishText(r) {
    const p = { particles: r.particles, castsPerSec: r.ms > 0 ? r.casts / (r.ms / 1000) : 0, final: true };
    const prim = r.kind === 'chain' ? { value: r.value, sigma: r.sigma } : r.summary && (r.summary.Seff || r.summary.C);
    if (prim) p.relHalfWidth = Z95_ * prim.sigma / Math.abs(prim.value);
    const head = r.fromProject ? 'Stored results from the project' : r.reason === 'leaks' ? 'Stopped: particles leaked' : r.stopped ? 'Stopped' : r.reason === 'time' ? 'Time limit reached' : r.reason === 'particles' ? 'Particle limit reached' : 'Done';
    return head + ' · ' + statusLine(p, r);
  }

  // ---------------------------------------------------------------- results
  function primaryText(sum, r) {
    const G = r.G || c.state.G;
    const gasTxt = G ? G.name + ', ' + D.temp(G.T) : '';
    const names = r.ports;
    if (sum.Seff) {
      const S = sum.Seff;
      return {
        label: 'Effective pumping speed S_eff at ' + (names[S.i] ? names[S.i].name : 'the inlet') + ' (' + gasTxt + ')',
        value: D.speed(S.value), note: '95 % interval ' + D.speedCI(S.ci95[0], S.ci95[1]) + '.',
      };
    }
    if (sum.C) {
      const C = sum.C;
      return {
        label: 'Conductance ' + (names[C.i] ? names[C.i].name : 'inlet') + ' → ' + (names[C.j] ? names[C.j].name : 'outlet') + ' (' + gasTxt + ')',
        value: D.speed(C.value), note: '95 % interval ' + D.speedCI(C.ci95[0], C.ci95[1]) + (r.perSource && r.perSource.length > 1 ? ', combining launches from both ends.' : '.'),
      };
    }
    return null;
  }

  function renderProfileResults() {
    const s = c.state, r = s.results, live = s.running && s.live && s.live.progress ? s.live.progress : null;
    for (const k of Object.keys(rows)) rows[k].hidden = true;
    E.matrixBlock.hidden = true; E.recipBlock.hidden = true;
    E.resultBadge.hidden = !(r && r.stopped);
    if (r && r.stopped) { E.resultBadge.className = 'badge badge-warn'; E.resultBadge.textContent = 'Stopped'; }
    E.statsBlock.hidden = !(r || live);
    E.rows.classList.toggle('cl-cad-paused', !!s.gasError);
    const src = r || (live && Number.isFinite(live.value) ? { value: live.value, sigma: live.sigma, ci95: live.ci95, G: s.G, formula: profileFormula(s.profile && s.profile.items, s.G) } : null);
    E.resultsEmpty.hidden = !!src;
    E.resultsEmpty.textContent = s.gasError ? 'Paused: fix the gas data above.' : 'Simulate the profile to see its conductance, traced exactly through the revolved surfaces.';
    if (src) {
      const G = src.G || s.G;
      setRow(rows.primary, 'Conductance, exact axisymmetric geometry (' + (G ? G.name + ', ' + D.temp(G.T) : '') + ')', D.speed(src.value),
        '95 % interval ' + D.speedCI(src.ci95[0], src.ci95[1]) + '. Molecular flow; the ends open into large volumes.' + (live && !r ? ' Running…' : ''));
      const pf = s.profile;
      if (pf && pf.inletArea > 0 && G) {
        const q = pf.inletArea * G.vbar / 4;
        setRow(rows.alpha, 'Transmission probability α (inlet → outlet)', fmtAlphaCI(src.value / q, src.ci95[0] / q, src.ci95[1] / q), 'Referred to the inlet area, ' + D.area(pf.inletArea) + '.');
      }
      if (src.formula) {
        const f = src.formula, dev = src.value / f.C - 1;
        const band = f.band ? ' Expected band of the formula: ' + fmtSignedPct(f.band.lo, 1) + ' to ' + fmtSignedPct(f.band.hi, 1) + '.' : '';
        setRow(rows.reference, 'Formula (molecular, Haefer/Oatley)', D.speed(f.C), 'Monte Carlo is ' + fmtSignedPct(dev, 1) + ' from the formula.' + band);
      }
    }
    renderStats(r, live);
  }

  function renderResults() {
    const s = c.state;
    if (s.phase === 'profile') { renderProfileResults(); return; }
    const live = s.running && s.live && s.live.progress ? s.live.progress : null;
    const r = s.results;
    const sum = r ? r.summary : live ? live.partial : null;
    const ports = r ? r.ports : (s.scene ? s.scene.ports.map((p, k) => ({ index: k, id: p.id, name: p.name, role: p.role, stick: p.stick, area: p.area })) : []);
    const has = !!(sum && (sum.alpha || []).some(Boolean));
    E.resultsEmpty.hidden = has;
    E.resultsEmpty.textContent = s.gasError ? 'Paused: fix the gas data above.' : (s.clearedNote || 'Run the simulation to see the transmission matrix, the conductance and the pressure map.');
    E.resultBadge.hidden = !(r && (r.stopped || r.fromProject || r.reason === 'leaks'));
    if (r) {
      E.resultBadge.className = 'badge ' + (r.reason === 'leaks' ? 'badge-bad' : 'badge-warn');
      E.resultBadge.textContent = r.reason === 'leaks' ? 'Stopped: leaks' : r.stopped ? 'Stopped' : 'From the project file';
      if (r.fromProject && !r.stopped) E.resultBadge.className = 'badge';
    }
    for (const k of Object.keys(rows)) rows[k].hidden = true;
    E.matrixBlock.hidden = !has; E.recipBlock.hidden = !has; E.statsBlock.hidden = !(r || live);
    E.rows.classList.toggle('cl-cad-paused', !!s.gasError);
    if (!has) { renderStats(r, live); return; }
    const rr = r || { ports, G: s.G, perSource: [] };
    const pt = primaryText(sum, rr);
    if (pt) setRow(rows.primary, pt.label, pt.value, pt.note + (live ? ' Running…' : ''));
    const i = sum.inletPort, j = sum.Seff ? sum.Seff.j : sum.outletPort;
    const Gr = rr.G || s.G, both = !sum.Seff && sum.C && rr.perSource && rr.perSource.length > 1;
    const nameOf = (k, fb) => (ports[k] ? ports[k].name : fb);
    if (both && Gr && ports[sum.C.i] && ports[sum.C.i].area > 0) {
      // the conductance row combines the launches from both ends; this α is the same estimate, C/(A_i v̄/4)
      const q = ports[sum.C.i].area * Gr.vbar / 4, C = sum.C;
      setRow(rows.alpha, 'Transmission probability α, both directions combined (' + nameOf(C.i, 'inlet') + ' → ' + nameOf(C.j, 'outlet') + ')',
        fmtAlphaCI(C.value / q, C.ci95[0] / q, C.ci95[1] / q),
        'Referred to the area of ' + nameOf(C.i, 'the inlet') + ', ' + D.area(ports[C.i].area) + '; C = α·A·v̄/4. The matrix below gives each direction on its own.');
    } else if (i !== null && j !== null && sum.alpha[i] && sum.alpha[i][j]) {
      const a = sum.alpha[i][j];
      setRow(rows.alpha, 'Transmission probability α (' + nameOf(i, 'inlet') + ' → ' + nameOf(j, 'outlet') + ')', fmtAlphaCI(a.value, a.lo, a.hi), 'Referred to the area of ' + nameOf(i, 'the inlet') + ', ' + (ports[i] ? D.area(ports[i].area) : '') + '.');
    }
    if (r && s.reference) {
      const ra = c.referenceAlpha();
      if (ra) { const rv = referenceRow(s.reference, ra.alpha, ra.sigma); setRow(rows.reference, 'Built-in reference α', rv.value, rv.note); }
    }
    // matrix
    const m = formatMatrix(sum, ports, r ? r.perSource : []);
    const head = ['From \\ to', ...m.columns];
    if (r) head.push('Leaks', 'Stuck');
    tableFrom(E.matrix, head, m.rows.map((row) => [row.from, ...row.cells, ...(r ? [row.leaks, row.stuck] : [])]));
    // reciprocity
    const rec = sum.reciprocity || [];
    E.recipBlock.hidden = !rec.length;
    if (rec.length) {
      tableFrom(E.recip, ['Pair', 'A_i·α_ij', 'A_j·α_ji', 'z', 'Check'], rec.map((x) => [
        (ports[x.i] ? ports[x.i].name : x.i) + ' ↔ ' + (ports[x.j] ? ports[x.j].name : x.j), D.area(x.lhs), D.area(x.rhs),
        Number.isFinite(x.z) ? minus(x.z.toFixed(2)) : '–', { node: badge(x.pass ? 'ok' : 'error', x.pass ? 'Pass' : 'Fail') },
      ]));
      const bad = rec.some((x) => !x.pass);
      E.recipNote.textContent = bad
        ? 'Reciprocity check failed: the two directions disagree, which usually means leaks, an unclosed opening or a non-manifold surface.'
        : 'Both directions agree within 3σ (A_i·α_ij = A_j·α_ji for diffuse walls).';
    }
    renderStats(r, live);
  }

  function renderStats(r, live) {
    E.stats.textContent = '';
    if (!r && !live) return;
    const vals = {};
    if (r) {
      vals.status = finishText(r).split(' · ')[0];
      vals.particles = fmtInt(r.particles); vals.rays = fmtInt(r.casts);
      vals.rate = r.ms > 0 ? fmtCount(r.casts / (r.ms / 1000)) : '–';
      vals.elapsed = fmtSeconds(r.ms / 1000);
      vals.leaks = Number.isFinite(r.leaksPerMillion) ? String(Number(r.leaksPerMillion.toPrecision(2))) : '–';
      vals.stuck = fmtInt(r.stuck);
    } else {
      vals.status = 'Running';
      vals.particles = fmtInt(live.particles); vals.rays = fmtInt(live.casts);
      vals.rate = fmtCount(live.castsPerSec); vals.elapsed = fmtSeconds(live.elapsed);
      vals.leaks = Number.isFinite(live.leaksPerMillion) ? String(Number(live.leaksPerMillion.toPrecision(2))) : '–';
      vals.stuck = '–';
    }
    for (const [k, label] of STAT_ROWS) {
      const row = el('div', { class: 'result' });
      row.append(el('span', { class: 'result-label' }, label), el('span', { class: 'result-value' }, vals[k] ?? '–'));
      E.stats.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- plots
  function referenceSpeed() {
    const s = c.state, r = s.results, ref = s.reference;
    if (!ref || !Number.isFinite(ref.alpha) || !s.scene || !s.G) return null;
    const ports = r ? r.ports : s.scene.ports;
    const p = ports.find((x) => x.id === s.referencePortId);
    if (!p || !(p.area > 0)) return null;
    const pump = ports.some((x) => x.role === 'pump');
    if (pump) return null;
    return ref.alpha * p.area * s.G.vbar / 4;
  }

  function drawConvergence() {
    if (typeof window === 'undefined' || !window.Plot) return;
    const s = c.state;
    const hist = s.running && s.live ? s.live.history : s.results ? s.results.history : [];
    if (!hist || hist.length < 2) {
      E.convPlot.textContent = '';
      E.convPlot.appendChild(el('p', { class: 'hint' }, s.running ? 'Collecting the first batches…' : 'No run yet.'));
      return;
    }
    const x = hist.map((h) => h.n), y = hist.map((h) => D.speedValue(h.value));
    const lo = hist.map((h) => D.speedValue(h.lo)), hi = hist.map((h) => D.speedValue(h.hi));
    const refS = referenceSpeed();
    const pump = (s.results ? s.results.ports : (s.scene ? s.scene.ports : [])).some((p) => p.role === 'pump');
    const qty = pump ? 'S_eff' : 'C';
    window.Plot.draw(E.convPlot, {
      height: 260,
      x: { label: 'Particles', log: true },
      y: { label: qty + ' (' + D.su() + ')' },
      series: [
        { type: 'band', x, y: hi, y0: lo, color: 'var(--c1)' },
        { type: 'line', x, y, label: 'Monte Carlo', color: 'var(--c1)' },
      ],
      hlines: refS ? [{ y: D.speedValue(refS), label: 'reference', color: 'var(--c3)' }] : [],
      hover: { format: (xv, hits) => fmtCount(xv) + ' particles' + (hits.length ? ' · ' + qty + ' = ' + D.sig(hits[0].y) + ' ' + D.su() : '') },
      ariaLabel: 'Convergence of ' + qty + ' against the number of particles',
    });
  }

  function drawAxial() {
    if (typeof window === 'undefined' || !window.Plot) return;
    const prof = c.axial({ live: c.state.running });
    if (!prof) {
      E.axialPlot.textContent = '';
      E.axialPlot.appendChild(el('p', { class: 'hint' }, c.state.phase === 'profile' ? 'The wall pressure needs a CAD mesh run; a 2D profile is simulated with exact surfaces.' : c.state.running ? 'Collecting wall hits…' : 'No run yet.'));
      E.axialNote.textContent = 'Wall pressure relative to the inlet, from the hit density on the walls (isothermal, diffuse walls).';
      return;
    }
    const x = Array.from(prof.s, (v) => D.lengthValue(v));
    const series = [
      { type: 'band', x, y: Array.from(prof.hi), y0: Array.from(prof.lo), color: 'var(--c2)' },
      { type: 'line', x, y: Array.from(prof.value), label: 'Monte Carlo', color: 'var(--c2)' },
    ];
    if (prof.clausing && prof.axis && prof.axis.length > 0) {
      series.push({ type: 'points', x: prof.clausing.zOverL.map((z) => D.lengthValue(z * prof.axis.length + (prof.axis.s0 || 0))), y: prof.clausing.value, label: 'Clausing (L/R = 20)', color: 'var(--c3)' });
    }
    window.Plot.draw(E.axialPlot, {
      height: 260,
      x: { label: 'Distance along the axis (' + D.lu() + ')' },
      y: { label: 'p/p_in', min: 0 },
      series,
      hover: { format: (xv, hits) => D.sig(xv) + ' ' + D.lu() + (hits.length ? ' · p/p_in = ' + D.sig(hits[0].y, 3) : '') },
      ariaLabel: 'Wall pressure against the distance along the axis',
    });
    E.axialNote.textContent = 'Wall pressure relative to the inlet, from the hit density in ' + prof.s.length + ' slices along the line from the inlet to the outlet.'
      + (prof.bent ? ' The passage bends, so the projection onto a straight axis is only indicative.' : '');
  }

  // ---------------------------------------------------------------- render loop
  function renderAll() {
    renderMessage(); renderToolbar(); renderMeshCheck(); renderPorts(); renderRun(); renderResults();
    drawConvergence(); drawAxial(); renderLegend(null); syncMesh(); syncColors(); syncPaths();
  }

  c.on((tags) => {
    if (disposed) return;
    if (tags.has('message')) renderMessage();
    if (tags.has('model')) { renderToolbar(); renderMeshCheck(); renderPorts(); renderRun(); applyViewOptions(); }
    if (tags.has('ports') || tags.has('pending') || tags.has('scene') || tags.has('model')) {
      renderPorts(); renderRun(); syncMesh();
      if (view.mode === 'surfaces') renderLegend(null);
    }
    if (tags.has('scene') || tags.has('model')) { renderToolbar(); applyViewOptions(); }
    if (tags.has('run')) { renderToolbar(); renderPorts(); renderRun(); }
    if (tags.has('results') || tags.has('gas') || tags.has('run')) {
      renderResults(); renderRun();
      if (!c.state.running) { drawConvergence(); drawAxial(); syncColors(true); syncPaths(); }
    }
    if (tags.has('progress')) onProgress();
  });

  function onProgress() {
    const now = performance.now();
    const due = () => {
      trailing = null;
      lastRender = performance.now();
      renderRun(); renderResults();
    };
    if (now - lastRender >= 500) due();
    else if (!trailing) trailing = setTimeout(due, 500 - (now - lastRender));
    if (now - lastConv >= 1000) { lastConv = now; drawConvergence(); drawAxial(); }
    else if (!convTrailing) convTrailing = setTimeout(() => { convTrailing = null; lastConv = performance.now(); if (c.state.running) { drawConvergence(); drawAxial(); } }, 1000 - (now - lastConv));
    const hv = c.state.live ? c.state.live.hitsVersion : undefined;
    if (view.mode === 'pressure' && hv !== undefined && hv !== lastHitsVersion && now - lastColors >= 1000) { lastHitsVersion = hv; syncColors(); }
  }

  // ---------------------------------------------------------------- events
  E.file.addEventListener('change', () => { const f = E.file.files && E.file.files[0]; E.file.value = ''; if (f) c.loadFile(f); });
  E.builtins.addEventListener('click', (e) => { const b = e.target.closest('[data-builtin]'); if (b) c.loadBuiltin(b.dataset.builtin); });
  E.unit.addEventListener('change', () => c.setUnit(E.unit.value));
  E.profile.addEventListener('change', () => { const f = E.profile.files && E.profile.files[0]; E.profile.value = ''; if (f) c.loadProfile(f); });
  E.profileAxis.addEventListener('change', () => c.setProfileAxis(E.profileAxis.value));
  E.profileOpen.addEventListener('click', () => {
    const pf = c.state.profile;
    if (pf && pf.items && typeof ctx.openInComponents === 'function') ctx.openInComponents(pf.items.map((it) => ({ ...it })));
  });
  E.save.addEventListener('click', async () => {
    try {
      const text = await c.exportProject();
      const blob = new Blob([text], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob), download: projectFileName(c.state) });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      saved = { results: c.state.results, source: c.state.source };
      c.setMessage('info', 'Project saved as ' + a.download + '.');
    } catch (err) { c.setMessage('error', err && err.message ? err.message : String(err)); }
  });
  E.open.addEventListener('change', async () => {
    const f = E.open.files && E.open.files[0];
    E.open.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      await c.openProject(text, { applyConditions: (cond) => { if (store && typeof store.set === 'function') store.set({ gas: cond.gas, T: cond.T, custom: cond.custom }); } });
      syncFromRunOpts();
    } catch (err) { c.setMessage('error', err && err.message ? err.message : String(err)); }
  });
  E.weldApply.addEventListener('click', () => {
    const t = String(E.weld.value).trim();
    if (!t) { c.setWeldTol(null); return; }
    const x = D.parse(t);
    if (!(Number.isFinite(x) && x >= 0)) { E.weld.setAttribute('aria-invalid', 'true'); return; }
    E.weld.setAttribute('aria-invalid', 'false');
    c.setWeldTol(D.lengthToSI(x));
  });
  E.auto.addEventListener('click', () => c.autoDetect());
  E.select.addEventListener('click', () => c.setSelecting(!c.state.selecting));
  E.pendingAdd.addEventListener('click', () => c.addPending());
  E.pendingCancel.addEventListener('click', () => c.cancelPending());
  E.target.addEventListener('change', () => { c.state.runOpts.target = Number(E.target.value); renderRun(); });
  E.maxTime.addEventListener('change', () => { c.state.runOpts.maxTime = E.maxTime.value === 'inf' ? Infinity : Number(E.maxTime.value); });
  E.seed.addEventListener('input', () => {
    c.state.runOpts.seed = E.seed.value;
    E.seed.setAttribute('aria-invalid', Number.isNaN(parseSeed(E.seed.value)) ? 'true' : 'false');
  });
  E.favor.addEventListener('change', () => { c.state.runOpts.favorSmall = E.favor.checked; });
  E.run.addEventListener('click', () => {
    if (runnerBusyElsewhere()) { renderRun(); return; }
    c.run();
  });
  E.stop.addEventListener('click', () => c.stop());
  E.reset.addEventListener('click', () => { E.viewDir.value = 'iso'; if (viewer) viewer.resetView('iso'); });
  E.viewDir.addEventListener('change', () => { if (viewer) viewer.resetView(E.viewDir.value); });
  E.displaySeg.addEventListener('change', (e) => { if (e.target && e.target.name === segName) { view.mode = e.target.value; syncColors(true); if (view.mode === 'surfaces') renderLegend(null); } });
  E.wire.addEventListener('change', () => { view.wireframe = E.wire.checked; applyViewOptions(); });
  E.paths.addEventListener('change', () => {
    view.paths = E.paths.checked;
    c.state.runOpts.trajectories = view.paths;      // the next run records sample paths only when they are shown
    if (viewer) viewer.setDisplay({ paths: view.paths });
  });
  E.average.addEventListener('change', () => { view.average = E.average.checked; syncColors(true); });
  E.clipAxis.addEventListener('change', () => {
    view.clipAxis = E.clipAxis.value === 'off' ? null : E.clipAxis.value;
    E.clipPos.disabled = !view.clipAxis; E.clipFlip.disabled = !view.clipAxis;
    applyViewOptions();
  });
  E.clipPos.addEventListener('input', () => { view.clipPos = Number(E.clipPos.value) / 100; if (viewer) viewer.setClip(view.clipAxis, view.clipPos, view.clipFlip); });
  E.clipFlip.addEventListener('change', () => { view.clipFlip = E.clipFlip.checked; if (viewer) viewer.setClip(view.clipAxis, view.clipPos, view.clipFlip); });
  // drag and drop onto the viewer
  E.viewPanel.addEventListener('dragover', (e) => { if (c.state.running) return; e.preventDefault(); E.viewPanel.classList.add('cl-cad-drop'); });
  E.viewPanel.addEventListener('dragleave', () => E.viewPanel.classList.remove('cl-cad-drop'));
  E.viewPanel.addEventListener('drop', (e) => {
    e.preventDefault();
    E.viewPanel.classList.remove('cl-cad-drop');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f || c.state.running) return;
    if (/\.(svg|dxf)$/i.test(f.name)) { c.loadProfile(f); return; }
    if (/\.json$/i.test(f.name)) f.text().then((t) => c.openProject(t, { applyConditions: (cond) => { if (store && typeof store.set === 'function') store.set({ gas: cond.gas, T: cond.T, custom: cond.custom }); } })).then(syncFromRunOpts);
    else c.loadFile(f);
  });

  function syncFromRunOpts() {
    const o = c.state.runOpts;
    E.target.value = String(o.target);
    E.maxTime.value = Number.isFinite(o.maxTime) ? String(o.maxTime) : 'inf';
    E.seed.value = o.seed || '';
    E.favor.checked = !!o.favorSmall;
  }

  // store: gas, temperature and display units
  let lastSettings = JSON.stringify(settings());
  const unsubscribe = store && typeof store.subscribe === 'function' ? store.subscribe(() => {
    const now = JSON.stringify(settings());
    if (now === lastSettings) return;
    lastSettings = now;
    c.conditionsChanged();
    portsKey = '';
    renderMeshCheck(); renderPorts(); renderRun(); renderResults(); drawConvergence(); drawAxial();
  }) : null;

  // runner busy in another tab: refresh the Run button now and then
  const busyTimer = setInterval(() => { if (!disposed && c.runner) renderRun(); }, 1000);
  // resolve the shared runner at once (this loads its module; no worker starts before a run), so that the timer above
  // can show "Another simulation is running" while the Components tab simulates
  Promise.resolve().then(() => c.resolveRunner()).then(() => { if (!disposed) renderRun(); }, () => {});

  // nothing is stored in the browser: warn before leaving with a run going, unsaved results or a loaded file (v2.2)
  let saved = { results: null, source: null };
  const onBeforeUnload = (ev) => {
    const st = c.state;
    const fileLoaded = st.source && st.source.kind !== 'builtin' && st.source !== saved.source;
    const fresh = st.results && !st.results.fromProject && st.results !== saved.results;
    if (!st.running && !fileLoaded && !fresh) return;
    ev.preventDefault();
    ev.returnValue = '';
  };
  if (typeof addEventListener === 'function') addEventListener('beforeunload', onBeforeUnload);

  renderAll();
  c.loadBuiltin(DEFAULT_BUILTIN);

  return {
    controller: c,
    get viewer() { return viewer; },
    dispose() {
      disposed = true;
      clearInterval(busyTimer);
      if (typeof removeEventListener === 'function') removeEventListener('beforeunload', onBeforeUnload);
      if (trailing) clearTimeout(trailing);
      if (convTrailing) clearTimeout(convTrailing);
      if (typeof unsubscribe === 'function') unsubscribe();
      if (c.state.running) c.stop();
      c.dispose();
      prep.dispose();
      if (viewer) viewer.dispose();
      root.textContent = '';
    },
  };
}

const Z95_ = 1.96;

function projectFileName(s) {
  const base = s.source ? (s.source.kind === 'builtin' ? 'builtin-' + s.source.name : String(s.source.name || 'model').replace(/\.[^.]+$/, '')) : 'model';
  return base.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) + '.conductance.json';
}
