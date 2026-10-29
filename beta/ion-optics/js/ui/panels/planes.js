/* ==========================================================================
   Ion optics UI: panels/planes.js — the Planes tab (spec §4.7)
   Plane picker; detector image (y–z, cylindrical x planes) or u–u′ phase
   space with the 2σ rms ellipse; histograms of position, angle, kinetic
   energy and time; statistics with rms emittance and Twiss parameters
   (Lapostolle 1971; Courant & Snyder 1958); "Find waist" with a canvas
   marker; grouped spots and grouped blur (VMI image quality, §3.11(6));
   CSV of the plane's crossings (columns of §4.7).
   ========================================================================== */
import { C_STRIDE, C_PLANE, C_KIND } from '../../engine/layout.js';
import { groupedBlurMetric, classIndex, planeSample, rmsRadius } from '../../engine/optimize.js';
import { planeStats, sampleWeights } from '../analysis-jobs.js';
import { chartBlock, scatterPlot, heatmapPlot, barsPlot, statList, fmtNum, download, dataTable, displayHistogram } from '../plots.js';

export const meta = { id: 'planes', title: 'Planes', order: 30 };

/** Grouped spots per (source, species, direction class, energy class): [{ key, n, cu, cw, rms }] and the blur. */
export function groupedSpotsOf(result, resolved, k) {
    const smp = planeSample(result, resolved, k);
    const cls = classIndex(resolved);
    const groups = new Map();
    smp.ids.forEach((id, i) => {
        const c = cls.get(id) || [-1, -1];
        const key = `dir ${c[0]} · energy ${c[1]}`;
        let g = groups.get(key);
        if (!g) { g = { key, u: [], w: [] }; groups.set(key, g); }
        g.u.push(smp.u[i]); g.w.push(smp.w[i]);
    });
    const rows = [...groups.values()].map((g) => ({ key: g.key, n: g.u.length, cu: g.u.reduce((s, v) => s + v, 0) / g.u.length, cw: g.w.reduce((s, v) => s + v, 0) / g.w.length, rms: rmsRadius(g.u, g.w) }));
    return { rows, blur: groupedBlurMetric(result, resolved, k) };
}

export function mount(el, ctx) {
    const { h } = ctx.ui.dom;
    const pick = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Plane' });
    const csvBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'CSV' });
    const waistBtn = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Find waist' });
    const clearBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Clear marker', hidden: true });
    const bar = h('div', { class: 'io-btnrow' }, h('label', { class: 'io-inline' }, h('span', { text: 'Plane' }), pick), waistBtn, clearBtn, csvBtn);
    const waistOut = h('p', { class: 'io-note', role: 'status' });
    const empty = h('p', { class: 'io-empty' });
    const top = h('div', { class: 'io-plane-grid' });
    const statsBox = h('div', { class: 'io-plane-stats' });
    const hist = h('div', { class: 'io-plane-hists' });
    const groupsBox = h('div', { class: 'io-plane-groups' });
    el.appendChild(h('div', { class: 'io-results io-planes' }, bar, waistOut, empty, top, statsBox, hist, groupsBox));
    let blocks = [];
    let curPlane = 0;
    let waistFor = null;   // { res, plane } of the shown "Find waist" line and canvas marker
    /** Removes the waist line and marker when they belong to another run or plane (also while the tab is hidden). */
    function dropStaleWaist() {
        const { res } = ctxState();
        if (!waistFor || (waistFor.res === res && waistFor.plane === curPlane)) return;
        waistFor = null;
        waistOut.textContent = '';
        if (ctx.view && ctx.view.removeOverlay) ctx.view.removeOverlay('io-waist');
        clearBtn.hidden = true;
    }
    const offRun = ctx.store.on('run', dropStaleWaist);
    pick.addEventListener('change', () => { curPlane = +pick.value; render(); });

    function clearBlocks() { for (const b of blocks) b.destroy(); blocks = []; top.replaceChildren(); hist.replaceChildren(); statsBox.replaceChildren(); groupsBox.replaceChildren(); }
    function ctxState() {
        const st = ctx.store.get(), res = st.run && st.run.result;
        return { st, res, resolved: (res && res.resolvedSnapshot) || st.resolved };
    }
    function render() {
        clearBlocks();
        dropStaleWaist();
        const { res, resolved } = ctxState();
        const planes = (resolved && resolved.recording && resolved.recording.planes) || [];
        pick.replaceChildren(...planes.map((p, k) => h('option', { value: String(k), text: p.name || p.id })));
        bar.hidden = !planes.length;
        if (!planes.length) { empty.hidden = false; empty.textContent = 'This project has no test planes or detectors (Recording tab).'; return; }
        if (curPlane >= planes.length) curPlane = 0;
        pick.value = String(curPlane);
        if (!res) { empty.hidden = false; empty.textContent = 'No run yet.'; return; }
        const plane = planes[curPlane];
        const ps = planeStats(res, resolved, curPlane);
        if (!ps.n) { empty.hidden = false; empty.textContent = `No particle crossed ${plane.name || plane.id}.`; return; }
        empty.hidden = true;
        const smp = ps.sample, ax = smp.frame.axes;
        const cyl = resolved.domain.type === 'cyl2d';
        const uLab = `${ax[0]} (mm)`, wLab = `${ax[1]} (mm)`;
        // detector image or phase space
        if (cyl && plane.kind === 'x') {
            blocks.push(chartBlock(top, { title: 'Detector image', canvas: true, plot: heatmapPlot({ x: smp.u, y: smp.w, xLabel: uLab, yLabel: wLab, ariaLabel: `Detector image at ${plane.name || plane.id}` }),
                columns: ['id', ax[0] + '_mm', ax[1] + '_mm'], rows: smp.ids.map((id, i) => [id, smp.u[i], smp.w[i]]), csvName: 'detector-image' }));
        }
        const e = ps.emittance.u;
        const upm = smp.up.map((v) => 1000 * v);
        blocks.push(chartBlock(top, { title: `Phase space ${ax[0]}–${ax[0]}′`, canvas: true,
            plot: scatterPlot({ x: smp.u, y: upm, xLabel: uLab, yLabel: `${ax[0]}′ (mrad)`, ellipse: e && e.sxx > 0 ? { cx: e.mu, cy: e.mp, sxx: e.sxx, syy: e.spp, sxy: e.sxp, k: 2 } : null, ariaLabel: `Phase space at ${plane.name || plane.id}` }),
            columns: ['id', ax[0] + '_mm', ax[0] + "'_mrad"], rows: smp.ids.map((id, i) => [id, smp.u[i], upm[i]]), csvName: 'phase-space', note: 'Dashed: the 2σ rms ellipse.' }));
        // statistics
        statsBox.appendChild(statList([
            ['Crossings', ps.n], [`Centroid ${ax[0]}`, ps.centroid[0], 'mm'], [`Centroid ${ax[1]}`, ps.centroid[1], 'mm'],
            [`rms ${ax[0]}`, ps.rms[0], 'mm'], [`rms ${ax[1]}`, ps.rms[1], 'mm'], ['rms radius', ps.rmsRadius, 'mm'],
            [`ε rms (${ax[0]}, ${ax[0]}′)`, ps.emittance.u.epsRms, 'mm·mrad'], ['α', ps.emittance.u.alpha], ['β', ps.emittance.u.beta, 'mm/mrad'], ['γ', ps.emittance.u.gamma, 'mrad/mm'],
            [`ε rms (${ax[1]}, ${ax[1]}′)`, ps.emittance.w.epsRms, 'mm·mrad'],
            ['Mean KE', ps.ke.mean, 'eV'], ['KE spread (rms)', ps.ke.sd, 'eV'], ['Mean TOF', ps.tof.mean, 'µs'], ['TOF spread (rms)', ps.tof.sd, 'µs'],
        ]));
        // histograms (Σw per bin when the sources carry statistical weights other than 1)
        const wts = sampleWeights(res, resolved, smp.ids);
        const mk = (title, vals, xLabel, name) => {
            const hh = displayHistogram(vals, xLabel, { weights: wts });
            const t = wts ? `${title} (weighted)` : title;
            blocks.push(chartBlock(hist, { title: t, plot: barsPlot({ series: [{ label: t, edges: hh.edges, counts: hh.counts }], xLabel: hh.label }), height: 180,
                columns: ['bin_low', 'bin_high', wts ? 'weighted_count' : 'count'], rows: Array.from(hh.counts, (c, i) => [hh.edges[i] + hh.offset, hh.edges[i + 1] + hh.offset, c]), csvName: name }));
        };
        mk(`Position ${ax[0]}`, smp.u, uLab, 'position-histogram');
        mk(`Angle ${ax[0]}′`, upm, `${ax[0]}′ (mrad)`, 'angle-histogram');
        mk('Kinetic energy', smp.ke, 'KE (eV)', 'energy-histogram');
        mk('Time of flight', smp.tof, 't (µs)', 'time-histogram');
        // grouped spots (grid sources with direction or energy classes)
        const hasClasses = (resolved.sources || []).some((s) => s.sampling === 'grid' || s.type === 'rows');
        if (hasClasses) {
            const gs = groupedSpotsOf(res, resolved, curPlane);
            if (gs.rows.length > 1) {
                groupsBox.append(h('h3', { class: 'io-card-title', text: 'Grouped spots (image quality)' }),
                    h('p', { class: 'io-note', text: `Grouped blur √(mean group rms²) = ${fmtNum(gs.blur, 4)} mm over ${gs.rows.length} groups (direction and energy classes; spread over source positions).` }),
                    dataTable({ columns: ['Group', 'n', `${ax[0]} centroid (mm)`, `${ax[1]} centroid (mm)`, 'rms (mm)'], rows: gs.rows.map((g) => [g.key, g.n, g.cu, g.cw, g.rms]), caption: 'Grouped spots', maxRows: 500 }));
            }
        }
    }

    function waistMarker(pos, plane) {
        if (!ctx.view || !ctx.view.addOverlay) return;
        const vertical = plane.kind !== 'y';
        ctx.view.addOverlay('io-waist', (c, xf) => {
            c.save();
            c.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--warn').trim() || '#b45309';
            c.setLineDash([6, 4]); c.lineWidth = 1.5;
            c.beginPath();
            if (vertical) { const [sx] = xf.toScreen(pos, 0); c.moveTo(sx, 0); c.lineTo(sx, xf.H); } else { const [, sy] = xf.toScreen(0, pos); c.moveTo(0, sy); c.lineTo(xf.W, sy); }
            c.stroke();
            c.setLineDash([]);
            c.fillStyle = c.strokeStyle; c.font = '12px system-ui, sans-serif';
            if (vertical) { const [sx] = xf.toScreen(pos, 0); c.fillText(`waist ${fmtNum(pos, 4)} mm`, sx + 4, 14); }
            c.restore();
        });
        clearBtn.hidden = false;
    }
    waistBtn.addEventListener('click', () => {
        const { res, resolved } = ctxState();
        if (!res) return;
        const plane = resolved.recording.planes[curPlane];
        const ps = planeStats(res, resolved, curPlane);
        if (!ps.waist || !Number.isFinite(ps.waist.offset)) { waistOut.textContent = 'No waist: too few rays or parallel rays.'; waistFor = { res, plane: curPlane }; return; }
        const axial = plane.kind === 'x' || plane.kind === 'y' || plane.kind === 'z';
        const pos = axial ? (plane.at || 0) + ps.waist.offset : ps.waist.offset;
        waistOut.textContent = `Waist ${axial ? `at ${plane.kind} = ${fmtNum(pos, 6)} mm` : `${fmtNum(pos, 6)} mm beyond the plane`}; rms radius there ${fmtNum(ps.waist.rms, 4)} mm (${fmtNum(ps.waist.rmsAtPlane, 4)} mm at the plane). Rays are continued as straight lines, so the region must be field-free.`;
        if (axial && plane.kind !== 'z') waistMarker(pos, plane);
        waistFor = { res, plane: curPlane };
        if (ctx.ui.announce) ctx.ui.announce(waistOut.textContent);
    });
    clearBtn.addEventListener('click', () => { if (ctx.view && ctx.view.removeOverlay) ctx.view.removeOverlay('io-waist'); clearBtn.hidden = true; waistOut.textContent = ''; waistFor = null; });
    csvBtn.addEventListener('click', () => {
        const { res, resolved } = ctxState();
        if (!res) return;
        const C = res.crossings, keep = [];
        for (let c = 0; c < res.nCross; c++) { const b = c * C_STRIDE; if (C[b + C_KIND] === 0 && C[b + C_PLANE] === curPlane) keep.push(b); }
        const sub = new Float64Array(keep.length * C_STRIDE);
        keep.forEach((b, i) => sub.set(C.subarray(b, b + C_STRIDE), i * C_STRIDE));
        const plane = resolved.recording.planes[curPlane];
        download(ctx.engine.io.runToCSV({ n: 0, summary: new Float64Array(0), crossings: sub, nCross: keep.length }, 'crossings', resolved), `crossings-${ctx.ui.dom.fileStem(plane.id)}.csv`);
    });
    render();
    return {
        update(evt) { if (!evt || ['run', 'show', 'resolved'].includes(evt.type)) render(); },
        destroy() { offRun(); clearBlocks(); if (ctx.view && ctx.view.removeOverlay) ctx.view.removeOverlay('io-waist'); },
    };
}
