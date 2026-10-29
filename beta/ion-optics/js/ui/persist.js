/* ==========================================================================
   Ion optics workbench: ui/persist.js
   Persistence (spec §2.5, §4.10): initial project (share link > autosave >
   the Einzel preset), autosave (1 s debounce), recent projects (10),
   preferences, share links, project files, and an opt-in IndexedDB cache of
   basis fields (off by default; LRU, 100 MB; a quota error disables it for
   the session). Every storage call is wrapped, so the app works with storage
   blocked. Links are data only: validated and clamped, never executed.
   ========================================================================== */
import { newProject, migrate, validate, EngineError } from '../engine/schema.js';
import { canonicalJSON, hash64 } from '../engine/hash.js';
import { encodeShare, decodeShareDetailed, parseShareHash, serializeProject, parseProject, projectFileName } from '../engine/io.js';

export const KEYS = Object.freeze({ autosave: 'ionopt.autosave.v1', recent: 'ionopt.recent.v1', prefs: 'ionopt.prefs.v1' });
/** Share links longer than this get a warning and the offer of a file. */
export const SHARE_WARN_CHARS = 8000;
const RECENT_MAX = 10;
const CACHE_DB = 'ionopt-cache', CACHE_STORE = 'basis', CACHE_META = 'meta';
const CACHE_LIMIT = 100 * 1024 * 1024;

// ---------------------------------------------------------------- environment (injectable for tests)
const env = {
    storage: () => globalThis.localStorage,
    location: () => globalThis.location,
    history: () => globalThis.history,
    document: () => globalThis.document,
    indexedDB: () => globalThis.indexedDB,
    now: () => Date.now(),
    setTimeout: (f, ms) => globalThis.setTimeout(f, ms),
    clearTimeout: (t) => globalThis.clearTimeout(t),
    loadPreset: async (id) => {
        const mod = await import('../presets/index.js');
        const p = mod.presetById ? mod.presetById(id) : (mod.PRESETS || []).find((x) => x.id === id);
        return p ? p.build() : null;
    },
    cacheBackend: null,
    /** Target for page-lifecycle listeners (pagehide, visibilitychange); null where there is none. */
    events: () => (typeof globalThis.addEventListener === 'function' ? globalThis : null),
};
const notices = [];

/**
 * Overrides parts of the environment (tests, embedding): storage, location, history, document, indexedDB, now,
 * setTimeout, clearTimeout, loadPreset(id), cacheBackend, events (pagehide target). Also resets the session state.
 * @param {object} overrides
 */
export function configurePersist(overrides = {}) {
    Object.assign(env, overrides);
    if (autosaveTimer !== null) { try { env.clearTimeout(autosaveTimer); } catch (e) { /* ignore */ } }
    autosaveTimer = null; pendingAutosave = null;
    cacheState.disabled = false; cacheState.backend = null; cacheState.notice = null;
    notices.length = 0;
}

/** Messages for the user collected by storage operations (quota, blocked storage, damaged data). */
export function takeNotices() {
    return notices.splice(0, notices.length);
}

function store() {
    try { return env.storage() || null; } catch (e) { return null; }
}
function readJSON(key) {
    const s = store();
    if (!s) return null;
    try {
        const v = s.getItem(key);
        return v === null || v === undefined ? null : JSON.parse(v);
    } catch (e) { return null; }
}
function writeJSON(key, value) {
    const s = store();
    if (!s) return false;
    try { s.setItem(key, JSON.stringify(value)); return true; } catch (e) {
        notices.push({ code: e && e.name === 'QuotaExceededError' ? 'W_STORAGE_FULL' : 'W_STORAGE', message: 'The browser did not allow saving to local storage.' });
        return false;
    }
}

// ---------------------------------------------------------------- initial project
async function defaultProject() {
    try {
        const p = await env.loadPreset('einzel');
        if (p && typeof p === 'object') return migrate(p);
    } catch (e) { /* presets not available */ }
    const p = newProject('cyl2d');
    p.meta.name = 'Untitled project';
    return p;
}

/**
 * The project to open: a share link in the URL hash, else the autosave, else the Einzel preset.
 * A link opens as a new project: the old autosave moves to Recent and the hash is removed from the address.
 * @param {{ keepHash?: boolean }} [opts]
 * @returns {Promise<{ project: object, source: 'link'|'autosave'|'default', notices?: object[], error?: object }>}
 */
export async function loadInitial(opts = {}) {
    let linkError = null;
    let loc = null;
    try { loc = env.location(); } catch (e) { loc = null; }
    const hash = loc && typeof loc.hash === 'string' ? loc.hash : '';
    if (hash && parseShareHash(hash)) {
        try {
            const d = await decodeShareDetailed(hash);
            const prev = readJSON(KEYS.autosave);
            if (prev && prev.project && typeof prev.project === 'object') pushRecent(prev.project);
            if (!opts.keepHash) {
                try {
                    const h = env.history();
                    if (h && typeof h.replaceState === 'function') h.replaceState(null, '', (loc.pathname || '') + (loc.search || ''));
                } catch (e) { /* history unavailable */ }
            }
            return { project: d.project, source: 'link', notices: [...d.clamped, ...d.warnings] };
        } catch (e) {
            linkError = { code: e && e.code ? e.code : 'E_BAD_PROJECT', message: e && e.message ? e.message : String(e) };
            // a damaged link leaves the address too, so a reload does not repeat the error
            if (!opts.keepHash) {
                try {
                    const h = env.history();
                    if (h && typeof h.replaceState === 'function') h.replaceState(null, '', (loc.pathname || '') + (loc.search || ''));
                } catch (err) { /* history unavailable */ }
            }
        }
    }
    const auto = readJSON(KEYS.autosave);
    if (auto && auto.project && typeof auto.project === 'object') {
        try {
            const project = migrate(auto.project);
            return linkError ? { project, source: 'autosave', error: linkError } : { project, source: 'autosave' };
        } catch (e) {
            notices.push({ code: 'W_AUTOSAVE_DAMAGED', message: 'The autosaved project could not be read.' });
        }
    }
    const project = await defaultProject();
    return linkError ? { project, source: 'default', error: linkError } : { project, source: 'default' };
}

// ---------------------------------------------------------------- autosave, recent, prefs
let autosaveTimer = null;
let pendingAutosave = null;

let lifecycleBound = null;
/** Writes a pending autosave when the page is hidden or unloaded (a tab closed within the 1 s debounce keeps the edit). */
function bindLifecycle() {
    let target = null;
    try { target = env.events(); } catch (e) { target = null; }
    if (!target || lifecycleBound === target) return;
    lifecycleBound = target;
    try {
        target.addEventListener('pagehide', () => flushAutosave());
        target.addEventListener('visibilitychange', () => {
            const doc = env.document();
            if (doc && doc.visibilityState === 'hidden') flushAutosave();
        });
    } catch (e) { /* no lifecycle events */ }
}

/** Saves the project to local storage 1 s after the last call (and at once when the page is hidden or closed). */
export function autosave(project) {
    bindLifecycle();
    pendingAutosave = project;
    if (autosaveTimer !== null) { try { env.clearTimeout(autosaveTimer); } catch (e) { /* ignore */ } }
    try {
        autosaveTimer = env.setTimeout(() => { autosaveTimer = null; flushAutosave(); }, 1000);
    } catch (e) { autosaveTimer = null; flushAutosave(); }
}

/** Writes a pending autosave now (e.g. on pagehide). @returns {boolean} */
export function flushAutosave() {
    if (autosaveTimer !== null) { try { env.clearTimeout(autosaveTimer); } catch (e) { /* ignore */ } autosaveTimer = null; }
    const p = pendingAutosave;
    pendingAutosave = null;
    if (!p) return false;
    return writeJSON(KEYS.autosave, { savedAt: new Date(env.now()).toISOString(), project: p });
}

/** The autosaved entry { savedAt, project } or null. */
export function readAutosave() {
    const a = readJSON(KEYS.autosave);
    return a && a.project ? a : null;
}

/** Recent projects, newest first: [{ savedAt, name, hash, project }]. */
export function recent() {
    const list = readJSON(KEYS.recent);
    return Array.isArray(list) ? list.filter((e) => e && e.project && typeof e.project === 'object') : [];
}

/** Adds a project to Recent (deduplicated, 10 entries). */
export function pushRecent(project) {
    if (!project || typeof project !== 'object') return false;
    let h;
    try { h = hash64(canonicalJSON(project)); } catch (e) { return false; }
    const name = project.meta && typeof project.meta.name === 'string' ? project.meta.name : 'Untitled project';
    const list = recent().filter((e) => e.hash !== h);
    list.unshift({ savedAt: new Date(env.now()).toISOString(), name, hash: h, project });
    while (list.length > RECENT_MAX) list.pop();
    // keep what fits: drop the oldest entries if storage refuses
    for (let n = list.length; n > 0; n--) {
        const s = store();
        if (!s) return false;
        try { s.setItem(KEYS.recent, JSON.stringify(list.slice(0, n))); return true; } catch (e) { /* try fewer */ }
    }
    notices.push({ code: 'W_STORAGE_FULL', message: 'Recent projects could not be saved (storage full).' });
    return false;
}

/** Removes a Recent entry by hash. */
export function removeRecent(hash) {
    writeJSON(KEYS.recent, recent().filter((e) => e.hash !== hash));
}

/** Preferences object (empty if none). */
export function prefs() {
    const p = readJSON(KEYS.prefs);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

/** Merges into the preferences. */
export function setPrefs(partial) {
    const next = { ...prefs(), ...(partial || {}) };
    writeJSON(KEYS.prefs, next);
    return next;
}

// ---------------------------------------------------------------- links and files

/**
 * Share link of the project (location without hash + '#p=…'): { url, chars, tooLong } (prints as the URL).
 * tooLong (more than SHARE_WARN_CHARS characters): warn and offer a file instead.
 * @param {object} project
 * @returns {Promise<{ url: string, chars: number, tooLong: boolean }>}
 */
export async function shareLink(project) {
    const frag = await encodeShare(project);
    let base = '';
    try {
        const loc = env.location();
        if (loc) base = loc.origin && loc.origin !== 'null' ? loc.origin + (loc.pathname || '') + (loc.search || '') : String(loc.href || '').split('#')[0];
    } catch (e) { base = ''; }
    const url = base + '#' + frag;
    const out = { url, chars: url.length, tooLong: url.length > SHARE_WARN_CHARS };
    Object.defineProperty(out, 'toString', { value: () => url, enumerable: false });
    return out;
}

/** Downloads the project as '<name>.ionopt.json'. @returns {boolean} */
export function downloadProject(project) {
    const doc = env.document();
    if (!doc) return false;
    try {
        const text = serializeProject(project);
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = doc.createElement('a');
        a.href = url;
        a.download = projectFileName(project);
        a.rel = 'noopener';
        a.style.display = 'none';
        doc.body.appendChild(a);
        a.click();
        a.remove();
        env.setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 1000);
        return true;
    } catch (e) {
        notices.push({ code: 'W_DOWNLOAD', message: 'The file could not be saved.' });
        return false;
    }
}

/**
 * Reads a project file (File or Blob, ≤ 5 MB): parses, migrates and validates it.
 * @returns {Promise<object>} Project
 * @throws {EngineError} E_BAD_PROJECT
 */
export async function readProjectFile(file) {
    if (!file) throw new EngineError('E_BAD_PROJECT', 'No file.');
    if (typeof file.size === 'number' && file.size > 5 * 1024 * 1024) throw new EngineError('E_BAD_PROJECT', 'The file is larger than 5 MB.');
    const text = typeof file.text === 'function' ? await file.text() : String(file);
    const project = parseProject(text);
    const v = validate(project);
    if (v.errors.length) {
        const first = v.errors[0];
        throw new EngineError('E_BAD_PROJECT', `The file is not a valid project: ${first.path ? first.path + ': ' : ''}${first.message}`, first.path, { errors: v.errors.slice(0, 50) });
    }
    return project;
}

// ---------------------------------------------------------------- basis cache (IndexedDB, opt-in)
const cacheState = { disabled: false, backend: null, notice: null };

function idbRequest(req) {
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}
function idbDone(tx) {
    return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}

/** IndexedDB backend: stores 'basis' (data) and 'meta' (bytes, lastUsed), both keyed [geomKey, k]. */
function idbBackend() {
    let dbp = null;
    const open = () => {
        if (dbp) return dbp;
        const idb = env.indexedDB();
        if (!idb) return Promise.reject(new Error('IndexedDB unavailable'));
        dbp = new Promise((res, rej) => {
            const req = idb.open(CACHE_DB, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
                if (!db.objectStoreNames.contains(CACHE_META)) db.createObjectStore(CACHE_META);
            };
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
        });
        return dbp;
    };
    return {
        async get(key) {
            const db = await open();
            return idbRequest(db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).get(key));
        },
        async put(key, data, meta) {
            const db = await open();
            const tx = db.transaction([CACHE_STORE, CACHE_META], 'readwrite');
            tx.objectStore(CACHE_STORE).put(data, key);
            tx.objectStore(CACHE_META).put(meta, key);
            await idbDone(tx);
        },
        async touch(key, meta) {
            const db = await open();
            const tx = db.transaction(CACHE_META, 'readwrite');
            tx.objectStore(CACHE_META).put(meta, key);
            await idbDone(tx);
        },
        async remove(key) {
            const db = await open();
            const tx = db.transaction([CACHE_STORE, CACHE_META], 'readwrite');
            tx.objectStore(CACHE_STORE).delete(key);
            tx.objectStore(CACHE_META).delete(key);
            await idbDone(tx);
        },
        async listMeta() {
            const db = await open();
            const store2 = db.transaction(CACHE_META, 'readonly').objectStore(CACHE_META);
            const [keys, vals] = await Promise.all([idbRequest(store2.getAllKeys()), idbRequest(store2.getAll())]);
            return keys.map((k, i) => ({ key: k, ...vals[i] }));
        },
        async clear() {
            const db = await open();
            const tx = db.transaction([CACHE_STORE, CACHE_META], 'readwrite');
            tx.objectStore(CACHE_STORE).clear();
            tx.objectStore(CACHE_META).clear();
            await idbDone(tx);
        },
    };
}

function backend() {
    if (!cacheState.backend) cacheState.backend = env.cacheBackend || idbBackend();
    return cacheState.backend;
}

function disableForSession(e) {
    cacheState.disabled = true;
    cacheState.notice = { code: 'W_CACHE_DISABLED', message: e && e.name === 'QuotaExceededError'
        ? 'The basis cache ran out of space and is off for this session.' : 'The basis cache is unavailable and is off for this session.' };
    notices.push(cacheState.notice);
}

/** Opt-in IndexedDB cache of basis fields, keyed [geomKey, k]; LRU with a 100 MB cap. */
export const basisCache = {
    /** True if the user turned the cache on and it works in this session. */
    get enabled() {
        if (cacheState.disabled) return false;
        if (prefs().basisCache !== true) return false;
        try { return !!(env.cacheBackend || env.indexedDB()); } catch (e) { return false; }
    },
    /** Turns the cache on (default) or off; a preference that persists. @returns {Promise<boolean>} enabled */
    async enable(on = true) { setPrefs({ basisCache: !!on }); if (on) cacheState.disabled = false; return basisCache.enabled; },
    /** Turns the cache off. */
    disable() { setPrefs({ basisCache: false }); return false; },
    /** The cached basis or null. @returns {Promise<Float64Array|null>} */
    async get(geomKey, k) {
        if (!basisCache.enabled) return null;
        try {
            const key = [geomKey, k];
            const data = await backend().get(key);
            if (!data) return null;
            const buf = data instanceof ArrayBuffer ? data : (data.buffer instanceof ArrayBuffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null);
            if (!buf) return null;
            backend().touch(key, { bytes: buf.byteLength, lastUsed: env.now() }).catch(() => {});
            return new Float64Array(buf);
        } catch (e) { return null; }
    },
    /** Stores a basis (a copy), then evicts least-recently-used entries above 100 MB. @returns {Promise<boolean>} */
    async put(geomKey, k, phi, meta = {}) {
        if (!basisCache.enabled) return false;
        try {
            const data = phi.buffer.slice(phi.byteOffset, phi.byteOffset + phi.byteLength);
            await backend().put([geomKey, k], data, { ...meta, bytes: data.byteLength, lastUsed: env.now() });
            await evict();
            return true;
        } catch (e) {
            disableForSession(e);
            return false;
        }
    },
    /** True if every listed basis of the geometry is cached. */
    async has(geomKey, ks) {
        if (!basisCache.enabled) return false;
        try {
            const metas = await backend().listMeta();
            const set = new Set(metas.filter((m) => m.key[0] === geomKey).map((m) => m.key[1]));
            return ks.every((k) => set.has(k));
        } catch (e) { return false; }
    },
    /** Removes every cached basis. */
    async clear() {
        try { await backend().clear(); return true; } catch (e) { return false; }
    },
    /** { bytes, entries } held by the cache. */
    async usage() {
        try {
            const metas = await backend().listMeta();
            return { bytes: metas.reduce((s, m) => s + (m.bytes || 0), 0), entries: metas.length };
        } catch (e) { return { bytes: 0, entries: 0 }; }
    },
    /** Why the cache is off this session (or null). */
    notice() { return cacheState.notice; },
    LIMIT_BYTES: CACHE_LIMIT,
};

async function evict() {
    const metas = await backend().listMeta();
    let total = metas.reduce((s, m) => s + (m.bytes || 0), 0);
    if (total <= CACHE_LIMIT) return;
    metas.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    for (const m of metas) {
        if (total <= CACHE_LIMIT) break;
        await backend().remove(m.key);
        total -= m.bytes || 0;
    }
}
