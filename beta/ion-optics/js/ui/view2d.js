/* ==========================================================================
   Ion optics UI: view2d.js
   The 2D canvas: world ↔ screen transform (x right, y up, mm), layers
   (potential, |E|, equipotentials, grid nodes and cuts, electrodes, magnets,
   sources, planes, trajectories, hits, time markers, overlays, tool
   graphics, scale bar), pan and zoom (wheel about the cursor, Space-drag,
   middle-drag, Pan tool, pinch and two-finger pan), mirrored halves for
   cylindrical and mirrored domains, theme tokens re-read on theme changes,
   cached layers for smooth interaction, PNG export and the overlay API
   (spec §2.5): addOverlay, removeOverlay, requestRender, worldToScreen,
   screenToWorld, fit, getBox, setDisplayTime, highlightParticle, on().
   ========================================================================== */
import { cssVar, clamp } from './dom.js';
import { createFieldLayer } from './render-field.js';
import { rgbAt, cssRgb } from './colormaps.js';
import { formatPretty } from './units.js';
import { compileGeometry } from '../engine/geometry.js';
import { S_STRIDE, S_STATUS, S_X, S_Y, S_Z, S_SRC, S_SPECIES, S_KE0, S_ID, STATUS } from '../engine/layout.js';

const TRAJ_LIVE_LIMIT = 150000;     // points drawn live each frame; above, a cached bitmap is used while interacting
const CHUNK_POINTS = 100000;        // points per Path2D chunk of a colour group
const PROGRESSIVE_POINTS = 250000;  // points stroked per frame when a large result is redrawn (≈ 12 ms in software)
const STATUS_COLOR = { [STATUS.DETECTED]: 'ok', [STATUS.HIT]: 'c2', [STATUS.EXIT]: 'c1', [STATUS.ABSORBED]: 'c4', [STATUS.TMAX]: 'c6', [STATUS.DRIFT_END]: 'c1' };
const FALLBACK_COLORS = ['#64748b', '#2563eb', '#ea580c', '#059669', '#7c3aed', '#dc2626', '#0891b2', '#ca8a04'];

/**
 * Per-particle summary rows (Float64Array, S_STRIDE per particle) of a run result, or null. A job manager may
 * replace `summary` by its statistics object; the rows are then looked up under `summaryRows` or `rows`.
 */
export function summaryRows(result) {
    if (!result) return null;
    if (ArrayBuffer.isView(result.summary)) return result.summary;
    if (ArrayBuffer.isView(result.summaryRows)) return result.summaryRows;
    if (ArrayBuffer.isView(result.rows)) return result.rows;
    return null;
}

/** Default layer settings (spec §2.2.1 view.layers). */
export const DEFAULT_LAYERS = Object.freeze({ potential: true, contours: 20, field: false, electrodes: true, trajectories: 'source', planes: true, hits: true, grid: 'auto', mirror: true, markers: false });

/**
 * Creates the canvas view.
 * @param {HTMLCanvasElement} canvas
 * @param {{ store: object, onError?: (e: Error) => void }} opts
 */
export function createView(canvas, { store, onError = null } = {}) {
    const ctx = canvas.getContext('2d', { alpha: false });
    const listeners = new Map();
    const overlays = new Map();
    const field = createFieldLayer();
    let W = 300, H = 150, dpr = 1;
    let cx = 0, cy = 0, s = 6;           // world centre (mm) and scale (CSS px per mm)
    let T = readTheme();
    let tool = null;
    let frame = 0, frameQueued = false;
    let interacting = false, interactTimer = null;
    let highlight = null;
    let displayTime = 0;
    let scene = emptyScene();
    let trajCache = null;                 // { key, paths, nPoints, bitmap, bview }
    let elecCache = null;                 // { key, items }
    let hiddenShapes = new Set();         // shape ids hidden while a tool drags them
    let fps = { last: 0, frames: 0, value: 0, times: [] };
    let destroyed = false;

    // ------------------------------------------------------------ events
    function on(evt, fn) {
        if (!listeners.has(evt)) listeners.set(evt, new Set());
        listeners.get(evt).add(fn);
        return () => listeners.get(evt) && listeners.get(evt).delete(fn);
    }
    function emit(evt, data) {
        const set = listeners.get(evt);
        if (!set) return;
        for (const fn of [...set]) { try { fn(data); } catch (e) { if (onError) onError(e); } }
    }

    // ------------------------------------------------------------ theme
    function readTheme() {
        const v = (n, d) => cssVar(n) || d;
        const t = {
            bg: v('--bg', '#ffffff'), surface: v('--surface', '#ffffff'), surface2: v('--surface-2', '#f2f5f9'), border: v('--border', '#e2e8f0'),
            borderStrong: v('--border-strong', '#cbd5e1'), text: v('--text', '#0f172a'), text2: v('--text-2', '#334155'), muted: v('--muted', '#5f6b7e'),
            accent: v('--accent', '#1d4ed8'), ok: v('--ok', '#047857'), warn: v('--warn', '#92400e'), danger: v('--danger', '#b91c1c'),
            font: v('--font', 'system-ui, sans-serif'), mono: v('--mono', 'monospace'),
        };
        for (let i = 1; i <= 6; i++) t['c' + i] = v('--c' + i, FALLBACK_COLORS[i]);
        t.dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
        return t;
    }
    function refreshTheme() { T = readTheme(); trajCache = null; requestRender(); }

    // ------------------------------------------------------------ transforms
    const X = (x) => W / 2 + (x - cx) * s;
    const Y = (y) => H / 2 - (y - cy) * s;
    function worldToScreen(x, y) { return [X(x), Y(y)]; }
    function screenToWorld(sx, sy) { return [cx + (sx - W / 2) / s, cy - (sy - H / 2) / s]; }
    function setWorld(c, rx = 1, ry = 1, d = dpr) {
        c.setTransform(d * s * rx, 0, 0, -d * s * ry, d * (W / 2 - cx * s), d * (H / 2 + cy * s));
    }
    function setScreen(c, d = dpr) { c.setTransform(d, 0, 0, d, 0, 0); }
    function xf() {
        return {
            scale: s, cx, cy, W, H, dpr, cyl: scene.cyl, mirror: mirrorFlags(),
            toScreen: worldToScreen, toWorld: screenToWorld,
            world: (c, rx = 1, ry = 1) => setWorld(c, rx, ry),
            screen: (c) => setScreen(c),
        };
    }
    function mirrorFlags() {
        const L = layers();
        return { x: !!scene.mirrorX && L.mirror !== false, y: !!(scene.cyl || scene.mirrorY) && L.mirror !== false };
    }
    /** Reflections to draw: [rx, ry] pairs including the identity. */
    function reflections() {
        const m = mirrorFlags();
        const out = [[1, 1]];
        if (m.y) out.push([1, -1]);
        if (m.x) out.push([-1, 1]);
        if (m.x && m.y) out.push([-1, -1]);
        return out;
    }

    // ------------------------------------------------------------ scene (geometry from the resolved project)
    function emptyScene() { return { key: null, resolved: null, geometry: null, cyl: false, mirrorX: false, mirrorY: false, dom: null, error: null }; }
    function updateScene() {
        const st = store.get();
        const r = st.resolved || st.lastResolved || null;
        if (!r || !r.domain) { scene = emptyScene(); return; }
        const key = (st.keys && st.keys.geomKey) || null;
        if (scene.resolved === r && scene.key === key) return;
        const d = r.domain;
        const h = d.h || d.cell || 1;
        const x0 = d.x[0], y0 = d.type === 'cyl2d' ? 0 : d.y[0];
        const nx = d.nx || Math.round((d.x[1] - d.x[0]) / h) + 1, ny = d.ny || Math.round((d.y[1] - y0) / h) + 1;
        const dom = { x0, y0, x1: x0 + (nx - 1) * h, y1: y0 + (ny - 1) * h, h, nx, ny };
        let geometry = scene.geometry, error = null;
        if (scene.key !== key || !geometry) {
            try { geometry = compileGeometry(r); } catch (e) { geometry = null; error = e; }
            elecCache = null;
        }
        scene = { key, resolved: r, geometry, cyl: d.type === 'cyl2d', mirrorX: !!(d.mirror && d.mirror.x), mirrorY: d.type !== 'cyl2d' && !!(d.mirror && d.mirror.y), dom, error };
    }

    function layers() {
        const st = store.get();
        const v = st.project && st.project.view;
        return { ...DEFAULT_LAYERS, ...((v && v.layers) || {}) };
    }
    function viewSettings() {
        const st = store.get();
        return (st.project && st.project.view) || {};
    }

    // ------------------------------------------------------------ sizing
    function resize() {
        const rect = canvas.getBoundingClientRect();
        const nw = Math.max(1, Math.round(rect.width)), nh = Math.max(1, Math.round(rect.height));
        const nd = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
        if (nw === W && nh === H && nd === dpr && canvas.width === Math.round(nw * nd)) return;
        // a view that showed the whole domain keeps showing it when the canvas shrinks (e.g. a window narrowed to phone width)
        const shows = () => {
            if (!scene || !scene.dom || !(W > 1 && H > 1)) return false;
            const b = getBox(), d = domainBox(), tol = 0.01 * Math.max(d.x1 - d.x0, d.y1 - d.y0);
            return b.x0 <= d.x0 + tol && b.x1 >= d.x1 - tol && b.y0 <= d.y0 + tol && b.y1 >= d.y1 - tol;
        };
        const wasShowing = shows();
        W = nw; H = nh; dpr = nd;
        canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
        trajCache && (trajCache.bitmap = null);
        if (wasShowing && !shows()) { fit(); return; }
        renderNow();
    }

    // ------------------------------------------------------------ view control
    function getBox() { const [x0, y1] = screenToWorld(0, 0), [x1, y0] = screenToWorld(W, H); return { x0, x1, y0, y1 }; }
    function domainBox() {
        const d = scene.dom;
        if (!d) return { x0: -10, x1: 10, y0: -10, y1: 10 };
        const m = mirrorFlags();
        return { x0: m.x ? -d.x1 : d.x0, x1: d.x1, y0: m.y ? -d.y1 : d.y0, y1: d.y1 };
    }
    function fit(box = null) {
        updateScene();
        const b = box || domainBox();
        const bw = Math.max(1e-6, b.x1 - b.x0), bh = Math.max(1e-6, b.y1 - b.y0);
        const pad = 28;
        s = clamp(Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh), 1e-3, 1e7);
        cx = (b.x0 + b.x1) / 2; cy = (b.y0 + b.y1) / 2;
        emit('view', getViewState());
        requestRender();
    }
    function setViewState({ center, scale } = {}) {
        if (Array.isArray(center) && center.length >= 2 && Number.isFinite(center[0]) && Number.isFinite(center[1])) { cx = center[0]; cy = center[1]; }
        if (Number.isFinite(scale) && scale > 0) s = clamp(scale, 1e-3, 1e7);
        emit('view', getViewState());
        requestRender();
    }
    function getViewState() { return { center: [cx, cy], scale: s, W, H, dpr }; }
    function zoomAt(f, sx = W / 2, sy = H / 2) {
        const [wx, wy] = screenToWorld(sx, sy);
        s = clamp(s * f, 1e-3, 1e7);
        cx = wx - (sx - W / 2) / s; cy = wy + (sy - H / 2) / s;
        beginInteraction();
        emit('view', getViewState());
        requestRender();
    }
    function panBy(dx, dy) { cx -= dx / s; cy += dy / s; beginInteraction(); emit('view', getViewState()); requestRender(); }
    function beginInteraction() {
        interacting = true;
        if (interactTimer) clearTimeout(interactTimer);
        interactTimer = setTimeout(() => { interacting = false; interactTimer = null; requestRender(); }, 140);
    }

    // ------------------------------------------------------------ render scheduling
    function requestRender() {
        if (frameQueued || destroyed) return;
        frameQueued = true;
        requestAnimationFrame(() => { frameQueued = false; renderNow(); });
    }
    function renderNow() {
        if (destroyed) return;
        const t0 = performance.now();
        try {
            updateScene();
            renderTo(ctx, W, H, dpr, { live: true });
        } catch (e) { if (onError) onError(e); }
        frame++;
        const t1 = performance.now();
        fps.times.push(t1);
        while (fps.times.length && fps.times[0] < t1 - 1000) fps.times.shift();
        fps.lastMs = t1 - t0;
    }

    // ------------------------------------------------------------ drawing
    function renderTo(c, w, hgt, d, opts = {}) {
        const st = store.get();
        const L = layers();
        const vs = viewSettings();
        const saveW = W, saveH = H, saveD = dpr;
        W = w; H = hgt; dpr = d;
        try {
            setScreen(c, d);
            c.fillStyle = opts.white ? '#ffffff' : T.surface2;
            c.fillRect(0, 0, w, hgt);
            if (!scene.dom) return;
            drawDomainBackground(c, opts);
            // field source
            const f = st.field;
            const raster = st.solution && st.solution.raster0;
            if (f && f.displayPhi && scene.dom && f.displayPhi.length === scene.dom.nx * scene.dom.ny) {
                field.setSource({ key: (f.fieldKey || '') + '|' + (f.displayTime || 0) + '|' + scene.dom.nx, phi: f.displayPhi, nx: scene.dom.nx, ny: scene.dom.ny, x0: scene.dom.x0, y0: scene.dom.y0, h: scene.dom.h, mirrorX: mirrorFlags().x, mirrorY: mirrorFlags().y, cyl: scene.cyl });
            } else field.setSource(null);
            if (field.source) {
                if (L.potential) drawPotential(c, vs.colormap || 'auto', opts);
                if (L.field) drawEmag(c, raster);
                if (L.contours !== false && L.contours !== 0) drawContours(c, { count: typeof L.contours === 'number' ? L.contours : 20, levels: vs.contourLevels || null });
            }
            const showGrid = L.grid === true || (L.grid === 'auto' && s * scene.dom.h > 8);
            if (showGrid) drawGrid(c, raster);
            if (L.electrodes !== false) drawElectrodes(c);
            drawDomainEdges(c);
            if (L.planes !== false) drawPlanes(c);
            drawMagnets(c);
            drawSources(c);
            const run = st.run;
            if (run && run.result && L.trajectories) drawTrajectories(c, run, L, opts);
            if (run && run.result && L.hits !== false) drawHits(c, run.result, run.status === 'stale');
            if (run && run.result && L.markers) drawMarkers(c, run.result);
            if (highlight !== null && run && run.result) drawHighlight(c, run.result);
            if (!opts.noOverlays) {
                for (const [id, draw] of overlays) {
                    c.save(); setScreen(c, d);
                    try { draw(c, xf()); } catch (e) { if (onError) onError(e); }
                    c.restore();
                }
                if (tool && typeof tool.draw === 'function') { c.save(); setScreen(c, d); try { tool.draw(c, xf()); } catch (e) { if (onError) onError(e); } c.restore(); }
            }
            if (opts.scaleBar !== false) drawScaleBar(c, opts);
        } finally {
            W = saveW; H = saveH; dpr = saveD;
            setScreen(c, saveD);
        }
    }

    function drawDomainBackground(c) {
        const d = scene.dom;
        c.save();
        c.fillStyle = T.surface;
        for (const [rx, ry] of reflections()) {
            setWorld(c, rx, ry);
            c.fillRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
        }
        c.restore();
    }

    function drawPotential(c, setting) {
        const d = scene.dom;
        const useBicubic = !interacting && s * d.h > 4;
        if (useBicubic) {
            const img = field.bicubicImage({ W, H, dpr, cx, cy, scale: s }, setting);
            if (img) {
                c.save(); setScreen(c, 1); c.globalAlpha = 1;
                c.drawImage(img, 0, 0);
                c.restore();
                return;
            }
        }
        const pi = field.potentialImage(setting);
        if (!pi) return;
        for (const [rx, ry] of reflections()) {
            c.save();
            c.imageSmoothingEnabled = true;
            setWorld(c, rx, ry);
            c.beginPath(); c.rect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0); c.clip();
            c.translate(d.x0 - d.h / 2, d.y1 + d.h / 2);
            c.scale(1, -1);
            c.drawImage(pi.canvas, 0, 0, d.nx * d.h, d.ny * d.h);
            c.restore();
        }
    }

    function drawEmag(c, raster) {
        const d = scene.dom;
        const img = field.emagImage(raster ? fixedMask(raster) : null);
        if (!img) return;
        c.save();
        c.globalAlpha = 0.85;
        for (const [rx, ry] of reflections()) {
            c.save();
            setWorld(c, rx, ry);
            c.beginPath(); c.rect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0); c.clip();
            c.translate(d.x0 - d.h / 2, d.y1 + d.h / 2);
            c.scale(1, -1);
            c.drawImage(img, 0, 0, d.nx * d.h, d.ny * d.h);
            c.restore();
        }
        c.restore();
    }
    let maskCache = null;
    function fixedMask(raster) {
        if (maskCache && maskCache.raster === raster) return maskCache.mask;
        const cls = raster.cls, m = new Uint8Array(cls.length);
        for (let k = 0; k < cls.length; k++) m[k] = cls[k] >= 0 || cls[k] === -2 ? 1 : 0;
        maskCache = { raster, mask: m };
        return m;
    }

    function drawContours(c, spec) {
        const cs = field.contours(spec);
        if (!cs) return;
        c.save();
        const lw = 1 / s;
        c.strokeStyle = T.text;
        for (const [rx, ry] of reflections()) {
            setWorld(c, rx, ry);
            for (const it of cs.items) {
                if (!it.path) continue;
                c.globalAlpha = it.major ? 0.72 : 0.4;
                c.lineWidth = it.major ? 1.3 * lw : lw;
                c.stroke(it.path);
            }
        }
        c.globalAlpha = 1;
        // labels (screen space, upper half only)
        setScreen(c);
        c.font = `11px ${T.font}`;
        c.textAlign = 'center'; c.textBaseline = 'middle';
        const placed = [];   // label boxes already drawn (labels that would overlap one are skipped)
        for (const it of cs.items) {
            if (!it.major) continue;
            const text = formatPretty(it.level, 'voltage', 4);
            for (const lab of it.labels) {
                const sx = X(lab.x), sy = Y(lab.y);
                if (sx < 10 || sx > W - 10 || sy < 10 || sy > H - 10) continue;
                const tw = c.measureText(text).width;
                const box = [sx - tw / 2 - 4, sy - 8, sx + tw / 2 + 4, sy + 8];
                if (placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
                placed.push(box);
                c.globalAlpha = 0.78;
                c.fillStyle = T.surface;
                c.fillRect(sx - tw / 2 - 3, sy - 7, tw + 6, 14);
                c.globalAlpha = 1;
                c.fillStyle = T.text;
                c.fillText(text, sx, sy);
            }
        }
        c.restore();
    }

    /** Node index window of the visible part of the solved half-plane under reflection (rx, ry). */
    function nodeWindow(rx, ry, pad = 1) {
        const d = scene.dom, b = getBox();
        const xa = rx > 0 ? b.x0 : -b.x1, xb = rx > 0 ? b.x1 : -b.x0;
        const ya = ry > 0 ? b.y0 : -b.y1, yb = ry > 0 ? b.y1 : -b.y0;
        return {
            i0: Math.max(0, Math.floor((xa - d.x0) / d.h) - pad), i1: Math.min(d.nx - 1, Math.ceil((xb - d.x0) / d.h) + pad),
            j0: Math.max(0, Math.floor((ya - d.y0) / d.h) - pad), j1: Math.min(d.ny - 1, Math.ceil((yb - d.y0) / d.h) + pad),
        };
    }
    function drawGrid(c, raster) {
        const d = scene.dom;
        let total = 0;
        const wins = reflections().map(([rx, ry]) => { const w = nodeWindow(rx, ry); total += Math.max(0, w.i1 - w.i0 + 1) * Math.max(0, w.j1 - w.j0 + 1); return [rx, ry, w]; });
        if (total > 80000) return;
        c.save();
        setScreen(c);
        const sz = Math.max(1, Math.min(3, s * d.h / 10));
        const cls = raster ? raster.cls : null;
        const free = new Path2D(), fixed = new Path2D();
        for (const [rx, ry, w] of wins) {
            for (let j = w.j0; j <= w.j1; j++) {
                const sy = Y(ry * (d.y0 + j * d.h));
                for (let i = w.i0; i <= w.i1; i++) {
                    const sx = X(rx * (d.x0 + i * d.h));
                    const isFixed = cls && cls[j * d.nx + i] >= 0;
                    (isFixed ? fixed : free).rect(sx - sz / 2, sy - sz / 2, sz, sz);
                }
            }
        }
        const { i0, i1, j0, j1 } = wins.reduce((a, [, , w]) => ({ i0: Math.min(a.i0, w.i0), i1: Math.max(a.i1, w.i1), j0: Math.min(a.j0, w.j0), j1: Math.max(a.j1, w.j1) }), { i0: Infinity, i1: -Infinity, j0: Infinity, j1: -Infinity });
        c.fillStyle = T.text;
        c.globalAlpha = 0.34;
        c.fill(free);
        c.globalAlpha = 1;
        c.fill(fixed);
        // cut markers: where a link meets an electrode surface
        if (raster && raster.cuts && raster.cuts.count) {
            const cu = raster.cuts, nx = d.nx;
            const marks = new Path2D();
            const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
            for (let q = 0; q < cu.count; q++) {
                const k = cu.node[q], i = k % nx, j = (k - i) / nx;
                if (i < i0 - 1 || i > i1 + 1 || j < j0 - 1 || j > j1 + 1) continue;
                const th = cu.theta[q], dir = cu.dir[q];
                const wx = d.x0 + (i + DX[dir] * th) * d.h, wy = d.y0 + (j + DY[dir] * th) * d.h;
                for (const [rx, ry] of reflections()) {
                    const sx = X(rx * wx), sy = Y(ry * wy);
                    marks.moveTo(sx + 2.2, sy); marks.arc(sx, sy, 2.2, 0, 2 * Math.PI);
                }
            }
            c.fillStyle = T.danger;
            c.fill(marks);
        }
        c.restore();
    }

    function electrodeColor(k) {
        const r = scene.resolved;
        const e = r && r.electrodes && r.electrodes[k];
        const col = e && typeof e.color === 'string' && /^#?[0-9a-f]{3,8}$/i.test(e.color) ? (e.color[0] === '#' ? e.color : '#' + e.color) : null;
        return col || FALLBACK_COLORS[k % FALLBACK_COLORS.length];
    }
    function isMesh(k) {
        const r = scene.resolved;
        const e = r && r.electrodes && r.electrodes[k];
        return !!(e && (e.kind === 'grid' || e.transparent === true));
    }

    function electrodeItems() {
        const g = scene.geometry;
        if (!g) return [];
        const key = scene.key + '|' + (scene.resolved ? scene.resolved.electrodes.map((e) => e.color + e.kind).join(',') : '');
        if (elecCache && elecCache.key === key) return elecCache.items;
        let outs = [];
        try { outs = g.outlines(0.5); } catch (e) { outs = []; }
        const items = outs.map((o) => {
            const p = new Path2D();
            const pts = o.pts;
            p.moveTo(pts[0], pts[1]);
            for (let q = 2; q < pts.length; q += 2) p.lineTo(pts[q], pts[q + 1]);
            if (o.closed) p.closePath();
            const prim = g.prims[o.prim];
            return { path: p, closed: o.closed, electrode: o.electrode, shapeId: prim ? prim.shapeId : null, shape: prim ? prim.shape : -1, pts };
        });
        elecCache = { key, items };
        return items;
    }

    function hatch(c, path, color, spacing = 7) {
        // clip to the world path, hatch in screen space
        c.save();
        c.clip(path);
        setScreen(c);
        c.strokeStyle = color; c.lineWidth = 1;
        c.beginPath();
        for (let x = -H; x < W + H; x += spacing) { c.moveTo(x, H); c.lineTo(x + H, 0); }
        c.stroke();
        c.restore();
    }

    function drawElectrodes(c) {
        const items = electrodeItems();
        if (!items.length) return;
        c.save();
        for (const [rx, ry] of reflections()) {
            for (const it of items) {
                if (it.shapeId !== null && hiddenShapes.has(it.shapeId)) continue;
                setWorld(c, rx, ry);
                if (it.electrode < 0) {
                    // void: hatched, dashed outline
                    if (it.closed) hatch(c, it.path, T.muted, 6);
                    setWorld(c, rx, ry);
                    c.setLineDash([4 / s, 3 / s]); c.lineWidth = 1 / s; c.strokeStyle = T.muted; c.stroke(it.path); c.setLineDash([]);
                    continue;
                }
                const col = electrodeColor(it.electrode);
                const mesh = isMesh(it.electrode);
                if (it.closed) {
                    if (mesh) { hatch(c, it.path, col, 5); setWorld(c, rx, ry); }
                    else { c.globalAlpha = 0.7; c.fillStyle = col; c.fill(it.path); c.globalAlpha = 1; }
                    c.lineWidth = 1 / s; c.strokeStyle = col;
                    if (mesh) c.setLineDash([5 / s, 3 / s]);
                    c.stroke(it.path); c.setLineDash([]);
                } else {
                    c.lineWidth = 2.5 / s; c.strokeStyle = col; c.lineCap = 'round';
                    if (mesh) c.setLineDash([6 / s, 4 / s]);
                    c.stroke(it.path); c.setLineDash([]);
                }
            }
        }
        c.restore();
    }

    function drawDomainEdges(c) {
        const d = scene.dom, r = scene.resolved;
        c.save();
        setWorld(c);
        c.lineWidth = 1.2 / s; c.strokeStyle = T.borderStrong;
        c.strokeRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
        // axis (cylindrical) or mirror lines
        const m = mirrorFlags();
        setScreen(c);
        c.setLineDash([8, 4, 2, 4]); c.lineWidth = 1; c.strokeStyle = T.muted;
        if (scene.cyl || scene.mirrorY) { const y = Y(0); c.beginPath(); c.moveTo(X(m.x ? -d.x1 : d.x0), y); c.lineTo(X(d.x1), y); c.stroke(); }
        if (scene.mirrorX) { const x = X(0); c.beginPath(); c.moveTo(x, Y(m.y ? -d.y1 : d.y0)); c.lineTo(x, Y(d.y1)); c.stroke(); }
        c.setLineDash([]);
        // edge conditions as coloured rims (dirichlet edges in their electrode colour)
        if (r && r.domain && r.domain.edges) {
            const idx = new Map((r.electrodes || []).map((e, k) => [e.id, k]));
            const edges = r.domain.edges;
            const rim = (x0, y0, x1, y1, e) => {
                if (!e) return;
                if (e.bc === 'neumann') { c.setLineDash([3, 3]); c.strokeStyle = T.muted; }
                else if (e.bc === 'dirichlet') { c.setLineDash([]); c.strokeStyle = electrodeColor(idx.has(e.electrode) ? idx.get(e.electrode) : 0); }
                else if (e.bc === 'profile') { c.setLineDash([1, 3]); c.strokeStyle = T.text2; }
                else return;
                c.lineWidth = 3;
                c.beginPath(); c.moveTo(X(x0), Y(y0)); c.lineTo(X(x1), Y(y1)); c.stroke();
            };
            rim(d.x0, d.y0, d.x0, d.y1, edges.xmin && !scene.mirrorX ? edges.xmin : null);
            rim(d.x1, d.y0, d.x1, d.y1, edges.xmax);
            rim(d.x0, d.y1, d.x1, d.y1, edges.ymax);
            if (!scene.cyl && !scene.mirrorY) rim(d.x0, d.y0, d.x1, d.y0, edges.ymin);
            c.setLineDash([]);
        }
        c.restore();
    }

    function drawPlanes(c) {
        const r = scene.resolved;
        const planes = r && r.recording && Array.isArray(r.recording.planes) ? r.recording.planes : [];
        if (!planes.length) return;
        const d = scene.dom, m = mirrorFlags();
        const yb0 = m.y ? -d.y1 : d.y0, yb1 = d.y1, xb0 = m.x ? -d.x1 : d.x0, xb1 = d.x1;
        c.save(); setScreen(c);
        c.font = `11px ${T.font}`; c.textBaseline = 'bottom';
        const sel = store.get().selection || {};
        for (const p of planes) {
            const det = !!p.terminate;
            const selected = sel.kind === 'plane' && (sel.ids || []).includes(p.id);
            c.strokeStyle = det ? T.c5 : T.text2;
            c.lineWidth = selected ? 3 : det ? 2 : 1.4;
            c.setLineDash(det ? [] : [6, 4]);
            const segs = [];
            const lim = typeof p.radius === 'number' && p.radius > 0 ? p.radius : null;
            if (p.kind === 'x') segs.push([p.at, lim ? -lim : yb0, p.at, lim ? lim : yb1]);
            else if (p.kind === 'y') segs.push([lim ? -lim : xb0, p.at, lim ? lim : xb1, p.at]);
            else if (p.kind === 'r') { segs.push([xb0, p.at, xb1, p.at]); if (m.y) segs.push([xb0, -p.at, xb1, -p.at]); }
            else if (p.kind === 'segment' && p.p0 && p.p1) { segs.push([p.p0[0], p.p0[1], p.p1[0], p.p1[1]]); if (m.y) segs.push([p.p0[0], -p.p0[1], p.p1[0], -p.p1[1]]); }
            for (const [a, b, e, f] of segs) { c.beginPath(); c.moveTo(X(a), Y(b)); c.lineTo(X(e), Y(f)); c.stroke(); }
            if (segs.length && p.name) {
                const [a, b, e, f] = segs[0];
                const tx = Math.max(X(a), X(e)), ty = Math.min(Y(b), Y(f));
                c.fillStyle = c.strokeStyle;
                c.fillText(p.name, clamp(tx + 4, 4, W - 80), clamp(ty + 14, 14, H - 4));
            }
        }
        c.setLineDash([]);
        c.restore();
    }

    function drawMagnets(c) {
        const r = scene.resolved;
        const mags = r && Array.isArray(r.magnets) ? r.magnets : [];
        if (!mags.length) return;
        c.save();
        let k = 0;
        for (const mg of mags) {
            if (mg.type === 'region' && mg.region) {
                const g = mg.region;
                const p = new Path2D();
                if (g.type === 'box' || (g.x0 !== undefined && g.points === undefined && g.rIn === undefined)) p.rect(g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0);
                else if (Array.isArray(g.points)) { g.points.forEach((q, i) => (i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1]))); p.closePath(); }
                else if (g.rOut !== undefined) {
                    const a0 = (g.a0 || 0) * Math.PI / 180, a1 = (g.a1 === undefined ? 360 : g.a1) * Math.PI / 180;
                    p.arc(g.cx || 0, g.cy || 0, g.rOut, a0, a1); p.arc(g.cx || 0, g.cy || 0, g.rIn || 0, a1, a0, true); p.closePath();
                }
                for (const [rx, ry] of scene.cyl ? reflections() : [[1, 1]]) {
                    setWorld(c, rx, ry);
                    c.globalAlpha = 0.4;
                    hatch(c, p, T.c4, 9);
                    c.globalAlpha = 1;
                    c.setLineDash([6 / s, 4 / s]); c.lineWidth = 1.5 / s; c.strokeStyle = T.c4; c.stroke(p); c.setLineDash([]);
                }
            } else if (mg.type === 'loop' && Array.isArray(mg.center)) {
                setScreen(c);
                const n = mg.normal || [1, 0, 0];
                // in-plane direction perpendicular to the normal's projection
                let ux = -(n[1] || 0), uy = n[0] || 0;
                const L = Math.hypot(ux, uy) || 1; ux /= L; uy /= L;
                if (Math.abs(n[0] || 0) < 1e-12 && Math.abs(n[1] || 0) < 1e-12) { ux = 1; uy = 0; }
                for (const sgn of [1, -1]) {
                    const px = X(mg.center[0] + sgn * mg.radius * ux), py = Y(mg.center[1] + sgn * mg.radius * uy);
                    c.strokeStyle = T.c4; c.lineWidth = 1.6; c.beginPath(); c.arc(px, py, 6, 0, 2 * Math.PI); c.stroke();
                    if ((sgn > 0) === ((mg.current || 0) >= 0)) { c.fillStyle = T.c4; c.beginPath(); c.arc(px, py, 2, 0, 2 * Math.PI); c.fill(); }
                    else { c.beginPath(); c.moveTo(px - 4, py - 4); c.lineTo(px + 4, py + 4); c.moveTo(px + 4, py - 4); c.lineTo(px - 4, py + 4); c.stroke(); }
                }
            } else if (mg.type === 'uniform') {
                setScreen(c);
                const B = mg.B || [0, 0, 0];
                c.font = `11px ${T.font}`; c.fillStyle = T.c4; c.textBaseline = 'top';
                c.fillText(`Uniform B = (${B.map((v) => formatPretty(v, 'flux', 3)).join(', ')})`, 10, 10 + 14 * k++);
            }
        }
        c.restore();
    }

    function drawSources(c) {
        const r = scene.resolved;
        const srcs = r && Array.isArray(r.sources) ? r.sources : [];
        if (!srcs.length) return;
        const sel = store.get().selection || {};
        c.save(); setScreen(c);
        srcs.forEach((src, k) => {
            const col = sourceColor(src, k);
            const selected = sel.kind === 'source' && (sel.ids || []).includes(src.id);
            c.strokeStyle = col; c.fillStyle = col; c.lineWidth = selected ? 2.5 : 1.5;
            const pos = src.position || {};
            let anchor = null;
            if (pos.type === 'point' && pos.p) { anchor = [pos.p[0], pos.p[1]]; c.beginPath(); c.arc(X(anchor[0]), Y(anchor[1]), selected ? 5 : 4, 0, 2 * Math.PI); c.fill(); }
            else if (pos.type === 'line' && pos.p0 && pos.p1) { c.beginPath(); c.moveTo(X(pos.p0[0]), Y(pos.p0[1])); c.lineTo(X(pos.p1[0]), Y(pos.p1[1])); c.stroke(); anchor = [(pos.p0[0] + pos.p1[0]) / 2, (pos.p0[1] + pos.p1[1]) / 2]; endTicks(c, pos.p0, pos.p1); }
            else if ((pos.type === 'disc' || pos.type === 'gaussian') && pos.center) {
                const rad = pos.type === 'disc' ? pos.radius : 2 * Math.max(Math.abs((pos.sigma || [0, 0])[0]), Math.abs((pos.sigma || [0, 0])[1]));
                anchor = [pos.center[0], pos.center[1]];
                c.setLineDash(pos.type === 'gaussian' ? [3, 2] : []);
                c.beginPath(); c.arc(X(anchor[0]), Y(anchor[1]), Math.max(3, (rad || 0) * s), 0, 2 * Math.PI); c.stroke(); c.setLineDash([]);
            } else if (pos.type === 'rect' && pos.center) {
                anchor = [pos.center[0], pos.center[1]];
                const u = pos.u || [1, 0, 0], v = pos.v || [0, 1, 0], hu = pos.halfU || 0, hv = pos.halfV || 0;
                c.beginPath();
                const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [anchor[0] + a * hu * u[0] + b * hv * v[0], anchor[1] + a * hu * u[1] + b * hv * v[1]]);
                cs.forEach((q, i) => (i ? c.lineTo(X(q[0]), Y(q[1])) : c.moveTo(X(q[0]), Y(q[1])))); c.closePath(); c.stroke();
            } else if (pos.type === 'list' && Array.isArray(pos.points)) {
                for (const q of pos.points) { c.beginPath(); c.arc(X(q[0]), Y(q[1]), 2.5, 0, 2 * Math.PI); c.fill(); }
                if (pos.points.length) anchor = [pos.points[0][0], pos.points[0][1]];
            }
            if (anchor) drawDirections(c, src.direction, anchor, col);
        });
        c.restore();
    }
    function endTicks(c, p0, p1) {
        for (const p of [p0, p1]) { c.beginPath(); c.arc(X(p[0]), Y(p[1]), 2.5, 0, 2 * Math.PI); c.fill(); }
    }
    function rotateAbout(v, axis, ang) {
        const [kx, ky, kz] = normalize(axis);
        const cA = Math.cos(ang), sA = Math.sin(ang);
        const dot = kx * v[0] + ky * v[1] + kz * v[2];
        return [v[0] * cA + (ky * v[2] - kz * v[1]) * sA + kx * dot * (1 - cA), v[1] * cA + (kz * v[0] - kx * v[2]) * sA + ky * dot * (1 - cA), v[2] * cA + (kx * v[1] - ky * v[0]) * sA + kz * dot * (1 - cA)];
    }
    function normalize(v) { const n = Math.hypot(v[0] || 0, v[1] || 0, v[2] || 0) || 1; return [(v[0] || 0) / n, (v[1] || 0) / n, (v[2] || 0) / n]; }
    function drawDirections(c, dir, anchor, col) {
        if (!dir) return;
        const dirs = [];
        if (dir.type === 'fixed') dirs.push(normalize(dir.dir || [1, 0, 0]));
        else if (dir.type === 'fan') {
            const ax = normalize(dir.axis || [1, 0, 0]), nm = dir.normal || [0, 0, 1];
            const a = (dir.from || 0) * Math.PI / 180, b = (dir.to || 0) * Math.PI / 180;
            for (let k = 0; k < 5; k++) dirs.push(rotateAbout(ax, nm, a + (b - a) * k / 4));
        } else if (dir.type === 'cone') {
            const ax = normalize(dir.axis || [1, 0, 0]), ha = (dir.halfAngle || 0) * Math.PI / 180;
            let perp = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
            dirs.push(ax, rotateAbout(ax, perp, ha), rotateAbout(ax, perp, -ha));
        } else if (dir.type === 'isotropic') {
            for (let k = 0; k < 8; k++) dirs.push([Math.cos(k * Math.PI / 4), Math.sin(k * Math.PI / 4), 0]);
        }
        const sx = X(anchor[0]), sy = Y(anchor[1]);
        c.save();
        c.strokeStyle = col; c.globalAlpha = 0.85; c.lineWidth = 1.3;
        for (const v of dirs) {
            const L = Math.hypot(v[0], v[1]);
            if (L < 0.2) continue;
            const ex = sx + 28 * v[0] / L, ey = sy - 28 * v[1] / L;
            c.beginPath(); c.moveTo(sx, sy); c.lineTo(ex, ey); c.stroke();
            const ang = Math.atan2(ey - sy, ex - sx);
            c.beginPath(); c.moveTo(ex, ey); c.lineTo(ex - 6 * Math.cos(ang - 0.45), ey - 6 * Math.sin(ang - 0.45)); c.moveTo(ex, ey); c.lineTo(ex - 6 * Math.cos(ang + 0.45), ey - 6 * Math.sin(ang + 0.45)); c.stroke();
        }
        c.restore();
    }
    function sourceColor(src, k) {
        if (src && typeof src.color === 'string' && src.color !== 'auto' && /^#[0-9a-f]{3,8}$/i.test(src.color)) return src.color;
        return T['c' + ((k % 6) + 1)];
    }

    // ------------------------------------------------------------ trajectories
    function colorGroup(result, i, mode, ke) {
        const S = summaryRows(result), o = i * S_STRIDE;
        if (!S) return 'c1';
        if (mode === 'species') return 'c' + (((S[o + S_SRC] * 7 + S[o + S_SPECIES]) % 6) + 1);
        if (mode === 'status') return STATUS_COLOR[S[o + S_STATUS]] || 'muted';
        if (mode === 'energy') {
            const t = ke.hi > ke.lo ? (S[o + S_KE0] - ke.lo) / (ke.hi - ke.lo) : 0.5;
            return 'v' + Math.max(0, Math.min(7, Math.floor(t * 8)));
        }
        const src = S[o + S_SRC];
        return 's' + src;
    }
    function groupColor(key) {
        if (key[0] === 'c') return T[key];
        if (key === 'ok') return T.ok;
        if (key === 'muted') return T.muted;
        if (key[0] === 'v') return cssRgb(rgbAt('viridis', (Number(key.slice(1)) + 0.5) / 8));
        if (key[0] === 't') return cssRgb(rgbAt('cividis', (Number(key.slice(1)) + 0.5) / 8));
        if (key[0] === 's') { const k = Number(key.slice(1)); const r = scene.resolved; return sourceColor(r && r.sources ? r.sources[k] : null, k); }
        return T.c1;
    }
    function buildTrajPaths(result, mode, projection) {
        const traj = result.traj;
        if (!traj || !traj.offsets || !traj.pts) return { groups: [], nPoints: 0 };
        const { offsets, pts } = traj;
        const S = summaryRows(result);
        let ke = { lo: Infinity, hi: -Infinity };
        if (mode === 'energy' && S) for (let i = 0; i < result.n; i++) { const v = S[i * S_STRIDE + S_KE0]; if (v < ke.lo) ke.lo = v; if (v > ke.hi) ke.hi = v; }
        const fold = projection === 'xrho';
        // one Path2D per colour group, split every CHUNK_POINTS points so large results can be drawn over several frames
        const groups = [], cur = new Map();
        const get = (k) => {
            let g = cur.get(k);
            if (!g || g.n > CHUNK_POINTS) { g = { key: k, path: new Path2D(), n: 0 }; cur.set(k, g); groups.push(g); }
            return g;
        };
        let tMin = Infinity, tMax = -Infinity;
        if (mode === 'time') for (let q = 0; q < pts.length; q += 4) { const t = pts[q + 3]; if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
        const tSpan = tMax > tMin ? tMax - tMin : 1;
        const n = result.n;
        for (let i = 0; i < n; i++) {
            const a = offsets[i], b = offsets[i + 1];
            if (b - a < 2) continue;
            const py = (q) => (fold ? Math.sign(pts[4 * q + 1] || 1) * Math.hypot(pts[4 * q + 1], pts[4 * q + 2]) : pts[4 * q + 1]);
            if (mode === 'time') {
                let bin = -1, path = null;
                for (let q = a; q < b; q++) {
                    const nb = Math.max(0, Math.min(7, Math.floor((pts[4 * q + 3] - tMin) / tSpan * 8)));
                    if (nb !== bin) {
                        const pq = q > a ? q - 1 : q;
                        path = get('t' + nb);
                        path.path.moveTo(pts[4 * pq], py(pq));
                        bin = nb;
                    }
                    path.path.lineTo(pts[4 * q], py(q));
                    path.n++;
                }
                continue;
            }
            const g = get(colorGroup(result, i, mode, ke));
            g.path.moveTo(pts[4 * a], py(a));
            for (let q = a + 1; q < b; q++) g.path.lineTo(pts[4 * q], py(q));
            g.n += b - a;
        }
        return { groups: groups.map((g) => [g.key, g.path, g.n]), nPoints: pts.length / 4 };
    }
    function trajKey(run, L, vs) { return [run.result && run.result.n, run.epoch, run.runKey, L.trajectories, vs.projection || 'xy', T.c1, T.dark].join('|'); }

    /**
     * Strokes the groups from index `from`, at most about `maxPoints` points (canvas drawing is rasterised when the
     * canvas is next used, so the budget is counted in points rather than time); returns the next group index.
     */
    function strokeTrajs(c, entry, alpha, d = dpr, from = 0, maxPoints = Infinity) {
        c.save();
        setWorld(c, 1, 1, d);
        c.lineWidth = 1 / s;
        c.lineJoin = 'round';
        c.globalAlpha = alpha;
        let k = from, done = 0;
        for (; k < entry.groups.length; k++) {
            const [key, path, n] = entry.groups[k];
            if (done > 0 && done + n > maxPoints) break;
            c.strokeStyle = groupColor(key);
            c.stroke(path);
            done += n;
        }
        c.restore();
        return k;
    }

    function drawTrajectories(c, run, L, opts) {
        const vs = viewSettings();
        const key = trajKey(run, L, vs);
        if (!trajCache || trajCache.key !== key || trajCache.result !== run.result) {
            trajCache = { key, result: run.result, ...buildTrajPaths(run.result, L.trajectories, vs.projection), bitmap: null, bview: null };
        }
        const alpha = run.status === 'stale' ? 0.4 : (run.live ? 0.9 : 1);
        if (!opts.live || trajCache.nPoints <= TRAJ_LIVE_LIMIT) { strokeTrajs(c, trajCache, alpha, dpr); return; }
        // large result: a bitmap cached for the view, shown transformed while panning and zooming and redrawn
        // when the interaction stops, a few groups per frame so no frame blocks for long
        const vkey = [cx, cy, s, W, H, dpr, alpha].join('|');
        if (trajCache.bitmap && trajCache.bview.key === vkey) { blit(c, trajCache.bitmap); return; }
        const showOld = () => {
            if (!trajCache.bitmap) return false;
            const bv = trajCache.bview, k = s / bv.s;
            c.save(); setScreen(c);
            c.setTransform(dpr * k, 0, 0, dpr * k, dpr * (W / 2 * (1 - k) + (bv.cx - cx) * s), dpr * (H / 2 * (1 - k) - (bv.cy - cy) * s));
            c.drawImage(trajCache.bitmap, 0, 0, bv.W, bv.H);
            c.restore();
            return true;
        };
        if (interacting && showOld()) return;
        let job = trajCache.job;
        if (!job || job.vkey !== vkey) {
            const cv = document.createElement('canvas');
            cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
            job = trajCache.job = { vkey, canvas: cv, next: 0, view: { key: vkey, cx, cy, s, W, H } };
        }
        job.next = strokeTrajs(job.canvas.getContext('2d'), trajCache, alpha, dpr, job.next, PROGRESSIVE_POINTS);
        if (job.next >= trajCache.groups.length) {
            trajCache.bitmap = job.canvas; trajCache.bview = job.view; trajCache.job = null;
            blit(c, job.canvas);
            return;
        }
        if (!showOld()) blit(c, job.canvas);   // first drawing: show what is done so far
        requestRender();
    }
    function blit(c, bm) { c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(bm, 0, 0); c.restore(); }

    function drawHits(c, result, stale) {
        const S = summaryRows(result), n = result.n;
        if (!S || !n) return;
        c.save(); setScreen(c);
        c.globalAlpha = stale ? 0.4 : 1;
        const hit = new Path2D(), det = new Path2D(), abs = new Path2D();
        const fold = viewSettings().projection === 'xrho';
        for (let i = 0; i < n; i++) {
            const o = i * S_STRIDE, st = S[o + S_STATUS];
            if (st !== STATUS.HIT && st !== STATUS.DETECTED && st !== STATUS.ABSORBED) continue;
            const y = fold ? Math.sign(S[o + S_Y] || 1) * Math.hypot(S[o + S_Y], S[o + S_Z]) : S[o + S_Y];
            const sx = X(S[o + S_X]), sy = Y(y);
            if (sx < -5 || sx > W + 5 || sy < -5 || sy > H + 5) continue;
            if (st === STATUS.HIT) { hit.moveTo(sx - 3, sy - 3); hit.lineTo(sx + 3, sy + 3); hit.moveTo(sx + 3, sy - 3); hit.lineTo(sx - 3, sy + 3); }
            else if (st === STATUS.DETECTED) { det.moveTo(sx + 2.4, sy); det.arc(sx, sy, 2.4, 0, 2 * Math.PI); }
            else { abs.moveTo(sx + 2.6, sy); abs.arc(sx, sy, 2.6, 0, 2 * Math.PI); }
        }
        c.lineWidth = 1.4;
        c.strokeStyle = T.danger; c.stroke(hit);
        c.fillStyle = T.ok; c.fill(det);
        c.strokeStyle = T.c4; c.stroke(abs);
        c.restore();
    }

    function drawMarkers(c, result) {
        const m = result.markers;
        if (!m || !m.length) return;
        c.save(); setScreen(c);
        c.fillStyle = T.text;
        const p = new Path2D();
        for (let q = 0; q < m.length; q += 5) {
            const sx = X(m[q + 2]), sy = Y(m[q + 3]);
            if (sx < -3 || sx > W + 3 || sy < -3 || sy > H + 3) continue;
            p.moveTo(sx + 1.6, sy); p.arc(sx, sy, 1.6, 0, 2 * Math.PI);
        }
        c.fill(p);
        c.restore();
    }

    function drawHighlight(c, result) {
        const traj = result.traj;
        if (!traj) return;
        let i = -1;
        const S = summaryRows(result);
        if (!S) return;
        for (let k = 0; k < result.n; k++) if (S[k * S_STRIDE + S_ID] === highlight) { i = k; break; }
        if (i < 0) return;
        const { offsets, pts } = traj;
        c.save(); setWorld(c);
        c.lineWidth = 3 / s; c.strokeStyle = T.accent; c.globalAlpha = 0.9;
        c.beginPath();
        for (let q = offsets[i]; q < offsets[i + 1]; q++) (q === offsets[i] ? c.moveTo(pts[4 * q], pts[4 * q + 1]) : c.lineTo(pts[4 * q], pts[4 * q + 1]));
        c.stroke();
        c.restore();
    }

    function niceLength(px) {
        const target = px / s;
        const mag = Math.pow(10, Math.floor(Math.log10(target)));
        for (const m of [5, 2, 1]) if (m * mag <= target) return m * mag;
        return mag;
    }
    function drawScaleBar(c, opts) {
        const len = niceLength(120);
        const px = len * s;
        c.save(); setScreen(c);
        const x0 = 14, y0 = H - 14;
        c.font = `11px ${T.font}`;
        const note = scene.cyl ? 'x →   r ↑ (lower half mirrored)' : 'x →   y ↑';
        const nw = c.measureText(note).width;
        // translucent backdrops keep the scale bar and the axis note readable over the potential map
        c.fillStyle = opts.white ? '#ffffff' : T.surface;
        c.globalAlpha = 0.78;
        c.fillRect(x0 - 6, y0 - 22, px + 12, 28);
        c.fillRect(W - 16 - nw, H - 22, nw + 12, 20);
        c.globalAlpha = 1;
        c.strokeStyle = opts.white ? '#0f172a' : T.text; c.fillStyle = c.strokeStyle; c.lineWidth = 2;
        c.beginPath(); c.moveTo(x0, y0 - 5); c.lineTo(x0, y0); c.lineTo(x0 + px, y0); c.lineTo(x0 + px, y0 - 5); c.stroke();
        c.textBaseline = 'bottom'; c.textAlign = 'center';
        c.fillText(formatPretty(len, 'length', 3), x0 + px / 2, y0 - 4);
        c.textAlign = 'right';
        c.fillStyle = opts.white ? '#334155' : T.text2;
        c.fillText(note, W - 10, H - 6);
        c.restore();
    }

    // ------------------------------------------------------------ hit testing
    /** Topmost object under a screen point: { kind: 'shape'|'source'|'plane'|'particle', id, index } or null. */
    function hitTest(sx, sy, { particles = true } = {}) {
        updateScene();
        const r = scene.resolved;
        if (!r) return null;
        const [wx0, wy0] = screenToWorld(sx, sy);
        const tolW = 6 / s;
        // sources
        const srcs = r.sources || [];
        for (let k = srcs.length - 1; k >= 0; k--) {
            const pos = srcs[k].position || {};
            const pts = pos.type === 'point' ? [pos.p] : pos.type === 'line' ? [pos.p0, pos.p1] : pos.center ? [pos.center] : [];
            for (const p of pts) if (p && Math.hypot(X(p[0]) - sx, Y(p[1]) - sy) < 8) return { kind: 'source', id: srcs[k].id, index: k };
            if (pos.type === 'line' && pos.p0 && pos.p1 && segDist(sx, sy, X(pos.p0[0]), Y(pos.p0[1]), X(pos.p1[0]), Y(pos.p1[1])) < 5) return { kind: 'source', id: srcs[k].id, index: k };
        }
        // planes
        const planes = (r.recording && r.recording.planes) || [];
        const d = scene.dom, m = mirrorFlags();
        for (let k = planes.length - 1; k >= 0; k--) {
            const p = planes[k];
            let dist = Infinity;
            if (p.kind === 'x') dist = Math.abs(X(p.at) - sx);
            else if (p.kind === 'y') dist = Math.abs(Y(p.at) - sy);
            else if (p.kind === 'r') dist = Math.min(Math.abs(Y(p.at) - sy), m.y ? Math.abs(Y(-p.at) - sy) : Infinity);
            else if (p.kind === 'segment' && p.p0 && p.p1) dist = segDist(sx, sy, X(p.p0[0]), Y(p.p0[1]), X(p.p1[0]), Y(p.p1[1]));
            if (dist < 5) return { kind: 'plane', id: p.id, index: k };
        }
        // shapes (last wins), in the solved half-plane
        const g = scene.geometry;
        if (g) {
            const wx = m.x ? Math.abs(wx0) : wx0, wy = m.y ? Math.abs(wy0) : wy0;
            for (let q = g.prims.length - 1; q >= 0; q--) {
                const p = g.prims[q];
                if (p.shapeId !== null && hiddenShapes.has(p.shapeId)) continue;
                if (p.kind === 'polyline') {
                    const pts = p.pts;
                    for (let e = 0; e + 3 < pts.length; e += 2) if (segDist(wx, wy, pts[e], pts[e + 1], pts[e + 2], pts[e + 3]) < tolW) return shapeHit(p);
                } else if (wx >= p.bbox.x0 - tolW && wx <= p.bbox.x1 + tolW && wy >= p.bbox.y0 - tolW && wy <= p.bbox.y1 + tolW && p.contains(wx, wy)) return shapeHit(p);
            }
        }
        void d;
        if (!particles) return null;
        const run = store.get().run;
        const res = run && run.result;
        if (res && res.traj && layers().trajectories) {
            const { offsets, pts } = res.traj;
            let best = -1, bd = 36;
            const n = res.n;
            for (let i = 0; i < n; i++) {
                for (let q = offsets[i]; q < offsets[i + 1]; q++) {
                    const dx = X(pts[4 * q]) - sx, dy = Y(pts[4 * q + 1]) - sy, d2 = dx * dx + dy * dy;
                    if (d2 < bd) { bd = d2; best = i; }
                }
            }
            const S = summaryRows(res);
            if (best >= 0 && S) return { kind: 'particle', id: S[best * S_STRIDE + S_ID], index: best };
        }
        return null;
    }
    function shapeHit(p) {
        const shapes = (scene.resolved && scene.resolved.shapes) || [];
        const sh = shapes[p.shape];
        return { kind: 'shape', id: sh ? sh.id : p.shapeId, index: p.shape };
    }
    function segDist(px, py, ax, ay, bx, by) {
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        return Math.hypot(px - ax - t * dx, py - ay - t * dy);
    }

    // ------------------------------------------------------------ pointer input
    const pointers = new Map();
    let pan = null, pinch = null, spaceDown = false, longPress = null, lastHover = null;
    function pt(e) {
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const [x, y] = screenToWorld(sx, sy);
        return { sx, sy, x, y, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, button: e.button, pointerType: e.pointerType, detail: e.detail };
    }
    function onPointerDown(e) {
        canvas.focus({ preventScroll: true });
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (pointers.size === 2) {
            // pinch: cancel any tool gesture
            if (tool && tool.cancelGesture) tool.cancelGesture();
            const [a, b] = [...pointers.values()];
            pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
            pan = null; clearLongPress();
            return;
        }
        const P = pt(e);
        const panMode = e.button === 1 || (e.button === 0 && (spaceDown || (tool && tool.name === 'pan') || viewerMode));
        if (panMode) { pan = { sx: P.sx, sy: P.sy, moved: false, start: P }; canvas.classList.add('io-panning'); e.preventDefault(); if (e.pointerType === 'touch' && viewerMode) startLongPress(P); return; }
        if (e.button !== 0) return;
        if (tool && tool.down) tool.down(e, P);
    }
    function onPointerMove(e) {
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && pointers.size >= 2) {
            const [a, b] = [...pointers.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            const rect = canvas.getBoundingClientRect();
            if (pinch.d > 0 && d > 0) zoomAt(d / pinch.d, mx - rect.left, my - rect.top);
            panBy(mx - pinch.mx, my - pinch.my);
            pinch = { d, mx, my };
            return;
        }
        const P = pt(e);
        if (pan) {
            const dx = P.sx - pan.sx, dy = P.sy - pan.sy;
            if (Math.abs(dx) + Math.abs(dy) > 3) { pan.moved = true; clearLongPress(); }
            panBy(dx, dy); pan.sx = P.sx; pan.sy = P.sy;
            return;
        }
        if (tool && tool.move) tool.move(e, P);
        lastHover = P;
        emitHover();
    }
    const emitHover = (() => { let q = false; return () => { if (q) return; q = true; requestAnimationFrame(() => { q = false; if (lastHover) emit('hover', { x: lastHover.x, y: lastHover.y, sx: lastHover.sx, sy: lastHover.sy }); }); }; })();
    function onPointerUp(e) {
        pointers.delete(e.pointerId);
        if (pinch) { if (pointers.size < 2) pinch = null; return; }
        const P = pt(e);
        if (pan) {
            canvas.classList.remove('io-panning');
            const fired = longPressFired;
            clearLongPress();
            const wasMoved = pan.moved;
            pan = null;
            // a tap on a touch screen pins the read-out at that point (there is no hover); a long press already did
            if (!wasMoved && viewerMode && !fired) emit('hover', { x: P.x, y: P.y, sx: P.sx, sy: P.sy, pinned: true });
            return;
        }
        if (tool && tool.up) tool.up(e, P);
    }
    function onPointerLeave() { lastHover = null; emit('hover', null); }
    let longPressFired = false;
    function startLongPress(P) {
        clearLongPress();
        // a long press probes the field at that point: the read-out is pinned there and announced
        longPress = setTimeout(() => { longPress = null; longPressFired = true; emit('hover', { x: P.x, y: P.y, sx: P.sx, sy: P.sy, pinned: true, longPress: true }); }, 600);
    }
    function clearLongPress() { if (longPress) { clearTimeout(longPress); longPress = null; } longPressFired = false; }
    function onWheel(e) {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
        zoomAt(Math.pow(1.0018, -clamp(dy, -400, 400)), e.clientX - rect.left, e.clientY - rect.top);
    }
    function onDblClick(e) { if (tool && tool.dblclick) tool.dblclick(e, pt(e)); }
    function onKeyDown(e) { if (e.key === ' ' && e.target === canvas) { spaceDown = true; e.preventDefault(); } }
    function onKeyUp(e) { if (e.key === ' ') spaceDown = false; }
    let viewerMode = false;

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
    if (ro) ro.observe(canvas);
    const offStore = ['project', 'resolved', 'field', 'run', 'selection', 'solution', 'ui'].map((evt) => store.on(evt, () => requestRender()));

    // ------------------------------------------------------------ export
    /** PNG of the current view at 1–4× with optional white background and scale bar. */
    function exportPNG({ scale = 2, white = false, scaleBar = true } = {}) {
        const k = clamp(Math.round(scale), 1, 4);
        const c = document.createElement('canvas');
        c.width = Math.round(W * k); c.height = Math.round(H * k);
        const cc = c.getContext('2d', { alpha: false });
        const saveT = T;
        if (white) T = { ...T, surface: '#ffffff', surface2: '#ffffff', text: '#0f172a', text2: '#334155', muted: '#5f6b7e', borderStrong: '#cbd5e1', dark: false };
        const was = interacting; interacting = false;
        try { renderTo(cc, W, H, k, { white, scaleBar, noOverlays: false, live: false }); } finally { T = saveT; interacting = was; }
        return new Promise((res) => c.toBlob((b) => res(b), 'image/png'));
    }

    // ------------------------------------------------------------ public API
    resize();
    return {
        canvas,
        // spec API
        addOverlay(id, draw) { overlays.set(id, draw); requestRender(); return () => { overlays.delete(id); requestRender(); }; },
        removeOverlay(id) { overlays.delete(id); requestRender(); },
        requestRender, worldToScreen, screenToWorld, fit, getBox,
        setDisplayTime(t) { displayTime = Number(t) || 0; emit('time', displayTime); requestRender(); },
        get displayTime() { return displayTime; },
        highlightParticle(id) { highlight = id === null || id === undefined ? null : id; requestRender(); },
        on,
        // WP4 extras
        emit, hitTest, exportPNG, refreshTheme, resize,
        getViewState, setViewState, zoomAt, panBy, beginInteraction,
        setTool(t) { if (tool && tool.deactivate) tool.deactivate(); tool = t; canvas.dataset.tool = t ? t.name : ''; if (tool && tool.activate) tool.activate(); requestRender(); },
        getTool() { return tool; },
        scene: () => { updateScene(); return scene; },
        layers, electrodeColor, isMesh, sourceColor: (src, k) => sourceColor(src, k),
        hideShapes(ids) { hiddenShapes = new Set(ids || []); requestRender(); },
        setViewerMode(v) { viewerMode = !!v; },
        get interacting() { return interacting; },
        renderSync: renderNow,
        fieldLayer: field,
        stats() { return { frames: frame, fps: fps.times.length, lastMs: fps.lastMs || 0, trajPoints: trajCache ? trajCache.nPoints : 0 }; },
        theme: () => T,
        destroy() {
            destroyed = true;
            offStore.forEach((f) => f && f());
            if (ro) ro.disconnect();
            window.removeEventListener('keyup', onKeyUp);
        },
    };
}
