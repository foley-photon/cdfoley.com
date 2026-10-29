/* ==========================================================================
   Ion optics UI: panels/recording.js
   Recording rail tab (spec §4.3, §2.2.2 recording): test planes and
   detectors (a detector records and stops particles), trajectory storage
   and time markers.
   ========================================================================== */
import { h, icon, clear } from '../dom.js';
import { bindForm, locate, nextId, displayValue } from '../forms.js';

const KIND_TEXT = { x: 'x =', y: 'y =', z: 'z =', r: 'r =', sphere: 'sphere r =' };

/** One-line description of a plane. */
export function planeSummary(p) {
    if (!p) return '';
    const where = p.kind === 'segment' ? `segment (${(p.p0 || []).map(displayValue).join(', ')}) → (${(p.p1 || []).map(displayValue).join(', ')})`
        : p.kind === 'sphere' ? `sphere r = ${displayValue(p.at)} mm about (${(p.center || [0, 0, 0]).map(displayValue).join(', ')})`
            : `${KIND_TEXT[p.kind] || p.kind} ${displayValue(p.at)} mm`;
    return `${where}${p.terminate ? ' · detector' : ''}${p.side && p.side !== 'both' ? ' · ' + p.side : ''}`;
}

/** Rail tab. */
export function mountRecording(host, ctx, app) {
    const { store } = ctx;
    const listEl = h('ul', { class: 'io-list', 'aria-label': 'Test planes and detectors' });
    const empty = h('p', { class: 'io-empty', text: 'No planes. A test plane records crossings; a detector also stops the particle.' });
    const addBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('plus', 16), h('span', { text: 'Add plane' }));
    addBtn.addEventListener('click', () => addPlane(ctx, app));
    const detail = h('div');
    const trj = bindForm(ctx, { kind: 'trajectories', label: 'Trajectory storage', idPrefix: 'io-trj', locate: (p) => (p.recording && p.recording.trajectories ? { obj: p.recording.trajectories, path: 'recording.trajectories' } : null),
        resolved: (r) => (r.recording ? r.recording.trajectories : null) });
    const tmToggle = h('input', { type: 'checkbox', id: 'io-tm-toggle' });
    tmToggle.addEventListener('change', () => ctx.commit((p) => {
        p.recording = p.recording || {};
        p.recording.timeMarkers = tmToggle.checked ? { dt: defaultDt(store) } : null;
    }, { label: tmToggle.checked ? 'Add time markers' : 'Remove time markers' }));
    const tmBox = h('div');
    host.append(
        h('h3', { class: 'io-group-title', text: 'Planes and detectors' }), listEl, empty, h('div', { class: 'io-add-row' }, addBtn), detail,
        h('h3', { class: 'io-group-title', text: 'Trajectories' }), trj.el,
        h('h3', { class: 'io-group-title', text: 'Time markers' }),
        h('label', { class: 'io-check', for: 'io-tm-toggle' }, tmToggle, h('span', { text: 'Mark positions at equal time steps' })), tmBox);
    let sig = '', rows = new Map(), ed = null, edId = null, tmForm = null, hadTm = null;
    function build() {
        const planes = (store.get().project.recording || {}).planes || [];
        sig = planes.map((p) => p.id).join('|');
        clear(listEl);
        rows = new Map();
        for (const pl of planes) {
            const li = h('li', { class: 'io-item' });
            const t = h('button', { type: 'button', class: 'io-item-title' });
            t.addEventListener('click', () => store.select({ kind: 'plane', ids: [pl.id] }));
            const badge = h('span', { class: 'badge', text: 'detector', hidden: true });
            const del = h('button', { type: 'button', class: 'io-mini', title: 'Delete', 'aria-label': `Delete ${pl.name || pl.id}` }, icon('trash', 16));
            del.addEventListener('click', () => {
                const r = ctx.commit((d) => { const L = locate(d, 'plane', pl.id); if (L) d.recording.planes.splice(L.index, 1); }, { label: 'Delete plane' });
                if (r.ok) store.select({ kind: null, ids: [] }); else if (ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' });
            });
            const sub = h('div', { class: 'io-item-sub' });
            li.append(h('div', { class: 'io-item-row' }, t, badge, h('span', { class: 'io-spacer' }), del), sub);
            rows.set(pl.id, { li, t, badge, sub });
            listEl.appendChild(li);
        }
        syncRows();
    }
    function syncRows() {
        const st = store.get();
        const rec = st.project.recording || {};
        const planes = rec.planes || [];
        empty.hidden = planes.length > 0;
        const sel = st.selection || {};
        for (const pl of planes) {
            const row = rows.get(pl.id);
            if (!row) continue;
            row.t.textContent = pl.name || pl.id;
            row.badge.hidden = !pl.terminate;
            row.sub.textContent = planeSummary(pl);
            row.li.classList.toggle('io-selected', sel.kind === 'plane' && (sel.ids || []).includes(pl.id));
        }
        const want = sel.kind === 'plane' && sel.ids && sel.ids.length === 1 ? sel.ids[0] : null;
        if (want !== edId) {
            clear(detail); ed = null; edId = want;
            if (want) { const box = h('div', { class: 'io-src-detail' }); detail.appendChild(box); ed = planeEditor(box, ctx, app, want); }
        } else if (ed) ed.update();
        trj.sync();
        const has = !!rec.timeMarkers;
        tmToggle.checked = has;
        if (has !== hadTm) {
            hadTm = has;
            clear(tmBox);
            tmForm = has ? bindForm(ctx, { kind: 'timeMarkers', label: 'Time markers', idPrefix: 'io-tm', locate: (p) => (p.recording && p.recording.timeMarkers ? { obj: p.recording.timeMarkers, path: 'recording.timeMarkers' } : null) }) : null;
            if (tmForm) tmBox.append(tmForm.el, h('p', { class: 'hint', text: 'Turn on the Time markers layer to see them.' }));
        } else if (tmForm) tmForm.sync();
    }
    function update() {
        const planes = (store.get().project.recording || {}).planes || [];
        const s = planes.map((p) => p.id).join('|');
        if (s !== sig) build(); else syncRows();
    }
    build();
    const offs = ['project', 'resolved', 'selection'].map((evt) => store.on(evt, update));
    return { update, destroy: () => offs.forEach((f) => f()) };
}

/**
 * Default marker interval: a twentieth of the longest flight of the last run, and at most a twentieth of the period of
 * the fastest drive (cosine terms, pulse and table periods, RF ideal fields), so the induced-current spectrum is not
 * aliased.
 */
function defaultDt(store) {
    const st = store.get();
    const res = st.run && st.run.result;
    let dt = 0.1;
    if (res && res.summary && ArrayBuffer.isView(res.summary)) {
        let tmax = 0;
        for (let i = 0; i < res.n; i++) tmax = Math.max(tmax, res.summary[i * 24 + 11] || 0);
        if (tmax > 0) dt = tmax / 20;
    }
    const r = st.resolved || st.lastResolved;
    let f = 0;
    for (const e of (r && r.electrodes) || []) for (const t of e.terms || []) {
        if (t && t.type === 'cos' && t.amp !== 0 && t.freq > f) f = t.freq;
        else if (t && (t.type === 'pulse' || t.type === 'table') && t.period > 0 && 1 / t.period > f) f = 1 / t.period;
    }
    for (const g of (r && r.idealFields) || []) if (g && g.V && g.freq > f) f = g.freq;
    if (f > 0) dt = Math.min(dt, 1 / (20 * f));
    return parseFloat(dt.toPrecision(2));
}

/** Adds an x plane at the view centre and selects it. */
export function addPlane(ctx, app) {
    const c = ctx.view.getViewState().center;
    let id = null;
    const r = ctx.commit((p) => {
        p.recording = p.recording || { planes: [], trajectories: { store: true, maxPoints: 2000 }, timeMarkers: null };
        p.recording.planes = p.recording.planes || [];
        id = nextId(p.recording.planes, 'p');
        p.recording.planes.push({ id, name: `Plane ${p.recording.planes.length + 1}`, kind: 'x', at: parseFloat(c[0].toPrecision(6)), limits: null, radius: null, terminate: false, side: 'both', record: 'first' });
    }, { label: 'Add plane' });
    if (r.ok) ctx.store.select({ kind: 'plane', ids: [id] }); else if (ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' });
    return r.ok ? id : null;
}

/** Inspector editor for a plane. */
export function planeEditor(host, ctx, app, id) {
    const { store } = ctx;
    const locP = (p) => locate(p, 'plane', id);
    const title = h('h3');
    host.appendChild(h('div', { class: 'io-insp-head' }, icon('plane', 18), title));
    const form = bindForm(ctx, {
        kind: 'plane', label: 'Edit plane', idPrefix: 'io-pl', locate: locP,
        resolved: (r) => ((r.recording && r.recording.planes) || []).find((x) => x.id === id) || null,
        merge: (key) => (key === 'at' ? 'plane:' + id : null),
        hide: (key, obj) => (key === 'at' && obj.kind === 'segment') || ((key === 'p0' || key === 'p1') && obj.kind !== 'segment') || (key === 'center' && obj.kind !== 'sphere')
            || (key === 'radius' && (obj.kind === 'segment' || obj.kind === 'r' || obj.kind === 'sphere')),
        intercept: (key, value, draft, L) => {
            if (key !== 'kind' || value === L.obj.kind) return false;
            const pl = L.obj;
            const c = ctx.view.getViewState().center;
            pl.kind = value;
            if (value === 'segment') { if (!Array.isArray(pl.p0)) pl.p0 = [round(c[0]), round(c[1] - 5)]; if (!Array.isArray(pl.p1)) pl.p1 = [round(c[0]), round(c[1] + 5)]; }
            else if (value === 'sphere') { if (!Array.isArray(pl.center)) pl.center = [round(c[0]), round(c[1]), 0]; if (!(pl.at > 0)) pl.at = 5; }
            else if (pl.at === undefined || pl.at === null) pl.at = value === 'x' ? round(c[0]) : value === 'r' ? Math.abs(round(c[1])) || 1 : round(c[1]);
            if (value === 'r' || value === 'segment' || value === 'sphere') pl.radius = null;
            return true;
        },
    });
    host.appendChild(form.el);
    host.appendChild(h('p', { class: 'hint', text: 'Segment planes are lines in the x–y (or x–r) plane, extruded or revolved; their forward normal is the segment direction turned by −90°.' }));
    function update() {
        const L = locP(store.get().project);
        if (!L) { clear(host); host.appendChild(h('p', { class: 'io-empty', text: 'This plane was deleted.' })); return; }
        title.textContent = L.obj.name || id;
        form.sync();
    }
    update();
    return { update };
}
function round(v) { return parseFloat(Number(v).toPrecision(6)); }
