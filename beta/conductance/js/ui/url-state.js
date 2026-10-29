// Components model <-> URL hash, grammar version 1 (spec 2.9). DOM-free; decoding never throws.
//   #v=1&tab=components&g=N2&T=293.15&bc=pump&p0=1e-4&lu=mm&su=L/s&pu=mbar&i=<items>
//   optional: &p1=<Pa> (bc=dp) &cd=<Cd> &pmin=<Pa> &pmax=<Pa>
//   custom gas: &g=custom&gM=<kg/mol>&geta=<Pa·s>&gom=<omega>&gga=<gamma>&gcd=<Cd>
//   <items> := <item>+ ; <item> := <token> '(' <params> ')' ; par := 'par(' <items> (';' <items>)+ ')'
// State = { tab, model: { items, gas: { id, T, custom }, Cd, bc, range }, units: { lu, su, pu } }.

import { ELEMENT_TYPES, defaultItem } from '../engine/elements.js';
import { GAS_IDS } from '../engine/gas.js';

export const TABS = Object.freeze(['components', 'cad', 'selftest']);
export const LENGTH_UNITS = Object.freeze(['mm', 'cm', 'm', 'in']);
export const SPEED_UNITS = Object.freeze(['L/s', 'm³/h', 'L/min', 'cfm']);
export const PRESSURE_UNITS = Object.freeze(['mbar', 'Pa', 'Torr', 'mTorr']);
export const DEFAULT_RANGE = Object.freeze({ pMin: 1e-6, pMax: 1.2e5 });
export const DEFAULT_HASH = 'v=1&g=N2&T=293.15&bc=pump&p0=1e-4&lu=mm&su=L/s&pu=mbar'
    + '&i=tube(d=0.1,L=0.2)elbow(d=0.1,A=0.1,B=0.1)pump(S=0.3,d=0.1,label=Turbo)';
export const BAD_LINK_NOTE = 'This link could not be read, so the default example is shown.';

const TOKEN_TYPE = Object.fromEntries(Object.entries(ELEMENT_TYPES).map(([type, d]) => [d.token, type]));
const WORD = /^[A-Za-z0-9._-]{1,40}$/;
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/** SI number as written in the hash: String(Number(x.toPrecision(7))) with 'e+' shortened to 'e'. */
export function encodeNumber(x) {
    return String(Number(Number(x).toPrecision(7))).replace('e+', 'e');
}

/** A label as a hash word: spaces become '_', other characters outside [A-Za-z0-9._-] are dropped, at most 40. */
export function encodeLabel(s) {
    return String(s ?? '').trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
}

const fieldActive = (f, item) => !f.when || Object.entries(f.when).every(([k, v]) => item[k] === v);

function encodeItem(item) {
    const def = ELEMENT_TYPES[item && item.t];
    if (!def) return '';
    if (item.t === 'parallel') {
        const br = Array.isArray(item.branches) ? item.branches : [];
        return def.token + '(' + br.map((b) => encodeItems(Array.isArray(b) ? b : [])).join(';') + ')';
    }
    const parts = [];
    for (const f of def.fields) {
        if (!fieldActive(f, item)) continue;
        const v = item[f.key];
        if (f.kind === 'number') {
            if (typeof v === 'number' && !Number.isNaN(v)) parts.push(f.key + '=' + encodeNumber(v));
        } else if (f.kind === 'select') {
            if (typeof v === 'string' && WORD.test(v)) parts.push(f.key + '=' + v);
        } else {
            const w = encodeLabel(v);
            if (w) parts.push(f.key + '=' + w);
        }
    }
    return def.token + '(' + parts.join(',') + ')';
}

/** The <items> part of the hash. */
export function encodeItems(items) {
    return (Array.isArray(items) ? items : []).map(encodeItem).join('');
}

/** The hash (without '#') of a state { tab, model, units }. */
export function encode(state) {
    const m = state.model, g = m.gas || {}, bc = m.bc || {}, u = state.units || {};
    const out = ['v=1'];
    if (state.tab && state.tab !== 'components') out.push('tab=' + state.tab);
    out.push('g=' + (g.id || 'N2'));
    if (g.id === 'custom' && g.custom) {
        const c = g.custom;
        out.push('gM=' + encodeNumber(c.M), 'geta=' + encodeNumber(c.eta20), 'gom=' + encodeNumber(c.omega),
            'gga=' + encodeNumber(c.gamma), 'gcd=' + encodeNumber(c.Cd));
    }
    out.push('T=' + encodeNumber(g.T ?? 293.15));
    if (m.Cd !== null && m.Cd !== undefined && Number.isFinite(m.Cd)) out.push('cd=' + encodeNumber(m.Cd));
    out.push('bc=' + (bc.mode === 'dp' ? 'dp' : 'pump'), 'p0=' + encodeNumber(bc.p0));
    if (bc.mode === 'dp') out.push('p1=' + encodeNumber(bc.p1));
    const r = m.range;
    if (r && !(r.pMin === DEFAULT_RANGE.pMin && r.pMax === DEFAULT_RANGE.pMax)) out.push('pmin=' + encodeNumber(r.pMin), 'pmax=' + encodeNumber(r.pMax));
    out.push('lu=' + (u.lu || 'mm'), 'su=' + (u.su || 'L/s'), 'pu=' + (u.pu || 'mbar'));
    out.push('i=' + encodeItems(m.items));
    return out.join('&');
}

// ---- decoding

class ParseError extends Error {}

function makeItem(type, params) {
    const def = ELEMENT_TYPES[type], item = defaultItem(type);
    for (const [k, raw] of params) {
        const f = def.fields.find((x) => x.key === k);
        if (!f) continue;                                         // unknown parameter: ignored
        if (f.kind === 'number') {
            if (NUMBER.test(raw)) item[k] = Number(raw);           // out-of-range values are kept for the editor
        } else if (f.kind === 'select') {
            if (WORD.test(raw)) item[k] = raw;
        } else if (WORD.test(raw)) {
            item[k] = raw.replace(/_/g, ' ');
        }
    }
    for (const f of def.fields) if (!fieldActive(f, item)) delete item[f.key];   // keep only the active fields
    return item;
}

// items from position pos of s, up to the end or a stop character (';' or ')' inside a group)
function parseItems(s, pos, inGroup) {
    const items = [];
    while (pos < s.length) {
        const ch = s[pos];
        if (inGroup && (ch === ';' || ch === ')')) break;
        const m = /^[A-Za-z][A-Za-z0-9_]*/.exec(s.slice(pos));
        if (!m) throw new ParseError('token');
        const token = m[0];
        pos += token.length;
        if (s[pos] !== '(') throw new ParseError('(');
        pos++;
        const type = TOKEN_TYPE[token];
        if (type === 'parallel') {
            if (inGroup) throw new ParseError('nested');
            const branches = [];
            for (;;) {
                const r = parseItems(s, pos, true);
                branches.push(r.items);
                pos = r.pos;
                if (s[pos] === ';') { pos++; continue; }
                if (s[pos] === ')') { pos++; break; }
                throw new ParseError(')');
            }
            const item = defaultItem('parallel');
            item.branches = branches;
            items.push(item);
            continue;
        }
        const end = s.indexOf(')', pos);
        if (end < 0) throw new ParseError(')');
        const body = s.slice(pos, end);
        if (/[(;]/.test(body)) throw new ParseError('body');
        pos = end + 1;
        if (!type) continue;                                      // unknown token: ignored
        const params = body ? body.split(',').map((p) => { const k = p.indexOf('='); return k < 0 ? [p, ''] : [p.slice(0, k), p.slice(k + 1)]; }) : [];
        items.push(makeItem(type, params));
    }
    return { items, pos };
}

/** Items from the <items> text; throws on a syntax error (unbalanced parentheses, stray characters). */
export function decodeItems(text) {
    const r = parseItems(String(text), 0, false);
    if (r.pos !== String(text).length) throw new ParseError('trailing');
    return r.items;
}

const num = (s) => (typeof s === 'string' && NUMBER.test(s) ? Number(s) : NaN);
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);

function defaultsFromHash() {
    const p = splitHash(DEFAULT_HASH);
    return buildState(p, decodeItems(p.get('i')));
}

function splitHash(h) {
    const map = new Map();
    for (const part of h.split('&')) {
        if (!part) continue;
        const k = part.indexOf('=');
        if (k <= 0) continue;
        const key = part.slice(0, k);
        if (!map.has(key)) map.set(key, part.slice(k + 1));
    }
    return map;
}

function buildState(p, items) {
    let id = p.get('g');
    let custom = null;
    if (id === 'custom') {
        const c = { M: num(p.get('gM')), eta20: num(p.get('geta')), omega: num(p.get('gom')), gamma: num(p.get('gga')), Cd: num(p.get('gcd')) };
        const d = { M: 0.0280134, eta20: 1.757e-5, omega: 0.74, gamma: 1.4, Cd: 0.824 };   // nitrogen, for missing values
        for (const k of Object.keys(c)) if (Number.isNaN(c[k])) c[k] = d[k];
        custom = c;
    } else if (!GAS_IDS.includes(id)) id = 'N2';
    const T = Number.isNaN(num(p.get('T'))) ? 293.15 : num(p.get('T'));
    const cd = num(p.get('cd'));
    const mode = p.get('bc') === 'dp' ? 'dp' : 'pump';
    let p0 = num(p.get('p0'));
    if (Number.isNaN(p0)) p0 = mode === 'dp' ? 10 : 1e-4;
    const bc = mode === 'dp' ? { mode, p0, p1: Number.isNaN(num(p.get('p1'))) ? p0 / 1000 : num(p.get('p1')) } : { mode, p0 };
    const pMin = num(p.get('pmin')), pMax = num(p.get('pmax'));
    const range = Number.isNaN(pMin) || Number.isNaN(pMax) ? { ...DEFAULT_RANGE } : { pMin, pMax };
    return {
        tab: pick(p.get('tab'), TABS, 'components'),
        model: { items, gas: { id, T, custom }, Cd: Number.isNaN(cd) ? null : cd, bc, range },
        units: { lu: pick(p.get('lu'), LENGTH_UNITS, 'mm'), su: pick(p.get('su'), SPEED_UNITS, 'L/s'), pu: pick(p.get('pu'), PRESSURE_UNITS, 'mbar') },
    };
}

/** The default state (Appendix B preset 1). */
export function defaultState() { return defaultsFromHash(); }

/**
 * Decodes a hash (with or without '#'). Never throws. Returns { state, kind, notice }:
 * kind 'empty' (no hash), 'anchor' (a plain page anchor such as #how), 'tab' (only a tab=…), 'model', or 'bad'
 * (a link that could not be read: the default state plus the notice).
 */
export function decode(hash) {
    let h = String(hash ?? '').replace(/^#/, '');
    try { h = decodeURIComponent(h); } catch (_) { /* keep the raw text */ }
    if (!h.trim()) return { state: defaultsFromHash(), kind: 'empty', notice: null };
    if (!h.includes('=')) return { state: defaultsFromHash(), kind: 'anchor', notice: null };
    const p = splitHash(h);
    const bad = () => ({ state: defaultsFromHash(), kind: 'bad', notice: BAD_LINK_NOTE });
    if (p.has('v') && p.get('v') !== '1') return bad();
    if (!p.has('i')) {
        const s = defaultsFromHash();
        if (p.has('tab')) { s.tab = pick(p.get('tab'), TABS, 'components'); return { state: s, kind: 'tab', notice: null }; }
        if (p.has('v')) return { state: buildState(p, s.model.items), kind: 'model', notice: null };
        return bad();
    }
    try {
        return { state: buildState(p, decodeItems(p.get('i'))), kind: 'model', notice: null };
    } catch (_) {
        return bad();
    }
}
