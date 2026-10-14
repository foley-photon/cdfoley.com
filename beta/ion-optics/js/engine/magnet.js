/* ==========================================================================
   Ion optics engine: magnet.js
   Static magnetic fields: uniform fields, hard-edged field regions and exact
   circular current loops.

   Regions are tested in plane coordinates, (x, y) for planar2d (extruded in z)
   and (x, ρ) for cyl2d (revolved about x, axial field only); fringe fields are
   not modelled. Region i sets bit i of the region signature used by the tracer
   to stop steps at field edges.

   Current loop: closed-form field of a circular filament, Simpson, Lane, Immer
   & Youngquist, "Simple analytic expressions for the magnetic field of a
   circular current loop", NASA Technical Report (2001); complete elliptic
   integrals K(m), E(m) by the arithmetic-geometric mean, Abramowitz & Stegun,
   Handbook of Mathematical Functions, §17.6. Units: mm, A, T.
   ========================================================================== */
import { MU0 } from './constants.js';

const MU0_MM = MU0 * 1e3;   // T·mm/A
const DEG = Math.PI / 180;

// Elliptic-integral scratch (typed, so field evaluation never allocates).
const KE2 = new Float64Array(2);
function ellipKE(m) {
    if (!(m < 1)) { KE2[0] = Infinity; KE2[1] = 1; return; }
    if (m < 0) m = 0;
    let a = 1, b = Math.sqrt(1 - m), c = Math.sqrt(m), sum = 0.5 * m, p2 = 0.5;
    for (let n = 0; n < 60; n++) {
        if (Math.abs(c) <= 1e-17 * a) break;
        const an = 0.5 * (a + b), bn = Math.sqrt(a * b);
        c = 0.5 * (a - b);
        a = an; b = bn; p2 *= 2; sum += p2 * c * c;
    }
    KE2[0] = Math.PI / (2 * a);
    KE2[1] = KE2[0] * (1 - sum);
}

/**
 * Complete elliptic integrals of the first and second kind with parameter m = k².
 * @param {number} m @returns {[number, number]} [K(m), E(m)]
 */
export function ellipticKE(m) {
    ellipKE(m);
    return [KE2[0], KE2[1]];
}

/**
 * Field of a circular loop in its own frame (ρ ≥ 0 from the axis, z along the normal, mm).
 * Positive current circulates counter-clockwise seen from +z, so B_z > 0 at the centre.
 * @param {number} radiusMm @param {number} currentA @param {number} turns @param {number} rhoMm @param {number} zMm
 * @param {Float64Array|number[]} out2  [Bρ, Bz] in T
 */
export function loopField(radiusMm, currentA, turns, rhoMm, zMm, out2) {
    const a = radiusMm, NI = (turns === undefined ? 1 : turns) * currentA, z = zMm;
    const rho = Math.abs(rhoMm), sgn = rhoMm < 0 ? -1 : 1;
    if (!(a > 0) || NI === 0) { out2[0] = 0; out2[1] = 0; return out2; }
    if (rho < 1e-9 * a) {
        const d2 = a * a + z * z;
        out2[0] = 0; out2[1] = MU0_MM * NI * a * a / (2 * d2 * Math.sqrt(d2));
        return out2;
    }
    const r2 = rho * rho + z * z, a2 = a * a;
    const alpha2 = a2 + r2 - 2 * a * rho, beta2 = a2 + r2 + 2 * a * rho, beta = Math.sqrt(beta2);
    ellipKE(1 - alpha2 / beta2);
    const eK = KE2[0], eE = KE2[1];
    const C = MU0_MM * NI / Math.PI;
    out2[0] = sgn * C * z / (2 * alpha2 * beta * rho) * ((a2 + r2) * eE - alpha2 * eK);
    out2[1] = C / (2 * alpha2 * beta) * ((a2 - r2) * eE + alpha2 * eK);
    return out2;
}

function vec3(v, d = 0) {
    return [Number(v && v[0]) || d, Number(v && v[1]) || d, Number(v && v[2]) || d];
}

/** Inside test for a region in plane coordinates (closed sets). */
function regionTest(region) {
    const r = region || {};
    const type = r.type || (Array.isArray(r.points) ? 'polygon' : (r.rOut !== undefined ? 'annulus' : 'box'));
    if (type === 'box') {
        const x0 = Math.min(+r.x0, +r.x1), x1 = Math.max(+r.x0, +r.x1), y0 = Math.min(+r.y0, +r.y1), y1 = Math.max(+r.y0, +r.y1);
        return (X, Y) => X >= x0 && X <= x1 && Y >= y0 && Y <= y1;
    }
    if (type === 'polygon') {
        const pts = (r.points || []).map((p) => [+p[0], +p[1]]);
        const n = pts.length, px = new Float64Array(n), py = new Float64Array(n);
        for (let i = 0; i < n; i++) { px[i] = pts[i][0]; py[i] = pts[i][1]; }
        return (X, Y) => {   // even-odd rule
            let inside = false;
            for (let i = 0, j = n - 1; i < n; j = i++) {
                if ((py[i] > Y) !== (py[j] > Y) && X < (px[j] - px[i]) * (Y - py[i]) / (py[j] - py[i]) + px[i]) inside = !inside;
            }
            return inside;
        };
    }
    if (type === 'annulus') {
        const cx = +r.cx || 0, cy = +r.cy || 0, rIn = Math.max(0, +r.rIn || 0), rOut = +r.rOut;
        const a0 = r.a0 === undefined ? 0 : +r.a0, a1 = r.a1 === undefined ? 360 : +r.a1;
        const span = a1 - a0, full = span >= 360;
        const rIn2 = rIn * rIn, rOut2 = rOut * rOut;
        return (X, Y) => {
            const dx = X - cx, dy = Y - cy, d2 = dx * dx + dy * dy;
            if (d2 < rIn2 || d2 > rOut2) return false;
            if (full) return true;
            let ang = Math.atan2(dy, dx) / DEG - a0;
            ang = ((ang % 360) + 360) % 360;
            return ang <= span || ang >= 360 - 1e-12;
        };
    }
    return () => false;
}

/**
 * Compiles the enabled magnets of a resolved project.
 * add(x, y, z, out3, sig) adds B (T) at (x, y, z); with sig ≥ 0 the region membership is taken from the
 * signature bits instead of the position (used by the tracer to keep one field across a step).
 * @param {Array<object>} resolvedMagnets @param {'planar2d'|'cyl2d'} domainType
 */
export function compileMagnets(resolvedMagnets, domainType) {
    const cyl = domainType === 'cyl2d';
    const list = (resolvedMagnets || []).filter((m) => m && m.enabled !== false);
    const warnings = [];
    let ubx = 0, uby = 0, ubz = 0, haveUniform = false;
    const regions = [], loops = [];
    for (const m of list) {
        if (m.type === 'uniform') {
            const B = vec3(m.B); ubx += B[0]; uby += B[1]; ubz += B[2]; haveUniform = haveUniform || B[0] !== 0 || B[1] !== 0 || B[2] !== 0;
        } else if (m.type === 'region') {
            const B = vec3(m.B);
            if (cyl && (B[1] !== 0 || B[2] !== 0)) {
                warnings.push({ path: 'magnets.' + (m.id || regions.length), code: 'W_REGION_AXIAL', message: 'Revolved field regions carry an axial field only; By and Bz ignored.' });
                B[1] = 0; B[2] = 0;
            }
            regions.push({ id: m.id, bx: B[0], by: B[1], bz: B[2], test: regionTest(m.region) });
        } else if (m.type === 'loop') {
            const c = vec3(m.center), nv = vec3(m.normal, 0);
            let nn = Math.sqrt(nv[0] * nv[0] + nv[1] * nv[1] + nv[2] * nv[2]);
            if (!(nn > 0)) { nv[0] = 1; nv[1] = 0; nv[2] = 0; nn = 1; }
            const loop = { id: m.id, cx: c[0], cy: c[1], cz: c[2], nx: nv[0] / nn, ny: nv[1] / nn, nz: nv[2] / nn,
                a: +m.radius, turns: m.turns === undefined ? 1 : +m.turns, current: +m.current || 0 };
            if (cyl && (Math.abs(loop.cy) > 1e-12 || Math.abs(loop.cz) > 1e-12 || Math.abs(Math.abs(loop.nx) - 1) > 1e-12)) {
                warnings.push({ path: 'magnets.' + (m.id || loops.length), code: 'W_LOOP_NOT_COAXIAL', message: 'Loop is not coaxial with the symmetry axis; the field is not axisymmetric.' });
            }
            loops.push(loop);
        }
    }
    if (regions.length > 32) throw Object.assign(new Error('At most 32 field regions.'), { name: 'EngineError', code: 'E_BAD_PROJECT' });
    const nR = regions.length, nL = loops.length;
    const rbx = new Float64Array(nR), rby = new Float64Array(nR), rbz = new Float64Array(nR), tests = regions.map((r) => r.test);
    for (let i = 0; i < nR; i++) { rbx[i] = regions[i].bx; rby[i] = regions[i].by; rbz[i] = regions[i].bz; }
    let bMax = Math.sqrt(ubx * ubx + uby * uby + ubz * ubz), regMax = 0;
    for (let i = 0; i < nR; i++) regMax = Math.max(regMax, Math.sqrt(rbx[i] * rbx[i] + rby[i] * rby[i] + rbz[i] * rbz[i]));
    bMax += regMax;
    for (const L of loops) if (L.a > 0) bMax += Math.abs(MU0_MM * L.turns * L.current / (2 * L.a));
    const any = haveUniform || nR > 0 || nL > 0;
    const out2 = new Float64Array(2);

    const sigAt = (x, y, z) => {
        if (nR === 0) return 0;
        const X = x, Y = cyl ? Math.sqrt(y * y + z * z) : y;
        let s = 0;
        for (let i = 0; i < nR; i++) if (tests[i](X, Y)) s = (s | (1 << i)) >>> 0;
        return s;
    };

    // vector-argument form: P = [t, x, y, z] (avoids boxing doubles on every call)
    const addV = (P, out3, sig) => {
        const x = P[1], y = P[2], z = P[3];
        out3[0] += ubx; out3[1] += uby; out3[2] += ubz;
        if (nR > 0) {
            const s = sig >= 0 ? sig : sigAt(x, y, z);
            if (s !== 0) for (let i = 0; i < nR; i++) if ((s >>> i) & 1) { out3[0] += rbx[i]; out3[1] += rby[i]; out3[2] += rbz[i]; }
        }
        for (let i = 0; i < nL; i++) {
            const L = loops[i];
            const dx = x - L.cx, dy = y - L.cy, dz = z - L.cz;
            const zl = dx * L.nx + dy * L.ny + dz * L.nz;
            const px = dx - zl * L.nx, py = dy - zl * L.ny, pz = dz - zl * L.nz;
            const rho = Math.sqrt(px * px + py * py + pz * pz);
            loopField(L.a, L.current, L.turns, rho, zl, out2);
            out3[0] += out2[1] * L.nx; out3[1] += out2[1] * L.ny; out3[2] += out2[1] * L.nz;
            if (rho > 0 && out2[0] !== 0) { const s = out2[0] / rho; out3[0] += s * px; out3[1] += s * py; out3[2] += s * pz; }
        }
        return out3;
    };
    const PV = new Float64Array(4);
    const add = (x, y, z, out3, sig = -1) => { PV[1] = x; PV[2] = y; PV[3] = z; return addV(PV, out3, sig); };

    return { any, hasRegions: nR > 0, nRegions: nR, bMax, uniform: [ubx, uby, ubz], add, addV, regionSig: sigAt, warnings };
}
