/* ==========================================================================
   Ion optics UI: panels/guide.js
   Coach marks (spec §4.8, §4.14, §2.5): startGuide(ctx, guideSpec) walks
   through a preset's guide one step at a time. Each step points at an
   element of the workbench by its data-guide attribute ("toolbar:presets",
   "electrode:<id>", "rail:<tab>", "dock:<tab>", "canvas"), outlines it and
   shows a small non-modal card next to it with Back, Next and "End tour".
   A step may first open a rail or dock tab ({ open: { rail, dock } }).
   A step whose target is not on screen after 1.5 s (the phone layout has
   no rail or dock tabs) is skipped; a tour with nothing to show ends
   quietly. Escape or "End tour" closes it; focus returns where it was.

   GuideSpec = { id, title, steps: [{ target, title, text, open?: { rail?, dock? } }] }
   ========================================================================== */

export const meta = { id: 'guide', title: 'Guide', order: 0 };

let active = null;

/**
 * Every data-guide target a guide uses (pure; for tests and checks).
 * @param {object} guideSpec
 * @returns {string[]}
 */
export function guideTargets(guideSpec) {
    const out = [];
    for (const s of (guideSpec && guideSpec.steps) || []) {
        if (s.target && !out.includes(s.target)) out.push(s.target);
        if (s.open && s.open.rail && !out.includes('rail:' + s.open.rail)) out.push('rail:' + s.open.rail);
        if (s.open && s.open.dock && !out.includes('dock:' + s.open.dock)) out.push('dock:' + s.open.dock);
    }
    return out;
}

/**
 * Checks a guide spec; returns a list of problems (empty when valid).
 * @param {object} guideSpec
 * @returns {string[]}
 */
export function validateGuide(guideSpec) {
    const errs = [];
    if (!guideSpec || typeof guideSpec !== 'object') return ['the guide must be an object'];
    if (typeof guideSpec.id !== 'string' || !guideSpec.id) errs.push('id is missing');
    if (!Array.isArray(guideSpec.steps) || !guideSpec.steps.length) errs.push('steps must be a non-empty list');
    (guideSpec.steps || []).forEach((s, i) => {
        if (!s || typeof s.target !== 'string' || !/^(toolbar|electrode|rail|dock):[A-Za-z0-9_.:-]+$|^canvas$/.test(s.target)) errs.push(`steps[${i}].target is not a data-guide value`);
        if (typeof s.title !== 'string' || !s.title) errs.push(`steps[${i}].title is missing`);
        if (typeof s.text !== 'string' || !s.text) errs.push(`steps[${i}].text is missing`);
        if (s.open && typeof s.open !== 'object') errs.push(`steps[${i}].open must be an object`);
    });
    return errs;
}

/** Ends the running guide, if any. */
export function stopGuide() {
    if (active) active.close('stopped');
}

function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'text') n.textContent = String(v);
        else if (k === 'class') n.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
        else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
}
let uidN = 0;
const uid = (p) => `${p}-${++uidN}`;
const cssEscape = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
const findTarget = (t) => document.querySelector(`[data-guide="${cssEscape(t)}"]`);
function isShown(node) {
    if (!node || !node.isConnected) return false;
    const r = node.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return false;
    for (let n = node; n && n !== document.body; n = n.parentElement) if (n.hidden) return false;
    return true;
}
/** Clicks a tab (rail or dock) unless it is already selected. */
function openTab(target) {
    const tab = findTarget(target);
    if (!tab || !isShown(tab)) return;
    if (tab.getAttribute('aria-selected') === 'true') return;
    tab.click();
}

/**
 * Starts a guide (any running guide ends first).
 * @param {object} ctx panel context (spec §2.5); uses ctx.ui.announce when present
 * @param {object} guideSpec { id, title, steps: [{ target, title, text, open? }] }
 * @returns {{ close(reason?: string): void, next(): void, back(): void, readonly step: number, done: Promise<string> }}
 *   done resolves with 'finished', 'ended' (by the user), 'stopped' or 'replaced'
 */
export function startGuide(ctx, guideSpec) {
    if (active) active.close('replaced');
    const problems = validateGuide(guideSpec);
    if (problems.length) throw new Error('Invalid guide: ' + problems.join('; '));
    const steps = guideSpec.steps;
    const prevFocus = document.activeElement;
    const titleId = uid('io-coach-title'), textId = uid('io-coach-text');
    const ring = el('div', { class: 'io-coach-ring', 'aria-hidden': 'true' });
    const count = el('span', { class: 'io-coach-count' });
    const title = el('h2', { id: titleId, class: 'io-coach-title' });
    const text = el('p', { id: textId, class: 'io-coach-text' });
    const endBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm io-coach-end', text: 'End tour' });
    const backBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm io-coach-back', text: 'Back' });
    const nextBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm io-coach-next', text: 'Next' });
    const arrow = el('span', { class: 'io-coach-arrow', 'aria-hidden': 'true' });
    const card = el('div', { class: 'io-coach', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId, 'aria-describedby': textId, tabindex: '-1', 'data-guide-id': guideSpec.id },
        arrow, el('div', { class: 'io-coach-top' }, count, el('span', { class: 'io-coach-name', text: guideSpec.title || 'Tour' })), title, text,
        el('div', { class: 'io-coach-actions' }, endBtn, el('span', { class: 'io-coach-spacer' }), backBtn, nextBtn));
    document.body.append(ring, card);

    let index = -1, target = null, timer = null, raf = 0, closed = false, token = 0;
    // steps whose target is not on screen are skipped, and the numbering counts only the steps that can be shown; on phones
    // (no rail or dock tabs) the steps without a visible target are dropped at once instead of after a wait each
    const skipped = new Set();
    const phone = !!(ctx && ctx.ui && typeof ctx.ui.isPhone === 'function' && ctx.ui.isPhone());
    if (phone) steps.forEach((st, i) => { const t = findTarget(st.target); if (!(t && isShown(t))) skipped.add(i); });
    const label = (i) => {
        let pos = 0;
        for (let k = 0; k <= i; k++) if (!skipped.has(k)) pos++;
        return `Step ${pos} of ${steps.length - skipped.size}`;
    };
    let resolveFn;
    const done = new Promise((res) => { resolveFn = res; });

    function place() {
        raf = 0;
        if (closed) return;
        if (target && !isShown(target)) target = null;
        const vw = window.innerWidth, vh = window.innerHeight, m = 8;
        const cw = card.offsetWidth, ch = card.offsetHeight;
        card.classList.toggle('io-coach-floating', !target);
        ring.hidden = !target;
        if (!target) {
            card.style.left = Math.max(m, (vw - cw) / 2) + 'px';
            card.style.top = Math.max(m, (vh - ch) / 2) + 'px';
            card.dataset.place = 'center';
            return;
        }
        const r = target.getBoundingClientRect();
        ring.style.left = (r.left - 4) + 'px'; ring.style.top = (r.top - 4) + 'px';
        ring.style.width = (r.width + 8) + 'px'; ring.style.height = (r.height + 8) + 'px';
        const gap = 14;
        // a rail tab: stand clear of the whole rail, so the panel the tab opens stays visible
        let right = r.right;
        if (target.getAttribute('role') === 'tab' && typeof target.closest === 'function') {
            const rail = target.closest('#io-rail');
            if (rail) right = Math.max(right, rail.getBoundingClientRect().right);
        }
        const options = [
            ['right', right + gap, r.top + r.height / 2 - ch / 2],
            ['bottom', r.left + r.width / 2 - cw / 2, r.bottom + gap],
            ['top', r.left + r.width / 2 - cw / 2, r.top - gap - ch],
            ['left', r.left - gap - cw, r.top + r.height / 2 - ch / 2],
        ];
        const fits = ([, x, y]) => x >= m && y >= m && x + cw <= vw - m && y + ch <= vh - m;
        let pick = options.find(fits);
        if (!pick) {
            // nothing fits whole: below or above, whichever has more room, clamped into the window
            pick = (vh - r.bottom > r.top) ? options[1] : options[2];
        }
        const x = Math.min(Math.max(m, pick[1]), Math.max(m, vw - m - cw));
        const y = Math.min(Math.max(m, pick[2]), Math.max(m, vh - m - ch));
        card.style.left = x + 'px'; card.style.top = y + 'px';
        card.dataset.place = pick[0];
        // the arrow points at the target's center along the card's facing edge
        if (pick[0] === 'right' || pick[0] === 'left') arrow.style.top = Math.min(Math.max(12, r.top + r.height / 2 - y), ch - 12) + 'px';
        else arrow.style.left = Math.min(Math.max(12, r.left + r.width / 2 - x), cw - 12) + 'px';
        if (pick[0] === 'right' || pick[0] === 'left') arrow.style.left = ''; else arrow.style.top = '';
    }
    const schedule = () => { if (!raf && !closed) raf = requestAnimationFrame(place); };

    // indices of the steps shown so far (Back walks this list, so skipped steps stay skipped)
    const shown = [];
    async function show(i, dir = 1) {
        if (closed) return;
        if (i >= steps.length) { close('finished'); return; }
        if (i < 0) return;
        if (skipped.has(i)) { if (dir < 0 && shown.length) show(shown.pop(), -1); else show(i + 1, 1); return; }
        const my = ++token;
        index = i;
        const s = steps[i];
        count.textContent = label(i);
        title.textContent = s.title;
        text.textContent = s.text;
        nextBtn.textContent = i === steps.length - 1 ? 'Done' : 'Next';
        target = null;
        // hidden while the target is looked up, so the card never flashes in a provisional place
        card.style.visibility = 'hidden';
        ring.hidden = true;
        if (s.open && s.open.rail) openTab('rail:' + s.open.rail);
        if (s.open && s.open.dock) openTab('dock:' + s.open.dock);
        // panels mount lazily: wait up to 1.5 s for the target
        for (let k = 0; k < 15 && !closed && my === token; k++) {
            const t = findTarget(s.target);
            if (t && isShown(t)) { target = t; break; }
            await new Promise((res) => setTimeout(res, 100));
        }
        if (closed || my !== token) return;
        if (!target) {
            // not on screen (the phone layout has no rail or dock tabs): skip the step
            skipped.add(i);
            if (dir < 0 && shown.length) { show(shown.pop(), -1); return; }
            show(i + 1, 1);
            return;
        }
        shown.push(i);
        count.textContent = label(i);
        nextBtn.textContent = steps.slice(i + 1).every((_, k) => skipped.has(i + 1 + k)) ? 'Done' : 'Next';
        backBtn.hidden = shown.length < 2;
        if (typeof target.scrollIntoView === 'function') { try { target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* ignore */ } }
        place();
        card.style.visibility = '';
        try { nextBtn.focus({ preventScroll: true }); } catch (e) { nextBtn.focus(); }
        try { if (ctx && ctx.ui && typeof ctx.ui.announce === 'function') ctx.ui.announce(`Tour, ${label(i).toLowerCase()}: ${s.title}. ${s.text}`); } catch (e) { /* no live region */ }
    }
    function back() {
        if (shown.length < 2) return;
        shown.pop();
        show(shown.pop(), -1);
    }

    function close(reason = 'ended') {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        if (raf) cancelAnimationFrame(raf);
        window.removeEventListener('resize', schedule);
        window.removeEventListener('scroll', schedule, true);
        document.removeEventListener('keydown', onKey, true);
        ring.remove();
        card.remove();
        if (active === api) active = null;
        if (reason !== 'replaced' && prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) { try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        resolveFn(reason);
    }
    function onKey(e) {
        if (e.key !== 'Escape' || !card.contains(document.activeElement)) return;
        e.preventDefault();
        e.stopPropagation();
        close('ended');
    }
    endBtn.addEventListener('click', () => close('ended'));
    backBtn.addEventListener('click', back);
    nextBtn.addEventListener('click', () => show(index + 1, 1));
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    document.addEventListener('keydown', onKey, true);
    timer = setInterval(schedule, 400);

    const api = {
        close, next: () => show(index + 1, 1), back,
        get step() { return index; }, done,
    };
    active = api;
    show(0);
    return api;
}
