// Absorption cross-section engine: interpolation, laser-line averages, unit conversions, Beer–Lambert absorption,
// photolysis per pulse, temperature interpolation and resampling. Pure functions, no DOM; usable from Node for tests.
// Spectra are arrays of [λ (nm), σ (cm² molecule⁻¹)] sorted by wavelength.

// CODATA 2022 (Mohr et al., Rev. Mod. Phys. 97, 025002 (2025)); N_A, h, c and k are exact.
export const N_A = 6.02214076e23;            // mol⁻¹
export const H = 6.62607015e-34;             // J s
export const C = 299792458;                  // m s⁻¹
export const K_B = 1.380649e-23;             // J K⁻¹
export const ATM = 101325;                   // Pa
export const LOSCHMIDT = ATM / (K_B * 273.15) * 1e-6;   // cm⁻³ at 273.15 K and 1 atm: 2.686780111e19
export const LN10 = Math.LN10;
export const A0_2 = 5.29177210544e-9 ** 2;   // Bohr radius squared, cm² (CODATA 2022)
/** σ per unit oscillator-strength density: 2π² r_e ħc = 1.0976 × 10⁻¹⁶ cm² eV (σ in Mb ≈ 109.76 df/dE in eV⁻¹). */
export const SIGMA_PER_DFDE = 2 * Math.PI ** 2 * 2.8179403205e-13 * 1.973269804e-5;

/* ── Units ─────────────────────────────────────────────────────────────── */
// σ in cm² molecule⁻¹ to the other common measures of absorption strength. Base e: I = I₀e^(−σnL); base 10: I = I₀10^(−εcL).
export const SIGMA_UNITS = Object.freeze({
    'cm2': { label: 'σ, cm² molecule⁻¹', to: (s) => s, from: (x) => x },
    'eps10': { label: 'ε (base 10), L mol⁻¹ cm⁻¹', to: (s) => (s * N_A) / (1000 * LN10), from: (x) => (x * 1000 * LN10) / N_A },
    'epse': { label: 'ε (base e), L mol⁻¹ cm⁻¹', to: (s) => (s * N_A) / 1000, from: (x) => (x * 1000) / N_A },
    'k273': { label: 'k (base e), cm⁻¹ atm⁻¹ at 273.15 K', to: (s) => s * LOSCHMIDT, from: (x) => x / LOSCHMIDT },
    'k273_10': { label: 'k (base 10), cm⁻¹ atm⁻¹ at 273.15 K', to: (s) => (s * LOSCHMIDT) / LN10, from: (x) => (x * LN10) / LOSCHMIDT },
    'Mb': { label: 'σ, Mb (10⁻¹⁸ cm²)', to: (s) => s * 1e18, from: (x) => x * 1e-18 },
    'barn': { label: 'σ, barn (10⁻²⁴ cm²)', to: (s) => s * 1e24, from: (x) => x * 1e-24 },
    'A2': { label: 'σ, Å² (10⁻¹⁶ cm²)', to: (s) => s * 1e16, from: (x) => x * 1e-16 },
    'a02': { label: 'σ, a₀² (atomic units)', to: (s) => s / A0_2, from: (x) => x * A0_2 },
    'm2': { label: 'σ, m²', to: (s) => s * 1e-4, from: (x) => x * 1e4 },
    'dfdE': { label: 'df/dE, oscillator strength per eV', to: (s) => s / SIGMA_PER_DFDE, from: (x) => x * SIGMA_PER_DFDE },
});
/** Number density (cm⁻³) of an ideal gas at pressure p (Pa) and temperature T (K). */
export const density = (pPa, T) => (pPa > 0 && T > 0 ? pPa / (K_B * T) * 1e-6 : 0);
/** Photon energy (J) and wavenumber (cm⁻¹) of a vacuum wavelength in nm. */
export const photonJ = (nm) => (H * C) / (nm * 1e-9);
export const nmToCm1 = (nm) => 1e7 / nm;
export const nmToEV = (nm) => photonJ(nm) / 1.602176634e-19;

/* ── Spectra ───────────────────────────────────────────────────────────── */
/** Index of the last point with λ ≤ x (binary search); −1 below the range. */
function lowerIndex(d, x) {
    let lo = 0; let hi = d.length - 1;
    if (!d.length || x < d[0][0]) return -1;
    if (x >= d[hi][0]) return hi;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (d[m][0] <= x) lo = m; else hi = m; }
    return lo;
}
/** σ at wavelength x by linear interpolation; null outside the data. */
export function sigmaAt(d, x) {
    const i = lowerIndex(d, x);
    if (i < 0 || (i === d.length - 1 && x > d[i][0])) return null;
    if (i === d.length - 1) return d[i][1];
    const [x0, y0] = d[i]; const [x1, y1] = d[i + 1];
    return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}
/** Median wavelength step of a spectrum (nm), its effective resolution as tabulated. */
export function medianStep(d) {
    const s = []; for (let i = 1; i < d.length; i++) s.push(d[i][0] - d[i - 1][0]);
    s.sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : null;
}
/**
 * σ averaged over a laser line: a Gaussian of FWHM `fwhm` (nm) centered on x, integrated over the tabulated points
 * (trapezoid rule on the product σ·g, with the Gaussian evaluated at the data points and at fine sub-steps).
 * fwhm ≤ 0 gives the point value. Returns { sigma, covered (fraction of the line's weight inside the data), points
 * (data points inside ±FWHM), coarse (true when the data are coarser than the line: the average is an interpolation) }.
 */
export function sigmaLine(d, x, fwhm = 0) {
    if (!(fwhm > 0)) { const s = sigmaAt(d, x); return { sigma: s, covered: s == null ? 0 : 1, points: 0, coarse: false }; }
    const sd = fwhm / (2 * Math.sqrt(2 * Math.LN2));
    const a = x - 4 * sd; const b = x + 4 * sd;
    const lo = Math.max(a, d[0][0]); const hi = Math.min(b, d[d.length - 1][0]);
    if (!(hi > lo)) return { sigma: null, covered: 0, points: 0, coarse: true };
    // integrate on a grid that includes every data point in range plus at least 400 steps across the window
    const xs = new Set();
    const n = 400; for (let k = 0; k <= n; k++) xs.add(lo + ((hi - lo) * k) / n);
    let inside = 0;
    for (let i = Math.max(0, lowerIndex(d, lo)); i < d.length && d[i][0] <= hi; i++) { if (d[i][0] >= lo) xs.add(d[i][0]); if (Math.abs(d[i][0] - x) <= fwhm) inside++; }
    const g = (t) => Math.exp(-0.5 * ((t - x) / sd) ** 2);
    const grid = [...xs].sort((p, q) => p - q);
    let num = 0; let den = 0;
    for (let k = 1; k < grid.length; k++) {
        const t0 = grid[k - 1]; const t1 = grid[k]; const w = t1 - t0;
        const s0 = sigmaAt(d, t0); const s1 = sigmaAt(d, t1);
        num += 0.5 * w * (s0 * g(t0) + s1 * g(t1)); den += 0.5 * w * (g(t0) + g(t1));
    }
    const total = sd * Math.sqrt(2 * Math.PI) * 0.99993666;   // weight of the full ±4σ window
    const step = medianStep(d);
    return { sigma: den > 0 ? num / den : null, covered: Math.min(1, den / total), points: inside, coarse: step != null && step > fwhm };
}
/**
 * Resample a spectrum to at most `max` points while keeping its shape: points are kept where the curve bends
 * (largest-triangle style on log σ), and the first and last point always. Returns a new array.
 */
export function resample(d, max = 2000) {
    if (d.length <= max) return d.slice();
    const out = [d[0]];
    const bucket = (d.length - 2) / (max - 2);
    const ly = (p) => Math.log10(Math.max(p[1], 1e-40));
    let a = 0;
    for (let i = 0; i < max - 2; i++) {
        const s = Math.floor(i * bucket) + 1; const e = Math.min(Math.floor((i + 1) * bucket) + 1, d.length - 1);
        const ns = Math.min(Math.floor((i + 1) * bucket) + 1, d.length - 1); const ne = Math.min(Math.floor((i + 2) * bucket) + 1, d.length);
        let ax = 0; let ay = 0; const cnt = Math.max(1, ne - ns);
        for (let j = ns; j < ne; j++) { ax += d[j][0]; ay += ly(d[j]); }
        ax /= cnt; ay /= cnt;
        let best = s; let area = -1;
        for (let j = s; j < e; j++) {
            const ar = Math.abs((d[a][0] - ax) * (ly(d[j]) - ly(d[a])) - (d[a][0] - d[j][0]) * (ay - ly(d[a])));
            if (ar > area) { area = ar; best = j; }
        }
        out.push(d[best]); a = best;
    }
    out.push(d[d.length - 1]);
    return out;
}

/* ── Temperature ───────────────────────────────────────────────────────── */
/**
 * σ(λ, T) from datasets of one series measured at several temperatures: linear in T between the two nearest
 * temperatures that both cover λ (no extrapolation). sets: [{ T, data }]. `value(set)` gives one set's σ at λ, by
 * default the point value sigmaAt(set.data, x); the page passes its table value (a line average, or the full-resolution
 * value of a thinned spectrum), so that the two agree. Returns { sigma, T0, T1 } or null.
 */
export function sigmaAtT(sets, x, T, value = (s) => sigmaAt(s.data, x)) {
    const ok = sets.filter((s) => Number.isFinite(s.T)).map((s) => ({ s, v: value(s) })).filter((p) => p.v != null).sort((a, b) => a.s.T - b.s.T);
    if (!ok.length) return null;
    const exact = ok.find((p) => Math.abs(p.s.T - T) < 1e-9);
    if (exact) return { sigma: exact.v, T0: exact.s.T, T1: exact.s.T };
    let lo = null; let hi = null;
    for (const p of ok) { if (p.s.T < T) lo = p; else if (!hi) hi = p; }
    if (!lo || !hi) return null;
    return { sigma: lo.v + ((hi.v - lo.v) * (T - lo.s.T)) / (hi.s.T - lo.s.T), T0: lo.s.T, T1: hi.s.T };
}

/* ── Absorption and photolysis ─────────────────────────────────────────── */
/**
 * Beer–Lambert for a gas cell or path: σ (cm²), number density n (cm⁻³), path L (cm).
 * Returns optical depth τ = σnL (base e), absorbance A = τ/ln 10, transmittance and fraction absorbed.
 */
export function beerLambert(sigma, n, L) {
    const tau = sigma * n * L;
    return { tau, A: tau / LN10, T: Math.exp(-tau), absorbed: -Math.expm1(-tau) };
}
/**
 * One laser pulse of fluence F (J cm⁻²) at λ (nm) on an optically thin sample: photon fluence Φ = F/(hc/λ),
 * fraction excited 1 − exp(−σΦ), fraction photolyzed 1 − exp(−σΦφ) with quantum yield φ. Saturation is included by the
 * exponential, stimulated emission and multiphoton steps are not.
 */
export function pulsePhotolysis(sigma, fluenceJcm2, nm, phi = 1) {
    const photons = fluenceJcm2 / photonJ(nm);
    // saturation fluence hν/σ (J cm⁻²): the fluence at which a fraction 1 − 1/e of the molecules absorbs a photon
    return { photons, excited: -Math.expm1(-sigma * photons), photolyzed: -Math.expm1(-sigma * photons * phi), saturation: sigma > 0 ? photonJ(nm) / sigma : null };
}
/**
 * Common laser lines, wavelengths in nm as usually quoted (the Nd:YAG harmonics from 1064.2 nm: 532.1, 354.7, 266.0
 * and 212.8 nm). The difference between air and vacuum, ≈0.075 nm at 250 nm, is below the resolution of most
 * cross-section data. scripts/build_data.py stores the full-resolution σ of every thinned spectrum at these lines
 * (its LASER_NM must match).
 */
export const LASER_LINES = Object.freeze([
    { nm: 118.2, label: '118.2 nm (9th harmonic of 1064, VUV)' }, { nm: 121.567, label: '121.6 nm (Lyman-α)' }, { nm: 157.6, label: '157.6 nm (F₂)' },
    { nm: 193.3, label: '193 nm (ArF)' }, { nm: 212.8, label: '212.8 nm (Nd:YAG 5th)' }, { nm: 222, label: '222 nm (KrCl)' }, { nm: 248.4, label: '248 nm (KrF)' },
    { nm: 266, label: '266 nm (Nd:YAG 4th)' }, { nm: 308, label: '308 nm (XeCl)' }, { nm: 351.1, label: '351.1 nm (XeF)' }, { nm: 354.7, label: '354.7 nm (Nd:YAG 3rd)' },
    { nm: 405, label: '405 nm (diode)' }, { nm: 532.1, label: '532.1 nm (Nd:YAG 2nd)' },
]);
/** The lines whose labels the plot keeps first where the marked lines crowd: the most used ones. */
export const LINE_RANK = Object.freeze([248.4, 193.3, 266, 532.1, 354.7, 308, 157.6, 121.567, 212.8, 351.1, 222, 405, 118.2]);

/* ── What the page shows ───────────────────────────────────────────────── */
// The steps between the form and the numbers on the page, kept here so that the tests and the site's check cover them.

/** The x axes of the plot: the wavelength as given, 10⁷/λ, or hc/λ. */
export const X_AXES = Object.freeze({
    nm: Object.freeze({ label: 'Wavelength (nm)', unit: 'nm', of: (nm) => nm }),
    cm1: Object.freeze({ label: 'Wavenumber (cm⁻¹)', unit: 'cm⁻¹', of: nmToCm1 }),
    eV: Object.freeze({ label: 'Photon energy (eV)', unit: 'eV', of: nmToEV }),
});
/** The wavelength (nm) of a value on an x axis. 10⁷/λ and hc/λ are their own inverses, so `of` goes both ways. */
export const axisToNm = (axis, v) => (X_AXES[axis] || X_AXES.nm).of(v);
/** A wavelength (nm) as text in the unit of an x axis, for the plot limits and the line labels: 248.4, 40258, 4.991. */
export function axisText(axis, nm) {
    if (!(nm > 0)) return '';
    if (axis === 'cm1') return String(Math.round(nmToCm1(nm)));
    if (axis === 'eV') return String(+nmToEV(nm).toPrecision(4));
    return String(+(+nm).toPrecision(7));
}
/**
 * The plot limits from the From and To fields, which are in the unit of the x axis: { min, max } as wavelengths in nm
 * (text, '' for an open end). On the wavenumber and photon-energy axes a larger value is a shorter wavelength, so From
 * gives the longest wavelength and To the shortest. A field that is not a positive number leaves its end open.
 */
export function limitsToNm(axis, from, to) {
    const nm = (v) => { const x = parseNum(v); return x != null && x > 0 ? String(+axisToNm(axis, x).toPrecision(7)) : ''; };
    return axis === 'cm1' || axis === 'eV' ? { min: nm(to), max: nm(from) } : { min: nm(from), max: nm(to) };
}
/** The reverse: what the From and To fields show for limits kept in nm. */
export function limitsFromNm(axis, min, max) {
    const tx = (v) => { const x = parseNum(v); return x != null && x > 0 ? axisText(axis, x) : ''; };
    return axis === 'cm1' || axis === 'eV' ? { from: tx(max), to: tx(min) } : { from: tx(min), to: tx(max) };
}

/* ── Numbers typed into the form ───────────────────────────────────────── */
// The same rules as the site's calculators (assets/js/calc.js): a number is read whole or not at all. parseFloat would
// read "1,5" as 1 and "12abc" as 12 and compute with that.
const AMBIGUOUS_COMMA = /^[-+]?[1-9]\d{0,2},\d{3}([eE][-+]?\d+)?$/;
const SUPD = { '⁻': '-', '⁺': '+', '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
const normNum = (s) => String(s ?? '').trim().replace(/[−‒–]/g, '-').replace(/\s+/g, '')
    .replace(/[×x*]10([⁻⁺⁰¹²³⁴⁵⁶⁷⁸⁹]+)$/, (m, e) => `e${[...e].map((c) => SUPD[c]).join('')}`)
    .replace(/[×x*]10\^?([-+]?\d+)$/i, 'e$1');
/**
 * A typed number, or null when the text is not one number. Accepted: 248.4, 1e-17, 1.079 × 10⁻¹⁷ (as the page writes
 * it), a decimal comma (1,5 is 1.5; 0,532 is 0.532) and thousands separators (1,234,567). One comma followed by exactly
 * three digits ("1,064") could be 1064 or 1.064 and is refused, as is any text with something left over ("12abc").
 */
export function parseNum(x) {
    let s = normNum(x);
    if (!s) return null;
    if (s.includes(',')) {
        if (AMBIGUOUS_COMMA.test(s)) return null;
        if (/^[-+]?[1-9]\d{0,2}(,\d{3})+(\.\d*)?([eE][-+]?\d+)?$/.test(s)) s = s.replace(/,/g, '');
        else if (/^[-+]?\d*,\d+([eE][-+]?\d+)?$/.test(s)) s = s.replace(',', '.');
        else return null;
    }
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
}
/**
 * Why a field's text is not a number, as a sentence for the page, or '' when it is one or the field is empty:
 * “abc” is not a number (wavelength). “1,064” is ambiguous (wavelength): enter 1064 or 1.064 (decimal comma: 1,0640).
 */
export function numError(x, label) {
    const raw = String(x ?? '').trim();
    if (!raw || parseNum(raw) != null) return '';
    const s = normNum(raw);
    if (/^[-+]?(\d+[.,]?\d*|[.,]\d+)[eE][-+]?$/.test(s)) return '';   // an exponent still being typed: no number yet, and no complaint
    if (/^[-+]?(\d+\.?\d*|\.\d+)[eE][-+]?\d+$/.test(s)) return `That value is out of range (${label}).`;
    if (AMBIGUOUS_COMMA.test(s)) {
        const m = s.match(/^([^eE]*)(.*)$/);
        return `“${raw}” is ambiguous (${label}): enter ${s.replace(',', '')} or ${s.replace(',', '.')} (decimal comma: ${m[1]}0${m[2]}).`;
    }
    return `“${raw}” is not a number (${label}).`;
}

/* ── Line labels on the plot ───────────────────────────────────────────── */
/**
 * Which of the marked lines keep their text. `lines` are [{ px (position along the axis in pixels), w (width of the
 * label in pixels), keep (true for a label that must stay), rank (lower is kept first; default: the order given) }].
 * A label is dropped (its line stays) when a kept label already lies within one label width of it, so that no label
 * is drawn across its neighbor's line or text. Returns an array of booleans in the order given.
 */
export function keepLabels(lines) {
    const rank = (i) => (lines[i].keep ? -1 : lines[i].rank ?? i);
    const order = lines.map((l, i) => i).sort((a, b) => rank(a) - rank(b) || a - b);
    const kept = []; const out = lines.map(() => false);
    for (const i of order) {
        const l = lines[i];
        if (l.keep || !kept.some((k) => Math.abs(k.px - l.px) < Math.max(k.w, l.w))) { out[i] = true; kept.push(l); }
    }
    return out;
}
/** Number density (cm⁻³) from the form: a pressure p in a unit worth `unitPa` pascal, at T (K). */
export const densityFromForm = (p, unitPa, T) => density(p * unitPa, T);
/** One pulse from the form: the fluence in mJ cm⁻², and the saturation fluence also in mJ cm⁻² (saturationmJ). */
export function pulseFromForm(sigma, fluencemJcm2, nm, phi = 1) {
    const r = pulsePhotolysis(sigma, fluencemJcm2 / 1000, nm, phi);
    return { ...r, saturationmJ: r.saturation == null ? null : r.saturation * 1000 };
}
/** A dataset the build thinned for the web (more points in the source than on the page). */
export const isThinned = (meta) => !!meta && Number.isFinite(meta.n0) && Number.isFinite(meta.np) && meta.n0 > meta.np;
/** The full-resolution σ the build stored for a thinned dataset at a laser line (meta.at, keyed by the line's nm), or null. */
export function storedAt(meta, x) {
    const v = meta && meta.at ? meta.at[String(x)] : undefined;
    return Number.isFinite(v) ? v : null;
}
/**
 * σ of one dataset at λ = x as the table at a laser line shows it: { sigma, covered, coarse, at (the wavelength of the
 * point used, for a dataset of one or two points), full (the value is the build's full-resolution one), thinned (the
 * value comes from a thinned spectrum) }. A dataset of one or two points gives its nearest point within 1 nm, not an
 * interpolation. A point value (fwhm ≤ 0) at a laser line of a thinned dataset is the full-resolution value.
 */
export function tableValue(meta, data, x, fwhm = 0) {
    if (data.length < 3) {
        const p = data.reduce((b, q) => (Math.abs(q[0] - x) < Math.abs(b[0] - x) ? q : b));
        const near = Math.abs(p[0] - x) <= 1;
        return { sigma: near ? p[1] : null, covered: near ? 1 : 0, coarse: false, at: p[0], full: false, thinned: false };
    }
    if (!(fwhm > 0)) { const s = storedAt(meta, x); if (s != null) return { sigma: s, covered: 1, coarse: false, at: null, full: true, thinned: false }; }
    const r = sigmaLine(data, x, fwhm);
    return { ...r, at: null, full: false, thinned: r.sigma != null && isThinned(meta) };
}
/**
 * A number for the page: plain, with d + 1 significant figures, from 10⁻³ up to 10^(d+1) where that needs no
 * exponent; otherwise "m × 10<sup>e</sup>" (HTML). '—' for a missing or non-finite value.
 */
export function formatSci(x, d = 3) {
    if (x == null || !Number.isFinite(x)) return '—';
    if (x === 0) return '0';
    const minus = (s) => String(s).replace(/^-/, '−');
    const a = Math.abs(x);
    if (a >= 1e-3 && a < 10 ** (d + 1)) {
        const p = x.toPrecision(d + 1);
        if (!/e/.test(p)) return minus(p.includes('.') ? p.replace(/0+$/, '').replace(/\.$/, '') : p);
    }
    const [m, e] = x.toExponential(d).split('e');
    return `${minus(m)} × 10<sup>${minus(String(+e))}</sup>`;
}
/**
 * The series a dataset belongs to, for temperature interpolation: its id without the temperature and the wavelength
 * range of the file name, so that one paper's versions (resolution, pressure, air or vacuum, a later revision) stay
 * apart. 'mainz2013:O3_Bass(1984)_203K_245-340nm' → 'mainz2013:O3_Bass(1984)', 'bremen:O3_Serdyuchenko2014_v2013FFT_293K'
 * → 'bremen:O3_Serdyuchenko2014_v2013FFT'.
 */
export const seriesKey = (id) => String(id).replace(/_\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?K(?=_|\(|$)/g, '').replace(/_[\d.]+(?:\s*[-,]\s*[\d.]+)*\s?nm/g, '');
/** The lowest σ a log plot draws: 10⁻¹² of the largest σ in the spectra shown ([[λ, σ], …] each); 0 when there is none. */
export function logFloor(spectra, decades = 12) {
    let top = 0;
    for (const d of spectra) for (const p of d) if (p[1] > top && Number.isFinite(p[1])) top = p[1];
    return top > 0 ? top * 10 ** -decades : 0;
}
