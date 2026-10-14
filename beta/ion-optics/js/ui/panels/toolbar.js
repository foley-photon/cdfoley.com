/* ==========================================================================
   Ion optics UI: panels/toolbar.js
   App bar (spec §4.2, §4.3, §4.6): Project menu (new, open, save, recent,
   export, duplicate, notes, settings), project name, undo/redo, Presets,
   the fields pill (state of the solution; click for the solver details),
   solve and run progress, Solve, Run, Live, Stop, Share and Help. On phones
   a compact bar keeps Presets, Run and a menu with everything else.
   Also builds the Methods text used by the export.
   ========================================================================== */
import { h, icon, clear, createMenu, fmtMs, fmtCount, fileStem, downloadText, downloadBlob, copyText } from '../dom.js';
import { formatPretty } from '../units.js';
import { ENGINE_VERSION, PRODUCT_NAME } from '../../engine/version.js';

/** Plain-language methods paragraph (fallback used only when the results package, analysis-jobs.js, cannot load). */
export function methodsText(state, { benchmark = null } = {}) {
    const r = state.resolved || state.lastResolved;
    if (!r) return 'The project has errors; fix them to describe the method.';
    const d = r.domain;
    const cyl = d.type === 'cyl2d';
    const K = Math.max(0, (r.electrodes || []).length - 1);
    const stats = Array.isArray(state.solve && state.solve.stats) ? state.solve.stats : [];
    const paths = [...new Set(stats.map((s) => (s.path || [s.method]).filter(Boolean).join(' → ')).filter(Boolean))];
    const solver = r.solver || {};
    const tr = r.tracer || {};
    const q = tr.q || {};
    const integ = tr.integrator === 'boris' ? 'the relativistic Boris pusher' : tr.integrator === 'rk4' ? 'fixed-step fourth-order Runge–Kutta' : tr.integrator === 'rk45' ? 'Dormand–Prince 5(4) with dense output' : 'Dormand–Prince 5(4) with dense output (Boris for long runs in purely magnetic fields)';
    const species = [];
    for (const s of r.sources || []) {
        const en = s.energy || {};
        const e = en.type === 'mono' ? `${formatPretty(en.ke, 'energy', 6)}` : en.type === 'uniform' ? `${formatPretty(en.min, 'energy', 6)} to ${formatPretty(en.max, 'energy', 6)}` : en.type === 'gaussian' ? `${formatPretty(en.mean, 'energy', 6)} (FWHM ${formatPretty(en.fwhm, 'energy', 4)})` : `${(en.values || []).length} energies`;
        species.push(`${s.count} × ${(s.species || []).map((x) => `${x.label || ''} (${formatPretty(x.mass, 'mass', 7)}, ${x.charge > 0 ? '+' : ''}${x.charge} e)`).join(', ')} at ${e}`);
    }
    const parts = [
        `Electrostatic fields were computed with ${PRODUCT_NAME} (engine ${ENGINE_VERSION}) on a ${cyl ? 'cylindrically symmetric (x, r)' : 'planar (x, y)'} grid of ${fmtCount(d.nx)} × ${fmtCount(d.ny)} nodes with a cell size of ${formatPretty(d.h, 'length', 6)}, using ${solver.boundary === 'staircase' ? 'staircase electrode boundaries' : 'Shortley–Weller sub-grid electrode boundaries'}.`,
        K ? `Laplace's equation was solved for ${K} basis field${K > 1 ? 's' : ''} (one per electrode at 1 V) by ${paths.length ? paths.join('; ') : 'the automatic multigrid → BiCGSTAB → SOR chain'} to an estimated algebraic error of ${solver.tol || 1e-10} V per volt, and the electrode voltages were combined by superposition.` : 'No electrode besides ground carries a voltage, so no field was solved.',
        `Particles were traced with ${integ} (relative tolerance ${q.rtol || '—'}, at most ${q.maxStepCells || '—'} cell per step) in the ${tr.fieldInterp === 'linear' ? 'bilinearly interpolated' : 'cubic Hermite (C¹) interpolated'} field, with ${tr.relativistic === false ? 'non-relativistic' : 'relativistic'} equations of motion.`,
    ];
    if (species.length) parts.push(`Sources: ${species.join('; ')}.`);
    if ((r.magnets || []).length) parts.push(`Magnetic fields: ${r.magnets.length} (hard-edged regions, uniform fields or circular current loops).`);
    parts.push(benchmark || 'The validation suite (Benchmarks tab) compares the engine with published and analytic values.');
    return parts.join(' ');
}

/** Mounts the app bar. */
export function mountToolbar(el, ctx, app) {
    const { store, jobs, persist } = ctx;
    const st = () => store.get();
    clear(el);
    const btn = (label, ic, { cls = 'btn btn-ghost btn-sm', guide = null, title = null, only = 'desktop' } = {}) => {
        const b = h('button', { type: 'button', class: `${cls} ${only === 'desktop' ? 'io-desktop-only' : ''}`, dataset: guide ? { guide } : null, title: title || label, 'aria-label': label || title }, ic ? icon(ic, 16) : null, label ? h('span', { class: 'io-btn-label', text: label }) : null);
        return b;
    };

    // ---- project menu and name
    const projBtn = btn('Project', 'file', { title: 'Project menu', cls: 'btn btn-ghost btn-sm io-compact' });
    projBtn.appendChild(icon('chevron', 14));
    const fileInput = h('input', { type: 'file', accept: '.json,.ionopt.json,application/json', hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
    fileInput.addEventListener('change', async () => {
        const f = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (!f) return;
        try { const p = await persist.readProjectFile(f); app.loadProject(p, { label: 'Open file' }); ctx.ui.toast(`Opened ${f.name}.`, { kind: 'ok' }); }
        catch (e) { ctx.ui.toast(`Could not open ${f.name}: ${e && e.message ? e.message : e}`, { kind: 'error' }); }
    });
    const nameIn = h('input', { type: 'text', class: 'io-name io-desktop-only', 'aria-label': 'Project name', spellcheck: 'false', maxlength: '200' });
    nameIn.addEventListener('change', () => {
        const v = nameIn.value.trim() || 'Untitled project';
        ctx.commit((p) => { p.meta = { ...(p.meta || {}), name: v }; }, { label: 'Rename project' });
    });
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { nameIn.blur(); } else if (e.key === 'Escape') { nameIn.value = (st().project.meta || {}).name || ''; nameIn.blur(); } });
    const undoB = btn('', 'undo', { cls: 'icon-btn', title: 'Undo (Ctrl+Z)' });
    const redoB = btn('', 'redo', { cls: 'icon-btn', title: 'Redo (Ctrl+Y)' });
    undoB.addEventListener('click', () => store.undo());
    redoB.addEventListener('click', () => store.redo());
    const presetsB = btn('Presets', 'layers', { cls: 'btn btn-secondary btn-sm', guide: 'toolbar:presets', title: 'Example devices', only: 'all' });
    presetsB.addEventListener('click', () => app.openPresets());

    // ---- fields pill, progress, solve/run/live/stop
    const pill = h('button', { type: 'button', class: 'io-pill io-desktop-only', title: 'Solver details' });
    pill.addEventListener('click', () => openSolveDetails(ctx, app));
    const prog = h('div', { class: 'io-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', hidden: true, 'aria-label': 'Progress' }, h('span', { class: 'io-progress-bar' }, h('span')), h('span', { class: 'io-progress-text' }));
    const solveB = btn('Solve', 'solve', { cls: 'btn btn-secondary btn-sm io-btn-solve io-compact', guide: 'toolbar:solve', title: 'Solve the fields (S)' });
    solveB.addEventListener('click', () => app.solve());
    const runB = btn('Run', 'play', { cls: 'btn btn-primary btn-sm', guide: 'toolbar:run', title: 'Run all particles (R)', only: 'all' });
    runB.addEventListener('click', () => app.run());
    const liveB = btn('Live', 'live', { cls: 'btn btn-secondary btn-sm io-toggle io-compact', guide: 'toolbar:live', title: 'Live preview while editing (L)' });
    liveB.addEventListener('click', () => app.setLive(st().ui.live === false));
    const stopB = btn('Stop', 'stop', { cls: 'btn btn-secondary btn-sm io-compact', title: 'Stop (Esc)' });
    stopB.addEventListener('click', () => app.stop());
    const shareB = btn('Share', 'share', { cls: 'btn btn-ghost btn-sm io-compact', guide: 'toolbar:share', title: 'Copy a link to this project' });
    shareB.addEventListener('click', () => app.share());
    const helpA = h('a', { class: 'icon-btn io-desktop-only', href: 'help/', target: '_blank', rel: 'noopener', title: 'Help (opens in a new tab)', 'aria-label': 'Help (opens in a new tab)' }, icon('help', 18));
    const inspB = btn('', 'inspector', { cls: 'icon-btn io-inspector-toggle', title: 'Show the inspector' });
    inspB.addEventListener('click', () => {
        const wb = document.getElementById('io-workbench');
        if (wb.classList.contains('io-insp-open')) app.closeInspector && app.closeInspector(); else app.openInspector && app.openInspector(true);
    });
    const moreB = h('button', { type: 'button', class: 'icon-btn io-phone-only', 'aria-label': 'More actions' }, icon('menu', 18));

    el.append(projBtn, fileInput, nameIn, undoB, redoB, presetsB, h('span', { class: 'io-sep io-desktop-only' }), pill, prog, h('span', { class: 'io-spacer' }),
        solveB, runB, liveB, stopB, h('span', { class: 'io-sep io-desktop-only' }), shareB, helpA, inspB, moreB);

    // ---- menus
    const projectItems = () => [
        { label: 'New cylindrical project', onSelect: () => app.newProject('cyl2d') },
        { label: 'New planar project', onSelect: () => app.newProject('planar2d') },
        { label: 'Open a project file…', onSelect: () => fileInput.click() },
        { label: 'Save to a file', shortcut: 'Ctrl+S', onSelect: () => app.saveFile() },
        { label: 'Recent projects…', onSelect: () => openRecent(ctx, app) },
        { label: 'Export…', onSelect: () => openExport(ctx, app) },
        { separator: true },
        { label: 'Duplicate project', onSelect: () => app.duplicateProject() },
        { label: 'Notes…', onSelect: () => openNotes(ctx, app) },
        { label: 'Settings…', onSelect: () => openSettings(ctx, app) },
        { label: 'Keyboard shortcuts', shortcut: '?', onSelect: () => app.showShortcuts && app.showShortcuts() },
    ];
    createMenu(projBtn, projectItems, { label: 'Project' });
    createMenu(moreB, () => [
        { label: 'Solve fields', onSelect: () => app.solve() },
        { label: st().ui.live === false ? 'Turn live preview on' : 'Turn live preview off', onSelect: () => app.setLive(st().ui.live === false) },
        { label: 'Stop', onSelect: () => app.stop(), disabled: !busy() },
        { label: 'Share a link', onSelect: () => app.share() },
        { label: 'Benchmarks', onSelect: () => app.mobile && app.mobile.showSheet ? app.mobile.showSheet('more') : app.showDockTab('bench') },
        { label: 'Help', onSelect: () => window.open('help/', '_blank', 'noopener') },
        { separator: true },
        ...projectItems(),
    ], { label: 'More actions' });

    // ---- state
    function busy() { const s = st(); return s.solve.status === 'running' || s.solve.status === 'queued' || s.run.status === 'running'; }
    let pulse = false;
    if (jobs && typeof jobs.on === 'function') jobs.on('solve:pulse', () => { pulse = true; sync(); });
    function sync() {
        const s = st();
        const meta = s.project.meta || {};
        if (document.activeElement !== nameIn) nameIn.value = meta.name || '';
        undoB.disabled = !store.canUndo();
        redoB.disabled = !store.canRedo();
        const ul = store.undoLabel ? store.undoLabel() : null, rl = store.redoLabel ? store.redoLabel() : null;
        undoB.title = ul ? `Undo ${ul} (Ctrl+Z)` : 'Undo (Ctrl+Z)'; undoB.setAttribute('aria-label', undoB.title);
        redoB.title = rl ? `Redo ${rl} (Ctrl+Y)` : 'Redo (Ctrl+Y)'; redoB.setAttribute('aria-label', redoB.title);
        // fields pill
        const sv = s.solve || {};
        const r = s.resolved || s.lastResolved;
        const K = r ? Math.max(0, r.electrodes.length - 1) : 0;
        let txt, state = sv.status || 'none';
        if (state === 'done') txt = `fields up to date · ${fmtMs(solveMs(sv))}`;
        else if (state === 'stale') txt = 'fields stale (geometry changed)';
        else if (state === 'running' || state === 'queued') {
            const pg = sv.progress || {};
            const total = pg.total || K || 1, done = Math.min(total, (pg.done || 0) + 1);
            txt = `solving ${done}/${total} · ${Math.round(100 * (pg.frac || 0))}%`;
        } else if (state === 'error') txt = 'fields: error';
        else txt = K ? 'fields not solved' : 'no fields to solve';
        if (!s.valid && s.valid !== undefined) { txt = 'project has errors'; state = 'error'; }
        pill.textContent = txt;
        pill.dataset.state = state;
        pill.setAttribute('aria-label', `Field solution: ${txt}. Show solver details.`);
        if (state !== 'stale') pulse = false;
        solveB.classList.toggle('io-pulse', state === 'stale' || pulse);
        // progress
        const run = s.run || {};
        let frac = null, ptxt = '';
        if (state === 'running' || state === 'queued') {
            const pg = sv.progress || {};
            frac = pg.frac || 0;
            ptxt = pg.text || `Solving fields: electrode ${Math.min(pg.total || K, (pg.done || 0) + 1)}/${pg.total || K}${pg.cycle ? ` · cycle ${pg.cycle}` : ''}${pg.estErr ? ` · est. error ${Number(pg.estErr).toExponential(0)}` : ''}`;
        } else if (run.status === 'running') {
            const pg = run.progress || {};
            frac = pg.total ? pg.done / pg.total : 0;
            ptxt = pg.text || `${pg.done || 0}/${pg.total || 0} particles${pg.etaMs ? ` · about ${Math.max(1, Math.round(pg.etaMs / 1000))} s left` : ''}`;
        }
        prog.hidden = frac === null;
        if (frac !== null) {
            prog.firstChild.firstChild.style.width = `${Math.round(100 * frac)}%`;
            prog.lastChild.textContent = ptxt;
            prog.setAttribute('aria-valuenow', String(Math.round(100 * frac)));
            prog.setAttribute('aria-valuetext', ptxt);
        }
        const live = s.ui.live !== false;
        liveB.setAttribute('aria-pressed', live ? 'true' : 'false');
        stopB.disabled = !busy();
        runB.disabled = !s.valid && s.valid !== undefined;
    }
    sync();
    for (const evt of ['project', 'solve', 'run', 'ui', 'resolved', 'solution']) store.on(evt, sync);
    return { update: sync };
}

function solveMs(sv) {
    if (typeof sv.ms === 'number') return sv.ms;
    return Array.isArray(sv.stats) ? sv.stats.reduce((a, b) => a + (b.ms || 0), 0) : 0;
}

/** Solver details: per-electrode method path, cycles, estimated error, residual and time. */
export function openSolveDetails(ctx, app) {
    const s = ctx.store.get();
    const sv = s.solve || {};
    const r = s.resolved || s.lastResolved;
    const body = h('div');
    const e = app.estimate ? app.estimate() : null;
    if (r) body.appendChild(h('p', { class: 'io-note', text: `${fmtCount(r.domain.nx)} × ${fmtCount(r.domain.ny)} = ${fmtCount(r.domain.N)} nodes${e && e.levels ? ` · ${e.levels} multigrid levels` : ''} · ${Math.max(0, r.electrodes.length - 1)} basis fields · status: ${sv.status || 'none'}.` }));
    const stats = Array.isArray(sv.stats) ? sv.stats : [];
    if (stats.length) {
        const tbl = h('table', { class: 'io-stats-table' }, h('caption', { class: 'visually-hidden', text: 'Solver statistics per electrode' }),
            h('thead', null, h('tr', null, ...['Electrode', 'Method path', 'Cycles / iterations / sweeps', 'Est. error (V/V)', 'Residual', 'Time'].map((t) => h('th', { scope: 'col', text: t })))));
        const tb = h('tbody');
        for (const x of stats) {
            const el = r && r.electrodes ? r.electrodes[x.k] : null;
            tb.appendChild(h('tr', null,
                h('td', { text: el ? el.name || el.id : (x.electrode || String(x.k)) }),
                h('td', { text: (x.path || [x.method]).filter(Boolean).join(' → ') + (x.converged === false ? ' (not converged)' : '') }),
                h('td', { class: 'num', text: `${x.cycles || 0} / ${x.iterations || 0} / ${x.sweeps || 0}` }),
                h('td', { class: 'num', text: Number.isFinite(x.estErr) ? x.estErr.toExponential(1) : '—' }),
                h('td', { class: 'num', text: Number.isFinite(x.scaledResidual) ? x.scaledResidual.toExponential(1) : '—' }),
                h('td', { class: 'num', text: fmtMs(x.ms) })));
        }
        tbl.appendChild(tb);
        body.appendChild(h('div', { class: 'io-scroll-x' }, tbl));
    } else body.appendChild(h('p', { class: 'io-empty', text: sv.status === 'error' ? `The solve failed: ${(sv.error && sv.error.message) || 'unknown error'}` : 'No solve yet.' }));
    const warns = Array.isArray(sv.warnings) ? sv.warnings : [];
    if (warns.length) body.append(h('h3', { class: 'io-group-title', text: 'Geometry warnings' }), h('ul', null, ...warns.slice(0, 30).map((w) => h('li', { text: w.message || w.code }))));
    return ctx.ui.openDialog({ title: 'Field solution', body, wide: true, actions: [{ label: 'Close', value: null }, { label: 'Solve again', value: 'solve', primary: true, onClick: () => { app.solve(); return true; } }] });
}

function openRecent(ctx, app) {
    let list = [];
    try { list = ctx.persist.recent() || []; } catch (e) { list = []; }
    const body = h('div', { class: 'io-preset-list', role: 'list' });
    const pr = ctx.ui.openDialog({ title: 'Recent projects', body, actions: [{ label: 'Close', value: null }] });
    if (!list.length) body.appendChild(h('p', { class: 'io-empty', text: 'No recent projects in this browser.' }));
    for (const it of list) {
        const p = it.project || it;
        const when = it.savedAt || it.time;
        const b = h('button', { type: 'button', class: 'io-preset-item', role: 'listitem' }, h('strong', { text: it.name || (p.meta && p.meta.name) || 'Untitled project' }),
            h('span', { text: `${p.domain && p.domain.type === 'planar2d' ? 'Planar' : 'Cylindrical'} · ${(p.shapes || []).length} shapes${when ? ' · ' + new Date(when).toLocaleString() : ''}` }));
        b.addEventListener('click', () => { pr.close('open'); app.loadProject(p, { label: 'Open recent project' }); });
        body.appendChild(b);
    }
    const first = body.querySelector('button');
    if (first) first.focus();
    return pr;
}

function openNotes(ctx) {
    const p = ctx.store.get().project;
    const ta = h('textarea', { class: 'input io-textarea', id: 'io-notes', rows: '10', spellcheck: 'true' });
    ta.value = (p.meta && p.meta.notes) || '';
    const body = h('div', { class: 'field' }, h('label', { for: 'io-notes', text: 'Notes (plain text, saved with the project)' }), ta);
    return ctx.ui.openDialog({ title: 'Project notes', body, actions: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true, onClick: () => {
        ctx.commit((d) => { d.meta = { ...(d.meta || {}), notes: ta.value }; }, { label: 'Notes' });
        return true;
    } }] });
}

async function openSettings(ctx) {
    const cache = ctx.persist.basisCache;
    const body = h('div');
    const cid = 'io-set-cache', aid = 'io-set-auto';
    const cacheBox = h('input', { type: 'checkbox', id: cid });
    const autoBox = h('input', { type: 'checkbox', id: aid });
    const usage = h('p', { class: 'hint' });
    const clearB = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Clear cache' });
    const enabled = () => { try { return cache ? (typeof cache.enabled === 'function' ? cache.enabled() : !!cache.enabled) : false; } catch (e) { return false; } };
    cacheBox.checked = enabled();
    autoBox.checked = ctx.store.get().ui.autoSolve !== false;
    const showUsage = async () => {
        if (!cache || typeof cache.usage !== 'function') { usage.textContent = 'Off by default; up to 100 MB in this browser.'; return; }
        try { const u = await cache.usage(); usage.textContent = `${u.entries || 0} basis fields, ${((u.bytes || 0) / 1048576).toFixed(1)} MB used of 100 MB.`; } catch (e) { usage.textContent = ''; }
    };
    cacheBox.addEventListener('change', async () => {
        try { if (cacheBox.checked) await cache.enable(true); else cache.disable(); } catch (e) { /* storage blocked */ }
        cacheBox.checked = enabled();
        if (cacheBox.checked === false && ctx.ui.toast && cache && cache.notice && cache.notice()) ctx.ui.toast(cache.notice().message, { kind: 'warn' });
        showUsage();
    });
    clearB.addEventListener('click', async () => { try { await cache.clear(); } catch (e) { /* ignore */ } showUsage(); if (ctx.ui.announce) ctx.ui.announce('Cache cleared.'); });
    autoBox.addEventListener('change', () => ctx.store.setUi('autoSolve', autoBox.checked));
    body.append(
        h('label', { class: 'io-check', for: aid }, autoBox, h('span', { text: 'Solve automatically after geometry edits (when the solve takes under 1.5 s)' })),
        h('hr'),
        h('label', { class: 'io-check', for: cid }, cacheBox, h('span', { text: 'Keep solved basis fields in this browser (IndexedDB, up to 100 MB)' })),
        usage, clearB,
        h('p', { class: 'hint', text: 'Everything runs in this browser; nothing is uploaded. The cache only speeds up reopening the same geometry.' }));
    if (!cache) { cacheBox.disabled = true; clearB.disabled = true; }
    showUsage();
    return ctx.ui.openDialog({ title: 'Settings', body, actions: [{ label: 'Close', value: null, primary: true }] });
}

/** Export: canvas PNG (1–4×, white background, scale bar), CSV tables, project JSON, Methods text. */
export async function openExport(ctx, app) {
    // the Methods text of the Summary tab (analysis-jobs, with the latest benchmark result); this module's own text is the fallback
    let methodsFn = methodsText;
    try { const aj = await import('../analysis-jobs.js'); if (aj && typeof aj.methodsText === 'function') methodsFn = (st) => aj.methodsText(st); } catch (e) { /* results package unavailable */ }
    const s = ctx.store.get();
    const res = s.run && s.run.result;
    const stem = fileStem((s.project.meta && s.project.meta.name) || 'project');
    const body = h('div', { class: 'io-export-grid' });
    const scaleSel = h('select', { id: 'io-ex-scale', class: 'io-select' }, ...[1, 2, 3, 4].map((k) => h('option', { value: String(k), text: `${k}×` })));
    scaleSel.value = '2';
    const white = h('input', { type: 'checkbox', id: 'io-ex-white' });
    const bar = h('input', { type: 'checkbox', id: 'io-ex-bar', checked: true });
    const png = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, icon('download', 16), h('span', { text: 'Save PNG' }));
    png.addEventListener('click', async () => {
        try {
            const blob = await ctx.view.exportPNG({ scale: Number(scaleSel.value), white: white.checked, scaleBar: bar.checked });
            if (blob) downloadBlob(blob, `${stem}.png`);
        } catch (e) { ctx.ui.toast('The image could not be saved: ' + (e.message || e), { kind: 'error' }); }
    });
    body.appendChild(h('fieldset', null, h('legend', { text: 'Canvas image' }),
        h('div', { class: 'io-btnrow' }, h('label', { for: 'io-ex-scale', text: 'Resolution' }), scaleSel,
            h('label', { class: 'io-check', for: 'io-ex-white' }, white, h('span', { text: 'White background' })),
            h('label', { class: 'io-check', for: 'io-ex-bar' }, bar, h('span', { text: 'Scale bar' })), png)));
    const csvRow = h('div', { class: 'io-btnrow' });
    for (const [which, label] of [['hits', 'Hits'], ['crossings', 'Plane crossings'], ['trajectories', 'Trajectories'], ['markers', 'Time markers']]) {
        const b = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', disabled: !res }, icon('download', 16), h('span', { text: label }));
        b.addEventListener('click', () => {
            try {
                const csv = ctx.engine.io.runToCSV(res, which, res.resolvedSnapshot || s.resolved || s.lastResolved);
                downloadText(csv, `${stem}-${which}.csv`, 'text/csv');
            } catch (e) { ctx.ui.toast(`The ${label.toLowerCase()} table could not be exported: ${e.message || e}`, { kind: 'error' }); }
        });
        csvRow.appendChild(b);
    }
    body.appendChild(h('fieldset', null, h('legend', { text: 'Tables (CSV)' }), res ? csvRow : h('p', { class: 'io-empty', text: 'Run the particles first.' })));
    const json = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('download', 16), h('span', { text: 'Project file (.ionopt.json)' }));
    json.addEventListener('click', () => app.saveFile());
    const mt = methodsFn(s);
    const copyM = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('copy', 16), h('span', { text: 'Copy Methods text' }));
    copyM.addEventListener('click', async () => { const ok = await copyText(mt); ctx.ui.toast(ok ? 'Methods text copied.' : 'Copying failed; use the download.', { kind: ok ? 'ok' : 'warn' }); });
    const dlM = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Download as text' });
    dlM.addEventListener('click', () => downloadText(mt, `${stem}-methods.txt`));
    body.appendChild(h('fieldset', null, h('legend', { text: 'Project and methods' }), h('div', { class: 'io-btnrow' }, json, copyM, dlM), h('p', { class: 'hint', text: mt })));
    return ctx.ui.openDialog({ title: 'Export', body, wide: true, actions: [{ label: 'Close', value: null }] });
}
