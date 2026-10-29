// Components tab controller (spec 4.2): line editor, results, checks, schematic, element table, plots and the
// "Verify by Monte Carlo" box. The pure helpers at the top are exported for the Node tests; mount() needs a DOM.

import { ELEMENT_TYPES, defaultItem, describeItem, mergeItems } from '../engine/elements.js';
import { analyze, sweep } from '../engine/network.js';
import { GASES, waterSaturation } from '../engine/gas.js';
import { decodeItems, DEFAULT_RANGE } from './url-state.js';
import { renderSchematic, defaultMode, SHARE_LEGEND, SHARE_MIX } from './schematic.js';
import { fmt, fmtNum, fmtPct, fmtSignedPct, fmtCI, toSI, fromSI, parseInput, editText } from './format.js';

// ================================================================================================ pure helpers

/** Appendix B presets: chip label, gas, boundary and the hash item string. */
export const PRESETS = Object.freeze([
    { label: 'Turbo on a DN100 line', gas: 'N2', bc: { mode: 'pump', p0: 1e-4 }, i: 'tube(d=0.1,L=0.2)elbow(d=0.1,A=0.1,B=0.1)pump(S=0.3,d=0.1,label=Turbo)' },
    { label: 'Livesey p. 100', gas: 'air', bc: { mode: 'pump', p0: 1e-4 }, i: 'tube(d=0.1,L=0.2)pump(S=0.3,d=0.1,label=Pump)' },
    { label: 'Roughing line (KF25)', gas: 'air', bc: { mode: 'pump', p0: 100 }, i: 'tube(d=0.025,L=1)pump(S=0.009722222,d=0.025,label=Rotary_vane)' },
    { label: 'Beamline: valve and reducer', gas: 'N2', bc: { mode: 'pump', p0: 1e-5 }, i: 'tube(d=0.04,L=0.15)bbox(C=0.08,gasRef=N2,d=0.04,label=Gate_valve)cone(d1=0.04,d2=0.063,L=0.05)pump(S=0.08,d=0.063,label=Turbo)' },
    { label: 'Differential aperture', gas: 'N2', bc: { mode: 'dp', p0: 10, p1: 0.01 }, i: 'orif(shape=circle,d=0.001)' },
    { label: 'Slit seal at atmosphere', gas: 'air', bc: { mode: 'dp', p0: 1e5, p1: 1e3 }, i: 'slit(h=0.0001,w=0.05,L=0.01)' },
    { label: 'Parallel branches', gas: 'N2', bc: { mode: 'pump', p0: 1e-4 }, i: 'tube(d=0.05,L=0.1)par(tube(d=0.02,L=0.3);tube(d=0.03,L=0.5)elbow(d=0.03,A=0.05,B=0.05))pump(S=0.05,d=0.05,label=Turbo)' },
]);

/** The full model of preset k (0-based): T = 293.15 K, the gas's default C_d, the default plot range. */
export function presetModel(k) {
    const p = PRESETS[k];
    return { items: decodeItems(p.i), gas: { id: p.gas, T: 293.15, custom: null }, Cd: null, bc: { ...p.bc }, range: { ...DEFAULT_RANGE } };
}

const GEOMETRIC = ['tube', 'orifice', 'slit', 'rect', 'annulus', 'cone', 'elbow', 'bbox'];
export const MAX_TOP = 40, MAX_BRANCH_ITEMS = 6, MIN_BRANCHES = 2, MAX_BRANCHES = 4;
const clone = (v) => JSON.parse(JSON.stringify(v));

/** '4.1.2' -> { i: 4, b: 1, j: 2 }; '3' -> { i: 3 }. */
export function parsePath(path) {
    const [i, b, j] = String(path).split('.').map(Number);
    return b === undefined ? { i } : { i, b, j };
}
const hasPump = (items) => items.length > 0 && items[items.length - 1] && items[items.length - 1].t === 'pump';
const listOf = (items, p) => (p.b === undefined ? items : items[p.i].branches[p.b]);
const indexOf = (p) => (p.b === undefined ? p.i : p.j);

/** Inserts defaultItem(type) before the pump (or at the end). Returns new items; unchanged at the 40-item limit or for a pump. */
export function insertItem(items, type) {
    if (!ELEMENT_TYPES[type] || type === 'pump' || items.length >= MAX_TOP) return items;
    const out = clone(items), at = hasPump(out) ? out.length - 1 : out.length;
    out.splice(at, 0, defaultItem(type));
    return out;
}

/** Appends defaultItem(type) to branch b of the parallel group at top-level index i (geometric types and bbox only). */
export function addToBranch(items, i, b, type) {
    if (!GEOMETRIC.includes(type)) return items;
    const br = items[i] && items[i].t === 'parallel' && items[i].branches[b];
    if (!br || br.length >= MAX_BRANCH_ITEMS) return items;
    const out = clone(items);
    out[i].branches[b].push(defaultItem(type));
    return out;
}

/** True when the item at path may be removed (never the pump; never the last element of a branch). */
export function canRemove(items, path) {
    const p = parsePath(path), list = listOf(items, p), it = list[indexOf(p)];
    if (!it || it.t === 'pump') return false;
    return p.b === undefined || list.length > 1;
}

/** True when the item can move one place in direction dir (−1 up, +1 down); the pump stays last. */
export function canMove(items, path, dir) {
    const p = parsePath(path), list = listOf(items, p), k = indexOf(p), to = k + dir, it = list[k];
    if (!it || it.t === 'pump' || to < 0 || to >= list.length) return false;
    return !(list[to] && list[to].t === 'pump');
}

/** True when the item can be duplicated (not the pump; within the 40-item and 6-per-branch limits). */
export function canDuplicate(items, path) {
    const p = parsePath(path), list = listOf(items, p), it = list[indexOf(p)];
    if (!it || it.t === 'pump') return false;
    return list.length < (p.b === undefined ? MAX_TOP : MAX_BRANCH_ITEMS);
}

export function removeItem(items, path) {
    if (!canRemove(items, path)) return items;
    const p = parsePath(path), out = clone(items);
    listOf(out, p).splice(indexOf(p), 1);
    return out;
}

export function moveItem(items, path, dir) {
    if (!canMove(items, path, dir)) return items;
    const p = parsePath(path), out = clone(items), list = listOf(out, p), k = indexOf(p);
    [list[k], list[k + dir]] = [list[k + dir], list[k]];
    return out;
}

export function duplicateItem(items, path) {
    if (!canDuplicate(items, path)) return items;
    const p = parsePath(path), out = clone(items), list = listOf(out, p), k = indexOf(p);
    list.splice(k + 1, 0, clone(list[k]));
    return out;
}

/** Adds a branch (one default tube) to the parallel group at index i, up to 4 branches. */
export function addBranch(items, i) {
    const g = items[i];
    if (!g || g.t !== 'parallel' || g.branches.length >= MAX_BRANCHES) return items;
    const out = clone(items);
    out[i].branches.push([defaultItem('tube')]);
    return out;
}

/** Removes branch b of the group at index i, keeping at least 2 branches. */
export function removeBranch(items, i, b) {
    const g = items[i];
    if (!g || g.t !== 'parallel' || g.branches.length <= MIN_BRANCHES) return items;
    const out = clone(items);
    out[i].branches.splice(b, 1);
    return out;
}

/**
 * Switches the boundary mode. To 'dp': the pump is removed (returned as memo so it can come back) and p1 = p0/1000.
 * To 'pump': the memo pump (or a default pump) is appended. Returns { items, bc, memo }.
 */
export function setBoundary(items, bc, mode, memo = null) {
    if (mode === bc.mode) return { items, bc, memo };
    const out = clone(items);
    if (mode === 'dp') {
        let pump = null;
        if (hasPump(out)) pump = out.pop();
        return { items: out, bc: { mode: 'dp', p0: bc.p0, p1: bc.p0 / 1000 }, memo: pump || memo };
    }
    out.push(memo ? clone(memo) : defaultItem('pump'));
    return { items: out, bc: { mode: 'pump', p0: bc.p0 }, memo };
}

const num1 = (path) => String(path).split('.').map((x) => Number(x) + 1).join('.');
const listText = (xs) => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);

/** The levels and titles of the check codes (spec 4.2.4). */
export const FLAG_INFO = Object.freeze({
    turbulent: { level: 'warn', title: 'Turbulent flow' },
    compressible: { level: 'warn', title: 'Compressible flow' },
    choked: { level: 'warn', title: 'Choked entrance' },
    'choked-exit': { level: 'warn', title: 'Choked outlet' },
    inertial: { level: 'warn', title: 'Inertial entrance loss' },
    extrapolated: { level: 'warn', title: 'Outside the table range' },
    'short-element': { level: 'warn', title: 'Short element' },
    'viscous-estimate': { level: 'ok', title: 'Black box' },
    merged: { level: 'ok', title: 'Merged elements' },
    'no-effect': { level: 'ok', title: 'Orifice without effect' },
    'water-condenses': { level: 'bad', title: 'Condensation' },
    'temperature-range': { level: 'warn', title: 'Temperature range' },
    'partial-overlap': { level: 'warn', title: 'Partly blocked junction' },
    'pump-wider': { level: 'warn', title: 'Pump wider than the line' },
    'pump-rod': { level: 'warn', title: 'Rod ends at the pump' },
    transitional: { level: 'ok', title: 'Transitional flow' },
});

/**
 * Check item of a code: { code, level, title, text }. ctx = { n: element number text, merged: number texts,
 * Re, Ma, Kn, pSat: formatted saturation pressure }.
 */
export function flagSentence(code, ctx = {}) {
    const info = FLAG_INFO[code];
    if (!info) return null;
    const n = ctx.n ?? '?', r3 = (x) => (Number.isFinite(x) ? fmtNum(x, 3) : '…');
    let text;
    switch (code) {
        case 'turbulent': text = `Turbulent in element ${n} (Re = ${r3(ctx.Re)}): the laminar model overestimates the conductance.`; break;
        case 'compressible': text = `Mach ${Number.isFinite(ctx.Ma) ? fmtNum(ctx.Ma, 2) : '…'} at the outlet of element ${n}: compressibility reduces accuracy.`; break;
        case 'choked': text = `Choked at the entrance of element ${n}: the flow is set by the upstream pressure, C_d and the area.`; break;
        case 'choked-exit': text = `Flow chokes at the outlet of element ${n} (isothermal limit): the downstream pressure no longer matters.`; break;
        case 'inertial': text = `Entrance loss of element ${n} is dominated by inertia (Bernoulli), set by C_d.`; break;
        case 'extrapolated': text = `Element ${n} is outside the validated table range; accuracy about ±1 %.`; break;
        case 'short-element': text = `Element ${n} is short (L < D_h) in viscous flow: entrance effects make this ±20 %.`; break;
        case 'viscous-estimate': text = `Black box ${n} is modeled as an equivalent tube outside molecular flow.`; break;
        case 'merged': text = `Elements ${listText(ctx.merged && ctx.merged.length ? ctx.merged : [n])} have the same bore and were combined into one for accuracy.`; break;
        case 'no-effect': text = `Orifice ${n} is at least as large as the bore before it and has no effect.`; break;
        case 'water-condenses': text = `Water vapor above its saturation pressure (${ctx.pSat ?? '…'} at this temperature) would condense.`; break;
        case 'temperature-range': text = 'The gas data are fitted near room temperature; outside 200 to 600 K the viscosity is extrapolated.'; break;
        case 'partial-overlap': text = `The opening of element ${n} only partly overlaps the one before it, so part of the gas meets a wall face. The formula treats this roughly and can be tens of percent high; use Verify by Monte Carlo.`; break;
        case 'pump-wider': text = 'The pump inlet is wider than the outlet of the line. The result assumes the gas spreads over the whole pump inlet, as on the speed test dome; a line that ends right at the pump flange gets less. Add the adapter or the pump throat as an element for a closer value.'; break;
        case 'pump-rod': text = `The rod of element ${n} ends at the pump inlet, so its end face shades part of the inlet. The result assumes the gas spreads over the whole pump inlet, as on the speed test dome. Add a short tube of the pump bore after the annulus for a closer value and to verify this line by Monte Carlo.`; break;
        case 'transitional': text = `Transitional flow in element ${n} (Kn = ${r3(ctx.Kn)}): accuracy ±3 % for long tubes, ±10 % otherwise.`; break;
        default: break;
    }
    return { code, level: info.level, title: info.title, text };
}

const LEVEL_ORDER = { bad: 0, warn: 1, ok: 2 };

/** All check items of an analysis, worst first. opts.fmtP formats the water saturation pressure. */
export function checksFor(analysis, opts = {}) {
    const out = [];
    const fmtP = opts.fmtP || ((p) => fmtNum(p, 3) + ' Pa');
    const top = (analysis.elements || []).filter((e) => !String(e.path).includes('.'));
    const lastN = top.length ? num1(top[top.length - 1].path) : '?';
    for (const w of analysis.warnings || []) {
        const c = flagSentence(w, { n: lastN, pSat: w === 'water-condenses' ? fmtP(waterSaturation(analysis.gas.T)) : undefined });
        if (c) out.push(c);
    }
    for (const e of analysis.elements || []) {
        const parts = String(e.path).split('.'), n = num1(e.path);
        const merged = e.mergedFrom && e.mergedFrom.length > 1
            ? e.mergedFrom.map((j) => num1(parts.length === 1 ? String(j) : `${parts[0]}.${parts[1]}.${j}`)) : null;
        for (const f of e.flags || []) {
            const c = flagSentence(f, { n, merged, Re: e.Re, Ma: e.Ma, Kn: e.Kn });
            if (c) out.push(c);
        }
        if (e.regime === 'transitional') out.push(flagSentence('transitional', { n, Kn: e.Kn }));
    }
    return out.map((c, k) => ({ c, k })).sort((a, b) => LEVEL_ORDER[a.c.level] - LEVEL_ORDER[b.c.level] || a.k - b.k).map((x) => x.c);
}

/**
 * Band badge of a Monte Carlo result against the molecular formula value (spec 3.5.6, Appendix B):
 * within when the MC 95 % interval overlaps [formula (1 + lo), formula (1 + hi)].
 */
export function bandBadge(mc, formula, band, approx = false) {
    const eps = 1e-9 * Math.abs(formula);   // an exact result (σ = 0) equal to the formula value is within
    const lo = formula * (1 + band.lo) - eps, hi = formula * (1 + band.hi) + eps;
    const ci = mc.ci95 || [mc.value, mc.value];
    const within = ci[1] >= lo && ci[0] <= hi;
    const exact = band.lo === 0 && band.hi === 0;   // a line whose molecular formula is exact (lone orifice, black box)
    const range = `${fmtSignedPct(band.lo)} to ${fmtSignedPct(band.hi)}`;
    return {
        within, cls: within ? 'badge badge-ok' : 'badge badge-warn',
        text: exact ? (within ? 'Matches the exact formula value' : 'Differs from the exact formula value')
            : within ? `Within the expected band (${range})` : `Outside the expected band (${range})`,
        // approx: the simulation itself simplifies the line (black boxes as tubes, pumps on plenums; see its notes)
        note: within ? '' : approx ? 'The formula combines elements approximately. The Monte Carlo value is exact for the simulated geometry; see the notes below for what it simplifies.'
            : 'The formula combines elements approximately. Trust the Monte Carlo value for this geometry.',
        diff: mc.value / formula - 1,
    };
}

/** "Monte Carlo is 0.36 % lower" style comparison text. */
export function compareText(diff) {
    if (!Number.isFinite(diff)) return '';
    if (Math.abs(diff) < 5e-5) return 'Monte Carlo and formula agree within 0.01 %';
    return `Monte Carlo is ${fmtNum(Math.abs(diff) * 100, 2)} % ${diff < 0 ? 'lower' : 'higher'}`;
}

/** The running-status line: "0.8 M particles · 35 M rays/s · ±1.6 % (95 %) · about 1 s left". */
export function mcStatusLine(p) {
    const parts = [`${fmtNum((p.particles || 0) / 1e6, 2)} M particles`];
    if (Number.isFinite(p.castsPerSec) && p.castsPerSec > 0) parts.push(`${fmtNum(p.castsPerSec / 1e6, 2)} M rays/s`);
    if (Number.isFinite(p.relHalfWidth)) parts.push(`±${fmtNum(p.relHalfWidth * 100, 2)} % (95 %)`);
    if (Number.isFinite(p.etaSeconds) && p.etaSeconds > 0) parts.push(`about ${Math.max(1, Math.ceil(p.etaSeconds))} s left`);
    return parts.join(' · ');
}

const SHORT_FLAG = { turbulent: 'turbulent', compressible: 'compressible', choked: 'choked', 'choked-exit': 'exit choke', inertial: 'inertial entrance',
    extrapolated: 'extrapolated', 'short-element': 'short', 'viscous-estimate': 'equivalent tube', merged: 'merged', 'no-effect': 'no effect',
    'partial-overlap': 'partly blocked' };
const NAME = { tube: 'Tube', orifice: 'Orifice', slit: 'Slit', rect: 'Duct', annulus: 'Annulus', cone: 'Cone', elbow: 'Elbow', bbox: 'Black box', pump: 'Pump' };

/** Short note words of an element row. */
export function noteWords(e) {
    const w = (e.flags || []).map((f) => SHORT_FLAG[f] || f);
    if (e.regime === 'transitional') w.push('transitional');
    return w;
}

const csvCell = (v) => { const s = v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const sig = (x) => (Number.isFinite(x) ? String(Number(x.toPrecision(6))) : '');

/** The element table as CSV with SI units in the header. */
export function elementsCSV(analysis) {
    const head = ['#', 'Element', 'alpha (molecular)', 'C alone, molecular (m3/s)', 'C here, operating (m3/s)', 'Share of the pressure drop',
        'p in (Pa)', 'p out (Pa)', 'Kn', 'Re', 'Mach', 'Regime', 'Notes'];
    const rows = [head];
    for (const e of analysis.elements || []) {
        rows.push([num1(e.path), e.describe, sig(e.alpha), sig(e.Cmol), sig(e.Cop), sig(e.share), sig(e.pIn), sig(e.pOut), sig(e.Kn), sig(e.Re), sig(e.Ma), e.regime, noteWords(e).join('; ')]);
    }
    if (analysis.pump) {
        const pp = analysis.pump;
        rows.push(['pump', 'Pump S = ' + sig(pp.S) + ' m3/s', '', '', '', sig(pp.share), sig(pp.pIn), '', '', '', '', '', pp.Sc > pp.S * 1.0005 ? 'S_c = ' + sig(pp.Sc) + ' m3/s (entrance-corrected)' : '']);
    }
    return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

/** Largest-share element index (-1 without elements). */
export function controllingIndex(analysis) {
    let best = -1;
    (analysis.elements || []).forEach((e, i) => { if (best < 0 || e.share > analysis.elements[best].share) best = i; });
    return best;
}

// ================================================================================================ DOM

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pid = (path) => String(path).replace(/\./g, '-');
const SVG_ICON = {
    up: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    dup: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
    del: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};
const ICON = { ok: '✓', warn: '!', bad: '✕' };
const LEVEL_WORD = { ok: 'Note', warn: 'Warning', bad: 'Problem' };
const SHAPE_LABEL = { circle: 'Circular', rect: 'Rectangular' };

/**
 * Mounts the Components tab. root: the #tab-components panel holding the static markup of index.html.
 * ctx = { store, getRunner, initial: Model, notice, onChange(), probeWorkers() }.
 * Returns { getModel(), setModel(model, { notice }), setItems(items), refresh(), dispose() }.
 */
export function mount(root, ctx = {}) {
    const store = ctx.store;
    const $ = (id) => root.querySelector('#' + id);
    const el = {
        notice: $('cl-notice'), presets: $('cl-presets'), chain: $('cl-chain'), add: $('cl-add'), error: $('cl-error'),
        results: $('cl-results'), checks: $('cl-checks'), regimeBadge: $('cl-regime-badge'),
        sch: $('cl-schematic'), legend: $('cl-legend'), table: $('cl-table'), csv: $('cl-csv'),
        plotOp: $('cl-plot-op'), plotOpTitle: $('cl-plot-op-h'), plotC: $('cl-plot-c'), pMin: $('cl-pmin'), pMax: $('cl-pmax'),
        mcRun: $('cl-mc-run'), mcHint: $('cl-mc-hint'), mcRunning: $('cl-mc-running'), mcProg: $('cl-mc-prog'), mcStatus: $('cl-mc-status'),
        mcStop: $('cl-mc-stop'), mcResults: $('cl-mc-results'), mcTarget: $('cl-mc-target'), mcTime: $('cl-mc-time'), mcSeed: $('cl-mc-seed'),
        mcSeedErr: $('cl-mc-seed-err'), mcBox: $('cl-mc'), addBtn: $('cl-add-btn'),
    };
    const init = ctx.initial || presetModel(0);
    let model = { items: clone(init.items), bc: clone(init.bc), range: clone(init.range || DEFAULT_RANGE) };
    let pumpMemo = null, schMode = null, schBasis = 'op';
    let good = null;           // { model (full), analysis, sw: { op, C }, key }
    let mc = null;             // { result, plan, key, stopped, formula, band }
    let planner = null, timer = 0, activePath = null, running = false;

    const units = () => store.get();
    const fullModel = () => {
        const s = store.get();
        return { items: model.items, gas: { id: s.gas, T: s.T, custom: s.gas === 'custom' ? s.custom : null }, Cd: s.Cd ?? null, bc: model.bc, range: model.range };
    };
    const keyOf = (m) => JSON.stringify([m.items, m.gas, m.Cd, m.bc]);
    const fmtLen = (m) => fmt('length', m);
    const fmtSpeed = (x) => fmt('speed', x);
    const fmtP = (p) => fmt('pressure', p, { sig: 3 });
    const changed = () => { if (typeof ctx.onChange === 'function') ctx.onChange(); };

    // -------------------------------------------------------------- presets, boundary
    el.presets.innerHTML = PRESETS.map((p, k) => `<button type="button" class="chip" data-preset="${k}">${esc(p.label)}</button>`).join('');
    // a preset replaces the whole line; when the line was the user's own (no preset), it can be restored once
    let undo = null;
    const isPreset = () => { const k = keyOf(fullModel()); return PRESETS.some((_, j) => keyOf(presetModel(j)) === k); };
    el.presets.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-preset]');
        if (!b) return;
        const own = !isPreset(), st = store.get();
        const before = { items: clone(model.items), bc: clone(model.bc), range: clone(model.range), gas: { gas: st.gas, T: st.T, custom: st.custom, Cd: st.Cd } };
        const m = presetModel(Number(b.dataset.preset));
        model = { items: m.items, bc: m.bc, range: m.range };
        pumpMemo = null; schMode = null;
        store.set({ gas: m.gas.id, T: m.gas.T, custom: null, Cd: null });
        hideNotice();
        if (own && el.notice) {
            undo = before;
            el.notice.innerHTML = 'Example loaded; it replaced your line. <button type="button" class="btn btn-ghost btn-sm" data-undo>Undo</button>';
            el.notice.hidden = false;
        }
        renderAll(true);
        changed();
    });
    if (el.notice) el.notice.addEventListener('click', (ev) => {
        if (!ev.target.closest('[data-undo]') || !undo) return;
        const u = undo;
        hideNotice();
        model = { items: u.items, bc: u.bc, range: u.range };
        pumpMemo = null; schMode = null;
        store.set(u.gas);
        renderAll(true);
        changed();
        const first = el.presets.querySelector('button');
        if (first) first.focus();
    });
    root.querySelectorAll('input[name="cl-bc"]').forEach((r) => r.addEventListener('change', () => {
        if (!r.checked) return;
        const s = setBoundary(model.items, model.bc, r.value, pumpMemo);
        model.items = s.items; model.bc = s.bc; pumpMemo = s.memo;
        renderAll(true);
        changed();
    }));
    const syncBoundary = () => root.querySelectorAll('input[name="cl-bc"]').forEach((r) => { r.checked = r.value === model.bc.mode; });

    // add-element select
    el.add.innerHTML = '<option value="">Choose a type…</option>' + Object.entries(ELEMENT_TYPES)
        .filter(([t]) => t !== 'pump').map(([t, d]) => `<option value="${t}">${esc(d.label)}</option>`).join('');
    // choosing a type only selects it; the Add button (or Enter) inserts it (arrow keys must not act, WCAG 3.2.2)
    const addSelected = () => {
        const t = el.add.value;
        if (!t) { el.add.focus(); return; }
        el.add.value = '';
        const before = model.items.length;
        model.items = insertItem(model.items, t);
        if (model.items.length === before) return;
        const at = hasPump(model.items) ? model.items.length - 2 : model.items.length - 1;
        renderChain();
        schedule(0);
        focusCard(String(at));
        changed();
    };
    if (el.addBtn) el.addBtn.addEventListener('click', addSelected);
    el.add.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addSelected(); } });

    function hideNotice() { undo = null; if (el.notice) { el.notice.hidden = true; el.notice.textContent = ''; } }
    if (ctx.notice && el.notice) { el.notice.textContent = ctx.notice; el.notice.hidden = false; }

    // -------------------------------------------------------------- chain rendering
    const itemAt = (path) => { const p = parsePath(path); return listOf(model.items, p)[indexOf(p)]; };

    function fieldHTML(path, f, it) {
        const id = `cl-f-${pid(path)}-${f.key}`, err = `<p class="cl-ferr" id="${id}-err" hidden></p>`;
        if (f.kind === 'number') {
            const u = f.dim === 'length' ? units().lu : units().su;
            const v = Number.isFinite(it[f.key]) ? editText(fromSI(f.dim, u, it[f.key])) : '';
            return `<div class="field"><label for="${id}">${esc(f.label)}</label><div class="input-unit"><input id="${id}" data-key="${f.key}" data-kind="number" data-dim="${f.dim}" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(v)}" aria-describedby="${id}-err"><span class="unit">${esc(u)}</span></div>${err}</div>`;
        }
        if (f.kind === 'select') {
            const opts = f.options.map((o) => `<option value="${esc(o)}"${it[f.key] === o ? ' selected' : ''}>${esc(f.key === 'gasRef' ? (GASES[o] ? GASES[o].name : o) : SHAPE_LABEL[o] || o)}</option>`).join('');
            return `<div class="field"><label for="${id}">${esc(f.label || (f.key === 'shape' ? 'Shape' : f.key))}</label><select id="${id}" class="input" data-key="${f.key}" data-kind="select" aria-describedby="${id}-err">${opts}</select>${err}</div>`;
        }
        return `<div class="field"><label for="${id}">${esc(f.label || 'Name')}</label><input id="${id}" class="input" data-key="${f.key}" data-kind="text" maxlength="${f.maxLength || 40}" autocomplete="off" value="${esc(it[f.key] ?? '')}" aria-describedby="${id}-err">${err}</div>`;
    }
    const activeFields = (it) => ELEMENT_TYPES[it.t].fields.filter((f) => !f.when || Object.entries(f.when).every(([k, v]) => it[k] === v));

    function buttonsHTML(path, items) {
        const n = num1(path);
        const b = (act, label, ok) => `<button type="button" class="btn btn-ghost btn-sm cl-icon" data-act="${act}" aria-label="${label}"${ok ? '' : ' disabled'}>${SVG_ICON[act]}</button>`;
        return `<span class="cl-card-btns">${b('up', `Move element ${n} up`, canMove(items, path, -1))}${b('down', `Move element ${n} down`, canMove(items, path, 1))}`
            + `${b('dup', `Duplicate element ${n}`, canDuplicate(items, path))}${b('del', `Remove element ${n}`, canRemove(items, path))}</span>`;
    }

    function cardHTML(it, path) {
        const def = ELEMENT_TYPES[it.t], n = num1(path), isPump = it.t === 'pump', sub = path.includes('.');
        const head = `<div class="cl-card-head"><span class="cl-num" aria-hidden="true">${n}</span><span class="cl-card-type">${esc(def.label)}</span>`
            + `<span class="cl-card-desc" data-desc>${esc(it.t === 'parallel' ? '' : describeItem(it, fmtLen, fmtSpeed))}</span>${isPump ? '' : buttonsHTML(path, model.items)}</div>`;
        let bodyHTML = '';
        if (it.t === 'parallel') {
            const cols = it.branches.map((br, b) => {
                const subs = br.map((s, j) => cardHTML(s, `${path}.${b}.${j}`)).join('');
                const addOpts = '<option value="">+ element</option>' + GEOMETRIC.map((t) => `<option value="${t}">${esc(ELEMENT_TYPES[t].label)}</option>`).join('');
                return `<div class="cl-branch" data-branch="${b}"><h4 class="cl-branch-h">Branch ${b + 1}</h4><ol class="cl-chain cl-subchain">${subs}</ol>`
                    + `<div class="cl-branch-actions"><select class="input cl-branch-add" data-group="${path}" data-branch="${b}" aria-label="Element type to add to branch ${b + 1}"${br.length >= MAX_BRANCH_ITEMS ? ' disabled' : ''}>${addOpts}</select>`
                    + `<button type="button" class="btn btn-secondary btn-sm" data-act="branchadd" data-branch="${b}" aria-label="Add the chosen element to branch ${b + 1}"${br.length >= MAX_BRANCH_ITEMS ? ' disabled' : ''}>Add</button>`
                    + `<button type="button" class="btn btn-ghost btn-sm" data-act="rmbranch" data-branch="${b}"${it.branches.length <= MIN_BRANCHES ? ' disabled' : ''}>Remove branch</button></div></div>`;
            }).join('');
            bodyHTML = `<div class="cl-branches">${cols}</div><div class="cl-branch-more"><button type="button" class="btn btn-secondary btn-sm" data-act="addbranch"${it.branches.length >= MAX_BRANCHES ? ' disabled' : ''}>+ Branch</button>`
                + `<span class="hint">Branches start and end in ideal mixing volumes. Up to ${MAX_BRANCHES} branches of up to ${MAX_BRANCH_ITEMS} elements.</span></div>`;
        } else if (it.t === 'chamber') {
            bodyHTML = '<p class="hint">A large volume: the flow mixes completely here, so the next element starts from a still gas.</p>';
        } else {
            bodyHTML = `<div class="field-row">${activeFields(it).map((f) => fieldHTML(path, f, it)).join('')}</div>`;
            if (isPump) bodyHTML += '<p class="hint">Use the speed for this gas; turbo pumps pump light gases more slowly.</p>';
        }
        return `<li class="cl-card${sub ? ' cl-mini' : ''}${isPump ? ' cl-pump' : ''}${it.t === 'parallel' ? ' cl-par' : ''}" id="cl-card-${pid(path)}" data-path="${path}" tabindex="-1">${head}${bodyHTML}`
            + `<p class="hint cl-card-note" data-note hidden></p><p class="cl-ferr" data-cerr hidden></p></li>`;
    }

    function endHTML(kind) {
        const pu = units().pu, bc = model.bc, dp = bc.mode === 'dp';
        const key = kind === 'start' ? 'p0' : 'p1';
        const label = kind === 'start' ? (dp ? 'Upstream pressure <span class="sym">p₁</span>' : 'Chamber pressure <span class="sym">p₀</span>') : 'Downstream pressure <span class="sym">p₂</span>';
        const v = Number.isFinite(bc[key]) ? editText(fromSI('pressure', pu, bc[key])) : '';
        const title = kind === 'start' ? (dp ? 'Upstream volume' : 'Chamber') : 'Downstream volume';
        return `<li class="cl-card cl-fixed" data-end="${kind}"><div class="cl-card-head"><span class="cl-card-type">${title}</span></div>`
            + `<div class="field"><label for="cl-${key}">${label}</label><div class="input-unit"><input id="cl-${key}" data-bc="${key}" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(v)}" aria-describedby="cl-${key}-err"><span class="unit">${esc(pu)}</span></div>`
            + `<p class="cl-ferr" id="cl-${key}-err" hidden></p></div></li>`;
    }

    function renderChain() {
        const focusId = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : null;
        el.chain.innerHTML = endHTML('start') + model.items.map((it, i) => cardHTML(it, String(i))).join('') + (model.bc.mode === 'dp' ? endHTML('end') : '');
        el.add.disabled = model.items.length >= MAX_TOP;
        if (el.addBtn) el.addBtn.disabled = model.items.length >= MAX_TOP;
        if (focusId) { const f = document.getElementById(focusId); if (f) f.focus(); }
        if (good) { updateCardNotes(good.analysis); }
    }

    function focusCard(path) {
        const card = root.querySelector(`#cl-card-${pid(path)}`);
        if (!card) return;
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        const f = card.querySelector('input, select');
        (f || card).focus({ preventScroll: true });
    }

    // -------------------------------------------------------------- chain events
    el.chain.addEventListener('input', (ev) => onField(ev.target, false));
    const addToBranchFrom = (sel) => {
        const type = sel.value;
        if (!type) { sel.focus(); return; }
        const i = Number(sel.dataset.group), b = Number(sel.dataset.branch);
        sel.value = '';
        model.items = addToBranch(model.items, i, b, type);
        renderChain(); schedule(0); changed();
        focusCard(`${i}.${b}.${model.items[i].branches[b].length - 1}`);
    };
    el.chain.addEventListener('change', (ev) => {
        const t = ev.target;
        if (t.classList.contains('cl-branch-add')) return;   // only a choice; the Add button acts
        onField(t, true);
    });
    el.chain.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && ev.target.classList && ev.target.classList.contains('cl-branch-add')) { ev.preventDefault(); addToBranchFrom(ev.target); }
    });
    function onField(t, isChange) {
        if (t.dataset.bc) {
            const v = parseInput(t.value);
            model.bc = { ...model.bc, [t.dataset.bc]: Number.isFinite(v) ? toSI('pressure', units().pu, v) : NaN };
            schedule(); changed();
            return;
        }
        const card = t.closest('[data-path]');
        if (!card || !t.dataset.key) return;
        const path = card.dataset.path, it = itemAt(path);
        if (!it) return;
        const key = t.dataset.key;
        if (t.dataset.kind === 'number') {
            const v = parseInput(t.value), u = t.dataset.dim === 'length' ? units().lu : units().su;
            it[key] = Number.isFinite(v) ? toSI(t.dataset.dim, u, v) : NaN;
        } else if (t.dataset.kind === 'select') {
            if (!isChange && t.tagName === 'SELECT') return;
            it[key] = t.value;
            if (key === 'shape') {   // fill the newly active fields from the defaults, drop the inactive ones
                const d = ELEMENT_TYPES[it.t].defaults;
                for (const f of ELEMENT_TYPES[it.t].fields) {
                    const on = !f.when || Object.entries(f.when).every(([k, v]) => it[k] === v);
                    if (on && it[f.key] === undefined) it[f.key] = d[f.key];
                    if (!on) delete it[f.key];
                }
                renderChain();
            }
        } else {
            it[key] = t.value;
        }
        const desc = card.querySelector(':scope > .cl-card-head [data-desc]');
        if (desc && it.t !== 'parallel') desc.textContent = describeItem(it, fmtLen, fmtSpeed);
        schedule(); changed();
    }
    el.chain.addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-act]');
        if (!b || b.disabled) return;
        const card = b.closest('[data-path]'), path = card.dataset.path, act = b.dataset.act;
        let next = model.items, focus = null;
        const p = parsePath(path);
        if (act === 'up' || act === 'down') {
            const dir = act === 'up' ? -1 : 1;
            next = moveItem(model.items, path, dir);
            focus = p.b === undefined ? String(p.i + dir) : `${p.i}.${p.b}.${p.j + dir}`;
        } else if (act === 'dup') {
            next = duplicateItem(model.items, path);
            focus = p.b === undefined ? String(p.i + 1) : `${p.i}.${p.b}.${p.j + 1}`;
        } else if (act === 'del') {
            next = removeItem(model.items, path);
        } else if (act === 'branchadd') {
            const sel = b.closest('.cl-branch-actions') && b.closest('.cl-branch-actions').querySelector('select.cl-branch-add');
            if (sel) addToBranchFrom(sel);
            return;
        } else if (act === 'addbranch') {
            next = addBranch(model.items, p.i);
        } else if (act === 'rmbranch') {
            next = removeBranch(model.items, p.i, Number(b.dataset.branch));
        }
        if (next === model.items) return;
        model.items = next;
        renderChain(); schedule(0); changed();
        if (focus) {
            const btn = root.querySelector(`#cl-card-${pid(focus)} button[data-act="${act}"]`);
            if (btn && !btn.disabled) btn.focus(); else focusCard(focus);
        } else if (act === 'del') el.add.focus();
    });

    // -------------------------------------------------------------- recompute
    function schedule(ms = 100) {
        clearTimeout(timer);
        timer = setTimeout(recompute, ms);
    }

    function clearErrors() {
        root.querySelectorAll('[aria-invalid="true"]').forEach((n) => n.removeAttribute('aria-invalid'));
        root.querySelectorAll('.cl-ferr').forEach((n) => { n.hidden = true; n.textContent = ''; });
    }

    function showErrors(errors) {
        const msgs = [];
        let paused = false;
        for (const e of errors) {
            if (e.path === 'gas') { paused = true; continue; }
            let input = null, holder = null;
            if (e.path === 'bc') { input = root.querySelector(`#cl-${e.field === 'p1' ? 'p1' : 'p0'}`); holder = root.querySelector(`#cl-${e.field === 'p1' ? 'p1' : 'p0'}-err`); }
            else if (e.path === 'range') { input = el.pMin; }
            else if (e.path !== '') {
                const card = root.querySelector(`#cl-card-${pid(e.path)}`);
                if (card) {
                    input = e.field ? card.querySelector(`[data-key="${e.field}"]`) : null;
                    holder = input ? root.querySelector(`#${input.id}-err`) : card.querySelector(':scope > [data-cerr]');
                }
            }
            if (input) input.setAttribute('aria-invalid', 'true');
            if (holder && !holder.textContent) { holder.textContent = e.message; holder.hidden = false; }
            const where = /^\d/.test(e.path) ? `Element ${num1(e.path)}: ` : '';
            const text = e.path === 'bc' && e.field === 'p1' && /below/.test(e.message) ? 'p₂ must be below p₁.' : e.message;
            if (holder && holder.textContent === e.message) holder.textContent = text;
            msgs.push(where + text);
        }
        if (paused) msgs.unshift('Paused: fix the gas data above.');
        el.error.textContent = msgs.slice(0, 3).join(' ') + (msgs.length > 3 ? ` (${msgs.length - 3} more)` : '');
        el.error.classList.add('show');
        el.results.classList.add('cl-stale');
        root.querySelectorAll('.cl-dep').forEach((n) => n.classList.add('cl-stale'));
    }

    function recompute() {
        clearTimeout(timer);
        const m = fullModel(), a = analyze(m);
        clearErrors();
        if (!a.ok) { showErrors(a.errors); updateMcButton(); return; }
        let op = null, C = null;
        try {
            op = sweep(m, m.bc.mode === 'dp' ? 'dp' : 'Seff');
            C = sweep(m, 'C');
        } catch (err) {
            showErrors([{ path: '', field: null, message: err.message }]);
            return;
        }
        el.error.classList.remove('show');
        el.error.textContent = '';
        el.results.classList.remove('cl-stale');
        root.querySelectorAll('.cl-dep').forEach((n) => n.classList.remove('cl-stale'));
        good = { model: clone(m), analysis: a, sw: { op, C }, key: keyOf(m) };
        if (mc) mc.stale = mc.key !== good.key;
        renderResults();
    }

    function renderResults() {
        if (!good) return;
        const a = good.analysis;
        renderRows(a);
        renderChecks(a);
        updateCardNotes(a);
        renderSchematicPanel();
        renderTable(a);
        renderPlots();
        renderMc();
        updateMcButton();
    }

    // -------------------------------------------------------------- results panel
    function setRow(id, label, value, note = '') {
        const row = root.querySelector('#' + id);
        if (!row) return;
        if (value === null) { row.hidden = true; return; }
        row.querySelector('.result-label').innerHTML = label;
        const v = row.querySelector('.result-value');
        if (typeof value === 'object') v.innerHTML = value.html; else v.textContent = value;
        const n = row.querySelector('.result-note');
        if (n) { n.textContent = note; n.hidden = !note; }
        row.hidden = false;
    }

    function renderRows(a) {
        const pump = a.bc.mode === 'pump', ci = controllingIndex(a);
        const noConv = !a.converged;
        const v = (dim, x, o) => (noConv ? 'Did not converge at this pressure' : fmt(dim, x, o));
        if (pump) {
            const pumpOnly = a.elements.length === 0;
            setRow('cl-r-primary', 'Effective pumping speed <span class="sym">S<sub>eff</sub></span>', v('speed', a.Seff),
                noConv || !a.pump ? '' : `(${fmtPct(a.pump.fraction)} of the pump's speed)`);
            setRow('cl-r-cline', 'Line conductance at this pressure <span class="sym">C = Q/(p₀ − p<sub>pump</sub>)</span>', pumpOnly ? 'pump on the chamber' : v('speed', a.Cline));
            setRow('cl-r-cmol', 'Molecular-flow line conductance <span class="sym">C<sub>mol</sub></span>', pumpOnly ? 'pump on the chamber' : fmt('speed', a.mol.Cline), pumpOnly ? '' : a.mol.band.note);
            setRow('cl-r-smol', 'Molecular-flow <span class="sym">S<sub>eff</sub></span>', fmt('speed', a.mol.Seff));
            setRow('cl-r-q', 'Throughput <span class="sym">Q</span>', v('pv', a.Q));
            setRow('cl-r-pn', 'Pressure at the pump inlet <span class="sym">p<sub>N</sub></span>', v('pressure', a.pN));
        } else {
            setRow('cl-r-primary', 'Throughput <span class="sym">Q</span>', v('pv', a.Q));
            setRow('cl-r-cline', 'Line conductance at this pressure <span class="sym">C = Q/(p₁ − p₂)</span>', v('speed', a.Cline));
            setRow('cl-r-cmol', 'Molecular-flow line conductance <span class="sym">C<sub>mol</sub></span>', fmt('speed', a.mol.Cline), a.mol.band.note);
            setRow('cl-r-smol', '', null);
            setRow('cl-r-q', '', null);
            setRow('cl-r-pn', '', null);
        }
        const cls = a.regime === 'transitional' ? 'badge badge-warn' : 'badge';
        const word = a.regime.charAt(0).toUpperCase() + a.regime.slice(1);
        let note = ci >= 0 ? `Set by element ${num1(a.elements[ci].path)} (Kn = ${fmtNum(a.elements[ci].Kn, 3)}).` : '';
        if (ci >= 0 && a.elements[ci].Kn > 0.5 && Number.isFinite(a.Cline) && a.mol.Cline > 0 && a.converged) {
            const dev = a.Cline / a.mol.Cline - 1;   // rarefaction effects already show above Kn = 0.5
            if (Math.abs(dev) > 0.02) note += ` The line conductance is ${fmtNum(Math.abs(dev) * 100, 2)} % ${dev > 0 ? 'above' : 'below'} its molecular value.`;
        }
        setRow('cl-r-regime', 'Flow regime', { html: `<span class="${cls}">${esc(word)}</span>` }, note);
        if (el.regimeBadge) { el.regimeBadge.className = cls; el.regimeBadge.textContent = word; el.regimeBadge.hidden = false; }
        if ((a.mol.band.hi > 0.15 || a.mol.band.lo < -0.15) && !/Monte Carlo check/.test(a.mol.band.note)) {
            const row = root.querySelector('#cl-r-cmol .result-note');
            if (row) row.textContent = a.mol.band.note + ' The band is wide: run the Monte Carlo check below.';
        }
    }

    function renderChecks(a) {
        const list = checksFor(a, { fmtP });
        el.checks.innerHTML = list.length
            ? list.map((c) => `<li class="${c.level}"><span class="ic" aria-hidden="true">${ICON[c.level]}</span><span><span class="visually-hidden">${LEVEL_WORD[c.level]}: </span><b>${esc(c.title)}.</b> ${esc(c.text)}</span></li>`).join('')
            : `<li class="ok"><span class="ic" aria-hidden="true">${ICON.ok}</span><span>No warnings at this operating point.</span></li>`;
    }

    function updateCardNotes(a) {
        const cover = new Map();
        a.elements.forEach((e) => {
            const parts = String(e.path).split('.');
            const idx = e.mergedFrom && e.mergedFrom.length > 1 ? e.mergedFrom : null;
            if (idx) idx.forEach((j, k) => cover.set(parts.length === 1 ? String(j) : `${parts[0]}.${parts[1]}.${j}`, k < idx.length - 1 ? 'next' : 'prev'));
        });
        root.querySelectorAll('.cl-card[data-path]').forEach((card) => {
            const path = card.dataset.path, it = itemAt(path), note = card.querySelector(':scope > [data-note]');
            if (!it || !note) return;
            let text = '';
            const m = cover.get(path);
            if (m) text = m === 'next' ? 'Merged with the next element for the calculation.' : 'Merged with the previous element for the calculation.';
            if (it.t === 'bbox') {
                const e = a.elements.find((x) => x.path === path);
                if (e && Number.isFinite(e.Leq)) text = `Equivalent tube length ${fmt('length', e.Leq)} (same molecular conductance as the datasheet value).`;
            }
            if (it.t === 'pump' && Number.isFinite(it.d) && it.d > 0) {
                text = `Maximum for this bore: ${fmt('speed', Math.PI * it.d * it.d / 4 * a.gas.vbar / 4)} (molecular orifice limit).`;
            }
            note.textContent = text;
            note.hidden = !text;
            card.classList.toggle('cl-merged', !!m);
        });
    }

    // -------------------------------------------------------------- schematic
    const schSeg = (name) => root.querySelectorAll(`input[name="${name}"]`);
    schSeg('cl-sch-mode').forEach((r) => r.addEventListener('change', () => { if (r.checked) { schMode = r.value; renderSchematicPanel(); } }));
    schSeg('cl-sch-basis').forEach((r) => r.addEventListener('change', () => { if (r.checked) { schBasis = r.value; renderSchematicPanel(); } }));
    if (el.legend) {
        el.legend.innerHTML = '<span class="cl-sch-legend-t">Share of the total resistance:</span>' + SHARE_LEGEND.map((t, k) =>
            `<span class="cl-sch-legend-i"><span class="cl-sch-swatch" style="background: color-mix(in srgb, var(--c2) ${SHARE_MIX[k]}%, var(--surface))"></span>${esc(t)}</span>`).join('');
    }

    function renderSchematicPanel() {
        if (!good) return;
        const items = good.model.items, mode = schMode || defaultMode(items);
        schSeg('cl-sch-mode').forEach((r) => { r.checked = r.value === mode; });
        schSeg('cl-sch-basis').forEach((r) => { r.checked = r.value === schBasis; });
        const r = renderSchematic(good.analysis, { items, mode, basis: schBasis, fmtLen, fmtP, fmtSpeed });
        el.sch.innerHTML = r.svg;
        if (activePath) highlight(activePath, false);
    }
    function highlight(path, scroll) {
        activePath = path;
        el.sch.querySelectorAll('.cl-sch-el').forEach((g) => g.classList.toggle('is-active', g.dataset.path === path));
        el.table.querySelectorAll('tr[data-path]').forEach((tr) => tr.classList.toggle('is-active', tr.dataset.path === path));
        if (scroll) focusCard(path);
    }
    el.sch.addEventListener('click', (ev) => { const g = ev.target.closest('.cl-sch-el'); if (g) highlight(g.dataset.path, true); });
    el.sch.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const g = ev.target.closest('.cl-sch-el');
        if (g) { ev.preventDefault(); highlight(g.dataset.path, true); }
    });

    // -------------------------------------------------------------- element table
    // merged item of each compiled element, by path (the table describes what was calculated)
    function mergedItems(items) {
        const map = new Map();
        const add = (list, pathOf) => { for (const { item, paths } of mergeItems(list)) map.set(pathOf(paths[0]), item); };
        add(items, String);
        items.forEach((it, i) => { if (it && it.t === 'parallel') it.branches.forEach((br, b) => add(br, (j) => `${i}.${b}.${j}`)); });
        return map;
    }
    function renderTable(a) {
        const merged = mergedItems(good.model.items), su = units().su, pu = units().pu;
        const spd = (x) => fmtNum(fromSI('speed', su, x), 4), prs = (x) => fmtNum(fromSI('pressure', pu, x), 3);
        const rows = a.elements.map((e) => {
            const parts = e.path.split('.'), branch = parts.length > 1;
            const flagged = (e.flags || []).some((f) => FLAG_INFO[f] && FLAG_INFO[f].level !== 'ok') || e.regime === 'transitional';
            const label = (branch ? `<span class="cl-branch-tag">Branch ${Number(parts[1]) + 1}</span> ` : '') + esc(describeItem(merged.get(e.path) || itemAt(e.path) || { t: e.t }, fmtLen, fmtSpeed))
                + (e.mergedFrom && e.mergedFrom.length > 1 ? ` <span class="cl-branch-tag">(${e.mergedFrom.length} merged)</span>` : '');
            const words = noteWords(e).join(', ');
            return `<tr data-path="${e.path}" class="${branch ? 'cl-indent' : ''}" tabindex="0">`
                + `<th scope="row">${flagged ? '<span class="cl-flag" title="See the checks">!</span>' : ''}${num1(e.path)}</th><td class="cl-name">${label}</td>`
                + `<td class="num">${fmtNum(e.alpha, 4)}</td><td class="num">${spd(e.Cmol)}</td><td class="num">${e.Cop === null ? '—' : spd(e.Cop)}</td>`
                + `<td class="num">${fmtPct(e.share)}</td><td class="num">${prs(e.pIn)} → ${prs(e.pOut)}</td>`
                + `<td class="num">${fmtNum(e.Kn, 3)}</td><td class="num">${e.Re === null ? '—' : fmtNum(e.Re, 3)}</td><td class="num">${e.Ma === null ? '—' : fmtNum(e.Ma, 2)}</td>`
                + `<td>${esc(e.regime)}</td><td>${esc(words)}</td></tr>`;
        });
        if (a.pump) {
            const pp = a.pump, path = String(model.items.length - 1);
            rows.push(`<tr data-path="${path}" tabindex="0"><th scope="row">${num1(path)}</th><td class="cl-name">${esc(describeItem(itemAt(path) || { t: 'pump' }, fmtLen, fmtSpeed))}</td>`
                + `<td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">${fmtPct(pp.share)}</td>`
                + `<td class="num">${prs(pp.pIn)}</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td>pump</td>`
                + `<td>${pp.Sc > pp.S * 1.0005 ? `S<sub>c</sub> = ${esc(fmt('speed', pp.Sc))} with the entrance correction (Oatley)` : ''}</td></tr>`);
        }
        el.table.innerHTML = '<thead><tr><th scope="col">#</th><th scope="col">Element</th><th scope="col" class="num"><abbr title="Molecular transmission probability">α</abbr></th>'
            + `<th scope="col" class="num"><abbr title="Conductance alone, molecular flow">C alone</abbr> (${esc(su)})</th><th scope="col" class="num"><abbr title="Conductance in the line at the operating point">C here</abbr> (${esc(su)})</th><th scope="col" class="num"><abbr title="Share of the pressure drop">Share</abbr></th>`
            + `<th scope="col" class="num">p in → out (${esc(pu)})</th><th scope="col" class="num">Kn</th><th scope="col" class="num">Re</th><th scope="col" class="num">Mach</th>`
            + '<th scope="col">Regime</th><th scope="col">Notes</th></tr></thead><tbody>' + rows.join('') + '</tbody>';
    }
    el.table.addEventListener('click', (ev) => { const tr = ev.target.closest('tr[data-path]'); if (tr) highlight(tr.dataset.path, true); });
    el.table.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        const tr = ev.target.closest('tr[data-path]');
        if (tr) { ev.preventDefault(); highlight(tr.dataset.path, true); }
    });
    if (el.csv) el.csv.addEventListener('click', () => {
        if (!good || !window.Calc) return;
        const t = el.csv.textContent, flash = (msg) => { el.csv.textContent = msg; setTimeout(() => { el.csv.textContent = t; }, 1400); };
        Promise.resolve().then(() => window.Calc.copyText(elementsCSV(good.analysis))).then(() => flash('Copied'), () => flash('Copy failed'));
    });

    // -------------------------------------------------------------- plots
    const rangeInputs = () => {
        const pu = units().pu;
        el.pMin.value = editText(fromSI('pressure', pu, model.range.pMin));
        el.pMax.value = editText(fromSI('pressure', pu, model.range.pMax));
        root.querySelectorAll('[data-unit="pressure"]').forEach((n) => { n.textContent = pu; });
    };
    const onRange = () => {
        const pu = units().pu, a = parseInput(el.pMin.value), b = parseInput(el.pMax.value);
        model.range = { pMin: Number.isFinite(a) ? toSI('pressure', pu, a) : NaN, pMax: Number.isFinite(b) ? toSI('pressure', pu, b) : NaN };
        schedule(); changed();
    };
    el.pMin.addEventListener('input', onRange);
    el.pMax.addEventListener('input', onRange);

    function renderPlots() {
        if (!good || !window.Plot) return;
        const a = good.analysis, { op, C } = good.sw, pu = units().pu, su = units().su, pump = a.bc.mode === 'pump';
        const pos = (v) => Number.isFinite(v) && v > 0;   // both plots have log axes: only finite positive values
        const px = (arr) => Array.from(arr, (x) => fromSI('pressure', pu, x));
        const sy = (arr, ok) => Array.from(arr, (y, k) => (ok && !ok[k]) || !pos(y) ? NaN : fromSI('speed', su, y));
        const xMin = fromSI('pressure', pu, model.range.pMin), xMax = fromSI('pressure', pu, model.range.pMax);
        // vertical marks; marks closer than 4 % of the log axis share one label ("p₁ · Kn 0.5")
        const marks = (list) => {
            const span = Math.log10(xMax / xMin) || 1, out = [];
            for (const m of list.filter((v) => v && pos(v.x)).sort((u, v) => u.x - v.x)) {
                const last = out[out.length - 1];
                if (last && Math.log10(m.x / last.x) < 0.04 * span) last.label = [last.label, m.label].filter(Boolean).join(' · ');
                else out.push({ ...m });
            }
            return out;
        };
        // the two Kn lines are often less than a third of the axis apart, where their labels (anchored on opposite
        // sides of the middle) would collide: the left line then carries both ("Kn 0.5 · 0.01") and the right none
        const kn = (sw) => {
            const lo = sw.knMarks.kn05, hi = sw.knMarks.kn001;
            const close = lo !== null && hi !== null && Math.abs(Math.log10(hi / lo)) < 0.3 * Math.log10(xMax / xMin);
            return [lo !== null ? { x: fromSI('pressure', pu, lo), label: close ? 'Kn 0.5 · 0.01' : 'Kn 0.5', color: 'var(--muted)' } : null,
                hi !== null ? { x: fromSI('pressure', pu, hi), label: close ? '' : 'Kn 0.01', color: 'var(--muted)' } : null];
        };
        const r = mc && !mc.stale && mc.result;
        const mcPoint = !!(r && pos(r.value) && Array.isArray(r.ci95));
        const mcSeries = (x0) => {
            const x = [x0, x0 * 1.5].map((v) => fromSI('pressure', pu, v));
            const lo = Math.max(r.ci95[0], r.value * 1e-3), hi = Math.max(r.ci95[1], r.value);
            return [{ type: 'band', x, y: [hi, hi].map((v) => fromSI('speed', su, v)), y0: [lo, lo].map((v) => fromSI('speed', su, v)), color: 'var(--c5)', opacity: 0.35 },
                { type: 'points', x: [x[0]], y: [fromSI('speed', su, r.value)], label: 'Monte Carlo', color: 'var(--c5)', r: 4 }];
        };
        // headroom above the highest line, so the labels of the vertical marks (drawn at the top) stay clear of it
        const yTop = (series, hl) => {
            let m = 0;
            for (const sr of series) for (const v of sr.y) if (pos(v) && v > m) m = v;
            for (const h of hl) if (pos(h.y) && h.y > m) m = h.y;
            return m > 0 ? m * Math.pow(10, 0.45) : undefined;
        };
        const fmtX = (x) => fmtNum(x, 3) + ' ' + pu;
        const fmtY = (y) => fmtNum(y, 4) + ' ' + su;
        // operating curve
        const opSeries = [{ type: 'line', x: px(op.x), y: sy(op.y, op.converged), label: pump ? 'S_eff' : 'C = Q/(p₁ − p₂)', color: 'var(--c1)' }];
        if (mcPoint && pump) opSeries.push(...mcSeries(op.x[0]));
        const hl = [{ y: fromSI('speed', su, op.ymol), label: 'molecular', color: 'var(--c3)' }];
        if (pump && a.pump) hl.unshift({ y: fromSI('speed', su, a.pump.S), label: 'pump', color: 'var(--muted)' });
        const hlOp = hl.filter((h) => pos(h.y));
        el.plotOpTitle.textContent = pump ? 'Effective pumping speed vs chamber pressure' : 'Conductance vs upstream pressure (p₂/p₁ fixed)';
        window.Plot.draw(el.plotOp, {
            height: 300, x: { label: (pump ? 'Chamber pressure p₀' : 'Upstream pressure p₁') + ` (${pu})`, log: true, min: xMin, max: xMax },
            y: { label: (pump ? 'S_eff' : 'C') + ` (${su})`, log: true, max: yTop(opSeries, hlOp) }, series: opSeries, hlines: hlOp,
            vlines: marks([{ x: fromSI('pressure', pu, a.bc.p0), label: pump ? 'p₀' : 'p₁', color: 'var(--c1)' }, ...kn(op)]),
            hover: { format: (x, hits) => `p = ${fmtX(x)}` + (hits.length && hits[0].series.type === 'line' ? ` · ${pump ? 'S_eff' : 'C'} = ${fmtY(hits[0].y)}` : '') },
            ariaLabel: el.plotOpTitle.textContent,
        });
        // C against mean pressure: nothing to draw for a pump directly on the chamber (no line, C infinite)
        if (!a.elements.length || !pos(C.ymol)) {
            el.plotC.innerHTML = '<p class="hint">The pump sits directly on the chamber, so there is no line whose conductance could be plotted.</p>';
            return;
        }
        const cSeries = [{ type: 'line', x: px(C.x), y: sy(C.y, C.converged), label: 'C(p̄)', color: 'var(--c2)' }];
        if (mcPoint && !pump) cSeries.push(...mcSeries(C.x[0]));
        const hlC = [{ y: fromSI('speed', su, C.ymol), label: 'molecular', color: 'var(--c3)' }];
        window.Plot.draw(el.plotC, {
            height: 300, x: { label: `Mean pressure p̄ (${pu})`, log: true, min: xMin, max: xMax }, y: { label: `C (${su})`, log: true, max: yTop(cSeries, hlC) },
            series: cSeries, hlines: hlC, vlines: marks(kn(C)),
            hover: { format: (x, hits) => `p̄ = ${fmtX(x)}` + (hits.length && hits[0].series.type === 'line' ? ` · C = ${fmtY(hits[0].y)}` : '') },
            ariaLabel: 'Line conductance vs mean pressure (small pressure difference)',
        });
    }

    // -------------------------------------------------------------- Monte Carlo
    const MC_HINT = 'Simulates the same geometry particle by particle (exact geometry, molecular flow). Long or narrow lines take longer; see Options.';
    let busyTimer = 0;
    function updateMcButton() {
        if (running) return;
        let reason = '';
        if (!good || el.results.classList.contains('cl-stale')) reason = 'Fix the inputs first.';
        else if (planner) {
            try {
                const plan = planner.chainPlan(good.model.items, good.analysis.gas, { bc: good.model.bc });
                if (plan.unsupported) reason = plan.unsupported.join(' ');
            } catch (err) { reason = err.message; }
        }
        el.mcRun.disabled = !!reason;
        el.mcHint.textContent = reason || MC_HINT;
    }
    // the planner (chain-scene and the chain kernel, about 47 kB) loads on the first sign of interest in the box
    let plannerLoad = null;
    function loadPlanner() {
        if (!plannerLoad) {
            plannerLoad = import('../engine/chain-scene.js').then((m) => { planner = m; updateMcButton(); return m; }, (err) => {
                plannerLoad = null;
                el.mcHint.textContent = 'The simulation code could not be loaded. The formula results above still work.';
                throw err;
            });
        }
        return plannerLoad;
    }
    if (el.mcBox) for (const ev of ['pointerenter', 'focusin', 'touchstart']) el.mcBox.addEventListener(ev, () => { loadPlanner().catch(() => {}); }, { once: true, passive: true });

    function mcRowsOff() { setRow('cl-mc-r-formula', '', null); setRow('cl-mc-r-badge', '', null); }
    function renderMc() {
        const rows = el.mcResults;
        if (!mc || !mc.result) { rows.hidden = true; return; }
        rows.hidden = false;
        const r = mc.result, pump = r.kind === 'Seff', sym = pump ? 'S<sub>eff</sub>' : 'C', label = `Monte Carlo <span class="sym">${sym}</span>`;
        const stale = mc.stale ? ' Out of date; run again.' : '';
        rows.classList.toggle('cl-stale', !!mc.stale);
        const notes = ['Black boxes are simulated as their equivalent tubes; chambers and parallel junctions as ideal mixing volumes.'];
        if (mc.plan && mc.plan.notes && mc.plan.notes.length) notes.push(...mc.plan.notes);
        const n = root.querySelector('#cl-mc-note');
        if (n) n.textContent = notes.join(' ');
        const blocks = Array.isArray(r.blocks) ? r.blocks : [];
        const exact = r.reason === 'exact' || (blocks.length > 0 && blocks.every((b) => b.exact));
        if (!exact && (!Number.isFinite(r.value) || !(r.particles > 0))) {
            setRow('cl-mc-r-value', label, 'No result', (r.reason === 'time' ? 'The time limit passed before any particles were traced; run again.' : 'Stopped before any particles were traced; run again.') + stale);
            mcRowsOff();
            return;
        }
        if (!exact && !(r.value > 0)) {
            setRow('cl-mc-r-value', label, 'No particle got through',
                `Too few particles were transmitted to verify this line (0 of ${fmtNum(r.particles, 3)}): it transmits less than about 1 in ${fmtNum(r.particles, 2)}. Raise the maximum time under Options.` + stale);
            mcRowsOff();
            return;
        }
        const rhw = r.sigma > 0 && r.value > 0 ? 1.96 * r.sigma / r.value : NaN, pct = (x) => `±${fmtNum(x * 100, 2)} %`;
        const ciText = exact ? `${fmt('speed', r.value)} (exact)` : `${fmtCI(r.value, r.ci95[0], r.ci95[1], 'speed')} (95 %)`;
        const counted = `${fmtNum(r.particles / 1e6, 3)} M particles in ${fmtNum(r.ms / 1000, 2)} s.`;
        const runNote = exact ? 'A lone orifice between two large volumes is exact, so nothing needs to be simulated.'
            : mc.stopped ? `Stopped at ${pct(rhw)} (target ${pct(mc.target)}). ${counted}`
                : r.reason === 'time' ? `Reached the time limit at ${pct(rhw)} (target ${pct(mc.target)}); raise the maximum time for a tighter result. ${counted}`
                    : counted;
        setRow('cl-mc-r-value', label, ciText, runNote + stale);
        const b = bandBadge(r, mc.formula, mc.band, notes.length > 1);
        const cmp = compareText(b.diff);
        setRow('cl-mc-r-formula', 'Formula (molecular)', `${fmt('speed', mc.formula)}`, cmp ? cmp + '.' : '');
        setRow('cl-mc-r-badge', 'Formula error band', { html: `<span class="${b.cls}">${esc(b.text)}</span>` }, b.note);
    }

    // seed: blank (random) or a whole number 0 to 4294967295, as on the CAD tab
    function readSeed() {
        const t = el.mcSeed.value.trim();
        const bad = t !== '' && (!/^\d{1,10}$/.test(t) || Number(t) > 0xffffffff);
        el.mcSeed.toggleAttribute('aria-invalid', bad);
        if (bad) el.mcSeed.setAttribute('aria-invalid', 'true');
        if (el.mcSeedErr) { el.mcSeedErr.textContent = bad ? 'The seed must be a whole number from 0 to 4294967295, or blank for a random seed.' : ''; el.mcSeedErr.hidden = !bad; }
        return bad ? NaN : t === '' ? null : Number(t);
    }
    el.mcSeed.addEventListener('input', readSeed);

    async function runMc() {
        if (running || !good) return;
        const seed = readSeed();
        if (Number.isNaN(seed)) { el.mcSeed.focus(); return; }
        // everything about the simulated model is captured now: the result belongs to this model, even if it is edited
        const m = good.model, G = good.analysis.gas, a = good.analysis, key = good.key;
        if (!planner) {
            try { await loadPlanner(); } catch (_) { return; }
            if (!good || good.key !== key) { updateMcButton(); return; }
        }
        let runner;
        try { runner = await ctx.getRunner(); } catch (err) { mcFail(err); return; }
        if (runner.busy) {
            clearTimeout(busyTimer);
            el.mcRun.textContent = 'Another simulation is running (Stop it first)';
            busyTimer = setTimeout(() => { el.mcRun.textContent = 'Verify by Monte Carlo (molecular flow)'; }, 3000);
            return;
        }
        const plan = planner.chainPlan(m.items, G, { bc: m.bc });
        if (plan.unsupported) { updateMcButton(); return; }
        const target = Number(el.mcTarget.value) || 0.01, maxTime = Number(el.mcTime.value) || 20;
        const opts = { target, maxTime, onProgress: (p) => progress(p, maxTime) };
        if (seed !== null) opts.seed = seed;
        running = true;
        el.mcRun.disabled = true;
        el.mcRunning.hidden = false;
        el.mcProg.value = 0;
        el.mcStatus.textContent = 'Starting the workers…';
        try {
            const r = await runner.runChain(plan, G, opts);
            mc = { result: r, plan, key, target, stopped: !!r.stopped, stale: !good || good.key !== key,
                formula: r.kind === 'Seff' ? a.mol.Seff : a.mol.Cline, band: a.mol.band };
            el.mcStatus.textContent = r.stopped ? 'Stopped.' : r.reason === 'time' ? 'Time limit reached.' : 'Done.';
        } catch (err) {
            await mcFail(err);
        } finally {
            running = false;
            el.mcRunning.hidden = true;
            updateMcButton();
            renderMc();
            renderPlots();
        }
    }
    el.mcRun.addEventListener('click', runMc);
    el.mcStop.addEventListener('click', async () => { try { const r = await ctx.getRunner(); r.stop(); } catch (_) { /* nothing to stop */ } });

    // -------------------------------------------------------------- store and whole renders
    function renderAll(sync) {
        syncBoundary();
        renderChain();
        rangeInputs();
        if (sync) recompute(); else schedule(0);
    }
    const unsubscribe = store.subscribe((s, keys) => {
        const unitsChanged = keys.some((k) => k === 'lu' || k === 'su' || k === 'pu');
        if (unitsChanged) { renderChain(); rangeInputs(); }
        if (keys.some((k) => k === 'gas' || k === 'T' || k === 'custom' || k === 'Cd')) schedule(0);
        else if (unitsChanged && good) renderResults();
    });

    renderAll(true);

    return {
        // structuredClone keeps NaN (an unreadable field), which the JSON clone would turn into null
        getModel: () => structuredClone({ items: model.items, bc: model.bc, range: model.range }),
        setModel(m, { notice } = {}) {
            model = { items: clone(m.items), bc: clone(m.bc), range: clone(m.range || DEFAULT_RANGE) };
            pumpMemo = null; schMode = null;
            if (notice && el.notice) { el.notice.textContent = notice; el.notice.hidden = false; } else hideNotice();
            renderAll(true);
        },
        setItems(items) {
            let next = clone(items).filter((it) => it && it.t !== 'pump');
            if (model.bc.mode === 'pump') next.push(hasPump(model.items) ? model.items[model.items.length - 1] : defaultItem('pump'));
            model.items = next;
            renderAll(true);
            changed();
        },
        refresh: () => { recompute(); },
        dispose() { unsubscribe(); clearTimeout(timer); },
    };
}

