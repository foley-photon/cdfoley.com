/* ==========================================================================
   Ion optics UI: panels/presets.js
   The preset gallery (spec §4.14, §2.5): a modal dialog of cards, each with
   an SVG thumbnail drawn from the preset's geometry outlines
   (geometry.outlines()), its blurb and its "Try" line, filters by device
   type, a first-visit welcome, and keyboard navigation (arrow keys move
   between cards, Enter opens one, Escape closes, Tab stays inside).
   openGallery(ctx, { firstVisit }) resolves with the chosen preset id, or
   null; the workbench then loads it. When the chosen preset has a guide,
   the short tour starts once the project has loaded (a checkbox in the
   gallery turns that off; the choice is kept in the preferences).
   presetThumbnail() is pure (string output, no DOM), so Node tests use it.
   ========================================================================== */

import { startGuide, stopGuide } from './guide.js';

export const meta = { id: 'presets', title: 'Presets', order: 0 };

const SVG_NS = 'http://www.w3.org/2000/svg';
const HEX = /^#[0-9a-f]{6}$/i;
const TAG_LABELS = { lens: 'Lenses', mirror: 'Mirrors', analyzer: 'Energy analyzers', tof: 'Time of flight', rf: 'RF devices', magnetic: 'Magnetic', imaging: 'Imaging' };
const thumbCache = new Map();

// ---------------------------------------------------------------- thumbnails (pure)
const num = (v) => (Number.isFinite(v) ? +v.toFixed(2) : 0);

/**
 * World box shown by a thumbnail: the domain, unfolded across the axis (cylindrical) and the mirror planes.
 * @param {object} resolved
 * @returns {{ x0: number, x1: number, y0: number, y1: number, mx: boolean, my: boolean }}
 */
export function thumbnailBox(resolved) {
    const d = resolved.domain;
    const cyl = d.type === 'cyl2d';
    const mx = !!(d.mirror && d.mirror.x), my = cyl || !!(d.mirror && d.mirror.y);
    const x0 = mx ? -Math.max(Math.abs(d.x[0]), Math.abs(d.x[1])) : d.x[0], x1 = mx ? Math.max(Math.abs(d.x[0]), Math.abs(d.x[1])) : d.x[1];
    const y0 = my ? -Math.max(Math.abs(d.y[0]), Math.abs(d.y[1])) : d.y[0], y1 = my ? Math.max(Math.abs(d.y[0]), Math.abs(d.y[1])) : d.y[1];
    return { x0, x1, y0, y1, mx, my };
}

/**
 * SVG markup of a preset thumbnail: electrodes and voids from geometry.outlines() (filled in painting order, later
 * shapes on top), meshes and zero-thickness sheets as lines, magnet regions, sources and recording planes.
 * Colors come from the project (validated #rrggbb) and from CSS classes (presets.css).
 * @param {object} preset a preset module's default export
 * @param {{ schema: object, geometry: object }} engine
 * @param {{ width?: number, height?: number }} [size]
 * @returns {string} '<svg …>…</svg>'
 */
export function presetThumbnail(preset, engine, { width = 240, height = 120 } = {}) {
    const key = `${preset.id}|${width}|${height}`;
    if (thumbCache.has(key)) return thumbCache.get(key);
    const open = `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="io-thumb-svg" aria-hidden="true" focusable="false">`;
    let body = '';
    try {
        const res = engine.schema.resolve(preset.build());
        if (!res.resolved || res.errors.length) throw new Error('invalid');
        const r = res.resolved;
        const geo = engine.geometry.compileGeometry(r);
        const box = thumbnailBox(r);
        const pad = 6;
        const s = Math.min((width - 2 * pad) / (box.x1 - box.x0), (height - 2 * pad) / (box.y1 - box.y0));
        const ox = (width - s * (box.x1 - box.x0)) / 2, oy = (height - s * (box.y1 - box.y0)) / 2;
        const X = (x) => num(ox + (x - box.x0) * s), Y = (y) => num(oy + (box.y1 - y) * s);
        // the four (or fewer) mirror images of the solved region
        const images = [[1, 1]];
        if (box.mx) images.push([-1, 1]);
        if (box.my) images.push([1, -1]);
        if (box.mx && box.my) images.push([-1, -1]);
        const pathOf = (pts, closed, fx, fy) => {
            let d = '';
            for (let i = 0; i < pts.length; i += 2) d += (i ? 'L' : 'M') + X(fx * pts[i]) + ' ' + Y(fy * pts[i + 1]);
            return closed ? d + 'Z' : d;
        };
        const dm = r.domain;
        const parts = [];
        // domain frame and axis
        for (const [fx, fy] of images) {
            const xa = fx * dm.x[0], xb = fx * dm.x[1], ya = fy * dm.y[0], yb = fy * dm.y[1];
            parts.push(`<rect class="io-thumb-frame" x="${Math.min(X(xa), X(xb))}" y="${Math.min(Y(ya), Y(yb))}" width="${num(Math.abs(X(xb) - X(xa)))}" height="${num(Math.abs(Y(yb) - Y(ya)))}"/>`);
        }
        if (dm.type === 'cyl2d') parts.push(`<line class="io-thumb-axis" x1="${X(box.x0)}" y1="${Y(0)}" x2="${X(box.x1)}" y2="${Y(0)}"/>`);
        // magnet regions (plane coordinates)
        for (const m of r.magnets || []) {
            if (m.type !== 'region' || !m.region) continue;
            const g = m.region;
            let pts = null;
            if (g.type === 'box') pts = [g.x0, g.y0, g.x1, g.y0, g.x1, g.y1, g.x0, g.y1];
            else if (g.type === 'polygon') pts = g.points.flat();
            else if (g.type === 'annulus') {
                pts = [];
                const n = Math.max(8, Math.ceil(Math.abs(g.a1 - g.a0) / 3));
                for (let i = 0; i <= n; i++) { const a = (g.a0 + (g.a1 - g.a0) * i / n) * Math.PI / 180; pts.push(g.cx + g.rOut * Math.cos(a), g.cy + g.rOut * Math.sin(a)); }
                for (let i = n; i >= 0; i--) { const a = (g.a0 + (g.a1 - g.a0) * i / n) * Math.PI / 180; pts.push(g.cx + g.rIn * Math.cos(a), g.cy + g.rIn * Math.sin(a)); }
            }
            if (pts) for (const [fx, fy] of images) parts.push(`<path class="io-thumb-magnet" d="${pathOf(pts, true, fx, fy)}"/>`);
        }
        // electrodes and voids in painting order
        const els = r.electrodes || [];
        const outlines = geo.outlines(2);
        for (const o of outlines) {
            const e = o.electrode >= 0 ? els[o.electrode] : null;
            const color = e && HEX.test(e.color || '') ? e.color : '#808080';
            const mesh = !!(e && (e.transparent || e.kind === 'grid'));
            for (const [fx, fy] of images) {
                const d = pathOf(o.pts, o.closed, fx, fy);
                if (o.electrode < 0) parts.push(`<path class="io-thumb-void" d="${d}"/>`);
                else if (o.closed && !mesh) parts.push(`<path class="io-thumb-el" d="${d}" fill="${color}" stroke="${color}"/>`);
                else parts.push(`<path class="io-thumb-line${mesh ? ' io-thumb-mesh' : ''}" d="${d}" stroke="${color}"/>`);
            }
        }
        // recording planes inside the box (segments, x and y planes)
        for (const p of (r.recording && r.recording.planes) || []) {
            let seg = null;
            if (p.kind === 'segment' && p.p0 && p.p1) seg = [p.p0[0], p.p0[1], p.p1[0], p.p1[1]];
            else if (p.kind === 'x' && p.at >= box.x0 && p.at <= box.x1) seg = [p.at, box.y0, p.at, box.y1];
            else if (p.kind === 'y' && p.at >= box.y0 && p.at <= box.y1) seg = [box.x0, p.at, box.x1, p.at];
            if (seg) parts.push(`<line class="io-thumb-plane${p.terminate ? ' io-thumb-detector' : ''}" x1="${X(seg[0])}" y1="${Y(seg[1])}" x2="${X(seg[2])}" y2="${Y(seg[3])}"/>`);
        }
        // sources
        for (const src of r.sources || []) {
            const P = src.position || {};
            if (P.type === 'line' && P.p0 && P.p1) parts.push(`<line class="io-thumb-source-line" x1="${X(P.p0[0])}" y1="${Y(P.p0[1])}" x2="${X(P.p1[0])}" y2="${Y(P.p1[1])}"/>`);
            const c = P.p || P.center || (P.p0 && P.p1 ? [(P.p0[0] + P.p1[0]) / 2, (P.p0[1] + P.p1[1]) / 2] : null);
            if (c) parts.push(`<circle class="io-thumb-source" cx="${X(c[0])}" cy="${Y(c[1])}" r="2.5"/>`);
        }
        body = parts.join('');
    } catch (e) {
        body = `<rect class="io-thumb-frame" x="1" y="1" width="${width - 2}" height="${height - 2}"/>`;
    }
    const svg = open + body + '</svg>';
    thumbCache.set(key, svg);
    return svg;
}

// ---------------------------------------------------------------- DOM helpers
function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'text') n.textContent = String(v);
        else if (k === 'class') n.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
        else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
}
let uidN = 0;
const uid = (p) => `${p}-${++uidN}`;
function closeIcon(ctx) {
    try { if (ctx && ctx.ui && ctx.ui.dom && typeof ctx.ui.dom.icon === 'function') return ctx.ui.dom.icon('x', 18); } catch (e) { /* fall back to text */ }
    return document.createTextNode('×');
}
function focusablesIn(root) {
    return Array.from(root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter((n) => !n.disabled && !n.hidden && n.getAttribute('tabindex') !== '-1' && n.getClientRects().length > 0);
}
function readPrefs(ctx) {
    try { return (ctx.persist && typeof ctx.persist.prefs === 'function' && ctx.persist.prefs()) || {}; } catch (e) { return {}; }
}
function writePrefs(ctx, patch) {
    try { if (ctx.persist && typeof ctx.persist.setPrefs === 'function') ctx.persist.setPrefs(patch); } catch (e) { /* storage blocked */ }
}
async function engineOf(ctx) {
    const eng = (ctx && ctx.engine) || {};
    const schema = eng.schema || await import('../../engine/schema.js');
    const geometry = eng.geometry || await import('../../engine/geometry.js');
    return { schema, geometry };
}

// ---------------------------------------------------------------- gallery
let openDialog = null;

/**
 * Opens the preset gallery.
 * @param {object} ctx panel context (spec §2.5)
 * @param {{ firstVisit?: boolean }} [opts] firstVisit: welcome text, focus on the loaded preset
 * @returns {Promise<string|null>} the chosen preset id, or null when closed
 */
export async function openGallery(ctx, { firstVisit = false } = {}) {
    const prevFocus = document.activeElement;
    if (openDialog) openDialog.close(null);
    stopGuide();   // a running tour has done its job once the gallery opens (its last step points here)
    const { PRESETS, presetById } = await import('../../presets/index.js');
    const engine = await engineOf(ctx);
    const current = (() => { try { const m = ctx.store.get().project.meta; return m && m.preset ? m.preset : null; } catch (e) { return null; } })();
    const prefs = readPrefs(ctx);

    const titleId = uid('io-gal-title'), introId = uid('io-gal-intro');
    const dlg = el('dialog', { class: ['io-dialog', 'io-dialog-wide', 'io-gallery', firstVisit ? 'io-gallery-first' : null], 'aria-labelledby': titleId, 'aria-describedby': introId });
    const closeBtn = el('button', { type: 'button', class: 'icon-btn io-dialog-x', 'aria-label': 'Close' }, closeIcon(ctx));
    const head = el('div', { class: 'io-dialog-head' }, el('h2', { id: titleId, text: firstVisit ? 'Welcome: pick a device' : 'Presets' }), closeBtn);
    const body = el('div', { class: 'io-dialog-body io-gallery-body' });
    if (firstVisit) {
        body.append(el('p', { class: 'io-gallery-welcome', text: 'This simulator solves the electrostatic field of the electrodes you draw and traces ions and electrons through it, in your browser. '
            + 'The Einzel lens is already loaded and running. Start from it, or pick another device below.' }));
    }
    body.append(el('p', { id: introId, class: 'io-gallery-intro', text: 'Example devices with known answers. Opening one replaces the current project, which stays under Project ▸ Recent projects.' }));

    // filters
    const tags = [];
    for (const p of PRESETS) for (const t of p.tags || []) if (!tags.includes(t)) tags.push(t);
    const filters = el('div', { class: 'io-gallery-filters', role: 'group', 'aria-label': 'Show presets' });
    const chips = [];
    const mkChip = (tag, label) => {
        const b = el('button', { type: 'button', class: 'chip io-gallery-chip', 'aria-pressed': tag === null ? 'true' : 'false', text: label });
        b.addEventListener('click', () => setFilter(tag));
        chips.push({ tag, b });
        filters.append(b);
    };
    mkChip(null, 'All');
    for (const t of tags) mkChip(t, TAG_LABELS[t] || t);
    body.append(filters);

    // cards
    const grid = el('ul', { class: 'io-gallery-grid', 'aria-label': 'Presets' });
    const cards = [];
    for (const p of PRESETS) {
        const tId = uid('io-gal-t'), dId = uid('io-gal-d');
        const thumb = el('span', { class: 'io-preset-thumb', 'aria-hidden': 'true' });
        const kind = p.domainType === 'cyl2d' ? 'Cylindrical' : 'Planar';
        const btn = el('button', { type: 'button', class: ['io-preset-card', p.id === current ? 'io-preset-current' : null], 'data-id': p.id, 'aria-labelledby': tId, 'aria-describedby': dId, tabindex: '-1',
            'aria-current': p.id === current ? 'true' : null },
        thumb,
        el('span', { class: 'io-preset-head' }, el('span', { id: tId, class: 'io-preset-title', text: p.title }), p.id === current ? el('span', { class: 'badge io-preset-badge', text: 'Loaded' }) : null),
        el('span', { id: dId, class: 'io-preset-desc' },
            el('span', { class: 'io-preset-meta', text: `${kind} · ${(p.tags || []).map((t) => TAG_LABELS[t] || t).join(', ')}.` }),
            el('span', { class: 'io-preset-blurb', text: ' ' + (p.blurb || '') }),
            p.tryThis ? el('span', { class: 'io-preset-try' }, el('b', { text: ' Try: ' }), document.createTextNode(p.tryThis)) : null));
        btn.addEventListener('click', () => finish(p.id));
        const li = el('li', { class: 'io-gallery-item' }, btn);
        grid.append(li);
        cards.push({ p, li, btn, thumb });
    }
    body.append(grid);

    // footer
    const tourId = uid('io-gal-tour');
    const tourBox = el('input', { type: 'checkbox', id: tourId, class: 'io-gallery-tour-input' });
    tourBox.checked = prefs.presetTours !== false;
    const tourLabel = el('label', { class: 'io-gallery-tour', for: tourId }, tourBox, document.createTextNode(' Show the short tour of presets that have one'));
    tourBox.addEventListener('change', () => writePrefs(ctx, { presetTours: tourBox.checked }));
    const cancelBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: firstVisit ? 'Keep the Einzel lens' : 'Cancel' });
    const foot = el('div', { class: 'io-dialog-foot io-gallery-foot' }, tourLabel, cancelBtn);
    dlg.append(head, body, foot);

    let resolveFn;
    const done = new Promise((res) => { resolveFn = res; });
    let finished = false;
    function finish(id) {
        if (finished) return;
        finished = true;
        openDialog = null;
        try { dlg.close(); } catch (e) { /* already closed */ }
        dlg.remove();
        if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) { try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        const chosen = id ? presetById(id) : null;
        if (chosen && chosen.guide && tourBox.checked) scheduleGuide(ctx, chosen);
        resolveFn(id || null);
    }
    closeBtn.addEventListener('click', () => finish(null));
    cancelBtn.addEventListener('click', () => finish(null));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) finish(null); });

    // roving focus over the visible cards
    const visible = () => cards.filter((c) => !c.li.hidden);
    let active = Math.max(0, cards.findIndex((c) => c.p.id === (firstVisit ? (current || 'einzel') : current)));
    function setActive(i, focus = true) {
        const vis = visible();
        if (!vis.length) return;
        const idx = Math.max(0, Math.min(vis.length - 1, i));
        for (const c of cards) c.btn.setAttribute('tabindex', '-1');
        vis[idx].btn.setAttribute('tabindex', '0');
        active = cards.indexOf(vis[idx]);
        if (focus) vis[idx].btn.focus();
    }
    function columns() {
        const vis = visible();
        if (vis.length < 2) return 1;
        const top = vis[0].li.offsetTop;
        let n = 0;
        for (const c of vis) { if (c.li.offsetTop !== top) break; n++; }
        return Math.max(1, n);
    }
    grid.addEventListener('keydown', (e) => {
        const vis = visible();
        const at = vis.indexOf(cards[active]);
        let next = -1;
        if (e.key === 'ArrowRight') next = at + 1;
        else if (e.key === 'ArrowLeft') next = at - 1;
        else if (e.key === 'ArrowDown') next = at + columns();
        else if (e.key === 'ArrowUp') next = at - columns();
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = vis.length - 1;
        else return;
        e.preventDefault();
        if (next >= 0 && next < vis.length) setActive(next);
    });
    grid.addEventListener('focusin', (e) => {
        const i = cards.findIndex((c) => c.btn === e.target);
        if (i >= 0 && i !== active) { const vis = visible(); setActive(vis.indexOf(cards[i]), false); }
    });
    function setFilter(tag) {
        for (const c of chips) c.b.setAttribute('aria-pressed', c.tag === tag ? 'true' : 'false');
        for (const c of cards) c.li.hidden = tag !== null && !(c.p.tags || []).includes(tag);
        const vis = visible();
        const keep = vis.indexOf(cards[active]);
        setActive(keep >= 0 ? keep : 0, false);
        announce(ctx, `${vis.length} preset${vis.length === 1 ? '' : 's'} shown.`);
    }
    // Tab stays inside the dialog
    dlg.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const f = focusablesIn(dlg);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || !dlg.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    const layer = document.getElementById('io-dialogs') || document.body;
    layer.append(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    setActive(visible().indexOf(cards[active]), true);
    openDialog = { close: finish };

    // thumbnails, a few per frame so the dialog opens at once
    let k = 0;
    const step = () => {
        if (finished) return;
        const t0 = performance.now();
        while (k < cards.length && performance.now() - t0 < 12) {
            const c = cards[k++];
            c.thumb.innerHTML = presetThumbnail(c.p, engine);   // markup built from numbers and validated colors only
        }
        if (k < cards.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return done;
}

function announce(ctx, msg) {
    try { if (ctx && ctx.ui && typeof ctx.ui.announce === 'function') ctx.ui.announce(msg); } catch (e) { /* no live region */ }
}

/** Starts a preset's guide once the workbench has loaded it (waits up to 6 s for the load; gives up quietly). */
function scheduleGuide(ctx, preset) {
    const t0 = Date.now();
    const loadedId = () => { try { const m = ctx.store.get().project.meta; return m ? m.preset : null; } catch (e) { return null; } };
    const tick = () => {
        if (loadedId() === preset.id) { setTimeout(() => { if (loadedId() === preset.id) startGuide(ctx, preset.guide); }, 500); return; }
        if (Date.now() - t0 < 6000) setTimeout(tick, 150);
    };
    setTimeout(tick, 150);
}
