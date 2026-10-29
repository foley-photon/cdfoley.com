/* ==========================================================================
   Ion optics UI: panels/compare.js — the Compare tab (spec §4.7)
   Up to 8 pinned runs. A pin keeps a snapshot of the project and the metrics
   of its run (analysis-jobs.js); the trajectories are never stored. After a
   reload every pinned run is regenerated from its snapshot through
   jobs.withTemporaryProject (the sources carry their seeds, so the same
   particles fly again), and the regenerated metrics are compared with the
   stored ones. Pinned trajectories are drawn as dashed ghosts on the canvas
   through the view's overlay hook, with a numbered tick at each waist, but
   only while the current project has the pin's geometry (geometry key); a
   pin keeps its metrics and a thinned copy of its trajectory points (at
   most GHOST_POINTS), not the field model or the full result. The
   table lists the metrics side by side, with a CSV export. Pins live in the
   store (state.runs, 'runs' events) and in local storage by the same rules
   as the autosave (every storage call wrapped; the app works without it).
   ========================================================================== */
import { makePin, pinMetrics, nextPinColor, readPins, writePins, compareTable, compareCsv, metricsDiffer, MAX_PINS, PIN_COLORS } from '../analysis-jobs.js';
import { fmtNum, dataTable, download, themeColors, onThemeChange } from '../plots.js';

export const meta = { id: 'compare', title: 'Compare', order: 80 };

const OVERLAY_ID = 'io-cmp-ghosts';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** Trajectory points kept per pin for its ghost (12 bytes each: x, y, z as Float32). */
export const GHOST_POINTS = 120000;

/**
 * The part of a run result a ghost needs (pure, for tests): per-particle offsets and x, y, z of the trajectory points,
 * thinned evenly within each trajectory (first and last points kept) to at most `budget` points. null without
 * stored trajectories.
 * @param {{ n: number, traj?: { offsets: ArrayLike<number>, pts: ArrayLike<number> } }} result
 * @returns {{ n: number, offsets: Int32Array, pts: Float32Array } | null}
 */
export function ghostOf(result, budget = GHOST_POINTS) {
    const tr = result && result.traj;
    if (!tr || !tr.offsets || !tr.pts || !tr.pts.length) return null;
    const n = result.n, off = tr.offsets, P = tr.pts;
    const total = off[n] - off[0];
    if (!(total > 0)) return null;
    const step = Math.max(1, Math.ceil(total / Math.max(2 * n, budget)));
    const offsets = new Int32Array(n + 1);
    let m = 0;
    for (let i = 0; i < n; i++) { const c = off[i + 1] - off[i]; m += c <= 2 ? c : Math.ceil((c - 1) / step) + 1; offsets[i + 1] = m; }
    const pts = new Float32Array(3 * m);
    let o = 0;
    for (let i = 0; i < n; i++) {
        const a = off[i], b = off[i + 1];
        for (let q = a; q < b; q += (b - a <= 2 ? 1 : step)) { pts[o++] = P[4 * q]; pts[o++] = P[4 * q + 1]; pts[o++] = P[4 * q + 2]; }
        if (b - a > 2 && (b - 1 - a) % step !== 0) { const q = b - 1; pts[o++] = P[4 * q]; pts[o++] = P[4 * q + 1]; pts[o++] = P[4 * q + 2]; }
    }
    return { n, offsets, pts };
}

/** The comparison table with fractions shown as percentages, as in the Summary (pure; the CSV keeps the numbers). */
export function percentRows(t) {
    const pct = (v) => (isNum(v) ? `${(100 * v).toFixed(v === 1 || v === 0 ? 0 : 1)}%` : v);
    return { ...t, rows: t.rows.map((r, i) => (/(^|:)fraction$|^transmission$/.test((t.keys && t.keys[i]) || '') ? [r[0], ...r.slice(1).map(pct)] : r)) };
}

/** One line about a pinned run for its card (pure, for tests). */
export function pinSummary(m) {
    if (!m) return '';
    const parts = [`${isNum(m.launched) ? m.launched.toLocaleString('en-US') : '?'} particle${m.launched === 1 ? '' : 's'}`];
    if (isNum(m.transmission)) parts.push(`transmission ${(100 * m.transmission).toFixed(m.transmission === 1 || m.transmission === 0 ? 0 : 1)}%`);
    if (m.waist && m.waist.ok) parts.push(`waist at ${m.waist.axis} ≈ ${fmtNum(m.waist.position, 4)} mm, rms ${fmtNum(m.waist.rms, 3)} mm`);
    else {
        const p = (m.planes || []).find((q) => q.crossings > 0 && isNum(q.spotRms));
        if (p) parts.push(`${p.name || p.id}: rms spot ${fmtNum(p.spotRms, 4)} mm`);
    }
    if (m.trajectories === false) parts.push('no stored trajectories');
    return parts.join(' · ');
}

export function mount(el, ctx) {
    const { h } = ctx.ui.dom;
    const store = ctx.store, view = ctx.view;
    // regenerated results by pin id: { ghost (thinned trajectories), geomKey, metrics, engineVersion, error }
    const results = new Map();
    const paths = new Map();          // Path2D of a pin's trajectories, keyed by pin id, for one projection
    let theme = themeColors();
    let regenerating = false, destroyed = false, storageWarned = false;

    const intro = h('p', { class: 'io-note', text: `Pin the current run to keep its project and results (up to ${MAX_PINS}). Pinned trajectories are drawn as dashed ghosts on the canvas and their metrics are listed side by side. Pins stay in this browser; after a reload each run is regenerated from its stored project and seed.` });
    const pinBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Pin current run' });
    const csvBtn = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'CSV', disabled: true });
    const clearBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Unpin all', disabled: true });
    const status = h('p', { class: 'io-note io-cmp-status', role: 'status' });
    const list = h('div', { class: 'io-cmp-list', role: 'list', 'aria-label': 'Pinned runs' });
    const tableBox = h('div', { class: 'io-cmp-table' });
    const root = h('div', { class: 'io-results io-cmp' }, intro, h('div', { class: 'io-btnrow io-results-actions' }, pinBtn, csvBtn, clearBtn), status, list, tableBox);
    el.appendChild(root);

    const pins = () => (store.get().runs || []);
    const metricsOf = (p) => { const r = results.get(p.id); return r && r.metrics ? r.metrics : p.metrics; };
    const colorOf = (p) => { const i = Math.max(0, PIN_COLORS.indexOf(p.color)); return theme.series[i % theme.series.length] || theme.accent; };
    const say = (text) => { status.textContent = text; if (text && ctx.ui.announce) ctx.ui.announce(text); };

    // ---- pinning the current run
    function canPin() {
        const st = store.get(), run = st.run || {};
        if (!st.resolved) return { ok: false, why: 'The project has errors; fix them before pinning.' };
        if (!run.result) return { ok: false, why: 'No run yet. Run the particles (Run ▶) first.' };
        if (run.status === 'running') return { ok: false, why: 'Wait for the run to finish.' };
        if (run.status === 'stale') return { ok: false, why: 'The project changed since this run; run the particles again before pinning.' };
        // a live preview traces at most 200 particles per source: pin it only when that is every particle
        if (run.live && !(run.result.n >= (st.resolved.particleCount || 0))) return { ok: false, why: 'The live preview traces only some of the particles; make a full run (Run ▶) before pinning.' };
        if (pins().length >= MAX_PINS) return { ok: false, why: `${MAX_PINS} runs are pinned; unpin one first.` };
        return { ok: true, why: '' };
    }
    function pinCurrent() {
        const c = canPin();
        if (!c.ok) { say(c.why); return; }
        const st = store.get(), res = st.run.result;
        const resolved = res.resolvedSnapshot || st.resolved;
        const model = st.field && st.field.model ? st.field.model : null;
        let pin;
        try { pin = makePin({ project: st.project, resolved, result: res, model, color: nextPinColor(pins()) }); }
        catch (e) { say(`The run could not be pinned: ${e && e.message ? e.message : e}`); return; }
        if (st.run.partial || st.run.status === 'partial') pin.label += ' (partial run)';
        results.set(pin.id, { ghost: ghostOf(res), geomKey: (st.keys && st.keys.geomKey) || null, metrics: pin.metrics, engineVersion: pin.engineVersion, error: null });
        store.pinRun(pin);
        say(`Pinned "${pin.label}".`);
    }

    // ---- regeneration of pinned runs from their snapshots (one at a time, in pin order)
    async function regenerate() {
        if (regenerating || destroyed) return;
        regenerating = true;
        try {
            for (;;) {
                const all = pins();
                const p = all.find((q) => !results.has(q.id));
                if (!p || destroyed) break;
                status.textContent = `Regenerating pinned run ${all.indexOf(p) + 1} of ${all.length}: ${p.label}…`;
                const entry = { ghost: null, geomKey: null, metrics: null, engineVersion: ctx.version ? ctx.version.ENGINE_VERSION : null, error: null };
                try {
                    const project = ctx.engine.schema && typeof ctx.engine.schema.migrate === 'function' ? ctx.engine.schema.migrate(p.project) : p.project;
                    // only the metrics, the geometry key and a thinned copy of the trajectories outlive the temporary project
                    const out = await ctx.jobs.withTemporaryProject(project, async (tmp) => {
                        const r = await tmp.run();
                        if (!r) return null;
                        if (r.partial) return { partial: true };
                        return { ghost: ghostOf(r), geomKey: tmp.keys ? tmp.keys.geomKey : null, metrics: pinMetrics(r, tmp.resolved, tmp.field && tmp.field.model ? tmp.field.model : null) };
                    });
                    if (!out) throw new Error('the run produced no result');
                    if (out.partial) throw new Error('the run was stopped before it finished');
                    entry.ghost = out.ghost; entry.geomKey = out.geomKey; entry.metrics = out.metrics;
                } catch (e) { entry.error = e && e.message ? e.message : String(e); }
                if (destroyed) return;
                // the pin may have been removed meanwhile
                if (pins().some((q) => q.id === p.id)) { results.set(p.id, entry); paths.delete(p.id); }
                render();
                view.requestRender();
            }
            if (!destroyed && /^Regenerating/.test(status.textContent)) {
                const n = pins().length, bad = pins().filter((q) => { const r = results.get(q.id); return r && r.error; }).length;
                status.textContent = bad ? `${bad} pinned run${bad === 1 ? '' : 's'} could not be regenerated (see the list).` : (n ? `${n} pinned run${n === 1 ? '' : 's'} regenerated.` : '');
            }
        } finally { regenerating = false; }
    }

    // ---- opening a pinned project
    async function loadPin(p) {
        let ok = true;
        if (ctx.ui.openDialog) {
            ok = await ctx.ui.openDialog({ title: 'Open the pinned project', body: `Replace the current project with "${p.label}"? The current project moves to Recent projects.`,
                actions: [{ label: 'Cancel', value: false }, { label: 'Open', value: true, primary: true }] });
        }
        if (ok !== true) return;
        const project = JSON.parse(JSON.stringify(p.project));
        if (ctx.app && typeof ctx.app.loadProject === 'function') ctx.app.loadProject(project, { label: 'Open pinned run' });
        else store.replaceProject(project, { label: 'Open pinned run' });
    }

    // ---- rendering
    function renderButtons() {
        const c = canPin();
        pinBtn.disabled = !c.ok;
        pinBtn.title = c.ok ? 'Keep the current project and run for comparison' : c.why;
        csvBtn.disabled = clearBtn.disabled = !pins().length;
    }
    /** True when a pin's geometry is the current project's (only then is its ghost drawn). */
    const sameGeometry = (r) => { const k = store.get().keys; return !!(r && r.geomKey && k && k.geomKey === r.geomKey); };
    function render() {
        const ps = pins();
        renderButtons();
        list.replaceChildren();
        tableBox.replaceChildren();
        if (!ps.length) { list.appendChild(h('p', { class: 'io-empty', text: 'No pinned runs yet.' })); return; }
        let changed = 0, other = 0;
        ps.forEach((p, i) => {
            const r = results.get(p.id);
            const swatch = h('span', { class: 'io-cmp-swatch', style: { background: `var(--${PIN_COLORS.includes(p.color) ? p.color : 'c1'})` }, 'aria-hidden': 'true' });
            const label = h('input', { class: 'input io-cmp-label', type: 'text', value: p.label, 'aria-label': `Label of pinned run ${i + 1}`, spellcheck: 'false' });
            label.addEventListener('change', () => { const v = label.value.trim(); if (v && v !== p.label) store.pinRun({ ...p, label: v }); else label.value = p.label; });
            const show = h('input', { type: 'checkbox', checked: p.visible !== false, 'aria-label': `Show pinned run ${i + 1} on the canvas` });
            show.addEventListener('change', () => store.pinRun({ ...p, visible: show.checked }));
            const loadBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Open', title: 'Open the pinned project (the current one moves to Recent projects)' });
            loadBtn.addEventListener('click', () => loadPin(p));
            const unpinBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Unpin' });
            unpinBtn.addEventListener('click', () => { results.delete(p.id); paths.delete(p.id); store.unpinRun(p.id); say(`Unpinned "${p.label}".`); });
            const state = h('p', { class: 'io-note io-cmp-state' });
            if (!r) state.textContent = 'Regenerating…';
            else if (r.error) { state.textContent = `Could not be regenerated: ${r.error}`; state.classList.add('io-warn-text'); }
            else {
                state.textContent = pinSummary(r.metrics);
                if (metricsDiffer(p.metrics, r.metrics)) {
                    changed++;
                    const then = p.engineVersion && r.engineVersion && p.engineVersion !== r.engineVersion ? `, engine ${p.engineVersion} then` : '';
                    state.append(' ', h('span', { class: 'io-warn-text', text: `(differs from the run as pinned${then})` }));
                }
                if (r.metrics && r.metrics.waist && !r.metrics.waist.ok && r.metrics.waist.reason) state.append(' ', h('span', { class: 'io-cmp-dim', text: `(no waist: ${r.metrics.waist.reason})` }));
                if (!sameGeometry(r)) { other++; state.append(' ', h('span', { class: 'io-cmp-dim', text: '(another geometry: not drawn on this canvas)' })); }
            }
            list.appendChild(h('div', { class: 'io-cmp-pin', role: 'listitem' },
                h('div', { class: 'io-cmp-pin-row' }, h('span', { class: 'io-cmp-index', text: String(i + 1) }), swatch, label,
                    h('label', { class: 'io-inline io-cmp-show' }, show, h('span', { text: 'Canvas' })), loadBtn, unpinBtn),
                state));
        });
        if (other) list.appendChild(h('p', { class: 'io-note', text: `${other === 1 ? '1 pinned run belongs' : `${other} pinned runs belong`} to another geometry and ${other === 1 ? 'is' : 'are'} not drawn on this canvas (Open loads a pinned project with its ghost).` }));
        const t = percentRows(compareTable(ps, metricsOf));
        tableBox.appendChild(dataTable({ columns: t.columns, rows: t.rows, caption: 'Pinned runs side by side' }));
        if (changed) tableBox.appendChild(h('p', { class: 'io-note io-warn-text', text: 'The table shows the regenerated values. Where they differ from the values stored when the run was pinned, the engine or a preset has changed since; pin the run again to refresh the stored values.' }));
        if (ps.some((p) => { const r = results.get(p.id); return r && r.metrics && r.metrics.trajectories === false; })) tableBox.appendChild(h('p', { class: 'io-note', text: 'A pinned run without stored trajectories (Recording ▸ trajectories off) has no ghost on the canvas; its metrics are still listed.' }));
    }

    // ---- canvas ghosts (overlay hook)
    /** Path2D of a pin's ghost in stretched coordinates (x, aspect·y), so the uniform transform strokes even widths. */
    function pathFor(p, r, projection, ay) {
        const e = paths.get(p.id);
        if (e && e.projection === projection && e.ay === ay) return e.path;
        const { offsets, pts, n } = r.ghost;
        const fold = projection === 'xrho';
        const py = (q) => ay * (fold ? Math.sign(pts[3 * q + 1] || 1) * Math.hypot(pts[3 * q + 1], pts[3 * q + 2]) : pts[3 * q + 1]);
        const path = new Path2D();
        for (let i = 0; i < n; i++) {
            const a = offsets[i], b = offsets[i + 1];
            if (b - a < 2) continue;
            path.moveTo(pts[3 * a], py(a));
            for (let q = a + 1; q < b; q++) path.lineTo(pts[3 * q], py(q));
        }
        paths.set(p.id, { projection, ay, path });
        return path;
    }
    function drawGhosts(c, xf) {
        const ps = pins();
        if (!ps.length) return;
        const proj = store.get().project, projection = (proj && proj.view && proj.view.projection) || 'xy';
        const ay = isNum(xf.aspect) && xf.aspect > 0 ? xf.aspect : 1;
        ps.forEach((p, i) => {
            if (p.visible === false) return;
            const r = results.get(p.id);
            // a ghost is drawn only on its own geometry (never across another project's domain)
            if (!r || r.error || !sameGeometry(r)) return;
            const col = colorOf(p);
            if (r.ghost && r.ghost.pts.length) {
                c.save();
                // uniform transform (x, aspect·y): the dashes and the line width are the same along x and y under a stretch
                const d = xf.dpr || 1;
                c.setTransform(d * xf.scale, 0, 0, -d * xf.scale, d * (xf.W / 2 - xf.cx * xf.scale), d * (xf.H / 2 + xf.cy * ay * xf.scale));
                c.lineWidth = 1.25 / xf.scale;
                c.lineJoin = 'round';
                c.setLineDash([6 / xf.scale, 4 / xf.scale]);
                c.lineDashOffset = (i * 3) / xf.scale;
                c.globalAlpha = 0.55;
                c.strokeStyle = col;
                c.stroke(pathFor(p, r, projection, ay));
                c.restore();
            }
            const w = r.metrics && r.metrics.waist;
            if (w && w.ok && isNum(w.position) && (w.axis === 'x' || w.axis === 'y')) {
                const rms = isNum(w.rms) ? Math.abs(w.rms) : 0;
                const a = w.axis === 'x' ? xf.toScreen(w.position, rms) : xf.toScreen(rms, w.position);
                const b = w.axis === 'x' ? xf.toScreen(w.position, -rms) : xf.toScreen(-rms, w.position);
                c.save();
                xf.screen(c);
                c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 2; c.globalAlpha = 0.9;
                c.font = `11px ${theme.font}`;
                c.beginPath();
                if (w.axis === 'x') {
                    const half = Math.max(6, Math.abs(b[1] - a[1]) / 2), mid = 0.5 * (a[1] + b[1]);
                    c.moveTo(a[0], mid - half); c.lineTo(a[0], mid + half); c.stroke();
                    c.textAlign = 'center'; c.textBaseline = 'bottom';
                    c.fillText(String(i + 1), a[0], mid - half - 2);
                } else {
                    const half = Math.max(6, Math.abs(b[0] - a[0]) / 2), mid = 0.5 * (a[0] + b[0]);
                    c.moveTo(mid - half, a[1]); c.lineTo(mid + half, a[1]); c.stroke();
                    c.textAlign = 'left'; c.textBaseline = 'middle';
                    c.fillText(String(i + 1), mid + half + 3, a[1]);
                }
                c.restore();
            }
        });
    }

    // ---- wiring
    pinBtn.addEventListener('click', pinCurrent);
    csvBtn.addEventListener('click', () => download(compareCsv(pins(), metricsOf), 'compare.csv'));
    clearBtn.addEventListener('click', async () => {
        let ok = true;
        if (ctx.ui.openDialog) ok = await ctx.ui.openDialog({ title: 'Unpin all runs', body: `Remove all ${pins().length} pinned runs?`, actions: [{ label: 'Cancel', value: false }, { label: 'Unpin all', value: true, primary: true }] });
        if (ok !== true) return;
        for (const p of pins()) store.unpinRun(p.id);
        results.clear(); paths.clear();
        say('All runs unpinned.');
    });
    const offTheme = onThemeChange(() => { theme = themeColors(); view.requestRender(); });
    const offOverlay = view.addOverlay(OVERLAY_ID, drawGhosts);
    // pins saved in this browser, when the session has none yet
    if (!pins().length) for (const p of readPins()) store.pinRun(p);
    // pin changes are saved and drawn also while the tab is hidden (the phone sheet can hide or unpin them)
    const onRuns = () => {
        for (const id of [...results.keys()]) if (!pins().some((q) => q.id === id)) { results.delete(id); paths.delete(id); }
        if (!writePins(pins()) && !storageWarned && pins().length) { storageWarned = true; say('The pins could not be saved in this browser (storage blocked or full); they last for this session.'); }
        render();
        regenerate();
        view.requestRender();
    };
    const offRuns = store.on('runs', onRuns);
    // another geometry hides the ghosts at once (the overlay checks the key; the list notes it when shown)
    let lastGeom = (store.get().keys || {}).geomKey || null;
    const offGeom = store.on('resolved', () => { const g = (store.get().keys || {}).geomKey || null; if (g !== lastGeom) { lastGeom = g; if (!regenerating) status.textContent = ''; if (pins().length) view.requestRender(); } });
    render();
    regenerate();
    view.requestRender();

    return {
        update(evt) {
            if (!evt) return;
            if (evt.type === 'show') render();
            else if (['run', 'resolved', 'project', 'solve'].includes(evt.type)) { renderButtons(); if (evt.type === 'resolved') render(); }
        },
        destroy() {
            destroyed = true;
            offRuns(); offGeom();
            if (typeof offOverlay === 'function') offOverlay(); else view.removeOverlay(OVERLAY_ID);
            offTheme();
            root.remove();
        },
    };
}
