// three.js viewer of the CAD tab (spec §4.5, §7.5). The only module that imports 'three' (through the page's import
// map). Written for this site; no three.js add-on code (H5, H11): the orbit controls are ./orbit.js.
//
//   createViewer(container, { onPick, onReady }) → Viewer
//   Viewer = { setMesh(positions, triPort, portColors), setColors(rgbPerTri), setPaths(paths),
//              setClip(axis | null, offset01, flip), setDisplay({ wireframe, paths }), resetView(dir?),
//              setTheme(), dispose(), canvas,
//              renderNow(), info(), webgl }                         (the last three are additions for tests)
//
// setMesh(positions, triPort, portColors)
//   positions:  Float32Array, 9 numbers per triangle (metres): the prepared mesh followed by the port caps. Kept by
//               reference (not copied): pass the same array again to recolour without rebuilding the geometry.
//   triPort:    Int16Array, one entry per triangle: a port id, or −1 for walls. Any value listed in portColors is
//               drawn in that colour (cad-ui uses −2 for a pending selection); other values are walls.
//   portColors: { [id]: colour } where colour is a CSS custom property name ('--c3'), a hex colour, or [r, g, b]
//               (0–255). Tokens are re-read on theme changes.
// setColors(rgbPerTri)
//   Float32Array(3·nTri) of sRGB components in 0–1 (the pressure map), or null for the role colours. Port triangles
//   keep their port colour; a NaN red component draws the triangle in --border ("not enough hits").
// setPaths(paths): array of Float32Array xyz polylines (metres), drawn as one LineSegments in --c6 at 60 % opacity.
// setClip(axis, offset01, flip): axis 'x' | 'y' | 'z' or null; the plane sits at offset01 across the bounding box
//   and keeps the low side (or the high side with flip).
// resetView(dir): '+x', '−x' (or '-x'), '+y', '-y', '+z', '-z' or 'iso' (default).
//
// Rendering is on demand (after camera and data changes), never in a continuous loop. Without WebGL 2 (three.js
// r186 needs it) the container shows a message and every method is a no-op. three.js's own log, warn and error
// calls are routed away from the console (H13).
import * as THREE from 'three';
import { attachOrbit } from './orbit.js';

const FOV = 40;
const WIREFRAME_MAX_TRI = 150000;
const PICK_MOVE_PX = 4;
const NO_WEBGL = 'This browser cannot show 3D graphics. The simulation still runs; results appear below.';
const TOKENS = {
  background: '--surface', wall: '--border-strong', noData: '--border', paths: '--c6', wire: '--text-2',
};

const sink = { last: [] };
function quiet(level, message, ...rest) {
  // keep the last few messages for debugging (never printed)
  sink.last.push([level, String(message), ...rest.map(String)]);
  if (sink.last.length > 20) sink.last.shift();
}

/** Parses '#rgb', '#rrggbb', '#rrggbbaa', 'rgb(…)' or 'rgba(…)' into [r, g, b] (0–255), or null. */
export function parseCssColor(text) {
  const s = String(text || '').trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = /^rgba?\(\s*([^)]*)\)$/i.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    if (parts.length < 3) return null;
    const v = parts.map((p) => (p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p)));
    return v.every(Number.isFinite) ? v.map((x) => Math.max(0, Math.min(255, x))) : null;
  }
  m = /^color\(\s*srgb\s+([^)]*)\)$/i.exec(s);
  if (m) {
    const v = m[1].split(/[\s/]+/).filter(Boolean).slice(0, 3).map(parseFloat);
    return v.length === 3 && v.every(Number.isFinite) ? v.map((x) => Math.max(0, Math.min(255, x * 255))) : null;
  }
  return null;
}

function readToken(name) {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return null;
  return parseCssColor(getComputedStyle(document.documentElement).getPropertyValue(name));
}

function linearColor(rgb255, fallback) {
  const c = new THREE.Color();
  const v = rgb255 || fallback || [128, 128, 128];
  c.setRGB(v[0] / 255, v[1] / 255, v[2] / 255, THREE.SRGBColorSpace);
  return c;
}

function resolveColor(spec, fallbackToken) {
  if (Array.isArray(spec) && spec.length >= 3) return linearColor(spec);
  if (typeof spec === 'string') {
    if (spec.startsWith('--')) return linearColor(readToken(spec), readToken(fallbackToken));
    return linearColor(parseCssColor(spec), readToken(fallbackToken));
  }
  return linearColor(readToken(fallbackToken));
}

// sRGB (0–1) → linear through a 256-entry table (the pressure colours are 8-bit viridis anyway)
const SRGB_LIN = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  return t;
})();
const lin = (c) => (c > 0 ? (c >= 1 ? 1 : SRGB_LIN[(c * 255 + 0.5) | 0]) : 0);

/**
 * Boundary edges of each port's triangle set (edges used by one triangle of the set), as line-segment positions
 * (6 numbers per edge) and the port id of each segment. Vertices are matched by exact coordinates.
 */
export function portOutlineSegments(positions, triPort, isPort) {
  const byPort = new Map();
  const n = triPort.length;
  for (let t = 0; t < n; t++) {
    const p = triPort[t];
    if (!isPort(p)) continue;
    let list = byPort.get(p);
    if (!list) { list = []; byPort.set(p, list); }
    list.push(t);
  }
  const segs = [], ids = [];
  for (const [p, list] of byPort) {
    const edges = new Map();
    const key = (o) => positions[o] + ',' + positions[o + 1] + ',' + positions[o + 2];
    for (const t of list) {
      const o = 9 * t, k = [key(o), key(o + 3), key(o + 6)];
      for (let e = 0; e < 3; e++) {
        const a = k[e], b = k[(e + 1) % 3];
        const ek = a < b ? a + '|' + b : b + '|' + a;
        const rec = edges.get(ek);
        if (rec) rec.count++;
        else edges.set(ek, { count: 1, oa: o + 3 * e, ob: o + 3 * ((e + 1) % 3) });
      }
    }
    for (const rec of edges.values()) {
      if (rec.count !== 1) continue;
      segs.push(positions[rec.oa], positions[rec.oa + 1], positions[rec.oa + 2], positions[rec.ob], positions[rec.ob + 1], positions[rec.ob + 2]);
      ids.push(p);
    }
  }
  return { positions: new Float32Array(segs), ids };
}

function noWebglViewer(container, onReady) {
  const msg = document.createElement('p');
  msg.className = 'cl-viewer-msg';
  msg.textContent = NO_WEBGL;
  container.appendChild(msg);
  const noop = () => {};
  const v = {
    webgl: false, canvas: null, setMesh: noop, setColors: noop, setPaths: noop, setClip: noop, setDisplay: noop,
    resetView: noop, setTheme: noop, renderNow: () => 0, info: () => ({ webgl: false, triangles: 0 }),
    dispose() { if (msg.parentNode) msg.parentNode.removeChild(msg); },
  };
  if (typeof onReady === 'function') queueMicrotask(() => onReady(v));
  return v;
}

/** Creates the viewer inside `container` (which should have a size). See the header for the API. */
export async function createViewer(container, { onPick, onReady } = {}) {
  if (typeof THREE.setConsoleFunction === 'function') THREE.setConsoleFunction(quiet);
  const canvas = document.createElement('canvas');
  canvas.className = 'cl-viewer-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('tabindex', '0');
  canvas.setAttribute('aria-label', '3D view of the model');
  const attrs = {
    alpha: false, depth: true, stencil: false, antialias: true, premultipliedAlpha: true,
    preserveDrawingBuffer: false, powerPreference: 'default', failIfMajorPerformanceCaveat: false,
  };
  let gl = null;
  try { gl = canvas.getContext('webgl2', attrs); } catch (_) { gl = null; }
  if (!gl) return noWebglViewer(container, onReady);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true });
  } catch (_) {
    return noWebglViewer(container, onReady);
  }
  container.appendChild(canvas);
  renderer.setPixelRatio(Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2));
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.001, 100);
  camera.position.set(1, 1, 1);
  const target = new THREE.Vector3();

  const hemi = new THREE.HemisphereLight();
  hemi.groundColor.setScalar(0.42);
  hemi.intensity = 1.55;
  const head = new THREE.DirectionalLight();
  head.intensity = 1.35;
  head.position.set(0.3, 0.4, 1);
  head.target.position.set(0, 0, -1);
  camera.add(head, head.target);          // a head-light: shines along the view, so the visible side is lit
  scene.add(hemi, camera);

  const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  let clip = { axis: null, offset: 0.5, flip: false };

  const material = new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  let geometry = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = false;
  scene.add(mesh);

  const wireMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false });
  let wire = null;                         // LineSegments, built lazily
  const outlineMat = new THREE.LineBasicMaterial({ vertexColors: true });
  const outlines = new THREE.LineSegments(new THREE.BufferGeometry(), outlineMat);
  outlines.visible = false;
  scene.add(outlines);
  const pathMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false });
  const paths = new THREE.LineSegments(new THREE.BufferGeometry(), pathMat);
  paths.visible = false;
  scene.add(paths);

  const state = {
    positions: null, nTri: 0, triPort: null, portColors: {}, portLin: new Map(), map: null,
    colors: null, outlineIds: [], display: { wireframe: false, paths: true }, hasPaths: false,
    bbox: null, center: new THREE.Vector3(), radius: 1, diag: 1, disposed: false, theme: {},
  };

  // ---------------------------------------------------------------- theme
  function readTheme() {
    const th = {};
    for (const [k, tok] of Object.entries(TOKENS)) th[k] = linearColor(readToken(tok));
    state.theme = th;
    state.portLin = new Map();
    for (const [id, spec] of Object.entries(state.portColors || {})) state.portLin.set(Number(id), resolveColor(spec, TOKENS.wall));
    renderer.setClearColor(th.background, 1);
    wireMat.color.copy(th.wire);
    pathMat.color.copy(th.paths);
  }

  // ---------------------------------------------------------------- colours
  function fillColors() {
    if (!state.colors || !state.triPort) return;
    const C = state.colors, tp = state.triPort, n = state.nTri, map = state.map;
    const wall = state.theme.wall, nd = state.theme.noData, pl = state.portLin;
    for (let t = 0; t < n; t++) {
      let r, g, b;
      const pc = pl.size ? pl.get(tp[t]) : undefined;
      if (pc) { r = pc.r; g = pc.g; b = pc.b; }
      else if (map) {
        const mr = map[3 * t];
        if (Number.isNaN(mr) || mr === undefined) { r = nd.r; g = nd.g; b = nd.b; }
        else { r = lin(mr); g = lin(map[3 * t + 1]); b = lin(map[3 * t + 2]); }
      } else { r = wall.r; g = wall.g; b = wall.b; }
      const o = 9 * t;
      C[o] = r; C[o + 1] = g; C[o + 2] = b;
      C[o + 3] = r; C[o + 4] = g; C[o + 5] = b;
      C[o + 6] = r; C[o + 7] = g; C[o + 8] = b;
    }
    const attr = geometry.getAttribute('color');
    if (attr) attr.needsUpdate = true;
  }

  function fillOutlineColors() {
    const g = outlines.geometry, attr = g.getAttribute('color');
    if (!attr) return;
    const C = attr.array, ids = state.outlineIds, wall = state.theme.wall;
    for (let i = 0; i < ids.length; i++) {
      const c = state.portLin.get(ids[i]) || wall;
      const o = 6 * i;
      C[o] = c.r; C[o + 1] = c.g; C[o + 2] = c.b; C[o + 3] = c.r; C[o + 4] = c.g; C[o + 5] = c.b;
    }
    attr.needsUpdate = true;
  }

  function rebuildOutlines() {
    const old = outlines.geometry;
    const g = new THREE.BufferGeometry();
    if (state.positions && state.triPort) {
      const isPort = (p) => state.portLin.has(p);
      const o = portOutlineSegments(state.positions, state.triPort, isPort);
      state.outlineIds = o.ids;
      if (o.ids.length) {
        g.setAttribute('position', new THREE.BufferAttribute(o.positions, 3));
        g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(o.positions.length), 3));
      }
    } else state.outlineIds = [];
    outlines.geometry = g;
    old.dispose();
    outlines.visible = state.outlineIds.length > 0;
    fillOutlineColors();
  }

  // ---------------------------------------------------------------- camera
  function fitDistance() {
    const v = THREE.MathUtils.degToRad(FOV);
    const h = 2 * Math.atan(Math.tan(v / 2) * Math.max(camera.aspect, 1e-3));
    const half = Math.min(v, h) / 2;
    return (state.radius / Math.sin(half)) * 1.04;
  }

  function updateClipPlanes() {
    const near = Math.max(state.diag * 1e-4, 1e-9), far = Math.max(state.diag * 100, 1e-6);
    if (camera.near !== near || camera.far !== far) { camera.near = near; camera.far = far; camera.updateProjectionMatrix(); }
  }

  const VIEW_DIRS = {
    '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1],
    iso: [1, 0.85, 1.25],
  };

  function resetView(dir = 'iso') {
    const key = String(dir || 'iso').toLowerCase().replace('−', '-');
    const d = VIEW_DIRS[key] || VIEW_DIRS.iso;
    const v = new THREE.Vector3(d[0], d[1], d[2]).normalize();
    if (key === '+y' || key === '-y') v.z += 1e-3;           // stay off the pole; the orbit clamps the polar angle
    target.copy(state.center);
    camera.position.copy(state.center).addScaledVector(v.normalize(), fitDistance());
    orbit.setLimits(0.05 * state.diag, 20 * state.diag);
    orbit.update();
    updateClipPlanes();
    requestRender();
  }

  // ---------------------------------------------------------------- render
  let frame = 0;
  let lastW = 0, lastH = 0;
  function resize() {
    const w = Math.max(1, Math.round(container.clientWidth || canvas.clientWidth || 1));
    const h = Math.max(1, Math.round(container.clientHeight || canvas.clientHeight || 1));
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function renderNow() {
    if (state.disposed) return 0;
    const t0 = performance.now();
    resize();
    renderer.render(scene, camera);
    return performance.now() - t0;
  }

  function requestRender() {
    if (frame || state.disposed) return;
    frame = requestAnimationFrame(() => { frame = 0; renderNow(); });
  }

  const orbit = attachOrbit(canvas, camera, { target, onChange: () => { updateClipPlanes(); requestRender(); }, onReset: () => resetView('iso') });

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { lastW = 0; requestRender(); }) : null;
  if (ro) ro.observe(container);

  // ---------------------------------------------------------------- picking
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let press = null, touches = 0;
  function onDown(e) {
    touches++;
    if (touches > 1) { press = null; return; }
    press = { x: e.clientX, y: e.clientY, id: e.pointerId, ok: e.pointerType !== 'mouse' || e.button === 0 };
  }
  function onUp(e) {
    touches = Math.max(0, touches - 1);
    const p = press;
    if (!p || p.id !== e.pointerId) return;
    press = null;
    if (!p.ok || Math.hypot(e.clientX - p.x, e.clientY - p.y) >= PICK_MOVE_PX || typeof onPick !== 'function') return;
    onPick(pickAt(e.clientX, e.clientY));
  }
  function onCancel() { touches = 0; press = null; }
  function pickAt(clientX, clientY) {
    if (!state.positions || !mesh.visible) return null;
    const r = canvas.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(mesh, false);
    for (const h of hits) {
      if (clip.axis && clipPlane.distanceToPoint(h.point) < 0) continue;
      const tri = h.faceIndex;
      return { tri, point: [h.point.x, h.point.y, h.point.z], port: state.triPort ? state.triPort[tri] : -1 };
    }
    return null;
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);

  // ---------------------------------------------------------------- theme events
  const onTheme = () => viewer.setTheme();
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  document.addEventListener('themechange', onTheme);
  if (mq && mq.addEventListener) mq.addEventListener('change', onTheme);

  // ---------------------------------------------------------------- API
  let clipOn = false;
  function applyClip() {
    const on = !!clip.axis;
    if (on !== clipOn) {
      // the number of planes is part of the shader program; moving the plane only changes uniforms
      clipOn = on;
      const planes = on ? [clipPlane] : [];
      for (const m of [material, outlineMat, wireMat, pathMat]) { m.clippingPlanes = planes; m.needsUpdate = true; }
    }
    if (!clip.axis || !state.bbox) return;
    const k = clip.axis === 'x' ? 0 : clip.axis === 'y' ? 1 : 2;
    const lo = state.bbox.min.getComponent(k), hi = state.bbox.max.getComponent(k);
    const pad = (hi - lo) * 1e-4 + 1e-12;
    const at = lo - pad + (hi - lo + 2 * pad) * Math.min(1, Math.max(0, clip.offset));
    const n = new THREE.Vector3(); n.setComponent(k, clip.flip ? 1 : -1);
    clipPlane.normal.copy(n);
    clipPlane.constant = clip.flip ? -at : at;
  }

  function buildWire() {
    if (wire) { scene.remove(wire); wire.geometry.dispose(); wire = null; }
    if (!state.positions || state.nTri > WIREFRAME_MAX_TRI) return;
    wire = new THREE.LineSegments(new THREE.WireframeGeometry(geometry), wireMat);
    wire.visible = !!state.display.wireframe;
    scene.add(wire);
  }

  const viewer = {
    webgl: true,
    canvas,
    setMesh(positions, triPort, portColors) {
      const n = Math.floor((positions ? positions.length : 0) / 9);
      state.triPort = triPort || new Int16Array(n).fill(-1);
      state.portColors = portColors || {};
      state.portLin = new Map();
      for (const [id, spec] of Object.entries(state.portColors)) state.portLin.set(Number(id), resolveColor(spec, TOKENS.wall));
      if (positions !== state.positions) {
        const old = geometry;
        geometry = new THREE.BufferGeometry();
        state.positions = positions;
        state.nTri = n;
        if (n > 0) {
          geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
          geometry.computeVertexNormals();
          state.colors = new Float32Array(9 * n);
          geometry.setAttribute('color', new THREE.BufferAttribute(state.colors, 3));
          geometry.computeBoundingBox();
          geometry.computeBoundingSphere();
          const bb = geometry.boundingBox;
          const prev = state.bbox;
          state.bbox = bb.clone();
          bb.getCenter(state.center);
          const size = new THREE.Vector3(); bb.getSize(size);
          state.diag = Math.max(size.length(), 1e-9);
          state.radius = state.diag / 2;
          // a new model resets the view; the same model with caps added (same box) keeps the camera
          const tol = 1e-9 * state.diag;
          const sameBox = prev && prev.min.distanceTo(bb.min) <= tol && prev.max.distanceTo(bb.max) <= tol;
          mesh.geometry = geometry;
          mesh.visible = true;
          old.dispose();
          if (state.display.wireframe) buildWire(); else if (wire) { scene.remove(wire); wire.geometry.dispose(); wire = null; }
          applyClip();
          if (!sameBox) resetView('iso');
        } else {
          mesh.visible = false; state.colors = null; old.dispose();
        }
      }
      fillColors();
      rebuildOutlines();
      requestRender();
    },
    setColors(rgbPerTri) {
      state.map = rgbPerTri && rgbPerTri.length >= 3 * state.nTri ? rgbPerTri : null;
      fillColors();
      requestRender();
    },
    setPaths(list) {
      const segs = [];
      for (const p of list || []) {
        const m = Math.floor(p.length / 3);
        for (let i = 0; i + 1 < m; i++) {
          const a = 3 * i, b = 3 * (i + 1);
          segs.push(p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2]);
        }
      }
      const old = paths.geometry, g = new THREE.BufferGeometry();
      if (segs.length) g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs), 3));
      paths.geometry = g;
      old.dispose();
      state.hasPaths = segs.length > 0;
      paths.visible = state.hasPaths && !!state.display.paths;
      requestRender();
    },
    setClip(axis, offset01 = 0.5, flip = false) {
      const a = axis ? String(axis).toLowerCase() : null;
      clip = { axis: a === 'x' || a === 'y' || a === 'z' ? a : null, offset: Number.isFinite(offset01) ? offset01 : 0.5, flip: !!flip };
      applyClip();
      requestRender();
    },
    setDisplay(opts = {}) {
      if ('wireframe' in opts) {
        state.display.wireframe = !!opts.wireframe && state.nTri <= WIREFRAME_MAX_TRI;
        if (state.display.wireframe && !wire) buildWire();
        if (wire) wire.visible = state.display.wireframe;
      }
      if ('paths' in opts) { state.display.paths = !!opts.paths; paths.visible = state.hasPaths && state.display.paths; }
      requestRender();
      return { wireframe: state.display.wireframe, paths: state.display.paths };
    },
    resetView,
    setTheme() {
      if (state.disposed) return;
      readTheme();
      fillColors();
      fillOutlineColors();
      requestRender();
    },
    renderNow,
    info() {
      return {
        webgl: true, triangles: state.nTri, diag: state.diag, wireframe: !!(wire && wire.visible), paths: paths.visible,
        clip: { ...clip }, camera: orbit.state, outlineSegments: state.outlineIds.length,
      };
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('themechange', onTheme);
      if (mq && mq.removeEventListener) mq.removeEventListener('change', onTheme);
      if (ro) ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      orbit.dispose();
      geometry.dispose(); outlines.geometry.dispose(); paths.geometry.dispose();
      if (wire) wire.geometry.dispose();
      material.dispose(); wireMat.dispose(); outlineMat.dispose(); pathMat.dispose();
      renderer.dispose();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    },
  };

  readTheme();
  resize();
  renderNow();
  if (typeof onReady === 'function') queueMicrotask(() => onReady(viewer));
  return viewer;
}
