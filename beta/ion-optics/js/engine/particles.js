/* ==========================================================================
   Ion optics engine: particles.js
   Particle sources: species table, particle counts and the generator.

   Every particle i of source s uses only uniform01/normal01(seed_s, s, i, c)
   (rng.js), so any index range can be generated independently and batching
   never changes a particle. Random sampling: cone with cos θ uniform in
   [cos α, 1] (solid), θ uniform (angle) or sin²θ uniform (Lambert); disc
   r = R√U; Gaussians by Box-Muller truncated at ±4σ; anisotropic emission
   P(θ) ∝ 1 + β·P₂(cos θ) by rejection (von Neumann). Species are apportioned
   by largest remainder and interleaved by the golden-ratio permutation
   j → j·g mod N (Kronecker sequence), so any prefix of a source holds the
   species in proportion. Grid sampling: Cartesian product species ×
   positions × directions × energies × times (species slowest); line points
   include the ends; discs use Vogel's spiral (Vogel, Math. Biosci. 44, 179
   (1979)); cones and spheres use Fibonacci lattices (González, Math. Geosci.
   42, 49 (2010)). Directions are built about +x and rotated onto the axis by
   Rodrigues' formula.

   Masses: CODATA 2022 proton mass; other ions are AME2020 atomic masses
   (Wang et al., Chin. Phys. C 45, 030003 (2021)) minus one electron mass.

   Particle lists ('rows' sources): one canonical row per particle,
   [mass, charge, x, y, z, dx, dy, dz, ke, t0]; generateRows/frozenSource
   turn a sampled source into such a list with the sampled directions kept
   bit for bit, so the frozen source reproduces the run; rowsFromEndStates
   builds the reverse-flight (v → −v, t0 reset) or hand-off list from a run's
   summary rows. Per-source weights: particleWeights/weightedSummary.
   ========================================================================== */
import { ME_U, C_MMUS, K_ACC, UC2_EV, speedFromKE, properSpeedFromKE } from './constants.js';
import { uniform01, normal01, Stream } from './rng.js';
import {
    P_STRIDE, P_ID, P_SRC, P_SPECIES, P_MASS, P_CHARGE, P_T0, P_X, P_Y, P_Z, P_WX, P_WY, P_WZ, P_KE, P_C0, P_C1, P_C2,
    S_STRIDE, S_ID, S_STATUS, S_WHERE, S_X, S_Y, S_Z, S_VX, S_VY, S_VZ, S_KE, S_SRC, S_SPECIES, STATUS,
} from './layout.js';

// AME2020 atomic masses (u) of the most abundant isotopes.
const ATOM = { He4: 4.00260325413, C12: 12, N14: 14.00307400425, O16: 15.99491461926, Ar40: 39.9623831237, Kr84: 83.9114977282, Xe132: 131.9041550856 };

/** Built-in species: { id, label, mass (u), charge (e), isotope }. */
export const SPECIES = Object.freeze([
    { id: 'e-', label: 'e⁻', mass: ME_U, charge: -1, isotope: 'electron' },
    { id: 'H+', label: 'H⁺', mass: 1.0072764665789, charge: 1, isotope: 'proton' },
    { id: 'He+', label: 'He⁺', mass: ATOM.He4 - ME_U, charge: 1, isotope: '⁴He' },
    { id: 'C+', label: 'C⁺', mass: ATOM.C12 - ME_U, charge: 1, isotope: '¹²C' },
    { id: 'N+', label: 'N⁺', mass: ATOM.N14 - ME_U, charge: 1, isotope: '¹⁴N' },
    { id: 'O+', label: 'O⁺', mass: ATOM.O16 - ME_U, charge: 1, isotope: '¹⁶O' },
    { id: 'N2+', label: 'N₂⁺', mass: 2 * ATOM.N14 - ME_U, charge: 1, isotope: '¹⁴N₂' },
    { id: 'O2+', label: 'O₂⁺', mass: 2 * ATOM.O16 - ME_U, charge: 1, isotope: '¹⁶O₂' },
    { id: 'Ar+', label: 'Ar⁺', mass: ATOM.Ar40 - ME_U, charge: 1, isotope: '⁴⁰Ar' },
    { id: 'Kr+', label: 'Kr⁺', mass: ATOM.Kr84 - ME_U, charge: 1, isotope: '⁸⁴Kr' },
    { id: 'Xe+', label: 'Xe⁺', mass: ATOM.Xe132 - ME_U, charge: 1, isotope: '¹³²Xe' },
    { id: 'C60+', label: 'C₆₀⁺', mass: 60 * ATOM.C12 - ME_U, charge: 1, isotope: '¹²C₆₀' },
].map((s) => Object.freeze(s)));

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const DEG = Math.PI / 180;
const SIGMA_PER_FWHM = 1 / (2 * Math.sqrt(2 * Math.LN2));
const LANE = 16;   // Stream lanes: LANE + stream id

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const intN = (v) => Math.max(1, Math.floor(num(v, 1)));
function v3(v) { return [num(v && v[0]), num(v && v[1]), num(v && v[2])]; }
function unit(v, fallback = [1, 0, 0]) {
    const a = v3(v), n = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : fallback.slice();
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Orthonormal pair (u, v) perpendicular to the unit vector n (u = x̂ or ŷ projected). */
function basisPerp(n) {
    const ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const d = ref[0] * n[0] + ref[1] * n[1] + ref[2] * n[2];
    const u = unit([ref[0] - d * n[0], ref[1] - d * n[1], ref[2] - d * n[2]]);
    return [u, cross(n, u)];
}

/** Rotation taking +x onto the unit axis a, applied to d (Rodrigues). */
function rotFromX(d, a, out) {
    const ax = a[0], ay = a[1], az = a[2];
    if (ax > 1 - 1e-15) { out[0] = d[0]; out[1] = d[1]; out[2] = d[2]; return out; }
    if (ax < -1 + 1e-15) { out[0] = -d[0]; out[1] = -d[1]; out[2] = d[2]; return out; }
    const s = Math.sqrt(ay * ay + az * az), kx = 0, ky = -az / s, kz = ay / s, c = ax;
    const kd = ky * d[1] + kz * d[2];
    const cx = ky * d[2] - kz * d[1], cy = kz * d[0] - kx * d[2], cz = kx * d[1] - ky * d[0];
    out[0] = d[0] * c + cx * s + kx * kd * (1 - c);
    out[1] = d[1] * c + cy * s + ky * kd * (1 - c);
    out[2] = d[2] * c + cz * s + kz * kd * (1 - c);
    return out;
}

// ---------------------------------------------------------------- counting

function speciesList(src) {
    const sp = Array.isArray(src.species) && src.species.length ? src.species : [{ label: 'm/z 100', mass: 100, charge: 1, fraction: 1 }];
    return sp;
}
function posCount(p) {
    switch (p && p.type) {
        case 'line': case 'disc': return intN(p.n);
        case 'rect': { const n = Array.isArray(p.n) ? p.n : [p.n, p.n]; return intN(n[0]) * intN(n[1]); }
        case 'list': return Math.max(1, (p.points || []).length);
        default: return 1;
    }
}
function dirCount(d) {
    switch (d && d.type) {
        case 'cone': case 'fan': case 'isotropic': return intN(d.n);
        default: return 1;
    }
}
function energyCount(e) {
    switch (e && e.type) {
        case 'uniform': return intN(e.n);
        case 'list': return Math.max(1, (e.values || []).length);
        default: return 1;
    }
}
function timeCount(t) {
    switch (t && t.type) {
        case 'uniform': case 'rfPhase': return intN(t.n);
        case 'list': return Math.max(1, (t.values || []).length);
        default: return 1;
    }
}

/**
 * Number of particles of one resolved source (0 if disabled). Grid sampling: the size of the
 * Cartesian product; random sampling: `count`.
 * @returns {number}
 */
export function sourceCount(src) {
    if (!src || src.enabled === false) return 0;
    if (src.type === 'rows') return Array.isArray(src.rows) ? src.rows.length : 0;
    if (src.sampling === 'grid') {
        return speciesList(src).length * posCount(src.position) * dirCount(src.direction) * energyCount(src.energy) * timeCount(src.time);
    }
    return Math.max(0, Math.floor(num(src.count)));
}

/**
 * Total particle count of the resolved sources (use sourceCount for one source).
 * @returns {number}
 */
export function countParticles(resolvedSources) {
    let n = 0;
    for (const s of resolvedSources || []) n += sourceCount(s);
    return n;
}

// ---------------------------------------------------------------- per-source sampler

function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }

/** Largest-remainder apportionment of N over fractions; returns cumulative bounds (length K+1). */
function apportion(N, fractions) {
    const K = fractions.length;
    let sum = 0; for (const f of fractions) sum += Math.max(0, f);
    const q = fractions.map((f) => (sum > 0 ? N * Math.max(0, f) / sum : N / K));
    const n = q.map(Math.floor);
    let rest = N - n.reduce((a, b) => a + b, 0);
    const order = q.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let i = 0; rest > 0; i = (i + 1) % K, rest--) n[order[i][1]]++;
    const cum = [0];
    for (let k = 0; k < K; k++) cum.push(cum[k] + n[k]);
    return cum;
}

function truncNormal(seed, s, j, c) {
    let z = normal01(seed, s, j, c);
    if (Math.abs(z) <= 4) return z;
    const st = new Stream(seed, s, j, LANE + c);
    for (let k = 0; k < 1000; k++) { z = st.normal(); if (Math.abs(z) <= 4) return z; }
    return 0;
}

/** Inverse CDF of cos θ for P ∝ 1 + β P₂(cos θ) on [−1, 1] (bisection). */
function isoInverse(u, beta) {
    if (beta === 0) return 2 * u - 1;
    const F = (c) => ((c + 1) + beta * (c * c * c - c) / 2) / 2;
    let lo = -1, hi = 1;
    for (let k = 0; k < 60; k++) { const m = 0.5 * (lo + hi); if (F(m) < u) lo = m; else hi = m; }
    return 0.5 * (lo + hi);
}

/**
 * Sampler of a 'rows' source (resolved form: [mass, charge, x, y, z, dx, dy, dz, ke, t0] per particle, unit direction).
 * The species index is the first entry of src.species with the row's mass and charge (the resolver appends one for every
 * pair, so it always exists); class indices come from src.classes when a frozen list carries one triple per row, else
 * they are −1. The proper velocity is wmag·d with the same wmag as a sampled source, so a frozen source reproduces the
 * sampled particles bit for bit.
 */
function makeRowSampler(src, sIndex, opts) {
    const rows = Array.isArray(src.rows) ? src.rows : [];
    const cls = Array.isArray(src.classes) && src.classes.length === rows.length ? src.classes : null;
    const species = Array.isArray(src.species) ? src.species : [];
    const spIndex = new Map();
    species.forEach((sp, k) => { const key = `${sp.mass}|${sp.charge}`; if (!spIndex.has(key)) spIndex.set(key, k); });
    const rel = opts.relativistic !== false;
    return function fill(j, id, out, o) {
        const r = rows[j] || [];
        const m = num(r[0], 100), q = num(r[1], 1), ke = Math.max(0, num(r[8]));
        const wmag = rel ? properSpeedFromKE(ke, m) : speedFromKE(ke, m, false);
        const key = `${m}|${q}`;
        let iS = spIndex.get(key);
        if (iS === undefined) {
            // not resolved through schema.js: register the pair so the summary still names a species
            iS = species.length; species.push({ label: `m/z ${+m.toPrecision(6)}`, mass: m, charge: q, fraction: 1 }); spIndex.set(key, iS);
        }
        out[o + P_ID] = id; out[o + P_SRC] = sIndex; out[o + P_SPECIES] = iS;
        out[o + P_MASS] = m; out[o + P_CHARGE] = q; out[o + P_T0] = num(r[9]);
        out[o + P_X] = num(r[2]); out[o + P_Y] = num(r[3]); out[o + P_Z] = num(r[4]);
        out[o + P_WX] = wmag * num(r[5]); out[o + P_WY] = wmag * num(r[6]); out[o + P_WZ] = wmag * num(r[7]);
        out[o + P_KE] = ke;
        const c = cls ? cls[j] : null;
        out[o + P_C0] = c ? num(c[0], -1) : -1; out[o + P_C1] = c ? num(c[1], -1) : -1; out[o + P_C2] = c ? num(c[2], -1) : -1;
    };
}

/**
 * Sampler of one source: fill(j, id, out, o) writes particle j of the source as a P_STRIDE row at offset o.
 * With `asRow`, fill(j) instead returns the canonical row [mass, charge, x, y, z, dx, dy, dz, ke, t0] with the direction
 * exactly as sampled (before the KE → velocity step), which is what "Freeze to list" stores.
 */
function makeSampler(src, sIndex, opts, asRow = false) {
    if (src.type === 'rows') {
        if (!asRow) return makeRowSampler(src, sIndex, opts);
        const rows = Array.isArray(src.rows) ? src.rows : [];
        return (j) => (rows[j] || []).slice(0, 10).map((v) => num(v));
    }
    const seed = num(src.seed, 1);
    const grid = src.sampling === 'grid';
    const species = speciesList(src).map((sp) => ({ mass: num(sp.mass, 100), charge: num(sp.charge, 1), fraction: num(sp.fraction, 1) }));
    const K = species.length;
    const P = src.position || { type: 'point', p: [0, 0, 0] };
    const Dd = src.direction || { type: 'fixed', dir: [1, 0, 0] };
    const En = src.energy || { type: 'mono', ke: 0 };
    const Tm = src.time || { type: 'fixed', t: 0 };
    const nPos = posCount(P), nDir = dirCount(Dd), nE = energyCount(En), nT = timeCount(Tm);
    const N = sourceCount(src);
    // random-mode species interleave
    let cum = null, g = 0;
    if (!grid && N > 0) {
        cum = apportion(N, species.map((s) => s.fraction));
        g = Math.round(N * 0.6180339887498949) % N;
        if (N > 1) { let d = 0; while (gcd(g, N) !== 1) { d = d > 0 ? -d : 1 - d; g = ((Math.round(N * 0.6180339887498949) + d) % N + N) % N; } }
    }
    // position setup
    const pTmp = [0, 0, 0];
    let discU = null, discV = null, rectU = null, rectV = null;
    if (P.type === 'disc') { const nrm = unit(P.normal, [1, 0, 0]); [discU, discV] = basisPerp(nrm); }
    if (P.type === 'rect') { rectU = unit(P.u, [1, 0, 0]); rectV = unit(P.v, [0, 1, 0]); }
    // direction setup
    const dirAxis = unit(Dd.axis || (Dd.type === 'fixed' ? Dd.dir : [1, 0, 0]), [1, 0, 0]);
    let fanA = null, fanN = null;
    if (Dd.type === 'fan') {
        fanN = unit(Dd.normal, [0, 0, 1]);
        const a = v3(Dd.axis || [1, 0, 0]), d = a[0] * fanN[0] + a[1] * fanN[1] + a[2] * fanN[2];
        fanA = unit([a[0] - d * fanN[0], a[1] - d * fanN[1], a[2] - d * fanN[2]], basisPerp(fanN)[0]);
    }
    const coneA = num(Dd.halfAngle) * DEG;
    const beta = num(Dd.beta);

    function position(j, k, out) {
        const c = P.p || P.center || [0, 0, 0];
        switch (P.type) {
            case 'line': {
                const p0 = v3(P.p0), p1 = v3(P.p1);
                const u = grid ? (nPos === 1 ? 0.5 : k / (nPos - 1)) : uniform01(seed, sIndex, j, 1);
                for (let i = 0; i < 3; i++) out[i] = p0[i] + u * (p1[i] - p0[i]);
                return;
            }
            case 'disc': {
                const cc = v3(P.center), R = num(P.radius);
                let r, ph;
                if (grid) { r = nPos === 1 ? 0 : R * Math.sqrt((k + 0.5) / nPos); ph = k * GOLDEN_ANGLE; }
                else { r = R * Math.sqrt(uniform01(seed, sIndex, j, 1)); ph = 2 * Math.PI * uniform01(seed, sIndex, j, 2); }
                const a = r * Math.cos(ph), b = r * Math.sin(ph);
                for (let i = 0; i < 3; i++) out[i] = cc[i] + a * discU[i] + b * discV[i];
                return;
            }
            case 'rect': {
                const cc = v3(P.center), hu = num(P.halfU), hv = num(P.halfV);
                let a, b;
                if (grid) {
                    const n = Array.isArray(P.n) ? P.n : [P.n, P.n], nu = intN(n[0]), nv = intN(n[1]);
                    const iu = Math.floor(k / nv), iv = k - iu * nv;
                    a = -hu + (iu + 0.5) * 2 * hu / nu; b = -hv + (iv + 0.5) * 2 * hv / nv;
                } else {
                    a = (2 * uniform01(seed, sIndex, j, 1) - 1) * hu; b = (2 * uniform01(seed, sIndex, j, 2) - 1) * hv;
                }
                for (let i = 0; i < 3; i++) out[i] = cc[i] + a * rectU[i] + b * rectV[i];
                return;
            }
            case 'gaussian': {
                const cc = v3(P.center), sg = v3(P.sigma);
                for (let i = 0; i < 3; i++) out[i] = cc[i] + (grid || sg[i] === 0 ? 0 : sg[i] * truncNormal(seed, sIndex, j, 1 + i));
                return;
            }
            case 'list': {
                const pts = P.points || [];
                if (!pts.length) { out[0] = 0; out[1] = 0; out[2] = 0; return; }
                const idx = grid ? k : Math.min(pts.length - 1, Math.floor(uniform01(seed, sIndex, j, 1) * pts.length));
                const p = v3(pts[idx]); out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
                return;
            }
            default: { const p = v3(c); out[0] = p[0]; out[1] = p[1]; out[2] = p[2]; }
        }
    }

    const dLocal = [0, 0, 0];
    function direction(j, k, out) {
        switch (Dd.type) {
            case 'cone': {
                let cth, ph;
                const fill = Dd.fill || 'solid';
                if (grid && nDir === 1) { out[0] = dirAxis[0]; out[1] = dirAxis[1]; out[2] = dirAxis[2]; return; }
                const u = grid ? (k + 0.5) / nDir : uniform01(seed, sIndex, j, 4);
                ph = grid ? k * GOLDEN_ANGLE : 2 * Math.PI * uniform01(seed, sIndex, j, 5);
                if (fill === 'angle') cth = Math.cos(u * coneA);
                else if (fill === 'lambert') { const s = Math.sqrt(u) * Math.sin(Math.min(coneA, Math.PI / 2)); cth = Math.sqrt(Math.max(0, 1 - s * s)); }
                else cth = 1 - u * (1 - Math.cos(coneA));
                const sth = Math.sqrt(Math.max(0, 1 - cth * cth));
                dLocal[0] = cth; dLocal[1] = sth * Math.cos(ph); dLocal[2] = sth * Math.sin(ph);
                rotFromX(dLocal, dirAxis, out);
                return;
            }
            case 'fan': {
                const from = num(Dd.from) * DEG, to = num(Dd.to) * DEG;
                const th = grid ? (nDir === 1 ? 0.5 * (from + to) : from + (to - from) * k / (nDir - 1)) : from + (to - from) * uniform01(seed, sIndex, j, 4);
                const c = Math.cos(th), s = Math.sin(th), na = cross(fanN, fanA);
                for (let i = 0; i < 3; i++) out[i] = fanA[i] * c + na[i] * s;
                return;
            }
            case 'isotropic': {
                let cth, ph;
                if (grid) {
                    cth = isoInverse(1 - (k + 0.5) / nDir, beta); ph = k * GOLDEN_ANGLE;
                } else {
                    const fmax = Math.max(1 + beta, 1 - beta / 2, 1e-12);
                    cth = 2 * uniform01(seed, sIndex, j, 4) - 1;
                    let acc = uniform01(seed, sIndex, j, 6);
                    const st = beta !== 0 ? new Stream(seed, sIndex, j, LANE + 4) : null;
                    for (let it = 0; beta !== 0 && it < 10000; it++) {
                        const w = (1 + beta * 0.5 * (3 * cth * cth - 1)) / fmax;
                        if (acc <= w) break;
                        cth = 2 * st.next() - 1; acc = st.next();
                    }
                    ph = 2 * Math.PI * uniform01(seed, sIndex, j, 5);
                }
                const sth = Math.sqrt(Math.max(0, 1 - cth * cth));
                dLocal[0] = cth; dLocal[1] = sth * Math.cos(ph); dLocal[2] = sth * Math.sin(ph);
                rotFromX(dLocal, dirAxis, out);
                return;
            }
            default: { const d = unit(Dd.dir || Dd.axis, [1, 0, 0]); out[0] = d[0]; out[1] = d[1]; out[2] = d[2]; }
        }
    }

    function energy(j, k) {
        switch (En.type) {
            case 'uniform': {
                const a = num(En.min), b = num(En.max);
                return grid ? (nE === 1 ? 0.5 * (a + b) : a + (b - a) * k / (nE - 1)) : a + (b - a) * uniform01(seed, sIndex, j, 7);
            }
            case 'gaussian': {
                const m = num(En.mean), sg = num(En.fwhm) * SIGMA_PER_FWHM;
                if (grid || sg === 0) return m;
                let z = normal01(seed, sIndex, j, 7), e = m + sg * z;
                if (Math.abs(z) <= 4 && e > 0) return e;
                const st = new Stream(seed, sIndex, j, LANE + 7);
                for (let it = 0; it < 10000; it++) { z = st.normal(); e = m + sg * z; if (Math.abs(z) <= 4 && e > 0) return e; }
                return Math.max(m, 0);
            }
            case 'list': {
                const vals = En.values || [];
                if (!vals.length) return 0;
                return num(vals[grid ? k : Math.min(vals.length - 1, Math.floor(uniform01(seed, sIndex, j, 7) * vals.length))]);
            }
            default: return num(En.ke);
        }
    }

    function time(j, k) {
        switch (Tm.type) {
            case 'uniform': {
                const a = num(Tm.t0), b = num(Tm.t1);
                return grid ? (nT === 1 ? 0.5 * (a + b) : a + (b - a) * k / (nT - 1)) : a + (b - a) * uniform01(seed, sIndex, j, 8);
            }
            case 'rfPhase': {
                const f = num(Tm.freq);
                if (!(f > 0)) return 0;
                return grid ? k / (nT * f) : uniform01(seed, sIndex, j, 8) / f;
            }
            case 'list': {
                const vals = Tm.values || [];
                if (!vals.length) return 0;
                return num(vals[grid ? k : Math.min(vals.length - 1, Math.floor(uniform01(seed, sIndex, j, 8) * vals.length))]);
            }
            default: return num(Tm.t);
        }
    }

    const dir = [0, 0, 0];
    return function fill(j, id, out, o) {
        let iS, iP, iD, iE, iT;
        if (grid) {
            let r = j;
            iT = r % nT; r = (r - iT) / nT;
            iE = r % nE; r = (r - iE) / nE;
            iD = r % nDir; r = (r - iD) / nDir;
            iP = r % nPos; r = (r - iP) / nPos;
            iS = r;
        } else {
            iP = iD = iE = iT = 0;
            const pj = N > 1 ? (j * g) % N : 0;
            iS = 0; while (iS < K - 1 && pj >= cum[iS + 1]) iS++;
        }
        const sp = species[iS];
        position(j, iP, pTmp);
        direction(j, iD, dir);
        const ke = Math.max(0, energy(j, iE));
        const t0 = time(j, iT);
        if (asRow) return [sp.mass, sp.charge, pTmp[0], pTmp[1], pTmp[2], dir[0], dir[1], dir[2], ke, t0];
        const rel = opts.relativistic !== false;
        const wmag = rel ? properSpeedFromKE(ke, sp.mass) : speedFromKE(ke, sp.mass, false);
        out[o + P_ID] = id; out[o + P_SRC] = sIndex; out[o + P_SPECIES] = iS;
        out[o + P_MASS] = sp.mass; out[o + P_CHARGE] = sp.charge; out[o + P_T0] = t0;
        out[o + P_X] = pTmp[0]; out[o + P_Y] = pTmp[1]; out[o + P_Z] = pTmp[2];
        out[o + P_WX] = wmag * dir[0]; out[o + P_WY] = wmag * dir[1]; out[o + P_WZ] = wmag * dir[2];
        out[o + P_KE] = ke;
        out[o + P_C0] = grid ? iP : -1; out[o + P_C1] = grid ? iD : -1; out[o + P_C2] = grid ? iE : -1;
    };
}

/**
 * Particles with global ids i0 ≤ id < i1 (ids run over the sources in order) as P_STRIDE rows.
 * Uses source.firstId/count when present, else derives them with sourceCount.
 * @param {Array<object>} resolvedSources @param {number} i0 @param {number} i1
 * @param {{ domainType?: string, relativistic?: boolean }} [opts]
 * @returns {Float64Array}
 */
export function generate(resolvedSources, i0, i1, opts = {}) {
    const { sources, firsts, counts, total } = idRanges(resolvedSources);
    i0 = Math.max(0, Math.floor(num(i0)));
    i1 = Math.min(total, Math.floor(num(i1, total)));
    const n = Math.max(0, i1 - i0);
    const out = new Float64Array(n * P_STRIDE);
    if (n === 0) return out;
    const samplers = new Array(sources.length).fill(null);
    let si = 0;
    for (let id = i0; id < i1; id++) {
        while (si < sources.length - 1 && id >= firsts[si] + counts[si]) si++;
        while (si > 0 && id < firsts[si]) si--;
        if (!samplers[si]) {
            const s = sources[si];
            samplers[si] = makeSampler(s, typeof s.index === 'number' ? s.index : si, opts);
        }
        samplers[si](id - firsts[si], id, out, (id - i0) * P_STRIDE);
    }
    return out;
}

/** Enabled sources with their id ranges (firstId/count when present, else derived in order). */
function idRanges(resolvedSources) {
    const sources = (resolvedSources || []).filter((s) => s && s.enabled !== false);
    const firsts = [], counts = [];
    let acc = 0;
    for (const s of sources) {
        const n = sourceCount(s);
        const f = typeof s.firstId === 'number' ? s.firstId : acc;
        firsts.push(f); counts.push(n); acc = f + n;
    }
    return { sources, firsts, counts, total: acc };
}

// ---------------------------------------------------------------- particle lists ('rows' sources)

/**
 * The particles of one resolved source as canonical rows [mass u, charge e, x, y, z mm, dx, dy, dz, ke eV, t0 µs], with the
 * direction exactly as the sampler produced it. A 'rows' source whose `rows` hold these particles generates the same
 * P_STRIDE rows as the original source, bit for bit ("Freeze to list").
 * @param {object} resolvedSource @param {{ relativistic?: boolean }} [opts]
 * @returns {number[][]}
 */
export function generateRows(resolvedSource, opts = {}) {
    const s = resolvedSource;
    if (!s || s.enabled === false) return [];
    const n = sourceCount(s);
    const fill = makeSampler(s, typeof s.index === 'number' ? s.index : 0, opts, true);
    const out = new Array(n);
    for (let j = 0; j < n; j++) out[j] = fill(j);
    return out;
}

/**
 * Class indices [position, direction, energy] of every particle of a resolved source as its sampler assigns them: one
 * triple per particle for grid sampling (or a list that carries them), 'random' for random sampling (every index −1:
 * one group). A frozen list stores them, so grouped metrics group its particles exactly as the original source's.
 * @param {object} resolvedSource @param {{ relativistic?: boolean }} [opts]
 * @returns {'random'|number[][]|null} null for a list without class indices
 */
export function sourceClasses(resolvedSource, opts = {}) {
    const s = resolvedSource;
    if (!s) return null;
    if (s.type === 'rows') return s.classes === 'random' || Array.isArray(s.classes) ? s.classes : null;
    if (s.sampling !== 'grid') return 'random';
    const n = sourceCount(s), fill = makeSampler(s, typeof s.index === 'number' ? s.index : 0, opts), row = new Float64Array(P_STRIDE), out = new Array(n);
    for (let j = 0; j < n; j++) { fill(j, j, row, 0); out[j] = [row[P_C0], row[P_C1], row[P_C2]]; }
    return out;
}

/**
 * The project object of a 'rows' source that reproduces a resolved source ("Freeze to list"): same id, name, color,
 * weight and species list, `rows` from generateRows and the class indices of the original particles (`classes`, see
 * sourceClasses; left out when unknown). Returns null for a disabled source.
 * @param {object} resolvedSource @param {{ relativistic?: boolean }} [opts]
 */
export function frozenSource(resolvedSource, opts = {}) {
    const s = resolvedSource;
    if (!s || s.enabled === false) return null;
    const species = Array.isArray(s.species) ? s.species.map((sp) => ({ label: sp.label, mass: sp.mass, charge: sp.charge, fraction: sp.fraction === undefined ? 1 : sp.fraction })) : [];
    const out = { id: s.id, name: s.name || s.id, enabled: true, color: s.color === undefined ? 'auto' : s.color, type: 'rows', weight: s.weight === undefined ? 1 : s.weight,
        species, velocity: false, rows: generateRows(s, opts) };
    const classes = sourceClasses(s, opts);
    if (classes !== null) out.classes = Array.isArray(classes) ? classes.map((c) => c.slice()) : classes;
    return out;
}

/**
 * Canonical rows from P_STRIDE particle rows (direction = w/|w|; a particle at rest keeps [1, 0, 0]).
 * @param {Float64Array} P @returns {number[][]}
 */
export function rowsFromParticles(P) {
    const n = Math.floor((P ? P.length : 0) / P_STRIDE), out = new Array(n);
    for (let i = 0; i < n; i++) {
        const o = i * P_STRIDE;
        const wx = P[o + P_WX], wy = P[o + P_WY], wz = P[o + P_WZ], w = Math.hypot(wx, wy, wz);
        const d = w > 0 ? [wx / w, wy / w, wz / w] : [1, 0, 0];
        out[i] = [P[o + P_MASS], P[o + P_CHARGE], P[o + P_X], P[o + P_Y], P[o + P_Z], d[0], d[1], d[2], P[o + P_KE], P[o + P_T0]];
    }
    return out;
}

/**
 * Rows from the end states of a run: position, kinetic energy and direction of every summary row, reversed
 * (v → −v) by default, with the birth time reset to `t0`. Mass and charge come from the run's species tables.
 * filter(status, S, o) → boolean selects the particles (default: every particle that moved: not CANCELLED, BORN_INSIDE or NUM_ERROR).
 * A particle at rest at the end gets the direction [1, 0, 0] (or [−1, 0, 0] when reversed).
 * @param {object} result TraceResult @param {object} resolved the run's resolved project
 * @param {{ reverse?: boolean, t0?: number, filter?: (status: number, S: Float64Array, o: number) => boolean }} [opts]
 * @returns {{ rows: number[][], ids: number[], species: object[] }}
 */
export function rowsFromEndStates(result, resolved, { reverse = true, t0 = 0, filter = null } = {}) {
    const S = result && result.summary ? result.summary : new Float64Array(0), n = result ? result.n : 0;
    const sources = (resolved && resolved.sources) || [];
    const sign = reverse ? -1 : 1;
    const skip = new Set([STATUS.CANCELLED, STATUS.BORN_INSIDE, STATUS.NUM_ERROR]);
    const rows = [], ids = [], species = [], spKey = new Map();
    for (let i = 0; i < n; i++) {
        const o = i * S_STRIDE, st = S[o + S_STATUS];
        if (filter ? !filter(st, S, o) : skip.has(st)) continue;
        const src = sources[S[o + S_SRC]];
        const sp = src && Array.isArray(src.species) ? src.species[S[o + S_SPECIES]] : null;
        if (!sp || !(sp.mass > 0) || !sp.charge) continue;
        const vx = S[o + S_VX], vy = S[o + S_VY], vz = S[o + S_VZ], v = Math.hypot(vx, vy, vz);
        const d = v > 0 ? [sign * vx / v, sign * vy / v, sign * vz / v] : [sign, 0, 0];
        rows.push([sp.mass, sp.charge, S[o + S_X], S[o + S_Y], S[o + S_Z], d[0], d[1], d[2], Math.max(0, S[o + S_KE]), t0]);
        ids.push(S[o + S_ID]);
        const key = `${sp.mass}|${sp.charge}`;
        if (!spKey.has(key)) { spKey.set(key, species.length); species.push({ label: sp.label, mass: sp.mass, charge: sp.charge, fraction: 1 }); }
    }
    return { rows, ids, species };
}

/**
 * Converts particle rows between the direction form [m, q, x, y, z, dx, dy, dz, ke, t0] and the velocity form
 * [m, q, x, y, z, vx, vy, vz, t0] (mm/µs; relativistic velocity when the flag is set).
 * @param {number[][]} rows @param {{ toVelocity: boolean, relativistic?: boolean }} opts
 * @returns {number[][]}
 */
export function convertRows(rows, { toVelocity, relativistic = true }) {
    const out = [];
    for (const r of rows || []) {
        if (!Array.isArray(r)) continue;
        if (toVelocity) {
            if (r.length === 9) { out.push(r.slice()); continue; }
            const m = num(r[0], 100), ke = Math.max(0, num(r[8]));
            const v = relativistic ? velocityFromKE(ke, m) : speedFromKE(ke, m, false);
            out.push([r[0], r[1], r[2], r[3], r[4], v * num(r[5]), v * num(r[6]), v * num(r[7]), r[9]]);
        } else {
            if (r.length === 10) { out.push(r.slice()); continue; }
            const m = num(r[0], 100), vx = num(r[5]), vy = num(r[6]), vz = num(r[7]), v = Math.hypot(vx, vy, vz);
            const d = v > 0 ? [vx / v, vy / v, vz / v] : [1, 0, 0];
            const ke = relativistic ? keFromVelocity(v, m) : m * v * v / (2 * K_ACC);
            out.push([r[0], r[1], r[2], r[3], r[4], d[0], d[1], d[2], ke, r[8]]);
        }
    }
    return out;
}
function velocityFromKE(ke, m) {
    const g = 1 + Math.max(0, ke) / (m * UC2_EV);
    return C_MMUS * Math.sqrt(Math.max(0, 1 - 1 / (g * g)));
}
function keFromVelocity(v, m) {
    const beta = Math.min(v / C_MMUS, 1 - 1e-15);
    return (1 / Math.sqrt(1 - beta * beta) - 1) * m * UC2_EV;
}

function freshId(list, prefix) {
    const used = new Set((list || []).map((o) => o && o.id));
    for (let n = 1; ; n++) if (!used.has(prefix + n)) return prefix + n;
}

/**
 * A 'rows' source holding the end states of a run ("Source from end states"): reversed (v → −v, reverse flight) or as
 * they ended (hand-off), birth time reset to t0. `filter` selects particles (see rowsFromEndStates); `ids` (a Set of
 * particle ids) is a shortcut for the rows shown in a table. Returns null when no particle qualifies.
 * @param {object} result @param {object} resolved
 * @param {{ reverse?: boolean, t0?: number, filter?: Function, ids?: Set<number>, id?: string, name?: string, weight?: number }} [opts]
 */
export function endStatesSource(result, resolved, { reverse = true, t0 = 0, filter = null, ids = null, id = null, name = null, weight = 1 } = {}) {
    const f = ids ? (st, S, o) => ids.has(S[o + S_ID]) && st !== STATUS.CANCELLED && st !== STATUS.BORN_INSIDE && st !== STATUS.NUM_ERROR : filter;
    const es = rowsFromEndStates(result, resolved, { reverse, t0, filter: f });
    if (!es.rows.length) return null;
    return { id: id || (reverse ? 'rev1' : 'end1'), name: name || (reverse ? 'Reversed end states' : 'End states'), enabled: true, color: 'auto',
        type: 'rows', weight, species: es.species, velocity: false, rows: es.rows, origin: { particles: es.ids.length, reverse } };
}

/**
 * Adds a source to a project draft (a fresh id when the given one is taken) and, by default, disables the other enabled
 * sources so that the new particles fly alone (a reverse-flight check). Returns { id, disabled }.
 * @param {object} project (mutated) @param {object} source @param {{ disableOthers?: boolean }} [opts]
 */
export function addEndStatesSource(project, source, { disableOthers = true } = {}) {
    project.sources = Array.isArray(project.sources) ? project.sources : [];
    let disabled = 0;
    if (disableOthers) for (const s of project.sources) if (s && s.enabled !== false) { s.enabled = false; disabled++; }
    const used = new Set(project.sources.map((s) => s && s.id));
    const id = source.id && !used.has(source.id) ? source.id : freshId(project.sources, source.id ? String(source.id).replace(/\d+$/, '') || 'r' : 'r');
    project.sources.push({ ...source, id });
    return { id, disabled };
}

// ---------------------------------------------------------------- weights

/** Weight of each source (resolved sources; 1 when absent), indexed like S_SRC. */
export function sourceWeights(resolvedSources) {
    const srcs = resolvedSources || [];
    let n = srcs.length;
    for (const s of srcs) if (s && typeof s.index === 'number') n = Math.max(n, s.index + 1);
    const w = new Float64Array(n).fill(1);
    srcs.forEach((s, k) => { const i = s && typeof s.index === 'number' ? s.index : k; if (s && s.weight > 0) w[i] = s.weight; });
    return w;
}

/**
 * Statistical weight of every summary row of a run (its source's `weight`, 1 by default): the `weights` input of
 * analysis.histogram and of weighted counts.
 * @param {object} result TraceResult @param {object} resolved
 * @returns {Float64Array}
 */
export function particleWeights(result, resolved) {
    const S = result && result.summary ? result.summary : new Float64Array(0), n = result ? result.n : 0;
    const w = sourceWeights(resolved && resolved.sources);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) { const k = S[i * S_STRIDE + S_SRC]; out[i] = k >= 0 && k < w.length ? w[k] : 1; }
    return out;
}

/**
 * Weighted counts of a run: Σw over launched particles, over detected particles (status DETECTED, per plane) and the
 * weighted transmission detected/launched; unweighted figures alongside.
 * @param {object} result TraceResult @param {object} resolved
 * @returns {{ launched: number, detected: number, transmission: number, byPlane: Array<{ index: number, detected: number, fraction: number }>,
 *   bySource: Array<{ index: number, weight: number, launched: number, detected: number, transmission: number }>, unweighted: { launched: number, detected: number, transmission: number } }}
 */
export function weightedSummary(result, resolved) {
    const S = result && result.summary ? result.summary : new Float64Array(0), n = result ? result.n : 0;
    const w = sourceWeights(resolved && resolved.sources);
    const byPlane = new Map(), bySrc = new Map();
    let launched = 0, detected = 0, nDet = 0;
    for (let i = 0; i < n; i++) {
        const o = i * S_STRIDE, k = S[o + S_SRC], wi = k >= 0 && k < w.length ? w[k] : 1, det = S[o + S_STATUS] === STATUS.DETECTED;
        launched += wi;
        let bs = bySrc.get(k);
        if (!bs) { bs = { index: k, weight: wi, launched: 0, detected: 0, transmission: 0 }; bySrc.set(k, bs); }
        bs.launched += wi;
        if (det) {
            detected += wi; nDet++; bs.detected += wi;
            const p = S[o + S_WHERE];
            byPlane.set(p, (byPlane.get(p) || 0) + wi);
        }
    }
    for (const bs of bySrc.values()) bs.transmission = bs.launched > 0 ? bs.detected / bs.launched : 0;
    return {
        launched, detected, transmission: launched > 0 ? detected / launched : 0,
        byPlane: [...byPlane.entries()].sort((a, b) => a[0] - b[0]).map(([index, d]) => ({ index, detected: d, fraction: launched > 0 ? d / launched : 0 })),
        bySource: [...bySrc.values()].sort((a, b) => a.index - b.index),
        unweighted: { launched: n, detected: nDet, transmission: n > 0 ? nDet / n : 0 },
    };
}
