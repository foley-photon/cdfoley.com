/* ==========================================================================
   Ion optics UI: panels/statusbar.js
   Status bar (spec §4.2): x, y or r, potential, |E| and its components,
   node (i, j), owner electrode and cell type at the cursor, evaluated by the
   main-thread field model at the display time (so the read-out is exactly
   what the particles feel). Also the canvas status chips (stale results,
   live preview, partial runs).
   ========================================================================== */
import { h, clear } from '../dom.js';
import { formatPretty } from '../units.js';

const CELL_WORDS = ['regular cell', 'boundary cell', 'inside an electrode', 'outside the grid'];

/**
 * Field read-out at a world point: { x, y, phi, Ex, Ey, Ez, Emag, Erho?, where, cellType, owner, i, j, inside } or null.
 * Values come straight from the field model's E() and ownerAt(), so they equal the model to the last bit.
 */
export function readoutAt(state, x, y, t = 0) {
    const r = state.resolved || state.lastResolved;
    if (!r || !r.domain) return null;
    const d = r.domain;
    const cyl = d.type === 'cyl2d';
    const mx = !!(d.mirror && d.mirror.x), my = !cyl && !!(d.mirror && d.mirror.y);
    const X = mx ? Math.abs(x) : x, Y = cyl || my ? Math.abs(y) : y;
    const h0 = d.h, x0 = d.x[0], y0 = cyl ? 0 : d.y[0];
    const i = Math.round((X - x0) / h0), j = Math.round((Y - y0) / h0);
    const inside = X >= x0 - 1e-9 * h0 && X <= x0 + (d.nx - 1) * h0 + 1e-9 * h0 && Y >= y0 - 1e-9 * h0 && Y <= y0 + (d.ny - 1) * h0 + 1e-9 * h0;
    const out = { x, y, inside, i: inside ? i : null, j: inside ? j : null, phi: NaN, Ex: NaN, Ey: NaN, Ez: NaN, Emag: NaN, where: 3, cellType: 3, owner: -1, cyl };
    const f = state.field;
    const model = f && f.model;
    if (model && typeof model.E === 'function') {
        const e4 = new Float64Array(4);
        out.where = model.E(t, x, y, 0, e4);
        out.Ex = e4[0]; out.Ey = e4[1]; out.Ez = e4[2]; out.phi = e4[3];
        out.Emag = Math.sqrt(e4[0] * e4[0] + e4[1] * e4[1] + e4[2] * e4[2]);
        if (cyl) out.Erho = y === 0 ? e4[1] : Math.sign(y) * e4[1];
        out.owner = typeof model.ownerAt === 'function' ? model.ownerAt(x, y, 0) : -1;
        out.cellType = typeof model.cellTypeAt === 'function' ? model.cellTypeAt(x, y, 0) : out.where;
        if (model.hasB && typeof model.B === 'function') { const b = new Float64Array(3); model.B(x, y, 0, b); out.B = [b[0], b[1], b[2]]; }
    }
    return out;
}

/** Mounts the status bar and the canvas chips. */
export function mountStatusbar(el, ctx, app) {
    const { store, view } = ctx;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'off');
    const span = (label) => { const v = h('span', { class: 'io-st-val' }); const s = h('span', { class: 'io-st' }, h('b', { text: label }), v); return { s, v }; };
    const fx = span('x'), fy = span('y'), fphi = span('φ'), fe = span('|E|'), fex = span('Eₓ'), fey = span('E_y'), fnode = span('node'), fown = span(''), fB = span('B');
    fown.s.classList.add('io-st-owner');
    const touch = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
    const hint = h('span', { class: 'io-st-hint', text: touch ? 'Tap the canvas for the potential and field there; long-press to probe.' : 'Move the pointer over the canvas for the potential and field there.' });
    el.append(fx.s, fy.s, fphi.s, fe.s, fex.s, fey.s, fnode.s, fown.s, fB.s, hint);
    let last = null, pinned = false;
    function render() {
        const st = store.get();
        const r = st.resolved || st.lastResolved;
        const cyl = r && r.domain && r.domain.type === 'cyl2d';
        fy.s.firstChild.textContent = cyl ? 'r' : 'y';
        fey.s.firstChild.textContent = cyl ? 'E_r' : 'E_y';
        const parts = [fx, fy, fphi, fe, fex, fey, fnode, fown, fB];
        if (!last) { parts.forEach((p) => { p.s.hidden = true; }); hint.hidden = false; app.readout = null; return; }
        hint.hidden = true;
        const ro = readoutAt(st, last.x, last.y, view.displayTime || 0);
        app.readout = ro;
        parts.forEach((p) => { p.s.hidden = false; });
        // fixed units, so neighbouring values compare at a glance: mm for coordinates, V/mm with one shared exponent for fields
        fx.v.textContent = fmtMm(last.x);
        fy.v.textContent = fmtMm(cyl ? Math.abs(last.y) : last.y);
        if (!ro || !st.field) {
            fphi.v.textContent = st.solve && st.solve.status === 'running' ? 'solving…' : '—';
            [fe, fex, fey].forEach((p) => { p.v.textContent = '—'; });
        } else {
            fphi.v.textContent = Number.isFinite(ro.phi) ? formatPretty(ro.phi, 'voltage', 6) : '—';
            const ev = [ro.Emag, ro.Ex, cyl ? ro.Erho : ro.Ey];
            const ef = fieldFormatter(ev);
            fe.v.textContent = ef(ev[0]);
            fex.v.textContent = ef(ev[1]);
            fey.v.textContent = ef(ev[2]);
        }
        fnode.v.textContent = ro && ro.inside ? `(${ro.i}, ${ro.j})` : 'outside';
        let own = '';
        if (ro) {
            if (ro.owner >= 0 && r && r.electrodes && r.electrodes[ro.owner]) own = `in ${r.electrodes[ro.owner].name || r.electrodes[ro.owner].id}`;
            else own = CELL_WORDS[ro.cellType] || '';
            if (ro.owner < 0 && ro.cellType !== undefined && ro.cellType !== 3) own = CELL_WORDS[ro.cellType];
        }
        fown.v.textContent = own;
        fB.s.hidden = !(ro && ro.B);
        if (ro && ro.B) fB.v.textContent = `(${ro.B.map((v) => formatPretty(v, 'flux', 3)).join(', ')})`;
        if (pinned) el.setAttribute('aria-live', 'polite'); else el.setAttribute('aria-live', 'off');
    }
    view.on('hover', (p) => { last = p; pinned = !!(p && p.pinned); render(); });
    const offs = ['field', 'resolved'].map((evt) => store.on(evt, () => { if (last) render(); }));
    view.on('time', () => { if (last) render(); });
    render();

    // ---- canvas chips
    const chips = document.getElementById('io-canvas-chips');
    function chipsUpdate() {
        if (!chips) return;
        clear(chips);
        const st = store.get();
        const run = st.run || {};
        const add = (text, cls, title) => chips.appendChild(h('span', { class: 'badge ' + (cls || ''), text, title: title || text }));
        if (st.solve && st.solve.status === 'stale') add('fields stale', 'badge-warn', 'The geometry changed; solve again to update the fields.');
        if (st.solve && (st.solve.status === 'running' || st.solve.status === 'queued')) add('solving…', '');
        if (run.status === 'stale' && run.result) add('stale', 'badge-warn', 'The model changed after this run; run again.');
        if (run.status === 'running') add('running…', '');
        if (run.status === 'partial') add('partial run', 'badge-warn', 'The run was stopped; finished particles are shown.');
        if (run.status === 'done' && run.live && run.result) {
            const r = st.resolved || st.lastResolved;
            const total = r ? r.particleCount : 0;
            add(`live preview · ${run.result.n}${total > run.result.n ? ` of ${total}` : ''}`, '', 'Preview of the first particles of each source; press Run for all.');
        }
        if (!st.valid && st.valid !== undefined) add('project has errors', 'badge-bad', 'Fix the fields marked in red; the last valid project is shown.');
    }
    offs.push(...['run', 'solve', 'project'].map((evt) => store.on(evt, chipsUpdate)));
    chipsUpdate();
    return { update: render, destroy: () => offs.forEach((f) => f()) };
}

const minus = (t) => t.replace(/^-/, '−').replace('e-', 'e−');
/** A coordinate in mm to 1 µm (trailing zeros dropped). */
export function fmtMm(v) {
    if (!Number.isFinite(v)) return '—';
    const t = Number(v.toFixed(4));
    return `${minus(String(Object.is(t, -0) ? 0 : t))} mm`;
}
/**
 * Formatter for a set of field values in V/mm with one shared scale: plain decimals (5 significant figures on the largest)
 * between 1e-3 and 1e5 V/mm, otherwise a common power of ten.
 */
export function fieldFormatter(values) {
    let m = 0;
    for (const v of values) if (Number.isFinite(v)) m = Math.max(m, Math.abs(v));
    if (!(m > 0)) return (v) => (Number.isFinite(v) ? '0 V/mm' : '—');
    const e = Math.floor(Math.log10(m));
    if (e >= -3 && e < 5) {
        const d = Math.max(0, 4 - e);
        return (v) => (Number.isFinite(v) ? `${minus(Math.abs(v) < 0.5 * Math.pow(10, -d) ? '0' : v.toFixed(d))} V/mm` : '—');
    }
    const sc = Math.pow(10, e);
    return (v) => (Number.isFinite(v) ? `${minus((v / sc).toFixed(4))}e${minus(String(e))} V/mm` : '—');
}
