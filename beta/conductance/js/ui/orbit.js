// Orbit, pan and dolly controls for the CAD viewer (spec §4.5), written for this site (no three.js add-on code).
// No three import: the controls drive any camera with position and up vectors ({ x, y, z }, with set() when
// available), a vertical field of view `fov` in degrees and lookAt(x, y, z). The orbit is about +Y (camera.up).
//
//   Mouse:    left-drag rotates about the target; right-drag or Shift+drag pans; the wheel dollies.
//   Touch:    one finger rotates; two fingers pinch to dolly and pan.
//   Keyboard: (canvas focused) arrows rotate by 5°, Shift+arrows pan, + and − dolly, 0 resets.
//   Limits:   polar angle in [0.01, π − 0.01]; distance in [minDistance, maxDistance] (set by the viewer to
//             [0.05, 20] × the scene diagonal).
// Angles are radians (§2.0: only names ending in Deg are in degrees).

export const POLAR_MIN = 0.01;
export const POLAR_MAX = Math.PI - 0.01;
export const KEY_ROTATE = 5 * Math.PI / 180;
export const DRAG_THRESHOLD_PX = 3;          // a press that moves less than this is a click, not a rotation

const cx = (v) => (v == null ? 0 : (Array.isArray(v) || ArrayBuffer.isView(v) ? v[0] : v.x));
const cy = (v) => (v == null ? 0 : (Array.isArray(v) || ArrayBuffer.isView(v) ? v[1] : v.y));
const cz = (v) => (v == null ? 0 : (Array.isArray(v) || ArrayBuffer.isView(v) ? v[2] : v.z));

function setVec(v, x, y, z) {
  if (Array.isArray(v) || ArrayBuffer.isView(v)) { v[0] = x; v[1] = y; v[2] = z; return; }
  if (typeof v.set === 'function') v.set(x, y, z);
  else { v.x = x; v.y = y; v.z = z; }
}

/**
 * Spherical coordinates of a vector about +Y: { radius, theta, phi } with theta = atan2(x, z) (azimuth, −π…π)
 * and phi = the polar angle from +Y (0…π). Uses atan2 for phi, so it is accurate near the poles. Accepts
 * { x, y, z } or [x, y, z]. The zero vector gives { radius: 0, theta: 0, phi: 0 }.
 */
export function sphericalFromVector(v) {
  const x = cx(v), y = cy(v), z = cz(v);
  const radius = Math.hypot(x, y, z);
  if (radius === 0) return { radius: 0, theta: 0, phi: 0 };
  return { radius, theta: Math.atan2(x, z), phi: Math.atan2(Math.hypot(x, z), y) };
}

/** Vector { x, y, z } from spherical { radius, theta, phi } (the inverse of sphericalFromVector). */
export function vectorFromSpherical(s) {
  const sp = Math.sin(s.phi) * s.radius;
  return { x: sp * Math.sin(s.theta), y: Math.cos(s.phi) * s.radius, z: sp * Math.cos(s.theta) };
}

/**
 * Screen axes of a camera at spherical angles (theta, phi) looking at its target with up = +Y:
 * { right, up, forward } as unit vectors { x, y, z } in world space.
 */
export function basisFromSpherical(theta, phi) {
  const st = Math.sin(theta), ct = Math.cos(theta), sp = Math.sin(phi), cp = Math.cos(phi);
  return {
    right: { x: ct, y: 0, z: -st },
    up: { x: -st * cp, y: sp, z: -ct * cp },
    forward: { x: -sp * st, y: -cp, z: -sp * ct },
  };
}

/**
 * World-space offset of the target for a pan drag of (dx, dy) pixels (screen y down): the content follows the
 * pointer, so the target moves by −dx along `right` and +dy along `up`, each pixel being worth one pixel's world
 * size at the target distance, 2·distance·tan(fovY/2)/viewportHeight. basis = { right, up } (unit vectors);
 * fovY in radians. Returns { x, y, z }.
 */
export function panOffset(basis, dx, dy, distance, fovY, viewportHeight) {
  const h = viewportHeight > 0 ? viewportHeight : 1;
  const wpp = 2 * distance * Math.tan(fovY / 2) / h;
  const r = basis.right, u = basis.up;
  return {
    x: (-dx * cx(r) + dy * cx(u)) * wpp,
    y: (-dx * cy(r) + dy * cy(u)) * wpp,
    z: (-dx * cz(r) + dy * cz(u)) * wpp,
  };
}

/** New camera distance after a dolly by `factor` (< 1 moves closer), clamped to [min, max]. */
export function dollyDistance(d, factor, min, max) {
  const lo = Number.isFinite(min) ? min : 0, hi = max === undefined || max === null ? Infinity : max;
  const x = d * factor;
  return x < lo ? lo : x > hi ? hi : x;
}

/** Polar angle clamped to [POLAR_MIN, POLAR_MAX]. */
export function clampPolar(phi) {
  return phi < POLAR_MIN ? POLAR_MIN : phi > POLAR_MAX ? POLAR_MAX : phi;
}

/** Dolly factor of a wheel event's deltaY in pixels (positive = away). */
export function wheelFactor(deltaY, deltaMode = 0) {
  const px = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
  return Math.exp(Math.max(-600, Math.min(600, px)) * 0.0015);
}

/**
 * Attaches orbit controls to a canvas and camera. options: { target ({ x, y, z } or [x, y, z]; moved in place
 * by pans), onChange() (after every camera change), onReset() (key 0 and reset(); defaults to restoring the
 * view at attach time), minDistance, maxDistance }.
 * Returns { update(), reset(), dispose(), setLimits(min, max), get state() }; update() re-reads the camera
 * position and target after the caller moved them, and applies the limits.
 */
export function attachOrbit(canvas, camera, options = {}) {
  const target = options.target || { x: 0, y: 0, z: 0 };
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const onReset = typeof options.onReset === 'function' ? options.onReset : null;
  const limits = {
    min: Number.isFinite(options.minDistance) ? options.minDistance : 0,
    max: options.maxDistance > 0 ? options.maxDistance : Infinity,
  };
  let s = { radius: 1, theta: 0, phi: Math.PI / 2 };
  const saved = { target: [0, 0, 0], s: null };

  const fovY = () => ((camera.fov > 0 ? camera.fov : 50) * Math.PI) / 180;
  const height = () => (canvas.clientHeight > 0 ? canvas.clientHeight : (canvas.height > 0 ? canvas.height : 400));

  function readCamera() {
    const p = camera.position;
    s = sphericalFromVector({ x: cx(p) - cx(target), y: cy(p) - cy(target), z: cz(p) - cz(target) });
    if (!(s.radius > 0)) s = { radius: Math.max(limits.min, 1e-9), theta: 0, phi: Math.PI / 2 };
  }

  function apply() {
    s.phi = clampPolar(s.phi);
    s.radius = dollyDistance(s.radius, 1, limits.min, limits.max);
    if (s.theta > Math.PI || s.theta < -Math.PI) s.theta = Math.atan2(Math.sin(s.theta), Math.cos(s.theta));
    const o = vectorFromSpherical(s);
    if (camera.up) setVec(camera.up, 0, 1, 0);
    setVec(camera.position, cx(target) + o.x, cy(target) + o.y, cz(target) + o.z);
    if (typeof camera.lookAt === 'function') camera.lookAt(cx(target), cy(target), cz(target));
  }

  function changed() { apply(); onChange(); }

  function rotate(dTheta, dPhi) { s.theta += dTheta; s.phi += dPhi; changed(); }

  function pan(dx, dy) {
    const off = panOffset(basisFromSpherical(s.theta, s.phi), dx, dy, s.radius, fovY(), height());
    setVec(target, cx(target) + off.x, cy(target) + off.y, cz(target) + off.z);
    changed();
  }

  function dolly(factor) { s.radius = dollyDistance(s.radius, factor, limits.min, limits.max); changed(); }

  function snapshot() {
    saved.target = [cx(target), cy(target), cz(target)];
    saved.s = { ...s };
  }

  function reset() {
    if (onReset) { onReset(); return; }
    if (!saved.s) return;
    setVec(target, saved.target[0], saved.target[1], saved.target[2]);
    s = { ...saved.s };
    changed();
  }

  // ---------------------------------------------------------------- pointer input
  const pointers = new Map();     // pointerId → { x, y }
  let mode = null;                // 'rotate' | 'pan' | 'pinch' | null
  let press = null;               // { x, y, moved } of the first pointer
  let pinch = null;               // { d, mx, my }

  function pinchState() {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* not capturable (synthetic event) */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      const panning = e.pointerType === 'mouse' ? (e.button === 2 || e.button === 1 || e.shiftKey) : e.shiftKey;
      mode = panning ? 'pan' : 'rotate';
      press = { x: e.clientX, y: e.clientY, moved: false };
    } else if (pointers.size === 2) {
      mode = 'pinch';
      pinch = pinchState();
    }
  }

  function onPointerMove(e) {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const x = e.clientX, y = e.clientY;
    if (mode === 'pinch' && pointers.size >= 2) {
      prev.x = x; prev.y = y;
      const now = pinchState();
      if (pinch && now.d > 0 && pinch.d > 0) {
        s.radius = dollyDistance(s.radius, pinch.d / now.d, limits.min, limits.max);
        const off = panOffset(basisFromSpherical(s.theta, s.phi), now.mx - pinch.mx, now.my - pinch.my, s.radius, fovY(), height());
        setVec(target, cx(target) + off.x, cy(target) + off.y, cz(target) + off.z);
        changed();
      }
      pinch = now;
      return;
    }
    if (press && !press.moved) {
      if (Math.hypot(x - press.x, y - press.y) < DRAG_THRESHOLD_PX) return;
      press.moved = true;
    }
    const dx = x - prev.x, dy = y - prev.y;
    prev.x = x; prev.y = y;
    if (!dx && !dy) return;
    const h = height();
    if (mode === 'pan') pan(dx, dy);
    else if (mode === 'rotate') rotate(-2 * Math.PI * dx / h, -2 * Math.PI * dy / h);
  }

  function onPointerUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    if (pointers.size === 1) {
      // back from a pinch to one finger: continue as a rotation from here
      const [p] = [...pointers.values()];
      mode = 'rotate';
      press = { x: p.x, y: p.y, moved: true };
      pinch = null;
    } else if (pointers.size === 0) {
      mode = null; press = null; pinch = null;
    }
  }

  function onWheel(e) {
    if (!e.deltaY) return;
    e.preventDefault();
    dolly(wheelFactor(e.deltaY, e.deltaMode));
  }

  function onContextMenu(e) { e.preventDefault(); }

  function onKeyDown(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const h = height(), step = h / 20;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': if (e.shiftKey) pan(-step, 0); else rotate(KEY_ROTATE, 0); break;
      case 'ArrowRight': if (e.shiftKey) pan(step, 0); else rotate(-KEY_ROTATE, 0); break;
      case 'ArrowUp': if (e.shiftKey) pan(0, -step); else rotate(0, -KEY_ROTATE); break;
      case 'ArrowDown': if (e.shiftKey) pan(0, step); else rotate(0, KEY_ROTATE); break;
      case '+': case '=': dolly(0.9); break;
      case '-': case '_': dolly(1 / 0.9); break;
      case '0': reset(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  if (canvas.style) canvas.style.touchAction = 'none';
  const opts = { passive: false };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, opts);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('keydown', onKeyDown);

  readCamera();
  apply();
  snapshot();

  return {
    update() { readCamera(); apply(); },
    reset,
    dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel, opts);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('keydown', onKeyDown);
      pointers.clear();
    },
    setLimits(min, max) {
      limits.min = Number.isFinite(min) && min >= 0 ? min : 0;
      limits.max = max > 0 ? max : Infinity;
      readCamera();
      apply();
    },
    saveState() { readCamera(); snapshot(); },
    get state() { return { radius: s.radius, theta: s.theta, phi: s.phi, target: [cx(target), cy(target), cz(target)] }; },
  };
}
