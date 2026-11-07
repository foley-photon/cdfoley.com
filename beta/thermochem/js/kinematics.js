// Kinematics on top of the ATcT energetics: photofragment recoil (two-body photodissociation, photoionization) and
// projectile–target collision energetics (centre-of-mass energy and the reaction channels it opens). Pure functions,
// no DOM; usable from Node for tests. Energies in kJ/mol unless named otherwise, masses in u (g/mol), speeds in m/s.
import { reactionEnthalpy, compKey, ELECTRON, KJ_PER } from './engine.js';

// CODATA 2022 (Mohr et al., Rev. Mod. Phys. 97, 025002 (2025)); N_A, e and c are exact.
export const N_A = 6.02214076e23;
export const AMU = 1.66053906892e-27;          // kg, ±0.00000000052e-27
export const E_CHARGE = 1.602176634e-19;       // C
export const C_LIGHT = 299792458;              // m/s
const J_PER_KJMOL = 1000 / N_A;                // one kJ/mol per particle, in J

/** Speed (m/s) of a particle of mass m (u) carrying kinetic energy kj (kJ/mol). */
export const speed = (kj, m) => (kj > 0 && m > 0 ? Math.sqrt((2 * kj * J_PER_KJMOL) / (m * AMU)) : 0);

/* ── Photofragment recoil ─────────────────────────────────────────────── */
/**
 * Two-body recoil in the centre-of-mass frame of the parent. The translational energy eT (kJ/mol) is shared so that
 * the fragments carry equal and opposite momenta: KE_A = eT·m_B/(m_A + m_B), KE_B = eT·m_A/(m_A + m_B).
 * Returns [{ m, ke, v, p }] in the order of `masses`, p in kg m/s.
 */
export function recoil(eT, masses) {
    const [mA, mB] = masses; const M = mA + mB;
    const ke = [eT * mB / M, eT * mA / M];
    return ke.map((k, i) => { const v = speed(k, masses[i]); return { m: masses[i], ke: Math.max(k, 0), v, p: masses[i] * AMU * v }; });
}

/**
 * Photodissociation energy balance: E_avail = n·hν + E_int(parent) − ΔrH°(0 K); E_T = E_avail − E_int(products).
 * `terms` is a resolved, balanced reaction with one reactant (the parent; ν = −1) and two products. Returns
 * { h, eAvail, eT, frags: [{ species, m, ke, v, p }], error } with energies in kJ/mol.
 */
export function photofragments(db, terms, { photonKJ, nPhoton = 1, eIntParent = 0, eIntProducts = 0 }) {
    const reac = terms.filter((t) => t.nu < 0); const prod = terms.filter((t) => t.nu > 0);
    if (reac.length !== 1 || Math.abs(reac[0].nu + 1) > 1e-9 || reac[0].species.isElectron) return { error: 'Give one parent molecule on the left, with coefficient 1: CH3I -> CH3 + I.' };
    const frags = prod.flatMap((t) => Array.from({ length: Math.round(t.nu) }, () => t.species));
    if (prod.some((t) => Math.abs(t.nu - Math.round(t.nu)) > 1e-9) || frags.length !== 2) {
        return { error: 'Recoil is unique only for two fragments: write the products as A + B (2 O counts as two). For three or more bodies the energy can be shared in many ways; the Reaction tab still gives the energetics.' };
    }
    const h = reactionEnthalpy(db, terms);
    if (!h || h.h0 == null) return { error: 'A species has no 0 K value (condensed or aqueous).' };
    const eAvail = nPhoton * photonKJ + eIntParent - h.h0;
    const eT = eAvail - eIntProducts;
    const kin = eT > 0 ? recoil(eT, frags.map((s) => s.mass)) : frags.map((s) => ({ m: s.mass, ke: 0, v: 0, p: 0 }));
    return { h, eAvail, eT, frags: frags.map((s, i) => ({ species: s, ...kin[i] })) };
}

/**
 * Velocity-map imaging and time-of-flight estimates for a fragment ion of charge q (elementary charges) with
 * recoil kinetic energy ke (kJ/mol) and speed v:
 *   ring radius R = N·L·√(KE / (qV)) (drift-dominated flight; independent of mass),
 *   arrival time t = L·√(m / (2qV)),
 *   turnaround spread Δt = 2·m·v / (qE) for a fragment recoiling along the TOF axis in a uniform field E.
 * L in m, V in volts (the energy per charge the ion gains), E in V/m, N the magnification (1 for an ideal lens).
 */
export function vmi({ ke, v, m, q = 1, L, V, N = 1, field = null }) {
    const keJ = ke * J_PER_KJMOL; const qq = Math.abs(q) * E_CHARGE; const mk = m * AMU;
    const R = L > 0 && V > 0 ? N * L * Math.sqrt(keJ / (qq * V)) : null;
    const t = L > 0 && V > 0 ? L * Math.sqrt(mk / (2 * qq * V)) : null;
    const dt = field > 0 ? (2 * mk * v) / (qq * field) : null;
    return { R, t, dt };
}

/** Largest Doppler shift (cm⁻¹) of a probe transition at vacuum wavelength lambdaNm for a fragment moving at v. */
export const dopplerShift = (v, lambdaNm) => (lambdaNm > 0 ? (1e7 / lambdaNm) * (v / C_LIGHT) : null);

/* ── Collisions ──────────────────────────────────────────────────────── */
const SKIP_STATE = /\b(ortho|para)\b/;
function sub(a, b) {
    const r = { ...a };
    for (const [e, n] of Object.entries(b)) { r[e] = (r[e] || 0) - n; if (r[e] < 0) return null; if (!r[e]) delete r[e]; }
    return r;
}
function add(a, b) { const r = { ...a }; for (const [e, n] of Object.entries(b)) r[e] = (r[e] || 0) + n; return r; }

/**
 * Collision of a projectile (lab kinetic energy eLab, kJ/mol) with a target at rest:
 *   E_cm = E_lab · m_t / (m_p + m_t), the energy available for reaction or excitation;
 *   head-on elastic transfer to the target T_max = 4 m_p m_t / (m_p + m_t)² · E_lab.
 */
export function collisionFrame(mp, mt, eLab) {
    const M = mp + mt;
    return {
        mu: (mp * mt) / M, eCM: (eLab * mt) / M, tMax: (4 * mp * mt / (M * M)) * eLab,
        vp: speed(eLab, mp), vcm: (mp * speed(eLab, mp)) / M,
    };
}
/** Lab-frame projectile energy that gives a centre-of-mass energy eCM (inverse of collisionFrame). */
export const labForCM = (eCM, mp, mt) => (eCM * (mp + mt)) / mt;

/**
 * Product channels of projectile P + target T: every set of one to three gas-phase ATcT species (plus electrons when
 * opts.ionize) with the combined composition and charge, each product charged −1, 0 or +1. Channels that only return the
 * reactants are left out (ATcT's second listing of a ground level counts as the plain entry). Each channel: { products,
 * terms, h0 (ΔrH° at 0 K = the centre-of-mass threshold), h298, u, ucorr, kind }. kind: 'charge transfer', 'ion pair'
 * (neutral reactants to a cation and an anion), 'transfer' (atom, ion or group transfer), 'excitation' (same fragments,
 * other state or isomer), 'association' (one product; needs a third body or radiation), 'dissociation' (three or more
 * heavy products), 'ionization' (an electron among the products). opts: { three, ionize, labeled, limit }.
 * Every product set is enumerated with its 0 K energy first; the `limit` lowest get the full treatment (uncertainties),
 * so no low-lying channel is lost. The returned array carries `total` (all channels found) and `truncated` (true only if
 * the enumeration itself hit its safety cap of MAX_ENUM sets).
 */
const MAX_ENUM = 2000000;
export function collisionChannels(db, P, T, opts = {}) {
    const { three = false, ionize = false, labeled = false, limit = 300 } = opts;
    const comp = add(P.comp, T.comp); const q = P.q + T.q;
    const alias = db.aliasOf || new Map();
    const canon = (s) => alias.get(s.id) || s;
    const pool = db.species.filter((s) => s.gas && s.h0 != null && Math.abs(s.q) <= 1 && !SKIP_STATE.test(s.state)
        && (labeled || !s.labeled) && !alias.has(s.id) && sub(comp, s.comp));
    const byKey = new Map();
    for (const s of pool) { const l = byKey.get(s.key); if (l) l.push(s); else byKey.set(s.key, [s]); }
    const reacIds = [canon(P).id, canon(T).id].sort().join('+');
    const h0r = P.h0 + T.h0;
    const cand = []; const seen = new Set(); let truncated = false;
    const addCh = (heavy, ne) => {
        if (cand.length >= MAX_ENUM) { truncated = true; return; }
        const k = heavy.map((s) => s.id).sort().join('+') + (ne ? `+${ne}e` : '');
        if ((!ne && k === reacIds) || seen.has(k)) return; seen.add(k);
        cand.push({ heavy, ne, h0: heavy.reduce((a, s) => a + s.h0, 0) - h0r });
    };
    const maxE = ionize ? 2 : 0;
    for (let ne = 0; ne <= maxE; ne++) {
        const qh = q + ne;   // charge the heavy products must carry
        for (const s of byKey.get(compKey(comp, qh)) || []) addCh([s], ne);   // one heavy product
        for (const a of pool) {
            const rest = sub(comp, a.comp); if (!rest || !Object.keys(rest).length) continue;
            const qb = qh - a.q;
            if (Math.abs(qb) <= 1) for (const b of byKey.get(compKey(rest, qb)) || []) if (b.rank >= a.rank) addCh([a, b], ne);
            if (!three) continue;
            for (const b of pool) {
                if (b.rank < a.rank) continue;
                const rest2 = sub(rest, b.comp); if (!rest2 || !Object.keys(rest2).length) continue;
                const qc = qh - a.q - b.q; if (Math.abs(qc) > 1) continue;
                for (const c of byKey.get(compKey(rest2, qc)) || []) if (c.rank >= b.rank) addCh([a, b, c], ne);
            }
        }
    }
    cand.sort((x, y) => x.h0 - y.h0);
    const out = [];
    for (const c of cand.slice(0, limit)) {
        const prods = [...c.heavy, ...Array(c.ne).fill(ELECTRON)];
        const terms = [{ nu: -1, species: P }, { nu: -1, species: T }, ...prods.map((s) => ({ nu: 1, species: s }))];
        const r = reactionEnthalpy(db, terms);
        if (r && r.h0 != null) out.push({ products: prods, terms, ...r, kind: kindOf(P, T, c.heavy, c.ne) });
    }
    out.sort((x, y) => x.h0 - y.h0);
    out.total = cand.length; out.truncated = truncated;
    return out;
}
function kindOf(P, T, heavy, ne) {
    if (ne > 0) return 'ionization';
    if (heavy.length === 1) return 'association';
    if (heavy.length >= 3) return 'dissociation';
    const ck = (s) => compKey(s.comp, 0);
    const same = (a, b) => (ck(a) === ck(P) && ck(b) === ck(T)) || (ck(a) === ck(T) && ck(b) === ck(P));
    const [a, b] = heavy;
    if (!P.q && !T.q && a.q && b.q) return 'ion pair';
    if (same(a, b)) {
        const qs = (x, y) => (ck(x) === ck(P) ? [x.q, y.q] : [y.q, x.q]);
        const [qp, qt] = qs(a, b);
        return qp !== P.q || qt !== T.q ? 'charge transfer' : 'excitation';
    }
    return 'transfer';
}

/** kJ/mol per eV, re-exported for callers that work in eV. */
export const KJ_PER_EV = KJ_PER.eV;
