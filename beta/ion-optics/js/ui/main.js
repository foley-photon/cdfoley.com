/* ==========================================================================
   Ion optics UI: main.js
   Boots the workbench: loads the platform (store, pool, jobs, persist and
   the schema, hash, io and expr modules), builds the shell (app bar, model
   rail, canvas, inspector, status bar, results dock), the panel registry for
   the analysis and preset packages (loaded lazily with dynamic import(),
   "Panel unavailable" when a module is missing), the context object handed
   to every panel (spec §2.5), dialogs, toasts and the live region.
   ========================================================================== */
import * as dom from './dom.js';
import * as units from './units.js';
import * as forms from './forms.js';
import { createCommitter } from './forms.js';
import * as colormaps from './colormaps.js';
import * as layout from '../engine/layout.js';
import * as constants from '../engine/constants.js';
import * as analysis from '../engine/analysis.js';
import * as geometry from '../engine/geometry.js';
import { PRODUCT_NAME, ENGINE_VERSION, PROTOCOL_VERSION } from '../engine/version.js';
import { createView, ASPECTS } from './view2d.js';
import { createReplay, SPEEDS } from './replay.js';
import { createTools } from './tools.js';
import { installShortcuts } from './shortcuts.js';
import { createA11y, runStats } from './a11y.js';
import { createMobile } from './mobile.js';
import { mountToolbar } from './panels/toolbar.js';
import { mountElectrodes } from './panels/electrodes.js';
import { mountShapes } from './panels/shapes.js';
import { mountParams } from './panels/params.js';
import { mountParticles } from './panels/particles.js';
import { mountFields } from './panels/fields.js';
import { mountRecording } from './panels/recording.js';
import { mountDomain } from './panels/domain.js';
import { mountInspector } from './panels/inspector.js';
import { mountStatusbar } from './panels/statusbar.js';

const { h, icon } = dom;

/** Model rail tabs (WP4 panels). */
export const RAIL_TABS = Object.freeze([
    { id: 'electrodes', title: 'Electrodes', icon: 'electrode', mount: mountElectrodes },
    { id: 'shapes', title: 'Shapes', icon: 'shapes', mount: mountShapes },
    { id: 'params', title: 'Params', icon: 'params', mount: mountParams },
    { id: 'particles', title: 'Particles', icon: 'particles', mount: mountParticles },
    { id: 'fields', title: 'Fields', icon: 'magnet', mount: mountFields },
    { id: 'recording', title: 'Recording', icon: 'recording', mount: mountRecording },
    { id: 'domain', title: 'Domain', icon: 'domain', mount: mountDomain },
]);

/**
 * Results dock registry (panels of the analysis package, loaded lazily). `planned` panels are later-phase
 * features and are not requested in beta 1.
 */
export const DOCK_PANELS = Object.freeze([
    { id: 'summary', title: 'Summary', path: './panels/results.js', order: 10 },
    { id: 'hits', title: 'Hits', path: './panels/hits.js', order: 20 },
    { id: 'planes', title: 'Planes', path: './panels/planes.js', order: 30 },
    { id: 'tof', title: 'TOF', path: './panels/tof.js', order: 40 },
    { id: 'lens', title: 'Lens', path: './panels/lens.js', order: 50 },
    { id: 'profile', title: 'Profile', path: './panels/profile.js', order: 60 },
    { id: 'charges', title: 'Charges & multipoles', path: './panels/charges.js', order: 65 },
    { id: 'scan', title: 'Scan & tune', path: './panels/scan.js', order: 70 },
    { id: 'compare', title: 'Compare', path: './panels/compare.js', order: 80 },
    { id: 'bench', title: 'Benchmarks', path: './panels/benchmarks.js', order: 90 },
    { id: 'log', title: 'Log', path: './panels/log.js', order: 100 },
]);

/** Dialog modules of the presets package. */
export const DIALOG_MODULES = Object.freeze({ presets: './panels/presets.js', guide: './panels/guide.js', presetIndex: '../presets/index.js' });

const PLATFORM_PATHS = { store: './store.js', pool: './pool.js', jobs: './jobs.js', persist: './persist.js', schema: '../engine/schema.js', hash: '../engine/hash.js', io: '../engine/io.js', expr: '../engine/expr.js' };

/**
 * Loads the platform modules and returns a uniform object; rejects when any of them fails to load
 * (the page then says so instead of starting half-built).
 */
export async function loadPlatform() {
    const names = Object.keys(PLATFORM_PATHS);
    const mods = await Promise.all(names.map((n) => import(PLATFORM_PATHS[n])));
    const M = {};
    names.forEach((n, i) => { M[n] = mods[i]; });
    return {
        kind: 'real', schema: M.schema, hash: M.hash, io: M.io, expr: M.expr, persist: M.persist,
        createStore: (p, o) => M.store.createStore(p, o), createPool: (o) => M.pool.createPool(o), createJobs: (st, pl, ps, o) => M.jobs.createJobs(st, pl, ps, o),
    };
}

/**
 * The context object handed to panels (spec §2.5 panel contract).
 * @returns {object} ctx
 */
export function createContext({ store, jobs, persist, pool, view, platform, ui }) {
    return {
        store, jobs, persist, pool, view,
        ui: { dom, units, forms, colormaps, ...ui },
        engine: { schema: platform.schema, hash: platform.hash, io: platform.io, layout, constants, analysis, geometry, exact: null, lensprops: null, optimize: null, expr: platform.expr },
        plots: null,
        /** Validating project writer shared by the WP4 panels (an invalid edit never reaches the project). */
        commit: createCommitter({ store, schema: platform.schema }),
        version: { PRODUCT_NAME, ENGINE_VERSION, PROTOCOL_VERSION },
    };
}

// ---------------------------------------------------------------- dialogs, toasts, live region
let dialogLayer = null;

/**
 * Opens a modal dialog. opts: { title, body (Node|string|(el) => void), actions: [{ label, value, primary, danger }],
 * className, wide, onOpen(dialog) }. Resolves with the chosen action's value, or null on Escape/close.
 * The returned promise carries .dialog (the element) and .close(value).
 */
export function openDialog(opts = {}) {
    const prevFocus = document.activeElement;
    const titleId = dom.uid('io-dlg');
    const dlg = h('dialog', { class: ['io-dialog', opts.className, opts.wide ? 'io-dialog-wide' : null], 'aria-labelledby': titleId });
    const head = h('div', { class: 'io-dialog-head' }, h('h2', { id: titleId, text: opts.title || '' }));
    const closeBtn = h('button', { class: 'icon-btn io-dialog-x', type: 'button', 'aria-label': 'Close' }, icon('x'));
    head.appendChild(closeBtn);
    const body = h('div', { class: 'io-dialog-body' });
    if (typeof opts.body === 'string') body.appendChild(h('p', { text: opts.body }));
    else if (opts.body instanceof Node) body.appendChild(opts.body);
    else if (typeof opts.body === 'function') opts.body(body);
    const foot = h('div', { class: 'io-dialog-foot' });
    let resolveFn;
    const p = new Promise((res) => { resolveFn = res; });
    let done = false;
    const close = (value = null) => {
        if (done) return;
        done = true;
        try { dlg.close(); } catch (e) { /* already closed */ }
        dlg.remove();
        if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) prevFocus.focus();
        resolveFn(value);
    };
    for (const a of opts.actions || []) {
        const b = h('button', { type: 'button', class: ['btn', 'btn-sm', a.primary ? 'btn-primary' : a.danger ? 'btn-secondary io-danger' : 'btn-secondary'], text: a.label });
        b.addEventListener('click', () => { if (a.onClick) { const r = a.onClick(); if (r === false) return; } close(a.value === undefined ? a.label : a.value); });
        foot.appendChild(b);
    }
    dlg.append(head, body);
    if ((opts.actions || []).length) dlg.appendChild(foot);
    closeBtn.addEventListener('click', () => close(null));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg && opts.lightDismiss !== false) close(null); });
    (dialogLayer || document.body).appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    if (opts.onOpen) opts.onOpen(dlg, close);
    const first = dom.focusables(body)[0] || foot.querySelector('.btn-primary') || closeBtn;
    if (first && opts.autofocus !== false) first.focus();
    p.dialog = dlg;
    p.close = close;
    return p;
}

let toastBox = null;
/** Short message; kind: 'info'|'ok'|'warn'|'error'. */
export function toast(message, { kind = 'info', timeout = null, action = null } = {}) {
    if (!toastBox) return;
    const t = h('div', { class: ['io-toast', 'io-toast-' + kind], role: kind === 'error' ? 'alert' : 'status' }, h('span', { text: message }));
    if (action && action.label) {
        const b = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: action.label });
        b.addEventListener('click', () => { action.onClick && action.onClick(); t.remove(); });
        t.appendChild(b);
    }
    const x = h('button', { type: 'button', class: 'io-toast-x', 'aria-label': 'Dismiss' }, icon('x', 14));
    x.addEventListener('click', () => t.remove());
    t.appendChild(x);
    toastBox.appendChild(t);
    const ms = timeout || (kind === 'error' ? 9000 : 4500);
    setTimeout(() => t.remove(), ms);
    while (toastBox.children.length > 4) toastBox.firstChild.remove();
    return t;
}

let liveRegion = null;
/** Announces a message through the polite live region. */
export function announce(message) {
    if (!liveRegion) return;
    liveRegion.textContent = '';
    setTimeout(() => { liveRegion.textContent = String(message); }, 30);
}

// ---------------------------------------------------------------- log (shared with the Log panel)
function createLog() {
    const entries = [];
    const listeners = new Set();
    return {
        add(level, message, detail = null) {
            const e = { time: new Date(), level, message: String(message), detail };
            entries.push(e);
            if (entries.length > 500) entries.shift();
            for (const fn of listeners) fn(e);
            return e;
        },
        entries: () => entries.slice(),
        on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
}

// ---------------------------------------------------------------- boot
async function boot() {
    const root = document.getElementById('io-workbench');
    if (!root) return;
    for (const el of document.querySelectorAll('[data-product-name]')) el.textContent = PRODUCT_NAME;
    measureBanner();

    liveRegion = document.getElementById('io-live');
    toastBox = document.getElementById('io-toasts');
    dialogLayer = document.getElementById('io-dialogs') || document.body;
    const log = createLog();
    const status = document.getElementById('io-boot');
    const setBoot = (t) => { if (status) status.textContent = t; };

    let platform;
    try {
        platform = await loadPlatform();
    } catch (e) {
        setBoot('The simulator could not start: its program files did not load. Reload the page to try again.');
        root.classList.add('io-failed');
        return;
    }

    const mobileMq = typeof matchMedia === 'function' ? matchMedia('(max-width: 759.98px)') : null;
    const isPhone = () => !!(mobileMq && mobileMq.matches) || !!(navigator.deviceMemory && navigator.deviceMemory <= 2);
    const mobile = isPhone();

    let initial;
    try { initial = await platform.persist.loadInitial(); } catch (e) { initial = null; }
    let project = initial && initial.project;
    if (!project) {
        try { project = await defaultProject(platform); } catch (e) { project = platform.schema.newProject('cyl2d'); }
    }

    const store = platform.createStore(project, { mobile });
    let pool;
    try {
        pool = platform.createPool({ url: new URL('../workers/engine-worker.js', import.meta.url), mobile, ...(mobile ? { size: 2 } : {}) });
    } catch (e) { pool = null; }
    const jobs = platform.createJobs(store, pool, platform.persist, { mobile });
    if (store.get().ui.live === undefined) store.setUi('live', true);

    // shell
    const canvas = document.getElementById('io-canvas');
    const view = createView(canvas, { store, onError: (e) => log.add('error', e.message || String(e)) });
    const ui = { announce, toast, openDialog, log, isPhone };
    const ctx = createContext({ store, jobs, persist: platform.persist, pool, view, platform, ui });
    const app = createApp(ctx, platform, log);
    ctx.app = app;
    if (/[?&]debug\b/.test(location.search)) window.__ionopt = { ctx, app, store, jobs, view, platform };

    const tools = createTools(ctx, app);
    app.tools = tools;
    mountToolbar(document.getElementById('io-appbar'), ctx, app);
    mountRail(ctx, app);
    mountInspector(document.getElementById('io-inspector-body'), ctx, app);
    mountStatusbar(document.getElementById('io-status'), ctx, app);
    mountViewbar(document.getElementById('io-viewbar'), ctx, app);
    mountDock(ctx, app);
    installShortcuts(ctx, app);
    app.a11y = createA11y(ctx, app);
    app.mobile = createMobile(ctx, app);
    setupSplitter(ctx);
    setupDrop(ctx, app);

    // view from the project, else fit
    app.applyProjectView(true);
    tools.setTool('select');

    // persistence and log hooks
    store.on('project', () => { try { platform.persist.autosave(store.get().project); } catch (e) { /* storage blocked */ } });
    window.addEventListener('pagehide', () => { try { if (platform.persist.flushAutosave) platform.persist.flushAutosave(); } catch (e) { /* ignore */ } });
    let lastErr = { msg: '', at: 0 };
    store.on('error', (err) => {
        const msg = (err && err.message) || 'An error occurred.';
        if (err && err.code === 'E_CANCELLED') return;
        const now = Date.now();
        if (msg === lastErr.msg && now - lastErr.at < 1500) return;   // the same failure reported twice
        lastErr = { msg, at: now };
        log.add('error', msg, err);
        toast(msg, { kind: 'error' });
        announce('Error: ' + msg);
    });
    let lastSolve = store.get().solve.status, lastRun = store.get().run.status, lastWarnKey = null;
    store.on('solve', () => {
        const s = store.get().solve;
        if (s.status === lastSolve) return;
        lastSolve = s.status;
        if (s.status === 'done') {
            const ms = typeof s.ms === 'number' ? s.ms : (Array.isArray(s.stats) ? s.stats.reduce((a, b) => a + (b.ms || 0), 0) : 0);
            log.add('info', `Fields solved in ${dom.fmtMs(ms)}` + (Array.isArray(s.stats) && s.stats.length ? ': ' + s.stats.map((x) => (x.path || [x.method]).filter(Boolean).join(' → ')).join('; ') : ''), s.stats);
            announce(`Fields solved in ${dom.fmtMs(ms)}.`);
            const warns = Array.isArray(s.warnings) ? s.warnings : (typeof jobs.geometryWarnings === 'function' ? safe(() => jobs.geometryWarnings(), []) : []);
            const key = (s.geomKey || '') + '|' + warns.length;
            if (key !== lastWarnKey) {
                lastWarnKey = key;
                for (const w of warns.slice(0, 50)) log.add('warn', w.message || w.code, w);
            }
            if (app.railBadge) app.railBadge('shapes', warns.length > 0, `${warns.length} geometry warning${warns.length === 1 ? '' : 's'}`);
        } else if (s.status === 'error') {
            const msg = (s.error && s.error.message) || 'The field solve failed.';
            log.add('error', msg, s.error);
            if (!(s.error && s.error.code === 'E_CANCELLED')) { toast(msg, { kind: 'error' }); announce('Solve failed: ' + msg); }
        }
    });
    store.on('run', () => {
        const r = store.get().run;
        if (r.status === lastRun && !(r.status === 'done' && !r.live && r.epoch !== app._lastAnnouncedEpoch)) return;
        lastRun = r.status;
        if ((r.status === 'done' || r.status === 'partial') && r.result && !r.live) {
            app._lastAnnouncedEpoch = r.epoch;
            const sum = app.runSummary();
            if (sum) { log.add('info', sum); announce(sum); }
        } else if (r.status === 'error') {
            const msg = (r.error && r.error.message) || 'The run failed.';
            log.add('error', msg);
        }
    });

    // the display time (RF phase) drives the displayed potential
    view.on('time', dom.rafThrottle((t) => {
        if (typeof jobs.ensureField !== 'function' || !store.get().field) return;
        const p = jobs.ensureField({ displayTime: t });
        if (p && typeof p.then === 'function') p.then(null, () => {});
    }));

    // theme changes re-read the canvas tokens
    document.addEventListener('themechange', () => view.refreshTheme());
    if (typeof matchMedia === 'function') {
        const mq = matchMedia('(prefers-color-scheme: dark)');
        const fn = () => view.refreshTheme();
        if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn);
    }

    // version handshake and worker fallback
    const reloadBanner = () => app.banner('This page was updated while open. Reload to continue.', { kind: 'warn', action: { label: 'Reload', onClick: () => location.reload() } });
    const fallbackBanner = () => app.banner('Background workers are unavailable; calculations run on the page and the interface may pause during long jobs.', { kind: 'info' });
    if (pool && pool.ready && typeof pool.ready.then === 'function') {
        pool.ready.then(() => { if (pool.versionOk === false) reloadBanner(); else if (pool.fallback) fallbackBanner(); }, () => fallbackBanner());
    }
    if (jobs && typeof jobs.on === 'function') {
        jobs.on('fallback', fallbackBanner);
        jobs.on('version', reloadBanner);
        jobs.on('versionMismatch', reloadBanner);
        jobs.on('log', (m) => { if (m && m.message) log.add(m.level || 'info', m.message); });
        jobs.on('run:stopped', (m) => { if (m && m.message) toast(m.message, { kind: 'info' }); });
        // benchmark results stream in: announce one summary once they stop arriving
        let bench = [], benchTimer = null;
        jobs.on('bench:result', (r) => {
            if (!r) return;
            bench.push(r);
            if (benchTimer) clearTimeout(benchTimer);
            benchTimer = setTimeout(() => {
                const n = (st) => bench.filter((x) => x.status === st).length;
                const parts = [`${n('pass')} passed`, n('fail') ? `${n('fail')} failed` : '', n('error') ? `${n('error')} with errors` : '', n('info') ? `${n('info')} informational` : ''].filter(Boolean);
                announce(`Benchmarks: ${parts.join(', ')}.`);
                log.add(n('fail') || n('error') ? 'warn' : 'info', `Benchmarks finished: ${parts.join(', ')}.`);
                bench = []; benchTimer = null;
            }, 1500);
        });
    }

    // a share link pasted into the address bar of this tab is a fragment-only navigation (no reload): open it here
    window.addEventListener('hashchange', async () => {
        const io = platform.io;
        if (!io || typeof io.parseShareHash !== 'function' || !io.parseShareHash(location.hash)) return;
        const clearHash = () => { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ } };
        try {
            const d = await (io.decodeShareDetailed ? io.decodeShareDetailed(location.hash) : io.decodeShare(location.hash).then((project) => ({ project, clamped: [], warnings: [] })));
            clearHash();
            if (app.loadProject(d.project, { label: 'Open link' })) {
                toast(`Opened the shared project "${(d.project.meta && d.project.meta.name) || 'Untitled project'}"; the previous one is in Recent.`, { kind: 'ok' });
                for (const n of [...(d.clamped || []), ...(d.warnings || [])].slice(0, 3)) if (n && n.message) log.add('warn', n.message);
            }
        } catch (e) {
            clearHash();
            toast(`The shared link could not be opened: ${e && e.message ? e.message : e}`, { kind: 'error' });
        }
    });

    // the first-visit guide must not take the focus from someone who has started working
    let interacted = false;
    const markInteracted = () => { interacted = true; };
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) document.addEventListener(ev, markInteracted, { capture: true, once: true, passive: true });

    // the platform starts the first solve by itself; the guide follows on a first visit
    root.classList.add('io-ready');
    setBoot('');
    if (initial && initial.error) toast(`The shared link could not be opened: ${initial.error.message}`, { kind: 'error' });
    if (initial && Array.isArray(initial.notices)) for (const n of initial.notices.slice(0, 3)) if (n && n.message) log.add('warn', n.message);
    let prefs = {};
    try { prefs = platform.persist.prefs() || {}; } catch (e) { prefs = {}; }
    if (typeof prefs.live === 'boolean') store.setUi('live', prefs.live);
    if (!prefs.visited && initial && initial.source === 'default') {
        try { platform.persist.setPrefs({ visited: true }); } catch (e) { /* ignore */ }
        setTimeout(() => {
            const a = document.activeElement;
            const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
            if (!interacted && !typing) app.startFirstGuide();
        }, 1200);
    }
}

function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }

/** Default project: the Einzel preset from the presets package, else an empty cylindrical project. */
async function defaultProject(platform) {
    try {
        const idx = await import(DIALOG_MODULES.presetIndex);
        const p = idx.presetById ? idx.presetById('einzel') : null;
        if (p && typeof p.build === 'function') return p.build();
    } catch (e) { /* not available */ }
    return platform.schema.newProject('cyl2d');
}

function measureBanner() {
    const b = document.querySelector('.io-beta');
    if (!b) return;
    const set = () => document.documentElement.style.setProperty('--io-banner-h', Math.ceil(b.getBoundingClientRect().height) + 'px');
    set();
    if (typeof ResizeObserver === 'function') new ResizeObserver(set).observe(b);
}

// ---------------------------------------------------------------- application helpers
function createApp(ctx, platform, log) {
    const { store, jobs, view } = ctx;
    const bannerBox = document.getElementById('io-banners');
    const quiet = (p) => (p && typeof p.then === 'function' ? p.then((v) => v, () => null) : Promise.resolve(p));
    const app = {
        platform, log,
        /** Selection helpers. */
        select(kind, ids) { store.select({ kind, ids: ids === null || ids === undefined ? [] : Array.isArray(ids) ? ids : [ids] }); },
        selection() { return store.get().selection || { kind: null, ids: [] }; },
        /** Replaces the project (preset, file, new) and fits the view; the previous project goes to Recent. */
        loadProject(p, { label = 'Open project', keepRecent = true } = {}) {
            if (keepRecent) { try { platform.persist.pushRecent(store.get().project); } catch (e) { /* ignore */ } }
            store.setUi('drawElectrode', null);
            try { store.replaceProject(p, { label }); } catch (e) { toast('That project could not be opened: ' + (e.message || e), { kind: 'error' }); return false; }
            view.highlightParticle(null);
            app.applyProjectView(true);
            return true;
        },
        applyProjectView(fitIfMissing) {
            const v = store.get().project && store.get().project.view;
            if (v && Array.isArray(v.center) && v.scale > 0) {
                view.setViewState({ center: v.center, scale: v.scale });
                // fit when the saved view (made for another canvas size) does not show the whole domain
                const sc = view.scene();
                const b = view.getBox();
                const tol = sc.dom ? 0.02 * Math.max(sc.dom.x1 - sc.dom.x0, sc.dom.y1 - sc.dom.y0) : 0;
                if (sc.dom && (b.x0 > sc.dom.x0 + tol || b.x1 < sc.dom.x1 - tol || b.y1 < sc.dom.y1 - tol || b.y0 > (sc.cyl || sc.mirrorY ? -sc.dom.y1 : sc.dom.y0) + tol)) view.fit();
            } else if (fitIfMissing) view.fit();
            if (v && typeof v.displayTime === 'number') view.setDisplayTime(v.displayTime);
        },
        /** A copy of the project with the current view (centre, scale) written in (for Save, Share, Duplicate). */
        projectWithView() {
            const p = dom.clone(store.get().project);
            const st = view.getViewState();
            p.view = { ...(p.view || {}), center: [dom.tidy(st.center[0]), dom.tidy(st.center[1])], scale: dom.tidy(st.scale) };
            return p;
        },
        /** Solve with a confirmation above 5 s or 70% of the memory cap. Never rejects. */
        async solve() {
            const e = safeEstimate();
            if (e && e.blocked) { toast(e.blockMessage || 'This job is over the limits of this device.', { kind: 'error' }); return null; }
            if (e && (e.solveMs > 5000 || e.memMB > 0.7 * memCap())) {
                const ok = await confirmJob('Solve fields', e);
                if (!ok) return null;
            }
            return quiet(jobs.solve({ force: true }));
        },
        /** Full run with the same confirmation. Never rejects. */
        async run() {
            const e = safeEstimate();
            const st = store.get();
            if (st.valid === false) { toast('The project has errors; fix the fields marked in red first.', { kind: 'warn' }); return null; }
            if (e && e.blocked) { toast(e.blockMessage || 'This job is over the limits of this device.', { kind: 'error' }); return null; }
            if (e && ((e.runTotalMs || e.runMs || 0) + (st.solve.status === 'done' ? 0 : (e.solveMs || 0)) > 5000 || e.memMB > 0.7 * memCap())) {
                const ok = await confirmJob('Run particles', e);
                if (!ok) return null;
            }
            return quiet(jobs.run({ mode: 'full' }));
        },
        stop() {
            const st = store.get();
            if (st.solve.status === 'running' || st.solve.status === 'queued') jobs.cancelSolve();
            if (st.run.status === 'running') jobs.cancelRun();
            // a long live preview (gas, drag, many steps) is stopped too; the next edit starts a new one
            if (typeof jobs.previewing === 'function' && jobs.previewing()) { jobs.cancelPreview(); announce('Live preview stopped.'); return; }
            announce('Stopped.');
        },
        /** True while something can be stopped: a solve, a run or a live preview in flight. */
        isBusy() {
            const st = store.get();
            return st.solve.status === 'running' || st.solve.status === 'queued' || st.run.status === 'running' || (typeof jobs.previewing === 'function' && jobs.previewing());
        },
        setLive(on) {
            store.setUi('live', !!on);
            try { platform.persist.setPrefs({ live: !!on }); } catch (e) { /* ignore */ }
            if (typeof jobs.setLive === 'function') jobs.setLive(!!on);
            announce(on ? 'Live preview on.' : 'Live preview off.');
            const st = store.get();
            if (on && st.solution && st.keys && st.solution.geomKey === st.keys.geomKey) quiet(jobs.run({ mode: 'live' }));
        },
        /** One-line run summary for the live region and the log. */
        runSummary() {
            const st = store.get();
            const res = st.run && st.run.result;
            if (!res) return '';
            const sum = runStats(res, res.resolvedSnapshot || st.resolved || st.lastResolved, analysis);
            if (!sum) return '';
            const cnt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));
            const parts = [`${cnt(sum.launched)} particle${sum.launched === 1 ? '' : 's'}`];
            const bs = sum.byStatus || {};
            const keys = ['DETECTED', 'HIT', 'EXIT', 'ABSORBED', 'TMAX', 'DRIFT_END', 'NUM_ERROR', 'BORN_INSIDE', 'CANCELLED', 'STEPS'];
            // [one, several]
            const words = { DETECTED: ['detected', 'detected'], HIT: ['hit an electrode', 'hit electrodes'], EXIT: ['left the domain', 'left the domain'], ABSORBED: ['absorbed by a mesh', 'absorbed by meshes'],
                TMAX: ['reached the time limit', 'reached the time limit'], DRIFT_END: ['drifted out', 'drifted out'], NUM_ERROR: ['numerical error', 'numerical errors'],
                BORN_INSIDE: ['started inside an electrode', 'started inside electrodes'], CANCELLED: ['cancelled', 'cancelled'], STEPS: ['hit the step limit', 'hit the step limit'] };
            for (const k of keys) if (bs[k]) parts.push(`${cnt(bs[k])} ${words[k][bs[k] === 1 ? 0 : 1]}`);
            if (sum.launched && sum.transmission) parts.push(`transmission ${(100 * sum.transmission.overall).toFixed(sum.transmission.overall === 1 || sum.transmission.overall === 0 ? 0 : 1)}%`);
            return `Run ${st.run.status === 'partial' ? 'stopped' : 'finished'}: ${parts.join(', ')}.`;
        },
        banner(text, { kind = 'info', action = null } = {}) {
            if (!bannerBox) return;
            for (const b of bannerBox.children) if (b.dataset.text === text) return;
            const b = h('div', { class: ['io-banner', 'callout', kind === 'warn' ? 'callout-warn' : ''], role: 'status', dataset: { text } }, h('span', { text }));
            if (action) { const btn = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: action.label }); btn.addEventListener('click', action.onClick); b.appendChild(btn); }
            bannerBox.appendChild(b);
        },
        /** New empty project of a domain type (the current one goes to Recent). */
        newProject(type) {
            const p = platform.schema.newProject(type);
            if (p.meta) p.meta.name = 'Untitled project';
            app.loadProject(p, { label: 'New project' });
            toast('New project. The previous one is under Project ▸ Recent projects.', { kind: 'ok' });
        },
        /** Downloads the project file (with the current view). */
        saveFile() {
            try { platform.persist.downloadProject(app.projectWithView()); announce('Project file saved.'); }
            catch (e) { toast('The file could not be saved: ' + (e.message || e), { kind: 'error' }); }
        },
        /** Copies the project as a new one ("… (copy)"); the original stays in Recent. */
        duplicateProject() {
            const p = app.projectWithView();
            const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
            p.meta = { ...(p.meta || {}), name: `${(p.meta && p.meta.name) || 'Untitled project'} (copy)`, created: now, modified: now };
            app.loadProject(p, { label: 'Duplicate project' });
            toast('Working on a copy; the original is under Recent projects.', { kind: 'ok' });
        },
        /** Copies a share link; offers a file when the link is long. */
        async share() {
            let link;
            try { link = await platform.persist.shareLink(app.projectWithView()); } catch (e) { toast('The link could not be made: ' + (e.message || e), { kind: 'error' }); return; }
            const url = typeof link === 'string' ? link : link.url;
            if (link.tooLong) {
                const r = await openDialog({ title: 'Long link', body: `This link is ${dom.fmtCount(link.chars)} characters long; some apps cut links over 8,000 characters. A project file is safer for large projects.`,
                    actions: [{ label: 'Save a file', value: 'file' }, { label: 'Copy the link anyway', value: 'copy', primary: true }] });
                if (r === 'file') { app.saveFile(); return; }
                if (r !== 'copy') return;
            }
            const ok = await dom.copyText(url);
            if (ok) { toast('Link copied. It opens this project as a new copy; nothing is uploaded.', { kind: 'ok' }); announce('Link copied.'); }
            else openDialog({ title: 'Share link', body: (el) => { const ta = h('textarea', { class: 'input io-textarea', rows: '5', readonly: true, 'aria-label': 'Share link' }); ta.value = url; el.appendChild(ta); setTimeout(() => ta.select(), 0); }, actions: [{ label: 'Close', value: null }] });
        },
        /** Opens the preset gallery (presets package), else a simple list. */
        async openPresets({ firstVisit = false } = {}) {
            let id = null;
            try {
                const mod = await import(DIALOG_MODULES.presets);
                if (typeof mod.openGallery !== 'function') throw new Error('no gallery');
                id = await mod.openGallery(ctx, { firstVisit });
            } catch (e) {
                id = await fallbackGallery(ctx);
            }
            if (id) await app.loadPreset(id);
            return id;
        },
        async loadPreset(id) {
            let preset = null;
            try { const idx = await import(DIALOG_MODULES.presetIndex); preset = idx.presetById ? idx.presetById(id) : null; } catch (e) { preset = null; }
            if (!preset) { toast('That preset is not available.', { kind: 'warn' }); return false; }
            app.loadProject(preset.build(), { label: 'Load preset' });
            announce(`Loaded the ${preset.title || id} preset.`);
            return true;
        },
        async startFirstGuide() {
            try {
                const [g, idx] = await Promise.all([import(DIALOG_MODULES.guide), import(DIALOG_MODULES.presetIndex)]);
                const preset = idx.presetById ? idx.presetById((store.get().project.meta || {}).preset || 'einzel') : null;
                if (preset && preset.guide && typeof g.startGuide === 'function') g.startGuide(ctx, preset.guide);
            } catch (e) { /* guides need the presets package */ }
        },
        estimate: safeEstimate,
        memCap,
        log,
    };
    function safeEstimate() { try { return typeof jobs.estimate === 'function' ? jobs.estimate() : null; } catch (e) { return null; } }
    function memCap() { return ctx.ui.isPhone() ? 300 : 1500; }
    async function confirmJob(title, e) {
        const body = h('div', null,
            h('p', { text: 'This job is larger than usual. Continue?' }),
            h('dl', { class: 'io-kv' },
                h('dt', { text: 'Grid nodes' }), h('dd', { text: dom.fmtCount(e.nodes) }),
                h('dt', { text: 'Basis fields' }), h('dd', { text: String(e.bases) }),
                h('dt', { text: 'Memory' }), h('dd', { text: `${Math.round(e.memMB)} MB` }),
                h('dt', { text: 'Estimated time' }), h('dd', { text: dom.fmtMs((e.solveMs || 0) + (e.runTotalMs || e.runMs || 0)) }),
                ...(e.postMs > 500 ? [h('dt', { text: 'of which after tracing' }), h('dd', { text: `${dom.fmtMs(e.postMs)} (merging and summarizing on this page)` })] : [])));
        const r = await openDialog({ title, body, actions: [{ label: 'Cancel', value: false }, { label: 'Continue', value: true, primary: true }] });
        return r === true;
    }
    return app;
}

async function fallbackGallery(ctx) {
    let list = [];
    try { const idx = await import(DIALOG_MODULES.presetIndex); list = (idx.PRESETS || []).map((p) => ({ id: p.id, title: p.title, blurb: p.blurb })); } catch (e) { list = []; }
    const body = h('div', { class: 'io-preset-list', role: 'list' });
    const p = openDialog({ title: 'Presets', body, actions: [{ label: 'Cancel', value: null }] });
    for (const it of list) {
        const b = h('button', { type: 'button', class: 'io-preset-item', role: 'listitem' }, h('strong', { text: it.title }), h('span', { text: it.blurb || '' }));
        b.addEventListener('click', () => p.close(it.id));
        body.appendChild(b);
    }
    const first = body.querySelector('button');
    if (first) first.focus();
    return p;
}

// ---------------------------------------------------------------- rail (WAI-ARIA tabs)
function mountRail(ctx, app) {
    const tabsEl = document.getElementById('io-rail-tabs');
    const panelsEl = document.getElementById('io-rail-panels');
    const rail = document.getElementById('io-rail');
    const tabs = [], panels = [], mounted = new Map();
    RAIL_TABS.forEach((t, i) => {
        const id = 'io-railtab-' + t.id;
        const b = h('button', { type: 'button', role: 'tab', id, class: 'io-railtab', 'aria-selected': 'false', 'aria-controls': 'io-railpanel-' + t.id, tabindex: '-1', title: t.title, dataset: { guide: 'rail:' + t.id, tab: t.id } },
            icon(t.icon, 20), h('span', { class: 'io-railtab-label', text: t.title }), h('span', { class: 'io-badge-dot', hidden: true }));
        const p = h('section', { role: 'tabpanel', id: 'io-railpanel-' + t.id, class: 'io-railpanel', 'aria-labelledby': id, hidden: true, tabindex: '-1' },
            h('h2', { class: 'io-panel-title', text: t.title }));
        tabsEl.appendChild(b); panelsEl.appendChild(p);
        tabs.push(b); panels.push(p);
        b.addEventListener('click', () => { if (rail.classList.contains('io-rail-collapsed') || !rail.classList.contains('io-rail-open')) rail.classList.add('io-rail-open'); show(i, true); });
        b.addEventListener('keydown', (e) => {
            let k = -1;
            if (e.key === 'ArrowDown' || e.key === 'ArrowRight') k = (i + 1) % tabs.length;
            else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') k = (i - 1 + tabs.length) % tabs.length;
            else if (e.key === 'Home') k = 0;
            else if (e.key === 'End') k = tabs.length - 1;
            if (k >= 0) { e.preventDefault(); show(k, true); tabs[k].focus(); }
        });
    });
    function show(i, user = false) {
        tabs.forEach((b, k) => { b.setAttribute('aria-selected', k === i ? 'true' : 'false'); b.tabIndex = k === i ? 0 : -1; panels[k].hidden = k !== i; });
        const t = RAIL_TABS[i];
        if (!mounted.has(t.id)) {
            const host = h('div', { class: 'io-railpanel-body' });
            panels[i].appendChild(host);
            try { mounted.set(t.id, t.mount(host, ctx, app) || {}); } catch (e) { host.appendChild(h('p', { class: 'io-empty', text: 'This panel failed to load: ' + e.message })); mounted.set(t.id, {}); }
        }
        if (user) ctx.store.setUi('railTab', t.id);
        rail.dataset.tab = t.id;
    }
    app.showRailTab = (id, focusPanel = false) => {
        const i = RAIL_TABS.findIndex((t) => t.id === id);
        if (i < 0) return;
        rail.classList.add('io-rail-open');
        show(i, true);
        if (focusPanel) panels[i].focus();
    };
    app.railBadge = (id, on, label = '') => {
        const b = tabs[RAIL_TABS.findIndex((t) => t.id === id)];
        if (!b) return;
        const dot = b.querySelector('.io-badge-dot');
        dot.hidden = !on;
        b.setAttribute('aria-label', on ? `${b.title} (${label || 'warnings'})` : b.title);
    };
    const start = ctx.store.get().ui.railTab;
    show(Math.max(0, RAIL_TABS.findIndex((t) => t.id === start)));
    const closeRail = () => {
        if (!rail.classList.contains('io-rail-open')) return false;
        rail.classList.remove('io-rail-open');
        const sel = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
        if (sel) sel.focus();
        return true;
    };
    document.getElementById('io-rail-close')?.addEventListener('click', closeRail);
    // Escape closes the drawer on tablets (the panel stays open on desktops)
    rail.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && typeof matchMedia === 'function' && matchMedia('(max-width: 1099.98px)').matches && closeRail()) { e.stopPropagation(); e.preventDefault(); }
    });
}

// ---------------------------------------------------------------- view bar (tools, layers, colour by, stretch, replay, zoom, time)
function mountViewbar(el, ctx, app) {
    if (!el) return;
    const { store, view } = ctx;
    const tools = app.tools;
    dom.clear(el);
    const svgIcon = (...paths) => dom.svg('svg', { viewBox: '0 0 24 24', width: '18', height: '18', fill: 'currentColor', stroke: 'none', 'aria-hidden': 'true', focusable: 'false', class: 'io-icon' }, ...paths);
    const pauseIcon = () => svgIcon(dom.svg('rect', { x: '6', y: '5', width: '4', height: '14', rx: '1' }), dom.svg('rect', { x: '14', y: '5', width: '4', height: '14', rx: '1' }));
    const toolGroup = h('div', { class: 'io-toolgroup', role: 'group', 'aria-label': 'Tools' });
    for (const t of tools.list()) {
        const b = h('button', { type: 'button', class: 'io-toolbtn', 'aria-pressed': 'false', title: t.title + (t.key ? ` (${t.key})` : ''), 'aria-label': t.title, dataset: { tool: t.id } }, icon(t.icon, 18));
        if (t.editing) b.classList.add('io-edit-only');
        b.addEventListener('click', () => tools.setTool(t.id));
        toolGroup.appendChild(b);
    }
    // electrode for new shapes
    const elSel = h('select', { class: 'io-select io-select-sm io-elsel', 'aria-label': 'Electrode for new shapes', title: 'Electrode for new shapes' });
    elSel.addEventListener('change', () => store.setUi('drawElectrode', elSel.value));
    const fillElectrodes = () => {
        const els = store.get().project.electrodes || [];
        const cur = store.get().ui.drawElectrode;
        dom.clear(elSel);
        for (const e of els) elSel.appendChild(h('option', { value: e.id, text: e.name || e.id }));
        elSel.appendChild(h('option', { value: '__void', text: 'Void' }));
        const want = cur && (cur === '__void' || els.some((e) => e.id === cur)) ? cur : (els[1] ? els[1].id : 'gnd');
        elSel.value = want;
        if (cur !== want) store.setUi('drawElectrode', want);
    };
    fillElectrodes();
    store.on('project', fillElectrodes);

    // layers menu
    const layersBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost io-menubtn', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, icon('layers', 16), h('span', { text: 'Layers' }));
    const layersPop = h('div', { class: 'io-popover', hidden: true, role: 'group', 'aria-label': 'Layers' });
    const LAYERS = [['potential', 'Potential'], ['contours', 'Equipotentials'], ['field', '|E| (log)'], ['electrodes', 'Electrodes'], ['trajectories', 'Trajectories'], ['planes', 'Planes'], ['hits', 'Hits'], ['markers', 'Time markers'], ['grid', 'Grid nodes and cuts'], ['mirror', 'Mirrored half'],
        ['surface', 'Potential-energy surface (3D)']];
    const layerInputs = new Map();
    for (const [k, label] of LAYERS) {
        const id = dom.uid('io-layer');
        const cb = h('input', { type: 'checkbox', id });
        cb.addEventListener('change', () => {
            store.update((p) => {
                p.view = p.view || {}; p.view.layers = { ...(p.view.layers || {}) };
                if (k === 'contours') p.view.layers.contours = cb.checked ? 20 : false;
                else if (k === 'trajectories') p.view.layers.trajectories = cb.checked ? (store.get().ui.lastColorBy || 'source') : false;
                else if (k === 'grid') p.view.layers.grid = cb.checked ? true : 'auto';
                else p.view.layers[k] = cb.checked;
            }, { label: 'Layers', merge: 'layers' });
        });
        layersPop.appendChild(h('label', { class: 'io-check', for: id }, cb, h('span', { text: label })));
        layerInputs.set(k, cb);
    }
    const cmSel = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Color map' },
        ...[['auto', 'Color map: auto'], ['diverging', 'Diverging'], ['viridis', 'Viridis'], ['cividis', 'Cividis'], ['gray', 'Gray']].map(([v, t]) => h('option', { value: v, text: t })));
    cmSel.addEventListener('change', () => store.update((p) => { p.view = { ...(p.view || {}), colormap: cmSel.value }; }, { label: 'Color map' }));
    const ncInput = h('input', { type: 'number', min: '0', max: '200', step: '1', class: 'input io-num-sm', 'aria-label': 'Number of equipotentials' });
    ncInput.addEventListener('change', () => { const n = Math.max(0, Math.min(200, Math.round(Number(ncInput.value) || 0))); store.update((p) => { p.view = p.view || {}; p.view.layers = { ...(p.view.layers || {}), contours: n > 0 ? n : false }; }, { label: 'Equipotentials' }); });
    // an explicit list of equipotential levels replaces the automatic ones
    const lvId = dom.uid('io-levels');
    const lvInput = h('input', { type: 'text', id: lvId, class: 'input io-levels', spellcheck: 'false', placeholder: 'automatic', 'aria-describedby': lvId + '-msg' });
    const lvMsg = h('div', { class: 'io-field-msg', id: lvId + '-msg', hidden: true, role: 'alert' });
    lvInput.addEventListener('change', () => {
        const text = lvInput.value.trim();
        let levels = null;
        if (text) {
            const r = forms.parseList(text, 'voltage');
            if (!r.ok || r.value.some((v) => typeof v !== 'number')) { lvMsg.hidden = false; lvMsg.textContent = r.ok ? 'Enter numbers (V), for example "−500, 0, 500".' : r.error; lvInput.setAttribute('aria-invalid', 'true'); return; }
            levels = r.value;
        }
        lvMsg.hidden = true; lvInput.removeAttribute('aria-invalid');
        store.update((p) => { p.view = { ...(p.view || {}), contourLevels: levels }; }, { label: 'Equipotential levels' });
    });
    // relief of the potential-energy surface (height of the full q·φ range relative to the domain, ×)
    const reliefIn = h('input', { type: 'range', min: '0.25', max: '4', step: '0.25', value: '1', 'aria-label': 'Surface relief' });
    const reliefOut = h('output', { class: 'io-relief-out', text: '×1' });
    reliefIn.addEventListener('input', dom.rafThrottle(() => {
        const r = Math.max(0.25, Math.min(4, Number(reliefIn.value) || 1));
        reliefOut.textContent = '×' + units.formatPretty(r, 'none', 3);
        store.update((p) => { p.view = { ...(p.view || {}), relief: r }; }, { label: 'Surface relief', merge: 'relief' });
    }));
    const reliefRow = h('label', { class: 'io-relief' }, h('span', { text: 'Relief' }), reliefIn, reliefOut);
    // vertical stretch for long thin devices (view.aspect; the canvas shows an aspect badge while it is on)
    const aspectSel = h('select', { class: 'io-select io-select-sm io-aspect', 'aria-label': 'Vertical stretch', title: 'Vertical stretch (y × factor) for long thin devices' },
        ...ASPECTS.map((a) => h('option', { value: String(a), text: a === 1 ? '1:1' : `y ×${a}` })));
    aspectSel.addEventListener('change', () => {
        const a = Number(aspectSel.value) || 1;
        store.update((p) => { p.view = { ...(p.view || {}), aspect: a }; }, { label: 'Vertical stretch' });
    });
    layersPop.append(reliefRow, h('hr'), h('label', { class: 'io-inline' }, h('span', { text: 'Equipotentials' }), ncInput),
        h('label', { class: 'io-levels-label', for: lvId, text: 'Levels (V, optional list)' }), lvInput, lvMsg, cmSel,
        h('label', { class: 'io-inline io-aspect-row' }, h('span', { text: 'Vertical stretch' }), aspectSel));
    togglePopover(layersBtn, layersPop);

    // moving-dot replay of the run (replay.js): one toggle in the view bar; the transport (play/pause, scrubber,
    // speed, close) floats over the canvas while the replay is on, so the view bar keeps its height
    const replay = createReplay({ store, view, reducedMotion: dom.reducedMotion });
    app.replay = replay;
    const rpBtn = h('button', { type: 'button', class: 'io-toolbtn io-replay-btn', 'aria-pressed': 'false', 'aria-label': 'Replay the run as moving dots', title: 'Replay the run as moving dots', hidden: true }, icon('play', 18));
    const rpWrap = h('div', { class: 'io-replay io-replay-bar', role: 'group', 'aria-label': 'Trajectory replay', hidden: true });
    const rpPlay = h('button', { type: 'button', class: 'io-toolbtn io-replay-play', 'aria-label': 'Pause replay', title: 'Play or pause' }, pauseIcon());
    const rpRange = h('input', { type: 'range', min: '0', max: '1', step: '0.001', value: '0', 'aria-label': 'Replay time', class: 'io-replay-range' });
    const rpOut = h('output', { class: 'io-replay-out', text: '' });
    const rpSpeed = h('select', { class: 'io-select io-select-sm io-replay-speed', 'aria-label': 'Replay speed' }, ...SPEEDS.map((k) => h('option', { value: String(k), text: `${units.formatPretty(k, 'none', 3)}×`, selected: k === 1 })));
    const rpStop = h('button', { type: 'button', class: 'io-toolbtn io-replay-stop', 'aria-label': 'Close the replay and show the full trajectories', title: 'Close the replay (show the full trajectories)' }, icon('x', 16));
    rpWrap.append(rpPlay, rpRange, rpOut, rpSpeed, rpStop);
    (document.getElementById('io-canvas-wrap') || el).appendChild(rpWrap);
    const startReplay = () => { if (!replay.play()) ctx.ui.toast('Run the particles first; the replay needs stored trajectories.', { kind: 'info' }); else rpPlay.focus(); };
    rpBtn.addEventListener('click', () => { if (replay.active) { replay.stop(); rpBtn.focus(); } else startReplay(); });
    rpPlay.addEventListener('click', () => { if (replay.playing) replay.pause(); else startReplay(); });
    rpRange.addEventListener('input', () => { replay.pause(); replay.seekFraction(Number(rpRange.value)); });
    rpSpeed.addEventListener('change', () => replay.setSpeed(Number(rpSpeed.value) || 1));
    rpStop.addEventListener('click', () => { replay.stop(); rpBtn.focus(); });
    const syncReplay = (st) => {
        const rg = st.range;
        rpWrap.hidden = !st.active;
        rpBtn.setAttribute('aria-pressed', st.active ? 'true' : 'false');
        rpPlay.replaceChildren(st.playing ? pauseIcon() : icon('play', 18));
        rpPlay.setAttribute('aria-label', st.playing ? 'Pause replay' : 'Play replay');
        rpRange.disabled = !rg;
        if (rg && st.t !== null && document.activeElement !== rpRange) rpRange.value = String(rg.t1 > rg.t0 ? (st.t - rg.t0) / (rg.t1 - rg.t0) : 0);
        rpOut.textContent = st.t === null ? '' : `t = ${units.formatPretty(st.t, 'time', 4)}`;
    };
    replay.on(syncReplay);
    syncReplay(replay.state());

    // colour by
    const colorBy = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Color trajectories by' },
        ...[['source', 'Color by source'], ['species', 'Color by species'], ['energy', 'Color by energy'], ['status', 'Color by status'], ['time', 'Color by time']].map(([v, t]) => h('option', { value: v, text: t })));
    colorBy.addEventListener('change', () => { store.setUi('lastColorBy', colorBy.value); store.update((p) => { p.view = p.view || {}; p.view.layers = { ...(p.view.layers || {}), trajectories: colorBy.value }; }, { label: 'Color by' }); });
    const proj = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Projection', title: 'Trajectory projection' }, h('option', { value: 'xy', text: 'x–y' }), h('option', { value: 'xrho', text: 'x–ρ (folded)' }));
    proj.addEventListener('change', () => store.update((p) => { p.view = { ...(p.view || {}), projection: proj.value }; }, { label: 'Projection' }));

    // zoom
    const zoomGroup = h('div', { class: 'io-toolgroup', role: 'group', 'aria-label': 'Zoom' });
    const zb = (ic, label, fn) => { const b = h('button', { type: 'button', class: 'io-toolbtn', 'aria-label': label, title: label }, icon(ic, 18)); b.addEventListener('click', fn); zoomGroup.appendChild(b); };
    zb('fit', 'Fit (0)', () => view.fit());
    zb('zoomOut', 'Zoom out (−)', () => view.zoomAt(1 / 1.4));
    zb('zoomIn', 'Zoom in (+)', () => view.zoomAt(1.4));

    // RF display time
    const timeWrap = h('label', { class: 'io-time', hidden: true }, h('span', { text: 't' }));
    const timeRange = h('input', { type: 'range', min: '0', max: '1', step: '0.001', value: '0', 'aria-label': 'Display time' });
    const timeOut = h('output', { class: 'io-time-out', text: '0 µs' });
    timeWrap.append(timeRange, timeOut);
    const onTime = dom.rafThrottle(() => {
        const t = Number(timeRange.value) * (timeWrap.__period || 1);
        timeOut.textContent = units.formatPretty(t, 'time', 4);
        view.setDisplayTime(t);   // the view's 'time' event updates the displayed potential (see boot)
    });
    timeRange.addEventListener('input', onTime);
    view.on('time', (t) => {
        if (document.activeElement === timeRange) return;
        const P = timeWrap.__period || 1;
        timeRange.value = String(Math.max(0, Math.min(1, (t % P) / P)));
        timeOut.textContent = units.formatPretty(t, 'time', 4);
    });
    // the replay of a run in time-dependent fields drives the display time, so the potential (and the surface) shown is
    // the one the dots fly through (at most 10 updates per second while playing: each one recombines the field)
    let lastLink = -Infinity;
    replay.on((rs) => {
        if (!rs.active || rs.t === null || timeWrap.hidden) return;
        const t = performance.now();
        if (rs.playing && t - lastLink < 100) return;
        lastLink = t;
        view.setDisplayTime(rs.t);
    });

    el.append(toolGroup, h('span', { class: 'io-sep' }), elSel, layersBtn, layersPop, colorBy, proj, rpBtn, h('span', { class: 'io-spacer' }), timeWrap, zoomGroup);

    function syncBar() {
        const st = store.get();
        const v = st.project.view || {};
        const L = { ...view.layers() };
        for (const [k, cb] of layerInputs) {
            const val = L[k];
            cb.checked = k === 'grid' ? val === true : k === 'contours' ? (typeof val === 'number' ? val > 0 : !!val) : !!val;
        }
        ncInput.value = typeof L.contours === 'number' ? String(L.contours) : '0';
        if (document.activeElement !== lvInput) lvInput.value = Array.isArray(v.contourLevels) && v.contourLevels.length ? v.contourLevels.map((x) => forms.displayValue(x)).join(', ') : '';
        cmSel.value = v.colormap || 'auto';
        colorBy.value = typeof L.trajectories === 'string' ? L.trajectories : (st.ui.lastColorBy || 'source');
        colorBy.disabled = !L.trajectories;
        proj.value = v.projection || 'xy';
        proj.hidden = st.resolved && st.resolved.domain && st.resolved.domain.type !== 'cyl2d';
        if (document.activeElement !== reliefIn) { const r = Number(v.relief) > 0 ? Number(v.relief) : 1; reliefIn.value = String(r); reliefOut.textContent = '×' + units.formatPretty(r, 'none', 3); }
        reliefRow.hidden = !L.surface;
        const asp = Number(v.aspect) > 0 ? Number(v.aspect) : 1;
        if (!ASPECTS.includes(asp) && ![...aspectSel.options].some((o) => Number(o.value) === asp)) aspectSel.appendChild(h('option', { value: String(asp), text: `y ×${units.formatPretty(asp, 'none', 3)}` }));
        aspectSel.value = String(asp);
        const res = st.run && st.run.result;
        rpBtn.hidden = !(res && res.traj && res.traj.offsets && res.n > 0);
        // time slider when fields are time dependent
        const r = st.resolved;
        let period = 0;
        if (r && Array.isArray(r.electrodes)) for (const e of r.electrodes) for (const t of e.terms || []) {
            if (t.type === 'cos' && t.freq > 0) period = Math.max(period, 1 / t.freq);
            else if (t.type === 'pulse') period = Math.max(period, t.period || (t.t0 || 0) + (t.rise || 0) + (t.width || 0) + (t.fall || 0));
            else if (t.type === 'table' && Array.isArray(t.points) && t.points.length) period = Math.max(period, t.period || t.points[t.points.length - 1][0]);
        }
        timeWrap.hidden = !(period > 0);
        timeWrap.__period = period || 1;
    }
    syncBar();
    store.on('project', syncBar);
    store.on('run', syncBar);
    tools.onChange((id) => { for (const b of toolGroup.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', b.dataset.tool === id ? 'true' : 'false'); });
}

/** Simple popover toggled by a button (Escape and outside clicks close it). */
export function togglePopover(btn, pop) {
    const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = pop.hidden;
        pop.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
            const r = btn.getBoundingClientRect(), pr = pop.offsetParent ? pop.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
            pop.style.left = Math.max(4, r.left - pr.left) + 'px';
            pop.style.top = (r.bottom - pr.top + 4) + 'px';
            const f = dom.focusables(pop)[0];
            if (f) f.focus();
        }
    });
    pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); e.stopPropagation(); } });
    document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close(); });
    return close;
}

// ---------------------------------------------------------------- dock with the lazy panel registry
function mountDock(ctx, app) {
    const tabsEl = document.getElementById('io-dock-tabs');
    const panelsEl = document.getElementById('io-dock-panels');
    const dockEl = document.getElementById('io-dock');
    const entries = DOCK_PANELS.slice().sort((a, b) => a.order - b.order);
    const tabs = [], panels = [], inst = new Map(), loading = new Map();
    entries.forEach((p, i) => {
        const id = 'io-docktab-' + p.id;
        const b = h('button', { type: 'button', role: 'tab', id, class: 'io-docktab', 'aria-selected': 'false', 'aria-controls': 'io-dockpanel-' + p.id, tabindex: '-1', dataset: { guide: 'dock:' + p.id, tab: p.id } }, h('span', { text: p.title }));
        const panel = h('div', { role: 'tabpanel', id: 'io-dockpanel-' + p.id, class: 'io-dockpanel', 'aria-labelledby': id, hidden: true, tabindex: '0' });
        tabsEl.appendChild(b); panelsEl.appendChild(panel);
        tabs.push(b); panels.push(panel);
        b.addEventListener('click', () => show(i, true));
        b.addEventListener('keydown', (e) => {
            let k = -1;
            if (e.key === 'ArrowRight') k = (i + 1) % tabs.length;
            else if (e.key === 'ArrowLeft') k = (i - 1 + tabs.length) % tabs.length;
            else if (e.key === 'Home') k = 0;
            else if (e.key === 'End') k = tabs.length - 1;
            if (k >= 0) { e.preventDefault(); show(k, true); tabs[k].focus(); }
        });
    });
    let current = -1;
    async function load(i) {
        const p = entries[i];
        if (inst.has(p.id) || loading.has(p.id)) return loading.get(p.id);
        const host = panels[i];
        if (p.planned) {
            host.appendChild(h('div', { class: 'io-empty' }, h('p', { text: `${p.title}: planned for a later release.` })));
            inst.set(p.id, {});
            return null;
        }
        host.appendChild(h('p', { class: 'io-empty io-loading', text: 'Loading…' }));
        const pr = (async () => {
            try {
                await ensureWp5(ctx);
                const mod = await import(p.path);
                if (!mod || typeof mod.mount !== 'function') throw new Error('no mount()');
                dom.clear(host);
                if (mod.meta && mod.meta.title && mod.meta.title !== p.title) tabs[i].firstChild.textContent = mod.meta.title;
                const r = await mod.mount(host, ctx);
                inst.set(p.id, r || {});
            } catch (e) {
                dom.clear(host);
                host.appendChild(unavailable(p, ctx, app));
                inst.set(p.id, { unavailable: true, update: host.__update || null });
            } finally { loading.delete(p.id); }
        })();
        loading.set(p.id, pr);
        return pr;
    }
    function show(i, user = false) {
        current = i;
        tabs.forEach((b, k) => { b.setAttribute('aria-selected', k === i ? 'true' : 'false'); b.tabIndex = k === i ? 0 : -1; panels[k].hidden = k !== i; });
        if (dockEl.classList.contains('io-dock-collapsed') && user) setCollapsed(false);
        load(i).then(() => {
            const id = entries[i].id, x = inst.get(id);
            // the store events the panel missed while it was hidden (it compares its stored results with the current keys)
            const m = missed.get(id);
            missed.delete(id);
            if (x && typeof x.update === 'function') { try { x.update({ type: 'show', state: ctx.store.get(), missed: m ? [...m] : [] }); } catch (e) { app.log.add('error', e.message); } }
        });
        if (user) ctx.store.setUi('dockTab', entries[i].id);
    }
    const missed = new Map();   // panel id → store events that arrived while it was hidden
    for (const evt of ['project', 'resolved', 'selection', 'solve', 'solution', 'field', 'run', 'runs', 'ui']) {
        ctx.store.on(evt, () => {
            if (current < 0) return;
            for (const id of inst.keys()) {
                if (id === entries[current].id) continue;
                if (!missed.has(id)) missed.set(id, new Set());
                missed.get(id).add(evt);
            }
            const x = inst.get(entries[current].id);
            if (x && typeof x.update === 'function') { try { x.update({ type: evt, state: ctx.store.get() }); } catch (e) { app.log.add('error', e.message); } }
        });
    }
    // Compare pins saved in this browser: load the Compare tab in the background once the first run is done (or after
    // 6 s), so the pinned ghosts are on the canvas without opening the tab. The key is analysis-jobs.PINS_STORAGE_KEY,
    // read here directly so the startup does not import the analysis modules.
    (() => {
        let saved = false;
        // the stored value is { version, savedAt, pins: [...] } (an older form is a bare array); 'Unpin all' leaves an empty list
        try {
            const raw = localStorage.getItem('ionopt.pins.v1');
            const data = raw ? JSON.parse(raw) : null;
            const list = Array.isArray(data) ? data : (data && Array.isArray(data.pins) ? data.pins : []);
            saved = list.length > 0;
        } catch (e) { /* storage blocked or damaged */ }
        const k = entries.findIndex((p) => p.id === 'compare');
        if (!saved || k < 0) return;
        let done = false, off = null, timer = 0;
        const go = () => { if (done) return; done = true; if (off) off(); clearTimeout(timer); load(k); };
        off = ctx.store.on('run', () => { const r = ctx.store.get().run; if (r && r.status === 'done') setTimeout(go, 0); });
        timer = setTimeout(go, 6000);
    })();
    const collapseBtn = document.getElementById('io-dock-toggle');
    function setCollapsed(c) {
        dockEl.classList.toggle('io-dock-collapsed', c);
        document.getElementById('io-workbench').classList.toggle('io-dock-is-collapsed', c);
        if (collapseBtn) { collapseBtn.setAttribute('aria-expanded', c ? 'false' : 'true'); collapseBtn.setAttribute('aria-label', c ? 'Expand results' : 'Collapse results'); }
        setTimeout(() => ctx.view.resize(), 0);
    }
    if (collapseBtn) collapseBtn.addEventListener('click', () => setCollapsed(!dockEl.classList.contains('io-dock-collapsed')));
    app.showDockTab = (id) => {
        const i = entries.findIndex((p) => p.id === id);
        if (i < 0) return false;
        if (app.mobile && app.mobile.active && ['summary', 'tof', 'planes'].includes(id)) { app.mobile.showSheet('results'); return true; }
        show(i, true);
        return true;
    };
    /** Mounts a registry panel into another host (the phone sheet); a separate instance with its own updates. */
    app.mountPanelInto = async (id, host) => {
        const p = entries.find((x) => x.id === id);
        if (!p) return null;
        host.appendChild(h('p', { class: 'io-empty io-loading', text: 'Loading…' }));
        try {
            await ensureWp5(ctx);
            const mod = await import(p.path);
            if (!mod || typeof mod.mount !== 'function') throw new Error('no mount()');
            dom.clear(host);
            const r = (await mod.mount(host, ctx)) || {};
            if (typeof r.update === 'function') {
                for (const evt of ['project', 'resolved', 'solve', 'field', 'run', 'ui']) ctx.store.on(evt, () => { try { r.update({ type: evt, state: ctx.store.get() }); } catch (e) { app.log.add('error', e.message); } });
            }
            return r;
        } catch (e) {
            dom.clear(host);
            host.appendChild(unavailable(p, ctx, app));
            return null;
        }
    };
    app.dockPanel = (id) => inst.get(id) || null;
    const start = ctx.store.get().ui.dockTab;
    show(Math.max(0, entries.findIndex((p) => p.id === start)));
}

let wp5Loading = null;
/** Loads the analysis package's engine modules and plots once (missing modules leave false). */
function ensureWp5(ctx) {
    if (wp5Loading) return wp5Loading;
    wp5Loading = (async () => {
        const [ex, lp, op, pl] = await Promise.allSettled([import('../engine/exact.js'), import('../engine/lensprops.js'), import('../engine/optimize.js'), import('./plots.js')]);
        ctx.engine.exact = ex.status === 'fulfilled' ? ex.value : false;
        ctx.engine.lensprops = lp.status === 'fulfilled' ? lp.value : false;
        ctx.engine.optimize = op.status === 'fulfilled' ? op.value : false;
        ctx.plots = pl.status === 'fulfilled' ? pl.value : false;
    })();
    return wp5Loading;
}

/** "Panel unavailable" placeholder; the Summary slot keeps a minimal run summary. */
function unavailable(p, ctx, app) {
    const box = h('div', { class: 'io-empty io-unavailable' }, h('p', null, h('strong', { text: 'Panel unavailable. ' }), h('span', { text: `The ${p.title} panel could not be loaded.` })));
    if (p.id === 'summary') {
        const out = h('p', { class: 'io-mini-summary' });
        const upd = () => { out.textContent = app.runSummary() || 'No run yet.'; };
        upd();
        box.appendChild(out);
        box.__update = upd;
        ctx.store.on('run', upd);
    }
    return box;
}

// ---------------------------------------------------------------- dock splitter
function setupSplitter(ctx) {
    const split = document.getElementById('io-splitter');
    const centre = document.getElementById('io-centre');
    if (!split || !centre) return;
    let start = null;
    const setH = (px) => {
        const total = centre.getBoundingClientRect().height;
        const v = Math.max(80, Math.min(total - 160, px));
        document.getElementById('io-workbench').style.setProperty('--io-dock-h', v + 'px');
        split.setAttribute('aria-valuenow', String(Math.round(100 * v / total)));
        ctx.view.resize();
    };
    split.addEventListener('pointerdown', (e) => { start = { y: e.clientY, h: document.getElementById('io-dock').getBoundingClientRect().height }; split.setPointerCapture(e.pointerId); });
    split.addEventListener('pointermove', (e) => { if (start) setH(start.h - (e.clientY - start.y)); });
    split.addEventListener('pointerup', () => { start = null; });
    split.addEventListener('keydown', (e) => {
        const cur = document.getElementById('io-dock').getBoundingClientRect().height;
        if (e.key === 'ArrowUp') { setH(cur + 24); e.preventDefault(); } else if (e.key === 'ArrowDown') { setH(cur - 24); e.preventDefault(); }
    });
}

// ---------------------------------------------------------------- open by dropping a file on the canvas
function setupDrop(ctx, app) {
    const wrap = document.getElementById('io-canvas-wrap');
    if (!wrap) return;
    wrap.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); wrap.classList.add('io-drop'); } });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('io-drop'));
    wrap.addEventListener('drop', async (e) => {
        wrap.classList.remove('io-drop');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!f) return;
        e.preventDefault();
        try { const p = await ctx.persist.readProjectFile(f); app.loadProject(p, { label: 'Open file' }); toast(`Opened ${f.name}.`, { kind: 'ok' }); }
        catch (err) { toast(`Could not open ${f.name}: ${err && err.message ? err.message : err}`, { kind: 'error' }); }
    });
}

if (typeof document !== 'undefined' && document.getElementById) {
    const start = () => boot().catch((e) => {
        const s = document.getElementById('io-boot');
        if (s) s.textContent = 'The simulator failed to start: ' + (e && e.message ? e.message : String(e));
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}
