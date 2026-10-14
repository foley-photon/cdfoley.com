/* ==========================================================================
   Ion optics UI: panels/compare.js — the Compare tab (later phase, P1b)
   Pinned-run comparison is planned for a later release (spec §7.9); this
   module keeps the registry slot so the tab can say so.
   ========================================================================== */
export const meta = { id: 'compare', title: 'Compare', order: 80, planned: true };

export function mount(el, ctx) {
    const { h } = ctx.ui.dom;
    el.appendChild(h('div', { class: 'io-results' }, h('p', { class: 'io-empty', text: 'Comparing pinned runs (up to 8, with overlays and a metric table) is planned for a later release.' })));
    return { update() {}, destroy() {} };
}
