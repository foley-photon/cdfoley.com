// WP-D teaching visuals: the pure parts of the moving-dot replay (replay.js) and the potential-energy surface
// (render-surface.js) load without a DOM and behave as documented; view2d.js keeps its spec API and defaults while
// exposing the new entry points (setReplay, aspect, surface mode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const UI = '../../beta/ion-optics/js/ui/';
const ROOT = fileURLToPath(new URL('../../beta/ion-optics/', import.meta.url));

/** Three trajectories: 4 points each at t = 0, 1, 2, 3 (particle 1 starts at t = 1; particle 2 has one point). */
function sampleTraj() {
    const pts = [], offsets = [0];
    const add = (x0, t0, n) => { for (let k = 0; k < n; k++) pts.push(x0 + k, 2 * k, 0, t0 + k); offsets.push(pts.length / 4); };
    add(0, 0, 4);      // x = 0 … 3, y = 0 … 6, t = 0 … 3
    add(10, 1, 4);     // t = 1 … 4
    add(20, 5, 1);     // a single point at t = 5
    return { traj: { offsets: Uint32Array.from(offsets), pts: Float32Array.from(pts) }, n: 3 };
}

test('replay.js: time range and positions interpolate, cursors sweep forward and reset backwards', async () => {
    const R = await import(UI + 'replay.js');
    const { traj, n } = sampleTraj();
    assert.deepEqual(R.timeRange(traj, n), { t0: 0, t1: 5 });
    assert.equal(R.timeRange({ offsets: Uint32Array.from([0, 0]), pts: new Float32Array(0) }, 1), null);
    const cur = R.makeCursor(n);
    R.positionsAt(traj, n, 0.5, cur);
    assert.deepEqual([...cur.alive], [1, 0, 0]);
    assert.ok(Math.abs(cur.pos[0] - 0.5) < 1e-6 && Math.abs(cur.pos[1] - 1) < 1e-6, 'particle 0 half way to its second point');
    R.positionsAt(traj, n, 2.25, cur);
    assert.deepEqual([...cur.alive], [1, 1, 0]);
    assert.equal(cur.idx[0], 2);
    assert.ok(Math.abs(cur.pos[0] - 2.25) < 1e-6);
    assert.ok(Math.abs(cur.pos[3] - 11.25) < 1e-6, 'particle 1 at t = 2.25 is 1.25 past its start');
    R.positionsAt(traj, n, 4.5, cur);
    assert.deepEqual([...cur.alive], [2, 2, 0], 'finished particles keep their last point');
    assert.equal(cur.pos[0], 3);
    assert.equal(cur.pos[3], 13);
    R.positionsAt(traj, n, 5, cur);
    assert.equal(cur.alive[2], 2, 'a one-point trajectory is finished once its time is reached');
    // backwards seek resets the cursor
    R.positionsAt(traj, n, 1.5, cur);
    assert.deepEqual([...cur.alive], [1, 1, 0]);
    assert.equal(cur.idx[0], 1);
    assert.ok(Math.abs(cur.pos[0] - 1.5) < 1e-6);
    assert.equal(R.trajOf({ n: 0, traj }), null);
    assert.equal(R.trajOf({ n: 3, traj }), traj);
    assert.ok(R.SPEEDS.includes(1) && R.BASE_SECONDS > 0);
});

test('replay.js: the clock plays at the base rate, loops, honours reduced motion and follows the store', async () => {
    const R = await import(UI + 'replay.js');
    const { traj, n } = sampleTraj();
    let result = { n, traj };
    const listeners = new Set();
    const store = { get: () => ({ run: { result } }), on: (evt, fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
    const frames = [];
    const view = { setReplay: (r) => frames.push(r ? { t: r.t, alive: [...r.alive] } : null) };
    let clock = 0, pending = null, reduced = false;
    const rep = R.createReplay({ store, view, reducedMotion: () => reduced, raf: (fn) => { pending = fn; return 1; }, now: () => clock });
    assert.equal(rep.active, false);
    assert.ok(rep.play());
    assert.equal(rep.playing, true);
    assert.equal(frames[0].t, 0);
    // 0.1 s of wall time at 1× advances 0.1/BASE_SECONDS of the 5 µs run
    const rate = 5 / R.BASE_SECONDS;
    clock = 100; pending();
    assert.ok(Math.abs(rep.time - 0.1 * rate) < 1e-9, `t = ${rep.time}`);
    rep.setSpeed(4);
    clock = 200; pending();
    assert.ok(Math.abs(rep.time - (0.1 * rate + 0.1 * 4 * rate)) < 1e-9);
    // a frame longer than 0.25 s counts as 0.25 s (a hidden tab does not jump)
    rep.setSpeed(1); rep.seek(0);
    clock = 2200; pending();
    assert.ok(Math.abs(rep.time - 0.25 * rate) < 1e-9, `capped frame: t = ${rep.time}`);
    // running past the end loops
    rep.seek(4.99);
    clock = 2300; pending();
    assert.ok(rep.time < 1 && rep.playing, 'looped to the start');
    // reduced motion: steps no faster than 10 Hz and stops at the end
    reduced = true;
    rep.seek(4.95);
    const before = frames.length;
    clock = 2310; pending();
    assert.equal(frames.length, before, 'no frame within 100 ms under reduced motion');
    clock = 2450; pending();
    assert.equal(rep.playing, false, 'stopped at the end instead of looping');
    assert.equal(rep.time, 5);
    reduced = false;
    // a new result resets the cursors and clamps the time; a result without trajectories leaves replay mode
    result = { n: 1, traj: { offsets: Uint32Array.from([0, 2]), pts: Float32Array.from([0, 0, 0, 0, 1, 0, 0, 2]) } };
    for (const fn of listeners) fn();
    assert.deepEqual(rep.range(), { t0: 0, t1: 2 });
    assert.equal(rep.time, 2);
    result = { n: 1 };
    for (const fn of listeners) fn();
    assert.equal(rep.active, false);
    assert.equal(frames[frames.length - 1], null);
    rep.destroy();
});

test('render-surface.js: sampling caps at 200 per direction, mirrors, signs by polarity and keeps electrode owners', async () => {
    const S = await import(UI + 'render-surface.js');
    assert.equal(S.MAX_SAMPLES, 200);
    assert.deepEqual([...S.sampleIndices(5, 200)], [0, 1, 2, 3, 4]);
    const idx = S.sampleIndices(801, 200);
    assert.ok(idx.length <= 200 && idx[0] === 0 && idx[idx.length - 1] === 800, `${idx.length} samples`);
    for (let k = 1; k < idx.length; k++) assert.ok(idx[k] > idx[k - 1]);
    // a saddle: φ = x² − y² on a 801 × 65 grid (cyl2d: y0 = 0), one electrode on the last column
    const nx = 801, ny = 65, h = 0.25, x0 = -100, y0 = 0;
    const phi = new Float64Array(nx * ny), cls = new Int16Array(nx * ny).fill(-1);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = x0 + i * h, y = y0 + j * h; phi[j * nx + i] = x * x - y * y; if (i === nx - 1) cls[j * nx + i] = 2; }
    const surf = S.sampleSurface({ phi, nx, ny, x0, y0, h, cls, mirrorY: true, sign: -1 });
    assert.equal(surf.half.nsx, idx.length);
    assert.equal(surf.half.nsy, 65);
    assert.equal(surf.nsy, 129, 'mirrored rows share the axis sample');
    assert.equal(surf.xs[0], -100); assert.equal(surf.xs[surf.nsx - 1], 100);
    assert.equal(surf.ys[0], -16); assert.equal(surf.ys[64], 0); assert.equal(surf.ys[128], 16);
    assert.equal(surf.sign, -1);
    assert.ok(Math.abs(surf.z[64 * surf.nsx + 0] - (-(10000))) < 1e-3, 'z = sign·φ');
    assert.ok(surf.zmin <= surf.zmax && surf.zmin === -10000);
    assert.equal(surf.owner[64 * surf.nsx + surf.nsx - 1], 2);
    assert.equal(surf.owner[64 * surf.nsx], -1);
    // heightAt interpolates bilinearly and uses |y| on the mirrored side
    assert.ok(Math.abs(S.heightAt(surf, 0, 0) - 0) < 1e-6);
    assert.ok(Math.abs(S.heightAt(surf, 0, 4) - 16) < 0.05, 'q·φ at (0, 4) ≈ −(0 − 16)');
    assert.ok(Math.abs(S.heightAt(surf, 0, -4) - S.heightAt(surf, 0, 4)) < 1e-6);
    assert.ok(Number.isNaN(S.heightAt(surf, 200, 0)));
    assert.deepEqual(S.hexRgb('#ff8800'), [255, 136, 0]);
    assert.deepEqual(S.hexRgb('0f0'), [0, 255, 0]);
    assert.equal(S.hexRgb('rgb(1, 2, 3)'), null);
    assert.equal(S.polaritySign({ sources: [{ species: [{ charge: -1, fraction: 1 }] }] }), -1);
    assert.equal(S.polaritySign({ sources: [{ n: 10, species: [{ charge: 1 }] }, { n: 3, species: [{ charge: -2 }] }] }), 1);
    assert.equal(S.polaritySign(null), 1);
});

test('render-surface.js: the projector is a rotation plus elevation and the raster paints quads back to front', async () => {
    const S = await import(UI + 'render-surface.js');
    const nx = 21, ny = 11, h = 1;
    const phi = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) phi[j * nx + i] = i < 10 ? 0 : 100;   // a step
    const surf = S.sampleSurface({ phi, nx, ny, x0: 0, y0: 0, h, sign: 1 });
    // top view (el → 89°): u = x − xmid, v ≈ (y − ymid)·sin(el) + (z − zmid)·zScale·cos(el)
    const top = S.makeProjector(surf, { az: 0, el: 89, relief: 1 });
    let [u, v] = top.project(10, 5, 50);
    assert.ok(Math.abs(u) < 1e-9 && Math.abs(v) < 1e-9, 'the centre (x, y, z mid) projects to the origin');
    [u, v] = top.project(20, 5, 50);
    assert.ok(Math.abs(u - 10) < 1e-9);
    [u, v] = top.project(10, 10, 50);
    assert.ok(Math.abs(v - 5 * Math.sin(89 * Math.PI / 180)) < 1e-9, 'v follows y·sin(el)');
    // azimuth 90° swaps the axes
    const side = S.makeProjector(surf, { az: 90, el: 30, relief: 1, aspect: 2 });
    [u] = side.project(10, 7, 50);
    assert.ok(Math.abs(u - (-(7 - 5) * 2)) < 1e-9, 'y (stretched ×2) runs along −u at az = 90°');
    // relief: the full height range spans 0.3 · relief of the larger extent
    const p1 = S.makeProjector(surf, { az: 0, el: 90, relief: 2 });
    assert.ok(Math.abs(p1.zScale * 100 - 0.3 * 2 * 20) < 1e-9);
    assert.ok(p1.normal(1, 0, 0, 0, 1, 0) > 0.58 && p1.normal(1, 0, 0, 0, 1, 0) <= 1, 'a flat facet is lit');
    const b = p1.bbox();
    assert.ok(b.u1 > b.u0 && b.v1 > b.v0);
    // raster into a plain buffer: pixels land inside the projected footprint, the step face is painted
    const W = 160, H = 120;
    const img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
    const proj = S.makeProjector(surf, { az: -30, el: 35, relief: 1 });
    const bb = proj.bbox();
    const sc = Math.min((W - 10) / (bb.u1 - bb.u0), (H - 10) / (bb.v1 - bb.v0));
    const toDevice = (uu, vv) => [W / 2 + (uu - (bb.u0 + bb.u1) / 2) * sc, H / 2 - (vv - (bb.v0 + bb.v1) / 2) * sc];
    const { px, py } = S.projectSamples(surf, proj, toDevice);
    assert.equal(px.length, surf.nsx * surf.nsy);
    const lut = new Uint8ClampedArray(768);
    for (let k = 0; k < 256; k++) { lut[3 * k] = k; lut[3 * k + 1] = 0; lut[3 * k + 2] = 255 - k; }
    const stats = S.rasterSurface(surf, px, py, img, { lut, lo: 0, hi: 100, projector: proj, meshEvery: 5 });
    assert.equal(stats.quads, (surf.nsx - 1) * (surf.nsy - 1));
    assert.ok(stats.pixels > 1000, `${stats.pixels} pixels`);
    let painted = 0, low = 0, high = 0;
    for (let k = 0; k < W * H; k++) {
        if (img.data[4 * k + 3] === 0) continue;
        painted++;
        if (img.data[4 * k] < 60 && img.data[4 * k + 2] > 120) low++;
        if (img.data[4 * k] > 120 && img.data[4 * k + 2] < 60) high++;
    }
    assert.ok(painted > 1000 && painted < W * H, `${painted} painted`);
    assert.ok(low > 200 && high > 200, `both plateaus visible: ${low} low, ${high} high`);
    // a second raster into a smaller buffer clips without throwing
    const small = { width: 8, height: 6, data: new Uint8ClampedArray(8 * 6 * 4) };
    assert.doesNotThrow(() => S.rasterSurface(surf, px, py, small, { lut, lo: 0, hi: 100, projector: proj }));
});

test('view2d.js keeps its defaults and spec API and exposes the teaching entry points', async () => {
    const V = await import(UI + 'view2d.js');
    assert.deepEqual({ ...V.DEFAULT_LAYERS }, { potential: true, contours: 20, field: false, electrodes: true, trajectories: 'source', planes: true, hits: true, grid: 'auto', mirror: true, markers: false });
    assert.deepEqual([...V.ASPECTS], [1, 2, 4, 8, 16]);
    const src = readFileSync(ROOT + 'js/ui/view2d.js', 'utf8');
    for (const k of ['setReplay', 'surfaceMode', 'rotateSurface', 'drawAspectBadge', 'open edge: ∂φ/∂n = 0', 'setWorldU', 'drawSurfaceMode', 'drawReplayDots']) assert.ok(src.includes(k), k);
    const main = readFileSync(ROOT + 'js/ui/main.js', 'utf8');
    for (const k of ["['surface', 'Potential-energy surface (3D)']", 'Vertical stretch', 'Trajectory replay', 'createReplay', 'reducedMotion']) assert.ok(main.includes(k), k);
    const css = readFileSync(ROOT + 'css/app.css', 'utf8');
    for (const k of ['.io-replay', '.io-aspect', '.io-relief', 'data-surface']) assert.ok(css.includes(k), k);
    // the new modules follow H5/H8 habits: no console, no innerHTML, no eval
    for (const f of ['js/ui/render-surface.js', 'js/ui/replay.js']) {
        const s = readFileSync(ROOT + f, 'utf8');
        assert.ok(!/\bconsole\s*\./.test(s), f + ' uses console');
        assert.ok(!/\binnerHTML\s*=/.test(s), f + ' writes innerHTML');
        assert.ok(!/\beval\s*\(|new Function\s*\(/.test(s), f + ' evaluates code');
        assert.ok(!/\b(document|window|self)\s*[.[]/.test(s), f + ' touches the document');
    }
});
