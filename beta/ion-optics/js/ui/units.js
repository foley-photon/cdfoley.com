/* ==========================================================================
   Ion optics UI: units.js
   Parsing and formatting of input values with units. Engine units (spec
   §2.1.1): length mm, time µs, potential V, field V/mm, flux density T,
   mass u, charge e, energy eV, frequency MHz, angles degrees, current A;
   'field' is the electric field and 'flux' the magnetic flux density.
   A numeric input accepts a plain number (engine unit), a number with a unit
   ("2 kV", "0.5mm", "1 mT"), or an expression over parameters ("D/2+1"),
   which is returned as an expression for the schema to evaluate.
   Pure module: no DOM, usable in Node tests.
   ========================================================================== */

const PI = Math.PI;

/** Unit tables per dimension: [symbol, factor to the engine unit]. The first entry is the engine unit. */
export const DIMS = Object.freeze({
    length: { unit: 'mm', label: 'length', units: [['mm', 1], ['µm', 1e-3], ['um', 1e-3], ['nm', 1e-6], ['cm', 10], ['m', 1e3], ['in', 25.4], ['mil', 0.0254]] },
    voltage: { unit: 'V', label: 'voltage', units: [['V', 1], ['mV', 1e-3], ['µV', 1e-6], ['uV', 1e-6], ['kV', 1e3], ['MV', 1e6]] },
    energy: { unit: 'eV', label: 'energy', units: [['eV', 1], ['meV', 1e-3], ['keV', 1e3], ['MeV', 1e6], ['GeV', 1e9]] },
    mass: { unit: 'u', label: 'mass', units: [['u', 1], ['Da', 1], ['amu', 1], ['kDa', 1e3]] },
    charge: { unit: 'e', label: 'charge', units: [['e', 1]] },
    angle: { unit: '°', label: 'angle', units: [['°', 1], ['deg', 1], ['rad', 180 / PI], ['mrad', 0.18 / PI], ['µrad', 1.8e-4 / PI], ['urad', 1.8e-4 / PI]] },
    time: { unit: 'µs', label: 'time', units: [['µs', 1], ['us', 1], ['ns', 1e-3], ['ps', 1e-6], ['ms', 1e3], ['s', 1e6]] },
    freq: { unit: 'MHz', label: 'frequency', units: [['MHz', 1], ['kHz', 1e-3], ['Hz', 1e-6], ['GHz', 1e3]] },
    field: { unit: 'V/mm', label: 'electric field', units: [['V/mm', 1], ['kV/mm', 1e3], ['V/m', 1e-3], ['V/cm', 0.1], ['kV/cm', 100], ['MV/m', 1e3]] },
    flux: { unit: 'T', label: 'flux density', units: [['T', 1], ['mT', 1e-3], ['µT', 1e-6], ['uT', 1e-6], ['G', 1e-4], ['kG', 0.1], ['gauss', 1e-4]] },
    current: { unit: 'A', label: 'current', units: [['A', 1], ['mA', 1e-3], ['kA', 1e3]] },
    mobility: { unit: 'cm²/(V·s)', label: 'mobility', units: [['cm²/(V·s)', 1], ['cm2/Vs', 1], ['cm²/Vs', 1]] },
    none: { unit: '', label: 'number', units: [['', 1], ['%', 0.01]] },
});

/** Preferred display units (ascending factor) for pretty formatting. */
const PRETTY = {
    length: [['nm', 1e-6], ['µm', 1e-3], ['mm', 1], ['m', 1e3]],
    voltage: [['mV', 1e-3], ['V', 1], ['kV', 1e3], ['MV', 1e6]],
    energy: [['meV', 1e-3], ['eV', 1], ['keV', 1e3], ['MeV', 1e6]],
    time: [['ps', 1e-6], ['ns', 1e-3], ['µs', 1], ['ms', 1e3], ['s', 1e6]],
    freq: [['Hz', 1e-6], ['kHz', 1e-3], ['MHz', 1], ['GHz', 1e3]],
    flux: [['µT', 1e-6], ['mT', 1e-3], ['T', 1]],
    field: [['V/m', 1e-3], ['V/mm', 1], ['kV/mm', 1e3]],
    current: [['mA', 1e-3], ['A', 1], ['kA', 1e3]],
};

/**
 * Normalises a dimension name ('length', …); unknown → 'none'. 'field' is the electric field (V/mm) and
 * 'flux' the magnetic flux density (T), as in the engine units (spec §2.1.1); aliases are accepted.
 */
export function dimOf(dim) {
    if (!dim) return 'none';
    if (DIMS[dim]) return dim;
    const d = String(dim).toLowerCase();
    if (d === 'b' || d === 'magnetic' || d === 'bfield' || d === 'tesla' || d === 'flux density') return 'flux';
    if (d === 'e' || d === 'electric' || d === 'efield') return 'field';
    if (d === 'frequency') return 'freq';
    if (d === 'potential' || d === 'v') return 'voltage';
    if (d === 'ke' || d === 'kinetic') return 'energy';
    if (d === 'count' || d === 'int' || d === 'integer' || d === 'ratio' || d === 'fraction') return 'none';
    return DIMS[d] ? d : 'none';
}

/** Engine unit symbol of a dimension ('' for none). */
export function unitOf(dim) { return DIMS[dimOf(dim)].unit; }

/** All unit symbols accepted for a dimension. */
export function unitsOf(dim) { return DIMS[dimOf(dim)].units.map((u) => u[0]); }

/** Factor of a unit symbol for a dimension, or null if unknown. Case-sensitive first, then a unique case-insensitive match. */
export function unitFactor(dim, sym) {
    const list = DIMS[dimOf(dim)].units;
    const s = normaliseText(sym);
    for (const [u, f] of list) if (u === s) return f;
    const lower = s.toLowerCase();
    const hits = list.filter(([u]) => u.toLowerCase() === lower);
    // 'mv'/'Mv' are ambiguous between milli and mega only for case-sensitive prefixes: refuse if factors differ
    if (hits.length && hits.every((x) => x[1] === hits[0][1])) return hits[0][1];
    return null;
}

/** Text normalisation: Unicode minus, Greek mu, multiplication sign, non-breaking spaces. */
export function normaliseText(s) {
    return String(s)
        .replace(/[−‒–—]/g, '-')
        .replace(/μ/g, 'µ')
        .replace(/×/g, '*')
        .replace(/[   ]/g, ' ')
        .trim();
}

const NUM_UNIT = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(\S.*)?$/;

/**
 * Parses a user entry for a numeric field.
 * @param {string} text
 * @param {string} dim dimension name (§2.2.2)
 * @returns {{kind: 'empty'} | {kind: 'number', value: number, unit: string} | {kind: 'expr', expr: string} | {kind: 'error', message: string}}
 */
export function parseQuantity(text, dim = 'none') {
    const s = normaliseText(text == null ? '' : text);
    if (s === '') return { kind: 'empty' };
    const m = NUM_UNIT.exec(s);
    if (m) {
        const v = parseFloat(m[1]);
        if (!Number.isFinite(v)) return { kind: 'error', message: 'Not a finite number.' };
        if (m[2] === undefined) return { kind: 'number', value: v, unit: unitOf(dim) };
        const f = unitFactor(dim, m[2].trim());
        if (f !== null) return { kind: 'number', value: tidyProduct(v, f), unit: m[2].trim() };
        // something that is not a known unit: maybe an expression such as "2*D"
        if (/^[*/^+\-(]/.test(m[2].trim())) return { kind: 'expr', expr: s };
        const units = unitsOf(dim).filter(Boolean);
        return { kind: 'error', message: units.length ? `Unknown unit "${m[2].trim()}". Use ${units.slice(0, 6).join(', ')}.` : `Unexpected "${m[2].trim()}" after the number.` };
    }
    if (/^[A-Za-z_(+\-.\d]/.test(s)) return { kind: 'expr', expr: s };
    return { kind: 'error', message: 'Enter a number, a number with a unit, or an expression.' };
}

/** v·f with the product rounded to 15 significant digits when that removes binary noise (2.1 kV → 2100 exactly). */
function tidyProduct(v, f) {
    if (f === 1) return v;
    const p = v * f;
    const r = parseFloat(p.toPrecision(15));
    return Object.is(r, -0) ? 0 : r;
}

/**
 * Converts a value between two units of one dimension.
 * @returns {number} NaN for unknown units
 */
export function convert(value, fromUnit, toUnit, dim) {
    const a = unitFactor(dim, fromUnit), b = unitFactor(dim, toUnit);
    if (a === null || b === null) return NaN;
    return value * a / b;
}

/**
 * Number for an input box: the shortest text that parses back to the same double, with a Unicode minus
 * only when `display` is set. Values are tidied to 12 significant digits first.
 */
export function formatNumber(v, { digits = 12, display = false } = {}) {
    if (typeof v !== 'number') return v == null ? '' : String(v);
    if (Number.isNaN(v)) return 'NaN';
    if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
    let r = parseFloat(v.toPrecision(digits));
    if (Object.is(r, -0)) r = 0;
    let s = String(r);
    if (display) s = s.replace(/^-/, '−').replace(/e-/, 'e−').replace(/e\+/, 'e');
    return s;
}

/**
 * Value with its engine unit ("2000 V"), or in `unit` when given ("2 kV").
 * @param {number} v value in engine units
 * @param {string} dim
 * @param {{unit?: string, digits?: number, display?: boolean}} [opts]
 */
export function formatQuantity(v, dim = 'none', { unit = null, digits = 12, display = false } = {}) {
    const d = dimOf(dim);
    const u = unit === null ? DIMS[d].unit : unit;
    const f = unitFactor(d, u);
    const val = f ? v / f : v;
    const num = formatNumber(f && f !== 1 ? parseFloat(val.toPrecision(15)) : val, { digits, display });
    return u ? `${num} ${u}` : num;
}

/**
 * Human-friendly value with an automatic prefix (2000 V → "2 kV"), for read-outs.
 * @param {number} v value in engine units
 * @param {string} dim
 * @param {number} [digits] significant digits
 */
export function formatPretty(v, dim = 'none', digits = 4) {
    const d = dimOf(dim);
    if (typeof v !== 'number' || !Number.isFinite(v)) return v === null || v === undefined || Number.isNaN(v) ? '—' : String(v);
    const list = PRETTY[d];
    let sym = DIMS[d].unit, f = 1;
    if (list && v !== 0) {
        const a = Math.abs(v);
        for (const [u, g] of list) if (a >= g * 0.9999999) { sym = u; f = g; }
        if (a < list[0][1]) { sym = list[0][0]; f = list[0][1]; }
    }
    const x = v / f;
    let s;
    const ax = Math.abs(x);
    if (ax !== 0 && (ax < 1e-3 || ax >= 1e6)) {
        const [m, e] = x.toExponential(Math.max(0, digits - 1)).split('e');
        s = String(parseFloat(m)) + 'e' + e.replace('+', '');
    } else s = String(parseFloat(x.toPrecision(digits)));
    s = s.replace(/^-/, '−').replace(/e-/, 'e−');
    return sym ? `${s} ${sym}` : s;
}

/** True when the text is an expression rather than a plain or unit-suffixed number. */
export function isExpressionText(text, dim = 'none') {
    return parseQuantity(text, dim).kind === 'expr';
}
