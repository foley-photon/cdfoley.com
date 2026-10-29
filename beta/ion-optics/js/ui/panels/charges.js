/* ==========================================================================
   Ion optics UI: panels/charges.js — the "Charges & multipoles" tab
   Three tools on the solved fields (engine/fieldanalysis.js):
   1. Charge on every electrode by Gauss's law on a discrete contour around
      it, the capacitance matrix from the 1 V basis solutions, and the
      potential of a floating (isolated) conductor from C·V = Q, which can be
      written back as the electrode's voltage.
   2. Induced charge and current on an electrode along the recorded
      trajectories (Shockley–Ramo theorem; the basis solution is the
      weighting potential), with time plots and the amplitude spectrum of
      the total current from uniformly spaced time markers.
   3. Multipole coefficients of the potential on a circle (planar, Fourier
      series) or a sphere (cylindrical, Legendre series).
   Every table has a CSV export; nothing here writes to the console.
   ========================================================================== */
import * as FA from '../../engine/fieldanalysis.js';
import { E_CHARGE } from '../../engine/constants.js';
import { chartBlock, linePlot, dataTable, fmtNum, csvText, download } from '../plots.js';

export const meta = { id: 'charges', title: 'Charges & multipoles', order: 65 };

/**
 * Electrode potentials at the display time from a built field (pure, for tests): channel 0 holds the DC voltages,
 * the others the waveform amplitudes with their time functions.
 * @param {{ channels?: Array<{ cut: ArrayLike<number>, fn: { value(t: number): number } | null }>, displayTime?: number }} fld
 * @param {number} nE
 * @returns {Float64Array}
 */
export function electrodeVoltages(fld, nE) {
    const V = new Float64Array(nE);
    const ch = (fld && fld.channels) || [];
    const t = fld && typeof fld.displayTime === 'number' ? fld.displayTime : 0;
    for (let c = 0; c < ch.length; c++) {
        const cut = ch[c].cut;
        if (!cut) continue;
        const w = c === 0 || !ch[c].fn ? 1 : ch[c].fn.value(t);
        if (w === 0) continue;
        for (let e = 0; e < nE && e < cut.length; e++) V[e] += w * (+cut[e] || 0);
    }
    return V;
}

/** Default multipole settings for a resolved domain (pure, for tests): center on the mirror or anti-mirror planes or the domain center. */
export function multipoleDefaults(resolved) {
    const d = resolved.domain, cyl = d.type === 'cyl2d';
    const am = d.antimirror || {};
    const mx = !!((d.mirror && d.mirror.x) || am.x), my = !cyl && !!((d.mirror && d.mirror.y) || am.y);
    const cx = mx ? 0 : 0.5 * (d.x[0] + d.x[1]);
    const cy = cyl ? 0 : (my ? 0 : 0.5 * (d.y[0] + d.y[1]));
    const half = Math.min(mx ? d.x[1] : 0.5 * (d.x[1] - d.x[0]), cyl ? d.y[1] : (my ? d.y[1] : 0.5 * (d.y[1] - d.y[0])));
    const R = +Math.max(d.h, 0.25 * half).toPrecision(3);
    return { cx: +cx.toPrecision(6), cy: +cy.toPrecision(6), R, r0: R, nMax: 12, samples: cyl ? 64 : 360 };
}

/**
 * Anti-mirror planes of a resolved domain that the field-analysis tools must account for: { x, y } (a mirror plane on
 * the same axis wins, as in the field model).
 */
export function antimirrorPlanes(resolved) {
    const d = (resolved && resolved.domain) || {}, am = d.antimirror || {}, m = d.mirror || {};
    return { x: !!am.x && !m.x, y: d.type !== 'cyl2d' && !!am.y && !m.y };
}

/**
 * Potential sampler folded across anti-mirror planes (pure): φ(−x, y) = −φ(x, y) for an anti-mirror plane x = 0, and
 * likewise for y. Used when the engine's evaluator returns NaN on the image half.
 * @param {(x: number, y: number) => number} phiAt
 * @param {{ x: boolean, y: boolean }} am
 */
export function foldAntimirror(phiAt, am) {
    if (!am.x && !am.y) return phiAt;
    return (x, y, ...rest) => {
        let sgn = 1;
        if (am.x && x < 0) { x = -x; sgn = -sgn; }
        if (am.y && y < 0) { y = -y; sgn = -sgn; }
        return sgn * phiAt(x, y, ...rest);
    };
}

/**
 * Highest drive frequency (MHz) of a resolved project: cosine terms and pulse or table periods of the electrode
 * waveforms, and RF ideal fields. 0 for static fields.
 */
export function driveFrequencyMax(resolved) {
    let f = 0;
    for (const e of (resolved && resolved.electrodes) || []) {
        for (const t of e.terms || (e.wave && e.wave.terms) || []) {
            if (!t) continue;
            if (t.type === 'cos' && t.freq > f && t.amp !== 0) f = t.freq;
            else if ((t.type === 'pulse' || t.type === 'table') && t.period > 0 && 1 / t.period > f) f = 1 / t.period;
        }
    }
    for (const g of (resolved && resolved.idealFields) || []) {
        if ((g.type === 'quadrupole2d' || g.type === 'quadrupole3d') && g.V && g.freq > f) f = g.freq;
    }
    return f;
}

/** Significant digits that show a value to a resolution `res` (at least 2). */
export function digitsFor(value, res) {
    const a = Math.abs(value);
    if (!(a > 0) || !(res > 0)) return 4;
    return Math.max(2, Math.min(10, Math.floor(Math.log10(a)) - Math.floor(Math.log10(res)) + 1));
}

/** Human-readable multipole name. */
export function multipoleName(n, cyl) {
    const names = cyl ? ['monopole', 'dipole', 'quadrupole', 'hexapole', 'octupole', 'decapole', 'dodecapole'] : ['monopole', 'dipole', 'quadrupole', 'hexapole', 'octupole', 'decapole', 'dodecapole'];
    return n < names.length ? names[n] : `${2 * n}-pole`;
}

const parseNum = (s) => Number(String(s).trim().replace('−', '-'));

export function mount(el, ctx) {
    const { h } = ctx.ui.dom;
    const fileStem = (name) => (ctx.ui.dom.fileStem ? ctx.ui.dom.fileStem(name) : 'project');
    const root = h('div', { class: 'io-results io-chg' });
    el.appendChild(root);

    // ---------------------------------------------------------------- shared state and helpers
    let part = null, partKey = null;       // charge partition by geomKey
    let cm = null, cmKey = null;           // capacitance matrix by geomKey
    let wf = null, wfKey = null;           // weighting-potential evaluator by geomKey + electrode
    let charts = [];
    let ramoKeys = null;                   // stateKeys() of the shown induced signals
    let timer = null;
    const clearCharts = () => { for (const b of charts) b.destroy(); charts = []; ramoKeys = null; rCharts.classList.remove('io-dim'); };
    const nameOf = (resolved, e) => { const x = resolved && resolved.electrodes && resolved.electrodes[e]; return x ? (x.name || x.id || `electrode ${e}`) : `electrode ${e}`; };
    const chargeUnit = (cyl) => (cyl ? 'pC' : 'pC/m');
    const capUnit = (cyl) => (cyl ? 'pF' : 'pF/m');
    const setNote = (node, text, warn = false) => { node.textContent = text; node.classList.toggle('io-warn-text', !!warn); };

    /** Keys of the state a result was computed for: geometry, fields (voltages, waveforms), display time, last run. */
    const stateKeys = () => {
        const st = ctx.store.get(), k = st.keys || {};
        const res = st.run && st.run.result;
        return { geom: k.geomKey || '', field: `${k.fieldKey || ''}|${(st.project && st.project.view && st.project.view.displayTime) || 0}`, run: res ? `${st.run.runKey || ''}|${res.runId || ''}|${res.epoch || ''}|${res.n}` : '' };
    };
    /**
     * Anti-mirror models: the 1 V basis of an electrode is an odd-mode solution (its image across the plane at −1 V), so it
     * is neither a column of the capacitance matrix nor a weighting potential. Refused unless the engine folds them
     * (fieldanalysis.ANTIMIRROR_FOLDING).
     */
    function antimirrorRefusal(resolved, what) {
        const am = antimirrorPlanes(resolved);
        if ((!am.x && !am.y) || FA.ANTIMIRROR_FOLDING === true) return null;
        const pl = am.x && am.y ? 'x = 0 and y = 0' : am.x ? 'x = 0' : 'y = 0';
        return `${what} are not available for a model with an anti-mirror plane (${pl}): there the 1 V solution of an electrode has its mirror image at −1 V (the odd mode), so it is neither a capacitance column nor a weighting potential. Model the full domain (or use a mirror plane if the voltages are symmetric) for these tools; the multipole expansion below works on anti-mirror models.`;
    }
    /** The solution, the built field and the resolved project, or null with a message in `note`. */
    async function fieldState(note) {
        const st = ctx.store.get();
        if (!st.resolved) { setNote(note, 'The project has errors; see the Log tab.'); return null; }
        if (st.resolved.electrodes.length <= 1) { setNote(note, 'This project has no electrode besides ground, so there is nothing to compute.'); return null; }
        let fld = null;
        try { fld = await ctx.jobs.ensureField(); } catch (e) { setNote(note, `No field yet: ${e && e.message ? e.message : e}`); return null; }
        const st2 = ctx.store.get();
        const sol = st2.solution;
        if (!fld || !sol || !sol.raster0 || !sol.bases || sol.bases.size === 0) { setNote(note, 'Solve the fields first.'); return null; }
        if (sol.geomKey !== st2.keys.geomKey) { setNote(note, 'The geometry changed; solve the fields again.'); return null; }
        return { st: st2, resolved: st2.resolved, sol, fld };
    }
    function partitionFor(sol) {
        if (part && partKey === sol.geomKey) return part;
        part = FA.chargePartition(sol.raster0); partKey = sol.geomKey;
        cm = null; cmKey = null;
        return part;
    }
    function matrixFor(sol) {
        const p = partitionFor(sol);
        if (cm && cmKey === sol.geomKey) return cm;
        cm = FA.capacitanceMatrix(p, sol.bases); cmKey = sol.geomKey;
        return cm;
    }
    function electrodeOptions(select, resolved, sol, keep) {
        const prev = keep && select.value !== '' ? select.value : null;
        select.replaceChildren();
        for (let e = 1; e < resolved.electrodes.length; e++) {
            if (sol && !sol.bases.has(e)) continue;
            select.appendChild(h('option', { value: String(e), text: nameOf(resolved, e) }));
        }
        if (prev !== null && [...select.options].some((o) => o.value === prev)) select.value = prev;
    }

    // ================================================================ 1. charges and capacitance
    const cNote = h('p', { class: 'io-note', role: 'status' });
    const cTables = h('div', { class: 'io-chg-tables' });
    const cBtn = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Compute charges' });
    const cCsvQ = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'CSV charges', disabled: true });
    const cCsvC = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'CSV capacitance matrix', disabled: true });
    const fSel = h('select', { class: 'input io-chg-select', 'aria-label': 'Floating electrode' });
    const fCharge = h('input', { class: 'input io-num io-num-sm', type: 'text', inputmode: 'decimal', value: '0', 'aria-label': 'Charge of the floating electrode' });
    const fUnit = h('span', { class: 'io-chg-unit', text: 'pC' });
    const fBtn = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Floating potential' });
    const fApply = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Apply as voltage', disabled: true });
    const fNote = h('p', { class: 'io-note', role: 'status' });
    let lastCharges = null, lastFloat = null;
    root.appendChild(h('section', { class: 'io-card io-chg-card' },
        h('h3', { class: 'io-card-title', text: 'Charge and capacitance' }),
        h('p', { class: 'io-note', text: 'Gauss\'s law on a discrete contour around each electrode, midway to its neighbors (planar models: per meter of depth; mirror images included). The capacitance matrix C comes from the 1 V basis solutions: C_ij is the charge on electrode i when electrode j is at 1 V and all others at 0 V, so Q = C·V. The ground column follows from charge neutrality.' }),
        h('div', { class: 'io-btnrow' }, cBtn, cCsvQ, cCsvC),
        cNote, cTables,
        h('div', { class: 'io-chg-float' },
            h('h4', { class: 'io-chg-sub', text: 'Floating conductor' }),
            h('p', { class: 'io-note', text: 'An isolated electrode takes the potential at which its total charge equals the given value (0 for an uncharged conductor), with every other electrode at its present voltage: the row of C·V = Q for that electrode.' }),
            h('div', { class: 'io-btnrow' }, h('label', { class: 'io-inline' }, h('span', { text: 'Electrode' }), fSel), h('label', { class: 'io-inline' }, h('span', { text: 'Charge' }), fCharge, fUnit), fBtn, fApply),
            fNote)));

    async function computeCharges() {
        cCsvQ.disabled = true; cCsvC.disabled = true; fApply.disabled = true;
        cTables.replaceChildren();
        lastCharges = null; lastFloat = null;
        fNote.textContent = '';
        const fs = await fieldState(cNote);
        if (!fs) return;
        const { resolved, sol, fld } = fs;
        const keys = stateKeys();
        const refuse = antimirrorRefusal(resolved, 'Charges, the capacitance matrix and floating potentials');
        if (refuse) { setNote(cNote, refuse, true); return; }
        const cyl = resolved.domain.type === 'cyl2d';
        let matrix;
        try { matrix = matrixFor(sol); } catch (e) { setNote(cNote, `The charges could not be computed: ${e && e.message ? e.message : e}`, true); return; }
        const p = part;
        const nE = matrix.n;
        const volts = electrodeVoltages(fld, nE);
        // a charge density (domain.charge) induces charge on the electrodes too: Q = C·V + Q_ρ (Q_ρ with every electrode at 0 V)
        const hasRho = sol.bases.has(-1);
        let qRho = null, rhoErr = null;
        if (hasRho && typeof FA.spaceChargeCharges === 'function') {
            try { const r = FA.spaceChargeCharges(p, sol, resolved); qRho = r && r.charge ? r.charge : r; } catch (e) { rhoErr = e && e.message ? e.message : String(e); }
        }
        const fp = FA.floatingPotentials(matrix, volts, []);
        const Q = Float64Array.from(fp.charges);
        if (qRho) for (let e = 0; e < nE; e++) Q[e] += +qRho[e] || 0;
        const t = fld.displayTime || 0;
        const timeDep = fld.channels && fld.channels.length > 1;
        // charge table
        const qScale = 1e12;
        const qCols = qRho ? ['Electrode', 'Potential (V)', `Charge (${chargeUnit(cyl)})`, `of which from ρ (${chargeUnit(cyl)})`, 'Note'] : ['Electrode', 'Potential (V)', `Charge (${chargeUnit(cyl)})`, 'Note'];
        const qRows = [];
        let total = 0;
        for (let e = 0; e < nE; e++) {
            const noteE = p.regionNodes[e] > 0 ? '' : 'no surface in the domain';
            qRows.push(qRho ? [nameOf(resolved, e), volts[e], Q[e] * qScale, (+qRho[e] || 0) * qScale, noteE] : [nameOf(resolved, e), volts[e], Q[e] * qScale, noteE]);
            total += Q[e];
        }
        const mCols = [`C (${capUnit(cyl)})`, ...Array.from({ length: nE }, (_, j) => nameOf(resolved, j))];
        const mRows = [];
        for (let i = 0; i < nE; i++) mRows.push([nameOf(resolved, i), ...Array.from({ length: nE }, (_, j) => matrix.C[i * nE + j] * 1e12)]);
        cTables.append(
            h('div', { class: 'io-chg-table' }, dataTable({ columns: qCols, rows: qRows, caption: `Charge per electrode${timeDep ? ` at t = ${fmtNum(t)} µs` : ''}` })),
            h('div', { class: 'io-chg-table' }, dataTable({ columns: mCols, rows: mRows, caption: `Capacitance matrix (${capUnit(cyl)}); ground column from Σ_j C_ij = 0` })));
        // Σ Q = 0 holds by construction of the discrete contours (every face adds to one electrode what it takes from
        // another), so it is no check; the reciprocity error (the measured ground row against the derived column included) is
        const parts = [`Reciprocity: max |C_ij − C_ji| is ${fmtNum(matrix.asymmetry, 2)} of max |C| (the exact matrix is symmetric; this measures the discretization error).`];
        let warn = false;
        if (qRho) parts.push(`The charge density (domain.charge) induces ${fmtNum(total * qScale, 4)} ${chargeUnit(cyl)} in all on the electrodes, balancing the enclosed space charge; it is included in the charges and in the floating potentials.`);
        else if (hasRho) { parts.push(`This domain has a charge density (domain.charge): the charges above are C·V only and leave out the charge it induces on the electrodes${rhoErr ? ` (${rhoErr})` : ''}, and floating potentials ignore it.`); warn = true; }
        if (p.faces.irregular > 0) { parts.push(`${p.faces.irregular} of ${p.faces.count} contour faces lie in cells cut by an electrode (electrodes closer than two cells): the charge there is only first-order accurate; use a smaller cell.`); warn = true; }
        if (p.unlabeled > 0) parts.push(`${p.unlabeled} free nodes are not connected to any electrode.`);
        if (matrix.missing.length > 1) { parts.push('Several electrodes have no basis field; their columns are missing.'); warn = true; }
        setNote(cNote, parts.join(' '), warn);
        lastCharges = { qCols, qRows, mCols, mRows, matrix, volts, resolved, cyl, qRho, keys };
        cCsvQ.disabled = false; cCsvC.disabled = false;
        electrodeOptions(fSel, resolved, sol, true);
        fUnit.textContent = chargeUnit(cyl);
    }
    cBtn.addEventListener('click', () => computeCharges());
    cCsvQ.addEventListener('click', () => {
        if (!lastCharges) return;
        const u = lastCharges.cyl ? 'pC' : 'pC_per_m';
        const cols = lastCharges.qRho ? ['electrode', 'potential_V', `charge_${u}`, `charge_from_rho_${u}`, 'note'] : ['electrode', 'potential_V', `charge_${u}`, 'note'];
        download(csvText(cols, lastCharges.qRows), `${fileStem((ctx.store.get().project.meta || {}).name)}-charges.csv`);
    });
    cCsvC.addEventListener('click', () => { if (lastCharges) download(csvText(lastCharges.mCols.map((c, i) => (i === 0 ? (lastCharges.cyl ? 'C_pF' : 'C_pF_per_m') : c)), lastCharges.mRows), `${fileStem((ctx.store.get().project.meta || {}).name)}-capacitance.csv`); });
    fBtn.addEventListener('click', async () => {
        fApply.disabled = true; lastFloat = null;
        if (!lastCharges) await computeCharges();
        if (!lastCharges) { setNote(fNote, 'Compute the charges first.'); return; }
        const e = Number(fSel.value);
        if (!(e >= 1)) { setNote(fNote, 'Choose an electrode to float.'); return; }
        const q = parseNum(fCharge.value);
        if (!Number.isFinite(q)) { setNote(fNote, `Enter the charge in ${chargeUnit(lastCharges.cyl)}.`, true); return; }
        // with a charge density the electrode's share Q_ρ is not part of C·V: solve C·V = Q − Q_ρ for it
        const qr = lastCharges.qRho ? (+lastCharges.qRho[e] || 0) : 0;
        const fp = FA.floatingPotentials(lastCharges.matrix, lastCharges.volts, [{ index: e, charge: q * 1e-12 - qr }]);
        if (!fp.ok) { setNote(fNote, 'The capacitance matrix is singular for this electrode (no surface in the domain?).', true); return; }
        const v = fp.volts[e];
        lastFloat = { e, v, id: lastCharges.resolved.electrodes[e].id, name: nameOf(lastCharges.resolved, e) };
        const g0 = fp.charges[0] + (lastCharges.qRho ? (+lastCharges.qRho[0] || 0) : 0);
        setNote(fNote, `${nameOf(lastCharges.resolved, e)} floating with ${fmtNum(q, 4)} ${chargeUnit(lastCharges.cyl)}: potential ${fmtNum(v, 7)} V (now ${fmtNum(lastCharges.volts[e], 6)} V). The other electrodes keep their present voltages; the charge on ground is then ${fmtNum(g0 * 1e12, 4)} ${chargeUnit(lastCharges.cyl)}.${lastCharges.qRho ? ' The charge induced by the charge density is included.' : ''}`);
        fApply.disabled = false;
    });
    fApply.addEventListener('click', async () => {
        if (!lastFloat) return;
        const { id, v, name } = lastFloat;
        const cur = (ctx.store.get().project.electrodes || []).find((q) => q.id === id);
        if (!cur) return;
        const was = cur.v;
        // a voltage given as an expression (a parameter, a slider) is replaced by a number only after asking
        if (typeof was === 'string' && ctx.ui.openDialog) {
            const ok = await ctx.ui.openDialog({ title: 'Replace the voltage expression?', body: `The voltage of ${name} is the expression "${was}". Applying the floating potential replaces it by the number ${fmtNum(v, 6)} V, so the parameters no longer drive this electrode (Undo restores the expression).`,
                actions: [{ label: 'Cancel', value: false }, { label: 'Replace', value: true, primary: true }] });
            if (ok !== true) return;
        }
        ctx.store.update((d) => { const x = d.electrodes.find((q) => q.id === id); if (x) x.v = +v.toPrecision(10); }, { label: 'Set floating potential' });
        if (ctx.ui.toast) ctx.ui.toast(typeof was === 'string' ? `${name} was ${was}; now ${fmtNum(v, 6)} V (undo to restore).` : `${name} set to ${fmtNum(v, 6)} V.`, { kind: 'ok' });
        fApply.disabled = true;
    });

    // ================================================================ 2. Shockley–Ramo
    const rSel = h('select', { class: 'input io-chg-select', 'aria-label': 'Electrode for the induced charge' });
    const rSrc = h('select', { class: 'input io-chg-select', 'aria-label': 'Sampling of the trajectories' },
        h('option', { value: 'auto', text: 'Time markers if present, else trajectory points' }), h('option', { value: 'markers', text: 'Time markers' }), h('option', { value: 'trajectories', text: 'Trajectory points' }));
    const rN = h('input', { class: 'input io-num io-num-sm', type: 'number', min: '1', max: '64', step: '1', value: '8', 'aria-label': 'Particles plotted individually' });
    const rBtn = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Compute induced signals' });
    const rNote = h('p', { class: 'io-note', role: 'status' });
    const rCharts = h('div', { class: 'io-chg-charts' });
    root.appendChild(h('section', { class: 'io-card io-chg-card' },
        h('h3', { class: 'io-card-title', text: 'Induced charge and current (Shockley–Ramo)' }),
        h('p', { class: 'io-note', text: 'A particle of charge q at x induces the charge Q_k = −q·φ_k(x) on electrode k, where φ_k is the electrode\'s 1 V basis solution (its weighting potential), and the current i_k = dQ_k/dt = q·v·E_w with the weighting field E_w = −∇φ_k. The total sums every particle of the last run; after a particle ends, its final value is kept (on an electrode φ_k is 0 or 1). The spectrum of the total current needs uniform sampling: set a time-marker interval in the Recording tab; trajectory points are resampled onto a uniform grid.' }),
        h('div', { class: 'io-btnrow' }, h('label', { class: 'io-inline' }, h('span', { text: 'Electrode' }), rSel), h('label', { class: 'io-inline' }, h('span', { text: 'Samples' }), rSrc), h('label', { class: 'io-inline' }, h('span', { text: 'Plot first' }), rN), rBtn),
        rNote, rCharts));

    async function computeRamo() {
        clearCharts();
        const fs = await fieldState(rNote);
        if (!fs) return;
        const { st, resolved, sol } = fs;
        electrodeOptions(rSel, resolved, sol, true);
        const refuse = antimirrorRefusal(resolved, 'Induced charges and currents');
        if (refuse) { setNote(rNote, refuse, true); return; }
        const k = Number(rSel.value);
        if (!(k >= 1)) { setNote(rNote, 'No electrode with a basis field.'); return; }
        const res = st.run && st.run.result;
        if (!res || !res.summary || !(res.n > 0)) { setNote(rNote, 'No run yet: run the particles first (Run ▶).'); return; }
        if (st.run.runKey && st.run.runKey !== st.keys.runKey) { setNote(rNote, 'The last run is stale (the project changed since): run the particles again.', true); return; }
        const resolvedRun = res.resolvedSnapshot || resolved;
        const keys = stateKeys();
        setNote(rNote, 'Computing…');
        try {
            const key = `${sol.geomKey}|${k}|${resolved.tracer && resolved.tracer.fieldInterp}`;
            if (!wf || wfKey !== key) { wf = FA.weightingPotentials(sol, resolved, [k], { interp: (resolved.tracer && resolved.tracer.fieldInterp) || 'cubic' }); wfKey = key; }
            const maxSeries = 2000;
            const ind = FA.inducedFromResult(wf, 0, res, resolvedRun, { source: rSrc.value, maxSeries });
            if (!ind.count || !ind.total) { setNote(rNote, ind.source === 'none' ? 'The run stored neither time markers nor trajectory points (enable trajectory storage or a time-marker interval in the Recording tab).' : 'No particle of the run has sampled points.'); return; }
            const cyl = resolved.domain.type === 'cyl2d';
            const nPlot = Math.max(1, Math.min(64, Math.round(+rN.value || 8)));
            const tot = ind.total;
            const eName = nameOf(resolved, k);
            const toE = (a) => Array.from(a, (v) => v / E_CHARGE);
            const toPA = (a) => Array.from(a, (v) => v * 1e12);
            const series = (key, conv) => {
                const s = [];
                if (ind.count > 1) s.push({ label: `total (${ind.count} particles)`, x: tot.t, y: conv(tot[key]) });
                ind.particles.slice(0, nPlot).forEach((p) => s.push({ label: `particle ${p.id}`, x: p.t, y: conv(p[key]), dash: ind.count > 1 }));
                return s;
            };
            const rowsTotal = () => Array.from(tot.t, (t, i) => [t, tot.charge[i], tot.current[i]]);
            const rowsEach = () => { const out = []; for (const p of ind.particles) for (let i = 0; i < p.n; i++) out.push([p.id, p.t[i], p.charge[i], p.current[i]]); return out; };
            charts.push(chartBlock(rCharts, { title: `Induced charge on ${eName}`, plot: linePlot({ series: series('charge', toE), xLabel: 't (µs)', yLabel: 'Q (e)' }), columns: ['t_us', 'Q_C', 'I_A'], rows: rowsTotal, csvName: 'induced-total' }));
            charts.push(chartBlock(rCharts, { title: `Induced current in ${eName}`, plot: linePlot({ series: series('current', toPA), xLabel: 't (µs)', yLabel: 'i (pA)' }), columns: ['id', 't_us', 'Q_C', 'I_A'], rows: rowsEach, csvName: 'induced-particles' }));
            let specText = '', warn = false;
            const fDrive = driveFrequencyMax(resolvedRun);
            if (tot.n >= 8) {
                try {
                    const sp = FA.spectrum(tot.t, tot.current);
                    // the peak is located between bins from the Hann window's response (fieldanalysis.spectrum): exact for one clean tone
                    const fTxt = fmtNum(sp.peak.freq, digitsFor(sp.peak.freq, 0.05 * sp.df));
                    const nyq = 0.5 / sp.dt;
                    let alias = '';
                    if (fDrive > 0 && fDrive >= nyq) {
                        alias = ` The sampling interval ${fmtNum(sp.dt, 4)} µs is too long for the ${fmtNum(fDrive, 6)} MHz drive (the Nyquist frequency 1/(2·dt) is ${fmtNum(nyq, 4)} MHz): the spectrum is aliased and its peak is meaningless. Set Time markers (Recording tab) to at most ${fmtNum(0.1 / fDrive, 3)} µs, a tenth of the drive period, and run again.`;
                        warn = true;
                    }
                    charts.push(chartBlock(rCharts, { title: 'Amplitude spectrum of the total current', plot: linePlot({ series: [{ label: 'amplitude (pA)', x: sp.freq, y: toPA(sp.amp) }], xLabel: 'f (MHz)', yLabel: 'amplitude (pA)' }),
                        columns: ['f_MHz', 'amplitude_A'], rows: () => Array.from(sp.freq, (f, i) => [f, sp.amp[i]]), csvName: 'induced-spectrum',
                        note: `${sp.n} samples at ${fmtNum(sp.dt, 4)} µs (Hann window, mean removed); frequency step ${fmtNum(sp.df, 4)} MHz, Nyquist frequency ${fmtNum(nyq, 4)} MHz; strongest component ${fTxt} MHz, ${fmtNum(sp.peak.amp * 1e12, 3)} pA (located between bins from the Hann window's response: exact for a single clean tone; other components and noise set the error).${alias}` }));
                    specText = ` Spectrum peak at ${fTxt} MHz.${alias}`;
                } catch (e) { specText = ` No spectrum: ${e && e.message ? e.message : e}`; }
            }
            const srcText = ind.source === 'markers' ? `time markers every ${fmtNum(ind.dt, 4)} µs` : 'stored trajectory points (non-uniform; currents by time differences, totals resampled)';
            const nAll = resolvedRun.particleCount || 0;
            const preview = st.run.live && nAll > res.n ? ` These are the ${res.n.toLocaleString('en-US')} particles of the live preview, not all ${nAll.toLocaleString('en-US')} of the run: press Run for all.` : '';
            if (preview) warn = true;
            setNote(rNote, `${ind.count} particle${ind.count === 1 ? '' : 's'} from ${srcText}; current by ${ind.particles[0].method === 'velocity' ? 'Ramo\'s theorem' : 'time differences of the charge'}; ${cyl ? 'cylindrical' : 'planar'} model.${preview}${ind.skipped ? ` ${ind.skipped} particles beyond the first ${maxSeries} were left out.` : ''}${specText} Positions are stored in single precision (about 7 digits).`, warn);
            ramoKeys = keys;
        } catch (e) { setNote(rNote, `The induced signals could not be computed: ${e && e.message ? e.message : e}`, true); }
    }
    rBtn.addEventListener('click', () => computeRamo());

    // ================================================================ 3. multipoles
    const mPot = h('select', { class: 'input io-chg-select', 'aria-label': 'Potential to expand' });
    const mIn = {};
    for (const [key, label] of [['cx', 'center x (mm)'], ['cy', 'center y (mm)'], ['R', 'sampling radius (mm)'], ['r0', 'reference radius r₀ (mm)'], ['nMax', 'highest order'], ['samples', 'samples']]) {
        mIn[key] = h('input', { class: 'input io-num io-num-sm', type: 'text', inputmode: 'decimal', 'aria-label': label, placeholder: label });
    }
    const mBtn = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Compute multipoles' });
    const mCsv = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'CSV', disabled: true });
    const mNote = h('p', { class: 'io-note', role: 'status' });
    const mTable = h('div', { class: 'io-chg-table' });
    const field = (label, input) => h('label', { class: 'io-chg-field' }, h('span', { text: label }), input);
    const mCyField = field('center y', mIn.cy);
    let lastMulti = null, mDefaultsFor = null;
    root.appendChild(h('section', { class: 'io-card io-chg-card' },
        h('h3', { class: 'io-card-title', text: 'Multipole coefficients' }),
        h('p', { class: 'io-note io-chg-multinote', text: 'Planar: φ(r, θ) = a₀ + Σ (r/r₀)ⁿ (aₙ cos nθ + bₙ sin nθ) on a circle about the center (θ from +x). Cylindrical: φ(r, θ) = Σ cₙ (r/r₀)ⁿ Pₙ(cos θ) on a sphere about a point of the axis (θ from +x). The coefficients are in volts at r = r₀; mirrored and anti-mirrored halves are folded in. For a quadrupole, "per volt" of one rod pair (the other pair at 0 V) gives a₀ = a₂ = 0.5 when r₀ is the field radius; with the pairs at +V and −V the potential at the present voltages gives a₂ = V. Set r₀ to the field radius (the default is a quarter of the domain).' }),
        h('div', { class: 'io-chg-form' }, field('Potential', mPot), field('center x', mIn.cx), mCyField, field('sampling radius R', mIn.R), field('reference radius r₀', mIn.r0), field('highest order', mIn.nMax), field('samples', mIn.samples)),
        h('div', { class: 'io-btnrow' }, mBtn, mCsv),
        mNote, mTable));

    function multipoleOptions(resolved, sol, fld) {
        const prev = mPot.value;
        mPot.replaceChildren();
        const t = fld && fld.displayTime ? ` at t = ${fmtNum(fld.displayTime)} µs` : '';
        mPot.appendChild(h('option', { value: 'display', text: `Potential at the present voltages${t}` }));
        for (let e = 1; e < resolved.electrodes.length; e++) if (sol.bases.has(e)) mPot.appendChild(h('option', { value: String(e), text: `Per volt of ${nameOf(resolved, e)}` }));
        if ([...mPot.options].some((o) => o.value === prev)) mPot.value = prev;
    }
    function fillDefaults(resolved) {
        const key = `${resolved.domain.type}|${resolved.domain.x}|${resolved.domain.y}|${JSON.stringify(resolved.domain.mirror || {})}`;
        if (mDefaultsFor === key) return;
        mDefaultsFor = key;
        const d = multipoleDefaults(resolved);
        for (const k of Object.keys(d)) mIn[k].value = String(d[k]);
        mCyField.hidden = resolved.domain.type === 'cyl2d';
    }
    async function computeMultipoles() {
        mCsv.disabled = true; lastMulti = null;
        mTable.replaceChildren();
        const fs = await fieldState(mNote);
        if (!fs) return;
        const { resolved, sol, fld } = fs;
        multipoleOptions(resolved, sol, fld);
        fillDefaults(resolved);
        const cyl = resolved.domain.type === 'cyl2d';
        const v = {};
        for (const k of ['cx', 'cy', 'R', 'r0', 'nMax', 'samples']) v[k] = parseNum(mIn[k].value);
        if (cyl) v.cy = 0;
        if (![v.cx, v.cy, v.R, v.r0].every(Number.isFinite) || !(v.R > 0) || !(v.r0 > 0)) { setNote(mNote, 'Enter the center and positive radii in mm.', true); return; }
        const nMax = Math.max(0, Math.min(40, Math.round(v.nMax) || 0)), samples = Math.max(8, Math.min(4096, Math.round(v.samples) || (cyl ? 64 : 360)));
        try {
            let channel, label;
            const nE = resolved.electrodes.length;
            if (mPot.value === 'display') {
                const volts = electrodeVoltages(fld, nE);
                channel = { phi: fld.displayPhi, cut: volts };
                label = 'the potential at the present voltages';
            } else {
                const k = Number(mPot.value);
                const cut = new Float64Array(nE); cut[k] = 1;
                channel = { phi: sol.bases.get(k), cut };
                const amk = antimirrorPlanes(resolved);
                label = `the potential per volt of ${nameOf(resolved, k)}${amk.x || amk.y ? ' (with its anti-mirror image at −1 V)' : ''}`;
            }
            const ev = FA.createPotentialEvaluator({ raster0: sol.raster0, geometry: sol.geometry || null, domain: resolved.domain, channels: [channel], interp: (resolved.tracer && resolved.tracer.fieldInterp) || 'cubic' });
            let sampler = FA.potentialSampler(ev, 0);
            // anti-mirror planes: fold the image half with the sign change when the evaluator does not (NaN there)
            const am = antimirrorPlanes(resolved);
            if (am.x || am.y) {
                const d = resolved.domain;
                const xm = 0.5 * (d.x[0] + d.x[1]), ym = cyl ? 0.5 * d.y[1] : 0.5 * (d.y[0] + d.y[1]);
                const probe = sampler(am.x ? -xm : xm, am.y ? -ym : ym);
                if (!Number.isFinite(probe)) sampler = foldAntimirror(sampler, am);
            }
            const mp = cyl ? FA.multipoleSphere(sampler, { cx: v.cx, R: v.R, r0: v.r0, nMax, samples }) : FA.multipoleCircle(sampler, { cx: v.cx, cy: v.cy, R: v.R, r0: v.r0, nMax, samples });
            const coef = cyl ? mp.c : mp.c;
            let lead = 0;
            for (let n = 1; n <= mp.nMax; n++) if (Math.abs(coef[n]) > Math.abs(coef[lead]) || lead === 0) lead = n;
            const leadAbs = Math.abs(coef[lead]) || 1;
            const cols = cyl ? ['n', 'name', 'c_n (V)', 'c_n / c_lead'] : ['n', 'name', 'a_n cos (V)', 'b_n sin (V)', '|c_n| (V)', 'phase (°)', '|c_n| / |c_lead|'];
            const rows = [];
            for (let n = 0; n <= mp.nMax; n++) {
                rows.push(cyl ? [n, multipoleName(n, true), mp.c[n], mp.c[n] / leadAbs] : [n, multipoleName(n, false), mp.a[n], mp.b[n], mp.c[n], mp.phase[n], mp.c[n] / leadAbs]);
            }
            mTable.classList.remove('io-dim');
            mTable.appendChild(dataTable({ columns: cols, rows, caption: cyl ? `Legendre coefficients on the sphere R = ${fmtNum(v.R)} mm about x = ${fmtNum(v.cx)} mm, r₀ = ${fmtNum(v.r0)} mm` : `Fourier coefficients on the circle R = ${fmtNum(v.R)} mm about (${fmtNum(v.cx)}, ${fmtNum(v.cy)}) mm, r₀ = ${fmtNum(v.r0)} mm`, digits: 7 }));
            setNote(mNote, `Expansion of ${label}: ${mp.samples} samples, orders 0–${mp.nMax}; leading term n = ${lead} (${multipoleName(lead, cyl)}); rms residual of the truncated series on the sampling surface ${fmtNum(mp.residual, 3)} V.`);
            lastMulti = { cols, rows, keys: stateKeys(), perVolt: mPot.value !== 'display' };
            mCsv.disabled = false;
        } catch (e) { setNote(mNote, `The expansion could not be computed: ${e && e.message ? e.message : e}`, true); }
    }
    mBtn.addEventListener('click', () => computeMultipoles());
    mCsv.addEventListener('click', () => { if (lastMulti) download(csvText(lastMulti.cols.map((c) => c.replace(/\s*\(.*\)$/, '').replace(/[^\w|/]+/g, '_')), lastMulti.rows), `${fileStem((ctx.store.get().project.meta || {}).name)}-multipoles.csv`); });

    // ---------------------------------------------------------------- updates
    function refreshOptions() {
        const st = ctx.store.get();
        if (!st.resolved) return;
        const sol = st.solution && st.solution.geomKey === st.keys.geomKey ? st.solution : null;
        electrodeOptions(fSel, st.resolved, sol, true);
        electrodeOptions(rSel, st.resolved, sol, true);
        multipoleOptions(st.resolved, sol || { bases: new Map() }, st.field);
        fillDefaults(st.resolved);
    }
    /**
     * Compares the shown results with the current state (also when the tab was hidden while the project, the preset or the
     * voltages changed): the charges are recomputed; induced signals and multipoles of another geometry are cleared, and
     * those of other fields or another run are dimmed with a note.
     */
    function checkStale() {
        const now = stateKeys();
        if (lastCharges && (lastCharges.keys.geom !== now.geom || lastCharges.keys.field !== now.field)) {
            if (lastCharges.keys.geom !== now.geom) { cTables.replaceChildren(); lastCharges = null; lastFloat = null; fApply.disabled = true; cCsvQ.disabled = true; cCsvC.disabled = true; setNote(fNote, ''); setNote(cNote, 'The geometry changed; computing again…'); }
            scheduleCharges();
        }
        if (charts.length && ramoKeys) {
            if (ramoKeys.geom !== now.geom) { clearCharts(); setNote(rNote, 'The project changed (another geometry); compute the induced signals again.'); }
            else if (ramoKeys.field !== now.field || ramoKeys.run !== now.run) { rCharts.classList.add('io-dim'); setNote(rNote, 'The fields or the run changed since these signals were computed; compute again for the current state.', true); }
        }
        if (lastMulti) {
            if (lastMulti.keys.geom !== now.geom) { mTable.replaceChildren(); lastMulti = null; mCsv.disabled = true; setNote(mNote, 'The project changed (another geometry); compute the multipoles again.'); }
            else if (!lastMulti.perVolt && lastMulti.keys.field !== now.field) { mTable.classList.add('io-dim'); setNote(mNote, 'The voltages or the display time changed since this expansion; compute again for the current state.', true); }
        }
    }
    function scheduleCharges() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; computeCharges(); }, 250);
    }
    refreshOptions();
    setNote(cNote, 'Solve the fields, then compute.');
    return {
        update(evt) {
            const type = evt && evt.type;
            if (type === 'show') { refreshOptions(); checkStale(); if (!lastCharges) scheduleCharges(); return; }
            if (type === 'solution' || type === 'field' || type === 'resolved' || type === 'project' || type === 'run') { refreshOptions(); checkStale(); }
        },
        destroy() { if (timer) clearTimeout(timer); clearCharts(); root.remove(); },
    };
}
