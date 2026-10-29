/* ==========================================================================
   Ion optics engine: analysis.js
   Run summaries and beam statistics on TraceResult rows (specification
   §3.11(4)-(7)).

   - Waist: rays at a field-free plane continue as straight lines, so the rms
     size about the centroid is a quadratic in the axial position and its
     minimum has a closed form (e.g. Wollnik, Optics of Charged Particles,
     Academic Press (1987), ch. 7).
   - Histograms: Freedman & Diaconis, Z. Wahrscheinlichkeitstheorie verw.
     Gebiete 57, 453 (1981) bin width 2·IQR·n^(−1/3); peaks: full width at
     half maximum from linearly interpolated half-maximum crossings of the
     (1, 2, 1)-smoothed histogram (padded by empty bins, re-binned until the
     FWHM spans ≥ 5 bins, then corrected for the bin and smoothing widths),
     peak position and height from a parabola through the same smoothed
     curve; TOF resolving power R = t̄/(2·FWHM) (Wiley & McLaren, Rev. Sci.
     Instrum. 26, 1150 (1955)). Arrival-time peaks with a steep edge have no
     finite half-maximum width (the FWHM shrinks with the bin width), so the
     rms-based R = t̄/(2·2.3548σ) and the narrowest interval holding 76.1% of
     the values (the FWHM fraction of a Gaussian) are reported too; the
     rms-based value is the robust one used for scans and tuning. Whether
     the FWHM is converged is decided over a deterministic bootstrap of the
     values (median change on halving the bin width, 16-84% spread).
   - Beam waist of a run: per (source, species) group, so a dispersive
     device reports the image of each species, not where their lines cross.
   - Emittance and Twiss parameters from centred second moments of (u, u′)
     (Lapostolle, IEEE Trans. Nucl. Sci. 18, 1101 (1971); Courant & Snyder,
     Ann. Phys. 3, 1 (1958)).
   - TOF calibration t = a·√(m/q) + b by linear least squares.
   ========================================================================== */
import {
    S_STRIDE, S_ID, S_STATUS, S_WHERE, S_DE_END, S_PATH, S_WORK, S_SRC, S_SPECIES, S_KE0, S_KE, S_TOF, S_FLAGS, S_TBAND,
    C_STRIDE, C_ID, C_PLANE, C_X, C_Y, C_Z, C_VX, C_VY, C_VZ, C_DIR, C_KIND,
    STATUS, STATUS_NAMES, FLAG,
} from './layout.js';
import { weightedSummary } from './particles.js';

const AXIS = { x: C_X, y: C_Y, z: C_Z };
const VAXIS = { x: C_VX, y: C_VY, z: C_VZ };
const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);

function axisCol(a) {
    const c = AXIS[a];
    if (c === undefined) throw new Error('Unknown axis ' + a);
    return c;
}

/**
 * Counts and diagnostics of a run.
 * @param {object} result TraceResult
 * @param {object} [resolved] resolved project (names of electrodes, planes, sources, species)
 * @returns {{ launched: number, traced: number, byStatus: Object<string, number>,
 *   byElectrode: Array<{ index: number, id: string|null, name: string|null, hit: number, absorbed: number, bornInside: number }>,
 *   byPlane: Array<{ index: number, id: string|null, name: string|null, terminate: boolean, detected: number, crossings: number, particles: number }>,
 *   bySource: Array<{ index: number, id: string|null, name: string|null, launched: number, detected: number, byStatus: Object<string, number> }>,
 *   bySpecies: Array<{ source: number, species: number, label: string|null, mass: number|null, charge: number|null, launched: number, detected: number, transmission: number }>,
 *   transmission: { overall: number, byPlane: Array<{ index: number, id: string|null, name: string|null, detected: number, fraction: number }> },
 *   energy: { maxEnd: number, medianEnd: number, maxEndRel: number, maxPath: number, maxWork: number, warned: number,
 *     warnedHit: number, warnedBand: number, notChecked: null|'plugins'|'time'|'outside' }, weighted: object }}
 * weighted is particles.weightedSummary: Σw launched and detected, the weighted transmission, per plane and per source.
 * energy.maxEndRel is relative to max(KE at the start, KE at the end, |q|·(largest − smallest electrode voltage)); warned counts
 * the flagged particles that did not end on an electrode (warnedHit those that did), warnedBand those among them whose error
 * comes from the field in cells cut by electrodes (time spent there, integrator work error under 1% of the energy error).
 * energy.notChecked says why no particle has an energy error (null when some do): 'plugins' (drag, gas collisions or
 * space charge change the energy), 'time' (time-dependent fields), 'outside' (every particle ended outside the grid).
 */
export function summarize(result, resolved = null) {
    const n = result ? result.n : 0;
    const S = result ? result.summary : new Float64Array(0);
    const C = result ? result.crossings : new Float64Array(0);
    const nc = result ? result.nCross : 0;
    const electrodes = (resolved && resolved.electrodes) || [];
    const planes = (resolved && resolved.recording && resolved.recording.planes) || [];
    const sources = (resolved && resolved.sources) || [];
    const byStatus = {};
    for (const name of STATUS_NAMES) byStatus[name] = 0;
    let maxElec = electrodes.length - 1, maxPlane = planes.length - 1, maxSrc = sources.length - 1;
    for (let i = 0; i < n; i++) {
        const o = i * S_STRIDE, st = S[o + S_STATUS], w = S[o + S_WHERE];
        if (st === STATUS.HIT || st === STATUS.ABSORBED || st === STATUS.BORN_INSIDE) maxElec = Math.max(maxElec, w);
        if (st === STATUS.DETECTED) maxPlane = Math.max(maxPlane, w);
        maxSrc = Math.max(maxSrc, S[o + S_SRC]);
    }
    for (let c = 0; c < nc; c++) { const p = C[c * C_STRIDE + C_PLANE]; if (p > maxPlane) maxPlane = p; }
    const byElectrode = [];
    for (let k = 0; k <= maxElec; k++) {
        const e = electrodes[k] || null;
        byElectrode.push({ index: k, id: e ? e.id ?? null : null, name: e ? e.name ?? null : null, hit: 0, absorbed: 0, bornInside: 0 });
    }
    const byPlane = [];
    for (let k = 0; k <= maxPlane; k++) {
        const p = planes[k] || null;
        byPlane.push({ index: k, id: p ? p.id ?? null : null, name: p ? p.name ?? null : null, terminate: !!(p && p.terminate), detected: 0, crossings: 0, particles: 0 });
    }
    const bySource = [];
    for (let k = 0; k <= maxSrc; k++) {
        const s = sources[k] || null;
        const bs = {}; for (const name of STATUS_NAMES) bs[name] = 0;
        bySource.push({ index: k, id: s ? s.id ?? null : null, name: s ? s.name ?? null : null, launched: 0, detected: 0, byStatus: bs });
    }
    const spMap = new Map();
    let detected = 0, warned = 0, warnedHit = 0, warnedBand = 0;
    // voltage span of the electrodes (dc plus waveform amplitudes): the potential-energy scale of a run
    let vLo = 0, vHi = 0;
    for (const e of electrodes) {
        if (!e) continue;
        const v = Number.isFinite(e.dc) ? e.dc : (Number.isFinite(e.v) ? e.v : 0);
        let sw = 0;
        for (const t of e.terms || []) if (t && Number.isFinite(t.amp)) sw += Math.abs(t.amp); else if (t && t.type === 'table') for (const q of t.points || []) sw = Math.max(sw, Math.abs(q[1]) || 0);
        vLo = Math.min(vLo, v - sw); vHi = Math.max(vHi, v + sw);
    }
    const dEnds = [];
    let maxEnd = 0, maxEndRel = 0, maxPath = 0, maxWork = 0;
    for (let i = 0; i < n; i++) {
        const o = i * S_STRIDE, st = S[o + S_STATUS], w = S[o + S_WHERE], src = S[o + S_SRC], sp = S[o + S_SPECIES];
        const name = STATUS_NAMES[st] || 'FLYING';
        byStatus[name]++;
        if ((st === STATUS.HIT || st === STATUS.ABSORBED || st === STATUS.BORN_INSIDE) && w >= 0) {
            const be = byElectrode[w];
            if (st === STATUS.HIT) be.hit++; else if (st === STATUS.ABSORBED) be.absorbed++; else be.bornInside++;
        }
        if (st === STATUS.DETECTED && w >= 0) { byPlane[w].detected++; detected++; }
        if (src >= 0 && bySource[src]) {
            const bs = bySource[src]; bs.launched++; bs.byStatus[name]++;
            if (st === STATUS.DETECTED) bs.detected++;
        }
        const key = src * 65536 + sp;
        let rec = spMap.get(key);
        if (!rec) {
            const s = sources[src];
            const spec = s && Array.isArray(s.species) ? s.species[sp] : null;
            rec = { source: src, species: sp, label: spec ? spec.label ?? null : null, mass: spec ? spec.mass ?? null : null, charge: spec ? spec.charge ?? null : null, launched: 0, detected: 0, transmission: 0 };
            spMap.set(key, rec);
        }
        rec.launched++;
        if (st === STATUS.DETECTED) rec.detected++;
        const dE = S[o + S_DE_END];
        if (dE === dE) {
            const a = Math.abs(dE);
            dEnds.push(a);
            if (a > maxEnd) maxEnd = a;
            const spec = spMap.get(key);
            const q = spec && Number.isFinite(spec.charge) ? Math.abs(spec.charge) : 1;
            const scale = Math.max(S[o + S_KE0] || 0, S[o + S_KE] || 0, q * (vHi - vLo));
            if (scale > 0 && a / scale > maxEndRel) maxEndRel = a / scale;
        }
        if (S[o + S_PATH] > maxPath) maxPath = S[o + S_PATH];
        if (S[o + S_WORK] > maxWork) maxWork = S[o + S_WORK];
        if ((S[o + S_FLAGS] & FLAG.ENERGY_WARN) !== 0) {
            if (st === STATUS.HIT || st === STATUS.ABSORBED || st === STATUS.BORN_INSIDE) warnedHit++;
            else {
                warned++;
                if (S[o + S_TBAND] > 0 && S[o + S_WORK] < 0.01 * Math.abs(dE)) warnedBand++;
            }
        }
    }
    const seen = new Map();
    for (let c = 0; c < nc; c++) {
        const b = c * C_STRIDE;
        if (C[b + C_KIND] !== 0) continue;
        const p = C[b + C_PLANE];
        if (p < 0 || !byPlane[p]) continue;
        byPlane[p].crossings++;
        const key = p + ':' + C[b + C_ID];
        if (!seen.has(key)) { seen.set(key, 1); byPlane[p].particles++; }
    }
    dEnds.sort((a, b) => a - b);
    const medianEnd = dEnds.length ? (dEnds.length % 2 ? dEnds[(dEnds.length - 1) / 2] : 0.5 * (dEnds[dEnds.length / 2 - 1] + dEnds[dEnds.length / 2])) : NaN;
    let notChecked = null;
    if (!dEnds.length && n > 0) {
        const tr = (resolved && resolved.tracer) || {};
        const gasOn = !!(tr.gas && tr.gas.enabled !== false && tr.gas.pressure > 0);
        let td = false;
        for (let i = 0; i < n && !td; i++) if ((S[i * S_STRIDE + S_FLAGS] & FLAG.TD_FIELDS) !== 0) td = true;
        notChecked = tr.spaceCharge || tr.drag || gasOn ? 'plugins' : (td ? 'time' : 'outside');
    }
    const bySpecies = [...spMap.values()].sort((a, b) => a.source - b.source || a.species - b.species);
    for (const r of bySpecies) r.transmission = r.launched > 0 ? r.detected / r.launched : 0;
    const traced = n - byStatus.CANCELLED;
    return {
        launched: n, traced, byStatus, byElectrode, byPlane, bySource, bySpecies,
        transmission: {
            overall: n > 0 ? detected / n : 0,
            byPlane: byPlane.filter((p) => p.terminate || p.detected > 0).map((p) => ({ index: p.index, id: p.id, name: p.name, detected: p.detected, fraction: n > 0 ? p.detected / n : 0 })),
        },
        energy: { maxEnd: dEnds.length ? maxEnd : NaN, medianEnd, maxEndRel: dEnds.length ? maxEndRel : NaN, maxPath, maxWork, warned, warnedHit, warnedBand, notChecked },

        // the counts above with every particle carrying its source's statistical weight (1 by default)
        weighted: weightedSummary(result, resolved),
    };
}

/**
 * Crossing rows of one plane (planeIndex ≥ 0) or of the meshes (planeIndex = −1), copied into a compact array.
 * filter: function (rows, offset) → boolean, or { source?, species?, status?, ids? } matched through the summary rows.
 * @param {object} result @param {number} planeIndex
 * @param {{ side?: 'both'|'forward'|'backward', filter?: ((rows: Float64Array, offset: number) => boolean)|object }} [opts]
 * @returns {Float64Array} C_STRIDE rows
 */
export function planeRows(result, planeIndex, { side = 'both', filter = null } = {}) {
    const C = result.crossings, nc = result.nCross;
    const out = [];
    let byId = null;
    const needSummary = filter && typeof filter === 'object' && (filter.source !== undefined || filter.species !== undefined || filter.status !== undefined);
    if (needSummary) {
        byId = new Map();
        for (let i = 0; i < result.n; i++) byId.set(result.summary[i * S_STRIDE + S_ID], i * S_STRIDE);
    }
    const wantKind = planeIndex < 0 ? 1 : 0;
    for (let c = 0; c < nc; c++) {
        const b = c * C_STRIDE;
        if (C[b + C_KIND] !== wantKind) continue;
        if (wantKind === 0 && C[b + C_PLANE] !== planeIndex) continue;
        if (side === 'forward' && !(C[b + C_DIR] > 0)) continue;
        if (side === 'backward' && !(C[b + C_DIR] < 0)) continue;
        if (typeof filter === 'function') { if (!filter(C, b)) continue; }
        else if (filter && typeof filter === 'object') {
            if (filter.ids && !filter.ids.has(C[b + C_ID])) continue;
            if (byId) {
                const so = byId.get(C[b + C_ID]);
                if (so === undefined) continue;
                const S = result.summary;
                if (filter.source !== undefined && S[so + S_SRC] !== filter.source) continue;
                if (filter.species !== undefined && S[so + S_SPECIES] !== filter.species) continue;
                if (filter.status !== undefined && S[so + S_STATUS] !== filter.status) continue;
            }
        }
        out.push(b);
    }
    const res = new Float64Array(out.length * C_STRIDE);
    for (let i = 0; i < out.length; i++) res.set(C.subarray(out[i], out[i] + C_STRIDE), i * C_STRIDE);
    return res;
}

/**
 * Centroid and rms of two coordinates of crossing rows.
 * @param {Float64Array} rows C_STRIDE rows @param {string[]} [axes] two of 'x', 'y', 'z'
 * @returns {{ n: number, cu: number, cv: number, rmsU: number, rmsV: number, rms: number, minU: number, maxU: number, minV: number, maxV: number }}
 */
export function spotStats(rows, axes = ['y', 'z']) {
    const cu = axisCol(axes[0]), cv = axisCol(axes[1] || 'z');
    const n = Math.floor(rows.length / C_STRIDE);
    if (n === 0) return { n: 0, cu: NaN, cv: NaN, rmsU: NaN, rmsV: NaN, rms: NaN, minU: NaN, maxU: NaN, minV: NaN, maxV: NaN };
    let su = 0, sv = 0, minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < n; i++) {
        const u = rows[i * C_STRIDE + cu], v = rows[i * C_STRIDE + cv];
        su += u; sv += v;
        if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const mu = su / n, mv = sv / n;
    let qu = 0, qv = 0;
    for (let i = 0; i < n; i++) { const du = rows[i * C_STRIDE + cu] - mu, dv = rows[i * C_STRIDE + cv] - mv; qu += du * du; qv += dv * dv; }
    const rmsU = Math.sqrt(qu / n), rmsV = Math.sqrt(qv / n);
    return { n, cu: mu, cv: mv, rmsU, rmsV, rms: Math.sqrt((qu + qv) / n), minU, maxU, minV, maxV };
}

/**
 * Beam waist from rows at a field-free plane: straight-line continuation of every ray along `axis`
 * (the beam direction); the rms radius about the centroid in the two transverse coordinates is
 * quadratic in the axial position, with its minimum in closed form.
 * @param {Float64Array} rows @param {'x'|'y'|'z'} [axis]
 * @returns {{ n: number, position: number, rms: number, rmsAtPlane: number, planePosition: number }}
 */
export function waist(rows, axis = 'x') {
    const ca = axisCol(axis), va = VAXIS[axis];
    const tr = ['x', 'y', 'z'].filter((a) => a !== axis);
    const c1 = AXIS[tr[0]], c2 = AXIS[tr[1]], v1 = VAXIS[tr[0]], v2 = VAXIS[tr[1]];
    const n = Math.floor(rows.length / C_STRIDE);
    if (n === 0) return { n: 0, position: NaN, rms: NaN, rmsAtPlane: NaN, planePosition: NaN };
    let xp = 0;
    for (let i = 0; i < n; i++) xp += rows[i * C_STRIDE + ca];
    xp /= n;
    const U = new Float64Array(n), V = new Float64Array(n), Up = new Float64Array(n), Vp = new Float64Array(n);
    let mu = 0, mv = 0, mup = 0, mvp = 0, used = 0;
    for (let i = 0; i < n; i++) {
        const b = i * C_STRIDE, vax = rows[b + va];
        if (!(vax !== 0)) continue;
        const up = rows[b + v1] / vax, vp = rows[b + v2] / vax, d = xp - rows[b + ca];
        U[used] = rows[b + c1] + up * d; V[used] = rows[b + c2] + vp * d; Up[used] = up; Vp[used] = vp;
        mu += U[used]; mv += V[used]; mup += up; mvp += vp; used++;
    }
    if (used === 0) return { n: 0, position: NaN, rms: NaN, rmsAtPlane: NaN, planePosition: xp };
    mu /= used; mv /= used; mup /= used; mvp /= used;
    let A = 0, B = 0, Cq = 0;
    for (let i = 0; i < used; i++) {
        const du = U[i] - mu, dv = V[i] - mv, dup = Up[i] - mup, dvp = Vp[i] - mvp;
        A += du * du + dv * dv; B += du * dup + dv * dvp; Cq += dup * dup + dvp * dvp;
    }
    A /= used; B /= used; Cq /= used;
    let s = 0, r2 = A;
    if (Cq > 0) { s = -B / Cq; r2 = A - B * B / Cq; }
    return { n: used, position: xp + s, rms: Math.sqrt(Math.max(0, r2)), rmsAtPlane: Math.sqrt(A), planePosition: xp };
}

/**
 * The beam waist to report for a run (§3.11(4); one rule for the Summary card and the canvas label), or null.
 * Plane: the project's analysis.waist.plane, else the first terminating x, y or z plane. The rays are grouped by
 * (source, species) and the waist is found per group, because a dispersive device (a mass spectrometer) images each
 * species in its own spot: the pooled rms would be dominated by the spot separation and its minimum would land where
 * the species lines happen to cross. The reported position is the particle-weighted mean of the group waists and the
 * rms is the within-group rms there; `groups` lists each group with its centroid at the plane. When groups of different
 * species land in separate spots (centroid distance at the plane larger than the largest within-group rms, at the plane
 * or at the waist, of the pair), the beam is dispersed and no single waist is reported (`dispersed`, ok false): the
 * per-group waists in `groups` are then the images of the species. The waist is reported only when it is meaningful:
 * rays continue as straight lines from the plane, so the straight path from the plane back (or on) to every group's
 * waist must be field-free (|E| ≤ 1e-4 of the largest electrode voltage per cell, sampled along the group centroid at
 * t = 0 and, for time-dependent fields, a quarter period later; no magnetic field there either); every group waist must
 * lie inside the domain or in a drift region beyond it; and the within-group rms size must change by more than 1%
 * between the plane and the waist (else the beam is parallel).
 * @param {object} result TraceResult @param {object} resolved @param {object|null} [model] FieldModel for the field test
 * @returns {null|{ plane: number, id: string|null, name: string, axis: 'x'|'y'|'z', position: number, rms: number, rmsAtPlane: number,
 *   spread: number, dispersed: boolean, groups: { label: string, species: string, n: number, position: number, rms: number, rmsAtPlane: number, centroid: number[] }[],
 *   ok: boolean, reason: string|null }}
 *   ok false with a reason when a waist was found but is not meaningful (or the beam is dispersed); `spread` = largest − smallest
 *   group position (0 for one group); `centroid` = the group's mean transverse position at the plane (the two coordinates other than the axis)
 */
export function beamWaist(result, resolved, model = null) {
    if (!result || !resolved || !(result.nCross > 0)) return null;
    const planes = (resolved.recording && resolved.recording.planes) || [];
    const axial = (p) => p && (p.kind === 'x' || p.kind === 'y' || p.kind === 'z');
    let k = -1;
    const want = resolved.analysis && resolved.analysis.waist && resolved.analysis.waist.plane;
    if (want) k = planes.findIndex((p) => p.id === want);
    if (k < 0) k = planes.findIndex((p) => axial(p) && p.terminate);
    if (k < 0 || !axial(planes[k])) return null;
    const plane = planes[k], axis = plane.kind;
    const all = planeRows(result, k, { side: plane.side || 'both' });
    // first crossing per particle
    const seen = new Set(), keep = [];
    for (let i = 0; i * C_STRIDE < all.length; i++) { const id = all[i * C_STRIDE + C_ID]; if (!seen.has(id)) { seen.add(id); keep.push(i); } }
    if (keep.length < 3) return null;
    // group by (source, species) through the summary rows
    const S = result.summary, byId = new Map();
    if (ArrayBuffer.isView(S)) for (let i = 0; i < result.n; i++) byId.set(S[i * S_STRIDE + S_ID], i * S_STRIDE);
    const sources = resolved.sources || [];
    const groups = new Map();
    for (const i of keep) {
        const o = byId.get(all[i * C_STRIDE + C_ID]);
        const src = o === undefined ? 0 : S[o + S_SRC], sp = o === undefined ? 0 : S[o + S_SPECIES];
        const key = `${src}:${sp}`;
        let g = groups.get(key);
        if (!g) {
            const s = sources[src], spec = s && s.species ? s.species[sp] : null;
            const label = (spec && spec.label) || (spec ? `${spec.mass} u` : `species ${sp}`);
            // the same ion from two sources is one species; different ions are what a mass spectrometer disperses
            const species = spec && Number.isFinite(spec.mass) ? `${spec.mass}/${spec.charge}` : `s${src}:${sp}`;
            g = { label: sources.length > 1 && s ? `${s.name || s.id}: ${label}` : label, species, idx: [] };
            groups.set(key, g);
        }
        g.idx.push(i);
    }
    const out = { plane: k, id: plane.id ?? null, name: plane.name || plane.id || `plane ${k}`, axis, position: NaN, rms: NaN, rmsAtPlane: NaN, spread: 0, dispersed: false, groups: [], ok: true, reason: null };
    const fail = (reason) => { out.ok = false; out.reason = reason; return out; };
    const d = resolved.domain || {}, ai = { x: 0, y: 1, z: 2 }[axis];
    const COLS = [C_X, C_Y, C_Z], tcols = [0, 1, 2].filter((a) => a !== ai);
    const box = model && model.box ? [[model.box.xmin, model.box.xmax], [model.box.ymin, model.box.ymax], [model.box.zmin, model.box.zmax]][ai] : null;
    const e4 = new Float64Array(4), b3 = new Float64Array(3);
    const thr = model ? 1e-4 * Math.max(model.vSpan > 0 ? model.vSpan : 0, 1e-12) / (model.h > 0 ? model.h : 1) : 0;
    const times = model && model.timeDependent && model.minPeriod < Infinity ? [0, 0.25 * model.minPeriod] : [0];
    let nTot = 0, posSum = 0, r2Sum = 0, a2Sum = 0, posMin = Infinity, posMax = -Infinity;
    for (const g of groups.values()) {
        if (g.idx.length < 2) continue;   // one ray has no waist
        const rows = new Float64Array(g.idx.length * C_STRIDE);
        g.idx.forEach((i, j) => rows.set(all.subarray(i * C_STRIDE, (i + 1) * C_STRIDE), j * C_STRIDE));
        const w = waist(rows, axis);
        if (!(Number.isFinite(w.position) && Number.isFinite(w.rms)) || w.n < 2) continue;
        // the group's centroid at the plane: the transverse pair is its spot, the axial coordinate the plane itself
        const n = g.idx.length, p = [0, 0, 0];
        for (let j = 0; j < n; j++) for (let a = 0; a < 3; a++) p[a] += rows[j * C_STRIDE + COLS[a]] / n;
        out.groups.push({ label: g.label, species: g.species, n: w.n, position: w.position, rms: w.rms, rmsAtPlane: w.rmsAtPlane, centroid: tcols.map((a) => p[a]) });
        nTot += w.n; posSum += w.n * w.position; r2Sum += w.n * w.rms * w.rms; a2Sum += w.n * w.rmsAtPlane * w.rmsAtPlane;
        posMin = Math.min(posMin, w.position); posMax = Math.max(posMax, w.position);
        // inside the domain, or beyond an edge where particles drift
        if (out.ok && box && (axis === 'x' || (axis === 'y' && d.type === 'planar2d'))) {
            const beyond = d.beyond || {}, lo = axis === 'x' ? 'xmin' : 'ymin', hi = axis === 'x' ? 'xmax' : 'ymax';
            if ((w.position < box[0] && beyond[lo] !== 'drift') || (w.position > box[1] && beyond[hi] !== 'drift')) fail('outside the domain');
        }
        // field-free straight path between the plane and this group's waist, along the group centroid
        if (out.ok && model && typeof model.E === 'function') {
            for (let m = 0; m <= 24 && out.ok; m++) {
                p[ai] = w.planePosition + (w.position - w.planePosition) * m / 24;
                for (const t of times) {
                    model.E(t, p[0], p[1], p[2], e4);
                    if (Math.hypot(e4[0], e4[1], e4[2]) > thr) { fail('the rays pass through a field between the plane and the waist'); break; }
                }
                if (out.ok && model.hasB && typeof model.B === 'function') {
                    model.B(p[0], p[1], p[2], b3);
                    if (Math.hypot(b3[0], b3[1], b3[2]) > 1e-12) fail('the rays pass through a magnetic field between the plane and the waist');
                }
            }
        }
    }
    if (!out.groups.length || nTot < 3) return null;
    out.position = posSum / nTot; out.rms = Math.sqrt(r2Sum / nTot); out.rmsAtPlane = Math.sqrt(a2Sum / nTot); out.spread = posMax - posMin;
    // dispersed beam: two species land in separate spots (centroids further apart than the larger of their within-group rms)
    const G = out.groups;
    for (let a = 0; a < G.length && !out.dispersed; a++) for (let b = a + 1; b < G.length; b++) {
        if (G[a].species === G[b].species) continue;
        const dist = Math.hypot(G[a].centroid[0] - G[b].centroid[0], G[a].centroid[1] - G[b].centroid[1]);
        if (dist > Math.max(G[a].rmsAtPlane, G[b].rmsAtPlane, G[a].rms, G[b].rms, 1e-9)) { out.dispersed = true; break; }
    }
    if (out.ok && out.dispersed) fail('the beam is dispersed into separate species spots, so there is no single waist; each species is imaged on its own');
    if (!out.ok) return out;
    if (!(out.rmsAtPlane > 0) || Math.abs(out.rmsAtPlane - out.rms) <= 0.01 * out.rmsAtPlane) return fail('parallel beam: the rms size hardly changes');
    return out;
}

/**
 * Rms emittance and Twiss parameters of (u, u′), u′ = v_u/v_axis in mrad.
 * @param {Float64Array} rows @param {'x'|'y'|'z'} coord transverse coordinate u @param {'x'|'y'|'z'} [axis] beam direction
 * @returns {{ n: number, epsRms: number, alpha: number, beta: number, gamma: number, meanU: number, meanUp: number }}
 */
export function emittance(rows, coord, axis = coord === 'x' ? 'y' : 'x') {
    const cu = axisCol(coord), vu = VAXIS[coord], va = VAXIS[axis];
    const n = Math.floor(rows.length / C_STRIDE);
    let m = 0, su = 0, sp = 0;
    for (let i = 0; i < n; i++) { const b = i * C_STRIDE; if (rows[b + va] !== 0) { su += rows[b + cu]; sp += 1000 * rows[b + vu] / rows[b + va]; m++; } }
    if (m === 0) return { n: 0, epsRms: NaN, alpha: NaN, beta: NaN, gamma: NaN, meanU: NaN, meanUp: NaN };
    const mu = su / m, mp = sp / m;
    let uu = 0, pp = 0, up = 0;
    for (let i = 0; i < n; i++) {
        const b = i * C_STRIDE;
        if (rows[b + va] === 0) continue;
        const du = rows[b + cu] - mu, dp = 1000 * rows[b + vu] / rows[b + va] - mp;
        uu += du * du; pp += dp * dp; up += du * dp;
    }
    uu /= m; pp /= m; up /= m;
    const eps = Math.sqrt(Math.max(0, uu * pp - up * up));
    return { n: m, epsRms: eps, alpha: eps > 0 ? -up / eps : NaN, beta: eps > 0 ? uu / eps : NaN, gamma: eps > 0 ? pp / eps : NaN, meanU: mu, meanUp: mp };
}

function finiteValues(values) {
    const out = [];
    for (let i = 0; i < values.length; i++) { const v = values[i]; if (typeof v === 'number' && Number.isFinite(v)) out.push(v); }
    return out;
}

function quantileSorted(s, q) {
    if (s.length === 0) return NaN;
    const pos = (s.length - 1) * q, i = Math.floor(pos), f = pos - i;
    return i + 1 < s.length ? s[i] + f * (s[i + 1] - s[i]) : s[i];
}

/** Number of Freedman-Diaconis bins (at least `minBins`) for sorted finite values over [lo, hi]. */
function fdBins(sorted, lo, hi, minBins = 10) {
    const n = sorted.length;
    const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
    let nb;
    if (iqr > 0 && hi > lo) nb = Math.ceil((hi - lo) / (2 * iqr * Math.pow(n, -1 / 3)));
    else nb = Math.ceil(Math.log2(Math.max(1, n))) + 1;
    return Math.max(minBins, Math.min(10000, nb));
}

/**
 * Histogram of finite values. bins: 'auto' (Freedman-Diaconis, ≥ 10 bins) or a count.
 * @param {ArrayLike<number>} values
 * @param {{ bins?: 'auto'|number, min?: number, max?: number, weights?: ArrayLike<number> }} [opts]
 * @returns {{ edges: Float64Array, counts: Float64Array }}
 */
export function histogram(values, { bins = 'auto', min, max, weights } = {}) {
    const vals = [], wts = [];
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (typeof v === 'number' && Number.isFinite(v)) { vals.push(v); wts.push(weights ? +weights[i] : 1); }
    }
    let lo = typeof min === 'number' && Number.isFinite(min) ? min : Infinity;
    let hi = typeof max === 'number' && Number.isFinite(max) ? max : -Infinity;
    if (lo === Infinity) for (const v of vals) if (v < lo) lo = v;
    if (hi === -Infinity) for (const v of vals) if (v > hi) hi = v;
    if (!(lo < Infinity)) { lo = 0; hi = 1; }
    if (!(hi > lo)) { const d = Math.abs(lo) > 0 ? Math.abs(lo) * 1e-9 : 0.5; lo -= d; hi += d; }
    let nb;
    if (typeof bins === 'number' && bins >= 1) nb = Math.floor(bins);
    else {
        const inside = vals.filter((v) => v >= lo && v <= hi).sort((a, b) => a - b);
        nb = fdBins(inside, lo, hi, 10);
    }
    const edges = new Float64Array(nb + 1), counts = new Float64Array(nb);
    for (let k = 0; k <= nb; k++) edges[k] = lo + (hi - lo) * k / nb;
    const scale = nb / (hi - lo);
    for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        if (v < lo || v > hi) continue;
        let k = Math.floor((v - lo) * scale);
        if (k >= nb) k = nb - 1; else if (k < 0) k = 0;
        counts[k] += wts[i];
    }
    return { edges, counts };
}

/** Width of the narrowest interval holding a fraction `frac` of the sorted values (at least two values). */
export function shortestInterval(sorted, frac = 0.761) {
    const n = sorted.length;
    if (n < 2) return NaN;
    const k = Math.min(n - 1, Math.max(1, Math.ceil(frac * n) - 1));
    let best = Infinity;
    for (let i = 0; i + k < n; i++) { const d = sorted[i + k] - sorted[i]; if (d < best) best = d; }
    return best;
}

/** Half-maximum width of sorted values histogrammed with nb bins over [lo, hi], padded by two empty bins on each side. */
function halfMaxWidth(sorted, lo, hi, nb) {
    const w = (hi - lo) / nb, pad = 2, nt = nb + 2 * pad, x0 = lo - pad * w;
    const counts = new Float64Array(nt);
    for (const v of sorted) { let k = Math.floor((v - lo) / w); if (k >= nb) k = nb - 1; else if (k < 0) k = 0; counts[k + pad]++; }
    // binomial (1, 2, 1)/4 smoothing; the peak height, its position and both half-maximum crossings all come from this one curve
    const sm = new Float64Array(nt);
    for (let k = 1; k < nt - 1; k++) sm[k] = 0.25 * (counts[k - 1] + 2 * counts[k] + counts[k + 1]);
    let kMax = 1;
    for (let k = 2; k < nt - 1; k++) if (sm[k] > sm[kMax]) kMax = k;
    const centre = (k) => x0 + (k + 0.5) * w;
    let tPeak = centre(kMax), hMax = sm[kMax];
    const a = sm[kMax - 1], b = sm[kMax], c = sm[kMax + 1], den = a - 2 * b + c;
    if (den < 0) { const xv = 0.5 * (a - c) / den; if (Math.abs(xv) <= 0.5) { tPeak = centre(kMax) + xv * w; hMax = b - 0.25 * (a - c) * xv; } }
    const half = 0.5 * hMax;
    let kl = kMax;
    while (sm[kl - 1] >= half) kl--;   // sm[0] = 0 < half, so the loop ends
    const left = centre(kl - 1) + (half - sm[kl - 1]) / (sm[kl] - sm[kl - 1]) * w;
    let kr = kMax;
    while (sm[kr + 1] >= half) kr++;
    const right = centre(kr) + (sm[kr] - half) / (sm[kr] - sm[kr + 1]) * w;
    return { fwhm: right - left, w, tPeak };
}

/** The histogram (variance w²/12) and the (1, 2, 1)/4 smoothing (w²/2) widen a resolved peak: removed in quadrature once it spans ≥ 5 bins. */
function correctedFwhm(x) { return x.fwhm >= 5 * x.w ? Math.sqrt(Math.max(0, x.fwhm * x.fwhm - 8 * Math.LN2 * (7 / 12) * x.w * x.w)) : x.fwhm; }

/**
 * Deterministic bootstrap of the half-maximum width (`reps` resamples of the values, xorshift seeded by n and nb):
 * the median of FWHM(2nb)/FWHM(nb) (both bin-corrected) and the 16–84% spread of FWHM(nb) relative to its median.
 * A single histogram at ≈ 5 values per bin is too noisy to tell a converged width from one that follows the bin width;
 * the medians over the resamples are not.
 */
function bootstrapHalfMax(values, lo, hi, nb, reps) {
    const n = values.length;
    let seed = (0x9e3779b9 ^ n ^ Math.imul(nb, 0x85ebca6b)) >>> 0;
    if (seed === 0) seed = 0x2545f491;
    const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
    const buf = new Float64Array(n), widths = [], ratios = [];
    for (let r = 0; r < reps; r++) {
        for (let i = 0; i < n; i++) buf[i] = values[Math.floor(rnd() * n)];
        const a = correctedFwhm(halfMaxWidth(buf, lo, hi, nb)), b = correctedFwhm(halfMaxWidth(buf, lo, hi, 2 * nb));
        if (a > 0 && Number.isFinite(a) && Number.isFinite(b)) { widths.push(a); ratios.push(b / a); }
    }
    if (widths.length < 8) return { ratio: NaN, spread: NaN };
    widths.sort((p, q) => p - q); ratios.sort((p, q) => p - q);
    const med = widths[Math.floor(0.5 * (widths.length - 1))];
    const spread = (widths[Math.ceil(0.84 * (widths.length - 1))] - widths[Math.floor(0.16 * (widths.length - 1))]) / med;
    return { ratio: ratios[Math.floor(0.5 * (ratios.length - 1))], spread };
}

/**
 * Peak statistics of a set of times (or any values): mean, std, FWHM, peak position and resolving power t̄/(2·FWHM),
 * plus the robust widths: the rms-based FWHM equivalent 2.3548σ with R = t̄/(2·2.3548σ) (resolvingPowerRms), and the
 * narrowest interval holding 76.1% of the values (w76, the FWHM of a Gaussian) with R = t̄/(2·w76) (resolvingPower76).
 * The half-maximum width comes from a histogram padded by empty bins (so both crossings exist) and re-binned (keeping
 * ≥ 5 values per bin on average) until it spans ≥ 5 bins; it is then corrected in quadrature for the bin and smoothing
 * widths. It counts as resolved (`fwhmResolved`) when it spans ≥ 4 bins and, over a deterministic bootstrap of 50
 * resamples of the values (20 above 50,000 values), halving the bin width changes its median by < 25% and its 16–84%
 * spread is < 30% of its median (a single histogram at ≈ 5 values per bin is too noisy for that decision); otherwise
 * (a peak with a steep edge, whose half-maximum width shrinks with the bin width, or too few values) the note says so.
 * Measured on 200 seeds per size: a peak with density ∝ 1/√(t − t₀) (no finite half-maximum width) is marked resolved
 * in 0 of 200 cases at n = 100–4000 (its width spans fewer than 4 bins), Gaussians in 96–100% at n ≥ 250 and 38% at
 * n = 100. Crossings on the unsmoothed counts were tried and rejected: at ≈ 5 values per bin they halve the Gaussian
 * resolve rate at n = 250 and leave the cusp bias in place, so a resolved peak that is much narrower than its
 * narrowest-76% width (FWHM < 0.75·w76: a cusp or long tails) carries the caveat instead: the FWHM of a sharply
 * peaked (cusp-shaped) distribution from the smoothed histogram is biased high by up to about a quarter (the smoothing
 * broadens a cusp by more than the Gaussian-equivalent width that is removed), so the rms-based and 76% values are the
 * ones to compare. A resolved width spanning 4–5 bins is uncorrected and noted (about a tenth high).
 * Below 30 values the FWHM is 2.3548σ (noted).
 * @param {ArrayLike<number>} values
 * @returns {{ n: number, mean: number, std: number, fwhm: number, tPeak: number, resolvingPower: number, resolvingPowerRms: number,
 *   w76: number, resolvingPower76: number, binWidth: number, fwhmBins: number, fwhmResolved: boolean, cuspLike: boolean, fwhmRatio: number,
 *   fwhmSpread: number, note: string|null }}
 *   fwhmBins: bins spanned by the (uncorrected) half-maximum width; cuspLike: FWHM < 0.75·w76; fwhmRatio: median
 *   FWHM(2× bins)/FWHM over the bootstrap; fwhmSpread: its 16–84% relative spread (NaN below 30 values)
 */
export function peakStats(values) {
    const v = finiteValues(values);
    const n = v.length;
    if (n === 0) return { n: 0, mean: NaN, std: NaN, fwhm: NaN, tPeak: NaN, resolvingPower: NaN, resolvingPowerRms: NaN, w76: NaN, resolvingPower76: NaN, binWidth: NaN, fwhmBins: NaN, fwhmResolved: false, cuspLike: false, fwhmRatio: NaN, fwhmSpread: NaN, note: 'no values' };
    let s = 0;
    for (const x of v) s += x;
    const mean = s / n;
    let q = 0;
    for (const x of v) q += (x - mean) * (x - mean);
    const std = Math.sqrt(q / n);
    const rPow = (width) => (width > 0 ? mean / (2 * width) : Infinity);
    const resolvingPowerRms = rPow(FWHM_PER_SIGMA * std);
    v.sort((a, b) => a - b);
    const w76 = shortestInterval(v, 0.761);
    if (n < 30 || !(std > 0)) {
        const fwhm = FWHM_PER_SIGMA * std;
        return { n, mean, std, fwhm, tPeak: mean, resolvingPower: rPow(fwhm), resolvingPowerRms, w76, resolvingPower76: rPow(w76), binWidth: NaN, fwhmBins: NaN, fwhmResolved: false,
            cuspLike: false, fwhmRatio: NaN, fwhmSpread: NaN, note: n < 30 ? 'FWHM = 2.3548 sigma (fewer than 30 values)' : null };
    }
    const lo = v[0], hi = v[n - 1];
    let nb = fdBins(v, lo, hi, 10);
    const maxBins = Math.max(nb, Math.floor(n / 5));
    let r = halfMaxWidth(v, lo, hi, nb);
    // re-bin until the FWHM spans ≥ 5 bins (keeping ≥ 5 values per bin on average)
    for (let it = 0; it < 6 && r.fwhm < 5 * r.w && nb < maxBins; it++) {
        nb = Math.min(maxBins, Math.max(nb + 1, Math.ceil(nb * Math.min(8, 6 * r.w / Math.max(r.fwhm, 1e-300)))));
        r = halfMaxWidth(v, lo, hi, nb);
    }
    const fwhm = correctedFwhm(r);
    // convergence test: a true half-maximum width does not follow the bin width, and a converged one is statistically stable
    const bs = bootstrapHalfMax(v, lo, hi, nb, n > 50000 ? 20 : 50);
    const fwhmBins = r.fwhm / r.w;
    // every false positive of the 1/√ edge peak spans fewer than 4 bins; Gaussians of ≥ 250 values span ≥ 5
    const fwhmResolved = fwhmBins >= 4 && Math.abs(bs.ratio - 1) < 0.25 && bs.spread < 0.30;
    const cuspLike = fwhmResolved && w76 > 0 && fwhm < 0.75 * w76;
    let note = null;
    if (!fwhmResolved) {
        note = fwhmBins < 4 ? 'the half-maximum width spans fewer than 4 histogram bins (a peak with a steep edge), so R from the FWHM is not reliable; use the rms-based R'
            : (bs.spread >= 0.25 && Math.abs(bs.ratio - 1) < 0.25) ? 'the half-maximum width is statistically unstable with this number of values, so R from the FWHM is not reliable; use the rms-based R'
                : 'the half-maximum width follows the histogram bin width (a peak with a steep edge), so R from the FWHM is not reliable; use the rms-based R';
    } else {
        const caveats = [];
        if (cuspLike) caveats.push('the peak is much narrower than its narrowest-76% width (a cusp-shaped or long-tailed peak): the FWHM from the smoothed histogram is biased high by up to about a quarter, so R (FWHM) reads low; compare R (rms) and R (narrowest 76%)');
        if (fwhmBins < 5) caveats.push('the half-maximum width spans fewer than 5 bins, so it is not corrected for the bin width and reads about a tenth high');
        if (caveats.length) note = caveats.join('; ');
    }
    return { n, mean, std, fwhm, tPeak: r.tPeak, resolvingPower: rPow(fwhm), resolvingPowerRms, w76, resolvingPower76: rPow(w76), binWidth: r.w, fwhmBins, fwhmResolved, cuspLike, fwhmRatio: bs.ratio, fwhmSpread: bs.spread, note };
}

/**
 * Groups rows by key. keyFn(rows, offset) → key (any Map key).
 * @param {Float64Array} rows @param {(rows: Float64Array, offset: number) => any} keyFn @param {number} [stride] row stride (default C_STRIDE)
 * @returns {Map<any, Float64Array>} rows per key, in first-seen key order
 */
export function groupBy(rows, keyFn, stride = C_STRIDE) {
    const n = Math.floor(rows.length / stride);
    const idx = new Map();
    for (let i = 0; i < n; i++) {
        const k = keyFn(rows, i * stride);
        let a = idx.get(k);
        if (!a) { a = []; idx.set(k, a); }
        a.push(i);
    }
    const out = new Map();
    for (const [k, list] of idx) {
        const g = new Float64Array(list.length * stride);
        for (let j = 0; j < list.length; j++) g.set(rows.subarray(list[j] * stride, list[j] * stride + stride), j * stride);
        out.set(k, g);
    }
    return out;
}

/**
 * Centroid and rms radius about the centroid per group of crossing rows (VMI image quality).
 * @param {Float64Array} rows @param {(rows: Float64Array, offset: number) => any} keyFn @param {string[]} [axes] the plane's (a, b) coordinates
 * @returns {Array<{ key: any, n: number, cu: number, cv: number, rms: number }>} sorted by key
 */
export function groupedSpots(rows, keyFn, axes = ['y', 'z']) {
    const groups = groupBy(rows, keyFn);
    const out = [];
    for (const [key, g] of groups) {
        const s = spotStats(g, axes);
        out.push({ key, n: s.n, cu: s.cu, cv: s.cv, rms: s.rms });
    }
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
}

/**
 * Grouped blur: √(mean of the squared group rms) (§3.11(6)).
 * @param {Array<{ rms: number }>} spots @returns {number}
 */
export function groupedBlur(spots) {
    let s = 0, m = 0;
    for (const g of spots) if (g.rms === g.rms) { s += g.rms * g.rms; m++; }
    return m > 0 ? Math.sqrt(s / m) : NaN;
}

/**
 * TOF calibration t = a·√(m/q) + b by least squares.
 * @param {Array<{ mq: number, t: number }|[number, number]>} pairs
 * @returns {{ a: number, b: number, r2: number, n: number }}
 */
export function tofCalibration(pairs) {
    const X = [], T = [];
    for (const p of pairs || []) {
        const mq = Array.isArray(p) ? p[0] : p.mq, t = Array.isArray(p) ? p[1] : p.t;
        if (mq > 0 && Number.isFinite(t)) { X.push(Math.sqrt(mq)); T.push(t); }
    }
    const n = X.length;
    if (n < 2) return { a: NaN, b: NaN, r2: NaN, n };
    let sx = 0, st = 0;
    for (let i = 0; i < n; i++) { sx += X[i]; st += T[i]; }
    const mx = sx / n, mt = st / n;
    let sxx = 0, sxt = 0, stt = 0;
    for (let i = 0; i < n; i++) { const dx = X[i] - mx, dt = T[i] - mt; sxx += dx * dx; sxt += dx * dt; stt += dt * dt; }
    if (!(sxx > 0)) return { a: NaN, b: NaN, r2: NaN, n };
    const a = sxt / sxx, b = mt - a * mx;
    let res = 0;
    for (let i = 0; i < n; i++) { const r = T[i] - (a * X[i] + b); res += r * r; }
    return { a, b, r2: stt > 0 ? 1 - res / stt : 1, n };
}

/**
 * Times of flight of the particles detected on one plane (helper for the TOF tab).
 * @param {object} result @param {number} planeIndex @returns {Float64Array}
 */
export function detectedTimes(result, planeIndex) {
    const out = [];
    const S = result.summary;
    for (let i = 0; i < result.n; i++) {
        const o = i * S_STRIDE;
        if (S[o + S_STATUS] === STATUS.DETECTED && S[o + S_WHERE] === planeIndex) out.push(S[o + S_TOF]);
    }
    return Float64Array.from(out);
}
