// WP4 acceptance 3 (spec §7.5): the CAD logic of cad-ui.js — the Run-enable rule with its reasons, stick ↔ speed for
// any gas and temperature, the clearing rules (a role change clears the results; a gas change recomputes C from the
// counts, matching a hand calculation), transmission-matrix formatting — plus the DOM-free controller driven by a
// stub prep worker (a hard-coded built-in) and a stub runner that replays progress from WP2's real mesh kernel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gasState, GAS_IDS } from '../../beta/conductance/js/engine/gas.js';
import { wilson, summarizeMesh } from '../../beta/conductance/js/engine/stats.js';
import { makeScene, runMeshBatch, toPreparedOrder } from '../../beta/conductance/js/engine/mesh-mc.js';
import { makeTracer } from '../../beta/conductance/js/engine/bvh.js';
import { parseProject } from '../../beta/conductance/js/io/project.js';
import * as cad from '../../beta/conductance/js/ui/cad-ui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rel = (a, b) => Math.abs(a / b - 1);

// ================================================================ pure helpers
test('stick ↔ speed: Appendix B.3 sticking coefficients and round trips for every gas and temperature', () => {
  const N2 = gasState('N2', 293.15), air = gasState('air', 293.15);
  const A = (d) => Math.PI * d * d / 4;
  assert.ok(Math.abs(cad.stickFromSpeed(0.3, A(0.1), N2) - 0.32460) < 5e-6, 'preset 1');
  assert.ok(Math.abs(cad.stickFromSpeed(0.3, A(0.1), air) - 0.33006) < 5e-6, 'preset 2');
  assert.ok(Math.abs(cad.stickFromSpeed(0.009722222, A(0.025), air) - 0.17114) < 5e-6, 'preset 3');
  assert.ok(Math.abs(cad.stickFromSpeed(0.08, A(0.063), N2) - 0.21809) < 5e-6, 'preset 4');
  // the molecular maximum is A·v̄/4: air at 20 °C passes 11.5728 L/s per cm²
  assert.ok(Math.abs(cad.maxSpeed(1e-4, air) * 1000 - 11.5728) < 1e-4);
  const gases = [...GAS_IDS.map((id) => [id, null]), ['custom', { M: 0.1, eta20: 2e-5, omega: 0.7, gamma: 1.3, Cd: 0.8 }]];
  for (const [id, custom] of gases) {
    for (const T of [77, 200, 293.15, 450, 1200]) {
      const G = gasState(id, T, custom);
      for (const area of [1e-6, 3.1e-3, 0.2]) {
        const Smax = area * G.vbar / 4;
        assert.ok(rel(cad.maxSpeed(area, G), Smax) < 1e-15);
        for (const stick of [1e-4, 0.25, 1]) {
          const S = cad.speedFromStick(stick, area, G);
          assert.ok(rel(S, stick * Smax) < 1e-15);
          assert.ok(rel(cad.stickFromSpeed(S, area, G), stick) < 1e-14, id + ' ' + T);
        }
      }
    }
  }
  // the same speed is a different sticking coefficient in another gas: v̄ ∝ √(T/M)
  const He = gasState('He', 293.15);
  assert.ok(rel(cad.stickFromSpeed(0.3, A(0.1), N2) / cad.stickFromSpeed(0.3, A(0.1), He), He.vbar / N2.vbar) < 1e-14);
});

test('pump checks: a speed above A·v̄/4 or a sticking coefficient outside (0, 1] is refused with a sentence', () => {
  const G = gasState('N2', 293.15), A = 1e-3, Smax = A * G.vbar / 4;
  const pump = (o) => ({ id: 0, name: 'Pump', role: 'pump', kind: 'region', area: A, ...o });
  assert.equal(cad.pumpProblem(pump({ pumpBy: 'speed', speed: 0.5 * Smax }), A, G), null);
  assert.match(cad.pumpProblem(pump({ pumpBy: 'speed', speed: 1.01 * Smax }), A, G), /above the molecular-flow maximum/);
  assert.match(cad.pumpProblem(pump({ pumpBy: 'speed', speed: -1 }), A, G), /positive number/);
  assert.equal(cad.pumpProblem(pump({ pumpBy: 'stick', stick: 1, speed: null }), A, G), null);
  assert.match(cad.pumpProblem(pump({ pumpBy: 'stick', stick: 1.2, speed: null }), A, G), /at most 1/);
  assert.match(cad.pumpProblem(pump({ pumpBy: 'stick', stick: 0, speed: null }), A, G), /above 0/);
  assert.equal(cad.pumpProblem({ role: 'outlet' }, A, G), null);
});

const REPORT_OK = {
  nTri: 10, loops: [{ id: 0, planar: true, area: 1e-4 }, { id: 1, planar: true, area: 1e-4 }], messages: [], severity: 'ok',
};
const loopPort = (id, role, extra = {}) => ({ id, name: 'P' + id, kind: 'loop', loops: [[id]], role, stick: 1, speed: null, pumpBy: 'speed', ...extra });

test('Run-enable rule and its reasons', () => {
  const G = gasState('N2', 293.15);
  const base = { phase: 'ready', report: REPORT_OK, ports: [loopPort(0, 'inlet'), loopPort(1, 'outlet')], G, sceneReady: true };
  assert.deepEqual(cad.runEnable(base), { ok: true, reason: '' });
  const reason = (patch) => cad.runEnable({ ...base, ...patch }).reason;
  assert.match(reason({ phase: 'empty', report: null }), /Load a model/);
  assert.match(reason({ phase: 'loading' }), /Preparing the mesh/);
  assert.match(reason({ running: true }), /running/);
  assert.match(reason({ report: { ...REPORT_OK, severity: 'error', messages: [{ level: 'error', text: 'x' }] } }), /mesh errors/);
  assert.match(reason({ ports: [loopPort(0, 'inlet')] }), /Every opening needs a role: 1 flat opening has none/);
  assert.equal(reason({ ports: [loopPort(0, 'inlet'), loopPort(1, 'closed')] }), 'Select an outlet or a pump as well as the inlet.');
  assert.equal(reason({ ports: [loopPort(0, 'outlet'), loopPort(1, 'closed')] }), 'Select an inlet as well as the outlet.');
  assert.equal(reason({ ports: [loopPort(0, 'closed'), loopPort(1, 'closed')] }), 'Select an inlet and an outlet.');
  // a closed solid with no openings yet
  assert.equal(cad.runEnable({ ...base, report: { ...REPORT_OK, loops: [], closed: true }, ports: [] }).reason, 'Select an inlet and an outlet.');
  assert.equal(reason({ ports: [loopPort(0, 'inlet'), loopPort(1, 'pump', { pumpBy: 'speed', speed: 1e3 })] }), 'The pumping speed of "P1" is above the molecular-flow maximum of its opening.');
  assert.equal(cad.runEnable({ ...base, ports: [loopPort(0, 'inlet'), loopPort(1, 'pump', { pumpBy: 'speed', speed: 1e-3 })] }).ok, true, 'a pump is a valid sink');
  assert.equal(reason({ gasError: 'bad' }), 'Paused: fix the gas data above.');
  assert.equal(reason({ sceneError: 'Cannot tell which side of opening 1 is inside. Close the mesh or check the normals.' }), 'Cannot tell which side of opening 1 is inside. Close the mesh or check the normals.');
  assert.match(reason({ sceneReady: false, scenePending: true }), /Preparing the openings/);
  assert.equal(reason({ runnerBusy: true }), 'Another simulation is running (Stop it first)');
});

test('clearing rules: what a change does to stored results', () => {
  for (const k of ['role', 'pump', 'region', 'geometry', 'weld']) assert.equal(cad.changeEffect(k), 'clear', k);
  assert.equal(cad.changeEffect('units'), 'clear');
  assert.equal(cad.changeEffect('units', { builtin: true }), 'keep');
  assert.equal(cad.changeEffect('gas'), 'recompute');
  assert.equal(cad.changeEffect('gas', { pumpBySpeed: true }), 'clear');
  for (const k of ['name', 'display', 'run-options']) assert.equal(cad.changeEffect(k), 'keep', k);
});

test('a gas change recomputes C from the stored counts, matching a hand calculation', () => {
  const Ain = 1e-4, Aout = 2e-4;
  const ports = [{ role: 'inlet', stick: 1, area: Ain }, { role: 'outlet', stick: 1, area: Aout }];
  const perSource = [{ port: 0, n: 10000, absorbed: [3000, 5000] }, { port: 1, n: 10000, absorbed: [2500, 6000] }];
  for (const [id, T] of [['N2', 293.15], ['He', 350], ['CO2', 250]]) {
    const G = gasState(id, T), q = G.vbar / 4;
    // by hand: both directions give C = α·A·v̄/4; inverse-variance combination
    const C1 = 0.5 * Ain * q, s1 = Math.sqrt(0.5 * 0.5 / 10000) * Ain * q;
    const C2 = 0.25 * Aout * q, s2 = Math.sqrt(0.25 * 0.75 / 10000) * Aout * q;
    const w1 = 1 / (s1 * s1), w2 = 1 / (s2 * s2);
    const C = (w1 * C1 + w2 * C2) / (w1 + w2), sig = 1 / Math.sqrt(w1 + w2);
    const sum = cad.summarizeCounts(ports, perSource, G, { inletPort: 0, outletPort: 1 });
    assert.ok(rel(sum.C.value, C) < 1e-12, id);
    assert.ok(rel(sum.C.sigma, sig) < 1e-12);
    assert.ok(rel(sum.C.ci95[1] - sum.C.value, 1.96 * sig) < 1e-12);
    assert.equal(sum.Seff, null);
    assert.equal(sum.reciprocity.length, 1);
    assert.ok(Math.abs(sum.reciprocity[0].z) < 1e-9, 'A_in·α_io = A_out·α_oi here');
  }
  // the ratio between gases is exactly v̄₂/v̄₁: the counts do not depend on the gas
  const a = cad.summarizeCounts(ports, perSource, gasState('N2', 293.15), { inletPort: 0, outletPort: 1 });
  const b = cad.summarizeCounts(ports, perSource, gasState('H2', 500), { inletPort: 0, outletPort: 1 });
  assert.ok(rel(b.C.value / a.C.value, gasState('H2', 500).vbar / gasState('N2', 293.15).vbar) < 1e-12);
});

test('transmission-matrix formatting: α with its Wilson 95 % interval, leaks and stuck per source', () => {
  assert.equal(cad.fmtAlphaCI(0.2653, 0.2641, 0.2666), '0.2653 (0.2641–0.2666)');
  assert.equal(cad.fmtAlphaCI(0.001234, 0.0012, 0.00127), '0.001234 (0.001200–0.001270)');
  assert.equal(cad.fmtAlphaCI(1, 0.9996, 1), '1.000 (1.000–1.000)');
  assert.equal(cad.fmtAlphaCI(0, 0, 0.0003), '0 (0–0.0003000)');
  assert.equal(cad.fmtAlpha(0.26524), '0.2652');
  assert.equal(cad.fmtAlpha(0.000012345), '0.00001234');
  assert.equal(cad.fmtAlpha(NaN), '–');
  const ports = [{ name: 'Inlet', role: 'inlet', stick: 1, area: 1e-3 }, { name: 'Outlet', role: 'outlet', stick: 1, area: 1e-3 }];
  const perSource = [{ port: 0, n: 100000, absorbed: [73476, 26524], leaks: 2, stuck: 1 }, { port: 1, n: 50000, absorbed: [13262, 36738], leaks: 0, stuck: 0 }];
  const sum = summarizeMesh(ports, perSource, 470);
  const m = cad.formatMatrix(sum, ports, perSource);
  assert.deepEqual(m.columns, ['Inlet', 'Outlet']);
  assert.equal(m.rows.length, 2);
  assert.equal(m.rows[0].from, 'Inlet');
  const w = wilson(26524, 100000);
  assert.equal(m.rows[0].cells[1], cad.fmtAlphaCI(0.26524, w.lo, w.hi));
  assert.equal(m.rows[0].cells[1], '0.2652 (0.2625–0.2680)');
  assert.equal(m.rows[0].leaks, '2');
  assert.equal(m.rows[0].stuck, '1');
  assert.equal(m.rows[1].cells[0], '0.2652 (0.2614–0.2691)');
  // a pump port never launches: its row is absent
  const pumpPorts = [ports[0], { name: 'Pump', role: 'pump', stick: 0.3, area: 1e-3 }];
  const ps = summarizeMesh(pumpPorts, [perSource[0]], 470);
  assert.equal(cad.formatMatrix(ps, pumpPorts, [perSource[0]]).rows.length, 1);
});

test('number and text helpers: bounding box, size warning, caps, seed, status, reference line', () => {
  assert.equal(cad.bboxText([0, 0, 0, 0.15, 0.04, 0.04], 'mm', 8192), '150.0 × 40.0 × 40.0 mm · 8192 triangles');
  assert.equal(cad.bboxText([0, 0, 0, 0.15, 0.04, 0.04], 'm', 250000), '0.1500 × 0.0400 × 0.0400 m · 250 000 triangles');
  assert.equal(cad.bboxText([0, 0, 0, 0.0254, 0.0254, 0.0508], 'in', 1), '1.000 × 1.000 × 2.000 in · 1 triangle');
  assert.equal(cad.sizeWarning([0, 0, 0, 0.15, 0.04, 0.04]), '');
  assert.equal(cad.sizeWarning([0, 0, 0, 15, 4, 4]), 'That looks too small or too large; check the unit.');
  assert.equal(cad.sizeWarning([0, 0, 0, 5e-5, 1e-5, 1e-5]), 'That looks too small or too large; check the unit.');
  assert.equal(cad.triangleCapMessage(250000, false), null);
  assert.match(cad.triangleCapMessage(250001, false), /250 000/);
  assert.equal(cad.triangleCapMessage(100000, true), null);
  assert.equal(cad.triangleCapMessage(123456, true), 'This model has 123 456 triangles; phones are limited to 100 000. Use a desktop browser or reduce the mesh.');
  assert.equal(cad.parseSeed(''), null);
  assert.equal(cad.parseSeed(' 42 '), 42);
  assert.equal(cad.parseSeed('4294967295'), 4294967295);
  assert.ok(Number.isNaN(cad.parseSeed('4294967296')));
  assert.ok(Number.isNaN(cad.parseSeed('-1')));
  assert.ok(Number.isNaN(cad.parseSeed('1e3')));
  assert.equal(cad.statusLine({ particles: 8e5, castsPerSec: 3.5e7, relHalfWidth: 0.016, etaSeconds: 1.2 }), '0.8 M particles · 35 M rays/s · ±1.6 % (95 %) · about 1.2 s left');
  assert.equal(cad.statusLine({ particles: 1450, castsPerSec: 0, relHalfWidth: NaN, final: true }), '1.45 k particles');
  assert.equal(cad.referenceLine({ alpha: 0.26524, sigma: 0.00021, source: 'TPMC, this work' }, 0.26524 * 1.0012, Math.sqrt((0.000318288 / 1.1) ** 2 - 0.00021 ** 2)),
    'Reference α = 0.26524 ± 0.00021 (TPMC, this work); this run differs by +0.12 % (1.1σ).');
  assert.equal(cad.referenceLine({ alpha: 0.1909424, sigma: 0, source: 'Integral equation' }, 0.19, 0.0005),
    'Reference α = 0.1909424 (Integral equation); this run differs by −0.49 % (1.9σ).');
  assert.equal(cad.referenceLine(null, 0.2, 0.01), '');
  assert.ok(cad.progressFraction({ relHalfWidth: 0.02, elapsed: 1, etaSeconds: 3 }, { target: 0.01, maxTime: 60 }) >= 0.25);
  assert.equal(cad.progressFraction({ final: true }, {}), 1);
  assert.equal(cad.autoWorkers(12, false), 8);
  assert.equal(cad.autoWorkers(4, false), 3);
  assert.equal(cad.autoWorkers(16, true), 2);
  assert.equal(cad.autoWorkers(12, false, 80e6), 2, 'mesh runs are limited to 200 MB of scenes');
  assert.equal(cad.fmtInt(8192), '8192');
  assert.equal(cad.fmtInt(1234567), '1 234 567');
  assert.equal(cad.fmtSeconds(0.48), '0.48 s');
  assert.equal(cad.fmtSeconds(125), '2 min 05 s');
});

// ================================================================ stub geometry: a square duct with two openings
const A_SIDE = 0.02, L_DUCT = 0.02, M = 4;
function ductPositions(a = A_SIDE, L = L_DUCT, m = M) {
  const t = [];
  const quad = (p0, p1, p2, p3) => { t.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3); };
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      const u0 = a * i / m, u1 = a * (i + 1) / m, z0 = L * j / m, z1 = L * (j + 1) / m;
      quad([0, u0, z0], [0, u1, z0], [0, u1, z1], [0, u0, z1]);
      quad([a, u0, z0], [a, u0, z1], [a, u1, z1], [a, u1, z0]);
      quad([u0, 0, z0], [u0, 0, z1], [u1, 0, z1], [u1, 0, z0]);
      quad([u0, a, z0], [u1, a, z0], [u1, a, z1], [u0, a, z1]);
    }
  }
  return Float32Array.from(t);
}
function capOf(loopId, a = A_SIDE, L = L_DUCT) {
  const z = loopId === 0 ? 0 : L;
  return [0, 0, z, a, 0, z, a, a, z, 0, 0, z, a, a, z, 0, a, z];
}
function ductReport(positions, extra = {}) {
  const a = A_SIDE, L = L_DUCT;
  return {
    nTri: positions.length / 9, nVert: 4 * M * (M + 1), bbox: [0, 0, 0, a, a, L], diag: Math.hypot(a, a, L), weldTol: 1e-6 * Math.hypot(a, a, L),
    merged: 0, degenerate: 0, duplicate: 0, boundaryEdges: 8 * M, nonManifoldEdges: 0, openChains: 0,
    loops: [
      { id: 0, planar: true, area: a * a, sides: 4 * M, circular: false, centroid: [a / 2, a / 2, 0], normal: [0, 0, 1], perimeter: 4 * a },
      { id: 1, planar: true, area: a * a, sides: 4 * M, circular: false, centroid: [a / 2, a / 2, L], normal: [0, 0, 1], perimeter: 4 * a },
    ],
    closed: false, windingConsistent: true, signedVolume: a * a * L, faceting: [], severity: 'ok',
    messages: [{ level: 'ok', code: 'openings', text: '2 openings were found.' }], ...extra,
  };
}
const AUTO_PORTS = [
  { id: 0, name: 'Inlet', kind: 'loop', loops: [[0]], tris: null, role: 'inlet', stick: 1, speed: null },
  { id: 1, name: 'Outlet', kind: 'loop', loops: [[1]], tris: null, role: 'outlet', stick: 1, speed: null },
];
const REFERENCE = { alpha: 0.53622, sigma: 0.00035, source: 'TPMC (research): square duct, L/a = 1' };

/** A Worker-like stub of the prep worker (§2.13) for the hard-coded duct. */
function stubPrepWorker(opts = {}) {
  const w = { log: [], specs: null, nTriParsed: opts.nTriParsed || null, onmessage: null, onerror: null, terminated: false };
  let positions = ductPositions();
  const reply = (msg) => setTimeout(() => { if (!w.terminated && w.onmessage) w.onmessage({ data: msg }); }, 0);
  w.postMessage = (msg) => {
    w.log.push(msg);
    const id = msg.id;
    switch (msg.type) {
      case 'builtin': positions = ductPositions(); reply({ type: 'prepared', id, positions, report: ductReport(positions), autoPorts: AUTO_PORTS, reference: REFERENCE, label: 'Square duct 20 × 20 × 20 mm' }); break;
      case 'parse': reply({ type: 'parsed', id, nTri: w.nTriParsed || 128, format: 'stl-binary', warnings: [], bbox: [0, 0, 0, msg.scale * 20, msg.scale * 20, msg.scale * 20] }); break;
      case 'prepare': case 'loadMesh': positions = ductPositions(); reply({ type: 'prepared', id, positions, report: ductReport(positions), autoPorts: AUTO_PORTS }); break;
      case 'region': {
        // the flat face x = 0 (wall triangles 0, 1, 8, 9, …: every 8th pair)
        const tris = [];
        for (let k = 0; k < positions.length / 9; k++) if (positions[9 * k] === 0 && positions[9 * k + 3] === 0 && positions[9 * k + 6] === 0) tris.push(k);
        reply({ type: 'region', id, tris: Uint32Array.from(tris), plane: { n: [1, 0, 0], d: 0 }, area: A_SIDE * L_DUCT });
        break;
      }
      case 'scene': {
        w.specs = msg.ports;
        const bad = msg.ports.find((p) => p.role === 'pump' && !(p.stick > 0 && p.stick <= 1) && !(p.speed > 0));
        if (bad) { reply({ type: 'error', id, message: 'The sticking coefficient of "' + bad.name + '" must be above 0 and at most 1.' }); break; }
        const nMesh = positions.length / 9;
        const caps = [], capPort = [];
        for (const p of msg.ports) if (p.kind === 'loop') for (const g of p.loops) { caps.push(...capOf(g[0])); capPort.push(p.id, p.id); }
        const all = new Float32Array(positions.length + caps.length);
        all.set(positions); all.set(caps, positions.length);
        const n = all.length / 9, triPort = new Int16Array(n).fill(-1), sceneTri = new Int16Array(n).fill(-1);
        const open = msg.ports.filter((p) => p.role !== 'closed');
        const idx = new Map(open.map((p, k) => [p.id, k]));
        capPort.forEach((pid, k) => { triPort[nMesh + k] = pid; if (idx.has(pid)) sceneTri[nMesh + k] = idx.get(pid); });
        for (const p of msg.ports) if (p.kind === 'region') for (const t of p.tris) { triPort[t] = p.id; if (idx.has(p.id)) sceneTri[t] = idx.get(p.id); }
        const inward = (p) => (p.kind === 'region' ? [1, 0, 0] : p.loops[0][0] === 0 ? [0, 0, 1] : [0, 0, -1]);
        const scene = makeScene(all, sceneTri, open.map((p) => ({ id: p.id, name: p.name, role: p.role, stick: p.stick ?? 1, inward: inward(p) })));
        reply({ type: 'scene', id, scene, capPositions: Float32Array.from(caps), triPort, ms: 1 });
        break;
      }
      case 'export': reply({ type: 'exported', id, vertices: Float32Array.from(positions), triangles: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i) }); break;
      default: reply({ type: 'error', id, message: 'unknown request ' + msg.type });
    }
  };
  w.terminate = () => { w.terminated = true; };
  return w;
}

/** A stub McRunner: runs WP2's mesh kernel in-process in a few batches and replays the progress. */
class StubRunner {
  constructor({ batches = 4, perBatch = 5000, failWith = null, pauseMs = 0 } = {}) {
    Object.assign(this, { batches, perBatch, failWith, pauseMs });
    this._busy = false; this.calls = []; this.stopped = false;
  }
  get busy() { return this._busy; }
  get workers() { return 3; }
  stop() { this.stopped = true; }
  async runMesh(scene, G, opts) {
    if (this._busy) throw new Error('Another simulation is running (Stop it first).');
    this._busy = true; this.stopped = false;
    this.calls.push({ scene, G, opts });
    try {
      const trace = makeTracer(scene), nP = scene.ports.length;
      const src = scene.ports.map((p, k) => k).filter((k) => k === opts.inletPort || (scene.ports[k].stick >= 1 && scene.ports[k].role !== 'pump'));
      const perSource = src.map((k) => ({ port: k, n: 0, absorbed: new Float64Array(nP), leaks: 0, stuck: 0, casts: 0 }));
      const tally = new Uint32Array(scene.nTri);
      let inletN = 0, particles = 0, casts = 0;
      const history = [], paths = [];
      for (let b = 0; b < this.batches && !this.stopped; b++) {
        for (const ps of perSource) {
          const inlet = scene.ports[ps.port].role === 'inlet';
          const r = runMeshBatch(scene, trace, { source: ps.port, n: this.perBatch, seed: opts.seed + 97 * b + ps.port, tally: inlet ? tally : null, paths: inlet && b === 0 ? 5 : 0 });
          ps.n += r.n; ps.stuck += r.stuck; ps.casts += r.casts; ps.leaks += r.leaks;
          for (let j = 0; j < nP; j++) ps.absorbed[j] += r.absorbed[j];
          particles += r.n + r.stuck; casts += r.casts;
          if (inlet) inletN += r.n + r.stuck;
          paths.push(...r.paths);
        }
        const sum = summarizeMesh(scene.ports, perSource, G.vbar, { inletPort: opts.inletPort, outletPort: opts.outletPort });
        const p = sum.primary;
        history.push({ n: particles, value: p.value, lo: p.ci95[0], hi: p.ci95[1] });
        const last = b === this.batches - 1;
        opts.onProgress({
          kind: 'mesh', elapsed: 0.1 * (b + 1), particles, casts, castsPerSec: casts / (0.1 * (b + 1)), value: p.value, sigma: p.sigma,
          ci95: p.ci95, relHalfWidth: 1.96 * p.sigma / p.value, etaSeconds: last ? 0 : 0.1, history: history.slice(), final: false,
          partial: sum, hits: toPreparedOrder(scene, tally), inletLaunches: [{ port: opts.inletPort, n: inletN }], leaksPerMillion: 0,
        });
        if (this.pauseMs) await sleep(this.pauseMs); else await sleep(0);
      }
      const sum = summarizeMesh(scene.ports, perSource, G.vbar, { inletPort: opts.inletPort, outletPort: opts.outletPort });
      const result = {
        ports: scene.ports.map((p, k) => ({ index: k, id: p.id, name: p.name, role: p.role, stick: p.stick, area: p.area })),
        perSource: perSource.map((s) => ({ ...s, absorbed: Array.from(s.absorbed) })), alpha: sum.alpha, C: sum.C, Seff: sum.Seff,
        reciprocity: sum.reciprocity, inletPort: sum.inletPort, outletPort: sum.outletPort, pumpPort: sum.pumpPort,
        leaksPerMillion: 0, leaks: 0, stuck: 0, hits: toPreparedOrder(scene, tally), inletLaunches: [{ port: opts.inletPort, n: inletN }],
        paths, particles, casts, ms: 123, stopped: this.stopped, reason: this.stopped ? 'stopped' : 'target', seed: opts.seed,
      };
      if (this.failWith) {
        const err = new Error(this.failWith);
        err.code = 'leaks';
        err.partial = { ...result, reason: 'leaks' };
        throw err;
      }
      return result;
    } finally { this._busy = false; }
  }
}

function makeController({ runner = new StubRunner(), settings = { gas: 'N2', T: 293.15, custom: null, Cd: null }, phone = false, prepOpts = {} } = {}) {
  const worker = stubPrepWorker(prepOpts);
  const st = { ...settings };
  const c = new cad.CadController({ prep: cad.createPrepClient(worker), getRunner: () => runner, settings: () => st, phone, debounceMs: 1 });
  return { c, worker, runner, st };
}
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(2); }
}

// ================================================================ controller
test('controller: built-in → openings → scene → run with progress → results, matrix and reference', async () => {
  const { c, worker, runner } = makeController();
  const seen = new Set();
  c.on((tags) => { for (const t of tags) seen.add(t); });
  await c.loadBuiltin('rect');
  await until(() => c.state.sceneReady);
  const s = c.state;
  assert.equal(s.phase, 'ready');
  assert.equal(s.ports.length, 2);
  assert.deepEqual(s.ports.map((p) => p.role), ['inlet', 'outlet']);
  assert.ok(rel(s.ports[0].area, 4e-4) < 1e-6, 'area from the scene (Float32 caps): ' + s.ports[0].area);
  assert.equal(s.allPositions.length, (128 + 4) * 9, 'mesh plus caps');
  assert.equal(c.enableState().ok, true);
  const tp = c.viewTriPort();
  assert.equal(tp[127], -1);
  assert.equal(tp[128], 0);
  assert.equal(tp[131], 1);
  assert.deepEqual(c.viewPortColors(), { 0: '--c3', 1: '--c1' });
  // run
  let progress = 0;
  c.on((tags) => { if (tags.has('progress')) progress++; });
  await c.run({ seed: '12345' });
  assert.equal(progress, runner.batches);
  assert.ok(seen.has('model') && seen.has('scene') && seen.has('run') && seen.has('results'));
  const call = runner.calls[0];
  assert.equal(call.opts.seed, 12345);
  assert.equal(call.opts.inletPort, 0);
  assert.equal(call.opts.outletPort, 1);
  assert.equal(call.opts.tally, true);
  assert.equal(call.opts.paths, 40);
  assert.equal(call.opts.target, 0.01);
  assert.equal(call.opts.maxTime, 60);
  assert.equal(call.opts.allocation, 'equal');
  const r = s.results;
  assert.ok(r && !r.stopped);
  assert.equal(r.perSource.length, 2, 'both stick-1 ports launched');
  assert.equal(r.hits.length, 132);
  // the result is the same as WP2's summary of the counts
  const sum = summarizeMesh(r.ports, r.perSource, s.G.vbar, { inletPort: 0, outletPort: 1 });
  assert.ok(rel(r.summary.C.value, sum.C.value) < 1e-15);
  // and close to the duct's reference α = 0.53622 (the coarse stub mesh is an exact square duct)
  const ra = c.referenceAlpha();
  assert.ok(Math.abs(ra.alpha - REFERENCE.alpha) < 4 * Math.hypot(ra.sigma, REFERENCE.sigma), 'α = ' + ra.alpha + ' ± ' + ra.sigma);
  assert.match(cad.referenceLine(s.reference, ra.alpha, ra.sigma), /^Reference α = 0\.53622 ± 0\.00035 \(TPMC \(research\): square duct, L\/a = 1\); this run differs by [+−]\d+\.\d\d % \(\d+\.\dσ\)\.$/);
  const m = cad.formatMatrix(r.summary, r.ports, r.perSource);
  assert.equal(m.rows.length, 2);
  assert.match(m.rows[0].cells[1], /^0\.5\d{3} \(0\.5\d{3}–0\.5\d{3}\)$/);
  // pressure map and axial profile from the tallies
  const map = c.pressureMap({ average: false });
  assert.ok(map.valid > 100, 'most wall triangles have ≥ 10 hits');
  assert.equal(map.rgb.length, 3 * 132);
  assert.ok(Number.isNaN(map.rgb[3 * 130]), 'caps are ports, not walls');
  assert.ok(map.scale.min > 0 && map.scale.max === 1);
  const avg = c.pressureMap({ average: true });
  assert.ok(avg.valid >= map.valid);
  const ax = c.axial();
  assert.equal(ax.s.length, 40);
  assert.equal(ax.bent, false);
  assert.equal(ax.clausing, null);
  const finite = Array.from(ax.value).filter(Number.isFinite);
  assert.ok(finite[0] > finite[finite.length - 1], 'pressure falls from the inlet to the outlet');
  worker.terminate();
});

test('controller: a role change clears the results; a gas change recomputes C from the counts', async () => {
  const { c, st } = makeController();
  await c.loadBuiltin('rect');
  await until(() => c.state.sceneReady);
  await c.run({ seed: '7' });
  const C0 = c.state.results.summary.C.value, sig0 = c.state.results.summary.C.sigma;
  const counts = JSON.stringify(c.state.results.perSource);
  const v0 = c.state.G.vbar;
  // gas and temperature: same counts, C scales with v̄
  st.gas = 'He'; st.T = 350;
  c.conditionsChanged();
  assert.ok(c.state.results, 'results kept');
  assert.equal(JSON.stringify(c.state.results.perSource), counts);
  const ratio = c.state.G.vbar / v0;
  assert.ok(rel(c.state.results.summary.C.value, C0 * ratio) < 1e-12);
  assert.ok(rel(c.state.results.summary.C.sigma, sig0 * ratio) < 1e-12);
  // by hand from the counts
  const q = c.state.G.vbar / 4;
  const [a, b] = c.state.results.perSource;
  const Ain = c.state.results.ports[0].area, Aout = c.state.results.ports[1].area;
  const e1 = { v: a.absorbed[1] / a.n * Ain * q, s: Math.sqrt(a.absorbed[1] / a.n * (1 - a.absorbed[1] / a.n) / a.n) * Ain * q };
  const e2 = { v: b.absorbed[0] / b.n * Aout * q, s: Math.sqrt(b.absorbed[0] / b.n * (1 - b.absorbed[0] / b.n) / b.n) * Aout * q };
  const w1 = 1 / e1.s ** 2, w2 = 1 / e2.s ** 2;
  assert.ok(rel(c.state.results.summary.C.value, (w1 * e1.v + w2 * e2.v) / (w1 + w2)) < 1e-12);
  // invalid custom gas: paused, results kept
  st.gas = 'custom'; st.custom = { M: -1, eta20: 1e-5, omega: 0.7, gamma: 1.4, Cd: 0.8 };
  c.conditionsChanged();
  assert.ok(c.state.gasError);
  assert.equal(c.enableState().reason, 'Paused: fix the gas data above.');
  assert.ok(c.state.results);
  st.gas = 'N2'; st.T = 293.15; st.custom = null;
  c.conditionsChanged();
  assert.equal(c.state.gasError, null);
  assert.ok(rel(c.state.results.summary.C.value, C0) < 1e-12, 'back to the original gas');
  // a name change keeps the results; a role change clears them
  c.setName(1, 'Flange');
  assert.ok(c.state.results);
  assert.equal(c.state.results.ports[1].name, 'Flange');
  c.setRole(1, 'closed');
  assert.equal(c.state.results, null);
  assert.equal(c.enableState().ok, false);
});

test('controller: pumps — speed becomes a sticking coefficient for the scene; a gas change then clears the counts', async () => {
  const { c, worker, st } = makeController();
  await c.loadBuiltin('rect');
  await until(() => c.state.sceneReady);
  c.setRole(1, 'pump');
  const p = c.state.ports[1];
  assert.equal(p.pumpBy, 'stick');
  assert.equal(p.stick, 1, 'a new pump starts as a perfect one');
  const A = 4e-4, G = c.state.G, Smax = A * G.vbar / 4;
  c.setPump(1, { by: 'speed' });
  assert.ok(rel(p.speed, Smax) < 1e-12, 'switching to speed keeps the same pump');
  c.setPump(1, { speed: 0.4 * Smax });
  await until(() => c.state.sceneReady);
  const spec = worker.specs.find((x) => x.id === 1);
  assert.ok(Math.abs(spec.stick - 0.4) < 1e-12);
  assert.equal(spec.speed, null);
  await c.run({ seed: '3' });
  const r = c.state.results;
  assert.ok(r.summary.Seff && !r.summary.C, 'a pump gives S_eff');
  assert.equal(r.perSource.length, 1, 'pumps never launch');
  assert.match(cad.statusLine({ particles: r.particles, final: true }), /particles/);
  // speed above the maximum
  c.setPump(1, { speed: 2 * Smax });
  assert.equal(c.state.results, null, 'a pump change clears');
  assert.match(c.enableState().reason, /above the molecular-flow maximum/);
  c.setPump(1, { speed: 0.4 * Smax });
  await until(() => c.state.sceneReady);
  await c.run({ seed: '3' });
  assert.ok(c.state.results);
  st.gas = 'Ar';
  c.conditionsChanged();
  assert.equal(c.state.results, null, 'the sticking coefficient follows the gas: the counts are stale');
  await until(() => c.state.sceneReady);
  const spec2 = worker.specs.find((x) => x.id === 1);
  assert.ok(Math.abs(spec2.stick - 0.4 * G.vbar / c.state.G.vbar) < 1e-12, 'new stick for argon');
  // by sticking coefficient: a gas change only recomputes
  c.setPump(1, { by: 'stick', stick: 0.5 });
  await until(() => c.state.sceneReady);
  await c.run({ seed: '4' });
  const S0 = c.state.results.summary.Seff.value, vb = c.state.G.vbar;
  st.gas = 'N2';
  c.conditionsChanged();
  assert.ok(c.state.results);
  assert.ok(rel(c.state.results.summary.Seff.value, S0 * c.state.G.vbar / vb) < 1e-12);
});

test('controller: Select region adds a coplanar face as an opening; Auto-detect restores the defaults', async () => {
  const { c } = makeController();
  await c.loadBuiltin('rect');
  await until(() => c.state.sceneReady);
  await c.pickRegion(3);
  assert.equal(c.state.pending, null, 'no selection unless Select region is on');
  c.setSelecting(true);
  await c.pickRegion(130);
  assert.equal(c.state.message.text, 'That face is already an opening.');
  await c.pickRegion(0);
  const pd = c.state.pending;
  assert.ok(pd && pd.tris.length === 2 * M * M);
  assert.ok(Math.abs(pd.area - A_SIDE * L_DUCT) < 1e-15);
  const vt = c.viewTriPort();
  assert.equal(vt[pd.tris[0]], cad.SELECTION_ID);
  assert.equal(c.viewPortColors()[cad.SELECTION_ID], '--c2');
  const port = c.addPending();
  assert.equal(port.kind, 'region');
  assert.equal(port.role, 'outlet', 'there is already an inlet');
  assert.equal(c.state.ports.length, 3);
  await until(() => c.state.sceneReady);
  assert.equal(c.viewTriPort()[pd.tris[0]], port.id);
  await c.pickRegion(pd.tris[1]);
  assert.match(c.state.message.text, /already part of/);
  c.removePort(port.id);
  assert.equal(c.state.ports.length, 2);
  c.setRole(0, 'closed');
  c.autoDetect();
  assert.deepEqual(c.state.ports.map((p) => p.role), ['inlet', 'outlet']);
});

test('controller: Stop keeps partial results marked stopped; a leak error keeps the partial counts', async () => {
  const slow = new StubRunner({ batches: 50, perBatch: 500, pauseMs: 5 });
  const { c } = makeController({ runner: slow });
  await c.loadBuiltin('rect');
  await until(() => c.state.sceneReady);
  const done = c.run({ seed: '1' });
  await until(() => c.state.live && c.state.live.progress);
  assert.equal(c.state.running, true);
  assert.equal(c.enableState().ok, false);
  c.setRole(1, 'closed');
  assert.equal(c.state.ports[1].role, 'outlet', 'roles are locked during a run');
  c.stop();
  await done;
  assert.equal(c.state.running, false);
  assert.ok(c.state.results.stopped);
  assert.ok(c.state.results.particles < 50 * 500 * 2);
  // leaks
  const leaky = new StubRunner({ batches: 1, perBatch: 500, failWith: 'Particles are escaping through a gap in the mesh (250 per million rays). Check the open edges listed in the mesh report.' });
  const k = makeController({ runner: leaky });
  await k.c.loadBuiltin('rect');
  await until(() => k.c.state.sceneReady);
  await k.c.run({ seed: '1' });
  assert.equal(k.c.state.results.reason, 'leaks');
  assert.equal(k.c.state.message.level, 'error');
  assert.match(k.c.state.message.text, /escaping through a gap/);
});

test('controller: another tab’s run blocks Run; a bad seed is refused', async () => {
  const runner = new StubRunner();
  const { c } = makeController({ runner });
  await c.loadBuiltin('rect');
  await until(() => c.state.sceneReady);
  runner._busy = true;
  await c.run();
  assert.equal(c.state.message.text, 'Another simulation is running (Stop it first)');
  assert.equal(c.state.results, null);
  runner._busy = false;
  await c.run({ seed: 'abc' });
  assert.match(c.state.message.text, /seed must be a whole number/);
  await c.run({ seed: '' });
  assert.ok(c.state.results, 'blank seed = random');
  assert.ok(Number.isInteger(runner.calls[runner.calls.length - 1].opts.seed));
});

test('controller: files — triangle caps, the unit rescales a file, a built-in only changes the shown numbers', async () => {
  const big = makeController({ prepOpts: { nTriParsed: 250001 } });
  await big.c.loadFile({ name: 'big.stl', buffer: new ArrayBuffer(84) });
  assert.match(big.c.state.message.text, /This model has 250 001 triangles; the limit is 250/);
  assert.equal(big.c.state.prepared, null);
  const phone = makeController({ phone: true, prepOpts: { nTriParsed: 100001 } });
  await phone.c.loadFile({ name: 'p.stl', buffer: new ArrayBuffer(84) });
  assert.match(phone.c.state.message.text, /phones are limited to 100/);
  const { c, worker } = makeController();
  await c.loadFile({ name: 'part.stl', buffer: new ArrayBuffer(84) });
  await until(() => c.state.sceneReady);
  assert.equal(worker.log.find((m) => m.type === 'parse').scale, 1e-3);
  assert.equal(c.state.source.format, 'stl-binary');
  await c.run({ seed: '5' });
  assert.ok(c.state.results);
  await c.setUnit('in');
  assert.equal(worker.log.filter((m) => m.type === 'parse').pop().scale, 0.0254, 're-parsed in inches');
  assert.equal(c.state.results, null, 'a unit change rescales the file and clears the results');
  await until(() => c.state.sceneReady);
  // built-in: keep
  await c.loadBuiltin('rect');
  await until(() => c.state.sceneReady);
  await c.run({ seed: '5' });
  await c.setUnit('cm');
  assert.ok(c.state.results, 'a built-in keeps its size and its results');
  assert.equal(c.state.unit, 'cm');
});

test('controller: project save → open restores the openings, run options and stored results without re-running', async () => {
  const { c, runner, st } = makeController();
  await c.loadBuiltin('rect');
  await until(() => c.state.sceneReady);
  c.setName(1, 'Exit flange');
  c.state.runOpts.target = 0.003;
  c.state.runOpts.maxTime = 300;
  c.state.runOpts.favorSmall = true;
  await c.run({ seed: '99' });
  const C0 = c.state.results.summary.C.value;
  const text = await c.exportProject();
  const pj = parseProject(text);
  assert.equal(pj.source.kind, 'builtin');
  assert.equal(pj.source.name, 'rect');
  assert.equal(pj.mesh, null);
  assert.equal(pj.ports[1].name, 'Exit flange');
  assert.equal(pj.run.target, 0.003);
  assert.equal(pj.run.maxTime, 300);
  assert.equal(pj.run.seed, 99);
  assert.equal(pj.run.allocation, 'favor-small');
  assert.equal(pj.results.perSource.length, 2);
  assert.equal(pj.results.hits.length, 132);
  // open in a fresh controller with another gas set on the page
  const k = makeController({ settings: { gas: 'He', T: 400, custom: null, Cd: null } });
  let applied = null;
  await k.c.openProject(text, { applyConditions: (cond) => { applied = cond; Object.assign(k.st, { gas: cond.gas, T: cond.T, custom: cond.custom }); } });
  assert.deepEqual(applied, { gas: 'N2', T: 293.15, custom: null });
  const s = k.c.state;
  assert.ok(s.results && s.results.fromProject);
  assert.equal(k.runner.calls.length, 0, 'no re-run');
  assert.ok(rel(s.results.summary.C.value, C0) < 1e-12);
  assert.equal(s.ports[1].name, 'Exit flange');
  assert.equal(s.runOpts.target, 0.003);
  assert.equal(s.runOpts.favorSmall, true);
  assert.ok(k.c.pressureMap({ average: true }).valid > 0, 'stored hits give the pressure map');
  // save again: identical apart from the time stamp
  const again = await k.c.exportProject();
  assert.equal(again.replace(/"saved": "[^"]*"/, ''), text.replace(/"saved": "[^"]*"/, ''));
  // a damaged file
  await k.c.openProject('{"format":"nope"}');
  assert.equal(k.c.state.message.text, 'This file is not a Conductance Lab CAD project.');
  void runner; void st;
});

// ================================================================ pressure helpers
test('wall pressure by hand: p/p_in = (h/A)/(Σ N_i/A_i); fewer than 10 hits is no data', () => {
  const areas = Float64Array.from([1, 2, 0.5, 1]);
  const hits = Uint32Array.from([100, 9, 30, 0]);
  const triPort = Int16Array.from([-1, -1, -1, 0]);
  const { p, valid, norm } = cad.wallPressureValues({ hits, areas, triPort, inletLaunches: [{ port: 0, n: 1000 }], portAreas: [4] });
  assert.equal(norm, 250);
  assert.ok(Math.abs(p[0] - 100 / (1 * 250)) < 1e-15);
  assert.ok(Number.isNaN(p[1]), '9 hits');
  assert.ok(Math.abs(p[2] - 30 / (0.5 * 250)) < 1e-15);
  assert.ok(Number.isNaN(p[3]), 'ports have no wall pressure');
  assert.equal(valid, 2);
  // patches: the sum over the patch
  const avg = cad.wallPressureValues({ hits, areas, triPort, inletLaunches: [{ port: 0, n: 1000 }], portAreas: [4], patches: Int32Array.from([0, 0, 1, -1]) });
  assert.ok(Math.abs(avg.p[0] - 109 / (3 * 250)) < 1e-15);
  assert.equal(avg.p[0], avg.p[1], 'a patch shares one value (and its hit count)');
  const none = cad.wallPressureValues({ hits, areas, triPort, inletLaunches: [], portAreas: [4] });
  assert.equal(none.valid, 0);
});

test('coplanar patches: flat faces join, bends separate, long strips are cut along their length', () => {
  const pos = ductPositions(0.02, 0.02, 4);
  const ids = cad.trianglePatches(pos, { cells: 1 });
  // with one cell per diagonal, each wall face is one patch: 4 patches
  assert.equal(new Set(ids).size, 4);
  for (let t = 0; t < ids.length; t += 2) assert.equal(ids[t], ids[t + 1], 'a quad stays together');
  // with finer cells the faces split into several patches, never across a corner
  const fine = cad.trianglePatches(pos, { cells: 10 });
  assert.ok(new Set(fine).size > 4);
  // positions are Float32: compare the far faces with the Float32 value of 0.02
  const A32 = Math.fround(0.02);
  const faceOf = (t) => {
    const o = 9 * t, all = (k, v) => pos[o + k] === v && pos[o + 3 + k] === v && pos[o + 6 + k] === v;
    return all(0, 0) ? 'x0' : all(0, A32) ? 'x1' : all(1, 0) ? 'y0' : all(1, A32) ? 'y1' : '?';
  };
  const faceOfPatch = new Map();
  for (let t = 0; t < fine.length; t++) {
    const f = faceOf(t);
    if (faceOfPatch.has(fine[t])) assert.equal(faceOfPatch.get(fine[t]), f);
    else faceOfPatch.set(fine[t], f);
  }
  // a long strip (tube facet) is cut along its length by the default grid
  const strip = [];
  for (let j = 0; j < 40; j++) { const z0 = j / 40, z1 = (j + 1) / 40; strip.push(0, 0, z0, 0.01, 0, z0, 0.01, 0, z1, 0, 0, z0, 0.01, 0, z1, 0, 0, z1); }
  const sp = cad.trianglePatches(Float32Array.from(strip));
  assert.ok(new Set(sp).size >= 30, 'the gradient along a strip survives: ' + new Set(sp).size + ' patches');
  // degenerate triangles get no patch
  const deg = cad.trianglePatches(Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]));
  assert.equal(deg[0], -1);
});

test('pressure colours and axis helpers', () => {
  const pc = cad.pressureColors(Float64Array.from([1, 0.01, NaN]));
  assert.equal(pc.scale.min, 0.01);
  assert.ok(Number.isNaN(pc.rgb[6]));
  assert.ok(Math.abs(pc.rgb[0] - 0xfd / 255) < 1e-6, 'p = p_in is the top of the scale');
  const scene = { ports: [{ role: 'inlet', inward: [0, 0, 1] }, { role: 'outlet', inward: [-1, 0, 0] }] };
  assert.equal(cad.isBent(scene, 0, 1), true);
  scene.ports[1].inward = [0, 0, -1];
  assert.equal(cad.isBent(scene, 0, 1), false);
  assert.deepEqual(cad.scenePortIndices({ ports: [{ role: 'outlet' }, { role: 'inlet' }, { role: 'pump' }] }), { inlet: 1, outlet: 0, pump: 2 });
  assert.deepEqual(cad.scenePortIndices({ ports: [{ role: 'inlet' }, { role: 'pump' }] }), { inlet: 0, outlet: 1, pump: 1 });
  assert.equal(cad.clausingOverlay({ kind: 'builtin', name: 'tube', params: {} }), null, 'the default tube is L/R = 10');
  const cl = cad.clausingOverlay({ kind: 'builtin', name: 'tube', params: { d: 0.04, L: 0.4 } });
  assert.equal(cl.zOverL.length, 6);
  assert.equal(cl.value[0], 0.9273);
  assert.equal(cad.clausingOverlay({ kind: 'file', name: 'tube' }), null);
});

// ================================================================ 2D profiles (P2)
import { readFileSync } from 'node:fs';
import { compileBlock, runChainBlock } from '../../beta/conductance/js/engine/chain-mc.js';
import { combinePlan } from '../../beta/conductance/js/engine/chain-scene.js';
import { molecularLimit } from '../../beta/conductance/js/engine/network.js';

const FIX = new URL('./fixtures/wp3/', import.meta.url);

/** A stub McRunner for chain plans: WP2's chain kernel in-process, inlet launches only. */
class StubChainRunner {
  constructor() { this._busy = false; this.calls = []; }
  get busy() { return this._busy; }
  get workers() { return 2; }
  stop() {}
  async runChain(plan, G, opts) {
    this._busy = true;
    this.calls.push({ plan, G, opts });
    try {
      const blocks = plan.blocks.filter((b) => b.cells.length).map((b, k) => {
        const r = runChainBlock(compileBlock(b), 40000, (opts.seed + 31 * k) >>> 0);
        return { id: b.id, in: { n: r.n, trans: r.trans }, out: null, n: r.n, trans: r.trans, casts: r.casts };
      });
      const c = combinePlan(plan, blocks, G);
      const particles = blocks.reduce((a, b) => a + b.n, 0), casts = blocks.reduce((a, b) => a + b.casts, 0);
      opts.onProgress({ kind: 'chain', elapsed: 0.1, particles, casts, castsPerSec: casts / 0.1, value: c.value, sigma: c.sigma, ci95: c.ci95,
        relHalfWidth: 1.96 * c.sigma / c.value, etaSeconds: 0, history: [{ n: particles, value: c.value, lo: c.ci95[0], hi: c.ci95[1] }], final: true });
      return { value: c.value, sigma: c.sigma, ci95: c.ci95, kind: c.kind, blocks, particles, casts, ms: 100, stopped: false, reason: 'target', seed: opts.seed };
    } finally { this._busy = false; }
  }
}

test('latheMesh: walls revolved about z, caps as discs or rings with the right areas', () => {
  // tube r 20 mm, 0…100 mm, then a cone to r 34.56 mm at 140 mm
  const lathe = Float64Array.from([0.02, 0, 0.02, 0.1, 0.0345588, 0.14]);
  const m = cad.latheMesh(lathe, 64);
  const nWall = 2 * 64 * 2, nCap = 64 + 64;
  assert.equal(m.positions.length / 9, nWall + nCap);
  assert.equal(m.triPort.filter((p) => p === -1).length, nWall);
  assert.equal(m.triPort.filter((p) => p === 0).length, 64);
  assert.ok(rel(m.inletArea, Math.PI * 0.02 ** 2) < 1e-12);
  assert.ok(rel(m.outletArea, Math.PI * 0.0345588 ** 2) < 1e-12);
  // the cap triangles are the 64-gon of the radius: their area is within 0.2 % of the circle
  const A = cad.triangleAreas(m.positions);
  let a0 = 0; m.triPort.forEach((p, t) => { if (p === 0) a0 += A[t]; });
  assert.ok(rel(a0, m.inletArea) < 2e-3);
  // an annulus: rod r 10 mm over the whole length gives rings at both ends
  const ann = cad.latheMesh(Float64Array.from([0.02, 0, 0.02, 0.02, NaN, NaN, 0.01, 0, 0.01, 0.02]), 32);
  assert.ok(rel(ann.inletArea, Math.PI * (0.02 ** 2 - 0.01 ** 2)) < 1e-12);
  assert.equal(ann.triPort.filter((p) => p === 1).length, 64, 'a ring is two triangles per facet');
  assert.equal(cad.profileFormat('a.SVG', ''), 'svg');
  assert.equal(cad.profileFormat('x', '<?xml version="1.0"?><svg width="1">'), 'svg');
  assert.equal(cad.profileFormat('x', '0\nSECTION'), 'dxf');
  assert.equal(cad.profileScale('mm', 'in'), 1e-3);
  assert.equal(cad.profileScale('in', 'mm'), 0.0254);
  assert.equal(cad.profileScale(null, 'cm'), 0.01);
});

test('controller: a 2D profile becomes items and a lathe, simulates exactly by the chain MC and follows the gas', async () => {
  const runner = new StubChainRunner();
  const { c, st } = makeController({ runner });
  const text = readFileSync(new URL('tube-cone-mm.svg', FIX), 'utf8');
  await c.loadProfile({ name: 'tube-cone-mm.svg', text });
  const s = c.state;
  assert.equal(s.phase, 'profile');
  assert.equal(s.unit, 'mm', 'the drawing states millimetres');
  assert.deepEqual(s.profile.items.map((i) => i.t), ['tube', 'cone']);
  assert.ok(Math.abs(s.profile.items[0].d - 0.04) < 1e-12 && Math.abs(s.profile.items[0].L - 0.1) < 1e-12);
  assert.equal(s.message.level, 'warn', 'the ignored text element is reported');
  assert.equal(c.viewTriPort(), s.profileTriPort);
  assert.equal(c.viewTriPort().length, s.allPositions.length / 9);
  assert.deepEqual(c.viewPortColors(), { 0: '--c3', 1: '--c1' });
  assert.ok(Math.abs(s.profile.bbox[5] - s.profile.bbox[2] - 0.14) < 1e-9);
  assert.equal(cad.profileBboxText(s.profile.bbox, 'mm', 2), '140.0 mm long, Ø69.12 mm · 2 elements');
  assert.deepEqual(c.enableState(), { ok: true, reason: '' });
  await assert.rejects(c.exportProject(), /not saved as a project/);
  await c.run({ seed: '11' });
  const r = s.results;
  assert.equal(r.kind, 'chain');
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].plan.kind, 'C', 'a line between two pressures');
  // the exact chain value is near the Haefer formula (one dissimilar junction: within about +3 %)
  const Cf = molecularLimit(s.profile.items, s.G).Cline;
  assert.ok(Math.abs(r.formula.C / Cf - 1) < 1e-12);
  assert.ok(r.value / Cf - 1 > -0.02 && r.value / Cf - 1 < 0.06, 'MC/formula − 1 = ' + (r.value / Cf - 1));
  assert.ok(r.ci95[0] < r.value && r.ci95[1] > r.value);
  // a gas change recomputes from the counts: C ∝ v̄
  const C0 = r.value, v0 = s.G.vbar;
  st.gas = 'Ar';
  c.conditionsChanged();
  assert.ok(s.results, 'kept');
  assert.ok(rel(s.results.value, C0 * s.G.vbar / v0) < 1e-12);
  // the axis option re-converts and clears the results
  c.setProfileAxis('zero');
  assert.equal(s.results, null);
  // this drawing's axis is not at the page's y = 0, so that reading is refused; back to the lowest line restores it
  assert.equal(s.profile.items, null);
  assert.match(s.message.text, /not a simple axisymmetric passage/);
  assert.equal(c.enableState().ok, false);
  c.setProfileAxis('min');
  assert.deepEqual(s.profile.items.map((i) => i.t), ['tube', 'cone']);
  assert.equal(c.enableState().ok, true);
  // a DXF in inches
  await c.loadProfile({ name: 'tube-in.dxf', text: readFileSync(new URL('tube-in.dxf', FIX), 'utf8') });
  assert.equal(s.unit, 'in');
  assert.ok(Math.abs(s.profile.items[0].d - 0.0508) < 1e-12 && Math.abs(s.profile.items[0].L - 0.1016) < 1e-12);
  // a doubled-back path is refused with the spec's sentence, and the view is cleared
  await c.loadProfile({ name: 'doubled-back.svg', text: readFileSync(new URL('doubled-back.svg', FIX), 'utf8') });
  assert.equal(s.message.level, 'error');
  assert.match(s.message.text, /not a simple axisymmetric passage/);
  assert.equal(s.allPositions, null);
  assert.equal(c.enableState().ok, false);
  // a built-in afterwards leaves profile mode
  await c.loadBuiltin('rect');
  await until(() => c.state.sceneReady);
  assert.equal(s.profile, null);
  assert.equal(s.phase, 'ready');
});

// ---- v2.2 fix round 1: the reference row shows the reference; this run's α goes to the note
test('referenceRow puts the reference α in the value and this run in the note', () => {
    const r = cad.referenceRow({ alpha: 0.26524, sigma: 0.00021, source: 'TPMC, this work' }, 0.2649, 0.0008);
    assert.equal(r.value, '0.26524 ± 0.00021');
    assert.match(r.note, /^Reference: TPMC, this work\. This run: 0\.2649\d*, −0\.1\d %/);
    assert.deepEqual(cad.referenceRow(null, 0.2, 0.1), { value: '', note: '' });
});
