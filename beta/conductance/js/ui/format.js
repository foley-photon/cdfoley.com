// Display units and number formatting over window.Calc (spec 2.15, H14). Code is SI everywhere else; this module
// is the only place where display units are applied. Node tests inject Calc with setCalc(obj).
//   'length'      -> Calc 'length'      mm, cm, m, in, µm
//   'speed'       -> Calc 'throughput'  L/s, m³/h, L/min, cfm, m³/s   (volumetric flow: conductance, pumping speed)
//   'pressure'    -> Calc 'pressure'    Pa, mbar, Torr, mTorr, µbar, atm
//   'pv'          -> local table        Pa·m³/s, mbar·L/s, Torr·L/s, sccm (sccm depends on the gas temperature)
//   'temperature' -> Calc 'temperature' °C, K, °F

import { store } from './store.js';

export const UNITS = Object.freeze({
    length: Object.freeze(['mm', 'cm', 'm', 'in', 'µm']),
    speed: Object.freeze(['L/s', 'm³/h', 'L/min', 'cfm', 'm³/s']),
    pressure: Object.freeze(['Pa', 'mbar', 'Torr', 'mTorr', 'µbar', 'atm']),
    pv: Object.freeze(['Pa·m³/s', 'mbar·L/s', 'Torr·L/s', 'sccm']),
    temperature: Object.freeze(['°C', 'K', '°F']),
});
const CALC_DIM = { length: 'length', speed: 'throughput', pressure: 'pressure', temperature: 'temperature' };
const TORR = 101325 / 760;
// SI factors, identical to calc.js (used only when window.Calc is missing)
const FACTORS = {
    length: { mm: 1e-3, cm: 1e-2, m: 1, in: 0.0254, 'µm': 1e-6 },
    speed: { 'L/s': 1e-3, 'm³/h': 1 / 3600, 'm³/s': 1, 'L/min': 1e-3 / 60, cfm: 4.719474432e-4 },
    pressure: { Pa: 1, mbar: 100, Torr: TORR, mTorr: TORR / 1000, 'µbar': 0.1, atm: 101325 },
    pv: { 'Pa·m³/s': 1, 'mbar·L/s': 0.1, 'Torr·L/s': TORR * 1e-3 },
};
/** sccm per (Pa·m³/s) at 273.15 K: 60·10⁶ cm³/min per m³/s over 101325 Pa (standard conditions 0 °C, 1 atm). */
export const SCCM_PER_PAM3S_0C = 60e6 / 101325;

let calcRef = null;
/** Injects a Calc implementation (Node tests); null restores window.Calc. */
export function setCalc(obj) { calcRef = obj || null; }
const C = () => calcRef || (typeof globalThis !== 'undefined' && globalThis.Calc) || null;

const DEFAULT_UNIT = { length: 'lu', speed: 'su', pressure: 'pu' };
/** The unit shown by default for a dimension (from the store for length, speed and pressure). */
export function defaultUnit(dim) {
    // throughput follows the pressure unit (v2.2): Pa -> Pa·m³/s, Torr and mTorr -> Torr·L/s, otherwise mbar·L/s
    if (dim === 'pv') { const pu = store.get().pu; return pu === 'Pa' ? 'Pa·m³/s' : pu === 'Torr' || pu === 'mTorr' ? 'Torr·L/s' : 'mbar·L/s'; }
    if (dim === 'temperature') return '°C';
    const s = store.get();
    return (DEFAULT_UNIT[dim] && s[DEFAULT_UNIT[dim]]) || UNITS[dim][0];
}

function checkUnit(dim, unit) {
    if (!UNITS[dim] || !UNITS[dim].includes(unit)) throw new RangeError(`Unknown unit ${unit} for ${dim}.`);
}

/** Display value -> SI. T (K) is used only by sccm. */
export function toSI(dim, unit, x, T = 293.15) {
    checkUnit(dim, unit);
    if (dim === 'pv') return unit === 'sccm' ? x / (SCCM_PER_PAM3S_0C * 273.15 / T) : x * FACTORS.pv[unit];
    const calc = C();
    if (calc && typeof calc.toSI === 'function') return calc.toSI(CALC_DIM[dim], unit, x);
    if (dim === 'temperature') return unit === '°C' ? x + 273.15 : unit === '°F' ? (x - 32) * 5 / 9 + 273.15 : x;
    return x * FACTORS[dim][unit];
}

/** SI -> display value. T (K) is used only by sccm. */
export function fromSI(dim, unit, x, T = 293.15) {
    checkUnit(dim, unit);
    if (dim === 'pv') return unit === 'sccm' ? x * SCCM_PER_PAM3S_0C * 273.15 / T : x / FACTORS.pv[unit];
    const calc = C();
    if (calc && typeof calc.fromSI === 'function') return calc.fromSI(CALC_DIM[dim], unit, x);
    if (dim === 'temperature') return unit === '°C' ? x - 273.15 : unit === '°F' ? (x - 273.15) * 9 / 5 + 32 : x;
    return x / FACTORS[dim][unit];
}

const SUP = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
// Calc.fmt.num rules, used when Calc is missing: plain for 1e-3 <= |x| < 1e5, else "1.234 × 10⁻⁵"; minus sign U+2212
function numFallback(x, sig) {
    if (x === null || x === undefined || Number.isNaN(x)) return '—';
    if (!Number.isFinite(x)) return x > 0 ? '∞' : '−∞';
    if (x === 0) return '0';
    const a = Math.abs(x), trim = (s) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);
    const plain = (v) => {
        const r = Number(v.toPrecision(sig)), mag = Math.floor(Math.log10(Math.abs(r)));
        return trim(r.toFixed(Math.min(Math.max(0, sig - 1 - mag), 20)));
    };
    let out;
    if (a >= 1e-3 && a < 1e5) out = plain(x);
    else {
        const [m, e] = x.toExponential(sig - 1).split('e'), ex = parseInt(e, 10);
        out = ex >= 0 && ex <= 2 ? plain(x) : trim(m) + ' × 10' + String(ex).split('').map((c) => SUP[c] || c).join('');
    }
    return out.replace(/^-/, '−');
}

/** A number with sig significant figures, by Calc.fmt.num rules ("1234", "0.01234", "1.234 × 10⁻⁵"). */
export function fmtNum(x, sig = 4) {
    const calc = C();
    if (calc && calc.fmt && typeof calc.fmt.num === 'function') return calc.fmt.num(x, sig);
    return numFallback(x, sig);
}

/** A fraction as a percentage: fmtPct(0.4615) -> "46.2 %". */
export function fmtPct(frac, sig = 3) {
    if (!Number.isFinite(frac)) return '—';
    return fmtNum(frac * 100, sig) + ' %';
}

/** A signed percentage of a relative difference: "+1.3 %", "−0.36 %". */
export function fmtSignedPct(frac, sig = 2) {
    if (!Number.isFinite(frac)) return '—';
    const s = fmtNum(Math.abs(frac) * 100, sig);
    return (frac > 0 ? '+' : frac < 0 ? '−' : '') + s + ' %';
}

/** An SI value in a display unit with its unit: fmt('speed', 0.1385) -> "138.5 L/s". opts = { unit, sig = 4, T }. */
export function fmt(dim, x, { unit, sig = 4, T } = {}) {
    const u = unit || defaultUnit(dim);
    if (!Number.isFinite(x)) return x === Infinity ? '∞' : '—';
    const temp = T ?? store.get().T ?? 293.15;
    return fmtNum(fromSI(dim, u, x, temp), sig) + ' ' + u;
}

/** Display value of an SI quantity (number) in the default or given unit. */
export function displayValue(dim, x, unit) { return fromSI(dim, unit || defaultUnit(dim), x, store.get().T ?? 293.15); }

/**
 * A value with its 95 % interval: "138.0 ± 0.3 L/s" when the interval is symmetric, else "138.0 (137.7–138.4) L/s".
 * The value is rounded to the precision of the half-width (one significant figure, two when it starts with 1).
 */
export function fmtCI(value, lo, hi, dim, { unit } = {}) {
    const u = dim ? (unit || defaultUnit(dim)) : '';
    const T = store.get().T ?? 293.15;
    const conv = (x) => (dim ? fromSI(dim, u, x, T) : x);
    const v = conv(value), a = conv(lo), b = conv(hi);
    if (![v, a, b].every(Number.isFinite)) return '—';
    const hw = Math.abs(b - a) / 2, tail = u ? ' ' + u : '';
    if (!(hw > 0)) return fmtNum(v, 4) + tail;
    const asym = Math.abs((v - a) - (b - v)) > 0.2 * hw;
    const mag = Math.floor(Math.log10(hw)), lead = Math.floor(hw / 10 ** mag);
    const dec = -mag + (lead === 1 ? 1 : 0);
    const av = Math.abs(v);
    if (dec >= 0 && dec <= 8 && av >= 1e-3 && av < 1e6) {
        const f = (x) => x.toFixed(dec).replace(/^-/, '−');
        return asym ? `${f(v)} (${f(a)}–${f(b)})${tail}` : `${f(v)} ± ${f(hw)}${tail}`;
    }
    if (dec < 0 && av >= 1 && av < 1e6) {
        const r = (x) => String(Math.round(x / 10 ** -dec) * 10 ** -dec).replace(/^-/, '−');
        return asym ? `${r(v)} (${r(a)}–${r(b)})${tail}` : `${r(v)} ± ${r(hw)}${tail}`;
    }
    const sig = Math.max(2, Math.min(7, Math.floor(Math.log10(av || 1)) - mag + 1 + (lead === 1 ? 1 : 0)));
    return asym ? `${fmtNum(v, sig)} (${fmtNum(a, sig)}–${fmtNum(b, sig)})${tail}` : `${fmtNum(v, sig)} ± ${fmtNum(hw, 2)}${tail}`;
}

/** Calc.parseNum: decimal comma, "1×10^-3", "1e-3", Unicode minus; NaN for anything else. */
export function parseInput(text) {
    const calc = C();
    if (calc && typeof calc.parseNum === 'function') return calc.parseNum(text);
    if (text === null || text === undefined) return NaN;
    let s = String(text).trim().replace(/[−‒–]/g, '-').replace(/\s+/g, '');
    if (!s) return NaN;
    if (s.includes(',')) {
        if (/^[-+]?\d{1,3}(,\d{3})+(\.\d*)?([eE][-+]?\d+)?$/.test(s)) s = s.replace(/,/g, '');
        else if (/^[-+]?\d*,\d+([eE][-+]?\d+)?$/.test(s)) s = s.replace(',', '.');
        else return NaN;
    }
    s = s.replace(/(?:[×x*])10\^?([-+]?\d+)$/i, 'e$1').replace(/E/g, 'e');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(s)) return NaN;
    return parseFloat(s);
}

/** Editable ASCII text of a display value (for input boxes): 6 significant figures, "1.2e-5" style when tiny or huge. */
export function editText(x, sig = 6) {
    if (!Number.isFinite(x)) return '';
    const calc = C();
    if (calc && calc.fmt && typeof calc.fmt.plain === 'function') return calc.fmt.plain(x, sig);
    if (x === 0) return '0';
    const a = Math.abs(x);
    if (a >= 1e-4 && a < 1e7) return String(Number(x.toPrecision(sig)));
    const [m, e] = x.toExponential(sig - 1).split('e');
    return (m.includes('.') ? m.replace(/\.?0+$/, '') : m) + 'e' + e.replace('+', '');
}
