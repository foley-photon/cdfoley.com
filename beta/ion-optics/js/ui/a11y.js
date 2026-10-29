/* ==========================================================================
   Ion optics UI: a11y.js
   Accessibility helpers (spec §4.12): the canvas's text alternative, updated
   after each run ("Einzel lens, cylindrical, 3 electrodes, 21 trajectories,
   waist at x = 78.9 mm, transmission 100%"), a "Describe scene" button that
   writes a full description to the live region, and run statistics that
   work with either form of a run result (summary rows or summary object).
   ========================================================================== */
import { h, icon } from './dom.js';
import { formatPretty } from './units.js';
import { summaryRows } from './view2d.js';
import { STATUS_NAMES } from '../engine/layout.js';

const STATUS_PHRASES = { DETECTED: 'detected', HIT: 'hit an electrode', EXIT: 'left the domain', ABSORBED: 'absorbed by a mesh', TMAX: 'reached the time limit', DRIFT_END: 'drifted to the limit', NUM_ERROR: 'stopped by a numerical error', BORN_INSIDE: 'started inside an electrode', CANCELLED: 'cancelled', STEPS: 'reached the step limit', FLYING: 'still flying' };

/**
 * Run statistics: the engine's summary of a result (from its summary rows), or the summary object a job manager
 * attached to the result. Returns null when neither is available.
 */
export function runStats(result, resolved, analysis) {
    if (!result) return null;
    if (result.summary && !ArrayBuffer.isView(result.summary) && typeof result.summary.launched === 'number') return result.summary;
    if (summaryRows(result) && analysis && typeof analysis.summarize === 'function') {
        try { return analysis.summarize(result, resolved); } catch (e) { return null; }
    }
    return null;
}

/**
 * The meaningful beam waist of a run ({ axis, position, rms, … }) or null: the engine's beamWaist rule, shared with the
 * Summary tab (field-free straight path to the plane, inside the domain or a drift region, not a parallel beam).
 */
export function waistOf(result, resolved, analysis, model = null) {
    if (!result || !resolved || !analysis || typeof analysis.beamWaist !== 'function' || !ArrayBuffer.isView(result.summary)) return null;
    try {
        const w = analysis.beamWaist(result, resolved, model);
        return w && w.ok ? w : null;
    } catch (e) { return null; }
}

/** Short text alternative for the canvas. */
export function canvasLabel(state, analysis) {
    const r = state.resolved || state.lastResolved;
    const p = state.project || {};
    if (!r) return 'Simulation canvas: the project has errors.';
    const name = (p.meta && p.meta.name) || 'Untitled project';
    const parts = [name, r.domain.type === 'cyl2d' ? 'cylindrical' : 'planar', `${r.electrodes.length} electrode${r.electrodes.length === 1 ? '' : 's'}`];
    const res = state.run && state.run.result;
    if (res) {
        parts.push(`${res.n} trajector${res.n === 1 ? 'y' : 'ies'}${state.run.live ? ' (live preview)' : ''}`);
        const rr = res.resolvedSnapshot || r;
        const w = waistOf(res, rr, analysis, state.field && state.field.model);
        if (w) parts.push(`waist at ${w.axis} = ${formatPretty(w.position, 'length', 3)}`);
        const s = runStats(res, rr, analysis);
        const detectors = ((rr.recording && rr.recording.planes) || []).some((p) => p.terminate);
        if (s && s.launched) {
            if (detectors) parts.push(`transmission ${pct(s.transmission.overall)}`);
            else {
                const counts = STATUS_NAMES.map((n) => [n, (s.byStatus && s.byStatus[n]) || 0]).filter(([, c]) => c > 0);
                if (counts.length) parts.push(counts.map(([n, c]) => `${c} ${STATUS_PHRASES[n] || n.toLowerCase()}`).join(', '));
            }
        }
        if (state.run.status === 'stale') parts.push('results stale');
    } else parts.push('no trajectories yet');
    return parts.join(', ');
}

function pct(f) { return `${(100 * f).toFixed(f === 0 || f === 1 ? 0 : 1)}%`; }

/** Full scene description (the "Describe scene" button). */
export function describeScene(state, analysis) {
    const r = state.resolved || state.lastResolved;
    const p = state.project || {};
    if (!r) return 'The project has errors, so the scene cannot be described. Fix the fields marked in red.';
    const d = r.domain;
    const out = [];
    out.push(`${(p.meta && p.meta.name) || 'Untitled project'}: a ${d.type === 'cyl2d' ? 'cylindrically symmetric domain (revolved about the x axis)' : 'planar domain'} from x = ${formatPretty(d.x[0], 'length', 5)} to ${formatPretty(d.x[1], 'length', 5)} and ${d.type === 'cyl2d' ? 'r' : 'y'} = ${formatPretty(d.y[0], 'length', 5)} to ${formatPretty(d.y[1], 'length', 5)}, cell ${formatPretty(d.h, 'length', 4)} (${d.nx} by ${d.ny} nodes).`);
    const sym = [];
    if (d.mirror && d.mirror.x) sym.push('a mirror plane at x = 0');
    if (d.mirror && d.mirror.y && d.type !== 'cyl2d') sym.push('a mirror plane at y = 0');
    if (d.antimirror && d.antimirror.x) sym.push('an anti-mirror plane at x = 0 (the other half carries the opposite voltages)');
    if (d.antimirror && d.antimirror.y) sym.push('an anti-mirror plane at y = 0 (the other half carries the opposite voltages)');
    if (sym.length) out.push(`Symmetry: ${sym.join(' and ')}.`);
    if (typeof d.charge === 'string' && d.charge.trim()) out.push(`A space-charge density ρ = ${d.charge.trim()} C/m³ is part of the field solve.`);
    const els = r.electrodes.filter((e) => e.index !== 0);
    if (els.length) out.push(`Electrodes: ${els.map((e) => `${e.name || e.id} at ${formatPretty(e.dc, 'voltage', 5)}${(e.terms || []).length ? ' plus a waveform' : ''}${e.kind === 'grid' ? ' (mesh)' : ''}`).join('; ')}.`);
    else out.push('Only the ground electrode exists, so there is no electric field from electrodes.');
    const counts = {};
    for (const s of r.shapes || []) counts[s.type] = (counts[s.type] || 0) + 1;
    const ks = Object.keys(counts);
    out.push(ks.length ? `Shapes: ${ks.map((k) => `${counts[k]} ${k === 'polyline' ? 'line' : k}${counts[k] > 1 ? 's' : ''}`).join(', ')}.` : 'No shapes.');
    if ((r.magnets || []).length) out.push(`${r.magnets.length} magnetic field${r.magnets.length > 1 ? 's' : ''}.`);
    for (const s of r.sources || []) {
        const sp = (s.species || []).map((x) => x.label || `${x.mass} u`).join(', ');
        const wt = s.weight !== undefined && s.weight !== 1 ? `, weight ${formatPretty(s.weight, 'none', 4)}` : '';
        if (s.type === 'rows') out.push(`Source ${s.name || s.id}: a list of ${s.count} particles of ${sp}${wt}.`);
        else out.push(`Source ${s.name || s.id}: ${s.count} particles of ${sp}, ${s.position ? s.position.type : ''} start, ${s.direction ? s.direction.type : ''} direction${wt}.`);
    }
    const planes = (r.recording && r.recording.planes) || [];
    if (planes.length) out.push(`Planes: ${planes.map((q) => `${q.name || q.id} (${q.kind === 'segment' ? 'segment' : q.kind === 'sphere' ? `sphere R = ${formatPretty(q.at, 'length', 5)} about ${(q.center || [0, 0, 0]).map((v) => formatPretty(v, 'length', 4)).join(', ')}` : `${q.kind} = ${formatPretty(q.at, 'length', 5)}`}${q.terminate ? ', detector' : ''})`).join('; ')}.`);
    const tr = r.tracer || {};
    const plug = [tr.spaceCharge ? 'space charge (onset estimator)' : null, tr.gas ? 'background gas collisions' : null, tr.drag ? 'Stokes drag' : null].filter(Boolean);
    if (plug.length) out.push(`Physics plug-ins on: ${plug.join(', ')}.`);
    const v = p.view || {};
    if (v.layers && v.layers.surface) out.push('The canvas shows the potential-energy surface (3D view).');
    else if (v.aspect > 0 && v.aspect !== 1) out.push(`The canvas stretches y by ${formatPretty(v.aspect, 'none', 3)}.`);
    const sv = state.solve || {};
    out.push(sv.status === 'done' ? 'The fields are solved.' : sv.status === 'running' ? 'The fields are being solved.' : sv.status === 'stale' ? 'The fields are stale: the geometry changed since the last solve.' : 'The fields are not solved yet.');
    const res = state.run && state.run.result;
    if (res) {
        const s = runStats(res, res.resolvedSnapshot || r, analysis);
        if (s) {
            const st = Object.keys(s.byStatus || {}).filter((k) => s.byStatus[k] > 0).map((k) => `${s.byStatus[k]} ${STATUS_PHRASES[k] || k.toLowerCase()}`);
            const det = ((((res.resolvedSnapshot || r).recording) || {}).planes || []).some((q) => q.terminate);
            out.push(`${state.run.live ? 'Live preview' : 'Last run'}: ${s.launched} particles; ${st.join(', ')}${det ? `; transmission ${pct(s.transmission.overall)}` : ''}.`);
            if (s.energy && Number.isFinite(s.energy.maxEndRel)) out.push(`Largest relative energy error ${s.energy.maxEndRel.toExponential(1)}.`);
        }
        const w = waistOf(res, res.resolvedSnapshot || r, analysis, state.field && state.field.model);
        if (w) out.push(`The beam waist is at ${w.axis} = ${formatPretty(w.position, 'length', 4)} with rms radius ${formatPretty(w.rms, 'length', 3)}.`);
        if (state.run.status === 'stale') out.push('These results are stale: the model changed after the run.');
    } else out.push('No particles have been run yet.');
    return out.join(' ');
}

/** Installs the canvas label updates and the Describe scene button. */
export function createA11y(ctx, app) {
    const { store, view } = ctx;
    const canvas = view.canvas;
    const analysis = ctx.engine.analysis;
    let pending = null;
    const updateLabel = () => {
        if (pending) return;
        pending = setTimeout(() => {
            pending = null;
            try { canvas.setAttribute('aria-label', canvasLabel(store.get(), analysis)); } catch (e) { canvas.setAttribute('aria-label', 'Simulation canvas'); }
        }, 120);
    };
    for (const evt of ['run', 'project', 'solve']) store.on(evt, updateLabel);
    updateLabel();
    const bar = document.getElementById('io-viewbar');
    const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm io-describe', title: 'Describe the scene for screen readers' }, icon('describe', 16), h('span', { text: 'Describe' }));
    btn.addEventListener('click', () => describe());
    if (bar) bar.appendChild(btn);
    function describe() {
        const text = describeScene(store.get(), analysis);
        if (ctx.ui.announce) ctx.ui.announce(text);
        if (ctx.ui.log) ctx.ui.log.add('info', 'Scene: ' + text);
        if (ctx.ui.toast) ctx.ui.toast('Scene description sent to the screen reader and added to the Log tab.', { kind: 'info' });
        return text;
    }
    return { describe, updateLabel, label: () => canvasLabel(store.get(), analysis), STATUS_NAMES };
}
