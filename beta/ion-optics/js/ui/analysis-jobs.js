/* ==========================================================================
   Ion optics UI: analysis-jobs.js
   Main-thread orchestration of the analysis tools (spec §3.11, §4.7):
   lens properties and the image finder (rays traced by the worker pool
   through jobs.traceBatch), 1D scans and Nelder–Mead tuning (temporary
   projects through jobs.withTemporaryProject, which re-solve only when the
   geometry changes), the accuracy check (h/2 re-solve, rtol/100 re-run of the
   first ≤ 200 particles, the observed order p from three resolutions and the
   Richardson estimates of the remaining grid error, Δ·2^p/(2^p − 1) for the
   current grid and Δ/(2^p − 1) for the finer one; Richardson, Phil. Trans.
   R. Soc. A 210, 307 (1911)),
   field profiles along a line, run overviews for the Summary tab and the
   Methods text. Pure functions take plain data so Node tests can call them.
   ========================================================================== */
import { lensProperties, imageOf } from '../engine/lensprops.js';
import { scan1D, nelderMead, evaluateMetric, planeIndex, planeSample, rmsRadius, waistOf, METRICS } from '../engine/optimize.js';
import { summarize, peakStats, histogram, tofCalibration } from '../engine/analysis.js';
import { S_STRIDE, S_ID, S_STATUS, S_X, S_Y, S_Z, S_SPECIES, S_SRC, STATUS, STATUS_NAMES } from '../engine/layout.js';
import { ENGINE_VERSION, PRODUCT_NAME } from '../engine/version.js';

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
 * TOF peaks per species at a plane: histogram data, peak statistics (mean, σ, FWHM, R from the FWHM, from the rms width and
 * from the narrowest 76.1% of the times; the bootstrap range of the rms-based R) and the calibration t = a√(m/q) + b.
 */
export function tofPeaks(result, resolved, k) {
    const smp = planeSample(result, resolved, k);
    const S = result.summary, sidx = new Map();
    for (let i = 0; i < result.n; i++) sidx.set(S[i * S_STRIDE + S_ID], i * S_STRIDE);
    const groups = new Map();
    const sources = (resolved && resolved.sources) || [];
    for (let i = 0; i < smp.ids.length; i++) {
        const o = sidx.get(smp.ids[i]);
        const src = sources[S[o + S_SRC]], sp = src && src.species ? src.species[S[o + S_SPECIES]] : null;
        const key = sp ? `${sp.label}` : `species ${S[o + S_SPECIES]}`;
        let g = groups.get(key);
        if (!g) { g = { label: key, mass: sp ? sp.mass : NaN, charge: sp ? sp.charge : NaN, t: [] }; groups.set(key, g); }
        g.t.push(smp.tof[i]);
    }
    const peaks = [...groups.values()].map((g) => ({ ...g, stats: peakStats(g.t), rRange: bootstrapRmsR(g.t) }));
    const all = smp.tof;
    let lo = Infinity, hi = -Infinity;
    for (const t of all) { if (t < lo) lo = t; if (t > hi) hi = t; }
    const hist = all.length ? peaks.map((p) => ({ label: p.label, ...histogram(p.t, { bins: Math.max(10, Math.min(200, Math.round(Math.sqrt(all.length) * 2))), min: lo, max: hi }) })) : [];
    const pairs = peaks.filter((p) => isNum(p.mass) && isNum(p.charge) && p.charge !== 0 && p.stats.n > 0).map((p) => ({ mq: p.mass / Math.abs(p.charge), t: p.stats.mean }));
    const cal = pairs.length >= 2 ? tofCalibration(pairs) : null;
    return { peaks, hist, calibration: cal, n: all.length };
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
 * Accuracy check of the current project: the first ≤ maxParticles particles are re-run on a grid with half the cell
 * (twice the cell when the memory estimate forbids it, noted), at rtol/100 on the same grid, and on a 2h grid
 * (when it divides the domain) for the observed order. onStep(text) reports progress.
 */
export async function accuracyCheck(ctx, { maxParticles = 200, onStep = null } = {}) {
    const st = ctx.store.get();
    if (!st.resolved) throw new Error('The project has errors; fix them before the accuracy check.');
    const project = clone(st.project), r0 = st.resolved;
    const n = Math.min(maxParticles, r0.particleCount);
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
    const runFirst = (p, label) => ctx.jobs.withTemporaryProject(p, async (tmp) => {
        if (onStep) onStep(label);
        const est = tmp.estimate ? tmp.estimate() : null;
        if (est && est.blocked) { const e = new Error(est.blockMessage || 'Too large'); e.code = 'E_MEMORY'; throw e; }
        const res = await tmp.traceBatch({ range: [0, n] });
        return { result: res, resolved: tmp.resolved, nodes: tmp.resolved.domain.N };
    });
    const notes = [];
    const base = await runFirst(project, 'Re-running the first particles on the current grid');
    let fine, fineCell = h / 2;
    try { fine = await runFirst(withCell(h / 2), `Solving on a grid with half the cell (${h / 2} mm)`); }
    catch (e) {
        if (!(e && e.code === 'E_MEMORY')) throw e;
        fineCell = 2 * h;
        notes.push('The half-cell grid exceeds the memory limit; the comparison uses twice the cell instead.');
        fine = await runFirst(withCell(2 * h), `Solving on a grid with twice the cell (${2 * h} mm)`);
    }
    const tight = await runFirst(withRtol(), `Re-running at rtol/100 (${(rtol / 100).toExponential(0)})`);
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
    parts.push(`Electrostatic fields were computed with the ${PRODUCT_NAME} (beta, engine ${ENGINE_VERSION}) on a two-dimensional ${cyl ? 'cylindrical (x, r)' : 'planar (x, y)'} grid of ${d.nx} × ${d.ny} nodes (${d.N.toLocaleString('en-US')} nodes, cell ${fmtSig(d.h, 4)} mm${d.mirror && (d.mirror.x || d.mirror.y) ? `, mirrored in ${[d.mirror.x ? 'x' : null, d.mirror.y ? 'y' : null].filter(Boolean).join(' and ')}` : ''})${(sol.boundary || 'subgrid') === 'subgrid' ? ' with Shortley–Weller sub-grid boundaries' : ' with staircase boundaries'}.`);
    if (nBases > 0) {
        const paths = state.solve && Array.isArray(state.solve.stats) ? [...new Set(state.solve.stats.map((s) => (s.path || []).join(' → ')))].filter(Boolean) : [];
        parts.push(`Laplace's equation was solved by ${methodText} to an estimated error of ${fmtE(sol.tol || 1e-10)} V per volt${paths.length ? ` (methods used: ${paths.join('; ')})` : ''}; ${nBases === 1 ? 'one unit-voltage basis field was' : `${nBases} unit-voltage basis fields, one per electrode, were`} combined by superposition${r.channelCount ? `, with ${r.channelCount} time-dependent channel${r.channelCount === 1 ? '' : 's'}` : ''}.`);
    } else parts.push('No electrode besides ground carries a voltage, so the electric field from electrodes is zero.');
    const interp = r.tracer.fieldInterp === 'linear' ? 'bilinear interpolation of nodal fields' : 'C¹ bicubic Hermite interpolation of the potential (bilinear nodal fields with same-side extrapolation in cells cut by electrodes)';
    parts.push(`The field between nodes used ${interp}.`);
    const q = r.tracer.q || {};
    const integ = { auto: 'the Dormand–Prince 5(4) method, or the Boris method for long runs in purely magnetic fields,', rk45: 'the Dormand–Prince 5(4) method', boris: 'the relativistic Boris method', rk4: 'the classical fourth-order Runge–Kutta method' }[r.tracer.integrator || 'auto'];
    parts.push(`Trajectories were integrated ${r.tracer.relativistic === false ? 'nonrelativistically' : 'relativistically'} with ${integ} at ${QUALITY_TEXT[r.tracer.quality] || 'normal'} accuracy (relative tolerance ${fmtE(q.rtol)}, steps ≤ ${fmtSig(q.maxStepCells)} cell and ≤ ${fmtSig(q.nearStepCells)} cell near electrodes).`);
    if ((r.magnets || []).length) parts.push(`Magnetic fields: ${r.magnets.length} source${r.magnets.length === 1 ? '' : 's'} (sharp-edged regions, uniform fields or exact circular loops).`);
    const sp = [];
    for (const s of r.sources || []) {
        const species = (s.species || []).map((x) => `${x.label} (${fmtSig(x.mass, 6)} u, ${x.charge > 0 ? '+' : ''}${x.charge} e)`);
        const en = s.energy || {};
        const e = en.type === 'mono' ? `${fmtSig(en.ke, 6)} eV` : en.type === 'uniform' ? `${fmtSig(en.min)}–${fmtSig(en.max)} eV` : en.type === 'gaussian' ? `${fmtSig(en.mean)} eV (FWHM ${fmtSig(en.fwhm)} eV)` : en.type === 'list' ? `${(en.values || []).map((v) => fmtSig(v)).join(', ')} eV` : '';
        sp.push(`${s.count} ${listJoin(species)} at ${e}`);
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

