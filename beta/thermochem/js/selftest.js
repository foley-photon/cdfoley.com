// Self-test cases. Each case recomputes a reaction energy from the loaded ATcT table and checks it twice:
//  1. "table": against the value hand-computed from ATcT TN 1.228 on 2026-11-06 (catches data, parsing and engine errors);
//  2. "reference": against a reference value, passing when |Δ| ≤ √(U_tool² + U_ref²) with both at 95 %.
// The references are NOT independent tests of ATcT. Most are measurements that ATcT itself uses as inputs (the
// ATcT 1.228 species pages list them), so agreement is expected; one is an ATcT-group analysis of such inputs;
// H2CO -> H2 + CO is compared with the previous ATcT version (a version-to-version check); IE(H) is checked to
// ATcT's printed rounding. Together they show that the tool reproduces ATcT, not that ATcT is right.
// The EXCITED cases (group 'excited') check excited-product and electron-attachment thresholds against thresholds quoted
// in the literature (rounded, and partly built on older thermochemistry; each row states its tolerance) or against sums of
// cited measurements. Plus unit, lookup, state-label, balance, covariance, diagram and version-diff checks.

import {
    parseReaction, resolveReaction, resolveToken, search, balance, reactionEnthalpy, toKJ, fromKJ, kjToNm, nmToKJ,
    excitedStates, excitedThresholds, findChannels, versionChange, stateToken, unboundAnion,
} from './engine.js';
import { buildDiagram } from './diagram.js';

const ATCT_H2O = 'https://atct.anl.gov/Thermochemical%20Data/version%201.228/species/?species_number=28';
const ATCT_CH4 = 'https://atct.anl.gov/Thermochemical%20Data/version%201.228/species/?species_number=23';
const ATCT_O = 'https://atct.anl.gov/Thermochemical%20Data/version%201.228/species/?species_number=22';

/** What each kind of reference can and cannot show. */
export const KINDS = Object.freeze({
    input: 'ATcT input: agreement expected',
    atct: 'ATcT-group analysis of TN inputs: not independent',
    version: 'Version-to-version check (TN 1.220), not independent',
    rounding: 'ATcT input: checked to the printed rounding only',
    quoted: 'Threshold quoted in the literature, checked to the tolerance given in the row; partly independent',
    composed: 'Sum of cited values; the excitation term is the NIST value the tool itself adds',
});

const HAXTON_TOL = 'Haxton et al. quote the three asymptotes (3.56, 4.35 and 8.38 eV) to 0.01 eV without listing the thermochemistry behind them; this tool differs by 0.013, 0.003 and 0.011 eV, so all three are checked at ±0.02 eV. They test the bookkeeping of the attached electron and of OH(A), which would be wrong by electronvolts, not the last digit';

export const CASES = Object.freeze([
    {
        id: 'd0-h-oh', title: 'D₀(H–OH)', rxn: 'H2O -> H + OH', q: 'h0', table: 492.214, kind: 'input',
        ref: { v: 41145.92, u: 0.12, unit: 'cm⁻¹' }, show: 'cm⁻¹',
        src: 'O. V. Boyarkin et al., Chem. Phys. Lett. 568–569, 14 (2013); TN input 164.3 on the ATcT H₂O page',
        href: 'https://doi.org/10.1016/j.cplett.2013.03.007',
    },
    {
        id: 'd0-h-ch3', title: 'D₀(H–CH₃)', rxn: 'CH4 -> CH3 + H', q: 'h0', table: 432.457, kind: 'atct',
        ref: { v: 432.463, u: 0.027, unit: 'kJ/mol' }, show: 'kJ/mol',
        src: 'Y.-C. Chang, B. Xiong, D. H. Bross, B. Ruscic and C. Y. Ng, Phys. Chem. Chem. Phys. 19, 9592–9605 (2017), a paper by the ATcT group',
        href: 'https://doi.org/10.1039/C6CP08200A',
    },
    {
        id: 'd0-h-hco', title: 'D₀(H–HCO), the H₂CO radical-channel threshold', rxn: 'CH2O -> H + HCO', q: 'h0', table: 362.804, kind: 'input',
        ref: { v: 30328.5, u: 0.5, unit: 'cm⁻¹' }, show: 'cm⁻¹', nm: 329.73,
        src: 'A. C. Terentis and S. H. Kable, Chem. Phys. Lett. 258, 626–632 (1996), ±0.5 cm⁻¹; ATcT uses it as an input with an estimated ±1.0 cm⁻¹',
        href: 'https://doi.org/10.1016/0009-2614(96)00705-1',
    },
    {
        id: 'h2co-mol', title: 'Δ<sub>r</sub>H°(0 K), H₂CO → H₂ + CO (molecular channel)', rxn: 'CH2O -> H2 + CO', q: 'h0', table: -8.417, kind: 'version',
        ref: { v: -8.417, u: 0.093, unit: 'kJ/mol' }, show: 'kJ/mol',
        src: 'ATcT TN 1.220 (API): ΔfH°₀ CO −113.799, H₂CO −105.382 kJ/mol; ±0.093 is the TN 1.220 covariance uncertainty of the difference. No single direct measurement exists',
        href: 'https://atct.anl.gov/api/v1/',
    },
    {
        id: 'd0-o2', title: 'D₀(O₂)', rxn: 'O2 -> 2 O', q: 'h0', table: 493.686, kind: 'input',
        ref: { v: 41269.2, u: 0.5, unit: 'cm⁻¹' }, show: 'cm⁻¹',
        src: 'Lewis et al. (1985), TN input 1.4 as listed on the ATcT O(g) page (Gibson 1991: 41269.6 ± 0.9; Cosby 1992: 41268.6 ± 1.1)',
        href: ATCT_O,
    },
    {
        id: 'd0-oh', title: 'D₀(O–H) of hydroxyl', rxn: 'OH -> O + H', q: 'h0', table: 425.592, kind: 'input',
        ref: { v: 35580, u: 15, unit: 'cm⁻¹' }, show: 'cm⁻¹',
        src: 'Sun et al. (2020), TN input 152.1 as listed on the ATcT H₂O(g) page',
        href: ATCT_H2O,
    },
    {
        id: 'ie-h2o', title: 'Adiabatic IE(H₂O)', rxn: 'H2O -> [H2O]+ + e-', q: 'h0', table: 1217.398, kind: 'input',
        ref: { v: 101766.3, u: 1.0, unit: 'cm⁻¹' }, show: 'cm⁻¹',
        src: 'Lauzin et al. (2015), TN input 117.1 as listed on the ATcT H₂O(g) page',
        href: ATCT_H2O,
    },
    {
        id: 'ae-ch3p', title: 'AE(CH₃⁺/CH₄), dissociative photoionization', rxn: 'CH4 -> [CH3]+ + H + e-', q: 'h0', table: 1381.930, kind: 'input',
        ref: { v: 14.32271, u: 0.00013, unit: 'eV' }, show: 'eV',
        src: 'Chang et al. (2017), TN input 2420.1 as listed on the ATcT CH₄(g) page',
        href: ATCT_CH4,
    },
    {
        id: 'ie-h', title: 'IE(H), to the printed rounding', rxn: 'H -> H+ + e-', q: 'h0', table: 1312.050, kind: 'rounding',
        ref: { v: 109678.7717, u: 0.0010, unit: 'cm⁻¹' }, show: 'cm⁻¹', tolKJ: 0.001,
        src: 'NIST Atomic Spectra Database, H I ionization energy. ATcT prints ΔfH° of H and H⁺ to 0.001 kJ/mol (0.08 cm⁻¹), so the tolerance is the full rounding of the two printed values, ±0.001 kJ/mol',
        href: 'https://physics.nist.gov/PhysRefData/ASD/ionEnergy.html',
    },
    // ── excited products and electron attachment (need data/excited-states.json for the NIST states) ──
    {
        id: 'o3-o1d-o2a', group: 'excited', title: 'O₃ → O(¹D) + O₂(a¹Δ<sub>g</sub>), the spin-allowed UV threshold', rxn: 'O3 -> O(1D) + O2(a1Δg)', q: 'h0', table: 386.666, kind: 'quoted',
        ref: { v: 310, u: 1, unit: 'nm' }, show: 'nm', tolNote: '“≈310 nm” is checked at ±1 nm (an “≈” value, not a stated rounding); the tool’s 309.38 nm is 0.62 nm from 310 nm, just outside a ±0.5 nm rounding, a gap expected from the older thermochemistry behind the quoted value',
        src: 'K. Takahashi, S. Hayashi, Y. Matsumi, N. Taniguchi and S. Hayashida, J. Geophys. Res. 107(D20), 4440 (2002): “the channel (1) threshold (≈310 nm)”. Both excited states are ATcT entries here, so this tests ATcT plus the state bookkeeping against a rounded literature value',
        href: 'https://doi.org/10.1029/2001JD002048',
    },
    {
        id: 'o2-o-o1d', group: 'excited', title: 'O₂ → O(³P₂) + O(¹D₂), the Schumann–Runge continuum limit', rxn: 'O2 -> O + O(1D)', q: 'h0', table: 683.508, kind: 'input',
        ref: { v: 57136.4, u: 0.9, unit: 'cm⁻¹' }, show: 'cm⁻¹',
        src: 'S. T. Gibson, B. R. Lewis, K. G. H. Baldwin and J. H. Carver, J. Chem. Phys. 94, 1060–1068 (1991): limiting rotationless dissociation energy 57 136.4 ± 0.9 cm⁻¹. ATcT uses this measurement (via D₀(O₂)) as an input. Convention: the same paper’s D₀(O₂) = 41 269.6 ± 0.9 cm⁻¹ (referred to the lowest level) plus O(¹D₂) 15 867.862 cm⁻¹ (NIST ASD) gives 57 137.5 cm⁻¹, so the rotationless and lowest-level limits differ by about 1 cm⁻¹, inside the tolerance',
        href: 'https://doi.org/10.1063/1.460062',
    },
    {
        id: 'h2o-oha', group: 'excited', title: 'H₂O → H + OH(A²Σ⁺), NIST excited state added to ATcT', rxn: 'H2O -> H + OH(A)', q: 'h0', table: 880.289, kind: 'composed',
        ref: { v: 73586.49, u: 0.12, unit: 'cm⁻¹' }, show: 'cm⁻¹',
        src: 'D₀(H–OH) = 41 145.92 ± 0.12 cm⁻¹ (Boyarkin et al. 2013, an ATcT input) plus T₀(OH A²Σ⁺) = 32 440.57 cm⁻¹: the A–X (0,0) band origin 32 402.39 cm⁻¹ (Huber & Herzberg, NIST WebBook), which H&H note 8 refers to the Hill–Van Vleck zero point of X²Π, plus 38.18 cm⁻¹ from that zero point down to the lowest level X²Π₃/₂ J = 3/2 (A₀ = −139.21, B₀ = 18.549 cm⁻¹, same page). The tool adds the same value, so this checks the bookkeeping, not the data',
        href: 'https://webbook.nist.gov/cgi/cbook.cgi?ID=C3352576&Mask=1000',
    },
    {
        id: 'n2o-o1d', group: 'excited', title: 'N₂O → N₂ + O(¹D)', rxn: 'N2O -> N2 + O(1D)', q: 'h0', table: 350.634, kind: 'quoted',
        ref: { v: 341, u: 0.5, unit: 'nm' }, show: 'nm',
        src: 'T. Nakayama, K. Takahashi, Y. Matsumi, N. Taniguchi and S. Hayashida, J. Geophys. Res. 108(D21), 4668 (2003): “N₂O + hν → N₂ + O(¹D), λ ≤ 341 nm … the thermochemical threshold” (citing the NASA/JPL evaluation)',
        href: 'https://doi.org/10.1029/2003JD003709',
    },
    {
        id: 'dea-h2o-o', group: 'excited', title: 'Dissociative electron attachment H₂O + e⁻ → H₂ + O⁻', rxn: 'H2O + e- -> H2 + O-', q: 'h0', table: 344.762, kind: 'quoted',
        ref: { v: 3.56, u: 0.02, unit: 'eV' }, show: 'eV', tolNote: HAXTON_TOL,
        src: 'D. J. Haxton, T. N. Rescigno and C. W. McCurdy, Phys. Rev. A 75, 012711 (2007): H₂ + O⁻ asymptote at 3.56 eV',
        href: 'https://doi.org/10.1103/PhysRevA.75.012711',
    },
    {
        id: 'dea-h2o', group: 'excited', title: 'Dissociative electron attachment H₂O + e⁻ → H⁻ + OH', rxn: 'H2O + e- -> H- + OH', q: 'h0', table: 419.444, kind: 'quoted',
        ref: { v: 4.35, u: 0.02, unit: 'eV' }, show: 'eV', tolNote: HAXTON_TOL,
        src: 'Haxton et al. (2007), the same sentence: H⁻ + OH(X²Π) asymptote at 4.35 eV',
        href: 'https://doi.org/10.1103/PhysRevA.75.012711',
    },
    {
        id: 'dea-h2o-oha', group: 'excited', title: 'Dissociative electron attachment H₂O + e⁻ → H⁻ + OH(A²Σ⁺)', rxn: 'H2O + e- -> H- + OH(A)', q: 'h0', table: 807.519, kind: 'quoted',
        ref: { v: 8.38, u: 0.02, unit: 'eV' }, show: 'eV', tolNote: HAXTON_TOL,
        src: 'Haxton et al. (2007), the same sentence: H⁻ + OH(A²Σ⁺) asymptote at 8.38 eV',
        href: 'https://doi.org/10.1103/PhysRevA.75.012711',
    },
]);

/** Run one reaction case against a database. */
export function runCase(db, c) {
    const p = parseReaction(c.rxn);
    const r = resolveReaction(db, p);
    const bal = balance(r.terms);
    const h = r.errors.length ? null : reactionEnthalpy(db, r.terms);
    const value = h ? h[c.q] : null;
    const nmRef = c.ref.unit === 'nm';
    const refKJ = nmRef ? nmToKJ(c.ref.v) : toKJ(c.ref.v, c.ref.unit);
    const refU = nmRef ? nmToKJ(c.ref.v - c.ref.u) - refKJ : toKJ(c.ref.u, c.ref.unit);
    if (c.group === 'excited' && !db.exc) {
        return { ...c, value: null, u: null, ucorr: null, balanced: bal.ok, errors: ['needs the excited-state file'], refKJ, refU, diff: NaN, tol: NaN, tableOk: false, pubOk: false, nmOk: false, pass: null };
    }
    const tableOk = value != null && Math.abs(value - c.table) <= 0.0015;
    const tol = c.tolKJ != null ? c.tolKJ : h ? Math.hypot(h.u, refU) : 0;
    const diff = value != null ? value - refKJ : NaN;
    const pubOk = value != null && Math.abs(diff) <= tol;
    const nmOk = c.nm == null || (value != null && Math.abs(kjToNm(value) - c.nm) < 0.01);
    return {
        ...c, value, u: h ? h.u : null, ucorr: h && h.ucorr ? h.ucorr.u : null, balanced: bal.ok, errors: r.errors,
        refKJ, refU, diff, tol, tableOk, pubOk, nmOk, pass: bal.ok && tableOk && pubOk && nmOk,
    };
}

/** One reaction's terms, balance and 0 K value, for the lookup checks. */
function rx(db, text) {
    const p = parseReaction(text);
    if (p.error) return { error: p.error };
    const r = resolveReaction(db, p);
    const h = r.errors.length ? null : reactionEnthalpy(db, r.terms);
    return { terms: r.terms, ok: !r.errors.length && balance(r.terms).ok, h0: h ? h.h0 : null, error: r.errors[0] };
}
const near = (x, v) => x != null && Math.abs(x - v) <= 0.0015;
/** The covariance part of a reaction's TN 1.220 uncertainty, without the rounding of the printed values. */
const cov = (h) => Math.sqrt(Math.max(h.ucorr.u220 ** 2 - (h.rvar || 0), 0));

/**
 * Unit-conversion, lookup, balance and uncertainty checks that do not depend on a single reference value.
 * `pass` is true, false, or null (not applicable to the loaded table; not counted).
 */
export function extraChecks(db) {
    const out = [];
    const add = (title, pass, detail, group = 'units') => out.push({ title, pass, detail, group });
    // units (CODATA 2022: N_A, e, h, c and k exact)
    add('1 eV = 8065.544 cm⁻¹', Math.abs(fromKJ(toKJ(1, 'eV'), 'cm⁻¹') - 8065.543937) < 1e-6, `${fromKJ(toKJ(1, 'eV'), 'cm⁻¹').toFixed(6)} cm⁻¹ (CODATA 2022, exact: 8065.543937…)`);
    add('1 kcal/mol = 4.184 kJ/mol', Math.abs(toKJ(1, 'kcal/mol') - 4.184) < 1e-12, 'thermochemical calorie, exact');
    add('193 nm photon = 619.83 kJ/mol = 6.424 eV', Math.abs(nmToKJ(193) - 619.827) < 0.005 && Math.abs(fromKJ(nmToKJ(193), 'eV') - 6.4240) < 0.0005,
        `${nmToKJ(193).toFixed(3)} kJ/mol, ${fromKJ(nmToKJ(193), 'eV').toFixed(4)} eV`);
    add('1 kJ/mol ≙ 120.272 K (E = RT)', Math.abs(fromKJ(1, 'K') - 120.2724) < 0.001, `${fromKJ(1, 'K').toFixed(4)} K`);
    // lookup: plain formulas, ion spellings, fractions (the hand values are from the TN 1.228 table)
    const o3 = rx(db, 'O3 -> O2 + O');
    const o3s = o3.terms && o3.terms[0].species;
    add('Plain formula: in “O3 -> O2 + O”, O3 is ozone (ATcT OOO) and D₀(O₂–O) = 102.434 kJ/mol',
        !!o3s && o3s.id === '10028-15-6*0' && o3.ok && near(o3.h0, 102.434), o3s ? `${o3s.formula} (${o3s.state}) ${o3s.name}; ${o3.h0} kJ/mol` : String(o3.error), 'lookup');
    const c2h4 = resolveToken(db, 'C2H4').species;
    add('Composition: “C2H4” is ethylene (ATcT CH2CH2)', !!c2h4 && c2h4.id === '74-85-1*0', c2h4 ? `${c2h4.formula} (${c2h4.state}) ${c2h4.name}` : 'not found', 'lookup');
    const ch3p = search(db, 'CH3+', 5)[0];
    add('Ion spelling: searching “CH3+” lists methylium ([CH3]+) first', !!ch3p && ch3p.id === '14531-53-4*0', ch3p ? `${ch3p.formula} (${ch3p.state}) ${ch3p.name}` : 'no hit', 'lookup');
    const ohm = search(db, 'OH-', 5)[0];
    add('Ion spelling: searching “OH-” lists gas-phase hydroxide ([OH]-) first', !!ohm && ohm.id === '14280-30-9*0', ohm ? `${ohm.formula} (${ohm.state}) ${ohm.name}` : 'no hit', 'lookup');
    const half = rx(db, '1/2 O2 -> O');
    add('Fraction: “1/2 O2 -> O” takes ν = ½ and gives D₀(O₂)/2 = 246.843 kJ/mol', !!half.ok && half.terms[0].coef === 0.5 && near(half.h0, 246.843),
        half.ok ? `ν = ${half.terms[0].coef}; ${half.h0} kJ/mol` : String(half.error), 'lookup');
    // balance
    const unb = balance(resolveReaction(db, parseReaction('H2O -> H + O')).terms);
    add('Negative control: H₂O → H + O is flagged unbalanced', !unb.ok && unb.elements.H === -1, `net H ${unb.elements.H}`, 'balance');
    const chg = balance(resolveReaction(db, parseReaction('CH4 -> CH3+ + H')).terms);
    add('Negative control: CH₄ → CH₃⁺ + H (no electron) is flagged as a charge imbalance', !chg.ok && chg.charge === 1, `net charge ${chg.charge}`, 'balance');
    const ion = balance(resolveReaction(db, parseReaction('CH4 -> CH3+ + H + e-')).terms);
    add('Ion spelling: “CH3+” resolves to ATcT [CH3]+ and balances with e⁻', ion.ok, ion.ok ? 'balanced' : 'not balanced', 'balance');
    // correlated uncertainty: CH2O -> H + HCO. Quadrature ignores the strong H2CO/HCO correlation (both are tied by the
    // measured D0); the ATcT covariance (TN 1.220 API) gives a far smaller uncertainty.
    const h = reactionEnthalpy(db, resolveReaction(db, parseReaction('CH2O -> H + HCO')).terms);
    if (h && h.ucorr && h.ucorr.covered) {
        add('Correlation matters: U(D₀(H–HCO)) with ATcT covariances < 1/5 of the independent-error estimate',
            h.ucorr.u < h.u / 5, `independent ±${h.u.toFixed(3)} kJ/mol; correlated (TN ${h.ucorr.tn} correlations, TN 1.228 U) ±${h.ucorr.u.toFixed(4)} kJ/mol`, 'balance');
        // the sparse file (pairs below 0.1 % of a pair variance cut) against the exact 10 × 10 matrix the API returned for the
        // self-test species (raw/atct_api_v1_covariance_selftest.json): √(νᵀCν) = 0.0079917 kJ/mol for H₂CO → H + HCO
        add('Sparse covariance file reproduces the exact ATcT API matrix: U(D₀(H–HCO)) with TN 1.220 covariances = 0.00799 kJ/mol (±1 %)',
            Math.abs(cov(h) - 0.0079917) <= 0.01 * 0.0079917, `sparse file ±${cov(h).toFixed(5)} kJ/mol (rounding of the printed values removed); exact API 10 × 10 matrix ±0.00799 kJ/mol`, 'balance');
        const w = reactionEnthalpy(db, resolveReaction(db, parseReaction('H2O -> H + OH')).terms);
        add('Same for D₀(H–OH): 0.001120 kJ/mol from the exact API matrix (±1 %)', !!(w && w.ucorr && w.ucorr.covered && Math.abs(cov(w) - 0.0011204) <= 0.01 * 0.0011204),
            w && w.ucorr && w.ucorr.covered ? `sparse file ±${cov(w).toFixed(6)} kJ/mol (rounding of the printed values removed)` : 'not covered', 'balance');
    } else {
        add('Correlated uncertainty (needs the covariance file)', null, 'not applicable: no ATcT covariances are loaded for this table', 'balance');
    }
    // state labels: ground-state spellings give the ground entry; every listed state's own token reads back as that state
    if (db.exc) {
        const gnd = [['Cl(2P3/2)', '22537-15-1*0'], ['F(2P3/2)', '14762-94-8*0'], ['H(2S1/2)', '12385-13-6*0'], ['Si(3P0)', '7440-21-3*0'], ['N(4S)', '17778-88-0*0'],
            ['O2(X)', '7782-44-7*0'], ['CH(X)', '3315-37-5*0'], ['OH(X)', '3352-57-6*0']];
        const bad = gnd.filter(([t, id]) => { const r = resolveToken(db, t); return !r.species || r.species.id !== id; });
        add('Ground-state labels: Cl(2P3/2), F(2P3/2), H(2S1/2), Si(3P0), N(4S), O2(X), CH(X) and OH(X) give the ground entry, not an excited level', !bad.length,
            bad.length ? `wrong: ${bad.map(([t]) => `${t} → ${(resolveToken(db, t).species || {}).name || resolveToken(db, t).error}`).join('; ')}` : `${gnd.length} labels`, 'lookup');
        const exl = [['Cl(4s 2P1/2)', 74865.667], ['Si(3P°1)', 39760.285], ['CH(C)', 31777.88], ['S2(C)', 55633.3], ['Cl(2P1/2)', 882.3515]];
        const bad2 = exl.filter(([t, cm]) => { const r = resolveToken(db, t); return !r.excited || Math.abs(r.excited.cm1 - cm) > 1e-6; });
        add('Excited-state labels: Cl(4s 2P1/2), Si(3P°1), CH(C), S2(C) and Cl(2P1/2) give the intended level (CH(C) is not read as C₂H)', !bad2.length,
            bad2.length ? `wrong: ${bad2.map(([t]) => t).join(', ')}` : `${exl.length} labels`, 'lookup');
        let n = 0; const fails = [];
        for (const l of db.exc.byGround.values()) for (const st of l) { n++; const tok = stateToken(db, st); const r = resolveToken(db, tok); if (r.error || (r.excited !== st && !(st.atct && r.species === st.atct))) fails.push(tok); }
        add('Every listed state’s reaction link reads back as that state (token round trip)', !fails.length, fails.length ? `${fails.length} of ${n} fail: ${fails.slice(0, 6).join(', ')}` : `${n} states`, 'lookup');
    } else {
        add('State labels (need the excited-state file)', null, 'not applicable: no excited-state file loaded', 'lookup');
    }
    // excited states: no double counting of states ATcT lists
    const o = (db.byFormula.get('o') || []).find((x) => x.state === 'g');
    const ex = o ? excitedStates(db, o) : [];
    if (db.exc && o) {
        const d1 = ex.filter((x) => x.state === '1D');
        const ok = d1.length === 1 && !!d1[0].atct && Math.abs((d1[0].atct.h0 - o.h0) / toKJ(1, 'cm⁻¹') - d1[0].cm1) < 0.1;
        add('O(¹D) appears once, as ATcT’s own entry; NIST ASD’s 15 867.862 cm⁻¹ agrees within 0.1 cm⁻¹', ok,
            d1.length ? `${d1.length} entry; ATcT ${(((d1[0].atct ? d1[0].atct.h0 : NaN) - o.h0) / toKJ(1, 'cm⁻¹')).toFixed(2)} cm⁻¹ vs NIST ${d1[0].cm1} cm⁻¹` : 'not found', 'excited');
        const ch = findChannels(db, (db.byFormula.get('ooo') || [])[0], 'neutral', { labeled: true, excited: true });
        add('With excited products on, ATcT’s O(¹D) and O₂(a¹Δg) entries are not listed again as separate channels', !ch.some((c) => c.products.some((s) => db.exc.atctIds.has(s.id))),
            `${ch.length} O₃ channels, none with an ATcT excited entry as a product`, 'excited');
        // one row per physical channel: ATcT's second listing of a ground level (O (g, triplet), O2 (g, triplet)) is not a new
        // channel, and identical fragments in swapped states are one threshold
        const keyOf = (c) => c.products.map((s) => (db.aliasOf && db.aliasOf.get(s.id) ? db.aliasOf.get(s.id).id : s.id)).sort().join('+');
        const keys = ch.map(keyOf);
        const o2p = findChannels(db, (db.byFormula.get('o2') || []).find((x) => x.state === 'g'), 'neutral', {}).find((c) => c.products.length === 2 && c.products.every((s) => s.formula === 'O'));
        const ex2 = o2p ? excitedThresholds(db, o2p, { fine: true }) : [];
        const exKeys = ex2.map((x) => x.states.map((st) => (st ? `${st.state}${st.J}` : 'g')).sort().join('+'));
        add('Channels are unique: O₃ lists O₂ + O once, and O₂ → O + O(¹D₂) is one excited threshold, not two', new Set(keys).size === keys.length && new Set(exKeys).size === exKeys.length && exKeys.filter((x) => x === '1D2+g').length === 1,
            `${keys.length} O₃ channels, ${new Set(keys).size} distinct; ${ex2.length} O + O excited thresholds, ${new Set(exKeys).size} distinct`, 'excited');
        const dea = findChannels(db, (db.byFormula.get('h2o') || []).find((x) => x.state === 'g'), 'dea', {});
        add('DEA mode: every H₂O + e⁻ channel has one anion and total charge −1, and H⁻ + OH is among them', dea.length > 0 && dea.every((c) => c.products.reduce((a, s) => a + s.q, 0) === -1 && c.products.filter((s) => s.q === -1).length === 1)
            && dea.some((c) => c.products.map((s) => s.formula).sort().join(' ') === 'H- OH'), `${dea.length} channels`, 'excited');
        const h2om = (db.byFormula.get('[h2o]-') || []).find((x) => x.gas);
        const ohm = (db.byFormula.get('[oh]-') || []).find((x) => x.gas);
        add('Unbound anions are recognised: [H₂O]⁻ lies above H₂O (negative EA) and is tagged; OH⁻ is bound', !!h2om && unboundAnion(db, h2om) && !!ohm && !unboundAnion(db, ohm),
            h2om ? `[H₂O]⁻ ${unboundAnion(db, h2om) ? 'unbound' : 'bound'}; OH⁻ ${ohm && unboundAnion(db, ohm) ? 'unbound' : 'bound'}` : 'no [H2O]- entry', 'excited');
    } else {
        add('Excited-state bookkeeping (needs the excited-state file)', null, 'not applicable: no excited-state file loaded', 'excited');
    }
    // energy diagram arithmetic: levels relative to the reactants, user energies converted from their unit
    const dg = buildDiagram({ unit: 'kJ/mol', levels: [{ label: 'H2CO', kj: 0, kind: 'reactant' }, { label: 'TS', kj: toKJ(79.2, 'kcal/mol'), kind: 'ts' }, { label: 'H + HCO', kj: 362.804, kind: 'product' }], photon: { kj: nmToKJ(308), label: '308 nm' }, connect: 'fan' }, { width: 600 });
    const yTS = dg.columns[1].y; const yR = dg.columns[0].y; const yP = dg.columns[2].y;
    add('Diagram: a TS entered as 79.2 kcal/mol sits at 331.373 kJ/mol and its height is proportional to energy', Math.abs(dg.columns[1].kj - 331.3728) < 0.001 && Math.abs((yR - yTS) / (yR - yP) - 331.3728 / 362.804) < 1e-9,
        `${dg.columns[1].kj.toFixed(4)} kJ/mol; height ratio ${((yR - yTS) / (yR - yP)).toFixed(6)}`, 'diagram');
    // version diff (TN 1.220 values from the ATcT API /all/ dump, 2026-11-06)
    const w2 = (db.byFormula.get('h2o') || []).find((x) => x.state === 'g');
    if (db.diff && w2) {
        const v = versionChange(db, w2);
        add('Version diff: H₂O(g) was −241.808 kJ/mol at 298.15 K in TN 1.220 (−241.798 in TN 1.228)', !!v && v.h298 === -241.808, v ? `TN 1.220: ${v.h298} kJ/mol` : 'no change found', 'diagram');
    } else {
        add('Version diff (needs the diff file)', null, 'not applicable: no TN 1.220 diff loaded for this table', 'diagram');
    }
    return out;
}
