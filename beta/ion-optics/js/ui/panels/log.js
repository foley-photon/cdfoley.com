/* ==========================================================================
   Ion optics UI: panels/log.js — the Log tab (spec §4.7)
   Solver paths per basis field (method chain, cycles, estimated error,
   residual, time), the estimated error against cycle as reported by solve
   progress, geometry and project warnings (click one to select the shape
   it names), errors and timings from the shared log, with filters.
   ========================================================================== */
import { chartBlock, linePlot, dataTable } from '../plots.js';

export const meta = { id: 'log', title: 'Log', order: 100 };

export function mount(el, ctx) {
    const { h } = ctx.ui.dom;
    const levelSel = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Show' }, h('option', { value: '', text: 'All messages' }), h('option', { value: 'error', text: 'Errors' }), h('option', { value: 'warn', text: 'Warnings' }), h('option', { value: 'info', text: 'Information' }));
    const copyBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Copy log' });
    const solverBox = h('div', { class: 'io-log-solver' });
    const convBox = h('div');
    const warnBox = h('div', { class: 'io-log-warnings' });
    const list = h('ol', { class: 'io-log-list', 'aria-live': 'polite', 'aria-relevant': 'additions' });
    el.appendChild(h('div', { class: 'io-results io-log' }, solverBox, convBox, warnBox, h('div', { class: 'io-btnrow' }, h('h3', { class: 'io-card-title', text: 'Messages' }), levelSel, copyBtn), list));
    const log = ctx.ui.log || { entries: () => [], on: () => () => {} };
    const conv = new Map();   // k → { cycles: [], err: [] } for the latest solve
    let block = null, lastGeom = null;

    const offProgress = ctx.jobs && typeof ctx.jobs.on === 'function' ? ctx.jobs.on('solve:progress', (p) => {
        // only finite estimates can go on the log axis (the first cycles report ∞ while ρ ≥ 1)
        if (!p || p.phase !== 'solve' || !(p.estErr > 0 && p.estErr < Infinity) || !(p.cycle > 0)) return;
        const g = ctx.store.get().solve.geomKey;
        if (g !== lastGeom) { conv.clear(); lastGeom = g; }
        let c = conv.get(p.k);
        if (!c) { c = { cycles: [], err: [] }; conv.set(p.k, c); }
        c.cycles.push(p.cycle); c.err.push(p.estErr);
    }) : null;

    function renderSolver() {
        const st = ctx.store.get();
        solverBox.replaceChildren();
        const stats = (st.solve && Array.isArray(st.solve.stats) && st.solve.stats) || [];
        if (stats.length) {
            const els = (st.resolved && st.resolved.electrodes) || [];
            solverBox.append(h('h3', { class: 'io-card-title', text: 'Field solve' }), dataTable({
                columns: ['Basis (electrode)', 'Method path', 'Cycles / iterations / sweeps', 'Estimated error (V/V)', 'Scaled residual', 'Levels', 'Time (ms)', 'Converged'],
                rows: stats.map((s) => [els[s.k] ? els[s.k].name || els[s.k].id : (s.k < 0 ? 'Space charge' : String(s.k)), (s.path || []).join(' → '), [s.cycles, s.iterations, s.sweeps].map((v) => v || 0).join(' / '), s.estErr, s.scaledResidual, s.levels, Math.round(s.ms || 0), s.converged === false ? 'no' : 'yes']),
                caption: 'Solver statistics per basis field',
            }));
        } else {
            const done = st.solve && st.solve.status === 'done';
            const nb = st.resolved ? Math.max(0, st.resolved.electrodes.length - 1) : 0;
            solverBox.appendChild(h('p', { class: 'io-empty', text: done && nb === 0 ? 'Nothing to solve: no electrode besides ground (the electric field from electrodes is zero).' : 'No field solve yet.' }));
        }
        if (block) { block.destroy(); block = null; }
        if (conv.size) {
            const series = [...conv.entries()].map(([k, c]) => ({ label: `basis ${k}`, x: c.cycles, y: c.err, type: 'points', line: true }));
            const rows = [];
            for (const [k, c] of conv) c.cycles.forEach((cy, i) => rows.push([k, cy, c.err[i]]));
            block = chartBlock(convBox, { title: 'Estimated error during the solve', plot: linePlot({ series, xLabel: 'cycle (or iteration, sweep)', yLabel: 'estimated error (V/V)', logY: true }), columns: ['basis', 'cycle', 'est_error'], rows, csvName: 'solver-convergence', note: 'Sampled from progress reports (at most 10 per second).' });
        }
        warnBox.replaceChildren();
        const ws = [];
        for (const w of (st.solution && st.solution.warnings) || []) ws.push({ ...w, src: 'geometry' });
        for (const w of (st.issues && st.issues.warnings) || []) ws.push({ ...w, src: 'project' });
        for (const e of (st.issues && st.issues.errors) || []) ws.push({ ...e, src: 'error' });
        if (ws.length) {
            const ul = h('ul', { class: 'io-warn-list' });
            for (const w of ws.slice(0, 200)) {
                const m = /^shapes\[(\d+)\]/.exec(w.path || '');
                const li = h('li', { class: w.src === 'error' ? 'io-log-error' : '' }, h('span', { class: `badge ${w.src === 'error' ? 'badge-bad' : 'badge-warn'}`, text: w.code || w.src }), ' ', h('span', { text: `${w.path ? w.path + ': ' : ''}${w.message || ''}` }));
                if (m) {
                    const b = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Select shape' });
                    b.addEventListener('click', () => { const sh = (ctx.store.get().project.shapes || [])[+m[1]]; if (sh) ctx.store.select({ kind: 'shape', ids: [sh.id] }); });
                    li.append(' ', b);
                }
                ul.appendChild(li);
            }
            warnBox.append(h('h3', { class: 'io-card-title', text: 'Warnings' }), ul);
        }
    }
    const fmtTime = (t) => (t instanceof Date ? t.toTimeString().slice(0, 8) : '');
    function item(e) {
        return h('li', { class: `io-log-item io-log-${e.level}` }, h('time', { text: fmtTime(e.time) }), ' ', h('span', { class: `badge ${e.level === 'error' ? 'badge-bad' : e.level === 'warn' ? 'badge-warn' : ''}`, text: e.level }), ' ', h('span', { text: e.message }));
    }
    function renderList() {
        const f = levelSel.value;
        list.replaceChildren(...log.entries().filter((e) => !f || e.level === f).slice(-300).map(item));
    }
    const offLog = log.on((e) => { if (!levelSel.value || e.level === levelSel.value) { list.appendChild(item(e)); while (list.children.length > 300) list.firstChild.remove(); } });
    levelSel.addEventListener('change', renderList);
    copyBtn.addEventListener('click', async () => {
        const text = log.entries().map((e) => `${fmtTime(e.time)} ${e.level} ${e.message}`).join('\n');
        const ok = await ctx.ui.dom.copyText(text || '(empty log)');
        if (ctx.ui.toast) ctx.ui.toast(ok ? 'Log copied.' : 'Copy failed.', { kind: ok ? 'ok' : 'warn' });
    });
    renderSolver();
    renderList();
    return {
        update(evt) { if (evt && ['show', 'solve', 'solution', 'resolved'].includes(evt.type)) renderSolver(); },
        destroy() { if (typeof offLog === 'function') offLog(); if (typeof offProgress === 'function') offProgress(); if (block) block.destroy(); },
    };
}
