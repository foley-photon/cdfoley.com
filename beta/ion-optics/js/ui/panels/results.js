/* ==========================================================================
   Ion optics UI: panels/results.js — the Summary tab (spec §4.7)
   Cards: launched, status breakdown, transmission per detector, hits per
   electrode, mean TOF and rms spot per plane, waist, energy diagnostics,
   solver path and timings; warnings; "Copy Methods text"; "Accuracy check"
   (§3.11(2)) with its report.
   ========================================================================== */
import { runOverview, methodsText, accuracyCheck, statusList } from '../analysis-jobs.js';
import { beamWaist } from '../../engine/analysis.js';
import { fmtNum, dataTable, csvText, download } from '../plots.js';

export const meta = { id: 'summary', title: 'Summary', order: 10 };

/**
 * Identity of the project an accuracy check or Methods text was made for (pure, for tests): the preset, the creation
 * stamp and the run key, which covers geometry, voltages, waveforms, sources, recording and tracer settings. A report
 * whose identity differs from the current state belongs to another project or to an earlier state of this one, and is
 * cleared (the Methods text box silently, the accuracy report under a one-line note saying why).
 */
export function projectIdentity(state) {
    const m = (state && state.project && state.project.meta) || {}, k = (state && state.keys) || {};
    return [m.preset || '', m.created || '', k.runKey || ''].join('|');
}

/**
 * Why the energy diagnostics are off for a run whose summary has no end-energy errors (pure, for tests): the physics
 * plug-ins (energy is not conserved with drag, gas collisions or space charge), time-dependent fields, or particles
 * that ended outside the grid.
 */
export function energyUncheckedReason(resolved) {
    const tr = (resolved && resolved.tracer) || {};
    const plug = [tr.drag ? 'Stokes drag' : null, tr.gas && tr.gas.enabled !== false ? 'gas collisions' : null,
        tr.spaceCharge && tr.spaceCharge.enabled !== false ? 'space charge' : null].filter(Boolean);
    if (plug.length) return `Not checked: energy is not conserved with ${plug.length === 1 ? plug[0] : `${plug.slice(0, -1).join(', ')} and ${plug[plug.length - 1]}`} (a physics plug-in is on).`;
    const td = (resolved && resolved.channelCount > 0) || ((resolved && resolved.idealFields) || []).some((f) => f && f.V && f.freq > 0);
    if (td) return 'Not checked: the fields are time-dependent, so the kinetic plus potential energy changes along the flight.';
    return 'Not checked: the particles ended outside the grid (no potential to compare with there).';
}

/**
 * Sources whose start positions lie outside the solved domain (pure, for tests): explicit points (particle lists, point
 * and list positions) are counted; for lines, discs, rectangles and Gaussian clouds the center or an end point outside
 * is reported. Such particles leave the domain at once.
 * @returns {string[]} warning texts
 */
export function startsOutside(resolved) {
    const d = resolved && resolved.domain;
    if (!d || !Array.isArray(d.x) || !Array.isArray(d.y)) return [];
    const cyl = d.type === 'cyl2d', m = d.mirror || {}, am = d.antimirror || {};
    const x0 = m.x || am.x ? -d.x[1] : d.x[0], x1 = d.x[1];
    const y0 = cyl ? 0 : (m.y || am.y ? -d.y[1] : d.y[0]), y1 = d.y[1];
    const eps = 1e-9 * Math.max(1, Math.abs(x1 - x0), Math.abs(y1 - y0));
    const inside = (p) => {
        if (!Array.isArray(p)) return true;
        const x = +p[0], y = cyl ? Math.hypot(+p[1] || 0, +p[2] || 0) : +p[1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
        return x >= x0 - eps && x <= x1 + eps && y >= y0 - eps && y <= y1 + eps;
    };
    const out = [];
    for (const s of (resolved && resolved.sources) || []) {
        const name = s.name || s.id;
        let pts = null, region = false;
        if (s.type === 'rows' && Array.isArray(s.rows)) pts = s.rows.map((r) => [r[2], r[3], r[4]]);
        else if (s.position) {
            const q = s.position;
            if (q.type === 'point') pts = [q.p];
            else if (q.type === 'list') pts = q.points;
            else if (q.type === 'line') { pts = [q.p0, q.p1]; region = true; }
            else if (q.center) { pts = [q.center]; region = true; }
        }
        if (!Array.isArray(pts) || !pts.length) continue;
        const bad = pts.filter((p) => !inside(p)).length;
        if (!bad) continue;
        if (region) out.push(`Source "${name}": its start ${s.position.type === 'line' ? 'line reaches' : 'region is centered'} outside the domain, so particles that start there leave it at once.`);
        else out.push(`Source "${name}": ${bad === pts.length && bad > 1 ? 'all' : bad.toLocaleString('en-US')} of its ${pts.length.toLocaleString('en-US')} start position${pts.length === 1 ? '' : 's'} ${bad === 1 ? 'lies' : 'lie'} outside the domain (x ${fmtNum(x0)} to ${fmtNum(x1)} mm, ${cyl ? 'r' : 'y'} ${fmtNum(y0)} to ${fmtNum(y1)} mm); ${bad === 1 ? 'that particle leaves' : 'those particles leave'} it at once.`);
    }
    return out;
}

const STATUS_WORDS = { DETECTED: 'detected', HIT: 'hit an electrode', EXIT: 'left the domain', TMAX: 'reached the time limit', STEPS: 'reached the step limit', ABSORBED: 'absorbed by a mesh',
    DRIFT_END: 'drifted out', NUM_ERROR: 'numerical error', BORN_INSIDE: 'started inside an electrode', CANCELLED: 'cancelled', FLYING: 'still flying' };
const STATUS_BADGE = { DETECTED: 'badge-ok', HIT: '', EXIT: '', TMAX: '', ABSORBED: '', NUM_ERROR: 'badge-bad', BORN_INSIDE: 'badge-warn', CANCELLED: 'badge-warn', STEPS: 'badge-warn' };

export function mount(el, ctx) {
    const { h } = ctx.ui.dom;
    const root = h('div', { class: 'io-results io-summary' });
    const head = h('div', { class: 'io-results-head' });
    const cards = h('div', { class: 'io-cards', 'aria-live': 'off' });
    const warnBox = h('div', { class: 'io-warnings' });
    const btnMethods = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Copy Methods text' });
    const btnAcc = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Accuracy check' });
    const accBox = h('div', { class: 'io-accuracy' });
    const methodsBox = h('div', { class: 'io-methods-box' });
    const actions = h('div', { class: 'io-btnrow io-results-actions' }, btnMethods, btnAcc);
    root.append(head, cards, warnBox, actions, methodsBox, accBox);
    el.appendChild(root);
    let accRunning = false;
    // which project (and state of it) the shown accuracy report and Methods text belong to
    let accFor = null, methodsFor = null;
    const projectName = (st) => (st.project && st.project.meta && st.project.meta.name) || 'Untitled project';
    // a report or Methods text made for another project (or an earlier state of this one) is cleared, never shown under the wrong project
    function checkStale(st) {
        const id = projectIdentity(st);
        if (methodsFor && methodsFor !== id) { methodsBox.replaceChildren(); methodsFor = null; }
        if (accFor && accFor.key !== id && !accRunning) {
            accBox.replaceChildren(h('p', { class: 'io-note io-stale-note', text: `The accuracy check made for "${accFor.name}" was cleared because the project changed; run the check again for the current project.` }));
            accFor = null;
        }
    }

    const card = (title, ...body) => h('section', { class: 'io-card' }, h('h3', { class: 'io-card-title', text: title }), ...body);
    const line = (k, v) => h('div', { class: 'io-card-line' }, h('span', { class: 'io-card-k', text: k }), h('span', { class: 'io-card-v', text: v }));

    function render() {
        const st = ctx.store.get();
        const run = st.run || {}, res = run.result, resolved = (res && res.resolvedSnapshot) || st.resolved;
        head.replaceChildren();
        cards.replaceChildren();
        warnBox.replaceChildren();
        checkStale(st);
        if (!st.resolved) { head.appendChild(h('p', { class: 'io-empty', text: 'The project has errors; see the Log tab.' })); return; }
        if (!res) {
            head.appendChild(h('p', { class: 'io-empty', text: run.status === 'running' ? 'Running…' : 'No run yet. Solve the fields and run the particles (Run ▶).' }));
            renderSolver();
            return;
        }
        const ov = runOverview(res, resolved);
        const s = ov.summary;
        if (!s.launched) {
            head.appendChild(h('p', { class: 'io-empty', text: (resolved && resolved.particleCount === 0) ? 'This project has no particles; add a source in the Particles tab.' : 'The last run traced no particles.' }));
            renderSolver();
            return;
        }
        const tag = run.live ? 'Live preview' : run.partial || run.status === 'partial' ? 'Partial run (stopped)' : 'Run';
        // wall time of the run (measured by the job manager); the summed worker time is the CPU total
        const rs = res.stats || {};
        const wall = Number.isFinite(res.wallMs) ? res.wallMs : NaN;
        const nw = res.workers || rs.workers || 0;
        let timeText = '';
        if (Number.isFinite(wall)) timeText = ` · ${(wall / 1000).toFixed(2)} s${rs.ms && nw > 1 ? ` (${(rs.ms / 1000).toFixed(2)} s of computing on ${nw} workers)` : ''}`;
        else if (rs.ms) timeText = ` · ${(rs.ms / 1000).toFixed(2)} s of computing${nw ? ` on ${nw} worker${nw === 1 ? '' : 's'}` : ''}`;
        head.appendChild(h('p', { class: 'io-results-tag' }, h('span', { class: 'badge', text: tag }),
            h('span', { text: ` ${s.launched.toLocaleString('en-US')} particle${s.launched === 1 ? '' : 's'}${timeText}` })));
        if (res.partialNote) head.appendChild(h('p', { class: 'io-note', text: res.partialNote }));
        // launched + status
        const stBox = h('div', { class: 'io-badges' });
        for (const [name, c] of statusList(s)) stBox.appendChild(h('span', { class: `badge ${STATUS_BADGE[name] || ''}`, text: `${c.toLocaleString('en-US')} ${STATUS_WORDS[name] || name.toLowerCase()}` }));
        cards.appendChild(card('Particles', line('Launched', s.launched.toLocaleString('en-US')), stBox));
        // transmission
        const tr = card('Transmission');
        if (s.transmission.byPlane.length) for (const p of s.transmission.byPlane) tr.appendChild(line(p.name || p.id || `plane ${p.index}`, `${(100 * p.fraction).toFixed(p.fraction === 1 || p.fraction === 0 ? 0 : 1)}% (${p.detected.toLocaleString('en-US')})`));
        else tr.appendChild(h('p', { class: 'io-note', text: 'No detector (terminating plane) in this project.' }));
        // statistical source weights (Particles tab): the weighted transmission beside the counts
        const wsum = s.weighted;
        if (wsum && s.transmission.byPlane.length && wsum.bySource.some((b) => b.weight !== 1)) {
            const pct = (f) => `${(100 * f).toFixed(f === 1 || f === 0 ? 0 : 1)}%`;
            tr.appendChild(line('Weighted (source weights)', `${pct(wsum.transmission)} (Σw ${+wsum.detected.toPrecision(6)} of ${+wsum.launched.toPrecision(6)})`));
        }
        cards.appendChild(tr);
        // hits per electrode
        const he = s.byElectrode.filter((e) => e.hit + e.absorbed + e.bornInside > 0);
        if (he.length) {
            const c = card('Hits per electrode');
            for (const e of he) c.appendChild(line(e.name || e.id || `electrode ${e.index}`, `${e.hit} hit${e.absorbed ? `, ${e.absorbed} absorbed` : ''}${e.bornInside ? `, ${e.bornInside} born inside` : ''}`));
            cards.appendChild(c);
        }
        // planes: TOF and spot
        const pl = ov.planes.filter((p) => p.crossings > 0);
        if (pl.length) {
            const c = card('Planes');
            for (const p of pl) c.appendChild(line(p.name, `${p.crossings} crossing${p.crossings === 1 ? '' : 's'} · rms spot ${fmtNum(p.spotRms, 4)} mm · mean TOF ${fmtNum(p.meanTof, 5)} µs`));
            cards.appendChild(c);
        }
        // waist
        // one rule with the canvas label: only a waist on a field-free straight continuation, inside the domain or a drift region;
        // a beam dispersed into separate species spots has no single waist (the label omits it) but each species' image is listed
        const bw = beamWaist(res, resolved, st.field && st.field.model);
        const multi = bw && bw.groups && bw.groups.length > 1;
        if (bw && bw.ok) {
            const wc = card('Waist', h('p', { class: 'io-big', text: `Waist at ${bw.axis} ≈ ${fmtNum(bw.position, 4)} mm` }),
                line(multi ? 'rms radius there (within each species)' : 'rms radius there', `${fmtNum(bw.rms, 3)} mm`), line('from rays at', bw.name));
            if (multi && bw.spread > bw.rms) {
                for (const g of bw.groups) wc.appendChild(line(g.label, `${bw.axis} ≈ ${fmtNum(g.position, 4)} mm, rms ${fmtNum(g.rms, 3)} mm (${g.n} rays)`));
                wc.appendChild(h('p', { class: 'io-note', text: 'The position above is the particle-weighted mean of the species waists.' }));
            }
            cards.appendChild(wc);
        } else if (bw && bw.dispersed && multi) {
            const wc = card('Waist', h('p', { class: 'io-big', text: 'No single waist: the species land in separate spots' }), line('from rays at', bw.name));
            for (const g of bw.groups) wc.appendChild(line(g.label, `${bw.axis} ≈ ${fmtNum(g.position, 4)} mm, rms ${fmtNum(g.rms, 3)} mm (${g.n} rays)`));
            wc.appendChild(h('p', { class: 'io-note', text: 'The beam is dispersed by species, so the pooled rms size has no meaningful minimum; the positions above are the waist (image) of each species.' }));
            cards.appendChild(wc);
        }
        // energy
        const en = s.energy;
        const ec = card('Energy conservation');
        if (Number.isFinite(en.maxEnd)) {
            ec.append(line('max |ΔE| at the end', `${fmtNum(en.maxEnd, 3)} eV (${fmtNum(en.maxEndRel, 2)} of the energy scale)`), line('median |ΔE|', `${fmtNum(en.medianEnd, 3)} eV`), line('max work error', `${fmtNum(en.maxWork, 3)} eV`));
            if (en.warned) {
                const pl = (n) => `${n} particle${n === 1 ? '' : 's'}`;
                const band = en.warnedBand || 0, other = en.warned - band;
                const parts = [];
                if (band) parts.push(`${pl(band)} passed through cells cut by electrodes, where the field is only first-order accurate: use a smaller cell near those electrodes (a higher trajectory accuracy will not help)`);
                if (other) parts.push(`${pl(other)} ${other === 1 ? 'carries' : 'carry'} an integration error: use a higher trajectory accuracy`);
                ec.appendChild(h('p', { class: 'io-note io-warn-text', text: `${pl(en.warned)} exceeded the energy tolerance (10⁻⁶ of the energy scale). ${parts.join('; ')}.` }));
            }
            if (en.warnedHit) ec.appendChild(h('p', { class: 'io-note', text: `${en.warnedHit} particle${en.warnedHit === 1 ? '' : 's'} that ended on an electrode also exceeded it (not counted above).` }));
        } else ec.appendChild(h('p', { class: 'io-note', text: energyUncheckedReason(resolved) }));
        cards.appendChild(ec);
        renderSolver();
        // warnings
        const ws = [];
        const sol = st.solution;
        for (const w of (sol && sol.warnings) || []) ws.push(w.message || String(w));
        for (const w of (st.issues && st.issues.warnings) || []) ws.push(w.message || String(w));
        if (en.warned) ws.push('Energy diagnostics flagged some particles (see Energy conservation).');
        for (const w of startsOutside(resolved)) ws.push(w);
        if (res.stats && res.stats.crossDropped > 0) {
            const cap = Math.max(1, Math.min(1000, Math.floor(2e6 / Math.max(1, s.launched))));
            ws.push(`${res.stats.crossDropped.toLocaleString('en-US')} repeated plane or mesh crossings were not recorded: a run keeps at most ${cap.toLocaleString('en-US')} per particle and plane (2,000,000 rows in all).`);
        }
        if (ws.length) {
            warnBox.appendChild(h('h3', { class: 'io-card-title', text: 'Warnings' }));
            const ul = h('ul', { class: 'io-warn-list' });
            for (const w of [...new Set(ws)].slice(0, 30)) ul.appendChild(h('li', { text: w }));
            warnBox.appendChild(ul);
        }
    }
    function renderSolver() {
        const st = ctx.store.get();
        const stats = (st.solve && Array.isArray(st.solve.stats) && st.solve.stats) || [];
        if (!stats.length && !(st.solve && st.solve.ms)) return;
        const c = card('Fields');
        const els = (st.resolved && st.resolved.electrodes) || [];
        for (const s of stats) {
            const e = els[s.k];
            c.appendChild(line(e ? e.name || e.id : s.k < 0 ? 'Space charge (Poisson term)' : `basis ${s.k}`, `${(s.path || []).join(' → ')} · ${s.cycles || s.iterations || s.sweeps || 0} ${s.cycles ? 'cycles' : s.iterations ? 'iterations' : 'sweeps'} · est. error ${fmtNum(s.estErr, 2)} · ${Math.round(s.ms || 0)} ms${s.converged === false ? ' · NOT CONVERGED' : ''}`));
        }
        if (st.solve && st.solve.ms) c.appendChild(line('Solve time', `${(st.solve.ms / 1000).toFixed(2)} s`));
        if (st.resolved) c.appendChild(line('Grid', `${st.resolved.domain.nx} × ${st.resolved.domain.ny} = ${st.resolved.domain.N.toLocaleString('en-US')} nodes, cell ${st.resolved.domain.h} mm`));
        cards.appendChild(c);
    }

    btnMethods.addEventListener('click', async () => {
        const st = ctx.store.get();
        const text = methodsText(st);
        const ok = await ctx.ui.dom.copyText(text);
        if (ctx.ui.toast) ctx.ui.toast(ok ? 'Methods text copied.' : 'Copy failed; the text is shown below.', { kind: ok ? 'ok' : 'warn' });
        if (!ok) { const ta = h('textarea', { class: 'input io-methods', rows: 6, readonly: true, 'aria-label': 'Methods text' }); ta.value = text; methodsBox.replaceChildren(ta); methodsFor = projectIdentity(st); }
    });

    btnAcc.addEventListener('click', async () => {
        if (accRunning) return;
        accRunning = true;
        btnAcc.disabled = true;
        const st0 = ctx.store.get();
        // the report belongs to the project as it is now; an earlier report (for any project) is replaced
        accFor = { key: projectIdentity(st0), name: projectName(st0) };
        const status = h('p', { class: 'io-note', role: 'status', text: 'Accuracy check: starting…' });
        accBox.replaceChildren(status);
        try {
            const rep = await accuracyCheck(ctx, { onStep: (t) => { status.textContent = `Accuracy check: ${t}…`; } });
            renderAccuracy(rep);
            if (ctx.ui.announce) ctx.ui.announce('Accuracy check finished.');
        } catch (e) {
            accBox.replaceChildren(h('p', { class: 'io-note io-warn-text', text: `Accuracy check failed: ${e && e.message ? e.message : e}` }));
        } finally { accRunning = false; btnAcc.disabled = false; checkStale(ctx.store.get()); }
    });

    function renderAccuracy(rep) {
        const finer = rep.fineCell < rep.cell;
        const cols = ['Metric', 'Current', `Cell ${fmtNum(rep.fineCell, 4)} mm`, 'Δ grid', 'Observed order', 'Order used',
            'Est. grid error of current', ...(finer ? [`Est. grid error at ${fmtNum(rep.fineCell, 4)} mm`] : []), `Δ ${rep.tightLabel || 'rtol/100'}`];
        const rows = rep.rows.map((r) => [r.label + (r.unit ? ` (${r.unit})` : ''), r.value, r.fine, r.dGrid, r.order, r.p, r.errCurrent, ...(finer ? [r.errFine] : []), r.dTol]);
        const box = h('div', { class: 'io-accuracy-report' },
            h('h3', { class: 'io-card-title', text: `Accuracy check: ${accFor ? accFor.name : projectName(ctx.store.get())}` }),
            h('p', { class: 'io-note', text: `First ${rep.particles} particles re-run on a grid with cell ${fmtNum(rep.fineCell, 4)} mm (current ${fmtNum(rep.cell, 4)} mm${rep.coarseCell ? `; ${fmtNum(rep.coarseCell, 4)} mm for the observed order` : ''}) ${rep.tightening === 'steps' ? 'and with the lockstep steps shortened to 1/√10 (space charge)' : `and at rtol ${fmtNum(rep.rtol / 100, 2)}`}. Largest end-point shift: ${fmtNum(rep.endShift.grid, 3)} mm (grid), ${fmtNum(rep.endShift.rtol, 3)} mm (trajectory accuracy).` }),
            h('p', { class: 'io-note', text: 'Grid errors are Richardson estimates (signed; add them to the value): Δ·2^p/(2^p − 1) for the current cell and Δ/(2^p − 1) for the finer one, with p the observed order clamped to 1–2, or 1 when it could not be measured. Electrodes with sharp corners converge with p ≈ 4/3.' }),
            dataTable({ columns: cols, rows, caption: 'Per-metric differences' }));
        for (const n of rep.notes) box.appendChild(h('p', { class: 'io-note io-warn-text', text: n }));
        const csv = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'CSV' });
        csv.addEventListener('click', () => download(csvText(cols, rows), 'accuracy-check.csv'));
        box.appendChild(csv);
        accBox.replaceChildren(box);
    }

    render();
    return {
        update(evt) { if (!evt || ['show', 'run', 'solve', 'solution', 'resolved', 'project'].includes(evt.type)) render(); },
        destroy() { root.remove(); },
    };
}
