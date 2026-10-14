// WP2 counter-based RNG: known-answer tests, ranges, moments, independence of counters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hash32, uniform01, normal01, Stream, philox4x32 } from '../../beta/ion-optics/js/engine/rng.js';

const hex = (a) => a.map((v) => v.toString(16).padStart(8, '0')).join(' ');

test('Philox-4x32-10 known-answer vectors (Salmon et al. 2011, Random123 kat_vectors)', () => {
    assert.equal(hex(philox4x32(0, 0, 0, 0, 0, 0)), '6627e8d5 e169c58d bc57ac4c 9b00dbd8');
    assert.equal(hex(philox4x32(0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff)), '408f276d 41c83b0e a20bc7c6 6d5451fd');
    assert.equal(hex(philox4x32(0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344, 0xa4093822, 0x299f31d0)), 'd16cfe09 94fdcceb 5001e420 24126ea1');
});

test('pure functions of (seed, a, b, c): repeatable, counter-sensitive', () => {
    assert.equal(uniform01(7, 1, 2, 3), uniform01(7, 1, 2, 3));
    assert.equal(normal01(7, 1, 2, 3), normal01(7, 1, 2, 3));
    assert.equal(hash32(7, 1, 2, 3), hash32(7, 1, 2, 3));
    const seen = new Set();
    for (const args of [[7, 1, 2, 3], [8, 1, 2, 3], [7, 0, 2, 3], [7, 1, 0, 3], [7, 1, 2, 0], [2 ** 32 + 7, 1, 2, 3]]) seen.add(uniform01(...args));
    assert.equal(seen.size, 6, 'every component of the counter and both key words change the result');
    // order of evaluation never matters (no hidden state between calls)
    const a = [uniform01(1, 0, 5, 1), uniform01(1, 0, 9, 1)];
    const b = [uniform01(1, 0, 9, 1), uniform01(1, 0, 5, 1)];
    assert.deepEqual(a, b.reverse());
});

test('uniform01: range [0, 1), 53-bit resolution, moments within 3σ/√n', () => {
    const n = 200000;
    let s = 0, s2 = 0, mn = 1, mx = 0, fracBits = 0;
    for (let i = 0; i < n; i++) {
        const u = uniform01(3, 1, i, 7);
        assert.ok(u >= 0 && u < 1);
        s += u; s2 += u * u; if (u < mn) mn = u; if (u > mx) mx = u;
        if (Math.round(u * 2 ** 53) !== u * 2 ** 53) fracBits++;
    }
    assert.equal(fracBits, 0, 'values are multiples of 2^-53');
    const mean = s / n, v = s2 / n - mean * mean;
    assert.ok(Math.abs(mean - 0.5) <= 3 * Math.sqrt(1 / 12) / Math.sqrt(n), 'mean ' + mean);
    // var of u² estimator: Var(u²) = 1/5 − 1/9 = 4/45
    assert.ok(Math.abs(v - 1 / 12) <= 3 * Math.sqrt(4 / 45 + 0.5) / Math.sqrt(n), 'variance ' + v);
    assert.ok(mn < 1e-4 && mx > 1 - 1e-4);
});

test('normal01: moments within 3σ/√n', () => {
    const n = 200000;
    let s = 0, s2 = 0, s4 = 0;
    for (let i = 0; i < n; i++) { const z = normal01(11, 2, i, 3); s += z; s2 += z * z; s4 += z ** 4; }
    const mean = s / n, v = s2 / n, k = s4 / n;
    assert.ok(Math.abs(mean) <= 3 / Math.sqrt(n), 'mean ' + mean);
    assert.ok(Math.abs(v - 1) <= 3 * Math.sqrt(2) / Math.sqrt(n), 'variance ' + v);
    assert.ok(Math.abs(k - 3) <= 3 * Math.sqrt(96) / Math.sqrt(n), 'fourth moment ' + k);
});

test('hash32 is a uint32 with balanced bits', () => {
    const n = 50000, ones = new Float64Array(32);
    for (let i = 0; i < n; i++) {
        const h = hash32(5, i, 0, 0);
        assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
        for (let b = 0; b < 32; b++) ones[b] += (h >>> b) & 1;
    }
    for (let b = 0; b < 32; b++) assert.ok(Math.abs(ones[b] / n - 0.5) <= 3 * 0.5 / Math.sqrt(n) * 1.5, 'bit ' + b);
});

test('Stream: deterministic sequence, disjoint from fixed draws, normal moments', () => {
    const a = new Stream(4, 1, 2), b = new Stream(4, 1, 2);
    const sa = [], sb = [];
    for (let i = 0; i < 10; i++) { sa.push(a.next()); sb.push(b.next()); }
    assert.deepEqual(sa, sb);
    const fixed = new Set();
    for (let c = 0; c < 10; c++) fixed.add(uniform01(4, 1, 2, c));
    for (const v of sa) assert.ok(!fixed.has(v), 'stream draws differ from the fixed counters');
    const st = new Stream(9, 3, 4);
    let s = 0, s2 = 0;
    const n = 100000;
    for (let i = 0; i < n; i++) { const z = st.normal(); s += z; s2 += z * z; }
    assert.ok(Math.abs(s / n) <= 3 / Math.sqrt(n));
    assert.ok(Math.abs(s2 / n - 1) <= 3 * Math.sqrt(2 / n));
});
