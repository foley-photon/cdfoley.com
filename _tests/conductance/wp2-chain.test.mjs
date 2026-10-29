// WP2: analytic chain Monte Carlo — apertures, kernel, chain plans of the presets (Appendix B.3), combination,
// and the chain validation cases at quick N (spec §2.11, §3.6.2, §5.3; §7.3 acceptance 3).
// The full-N run of the same cases is in run-validation.mjs (spec §5.4: long Monte Carlo stays out of node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apInside, apArea, apIntersectArea, cellApertures, mirrorBlock, makeBlock, compileBlock, runChainBlock,
} from '../../beta/conductance/js/engine/chain-mc.js';
import { chainPlan, combinePlan, reverseBlock } from '../../beta/conductance/js/engine/chain-scene.js';
import { createService } from '../../beta/conductance/js/engine/tpmc-service.js';
import { McRunner } from '../../beta/conductance/js/engine/mc-runner.js';
import { MC_CASES } from '../../beta/conductance/js/engine/validation-mc.js';
import { gasState } from '../../beta/conductance/js/engine/gas.js';
import { evaluate } from '../../beta/conductance/js/engine/validation.js';
import { makeRng } from '../../beta/conductance/js/engine/rng.js';

const N2 = gasState('N2', 293.15), AIR = gasState('air', 293.15);
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);
const rel = (a, b, r, msg) => assert.ok(Math.abs(a / b - 1) <= r, `${msg || ''} ${a} vs ${b}`);
const disc = (r) => ({ kind: 'disc', r });

// a Worker-like object that runs the service on this thread (messages are structured-cloned, as between threads)
function inProcessWorker() {
  const w = { onmessage: null, onerror: null, dead: false };
  const svc = createService((msg) => setImmediate(() => { if (!w.dead && w.onmessage) w.onmessage({ data: msg }); }));
  w.postMessage = (msg) => { const m = structuredClone(msg); setImmediate(() => { if (!w.dead) svc.onMessage(m); }); };
  w.terminate = () => { w.dead = true; };
  return w;
}

test('aperture inside tests and areas', () => {
  assert.ok(apInside(null, 5, 5));
  assert.ok(apInside(disc(1), 0.6, 0.8) && !apInside(disc(1), 0.6, 0.81));
  const ring = { kind: 'ring', ri: 0.5, ro: 1 };
  assert.ok(apInside(ring, 0.7, 0) && !apInside(ring, 0.4, 0) && !apInside(ring, 1.1, 0));
  const rect = { kind: 'rect', a: 2, b: 1 };
  assert.ok(apInside(rect, 1, 0.5) && !apInside(rect, 1.01, 0));
  close(apArea(disc(2)), 4 * Math.PI, 1e-15);
  close(apArea(ring), 0.75 * Math.PI, 1e-15);
  assert.equal(apArea(rect), 2);
});

test('intersection areas of centred apertures (exact, checked by sampling)', () => {
  const ring = { kind: 'ring', ri: 0.3, ro: 0.9 };
  close(apIntersectArea(disc(1), disc(0.5)), Math.PI * 0.25, 1e-15);
  close(apIntersectArea(disc(0.5), ring), Math.PI * (0.25 - 0.09), 1e-15);
  assert.equal(apIntersectArea({ kind: 'rect', a: 2, b: 1 }, { kind: 'rect', a: 1, b: 3 }), 1);
  close(apIntersectArea(disc(1), { kind: 'rect', a: 4, b: 4 }), Math.PI, 1e-14);
  close(apIntersectArea(disc(1), { kind: 'rect', a: 1, b: 1 }), 1, 1e-15);
  assert.equal(apIntersectArea(disc(1), null), Math.PI);
  // a disc crossed by a long slit, and a ring crossed by a rectangle, against 4·10⁶ uniform samples
  const rng = makeRng(9);
  for (const [p, q, box] of [[disc(1), { kind: 'rect', a: 0.4, b: 3 }, 1.5], [ring, { kind: 'rect', a: 1.2, b: 0.5 }, 1]]) {
    let hit = 0;
    const n = 4e6;
    for (let i = 0; i < n; i++) {
      const u = (2 * rng() - 1) * box, v = (2 * rng() - 1) * box;
      if (apInside(p, u, v) && apInside(q, u, v)) hit++;
    }
    const est = hit / n * 4 * box * box, sig = Math.sqrt(hit) / n * 4 * box * box;
    close(apIntersectArea(p, q), est, 4 * sig, 'sampled area');
  }
});

test('compileBlock validates its input', () => {
  assert.throws(() => compileBlock({ cells: [{ type: 'tube', R: -1, L: 1 }], plates: [] }), RangeError);
  assert.throws(() => compileBlock({ cells: [{ type: 'hose', R: 1, L: 1 }], plates: [] }), RangeError);
  assert.throws(() => compileBlock({ cells: [{ type: 'elbow', R: 1, A: 0.5, B: 2 }], plates: [] }), /leg/);
  assert.throws(() => compileBlock({ cells: [{ type: 'annulus', Ri: 1, Ro: 1, L: 1 }], plates: [] }), RangeError);
  assert.throws(() => compileBlock({ cells: [], plates: [null] }), RangeError);
  assert.throws(() => compileBlock({ cells: [{ type: 'tube', R: 1, L: 1 }], plates: [], outlet: { stick: 1.5 } }), RangeError);
  const cb = compileBlock(makeBlock({ cells: [{ type: 'tube', R: 1, L: 1 }], outlet: { stick: 0.5 } }));
  assert.throws(() => runChainBlock(cb, 10, 1, { reverse: true }), RangeError);
});

test('runChainBlock: deterministic counts, bookkeeping, scale invariance and the bounce cap', () => {
  const block = makeBlock({ cells: [{ type: 'tube', R: 1, L: 10 }] });
  const cb = compileBlock(block);
  const a = runChainBlock(cb, 20000, 42), b = runChainBlock(cb, 20000, 42);
  assert.deepEqual(a, b);
  assert.equal(a.n + a.stuck, 20000);
  assert.equal(a.trans + a.back, a.n);
  assert.equal(a.src, 'in');
  assert.ok(a.casts >= a.n);
  // α is scale-free: the same block in millimetres gives the same counts
  const mm = compileBlock(makeBlock({ cells: [{ type: 'tube', R: 0.001, L: 0.01 }] }));
  assert.deepEqual(runChainBlock(mm, 20000, 42), a);
  // bounce cap: stuck particles are excluded from n
  const s = runChainBlock(compileBlock(makeBlock({ cells: [{ type: 'tube', R: 1, L: 100 }] })), 2000, 3, { maxBounces: 5 });
  assert.ok(s.stuck > 0);
  assert.equal(s.n + s.stuck, 2000);
  assert.equal(s.trans + s.back, s.n);
  // a lone aperture transmits everything; a partial outlet absorbs with its sticking probability
  const lone = compileBlock(makeBlock({ cells: [], plates: [disc(0.5)] }));
  assert.deepEqual(runChainBlock(lone, 1000, 1), { n: 1000, trans: 1000, back: 0, stuck: 0, casts: 0, src: 'in' });
  const half = runChainBlock(compileBlock(makeBlock({ cells: [], plates: [disc(0.5)], outlet: { stick: 0.25 } })), 1e5, 2);
  close(half.trans / half.n, 0.25, 4 * Math.sqrt(0.25 * 0.75 / 1e5));
});

test('chain kernel reproduces reference cases in both directions (2·10⁵ particles, |z| < 3.5)', () => {
  const deg = Math.PI / 180;
  const cases = [
    [[{ type: 'tube', R: 2, L: 4 }, { type: 'tube', R: 1, L: 4 }], [], 0.08445, 0.0002],
    [[{ type: 'tube', R: 1, L: 1 }, { type: 'tube', R: 1, L: 1 }], [null, disc(0.5)], 0.21433, 0.00029],
    [[{ type: 'cone', R1: 1, R2: 1 + 4 * Math.tan(-10 * deg), L: 4 }], [], 0.04941, 0.00015],
    [[{ type: 'tube', R: 1, L: 1 }, { type: 'elbow', R: 1, A: 1, B: 1 }, { type: 'tube', R: 1, L: 1 }], [], 0.35147, 0.00034],
    [[{ type: 'annulus', Ri: 0.5, Ro: 1, L: 1 }], [], 0.52877, 0.00035],
    [[{ type: 'rect', a: 1, b: 1, L: 1 }], [], 0.53622, 0.00035],
  ];
  for (const [cells, plates, ref, sig] of cases) {
    const block = makeBlock({ cells, plates });
    const cb = compileBlock(block), N = 2e5;
    const f = runChainBlock(cb, N, 11), r = runChainBlock(cb, N, 12, { reverse: true });
    assert.equal(r.src, 'out');
    const af = f.trans / f.n, sf = Math.sqrt(af * (1 - af) / f.n);
    const ar = r.trans / r.n * block.Aout / block.Ain, sr = Math.sqrt((r.trans / r.n) * (1 - r.trans / r.n) / r.n) * block.Aout / block.Ain;
    assert.ok(Math.abs(af - ref) < 3.5 * Math.hypot(sf, sig), `forward ${cells.map((c) => c.type)} ${af} vs ${ref}`);
    assert.ok(Math.abs(ar - ref) < 3.5 * Math.hypot(sr, sig), `reverse ${cells.map((c) => c.type)} ${ar} vs ${ref}`);
  }
});

test('reverseBlock mirrors cells, plates and areas, and refuses pump blocks', () => {
  const block = makeBlock({
    id: 3, cells: [{ type: 'cone', R1: 1, R2: 2, L: 3 }, { type: 'elbow', R: 2, A: 2, B: 5 }, { type: 'rect', a: 1, b: 2, L: 1 }],
    plates: [disc(0.8), null, { kind: 'rect', a: 0.5, b: 1 }, null],
  });
  const r = reverseBlock(block);
  assert.deepEqual(r.cells, [{ type: 'rect', a: 1, b: 2, L: 1 }, { type: 'elbow', R: 2, A: 5, B: 2 }, { type: 'cone', R1: 2, R2: 1, L: 3 }]);
  assert.deepEqual(r.plates, [null, { kind: 'rect', a: 0.5, b: 1 }, null, disc(0.8)]);
  assert.equal(r.Ain, block.Aout); assert.equal(r.Aout, block.Ain);
  assert.equal(r.outlet, null);
  assert.deepEqual(mirrorBlock(r).cells, block.cells);
  assert.throws(() => reverseBlock({ ...block, outlet: { stick: 0.3 } }), RangeError);
  assert.doesNotThrow(() => reverseBlock({ ...block, outlet: { stick: 1 } }));
  assert.deepEqual(cellApertures({ type: 'cone', R1: 1, R2: 2, L: 1 }), { apIn: disc(1), apOut: disc(2) });
});

const PRESETS = [
  [N2, 'pump', [{ t: 'tube', d: 0.1, L: 0.2 }, { t: 'elbow', d: 0.1, A: 0.1, B: 0.1 }, { t: 'pump', S: 0.3, d: 0.1, label: 'Turbo' }]],
  [AIR, 'pump', [{ t: 'tube', d: 0.1, L: 0.2 }, { t: 'pump', S: 0.3, d: 0.1, label: 'Pump' }]],
  [AIR, 'pump', [{ t: 'tube', d: 0.025, L: 1 }, { t: 'pump', S: 0.009722222, d: 0.025, label: 'Rotary_vane' }]],
  [N2, 'pump', [{ t: 'tube', d: 0.04, L: 0.15 }, { t: 'bbox', C: 0.08, gasRef: 'N2', d: 0.04, label: 'Gate_valve' }, { t: 'cone', d1: 0.04, d2: 0.063, L: 0.05 }, { t: 'pump', S: 0.08, d: 0.063, label: 'Turbo' }]],
  [N2, 'dp', [{ t: 'orifice', shape: 'circle', d: 0.001 }]],
  [AIR, 'dp', [{ t: 'slit', h: 0.0001, w: 0.05, L: 0.01 }]],
  [N2, 'pump', [{ t: 'tube', d: 0.05, L: 0.1 }, { t: 'parallel', branches: [[{ t: 'tube', d: 0.02, L: 0.3 }], [{ t: 'tube', d: 0.03, L: 0.5 }, { t: 'elbow', d: 0.03, A: 0.05, B: 0.05 }]] }, { t: 'pump', S: 0.05, d: 0.05, label: 'Turbo' }]],
];
const plan = (k) => chainPlan(PRESETS[k][2], PRESETS[k][0], { bc: { mode: PRESETS[k][1], p0: 1e-4, p1: 1e-6 } });
const cellsClose = (got, want) => {
  assert.equal(got.length, want.length);
  got.forEach((c, i) => {
    assert.equal(c.type, want[i].type);
    for (const k of Object.keys(want[i])) if (k !== 'type') close(c[k], want[i][k], 5e-7, `${c.type}.${k}`);
  });
};

test('chainPlan maps the 7 presets to the block lists of Appendix B.3', () => {
  const p1 = plan(0);
  assert.equal(p1.kind, 'Seff');
  assert.deepEqual(p1.tree, { k: 'pumpBlock', id: 0 });
  cellsClose(p1.blocks[0].cells, [{ type: 'tube', R: 0.05, L: 0.2 }, { type: 'elbow', R: 0.05, A: 0.1, B: 0.1 }]);
  close(p1.blocks[0].outlet.stick, 0.32460, 5e-6);
  assert.ok(p1.blocks[0].plates.every((x) => x === null));
  const p2 = plan(1);
  cellsClose(p2.blocks[0].cells, [{ type: 'tube', R: 0.05, L: 0.2 }]);
  close(p2.blocks[0].outlet.stick, 0.33006, 5e-6);
  const p3 = plan(2);
  cellsClose(p3.blocks[0].cells, [{ type: 'tube', R: 0.0125, L: 1 }]);
  close(p3.blocks[0].outlet.stick, 0.17114, 5e-6);
  const p4 = plan(3);
  cellsClose(p4.blocks[0].cells, [{ type: 'tube', R: 0.02, L: 0.15 }, { type: 'tube', R: 0.02, L: 0.035692 }, { type: 'cone', R1: 0.02, R2: 0.0315, L: 0.05 }]);
  close(p4.blocks[0].outlet.stick, 0.21809, 5e-6);
  assert.equal(p4.blocks[0].plates.length, 4);
  assert.equal(p4.notes.length, 1);
  const p5 = plan(4);
  assert.equal(p5.kind, 'C');
  assert.deepEqual(p5.tree, { k: 'block', id: 0 });
  assert.equal(p5.blocks[0].cells.length, 0);
  assert.deepEqual(p5.blocks[0].plates, [disc(0.0005)]);
  const c5 = combinePlan(p5, [], N2);                     // exact: C = A·v̄/4, σ = 0
  close(c5.value, Math.PI * 0.0005 ** 2 * N2.vbar / 4, 1e-18);
  close(c5.value * 1000, 0.092423, 5e-7, 'C_mol of preset 5 (L/s)');
  assert.equal(c5.sigma, 0);
  const p6 = plan(5);
  assert.equal(p6.kind, 'C');
  cellsClose(p6.blocks[0].cells, [{ type: 'rect', a: 0.0001, b: 0.05, L: 0.01 }]);
  assert.equal(p6.blocks[0].outlet, null);
  const p7 = plan(6);
  assert.equal(p7.blocks.length, 3);
  cellsClose(p7.blocks[0].cells, [{ type: 'tube', R: 0.025, L: 0.1 }]);
  cellsClose(p7.blocks[1].cells, [{ type: 'tube', R: 0.01, L: 0.3 }]);
  cellsClose(p7.blocks[2].cells, [{ type: 'tube', R: 0.015, L: 0.5 }, { type: 'elbow', R: 0.015, A: 0.05, B: 0.05 }]);
  assert.deepEqual(p7.tree, { k: 'series', parts: [{ k: 'block', id: 0 }, { k: 'par', branches: [{ k: 'block', id: 1 }, { k: 'block', id: 2 }] }, { k: 'pump', S: 0.05 }] });
  assert.ok(p7.blocks.every((b) => b.outlet === null));
  assert.deepEqual(p7.blocks.map((b) => b.label), ['Element 1', 'Element 2, branch 1', 'Element 2, branch 2']);
});

test('chainPlan: plates, pump bores, rectangles and unsupported lines', () => {
  // orifice before a tube, and a plate between two tubes
  const a = chainPlan([{ t: 'orifice', shape: 'circle', d: 0.01 }, { t: 'tube', d: 0.02, L: 0.08 }], N2, { bc: { mode: 'dp' } });
  assert.deepEqual(a.blocks[0].plates, [disc(0.005), null]);
  close(a.blocks[0].Ain, Math.PI * 0.005 ** 2, 1e-18);
  const b = chainPlan([{ t: 'tube', d: 2, L: 1 }, { t: 'orifice', shape: 'circle', d: 1 }, { t: 'tube', d: 2, L: 1 }], N2, { bc: { mode: 'dp' } });
  assert.deepEqual(b.blocks[0].plates, [null, disc(0.5), null]);
  // two plates at one junction combine; a rectangular orifice is aligned like the slit after it
  const c = chainPlan([{ t: 'orifice', shape: 'circle', d: 1 }, { t: 'orifice', shape: 'circle', d: 0.5 }, { t: 'tube', d: 2, L: 1 }], N2, { bc: { mode: 'dp' } });
  assert.deepEqual(c.blocks[0].plates[0], disc(0.25));
  const d = chainPlan([{ t: 'orifice', shape: 'rect', w: 0.05, h: 0.0002 }, { t: 'slit', h: 0.0001, w: 0.05, L: 0.01 }], N2, { bc: { mode: 'dp' } });
  assert.deepEqual(d.blocks[0].plates[0], { kind: 'rect', a: 0.0002, b: 0.05 });
  close(d.blocks[0].Ain, 0.0001 * 0.05, 1e-18);
  // a pump bore smaller than the duct adds a plate; a chamber detaches the pump
  const e = chainPlan([{ t: 'tube', d: 0.1, L: 0.2 }, { t: 'pump', S: 0.1, d: 0.063 }], N2, { bc: { mode: 'pump' } });
  assert.deepEqual(e.blocks[0].plates[1], disc(0.0315));
  const f = chainPlan([{ t: 'tube', d: 0.1, L: 0.2 }, { t: 'chamber' }, { t: 'pump', S: 0.1, d: 0.063 }], N2, { bc: { mode: 'pump' } });
  assert.deepEqual(f.tree, { k: 'series', parts: [{ k: 'block', id: 0 }, { k: 'pump', S: 0.1 }] });
  // unsupported lines say why
  const why = (items, mode = 'pump') => chainPlan(items, N2, { bc: { mode } }).unsupported;
  assert.ok(why([{ t: 'pump', S: 0.1, d: 0.1 }])[0].includes('nothing to simulate'));
  assert.ok(why([], 'dp')[0].includes('Add at least one element'));
  assert.ok(why([{ t: 'orifice', shape: 'circle', d: 0.01 }, { t: 'pump', S: 0.01, d: 0.1 }])[0].includes('directly on the pump'));
  assert.ok(why([{ t: 'tube', d: 0.1, L: 0.1 }, { t: 'pump', S: 10, d: 0.1 }])[0].includes('molecular-flow maximum'));
  assert.ok(why([{ t: 'tube', d: 0.1, L: 0.1 }, { t: 'pump', S: 0.1, d: 0.1 }], 'dp')[0].includes('pump'));
  assert.ok(why([{ t: 'tube', d: 0.1, L: 0.1 }])[0].includes('no pump'));
  assert.ok(why([{ t: 'orifice', shape: 'circle', d: 0.03 }, { t: 'orifice', shape: 'rect', w: 0.04, h: 0.01 }, { t: 'tube', d: 0.1, L: 0.1 }], 'dp')[0].includes('different shape'));
  assert.ok(why([{ t: 'tube', d: 0.04, L: 0.1 }, { t: 'bbox', C: 10, gasRef: 'N2', d: 0.04, label: 'x' }], 'dp').length === 1);
  // an orifice right at the pump inlet (smaller than the pump bore) is refused even after a duct
  assert.ok(why([{ t: 'tube', d: 0.1, L: 0.2 }, { t: 'orifice', shape: 'circle', d: 0.05 }, { t: 'pump', S: 0.1, d: 0.1 }])[0].includes('directly on the pump'));
  // ... but one at least as large as the pump bore only adds the pump-bore plate
  const big = chainPlan([{ t: 'tube', d: 0.1, L: 0.2 }, { t: 'orifice', shape: 'circle', d: 0.08 }, { t: 'pump', S: 0.05, d: 0.063 }], N2, { bc: { mode: 'pump' } });
  assert.deepEqual(big.blocks[0].plates[1], disc(0.0315));
  // blocked junctions: a plate hole inside the rod of an annulus, at the start or in the middle of a run
  const rod = { t: 'annulus', di: 0.02, do: 0.04, L: 0.1 };
  assert.ok(why([{ t: 'orifice', shape: 'circle', d: 0.01 }, rod], 'dp')[0].includes('nothing can pass'));
  assert.ok(why([{ t: 'tube', d: 0.04, L: 0.1 }, { t: 'orifice', shape: 'circle', d: 0.01 }, rod], 'dp')[0].includes('nothing can pass'));
  assert.ok(why([{ t: 'tube', d: 0.015, L: 0.1 }, rod], 'dp')[0].includes('nothing can pass'));
  // cells the kernel refuses are reported by chainPlan, not by a worker later
  assert.ok(why([{ t: 'elbow', d: 0.04, A: 0.01, B: 0.05 }], 'dp')[0].includes('at least the bore radius'));
  assert.deepEqual(chainPlan([{ t: 'tube', d: 0.1, L: 0.1 }], null, { bc: { mode: 'dp' } }).unsupported, ['The gas data are not valid.']);
});

test('compileBlock refuses a source opening that nothing can enter', () => {
  const blocked = makeBlock({ cells: [{ type: 'annulus', Ri: 0.5, Ro: 1, L: 1 }], plates: [disc(0.3)] });
  assert.equal(blocked.Ain, 0);
  assert.throws(() => compileBlock(blocked), /completely blocked/);
  const outBlocked = makeBlock({ cells: [{ type: 'annulus', Ri: 0.5, Ro: 1, L: 1 }], plates: [null, disc(0.3)] });
  const cb = compileBlock(outBlocked);
  assert.throws(() => runChainBlock(cb, 10, 1, { reverse: true }), /completely blocked/);
  const r = runChainBlock(cb, 2000, 1);
  assert.equal(r.trans, 0);
  assert.equal(r.back, r.n);
});

test('combinePlan combines block counts in series and parallel', () => {
  const p7 = plan(6), q = N2.vbar / 4;
  const res = [
    { id: 0, in: { n: 9e5, trans: 9e5 * 0.6 }, out: { n: 1e5, trans: 1e5 * 0.6 } },
    { id: 1, in: { n: 1e6, trans: 1e5 } },
    { id: 2, in: { n: 1e6, trans: 4e4 }, out: null },
  ];
  const r = combinePlan(p7, res, N2);
  const CA = 0.6 * p7.blocks[0].Ain * q, CB = 0.1 * p7.blocks[1].Ain * q + 0.04 * p7.blocks[2].Ain * q;
  rel(r.value, 1 / (1 / CA + 1 / CB + 1 / 0.05), 1e-12);
  assert.equal(r.kind, 'Seff');
  assert.deepEqual(r.ci95, [r.value - 1.96 * r.sigma, r.value + 1.96 * r.sigma]);
  assert.ok(r.sigma > 0);
  // legacy entries { id, n, trans } count as inlet launches
  const r2 = combinePlan(p7, [{ id: 0, n: 9e5, trans: 5.4e5 }, { id: 1, n: 1e6, trans: 1e5 }, { id: 2, n: 1e6, trans: 4e4 }], N2);
  rel(r2.value, r.value, 1e-9);
});

test('chain validation cases pass at quick N (in-process runner, evaluated by WP1 evaluate)', async () => {
  const mc = new McRunner({ createWorker: inProcessWorker, workers: 1 });
  const cases = MC_CASES.filter((c) => c.group === 'chain-mc' || (c.group === 'negative' && c.id.startsWith('neg-sampler')));
  assert.equal(cases.length, 18);
  const rows = [];
  for (const c of cases) {
    let outcome;
    try { outcome = await c.run({ mc, quick: true }); } catch (err) { outcome = { error: err.message }; }
    rows.push(evaluate(c, outcome));
  }
  mc.dispose();
  for (const r of rows) {
    if (r.group === 'negative') assert.equal(r.caught, true, `${r.id} not caught: ${r.devText}`);
    else assert.equal(r.pass, true, `${r.id}: ${r.value} vs ${r.ref} (${r.devText}, ${r.tolText})`);
  }
});

// ---- v2.2 fix round 1: a pump inlet wider than the line's outlet is not simulated as a sticking disc on the outlet
test('chainPlan asks for the adapter when the pump inlet is wider than the outlet', () => {
  const bc = { mode: 'pump', p0: 1e-4 };
  for (const items of [[{ t: 'tube', d: 0.04, L: 0.05 }, { t: 'pump', S: 0.3, d: 0.1, label: 'T' }], [{ t: 'tube', d: 0.063, L: 0.1 }, { t: 'pump', S: 0.3, d: 0.1, label: 'T' }],
    [{ t: 'annulus', di: 0.02, do: 0.04, L: 0.05 }, { t: 'pump', S: 0.3, d: 0.06, label: 'T' }]]) {
    const plan = chainPlan(items, N2, { bc });
    assert.ok(plan.unsupported && /does not fit inside the outlet/.test(plan.unsupported[0]), JSON.stringify(plan));
  }
  // v2.3: an annulus whose bore takes the whole pump inlet: only the rod's end face is in the way, and the text says so
  for (const items of [[{ t: 'annulus', di: 0.02, do: 0.04, L: 0.05 }, { t: 'pump', S: 0.01, d: 0.03, label: 'T' }],
    [{ t: 'tube', d: 0.05, L: 0.1 }, { t: 'annulus', di: 0.01, do: 0.1, L: 0.2 }, { t: 'pump', S: 0.3, d: 0.1, label: 'T' }]]) {
    const plan = chainPlan(items, N2, { bc });
    assert.ok(plan.unsupported && /^The rod of element \d ends at the pump inlet/.test(plan.unsupported[0]) && !/does not fit/.test(plan.unsupported[0]), JSON.stringify(plan));
  }
  const ok = chainPlan([{ t: 'tube', d: 0.04, L: 0.05 }, { t: 'cone', d1: 0.04, d2: 0.1, L: 0.06 }, { t: 'pump', S: 0.3, d: 0.1, label: 'T' }], N2, { bc });
  assert.ok(!ok.unsupported && ok.blocks.length === 1 && ok.blocks[0].outlet.stick > 0);
  const smaller = chainPlan([{ t: 'tube', d: 0.1, L: 0.2 }, { t: 'pump', S: 0.08, d: 0.063, label: 'T' }], N2, { bc });
  assert.ok(!smaller.unsupported && smaller.blocks[0].plates[1] && smaller.blocks[0].plates[1].r === 0.0315);
});
