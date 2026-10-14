// WP-H Compare tab: the pin store (add, replace, remove, cap at 8, local-storage round trip, damaged or blocked storage),
// pin records (deep project snapshot, metrics, label), deterministic regeneration from the snapshot and seed, and the
// side-by-side metric table and CSV for the Einzel preset at Vc = 850 and 700 V.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as aj from '../../beta/ion-optics/js/ui/analysis-jobs.js';
import { pinSummary } from '../../beta/ion-optics/js/ui/panels/compare.js';
import { runProject } from '../../beta/ion-optics/js/engine/pipeline.js';
import { presetById } from '../../beta/ion-optics/js/presets/index.js';
import { ENGINE_VERSION } from '../../beta/ion-optics/js/engine/version.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
function fakeStorage({ throwOnAccess = false, quota = Infinity } = {}) {
    const map = new Map();
    const s = {
        map,
        getItem(k) { if (throwOnAccess) throw new Error('blocked'); return map.has(k) ? map.get(k) : null; },
        setItem(k, v) { if (throwOnAccess) throw new Error('blocked'); if (String(v).length > quota) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } map.set(k, String(v)); },
        removeItem(k) { map.delete(k); },
    };
    return s;
}
function einzelAt(vc) {
    const p = presetById('einzel').build();
    p.params.find((q) => q.name === 'Vc').value = vc;
    return p;
}
const runs = new Map();
function einzelRun(vc) {
    if (!runs.has(vc)) {
        const project = einzelAt(vc);
        const r = runProject(project);
        runs.set(vc, { project, resolved: r.resolved, result: r.result, model: r.field.model });
    }
    return runs.get(vc);
}
function pinOf(vc, id) {
    const r = einzelRun(vc);
    return aj.makePin({ project: r.project, resolved: r.resolved, result: r.result, model: r.model, id, now: 1_760_000_000_000 });
}
const rowOf = (table, label) => table.rows.find((r) => r[0] === label);

test('pin store: add replaces by id and keeps the newest 8; remove; colours cycle through the six tokens', () => {
    const mk = (i) => ({ id: `p${i}`, label: `pin ${i}`, project: { meta: { name: 'x' } }, metrics: null, color: aj.PIN_COLORS[i % 6], visible: true });
    let pins = [];
    for (let i = 0; i < 10; i++) pins = aj.addPin(pins, mk(i));
    assert.equal(pins.length, aj.MAX_PINS);
    assert.deepEqual(pins.map((p) => p.id), ['p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'], 'the two oldest were dropped');
    pins = aj.addPin(pins, { ...mk(5), label: 'renamed' });
    assert.equal(pins.length, aj.MAX_PINS);
    assert.deepEqual(pins.map((p) => p.id), ['p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'], 'a pin with the same id replaces the old one in place');
    assert.equal(pins[3].label, 'renamed');
    assert.equal(pins.filter((p) => p.id === 'p5').length, 1);
    pins = aj.removePin(pins, 'p7');
    assert.equal(pins.length, 7);
    assert.ok(!pins.some((p) => p.id === 'p7'));
    assert.equal(aj.nextPinColor([]), 'c1');
    assert.equal(aj.nextPinColor([{ color: 'c1' }, { color: 'c3' }]), 'c2');
    assert.equal(aj.nextPinColor(aj.PIN_COLORS.map((c) => ({ color: c }))), 'c1', 'all six used: cycle');
    assert.equal(aj.nextPinColor([...aj.PIN_COLORS, 'c1'].map((c) => ({ color: c }))), 'c2');
});

test('pin store: local-storage round trip keeps project, metrics, label, colour and visibility; damaged, foreign or blocked storage reads as []', () => {
    const s = fakeStorage();
    assert.deepEqual(aj.readPins(s), []);
    const a = { id: 'a', label: 'A', createdAt: '2026-10-14T00:00:00Z', engineVersion: ENGINE_VERSION, runKey: 'k1', project: einzelAt(850), metrics: { launched: 21, transmission: 1, planes: [] }, color: 'c2', visible: false,
        result: { summary: new Float64Array(24) }, resolved: { big: true } };
    const b = { id: 'b', label: 'B', project: einzelAt(700), metrics: null, color: 'c4' };
    assert.equal(aj.writePins([a, b], s, 1_760_000_000_000), true);
    const saved = JSON.parse(s.map.get(aj.PINS_STORAGE_KEY));
    assert.equal(saved.version, 1);
    assert.equal(saved.pins.length, 2);
    assert.ok(!('result' in saved.pins[0]) && !('resolved' in saved.pins[0]), 'results and derived state are never stored');
    const back = aj.readPins(s);
    assert.equal(back.length, 2);
    assert.equal(back[0].id, 'a'); assert.equal(back[0].label, 'A'); assert.equal(back[0].color, 'c2'); assert.equal(back[0].visible, false);
    assert.equal(back[0].engineVersion, ENGINE_VERSION); assert.equal(back[0].runKey, 'k1');
    assert.deepEqual(back[0].project, a.project);
    assert.deepEqual(back[0].metrics, a.metrics);
    assert.equal(back[1].visible, true, 'visibility defaults to shown');
    assert.equal(back[1].metrics, null);
    // more than 8 saved (or hand-edited): the newest 8 are read; entries without id or project are dropped
    s.setItem(aj.PINS_STORAGE_KEY, JSON.stringify({ pins: [...Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, project: { meta: { name: `n${i}` } } })), { id: 'noproject' }, { project: {} }, 'junk', null] }));
    const many = aj.readPins(s);
    assert.equal(many.length, 8);
    assert.equal(many[0].id, 'q2');
    assert.equal(many[0].label, 'n2', 'a missing label is derived from the project');
    assert.equal(many[0].color, 'c1', 'an unknown colour falls back to the first token');
    s.setItem(aj.PINS_STORAGE_KEY, '{not json');
    assert.deepEqual(aj.readPins(s), []);
    s.setItem(aj.PINS_STORAGE_KEY, JSON.stringify({ something: 'else' }));
    assert.deepEqual(aj.readPins(s), []);
    assert.deepEqual(aj.readPins(null), []);
    assert.deepEqual(aj.readPins(fakeStorage({ throwOnAccess: true })), []);
    assert.equal(aj.writePins([a], fakeStorage({ throwOnAccess: true })), false);
    assert.equal(aj.writePins([a], fakeStorage({ quota: 10 })), false);
    assert.equal(aj.writePins([a], null), false);
});

test('a pin is a deep snapshot with the run metrics, its label names the slider parameter', () => {
    const r = einzelRun(850);
    const pin = pinOf(850, 'pin-850');
    assert.equal(pin.id, 'pin-850');
    assert.equal(pin.label, 'Einzel lens · Vc = 850 V');
    assert.equal(pin.engineVersion, ENGINE_VERSION);
    assert.equal(typeof pin.runKey, 'string');
    assert.ok(pin.runKey.length > 0);
    assert.equal(pin.createdAt, '2025-10-09T08:53:20.000Z');
    assert.equal(pin.color, 'c1'); assert.equal(pin.visible, true);
    assert.deepEqual(pin.project, r.project);
    assert.notEqual(pin.project, r.project, 'a copy');
    r.project.params.find((q) => q.name === 'Vc').value = 0;
    assert.equal(pin.project.params.find((q) => q.name === 'Vc').value, 850, 'changing the original leaves the snapshot alone');
    r.project.params.find((q) => q.name === 'Vc').value = 850;
    const m = pin.metrics;
    assert.equal(m.launched, 21);
    assert.equal(m.transmission, 1);
    assert.ok(m.waist && m.waist.ok && m.waist.axis === 'x', JSON.stringify(m.waist));
    assert.ok(Math.abs(m.waist.position - 78.9) < 2, `waist ${m.waist.position}`);
    assert.ok(m.waist.rms > 0 && m.waist.rms < 1, `rms at the waist ${m.waist.rms}`);
    assert.equal(m.planes.length, 1);
    assert.equal(m.planes[0].id, 'p1'); assert.equal(m.planes[0].crossings, 21); assert.equal(m.planes[0].fraction, 1);
    assert.ok(isNum(m.planes[0].spotRms) && m.planes[0].spotRms > 0);
    assert.ok(isNum(m.planes[0].meanTof) && m.planes[0].meanTof > 0);
    assert.ok(m.planes[0].tof && isNum(m.planes[0].tof.sd) && m.planes[0].tof.peaks.length === 1 && m.planes[0].tof.peaks[0].label === 'm/z 100');
    assert.ok(isNum(m.energy.maxEnd));
    assert.equal(m.trajectories, true);
    assert.ok(JSON.stringify(m).length < 20000, 'metrics are small and JSON-safe');
    // other labels: no slider parameter → fixed electrode voltages; nothing numeric → the name alone
    const tt = presetById('two-tube').build();
    assert.ok(/^Two-tube immersion lens/.test(aj.pinLabel(tt)), aj.pinLabel(tt));
    assert.equal(aj.pinLabel({ meta: { name: 'Bare' }, params: [], electrodes: [{ id: 'gnd', ground: true }] }), 'Bare');
    assert.equal(aj.pinLabel({}), 'Untitled project');
    assert.match(pinSummary(m), /^21 particles · transmission 100% · waist at x ≈ 78\.\d+ mm, rms 0\.\d+ mm$/);
    assert.throws(() => aj.makePin({ project: r.project, resolved: null, result: r.result }), /needs the project/);
});

test('Einzel at Vc 850 and 700 V: the table shows both waists and rms spots, the CSV has a column per pin', () => {
    const p850 = pinOf(850, 'a'), p700 = pinOf(700, 'b');
    const t = aj.compareTable([p850, p700]);
    assert.deepEqual(t.columns, ['Metric', '1. Einzel lens · Vc = 850 V', '2. Einzel lens · Vc = 700 V']);
    assert.equal(t.rows.length, t.keys.length);
    const waist = rowOf(t, 'Waist position (mm)'), rms = rowOf(t, 'rms radius at the waist (mm)'), spot = rowOf(t, 'Image plane: spot rms (mm)');
    assert.ok(waist && rms && spot, t.rows.map((r) => r[0]).join(' | '));
    assert.ok(isNum(waist[1]) && isNum(waist[2]));
    assert.ok(Math.abs(waist[1] - 78.9) < 2, `850 V waist ${waist[1]}`);
    assert.ok(waist[2] > waist[1] + 5, `the weaker lens (700 V) focuses further out: ${waist[2]} vs ${waist[1]}`);
    assert.ok(isNum(rms[1]) && isNum(rms[2]) && rms[1] > 0 && rms[2] > 0);
    assert.ok(isNum(spot[1]) && isNum(spot[2]) && spot[1] !== spot[2]);
    assert.deepEqual(rowOf(t, 'Particles launched').slice(1), [21, 21]);
    assert.deepEqual(rowOf(t, 'Image plane: transmission').slice(1), [1, 1]);
    assert.ok(rowOf(t, 'Image plane: mean TOF (µs)'));
    assert.ok(rowOf(t, 'Image plane: TOF σ (µs)'));
    assert.ok(rowOf(t, 'Max |ΔE| at the end (eV)'));
    assert.ok(!t.rows.some((r) => /m\/z 100/.test(r[0])), 'per-species rows only with two or more species');
    // a pin without metrics (not yet regenerated) gives NaN cells, not missing rows
    const t2 = aj.compareTable([p850, { id: 'c', label: 'empty', project: {}, metrics: null }]);
    assert.equal(rowOf(t2, 'Waist position (mm)').length, 3);
    assert.ok(Number.isNaN(rowOf(t2, 'Waist position (mm)')[2]));
    assert.deepEqual(aj.compareTable([]).rows, []);
    // metricsOf picks another metric set (the panel passes the regenerated one)
    const t3 = aj.compareTable([p850], () => ({ launched: 5 }));
    assert.deepEqual(t3.rows, [['Particles launched', 5]]);
    // CSV
    const csv = aj.compareCsv([p850, p700]);
    const lines = csv.trimEnd().split('\r\n');
    assert.equal(lines.length, t.rows.length + 1);
    assert.equal(lines[0], 'Metric,1. Einzel lens · Vc = 850 V,2. Einzel lens · Vc = 700 V');
    const wl = lines.find((l) => l.startsWith('Waist position (mm),'));
    assert.ok(wl);
    const cells = wl.split(',');
    assert.equal(cells.length, 3);
    assert.ok(Math.abs(Number(cells[1]) - waist[1]) < 1e-9 * waist[1]);
    assert.ok(Math.abs(Number(cells[2]) - waist[2]) < 1e-9 * waist[2]);
});

test('a pin regenerates deterministically from its snapshot and seed; metricsDiffer sees a changed run', () => {
    const r = einzelRun(850);
    const pin = pinOf(850, 'det');
    // what the Compare tab does after a reload: run the stored project again (through JSON, as local storage returns it)
    const again = runProject(JSON.parse(JSON.stringify(pin.project)));
    assert.equal(again.result.n, r.result.n);
    assert.deepEqual(Array.from(again.result.summary), Array.from(r.result.summary), 'summary rows are bitwise equal');
    assert.deepEqual(Array.from(again.result.crossings.subarray(0, again.result.nCross * 14)), Array.from(r.result.crossings.subarray(0, r.result.nCross * 14)));
    assert.ok(again.result.traj && r.result.traj);
    assert.equal(again.result.traj.pts.length, r.result.traj.pts.length);
    assert.deepEqual(Array.from(again.result.traj.offsets), Array.from(r.result.traj.offsets));
    assert.deepEqual(Array.from(again.result.traj.pts), Array.from(r.result.traj.pts), 'trajectory points are bitwise equal');
    const m2 = aj.pinMetrics(again.result, again.resolved, again.field.model);
    assert.equal(aj.metricsDiffer(pin.metrics, m2), false);
    // the stored metrics survive a JSON round trip (NaN → null) and still compare equal
    assert.equal(aj.metricsDiffer(JSON.parse(JSON.stringify(pin.metrics)), m2), false);
    // a different run is seen
    const other = pinOf(700, 'other');
    assert.equal(aj.metricsDiffer(pin.metrics, other.metrics), true);
    assert.equal(aj.metricsDiffer(null, m2), false);
    // the serialized pin is what the panel saves: the same project, no results
    const s = aj.serializePin({ ...pin, result: r.result, resolved: r.resolved });
    assert.deepEqual(Object.keys(s).sort(), ['color', 'createdAt', 'engineVersion', 'id', 'label', 'metrics', 'project', 'runKey', 'visible']);
    assert.deepEqual(s.project, pin.project);
});
