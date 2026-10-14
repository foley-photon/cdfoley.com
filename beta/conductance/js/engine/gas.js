// Gas data and kinetic helpers (spec 2.1, 3.1). SI units. Pure module: no DOM, runs in page, worker and Node.
// lambda, Kn and delta all come from the viscosity, so they agree with Sharipov's rarefaction parameter.

const SQRT_PI = Math.sqrt(Math.PI);
const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };

export const R_GAS = 8.314462618;   // J/(mol K)
export const T_REF = 293.15;        // K: reference temperature of eta20 and of black-box datasheets
export const GAS_IDS = Object.freeze(['N2', 'air', 'He', 'H2', 'Ar', 'H2O', 'CO2']);

// M: IUPAC; eta20: CRC Handbook at 293.15 K (H2O: IAPWS 2008); omega: Bird 1994 Table A1 (H2O fitted to IAPWS
// 293-373 K); Cd: Liepmann via JPCRD 1998 Table 28 for N2, Ar and CO2, assumed by analogy elsewhere (assumedCd).
export const GASES = deepFreeze({
    N2: { name: 'Nitrogen', M: 28.0134e-3, eta20: 17.57e-6, omega: 0.74, gamma: 1.40, Cd: 0.824, assumedCd: false },
    air: { name: 'Dry air', M: 28.9647e-3, eta20: 18.13e-6, omega: 0.77, gamma: 1.40, Cd: 0.82, assumedCd: true },
    He: { name: 'Helium', M: 4.002602e-3, eta20: 19.6e-6, omega: 0.66, gamma: 5 / 3, Cd: 0.81, assumedCd: true },
    H2: { name: 'Hydrogen', M: 2.01588e-3, eta20: 8.8e-6, omega: 0.67, gamma: 1.41, Cd: 0.82, assumedCd: true },
    Ar: { name: 'Argon', M: 39.948e-3, eta20: 22.3e-6, omega: 0.81, gamma: 5 / 3, Cd: 0.812, assumedCd: false },
    H2O: { name: 'Water vapor', M: 18.01528e-3, eta20: 9.55e-6, omega: 1.06, gamma: 1.33, Cd: 0.83, assumedCd: true },
    CO2: { name: 'Carbon dioxide', M: 44.0095e-3, eta20: 14.7e-6, omega: 0.93, gamma: 1.29, Cd: 0.83, assumedCd: false },
});

const CUSTOM_LABELS = { M: 'molar mass', eta20: 'viscosity at 20 °C', omega: 'viscosity exponent ω', gamma: 'heat-capacity ratio γ', Cd: 'discharge coefficient' };

function fail(field, message) {
    const err = new RangeError(message);
    err.field = field;
    throw err;
}

/**
 * Gas state at temperature T (K). id is one of GAS_IDS or 'custom' (then custom = { M, eta20, omega, gamma, Cd } in SI).
 * Returns { id, name, M, T, Rs, eta, vbar, vm, c, gamma, Cd }. Throws RangeError (with a `field` property) for
 * T outside 20-3000 K, an unknown id, a non-finite or non-positive custom value, gamma outside (1, 1.67] or Cd outside (0, 1].
 */
export function gasState(id, T, custom = null, CdOverride = null) {
    if (!(Number.isFinite(T) && T >= 20 && T <= 3000)) fail('T', 'The temperature must be between 20 K and 3000 K.');
    let g;
    if (id === 'custom') {
        if (!custom || typeof custom !== 'object') fail('M', 'Enter the custom gas data.');
        for (const k of ['M', 'eta20', 'omega', 'gamma', 'Cd']) {
            if (!(Number.isFinite(custom[k]) && custom[k] > 0)) fail(k, `The custom gas needs a positive ${CUSTOM_LABELS[k]}.`);
        }
        g = { name: 'Custom gas', M: custom.M, eta20: custom.eta20, omega: custom.omega, gamma: custom.gamma, Cd: custom.Cd };
    } else if (Object.prototype.hasOwnProperty.call(GASES, id)) {
        g = GASES[id];
    } else {
        fail('id', `Unknown gas "${id}".`);
    }
    if (!(g.gamma > 1 && g.gamma <= 1.67)) fail('gamma', 'The heat-capacity ratio γ must be above 1 and at most 1.67.');
    const Cd = CdOverride ?? g.Cd;
    if (!(Number.isFinite(Cd) && Cd > 0 && Cd <= 1)) fail('Cd', 'The discharge coefficient must be above 0 and at most 1.');
    const Rs = R_GAS / g.M, eta = g.eta20 * Math.pow(T / T_REF, g.omega);
    return {
        id, name: g.name, M: g.M, T, Rs, eta,
        vbar: Math.sqrt(8 * Rs * T / Math.PI), vm: Math.sqrt(2 * Rs * T), c: Math.sqrt(g.gamma * Rs * T),
        gamma: g.gamma, Cd,
    };
}

/** Mean free path (m) at pressure p (Pa): (sqrt(pi)/2) eta vm / p. */
export function meanFreePath(G, p) { return (SQRT_PI / 2) * G.eta * G.vm / p; }

/** Rarefaction parameter delta = r p / (eta vm) for the length r (m). */
export function rarefaction(G, r, p) { return r * p / (G.eta * G.vm); }

/** Molecular conductance (m^3/s) of a thin orifice of area A (m^2): A vbar / 4. */
export function orificeC(G, A) { return A * G.vbar / 4; }

/** 'temperature-range' outside 200-600 K (the viscosity fits are extrapolated there), else null. */
export function temperatureWarning(T) { return T < 200 || T > 600 ? 'temperature-range' : null; }

/** Saturation pressure of water (Pa), Magnus formula (Alduchov & Eskridge 1996); about 1 % up to 60 °C. */
export function waterSaturation(T) {
    const t = T - 273.15;
    return 610.94 * Math.exp(17.625 * t / (t + 243.04));
}
