// WP1 geometry (spec 3.2, 7.2 acceptance 1): compose() agrees with classify() on 10^4 random segments per
// primitive type (transforms, voids, CSG order, polylines through vertices), 20 points each; transforms,
// first hits, outlines and warnings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileGeometry, geometryWarnings, newComposition, SHAPE_TYPES } from '../../beta/ion-optics/js/engine/geometry.js';
import { makeGrid, rasterize } from '../../beta/ion-optics/js/engine/raster.js';

function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ELS = [{ id: 'gnd' }, { id: 'a' }, { id: 'b' }, { id: 'c', kind: 'grid' }];
function domain(type = 'planar2d', h = 0.5) {
    const cyl = type === 'cyl2d';
    return { type, h, cell: h, x: [-10, 10], y: cyl ? [0, 10] : [-10, 10], nx: Math.round(20 / h) + 1, ny: Math.round((cyl ? 10 : 20) / h) + 1, edges: {}, mirror: {} };
}
const snap = (v, r) => (r() < 0.3 ? Math.round(v * 2) / 2 : v);   // vertices often on grid nodes (h = 0.5)

function randomShape(type, r) {
    const U = (a, b) => a + (b - a) * r();
    const el = r() < 0.25 ? null : ['a', 'b', 'c'][Math.floor(3 * r())];
    const s = { id: 's' + Math.floor(1e9 * r()), type, electrode: el };
    switch (type) {
        case 'box': Object.assign(s, { x0: snap(U(-9, 9), r), x1: snap(U(-9, 9), r), y0: snap(U(-9, 9), r), y1: snap(U(-9, 9), r) }); break;
        case 'tube': { const rIn = U(0, 5); Object.assign(s, { x0: snap(U(-9, 9), r), x1: snap(U(-9, 9), r), rIn, rOut: rIn + U(0, 4) }); break; }
        case 'plate': Object.assign(s, { x: snap(U(-9, 9), r), t: r() < 0.2 ? 0 : (r() < 0.3 ? 0.3 : U(0, 2)), rHole: U(0, 4), rOut: U(4, 9) }); break;
        case 'disc': Object.assign(s, { x: snap(U(-9, 9), r), t: r() < 0.2 ? 0 : U(0, 3), r: U(0.2, 8) }); break;
        case 'circle': Object.assign(s, { cx: snap(U(-8, 8), r), cy: snap(U(-8, 8), r), r: r() < 0.1 ? 0.1 : U(0.2, 5) }); break;
        case 'annulus': {
            const rIn = r() < 0.2 ? 0 : U(0.3, 4);
            const a0 = U(-180, 360), kind = r();
            const span = kind < 0.2 ? 360 : kind < 0.35 ? 180 : kind < 0.6 ? U(181, 359) : U(1, 179);
            Object.assign(s, { cx: snap(U(-6, 6), r), cy: snap(U(-6, 6), r), rIn, rOut: rIn + U(0.2, 4), a0, a1: a0 + span });
            break;
        }
        case 'polygon': {
            const n = 3 + Math.floor(7 * r()), cx = U(-5, 5), cy = U(-5, 5), pts = [];
            const star = r() < 0.5;
            for (let i = 0; i < n; i++) {
                if (star) { const a = 2 * Math.PI * i / n, rr = (i % 2 ? 0.4 : 1) * U(1, 5); pts.push([snap(cx + rr * Math.cos(a), r), snap(cy + rr * Math.sin(a), r)]); } else pts.push([snap(U(-9, 9), r), snap(U(-9, 9), r)]);
            }
            s.points = pts;
            break;
        }
        case 'polyline': {
            const n = 2 + Math.floor(5 * r()), pts = [];
            let x = snap(U(-8, 8), r), y = snap(U(-8, 8), r);
            pts.push([x, y]);
            for (let i = 1; i < n; i++) {
                const kind = r();
                if (kind < 0.25) x = snap(U(-9, 9), r); else if (kind < 0.5) y = snap(U(-9, 9), r); else { x = snap(U(-9, 9), r); y = snap(U(-9, 9), r); }
                pts.push([x, y]);
            }
            s.points = pts;
            break;
        }
        case 'quadric': {
            const pick = [1, -1, 0.5, -0.5, 2, -2];
            Object.assign(s, { A: pick[Math.floor(6 * r())], B: pick[Math.floor(6 * r())], C: U(-4, 16), cx: U(-5, 5), cy: U(-5, 5) });
            const x0 = U(-9, 5), y0 = U(-9, 5);
            s.clip = [x0, x0 + U(1, 12), y0, y0 + U(1, 12)];
            break;
        }
        default: break;
    }
    if (r() < 0.5) {
        const rot = type === 'quadric' ? 90 * Math.floor(4 * r()) : (r() < 0.3 ? 90 * Math.floor(4 * r()) : U(-180, 180));
        s.transform = { translate: [U(-2, 2), U(-2, 2)], rotate: rot, about: [U(-3, 3), U(-3, 3)], mirror: ['none', 'x', 'y', 'xy'][Math.floor(4 * r())] };
    }
    return s;
}
function verticesOf(g) {
    const v = [];
    for (const p of g.prims) {
        if (p.pts) for (let i = 0; i < p.np; i++) v.push([p.pts[2 * i], p.pts[2 * i + 1]]);
        else { const b = p.bbox; v.push([b.x0, b.y0], [b.x1, b.y1], [b.x0, b.y1], [b.x1, b.y0]); }
    }
    return v;
}
function classAt(comp, t) {
    for (let q = 0; q < comp.n; q++) if (comp.t0[q] <= t && t <= comp.t1[q]) return comp.cls[q];
    return -1;
}

for (const type of SHAPE_TYPES) {
    test(`compose agrees with classify: ${type} (10^4 segments x 20 points)`, () => {
        const r = rng(0xC0FFEE + type.length * 7919 + type.charCodeAt(0));
        let bad = 0, checked = 0, pieces = 0, edgeChecked = 0;
        const examples = [];
        const comp = newComposition(8);
        const SCENES = 20, SEGS = 500;
        for (let sc = 0; sc < SCENES; sc++) {
            const dtype = (type === 'tube' || type === 'plate' || type === 'disc') && r() < 0.5 ? 'cyl2d' : 'planar2d';
            const shapes = [];
            const n = 3 + Math.floor(4 * r());
            for (let i = 0; i < n; i++) {
                shapes.push(randomShape(type, r));
                if (r() < 0.3) shapes.push(randomShape(r() < 0.5 ? 'box' : 'circle', r));
            }
            const resolved = { domain: domain(dtype), electrodes: ELS, shapes };
            const g = compileGeometry(resolved);
            const verts = verticesOf(g);
            for (let s = 0; s < SEGS; s++) {
                let px, py, qx, qy;
                const kind = r();
                if (kind < 0.25 && verts.length) {          // through a vertex
                    const [vx, vy] = verts[Math.floor(r() * verts.length)];
                    const a = 2 * Math.PI * r(), l0 = 6 * r(), l1 = 6 * r();
                    const ax = r() < 0.4 ? Math.round(Math.cos(a)) : Math.cos(a), ay = r() < 0.4 ? Math.round(Math.sin(a)) : Math.sin(a);
                    px = vx - l0 * ax; py = vy - l0 * ay; qx = vx + l1 * ax; qy = vy + l1 * ay;
                } else if (kind < 0.5) {                     // grid rows and columns, as the rasteriser uses them
                    const c = Math.round((r() * 24 - 12) * 2) / 2;
                    if (r() < 0.5) { px = -12; qx = 12; py = qy = c; } else { py = -12; qy = 12; px = qx = c; }
                } else { px = 24 * r() - 12; py = 24 * r() - 12; qx = 24 * r() - 12; qy = 24 * r() - 12; }
                const dx = qx - px, dy = qy - py;
                g.compose(px, py, dx, dy, comp);
                pieces += comp.n;
                for (let q = 0; q < comp.n; q++) {
                    assert.ok(comp.t0[q] <= comp.t1[q] && comp.t0[q] >= 0 && comp.t1[q] <= 1, 'pieces inside [0, 1]');
                    if (q > 0) assert.ok(comp.t0[q] > comp.t1[q - 1], 'pieces sorted and disjoint');
                }
                for (let m = 0; m < 20; m++) {
                    const t = r();
                    const a = classAt(comp, t), b = g.classify(px + t * dx, py + t * dy);
                    checked++;
                    if (a !== b) { bad++; if (examples.length < 5) examples.push({ sc, px, py, qx, qy, t, compose: a, classify: b }); }
                }
                // and just inside / outside every piece end (1e-9 in t: a few eps; tangent chords are ill-conditioned below that)
                const ends = [];
                for (let q = 0; q < comp.n; q++) ends.push(comp.t0[q] - 1e-9, comp.t0[q] + 1e-9, comp.t1[q] - 1e-9, comp.t1[q] + 1e-9);
                for (const t of ends) {
                    if (t < 0 || t > 1) continue;
                    const a = classAt(comp, t), b = g.classify(px + t * dx, py + t * dy);
                    edgeChecked++;
                    if (a !== b) { bad++; if (examples.length < 5) examples.push({ sc, px, py, qx, qy, t, compose: a, classify: b, edge: true }); }
                }
            }
        }
        assert.equal(checked, SCENES * SEGS * 20);
        assert.ok(pieces > 1000 && edgeChecked > 2000, `segments meet the shapes (${pieces} pieces, ${edgeChecked} end samples)`);
        assert.equal(bad, 0, `disagreements: ${JSON.stringify(examples)}`);
    });
}

test('transforms: mirror, rotate, translate about a point', () => {
    const res = (shapes) => ({ domain: domain(), electrodes: ELS, shapes });
    // box rotated 90 deg about (1, 1): [2, 4] x [0, 1] -> x in [0, 1], y in [2, 4]
    let g = compileGeometry(res([{ type: 'box', electrode: 'a', x0: 2, x1: 4, y0: 0, y1: 1, transform: { rotate: 90, about: [1, 1] } }]));
    assert.equal(g.prims[0].kind, 'rect');
    const b = g.prims[0].params;
    assert.ok(Math.abs(b.x0 - 1) < 1e-12 && Math.abs(b.x1 - 2) < 1e-12 && Math.abs(b.y0 - 2) < 1e-12 && Math.abs(b.y1 - 4) < 1e-12, JSON.stringify(b));
    // 30 deg rotation turns a box into a polygon
    g = compileGeometry(res([{ type: 'box', electrode: 'a', x0: 0, x1: 4, y0: -0.5, y1: 0.5, transform: { rotate: 30 } }]));
    assert.equal(g.prims[0].kind, 'polygon');
    const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
    assert.equal(g.classify(3 * c30, 3 * s30), 1);
    assert.equal(g.classify(3, 0), -1);
    // mirror x about x = 1, then translate (0, 2)
    g = compileGeometry(res([{ type: 'circle', electrode: 'b', cx: 3, cy: 0, r: 1, transform: { mirror: 'x', about: [1, 0], translate: [0, 2] } }]));
    assert.ok(Math.abs(g.prims[0].params.cx + 1) < 1e-12 && Math.abs(g.prims[0].params.cy - 2) < 1e-12);
    // annulus sector 0..90 mirrored in x becomes 90..180
    g = compileGeometry(res([{ type: 'annulus', electrode: 'a', cx: 0, cy: 0, rIn: 2, rOut: 3, a0: 0, a1: 90, transform: { mirror: 'x' } }]));
    assert.equal(g.classify(-2.5 * Math.SQRT1_2, 2.5 * Math.SQRT1_2), 1);
    assert.equal(g.classify(2.5 * Math.SQRT1_2, 2.5 * Math.SQRT1_2), -1);
    // mirror y: 0..90 -> -90..0
    g = compileGeometry(res([{ type: 'annulus', electrode: 'a', cx: 0, cy: 0, rIn: 2, rOut: 3, a0: 0, a1: 90, transform: { mirror: 'y' } }]));
    assert.equal(g.classify(2.5 * Math.SQRT1_2, -2.5 * Math.SQRT1_2), 1);
    // quadric rotated 90 deg swaps A and B
    g = compileGeometry(res([{ type: 'quadric', electrode: 'a', A: 1, B: -1, C: 4, cx: 0, cy: 0, clip: [0, 8, -8, 8], transform: { rotate: 90 } }]));
    assert.equal(g.classify(0, 3), 1);      // was (3, 0): x^2 - y^2 >= 4 -> now y^2 - x^2 >= 4
    assert.equal(g.classify(3, 0), -1);
    // later shapes win, voids carve
    g = compileGeometry(res([{ type: 'box', electrode: 'a', x0: -5, x1: 5, y0: -5, y1: 5 }, { type: 'circle', electrode: null, cx: 0, cy: 0, r: 2 }, { type: 'box', electrode: 'b', x0: -0.5, x1: 0.5, y0: -0.5, y1: 0.5 }]));
    assert.equal(g.classify(4, 4), 1);
    assert.equal(g.classify(1.5, 0), -1);
    assert.equal(g.classify(0, 0), 2);
    // closed sets: points within eps of a boundary are inside
    assert.equal(g.classify(5 + 1e-11, 0), 1);
    assert.equal(g.classify(5 + 1e-6, 0), -1);
});

test('firstNonFree: first non-free point, transparent meshes skipped on request', () => {
    const g = compileGeometry({ domain: domain(), electrodes: ELS, shapes: [
        { type: 'polyline', electrode: 'c', points: [[0, -5], [0, 5]] },
        { type: 'box', electrode: 'a', x0: 4, x1: 6, y0: -5, y1: 5 },
        { type: 'box', electrode: null, x0: 4, x1: 6, y0: 2, y1: 3 }] });
    let h = g.firstNonFree(-5, 0, 10, 0);
    assert.ok(h && h.electrode === 3 && h.transparent && Math.abs(h.t - 1 / 3) < 1e-9);
    h = g.firstNonFree(-5, 0, 10, 0, true);
    assert.ok(h && h.electrode === 1 && !h.transparent && Math.abs(h.t - 0.6) < 1e-9);
    h = g.firstNonFree(-5, 2.5, 10, 2.5, true);   // through the void hole
    assert.equal(h, null);
    h = g.firstNonFree(5, 0, 7, 0);               // starting inside
    assert.ok(h && h.t === 0 && h.electrode === 1);
});

test('outlines follow the primitive boundaries', () => {
    const shapes = [
        { type: 'box', electrode: 'a', x0: -9, x1: -7, y0: -1, y1: 1 },
        { type: 'circle', electrode: 'a', cx: -4, cy: 0, r: 1.5 },
        { type: 'annulus', electrode: 'b', cx: 0, cy: 0, rIn: 1, rOut: 2, a0: 20, a1: 250 },
        { type: 'annulus', electrode: 'b', cx: 4, cy: 4, rIn: 1, rOut: 2 },
        { type: 'polygon', electrode: 'a', points: [[5, -5], [8, -5], [6, -2]] },
        { type: 'polyline', electrode: 'c', points: [[-8, 5], [-6, 7], [-4, 5]] },
        { type: 'quadric', electrode: 'a', A: 1, B: -1, C: 1, cx: 0, cy: -6, clip: [0, 6, -9, -3] },
    ];
    const g = compileGeometry({ domain: domain(), electrodes: ELS, shapes });
    const outl = g.outlines(1);
    const byPrim = new Map();
    for (const o of outl) { if (!byPrim.has(o.prim)) byPrim.set(o.prim, []); byPrim.get(o.prim).push(o); }
    assert.equal(byPrim.size, 7);
    assert.equal(byPrim.get(5)[0].closed, false);
    for (const [q, list] of byPrim) {
        const p = g.prims[q];
        for (const o of list) {
            const n = o.pts.length / 2;
            assert.ok(n >= 2);
            for (let i = 0; i < n; i++) {
                const x = o.pts[2 * i], y = o.pts[2 * i + 1];
                // every outline vertex is on the closed set (within the tessellation tolerance of curves)
                let inside = p.contains(x, y);
                if (!inside) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (p.contains(x + 2e-3 * dx, y + 2e-3 * dy)) inside = true;
                assert.ok(inside, `prim ${q} (${p.kind}) vertex ${i} (${x}, ${y})`);
            }
        }
    }
    // quadric outline: vertices on the hyperbola (x - 0)^2 - (y + 6)^2 = 1 or on the clip box
    for (const o of byPrim.get(6)) {
        for (let i = 0; i < o.pts.length / 2; i++) {
            const x = o.pts[2 * i], y = o.pts[2 * i + 1];
            const onConic = Math.abs(x * x - (y + 6) * (y + 6) - 1) < 2e-2, onClip = Math.abs(x) < 1e-9 || Math.abs(x - 6) < 1e-9 || Math.abs(y + 9) < 1e-9 || Math.abs(y + 3) < 1e-9;
            assert.ok(onConic || onClip, `quadric outline vertex (${x}, ${y})`);
        }
    }
});

test('geometry warnings', () => {
    const resolved = {
        domain: { type: 'cyl2d', h: 0.5, cell: 0.5, x: [-10, 10.2], y: [0, 10], nx: 41, ny: 21, edges: {}, mirror: {} },
        electrodes: [{ id: 'gnd' }, { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'unused', name: 'Unused' }],
        shapes: [
            { type: 'circle', electrode: 'a', cx: 0.25, cy: 5.25, r: 0.1 },                 // 0 sub-cell and thin
            { type: 'box', electrode: 'a', x0: 20, x1: 22, y0: 1, y1: 2 },                  // 1 outside
            { type: 'box', electrode: 'b', x0: -2, x1: 2, y0: -1, y1: 1 },                  // 2 below the axis
            { type: 'polygon', electrode: 'a', points: [[3, 3], [6, 6], [6, 3], [3, 6]] }, // 3 self-crossing
            { type: 'box', electrode: 'b', x0: -8, x1: -7, y0: 2, y1: 3 },                  // 4 buried by 5
            { type: 'box', electrode: 'a', x0: -9, x1: -6, y0: 1, y1: 4 },                  // 5
            { type: 'plate', electrode: 'b', x: 8, t: 1, rHole: 3, rOut: 9 },                // 6 aperture 6 cells
            { type: 'box', electrode: 'b', x0: 2.5, x1: 3.5, y0: 8, y1: 9 },               // 7 touches 8 (short)
            { type: 'box', electrode: 'a', x0: 3.5, x1: 4.5, y0: 8, y1: 9 },               // 8
        ],
    };
    const g = compileGeometry(resolved);
    const r0 = rasterize(g, makeGrid(resolved.domain, 0), resolved, {});
    const w = geometryWarnings(g, resolved, r0);
    const has = (code, path) => w.some((i) => i.code === code && (path === undefined || i.path.startsWith(path)));
    assert.ok(has('W_SUBCELL', 'shapes[0]'), 'W_SUBCELL');
    assert.ok(has('W_THIN', 'shapes[0]'), 'W_THIN');
    assert.ok(has('W_OUTSIDE', 'shapes[1]'), 'W_OUTSIDE');
    assert.ok(has('W_CLIPPED_AXIS', 'shapes[2]'), 'W_CLIPPED_AXIS');
    assert.ok(has('W_SELF_INTERSECT', 'shapes[3]'), 'W_SELF_INTERSECT');
    assert.ok(has('W_BURIED', 'shapes[4]'), 'W_BURIED');
    assert.ok(!has('W_BURIED', 'shapes[5]'));
    assert.ok(has('W_APERTURE_RES', 'shapes[6]'), 'W_APERTURE_RES');
    assert.ok(has('W_EMPTY_ELECTRODE', 'electrodes[3]'), 'W_EMPTY_ELECTRODE');
    assert.ok(has('W_EXTENT_ROUNDED', 'domain.x'), 'W_EXTENT_ROUNDED');
    assert.ok(has('W_SHORT'), 'W_SHORT');
    for (const i of w) assert.ok(typeof i.message === 'string' && i.message.length > 10);
});
