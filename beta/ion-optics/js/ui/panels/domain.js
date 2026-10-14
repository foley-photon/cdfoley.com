/* ==========================================================================
   Ion optics UI: panels/domain.js
   Domain rail tab (spec §4.3): domain type, extents and cell size with live
   node count, multigrid levels, memory and estimated solve time (from
   jobs.estimate()), cells across the smallest aperture, cell sizes that
   divide the extents; the four edges (fixed voltage, Neumann, axis or a
   profile of segments and ramps), mirrors, what happens beyond each edge;
   solver settings; tracer settings (integrator, trajectory accuracy, field
   interpolation with a one-line explanation, relativistic, limits).
   ========================================================================== */
import { h, icon, clear, fmtCount, fmtMs } from '../dom.js';
import { bindForm, metaFor, normaliseDescriptor, createField, refOptions, storeEvalExpr } from '../forms.js';
import { formatPretty } from '../units.js';

const EDGE_LABELS = { xmin: 'Left edge (x start)', xmax: 'Right edge (x end)', ymin: 'Bottom edge (y start)', ymax: 'Top edge (y end)' };
const NICE = [1, 2, 2.5, 5];

/** Cell sizes near h (within a factor of 4) that divide both extents: [{ cell, nx, ny, N }], closest first. */
export function cellSuggestions(x, y, h, limit = 6) {
    const Lx = x[1] - x[0], Ly = y[1] - y[0];
    if (!(Lx > 0) || !(Ly > 0) || !(h > 0)) return [];
    const out = [];
    const lo = h / 4, hi = h * 4;
    for (let e = Math.floor(Math.log10(lo)) - 1; e <= Math.ceil(Math.log10(hi)) + 1; e++) {
        for (const m of NICE) {
            const c = parseFloat((m * Math.pow(10, e)).toPrecision(12));
            if (c < lo * 0.999 || c > hi * 1.001) continue;
            const nx = Lx / c, ny = Ly / c;
            if (Math.abs(nx - Math.round(nx)) > 1e-9 * Math.max(1, nx) || Math.abs(ny - Math.round(ny)) > 1e-9 * Math.max(1, ny)) continue;
            const NX = Math.round(nx) + 1, NY = Math.round(ny) + 1;
            out.push({ cell: c, nx: NX, ny: NY, N: NX * NY });
        }
    }
    out.sort((a, b) => Math.abs(Math.log(a.cell / h)) - Math.abs(Math.log(b.cell / h)));
    return out.slice(0, limit);
}

/**
 * Smallest aperture radius (plate holes, tube bores, and thin apertures made of lines, polygons, rings or boxes off the axis;
 * the same rule as the W_APERTURE_RES warning, geometry.apertureRadii): { r, shapeId } or null.
 * @param {object} resolved @param {{ compileGeometry?: Function, apertureRadii?: Function }} [geometryApi] engine geometry module
 */
export function smallestAperture(resolved, geometryApi = null) {
    let list = null;
    if (geometryApi && typeof geometryApi.apertureRadii === 'function' && typeof geometryApi.compileGeometry === 'function') {
        try { list = geometryApi.apertureRadii(geometryApi.compileGeometry(resolved), resolved); } catch (e) { list = null; }
    }
    if (!list) {
        list = [];
        for (const s of (resolved && resolved.shapes) || []) {
            if (s.type === 'plate' && s.rHole > 0) list.push({ r: s.rHole, shapeId: s.id });
            else if (s.type === 'tube' && s.rIn > 0) list.push({ r: s.rIn, shapeId: s.id });
        }
    }
    let best = null;
    for (const a of list) if (!best || a.r < best.r) best = { r: a.r, shapeId: a.shapeId };
    return best;
}

/** Rail tab. */
export function mountDomain(host, ctx, app) {
    const { store } = ctx;
    const meta = ctx.engine.schema && ctx.engine.schema.META;
    // ---- grid
    const typeSel = h('select', { id: 'io-dom-type', class: 'input io-select' }, h('option', { value: 'cyl2d', text: 'Cylindrical (x, r): revolved about x' }), h('option', { value: 'planar2d', text: 'Planar (x, y): extruded in z' }));
    typeSel.addEventListener('change', () => changeType(typeSel.value));
    const gridForm = bindForm(ctx, {
        descs: metaFor(meta, 'domain').map(normaliseDescriptor).filter((d) => d.key !== 'type'),
        label: 'Domain', idPrefix: 'io-dom', locate: (p) => (p.domain ? { obj: p.domain, path: 'domain' } : null), resolved: (r) => r.domain,
    });
    const stats = h('p', { class: 'io-note io-dom-stats', role: 'status' });
    const aperture = h('p', { class: 'io-note' });
    const sugg = h('div', { class: 'chip-row io-cell-chips', role: 'group', 'aria-label': 'Cell sizes that divide the extents' });
    // ---- edges
    const edgesBox = h('div', { class: 'io-edges' });
    // ---- mirrors, beyond, solver, tracer
    const mirrorForm = bindForm(ctx, { kind: 'mirror', label: 'Mirror', idPrefix: 'io-mir', locate: (p) => (p.domain ? { obj: p.domain.mirror || {}, path: 'domain.mirror' } : null),
        intercept: (key, value, draft) => { draft.domain.mirror = { x: false, y: false, ...(draft.domain.mirror || {}), [key]: value }; return true; } });
    const beyondForm = bindForm(ctx, { kind: 'beyond', label: 'Beyond the edges', idPrefix: 'io-bey', locate: (p) => (p.domain ? { obj: p.domain.beyond || {}, path: 'domain.beyond' } : null),
        intercept: (key, value, draft) => { draft.domain.beyond = { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop', ...(draft.domain.beyond || {}), [key]: value }; return true; } });
    const solverForm = bindForm(ctx, { kind: 'solver', label: 'Solver', idPrefix: 'io-sol', locate: (p) => (p.solver ? { obj: p.solver, path: 'solver' } : null), resolved: (r) => r.solver });
    const tracerForm = bindForm(ctx, {
        kind: 'tracer', label: 'Tracer', idPrefix: 'io-trc', locate: (p) => (p.tracer ? { obj: p.tracer, path: 'tracer' } : null), resolved: (r) => r.tracer,
        intercept: (key, value, draft) => {
            if (key !== 'quality') return false;
            draft.tracer.quality = value;
            if (value === 'custom' && !draft.tracer.custom) {
                let c = null;
                try { c = ctx.engine.schema.defaults('custom'); } catch (e) { c = null; }
                draft.tracer.custom = c && c.rtol ? c : { rtol: 1e-8, maxStepCells: 0.5, nearStepCells: 0.1, rfStepsPerPeriod: 32, borisStepsPerGyration: 128 };
            }
            return true;
        },
    });
    const customBox = h('div');
    const interpNote = h('p', { class: 'hint' });
    host.append(
        h('h3', { class: 'io-group-title', text: 'Grid' }),
        h('div', { class: 'field io-field-select' }, h('label', { for: 'io-dom-type', text: 'Domain type' }), typeSel),
        gridForm.el, stats, aperture, sugg,
        h('h3', { class: 'io-group-title', text: 'Edges' }), h('p', { class: 'io-note', text: 'Each edge is held at an electrode\'s voltage, has zero normal field (Neumann), is the symmetry axis, or follows a profile of segments and linear ramps.' }), edgesBox,
        h('h3', { class: 'io-group-title', text: 'Mirrors' }), mirrorForm.el,
        h('h3', { class: 'io-group-title', text: 'Leaving the domain' }), beyondForm.el,
        h('details', { class: 'io-card' }, h('summary', { text: 'Field solver' }), solverForm.el, h('p', { class: 'hint', text: 'Automatic runs multigrid, then multigrid-preconditioned BiCGSTAB, then adaptive SOR if needed; the path is shown in the Fields pill.' })),
        h('details', { class: 'io-card', open: true }, h('summary', { text: 'Particle tracing' }), tracerForm.el, interpNote, customBox));

    async function changeType(t) {
        const p = store.get().project;
        if (!p.domain || p.domain.type === t) return;
        const ok = await ctx.ui.openDialog({
            title: 'Change the domain type',
            body: t === 'cyl2d' ? 'Cylindrical domains are bodies of revolution about the x axis: the vertical coordinate becomes the radius r ≥ 0 and the bottom edge becomes the symmetry axis. Shapes keep their numbers.' : 'Planar domains are extruded in z: the vertical coordinate becomes y and the bottom edge gets a fixed voltage (ground). Shapes keep their numbers.',
            actions: [{ label: 'Cancel', value: false }, { label: 'Change', value: true, primary: true }],
        });
        if (ok !== true) { typeSel.value = p.domain.type; return; }
        const r = ctx.commit((d) => {
            const D = d.domain;
            const y = Array.isArray(D.y) ? D.y : [0, 10];
            D.type = t;
            D.edges = D.edges || {};
            if (t === 'cyl2d') {
                const top = typeof y[1] === 'number' && typeof y[0] === 'number' ? Math.max(Math.abs(y[0]), Math.abs(y[1])) : y[1];
                D.y = [0, top];
                D.edges.ymin = { bc: 'axis' };
                D.mirror = { ...(D.mirror || {}), y: false };
            } else {
                D.y = typeof y[1] === 'number' ? [-y[1], y[1]] : y;
                D.edges.ymin = { bc: 'dirichlet', electrode: 'gnd' };
            }
        }, { label: 'Domain type' });
        if (!r.ok) { if (ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' }); typeSel.value = p.domain.type; }
        else if (app.applyProjectView) setTimeout(() => ctx.view.fit(), 0);
    }

    // ---- edges
    let edgeSig = '';
    const edgeEditors = [];
    function buildEdges() {
        const p = store.get().project;
        const D = p.domain || {};
        const edges = D.edges || {};
        edgeSig = sigOfEdges(D);
        clear(edgesBox);
        edgeEditors.length = 0;
        for (const key of ['xmin', 'xmax', 'ymin', 'ymax']) {
            const ed = edges[key] || { bc: 'dirichlet', electrode: 'gnd' };
            const card = h('div', { class: 'io-card io-edge' });
            const cyl = D.type === 'cyl2d';
            const label = cyl && key === 'ymin' ? 'Axis (r = 0)' : cyl && key === 'ymax' ? 'Outer edge (r max)' : EDGE_LABELS[key];
            card.appendChild(h('div', { class: 'io-card-title', text: label }));
            if (cyl && key === 'ymin') {
                card.appendChild(h('p', { class: 'io-note', text: 'Symmetry axis (required for cylindrical domains).' }));
                edgesBox.appendChild(card);
                continue;
            }
            const sid = `io-edge-${key}`;
            const bcSel = h('select', { id: sid, class: 'input io-select' },
                h('option', { value: 'dirichlet', text: 'Fixed voltage (electrode)' }), h('option', { value: 'neumann', text: 'Zero normal field (Neumann)' }), h('option', { value: 'profile', text: 'Profile (segments and ramps)' }));
            bcSel.value = ed.bc === 'axis' ? 'dirichlet' : ed.bc;
            bcSel.addEventListener('change', () => setBc(key, bcSel.value));
            card.appendChild(h('div', { class: 'field' }, h('label', { for: sid, text: 'Boundary' }), bcSel));
            if (ed.bc === 'dirichlet') {
                const elSel = h('select', { id: sid + '-el', class: 'input io-select' }, ...refOptions(p).electrode.map((o) => h('option', { value: o.value, text: o.label })));
                elSel.value = ed.electrode || 'gnd';
                elSel.addEventListener('change', () => commitEdge(key, (e) => { e.electrode = elSel.value; }));
                card.appendChild(h('div', { class: 'field' }, h('label', { for: sid + '-el', text: 'Electrode' }), elSel));
                edgeEditors.push({ key, sync: () => { const e2 = ((store.get().project.domain || {}).edges || {})[key]; if (e2 && document.activeElement !== elSel) elSel.value = e2.electrode || 'gnd'; } });
            } else if (ed.bc === 'profile') {
                card.appendChild(profileEditor(key));
            }
            edgesBox.appendChild(card);
        }
    }
    function edgeRange(key) {
        const st = store.get();
        const r = st.resolved || st.lastResolved;
        const D = r && r.domain ? r.domain : store.get().project.domain;
        const along = key === 'xmin' || key === 'xmax' ? D.y : D.x;
        return [along[0], along[1]];
    }
    function setBc(key, bc) {
        const [a, b] = edgeRange(key);
        commitEdge(key, (e, D) => {
            const next = bc === 'dirichlet' ? { bc, electrode: 'gnd' } : bc === 'neumann' ? { bc } : { bc, segments: [{ from: a, to: b, electrode: e.electrode || 'gnd' }] };
            D.edges[key] = next;
        });
    }
    function commitEdge(key, fn) {
        const r = ctx.commit((d) => {
            d.domain.edges = d.domain.edges || {};
            const e = d.domain.edges[key] || (d.domain.edges[key] = { bc: 'dirichlet', electrode: 'gnd' });
            fn(e, d.domain);
        }, { label: 'Domain edge' });
        if (!r.ok && ctx.ui.toast) { ctx.ui.toast(r.error, { kind: 'warn' }); buildEdges(); }
        return r;
    }
    function profileEditor(key) {
        const box = h('div', { class: 'io-profile' });
        const p = store.get().project;
        const segs = ((p.domain.edges || {})[key] || {}).segments || [];
        const table = h('div', { class: 'io-seg-list' });
        segs.forEach((sg, k) => {
            const row = h('div', { class: 'io-seg-row' });
            const mk = (fkey, label) => createField({ key: fkey, label, kind: 'number', dim: 'length' }, {
                value: sg[fkey], evalExpr: storeEvalExpr(ctx), idPrefix: 'io-seg',
                onCommit: (v) => commitEdge(key, (e) => { e.segments[k][fkey] = v; }),
            });
            const fFrom = mk('from', 'From'), fTo = mk('to', 'To');
            const mode = h('select', { class: 'input io-select', 'aria-label': `Segment ${k + 1} kind` }, h('option', { value: 'el', text: 'Electrode' }), h('option', { value: 'ramp', text: 'Linear ramp' }));
            mode.value = Array.isArray(sg.ramp) ? 'ramp' : 'el';
            const els = refOptions(p).electrode;
            const elA = h('select', { class: 'input io-select', 'aria-label': `Segment ${k + 1} electrode` }, ...els.map((o) => h('option', { value: o.value, text: o.label })));
            const elB = h('select', { class: 'input io-select', 'aria-label': `Segment ${k + 1} ramp end electrode` }, ...els.map((o) => h('option', { value: o.value, text: o.label })));
            if (Array.isArray(sg.ramp)) { elA.value = sg.ramp[0]; elB.value = sg.ramp[1]; } else { elA.value = sg.electrode || 'gnd'; elB.hidden = true; }
            const apply = () => commitEdge(key, (e) => {
                const s = e.segments[k];
                if (mode.value === 'ramp') { delete s.electrode; s.ramp = [elA.value, elB.value]; } else { delete s.ramp; s.electrode = elA.value; }
            });
            mode.addEventListener('change', () => { elB.hidden = mode.value !== 'ramp'; apply(); });
            elA.addEventListener('change', apply); elB.addEventListener('change', apply);
            const rm = h('button', { type: 'button', class: 'io-mini', 'aria-label': `Remove segment ${k + 1}`, title: 'Remove segment' }, icon('trash', 16));
            rm.addEventListener('click', () => commitEdge(key, (e) => { e.segments.splice(k, 1); }));
            row.append(h('div', { class: 'io-form' }, fFrom.el, fTo.el), h('div', { class: 'io-item-row' }, mode, elA, elB, rm));
            table.appendChild(row);
        });
        const add = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, icon('plus', 16), h('span', { text: 'Split the last segment' }));
        add.addEventListener('click', () => commitEdge(key, (e) => {
            const last = e.segments[e.segments.length - 1];
            const st = store.get();
            const r = st.resolved || st.lastResolved;
            const rs = r && r.domain && r.domain.edges && r.domain.edges[key] && r.domain.edges[key].segments;
            const rl = rs ? rs[rs.length - 1] : null;
            const a = rl ? rl.from : (typeof last.from === 'number' ? last.from : 0), b = rl ? rl.to : (typeof last.to === 'number' ? last.to : 1);
            const mid = parseFloat(((a + b) / 2).toPrecision(8));
            e.segments.push({ from: mid, to: last.to, electrode: last.electrode || 'gnd' });
            last.to = mid;
        }));
        const [a, b] = edgeRange(key);
        box.append(table, add, h('p', { class: 'hint', text: `Segments must tile the edge exactly, from ${formatPretty(a, 'length', 6)} to ${formatPretty(b, 'length', 6)}. A ramp is an ideal voltage divider between two electrodes.` }));
        return box;
    }
    function sigOfEdges(D) { return JSON.stringify([D.type, D.edges]); }

    // ---- stats and suggestions
    function syncStats() {
        const st = store.get();
        const r = st.resolved || st.lastResolved;
        const D = r && r.domain;
        if (!D) { stats.textContent = ''; return; }
        let e = null;
        try { e = typeof ctx.jobs.estimate === 'function' ? ctx.jobs.estimate() : null; } catch (err) { e = null; }
        const parts = [`${fmtCount(D.nx)} × ${fmtCount(D.ny)} = ${fmtCount(D.N || D.nx * D.ny)} nodes`];
        if (e) {
            if (e.levels) parts.push(`${e.levels} multigrid levels`);
            parts.push(`${e.bases} basis field${e.bases === 1 ? '' : 's'}`);
            if (e.memMB) parts.push(`about ${e.memMB < 10 ? e.memMB.toFixed(1) : Math.round(e.memMB)} MB`);
            if (e.bases > 0) parts.push(`solve about ${fmtMs(e.solveMs)}`);
        }
        stats.textContent = parts.join(' · ');
        const ap = smallestAperture(r, ctx.engine && ctx.engine.geometry);
        aperture.hidden = !ap;
        if (ap) {
            const cells = ap.r / D.h;
            aperture.textContent = `Smallest aperture radius ${formatPretty(ap.r, 'length', 4)} = ${cells.toFixed(cells < 10 ? 1 : 0)} cells across the radius${cells < 16 ? ' (below 16: lens results may be off by more than 1e-3; thin-walled lenses need ≥ 20 cells for about 1e-3, 40 for 2e-4, 80 for 1e-4; sharp corners converge more slowly)' : cells < 20 ? ' (use ≥ 20 for lens work; the Accuracy check measures the grid error)' : ''}.`;
            aperture.classList.toggle('io-warn-text', cells < 16);
        }
        const p = st.project;
        const xs = r.domain.x, ys = p.domain && Array.isArray(p.domain.y) && typeof p.domain.y[1] === 'number' && typeof p.domain.y[0] === 'number' ? p.domain.y : r.domain.y;
        const px = p.domain && Array.isArray(p.domain.x) && typeof p.domain.x[0] === 'number' && typeof p.domain.x[1] === 'number' ? p.domain.x : xs;
        const list = cellSuggestions(px, ys, D.h);
        clear(sugg);
        if (list.length) {
            sugg.appendChild(h('span', { class: 'io-item-sub', text: 'Cells that fit: ' }));
            for (const s of list) {
                const cur = Math.abs(s.cell - D.h) < 1e-12 * D.h;
                const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': cur ? 'true' : 'false', title: `${fmtCount(s.nx)} × ${fmtCount(s.ny)} = ${fmtCount(s.N)} nodes` }, `${formatPretty(s.cell, 'length', 4)} · ${fmtCount(s.N, true)}`);
                b.addEventListener('click', () => { const res = ctx.commit((d) => { d.domain.cell = s.cell; }, { label: 'Cell size' }); if (!res.ok && ctx.ui.toast) ctx.ui.toast(res.error, { kind: 'warn' }); });
                sugg.appendChild(b);
            }
        }
    }

    let hadCustom = null, customForm = null;
    function update() {
        const st = store.get();
        const p = st.project;
        if (document.activeElement !== typeSel) typeSel.value = p.domain ? p.domain.type : 'cyl2d';
        gridForm.sync(); mirrorForm.sync(); beyondForm.sync(); solverForm.sync(); tracerForm.sync();
        if (sigOfEdges(p.domain || {}) !== edgeSig) buildEdges(); else edgeEditors.forEach((e) => e.sync());
        syncStats();
        const tr = p.tracer || {};
        interpNote.textContent = tr.fieldInterp === 'linear'
            ? 'Linear: bilinear nodal field; can give smaller focal errors below 16 cells per aperture radius, but does not conserve energy as well.'
            : 'Cubic: smooth (C¹) potential whose exact gradient is the force, so energy is conserved to the integrator tolerance; best at 32 or more cells per aperture radius.';
        const hasCustom = tr.quality === 'custom' && !!tr.custom;
        if (hasCustom !== hadCustom) {
            hadCustom = hasCustom;
            clear(customBox);
            customForm = hasCustom ? bindForm(ctx, { kind: 'custom', label: 'Custom accuracy', idPrefix: 'io-cus', locate: (pp) => (pp.tracer && pp.tracer.custom ? { obj: pp.tracer.custom, path: 'tracer.custom' } : null) }) : null;
            if (customForm) customBox.append(h('h4', { class: 'io-group-title', text: 'Custom accuracy' }), customForm.el);
        } else if (customForm) customForm.sync();
    }
    buildEdges();
    update();
    const offs = ['project', 'resolved', 'solve'].map((evt) => store.on(evt, update));
    return { update, destroy: () => offs.forEach((f) => f()) };
}
