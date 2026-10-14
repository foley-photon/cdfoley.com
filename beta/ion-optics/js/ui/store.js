/* ==========================================================================
   Ion optics workbench: ui/store.js
   Application state: the project (immutable snapshots), its resolution,
   issues and cache keys, selection, solve/solution/field/run state, pinned
   runs and UI state, with undo/redo (200 steps; updates with the same merge
   key within 1 s form one step) and events. Staleness is decided only by the
   keys: a new geomKey makes the solution stale, a new fieldKey the field and
   run, a new runKey the run (spec §2.2.5, §2.5).
   Listeners receive (payload, state, info): for state events the payload is
   the whole state; for 'error' it is the error.
   ========================================================================== */
import { resolve, migrate } from '../engine/schema.js';
import { projectKeys } from '../engine/hash.js';

const EVENTS = Object.freeze(['project', 'resolved', 'selection', 'solve', 'solution', 'field', 'run', 'runs', 'ui', 'error']);
const UNDO_BYTES = 64 * 1024 * 1024;   // size cap of the undo history (very large projects keep fewer steps)

function setIn(obj, path, value) {
    const parts = String(path).split('.').filter(Boolean);
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
        cur[k] = cur[k] !== null && typeof cur[k] === 'object' ? { ...cur[k] } : {};
        cur = cur[k];
    }
    const last = parts[parts.length - 1];
    if (last === undefined || last === '__proto__' || last === 'constructor' || last === 'prototype') return;
    cur[last] = value;
}

/** Phone limits apply below 760 px or with deviceMemory ≤ 2 (spec §2.2.4). */
function detectMobile() {
    try {
        const g = globalThis;
        if (g.matchMedia && g.matchMedia('(max-width: 759.98px)').matches) return true;
        if (g.navigator && typeof g.navigator.deviceMemory === 'number' && g.navigator.deviceMemory <= 2) return true;
    } catch (e) { /* no media queries */ }
    return false;
}

function sizeOf(project) {
    try { return JSON.stringify(project).length * 2; } catch (e) { return 0; }
}

/** Issue list: an array of { path, code, message, severity } that also carries `.errors` and `.warnings`. */
function issueList(errors, warnings) {
    const list = [...errors.map((x) => ({ ...x, severity: 'error' })), ...warnings.map((x) => ({ ...x, severity: 'warning' }))];
    Object.defineProperty(list, 'errors', { value: errors, enumerable: false });
    Object.defineProperty(list, 'warnings', { value: warnings, enumerable: false });
    return list;
}

/**
 * Creates the store.
 * @param {object} project initial project (migrated on entry)
 * @param {{ mobile?: boolean, maxUndo?: number, mergeMs?: number, now?: () => number, ui?: object }} [opts]
 * @returns {object} Store with getters project, resolved, lastResolved, issues, keys, valid, selection and the methods
 *   get, update, replaceProject, undo, redo, canUndo, canRedo, undoLabel, redoLabel, undoDepth, select, setUi, setSolve,
 *   setSolution, setField, setRun, pinRun, unpinRun, on, emit, emitError.
 */
export function createStore(project, opts = {}) {
    const mobile = opts.mobile === undefined ? detectMobile() : !!opts.mobile;
    const maxUndo = opts.maxUndo || 200;
    const mergeMs = opts.mergeMs === undefined ? 1000 : opts.mergeMs;
    const now = opts.now || (() => Date.now());
    const listeners = new Map();
    const undoStack = [];   // { project, label, bytes }
    const redoStack = [];
    let undoBytes = 0;
    let lastMergeKey = null, lastMergeAt = -Infinity;

    const state = {
        project: null, resolved: null, lastResolved: null, valid: false,
        issues: issueList([], []),
        keys: { geomKey: null, fieldKey: null, runKey: null },
        selection: { kind: null, ids: [] },
        solve: { status: 'none', progress: null, stats: [], error: null, geomKey: null },
        solution: null,
        field: null,
        run: { status: 'none', progress: null, result: null, live: false, runKey: null, epoch: 0 },
        runs: [],
        ui: { autoSolve: true, live: true, ...(opts.ui || {}) },
    };

    function emit(evt, payload, info) {
        for (const name of [evt, '*']) {
            const set = listeners.get(name);
            if (!set) continue;
            for (const fn of [...set]) {
                try { fn(payload === undefined ? state : payload, state, { event: evt, ...(info || {}) }); } catch (e) {
                    if (evt !== 'error') emit('error', { source: 'listener', event: evt, code: 'E_INTERNAL', message: e && e.message ? e.message : String(e), error: e });
                }
            }
        }
    }

    /** Re-derives solve/run status from the keys; returns which statuses changed. */
    function refreshStaleness() {
        const k = state.keys;
        let solveChanged = false, runChanged = false;
        const s = state.solve;
        // a solve error stays only while its geometry is current
        const keepError = s.status === 'error' && s.geomKey === k.geomKey;
        if (s.status !== 'running' && s.status !== 'queued' && !keepError) {
            let st;
            if (state.solution) st = state.solution.geomKey === k.geomKey ? 'done' : 'stale';
            else st = 'none';
            if (st !== s.status) { state.solve = { ...s, status: st, error: null }; solveChanged = true; }
        }
        const r = state.run;
        if (r.status !== 'running' && r.result) {
            let st = r.status;
            if (r.runKey !== k.runKey) st = 'stale';
            else if (r.status === 'stale') st = r.partial ? 'partial' : 'done';
            if (st !== r.status) { state.run = { ...r, status: st }; runChanged = true; }
        }
        return { solveChanged, runChanged };
    }

    function setProject(p, info) {
        state.project = p;
        const r = resolve(p, { mobile });
        state.issues = issueList(r.errors, r.warnings);
        if (r.resolved) {
            state.resolved = r.resolved;
            state.lastResolved = r.resolved;
            state.valid = true;
            state.keys = projectKeys(r.resolved);
        } else {
            state.resolved = null;
            state.valid = false;
            state.keys = { geomKey: null, fieldKey: null, runKey: null };
        }
        const ch = refreshStaleness();
        emit('project', undefined, info);
        emit('resolved', undefined, info);
        if (ch.solveChanged) emit('solve');
        if (ch.runChanged) emit('run');
    }

    function pushUndo(prev, label) {
        const bytes = sizeOf(prev);
        undoStack.push({ project: prev, label: label || '', bytes });
        undoBytes += bytes;
        while (undoStack.length > maxUndo || (undoBytes > UNDO_BYTES && undoStack.length > 1)) {
            const old = undoStack.shift();
            undoBytes -= old.bytes;
        }
    }

    function stamp(p) {
        if (p && p.meta && typeof p.meta === 'object') p.meta.modified = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
        return p;
    }

    const store = {
        /** The whole state (read-only; change it through the methods). */
        get() { return state; },
        /** The current project (an immutable snapshot: copy before changing it). */
        get project() { return state.project; },
        /** The resolved project, or null while the project has errors. */
        get resolved() { return state.resolved; },
        /** The last resolved project without errors (for drawing while an edit is invalid). */
        get lastResolved() { return state.lastResolved; },
        /** Issues of the current project: array of { path, code, message, severity } with `.errors` and `.warnings`. */
        get issues() { return state.issues; },
        /** { geomKey, fieldKey, runKey } of the current project (null keys while it has errors). */
        get keys() { return state.keys; },
        /** True when the current project has no errors. */
        get valid() { return state.valid; },
        /** { kind, ids } of the selected objects. */
        get selection() { return state.selection; },
        /**
         * Changes the project through a mutator on a deep copy (or the mutator returns a new project). One undo step,
         * unless the previous update had the same `merge` key less than 1 s ago (a drag is one step).
         * @param {(draft: object) => (object|void)} mutator
         * @param {{ label?: string, merge?: string|null }} [o]
         * @returns {object} the new project
         */
        update(mutator, o = {}) {
            const prev = state.project;
            const draft = structuredClone(prev);
            const ret = mutator(draft);
            const next = ret && typeof ret === 'object' ? ret : draft;
            const t = now();
            const merge = o.merge === undefined ? null : o.merge;
            const merging = merge !== null && merge === lastMergeKey && t - lastMergeAt < mergeMs;
            if (!merging) pushUndo(prev, o.label);
            lastMergeKey = merge;
            lastMergeAt = t;
            redoStack.length = 0;
            setProject(stamp(next), { label: o.label || '', merge, kind: 'update' });
            return state.project;
        },
        /**
         * Replaces the project (preset, file or link): an undo boundary that clears the solution and results.
         * @param {object} p @param {{ label?: string }} [o]
         */
        replaceProject(p, o = {}) {
            const next = migrate(p);
            if (state.project) pushUndo(state.project, o.label || 'Replace project');
            redoStack.length = 0;
            lastMergeKey = null;
            state.solution = null;
            state.field = null;
            state.solve = { status: 'none', progress: null, stats: [], error: null, geomKey: null };
            state.run = { status: 'none', progress: null, result: null, live: false, runKey: null, epoch: state.run.epoch + 1 };
            state.selection = { kind: null, ids: [] };
            setProject(next, { label: o.label || '', kind: 'replace' });
            emit('selection'); emit('solution'); emit('field'); emit('solve'); emit('run');
            return state.project;
        },
        /** Restores the previous project; false if there is none. */
        undo() {
            const e = undoStack.pop();
            if (!e) return false;
            undoBytes -= e.bytes;
            redoStack.push({ project: state.project, label: e.label, bytes: e.bytes });
            lastMergeKey = null;
            setProject(e.project, { label: e.label, kind: 'undo' });
            return true;
        },
        /** Re-applies an undone change; false if there is none. */
        redo() {
            const e = redoStack.pop();
            if (!e) return false;
            pushUndo(state.project, e.label);
            lastMergeKey = null;
            setProject(e.project, { label: e.label, kind: 'redo' });
            return true;
        },
        canUndo() { return undoStack.length > 0; },
        canRedo() { return redoStack.length > 0; },
        undoLabel() { return undoStack.length ? undoStack[undoStack.length - 1].label : null; },
        redoLabel() { return redoStack.length ? redoStack[redoStack.length - 1].label : null; },
        /** Number of undo steps held. */
        undoDepth() { return undoStack.length; },
        /** Selects objects: { kind: 'shape'|'electrode'|'source'|'plane'|'magnet'|'param'|'idealField'|null, ids }. */
        select(sel) {
            const ids = sel && Array.isArray(sel.ids) ? sel.ids.slice() : [];
            state.selection = { kind: sel && sel.kind ? sel.kind : null, ids };
            emit('selection');
        },
        /** Non-undoable UI state: setUi('live', false), setUi('dock.tab', 'hits') (stored flat and nested). */
        setUi(path, value) {
            const ui = { ...state.ui, [path]: value };
            if (String(path).includes('.')) setIn(ui, path, value);
            state.ui = ui;
            emit('ui', undefined, { path, value });
        },
        /** jobs.js: merges into the solve state. */
        setSolve(partial) {
            state.solve = { ...state.solve, ...(partial || {}) };
            emit('solve');
        },
        /** jobs.js: the solution { geomKey, raster0, bases, geometry, stats, … } or null. */
        setSolution(s) {
            state.solution = s || null;
            const ch = refreshStaleness();
            emit('solution');
            if (ch.solveChanged) emit('solve');
        },
        /** jobs.js: merges into the field state { fieldKey, grid, model, displayPhi, displayTime } (null clears it). */
        setField(partial) {
            state.field = partial === null ? null : { ...(state.field || {}), ...partial };
            emit('field');
        },
        /** jobs.js: merges into the run state. */
        setRun(partial) {
            state.run = { ...state.run, ...(partial || {}) };
            refreshStaleness();
            emit('run');
        },
        /** Pins a run for comparison (at most 8): a pin with a known id is replaced in place (its number and color stay). */
        pinRun(run) {
            if (!run) return;
            const runs = state.runs.slice();
            const k = runs.findIndex((r) => r.id === run.id);
            if (k >= 0) runs[k] = run;
            else runs.push(run);
            while (runs.length > 8) runs.shift();
            state.runs = runs;
            emit('runs');
        },
        unpinRun(id) {
            state.runs = state.runs.filter((r) => r.id !== id);
            emit('runs');
        },
        /**
         * Subscribes to 'project', 'resolved', 'selection', 'solve', 'solution', 'field', 'run', 'runs', 'ui', 'error'
         * or '*'. The listener gets (payload, state, info). @returns {() => void} unsubscribe
         */
        on(evt, fn) {
            if (!listeners.has(evt)) listeners.set(evt, new Set());
            listeners.get(evt).add(fn);
            return () => { const s = listeners.get(evt); if (s) s.delete(fn); };
        },
        /** Emits an event (jobs.js uses it for 'error'). */
        emit(evt, payload, info) { emit(evt, payload, info); },
        /** Reports an error to the 'error' subscribers. */
        emitError(err) { emit('error', err); },
        EVENTS,
    };

    setProject(migrate(project), { kind: 'init' });
    return store;
}
