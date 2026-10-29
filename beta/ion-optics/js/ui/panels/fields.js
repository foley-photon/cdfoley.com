/* ==========================================================================
   Ion optics UI: panels/fields.js
   Fields rail tab (spec §4.3, §2.2.2): magnets (uniform field, hard-edged
   field region, current loop, pole pieces described by a magnetic scalar
   potential ψ, each piece a region with its ψ in T·mm) with a helper for
   planar sector magnets that
   sets the region and the flux density for a chosen ion, and, under
   "Advanced", ideal analytic fields that are added to the solved field.
   Bending radius r = γm|v|/(|q|B) from the engine constants (cyclotron()).
   ========================================================================== */
import { h, icon, clear } from '../dom.js';
import { bindForm, locate, nextId, parseScalar, metaFor } from '../forms.js';
import { formatPretty } from '../units.js';
import { cyclotron } from '../../engine/constants.js';

const MAGNET_TYPES = [['uniform', 'Uniform field'], ['region', 'Field region (sharp edges)'], ['loop', 'Current loop'], ['poles', 'Pole pieces (scalar potential)']];
const DEFAULT_MAGNET_NAMES = new Set(['Uniform field', 'Field region', 'Current loop', 'Pole pieces']);
const IDEAL_TYPES = [['uniformE', 'Uniform E'], ['quadrupole2d', 'Quadrupole (2D)'], ['quadrupole3d', 'Quadrupole (3D, axis x)'], ['coax', 'Coaxial (log)'], ['sphere', 'Spherical (A + B/r)']];

/** Schema defaults of a kind for the project's domain type (planar projects get planar pole pieces), else the fallback. */
function defaultsOf(ctx, kind, fallback) {
    const p = ctx.store && ctx.store.get().project;
    const dt = p && p.domain && p.domain.type === 'planar2d' ? 'planar2d' : 'cyl2d';
    try { const d = ctx.engine.schema.defaults(kind, dt); if (d && typeof d === 'object' && Object.keys(d).length) return d; } catch (e) { /* not known */ }
    const f = typeof fallback === 'function' ? fallback(dt === 'cyl2d') : fallback;
    return structuredClone(f);
}
const MAG_FALLBACK = {
    uniform: { type: 'uniform', B: [0, 0, 0.01] },
    region: { type: 'region', B: [0, 0, 0.01], region: { type: 'box', x0: -10, x1: 10, y0: -10, y1: 10 } },
    loop: { type: 'loop', center: [0, 0, 0], normal: [1, 0, 0], radius: 10, turns: 1, current: 1 },
    // pole pieces: a gap of 10 mm (planar: centered on y = 0 with ψ = ±1 T·mm; cylindrical: two pieces above the axis)
    poles: (cyl) => ({ type: 'poles', boundary: 'neumann', pieces: [{ region: { type: 'box', x0: -10, x1: 10, y0: 5, y1: 8 }, psi: 1 },
        { region: { type: 'box', x0: -10, x1: 10, y0: cyl ? 12 : -8, y1: cyl ? 15 : -5 }, psi: cyl ? 0 : -1 }] }),
};
const POLE_FALLBACK = { region: { type: 'box', x0: -10, x1: 10, y0: 5, y1: 8 }, psi: 1 };
const REGION_FALLBACK = { box: { type: 'box', x0: -10, x1: 10, y0: 0, y1: 10 }, polygon: { type: 'polygon', points: [[0, 0], [20, 0], [0, 20]] }, annulus: { type: 'annulus', cx: 0, cy: 0, rIn: 50, rOut: 150, a0: 0, a1: 90 } };
const IDEAL_FALLBACK = {
    uniformE: { type: 'uniformE', E: [1, 0, 0], ref: [0, 0, 0], box: null },
    quadrupole2d: { type: 'quadrupole2d', center: [0, 0], r0: 4, U: 0, V: 100, freq: 1, phase: 0 },
    quadrupole3d: { type: 'quadrupole3d', center: [0, 0, 0], r0: 7, z0: 5, U: 0, V: 100, freq: 1, phase: 0 },
    coax: { type: 'coax', center: [0, 0], a: 10, b: 20, Va: 100, Vb: 0 },
    sphere: { type: 'sphere', center: [0, 0, 0], R1: 10, R2: 20, V1: 100, V2: 0 },
};

/** A list of items with an editor for the selected one (magnets or ideal fields). */
function itemSection(ctx, app, { kind, listKey, title, types, prefix, emptyText, editor, describe, extraButtons = [] }) {
    const { store } = ctx;
    const wrap = h('div', { class: 'io-section' });
    const listEl = h('ul', { class: 'io-list', 'aria-label': title });
    const empty = h('p', { class: 'io-empty', text: emptyText });
    const typeSel = h('select', { class: 'io-select', 'aria-label': `Kind of ${title.toLowerCase()} to add` }, ...types.map(([v, t]) => h('option', { value: v, text: t })));
    const addBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('plus', 16), h('span', { text: 'Add' }));
    addBtn.addEventListener('click', () => {
        const t = typeSel.value;
        let id = null;
        const base = kind === 'magnet' ? defaultsOf(ctx, 'magnet.' + t, MAG_FALLBACK[t]) : defaultsOf(ctx, 'ideal.' + t, IDEAL_FALLBACK[t]);
        const r = ctx.commit((p) => {
            const list = p[listKey] || (p[listKey] = []);
            id = nextId(list, prefix);
            const obj = { ...base, id, enabled: true };
            if (kind === 'magnet') {
                obj.name = obj.name && !DEFAULT_MAGNET_NAMES.has(obj.name) ? obj.name : `${t === 'poles' ? 'Pole pieces' : types.find((x) => x[0] === t)[1]} ${list.length + 1}`;
                if (p.domain && p.domain.type === 'cyl2d' && Array.isArray(obj.B)) obj.B = [obj.B[0] || obj.B[2] || 0.01, 0, 0];
            }
            list.push(obj);
        }, { label: `Add ${kind === 'magnet' ? 'magnet' : 'ideal field'}` });
        if (r.ok) store.select({ kind, ids: [id] }); else if (ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' });
    });
    const detail = h('div');
    wrap.append(listEl, empty, h('div', { class: 'io-add-row' }, typeSel, addBtn, ...extraButtons), detail);
    let sig = '', rows = new Map(), ed = null, edId = null;
    function build() {
        const list = store.get().project[listKey] || [];
        sig = list.map((m) => m.id + ':' + m.type).join('|');
        clear(listEl);
        rows = new Map();
        for (const m of list) {
            const li = h('li', { class: 'io-item' });
            const en = h('input', { type: 'checkbox', 'aria-label': `Enable ${m.name || m.id}` });
            en.addEventListener('change', () => ctx.commit((d) => { const L = locate(d, kind, m.id); if (L) L.obj.enabled = en.checked; }, { label: 'Enable' }));
            const t = h('button', { type: 'button', class: 'io-item-title' });
            t.addEventListener('click', () => store.select({ kind, ids: [m.id] }));
            const del = h('button', { type: 'button', class: 'io-mini', title: 'Delete', 'aria-label': `Delete ${m.name || m.id}` }, icon('trash', 16));
            del.addEventListener('click', () => { const r = ctx.commit((d) => { const L = locate(d, kind, m.id); if (L) d[listKey].splice(L.index, 1); }, { label: 'Delete' }); if (r.ok) store.select({ kind: null, ids: [] }); });
            const sub = h('div', { class: 'io-item-sub' });
            li.append(h('div', { class: 'io-item-row' }, en, t, h('span', { class: 'io-spacer' }), del), sub);
            rows.set(m.id, { li, en, t, sub });
            listEl.appendChild(li);
        }
        syncRows();
    }
    function syncRows() {
        const st = store.get();
        const list = st.project[listKey] || [];
        empty.hidden = list.length > 0;
        const sel = st.selection || {};
        for (const m of list) {
            const row = rows.get(m.id);
            if (!row) continue;
            row.en.checked = m.enabled !== false;
            row.t.textContent = m.name || `${(types.find((x) => x[0] === m.type) || [0, m.type])[1]} (${m.id})`;
            row.sub.textContent = describe(m);
            row.li.classList.toggle('io-selected', sel.kind === kind && (sel.ids || []).includes(m.id));
        }
        const want = sel.kind === kind && sel.ids && sel.ids.length === 1 ? sel.ids[0] : null;
        if (want !== edId) {
            clear(detail); ed = null; edId = want;
            if (want) { const box = h('div', { class: 'io-src-detail' }); detail.appendChild(box); ed = editor(box, ctx, app, want); }
        } else if (ed) ed.update();
    }
    function update() {
        const list = store.get().project[listKey] || [];
        const s = list.map((m) => m.id + ':' + m.type).join('|');
        if (s !== sig) build(); else syncRows();
    }
    build();
    return { el: wrap, update };
}

function describeMagnet(m) {
    const B = Array.isArray(m.B) ? m.B : null;
    const bTxt = B ? `B = (${B.map((v) => (typeof v === 'number' ? formatPretty(v, 'flux', 3) : v)).join(', ')})` : '';
    if (m.type === 'uniform') return `Uniform · ${bTxt}`;
    if (m.type === 'region') return `${m.region ? m.region.type : 'region'} · ${bTxt}`;
    if (m.type === 'loop') return `Loop r = ${typeof m.radius === 'number' ? formatPretty(m.radius, 'length', 4) : m.radius}, ${typeof m.current === 'number' ? formatPretty(m.current, 'current', 4) : m.current} × ${m.turns || 1}`;
    if (m.type === 'poles') return describePoles(m);
    return m.type;
}
/** "2 pole pieces · ψ −1 to 1 T·mm (Δψ 2 T·mm)" (expressions are listed as written). */
export function describePoles(m) {
    const pieces = Array.isArray(m.pieces) ? m.pieces : [];
    const n = pieces.length;
    const head = `${n} pole piece${n === 1 ? '' : 's'}`;
    const psi = pieces.map((p) => p && p.psi);
    if (!n) return head;
    if (psi.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        const lo = Math.min(...psi), hi = Math.max(...psi);
        const f = (v) => formatPretty(v, 'none', 4);
        return lo === hi ? `${head} · ψ ${f(lo)} T·mm` : `${head} · ψ ${f(lo)} to ${f(hi)} T·mm (Δψ ${f(hi - lo)} T·mm)`;
    }
    return `${head} · ψ ${psi.map((v) => (v === undefined || v === null ? '?' : String(v))).join(', ')} T·mm`;
}
function describeIdeal(f) { return (IDEAL_TYPES.find((x) => x[0] === f.type) || [0, f.type])[1]; }

/** Rail tab. */
export function mountFields(host, ctx, app) {
    const { store } = ctx;
    const wedgeBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: 'Sector magnet for a chosen ion' }, icon('magnet', 16), h('span', { text: 'Sector helper' }));
    wedgeBtn.addEventListener('click', () => openWedgeHelper(ctx, app));
    const mags = itemSection(ctx, app, { kind: 'magnet', listKey: 'magnets', title: 'Magnets', types: MAGNET_TYPES, prefix: 'm', emptyText: 'No magnetic fields.', editor: magnetEditor, describe: describeMagnet, extraButtons: [wedgeBtn] });
    const ideals = itemSection(ctx, app, { kind: 'idealField', listKey: 'idealFields', title: 'Ideal fields', types: IDEAL_TYPES, prefix: 'f', emptyText: 'No ideal fields.', editor: idealEditor, describe: describeIdeal });
    const adv = h('details', { class: 'io-card' }, h('summary', { text: 'Advanced: ideal analytic fields' }),
        h('p', { class: 'io-note', text: 'Analytic fields are added to the solved electrode field everywhere (also outside the grid when boxed). Use them for idealised tests; real devices should be drawn as electrodes.' }), ideals.el);
    host.append(
        h('p', { class: 'io-note', text: 'Field regions have sharp edges; pole pieces give fringe fields (B = −∇ψ solved on the domain grid between iron pieces at fixed ψ). In cylindrical domains uniform fields and field regions allow only an axial field Bx.' }),
        h('h3', { class: 'io-group-title', text: 'Magnets' }), mags.el, adv);
    const update = () => { mags.update(); ideals.update(); if ((store.get().project.idealFields || []).length) adv.open = true; };
    update();
    const offs = ['project', 'resolved', 'selection'].map((evt) => store.on(evt, update));
    return { update, destroy: () => offs.forEach((f) => f()) };
}

/** Inspector editor for a magnet. */
export function magnetEditor(host, ctx, app, id) {
    const { store } = ctx;
    const locM = (p) => locate(p, 'magnet', id);
    const resM = (r) => (r.magnets || []).find((m) => m.id === id) || null;
    const title = h('h3');
    host.appendChild(h('div', { class: 'io-insp-head' }, icon('magnet', 18), title));
    const common = bindForm(ctx, {
        kind: 'magnet', label: 'Edit magnet', idPrefix: 'io-mg', locate: locM, resolved: resM,
        intercept: (key, value, draft, L) => {
            if (key !== 'type' || value === L.obj.type) return false;
            const base = defaultsOf(ctx, 'magnet.' + value, MAG_FALLBACK[value]);
            const keep = { id: L.obj.id, name: L.obj.name, enabled: L.obj.enabled };
            const next = { ...base, ...keep, type: value };
            if (draft.domain && draft.domain.type === 'cyl2d' && Array.isArray(next.B)) next.B = [next.B[0] || next.B[2] || 0.01, 0, 0];
            draft.magnets[L.index] = next;
            return true;
        },
    });
    host.appendChild(common.el);
    const typeBox = h('div');
    host.appendChild(typeBox);
    let tForm = null, rForm = null, tType = null, rType = null, poles = null;
    function update() {
        const L = locM(store.get().project);
        if (!L) { clear(host); host.appendChild(h('p', { class: 'io-empty', text: 'This magnet was deleted.' })); return; }
        title.textContent = L.obj.name || id;
        common.sync();
        const t = L.obj.type, rt = L.obj.region ? L.obj.region.type : null;
        if (t !== tType || rt !== rType) {
            tType = t; rType = rt;
            clear(typeBox);
            tForm = bindForm(ctx, {
                kind: 'magnet', sub: t, label: 'Edit magnet', idPrefix: 'io-mt', locate: locM, resolved: resM,
                intercept: (key, value, draft, LL) => {
                    if (key !== 'region.type') return false;
                    LL.obj.region = { ...defaultsOf(ctx, 'region.' + value, REGION_FALLBACK[value]), type: value };
                    return true;
                },
            });
            typeBox.appendChild(tForm.el);
            if (t === 'region') {
                if (!tForm.fields.has('region.type')) {
                    const sel = h('select', { class: 'io-select', 'aria-label': 'Region shape' }, ...['box', 'polygon', 'annulus'].map((v) => h('option', { value: v, text: v === 'annulus' ? 'Annulus sector' : v[0].toUpperCase() + v.slice(1) })));
                    sel.value = rt || 'box';
                    sel.addEventListener('change', () => ctx.commit((p) => { const M = locM(p); if (M) M.obj.region = { ...defaultsOf(ctx, 'region.' + sel.value, REGION_FALLBACK[sel.value]), type: sel.value }; }, { label: 'Region shape' }));
                    typeBox.appendChild(h('div', { class: 'field' }, h('label', { text: 'Region shape' }), sel));
                }
                rForm = rt ? bindForm(ctx, { kind: 'region', sub: rt, label: 'Edit region', idPrefix: 'io-mr',
                    locate: (p) => { const M = locM(p); return M && M.obj.region ? { obj: M.obj.region, path: `${M.path}.region` } : null; },
                    resolved: (r) => { const m = resM(r); return m ? m.region : null; } }) : null;
                if (rForm) typeBox.appendChild(h('div', { class: 'io-card' }, h('div', { class: 'io-card-title', text: 'Region (plane coordinates)' }), rForm.el));
            } else rForm = null;
            if (t === 'poles') { poles = polesEditor(typeBox, ctx, locM, resM); } else poles = null;
            typeBox.appendChild(radiusNote);
        } else { tForm.sync(); if (rForm) rForm.sync(); if (poles) poles.update(); }
        updateRadiusNote();
    }
    const radiusNote = h('p', { class: 'io-note' });
    function updateRadiusNote() {
        const st = store.get();
        const r = st.resolved || st.lastResolved;
        const m = r ? resM(r) : null;
        const src = r && r.sources && r.sources[0];
        if (!m || !Array.isArray(m.B) || !src || !src.species || !src.species.length) { radiusNote.textContent = ''; return; }
        const B = Math.hypot(m.B[0], m.B[1], m.B[2]);
        const sp = src.species[0];
        const ke = src.energy && src.energy.type === 'mono' ? src.energy.ke : src.energy && src.energy.mean;
        if (!(B > 0) || !(ke > 0)) { radiusNote.textContent = ''; return; }
        const c = cyclotron(sp.mass, sp.charge, B, ke, r.tracer ? r.tracer.relativistic !== false : true);
        radiusNote.textContent = `For ${sp.label || sp.mass + ' u'} at ${formatPretty(ke, 'energy', 4)}: bending radius ${formatPretty(c.radiusMM, 'length', 5)}, cyclotron frequency ${formatPretty(c.freqMHz, 'freq', 5)}.`;
    }
    update();
    return { update };
}

/**
 * Editor of the pieces of a 'poles' magnet: one card per piece with its shape (box, polygon, annulus sector: the same
 * region forms as a field region), its scalar potential ψ (T·mm), and buttons to add and delete pieces.
 * @returns {{ update(): void }}
 */
/** The pole-piece descriptors with the unit of ψ in its label. */
function poleDescs(ctx) {
    return metaFor(ctx.engine && ctx.engine.schema && ctx.engine.schema.META, 'pole').map((d) => (d.key === 'psi' && !/T·mm/.test(d.label) ? { ...d, label: `${d.label} (T·mm)` } : d));
}
function polesEditor(host, ctx, locM, resM) {
    const { store } = ctx;
    const box = h('div', { class: 'io-card io-poles' });
    const head = h('div', { class: 'io-card-title', text: 'Pole pieces (plane coordinates)' });
    const note = h('p', { class: 'io-note', text: 'Each piece is iron at a fixed magnetic scalar potential ψ; B = −∇ψ in the gaps (about |Δψ|/gap in tesla). Pieces are not obstacles for particles; mirror and anti-mirror planes of the domain apply to ψ too.' });
    const list = h('div', { class: 'io-poles-list' });
    const addBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('plus', 16), h('span', { text: 'Add piece' }));
    box.append(head, note, list, h('div', { class: 'io-add-row' }, addBtn));
    host.appendChild(box);
    const pieceLoc = (j) => (p) => { const M = locM(p); const pc = M && Array.isArray(M.obj.pieces) ? M.obj.pieces[j] : null; return pc ? { obj: pc, path: `${M.path}.pieces[${j}]` } : null; };
    const pieceRes = (j) => (r) => { const m = resM(r); return m && Array.isArray(m.pieces) ? m.pieces[j] || null : null; };
    addBtn.addEventListener('click', () => {
        const r = ctx.commit((p) => {
            const M = locM(p);
            if (!M) return;
            const pcs = M.obj.pieces || (M.obj.pieces = []);
            const last = pcs[pcs.length - 1];
            // a new piece next to the last box (or the default one), at ψ = 0
            const lr = last && last.region;
            const nb = lr && lr.type === 'box' && [lr.x0, lr.x1, lr.y0, lr.y1].every((v) => typeof v === 'number')
                ? { region: { type: 'box', x0: lr.x0, x1: lr.x1, y0: Math.max(lr.y0, lr.y1) + 5, y1: Math.max(lr.y0, lr.y1) + 8 }, psi: 0 }
                : { ...defaultsOf(ctx, 'pole', POLE_FALLBACK), psi: 0 };
            pcs.push(nb);
        }, { label: 'Add pole piece' });
        if (!r.ok && ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' });
    });
    let sig = null, forms = [];
    function build(pieces) {
        clear(list);
        forms = [];
        pieces.forEach((pc, j) => {
            const rt = pc && pc.region ? pc.region.type || 'box' : 'box';
            const card = h('div', { class: 'io-pole-piece' });
            const del = h('button', { type: 'button', class: 'io-mini', title: 'Delete this piece', 'aria-label': `Delete pole piece ${j + 1}` }, icon('trash', 16));
            del.disabled = pieces.length <= 1;
            del.addEventListener('click', () => {
                const r = ctx.commit((p) => { const M = locM(p); if (M && Array.isArray(M.obj.pieces)) M.obj.pieces.splice(j, 1); }, { label: 'Delete pole piece' });
                if (!r.ok && ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' });
            });
            card.appendChild(h('div', { class: 'io-item-row' }, h('strong', { text: `Piece ${j + 1}` }), h('span', { class: 'io-spacer' }), del));
            const pf = bindForm(ctx, {
                kind: 'pole', descs: poleDescs(ctx), label: 'Edit pole piece', idPrefix: `io-pp${j}`, locate: pieceLoc(j), resolved: pieceRes(j),
                intercept: (key, value, draft, L) => {
                    if (key !== 'region.type') return false;
                    if (L.obj.region && L.obj.region.type === value) return true;
                    L.obj.region = { ...defaultsOf(ctx, 'region.' + value, REGION_FALLBACK[value]), type: value };
                    return true;
                },
            });
            card.appendChild(pf.el);
            const rf = bindForm(ctx, { kind: 'region', sub: rt, label: 'Edit pole piece', idPrefix: `io-ppr${j}`,
                locate: (p) => { const L = pieceLoc(j)(p); return L && L.obj.region ? { obj: L.obj.region, path: `${L.path}.region` } : null; },
                resolved: (r) => { const pc = pieceRes(j)(r); return pc ? pc.region : null; } });
            card.appendChild(rf.el);
            forms.push(pf, rf);
            list.appendChild(card);
        });
    }
    function update() {
        const M = locM(store.get().project);
        const pieces = M && Array.isArray(M.obj.pieces) ? M.obj.pieces : [];
        const s = pieces.map((pc) => (pc && pc.region ? pc.region.type || 'box' : '-')).join('|');
        if (s !== sig) { sig = s; build(pieces); } else for (const f of forms) f.sync();
    }
    update();
    return { update };
}

/** Inspector editor for an ideal field. */
export function idealEditor(host, ctx, app, id) {
    const { store } = ctx;
    const locF = (p) => locate(p, 'idealField', id);
    const resF = (r) => (r.idealFields || []).find((m) => m.id === id) || null;
    const title = h('h3');
    host.appendChild(h('div', { class: 'io-insp-head' }, icon('wave', 18), title));
    const common = bindForm(ctx, {
        kind: 'idealField', label: 'Edit ideal field', idPrefix: 'io-if', locate: locF, resolved: resF,
        intercept: (key, value, draft, L) => {
            if (key !== 'type' || value === L.obj.type) return false;
            draft.idealFields[L.index] = { ...defaultsOf(ctx, 'ideal.' + value, IDEAL_FALLBACK[value]), id: L.obj.id, enabled: L.obj.enabled, type: value };
            return true;
        },
    });
    host.appendChild(common.el);
    const box = h('div');
    host.appendChild(box);
    let f = null, ft = null;
    function update() {
        const L = locF(store.get().project);
        if (!L) { clear(host); host.appendChild(h('p', { class: 'io-empty', text: 'This field was deleted.' })); return; }
        title.textContent = `${describeIdeal(L.obj)} (${id})`;
        common.sync();
        if (L.obj.type !== ft) {
            ft = L.obj.type;
            clear(box);
            f = bindForm(ctx, { kind: 'ideal', sub: ft, label: 'Edit ideal field', idPrefix: 'io-it', locate: locF, resolved: resF });
            box.appendChild(f.el);
        } else f.sync();
    }
    update();
    return { update };
}

/**
 * Sector-magnet helper (planar domains): an annulus-sector field region whose flux density bends a chosen ion on
 * the mean radius. B = γm|v|/(|q|r) from cyclotron(); the sign of Bz sets the turning sense.
 */
export function openWedgeHelper(ctx, app) {
    const { store } = ctx;
    const p = store.get().project;
    if (p.domain && p.domain.type === 'cyl2d') { if (ctx.ui.toast) ctx.ui.toast('Sector magnets need a planar domain (cylindrical domains allow only an axial field).', { kind: 'warn' }); return null; }
    const c = ctx.view.getViewState().center;
    const fields = [
        ['cx', 'Center x', 'length', round(c[0])], ['cy', 'Center y', 'length', round(c[1])], ['R', 'Mean radius', 'length', 100], ['w', 'Radial width', 'length', 100],
        ['a0', 'Start angle', 'angle', 0], ['phi', 'Sector angle', 'angle', 90], ['mass', 'Ion mass', 'mass', 100], ['charge', 'Ion charge', 'charge', 1], ['ke', 'Kinetic energy', 'energy', 1000],
    ];
    const inputs = new Map();
    const body = h('div', { class: 'io-form' });
    for (const [key, label, dim, v] of fields) {
        const id = 'io-wedge-' + key;
        const inp = h('input', { id, class: 'input', type: 'text', value: String(v), inputmode: 'decimal' });
        inputs.set(key, { inp, dim });
        body.appendChild(h('div', { class: 'field' }, h('label', { for: id, text: label }), inp));
    }
    const dirSel = h('select', { id: 'io-wedge-dir', class: 'input io-select' }, h('option', { value: 'ccw', text: 'Counter-clockwise (angles increase)' }), h('option', { value: 'cw', text: 'Clockwise' }));
    body.appendChild(h('div', { class: 'field io-field-select' }, h('label', { for: 'io-wedge-dir', text: 'Ions circulate' }), dirSel));
    const out = h('p', { class: 'io-note', role: 'status' });
    const msg = h('p', { class: 'io-field-msg', role: 'alert', hidden: true });
    body.append(out, msg);
    const read = () => {
        const v = {};
        for (const [key, { inp, dim }] of inputs) {
            const r = parseScalar({ kind: 'number', dim }, inp.value, {});
            if (!r.ok || typeof r.value !== 'number') return { error: `${key}: ${r.ok ? 'enter a number' : r.error}` };
            v[key] = r.value;
        }
        if (!(v.R > 0) || !(v.w > 0) || v.w >= 2 * v.R) return { error: 'The radial width must be positive and less than twice the mean radius.' };
        if (!(v.mass > 0) || !v.charge || !(v.ke > 0)) return { error: 'Mass, charge and energy must be non-zero.' };
        const c1 = cyclotron(v.mass, v.charge, 1, v.ke, true);
        const B = c1.radiusMM / v.R;
        const sign = (dirSel.value === 'ccw' ? -1 : 1) * Math.sign(v.charge);
        return { v, Bz: sign * B };
    };
    const refresh = () => {
        const r = read();
        msg.hidden = !r.error; msg.textContent = r.error || '';
        out.textContent = r.error ? '' : `|B| = ${formatPretty(Math.abs(r.Bz), 'flux', 6)} (Bz = ${formatPretty(r.Bz, 'flux', 6)}) bends the ion on r = ${formatPretty(r.v.R, 'length', 5)}.`;
    };
    body.addEventListener('input', refresh);
    body.addEventListener('change', refresh);
    refresh();
    return ctx.ui.openDialog({
        title: 'Sector magnet helper', body,
        actions: [{ label: 'Cancel', value: null }, { label: 'Add magnet', value: 'ok', primary: true, onClick: () => {
            const r = read();
            if (r.error) { refresh(); return false; }
            let id = null;
            const res = ctx.commit((d) => {
                d.magnets = d.magnets || [];
                id = nextId(d.magnets, 'm');
                d.magnets.push({ id, name: `Sector ${round(r.v.phi)}°`, enabled: true, type: 'region', B: [0, 0, round(r.Bz)],
                    region: { type: 'annulus', cx: r.v.cx, cy: r.v.cy, rIn: round(r.v.R - r.v.w / 2), rOut: round(r.v.R + r.v.w / 2), a0: r.v.a0, a1: round(r.v.a0 + r.v.phi) } });
            }, { label: 'Add sector magnet' });
            if (!res.ok) { msg.hidden = false; msg.textContent = res.error; return false; }
            store.select({ kind: 'magnet', ids: [id] });
            return true;
        } }],
    });
}
function round(v) { return parseFloat(Number(v).toPrecision(8)); }
