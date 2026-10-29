/* ==========================================================================
   Ion optics UI: tools.js
   Canvas tools (spec §4.5): select and edit (handles, move, Alt-click to
   insert a polygon vertex, Delete removes it), pan, shape drawing (box, tube,
   plate, disc, circle, annulus, polygon, zero-thickness line, quadric by
   form), sources, test planes, measure and probe. Points snap to vertices,
   edges, the axis and mirror lines, grid nodes or a zoom-scaled decimal grid
   (Alt disables snapping). While a shape is dragged only a ghost outline is
   redrawn (one-shape geometry compiled per frame); the edit is committed as
   one undo step on release. Parameters given as expressions keep their
   expressions: a drag adds a numeric offset (or moves the shape's transform)
   instead of replacing them.
   The geometry helpers at the top are pure and tested in Node.
   ========================================================================== */
import { compileGeometry } from '../engine/geometry.js';
import { getPath, setPath, locate, createCommitter, nextId, parseScalar } from './forms.js';
import { formatPretty } from './units.js';
import { tidy, h as el, clamp } from './dom.js';

// ---------------------------------------------------------------- tool table
/** Tools in view-bar order. `editing` tools are hidden in phone viewer mode. */
export const TOOL_DEFS = Object.freeze([
    { id: 'select', title: 'Select and edit', icon: 'select', key: 'V' },
    { id: 'pan', title: 'Pan', icon: 'pan', key: 'H' },
    { id: 'box', title: 'Box', icon: 'box', key: 'B', editing: true, shape: 'box' },
    { id: 'tube', title: 'Tube', icon: 'tube', key: 'T', editing: true, shape: 'tube' },
    { id: 'plate', title: 'Aperture plate (press at x, drag to the outer radius; Alt-drag sets the hole)', icon: 'plate', editing: true, shape: 'plate' },
    { id: 'disc', title: 'Disc', icon: 'disc', editing: true, shape: 'disc' },
    { id: 'circle', title: 'Circle', icon: 'circle', key: 'C', editing: true, shape: 'circle' },
    { id: 'annulus', title: 'Annulus or sector', icon: 'annulus', editing: true, shape: 'annulus' },
    { id: 'polygon', title: 'Polygon (click vertices; Enter or double-click closes)', icon: 'polygon', key: 'P', editing: true, shape: 'polygon' },
    { id: 'line', title: 'Line: zero-thickness sheet or mesh (click points; Enter finishes)', icon: 'line', editing: true, shape: 'polyline' },
    { id: 'quadric', title: 'Quadric (form)', icon: 'quadric', editing: true, shape: 'quadric' },
    { id: 'source', title: 'Particle source (click: point, drag: line)', icon: 'source', editing: true },
    { id: 'plane', title: 'Test plane (drag sets the direction or a segment)', icon: 'plane', editing: true },
    { id: 'measure', title: 'Measure', icon: 'measure', key: 'M' },
    { id: 'probe', title: 'Probe line for the Profile tab', icon: 'probe', key: 'Shift+P' },
]);

// ---------------------------------------------------------------- pure helpers
const DEG = Math.PI / 180;

/** Transform record of a shape (mirror → rotate → translate, about `about`), or null for the identity. */
export function makeTransform(tr) {
    if (!tr || typeof tr !== 'object') return null;
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const tx = n(tr.translate && tr.translate[0]), ty = n(tr.translate && tr.translate[1]);
    const rot = n(tr.rotate), ax = n(tr.about && tr.about[0]), ay = n(tr.about && tr.about[1]);
    const m = tr.mirror || 'none';
    const sx = m === 'x' || m === 'xy' ? -1 : 1, sy = m === 'y' || m === 'xy' ? -1 : 1;
    if (tx === 0 && ty === 0 && rot === 0 && sx === 1 && sy === 1) return null;
    return { tx, ty, ax, ay, sx, sy, c: Math.cos(rot * DEG), s: Math.sin(rot * DEG) };
}
/** Local shape point → world point. */
export function toWorld(xf, x, y) {
    if (!xf) return [x, y];
    const u = xf.sx * (x - xf.ax), v = xf.sy * (y - xf.ay);
    return [xf.ax + xf.c * u - xf.s * v + xf.tx, xf.ay + xf.s * u + xf.c * v + xf.ty];
}
/** World point → local shape point. */
export function toLocal(xf, x, y) {
    if (!xf) return [x, y];
    const wx = x - xf.tx - xf.ax, wy = y - xf.ay - xf.ty;
    const u = xf.c * wx + xf.s * wy, v = -xf.s * wx + xf.c * wy;
    return [xf.ax + xf.sx * u, xf.ay + xf.sy * v];
}

/**
 * Adds a numeric offset to an expression, merging it with a trailing "± number" term when there is one
 * ("D/2+1" + 0.5 → "D/2+1.5"), so dragging a parametric shape keeps its expression.
 * @param {string} expr @param {number} delta
 * @param {(src: string) => any} [check] parser that throws on an invalid base expression
 */
export function offsetExpr(expr, delta, check = null) {
    const d = tidy(delta);
    if (!d) return expr;
    const m = /^(.*\S)\s*([+-])\s*(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*$/.exec(expr);
    if (m && balanced(m[1]) && !/[*/^(,+-]$/.test(m[1].trim())) {
        let ok = true;
        if (check) { try { check(m[1]); } catch (e) { ok = false; } }
        if (ok) {
            const c = tidy((m[2] === '-' ? -1 : 1) * parseFloat(m[3]) + d);
            if (c === 0) return m[1].trim();
            return `${m[1].trim()}${c < 0 ? '-' : '+'}${fmtNum(Math.abs(c))}`;
        }
    }
    return `${expr}${d < 0 ? '-' : '+'}${fmtNum(Math.abs(d))}`;
}
function balanced(s) {
    let k = 0;
    for (const ch of s) { if (ch === '(') k++; else if (ch === ')') { k--; if (k < 0) return false; } }
    return k === 0;
}
function fmtNum(v) { return String(tidy(v)); }

/**
 * New project value for a parameter that moves from `oldNum` to `newNum` (resolved numbers):
 * numbers are replaced, expressions get an offset.
 */
export function shiftedValue(projValue, oldNum, newNum, check = null) {
    if (typeof projValue === 'string') return offsetExpr(projValue, newNum - oldNum, check);
    return tidy(newNum);
}

/**
 * Handles of a resolved (numeric) shape in local coordinates: [{ id, x, y, cursor }].
 * Polygons and lines get one handle per vertex ('v<i>').
 */
export function shapeHandles(s, { cyl = false } = {}) {
    const H = [];
    const add = (id, x, y, cursor = 'pointer') => H.push({ id, x, y, cursor });
    switch (s.type) {
        case 'box': {
            const { x0, x1, y0, y1 } = s, xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
            add('nw', x0, y1, 'nwse-resize'); add('n', xm, y1, 'ns-resize'); add('ne', x1, y1, 'nesw-resize'); add('e', x1, ym, 'ew-resize');
            add('se', x1, y0, 'nwse-resize'); add('s', xm, y0, 'ns-resize'); add('sw', x0, y0, 'nesw-resize'); add('w', x0, ym, 'ew-resize');
            break;
        }
        case 'tube': {
            const { x0, x1, rIn, rOut } = s, xm = (x0 + x1) / 2, rm = (rIn + rOut) / 2;
            add('nw', x0, rOut, 'nwse-resize'); add('n', xm, rOut, 'ns-resize'); add('ne', x1, rOut, 'nesw-resize'); add('e', x1, rm, 'ew-resize');
            add('se', x1, rIn, 'nwse-resize'); add('s', xm, rIn, 'ns-resize'); add('sw', x0, rIn, 'nesw-resize'); add('w', x0, rm, 'ew-resize');
            break;
        }
        case 'plate': {
            const { x, t, rHole, rOut } = s, rm = (rHole + rOut) / 2;
            add('nw', x - t / 2, rOut, 'nwse-resize'); add('n', x, rOut, 'ns-resize'); add('ne', x + t / 2, rOut, 'nesw-resize'); add('e', x + t / 2, rm, 'ew-resize');
            add('se', x + t / 2, rHole, 'nwse-resize'); add('s', x, rHole, 'ns-resize'); add('sw', x - t / 2, rHole, 'nesw-resize'); add('w', x - t / 2, rm, 'ew-resize');
            break;
        }
        case 'disc': {
            const { x, t, r } = s;
            add('nw', x - t / 2, r, 'nwse-resize'); add('n', x, r, 'ns-resize'); add('ne', x + t / 2, r, 'nesw-resize');
            add('e', x + t / 2, r / 2, 'ew-resize'); add('w', x - t / 2, r / 2, 'ew-resize');
            break;
        }
        case 'circle': {
            const { cx, cy, r } = s;
            add('r0', cx + r, cy, 'ew-resize'); add('r1', cx, cy + r, 'ns-resize'); add('r2', cx - r, cy, 'ew-resize');
            if (!(cyl && cy - r < 0)) add('r3', cx, cy - r, 'ns-resize');
            break;
        }
        case 'annulus': {
            const { cx, cy, rIn, rOut } = s;
            const a0 = s.a0 === undefined ? 0 : s.a0, a1 = s.a1 === undefined ? 360 : s.a1;
            const am = (a1 - a0 >= 360 - 1e-9 ? a0 + 45 : (a0 + a1) / 2) * DEG, rm = (rIn + rOut) / 2;
            add('rOut', cx + rOut * Math.cos(am), cy + rOut * Math.sin(am), 'move');
            add('rIn', cx + rIn * Math.cos(am), cy + rIn * Math.sin(am), 'move');
            add('a0', cx + rm * Math.cos(a0 * DEG), cy + rm * Math.sin(a0 * DEG), 'crosshair');
            if (a1 - a0 < 360 - 1e-9) add('a1', cx + rm * Math.cos(a1 * DEG), cy + rm * Math.sin(a1 * DEG), 'crosshair');
            break;
        }
        case 'polygon': case 'polyline':
            (s.points || []).forEach((p, i) => add('v' + i, p[0], p[1], 'move'));
            break;
        case 'quadric': {
            const c = s.clip || [0, 0, 0, 0];
            add('c', s.cx, s.cy, 'move');
            add('k0', c[0], c[2], 'nesw-resize'); add('k1', c[1], c[2], 'nwse-resize'); add('k2', c[1], c[3], 'nesw-resize'); add('k3', c[0], c[3], 'nwse-resize');
            break;
        }
        default: break;
    }
    return H;
}

/**
 * Parameter edits for dragging handle `id` of numeric shape `s` to local point (x, y): a Map path → new value.
 * Sizes are kept positive (minimum `minSize`) and ordered (start < end, inner < outer).
 */
export function handleEdits(s, id, x, y, { cyl = false, mirrorY = false, minSize = 1e-6 } = {}) {
    const E = new Map();
    const r = (cyl || mirrorY || s.type === 'tube' || s.type === 'plate' || s.type === 'disc') ? Math.abs(y) : y;
    switch (s.type) {
        case 'box':
            if (id.includes('w')) E.set('x0', Math.min(x, s.x1 - minSize));
            if (id.includes('e')) E.set('x1', Math.max(x, s.x0 + minSize));
            if (id.includes('s')) E.set('y0', Math.min(y, s.y1 - minSize));
            if (id.includes('n')) E.set('y1', Math.max(y, s.y0 + minSize));
            break;
        case 'tube':
            if (id.includes('w')) E.set('x0', Math.min(x, s.x1 - minSize));
            if (id.includes('e')) E.set('x1', Math.max(x, s.x0 + minSize));
            if (id.includes('s')) E.set('rIn', clamp(r, 0, s.rOut - minSize));
            if (id.includes('n')) E.set('rOut', Math.max(r, s.rIn + minSize));
            break;
        case 'plate':
            if (id.includes('w') || id.includes('e')) E.set('t', Math.max(2 * Math.abs(x - s.x), minSize));
            if (id.includes('s')) E.set('rHole', clamp(r, 0, s.rOut - minSize));
            if (id.includes('n')) E.set('rOut', Math.max(r, s.rHole + minSize));
            break;
        case 'disc':
            if (id.includes('w') || id.includes('e')) E.set('t', Math.max(2 * Math.abs(x - s.x), minSize));
            if (id.includes('n')) E.set('r', Math.max(r, minSize));
            break;
        case 'circle': E.set('r', Math.max(Math.hypot(x - s.cx, y - s.cy), minSize)); break;
        case 'annulus': {
            const d = Math.hypot(x - s.cx, y - s.cy);
            if (id === 'rOut') E.set('rOut', Math.max(d, s.rIn + minSize));
            else if (id === 'rIn') E.set('rIn', clamp(d, 0, s.rOut - minSize));
            else {
                let a = Math.atan2(y - s.cy, x - s.cx) / DEG;
                const a0 = s.a0 === undefined ? 0 : s.a0, a1 = s.a1 === undefined ? 360 : s.a1;
                if (id === 'a0') { while (a > a1) a -= 360; while (a <= a1 - 360) a += 360; E.set('a0', a); }
                else { while (a < a0) a += 360; while (a >= a0 + 360) a -= 360; E.set('a1', a); }
            }
            break;
        }
        case 'polygon': case 'polyline': {
            const i = Number(id.slice(1));
            if (Number.isInteger(i) && s.points && s.points[i]) { E.set(`points[${i}][0]`, x); E.set(`points[${i}][1]`, y); }
            break;
        }
        case 'quadric': {
            if (id === 'c') { E.set('cx', x); E.set('cy', y); break; }
            const c = s.clip || [0, 0, 0, 0];
            const k = Number(id.slice(1));
            const ix = k === 0 || k === 3 ? 0 : 1, iy = k === 0 || k === 1 ? 2 : 3;
            E.set(`clip[${ix}]`, ix === 0 ? Math.min(x, c[1] - minSize) : Math.max(x, c[0] + minSize));
            E.set(`clip[${iy}]`, iy === 2 ? Math.min(y, c[3] - minSize) : Math.max(y, c[2] + minSize));
            break;
        }
        default: break;
    }
    return E;
}

/**
 * Parameter edits that move numeric shape `s` by (dx, dy) in world coordinates: a Map path → new value.
 * Shapes with a transform move through `transform.translate`; plates and discs move only along x.
 */
export function moveEdits(s, dx, dy, { cyl = false } = {}) {
    const E = new Map();
    if (makeTransform(s.transform)) {
        const t = (s.transform && s.transform.translate) || [0, 0];
        E.set('transform.translate[0]', (t[0] || 0) + dx);
        E.set('transform.translate[1]', (t[1] || 0) + dy);
        return E;
    }
    const sh = (k, d) => { if (typeof s[k] === 'number' && d !== 0) E.set(k, s[k] + d); };
    switch (s.type) {
        case 'box': sh('x0', dx); sh('x1', dx); sh('y0', dy); sh('y1', dy); break;
        case 'tube': sh('x0', dx); sh('x1', dx); if (s.rIn + dy >= 0) { sh('rIn', dy); sh('rOut', dy); } break;
        case 'plate': case 'disc': sh('x', dx); break;
        case 'circle': case 'annulus': sh('cx', dx); sh('cy', cyl && s.cy + dy < 0 ? -s.cy : dy); break;
        case 'polygon': case 'polyline':
            (s.points || []).forEach((p, i) => { if (dx) E.set(`points[${i}][0]`, p[0] + dx); if (dy) E.set(`points[${i}][1]`, p[1] + dy); });
            break;
        case 'quadric': {
            sh('cx', dx); sh('cy', dy);
            const c = s.clip || [0, 0, 0, 0];
            if (dx) { E.set('clip[0]', c[0] + dx); E.set('clip[1]', c[1] + dx); }
            if (dy) { E.set('clip[2]', c[2] + dy); E.set('clip[3]', c[3] + dy); }
            break;
        }
        default: break;
    }
    return E;
}

/** Applies numeric edits to a copy of a resolved shape. */
export function applyNumeric(s, edits) {
    const out = structuredClone(s);
    for (const [p, v] of edits) {
        if (p.startsWith('transform.') && !out.transform) out.transform = { translate: [0, 0], rotate: 0, about: [0, 0], mirror: 'none' };
        setPath(out, p, v);
    }
    return out;
}

/**
 * Applies edits to the project copy of a shape: numbers are replaced (tidied), expressions get an offset.
 * `res` is the resolved shape the edits were computed from.
 */
export function applyToProject(projShape, res, edits, check = null) {
    for (const [p, v] of edits) {
        if (p.startsWith('transform.') && !projShape.transform) projShape.transform = { translate: [0, 0], rotate: 0, about: [0, 0], mirror: 'none' };
        const pv = getPath(projShape, p);
        const old = getPath(res, p);
        setPath(projShape, p, shiftedValue(pv === undefined ? 0 : pv, typeof old === 'number' ? old : 0, v, check));
    }
    return projShape;
}

/** A nice round length near `v` (1, 2 or 5 × 10^k). */
export function niceLength(v) {
    if (!(v > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / mag;
    return tidy((f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag);
}

/**
 * Numeric parameters of a new shape drawn by a drag from a to b (world points), for the tool's shape type.
 * `fold` maps y to |y| (cylindrical domains and y mirrors). Returns null when the drag is too small for that type.
 */
export function shapeFromDrag(type, a, b, { fold = false, h = 1, minSize = 1e-6 } = {}) {
    const fy = (y) => (fold ? Math.abs(y) : y);
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
    let y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    if (fold) { if (y1 <= 0) { const t = -y1; y1 = -y0; y0 = t; } else if (y0 < 0) y0 = 0; }
    const dx = x1 - x0, ra = Math.min(Math.abs(a[1]), Math.abs(b[1])), rb = Math.max(Math.abs(a[1]), Math.abs(b[1]));
    const thick = Math.max(dx, 2 * h);
    switch (type) {
        case 'box': return dx > minSize && y1 - y0 > minSize ? { x0, x1, y0, y1 } : null;
        case 'tube': return dx > minSize && rb - ra > minSize ? { x0, x1, rIn: ra, rOut: rb } : null;
        case 'plate': return rb > minSize ? { x: dx > 2 * h ? (x0 + x1) / 2 : a[0], t: thick, rHole: rb - ra > minSize ? ra : 0, rOut: rb } : null;
        case 'disc': return rb > minSize ? { x: dx > 2 * h ? (x0 + x1) / 2 : a[0], t: thick, r: rb } : null;
        case 'circle': { const r = Math.hypot(b[0] - a[0], b[1] - a[1]); return r > minSize ? { cx: a[0], cy: fy(a[1]), r } : null; }
        case 'annulus': { const r = Math.hypot(b[0] - a[0], b[1] - a[1]); return r > minSize ? { cx: a[0], cy: fy(a[1]), rIn: 0.8 * r, rOut: r, a0: 0, a1: 360 } : null; }
        default: return null;
    }
}

/**
 * Snap candidates for a world point: vertices and edges of outlines, the axis or mirror lines, then the node
 * grid (when nodes are at least `minPx` apart on screen) or a decimal grid of 0.1 mm × 10^k.
 * @param {number} x @param {number} y
 * @param {{ scale: number, dom: {x0,y0,h}|null, vertices?: Float64Array|number[], segments?: Array<Float64Array>,
 *   lines?: Array<{x?: number, y?: number}>, tolPx?: number, minPx?: number }} o
 * @returns {{ x: number, y: number, kind: string|null }}
 */
export function snapPoint(x, y, o) {
    const s = o.scale, tol = (o.tolPx || 8) / s;
    let best = null, bd = tol;
    const V = o.vertices || [];
    for (let k = 0; k + 1 < V.length; k += 2) {
        const d = Math.hypot(V[k] - x, V[k + 1] - y);
        if (d < bd) { bd = d; best = { x: V[k], y: V[k + 1], kind: 'vertex' }; }
    }
    if (best) return best;
    for (const L of o.lines || []) {
        if (typeof L.y === 'number' && Math.abs(y - L.y) < tol) {
            const g = gridStep(o);
            return { x: g.snapX(x), y: L.y, kind: L.kind || 'axis' };
        }
        if (typeof L.x === 'number' && Math.abs(x - L.x) < tol) {
            const g = gridStep(o);
            return { x: L.x, y: g.snapY(y), kind: L.kind || 'mirror' };
        }
    }
    bd = tol;
    for (const P of o.segments || []) {
        for (let k = 0; k + 3 < P.length; k += 2) {
            const ax = P[k], ay = P[k + 1], bx = P[k + 2], by = P[k + 3];
            const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey;
            let t = L2 > 0 ? ((x - ax) * ex + (y - ay) * ey) / L2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = ax + t * ex, py = ay + t * ey, d = Math.hypot(px - x, py - y);
            if (d < bd) { bd = d; best = { x: px, y: py, kind: 'edge' }; }
        }
    }
    if (best) return best;
    const g = gridStep(o);
    return { x: g.snapX(x), y: g.snapY(y), kind: g.kind };
}
function gridStep(o) {
    const s = o.scale, d = o.dom, minPx = o.minPx || 8;
    if (d && d.h > 0 && d.h * s >= minPx) {
        return { kind: 'node', snapX: (x) => tidy(d.x0 + Math.round((x - d.x0) / d.h) * d.h), snapY: (y) => tidy(d.y0 + Math.round((y - d.y0) / d.h) * d.h) };
    }
    // decimal grid of 0.1 mm × (1, 2, 5) × 10^k, the finest one at least minPx apart on screen
    let step = 0.1;
    for (let k = 0; step * s < minPx && k < 40; k++) step = tidy(step * (k % 3 === 1 ? 2.5 : 2));
    return { kind: 'grid', snapX: (x) => tidy(Math.round(x / step) * step), snapY: (y) => tidy(Math.round(y / step) * step) };
}

// ---------------------------------------------------------------- the tool manager
/**
 * Creates the canvas tools.
 * @param {object} ctx panel context (store, view, ui, engine)
 * @param {object} app application helpers from main.js
 * @returns {object} { list, setTool, current, onChange, key(e), nudge, reorder, duplicate, deleteSelection, cancel, … }
 */
export function createTools(ctx, app) {
    const { store, view } = ctx;
    const commit = createCommitter({ store, schema: ctx.engine.schema });
    const exprCheck = ctx.engine.expr && ctx.engine.expr.parseExpr ? (s) => ctx.engine.expr.parseExpr(s) : null;
    const changeFns = new Set();
    let toolId = 'select';
    let active = null;            // current tool object handed to the view
    let viewerMode = false;
    const ST = () => store.get();
    const R = () => ST().resolved || ST().lastResolved || null;

    function list() { return TOOL_DEFS.map((t) => ({ ...t })); }
    function def(id) { return TOOL_DEFS.find((t) => t.id === id) || TOOL_DEFS[0]; }

    // ------------------------------------------------------------ snapping data (cached per geometry)
    let snapCache = null;
    function snapData() {
        const sc = view.scene();
        const key = sc.key + '|' + (sc.geometry ? sc.geometry.prims.length : 0);
        if (snapCache && snapCache.key === key) return snapCache;
        // vertices and outline segments, each tagged with the id of the shape it belongs to
        const vertices = [], vOwner = [], segments = [], sOwner = [];
        const g = sc.geometry;
        if (g) {
            for (const p of g.prims) {
                const own = p.shapeId;
                const push = (x, y) => { vertices.push(x, y); vOwner.push(own); };
                if (p.kind === 'rect') { const q = p.params; push(q.x0, q.y0); push(q.x1, q.y0); push(q.x1, q.y1); push(q.x0, q.y1); }
                else if ((p.kind === 'polygon' || p.kind === 'polyline') && p.pts) for (let k = 0; k + 1 < p.pts.length; k += 2) push(p.pts[k], p.pts[k + 1]);
                else if ((p.kind === 'circle' || p.kind === 'annulus') && p.params) push(p.params.cx, p.params.cy);
            }
            let outs = [];
            try { outs = g.outlines(2); } catch (e) { outs = []; }
            for (const o of outs) {
                const own = g.prims[o.prim] ? g.prims[o.prim].shapeId : null;
                if (o.closed && o.pts.length >= 4) { const c = new Float64Array(o.pts.length + 2); c.set(o.pts); c[o.pts.length] = o.pts[0]; c[o.pts.length + 1] = o.pts[1]; segments.push(c); }
                else segments.push(o.pts);
                sOwner.push(own);
            }
        }
        const r = sc.resolved;
        if (r && r.sources) for (const s of r.sources) { const p = s.position || {}; for (const q of [p.p, p.p0, p.p1, p.center]) if (Array.isArray(q)) { vertices.push(q[0], q[1]); vOwner.push('source:' + s.id); } }
        const lines = [];
        if (sc.cyl || sc.mirrorY) lines.push({ y: 0, kind: sc.cyl ? 'axis' : 'mirror' });
        if (sc.mirrorX) lines.push({ x: 0, kind: 'mirror' });
        snapCache = { key, vertices: Float64Array.from(vertices), vOwner, segments, sOwner, lines, dom: sc.dom, filtered: new Map() };
        return snapCache;
    }
    /**
     * Snapped world point for pointer info P (Alt disables). `excludeIds` leaves out the geometry of the shapes
     * being moved or edited, so a shape never snaps to itself.
     */
    function snap(P, { excludeIds = null } = {}) {
        if (P.alt) return { x: P.x, y: P.y, kind: null };
        const d = snapData();
        const st = view.getViewState();
        let verts = d.vertices, segs = d.segments;
        if (excludeIds && excludeIds.length) {
            const fk = excludeIds.join('|');
            let f = d.filtered.get(fk);
            if (!f) {
                const ex = new Set(excludeIds);
                const v = [];
                for (let k = 0; k < d.vOwner.length; k++) if (!ex.has(d.vOwner[k])) v.push(d.vertices[2 * k], d.vertices[2 * k + 1]);
                f = { verts: Float64Array.from(v), segs: d.segments.filter((sg, k) => !ex.has(d.sOwner[k])) };
                d.filtered.set(fk, f);
            }
            verts = f.verts; segs = f.segs;
        }
        return snapPoint(P.x, P.y, { scale: st.scale, dom: d.dom, vertices: verts, segments: segs, lines: d.lines });
    }
    let snapMark = null;
    function drawSnap(c, xf) {
        if (!snapMark || !snapMark.kind) return;
        const [sx, sy] = xf.toScreen(snapMark.x, snapMark.y);
        const T = view.theme();
        c.strokeStyle = T.accent; c.lineWidth = 1.5;
        c.beginPath();
        if (snapMark.kind === 'vertex') c.rect(sx - 5, sy - 5, 10, 10);
        else if (snapMark.kind === 'edge') { c.moveTo(sx - 5, sy + 5); c.lineTo(sx + 5, sy - 5); c.moveTo(sx - 5, sy - 5); c.lineTo(sx + 5, sy + 5); }
        else if (snapMark.kind === 'axis' || snapMark.kind === 'mirror') { c.moveTo(sx - 7, sy); c.lineTo(sx + 7, sy); c.moveTo(sx, sy - 4); c.lineTo(sx, sy + 4); }
        else { c.arc(sx, sy, 3, 0, 2 * Math.PI); }
        c.stroke();
    }

    // ------------------------------------------------------------ helpers
    const scene = () => view.scene();
    const minSize = () => { const d = scene().dom; return d ? d.h * 1e-3 : 1e-6; };
    const fold = () => { const sc = scene(); return sc.cyl || sc.mirrorY; };
    function round(v) {
        const d = scene().dom;
        const q = d ? Math.pow(10, Math.floor(Math.log10(d.h)) - 2) : 1e-4;
        return tidy(Math.round(v / q) * q);
    }
    function drawElectrode() {
        const v = ST().ui.drawElectrode;
        if (v === '__void') return null;
        const els = ST().project.electrodes || [];
        if (v && els.some((e) => e.id === v)) return v;
        return els[1] ? els[1].id : 'gnd';
    }
    function selected() { const s = ST().selection || { kind: null, ids: [] }; return { kind: s.kind, ids: s.ids || [] }; }
    function resolvedShape(id) { const r = R(); return r && r.shapes ? r.shapes.find((s) => s.id === id) || null : null; }
    function tryCommit(mut, opts) {
        const res = commit(mut, opts);
        if (!res.ok && ctx.ui.toast) ctx.ui.toast(res.error || 'That edit is not valid.', { kind: 'warn' });
        return res;
    }
    function ghostOutlines(shapes) {
        const r = R();
        if (!r || !shapes.length) return [];
        try {
            const g = compileGeometry({ domain: r.domain, electrodes: r.electrodes, shapes });
            return g.outlines(1);
        } catch (e) { return []; }
    }
    function drawOutlines(c, xf, outs, { dashed = false, alpha = 0.35 } = {}) {
        const T = view.theme();
        const refl = [[1, 1]];
        if (xf.mirror.y) refl.push([1, -1]);
        if (xf.mirror.x) refl.push([-1, 1]);
        if (xf.mirror.x && xf.mirror.y) refl.push([-1, -1]);
        for (const [rx, ry] of refl) {
            for (const o of outs) {
                const p = new Path2D();
                for (let k = 0; k < o.pts.length; k += 2) {
                    const [sx, sy] = xf.toScreen(rx * o.pts[k], ry * o.pts[k + 1]);
                    if (k === 0) p.moveTo(sx, sy); else p.lineTo(sx, sy);
                }
                if (o.closed) p.closePath();
                const col = o.electrode >= 0 ? view.electrodeColor(o.electrode) : T.muted;
                if (o.closed && alpha > 0) { c.globalAlpha = alpha; c.fillStyle = col; c.fill(p); c.globalAlpha = 1; }
                c.strokeStyle = T.accent; c.lineWidth = o.closed ? 1.5 : 2.5;
                c.setLineDash(dashed ? [5, 3] : []);
                c.stroke(p);
                c.setLineDash([]);
            }
        }
    }
    function addShape(type, params, { select = true, label } = {}) {
        let newId = null;
        const res = tryCommit((p) => {
            p.shapes = p.shapes || [];
            newId = nextId(p.shapes, 's');
            const sh = { id: newId, type, electrode: drawElectrode(), ...params };
            p.shapes.push(sh);
        }, { label: label || `Add ${type}` });
        if (res.ok && select) store.select({ kind: 'shape', ids: [newId] });
        if (res.ok && ctx.ui.announce) ctx.ui.announce(`Added a ${type === 'polyline' ? 'line' : type}.`);
        return res.ok ? newId : null;
    }
    function tidyParams(o) {
        const out = {};
        for (const k of Object.keys(o)) out[k] = typeof o[k] === 'number' ? round(o[k]) : Array.isArray(o[k]) ? o[k].map((v) => (Array.isArray(v) ? v.map(round) : typeof v === 'number' ? round(v) : v)) : o[k];
        return out;
    }
    function defaultSize() {
        const st = view.getViewState();
        return niceLength(80 / st.scale);
    }

    // ------------------------------------------------------------ select tool
    function selectTool() {
        let drag = null;       // { mode: 'move'|'handle'|'source'|'plane', ... }
        let hoverHandle = null;
        let activeVertex = null;   // { id, index } of the last grabbed polygon vertex
        const HANDLE_PX = 7;

        function single() {
            const s = selected();
            if (s.kind !== 'shape' || s.ids.length !== 1) return null;
            const rs = resolvedShape(s.ids[0]);
            if (!rs || rs.locked) return null;
            return rs;
        }
        function handlesWorld(rs) {
            const xf = makeTransform(rs.transform);
            const sc = scene();
            return shapeHandles(rs, { cyl: sc.cyl }).map((hd) => { const [x, y] = toWorld(xf, hd.x, hd.y); return { ...hd, wx: x, wy: y }; });
        }
        function handleAt(P) {
            const rs = single();
            if (!rs) return null;
            for (const hd of handlesWorld(rs)) {
                const [sx, sy] = view.worldToScreen(hd.wx, hd.wy);
                if (Math.abs(sx - P.sx) <= HANDLE_PX && Math.abs(sy - P.sy) <= HANDLE_PX) return { rs, hd };
            }
            return null;
        }
        /** Signs that map a motion in a mirrored half back to the solved half (planes: only kinds that are mirrored). */
        function mirrorSigns(P, plane = false) {
            const sc = scene();
            let sy = (sc.cyl || sc.mirrorY) && P.y < 0 ? -1 : 1;
            if (plane) {
                const r = R();
                const pl = r && r.recording ? (r.recording.planes || []).find((q) => q.id === (view.hitTest(P.sx, P.sy) || {}).id) : null;
                if (!pl || !(pl.kind === 'r' || (pl.kind === 'y' && sc.mirrorY))) sy = 1;
            }
            return { sx: sc.mirrorX && P.x < 0 ? -1 : 1, sy };
        }
        function foldWorld(x, y) {
            const sc = scene();
            return [sc.mirrorX ? Math.abs(x) : x, sc.cyl || sc.mirrorY ? Math.abs(y) : y];
        }
        return {
            name: 'select',
            down(e, P) {
                const hh = handleAt(P);
                if (hh) {
                    drag = { mode: 'handle', id: hh.rs.id, rs: hh.rs, hd: hh.hd, start: P, moved: false, ghost: null };
                    if (hh.hd.id[0] === 'v') activeVertex = { id: hh.rs.id, index: Number(hh.hd.id.slice(1)) };
                    return;
                }
                // Alt-click on an edge of the selected polygon or line inserts a vertex
                const one = single();
                if (P.alt && one && (one.type === 'polygon' || one.type === 'polyline')) {
                    if (insertVertex(one, P)) return;
                }
                const hit = view.hitTest(P.sx, P.sy);
                const sel = selected();
                if (!hit) {
                    if (!P.shift) store.select({ kind: null, ids: [] });
                    view.highlightParticle(null);
                    drag = null;
                    return;
                }
                view.emit('pick', hit);
                if (hit.kind === 'particle') {
                    store.select({ kind: 'particle', ids: [hit.id] });
                    view.highlightParticle(hit.id);
                    return;
                }
                view.highlightParticle(null);
                let ids;
                if (P.shift && sel.kind === hit.kind && hit.kind === 'shape') {
                    ids = sel.ids.includes(hit.id) ? sel.ids.filter((i) => i !== hit.id) : [...sel.ids, hit.id];
                } else ids = sel.kind === hit.kind && sel.ids.includes(hit.id) ? sel.ids : [hit.id];
                if (!(sel.kind === hit.kind && sameIds(sel.ids, ids))) store.select({ kind: hit.kind, ids });
                if (viewerMode) return;
                if (hit.kind === 'shape') {
                    const shapes = ids.map(resolvedShape).filter((s) => s && !s.locked);
                    if (shapes.length) drag = { mode: 'move', shapes, start: P, moved: false, ghost: null, ...mirrorSigns(P) };
                } else if (hit.kind === 'source' || hit.kind === 'plane') {
                    drag = { mode: hit.kind, id: hit.id, start: P, moved: false, last: [0, 0], ...(hit.kind === 'plane' ? mirrorSigns(P, true) : { sx: 1, sy: 1 }) };
                }
            },
            move(e, P) {
                if (!drag) {
                    const hh = handleAt(P);
                    hoverHandle = hh ? hh.hd.id : null;
                    view.canvas.style.cursor = hh ? hh.hd.cursor : '';
                    return;
                }
                if (!drag.moved && Math.hypot(P.sx - drag.start.sx, P.sy - drag.start.sy) < 3) return;
                if (!drag.moved) { drag.moved = true; view.beginInteraction(); }
                if (drag.mode === 'handle') {
                    const sp = snap(P, { excludeIds: [drag.rs.id] });
                    snapMark = sp;
                    const xf = makeTransform(drag.rs.transform);
                    let [lx, ly] = toLocal(xf, sp.x, sp.y);
                    if (!xf) [lx, ly] = foldWorld(lx, ly);
                    const sc = scene();
                    drag.edits = handleEdits(drag.rs, drag.hd.id, lx, ly, { cyl: sc.cyl, mirrorY: sc.mirrorY, minSize: minSize() });
                    drag.ghost = [applyNumeric(drag.rs, drag.edits)];
                    view.hideShapes([drag.rs.id]);
                } else if (drag.mode === 'move') {
                    const ex = drag.shapes.map((x) => x.id);
                    const a = snap(drag.start, { excludeIds: ex }), b = snap(P, { excludeIds: ex });
                    snapMark = b;
                    // a drag in a mirrored half moves the shape in the solved half (mirror image of the motion)
                    let dx = drag.sx * (b.x - a.x), dy = drag.sy * (b.y - a.y);
                    if (P.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
                    const sc = scene();
                    drag.dx = dx; drag.dy = dy;
                    drag.ghost = drag.shapes.map((s) => applyNumeric(s, moveEdits(s, dx, dy, { cyl: sc.cyl })));
                    view.hideShapes(drag.shapes.map((s) => s.id));
                } else if (drag.mode === 'source' || drag.mode === 'plane') {
                    const ex = drag.mode === 'source' ? ['source:' + drag.id] : null;
                    const a = snap(drag.start, { excludeIds: ex }), b = snap(P, { excludeIds: ex });
                    snapMark = b;
                    const dx = drag.sx * (b.x - a.x), dy = drag.sy * (b.y - a.y);
                    const ddx = dx - drag.last[0], ddy = dy - drag.last[1];
                    if (ddx || ddy) {
                        const ok = drag.mode === 'source' ? moveSource(drag.id, ddx, ddy, 'move:' + drag.id) : movePlane(drag.id, ddx, ddy, 'move:' + drag.id);
                        if (ok) drag.last = [dx, dy];
                    }
                }
                view.requestRender();
            },
            up(e, P) {
                const d = drag;
                drag = null;
                snapMark = null;
                if (!d || !d.moved) { view.hideShapes([]); view.requestRender(); return; }
                if (d.mode === 'handle' && d.edits && d.edits.size) {
                    const edits = new Map([...d.edits].map(([k, v]) => [k, round(v)]));
                    tryCommit((p) => { const L = locate(p, 'shape', d.rs.id); if (L) applyToProject(L.obj, d.rs, edits, exprCheck); }, { label: 'Edit shape' });
                } else if (d.mode === 'move' && (d.dx || d.dy)) {
                    const sc = scene();
                    tryCommit((p) => {
                        for (const s of d.shapes) {
                            const L = locate(p, 'shape', s.id);
                            if (!L) continue;
                            const ed = moveEdits(s, round(d.dx), round(d.dy), { cyl: sc.cyl });
                            applyToProject(L.obj, s, new Map([...ed].map(([k, v]) => [k, round(v)])), exprCheck);
                        }
                    }, { label: d.shapes.length > 1 ? 'Move shapes' : 'Move shape' });
                }
                view.hideShapes([]);
                view.requestRender();
            },
            draw(c, xf) {
                if (drag && drag.ghost) drawOutlines(c, xf, ghostOutlines(drag.ghost), { dashed: true });
                const rs = !drag ? single() : (drag.mode === 'handle' ? applyNumeric(drag.rs, drag.edits || new Map()) : null);
                if (rs) {
                    const T = view.theme();
                    for (const hd of handlesWorld(rs)) {
                        const [sx, sy] = xf.toScreen(hd.wx, hd.wy);
                        c.fillStyle = hd.id === hoverHandle ? T.accent : T.surface;
                        c.strokeStyle = T.accent; c.lineWidth = 1.5;
                        c.fillRect(sx - 4.5, sy - 4.5, 9, 9); c.strokeRect(sx - 4.5, sy - 4.5, 9, 9);
                    }
                }
                drawSnap(c, xf);
            },
            cancelGesture() { drag = null; view.hideShapes([]); snapMark = null; },
            deactivate() { drag = null; view.hideShapes([]); view.canvas.style.cursor = ''; snapMark = null; },
            activeVertex: () => activeVertex,
            key(e) {
                if ((e.key === 'Delete' || e.key === 'Backspace') && activeVertex) {
                    const rs = single();
                    if (rs && rs.id === activeVertex.id && (rs.type === 'polygon' || rs.type === 'polyline')) {
                        const min = rs.type === 'polygon' ? 3 : 2;
                        if ((rs.points || []).length > min) {
                            const i = activeVertex.index;
                            const r = tryCommit((p) => { const L = locate(p, 'shape', rs.id); if (L) L.obj.points.splice(i, 1); }, { label: 'Delete vertex' });
                            activeVertex = null;
                            if (r.ok && ctx.ui.announce) ctx.ui.announce('Vertex deleted.');
                            return true;
                        }
                    }
                }
                if (e.key === 'Escape' && drag) { this.cancelGesture(); view.requestRender(); return true; }
                return false;
            },
        };
        function insertVertex(rs, P) {
            const xf = makeTransform(rs.transform);
            const pts = rs.points || [];
            const n = pts.length, closed = rs.type === 'polygon';
            let best = -1, bd = 7;
            for (let i = 0; i < (closed ? n : n - 1); i++) {
                const [ax, ay] = view.worldToScreen(...toWorld(xf, pts[i][0], pts[i][1]));
                const [bx, by] = view.worldToScreen(...toWorld(xf, pts[(i + 1) % n][0], pts[(i + 1) % n][1]));
                const d = segDistPx(P.sx, P.sy, ax, ay, bx, by);
                if (d < bd) { bd = d; best = i; }
            }
            if (best < 0) return false;
            let [lx, ly] = toLocal(xf, P.x, P.y);
            if (!xf && scene().cyl) ly = Math.abs(ly);
            const at = best + 1;
            const r = tryCommit((p) => { const L = locate(p, 'shape', rs.id); if (L) L.obj.points.splice(at, 0, [round(lx), round(ly)]); }, { label: 'Insert vertex' });
            if (r.ok) { activeVertex = { id: rs.id, index: at }; if (ctx.ui.announce) ctx.ui.announce('Vertex inserted.'); }
            return r.ok;
        }
    }

    // ------------------------------------------------------------ drag-to-draw shape tools
    function dragShapeTool(type) {
        let a = null, b = null, P0 = null;
        let hole = null;   // plate: hole radius set by an Alt-drag (the plain drag sets x, then the outer radius)
        const params = () => {
            const prm = shapeFromDrag(type, a, b, { fold: fold(), h: scene().dom ? scene().dom.h : 1, minSize: minSize() });
            if (prm && type === 'plate' && hole !== null) { prm.rHole = Math.min(hole, Math.max(0, prm.rOut - minSize())); }
            return prm;
        };
        return {
            name: type,
            down(e, P) { const s = snap(P); a = [s.x, s.y]; b = a; P0 = P; snapMark = s; hole = null; },
            move(e, P) {
                const s = snap(P); snapMark = s;
                if (!a) { view.requestRender(); return; }
                if (type === 'plate' && P.alt && b) { hole = Math.abs(P.y); view.requestRender(); return; }
                b = [s.x, s.y];
                view.requestRender();
            },
            up(e, P) {
                if (!a) return;
                if (!(type === 'plate' && P.alt)) { const s = snap(P); b = [s.x, s.y]; }
                const dragged = Math.hypot(P.sx - P0.sx, P.sy - P0.sy) > 4;
                let prm = dragged ? params() : null;
                if (!prm) prm = defaultShapeAt(type, a);
                a = null; b = null; snapMark = null; hole = null;
                if (prm) { addShape(type, tidyParams(prm)); setTool('select'); }
                view.requestRender();
            },
            draw(c, xf) {
                if (a && b) {
                    const prm = params();
                    if (prm) drawOutlines(c, xf, ghostOutlines([{ id: '__ghost', type, electrodeIndex: electrodeIndex(), ...prm }]), { dashed: true });
                    drawDims(c, xf, a, b);
                }
                drawSnap(c, xf);
            },
            cancelGesture() { a = null; b = null; },
            deactivate() { a = null; b = null; snapMark = null; },
            key(e) { if (e.key === 'Escape' && a) { a = null; b = null; view.requestRender(); return true; } return false; },
        };
    }
    function electrodeIndex() {
        const id = drawElectrode();
        if (id === null) return -1;
        const r = R();
        const k = r ? r.electrodes.findIndex((e) => e.id === id) : -1;
        return k;
    }
    function defaultShapeAt(type, p) {
        const L = defaultSize();
        const x = p[0], y = fold() ? Math.abs(p[1]) : p[1];
        switch (type) {
            case 'box': return { x0: x - L, x1: x + L, y0: y - L / 2, y1: y + L / 2 };
            case 'tube': return { x0: x - L, x1: x + L, rIn: Math.max(y, L / 2), rOut: Math.max(y, L / 2) + L / 4 };
            case 'plate': return { x, t: Math.max(L / 8, scene().dom ? 2 * scene().dom.h : 0.5), rHole: L / 2, rOut: 2 * L };
            case 'disc': return { x, t: Math.max(L / 8, scene().dom ? 2 * scene().dom.h : 0.5), r: L };
            case 'circle': return { cx: x, cy: y, r: L / 2 };
            case 'annulus': return { cx: x, cy: y, rIn: 0.8 * L, rOut: L, a0: 0, a1: 360 };
            default: return null;
        }
    }
    function drawDims(c, xf, a, b) {
        const T = view.theme();
        const [sx, sy] = xf.toScreen(b[0], b[1]);
        const text = `Δx ${formatPretty(b[0] - a[0], 'length', 4)} · Δy ${formatPretty(b[1] - a[1], 'length', 4)}`;
        c.font = `11px ${T.font}`;
        const w = c.measureText(text).width;
        c.fillStyle = T.surface; c.globalAlpha = 0.9; c.fillRect(sx + 10, sy + 8, w + 8, 16); c.globalAlpha = 1;
        c.fillStyle = T.text; c.textBaseline = 'middle'; c.fillText(text, sx + 14, sy + 16);
    }

    // ------------------------------------------------------------ polygon and line
    function pointsTool(type) {
        const pts = [];
        let hover = null, P0 = null, dragged = false;
        const minPts = type === 'polygon' ? 3 : 2;
        function finish() {
            if (pts.length >= minPts) {
                const f = fold();
                const points = pts.map(([x, y]) => [round(x), round(f ? Math.abs(y) : y)]);
                addShape(type, { points }, { label: type === 'polygon' ? 'Add polygon' : 'Add line' });
                pts.length = 0;
                setTool('select');
            } else if (ctx.ui.toast) ctx.ui.toast(type === 'polygon' ? 'A polygon needs at least 3 vertices.' : 'A line needs at least 2 points.', { kind: 'warn' });
            view.requestRender();
        }
        return {
            name: type,
            down(e, P) {
                const s = snap(P); snapMark = s;
                P0 = P; dragged = false;
                if (pts.length >= minPts && type === 'polygon') {
                    const [fx, fy] = view.worldToScreen(pts[0][0], pts[0][1]);
                    if (Math.hypot(fx - P.sx, fy - P.sy) < 8) { finish(); P0 = null; return; }
                }
                pts.push([s.x, s.y]);
                view.requestRender();
            },
            move(e, P) {
                const s = snap(P); snapMark = s; hover = [s.x, s.y];
                if (P0 && Math.hypot(P.sx - P0.sx, P.sy - P0.sy) > 4) dragged = true;
                view.requestRender();
            },
            up(e, P) {
                // a single press-drag-release with the line tool draws a two-point line
                if (type === 'polyline' && P0 && dragged && pts.length === 1) { const s = snap(P); pts.push([s.x, s.y]); finish(); }
                P0 = null;
            },
            dblclick() { if (pts.length > minPts) pts.pop(); finish(); },
            draw(c, xf) {
                const T = view.theme();
                if (pts.length) {
                    c.strokeStyle = T.accent; c.lineWidth = 2; c.setLineDash([6, 4]);
                    c.beginPath();
                    pts.forEach((p, i) => { const [sx, sy] = xf.toScreen(p[0], p[1]); if (i) c.lineTo(sx, sy); else c.moveTo(sx, sy); });
                    if (hover) { const [sx, sy] = xf.toScreen(hover[0], hover[1]); c.lineTo(sx, sy); }
                    c.stroke(); c.setLineDash([]);
                    for (const p of pts) { const [sx, sy] = xf.toScreen(p[0], p[1]); c.fillStyle = T.accent; c.fillRect(sx - 3, sy - 3, 6, 6); }
                }
                drawSnap(c, xf);
            },
            key(e) {
                if (e.key === 'Enter') { finish(); return true; }
                if (e.key === 'Escape') { if (pts.length) { pts.length = 0; view.requestRender(); return true; } return false; }
                if (e.key === 'Backspace' && pts.length) { pts.pop(); view.requestRender(); return true; }
                return false;
            },
            cancelGesture() { pts.length = 0; },
            deactivate() { pts.length = 0; hover = null; snapMark = null; },
        };
    }

    // ------------------------------------------------------------ quadric (form)
    function quadricTool() {
        return {
            name: 'quadric',
            down(e, P) { const s = snap(P); openQuadricForm([s.x, s.y]); },
            draw(c, xf) { drawSnap(c, xf); },
            move(e, P) { snapMark = snap(P); view.requestRender(); },
            deactivate() { snapMark = null; },
        };
    }
    function openQuadricForm(at) {
        const f = fold();
        const cx = round(at[0]), cy = round(f ? Math.abs(at[1]) : at[1]);
        const L = defaultSize();
        const fields = [['A', 1], ['B', -1], ['C', round(L * L)], ['cx', cx], ['cy', cy], ['clip x0', round(cx)], ['clip x1', round(cx + 3 * L)], ['clip y0', round(cy)], ['clip y1', round(cy + 3 * L)]];
        const inputs = new Map();
        const body = el('div', { class: 'io-form' });
        for (const [label, v] of fields) {
            const id = 'io-q-' + label.replace(/\s/g, '');
            const inp = el('input', { id, class: 'input', type: 'text', value: String(v), inputmode: 'decimal' });
            inputs.set(label, inp);
            body.appendChild(el('div', { class: 'field' }, el('label', { for: id, text: label }), inp));
        }
        const msg = el('p', { class: 'io-field-msg', hidden: true, role: 'alert' });
        body.appendChild(msg);
        body.appendChild(el('p', { class: 'io-note', text: 'Inside where A(x − cx)² + B(y − cy)² ≥ C within the clip box (the box selects the branch).' }));
        const pr = ctx.ui.openDialog({
            title: 'Add a quadric', body,
            actions: [{ label: 'Cancel', value: null }, { label: 'Add', value: 'ok', primary: true, onClick: () => {
                const vals = {};
                for (const [label, inp] of inputs) {
                    const r = parseScalar({ kind: 'number', dim: label.startsWith('clip') || label.startsWith('c') ? 'length' : 'none' }, inp.value, {});
                    if (!r.ok) { msg.hidden = false; msg.textContent = `${label}: ${r.error}`; return false; }
                    vals[label] = r.value;
                }
                addShape('quadric', { A: vals.A, B: vals.B, C: vals.C, cx: vals.cx, cy: vals.cy, clip: [vals['clip x0'], vals['clip x1'], vals['clip y0'], vals['clip y1']] });
                setTool('select');
                return true;
            } }],
        });
        return pr;
    }

    // ------------------------------------------------------------ source and plane
    function sourceTool() {
        let a = null, P0 = null, b = null;
        return {
            name: 'source',
            down(e, P) { const s = snap(P); a = [s.x, s.y]; b = a; P0 = P; snapMark = s; },
            move(e, P) { const s = snap(P); snapMark = s; if (a) b = [s.x, s.y]; view.requestRender(); },
            up(e, P) {
                if (!a) return;
                const s = snap(P);
                const dragged = Math.hypot(P.sx - P0.sx, P.sy - P0.sy) > 4;
                const p0 = [round(a[0]), round(a[1]), 0], p1 = [round(s.x), round(s.y), 0];
                a = null; b = null; snapMark = null;
                let newId = null;
                const res = tryCommit((p) => {
                    p.sources = p.sources || [];
                    newId = nextId(p.sources, 'b');
                    const n = p.sources.length + 1;
                    const src = {
                        id: newId, name: `Source ${n}`, enabled: true, color: 'auto', count: dragged ? 11 : 9, sampling: 'grid', seed: 1,
                        species: [{ label: 'm/z 100', mass: 100, charge: 1, fraction: 1 }],
                        position: dragged ? { type: 'line', p0, p1, n: 11 } : { type: 'point', p: p0 },
                        direction: dragged ? { type: 'fixed', dir: [1, 0, 0] } : { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: -5, to: 5, n: 9 },
                        energy: { type: 'mono', ke: 100 }, time: { type: 'fixed', t: 0 },
                    };
                    p.sources.push(src);
                }, { label: 'Add source' });
                if (res.ok) { store.select({ kind: 'source', ids: [newId] }); if (app.showRailTab) app.showRailTab('particles'); setTool('select'); }
                view.requestRender();
            },
            draw(c, xf) {
                if (a && b) {
                    const T = view.theme();
                    const [ax, ay] = xf.toScreen(a[0], a[1]), [bx, by] = xf.toScreen(b[0], b[1]);
                    c.strokeStyle = T.c1; c.lineWidth = 2; c.setLineDash([5, 3]);
                    c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke(); c.setLineDash([]);
                }
                drawSnap(c, xf);
            },
            deactivate() { a = null; snapMark = null; },
            cancelGesture() { a = null; },
        };
    }
    function planeFromDrag(a, b, dragged) {
        const sc = scene();
        if (!dragged) return { kind: 'x', at: round(a[0]) };
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const ang = Math.abs(Math.atan2(dy, dx)) / DEG;
        if (Math.abs(ang - 90) < 12) return { kind: 'x', at: round(a[0]) };
        if (ang < 12 || ang > 168) return sc.cyl ? { kind: 'r', at: round(Math.abs(a[1])) } : { kind: 'y', at: round(a[1]) };
        return { kind: 'segment', p0: [round(a[0]), round(a[1])], p1: [round(b[0]), round(b[1])] };
    }
    function planeTool() {
        let a = null, b = null, P0 = null;
        return {
            name: 'plane',
            down(e, P) { const s = snap(P); a = [s.x, s.y]; b = a; P0 = P; snapMark = s; },
            move(e, P) { const s = snap(P); snapMark = s; if (a) b = [s.x, s.y]; view.requestRender(); },
            up(e, P) {
                if (!a) return;
                const s = snap(P);
                const dragged = Math.hypot(P.sx - P0.sx, P.sy - P0.sy) > 6;
                const pl = planeFromDrag(a, [s.x, s.y], dragged);
                a = null; b = null; snapMark = null;
                let newId = null;
                const res = tryCommit((p) => {
                    p.recording = p.recording || { planes: [], trajectories: { store: true, maxPoints: 2000 }, timeMarkers: null };
                    p.recording.planes = p.recording.planes || [];
                    newId = nextId(p.recording.planes, 'p');
                    p.recording.planes.push({ id: newId, name: `Plane ${p.recording.planes.length + 1}`, ...pl, limits: null, radius: null, terminate: false, side: 'both', record: 'first' });
                }, { label: 'Add plane' });
                if (res.ok) { store.select({ kind: 'plane', ids: [newId] }); if (app.showRailTab) app.showRailTab('recording'); setTool('select'); }
                view.requestRender();
            },
            draw(c, xf) {
                if (a && b) {
                    const T = view.theme();
                    const [ax, ay] = xf.toScreen(a[0], a[1]), [bx, by] = xf.toScreen(b[0], b[1]);
                    c.strokeStyle = T.c5; c.lineWidth = 2; c.setLineDash([6, 4]);
                    c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke(); c.setLineDash([]);
                }
                drawSnap(c, xf);
            },
            deactivate() { a = null; snapMark = null; },
            cancelGesture() { a = null; },
        };
    }

    // ------------------------------------------------------------ measure and probe
    let measure = null;   // { a, b } persists until the next measurement or tool change
    function measureInfo(a, b) {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        return { p0: a, p1: b, d: Math.hypot(dx, dy), dx, dy, angle: Math.atan2(dy, dx) / DEG };
    }
    function measureText(m) {
        return `${formatPretty(m.d, 'length', 5)} · Δx ${formatPretty(m.dx, 'length', 5)} · Δy ${formatPretty(m.dy, 'length', 5)} · ${tidy(Math.round(m.angle * 100) / 100)}°`;
    }
    function lineTool(kind) {
        let a = null;
        return {
            name: kind,
            down(e, P) { const s = snap(P); a = [s.x, s.y]; if (kind === 'measure') measure = { a, b: a }; else measure = null; snapMark = s; view.requestRender(); },
            move(e, P) {
                const s = snap(P); snapMark = s;
                if (a) { if (kind === 'measure') measure = { a, b: [s.x, s.y] }; else measure = { a, b: [s.x, s.y], probe: true }; }
                view.requestRender();
            },
            up(e, P) {
                if (!a) return;
                const s = snap(P);
                const b = [s.x, s.y];
                const info = measureInfo(a, b);
                a = null; snapMark = null;
                if (kind === 'measure') {
                    measure = { a: info.p0, b: info.p1 };
                    view.emit('measure', info);
                    if (ctx.ui.announce) ctx.ui.announce('Distance ' + measureText(info));
                } else {
                    measure = null;
                    if (info.d > 0) {
                        store.setUi('probe', { p0: info.p0, p1: info.p1 });
                        view.emit('probe', { p0: info.p0, p1: info.p1 });
                        if (app.showDockTab) app.showDockTab('profile');
                        if (ctx.ui.announce) ctx.ui.announce('Probe line set; see the Profile tab.');
                    }
                }
                view.requestRender();
            },
            draw(c, xf) {
                if (measure) {
                    const T = view.theme();
                    const [ax, ay] = xf.toScreen(measure.a[0], measure.a[1]), [bx, by] = xf.toScreen(measure.b[0], measure.b[1]);
                    c.strokeStyle = T.text; c.lineWidth = 1.5; c.setLineDash(measure.probe ? [6, 3] : []);
                    c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke(); c.setLineDash([]);
                    for (const [x, y] of [[ax, ay], [bx, by]]) { c.beginPath(); c.arc(x, y, 3, 0, 2 * Math.PI); c.fillStyle = T.text; c.fill(); }
                    if (!measure.probe) {
                        const text = measureText(measureInfo(measure.a, measure.b));
                        c.font = `12px ${T.font}`;
                        const w = c.measureText(text).width;
                        const tx = clamp((ax + bx) / 2 - w / 2, 4, xf.W - w - 12), ty = clamp((ay + by) / 2 - 22, 4, xf.H - 24);
                        c.fillStyle = T.surface; c.globalAlpha = 0.92; c.fillRect(tx - 4, ty, w + 8, 18); c.globalAlpha = 1;
                        c.strokeStyle = T.border; c.strokeRect(tx - 4, ty, w + 8, 18);
                        c.fillStyle = T.text; c.textBaseline = 'middle'; c.fillText(text, tx, ty + 9);
                    }
                }
                drawSnap(c, xf);
            },
            deactivate() { a = null; measure = null; snapMark = null; },
            cancelGesture() { a = null; },
            key(e) { if (e.key === 'Escape' && measure) { measure = null; view.requestRender(); return true; } return false; },
        };
    }

    function panTool() { return { name: 'pan', down() {}, move() {}, up() {} }; }

    // ------------------------------------------------------------ persistent overlays: selection outline and probe line
    let selCache = null;
    view.addOverlay('io-selection', (c, xf) => {
        const s = selected();
        if (s.kind !== 'shape' || !s.ids.length) return;
        const r = R();
        if (!r) return;
        const key = (ST().keys && ST().keys.geomKey) + '|' + s.ids.join(',');
        if (!selCache || selCache.key !== key) {
            const shapes = s.ids.map(resolvedShape).filter(Boolean);
            selCache = { key, outs: ghostOutlines(shapes) };
        }
        drawOutlines(c, xf, selCache.outs, { alpha: 0 });
    });
    view.addOverlay('io-probe', (c, xf) => {
        const pr = ST().ui.probe;
        if (!pr || !pr.p0 || !pr.p1) return;
        const T = view.theme();
        const [ax, ay] = xf.toScreen(pr.p0[0], pr.p0[1]), [bx, by] = xf.toScreen(pr.p1[0], pr.p1[1]);
        c.strokeStyle = T.c6; c.lineWidth = 2; c.setLineDash([7, 4]);
        c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke(); c.setLineDash([]);
        c.fillStyle = T.c6;
        c.font = `11px ${T.font}`; c.textBaseline = 'bottom';
        c.fillText('Probe', bx + 6, by - 4);
    });

    // ------------------------------------------------------------ editing commands (also used by shortcuts and panels)
    function moveSource(id, dx, dy, merge) {
        const r = R();
        const rs = r && r.sources ? r.sources.find((s) => s.id === id) : null;
        const res = tryCommit((p) => {
            const L = locate(p, 'source', id);
            if (!L) return;
            const pos = L.obj.position || {};
            const rp = rs ? rs.position || {} : pos;
            const shift = (key, i, d) => {
                if (!Array.isArray(pos[key]) || !d) return;
                const old = Array.isArray(rp[key]) && typeof rp[key][i] === 'number' ? rp[key][i] : (typeof pos[key][i] === 'number' ? pos[key][i] : 0);
                pos[key][i] = shiftedValue(pos[key][i], old, round(old + d), exprCheck);
            };
            for (const key of ['p', 'p0', 'p1', 'center']) { shift(key, 0, dx); shift(key, 1, dy); }
            if (Array.isArray(pos.points)) for (const q of pos.points) { if (typeof q[0] === 'number') q[0] = round(q[0] + dx); if (typeof q[1] === 'number') q[1] = round(q[1] + dy); }
        }, { label: 'Move source', merge });
        return res.ok;
    }
    function movePlane(id, dx, dy, merge) {
        const r = R();
        const rp = r && r.recording ? (r.recording.planes || []).find((q) => q.id === id) : null;
        const res = tryCommit((p) => {
            const L = locate(p, 'plane', id);
            if (!L) return;
            const pl = L.obj;
            const sh = (val, old, d) => shiftedValue(val, old, round(old + d), exprCheck);
            if (pl.kind === 'x' && dx) pl.at = sh(pl.at, rp ? rp.at : pl.at, dx);
            else if ((pl.kind === 'y' || pl.kind === 'r') && dy) pl.at = sh(pl.at, rp ? rp.at : pl.at, pl.kind === 'r' && rp && rp.at + dy < 0 ? 0 : dy);
            else if (pl.kind === 'segment') {
                for (const k of ['p0', 'p1']) {
                    if (!Array.isArray(pl[k])) continue;
                    const o = rp && Array.isArray(rp[k]) ? rp[k] : pl[k];
                    pl[k] = [sh(pl[k][0], o[0], dx), sh(pl[k][1], o[1], dy)];
                }
            }
        }, { label: 'Move plane', merge });
        return res.ok;
    }
    /** Moves the selection by (dx, dy) mm (arrow-key nudges). */
    function nudge(dx, dy) {
        const s = selected();
        if (!s.ids.length) return false;
        if (s.kind === 'shape') {
            const sc = scene();
            const shapes = s.ids.map(resolvedShape).filter((x) => x && !x.locked);
            if (!shapes.length) return false;
            const res = tryCommit((p) => {
                for (const rs of shapes) {
                    const L = locate(p, 'shape', rs.id);
                    if (L) applyToProject(L.obj, rs, new Map([...moveEdits(rs, dx, dy, { cyl: sc.cyl })].map(([k, v]) => [k, round(v)])), exprCheck);
                }
            }, { label: 'Nudge', merge: 'nudge:' + s.ids.join(',') });
            return res.ok;
        }
        if (s.kind === 'source') return s.ids.every((id) => moveSource(id, dx, dy, 'nudge:' + id));
        if (s.kind === 'plane') return s.ids.every((id) => movePlane(id, dx, dy, 'nudge:' + id));
        return false;
    }
    /** Moves the selected shapes one place earlier (−1) or later (+1) in the CSG order. */
    function reorder(dir) {
        const s = selected();
        if (s.kind !== 'shape' || !s.ids.length) return false;
        const res = tryCommit((p) => {
            const shapes = p.shapes || [];
            const idx = s.ids.map((id) => shapes.findIndex((x) => x.id === id)).filter((i) => i >= 0).sort((a, b) => (dir > 0 ? b - a : a - b));
            for (const i of idx) {
                const j = i + dir;
                if (j < 0 || j >= shapes.length || s.ids.includes(shapes[j].id)) continue;
                const t = shapes[i]; shapes[i] = shapes[j]; shapes[j] = t;
            }
        }, { label: dir > 0 ? 'Move later' : 'Move earlier' });
        if (res.ok && ctx.ui.announce) ctx.ui.announce(dir > 0 ? 'Moved later in the shape order (wins over more shapes).' : 'Moved earlier in the shape order.');
        return res.ok;
    }
    /** Duplicates the selected shapes, sources or planes (copies follow their originals). */
    function duplicate() {
        const s = selected();
        if (!s.ids.length) return false;
        const lists = { shape: 'shapes', source: 'sources', plane: 'recording.planes', magnet: 'magnets' };
        const lp = lists[s.kind];
        if (!lp) return false;
        const newIds = [];
        const prefix = { shape: 's', source: 'b', plane: 'p', magnet: 'm' }[s.kind];
        const res = tryCommit((p) => {
            const list = getPath(p, lp);
            if (!Array.isArray(list)) return;
            for (const id of s.ids) {
                const i = list.findIndex((o) => o && o.id === id);
                if (i < 0) continue;
                const copy = structuredClone(list[i]);
                copy.id = nextId(list, prefix);
                if (copy.name) copy.name = copy.name + ' copy';
                list.splice(i + 1, 0, copy);
                newIds.push(copy.id);
            }
        }, { label: 'Duplicate' });
        if (res.ok && newIds.length) { store.select({ kind: s.kind, ids: newIds }); if (ctx.ui.announce) ctx.ui.announce(`Duplicated ${newIds.length} item${newIds.length > 1 ? 's' : ''}.`); }
        return res.ok;
    }
    /** Deletes the selected shapes, sources, planes, magnets or ideal fields. */
    function deleteSelection() {
        const s = selected();
        if (!s.ids.length) return false;
        if (active && active.key && active.activeVertex && active.activeVertex()) {
            if (active.key({ key: 'Delete' })) return true;
        }
        const lists = { shape: 'shapes', source: 'sources', plane: 'recording.planes', magnet: 'magnets', idealField: 'idealFields' };
        const lp = lists[s.kind];
        if (!lp) return false;
        if (s.kind === 'shape') {
            const locked = s.ids.map(resolvedShape).filter((x) => x && x.locked);
            if (locked.length === s.ids.length) { if (ctx.ui.toast) ctx.ui.toast('That shape is locked.', { kind: 'warn' }); return false; }
        }
        const res = tryCommit((p) => {
            const list = getPath(p, lp);
            if (!Array.isArray(list)) return;
            for (let i = list.length - 1; i >= 0; i--) if (list[i] && s.ids.includes(list[i].id) && !(s.kind === 'shape' && list[i].locked)) list.splice(i, 1);
        }, { label: 'Delete' });
        if (res.ok) { store.select({ kind: null, ids: [] }); if (ctx.ui.announce) ctx.ui.announce('Deleted.'); }
        return res.ok;
    }

    // ------------------------------------------------------------ tool switching
    const makers = {
        select: selectTool, pan: panTool,
        box: () => dragShapeTool('box'), tube: () => dragShapeTool('tube'), plate: () => dragShapeTool('plate'), disc: () => dragShapeTool('disc'),
        circle: () => dragShapeTool('circle'), annulus: () => dragShapeTool('annulus'),
        polygon: () => pointsTool('polygon'), line: () => pointsTool('polyline'), quadric: quadricTool,
        source: sourceTool, plane: planeTool, measure: () => lineTool('measure'), probe: () => lineTool('probe'),
    };
    function setTool(id) {
        let want = makers[id] ? id : 'select';
        if (viewerMode && def(want).editing) want = 'select';
        toolId = want;
        active = makers[want]();
        view.setTool(active);
        for (const fn of changeFns) { try { fn(want); } catch (e) { /* listener */ } }
    }
    function key(e) { return !!(active && typeof active.key === 'function' && active.key(e)); }

    /** Adds a shape of default size centred at world point c (the Shapes panel's add buttons). */
    function addShapeAt(type, c) {
        if (type === 'quadric') { openQuadricForm(c); return null; }
        const L = defaultSize();
        const f = fold();
        const x = c[0], y = f ? Math.max(Math.abs(c[1]), L) : c[1];
        if (type === 'polygon') return addShape('polygon', tidyParams({ points: [[x - L, y - L / 2], [x + L, y - L / 2], [x, y + L / 2]] }));
        if (type === 'polyline') return addShape('polyline', tidyParams({ points: [[x, f ? Math.max(0, y - L) : y - L], [x, y + L]] }));
        const prm = defaultShapeAt(type, [x, y]);
        return prm ? addShape(type, tidyParams(prm)) : null;
    }

    const api = {
        list, setTool, key, nudge, reorder, duplicate, deleteSelection, moveSource, movePlane, addShape, addShapeAt, snap,
        current: () => toolId,
        get active() { return active; },
        onChange(fn) { changeFns.add(fn); return () => changeFns.delete(fn); },
        setViewerMode(on) { viewerMode = !!on; if (viewerMode && def(toolId).editing) setTool('select'); },
        cancel() { if (active && active.cancelGesture) active.cancelGesture(); measure = null; view.hideShapes([]); view.requestRender(); },
        defaultSize,
    };
    return api;
}

function sameIds(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }
function segDistPx(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
