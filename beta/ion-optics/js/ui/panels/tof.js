/* ==========================================================================
   Ion optics UI: panels/tof.js — the TOF tab (spec §4.7, §3.11(5))
   Time-of-flight histogram per species at a plane, a peak table (mean, σ,
   resolving power from the rms width R = t̄/(2·2.3548σ) with its bootstrap
   range, from the narrowest 76.1% of the arrivals, and from the FWHM of
   interpolated half-maximum crossings, flagged when the peak is narrower
   than the histogram resolution) and the calibration t = a·√(m/q) + b
   (Wiley & McLaren, Rev. Sci. Instrum. 26, 1150 (1955)).
   ========================================================================== */
import { tofPeaks } from '../analysis-jobs.js';
import { chartBlock, barsPlot, dataTable, fmtNum, csvText, download, displayHistogram } from '../plots.js';

export const meta = { id: 'tof', title: 'TOF', order: 40 };

export function mount(el, ctx) {
    const { h } = ctx.ui.dom;
    const pick = h('select', { class: 'io-select io-select-sm', 'aria-label': 'Plane' });
    const empty = h('p', { class: 'io-empty' });
    const chartBox = h('div');
    const peaksBox = h('div', { class: 'io-tof-peaks' });
    const calBox = h('div', { class: 'io-tof-cal' });
    const bar = h('div', { class: 'io-btnrow' }, h('label', { class: 'io-inline' }, h('span', { text: 'Plane' }), pick));
    el.appendChild(h('div', { class: 'io-results io-tof' }, bar, empty, chartBox, peaksBox, calBox));
    let blocks = [], cur = -1;
    pick.addEventListener('change', () => { cur = +pick.value; render(); });

    function render() {
        for (const b of blocks) b.destroy();
        blocks = [];
        chartBox.replaceChildren(); peaksBox.replaceChildren(); calBox.replaceChildren();
        const st = ctx.store.get(), res = st.run && st.run.result, resolved = (res && res.resolvedSnapshot) || st.resolved;
        const planes = (resolved && resolved.recording && resolved.recording.planes) || [];
        pick.replaceChildren(...planes.map((p, k) => h('option', { value: String(k), text: `${p.name || p.id}${p.terminate ? ' (detector)' : ''}` })));
        bar.hidden = !planes.length;
        if (!planes.length) { empty.hidden = false; empty.textContent = 'Add a detector or test plane (Recording tab) to measure times of flight.'; return; }
        if (cur < 0 || cur >= planes.length) { const d = planes.findIndex((p) => p.terminate); cur = d >= 0 ? d : 0; }
        pick.value = String(cur);
        if (!res) { empty.hidden = false; empty.textContent = 'No run yet.'; return; }
        const t = tofPeaks(res, resolved, cur);
        if (!t.n) { empty.hidden = false; empty.textContent = 'No particle reached this plane.'; return; }
        empty.hidden = true;
        const series = t.hist.map((hh) => ({ label: hh.label, edges: hh.edges, counts: hh.counts }));
        const rows = [];
        for (const hh of t.hist) for (let i = 0; i < hh.counts.length; i++) rows.push([hh.label, hh.edges[i], hh.edges[i + 1], hh.counts[i]]);
        blocks.push(chartBlock(chartBox, { title: `Time of flight at ${planes[cur].name || planes[cur].id}`, plot: barsPlot({ series, xLabel: 't (µs)' }), columns: ['species', 'bin_low_us', 'bin_high_us', 'count'], rows, csvName: 'tof-histogram' }));
        // one zoomed chart per peak: mean ± 4σ (or ± 2·FWHM), with the half-maximum width marked
        const grid = h('div', { class: 'io-plane-hists' });
        chartBox.appendChild(grid);
        for (const p of t.peaks) {
            if (!(p.stats.n > 1)) continue;
            const half = Math.max(4 * p.stats.std, 2 * p.stats.fwhm) || Math.abs(p.stats.mean) * 1e-6 || 1e-9;
            const inside = p.t.filter((x) => Math.abs(x - p.stats.mean) <= half);
            const hh = displayHistogram(inside, 't (µs)', { minBins: 12, maxBins: 60, offsetBelow: 0.05 });
            const vl = Number.isFinite(p.stats.fwhm) ? [{ x: p.stats.tPeak - p.stats.fwhm / 2 - hh.offset, label: 'FWHM' }, { x: p.stats.tPeak + p.stats.fwhm / 2 - hh.offset }] : [];
            blocks.push(chartBlock(grid, { title: `${p.label}: R ≈ ${fmtNum(p.stats.resolvingPowerRms, 2)} (rms width)`, plot: barsPlot({ series: [{ label: p.label, edges: hh.edges, counts: hh.counts }], xLabel: hh.label, vlines: vl }), height: 170,
                columns: ['bin_low_us', 'bin_high_us', 'count'], rows: hh.counts.map((c, i) => [hh.edges[i] + hh.offset, hh.edges[i + 1] + hh.offset, c]), csvName: `tof-peak-${p.label}` }));
        }
        // R to two significant figures: with a few hundred ions the statistical spread is ±5-15%
        const r2 = (v) => (Number.isFinite(v) ? parseFloat(v.toPrecision(2)) : v);
        const range = (p) => (Number.isFinite(p.rRange[0]) ? `${fmtNum(r2(p.rRange[0]), 2)}–${fmtNum(r2(p.rRange[1]), 2)}` : '—');
        const cols = ['Species', 'n', 'Mean (µs)', 'σ (µs)', 'R (rms) = t̄/(2·2.3548σ)', 'R (rms), 68% range', 'R (narrowest 76%)', 'FWHM (µs)', 'R (FWHM)', 'Note'];
        const prow = t.peaks.map((p) => [p.label, p.stats.n, p.stats.mean, p.stats.std, r2(p.stats.resolvingPowerRms), range(p), r2(p.stats.resolvingPower76),
            p.stats.fwhm, p.stats.fwhmResolved ? r2(p.stats.resolvingPower) : `${fmtNum(r2(p.stats.resolvingPower), 2)} (not reliable)`, p.stats.note || '']);
        const csvRows = t.peaks.map((p) => [p.label, p.stats.n, p.stats.mean, p.stats.std, p.stats.resolvingPowerRms, p.rRange[0], p.rRange[1], p.stats.w76, p.stats.resolvingPower76,
            p.stats.fwhm, p.stats.resolvingPower, p.stats.fwhmResolved ? 'yes' : 'no', p.stats.note || '']);
        const csv = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'CSV' });
        csv.addEventListener('click', () => download(csvText(['species', 'n', 'mean_us', 'sigma_us', 'resolving_power_rms', 'r_rms_p16', 'r_rms_p84', 'w76_us', 'resolving_power_76',
            'fwhm_us', 'resolving_power_fwhm', 'fwhm_resolved', 'note'], csvRows), 'tof-peaks.csv'));
        const flagged = t.peaks.filter((p) => p.stats.n >= 30);
        const mixedFlags = flagged.some((p) => p.stats.fwhmResolved) && flagged.some((p) => !p.stats.fwhmResolved);
        peaksBox.append(h('h3', { class: 'io-card-title', text: 'Peaks' }), dataTable({ columns: cols, rows: prow, caption: 'Peak statistics' }), csv,
            h('p', { class: 'io-note', text: 'R (rms) uses the FWHM of a Gaussian with the same rms width; it is the robust value that Scan & tune optimizes. '
                + 'For peaks that are not Gaussian (a steep leading edge is common after a mirror) the three values differ, and the FWHM value depends on the number of ions. '
                + 'The FWHM of a sharply peaked (cusp-shaped) distribution is biased high by up to about a quarter, so its R (FWHM) reads low; compare R (rms) and R (narrowest 76%). '
                + 'The range is a 68% bootstrap interval from the finite number of ions.'
                + (mixedFlags ? ' The FWHM reliability mark differs between the species of this run: the mark is itself a statistical test on a few hundred ions, so treat the FWHM values of all species with the same caution.' : '') }));
        // separation of neighbouring peaks in units of their rms-based width (2.3548σ)
        const sorted = t.peaks.filter((p) => p.stats.n > 0).sort((a, b) => a.stats.mean - b.stats.mean);
        const seps = [];
        const W = 2 * Math.sqrt(2 * Math.LN2);
        for (let i = 1; i < sorted.length; i++) {
            const a = sorted[i - 1], b = sorted[i], w = W * Math.max(a.stats.std, b.stats.std);
            seps.push(`${a.label} → ${b.label}: Δt = ${fmtNum(b.stats.mean - a.stats.mean, 4)} µs = ${fmtNum((b.stats.mean - a.stats.mean) / w, 3)} × 2.3548σ`);
        }
        if (seps.length) peaksBox.appendChild(h('p', { class: 'io-note', text: seps.join(' · ') }));
        if (t.calibration && Number.isFinite(t.calibration.a)) {
            calBox.append(h('h3', { class: 'io-card-title', text: 'Calibration t = a·√(m/q) + b' }),
                h('p', { class: 'io-mono', text: `a = ${fmtNum(t.calibration.a, 7)} µs/√(u/e), b = ${fmtNum(t.calibration.b, 5)} µs, r² = ${fmtNum(t.calibration.r2, 8)} (${t.calibration.n} species)` }));
        } else calBox.appendChild(h('p', { class: 'io-note', text: 'The mass calibration needs two or more species at this plane.' }));
    }
    render();
    return {
        update(evt) { if (!evt || ['run', 'show', 'resolved'].includes(evt.type)) render(); },
        destroy() { for (const b of blocks) b.destroy(); },
    };
}
