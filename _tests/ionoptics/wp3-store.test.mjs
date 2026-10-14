// WP3 acceptance (6): the store keeps 200 undo steps, merges updates with the same key within 1 s into one step, and
// decides staleness only by the cache keys (spec §2.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../beta/ion-optics/js/ui/store.js';
import { einzel } from './fixtures/wp3/projects.mjs';

/** A store with a manual clock. */
function make(project = einzel(), opts = {}) {
    let t = 1000;
    const store = createStore(project, { mobile: false, now: () => t, ...opts });
    return { store, tick: (ms) => { t += ms; }, at: () => t };
}
const vc = (s) => s.project.params[1].value;

test('200 undo steps; redo; labels', () => {
    const { store, tick } = make();
    for (let i = 1; i <= 250; i++) { store.update((p) => { p.params[1].value = i; }, { label: `step ${i}` }); tick(10); }
    assert.equal(store.undoDepth(), 200);
    assert.equal(store.undoLabel(), 'step 250');
    for (let i = 0; i < 200; i++) assert.equal(store.undo(), true);
    assert.equal(store.undo(), false, 'the oldest 50 steps were dropped');
    assert.equal(vc(store), 50);
    assert.equal(store.canUndo(), false);
    assert.equal(store.canRedo(), true);
    assert.equal(store.redoLabel(), 'step 51');
    for (let i = 0; i < 5; i++) store.redo();
    assert.equal(vc(store), 55);
    store.update((p) => { p.params[1].value = -1; }, { label: 'branch' });
    assert.equal(store.canRedo(), false, 'a new edit clears redo');
    store.undo();
    assert.equal(vc(store), 55);
});

test('updates with the same merge key within 1 s are one undo step', () => {
    const { store, tick } = make();
    const start = vc(store);
    for (let i = 0; i < 100; i++) { store.update((p) => { p.params[1].value = 900 + i; }, { label: 'Vc', merge: 'v:centre' }); tick(16); }   // a 1.6 s drag
    assert.equal(store.undoDepth(), 1);
    assert.equal(vc(store), 999);
    store.undo();
    assert.equal(vc(store), start, 'one undo restores the value before the drag');
    store.redo();
    tick(1001);
    store.update((p) => { p.params[1].value = 1; }, { merge: 'v:centre' });
    assert.equal(store.undoDepth(), 2, 'more than 1 s later: a new step');
    tick(10);
    store.update((p) => { p.params[1].value = 2; }, { merge: 'v:outer' });
    assert.equal(store.undoDepth(), 3, 'another key: a new step');
    tick(10);
    store.update((p) => { p.params[1].value = 3; }, { merge: 'v:outer' });
    store.update((p) => { p.params[1].value = 4; });
    assert.equal(store.undoDepth(), 4, 'no key: always a new step');
    store.undo();
    tick(10);
    store.update((p) => { p.params[1].value = 5; }, { merge: 'v:outer' });
    assert.equal(store.undoDepth(), 4, 'undo breaks a merge chain');
});

test('mutators edit a copy; returning a new project also works; the previous snapshot is untouched', () => {
    const { store } = make();
    const before = store.project;
    store.update((p) => { p.shapes[0].x0 = -50; });
    assert.equal(before.shapes[0].x0, -55);
    assert.equal(store.project.shapes[0].x0, -50);
    store.update((p) => ({ ...p, meta: { ...p.meta, name: 'Returned' } }));
    assert.equal(store.project.meta.name, 'Returned');
    assert.throws(() => store.update(() => { throw new Error('bad mutator'); }));
    assert.equal(store.project.meta.name, 'Returned', 'a throwing mutator changes nothing');
    assert.notEqual(store.project.meta.modified, undefined);
});

test('staleness is decided only by the keys', () => {
    const { store } = make();
    const st = () => store.get();
    const g0 = st().keys.geomKey;
    store.setSolution({ geomKey: g0, raster0: null, bases: new Map() });
    assert.equal(st().solve.status, 'done');
    store.setRun({ status: 'done', result: { n: 1 }, runKey: st().keys.runKey });
    assert.equal(st().run.status, 'done');
    // cosmetic edits: nothing stale
    store.update((p) => { p.electrodes[1].color = '#000000'; p.meta.notes = 'n'; p.view.scale = 9; });
    assert.deepEqual([st().solve.status, st().run.status], ['done', 'done']);
    // a voltage edit: the run is stale, the solution is not
    store.update((p) => { p.params[1].value = 900; });
    assert.deepEqual([st().solve.status, st().run.status], ['done', 'stale']);
    // back to the old voltage: the keys match again, so the run is current again
    store.update((p) => { p.params[1].value = 850; });
    assert.deepEqual([st().solve.status, st().run.status], ['done', 'done']);
    // a geometry edit: the solution is stale; undo makes it current again
    store.update((p) => { p.shapes[0].x0 = -54; });
    assert.deepEqual([st().solve.status, st().run.status], ['stale', 'stale']);
    store.undo();
    assert.deepEqual([st().solve.status, st().run.status], ['done', 'done']);
    assert.equal(st().keys.geomKey, g0);
    // running states are left alone; an error stays only while its geometry is current
    store.setSolve({ status: 'running' });
    store.update((p) => { p.shapes[0].x0 = -53; });
    assert.equal(st().solve.status, 'running');
    store.setSolve({ status: 'error', error: { code: 'E_NO_CONVERGENCE', message: 'x' }, geomKey: st().keys.geomKey });
    store.update((p) => { p.params[1].value = 860; });
    assert.equal(st().solve.status, 'error', 'same geometry: the error stays');
    store.update((p) => { p.shapes[0].x0 = -52; });
    assert.equal(st().solve.status, 'stale', 'new geometry: stale, error cleared');
    assert.equal(st().solve.error, null);
});

test('invalid edits keep the last resolved project and report issues with paths', () => {
    const { store } = make();
    const last = store.resolved;
    store.update((p) => { p.domain.cell = 0; });
    assert.equal(store.valid, false);
    assert.equal(store.resolved, null);
    assert.equal(store.lastResolved, last);
    assert.deepEqual(store.keys, { geomKey: null, fieldKey: null, runKey: null });
    assert.ok(store.issues.some((i) => i.path === 'domain.cell' && i.severity === 'error'));
    assert.ok(Array.isArray(store.issues.errors) && store.issues.errors.length === 1);
    store.undo();
    assert.equal(store.valid, true);
});

test('events, listeners and their errors', () => {
    const { store } = make();
    const seen = [];
    const offs = ['project', 'resolved', 'selection', 'solve', 'solution', 'field', 'run', 'runs', 'ui', 'error'].map((e) => store.on(e, (payload, state, info) => seen.push([e, info.event])));
    store.update((p) => { p.meta.name = 'x'; }, { label: 'Rename' });
    assert.deepEqual(seen.splice(0), [['project', 'project'], ['resolved', 'resolved']]);
    store.select({ kind: 'shape', ids: ['s1'] });
    assert.deepEqual(store.selection, { kind: 'shape', ids: ['s1'] });
    store.setUi('dock.tab', 'hits');
    assert.equal(store.get().ui['dock.tab'], 'hits');
    assert.equal(store.get().ui.dock.tab, 'hits');
    store.setField({ fieldKey: 'f' }); store.setRun({ progress: { done: 1 } }); store.pinRun({ id: 1 }); store.unpinRun(1);
    assert.deepEqual(seen.splice(0).map((x) => x[0]), ['selection', 'ui', 'field', 'run', 'runs', 'runs']);
    // a throwing listener is reported through 'error', other listeners still run
    store.on('project', () => { throw new Error('listener bug'); });
    let ran = false;
    store.on('project', () => { ran = true; });
    store.update((p) => { p.meta.name = 'y'; });
    assert.ok(ran);
    const err = seen.find((x) => x[0] === 'error');
    assert.ok(err, 'error event');
    offs.forEach((off) => off());
    seen.length = 0;
    store.update((p) => { p.meta.name = 'z'; });
    assert.deepEqual(seen, [], 'unsubscribed');
});

test('replaceProject resets solution and results; undo returns to the previous project', () => {
    const { store } = make();
    store.setSolution({ geomKey: store.keys.geomKey, raster0: null, bases: new Map() });
    store.setRun({ status: 'done', result: { n: 2 }, runKey: store.keys.runKey });
    const e0 = store.get().run.epoch;
    const p2 = einzel(); p2.meta.name = 'Second';
    store.replaceProject(p2, { label: 'Open' });
    const st = store.get();
    assert.equal(st.project.meta.name, 'Second');
    assert.deepEqual([st.solution, st.field, st.solve.status, st.run.status, st.run.result], [null, null, 'none', 'none', null]);
    assert.equal(st.run.epoch, e0 + 1);
    store.undo();
    assert.equal(store.project.meta.name, 'Einzel lens');
    for (let i = 0; i < 3; i++) store.pinRun({ id: i });
    for (let i = 3; i < 12; i++) store.pinRun({ id: i });
    assert.equal(store.get().runs.length, 8, 'at most 8 pinned runs');
});
