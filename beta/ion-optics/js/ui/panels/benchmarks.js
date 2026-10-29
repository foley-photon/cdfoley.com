/* ==========================================================================
   Ion optics UI: panels/benchmarks.js — the Benchmarks tab (spec §4.9)
   Runs the validation suite in this browser (one low-priority worker job
   per case, results streaming in), shows each case against its published
   or analytic reference with tolerance, typical calibrated deviation and a
   status badge with text; expanded rows list every sub-check, the setup
   details, an optional mini plot and "Open setup". Reports export as
   Markdown and JSON; the last report is kept in localStorage with its
   engine version (dimmed with "re-run" when stale). T14 adds the browser
   check "1 vs N workers": the same setup run through the worker pool must
   give the bit-identical rows (compared by digest).
   ========================================================================== */
import { BENCHMARKS, caseProject, resultDigest } from '../../engine/bench/cases.js';
import { TARGETS } from '../../engine/bench/targets.js';
import { ENGINE_VERSION } from '../../engine/version.js';
import { BENCH_STORAGE_KEY } from '../analysis-jobs.js';
import { fmtNum, dataTable, linePlot, chartBlock, download } from '../plots.js';

export const meta = { id: 'bench', title: 'Benchmarks', order: 90 };

const GROUPS = [['K', 'Kinematics and magnetics'], ['S', 'Field solutions'], ['T', 'Trajectories in solved fields'], ['L', 'Lens properties'], ['D', 'Drag and gas'], ['I', 'Devices'], ['P', 'Planned and promoted']];
/** Registry counts by kind, so the panel follows the registry instead of hard-coding them. */
const countKind = (kind) => BENCHMARKS.filter((b) => b.kind === kind).length;
const STATUS = { pass: ['Pass', 'badge-ok'], fail: ['Fail', 'badge-bad'], info: ['Info', ''], planned: ['Planned', ''], error: ['Error', 'badge-bad'], cancelled: ['Stopped', 'badge-warn'], running: ['Running…', 'badge-warn'], queued: ['Queued', ''], none: ['Not run', ''] };

/** The check with the largest |deviation|/tolerance (failed checks first). */
export function worstCheck(r) {
    let w = null, ws = -1;
    for (const c of (r && r.checks) || []) {
        const s = !c.pass ? Infinity : (c.tolKind === 'bracket' || !(c.tol > 0) ? 0 : Math.abs(c.deviation) / c.tol);
        if (s > ws) { ws = s; w = c; }
    }
    return w;
}
const tolText = (c) => (!c ? '' : c.tolKind === 'bracket' ? (Array.isArray(c.tol) ? `[${c.tol.map((v) => fmtNum(v)).join(', ')}]` : 'equal') : c.tolKind === 'digits' ? `±${fmtNum(c.tol)} (digits)` : `${c.tolKind === 'rel' ? 'rel' : 'abs'} ${fmtNum(c.tol)}`);
const valText = (v) => (typeof v === 'number' ? fmtNum(v, 8) : v === undefined || v === null ? '' : String(v));
/** Typical deviation from the calibration record of a case. */
export function typicalText(id, level = 'quick') {
    const t = TARGETS[id];
    const o = t && t.calibration && t.calibration.observed;
    if (!o) return '—';
    const other = level === 'full' ? 'quick' : 'full';
    let ent = Object.entries(o).filter(([k]) => k.toLowerCase().includes(level));
    if (!ent.length) ent = Object.entries(o).filter(([k]) => !k.toLowerCase().includes(other));
    if (!ent.length) ent = Object.entries(o);
    return ent.slice(0, 2).map(([, v]) => (Array.isArray(v) ? v.map((x) => fmtNum(x, 2)).join(' to ') : fmtNum(v, 2))).join('; ');
}
/** One-line status of a case for tables and reports. */
export function caseStatus(def, r) {
    if (def.kind === 'planned') return 'planned';
    if (!r) return 'none';
    return r.status;
}
/** Summary counts of a result list. */
export function summarise(results) {
    const gates = BENCHMARKS.filter((b) => b.kind === 'gate');
    const by = new Map(results.map((r) => [r.id, r]));
    const passed = gates.filter((b) => by.get(b.id) && by.get(b.id).status === 'pass').length;
    const failed = gates.filter((b) => by.get(b.id) && (by.get(b.id).status === 'fail' || by.get(b.id).status === 'error')).length;
    return { gates: gates.length, passed, failed, run: results.filter((r) => r.status !== 'cancelled').length, info: results.filter((r) => r.status === 'info' && !(r.details && r.details.planned)).length };
}
/** Markdown report (pure, for tests). */
export function markdownReport(results, { level, env = '', date = new Date().toISOString() } = {}) {
    const by = new Map(results.map((r) => [r.id, r]));
    const s = summarise(results);
    const lines = [`# Validation suite report`, '', `Level ${level} · engine ${ENGINE_VERSION}${env ? ` · ${env}` : ''} · run ${date}`, '', `Gates passed: ${s.passed}/${s.gates}${s.failed ? ` · failed: ${s.failed}` : ''}`, '',
        '| ID | Check | Status | Computed | Reference | Deviation | Tolerance | Time (s) |', '|---|---|---|---|---|---|---|---|'];
    const esc = (t) => String(t).replace(/\|/g, '\\|');
    for (const b of BENCHMARKS) {
        const r = by.get(b.id), w = worstCheck(r);
        lines.push(`| ${b.id} | ${esc(b.title)} | ${STATUS[caseStatus(b, r)][0]} | ${w ? esc(valText(w.value)) : ''} | ${w ? esc(valText(w.target)) : ''} | ${w ? esc(valText(w.deviation)) : ''} | ${esc(tolText(w))} | ${r ? (r.ms / 1000).toFixed(2) : ''} |`);
    }
    const failing = results.filter((r) => r.status === 'fail' || r.status === 'error');
    if (failing.length) {
        lines.push('', '## Failing checks', '');
        for (const r of failing) {
            if (r.status === 'error') lines.push(`- ${r.id}: error: ${esc(r.details && r.details.error)}`);
            for (const c of r.checks.filter((x) => !x.pass)) lines.push(`- ${r.id} ${esc(c.label)}: ${valText(c.value)} vs ${valText(c.target)} (${tolText(c)})`);
        }
    }
    lines.push('', 'References: see each case in the Benchmarks tab or help/#validation.');
    return lines.join('\n') + '\n';
}

function browserName() {
    try {
        const b = navigator.userAgentData && navigator.userAgentData.brands;
        if (b && b.length) { const x = b.find((q) => !/Not.A.Brand|Chromium/i.test(q.brand)) || b[0]; return `${x.brand} ${x.version}`; }
        const ua = navigator.userAgent;
        const m = /(Firefox|Edg|Chrome|Safari)\/(\d+)/.exec(ua);
        return m ? `${m[1] === 'Edg' ? 'Edge' : m[1]} ${m[2]}` : 'browser';
    } catch (e) { return 'browser'; }
}

export function mount(el, ctx) {
    const { h } = ctx.ui.dom;
    const quickBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Run quick' });
    const fullBtn = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Run full' });
    const stopBtn = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Stop', disabled: true });
    const mdBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Export report (Markdown)' });
    const jsonBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Export JSON' });
    const copyBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Copy summary' });
    const env = h('p', { class: 'io-note io-bench-env' });
    const sumLine = h('p', { class: 'io-bench-summary', role: 'status' });
    const stale = h('p', { class: 'io-note io-warn-text', hidden: true });
    const tbody = h('tbody');
    const table = h('table', { class: 'io-table io-bench-table' },
        h('caption', { class: 'visually-hidden', text: 'Validation cases' }),
        h('thead', null, h('tr', null, ...[['', 'exp'], ['ID', 'id'], ['Check', 'check'], ['Reference', 'ref'], ['Target', 'num'], ['Computed', 'num'], ['Deviation', 'num'], ['Tolerance', 'tol'], ['Typical', 'typ'], ['Status', 'st'], ['Time', 'time']]
            .map(([t, c]) => h('th', { scope: 'col', class: `c-${c}`, text: t, title: t === 'Typical' ? 'Typical deviation measured in the calibration' : null })))), tbody);
    el.appendChild(h('div', { class: 'io-results io-bench' },
        h('h3', { class: 'io-bench-title', text: `Validation suite: ${countKind('gate')} checks against published and analytic values, run in this browser` }),
        h('div', { class: 'io-btnrow' }, quickBtn, fullBtn, stopBtn, h('span', { class: 'io-sep' }), mdBtn, jsonBtn, copyBtn), env, sumLine, stale,
        h('div', { class: 'io-table-scroll' }, table)));

    const S = { results: new Map(), level: 'quick', running: false, runningIds: new Set(), date: null, wallMs: 0, stale: false, open: new Set(), charts: [] };
    const workers = () => (ctx.pool && ctx.pool.size ? `${ctx.pool.size} worker${ctx.pool.size === 1 ? '' : 's'}` : 'main thread');
    const envText = () => `${browserName()} · ${workers()} · engine ${ENGINE_VERSION} · ${S.date ? new Date(S.date).toLocaleString() : 'not run yet'} · level ${S.level}`;
    const envShort = () => `${browserName()} · ${workers()}`;

    // ---- stored report
    try {
        const raw = localStorage.getItem(BENCH_STORAGE_KEY);
        if (raw) {
            const rep = JSON.parse(raw);
            if (rep && Array.isArray(rep.results)) {
                for (const r of rep.results) S.results.set(r.id, r);
                S.level = rep.level || 'quick'; S.date = rep.date || null; S.wallMs = rep.wallMs || 0;
                S.stale = rep.engineVersion !== ENGINE_VERSION;
            }
        }
    } catch (e) { /* storage blocked */ }
    function save() {
        try {
            const results = [...S.results.values()];
            localStorage.setItem(BENCH_STORAGE_KEY, JSON.stringify({ level: S.level, engineVersion: ENGINE_VERSION, date: S.date, wallMs: S.wallMs, env: envText(), summary: summarise(results), results }));
        } catch (e) { /* quota or blocked: the report stays on screen */ }
    }

    function badge(st) { const [t, c] = STATUS[st] || STATUS.none; return h('span', { class: `badge ${c}`, text: t }); }
    function render() {
        for (const c of S.charts) c.destroy();
        S.charts = [];
        env.textContent = envText();
        stale.hidden = !S.stale;
        stale.textContent = S.stale ? 'These results come from an earlier engine version; re-run the suite.' : '';
        table.classList.toggle('io-dim', S.stale);
        const results = [...S.results.values()];
        const s = summarise(results);
        sumLine.textContent = results.length ? `Gates passed: ${s.passed}/${s.gates}${s.failed ? ` · failed ${s.failed}` : ''} · informational ${s.info} · planned ${countKind('planned')}${S.wallMs ? ` · ${(S.wallMs / 1000).toFixed(1)} s` : ''}${S.running ? ` · running ${S.runningIds.size} case${S.runningIds.size === 1 ? '' : 's'}…` : ''}` : 'Not run yet in this browser.';
        tbody.replaceChildren();
        for (const [g, gname] of GROUPS) {
            tbody.appendChild(h('tr', { class: 'io-bench-group' }, h('th', { scope: 'rowgroup', colspan: '11', text: `${g} · ${gname}` })));
            for (const b of BENCHMARKS.filter((x) => x.group === g)) {
                const r = S.results.get(b.id);
                const st = S.runningIds.has(b.id) ? 'running' : caseStatus(b, r);
                const w = worstCheck(r);
                const exp = h('button', { type: 'button', class: 'io-expander', 'aria-expanded': S.open.has(b.id) ? 'true' : 'false', 'aria-label': `Details of ${b.id}`, text: S.open.has(b.id) ? '▾' : '▸', disabled: b.kind === 'planned' && !r });
                exp.addEventListener('click', () => { if (S.open.has(b.id)) S.open.delete(b.id); else S.open.add(b.id); render(); });
                const refCell = h('td', { class: 'io-bench-ref' });
                if (b.reference.url) refCell.appendChild(h('a', { href: b.reference.url, target: '_blank', rel: 'noopener', text: b.reference.short || b.reference.text, title: b.reference.text }));
                else refCell.appendChild(h('span', { text: b.reference.short || b.reference.text, title: b.reference.text }));
                tbody.appendChild(h('tr', { class: `io-bench-row io-st-${st}` },
                    h('td', null, exp), h('th', { scope: 'row', text: b.id }), h('td', { text: b.title }), refCell,
                    h('td', { class: 'num', text: w ? valText(w.target) : '' }), h('td', { class: 'num', text: w ? valText(w.value) : '' }), h('td', { class: 'num', text: w ? (typeof w.deviation === 'number' ? fmtNum(w.deviation, 3) : valText(w.deviation)) : '' }),
                    h('td', { text: w ? tolText(w) : b.levels[S.level].tolerance }), h('td', { class: 'io-bench-typ', text: typicalText(b.id, S.level) }), h('td', null, badge(st)), h('td', { class: 'num', text: r ? `${(r.ms / 1000).toFixed(2)} s` : '' })));
                if (S.open.has(b.id)) tbody.appendChild(h('tr', { class: 'io-bench-detail' }, h('td', { colspan: '11' }, detail(b, r))));
            }
        }
    }
    function detail(b, r) {
        const box = h('div', { class: 'io-bench-detailbox' }, h('p', { class: 'io-note', text: b.description }),
            h('p', { class: 'io-note', text: `Set-up (${S.level}): ${b.levels[S.level].setup}; tolerance: ${b.levels[S.level].tolerance}. Reference: ${b.reference.text}.` }));
        if (r && r.checks && r.checks.length) box.appendChild(dataTable({ columns: ['Check', 'Computed', 'Reference', 'Deviation', 'Tolerance', 'Status'], rows: r.checks.map((c) => [c.label, valText(c.value), valText(c.target), valText(c.deviation), tolText(c), c.pass ? 'pass' : 'fail']), caption: `${b.id} checks` }));
        if (r && r.details) {
            if (r.details.error) box.appendChild(h('p', { class: 'io-note io-warn-text', text: `Error: ${r.details.error}` }));
            const dl = h('dl', { class: 'io-kv' });
            for (const [k, v] of Object.entries(r.details)) {
                if (k === 'error') continue;
                let t = typeof v === 'object' ? JSON.stringify(v) : String(v);
                if (t.length > 400) t = t.slice(0, 397) + '…';
                dl.append(h('dt', { text: k }), h('dd', { text: t }));
            }
            box.appendChild(dl);
        }
        if (r && Array.isArray(r.series) && r.series.length) {
            const s = r.series[0];
            const holder = h('div');
            box.appendChild(holder);
            S.charts.push(chartBlock(holder, { title: s.label, plot: linePlot({ series: [{ label: s.label, x: s.x, y: s.y, type: 'points', line: true }], xLabel: s.xLabel || '', yLabel: s.yLabel || '' }), columns: [s.xLabel || 'x', s.yLabel || 'y'], rows: s.x.map((x, i) => [x, s.y[i]]), csvName: `${b.id}-series`, height: 160 }));
        }
        if (b.kind !== 'planned') {
            const open = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Open setup' });
            open.addEventListener('click', () => openSetup(b));
            box.appendChild(h('div', { class: 'io-btnrow' }, open));
        }
        return box;
    }
    async function openSetup(b) {
        const p = caseProject(b.id, S.level);
        if (!p) return;
        let ok = true;
        if (ctx.ui.openDialog) ok = (await ctx.ui.openDialog({ title: `Open the ${b.id} setup`, body: `“${p.meta.name}” replaces the current project; your current work moves to Recent (Project ▾ → Recent).`, actions: [{ label: 'Cancel', value: false }, { label: 'Open setup', value: true, primary: true }] })) === true;
        if (!ok) return;
        if (ctx.app && ctx.app.loadProject) ctx.app.loadProject(p, { label: `Open ${b.id} setup` });
        else ctx.store.replaceProject(p, { label: `Open ${b.id} setup` });
        if (ctx.ui.announce) ctx.ui.announce(`Opened the ${b.id} setup.`);
    }

    async function t14Workers(r) {
        // browser-only part of T14: the same setup through the pool (N workers) must reproduce the in-worker digest
        if (!r || r.status !== 'pass' || !r.details || !r.details.digest || !ctx.jobs || !ctx.jobs.withTemporaryProject || !ctx.pool) return r;
        try {
            const run = await ctx.jobs.withTemporaryProject(caseProject('T14', S.level), (tmp) => tmp.run());
            const same = resultDigest(run) === r.details.digest;
            const c = { label: `1 worker vs ${ctx.pool.size} workers (browser)`, target: 'identical', value: same ? 'identical' : 'different', unit: '', tol: null, tolKind: 'bracket', deviation: same ? 0 : 1, pass: same };
            return { ...r, checks: [...r.checks, c], status: same ? 'pass' : 'fail', details: { ...r.details, poolDigest: resultDigest(run), workers: ctx.pool.size } };
        } catch (e) { return { ...r, details: { ...r.details, poolCheck: `not run: ${e && e.message ? e.message : e}` } }; }
    }

    async function run(level) {
        if (S.running) return;
        S.running = true; S.level = level; S.stale = false;
        quickBtn.disabled = true; fullBtn.disabled = true; stopBtn.disabled = false;
        const ids = BENCHMARKS.filter((b) => b.kind !== 'planned').map((b) => b.id);
        for (const id of ids) S.results.delete(id);
        S.runningIds = new Set(ids);
        const t0 = performance.now();
        S.date = new Date().toISOString();
        render();
        const onResult = async (r0) => {
            let r = r0;
            if (r.id === 'T14') r = await t14Workers(r);
            S.runningIds.delete(r.id);
            S.results.set(r.id, r);
            S.wallMs = performance.now() - t0;
            render();
        };
        try {
            if (ctx.jobs && typeof ctx.jobs.runBenchmarks === 'function' && ctx.pool) {
                const pend = [];
                await ctx.jobs.runBenchmarks({ ids, level, onResult: (r) => { pend.push(onResult(r)); } });
                await Promise.all(pend);
            } else {
                const mod = await import('../../engine/bench/cases.js');
                for (const id of ids) {
                    if (!S.running) break;
                    await new Promise((res) => setTimeout(res, 0));
                    await onResult(await mod.runBenchmark(id, level, {}));
                }
            }
        } catch (e) {
            if (ctx.ui.toast) ctx.ui.toast(`The benchmark run failed: ${e && e.message ? e.message : e}`, { kind: 'error' });
        } finally {
            for (const id of S.runningIds) S.results.set(id, { id, level, status: 'cancelled', ms: 0, engineVersion: ENGINE_VERSION, checks: [], details: {} });
            S.runningIds.clear();
            S.running = false; S.wallMs = performance.now() - t0;
            quickBtn.disabled = false; fullBtn.disabled = false; stopBtn.disabled = true;
            save();
            render();
            const s = summarise([...S.results.values()]);
            if (ctx.ui.announce) ctx.ui.announce(`Validation suite finished: ${s.passed} of ${s.gates} gates passed.`);
        }
    }
    quickBtn.addEventListener('click', () => run('quick'));
    fullBtn.addEventListener('click', () => run('full'));
    stopBtn.addEventListener('click', () => { if (ctx.jobs && ctx.jobs.cancelBenchmarks) ctx.jobs.cancelBenchmarks(); S.running = false; });
    mdBtn.addEventListener('click', () => download(markdownReport([...S.results.values()], { level: S.level, env: envShort(), date: S.date || new Date().toISOString() }), `validation-${S.level}.md`, 'text/markdown'));
    jsonBtn.addEventListener('click', () => download(JSON.stringify({ suite: 'ion-optics-validation', level: S.level, engineVersion: ENGINE_VERSION, env: envText(), date: S.date, wallMs: S.wallMs, summary: summarise([...S.results.values()]), results: [...S.results.values()] }, null, 1), `validation-${S.level}.json`, 'application/json'));
    copyBtn.addEventListener('click', async () => {
        const s = summarise([...S.results.values()]);
        const text = `Validation suite (${S.level}): ${s.passed}/${s.gates} gates passed, ${s.info} informational, ${countKind('planned')} planned; engine ${ENGINE_VERSION}; ${browserName()}, ${workers()}; ${S.date ? S.date.slice(0, 10) : ''}.`;
        const ok = await ctx.ui.dom.copyText(text);
        if (ctx.ui.toast) ctx.ui.toast(ok ? 'Summary copied.' : 'Copy failed.', { kind: ok ? 'ok' : 'warn' });
    });
    render();
    return {
        update(evt) { if (evt && evt.type === 'show') render(); },
        destroy() { for (const c of S.charts) c.destroy(); },
    };
}
