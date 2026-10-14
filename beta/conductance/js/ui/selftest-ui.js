// Self-test tab (spec 4.6): re-runs the validation suite in the visitor's browser against published values.
// Pure helpers (case selection, text, CSV and JSON export, summary) are exported for the Node tests.

import { runCases, summarize } from '../engine/validation.js';
import { FORMULA_CASES } from '../engine/validation-formulas.js';
import { fmtCI } from './format.js';

export const GROUPS = Object.freeze([
    ['formula', 'Formula checks'],
    ['chain-mc', 'Monte Carlo: analytic geometry'],
    ['mesh-mc', 'Monte Carlo: CAD meshes'],
    ['negative', 'Negative controls (deliberately wrong methods)'],
]);
export const INTRO = 'These checks compare this tool with published values (Matuda, JPCRD, Livesey, NASA TN D-2330, CERN-2007-003, Leybold) '
    + 'and with high-precision Monte Carlo results computed while building it. Negative controls run deliberately wrong methods and must be caught.';

/** The cases of a run: 'formula' (all formula cases), 'quick' (quick Monte Carlo set) or 'full' (everything). nodeOnly cases are skipped. */
export function casesFor(kind, formulaCases, mcCases) {
    const mcOk = (mcCases || []).filter((c) => !c.nodeOnly);
    if (kind === 'formula') return formulaCases.slice();
    if (kind === 'quick') return mcOk.filter((c) => c.quick);
    return [...formulaCases, ...mcOk];
}

const num = (x, sig = 6) => (Number.isFinite(x) ? String(Number(x.toPrecision(sig))).replace(/^-/, '−').replace('e-', 'e−') : '—');
const withUnit = (s, u) => (u && s !== '—' ? `${s} ${u}` : s);

/** Reference text: "0.26524 (σ 0.00021)" when the reference has an uncertainty. */
export function refText(row) {
    const base = withUnit(num(row.ref), row.unit);
    return row.refSigma > 0 ? `${base} (σ ${num(row.refSigma, 2)})` : base;
}

/** This tool's value: Monte Carlo rows as value ± 2σ. */
export function valueText(row) {
    if (!Number.isFinite(row.value)) return '—';
    if (row.sigma > 0) return withUnit(fmtCI(row.value, row.value - 2 * row.sigma, row.value + 2 * row.sigma).replace(/ \(.*\)$/, ''), row.unit);
    return withUnit(num(row.value), row.unit);
}

/** Result word and badge class of a row. */
export function verdict(row) {
    if (row.stopped) return { text: 'stopped', cls: 'badge' };
    if (row.group === 'negative') return row.caught ? { text: 'caught', cls: 'badge badge-ok' } : { text: 'missed', cls: 'badge badge-bad' };
    return row.pass ? { text: 'PASS', cls: 'badge badge-ok' } : { text: 'FAIL', cls: 'badge badge-bad' };
}

/** "47 of 47 formula checks passed · 16 of 16 Monte Carlo checks passed · negative controls caught 3 of 3." */
// stop = { done, total } after a run that was stopped: the summary says so, because the counts alone look complete
export function summaryLine(rows, stop = null) {
    const s = summarize(rows.filter((r) => !r.stopped));
    const parts = [];
    if (s.formula[1]) parts.push(`${s.formula[0]} of ${s.formula[1]} formula checks passed`);
    if (s.mc[1]) parts.push(`${s.mc[0]} of ${s.mc[1]} Monte Carlo checks passed`);
    if (s.negative[1]) parts.push(`negative controls caught ${s.negative[0]} of ${s.negative[1]}`);
    if (stop) parts.push(`stopped after ${stop.done} of ${stop.total} checks; the checks not listed did not run`);
    return parts.length ? parts.join(' · ') + '.' : 'No checks have run yet.';
}

/** Browser name and major version from navigator data: "Microsoft Edge 141". */
export function browserName(ua = '', brands = null) {
    const known = ['Microsoft Edge', 'Google Chrome', 'Opera', 'Brave', 'Chromium'];
    if (Array.isArray(brands)) for (const k of known) { const b = brands.find((x) => x.brand === k); if (b) return `${k} ${b.version}`; }
    const pats = [[/Edg\/(\d+)/, 'Microsoft Edge'], [/OPR\/(\d+)/, 'Opera'], [/Firefox\/(\d+)/, 'Firefox'], [/Chrome\/(\d+)/, 'Chrome'], [/Version\/(\d+)[^ ]* .*Safari\//, 'Safari']];
    for (const [re, name] of pats) { const m = re.exec(ua); if (m) return `${name} ${m[1]}`; }
    return 'Unknown browser';
}

const pad = (n) => String(n).padStart(2, '0');
/** "8 workers · Microsoft Edge 141 · run 2026-10-12 14:03". */
export function deviceLine({ workers, browser, date }) {
    const d = date || new Date();
    return `${workers} worker${workers === 1 ? '' : 's'} · ${browser} · run ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** conductance-selftest-YYYYMMDD.json */
export function fileName(date = new Date()) {
    return `conductance-selftest-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.json`;
}

const csvCell = (v) => { const s = v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const CSV_HEAD = ['id', 'group', 'check', 'source', 'source_url', 'reference', 'reference_sigma', 'value', 'sigma', 'unit', 'deviation', 'tolerance', 'result', 'ms'];

/** Rows as CSV (plain numbers, so a spreadsheet can read them). */
export function toCSV(rows) {
    const lines = [CSV_HEAD];
    for (const r of rows) {
        lines.push([r.id, r.group, r.title, r.source && r.source.label, r.source && r.source.url, r.ref, r.refSigma || 0, r.value, r.sigma || 0,
            r.unit || '', r.devText, r.tolText, verdict(r).text, Number.isFinite(r.ms) ? Math.round(r.ms) : '']);
    }
    return lines.map((l) => l.map(csvCell).join(',')).join('\n') + '\n';
}

/** Rows plus the device line as pretty JSON. */
export function toJSON(rows, device, stop = null) {
    const clean = rows.map((r) => ({
        id: r.id, group: r.group, title: r.title, source: r.source, ref: r.ref, refSigma: r.refSigma || 0, value: Number.isFinite(r.value) ? r.value : null,
        sigma: r.sigma || 0, unit: r.unit || '', dev: Number.isFinite(r.dev) ? r.dev : null, devText: r.devText, tolText: r.tolText,
        pass: !!r.pass, caught: r.caught ?? null, result: verdict(r).text, ms: Number.isFinite(r.ms) ? Math.round(r.ms * 10) / 10 : null,
    }));
    return JSON.stringify({ format: 'cdfoley-conductance-selftest', version: 1, device, summary: summaryLine(rows, stop), stopped: stop, rows: clean }, null, 2) + '\n';
}

// ================================================================================================ DOM

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TEMPLATE = `
<div class="cl-selftest">
  <p class="cl-st-intro">${esc(INTRO)}</p>
  <div class="btn-row cl-st-buttons">
    <button type="button" class="btn btn-primary" data-run="formula">Run formula checks</button>
    <button type="button" class="btn btn-secondary" data-run="quick">Run Monte Carlo checks</button>
    <button type="button" class="btn btn-secondary" data-run="full">Run full suite</button>
    <button type="button" class="btn btn-ghost" data-stop hidden>Stop</button>
  </div>
  <p class="hint">Formula checks take under a second and run when this tab first opens. The quick Monte Carlo set takes about 15 s on a desktop, the full suite about 2 minutes.</p>
  <div class="cl-st-progress" hidden><progress max="1" value="0"></progress><span class="cl-st-now" aria-live="polite"></span></div>
  <p class="cl-st-summary" aria-live="polite">No checks have run yet.</p>
  <p class="hint cl-st-device"></p>
  <div class="btn-row cl-st-export">
    <button type="button" class="btn btn-ghost btn-sm" data-csv disabled>Copy as CSV</button>
    <button type="button" class="btn btn-ghost btn-sm" data-json disabled>Download JSON</button>
  </div>
  <div class="cl-table-scroll"><table class="cl-st-table">
    <caption class="visually-hidden">Validation checks and their results</caption>
    <thead><tr><th scope="col">Check</th><th scope="col">Source</th><th scope="col" class="num">Reference</th><th scope="col" class="num">This tool</th>
    <th scope="col" class="num">Deviation</th><th scope="col">Tolerance</th><th scope="col">Result</th></tr></thead>
    ${GROUPS.map(([g, label]) => `<tbody data-group="${g}" hidden><tr class="cl-st-group"><th scope="colgroup" colspan="7">${esc(label)}</th></tr></tbody>`).join('')}
  </table></div>
  <p class="hint">Monte Carlo checks use fixed seeds and particle counts, so a run is reproducible in a given browser engine. Other engines may round some functions differently and give slightly different counts; the tolerances are statistical, so they still pass. "This tool" shows Monte Carlo values as value ± 2σ.</p>
</div>`;

/**
 * Mounts the Self-test tab into root. ctx = { getRunner } (returns an McRunner or a Promise of one; created on first
 * use). Runs the formula checks at once.
 */
export function mount(root, ctx = {}) {
    root.innerHTML = TEMPLATE;
    const q = (s) => root.querySelector(s);
    const rows = new Map();
    const btns = root.querySelectorAll('[data-run]'), stopBtn = q('[data-stop]');
    const prog = q('.cl-st-progress'), bar = prog.querySelector('progress'), now = q('.cl-st-now');
    const summary = q('.cl-st-summary'), device = q('.cl-st-device'), csvBtn = q('[data-csv]'), jsonBtn = q('[data-json]');
    let busy = false, controller = null, mcCases = null, runner = null, lastDevice = null, stopInfo = null;

    const defaultWorkers = () => {
        const phone = typeof matchMedia === 'function' && matchMedia('(max-width: 860px)').matches;
        return phone ? 2 : Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    };
    const browser = () => browserName(navigator.userAgent, navigator.userAgentData && navigator.userAgentData.brands);

    function rowHTML(r) {
        const v = verdict(r), src = r.source || {}, url = src.url || '';
        const ext = /^https?:/.test(url);
        const link = url ? `<a href="${esc(url)}"${ext ? ' target="_blank" rel="noopener"' : ''}>${esc(src.label || url)}</a>` : esc(src.label || '');
        return `<tr data-id="${esc(r.id)}"><th scope="row">${esc(r.title)}</th><td class="cl-st-src">${link}</td><td class="num">${esc(refText(r))}</td>`
            + `<td class="num">${esc(valueText(r))}</td><td class="num">${esc(r.devText || '—')}</td><td>${esc(r.tolText)}</td><td><span class="${v.cls}">${esc(v.text)}</span></td></tr>`;
    }
    function show(r) {
        rows.set(r.id, r);
        const body = q(`tbody[data-group="${r.group}"]`);
        if (!body) return;
        body.hidden = false;
        const old = body.querySelector(`tr[data-id="${CSS.escape(r.id)}"]`);
        if (old) old.outerHTML = rowHTML(r); else body.insertAdjacentHTML('beforeend', rowHTML(r));
        summary.textContent = summaryLine([...rows.values()], stopInfo);
        csvBtn.disabled = jsonBtn.disabled = false;
    }
    function setBusy(on, label = '') {
        busy = on;
        btns.forEach((b) => { b.disabled = on; });
        stopBtn.hidden = !on;
        prog.hidden = !on;
        if (on) { bar.value = 0; now.textContent = label; }
    }

    async function getRunner() {
        if (runner) return runner;
        if (typeof ctx.getRunner !== 'function') throw new Error('The simulation is not available on this page.');
        runner = await ctx.getRunner();
        return runner;
    }

    async function run(kind) {
        if (busy) return;
        let mc = null;
        if (kind !== 'formula') {
            try {
                if (!mcCases) mcCases = (await import('../engine/validation-mc.js')).MC_CASES;
                mc = await getRunner();
            } catch (err) {
                summary.textContent = 'The Monte Carlo checks could not start: ' + (err && err.message ? err.message : String(err));
                return;
            }
            if (mc.busy) { summary.textContent = 'Another simulation is running (Stop it first).'; return; }
        }
        const cases = casesFor(kind, FORMULA_CASES, mcCases || []);
        controller = new AbortController();
        const signal = controller.signal;
        setBusy(true, kind === 'formula' ? 'Formula checks…' : `Check 1 of ${cases.length}…`);
        lastDevice = deviceLine({ workers: mc ? mc.workers || defaultWorkers() : defaultWorkers(), browser: browser(), date: new Date() });
        device.textContent = lastDevice;
        const ctxRun = { mc, quick: kind === 'quick' };
        let done = 0;
        stopInfo = null;
        try {
            await runCases(cases, ctxRun, (r, i) => {
                if (signal.aborted) r.stopped = true; else done++;
                show(r);
                bar.value = (i + 1) / cases.length;
                now.textContent = i + 1 < cases.length ? `Check ${i + 2} of ${cases.length}: ${cases[i + 1].title}` : 'Done.';
            }, signal);
        } finally {
            if (signal.aborted && done < cases.length) {
                stopInfo = { done, total: cases.length };
                summary.textContent = summaryLine([...rows.values()], stopInfo);
            }
            setBusy(false);
            controller = null;
        }
    }

    btns.forEach((b) => b.addEventListener('click', () => run(b.dataset.run)));
    stopBtn.addEventListener('click', () => {
        if (controller) controller.abort();
        if (runner && runner.busy) runner.stop();
    });
    csvBtn.addEventListener('click', () => {
        const text = toCSV([...rows.values()]);
        const t = csvBtn.textContent, flash = (msg) => { csvBtn.textContent = msg; setTimeout(() => { csvBtn.textContent = t; }, 1400); };
        if (window.Calc && window.Calc.copyText) Promise.resolve().then(() => window.Calc.copyText(text)).then(() => flash('Copied'), () => flash('Copy failed'));
    });
    jsonBtn.addEventListener('click', () => {
        const blob = new Blob([toJSON([...rows.values()], lastDevice, stopInfo)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName(new Date());
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    run('formula');
    return { run, rows: () => [...rows.values()], dispose() { if (controller) controller.abort(); } };
}
