/* ==========================================================================
   Ion optics engine: gas.js
   Hard-sphere collisions of ions with a background gas (a plug-in of the
   tracer, trace.js, and of the lockstep space-charge tracer, coulomb.js),
   and mobility helpers for the Stokes-drag plug-in.

   Model. The gas is a Maxwell–Boltzmann gas of number density n = p/(k_B T),
   molecular mass m_g and bulk velocity v_g. An ion of mass M, velocity v and
   collision diameter d_i meets gas molecules of diameter d_g as rigid spheres
   with the cross-section σ = π d², d = (d_i + d_g)/2. Its collision rate is
   ν(v) = n σ ⟨g⟩, where ⟨g⟩ is the mean relative speed against the gas: for
   a test particle of speed u = |v − v_g| in a Maxwellian gas with the most
   probable speed c = √(2 k_B T / m_g) and s = u/c,
       ⟨g⟩ = c [(s + 1/(2s)) erf(s) + e^(−s²)/√π]
   (the Maxwell integral; Chapman & Cowling, The Mathematical Theory of
   Non-uniform Gases, 3rd ed. (1970), ch. 5; limits √(8 k_B T/(π m_g)) for
   s → 0 and u for s → ∞). The collision partner is drawn from the Maxwellian
   weighted by the relative speed (the flux-weighted partner distribution) and
   the scattering is isotropic in the center-of-mass frame, which is exact for
   rigid spheres; energy and momentum are conserved exactly in every collision
   (Bird, Molecular Gas Dynamics and the Direct Simulation of Gas Flows (1994),
   §2.4 and §11.1). Free paths are exponential: the tracers keep a per-particle
   collision budget E = −ln(1 − u) and collide when ∫ν dt reaches it, so the
   collision count is exact whatever the step size; steps are capped at a
   tenth of the mean free time 1/ν so that the collision time is resolved.

   Random numbers are counter-based (rng.js): one stream per particle id, so
   results never depend on batching or the number of workers.

   Mobility. The low-field (Chapman–Enskog, first approximation) mobility of
   rigid spheres K = (3e/(16 n)) √(2π/(μ k_B T)) / (π d²), the reduced
   mobility K₀ = K (p/760 Torr)(273.15 K/T) and the relaxation time
   τ = K M/e of the Stokes drag (Mason & McDaniel, Transport Properties of
   Ions in Gases (1988), ch. 1 and 5). The first approximation is exact for
   ions much heavier than the gas; for ions much lighter than the gas the
   hard-sphere collisions of the model give up to 32/(9π) ≈ 1.13 times more
   (the Lorentz limit), so the readout is a lower bound there.

   Units: Pa, K, u, Å on the way in (the schema's tracer.gas), engine units
   (mm, µs, mm/µs) inside and out. k_B is exact (SI 2019).
   ========================================================================== */
import { AMU_KG, E_CHARGE, K_ACC, C_MMUS } from './constants.js';
import { Stream } from './rng.js';

/** Boltzmann constant, J/K (exact). */
export const K_B = 1.380649e-23;
/** One torr in pascal (101325/760, exact). */
export const TORR_PA = 101325 / 760;
/** RNG stream id of the gas collisions (a = GAS_A, b = particle id, lanes ≥ 1). */
export const GAS_A = 0x3c6ef372;

const SQRT_PI = Math.sqrt(Math.PI);
const TWO_OVER_SQRT_PI = 2 / SQRT_PI;
const INV_C2 = 1 / (C_MMUS * C_MMUS);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Error function, Abramowitz & Stegun, Handbook of Mathematical Functions, eq. 7.1.26 (|error| ≤ 1.5e-7).
 * @param {number} x @returns {number}
 */
export function erf(x) {
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const y = 1 - poly * Math.exp(-ax * ax);
    return x < 0 ? -y : y;
}

/**
 * Mean relative speed ⟨|v − c|⟩ of a particle moving at `speed` through a Maxwellian gas with most probable speed cmp
 * (same units as the arguments): cmp [(s + 1/(2s)) erf(s) + e^(−s²)/√π], s = speed/cmp.
 * @param {number} speed @param {number} cmp @returns {number}
 */
export function meanRelativeSpeed(speed, cmp) {
    if (!(cmp > 0)) return Math.abs(speed);
    const s = Math.abs(speed) / cmp;
    if (s < 1e-3) return cmp * TWO_OVER_SQRT_PI * (1 + s * s / 3);
    return cmp * ((s + 0.5 / s) * erf(s) + Math.exp(-s * s) / SQRT_PI);
}

/**
 * Collision diameter (Å) estimated from the mass: a sphere of mass density ρ (default 1 g/cm³, the density of water
 * and of most organic molecules), d = (6 M/(π ρ))^(1/3). The uncertainty of this estimate is the dominant one of the
 * model (cross-sections are known to 30 % at best); enter a measured kinetic diameter when one is known.
 * @param {number} massU @param {number} [densityGcm3=1] @returns {number} Å
 */
export function ionDiameterEstimate(massU, densityGcm3 = 1) {
    if (!(massU > 0) || !(densityGcm3 > 0)) return 0;
    const grams = massU * AMU_KG * 1e3;
    return Math.cbrt(6 * grams / (Math.PI * densityGcm3)) * 1e8;
}

/** Number density (mm⁻³) of an ideal gas at pressure p (Pa) and temperature T (K). */
export function numberDensity(pressurePa, temperatureK) {
    return pressurePa > 0 && temperatureK > 0 ? pressurePa / (K_B * temperatureK) * 1e-9 : 0;
}

/** Most probable speed √(2 k_B T/m) of a Maxwellian gas (mm/µs); mass in u. */
export function mostProbableSpeed(temperatureK, massU) {
    return Math.sqrt(2 * K_B * temperatureK / (massU * AMU_KG)) * 1e-3;
}

/**
 * Mobility K (cm²/(V·s)) at pressure p (Torr) and temperature T (K) from the reduced mobility K₀ (cm²/(V·s)):
 * K = K₀ (760/p)(T/273.15).
 */
export function mobilityFromReduced(k0, pressureTorr, temperatureK) {
    if (!(k0 > 0) || !(pressureTorr > 0) || !(temperatureK > 0)) return NaN;
    return k0 * (760 / pressureTorr) * (temperatureK / 273.15);
}

/** Reduced mobility K₀ (cm²/(V·s)) from the mobility K at p (Torr) and T (K): K₀ = K (p/760)(273.15/T). */
export function reducedMobility(k, pressureTorr, temperatureK) {
    if (!(k > 0) || !(pressureTorr > 0) || !(temperatureK > 0)) return NaN;
    return k * (pressureTorr / 760) * (273.15 / temperatureK);
}

/**
 * Relaxation time τ = K_mob M/(K_ACC |q|) (µs) of the Stokes drag a = −(v − v_gas)/τ with K in cm²/(V·s)
 * (K_mob = 1e-4 K in mm²/(V·µs)), M in u, q in e (spec §3.12).
 */
export function dragTimeConstant(mobilityCm2Vs, massU, chargeE) {
    if (!(mobilityCm2Vs > 0) || !(massU > 0) || !(Math.abs(chargeE) > 0)) return Infinity;
    return 1e-4 * mobilityCm2Vs * massU / (K_ACC * Math.abs(chargeE));
}

/**
 * Low-field mobility (cm²/(V·s)) of a rigid-sphere ion in a rigid-sphere gas (Chapman–Enskog first approximation):
 * K = (3e/(16 n)) √(2π/(μ k_B T)) / (π d²), with the reduced mass μ and the collision diameter d = (d_i + d_g)/2.
 * @param {number} ionMassU @param {{ pressure: number, temperature: number, mass: number, diameter: number, ionDiameter?: number|null }} gas
 *   pressure Pa, temperature K, mass u, diameters Å (ionDiameter null: estimated from the ion mass)
 * @param {number} [chargeE=1] |q| in e
 * @returns {number} cm²/(V·s), NaN without a gas
 */
export function hardSphereMobility(ionMassU, gas, chargeE = 1) {
    if (!gas || !(gas.pressure > 0) || !(gas.temperature > 0) || !(gas.mass > 0) || !(ionMassU > 0)) return NaN;
    const di = gas.ionDiameter > 0 ? gas.ionDiameter : ionDiameterEstimate(ionMassU);
    const d = 0.5 * (di + gas.diameter) * 1e-10;
    const n = gas.pressure / (K_B * gas.temperature);
    const mu = ionMassU * gas.mass / (ionMassU + gas.mass) * AMU_KG;
    const k = 3 * Math.abs(chargeE) * E_CHARGE / (16 * n) * Math.sqrt(2 * Math.PI / (mu * K_B * gas.temperature)) / (Math.PI * d * d);
    return k * 1e4;
}

/**
 * Compiles a resolved `tracer.gas` object into the collision model used by the tracers.
 * @param {{ pressure: number, temperature: number, mass: number, diameter: number, ionDiameter?: number|null, velocity?: number[] }} gas
 * @returns {object} model: { n (mm⁻³), cmp (mm/µs), meanSpeed (mm/µs), kT (eV), vg [3], species(massU), rate(sp, vx, vy, vz),
 *   budget(stream), collide(sp, stream, W, o, relativistic), meanFreePath(sp, speed), summary(massU) }
 */
export function createGasModel(gas) {
    const p = num(gas && gas.pressure, 0), T = num(gas && gas.temperature, 293.15), mg = num(gas && gas.mass, 4);
    const dg = num(gas && gas.diameter, 0);
    const diFixed = gas && gas.ionDiameter > 0 ? gas.ionDiameter : null;
    const vg = Array.isArray(gas && gas.velocity) ? [num(gas.velocity[0], 0), num(gas.velocity[1], 0), num(gas.velocity[2], 0)] : [0, 0, 0];
    const n = numberDensity(p, T);
    const cmp = mostProbableSpeed(T, mg);
    const sigmaC = cmp / Math.SQRT2;               // per-component standard deviation of the gas velocity
    const kT = K_B * T / E_CHARGE;                 // eV
    const cache = new Map();

    /** Per-species constants (cached by mass): { massU, ionDiameter, d, sigma, nSigma, mg, aG, aI }. */
    function species(massU) {
        const key = +massU;
        let s = cache.get(key);
        if (s) return s;
        const di = diFixed !== null ? diFixed : ionDiameterEstimate(key);
        const d = 0.5 * (di + dg);                         // Å
        const sigma = Math.PI * d * d * 1e-14;             // mm²
        s = { massU: key, ionDiameter: di, d, sigma, nSigma: n * sigma, mg, aG: mg / (key + mg), aI: key / (key + mg) };
        cache.set(key, s);
        return s;
    }
    /** Collision rate ν (1/µs) of a species at velocity (vx, vy, vz) mm/µs. */
    function rate(sp, vx, vy, vz) {
        if (!(sp.nSigma > 0)) return 0;
        const ux = vx - vg[0], uy = vy - vg[1], uz = vz - vg[2];
        return sp.nSigma * meanRelativeSpeed(Math.sqrt(ux * ux + uy * uy + uz * uz), cmp);
    }
    /** Mean free path (mm) of a species moving at `speed` relative to the gas: speed/ν. */
    function meanFreePath(sp, speed) {
        const nu = sp.nSigma * meanRelativeSpeed(speed, cmp);
        return nu > 0 ? speed / nu : Infinity;
    }
    /** A fresh exponential collision budget −ln(1 − u). */
    function budget(stream) { return -Math.log(1 - stream.next()); }
    /**
     * One elastic rigid-sphere collision. W holds the proper velocity of the ion at W[o..o+2] (= the velocity when
     * not relativistic); it is replaced by the post-collision value. The partner is drawn from the Maxwellian weighted
     * by the relative speed (rejection against |u| + 4 cmp), the center-of-mass scattering direction is isotropic.
     */
    function collide(sp, stream, W, o, relativistic) {
        let wx = W[o], wy = W[o + 1], wz = W[o + 2];
        let ig = 1;
        if (relativistic) ig = 1 / Math.sqrt(1 + (wx * wx + wy * wy + wz * wz) * INV_C2);
        const vx = wx * ig, vy = wy * ig, vz = wz * ig;
        const ux = vx - vg[0], uy = vy - vg[1], uz = vz - vg[2];
        const gMax = Math.sqrt(ux * ux + uy * uy + uz * uz) + 4 * cmp;
        let cx = 0, cy = 0, cz = 0, gx = 0, gy = 0, gz = 0, g = 0;
        for (let it = 0; it < 64; it++) {
            cx = sigmaC * stream.normal(); cy = sigmaC * stream.normal(); cz = sigmaC * stream.normal();
            gx = ux - cx; gy = uy - cy; gz = uz - cz;
            g = Math.sqrt(gx * gx + gy * gy + gz * gz);
            if (stream.next() * gMax <= g) break;
        }
        // isotropic direction of the new relative velocity (center-of-mass frame)
        const cosT = 2 * stream.next() - 1, sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT)), phi = 2 * Math.PI * stream.next();
        const nx = sinT * Math.cos(phi), ny = sinT * Math.sin(phi), nz = cosT;
        // lab-frame gas velocity of the partner and the center-of-mass velocity
        const px = cx + vg[0], py = cy + vg[1], pz = cz + vg[2];
        const cmx = sp.aI * vx + sp.aG * px, cmy = sp.aI * vy + sp.aG * py, cmz = sp.aI * vz + sp.aG * pz;
        const nvx = cmx + sp.aG * g * nx, nvy = cmy + sp.aG * g * ny, nvz = cmz + sp.aG * g * nz;
        let gam = 1;
        if (relativistic) {
            const b2 = Math.min((nvx * nvx + nvy * nvy + nvz * nvz) * INV_C2, 1 - 1e-16);
            gam = 1 / Math.sqrt(1 - b2);
        }
        W[o] = nvx * gam; W[o + 1] = nvy * gam; W[o + 2] = nvz * gam;
        return g;
    }
    /** Numbers for the interface: densities, speeds, the fast-ion and thermal mean free paths, the low-field mobility. */
    function summary(massU, chargeE = 1) {
        const sp = species(massU > 0 ? massU : 1);
        const meanSpeed = cmp * TWO_OVER_SQRT_PI;
        const lambdaFast = sp.nSigma > 0 ? 1 / sp.nSigma : Infinity;        // ion much faster than the gas
        const nuThermal = sp.nSigma * meanRelativeSpeed(0, cmp);           // ion at rest in the gas
        return {
            n, cmp, meanSpeed, kT, thermalEnergy: 1.5 * kT, ionDiameter: sp.ionDiameter, d: sp.d, sigma: sp.sigma,
            lambdaFast, nuThermal, tauThermal: nuThermal > 0 ? 1 / nuThermal : Infinity,
            mobility: hardSphereMobility(massU, { pressure: p, temperature: T, mass: mg, diameter: dg, ionDiameter: diFixed }, chargeE),
        };
    }
    return { n, cmp, meanSpeed: cmp * TWO_OVER_SQRT_PI, kT, vg, pressure: p, temperature: T, gasMass: mg, species, rate, meanFreePath, budget, collide, summary };
}

/**
 * The per-particle random stream of the gas model (seed, GAS_A, particle id, lane 1).
 * @param {number} seed @param {number} particleId @returns {Stream}
 */
export function gasStream(seed, particleId) { return new Stream(seed, GAS_A, particleId, 1); }
