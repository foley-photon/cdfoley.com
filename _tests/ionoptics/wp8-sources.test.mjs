// WP-E (round 2): schema fields for the other packages; 'rows' sources; Freeze to list (bitwise); particle CSV in and out;
// per-source weights; Source from end states (reverse flight: the T6 lens rays return to their start points).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../beta/ion-optics/js/engine/schema.js';
import * as io from '../../beta/ion-optics/js/engine/io.js';
import * as L from '../../beta/ion-optics/js/engine/layout.js';
import { K_ACC, UC2_EV, C_MMUS, speedFromKE, properSpeedFromKE } from '../../beta/ion-optics/js/engine/constants.js';
import { histogram, summarize } from '../../beta/ion-optics/js/engine/analysis.js';
import {
    countParticles, generate, generateRows, frozenSource, rowsFromParticles, rowsFromEndStates, convertRows,
    endStatesSource, addEndStatesSource, sourceWeights, particleWeights, weightedSummary,
} from '../../beta/ion-optics/js/engine/particles.js';
import { runProject } from '../../beta/ion-optics/js/engine/pipeline.js';
import { caseProject } from '../../beta/ion-optics/js/engine/bench/cases.js';
import { einzel, plateMirror } from './fixtures/wp3/projects.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const codesAt = (list, path) => list.filter((i) => i.path === path).map((i) => i.code);
const rowsSource = (rows, over = {}) => ({ ...S.defaults('source.rows'), id: 'r1', name: 'list', rows, ...over });
const bitwise = (a, b, skip = () => false) => { assert.equal(a.length, b.length, 'length'); for (let i = 0; i < a.length; i++) if (!skip(i)) assert.ok(Object.is(a[i], b[i]), `index ${i}: ${a[i]} vs ${b[i]}`); };

// ---------------------------------------------------------------- day-1 schema fields

test('day-1 fields: defaults leave an existing project unchanged, and the new keys resolve to off', () => {
    const p = einzel();
    const before = S.resolve(p);
    assert.deepEqual(before.errors, []);
    const R = before.resolved;
    assert.deepEqual(R.domain.antimirror, { x: false, y: false });
    assert.equal(R.domain.charge, null);
    assert.equal(R.tracer.spaceCharge, null);
    assert.equal(R.tracer.gas, null);
    assert.deepEqual(R.sources.map((s) => [s.type, s.weight]), [['sampled', 1]]);
    // the same project with the new keys at their defaults gives the same particles
    const q = clone(p);
    q.domain.antimirror = { x: false, y: false }; q.domain.charge = '';
    q.tracer.spaceCharge = { ...S.defaults('spaceCharge'), enabled: false }; q.tracer.gas = { ...S.defaults('gas'), enabled: false };
    q.sources[0].type = 'sampled'; q.sources[0].weight = 1;
    const after = S.resolve(q);
    assert.deepEqual(after.errors, []); assert.deepEqual(after.warnings, before.warnings);
    assert.equal(after.resolved.tracer.spaceCharge, null); assert.equal(after.resolved.tracer.gas, null);
    bitwise(generate(R.sources, 0, R.particleCount, { relativistic: true }), generate(after.resolved.sources, 0, after.resolved.particleCount, { relativistic: true }));
    // newProject and the on-state defaults validate
    for (const t of ['planar2d', 'cyl2d']) {
        const n = S.newProject(t);
        assert.deepEqual(S.validate(n).errors, []);
        assert.deepEqual(n.domain.antimirror, { x: false, y: false }); assert.equal(n.domain.charge, ''); assert.equal(n.tracer.spaceCharge, null); assert.equal(n.tracer.gas, null);
        n.tracer.spaceCharge = S.defaults('spaceCharge'); n.tracer.gas = S.defaults('gas');
        n.magnets.push(S.defaults('magnet.poles', t));
        n.recording.planes.push({ ...S.defaults('plane'), kind: 'sphere', at: 3, center: [1, 2, 0] });
        n.sources.push(S.defaults('source.rows'));
        n.sources.push({ ...S.defaults('source'), id: 'b2' });
        const r = S.resolve(n);
        assert.deepEqual(r.errors, [], t);
        assert.deepEqual(r.resolved.tracer.spaceCharge, { enabled: true, model: 'coulomb', softening: 1e-4, maxParticles: 2000, factor: 1 });
        assert.equal(r.resolved.tracer.gas.model, 'hardSphere'); assert.equal(r.resolved.tracer.gas.ionDiameter, null); assert.deepEqual(r.resolved.tracer.gas.velocity, [0, 0, 0]);
        assert.equal(r.resolved.magnets[0].type, 'poles'); assert.equal(r.resolved.magnets[0].pieces.length, 2); assert.equal(r.resolved.magnets[0].boundary, 'neumann');
        assert.deepEqual([r.resolved.recording.planes[0].kind, r.resolved.recording.planes[0].at, r.resolved.recording.planes[0].center], ['sphere', 3, [1, 2, 0]]);
        assert.deepEqual(r.resolved.sources.map((s) => s.type), ['rows', 'sampled']);
    }
    for (const k of ['spaceCharge', 'gas', 'pole', 'antimirror', 'rows', 'row', 'source.rows']) assert.ok(S.defaults(k), k);
    assert.ok(S.ENUMS.magnetType.includes('poles') && S.ENUMS.planeKind.includes('sphere') && S.ENUMS.sourceType.includes('rows'));
    for (const k of ['spaceCharge', 'gas', 'pole', 'magnet.poles', 'antimirror', 'rows', 'rows.velocity', 'source.rows']) assert.ok(Array.isArray(S.META[k]) && S.META[k].length, k);
});

test('day-1 fields: validation (anti-mirror, charge expression, poles, sphere, space-charge cap, gas)', () => {
    const base = () => { const p = S.newProject('planar2d'); p.domain.x = [0, 10]; p.domain.y = [0, 10]; p.domain.cell = 1; return p; };
    // anti-mirror: needs x0 = 0 and a grounded xmin edge; not together with a mirror; not y in cyl2d
    let p = base(); p.domain.antimirror = { x: true, y: false };
    assert.deepEqual(S.validate(p).errors, []);
    assert.deepEqual(S.resolve(p).resolved.domain.antimirror, { x: true, y: false });
    p.domain.edges.xmin = { bc: 'neumann' };
    assert.deepEqual(codesAt(S.validate(p).errors, 'domain.edges.xmin'), ['E_MIRROR']);
    p = base(); p.domain.x = [-5, 5]; p.domain.antimirror = { x: true, y: false };
    assert.deepEqual(codesAt(S.validate(p).errors, 'domain.x[0]'), ['E_MIRROR']);
    p = base(); p.domain.mirror = { x: true, y: false }; p.domain.edges.xmin = { bc: 'neumann' }; p.domain.antimirror = { x: true, y: false };
    assert.deepEqual(codesAt(S.validate(p).errors, 'domain.antimirror.x'), ['E_MIRROR']);
    p = S.newProject('cyl2d'); p.domain.antimirror = { x: false, y: true };
    assert.deepEqual(codesAt(S.validate(p).errors, 'domain.antimirror.y'), ['E_MIRROR']);
    p = base(); p.domain.antimirror = 'x';
    assert.deepEqual(codesAt(S.validate(p).errors, 'domain.antimirror'), ['E_TYPE']);
    // charge: expression in x, y, z, r and the parameters; C/m³
    p = base(); p.params.push({ name: 'rho0', value: 2e-6, dim: 'none' }); p.domain.charge = ' rho0*sin(pi*x/10)*(1-y/10) ';
    let r = S.resolve(p);
    assert.deepEqual(r.errors, []); assert.equal(r.resolved.domain.charge, 'rho0*sin(pi*x/10)*(1-y/10)');
    p.domain.charge = 'rho0*foo';
    assert.deepEqual(codesAt(S.validate(p).errors, 'domain.charge'), ['E_EXPR_UNKNOWN']);
    p.domain.charge = 'rho0*(';
    assert.deepEqual(codesAt(S.validate(p).errors, 'domain.charge'), ['E_EXPR_SYNTAX']);
    p.domain.charge = 1;
    assert.deepEqual(codesAt(S.validate(p).errors, 'domain.charge'), ['E_TYPE']);
    p.domain.charge = '   ';
    assert.equal(S.resolve(p).resolved.domain.charge, null);
    // poles
    p = base(); p.magnets.push({ id: 'm1', type: 'poles', pieces: [] });
    assert.deepEqual(codesAt(S.validate(p).errors, 'magnets[0].pieces'), ['E_REQUIRED']);
    p.magnets[0].pieces = [{ region: { type: 'box', x0: 0, x1: 1, y0: 0, y1: 1 }, psi: 'nope' }];
    assert.deepEqual(codesAt(S.validate(p).errors, 'magnets[0].pieces[0].psi'), ['E_EXPR_UNKNOWN']);
    p.magnets[0].pieces[0].psi = 0.5; p.magnets[0].boundary = 'zero';
    r = S.resolve(p); assert.deepEqual(r.errors, []); assert.equal(r.resolved.magnets[0].boundary, 'zero'); assert.equal(r.resolved.magnets[0].pieces[0].psi, 0.5);
    // sphere plane
    p = base(); p.recording.planes.push({ id: 'p1', kind: 'sphere', at: 0 });
    assert.deepEqual(codesAt(S.validate(p).errors, 'recording.planes[0].at'), ['E_RANGE']);
    p.recording.planes[0].at = 2; r = S.resolve(p); assert.deepEqual(r.errors, []); assert.deepEqual(r.resolved.recording.planes[0].center, [0, 0, 0]);
    // space charge: cap, softening, disabled copies keep their settings
    p = base(); p.tracer.spaceCharge = { enabled: true, maxParticles: 10 }; p.sources.push({ ...S.defaults('source'), count: 11 });
    assert.deepEqual(codesAt(S.validate(p).errors, 'tracer.spaceCharge.maxParticles'), ['E_LIMIT']);
    p.sources[0].count = 10; assert.deepEqual(S.validate(p).errors, []);
    p.tracer.spaceCharge = { enabled: true, softening: 0 }; assert.deepEqual(codesAt(S.validate(p).errors, 'tracer.spaceCharge.softening'), ['E_RANGE']);
    p.tracer.spaceCharge = { enabled: false, softening: 0 }; r = S.resolve(p); assert.deepEqual(r.errors, []); assert.equal(r.resolved.tracer.spaceCharge, null);
    p.tracer.spaceCharge = { enabled: true, maxParticles: 5000 }; assert.deepEqual(codesAt(S.validate(p).errors, 'tracer.spaceCharge.maxParticles'), ['E_RANGE']);
    // gas
    p = base(); p.tracer.gas = { pressure: -1, mass: 4, diameter: 2 };
    assert.deepEqual(codesAt(S.validate(p).errors, 'tracer.gas.pressure'), ['E_RANGE']);
    p.tracer.gas = { pressure: 0.5, mass: 4, diameter: 2 }; r = S.resolve(p); assert.deepEqual(r.errors, []);
    assert.deepEqual(r.resolved.tracer.gas, { enabled: true, model: 'hardSphere', pressure: 0.5, temperature: 293.15, mass: 4, diameter: 2, ionDiameter: null, velocity: [0, 0, 0] });
    p.tracer.gas = 3; assert.deepEqual(codesAt(S.validate(p).errors, 'tracer.gas'), ['E_TYPE']);
    // weight
    p = base(); p.sources.push({ ...S.defaults('source'), weight: 0 });
    assert.deepEqual(codesAt(S.validate(p).errors, 'sources[0].weight'), ['E_RANGE']);
    p.sources[0].weight = '2*1.5'; assert.equal(S.resolve(p).resolved.sources[0].weight, 3);
});

// ---------------------------------------------------------------- rows sources

test('rows source: resolution (species, unit directions, velocity rows), counts and generation', () => {
    const p = S.newProject('cyl2d');
    p.sources.push(rowsSource([[100, 1, 1, 1, 0, 1, 0.01, 0, 100, 0], [200, 2, 1, 2, 0, 1, 0, 0, '25*2', 0.1], [100, 1, 1, 3, 0, 0, 1, 0, 10, 0]],
        { species: [{ label: 'heavy', mass: 200, charge: 2, fraction: 1 }] }));
    p.sources.push(rowsSource([[100, 1, 1, 1, 0, 10, 0, 0, 0]], { id: 'r2', velocity: true }));
    p.sources.push(rowsSource([[100, 1, 1, 1, 0, 0, 10, 0, 0.5]], { id: 'r3', velocity: true, enabled: false }));
    const r = S.resolve(p);
    assert.deepEqual(r.errors, []);
    const [a, b] = r.resolved.sources;
    assert.equal(r.resolved.sources.length, 2, 'disabled rows source dropped');
    assert.deepEqual(a.species.map((s) => [s.label, s.mass, s.charge]), [['heavy', 200, 2], ['m/z 100', 100, 1]]);
    assert.equal(a.count, 3); assert.equal(a.firstId, 0); assert.equal(b.firstId, 3); assert.equal(r.resolved.particleCount, 4);
    const n = Math.hypot(1, 0.01);
    assert.deepEqual(a.rows[0].slice(5, 8), [1 / n, 0.01 / n, 0]);
    assert.deepEqual(a.rows[1], [200, 2, 1, 2, 0, 1, 0, 0, 50, 0.1]);
    assert.deepEqual(a.position, { type: 'list', points: [[1, 1, 0], [1, 2, 0], [1, 3, 0]], preview: true });
    assert.equal(a.direction, null);
    // velocity row: KE from |v| with the relativistic flag (default on)
    const beta = 10 / C_MMUS, keRel = (1 / Math.sqrt(1 - beta * beta) - 1) * 100 * UC2_EV;
    assert.equal(b.rows[0][8], keRel); assert.deepEqual(b.rows[0].slice(5, 8), [1, 0, 0]); assert.equal(b.rows[0][9], 0);
    p.tracer.relativistic = false;
    assert.equal(S.resolve(p).resolved.sources[1].rows[0][8], 100 * 100 / (2 * K_ACC));
    // generation: w = wmag·d, species index from the list, class indices −1, ids over the sources
    assert.equal(countParticles(r.resolved.sources), 4);
    const P = generate(r.resolved.sources, 0, 4, { relativistic: true });
    const row = (i) => P.subarray(i * L.P_STRIDE, (i + 1) * L.P_STRIDE);
    assert.deepEqual([row(0)[L.P_ID], row(0)[L.P_SRC], row(0)[L.P_SPECIES], row(1)[L.P_SPECIES], row(3)[L.P_SRC], row(3)[L.P_ID]], [0, 0, 1, 0, 1, 3]);
    assert.deepEqual([row(1)[L.P_MASS], row(1)[L.P_CHARGE], row(1)[L.P_T0], row(1)[L.P_KE]], [200, 2, 0.1, 50]);
    const wm = properSpeedFromKE(100, 100);
    assert.deepEqual([row(0)[L.P_WX], row(0)[L.P_WY], row(0)[L.P_WZ]], [wm * (1 / n), wm * (0.01 / n), wm * 0]);
    assert.deepEqual([row(0)[L.P_C0], row(0)[L.P_C1], row(0)[L.P_C2]], [-1, -1, -1]);
    // KE is the stored quantity: at β = 3e-5 the proper speed recovered from (γ − 1)·m·c² carries ε/(γ − 1) ≈ 4e-7 relative, as for any slow relativistic particle
    assert.ok(Math.abs(Math.hypot(row(3)[L.P_WX], row(3)[L.P_WY], row(3)[L.P_WZ]) - 10 / Math.sqrt(1 - beta * beta)) < 1e-5, 'velocity row flies at 10 mm/µs');
    // batching never changes a particle
    bitwise(generate(r.resolved.sources, 2, 4, { relativistic: true }), P.subarray(2 * L.P_STRIDE));
    // errors: per cell, capped at 50 rows with a summary
    const bad = S.newProject('cyl2d');
    bad.sources.push(rowsSource([[0, 1, 0, 0, 0, 1, 0, 0, 1, 0], [100, 0, 0, 0, 0, 1, 0, 0, 1, 0], [100, 1, 0, 0, 0, 0, 0, 0, 1, 0], [100, 1, 0, 0, 0, 1, 0, 0, -1, 0], [1, 2, 3], 'x', [100, 1, 0, 0, 0, 1, 0, 0, 1, 0]]));
    const e = S.validate(bad).errors.map((x) => [x.path, x.code]);
    assert.deepEqual(e, [['sources[0].rows[0][0]', 'E_RANGE'], ['sources[0].rows[1][1]', 'E_RANGE'], ['sources[0].rows[2][5]', 'E_RANGE'], ['sources[0].rows[3][8]', 'E_RANGE'], ['sources[0].rows[4]', 'E_TYPE'], ['sources[0].rows[5]', 'E_TYPE']]);
    const many = S.newProject('cyl2d');
    many.sources.push(rowsSource(Array.from({ length: 80 }, () => [0, 1, 0, 0, 0, 1, 0, 0, 1, 0])));
    const em = S.validate(many).errors;
    assert.equal(em.length, 51); assert.deepEqual(em[50], { path: 'sources[0].rows', code: 'E_ROWS', message: '80 rows have errors (the first 50 are listed).' });
    const none = S.newProject('cyl2d'); none.sources.push(rowsSource([]));
    assert.deepEqual(codesAt(S.validate(none).errors, 'sources[0].rows'), ['E_RANGE']);
    const vel9 = S.newProject('cyl2d'); vel9.sources.push(rowsSource([[100, 1, 0, 0, 0, 1, 0, 0, 1, 0]], { velocity: true }));
    assert.deepEqual(codesAt(S.validate(vel9).errors, 'sources[0].rows[0]'), ['E_TYPE']);
    // convertRows is the inverse pair used by the editor's velocity switch
    const d = [[100, 1, 1, 2, 3, 0.6, 0.8, 0, 100, 0.2]];
    const v = convertRows(d, { toVelocity: true, relativistic: false });
    assert.equal(v[0].length, 9); assert.ok(Math.abs(Math.hypot(v[0][5], v[0][6], v[0][7]) - speedFromKE(100, 100, false)) < 1e-12);
    const back = convertRows(v, { toVelocity: false, relativistic: false });
    assert.ok(Math.abs(back[0][8] - 100) < 1e-9 && Math.abs(back[0][5] - 0.6) < 1e-15 && back[0][9] === 0.2);
});

test('Freeze to list: the frozen source reproduces the sampled run bit for bit (grid and random sources, through JSON)', () => {
    const p = einzel();   // grid line source
    p.sources.push({ id: 'b2', name: 'Random cone', enabled: true, color: 'auto', count: 37, sampling: 'random', seed: 7,
        species: [{ label: 'a', mass: 100, charge: 1, fraction: 2 }, { label: 'b', mass: 101, charge: 1, fraction: 1 }],
        position: { type: 'gaussian', center: [-52, 0, 0], sigma: [0, 0.5, 0.5] }, direction: { type: 'cone', axis: [1, 0.1, 0], halfAngle: 3, fill: 'solid' },
        energy: { type: 'gaussian', mean: 1000, fwhm: 20 }, time: { type: 'uniform', t0: 0, t1: 0.1 } });
    p.sources.push({ id: 'b3', name: 'Fan', enabled: true, color: 'auto', count: 1, sampling: 'grid', seed: 1,
        species: [{ label: 'e', mass: 5.4857990904271e-4, charge: -1, fraction: 1 }],
        position: { type: 'disc', center: [-50, 0, 0], normal: [1, 0, 0], radius: 2, n: 5 }, direction: { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: -3, to: 3, n: 3 },
        energy: { type: 'list', values: [500, 1000] }, time: { type: 'rfPhase', freq: 2, n: 2 } });
    const R0 = S.resolve(p).resolved;
    const P0 = generate(R0.sources, 0, R0.particleCount, { relativistic: true });
    const q = clone(p);
    q.sources = R0.sources.map((s) => frozenSource(s, { relativistic: true }));
    assert.ok(q.sources.every((s) => s.type === 'rows' && s.rows.length > 0 && s.velocity === false));
    assert.deepEqual(q.sources.map((s) => [s.id, s.rows.length]), [['b1', 21], ['b2', 37], ['b3', 60]]);
    const q2 = io.parseProject(io.serializeProject(q));   // a saved and reopened project file
    const r1 = S.resolve(q2);
    assert.deepEqual(r1.errors, []);
    const P1 = generate(r1.resolved.sources, 0, r1.resolved.particleCount, { relativistic: true });
    // every column is identical, the class indices included: the frozen lists carry them ('random' for the random source)
    bitwise(P0, P1);
    assert.deepEqual(q2.sources.map((s) => (Array.isArray(s.classes) ? s.classes.length : s.classes)), [21, 'random', 60]);
    assert.deepEqual(r1.resolved.sources.map((s) => s.species.map((x) => x.label)), [['m/z 100'], ['a', 'b'], ['e']]);
    // the full runs agree bit for bit
    const A = runProject(p), B = runProject(q2);
    bitwise(A.result.summary, B.result.summary);
    bitwise(A.result.crossings.subarray(0, A.result.nCross * L.C_STRIDE), B.result.crossings.subarray(0, B.result.nCross * L.C_STRIDE));
    assert.deepEqual(summarize(B.result, B.resolved).bySpecies.map((s) => [s.label, s.launched]), summarize(A.result, A.resolved).bySpecies.map((s) => [s.label, s.launched]));
    // generateRows and rowsFromParticles describe the same particles
    const rows = generateRows(R0.sources[1], { relativistic: true });
    const fromP = rowsFromParticles(generate([R0.sources[1]], R0.sources[1].firstId, R0.sources[1].firstId + 37, { relativistic: true }));
    rows.forEach((r, i) => { for (let c = 0; c < 10; c++) assert.ok(Math.abs(r[c] - fromP[i][c]) <= 1e-12 * Math.max(1, Math.abs(r[c])), `row ${i} col ${c}`); });
});

// ---------------------------------------------------------------- particle CSV

test('particle CSV: direction and velocity forms round-trip exactly; hits tables import as end states; errors are per row', async () => {
    const rows = [[100, 1, -52, 1.0275890105485488, 0.5996663905465078, 0.9971714515081134, 0.07391020789056414, -0.013652013286552559, 993.1763602164128, 0.09837452717951975],
        [5.4857990904271e-4, -1, 0, 0, 0, 0, 0, 1, 0.1, -0], [12, 3, 1e-7, 2e21, -3.5, 1, 0, 0, 0, 0]];
    const csv = io.particlesToCSV(rows);
    assert.equal(csv.split('\r\n')[0], io.PARTICLE_COLUMNS.join(','));
    const back = io.parseParticlesCSV(csv);
    assert.deepEqual(back.rows, rows.map((r) => r.map((v) => (Object.is(v, -0) ? 0 : v))));
    assert.deepEqual([back.velocity, back.errors, back.skipped, back.fromHits], [false, [], 0, false]);
    // velocity form keeps ke exactly and the direction to rounding; a plain velocity table derives ke from |v|
    const csvV = io.particlesToCSV(rows, { velocity: true, relativistic: true });
    assert.equal(csvV.split('\r\n')[0], io.PARTICLE_COLUMNS_VELOCITY.join(','));
    const backV = io.parseParticlesCSV(csvV, { relativistic: true });
    assert.ok(backV.velocity);
    rows.forEach((r, i) => { assert.equal(backV.rows[i][8], r[8]); for (const c of [5, 6, 7]) assert.ok(Math.abs(backV.rows[i][c] - r[c]) < 1e-12, `row ${i} col ${c}`); });
    const plainV = io.parseParticlesCSV('mass_u,charge_e,x_mm,y_mm,z_mm,vx_mm_us,vy_mm_us,vz_mm_us\n100,1,0,0,0,10,0,0\n', { relativistic: false });
    assert.deepEqual(plainV.rows, [[100, 1, 0, 0, 0, 1, 0, 0, 100 * 100 / (2 * K_ACC), 0]]);
    // headerless tables (10 or 9 columns), semicolons, tabs, comments, blank lines, aliases, reverse
    assert.deepEqual(io.parseParticlesCSV('# c\n\n100;1;0;0;0;1;0;0;50;0\n').rows, [[100, 1, 0, 0, 0, 1, 0, 0, 50, 0]]);
    assert.deepEqual(io.parseParticlesCSV('100\t1\t0\t0\t0\t0\t10\t0\t0.5', { relativistic: false }).rows, [[100, 1, 0, 0, 0, 0, 1, 0, 100 * 100 / (2 * K_ACC), 0.5]]);
    assert.deepEqual(io.parseParticlesCSV('m,q,x,y,z,dx,dy,dz,ke,t0\n100,1,0,0,0,0,0,1,5,0', { reverse: true }).rows, [[100, 1, 0, 0, 0, -0, -0, -1, 5, 0]]);
    // hits table export of a run → end states (position, direction and energy at the end), reversible
    const { resolved, result } = runProject(plateMirror());
    const fromHits = io.parseParticlesCSV(io.runToCSV(result, 'hits', resolved), { reverse: true });
    const direct = rowsFromEndStates(result, resolved, { reverse: true });
    assert.ok(fromHits.fromHits); assert.equal(fromHits.rows.length, direct.rows.length);
    fromHits.rows.forEach((r, i) => { for (let c = 0; c < 10; c++) assert.ok(Math.abs(r[c] - direct.rows[i][c]) <= 1e-9 * Math.max(1, Math.abs(direct.rows[i][c])), `row ${i} col ${c}: ${r[c]} vs ${direct.rows[i][c]}`); });
    // errors
    assert.throws(() => io.parseParticlesCSV('a,b\n1,2'), (e) => e.code === 'E_BAD_PROJECT');
    assert.throws(() => io.parseParticlesCSV('mass_u,charge_e,x_mm,y_mm,z_mm,dx,dy,dz,t0_us\n1,1,0,0,0,1,0,0,0'), (e) => /ke_eV/.test(e.message));
    assert.throws(() => io.parseParticlesCSV('1,2,3\n'), (e) => /10 columns/.test(e.message));
    assert.throws(() => io.parseParticlesCSV('\n# only comments\n'), (e) => e.code === 'E_BAD_PROJECT');
    const bad = io.parseParticlesCSV(`${io.PARTICLE_COLUMNS.join(',')}\n0,1,0,0,0,1,0,0,1,0\n100,1,0,0,0,0,0,0,1,0\n100,1,0,0,0,1,0,0,1,\n100,1,x,0,0,1,0,0,1,0\n100,1,0,0,0,1,0,0,-2,0\n`);
    assert.deepEqual(bad.errors.map((e) => e.line), [2, 3, 5, 6]); assert.equal(bad.rows.length, 1); assert.equal(bad.rows[0][9], 0, 'an empty t0 is 0');
    assert.equal(io.parseParticlesCSV(csv, { maxRows: 2 }).skipped, 1);
    // rows sources survive project files and share links; links clamp oversized lists
    const p = S.newProject('cyl2d'); p.sources.push(rowsSource(rows));
    assert.deepEqual(io.parseProject(io.serializeProject(p)).sources[0].rows, rows.map((r) => r.map((v) => (Object.is(v, -0) ? 0 : v))));
    assert.deepEqual((await io.decodeShare('#' + (await io.encodeShare(p)))).sources[0].rows, rows.map((r) => r.map((v) => (Object.is(v, -0) ? 0 : v))));
    const big = S.newProject('cyl2d'); big.sources.push(rowsSource(Array.from({ length: 5 }, () => [100, 1, 0, 0, 0, 1, 0, 0, 1, 0])));
    const d = await io.decodeShareDetailed('#pj=' + Buffer.from(JSON.stringify(big)).toString('base64url'));
    assert.equal(d.project.sources[0].rows.length, 5);
});

// ---------------------------------------------------------------- weights

test('per-source weights: particleWeights feeds histogram and the weighted transmission changes as expected', () => {
    const p = einzel();
    p.sources.push({ id: 'b2', name: 'Wide', enabled: true, color: 'auto', count: 10, sampling: 'grid', seed: 1,
        species: [{ label: 'm/z 100', mass: 100, charge: 1, fraction: 1 }],
        position: { type: 'line', p0: [-52, 6, 0], p1: [-52, 9, 0], n: 10 }, direction: { type: 'fixed', dir: [1, 0, 0] }, energy: { type: 'mono', ke: 1000 }, time: { type: 'fixed', t: 0 } });
    const run = (w1, w2) => { const q = clone(p); q.sources[0].weight = w1; q.sources[1].weight = w2; return runProject(q); };
    const A = run(1, 1), B = run(3, 1);
    const sA = summarize(A.result, A.resolved), sB = summarize(B.result, B.resolved);
    assert.equal(sA.transmission.overall, sB.transmission.overall, 'the run itself does not depend on the weights');
    const wA = weightedSummary(A.result, A.resolved), wB = weightedSummary(B.result, B.resolved);
    assert.equal(wA.transmission, sA.transmission.overall);
    assert.deepEqual(wB.unweighted, { launched: 31, detected: sB.byStatus.DETECTED, transmission: sB.transmission.overall });
    const d1 = sA.bySource[0].detected, d2 = sA.bySource[1].detected;
    assert.equal(d1, 21, 'the on-axis beam is fully detected');
    assert.ok(d2 < 10, 'the wide beam is partly lost');
    assert.equal(wB.launched, 3 * 21 + 10);
    assert.equal(wB.detected, 3 * d1 + d2);
    assert.equal(wB.transmission, (3 * d1 + d2) / (3 * 21 + 10));
    assert.deepEqual(wB.bySource.map((s) => [s.index, s.weight, s.launched, s.detected]), [[0, 3, 63, 63], [1, 1, 10, d2]]);
    assert.deepEqual(wB.byPlane, [{ index: 0, detected: 3 * d1 + d2, fraction: wB.transmission }]);
    assert.deepEqual(Array.from(sourceWeights(B.resolved.sources)), [3, 1]);
    const pw = particleWeights(B.result, B.resolved);
    assert.equal(pw.length, 31); assert.equal(pw.reduce((a, b) => a + b, 0), 73);
    // histogram weights: the weighted KE histogram counts 3 per on-axis ray
    const ke = Array.from({ length: B.result.n }, (_, i) => B.result.summary[i * L.S_STRIDE + L.S_KE0]);
    const hw = histogram(ke, { bins: 1, weights: pw }), hu = histogram(ke, { bins: 1 });
    assert.equal(hu.counts[0], 31); assert.equal(hw.counts[0], 73);
});

// ---------------------------------------------------------------- source from end states (reverse flight)

test('Source from end states: the reversed T6 lens rays return to their start points within 1e-6 R through the project path', () => {
    const p = caseProject('T6', 'quick');   // zero-gap einzel, R = 1 mm, rtol 1e-12, 8 rays to the end plane at x = 3.5
    assert.ok(p && p.tracer.custom && p.tracer.custom.rtol === 1e-12);
    const fwd = runProject(p);
    assert.equal(summarize(fwd.result, fwd.resolved).byStatus.DETECTED, fwd.result.n);
    const starts = new Map();
    const P = generate(fwd.resolved.sources, 0, fwd.resolved.particleCount, { relativistic: false });
    for (let i = 0; i < fwd.result.n; i++) starts.set(P[i * L.P_STRIDE + L.P_ID], [P[i * L.P_STRIDE + L.P_X], P[i * L.P_STRIDE + L.P_Y], P[i * L.P_STRIDE + L.P_Z]]);
    // what the Hits tab button does: a rows source of the reversed end states, the other sources disabled, then a run
    const src = endStatesSource(fwd.result, fwd.resolved, { reverse: true });
    assert.equal(src.type, 'rows'); assert.equal(src.rows.length, fwd.result.n); assert.deepEqual(src.origin, { particles: 8, reverse: true });
    assert.ok(src.rows.every((r) => r[9] === 0 && r[0] === 100 && r[1] === 1 && Math.abs(r[2] - 3.5) < 1e-9 && r[5] < 0), 'at the end plane, flying back, t0 reset');
    const q = clone(p);
    const added = addEndStatesSource(q, src, { disableOthers: true });
    assert.deepEqual(added, { id: 'rev1', disabled: 3 });
    assert.deepEqual(q.sources.map((s) => s.enabled !== false), [false, false, false, true]);
    const xs = starts.values().next().value[0];
    q.recording.planes = [{ id: 'start', name: 'Start plane', kind: 'x', at: xs, limits: null, radius: null, terminate: true, side: 'backward', record: 'first' }];
    assert.deepEqual(S.validate(q).errors, []);
    const back = runProject(q);
    assert.equal(back.result.n, fwd.result.n);
    let worst = 0;
    for (let i = 0; i < back.result.n; i++) {
        const o = i * L.S_STRIDE;
        assert.equal(back.result.summary[o + L.S_STATUS], L.STATUS.DETECTED, `ray ${i} reached the start plane`);
        const s0 = starts.get(i);   // the reversed rows keep the forward ids' order
        worst = Math.max(worst, Math.hypot(back.result.summary[o + L.S_Y] - s0[1], back.result.summary[o + L.S_Z] - s0[2]));
    }
    assert.ok(worst <= 1e-6, `max distance from the start point ${worst} mm (R = 1 mm)`);
    // the energy comes back too
    for (let i = 0; i < back.result.n; i++) assert.ok(Math.abs(back.result.summary[i * L.S_STRIDE + L.S_KE] - 1000) < 1e-5, 'KE 1000 eV at the start');
    // hand-off (not reversed) and a fresh id when the default one is taken
    const fwdSrc = endStatesSource(fwd.result, fwd.resolved, { reverse: false, t0: 2.5, ids: new Set([1, 3]) });
    assert.equal(fwdSrc.rows.length, 2); assert.ok(fwdSrc.rows.every((r) => r[5] > 0 && r[9] === 2.5)); assert.equal(fwdSrc.name, 'End states');
    const q2 = clone(q);
    assert.deepEqual(addEndStatesSource(q2, endStatesSource(fwd.result, fwd.resolved), { disableOthers: false }), { id: 'rev2', disabled: 0 });
    assert.equal(endStatesSource({ n: 0, summary: new Float64Array(0) }, fwd.resolved), null);
});
