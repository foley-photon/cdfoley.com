// WP-F physics plug-ins (improvement plan §4, package WP-F): space charge routed to coulomb.js (an onset estimator), hard-sphere
// gas collisions (gas.js) in the tracer, the Stokes-drag mobility helpers, the charge basis in the pipeline (WP-G handoff H1)
// and the job bookkeeping (H4). Every plug-in is off by default, so existing projects are untouched (the other suites and
// bench.mjs prove that); the gates here are the plan's P2, I2 and I4 plus T14 (determinism) with the gas on.
// Level: IONOPTICS_LEVEL=full runs I2 with 1000 particles (about 25 s); quick uses 250 (about 1.5 s).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../../beta/ion-optics/js/engine/pipeline.js';
import * as G from '../../beta/ion-optics/js/engine/gas.js';
import { traceCoulomb, coulombEnergy } from '../../beta/ion-optics/js/engine/coulomb.js';
import { traceParticles, mergeResults, traceOptions } from '../../beta/ion-optics/js/engine/trace.js';
import { createFieldModel } from '../../beta/ion-optics/js/engine/fieldmodel.js';
import { createHandler } from '../../beta/ion-optics/js/engine/worker-core.js';
import { resolve, validate } from '../../beta/ion-optics/js/engine/schema.js';
import { projectKeys } from '../../beta/ion-optics/js/engine/hash.js';
import { CHARGE_BASIS } from '../../beta/ion-optics/js/engine/operator.js';
import { combine } from '../../beta/ion-optics/js/engine/field.js';
import { Stream, uniform01 } from '../../beta/ion-optics/js/engine/rng.js';
import { estimateProject } from '../../beta/ion-optics/js/ui/jobs.js';
import { gasReadout, leadSpecies } from '../../beta/ion-optics/js/ui/panels/domain.js';
import { K_ACC, AMU_KG, E_CHARGE, EPS0, ME_U, ME_KG, speedFromKE } from '../../beta/ion-optics/js/engine/constants.js';
import * as L from '../../beta/ion-optics/js/engine/layout.js';
import { einzel, rfQuadrupole } from './fixtures/wp3/projects.mjs';

const FULL = process.env.IONOPTICS_LEVEL === 'full';
const TORR = 101325 / 760, KB = 1.380649e-23;
const { STATUS, STATUS_NAMES, S_STRIDE, C_STRIDE } = L;
const S = (r, i, f) => r.summary[i * S_STRIDE + f];
const relEq = (a, b, rel, msg = '') => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg}: ${a} vs ${b} (rel ${(a / b - 1).toExponential(2)})`);
const absEq = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (diff ${(a - b).toExponential(2)})`);
const sameArr = (a, b, what) => { assert.equal(a.length, b.length, what + ' length'); for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) assert.fail(`${what}: differs at ${i}: ${a[i]} vs ${b[i]}`); };
function statusCounts(result) { const out = {}; for (let i = 0; i < result.n; i++) { const s = STATUS_NAMES[S(result, i, L.S_STATUS)]; out[s] = (out[s] || 0) + 1; } return out; }

// ---------------------------------------------------------------- project builders (schema-valid, field-free planar boxes)
function proj(o) {
    return {
        format: 'ion-optics-project', version: 1,
        meta: { name: o.name || 'physics', notes: '', created: '2026-10-14T00:00:00Z', modified: '2026-10-14T00:00:00Z', engine: '0.1.0' },
        params: o.params || [],
        domain: { type: 'planar2d', cell: o.cell || 1, x: o.x, y: o.y,
            edges: { xmin: { bc: 'dirichlet', electrode: 'gnd' }, xmax: { bc: 'dirichlet', electrode: 'gnd' }, ymin: { bc: 'dirichlet', electrode: 'gnd' }, ymax: { bc: 'dirichlet', electrode: 'gnd' }, ...(o.edges || {}) },
            mirror: { x: false, y: false }, charge: o.charge || '', beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' } },
        electrodes: [{ id: 'gnd', name: 'Ground', ground: true, color: '#64748b' }, ...(o.electrodes || [])],
        shapes: (o.shapes || []).map((s, i) => ({ id: 's' + (i + 1), enabled: true, locked: false, ...s })),
        magnets: [], idealFields: o.ideal || [],
        sources: o.sources || [],
        recording: { planes: o.planes || [], trajectories: { store: o.store !== false, maxPoints: 2000 }, timeMarkers: null },
        tracer: { integrator: 'rk45', quality: o.quality || 'normal', custom: null, fieldInterp: 'cubic', relativistic: false, tMax: o.tMax || 1000, maxSteps: 500000, maxDrift: 10000,
            drag: o.drag || null, spaceCharge: o.spaceCharge || null, gas: o.gas || null },
        solver: { boundary: 'subgrid', method: 'auto', tol: 1e-10, maxCycles: 60, maxIterations: 200, maxSweeps: 100000 },
        analysis: { lens: null, scan: null, optimize: null, waist: null },
        view: { center: [0, 0], scale: 5, displayTime: 0, projection: 'xy', colormap: 'auto', contourLevels: null,
            layers: { potential: true, contours: 20, field: false, electrodes: true, trajectories: 'source', planes: true, hits: true, grid: 'auto', mirror: true, markers: false } },
    };
}
const beam = (n, mass, ke, extra = {}) => ({ id: 'b1', name: 'beam', enabled: true, color: 'auto', count: n, sampling: 'random', seed: 3,
    species: [{ label: `${mass} u`, mass, charge: 1, fraction: 1 }], position: { type: 'point', p: [0, 0, 0] }, direction: { type: 'fixed', dir: [1, 0, 0] },
    energy: { type: 'mono', ke }, time: { type: 'fixed', t: 0 }, ...extra });
const rowsSource = (rows) => ({ id: 'b1', name: 'list', enabled: true, color: 'auto', type: 'rows', weight: 1, species: [], velocity: false, rows });
const xPlane = (id, at, extra = {}) => ({ id, name: id, kind: 'x', at, limits: null, radius: null, terminate: false, side: 'both', record: 'first', ...extra });
/** B19 gas: He (2 Å) at 4 mTorr and 275 K; ions of 15 Å. */
const I4_GAS = { enabled: true, model: 'hardSphere', pressure: 4e-3 * TORR, temperature: 275, mass: 4.002602, diameter: 2, ionDiameter: 15, velocity: [0, 0, 0] };
/** Σ path, collisions and mean final KE of a run. */
function tally(out) {
    let path = 0, ke = 0, vx = 0;
    for (let i = 0; i < out.result.n; i++) { path += S(out.result, i, L.S_PATH); ke += S(out.result, i, L.S_KE); vx += S(out.result, i, L.S_VX); }
    return { path, coll: out.result.stats.collisions, keMean: ke / out.result.n, vxMean: vx / out.result.n, n: out.result.n };
}

// ================================================================ gas.js: pure functions and the collision kernel
test('gas.js: erf, the mean relative speed and its limits, number density, mobility helpers, diameter estimate, drag time', () => {
    absEq(G.erf(0.5), 0.5204998778, 2e-7, 'erf(0.5)'); absEq(G.erf(-1), -0.8427007929, 2e-7, 'erf(−1)'); absEq(G.erf(3), 0.9999779095, 2e-7, 'erf(3)');
    absEq(G.erf(0), 0, 2e-9, 'erf(0) (the A&S 7.1.26 residual)');
    const c = 1.3;
    relEq(G.meanRelativeSpeed(0, c), 2 * c / Math.sqrt(Math.PI), 1e-12, 'slow particle: the mean gas speed √(8kT/πm)');
    relEq(G.meanRelativeSpeed(1e-4 * c, c), 2 * c / Math.sqrt(Math.PI), 1e-7, 'continuous at the small-s switch');
    relEq(G.meanRelativeSpeed(200 * c, c), 200 * c * (1 + 1 / (2 * 200 * 200)), 1e-6, 'fast particle: its own speed');
    let last = 0;
    for (let s = 0; s <= 6; s += 0.05) { const g = G.meanRelativeSpeed(s * c, c); assert.ok(g >= last - 1e-12 && g >= s * c - 1e-12, 'monotone and ≥ speed'); last = g; }
    relEq(G.numberDensity(TORR, 273.15), 101325 / 760 / (KB * 273.15) * 1e-9, 1e-12, 'n = p/(kT) in mm⁻³');
    relEq(G.numberDensity(TORR, 273.15) * 1e9, 3.5353e22, 1e-4, 'Loschmidt at 1 Torr');
    relEq(G.mostProbableSpeed(275, 4.002602), Math.sqrt(2 * KB * 275 / (4.002602 * AMU_KG)) * 1e-3, 1e-12, 'most probable speed');
    const K = G.mobilityFromReduced(4.31, 1, 298);
    absEq(K, 3574, 0.5, 'B20: K₀ 4.31 at 1 Torr, 298 K gives K = 3574 (digits)');
    relEq(G.reducedMobility(K, 1, 298), 4.31, 1e-12, 'K₀ round trip');
    assert.ok(Number.isNaN(G.mobilityFromReduced(0, 1, 298)) && Number.isNaN(G.mobilityFromReduced(1, 0, 298)));
    // the rigid-sphere Chapman–Enskog mobility reproduces B20's K from its effective cross-section (C₆₀, 10.18 Å in He)
    const kCE = G.hardSphereMobility(720, { pressure: TORR, temperature: 298, mass: 4.002602, diameter: 2.2, ionDiameter: 10.18 });
    relEq(kCE, 3574, 0.05, 'Chapman–Enskog rigid spheres vs the B20 mobility');
    assert.ok(Number.isNaN(G.hardSphereMobility(720, null)));
    relEq(G.ionDiameterEstimate(200), Math.cbrt(6 * 200 * AMU_KG * 1e3 / Math.PI) * 1e8, 1e-12, 'density-1 sphere');
    assert.ok(G.ionDiameterEstimate(200) > 8 && G.ionDiameterEstimate(200) < 9.5, '200 u ≈ 8.6 Å');
    assert.ok(G.ionDiameterEstimate(720) > 12 && G.ionDiameterEstimate(720) < 14.5, 'C₆₀ ≈ 13 Å (measured 10.18)');
    relEq(G.dragTimeConstant(2, 100, 1), 1e-4 * 2 * 100 / K_ACC, 1e-12, 'τ = K_mob m/(K_ACC q): the D1 relaxation time');
    assert.equal(G.dragTimeConstant(2, 100, 0), Infinity);
});

test('gas.js collision kernel: cold partner gives |v′| within [(M−m)/(M+m), 1]·v and the mean energy loss 2mM/(M+m)²; warm partners are flux-weighted; streams are deterministic', () => {
    const M = 200, m = 4.002602;
    const cold = G.createGasModel({ pressure: 1, temperature: 1e-7, mass: m, diameter: 2, ionDiameter: 15, velocity: [0, 0, 0] });
    const sp = cold.species(M);
    assert.equal(sp.ionDiameter, 15); relEq(sp.sigma, Math.PI * 8.5 * 8.5 * 1e-14, 1e-12, 'σ = π d² in mm²'); relEq(sp.aG, m / (M + m), 1e-12);
    const v0 = speedFromKE(24, M, false), W = new Float64Array(3);
    const st = new Stream(9, G.GAS_A, 1, 1);
    let sumE = 0, n = 20000, lo = Infinity, hi = 0;
    for (let i = 0; i < n; i++) {
        W[0] = v0; W[1] = 0; W[2] = 0;
        cold.collide(sp, st, W, 0, false);
        const v = Math.hypot(W[0], W[1], W[2]);
        sumE += v * v / (v0 * v0); if (v < lo) lo = v; if (v > hi) hi = v;
    }
    const loss = 1 - sumE / n, exp = 2 * m * M / ((M + m) * (M + m));
    absEq(loss, exp, 1.5e-3, 'mean fractional energy loss per collision (isotropic center-of-mass scattering)');
    assert.ok(lo / v0 >= (M - m) / (M + m) - 1e-6 && hi / v0 <= 1 + 1e-6, `speed bounds ${lo / v0} … ${hi / v0}`);
    // warm gas: the partner distribution is weighted by the relative speed, so the sampled mean of g is ⟨g²⟩/⟨g⟩ = (v² + 3kT/m)/⟨g⟩
    const warm = G.createGasModel(I4_GAS), spw = warm.species(M);
    const gBar = G.meanRelativeSpeed(v0, warm.cmp);
    let sumG = 0;
    const st2 = new Stream(9, G.GAS_A, 2, 1);
    for (let i = 0; i < n; i++) { W[0] = v0; W[1] = 0; W[2] = 0; sumG += warm.collide(spw, st2, W, 0, false); }
    relEq(sumG / n, (v0 * v0 + 1.5 * warm.cmp * warm.cmp) / gBar, 0.01, 'flux-weighted partners: ⟨g⟩_sampled = ⟨g²⟩/⟨g⟩');
    assert.ok(sumG / n > gBar, 'and above the unweighted mean relative speed');
    // relativistic flag: identical kinematics at these speeds (γ − 1 ≈ 1e-10), and the same stream gives the same sequence
    const a = new Stream(9, G.GAS_A, 3, 1), b = new Stream(9, G.GAS_A, 3, 1), WA = new Float64Array([v0, 0, 0]), WB = new Float64Array([v0, 0, 0]);
    warm.collide(spw, a, WA, 0, false); warm.collide(spw, b, WB, 0, true);
    for (let k = 0; k < 3; k++) absEq(WA[k], WB[k], 1e-9 * v0, 'relativistic branch agrees at low speed');
    // the rate and the mean free path
    relEq(warm.rate(spw, v0, 0, 0), spw.nSigma * gBar, 1e-12, 'ν = nσ⟨g⟩');
    relEq(warm.meanFreePath(spw, v0), v0 / (spw.nSigma * gBar), 1e-12, 'λ(v) = v/ν');
    relEq(warm.summary(M).lambdaFast, 1 / spw.nSigma, 1e-12, 'fast-ion mean free path 1/(nσ)');
    // zero pressure: no collisions
    const off = G.createGasModel({ ...I4_GAS, pressure: 0 });
    assert.equal(off.rate(off.species(M), v0, 0, 0), 0);
});

// ================================================================ the tracer with the gas on
test('tracer with gas: a cold gas gives exponential free paths with λ = 1/(nσ) exactly (to 3σ) whatever the speed decay; energy diagnostics off; collisions counted', () => {
    // same n as I4 but T → 0: the gas is at rest, so ν = nσv and the free paths are exponential with mean 1/(nσ) at every speed
    const T = 1e-3, cold = { ...I4_GAS, temperature: T, pressure: I4_GAS.pressure * T / 275 };
    const lam0 = 1 / G.createGasModel(cold).species(200).nSigma;
    relEq(lam0, 3.1366, 1e-3, 'λ = kT/(π d² p) = 1/(nσ) for the B19 numbers');
    const v0 = speedFromKE(24, 200, false);
    const out = PL.runProject(proj({ x: [-100, 100], y: [-100, 100], cell: 1, tMax: 6 * lam0 / v0, gas: cold, store: false, sources: [beam(1000, 200, 24)] }));
    const t = tally(out);
    assert.ok(t.coll > 4000, `enough collisions for statistics: ${t.coll}`);
    relEq(t.path / t.coll, lam0, 3.5 / Math.sqrt(t.coll), `Σpath/Σcollisions over ${t.coll} collisions (3.5σ)`);
    assert.ok(t.keMean < 24 * Math.exp(-0.9 * 0.0385 * t.coll / t.n), 'the ions cool by about 3.85 % of their energy per collision');
    assert.ok(Number.isNaN(S(out.result, 0, L.S_DE_END)) && Number.isNaN(S(out.result, 0, L.S_DE_MAX)), 'no energy check with collisions');
    assert.equal(S(out.result, 0, L.S_FLAGS) & L.FLAG.BORIS, 0);
    assert.deepEqual(statusCounts(out.result), { TMAX: 1000 });
    assert.ok(out.result.stats.collisions === t.coll && out.result.stats.steps > 10 * t.coll, 'the step cap τ_mfp/10 gives at least ten steps per collision');
});

test('I4 (B19): 200 u, 15 Å ions at 24 eV in He (2 Å) at 4 mTorr, 275 K: mean free path 1/(nσ) = 3.14 mm within 5 %, KE → 3kT/2, velocity decay within 2× of the equivalent drag', () => {
    const m = G.createGasModel(I4_GAS), sp = m.species(200);
    const lam0 = 1 / sp.nSigma;                    // 3.1366 mm, the plan's 1/(nσ) = 3.1 mm
    const v0 = speedFromKE(24, 200, false), gBar = G.meanRelativeSpeed(v0, m.cmp);
    const lamKin = v0 / (sp.nSigma * gBar);        // the kinetic-theory mean free path at 24 eV: 3.061 mm (s = v0/c_mp = 4.5)
    relEq(lam0, 3.14, 0.01, 'the plan: λ = 1/(nσ) = 3.1 mm');
    // (a) mean free path over about two λ (the ions lose 2 % of their speed per collision, so λ(v) stays within 1 %)
    const run = PL.runProject(proj({ x: [-100, 100], y: [-100, 100], cell: 1, tMax: 2 * lam0 / v0, gas: I4_GAS, store: false, sources: [beam(2000, 200, 24)] }));
    const t = tally(run);
    const lamHat = t.path / t.coll;
    assert.ok(t.coll > 3000, `collisions ${t.coll}`);
    relEq(lamHat, lam0, 0.05, 'measured mean free path vs 1/(nσ)');
    relEq(lamHat, lamKin, 0.05, 'measured mean free path vs the kinetic-theory value v/(nσ⟨g⟩)');
    // (b) thermalization at 40 mTorr (the same physics, ten times faster): ⟨KE⟩ → 3kT/2 = 35.5 meV
    const hot = { ...I4_GAS, pressure: 40e-3 * TORR };
    const kT = KB * 275 / E_CHARGE;
    const th = PL.runProject(proj({ x: [-200, 200], y: [-200, 200], cell: 2, tMax: 60, gas: hot, store: false, sources: [beam(150, 200, 24)] }));
    const tt = tally(th);
    assert.ok(tt.coll / tt.n > 200, `collisions per ion ${tt.coll / tt.n}`);
    relEq(tt.keMean, 1.5 * kT, 0.15, '⟨KE⟩ after thermalization vs 3kT/2 (150 ions: 1σ ≈ 5 %)');
    assert.deepEqual(statusCounts(th.result), { TMAX: 150 });
    // (c) drag equivalence: the hard-sphere momentum-transfer rate ν_m = nσ⟨g⟩(v0)·m_g/(M + m_g) is a Stokes drag with K_eq = e/(M ν_m)
    const nuM = m.rate(sp, v0, 0, 0) * sp.aG, Keq = K_ACC / (nuM * 200) * 1e4;
    const t1 = 1 / nuM;
    const hs = PL.runProject(proj({ x: [-300, 300], y: [-300, 300], cell: 2, tMax: t1, gas: I4_GAS, store: false, sources: [beam(400, 200, 24)] }));
    const dr = PL.runProject(proj({ x: [-300, 300], y: [-300, 300], cell: 2, tMax: t1, drag: { type: 'stokes', mobility: Keq, gasVelocity: [0, 0, 0] }, store: false, sources: [beam(1, 200, 24)] }));
    const th1 = tally(hs), vDrag = S(dr.result, 0, L.S_VX);
    relEq(vDrag, v0 * Math.exp(-1), 1e-6, 'the drag run decays by e over τ_m');
    const rateHS = Math.log(v0 / th1.vxMean) / t1;
    assert.ok(rateHS / nuM > 0.5 && rateHS / nuM < 2, `hard-sphere decay rate ${rateHS.toFixed(4)} vs ν_m ${nuM.toFixed(4)} (ratio ${(rateHS / nuM).toFixed(3)}; within 2×)`);
    assert.ok(th1.vxMean / vDrag > 0.5 && th1.vxMean / vDrag < 2, `⟨v_x⟩ after τ_m: hard sphere ${th1.vxMean.toFixed(4)} vs drag ${vDrag.toFixed(4)} (within 2×)`);
    const perColl = Math.log(v0 / th1.vxMean) / (th1.coll / th1.n);
    assert.ok(perColl / sp.aG > 0.5 && perColl / sp.aG < 2, `velocity loss per collision ${perColl.toFixed(4)} vs m_g/(M + m_g) = ${sp.aG.toFixed(4)} (within 2×)`);
    assert.ok(rateHS < nuM, 'the hard-sphere decay is slower than the initial-rate drag (the rate falls with the speed)');
    // the drag run keeps the same gas-velocity semantics as before: D1's terminal velocity through traceOptions
    const d1 = proj({ x: [0, 10], y: [-2, 2], cell: 0.5, tMax: 50 * 1e-4 * 2 * 100 / K_ACC, edges: { xmin: { bc: 'dirichlet', electrode: 'plate' }, ymin: { bc: 'neumann' }, ymax: { bc: 'neumann' } },
        electrodes: [{ id: 'plate', name: 'plate', kind: 'solid', v: 240, wave: null, color: '#2563eb' }], drag: { type: 'stokes', mobility: 2, gasVelocity: [0, 0, 0] }, store: false,
        sources: [{ ...beam(1, 100, 0), position: { type: 'point', p: [1, 0, 0] } }], quality: 'fine' });
    relEq(S(PL.runProject(d1).result, 0, L.S_VX), 1e-4 * 2 * 24, 1e-6, 'D1 terminal velocity KE = 4.8e-3 mm/µs');
});

test('thermal ions of the gas mass: the ensemble mean free path is 1/(√2 nσ) within 5 % (the textbook formula in its regime)', () => {
    const gas = { ...I4_GAS, pressure: 40e-3 * TORR, ionDiameter: 2 };   // He⁺ in He
    const sp = G.createGasModel(gas).species(4.002602);
    const kT = KB * 275 / E_CHARGE;
    const out = PL.runProject(proj({ x: [-200, 200], y: [-200, 200], cell: 2, tMax: 60, gas, store: false,
        sources: [beam(600, 4.002602, 1.5 * kT, { direction: { type: 'isotropic' } })] }));
    const t = tally(out);
    assert.ok(t.coll > 8000, `collisions ${t.coll}`);
    relEq(t.path / t.coll, 1 / (Math.SQRT2 * sp.nSigma), 0.05, 'Σpath/Σcollisions vs kT/(√2 π d² p)');
    relEq(t.keMean, 1.5 * kT, 0.1, 'the ensemble stays thermal');
});

test('T14 with the gas on: chunks of 1, 7 and 64 particles merge bitwise into one pass (summaries, crossings, trajectories, markers, collision count)', () => {
    const gas = { ...I4_GAS, pressure: 40e-3 * TORR };
    const p = proj({ x: [-100, 100], y: [-100, 100], cell: 1, tMax: 3, gas,
        sources: [beam(150, 200, 24, { direction: { type: 'cone', axis: [1, 0, 0], halfAngle: 20 } })], planes: [xPlane('p', 5, { record: 'all' })] });
    const r = PL.resolveOrThrow(p);
    const f = PL.buildField(r, PL.solveProject(r));
    const ov = { record: { trajectories: true, markersDt: 0.5 } };
    const whole = PL.traceProject(r, f, { overrides: ov });
    assert.ok(whole.stats.collisions > 1000, `collisions ${whole.stats.collisions}`);
    assert.ok(whole.markers && whole.markers.length > 0);
    const N = r.particleCount;
    for (const B of [1, 7, 64]) {
        const parts = [];
        for (let i0 = 0; i0 < N; i0 += B) parts.push(PL.traceProject(r, f, { i0, i1: Math.min(N, i0 + B), overrides: ov }));
        const m = mergeResults(parts.reverse());
        sameArr(m.summary, whole.summary, 'summary B=' + B);
        sameArr(m.crossings, whole.crossings, 'crossings B=' + B);
        sameArr(m.traj.offsets, whole.traj.offsets, 'offsets B=' + B);
        sameArr(m.traj.pts, whole.traj.pts, 'points B=' + B);
        sameArr(m.markers, whole.markers, 'markers B=' + B);
        assert.equal(m.stats.collisions, whole.stats.collisions, 'collisions B=' + B);
    }
    // the same run twice is identical (counter-based streams), and a different seed is not
    const again = PL.traceProject(r, f, { overrides: ov });
    sameArr(again.summary, whole.summary, 'repeat');
    const r2 = PL.resolveOrThrow({ ...p, tracer: { ...p.tracer, seed: 2 } });
    assert.notDeepEqual(PL.traceProject(r2, PL.buildField(r2, PL.solveProject(r2)), { overrides: ov }).summary, whole.summary, 'another seed changes the collisions');
});

test('defaults off: traceOptions carries gas: null; pressure 0 or enabled: false is the same code path as no gas (bitwise); the Boris choice yields to the gas', () => {
    const r = resolve(einzel()).resolved;
    const o = traceOptions(r);
    assert.equal(o.gas, null); assert.equal(o.drag, null);
    assert.equal(PL.spaceChargeOf(r), null);
    const base = proj({ x: [-100, 100], y: [-100, 100], cell: 1, tMax: 2, sources: [beam(40, 200, 24, { direction: { type: 'cone', axis: [1, 0, 0], halfAngle: 20 } })], planes: [xPlane('p', 5)] });
    const ref = PL.runProject(base).result;
    const zero = PL.runProject({ ...base, tracer: { ...base.tracer, gas: { ...I4_GAS, pressure: 0 } } }).result;
    sameArr(zero.summary, ref.summary, 'pressure 0'); sameArr(zero.traj.pts, ref.traj.pts, 'pressure 0 trajectories');
    assert.equal(zero.stats.collisions, 0);
    const off = PL.runProject({ ...base, tracer: { ...base.tracer, gas: { ...I4_GAS, enabled: false } } }).result;
    sameArr(off.summary, ref.summary, 'enabled: false');
    // with gas, a magnetic run that would pick Boris integrates with Dormand–Prince instead
    const model = createFieldModel({ resolved: { domain: { type: 'planar2d', cell: 10, h: 10, x: [-400, 400], y: [-400, 400], nx: 81, ny: 81, mirror: { x: false, y: false }, beyond: {} },
        electrodes: [{ id: 'gnd' }], magnets: [{ type: 'uniform', B: [0, 0, 0.5] }], idealFields: [] } });
    assert.ok(model.hasB && model.bMax > 0);
    const row = new Float64Array(L.P_STRIDE);
    row[L.P_MASS] = 100; row[L.P_CHARGE] = 1; row[L.P_WX] = speedFromKE(1000, 100, false); row[L.P_KE] = 1000;
    const T = 1 / (K_ACC * 0.5 / 100 / (2 * Math.PI));   // gyration period, µs
    const g = traceParticles(model, row, { relativistic: false, tMax: 60 * T, gas: { ...I4_GAS, pressure: 1e-9 }, record: { trajectories: false } });
    assert.equal(S(g, 0, L.S_FLAGS) & L.FLAG.BORIS, 0, 'no Boris with the gas on');
    const b = traceParticles(model, row, { relativistic: false, tMax: 60 * T, record: { trajectories: false } });
    assert.ok((S(b, 0, L.S_FLAGS) & L.FLAG.BORIS) !== 0, 'Boris without it (long magnetic run: tMax/T_gyr > 50)');
});

// ================================================================ space charge: P2 and I2 through the pipeline
test('P2 end to end: two protons from rest 1 µm apart (tracer.spaceCharge, ε = 1e-7 mm) reach 0.719982 meV each through runProject and the worker handler', () => {
    const mp = 1.0072764665789;
    const p = proj({ x: [-500, 500], y: [-500, 500], cell: 1, tMax: 300, quality: 'fine', store: false,
        sources: [rowsSource([[mp, 1, -0.0005, 0, 0, 1, 0, 0, 0, 0], [mp, 1, 0.0005, 0, 0, 1, 0, 0, 0, 0]])],
        spaceCharge: { enabled: true, model: 'coulomb', softening: 1e-7, maxParticles: 2000, factor: 1 } });
    assert.deepEqual(validate(p).errors, []);
    const out = PL.runProject(p);
    const R = out.result;
    assert.equal(R.stats.lockstep, true, 'routed to the lockstep space-charge tracer');
    const xs = [S(R, 0, L.S_X), S(R, 0, L.S_Y), S(R, 0, L.S_Z), S(R, 1, L.S_X), S(R, 1, L.S_Y), S(R, 1, L.S_Z)];
    const U = coulombEnergy(xs, [1, 1], 1e-7), U0 = coulombEnergy([-0.0005, 0, 0, 0.0005, 0, 0], [1, 1], 1e-7);
    relEq(U0, 1.439964e-3, 1e-6, 'initial interaction energy 1.439964 meV');
    const per = (S(R, 0, L.S_KE) + U / 2) * 1e3;
    absEq(per, 0.719982, 5e-7, 'asymptotic energy per proton, meV (half a unit in the last printed digit)');
    relEq(S(R, 0, L.S_KE) + S(R, 1, L.S_KE) + U, U0, 1e-6, 'energy conserved');
    absEq(S(R, 0, L.S_X), -S(R, 1, L.S_X), 1e-9, 'symmetric');
    assert.deepEqual(statusCounts(R), { TMAX: 2 });
    assert.equal(out.summary.launched, 2);
    // the worker core routes the same run: setField + trace by range equals runProject bitwise
    const r = PL.resolveOrThrow(p), keys = projectKeys(r);
    const msgs = [];
    const handle = createHandler({ post: (m) => msgs.push(m) });
    handle({ v: 1, type: 'solve', id: 1, geomKey: keys.geomKey, resolved: r, electrodes: [], wantRaster: true });
    handle({ v: 1, type: 'setField', fieldKey: keys.fieldKey, runKey: keys.runKey, geomKey: keys.geomKey, resolved: r });
    handle({ v: 1, type: 'trace', id: 2, fieldKey: keys.fieldKey, runKey: keys.runKey, range: [0, r.particleCount] });
    const tr = msgs.find((m) => m.type === 'traceResult');
    assert.ok(tr, JSON.stringify(msgs.map((m) => [m.type, m.message])));
    sameArr(tr.result.summary, R.summary, 'worker result');
    // the plug-in is honest about its limits: more than the cap is refused by the schema
    const big = { ...p, sources: [beam(2001, mp, 0)] };
    assert.ok(validate(big).errors.some((e) => e.path === 'tracer.spaceCharge.maxParticles' && e.code === 'E_LIMIT'));
    // pair step from the accuracy preset: normal is coarser than fine but still within 2e-5
    const normal = PL.runProject({ ...p, tracer: { ...p.tracer, quality: 'normal' } }).result;
    relEq((S(normal, 0, L.S_KE) + coulombEnergy([S(normal, 0, L.S_X), 0, 0, S(normal, 1, L.S_X), 0, 0], [1, 1], 1e-7) / 2) * 1e3, 0.719982, 2e-5, 'normal accuracy');
    assert.ok(normal.stats.steps < R.stats.steps);
    assert.deepEqual([PL.PAIR_STEP.draft, PL.PAIR_STEP.normal, PL.PAIR_STEP.fine], [0.05, 0.02, 0.005]);
});

test('I2 (B12) beam spread: 1 eV electrons, R₀ 3 mm, tan θ 0.3 converging, 3.47e-13 C born over 0.1 µs: minimum envelope radius 1.28 mm ± 25 % (laminar theory 1.275)', { timeout: 180000 }, () => {
    const N = FULL ? 1000 : 250, eps = FULL ? 0.1 : 0.25;
    const Qtot = 3.47e-13, R0 = 3, F = R0 / 0.3, tBirth = 0.1;
    const rows = [];
    for (let i = 0; i < N; i++) {
        const r = R0 * Math.sqrt(uniform01(11, 1, i, 1)), phi = 2 * Math.PI * uniform01(11, 1, i, 2), t0 = tBirth * uniform01(11, 1, i, 3);
        const y = r * Math.cos(phi), z = r * Math.sin(phi), d = Math.hypot(F, y, z);
        rows.push([ME_U, -1, 0, y, z, F / d, -y / d, -z / d, 1, t0]);   // aimed at the geometric focus (10, 0, 0)
    }
    const planes = [];
    for (let x = 2; x <= 16 + 1e-9; x += 0.5) planes.push(xPlane('p' + planes.length, +x.toFixed(3), { side: 'forward' }));
    const factor = Qtot / E_CHARGE / N;
    const p = proj({ x: [-5, 100], y: [-20, 20], cell: 2, tMax: 2, store: false, sources: [rowsSource(rows)], planes,
        spaceCharge: { enabled: true, model: 'coulomb', softening: eps, maxParticles: 2000, factor } });
    assert.deepEqual(validate(p).errors, []);
    const envelope = (result) => planes.map((_, k) => {
        let n = 0, sy = 0, sz = 0, syy = 0, szz = 0;
        for (let c = 0; c < result.nCross; c++) {
            const b = c * C_STRIDE;
            if (result.crossings[b + L.C_KIND] !== 0 || result.crossings[b + L.C_PLANE] !== k) continue;
            const y = result.crossings[b + L.C_Y], z = result.crossings[b + L.C_Z];
            n++; sy += y; sz += z; syy += y * y; szz += z * z;
        }
        return n < 2 ? NaN : Math.sqrt(2 * (syy / n - (sy / n) ** 2 + szz / n - (sz / n) ** 2));   // uniform disc: R = √2 r_rms
    });
    const out = PL.runProject(p);
    assert.equal(out.result.stats.lockstep, true);
    assert.deepEqual(statusCounts(out.result), { EXIT: N }, 'every electron leaves through x = 100');
    const env = envelope(out.result);
    let rMin = Infinity, xMin = NaN;
    env.forEach((e, k) => { if (e < rMin) { rMin = e; xMin = planes[k].at; } });
    // Reiser §4.2: R′² = R₀′² + 2K ln(R/R₀), K = I e/(2π ε₀ m v³); R_min = R₀ exp(−tan²θ/(2K)) = 1.2748 mm for I = 3.47 µA
    const v = Math.sqrt(2 * E_CHARGE / ME_KG), I = Qtot / (tBirth * 1e-6), Kp = I * E_CHARGE / (2 * Math.PI * EPS0 * ME_KG * v ** 3);
    const rTheory = R0 * Math.exp(-0.09 / (2 * Kp));
    absEq(rTheory, 1.28, 0.01, 'the plan\'s R₀/2.35');
    assert.ok(rMin >= 0.96 && rMin <= 1.60, `minimum envelope radius ${rMin.toFixed(3)} mm at x = ${xMin} (band 1.28 ± 25 %; N = ${N}, ε = ${eps})`);
    relEq(rMin, rTheory, 0.1, 'within 10 % of the laminar envelope value');
    assert.ok(xMin > 5 && xMin < 12, `waist before the geometric focus at 10 mm: ${xMin}`);
    assert.ok(env[0] > 2.3 && env[env.length - 1] > rMin, 'the envelope converges, reaches the waist and diverges again');
    // without space charge the same beam focuses to a point
    const free = PL.runProject({ ...p, tracer: { ...p.tracer, spaceCharge: null } });
    assert.ok(Math.min(...envelope(free.result).filter((e) => e === e)) < 0.05, 'geometric focus without the pair forces');
});

test('coulomb.js plug-ins: charge factor scales the pair force, drag and gas act in the lockstep integrator, progress is reported', () => {
    const model = createFieldModel({ resolved: { domain: { type: 'planar2d', cell: 1, h: 1, x: [-500, 500], y: [-500, 500], nx: 1001, ny: 1001, mirror: { x: false, y: false }, beyond: {} }, electrodes: [{ id: 'gnd' }], magnets: [], idealFields: [] } });
    const mp = 1.0072764665789;
    const rows = (q) => { const P = new Float64Array(2 * L.P_STRIDE); for (let i = 0; i < 2; i++) { const o = i * L.P_STRIDE; P[o + L.P_ID] = i; P[o + L.P_MASS] = mp; P[o + L.P_CHARGE] = q; P[o + L.P_X] = i ? 0.0005 : -0.0005; } return P; };
    const one = traceCoulomb(model, rows(1), { relativistic: false, tMax: 50, softening: 1e-7, pairStep: 0.02, record: { trajectories: false } });
    const four = traceCoulomb(model, rows(1), { relativistic: false, tMax: 50, softening: 1e-7, pairStep: 0.02, factor: 4, record: { trajectories: false } });
    const two = traceCoulomb(model, rows(2), { relativistic: false, tMax: 50, softening: 1e-7, pairStep: 0.02, record: { trajectories: false } });
    relEq(S(four, 0, L.S_KE), 4 * S(one, 0, L.S_KE), 2e-4, 'factor 4 multiplies the released energy by 4 (the partner charge once)');
    relEq(S(two, 0, L.S_KE), 4 * S(one, 0, L.S_KE), 2e-4, 'charge 2 on both: q_i q_j = 4');
    // Stokes drag inside the lockstep integrator: the terminal velocity K_mob·E of an ion in a uniform field
    const E = createFieldModel({ resolved: { domain: { type: 'planar2d', cell: 1, h: 1, x: [-500, 500], y: [-500, 500], nx: 1001, ny: 1001, mirror: { x: false, y: false }, beyond: {} }, electrodes: [{ id: 'gnd' }], magnets: [], idealFields: [{ type: 'uniformE', E: [10, 0, 0] }] } });
    const single = new Float64Array(L.P_STRIDE); single[L.P_MASS] = 100; single[L.P_CHARGE] = 1;
    const tau = 1e-4 * 2000 * 100 / K_ACC;   // 0.207 µs
    const d = traceCoulomb(E, single, { relativistic: false, tMax: 40 * tau, drag: { type: 'stokes', mobility: 2000, gasVelocity: [0, 0, 0] }, record: { trajectories: false } });
    relEq(S(d, 0, L.S_VX), 1e-4 * 2000 * 10, 1e-6, 'terminal velocity K_mob·E in the lockstep integrator');
    assert.ok(d.stats.steps >= 40 * 10, 'the step is capped at a tenth of the drag time constant');
    // gas in the lockstep integrator: collisions counted, mean free path right within statistics (cold gas, exact rate by construction)
    const cold = { ...I4_GAS, temperature: 1e-3, pressure: I4_GAS.pressure * 1e-3 / 275 };
    const lam0 = 1 / G.createGasModel(cold).species(200).nSigma, v0 = speedFromKE(24, 200, false);
    const n = 300, P = new Float64Array(n * L.P_STRIDE);
    for (let i = 0; i < n; i++) { const o = i * L.P_STRIDE; P[o + L.P_ID] = i; P[o + L.P_MASS] = 200; P[o + L.P_CHARGE] = 1; P[o + L.P_Y] = (i % 30) * 10 - 145; P[o + L.P_Z] = Math.floor(i / 30) * 10 - 45; P[o + L.P_WX] = v0; P[o + L.P_KE] = 24; }
    let progress = 0;
    const g = traceCoulomb(model, P, { relativistic: false, tMax: 4 * lam0 / v0, gas: cold, softening: 1e3, factor: 0, record: { trajectories: false } }, { onProgress: () => progress++, progressEveryMs: 1 });
    let path = 0; for (let i = 0; i < n; i++) path += S(g, i, L.S_PATH);
    assert.ok(g.stats.collisions > 800, `collisions ${g.stats.collisions}`);
    relEq(path / g.stats.collisions, lam0, 4 / Math.sqrt(g.stats.collisions), 'mean free path in the lockstep integrator (4σ; the collision rate is exact, the collision lags by at most one step)');
    assert.ok(progress >= 1, 'progress reported');
    assert.ok(g.stats.steps >= 10 * g.stats.collisions / n, 'cap at a tenth of the mean free time');
});

// ================================================================ the charge basis (WP-G handoff H1) and the job bookkeeping (H4)
test('H1: a charge density adds CHARGE_BASIS to the solve; the DC channel weights it 1 and the time channels 0; projects without it are unchanged', () => {
    const q = rfQuadrupole();
    const rfBase = resolve(q).resolved;
    assert.deepEqual(PL.basisElectrodes(rfBase), [1, 2]);
    assert.equal(PL.hasChargeDensity(rfBase), false);
    q.domain.charge = 'rho0';
    q.params.push({ name: 'rho0', value: 2e-6, dim: 'none', note: 'C/m³' });
    const r = resolve(q);
    assert.deepEqual(r.errors, []);
    const rr = r.resolved;
    assert.ok(PL.hasChargeDensity(rr));
    assert.deepEqual(PL.basisElectrodes(rr), [1, 2, CHARGE_BASIS]);
    assert.deepEqual(PL.basisElectrodes({ domain: { charge: '   ' }, electrodes: [{ id: 'gnd' }, { id: 'a' }] }), [1], 'a blank expression is no charge density');
    const solved = PL.solveProject(rr);
    assert.deepEqual([...solved.bases.keys()].sort((a, b) => a - b), [CHARGE_BASIS, 1, 2]);
    const N = rr.domain.N, rho = solved.bases.get(CHARGE_BASIS);
    assert.ok(rho.some((v) => v !== 0) && rho.every(Number.isFinite), 'the particular solution is non-trivial');
    const f = PL.buildField(rr, solved);
    assert.equal(f.channels.length, 2, 'DC and one RF channel');
    const dcExp = combine(solved.bases, (k) => (k < 0 ? 1 : f.dc[k]), N);
    sameArr(f.channels[0].phi, dcExp, 'DC channel = Σ V_k φ_k + φ_ρ');
    const electrodesOnly = new Map([[1, solved.bases.get(1)], [2, solved.bases.get(2)]]);
    sameArr(f.channels[1].phi, combine(electrodesOnly, f.timeChannels[0].amp, N), 'the RF channel excludes the charge basis');
    // the particular solution raises the potential in the free space (positive charge, grounded box)
    const phi = new Float64Array(4);
    f.model.E(0, 2, 2, 0, phi);
    const f0 = PL.buildField(rfBase, PL.solveProject(rfBase));
    const phi0 = new Float64Array(4);
    f0.model.E(0, 2, 2, 0, phi0);
    assert.ok(phi[3] > phi0[3], 'positive space charge raises φ at the same point and time');
    // solveProject with explicit electrodes still honours the list
    assert.deepEqual([...PL.solveProject(rr, { electrodes: [CHARGE_BASIS] }).bases.keys()], [CHARGE_BASIS]);
});

test('H4 and space-charge planning: estimateProject counts the charge basis, plans space-charge runs on one worker with the pair cost; previews scale the charge factor', () => {
    const r0 = resolve(einzel()).resolved;
    const e0 = estimateProject(r0, { workers: 1 });
    assert.equal(e0.bases, 2); assert.equal(e0.spaceCharge, false);
    const q = einzel();
    q.domain.charge = '1e-6';
    const rc = resolve(q);
    assert.deepEqual(rc.errors, []);
    const ec = estimateProject(rc.resolved, { workers: 1 });
    assert.equal(ec.bases, 3, 'one more basis for the Poisson term');
    assert.ok(ec.solveMs > e0.solveMs && ec.memMB > e0.memMB, `the estimate counts the extra basis: ${ec.solveMs} vs ${e0.solveMs} ms, ${ec.memMB} vs ${e0.memMB} MB`);
    const s = einzel();
    s.tracer.spaceCharge = { enabled: true, softening: 0.1, factor: 10 };
    const rs = resolve(s);
    assert.deepEqual(rs.errors, []);
    const es = estimateProject(rs.resolved, { workers: 7 });
    assert.ok(es.spaceCharge && es.traceWorkers === 1, 'one trace worker');
    assert.ok(es.warnings.some((w) => w.code === 'W_SPACE_CHARGE' && /onset estimator/.test(String(w))));
    const big = { ...rs.resolved, particleCount: 2000 };
    const eb = estimateProject(big, { workers: 7 });
    assert.ok(eb.runMs > 50 * es.runMs, `pair cost grows with n²: ${es.runMs.toFixed(1)} ms for 21, ${eb.runMs.toFixed(0)} ms for 2000`);
    // the coulomb options: softening and factor from the project, pair step from the preset, factorScale from an override (previews)
    const co = PL.coulombOptions(rs.resolved, traceOptions(rs.resolved, { factorScale: 4 }));
    assert.equal(co.softening, 0.1); assert.equal(co.factor, 40); assert.equal(co.pairStep, PL.PAIR_STEP.normal);
    assert.equal(PL.coulombOptions(rs.resolved, traceOptions(rs.resolved)).factor, 10);
    s.tracer.spaceCharge.pairStep = 0.03;
    assert.equal(PL.coulombOptions(resolve(s).resolved, {}).pairStep, 0.03, 'an explicit pairStep is honored');
    // analysis rays (explicit rows with the override spaceCharge: false) measure the field without the pair forces
    const mp = 1.0072764665789;
    const two = proj({ x: [-500, 500], y: [-500, 500], cell: 1, tMax: 50, store: false,
        sources: [rowsSource([[mp, 1, -0.0005, 0, 0, 1, 0, 0, 0, 0], [mp, 1, 0.0005, 0, 0, 1, 0, 0, 0, 0]])],
        spaceCharge: { enabled: true, model: 'coulomb', softening: 1e-7, maxParticles: 2000, factor: 1 } });
    const rt = PL.resolveOrThrow(two), ft = PL.buildField(rt, PL.solveProject(rt));
    const withSc = PL.traceProject(rt, ft), without = PL.traceProject(rt, ft, { overrides: { spaceCharge: false } });
    assert.equal(withSc.stats.lockstep, true); assert.ok(S(withSc, 0, L.S_KE) > 1e-4, 'the protons repel');
    assert.ok(!without.stats.lockstep && S(without, 0, L.S_KE) === 0 && S(without, 0, L.S_X) === -0.0005, 'without the pair forces they stay at rest');
});

test('Domain panel helpers: gasReadout names the diameter in use, 1/(nσ) and the rigid-sphere mobility; leadSpecies picks the first enabled source', () => {
    const r = resolve(einzel()).resolved;
    assert.deepEqual(leadSpecies(r), { mass: 100, charge: 1, label: 'm/z 100' });
    assert.equal(leadSpecies({ sources: [{ enabled: false, species: [{ mass: 5 }] }] }), null);
    const lines = gasReadout(I4_GAS, { mass: 200, charge: 1, label: '200 u' });
    assert.equal(lines.length, 3);
    assert.match(lines[0], /collision diameter 15 Å/); assert.ok(!/estimated/.test(lines[0]));
    assert.match(lines[1], /1\/\(nσ\) = 3\.137 mm/);
    assert.match(lines[2], /cm²\/\(V·s\)/);
    const est = gasReadout({ ...I4_GAS, ionDiameter: null }, { mass: 200, charge: 1, label: '200 u' });
    assert.match(est[0], /estimated from the mass/);
    assert.deepEqual(gasReadout(null, null), []);
    assert.match(gasReadout({ ...I4_GAS, pressure: 0 }, null)[0], /Pressure 0/);
});
