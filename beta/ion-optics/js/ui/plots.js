/* ==========================================================================
   Ion optics UI: plots.js
   Chart blocks for the results dock (spec §4.7): every chart has a
   "Table" toggle (aria-pressed) showing its data as an accessible table and
   a CSV download. 1D charts use the site's window.Plot (SVG, colours from
   CSS variables, so they follow the theme by themselves); scatter plots and
   2D histograms are drawn on a canvas that re-reads the colour tokens on
   the themechange event and on prefers-color-scheme changes.
   2D histograms use a viridis-like ramp (van der Walt & Smith, CC0).
   No DOM access at import time (the module also loads in Node tests).
   ========================================================================== */

/** Element helper (text only through textContent). */
function el(tag, attrs = null, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = String(v);
        else if (k === 'on') for (const t of Object.keys(v)) e.addEventListener(t, v[t]);
        else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
}

/** Number to short text with a Unicode minus (significant digits). */
export function fmtNum(v, digits = 6) {
    if (v === null || v === undefined) return '—';
    if (typeof v !== 'number') return String(v);
    if (Number.isNaN(v)) return '—';
    if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
    if (v === 0) return '0';
    const a = Math.abs(v);
    const s = a >= 1e-3 && a < 1e6 ? String(parseFloat(v.toPrecision(digits))) : v.toExponential(Math.max(0, digits - 1)).replace(/\.?0+e/, 'e').replace('e+', 'e');
    return s.replace(/^-/, '−').replace('e-', 'e−');
}

/** RFC 4180 CSV with '.' decimals and 10 significant digits. */
export function csvText(columns, rows) {
    // text a spreadsheet would read as a formula gets a leading ' (names come from shared links and files)
    const q = (s0) => { const s = /^[=+\-@\t\r]/.test(s0) ? "'" + s0 : s0; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cell = (v) => {
        if (typeof v === 'number') return Number.isFinite(v) ? String(parseFloat(v.toPrecision(10))) : (Number.isNaN(v) ? 'NaN' : (v > 0 ? 'Infinity' : '-Infinity'));
        return q(v === null || v === undefined ? '' : String(v));
    };
    const lines = [columns.map((c) => q(String(c))).join(',')];
    for (const r of rows) lines.push(r.map(cell).join(','));
    return lines.join('\r\n') + '\r\n';
}

/** Saves text as a file (browser). */
export function download(text, filename, type = 'text/csv') {
    const blob = new Blob([text], { type: type + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename, hidden: true });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

/** Colour tokens of the current theme (with fallbacks). */
export function themeColors() {
    const cs = typeof getComputedStyle === 'function' && typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
    const v = (n, d) => (cs && cs.getPropertyValue(n).trim()) || d;
    const out = { text: v('--text', '#0f172a'), muted: v('--muted', '#5f6b7e'), border: v('--border', '#e2e8f0'), surface: v('--surface', '#ffffff'), bg: v('--bg', '#ffffff'), accent: v('--accent', '#1d4ed8'), font: v('--font', 'system-ui, sans-serif') };
    const fb = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#dc2626', '#0891b2'];
    out.series = fb.map((d, i) => v(`--c${i + 1}`, d));
    return out;
}

/** Calls fn on theme changes (site themechange event and prefers-color-scheme); returns an unsubscribe function. */
export function onThemeChange(fn) {
    if (typeof document === 'undefined') return () => {};
    const h = () => fn();
    document.addEventListener('themechange', h);
    let mq = null;
    if (typeof matchMedia === 'function') { mq = matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', h); }
    return () => { document.removeEventListener('themechange', h); if (mq && mq.removeEventListener) mq.removeEventListener('change', h); };
}

/**
 * Accessible data table. columns: string[]; rows: any[][]; maxRows: cap (a note states the remainder).
 * @returns {HTMLElement}
 */
export function dataTable({ columns, rows, caption = '', maxRows = 2000, digits = 7 }) {
    const wrap = el('div', { class: 'io-table-scroll' });
    const t = el('table', { class: 'io-table' });
    if (caption) t.appendChild(el('caption', { text: caption }));
    const thead = el('thead'), tr = el('tr');
    for (const c of columns) tr.appendChild(el('th', { scope: 'col', text: c }));
    thead.appendChild(tr);
    t.appendChild(thead);
    const tb = el('tbody');
    const n = Math.min(rows.length, maxRows);
    for (let i = 0; i < n; i++) {
        const r = el('tr');
        for (const v of rows[i]) r.appendChild(el('td', { text: typeof v === 'number' ? fmtNum(v, digits) : (v === null || v === undefined ? '' : String(v)) }));
        tb.appendChild(r);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    if (rows.length > n) wrap.appendChild(el('p', { class: 'io-note', text: `Showing ${n} of ${rows.length} rows; the CSV has all of them.` }));
    return wrap;
}

let blockSeq = 0;
/**
 * A chart block with a title, a "Table" toggle and a CSV button.
 * spec: { title, plot(el) (draws the chart into el), columns, rows (array or () => array), csvName, empty, note, height }
 * @returns {{ el: HTMLElement, update(spec: object): void, destroy(): void, showTable(on: boolean): void }}
 */
export function chartBlock(container, spec) {
    let cur = { ...spec };
    let tableOn = false;
    const id = `io-chart-${++blockSeq}`;
    const titleEl = el('h3', { class: 'io-chart-title', id: id + '-t' });
    const tableBtn = el('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'aria-pressed': 'false', 'aria-controls': id + '-b', text: 'Table' });
    const csvBtn = el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'CSV' });
    const head = el('div', { class: 'io-chart-head' }, titleEl, el('span', { class: 'io-chart-tools' }, tableBtn, csvBtn));
    const body = el('div', { class: 'io-chart-body', id: id + '-b', role: 'group', 'aria-labelledby': id + '-t' });
    const note = el('p', { class: 'io-note', hidden: true });
    const box = el('figure', { class: 'io-chart' }, head, body, note);
    container.appendChild(box);
    const rowsOf = () => (typeof cur.rows === 'function' ? cur.rows() : (cur.rows || []));
    function render() {
        titleEl.textContent = cur.title || '';
        while (body.firstChild) body.removeChild(body.firstChild);
        const rows = rowsOf();
        note.hidden = !cur.note;
        note.textContent = cur.note || '';
        csvBtn.disabled = !rows.length;
        if (!rows.length && cur.empty !== null) { body.appendChild(el('p', { class: 'io-empty', text: cur.empty || 'No data.' })); return; }
        if (tableOn) { body.appendChild(dataTable({ columns: cur.columns || [], rows, caption: cur.title || '' })); return; }
        const plotEl = el('div', { class: 'io-plot', style: cur.height ? `min-height:${cur.height}px` : null });
        body.appendChild(plotEl);
        try { cur.plot(plotEl); } catch (e) { plotEl.appendChild(el('p', { class: 'io-empty', text: 'The chart could not be drawn; use the table.' })); }
    }
    tableBtn.addEventListener('click', () => { tableOn = !tableOn; tableBtn.setAttribute('aria-pressed', tableOn ? 'true' : 'false'); render(); });
    csvBtn.addEventListener('click', () => download(csvText(cur.columns || [], rowsOf()), (cur.csvName || 'chart') + '.csv'));
    const off = onThemeChange(() => { if (!tableOn && cur.canvas) render(); });
    render();
    return {
        el: box,
        update(next) { cur = { ...cur, ...next }; render(); },
        showTable(on) { tableOn = !!on; tableBtn.setAttribute('aria-pressed', tableOn ? 'true' : 'false'); render(); },
        destroy() { off(); box.remove(); },
    };
}

// ---------------------------------------------------------------- SVG charts (window.Plot)
function plotOrFallback(target, opts) {
    if (typeof window !== 'undefined' && window.Plot && typeof window.Plot.draw === 'function') return window.Plot.draw(target, opts);
    target.appendChild(el('p', { class: 'io-empty', text: 'Charts are loading; the table shows the data.' }));
    return null;
}

/**
 * Line chart: series [{ label, x, y, color?, dash?, type? ('line'|'points'), line? }].
 * @returns {(target: HTMLElement) => void}
 */
export function linePlot({ series, xLabel = '', yLabel = '', height = 220, vlines = [], hlines = [], logX = false, logY = false, xMin, xMax, yMin, yMax, ariaLabel }) {
    // a log axis needs at least one finite positive value (else the shared plotter puts a tick at NaN)
    const positive = (key) => series.some((s) => Array.from(s[key] || []).some((v) => v > 0 && v < Infinity));
    if (logX && !positive('x')) logX = false;
    if (logY && !positive('y')) logY = false;
    return (target) => plotOrFallback(target, {
        height, x: { label: xLabel, log: logX, min: xMin, max: xMax }, y: { label: yLabel, log: logY, min: yMin, max: yMax },
        series: series.map((s) => ({ type: s.type || 'line', x: Array.from(s.x), y: Array.from(s.y), label: s.label, color: s.color, dash: s.dash, line: s.line, r: s.r })),
        vlines, hlines, hover: true, ariaLabel,
    });
}

/**
 * Histogram from bin edges and counts (several series overlay).
 * @returns {(target: HTMLElement) => void}
 */
export function barsPlot({ series, xLabel = '', yLabel = 'count', height = 200, vlines = [] }) {
    return (target) => plotOrFallback(target, {
        height, x: { label: xLabel }, y: { label: yLabel, min: 0 },
        series: series.map((s) => ({ type: 'bars', label: s.label, color: s.color, bins: Array.from(s.counts, (c, i) => ({ x0: s.edges[i], x1: s.edges[i + 1], y: c })) })),
        vlines, legend: series.length > 1,
    });
}

// ---------------------------------------------------------------- canvas charts
const VIRIDIS = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
function viridis(t) {
    const x = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1), i = Math.min(VIRIDIS.length - 2, Math.floor(x)), f = x - i;
    const a = VIRIDIS[i], b = VIRIDIS[i + 1];
    return [Math.round(a[0] + f * (b[0] - a[0])), Math.round(a[1] + f * (b[1] - a[1])), Math.round(a[2] + f * (b[2] - a[2]))];
}
function niceTicks(lo, hi, n = 5) {
    if (!(hi > lo)) return [lo];
    const raw = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / mag;
    const step = (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(parseFloat(v.toPrecision(12)));
    return out;
}
function extentOf(a, pad = 0.05) {
    let lo = Infinity, hi = -Infinity;
    for (const v of a) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!(lo < Infinity)) return [0, 1];
    if (hi === lo) { const d = Math.abs(lo) * 0.1 || 1; return [lo - d, hi + d]; }
    const d = (hi - lo) * pad;
    return [lo - d, hi + d];
}
/** Canvas with axes; returns a drawing context and the data→pixel maps. */
function axesCanvas(target, { xr, yr, xLabel, yLabel, height = 240, ariaLabel, equal = false }) {
    const C = themeColors();
    const W = Math.max(260, Math.min(900, target.clientWidth || 480)), H = height;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const cv = el('canvas', { class: 'io-canvas-plot', role: 'img', 'aria-label': ariaLabel || `${yLabel} versus ${xLabel}` });
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    target.appendChild(cv);
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const M = { l: 58, r: 14, t: 10, b: 40 };
    let [x0, x1] = xr, [y0, y1] = yr;
    if (equal) {
        const sx = (W - M.l - M.r) / (x1 - x0), sy = (H - M.t - M.b) / (y1 - y0), s = Math.min(sx, sy);
        const cx = 0.5 * (x0 + x1), cy = 0.5 * (y0 + y1), hw = (W - M.l - M.r) / s / 2, hh = (H - M.t - M.b) / s / 2;
        x0 = cx - hw; x1 = cx + hw; y0 = cy - hh; y1 = cy + hh;
    }
    const px = (x) => M.l + (x - x0) / (x1 - x0) * (W - M.l - M.r);
    const py = (y) => H - M.b - (y - y0) / (y1 - y0) * (H - M.t - M.b);
    c.font = `11px ${C.font}`;
    c.strokeStyle = C.border; c.fillStyle = C.muted; c.lineWidth = 1;
    c.textAlign = 'center';
    for (const v of niceTicks(x0, x1)) { const p = px(v); c.beginPath(); c.moveTo(p, M.t); c.lineTo(p, H - M.b); c.stroke(); c.fillText(fmtNum(v, 4), p, H - M.b + 14); }
    c.textAlign = 'right';
    for (const v of niceTicks(y0, y1)) { const p = py(v); c.beginPath(); c.moveTo(M.l, p); c.lineTo(W - M.r, p); c.stroke(); c.fillText(fmtNum(v, 4), M.l - 6, p + 3.5); }
    c.fillStyle = C.text; c.textAlign = 'center';
    c.fillText(xLabel, (M.l + W - M.r) / 2, H - 6);
    c.save(); c.translate(13, (M.t + H - M.b) / 2); c.rotate(-Math.PI / 2); c.fillText(yLabel, 0, 0); c.restore();
    c.save(); c.beginPath(); c.rect(M.l, M.t, W - M.l - M.r, H - M.t - M.b); c.clip();
    return { c, px, py, C, done: () => c.restore(), W, H, M, x0, x1, y0, y1 };
}

/**
 * Scatter plot on a canvas; ellipse { cx, cy, sxx, syy, sxy, k = 2 } draws the k-sigma ellipse of a covariance.
 * groups (optional) colour the points by an integer group index.
 * @returns {(target: HTMLElement) => void}
 */
export function scatterPlot({ x, y, groups = null, xLabel = 'x', yLabel = 'y', height = 240, ellipse = null, equal = false, ariaLabel }) {
    return (target) => {
        const xr = extentOf(x), yr = extentOf(y);
        const ax = axesCanvas(target, { xr, yr, xLabel, yLabel, height, ariaLabel, equal });
        const { c, px, py, C } = ax;
        for (let i = 0; i < x.length; i++) {
            if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
            c.fillStyle = C.series[groups ? Math.abs(groups[i]) % 6 : 0];
            c.beginPath(); c.arc(px(x[i]), py(y[i]), 2.2, 0, 2 * Math.PI); c.fill();
        }
        if (ellipse && ellipse.sxx > 0 && ellipse.syy > 0) {
            const k = ellipse.k || 2;
            const a = ellipse.sxx, b = ellipse.sxy || 0, d = ellipse.syy;
            const tr = a + d, det = a * d - b * b, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
            const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc), ang = Math.atan2(l1 - a, b || 1e-300);
            c.strokeStyle = C.text; c.lineWidth = 1.5; c.setLineDash([5, 4]);
            c.beginPath();
            for (let t = 0; t <= 64; t++) {
                const s = 2 * Math.PI * t / 64, u = k * Math.sqrt(l1) * Math.cos(s), v = k * Math.sqrt(l2) * Math.sin(s);
                const X = ellipse.cx + u * Math.cos(ang) - v * Math.sin(ang), Y = ellipse.cy + u * Math.sin(ang) + v * Math.cos(ang);
                if (t === 0) c.moveTo(px(X), py(Y)); else c.lineTo(px(X), py(Y));
            }
            c.stroke(); c.setLineDash([]);
        }
        ax.done();
    };
}

/**
 * 2D histogram (detector image) on a canvas with a viridis-like ramp.
 * @returns {(target: HTMLElement) => void}
 */
export function heatmapPlot({ x, y, bins = 64, xLabel = 'y (mm)', yLabel = 'z (mm)', height = 260, range = null, ariaLabel }) {
    return (target) => {
        let xr = range ? range.x : extentOf(x, 0.02), yr = range ? range.y : extentOf(y, 0.02);
        const span = Math.max(xr[1] - xr[0], yr[1] - yr[0]);
        const cxm = 0.5 * (xr[0] + xr[1]), cym = 0.5 * (yr[0] + yr[1]);
        xr = [cxm - span / 2, cxm + span / 2]; yr = [cym - span / 2, cym + span / 2];
        const H = new Float64Array(bins * bins);
        let max = 0;
        for (let i = 0; i < x.length; i++) {
            const a = Math.floor((x[i] - xr[0]) / (xr[1] - xr[0]) * bins), b = Math.floor((y[i] - yr[0]) / (yr[1] - yr[0]) * bins);
            if (a < 0 || b < 0 || a >= bins || b >= bins) continue;
            const v = ++H[b * bins + a];
            if (v > max) max = v;
        }
        const ax = axesCanvas(target, { xr, yr, xLabel, yLabel, height, ariaLabel, equal: true });
        const { c, px, py } = ax;
        const dx = (xr[1] - xr[0]) / bins, dy = (yr[1] - yr[0]) / bins;
        for (let b = 0; b < bins; b++) for (let a = 0; a < bins; a++) {
            const v = H[b * bins + a];
            if (!v) continue;
            const [r, g, bl] = viridis(Math.sqrt(v / max));
            c.fillStyle = `rgb(${r},${g},${bl})`;
            const X0 = px(xr[0] + a * dx), X1 = px(xr[0] + (a + 1) * dx), Y0 = py(yr[0] + b * dy), Y1 = py(yr[0] + (b + 1) * dy);
            c.fillRect(Math.min(X0, X1), Math.min(Y0, Y1), Math.abs(X1 - X0) + 0.5, Math.abs(Y1 - Y0) + 0.5);
        }
        ax.done();
    };
}

/** Small key–value statistics list (dl). items: [[label, value, unit?]]. */
export function statList(items) {
    const dl = el('dl', { class: 'io-stats' });
    for (const [k, v, u] of items) dl.appendChild(el('div', null, el('dt', { text: k }), el('dd', { text: (typeof v === 'number' ? fmtNum(v) : String(v)) + (u ? ` ${u}` : '') })));
    return dl;
}

/**
 * Display histogram of values: 10–80 equal bins over the data range; when the spread is tiny compared with the
 * values (e.g. kinetic energies of 1000.007 ± 0.001 eV) the bins are taken on value − offset and the label says so.
 * @returns {{ edges: number[], counts: number[], offset: number, label: string }}
 */
export function displayHistogram(values, label, { minBins = 10, maxBins = 80, offsetBelow = 1e-4 } = {}) {
    const v = [];
    for (const x of values) if (Number.isFinite(x)) v.push(x);
    if (!v.length) return { edges: [0, 1], counts: [0], offset: 0, label };
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; sum += x; }
    const mean = sum / v.length;
    let offset = 0, lab = label;
    if (hi > lo && (hi - lo) < offsetBelow * Math.abs(mean)) {
        offset = parseFloat(mean.toPrecision(Math.max(3, Math.ceil(-Math.log10((hi - lo) / Math.abs(mean))) + 1)));
        const m = /\s*\(([^)]*)\)$/.exec(label);
        lab = `${m ? label.slice(0, m.index) : label} − ${fmtNum(offset, 8)}${m ? ` (${m[1]})` : ''}`;
    }
    const a = lo - offset, b = hi - offset;
    const n = Math.max(minBins, Math.min(maxBins, Math.round(2 * Math.sqrt(v.length))));
    const span = b > a ? b - a : (Math.abs(a) || 1) * 1e-6;
    const x0 = b > a ? a : a - span / 2;
    const edges = [], counts = new Array(n).fill(0);
    for (let i = 0; i <= n; i++) edges.push(x0 + span * i / n);
    for (const x of v) { let k = Math.floor((x - offset - x0) / span * n); if (k >= n) k = n - 1; if (k < 0) k = 0; counts[k]++; }
    return { edges, counts, offset, label: lab };
}

export { el as h };
