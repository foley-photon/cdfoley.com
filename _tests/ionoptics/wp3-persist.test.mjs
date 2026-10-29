// WP3 acceptance (8): persistence with fake storage — autosave survives a reload, storage exceptions are handled,
// the IndexedDB basis cache is off by default and evicts least-recently-used entries; links, recent, files.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../beta/ion-optics/js/ui/persist.js';
import { encodeShare } from '../../beta/ion-optics/js/engine/io.js';
import { canonicalJSON } from '../../beta/ion-optics/js/engine/hash.js';
import { migrate, newProject } from '../../beta/ion-optics/js/engine/schema.js';
import { einzel, plateMirror, vmi } from './fixtures/wp3/projects.mjs';

// ---------------------------------------------------------------- fakes
function fakeStorage({ throwOnAccess = false, quota = Infinity } = {}) {
    const map = new Map();
    const s = {
        map, sets: 0,
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) {
            const size = [...map].reduce((a, [kk, vv]) => a + (kk === k ? 0 : vv.length), 0) + String(v).length;
            if (size > quota) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
            s.sets++; map.set(k, String(v));
        },
        removeItem(k) { map.delete(k); },
    };
    return throwOnAccess ? () => { const e = new Error('The operation is insecure.'); e.name = 'SecurityError'; throw e; } : () => s;
}
function fakeTimers() {
    let now = 0, seq = 0;
    const due = new Map();
    return {
        setTimeout: (f, ms) => { const id = ++seq; due.set(id, { at: now + ms, f }); return id; },
        clearTimeout: (id) => { due.delete(id); },
        advance(ms) {
            now += ms;
            for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) { due.delete(id); t.f(); }
        },
        pending: () => due.size,
    };
}
function fakeBackend({ keepData = true, quotaBytes = Infinity } = {}) {
    const data = new Map(), meta = new Map(), key = (k) => JSON.stringify(k);
    const b = {
        calls: 0, data, meta,
        async get(k) { b.calls++; return data.get(key(k)) || null; },
        async put(k, d, m) {
            b.calls++;
            const used = [...meta.values()].reduce((a, x) => a + x.bytes, 0);
            if (used + m.bytes > quotaBytes) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; }
            data.set(key(k), keepData ? d : new ArrayBuffer(0)); meta.set(key(k), { ...m });
        },
        async touch(k, m) { b.calls++; if (meta.has(key(k))) meta.set(key(k), { ...meta.get(key(k)), lastUsed: m.lastUsed }); },   // sizes as stored
        async remove(k) { b.calls++; data.delete(key(k)); meta.delete(key(k)); },
        async listMeta() { b.calls++; return [...meta].map(([k, m]) => ({ key: JSON.parse(k), ...m })); },
        async clear() { b.calls++; data.clear(); meta.clear(); },
    };
    return b;
}
let clock = 1_700_000_000_000;
function env(over = {}) {
    const timers = fakeTimers();
    const history = { calls: [], replaceState(s, t, url) { this.calls.push(url); } };
    const e = {
        storage: fakeStorage(), location: () => ({ hash: '', pathname: '/beta/ion-optics/', search: '', origin: 'https://example.test', href: 'https://example.test/beta/ion-optics/' }),
        history: () => history, document: () => null, indexedDB: () => null, now: () => clock,
        setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
        loadPreset: async (id) => (id === 'einzel' ? einzel() : null), cacheBackend: null, ...over,
    };
    P.configurePersist(e);
    return { e, timers, history };
}
const same = (a, b) => assert.equal(canonicalJSON(a), canonicalJSON(b));

beforeEach(() => { clock += 1000; });

test('first visit: the Einzel preset; without presets: a new project', async () => {
    env();
    const r = await P.loadInitial();
    assert.equal(r.source, 'default');
    same(r.project, migrate(einzel()));
    env({ loadPreset: async () => { throw new Error('presets/index.js not found'); } });
    const r2 = await P.loadInitial();
    assert.equal(r2.source, 'default');
    assert.equal(r2.project.domain.type, 'cyl2d');
    assert.deepEqual(r2.project.shapes, []);
});

test('autosave: 1 s debounce, survives a reload, flushes on demand', async () => {
    const { e, timers } = env();
    const s = e.storage();
    const p = plateMirror();
    P.autosave(einzel()); timers.advance(500);
    P.autosave(p); timers.advance(999);
    assert.equal(s.sets, 0, 'nothing written within 1 s of the last change');
    timers.advance(1);
    assert.equal(s.sets, 1, 'one write for two changes');
    const saved = JSON.parse(s.getItem('ionopt.autosave.v1'));
    assert.equal(typeof saved.savedAt, 'string');
    // reload: a new session with the same storage
    P.configurePersist({ ...e, storage: () => s });
    const r = await P.loadInitial();
    assert.equal(r.source, 'autosave');
    same(r.project, p);
    same(P.readAutosave().project, p);
    P.autosave(vmi());
    assert.equal(P.flushAutosave(), true);
    assert.equal(timers.pending(), 0, 'flush cancels the timer');
    same(JSON.parse(s.getItem('ionopt.autosave.v1')).project, vmi());
    assert.equal(P.flushAutosave(), false, 'nothing pending');
});

test('a share link wins over the autosave, which moves to Recent; the hash is removed', async () => {
    const { e, history } = env();
    P.autosave(einzel()); P.flushAutosave();
    const linked = plateMirror();
    const hash = '#' + await encodeShare(linked);
    P.configurePersist({ ...e, location: () => ({ hash, pathname: '/beta/ion-optics/', search: '?x=1', origin: 'https://example.test' }) });
    const r = await P.loadInitial();
    assert.equal(r.source, 'link');
    same(r.project, linked);
    assert.deepEqual(history.calls, ['/beta/ion-optics/?x=1']);
    assert.equal(P.recent()[0].name, 'Einzel lens');
    same(P.recent()[0].project, einzel());
    history.calls.length = 0;
    await P.loadInitial({ keepHash: true });
    assert.deepEqual(history.calls, [], 'keepHash leaves the address alone');
    // a damaged link falls back to the autosave and reports why
    P.configurePersist({ ...e, location: () => ({ hash: '#p=damaged$$', pathname: '/', search: '' }) });
    const bad = await P.loadInitial();
    assert.equal(bad.source, 'autosave');
    assert.equal(bad.error.code, 'E_BAD_PROJECT');
});

test('storage exceptions are handled: blocked storage, full storage, damaged data', async () => {
    // blocked (e.g. a sandboxed or private window): every call works and nothing throws
    env({ storage: fakeStorage({ throwOnAccess: true }) });
    assert.equal((await P.loadInitial()).source, 'default');
    assert.doesNotThrow(() => { P.autosave(einzel()); P.flushAutosave(); });
    assert.deepEqual(P.recent(), []);
    assert.equal(P.pushRecent(einzel()), false);
    assert.deepEqual(P.prefs(), {});
    assert.doesNotThrow(() => P.setPrefs({ live: false }));
    assert.equal(P.readAutosave(), null);
    // full: the write fails and the user is told
    const { e } = env({ storage: fakeStorage({ quota: 100 }) });
    P.autosave(einzel());
    assert.equal(P.flushAutosave(), false);
    assert.deepEqual(P.takeNotices().map((n) => n.code), ['W_STORAGE_FULL']);
    // damaged JSON or a foreign object in storage is ignored
    const s = fakeStorage()();
    s.setItem('ionopt.autosave.v1', '{not json');
    s.setItem('ionopt.recent.v1', '"x"');
    s.setItem('ionopt.prefs.v1', '[1,2]');
    env({ storage: () => s });
    assert.equal(P.readAutosave(), null);
    assert.deepEqual(P.recent(), []);
    assert.deepEqual(P.prefs(), {});
    assert.equal((await P.loadInitial()).source, 'default');
    s.setItem('ionopt.autosave.v1', JSON.stringify({ savedAt: 'x', project: { format: 'spreadsheet' } }));
    assert.equal((await P.loadInitial()).source, 'default');
    assert.ok(P.takeNotices().some((n) => n.code === 'W_AUTOSAVE_DAMAGED'));
    void e;
});

test('Recent: newest first, deduplicated, at most 10, fewer when storage is full', () => {
    const { e } = env();
    for (let i = 0; i < 12; i++) { const p = einzel(); p.meta.name = `P${i}`; P.pushRecent(p); }
    let list = P.recent();
    assert.equal(list.length, 10);
    assert.deepEqual(list.slice(0, 3).map((x) => x.name), ['P11', 'P10', 'P9']);
    const again = einzel(); again.meta.name = 'P5';
    P.pushRecent(again);
    list = P.recent();
    assert.equal(list.length, 10);
    assert.equal(list[0].name, 'P5');
    assert.equal(list.filter((x) => x.name === 'P5').length, 1, 'the same project is listed once');
    P.removeRecent(list[0].hash);
    assert.equal(P.recent()[0].name, 'P11');
    // storage that only fits a few projects keeps the newest ones
    const one = JSON.stringify(einzel()).length;
    env({ storage: fakeStorage({ quota: one * 3.5 }) });
    for (let i = 0; i < 6; i++) { const p = einzel(); p.meta.name = `Q${i}`; P.pushRecent(p); }
    const kept = P.recent();
    assert.ok(kept.length >= 1 && kept.length < 6);
    assert.equal(kept[0].name, 'Q5');
    void e;
});

test('preferences merge', () => {
    env();
    assert.deepEqual(P.prefs(), {});
    P.setPrefs({ live: false, visited: true });
    P.setPrefs({ live: true });
    assert.deepEqual(P.prefs(), { live: true, visited: true });
});

test('the IndexedDB basis cache is off by default', async () => {
    const backend = fakeBackend();
    env({ cacheBackend: backend });
    assert.equal(P.basisCache.enabled, false);
    assert.equal(await P.basisCache.put('g1', 1, new Float64Array(4)), false);
    assert.equal(await P.basisCache.get('g1', 1), null);
    assert.equal(await P.basisCache.has('g1', [1]), false);
    assert.equal(backend.calls, 0, 'nothing touches IndexedDB until the user turns the cache on');
    // no IndexedDB at all: it cannot be enabled
    env({ cacheBackend: null, indexedDB: () => null });
    assert.equal(await P.basisCache.enable(true), false);
});

test('basis cache: round trip, LRU eviction above 100 MB, quota errors disable it for the session', async () => {
    const backend = fakeBackend();
    env({ cacheBackend: backend });
    assert.equal(await P.basisCache.enable(true), true);
    assert.equal(P.prefs().basisCache, true);
    const phi = Float64Array.from({ length: 1000 }, (_, i) => Math.sin(i));
    assert.equal(await P.basisCache.put('gA', 1, phi), true);
    phi[0] = 99;
    const back = await P.basisCache.get('gA', 1);
    assert.ok(back instanceof Float64Array && back.length === 1000);
    assert.equal(back[0], 0, 'the cache stored a copy');
    assert.equal(back[5], Math.sin(5));
    assert.equal(await P.basisCache.has('gA', [1]), true);
    assert.equal(await P.basisCache.has('gA', [1, 2]), false);
    await P.basisCache.clear();
    // LRU: 13 × 8 MB; entry 0 is read (most recently used) before the overflow, so entry 1 goes first
    const lru = fakeBackend({ keepData: false });
    env({ cacheBackend: lru });
    await P.basisCache.enable(true);
    const eight = new Float64Array(1 << 20);
    for (let k = 0; k < 12; k++) { clock += 10; assert.equal(await P.basisCache.put('gL', k, eight), true); }
    clock += 10;
    lru.data.set(JSON.stringify(['gL', 0]), new ArrayBuffer(8));
    await P.basisCache.get('gL', 0);
    clock += 10;
    await P.basisCache.put('gL', 12, eight);
    const u = await P.basisCache.usage();
    assert.ok(u.bytes <= P.basisCache.LIMIT_BYTES, `${u.bytes} bytes`);
    const keys = (await lru.listMeta()).map((m) => m.key[1]).sort((a, b) => a - b);
    assert.ok(keys.includes(0) && keys.includes(12) && !keys.includes(1), JSON.stringify(keys));
    // quota: disabled for this session, with a notice; turning it on again re-enables it
    const full = fakeBackend({ quotaBytes: 100 });
    env({ cacheBackend: full });
    await P.basisCache.enable(true);
    P.takeNotices();
    assert.equal(await P.basisCache.put('gQ', 1, new Float64Array(100)), false);
    assert.equal(P.basisCache.enabled, false);
    assert.equal(P.basisCache.notice().code, 'W_CACHE_DISABLED');
    assert.match(P.basisCache.notice().message, /ran out of space/);
    assert.deepEqual(P.takeNotices().map((n) => n.code), ['W_CACHE_DISABLED']);
    assert.equal(await P.basisCache.get('gQ', 1), null);
    assert.equal(await P.basisCache.enable(true), true);
    P.basisCache.disable();
    assert.equal(P.basisCache.enabled, false);
});

test('share links, downloads and project files', async () => {
    env();
    const link = await P.shareLink(einzel());
    assert.ok(link.url.startsWith('https://example.test/beta/ion-optics/#p='));
    assert.equal(String(link), link.url);
    assert.equal(link.tooLong, false);
    const noisy = einzel();
    noisy.meta.notes = Array.from({ length: 1500 }, (_, i) => (i * 2654435761 >>> 0).toString(36)).join(' ');
    const long = await P.shareLink(noisy);
    assert.ok(long.chars > 8000 && long.tooLong, `${long.chars} characters`);
    // download through a fake document
    const made = [];
    const doc = { body: { appendChild: (a) => made.push(a) }, createElement: () => ({ style: {}, click() { this.clicked = true; }, remove() { this.removed = true; } }) };
    env({ document: () => doc });
    assert.equal(P.downloadProject(einzel()), true);
    assert.equal(made[0].download, 'Einzel lens.ionopt.json');
    assert.ok(made[0].clicked && made[0].removed && made[0].href.startsWith('blob:'));
    env({ document: () => null });
    assert.equal(P.downloadProject(einzel()), false);
    // reading files
    const file = (text, size = text.length) => ({ size, text: async () => text });
    same(await P.readProjectFile(file(JSON.stringify(einzel()))), migrate(einzel()));
    const bad = einzel(); bad.domain.cell = 0;
    await assert.rejects(P.readProjectFile(file(JSON.stringify(bad))), (e) => e.code === 'E_BAD_PROJECT' && e.path === 'domain.cell');
    await assert.rejects(P.readProjectFile(file('{', 6 * 1024 * 1024)), (e) => /larger than 5 MB/.test(e.message));
    await assert.rejects(P.readProjectFile(file('not json')), (e) => e.code === 'E_BAD_PROJECT');
    await assert.rejects(P.readProjectFile(null), (e) => e.code === 'E_BAD_PROJECT');
    const blank = newProject('planar2d');
    same(await P.readProjectFile(file(JSON.stringify(blank))), migrate(blank));
});

test('a pending autosave is written when the page is hidden or closed', () => {
    const handlers = {};
    const target = { addEventListener: (t, f) => { (handlers[t] = handlers[t] || []).push(f); } };
    const doc = { visibilityState: 'visible' };
    const { e, timers } = env({ events: () => target, document: () => doc });
    const s = e.storage();
    P.autosave(einzel());
    assert.equal(s.sets, 0);
    for (const f of handlers.pagehide) f();
    assert.equal(s.sets, 1, 'written on pagehide');
    assert.equal(timers.pending(), 0);
    P.autosave(plateMirror());
    doc.visibilityState = 'hidden';
    for (const f of handlers.visibilitychange) f();
    assert.equal(s.sets, 2, 'written when the tab is hidden');
    same(JSON.parse(s.getItem('ionopt.autosave.v1')).project, plateMirror());
    P.autosave(vmi());
    assert.equal(handlers.pagehide.length, 1, 'listeners are added once');
});
