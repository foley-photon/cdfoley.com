// Review fix pass (engine 0.2.2): regression tests for the numerics review findings fixed in the engine and the UI
// guards. Each test names the finding it guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as PL from '../../beta/ion-optics/js/engine/pipeline.js';
import * as S from '../../beta/ion-optics/js/engine/schema.js';
import * as io from '../../beta/ion-optics/js/engine/io.js';
import { parseExpr } from '../../beta/ion-optics/js/engine/expr.js';
import { magneticWarning, BETA2_WARN } from '../../beta/ion-optics/js/engine/coulomb.js';
import { mergeResults } from '../../beta/ion-optics/js/engine/trace.js';
import { summarize } from '../../beta/ion-optics/js/engine/analysis.js';
import { ENGINE_VERSION } from '../../beta/ion-optics/js/engine/version.js';
import * as L from '../../beta/ion-optics/js/engine/layout.js';

const SUM = (r, i, f) => r.summary[i * L.S_STRIDE + f];
const SC = (factor = 1e-30, softening = 1e-4) => ({ enabled: true, model: 'coulomb', softening, maxParticles: 2000, factor });

// ---------------------------------------------------------------- a small planar project builder
const ED = (electrode) => ({ bc: 'dirichlet', electrode });
function proj(o) {
    return {
        format: 'ion-optics-project', version: 1,
        meta: { name: o.name || 'review fix test', notes: '', created: '2026-11-04T00:00:00Z', modified: '2026-11-04T00:00:00Z', engine: ENGINE_VERSION },
        params: [],
        domain: { type: 'planar2d', cell: o.cell, x: o.x, y: o.y,
            edges: { xmin: ED('gnd'), xmax: ED('gnd'), ymin: ED('gnd'), ymax: ED('gnd') },
            mirror: { x: false, y: false }, antimirror: { x: false, y: false }, charge: '',
            beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' } },
        electrodes: [{ id: 'gnd', name: 'Ground', ground: true, color: '#64748b' }, ...(o.electrodes || [])],
        shapes: (o.shapes || []).map((s, i) => ({ id: 's' + (i + 1), enabled: true, locked: false, ...s })),
        magnets: o.magnets || [], idealFields: [], sources: o.sources || [],
        recording: { planes: [], trajectories: { store: false, maxPoints: 2000 }, timeMarkers: null },
        tracer: { integrator: 'rk45', quality: 'normal', custom: null, fieldInterp: 'cubic', relativistic: o.relativistic === true, tMax: o.tMax || 100, maxSteps: 1000000, maxDrift: 10000,
            drag: null, spaceCharge: o.spaceCharge || null, gas: null },
        solver: { boundary: 'subgrid', method: 'auto', tol: 1e-12, maxCycles: 60, maxIterations: 200, maxSweeps: 100000 },
        analysis: { lens: null, scan: null, optimize: null, waist: null },
        view: { center: [0, 0], scale: 5, displayTime: 0, projection: 'xy', colormap: 'auto', contourLevels: null,
            layers: { potential: true, contours: 20, field: false, electrodes: true, trajectories: 'source', planes: true, hits: true, grid: 'auto', mirror: true, markers: false } },
    };
}
const lineSource = ({ n, x0, ke = 1e6, mass = 1, charge = 1, color = 'auto', y0 = 8 }) => ({
    id: 'b1', name: 'b', enabled: true, color, type: 'sampled', weight: 1, count: n, sampling: 'random', seed: 1,
    species: [{ label: 'x', mass, charge, fraction: 1 }],
    position: { type: 'line', p0: [x0, -y0, 0], p1: [x0, y0, 0], n }, direction: { type: 'fixed', dir: [1, 0, 0] },
    energy: { type: 'mono', ke }, time: { type: 'fixed', t: 0 } });
/** A transparent plate (mesh) of transmission T at x = mx, thickness t, in a 60 mm box; a line source at x0. */
function meshProject({ n, x0, mx, t, T = 0.5, cell = 1, V = 0, ke = 1e6, spaceCharge = null }) {
    return proj({ cell, x: [-30, 30], y: [-30, 30], spaceCharge,
        electrodes: [{ id: 'M', name: 'M', kind: 'grid', transmission: T, v: V, wave: null, color: '#2563eb' }],
        shapes: [{ electrode: 'M', type: 'plate', x: mx, t, rHole: 0, rOut: 25 }],
        sources: [lineSource({ n, x0, ke })] });
}
function statusCounts(res) {
    const c = {};
    for (let i = 0; i < res.n; i++) { const st = L.STATUS_NAMES[SUM(res, i, L.S_STATUS)]; c[st] = (c[st] || 0) + 1; }
    return c;
}
/** Mesh crossing rows (C_KIND 1) per particle id. */
function meshRows(res) {
    const per = new Map();
    for (let c = 0; c < res.nCross; c++) {
        const b = c * L.C_STRIDE;
        if (res.crossings[b + L.C_KIND] !== 1) continue;
        const id = res.crossings[b + L.C_ID];
        per.set(id, (per.get(id) || 0) + 1);
    }
    return per;
}

// ================================================================ finding 1: thick mesh in the space-charge tracer
test('space charge: a thick mesh rolls its transmission once per crossing (inside it transparent electrodes are skipped)', () => {
    const n = 600;
    for (const t of [0, 0.05, 2]) {
        const ord = PL.runProject(meshProject({ n, x0: -19.97, mx: 0.3, t })).result;
        const sc = PL.runProject(meshProject({ n, x0: -19.97, mx: 0.3, t, spaceCharge: SC() })).result;
        assert.equal(sc.stats.lockstep, true);
        const a = statusCounts(ord), b = statusCounts(sc);
        // the mesh roll of a particle depends only on its id and crossing count, so both tracers pass the same particles
        assert.equal(b.EXIT, a.EXIT, `t = ${t}: space charge ${JSON.stringify(b)} vs ordinary ${JSON.stringify(a)}`);
        assert.ok(b.EXIT > 0.42 * n && b.EXIT < 0.58 * n, `t = ${t}: transmission ${b.EXIT / n} (was T^(t/s) ≈ 0 for t = 2 mm)`);
        for (const [id, k] of meshRows(sc)) assert.equal(k, 1, `particle ${id}: one mesh row`);
    }
});

// ================================================================ finding 2: gyration step cap and the energy check of the space-charge tracer
test('space charge: 32 steps per gyration keep a slow ion in a strong B field, and the energy error is reported', () => {
    // 10 eV proton in 1 T: r = 0.457 mm < cell 0.5 mm, 100 turns (RK4 at about 11 steps per turn lost 35 % of its KE)
    const m = 1.007276, Bz = 1;
    const fc = 1.602176634e-19 * Bz / (m * 1.66053906892e-27) / (2 * Math.PI);   // Hz
    const T = 1e6 / fc;                                                            // µs per turn
    const p = proj({ cell: 0.5, x: [-10, 10], y: [-10, 10], tMax: 100 * T, spaceCharge: SC(1),
        magnets: [{ id: 'm1', name: 'B', enabled: true, type: 'uniform', B: [0, 0, Bz] }],
        sources: [{ ...lineSource({ n: 1, x0: 0, ke: 10, mass: m }), position: { type: 'point', p: [0, 0, 0] }, sampling: 'grid' }] });
    const out = PL.runProject(p), r = out.result;
    const ke = SUM(r, 0, L.S_KE), dE = SUM(r, 0, L.S_DE_END);
    assert.equal(L.STATUS_NAMES[SUM(r, 0, L.S_STATUS)], 'TMAX');
    assert.ok(SUM(r, 0, L.S_STEPS) >= 32 * 100 - 1, `steps ${SUM(r, 0, L.S_STEPS)}`);
    assert.ok(Math.abs(ke - 10) < 0.01 * 10, `KE after 100 turns ${ke} eV`);
    // field-free in E: the energy error is the KE change, and it is flagged and summarized (no longer "not checked")
    assert.ok(Number.isFinite(dE) && Math.abs(dE - (ke - 10)) < 1e-9, `S_DE_END ${dE} vs ΔKE ${ke - 10}`);
    assert.ok(SUM(r, 0, L.S_DE_MAX) >= Math.abs(dE));
    assert.ok((SUM(r, 0, L.S_FLAGS) & L.FLAG.ENERGY_WARN) !== 0, 'the loss is flagged');
    assert.ok(Math.abs(SUM(r, 0, L.S_WORK) - Math.abs(dE)) < 1e-6, 'the work sum sees the same integration error');
    assert.equal(out.summary.energy.notChecked, null);
    assert.equal(out.summary.energy.warned, 1);
});

test('space charge: the energy check is net of the pair-force work (two protons from rest close to 1e-9 of their energy)', () => {
    // two protons 1 µm apart from rest in a field-free box: each gains k e²/(2d) = 0.72 meV from the pair force
    const p = proj({ cell: 1, x: [-10, 10], y: [-10, 10], tMax: 300, spaceCharge: { ...SC(1, 1e-7), pairStep: 0.005 },
        sources: [{ ...lineSource({ n: 2, x0: 0, ke: 0, y0: 5e-4 }), sampling: 'grid', direction: { type: 'fixed', dir: [0, 1, 0] } }] });
    p.tracer.quality = 'fine';
    const r = PL.runProject(p).result;
    for (let i = 0; i < 2; i++) {
        const ke = SUM(r, i, L.S_KE), dE = SUM(r, i, L.S_DE_END);
        assert.ok(ke > 0.7e-3 && ke < 0.73e-3, `KE ${ke} eV`);
        assert.ok(Number.isFinite(dE) && Math.abs(dE) < 1e-9 * 1e-3 + 1e-6 * ke, `ΔE net of the pair work ${dE} eV`);
        assert.equal(SUM(r, i, L.S_FLAGS) & L.FLAG.ENERGY_WARN, 0, 'not flagged');
    }
    assert.equal(r.warnings, undefined, 'slow protons: no magnetic pair-force warning');
});

// ================================================================ finding 3: a field-free mesh at a step end
test('trace.js: a mesh on a step end rolls once (meshCarry), so a T = 0.5 mesh passes 0.5, not T²', () => {
    const n = 2001;
    // source at x = 0, mesh at x = 10, cell 0.5: the field-free steps end exactly on the mesh
    for (const [x0, mx, cell] of [[0, 10, 0.5], [-20, 0.3, 1]]) {
        const r = PL.runProject(meshProject({ n, x0, mx, t: 0, cell })).result;
        const c = statusCounts(r);
        assert.ok(c.EXIT > 0.45 * n && c.EXIT < 0.55 * n, `x0 ${x0}, mesh ${mx}: transmission ${c.EXIT / n} (was ≈ 0.244)`);
        for (const [id, k] of meshRows(r)) assert.equal(k, 1, `particle ${id}: one mesh row, not two at the same x`);
    }
});

// ================================================================ finding 4: conventional precedence of a leading minus
test('expressions: -x^2 = -(x^2) (conventional precedence), 2^-1 = 0.5', () => {
    const ev = (s, v = {}) => parseExpr(s).evaluate(v);
    assert.equal(ev('-2^2'), -4);
    assert.equal(ev('-x^2', { x: 3 }), -9);
    assert.equal(ev('(-x)^2', { x: 3 }), 9);
    assert.equal(ev('2^-1'), 0.5);
    assert.equal(ev('2^-x', { x: 3 }), 0.125);
    assert.equal(ev('2*-3'), -6);
    assert.equal(ev('8/-2^2'), -2);
    assert.equal(ev('exp(-r^2/4)', { r: 2 }), Math.exp(-1), 'a Gaussian decays');
});

// ================================================================ finding 5: a source color is only ever #rrggbb or auto
test('a source color that is not #rrggbb becomes "auto" in the resolved project, and the Particles swatch guards it', async () => {
    const p = meshProject({ n: 4, x0: -20, mx: 0.3, t: 0 });
    p.sources[0].color = 'url(https://tracker.invalid/beacon.png)';
    const r = S.resolve(p);
    assert.equal(r.resolved.sources[0].color, 'auto');
    assert.ok(r.warnings.some((w) => w.code === 'W_COLOR' && w.path === 'sources[0].color'));
    const q = meshProject({ n: 4, x0: -20, mx: 0.3, t: 0 });
    q.sources[0].color = '#12abEF';
    assert.equal(S.resolve(q).resolved.sources[0].color, '#12abEF', 'a valid color is kept');
    // a share link keeps the project text, so the panel (which draws from the project) must guard as well
    const d = await io.decodeShareDetailed('#' + await io.encodeShare(p));
    assert.ok(d.warnings.some((w) => w.code === 'W_COLOR'));
    const src = readFileSync(new URL('../../beta/ion-optics/js/ui/panels/particles.js', import.meta.url), 'utf8');
    const line = src.split('\n').find((l) => l.includes('row.sw.style.background'));
    assert.ok(line && /\/\^#\[0-9a-f\]\{6\}\$\/i\.test\(s\.color\)/.test(line), `the swatch tests #rrggbb: ${line}`);
});

// ================================================================ finding 7: __proto__ in a project file
test('a "__proto__" key in a project does not set the prototype of the resolved project', () => {
    const p = meshProject({ n: 4, x0: -20, mx: 0.3, t: 0 });
    const txt = JSON.stringify(p).replace(/^\{/, '{"__proto__":{"particleCount":1e9,"polluted":true},"constructor":{"polluted":true},"prototype":1,"myKey":7,');
    const proj2 = io.parseProject(txt);
    assert.ok(Object.prototype.hasOwnProperty.call(proj2, '__proto__'), 'the parsed file carries the key as data');
    const r = PL.resolveOrThrow(proj2);
    assert.equal(Object.getPrototypeOf(r), Object.prototype);
    assert.equal(r.polluted, undefined);
    assert.equal(r.particleCount, 4);
    assert.equal(r.constructor, Object, 'constructor is not copied');
    assert.equal(Object.prototype.hasOwnProperty.call(r, 'prototype'), false);
    assert.equal(r.myKey, 7, 'other unknown keys are still kept');
    assert.equal(({}).polluted, undefined);
});

// ================================================================ physics finding 1: the electrostatic pair force at high β
test('space charge: a run whose mean β² exceeds 0.01 warns W_SC_MAGNETIC (electrostatic pair forces), and a merge keeps it', () => {
    assert.equal(magneticWarning(BETA2_WARN), null);
    assert.equal(magneticWarning(0.005), null);
    const w = magneticWarning(0.3);
    assert.equal(w.code, 'W_SC_MAGNETIC');
    assert.match(w.message, /electrostatic only/);
    assert.match(w.message, /γ² ≈ 1\.43/);
    // 30 keV electrons (β² = 0.109), field-free
    const p = proj({ cell: 1, x: [-30, 30], y: [-30, 30], tMax: 1e-4, relativistic: true, spaceCharge: SC(1),
        sources: [lineSource({ n: 4, x0: -20, ke: 30000, mass: 5.48579909065e-4, charge: -1 })] });
    const r = PL.runProject(p).result;
    assert.ok(Math.abs(r.stats.beta2 - 0.1088) < 2e-3, `mean β² ${r.stats.beta2}`);
    assert.ok(Array.isArray(r.warnings) && r.warnings.length === 1 && r.warnings[0].code === 'W_SC_MAGNETIC');
    const m = mergeResults([r]);
    assert.equal(m.warnings[0].code, 'W_SC_MAGNETIC');
    assert.equal(m.stats.beta2, r.stats.beta2);
    assert.equal(summarize(m, PL.resolveOrThrow(p)).launched, 4);
    // the ordinary tracer has no pair force and no such warning
    const q = proj({ cell: 1, x: [-30, 30], y: [-30, 30], tMax: 1e-4, relativistic: true,
        sources: [lineSource({ n: 4, x0: -20, ke: 30000, mass: 5.48579909065e-4, charge: -1 })] });
    assert.equal(PL.runProject(q).result.warnings, undefined);
});
