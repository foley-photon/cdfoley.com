/* ==========================================================================
   Ion optics UI: panels/shapes.js
   Shapes rail tab (spec §4.3): the CSG list ("Later shapes win"), reordered
   by dragging the grip or with the up/down buttons, with an enabled eye, a
   lock, the electrode chip (or Void), duplicate and delete; buttons to add
   each shape type; geometry warnings from the last solve (clickable). The
   inspector editor adds the type's parameters, the transform, mirroring and
   conversion to a polygon.
   ========================================================================== */
import { h, icon, clear } from '../dom.js';
import { bindForm, locate, nextId } from '../forms.js';
import { compileGeometry } from '../../engine/geometry.js';

export const SHAPE_LABELS = Object.freeze({ box: 'Box', tube: 'Tube', plate: 'Plate', disc: 'Disc', circle: 'Circle', annulus: 'Annulus', polygon: 'Polygon', polyline: 'Line', quadric: 'Quadric' });
const ADD_TYPES = ['box', 'tube', 'plate', 'disc', 'circle', 'annulus', 'polygon', 'polyline', 'quadric'];

/** Display name of a shape. */
export function shapeTitle(s) { return (s && s.name) || `${SHAPE_LABELS[s && s.type] || (s && s.type) || 'Shape'} ${s ? s.id : ''}`; }

/** Electrode chip: colour swatch and name, or a dashed "Void". */
export function electrodeChip(project, id) {
    if (id === null || id === undefined) return h('span', { class: 'io-chip-el io-chip-void', title: 'Void: carves free space' }, 'Void');
    const e = (project.electrodes || []).find((x) => x.id === id);
    const sw = h('span', { class: 'io-swatch' });
    sw.style.background = e && /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#888888';
    return h('span', { class: 'io-chip-el', title: e ? `${e.name || id} (${id})` : id }, sw, e ? e.name || id : id);
}

/** Local centre of a numeric shape (pivot for mirroring). */
export function shapeCentre(s) {
    switch (s.type) {
        case 'box': return [(s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2];
        case 'tube': return [(s.x0 + s.x1) / 2, (s.rIn + s.rOut) / 2];
        case 'plate': return [s.x, (s.rHole + s.rOut) / 2];
        case 'disc': return [s.x, s.r / 2];
        case 'circle': case 'annulus': case 'quadric': return [s.cx, s.cy];
        case 'polygon': case 'polyline': {
            const P = s.points || [];
            let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
            for (const q of P) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
            return P.length ? [(x0 + x1) / 2, (y0 + y1) / 2] : [0, 0];
        }
        default: return [0, 0];
    }
}

/** Shape commands shared by the panel, the inspector and the shortcuts. */
export function shapeCommands(ctx, app) {
    const { store } = ctx;
    const toast = (m) => ctx.ui.toast && ctx.ui.toast(m, { kind: 'warn' });
    const res = () => { const st = store.get(); return st.resolved || st.lastResolved; };
    const rshape = (id) => { const r = res(); return r && r.shapes ? r.shapes.find((s) => s.id === id) : null; };
    return {
        toggle(id, key) {
            const r = ctx.commit((p) => { const L = locate(p, 'shape', id); if (L) L.obj[key] = key === 'enabled' ? L.obj.enabled === false : !L.obj.locked; }, { label: key === 'enabled' ? 'Show or hide shape' : 'Lock or unlock shape' });
            if (!r.ok) toast(r.error);
        },
        move(id, dir) {
            const r = ctx.commit((p) => {
                const L = locate(p, 'shape', id);
                if (!L) return;
                const j = L.index + dir;
                if (j < 0 || j >= p.shapes.length) return;
                const t = p.shapes[L.index]; p.shapes[L.index] = p.shapes[j]; p.shapes[j] = t;
            }, { label: dir > 0 ? 'Move later' : 'Move earlier' });
            if (!r.ok) toast(r.error);
        },
        moveTo(id, to) {
            const r = ctx.commit((p) => {
                const L = locate(p, 'shape', id);
                if (!L) return;
                const [item] = p.shapes.splice(L.index, 1);
                p.shapes.splice(Math.max(0, Math.min(p.shapes.length, to)), 0, item);
            }, { label: 'Reorder shapes' });
            if (!r.ok) toast(r.error);
        },
        duplicate(id) {
            let nid = null;
            const r = ctx.commit((p) => {
                const L = locate(p, 'shape', id);
                if (!L) return;
                const c = structuredClone(L.obj);
                c.id = nid = nextId(p.shapes, 's');
                if (c.name) c.name += ' copy';
                p.shapes.splice(L.index + 1, 0, c);
            }, { label: 'Duplicate shape' });
            if (r.ok) store.select({ kind: 'shape', ids: [nid] }); else toast(r.error);
        },
        remove(id) {
            const r = ctx.commit((p) => { const L = locate(p, 'shape', id); if (L) p.shapes.splice(L.index, 1); }, { label: 'Delete shape' });
            if (r.ok) { const sel = store.get().selection; if (sel.kind === 'shape') store.select({ kind: 'shape', ids: sel.ids.filter((x) => x !== id) }); } else toast(r.error);
        },
        mirror(id, axis) {
            const rs = rshape(id);
            const c = rs ? shapeCentre(rs) : [0, 0];
            const r = ctx.commit((p) => {
                const L = locate(p, 'shape', id);
                if (!L) return;
                const s = L.obj;
                if (!s.transform) s.transform = { translate: [0, 0], rotate: 0, about: [c[0], c[1]], mirror: 'none' };
                const m = s.transform.mirror || 'none';
                let mx = m === 'x' || m === 'xy', my = m === 'y' || m === 'xy';
                if (axis === 'x') mx = !mx; else my = !my;
                s.transform.mirror = mx && my ? 'xy' : mx ? 'x' : my ? 'y' : 'none';
            }, { label: 'Mirror shape' });
            if (!r.ok) toast(r.error);
        },
        toPolygon(id) {
            const rs = rshape(id);
            const R = res();
            if (!rs || !R) return false;
            if (rs.type === 'polygon' || rs.type === 'polyline') { toast(rs.type === 'polygon' ? 'This shape is already a polygon.' : 'A zero-thickness line cannot become a polygon.'); return false; }
            let outs = [];
            try { outs = compileGeometry({ domain: R.domain, electrodes: R.electrodes, shapes: [rs] }).outlines(2).filter((o) => o.closed && o.pts.length >= 6); } catch (e) { outs = []; }
            if (!outs.length) { toast('This shape has no closed outline inside the domain.'); return false; }
            const q = (v) => parseFloat(v.toPrecision(10));
            const r = ctx.commit((p) => {
                const L = locate(p, 'shape', id);
                if (!L) return;
                const base = L.obj;
                const polys = outs.map((o, k) => {
                    const pts = [];
                    for (let i = 0; i < o.pts.length; i += 2) pts.push([q(o.pts[i]), q(o.pts[i + 1])]);
                    const out = { id: k === 0 ? base.id : null, type: 'polygon', electrode: base.electrode === undefined ? 'gnd' : base.electrode, points: pts };
                    if (base.name) out.name = base.name;
                    if (base.enabled === false) out.enabled = false;
                    if (base.locked) out.locked = true;
                    return out;
                });
                p.shapes.splice(L.index, 1, ...polys);
                for (const s of polys) if (s.id === null) s.id = nextId(p.shapes, 's');
            }, { label: 'Convert to polygon' });
            if (!r.ok) toast(r.error); else if (ctx.ui.announce) ctx.ui.announce('Converted to a polygon.');
            return r.ok;
        },
        add(type) {
            if (app.tools && app.tools.addShapeAt) {
                const v = ctx.view.getViewState();
                return app.tools.addShapeAt(type, v.center);
            }
            return null;
        },
    };
}

/** Rail tab. */
export function mountShapes(host, ctx, app) {
    const { store } = ctx;
    const cmd = shapeCommands(ctx, app);
    const addRow = h('div', { class: 'io-add-row', role: 'group', 'aria-label': 'Add a shape' });
    for (const t of ADD_TYPES) {
        const b = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', title: `Add a ${SHAPE_LABELS[t].toLowerCase()} at the view center (or draw it with the canvas tools)` }, icon(t === 'polyline' ? 'line' : t, 16), h('span', { text: SHAPE_LABELS[t] }));
        b.addEventListener('click', () => cmd.add(t));
        addRow.appendChild(b);
    }
    const warnBox = h('ul', { class: 'io-warnings', 'aria-label': 'Geometry warnings', hidden: true });
    const listEl = h('ol', { class: 'io-list io-shape-list', 'aria-label': 'Shapes in painting order; later shapes win' });
    const empty = h('p', { class: 'io-empty', text: 'No shapes yet. Add one above or draw it on the canvas.' });
    host.append(
        h('p', { class: 'io-note' }, h('strong', { text: 'Later shapes win. ' }), 'Each shape paints over the ones before it; a Void carves free space. Drag the grip or use the arrows to change the order.'),
        addRow, warnBox, listEl, empty);
    let sig = '', rows = new Map();
    let dragState = null;

    function build() {
        const p = store.get().project;
        const shapes = p.shapes || [];
        sig = shapes.map((s) => s.id).join('|');
        clear(listEl);
        rows = new Map();
        shapes.forEach((s, i) => {
            const li = h('li', { class: 'io-item', dataset: { id: s.id } });
            const grip = h('span', { class: 'io-grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, icon('grip', 16));
            const eye = h('button', { type: 'button', class: 'io-mini', 'aria-pressed': 'true', title: 'Enabled' }, icon('eye', 16));
            const lock = h('button', { type: 'button', class: 'io-mini', 'aria-pressed': 'false', title: 'Lock (prevents canvas edits)' }, icon('unlock', 16));
            const title = h('button', { type: 'button', class: 'io-item-title' });
            const up = h('button', { type: 'button', class: 'io-mini', title: 'Earlier (paints under)' }, icon('up', 16));
            const down = h('button', { type: 'button', class: 'io-mini', title: 'Later (paints over)' }, icon('down', 16));
            const dup = h('button', { type: 'button', class: 'io-mini', title: 'Duplicate' }, icon('copy', 16));
            const del = h('button', { type: 'button', class: 'io-mini', title: 'Delete' }, icon('trash', 16));
            const chipBox = h('span', { class: 'io-chip-box' });
            const sub = h('div', { class: 'io-item-row io-item-sub' }, h('span', { class: 'io-order', text: `#${i + 1}` }), chipBox, up, down, dup, del);
            li.append(h('div', { class: 'io-item-row' }, grip, eye, lock, title), sub);
            eye.addEventListener('click', () => cmd.toggle(s.id, 'enabled'));
            lock.addEventListener('click', () => cmd.toggle(s.id, 'locked'));
            title.addEventListener('click', (e) => {
                const sel = store.get().selection;
                if (e.shiftKey && sel.kind === 'shape') store.select({ kind: 'shape', ids: sel.ids.includes(s.id) ? sel.ids.filter((x) => x !== s.id) : [...sel.ids, s.id] });
                else store.select({ kind: 'shape', ids: [s.id] });
                app.openInspector && app.openInspector();
            });
            up.addEventListener('click', () => cmd.move(s.id, -1));
            down.addEventListener('click', () => cmd.move(s.id, 1));
            dup.addEventListener('click', () => cmd.duplicate(s.id));
            del.addEventListener('click', () => cmd.remove(s.id));
            grip.addEventListener('pointerdown', (e) => startDrag(e, s.id, li));
            rows.set(s.id, { li, eye, lock, title, chipBox, up, down, dup, del });
            listEl.appendChild(li);
        });
        syncRows();
    }
    function syncRows() {
        const st = store.get(), p = st.project;
        const shapes = p.shapes || [];
        empty.hidden = shapes.length > 0;
        const sel = st.selection || {};
        shapes.forEach((s, i) => {
            const row = rows.get(s.id);
            if (!row) return;
            const name = shapeTitle(s);
            row.title.textContent = name;
            const on = s.enabled !== false;
            row.eye.setAttribute('aria-pressed', on ? 'true' : 'false');
            row.eye.setAttribute('aria-label', `${name}: ${on ? 'enabled' : 'disabled'}`);
            row.eye.replaceChildren(icon(on ? 'eye' : 'eyeOff', 16));
            row.lock.setAttribute('aria-pressed', s.locked ? 'true' : 'false');
            row.lock.setAttribute('aria-label', `${name}: ${s.locked ? 'locked' : 'unlocked'}`);
            row.lock.replaceChildren(icon(s.locked ? 'lock' : 'unlock', 16));
            row.li.classList.toggle('io-disabled', !on);
            row.li.classList.toggle('io-selected', sel.kind === 'shape' && (sel.ids || []).includes(s.id));
            row.li.setAttribute('aria-current', sel.kind === 'shape' && (sel.ids || []).includes(s.id) ? 'true' : 'false');
            row.chipBox.replaceChildren(electrodeChip(p, s.electrode === undefined ? 'gnd' : s.electrode));
            row.up.disabled = i === 0; row.down.disabled = i === shapes.length - 1;
            row.up.setAttribute('aria-label', `Move ${name} earlier`); row.down.setAttribute('aria-label', `Move ${name} later`);
            row.dup.setAttribute('aria-label', `Duplicate ${name}`); row.del.setAttribute('aria-label', `Delete ${name}`);
        });
        syncWarnings();
    }
    function syncWarnings() {
        const warns = currentWarnings(ctx);
        clear(warnBox);
        warnBox.hidden = !warns.length;
        for (const w of warns.slice(0, 30)) {
            const b = h('button', { type: 'button', class: w.severity === 'error' ? 'io-err' : '' }, w.message || w.code);
            b.addEventListener('click', () => selectIssue(ctx, app, w));
            warnBox.appendChild(h('li', null, b));
        }
    }
    function startDrag(e, id, li) {
        e.preventDefault();
        const grip = e.currentTarget;
        try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        dragState = { id, li, target: null };
        li.classList.add('io-dragging');
        const move = (ev) => {
            const items = [...listEl.children];
            let to = items.length;
            for (let k = 0; k < items.length; k++) {
                const r = items[k].getBoundingClientRect();
                if (ev.clientY < r.top + r.height / 2) { to = k; break; }
            }
            items.forEach((it, k) => it.classList.toggle('io-drop-before', k === to && it !== li));
            dragState.target = to;
        };
        const up = () => {
            grip.removeEventListener('pointermove', move);
            grip.removeEventListener('pointerup', up);
            grip.removeEventListener('pointercancel', up);
            li.classList.remove('io-dragging');
            for (const it of listEl.children) it.classList.remove('io-drop-before');
            const st = dragState;
            dragState = null;
            if (!st || st.target === null) return;
            const from = (store.get().project.shapes || []).findIndex((s) => s.id === st.id);
            let to = st.target;
            if (to > from) to -= 1;
            if (from >= 0 && to !== from) cmd.moveTo(st.id, to);
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
        grip.addEventListener('pointercancel', up);
    }
    function update() {
        const s = (store.get().project.shapes || []).map((x) => x.id).join('|');
        if (s !== sig) build(); else syncRows();
    }
    build();
    const offs = ['project', 'selection', 'solve'].map((evt) => store.on(evt, update));
    return { update, destroy: () => offs.forEach((f) => f()) };
}

/** Geometry warnings of the current solution (project paths). */
export function currentWarnings(ctx) {
    const st = ctx.store.get();
    let w = st.solve && Array.isArray(st.solve.warnings) ? st.solve.warnings : null;
    if (!w && ctx.jobs && typeof ctx.jobs.geometryWarnings === 'function') { try { w = ctx.jobs.geometryWarnings(); } catch (e) { w = null; } }
    return Array.isArray(w) ? w.filter((x) => x && (x.message || x.code)) : [];
}

/** Selects the object an issue path points to and shows it. */
export function selectIssue(ctx, app, w) {
    const m = /^(shapes|sources|magnets|electrodes|idealFields)\[(\d+)\]/.exec(w.path || '');
    if (!m) return;
    const p = ctx.store.get().project;
    const kind = { shapes: 'shape', sources: 'source', magnets: 'magnet', electrodes: 'electrode', idealFields: 'idealField' }[m[1]];
    const obj = (p[m[1]] || [])[Number(m[2])];
    if (obj && obj.id) { ctx.store.select({ kind, ids: [obj.id] }); app.openInspector && app.openInspector(); }
}

/** Inspector editor for one shape. */
export function shapeEditor(host, ctx, app, id) {
    const { store } = ctx;
    const cmd = shapeCommands(ctx, app);
    const p0 = store.get().project;
    const L0 = locate(p0, 'shape', id);
    if (!L0) { host.appendChild(h('p', { class: 'io-empty', text: 'This shape was deleted.' })); return { update() {} }; }
    const type = L0.obj.type;
    const title = h('h3');
    const chip = h('span', { class: 'io-chip-box' });
    host.appendChild(h('div', { class: 'io-insp-head' }, icon(type === 'polyline' ? 'line' : type, 18), title, chip));
    const locS = (p) => locate(p, 'shape', id);
    const resS = (r) => (r.shapes || []).find((s) => s.id === id) || null;
    const common = bindForm(ctx, { kind: 'shape', label: 'Edit shape', idPrefix: 'io-sh', locate: locS, resolved: resS });
    const params = bindForm(ctx, { kind: 'shape', sub: type, label: 'Edit shape', idPrefix: 'io-sp', locate: locS, resolved: resS, merge: (key) => `shape:${id}:${key}` });
    host.append(params.el, h('div', { class: 'io-insp-section' }, common.el));
    // transform
    const trBox = h('div');
    const trDetails = h('details', { class: 'io-card io-insp-section' }, h('summary', { text: 'Transform (mirror, rotate, translate)' }), trBox);
    host.appendChild(trDetails);
    let trForm = null;
    const addTr = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Add a transform' });
    addTr.addEventListener('click', () => {
        const rs = resS(store.get().resolved || store.get().lastResolved || { shapes: [] });
        const c = rs ? shapeCentre(rs) : [0, 0];
        ctx.commit((p) => { const L = locS(p); if (L) L.obj.transform = { translate: [0, 0], rotate: 0, about: [c[0], c[1]], mirror: 'none' }; }, { label: 'Add transform' });
    });
    const rmTr = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Remove the transform' });
    rmTr.addEventListener('click', () => ctx.commit((p) => { const L = locS(p); if (L) delete L.obj.transform; }, { label: 'Remove transform' }));
    // actions
    const act = (label, ic, fn, extra = '') => { const b = h('button', { type: 'button', class: `btn btn-secondary btn-sm ${extra}` }, ic ? icon(ic, 16) : null, h('span', { text: label })); b.addEventListener('click', fn); return b; };
    const actions = h('div', { class: 'io-insp-actions' },
        act('Flip x', 'mirror', () => cmd.mirror(id, 'x')), act('Flip y', 'mirror', () => cmd.mirror(id, 'y')),
        act('To polygon', 'polygon', () => cmd.toPolygon(id)), act('Duplicate', 'copy', () => cmd.duplicate(id)),
        act('Earlier', 'up', () => cmd.move(id, -1)), act('Later', 'down', () => cmd.move(id, 1)),
        act('Delete', 'trash', () => cmd.remove(id), 'io-danger'));
    host.appendChild(actions);
    let hadTr = null;
    function update() {
        const p = store.get().project;
        const L = locS(p);
        if (!L) { clear(host); host.appendChild(h('p', { class: 'io-empty', text: 'This shape was deleted.' })); return; }
        if (L.obj.type !== type) { clear(host); shapeEditor(host, ctx, app, id); return; }
        title.textContent = shapeTitle(L.obj);
        chip.replaceChildren(electrodeChip(p, L.obj.electrode === undefined ? 'gnd' : L.obj.electrode));
        common.sync(); params.sync();
        const has = !!L.obj.transform;
        if (has !== hadTr) {
            hadTr = has;
            clear(trBox);
            trForm = null;
            if (has) {
                trForm = bindForm(ctx, { kind: 'transform', label: 'Edit transform', idPrefix: 'io-tr', locate: (pp) => { const LL = locS(pp); return LL && LL.obj.transform ? { obj: LL.obj.transform, path: `${LL.path}.transform` } : null; }, resolved: (r) => { const s = resS(r); return s ? s.transform : null; } });
                trBox.append(trForm.el, rmTr);
            } else trBox.append(h('p', { class: 'io-note', text: 'Mirror, then rotate about the pivot, then translate. Dragging a transformed shape moves its translation, so parametric values stay unchanged.' }), addTr);
        }
        if (trForm) trForm.sync();
        trDetails.open = trDetails.open || has;
    }
    update();
    return { update };
}
