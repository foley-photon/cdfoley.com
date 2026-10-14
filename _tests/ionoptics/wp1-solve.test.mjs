// WP1 solvers (spec 3.4, 3.5, 7.2 acceptance 4): S7 superposition, S8 agreement of the forced methods, S9 thin
// features on off-lattice levels, Carre adaptive SOR on the einzel of the SOR study, estimate quality, the
// fallback chain with a broken coarse level, hooks and cancellation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileGeometry } from '../../beta/ion-optics/js/engine/geometry.js';
import { buildHierarchy, basisSetup, newRhs } from '../../beta/ion-optics/js/engine/operator.js';
import { solveBasis, solveVoltages, multigridSolve, bicgstabMG, carreSOR, omegaBox, estimate } from '../../beta/ion-optics/js/engine/solve.js';

const maxDiff = (a, b) => { let m = 0; for (let k = 0; k < a.length; k++) { const d = Math.abs(a[k] - b[k]); if (d > m) m = d; } return m; };
function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// thin-wall einzel: walls 0.4 cell thick between nodes, three electrodes, ramp-closed top edge
function einzelThin() {
    return {
        domain: { type: 'cyl2d', h: 1, x: [-128, 128], y: [0, 48], nx: 257, ny: 49,
            edges: { xmin: { bc: 'dirichlet', electrode: 'a' }, xmax: { bc: 'dirichlet', electrode: 'c' }, ymin: { bc: 'axis' },
                ymax: { bc: 'profile', segments: [{ from: -128, to: -20, electrode: 'a' }, { from: -20, to: 20, ramp: ['a', 'c'] }, { from: 20, to: 128, electrode: 'c' }] } } },
        electrodes: [{ id: 'gnd' }, { id: 'a' }, { id: 'b' }, { id: 'c' }],
        shapes: [
            { type: 'tube', electrode: 'a', x0: -120, x1: -10.5, rIn: 20.3, rOut: 20.7 },
            { type: 'tube', electrode: 'b', x0: -8.5, x1: 8.5, rIn: 20.3, rOut: 20.7 },
            { type: 'tube', electrode: 'c', x0: 10.5, x1: 120, rIn: 20.3, rOut: 20.7 },
        ],
    };
}
// S9: 404 x 98 two-aperture lens, plates 0.3 cell between nodes and 1 cell off-lattice; xmax Dirichlet and
// ymax Neumann both off the coarse lattices (403 and 97 intervals)
function s9Fixture() {
    return {
        domain: { type: 'cyl2d', h: 1, x: [-200, 203], y: [0, 97], nx: 404, ny: 98,
            edges: { xmin: { bc: 'dirichlet', electrode: 'A' }, xmax: { bc: 'dirichlet', electrode: 'B' }, ymin: { bc: 'axis' }, ymax: { bc: 'neumann' } } },
        electrodes: [{ id: 'gnd' }, { id: 'A' }, { id: 'B' }],
        shapes: [{ type: 'box', electrode: 'A', x0: -9.65, x1: -9.35, y0: 16, y1: 97 }, { type: 'box', electrode: 'B', x0: 8.5, x1: 9.5, y0: 16, y1: 97 }],
    };
}
// the einzel of the adaptive-SOR study (S = 1, 417 x 71, node-aligned walls)
function carreEinzel() {
    return {
        domain: { type: 'cyl2d', h: 1, x: [-208, 208], y: [0, 70], nx: 417, ny: 71, edges: {} },
        electrodes: [{ id: 'gnd' }, { id: 'outer' }, { id: 'centre' }],
        shapes: [{ type: 'box', electrode: 'centre', x0: -20, x1: 20, y0: 40, y1: 42 }, { type: 'box', electrode: 'outer', x0: -188, x1: -28, y0: 40, y1: 42 }, { type: 'box', electrode: 'outer', x0: 28, x1: 188, y0: 40, y1: 42 }],
    };
}
const cache = new Map();
function hierarchy(name, make) {
    if (!cache.has(name)) { const res = make(); const geo = compileGeometry(res); cache.set(name, { res, geo, H: buildHierarchy(geo, res, {}) }); }
    return cache.get(name);
}

test('S7 superposition: direct solve equals the weighted basis sum to 1e-9 max|V| (ramps included)', () => {
    const { H } = hierarchy('einzel', einzelThin);
    assert.ok(H[0].raster.mix.count > 0, 'ramp nodes present');
    const bases = new Map();
    for (const k of [1, 2, 3]) {
        const { phi, stats } = solveBasis(H, k, { tol: 1e-12 });
        assert.ok(stats.converged);
        bases.set(k, phi);
    }
    const r = rng(7);
    for (let trial = 0; trial < 3; trial++) {
        const V = [0, 2000 * r() - 1000, 2000 * r() - 1000, 2000 * r() - 1000];
        const { phi, stats } = solveVoltages(H, V, { tol: 1e-12 });
        assert.ok(stats.converged);
        const sum = new Float64Array(phi.length);
        for (const k of [1, 2, 3]) { const b = bases.get(k); for (let q = 0; q < sum.length; q++) sum[q] += V[k] * b[q]; }
        const vmax = Math.max(...V.map(Math.abs));
        const d = maxDiff(sum, phi);
        assert.ok(d <= 1e-9 * vmax, `superposition error ${d} for max|V| ${vmax}`);
    }
});

for (const [name, make, ks] of [['thin-wall einzel', einzelThin, [1, 2, 3]], ['thin-plate two-aperture lens', s9Fixture, [1, 2]]]) {
    test(`S8 forced multigrid, krylov and sor agree to 1e-9 V/V: ${name}`, () => {
        const { H } = hierarchy(name, make);
        assert.ok(H.length >= 3);
        for (const k of ks) {
            const sol = {};
            for (const method of ['multigrid', 'krylov', 'sor']) {
                const { phi, stats } = solveBasis(H, k, { method, tol: 1e-10 });
                assert.ok(stats.converged, `${method} converged`);
                assert.deepEqual(stats.path, [method]);
                sol[method] = phi;
            }
            const d1 = maxDiff(sol.multigrid, sol.krylov), d2 = maxDiff(sol.multigrid, sol.sor), d3 = maxDiff(sol.krylov, sol.sor);
            assert.ok(Math.max(d1, d2, d3) <= 1e-9, `basis ${k}: ${d1} ${d2} ${d3}`);
        }
    });
}

test('S9 thin features: cuts on every level, auto without fallback, contraction <= 0.35/cycle, equal to SOR', () => {
    const { H } = hierarchy('thin-plate two-aperture lens', s9Fixture);
    assert.ok(H.length >= 4);
    for (const op of H) {
        const el = op.raster.cuts.elec;
        assert.ok([...el].filter((e) => e === 1).length > 0 && [...el].filter((e) => e === 2).length > 0, `level ${op.level} plate cuts`);
        if (op.level > 0) assert.ok(op.grid.offX > 0 && op.grid.offY > 0, 'far edges off the coarse lattice');
    }
    for (const k of [1, 2]) {
        const op = H[0], u = new Float64Array(op.N), b = newRhs(op);
        basisSetup(op, k, u, b);
        const st = multigridSolve(H, u, b, { tol: 1e-10, allowSwitch: true });
        assert.ok(st.converged && !st.switchReason);
        const hst = st.history, mean = Math.pow(hst[hst.length - 1] / hst[0], 1 / (hst.length - 1));
        assert.ok(mean <= 0.35, `mean contraction ${mean}`);
        const auto = solveBasis(H, k, { tol: 1e-12 }), sor = solveBasis(H, k, { method: 'sor', tol: 1e-10 });
        assert.deepEqual(auto.stats.path, ['multigrid']);
        assert.ok(auto.stats.converged && sor.stats.converged);
        assert.ok(maxDiff(auto.phi, sor.phi) <= 1e-9);
    }
});

test('SOR near omega = 2 does not certify a tolerance below its round-off plateau; it stops by stagnation', () => {
    const { H } = hierarchy('thin-plate two-aperture lens', s9Fixture);
    const ref = solveBasis(H, 1, { tol: 1e-12 }).phi;
    const { phi, stats } = solveBasis(H, 1, { method: 'sor', tol: 1e-12 });
    const e = maxDiff(phi, ref);
    assert.ok(stats.sweeps < 10000, `sweeps ${stats.sweeps}`);
    assert.ok(stats.converged === (stats.estErr <= 1e-12), 'converged only when certified');
    assert.ok(stats.estErr >= e / 2, `estimate ${stats.estErr} vs true ${e}`);
    if (!stats.converged) assert.ok(stats.warnings.some((w) => w.code === 'W_NOT_CONVERGED'));
    assert.ok(e < 1e-11, `the solution is still accurate (${e})`);
});

test('Carre SOR on the 417 x 71 einzel: <= 320 sweeps to 1e-6, within 1.3x of the best fixed factor, honest estimate', () => {
    const { H } = hierarchy('carre einzel', carreEinzel);
    const op = H[0];
    assert.equal(op.raster.cuts.count, 0, 'node-aligned walls');
    const ref = solveBasis(H, 2, { tol: 1e-12 }).phi;
    const u = new Float64Array(op.N), b = newRhs(op);
    basisSetup(op, 2, u, b);
    const st = carreSOR(op, u, b, { tol: 1e-6 });
    const trueErr = maxDiff(u, ref);
    assert.ok(st.converged && st.updates > 0);
    assert.ok(st.sweeps <= 320, `sweeps ${st.sweeps}`);
    assert.ok(trueErr <= 1e-6, `true error ${trueErr}`);
    assert.ok(st.estErr >= trueErr / 2, `estimate ${st.estErr} vs true ${trueErr}`);
    // fixed factors under the same stop rule
    let best = Infinity;
    for (let w = 1.88; w <= 1.96 + 1e-9; w += 0.005) {
        const uf = new Float64Array(op.N), bf = newRhs(op);
        basisSetup(op, 2, uf, bf);
        const sf = carreSOR(op, uf, bf, { tol: 1e-6, adapt: false, omega: w, maxSweeps: 5000 });
        const e = maxDiff(uf, ref);
        assert.ok(sf.estErr >= e / 2, `fixed ${w}: estimate ${sf.estErr} vs true ${e}`);
        if (sf.converged && sf.sweeps < best) best = sf.sweeps;
    }
    assert.ok(st.sweeps <= 1.3 * best, `Carre ${st.sweeps} sweeps vs best fixed ${best}`);
});

test('error estimates are never more than 2x below the true error (multigrid, krylov, sor)', () => {
    for (const [name, make] of [['thin-wall einzel', einzelThin], ['thin-plate two-aperture lens', s9Fixture]]) {
        const { H } = hierarchy(name, make);
        const op = H[0];
        const ref = solveBasis(H, 1, { tol: 1e-12 }).phi;
        for (const tol of [1e-6, 1e-8]) {
            for (const [method, fn] of [['multigrid', (u, b) => multigridSolve(H, u, b, { tol })], ['krylov', (u, b) => bicgstabMG(H, u, b, { tol })], ['sor', (u, b) => carreSOR(op, u, b, { tol })]]) {
                const u = new Float64Array(op.N), b = newRhs(op);
                basisSetup(op, 1, u, b);
                const st = fn(u, b);
                const e = maxDiff(u, ref);
                assert.ok(st.converged, `${name} ${method} ${tol}`);
                assert.ok(st.estErr >= e / 2, `${name} ${method} tol ${tol}: estimate ${st.estErr} vs true ${e}`);
                assert.ok(e <= 2 * tol, `${name} ${method} tol ${tol}: true error ${e}`);
            }
        }
    }
});

test('a deliberately broken coarse level still converges through the chain', () => {
    const res = s9Fixture();
    const geo = compileGeometry(res);
    const H = buildHierarchy(geo, res, {});
    const ref = solveBasis(H, 1, { tol: 1e-12 }).phi;
    const op1 = H[1];
    for (let j = 0; j < op1.ny; j++) op1.rowInvD[j] = -op1.rowInvD[j];     // a coarse operator with the wrong sign
    for (let m = 0; m < op1.irr.count; m++) op1.irr.diag[m] = -op1.irr.diag[m];
    const { phi, stats } = solveBasis(H, 1, { tol: 1e-10 });
    assert.ok(stats.converged, `path ${stats.path}`);
    assert.ok(stats.path.length >= 2 && stats.path[0] === 'multigrid', `path ${stats.path}`);
    assert.ok(maxDiff(phi, ref) <= 2e-10);
});

test('auto converges on every fixture; small grids use SOR', () => {
    for (const [name, make] of [['thin-wall einzel', einzelThin], ['thin-plate two-aperture lens', s9Fixture], ['carre einzel', carreEinzel]]) {
        const { H, res } = hierarchy(name, make);
        for (let k = 1; k < res.electrodes.length; k++) {
            const { stats } = solveBasis(H, k, {});
            assert.ok(stats.converged, `${name} basis ${k}`);
            assert.ok(stats.estErr <= 1e-10 && stats.scaledResidual <= 1e-9);
            for (const f of ['method', 'path', 'levels', 'cycles', 'iterations', 'sweeps', 'omega', 'rho', 'estErr', 'scaledResidual', 'converged', 'ms', 'nodes', 'free', 'irregular', 'warnings']) assert.ok(f in stats, f);
        }
    }
    const tiny = { domain: { type: 'planar2d', h: 1, x: [0, 12], y: [0, 6], nx: 13, ny: 7, edges: {} }, electrodes: [{ id: 'gnd' }, { id: 'a' }], shapes: [{ type: 'circle', electrode: 'a', cx: 6.2, cy: 3.1, r: 1.3 }] };
    const Ht = buildHierarchy(compileGeometry(tiny), tiny, {});
    assert.ok(Ht.length < 3);
    const st = solveBasis(Ht, 1, {}).stats;
    assert.deepEqual(st.path, ['sor']);
    assert.ok(st.converged);
    const z = solveVoltages(Ht, [0, 0], {});
    assert.ok(z.stats.converged && z.phi.every((v) => v === 0));
});

test('progress hooks, cancellation and time limits', () => {
    const { H } = hierarchy('thin-wall einzel', einzelThin);
    const seen = [];
    solveBasis(H, 2, { method: 'sor', tol: 1e-12 }, { onProgress: (p) => seen.push(p), progressEveryMs: 0 });
    assert.ok(seen.length > 10);
    for (const p of seen) for (const f of ['phase', 'frac', 'cycle', 'iteration', 'sweep', 'estErr', 'scaledResidual', 'omega']) assert.ok(f in p, f);
    assert.ok(seen.every((p) => p.frac >= 0 && p.frac <= 1));
    let n = 0;
    assert.throws(() => solveBasis(H, 2, { method: 'sor' }, { shouldStop: () => ++n > 5 }), (e) => e.name === 'EngineError' && e.code === 'E_CANCELLED');
    const lim = solveBasis(H, 2, { method: 'sor', tol: 1e-12, timeLimitMs: 1 });
    assert.equal(lim.stats.converged, false);
    assert.ok(lim.stats.warnings.some((w) => w.code === 'W_TIME_LIMIT' || w.code === 'W_NOT_CONVERGED'));
});

test('omegaBox follows the edge conditions; estimate() levels and costs', () => {
    const grid = (type, nx, ny, bc) => ({ type, nx, ny, edges: { xmin: { bc: bc[0] }, xmax: { bc: bc[1] }, ymin: { bc: bc[2] }, ymax: { bc: bc[3] } } });
    const box = (kx, ky) => { const rho = 0.5 * (Math.cos(kx) + Math.cos(ky)); return 2 / (1 + Math.sqrt(1 - rho * rho)); };
    assert.equal(omegaBox(grid('planar2d', 101, 51, ['dirichlet', 'dirichlet', 'dirichlet', 'dirichlet'])), box(Math.PI / 100, Math.PI / 50));
    assert.equal(omegaBox(grid('planar2d', 101, 51, ['neumann', 'dirichlet', 'dirichlet', 'neumann'])), box(Math.PI / 200, Math.PI / 100));
    assert.equal(omegaBox(grid('cyl2d', 101, 51, ['dirichlet', 'profile', 'axis', 'dirichlet'])), box(Math.PI / 100, 2.4048 / 50));
    assert.equal(omegaBox(grid('cyl2d', 101, 51, ['dirichlet', 'dirichlet', 'axis', 'neumann'])), box(Math.PI / 100, 0));
    assert.ok(omegaBox(grid('planar2d', 101, 51, ['neumann', 'neumann', 'neumann', 'neumann'])) < 2);
    const e = estimate({ nx: 801, ny: 65 }, 2);
    assert.equal(e.levels, 4);   // 801x65 -> 401x33 -> 201x17 -> 101x9 (909 nodes <= 1000: coarsest)
    assert.ok(Math.abs(e.msPerBasis - 20 * 12 * 4.5e-6 * 801 * 65 * 1.34) < 1e-9);
    assert.equal(estimate({ nx: 13, ny: 7 }, 1).levels, 1);
});
