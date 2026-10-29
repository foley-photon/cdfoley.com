// WP4 acceptance 2 (spec §7.5): orbit maths — spherical round trip to 1e-12, a pan moves the target by exactly one
// pixel's world size at the target distance, and the polar and dolly clamps hold — plus the input handling of
// attachOrbit on a fake canvas (no DOM in Node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sphericalFromVector, vectorFromSpherical, basisFromSpherical, panOffset, dollyDistance, clampPolar, wheelFactor,
  attachOrbit, POLAR_MIN, POLAR_MAX, KEY_ROTATE,
} from '../../beta/conductance/js/ui/orbit.js';

// small seeded generator (mulberry32) for repeatable random cases
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.hypot(a.x, a.y, a.z);
const angleDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

test('spherical → vector → spherical round trip to 1e-12', () => {
  const r = rng(1);
  for (let i = 0; i < 20000; i++) {
    const s = { radius: 10 ** (6 * r() - 3), theta: (2 * r() - 1) * Math.PI * 0.999999, phi: 1e-6 + r() * (Math.PI - 2e-6) };
    if (i < 10) s.phi = [1e-9, 1e-6, 0.01, Math.PI - 0.01, Math.PI - 1e-6, Math.PI / 2, 1, 2, 3, 0.5][i];
    const back = sphericalFromVector(vectorFromSpherical(s));
    assert.ok(Math.abs(back.radius / s.radius - 1) <= 1e-12, 'radius ' + JSON.stringify(s));
    assert.ok(Math.abs(back.phi - s.phi) <= 1e-12 * Math.max(1, s.phi), 'phi ' + JSON.stringify(s) + ' → ' + back.phi);
    assert.ok(angleDiff(back.theta, s.theta) <= 1e-12 * Math.PI, 'theta ' + JSON.stringify(s));
  }
});

test('vector → spherical → vector round trip to 1e-12, including the poles and the zero vector', () => {
  const r = rng(2);
  const cases = [{ x: 0, y: 1, z: 0 }, { x: 0, y: -2, z: 0 }, { x: 1e-9, y: 5, z: 0 }, [3, 4, 12], { x: -1, y: 0, z: -1 }];
  for (let i = 0; i < 20000; i++) cases.push({ x: (2 * r() - 1) * 10, y: (2 * r() - 1) * 10, z: (2 * r() - 1) * 10 });
  for (const c of cases) {
    const v = Array.isArray(c) ? { x: c[0], y: c[1], z: c[2] } : c;
    const w = vectorFromSpherical(sphericalFromVector(c));
    const L = len(v);
    for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(w[k] - v[k]) <= 1e-12 * L, JSON.stringify(c) + ' ' + k);
  }
  assert.deepEqual(sphericalFromVector({ x: 0, y: 0, z: 0 }), { radius: 0, theta: 0, phi: 0 });
  const s = sphericalFromVector({ x: 0, y: 0, z: 1 });
  assert.equal(s.theta, 0);
  assert.ok(Math.abs(s.phi - Math.PI / 2) < 1e-15);
});

test('the screen basis is orthonormal and faces the target', () => {
  const r = rng(3);
  for (let i = 0; i < 2000; i++) {
    const theta = (2 * r() - 1) * Math.PI, phi = 0.01 + r() * (Math.PI - 0.02);
    const b = basisFromSpherical(theta, phi);
    for (const v of [b.right, b.up, b.forward]) assert.ok(Math.abs(len(v) - 1) < 1e-12);
    assert.ok(Math.abs(dot(b.right, b.up)) < 1e-12);
    assert.ok(Math.abs(dot(b.right, b.forward)) < 1e-12);
    assert.ok(Math.abs(dot(b.up, b.forward)) < 1e-12);
    const o = vectorFromSpherical({ radius: 1, theta, phi });
    assert.ok(Math.abs(dot(b.forward, o) + 1) < 1e-12, 'forward points from the camera to the target');
    assert.ok(b.up.y >= -1e-12, 'up has no downward tilt');
    // right-handed: right × up = −forward (three.js camera looks down its −z)
    const cx = b.right.y * b.up.z - b.right.z * b.up.y, cy = b.right.z * b.up.x - b.right.x * b.up.z, cz = b.right.x * b.up.y - b.right.y * b.up.x;
    assert.ok(Math.abs(cx + b.forward.x) < 1e-12 && Math.abs(cy + b.forward.y) < 1e-12 && Math.abs(cz + b.forward.z) < 1e-12);
  }
});

test('a one-pixel pan moves the target by exactly one pixel’s world size at the target distance', () => {
  const r = rng(4);
  for (let i = 0; i < 2000; i++) {
    const d = 10 ** (4 * r() - 2), fov = (10 + 100 * r()) * Math.PI / 180, h = 100 + Math.floor(1500 * r());
    const b = basisFromSpherical((2 * r() - 1) * Math.PI, 0.01 + r() * 3.1);
    const px = 2 * d * Math.tan(fov / 2) / h;
    const ox = panOffset(b, 1, 0, d, fov, h), oy = panOffset(b, 0, 1, d, fov, h);
    assert.ok(Math.abs(len(ox) / px - 1) < 1e-12, 'dx length');
    assert.ok(Math.abs(len(oy) / px - 1) < 1e-12, 'dy length');
    assert.ok(Math.abs(dot(ox, b.right) / px + 1) < 1e-12, 'drag right moves the target left');
    assert.ok(Math.abs(dot(oy, b.up) / px - 1) < 1e-12, 'drag down moves the target up');
    const o = panOffset(b, 7, -3, d, fov, h);
    assert.ok(Math.abs(len(o) / (px * Math.hypot(7, 3)) - 1) < 1e-12, 'linear in the drag');
  }
  // the example in words: 40° field of view, 1 m away, 400 px tall → 1.8198 mm per pixel
  const o = panOffset({ right: [1, 0, 0], up: [0, 1, 0] }, 1, 0, 1, 40 * Math.PI / 180, 400);
  assert.ok(Math.abs(o.x + 2 * Math.tan(20 * Math.PI / 180) / 400) < 1e-15);
});

test('dolly and polar clamps', () => {
  assert.equal(dollyDistance(10, 0.5, 1, 100), 5);
  assert.equal(dollyDistance(10, 0.01, 1, 100), 1);
  assert.equal(dollyDistance(10, 1000, 1, 100), 100);
  assert.equal(dollyDistance(10, 2, undefined, undefined), 20);
  assert.equal(clampPolar(-1), POLAR_MIN);
  assert.equal(clampPolar(4), POLAR_MAX);
  assert.equal(clampPolar(1), 1);
  assert.equal(POLAR_MIN, 0.01);
  assert.ok(Math.abs(POLAR_MAX - (Math.PI - 0.01)) < 1e-15);
  assert.ok(wheelFactor(100) > 1 && wheelFactor(-100) < 1);
  assert.ok(Math.abs(wheelFactor(100) * wheelFactor(-100) - 1) < 1e-12);
  assert.ok(wheelFactor(3, 1) > wheelFactor(3, 0));
});

// ---------------------------------------------------------------- attachOrbit on a fake canvas
function fakeCanvas(height = 400) {
  const listeners = new Map();
  return {
    clientHeight: height, style: {}, captured: new Set(),
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    setPointerCapture(id) { this.captured.add(id); },
    releasePointerCapture(id) { this.captured.delete(id); },
    fire(type, props = {}) {
      const ev = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, button: 0, shiftKey: false, pointerType: 'mouse', pointerId: 1, ...props };
      for (const fn of listeners.get(type) || []) fn(ev);
      return ev;
    },
    count() { let n = 0; for (const s of listeners.values()) n += s.size; return n; },
  };
}
function fakeCamera(pos = [0, 0, 10]) {
  return {
    fov: 40, position: { x: pos[0], y: pos[1], z: pos[2] }, up: { x: 0, y: 1, z: 0 }, looked: null,
    lookAt(x, y, z) { this.looked = [x, y, z]; },
  };
}
const distance = (cam, t) => Math.hypot(cam.position.x - t.x, cam.position.y - t.y, cam.position.z - t.z);

function drag(cv, x0, y0, x1, y1, props = {}) {
  cv.fire('pointerdown', { clientX: x0, clientY: y0, ...props });
  const steps = 8;
  for (let k = 1; k <= steps; k++) cv.fire('pointermove', { clientX: x0 + (x1 - x0) * k / steps, clientY: y0 + (y1 - y0) * k / steps, ...props });
  cv.fire('pointerup', { clientX: x1, clientY: y1, ...props });
}

test('attachOrbit: dragging rotates, the polar clamp holds at both poles', () => {
  const cv = fakeCanvas(), cam = fakeCamera(), target = { x: 0, y: 0, z: 0 };
  let changes = 0;
  const o = attachOrbit(cv, cam, { target, onChange: () => { changes++; } });
  assert.equal(cv.style.touchAction, 'none');
  drag(cv, 100, 100, 100, -5000);       // far up: the camera would pass under the target
  assert.ok(o.state.phi <= POLAR_MAX + 1e-15 && o.state.phi >= POLAR_MAX - 1e-12, 'clamped at the bottom pole: ' + o.state.phi);
  drag(cv, 100, 100, 100, 9000);
  assert.ok(Math.abs(o.state.phi - POLAR_MIN) < 1e-12, 'clamped at the top pole: ' + o.state.phi);
  assert.ok(changes > 0);
  assert.deepEqual(cam.looked, [0, 0, 0]);
  assert.ok(Math.abs(distance(cam, target) - 10) < 1e-9, 'rotation keeps the distance');
  const th = o.state.theta;
  drag(cv, 0, 0, 100, 0);               // 100 px → 2π·100/400 = π/2 to the left
  assert.ok(angleDiff(o.state.theta, th - Math.PI / 2) < 1e-9);
  o.dispose();
  assert.equal(cv.count(), 0, 'dispose removes every listener');
});

test('attachOrbit: a press that moves less than 3 px does not rotate (it is a click)', () => {
  const cv = fakeCanvas(), cam = fakeCamera(), target = { x: 0, y: 0, z: 0 };
  const o = attachOrbit(cv, cam, { target });
  const before = o.state;
  drag(cv, 50, 50, 52, 51);
  assert.deepEqual(o.state, before);
  o.dispose();
});

test('attachOrbit: right-drag and Shift+drag pan by one pixel’s world size per pixel', () => {
  const cv = fakeCanvas(400), cam = fakeCamera([0, 0, 10]), target = { x: 0, y: 0, z: 0 };
  const o = attachOrbit(cv, cam, { target });
  const px = 2 * 10 * Math.tan(20 * Math.PI / 180) / 400;
  drag(cv, 10, 10, 110, 10, { button: 2 });
  // camera on +z looking at the origin: screen right is +x, so dragging right moves the target to −x
  assert.ok(Math.abs(target.x + (100 - 3) * px) < 1e-9 || Math.abs(target.x + 100 * px) < 1e-9, 'target.x = ' + target.x);
  const x1 = target.x;
  drag(cv, 10, 10, 10, 60, { shiftKey: true });
  assert.ok(target.y > 0, 'dragging down moves the target up');
  assert.ok(Math.abs(target.x - x1) < 1e-12);
  assert.ok(Math.abs(distance(cam, target) - 10) < 1e-9, 'panning keeps the distance');
  const ev = cv.fire('contextmenu');
  assert.ok(ev.defaultPrevented, 'the context menu is suppressed so right-drag can pan');
  o.dispose();
});

test('attachOrbit: wheel and keys dolly within the limits; arrows rotate 5°; 0 resets', () => {
  const cv = fakeCanvas(), cam = fakeCamera([0, 0, 10]), target = { x: 0, y: 0, z: 0 };
  let resets = 0;
  const o = attachOrbit(cv, cam, { target, minDistance: 2, maxDistance: 50 });
  for (let i = 0; i < 100; i++) cv.fire('wheel', { deltaY: -500, deltaMode: 0 });
  assert.ok(Math.abs(distance(cam, target) - 2) < 1e-9, 'dolly clamps at the minimum');
  for (let i = 0; i < 100; i++) cv.fire('wheel', { deltaY: 500, deltaMode: 0 });
  assert.ok(Math.abs(distance(cam, target) - 50) < 1e-9, 'dolly clamps at the maximum');
  const wheel = cv.fire('wheel', { deltaY: 10 });
  assert.ok(wheel.defaultPrevented, 'the page does not scroll while the wheel zooms');
  o.setLimits(0.5, 20);
  assert.ok(Math.abs(distance(cam, target) - 20) < 1e-9, 'new limits apply at once');
  cv.fire('keydown', { key: '+' });
  assert.ok(Math.abs(distance(cam, target) - 18) < 1e-9);
  cv.fire('keydown', { key: '-' });
  assert.ok(Math.abs(distance(cam, target) - 20) < 1e-9);
  const t0 = o.state.theta, p0 = o.state.phi;
  const k = cv.fire('keydown', { key: 'ArrowLeft' });
  assert.ok(k.defaultPrevented);
  assert.ok(angleDiff(o.state.theta, t0 + KEY_ROTATE) < 1e-12);
  cv.fire('keydown', { key: 'ArrowDown' });
  assert.ok(Math.abs(o.state.phi - (p0 + KEY_ROTATE)) < 1e-12);
  assert.ok(Math.abs(KEY_ROTATE - 5 * Math.PI / 180) < 1e-15);
  cv.fire('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.ok(Math.hypot(target.x, target.y, target.z) > 0, 'Shift+arrow pans');
  cv.fire('keydown', { key: '0' });
  assert.deepEqual(o.state.target, [0, 0, 0]);
  assert.ok(Math.abs(o.state.radius - 10) < 1e-9, 'reset restores the attach-time view (clamped)');
  const other = cv.fire('keydown', { key: 'a' });
  assert.ok(!other.defaultPrevented, 'other keys pass through');
  o.dispose();
  // with an onReset callback, 0 calls it instead
  const cv2 = fakeCanvas(), o2 = attachOrbit(cv2, fakeCamera(), { onReset: () => { resets++; } });
  cv2.fire('keydown', { key: '0' });
  o2.reset();
  assert.equal(resets, 2);
  o2.dispose();
});

test('attachOrbit: two fingers pinch to dolly and pan; lifting one finger continues as a rotation', () => {
  const cv = fakeCanvas(), cam = fakeCamera([0, 0, 10]), target = { x: 0, y: 0, z: 0 };
  const o = attachOrbit(cv, cam, { target, minDistance: 0.1, maxDistance: 100 });
  const T = { pointerType: 'touch' };
  cv.fire('pointerdown', { ...T, pointerId: 1, clientX: 100, clientY: 100 });
  cv.fire('pointerdown', { ...T, pointerId: 2, clientX: 200, clientY: 100 });
  cv.fire('pointermove', { ...T, pointerId: 2, clientX: 300, clientY: 100 });   // spread 100 → 200 px, midpoint +50 px
  assert.ok(Math.abs(distance(cam, target) - 5) < 1e-9, 'pinch out halves the distance: ' + distance(cam, target));
  assert.ok(target.x < 0, 'the midpoint moved right, so the content follows');
  cv.fire('pointerup', { ...T, pointerId: 2, clientX: 300, clientY: 100 });
  const th = o.state.theta;
  cv.fire('pointermove', { ...T, pointerId: 1, clientX: 140, clientY: 100 });
  assert.ok(Math.abs(angleDiff(o.state.theta, th) - 2 * Math.PI * 40 / 400) < 1e-9, 'one finger rotates');
  cv.fire('pointerup', { ...T, pointerId: 1, clientX: 140, clientY: 100 });
  assert.equal(cv.captured.size, 0, 'pointer capture is released');
  o.dispose();
});

test('attachOrbit works with array targets and update() re-reads a moved camera', () => {
  const cv = fakeCanvas(), cam = fakeCamera([0, 5, 0]), target = [0, 0, 0];
  const o = attachOrbit(cv, cam, { target });
  assert.ok(o.state.phi >= POLAR_MIN, 'a camera straight above is pushed off the pole');
  cam.position.x = 3; cam.position.y = 0; cam.position.z = 4;
  o.update();
  assert.ok(Math.abs(o.state.radius - 5) < 1e-12);
  assert.ok(Math.abs(o.state.phi - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(o.state.theta - Math.atan2(3, 4)) < 1e-12);
  o.dispose();
});
