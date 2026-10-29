// WP2 performance probe (spec §6 and §7.3 acceptance 7). Not part of node --test: it prints the measured numbers
// for the Monte Carlo rows of §6 and marks each budget OK or MISS. Exit code 1 when a §7.3 acceptance row misses.
// Usage: node _tests/conductance/wp2-perf.mjs [--quick]
// Meshes are built here with the construction of §7.4 (testgeom.js), so the probe runs without WP3.
import { makeBlock, compileBlock, runChainBlock } from '../../beta/conductance/js/engine/chain-mc.js';
import { buildBVH, makeTracer } from '../../beta/conductance/js/engine/bvh.js';
import { makeScene, runMeshBatch } from '../../beta/conductance/js/engine/mesh-mc.js';
import { chainPlan } from '../../beta/conductance/js/engine/chain-scene.js';
import { McRunner } from '../../beta/conductance/js/engine/mc-runner.js';
import { gasState } from '../../beta/conductance/js/engine/gas.js';
import { NodeWorker } from './node-worker.mjs';

const quick = process.argv.includes('--quick');
const N2 = gasState('N2', 293.15);
const now = () => performance.now();
const rows = [];
let acceptanceMiss = false;
function row(item, value, budget, ok, acceptance = false) {
  rows.push({ item, value, budget, ok });
  if (acceptance && ok === false) acceptanceMiss = true;
  process.stdout.write(`${ok === null ? '    ' : ok ? 'OK  ' : 'MISS'}  ${item.padEnd(66)} ${String(value).padEnd(26)} ${budget}\n`);
}
const f = (x, d = 2) => x.toFixed(d);

// ---------------------------------------------------------------- geometry (as testgeom.js builds it, §7.4)
const areaR = (R, n) => R * Math.sqrt(2 * Math.PI / (n * Math.sin(2 * Math.PI / n)));
function soup(tris) {
  const tri = new Float32Array(9 * tris.length);
  tris.forEach((t, i) => { for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) tri[9 * i + 3 * v + k] = t[v][k]; });
  return tri;
}
function tubeMesh(R, L, nA, nL) {
  const Rp = areaR(R, nA);
  const P = (k, z) => [Rp * Math.cos(2 * Math.PI * k / nA), Rp * Math.sin(2 * Math.PI * k / nA), z];
  const tris = [], port = [];
  for (let j = 0; j < nL; j++) {
    const z0 = L * j / nL, z1 = L * (j + 1) / nL;
    for (let k = 0; k < nA; k++) { const a = P(k, z0), b = P(k + 1, z0), c = P(k + 1, z1), d = P(k, z1); tris.push([a, b, c], [a, c, d]); port.push(-1, -1); }
  }
  for (const [z, g] of [[0, 0], [L, 1]]) for (let k = 0; k < nA; k++) { tris.push([[0, 0, z], P(k, z), P(k + 1, z)]); port.push(g); }
  return { tri: soup(tris), triPort: Int16Array.from(port) };
}
function elbowMesh(R = 0.02, A = 0.06, B = 0.06, n = 64) {
  const Rp = areaR(R, n), ds = 2 * Math.PI * R / n;
  const m0 = Math.max(1, Math.round(A / ds)), m1 = Math.max(1, Math.round(B / ds));
  const c = (k) => Math.cos(2 * Math.PI * k / n), s = (k) => Math.sin(2 * Math.PI * k / n);
  const leg0 = (k, j) => [Rp * c(k), Rp * s(k), (A - Rp * c(k)) * j / m0];
  const leg1 = (k, j) => { const x0 = Rp * c(k); return [x0 + (B - x0) * j / m1, Rp * s(k), A - Rp * c(k)]; };
  const tris = [], port = [];
  for (const [g, m] of [[leg0, m0], [leg1, m1]]) {
    for (let j = 0; j < m; j++) for (let k = 0; k < n; k++) {
      const a = g(k, j), b = g(k + 1, j), cc = g(k + 1, j + 1), d = g(k, j + 1);
      tris.push([a, b, cc], [a, cc, d]); port.push(-1, -1);
    }
  }
  for (let k = 0; k < n; k++) { tris.push([[0, 0, 0], leg0(k, 0), leg0(k + 1, 0)]); port.push(0); }
  for (let k = 0; k < n; k++) { tris.push([[B, 0, A], leg1(k, m1), leg1(k + 1, m1)]); port.push(1); }
  return { tri: soup(tris), triPort: Int16Array.from(port) };
}
const twoPorts = (inwardOut) => [{ name: 'Inlet', role: 'inlet', stick: 1, inward: [0, 0, 1] }, { name: 'Outlet', role: 'outlet', stick: 1, inward: inwardOut }];
function sceneBytes(sc) {
  let b = 0;
  for (const k of ['tri', 'normal', 'area', 'port', 'origTri', 'box', 'meta']) b += sc[k].byteLength;
  for (const p of sc.ports) b += p.slots.byteLength + p.cdf.byteLength;
  return b;
}

// a runner whose worker factory counts the result messages that carry a tally copy
function countingRunner(workers) {
  const stats = { results: 0, hits: 0, perWorker: [] };
  const createWorker = () => {
    const w = new NodeWorker();
    const k = stats.perWorker.length;
    stats.perWorker.push(0);
    w.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'result') { stats.results++; if (e.data.hits) { stats.hits++; stats.perWorker[k]++; } }
    });
    return w;
  };
  return { mc: new McRunner({ createWorker, workers }), stats };
}

process.stdout.write(`WP2 performance probe${quick ? ' (quick)' : ''}: Node ${process.version}, ${(await import('node:os')).cpus()[0].model.trim()}\n\n`);
process.stdout.write(`${'    '}  ${'Item'.padEnd(66)} ${'Measured'.padEnd(26)} Budget (§6, §7.3)\n`);

// ---------------------------------------------------------------- 1. chain kernel, one thread
const CHAIN = {
  'tube L/R = 10': [{ type: 'tube', R: 1, L: 10 }],
  'tube L/R = 100': [{ type: 'tube', R: 1, L: 100 }],
  'elbow R 1, A = B = 2': [{ type: 'elbow', R: 1, A: 2, B: 2 }],
  'cone β = 20°, L/R₁ = 2': [{ type: 'cone', R1: 1, R2: 1 + 2 * Math.tan(20 * Math.PI / 180), L: 2 }],
  'Livesey 15/25/20 (3 tubes)': [{ type: 'tube', R: 7.5, L: 30 }, { type: 'tube', R: 12.5, L: 50 }, { type: 'tube', R: 10, L: 40 }],
};
for (const [name, cells] of Object.entries(CHAIN)) {
  const cb = compileBlock(makeBlock({ cells }));
  runChainBlock(cb, 20000, 1);                                  // warm-up
  const N = quick ? 1e5 : 4e5, t = now();
  const r = runChainBlock(cb, N, 12345);
  const s = (now() - t) / 1000, mc = r.casts / s / 1e6;
  const acc = name === 'tube L/R = 10';
  row(`Chain kernel, 1 thread: ${name} (${f(r.casts / N, 2)} casts/particle)`, `${f(mc)} M casts/s, ${f(N / s / 1e6, 3)} M part./s`,
    acc ? '≥ 4 M casts/s per thread' : '(4.4–7.5 in the design phase)', acc ? mc >= 4 : null, acc);
}

// ---------------------------------------------------------------- 2. BVH build and mesh kernel, one thread
const t26 = tubeMesh(1, 10, 128, 100);                         // 25 856 triangles (the design-phase 26 k tube)
let t = now();
buildBVH(t26.tri);
const tb26 = now() - t;
row(`BVH build, tube of ${t26.tri.length / 9} triangles`, `${f(tb26, 0)} ms`, '≤ 250 ms at 26 k', tb26 <= 250);
const sc26 = makeScene(t26.tri, t26.triPort, twoPorts([0, 0, -1]));
const bpt = sceneBytes(sc26) / sc26.nTri;
row('Scene memory per triangle (tri, normal, area, port, origTri, box, meta, port tables)', `${f(bpt, 1)} B`, 'about 80 B', bpt <= 100);
if (!quick) {
  const t250 = tubeMesh(1, 10, 256, 488);                      // 250 368 triangles
  t = now();
  buildBVH(t250.tri);
  const tb = now() - t;
  row(`BVH build, tube of ${t250.tri.length / 9} triangles`, `${f(tb, 0)} ms`, '≤ 3 s at 250 k', tb <= 3000);
}
{
  const trace = makeTracer(sc26);
  runMeshBatch(sc26, trace, { source: 0, n: 5000, seed: 1 });   // warm-up
  const N = quick ? 2e4 : 6e4;
  t = now();
  const r = runMeshBatch(sc26, trace, { source: 0, n: N, seed: 7 });
  const s = (now() - t) / 1000, mc = r.casts / s / 1e6;
  row(`Mesh kernel, 1 thread: 26 k-triangle tube L/R = 10 (${f(r.casts / N, 2)} casts/particle, ${r.leaks} leaks)`, `${f(mc, 3)} M casts/s`,
    '≥ 0.4 M casts/s per thread', mc >= 0.4, true);
}

// ---------------------------------------------------------------- 3. worker start-up
async function startup(nW, msg) {
  const ws = Array.from({ length: nW }, () => new NodeWorker());
  const t0 = now();
  await Promise.all(ws.map((w) => new Promise((resolve, reject) => {
    w.onmessage = (e) => { if (e.data.type === 'loaded') resolve(); else if (e.data.type === 'error') reject(new Error(e.data.message)); };
    w.onerror = (e) => reject(new Error(e.message));
    w.postMessage(msg);
  })));
  const ms = now() - t0;
  await Promise.all(ws.map((w) => w.terminate()));
  return ms;
}
{
  const plan = chainPlan([{ t: 'tube', d: 0.1, L: 0.2 }, { t: 'elbow', d: 0.1, A: 0.1, B: 0.1 }, { t: 'pump', S: 0.3, d: 0.1, label: 'Turbo' }], N2, { bc: { mode: 'pump', p0: 1e-4 } });
  const ms1 = await startup(8, { type: 'load', job: 1, kind: 'chain', blocks: plan.blocks });
  row('Worker start-up, 8 threads: module load + chain load + "loaded" reply', `${f(ms1, 0)} ms`, '≤ 300 ms for all workers', ms1 <= 300);
  const ms2 = await startup(8, { type: 'load', job: 1, kind: 'mesh', scene: sc26 });
  row('Worker start-up, 8 threads: module load + 26 k mesh scene (structured clone)', `${f(ms2, 0)} ms`, '≤ 300 ms for all workers', ms2 <= 300);
}

// ---------------------------------------------------------------- 4. scaling from 1 to 8 workers (warm pools)
async function throughput(nW, kind, perWorkerParticles) {
  const mc = new McRunner({ createWorker: () => new NodeWorker(), workers: nW });
  const plan = { blocks: [makeBlock({ id: 0, cells: [{ type: 'tube', R: 1, L: 10 }] })], tree: { k: 'pumpBlock', id: 0 }, kind: 'C', notes: [] };
  const go = (n) => (kind === 'chain'
    ? mc.runChain(plan, N2, { target: 0, maxTime: 60, maxParticles: n, seed: 99 })
    : mc.runMesh(sc26, N2, { target: 0, maxTime: 60, maxParticles: n, seed: 99, tally: false, paths: 0 }));
  await go(nW * 2000);                                          // warm-up: threads started, modules loaded
  const t0 = now();
  const r = await go(nW * perWorkerParticles);
  const s = (now() - t0) / 1000;
  mc.dispose();
  return { castsPerSec: r.casts / s, s };
}
const PART = quick ? { chain: 3e5, mesh: 1.5e4 } : { chain: 1.5e6, mesh: 1e5 };
for (const kind of ['chain', 'mesh']) {
  const one = await throughput(1, kind, PART[kind]);
  const eight = await throughput(8, kind, PART[kind]);
  const scale = eight.castsPerSec / one.castsPerSec;
  const what = kind === 'chain' ? 'chain tube L/R = 10' : '26 k-triangle mesh tube';
  row(`Runner throughput, ${what}: 1 worker → 8 workers`, `${f(one.castsPerSec / 1e6)} → ${f(eight.castsPerSec / 1e6)} M casts/s`, '', null);
  row(`Scaling from 1 to 8 workers, ${what}`, `${f(scale, 2)}×`, '≥ 5×', scale >= 5, true);
  if (kind === 'mesh') row('Mesh MC total with 8 workers (26 k triangles)', `${f(eight.castsPerSec / 1e6)} M casts/s`, '≥ 2.5 M casts/s total', eight.castsPerSec >= 2.5e6);
}

// ---------------------------------------------------------------- 5. Verify by Monte Carlo, default preset, ±1 %
const preset1 = [{ t: 'tube', d: 0.1, L: 0.2 }, { t: 'elbow', d: 0.1, A: 0.1, B: 0.1 }, { t: 'pump', S: 0.3, d: 0.1, label: 'Turbo' }];
for (const nW of [8, 2]) {
  const reps = quick ? 1 : 3, times = [];
  let last = null;
  for (let k = 0; k < reps; k++) {
    const t0 = now();
    const mc = new McRunner({ createWorker: () => new NodeWorker(), workers: nW });   // cold: threads start in the run
    const plan = chainPlan(preset1, N2, { bc: { mode: 'pump', p0: 1e-4 } });
    last = await mc.runChain(plan, N2, { target: 0.01, maxTime: 20, seed: 1000 + k });
    times.push((now() - t0) / 1000);
    mc.dispose();
  }
  const worst = Math.max(...times);
  row(`Verify by MC, preset 1 to ±1 % (95 %), ${nW} workers, cold start (${last.particles} particles, ${f(last.value * 1000)} L/s)`,
    `${times.map((x) => f(x, 2)).join(', ')} s`, nW === 8 ? '≤ 2 s with 8 workers' : '≤ 6 s with 2 workers', worst <= (nW === 8 ? 2 : 6));
}

// ---------------------------------------------------------------- 6. CAD default elbow to ±1 % with 8 workers, tally traffic
{
  const t0 = now();
  const em = elbowMesh();
  const sc = makeScene(em.tri, em.triPort, twoPorts([-1, 0, 0]));
  const tBuild = now() - t0;
  const mc = new McRunner({ createWorker: () => new NodeWorker(), workers: 8 });      // cold: threads start in the run
  const tRun = now();
  const r = await mc.runMesh(sc, N2, { target: 0.01, maxTime: 30, seed: 4242, tally: true, paths: 40 });
  const total = (now() - t0) / 1000, runS = (now() - tRun) / 1000;
  mc.dispose();
  const alpha = r.C.value / (sc.ports[0].area * N2.vbar / 4);
  row(`CAD default elbow (${sc.nTri} triangles) to ±1 %, 8 workers: mesh + BVH ${f(tBuild, 0)} ms, run ${f(runS, 2)} s`,
    `${f(total, 2)} s (α ${alpha.toFixed(4)})`, '≤ 5 s with 8 workers', total <= 5);
  row(`  particles, casts per particle, leaks per million`, `${r.particles}, ${f(r.casts / r.particles, 2)}, ${f(r.leaksPerMillion, 2)}`, '(about 1.1·10⁵ and 8.4)', null);
  // tally traffic over a run of fixed length: the first result carries a copy, then at most one per second
  const T = quick ? 2 : 4;
  const cr = countingRunner(8);
  const tt = now();
  await cr.mc.runMesh(sc, N2, { target: 0, maxTime: T, seed: 77, tally: true, paths: 0 });
  const runT = (now() - tt) / 1000;
  cr.mc.dispose();
  const most = Math.max(...cr.stats.perWorker), rate = (most - 1) / runT;
  row(`Tally traffic over a ${T} s run: copies of the largest worker, after its first`, `${most - 1} in ${f(runT, 2)} s (${f(rate, 2)} /s)`,
    '≤ 1 message per worker per second', rate <= 1);
}

process.stdout.write(`\n${rows.filter((r) => r.ok === false).length} budget rows missed; §7.3 acceptance 7 ${acceptanceMiss ? 'NOT met' : 'met'}.\n`);
process.exitCode = acceptanceMiss ? 1 : 0;
