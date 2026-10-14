// WP2: statistics, combination, stopping rule, reciprocity and summaries (spec §3.6.2, §3.6.5; §7.3 acceptance 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Z95, binomial, wilson, safeSigma, ci95, relHalfWidth, inverseVariance, combineSeries, combineParallel, combineTree,
  particlesFor, stopReason, etaSeconds, reciprocityZ, isExactBlock, canReverse, blockEstimate, defaultPorts, summarizeMesh,
  MIN_PARTICLES, MIN_COUNTS,
} from '../../beta/conductance/js/engine/stats.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);

test('binomial estimate and σ', () => {
  const b = binomial(19, 100);
  assert.equal(b.p, 0.19);
  close(b.sigma, Math.sqrt(0.19 * 0.81 / 100), 1e-15);
  assert.ok(Number.isNaN(binomial(0, 0).p));
});

test('Wilson intervals match hand values (z = 1.96)', () => {
  // textbook form: (p + z²/2n ± z√(p(1 − p)/n + z²/4n²))/(1 + z²/n)
  const hand = (k, n) => {
    const p = k / n, z = 1.96, a = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [(c - h) / a, (c + h) / a];
  };
  for (const [k, n] of [[0, 10], [5, 10], [10, 10], [1, 100], [19, 100], [190942, 1e6]]) {
    const w = wilson(k, n), [lo, hi] = hand(k, n);
    close(w.lo, Math.max(0, lo), 1e-12, `lo ${k}/${n}`);
    close(w.hi, Math.min(1, hi), 1e-12, `hi ${k}/${n}`);
  }
  // published values: 5/10 → (0.2366, 0.7634); 0/10 → (0, 0.2775)
  const w5 = wilson(5, 10), w0 = wilson(0, 10);
  close(w5.lo, 0.2366, 5e-5); close(w5.hi, 0.7634, 5e-5);
  assert.equal(w0.lo, 0); close(w0.hi, 0.2775, 5e-5);
  assert.deepEqual([wilson(0, 0).lo, wilson(0, 0).hi], [0, 1]);
});

test('safeSigma is the binomial σ, or the Wilson half-width/z at k = 0 or k = n', () => {
  assert.equal(safeSigma(19, 100), binomial(19, 100).sigma);
  close(safeSigma(0, 100), wilson(0, 100).half / Z95, 1e-15);
  assert.ok(safeSigma(100, 100) > 0);
});

test('ci95, relative half-width and particle estimates', () => {
  assert.deepEqual(ci95(10, 1), [10 - 1.96, 10 + 1.96]);
  close(relHalfWidth(2, 0.1), 0.098, 1e-15);
  assert.equal(relHalfWidth(0, 1), Infinity);
  // N = 3.84·(1 − α)/(α ε²). §3.6.5 quotes 7.4·10⁴ at α = 0.19, but its own formula gives 1.64·10⁵ there; the
  // other quoted values follow the formula: 3.8·10⁷ at α = 0.001, 1.1·10⁵ for the elbow (α 0.265), 2.2·10⁵ for preset 1.
  close(particlesFor(0.19, 0.01) / (3.8416 * 0.81 / (0.19 * 1e-4)), 1, 1e-12);
  close(particlesFor(0.001, 0.01) / 3.8e7, 1, 0.01, 'spec: 3.8·10⁷ particles at α = 0.001');
  close(particlesFor(0.265, 0.01) / 1.1e5, 1, 0.04, 'spec: about 1.1·10⁵ particles for the default elbow');
  close(particlesFor(0.1498, 0.01) / 2.2e5, 1, 0.02, 'spec: about 2.2·10⁵ particles for preset 1');
  assert.equal(particlesFor(0, 0.01), Infinity);
});

test('inverse-variance combination', () => {
  const c = inverseVariance([{ value: 1, sigma: 0.1 }, { value: 2, sigma: 0.2 }]);
  close(c.value, 1.2, 1e-15);
  close(c.sigma, 1 / Math.sqrt(125), 1e-15);
  assert.deepEqual(c.ci95, ci95(c.value, c.sigma));
  const one = inverseVariance([{ value: 3, sigma: 0.5 }, { value: NaN, sigma: 1 }]);
  assert.equal(one.value, 3); assert.equal(one.sigma, 0.5);
  const exact = inverseVariance([{ value: 4, sigma: 0 }]);
  assert.equal(exact.value, 4);
});

test('series and parallel combination with error propagation', () => {
  const s = combineSeries([{ value: 2, sigma: 0.2 }, { value: 2, sigma: 0.2 }]);
  close(s.value, 1, 1e-15);
  close(s.sigma, Math.sqrt(2 * 0.04 / 16), 1e-15);    // X²·√(Σσ²/C⁴)
  const p = combineParallel([{ value: 1, sigma: 0.3 }, { value: 2, sigma: 0.4 }]);
  assert.equal(p.value, 3); close(p.sigma, 0.5, 1e-15);
  const z = combineSeries([{ value: 0, sigma: 0.01 }, { value: 2, sigma: 0.2 }]);
  assert.equal(z.value, 0); assert.equal(z.sigma, 0.01);
  // tree: series(block 0, par(block 1, block 2), pump S)
  const leaves = { 0: { value: 4, sigma: 0.1 }, 1: { value: 1, sigma: 0.05 }, 2: { value: 3, sigma: 0.1 } };
  const tree = { k: 'series', parts: [{ k: 'block', id: 0 }, { k: 'par', branches: [{ k: 'block', id: 1 }, { k: 'block', id: 2 }] }, { k: 'pump', S: 2 }] };
  const r = combineTree(tree, (n) => leaves[n.id]);
  const X = 1 / (1 / 4 + 1 / 4 + 1 / 2);
  close(r.value, X, 1e-15);
  const sB = Math.hypot(0.05, 0.1);
  close(r.sigma, X * X * Math.sqrt(0.1 ** 2 / 4 ** 4 + sB ** 2 / 4 ** 4), 1e-15);
  assert.throws(() => combineTree({ k: 'nope' }, () => null), RangeError);
  assert.equal(combineTree({ k: 'pumpBlock', id: 0 }, (n) => leaves[n.id]).value, 4);
});

test('stopping rule: target needs 10^4 particles and 100 counts; then particles and time limits', () => {
  const base = { value: 1, sigma: 0.004, particles: 2e4, counts: 500, elapsed: 1, target: 0.01, maxTime: 60, maxParticles: 1e9 };
  assert.equal(MIN_PARTICLES, 1e4); assert.equal(MIN_COUNTS, 100);
  assert.equal(stopReason(base), 'target');                                   // 1.96·0.004 = 0.78 % ≤ 1 %
  assert.equal(stopReason({ ...base, sigma: 0.006 }), null);                   // 1.18 % > 1 %
  assert.equal(stopReason({ ...base, particles: 9999 }), null);
  assert.equal(stopReason({ ...base, counts: 99 }), null);
  assert.equal(stopReason({ ...base, sigma: 0.006, elapsed: 60 }), 'time');
  assert.equal(stopReason({ ...base, sigma: 0.006, particles: 1e9 }), 'particles');
  assert.equal(stopReason({ ...base, sigma: 0.006, maxTime: Infinity, elapsed: 1e6 }), null);
  assert.equal(stopReason({ ...base, target: 0 }), null);
});

test('time estimate from the relative half-width', () => {
  // ±2 % now, target 1 %: four times the particles are needed, i.e. 3·N more
  close(etaSeconds({ particles: 1e5, rhw: 0.02, target: 0.01, rate: 1e5 }), 3, 1e-12);
  assert.equal(etaSeconds({ particles: 1e5, rhw: 0.005, target: 0.01, rate: 1e5 }), 0);
  assert.equal(etaSeconds({ particles: 1e5, rhw: Infinity, target: 0.01, rate: 1e5 }), null);
});

test('reciprocity z-score', () => {
  assert.equal(reciprocityZ(2, 0.25, 0.01, 1, 0.5, 0.01), 0);
  close(reciprocityZ(2, 0.3, 0.01, 3, 0.2, 0.01), 0, 1e-12);
  close(reciprocityZ(1, 0.5, 0.01, 1, 0.47, 0.01), 0.03 / Math.sqrt(2e-4), 1e-12);
  assert.equal(reciprocityZ(1, 0.5, 0, 1, 0.4, 0), Infinity);
});

const disc = (r) => ({ kind: 'disc', r });

test('block estimates: exact apertures, two directions and pump blocks', () => {
  const vbar = 470, q = vbar / 4;
  const lone = { id: 0, cells: [], plates: [disc(0.01)], outlet: null, Ain: Math.PI * 1e-4, Aout: Math.PI * 1e-4 };
  assert.ok(isExactBlock(lone));
  const e0 = blockEstimate(lone, null, vbar);
  assert.equal(e0.value, lone.Ain * q); assert.equal(e0.sigma, 0); assert.equal(e0.exact, true);
  const cont = { id: 1, cells: [{ type: 'tube', R: 2, L: 4 }, { type: 'tube', R: 1, L: 4 }], plates: [null, null, null], outlet: null, Ain: 4 * Math.PI, Aout: Math.PI };
  assert.ok(!isExactBlock(cont) && canReverse(cont));
  const counts = { in: { n: 100000, trans: 8445 }, out: { n: 900000, trans: 337800 } };
  const e = blockEstimate(cont, counts, vbar);
  const Cin = 0.08445 * cont.Ain * q, sIn = Math.sqrt(0.08445 * (1 - 0.08445) / 1e5) * cont.Ain * q;
  const aOut = 337800 / 900000, Cout = aOut * cont.Aout * q, sOut = Math.sqrt(aOut * (1 - aOut) / 9e5) * cont.Aout * q;
  const w1 = 1 / sIn ** 2, w2 = 1 / sOut ** 2;
  close(e.value, (w1 * Cin + w2 * Cout) / (w1 + w2), 1e-12 * e.value);
  close(e.sigma, 1 / Math.sqrt(w1 + w2), 1e-12 * e.sigma);
  close(e.alpha, e.value / (cont.Ain * q), 1e-15);
  assert.equal(e.counts, 337800);
  const pumpB = { ...cont, outlet: { stick: 0.3 } };
  assert.ok(!canReverse(pumpB));
  const ep = blockEstimate(pumpB, counts, vbar);
  close(ep.value, Cin, 1e-12 * Cin);                 // the outlet direction is ignored for a pump block
  assert.ok(Number.isNaN(blockEstimate(cont, null, vbar).value));
});

test('mesh summary: transmission matrix, C from both directions, S_eff, reciprocity', () => {
  const vbar = 470, q = vbar / 4;
  const ports = [{ role: 'inlet', stick: 1, area: 2 }, { role: 'outlet', stick: 1, area: 1 }, { role: 'pump', stick: 0.5, area: 1 }];
  assert.deepEqual(defaultPorts(ports), { iIn: 0, jOut: 1, jPump: 2 });
  const perSource = [
    { port: 0, n: 1e5, absorbed: [60000, 20000, 20000] },
    { port: 1, n: 5e4, absorbed: [20000, 10000, 20000] },
  ];
  const s = summarizeMesh(ports, perSource, vbar);
  assert.equal(s.alpha.length, 3);
  assert.equal(s.alpha[2], null);
  assert.equal(s.alpha[0][1].value, 0.2);
  close(s.alpha[0][1].sigma, Math.sqrt(0.2 * 0.8 / 1e5), 1e-15);
  const w = wilson(20000, 1e5);
  assert.equal(s.alpha[0][1].lo, w.lo); assert.equal(s.alpha[0][1].hi, w.hi);
  // C: 0.2·2·q from the inlet, 0.4·1·q from the outlet → inverse variance
  const a = { value: 0.2 * 2 * q, sigma: Math.sqrt(0.16 / 1e5) * 2 * q }, b = { value: 0.4 * 1 * q, sigma: Math.sqrt(0.24 / 5e4) * q };
  const iv = inverseVariance([a, b]);
  close(s.C.value, iv.value, 1e-12); close(s.C.sigma, iv.sigma, 1e-12);
  assert.equal(s.C.i, 0); assert.equal(s.C.j, 1);
  close(s.Seff.value, 0.2 * 2 * q, 1e-12);
  assert.equal(s.primary, s.Seff);
  assert.equal(s.reciprocity.length, 1);
  assert.equal(s.reciprocity[0].z, 0);                  // 2·0.2 = 1·0.4
  assert.ok(s.reciprocity[0].pass);
  // without a pump the primary is C
  const s2 = summarizeMesh(ports.slice(0, 2), perSource.map((p) => ({ ...p, absorbed: p.absorbed.slice(0, 2) })), vbar);
  assert.equal(s2.Seff, null);
  assert.equal(s2.primary, s2.C);
});
