// WP2: random numbers and direction samplers (spec §3.6.1, §7.3 acceptance 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mix32, splitmix32, makeRng, randInt, sourceKeyOf, batchSeed, cosineDir, asinDir, uniformDir, getSampler, SAMPLERS,
} from '../../beta/conductance/js/engine/rng.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/wp2/xoshiro128ss-seed12345.json', import.meta.url), 'utf8'));

test('xoshiro128** reproduces the prototype makeRng(12345) for its first 1000 outputs', () => {
  assert.equal(fixture.u32.length, 1000);
  const rng = makeRng(12345);
  for (let i = 0; i < 1000; i++) assert.equal(rng(), fixture.u32[i] / 4294967296, `output ${i}`);
  const r2 = makeRng(12345);
  for (let i = 0; i < 1000; i++) assert.equal(r2.u32(), fixture.u32[i], `u32 output ${i}`);
});

test('splitmix32 outputs mix32(seed + k·0x9E3779B9)', () => {
  const sm = splitmix32(7);
  let x = 7;
  for (let k = 0; k < 10; k++) { assert.equal(sm(), mix32(x)); x = (x + 0x9E3779B9) >>> 0; }
  assert.equal(mix32(0), 2462723854);
  for (const v of [0, 1, 0xffffffff, -1, 123456789]) {
    const m = mix32(v);
    assert.ok(Number.isInteger(m) && m >= 0 && m < 2 ** 32);
  }
});

test('rng() lies in [0, 1); seed 0 works; randInt is in range', () => {
  for (const seed of [0, 1, 0xffffffff]) {
    const rng = makeRng(seed);
    let zeros = 0;
    for (let i = 0; i < 10000; i++) { const u = rng(); assert.ok(u >= 0 && u < 1); if (u === 0) zeros++; }
    assert.ok(zeros < 2);
  }
  const rng = makeRng(3);
  for (let i = 0; i < 1000; i++) { const k = randInt(rng, 7); assert.ok(Number.isInteger(k) && k >= 0 && k < 7); }
});

test('uniformity, variance and lag-1 correlation of 10^6 outputs', () => {
  const rng = makeRng(20261012), n = 1e6, hist = new Float64Array(10);
  let s1 = 0, s2 = 0, sc = 0, prev = rng();
  for (let i = 0; i < n; i++) {
    const u = rng();
    s1 += u; s2 += u * u; hist[Math.floor(u * 10)]++; sc += (u - 0.5) * (prev - 0.5); prev = u;
  }
  const mean = s1 / n, varc = s2 / n - mean * mean;
  assert.ok(Math.abs(mean - 0.5) < 4 * Math.sqrt(1 / 12 / n));
  assert.ok(Math.abs(varc - 1 / 12) < 1e-3);
  let chi2 = 0;
  for (const h of hist) chi2 += (h - n / 10) ** 2 / (n / 10);
  assert.ok(chi2 < 33.7, 'chi² with 9 degrees of freedom: ' + chi2);   // p ≈ 1e-4
  assert.ok(Math.abs(sc / n * 12) < 4 / Math.sqrt(n));
});

test('batchSeed is stable', () => {
  const snap = [[20261012, 0, 0, 4077477603], [20261012, 1, 0, 2801114016], [20261012, 0, 1, 529986496], [0, 0, 0, 3553795876],
    [12345, 7, 99999, 829350845], [4294967295, 4095, 1048575, 1109688387], [1, 4096, 1048576, 3975510]];
  for (const [j, s, q, v] of snap) assert.equal(batchSeed(j, s, q), v);
  assert.equal(sourceKeyOf('in'), 0);
  assert.equal(sourceKeyOf('out'), 1);
  assert.equal(sourceKeyOf(5), 5);
});

test('batchSeed is collision-free over 10^6 (source, seq) pairs, for several splits and job seeds', () => {
  const grids = [[1, 1e6], [2, 5e5], [10, 1e5], [16, 62500], [1000, 1000]];
  for (const job of [20261012, 0, 0xffffffff]) {
    for (const [ns, nq] of grids) {
      const seen = new Set();
      for (let s = 0; s < ns; s++) {
        for (let q = 0; q < nq; q++) {
          const v = batchSeed(job, s, q);
          assert.ok(v !== 0);
          seen.add(v);
        }
      }
      assert.equal(seen.size, ns * nq, `job ${job}, ${ns} sources × ${nq} seqs`);
      if (job !== 20261012) break;   // one grid for the other job seeds keeps the test fast
    }
  }
});

function moments(sampler, nx, ny, nz, n, seed) {
  const rng = makeRng(seed), D = new Float64Array(3);
  let c1 = 0, c2 = 0, neg = 0, badLen = 0;
  for (let i = 0; i < n; i++) {
    sampler(rng, nx, ny, nz, D);
    const c = D[0] * nx + D[1] * ny + D[2] * nz;
    c1 += c; c2 += c * c;
    if (c < 0) neg++;
    if (Math.abs(Math.hypot(D[0], D[1], D[2]) - 1) > 1e-12) badLen++;
  }
  return { m1: c1 / n, m2: c2 / n, neg, badLen };
}

test('cosine sampler: <cos θ> = 2/3 and <cos² θ> = 1/2 within 4σ at 10^6 draws, about any normal', () => {
  const n = 1e6;
  const s1 = Math.sqrt((1 / 2 - 4 / 9) / n), s2 = Math.sqrt((1 / 3 - 1 / 4) / n);
  const normals = [[0, 0, 1], [0, 0, -1], [1, 0, 0]];
  const l = Math.hypot(0.3, -0.5, 0.8);
  normals.push([0.3 / l, -0.5 / l, 0.8 / l]);
  normals.forEach((nrm, k) => {
    const m = moments(cosineDir, nrm[0], nrm[1], nrm[2], k === 0 ? n : 2e5, 100 + k);
    const nn = k === 0 ? n : 2e5, f = Math.sqrt(n / nn);
    assert.ok(Math.abs(m.m1 - 2 / 3) < 4 * s1 * f, `normal ${k}: <cos> ${m.m1}`);
    assert.ok(Math.abs(m.m2 - 1 / 2) < 4 * s2 * f, `normal ${k}: <cos²> ${m.m2}`);
    assert.equal(m.neg, 0);
    assert.equal(m.badLen, 0);
  });
});

test('negative-control samplers have the wrong moments', () => {
  const n = 2e5;
  const a = moments(asinDir, 0, 0, 1, n, 5);      // θ = asin ξ: <cos θ> = π/4
  assert.ok(Math.abs(a.m1 - Math.PI / 4) < 4 * Math.sqrt((2 / 3 - (Math.PI / 4) ** 2) / n));
  assert.equal(a.neg, 0); assert.equal(a.badLen, 0);
  const u = moments(uniformDir, 0, 1, 0, n, 6);   // cos θ = ξ: <cos θ> = 1/2, <cos²θ> = 1/3
  assert.ok(Math.abs(u.m1 - 0.5) < 4 * Math.sqrt(1 / 12 / n));
  assert.ok(Math.abs(u.m2 - 1 / 3) < 4 * Math.sqrt((1 / 5 - 1 / 9) / n));
  assert.equal(u.neg, 0); assert.equal(u.badLen, 0);
});

test('getSampler names the samplers and rejects unknown ones', () => {
  assert.deepEqual([...SAMPLERS], ['cosine', 'asin', 'uniform']);
  assert.equal(getSampler(), cosineDir);
  assert.equal(getSampler('cosine'), cosineDir);
  assert.equal(getSampler('asin'), asinDir);
  assert.equal(getSampler('uniform'), uniformDir);
  assert.throws(() => getSampler('isotropic'), RangeError);
});
