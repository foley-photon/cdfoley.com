/* ==========================================================================
   Ion optics workbench: ui/jobs.js
   Orchestrates solves, fields and runs over the worker pool (spec §2.4.1,
   §2.5, §3.5, §6):
   - solve: one job per non-ground electrode, the first also returns the
     level-0 raster; bases stay on the main thread (optional IndexedDB cache);
   - field: the main thread recombines the channel potentials and builds its
     own field model (cursor, profiles, lens tool); trace workers receive the
     bases once per geometry (when K·8N ≤ 64 MB) and recombine locally, so a
     voltage change sends only the resolved project;
   - runs: particles generated in the workers by index range, chunks of
     clamp(ceil(n/(4W)), 16, 512), merged in index order (bitwise independent
     of worker count and chunking); Stop keeps finished chunks as "partial";
   - live preview: the first particles of each source on the reserved worker,
     superseded (dropped from the queue, never interrupted) by newer edits;
   - estimate(): nodes, levels, memory and times before every solve and run;
     over-budget jobs are refused and the worker count is lowered first.
   Public methods used by the interface (solve, run, ensureSolution,
   ensureField, preview) never reject: failures land in the store's solve and
   run states (or its 'error' event) and the promise resolves with null.
   traceBatch and withTemporaryProject reject, for analysis code that awaits.
   ========================================================================== */
import { EngineError, LIMITS, resolve, projectPath } from '../engine/schema.js';
import { projectKeys } from '../engine/hash.js';
import { ENGINE_VERSION } from '../engine/version.js';
import { estimate as solveEstimate } from '../engine/solve.js';
import { compileGeometry, geometryWarnings } from '../engine/geometry.js';
import { unpackRaster } from '../engine/raster.js';
import { buildField, displayPotential, basisElectrodes } from '../engine/pipeline.js';
import { generate } from '../engine/particles.js';
import { mergeResults } from '../engine/trace.js';
import { summarize } from '../engine/analysis.js';
import { speedFromKE } from '../engine/constants.js';
import { P_STRIDE } from '../engine/layout.js';
import { createPool } from './pool.js';

/**
 * Estimator constants, calibrated against measured single-thread solve and run times of the eleven WP3 fixture
 * projects (Node 24, Ryzen 5 3600; design/wp3/calib.mjs). Multigrid cost per cycle = freeNs·free + fixedNs·fixed
 * + coarseNs·(coarsest-level nodes); hierarchy (geometry, rasters and operators of every level) = hierarchyNs·N.
 * cycles / nsPerNode / sorSweepsPerSide also feed solve.estimate() (levels and the SOR formula on shallow grids).
 */
export const CALIBRATION = {
    cycles: 14, nsPerNode: 3.9, sorSweepsPerSide: 1.3,
    freeNs: 33, fixedNs: 15,                      // fine-level work per node and multigrid cycle (all levels above the coarsest)
    coarseSweepsPerSide: 4.5,                     // coarsest-level SOR sweeps per cycle ≈ this × its shorter effective side
    hierarchyNs: 95,                              // per fine node, once per solving worker
    fieldNsPerNodeChannel: 60,                    // nodal derivatives per node and channel (main-thread field)
    stepsPerSec: { cubic: 0.55e6, linear: 0.8e6 },
    particleMs: 0.3,                              // per-particle overhead (generation, events, recording)
    runOverheadMs: 5,                             // per run and worker (messages, field set-up)
};

const MB = 1024 * 1024;
const HOLD_BASES_BYTES = 64 * MB;
const AUTO_SOLVE_MS = 1500;
const PROGRESS_MS = 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function errInfo(e) {
    return { code: e && e.code ? e.code : 'E_INTERNAL', message: e && e.message ? e.message : String(e), path: e && e.path, detail: e && e.detail };
}
function cancelled(msg = 'Stopped.') { return new EngineError('E_CANCELLED', msg); }
function isCancel(e) { return !!(e && e.code === 'E_CANCELLED'); }
/** A warning { code, message } that prints as its message. */
function note(code, message) {
    const w = { code, message };
    Object.defineProperty(w, 'toString', { value: () => message, enumerable: false });
    return w;
}
function fmtSci(v) { return typeof v === 'number' && Number.isFinite(v) ? v.toExponential(0) : '–'; }

/** Phone rules (spec §2.2.4): width below 760 px or deviceMemory ≤ 2. */
export function detectMobile() {
    try {
        const g = globalThis;
        if (g.matchMedia && g.matchMedia('(max-width: 759.98px)').matches) return true;
        if (g.navigator && typeof g.navigator.deviceMemory === 'number' && g.navigator.deviceMemory <= 2) return true;
    } catch (e) { /* no media queries */ }
    return false;
}

// ---------------------------------------------------------------- estimator helpers
const fixedCache = new WeakMap();

/**
 * Fraction of the domain inside electrodes (fixed nodes), sampled with geometry.classify on a 64 × 64 lattice of cell
 * centres (cached per resolved object). Shapes are exact, so voids and CSG order count.
 * @param {object} r resolved project
 * @returns {number} 0…1
 */
export function fixedFraction(r) {
    if (!r || !r.domain) return 0;
    if (fixedCache.has(r)) return fixedCache.get(r);
    let f = 0;
    if ((r.shapes || []).length) {
        try {
            const g = compileGeometry(r);
            const d = r.domain, M = 64;
            const x0 = d.x[0], y0 = d.y[0], dx = (d.x[1] - d.x[0]) / M, dy = (d.y[1] - d.y[0]) / M;
            let hit = 0;
            for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) if (g.classify(x0 + (i + 0.5) * dx, y0 + (j + 0.5) * dy) >= 0) hit++;
            f = hit / (M * M);
        } catch (e) { f = 0; }
    }
    fixedCache.set(r, f);
    return f;
}

/**
 * Shape of the multigrid hierarchy the solver will build (spec §3.4.1: coarsen while both sides keep ≥ 5 nodes and
 * the level has more than 1000 free nodes, at most 8 levels), with free nodes estimated from the fixed fraction.
 * coarseSide: the shorter effective side of the coarsest level (a Neumann side or the axis doubles it), which sets
 * how many SOR sweeps the coarsest solve takes.
 * @param {object} r resolved project @param {number} fixed fixed-node fraction
 * @returns {{ levels: number, coarseFree: number, coarseSide: number }}
 */
export function multigridShape(r, fixed) {
    const d = r.domain, nx = d.nx, ny = d.ny, free = Math.max(0.02, 1 - fixed);
    let levels = 0, cx = nx, cy = ny;
    for (let l = 0; l < 8; l++) {
        const s = 2 ** l;
        const nxl = Math.ceil((nx - 1) / s) + 1, nyl = Math.ceil((ny - 1) / s) + 1;
        if (l > 0 && (nxl < 5 || nyl < 5)) break;
        levels++; cx = nxl; cy = nyl;
        if (nxl * nyl * free <= 1000) break;
    }
    const e = d.edges || {};
    const soft = (k) => !!(e[k] && (e[k].bc === 'neumann' || e[k].bc === 'axis'));
    const sx = soft('xmin') && soft('xmax') ? Infinity : cx * (soft('xmin') || soft('xmax') ? 2 : 1);
    const sy = soft('ymin') && soft('ymax') ? Infinity : cy * (soft('ymin') || soft('ymax') ? 2 : 1);
    const side = Math.min(sx, sy);
    return { levels, coarseFree: cx * cy * free, coarseSide: Number.isFinite(side) ? side : Math.max(cx, cy) };
}

function sourceEnergyMin(s) {
    const en = (s && s.energy) || {};
    if (en.type === 'mono') return en.ke;
    if (en.type === 'uniform') return en.min;
    if (en.type === 'gaussian') return Math.max(1e-3, en.mean - en.fwhm);
    if (en.type === 'list') return Math.min(...en.values);
    return 0;
}
function sourceStart(s) {
    const p = (s && s.position) || {};
    if (p.type === 'point') return p.p;
    if (p.type === 'line') return [0.5 * (p.p0[0] + p.p1[0]), 0.5 * (p.p0[1] + p.p1[1]), 0.5 * (p.p0[2] + p.p1[2])];
    if (p.type === 'list') return p.points && p.points.length ? p.points[0] : [0, 0, 0];
    return p.center || [0, 0, 0];
}
function rotZ(v, deg) {
    const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
    return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}
function sourceDirection(s) {
    const d = (s && s.direction) || {};
    let v = d.type === 'fixed' ? d.dir : (d.axis || [1, 0, 0]);
    if (d.type === 'fan' && Number.isFinite(d.from) && Number.isFinite(d.to) && d.normal && Math.abs(d.normal[2]) > 0.9) v = rotZ(v, 0.5 * (d.from + d.to) * Math.sign(d.normal[2]));
    const n = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
}
/** Distance from p along unit u to the edge of the box [x0, x1] × [y0, y1] (z unbounded); Infinity if it never leaves. */
function rayToBox(p, u, x0, x1, y0, y1) {
    let t = Infinity;
    if (u[0] > 1e-12) t = Math.min(t, (x1 - p[0]) / u[0]); else if (u[0] < -1e-12) t = Math.min(t, (x0 - p[0]) / u[0]);
    if (u[1] > 1e-12) t = Math.min(t, (y1 - p[1]) / u[1]); else if (u[1] < -1e-12) t = Math.min(t, (y0 - p[1]) / u[1]);
    return Math.max(0, t);
}

/**
 * Typical integration steps per particle of one source (estimates and preview sizes). Beams: the path from the start
 * along the launch direction to the first terminating plane or the grid edge (field-free drift outside the grid costs no
 * steps), doubled when every terminating plane lies behind the start (the particles must turn around); particles slow
 * compared with the electrode voltages (kinetic energy below 5% of |q|·V): the longest distance from the start to a
 * domain edge. RF fields: steps per period over the flight time (the whole time limit for trapped, slow particles).
 * Steps are maxStepCells·h long. A cold estimate: jobs.estimate() prefers the steps measured by the last run or preview.
 * @param {object} r resolved project @param {object} s resolved source
 * @returns {number}
 */
export function sourceSteps(r, s) {
    const d = r.domain, h = d.h, cyl = d.type === 'cyl2d';
    const q = (r.tracer && r.tracer.q) || { maxStepCells: 0.5, rfStepsPerPeriod: 32 };
    const stepLen = q.maxStepCells * h;
    const X0 = d.mirror && d.mirror.x ? -d.x[1] : d.x[0], X1 = d.x[1];
    const Y0 = cyl || (d.mirror && d.mirror.y) ? -d.y[1] : d.y[0], Y1 = d.y[1];
    const Lx = X1 - X0, Ly = Y1 - Y0;
    // voltage scale: electrodes (DC plus waveform amplitudes) and ideal fields
    let vScale = 0, fMax = 0;
    for (const e of r.electrodes || []) {
        let v = Math.abs(e.dc || 0);
        for (const t of e.terms || []) {
            if (t.type === 'table') for (const p of t.points || []) v = Math.max(v, Math.abs(e.dc || 0) + Math.abs(p[1]));
            else v += Math.abs(t.amp || 0);
            if (t.type === 'cos' && t.freq > fMax) fMax = t.freq;
        }
        vScale = Math.max(vScale, v);
    }
    for (const f of r.idealFields || []) {
        if (f.type === 'quadrupole2d' || f.type === 'quadrupole3d') { vScale = Math.max(vScale, Math.abs(f.U || 0) + Math.abs(f.V || 0)); if (f.V && f.freq > fMax) fMax = f.freq; }
    }
    let qMax = 0, mMin = Infinity;
    for (const sp of s.species || []) { qMax = Math.max(qMax, Math.abs(sp.charge || 0)); mMin = Math.min(mMin, sp.mass); }
    const ke = Math.max(sourceEnergyMin(s), 0);
    const slow = ke < 0.05 * qMax * vScale;
    const p0 = sourceStart(s), u = sourceDirection(s);
    const planar3 = cyl ? [p0[0], Math.hypot(p0[1], p0[2]), 0] : p0;
    let path;
    if (slow) path = Math.max(X1 - planar3[0], planar3[0] - X0, Y1 - planar3[1], planar3[1] - Y0);   // pushed across the domain by the field
    else {
        const uu = cyl ? [u[0], Math.hypot(u[1], u[2]), 0] : u;
        let edge = rayToBox(planar3, uu, X0, X1, Y0, Y1);
        let ahead = Infinity, anyTerm = false, allBehind = true;
        for (const pl of (r.recording && r.recording.planes) || []) {
            if (!pl.terminate) continue;
            anyTerm = true;
            let dist = NaN;
            if (pl.kind === 'x' && Math.abs(u[0]) > 1e-9) dist = (pl.at - p0[0]) / u[0];
            else if (pl.kind === 'y' && Math.abs(u[1]) > 1e-9) dist = (pl.at - p0[1]) / u[1];
            else if (pl.kind === 'z' && Math.abs(u[2]) > 1e-9) dist = (pl.at - p0[2]) / u[2];
            else if (pl.kind === 'segment') {
                // ahead of the start: the straight distance to its middle (paths to segments are often curved)
                const mx = 0.5 * (pl.p0[0] + pl.p1[0]) - p0[0], my = 0.5 * (pl.p0[1] + pl.p1[1]) - p0[1];
                dist = mx * u[0] + my * u[1] > 0 ? Math.hypot(mx, my) : -1;
            }
            if (Number.isFinite(dist) && dist > 0) { allBehind = false; ahead = Math.min(ahead, dist); }
        }
        if (!Number.isFinite(edge)) edge = Number.isFinite(ahead) ? ahead : Math.max(Lx, Ly);
        path = Math.min(edge, ahead);
        if (anyTerm && allBehind) path *= 2;
        if (!(path > 0)) path = 0.5 * Math.max(Lx, Ly);
    }
    let steps = path / stepLen;
    if (fMax > 0) {
        const tMax = (r.tracer && r.tracer.tMax) || 1000;
        const v = speedFromKE(Math.max(ke, 1e-3), Number.isFinite(mMin) ? mMin : 1, false);
        const T = slow ? tMax : Math.min(tMax, path / v);
        steps = Math.max(steps, T * fMax * q.rfStepsPerPeriod);
    }
    return Math.max(20, Math.min(steps, (r.tracer && r.tracer.maxSteps) || 5e5));
}

/**
 * Typical integration steps per particle of a resolved project: the particle-weighted mean of sourceSteps.
 * @param {object} r resolved project
 * @returns {number}
 */
export function stepsPerParticle(r) {
    if (!r || !r.domain) return 1000;
    let n = 0, sum = 0;
    for (const s of r.sources || []) {
        const c = Math.max(0, s.count || 0);
        if (!c) continue;
        n += c; sum += c * sourceSteps(r, s);
    }
    return n > 0 ? sum / n : 1000;
}

/**
 * Estimate for a resolved project (spec §3.5, §6): nodes, levels, bases, memory and times; `blockedSolve`/`blockedRun`
 * when a limit is exceeded. Pure: tests call it directly. `measured` ({ stepsPerParticle, stepsPerSec }, from an earlier
 * run or preview of the same field) replaces the step heuristics and the default step rate.
 * @param {object} r resolved project
 * @param {{ workers?: number, mobile?: boolean, measured?: { stepsPerParticle?: number, stepsPerSec?: number } | null }} [o]
 *   workers = workers available for solves and runs
 */
export function estimateProject(r, o = {}) {
    const mobile = !!o.mobile;
    const lim = mobile ? LIMITS.mobile : LIMITS.desktop;
    const Wall = Math.max(1, o.workers || 1);
    const out = { nodes: 0, levels: 0, bases: 0, channels: 0, memMB: 0, solveMemMB: 0, runMemMB: 0, solveMs: 0, fieldMs: 0, runMs: 0,
        particles: 0, stepsPerParticle: 0, stepsPerSec: 0, measured: false, fixedFraction: 0, solveWorkers: 1, traceWorkers: Wall, warnings: [],
        blocked: false, blockedSolve: false, blockedRun: false, blockCode: null, blockMessage: null, confirm: false, limits: lim };
    if (!r || !r.domain || !Number.isFinite(r.domain.N)) return out;
    const { nx, ny, N } = r.domain;
    const K = Math.max(0, (r.electrodes || []).length - 1);
    const C = 1 + (r.channelCount || 0);
    out.nodes = N; out.bases = K; out.channels = C;
    const maxB = lim.maxMemMB * MB;
    // memory (§3.5): main 8NK + 32NC + 3N + display; solve worker ≤ 100N; trace worker 8NK (if ≤ 64 MB) + 32NC + 3N
    const main = 8 * N * K + 32 * N * C + 3 * N + 8 * N + 6 * N;
    let Ws = clamp(Math.min(Wall, Math.max(1, K)), 1, Wall);
    const solveMem = (w) => main + w * 100 * N;
    while (solveMem(Ws) > maxB && Ws > 1) Ws--;
    const basesHeld = 8 * N * K <= HOLD_BASES_BYTES ? 8 * N * K : 0;
    const perTrace = basesHeld + 32 * N * C + 3 * N + 6 * N;
    const n = r.particleCount || 0;
    const trj = (r.recording && r.recording.trajectories) || { store: true, maxPoints: 2000 };
    const pts = trj.store === false ? 0 : Math.min(n * (trj.maxPoints || 2000), lim.pointBudget);
    // crossing rows (14 doubles each): first crossings of 'first' planes, ≤ min(1000, 2e6/n) per particle on 'all' planes and meshes;
    // kept twice while the worker parts are merged
    const planesR = (r.recording && r.recording.planes) || [];
    const nAll = planesR.filter((q) => q && q.record === 'all').length + ((r.electrodes || []).some((e) => e && e.kind === 'grid') ? 1 : 0);
    const nFirst = planesR.length - planesR.filter((q) => q && q.record === 'all').length;
    const crossCap = Math.max(1, Math.min(1000, Math.floor(2e6 / Math.max(1, n))));
    const crossRows = n * (nFirst + nAll * crossCap);
    const results = n * 24 * 8 + pts * 16 * 2 + crossRows * 14 * 8 * 2;
    let Wt = Wall;
    const runMem = (w) => main + w * perTrace + results;
    while (runMem(Wt) > maxB && Wt > 1) Wt--;
    out.solveWorkers = Ws; out.traceWorkers = Wt;
    out.solveMemMB = solveMem(Ws) / MB; out.runMemMB = runMem(Wt) / MB;
    out.memMB = Math.max(out.solveMemMB, out.runMemMB);
    // solve time: hierarchy per solving worker, then the bases in ceil(K / Ws) rounds
    const fixed = K > 0 ? fixedFraction(r) : 0;
    out.fixedFraction = fixed;
    const mg = multigridShape(r, fixed);
    out.levels = mg.levels;
    let perBasis = 0;
    const method = (r.solver && r.solver.method) || 'auto';
    if (K > 0) {
        if (mg.levels >= 3 && method !== 'sor') {
            const fine = CALIBRATION.freeNs * N * (1 - fixed) + CALIBRATION.fixedNs * N * fixed;
            const coarse = CALIBRATION.nsPerNode * CALIBRATION.coarseSweepsPerSide * mg.coarseSide * mg.coarseFree;
            perBasis = CALIBRATION.cycles * (fine + coarse) * 1e-6 * (method === 'krylov' ? 1.5 : 1);   // BiCGSTAB: two V-cycles per iteration, fewer iterations
        } else perBasis = solveEstimate({ nx, ny }, 1, { ...CALIBRATION, maxLevels: 2 }).msPerBasis * (1 - 0.5 * fixed);
    }
    out.solveMs = N * CALIBRATION.hierarchyNs * 1e-6 * (K > 0 ? 1 : 0.4) + perBasis * Math.ceil(K / Ws);
    out.fieldMs = K > 0 ? N * C * CALIBRATION.fieldNsPerNodeChannel * 1e-6 + N * K * C * 2e-6 : 0;
    // run time
    out.particles = n;
    const meas = o.measured || null;
    out.measured = !!(meas && meas.stepsPerParticle > 0);
    out.stepsPerParticle = out.measured ? meas.stepsPerParticle : stepsPerParticle(r);
    const rate = meas && meas.stepsPerSec > 0 ? meas.stepsPerSec
        : (r.tracer && r.tracer.fieldInterp === 'linear' ? CALIBRATION.stepsPerSec.linear : CALIBRATION.stepsPerSec.cubic);
    out.stepsPerSec = rate;
    const busy = Math.min(Wt, Math.max(1, Math.ceil(n / 16)));
    out.runMs = n > 0 ? CALIBRATION.runOverheadMs + n * (out.stepsPerParticle / rate * 1000 + CALIBRATION.particleMs) / busy : 0;
    // limits
    if (Wt < Wall) out.warnings.push(note('W_FEWER_WORKERS', `Memory limits the run to ${Wt} worker${Wt === 1 ? '' : 's'}.`));
    if (N > lim.maxNodes) { out.blockedSolve = true; out.blockCode = 'E_GRID_TOO_LARGE'; out.blockMessage = `The grid has ${N.toLocaleString('en-US')} nodes; the limit${mobile ? ' on phones' : ''} is ${lim.maxNodes.toLocaleString('en-US')}.`; }
    else if (solveMem(Ws) > maxB) { out.blockedSolve = true; out.blockCode = 'E_MEMORY'; out.blockMessage = `Solving needs about ${Math.round(out.solveMemMB)} MB; the limit${mobile ? ' on phones' : ''} is ${lim.maxMemMB} MB.`; }
    if (out.blockedSolve) out.blockedRun = true;
    else if (n > lim.maxParticles) { out.blockedRun = true; out.blockCode = 'E_LIMIT'; out.blockMessage = `The run has ${n.toLocaleString('en-US')} particles; the limit${mobile ? ' on phones' : ''} is ${lim.maxParticles.toLocaleString('en-US')}.`; }
    else if (runMem(Wt) > maxB) { out.blockedRun = true; out.blockCode = 'E_MEMORY'; out.blockMessage = `This run needs about ${Math.round(out.runMemMB)} MB; the limit${mobile ? ' on phones' : ''} is ${lim.maxMemMB} MB.`; }
    out.blocked = out.blockedSolve || out.blockedRun;
    if (!out.blocked && out.memMB > lim.warnMemMB) out.warnings.push(note('W_MEMORY', `This job needs about ${Math.round(out.memMB)} MB.`));
    if (N > lim.warnNodes && !out.blockedSolve) out.warnings.push(note('W_GRID_LARGE', `${N.toLocaleString('en-US')} nodes: solving will take a while.`));
    if (out.blocked) out.warnings.push(note(out.blockCode, out.blockMessage));
    out.confirm = !out.blocked && (out.solveMs > 5000 || out.runMs > 5000 || out.memMB > 0.7 * lim.maxMemMB);
    return out;
}

/** Runs task factories with at most `limit` in flight; returns allSettled-style results. Stops starting new ones once `stop()`. */
async function runLimited(factories, limit, stop = () => false) {
    const results = new Array(factories.length);
    let next = 0;
    async function lane() {
        while (next < factories.length) {
            const i = next++;
            if (stop()) { results[i] = { status: 'rejected', reason: cancelled() }; continue; }
            try { results[i] = { status: 'fulfilled', value: await factories[i]() }; } catch (e) { results[i] = { status: 'rejected', reason: e }; }
        }
    }
    const lanes = [];
    for (let k = 0; k < Math.max(1, Math.min(limit, factories.length)); k++) lanes.push(lane());
    await Promise.all(lanes);
    return results;
}

/**
 * Creates the job manager.
 * @param {object} store from createStore
 * @param {object|null} pool from createPool (null: an inline pool on the main thread)
 * @param {object} [persist] persist.js namespace (basisCache); optional
 * @param {{ mobile?: boolean, autoStart?: boolean, autoSolveDelayMs?: number, previewDelayMs?: number }} [opts]
 */
export function createJobs(store, pool, persist = null, opts = {}) {
    const mobile = opts.mobile === undefined ? detectMobile() : !!opts.mobile;
    const ownPool = !pool;
    if (ownPool) pool = createPool({ inline: true, mobile });
    const lim = mobile ? LIMITS.mobile : LIMITS.desktop;
    const autoSolveDelay = opts.autoSolveDelayMs === undefined ? 250 : opts.autoSolveDelayMs;
    const previewDelay = opts.previewDelayMs === undefined ? 30 : opts.previewDelayMs;
    const listeners = new Map();
    let epoch = 0, runSeq = 0, tmpSeq = 0, idSeq = 0;
    let autoTimer = null, previewTimer = null;
    let fullRun = null;   // { runId, group, cancelled }
    let lastKeys = { ...store.get().keys };
    let destroyed = false;

    function emit(evt, payload) {
        for (const name of [evt, '*']) {
            const set = listeners.get(name);
            if (set) for (const fn of [...set]) { try { fn(payload, evt); } catch (e) { /* listener errors are not ours */ } }
        }
    }
    /** Errors without a solve/run status to show them: the store's 'error' event (toast, Log, live region). */
    function reportToStore(e, where) {
        if (isCancel(e)) return;
        const info = { source: 'jobs', where, ...errInfo(e) };
        emit(`${where}:error`, info);
        try { store.emit('error', info); } catch (err) { /* store without emit */ }
    }
    const offPool = [];
    if (typeof pool.on === 'function') {
        offPool.push(pool.on('log', (m) => emit('log', { level: m.level || 'info', message: m.message, id: m.id })));
        offPool.push(pool.on('fallback', (m) => emit('fallback', m)));
        offPool.push(pool.on('version', (m) => { emit('version', m); emit('versionMismatch', m); }));
        offPool.push(pool.on('crash', (m) => emit('log', { level: 'warn', message: `An engine worker stopped and was restarted: ${m && m.message ? m.message : ''}` })));
    }
    // no worker pool was available: everything runs on the main thread (the page shows a banner)
    if (ownPool) setTimeout(() => { if (!destroyed) emit('fallback', { reason: 'No worker pool.' }); }, 0);
    const workers = () => Math.max(1, typeof pool.traceWorkers === 'function' ? pool.traceWorkers() : Math.max(1, (pool.size || 1) - 1));
    const estimateFor = (r, measured = null) => estimateProject(r, { workers: workers(), mobile, measured });
    /** Steps per particle and step rate measured by the last run or preview of the current field (null if none). */
    function measuredRun() {
        const st = store.get();
        const res = st.run && st.run.result;
        if (!res || !st.keys || res.fieldKey !== st.keys.fieldKey || !res.stats || !(res.n > 0) || !(res.stats.steps > 0)) return null;
        return { stepsPerParticle: res.stats.steps / res.n, stepsPerSec: res.stats.ms > 0 ? res.stats.steps / res.stats.ms * 1000 : 0 };
    }

    // ---------------------------------------------------------------- contexts
    // A context bundles a resolved project with its keys, solution and field, and where updates go.
    const storeShared = { solving: null };
    function storeCtx() {
        const st = store.get();
        return {
            kind: 'store', resolved: st.resolved, keys: { ...st.keys }, shared: storeShared, group: '',
            get solution() { return store.get().solution; },
            get field() { return store.get().field; },
            setSolve: (p) => store.setSolve(p), setSolution: (s) => store.setSolution(s), setField: (f) => store.setField(f),
        };
    }

    // ---------------------------------------------------------------- solve
    // the two most recent solutions of the interface (bases ≤ 64 MB each), so undoing a geometry edit needs no solve
    const recentSolutions = new Map();
    function rememberSolution(s) {
        let bytes = 0;
        for (const phi of s.bases.values()) bytes += phi.byteLength;
        if (bytes > HOLD_BASES_BYTES) return;
        recentSolutions.delete(s.geomKey);
        recentSolutions.set(s.geomKey, s);
        while (recentSolutions.size > 2) recentSolutions.delete(recentSolutions.keys().next().value);
    }

    async function doSolve(c, { force = false } = {}) {
        const r = c.resolved;
        if (!r) throw Object.assign(new EngineError('E_BAD_PROJECT', 'The project has errors; fix them before solving.'), { stage: 'solve' });
        const geomKey = c.keys.geomKey;
        const sol = c.solution;
        if (!force && sol && sol.geomKey === geomKey) return sol;
        const sh = c.shared;
        if (sh.solving && sh.solving.geomKey === geomKey && !force) return sh.solving.promise;
        if (!force && c.kind === 'store' && recentSolutions.has(geomKey)) {
            const again = recentSolutions.get(geomKey);
            recentSolutions.delete(geomKey); recentSolutions.set(geomKey, again);
            if (sh.solving) { sh.solving.cancelled = true; pool.cancel(sh.solving.group); sh.solving = null; }
            c.setSolution(again);
            c.setSolve({ status: 'done', progress: null, stats: again.stats, error: null, geomKey, ms: again.ms, warnings: again.warnings });
            emit('solve:done', { geomKey, stats: again.stats, ms: 0, temporary: false, reused: true });
            return again;
        }
        if (sh.solving) { sh.solving.cancelled = true; pool.cancel(sh.solving.group); }
        const est = estimateFor(r);
        if (est.blockedSolve) {
            const err = Object.assign(new EngineError(est.blockCode, est.blockMessage), { stage: 'solve' });
            c.setSolve({ status: 'error', progress: null, error: errInfo(err), geomKey });
            throw err;
        }
        const ks = basisElectrodes(r);
        const group = `${c.group}solve:${++idSeq}`;
        const token = { geomKey, cancelled: false, group, promise: null };
        sh.solving = token;
        c.setSolve({ status: 'running', progress: { frac: 0, done: 0, total: ks.length, text: 'Solving fields' }, stats: [], error: null, geomKey });
        const t0 = now();
        token.promise = (async () => {
            const bases = new Map();
            const stats = [];
            let packed = null;
            const cache = persist && persist.basisCache;
            const useCache = !!(cache && (typeof cache.enabled === 'function' ? cache.enabled() : cache.enabled));
            if (useCache) {
                for (const k of ks) {
                    try {
                        const phi = await cache.get(geomKey, k);
                        if (phi && phi.length === r.domain.N) bases.set(k, phi);
                    } catch (e) { /* the cache is best effort */ }
                }
                if (token.cancelled) throw cancelled();
            }
            const todo = ks.filter((k) => !bases.has(k));
            const fr = new Map();
            let done = ks.length - todo.length, lastProgress = -Infinity;
            const onMessage = (m) => {
                if (token.cancelled) return;
                if (m.type === 'progress') {
                    fr.set(m.k, clamp(m.frac || 0, 0, 1));
                    const t = now();
                    if (t - lastProgress < PROGRESS_MS) return;
                    lastProgress = t;
                    let f = done;
                    for (const [k, v] of fr) if (!bases.has(k)) f += v;
                    const frac = ks.length ? f / ks.length : 1;
                    const text = m.phase === 'raster' ? 'Solving fields: preparing the grid'
                        : `Solving fields: electrode ${Math.min(ks.length, done + 1)}/${ks.length}${m.cycle ? ` · cycle ${m.cycle}` : ''}${m.estErr ? ` · est. error ${fmtSci(m.estErr)}` : ''}`;
                    const p = { frac: clamp(frac, 0, 1), done, total: ks.length, k: m.k, phase: m.phase, cycle: m.cycle, estErr: m.estErr, text };
                    c.setSolve({ progress: p });
                    emit('solve:progress', p);
                } else if (m.type === 'raster') packed = m.packed;
                else if (m.type === 'basis') {
                    bases.set(m.k, m.phi);
                    stats.push({ ...m.stats, k: m.k });
                    done++;
                    if (useCache) { try { Promise.resolve(cache.put(geomKey, m.k, m.phi, { nodes: r.domain.N })).catch(() => {}); } catch (e) { /* best effort */ } }
                }
            };
            const exec = (electrodes, wantRaster) => () => pool.exec({ type: 'solve', geomKey, resolved: r, electrodes, wantRaster }, { group, priority: 1, onMessage });
            const factories = todo.length === 0 ? [exec([], true)] : todo.map((k, q) => exec([k], q === 0));
            const settled = await runLimited(factories, est.solveWorkers, () => token.cancelled);
            if (token.cancelled) throw cancelled();
            const bad = settled.find((s) => s.status === 'rejected');
            if (bad) throw bad.reason;
            if (!packed) throw new EngineError('E_INTERNAL', 'The solve returned no grid.');
            const raster0 = unpackRaster(packed);
            const geometry = compileGeometry(r);
            stats.sort((a, b) => a.k - b.k);
            let warnings = [];
            try { warnings = geometryWarnings(geometry, r, raster0).map((w) => ({ ...w, path: projectPath(r, w.path) })); } catch (e) { warnings = []; }
            try { pool.broadcast({ type: 'drop', hierarchy: geomKey }); } catch (e) { /* best effort */ }
            return { geomKey, raster0, packed, bases, geometry, stats, warnings, resolved: r, ms: now() - t0 };
        })();
        try {
            const s = await token.promise;
            if (sh.solving === token) sh.solving = null;
            if (c.kind === 'store') rememberSolution(s);
            c.setSolution(s);
            const current = c.kind === 'store' ? store.get().keys.geomKey : geomKey;
            c.setSolve({ status: s.geomKey === current ? 'done' : 'stale', progress: null, stats: s.stats, error: null, geomKey, ms: s.ms, warnings: s.warnings });
            const info = { geomKey, stats: s.stats, ms: s.ms, temporary: c.kind !== 'store' };
            emit('solve:done', info);
            emit('solved', info);
            return s;
        } catch (e0) {
            const e = e0 && typeof e0 === 'object' ? e0 : new EngineError('E_INTERNAL', String(e0));
            const superseded = sh.solving !== null && sh.solving !== token;   // a newer solve owns the status
            if (sh.solving === token) sh.solving = null;
            if (token.cancelled || isCancel(e)) {
                if (!superseded) {
                    const cur = c.solution;
                    const gk = c.kind === 'store' ? store.get().keys.geomKey : geomKey;
                    c.setSolve({ status: cur ? (cur.geomKey === gk ? 'done' : 'stale') : 'none', progress: null });
                }
                throw Object.assign(cancelled(), { stage: 'solve' });
            }
            if (!superseded) c.setSolve({ status: 'error', progress: null, error: errInfo(e) });
            emit('solve:error', { where: 'solve', ...errInfo(e) });
            e.stage = 'solve';
            throw e;
        }
    }

    // ---------------------------------------------------------------- field
    async function doField(c, { displayTime } = {}) {
        const sol = await doSolve(c);
        const fieldKey = c.keys.fieldKey;
        const prev = c.field;
        const t = typeof displayTime === 'number' ? displayTime : (prev && typeof prev.displayTime === 'number' ? prev.displayTime : ((c.resolved.view && c.resolved.view.displayTime) || 0));
        if (prev && prev.fieldKey === fieldKey && prev.geomKey === sol.geomKey && prev.built) {
            if (prev.displayTime !== t) {
                const timeDependent = prev.built.channels && prev.built.channels.length > 1;
                c.setField({ displayPhi: timeDependent ? displayPotential(prev.built, t) : prev.displayPhi, displayTime: t });
            }
            return c.field;
        }
        const t0 = now();
        const built = buildField(c.resolved, sol);
        const displayPhi = displayPotential(built, t);
        const state = { fieldKey, geomKey: sol.geomKey, runKey: c.keys.runKey, grid: built.grid, model: built.model, channels: built.channels, geometry: built.geometry, built,
            displayPhi, displayTime: t, resolved: c.resolved, ms: now() - t0 };
        // an edit made while this field was built has moved the store on: never overwrite a newer field with an older one
        if (c.kind === 'store' && store.get().keys.fieldKey !== fieldKey) return state;
        c.setField(state);
        return c.field;
    }

    // ---------------------------------------------------------------- tracing over the pool
    function setupFor(c, sol, fld) {
        const { geomKey, fieldKey, runKey } = c.keys;
        const r = c.resolved;
        const N = sol.raster0.grid.N;
        const hold = 8 * N * sol.bases.size <= HOLD_BASES_BYTES;
        return (slot) => {
            const msgs = [];
            const h = slot.holds;
            if (h.geomKey !== geomKey) {
                msgs.push({ msg: { type: 'loadBases', geomKey, packedRaster: sol.packed, bases: hold ? [...sol.bases].map(([k, phi]) => ({ k, phi })) : [] } });
            }
            const hasField = h.geomKey === geomKey && h.fields.some((f) => f.fieldKey === fieldKey);
            if (!hasField || !h.runKeys.includes(runKey)) {
                const m = { type: 'setField', fieldKey, runKey, geomKey, resolved: r };
                if (!hold && !hasField && fld.channels.length) m.channels = fld.channels.map((ch) => ({ phi: ch.phi }));
                msgs.push({ msg: m });
            }
            return msgs;
        };
    }

    /** Traces ranges or particle rows through the pool; resolves with { result (merged), partial, parts }. */
    async function traceRun(c, { ranges = null, particles = null, total, overrides = {}, priority = 1, group, onProgress = null, limit = Infinity, stop = () => false }) {
        const sol = c.solution, fld = c.field;
        const { fieldKey, runKey } = c.keys;
        // the bases and field must belong to this context's keys (an edit during a solve can move the store on)
        if (!sol || sol.geomKey !== c.keys.geomKey || !fld || fld.fieldKey !== fieldKey) throw cancelled('Superseded by an edit.');
        const setup = setupFor(c, sol, fld);
        const doneBy = new Map();
        let doneAll = 0, finishedAll = 0;   // particles traced so far, and those in finished chunks (the ones a Stop keeps)
        const mk = (msg, transfer, key, count) => () => pool.exec(msg, {
            transfer, priority, group, affinity: fieldKey, setup,
            onMessage: (m) => {
                if (m.type !== 'progress' || !onProgress) return;
                const prevDone = doneBy.get(key) || 0;
                const d = Math.min(count, m.done || 0);
                doneAll += d - prevDone; doneBy.set(key, d);
                onProgress(doneAll, finishedAll);
            },
        }).then((reply) => {
            const prevDone = doneBy.get(key) || 0;
            doneAll += count - prevDone; doneBy.set(key, count);
            finishedAll += count;
            if (onProgress) onProgress(doneAll, finishedAll);
            return reply.result;
        });
        const factories = [];
        if (particles) {
            const n = Math.floor(particles.length / P_STRIDE);
            const W = priority === 0 ? 1 : workers();
            const chunk = clamp(Math.ceil(n / (4 * W)), 16, 512);
            for (let a = 0; a < n; a += chunk) {
                const b = Math.min(n, a + chunk);
                const part = particles.slice(a * P_STRIDE, b * P_STRIDE);
                factories.push(mk({ type: 'trace', fieldKey, runKey, particles: part, overrides, total: total || n }, [part.buffer], 'p' + a, b - a));
            }
        } else {
            for (const [a, b] of ranges) factories.push(mk({ type: 'trace', fieldKey, runKey, range: [a, b], overrides, total }, [], 'r' + a, b - a));
        }
        const settled = await runLimited(factories, limit, stop);
        const parts = [];
        let partial = false, failure = null;
        for (const s of settled) {
            if (s.status === 'fulfilled') parts.push(s.value);
            else if (isCancel(s.reason)) partial = true;
            else if (!failure) failure = s.reason;
        }
        if (failure) throw failure;
        return { result: mergeResults(parts), partial, parts: parts.length, traced: doneAll, finished: finishedAll };
    }

    function chunkRanges(n, W, offset = 0) {
        const chunk = clamp(Math.ceil(n / (4 * Math.max(1, W))), 16, 512);
        const out = [];
        for (let a = 0; a < n; a += chunk) out.push([offset + a, offset + Math.min(n, a + chunk)]);
        return out;
    }

    // ---------------------------------------------------------------- full runs
    async function runFull() {
        let c = storeCtx();
        if (!c.resolved) {
            const err = new EngineError('E_BAD_PROJECT', 'The project has errors; fix them before running.');
            store.setRun({ status: 'error', error: errInfo(err), progress: null });
            throw err;
        }
        // field for the current keys (re-solving if the project changed while solving)
        for (let attempt = 0; ; attempt++) {
            await doField(c);
            const c2 = storeCtx();
            if (!c2.resolved) throw cancelled('The project has errors.');
            if (c2.field && c2.field.fieldKey === c2.keys.fieldKey && c2.solution && c2.solution.geomKey === c2.keys.geomKey) { c = c2; break; }
            if (attempt >= 2) throw cancelled('Superseded by an edit.');
            c = c2;
        }
        const r = c.resolved;
        const est = estimateFor(r, measuredRun());
        if (est.blockedRun) {
            const err = new EngineError(est.blockCode, est.blockMessage);
            store.setRun({ status: 'error', error: errInfo(err), progress: null });
            throw Object.assign(err, { stage: 'run' });
        }
        if (fullRun) { fullRun.cancelled = true; pool.cancel(fullRun.group); }
        const myEpoch = ++epoch;
        const runId = ++runSeq;
        const group = `run:${runId}`;
        const token = { runId, group, cancelled: false };
        fullRun = token;
        pool.cancelQueued('preview');
        const n = r.particleCount;
        const W = est.traceWorkers;
        const t0 = now();
        let lastProgress = -Infinity, trailing = null, pendingDone = 0, pendingFinished = 0;
        store.setRun({ status: 'running', progress: { done: 0, total: n, etaMs: null, text: `0/${n} particles` }, live: false, runKey: c.keys.runKey, epoch: myEpoch, error: null });
        const publish = (done) => {
            const t = now();
            lastProgress = t;
            const el = t - t0;
            const etaMs = done > 0 ? el * (n - done) / done : null;
            const fin = Math.min(done, pendingFinished);
            const text = `${done}/${n} particles${fin < done ? ` (${fin} in finished batches)` : ''}${etaMs !== null && done < n ? ` · about ${Math.max(1, Math.round(etaMs / 1000))} s left` : ''}`;
            const p = { done, finished: fin, total: n, etaMs, text };
            store.setRun({ progress: p });
            emit('run:progress', p);
        };
        const stopTrailing = () => { if (trailing) { clearTimeout(trailing); trailing = null; } };
        let out;
        try {
            out = await traceRun(c, {
                ranges: chunkRanges(n, W), total: n, priority: 1, group, limit: W, stop: () => token.cancelled,
                onProgress: (done, finished = done) => {
                    pendingFinished = finished;
                    if (token.cancelled) return;
                    const t = now();
                    if (t - lastProgress < PROGRESS_MS && done < n) {
                        // throttled: publish the latest count shortly, so a long pause never leaves a stale count
                        pendingDone = done;
                        if (!trailing) trailing = setTimeout(() => { trailing = null; if (!token.cancelled && fullRun === token) publish(pendingDone); }, Math.max(0, PROGRESS_MS - (t - lastProgress)));
                        return;
                    }
                    stopTrailing();
                    publish(done);
                },
            });
        } catch (e) {
            stopTrailing();
            const superseded = fullRun !== null && fullRun !== token;
            if (fullRun === token) fullRun = null;
            if (!superseded && !isCancel(e)) store.setRun({ status: 'error', progress: null, error: errInfo(e) });
            if (!isCancel(e)) emit('run:error', { where: 'run', ...errInfo(e) });
            throw Object.assign(e, { stage: 'run' });
        }
        stopTrailing();
        const superseded = fullRun !== null && fullRun !== token;   // a newer full run owns the run state
        if (fullRun === token) fullRun = null;
        const partial = out.partial || token.cancelled;
        const summary = summarize(out.result, r);
        // Stop keeps whole finished batches only: say how many particles were kept and how many traced ones were dropped
        const partialNote = partial ? `Stopped: kept the ${out.result.n} particles of the finished batches${out.traced > out.result.n ? `; ${out.traced - out.result.n} particles traced in unfinished batches were discarded` : ''}.` : null;
        // the TraceResult itself (summary rows, crossings, trajectories) plus run metadata
        const result = { ...out.result, runId, epoch: myEpoch, fieldKey: c.keys.fieldKey, runKey: c.keys.runKey, live: false, partial, partialNote,
            resolvedSnapshot: r, wallMs: now() - t0, workers: W };
        if (superseded) return result;   // a newer run owns the state and its events
        store.setRun({ status: partial ? 'partial' : 'done', progress: null, result, summary, live: false, runKey: c.keys.runKey, epoch: myEpoch, partial, error: null });
        emit('run:done', result);
        emit('ran', result);
        return result;
    }

    function cancelRun() {
        if (fullRun) { fullRun.cancelled = true; pool.cancel(fullRun.group); }
    }

    function cancelSolve() {
        const t = storeShared.solving;
        if (t) { t.cancelled = true; pool.cancel(t.group); }
    }

    // ---------------------------------------------------------------- live preview
    async function previewRun() {
        let c = storeCtx();
        if (!c.resolved || destroyed) return null;
        const sol = c.solution;
        if (!sol || sol.geomKey !== c.keys.geomKey) return null;   // the solve comes first
        const myEpoch = ++epoch;
        await doField(c);
        if (myEpoch !== epoch || destroyed || fullRun) return null;
        c = storeCtx();
        if (!c.field || c.field.fieldKey !== c.keys.fieldKey) return null;   // edited meanwhile: a newer preview follows
        const r = c.resolved;
        const per = clamp(Math.floor(40000 / stepsPerParticle(r)), 4, mobile ? 50 : 200);
        const chunks = [];
        let n = 0;
        for (const s of r.sources) {
            const m = Math.min(per, s.count);
            if (m <= 0) continue;
            chunks.push(generate(r.sources, s.firstId, s.firstId + m, { domainType: r.domain.type, relativistic: r.tracer.relativistic !== false }));
            n += m;
        }
        const particles = new Float64Array(n * P_STRIDE);
        let o = 0;
        for (const ch of chunks) { particles.set(ch, o); o += ch.length; }
        pool.cancelQueued('preview');   // older previews that have not started are superseded
        const t0 = now();
        const out = await traceRun(c, { particles, total: n, priority: 0, group: 'preview' });
        if (myEpoch !== epoch || destroyed || fullRun || out.partial) return null;   // superseded: ignored
        const summary = summarize(out.result, r);
        const result = { ...out.result, runId: null, epoch: myEpoch, fieldKey: c.keys.fieldKey, runKey: c.keys.runKey, live: true, partial: false,
            resolvedSnapshot: r, wallMs: now() - t0, workers: 1 };
        store.setRun({ status: 'done', progress: null, result, summary, live: true, runKey: c.keys.runKey, epoch: myEpoch, partial: false, error: null });
        emit('preview:done', result);
        emit('preview', result);
        return result;
    }

    function schedulePreview() {
        if (destroyed) return;
        if (previewTimer) clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
            previewTimer = null;
            preview();
        }, previewDelay);
    }

    // ---------------------------------------------------------------- automatic behaviour
    function afterSolve() {
        const st = store.get();
        if (destroyed || !st.resolved || !st.solution || st.solution.geomKey !== st.keys.geomKey) return;
        if (st.resolved.particleCount > 0 && st.resolved.particleCount <= 500) run({ mode: 'full' });
        else if (st.ui.live !== false) schedulePreview();
        else ensureField();
    }

    function scheduleAutoSolve() {
        if (autoTimer) clearTimeout(autoTimer);
        autoTimer = setTimeout(() => {
            autoTimer = null;
            const st = store.get();
            if (destroyed || !st.resolved || st.ui.autoSolve === false) return;
            if (st.solution && st.solution.geomKey === st.keys.geomKey) { afterSolve(); return; }
            if (!recentSolutions.has(st.keys.geomKey)) {
                const est = estimateFor(st.resolved);
                if (est.blockedSolve || est.solveMs > AUTO_SOLVE_MS) { emit('solve:pulse', est); return; }
            }
            solve().then((s) => { if (s) afterSolve(); });
        }, autoSolveDelay);
    }

    const offResolved = store.on('resolved', (state, _st, info) => {
        const st = state && state.keys ? state : store.get();
        if (destroyed || !st.valid) return;
        const keys = st.keys;
        const prev = lastKeys;
        lastKeys = { ...keys };
        // a loaded project (preset, file, link, Recent, undo of a load) clears the solution even when its keys equal the
        // previous ones: it is then treated like a new geometry (a recent solution is reused without a solve job)
        const loaded = info && (info.kind === 'replace' || info.kind === 'undo' || info.kind === 'redo');
        const solved = st.solution && st.solution.geomKey === keys.geomKey;
        const solving = storeShared.solving && storeShared.solving.geomKey === keys.geomKey;
        if (keys.geomKey !== prev.geomKey || (loaded && !solved && !solving)) { scheduleAutoSolve(); return; }
        if (keys.fieldKey !== prev.fieldKey) {
            if (st.solution && st.solution.geomKey === keys.geomKey) {
                ensureField().then((f) => { if (f && store.get().ui.live !== false) schedulePreview(); });
            }
            return;
        }
        if (keys.runKey !== prev.runKey && st.ui.live !== false && st.solution && st.solution.geomKey === keys.geomKey) schedulePreview();
    });

    // ---------------------------------------------------------------- public wrappers (never reject)
    async function solve({ force = false } = {}) {
        const c = storeCtx();
        if (!c.resolved) {
            store.setSolve({ status: 'error', progress: null, error: { code: 'E_BAD_PROJECT', message: 'The project has errors; fix them before solving.' }, geomKey: null });
            return null;
        }
        try { return await doSolve(c, { force }); } catch (e) { return null; }   // the solve state shows the error
    }
    async function ensureSolution() { return solve({ force: false }); }
    async function ensureField(o = {}) {
        try {
            const c = storeCtx();
            if (!c.resolved) return null;
            const sol = c.solution;
            const current = sol && sol.geomKey === c.keys.geomKey;
            const solving = storeShared.solving && storeShared.solving.geomKey === c.keys.geomKey;
            if (!current && !solving && o.solve === false) return null;
            return await doField(c, o);
        } catch (e) {
            if (!(e && e.stage === 'solve')) reportToStore(e, 'field');
            return null;
        }
    }
    async function run({ mode = 'full' } = {}) {
        if (mode === 'live') return preview();
        try { return await runFull(); } catch (e) { return null; }   // the run (or solve) state shows the error
    }
    async function preview() {
        try { return await previewRun(); } catch (e) {
            if (!(e && e.stage === 'solve')) reportToStore(e, 'preview');
            return null;
        }
    }
    function setLive(on) {
        const v = !!on;
        if (store.get().ui.live !== v) store.setUi('live', v);
        if (v) schedulePreview();
    }

    // ---------------------------------------------------------------- temporary projects and batches
    async function withTemporaryProject(project, fn) {
        const res = resolve(project, { mobile });
        if (!res.resolved) {
            const first = res.errors[0] || { path: '', message: 'Invalid project.' };
            throw new EngineError('E_BAD_PROJECT', `${first.path ? first.path + ': ' : ''}${first.message}`, first.path, { errors: res.errors });
        }
        const keys = projectKeys(res.resolved);
        const local = { solution: null, field: null, solve: { status: 'none', progress: null, stats: [], error: null, geomKey: null }, run: { status: 'none', result: null } };
        const st = store.get();
        if (st.solution && st.solution.geomKey === keys.geomKey) local.solution = st.solution;   // same geometry: reuse the bases
        const prefix = `tmp${++tmpSeq}:`;
        const tc = {
            kind: 'temporary', resolved: res.resolved, keys, shared: { solving: null }, group: prefix,
            get solution() { return local.solution; }, get field() { return local.field; },
            setSolve: (p) => { local.solve = { ...local.solve, ...(p || {}) }; },
            setSolution: (s) => { local.solution = s; },
            setField: (f) => { local.field = f === null ? null : { ...(local.field || {}), ...f }; },
        };
        const W = () => workers();
        const cancelAll = () => {
            for (const g of [prefix + 'trace', prefix + 'run']) pool.cancel(g);
            if (tc.shared.solving) { tc.shared.solving.cancelled = true; pool.cancel(tc.shared.solving.group); }
        };
        const tmp = {
            resolved: res.resolved, keys, warnings: res.warnings,
            estimate: () => estimateFor(res.resolved),
            solve: (o = {}) => doSolve(tc, o),
            ensureSolution: () => doSolve(tc),
            ensureField: (o = {}) => doField(tc, o),
            get solution() { return local.solution; },
            get field() { return local.field; },
            traceBatch: async ({ particles = null, range = null, overrides = {} } = {}) => {
                await doField(tc);
                const r0 = range ? range[0] : 0, r1 = range ? range[1] : res.resolved.particleCount;
                const n = particles ? Math.floor(particles.length / P_STRIDE) : 0;
                const out = particles
                    ? await traceRun(tc, { particles, total: n, overrides, priority: 1, group: prefix + 'trace' })
                    : await traceRun(tc, { ranges: chunkRanges(r1 - r0, W(), r0), total: res.resolved.particleCount, overrides, priority: 1, group: prefix + 'trace' });
                if (out.partial) throw cancelled();
                return out.result;
            },
            run: async ({ overrides = {} } = {}) => {
                await doField(tc);
                const n = res.resolved.particleCount;
                const t0 = now();
                const out = await traceRun(tc, { ranges: chunkRanges(n, W()), total: n, overrides, priority: 1, group: prefix + 'run' });
                const result = { ...out.result, partial: out.partial, live: false, fieldKey: keys.fieldKey, runKey: keys.runKey, resolvedSnapshot: res.resolved,
                    wallMs: now() - t0, workers: W() };
                local.run = { status: out.partial ? 'partial' : 'done', result, summary: summarize(out.result, res.resolved) };
                return result;
            },
            cancel: cancelAll, cancelSolve: cancelAll, cancelRun: cancelAll,
            on: () => () => {},
        };
        tmp.jobs = tmp;
        tmp.store = {
            get: () => ({ project, resolved: res.resolved, keys, valid: true, issues: { errors: res.errors, warnings: res.warnings }, solution: local.solution, field: local.field,
                solve: local.solve, run: local.run, ui: {} }),
            project, resolved: res.resolved, keys, valid: true, issues: { errors: res.errors, warnings: res.warnings },
            on: () => () => {},
        };
        try {
            // fn may take the jobs-like object itself or destructure { store, jobs } from it
            return await fn(tmp);
        } finally {
            local.field = null;
            local.solution = null;
        }
    }

    async function traceBatch({ particles = null, range = null, overrides = {}, project = null } = {}) {
        if (project) return withTemporaryProject(project, (tmp) => tmp.traceBatch({ particles, range, overrides }));
        const c = storeCtx();
        if (!c.resolved) throw new EngineError('E_BAD_PROJECT', 'The project has errors; fix them before tracing.');
        await doField(c);
        const c2 = storeCtx();
        if (!c2.field || c2.field.fieldKey !== c2.keys.fieldKey) await doField(c2);
        const n = particles ? Math.floor(particles.length / P_STRIDE) : 0;
        const r0 = range ? range[0] : 0, r1 = range ? range[1] : c2.resolved.particleCount;
        const out = particles
            ? await traceRun(c2, { particles, total: n, overrides, priority: 1, group: 'batch' })
            : await traceRun(c2, { ranges: chunkRanges(r1 - r0, workers(), r0), total: c2.resolved.particleCount, overrides, priority: 1, group: 'batch' });
        if (out.partial) throw cancelled();
        return out.result;
    }

    // ---------------------------------------------------------------- benchmarks
    async function runBenchmarks({ ids = null, level = 'quick', onResult = null } = {}) {
        let list = ids;
        if (!Array.isArray(list)) {
            try {
                const mod = await import('../engine/bench/cases.js');
                list = (mod.BENCHMARKS || []).filter((b) => b.kind !== 'planned').map((b) => b.id);
            } catch (e) {
                reportToStore(new EngineError('E_UNSUPPORTED', 'The benchmark cases are not available in this build.'), 'bench');
                list = [];
            }
        }
        const all = list.map((id) => pool.exec({ type: 'bench', caseId: id, level }, {
            priority: 2, group: 'bench', onMessage: (m) => { if (m.type === 'progress') emit('bench:progress', { id, frac: m.frac, msg: m.msg }); },
        }).then((reply) => reply.result, (e) => ({ id, level, status: isCancel(e) ? 'cancelled' : 'error', message: e && e.message ? e.message : String(e), engineVersion: ENGINE_VERSION, checks: [] }))
            .then((res) => {
                if (onResult) { try { onResult(res); } catch (e) { /* caller */ } }
                emit('bench:result', res);
                return res;
            }));
        return Promise.all(all);
    }

    function cancelBenchmarks() { pool.cancel('bench'); }

    // ---------------------------------------------------------------- public API
    const jobs = {
        /**
         * Nodes, levels, bases, memory (MB), solve/run times (ms), warnings, `blocked`, `confirm` for the current project.
         * After a run or live preview of the current field, the run time uses its measured steps per particle and step rate.
         */
        estimate() { const st = store.get(); return st.resolved ? estimateFor(st.resolved, measuredRun()) : estimateFor(st.lastResolved); },
        /** Solves the basis fields (no-op when the solution is current, unless `force`). Resolves with the solution or null. */
        solve,
        cancelSolve,
        /** Full run of every particle, or a live preview with mode 'live'. Resolves with the result or null. */
        run,
        cancelRun,
        /** Solves if the solution is stale. Resolves with the solution or null. */
        ensureSolution,
        /** Geometry warnings of the current solution (project paths). */
        geometryWarnings() { const s = store.get().solution; return s && s.warnings ? s.warnings : []; },
        /**
         * Builds the main-thread field and the display potential at displayTime, solving first when the solution is
         * stale (`solve: false`: never solve, resolve null instead). Resolves with the store's field state
         * { fieldKey, grid, model, channels, geometry, displayPhi, displayTime } or null if it could not be built (the
         * error is in the solve state or the store's 'error' event).
         */
        ensureField,
        traceBatch,
        withTemporaryProject,
        runBenchmarks,
        cancelBenchmarks,
        /** Starts a live preview now (normally automatic on edits). */
        preview,
        /** Live mode on or off (ui.live); turning it on starts a preview. */
        setLive,
        /** Subscribes: 'solve:progress' 'solve:done' 'solve:error' 'solve:pulse' 'run:progress' 'run:done' 'run:error' 'preview:done'
         * 'preview:error' 'field:error' 'bench:progress' 'bench:result' 'log' 'fallback' 'version' 'versionMismatch' (or '*'). */
        on(evt, fn) {
            if (!listeners.has(evt)) listeners.set(evt, new Set());
            listeners.get(evt).add(fn);
            return () => listeners.get(evt).delete(fn);
        },
        /** Current epoch (each preview and full run increments it). */
        epoch() { return epoch; },
        /** The pool in use (an inline pool when none was given). */
        pool,
        /** Stops timers and listeners. */
        destroy() {
            destroyed = true;
            if (autoTimer) clearTimeout(autoTimer);
            if (previewTimer) clearTimeout(previewTimer);
            offResolved();
            for (const off of offPool) { try { off(); } catch (e) { /* ignore */ } }
        },
    };

    if (opts.autoStart !== false) {
        const st = store.get();
        if (st.resolved && !(st.solution && st.solution.geomKey === st.keys.geomKey)) scheduleAutoSolve();
    }
    return jobs;
}
