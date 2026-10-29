// WP2 magnets: elliptic integrals, exact current loops (T13), uniform fields, hard-edged regions and signatures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileMagnets, loopField, ellipticKE } from '../../beta/ion-optics/js/engine/magnet.js';
import { createFieldModel } from '../../beta/ion-optics/js/engine/fieldmodel.js';
import { MU0 } from '../../beta/ion-optics/js/engine/constants.js';

const relEq = (a, b, rel, msg = '') => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg} ${a} vs ${b}`);

/** Biot–Savart midpoint rule over a loop of radius a (mm) in the plane z = 0 centred at the origin; field (T) at (x, y, z). */
function biotSavart(a, I, x, y, z, n = 20000) {
    let bx = 0, by = 0, bz = 0;
    const k = MU0 * 1e3 / (4 * Math.PI) * I;   // T·mm/A
    for (let i = 0; i < n; i++) {
        const p = 2 * Math.PI * (i + 0.5) / n;
        const lx = a * Math.cos(p), ly = a * Math.sin(p);
        const dlx = -a * Math.sin(p) * 2 * Math.PI / n, dly = a * Math.cos(p) * 2 * Math.PI / n;
        const rx = x - lx, ry = y - ly, rz = z, r3 = Math.pow(rx * rx + ry * ry + rz * rz, 1.5);
        bx += k * (dly * rz) / r3; by += k * (-dlx * rz) / r3; bz += k * (dlx * ry - dly * rx) / r3;
    }
    return [bx, by, bz];
}

test('complete elliptic integrals by the AGM (A&S 17.6)', () => {
    const [K0, E0] = ellipticKE(0);
    relEq(K0, Math.PI / 2, 1e-15); relEq(E0, Math.PI / 2, 1e-15);
    const [K5, E5] = ellipticKE(0.5);
    relEq(K5, 1.854074677301372, 1e-14, 'K(0.5)'); relEq(E5, 1.350643881047675, 1e-14, 'E(0.5)');
    const [K9, E9] = ellipticKE(0.99);
    relEq(K9, 3.695637362989875, 1e-13, 'K(0.99)'); relEq(E9, 1.015993545025224, 1e-13, 'E(0.99)');
    assert.equal(ellipticKE(1)[0], Infinity);
});

test('T13: Helmholtz pair and single loop on axis (to 1e-6)', () => {
    const o = new Float64Array(2);
    loopField(100, 1, 1, 0, 50, o);
    relEq(o[1], 4.49588e-6, 1e-6, 'one loop at 50 mm');
    assert.equal(o[0], 0);
    // through compileMagnets and the FieldModel: N 100, 1 A, R 100 mm at x = ±50 (normals along +x)
    const mags = [{ type: 'loop', center: [-50, 0, 0], normal: [1, 0, 0], radius: 100, turns: 100, current: 1 },
        { type: 'loop', center: [50, 0, 0], normal: [1, 0, 0], radius: 100, turns: 100, current: 1 }];
    const model = createFieldModel({ resolved: { domain: { type: 'cyl2d', cell: 1, h: 1, x: [-100, 100], y: [0, 50], nx: 201, ny: 51 }, electrodes: [{ id: 'gnd' }], magnets: mags, idealFields: [] } });
    const b = new Float64Array(3);
    model.B(0, 0, 0, b);
    relEq(b[0], 0.899176e-3, 1e-6, 'Helmholtz centre');
    assert.ok(Math.abs(b[1]) < 1e-18 && Math.abs(b[2]) < 1e-18);
    // uniformity of the Helmholtz centre: dB/B < 1e-4 within 5 mm
    model.B(5, 3, 0, b);
    assert.ok(Math.abs(b[0] / 0.899176e-3 - 1) < 1e-4);
});

test('loop field off axis equals a Biot–Savart integration (to 1e-9)', () => {
    const o = new Float64Array(2);
    for (const [rho, z] of [[30, 10], [80, -40], [150, 5], [99, 1], [10, 200]]) {
        loopField(100, 2, 3, rho, z, o);
        const bs = biotSavart(100, 6, rho, 0, z);
        relEq(o[0], bs[0], 1e-9, `Bρ at (${rho}, ${z})`);
        relEq(o[1], bs[2], 1e-9, `Bz at (${rho}, ${z})`);
    }
    // continuity at the axis threshold
    const a = new Float64Array(2), b = new Float64Array(2);
    loopField(100, 1, 1, 0.99e-7, 20, a); loopField(100, 1, 1, 1.01e-7, 20, b);
    relEq(a[1], b[1], 1e-12, 'Bz across ρ = 1e-9 a');
    // an arbitrary orientation through compileMagnets
    const nrm = [1, 2, 2].map((v) => v / 3);
    const mag = compileMagnets([{ type: 'loop', center: [5, -3, 2], normal: nrm, radius: 40, turns: 2, current: 1.5 }], 'planar2d');
    const out = [0, 0, 0];
    const P = [25, 10, -15];
    mag.add(P[0], P[1], P[2], out);
    // rebuild in the loop frame: e3 = n, e1 ⟂ n
    const e1 = [2 / 3, -2 / 3, 1 / 3].map((v) => v), e2 = [nrm[1] * e1[2] - nrm[2] * e1[1], nrm[2] * e1[0] - nrm[0] * e1[2], nrm[0] * e1[1] - nrm[1] * e1[0]];
    const d = [P[0] - 5, P[1] + 3, P[2] - 2];
    const lx = d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2], ly = d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2], lz = d[0] * nrm[0] + d[1] * nrm[1] + d[2] * nrm[2];
    const bl = biotSavart(40, 3, lx, ly, lz);
    const bw = [0, 1, 2].map((i) => bl[0] * e1[i] + bl[1] * e2[i] + bl[2] * nrm[i]);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(out[i] - bw[i]) <= 1e-9 * Math.hypot(...bw), 'component ' + i);
});

test('uniform fields add everywhere; bMax', () => {
    const mag = compileMagnets([{ type: 'uniform', B: [0, 0, 0.5] }, { type: 'uniform', B: [0.1, 0, 0] }, { type: 'uniform', B: [0, 0, 1], enabled: false }], 'planar2d');
    const out = [0, 0, 0];
    mag.add(1e6, -1e6, 5, out);
    assert.deepEqual(out, [0.1, 0, 0.5]);
    assert.ok(mag.any && !mag.hasRegions);
    relEq(mag.bMax, Math.hypot(0.1, 0.5), 1e-15);
    assert.equal(compileMagnets([], 'planar2d').any, false);
});

test('regions: box, polygon (even-odd), annulus sector; signature bits; planar extrusion', () => {
    const mag = compileMagnets([
        { type: 'region', B: [0, 0, 1], region: { type: 'box', x0: 0, x1: 10, y0: 0, y1: 5 } },
        { type: 'region', B: [0, 0, 2], region: { type: 'polygon', points: [[20, 0], [30, 0], [30, 10], [20, 10], [20, 0], [24, 4], [26, 4], [26, 6], [24, 6], [24, 4]] } },
        { type: 'region', B: [0, 0, -0.5], region: { type: 'annulus', cx: 0, cy: 0, rIn: 50, rOut: 150, a0: 0, a1: 90 } },
        { type: 'region', B: [0, 0, 3], region: { type: 'annulus', cx: 0, cy: 0, rIn: 0, rOut: 10, a0: 300, a1: 420 } },
    ], 'planar2d');
    assert.ok(mag.hasRegions);
    const cases = [
        [[9, 4.5, 0], 1], [[9, 4.5, 1e4], 1], [[10, 5, 0], 1], [[10.001, 5, 0], 0], [[5, 2, 0], 9],
        [[21, 1, 0], 2], [[25, 5, 0], 0], [[27, 5, 0], 2],
        [[100, 1e-9, 0], 4], [[0, 100, 0], 4], [[-1e-9, 100, 0], 0], [[100, -1e-9, 0], 0], [[30, 30, 0], 0], [[120, 90, 0], 4],
        [[5, -1, 0], 8], [[5, 1, 0], 9], [[-5, 1, 0], 0],
    ];
    for (const [p, sig] of cases) assert.equal(mag.regionSig(p[0], p[1], p[2]), sig, 'sig at ' + p);
    const out = [0, 0, 0];
    mag.add(9, 4.5, 0, out); assert.deepEqual(out, [0, 0, 1]);
    const o2 = [0, 0, 0]; mag.add(9, 4.5, 0, o2, 4); assert.deepEqual(o2, [0, 0, -0.5], 'frozen signature overrides the position');
    const o3 = [0, 0, 0]; mag.add(5, 1, 0, o3); assert.deepEqual(o3, [0, 0, 4]);
});

test('regions in cyl2d: tested in (x, ρ), axial field only (with a warning)', () => {
    const mag = compileMagnets([{ type: 'region', B: [0.2, 0.3, 0], region: { type: 'box', x0: 0, x1: 10, y0: 2, y1: 4 } }], 'cyl2d');
    assert.equal(mag.warnings.length, 1);
    assert.equal(mag.regionSig(5, 0, 3), 1);
    assert.equal(mag.regionSig(5, 3 * Math.SQRT1_2, -3 * Math.SQRT1_2), 1);
    assert.equal(mag.regionSig(5, 1, 1), 0);
    const out = [0, 0, 0]; mag.add(5, 0, -3, out); assert.deepEqual(out, [0.2, 0, 0]);
    const coax = compileMagnets([{ type: 'loop', center: [0, 0, 0], normal: [1, 0, 0], radius: 5, current: 1 }], 'cyl2d');
    assert.equal(coax.warnings.length, 0);
    const off = compileMagnets([{ type: 'loop', center: [0, 1, 0], normal: [1, 0, 0], radius: 5, current: 1 }], 'cyl2d');
    assert.equal(off.warnings[0].code, 'W_LOOP_NOT_COAXIAL');
});
