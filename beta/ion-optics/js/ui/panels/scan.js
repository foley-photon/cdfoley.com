/* ==========================================================================
   Ion optics UI: panels/scan.js — the "Scan & tune" tab (spec §4.7)
   A 1D scan of a parameter, electrode voltage or source energy against a
   metric (transmission, spot rms, waist position, mean TOF, TOF FWHM,
   resolving power, mean KE, grouped blur) with a live plot, a table and
   "Apply best"; bounded Nelder–Mead tuning of ≤ 4 variables (budget 60)
   with a live best-so-far plot. Geometry variables re-solve the fields at
   every point; the estimate is shown first.
   ========================================================================== */
import { scanJob, optimizeJob, variableValue, variableMovesGeometry, applyVariable } from '../analysis-jobs.js';
import { METRICS, scanValues } from '../../engine/optimize.js';
import { chartBlock, linePlot, fmtNum } from '../plots.js';

export const meta = { id: 'scan', title: 'Scan & tune', order: 70 };

/** Variables of a project: parameters, non-ground electrodes, source energies (pure, for tests). */
export function variableOptions(project) {
    const out = [];
    for (const p of project.params || []) out.push({ kind: 'param', id: p.name, label: `Parameter ${p.name}` });
    for (const e of project.electrodes || []) if (!e.ground && e.id !== 'gnd') out.push({ kind: 'electrode', id: e.id, label: `Voltage of ${e.name || e.id}` });
    for (const s of project.sources || []) out.push({ kind: 'sourceEnergy', id: s.id, label: `Energy of ${s.name || s.id}` });
    return out;
}

/**
 * Default scan settings for a project (pure, for tests): the project's analysis.scan when it has one; else the first parameter
 * with a slider (else an electrode voltage, else any parameter) against spot rms at the image plane (analysis.waist.plane),
 * the TOF resolving power when a detector sees two or more species, or the transmission.
 * @returns {{ index: number, values: { from: number, to: number, n: number }|null, metric: { type: string, plane: string|null, species?: string } }}
 */
export function scanDefaults(project, resolved) {
    const vars = variableOptions(project || {});
    const an = (project && project.analysis) || {};
    const sc = an.scan;
    const planes = (resolved && resolved.recording && resolved.recording.planes) || [];
    const det = planes.find((q) => q.terminate);
    if (sc && sc.variable) {
        const k = vars.findIndex((v) => v.kind === sc.variable.kind && v.id === sc.variable.id);
        if (k >= 0) {
            const vals = sc.values && Number.isFinite(sc.values.from) && Number.isFinite(sc.values.to) ? { from: sc.values.from, to: sc.values.to, n: sc.values.n || 11 } : null;
            const m = sc.metric || {};
            return { index: k, values: vals, metric: { type: METRICS[m.type] ? m.type : 'transmission', plane: m.plane || (det ? det.id : null), species: m.species } };
        }
    }
    const params = (project && project.params) || [];
    let index = vars.findIndex((v) => v.kind === 'param' && params.some((p) => p.name === v.id && p.slider));
    if (index < 0) index = vars.findIndex((v) => v.kind === 'electrode');
    if (index < 0) index = vars.findIndex((v) => v.kind === 'param');
    if (index < 0) index = 0;
    const image = an.waist && an.waist.plane ? planes.find((q) => q.id === an.waist.plane) : null;
    let nSpecies = 0;
    for (const s of (resolved && resolved.sources) || []) nSpecies += (s.species || []).length;
    let metric = { type: 'transmission', plane: det ? det.id : null };
    if (image) metric = { type: 'spotRms', plane: image.id };
    else if (det && nSpecies >= 2) metric = { type: 'resolvingPower', plane: det.id };
    return { index, values: null, metric };
}

export function mount(el, ctx) {
    const { h } = ctx.ui.dom;
    const varSel = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Variable' });
    const fromIn = h('input', { class: 'input io-num io-num-sm', type: 'text', inputmode: 'decimal', 'aria-label': 'From' });
    const toIn = h('input', { class: 'input io-num io-num-sm', type: 'text', inputmode: 'decimal', 'aria-label': 'To' });
    const nIn = h('input', { class: 'input io-num io-num-sm', type: 'number', min: '2', max: '200', value: '11', 'aria-label': 'Points' });
    const metricSel = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Metric' }, ...Object.entries(METRICS).map(([k, m]) => h('option', { value: k, text: m.label })));
    const planeSel = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Plane' });
    const speciesSel = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Species' });
    const goalSel = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Goal' }, h('option', { value: 'min', text: 'Minimize' }), h('option', { value: 'max', text: 'Maximize' }));
    const runBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Run scan' });
    const stopBtn = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Stop', disabled: true });
    const applyBtn = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Apply best', disabled: true });
    const status = h('p', { class: 'io-note', role: 'status' });
    const scanChart = h('div');
    const metricRow = h('div', { class: 'io-btnrow' }, h('label', { class: 'io-inline' }, h('span', { text: 'Metric' }), metricSel), h('label', { class: 'io-inline' }, h('span', { text: 'at' }), planeSel), h('label', { class: 'io-inline' }, h('span', { text: 'species' }), speciesSel), goalSel);
    const scanSec = h('section', { class: 'io-card' }, h('h3', { class: 'io-card-title', text: '1D scan' }),
        h('div', { class: 'io-btnrow' }, h('label', { class: 'io-inline' }, h('span', { text: 'Variable' }), varSel), h('label', { class: 'io-inline' }, h('span', { text: 'from' }), fromIn), h('label', { class: 'io-inline' }, h('span', { text: 'to' }), toIn), h('label', { class: 'io-inline' }, h('span', { text: 'points' }), nIn)),
        h('div', { class: 'io-btnrow' }, runBtn, stopBtn, applyBtn), scanChart);
    // tuning
    const tuneRows = h('div', { class: 'io-tune-rows' });
    const addVarBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Add variable' });
    const evalIn = h('input', { class: 'input io-num io-num-sm', type: 'number', min: '5', max: '1000', value: '60', 'aria-label': 'Evaluation budget' });
    const tuneBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Tune' });
    const tuneApply = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Apply result', disabled: true });
    const tuneChart = h('div');
    const tuneOut = h('p', { class: 'io-note', role: 'status' });
    const tuneSec = h('section', { class: 'io-card' }, h('h3', { class: 'io-card-title', text: 'Tune (Nelder–Mead, bounded)' }), tuneRows,
        h('div', { class: 'io-btnrow' }, addVarBtn, h('label', { class: 'io-inline' }, h('span', { text: 'budget' }), evalIn), tuneBtn, tuneApply), tuneOut, tuneChart);
    el.appendChild(h('div', { class: 'io-results io-scan' }, metricRow, status, scanSec, tuneSec));

    let vars = [], stop = false, busy = false, scanRes = null, tuneRes = null, scanBlock = null, tuneBlock = null, filledKey = null, applied = null;
    const runKeyNow = () => (ctx.store.get().keys || {}).runKey || null;
    // which project the defaults were set for (a new preset or project resets them)
    const projectKey = () => { const m = (ctx.store.get().project || {}).meta || {}; return `${m.preset || ''}|${m.created || ''}`; };
    const num = (s) => Number(String(s).replace('−', '-'));
    const metricOf = () => ({ type: metricSel.value, plane: metricSel.value === 'transmission' && planeSel.value === '' ? null : (planeSel.value || null), species: speciesSel.value || undefined });

    function refresh() {
        const st = ctx.store.get(), p = st.project, r = st.resolved;
        vars = variableOptions(p);
        const cur = varSel.value;
        varSel.replaceChildren(...vars.map((v, i) => h('option', { value: String(i), text: v.label })));
        if (cur && +cur < vars.length) varSel.value = cur;
        const planes = (r && r.recording && r.recording.planes) || [];
        const cp = planeSel.value;
        planeSel.replaceChildren(h('option', { value: '', text: 'any detector' }), ...planes.map((q) => h('option', { value: q.id, text: q.name || q.id })));
        if (planes.some((q) => q.id === cp)) planeSel.value = cp; else { const d = planes.find((q) => q.terminate); planeSel.value = d ? d.id : ''; }
        const labels = new Set();
        for (const s of (r && r.sources) || []) for (const sp of s.species || []) labels.add(sp.label);
        const cs = speciesSel.value;
        speciesSel.replaceChildren(h('option', { value: '', text: 'all' }), ...[...labels].map((l) => h('option', { value: l, text: l })));
        if (labels.has(cs)) speciesSel.value = cs;
        const key = projectKey();
        if (key !== filledKey && filledKey !== null) clearResults();   // another project or preset: its results do not apply
        else markStale();
        if (key !== filledKey && vars.length) {
            filledKey = key;
            const d = scanDefaults(p, r);
            varSel.value = String(Math.min(d.index, vars.length - 1));
            metricSel.value = d.metric.type;
            goalSel.value = METRICS[d.metric.type].goal;
            planeSel.value = d.metric.plane && planes.some((q) => q.id === d.metric.plane) ? d.metric.plane : planeSel.value;
            speciesSel.value = d.metric.species && labels.has(d.metric.species) ? d.metric.species : '';
            if (d.values) { fromIn.value = String(d.values.from); toIn.value = String(d.values.to); nIn.value = String(Math.max(2, Math.min(200, d.values.n))); }
            else setRange();
        } else if (!fromIn.value && vars.length) setRange();
        for (const row of tuneRows.children) row.__refresh && row.__refresh();
    }
    /** Results of an earlier project or preset are removed (they may name variables that do not exist here). */
    function clearResults() {
        scanRes = null; tuneRes = null; applied = null;
        applyBtn.disabled = true; tuneApply.disabled = true;
        status.textContent = ''; tuneOut.textContent = '';
        if (scanBlock) { scanBlock.destroy(); scanBlock = null; }
        if (tuneBlock) { tuneBlock.destroy(); tuneBlock = null; }
    }
    /** After an edit of the same project (other than applying the result) the shown values were computed for earlier settings. */
    function markStale() {
        const k = (ctx.store.get().keys || {}).runKey || null;
        for (const [res, out] of [[scanRes, status], [tuneRes, tuneOut]]) {
            if (!res || !res.runKey || res.staleNoted) continue;
            if (applied && applied.res === res) { if (k !== applied.key) { res.runKey = k; applied = null; } continue; }
            if (k !== res.runKey) { res.staleNoted = true; out.textContent = `${out.textContent} The project changed since; these values were computed for the earlier settings.`; }
        }
    }
    function setRange() {
        const st = ctx.store.get(), v = vars[+varSel.value || 0];
        if (!v) return;
        const c = variableValue(st.project, st.resolved, v);
        if (!Number.isFinite(c)) return;
        const d = Math.abs(c) > 0 ? 0.2 * Math.abs(c) : 1;
        fromIn.value = String(+(c - d).toPrecision(6)); toIn.value = String(+(c + d).toPrecision(6));
    }
    varSel.addEventListener('change', setRange);
    metricSel.addEventListener('change', () => { goalSel.value = METRICS[metricSel.value].goal; });

    function setBusy(b) { busy = b; runBtn.disabled = b; tuneBtn.disabled = b; stopBtn.disabled = !b; }
    stopBtn.addEventListener('click', () => { stop = true; });
    async function confirmGeometry(v, value, perPointText, count = 1) {
        const st = ctx.store.get();
        if (!variableMovesGeometry(ctx, st.project, v, value)) return true;
        const est = ctx.jobs.estimate ? ctx.jobs.estimate() : null;
        const fmt = ctx.ui.dom && ctx.ui.dom.fmtMs ? ctx.ui.dom.fmtMs : (ms) => `${(ms / 1000).toFixed(2)} s`;
        const each = est && est.solveMs > 0 ? est.solveMs + (est.runMs > 0 ? est.runMs : 0) : NaN;
        const msg = `This variable changes the geometry, so every ${perPointText} re-solves the fields${Number.isFinite(each) ? ` (about ${fmt(each)} each, ${fmt(each * count)} for all ${count})` : ''}. Continue?`;
        if (ctx.ui.openDialog) {
            const r = await ctx.ui.openDialog({ title: 'Re-solve at every point', body: msg, actions: [{ label: 'Cancel', value: false }, { label: 'Continue', value: true, primary: true }] });
            return r === true;
        }
        return true;
    }
    runBtn.addEventListener('click', async () => {
        const v = vars[+varSel.value];
        const a = num(fromIn.value), b = num(toIn.value), n = Math.max(2, Math.min(200, Math.round(num(nIn.value))));
        if (!v || !Number.isFinite(a) || !Number.isFinite(b)) { status.textContent = 'Choose a variable and a range.'; return; }
        if (!(await confirmGeometry(v, a, 'point', n))) return;
        const values = scanValues({ from: a, to: b, n });
        const metric = metricOf(), mdef = METRICS[metric.type];
        const xs = [], ys = [];
        stop = false; setBusy(true); applyBtn.disabled = true;
        if (scanBlock) scanBlock.destroy();
        const draw = () => linePlot({ series: [{ label: mdef.label, x: xs, y: ys, type: 'points', line: true }], xLabel: v.label, yLabel: `${mdef.label}${mdef.unit ? ` (${mdef.unit})` : ''}` });
        scanBlock = chartBlock(scanChart, { title: `${mdef.label} against ${v.label}`, plot: draw(), columns: ['value', metric.type], rows: () => xs.map((x, i) => [x, ys[i]]), csvName: 'scan', empty: 'Scanning…' });
        try {
            scanRes = await scanJob(ctx, { variable: v, values, metric, goal: goalSel.value }, (i, x, m) => {
                xs.push(x); ys.push(m);
                status.textContent = `Point ${i + 1}/${values.length}: ${v.label} = ${fmtNum(x)} → ${fmtNum(m)}`;
                scanBlock.update({ plot: draw() });
            }, () => stop);
            scanRes.runKey = runKeyNow();
            if (scanRes.best) {
                status.textContent = `Best: ${v.label} = ${fmtNum(scanRes.best.value)} (${mdef.label} ${fmtNum(scanRes.best.metric)}).${stop ? ' Stopped.' : ''}`;
                applyBtn.disabled = false;
                scanBlock.update({ plot: linePlot({ series: [{ label: mdef.label, x: xs, y: ys, type: 'points', line: true }], xLabel: v.label, yLabel: mdef.label, vlines: [{ x: scanRes.best.value, label: 'best' }] }) });
            } else status.textContent = 'No finite metric values (check the plane and the metric).';
            if (ctx.ui.announce) ctx.ui.announce(status.textContent);
        } catch (e) { status.textContent = `The scan failed: ${e && e.message ? e.message : e}`; }
        finally { setBusy(false); }
    });
    applyBtn.addEventListener('click', () => {
        if (!scanRes || !scanRes.best) return;
        const v = vars[+varSel.value];
        applied = { res: scanRes, key: runKeyNow() };
        ctx.store.update((p) => { const q = applyVariable(p, v, scanRes.best.value); Object.assign(p, q); }, { label: `Apply best ${v.label}` });
        status.textContent = `Applied ${v.label} = ${fmtNum(scanRes.best.value)}.`;
    });

    // ---- tuning rows: variable, lower, upper, step
    function addTuneRow(pre = null) {
        if (tuneRows.children.length >= 4) return;
        const sel = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Tuned variable' });
        const lo = h('input', { class: 'input io-num io-num-sm', type: 'text', inputmode: 'decimal', 'aria-label': 'Lower bound' });
        const hi = h('input', { class: 'input io-num io-num-sm', type: 'text', inputmode: 'decimal', 'aria-label': 'Upper bound' });
        const stp = h('input', { class: 'input io-num io-num-sm', type: 'text', inputmode: 'decimal', 'aria-label': 'Initial step', placeholder: 'step' });
        const rm = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Remove' });
        const row = h('div', { class: 'io-btnrow io-tune-row' }, sel, h('span', { text: 'from' }), lo, h('span', { text: 'to' }), hi, stp, rm);
        row.__refresh = () => {
            const cur = sel.value;
            sel.replaceChildren(...vars.map((v, i) => h('option', { value: String(i), text: v.label })));
            if (cur && +cur < vars.length) sel.value = cur;
        };
        row.__refresh();
        const setDefault = () => {
            const st = ctx.store.get(), v = vars[+sel.value];
            const c = v ? variableValue(st.project, st.resolved, v) : NaN;
            if (Number.isFinite(c)) { const d = Math.abs(c) > 0 ? 0.2 * Math.abs(c) : 1; lo.value = String(+(c - d).toPrecision(6)); hi.value = String(+(c + d).toPrecision(6)); stp.value = String(+(d / 4).toPrecision(3)); }
        };
        sel.addEventListener('change', setDefault);
        rm.addEventListener('click', () => row.remove());
        if (pre !== null) sel.value = String(pre);
        setDefault();
        row.__read = () => ({ v: vars[+sel.value], lower: num(lo.value), upper: num(hi.value), step: num(stp.value) });
        tuneRows.appendChild(row);
    }
    addVarBtn.addEventListener('click', () => addTuneRow());
    tuneBtn.addEventListener('click', async () => {
        const defs = [...tuneRows.children].map((r) => r.__read()).filter((d) => d.v);
        if (!defs.length) { tuneOut.textContent = 'Add a variable to tune.'; return; }
        if (defs.some((d) => !(d.upper > d.lower))) { tuneOut.textContent = 'Each variable needs lower < upper.'; return; }
        if (!(await confirmGeometry(defs[0].v, 0.5 * (defs[0].lower + defs[0].upper), 'evaluation', Math.max(5, Math.round(num(evalIn.value) || 60))))) return;
        const metric = metricOf(), mdef = METRICS[metric.type];
        const evals = [], best = [];
        stop = false; setBusy(true); tuneApply.disabled = true;
        if (tuneBlock) tuneBlock.destroy();
        const draw = () => linePlot({ series: [{ label: 'best so far', x: evals, y: best, type: 'points', line: true }], xLabel: 'evaluation', yLabel: mdef.label });
        tuneBlock = chartBlock(tuneChart, { title: 'Best value so far', plot: draw(), columns: ['evaluation', 'best'], rows: () => evals.map((e, i) => [e, best[i]]), csvName: 'tune', empty: 'Tuning…' });
        try {
            const sign = goalSel.value === 'max' ? -1 : 1;
            tuneRes = await optimizeJob(ctx, { variables: defs.map((d) => ({ kind: d.v.kind, id: d.v.id, lower: d.lower, upper: d.upper, step: d.step > 0 ? d.step : null })), metric, goal: goalSel.value, maxEval: Math.max(5, Math.round(num(evalIn.value) || 60)) },
                (it) => { evals.push(it.nEval); best.push(sign * it.fx); tuneOut.textContent = `Evaluation ${it.nEval}: best ${mdef.label} ${fmtNum(sign * it.fx)} at ${it.x.map((x) => fmtNum(x)).join(', ')}`; tuneBlock.update({ plot: draw() }); },
                () => stop);
            tuneRes.runKey = runKeyNow();
            tuneOut.textContent = `Result after ${tuneRes.nEval} evaluations: ${defs.map((d, i) => `${d.v.label} = ${fmtNum(tuneRes.x[i])}`).join(', ')}; ${mdef.label} ${fmtNum(tuneRes.value)}.`;
            tuneApply.disabled = false;
            if (ctx.ui.announce) ctx.ui.announce(tuneOut.textContent);
        } catch (e) { tuneOut.textContent = `Tuning failed: ${e && e.message ? e.message : e}`; }
        finally { setBusy(false); }
    });
    tuneApply.addEventListener('click', () => {
        if (!tuneRes) return;
        const defs = [...tuneRows.children].map((r) => r.__read()).filter((d) => d.v);
        applied = { res: tuneRes, key: runKeyNow() };
        ctx.store.update((p) => { let q = p; defs.forEach((d, i) => { q = applyVariable(q, d.v, tuneRes.x[i]); }); Object.assign(p, q); }, { label: 'Apply tuned values' });
    });

    refresh();
    if (!tuneRows.children.length && vars.length) addTuneRow(0);
    return {
        update(evt) { if (!busy && evt && ['show', 'project', 'resolved'].includes(evt.type)) refresh(); },
        destroy() { stop = true; if (scanBlock) scanBlock.destroy(); if (tuneBlock) tuneBlock.destroy(); },
    };
}
