/* ==========================================================================
   Ion optics UI: panels/electrodes.js
   Electrodes rail tab (spec §4.3): every electrode with its colour, name,
   kind and a voltage input with an inline slider (default range ±2·max|V|;
   when the voltage is a bare parameter name the slider drives that
   parameter and uses its slider range), wheel steps (Shift ×10, Alt ×0.1)
   and arrow nudges. A drag is one undo step (merge key v:<id>). The ground
   electrode is listed but locked. The "~" button opens the waveform editor
   (term list and a preview drawn from the engine's sampleWave).
   ========================================================================== */
import { h, icon, clear, rafThrottle } from '../dom.js';
import { createField, bindForm, locate, nextId, storeEvalExpr, displayValue } from '../forms.js';
import { formatPretty } from '../units.js';
import { sampleWave } from '../../engine/waveform.js';
import { niceLength } from '../tools.js';

const PALETTE = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#dc2626', '#0891b2', '#ca8a04', '#db2777'];

/** The parameter a voltage is bound to (a bare parameter name), or null. */
export function boundParam(project, v) {
    if (typeof v !== 'string') return null;
    const name = v.trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) return null;
    const i = (project.params || []).findIndex((p) => p && p.name === name);
    return i >= 0 ? { name, index: i, param: project.params[i] } : null;
}

/** Slider range for a voltage: the bound parameter's slider, else ±2·max|V| rounded up to 1, 2 or 5 × 10^k. */
export function voltageRange(resolved, project, id) {
    const e = (project.electrodes || []).find((x) => x.id === id);
    const b = e ? boundParam(project, e.v) : null;
    if (b && b.param.slider && b.param.slider.max > b.param.slider.min) {
        const s = b.param.slider;
        return { min: s.min, max: s.max, step: s.step > 0 ? s.step : niceLength((s.max - s.min) / 1000) };
    }
    let m = 0;
    for (const x of (resolved && resolved.electrodes) || []) if (x.index !== 0 && x.id !== 'gnd') m = Math.max(m, Math.abs(x.dc || 0));
    if (!(m > 0)) m = 500;
    let R = niceLength(2 * m);
    if (R < 2 * m) R = niceLength(R * 2.5);
    return { min: -R, max: R, step: niceLength(R / 1000) };
}

/**
 * Voltage input plus slider for one electrode.
 * @returns {{ el: HTMLElement, sync(): void }}
 */
export function voltageControl(ctx, app, id, { label = 'Voltage', guide = true } = {}) {
    const { store } = ctx;
    const commit = ctx.commit;
    const wrap = h('div', { class: 'io-volt', dataset: guide ? { guide: 'electrode:' + id } : null });
    const field = createField({ key: 'v', label, kind: 'number', dim: 'voltage' }, {
        value: undefined, evalExpr: storeEvalExpr(ctx), idPrefix: 'io-v', wheel: true,
        onCommit: (v, o) => commit((p) => { const L = locate(p, 'electrode', id); if (L) L.obj.v = v; }, { label: 'Voltage', merge: o.merge ? 'v:' + id : null }),
    });
    const range = h('input', { type: 'range', class: 'io-range', 'aria-label': label + ' slider' });
    const bindNote = h('div', { class: 'hint io-bind-note', hidden: true });
    wrap.append(field.el, range, bindNote);
    let frozen = null;
    const st = () => store.get();
    const res = () => st().resolved || st().lastResolved;
    const freeze = () => { if (!frozen) frozen = voltageRange(res(), st().project, id); };
    const thaw = () => { frozen = null; sync(); };
    range.addEventListener('pointerdown', freeze);
    range.addEventListener('keydown', freeze);
    range.addEventListener('change', thaw);
    range.addEventListener('blur', () => { if (frozen) thaw(); });
    range.addEventListener('input', () => {
        const v = Number(range.value);
        if (!Number.isFinite(v)) return;
        const p = st().project;
        const e = (p.electrodes || []).find((x) => x.id === id);
        const b = e ? boundParam(p, e.v) : null;
        const r = b
            ? commit((d) => { const q = d.params.find((x) => x.name === b.name); if (q) q.value = v; }, { label: `Parameter ${b.name}`, merge: 'v:' + id })
            : commit((d) => { const L = locate(d, 'electrode', id); if (L) L.obj.v = v; }, { label: 'Voltage', merge: 'v:' + id });
        if (r && !r.ok) field.setError(r.error);
        range.setAttribute('aria-valuetext', formatPretty(v, 'voltage', 6));
    });
    function sync() {
        const p = st().project;
        const e = (p.electrodes || []).find((x) => x.id === id);
        if (!e) return;
        const r = res();
        const re = r && r.electrodes ? r.electrodes.find((x) => x.id === id) : null;
        field.sync(e.v === undefined ? 0 : e.v, re ? re.dc : undefined);
        const b = boundParam(p, e.v);
        const nm = e.name || id;
        range.setAttribute('aria-label', `${nm} voltage slider`);
        if (field.input) field.input.setAttribute('aria-label', `${nm} voltage (V)`);
        const rg = frozen || voltageRange(r, p, id);
        range.min = String(rg.min); range.max = String(rg.max); range.step = String(rg.step);
        const cur = b ? (r && r.paramValues ? r.paramValues[b.name] : NaN) : (re ? re.dc : (typeof e.v === 'number' ? e.v : NaN));
        const sliderOk = Number.isFinite(cur) && (b || typeof e.v === 'number');
        range.disabled = !sliderOk;
        if (sliderOk && document.activeElement !== range) range.value = String(cur);
        if (sliderOk) range.setAttribute('aria-valuetext', formatPretty(cur, 'voltage', 6));
        bindNote.hidden = !b && sliderOk;
        bindNote.textContent = b ? `The slider sets parameter ${b.name}.` : sliderOk ? '' : 'The voltage is an expression; edit it in the box.';
    }
    sync();
    return { el: wrap, sync, field, range };
}

/** Short description of a waveform. */
export function waveSummary(e) {
    const terms = e && e.wave && Array.isArray(e.wave.terms) ? e.wave.terms : [];
    if (!terms.length) return 'DC only';
    return terms.map((t) => {
        if (t.type === 'cos') return `cos ${displayValue(t.amp)} V at ${displayValue(t.freq)} MHz`;
        if (t.type === 'pulse') return `pulse ${displayValue(t.amp)} V`;
        if (t.type === 'table') return `table (${(t.points || []).length} points)`;
        return t.type;
    }).join(' + ');
}

/** Rail tab. */
export function mountElectrodes(host, ctx, app) {
    const { store } = ctx;
    const listEl = h('ul', { class: 'io-list io-el-list', 'aria-label': 'Electrodes' });
    const addBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('plus', 16), h('span', { text: 'Add electrode' }));
    addBtn.addEventListener('click', () => addElectrode(ctx, app));
    host.append(
        h('p', { class: 'io-note', text: 'Drag a slider to change a voltage; trajectories update live. Every voltage is solved once as a basis field and recombined, so voltage changes need no new solve.' }),
        listEl, h('div', { class: 'io-add-row' }, addBtn));
    let rows = new Map(), sig = '';
    function build() {
        const p = store.get().project;
        const els = p.electrodes || [];
        sig = els.map((e) => e.id).join('|');
        clear(listEl);
        rows = new Map();
        for (const e of els) {
            const li = h('li', { class: 'io-item', dataset: { id: e.id } });
            const sw = h('span', { class: 'io-swatch' });
            const title = h('button', { type: 'button', class: 'io-item-title' });
            title.addEventListener('click', () => { store.select({ kind: 'electrode', ids: [e.id] }); app.openInspector && app.openInspector(); });
            const badge = h('span', { class: 'badge io-mesh-badge', text: 'mesh', hidden: true });
            const head = h('div', { class: 'io-item-row' }, sw, title, badge);
            li.appendChild(head);
            const row = { li, sw, title, badge, volt: null, waveBtn: null };
            if (e.id === 'gnd' || e.ground) {
                head.appendChild(h('span', { class: 'io-item-sub', dataset: { guide: 'electrode:gnd' } }, icon('lock', 14), ' 0 V (fixed)'));
            } else {
                const wb = h('button', { type: 'button', class: 'io-mini io-wave-btn', title: 'Waveform (time-dependent voltage)', 'aria-label': `Waveform of ${e.name || e.id}` }, icon('wave', 16));
                wb.addEventListener('click', () => openWaveEditor(ctx, app, e.id));
                const del = h('button', { type: 'button', class: 'io-mini', title: 'Delete electrode', 'aria-label': `Delete ${e.name || e.id}` }, icon('trash', 16));
                del.addEventListener('click', () => deleteElectrode(ctx, app, e.id));
                head.append(wb, del);
                row.waveBtn = wb;
                row.volt = voltageControl(ctx, app, e.id, { label: 'Voltage' });
                row.waveNote = h('div', { class: 'hint io-wave-note', hidden: true });
                li.append(row.volt.el, row.waveNote);
            }
            rows.set(e.id, row);
            listEl.appendChild(li);
        }
        syncRows();
    }
    function syncRows() {
        const st = store.get();
        const sel = st.selection || {};
        for (const e of st.project.electrodes || []) {
            const row = rows.get(e.id);
            if (!row) continue;
            row.sw.style.background = /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#888888';
            row.title.textContent = e.name || e.id;
            row.badge.hidden = e.kind !== 'grid';
            row.li.classList.toggle('io-selected', sel.kind === 'electrode' && (sel.ids || []).includes(e.id));
            if (row.volt) row.volt.sync();
            if (row.waveNote) {
                const has = e.wave && Array.isArray(e.wave.terms) && e.wave.terms.length;
                row.waveNote.hidden = !has;
                row.waveNote.textContent = has ? `+ ${waveSummary(e)}` : '';
                row.waveBtn.setAttribute('aria-pressed', has ? 'true' : 'false');
            }
        }
    }
    function update() {
        const p = store.get().project;
        const s = (p.electrodes || []).map((e) => e.id).join('|');
        if (s !== sig) build(); else syncRows();
    }
    build();
    const offs = ['project', 'resolved', 'selection'].map((evt) => store.on(evt, update));
    return { update, destroy: () => offs.forEach((f) => f()) };
}

/** Adds an electrode and selects it. */
export function addElectrode(ctx, app) {
    let id = null;
    const r = ctx.commit((p) => {
        const els = p.electrodes || (p.electrodes = []);
        id = nextId(els, 'e');
        const used = new Set(els.map((e) => e.color));
        const color = PALETTE.find((c) => !used.has(c)) || PALETTE[els.length % PALETTE.length];
        els.push({ id, name: `Electrode ${els.length}`, kind: 'solid', v: 0, wave: null, color });
    }, { label: 'Add electrode' });
    if (r.ok) {
        ctx.store.select({ kind: 'electrode', ids: [id] });
        ctx.store.setUi('drawElectrode', id);
        if (ctx.ui.announce) ctx.ui.announce('Electrode added; new shapes are drawn with it.');
    } else if (ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' });
    return r.ok ? id : null;
}

/** Deletes an electrode after confirmation; its shapes and edges become ground. */
export async function deleteElectrode(ctx, app, id) {
    const p = ctx.store.get().project;
    const e = (p.electrodes || []).find((x) => x.id === id);
    if (!e || id === 'gnd' || e.ground) return false;
    const nShapes = (p.shapes || []).filter((s) => s.electrode === id).length;
    const ok = await ctx.ui.openDialog({
        title: 'Delete electrode',
        body: `Delete “${e.name || id}”? ${nShapes ? `${nShapes} shape${nShapes > 1 ? 's' : ''} and any domain edges using it become ground (0 V).` : 'No shapes use it.'}`,
        actions: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, danger: true }],
    });
    if (ok !== true) return false;
    const r = ctx.commit((d) => {
        d.electrodes = d.electrodes.filter((x) => x.id !== id);
        for (const s of d.shapes || []) if (s.electrode === id) s.electrode = 'gnd';
        const edges = (d.domain && d.domain.edges) || {};
        for (const k of Object.keys(edges)) {
            const ed = edges[k];
            if (!ed) continue;
            if (ed.electrode === id) ed.electrode = 'gnd';
            for (const sg of ed.segments || []) {
                if (sg.electrode === id) sg.electrode = 'gnd';
                if (Array.isArray(sg.ramp) && sg.ramp.includes(id)) { delete sg.ramp; sg.electrode = 'gnd'; }
            }
        }
    }, { label: 'Delete electrode' });
    if (!r.ok) { if (ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' }); return false; }
    ctx.store.select({ kind: null, ids: [] });
    if (ctx.ui.announce) ctx.ui.announce(`Deleted electrode ${e.name || id}.`);
    return true;
}

/** Inspector editor for one electrode. */
export function electrodeEditor(host, ctx, app, id) {
    const { store } = ctx;
    const isGnd = id === 'gnd';
    const title = h('h3', { text: '' });
    const sw = h('span', { class: 'io-swatch' });
    host.appendChild(h('div', { class: 'io-insp-head' }, sw, title));
    const form = bindForm(ctx, {
        kind: 'electrode', label: 'Edit electrode', idPrefix: 'io-el',
        locate: (p) => locate(p, 'electrode', id),
        resolved: (r) => (r.electrodes || []).find((e) => e.id === id) || null,
        merge: (key) => (key === 'v' ? 'v:' + id : null),
        hide: (key) => isGnd && key !== 'name' && key !== 'color',
    });
    host.appendChild(form.el);
    let waveRow = null;
    if (isGnd) host.appendChild(h('p', { class: 'io-note', text: 'The ground electrode is always at 0 V and cannot be deleted. Domain edges and shapes default to it.' }));
    else {
        const summary = h('p', { class: 'io-note' });
        const editW = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('wave', 16), h('span', { text: 'Edit waveform' }));
        editW.addEventListener('click', () => openWaveEditor(ctx, app, id));
        const del = h('button', { type: 'button', class: 'btn btn-secondary btn-sm io-danger' }, icon('trash', 16), h('span', { text: 'Delete' }));
        del.addEventListener('click', () => deleteElectrode(ctx, app, id));
        const selShapes = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Select its shapes' });
        selShapes.addEventListener('click', () => {
            const ids = (store.get().project.shapes || []).filter((s) => s.electrode === id).map((s) => s.id);
            store.select({ kind: 'shape', ids });
        });
        waveRow = summary;
        host.append(h('div', { class: 'io-insp-section' }, h('h4', { class: 'io-group-title', text: 'Waveform' }), summary, h('div', { class: 'io-insp-actions' }, editW)),
            h('div', { class: 'io-insp-actions' }, selShapes, del));
    }
    function update() {
        const e = (store.get().project.electrodes || []).find((x) => x.id === id);
        if (!e) { clear(host); host.appendChild(h('p', { class: 'io-empty', text: 'This electrode was deleted.' })); return; }
        title.textContent = `${e.name || id} (${id})`;
        sw.style.background = /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#888888';
        form.sync();
        if (waveRow) waveRow.textContent = waveSummary(e);
    }
    update();
    return { update };
}

/** Waveform editor dialog: terms (cos, pulse, table) with their forms and a preview of V(t). */
export function openWaveEditor(ctx, app, id) {
    const { store } = ctx;
    const body = h('div', { class: 'io-wave' });
    const intro = h('p', { class: 'io-note', text: 'V(t) = DC voltage + Σ terms. Terms of the same kind and timing share one time channel; at most 7 channels are allowed. Times in µs, frequencies in MHz.' });
    const termsEl = h('div', { class: 'io-wave-terms' });
    const typeSel = h('select', { class: 'io-select', 'aria-label': 'Kind of term to add' },
        h('option', { value: 'cos', text: 'Cosine (RF)' }), h('option', { value: 'pulse', text: 'Pulse (trapezoid)' }), h('option', { value: 'table', text: 'Table (piecewise linear)' }));
    const addBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('plus', 16), h('span', { text: 'Add term' }));
    const plotEl = h('div', { class: 'io-wave-plot', role: 'img', 'aria-label': 'Preview of the voltage against time' });
    const tableToggle = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-expanded': 'false', text: 'Show data table' });
    const tableBox = h('div', { class: 'io-scroll-x', hidden: true });
    body.append(intro, termsEl, h('div', { class: 'io-btnrow' }, typeSel, addBtn), h('h3', { class: 'io-group-title', text: 'Preview' }), plotEl, tableToggle, tableBox);
    const idx = () => (store.get().project.electrodes || []).findIndex((e) => e.id === id);
    addBtn.addEventListener('click', () => {
        const type = typeSel.value;
        const schema = ctx.engine.schema;
        let term;
        try { term = schema.defaults('term.' + type); } catch (e) { term = null; }
        if (!term || !term.type) term = type === 'cos' ? { type: 'cos', amp: 100, freq: 1, phase: 0 } : type === 'pulse' ? { type: 'pulse', amp: 100, t0: 0, rise: 0.01, width: 1, fall: 0.01, period: null } : { type: 'table', points: [[0, 0], [1, 100]], period: null };
        const r = ctx.commit((p) => { const L = locate(p, 'electrode', id); if (!L) return; if (!L.obj.wave || !Array.isArray(L.obj.wave.terms)) L.obj.wave = { terms: [] }; L.obj.wave.terms.push(term); }, { label: 'Add waveform term' });
        if (!r.ok && ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' });
    });
    tableToggle.addEventListener('click', () => {
        tableBox.hidden = !tableBox.hidden;
        tableToggle.setAttribute('aria-expanded', tableBox.hidden ? 'false' : 'true');
        tableToggle.textContent = tableBox.hidden ? 'Show data table' : 'Hide data table';
    });
    let forms = [], sig = '';
    function build() {
        clear(termsEl);
        forms = [];
        const e = (store.get().project.electrodes || [])[idx()];
        const terms = e && e.wave && Array.isArray(e.wave.terms) ? e.wave.terms : [];
        sig = terms.map((t) => t.type).join('|');
        if (!terms.length) termsEl.appendChild(h('p', { class: 'io-empty', text: 'No terms: the electrode holds its DC voltage.' }));
        terms.forEach((t, k) => {
            const card = h('div', { class: 'io-card' });
            const rm = h('button', { type: 'button', class: 'io-mini', 'aria-label': `Remove term ${k + 1}`, title: 'Remove term' }, icon('trash', 16));
            rm.addEventListener('click', () => ctx.commit((p) => {
                const L = locate(p, 'electrode', id);
                if (!L || !L.obj.wave) return;
                L.obj.wave.terms.splice(k, 1);
                if (!L.obj.wave.terms.length) L.obj.wave = null;
            }, { label: 'Remove waveform term' }));
            card.appendChild(h('div', { class: 'io-item-row' }, h('strong', { class: 'io-item-title', text: `${k + 1}. ${t.type === 'cos' ? 'Cosine' : t.type === 'pulse' ? 'Pulse' : 'Table'}` }), rm));
            const f = bindForm(ctx, {
                kind: 'term', sub: t.type, label: 'Edit waveform', idPrefix: 'io-wt',
                locate: (p) => { const L = locate(p, 'electrode', id); const tt = L && L.obj.wave && L.obj.wave.terms ? L.obj.wave.terms[k] : null; return tt ? { obj: tt, path: `${L.path}.wave.terms[${k}]` } : null; },
                resolved: (r) => { const re = (r.electrodes || []).find((x) => x.id === id); return re && re.terms ? re.terms[k] : null; },
                merge: (key) => `wave:${id}:${k}:${key}`,
            });
            card.appendChild(f.el);
            forms.push(f);
            termsEl.appendChild(card);
        });
    }
    const drawPreview = rafThrottle(() => {
        const st = store.get();
        const r = st.resolved || st.lastResolved;
        const re = r && r.electrodes ? r.electrodes.find((x) => x.id === id) : null;
        clear(plotEl); clear(tableBox);
        if (!re) { plotEl.appendChild(h('p', { class: 'io-empty', text: 'Fix the errors in the project to see the preview.' })); return; }
        const T = previewSpan(re);
        let w;
        try { w = sampleWave(re, 0, T, 600); } catch (e) { w = null; }
        if (!w) return;
        const t = Array.from(w.t), v = Array.from(w.v);
        if (typeof window !== 'undefined' && window.Plot && typeof window.Plot.draw === 'function') {
            window.Plot.draw(plotEl, { height: 220, x: { label: 't (µs)' }, y: { label: 'V (V)' }, series: [{ type: 'line', x: t, y: v, label: 'V(t)', color: 'var(--c1)' }], hover: true });
        } else plotEl.appendChild(h('p', { class: 'io-empty', text: 'The plot library did not load; see the data table.' }));
        const tbl = h('table', { class: 'io-stats-table' }, h('caption', { class: 'visually-hidden', text: 'Voltage against time' }),
            h('thead', null, h('tr', null, h('th', { scope: 'col', text: 't (µs)' }), h('th', { scope: 'col', text: 'V (V)' }))));
        const tb = h('tbody');
        const stride = Math.max(1, Math.floor(t.length / 60));
        for (let i = 0; i < t.length; i += stride) tb.appendChild(h('tr', null, h('td', { class: 'num', text: formatPretty(t[i], 'none', 5) }), h('td', { class: 'num', text: formatPretty(v[i], 'none', 6) })));
        tbl.appendChild(tb);
        tableBox.appendChild(tbl);
    });
    function update() {
        const e = (store.get().project.electrodes || [])[idx()];
        if (!e) { pr.close(null); return; }
        const terms = e.wave && Array.isArray(e.wave.terms) ? e.wave.terms : [];
        if (terms.map((t) => t.type).join('|') !== sig) build(); else forms.forEach((f) => f.sync());
        drawPreview();
    }
    const e0 = (store.get().project.electrodes || [])[idx()];
    const pr = ctx.ui.openDialog({
        title: `Waveform: ${e0 ? e0.name || id : id}`, body, wide: true, className: 'io-wave-dialog',
        actions: [{ label: 'Remove waveform', value: 'remove', onClick: () => { ctx.commit((p) => { const L = locate(p, 'electrode', id); if (L) L.obj.wave = null; }, { label: 'Remove waveform' }); return false; } },
            { label: 'Done', value: 'done', primary: true }],
    });
    build();
    drawPreview();
    const offs = ['project', 'resolved'].map((evt) => store.on(evt, update));
    pr.then(() => offs.forEach((f) => f()));
    return pr;
}

/** Time span for the waveform preview (µs). */
export function previewSpan(re) {
    let T = 0;
    for (const t of re.terms || []) {
        if (t.type === 'cos' && t.freq > 0) T = Math.max(T, 3 / t.freq);
        else if (t.type === 'pulse') T = Math.max(T, t.period ? 2 * t.period : 1.5 * ((t.t0 || 0) + (t.rise || 0) + (t.width || 0) + (t.fall || 0)));
        else if (t.type === 'table' && Array.isArray(t.points) && t.points.length) T = Math.max(T, t.period ? 2 * t.period : 1.2 * t.points[t.points.length - 1][0]);
    }
    return T > 0 ? T : 1;
}
