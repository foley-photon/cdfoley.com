/* ==========================================================================
   Ion optics engine: hash.js
   Canonical JSON and the three cache keys that decide staleness (spec §2.2.5):
   geomKey (geometry, grid, edges, solver settings, the charge density with
   the values of the parameters it uses) → solution; fieldKey
   (+ voltages, waveforms, mesh settings, magnets, ideal fields, field
   interpolation) → field and run; runKey (+ sources, recording, tracer,
   domain.beyond) → run. Cosmetic fields (names, colours, ids of shapes and
   sources, view, notes) never enter a key.

   Hash: two 32-bit lanes over UTF-16 code units, an FNV-1a lane (Fowler, Noll
   & Vo, IETF draft-eastlake-fnv) and a multiply-xorshift lane with the
   MurmurHash2 multiplier, cross-mixed and finished with the MurmurHash3
   fmix32 avalanche (Appleby, public domain, 2011). Not cryptographic.
   ========================================================================== */
import { ENGINE_VERSION } from './version.js';
import { parseExpr } from './expr.js';

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);
}

function primitiveJSON(v) {
    if (v === null) return 'null';
    switch (typeof v) {
        case 'number': return Number.isFinite(v) ? JSON.stringify(v) : 'null';
        case 'string': return JSON.stringify(v);
        case 'boolean': return v ? 'true' : 'false';
        case 'bigint': return JSON.stringify(String(v));
        default: return undefined;   // undefined, functions, symbols
    }
}

function compact(v) {
    const p = primitiveJSON(v);
    if (p !== undefined) return p;
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return undefined;
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        const parts = [];
        for (let i = 0; i < v.length; i++) { const s = compact(v[i]); parts.push(s === undefined ? 'null' : s); }
        return '[' + parts.join(',') + ']';
    }
    if (typeof v.toJSON === 'function') return compact(v.toJSON());
    const keys = Object.keys(v).sort();
    const parts = [];
    for (const k of keys) { const s = compact(v[k]); if (s !== undefined) parts.push(JSON.stringify(k) + ':' + s); }
    return '{' + parts.join(',') + '}';
}

function pretty(v, ind, depth) {
    const p = primitiveJSON(v);
    if (p !== undefined) return p;
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return undefined;
    const pad = ' '.repeat(ind * (depth + 1)), end = ' '.repeat(ind * depth);
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        if (v.length === 0) return '[]';
        const items = [];
        let flat = true;
        for (let i = 0; i < v.length; i++) {
            const x = v[i];
            const isNumPair = Array.isArray(x) && x.length <= 4 && x.every((y) => primitiveJSON(y) !== undefined);
            if (!(primitiveJSON(x) !== undefined || isNumPair)) flat = false;
            const s = isNumPair ? compact(x).replace(/,/g, ', ') : pretty(x, ind, depth + 1);
            items.push(s === undefined ? 'null' : s);
        }
        const one = '[' + items.join(', ') + ']';
        if (flat && one.length + ind * depth <= 100) return one;
        return '[\n' + items.map((s) => pad + s).join(',\n') + '\n' + end + ']';
    }
    if (typeof v.toJSON === 'function') return pretty(v.toJSON(), ind, depth);
    const keys = Object.keys(v).sort();
    const parts = [];
    for (const k of keys) { const s = pretty(v[k], ind, depth + 1); if (s !== undefined) parts.push(pad + JSON.stringify(k) + ': ' + s); }
    if (!parts.length) return '{}';
    return '{\n' + parts.join(',\n') + '\n' + end + '}';
}

/**
 * Canonical JSON: keys sorted, numbers in shortest round-trip form, non-finite numbers as null, no whitespace
 * (or, with `indent` > 0, a stable indented form with short arrays on one line; used for project files).
 * @param {*} v @param {number} [indent]
 * @returns {string}
 */
export function canonicalJSON(v, indent = 0) {
    const s = indent > 0 ? pretty(v, indent | 0, 0) : compact(v);
    return s === undefined ? 'null' : s;
}

function fmix32(h) {
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}
const hex8 = (u) => (u >>> 0).toString(16).padStart(8, '0');

/**
 * 64-bit hash of a string as 16 hex characters (two 32-bit lanes).
 * @param {string} str
 * @returns {string}
 */
export function hash64(str) {
    const s = String(str);
    let a = 0x811c9dc5 | 0, b = 0x9747b28c | 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193);
        b = Math.imul(b ^ c, 0x5bd1e995);
        b ^= b >>> 15;
    }
    a ^= s.length;
    b ^= Math.imul(s.length, 0x27d4eb2d);
    const A = fmix32(a ^ Math.imul(b ^ (b >>> 16), 0x9e3779b1));
    const Bv = fmix32(b ^ Math.imul(A ^ (A >>> 15), 0x85ebca6b));
    return hex8(A) + hex8(Bv);
}

// ---------------------------------------------------------------- key contents

const SHAPE_PARAMS = {
    box: ['x0', 'x1', 'y0', 'y1'], tube: ['x0', 'x1', 'rIn', 'rOut'], plate: ['x', 't', 'rHole', 'rOut'], disc: ['x', 't', 'r'],
    circle: ['cx', 'cy', 'r'], annulus: ['cx', 'cy', 'rIn', 'rOut', 'a0', 'a1'], polygon: ['points'], polyline: ['points'],
    quadric: ['A', 'B', 'C', 'cx', 'cy', 'clip'],
};

function pick(o, keys) {
    const out = {};
    if (!o) return out;
    for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
    return out;
}
function omit(o, keys) {
    const out = {};
    if (!o) return out;
    for (const k of Object.keys(o)) if (!keys.includes(k)) out[k] = o[k];
    return out;
}

function edgeContent(e) {
    if (!e) return null;
    if (e.bc === 'dirichlet') return { bc: 'dirichlet', e: e.electrodeIndex };
    if (e.bc === 'profile') {
        return { bc: 'profile', s: (e.segments || []).map((s) => (s.rampIndex ? [s.from, s.to, s.rampIndex] : [s.from, s.to, s.electrodeIndex])) };
    }
    return { bc: e.bc };
}

/**
 * Key content of a charge-density expression: the text, plus the values of the parameters it uses (the Poisson basis
 * changes with them although the text does not). Without parameters the text alone, so such keys are unchanged.
 */
function chargeContent(src, paramValues) {
    if (typeof src !== 'string' || !src.trim()) return null;
    const p = {};
    try {
        for (const name of parseExpr(src.trim()).deps) {
            if (paramValues && Object.prototype.hasOwnProperty.call(paramValues, name)) p[name] = paramValues[name];
        }
    } catch (e) { /* the schema reports a bad expression; the text alone keys it */ }
    return Object.keys(p).length ? { e: src, p } : src;
}

/** The data that determines the solved basis fields. */
export function geomContent(resolved) {
    const r = resolved || {};
    const d = r.domain || {};
    const ed = d.edges || {};
    const sol = r.solver || {};
    return {
        v: ENGINE_VERSION,
        d: { type: d.type, h: d.h, x: d.x, y: d.y, nx: d.nx, ny: d.ny, mirror: d.mirror, antimirror: d.antimirror || null, charge: chargeContent(d.charge, r.paramValues),
            edges: { xmin: edgeContent(ed.xmin), xmax: edgeContent(ed.xmax), ymin: edgeContent(ed.ymin), ymax: edgeContent(ed.ymax) } },
        e: (r.electrodes || []).map((e) => e.id),
        s: (r.shapes || []).map((s) => ({ t: s.type, e: s.electrodeIndex, x: s.transform || null, p: pick(s, SHAPE_PARAMS[s.type] || []) })),
        solver: pick(sol, ['boundary', 'method', 'tol', 'maxCycles', 'maxIterations', 'maxSweeps']),
    };
}

/** The data, beyond the geometry, that determines the fields. */
export function fieldContent(resolved) {
    const r = resolved || {};
    return {
        e: (r.electrodes || []).map((e) => [e.kind || 'solid', e.kind === 'grid' ? e.transmission : null, e.dc || 0,
            (e.terms || []).map((t) => omit(t, ['label', 'name', 'note']))]),
        m: (r.magnets || []).map((m) => omit(m, ['id', 'name', 'enabled', 'srcIndex', 'color', 'note'])),
        f: (r.idealFields || []).map((f) => omit(f, ['id', 'name', 'enabled', 'srcIndex', 'note'])),
        i: (r.tracer && r.tracer.fieldInterp) || 'cubic',
    };
}

/** The data, beyond the fields, that determines a run. */
export function runContent(resolved) {
    const r = resolved || {};
    const rec = r.recording || {};
    return {
        s: (r.sources || []).map((s) => omit(s, ['id', 'name', 'color', 'srcIndex', 'note'])),
        p: (rec.planes || []).map((p) => omit(p, ['id', 'name', 'note'])),
        tj: rec.trajectories || null,
        tm: rec.timeMarkers || null,
        t: r.tracer || null,
        b: (r.domain && r.domain.beyond) || null,
        pb: r.limits ? r.limits.pointBudget : null,
    };
}

/**
 * Key of the solution (basis fields): domain type, cell, extents, edges incl. profiles, mirrors, electrode ids in
 * order, shapes, solver settings and ENGINE_VERSION.
 * @param {object} resolved
 * @returns {string}
 */
export function geomKey(resolved) {
    return 'g' + hash64(canonicalJSON(geomContent(resolved)));
}

/**
 * Key of the field: geomKey + electrode kinds, transmissions, DC voltages, waveform terms, magnets, ideal fields and
 * the field interpolation.
 * @param {object} resolved @param {string} [gk] geomKey (computed if omitted)
 * @returns {string}
 */
export function fieldKey(resolved, gk = geomKey(resolved)) {
    return 'f' + hash64(gk + '|' + canonicalJSON(fieldContent(resolved)));
}

/**
 * Key of a run: fieldKey + sources, recording, tracer settings and domain.beyond.
 * @param {object} resolved @param {string} [fk] fieldKey (computed if omitted)
 * @returns {string}
 */
export function runKey(resolved, fk = fieldKey(resolved)) {
    return 'r' + hash64(fk + '|' + canonicalJSON(runContent(resolved)));
}

/**
 * All three keys of a resolved project.
 * @param {object} resolved
 * @returns {{ geomKey: string, fieldKey: string, runKey: string }}
 */
export function projectKeys(resolved) {
    const g = geomKey(resolved);
    const f = fieldKey(resolved, g);
    return { geomKey: g, fieldKey: f, runKey: runKey(resolved, f) };
}
