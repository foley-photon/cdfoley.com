// Transitional and viscous flow laws (spec 2.5, 3.3): Sharipov's rarefaction function Z(delta) and its integral,
// the core law of an element interior with isothermal exit choking, the orifice (entrance or contraction) law with
// the isentropic cap, and the pump sink. Pure module. Flows Q are in Pa m^3/s, positive from node a to node b.

import { GP_SHARIPOV, ORIFICE_A } from './tables.js';
import { makePchip } from './interp.js';

const SQRT_PI = Math.sqrt(Math.PI), G0 = 8 / (3 * SQRT_PI), K_SAMPSON = 2 / (3 * SQRT_PI);
const GPD = GP_SHARIPOV.delta, NG = GPD.length, D_LO = GPD[0], D_HI = GPD[NG - 1];
const ZV = GP_SHARIPOV.GP.map((g, i) => (g - GPD[i] / 4) / G0);
const zLn = makePchip(GPD.map(Math.log), ZV);

/** Z(delta) = (G_P(delta) - delta/4)/G0: PCHIP in ln delta through Sharipov's nodes; Z(0) = 1; slip limit above 50. */
export function Z(delta) {
    if (delta <= 0) return 1;
    if (delta < D_LO) return 1 + (ZV[0] - 1) * delta / D_LO;
    if (delta <= D_HI) return zLn(Math.log(delta));
    return (1.018 - 1.15 / delta) / G0;
}

// 5-point Gauss-Legendre in ln t over [a, b] of Z(t) dt
const GLX = [-0.9061798459386640, -0.5384693101056831, 0, 0.5384693101056831, 0.9061798459386640];
const GLW = [0.2369268850561891, 0.4786286704993665, 0.5688888888888889, 0.4786286704993665, 0.2369268850561891];
function intZ(a, b) {
    const ua = Math.log(a), ub = Math.log(b), hm = (ub - ua) / 2, c = (ub + ua) / 2;
    let s = 0;
    for (let k = 0; k < 5; k++) { const t = Math.exp(c + hm * GLX[k]); s += GLW[k] * Z(t) * t; }
    return s * hm;
}
const CUM = new Float64Array(NG);
CUM[0] = D_LO * (1 + ZV[0]) / 2;
for (let i = 1; i < NG; i++) CUM[i] = CUM[i - 1] + intZ(GPD[i - 1], GPD[i]);

/** Integral of Z from 0 to delta. */
export function IZ(delta) {
    if (delta <= 0) return 0;
    if (delta <= D_LO) return delta + (ZV[0] - 1) * delta * delta / (2 * D_LO);
    if (delta <= D_HI) { let i = 0; while (GPD[i + 1] < delta) i++; return CUM[i] + intZ(GPD[i], delta); }
    return CUM[NG - 1] + (1.018 * (delta - D_HI) - 1.15 * Math.log(delta / D_HI)) / G0;
}

/** Long-tube reduced flow rate G_P(delta) = delta/4 + G0 Z(delta). */
export function GP(delta) { return delta / 4 + G0 * Z(delta); }

// Plane-channel (slot) Poiseuille flow rate G_P^ch(delta), delta = h p/(eta vm) on the full gap h: Sharipov & Seleznev,
// J. Phys. Chem. Ref. Data 27, 657 (1998), Table 3 (Cercignani & Pagani, BGK, diffuse walls). A channel of width w and
// length L carries C = (w h^2 vm/(2L)) G_P^ch; the part beyond plane Poiseuille (delta/6) is channelF = G_P^ch - delta/6.
const GCH_D = [0.01, 0.02, 0.03, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1, 1.5, 2, 3, 4, 5, 7, 10];
const GCH_G = [3.0489, 2.7107, 2.5234, 2.3016, 2.0314, 1.8079, 1.7092, 1.6017, 1.5591, 1.5389, 1.5530, 1.5942, 1.7092, 1.8440, 1.9883, 2.2914, 2.7638];
const GCH_F = GCH_G.map((g, i) => g - GCH_D[i] / 6), fLn = makePchip(GCH_D.map(Math.log), GCH_F);
const GCH_LO = GCH_D[0], GCH_HI = GCH_D[GCH_D.length - 1], SIGMA_P = 1.016;
const GCH_C = (GCH_F[GCH_F.length - 1] - SIGMA_P) * GCH_HI;

/**
 * channelF(delta) = G_P^ch(delta) - delta/6 of a long plane channel: PCHIP in ln delta through the table; below 0.01 the
 * free-molecular logarithm (1/sqrt(pi)) ln(1/delta); above 10 the slip limit 1.016 + c/delta (continuous at 10).
 */
export function channelF(delta) {
    if (!(delta > 0)) return Infinity;
    if (delta < GCH_LO) return GCH_F[0] + Math.log(GCH_LO / delta) / SQRT_PI;
    if (delta <= GCH_HI) return fLn(Math.log(delta));
    return SIGMA_P + GCH_C / delta;
}

// Rarefaction function of a slot-like core (rectangular duct, slit, annulus): Zc(t) = min(Z(t), ratio channelF(rho t)),
// with t = p/s the element's own rarefaction variable, ratio = (w h^2 vm/(2L))/Cm and rho = h/r_ref. The round-tube Z
// keeps the free-molecular long-flight enhancement of a wide gap at every pressure; gas collisions cut those flights
// off at about one mean free path, which the plane-channel solution includes. Both are upper bounds of the true
// flow, so the smaller one is used. IZ integrates Zc exactly piece by piece: the crossings of the two branches are
// grid nodes, so every interval holds one smooth branch. Below t = 1e-12 and above 1e9, Zc is held constant.
const ZC_LO = 1e-12, ZC_HI = 1e9, ZC_PER_DECADE = 10;
const zcCache = new Map();
export function cappedZ(ratio, rho) {
    const key = ratio + '|' + rho;
    let z = zcCache.get(key);
    if (z) return z;
    const zf = (t) => Math.min(Z(t), ratio * channelF(rho * t));
    const diff = (t) => Z(t) - ratio * channelF(rho * t);
    const nodes = [];
    const nDec = Math.log10(ZC_HI / ZC_LO), steps = Math.round(nDec * ZC_PER_DECADE);
    let tPrev = ZC_LO, dPrev = diff(ZC_LO);
    nodes.push(ZC_LO);
    for (let k = 1; k <= steps; k++) {
        const t = ZC_LO * Math.pow(10, k / ZC_PER_DECADE), d = diff(t);
        if ((d > 0) !== (dPrev > 0)) {           // a crossing in (tPrev, t): bisect in ln t
            let lo = Math.log(tPrev), hi = Math.log(t);
            for (let i = 0; i < 60; i++) { const m = 0.5 * (lo + hi); if ((diff(Math.exp(m)) > 0) === (dPrev > 0)) lo = m; else hi = m; }
            nodes.push(Math.exp(0.5 * (lo + hi)));
        }
        nodes.push(t);
        tPrev = t; dPrev = d;
    }
    const n = nodes.length, cum = new Float64Array(n);
    const gl = (a, b) => {
        const ua = Math.log(a), ub = Math.log(b), hm = (ub - ua) / 2, c = (ub + ua) / 2;
        let s = 0;
        for (let k = 0; k < 5; k++) { const t = Math.exp(c + hm * GLX[k]); s += GLW[k] * zf(t) * t; }
        return s * hm;
    };
    const zLo = zf(ZC_LO), zHi = zf(ZC_HI);
    cum[0] = ZC_LO * zLo;
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + gl(nodes[i - 1], nodes[i]);
    z = {
        ratio, rho,
        Z(t) { return t <= ZC_LO ? zLo : t >= ZC_HI ? zHi : zf(t); },
        IZ(t) {
            if (t <= 0) return 0;
            if (t <= ZC_LO) return t * zLo;
            if (t >= ZC_HI) return cum[n - 1] + (t - ZC_HI) * zHi;
            let lo = 0, hi = n - 1;
            while (hi - lo > 1) { const m = (lo + hi) >> 1; if (nodes[m] <= t) lo = m; else hi = m; }
            return cum[lo] + (t > nodes[lo] ? gl(nodes[lo], t) : 0);
        },
    };
    if (zcCache.size > 256) zcCache.clear();
    zcCache.set(key, z);
    return z;
}

const AR = ORIFICE_A.r, AA = ORIFICE_A.A;
// Segment of the piecewise-linear A(r) that holds r (r clamped to [0, 1]).
function aSegment(r) {
    let i = 0;
    while (i < AR.length - 2 && AR[i + 1] < r) i++;
    return i;
}

/** Near-free-molecular orifice coefficient A(r), piecewise linear in r = p_low/p_high (clamped to [0, 1]). */
export function nearFmA(r) {
    r = Math.min(1, Math.max(0, r));
    const i = aSegment(r);
    return AA[i] + (AA[i + 1] - AA[i]) * (r - AR[i]) / (AR[i + 1] - AR[i]);
}

/** Orifice rarefaction factor g(delta, r) = max(1 + A(r) delta, (2/(3 sqrt(pi))) delta (1 + r)/2). */
export function gOrifice(delta, r) { return Math.max(1 + nearFmA(r) * delta, K_SAMPSON * delta * (1 + r) / 2); }

/** Critical pressure ratio (2/(gamma+1))^(gamma/(gamma-1)). */
export function rStar(gamma) { return Math.pow(2 / (gamma + 1), gamma / (gamma - 1)); }

/** Isentropic flow function psi(r, gamma); constant (choked) for r <= r*. */
export function psi(r, gamma) {
    if (r <= rStar(gamma)) return Math.sqrt(gamma) * Math.pow(2 / (gamma + 1), (gamma + 1) / (2 * (gamma - 1)));
    return Math.sqrt(2 * gamma / (gamma - 1) * Math.max(0, Math.pow(r, 2 / gamma) - Math.pow(r, (gamma + 1) / gamma)));
}

// psi at r = pb/pa (pa >= pb > 0) and its derivative dpsi/dr. Above r* it is evaluated from ln r = log1p(-(pa - pb)/pa)
// as r^(2/g) (1 - r^((g-1)/g)), which keeps full precision as r tends to 1, where the plain formula cancels.
function psiDerivs(pa, pb, gamma) {
    if (pb / pa <= rStar(gamma)) return [psi(0, gamma), 0];
    const lnr = Math.log1p((pb - pa) / pa), c = 2 * gamma / (gamma - 1);
    const p = Math.sqrt(c * Math.max(0, -Math.exp(2 * lnr / gamma) * Math.expm1((gamma - 1) * lnr / gamma)));
    const du = (2 / gamma) * Math.exp((2 / gamma - 1) * lnr) - ((gamma + 1) / gamma) * Math.exp(lnr / gamma);
    return [p, p > 0 ? c * du / (2 * p) : 0];
}

/**
 * Isothermal exit-choke pressure p_c of a core edge at upstream pressure pa: kv (pa^2 - p_c^2)/2 = p_c A_out sqrt(Rs T),
 * i.e. p_c = (sqrt(w^2 + kv^2 pa^2) - w)/kv, written without cancellation as kv pa^2/(sqrt(w^2 + kv^2 pa^2) + w).
 */
export function coreChokeP(edge, pa, G) {
    const w = edge.Aout * Math.sqrt(G.Rs * G.T), x = edge.kv * pa;
    return x * pa / (Math.sqrt(w * w + x * x) + w);
}

// Linear (rarefied-to-creeping) resistance of an orifice edge at upstream pressure pa and ratio r; kept positive.
function orifR(edge, pa, r, G) {
    const Rto = 4 / (G.vbar * edge.Ato * gOrifice(edge.reTo * pa / (G.eta * G.vm), r));
    let R = Rto;
    if (edge.Afrom !== Infinity) R -= 4 / (G.vbar * edge.Afrom * gOrifice(edge.reFrom * pa / (G.eta * G.vm), r));
    return Math.max(R, 1e-9 * Rto);
}

// The two branches of an orifice edge for pa >= pb: linear (rarefied to creeping) and isentropic.
const orifLin = (edge, pa, pb, G) => (pa - pb) / orifR(edge, pa, pb / pa, G);
const orifIsen = (edge, pa, pb, G) => G.Cd * edge.Ato * pa * psiDerivs(pa, pb, G.gamma)[0] * Math.sqrt(G.Rs * G.T);

// g(delta, r) of spec 3.3.3 with delta = re pa/(eta vm) and r = pb/pa, and its partial derivatives [g, dg/dpa, dg/dpb].
function gDerivs(re, pa, r, G) {
    const dd = re / (G.eta * G.vm), delta = dd * pa, A = nearFmA(r);
    const g1 = 1 + A * delta, g2 = K_SAMPSON * delta * (1 + r) / 2;
    if (g1 >= g2) {
        const i = aSegment(Math.min(1, Math.max(0, r))), slope = (AA[i + 1] - AA[i]) / (AR[i + 1] - AR[i]);
        return [g1, dd * (A - r * slope), dd * slope];
    }
    return [g2, K_SAMPSON * dd / 2, K_SAMPSON * dd / 2];
}

// Analytic [dQ/dpa, dQ/dpb] of the linear branch Q = (pa - pb)/R_lin(pa, pb/pa) for pa > pb.
function orifLinDerivs(edge, pa, pb, G) {
    const r = pb / pa, c = 4 / G.vbar, [gt, gta, gtb] = gDerivs(edge.reTo, pa, r, G), Rto = c / (edge.Ato * gt);
    let R = Rto, Ra = -Rto * gta / gt, Rb = -Rto * gtb / gt;
    if (edge.Afrom !== Infinity) {
        const [gf, gfa, gfb] = gDerivs(edge.reFrom, pa, r, G), Rf = c / (edge.Afrom * gf);
        R -= Rf; Ra += Rf * gfa / gf; Rb += Rf * gfb / gf;
    }
    if (!(R >= 1e-9 * Rto)) { R = 1e-9 * Rto; Ra = -1e-9 * Rto * gta / gt; Rb = -1e-9 * Rto * gtb / gt; }
    const q = (pa - pb) / R;
    return [(1 - q * Ra) / R, (-1 - q * Rb) / R];
}

// Analytic [dQ/dpa, dQ/dpb] of the isentropic branch Q = Cd A_to pa psi(pb/pa) sqrt(Rs T) for pa > pb.
function orifIsenDerivs(edge, pa, pb, G) {
    const K = G.Cd * edge.Ato * Math.sqrt(G.Rs * G.T), [p, dp] = psiDerivs(pa, pb, G.gamma);
    return [K * (p - (pb / pa) * dp), K * dp];
}

/** Throughput (Pa m^3/s) of an edge from a to b at node pressures pa, pb; antisymmetric. */
export function edgeFlow(edge, pa, pb, G) {
    if (pa < pb) return -edgeFlow(edge, pb, pa, G);
    if (pa === pb) return 0;
    if (edge.k === 'core') {
        const px = Math.max(pb, coreChokeP(edge, pa, G)), iz = edge.zc ? edge.zc.IZ : IZ;
        return edge.kv * (pa - px) * (pa + px) / 2 + edge.Cm * edge.s * (iz(pa / edge.s) - iz(pb / edge.s));
    }
    return Math.min(orifLin(edge, pa, pb, G), orifIsen(edge, pa, pb, G));
}

/**
 * [Q, dQ/dpa, dQ/dpb], all analytic. Core edges: spec 3.5.5, plus the exit-choked branch, where
 * dp_c/dpa = kv pa/(w + kv p_c). Orifice edges: the derivative of the branch (linear or isentropic) that sets the flow.
 * (Spec 3.5.5 differentiates choked cores and orifice edges numerically; with its step of 1e-12 p that loses about four
 * digits, which stalls Newton on lines whose downstream drops are a few ppm of the pressure.)
 */
export function edgeDerivs(edge, pa, pb, G) {
    if (pa < pb) { const [q, dx, dy] = edgeDerivs(edge, pb, pa, G); return [-q, -dy, -dx]; }
    if (edge.k === 'core') {
        const zfn = edge.zc ? edge.zc.Z : Z;
        const q = edgeFlow(edge, pa, pb, G), pc = coreChokeP(edge, pa, G), za = edge.Cm * zfn(pa / edge.s), zb = edge.Cm * zfn(pb / edge.s);
        if (pb >= pc) return [q, edge.kv * pa + za, -(edge.kv * pb + zb)];
        const w = edge.Aout * Math.sqrt(G.Rs * G.T);
        return [q, edge.kv * pa * w / (w + edge.kv * pc) + za, -zb];
    }
    if (pa === pb) { const g = edgeG(edge, pa, G); return [0, g, -g]; }
    const ql = orifLin(edge, pa, pb, G), qi = orifIsen(edge, pa, pb, G);
    const [da, db] = ql <= qi ? orifLinDerivs(edge, pa, pb, G) : orifIsenDerivs(edge, pa, pb, G);
    return [Math.min(ql, qi), da, db];
}

/**
 * 'none' | 'inertial' | 'choked' (orifice edges) | 'choked-exit' (core edges) at the given pressures. A core edge is
 * reported exit-choked only when the choke takes more than 1 % off its flow: the choke caps the viscous term alone, so
 * in free-molecular and near-molecular flow (no continuum exit) the downstream pressure still matters.
 */
export function edgeLimit(edge, pa, pb, G) {
    if (pa < pb) [pa, pb] = [pb, pa];
    if (edge.k === 'core') {
        const pc = coreChokeP(edge, pa, G);
        if (!(pb < pc)) return 'none';
        const lost = edge.kv * (pc - pb) * (pc + pb) / 2;
        return lost > 0.01 * (edgeFlow(edge, pa, pb, G) + lost) ? 'choked-exit' : 'none';
    }
    if (pa === pb) return 'none';
    return orifIsen(edge, pa, pb, G) < orifLin(edge, pa, pb, G) ? (pb / pa <= rStar(G.gamma) ? 'choked' : 'inertial') : 'none';
}

/** Small-signal conductance dQ/dpa (m^3/s) at pa = pb = p (spec 3.5.7). */
export function edgeG(edge, p, G) {
    if (edge.k === 'core') return edge.kv * p + edge.Cm * (edge.zc ? edge.zc.Z(p / edge.s) : Z(p / edge.s));
    return 1 / orifR(edge, p, 1, G);
}

/** Pump conductance S_c(p) (m^3/s): 1/S_c = 1/S - [attached] 4/(A_p vbar g(delta_p, 1)) (spec 3.5.4). */
export function pumpSc(pump, p, G) {
    let Rp = 1 / pump.S;
    if (pump.attached) Rp -= 4 / (pump.A * G.vbar * gOrifice(pump.re * p / (G.eta * G.vm), 1));
    return 1 / Rp;
}
