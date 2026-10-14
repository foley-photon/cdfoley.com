// WP6 integrated preset tests (spec §4.14, §7.7 (5)): every preset solves and runs in Node within its time budget
// (3 s; the reflectron and the RF quadrupole 15 s) and meets the expectations stored in its `expect` list.
// The checks are data in the preset modules; this file interprets them through the real pipeline.
//
//   node --test "_tests/ionoptics/wp6-presets.test.mjs"                        quick level
//   IONOPTICS_LEVEL=full node --test "_tests/ionoptics/wp6-presets.test.mjs"   full level (adds the long scans)
//   node _tests/ionoptics/wp6-presets.test.mjs [--only einzel,vmi] [--json E:/path/wp6-presets.json]
//
// Nothing is written unless --json is given.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { PRESETS } from '../../beta/ion-optics/js/presets/index.js';
import * as pipeline from '../../beta/ion-optics/js/engine/pipeline.js';
import * as analysis from '../../beta/ion-optics/js/engine/analysis.js';
import * as particles from '../../beta/ion-optics/js/engine/particles.js';
import * as hash from '../../beta/ion-optics/js/engine/hash.js';
import * as L from '../../beta/ion-optics/js/engine/layout.js';
import { parseExpr } from '../../beta/ion-optics/js/engine/expr.js';
import { ENGINE_VERSION } from '../../beta/ion-optics/js/engine/version.js';
import { lensProperties, imageOf } from '../../beta/ion-optics/js/engine/lensprops.js';
import { reflectronTof } from '../../beta/ion-optics/js/engine/exact.js';

const LEVEL = process.env.IONOPTICS_LEVEL === 'full' ? 'full' : 'quick';
const ARGS = process.argv.slice(2);
const argOf = (name) => { const i = ARGS.indexOf(name); return i >= 0 && i + 1 < ARGS.length ? ARGS[i + 1] : null; };
const JSON_OUT = argOf('--json');
const ONLY = argOf('--only') ? argOf('--only').split(',') : null;
/** Time budget for resolve + solve + field + trace of the preset as built (spec §4.14). */
const BUDGET_MS = { reflectron: 15000, 'rf-quadrupole': 15000 };
const DEFAULT_BUDGET_MS = 3000;

// ---------------------------------------------------------------- runs
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Applies a variant to a project: { params: { name: value }, electrodes: { id: v }, shapes: { id: { key: value } },
 * add: { electrodes: [...], shapes: [...] } } (parameters, voltages, shape edits, appended electrodes and shapes).
 */
function applySet(project, set) {
    if (!set) return project;
    for (const [name, value] of Object.entries(set.params || {})) {
        const q = project.params.find((x) => x.name === name);
        if (!q) throw new Error(`unknown parameter ${name}`);
        q.value = value;
    }
    for (const [id, v] of Object.entries(set.electrodes || {})) {
        const e = project.electrodes.find((x) => x.id === id);
        if (!e) throw new Error(`unknown electrode ${id}`);
        e.v = v;
    }
    for (const [id, patch] of Object.entries(set.shapes || {})) {
        const s = project.shapes.find((x) => x.id === id);
        if (!s) throw new Error(`unknown shape ${id}`);
        Object.assign(s, clone(patch));
    }
    if (set.add) {
        for (const e of set.add.electrodes || []) project.electrodes.push(clone(e));
        for (const s of set.add.shapes || []) project.shapes.push(clone(s));
    }
    return project;
}

/** Solves a preset once and runs it with voltage or parameter changes (bases reused while the geometry key is unchanged). */
function makeRunner(preset) {
    const t0 = performance.now();
    const project0 = preset.build();
    const resolved0 = pipeline.resolveOrThrow(project0);
    const geom0 = hash.geomKey(resolved0);
    const solved0 = pipeline.solveProject(resolved0);
    const field0 = pipeline.buildField(resolved0, solved0);
    const result0 = pipeline.traceProject(resolved0, field0, {});
    const summary0 = analysis.summarize(result0, resolved0);
    const baseMs = performance.now() - t0;
    const base = { set: null, resolved: resolved0, solved: solved0, field: field0, result: result0, summary: summary0 };
    const cache = new Map([['{}', base]]);
    let extraSolves = 0;
    function run(set = null, { keep = true, trajectories = true } = {}) {
        const key = JSON.stringify(set || {}) + (trajectories ? '' : '|nt');
        if (cache.has(key)) return cache.get(key);
        const resolved = pipeline.resolveOrThrow(applySet(preset.build(), set));
        let solved = solved0;
        if (hash.geomKey(resolved) !== geom0) {
            // a geometry variant that a preset suggests must be as clean as the preset itself
            const { warnings } = pipeline.prepare(resolved);
            if (warnings.length) throw new Error(`the geometry variant raises ${warnings.map((w) => w.code).join(', ')}`);
            solved = pipeline.solveProject(resolved);
            extraSolves++;
        }
        const field = pipeline.buildField(resolved, solved);
        const result = pipeline.traceProject(resolved, field, trajectories ? {} : { overrides: { record: { trajectories: false } } });
        const out = { set, resolved, solved, field, result, summary: analysis.summarize(result, resolved) };
        if (keep) cache.set(key, out);
        return out;
    }
    return { preset, base, baseMs, run, get extraSolves() { return extraSolves; } };
}

// ---------------------------------------------------------------- run helpers
function planeIdx(run, id) {
    const k = run.resolved.recording.planes.findIndex((p) => p.id === id);
    if (k < 0) throw new Error(`no plane "${id}"`);
    return k;
}
function speciesRef(resolved, label) {
    for (const s of resolved.sources) {
        const k = (s.species || []).findIndex((sp) => sp.label === label);
        if (k >= 0) return { src: s.index !== undefined ? s.index : resolved.sources.indexOf(s), sp: k };
    }
    throw new Error(`no species "${label}"`);
}
/** Per-particle birth data and class indices (regenerated: counter-based, so identical to the traced rows). */
function particleInfo(run) {
    if (run._info) return run._info;
    const r = run.resolved;
    const rows = particles.generate(r.sources, 0, r.particleCount, { domainType: r.domain.type, relativistic: r.tracer.relativistic !== false });
    const out = [];
    for (let o = 0; o < rows.length; o += L.P_STRIDE) {
        out.push({ id: rows[o + L.P_ID], src: rows[o + L.P_SRC], sp: rows[o + L.P_SPECIES], ke: rows[o + L.P_KE], x0: rows[o + L.P_X], y0: rows[o + L.P_Y],
            c0: rows[o + L.P_C0], c1: rows[o + L.P_C1], c2: rows[o + L.P_C2] });
    }
    run._info = out;
    return out;
}
function dirCount(info, src) {
    let m = -1;
    for (const q of info) if (q.src === src && q.c1 > m) m = q.c1;
    return m + 1;
}
/** Ids matching { species?: label, energy?: eV, dir?: 'center'|'min'|'max'|index }. */
function selectIds(run, sel = {}) {
    const info = particleInfo(run);
    const sp = sel.species != null ? speciesRef(run.resolved, sel.species) : null;
    const out = [];
    for (const q of info) {
        if (sp && (q.src !== sp.src || q.sp !== sp.sp)) continue;
        if (sel.energy != null && Math.abs(q.ke - sel.energy) > 1e-9 * Math.max(1, Math.abs(sel.energy))) continue;
        if (sel.dir != null) {
            const nd = dirCount(info, q.src);
            const want = sel.dir === 'min' ? 0 : sel.dir === 'max' ? nd - 1 : sel.dir === 'center' ? (nd - 1) / 2 : sel.dir;
            if (q.c1 !== want) continue;
        }
        out.push(q.id);
    }
    if (!out.length) throw new Error(`no particle matches ${JSON.stringify(sel)}`);
    return out;
}
function one(ids, what) {
    if (ids.length !== 1) throw new Error(`${what}: expected one particle, found ${ids.length}`);
    return ids[0];
}
/** Summary-row offset of a particle id. */
function sOff(run, id) {
    const S = run.result.summary, i = id - (run.result.i0 || 0);
    if (S[i * L.S_STRIDE + L.S_ID] === id) return i * L.S_STRIDE;
    for (let k = 0; k < run.result.n; k++) if (S[k * L.S_STRIDE + L.S_ID] === id) return k * L.S_STRIDE;
    throw new Error(`no summary row for particle ${id}`);
}
/** First crossing of each particle on a plane: Map id → { x, y, z, vx, vy, vz, t, ke }. */
function crossings(run, planeId) {
    const key = '_cross_' + planeId;
    if (run[key]) return run[key];
    const rows = analysis.planeRows(run.result, planeIdx(run, planeId));
    const m = new Map();
    for (let o = 0; o < rows.length; o += L.C_STRIDE) {
        const id = rows[o + L.C_ID];
        if (m.has(id)) continue;
        m.set(id, { x: rows[o + L.C_X], y: rows[o + L.C_Y], z: rows[o + L.C_Z], vx: rows[o + L.C_VX], vy: rows[o + L.C_VY], vz: rows[o + L.C_VZ], t: rows[o + L.C_T], ke: rows[o + L.C_KE] });
    }
    run[key] = m;
    return m;
}
function coordOf(p, c) {
    if (c.coord === 'r') { const cx = c.center ? c.center[0] : 0, cy = c.center ? c.center[1] : 0; return Math.hypot(p.x - cx, p.y - cy); }
    return p[c.coord];
}
function crossingOf(run, planeId, id) {
    const p = crossings(run, planeId).get(id);
    if (!p) throw new Error(`particle ${id} never crossed plane "${planeId}" (status ${L.STATUS_NAMES ? L.STATUS_NAMES[run.result.summary[sOff(run, id) + L.S_STATUS]] : run.result.summary[sOff(run, id) + L.S_STATUS]})`);
    return p;
}
/** Stored trajectory points (x, y, z, t as Float32) of one particle. */
function trajectory(run, id) {
    const tr = run.result.traj;
    if (!tr) throw new Error('trajectories were not stored');
    const i = id - (run.result.i0 || 0);
    return tr.pts.subarray(4 * tr.offsets[i], 4 * tr.offsets[i + 1]);
}
/** Polar samples (unwrapped angle in degrees, radius) of a trajectory about a centre. */
function polar(pts, cx, cy) {
    const n = pts.length / 4, A = new Float64Array(n), R = new Float64Array(n);
    let prev = null, off = 0;
    for (let k = 0; k < n; k++) {
        const x = pts[4 * k] - cx, y = pts[4 * k + 1] - cy;
        let a = Math.atan2(y, x) * 180 / Math.PI;
        if (prev !== null) { while (a + off - prev > 180) off -= 360; while (a + off - prev < -180) off += 360; }
        a += off;
        A[k] = a; R[k] = Math.hypot(x, y); prev = a;
    }
    return { A, R };
}
function interpAt(A, R, a) {
    if (a < A[0] || a > A[A.length - 1]) return NaN;
    let lo = 0, hi = A.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A[m] <= a) lo = m; else hi = m; }
    return A[hi] === A[lo] ? R[lo] : R[lo] + (R[hi] - R[lo]) * (a - A[lo]) / (A[hi] - A[lo]);
}
function detectedTimes(run, planeId, label) {
    const pi = planeIdx(run, planeId);
    const sp = label != null ? speciesRef(run.resolved, label) : null;
    const S = run.result.summary, out = [];
    for (let i = 0; i < run.result.n; i++) {
        const o = i * L.S_STRIDE;
        if (S[o + L.S_STATUS] !== L.STATUS.DETECTED || S[o + L.S_WHERE] !== pi) continue;
        if (sp && (S[o + L.S_SRC] !== sp.src || S[o + L.S_SPECIES] !== sp.sp)) continue;
        out.push(S[o + L.S_TOF]);
    }
    return out;
}
/** Ring centroids of the ±90° direction groups at one energy (velocity-map imaging, §3.11(6)). */
function ringGroups(run, planeId, energy) {
    const info = particleInfo(run);
    const src = run.resolved.sources[0];
    const d = src.direction;
    if (!d || d.type !== 'fan') throw new Error('ring metrics need a fan source');
    const n = dirCount(info, 0);
    const angle = (k) => (n === 1 ? 0.5 * (d.from + d.to) : d.from + (d.to - d.from) * k / (n - 1));
    const kOf = (deg) => { for (let k = 0; k < n; k++) if (Math.abs(((angle(k) - deg) % 360 + 360) % 360) < 1e-9) return k; throw new Error(`no ${deg}° direction class`); };
    const cr = crossings(run, planeId);
    const group = (k) => {
        const ys = [], zs = [];
        for (const q of info) if (q.c1 === k && Math.abs(q.ke - energy) <= 1e-9 * energy) { const p = cr.get(q.id); if (p) { ys.push(p.y); zs.push(p.z); } }
        if (!ys.length) throw new Error(`no ${energy} eV ions of direction class ${k} reached the detector`);
        const my = ys.reduce((s, v) => s + v, 0) / ys.length, mz = zs.reduce((s, v) => s + v, 0) / zs.length;
        let q2 = 0;
        for (let i = 0; i < ys.length; i++) q2 += (ys[i] - my) ** 2 + (zs[i] - mz) ** 2;
        return { cy: my, cz: mz, rms: Math.sqrt(q2 / ys.length), n: ys.length };
    };
    const up = group(kOf(90)), down = group(kOf(270));
    return { up, down, R: 0.5 * Math.hypot(up.cy - down.cy, up.cz - down.cz) };
}
/** Grouped blur (§3.11(6)): groups by (source, species, direction class, energy class) at a plane. */
function groupedBlur(run, planeId) {
    const info = particleInfo(run);
    const byId = new Map(info.map((q) => [q.id, q]));
    const rows = analysis.planeRows(run.result, planeIdx(run, planeId));
    const spots = analysis.groupedSpots(rows, (R, o) => { const q = byId.get(R[o + L.C_ID]); return `${q.src}:${q.sp}:${q.c1}:${q.c2}`; }, ['y', 'z']);
    return analysis.groupedBlur(spots);
}
function evalArgs(args, paramValues) {
    const out = {};
    for (const [k, v] of Object.entries(args || {})) out[k] = typeof v === 'string' ? parseExpr(v).evaluate(paramValues) : v;
    return out;
}
const traceFnFor = (run) => async (parts, opts) => pipeline.traceProject(run.resolved, run.field, { particles: parts, overrides: opts });

// ---------------------------------------------------------------- metrics
// Each returns a number, a [min, max] range or { value, target } (a computed reference).
const METRICS = {
    transmission(run, c) {
        const ids = selectIds(run, c.species != null ? { species: c.species } : {});
        const pi = planeIdx(run, c.plane), S = run.result.summary;
        let d = 0;
        for (const id of ids) { const o = sOff(run, id); if (S[o + L.S_STATUS] === L.STATUS.DETECTED && S[o + L.S_WHERE] === pi) d++; }
        return d / ids.length;
    },
    statusFraction(run, c) {
        const ids = selectIds(run, c.species != null ? { species: c.species } : {});
        const want = new Set(c.status.map((s) => L.STATUS[s]));
        let k = 0;
        for (const id of ids) if (want.has(run.result.summary[sOff(run, id) + L.S_STATUS])) k++;
        return k / ids.length;
    },
    detectedCount(run, c) {
        const pi = planeIdx(run, c.plane), S = run.result.summary;
        let d = 0;
        for (let i = 0; i < run.result.n; i++) if (S[i * L.S_STRIDE + L.S_STATUS] === L.STATUS.DETECTED && S[i * L.S_STRIDE + L.S_WHERE] === pi) d++;
        return d;
    },
    waist(run, c) {
        return analysis.waist(analysis.planeRows(run.result, planeIdx(run, c.plane)), c.axis || 'x').position;
    },
    axisCrossing(run, c) {
        // the two rays born closest to the axis (excluding an axial ray), extended as straight lines from the plane
        const info = particleInfo(run).filter((q) => Math.abs(q.y0) > 1e-12).sort((a, b) => Math.abs(a.y0) - Math.abs(b.y0)).slice(0, 2);
        const xs = info.map((q) => { const p = crossingOf(run, c.plane, q.id); return p.x - p.y * p.vx / p.vy; });
        return xs.reduce((s, v) => s + v, 0) / xs.length;
    },
    energyError(run) {
        return run.summary.energy.maxEndRel;
    },
    fieldMagnitude(run, c) {
        const o = new Float64Array(4);
        run.field.model.E(0, c.at[0], c.at[1], c.at[2] || 0, o);
        return Math.hypot(o[0], o[1], o[2]);
    },
    radiusRange(run, c) {
        const id = one(selectIds(run, c.select), 'radiusRange');
        const { A, R } = polar(trajectory(run, id), c.center[0], c.center[1]);
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k < A.length; k++) if (A[k] >= c.angles[0] && A[k] <= c.angles[1]) { lo = Math.min(lo, R[k]); hi = Math.max(hi, R[k]); }
        for (const a of c.angles) { const r = interpAt(A, R, a); if (Number.isFinite(r)) { lo = Math.min(lo, r); hi = Math.max(hi, r); } }
        return [lo, hi];
    },
    fanCrossing(run, c) {
        const [pa, pb] = c.select.map((s) => polar(trajectory(run, one(selectIds(run, s), 'fanCrossing')), c.center[0], c.center[1]));
        let prev = null, prevA = null;
        for (let a = c.angles[0]; a <= c.angles[1] + 1e-9; a += 0.01) {
            const d = interpAt(pa.A, pa.R, a) - interpAt(pb.A, pb.R, a);
            if (!Number.isFinite(d)) { prev = null; continue; }
            if (prev !== null && (d === 0 || (d > 0) !== (prev > 0))) return prevA + (a - prevA) * prev / (prev - d);
            prev = d; prevA = a;
        }
        return NaN;
    },
    dispersion(run, c) {
        const pa = crossingOf(run, c.plane, one(selectIds(run, c.a), 'dispersion a'));
        const pb = crossingOf(run, c.plane, one(selectIds(run, c.b), 'dispersion b'));
        const eRef = c.eRef || c.b.energy;
        return (coordOf(pb, c) - coordOf(pa, c)) / (100 * (c.b.energy - c.a.energy) / eRef);
    },
    planeCoord(run, c) {
        const ids = selectIds(run, c.select || {});
        const v = ids.map((id) => coordOf(crossingOf(run, c.plane, id), c));
        return v.reduce((s, x) => s + x, 0) / v.length;
    },
    planeSpread(run, c) {
        const ids = selectIds(run, c.select || {});
        const v = ids.map((id) => coordOf(crossingOf(run, c.plane, id), c));
        return Math.max(...v) - Math.min(...v);
    },
    trajectoryMax(run, c) {
        // the largest stored coordinate, corrected to the vertex of the parabola through it and its two neighbors in time
        const pts = trajectory(run, one(selectIds(run, c.select), 'trajectoryMax'));
        const ax = { x: 0, y: 1, z: 2 }[c.coord];
        const n = pts.length / 4;
        let k = 0;
        for (let i = 1; i < n; i++) if (pts[4 * i + ax] > pts[4 * k + ax]) k = i;
        if (k === 0 || k === n - 1) return pts[4 * k + ax];
        const t0 = pts[4 * k + 3];
        const ta = pts[4 * (k - 1) + 3] - t0, tb = pts[4 * (k + 1) + 3] - t0;
        const ya = pts[4 * (k - 1) + ax], y0 = pts[4 * k + ax], yb = pts[4 * (k + 1) + ax];
        // y = y0 + b t + a t² through (ta, ya) and (tb, yb)
        const det = ta * tb * (tb - ta);
        const b = ((ya - y0) * tb * tb - (yb - y0) * ta * ta) / det, a = -((ya - y0) * tb - (yb - y0) * ta) / det;
        return a < 0 ? y0 - b * b / (4 * a) : y0;
    },
    meanTof(run, c) {
        const t = detectedTimes(run, c.plane, c.species);
        const value = t.reduce((s, v) => s + v, 0) / t.length;
        let target = null;
        if (c.reference && c.reference.model === 'reflectron1D') {
            const sp = speciesRef(run.resolved, c.species);
            const s = run.resolved.sources[sp.src].species[sp.sp];
            target = reflectronTof({ massU: s.mass, chargeE: s.charge, ...evalArgs(c.reference.args, run.resolved.paramValues) });
        }
        return { value, target };
    },
    // rms-based widths (2.3548σ), as the app's resolvingPower metric: a half-maximum width follows the bin width on edge-peaked arrivals
    resolvingPower(run, c) {
        return analysis.peakStats(detectedTimes(run, c.plane, c.species)).resolvingPowerRms;
    },
    peakSeparation(run, c) {
        const [a, b] = c.species.map((s) => analysis.peakStats(detectedTimes(run, c.plane, s)));
        return Math.abs(b.mean - a.mean) / (2 * Math.sqrt(2 * Math.LN2) * Math.max(a.std, b.std));
    },
    ringRadius(run, c) { return ringGroups(run, c.plane, c.energy).R; },
    ringRatio(run, c) { return ringGroups(run, c.plane, c.energies[1]).R / ringGroups(run, c.plane, c.energies[0]).R; },
    ringWidth(run, c) { const g = ringGroups(run, c.plane, c.energy); return Math.max(g.up.rms, g.down.rms) / g.R; },
    groupedBlur(run, c) { return groupedBlur(run, c.plane); },
};

/** Metrics that need more than one run, or tracing beyond the project's own particles. */
const COMPOSITE = {
    async lens(ctx, run, c) {
        if (!run._lens) {
            const spec = run.resolved.analysis && run.resolved.analysis.lens;
            if (!spec) throw new Error('the preset has no analysis.lens');
            run._lens = await lensProperties({ ...spec, relativistic: run.resolved.tracer.relativistic !== false }, run.field.model, traceFnFor(run));
        }
        return run._lens[c.key];
    },
    async imageX(ctx, run, c) {
        const s = run.resolved.sources[0], sp = s.species[0];
        const ke = s.energy.type === 'mono' ? s.energy.ke : s.energy.values[0];
        const out = await imageOf({ objectX: c.objectX, mass: sp.mass, charge: sp.charge, ke, angles: c.angles, xEnd: c.xEnd, relativistic: run.resolved.tracer.relativistic !== false }, traceFnFor(run));
        return out.imageX;
    },
    async scanOptimum(ctx, run, c) {
        const sc = c.scan && c.scan[LEVEL];
        if (!sc) return { skipped: `no ${LEVEL}-level scan` };
        const values = [];
        for (let v = sc.from; v <= sc.to + 1e-9 * Math.max(1, Math.abs(sc.to)); v += sc.step) values.push(+v.toFixed(10));
        let best = null, bestV = null;
        const series = [];
        for (const v of values) {
            const r = ctx.runner.run({ params: { [c.param]: v } }, { keep: false, trajectories: false });
            const m = METRICS[c.objective.metric](r, c.objective);
            series.push([v, m]);
            if (Number.isFinite(m) && (best === null || (c.goal === 'max' ? m > best : m < best))) { best = m; bestV = v; }
        }
        ctx.optimum = bestV;
        return { value: bestV, series };
    },
    async blurRatio(ctx, run, c) {
        const other = ctx.runner.run({ params: { [c.param]: c.other } }, { keep: false, trajectories: false });
        return groupedBlur(other, c.plane) / groupedBlur(run, c.plane);
    },
};

/** The optimum a check refers to with at: 'optimum': this run's scan result, else the recorded value. */
function optimumOf(ctx, preset) {
    if (ctx.optimum !== null && ctx.optimum !== undefined) return { param: ctx.optimumParam, value: ctx.optimum };
    const s = preset.expect.find((x) => x.metric === 'scanOptimum');
    if (!s) throw new Error('at: "optimum" without a scanOptimum check');
    const v = s.target !== null && s.target !== undefined ? s.target : s.measured;
    if (v === null || v === undefined) throw new Error('no recorded optimum');
    return { param: s.param, value: v };
}

/** Evaluates one check: { value, target, pass, info, note }. */
async function evaluate(ctx, preset, c) {
    if (c.level && c.level !== LEVEL && !(c.level === 'quick' && LEVEL === 'full')) return { skipped: `${c.level} level only` };
    if (c.metric === 'scanOptimum') ctx.optimumParam = c.param;
    // runs the metric needs
    const runs = [];
    if (c.at === 'optimum') {
        const opt = optimumOf(ctx, preset);
        for (const off of c.offsets || [0]) runs.push({ set: { ...(c.set || {}), params: { ...((c.set && c.set.params) || {}), [opt.param]: +(opt.value + off).toFixed(10) } }, label: `${opt.param} = ${+(opt.value + off).toFixed(6)}` });
    } else runs.push({ set: c.set || null, label: null });
    const values = [];
    let target = c.target !== null && c.target !== undefined ? c.target : (c.measured !== null && c.measured !== undefined && (c.tol !== undefined || c.rel !== undefined) ? c.measured : null);
    let extra = null;
    for (const r of runs) {
        const run = r.set ? ctx.runner.run(r.set) : ctx.runner.base;
        let v;
        if (COMPOSITE[c.metric]) v = await COMPOSITE[c.metric](ctx, run, c);
        else if (METRICS[c.metric]) v = METRICS[c.metric](run, c);
        else throw new Error(`unknown metric "${c.metric}"`);
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            if (v.skipped) return { skipped: v.skipped };
            if (v.series) extra = v.series;
            if (v.target !== undefined && v.target !== null) target = v.target;
            v = v.value;
        }
        values.push(v);
    }
    // several runs (a band around the optimum): keep the worst value against the bounds
    let value = values[0];
    if (values.length > 1) value = c.max !== undefined && c.min === undefined ? Math.max(...values) : Math.min(...values);
    const pass = judge(c, value, target);
    return { value, values: values.length > 1 ? values : undefined, target, pass, info: !!c.info, series: extra };
}

/** True if a value meets the check's target ± max(tol, rel·|target|) and its min/max bounds. */
function judge(c, value, target) {
    const lo = Array.isArray(value) ? value[0] : value, hi = Array.isArray(value) ? value[1] : value;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
    let ok = true, any = false;
    if (target !== null && target !== undefined && (c.tol !== undefined || c.rel !== undefined)) {
        const allowed = Math.max(c.tol || 0, (c.rel || 0) * Math.abs(target));
        ok = ok && Math.abs(lo - target) <= allowed && Math.abs(hi - target) <= allowed;
        any = true;
    }
    if (c.min !== undefined && c.min !== null) { ok = ok && lo >= c.min; any = true; }
    if (c.max !== undefined && c.max !== null) { ok = ok && hi <= c.max; any = true; }
    return any ? ok : true;
}

// ---------------------------------------------------------------- tests
const report = { level: LEVEL, engine: ENGINE_VERSION, date: new Date().toISOString(), presets: [] };
const fmt = (v) => (Array.isArray(v) ? `[${v.map(fmt).join(', ')}]` : typeof v === 'number' ? (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(4) : (+v.toPrecision(7)).toString()) : String(v));

for (const preset of PRESETS) {
    if (ONLY && !ONLY.includes(preset.id)) continue;
    test(`preset ${preset.id}: solves and runs within budget and meets its expectations`, { timeout: LEVEL === 'full' ? 1_200_000 : 300_000 }, async () => {
        const runner = makeRunner(preset);
        const budget = BUDGET_MS[preset.id] || DEFAULT_BUDGET_MS;
        const ctx = { runner, optimum: null, optimumParam: null };
        const row = { id: preset.id, ms: Math.round(runner.baseMs), budgetMs: budget, nodes: runner.base.resolved.domain.N, particles: runner.base.resolved.particleCount, checks: [] };
        const failures = [];
        if (!(runner.baseMs <= budget)) failures.push(`run took ${runner.baseMs.toFixed(0)} ms (budget ${budget} ms)`);
        for (const c of preset.expect) {
            let r;
            try { r = await evaluate(ctx, preset, c); } catch (e) { r = { error: e.message, pass: false }; }
            row.checks.push({ id: c.id, label: c.label, metric: c.metric, unit: c.unit || '', ...r, check: c.check, measured: c.measured });
            if (r.skipped) continue;
            if (!r.pass && !c.info) failures.push(`${c.id}: ${r.error ? 'error ' + r.error : `value ${fmt(r.value)} target ${fmt(r.target)} tol ${fmt(c.tol)} rel ${fmt(c.rel)} min ${fmt(c.min)} max ${fmt(c.max)}`}`);
        }
        report.presets.push(row);
        for (const ck of row.checks) {
            const status = ck.skipped ? 'skip' : ck.error ? 'ERROR' : ck.info ? 'info' : ck.pass ? 'pass' : 'FAIL';
            const drift = !ck.skipped && !ck.error && typeof ck.measured === 'number' && typeof ck.value === 'number' && Math.abs(ck.value - ck.measured) > 1e-6 * Math.max(1, Math.abs(ck.measured)) ? ` (stored ${fmt(ck.measured)})` : '';
            console.log(`  ${preset.id.padEnd(16)} ${ck.id.padEnd(12)} ${status.padEnd(5)} ${ck.skipped ? ck.skipped : ck.error ? ck.error : fmt(ck.value) + (ck.target !== null && ck.target !== undefined ? ' vs ' + fmt(ck.target) : '')} ${ck.unit}${drift}`);
        }
        console.log(`  ${preset.id.padEnd(16)} run          ${runner.baseMs <= budget ? 'pass ' : 'FAIL '} ${runner.baseMs.toFixed(0)} ms (budget ${budget} ms), ${row.nodes} nodes, ${row.particles} particles`);
        assert.deepEqual(failures, [], `${preset.id}: ${failures.join('; ')}`);
    });
}

test.after(() => {
    if (!JSON_OUT) return;
    writeFileSync(JSON_OUT, JSON.stringify(report, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v), 2));
});
