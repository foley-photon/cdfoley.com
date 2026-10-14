/* ==========================================================================
   Ion optics UI: analysis-jobs.js
   Main-thread orchestration of the analysis tools (spec §3.11, §4.7):
   lens properties and the image finder (rays traced by the worker pool
   through jobs.traceBatch), 1D scans and Nelder–Mead tuning (temporary
   projects through jobs.withTemporaryProject, which re-solve only when the
   geometry changes), the accuracy check (h/2 re-solve, rtol/100 re-run of the
   first ≤ 200 particles; with space charge the first particles of every
   source, each source's charge kept, and the lockstep steps shortened to
   1/√10 instead of rtol/100; the observed order p from three resolutions and the
   Richardson estimates of the remaining grid error, Δ·2^p/(2^p − 1) for the
   current grid and Δ/(2^p − 1) for the finer one; Richardson, Phil. Trans.
   R. Soc. A 210, 307 (1911)),
   field profiles along a line, run overviews for the Summary tab, the
   Methods text and the pinned runs of the Compare tab (pin records, their
   metrics, the side-by-side table and CSV, and the local-storage pin store).
   Pure functions take plain data so Node tests can call them.
   ========================================================================== */
import { lensProperties, imageOf } from '../engine/lensprops.js';
import { scan1D, nelderMead, evaluateMetric, planeIndex, planeSample, rmsRadius, waistOf, METRICS } from '../engine/optimize.js';
import { summarize, peakStats, histogram, tofCalibration, beamWaist } from '../engine/analysis.js';
import { S_STRIDE, S_ID, S_STATUS, S_X, S_Y, S_Z, S_SPECIES, S_SRC, STATUS, STATUS_NAMES, P_STRIDE } from '../engine/layout.js';
import { ENGINE_VERSION, PRODUCT_NAME } from '../engine/version.js';
import { runKey as runKeyOf } from '../engine/hash.js';
import { sourceWeights, generate } from '../engine/particles.js';
import { PAIR_STEP } from '../engine/pipeline.js';
import { csvText, fmtNum } from './plots.js';

export const BENCH_STORAGE_KEY = 'ionopt.bench.v1';

const clone = (v) => JSON.parse(JSON.stringify(v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------- run overview (Summary tab)
/**
 * Overview of a run for the Summary cards.
 * @param {object} result TraceResult (store run.result) @param {object} resolved
 * @returns {object} { summary, planes: [{ id, name, detected, fraction, crossings, spotRms, meanTof, waist }], solver, warnings }
 */
export function runOverview(result, resolved, { solveStats = null } = {}) {
    const sum = summarize(result, resolved);
    const planes = ((resolved && resolved.recording && resolved.recording.planes) || []).map((p, k) => {
        const smp = planeSample(result, resolved, k);
        const w = smp.u.length >= 2 ? waistOf(smp) : null;
        const atPlane = p.kind === 'x' || p.kind === 'y' || p.kind === 'z';
        const det = sum.byPlane[k] ? sum.byPlane[k].detected : 0;
        return {
            index: k, id: p.id, name: p.name || p.id, terminate: !!p.terminate, kind: p.kind,
            detected: det, fraction: sum.launched ? det / sum.launched : 0, crossings: smp.u.length,
            spotRms: smp.u.length ? rmsRadius(smp.u, smp.w) : NaN,
            meanTof: smp.tof.length ? smp.tof.reduce((s, v) => s + v, 0) / smp.tof.length : NaN,
            waist: w && isNum(w.offset) ? { position: atPlane ? (p.at || 0) + w.offset : w.offset, rms: w.rms } : null,
        };
    });
    return { summary: sum, planes, solver: solveStats || null };
}

/** Index of the plane whose waist the project asks for (analysis.waist.plane) or the first plane with crossings. */
export function waistPlane(resolved, overview) {
    const id = resolved && resolved.analysis && resolved.analysis.waist && resolved.analysis.waist.plane;
    if (id) { const k = planeIndex(resolved, id); if (k >= 0) return k; }
    const p = overview.planes.find((q) => q.crossings >= 2 && q.waist);
    return p ? p.index : -1;
}

// ---------------------------------------------------------------- planes and TOF
/**
 * Statistics of one plane: spot (centroid, rms), emittance and Twiss in both transverse coordinates, KE and time.
 */
export function planeStats(result, resolved, k, metric = null) {
    const smp = planeSample(result, resolved, k, metric);
    const n = smp.u.length;
    const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
    const sd = (a) => { const m = mean(a); return a.length ? Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length) : NaN; };
    const emitU = twiss(smp.u, smp.up), emitW = twiss(smp.w, smp.wp);
    return {
        n, frame: smp.frame, sample: smp,
        centroid: [mean(smp.u), mean(smp.w)], rms: [sd(smp.u), sd(smp.w)], rmsRadius: n ? rmsRadius(smp.u, smp.w) : NaN,
        emittance: { u: emitU, w: emitW }, ke: { mean: mean(smp.ke), sd: sd(smp.ke) }, tof: { mean: mean(smp.tof), sd: sd(smp.tof) },
        waist: n >= 2 ? waistOf(smp) : null,
    };
}

/** rms emittance and Twiss parameters of (u, u′) with u′ in mrad (§3.11(7)). */
export function twiss(u, up) {
    const pts = [];
    for (let i = 0; i < u.length; i++) if (isNum(u[i]) && isNum(up[i])) pts.push([u[i], 1000 * up[i]]);
    const n = pts.length;
    if (n < 2) return { n, epsRms: NaN, alpha: NaN, beta: NaN, gamma: NaN };
    let mu = 0, mp = 0;
    for (const [a, b] of pts) { mu += a; mp += b; }
    mu /= n; mp /= n;
    let uu = 0, pp = 0, upc = 0;
    for (const [a, b] of pts) { uu += (a - mu) ** 2; pp += (b - mp) ** 2; upc += (a - mu) * (b - mp); }
    uu /= n; pp /= n; upc /= n;
    const eps = Math.sqrt(Math.max(0, uu * pp - upc * upc));
    return { n, epsRms: eps, alpha: eps > 0 ? -upc / eps : NaN, beta: eps > 0 ? uu / eps : NaN, gamma: eps > 0 ? pp / eps : NaN, sxx: uu, spp: pp, sxp: upc, mu, mp };
}

/**
 * 68% bootstrap range [16th, 84th percentile] of the rms-based resolving power t̄/(2·2.3548σ) of a set of times
 * (deterministic resampling, `reps` resamples; [NaN, NaN] below 10 values).
 */
export function bootstrapRmsR(t, reps = 200) {
    const n = t.length;
    if (n < 10) return [NaN, NaN];
    let seed = 0x9e3779b9 ^ n;
    const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
    const rs = [];
    for (let r = 0; r < reps; r++) {
        let s = 0, q = 0;
        for (let i = 0; i < n; i++) { const x = t[Math.floor(rnd() * n)]; s += x; q += x * x; }
        const m = s / n, sd = Math.sqrt(Math.max(0, q / n - m * m));
        if (sd > 0) rs.push(m / (2 * 2 * Math.sqrt(2 * Math.LN2) * sd));
    }
    if (rs.length < 10) return [NaN, NaN];
    rs.sort((a, b) => a - b);
    return [rs[Math.floor(0.16 * (rs.length - 1))], rs[Math.ceil(0.84 * (rs.length - 1))]];
}

/**
 * Statistical weights (the sources' `weight`, Particles tab) of the particles with the given ids, for weighted histograms;
 * null when every weight is 1, so unweighted runs keep plain counts.
 * @param {object} result TraceResult @param {object} resolved @param {ArrayLike<number>} ids particle ids (e.g. planeSample().ids)
 * @returns {Float64Array|null}
 */
export function sampleWeights(result, resolved, ids) {
    const sw = sourceWeights(resolved && resolved.sources);
    if (!sw.some((w) => w !== 1) || !result || !result.summary) return null;
    const S = result.summary, row = new Map();
    for (let i = 0; i < result.n; i++) row.set(S[i * S_STRIDE + S_ID], i * S_STRIDE);
    const out = new Float64Array(ids.length);
    for (let i = 0; i < ids.length; i++) {
        const o = row.get(ids[i]), k = o === undefined ? -1 : S[o + S_SRC];
        out[i] = k >= 0 && k < sw.length ? sw[k] : 1;
    }
    return out;
}

/**
 * TOF peaks per species at a plane: histogram data, peak statistics (mean, σ, FWHM, R from the FWHM, from the rms width and
 * from the narrowest 76.1% of the times; the bootstrap range of the rms-based R) and the calibration t = a√(m/q) + b.
 * With source weights other than 1 the histograms count Σw per bin (`weighted: true`); the peak statistics stay unweighted.
 */
export function tofPeaks(result, resolved, k) {
    const smp = planeSample(result, resolved, k);
    const S = result.summary, sidx = new Map();
    for (let i = 0; i < result.n; i++) sidx.set(S[i * S_STRIDE + S_ID], i * S_STRIDE);
    const groups = new Map();
    const sources = (resolved && resolved.sources) || [];
    const wts = sampleWeights(result, resolved, smp.ids);
    for (let i = 0; i < smp.ids.length; i++) {
        const o = sidx.get(smp.ids[i]);
        const src = sources[S[o + S_SRC]], sp = src && src.species ? src.species[S[o + S_SPECIES]] : null;
        const key = sp ? `${sp.label}` : `species ${S[o + S_SPECIES]}`;
        let g = groups.get(key);
        if (!g) { g = { label: key, mass: sp ? sp.mass : NaN, charge: sp ? sp.charge : NaN, t: [], w: [] }; groups.set(key, g); }
        g.t.push(smp.tof[i]);
        g.w.push(wts ? wts[i] : 1);
    }
    const peaks = [...groups.values()].map(({ w, ...g }) => ({ ...g, ...(wts ? { w } : {}), stats: peakStats(g.t), rRange: bootstrapRmsR(g.t) }));
    const all = smp.tof;
    let lo = Infinity, hi = -Infinity;
    for (const t of all) { if (t < lo) lo = t; if (t > hi) hi = t; }
    const hist = all.length ? peaks.map((p) => ({ label: p.label, ...histogram(p.t, { bins: Math.max(10, Math.min(200, Math.round(Math.sqrt(all.length) * 2))), min: lo, max: hi, weights: wts ? p.w : undefined }) })) : [];
    const pairs = peaks.filter((p) => isNum(p.mass) && isNum(p.charge) && p.charge !== 0 && p.stats.n > 0).map((p) => ({ mq: p.mass / Math.abs(p.charge), t: p.stats.mean }));
    const cal = pairs.length >= 2 ? tofCalibration(pairs) : null;
    return { peaks, hist, calibration: cal, n: all.length, weighted: !!wts };
}

// ---------------------------------------------------------------- lens tool and image finder
/** Ray tracer for the lens tools: the worker pool through jobs.traceBatch (rows with overrides). */
export function poolTraceFn(ctx) {
    return (particles, opts) => ctx.jobs.traceBatch({ particles, overrides: opts });
}

/** Message for the lens tools when jobs.ensureField() could not build a field (it resolves null instead of rejecting). */
function noFieldMessage(ctx) {
    const st = ctx.store.get();
    const err = st.solve && st.solve.status === 'error' && st.solve.error && st.solve.error.message;
    if (err) return `The fields could not be solved: ${err}`;
    if (st.valid === false) return 'The project has errors; fix the fields marked in red first.';
    return 'There is no field to trace through yet. Solve the fields first.';
}

/** Cells across the smallest aperture radius warning helper: radius in mm and the grid cell. */
export function cellsPerRadius(radiusMm, h) { return h > 0 ? radiusMm / h : NaN; }

/**
 * Lens properties of the current project (DiChio protocol) with the main-thread field model and pool tracing.
 * spec as lensprops.lensProperties; relativistic defaults to the project's tracer setting.
 */
export async function lensJob(ctx, spec) {
    const fld = await ctx.jobs.ensureField();
    if (!fld || !fld.model) throw new Error(noFieldMessage(ctx));
    const st = ctx.store.get();
    const rel = spec.relativistic !== undefined ? spec.relativistic : !(st.resolved && st.resolved.tracer && st.resolved.tracer.relativistic === false);
    const out = await lensProperties({ ...spec, relativistic: rel }, fld.model, poolTraceFn(ctx));
    const h = st.resolved && st.resolved.domain ? st.resolved.domain.h : NaN;
    const cpr = cellsPerRadius(spec.D / 2, h);
    if (isNum(cpr) && cpr < 20) out.warnings.push({ code: 'W_APERTURE_RES', message: `Only ${cpr.toFixed(1)} cells across the reference radius D/2; lens results may be off by more than 1e-3. Thin-walled lenses need ≥ 20 cells for about 1e-3 (40 for 2e-4, 80 for 1e-4); sharp electrode corners converge more slowly.` });
    return out;
}

/** Image finder on the current project. */
export async function imageJob(ctx, spec) {
    const fld = await ctx.jobs.ensureField();
    if (!fld || !fld.model) throw new Error(noFieldMessage(ctx));
    const st = ctx.store.get();
    const rel = spec.relativistic !== undefined ? spec.relativistic : !(st.resolved && st.resolved.tracer && st.resolved.tracer.relativistic === false);
    return imageOf({ ...spec, relativistic: rel }, poolTraceFn(ctx));
}

// ---------------------------------------------------------------- scan variables
/** Current value of a scan variable { kind: 'param'|'electrode'|'sourceEnergy', id }. */
export function variableValue(project, resolved, variable) {
    if (!variable) return NaN;
    if (variable.kind === 'param') {
        if (resolved && resolved.paramValues && isNum(resolved.paramValues[variable.id])) return resolved.paramValues[variable.id];
        const p = (project.params || []).find((q) => q.name === variable.id);
        return p && isNum(p.value) ? p.value : NaN;
    }
    if (variable.kind === 'electrode') {
        const e = resolved && resolved.electrodes ? resolved.electrodes.find((q) => q.id === variable.id) : null;
        if (e && isNum(e.dc)) return e.dc;
        const pe = (project.electrodes || []).find((q) => q.id === variable.id);
        return pe && isNum(pe.v) ? pe.v : NaN;
    }
    if (variable.kind === 'sourceEnergy') {
        const s = ((resolved && resolved.sources) || project.sources || []).find((q) => q.id === variable.id);
        return s ? energyMean(s.energy) : NaN;
    }
    return NaN;
}
function energyMean(en) {
    if (!en) return NaN;
    if (en.type === 'mono') return en.ke;
    if (en.type === 'uniform') return 0.5 * (en.min + en.max);
    if (en.type === 'gaussian') return en.mean;
    if (en.type === 'list' && Array.isArray(en.values) && en.values.length) return en.values.reduce((s, v) => s + v, 0) / en.values.length;
    return NaN;
}
/**
 * A copy of the project with the variable set to value. Electrode voltages and parameters are written as numbers;
 * a source energy distribution is shifted so that its mean equals value.
 */
export function applyVariable(project, variable, value) {
    const p = clone(project);
    if (variable.kind === 'param') {
        const q = (p.params || []).find((x) => x.name === variable.id);
        if (!q) throw new Error(`Unknown parameter "${variable.id}".`);
        q.value = value;
    } else if (variable.kind === 'electrode') {
        const e = (p.electrodes || []).find((x) => x.id === variable.id);
        if (!e || e.ground) throw new Error(`Unknown electrode "${variable.id}".`);
        e.v = value;
    } else if (variable.kind === 'sourceEnergy') {
        const s = (p.sources || []).find((x) => x.id === variable.id);
        if (!s) throw new Error(`Unknown source "${variable.id}".`);
        const en = s.energy || { type: 'mono', ke: value };
        const m = energyMean(en);
        const d = isNum(m) ? value - m : 0;
        if (en.type === 'mono') en.ke = value;
        else if (en.type === 'uniform') { en.min += d; en.max += d; }
        else if (en.type === 'gaussian') en.mean = value;
        else if (en.type === 'list') en.values = en.values.map((v) => v + d);
        s.energy = en;
    }
    return p;
}

/** Runs a temporary copy of the project (no store changes) and evaluates a metric on it. */
export async function evaluateProject(ctx, project, metric) {
    return ctx.jobs.withTemporaryProject(project, async (tmp) => {
        const r = await tmp.run();
        return { value: evaluateMetric(metric, r, tmp.resolved), result: r, resolved: tmp.resolved, estimate: tmp.estimate ? tmp.estimate() : null };
    });
}

/** Does a variable change the geometry (and so need a solve per point)? */
export function variableMovesGeometry(ctx, project, variable, value) {
    try {
        const a = ctx.engine.schema.resolve(project), b = ctx.engine.schema.resolve(applyVariable(project, variable, value));
        if (!a.resolved || !b.resolved) return true;
        return ctx.engine.hash.geomKey(a.resolved) !== ctx.engine.hash.geomKey(b.resolved);
    } catch (e) { return true; }
}

/**
 * 1D scan of a variable against a metric. onPoint(index, value, metric) after each point.
 * @returns {Promise<{ values, metrics, best }>}
 */
export async function scanJob(ctx, { variable, values, metric, goal = null }, onPoint = null, shouldStop = null) {
    const base = clone(ctx.store.get().project);
    const g = goal || (METRICS[metric.type] ? METRICS[metric.type].goal : 'min');
    return scan1D(async (v) => (await evaluateProject(ctx, applyVariable(base, variable, v), metric)).value, values, onPoint, { goal: g, shouldStop });
}

/**
 * Nelder–Mead tuning of ≤ 4 bounded variables [{ kind, id, lower, upper, step }] against a metric (goal min|max).
 * @returns {Promise<{ x, fx, nEval, history, value }>} value = the metric at x (fx is negated for goal max)
 */
export async function optimizeJob(ctx, { variables, metric, goal = 'min', maxEval = 60 }, onIter = null, shouldStop = null) {
    const base = clone(ctx.store.get().project), st = ctx.store.get();
    const x0 = variables.map((v) => { const c = variableValue(base, st.resolved, v); return isNum(c) ? Math.min(v.upper, Math.max(v.lower, c)) : 0.5 * (v.lower + v.upper); });
    const sign = goal === 'max' ? -1 : 1;
    const f = async (x) => {
        let p = base;
        variables.forEach((v, i) => { p = applyVariable(p, v, x[i]); });
        const r = await evaluateProject(ctx, p, metric);
        return isNum(r.value) ? sign * r.value : Infinity;
    };
    const step = variables.map((v) => (v.step > 0 ? v.step : 0.1 * (v.upper - v.lower)));
    const r = await nelderMead(f, x0, { step, lower: variables.map((v) => v.lower), upper: variables.map((v) => v.upper), maxEval, ftol: 0, xtol: 0, shouldStop }, onIter);
    return { ...r, value: sign * r.fx };
}

// ---------------------------------------------------------------- accuracy check (§3.11(2))
/** The standard metric set of a run: per plane transmission, spot rms, mean TOF, mean KE, waist position. */
export function metricSet(result, resolved) {
    const out = [];
    const planes = (resolved && resolved.recording && resolved.recording.planes) || [];
    planes.forEach((p) => {
        const lab = p.name || p.id;
        if (p.terminate) out.push({ key: `${p.id}:transmission`, label: `${lab}: transmission`, unit: '', value: evaluateMetric({ type: 'transmission', plane: p.id }, result, resolved) });
        out.push({ key: `${p.id}:spotRms`, label: `${lab}: spot rms`, unit: 'mm', value: evaluateMetric({ type: 'spotRms', plane: p.id }, result, resolved) });
        out.push({ key: `${p.id}:meanTof`, label: `${lab}: mean TOF`, unit: 'µs', value: evaluateMetric({ type: 'meanTof', plane: p.id }, result, resolved) });
        out.push({ key: `${p.id}:meanKE`, label: `${lab}: mean KE`, unit: 'eV', value: evaluateMetric({ type: 'meanKE', plane: p.id }, result, resolved) });
        if (p.kind === 'x' || p.kind === 'y' || p.kind === 'z') out.push({ key: `${p.id}:waistPos`, label: `${lab}: waist position`, unit: 'mm', value: evaluateMetric({ type: 'waistPos', plane: p.id }, result, resolved) });
    });
    // end points of the first particles (position spread is the most sensitive trajectory metric)
    const S = result.summary;
    let sx = 0, n = 0;
    for (let i = 0; i < result.n; i++) { const o = i * S_STRIDE; if (S[o + S_STATUS] !== STATUS.CANCELLED) { sx += S[o + S_X]; n++; } }
    out.push({ key: 'end:x', label: 'Mean end x', unit: 'mm', value: n ? sx / n : NaN });
    return out.filter((m) => isNum(m.value));
}
/** Largest end-point distance between two runs of the same particles (matched by id). */
export function endPointShift(a, b) {
    const map = new Map();
    for (let i = 0; i < b.n; i++) map.set(b.summary[i * S_STRIDE + S_ID], i * S_STRIDE);
    let d = 0;
    for (let i = 0; i < a.n; i++) {
        const o = i * S_STRIDE, q = map.get(a.summary[o + S_ID]);
        if (q === undefined || a.summary[o + S_STATUS] !== b.summary[q + S_STATUS]) continue;
        d = Math.max(d, Math.hypot(a.summary[o + S_X] - b.summary[q + S_X], a.summary[o + S_Y] - b.summary[q + S_Y], a.summary[o + S_Z] - b.summary[q + S_Z]));
    }
    return d;
}
/**
 * Combines metric sets: differences, the observed order (three resolutions) and Richardson estimates of the remaining grid error.
 * The order used, p, is the observed one clamped to [1, 2], or 1 (the cautious choice) when it cannot be measured; errCurrent
 * = Δ·2^p/(2^p − 1) estimates the error of the current value and errFine = Δ/(2^p − 1) that of the finer-grid value
 * (signed: add it to the value). With fineIsCoarser (the comparison grid has twice the cell) Δ/(2^p − 1) is the error of the
 * current value and there is no finer one.
 */
export function accuracyTable(base, fine, tight, coarse = null, { fineIsCoarser = false } = {}) {
    const byKey = (set) => new Map(set.map((m) => [m.key, m]));
    const F = byKey(fine), Tt = byKey(tight), C = coarse ? byKey(coarse) : null;
    return base.map((m) => {
        const f = F.get(m.key), t = Tt.get(m.key), c = C ? C.get(m.key) : null;
        const dGrid = f ? f.value - m.value : NaN, dTol = t ? t.value - m.value : NaN;
        let order = NaN;
        if (c && f) { const e1 = Math.abs(c.value - m.value), e2 = Math.abs(m.value - f.value); if (e1 > 0 && e2 > 0) order = Math.log2(e1 / e2); }
        const p = isNum(order) ? Math.min(2, Math.max(1, order)) : 1, k = Math.pow(2, p) - 1;
        // fineIsCoarser: dGrid = value(2h) − value(h), so the error of the current value is −dGrid/(2^p − 1)
        const errCurrent = fineIsCoarser ? -dGrid / k : dGrid * (k + 1) / k;
        const errFine = fineIsCoarser ? NaN : dGrid / k;
        return { key: m.key, label: m.label, unit: m.unit, value: m.value, fine: f ? f.value : NaN, coarse: c ? c.value : NaN, dGrid, order, p, errCurrent, errFine, richardson: errCurrent, dTol };
    });
}
/**
 * The particles a space-charge accuracy check traces: the first particles of every source (at most `max` in all, split
 * evenly) and the per-source charge scale count/taken, so that the subset carries the charge of the whole run
 * (pipeline.coulombOptions, override factorScale by source index).
 * @param {object} resolved @param {number} [max]
 * @returns {{ particles: Float64Array, scale: number[], n: number }}
 */
export function spaceChargeSubset(resolved, max = 200) {
    const src = (resolved && resolved.sources) || [];
    const used = src.filter((s) => s.count > 0).length;
    const per = Math.max(1, Math.floor(max / Math.max(1, used)));
    const scale = src.map(() => 1), chunks = [];
    let n = 0;
    src.forEach((s, k) => {
        const m = Math.min(per, s.count);
        if (!(m > 0)) return;
        chunks.push(generate(src, s.firstId, s.firstId + m, { domainType: resolved.domain.type, relativistic: !resolved.tracer || resolved.tracer.relativistic !== false }));
        scale[typeof s.index === 'number' ? s.index : k] = s.count / m;
        n += m;
    });
    const particles = new Float64Array(n * P_STRIDE);
    let o = 0;
    for (const c of chunks) { particles.set(c, o); o += c.length; }
    return { particles, scale, n };
}

/**
 * Accuracy check of the current project: the first ≤ maxParticles particles are re-run on a grid with half the cell
 * (twice the cell when the memory estimate forbids it, noted), at rtol/100 on the same grid, and on a 2h grid
 * (when it divides the domain) for the observed order. onStep(text) reports progress.
 * Space charge: the lockstep integrator has no rtol, so the comparison run shortens its steps (cell caps and pair step)
 * to 1/√10, which cuts the time-step error of the fourth-order method about a hundredfold; the traced particles are the
 * first of every source, each source keeping its whole charge (spaceChargeSubset). `tightening` says which was used.
 */
export async function accuracyCheck(ctx, { maxParticles = 200, onStep = null } = {}) {
    const st = ctx.store.get();
    if (!st.resolved) throw new Error('The project has errors; fix them before the accuracy check.');
    const project = clone(st.project), r0 = st.resolved;
    const sc = !!(r0.tracer && r0.tracer.spaceCharge);
    const subset = sc ? spaceChargeSubset(r0, maxParticles) : null;
    const n = subset ? subset.n : Math.min(maxParticles, r0.particleCount);
    if (!(n > 0)) throw new Error('The project has no particles.');
    const h = r0.domain.h;
    const withCell = (cell) => { const p = clone(project); p.domain.cell = cell; return p; };
    const rtol = r0.tracer && r0.tracer.q ? r0.tracer.q.rtol : 1e-8;
    const withRtol = () => {
        const p = clone(project);
        const q = r0.tracer.q || {};
        p.tracer = { ...(p.tracer || {}), quality: 'custom', custom: { rtol: rtol / 100, maxStepCells: q.maxStepCells || 0.5, nearStepCells: q.nearStepCells || 0.1, rfStepsPerPeriod: q.rfStepsPerPeriod || 32, borisStepsPerGyration: q.borisStepsPerGyration || 128 } };
        return p;
    };
    const SHORT = 1 / Math.sqrt(10);
    const withShortSteps = () => {
        const p = clone(project);
        const q = r0.tracer.q || {}, s = r0.tracer.spaceCharge || {};
        const pair = (s.pairStep > 0 ? s.pairStep : (PAIR_STEP[r0.tracer.quality] || PAIR_STEP.normal)) * SHORT;
        p.tracer = { ...(p.tracer || {}), quality: 'custom', custom: { rtol, maxStepCells: (q.maxStepCells || 0.5) * SHORT, nearStepCells: (q.nearStepCells || 0.1) * SHORT,
            rfStepsPerPeriod: q.rfStepsPerPeriod || 32, borisStepsPerGyration: q.borisStepsPerGyration || 128 } };
        p.tracer.spaceCharge = { ...(p.tracer.spaceCharge || {}), pairStep: pair };
        return p;
    };
    const runFirst = (p, label) => ctx.jobs.withTemporaryProject(p, async (tmp) => {
        if (onStep) onStep(label);
        const est = tmp.estimate ? tmp.estimate() : null;
        if (est && est.blocked) { const e = new Error(est.blockMessage || 'Too large'); e.code = 'E_MEMORY'; throw e; }
        const res = subset ? await tmp.traceBatch({ particles: subset.particles, overrides: { factorScale: subset.scale } }) : await tmp.traceBatch({ range: [0, n] });
        return { result: res, resolved: tmp.resolved, nodes: tmp.resolved.domain.N };
    });
    const notes = [];
    if (sc) notes.push(`Space charge: the check traces the first ${n} particles of the sources with each source's charge factor scaled to carry its whole charge, and the comparison run shortens the lockstep steps (cell and pair-time caps) to 1/√10, about a hundredth of the time-step error of the fourth-order method, in place of rtol/100.`);
    const base = await runFirst(project, 'Re-running the first particles on the current grid');
    let fine, fineCell = h / 2;
    try { fine = await runFirst(withCell(h / 2), `Solving on a grid with half the cell (${h / 2} mm)`); }
    catch (e) {
        if (!(e && e.code === 'E_MEMORY')) throw e;
        fineCell = 2 * h;
        notes.push('The half-cell grid exceeds the memory limit; the comparison uses twice the cell instead.');
        fine = await runFirst(withCell(2 * h), `Solving on a grid with twice the cell (${2 * h} mm)`);
    }
    const tight = sc ? await runFirst(withShortSteps(), 'Re-running with the lockstep steps shortened to 1/√10')
        : await runFirst(withRtol(), `Re-running at rtol/100 (${(rtol / 100).toExponential(0)})`);
    let coarse = null;
    if (fineCell < h) {
        const span = r0.domain.x[1] - r0.domain.x[0], spanY = r0.domain.y[1] - r0.domain.y[0];
        const divides = (L) => Math.abs(L / (2 * h) - Math.round(L / (2 * h))) < 1e-9;
        if (divides(span) && divides(spanY)) {
            try { coarse = await runFirst(withCell(2 * h), `Solving on a grid with twice the cell (${2 * h} mm) for the observed order`); } catch (e) { coarse = null; }
        }
    }
    const mb = metricSet(base.result, base.resolved), mf = metricSet(fine.result, fine.resolved), mt = metricSet(tight.result, tight.resolved);
    const mc = coarse ? metricSet(coarse.result, coarse.resolved) : null;
    const rows = accuracyTable(mb, mf, mt, mc, { fineIsCoarser: fineCell > h });
    return {
        particles: n, cell: h, fineCell, coarseCell: coarse ? 2 * h : null, rtol, rows, notes,
        // which comparison run measured the trajectory accuracy: 'rtol' (rtol/100) or 'steps' (space charge: steps × 1/√10)
        tightening: sc ? 'steps' : 'rtol', tightLabel: sc ? 'steps/√10' : 'rtol/100',
        endShift: { grid: endPointShift(base.result, fine.result), rtol: endPointShift(base.result, tight.result) },
        nodes: { base: base.nodes, fine: fine.nodes, coarse: coarse ? coarse.nodes : null },
    };
}

// ---------------------------------------------------------------- field profiles
/**
 * φ and E along the straight line p0 → p1 (plane coordinates; z = 0) with n samples, at display time t.
 * @returns {{ s: number[], x: number[], y: number[], phi: number[], ex: number[], ey: number[], e: number[] }}
 */
export function profileData(model, p0, p1, n = 400, t = 0) {
    const out = { s: [], x: [], y: [], phi: [], ex: [], ey: [], e: [] };
    if (!model) return out;
    const e4 = new Float64Array(4), L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    for (let i = 0; i < n; i++) {
        const u = n > 1 ? i / (n - 1) : 0, x = p0[0] + u * (p1[0] - p0[0]), y = p0[1] + u * (p1[1] - p0[1]);
        model.E(t, x, y, 0, e4);
        out.s.push(u * L); out.x.push(x); out.y.push(y); out.phi.push(e4[3]); out.ex.push(e4[0]); out.ey.push(e4[1]); out.e.push(Math.hypot(e4[0], e4[1], e4[2]));
    }
    return out;
}
/** The axis line of a cylindrical project (x from the domain start to its end at r = 0). */
export function axisLine(resolved) {
    const d = resolved.domain, x0 = d.mirror && d.mirror.x ? -d.x[1] : d.x[0];
    return [[x0, 0], [d.x[1], 0]];
}

// ---------------------------------------------------------------- Methods text
/** Latest stored benchmark report (Benchmarks panel), or null. */
export function lastBenchmarkReport() {
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(BENCH_STORAGE_KEY) : null;
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}

const fmtSig = (v, d = 3) => (isNum(v) ? String(parseFloat(v.toPrecision(d))) : '—');
const fmtE = (v) => (isNum(v) ? v.toExponential(0).replace('e-', 'e−') : '—');
const listJoin = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
const QUALITY_TEXT = { draft: 'draft', normal: 'normal', fine: 'fine', custom: 'custom' };

/**
 * Methods paragraph for a report (§4.7): grid, boundary method, solver and tolerance, superposition, integrator and
 * tolerance, field interpolation, relativistic mode, species and energies, engine version, latest benchmark result.
 * @param {{ resolved: object, solve?: object, run?: object }} state store state (or the parts of it)
 * @param {{ bench?: object|null }} [opts] bench: a stored benchmark report (default: the one saved by the Benchmarks tab)
 */
export function methodsText(state, { bench = undefined } = {}) {
    const r = state.resolved;
    if (!r) return 'The project has errors, so no methods text can be written.';
    const d = r.domain, cyl = d.type === 'cyl2d';
    const parts = [];
    const nBases = Math.max(0, r.electrodes.length - 1);
    const sol = r.solver || {};
    const methodText = { auto: 'geometric multigrid V(2,2) with automatic fallback to MG-preconditioned BiCGSTAB and adaptive red-black SOR', multigrid: 'geometric multigrid V(2,2)', krylov: 'MG-preconditioned BiCGSTAB', sor: 'adaptive red-black SOR (Carré)' }[sol.method || 'auto'];
    parts.push(`Electrostatic fields were computed with the ${PRODUCT_NAME} (beta, engine ${ENGINE_VERSION}) on a two-dimensional ${cyl ? 'cylindrical (x, r)' : 'planar (x, y)'} grid of ${d.nx} × ${d.ny} nodes (${d.N.toLocaleString('en-US')} nodes, cell ${fmtSig(d.h, 4)} mm${d.mirror && (d.mirror.x || d.mirror.y) ? `, mirrored in ${[d.mirror.x ? 'x' : null, d.mirror.y ? 'y' : null].filter(Boolean).join(' and ')}` : ''}${d.antimirror && (d.antimirror.x || d.antimirror.y) ? `, anti-mirrored in ${[d.antimirror.x ? 'x' : null, d.antimirror.y ? 'y' : null].filter(Boolean).join(' and ')} (odd potential, 0 V on the plane)` : ''})${(sol.boundary || 'subgrid') === 'subgrid' ? ' with Shortley–Weller sub-grid boundaries' : ' with staircase boundaries'}.`);
    if (nBases > 0) {
        const paths = state.solve && Array.isArray(state.solve.stats) ? [...new Set(state.solve.stats.map((s) => (s.path || []).join(' → ')))].filter(Boolean) : [];
        parts.push(`Laplace's equation was solved by ${methodText} to an estimated error of ${fmtE(sol.tol || 1e-10)} V per volt${paths.length ? ` (methods used: ${paths.join('; ')})` : ''}; ${nBases === 1 ? 'one unit-voltage basis field was' : `${nBases} unit-voltage basis fields, one per electrode, were`} combined by superposition${r.channelCount ? `, with ${r.channelCount} time-dependent channel${r.channelCount === 1 ? '' : 's'}` : ''}.`);
    } else parts.push('No electrode besides ground carries a voltage, so the electric field from electrodes is zero.');
    if (typeof d.charge === 'string' && d.charge.trim()) {
        const odd = d.antimirror && ((d.antimirror.x && !(d.mirror && d.mirror.x)) || (!cyl && d.antimirror.y && !(d.mirror && d.mirror.y)));
        parts.push(`A space-charge density ρ = ${d.charge.trim()} (C/m³) entered as a Poisson term: its particular solution, with 0 V on every electrode, was solved as one more basis and added to the superposition (ρ sampled at the cell centers; the particles do not change it${odd ? '; across the anti-mirror plane the image half carries −ρ' : ''}).`);
    }
    const interp = r.tracer.fieldInterp === 'linear' ? 'bilinear interpolation of nodal fields' : 'C¹ bicubic Hermite interpolation of the potential (bilinear nodal fields with same-side extrapolation in cells cut by electrodes)';
    parts.push(`The field between nodes used ${interp}.`);
    const q = r.tracer.q || {};
    const integ = { auto: 'the Dormand–Prince 5(4) method, or the Boris method for long runs in purely magnetic fields,', rk45: 'the Dormand–Prince 5(4) method', boris: 'the relativistic Boris method', rk4: 'the classical fourth-order Runge–Kutta method' }[r.tracer.integrator || 'auto'];
    parts.push(`Trajectories were integrated ${r.tracer.relativistic === false ? 'nonrelativistically' : 'relativistically'} with ${integ} at ${QUALITY_TEXT[r.tracer.quality] || 'normal'} accuracy (relative tolerance ${fmtE(q.rtol)}, steps ≤ ${fmtSig(q.maxStepCells)} cell and ≤ ${fmtSig(q.nearStepCells)} cell near electrodes).`);
    if ((r.magnets || []).length) {
        const nPoles = r.magnets.filter((m) => m.type === 'poles').length;
        parts.push(`Magnetic fields: ${r.magnets.length} source${r.magnets.length === 1 ? '' : 's'} (${nPoles ? 'pole pieces from a magnetic scalar potential solved on the grid (B = −∇ψ, infinitely permeable pieces)' : 'sharp-edged regions, uniform fields or exact circular loops'}${nPoles && nPoles < r.magnets.length ? ', with sharp-edged regions, uniform fields or circular loops' : ''}).`);
    }
    // physics plug-ins (Domain → Physics)
    const sc = r.tracer.spaceCharge, gas = r.tracer.gas, drag = r.tracer.drag;
    if (sc) parts.push(`Pairwise Coulomb forces between the particles were added (space-charge onset estimator, not a self-consistent solution: direct summation with Plummer softening ε = ${fmtSig(sc.softening)} mm, charge factor ${fmtSig(sc.factor)}, lockstep fourth-order Runge–Kutta).`);
    if (gas) parts.push(`Hard-sphere collisions with a ${fmtSig(gas.mass, 5)} u gas at ${fmtSig(gas.pressure)} Pa and ${fmtSig(gas.temperature, 4)} K (collision diameters: gas ${fmtSig(gas.diameter)} Å, ions ${gas.ionDiameter > 0 ? `${fmtSig(gas.ionDiameter)} Å` : 'estimated from the mass as spheres of density 1 g/cm³'}; isotropic scattering in the center-of-mass frame) were included.`);
    if (drag) parts.push(`Stokes drag with a mobility K = ${fmtSig(drag.mobility, 4)} cm²/(V·s) was included (qualitative).`);
    const sp = [];
    for (const s of r.sources || []) {
        const species = (s.species || []).map((x) => `${x.label} (${fmtSig(x.mass, 6)} u, ${x.charge > 0 ? '+' : ''}${x.charge} e)`);
        const en = s.energy || {};
        const e = en.type === 'mono' ? `${fmtSig(en.ke, 6)} eV` : en.type === 'uniform' ? `${fmtSig(en.min)}–${fmtSig(en.max)} eV` : en.type === 'gaussian' ? `${fmtSig(en.mean)} eV (FWHM ${fmtSig(en.fwhm)} eV)` : en.type === 'list' ? `${(en.values || []).map((v) => fmtSig(v)).join(', ')} eV` : '';
        const wt = isNum(s.weight) && s.weight !== 1 ? `, weight ${fmtSig(s.weight)}` : '';
        sp.push(s.type === 'rows' ? `a list of ${s.count} particles of ${listJoin(species)}${wt}` : `${s.count} ${listJoin(species)} at ${e}${wt}`);
    }
    if (sp.length) parts.push(`Particles: ${listJoin(sp)}.`);
    const b = bench === undefined ? lastBenchmarkReport() : bench;
    if (b && b.summary) parts.push(`Latest validation suite in this browser: ${b.summary.passed}/${b.summary.gates} gates passed (${b.level} level, engine ${b.engineVersion}, ${String(b.date || '').slice(0, 10)}).`);
    else parts.push('The validation suite (Benchmarks tab) has not been run in this browser.');
    return parts.join(' ');
}

/** Particle status counts as [name, count] for display (non-zero only). */
export function statusList(summary) {
    return STATUS_NAMES.map((n) => [n, summary.byStatus[n] || 0]).filter(([, c]) => c > 0);
}

/** Text for a status code, for tables (e.g. 'detected'). */
export function statusLabel(code) {
    const t = { 0: 'flying', 1: 'hit', 2: 'detected', 3: 'left the domain', 4: 'time limit', 5: 'step limit', 6: 'absorbed', 7: 'drift end', 8: 'numerical error', 9: 'born inside', 10: 'cancelled' };
    return t[code] || String(code);
}

// ---------------------------------------------------------------- pinned runs (Compare tab, §4.7)
// A pin is a plain record { id, label, createdAt, engineVersion, runKey, project, metrics, color, visible }: a deep copy of
// the project (the sources carry their seeds, so the run is regenerated from it bitwise) and the metrics of the run as it
// was pinned. Results (trajectories) are never stored; the Compare tab regenerates them through jobs.withTemporaryProject.
export const PINS_STORAGE_KEY = 'ionopt.pins.v1';
export const MAX_PINS = 8;
/** Colour tokens of the pin ghosts (the site's series colours c1–c6; the panel reads their current values from CSS). */
export const PIN_COLORS = Object.freeze(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
const PARAM_UNITS = { voltage: ' V', length: ' mm', time: ' µs', energy: ' eV', mass: ' u', frequency: ' MHz', angle: '°' };
let pinSeq = 0;

/** Default label of a pin: the project name and its slider parameters (else up to three fixed electrode voltages). */
export function pinLabel(project) {
    const name = (project && project.meta && typeof project.meta.name === 'string' && project.meta.name) || 'Untitled project';
    const params = ((project && project.params) || []).filter((p) => p && p.slider && isNum(p.value));
    let parts = params.map((p) => `${p.name} = ${fmtNum(p.value, 6)}${PARAM_UNITS[p.dim] || ''}`);
    if (!parts.length) parts = ((project && project.electrodes) || []).filter((e) => e && !e.ground && isNum(e.v)).slice(0, 3).map((e) => `${e.name || e.id} ${fmtNum(e.v, 6)} V`);
    return parts.length ? `${name} · ${parts.join(', ')}` : name;
}

/**
 * Metrics of a run for the Compare table (plain numbers, JSON-safe; NaN where a value does not exist): particles,
 * transmission, the beam waist (§3.11(4), per species as in the Summary tab), per plane the crossings, detected
 * fraction, spot rms, mean TOF, the waist from that plane and, with ≥ 2 crossings, the TOF statistics (σ, FWHM,
 * rms-based resolving power, per species peaks), and the energy diagnostics.
 * @param {object} result TraceResult @param {object} resolved @param {object|null} [model] FieldModel for the waist test
 */
export function pinMetrics(result, resolved, model = null) {
    const ov = runOverview(result, resolved);
    const s = ov.summary;
    const bw = beamWaist(result, resolved, model);
    const planes = ov.planes.map((p) => {
        const row = { id: p.id, name: p.name, kind: p.kind, terminate: p.terminate, crossings: p.crossings, detected: p.detected, fraction: p.fraction,
            spotRms: p.spotRms, meanTof: p.meanTof, waistPos: p.waist ? p.waist.position : NaN, waistRms: p.waist ? p.waist.rms : NaN, tof: null };
        if (p.crossings >= 2) {
            const all = peakStats(planeSample(result, resolved, p.index).tof);
            const tp = tofPeaks(result, resolved, p.index);
            row.tof = { n: all.n, sd: all.std, fwhm: all.fwhm, fwhmResolved: !!all.fwhmResolved, resolvingPower: all.resolvingPowerRms,
                peaks: tp.peaks.map((q) => ({ label: q.label, n: q.stats.n, mean: q.stats.mean, sd: q.stats.std, fwhm: q.stats.fwhm, resolvingPower: q.stats.resolvingPowerRms })) };
        }
        return row;
    });
    const byStatus = {};
    for (const [k, c] of statusList(s)) byStatus[k] = c;
    return {
        launched: s.launched, traced: s.traced, byStatus, transmission: s.transmission.overall,
        waist: bw ? { ok: !!bw.ok, reason: bw.reason || null, axis: bw.axis, name: bw.name, position: bw.position, rms: bw.rms, rmsAtPlane: bw.rmsAtPlane,
            groups: (bw.groups || []).map((g) => ({ label: g.label, n: g.n, position: g.position, rms: g.rms })) } : null,
        planes, energy: { maxEnd: s.energy.maxEnd, medianEnd: s.energy.medianEnd, maxEndRel: s.energy.maxEndRel },
        trajectories: !!(result && result.traj && result.traj.pts && result.traj.pts.length),
    };
}

/**
 * A pin of a run: a deep copy of the project, its run key and the run's metrics.
 * @param {{ project: object, resolved: object, result: object, model?: object|null, id?: string|null, label?: string|null,
 *   color?: string|null, now?: number, engineVersion?: string }} o
 */
export function makePin({ project, resolved, result, model = null, id = null, label = null, color = null, now = Date.now(), engineVersion = ENGINE_VERSION }) {
    if (!project || !resolved || !result) throw new Error('A pin needs the project, its resolution and a run result.');
    return {
        id: id || `pin-${now.toString(36)}-${(++pinSeq).toString(36)}`,
        label: label || pinLabel(project), createdAt: new Date(now).toISOString(), engineVersion,
        runKey: runKeyOf(resolved), project: clone(project), metrics: pinMetrics(result, resolved, model),
        color: color || PIN_COLORS[0], visible: true,
    };
}

/**
 * The pins with `pin` added at the end, the oldest dropped beyond `max`; a pin whose id is already there replaces it in
 * place, so relabelling or hiding a pin keeps its number and column (as store.pinRun).
 */
export function addPin(pins, pin, max = MAX_PINS) {
    const list = pins || [];
    const k = list.findIndex((p) => p.id === pin.id);
    if (k >= 0) { const same = list.slice(); same[k] = pin; return same; }
    const out = [...list, pin];
    while (out.length > max) out.shift();
    return out;
}
/** The pins without the one with this id. */
export function removePin(pins, id) { return (pins || []).filter((p) => p.id !== id); }
/** The first colour token no pin uses (else cycling through the tokens). */
export function nextPinColor(pins) {
    const used = new Set((pins || []).map((p) => p.color));
    return PIN_COLORS.find((c) => !used.has(c)) || PIN_COLORS[(pins || []).length % PIN_COLORS.length];
}
/** The storable part of a pin (no results, no derived state). */
export function serializePin(pin) {
    const { id, label, createdAt, engineVersion, runKey, project, metrics, color } = pin;
    return { id, label, createdAt: createdAt || null, engineVersion: engineVersion || null, runKey: runKey || null, project, metrics: metrics || null,
        color: PIN_COLORS.includes(color) ? color : PIN_COLORS[0], visible: pin.visible !== false };
}
function defaultStorage() { try { return globalThis.localStorage || null; } catch (e) { return null; } }
/**
 * Pins saved in local storage (the same mechanism as the autosave: every call wrapped, [] when storage is blocked,
 * absent or damaged). Entries without an id or a project object are dropped; at most MAX_PINS (the newest) are kept.
 * @param {Storage|null} [storage]
 */
export function readPins(storage = defaultStorage()) {
    try {
        if (!storage) return [];
        const raw = storage.getItem(PINS_STORAGE_KEY);
        if (!raw) return [];
        const data = JSON.parse(raw);
        const list = Array.isArray(data) ? data : (data && Array.isArray(data.pins) ? data.pins : []);
        return list.filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && p.id && p.project && typeof p.project === 'object')
            .slice(-MAX_PINS)
            .map((p) => ({ ...serializePin(p), label: typeof p.label === 'string' && p.label ? p.label : pinLabel(p.project), metrics: p.metrics && typeof p.metrics === 'object' ? p.metrics : null }));
    } catch (e) { return []; }
}
/**
 * Saves the pins (serialized, at most MAX_PINS) to local storage; an empty list removes the entry, so that a startup
 * probe of the key finds nothing to load. @returns {boolean} saved
 */
export function writePins(pins, storage = defaultStorage(), now = Date.now()) {
    try {
        if (!storage) return false;
        const list = (pins || []).slice(-MAX_PINS);
        if (!list.length) {
            if (typeof storage.removeItem === 'function') storage.removeItem(PINS_STORAGE_KEY);
            else storage.setItem(PINS_STORAGE_KEY, '[]');
            return true;
        }
        storage.setItem(PINS_STORAGE_KEY, JSON.stringify({ version: 1, savedAt: new Date(now).toISOString(), pins: list.map(serializePin) }));
        return true;
    } catch (e) { return false; }
}

/**
 * True when two metric sets of the same pin disagree beyond rounding (1e-9 relative) in transmission, waist, spot
 * rms or mean TOF: the regenerated run differs from the one pinned (another engine version, or a changed preset).
 */
export function metricsDiffer(a, b) {
    if (!a || !b) return false;
    const pairs = [[a.transmission, b.transmission]];
    if (a.waist && b.waist && a.waist.ok && b.waist.ok) pairs.push([a.waist.position, b.waist.position], [a.waist.rms, b.waist.rms]);
    for (const p of a.planes || []) {
        const q = (b.planes || []).find((x) => x.id === p.id);
        if (q) pairs.push([p.spotRms, q.spotRms], [p.meanTof, q.meanTof], [p.fraction, q.fraction]);
    }
    return pairs.some(([x, y]) => isNum(x) && isNum(y) && Math.abs(x - y) > 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)));
}

/**
 * The side-by-side table of pinned runs: one column per pin and a row for every metric at least one pin has (NaN where
 * a pin lacks it). metricsOf(pin) chooses the metrics shown (default: those stored with the pin; the panel passes the
 * regenerated ones).
 * @returns {{ columns: string[], keys: string[], rows: Array<Array<string|number>> }}
 */
export function compareTable(pins, metricsOf = (p) => p.metrics) {
    const list = pins || [];
    const ms = list.map((p) => metricsOf(p) || {});
    const num = (v) => (isNum(v) ? v : NaN);
    const defs = [];
    const add = (key, label, get) => { if (!defs.some((d) => d.key === key)) defs.push({ key, label, get }); };
    add('launched', 'Particles launched', (m) => num(m.launched));
    add('transmission', 'Transmission (all detectors)', (m) => num(m.transmission));
    add('waist:pos', 'Waist position (mm)', (m) => (m.waist && m.waist.ok ? num(m.waist.position) : NaN));
    add('waist:rms', 'rms radius at the waist (mm)', (m) => (m.waist && m.waist.ok ? num(m.waist.rms) : NaN));
    const planeOf = (m, id) => ((m && m.planes) || []).find((p) => p.id === id);
    const pv = (id, f) => (m) => { const r = planeOf(m, id); return r ? num(f(r)) : NaN; };
    const tv = (id, f) => (m) => { const r = planeOf(m, id); return r && r.tof ? num(f(r.tof)) : NaN; };
    for (const m of ms) {
        for (const p of m.planes || []) {
            const lab = p.name || p.id;
            if (p.terminate) add(`${p.id}:fraction`, `${lab}: transmission`, pv(p.id, (r) => r.fraction));
            add(`${p.id}:crossings`, `${lab}: crossings`, pv(p.id, (r) => r.crossings));
            add(`${p.id}:spotRms`, `${lab}: spot rms (mm)`, pv(p.id, (r) => r.spotRms));
            add(`${p.id}:meanTof`, `${lab}: mean TOF (µs)`, pv(p.id, (r) => r.meanTof));
            add(`${p.id}:tofSd`, `${lab}: TOF σ (µs)`, tv(p.id, (t) => t.sd));
            add(`${p.id}:tofFwhm`, `${lab}: TOF FWHM (µs)`, tv(p.id, (t) => t.fwhm));
            add(`${p.id}:R`, `${lab}: resolving power t/(2·2.3548σ)`, tv(p.id, (t) => t.resolvingPower));
            const peaks = (p.tof && p.tof.peaks) || [];
            if (peaks.length > 1) {
                for (const pk of peaks) {
                    const sel = (f) => tv(p.id, (t) => { const q = (t.peaks || []).find((x) => x.label === pk.label); return q ? f(q) : NaN; });
                    add(`${p.id}:${pk.label}:meanTof`, `${lab}, ${pk.label}: mean TOF (µs)`, sel((q) => q.mean));
                    add(`${p.id}:${pk.label}:fwhm`, `${lab}, ${pk.label}: TOF FWHM (µs)`, sel((q) => q.fwhm));
                    add(`${p.id}:${pk.label}:R`, `${lab}, ${pk.label}: resolving power`, sel((q) => q.resolvingPower));
                }
            }
        }
    }
    add('energy:maxEnd', 'Max |ΔE| at the end (eV)', (m) => (m.energy ? num(m.energy.maxEnd) : NaN));
    const rows = [], keys = [];
    for (const d of defs) {
        const vals = ms.map((m) => d.get(m));
        if (vals.some(isNum)) { rows.push([d.label, ...vals]); keys.push(d.key); }
    }
    return { columns: ['Metric', ...list.map((p, i) => `${i + 1}. ${p.label || p.id}`)], keys, rows };
}
/** CSV of the comparison table. */
export function compareCsv(pins, metricsOf) {
    const t = compareTable(pins, metricsOf);
    return csvText(t.columns, t.rows);
}

