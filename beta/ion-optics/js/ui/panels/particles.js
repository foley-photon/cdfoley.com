/* ==========================================================================
   Ion optics UI: panels/particles.js
   Particles rail tab (spec §4.3, §2.2.2 sources): the sources, and for the
   selected one its sampling, species (picked from the engine's species
   table or a custom mass and charge) and the position, direction, energy
   and birth-time cards. Direction previews are drawn on the canvas by the
   view. Grid sampling derives the particle count from the cards.
   ========================================================================== */
import { h, icon, clear } from '../dom.js';
import { bindForm, locate, nextId } from '../forms.js';
import { formatPretty } from '../units.js';
import { SPECIES } from '../../engine/particles.js';

const CARD_TYPES = {
    position: [['point', 'Point'], ['line', 'Line'], ['disc', 'Disc'], ['rect', 'Rectangle'], ['gaussian', 'Gaussian (random only)'], ['list', 'List of points']],
    direction: [['fixed', 'Fixed'], ['cone', 'Cone'], ['fan', 'Fan (in a plane)'], ['isotropic', 'Isotropic (β)']],
    energy: [['mono', 'Single energy'], ['uniform', 'Uniform range'], ['gaussian', 'Gaussian (random only)'], ['list', 'List']],
    time: [['fixed', 'Fixed'], ['uniform', 'Uniform range'], ['rfPhase', 'RF phases'], ['list', 'List']],
};
const CARD_TITLES = { position: 'Position', direction: 'Direction', energy: 'Kinetic energy', time: 'Birth time' };

/** One-line description of a source (for lists and the phone sheet). */
export function sourceSummary(rs) {
    if (!rs) return '';
    const sp = (rs.species || []).map((s) => s.label || `${s.mass} u`).join(', ');
    const en = rs.energy || {};
    const e = en.type === 'mono' ? formatPretty(en.ke, 'energy', 4) : en.type === 'uniform' ? `${formatPretty(en.min, 'energy', 4)}–${formatPretty(en.max, 'energy', 4)}` : en.type === 'gaussian' ? `${formatPretty(en.mean, 'energy', 4)} ± ${formatPretty(en.fwhm / 2, 'energy', 3)}` : en.type === 'list' ? `${(en.values || []).length} energies` : '';
    return `${rs.count === undefined ? '' : rs.count + ' × '}${sp}${e ? ' · ' + e : ''}`;
}

/** Rail tab. */
export function mountParticles(host, ctx, app) {
    const { store } = ctx;
    const listEl = h('ul', { class: 'io-list', 'aria-label': 'Particle sources' });
    const empty = h('p', { class: 'io-empty', text: 'No sources. Add one here or click on the canvas with the source tool.' });
    const addBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('plus', 16), h('span', { text: 'Add source' }));
    addBtn.addEventListener('click', () => addSource(ctx, app));
    const detail = h('div', { class: 'io-src-detail' });
    host.append(listEl, empty, h('div', { class: 'io-add-row' }, addBtn), detail);
    let sig = '', rows = new Map(), editor = null, editorId = null;
    function build() {
        const p = store.get().project;
        const srcs = p.sources || [];
        sig = srcs.map((s) => s.id).join('|');
        clear(listEl);
        rows = new Map();
        for (const s of srcs) {
            const li = h('li', { class: 'io-item', dataset: { id: s.id } });
            const en = h('input', { type: 'checkbox', 'aria-label': `Enable ${s.name || s.id}` });
            en.addEventListener('change', () => ctx.commit((d) => { const L = locate(d, 'source', s.id); if (L) L.obj.enabled = en.checked; }, { label: 'Enable source' }));
            const sw = h('span', { class: 'io-swatch' });
            const title = h('button', { type: 'button', class: 'io-item-title' });
            title.addEventListener('click', () => store.select({ kind: 'source', ids: [s.id] }));
            const dup = h('button', { type: 'button', class: 'io-mini', title: 'Duplicate', 'aria-label': `Duplicate ${s.name || s.id}` }, icon('copy', 16));
            dup.addEventListener('click', () => duplicateSource(ctx, s.id));
            const del = h('button', { type: 'button', class: 'io-mini', title: 'Delete', 'aria-label': `Delete ${s.name || s.id}` }, icon('trash', 16));
            del.addEventListener('click', () => { const r = ctx.commit((d) => { const L = locate(d, 'source', s.id); if (L) d.sources.splice(L.index, 1); }, { label: 'Delete source' }); if (r.ok && store.get().selection.kind === 'source') store.select({ kind: null, ids: [] }); });
            const sub = h('div', { class: 'io-item-sub' });
            li.append(h('div', { class: 'io-item-row' }, en, sw, title, h('span', { class: 'io-spacer' }), dup, del), sub);
            rows.set(s.id, { li, en, sw, title, sub });
            listEl.appendChild(li);
        }
        syncRows();
    }
    function syncRows() {
        const st = store.get();
        const srcs = st.project.sources || [];
        empty.hidden = srcs.length > 0;
        const r = st.resolved || st.lastResolved;
        const sel = st.selection || {};
        srcs.forEach((s, k) => {
            const row = rows.get(s.id);
            if (!row) return;
            row.en.checked = s.enabled !== false;
            row.title.textContent = s.name || s.id;
            row.sw.style.background = s.color && s.color !== 'auto' ? s.color : ctx.view.sourceColor(null, k);
            const rs = r && r.sources ? r.sources.find((x) => x.id === s.id) : null;
            row.sub.textContent = s.enabled === false ? 'Disabled' : sourceSummary(rs);
            row.li.classList.toggle('io-selected', sel.kind === 'source' && (sel.ids || []).includes(s.id));
        });
        // detail editor of the selected source
        const want = sel.kind === 'source' && sel.ids && sel.ids.length === 1 ? sel.ids[0] : null;
        if (want !== editorId) {
            clear(detail);
            editor = null; editorId = want;
            if (want) {
                detail.appendChild(h('h3', { class: 'io-group-title', text: 'Selected source' }));
                const box = h('div');
                detail.appendChild(box);
                editor = sourceEditor(box, ctx, app, want, { compactHead: true });
            } else if (srcs.length) detail.appendChild(h('p', { class: 'io-note', text: 'Select a source to edit its species, position, direction, energy and birth time.' }));
        } else if (editor) editor.update();
    }
    function update() {
        const s = (store.get().project.sources || []).map((x) => x.id).join('|');
        if (s !== sig) build(); else syncRows();
    }
    build();
    const offs = ['project', 'resolved', 'selection'].map((evt) => store.on(evt, update));
    return { update, destroy: () => offs.forEach((f) => f()) };
}

/** Adds a source at the view centre and selects it. */
export function addSource(ctx, app) {
    const c = ctx.view.getViewState().center;
    let id = null;
    const r = ctx.commit((p) => {
        p.sources = p.sources || [];
        id = nextId(p.sources, 'b');
        p.sources.push({
            id, name: `Source ${p.sources.length + 1}`, enabled: true, color: 'auto', count: 9, sampling: 'grid', seed: 1,
            species: [{ label: 'm/z 100', mass: 100, charge: 1, fraction: 1 }],
            position: { type: 'point', p: [round(c[0]), round(c[1]), 0] },
            direction: { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: -5, to: 5, n: 9 },
            energy: { type: 'mono', ke: 100 }, time: { type: 'fixed', t: 0 },
        });
    }, { label: 'Add source' });
    if (r.ok) ctx.store.select({ kind: 'source', ids: [id] }); else if (ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' });
    return r.ok ? id : null;
}
function round(v) { return parseFloat(v.toPrecision(6)); }

function duplicateSource(ctx, id) {
    let nid = null;
    const r = ctx.commit((p) => {
        const L = locate(p, 'source', id);
        if (!L) return;
        const c = structuredClone(L.obj);
        c.id = nid = nextId(p.sources, 'b');
        c.name = (c.name || id) + ' copy';
        p.sources.splice(L.index + 1, 0, c);
    }, { label: 'Duplicate source' });
    if (r.ok) ctx.store.select({ kind: 'source', ids: [nid] });
}

/** Source editor: settings, species and the four cards. Used by the rail tab and the inspector. */
export function sourceEditor(host, ctx, app, id, { compactHead = false } = {}) {
    const { store } = ctx;
    const locS = (p) => locate(p, 'source', id);
    const resS = (r) => (r.sources || []).find((s) => s.id === id) || null;
    const title = h('h3');
    const countNote = h('p', { class: 'io-note' });
    if (!compactHead) host.appendChild(h('div', { class: 'io-insp-head' }, icon('source', 18), title));
    const main = bindForm(ctx, { kind: 'source', label: 'Edit source', idPrefix: 'io-src', locate: locS, resolved: resS, hide: (key, obj) => key === 'count' && obj.sampling === 'grid' });
    host.append(main.el, countNote);
    // species
    const spCard = h('div', { class: 'io-card' });
    const spList = h('div', { class: 'io-species' });
    const pick = h('select', { class: 'io-select', 'aria-label': 'Add a species' },
        h('option', { value: '', text: 'Add a species…' }),
        ...SPECIES.map((s) => h('option', { value: s.id, text: `${s.label}  (${formatPretty(s.mass, 'mass', 6)}, ${s.charge > 0 ? '+' : '−'}${Math.abs(s.charge)})` })),
        h('option', { value: '__custom', text: 'Custom mass and charge' }));
    pick.addEventListener('change', () => {
        const v = pick.value;
        pick.value = '';
        if (!v) return;
        const sp = v === '__custom' ? { label: 'custom', mass: 100, charge: 1, fraction: 1 } : (() => { const s = SPECIES.find((x) => x.id === v); return { label: s.label, mass: parseFloat(s.mass.toPrecision(10)), charge: s.charge, fraction: 1 }; })();
        const r = ctx.commit((p) => { const L = locS(p); if (L) (L.obj.species = L.obj.species || []).push(sp); }, { label: 'Add species' });
        if (!r.ok && ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' });
    });
    spCard.append(h('div', { class: 'io-card-title', text: 'Species' }), spList, pick);
    host.appendChild(spCard);
    // cards
    const cards = {};
    for (const key of Object.keys(CARD_TYPES)) {
        const card = h('div', { class: 'io-card' });
        const sel = h('select', { class: 'io-select', 'aria-label': `${CARD_TITLES[key]} type` }, ...CARD_TYPES[key].map(([v, t]) => h('option', { value: v, text: t })));
        sel.addEventListener('change', () => changeType(key, sel.value));
        const box = h('div');
        card.append(h('div', { class: 'io-item-row' }, h('span', { class: 'io-card-title', text: CARD_TITLES[key] }), h('span', { class: 'io-spacer' }), sel), box);
        host.appendChild(card);
        cards[key] = { card, sel, box, form: null, type: null };
    }
    function changeType(key, type) {
        let def = null;
        try { def = ctx.engine.schema.defaults(`${key}.${type}`); } catch (e) { def = null; }
        if (!def || def.type !== type) def = { type };
        const r = ctx.commit((p) => {
            const L = locS(p);
            if (!L) return;
            const old = L.obj[key] || {};
            // keep the location when switching position types
            if (key === 'position') {
                const at = old.p || old.center || old.p0 || null;
                if (at) { if ('p' in def) def.p = at.slice(); if ('center' in def) def.center = at.slice(); if ('p0' in def) { def.p0 = at.slice(); def.p1 = [at[0], (typeof at[1] === 'number' ? at[1] : 0) + 2, at[2] || 0]; } }
            }
            if (key === 'energy') {
                const ke = typeof old.ke === 'number' ? old.ke : typeof old.mean === 'number' ? old.mean : null;
                if (ke !== null) { if ('ke' in def) def.ke = ke; if ('mean' in def) def.mean = ke; if ('min' in def) { def.min = ke * 0.99; def.max = ke * 1.01; } if ('values' in def) def.values = [ke]; }
            }
            L.obj[key] = def;
        }, { label: `${CARD_TITLES[key]} type` });
        if (!r.ok) { if (ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' }); update(); }
    }
    let spSig = '', spForms = [];
    function buildSpecies(s) {
        clear(spList);
        spForms = [];
        (s.species || []).forEach((sp, k) => {
            const row = h('div', { class: 'io-species-row' });
            const f = bindForm(ctx, { kind: 'species', label: 'Edit species', idPrefix: 'io-spc', className: 'io-form io-form-4',
                locate: (p) => { const L = locS(p); return L && L.obj.species && L.obj.species[k] ? { obj: L.obj.species[k], path: `${L.path}.species[${k}]` } : null; },
                resolved: (r) => { const rs = resS(r); return rs && rs.species ? rs.species[k] : null; } });
            const rm = h('button', { type: 'button', class: 'io-mini', title: 'Remove species', 'aria-label': `Remove species ${sp.label || k + 1}` }, icon('trash', 16));
            rm.addEventListener('click', () => {
                const r = ctx.commit((p) => { const L = locS(p); if (L) L.obj.species.splice(k, 1); }, { label: 'Remove species' });
                if (!r.ok && ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' });
            });
            row.append(f.el, rm);
            spList.appendChild(row);
            spForms.push(f);
        });
    }
    function update() {
        const st = store.get();
        const L = locS(st.project);
        if (!L) { clear(host); host.appendChild(h('p', { class: 'io-empty', text: 'This source was deleted.' })); return; }
        const s = L.obj;
        title.textContent = s.name || id;
        main.sync();
        const r = st.resolved || st.lastResolved;
        const rs = r ? resS(r) : null;
        countNote.textContent = rs ? `${rs.count} particle${rs.count === 1 ? '' : 's'}${s.sampling === 'grid' ? ' (every combination of the classes below)' : ''}.` : '';
        const sig = (s.species || []).length + '';
        if (sig !== spSig) { spSig = sig; buildSpecies(s); } else spForms.forEach((f) => f.sync());
        for (const key of Object.keys(cards)) {
            const c = cards[key];
            const obj = s[key] || {};
            const type = obj.type || CARD_TYPES[key][0][0];
            if (document.activeElement !== c.sel) c.sel.value = type;
            if (c.type !== type) {
                c.type = type;
                clear(c.box);
                c.form = bindForm(ctx, { kind: key, sub: type, label: `Edit ${CARD_TITLES[key].toLowerCase()}`, idPrefix: 'io-' + key,
                    locate: (p) => { const LL = locS(p); return LL && LL.obj[key] ? { obj: LL.obj[key], path: `${LL.path}.${key}` } : null; },
                    resolved: (rr) => { const x = resS(rr); return x ? x[key] : null; },
                    hide: (k) => { if (k !== 'n') return false; const LL = locS(store.get().project); return !LL || LL.obj.sampling !== 'grid'; } });
                c.box.appendChild(c.form.el);
                if (key === 'direction' && ctx.store.get().project.domain && ctx.store.get().project.domain.type === 'cyl2d') c.box.appendChild(h('p', { class: 'hint', text: 'Directions are 3D; the canvas shows the x–y plane (r is the distance from the x axis).' }));
            } else c.form.sync();
        }
    }
    update();
    return { update };
}
