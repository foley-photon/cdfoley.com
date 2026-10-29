// WP2 waveforms: channel grouping, term values, breakpoints, sampling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeFunctions, sampleWave, cosFn, pulseFn, tableFn } from '../../beta/ion-optics/js/engine/waveform.js';

const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);

test('DC vector; gnd is always 0 V', () => {
    const tf = timeFunctions([{ id: 'gnd', ground: true, v: 99 }, { v: 100 }, { dc: 250, v: 1 }, { v: -5, terms: [] }]);
    assert.deepEqual([...tf.dc], [0, 100, 250, -5]);
    assert.equal(tf.channels.length, 0);
});

test('terms equal except for amplitude share one channel (quadrupole ±V cos Ωt)', () => {
    const tf = timeFunctions([
        { id: 'gnd', ground: true },
        { v: 21.81, terms: [{ type: 'cos', amp: -136.783, freq: 1.1, phase: 0 }] },
        { v: -21.81, terms: [{ type: 'cos', amp: 136.783, freq: 1.1, phase: 0 }] },
    ]);
    assert.equal(tf.channels.length, 1);
    const ch = tf.channels[0];
    assert.deepEqual([...ch.amp], [0, -136.783, 136.783]);
    assert.deepEqual([...tf.dc], [0, 21.81, -21.81]);
    for (const t of [0, 0.1, 0.3, 0.77]) {
        // V_k(t) = dc_k + amp_k f(t)
        close(tf.dc[1] + ch.amp[1] * ch.fn.value(t), 21.81 - 136.783 * Math.cos(2 * Math.PI * 1.1 * t), 1e-12, 'V1');
    }
    close(ch.fn.minPeriod, 1 / 1.1, 1e-15, 'minPeriod');
    assert.equal(ch.fn.nextBreak(0, 100), Infinity);
});

test('phase folding: a 180° phase shift is a sign flip of the same channel', () => {
    const tf = timeFunctions([{ ground: true }, { terms: [{ type: 'cos', amp: 2, freq: 1, phase: 30 }] }, { terms: [{ type: 'cos', amp: 3, freq: 1, phase: 210 }] }]);
    assert.equal(tf.channels.length, 1);
    const ch = tf.channels[0];
    for (const t of [0, 0.123, 0.5]) {
        close(ch.amp[1] * ch.fn.value(t), 2 * Math.cos(2 * Math.PI * t + Math.PI / 6), 1e-12);
        close(ch.amp[2] * ch.fn.value(t), 3 * Math.cos(2 * Math.PI * t + 7 * Math.PI / 6), 1e-12);
    }
    // K7 waveform: amp 21000, phase −90° → V = 21000 sin(2π t)
    const k7 = timeFunctions([{ ground: true }, { v: 0, terms: [{ type: 'cos', amp: 21000, freq: 1, phase: -90 }] }]);
    const c7 = k7.channels[0];
    for (const t of [0.1, 0.25, 0.4]) close(c7.amp[1] * c7.fn.value(t), 21000 * Math.sin(2 * Math.PI * t), 1e-9);
    // zero-frequency cos is DC
    const z = timeFunctions([{ ground: true }, { v: 1, terms: [{ type: 'cos', amp: 2, freq: 0, phase: 60 }] }]);
    assert.equal(z.channels.length, 0); close(z.dc[1], 2, 1e-12);
});

test('pulse: trapezoid values, left limits and corners', () => {
    const f = pulseFn(0.2, 0.1, 10, 0.1);
    for (const [t, v] of [[0, 0], [0.2, 0], [0.25, 0.5], [0.3, 1], [5, 1], [10.3, 1], [10.35, 0.5], [10.4, 0], [20, 0]]) close(f.value(t), v, 1e-12, 't=' + t);
    assert.equal(f.nextBreak(0, 100), 0.2);
    const b2 = f.nextBreak(0.2, 100), b3 = f.nextBreak(b2, 100), b4 = f.nextBreak(b3, 100);
    close(b2, 0.3, 1e-15); close(b3, 10.3, 1e-12); close(b4, 10.4, 1e-12);
    assert.equal(f.nextBreak(b4, 100), Infinity);
    assert.equal(f.nextBreak(0, 0.1), Infinity, 'only breakpoints in (t0, t1]');
    assert.equal(f.minPeriod, Infinity);
    // a step (rise 0): right-continuous value, left limit before the jump
    const s = pulseFn(1, 0, 2, 0);
    assert.equal(s.value(1), 1); assert.equal(s.valueLeft(1), 0);
    assert.equal(s.value(3), 0); assert.equal(s.valueLeft(3), 1);
    // periodic pulse train
    const p = pulseFn(0, 0.1, 0.2, 0.1, 1);
    close(p.value(1.05), 0.5, 1e-12); close(p.value(2.2), 1, 1e-12); close(p.value(-0.75), 1, 1e-12);
    close(p.nextBreak(1.35, 5), 1.4, 1e-12); close(p.nextBreak(1.4, 5), 2, 1e-12);
});

test('table: piecewise linear, constant beyond the ends, periodic wrap', () => {
    const f = tableFn([[0, 0], [1, 2], [3, -2]]);
    for (const [t, v] of [[-1, 0], [0.5, 1], [1, 2], [2, 0], [3, -2], [9, -2]]) close(f.value(t), v, 1e-12, 't=' + t);
    assert.equal(f.nextBreak(-5, 10), 0); assert.equal(f.nextBreak(0, 10), 1); assert.equal(f.nextBreak(1, 2), Infinity);
    const g = tableFn([[0, 0], [1, 1]], 2);
    close(g.value(0.5), 0.5, 1e-12); close(g.value(1.5), 1, 1e-12); close(g.value(2.5), 0.5, 1e-12);
    assert.equal(g.valueLeft(2), 1); assert.equal(g.value(2), 0);
    close(g.nextBreak(1.5, 10), 2, 1e-12); close(g.nextBreak(2, 10), 3, 1e-12);
    // channel normalisation keeps V(t) exact
    const tf = timeFunctions([{ ground: true }, { v: 1, terms: [{ type: 'table', points: [[0, 0], [1, -4], [2, 2]] }] }]);
    const ch = tf.channels[0];
    for (const t of [0.5, 1, 1.5]) close(tf.dc[1] + ch.amp[1] * ch.fn.value(t), 1 + (t <= 1 ? -4 * t : -4 + 6 * (t - 1)), 1e-12);
});

test('more than 7 distinct waveform shapes are refused', () => {
    const terms = [];
    for (let k = 0; k < 8; k++) terms.push({ type: 'cos', amp: 1, freq: 1 + k, phase: 0 });
    assert.throws(() => timeFunctions([{ ground: true }, { terms }]), (e) => e.code === 'E_UNSUPPORTED');
});

test('sampleWave includes breakpoints and both sides of a jump', () => {
    const s = sampleWave({ v: 10, terms: [{ type: 'pulse', amp: 5, t0: 1, rise: 0, width: 1, fall: 0 }] }, 0, 4, 5);
    const pairs = [...s.t].map((t, i) => [t, s.v[i]]);
    assert.deepEqual(pairs, [[0, 10], [1, 10], [1, 15], [2, 15], [2, 10], [3, 10], [4, 10]]);
    const c = sampleWave({ v: 0, terms: [{ type: 'cos', amp: 1, freq: 1 }] }, 0, 1, 3);
    assert.deepEqual([...c.t], [0, 0.5, 1]);
    close(c.v[1], -1, 1e-12);
    const cf = cosFn(2, 90);
    close(cf.value(0), 0, 1e-12); close(cf.period, 0.5, 1e-15);
});
