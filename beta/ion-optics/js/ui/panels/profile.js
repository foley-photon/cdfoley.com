/* ==========================================================================
   Ion optics UI: panels/profile.js — the Profile tab (spec §4.7)
   Potential φ and the field along the symmetry axis (one click in
   cylindrical projects), along a line drawn with the Probe tool, or along a
   line typed in; values from the main-thread field model at the display
   time; charts with data tables and CSV.
   ========================================================================== */
import { profileData, axisLine } from '../analysis-jobs.js';
import { chartBlock, linePlot, fmtNum } from '../plots.js';

export const meta = { id: 'profile', title: 'Profile', order: 60 };

export function mount(el, ctx) {
    const { h } = ctx.ui.dom;
    const axisBtn = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Along the axis' });
    const coords = ['x₀', 'y₀', 'x₁', 'y₁'].map((l) => h('input', { class: 'input io-num io-num-sm', type: 'text', inputmode: 'decimal', 'aria-label': `${l} (mm)`, placeholder: l }));
    const lineBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Along this line' });
    const nIn = h('input', { class: 'input io-num io-num-sm', type: 'number', min: '10', max: '5000', step: '10', value: '400', 'aria-label': 'Samples' });
    const note = h('p', { class: 'io-note', role: 'status' });
    const charts = h('div', { class: 'io-profile-charts' });
    el.appendChild(h('div', { class: 'io-results io-profile' },
        h('div', { class: 'io-btnrow' }, axisBtn, h('span', { class: 'io-sep' }), ...coords, lineBtn, h('label', { class: 'io-inline' }, h('span', { text: 'Samples' }), nIn)),
        h('p', { class: 'io-note', text: 'Draw a line with the Probe tool (Shift+P) on the canvas, or type its end points.' }), note, charts));
    let blocks = [], line = null, source = '';

    function clear() { for (const b of blocks) b.destroy(); blocks = []; }
    async function draw() {
        clear();
        const st = ctx.store.get();
        if (!st.resolved) { note.textContent = 'The project has errors.'; return; }
        axisBtn.hidden = st.resolved.domain.type !== 'cyl2d';
        if (!line) {
            if (st.resolved.domain.type === 'cyl2d') { line = axisLine(st.resolved); source = 'the axis'; } else { note.textContent = 'Choose a line.'; return; }
        }
        let fld;
        try { fld = await ctx.jobs.ensureField(); } catch (e) { note.textContent = `No field yet: ${e && e.message ? e.message : e}`; return; }
        if (!fld || !fld.model) { note.textContent = 'Solve the fields first.'; return; }
        const n = Math.max(10, Math.min(5000, Math.round(+nIn.value || 400)));
        const t = fld.displayTime || 0;
        const p = profileData(fld.model, line[0], line[1], n, t);
        const cyl = st.resolved.domain.type === 'cyl2d';
        const along = source === 'the axis';
        const xs = along ? p.x : p.s, xl = along ? 'x (mm)' : 'distance along the line (mm)';
        note.textContent = `Profile along ${source} from (${fmtNum(line[0][0])}, ${fmtNum(line[0][1])}) to (${fmtNum(line[1][0])}, ${fmtNum(line[1][1])}) mm${t ? ` at t = ${fmtNum(t)} µs` : ''}; ${n} samples.`;
        const rows = () => p.s.map((s, i) => [s, p.x[i], p.y[i], p.phi[i], p.ex[i], p.ey[i], p.e[i]]);
        const cols = ['s_mm', 'x_mm', cyl ? 'r_mm' : 'y_mm', 'phi_V', 'Ex_V_mm', cyl ? 'Er_V_mm' : 'Ey_V_mm', 'E_V_mm'];
        blocks.push(chartBlock(charts, { title: 'Potential φ', plot: linePlot({ series: [{ label: 'φ (V)', x: xs, y: p.phi }], xLabel: xl, yLabel: 'φ (V)' }), columns: cols, rows, csvName: 'profile' }));
        blocks.push(chartBlock(charts, { title: along ? 'Axial field E_x' : 'Field components', plot: linePlot({ series: along ? [{ label: 'E_x (V/mm)', x: xs, y: p.ex }] : [{ label: 'E_x', x: xs, y: p.ex }, { label: cyl ? 'E_r' : 'E_y', x: xs, y: p.ey }, { label: '|E|', x: xs, y: p.e, dash: true }], xLabel: xl, yLabel: 'E (V/mm)' }), columns: cols, rows, csvName: 'profile-field' }));
    }
    axisBtn.addEventListener('click', () => { const st = ctx.store.get(); if (st.resolved) { line = axisLine(st.resolved); source = 'the axis'; draw(); } });
    lineBtn.addEventListener('click', () => {
        const v = coords.map((c) => Number(String(c.value).replace('−', '-')));
        if (v.some((x) => !Number.isFinite(x))) { note.textContent = 'Enter four numbers: x₀, y₀, x₁, y₁ (mm).'; return; }
        line = [[v[0], v[1]], [v[2], v[3]]]; source = 'the line'; draw();
    });
    nIn.addEventListener('change', () => draw());
    let offProbe = null;
    if (ctx.view && typeof ctx.view.on === 'function') {
        offProbe = ctx.view.on('probe', (p) => {
            if (!p || !p.p0 || !p.p1 || p.point) return;
            line = [p.p0.slice(), p.p1.slice()]; source = 'the probe line';
            coords.forEach((c, i) => { c.value = String(+[p.p0[0], p.p0[1], p.p1[0], p.p1[1]][i].toPrecision(6)); });
            if (ctx.app && ctx.app.showDockTab) ctx.app.showDockTab('profile');
            draw();
        });
    }
    draw();
    return {
        update(evt) { if (evt && ['show', 'field', 'solution'].includes(evt.type)) draw(); },
        destroy() { clear(); if (typeof offProbe === 'function') offProbe(); },
    };
}
