// Round-1 verification fixes: regression tests for the problems the independent reviewers found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../beta/ion-optics/js/engine/schema.js';
import * as io from '../../beta/ion-optics/js/engine/io.js';
import * as G from '../../beta/ion-optics/js/engine/geometry.js';
import * as A from '../../beta/ion-optics/js/engine/analysis.js';
import * as optimize from '../../beta/ion-optics/js/engine/optimize.js';
import { runProject } from '../../beta/ion-optics/js/engine/pipeline.js';
import { estimateProject } from '../../beta/ion-optics/js/ui/jobs.js';
import { createPool } from '../../beta/ion-optics/js/ui/pool.js';
import { ENGINE_VERSION, PROTOCOL_VERSION } from '../../beta/ion-optics/js/engine/version.js';
import * as aj from '../../beta/ion-optics/js/ui/analysis-jobs.js';
import * as plots from '../../beta/ion-optics/js/ui/plots.js';
import { presetById } from '../../beta/ion-optics/js/presets/index.js';

test('accuracy table: Richardson estimates use the observed order (clamped to 1–2), p = 1 when unknown', () => {
    // values converging as h^(4/3): v(h) = 10 + h^(4/3); h = 1 (current), 0.5 (fine), 2 (coarse)
    const v = (hh) => 10 + Math.pow(hh, 4 / 3);
    const m = (x) => [{ key: 'k', label: 'k', unit: '', value: x }];
    const [row] = aj.accuracyTable(m(v(1)), m(v(0.5)), m(v(1)), m(v(2)));
    assert.ok(Math.abs(row.order - 4 / 3) < 1e-9, `order ${row.order}`);
    assert.ok(Math.abs(row.p - 4 / 3) < 1e-9);
    // the error of the current value (exact limit 10) and of the h/2 value, signed so that value + err = limit
    assert.ok(Math.abs(row.value + row.errCurrent - 10) < 1e-9, `current ${row.errCurrent}`);
    assert.ok(Math.abs(row.fine + row.errFine - 10) < 1e-9, `fine ${row.errFine}`);
    const [noOrder] = aj.accuracyTable(m(v(1)), m(v(0.5)), m(v(1)), null);
    assert.equal(noOrder.p, 1);
    assert.ok(Math.abs(noOrder.errCurrent - 2 * noOrder.dGrid) < 1e-12, 'p = 1: error of the current value is 2Δ');
    const [coarser] = aj.accuracyTable(m(v(1)), m(v(2)), m(v(1)), null, { fineIsCoarser: true });
    assert.ok(Number.isNaN(coarser.errFine));
    assert.ok(Math.abs(coarser.errCurrent + coarser.dGrid) < 1e-12, 'comparison with 2h, p = 1: error of current = −Δ');
});

test('W_QUASISTATIC: warned when 2πfL/c > 0.05, not for the presets', () => {
    const p = presetById('rf-quadrupole').build();
    assert.ok(!S.resolve(p).warnings.some((w) => w.code === 'W_QUASISTATIC'));
    for (const e of p.electrodes) if (e.wave) for (const t of e.wave.terms) if (t.type === 'cos') t.freq = 2000;
    const w = S.resolve(p).warnings.filter((x) => x.code === 'W_QUASISTATIC');
    assert.equal(w.length, 1);
    assert.match(w[0].path, /^electrodes\[\d+\]\.wave\.terms\[0\]\.freq$/);
    // ideal quadrupole fields count too
    const q = presetById('einzel').build();
    q.idealFields = [{ id: 'f1', enabled: true, type: 'quadrupole2d', center: [0, 0], r0: 4, U: 0, V: 100, freq: 500, phase: 0 }];
    assert.ok(S.resolve(q).warnings.some((x) => x.code === 'W_QUASISTATIC' && x.path === 'idealFields[0].freq'));
});

test('files and links must be ion-optics projects: {"a": 1} is refused', async () => {
    assert.throws(() => io.parseProject('{"a":1}'), /not an ion-optics project/);
    assert.throws(() => io.parseProject('{"format":"other"}'), /Not a project file/);
    await assert.rejects(io.decodeShare('#pj=eyJhIjoxfQ'), /does not contain an ion-optics project/);
    // a hand-written project without the format tag is still accepted
    const hand = presetById('einzel').build(); delete hand.format; delete hand.version;
    assert.equal(io.parseProject(JSON.stringify(hand)).meta.name, 'Einzel lens');
    const link = await io.encodeShare(presetById('two-tube').build());
    assert.equal((await io.decodeShare('#' + link)).meta.name, 'Two-tube immersion lens');
});

test('a parameter with an error gives a dependency error where it is used, not "unknown parameter"', () => {
    const p = presetById('einzel').build();
    p.params.find((q) => q.name === 'Vc').value = '1/0';
    const errs = S.resolve(p).errors;
    assert.equal(errs[0].code, 'E_NOT_FINITE');
    const dep = errs.find((e) => e.path === 'electrodes[2].v');
    assert.equal(dep.code, 'E_PARAM_DEPENDS');
    assert.ok(!errs.some((e) => e.code === 'E_EXPR_UNKNOWN'));
});

test('CSV text that a spreadsheet reads as a formula is neutralized', () => {
    assert.equal(io.toCSV(['a', 'b', 'c'], [[NaN, Infinity, '=1+2'], ['@x', '-y', 'm/z 100']]), "a,b,c\r\n,Infinity,'=1+2\r\n'@x,'-y,m/z 100\r\n");
    assert.equal(plots.csvText(['a'], [['=HYPERLINK("x")'], [-3]]), 'a\r\n"\'=HYPERLINK(""x"")"\r\n-3\r\n');
});

test('W_APERTURE_RES and the Domain tab see thin apertures made of polylines', () => {
    const p = presetById('aperture-lens').build();
    for (const [cell, warn] of [[0.25, false], [0.5, true], [1, true]]) {
        p.domain.cell = cell;
        const r = S.resolve(p).resolved;
        const g = G.compileGeometry(r);
        const radii = G.apertureRadii(g, r);
        assert.ok(radii.length >= 2 && radii.every((a) => Math.abs(a.r - 5) < 1e-9), JSON.stringify(radii));
        assert.equal(G.geometryWarnings(g, r).some((w) => w.code === 'W_APERTURE_RES'), warn, `cell ${cell}`);
    }
    // no new warnings on the presets at their own cells
    for (const id of ['einzel', 'two-tube', 'aperture-lens', 'plate-mirror', 'cda-127', 'hemisphere', 'reflectron', 'vmi']) {
        const r = S.resolve(presetById(id).build()).resolved;
        assert.ok(!G.geometryWarnings(G.compileGeometry(r), r).some((w) => w.code === 'W_APERTURE_RES'), id);
    }
});

test('waist: reported on a field-free continuation only (Einzel yes; Einzel without field, VMI no)', () => {
    const e = runProject(presetById('einzel').build());
    const w = A.beamWaist(e.result, e.resolved, e.field.model);
    assert.ok(w && w.ok && Math.abs(w.position - 78.9) < 2, JSON.stringify(w));
    const off = presetById('einzel').build(); off.params.find((q) => q.name === 'Vc').value = 0;
    const r0 = runProject(off);
    const w0 = A.beamWaist(r0.result, r0.resolved, r0.field.model);
    assert.ok(w0 && !w0.ok && /parallel/.test(w0.reason), JSON.stringify(w0));
    const v = presetById('vmi').build(); v.sources[0].energy = { type: 'list', values: [1] };
    const rv = runProject(v);
    const wv = A.beamWaist(rv.result, rv.resolved, rv.field.model);
    assert.ok(!wv || !wv.ok, JSON.stringify(wv));
});

test('Summary energy error is relative to the energy scale, and the resolving-power metric is rms-based', () => {
    const p = presetById('reflectron').build(); p.sources[0].count = 40; p.recording.trajectories.store = false;
    const r = runProject(p);
    const sum = A.summarize(r.result, r.resolved);
    assert.ok(sum.energy.maxEndRel < 1e-5, `relative to ≈ 2400 eV, not 0.5 eV: ${sum.energy.maxEndRel}`);
    const m = optimize.evaluateMetric({ type: 'resolvingPower', plane: 'det', species: 'm/z 100' }, r.result, r.resolved);
    const t = [];
    const smp = optimize.planeSample(r.result, r.resolved, 0, { type: 'resolvingPower', plane: 'det', species: 'm/z 100' });
    for (const x of smp.tof) t.push(x);
    assert.ok(Math.abs(m / A.peakStats(t).resolvingPowerRms - 1) < 1e-12);
});

test('crossing rows are budgeted per run and counted in the memory estimate', () => {
    const p = presetById('paul-trap').build();
    p.recording.planes.push({ id: 'pmid', name: 'Mid plane', kind: 'x', at: 0, limits: null, radius: null, terminate: false, side: 'both', record: 'all' });
    const r = S.resolve(p).resolved;
    const base = estimateProject(r, { workers: 4 });
    const q = structuredClone(p); for (const s of q.sources) s.count = 500000;
    const big = estimateProject(S.resolve(q).resolved, { workers: 4 });
    // the run's 2e6 crossing rows on the 'all' plane × 112 B × 2 copies ≈ 450 MB on top of the summary rows
    assert.ok(big.memMB - base.memMB > 400, `estimate grows with the crossing rows: ${base.memMB} → ${big.memMB}`);
    // a small run keeps 1000 rows per particle and plane at most; dropped rows are counted
    const one = structuredClone(p); one.sources = [{ ...one.sources[0], count: 2 }]; one.tracer.tMax = 2000;
    const out = runProject(one);
    assert.equal(typeof out.result.stats.crossDropped, 'number');
});

test('worker pool: a broken reserved preview worker (or every other worker) does not strand jobs', async () => {
    for (const broken of [[0], [1, 2, 3]]) {
        let made = 0;
        class FakeWorker {
            constructor() { this.index = made++; this.onmessage = null; this.onerror = null; }
            postMessage(m) {
                if (m.type === 'hello') {
                    if (broken.includes(this.index)) return;
                    setTimeout(() => this.onmessage && this.onmessage({ data: { v: 1, type: 'hello', id: m.id, engine: ENGINE_VERSION, protocol: PROTOCOL_VERSION } }), 2);
                    return;
                }
                setTimeout(() => this.onmessage && this.onmessage({ data: { v: 1, type: 'traceResult', id: m.id, i0: 0, result: {} } }), 2);
            }
            terminate() {}
        }
        const pool = createPool({ size: 4, WorkerImpl: FakeWorker, helloTimeoutMs: 100 });
        await pool.ready;
        const within = (pr) => Promise.race([pr.then(() => 'ok'), new Promise((res) => setTimeout(() => res('pending'), 1500))]);
        assert.equal(await within(pool.exec({ type: 'trace' }, { priority: 1 })), 'ok', `normal job, broken ${broken}`);
        assert.equal(await within(pool.exec({ type: 'trace' }, { priority: 0, group: 'preview' })), 'ok', `preview job, broken ${broken}`);
        assert.equal(pool.traceWorkers(), broken.length === 1 ? 3 : 1);
        pool.terminate();
    }
});

test('beamWaist groups the rays by species: the magnetic sector reports the image of each species, not the crossing of their lines', () => {
    const r = runProject(presetById('magnetic-sector').build());
    const w = A.beamWaist(r.result, r.resolved, r.field.model);
    assert.ok(w && w.ok, JSON.stringify(w));
    // Barber's rule: object and image at r/tan 45° = 100 mm; the detector is at x = −100, so every species images there (±1.5 mm dispersion)
    assert.ok(Math.abs(w.position + 100) < 0.3, `mean waist ${w.position}`);
    assert.equal(w.groups.length, 3);
    const pos = w.groups.map((g) => g.position);
    assert.ok(Math.abs(Math.min(...pos) + 101.45) < 0.2 && Math.abs(Math.max(...pos) + 98.45) < 0.2, pos.join(', '));
    assert.ok(w.spread > 2.5 && w.spread < 3.5 && w.rms < 0.05, `spread ${w.spread}, rms ${w.rms}`);
    // single-species presets are unchanged by the grouping
    const e = runProject(presetById('einzel').build());
    const we = A.beamWaist(e.result, e.resolved, e.field.model);
    assert.ok(we.ok && we.groups.length === 1 && Math.abs(we.position - 78.91) < 0.05, JSON.stringify(we));
});

test('peakStats: the FWHM reliability mark rarely passes an edge-shaped peak and rarely fails a Gaussian', () => {
    const lcg = (s) => () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
    let edgeResolved = 0, gaussResolved = 0, gaussRatioOff = 0;
    const T = 40;
    for (let t = 0; t < T; t++) {
        const rnd = lcg(5000 + t);
        // density ∝ 1/√(t − 30): a peak with a steep edge and no finite half-maximum width
        const edge = Float64Array.from({ length: 250 }, () => { const u = rnd(); return 30 + 1e-3 * u * u; });
        if (A.peakStats(edge).fwhmResolved) edgeResolved++;
        const g = Float64Array.from({ length: 250 }, () => 100 + 0.01 * Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd()));
        const s = A.peakStats(g);
        if (s.fwhmResolved) { gaussResolved++; if (Math.abs(s.resolvingPower / s.resolvingPowerRms - 1) > 0.35) gaussRatioOff++; }
    }
    assert.ok(edgeResolved <= 0.08 * T, `edge peaks marked resolved: ${edgeResolved}/${T}`);
    assert.ok(gaussResolved >= 0.85 * T, `Gaussians marked resolved: ${gaussResolved}/${T}`);
    assert.equal(gaussRatioOff, 0, 'a resolved Gaussian FWHM agrees with the rms width');
    const s = A.peakStats(Float64Array.from({ length: 250 }, lcg(7)));
    assert.ok(Number.isFinite(s.fwhmRatio) && Number.isFinite(s.fwhmSpread), 'diagnostics are returned');
});

test('Summary and Lens panels: project identity and field-state keys change with the right edits', async () => {
    const results = await import('../../beta/ion-optics/js/ui/panels/results.js');
    const lens = await import('../../beta/ion-optics/js/ui/panels/lens.js');
    const hash = await import('../../beta/ion-optics/js/engine/hash.js');
    const state = (p) => {
        const r = S.resolve(p).resolved;
        const gk = hash.geomKey(r), fk = hash.fieldKey(r, gk), rk = hash.runKey(r, fk);
        return { project: p, resolved: r, keys: { geomKey: gk, fieldKey: fk, runKey: rk } };
    };
    const p = presetById('einzel').build();
    const a = state(p);
    const v = structuredClone(p); v.params.find((q) => q.name === 'Vc').value = -8000;
    const b = state(v);
    assert.equal(a.keys.geomKey, b.keys.geomKey, 'a voltage change keeps the geometry key');
    assert.notEqual(results.projectIdentity(a), results.projectIdentity(b), 'the accuracy report identity changes with a voltage');
    assert.notEqual(lens.fieldStateKey(a), lens.fieldStateKey(b), 'the lens field-state key changes with a voltage');
    const c = structuredClone(p); c.tracer.relativistic = false;
    assert.notEqual(lens.fieldStateKey(a), lens.fieldStateKey(state(c)), 'and with the relativistic flag');
    const d = structuredClone(p); d.view.scale = 9;
    assert.equal(results.projectIdentity(a), results.projectIdentity(state(d)), 'a view change keeps both');
    assert.equal(lens.fieldStateKey(a), lens.fieldStateKey(state(d)));
});
