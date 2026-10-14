/* ==========================================================================
   Ion optics UI: shortcuts.js
   Keyboard shortcuts (spec §4.12), active outside text fields and dialogs:
   S solve, R run, L live, Esc cancel/stop, V select, H pan, B box, T tube,
   C circle, P polygon, M measure, Shift+P probe, Delete, Ctrl+Z / Ctrl+Y,
   Ctrl+D duplicate, arrows nudge 1 cell (Shift ×10, Alt ×0.1), [ / ] shape
   order, 0 fit, + / − zoom, ? this list. Ctrl+S saves the project file.
   ========================================================================== */
import { h } from './dom.js';

/** Shortcut table: [keys, description] (also shown by "?" and on the help page). */
export const SHORTCUTS = Object.freeze([
    ['S', 'Solve the fields'], ['R', 'Run all particles'], ['L', 'Live preview on or off'], ['Esc', 'Cancel the current drawing, or stop a solve or run'],
    ['V', 'Select and edit tool'], ['H', 'Pan tool (or hold Space, or drag with the middle button)'], ['B', 'Box tool'], ['T', 'Tube tool'], ['C', 'Circle tool'],
    ['P', 'Polygon tool (Enter or double-click closes)'], ['M', 'Measure tool'], ['Shift+P', 'Probe line for the Profile tab'],
    ['Delete', 'Delete the selection (or the grabbed polygon vertex)'], ['Ctrl+Z', 'Undo'], ['Ctrl+Y or Ctrl+Shift+Z', 'Redo'], ['Ctrl+D', 'Duplicate the selection'],
    ['Arrows', 'Move the selection one cell (Shift ×10, Alt ×0.1)'], ['[ and ]', 'Move the selected shape earlier or later in the painting order'],
    ['0', 'Fit the domain in view'], ['+ and −', 'Zoom in and out'], ['Ctrl+S', 'Save the project to a file'], ['?', 'Show this list'],
]);

const TOOL_KEYS = { v: 'select', h: 'pan', b: 'box', t: 'tube', c: 'circle', p: 'polygon', m: 'measure' };

/** True if keyboard focus is in a text field (shortcuts are off there). */
export function inTextField(target) {
    const el = target && target.nodeType === 1 ? target : null;
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes((el.type || 'text').toLowerCase());
    return false;
}

/** Opens the shortcut list. */
export function openShortcutsDialog(ctx) {
    const dl = h('dl', { class: 'io-shortcuts' });
    for (const [k, d] of SHORTCUTS) dl.append(h('dt', null, ...k.split(/( or | and )/).map((part) => (part === ' or ' || part === ' and ' ? part : h('kbd', { text: part })))), h('dd', { text: d }));
    return ctx.ui.openDialog({ title: 'Keyboard shortcuts', body: h('div', null, h('p', { class: 'io-note', text: 'Shortcuts work when the focus is not in a text field.' }), dl), actions: [{ label: 'Close', value: null, primary: true }] });
}

/**
 * Installs the document key handler.
 * @returns {{ dispose(): void, handle(e: KeyboardEvent): boolean }}
 */
export function installShortcuts(ctx, app) {
    const { store, view } = ctx;
    app.showShortcuts = () => openShortcutsDialog(ctx);
    function cellSize() {
        const st = store.get();
        const r = st.resolved || st.lastResolved;
        return r && r.domain ? r.domain.h : 1;
    }
    function handle(e) {
        if (e.defaultPrevented) return false;
        if (document.querySelector('dialog[open]')) return false;
        const ctrl = e.ctrlKey || e.metaKey;
        const k = e.key;
        // Ctrl shortcuts work everywhere except text fields (where the browser's own undo applies)
        if (ctrl && !e.altKey) {
            if (inTextField(e.target)) return false;
            const lk = k.toLowerCase();
            if (lk === 'z' && !e.shiftKey) { store.undo(); return true; }
            if (lk === 'y' || (lk === 'z' && e.shiftKey)) { store.redo(); return true; }
            if (lk === 'd') { if (app.tools) app.tools.duplicate(); return true; }
            if (lk === 's') { if (app.saveFile) app.saveFile(); return true; }
            return false;
        }
        if (inTextField(e.target)) return false;
        // the active tool first (Enter, Escape, Backspace while drawing; Delete on a grabbed vertex)
        if (app.tools && app.tools.key(e)) return true;
        if (k === 'Escape') {
            const st = store.get();
            if (st.solve.status === 'running' || st.solve.status === 'queued' || st.run.status === 'running') { app.stop(); return true; }
            if (app.tools && app.tools.current() !== 'select') { app.tools.setTool('select'); return true; }
            if ((st.selection.ids || []).length) { store.select({ kind: null, ids: [] }); view.highlightParticle(null); return true; }
            return false;
        }
        if (k === 'Delete' || k === 'Backspace') { return !!(app.tools && app.tools.deleteSelection()); }
        if (k.startsWith('Arrow')) {
            const sel = store.get().selection || {};
            if (!(sel.ids || []).length || !['shape', 'source', 'plane'].includes(sel.kind)) return false;
            const step = cellSize() * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
            const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[k];
            return !!(app.tools && app.tools.nudge(d[0], d[1]));
        }
        if (e.altKey) return false;
        if (k === '?') { app.showShortcuts(); return true; }
        if (k === '0') { view.fit(); return true; }
        if (k === '+' || k === '=') { view.zoomAt(1.4); return true; }
        if (k === '-' || k === '−' || k === '_') { view.zoomAt(1 / 1.4); return true; }
        if (k === '[') { return !!(app.tools && app.tools.reorder(-1)); }
        if (k === ']') { return !!(app.tools && app.tools.reorder(1)); }
        const lk = k.toLowerCase();
        if (lk === 'p' && e.shiftKey) { app.tools.setTool('probe'); return true; }
        if (e.shiftKey) return false;
        if (lk === 's') { app.solve(); return true; }
        if (lk === 'r') { app.run(); return true; }
        if (lk === 'l') { app.setLive(store.get().ui.live === false); return true; }
        if (TOOL_KEYS[lk] && app.tools) { app.tools.setTool(TOOL_KEYS[lk]); if (ctx.ui.announce) ctx.ui.announce(`${TOOL_KEYS[lk] === 'pan' ? 'Pan' : TOOL_KEYS[lk][0].toUpperCase() + TOOL_KEYS[lk].slice(1)} tool.`); return true; }
        return false;
    }
    const onKey = (e) => { if (handle(e)) e.preventDefault(); };
    document.addEventListener('keydown', onKey);
    return { handle, dispose: () => document.removeEventListener('keydown', onKey) };
}
