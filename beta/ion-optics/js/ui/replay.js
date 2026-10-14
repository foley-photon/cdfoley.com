/* ==========================================================================
   Ion optics UI: replay.js
   Moving-dot replay of a run. Every stored trajectory carries (x, y, z, t)
   points (layout.js), so the position of a particle at a display time τ is
   the linear interpolation of its polyline at t = τ. positionsAt() is that
   pure interpolation (per-particle cursors make a forward sweep O(1) per
   frame); timeRange() spans the run; createReplay() owns the clock
   (requestAnimationFrame, play/pause/seek/speed; at 1× a whole run lasts
   BASE_SECONDS of wall time), follows the run in the store and hands the
   view { t, pos, alive, idx } each tick. prefers-reduced-motion: playback
   stays available on request but advances in 10 Hz steps and stops at the
   end instead of looping; nothing plays by itself.
   ========================================================================== */

/** Wall-clock seconds for one whole run at speed 1×. */
export const BASE_SECONDS = 8;
/** Speed factors offered by the view bar. */
export const SPEEDS = Object.freeze([0.25, 0.5, 1, 2, 4]);
/** Frame interval (ms) under prefers-reduced-motion. */
export const REDUCED_STEP_MS = 100;

/** Trajectory arrays of a run result, or null when it stored none. */
export function trajOf(result) {
    const t = result && result.traj;
    if (!t || !t.offsets || !t.pts || !(result.n > 0) || t.offsets.length < result.n + 1) return null;
    return t;
}

/**
 * Earliest start and latest end time over the stored trajectories.
 * @returns {{ t0: number, t1: number } | null}
 */
export function timeRange(traj, n) {
    if (!traj) return null;
    const { offsets, pts } = traj;
    let t0 = Infinity, t1 = -Infinity;
    for (let i = 0; i < n; i++) {
        const a = offsets[i], b = offsets[i + 1];
        if (b <= a) continue;
        const ta = pts[4 * a + 3], tb = pts[4 * (b - 1) + 3];
        if (ta < t0) t0 = ta;
        if (tb > t1) t1 = tb;
    }
    if (!(t0 <= t1)) return null;
    return { t0, t1 };
}

/** Cursor state for positionsAt(): one index, three coordinates and a status per particle. */
export function makeCursor(n) {
    return { n, idx: new Int32Array(n), pos: new Float32Array(3 * n), alive: new Uint8Array(n), t: NaN };
}

/**
 * Positions of every particle at time t (µs). alive: 0 not yet started, 1 in flight (pos interpolated), 2 finished
 * (pos = last point). idx: index of the trajectory point at or before t. The cursor is advanced forward when t grows
 * and reset per particle when t went backwards.
 */
export function positionsAt(traj, n, t, cur) {
    const { offsets, pts } = traj;
    const { idx, pos, alive } = cur;
    for (let i = 0; i < n; i++) {
        const a = offsets[i], b = offsets[i + 1];
        if (b <= a) { alive[i] = 0; continue; }
        const last = b - 1;
        const ta = pts[4 * a + 3], tb = pts[4 * last + 3];
        if (t < ta) { alive[i] = 0; idx[i] = a; continue; }
        if (t >= tb) { alive[i] = 2; idx[i] = last; const o = 4 * last; pos[3 * i] = pts[o]; pos[3 * i + 1] = pts[o + 1]; pos[3 * i + 2] = pts[o + 2]; continue; }
        let k = idx[i];
        if (k < a || k >= last || pts[4 * k + 3] > t) k = a;
        while (k + 1 < last && pts[4 * (k + 1) + 3] <= t) k++;
        idx[i] = k;
        const o0 = 4 * k, o1 = o0 + 4;
        const tk = pts[o0 + 3], tk1 = pts[o1 + 3];
        const f = tk1 > tk ? (t - tk) / (tk1 - tk) : 0;
        pos[3 * i] = pts[o0] + f * (pts[o1] - pts[o0]);
        pos[3 * i + 1] = pts[o0 + 1] + f * (pts[o1 + 1] - pts[o0 + 1]);
        pos[3 * i + 2] = pts[o0 + 2] + f * (pts[o1 + 2] - pts[o0 + 2]);
        alive[i] = 1;
    }
    cur.t = t;
    return cur;
}

/**
 * The replay clock. opts: { store, view, reducedMotion: () => boolean, raf, now } (raf and now default to the
 * window's requestAnimationFrame and performance.now).
 * @returns {{ play(), pause(), toggle(), stop(), seek(t), seekFraction(f), setSpeed(k), speed, playing, active,
 *   time, range(), state(), on(fn), destroy() }}
 */
export function createReplay({ store, view, reducedMotion = () => false, raf = null, now = null } = {}) {
    const rafFn = raf || ((fn) => requestAnimationFrame(fn));
    const nowFn = now || (() => performance.now());
    const listeners = new Set();
    let result = null, traj = null, n = 0, range = null, cur = null;
    let t = null;            // null: replay off (full trajectories shown)
    let speed = 1, playing = false, handle = 0, lastTick = 0, lastEmit = 0, destroyed = false;

    function emit() { for (const fn of [...listeners]) fn(state()); }
    function state() { return { active: t !== null, playing, t, speed, range, n }; }

    /** Follows the run in the store: a new result resets the cursors and keeps the time inside the new range. */
    function follow() {
        const st = store.get();
        const r = st.run && st.run.result;
        if (r === result) return;
        result = r;
        traj = trajOf(r);
        n = traj ? r.n : 0;
        range = traj ? timeRange(traj, n) : null;
        cur = traj ? makeCursor(n) : null;
        if (!traj || !range) { if (t !== null) { t = null; playing = false; cancel(); view.setReplay(null); } emit(); return; }
        if (t !== null) { t = Math.min(Math.max(t, range.t0), range.t1); push(); }
        emit();
    }
    function push() {
        if (!traj || !cur || t === null) return;
        positionsAt(traj, n, t, cur);
        view.setReplay({ t, n, pos: cur.pos, alive: cur.alive, idx: cur.idx, t0: range.t0, t1: range.t1 });
    }
    function cancel() { if (handle) { try { cancelAnimationFrame(handle); } catch (e) { /* no rAF */ } handle = 0; } }
    function tick() {
        handle = 0;
        if (destroyed || !playing) return;
        const nowMs = nowFn();
        const reduced = reducedMotion();
        if (reduced && nowMs - lastEmit < REDUCED_STEP_MS) { handle = rafFn(tick); return; }
        const dt = Math.min(0.25, Math.max(0, (nowMs - lastTick) / 1000));
        lastTick = nowMs; lastEmit = nowMs;
        if (range) {
            const span = range.t1 - range.t0;
            t += dt * speed * (span > 0 ? span / BASE_SECONDS : 0);
            if (t >= range.t1) {
                if (reduced || span <= 0) { t = range.t1; playing = false; push(); emit(); return; }
                t = range.t0 + (t - range.t1) % span;
            }
        }
        push();
        emit();
        handle = rafFn(tick);
    }
    const api = {
        play() {
            follow();
            if (!traj || !range) return false;
            if (t === null || t >= range.t1) t = range.t0;
            playing = true; lastTick = nowFn(); lastEmit = 0;
            push(); emit();
            cancel(); handle = rafFn(tick);
            return true;
        },
        pause() { if (!playing) return; playing = false; cancel(); emit(); },
        toggle() { return playing ? api.pause() : api.play(); },
        /** Leaves replay mode: the view shows the full trajectories again. */
        stop() { playing = false; cancel(); if (t !== null) { t = null; view.setReplay(null); } emit(); },
        seek(tt) {
            follow();
            if (!traj || !range) return;
            t = Math.min(Math.max(Number(tt) || 0, range.t0), range.t1);
            push(); emit();
        },
        seekFraction(f) { if (range) api.seek(range.t0 + Math.min(1, Math.max(0, Number(f) || 0)) * (range.t1 - range.t0)); },
        setSpeed(k) { if (Number.isFinite(k) && k > 0) { speed = k; emit(); } },
        get speed() { return speed; },
        get playing() { return playing; },
        get active() { return t !== null; },
        get time() { return t; },
        range() { follow(); return range; },
        state,
        on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        destroy() { destroyed = true; cancel(); off(); listeners.clear(); },
    };
    const off = store.on('run', follow);
    follow();
    return api;
}
