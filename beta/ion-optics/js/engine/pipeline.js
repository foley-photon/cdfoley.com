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
import * as analysis from './analysis.js';
import { P_STRIDE } from './layout.js';

const EngineError = schema.EngineError;

/** The real engine modules, as namespaces. */
export const ENGINE = Object.freeze({ schema, hash, geometry, raster, operator, solve, field, fieldmodel, waveform, particles, trace, analysis });

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

/** Indices of the electrodes that get a basis field (every non-ground electrode). */
export function basisElectrodes(resolved) {
    const out = [];
    const list = (resolved && resolved.electrodes) || [];
    for (let k = 1; k < list.length; k++) out.push(k);
    return out;
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
        out.push({ key: 'dc', phi: E.field.combine(solved.bases, tf.dc, N), cut: dcCut, fn: null });
        for (const ch of tf.channels) out.push({ key: ch.key, phi: E.field.combine(solved.bases, ch.amp, N), cut: Float64Array.from(ch.amp), fn: ch.fn });
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
        const model = E.fieldmodel.createFieldModel({
            resolved, grid, raster0: solved.raster0, geometry,
            channelFns: channels.length ? channels.map((c) => c.fn) : null,
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
