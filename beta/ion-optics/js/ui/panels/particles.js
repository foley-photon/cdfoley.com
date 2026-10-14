/* ==========================================================================
   Ion optics UI: panels/particles.js
   Particles rail tab (spec §4.3, §2.2.2 sources): the sources, and for the
   selected one its settings, species (picked from the engine's species
   table or a custom mass and charge) and the position, direction, energy
   and birth-time cards. Direction previews are drawn on the canvas by the
   view. Grid sampling derives the particle count from the cards.

   Particle lists ('rows' sources): one row per particle, edited as text,
   imported from and exported to CSV (io.parseParticlesCSV / particlesToCSV).
   "Freeze to list" turns a sampled source into the list of the particles it
   generates (particles.frozenSource), which reproduces the run exactly.
   ========================================================================== */
import { h, icon, clear } from '../dom.js';
import { bindForm, locate, nextId } from '../forms.js';
import { formatPretty } from '../units.js';
import { download } from '../plots.js';
import { SPECIES, frozenSource, generateRows, convertRows } from '../../engine/particles.js';
import { particlesToCSV, parseParticlesCSV } from '../../engine/io.js';

const CARD_TYPES = {
    position: [['point', 'Point'], ['line', 'Line'], ['disc', 'Disc'], ['rect', 'Rectangle'], ['gaussian', 'Gaussian (random only)'], ['list', 'List of points']],
    direction: [['fixed', 'Fixed'], ['cone', 'Cone'], ['fan', 'Fan (in a plane)'], ['isotropic', 'Isotropic (β)']],
    energy: [['mono', 'Single energy'], ['uniform', 'Uniform range'], ['gaussian', 'Gaussian (random only)'], ['list', 'List']],
    time: [['fixed', 'Fixed'], ['uniform', 'Uniform range'], ['rfPhase', 'RF phases'], ['list', 'List']],
};
const CARD_TITLES = { position: 'Position', direction: 'Direction', energy: 'Kinetic energy', time: 'Birth time' };
const ROWS_EDITOR_MAX = 2000;   // longer lists are edited through CSV import and export

const isRows = (s) => !!s && s.type === 'rows';
const relOf = (p) => !(p && p.tracer && p.tracer.relativistic === false);

/** One-line description of a source (for lists and the phone sheet). */
export function sourceSummary(rs) {
    if (!rs) return '';
    const sp = (rs.species || []).map((s) => s.label || `${s.mass} u`).join(', ');
    const w = typeof rs.weight === 'number' && rs.weight !== 1 ? ` · weight ${formatPretty(rs.weight, 'none', 4)}` : '';
    if (isRows(rs)) return `${rs.count === undefined ? '' : rs.count + ' × '}${sp || 'particle list'} · list${w}`;
    const en = rs.energy || {};
    const e = en.type === 'mono' ? formatPretty(en.ke, 'energy', 4) : en.type === 'uniform' ? `${formatPretty(en.min, 'energy', 4)}–${formatPretty(en.max, 'energy', 4)}` : en.type === 'gaussian' ? `${formatPretty(en.mean, 'energy', 4)} ± ${formatPretty(en.fwhm / 2, 'energy', 3)}` : en.type === 'list' ? `${(en.values || []).length} energies` : '';
    return `${rs.count === undefined ? '' : rs.count + ' × '}${sp}${e ? ' · ' + e : ''}${w}`;
}

/** Rail tab. */
export function mountParticles(host, ctx, app) {
    const { store } = ctx;
    const listEl = h('ul', { class: 'io-list', 'aria-label': 'Particle sources' });
    const empty = h('p', { class: 'io-empty', text: 'No sources. Add one here or click on the canvas with the source tool.' });
    const addBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('plus', 16), h('span', { text: 'Add source' }));
    addBtn.addEventListener('click', () => addSource(ctx, app));
    const importBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', title: 'New particle list from a CSV file' }, icon('upload', 16), h('span', { text: 'Import CSV' }));
    const fileInput = csvFileInput(ctx, (parsed, file) => {
        let id = null;
        const r = ctx.commit((p) => {
            p.sources = p.sources || [];
            id = nextId(p.sources, 'b');
            p.sources.push({ ...ctx.engine.schema.defaults('source.rows'), id, name: file && file.name ? file.name.replace(/\.[^.]+$/, '') : 'Particle list', rows: parsed.rows });
        }, { label: 'Import particles' });
        if (r.ok) { ctx.store.select({ kind: 'source', ids: [id] }); importToast(ctx, parsed, file); } else if (ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' });
    });
    importBtn.addEventListener('click', () => fileInput.click());
    const detail = h('div', { class: 'io-src-detail' });
    host.append(listEl, empty, h('div', { class: 'io-add-row' }, addBtn, importBtn, fileInput), detail);
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
            id, name: `Source ${p.sources.length + 1}`, enabled: true, color: 'auto', type: 'sampled', weight: 1, count: 9, sampling: 'grid', seed: 1,
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

// ---------------------------------------------------------------- particle lists: conversion, CSV

/** Hidden file input for particle CSV files; onParsed(parsed, file) gets the result of io.parseParticlesCSV. */
function csvFileInput(ctx, onParsed) {
    const input = h('input', { type: 'file', accept: '.csv,.txt,.tsv,text/csv,text/plain', hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
    input.addEventListener('change', async () => {
        const f = input.files && input.files[0];
        input.value = '';
        if (!f) return;
        try {
            if (f.size > 64 * 1024 * 1024) throw new Error('The file is larger than 64 MB.');
            const text = await f.text();
            const parsed = parseParticlesCSV(text, { relativistic: relOf(ctx.store.get().project) });
            if (!parsed.rows.length) throw new Error(parsed.errors.length ? `no valid rows (line ${parsed.errors[0].line}: ${parsed.errors[0].message})` : 'no particle rows');
            onParsed(parsed, f);
        } catch (e) { if (ctx.ui.toast) ctx.ui.toast(`Could not import ${f.name}: ${e && e.message ? e.message : e}`, { kind: 'error' }); }
    });
    return input;
}
function importToast(ctx, parsed, file) {
    if (!ctx.ui.toast) return;
    const n = parsed.rows.length;
    const bad = parsed.errors.length ? `; ${parsed.errors.length} row${parsed.errors.length === 1 ? '' : 's'} skipped (line ${parsed.errors[0].line}: ${parsed.errors[0].message})` : '';
    const cut = parsed.skipped ? `; ${parsed.skipped} more rows beyond the limit were dropped` : '';
    const how = parsed.fromHits ? ' from a hits table (end states)' : parsed.velocity ? ' from velocity columns' : '';
    ctx.ui.toast(`Imported ${n.toLocaleString('en-US')} particle${n === 1 ? '' : 's'}${how} from ${file ? file.name : 'CSV'}${bad}${cut}.`, { kind: bad ? 'warn' : 'ok' });
}

/** The project object of a sampled source turned into a particle list, from the resolved source when available. */
function toRowsSource(ctx, src) {
    const st = ctx.store.get();
    const r = st.resolved || st.lastResolved;
    const rs = r && r.sources ? r.sources.find((x) => x.id === src.id) : null;
    const keep = { id: src.id, name: src.name, enabled: src.enabled !== false, color: src.color === undefined ? 'auto' : src.color, weight: src.weight === undefined ? 1 : src.weight };
    if (rs && !isRows(rs) && rs.count > 0) {
        const f = frozenSource({ ...rs, enabled: true }, { relativistic: relOf(st.project) });
        return { ...f, ...keep, enabled: keep.enabled };
    }
    return { ...ctx.engine.schema.defaults('source.rows'), ...keep, species: Array.isArray(src.species) ? structuredClone(src.species) : [] };
}

/** The project object of a particle list turned back into a sampled source (positions as a point list; first row's direction, energy and time). */
function toSampledSource(ctx, src) {
    const rel = relOf(ctx.store.get().project);
    const rows = convertRows(src.rows || [], { toVelocity: false, relativistic: rel });
    const first = rows[0] || [100, 1, 0, 0, 0, 1, 0, 0, 100, 0];
    const species = Array.isArray(src.species) && src.species.length ? structuredClone(src.species) : [{ label: `m/z ${first[0]}`, mass: first[0], charge: first[1], fraction: 1 }];
    return {
        id: src.id, name: src.name, enabled: src.enabled !== false, color: src.color === undefined ? 'auto' : src.color, type: 'sampled', weight: src.weight === undefined ? 1 : src.weight,
        count: Math.max(1, rows.length), sampling: 'random', seed: 1, species,
        position: rows.length > 1 ? { type: 'list', points: rows.map((r) => [r[2], r[3], r[4]]) } : { type: 'point', p: [first[2], first[3], first[4]] },
        direction: { type: 'fixed', dir: [first[5], first[6], first[7]] }, energy: { type: 'mono', ke: first[8] }, time: { type: 'fixed', t: first[9] },
    };
}

/** Source editor: settings, species and the four cards (sampled) or the particle list (rows). Used by the rail tab and the inspector. */
export function sourceEditor(host, ctx, app, id, { compactHead = false } = {}) {
    const { store } = ctx;
    const META = ctx.engine.schema.META || {};
    const locS = (p) => locate(p, 'source', id);
    const resS = (r) => (r.sources || []).find((s) => s.id === id) || null;
    const title = h('h3');
    const countNote = h('p', { class: 'io-note' });
    if (!compactHead) host.appendChild(h('div', { class: 'io-insp-head' }, icon('source', 18), title));
    const main = bindForm(ctx, { kind: 'source', label: 'Edit source', idPrefix: 'io-src', locate: locS, resolved: resS,
        hide: (key, obj) => (isRows(obj) ? ['sampling', 'count', 'seed'].includes(key) : key === 'count' && obj.sampling === 'grid'),
        intercept: (key, value, draft, L) => {
            if (key !== 'type') return false;
            if (value === (L.obj.type || 'sampled')) return true;
            draft.sources[L.index] = value === 'rows' ? toRowsSource(ctx, L.obj) : toSampledSource(ctx, L.obj);
            return true;
        } });
    // actions: freeze (sampled), CSV export (both), CSV import (replaces the particles of this source)
    const freezeBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', title: 'Replace this source by the list of the particles it generates (reproduces the run exactly)' }, icon('particles', 16), h('span', { text: 'Freeze to list' }));
    freezeBtn.addEventListener('click', () => {
        const r = ctx.commit((p) => { const L = locS(p); if (!L) return; const rs = toRowsSource(ctx, L.obj); if (!rs.rows.length) throw new Error('This source has no particles to freeze.'); p.sources[L.index] = rs; }, { label: 'Freeze to list' });
        if (!r.ok && ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' });
        else if (ctx.ui.toast) { const L = locS(store.get().project); ctx.ui.toast(`Frozen: ${L && L.obj.rows ? L.obj.rows.length.toLocaleString('en-US') : ''} particles are now an explicit list.`, { kind: 'ok' }); }
    });
    const exportBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', title: 'Save the particles of this source as CSV (mass, charge, position, direction, energy, birth time)' }, icon('download', 16), h('span', { text: 'Export CSV' }));
    exportBtn.addEventListener('click', () => {
        const st = store.get();
        const L = locS(st.project);
        const r = st.resolved || st.lastResolved;
        const rs = r ? resS(r) : null;
        if (!L || !rs) { if (ctx.ui.toast) ctx.ui.toast('Fix the project errors first; the particle list comes from the resolved source.', { kind: 'warn' }); return; }
        const rel = relOf(st.project);
        const rowsOut = isRows(rs) ? rs.rows : generateRows(rs, { relativistic: rel });
        download(particlesToCSV(rowsOut, { velocity: !!(L.obj.velocity), relativistic: rel }), `${ctx.ui.dom.fileStem((st.project.meta || {}).name)}-${L.obj.id}-particles.csv`);
    });
    const importBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', title: 'Replace the particles of this source with a CSV file (makes it a particle list)' }, icon('upload', 16), h('span', { text: 'Import CSV' }));
    const fileInput = csvFileInput(ctx, (parsed, file) => {
        const r = ctx.commit((p) => {
            const L = locS(p);
            if (!L) return;
            const base = isRows(L.obj) ? L.obj : toRowsSource(ctx, L.obj);
            p.sources[L.index] = { ...base, velocity: false, rows: parsed.rows, species: isRows(L.obj) ? (L.obj.species || []) : [] };
        }, { label: 'Import particles' });
        if (r.ok) importToast(ctx, parsed, file); else if (ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' });
    });
    importBtn.addEventListener('click', () => fileInput.click());
    const actions = h('div', { class: 'io-btnrow' }, freezeBtn, exportBtn, importBtn, fileInput);
    host.append(main.el, countNote, actions);
    // species (sampled sources)
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
    // cards (sampled sources)
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
    // particle list (rows sources)
    const rowsCard = h('div', { class: 'io-card' });
    const rowsNote = h('p', { class: 'io-note' });
    const rowsBox = h('div');
    rowsCard.append(h('div', { class: 'io-card-title', text: 'Particles' }), rowsNote, rowsBox);
    host.appendChild(rowsCard);
    let rowsForm = null, rowsSig = '';
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
    function buildRowsForm(s) {
        clear(rowsBox);
        const velocity = s.velocity === true;
        const names = velocity ? ['mass', 'charge', 'x', 'y', 'z', 'vx', 'vy', 'vz', 't0'] : ['mass', 'charge', 'x', 'y', 'z', 'dx', 'dy', 'dz', 'kinetic energy', 't0'];
        const descs = [(META['source.rows'] || [])[0], ((velocity ? META['rows.velocity'] : META.rows) || [])[0]].filter(Boolean)
            .map((d) => (d.key === 'rows' ? { ...d, names } : d));
        rowsForm = bindForm(ctx, { kind: 'rows', descs, label: 'Edit particles', idPrefix: 'io-rows', locate: locS, resolved: null,
            hide: (key, obj) => key === 'rows' && Array.isArray(obj.rows) && obj.rows.length > ROWS_EDITOR_MAX,
            intercept: (key, value, draft, L) => {
                if (key !== 'velocity' || value === (L.obj.velocity === true)) return false;
                // keep the particles: convert the rows to the other form
                L.obj.rows = convertRows(L.obj.rows || [], { toVelocity: value === true, relativistic: relOf(draft) });
                L.obj.velocity = value === true;
                return true;
            } });
        rowsBox.appendChild(rowsForm.el);
    }
    function update() {
        const st = store.get();
        const L = locS(st.project);
        if (!L) { clear(host); host.appendChild(h('p', { class: 'io-empty', text: 'This source was deleted.' })); return; }
        const s = L.obj;
        const rowsMode = isRows(s);
        title.textContent = s.name || id;
        main.sync();
        const r = st.resolved || st.lastResolved;
        const rs = r ? resS(r) : null;
        countNote.textContent = rs ? `${rs.count} particle${rs.count === 1 ? '' : 's'}${rowsMode ? ' in the list' : s.sampling === 'grid' ? ' (every combination of the classes below)' : ''}${rs.weight !== undefined && rs.weight !== 1 ? `, weight ${formatPretty(rs.weight, 'none', 4)} each` : ''}.` : '';
        freezeBtn.hidden = rowsMode;
        spCard.hidden = rowsMode;
        for (const key of Object.keys(cards)) cards[key].card.hidden = rowsMode;
        rowsCard.hidden = !rowsMode;
        if (rowsMode) {
            const n = Array.isArray(s.rows) ? s.rows.length : 0;
            const sig = `${s.velocity === true}|${n > ROWS_EDITOR_MAX}`;
            if (sig !== rowsSig) { rowsSig = sig; buildRowsForm(s); } else if (rowsForm) rowsForm.sync();
            rowsNote.textContent = n > ROWS_EDITOR_MAX
                ? `${n.toLocaleString('en-US')} particles: lists above ${ROWS_EDITOR_MAX.toLocaleString('en-US')} rows are edited through Export CSV and Import CSV.`
                : (s.velocity === true ? 'One particle per line: mass u, charge e, x, y, z mm, vx, vy, vz mm/µs, birth time µs.' : 'One particle per line: mass u, charge e, x, y, z mm, direction dx, dy, dz, kinetic energy eV, birth time µs.');
            return;
        }
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
