/* ==========================================================================
   Ion optics UI: panels/lens.js — the Lens tab (spec §4.7, §3.11(3))
   Wizard (reference plane, D, field-free start and end, species, kinetic
   energy, ray heights) → F1, F2, f1, f2, H1, H2 in units of D and in mm with
   the signs of DiChio, Natali & Kuyatt (Rev. Sci. Instrum. 45, 559 (1974)),
   the Lagrange–Helmholtz identity, the T² coefficient, the F*(T) vs T² plot
   and canvas markers; an image finder (object → image, magnification);
   a warning below 20 cells per reference radius.
   ========================================================================== */
import { lensJob, imageJob, cellsPerRadius } from '../analysis-jobs.js';
import { LENS_HEIGHTS } from '../../engine/lensprops.js';
import { chartBlock, linePlot, dataTable, fmtNum, csvText, download } from '../plots.js';

export const meta = { id: 'lens', title: 'Lens', order: 50 };

/**
 * Default lens settings for a project (pure, for tests): the project's own analysis.lens (a preset's or the last computed one),
 * completed by a guess from the geometry; with an empty project argument only the guess.
 */
export function lensDefaults(project, resolved) {
    const guess = lensGuess(resolved);
    const own = project && project.analysis && project.analysis.lens;
    if (own && typeof own === 'object') {
        const out = { ...guess };
        for (const [k, v] of Object.entries(own)) if (v !== null && v !== undefined) out[k] = Array.isArray(v) ? v.slice() : v;
        return out;
    }
    return guess;
}

/**
 * Key of everything a lens computation depends on besides the geometry (pure, for tests): the field key (voltages,
 * waveforms, magnets, ideal fields), the field interpolation and the relativistic flag, the three tracer-side inputs of
 * the lens rays. A change makes shown results stale (dimmed, with a "voltages changed" note, markers removed).
 */
export function fieldStateKey(state) {
    const k = (state && state.keys) || {}, tr = (state && state.resolved && state.resolved.tracer) || {};
    return [k.fieldKey || '', tr.fieldInterp || 'cubic', tr.relativistic === false ? 'nonrel' : 'rel'].join('|');
}

/** x of the first enabled source's position (the image finder's object), or NaN. */
export function sourceX(resolved) {
    const src = resolved && resolved.sources && resolved.sources[0];
    const p = src && src.position;
    if (!p) return NaN;
    if (p.type === 'point' && Array.isArray(p.p)) return p.p[0];
    if (p.type === 'line' && Array.isArray(p.p0) && Array.isArray(p.p1)) return 0.5 * (p.p0[0] + p.p1[0]);
    if ((p.type === 'disc' || p.type === 'rect' || p.type === 'gaussian') && Array.isArray(p.center)) return p.center[0];
    if (p.type === 'list' && Array.isArray(p.points) && p.points.length) return p.points.reduce((s, q) => s + q[0], 0) / p.points.length;
    return NaN;
}

/** x range of the solved domain (with mirror.x the mirrored half too). */
export function domainXRange(resolved) {
    const d = resolved && resolved.domain;
    if (!d) return null;
    return [d.mirror && d.mirror.x ? -d.x[1] : d.x[0], d.x[1]];
}

/** Lens settings guessed from the geometry and the first source. */
export function lensGuess(resolved) {
    const d = resolved && resolved.domain;
    const h = d ? d.h : 1, x0 = d ? d.x[0] : -50, x1 = d ? d.x[1] : 50;
    // D from the smallest inner radius of the tubes, plates and boxes reaching to the axis region
    let rMin = Infinity;
    for (const s of (resolved && resolved.shapes) || []) {
        if (s.type === 'tube' && s.rIn > 0) rMin = Math.min(rMin, s.rIn);
        if (s.type === 'plate' && s.rHole > 0) rMin = Math.min(rMin, s.rHole);
    }
    const D = Number.isFinite(rMin) ? 2 * rMin : (d ? (d.y[1] - d.y[0]) / 2 : 10);
    const src = resolved && resolved.sources && resolved.sources[0];
    const sp = src && src.species && src.species[0];
    const en = src && src.energy;
    const ke = en ? (en.type === 'mono' ? en.ke : en.type === 'uniform' ? 0.5 * (en.min + en.max) : en.type === 'gaussian' ? en.mean : en.type === 'list' ? en.values[0] : 1000) : 1000;
    return { refX: x0 < 0 && x1 > 0 ? 0 : +(0.5 * (x0 + x1)).toPrecision(6), D, xStart: +(x0 + 2 * h).toPrecision(8), xEnd: +(x1 - 2 * h).toPrecision(8),
        mass: sp ? sp.mass : 100, charge: sp ? sp.charge : 1, keLeft: ke > 0 ? ke : 1000, heights: LENS_HEIGHTS.slice(), side: 'both' };
}

export function mount(el, ctx) {
    const { h } = ctx.ui.dom;
    const fields = [
        ['refX', 'Reference plane x', 'mm', 'length'], ['D', 'Reference diameter D', 'mm', 'length'], ['xStart', 'Left field-free x', 'mm', 'length'], ['xEnd', 'Right field-free x', 'mm', 'length'],
        ['mass', 'Mass', 'u', 'mass'], ['charge', 'Charge', 'e', 'charge'], ['keLeft', 'Kinetic energy (left)', 'eV', 'energy'],
    ];
    const inputs = new Map();
    const form = h('form', { class: 'io-lens-form', novalidate: true });
    for (const [key, label, unit] of fields) {
        const id = ctx.ui.dom.uid('io-lens');
        const inp = h('input', { id, class: 'input io-num', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false' });
        inputs.set(key, inp);
        form.appendChild(h('div', { class: 'io-lens-field' }, h('label', { for: id, text: label }), h('span', { class: 'io-input-unit' }, inp, h('span', { class: 'io-unit', text: unit }))));
    }
    const hId = ctx.ui.dom.uid('io-lens');
    const heightsIn = h('input', { id: hId, class: 'input', type: 'text', autocomplete: 'off' });
    form.appendChild(h('div', { class: 'io-lens-field io-lens-wide' }, h('label', { for: hId, text: 'Ray heights (× D)' }), heightsIn));
    const sideSel = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Rays' }, h('option', { value: 'both', text: 'Both directions' }), h('option', { value: 'right', text: 'Left to right only' }), h('option', { value: 'left', text: 'Right to left only' }));
    form.appendChild(h('div', { class: 'io-lens-field' }, h('label', { text: 'Rays' }), sideSel));
    const goBtn = h('button', { type: 'submit', class: 'btn btn-sm btn-primary', text: 'Compute lens properties' });
    const resetBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Defaults' });
    form.appendChild(h('div', { class: 'io-btnrow io-lens-wide' }, goBtn, resetBtn));
    const msg = h('div', { class: 'io-lens-msg', role: 'status' });
    const out = h('div', { class: 'io-lens-out' });
    const chartBox = h('div');
    // image finder
    const objIn = h('input', { class: 'input io-num', type: 'text', inputmode: 'decimal', 'aria-label': 'Object position x (mm)' });
    const angIn = h('input', { class: 'input', type: 'text', value: '-0.25, 0.25', 'aria-label': 'Ray angles (degrees)' });
    const imgBtn = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Find image' });
    const imgOut = h('p', { class: 'io-note', role: 'status' });
    const imgBox = h('section', { class: 'io-card io-lens-image' }, h('h3', { class: 'io-card-title', text: 'Image finder' }),
        h('div', { class: 'io-btnrow' }, h('label', { class: 'io-inline' }, h('span', { text: 'Object x (mm)' }), objIn), h('label', { class: 'io-inline' }, h('span', { text: 'Angles (°)' }), angIn), imgBtn), imgOut);
    el.appendChild(h('div', { class: 'io-results io-lens' }, h('p', { class: 'io-note', text: 'Rays parallel to the axis are traced through the lens from a field-free region on one side to one on the other; cardinal elements are extrapolated to T → 0 (DiChio, Natali & Kuyatt 1974). Lengths are in units of D from the reference plane, negative to the left.' }), form, msg, out, chartBox, imgBox));

    let blocks = [], running = false, last = null, lastImage = null, filledKey = null;
    // which project the form was filled for: a new preset, a new project or a geometry change refills it
    const projectKey = () => {
        const st = ctx.store.get(), m = (st.project && st.project.meta) || {};
        return [m.preset || '', m.created || '', (st.keys && st.keys.geomKey) || ''].join('|');
    };
    const STALE_TEXT = 'Voltages, fields or tracer settings changed since this computation; compute again.';
    // same geometry, other fields: keep the form and the numbers, but dim them, say so and take the markers off the canvas
    function markStale() {
        const fk = fieldStateKey(ctx.store.get());
        if (last && !last.stale && last.key !== fk) {
            last.stale = true;
            out.classList.add('io-dim'); chartBox.classList.add('io-dim');
            msg.replaceChildren(h('p', { class: 'io-note io-warn-text io-stale-note', text: STALE_TEXT }));
            if (ctx.view && ctx.view.removeOverlay) ctx.view.removeOverlay('io-lens');
        }
        if (lastImage && !lastImage.stale && lastImage.key !== fk) {
            lastImage.stale = true;
            imgOut.classList.add('io-dim');
            imgOut.textContent = `${STALE_TEXT} Last result: ${imgOut.textContent}`;
            if (ctx.view && ctx.view.removeOverlay) ctx.view.removeOverlay('io-image');
        }
    }
    const parseNum = (s, dim) => {
        if (ctx.ui.units && ctx.ui.units.parseQuantity) {
            try {
                const r = ctx.ui.units.parseQuantity(s, dim);
                if (r && Number.isFinite(r.value)) return r.value;
                if (r && r.kind === 'expr' && ctx.engine.expr && ctx.engine.expr.parseExpr) {
                    const st = ctx.store.get();
                    return ctx.engine.expr.parseExpr(r.expr).evaluate((st.resolved && st.resolved.paramValues) || {});
                }
            } catch (e) { /* fall through */ }
        }
        const v = Number(String(s).replace('−', '-'));
        return v;
    };
    function fill(spec, { object = false } = {}) {
        for (const [key] of fields) inputs.get(key).value = spec[key] === undefined || spec[key] === null ? '' : String(spec[key]);
        heightsIn.value = (spec.heights || LENS_HEIGHTS).join(', ');
        sideSel.value = spec.side || 'both';
        if (object || !objIn.value) {
            const sx = sourceX(ctx.store.get().resolved);
            objIn.value = String(Number.isFinite(sx) ? +sx.toPrecision(8) : spec.xStart);
        }
    }
    function readSpec() {
        const s = {}, bad = [];
        for (const [key, label, , dim] of fields) {
            const v = parseNum(inputs.get(key).value, dim);
            inputs.get(key).setAttribute('aria-invalid', Number.isFinite(v) ? 'false' : 'true');
            if (!Number.isFinite(v)) bad.push(label); else s[key] = v;
        }
        const hs = heightsIn.value.split(/[,\s;]+/).filter(Boolean).map(Number);
        if (hs.length < 2 || hs.some((v) => !(v > 0))) bad.push('Ray heights'); else s.heights = hs;
        s.side = sideSel.value;
        if (!(s.D > 0)) bad.push('D');
        if (!(s.xEnd > s.xStart)) bad.push('the end must lie to the right of the start');
        if (s.charge === 0) bad.push('Charge');
        if (bad.length) return { error: `Check: ${bad.join(', ')}.` };
        const xr = domainXRange(ctx.store.get().resolved);
        if (xr) {
            const out = [];
            if (!(s.xStart > xr[0] && s.xStart < xr[1])) out.push(`the left field-free x (${fmtNum(s.xStart)} mm)`);
            if (!(s.xEnd > xr[0] && s.xEnd < xr[1])) out.push(`the right field-free x (${fmtNum(s.xEnd)} mm)`);
            if (out.length) return { error: `${out.join(' and ')} must lie inside the domain (x from ${fmtNum(xr[0])} to ${fmtNum(xr[1])} mm).`.replace(/^t/, 'T') };
        }
        return { spec: s };
    }
    function clearResults() {
        last = null; lastImage = null;
        for (const b of blocks) b.destroy();
        blocks = [];
        out.replaceChildren(); chartBox.replaceChildren(); msg.replaceChildren(); imgOut.textContent = '';
        out.classList.remove('io-dim'); chartBox.classList.remove('io-dim'); imgOut.classList.remove('io-dim');
        if (ctx.view && ctx.view.removeOverlay) { ctx.view.removeOverlay('io-lens'); ctx.view.removeOverlay('io-image'); }
    }
    function defaults() { const st = ctx.store.get(); filledKey = projectKey(); fill(lensDefaults(st.project, st.resolved), { object: true }); }
    resetBtn.addEventListener('click', () => { const st = ctx.store.get(); fill(lensDefaults(st.project, st.resolved), { object: true }); });
    const guessBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Guess from geometry' });
    guessBtn.addEventListener('click', () => { const st = ctx.store.get(); fill(lensGuess(st.resolved), { object: true }); });
    resetBtn.after(guessBtn);

    function markers(lp) {
        if (!ctx.view || !ctx.view.addOverlay) return;
        const mm = lp.raw.mm, items = [['F1', mm.F1], ['H1', mm.H1], ['H2', mm.H2], ['F2', mm.F2]].filter(([, v]) => Number.isFinite(v));
        ctx.view.addOverlay('io-lens', (c, xf) => {
            const col = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1d4ed8';
            c.save(); c.strokeStyle = col; c.fillStyle = col; c.font = '12px system-ui, sans-serif'; c.lineWidth = 1.2;
            items.forEach(([name, x], i) => {
                const [sx, sy] = xf.toScreen(x, 0);
                c.setLineDash(name[0] === 'H' ? [3, 3] : []);
                c.beginPath(); c.moveTo(sx, sy - 40); c.lineTo(sx, sy + 40); c.stroke();
                c.fillText(name, sx + 3, sy - 44 + (i % 2) * 12);
            });
            c.setLineDash([]); c.restore();
        });
    }
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (running) return;
        const r = readSpec();
        if (r.error) { msg.replaceChildren(h('p', { class: 'io-note io-warn-text', text: r.error })); return; }
        const spec = r.spec;
        running = true; goBtn.disabled = true;
        msg.replaceChildren(h('p', { class: 'io-note', text: 'Tracing lens rays…' }));
        const key0 = fieldStateKey(ctx.store.get());   // the fields the rays are traced in
        try {
            const lp = await lensJob(ctx, spec);
            last = { lp, spec, key: key0, stale: false };
            show(lp, spec);
            ctx.store.update((p) => { p.analysis = { ...(p.analysis || {}), lens: { ...spec } }; }, { label: 'Lens settings', merge: 'lens' });
            markers(lp);
            markStale();   // the fields may have changed while the rays were traced
            if (ctx.ui.announce) ctx.ui.announce(`Lens: f2 = ${fmtNum(lp.f2, 5)} D, F2 = ${fmtNum(lp.F2, 5)} D.`);
        } catch (err) {
            msg.replaceChildren(h('p', { class: 'io-note io-warn-text', text: `The lens tool failed: ${err && err.message ? err.message : err}` }));
        } finally { running = false; goBtn.disabled = false; }
    });

    function show(lp, spec) {
        msg.replaceChildren();
        out.classList.remove('io-dim'); chartBox.classList.remove('io-dim');
        for (const w of lp.warnings) msg.appendChild(h('p', { class: 'io-note io-warn-text', text: w.message }));
        const D = spec.D, mm = lp.raw.mm;
        const rows = [['F1', lp.F1, mm.F1, lp.raw.fits.F1[1]], ['F2', lp.F2, mm.F2, lp.raw.fits.F2[1]], ['f1', lp.f1, mm.f1, lp.raw.fits.f1[1]], ['f2', lp.f2, mm.f2, lp.raw.fits.f2[1]], ['H1', lp.H1, mm.H1, lp.raw.fits.H1[1]], ['H2', lp.H2, mm.H2, lp.raw.fits.H2[1]]];
        const cols = ['Element', 'Units of D', 'mm', 'T² coefficient (D)'];
        const csv = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'CSV' });
        csv.addEventListener('click', () => download(csvText(['element', 'value_D', 'value_mm', 't2_coefficient_D'], rows), 'lens-properties.csv'));
        out.replaceChildren(
            dataTable({ columns: cols, rows, caption: `Cardinal elements (D = ${fmtNum(D)} mm, reference x = ${fmtNum(spec.refX)} mm)` }),
            h('p', { class: 'io-mono', text: `Lagrange–Helmholtz identity |f1/f2|·(p2/p1) − 1 = ${fmtNum(lp.identity, 3)}; kinetic energy on the right ${fmtNum(lp.raw.keRight, 6)} eV (V2/V1 = ${fmtNum(lp.raw.keRight / spec.keLeft, 6)}).` }),
            csv);
        const st = ctx.store.get();
        const cpr = st.resolved ? cellsPerRadius(D / 2, st.resolved.domain.h) : NaN;
        if (Number.isFinite(cpr)) out.appendChild(h('p', { class: `io-note${cpr < 20 ? ' io-warn-text' : ''}`, text: `${fmtNum(cpr, 3)} cells across D/2${cpr < 20 ? ': below 20 cells results may be off by more than 1e-3.' : '.'} Thin-walled lenses: 20 cells give about 1e-3, 40 about 2e-4, 80 about 1e-4; sharp electrode corners converge more slowly (the default Einzel lens at 40 cells: a few parts in 1000). The Accuracy check in the Summary tab measures your geometry.` }));
        for (const b of blocks) b.destroy();
        blocks = [];
        chartBox.replaceChildren();
        const u = lp.raw.T.map((t) => (t / D) ** 2);
        const uf = [0]; for (let i = 1; i <= 40; i++) uf.push(Math.max(...u) * i / 40);
        const fitCurve = (c) => uf.map((x) => c[0] + c[1] * x + c[2] * x * x);
        const trow = lp.raw.T.map((t, i) => [t, u[i], lp.raw.F2s[i], lp.raw.H2s[i], lp.raw.F1s[i], lp.raw.H1s[i]]);
        const rayCols = ['T_mm', '(T/D)^2', 'F2*/D', 'H2*/D', 'F1*/D', 'H1*/D'];
        const grid = h('div', { class: 'io-plane-hists' });
        chartBox.appendChild(grid);
        for (const [key, vals] of [['F2', lp.raw.F2s], ['F1', lp.raw.F1s]]) {
            if (!vals.length) continue;
            blocks.push(chartBlock(grid, { title: `${key}*(T) against T²`, plot: linePlot({ series: [{ label: `${key}* (rays)`, x: u, y: vals, type: 'points' }, { label: 'fit', x: uf, y: fitCurve(lp.raw.fits[key]), dash: true }], xLabel: '(T/D)²', yLabel: `${key}*/D` }),
                columns: rayCols, rows: trow, csvName: 'lens-rays', note: `The T → 0 intercept ${fmtNum(lp[key], 6)} D of the fit c₀ + c₂(T/D)² + c₄(T/D)⁴ is the paraxial value.` }));
        }
    }

    imgBtn.addEventListener('click', async () => {
        const r = readSpec();
        if (r.error) { imgOut.textContent = r.error; return; }
        const ox = parseNum(objIn.value, 'length');
        const angles = angIn.value.split(/[,\s;]+/).filter(Boolean).map(Number).filter((v) => Number.isFinite(v) && v !== 0);
        if (!Number.isFinite(ox) || !angles.length) { imgOut.textContent = 'Enter the object position and at least one non-zero angle.'; return; }
        imgBtn.disabled = true; imgOut.textContent = 'Tracing…'; imgOut.classList.remove('io-dim');
        const key0 = fieldStateKey(ctx.store.get());
        try {
            const im = await imageJob(ctx, { objectX: ox, mass: r.spec.mass, charge: r.spec.charge, ke: r.spec.keLeft, angles, xEnd: r.spec.xEnd });
            lastImage = { key: key0, stale: false };
            imgOut.textContent = Number.isFinite(im.imageX)
                ? `Image at x = ${fmtNum(im.imageX, 6)} mm (${fmtNum((im.imageX - r.spec.refX) / r.spec.D, 5)} D from the reference), magnification ${fmtNum(im.magnification, 4)}, rms ray height there ${fmtNum(im.rms, 3)} mm.${im.warnings.length ? ' ' + im.warnings.map((w) => w.message).join(' ') : ''}`
                : `No image found. ${im.warnings.map((w) => w.message).join(' ')}`;
            if (Number.isFinite(im.imageX) && ctx.view && ctx.view.addOverlay) {
                ctx.view.addOverlay('io-image', (c, xf) => {
                    const col = getComputedStyle(document.documentElement).getPropertyValue('--ok').trim() || '#047857';
                    c.save(); c.fillStyle = col; c.strokeStyle = col; c.font = '12px system-ui, sans-serif';
                    for (const [x, lab] of [[ox, 'object'], [im.imageX, 'image']]) { const [sx, sy] = xf.toScreen(x, 0); c.beginPath(); c.arc(sx, sy, 4, 0, 2 * Math.PI); c.fill(); c.fillText(lab, sx + 5, sy + 14); }
                    c.restore();
                });
            }
        } catch (err) { imgOut.textContent = `The image finder failed: ${err && err.message ? err.message : err}`; }
        finally { imgBtn.disabled = false; markStale(); }
    });

    defaults();
    // the canvas markers must not outlive their fields while the tab is hidden (the dock forwards events only to the shown tab)
    const offs = ['resolved', 'field'].map((e) => ctx.store.on(e, () => { if (running) return; if (projectKey() !== filledKey) { if (last || lastImage) clearResults(); } else markStale(); }));
    return {
        update(evt) {
            if (!evt) return;
            if (evt.type === 'project' || evt.type === 'resolved' || evt.type === 'show' || evt.type === 'field') {
                if (projectKey() !== filledKey && !running) { clearResults(); defaults(); } else markStale();
            }
        },
        destroy() { offs.forEach((f) => f()); for (const b of blocks) b.destroy(); if (ctx.view && ctx.view.removeOverlay) { ctx.view.removeOverlay('io-lens'); ctx.view.removeOverlay('io-image'); } },
    };
}
