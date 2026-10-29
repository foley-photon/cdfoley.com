// Element registry, defaults, validation, compilation, merging and descriptions (spec 2.6, 3.2, 3.3, 3.5.1-3.5.2).
// Items are plain JSON objects in SI units with a `t` key. Pure module.

import { GAS_IDS, gasState, T_REF } from './gas.js';
import { tubeAlpha, tubeAlphaInverse, rectAlpha, annulusAlpha, coneAlpha, elbowAlpha, molecularInfo } from './molecular.js';
import { cappedZ } from './flow.js';

const PI = Math.PI;
const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };
const N = (key, label, dim, opts = {}) => (opts.when ? { key, label, dim, kind: 'number', when: opts.when } : { key, label, dim, kind: 'number' });
const S = (key, options, label) => (label ? { key, kind: 'select', options: [...options], label } : { key, kind: 'select', options: [...options] });
const T = (key, label) => ({ key, kind: 'text', maxLength: 40, label });

export const ELEMENT_TYPES = deepFreeze({
    tube: { label: 'Round tube', token: 'tube',
        fields: [N('d', 'Inner diameter', 'length'), N('L', 'Length', 'length')], defaults: { d: 0.04, L: 0.2 } },
    orifice: { label: 'Thin orifice (plate)', token: 'orif',
        fields: [S('shape', ['circle', 'rect'], 'Shape'), N('d', 'Hole diameter', 'length', { when: { shape: 'circle' } }),
            N('w', 'Width', 'length', { when: { shape: 'rect' } }), N('h', 'Height', 'length', { when: { shape: 'rect' } })],
        defaults: { shape: 'circle', d: 0.01, w: 0.02, h: 0.002 } },
    slit: { label: 'Slit (narrow gap)', token: 'slit',
        fields: [N('h', 'Gap', 'length'), N('w', 'Width', 'length'), N('L', 'Depth along the flow', 'length')],
        defaults: { h: 0.0005, w: 0.02, L: 0.01 } },
    rect: { label: 'Rectangular duct', token: 'rect',
        fields: [N('a', 'Side a', 'length'), N('b', 'Side b', 'length'), N('L', 'Length', 'length')],
        defaults: { a: 0.01, b: 0.03, L: 0.1 } },
    annulus: { label: 'Annulus (tube with a rod)', token: 'ann',
        fields: [N('di', 'Rod diameter', 'length'), N('do', 'Bore diameter', 'length'), N('L', 'Length', 'length')],
        defaults: { di: 0.01, do: 0.04, L: 0.1 } },
    cone: { label: 'Cone or reducer', token: 'cone',
        fields: [N('d1', 'Inlet diameter', 'length'), N('d2', 'Outlet diameter', 'length'), N('L', 'Length', 'length')],
        defaults: { d1: 0.063, d2: 0.04, L: 0.05 } },
    elbow: { label: '90° elbow (mitered)', token: 'elbow',
        fields: [N('d', 'Inner diameter', 'length'), N('A', 'Inlet leg to bend axis', 'length'), N('B', 'Outlet leg to bend axis', 'length')],
        defaults: { d: 0.04, A: 0.05, B: 0.05 } },
    bbox: { label: 'Black box (datasheet conductance)', token: 'bbox',
        fields: [N('C', 'Molecular conductance', 'speed'), S('gasRef', GAS_IDS, 'Datasheet gas'), N('d', 'Flange bore', 'length'), T('label', 'Name')],
        defaults: { C: 0.1, gasRef: 'N2', d: 0.04, label: 'Valve' } },
    chamber: { label: 'Chamber (large volume)', token: 'chamber', fields: [], defaults: {} },
    parallel: { label: 'Parallel branches', token: 'par', fields: [],
        defaults: { branches: [[{ t: 'tube', d: 0.016, L: 0.1 }], [{ t: 'tube', d: 0.016, L: 0.2 }]] } },
    pump: { label: 'Pump', token: 'pump',
        fields: [N('S', 'Pumping speed', 'speed'), N('d', 'Inlet bore', 'length'), T('label', 'Name')],
        defaults: { S: 0.08, d: 0.063, label: 'Turbo' } },
});

const GEOMETRIC = new Set(['tube', 'orifice', 'slit', 'rect', 'annulus', 'cone', 'elbow', 'bbox']);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const num = (v) => String(Number(v.toPrecision(4)));
const FMT_LEN = (m) => num(m * 1000) + ' mm';
const FMT_SPEED = (s) => num(s * 1000) + ' L/s';
const clone = (v) => JSON.parse(JSON.stringify(v));

/** A fresh item of the given type with its defaults (deep copy). */
export function defaultItem(type) {
    if (!has(ELEMENT_TYPES, type)) throw new RangeError(`Unknown element type "${type}".`);
    return { t: type, ...clone(ELEMENT_TYPES[type].defaults) };
}

const fieldActive = (f, item) => !f.when || Object.entries(f.when).every(([k, v]) => item[k] === v);

// Errors of one item: [{ field, message }]; ctx = { G, where, isLast, fmtLen, fmtSpeed }.
function itemErrors(item, ctx = {}) {
    const out = [], add = (field, message) => out.push({ field, message });
    if (!item || typeof item !== 'object' || !has(ELEMENT_TYPES, item.t)) { add('t', 'Unknown element type.'); return out; }
    const def = ELEMENT_TYPES[item.t], G = ctx.G || null;
    const fmtLen = ctx.fmtLen || FMT_LEN, fmtSpeed = ctx.fmtSpeed || FMT_SPEED;
    if (ctx.where === 'branch' && !GEOMETRIC.has(item.t)) {
        add(null, 'Branches may not contain chambers, pumps or parallel groups.');
        return out;
    }
    for (const f of def.fields) {
        if (!fieldActive(f, item)) continue;
        const v = item[f.key];
        if (f.kind === 'number') {
            if (!(Number.isFinite(v) && v > 0)) add(f.key, `${f.label} must be a positive number.`);
        } else if (f.kind === 'select') {
            if (!f.options.includes(v)) add(f.key, `Choose one of: ${f.options.join(', ')}.`);
        } else if (f.kind === 'text') {
            if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > f.maxLength)) {
                add(f.key, `${f.label} must be text of at most ${f.maxLength} characters.`);
            }
        }
    }
    const ok = (k) => !out.some((e) => e.field === k);
    switch (item.t) {
        case 'annulus':
            if (ok('di') && ok('do') && !(item.di < item.do)) add('di', 'The rod must be thinner than the bore.');
            break;
        case 'cone':
            if (ok('d1') && ok('d2') && ok('L') && Math.atan(Math.abs(item.d2 - item.d1) / 2 / item.L) * 180 / PI > 89) {
                add('L', 'This is a flat step, not a cone: use a thin orifice or a chamber.');
            }
            break;
        case 'elbow':
            if (ok('d')) {
                const R = item.d / 2, msg = `Each elbow leg must be at least the bore radius (${fmtLen(R)}).`;
                if (ok('A') && item.A < R) add('A', msg);
                if (ok('B') && item.B < R) add('B', msg);
            }
            break;
        case 'bbox':
            if (ok('C') && ok('d') && ok('gasRef')) {
                const lim = PI * item.d * item.d / 4 * gasState(item.gasRef, T_REF).vbar / 4;
                if (!(item.C / lim < 0.999)) {
                    add('C', `The datasheet conductance is at or above the orifice limit for this bore (${fmtSpeed(lim)}); check the value or the bore.`);
                }
            }
            break;
        case 'parallel': {
            const br = item.branches;
            if (!Array.isArray(br) || br.length < 2 || br.length > 4) add('branches', 'A parallel group needs 2 to 4 branches.');
            else if (br.some((b) => !Array.isArray(b) || b.length < 1 || b.length > 6)) add('branches', 'Each branch needs 1 to 6 elements.');
            break;
        }
        case 'pump':
            if (ctx.isLast === false) add(null, 'The pump must be the last element.');
            if (G && ok('S') && ok('d')) {
                const lim = PI * item.d * item.d / 4 * G.vbar / 4;
                if (!(item.S < lim)) add('S', `Pumping speed exceeds the molecular-flow maximum for this inlet bore: S ≤ ${fmtSpeed(lim)}.`);
            }
            break;
        default:
            break;
    }
    return out;
}

/**
 * Field-specific problems of one item: [{ field, message }], [] when valid. field is null for item-level messages.
 * ctx = { G (GasState, optional), where: 'top' | 'branch', isLast, fmtLen?, fmtSpeed? }.
 */
export function validateItem(item, ctx) { return itemErrors(item, ctx || {}); }

const P_MIN = 1e-10, P_MAX = 1e7;
const pressureOk = (p) => Number.isFinite(p) && p >= P_MIN && p <= P_MAX;

/**
 * All problems of a model: [{ path, field, message }]. path is the item path ('3', '4.1.2'), 'gas', 'bc', 'range'
 * or '' for the model as a whole. Covers every item plus the structural rules of spec 3.5.1.
 */
export function validateModel(model) {
    const out = [], add = (path, field, message) => out.push({ path, field, message });
    if (!model || typeof model !== 'object' || !Array.isArray(model.items)) {
        add('', 'items', 'The model has no element list.');
        return out;
    }
    const items = model.items, bc = model.bc || {}, gas = model.gas || {};
    let G = null;
    try { G = gasState(gas.id, gas.T, gas.custom ?? null, model.Cd ?? null); } catch (err) { add('gas', err.field || 'id', err.message); }
    if (items.length > 40) add('', 'items', 'A line can have at most 40 elements.');
    const mode = bc.mode;
    if (mode !== 'pump' && mode !== 'dp') add('bc', 'mode', 'Choose "chamber to pump" or "between two pressures".');
    if (!pressureOk(bc.p0)) {
        add('bc', 'p0', `The ${mode === 'dp' ? 'inlet' : 'chamber'} pressure must be between 1e-10 Pa and 1e7 Pa.`);
    }
    if (mode === 'dp') {
        if (!pressureOk(bc.p1)) add('bc', 'p1', 'The outlet pressure must be between 1e-10 Pa and 1e7 Pa.');
        else if (pressureOk(bc.p0) && !(bc.p1 < bc.p0)) add('bc', 'p1', 'The outlet pressure must be below the inlet pressure.');
        if (!items.some((it) => it && GEOMETRIC.has(it.t) || (it && it.t === 'parallel'))) {
            add('', 'items', 'Add at least one element between the two pressures.');
        }
    }
    if (model.range !== undefined && model.range !== null) {
        const { pMin, pMax } = model.range;
        if (!(pressureOk(pMin) && pressureOk(pMax) && pMin < pMax)) {
            add('range', 'pMin', 'The plot range must run from a lower to a higher pressure, within 1e-10 Pa to 1e7 Pa.');
        }
    }
    const pumps = items.map((it, i) => (it && it.t === 'pump' ? i : -1)).filter((i) => i >= 0);
    if (mode === 'pump' && pumps.length === 0) add('', 'items', 'Add a pump as the last element.');
    if (mode === 'dp' && pumps.length) add(String(pumps[0]), null, 'A pump can only be used in chamber-to-pump mode.');
    items.forEach((it, i) => {
        for (const e of itemErrors(it, { G, where: 'top', isLast: i === items.length - 1 })) add(String(i), e.field, e.message);
        if (it && it.t === 'parallel' && Array.isArray(it.branches)) {
            it.branches.forEach((br, b) => {
                if (!Array.isArray(br)) return;
                br.forEach((sub, j) => {
                    for (const e of itemErrors(sub, { G, where: 'branch', isLast: j === br.length - 1 })) add(`${i}.${b}.${j}`, e.field, e.message);
                });
            });
        }
    });
    return out;
}

function base(item, extra) {
    return {
        t: item.t, label: typeof item.label === 'string' ? item.label : null, path: null,
        Ain: 0, Aout: 0, reIn: 0, reOut: 0, aperture: false, alpha: 1, Cmol: 0, kv: null, Cm: null, s: null,
        rref: 0, Dh: 0, Amin: 0, length: 0, accuracy: 0, mergedFrom: null, noEffect: false, flags: [], notes: [],
        apIn: null, apOut: null, zc: null, ...extra,
    };
}

// ---------------------------------------------------------------- coaxial openings
// Inlet and outlet openings of compiled elements, all centred on the line axis: { kind: 'disc', r },
// { kind: 'ring', ri, ro } or { kind: 'rect', a, b } (a <= b; every rectangle has its short side along the same
// transverse axis, as in the Monte Carlo chain). Used to find where consecutive openings only partly overlap.
const disc = (r) => ({ kind: 'disc', r });
const rectAp = (x, y) => ({ kind: 'rect', a: Math.min(x, y), b: Math.max(x, y) });
const apArea = (ap) => (ap.kind === 'disc' ? PI * ap.r * ap.r : ap.kind === 'ring' ? PI * (ap.ro * ap.ro - ap.ri * ap.ri) : ap.a * ap.b);
// area of { x^2 + y^2 <= r^2, 0 <= x <= X, 0 <= y <= Y }
function quarterDiscRect(r, X, Y) {
    X = Math.min(X, r); Y = Math.min(Y, r);
    if (!(X > 0) || !(Y > 0)) return 0;
    if (X * X + Y * Y <= r * r) return X * Y;
    const F = (x) => 0.5 * (x * Math.sqrt(Math.max(r * r - x * x, 0)) + r * r * Math.asin(Math.min(1, x / r)));
    const xc = Math.sqrt(Math.max(r * r - Y * Y, 0));
    return Y * xc + F(X) - F(xc);
}

/** Area (m²) of the overlap of two coaxial openings (disc, ring or rect; null means no restriction). */
export function apertureOverlap(p, q) {
    if (!p && !q) return Infinity;
    if (!q) return apArea(p);
    if (!p) return apArea(q);
    if (p.kind === 'rect' && q.kind !== 'rect') [p, q] = [q, p];
    const ring = (x) => (x.kind === 'disc' ? { ri: 0, ro: x.r } : { ri: x.ri, ro: x.ro });
    if (p.kind !== 'rect' && q.kind !== 'rect') {
        const a = ring(p), b = ring(q), ro = Math.min(a.ro, b.ro), ri = Math.max(a.ri, b.ri);
        return ro > ri ? PI * (ro * ro - ri * ri) : 0;
    }
    if (p.kind === 'rect') return Math.min(p.a, q.a) * Math.min(p.b, q.b);
    const a = ring(p), dr = (r) => 4 * quarterDiscRect(r, q.a / 2, q.b / 2);
    return dr(a.ro) - (a.ri > 0 ? dr(a.ri) : 0);
}

/** Equivalent radius 2A/P of the overlap of two openings (an estimate where the overlap is not a disc, ring or rectangle). */
export function apertureOverlapRadius(p, q, A) {
    const ring = (x) => (x.kind === 'disc' ? { ri: 0, ro: x.r } : { ri: x.ri, ro: x.ro });
    if (p.kind !== 'rect' && q.kind !== 'rect') {
        const a = ring(p), b = ring(q), ro = Math.min(a.ro, b.ro), ri = Math.max(a.ri, b.ri);
        return ro - ri;
    }
    if (p.kind === 'rect' && q.kind === 'rect') { const a = Math.min(p.a, q.a), b = Math.min(p.b, q.b); return a * b / (a + b); }
    const rc = p.kind === 'rect' ? p : q, rd = p.kind === 'rect' ? q : p, w = ring(rd);
    return Math.min(rc.a * rc.b / (rc.a + rc.b), w.ro - w.ri, Math.sqrt(A / PI));
}

/** Compiles one geometric item (spec 2.6 Compiled; 3.2 and 3.3). Throws RangeError for invalid or non-geometric items. */
export function compileItem(item, G) {
    if (!item || !GEOMETRIC.has(item.t)) throw new RangeError('Only tubes, orifices, slits, ducts, annuli, cones, elbows and black boxes can be compiled.');
    const errs = itemErrors(item, { G });
    if (errs.length) throw new RangeError(errs[0].message);
    let e, slot = null;
    switch (item.t) {
        case 'tube': {
            const R = item.d / 2, A = PI * R * R;
            e = base(item, { Ain: A, Aout: A, reIn: R, reOut: R, alpha: tubeAlpha(item.L / item.d),
                kv: PI * R ** 4 / (8 * G.eta * item.L), rref: R, Dh: item.d, Amin: A, length: item.L, apIn: disc(R), apOut: disc(R) });
            break;
        }
        case 'orifice': {
            const rect = item.shape === 'rect';
            const A = rect ? item.w * item.h : PI * item.d * item.d / 4, re = rect ? item.w * item.h / (item.w + item.h) : item.d / 2;
            const ap = rect ? rectAp(item.w, item.h) : disc(item.d / 2);
            e = base(item, { Ain: A, Aout: A, reIn: re, reOut: re, aperture: true, alpha: 1, rref: re, Dh: 2 * re, Amin: A, length: 0, apIn: ap, apOut: ap });
            break;
        }
        case 'slit': case 'rect': {
            let a = item.t === 'slit' ? item.h : item.a, b = item.t === 'slit' ? item.w : item.b;
            if (a > b) [a, b] = [b, a];
            const A = a * b, re = a * b / (a + b);
            let sum = 0;
            for (let n = 1; n <= 99; n += 2) sum += Math.tanh(n * PI * b / (2 * a)) / n ** 5;
            const kv = b * a ** 3 / (12 * G.eta * item.L) * (1 - 192 * a / (PI ** 5 * b) * sum);
            e = base(item, { Ain: A, Aout: A, reIn: re, reOut: re, alpha: rectAlpha(a, b, item.L), kv, rref: re, Dh: 2 * re, Amin: A, length: item.L,
                apIn: rectAp(a, b), apOut: rectAp(a, b) });
            slot = { w: b, h: a, L: item.L };
            break;
        }
        case 'annulus': {
            const Ri = item.di / 2, Ro = item.do / 2, k = Ri / Ro, A = PI * (Ro * Ro - Ri * Ri), re = Ro - Ri;
            const kv = PI * Ro ** 4 / (8 * G.eta * item.L) * (1 - k ** 4 - (1 - k * k) ** 2 / Math.log(1 / k));
            const ap = { kind: 'ring', ri: Ri, ro: Ro };
            e = base(item, { Ain: A, Aout: A, reIn: re, reOut: re, alpha: annulusAlpha(Ri, Ro, item.L), kv, rref: re, Dh: 2 * re, Amin: A, length: item.L, apIn: ap, apOut: ap });
            slot = { w: PI * (Ro + Ri), h: Ro - Ri, L: item.L };
            break;
        }
        case 'cone': {
            const R1 = item.d1 / 2, R2 = item.d2 / 2, L = item.L, k = (R2 - R1) / L, flat = Math.abs(R2 - R1) <= 1e-12 * Math.max(R1, R2);
            const I4 = flat ? L / R1 ** 4 : (1 / (3 * k)) * (1 / R1 ** 3 - 1 / R2 ** 3);
            const I3 = flat ? L / R1 ** 3 : (1 / (2 * k)) * (1 / R1 ** 2 - 1 / R2 ** 2);
            const Rs = Math.min(R1, R2);
            e = base(item, { Ain: PI * R1 * R1, Aout: PI * R2 * R2, reIn: R1, reOut: R2, alpha: coneAlpha(R1, R2, L),
                kv: PI / (8 * G.eta * I4), rref: Math.cbrt(L / I3), Dh: 2 * Rs, Amin: PI * Rs * Rs, length: L, apIn: disc(R1), apOut: disc(R2) });
            break;
        }
        case 'elbow': {
            const R = item.d / 2, A = PI * R * R;
            e = base(item, { Ain: A, Aout: A, reIn: R, reOut: R, alpha: elbowAlpha(R, item.A, item.B),
                kv: PI * R ** 4 / (8 * G.eta * (item.A + item.B)), rref: R, Dh: item.d, Amin: A, length: item.A + item.B, apIn: disc(R), apOut: disc(R) });
            break;
        }
        case 'bbox': {
            const R = item.d / 2, A = PI * R * R, ref = gasState(item.gasRef, T_REF);
            const C = item.C * G.vbar / ref.vbar, aEq = C / (A * G.vbar / 4);
            const Leq = tubeAlphaInverse(aEq) * item.d;
            e = base(item, { Ain: A, Aout: A, reIn: R, reOut: R, alpha: aEq, kv: PI * R ** 4 / (8 * G.eta * Leq),
                rref: R, Dh: item.d, Amin: A, length: Leq, Leq, apIn: disc(R), apOut: disc(R) });
            e.flags.push('viscous-estimate');
            e.notes.push('equivalent-tube');
            break;
        }
        default:
            throw new RangeError('Unknown element type.');
    }
    const info = molecularInfo(item.t, item);
    e.accuracy = info.accuracy;
    if (info.extrapolated) e.flags.push('extrapolated');
    e.Cmol = e.Ain * G.vbar / 4 * e.alpha;
    if (!e.aperture) {
        const C0 = e.Ain * G.vbar / 4;
        e.Cm = Math.min(C0 * e.alpha / (1 - e.alpha), 1e9 * C0);
        e.s = G.eta * G.vm / e.rref;
        // slot-like sections (spec v2.2, 3.3.2): the rarefied part of the core flow is capped by the plane channel
        if (slot) e.zc = cappedZ(slot.w * slot.h * slot.h * G.vm / (2 * slot.L) / e.Cm, slot.h / e.rref);
    }
    return e;
}

const same = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));

/**
 * Merges consecutive items of identical cross-section (spec 3.5.2): tube + tube, tube + elbow (leg A grows),
 * elbow + tube (leg B grows), rect + rect, slit + slit, annulus + annulus. Returns [{ item, paths }], paths being
 * the indices of the merged items. Two elbows in a row are not merged.
 */
export function mergeItems(items) {
    const out = [];
    items.forEach((it, i) => {
        const p = out.length ? out[out.length - 1] : null, q = p && p.item;
        let m = null;
        if (q && it.t === 'tube' && q.t === 'tube' && same(q.d, it.d)) m = { ...q, L: q.L + it.L };
        else if (q && it.t === 'elbow' && q.t === 'tube' && same(q.d, it.d)) m = { ...it, A: it.A + q.L };
        else if (q && it.t === 'tube' && q.t === 'elbow' && same(q.d, it.d)) m = { ...q, B: q.B + it.L };
        else if (q && it.t === q.t && (it.t === 'rect' || it.t === 'slit')) {
            const [k1, k2] = it.t === 'rect' ? ['a', 'b'] : ['h', 'w'];
            if (same(Math.min(q[k1], q[k2]), Math.min(it[k1], it[k2])) && same(Math.max(q[k1], q[k2]), Math.max(it[k1], it[k2]))) m = { ...q, L: q.L + it.L };
        } else if (q && it.t === 'annulus' && q.t === 'annulus' && same(q.di, it.di) && same(q.do, it.do)) m = { ...q, L: q.L + it.L };
        if (m) { p.item = m; p.paths.push(i); } else out.push({ item: it, paths: [i] });
    });
    return out;
}

/** Short text such as "Tube Ø40 × 200 mm" or "Elbow Ø100, legs 300/100 mm". fmtLen(m) and fmtSpeed(m^3/s) give strings with units. */
export function describeItem(item, fmtLen, fmtSpeed = FMT_SPEED) {
    fmtLen = fmtLen || FMT_LEN;
    const split = (s) => { const m = /^(.*?)\s+(\S+)$/.exec(s); return m ? [m[1], m[2]] : [s, '']; };
    const L = (...vals) => {
        const f = vals.map((v) => split(fmtLen(v)));
        if (f.every((x) => x[1] === f[0][1])) return { n: f.map((x) => x[0]), u: f[0][1] ? ' ' + f[0][1] : '' };
        return { n: f.map((x) => (x[1] ? x[0] + ' ' + x[1] : x[0])), u: '' };
    };
    const name = (s, fallback) => (typeof s === 'string' && s ? s.replace(/_/g, ' ') : fallback);
    switch (item && item.t) {
        case 'tube': { const { n, u } = L(item.d, item.L); return `Tube Ø${n[0]} × ${n[1]}${u}`; }
        case 'orifice':
            if (item.shape === 'rect') { const { n, u } = L(item.w, item.h); return `Orifice ${n[0]} × ${n[1]}${u}`; }
            { const { n, u } = L(item.d); return `Orifice Ø${n[0]}${u}`; }
        case 'slit': { const { n, u } = L(item.h, item.w, item.L); return `Slit ${n[0]} × ${n[1]}, depth ${n[2]}${u}`; }
        case 'rect': { const { n, u } = L(item.a, item.b, item.L); return `Duct ${n[0]} × ${n[1]} × ${n[2]}${u}`; }
        case 'annulus': { const { n, u } = L(item.do, item.di, item.L); return `Annulus Ø${n[0]}/Ø${n[1]} × ${n[2]}${u}`; }
        case 'cone': { const { n, u } = L(item.d1, item.d2, item.L); return `Cone Ø${n[0]} → Ø${n[1]} × ${n[2]}${u}`; }
        case 'elbow': { const { n, u } = L(item.d, item.A, item.B); return `Elbow Ø${n[0]}, legs ${n[1]}/${n[2]}${u}`; }
        case 'bbox': { const { n, u } = L(item.d); return `${name(item.label, 'Black box')}: ${fmtSpeed(item.C)} (${item.gasRef}), Ø${n[0]}${u}`; }
        case 'chamber': return 'Chamber';
        case 'parallel': return `Parallel group, ${Array.isArray(item.branches) ? item.branches.length : 0} branches`;
        case 'pump': { const { n, u } = L(item.d); return `${name(item.label, 'Pump')}: ${fmtSpeed(item.S)}, inlet Ø${n[0]}${u}`; }
        default: return 'Unknown element';
    }
}
