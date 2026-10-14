/* ==========================================================================
   Ion optics UI: panels/hits.js — the Hits tab (spec §4.7)
   A virtualised, sortable and filterable table of the run's summary rows
   (status, source, species, electrode/plane); a row click (or Enter on the
   focused row) highlights the trajectory on the canvas; CSV with the
   columns of §4.7 (io.runToCSV) for the filtered rows.
   ========================================================================== */
import {
    S_STRIDE, S_ID, S_STATUS, S_WHERE, S_X, S_Y, S_Z, S_KE, S_TOF, S_STEPS, S_DE_END, S_SRC, S_SPECIES, S_KE0, STATUS_NAMES, STATUS,
} from '../../engine/layout.js';
import { fmtNum, download } from '../plots.js';
import { statusLabel } from '../analysis-jobs.js';
import { endStatesSource, addEndStatesSource, rowsFromEndStates } from '../../engine/particles.js';
import { particlesToCSV } from '../../engine/io.js';

export const meta = { id: 'hits', title: 'Hits', order: 20 };

const ROW_H = 26;
const COLS = [
    { key: 'id', label: 'ID', num: true, get: (S, o) => S[o + S_ID] },
    { key: 'source', label: 'Source', get: (S, o, x) => x.srcName(S[o + S_SRC]) },
    { key: 'species', label: 'Species', get: (S, o, x) => x.spName(S[o + S_SRC], S[o + S_SPECIES]) },
    { key: 'status', label: 'Status', get: (S, o) => statusLabel(S[o + S_STATUS]) },
    { key: 'where', label: 'Where', get: (S, o, x) => x.where(S[o + S_STATUS], S[o + S_WHERE]) },
    { key: 'tof', label: 'TOF (µs)', num: true, get: (S, o) => S[o + S_TOF] },
    { key: 'x', label: 'x (mm)', num: true, get: (S, o) => S[o + S_X] },
    { key: 'y', label: 'y (mm)', num: true, get: (S, o) => S[o + S_Y] },
    { key: 'z', label: 'z (mm)', num: true, get: (S, o) => S[o + S_Z] },
    { key: 'ke', label: 'KE (eV)', num: true, get: (S, o) => S[o + S_KE] },
    { key: 'ke0', label: 'KE₀ (eV)', num: true, get: (S, o) => S[o + S_KE0] },
    { key: 'dE', label: 'ΔE end (eV)', num: true, get: (S, o) => S[o + S_DE_END] },
    { key: 'steps', label: 'Steps', num: true, get: (S, o) => S[o + S_STEPS] },
];

/** Row model (pure, for tests): offsets of rows passing the filters, sorted by a column. */
export function hitRows(result, resolved, { status = '', source = '', species = '', electrode = '', sortKey = 'id', sortDir = 1 } = {}) {
    const S = result.summary, n = result.n, x = labels(resolved), out = [];
    for (let i = 0; i < n; i++) {
        const o = i * S_STRIDE;
        if (status !== '' && STATUS_NAMES[S[o + S_STATUS]] !== status) continue;
        if (source !== '' && S[o + S_SRC] !== +source) continue;
        if (species !== '' && x.spName(S[o + S_SRC], S[o + S_SPECIES]) !== species) continue;
        if (electrode !== '') {
            const st = S[o + S_STATUS];
            if (!(st === STATUS.HIT || st === STATUS.ABSORBED || st === STATUS.BORN_INSIDE) || S[o + S_WHERE] !== +electrode) continue;
        }
        out.push(o);
    }
    const col = COLS.find((c) => c.key === sortKey) || COLS[0];
    const val = out.map((o) => col.get(S, o, x));
    const idx = out.map((_, i) => i).sort((a, b) => {
        const va = val[a], vb = val[b];
        if (typeof va === 'number' && typeof vb === 'number') return (Number.isNaN(va) ? 1 : Number.isNaN(vb) ? -1 : (va - vb)) * sortDir || out[a] - out[b];
        return String(va).localeCompare(String(vb)) * sortDir || out[a] - out[b];
    });
    return idx.map((i) => out[i]);
}
function labels(resolved) {
    const sources = (resolved && resolved.sources) || [], els = (resolved && resolved.electrodes) || [], planes = (resolved && resolved.recording && resolved.recording.planes) || [];
    const EDGES = ['x min', 'x max', 'y min', 'y max', 'z min', 'z max', 'r max', 'drift limit'];
    return {
        srcName: (k) => (sources[k] ? sources[k].name || sources[k].id : String(k)),
        spName: (k, s) => (sources[k] && sources[k].species && sources[k].species[s] ? sources[k].species[s].label : String(s)),
        where: (st, w) => {
            if (!(w >= 0)) return '';
            if (st === STATUS.HIT || st === STATUS.ABSORBED || st === STATUS.BORN_INSIDE) return els[w] ? els[w].name || els[w].id : String(w);
            if (st === STATUS.DETECTED) return planes[w] ? planes[w].name || planes[w].id : String(w);
            if (st === STATUS.EXIT || st === STATUS.DRIFT_END) return EDGES[w] || String(w);
            return '';
        },
    };
}

export function mount(el, ctx) {
    const { h } = ctx.ui.dom;
    const state = { status: '', source: '', species: '', electrode: '', sortKey: 'id', sortDir: 1, rows: [], focus: 0, selected: null };
    const fStatus = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Filter by status' });
    const fSource = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Filter by source' });
    const fSpecies = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Filter by species' });
    const fElec = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Filter by electrode hit' });
    const count = h('span', { class: 'io-note io-hits-count', role: 'status' });
    const csvBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'CSV' });
    const bar = h('div', { class: 'io-btnrow io-hits-bar' }, fStatus, fSource, fSpecies, fElec, count, csvBtn);
    // end states of the filtered particles → a new particle-list source (reverse flight or hand-off), or a particle CSV
    const esMode = h('select', { class: 'io-select io-select-sm', 'aria-label': 'End-state source direction' },
        h('option', { value: 'reverse', text: 'Reversed (v → −v)' }), h('option', { value: 'forward', text: 'As they ended (hand-off)' }));
    const esBtn = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Source from end states', title: 'New particle list from the end states of the rows shown; the other sources are disabled so that it flies alone' });
    const pCsvBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Particles CSV', title: 'End states of the rows shown as a particle CSV (mass, charge, position, direction, energy)' });
    const esBar = h('div', { class: 'io-btnrow io-hits-bar' }, h('span', { class: 'io-note', text: 'End states:' }), esMode, esBtn, pCsvBtn);
    const headRow = h('div', { class: 'io-vt-row io-vt-head', role: 'row' });
    const sortBtns = new Map();
    for (const c of COLS) {
        const b = h('button', { type: 'button', class: 'io-vt-sort', text: c.label });
        b.addEventListener('click', () => { if (state.sortKey === c.key) state.sortDir = -state.sortDir; else { state.sortKey = c.key; state.sortDir = 1; } rebuild(); });
        const cell = h('div', { class: `io-vt-cell${c.num ? ' num' : ''}`, role: 'columnheader', 'aria-sort': 'none' }, b);
        sortBtns.set(c.key, cell);
        headRow.appendChild(cell);
    }
    const spacer = h('div', { class: 'io-vt-spacer' });
    const rowsBox = h('div', { class: 'io-vt-rows', role: 'rowgroup' });
    const scroll = h('div', { class: 'io-vt-scroll', tabindex: '0', role: 'grid', 'aria-label': 'Particles', 'aria-rowcount': '0' }, h('div', { role: 'rowgroup' }, headRow), spacer);
    spacer.appendChild(rowsBox);
    const empty = h('p', { class: 'io-empty', text: 'No run yet.' });
    el.append(h('div', { class: 'io-results io-hits' }, bar, esBar, empty, scroll));

    let result = null, resolved = null, lab = null;
    const opt = (sel, items, cur) => { sel.replaceChildren(...items.map(([v, t]) => h('option', { value: v, text: t }))); sel.value = items.some(([v]) => v === cur) ? cur : ''; };
    function setOptions() {
        const S = result.summary, n = result.n;
        const st = new Set(), sp = new Set(), el2 = new Set();
        for (let i = 0; i < n; i++) {
            const o = i * S_STRIDE;
            st.add(STATUS_NAMES[S[o + S_STATUS]]);
            sp.add(lab.spName(S[o + S_SRC], S[o + S_SPECIES]));
            const s = S[o + S_STATUS];
            if (s === STATUS.HIT || s === STATUS.ABSORBED || s === STATUS.BORN_INSIDE) el2.add(S[o + S_WHERE]);
        }
        opt(fStatus, [['', 'All statuses'], ...[...st].map((s) => [s, statusLabel(STATUS_NAMES.indexOf(s))])], state.status);
        opt(fSource, [['', 'All sources'], ...((resolved && resolved.sources) || []).map((s, k) => [String(k), s.name || s.id])], state.source);
        opt(fSpecies, [['', 'All species'], ...[...sp].map((s) => [s, s])], state.species);
        opt(fElec, [['', 'Any electrode'], ...[...el2].sort((a, b) => a - b).map((k) => [String(k), `Hit ${lab.where(STATUS.HIT, k)}`])], state.electrode);
        state.status = fStatus.value; state.source = fSource.value; state.species = fSpecies.value; state.electrode = fElec.value;
    }
    for (const [sel, key] of [[fStatus, 'status'], [fSource, 'source'], [fSpecies, 'species'], [fElec, 'electrode']]) sel.addEventListener('change', () => { state[key] = sel.value; rebuild(); });

    function rebuild() {
        const st = ctx.store.get();
        const run = st.run || {};
        result = run.result || null;
        resolved = (result && result.resolvedSnapshot) || st.resolved;
        empty.hidden = !!result;
        scroll.hidden = !result;
        bar.hidden = !result;
        esBar.hidden = !result;
        if (!result) return;
        lab = labels(resolved);
        setOptions();
        state.rows = hitRows(result, resolved, state);
        state.focus = Math.min(state.focus, Math.max(0, state.rows.length - 1));
        count.textContent = `${state.rows.length.toLocaleString('en-US')} of ${result.n.toLocaleString('en-US')} particles`;
        scroll.setAttribute('aria-rowcount', String(state.rows.length + 1));
        for (const [k, cell] of sortBtns) cell.setAttribute('aria-sort', k === state.sortKey ? (state.sortDir > 0 ? 'ascending' : 'descending') : 'none');
        spacer.style.height = `${state.rows.length * ROW_H}px`;
        paint();
    }
    function paint() {
        if (!result) return;
        const top = scroll.scrollTop, hgt = scroll.clientHeight || 400;
        const a = Math.max(0, Math.floor(top / ROW_H) - 5), b = Math.min(state.rows.length, Math.ceil((top + hgt) / ROW_H) + 5);
        rowsBox.style.transform = `translateY(${a * ROW_H}px)`;
        const S = result.summary;
        const frag = document.createDocumentFragment();
        for (let r = a; r < b; r++) {
            const o = state.rows[r];
            const id = S[o + S_ID];
            const row = h('div', { class: `io-vt-row${r === state.focus ? ' io-focus' : ''}${state.selected === id ? ' io-selected' : ''}`, role: 'row', 'aria-rowindex': String(r + 2), 'aria-selected': state.selected === id ? 'true' : 'false', dataset: { r: String(r) } });
            for (const c of COLS) {
                const v = c.get(S, o, lab);
                row.appendChild(h('div', { class: `io-vt-cell${c.num ? ' num' : ''}`, role: 'gridcell', text: typeof v === 'number' ? (c.key === 'id' || c.key === 'steps' ? String(v) : fmtNum(v, 7)) : v }));
            }
            frag.appendChild(row);
        }
        rowsBox.replaceChildren(frag);
    }
    function select(r) {
        if (!result || r < 0 || r >= state.rows.length) return;
        state.focus = r;
        const id = result.summary[state.rows[r] + S_ID];
        state.selected = id;
        if (ctx.view && typeof ctx.view.highlightParticle === 'function') ctx.view.highlightParticle(id);
        paint();
    }
    scroll.addEventListener('scroll', () => paint(), { passive: true });
    rowsBox.addEventListener('click', (e) => { const row = e.target.closest('[data-r]'); if (row) select(+row.dataset.r); });
    scroll.addEventListener('keydown', (e) => {
        if (!result || !state.rows.length) return;
        let r = state.focus;
        if (e.key === 'ArrowDown') r++; else if (e.key === 'ArrowUp') r--; else if (e.key === 'PageDown') r += 10; else if (e.key === 'PageUp') r -= 10;
        else if (e.key === 'Home') r = 0; else if (e.key === 'End') r = state.rows.length - 1;
        else if (e.key === 'Enter' || e.key === ' ') { select(state.focus); e.preventDefault(); return; }
        else return;
        e.preventDefault();
        state.focus = Math.max(0, Math.min(state.rows.length - 1, r));
        const y = state.focus * ROW_H;
        if (y < scroll.scrollTop) scroll.scrollTop = y; else if (y + ROW_H > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = y + ROW_H - scroll.clientHeight;
        paint();
    });
    csvBtn.addEventListener('click', () => {
        if (!result) return;
        const S = result.summary, sub = new Float64Array(state.rows.length * S_STRIDE);
        state.rows.forEach((o, i) => sub.set(S.subarray(o, o + S_STRIDE), i * S_STRIDE));
        const text = ctx.engine.io.runToCSV({ n: state.rows.length, summary: sub, crossings: new Float64Array(0), nCross: 0 }, 'hits', resolved);
        download(text, `${ctx.ui.dom.fileStem((ctx.store.get().project.meta || {}).name)}-hits.csv`);
    });
    const shownIds = () => new Set(state.rows.map((o) => result.summary[o + S_ID]));
    pCsvBtn.addEventListener('click', () => {
        if (!result) return;
        const ids = shownIds();
        const es = rowsFromEndStates(result, resolved, { reverse: false, filter: (st, S, o) => ids.has(S[o + S_ID]) });
        if (!es.rows.length) { if (ctx.ui.toast) ctx.ui.toast('No particle with an end state is shown.', { kind: 'warn' }); return; }
        download(particlesToCSV(es.rows), `${ctx.ui.dom.fileStem((ctx.store.get().project.meta || {}).name)}-end-states.csv`);
    });
    esBtn.addEventListener('click', () => {
        if (!result) return;
        const reverse = esMode.value !== 'forward';
        const src = endStatesSource(result, resolved, { reverse, ids: shownIds() });
        if (!src) { if (ctx.ui.toast) ctx.ui.toast('No particle with an end state is shown.', { kind: 'warn' }); return; }
        let added = null;
        const r = ctx.commit((d) => { added = addEndStatesSource(d, src, { disableOthers: true }); }, { label: 'Source from end states' });
        if (!r.ok) { if (ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' }); return; }
        ctx.store.select({ kind: 'source', ids: [added.id] });
        if (ctx.ui.toast) ctx.ui.toast(`Added "${src.name}" with ${src.rows.length.toLocaleString('en-US')} particles${added.disabled ? ` and disabled ${added.disabled} other source${added.disabled === 1 ? '' : 's'}` : ''}${reverse ? '; run it to fly the particles back' : ''}. Undo reverts this.`, { kind: 'ok' });
    });
    rebuild();
    return {
        update(evt) { if (!evt || evt.type === 'run' || evt.type === 'show') rebuild(); },
        destroy() { if (ctx.view && ctx.view.highlightParticle) ctx.view.highlightParticle(null); },
    };
}
