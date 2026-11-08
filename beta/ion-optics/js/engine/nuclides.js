/* ==========================================================================
   Ion optics engine: nuclides.js
   Isotope masses and labels, and the preset species groups of the particle
   picker. The masses come from the AME2020 atomic mass table (data/nuclides.js,
   generated from the IAEA Atomic Mass Data Center file mass_1.mas20.txt):

     Huang, Wang, Kondev, Audi and Naimi, "The AME 2020 atomic mass evaluation
     (I)", Chin. Phys. C 45, 030002 (2021), doi:10.1088/1674-1137/abddb0;
     Wang, Huang, Kondev, Audi and Naimi, "The AME 2020 atomic mass evaluation
     (II)", Chin. Phys. C 45, 030003 (2021), doi:10.1088/1674-1137/abddaf.

   Mass convention: an ion of charge state q (in e, signed) has
     m(Z, A, q) = M_atom(Z, A) − q·m_e,
   so a negative ion gains an electron mass. The binding energy of the removed
   electrons is neglected: summing the NIST ASD ionization energies of uranium,
   the first 30 electrons cost ~11 keV (5e-8 of the ion mass), the first 40
   ~25 keV (1e-7) and all 92 (the bare nucleus) 0.76 MeV (3.4e-6). That is
   larger than the AME2020 uncertainty of well-measured nuclides (1.6 µu, or
   1.5 keV, for 238U) but far below anything the tracer resolves.

   This module imports SPECIES from particles.js (the preset groups reuse its
   entries); particles.js itself stays free of the nuclide table, so the
   workers do not load it.
   ========================================================================== */
import { ME_U } from './constants.js';
import { SPECIES } from './particles.js';
import { SYMBOLS, DEFAULT_A, TABLE } from './data/nuclides.js';

const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
const SUB = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' };

/** Digits of a non-negative integer as superscripts ("238" → "²³⁸"). */
export function sup(n) { return String(Math.abs(Math.trunc(n))).replace(/\d/g, (d) => SUP[d]); }
/** Digits of a non-negative integer as subscripts ("60" → "₆₀"). */
export function sub(n) { return String(Math.abs(Math.trunc(n))).replace(/\d/g, (d) => SUB[d]); }
/** Charge suffix: "⁺", "²⁺", "⁻", "³⁻"; "" for q = 0. */
export function chargeSup(q) {
    const n = Math.abs(Math.trunc(q));
    if (n === 0) return '';
    return (n === 1 ? '' : sup(n)) + (q > 0 ? '⁺' : '⁻');
}

/** Element symbols by Z; index 0 is the neutron. */
export const ELEMENTS = Object.freeze(SYMBOLS.slice());
/** Highest Z in the table (118). */
export const Z_MAX = SYMBOLS.length - 1;

const Z_OF = new Map(SYMBOLS.map((s, z) => [s.toLowerCase(), z]));
/** Z of an element symbol (case-insensitive), or −1 ("n" is the neutron, Z = 0). */
export function elementZ(symbol) {
    const z = Z_OF.get(String(symbol || '').trim().toLowerCase());
    return z === undefined ? -1 : z;
}

// decoded lazily per element: Map<A, { delta: number (micro-u relative to A), estimated: boolean }>
const DECODED = new Array(SYMBOLS.length).fill(null);
function decode(z) {
    if (DECODED[z]) return DECODED[z];
    const m = new Map();
    let a = -1;
    for (const tok of TABLE[z].split(',')) {
        let d = tok;
        const eq = tok.indexOf('=');
        if (eq >= 0) { a = parseInt(tok.slice(0, eq), 10); d = tok.slice(eq + 1); } else a += 1;
        const estimated = d.endsWith('#');
        if (estimated) d = d.slice(0, -1);
        m.set(a, { delta: d, estimated });
    }
    DECODED[z] = m;
    return m;
}

/** Mass numbers of element Z known to AME2020, ascending ([] for an unknown Z). */
export function isotopesOf(z) {
    if (!Number.isInteger(z) || z < 0 || z > Z_MAX) return [];
    return Array.from(decode(z).keys());
}

/** Default mass number of element Z: the most abundant isotope, else the longest-lived one (NUBASE2020). */
export function defaultA(z) {
    return Number.isInteger(z) && z >= 1 && z <= Z_MAX ? DEFAULT_A[z] : 0;
}

/**
 * The nuclide (Z, A), or null when AME2020 has no entry:
 * { Z, A, N, symbol, atomicMass (u), estimated } with estimated = true for a value from systematics ('#' in AME2020).
 */
export function nuclide(z, a) {
    if (!Number.isInteger(z) || z < 0 || z > Z_MAX || !Number.isInteger(a)) return null;
    const e = decode(z).get(a);
    if (!e) return null;
    // A + d·1e-6 with d parsed as a decimal string, so 12C is exactly 12 and the AME digits survive
    const atomicMass = a + parseFloat(e.delta + 'e-6');
    return { Z: z, A: a, N: a - z, symbol: SYMBOLS[z], atomicMass, estimated: e.estimated };
}

/**
 * Mass (u) of the ion (Z, A) in charge state q (e, signed): atomic mass − q·m_e, ionization energy neglected
 * (see the header). NaN when the nuclide is not in the table.
 * @returns {number}
 */
export function nuclideMass(z, a, q = 1) {
    const n = nuclide(z, a);
    if (!n) return NaN;
    return n.atomicMass - (Number.isFinite(q) ? q : 0) * ME_U;
}

/** Label such as "²³⁸U³⁵⁺", "¹H⁻", "⁴He²⁺" (no charge suffix for q = 0). */
export function nuclideLabel(z, a, q = 1) {
    const sym = SYMBOLS[z] || '?';
    return `${sup(a)}${sym}${chargeSup(q)}`;
}

/**
 * Total kinetic energy (eV) of an ion of mass number A at an energy per nucleon in keV/u: E = (keV/u) × 1000 × A.
 * Accelerator usage treats "per u" and "per nucleon" as the same quantity and multiplies by the integer mass number,
 * not by the ion mass in u (the two differ by 0.7 % for a proton and by 1.3e-4 for ²³⁸U³⁵⁺).
 */
export function totalEnergyFromPerNucleon(keVPerU, a) { return keVPerU * 1e3 * a; }
/** Energy per nucleon (keV/u) from the total kinetic energy (eV) and the mass number A. */
export function perNucleonFromTotal(eV, a) { return a > 0 ? eV / (1e3 * a) : NaN; }

// ---------------------------------------------------------------- preset groups

const byId = (id) => SPECIES.find((s) => s.id === id);
/** Preset from an existing SPECIES entry (same id, mass and label, so saved projects and the benchmarks are unaffected). */
const fromSpecies = (id, note = '') => { const s = byId(id); return { id: s.id, label: s.label, mass: s.mass, charge: s.charge, isotope: s.isotope, note }; };
/** Preset of a single nuclide in charge state q. */
function ion(z, a, q, note = '', labelOverride = null) {
    const n = nuclide(z, a);
    if (!n) throw new Error(`no AME2020 entry for Z=${z}, A=${a}`);
    return { id: `${n.symbol}${a}:${q}`, label: labelOverride || nuclideLabel(z, a, q), mass: n.atomicMass - q * ME_U, charge: q, isotope: `${sup(a)}${n.symbol}`, note };
}
/** Preset of a molecular ion: atoms [[Z, A, count], ...], charge q, label given. */
function molecule(id, label, atoms, q, note = '') {
    let m = 0;
    const parts = [];
    for (const [z, a, k] of atoms) {
        const n = nuclide(z, a);
        if (!n) throw new Error(`no AME2020 entry for Z=${z}, A=${a}`);
        m += k * n.atomicMass;
        parts.push(`${sup(a)}${n.symbol}${k > 1 ? sub(k) : ''}`);
    }
    return { id, label, mass: m - q * ME_U, charge: q, isotope: parts.join(''), note };
}

const H = 1, HE = 2, C = 6, N = 7, O = 8, NE = 10, AR = 18, CA = 20, GA = 31, KR = 36, XE = 54, CS = 55, PB = 82, U = 92;

/**
 * Preset groups of the species picker: [{ id, title, entries: [{ id, label, mass (u), charge (e), isotope, note }] }].
 * Entries that exist in SPECIES keep their ids and masses. The accelerator group lists only charge states reported
 * in the cited ion-source and linac papers (help page, "Nuclear masses and ion-source charge states").
 */
export const PRESET_GROUPS = Object.freeze([
    { id: 'light', title: 'Electrons & light ions', entries: [
        fromSpecies('e-'),
        fromSpecies('H+', 'proton (CODATA 2022 mass)'),
        ion(H, 1, -1, 'hydrogen anion: H atom plus one electron'),
        ion(H, 2, 1, 'deuteron'),
        ion(HE, 3, 1),
        ion(HE, 4, 2, 'alpha particle', '⁴He²⁺ (α)'),
    ] },
    { id: 'gas', title: 'Noble gas, sputter & FIB ions', entries: [
        ion(NE, 20, 1),
        fromSpecies('Ar+'),
        ion(AR, 40, 2),
        fromSpecies('Kr+'),
        fromSpecies('Xe+'),
        ion(CS, 133, 1, 'caesium sputter and LMIS beams'),
        ion(GA, 69, 1, 'liquid-metal ion source (FIB)'),
        ion(O, 16, -1, 'oxygen anion: O atom plus one electron'),
    ] },
    { id: 'accel', title: 'Accelerator heavy-ion beams', entries: [
        // notes name the source paper, not the laboratory (the help page's reference list carries the full citations)
        ion(U, 238, 33, 'heavy-ion linac design: U³³⁺ and U³⁴⁺ are to be accelerated together before the stripper (Ostroumov et al., HB2021); ~230 eµA from a 28 GHz superconducting ECR source (Higurashi et al. 2014)'),
        ion(U, 238, 34, 'heavy-ion linac design: to be accelerated together with U³³⁺ before the stripper (Ostroumov et al., HB2021)'),
        ion(U, 238, 35, '28 GHz superconducting ECR source: ~180 eµA (Higurashi et al. 2014); 18 and 28 GHz U³⁵⁺ beam studies (Higurashi et al. 2012)'),
        ion(U, 238, 36, 'heavy-ion linac commissioning beam through a liquid-lithium charge stripper (Ostroumov et al., HB2021)'),
        ion(U, 238, 4, 'vacuum-arc ion source beam before an H₂ gas stripper (Barth et al. 2015)'),
        ion(U, 238, 28, '7.8 emA at 1.4 MeV/u after the H₂ gas stripper (Barth et al. 2015)'),
        ion(CA, 48, 11, 'superconducting ECR source feeding a cyclotron: 75 eµA sustained, 219 eµA record (Benitez et al. 2014)'),
        ion(AR, 36, 10, 'heavy-ion linac commissioning beam through a liquid-lithium charge stripper (Ostroumov et al., HB2021)'),
        ion(KR, 86, 17, 'heavy-ion linac commissioning: 17 MeV/u ⁸⁶Kr¹⁷⁺ before the stripper (Ostroumov et al., HB2021)'),
        ion(XE, 124, 26, 'heavy-ion linac commissioning beam through a liquid-lithium charge stripper (Ostroumov et al., HB2021)'),
        ion(AR, 40, 11, '14.5 GHz room-temperature ECR source: argon operation (Toivanen et al., ECRIS 2014)'),
        ion(PB, 208, 27, '14.5 GHz ECR source: the lead charge state used until 2007 (Toivanen et al., ECRIS 2014)'),
        ion(PB, 208, 29, '14.5 GHz ECR source: the lead charge state of choice since 2007, ~200 eµA (Toivanen et al., ECRIS 2014 and 2016)'),
        ion(PB, 208, 54, 'after the stripper foil of the lead linac (Toivanen et al., ECRIS 2014 and 2016)'),
    ] },
    { id: 'molecular', title: 'Molecular ions', entries: [
        molecule('H2+', 'H₂⁺', [[H, 1, 2]], 1),
        molecule('H3+', 'H₃⁺', [[H, 1, 3]], 1),
        fromSpecies('N2+'),
        fromSpecies('O2+'),
        molecule('CO2+', 'CO₂⁺', [[C, 12, 1], [O, 16, 2]], 1),
        fromSpecies('C60+'),
    ] },
].map((g) => Object.freeze({ ...g, entries: Object.freeze(g.entries.map((e) => Object.freeze(e))) })));

/** Preset entry by id across all groups, or null. */
export function presetById(id) {
    for (const g of PRESET_GROUPS) for (const e of g.entries) if (e.id === id) return e;
    return null;
}
