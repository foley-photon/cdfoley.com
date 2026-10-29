// WP5 exact.js (spec 5.3, 7.6 acceptance 1): the NBS zero-gap column to 1e-6, the zero-gap two-tube and einzel exact
// values to 1e-4, q* = 0.908046, the apex (0.70600, 0.23699) and the beta table to 1e-5, plus the closed-form
// kinematics used by the K, T and P cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../../beta/ion-optics/js/engine/exact.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (|diff| ${Math.abs(a - b)} > ${tol})`);

test('NBS 1972 Table 2 zero-gap column reproduced to 1e-6 (axial potential into the 0 V tube)', () => {
    const nbs = { 0.1: 0.370599, 0.2: 0.258334, 0.3: 0.171921, 0.4: 0.110938, 0.5: 0.070253, 0.6: 0.044009, 0.8: 0.017006, 1.0: 0.006520, 1.5: 0.000589, 2.0: 0.000053 };
    for (const [zD, ref] of Object.entries(nbs)) near(X.twoTubeAxial(-2 * Number(zD)), ref, 1e-6, `z/D ${zD}`);
});

test('the axial potential is antisymmetric about the gap and continuous where the series meets the integral', () => {
    for (const z of [0.01, 0.1, 0.2499, 0.3, 1, 3]) near(X.twoTubeAxial(z) + X.twoTubeAxial(-z), 1, 1e-12, `S(z) + S(−z) at ${z}`);
    near(X.twoTubeAxial(0), 0.5, 1e-12, 'S(0)');
    near(X.twoTubeAxial(0.25 - 1e-9), X.twoTubeAxial(0.25 + 1e-9), 1e-8, 'switch at 0.25');
    let prev = X.twoTubeAxial(-6);
    for (let z = -6; z <= 6; z += 0.05) { const v = X.twoTubeAxial(z); assert.ok(v >= prev - 1e-12, 'monotonic'); prev = v; }
});

test('zero-gap two-tube lens: research values at ratios 2-20 to 1e-4 (units of D, DiChio signs)', () => {
    const ref = {
        2: { f1: -10.923, f2: 15.4474, F1: -13.0527, F2: 12.9229 }, 5: { f1: -1.7473, f2: 3.9071, F1: -2.7531, F2: 2.4512 },
        10: { f1: -0.7952, f2: 2.5147, F1: -1.6066, F2: 1.1737 }, 20: { f1: -0.4528, f2: 2.0249, F1: -1.1939, F2: 0.6295 },
    };
    for (const [ratio, r] of Object.entries(ref)) {
        const e = X.twoTubeExact(Number(ratio));
        for (const k of ['F1', 'F2', 'f1', 'f2']) near(e[k], r[k], 1e-4, `ratio ${ratio} ${k}`);
        near(e.H1, e.F1 - e.f1, 1e-12, 'H1 = F1 − f1');
        near(Math.abs(e.f1 / e.f2) * Math.sqrt(Number(ratio)), 1, 1e-9, `Lagrange-Helmholtz identity, ratio ${ratio}`);
    }
});

test('zero-gap einzel lens, A/D 0.5: exact focal lengths to 1e-4 (the L2 references)', () => {
    const ref = { '-0.5': 0.6061, 0: 2.7724, 0.8: 139.2295, 2: 11.0939, 9: 1.3015 };
    for (const [ratio, f] of Object.entries(ref)) near(X.einzelExact(Number(ratio), 0.5).f, f, 1e-4, `ratio ${ratio}`);
    // the axial potential equals V1 far away and the series inside
    near(X.einzelAxial(-12, 9, 0.5), 1, 1e-9, 'far left');
    near(X.einzelAxial(0, 9, 0.5), 1 + 8 * (2 * X.twoTubeAxial(0.5) - 1), 1e-12, 'centre');
});

test('Mathieu: q* = 0.908046, apex (0.70600, 0.23699) and the beta table at a = 0 to 1e-5', () => {
    near(X.mathieu.edgeA0(), 0.908046, 1e-5, 'q*');
    near(X.mathieu.qEdgeA0, 0.908046, 1e-12, 'published constant');
    const ap = X.mathieu.apexPoint();
    near(ap.q, X.mathieu.apex.q, 1e-5, 'apex q');
    near(ap.a, X.mathieu.apex.a, 1e-5, 'apex a');
    const beta = { 0.1: 0.07085, 0.2: 0.14255, 0.3: 0.21606, 0.4: 0.29257, 0.5: 0.37374, 0.6: 0.46225, 0.7: 0.56307, 0.8: 0.68856, 0.9: 0.91591 };
    for (const [q, b] of Object.entries(beta)) near(X.mathieu.beta(0, Number(q)), b, 1e-5, `beta(0, ${q})`);
    // low-q series (NIST DLMF 28.6.1, 28.6.3): a0 = −q²/2 + 7q⁴/128 − 29q⁶/2304 + …, b1 = 1 − q − q²/8 + q³/64 − q⁴/1536 − …
    for (const q of [0.1, 0.3]) {
        near(X.mathieu.a0(q), -q * q / 2 + 7 * q ** 4 / 128 - 29 * q ** 6 / 2304 + 68687 * q ** 8 / 18874368, 2e-6, `a0(${q})`);
        near(X.mathieu.b1(q), 1 - q - q * q / 8 + q ** 3 / 64 - q ** 4 / 1536, 2e-6, `b1(${q})`);
    }
    assert.ok(X.mathieu.stable(0.230, 0.706) && !X.mathieu.stable(0.244, 0.706), 'apex bracket');
    assert.ok(X.mathieu.stable(0, 0.89) && !X.mathieu.stable(0, 0.93), 'a = 0 edge bracket');
    assert.ok(Number.isNaN(X.mathieu.beta(0, 0.95)), 'unstable gives NaN');
});

test('quadrupole voltages and the Paul-trap cut-off (T11, T12 references)', () => {
    const kw = { massU: 100, r0: 4, freqMHz: 1.1 };
    near(X.qmfVoltages({ ...kw, a: 0, q: X.mathieu.edgeA0() }).V, 179.826, 5e-4, 'V(q*)');
    const ap = X.mathieu.apexPoint(), v = X.qmfVoltages({ ...kw, a: ap.a, q: ap.q });
    near(v.U, 23.467, 5e-4, 'apex U');
    near(v.V, 139.813, 5e-4, 'apex V');
    near(X.paulLMCO({ r0: 7.07, z0: 5, freqMHz: 1, v0: 500 }), 107.69, 0.02, 'LMCO');
});

test('closed-form kinematics: K1, K2, K7, K8, mirror, capacitors, reflectron', () => {
    const k1 = X.uniformTransit({ gapMm: 10, dV: 1000, massU: 100 });
    near(k1.tUs, 0.4552860566, 1e-10, 'K1 t'); near(k1.vMMus, 43.9284263, 1e-7, 'K1 v');
    near(X.uniformTransit({ gapMm: 10, dV: 1000, massU: 100, ke0EV: 10 }).tUs, 0.4120282184, 1e-10, 'K1 10 eV');
    const drift = { 1.00782503207: 2.28531950, 28: 12.0457368, 100: 22.7643028, 1000: 71.9870463 };
    for (const [m, t] of Object.entries(drift)) near(X.driftTime(1000, 1000, Number(m)), t, 1e-7, `drift ${m}`);
    const k7 = { 10: 76.780588, 100: 7.678059, 1000: 0.767806 };
    for (const [m, x] of Object.entries(k7)) near(X.rfUniformDisplacement({ e0VMm: 100, freqMHz: 1, massU: Number(m), tUs: 0.5 }), x, 5e-7, `K7 ${m}`);
    // pulse: before the pulse nothing moves; on the plateau x = a0[(t − t0 − rise/2)²/2 + rise²/24]
    const p = { e0VMm: 10, t0: 0.2, rise: 0.1, width: 10, fall: 0.1, massU: 100 };
    near(X.pulseRampPosition({ ...p, tUs: 0.15 }), 0, 1e-15, 'before');
    const a0 = 96.48533202185 * 10 / 100, t = 1.0;
    near(X.pulseRampPosition({ ...p, tUs: t }), a0 * ((t - 0.2 - 0.05) ** 2 / 2 + 0.01 / 24), 1e-12, 'plateau');
    near(X.mirrorRange(20, 1000, 1000, 30), 34.641016, 1e-6, 'mirror 30°'); near(X.mirrorRange(20, 1000, 1000, 45), 40, 1e-12, 'mirror 45°');
    near(X.mirrorDepth(20, 1000, 1000, 45), 10, 1e-12, 'depth');
    near(X.coaxV(12.5, { a: 10, b: 20, Va: 100, Vb: 0 }), 67.807191, 1e-6, 'coax');
    near(X.sphereV(110, { R1: 80, R2: 120, V1: 500, V2: -1000 / 3 }), -181.818182, 1e-6, 'sphere');
    // reflectron: first-order energy focus at L = 4 d_pen (Mamyrin); mirror time 2v/a
    const tof = (ke) => X.reflectronTof({ massU: 100, sMm: 1e-9, eSrcVMm: ke / 1e-9, outMm: 100, backMm: 100, eMirrorVMm: 20 });
    const d = (tof(1001) - tof(999)) / (2e-3 * tof(1000));
    assert.ok(Math.abs(d) < 1e-6, `reflectron dlnT/dlnK ${d}`);
});
