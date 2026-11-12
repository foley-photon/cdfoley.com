// Absorption Cross-Section Atlas (beta): UI. Data: ./data/index.json (species and dataset metadata) and
// ./data/s/<n>.json (one spectrum each, loaded when it is shown). Engine: ./xsec.js.
import {
    SIGMA_UNITS, LASER_LINES, medianStep, sigmaAtT, beerLambert, nmToCm1, nmToEV, LOSCHMIDT,
    X_AXES, densityFromForm, pulseFromForm, isThinned, tableValue, formatSci, seriesKey, logFloor,
    parseNum, numError, axisText, limitsToNm, limitsFromNm, keepLabels, LINE_RANK,
} from './xsec.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const QUICK = ['O3', 'NO2', 'CH2O', 'SO2', 'H2O', 'O2', 'N2O', 'Cl2', 'HONO', 'CH3I', 'CO2', 'NH3'];
const RANGES = [['VUV', 100, 200], ['UV-C', 200, 280], ['UV-B/A', 280, 400], ['Visible', 400, 700], ['All', null, null]];
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6, #0e7490)', 'var(--c7, #a16207)', 'var(--c8, #be185d)'];
const MAX_SETS = 8;

let index = null; let byKey = new Map();
const cache = new Map();   // dataset id → [[λ, σ], …]
const inflight = new Map(); const failed = new Set();
let filter = '';   // the dataset list's filter: '' (all), 'rec' or a source key; not part of the link
const state = { k: '', on: [], x: 'nm', y: 'cm2', log: true, lines: false, min: '', max: '', lam: '248.4', fw: '', sig: '', p: '1', pu: '133.322368', T: '296', L: '10', F: '10', phi: '1', cv: '1e-17', cu: 'cm2' };

/* ── formatting ─────────────────────────────────────────────────────── */
const sci = formatSci;
const num = parseNum;   // a number read whole or not at all: "1,5" is 1.5, "1,064" and "12abc" are refused (xsec.js)
const bad = (msg) => `<p class="tc-msg tc-bad" role="alert">${esc(msg)}</p>`;
/** The first field of [[state key, label], …] whose text is not a number, as a message; '' when all are numbers or empty. */
const firstError = (fields) => { for (const [k, label] of fields) { const m = numError(state[k], label); if (m) return m; } return ''; };
function F(f) { return `<span class="xs-formula">${esc(f).replace(/([A-Za-z)\]])(\d+)/g, '$1<sub>$2</sub>')}</span>`; }
/** "Serdyuchenko et al. (2014)": first author's surname and "et al." past two authors; the title when no author is given. */
function authors(a) {
    const list = String(a || '').split(/,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
    if (!list.length) return '';
    const sur = (x) => (/et al/.test(x) ? x.replace(/\s*et al\.?/, '') : x).split(/\s+/).pop();
    if (list.length === 1) return /et al/.test(list[0]) ? `${sur(list[0])} et al.` : sur(list[0]);
    if (list.length === 2) return `${sur(list[0])} and ${sur(list[1])}`;
    return `${sur(list[0])} et al.`;
}
const refText = (r) => { if (!r) return 'unknown'; const a = authors(r.a) || r.lab || (r.t ? r.t.slice(0, 50) + (r.t.length > 50 ? '…' : '') : 'unknown'); return `${esc(a)}${r.y ? ` (${esc(r.y)})` : ''}`; };
/** The reference line under a dataset: authors and title (and journal) where the source gives them, else its citation text. */
const citeText = (r) => (r.t || r.j ? `${r.a ? `${r.a.replace(/\.$/, '')}. ` : ''}${r.t || ''}${r.j ? `${r.t ? ', ' : ''}${r.j}` : ''}` : r.c || r.a || '');
const doiLink = (r) => (r && r.doi ? ` <a href="https://doi.org/${esc(r.doi)}" target="_blank" rel="noopener">doi:${esc(r.doi)}</a>` : '');
const tText = (T) => (T == null ? 'T not given' : Array.isArray(T) ? `${T[0]}–${T[1]} K` : `${T} K`);
const srcName = (s) => (index.meta.sources[s] || { short: s }).short || s;

/* ── URL state ──────────────────────────────────────────────────────── */
function readURL() {
    const p = new URLSearchParams(location.search);
    for (const k of Object.keys(state)) if (k !== 'on' && p.has(k)) state[k] = p.get(k);
    if (p.has('on')) state.on = p.get('on').split(',').filter(Boolean).slice(0, MAX_SETS);
    state.log = p.get('log') !== '0'; state.lines = p.get('lines') === '1';
}
function writeURL() {
    const p = new URLSearchParams();
    if (state.k) p.set('k', state.k);
    if (state.on.length) p.set('on', state.on.join(','));
    for (const k of ['x', 'y', 'min', 'max', 'lam', 'fw']) if (state[k] && !(k === 'x' && state[k] === 'nm') && !(k === 'y' && state[k] === 'cm2')) p.set(k, state[k]);
    if (!state.log) p.set('log', '0'); if (state.lines) p.set('lines', '1');
    try { history.replaceState(null, '', `${location.pathname}?${p.toString()}${location.hash}`); } catch { /* sandbox */ }
}

/* ── species search ─────────────────────────────────────────────────── */
function search(q) {
    const t = q.trim().toLowerCase(); if (!t) return [];
    const scored = [];
    for (const s of index.species) {
        const f = s.f.toLowerCase(); const n = (s.n || '').toLowerCase();
        let sc = f === t ? 0 : (s.cas && s.cas === t) ? 0 : n === t ? 1 : f.startsWith(t) ? 2 : n.startsWith(t) ? 3 : n.includes(t) ? 4 : f.includes(t) ? 5 : -1;
        if (sc >= 0) scored.push([sc, -s.sets.length, s]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, 20).map((x) => x[2]);
}
function initCombo() {
    const input = $('xs-q'); const list = $('xs-list'); let items = []; let act = -1;
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); act = -1; };
    const open = () => {
        items = search(input.value);
        if (!input.value.trim()) { close(); return; }
        if (!items.length) {   // say so, instead of closing the list without a word
            list.innerHTML = `<li class="xs-l-none" aria-disabled="true">No molecule matches “${esc(input.value.trim())}”. Try a formula (SO2), a name, or a CAS number.</li>`;
            list.hidden = false; input.setAttribute('aria-expanded', 'true'); act = -1; return;
        }
        list.innerHTML = items.map((s, i) => `<li role="option" id="xs-o-${i}" aria-selected="false" data-i="${i}"><span>${F(s.f)}</span><span class="xs-l-name">${esc(s.n || '')}</span><span class="xs-l-n">${s.sets.length}</span></li>`).join('');
        list.hidden = false; input.setAttribute('aria-expanded', 'true');
    };
    const pick = (i) => { const s = items[i]; if (!s) return; close(); choose(s.k); };
    input.addEventListener('input', open);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { if (list.hidden) open(); act = Math.min(items.length - 1, act + 1); } else if (e.key === 'ArrowUp') act = Math.max(0, act - 1);
        else if (e.key === 'Enter') { if (!list.hidden) { if (items.length) pick(act >= 0 ? act : 0); e.preventDefault(); } return; } else if (e.key === 'Escape') { close(); return; } else return;
        e.preventDefault();
        if (!items.length) return;
        [...list.children].forEach((li, i) => li.setAttribute('aria-selected', i === act));
        if (act >= 0) input.setAttribute('aria-activedescendant', `xs-o-${act}`);
    });
    list.addEventListener('mousedown', (e) => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
    input.addEventListener('blur', () => setTimeout(close, 120));
}

/* ── species and datasets ───────────────────────────────────────────── */
/**
 * Datasets shown first: the newest recommendation near room temperature, then the measured spectra near room
 * temperature with the most points (the best-resolved modern data), from different papers; at most four.
 */
function defaultSets(s) {
    const room = (x) => x.T == null || (Array.isArray(x.T) ? x.T[0] <= 300 && x.T[1] >= 280 : x.T >= 280 && x.T <= 300);
    const yr = (x) => x.y || 0;
    const rec = s.sets.filter((x) => x.rec && room(x)).sort((a, b) => yr(b) - yr(a) || b.np - a.np);
    const dT = (x) => (Number.isFinite(x.T) ? Math.abs(x.T - 296) : Array.isArray(x.T) ? 0 : 5);
    // one set per paper, the one nearest 296 K; papers ranked by their best resolution
    const best = new Map();
    for (const x of s.sets) {
        if (x.rec || !room(x) || x.np < 3) continue;
        const k = `${x.ref.a}|${x.ref.y}`; const b = best.get(k);
        if (!b) best.set(k, { x, np: x.np }); else { b.np = Math.max(b.np, x.np); if (dT(x) < dT(b.x)) b.x = x; }
    }
    const meas = [...best.values()].sort((a, b) => b.np - a.np || yr(b.x) - yr(a.x)).map((b) => b.x);
    const out = []; const papers = new Set();
    const add = (x) => { const k = `${x.ref.a}|${x.ref.y}`; if (!papers.has(k)) { papers.add(k); out.push(x.id); } };
    if (rec[0]) add(rec[0]);
    for (const x of meas) { if (out.length >= 3) break; add(x); }
    for (const x of [...rec.slice(1), ...s.sets]) { if (out.length >= 3) break; add(x); }
    return out;
}
async function choose(k, keepOn = false) {
    const s = byKey.get(k); if (!s) return;
    if (k !== state.k) filter = '';
    state.k = k; $('xs-q').value = s.f;
    if (!keepOn) state.on = defaultSets(s);
    state.on = state.on.filter((id) => s.sets.some((x) => x.id === id));
    if (!state.on.length) state.on = defaultSets(s);   // a link whose on= names no dataset of this molecule
    renderSets();
    await loadSets(state.on);
    renderAll();
}
/** Fetch the spectra of these dataset IDs (one small file each) that are not loaded yet. */
async function loadSets(ids, quiet = false) {
    const s = byKey.get(state.k); if (!s) return;
    const want = ids.map((id) => s.sets.find((x) => x.id === id)).filter((x) => x && !cache.has(x.id) && !failed.has(x.id));
    if (!want.length) return;
    if (!quiet) $('xs-plot-note').textContent = 'Loading spectra…';
    await Promise.all(want.map((x) => {
        if (!inflight.has(x.id)) {
            inflight.set(x.id, fetch(`./data/s/${x.f}.json`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
                .then((d) => cache.set(x.id, d)).catch((err) => { failed.add(x.id); $('xs-plot-note').textContent = `Could not load a spectrum (${err.message}).`; })
                .finally(() => inflight.delete(x.id)));
        }
        return inflight.get(x.id);
    }));
}
const WIDE = window.matchMedia('(min-width: 1024px)');
/** Fade and shadow cues on the dataset list while it has more rows above or below the visible part. */
function shadeSets() {
    const sc = $('xs-sets').querySelector('.xs-sets-scroll'); if (!sc) return;
    sc.classList.toggle('xs-at-top', sc.scrollTop < 2);
    sc.classList.toggle('xs-at-end', sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2);
}
$('xs-sets').addEventListener('scroll', shadeSets, true);
WIDE.addEventListener('change', () => { const d = $('xs-sets').querySelector('.xs-sets-fold'); if (d && WIDE.matches) d.open = true; shadeSets(); });
let resizeT; addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (state.k) renderPlot(); }, 150); });   // the chart's height cap depends on the viewport (plot.js alone redraws for the width)
function renderSets() {
    const s = byKey.get(state.k); const root = $('xs-sets');
    if (!s) { root.innerHTML = ''; return; }
    // The list is re-rendered on every tick: keep the fold's state (open on wide screens until the reader closes it) and its scroll position.
    const prev = root.querySelector('.xs-sets-fold'); const open = prev ? prev.open : WIDE.matches;
    const prevScroll = root.querySelector('.xs-sets-scroll'); const top = prevScroll && root.dataset.k === state.k ? prevScroll.scrollTop : 0;   // a new molecule starts at the top
    const had = root.contains(document.activeElement) ? document.activeElement.dataset : {};   // the checkbox or filter chip that had focus is rebuilt below
    const fid = had.set; const ffid = had.filter;
    $('xs-count').textContent = `${s.f}: ${s.sets.length} dataset${s.sets.length === 1 ? '' : 's'}`;
    // the filter chips: all, the recommended ones, and each source this molecule has data from (only when there is a choice)
    const nBy = new Map(); for (const x of s.sets) nBy.set(x.src, (nBy.get(x.src) || 0) + 1);
    const nRec = s.sets.filter((x) => x.rec).length;
    const chips = [['', 'All', s.sets.length], ...(nRec && nRec < s.sets.length ? [['rec', 'Recommended', nRec]] : []), ...(nBy.size > 1 ? [...nBy].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, srcName(k), n]) : [])];
    if (!chips.some((c) => c[0] === filter)) filter = '';
    const match = (x) => !filter || (filter === 'rec' ? !!x.rec : x.src === filter);
    const sets = s.sets.filter((x) => match(x) || state.on.includes(x.id)).sort((a, b) => (b.rec - a.rec) || (a.l[0] - b.l[0]) || ((b.y || 0) - (a.y || 0)));
    const extra = filter ? sets.filter((x) => !match(x)).length : 0;
    const chipRow = chips.length > 1 ? `<div class="xs-quick xs-filter" role="group" aria-label="Filter the dataset list">${chips.map(([k, l, n]) => `<button type="button" data-filter="${esc(k)}" aria-pressed="${k === filter}">${esc(l)} <span class="tc-state">${n}</span></button>`).join('')}</div>${filter ? `<p class="hint xs-filter-note">${sets.length - extra} of ${s.sets.length} datasets listed${extra ? `, and the ${extra} shown on the plot from outside this filter` : ''}.</p>` : ''}` : '';
    root.innerHTML = `<div class="xs-sp-head"><h3>${esc(s.n || s.f)} ${F(s.f)}</h3>${s.cas ? `<span class="tc-state">CAS ${esc(s.cas)}</span>` : ''}</div>
    <details class="xs-sets-fold"${open ? ' open' : ''}><summary>Datasets <span class="xs-sets-n">(${state.on.length} shown of ${s.sets.length})</span></summary>
    ${chipRow}<div class="xs-sets-scroll"><table class="tc-table xs-sets"><thead><tr><th>Show</th><th>Reference</th><th class="num">T</th><th class="num">λ range, nm</th><th class="num">Points</th><th>Source</th></tr></thead><tbody>
    ${sets.map((x) => { const on = state.on.includes(x.id); const ci = state.on.indexOf(x.id); return `<tr><td><label class="xs-chk"><input type="checkbox" data-set="${esc(x.id)}" aria-label="Show ${refText(x.ref)}, ${esc(tText(x.T))}"${on ? ' checked' : ''}${!on && state.on.length >= MAX_SETS ? ' disabled' : ''}><span class="xs-swatch" style="${on ? `background:${COLORS[ci % COLORS.length]}` : ''}"></span></label></td><td>${refText(x.ref)}${x.rec ? ' <span class="tc-tag xs-rec">recommended</span>' : ''}${x.ul ? ' <span class="tc-tag">upper limits</span>' : ''}${x.ref && citeText(x.ref) ? `<br><span class="tc-state xs-cite">${esc(citeText(x.ref))}</span>` : ''}${doiLink(x.ref)}${x.res ? `<br><span class="tc-state">resolution ${esc(x.res)}</span>` : ''}${x.note ? `<details class="xs-note"><summary>note</summary>${esc(x.note)}</details>` : ''}</td><td class="num xs-c-T">${esc(tText(x.T))}</td><td class="num xs-c-l">${x.l[0] === x.l[1] ? x.l[0] : `${x.l[0]}–${x.l[1]}`}</td><td class="num xs-c-n">${x.np}${x.n0 > x.np ? `<br><span class="tc-state">of ${x.n0}</span>` : ''}</td><td class="tc-state xs-c-s">${esc(srcName(x.src))}${x.med && x.med !== 'unknown' ? `<br><span class="xs-med">${esc(x.med)} λ</span>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div><p class="hint">Up to ${MAX_SETS} datasets at once. “Recommended” marks the dataset an evaluation (NASA JPL or IUPAC) recommended in the source's version. Cite the original paper for any value you use.</p></details>`;
    root.dataset.k = state.k;
    const sc = root.querySelector('.xs-sets-scroll'); if (sc && top) sc.scrollTop = top;
    if (fid) root.querySelector(`input[data-set="${CSS.escape(fid)}"]`)?.focus({ preventScroll: true });
    else if (ffid != null) root.querySelector(`button[data-filter="${CSS.escape(ffid)}"]`)?.focus({ preventScroll: true });
    shadeSets();
}
document.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]'); if (!b) return;
    filter = b.dataset.filter; renderSets();
});
document.addEventListener('change', (e) => {
    const c = e.target.closest('input[data-set]'); if (!c) return;
    const id = c.dataset.set;
    if (c.checked) { if (!state.on.includes(id) && state.on.length < MAX_SETS) state.on.push(id); } else state.on = state.on.filter((x) => x !== id);
    renderSets(); loadSets(state.on).then(renderAll);
});

/* ── plot ───────────────────────────────────────────────────────────── */
function activeSets() {
    const s = byKey.get(state.k);
    if (!s) return [];
    const sets = state.on.map((id, i) => ({ meta: s.sets.find((x) => x.id === id), data: cache.get(id), color: COLORS[i % COLORS.length] })).filter((x) => x.meta && x.data);
    // Two shown datasets with the same reference and temperature (one evaluation's files for two ranges, or the same
    // table through two sources) are told apart by their range, and by their source if that is the same too.
    const base = (m) => `${refText(m.ref)} ${tText(m.T)}`; const range = (m) => (m.l[0] === m.l[1] ? `${m.l[0]} nm` : `${m.l[0]}–${m.l[1]} nm`);
    const count = (f, v) => sets.filter((x) => f(x.meta) === v).length;
    for (const x of sets) {
        const m = x.meta; const withRange = `${base(m)}|${range(m)}`;
        x.more = count(base, base(m)) < 2 ? '' : count((y) => `${base(y)}|${range(y)}`, withRange) < 2 ? range(m) : `${range(m)}, ${srcName(m.src)}`;
    }
    return sets;
}
function renderPlot() {
    const el = $('xs-plot'); const sets = activeSets();
    if (!sets.length || !window.Plot) { if (window.Plot) Plot.clear(el); $('xs-plot-note').textContent = state.k ? 'Pick at least one dataset.' : 'Pick a molecule.'; return; }
    const lo = num(state.min); const hi = num(state.max);
    const conv = (X_AXES[state.x] || X_AXES.nm).of; const yu = SIGMA_UNITS[state.y];
    const inRange = sets.map((s) => s.data.filter(([l, v]) => (lo == null || l >= lo) && (hi == null || l <= hi) && (!state.log || v > 0)));
    // some modeled spectra run down to 10⁻³⁰⁰ cm² in their band wings: on a log axis those points are left as gaps
    const floor = state.log ? logFloor(inRange) : 0; let hidden = 0;
    const series = sets.map((s, i) => {
        const pts = inRange[i];
        const y = pts.map((p) => { if (p[1] < floor) { hidden++; return NaN; } return yu.to(p[1]); });
        return { type: pts.length < 3 ? 'points' : 'line', x: pts.map((p) => conv(p[0])), y, color: s.color, label: `${refText(s.meta.ref)} ${tText(s.meta.T)}${s.more ? `, ${s.more}` : ''}`.replace(/<[^>]+>/g, '') };
    }).filter((s) => s.y.some(Number.isFinite));
    const limErr = numError($('xs-min').value, 'From') || numError($('xs-max').value, 'To');
    if (!series.length) { Plot.clear(el); $('xs-plot-note').textContent = `${limErr ? `${limErr} ` : ''}No data in this range.`; return; }
    // Line labels are in the unit of the axis (4.991 eV, not 248.4, on the photon-energy axis). Where the lines crowd
    // (thirteen of them between 2 and 10 eV), a label within the width of one already kept is left out; the line stays.
    const unit = (X_AXES[state.x] || X_AXES.nm).unit; const lineText = (nm) => (state.x === 'nm' ? String(nm) : `${axisText(state.x, nm)} ${unit}`);
    const xsAll = series.flatMap((q) => q.x.filter((v, i) => Number.isFinite(q.y[i]))); const xa = Math.min(...xsAll); const xb = Math.max(...xsAll);
    const inPlot = (nm) => (lo == null || nm >= lo) && (hi == null || nm <= hi) && conv(nm) >= xa && conv(nm) <= xb;
    const lam = num(state.lam);
    const vlines = state.lines ? LASER_LINES.filter((L) => inPlot(L.nm) && L.nm !== lam).map((L) => ({ x: conv(L.nm), label: lineText(L.nm), color: 'var(--muted)', rank: LINE_RANK.indexOf(L.nm) })) : [];   // the reader's own line, drawn next, stands for a preset at the same wavelength
    if (lam > 0 && inPlot(lam)) vlines.push({ x: conv(lam), label: state.x === 'nm' ? `${lam} nm` : lineText(lam), color: 'var(--accent)', keep: true });
    const plotW = Math.max(160, (el.clientWidth || 640) - 80);   // the drawn width, near enough to tell which labels would pile up
    const keep = keepLabels(vlines.map((v) => ({ px: xb > xa ? ((v.x - xa) / (xb - xa)) * plotW : 0, w: 7.2 * v.label.length + 12, keep: !!v.keep, rank: v.rank })));
    const dropped = keep.filter((k) => !k).length;
    vlines.forEach((v, i) => { if (!keep[i]) v.label = ''; });
    const draw = (hMax) => Plot.draw(el, {
        height: Math.floor(hMax / 1.3),   // plot.js draws the chart min(1.3 × height, max(230, 0.42 × width)) px tall
        x: { label: (X_AXES[state.x] || X_AXES.nm).label },
        y: { label: yu.label, log: state.log },
        series, vlines, includeLines: false,
        hover: { format: (x, hits) => `${state.x === 'nm' ? `${x.toFixed(2)} nm` : state.x === 'cm1' ? `${x.toFixed(0)} cm⁻¹` : `${x.toFixed(3)} eV`}${hits.map((h) => ` · ${h.series.label}: ${h.y.toExponential(3)}`).join('')}` },
    });
    draw(380);
    const steps = sets.map((s) => medianStep(s.data)).filter(Boolean);
    $('xs-plot-note').textContent = `${limErr ? `${limErr} ` : ''}${series.length} dataset${series.length === 1 ? '' : 's'}${steps.length ? `; tabulated spacing ${Math.min(...steps).toPrecision(2)}–${Math.max(...steps).toPrecision(2)} nm` : ''}. Spectra may be thinned for the web (at most 2 000 points each, keeping peaks; narrow windows between bands can be lost); the download gives the points as shipped.${hidden ? ` ${hidden} point${hidden === 1 ? '' : 's'} more than 12 decades below the largest value shown ${hidden === 1 ? 'is' : 'are'} left out of the log plot.` : ''}${dropped ? ` ${dropped} laser-line label${dropped === 1 ? ' is' : 's are'} left out where the lines crowd; the buttons under “At a laser line” name every line.` : ''}`;
    // Beside the picker the panel sticks below the header, so it may not be taller than the viewport leaves there (8 px kept at the
    // bottom): a chart that makes it overflow is drawn again shorter, down to the 230 px plot.js keeps. Elsewhere the panel's top is 'auto'.
    const panel = el.closest('.xs-spectrum'); const top = parseFloat(getComputedStyle(panel).top);
    if (Number.isFinite(top)) {
        const over = panel.scrollHeight + panel.offsetHeight - panel.clientHeight + top + 8 - innerHeight;   // content with borders, past the viewport
        const h = over > 0 ? el.querySelector('svg').getBoundingClientRect().height : 0;
        if (h > 230) draw(Math.max(230, h - over));
    }
}

/* ── values at a laser line ─────────────────────────────────────────── */
function renderAt() {
    const out = $('xs-at'); const sets = activeSets(); const lam = num(state.lam); const fw = num(state.fw) || 0;
    const err = firstError([['lam', 'wavelength'], ['fw', 'line width']]);
    if (err) { out.innerHTML = bad(err); return; }
    if (!lam || lam <= 0) { out.innerHTML = '<p class="tc-msg">Enter a wavelength.</p>'; return; }
    if (!sets.length) { out.innerHTML = ''; return; }
    const yu = SIGMA_UNITS[state.y]; const alt = state.y !== 'cm2';   // a second value column only when the plot's unit is not cm²
    const thinNote = (m) => `thinned to ${m.np} of ${m.n0} points for the web; check the source`;
    const rows = sets.map((s) => {
        const r = tableValue(s.meta, s.data, lam, fw);
        const warn0 = r.at != null ? `measured at ${r.at} nm only${r.sigma == null ? '' : ' (nearest value, not interpolated)'}` : r.sigma == null ? 'outside the data' : r.full ? `from the full ${s.meta.n0}-point spectrum; the plot is thinned` : fw > 0 && r.covered < 0.99 ? `line only ${(100 * r.covered).toFixed(0)} % inside the data` : r.coarse ? `data spacing ${medianStep(s.data).toPrecision(2)} nm${fw > 0 ? ' is wider than the line' : ''}: interpolated` : '';
        // a thinned spectrum can be far off between its kept points (banded or noisy regions): say so wherever a value from it is shown
        const warn = [s.meta.ul && r.sigma != null ? 'upper limit' : '', warn0, r.thinned ? thinNote(s.meta) : ''].filter(Boolean).join('; ');
        return `<tr><td class="xs-a-ref"><span class="xs-swatch" style="background:${s.color}"></span> ${refText(s.meta.ref)}${s.meta.rec ? ' <span class="tc-tag xs-rec">rec.</span>' : ''}${s.more ? ` <span class="tc-state xs-a-more">${esc(s.more)}</span>` : ''}</td><td class="num xs-a-T">${esc(tText(s.meta.T))}</td><td class="num xs-a-sig">${sci(r.sigma)}</td>${alt ? `<td class="num xs-a-alt" data-u="${esc(yu.label)}">${r.sigma != null ? sci(yu.to(r.sigma)) : ''}</td>` : ''}<td class="tc-state xs-a-note">${esc(warn)}</td><td class="xs-a-use"><button type="button" class="btn btn-ghost btn-sm" data-use="${r.sigma ?? ''}"${r.sigma == null ? ' disabled' : ''}>use ›</button></td></tr>`;
    }).join('');
    // temperature interpolation: each shown dataset's series (the same file series at other temperatures, seriesKey),
    // with the same values as the table (point value or line average, full resolution where the build stored it)
    const s = byKey.get(state.k);
    let tline = '';
    const T = num(state.T);
    if (s && T) {
        const gk = (x) => seriesKey(x.id);
        const shown = new Set(sets.map((x) => gk(x.meta)));
        const members = s.sets.filter((x) => Number.isFinite(x.T) && shown.has(gk(x)) && x.np >= 3).slice(0, 40);
        const missing = members.filter((x) => !cache.has(x.id) && !failed.has(x.id)).map((x) => x.id);
        if (missing.length) loadSets(missing, true).then(renderAt);
        const groups = new Map();
        for (const x of members) if (cache.has(x.id)) { const g = gk(x); if (!groups.has(g)) groups.set(g, []); groups.get(g).push({ T: x.T, data: cache.get(x.id), meta: x }); }
        const hits = [...groups.values()].filter((g) => g.length >= 2).map((g) => {
            let thin = false;
            const r = sigmaAtT(g, lam, T, (m) => { const v = tableValue(m.meta, m.data, lam, fw); thin ||= v.thinned; return v.sigma; });
            return { g, r, thin };
        }).filter((x) => x.r);
        if (hits.length) tline = `<p class="hint">At ${T} K (the gas temperature below), interpolated in T from the same values: ${hits.map(({ g, r, thin }) => `${refText(g[0].meta.ref)} ${sci(r.sigma)} cm² (between ${r.T0} and ${r.T1} K${thin ? '; from thinned spectra, check the source' : ''})`).join('; ')}.</p>`;
    }
    out.innerHTML = `<div class="xs-at-wrap"><table class="tc-table xs-at"><thead><tr><th>Dataset</th><th class="num">T</th><th class="num">σ, cm²</th>${alt ? `<th class="num">${esc(yu.label)}</th>` : ''}<th>Note</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint">${fw > 0 ? `Averaged over a Gaussian line of ${fw} nm FWHM.` : 'Point values, linearly interpolated (at a preset laser line, a thinned dataset gives the value of its full spectrum).'} ${lam} nm = ${nmToCm1(lam).toFixed(1)} cm⁻¹ = ${nmToEV(lam).toFixed(4)} eV. “use ›” copies σ into the absorption calculator.</p>${tline}`;
}
document.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-use]'); if (!b || !b.dataset.use) return;
    state.sig = String(+(+b.dataset.use).toPrecision(4)); $('xs-sig').value = state.sig;
    $('xs-sig-from').textContent = `From the table above at ${state.lam} nm.`; renderCalc();
});

/* ── absorption and photolysis ──────────────────────────────────────── */
function renderCalc() {
    const sig = num(state.sig); const p = num(state.p); const pu = num(state.pu); const T = num(state.T); const L = num(state.L);
    const bl = $('xs-bl'); const pp = $('xs-pp');
    const e1 = firstError([['sig', 'cross section'], ['p', 'pressure'], ['T', 'gas temperature'], ['L', 'path length']]);
    const e2 = firstError([['F', 'pulse fluence'], ['phi', 'quantum yield'], ['lam', 'wavelength']]);
    if (numError(state.sig, 'cross section')) { bl.innerHTML = bad(e1); pp.innerHTML = ''; return; }
    if (!(sig > 0)) { bl.innerHTML = '<p class="tc-msg">Enter σ, or press “use ›” in the table above.</p>'; pp.innerHTML = ''; return; }
    if (e1) bl.innerHTML = bad(e1);
    else if (p > 0 && T > 0 && L > 0) {
        const n = densityFromForm(p, pu, T); const r = beerLambert(sig, n, L);
        bl.innerHTML = `<div class="tc-results"><div class="tc-res"><h3>Number density</h3><div class="tc-big">${sci(n)}</div><div class="tc-alt">cm⁻³</div></div>
            <div class="tc-res"><h3>Optical depth <span class="xs-sym">τ</span></h3><div class="tc-big">${sci(r.tau)}</div><div class="tc-alt">absorbance (base 10) ${sci(r.A)}</div></div>
            <div class="tc-res"><h3>Transmitted</h3><div class="tc-big">${sci(100 * r.T)} %</div><div class="tc-alt">absorbed ${sci(100 * r.absorbed)} %</div></div></div>`;
    } else bl.innerHTML = '<p class="tc-msg">Enter a pressure, temperature and path length.</p>';
    const Fl = num(state.F); const phi = num(state.phi); const lam = num(state.lam);
    if (e2) pp.innerHTML = bad(e2);
    else if (Fl > 0 && lam > 0 && phi >= 0 && phi <= 1) {
        const r = pulseFromForm(sig, Fl, lam, phi);
        pp.innerHTML = `<div class="tc-results"><div class="tc-res"><h3>Photon fluence</h3><div class="tc-big">${sci(r.photons)}</div><div class="tc-alt">photons cm⁻² at ${lam} nm</div></div>
            <div class="tc-res"><h3>Fraction excited</h3><div class="tc-big">${sci(r.excited)}</div><div class="tc-alt">1 − e<sup>−σΦ</sup></div></div>
            <div class="tc-res"><h3>Fraction photolyzed</h3><div class="tc-big">${sci(r.photolyzed)}</div><div class="tc-alt">1 − e<sup>−σΦφ</sup>, φ = ${phi}</div></div>
            <div class="tc-res"><h3>Saturation fluence</h3><div class="tc-big">${sci(r.saturationmJ)}</div><div class="tc-alt">mJ cm⁻² (hν/σ)</div></div></div>
            <p class="hint">Optically thin sample, one-photon absorption, uniform fluence. For the energetics of the photolysis channels at this wavelength, see the <a href="/beta/thermochem/?tab=channels&amp;nm=${encodeURIComponent(lam)}">Thermochemistry Lab</a>.</p>`;
    } else pp.innerHTML = `<p class="tc-msg">${!(lam > 0) ? 'Enter a wavelength under “At a laser line”: the photon energy comes from it.' : 'Enter a fluence and a quantum yield between 0 and 1.'}</p>`;
}

/* ── unit converter ─────────────────────────────────────────────────── */
function renderConv() {
    const v = num(state.cv); const u = SIGMA_UNITS[state.cu];
    if (v == null || !u) { const m = numError(state.cv, 'value'); $('xs-conv').innerHTML = m ? bad(m) : '<p class="tc-msg">Enter a value.</p>'; return; }
    const s = u.from(v);
    $('xs-conv').innerHTML = `<div class="tc-table-scroll"><table class="tc-table xs-conv"><tbody>${Object.entries(SIGMA_UNITS).map(([k, x]) => `<tr><th>${esc(x.label)}</th><td class="num">${sci(x.to(s), 4)}</td></tr>`).join('')}</tbody></table></div>
    <p class="hint">Loschmidt's constant n₀ = ${sci(LOSCHMIDT, 8)} cm⁻³ (273.15 K, 1 atm).</p>`;
}

/* ── sources ────────────────────────────────────────────────────────── */
function renderSources() {
    const m = index.meta;
    $('xs-src').innerHTML = `<p>${index.species.length} molecules and ${index.species.reduce((a, s) => a + s.sets.length, 0)} datasets, built ${esc(m.built || '')}. Each dataset above is listed with the reference its source gives: the paper's authors and title where the source has them, otherwise the source's own citation text. Please cite the original paper, and the compilation it came through, for any value you use.</p>
    <ul>${Object.entries(m.sources).map(([k, s]) => `<li><strong>${esc(s.name)}</strong>${s.url ? ` (<a href="${esc(s.url)}" target="_blank" rel="noopener">source</a>)` : ''}. ${esc(s.license || '')}${s.cite ? ` Cite: ${esc(s.cite)}` : ''}</li>`).join('')}</ul>
    <p><strong>No endorsement.</strong> None of the sources above endorses this page. <strong>No warranty.</strong> The data are provided as is; check the original papers.</p>`;
}

/* ── download and share ─────────────────────────────────────────────── */
function downloadCSV() {
    const sets = activeSets(); if (!sets.length) return;
    const s = byKey.get(state.k);
    const q = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const lines = [`# ${s.n || s.f} (${s.f}) absorption cross sections, from https://cdfoley.com/beta/cross-sections/ on ${new Date().toISOString().slice(0, 10)}`,
        '# Columns: wavelength (nm, as the source gives it), sigma (cm2 molecule-1). Cite the original paper of each dataset.'];
    for (const x of sets) {
        const r = x.meta.ref || {}; const src = index.meta.sources[x.meta.src] || {};
        lines.push('#', `# Dataset: ${x.meta.id}`, `# Reference: ${(r.t || r.j || !r.c ? [r.a, r.y && `(${r.y})`, r.t, r.j, r.doi && `doi:${r.doi}`] : [r.c]).filter(Boolean).join(' ') || 'not given'}`,
            `# Temperature: ${tText(x.meta.T)}; wavelength scale: ${x.meta.med}; via ${src.name || x.meta.src} (${src.license || 'see source'})`,
            `# ${x.meta.rec ? 'Recommended by the evaluation the source follows. ' : ''}${x.meta.ul ? 'Upper limits, not measured values. ' : ''}Points as shipped on the site (${isThinned(x.meta) ? `${x.meta.np} of the source's ${x.meta.n0}, thinned` : `all ${x.meta.np}`}).`,
            'wavelength_nm,sigma_cm2,dataset', ...x.data.map(([l, v]) => `${l},${v},${q(x.meta.id)}`));
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
    a.download = `cross-sections-${state.k}.csv`; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ── render and boot ────────────────────────────────────────────────── */
/** The From and To fields and their units follow the x axis; the limits themselves are kept in nm (state.min, state.max). */
function syncLims() {
    const r = limitsFromNm(state.x, state.min, state.max); const u = (X_AXES[state.x] || X_AXES.nm).unit;
    $('xs-min').value = r.from; $('xs-max').value = r.to; $('xs-min-u').textContent = u; $('xs-max-u').textContent = u;
}
/** Mark the fields whose text is not a number (the shared stylesheet turns them red). */
function markFields() {
    for (const [id, k] of [['xs-lam', 'lam'], ['xs-fw', 'fw'], ['xs-sig', 'sig'], ['xs-p', 'p'], ['xs-T', 'T'], ['xs-L', 'L'], ['xs-F', 'F'], ['xs-phi', 'phi'], ['xs-cv', 'cv']]) $(id).setAttribute('aria-invalid', numError(state[k], k) ? 'true' : 'false');
    for (const id of ['xs-min', 'xs-max']) $(id).setAttribute('aria-invalid', numError($(id).value, id) ? 'true' : 'false');
}
function renderAll() { markFields(); renderPlot(); renderAt(); renderCalc(); renderConv(); writeURL(); }
async function boot() {
    readURL(); const hash = location.hash;
    $('xs-y').innerHTML = Object.entries(SIGMA_UNITS).map(([k, u]) => `<option value="${k}">${esc(u.label)}</option>`).join('');
    $('xs-cu').innerHTML = Object.entries(SIGMA_UNITS).map(([k, u]) => `<option value="${k}">${esc(u.label)}</option>`).join('');
    const bind = (id, k, ev = 'input', fn = renderAll) => { const el = $(id); if (el.type === 'checkbox') el.checked = !!state[k]; else el.value = state[k]; el.addEventListener(ev, () => { state[k] = el.type === 'checkbox' ? el.checked : el.value; fn(); }); };
    if (!X_AXES[state.x]) state.x = 'nm';
    bind('xs-x', 'x', 'change', () => { syncLims(); renderAll(); }); bind('xs-y', 'y', 'change'); bind('xs-log', 'log', 'change'); bind('xs-lines', 'lines', 'change');
    bind('xs-lam', 'lam'); bind('xs-fw', 'fw');
    // From and To are typed in the unit of the x axis and kept in nm
    for (const id of ['xs-min', 'xs-max']) {
        $(id).addEventListener('input', () => {
            const r = limitsToNm(state.x, $('xs-min').value, $('xs-max').value);
            const end = (id === 'xs-min') === (state.x === 'nm' || !X_AXES[state.x]) ? 'min' : 'max';   // only the end that was typed: the other keeps its exact nm value
            state[end] = r[end]; renderAll();
        });
    }
    syncLims();
    for (const [id, k] of [['xs-sig', 'sig'], ['xs-p', 'p'], ['xs-T', 'T'], ['xs-L', 'L'], ['xs-F', 'F'], ['xs-phi', 'phi']]) bind(id, k, 'input', () => { if (k === 'sig') $('xs-sig-from').textContent = ''; markFields(); renderCalc(); renderAt(); });   // a typed σ is no longer the table's
    bind('xs-pu', 'pu', 'change', renderCalc); bind('xs-cv', 'cv', 'input', () => { markFields(); renderConv(); }); bind('xs-cu', 'cu', 'change', renderConv);
    $('xs-ranges').innerHTML = RANGES.map(([l, a, b]) => `<button type="button" data-a="${a ?? ''}" data-b="${b ?? ''}">${l}${a ? ` <span class="tc-state">${a}–${b} nm</span>` : ''}</button>`).join('');
    $('xs-ranges').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.min = b.dataset.a; state.max = b.dataset.b; syncLims(); renderAll(); });
    $('xs-laser').innerHTML = LASER_LINES.map((L) => `<button type="button" data-nm="${L.nm}">${esc(L.label)}</button>`).join('');
    $('xs-laser').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.lam = b.dataset.nm; $('xs-lam').value = state.lam; renderAll(); });
    try {
        const r = await fetch('./data/index.json'); if (!r.ok) throw new Error(`HTTP ${r.status}`);
        index = await r.json();
    } catch (err) { $('xs-sets').innerHTML = `<p class="tc-msg tc-bad">Could not load the dataset index (${esc(err.message)}).</p>`; return; }
    byKey = new Map(index.species.map((s) => [s.k, s]));
    $('xs-quick').innerHTML = QUICK.map((f) => index.species.find((s) => s.f === f)).filter(Boolean).map((s) => `<button type="button" data-k="${esc(s.k)}">${F(s.f)}</button>`).join('');
    $('xs-quick').addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) choose(b.dataset.k); });
    initCombo(); renderSources();
    $('xs-csv').addEventListener('click', downloadCSV);
    $('xs-reset').addEventListener('click', () => { try { history.replaceState(null, '', location.pathname); } catch { /* sandbox */ } location.reload(); });   // the page without a query is the page as first opened
    $('xs-link').addEventListener('click', async (e) => { try { await navigator.clipboard.writeText(location.href); e.target.textContent = 'Copied'; } catch { prompt('Copy this link:', location.href); } setTimeout(() => { e.target.textContent = 'Copy link'; }, 1500); });
    const first = byKey.has(state.k) ? state.k : (index.species.find((s) => s.f === 'O3') || index.species[0]).k;
    await choose(first, byKey.has(state.k) && state.on.length > 0);
    const target = hash && /^#[\w-]+$/.test(hash) ? document.getElementById(hash.slice(1)) : null; if (target) target.scrollIntoView();   // the browser scrolled before the list and chart existed
    window.__xsec = { index: () => index, cache, state };
}
boot();
