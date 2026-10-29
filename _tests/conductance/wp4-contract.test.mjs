// WP4 contract test (spec §5.4 item 3, §7.5): every exported name of cad-ui.js, viewer3d.js, orbit.js and colormap.js
// exists with its documented signature and returns structurally valid results on a minimal input.
// viewer3d.js imports 'three' through the page's import map; here a resolve hook maps 'three' to a small fake module
// (a data: URL, nothing is written to disk) and the globals stand in for the DOM, so the viewer's own logic
// (colours, outlines, clipping, display toggles, theme, disposal) runs in Node. The real three.js is exercised in
// the browser checks (wp4-dev.html, wp4-perf.html).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// ---------------------------------------------------------------- fake three.js
const FAKE_THREE = `
export let consoleFn = null;
export function setConsoleFunction(fn) { consoleFn = fn; }
export const SRGBColorSpace = 'srgb';
export const DoubleSide = 2;
export const MathUtils = { degToRad: (d) => d * Math.PI / 180 };
const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export class Color {
  constructor() { this.r = 1; this.g = 1; this.b = 1; }
  setRGB(r, g, b, space) { const f = space === 'srgb' ? lin : (x) => x; this.r = f(r); this.g = f(g); this.b = f(b); return this; }
  setScalar(s) { this.r = this.g = this.b = s; return this; }
  copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
}
export class Vector2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } set(x, y) { this.x = x; this.y = y; return this; } }
export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  clone() { return new Vector3(this.x, this.y, this.z); }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { const l = this.length() || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  getComponent(k) { return [this.x, this.y, this.z][k]; }
  setComponent(k, v) { if (k === 0) this.x = v; else if (k === 1) this.y = v; else this.z = v; return this; }
}
class Box3 {
  constructor(min = new Vector3(), max = new Vector3()) { this.min = min; this.max = max; }
  clone() { return new Box3(this.min.clone(), this.max.clone()); }
  getCenter(v) { return v.set((this.min.x + this.max.x) / 2, (this.min.y + this.max.y) / 2, (this.min.z + this.max.z) / 2); }
  getSize(v) { return v.set(this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z); }
}
export const counters = { geometries: 0, disposedGeometries: 0, renders: 0, wireframes: 0 };
export const created = { meshes: [], renderers: [], planes: [] };
export class BufferAttribute { constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; } }
export class BufferGeometry {
  constructor() { this.attributes = {}; this.disposed = false; counters.geometries++; }
  setAttribute(n, a) { this.attributes[n] = a; return this; }
  getAttribute(n) { return this.attributes[n]; }
  computeVertexNormals() { this.normals = true; }
  computeBoundingBox() {
    const p = this.attributes.position.array, min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < p.length; i += 3) {
      min.x = Math.min(min.x, p[i]); min.y = Math.min(min.y, p[i + 1]); min.z = Math.min(min.z, p[i + 2]);
      max.x = Math.max(max.x, p[i]); max.y = Math.max(max.y, p[i + 1]); max.z = Math.max(max.z, p[i + 2]);
    }
    this.boundingBox = new Box3(min, max);
  }
  computeBoundingSphere() {}
  dispose() { if (!this.disposed) { this.disposed = true; counters.disposedGeometries++; } }
}
export class WireframeGeometry extends BufferGeometry { constructor(g) { super(); this.source = g; counters.wireframes++; } }
class Object3D {
  constructor() { this.children = []; this.visible = true; this.position = new Vector3(); }
  add(...o) { this.children.push(...o); return this; }
  remove(o) { this.children = this.children.filter((c) => c !== o); return this; }
}
export class Scene extends Object3D {}
export class PerspectiveCamera extends Object3D {
  constructor(fov, aspect, near, far) { super(); this.fov = fov; this.aspect = aspect; this.near = near; this.far = far; this.up = new Vector3(0, 1, 0); this.looked = null; }
  lookAt(x, y, z) { this.looked = [x, y, z]; }
  updateProjectionMatrix() {}
}
export class HemisphereLight extends Object3D { constructor() { super(); this.color = new Color(); this.groundColor = new Color(); this.intensity = 1; } }
export class DirectionalLight extends Object3D { constructor() { super(); this.color = new Color(); this.intensity = 1; this.target = new Object3D(); } }
class Material {
  constructor(p = {}) { Object.assign(this, p); this.color = new Color(); this.clippingPlanes = null; this.needsUpdate = false; this.disposed = false; }
  dispose() { this.disposed = true; }
}
export class MeshLambertMaterial extends Material {}
export class LineBasicMaterial extends Material {}
export class Mesh extends Object3D { constructor(g, m) { super(); this.geometry = g; this.material = m; created.meshes.push(this); } }
export class LineSegments extends Mesh {}
export class Plane {
  constructor(normal = new Vector3(1, 0, 0), constant = 0) { this.normal = normal; this.constant = constant; created.planes.push(this); }
  distanceToPoint(p) { return this.normal.x * p.x + this.normal.y * p.y + this.normal.z * p.z + this.constant; }
}
export const raycast = { hits: [] };
export class Raycaster { setFromCamera() {} intersectObject() { return raycast.hits; } }
export class WebGLRenderer {
  constructor(o) { this.options = o; this.localClippingEnabled = false; this.clear = null; this.size = null; this.disposed = false; created.renderers.push(this); }
  setPixelRatio(r) { this.pixelRatio = r; }
  setSize(w, h) { this.size = [w, h]; }
  setClearColor(c) { this.clear = { r: c.r, g: c.g, b: c.b }; }
  render() { counters.renders++; }
  dispose() { this.disposed = true; }
}
`;
const FAKE_URL = 'data:text/javascript,' + encodeURIComponent(FAKE_THREE);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'three') return { url: FAKE_URL, format: 'module', shortCircuit: true };
    return next(specifier, context);
  },
});

// ---------------------------------------------------------------- fake DOM
const TOKENS = {
  '--surface': '#ffffff', '--border-strong': '#cbd5e1', '--border': '#e2e8f0', '--c1': '#1d4ed8', '--c2': '#ea580c',
  '--c3': '#059669', '--c4': '#7c3aed', '--c6': '#0891b2', '--muted': '#5f6b7e', '--text-2': '#334155',
};
function listenerHost(extra = {}) {
  const map = new Map();
  return Object.assign({
    addEventListener(t, f) { if (!map.has(t)) map.set(t, new Set()); map.get(t).add(f); },
    removeEventListener(t, f) { map.get(t)?.delete(f); },
    dispatch(t, ev = {}) { for (const f of map.get(t) || []) f({ type: t, preventDefault() {}, ...ev }); },
    listenerCount() { let n = 0; for (const s of map.values()) n += s.size; return n; },
  }, extra);
}
function fakeElement(tag) {
  const attrs = {};
  return listenerHost({
    tagName: tag.toUpperCase(), style: {}, children: [], parentNode: null, textContent: '', className: '', clientWidth: 640, clientHeight: 480,
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return attrs[k] ?? null; }, attrs,
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 480 }; },
    setPointerCapture() {}, releasePointerCapture() {},
  });
}
let webglAvailable = false;
const fakeGl = { fake: 'webgl2' };
globalThis.document = listenerHost({
  documentElement: {},
  createElement(tag) {
    const e = fakeElement(tag);
    if (tag === 'canvas') e.getContext = (kind) => (webglAvailable && kind === 'webgl2' ? fakeGl : null);
    return e;
  },
});
globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => ' ' + (TOKENS[n] || '') + ' ' });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.matchMedia = () => listenerHost({ matches: false });
globalThis.devicePixelRatio = 1;

const colormap = await import('../../beta/conductance/js/ui/colormap.js');
const orbit = await import('../../beta/conductance/js/ui/orbit.js');
const cad = await import('../../beta/conductance/js/ui/cad-ui.js');
const viewer3d = await import('../../beta/conductance/js/ui/viewer3d.js');
const THREE = await import('three');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sRGBlin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const tokenLin = (name) => { const h = TOKENS[name].slice(1); return [0, 2, 4].map((k) => sRGBlin(parseInt(h.slice(k, k + 2), 16) / 255)); };
const close3 = (a, b, tol = 1e-6) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);

// ---------------------------------------------------------------- export lists and signatures
test('colormap.js exports (§7.5)', () => {
  assert.equal(colormap.VIRIDIS_ANCHORS.length, 16);
  assert.equal(typeof colormap.viridis, 'function');
  assert.equal(colormap.viridis.length, 1);
  assert.equal(typeof colormap.logScale, 'function');
  assert.equal(colormap.logScale.length, 1);
  const s = colormap.logScale([0.5, 0.01]);
  assert.ok(s.t instanceof Float32Array);
  for (const k of ['t', 'min', 'max', 'ticks']) assert.ok(k in s);
  assert.equal(colormap.viridis(0.5).length, 3);
});

test('orbit.js exports (§4.5, §7.5)', () => {
  for (const [name, n] of [['attachOrbit', 2], ['sphericalFromVector', 1], ['vectorFromSpherical', 1], ['panOffset', 6], ['dollyDistance', 4]]) {
    assert.equal(typeof orbit[name], 'function', name);
    assert.equal(orbit[name].length, n, name + '.length');
  }
  const s = orbit.sphericalFromVector({ x: 1, y: 1, z: 1 });
  for (const k of ['radius', 'theta', 'phi']) assert.ok(Number.isFinite(s[k]));
  const v = orbit.vectorFromSpherical(s);
  for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(v[k] - 1) < 1e-12);
  const o = orbit.panOffset({ right: [1, 0, 0], up: [0, 1, 0] }, 1, 1, 1, 1, 100);
  for (const k of ['x', 'y', 'z']) assert.ok(Number.isFinite(o[k]));
  assert.equal(orbit.dollyDistance(1, 2, 0, 10), 2);
  // attachOrbit returns { update, reset, dispose }
  const cv = fakeElement('canvas'), cam = { fov: 40, position: new THREE.Vector3(0, 0, 5), up: new THREE.Vector3(0, 1, 0), lookAt() {} };
  const ctl = orbit.attachOrbit(cv, cam, { target: new THREE.Vector3(), onChange() {} });
  for (const k of ['update', 'reset', 'dispose']) assert.equal(typeof ctl[k], 'function', k);
  ctl.dispose();
  assert.equal(cv.listenerCount(), 0);
});

test('cad-ui.js exports mount(root, ctx) and its pure helpers', () => {
  assert.equal(typeof cad.mount, 'function');
  assert.equal(cad.mount.length, 1);
  const names = ['runEnable', 'stickFromSpeed', 'speedFromStick', 'maxSpeed', 'changeEffect', 'summarizeCounts', 'formatMatrix',
    'fmtAlphaCI', 'fmtAlpha', 'wallPressureValues', 'pressureColors', 'trianglePatches', 'bboxText', 'referenceLine', 'statusLine',
    'parseSeed', 'triangleCapMessage', 'createPrepClient', 'portArea', 'pumpProblem', 'portSpecsForScene', 'portSpecsForProject',
    'sourceTitle', 'latheMesh', 'profileFormat', 'profileScale', 'profileBboxText', 'profileFormula'];
  for (const n of names) assert.equal(typeof cad[n], 'function', n);
  assert.equal(typeof cad.CadController, 'function');
  assert.deepEqual(cad.BUILTIN_CHIPS.map((b) => b.name), ['tube', 'elbow', 'cone', 'annulus', 'rect']);
  assert.deepEqual(cad.BUILTIN_CHIPS.map((b) => b.label), ['Tube', 'Elbow', 'Cone', 'Annulus', 'Rect duct']);
  assert.deepEqual(Object.keys(cad.FILE_UNITS), ['mm', 'cm', 'm', 'in', 'µm']);
  assert.deepEqual(cad.ROLE_TOKENS, { inlet: '--c3', outlet: '--c1', pump: '--c4', closed: '--muted' });
  assert.equal(cad.SELECTION_TOKEN, '--c2');
  assert.equal(cad.DEFAULT_BUILTIN, 'elbow');
  const en = cad.runEnable({ phase: 'empty' });
  assert.equal(en.ok, false);
  assert.equal(typeof en.reason, 'string');
});

// ---------------------------------------------------------------- viewer3d.js
test('createViewer without WebGL shows the message, logs nothing and returns a no-op viewer', async () => {
  webglAvailable = false;
  assert.equal(viewer3d.createViewer.length, 1);
  const box = fakeElement('div');
  let ready = null;
  const v = await viewer3d.createViewer(box, { onReady: (x) => { ready = x; } });
  await sleep(0);
  assert.equal(ready, v);
  assert.equal(v.webgl, false);
  assert.equal(v.canvas, null);
  for (const k of ['setMesh', 'setColors', 'setPaths', 'setClip', 'setDisplay', 'resetView', 'setTheme', 'dispose']) assert.equal(typeof v[k], 'function', k);
  assert.equal(box.children.length, 1);
  assert.equal(box.children[0].textContent, 'This browser cannot show 3D graphics. The simulation still runs; results appear below.');
  v.setMesh(new Float32Array(9), new Int16Array(1), {});
  v.setColors(null); v.setPaths([]); v.setClip('x', 0.5, false); v.setDisplay({ wireframe: true }); v.resetView('+x'); v.setTheme();
  v.dispose();
  assert.equal(box.children.length, 0);
});

// three triangles: two walls and one cap (port 0); the box is 0…2 × 0…1 × 0…1
const POS = Float32Array.from([
  0, 0, 0, 2, 0, 0, 2, 1, 0,
  0, 0, 0, 2, 1, 0, 0, 1, 1,
  0, 0, 0, 0, 1, 0, 0, 0, 1,
]);
function mainMesh() {
  const ms = THREE.created.meshes.filter((m) => m.material instanceof THREE.MeshLambertMaterial);
  return ms[ms.length - 1];
}
function lines() { return THREE.created.meshes.filter((m) => m instanceof THREE.LineSegments); }
const colorOf = (t) => Array.from(mainMesh().geometry.getAttribute('color').array.slice(9 * t, 9 * t + 3));
const vertexColorsUniform = (t) => {
  const a = mainMesh().geometry.getAttribute('color').array;
  for (let k = 3; k < 9; k++) if (a[9 * t + k] !== a[9 * t + (k % 3)]) return false;
  return true;
};

test('createViewer with WebGL: API, colours by role, pressure colours, no-data and selection colours', async () => {
  webglAvailable = true;
  const box = fakeElement('div');
  let ready = false;
  const v = await viewer3d.createViewer(box, { onReady: () => { ready = true; } });
  await sleep(0);
  assert.ok(ready);
  assert.equal(v.webgl, true);
  assert.equal(v.canvas.getAttribute('role'), 'img');
  assert.equal(v.canvas.getAttribute('tabindex'), '0');
  assert.ok(box.children.includes(v.canvas));
  assert.equal(typeof THREE.consoleFn, 'function', 'three.js messages are routed away from the console');
  const renderer = THREE.created.renderers[THREE.created.renderers.length - 1];
  assert.equal(renderer.options.context, fakeGl, 'the renderer uses the context that passed the WebGL 2 check');
  assert.equal(renderer.localClippingEnabled, true);
  assert.ok(close3([renderer.clear.r, renderer.clear.g, renderer.clear.b], tokenLin('--surface')), 'background is --surface');
  for (const k of ['setMesh', 'setColors', 'setPaths', 'setClip', 'setDisplay', 'resetView', 'setTheme', 'dispose']) assert.equal(typeof v[k], 'function', k);

  const triPort = Int16Array.from([-1, -1, 0]);
  v.setMesh(POS, triPort, { 0: '--c3' });
  const geo = mainMesh().geometry;
  assert.equal(geo.getAttribute('position').array, POS, 'positions are used by reference');
  assert.ok(geo.normals, 'normals are computed');
  assert.ok(close3(colorOf(0), tokenLin('--border-strong')), 'walls are --border-strong');
  assert.ok(close3(colorOf(2), tokenLin('--c3')), 'an inlet is --c3');
  for (let t = 0; t < 3; t++) assert.ok(vertexColorsUniform(t), 'the three vertices of a triangle share its colour');
  assert.equal(v.info().outlineSegments, 3, 'the cap triangle is outlined by its three edges');
  // the same positions again: recolour only
  v.setMesh(POS, Int16Array.from([-1, 1, 0]), { 0: '--c1', 1: [255, 0, 0] });
  assert.equal(mainMesh().geometry, geo, 'no new geometry for the same positions');
  assert.ok(close3(colorOf(2), tokenLin('--c1')));
  assert.ok(close3(colorOf(1), [1, 0, 0]), 'an [r, g, b] port colour');
  // pressure colours: NaN = not enough hits (--border); ports keep their colours
  const rgb = Float32Array.from([0.5, 0.25, 1, NaN, NaN, NaN, 0, 0, 0]);
  v.setMesh(POS, triPort, { 0: '--c3' });
  v.setColors(rgb);
  assert.ok(close3(colorOf(0), [sRGBlin(0.5), sRGBlin(0.25), 1], 2e-3), 'map colour (sRGB → linear)');
  assert.ok(close3(colorOf(1), tokenLin('--border')), 'not enough hits is --border');
  assert.ok(close3(colorOf(2), tokenLin('--c3')), 'ports keep their own colour');
  v.setColors(null);
  assert.ok(close3(colorOf(0), tokenLin('--border-strong')));
  // a pending selection uses any id with a colour, here −2 in --c2
  v.setMesh(POS, Int16Array.from([-2, -1, 0]), { 0: '--c3', [-2]: '--c2' });
  assert.ok(close3(colorOf(0), tokenLin('--c2')));
  assert.equal(v.info().outlineSegments, 6, 'the selection is outlined too');
  // theme change: tokens are re-read on the document's themechange event
  TOKENS['--border-strong'] = '#2d3b5c';
  TOKENS['--surface'] = '#111a2e';
  document.dispatch('themechange');
  assert.ok(close3(colorOf(1), tokenLin('--border-strong')), 'walls follow the dark theme');
  assert.ok(close3([renderer.clear.r, renderer.clear.g, renderer.clear.b], tokenLin('--surface')));
  TOKENS['--border-strong'] = '#cbd5e1';
  TOKENS['--surface'] = '#ffffff';
  v.setTheme();
  assert.ok(close3(colorOf(1), tokenLin('--border-strong')));
  v.dispose();
});

test('viewer: clipping plane, display toggles, trajectories, views, rendering on demand and disposal', async () => {
  webglAvailable = true;
  const box = fakeElement('div');
  const before = document.listenerCount();
  const v = await viewer3d.createViewer(box, {});
  v.setMesh(POS, Int16Array.from([-1, -1, 0]), { 0: '--c3' });
  const mat = mainMesh().material;
  assert.ok(!mat.clippingPlanes || mat.clippingPlanes.length === 0, 'no clipping by default');
  v.setClip('x', 0.25, false);
  assert.equal(mat.clippingPlanes.length, 1);
  const plane = mat.clippingPlanes[0];
  assert.deepEqual([plane.normal.x, plane.normal.y, plane.normal.z], [-1, 0, 0]);
  assert.ok(Math.abs(plane.constant - 0.5) < 1e-3, 'the plane sits a quarter of the way across x (0…2): ' + plane.constant);
  assert.ok(plane.distanceToPoint({ x: 0.1, y: 0, z: 0 }) > 0 && plane.distanceToPoint({ x: 1, y: 0, z: 0 }) < 0, 'keeps the low side');
  for (const l of lines()) if (l.material.clippingPlanes && l.material.clippingPlanes.length) assert.equal(l.material.clippingPlanes[0], plane, 'lines share the plane');
  v.setClip('x', 0.25, true);
  assert.deepEqual([plane.normal.x, plane.normal.y, plane.normal.z], [1, 0, 0]);
  assert.ok(plane.distanceToPoint({ x: 1, y: 0, z: 0 }) > 0, 'flip keeps the high side');
  v.setClip('z', 1, false);
  assert.ok(plane.distanceToPoint({ x: 0, y: 0, z: 1 }) >= 0, 'offset 1 keeps everything');
  v.setClip(null);
  assert.equal(mat.clippingPlanes.length, 0);
  // wireframe and trajectories
  assert.equal(v.setDisplay({ wireframe: true }).wireframe, true);
  assert.equal(v.info().wireframe, true);
  v.setDisplay({ wireframe: false });
  assert.equal(v.info().wireframe, false);
  v.setPaths([Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0])]);
  assert.equal(v.info().paths, true);
  const pathLine = lines().filter((l) => l.material.opacity === 0.6).pop();
  assert.equal(pathLine.geometry.getAttribute('position').array.length, 12, 'two segments');
  v.setDisplay({ paths: false });
  assert.equal(v.info().paths, false);
  v.setPaths([]);
  // views: the camera looks at the box centre from the requested side, outside the bounding sphere
  const info0 = v.info();
  assert.ok(info0.diag > 2.4 && info0.diag < 2.5);
  v.resetView('+x');
  const st = v.info().camera;
  assert.ok(Math.abs(st.target[0] - 1) < 1e-9 && Math.abs(st.target[1] - 0.5) < 1e-9 && Math.abs(st.target[2] - 0.5) < 1e-9);
  assert.ok(Math.abs(st.theta - Math.PI / 2) < 1e-6 && Math.abs(st.phi - Math.PI / 2) < 1e-6, 'looking from +x');
  assert.ok(st.radius > info0.diag / 2);
  v.resetView('+y');
  assert.ok(v.info().camera.phi >= 0.01 - 1e-12, 'never exactly on the pole');
  const r0 = THREE.counters.renders;
  await sleep(5);
  assert.ok(THREE.counters.renders > r0, 'changes request a render');
  const r1 = THREE.counters.renders;
  await sleep(20);
  assert.equal(THREE.counters.renders, r1, 'no continuous render loop');
  assert.ok(v.renderNow() >= 0);
  v.dispose();
  assert.equal(document.listenerCount(), before, 'the theme listener is removed');
  assert.ok(!box.children.includes(v.canvas), 'the canvas is removed');
  assert.equal(v.canvas.listenerCount(), 0, 'no listeners left on the canvas');
});

test('viewer: a new model resets the view, the same box keeps it; wireframe is refused above 150 000 triangles', async () => {
  webglAvailable = true;
  const v = await viewer3d.createViewer(fakeElement('div'), {});
  v.setMesh(POS, Int16Array.from([-1, -1, 0]), {});
  v.resetView('+z');
  const st = v.info().camera;
  // the same box with one more (cap) triangle: the camera stays
  const more = new Float32Array(POS.length + 9); more.set(POS); more.set([0, 0, 0, 0, 1, 1, 0, 0, 1], POS.length);
  v.setMesh(more, Int16Array.from([-1, -1, 0, 0]), { 0: '--c3' });
  assert.deepEqual(v.info().camera, st);
  // a different model: back to the iso view of the new box
  const scaled = POS.map((x) => x * 10);
  v.setMesh(scaled, Int16Array.from([-1, -1, 0]), {});
  assert.ok(v.info().diag > 24);
  assert.ok(Math.abs(v.info().camera.target[0] - 10) < 1e-6);
  // 150 001 triangles: no wireframe
  const n = 150001, big = new Float32Array(9 * n);
  for (let t = 0; t < n; t++) big.set([t, 0, 0, t + 1, 0, 0, t, 1, 0], 9 * t);
  v.setMesh(big, new Int16Array(n).fill(-1), {});
  assert.equal(v.setDisplay({ wireframe: true }).wireframe, false);
  assert.equal(v.info().triangles, n);
  v.dispose();
});

test('viewer: picking reports the triangle (= prepared-mesh index) and skips hits on the clipped side', async () => {
  webglAvailable = true;
  const picks = [];
  const v = await viewer3d.createViewer(fakeElement('div'), { onPick: (h) => picks.push(h) });
  v.setMesh(POS, Int16Array.from([-1, -1, 0]), { 0: '--c3' });
  THREE.raycast.hits = [{ faceIndex: 2, point: { x: 0, y: 0.2, z: 0.2 } }];
  const cv = v.canvas;
  cv.dispatch('pointerdown', { pointerId: 7, clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' });
  cv.dispatch('pointerup', { pointerId: 7, clientX: 102, clientY: 101, button: 0, pointerType: 'mouse' });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].tri, 2);
  assert.equal(picks[0].port, 0);
  // a drag is not a pick
  cv.dispatch('pointerdown', { pointerId: 8, clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' });
  cv.dispatch('pointerup', { pointerId: 8, clientX: 140, clientY: 100, button: 0, pointerType: 'mouse' });
  assert.equal(picks.length, 1);
  // a hit on the clipped-away side is skipped
  v.setClip('x', 0.25, false);                      // keeps x ≤ 0.5
  THREE.raycast.hits = [{ faceIndex: 0, point: { x: 1.5, y: 0.1, z: 0 } }, { faceIndex: 1, point: { x: 0.2, y: 0.5, z: 0.5 } }];
  cv.dispatch('pointerdown', { pointerId: 9, clientX: 10, clientY: 10, button: 0, pointerType: 'mouse' });
  cv.dispatch('pointerup', { pointerId: 9, clientX: 10, clientY: 10, button: 0, pointerType: 'mouse' });
  assert.equal(picks[1].tri, 1);
  THREE.raycast.hits = [];
  cv.dispatch('pointerdown', { pointerId: 10, clientX: 10, clientY: 10, button: 0, pointerType: 'mouse' });
  cv.dispatch('pointerup', { pointerId: 10, clientX: 10, clientY: 10, button: 0, pointerType: 'mouse' });
  assert.equal(picks[2], null, 'empty space gives null');
  v.dispose();
});

test('portOutlineSegments and parseCssColor', () => {
  // a square cap of two triangles: 4 boundary edges, the diagonal is shared
  const pos = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
  const o = viewer3d.portOutlineSegments(pos, Int16Array.from([3, 3]), (p) => p >= 0);
  assert.equal(o.ids.length, 4);
  assert.ok(o.ids.every((id) => id === 3));
  assert.equal(o.positions.length, 24);
  assert.equal(viewer3d.portOutlineSegments(pos, Int16Array.from([-1, -1]), (p) => p >= 0).ids.length, 0);
  assert.deepEqual(viewer3d.parseCssColor('#0891b2'), [8, 145, 178]);
  assert.deepEqual(viewer3d.parseCssColor('rgb(10, 20, 30)'), [10, 20, 30]);
  assert.deepEqual(viewer3d.parseCssColor('rgba(110 168 254 / 0.12)'), [110, 168, 254]);
  assert.deepEqual(viewer3d.parseCssColor('#abc'), [170, 187, 204]);
  assert.equal(viewer3d.parseCssColor('color-mix(in srgb, red, blue)'), null);
});
