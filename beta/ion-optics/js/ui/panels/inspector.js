/* ==========================================================================
   Ion optics UI: panels/inspector.js
   Inspector (spec §4.2, §4.3): the selected object as a numeric form (shape,
   electrode, source, plane, magnet, ideal field, parameter, or a traced
   particle's record), and quick run settings. Invalid input is flagged and
   never reaches the project. On tablets the inspector is an overlay drawer.
   ========================================================================== */
import { h, icon, clear, fmt } from '../dom.js';
import { bindForm, metaFor, normaliseDescriptor } from '../forms.js';
import { formatPretty } from '../units.js';
import { shapeEditor, shapeTitle } from './shapes.js';
import { electrodeEditor } from './electrodes.js';
import { sourceEditor } from './particles.js';
import { planeEditor } from './recording.js';
import { magnetEditor, idealEditor } from './fields.js';
import { paramEditor } from './params.js';
import { summaryRows } from '../view2d.js';
import { S_STRIDE, S_ID, S_STATUS, S_WHERE, S_TOF, S_X, S_Y, S_Z, S_KE, S_KE0, S_DE_END, S_STEPS, S_PATH, S_SRC, S_SPECIES, STATUS_NAMES } from '../../engine/layout.js';

const EDITORS = { shape: shapeEditor, electrode: electrodeEditor, source: sourceEditor, plane: planeEditor, magnet: magnetEditor, idealField: idealEditor, param: paramEditor };
const STATUS_WORDS = ['flying', 'hit an electrode', 'detected', 'left the domain', 'reached the time limit', 'reached the step limit', 'absorbed by a mesh', 'drifted to the limit', 'numerical error', 'started inside an electrode', 'cancelled'];

/** Mounts the inspector into its body element. */
export function mountInspector(el, ctx, app) {
    const { store } = ctx;
    const wb = document.getElementById('io-workbench');
    const sel = h('div', { class: 'io-insp-sel' });
    const quick = h('details', { class: 'io-card io-insp-quick', open: true }, h('summary', { text: 'Quick run settings' }));
    el.append(sel, quick);
    let curKey = null, ed = null;

    // quick run settings: trajectory accuracy, interpolation, integrator, relativistic + live toggle
    const quickDescs = metaFor(ctx.engine.schema && ctx.engine.schema.META, 'tracer').map(normaliseDescriptor)
        .filter((d) => ['quality', 'fieldInterp', 'integrator', 'relativistic'].includes(d.key));
    const qf = bindForm(ctx, { descs: quickDescs, label: 'Run settings', idPrefix: 'io-q', locate: (p) => (p.tracer ? { obj: p.tracer, path: 'tracer' } : null), resolved: (r) => r.tracer,
        intercept: (key, value, draft) => {
            if (key !== 'quality') return false;
            draft.tracer.quality = value;
            if (value === 'custom' && !draft.tracer.custom) draft.tracer.custom = { rtol: 1e-8, maxStepCells: 0.5, nearStepCells: 0.1, rfStepsPerPeriod: 32, borisStepsPerGyration: 128 };
            return true;
        } });
    const liveId = 'io-q-live';
    const live = h('input', { type: 'checkbox', id: liveId });
    live.addEventListener('change', () => app.setLive(live.checked));
    const count = h('p', { class: 'io-note' });
    quick.append(qf.el, h('label', { class: 'io-check', for: liveId }, live, h('span', { text: 'Live preview while editing' })), count);

    function key() {
        const s = store.get().selection || { kind: null, ids: [] };
        return `${s.kind}|${(s.ids || []).join(',')}`;
    }
    function build() {
        clear(sel);
        ed = null;
        const s = store.get().selection || { kind: null, ids: [] };
        const ids = s.ids || [];
        if (!s.kind || !ids.length) {
            sel.appendChild(h('p', { class: 'io-empty', text: 'Select a shape, source or plane on the canvas, or an item in the model panel, to edit it here.' }));
            return;
        }
        if (s.kind === 'particle') { ed = particleInfo(sel, ctx, ids[0]); return; }
        if (s.kind === 'shape' && ids.length > 1) { ed = multiShapes(sel, ctx, app, ids); return; }
        const make = EDITORS[s.kind];
        if (!make) { sel.appendChild(h('p', { class: 'io-empty', text: 'Nothing to edit for this selection.' })); return; }
        try { ed = make(sel, ctx, app, ids[0]); } catch (e) {
            clear(sel);
            sel.appendChild(h('p', { class: 'io-empty', text: 'This item could not be shown: ' + (e && e.message ? e.message : e) }));
            if (app.log) app.log.add('error', e && e.message ? e.message : String(e));
        }
    }
    function update(evt) {
        const k = key();
        if (k !== curKey) {
            curKey = k;
            build();
            if (evt === 'selection' && isTablet() && !k.startsWith('null|')) app.openInspector && app.openInspector(false);
        } else if (ed && ed.update) ed.update();
        qf.sync();
        live.checked = store.get().ui.live !== false;
        const st = store.get();
        const r = st.resolved || st.lastResolved;
        count.textContent = r ? `${r.particleCount || 0} particle${r.particleCount === 1 ? '' : 's'} per run.` : '';
    }
    app.openInspector = (focus = true) => {
        if (!isTablet()) return;
        wb.classList.add('io-insp-open');
        if (focus) { const f = el.querySelector('input, select, textarea, button'); if (f) f.focus(); }
    };
    app.closeInspector = () => { wb.classList.remove('io-insp-open'); };
    const closeBtn = document.getElementById('io-inspector-close');
    if (closeBtn) closeBtn.addEventListener('click', () => { app.closeInspector(); const c = document.getElementById('io-canvas'); if (c) c.focus(); });
    document.getElementById('io-inspector')?.addEventListener('keydown', (e) => { if (e.key === 'Escape' && wb.classList.contains('io-insp-open')) { app.closeInspector(); e.stopPropagation(); } });
    update();
    const offs = ['project', 'resolved', 'run', 'ui'].map((evt) => store.on(evt, () => update(evt)));
    offs.push(store.on('selection', () => update('selection')));
    return { update, destroy: () => offs.forEach((f) => f()) };
}

function isTablet() { return typeof matchMedia === 'function' && matchMedia('(max-width: 1099.98px)').matches; }

function multiShapes(host, ctx, app, ids) {
    const p = ctx.store.get().project;
    const names = ids.map((id) => (p.shapes || []).find((s) => s.id === id)).filter(Boolean).map(shapeTitle);
    host.append(h('div', { class: 'io-insp-head' }, icon('shapes', 18), h('h3', { text: `${ids.length} shapes selected` })),
        h('p', { class: 'io-note', text: names.join(', ') }),
        h('p', { class: 'io-note', text: 'Drag on the canvas or use the arrow keys to move them together (Shift ×10, Alt ×0.1).' }));
    const del = h('button', { type: 'button', class: 'btn btn-secondary btn-sm io-danger' }, icon('trash', 16), h('span', { text: 'Delete all' }));
    del.addEventListener('click', () => { if (app.tools) app.tools.deleteSelection(); });
    const dup = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('copy', 16), h('span', { text: 'Duplicate all' }));
    dup.addEventListener('click', () => { if (app.tools) app.tools.duplicate(); });
    host.appendChild(h('div', { class: 'io-insp-actions' }, dup, del));
    return { update() {} };
}

/** Record of one traced particle (from the run's summary rows). */
function particleInfo(host, ctx, id) {
    const dl = h('dl', { class: 'io-kv' });
    host.append(h('div', { class: 'io-insp-head' }, icon('particles', 18), h('h3', { text: `Particle ${id}` })), dl);
    const clearBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Clear the highlight' });
    clearBtn.addEventListener('click', () => { ctx.view.highlightParticle(null); ctx.store.select({ kind: null, ids: [] }); });
    host.appendChild(clearBtn);
    function update() {
        clear(dl);
        const st = ctx.store.get();
        const res = st.run && st.run.result;
        const S = res ? summaryRows(res) : null;
        if (!S) { dl.append(h('dt', { text: 'Status' }), h('dd', { text: 'No run result.' })); return; }
        let i = -1;
        for (let k = 0; k < res.n; k++) if (S[k * S_STRIDE + S_ID] === id) { i = k; break; }
        if (i < 0) { dl.append(h('dt', { text: 'Status' }), h('dd', { text: 'Not in the current run.' })); return; }
        const o = i * S_STRIDE;
        const r = (res.resolvedSnapshot || st.resolved || st.lastResolved);
        const status = S[o + S_STATUS], where = S[o + S_WHERE];
        let whereText = '';
        const io = ctx.engine.io;
        if (io && typeof io.whereText === 'function') { try { whereText = io.whereText(status, where, r); } catch (e) { whereText = ''; } }
        if (!whereText && status === 1 && r && r.electrodes && r.electrodes[where]) whereText = r.electrodes[where].name || r.electrodes[where].id;
        const src = r && r.sources ? r.sources[S[o + S_SRC]] : null;
        const sp = src && src.species ? src.species[S[o + S_SPECIES]] : null;
        const rows = [
            ['Status', `${STATUS_WORDS[status] || STATUS_NAMES[status] || status}${whereText ? ` (${whereText})` : ''}`],
            ['Source', src ? src.name || src.id : String(S[o + S_SRC])],
            ['Species', sp ? sp.label || `${sp.mass} u` : String(S[o + S_SPECIES])],
            ['Flight time', formatPretty(S[o + S_TOF], 'time', 7)],
            ['End point', `(${fmt(S[o + S_X], 6)}, ${fmt(S[o + S_Y], 6)}, ${fmt(S[o + S_Z], 6)}) mm`],
            ['Start energy', formatPretty(S[o + S_KE0], 'energy', 7)],
            ['End energy', formatPretty(S[o + S_KE], 'energy', 7)],
            ['Energy error', Number.isFinite(S[o + S_DE_END]) ? formatPretty(S[o + S_DE_END], 'energy', 3) : 'n/a (time-dependent fields)'],
            ['Steps', String(S[o + S_STEPS])],
            ['Path length', formatPretty(S[o + S_PATH], 'length', 6)],
        ];
        for (const [k, v] of rows) dl.append(h('dt', { text: k }), h('dd', { text: v }));
    }
    update();
    return { update };
}
