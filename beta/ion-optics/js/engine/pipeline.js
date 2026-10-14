/* ==========================================================================
   Ion optics engine: pipeline.js
   Synchronous pipeline for Node tests, benchmarks, benchmark jobs in workers
   and the main-thread fallback: resolve → geometry → raster → multigrid
   hierarchy → one 1 V basis field per non-ground electrode → superposition
   into time channels → field interpolant and 3D field model → particles →
   trace → summary (spec §2.3, §3.5).

   Superposition: φ(t) = Σ_k V_k(t) φ_k, exact for the discrete operator
   because Laplace's equation is linear (e.g. Jackson, Classical
   Electrodynamics, 3rd ed. (1999), §1.13); channels group the electrode
   waveforms (φ₀ = Σ dc_k φ_k, φ_c = Σ amp_{k,c} φ_k).

   A domain with a charge density (domain.charge, Poisson term) adds the
   particular solution φ_ρ (0 V on every electrode) as one more basis, keyed
   CHARGE_BASIS: weight 1 in the DC channel, 0 in every time channel.
   Runs with tracer.spaceCharge go to coulomb.js (direct pair forces, one
   lockstep batch: an onset estimator); everything else to trace.js.

   Every engine module is reached through one `engine` object, so tests and
   the worker core can inject stubs (makePipeline).
   ========================================================================== */
import * as schema from './schema.js';
import * as hash from './hash.js';
import * as geometry from './geometry.js';
import * as raster from './raster.js';
import * as operator from './operator.js';
import * as solve from './solve.js';
import * as field from './field.js';
import * as fieldmodel from './fieldmodel.js';
import * as waveform from './waveform.js';
import * as particles from './particles.js';
import * as trace from './trace.js';
import * as coulomb from './coulomb.js';
import * as gas from './gas.js';
import * as analysis from './analysis.js';
import { P_STRIDE } from './layout.js';
import { CHARGE_BASIS } from './operator.js';

const EngineError = schema.EngineError;

/** The real engine modules, as namespaces. */
export const ENGINE = Object.freeze({ schema, hash, geometry, raster, operator, solve, field, fieldmodel, waveform, particles, trace, coulomb, gas, analysis });

/** Pair-step fraction of the lockstep space-charge integrator per trajectory-accuracy preset (fraction of the smallest pair time scale). */
export const PAIR_STEP = Object.freeze({ draft: 0.05, normal: 0.02, fine: 0.005, custom: 0.02 });

const now = () => performance.now();

function isResolved(p) {
    return !!(p && typeof p === 'object' && typeof p.particleCount === 'number' && p.paramValues && p.domain && typeof p.domain.N === 'number');
}

/** Solver options from the resolved project, overridden by `opts`. */
export function solverOptions(resolved, opts = {}) {
    const s = (resolved && resolved.solver) || {};
    const o = { method: s.method || 'auto', tol: s.tol || 1e-10, maxCycles: s.maxCycles || 60, maxIterations: s.maxIterations || 200, maxSweeps: s.maxSweeps || 100000 };
    for (const k of ['method', 'tol', 'maxCycles', 'maxIterations', 'maxSweeps', 'timeLimitMs', 'initial']) if (opts[k] !== undefined) o[k] = opts[k];
    return o;
}

/**
 * Indices of the basis fields to solve: every non-ground electrode, plus CHARGE_BASIS (−1, the particular solution of
 * the Poisson term) when the domain has a charge density.
 */
export function basisElectrodes(resolved) {
    const out = [];
    const list = (resolved && resolved.electrodes) || [];
    for (let k = 1; k < list.length; k++) out.push(k);
    if (hasChargeDensity(resolved)) out.push(CHARGE_BASIS);
    return out;
}

/** True when the resolved domain carries a (non-blank) charge-density expression. */
export function hasChargeDensity(resolved) {
    const d = resolved && resolved.domain;
    return !!(d && typeof d.charge === 'string' && d.charge.trim());
}

/** The resolved space-charge settings of a run (tracer.spaceCharge), or null when the run uses the ordinary tracer. */
export function spaceChargeOf(resolved) {
    const sc = resolved && resolved.tracer && resolved.tracer.spaceCharge;
    return sc && typeof sc === 'object' && sc.enabled !== false ? sc : null;
}

/**
 * Options of coulomb.traceCoulomb for a space-charge run: the tracer options plus softening, factor and the pair step
 * (from the accuracy preset, or `spaceCharge.pairStep` when the project gives one).
 * The override `factorScale` lets a subset of the run carry the charge of the whole run: a number scales every particle
 * alike; an array scales by source index (resolved source `index`, the particles' P_SRC), so a subset that takes m_s of
 * the count_s particles of source s passes count_s/m_s for it (missing entries 1).
 * @param {object} resolved @param {object} traceOpts from trace.traceOptions
 */
export function coulombOptions(resolved, traceOpts) {
    const sc = spaceChargeOf(resolved) || {};
    const q = (resolved.tracer && resolved.tracer.quality) || 'normal';
    const pairStep = typeof sc.pairStep === 'number' && sc.pairStep > 0 && sc.pairStep <= 0.5 ? sc.pairStep : (PAIR_STEP[q] || PAIR_STEP.normal);
    const fs = traceOpts ? traceOpts.factorScale : null;
    const bySource = Array.isArray(fs) || ArrayBuffer.isView(fs)
        ? Array.from(fs, (v) => (typeof v === 'number' && v > 0 && Number.isFinite(v) ? v : 1)) : null;
    const scale = !bySource && fs > 0 && Number.isFinite(fs) ? fs : 1;
    return { ...traceOpts, softening: sc.softening > 0 ? sc.softening : coulomb.DEFAULT_SOFTENING, factor: (sc.factor >= 0 ? sc.factor : 1) * scale,
        factorBySource: bySource, pairStep };
}

/**
 * True if a compiled geometry fits the resolved project's electrodes. Geometry is cached by geomKey, but whether an
 * electrode is a mesh (transparent to particles) belongs to the fieldKey, so a cached geometry can be out of date.
 * @param {object} geometry @param {object} resolved
 * @returns {boolean}
 */
export function geometryMatches(geometry, resolved) {
    const els = (resolved && resolved.electrodes) || [];
    const tr = geometry && geometry.transparent;
    if (!tr || tr.length < els.length) return false;
    for (let k = 0; k < els.length; k++) if ((tr[k] ? 1 : 0) !== (els[k] && els[k].transparent ? 1 : 0)) return false;
    return true;
}

/**
 * Builds the pipeline functions over an engine object (namespaces as in ENGINE).
 * @param {object} engine
 */
export function makePipeline(engine = ENGINE) {
    const E = engine;

    function resolveOrThrow(project, opts = {}) {
        if (isResolved(project)) return project;
        const r = E.schema.resolve(project, opts);
        if (r.errors.length || !r.resolved) {
            const first = r.errors[0] || { path: '', message: 'The project could not be resolved.' };
            throw new EngineError('E_BAD_PROJECT', `${first.path ? first.path + ': ' : ''}${first.message}`, first.path, { errors: r.errors, warnings: r.warnings });
        }
        r.resolved.issues = { warnings: r.warnings };
        return r.resolved;
    }

    function prepare(resolved) {
        const geo = E.geometry.compileGeometry(resolved);
        const grid = E.raster.makeGrid(resolved.domain, 0);
        const boundary = (resolved.solver && resolved.solver.boundary) || 'subgrid';
        const raster0 = E.raster.rasterize(geo, grid, resolved, { boundary, snapTheta: 1e-3 });
        let warnings = [];
        if (E.geometry.geometryWarnings) {
            try { warnings = E.geometry.geometryWarnings(geo, resolved, raster0) || []; } catch (e) { warnings = []; }
        }
        warnings = warnings.map((w) => ({ ...w, path: E.schema.projectPath ? E.schema.projectPath(resolved, w.path) : w.path }));
        return { geometry: geo, hierarchy: null, raster0, warnings };
    }

    function solveProject(resolved, opts = {}, hooks = {}) {
        const t0 = now();
        const prep = opts.prepared || prepare(resolved);
        const ks = Array.isArray(opts.electrodes) ? opts.electrodes : basisElectrodes(resolved);
        const bases = new Map();
        const stats = [];
        if (ks.length === 0) return { geometry: prep.geometry, raster0: prep.raster0, bases, stats, warnings: prep.warnings, ms: now() - t0 };
        const boundary = (resolved.solver && resolved.solver.boundary) || 'subgrid';
        const H = opts.hierarchy || E.operator.buildHierarchy(prep.geometry, resolved, { boundary, raster0: prep.raster0 });
        const sopts = solverOptions(resolved, opts);
        const shouldStop = typeof hooks.shouldStop === 'function' ? hooks.shouldStop : null;
        const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : null;
        for (let q = 0; q < ks.length; q++) {
            const k = ks[q];
            if (shouldStop && shouldStop()) throw new EngineError('E_CANCELLED', 'The solve was stopped.');
            const sub = {
                progressEveryMs: hooks.progressEveryMs || 100,
                shouldStop: shouldStop || undefined,
                onProgress: onProgress ? (p) => onProgress({ ...p, phase: 'solve', k, index: q, count: ks.length, frac: (q + Math.max(0, Math.min(1, p.frac || 0))) / ks.length }) : undefined,
            };
            const r = E.solve.solveBasis(H, k, sopts, sub);
            if (shouldStop && shouldStop()) throw new EngineError('E_CANCELLED', 'The solve was stopped.');
            bases.set(k, r.phi);
            stats.push({ ...r.stats, k });
            if (typeof hooks.onBasis === 'function') hooks.onBasis(k, r.phi, r.stats);
        }
        return { geometry: prep.geometry, raster0: prep.raster0, bases, stats, warnings: prep.warnings, hierarchy: opts.keepHierarchy ? H : undefined, ms: now() - t0 };
    }

    /**
     * Channel potentials: [{ key, phi, cut, fn }], channel 0 = DC. `solved.channels` (combined potentials) may replace the bases.
     */
    function channelPotentials(resolved, solved, tf) {
        const N = solved.raster0.grid.N;
        const nE = resolved.electrodes.length;
        const out = [];
        const dcCut = Float64Array.from(tf.dc);
        if (Array.isArray(solved.channels) && solved.channels.length) {
            solved.channels.forEach((c, i) => {
                const cut = i === 0 ? dcCut : Float64Array.from(tf.channels[i - 1] ? tf.channels[i - 1].amp : new Float64Array(nE));
                out.push({ key: i === 0 ? 'dc' : (tf.channels[i - 1] ? tf.channels[i - 1].key : 'c' + i), phi: c.phi, cut, fn: i === 0 ? null : (tf.channels[i - 1] ? tf.channels[i - 1].fn : null) });
            });
            return out;
        }
        // the charge basis (k < 0) has weight 1 in the DC channel and 0 in every time channel; the cut values are unchanged
        // because φ_ρ is 0 on every electrode. Without it the weight arrays are used as before.
        const withCharge = solved.bases.has(CHARGE_BASIS);
        const wDc = withCharge ? (k) => (k < 0 ? 1 : tf.dc[k]) : tf.dc;
        out.push({ key: 'dc', phi: E.field.combine(solved.bases, wDc, N), cut: dcCut, fn: null });
        for (const ch of tf.channels) {
            const w = withCharge ? (k) => (k < 0 ? 0 : ch.amp[k]) : ch.amp;
            out.push({ key: ch.key, phi: E.field.combine(solved.bases, w, N), cut: Float64Array.from(ch.amp), fn: ch.fn });
        }
        return out;
    }

    function buildField(resolved, solved) {
        const tf = E.waveform.timeFunctions(resolved.electrodes);
        const hasBasis = (solved.bases && solved.bases.size > 0) || (Array.isArray(solved.channels) && solved.channels.length > 0);
        // mesh flags are not part of the geometry key: recompile a cached geometry whose flags are out of date
        const geometry = solved.geometry && geometryMatches(solved.geometry, resolved) ? solved.geometry : E.geometry.compileGeometry(resolved);
        let grid = null, channels = [];
        if (hasBasis) {
            channels = channelPotentials(resolved, solved, tf);
            grid = E.field.createFieldGrid(solved.raster0, geometry, { interp: (resolved.tracer && resolved.tracer.fieldInterp) || 'cubic' });
            grid.setChannels(channels.map((c) => c.phi), channels.map((c) => c.cut));
        }
        // with a charge density the DC channel carries φ_ρ too: its nodal range widens the model's potential span (energy
        // thresholds) and marks the field as electric (integrator choice). The same array serves bases and combined channels.
        let potentialRange = null;
        if (channels.length && hasChargeDensity(resolved)) {
            const phi = channels[0].phi;
            let lo = Infinity, hi = -Infinity;
            for (let k = 0; k < phi.length; k++) { const v = phi[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
            if (lo <= hi) potentialRange = [lo, hi];
        }
        const model = E.fieldmodel.createFieldModel({
            resolved, grid, raster0: solved.raster0, geometry,
            channelFns: channels.length ? channels.map((c) => c.fn) : null, potentialRange,
        });
        return { grid, model, channels, dc: tf.dc, timeChannels: tf.channels, geometry };
    }

    /**
     * Display potential φ(t) = φ₀ + Σ f_c(t) φ_c of a built field (Float64Array over the level-0 nodes; null if no solve).
     */
    function displayPotential(fieldObj, t = 0, out = null) {
        if (!fieldObj || !fieldObj.channels || !fieldObj.channels.length) return null;
        const ch = fieldObj.channels;
        const N = ch[0].phi.length;
        const res = out && out.length === N ? out : new Float64Array(N);
        res.set(ch[0].phi);
        for (let c = 1; c < ch.length; c++) {
            const w = ch[c].fn ? ch[c].fn.value(t) : 1;
            if (w === 0) continue;
            const p = ch[c].phi;
            for (let q = 0; q < N; q++) res[q] += w * p[q];
        }
        return res;
    }

    function traceProject(resolved, fieldObj, { i0 = 0, i1 = resolved.particleCount, particles: parts = null, overrides = {}, total = null } = {}, hooks = {}) {
        const relativistic = !resolved.tracer || resolved.tracer.relativistic !== false;
        const domainType = resolved.domain && resolved.domain.type;
        const rows = parts || E.particles.generate(resolved.sources, i0, i1, { domainType, relativistic });
        const n = Math.floor(rows.length / P_STRIDE);
        // per-particle trajectory cap from the run's total, so chunking never changes the stored points
        const nTotal = total || (parts ? n : resolved.particleCount) || 1;
        const budget = (resolved.limits && resolved.limits.pointBudget) || 2e6;
        const trj = (resolved.recording && resolved.recording.trajectories) || {};
        const cap = Math.max(2, Math.min(trj.maxPoints || 2000, Math.floor(budget / Math.max(1, nTotal))));
        const ov = { ...(overrides || {}) };
        // crossing rows ('all' planes, meshes) per particle from the run's total too: a global budget of 2e6 rows
        const crossCap = typeof E.trace.crossCapFor === 'function' ? E.trace.crossCapFor(nTotal) : 1000;
        const opts = E.trace.traceOptions(resolved, { ...ov, record: { maxPoints: cap, pointBudget: 1e15, crossCap, ...(ov.record || {}) } });
        if (!parts) opts.i0 = i0;
        // space charge: every particle of the batch in one lockstep pass through coulomb.js (an onset estimator); an override
        // spaceCharge: false traces without the pair forces (analysis rays that measure the field: lens tool, image finder)
        if (spaceChargeOf(resolved) && ov.spaceCharge !== false) {
            const C = E.coulomb || coulomb;
            return C.traceCoulomb(fieldObj.model, rows, coulombOptions(resolved, opts), hooks);
        }
        return E.trace.traceParticles(fieldObj.model, rows, opts, hooks);
    }

    function runProject(project, opts = {}) {
        const t0 = now();
        const resolved = resolveOrThrow(project, opts);
        const t1 = now();
        const solved = solveProject(resolved, opts.solver || {}, opts.hooks || {});
        const t2 = now();
        const fieldObj = buildField(resolved, solved);
        const t3 = now();
        const result = traceProject(resolved, fieldObj, { overrides: opts.overrides || {} }, opts.hooks || {});
        const t4 = now();
        const summary = E.analysis.summarize(result, resolved);
        const t5 = now();
        return { resolved, solved, field: fieldObj, result, summary,
            timings: { resolveMs: t1 - t0, solveMs: t2 - t1, fieldMs: t3 - t2, traceMs: t4 - t3, summaryMs: t5 - t4, totalMs: t5 - t0 } };
    }

    return { resolveOrThrow, prepare, solveProject, buildField, displayPotential, traceProject, runProject };
}

const P = makePipeline(ENGINE);

/**
 * Resolves a project or throws EngineError E_BAD_PROJECT (detail.errors lists every issue). A resolved project passes through.
 * @param {object} project @param {{ mobile?: boolean }} [opts]
 * @returns {object} resolved
 */
export function resolveOrThrow(project, opts = {}) { return P.resolveOrThrow(project, opts); }

/**
 * Geometry and level-0 raster of a resolved project, with geometry warnings (project paths).
 * @param {object} resolved
 * @returns {{ geometry: object, hierarchy: null, raster0: object, warnings: object[] }}
 */
export function prepare(resolved) { return P.prepare(resolved); }

/**
 * Solves one basis field per non-ground electrode (or `opts.electrodes`).
 * opts: solver overrides (method, tol, maxCycles, maxIterations, maxSweeps, timeLimitMs), electrodes, prepared, hierarchy.
 * hooks: onProgress({ phase, k, frac, cycle, estErr, scaledResidual, … }), onBasis(k, phi, stats), shouldStop(), progressEveryMs.
 * @returns {{ geometry: object, raster0: object, bases: Map<number, Float64Array>, stats: object[], warnings: object[] }}
 */
export function solveProject(resolved, opts = {}, hooks = {}) { return P.solveProject(resolved, opts, hooks); }

/**
 * Field interpolant and 3D field model from solved bases (or `solved.channels`, combined channel potentials).
 * `geometry` is the compiled geometry used (solved.geometry, or a recompiled one when mesh flags changed).
 * @returns {{ grid: object|null, model: object, channels: Array<{ key: string, phi: Float64Array, cut: Float64Array, fn: object|null }>,
 *   dc: Float64Array, timeChannels: object[], geometry: object }}
 */
export function buildField(resolved, solved) { return P.buildField(resolved, solved); }

/** Potential at display time t on the level-0 nodes (null when nothing was solved). */
export function displayPotential(fieldObj, t = 0, out = null) { return P.displayPotential(fieldObj, t, out); }

/**
 * Traces particles i0 ≤ id < i1 (generated from the sources) or the given particle rows.
 * @param {object} resolved @param {object} fieldObj from buildField
 * @param {{ i0?: number, i1?: number, particles?: Float64Array|null, overrides?: object, total?: number }} [range]
 * @param {object} [hooks] onProgress({ done, total }), shouldStop(), progressEveryMs
 * @returns {object} TraceResult
 */
export function traceProject(resolved, fieldObj, range = {}, hooks = {}) { return P.traceProject(resolved, fieldObj, range, hooks); }

/**
 * Resolve, solve, build the field, trace every particle and summarise.
 * @param {object} project @param {{ mobile?: boolean, solver?: object, overrides?: object, hooks?: object }} [opts]
 * @returns {{ resolved: object, solved: object, field: object, result: object, summary: object, timings: object }}
 */
export function runProject(project, opts = {}) { return P.runProject(project, opts); }
