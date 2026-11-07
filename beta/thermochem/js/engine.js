// Thermochemistry engine: ATcT species database, reaction parsing and balance, reaction enthalpies,
// uncertainty (independent errors and, where available, ATcT covariances), dissociation-channel search (neutral,
// ionic and electron-attachment channels, with excited products from NIST), the TN 1.220 -> 1.228 version diff,
// and energy unit conversion. Pure functions, no DOM; usable from Node for tests.

/* ── Units ─────────────────────────────────────────────────────────────── */
// CODATA 2022 (Mohr et al., Rev. Mod. Phys. 97, 025002 (2025)). N_A, e, h, c and k are exact in the SI, so every
// factor except the hartree is exact (shown to double precision). Base unit: kJ/mol.
export const KJ_PER = Object.freeze({
    'kJ/mol': 1,
    'kcal/mol': 4.184,                    // thermochemical calorie, exact
    'eV': 96.48533212331002,              // N_A e / 1000
    'cm⁻¹': 0.011962656563869701,         // N_A h c × (100 cm⁻¹ per m⁻¹) / 1000
    'K': 0.00831446261815324,             // R / 1000 = N_A k / 1000 (energy E = R T)
    'Eh': 2625.499639479163,              // N_A E_h / 1000, E_h = 4.3597447222060(48)e-18 J
});
export const UNITS = Object.freeze(Object.keys(KJ_PER));
/** Photon energy in kJ/mol × wavelength in nm (vacuum): N_A h c = 0.1196265656387 J m mol⁻¹ (exact). */
export const KJ_NM = 119626.5656386970;

export const toKJ = (v, unit) => v * KJ_PER[unit];
export const fromKJ = (kj, unit) => kj / KJ_PER[unit];
/** Vacuum wavelength (nm) of a photon carrying energy kj (kJ/mol); null when kj ≤ 0. */
export const kjToNm = (kj) => (kj > 0 ? KJ_NM / kj : null);
export const nmToKJ = (nm) => (nm > 0 ? KJ_NM / nm : null);

/* ── Database ──────────────────────────────────────────────────────────── */
const EXCLUDE_STATE = /\b(ortho|para)\b/;    // nuclear-spin isomers duplicate the parent species

/** Composition key: elements in Hill order plus charge, e.g. "C1H3O1|0". */
export function compKey(comp, q) {
    const els = Object.keys(comp).filter((e) => comp[e]);
    const hasC = els.includes('C');
    els.sort((a, b) => {
        if (hasC) { if (a === 'C') return -1; if (b === 'C') return 1; if (a === 'H') return -1; if (b === 'H') return 1; }
        return a < b ? -1 : a > b ? 1 : 0;
    });
    return els.map((e) => e + comp[e]).join('') + '|' + q;
}

export const ELECTRON = Object.freeze({
    n: 0, id: 'e-', name: 'Electron', formula: 'e⁻', state: 'g', q: -1, comp: {}, h0: 0, h298: 0, u: 0, utext: 'exact',
    mass: 0.000548579909, cas: '', smiles: '', inchikey: '', rank: 1e9, isElectron: true,
});

/** Build the in-memory database from the shipped JSON ({meta, cols, rows, syn, cov}). */
export function buildDB(payload) {
    const { cols, rows } = payload;
    const ix = Object.fromEntries(cols.map((c, i) => [c, i]));
    const species = rows.map((r, i) => {
        const s = {};
        for (const c of cols) s[c] = r[ix[c]];
        s.rank = i + 1;
        // ATcT prints "± 0.000" for uncertainties below 0.0005 kJ/mol; use that bound rather than zero (uPrinted keeps 0)
        s.uPrinted = s.u;
        if (!s.u && s.utext && !/exact/i.test(s.utext)) s.u = 0.0005;
        s.gas = /^g\b/.test(s.state);
        s.plainState = s.state === 'g' || s.state === 'g ?';
        s.labeled = s.gas && !s.plainState;
        s.key = compKey(s.comp, s.q);
        s.syn = (payload.syn && payload.syn[s.cas]) || [];
        s.hill = (payload.hill && payload.hill[s.cas]) || '';
        s.formulaLC = s.formula.toLowerCase();
        return s;
    });
    const byId = new Map(species.map((s) => [s.id, s]));
    const byNum = new Map(species.map((s) => [s.n, s]));
    const byFormula = new Map();
    const byKey = new Map();
    const byName = new Map();
    for (const s of species) {
        push(byFormula, s.formulaLC, s);
        push(byKey, s.key, s);
        for (const nm of [s.name, ...s.syn]) push(byName, nm.toLowerCase(), s);
    }
    byId.set('e-', ELECTRON);
    // ATcT lists the ground level of some species a second time under a label ("O (g, triplet)", "Cl (g, 2P3/2)", the
    // lowest conformer): a labeled gas entry with the same CAS RN and charge as the plain gas entry and the same ΔfH°(0 K)
    // within 0.001 kJ/mol is the same physical state. aliasOf maps it to the plain entry; channel searches skip it.
    const aliasOf = new Map(); const plainByCas = new Map();
    for (const s of species) if (s.plainState && s.cas) { const k = `${s.cas}|${s.q}`; if (!plainByCas.has(k)) plainByCas.set(k, s); }
    for (const s of species) {
        if (!s.labeled || !s.cas || s.h0 == null || EXCLUDE_STATE.test(s.state)) continue;
        const g = plainByCas.get(`${s.cas}|${s.q}`);
        if (g && g !== s && g.h0 != null && Math.abs(s.h0 - g.h0) <= 0.001) aliasOf.set(s.id, g);
    }
    // cov, exc and diff come from lazy-loaded files: attachCov, attachExcited, attachDiff
    return { meta: payload.meta || {}, species, byId, byNum, byFormula, byKey, byName, aliasOf, cov: null, exc: null, diff: null };
}
function push(map, k, v) { const a = map.get(k); if (a) { if (!a.includes(v)) a.push(v); } else map.set(k, [v]); }

/** Preferred species among same-formula alternatives: plain gas first, then other gas states, then by ATcT rank. */
export function preferred(list) {
    const score = (s) => (s.isElectron ? 0 : s.plainState ? 0 : s.gas && !EXCLUDE_STATE.test(s.state) ? 1 : s.gas ? 2 : 3);
    return list.slice().sort((a, b) => score(a) - score(b) || a.rank - b.rank);
}

/* ── Formula parsing (plain, Hill or structural formulas, with an optional charge) ── */
const ELEMENTS = new Set(('H D T He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr '
    + 'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir '
    + 'Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu').split(' '));

/**
 * Composition and charge of a formula: "O3", "C2H4", "HO2", Hill "H1O2", structural "CH3C(O)CH3" or "(CH3)2CO",
 * ions "CH3+", "[OH]-", "Ar+2", "Ar++". Element symbols are case-sensitive. Returns {comp, q} or null.
 */
export function parseFormula(raw) {
    let t = String(raw || '').replace(/\s+/g, '').replace(/⁺/g, '+').replace(/[⁻−]/g, '-');
    if (!t) return null;
    let q = 0;
    const ch = /(\+\+|--|[+-]\d*)$/.exec(t);
    if (ch) {
        const c = ch[1];
        q = c === '++' ? 2 : c === '--' ? -2 : (c[0] === '+' ? 1 : -1) * (c.length > 1 ? +c.slice(1) : 1);
        if (!q) return null;
        t = t.slice(0, -c.length);
    }
    if (!t) return null;
    const stack = [{}];
    let i = 0;
    const addTo = (o, e, n) => { o[e] = (o[e] || 0) + n; };
    while (i < t.length) {
        const c = t[i];
        if (c === '(' || c === '[') { stack.push({}); i++; continue; }
        if (c === ')' || c === ']') {
            if (stack.length < 2) return null;
            const g = stack.pop(); i++;
            const m = /^\d+/.exec(t.slice(i)); const k = m ? +m[0] : 1; if (m) i += m[0].length;
            for (const [e, n] of Object.entries(g)) addTo(stack[stack.length - 1], e, n * k);
            continue;
        }
        const m = /^([A-Z][a-z]?)(\d*)/.exec(t.slice(i));
        if (!m || !ELEMENTS.has(m[1])) return null;
        const n = m[2] ? +m[2] : 1; if (!n) return null;
        addTo(stack[stack.length - 1], m[1], n); i += m[0].length;
    }
    if (stack.length !== 1 || !Object.keys(stack[0]).length) return null;
    return { comp: stack[0], q };
}
/** Species with the composition and charge of a formula, or null. An all-lowercase formula is also tried in capitals. */
export function byComposition(db, f) {
    const pf = parseFormula(f) || (/^[a-z0-9()[\]+-]+$/.test(f) ? parseFormula(f.toUpperCase()) : null);
    if (!pf) return null;
    const l = db.byKey.get(compKey(pf.comp, pf.q));
    return l && l.length ? l : null;
}
const STATE_WORD = /^(g|l|cr|aq|s|liq|gas|cr,\s*l|amorp|vitreous)\b/i;

/**
 * Resolve one species token: ATcT ID, "#N" page number, "e-", ATcT formula with optional "(state)", ion spelling,
 * a plain or Hill formula (matched by composition and charge: "O3" → OOO, "C2H4" → CH2CH2), or a name/synonym.
 * `via` says how it matched; `alts` lists the alternatives (other states, or isomers for a composition match).
 */
export function resolveToken(db, raw) {
    const t = raw.trim();
    if (!t) return { error: 'empty species' };
    if (/^e-?$|^e⁻$|^electron$/i.test(t)) return { species: ELECTRON, alts: [ELECTRON], via: 'electron' };
    if (db.byId.has(t)) { const s = db.byId.get(t); return { species: s, alts: sameFormula(db, s), via: 'id' }; }
    const num = /^#(\d+)$/.exec(t);
    if (num && db.byNum.has(+num[1])) { const s = db.byNum.get(+num[1]); return { species: s, alts: sameFormula(db, s), via: 'id' }; }
    const norm = t.replace(/\s+/g, '');
    const list = db.byFormula.get(norm.toLowerCase()) || db.byFormula.get(t.toLowerCase());
    if (list) { const p = preferred(list); return { species: p[0], alts: p, via: 'formula' }; }
    // trailing "(state)": "O(g, singlet)", "H2O(l)", "CH2O (g, triplet)", "O3(g)"
    const st = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(t);
    if (st && STATE_WORD.test(st[2].trim())) {
        const f = st[1].replace(/\s+/g, '');
        const state = st[2].replace(/\s+/g, ' ').trim().toLowerCase();
        const exact = db.byFormula.get(f.toLowerCase());
        const cands = exact || resolveIon(db, f) || byComposition(db, f);
        if (cands) {
            const p = preferred(cands);
            const hit = p.find((s) => s.state.toLowerCase() === state) || p.find((s) => s.state.toLowerCase().replace(/\s/g, '') === state.replace(/\s/g, ''));
            if (hit) return { species: hit, alts: p, via: exact ? 'formula' : 'composition' };
            return { error: `no state “${st[2]}” for ${st[1]}; ATcT has ${[...new Set(p.map((s) => s.state))].join(', ')}`, alts: p };
        }
    }
    const ion = resolveIon(db, norm);
    if (ion) { const p = preferred(ion); return { species: p[0], alts: p, via: 'formula' }; }
    // "species(state)" names an electronic state ("O(1D)", "CH(C)", "S2(C)", "Cl(2P3/2)"). It is read before the
    // composition, so that "CH(C)" is CH in its C state and not C2H; resolveExcited returns null when the base species has
    // no listed states and the label is not a ground-state label.
    const ex = resolveExcited(db, t);
    if (ex && !ex.error) return ex;
    // plain or Hill formula by composition; a name wins only when it names a species of that same composition
    const comp = byComposition(db, norm);
    const named = db.byName.get(t.toLowerCase());
    if (named) {
        const p = preferred(named);
        if (!comp || comp.includes(p[0])) return { species: p[0], alts: p, via: 'name' };
    }
    if (ex) return comp ? { error: `${ex.error}. For ${preferred(comp)[0].formula} (${preferred(comp)[0].name}), write ${preferred(comp)[0].formula}` } : ex;
    if (comp) { const p = preferred(comp); return { species: p[0], alts: p, via: 'composition' }; }
    return { error: `“${t}” is not in ATcT ${db.meta.tn_version || ''}`.trim() };
}
// ion spellings: ATcT writes "[CH3]+", "[OH]-", "H+", "[Ar]+2"; accept "CH3+", "OH-", "[H]+", "Ar++" too
function resolveIon(db, norm) {
    const ion = /^\[?([^[\]]+?)\]?(\+\+|--|[+-]\d?)$/.exec(norm);
    if (!ion) return null;
    const sign = ion[2] === '++' ? '+2' : ion[2] === '--' ? '-2' : ion[2];
    for (const f of [`[${ion[1]}]${sign}`, `${ion[1]}${sign}`, `[${ion[1]}]${ion[2]}`, `${ion[1]}${ion[2]}`]) {
        const l = db.byFormula.get(f.toLowerCase());
        if (l) return l;
    }
    return null;
}
function sameFormula(db, s) { return s.isElectron ? [s] : preferred(db.byFormula.get(s.formulaLC) || [s]); }

/* ── Reaction parsing ──────────────────────────────────────────────────── */
const ARROW = /\s*(?:<=>|<->|->|→|⟶|=>|=)\s*/;

/** Split "2 O + hv -> O2" into sides of {coef, token}. Photon tokens (hv, hν, photon) are dropped. */
export function parseReaction(text) {
    const parts = String(text || '').split(ARROW);
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) return { error: 'Write the reaction as “reactants -> products”, e.g. H2O -> H + OH.' };
    const side = (s) => splitTerms(s).map(termOf).filter((x) => !x.photon);
    const left = side(parts[0]); const right = side(parts[1]);
    const bad = [...left, ...right].find((x) => x.error);
    if (bad) return { error: bad.error };
    if (!left.length || !right.length) return { error: 'Each side needs at least one species.' };
    return { left, right };
}
// Split a side into terms. A "+" is a separator when whitespace precedes it ("H + OH", "CH3+ + H") or when it is
// glued to a following species ("H+OH"); otherwise it is a charge sign ("CH3+", "[OH]+", "[Ar]+2", "X++").
export function splitTerms(s) {
    const out = []; let cur = ''; let depth = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
        if (c !== '+' || depth > 0) { cur += c; continue; }
        const after = s.slice(i + 1);
        const sep = i === 0 || /\s/.test(s[i - 1]) || (!/^\d+(\s|$)/.test(after) && /^[A-Za-z[(#]/.test(after));
        if (sep) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
}
function termOf(raw) {
    const t = raw.trim();
    if (/^(hv|hν|hnu|photon|γ)$/i.test(t)) return { photon: true };
    const m = /^(\d+\/\d+|\d+(?:\.\d+)?)\s*(.*)$/.exec(t);
    let coef = 1; let token = t;
    if (m && m[2] && (/^\s/.test(t.slice(m[1].length)) || /^[A-Z[(e]/.test(m[2]))) {
        coef = m[1].includes('/') ? (+m[1].split('/')[0]) / (+m[1].split('/')[1]) : +m[1];
        token = m[2];
    }
    if (!(coef > 0)) return { error: `bad coefficient in “${t}”` };
    return { coef, token: token.trim() };
}

/** Resolve a parsed reaction; overrides map "side:index" → ATcT ID chosen by the user. */
export function resolveReaction(db, parsed, overrides = {}) {
    const terms = [];
    const errors = [];
    const one = (x, sign, side, i) => {
        const key = `${side}:${i}`;
        let r = resolveToken(db, x.token);
        if (overrides[key] && db.byId.has(overrides[key])) r = { species: db.byId.get(overrides[key]), alts: r.alts || [db.byId.get(overrides[key])], via: 'choice' };
        if (r.error) errors.push(r.error);
        terms.push({ key, token: x.token, coef: x.coef, nu: sign * x.coef, species: r.species || null, alts: r.alts || [], via: r.via || null, error: r.error || null });
    };
    parsed.left.forEach((x, i) => one(x, -1, 'L', i));
    parsed.right.forEach((x, i) => one(x, 1, 'R', i));
    return { terms, errors };
}

/** Element and charge balance: {ok, elements: {El: net}, charge: net}. Net = products − reactants. */
export function balance(terms) {
    const el = {}; let q = 0;
    for (const t of terms) {
        if (!t.species) continue;
        for (const [e, n] of Object.entries(t.species.comp)) el[e] = (el[e] || 0) + t.nu * n;
        q += t.nu * t.species.q;
    }
    const off = Object.fromEntries(Object.entries(el).filter(([, v]) => Math.abs(v) > 1e-9));
    return { ok: !Object.keys(off).length && Math.abs(q) < 1e-9, elements: off, charge: Math.abs(q) < 1e-9 ? 0 : q };
}

/* ── Reaction enthalpy and uncertainty ─────────────────────────────────── */
/**
 * Σν ΔfH at 0 K and 298.15 K, the independent-error 95 % uncertainty u, and `ucorr`, the covariance-based
 * uncertainty (see covarianceU; null while no covariance file is attached).
 */
export function reactionEnthalpy(db, terms) {
    let h0 = 0; let h298 = 0; let xvar = 0; const missing0 = []; const missing298 = []; const nus = new Map(); const byS = new Map();
    for (const t of terms) {
        const s = t.species; if (!s) return null;
        if (s.h0 == null) missing0.push(s); else h0 += t.nu * s.h0;
        if (s.h298 == null) missing298.push(s); else h298 += t.nu * s.h298;
        // independent errors: one term per distinct species (a species listed twice, "O + O", counts as 2 O)
        const e = byS.get(s.id); if (e) e.nu += t.nu; else byS.set(s.id, { nu: t.nu, s });
        const k = s.base ? s.base.id : s.id;   // an excited state shares its ground entry's ATcT uncertainty
        nus.set(k, (nus.get(k) || 0) + t.nu);
    }
    let var0 = 0; let rvar = 0;
    for (const { nu, s } of byS.values()) {
        var0 += (nu * (s.u || 0)) ** 2;   // a NIST state's u already includes its term-value uncertainty
        if (s.base && s.uTerm) xvar += (nu * s.uTerm) ** 2;
    }
    // ATcT prints each value to the decimals of its uncertainty (at most 3), so the printed value carries up to half a
    // last digit of rounding; the covariances can't account for it (it matters where they cancel, as in Br₂ → 2 Br).
    // One rounding per printed ATcT value: an excited state and its ground entry share it (net coefficient).
    for (const { nu, s } of roundingTerms(byS)) { const r = nu * printRounding(s); var0 += r * r; xvar += r * r; rvar += r * r; }
    const u = Math.sqrt(var0);
    return {
        h0: missing0.length ? null : round(h0), h298: missing298.length ? null : round(h298), u, rvar,
        missing0: missing0.map((s) => s.id), missing298: missing298.map((s) => s.id),
        ucorr: covarianceU(db, nus, xvar),
    };
}
const round = (x) => Math.round(x * 1e6) / 1e6;
/** Net coefficient of each printed ATcT value (an excited state counts with its ground entry): [{ nu, s }]. */
function roundingTerms(byS) {
    const m = new Map();
    for (const { nu, s } of byS.values()) { const g = s.base || s; const e = m.get(g.id); if (e) e.nu += nu; else m.set(g.id, { nu, s: g }); }
    return [...m.values()];
}
/** Half the last printed digit of a species' ATcT value: ½·10^−d, d = decimals of its printed uncertainty (≤ 3); 0 if exact. */
export function printRounding(s) {
    const m = /^\d*\.(\d*)$/.exec(String(s.utext || '').trim());
    if (!m) return /^\d+$/.test(String(s.utext || '').trim()) ? 0.5 : 0;
    return 0.5 * 10 ** -Math.min(m[1].length, 3);
}

/* ── ATcT covariances (sparse file: TN 1.220, ΔfH° at 298.15 K) ─────────── */
/**
 * Attach the sparse covariance file (data/atct-cov-tn1.220.json): `ids`, `sd` (√ of the API diagonal, which approximates
 * the printed TN 1.220 95 % uncertainty: median ratio 0.988) and `rows` of "dj:r" correlation items for j > i (dj = j minus
 * the previous j; the first item is j − i). Pairs not listed have r = 0.
 */
export function attachCov(db, cov) {
    db.cov = {
        tn: cov.tn_version, T: cov.temperature_K, ids: cov.ids, sd: cov.sd, rows: cov.rows, cut: cov.cut,
        pos: new Map(cov.ids.map((id, i) => [id, i])), cache: new Map(),
    };
    return db.cov;
}
function corrRow(c, i) {
    let m = c.cache.get(i);
    if (m) return m;
    m = new Map(); let j = i;
    const txt = c.rows[i];
    if (txt) for (const item of txt.split(',')) { const k = item.indexOf(':'); j += +item.slice(0, k); m.set(j, +item.slice(k + 1)); }
    c.cache.set(i, m);
    return m;
}
/** Correlation coefficient r(i, j) by matrix index: 1 on the diagonal, 0 where the pair was cut. */
export function corr(c, i, j) {
    if (i === j) return 1;
    return (i < j ? corrRow(c, i).get(j) : corrRow(c, j).get(i)) || 0;
}
/** Species whose TN 1.220 and TN 1.228 uncertainties differ by more than this factor are flagged. */
export const STALE_FACTOR = 1.5;

/** A correlated variance below this fraction of Σ|terms| has lost three digits to cancellation. */
const CANCEL = 1e-3;

/**
 * Correlated 95 % uncertainty √(νᵀ C ν) of a reaction from the ATcT covariances (TN 1.220, the version the ATcT API
 * serves; ΔfH° at 298.15 K). `u220` is the sum with the TN 1.220 covariances exactly as served. `u` is the value shown:
 * the same sum, except that a species whose printed uncertainty changed between TN 1.220 and TN 1.228 (the version diff)
 * has its row and column scaled by U₁.₂₂₈ / U₁.₂₂₀ (printed values), so its own uncertainty is the TN 1.228 one while
 * its correlations stay those of TN 1.220. When that scaling leaves less than 0.1 % of Σ|terms| (heavy cancellation, as
 * in X₂ → 2 X), the scaled correlations are no longer meaningful and `u` falls back to `u220` (fallback = true). A
 * variance that still comes out ≤ 0 is not shown as 0: `u` is null and `lt` is the bound √(0.001 Σ|terms|).
 * `xvar` adds independent variance (term values of NIST states). Exact species (reference elements, e⁻) contribute
 * nothing; a species with U ≤ 0.0005 kJ/mol that is not in the file is added as independent. Returns null while no
 * covariance file is attached, else { covered, u, lt, u220, u220lt, fallback, clamped, scaled, tn, T, missing, stale }.
 * stale lists species whose printed uncertainty changed by more than STALE_FACTOR between the two versions.
 */
export function covarianceU(db, nus, xvar = 0) {
    const k = covSetup(db, nus, xvar); if (!k) return null;
    const { c, idx, v, f, missing, stale, scaled } = k;
    if (missing.length) return { covered: false, u: null, lt: null, u220: null, tn: c.tn, T: c.T, missing, stale, scaled };
    let a = k.extra; let b = k.extra; let ta = k.extra; let tb = k.extra;
    for (let x = 0; x < idx.length; x++) {
        for (let y = 0; y < idx.length; y++) {
            const r = corr(c, idx[x], idx[y]);
            if (!r) continue;
            const t = v[x] * v[y] * r * c.sd[idx[x]] * c.sd[idx[y]];
            b += t; tb += Math.abs(t);
            a += t * f[x] * f[y]; ta += Math.abs(t * f[x] * f[y]);
        }
    }
    let used = a; let tu = ta; let fallback = false;
    if (scaled.length && a <= CANCEL * ta) { used = b; tu = tb; fallback = true; }
    const clamped = used <= 0 && tu > 0;   // tu = 0: every species cancels (an identity), u is exactly 0
    return {
        covered: true, u: clamped ? null : Math.sqrt(used), lt: clamped ? Math.sqrt(CANCEL * tu) : null,
        u220: b > 0 || tb === 0 ? Math.sqrt(Math.max(b, 0)) : null, u220lt: b > 0 || tb === 0 ? null : Math.sqrt(CANCEL * tb),
        fallback, clamped, scaled, tn: c.tn, T: c.T, missing, stale,
    };
}
/**
 * The pieces of √(νᵀCν): covariance-matrix indices `idx`, coefficients `v` and TN 1.228 scale factors `f` of the covered
 * species (`ids`), independent variance `extra` (xvar plus tiny-uncertainty species outside the file, `extraById` per
 * species), and the `missing`, `stale` and `scaled` ID lists. Null while no covariance file is attached.
 */
function covSetup(db, nus, xvar = 0) {
    const c = db.cov; if (!c) return null;
    const idx = []; const v = []; const f = []; const ids = []; const missing = []; const stale = []; const scaled = [];
    let extra = xvar; const extraById = new Map();
    for (const [id, nu] of nus) {
        if (Math.abs(nu) < 1e-12) continue;
        const s = db.byId.get(id);
        const u = s ? s.u || 0 : 0;
        if (c.pos.has(id)) {
            const i = c.pos.get(id);
            idx.push(i); v.push(nu); ids.push(id);
            let fi = 1;
            const old = db.diff && s ? versionChange(db, s) : null;
            if (old && !old.isNew && old.u != null && s.uPrinted != null && Math.abs(old.u - s.uPrinted) > 5e-7) {
                // printed "± 0.000" means below 0.0005: use the smaller of that bound and the API value
                const u228 = s.uPrinted > 0 ? s.uPrinted : Math.min(0.0005, c.sd[i]);
                const u220 = old.u > 0 ? old.u : Math.min(0.0005, c.sd[i]);
                if (u220 > 0 && u228 > 0) fi = u228 / u220;
                if (fi !== 1) scaled.push(id);
                if (u228 > 0.001 && u220 > 0.001 && (fi > STALE_FACTOR || 1 / fi > STALE_FACTOR)) stale.push(id);
            }
            f.push(fi);
            continue;
        }
        if (u === 0) continue;
        if (u <= 0.0005) { extra += (nu * u) ** 2; extraById.set(id, (nu * u) ** 2); continue; }
        missing.push(id);
    }
    return { c, idx, v, f, ids, extra, extraById, missing, stale, scaled };
}

/**
 * Uncertainty budget of a reaction: what each species adds to the variance of ΔrH, and how far the result would improve
 * if that species were known exactly. One row per distinct ATcT entry (an excited state counts with its ground entry):
 * { id, species, nu, u (its 95 % uncertainty), indep (its part of the independent variance: (νU)² + rounding² + term²),
 *   share (its signed part of the variance used: Σⱼ νᵢνⱼCᵢⱼ plus its independent extras; the shares add up to the total and
 *   a share is negative when the species' correlations with the others cancel), without (the 95 % uncertainty with this
 *   species exact: the conditional variance Var − Cov(ΔrH, νᵢΔfHᵢ)²/Var(νᵢΔfHᵢ), as if a new measurement pinned it and the
 *   correlated species moved with it; its own rounding and term-value extras drop out too) }.
 * `how` is 'correlated' or 'independent' (as bestU), `total` the variance used and `indepTotal` the independent one.
 * When the correlated result is only a bound, `share` and `without` are null. Rounding of the printed values
 * (printRounding) and NIST term-value uncertainties are attributed to their species.
 */
export function uncertaintyBudget(db, terms) {
    const h = reactionEnthalpy(db, terms); if (!h) return null;
    const rows = new Map(); const byS = new Map();
    for (const t of terms) {
        const s = t.species; if (!s || s.isElectron) continue;
        const g = s.base || s;
        const r = rows.get(g.id) || { id: g.id, species: g, nu: 0, u: g.u || 0 };
        r.nu += t.nu; rows.set(g.id, r);
        const e = byS.get(s.id); if (e) e.nu += t.nu; else byS.set(s.id, { nu: t.nu, s });
    }
    // independent terms as in reactionEnthalpy, grouped by ground entry; extras are what the covariances can't carry
    const indepById = new Map(); const extraById = new Map();
    for (const { nu, s } of byS.values()) {
        const k = (s.base || s).id;
        indepById.set(k, (indepById.get(k) || 0) + (nu * (s.u || 0)) ** 2);
        extraById.set(k, (extraById.get(k) || 0) + (s.base && s.uTerm ? (nu * s.uTerm) ** 2 : 0));
    }
    for (const { nu, s } of roundingTerms(byS)) {   // one rounding per printed ATcT value, as in reactionEnthalpy
        const rr = (nu * printRounding(s)) ** 2;
        indepById.set(s.id, (indepById.get(s.id) || 0) + rr); extraById.set(s.id, (extraById.get(s.id) || 0) + rr);
    }
    const out = [...rows.values()].filter((r) => indepById.get(r.id) > 0);
    for (const r of out) r.indep = indepById.get(r.id);
    const indepTotal = out.reduce((a, r) => a + r.indep, 0);
    const bu = bestU(h);
    if (bu.how !== 'correlated') {
        for (const r of out) { r.share = r.indep; r.without = Math.sqrt(Math.max(indepTotal - r.indep, 0)); }
        return { how: 'independent', total: indepTotal, indepTotal, u: Math.sqrt(indepTotal), rows: out, h };
    }
    if (bu.lt) {
        for (const r of out) { r.share = null; r.without = null; }
        return { how: 'correlated', bound: true, total: null, indepTotal, u: bu.u, rows: out, h };
    }
    const nus = new Map();
    for (const t of terms) { const s = t.species; if (!s) continue; const k = s.base ? s.base.id : s.id; nus.set(k, (nus.get(k) || 0) + t.nu); }
    const k = covSetup(db, nus, [...extraById.values()].reduce((a, x) => a + x, 0));
    const useF = !h.ucorr.fallback;
    const T = (x, y) => {
        const r = corr(k.c, k.idx[x], k.idx[y]);
        return r ? k.v[x] * k.v[y] * r * k.c.sd[k.idx[x]] * k.c.sd[k.idx[y]] * (useF ? k.f[x] * k.f[y] : 1) : 0;
    };
    const n = k.idx.length; let total = k.extra; const rowSum = new Array(n).fill(0);
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) { const t = T(x, y); rowSum[x] += t; total += t; }
    for (const r of out) {
        const x = k.ids.indexOf(r.id);
        const ex = (extraById.get(r.id) || 0) + (k.extraById.get(r.id) || 0);
        if (x < 0) { r.share = ex; r.without = Math.sqrt(Math.max(total - ex, 0)); continue; }
        r.share = rowSum[x] + ex;
        const kk = T(x, x);   // conditional on this species: the network's correlations move the others with it
        r.without = Math.sqrt(Math.max(total - ex - (kk > 0 ? rowSum[x] ** 2 / kk : 0), 0));
    }
    return { how: 'correlated', total, indepTotal, u: Math.sqrt(Math.max(total, 0)), rows: out, h };
}

/**
 * The uncertainty a result shows: the correlated one when every species is covered, else the independent one.
 * lt = true when the correlated value is only a bound (shown as "< u").
 */
export function bestU(h) {
    if (!h) return { u: null, how: 'none' };
    const c = h.ucorr;
    if (c && c.covered) return c.u != null ? { u: c.u, how: 'correlated' } : { u: c.lt, how: 'correlated', lt: true };
    return { u: h.u, how: 'independent' };
}

/* ── Excited electronic states (NIST ASD, Huber–Herzberg, Jacox) ────────── */
/**
 * Attach the excited-state file (data/excited-states.json). Each row is an excitation energy above an ATcT ground
 * entry. Where ATcT itself lists the state (column `atct`), the ATcT entry is used and the NIST energy is kept only for
 * comparison, so no state is counted twice. Each list in db.exc.byGround is sorted by energy.
 */
export function attachExcited(db, payload) {
    const ix = Object.fromEntries(payload.cols.map((c, i) => [c, i]));
    const byGround = new Map(); const atctIds = new Set();
    const ground = new Map(Object.entries((payload.meta && payload.meta.ground) || {}));   // atoms: ground level by ATcT ID
    for (const r of payload.rows) {
        const g = db.byId.get(r[ix.ground]);
        if (!g || g.h0 == null) continue;
        const x = r[ix.atct] ? db.byId.get(r[ix.atct]) : null;
        if (r[ix.atct] && (!x || x.h0 == null)) continue;
        const nistKJ = r[ix.cm1] * KJ_PER['cm⁻¹'];
        const gl = ground.get(g.id);
        const note = r[ix.note] || '';
        const inGround = !!gl && note === gl.config;
        const st = {
            ground: g, species: r[ix.species], state: r[ix.state], J: r[ix.J], note,
            cm1: r[ix.cm1], uncCm1: r[ix.unc_cm1], sysCm1: ix.sys_cm1 != null ? r[ix.sys_cm1] : null, src: r[ix.src], method: r[ix.method],
            flags: r[ix.flags] ? r[ix.flags].split(';') : [], refs: r[ix.refs] || [], atct: x, fine: !!r[ix.fine],
            kj: x ? round(x.h0 - g.h0) : nistKJ, nistKJ, atom: !!gl, inGround, qual: gl && !inGround && note ? configQual(note, gl.config) : '',
        };
        // uncertainty of the term value: the source's own, plus the allowance for a reference level that was not converted
        st.uCm1 = Math.hypot(st.uncCm1 || 0, st.sysCm1 || 0);
        st.h0 = x ? x.h0 : g.h0 + st.kj;
        push(byGround, g.id, st);
        if (x) atctIds.add(x.id);
    }
    for (const l of byGround.values()) l.sort((a, b) => a.kj - b.kj);
    db.exc = { byGround, atctIds, ground, refs: payload.refs || {}, meta: payload.meta || {}, n: payload.rows.length };
    return db.exc;
}
/**
 * Short configuration label of an atomic level outside the ground configuration: the last subshell for a single excited
 * electron ("3s2.3p4.(3P).4s" → "4s", "2s" → "2s"), else the subshells that differ from the ground ("2s.2p3" → "2s2p3").
 */
function configQual(conf, gconf) {
    const parts = conf.split('.'); const last = parts[parts.length - 1];
    if (/\(/.test(conf) || /^\d+[spdfg]1?$/.test(last)) return last.replace(/([spdfg])1$/, '$1');
    const g = new Set(gconf.split('.'));
    return parts.filter((x) => !g.has(x)).join('');
}
/** Excited states listed for a ground-state species ([] when none, or while no file is attached). */
export const excitedStates = (db, s) => (db.exc && s && db.exc.byGround.get(s.id)) || [];

const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };
const subDigits = (x) => x.replace(/\d/g, (d) => SUB[d]);
/**
 * Plain-text state label: atoms "¹D₂", "²P°₁/₂", and outside the ground configuration with that configuration
 * ("4s ²P₃/₂", "2s ²S₁/₂"); molecules "A ²Σ⁺", "a ¹Δg", "B ²Π₁/₂", "ã ¹A₁".
 */
export function stateText(st) {
    if (!st) return '';
    let t = st.state.replace(/(^|\s)(\d)(?=[A-Z[ΣΠΔΦ])/g, (m, a, d) => a + SUP[d]).replace(/([ΣΠΔΦ][gu]?)([+-])/g, (m, a, c) => a + SUP[c])
        .replace(/(?<=[AB]'{0,2}"?)(\d)\b/g, (m, d) => SUB[d])
        .replace(/([ΣΠΔΦ][gu]?[⁺⁻]?)(\d+\/\d+|\d)(?![\d/])/g, (m, a, j) => a + subDigits(j));
    if (st.J) t += subDigits(st.J);
    if (st.qual) t = `${st.qual.replace(/([spdfg])(\d+)/g, (m, l, n) => l + n.replace(/\d/g, (d) => SUP[d]))} ${t}`;
    return t;
}
// Normalized label for matching typed state names: no spaces, accents stripped, Greek → Latin (Σ S, Π P, Δ D, Φ F),
// sub/superscript digits → digits, "*" → "°". The parity mark ° is kept (²P° of the halogen ground configuration and the
// excited ²P terms differ only by it); noPar drops it. Case is kept (A and a are different states).
const normState = (x) => String(x).replace(/[*º]/g, '°').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c))
    .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (c) => '₀₁₂₃₄₅₆₇₈₉'.indexOf(c)).replace(/⁺/g, '+').replace(/[⁻−]/g, '-')
    .replace(/Σ/g, 'S').replace(/Π/g, 'P').replace(/Δ/g, 'D').replace(/Φ/g, 'F').replace(/\s/g, '');
const noPar = (x) => x.replace(/°/g, '');

/**
 * Resolve "species(state)" to an electronic state: "O(1D)", "OH(A)", "O2(a1Δg)", "CO(a3Π)", "Cl(2P1/2)", "CH2(a)",
 * "Cl(4s 2P3/2)". Ground-state labels give the ground entry: "Cl(2P3/2)", "Cl(2P)", "H(2S1/2)", "H(1s)", "N(4S)",
 * "Si(3P0)", "OH(X)", "O2(X)". Atoms: the ground term (parity optional unless typed) and its fine-structure levels come
 * first; any other level must match its term (parity optional), J optional, or carry its configuration ("4s 2P3/2"); levels
 * of one term in one configuration give the lowest. Molecules: the exact label, the designation ("A", "a'"), or a unique
 * prefix. Several matching states give an error that lists them. Where ATcT lists the state the ATcT entry is returned;
 * otherwise a derived entry (see excitedSpecies). Returns null when the base has no listed states and the label is not a
 * ground-state label, so that the caller can read the text another way.
 */
export function resolveExcited(db, raw) {
    if (!db.exc) return null;
    const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(String(raw).trim());
    if (!m || !m[1].trim() || STATE_WORD.test(m[2].trim())) return null;
    const g = resolveToken(db, m[1]);
    if (!g.species || g.species.isElectron) return null;
    const ground = g.species.base || (db.aliasOf && db.aliasOf.get(g.species.id)) || g.species;
    const list = excitedStates(db, ground);
    const gl = db.exc.ground ? db.exc.ground.get(ground.id) : null;
    const want = normState(m[2]);
    const typedPar = want.includes('°');
    const eq = (a, b) => (typedPar ? a === b : noPar(a) === noPar(b));
    const gnd = { species: ground, alts: [ground], via: 'excited' };
    const hitOf = (st) => (st.atct ? { species: st.atct, alts: [st.atct], via: 'excited', excited: st } : { species: excitedSpecies(db, st), alts: [], via: 'excited', excited: st });
    let hits = [];
    if (gl) {
        const gt = normState(gl.term);
        if (eq(want, gt) || eq(want, gt + normState(gl.J)) || want.toLowerCase() === normState(gl.config).toLowerCase()) return gnd;
        hits = list.filter((st) => st.inGround && eq(normState(st.state), gt) && eq(want, normState(st.state + st.J)));
        if (hits.length === 1) return hitOf(hits[0]);
        hits = list.filter((st) => {
            const t = normState(st.state); const j = normState(st.J || ''); const q = st.qual ? normState(st.qual) : '';
            return eq(want, t) || eq(want, t + j) || (q && (want === q || eq(want, q + t) || eq(want, q + t + j)));
        });
        const inG = hits.filter((st) => st.inGround);
        if (inG.length) hits = inG;
        if (hits.length && hits.every((st) => st.state === hits[0].state && st.note === hits[0].note)) return hitOf(hits[0]);
    } else {
        if (!list.length && !/^X/.test(want)) return null;
        const desig = (st) => normState(st.state.split(/\s+/)[0]);
        hits = list.filter((st) => normState(st.state + (st.J || '')) === want);
        if (!hits.length) hits = list.filter((st) => desig(st) === want);
        if (hits.length === 1 && hits[0].fine && desig(hits[0]) === want) return gnd;   // "OH(X)": the ground state
        if (!hits.length) hits = list.filter((st) => normState(st.state + (st.J || '')).startsWith(want));
        if (hits.length === 1) return hitOf(hits[0]);
        if (!hits.length && /^X/.test(want)) return gnd;
    }
    if (hits.length > 1) {
        return { error: `“${m[2]}” matches several states of ${m[1].trim()}: ${hits.map((st) => `${stateText(st)} at ${st.cm1} cm⁻¹ (write ${stateToken(db, st)})`).join('; ')}` };
    }
    const groundLabel = gl ? `${gl.term}${gl.J} (ground)` : 'X (ground)';
    return { error: `no state “${m[2]}” for ${m[1].trim()}; listed: ${[groundLabel, ...list.map((st) => stateText(st))].join(', ')}` };
}
/**
 * Derived species entry for a NIST excited state (registered in db.byId so links and overrides find it). Its
 * uncertainty combines the ground entry's ATcT uncertainty with the term value's (uTerm: the source's own uncertainty and
 * any allowance for an unconverted reference level, in kJ/mol).
 */
export function excitedSpecies(db, st) {
    const g = st.ground; const lab = stateText(st);
    const id = `${g.id}@${st.qual ? st.qual + ' ' : ''}${st.state}${st.J ? ':' + st.J : ''}`;
    if (db.byId.has(id)) return db.byId.get(id);
    const uTerm = (st.uCm1 || 0) * KJ_PER['cm⁻¹'];
    const s = {
        ...g, id, name: `${g.name}, ${lab}`, formula: `${g.formula}(${lab})`, state: `g, ${lab}`, h0: round(st.h0), h298: null,
        u: Math.hypot(g.u || 0, uTerm), uTerm, utext: g.utext, labeled: true, plainState: false, base: g, excited: st, n: g.n,
    };
    db.byId.set(id, s);
    return s;
}
/**
 * Reaction-box token for a state that resolveToken reads back as the same state: the shortest of the term label, the
 * label with its configuration, the designation (molecules), or as a last resort the entry's ID.
 */
export function stateToken(db, st) {
    const f = st.ground.formula;
    const lab = `${st.state}${st.J || ''}`.replace(/\s+/g, '');
    const cands = st.atom
        ? [lab, st.qual ? `${st.qual} ${lab}` : null, st.note ? `${st.note} ${lab}` : null]
        : [st.state.split(/\s+/)[0], lab];
    const same = (r) => r && !r.error && r.excited === st;
    for (const c of cands) if (c && same(resolveToken(db, `${f}(${c})`))) return `${f}(${c})`;
    return st.atct ? st.atct.id : excitedSpecies(db, st).id;
}
/** Reaction terms of a channel with its products in the given states (null = ground; ATcT entry or derived NIST entry). */
export function excitedTerms(db, channel, states) {
    const prods = channel.products.map((s, i) => (states[i] ? states[i].atct || excitedSpecies(db, states[i]) : s));
    return [...channel.reactants.map((s) => ({ nu: -1, species: s })), ...prods.map((s) => ({ nu: 1, species: s }))];
}

/**
 * Thresholds for a channel with its products in excited states: every combination of product states (ground
 * included) except all-ground, sorted by energy. Each item: { states: [state or null per product], kj, h0 }, where
 * kj is the summed excitation energy and h0 the 0 K threshold. opts.maxKJ drops combinations more than maxKJ above
 * the ground-state channel; opts.fine = false leaves out spin-orbit and fine-structure levels of the ground state
 * (O ³P₁, Cl ²P½, OH X ²Π½ …); opts.limit caps the list.
 */
export function excitedThresholds(db, channel, opts = {}) {
    const { maxKJ = Infinity, limit = 200, fine = true } = opts;
    const lists = channel.products.map((s) => [null, ...(s.isElectron ? [] : excitedStates(db, s).filter((x) => fine || !x.fine))]);
    if (lists.every((l) => l.length === 1)) return [];
    let combos = [{ states: [], kj: 0 }];
    for (const l of lists) {
        const next = [];
        for (const c of combos) for (const st of l) { const kj = c.kj + (st ? st.kj : 0); if (kj <= maxKJ) next.push({ states: [...c.states, st], kj }); }
        combos = next;
        if (combos.length > 20000) break;
    }
    // identical fragments in swapped states ("O + O(¹D)" and "O(¹D) + O") are one channel
    const key = (c) => channel.products.map((s, i) => `${s.id}|${c.states[i] ? `${c.states[i].qual}${c.states[i].state}:${c.states[i].J || ''}` : ''}`).sort().join('+');
    const seen = new Set();
    return combos.filter((c) => { if (!c.states.some(Boolean)) return false; const k = key(c); if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => a.kj - b.kj).slice(0, limit).map((c) => ({ ...c, h0: round(channel.h0 + c.kj) }));
}

/* ── Version diff (TN 1.220 values of the species that changed) ─────────── */
export function attachDiff(db, payload) {
    db.diff = { meta: payload.meta || {}, rows: new Map(Object.entries(payload.rows || {})), newIds: new Set(payload.new || []) };
    return db.diff;
}
/** TN 1.220 values of a species where they differ from TN 1.228: {h0, h298, u}, or {isNew: true}, or null. */
export function versionChange(db, s) {
    if (!db.diff || !s || s.isElectron) return null;
    if (db.diff.newIds.has(s.id)) return { isNew: true };
    const r = db.diff.rows.get(s.id);
    return r ? { h0: r[0], h298: r[1], u: r[2] } : null;
}

/* ── Channel search (bond dissociation, photolysis, dissociative ionization) ── */
function subtract(a, b) {
    const r = { ...a };
    for (const [e, n] of Object.entries(b)) { r[e] = (r[e] || 0) - n; if (r[e] < 0) return null; if (!r[e]) delete r[e]; }
    return r;
}
const isEmpty = (c) => !Object.keys(c).length;

/**
 * Enumerate fragmentation channels of a gas-phase parent.
 * mode: 'neutral' (all products neutral), 'dpi' (one cation + neutrals + e⁻: appearance energies and the parent IE),
 *       'ionpair' (one cation + one anion), 'dea' (dissociative electron attachment, AB + e⁻ → A + B⁻: one anion and
 *       neutrals, the electron on the reactant side; the parent anion itself gives −EA).
 * opts: { three: include 3-body channels, labeled: include labeled gas states (excited states, conformers),
 *         excited: leave out the ATcT entries that the excited-state list shows as product states (with fine = false,
 *         the fine-structure ones such as Cl ²P½ are not shown there, so they stay in), fine, limit }
 * ATcT's second listing of a ground level (db.aliasOf: "O (g, triplet)", "Cl (g, 2P3/2)") is always left out.
 * Every channel carries `reactants` (the parent, plus e⁻ for 'dea') and `products`.
 */
export function findChannels(db, parent, mode = 'neutral', opts = {}) {
    const { three = false, labeled = false, excited = false, fine = true, limit = 400 } = opts;
    let skip = null;
    if (excited && db.exc) {
        skip = new Set();
        for (const l of db.exc.byGround.values()) for (const st of l) if (st.atct && (fine || !st.fine)) skip.add(st.atct.id);
    }
    const alias = db.aliasOf || new Map();
    const pool = db.species.filter((s) => s.gas && s.h0 != null && s.id !== parent.id && !EXCLUDE_STATE.test(s.state) && (labeled || !s.labeled) && !alias.has(s.id) && !(skip && skip.has(s.id)) && subtract(parent.comp, s.comp));
    // ATcT lists some species twice (e.g. "g" and "g ?"); the pool keeps both, the rank order breaks ties.
    const byKey = new Map();
    for (const s of pool) push(byKey, s.key, s);
    const out = [];
    const seen = new Set();
    const addChannel = (prods) => {
        const ids = prods.map((s) => s.id).sort();
        const k = ids.join('+'); if (seen.has(k)) return; seen.add(k);
        const reactants = mode === 'dea' ? [parent, ELECTRON] : [parent];
        const terms = [...reactants.map((s) => ({ nu: -1, species: s })), ...prods.map((s) => ({ nu: 1, species: s }))];
        const r = reactionEnthalpy(db, terms);
        if (!r || r.h0 == null) return;
        out.push({ reactants, products: prods, ...r });
    };
    const okCharges = (qs) => {
        if (mode === 'neutral') return qs.every((q) => q === 0);
        if (mode === 'dpi') return qs.filter((q) => q === 1).length === 1 && qs.every((q) => q === 0 || q === 1);
        if (mode === 'dea') return qs.filter((q) => q === -1).length === 1 && qs.every((q) => q === 0 || q === -1);
        return qs.length === 2 && qs.includes(1) && qs.includes(-1);
    };
    const eTail = mode === 'dpi' ? [ELECTRON] : [];
    const qOff = mode === 'dpi' ? -1 : mode === 'dea' ? 1 : 0;   // the electron's charge: a product in 'dpi', a reactant in 'dea'
    if (mode === 'dpi') {
        for (const s of byKey.get(compKey(parent.comp, parent.q + 1)) || []) addChannel([s, ...eTail]);   // parent ion: adiabatic IE
    }
    if (mode === 'dea') {
        for (const s of byKey.get(compKey(parent.comp, parent.q - 1)) || []) addChannel([s]);   // parent anion: attachment, −EA
    }
    for (const a of pool) {
        const rest = subtract(parent.comp, a.comp);
        if (!rest || isEmpty(rest)) continue;
        for (const qb of [-1, 0, 1]) {
            if (!okCharges([a.q, qb]) || a.q + qb + qOff !== parent.q) continue;
            for (const b of byKey.get(compKey(rest, qb)) || []) addChannel([a, b, ...eTail]);
        }
        if (!three || mode === 'ionpair') continue;
        for (const b of pool) {
            if (b.rank < a.rank) continue;
            const rest2 = subtract(rest, b.comp);
            if (!rest2 || isEmpty(rest2)) continue;
            for (const qc of [-1, 0, 1]) {
                if (!okCharges([a.q, b.q, qc]) || a.q + b.q + qc + qOff !== parent.q) continue;
                for (const c of byKey.get(compKey(rest2, qc)) || []) addChannel([a, b, c, ...eTail]);
            }
        }
        if (out.length > 20000) break;
    }
    out.sort((x, y) => x.h0 - y.h0);
    return out.slice(0, limit);
}

/* ── Species relations ─────────────────────────────────────────────────── */
/** Other entries with the same composition and charge (isomers, states, phases). */
export function sameComposition(db, s) { return (db.byKey.get(s.key) || []).filter((x) => x !== s); }

/** Bare ATcT formula of an ion: "[CH2O]+" → "CH2O", "H+" → "H", "[Ar]+2" → "Ar". */
export const coreFormula = (f) => f.replace(/(\+\d?|-\d?|\+\+|--)$/, '').replace(/^\[(.*)\]$/, '$1');
/** Ion with the same structural formula as the neutral (an IE or EA, not an energy to an isomeric ion). */
const sameStructure = (ion, s) => coreFormula(ion.formula) === coreFormula(s.formula);

/** Adiabatic ionization energies to every gas cation of the same composition (0 K): ΔfH0(M⁺) − ΔfH0(M). */
export function ionizationEnergies(db, s) {
    if (!s.gas || s.h0 == null) return [];
    return (db.byKey.get(compKey(s.comp, s.q + 1)) || []).filter((c) => c.gas && c.h0 != null && !EXCLUDE_STATE.test(c.state) && sameStructure(c, s))
        .map((c) => ({ ion: c, kj: c.h0 - s.h0, u: Math.hypot(c.u || 0, s.u || 0) })).sort((a, b) => a.kj - b.kj);
}
/** Adiabatic electron affinities from every gas anion of the same composition (0 K): ΔfH0(M) − ΔfH0(M⁻). */
export function electronAffinities(db, s) {
    if (!s.gas || s.h0 == null) return [];
    return (db.byKey.get(compKey(s.comp, s.q - 1)) || []).filter((a) => a.gas && a.h0 != null && !EXCLUDE_STATE.test(a.state) && sameStructure(a, s))
        .map((a) => ({ ion: a, kj: s.h0 - a.h0, u: Math.hypot(a.u || 0, s.u || 0) })).sort((a, b) => b.kj - a.kj);
}
/**
 * True for an anion that ATcT lists above its neutral of the same structure (negative adiabatic electron affinity):
 * it is unbound, at most a temporary anion, and not a stable product.
 */
export function unboundAnion(db, s) {
    if (!s || s.isElectron || !(s.q < 0) || s.h0 == null) return false;
    const ns = (db.byKey.get(compKey(s.comp, s.q + 1)) || []).filter((n) => n.gas && n.h0 != null && !EXCLUDE_STATE.test(n.state) && sameStructure(s, n));
    if (!ns.length) return false;
    return preferred(ns)[0].h0 - s.h0 < 0;
}
/**
 * Strict number from user text: digits with an optional decimal point and exponent, a leading sign ("−" too), or a lone
 * decimal comma with one or two decimals ("1,5"). Returns null for empty text and NaN for anything else ("0x10", "1,000").
 */
export function parseNum(text) {
    let t = String(text ?? '').trim().replace(/[−–]/g, '-');
    if (!t) return null;
    if (!t.includes('.') && /^[+-]?\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return NaN;
    const x = Number(t);
    return Number.isFinite(x) ? x : NaN;
}
/** Proton affinities at 298.15 K: ΔfH298(M) + ΔfH298(H⁺) − ΔfH298(MH⁺) (the stationary-electron convention cancels). */
export function protonAffinities(db, s) {
    if (!s.gas) return [];
    const hp = (db.byFormula.get('h+') || []).find((x) => x.gas);
    if (!hp) return [];
    const comp = { ...s.comp, H: (s.comp.H || 0) + 1 };
    return (db.byKey.get(compKey(comp, s.q + 1)) || []).filter((x) => x.gas && !EXCLUDE_STATE.test(x.state))
        .map((x) => ({ ion: x, kj: s.h298 + hp.h298 - x.h298, u: Math.hypot(x.u || 0, s.u || 0) })).sort((a, b) => b.kj - a.kj);
}

/* ── Search ────────────────────────────────────────────────────────────── */
/**
 * Ranked species search over formula, name, synonyms, CAS, ATcT ID, InChIKey and SMILES.
 * The first hit is always what the reaction parser would pick for the same text (resolveToken), followed by its
 * alternatives and every other species of the same composition and charge; text matches come after.
 */
export function search(db, query, limit = 25) {
    const raw = query.trim();
    const q = raw.toLowerCase();
    if (!q) return [];
    const qn = q.replace(/\s+/g, '');
    const out = []; const seen = new Set();
    const add = (s) => { if (s && !s.isElectron && !seen.has(s)) { seen.add(s); out.push(s); } };
    const r = resolveToken(db, raw);
    add(r.species);
    for (const s of r.alts || []) add(s);
    const comp = byComposition(db, raw.replace(/\s+/g, ''));
    if (comp) preferred(comp).forEach(add);
    const hits = [];
    for (const s of db.species) {
        if (seen.has(s)) continue;
        let score = Infinity;
        if (s.formulaLC === qn) score = 0;
        else if (s.name.toLowerCase() === q) score = 1;
        else if (s.cas === q || s.id.toLowerCase() === q || (s.inchikey && s.inchikey.toLowerCase() === q) || s.smiles.toLowerCase() === q) score = 1;
        else if (s.formulaLC.startsWith(qn)) score = 3;
        else if (s.name.toLowerCase().startsWith(q)) score = 4;
        else {
            for (const nm of s.syn) { const l = nm.toLowerCase(); if (l === q) { score = Math.min(score, 2); break; } if (l.startsWith(q)) score = Math.min(score, 5); else if (q.length > 2 && l.includes(q)) score = Math.min(score, 7); }
            if (score > 6 && q.length > 2 && s.name.toLowerCase().includes(q)) score = 6;
        }
        if (score > 6 && q.length >= 14 && s.inchikey && s.inchikey.toLowerCase().startsWith(q)) score = 2;
        if (score < Infinity) hits.push([score + (s.gas ? 0 : 0.5) + (s.labeled ? 0.3 : 0) + (EXCLUDE_STATE.test(s.state) ? 0.4 : 0), s.rank, s]);
    }
    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const h of hits) { if (out.length >= limit) break; add(h[2]); }
    return out.slice(0, limit);
}

/* ── CSV import (same columns as the cleaned ATcT CSV) ────────────────── */
export function parseCSV(text) {
    const rows = []; let row = []; let f = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
        if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; } else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows.filter((r) => r.length > 1 || r[0]);
}
/**
 * Convert a user CSV (columns of atct_tn1.228_species.csv) into the payload buildDB expects.
 * Required: atct_id, formula, dHf_298K_kJmol. Composition and charge come from the `composition` and `charge`
 * columns; where either is missing or empty they are parsed from the formula. Rows whose composition, charge or
 * ΔfH°(298.15 K) cannot be determined are skipped (counted in meta.skipped), so the balance check never runs blind.
 */
export function payloadFromCSV(text, label = 'user CSV') {
    const rows = parseCSV(String(text || '').replace(/^﻿/, ''));
    if (!rows.length) throw new Error('the file is empty');
    const head = rows.shift().map((h) => h.trim());
    if (!rows.length) throw new Error('the file has a header row but no data');
    const col = (n) => head.indexOf(n);
    const need = ['atct_id', 'formula', 'dHf_298K_kJmol'];
    const miss = need.filter((n) => col(n) < 0);
    if (miss.length) throw new Error(`missing column(s): ${miss.join(', ')}`);
    const get = (r, n) => (col(n) >= 0 && r[col(n)] != null ? r[col(n)].trim() : '');
    const num = (x) => (x === '' || x == null || isNaN(+x) ? null : +x);
    const cols = ['n', 'id', 'name', 'formula', 'state', 'q', 'comp', 'h0', 'h298', 'u', 'utext', 'mass', 'cas', 'smiles', 'inchikey'];
    const out = []; let skipped = 0;
    rows.forEach((r, i) => {
        let comp = {};
        for (const tok of get(r, 'composition').split(/\s+/).filter(Boolean)) { const m = /^([A-Z][a-z]?)(\d+)$/.exec(tok); if (m) comp[m[1]] = +m[2]; }
        let q = num(get(r, 'charge'));
        if (!Object.keys(comp).length || q == null) {
            const pf = parseFormula(get(r, 'formula'));
            if (pf) { if (!Object.keys(comp).length) comp = pf.comp; if (q == null) q = pf.q; }
        }
        const id = get(r, 'atct_id'); const h298 = num(get(r, 'dHf_298K_kJmol'));
        if (!id || h298 == null || !Object.keys(comp).length || q == null) { skipped++; return; }
        out.push([num(get(r, 'species_number')) || i + 1, id, get(r, 'name') || get(r, 'formula'), get(r, 'formula'), get(r, 'state') || 'g',
            q, comp, num(get(r, 'dHf_0K_kJmol')), h298, num(get(r, 'unc_95_kJmol')) || 0,
            get(r, 'unc_text'), num(get(r, 'mass_g_mol')), get(r, 'cas'), get(r, 'smiles'), get(r, 'inchikey')]);
    });
    const ver = (rows[0] && col('tn_version') >= 0) ? get(rows[0], 'tn_version') : '';
    return { meta: { source: label, tn_version: ver || 'unknown', units: 'kJ/mol', skipped }, cols, rows: out, syn: {}, cov: null };
}

