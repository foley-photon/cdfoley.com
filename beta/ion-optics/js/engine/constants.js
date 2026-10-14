/* ==========================================================================
   Ion optics engine: constants.js
   Physical constants and kinematic helpers in engine units.

   Units: length mm, time µs, velocity mm/µs (= km/s), potential V, field V/mm,
   flux density T, mass u, charge e (signed), kinetic energy eV.

   Sources: CODATA 2022 recommended values (NIST, Tiesinga et al., 2024) for the
   elementary charge, atomic mass constant, electron mass, vacuum permittivity
   and permeability; c is exact (SI 2019). Every derived constant below is
   computed at load time, never typed in. Relativistic kinematics:
   gamma = 1 + KE/(m c^2), proper velocity w = gamma v (Jackson, Classical
   Electrodynamics, 3rd ed., ch. 11-12).
   ========================================================================== */

export const E_CHARGE = 1.602176634e-19;     // C (exact)
export const AMU_KG = 1.66053906892e-27;     // kg
export const ME_KG = 9.1093837139e-31;       // kg
export const C_MMUS = 299792.458;            // mm/µs (exact)
export const EPS0 = 8.8541878188e-12;        // F/m
export const MU0 = 1.25663706127e-6;         // N/A^2

/** a[mm/µs²] = K_ACC·(q/m)·(E[V/mm] + v[mm/µs] × B[T]) with q in e and m in u. */
export const K_ACC = E_CHARGE / AMU_KG * 1e-6;
/** Electron mass in u. */
export const ME_U = ME_KG / AMU_KG;
/** Rest energy of 1 u in eV (= c²/K_ACC in engine units). */
export const UC2_EV = C_MMUS * C_MMUS / K_ACC;
/** µ0/(4π) in T·mm/A. */
export const MU0_4PI_MM = MU0 / (4 * Math.PI) * 1e3;
/** Electron rest energy in eV. */
export const ME_EV = ME_U * UC2_EV;
/** Coulomb constant e²/(4π ε0 u) in mm³/µs² (a = K_COUL·q_i·q_j/(m_i r²)). */
export const K_COUL = E_CHARGE * E_CHARGE / (4 * Math.PI * EPS0 * AMU_KG) * 1e-3;

/**
 * Speed |v| (mm/µs) of a particle with kinetic energy keEV (eV) and mass massU (u).
 * Nonrelativistic: sqrt(2·K_ACC·KE/m). Relativistic: c·sqrt(ε(2+ε))/(1+ε), ε = KE/(m c²),
 * written so that small energies keep full precision.
 * @param {number} keEV @param {number} massU @param {boolean} relativistic @returns {number}
 */
export function speedFromKE(keEV, massU, relativistic) {
    if (!(keEV > 0)) return 0;
    if (!relativistic) return Math.sqrt(2 * K_ACC * keEV / massU);
    const eps = keEV / (massU * UC2_EV);
    return C_MMUS * Math.sqrt(eps * (2 + eps)) / (1 + eps);
}

/**
 * Proper speed |w| = γ|v| = c·sqrt(γ² − 1) (mm/µs), γ = 1 + KE/(m c²).
 * @param {number} keEV @param {number} massU @returns {number}
 */
export function properSpeedFromKE(keEV, massU) {
    if (!(keEV > 0)) return 0;
    const eps = keEV / (massU * UC2_EV);
    return C_MMUS * Math.sqrt(eps * (2 + eps));
}

/**
 * Kinetic energy (eV) from the proper velocity w (mm/µs).
 * Relativistic: (γ − 1)·m·UC2_EV with γ = sqrt(1 + |w|²/c²); nonrelativistic: m|w|²/(2·K_ACC).
 * @returns {number}
 */
export function keFromProper(wx, wy, wz, massU, relativistic) {
    const w2 = wx * wx + wy * wy + wz * wz;
    if (!relativistic) return massU * w2 / (2 * K_ACC);
    const u2 = w2 / (C_MMUS * C_MMUS);
    return u2 / (Math.sqrt(1 + u2) + 1) * massU * UC2_EV;   // γ − 1 without cancellation
}

/** Lorentz factor from the proper velocity: sqrt(1 + |w|²/c²). @returns {number} */
export function gammaFromProper(wx, wy, wz) {
    return Math.sqrt(1 + (wx * wx + wy * wy + wz * wz) / (C_MMUS * C_MMUS));
}

/**
 * Cyclotron radius (mm) and frequency (MHz) in a uniform field bT (T).
 * Relativistic: r = γ m |v| / (|q| B), f = |q| B / (2π γ m); nonrelativistic: γ = 1.
 * @returns {{ radiusMM: number, freqMHz: number }}
 */
export function cyclotron(massU, chargeE, bT, keEV, relativistic) {
    const wc = K_ACC * Math.abs(chargeE / massU) * Math.abs(bT);   // rad/µs at γ = 1
    if (!(wc > 0)) return { radiusMM: Infinity, freqMHz: 0 };
    if (!relativistic) {
        return { radiusMM: speedFromKE(keEV, massU, false) / wc, freqMHz: wc / (2 * Math.PI) };
    }
    const gamma = 1 + Math.max(keEV, 0) / (massU * UC2_EV);
    return { radiusMM: properSpeedFromKE(keEV, massU) / wc, freqMHz: wc / (2 * Math.PI * gamma) };
}
