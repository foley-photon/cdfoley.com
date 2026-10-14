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
   ========================================================================== */
import { ME_U, speedFromKE, properSpeedFromKE } from './constants.js';
import { uniform01, normal01, Stream } from './rng.js';
import { P_STRIDE, P_ID, P_SRC, P_SPECIES, P_MASS, P_CHARGE, P_T0, P_X, P_Y, P_Z, P_WX, P_WY, P_WZ, P_KE, P_C0, P_C1, P_C2 } from './layout.js';

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

function makeSampler(src, sIndex, opts) {
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
    const sources = (resolvedSources || []).filter((s) => s && s.enabled !== false);
    const firsts = [], counts = [];
    let acc = 0;
    for (const s of sources) {
        const n = sourceCount(s);
        const f = typeof s.firstId === 'number' ? s.firstId : acc;
        firsts.push(f); counts.push(n); acc = f + n;
    }
    const total = acc;
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
