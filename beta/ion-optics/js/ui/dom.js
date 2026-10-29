/* ==========================================================================
   Ion optics UI: dom.js
   Small DOM helpers shared by the workbench UI and its panels: element
   construction (user strings only through textContent), events, timing,
   number formatting, icons, focus handling, downloads and the clipboard.
   ========================================================================== */

/**
 * Creates an element. attrs: class, text (textContent), dataset {}, style {} | string,
 * on {type: fn}, any other attribute (true → empty attribute, false/null → skipped).
 * Children: Node | string (as text) | arrays of those | null.
 * @param {string} tag
 * @param {object} [attrs]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs = null, ...children) {
    const el = document.createElement(tag);
    if (attrs) applyAttrs(el, attrs);
    append(el, children);
    return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Creates an SVG element with attributes (no text handling beyond `text`). */
export function svg(tag, attrs = null, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
        for (const k of Object.keys(attrs)) {
            const v = attrs[k];
            if (v === null || v === undefined || v === false) continue;
            if (k === 'text') el.textContent = String(v);
            else if (k === 'class') el.setAttribute('class', v);
            else el.setAttribute(k, v === true ? '' : String(v));
        }
    }
    append(el, children);
    return el;
}

function applyAttrs(el, attrs) {
    for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'dataset') { for (const d of Object.keys(v)) if (v[d] !== null && v[d] !== undefined) el.dataset[d] = String(v[d]); }
        else if (k === 'style') {
            if (typeof v === 'string') el.setAttribute('style', v);
            else for (const s of Object.keys(v)) { if (s.startsWith('--')) el.style.setProperty(s, v[s]); else el.style[s] = v[s]; }
        } else if (k === 'on') { for (const t of Object.keys(v)) el.addEventListener(t, v[t]); }
        else if (k === 'value' && 'value' in el) el.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'open') { el[k] = !!v; if (k === 'hidden' || k === 'disabled') { /* reflected */ } }
        else el.setAttribute(k, v === true ? '' : String(v));
    }
}

/** Appends children (Node, string → text node, arrays, null skipped). */
export function append(el, children) {
    for (const c of children) {
        if (c === null || c === undefined || c === false) continue;
        if (Array.isArray(c)) append(el, c);
        else if (typeof c === 'string' || typeof c === 'number') el.appendChild(document.createTextNode(String(c)));
        else el.appendChild(c);
    }
    return el;
}

/** Removes every child. */
export function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }

/** querySelector shorthand. */
export function $(sel, root = document) { return root.querySelector(sel); }
/** querySelectorAll as an array. */
export function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

/** Adds an event listener and returns a function that removes it. */
export function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    return () => target.removeEventListener(type, fn, opts);
}

/** HTML-escapes a string (for the rare places that build markup from data). */
export function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Debounce: fn runs ms after the last call. The returned function has .cancel() and .flush(). */
export function debounce(fn, ms) {
    let timer = null, lastArgs = null;
    const d = (...args) => {
        lastArgs = args;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; fn(...lastArgs); }, ms);
    };
    d.cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    d.flush = () => { if (timer !== null) { clearTimeout(timer); timer = null; fn(...(lastArgs || [])); } };
    return d;
}

/** Runs fn at most once per animation frame with the latest arguments. */
export function rafThrottle(fn) {
    let pending = false, lastArgs = null;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 16);
    return (...args) => {
        lastArgs = args;
        if (pending) return;
        pending = true;
        raf(() => { pending = false; fn(...lastArgs); });
    };
}

let uidCounter = 0;
/** Unique id string for element ids (label/for pairs, aria-controls). */
export function uid(prefix = 'io') { uidCounter += 1; return `${prefix}-${uidCounter}`; }

/** Number to string with a Unicode minus sign; digits = significant digits. */
export function fmt(v, digits = 6) {
    if (v === null || v === undefined) return '—';
    if (typeof v !== 'number') return String(v);
    if (Number.isNaN(v)) return '—';
    if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
    if (v === 0) return '0';
    const a = Math.abs(v);
    let s;
    if (a >= 1e-3 && a < 1e6) s = String(parseFloat(v.toPrecision(digits)));
    else {
        const [m, e] = v.toExponential(Math.max(0, digits - 1)).split('e');
        s = String(parseFloat(m)) + 'e' + e.replace('+', '');
    }
    return s.replace(/^-/, '−').replace(/e-/, 'e−');
}

/** Fixed decimals with a Unicode minus. */
export function fmtFixed(v, decimals = 2) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    return v.toFixed(decimals).replace(/^-/, '−');
}

/** Seconds or milliseconds for timings. */
export function fmtMs(ms) {
    if (!(ms >= 0)) return '—';
    if (ms < 1) return '< 1 ms';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

/** Large counts with thin separators (52 000 → "52k" when compact). */
export function fmtCount(n, compact = false) {
    if (!(n >= 0)) return '—';
    if (compact) {
        if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
        if (n >= 1e4) return Math.round(n / 1e3) + 'k';
    }
    return Math.round(n).toLocaleString('en-US');
}

/** Clamp helper. */
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Reads a CSS custom property (trimmed) from an element (default: :root). */
export function cssVar(name, el = document.documentElement) {
    return getComputedStyle(el).getPropertyValue(name).trim();
}

/** Elements that can take keyboard focus inside root, in DOM order. */
export function focusables(root) {
    const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary';
    return $$(sel, root).filter((el) => !el.hidden && el.offsetParent !== null && !el.closest('[inert]'));
}

/**
 * Keeps Tab focus inside root (for non-modal popovers and drawers; <dialog> showModal traps natively).
 * @returns {() => void} release function
 */
export function trapFocus(root) {
    const onKey = (e) => {
        if (e.key !== 'Tab') return;
        const list = focusables(root);
        if (!list.length) { e.preventDefault(); return; }
        const first = list[0], last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    root.addEventListener('keydown', onKey);
    return () => root.removeEventListener('keydown', onKey);
}

/** Saves a Blob under a file name. */
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename, hidden: true });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

/** Saves text as a file. */
export function downloadText(text, filename, type = 'text/plain') {
    downloadBlob(new Blob([text], { type: type + ';charset=utf-8' }), filename);
}

/** Copies text to the clipboard; resolves true on success. */
export async function copyText(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall back below */ }
    try {
        const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0', 'aria-hidden': 'true' });
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch (e) { return false; }
}

/** Safe file-name stem from a project name. */
export function fileStem(name) {
    const s = String(name || 'project').trim().replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(0, 60);
    return s || 'project';
}

/* ---------------------------------------------------------------- icons
   24×24 stroke icons (constant markup, never user data). */
const P = {
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
    live: '<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/><path d="M7.1 16.9a7 7 0 0 1 0-9.8M16.9 7.1a7 7 0 0 1 0 9.8"/>',
    solve: '<path d="M4 18c3-9 5-12 8-12s5 3 8 12"/><path d="M4 12h16" stroke-dasharray="2 2.5"/>',
    share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.6M8.2 13.2l7.6 4.6"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.8-2.5 2.2-2.5 3.9"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1.2"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    up: '<path d="m6 15 6-6 6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 8v6M8 11h6"/>',
    zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M8 11h6"/>',
    select: '<path d="M5 3l14 8-6 2-3 6z"/>',
    pan: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
    box: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
    tube: '<rect x="3" y="4" width="18" height="4" rx="1"/><rect x="3" y="16" width="18" height="4" rx="1"/><path d="M3 12h18" stroke-dasharray="2 2"/>',
    plate: '<rect x="10" y="2" width="4" height="7" rx="1"/><rect x="10" y="15" width="4" height="7" rx="1"/><path d="M3 12h18" stroke-dasharray="2 2"/>',
    disc: '<rect x="9" y="5" width="6" height="14" rx="1"/><path d="M3 12h18" stroke-dasharray="2 2"/>',
    circle: '<circle cx="12" cy="12" r="7"/>',
    annulus: '<path d="M4 12a8 8 0 0 1 16 0"/><path d="M8 12a4 4 0 0 1 8 0"/><path d="M4 12h4M16 12h4"/>',
    polygon: '<path d="M5 18 4 8l8-5 8 6-3 10z"/>',
    line: '<path d="M4 18 20 6"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="6" r="1.5"/>',
    quadric: '<path d="M4 4c3 6 3 10 0 16M20 4c-3 6-3 10 0 16"/>',
    source: '<circle cx="6" cy="12" r="2.5" fill="currentColor"/><path d="M10 12h10M10 8l10-3M10 16l10 3"/>',
    plane: '<path d="M14 3v18" /><path d="M5 12h7m-3-3 3 3-3 3"/>',
    measure: '<path d="m3 17 14-14 4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
    probe: '<path d="M3 20 20 4"/><path d="M3 20h4M3 20v-4"/><circle cx="20" cy="4" r="1.5"/>',
    wave: '<path d="M2 12c2.5-6 4.5-6 7 0s4.5 6 7 0 4.5-6 6 0"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.2" fill="currentColor"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor"/><circle cx="16" cy="10" r="1.2" fill="currentColor"/><path d="M12 21a3 3 0 0 1 0-6h1.5a2 2 0 0 0 0-4"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
    grip: '<circle cx="9" cy="6" r="1.2" fill="currentColor"/><circle cx="15" cy="6" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="18" r="1.2" fill="currentColor"/><circle cx="15" cy="18" r="1.2" fill="currentColor"/>',
    mirror: '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7 4 12l5 5zM15 7l5 5-5 5z"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    electrode: '<rect x="4" y="9" width="16" height="6" rx="1"/><path d="M12 9V4M9 4h6"/>',
    shapes: '<rect x="3" y="3" width="10" height="10" rx="1"/><circle cx="16" cy="16" r="5"/>',
    params: '<path d="M7 4c-2 0-2 2-2 4s-2 4-2 4 2 2 2 4 0 4 2 4M17 4c2 0 2 2 2 4s2 4 2 4-2 2-2 4 0 4-2 4"/><path d="M10 15l4-6"/>',
    particles: '<circle cx="5" cy="12" r="2" fill="currentColor"/><path d="M8 12c4 0 6-6 13-6M8 12h13M8 12c4 0 6 6 13 6"/>',
    magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z"/><path d="M6 8h4M14 8h4"/>',
    recording: '<path d="M15 3v18"/><path d="M4 8h7M4 12h7M4 16h7"/>',
    domain: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 10h18M3 15h18M9 5v14M15 5v14" opacity=".5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.5" r=".6" fill="currentColor"/>',
    warn: '<path d="M12 3 2 20h20z"/><path d="M12 9v5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
    download: '<path d="M12 4v11m-5-5 5 5 5-5"/><path d="M4 19h16"/>',
    upload: '<path d="M12 20V9m-5 5 5-5 5 5"/><path d="M4 5h16"/>',
    describe: '<path d="M4 6h16M4 10h16M4 14h10M4 18h7"/>',
    expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    dock: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 14h18"/>',
    inspector: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M15 4v16"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.2 19.8a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 1.5 14.6H1.4a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 3 9.3l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.1 5V4.9a2 2 0 1 1 4 0V5a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 19.6 9H20a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-.5 2z"/>',
};

/**
 * Inline SVG icon element (aria-hidden).
 * @param {string} name key of the icon table
 * @param {number} [size]
 */
export function icon(name, size = 18) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size));
    s.setAttribute('height', String(size));
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.8');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.classList.add('io-icon');
    // constant markup from the table above (never user data)
    s.innerHTML = P[name] || P.info;
    return s;
}

/** Names of the available icons. */
export const ICON_NAMES = Object.keys(P);

/** True when the user asked for reduced motion. */
export function reducedMotion() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Deep clone for plain JSON data. */
export function clone(v) {
    return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

/** Rounds a coordinate to a clean value (12 significant digits) so handle edits give tidy JSON. */
export function tidy(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return v;
    const r = parseFloat(v.toPrecision(12));
    return Object.is(r, -0) ? 0 : r;
}

/**
 * Drop-down menu (WAI-ARIA menu button): items are { label, onSelect, shortcut?, disabled?, separator? }
 * or a function returning them (evaluated on each opening). Arrow keys move, Escape and Tab close, focus returns
 * to the button. The menu is placed in `layer` (default: the button's offset parent).
 * @returns {{ open(): void, close(): void, el: HTMLElement }}
 */
export function createMenu(button, items, { layer = null, label = '' } = {}) {
    const menu = h('div', { class: 'io-menu', role: 'menu', hidden: true, 'aria-label': label || button.getAttribute('aria-label') || button.textContent.trim() });
    const host = layer || document.getElementById('io-workbench') || document.body;
    host.appendChild(menu);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    let open = false;
    const list = () => (typeof items === 'function' ? items() : items) || [];
    function build() {
        clear(menu);
        for (const it of list()) {
            if (it.separator) { menu.appendChild(h('hr', { role: 'separator' })); continue; }
            const b = h('button', { type: 'button', role: 'menuitem', tabindex: '-1', disabled: !!it.disabled }, h('span', { text: it.label }), it.shortcut ? h('kbd', { text: it.shortcut }) : null);
            b.addEventListener('click', () => { closeMenu(false); try { it.onSelect && it.onSelect(); } catch (e) { /* reported by the item */ } });
            menu.appendChild(b);
        }
    }
    function place() {
        const r = button.getBoundingClientRect(), hr = host.getBoundingClientRect();
        menu.style.left = Math.max(4, Math.min(r.left - hr.left, hr.width - menu.offsetWidth - 4)) + 'px';
        menu.style.top = (r.bottom - hr.top + 4) + 'px';
    }
    function openMenu() {
        build();
        menu.hidden = false; open = true;
        button.setAttribute('aria-expanded', 'true');
        place();
        const first = menu.querySelector('[role="menuitem"]:not([disabled])');
        if (first) first.focus();
    }
    function closeMenu(refocus = true) {
        if (!open) return;
        menu.hidden = true; open = false;
        button.setAttribute('aria-expanded', 'false');
        if (refocus) button.focus();
    }
    button.addEventListener('click', (e) => { e.stopPropagation(); if (open) closeMenu(); else openMenu(); });
    button.addEventListener('keydown', (e) => { if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && !open) { e.preventDefault(); openMenu(); } });
    menu.addEventListener('keydown', (e) => {
        const its = [...menu.querySelectorAll('[role="menuitem"]:not([disabled])')];
        const i = its.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); its[(i + 1) % its.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); its[(i - 1 + its.length) % its.length].focus(); }
        else if (e.key === 'Home') { e.preventDefault(); its[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); its[its.length - 1].focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
        else if (e.key === 'Tab') closeMenu(false);
    });
    document.addEventListener('pointerdown', (e) => { if (open && !menu.contains(e.target) && e.target !== button && !button.contains(e.target)) closeMenu(false); });
    return { open: openMenu, close: closeMenu, el: menu };
}
