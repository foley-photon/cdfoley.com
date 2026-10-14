// WP3 acceptance 9 (P2): axisymmetric 2D profiles from SVG and DXF to Components items (spec §3.6.8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSVGProfile, parseDXFProfile, profileToItems, PROFILE_REFUSAL } from '../../beta/conductance/js/io/profile2d.js';
import { validateItem } from '../../beta/conductance/js/engine/elements.js';
import { gasState } from '../../beta/conductance/js/engine/gas.js';

const fx = (name) => readFileSync(fileURLToPath(new URL('./fixtures/wp3/' + name, import.meta.url)), 'utf8');
const N2 = gasState('N2', 293.15);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' ' + a + ' vs ' + b);
const refused = (err) => err instanceof RangeError && err.message === PROFILE_REFUSAL;
const items = (pts, opts = { scale: 0.001, axis: 'zero' }) => profileToItems(pts.map((p) => Float64Array.from(p)), opts).items;
const valid = (list) => { for (const it of list) assert.deepEqual(validateItem(it, { G: N2, where: 'top', isLast: false }), [], JSON.stringify(it)); };
const dxf = (units, entities) => {
  const g = (c, v) => `${c}\n${v}\n`;
  let s = '';
  if (units !== null) s += g(0, 'SECTION') + g(2, 'HEADER') + g(9, '$INSUNITS') + g(70, units) + g(0, 'ENDSEC');
  return s + g(0, 'SECTION') + g(2, 'ENTITIES') + entities.map((e) => e.map(([c, v]) => g(c, v)).join('')).join('') + g(0, 'ENDSEC') + g(0, 'EOF');
};
const LINE = (x1, y1, x2, y2) => [[0, 'LINE'], [8, '0'], [10, x1], [20, y1], [11, x2], [21, y2]];

test('an SVG of a Ø40 × 100 mm tube with a 20° cone gives [tube, cone] in millimetres', () => {
  const p = parseSVGProfile(fx('tube-cone-mm.svg'));
  assert.equal(p.unitHint, 'mm');
  assert.match(p.warnings.join(' '), /1 circle, ellipse, text or image was ignored/);
  const r = profileToItems(p.paths, { scale: 0.001, axis: 'min' });
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map((i) => i.t), ['tube', 'cone']);
  const [t, c] = r.items;
  near(t.d * 1000, 40, 1e-9, 'tube Ø');
  near(t.L * 1000, 100, 1e-9, 'tube length');
  near(c.d1 * 1000, 40, 1e-9, 'cone inlet Ø');
  near(c.d2 * 1000, 2 * (20 + 40 * Math.tan(20 * Math.PI / 180)), 1e-3, 'cone outlet Ø');
  near(c.L * 1000, 40, 1e-9, 'cone length');
  near(Math.atan((c.d2 - c.d1) / 2 / c.L) * 180 / Math.PI, 20, 1e-3, 'half-angle');
  valid(r.items);
  // the display outline: (r, z) pairs in metres from the inlet, outer wall only here
  assert.ok(r.lathe instanceof Float64Array);
  assert.deepEqual(Array.from(r.lathe.subarray(0, 4)).map((x) => Math.round(x * 1e9) / 1e9), [0.02, 0, 0.02, 0.1]);
  assert.equal(r.lathe.length, 6);
});

test('a DXF in inches with $INSUNITS = 1 scales correctly', () => {
  const p = parseDXFProfile(fx('tube-in.dxf'));
  assert.equal(p.unitHint, 'in');
  assert.deepEqual(p.warnings, [], 'the TEXT entity is ignored quietly');
  const r = profileToItems(p.paths, { scale: 0.0254, axis: 'min' });
  assert.deepEqual(r.items, [{ t: 'tube', d: 0.0508, L: 0.1016 }]);
  // millimetres, centimetres and metres; unknown units leave the choice to the user
  const ent = [LINE(0, 0, 50, 0), LINE(0, 0, 0, 10), LINE(0, 10, 50, 10), LINE(50, 0, 50, 10)];
  assert.equal(parseDXFProfile(dxf(4, ent)).unitHint, 'mm');
  const cm = parseDXFProfile(dxf(5, ent));
  assert.equal(cm.unitHint, 'mm');
  assert.deepEqual(profileToItems(cm.paths, { scale: 0.001, axis: 'min' }).items, [{ t: 'tube', d: 0.2, L: 0.5 }]);
  const m = parseDXFProfile(dxf(6, ent));
  assert.deepEqual(profileToItems(m.paths, { scale: 0.001, axis: 'min' }).items, [{ t: 'tube', d: 20, L: 50 }]);
  const none = parseDXFProfile(dxf(null, ent));
  assert.equal(none.unitHint, null);
  const odd = parseDXFProfile(dxf(2, ent));
  assert.equal(odd.unitHint, null);
  assert.match(odd.warnings.join(' '), /\$INSUNITS = 2\) is not supported; pick the unit/);
});

test('a path that doubles back in z, branches, sloped inner bodies and crossings of the axis are refused', () => {
  const p = parseSVGProfile(fx('doubled-back.svg'));
  assert.throws(() => profileToItems(p.paths, { scale: 0.001, axis: 'min' }), refused);
  assert.throws(() => items([[0, 20, 100, 20, 80, 30, 150, 30]]), refused);
  assert.throws(() => items([[0, 20, 100, 20], [100, 20, 200, 20], [100, 20, 150, 30]]), refused, 'a branch');
  assert.throws(() => items([[0, 20, 100, 20], [20, 0, 20, 5, 80, 8, 80, 0]]), refused, 'a sloped rod');
  assert.throws(() => items([[0, 20, 100, 30], [20, 0, 20, 5, 80, 5, 80, 0]]), refused, 'a cone around a rod');
  assert.throws(() => items([[0, 20, 100, 20], [0, -20, 100, -20]]), refused, 'drawn on both sides of the axis');
  assert.throws(() => items([[0, 20, 50, 20]], { scale: 0, axis: 'zero' }), /Pick the unit/);
  assert.equal(PROFILE_REFUSAL, 'This profile is not a simple axisymmetric passage; export the 3D model as STL instead.');
});

test('steps need no item; plates of zero thickness become orifices; rods become annuli', () => {
  // a contraction and an expansion: tubes only
  assert.deepEqual(items([[0, 20, 50, 20, 50, 10, 80, 10, 80, 30, 120, 30]]),
    [{ t: 'tube', d: 0.04, L: 0.05 }, { t: 'tube', d: 0.02, L: 0.03 }, { t: 'tube', d: 0.06, L: 0.04 }]);
  // a plate drawn inside the wall's polyline (down and straight back up), and the same plate as a hanging line
  const plate = [{ t: 'tube', d: 0.04, L: 0.05 }, { t: 'orifice', shape: 'circle', d: 0.01 }, { t: 'tube', d: 0.04, L: 0.05 }];
  assert.deepEqual(items([[0, 20, 50, 20, 50, 5, 50, 20, 100, 20]]), plate);
  assert.deepEqual(items([[0, 20, 50, 20], [50, 20, 100, 20], [50, 20, 50, 5]]), plate);
  assert.deepEqual(items([[0, 20, 100, 20], [50, 20, 50, 5]]), plate, 'a line hanging from the middle of a wall segment');
  assert.deepEqual(items([[0, 20, 100, 20], [50, 5, 50, 20], [50, 20, 50, 5]]), plate, 'the same line drawn twice');
  // a plate between two different bores
  assert.deepEqual(items([[0, 20, 50, 20, 50, 4, 50, 30, 100, 30]]), [{ t: 'tube', d: 0.04, L: 0.05 }, { t: 'orifice', shape: 'circle', d: 0.008 }, { t: 'tube', d: 0.06, L: 0.05 }]);
  // a rod over part of the length, drawn from the axis
  const rod = items([[0, 20, 100, 20], [20, 0, 20, 8, 80, 8, 80, 0]]);
  assert.deepEqual(rod, [{ t: 'tube', d: 0.04, L: 0.02 }, { t: 'annulus', di: 0.016, do: 0.04, L: 0.06 }, { t: 'tube', d: 0.04, L: 0.02 }]);
  valid(rod);
  // a closed outline of an annulus over the whole length (no axis segment at all)
  assert.deepEqual(items([[0, 5, 0, 20, 100, 20, 100, 5, 0, 5]]), [{ t: 'annulus', di: 0.01, do: 0.04, L: 0.1 }]);
  // collinear pieces merge; a curved wall becomes several cones
  assert.deepEqual(items([[0, 20, 30, 20, 60, 20, 100, 30, 140, 40]]), [{ t: 'tube', d: 0.04, L: 0.06 }, { t: 'cone', d1: 0.04, d2: 0.08, L: 0.08 }]);
  // drawn below the axis (r < 0) with the axis at zero
  assert.deepEqual(items([[0, -20, 100, -20]]), [{ t: 'tube', d: 0.04, L: 0.1 }]);
});

test('SVG reading: path commands, curves and arcs flattened to 0.5°, transforms, units and defs', () => {
  const svg = (body, attrs = 'width="100mm" height="100mm" viewBox="0 0 100 100"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
  // relative commands with implicit repeats, H, V, Z
  const a = parseSVGProfile(svg('<path d="m10 80 h 50 v-10 l 20 0 20,0 V 80 z"/>'));
  assert.deepEqual(Array.from(a.paths[0]), [10, -80, 60, -80, 60, -70, 80, -70, 100, -70, 100, -80, 10, -80]);
  // a quarter-circle arc (glued flags) is flattened with chords that turn by at most about 0.5°
  const arc = parseSVGProfile(svg('<path d="M 0 50 A 50 50 0 01 50 0"/>')).paths[0];
  let maxTurn = 0;
  for (let k = 0; k < arc.length; k += 2) near(Math.hypot(arc[k] - 50, arc[k + 1] + 50), 50, 1e-9, 'on the circle');
  for (let k = 4; k < arc.length; k += 2) {
    const u = Math.atan2(arc[k - 1] - arc[k - 3], arc[k - 2] - arc[k - 4]), w = Math.atan2(arc[k + 1] - arc[k - 1], arc[k] - arc[k - 2]);
    maxTurn = Math.max(maxTurn, Math.abs(w - u));
  }
  assert.ok(maxTurn <= 0.5 * Math.PI / 180 + 1e-9, 'turn ' + maxTurn);
  assert.equal(arc.length / 2, 1 + 180);
  // a cubic quarter circle: close to the circle, turning ≤ about 0.5° per chord
  const k = 0.5522847498 * 50;
  const cub = parseSVGProfile(svg(`<path d="M 0 50 C 0 ${50 - k} ${50 - k} 0 50 0"/>`)).paths[0];
  for (let i = 0; i < cub.length; i += 2) near(Math.hypot(cub[i] - 50, cub[i + 1] + 50), 50, 0.02);
  let t2 = 0;
  for (let i = 4; i < cub.length; i += 2) {
    const u = Math.atan2(cub[i - 1] - cub[i - 3], cub[i - 2] - cub[i - 4]), w = Math.atan2(cub[i + 1] - cub[i - 1], cub[i] - cub[i - 2]);
    t2 = Math.max(t2, Math.abs(w - u));
  }
  assert.ok(t2 <= 0.6 * Math.PI / 180, 'cubic turn ' + t2);
  // S, Q and T are accepted; numbers may run together
  const q = parseSVGProfile(svg('<path d="M0,0Q10-10 20,0T40,0S50,10 60,0 L70.5.5"/>')).paths[0];
  assert.deepEqual(Array.from(q.slice(-2)), [70.5, -0.5]);
  // transforms on groups and elements; shapes inside <defs> are ignored; rect, line and polyline are read
  const t = parseSVGProfile(svg('<defs><path d="M0 0 L 999 999"/></defs><g transform="translate(10 20)"><g transform="scale(2)"><line x1="0" y1="0" x2="5" y2="0" transform="rotate(90)"/></g></g><rect x="1" y="2" width="3" height="4"/>'));
  assert.equal(t.paths.length, 2);
  assert.deepEqual(Array.from(t.paths[0]).map((x) => Math.round(x * 1e9) / 1e9 + 0), [10, -20, 10, -30]);
  assert.deepEqual(Array.from(t.paths[1]), [1, -2, 4, -2, 4, -6, 1, -6, 1, -2]);
  // units: inches and pixels (96 per inch) give inches; centimetres give millimetres; plain numbers give no unit
  assert.equal(parseSVGProfile(svg('<polyline points="0,0 96,0"/>', 'width="1in" height="1in" viewBox="0 0 96 96"')).unitHint, 'in');
  const px = parseSVGProfile(svg('<polyline points="0,0 96,0"/>', 'width="96px" height="96px" viewBox="0 0 96 96"'));
  assert.equal(px.unitHint, 'in');
  near(px.paths[0][2], 1, 1e-12, '96 px = 1 in');
  const cm = parseSVGProfile(svg('<polyline points="0,0 10,0"/>', 'width="10cm" height="10cm" viewBox="0 0 10 10"'));
  assert.equal(cm.unitHint, 'mm');
  near(cm.paths[0][2], 100, 1e-12);
  assert.equal(parseSVGProfile(svg('<polyline points="0,0 10,0"/>', 'width="100" height="100"')).unitHint, null);
  assert.match(parseSVGProfile(svg('<polyline points="0,0 10,0"/>', 'width="100mm" height="50mm" viewBox="0 0 100 100"')).warnings.join(' '), /scaled differently/);
  assert.throws(() => parseSVGProfile('<html><body/></html>'), /not an SVG file/);
  assert.throws(() => parseSVGProfile(svg('<circle cx="5" cy="5" r="2"/>')), /contains no lines or paths/);
  assert.throws(() => parseSVGProfile(svg('<path d="M 0 0 A 1 1 0 2 1 5 5"/>')), /arc flags are malformed/);
});

test('DXF reading: LWPOLYLINE bulges, POLYLINE/VERTEX, ARC; malformed files', () => {
  // a rounded inlet: a 90° bulge (b = tan(22.5°)) from (0, 30) to (10, 20), then a straight wall
  const lw = [[0, 'LWPOLYLINE'], [8, '0'], [90, 3], [70, 0], [10, 0], [20, 30], [42, -Math.tan(Math.PI / 8)], [10, 10], [20, 20], [10, 60], [20, 20]];
  const p = parseDXFProfile(dxf(4, [lw]));
  const pts = p.paths[0];
  for (let k = 2; k < pts.length - 4; k += 2) near(Math.hypot(pts[k] - 0, pts[k + 1] - 20), 10, 1e-9, 'arc point');
  const r = profileToItems(p.paths, { scale: 0.001, axis: 'zero' });
  assert.equal(r.items[r.items.length - 1].t, 'tube');
  near(r.items[r.items.length - 1].L, 0.05, 1e-12);
  assert.ok(r.items.slice(0, -1).every((i) => i.t === 'cone'), 'the rounded entrance is a series of short cones');
  near(r.items[0].d1, 0.06, 1e-9);
  // POLYLINE with VERTEX entities and an ARC
  const poly = [[[0, 'POLYLINE'], [8, '0'], [66, 1], [70, 0]], [[0, 'VERTEX'], [8, '0'], [10, 0], [20, 10]], [[0, 'VERTEX'], [8, '0'], [10, 40], [20, 10]], [[0, 'SEQEND'], [8, '0']],
    [[0, 'ARC'], [8, '0'], [10, 0], [20, 0], [40, 5], [50, 0], [51, 90]], [[0, 'SPLINE'], [8, '0']]];
  const q = parseDXFProfile(dxf(4, poly));
  assert.equal(q.paths.length, 2);
  assert.deepEqual(Array.from(q.paths[0]), [0, 10, 40, 10]);
  near(q.paths[1][0], 5, 1e-12); near(q.paths[1][q.paths[1].length - 1], 5, 1e-12);
  assert.match(q.warnings.join(' '), /Ignored 1 SPLINE/);
  assert.throws(() => parseDXFProfile('hello\nworld\n'), /malformed at line 1|not an ASCII DXF/);
  assert.throws(() => parseDXFProfile('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n'), /contains no lines, polylines or arcs/);
  assert.throws(() => parseDXFProfile('999\ncomment only\n'), /not an ASCII DXF file/);
});
