/* ==========================================================================
   Ion optics UI: mobile.js
   Phone viewer mode (spec §4.11, below 760 px): compact app bar (Presets,
   Run, menu), canvas at 55vh with one-finger pan, pinch zoom and long-press
   probe, and a bottom sheet with Voltages (electrode and parameter
   sliders), Beam (count, energy, species), Results (Summary, TOF, Planes)
   and More (Presets, Share, Help, pinned runs, Benchmarks). Drawing tools are hidden ("Geometry
   editing needs a larger screen"); parameters stay editable.
   ========================================================================== */
import { h, icon, clear } from './dom.js';
import { voltageControl } from './panels/electrodes.js';
import { mountParams } from './panels/params.js';
import { createField, locate, storeEvalExpr } from './forms.js';
import { SPECIES } from '../engine/particles.js';

export const PHONE_QUERY = '(max-width: 759.98px)';
const TABS = [['volt', 'Voltages'], ['beam', 'Beam'], ['results', 'Results'], ['more', 'More']];

/** Installs viewer mode; returns { active, showSheet(tab) }. */
export function createMobile(ctx, app) {
    const { store, view } = ctx;
    const sheet = document.getElementById('io-sheet');
    const bar = document.getElementById('io-viewbar');
    const mq = typeof matchMedia === 'function' ? matchMedia(PHONE_QUERY) : null;
    const note = h('span', { class: 'io-phone-note', text: 'Geometry editing needs a larger screen.' });
    if (bar) bar.appendChild(note);
    let built = false, active = false, current = 'volt';
    const tabs = [], panels = new Map(), mounted = new Map();

    function buildSheet() {
        if (built || !sheet) return;
        built = true;
        const tl = h('div', { class: 'io-sheet-tabs', role: 'tablist', 'aria-label': 'Controls' });
        const body = h('div', { class: 'io-sheet-body' });
        TABS.forEach(([id, label], i) => {
            const b = h('button', { type: 'button', role: 'tab', id: 'io-sheettab-' + id, 'aria-controls': 'io-sheetpanel-' + id, 'aria-selected': 'false', tabindex: '-1', text: label });
            b.addEventListener('click', () => show(id, true));
            b.addEventListener('keydown', (e) => {
                let k = -1;
                if (e.key === 'ArrowRight') k = (i + 1) % TABS.length; else if (e.key === 'ArrowLeft') k = (i - 1 + TABS.length) % TABS.length;
                else if (e.key === 'Home') k = 0; else if (e.key === 'End') k = TABS.length - 1;
                if (k >= 0) { e.preventDefault(); show(TABS[k][0], true); tabs[k].focus(); }
            });
            tabs.push(b);
            tl.appendChild(b);
            const p = h('div', { role: 'tabpanel', id: 'io-sheetpanel-' + id, class: 'io-sheet-panel', 'aria-labelledby': 'io-sheettab-' + id, hidden: true, tabindex: '0' });
            panels.set(id, p);
            body.appendChild(p);
        });
        sheet.append(tl, body);
    }
    let folded = true;
    function fold(on) {
        folded = on;
        if (sheet) sheet.classList.toggle('io-sheet-folded', on);
        tabs.forEach((b) => b.setAttribute('aria-expanded', b.getAttribute('aria-selected') === 'true' && !on ? 'true' : 'false'));
    }
    function show(id, user = false) {
        // a tap on the open tab folds the sheet down to its tab row; any other tap opens it on that tab
        if (user) fold(id === current && !folded);
        current = id;
        tabs.forEach((b, i) => { const on = TABS[i][0] === id; b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
        for (const [k, p] of panels) p.hidden = k !== id;
        if (!mounted.has(id)) { mounted.set(id, true); fill(id, panels.get(id)); }
        if (user) store.setUi('sheetTab', id);
        fold(folded);
    }
    function fill(id, host) {
        if (id === 'volt') {
            const box = h('div');
            host.append(h('p', { class: 'io-sheet-note', text: 'Drag a slider; trajectories update live.' }), box, h('h3', { class: 'io-group-title', text: 'Parameters' }));
            const pbox = h('div');
            host.appendChild(pbox);
            let sig = '', ctrls = [];
            const rebuild = () => {
                const els = (store.get().project.electrodes || []).filter((e) => e.id !== 'gnd' && !e.ground);
                const s = els.map((e) => e.id).join('|');
                if (s === sig) { ctrls.forEach((c) => c.sync()); return; }
                sig = s;
                clear(box);
                ctrls = els.map((e) => { const c = voltageControl(ctx, app, e.id, { label: e.name || e.id, guide: false }); box.appendChild(c.el); return c; });
                if (!els.length) box.appendChild(h('p', { class: 'io-empty', text: 'No electrodes with a voltage.' }));
            };
            rebuild();
            ['project', 'resolved'].forEach((evt) => store.on(evt, rebuild));
            mountParams(pbox, ctx, app);
        } else if (id === 'beam') {
            beamPanel(host);
        } else if (id === 'results') {
            for (const [pid, label] of [['summary', 'Summary'], ['tof', 'TOF'], ['planes', 'Planes']]) {
                const det = h('details', { class: 'io-card', open: pid === 'summary' }, h('summary', { text: label }));
                const box = h('div', { class: 'io-dockpanel' });
                det.appendChild(box);
                host.appendChild(det);
                let done = false;
                const load = () => { if (done) return; done = true; if (app.mountPanelInto) app.mountPanelInto(pid, box); };
                if (det.open) load(); else det.addEventListener('toggle', () => { if (det.open) load(); });
            }
        } else if (id === 'more') {
            const share = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('share', 16), h('span', { text: 'Share a link' }));
            share.addEventListener('click', () => app.share());
            const presets = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('layers', 16), h('span', { text: 'Presets' }));
            presets.addEventListener('click', () => app.openPresets());
            const help = h('a', { class: 'btn btn-secondary btn-sm', href: 'help/', target: '_blank', rel: 'noopener' }, icon('help', 16), h('span', { text: 'Help' }));
            const det = h('details', { class: 'io-card' }, h('summary', { text: 'Benchmarks' }));
            const box = h('div', { class: 'io-dockpanel' });
            det.appendChild(box);
            let done = false;
            det.addEventListener('toggle', () => { if (det.open && !done) { done = true; if (app.mountPanelInto) app.mountPanelInto('bench', box); } });
            host.append(h('div', { class: 'io-btnrow' }, presets, share, help), pinnedCard(), det,
                h('p', { class: 'io-sheet-note', text: 'Geometry editing, the inspector and the other result tabs need a larger screen. Everything runs in this browser.' }));
        }
    }
    /**
     * Runs pinned on a larger screen (saved in this browser) are drawn as dashed ghosts here too: the phone has no Compare
     * tab, so this card hides them or unpins them all.
     */
    function pinnedCard() {
        const card = h('div', { class: 'io-card io-phone-pins' });
        const txt = h('p', { class: 'io-sheet-note' });
        const hideB = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' });
        const unpinB = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Unpin all' });
        card.append(txt, h('div', { class: 'io-btnrow' }, hideB, unpinB));
        const pins = () => store.get().runs || [];
        const sync = () => {
            const ps = pins(), shown = ps.filter((p) => p.visible !== false).length;
            card.hidden = !ps.length;
            txt.textContent = `${ps.length === 1 ? '1 pinned run' : `${ps.length} pinned runs`} (from the Compare tab on a larger screen); ${shown ? `${shown} drawn as dashed ghosts on the canvas when the geometry matches` : 'hidden on the canvas'}.`;
            hideB.textContent = shown ? 'Hide on the canvas' : 'Show on the canvas';
        };
        hideB.addEventListener('click', () => { const show = !pins().some((p) => p.visible !== false); for (const p of pins()) store.pinRun({ ...p, visible: show }); });
        unpinB.addEventListener('click', async () => {
            const n = pins().length;
            const ok = ctx.ui && ctx.ui.openDialog ? await ctx.ui.openDialog({ title: 'Unpin all runs', body: `Remove all ${n} pinned runs from this browser?`, actions: [{ label: 'Cancel', value: false }, { label: 'Unpin all', value: true, primary: true }] }) : true;
            if (ok !== true) return;
            for (const p of pins()) store.unpinRun(p.id);
        });
        store.on('runs', sync);
        sync();
        return card;
    }
    function beamPanel(host) {
        const box = h('div');
        host.appendChild(box);
        let sig = '';
        let syncs = [];
        const rebuild = () => {
            const p = store.get().project;
            const srcs = p.sources || [];
            const s = srcs.map((x) => `${x.id}:${x.sampling}:${x.energy && x.energy.type}`).join('|');
            if (s === sig) { syncs.forEach((f) => f()); return; }
            sig = s;
            clear(box);
            syncs = [];
            if (!srcs.length) { box.appendChild(h('p', { class: 'io-empty', text: 'This project has no particle sources.' })); return; }
            for (const src of srcs) {
                const id = src.id;
                const card = h('div', { class: 'io-card' }, h('div', { class: 'io-card-title', text: src.name || id }));
                const ev = storeEvalExpr(ctx);
                if (src.sampling === 'random') {
                    const f = createField({ key: 'count', label: 'Particles', kind: 'int', min: 0 }, { evalExpr: ev, idPrefix: 'io-mb', onCommit: (v) => ctx.commit((d) => { const L = locate(d, 'source', id); if (L) L.obj.count = v; }, { label: 'Particles' }) });
                    card.appendChild(f.el);
                    syncs.push(() => { const L = locate(store.get().project, 'source', id); if (L) f.sync(L.obj.count); });
                }
                if (src.energy && src.energy.type === 'mono') {
                    const f = createField({ key: 'ke', label: 'Kinetic energy', kind: 'number', dim: 'energy', min: 0 }, { evalExpr: ev, idPrefix: 'io-me', onCommit: (v) => ctx.commit((d) => { const L = locate(d, 'source', id); if (L) L.obj.energy.ke = v; }, { label: 'Energy' }) });
                    card.appendChild(f.el);
                    syncs.push(() => { const L = locate(store.get().project, 'source', id); if (L && L.obj.energy) f.sync(L.obj.energy.ke); });
                } else card.appendChild(h('p', { class: 'io-sheet-note', text: 'Energy distribution: edit it on a larger screen.' }));
                const sel = h('select', { class: 'input io-select', id: 'io-msp-' + id }, h('option', { value: '', text: (src.species || []).map((x) => x.label).join(', ') || 'Species' }),
                    ...SPECIES.map((x) => h('option', { value: x.id, text: x.label })));
                sel.addEventListener('change', () => {
                    const sp = SPECIES.find((x) => x.id === sel.value);
                    if (!sp) return;
                    ctx.commit((d) => { const L = locate(d, 'source', id); if (L) L.obj.species = [{ label: sp.label, mass: parseFloat(sp.mass.toPrecision(10)), charge: sp.charge, fraction: 1 }]; }, { label: 'Species' });
                });
                card.appendChild(h('div', { class: 'field' }, h('label', { for: 'io-msp-' + id, text: 'Species' }), sel));
                syncs.push(() => { const L = locate(store.get().project, 'source', id); if (L && sel.options[0]) sel.options[0].textContent = (L.obj.species || []).map((x) => x.label).join(', ') || 'Species'; });
                box.appendChild(card);
            }
            syncs.forEach((f) => f());
        };
        rebuild();
        ['project', 'resolved'].forEach((evt) => store.on(evt, rebuild));
    }
    function apply() {
        const on = !!(mq && mq.matches);
        if (on === active) return;
        active = on;
        document.getElementById('io-workbench')?.classList.toggle('io-viewer', on);
        view.setViewerMode(on);
        if (app.tools) app.tools.setViewerMode(on);
        if (sheet) sheet.hidden = !on;
        if (on) { buildSheet(); show(store.get().ui.sheetTab || current); fold(true); }
        setTimeout(() => view.resize(), 0);
    }
    if (mq) { if (mq.addEventListener) mq.addEventListener('change', apply); else if (mq.addListener) mq.addListener(apply); }
    apply();
    return {
        get active() { return active; },
        showSheet(id) { if (!active) return false; buildSheet(); show(id); fold(false); return true; },
    };
}
