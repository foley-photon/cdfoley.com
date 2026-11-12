// Absorption Cross-Section Atlas (beta): UI. Engine: ./xsec.js. Data, all under ./data/:
//   species.json    the species list (key, formula, name, CAS number, number of datasets): search works once it is in
//   sp/<key>.json   one species' datasets, loaded when the species is chosen
//   s/<n>.json      one spectrum, loaded when it is shown
//   who.json, coarse.json   "Who absorbs here?": one dataset per species at each preset line, and in 2 nm bins
// The mole fractions of the air view are constants of the engine (AIR_DRY), not data files.
//   index.json      everything in species.json and sp/ in one 2.8 MB file: read only where those are missing
import {
    SIGMA_UNITS, LASER_LINES, medianStep, sigmaAtT, beerLambert, nmToCm1, nmToEV, LOSCHMIDT,
    X_AXES, densityFromForm, pulseFromForm, isThinned, tableValue, formatSci, seriesKey, logFloor,
    parseNum, numError, axisText, limitsToNm, limitsFromNm, keepLabels, LINE_RANK,
    refLabel, AIR_GASES, lineKey, whoAtLine, whoCoarse, whoView, whoNotes, whoDoubt, tempText,
    AIR, AIR_DRY, AIR_SOURCES, AIR_ARGON, waterSaturation, airAbsorption, fractionText, pathText,
} from './xsec.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const QUICK = ['O3', 'NO2', 'CH2O', 'SO2', 'H2O', 'O2', 'N2O', 'Cl2', 'HONO', 'CH3I', 'CO2', 'NH3'];
const RANGES = [['VUV', 100, 200], ['UV-C', 200, 280], ['UV-B/A', 280, 400], ['Visible', 400, 700], ['All', null, null]];
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6, #0e7490)', 'var(--c7, #a16207)', 'var(--c8, #be185d)'];
const MAX_SETS = 8;

let meta = null; let species = []; let byKey = new Map();   // species: [{ k, f, n, cas, ns (number of datasets), file, sets (null until loaded) }]
let full = null;           // the request for index.json, made only when the split files are missing or do not fit
let early = null;          // the first molecule's file, asked for while the species list is still on its way
let who = null; let coarse = null; const whoState = { who: '', coarse: '' };   // '' not asked, 'loading', 'ok' or 'missing'
let whoAll = false; let whoFrom = ''; let whoLam = ''; let whoFocus = '';   // the long list unfolded; the molecule last loaded from the "Who absorbs here?" table, the wavelength it was loaded at, and the molecule whose button gets the focus back
const WHO_TOP = 25;
const cache = new Map();   // dataset id → [[λ, σ], …]
const inflight = new Map(); const failed = new Set();
let filter = '';   // the dataset list's filter: '' (all), 'rec' or a source key; not part of the link
const state = { k: '', on: [], x: 'nm', y: 'cm2', log: true, lines: false, min: '', max: '', lam: '248.4', fw: '', who: 'air', ws: '', rh: String(AIR.rh), sig: '', p: '1', pu: '133.322368', T: '296', L: '10', F: '10', phi: '1', cv: '1e-17', cu: 'cm2' };

/* ── formatting ─────────────────────────────────────────────────────── */
const sci = formatSci;
const num = parseNum;   // a number read whole or not at all: "1,5" is 1.5, "1,064" and "12abc" are refused (xsec.js)
const bad = (msg) => `<p class="tc-msg tc-bad" role="alert">${esc(msg)}</p>`;
/** The first field of [[state key, label], …] whose text is not a number, as a message; '' when all are numbers or empty. */
const firstError = (fields) => { for (const [k, label] of fields) { const m = numError(state[k], label); if (m) return m; } return ''; };
function F(f) { return `<span class="xs-formula">${esc(f).replace(/([A-Za-z)\]])(\d+)/g, '$1<sub>$2</sub>')}</span>`; }
/** "Serdyuchenko et al. (2014)": first author's surname and "et al." past two authors; the title when no author is given (xsec.js). */
const refText = (r) => esc(refLabel(r));
/** The reference line under a dataset: authors and title (and journal) where the source gives them, else its citation text. */
const citeText = (r) => (r.t || r.j ? `${r.a ? `${r.a.replace(/\.$/, '')}. ` : ''}${r.t || ''}${r.j ? `${r.t ? ', ' : ''}${r.j}` : ''}` : r.c || r.a || '');
const doiLink = (r) => (r && r.doi ? ` <a href="https://doi.org/${esc(r.doi)}" target="_blank" rel="noopener">doi:${esc(r.doi)}</a>` : '');
const tText = tempText;
const srcName = (s) => ((meta.sources || {})[s] || { short: s }).short || s;
const getJSON = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };

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
    if (state.who === 'all') p.set('who', 'all');
    if (state.ws === 'sig') p.set('ws', 'sig');   // the air view ordered by σ per molecule, not by absorption in air
    if (state.rh !== String(AIR.rh)) p.set('rh', state.rh);
    for (const k of ['x', 'y', 'min', 'max', 'lam', 'fw']) if (state[k] && !(k === 'x' && state[k] === 'nm') && !(k === 'y' && state[k] === 'cm2')) p.set(k, state[k]);
    if (!state.log) p.set('log', '0'); if (state.lines) p.set('lines', '1');
    try { history.replaceState(null, '', `${location.pathname}?${p.toString()}${location.hash}`); } catch { /* sandbox */ }
}

/* ── species search ─────────────────────────────────────────────────── */
function search(q) {
    const t = q.trim().toLowerCase(); if (!t) return [];
    const scored = [];
    for (const s of species) {
        const f = s.f.toLowerCase(); const n = (s.n || '').toLowerCase();
        let sc = f === t ? 0 : (s.cas && s.cas === t) ? 0 : n === t ? 1 : f.startsWith(t) ? 2 : n.startsWith(t) ? 3 : n.includes(t) ? 4 : f.includes(t) ? 5 : -1;
        if (sc >= 0) scored.push([sc, -s.ns, s]);
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
        list.innerHTML = items.map((s, i) => `<li role="option" id="xs-o-${i}" aria-selected="false" data-i="${i}"><span>${F(s.f)}</span><span class="xs-l-name">${esc(s.n || '')}</span><span class="xs-l-n">${s.ns}</span></li>`).join('');
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
/** index.json, the one file that holds every species' datasets: read once, and only when the split files fail. */
function loadFull() {
    full ||= getJSON('./data/index.json');
    return full.then((d) => {
        for (const x of d.species) { const s = byKey.get(x.k); if (s && !s.sets) { s.sets = x.sets; s.ns = x.sets.length; } }
    });
}
/** The datasets of one species: its own small file, or index.json where that file is missing or is not this species'. */
const loading = new Map();
function loadSpecies(s) {
    if (s.sets) return Promise.resolve(s);
    if (!loading.has(s.k)) {
        loading.set(s.k, (async () => {
            try {
                const d = await (early && early.file === s.file ? early.req : getJSON(`./data/sp/${encodeURIComponent(s.file)}.json`));
                if (!d || d.k !== s.k || !Array.isArray(d.sets) || !d.sets.length) throw new Error('not this molecule');
                s.sets = d.sets; s.ns = d.sets.length;
            } catch {
                await loadFull();
                if (!s.sets) throw new Error('no datasets listed');
            } finally { loading.delete(s.k); }
            return s;
        })());
    }
    return loading.get(s.k);
}
let turn = 0;
/** Show a species. keepOn keeps the datasets a link names; first is the file number of a dataset to show first ("Who absorbs here?"). */
async function choose(k, keepOn = false, first = '') {
    const s = byKey.get(k); if (!s) return;
    const mine = ++turn;
    $('xs-q').value = s.f;
    if (!s.sets) $('xs-count').textContent = `${s.f}: loading…`;
    try { await loadSpecies(s); } catch (err) {
        if (mine === turn) { $('xs-count').textContent = ''; $('xs-sets').innerHTML = bad(`Could not load the datasets of ${s.f} (${err.message}).`); }
        return;
    }
    if (mine !== turn) return;   // a later choice overtook this one
    if (k !== state.k) filter = '';
    if (!first) whoFrom = '';
    state.k = k;
    if (!keepOn) {
        state.on = defaultSets(s);
        const x = first && s.sets.find((q) => q.f === first);   // the dataset the reverse lookup ranked this molecule by comes first
        if (x) state.on = [x.id, ...state.on.filter((id) => id !== x.id)].slice(0, 4);
    }
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

/* ── who absorbs here? ──────────────────────────────────────────────── */
/** Fetch who.json (the preset lines) or coarse.json (any wavelength) once, then draw the table again. */
function loadWho(name) {
    if (whoState[name]) return;
    whoState[name] = 'loading';
    getJSON(`./data/${name}.json`).then((d) => { if (name === 'who') who = d; else coarse = d; whoState[name] = 'ok'; }, () => { whoState[name] = 'missing'; }).then(renderWho);
}
/**
 * The one line above the air table: which gas takes the light, and the 1/e length of the gases that have a value.
 * missing: the gases of the air view with no row at the wavelength (whoView).
 */
function airTakeaway(A, lam, missing = []) {
    const n = A.sum.length; const f = (r) => F(byKey.get(r.k).f);
    const list = (x) => (x.length > 1 ? `${x.slice(0, -1).join(', ')} and ${x[x.length - 1]}` : x[0]);
    // a value the other datasets do not confirm is listed, with what it would give, and stays out of the sum
    const left = A.left.map((r) => ` ${f(r)} is listed and left out of the sum (${esc(whoDoubt(r).note)}); its listed value would give α ≈ ${sci(r.alpha, 1)} m⁻¹.`).join('');
    // the three main gases of humid air: without a firm value for one of them the line is not the answer for air
    const main = ['N2', 'O2', 'H2O']; const gone = main.filter((k) => missing.includes(k)).map((k) => F(byKey.has(k) ? byKey.get(k).f : k));
    const open = gone.length > 0 || A.left.some((r) => main.includes(r.k));
    const scope = `${gone.length ? ` No table here for ${list(gone)}, so this is not the whole answer for air: the` : ' The'} sum covers only the gases with a value at this wavelength${A.limits.length ? ', leaves out the upper limits' : ''} and counts absorption only, not scattering.`;
    if (!n) return A.limits.length || A.left.length ? `<p class="xs-who-take">${A.left.length ? 'No firm value' : 'Only upper limits'} at ${lam} nm for these gases, so there is no sum for air.${left}</p>` : '';
    const a = (x) => `α ${A.rough ? '≈' : '='} ${sci(x, A.rough ? 1 : 2)} m⁻¹`;
    const len = (m) => `${A.rough ? '≈ ' : ''}${pathText(m, A.rough ? 1 : 2)}`;
    const share = (100 * A.top.alpha) / A.total;
    // a flagged value is never given as firm, and neither is a line with a main gas missing: the gas "has the largest
    // listed value", it does not "take the most light"; the line says which flag, marks every figure ≈, and gives what
    // is left without the flagged rows
    const flagged = [A.top, A.tie].filter((r) => r && r.weak); const soft = flagged.length > 0 || open;
    const lead = n === 1 ? `<strong>${f(A.top)} is the only one of these gases with a ${A.left.length ? 'firm ' : ''}value at ${lam} nm.</strong> In air it gives ${a(A.top.alpha)}, a 1/e length of ${len(A.top.L)}.`
        : A.tie ? `<strong>${f(A.top)} and ${f(A.tie)} ${soft ? 'have the largest listed values' : 'take the most light'} in air at ${lam} nm</strong>, within a factor of two of each other (α ${A.rough ? '≈' : '='} ${sci(A.top.alpha, A.rough ? 1 : 2)} and ${sci(A.tie.alpha, A.rough ? 1 : 2)} m⁻¹).`
            : `<strong>${f(A.top)} ${soft ? 'has the largest listed value' : 'takes the most light'} in air at ${lam} nm</strong>: ${a(A.top.alpha)}, ${share >= 99.5 ? 'over 99' : share.toFixed(0)} % of the listed total.`;
    const sum = n > 1 ? ` The ${n} gases ${A.left.length ? 'in the sum' : 'with a value'} add up to ${a(A.total)}, a 1/e length of ${len(A.L)}.` : '';
    const why = [A.sum.some((r) => r.approx) ? 'these are means of σ over 2 nm, not values at the line' : '',
        ...flagged.map((r) => `the ${f(r)} value is flagged (${esc(whoNotes(r).join('; '))})`),
        !flagged.length && A.weakShare >= 0.1 ? `flagged values carry ${(100 * A.weakShare).toFixed(0)} % of the sum` : ''].filter(Boolean);
    const rough = why.length ? ` Rough figures: ${why.join('; ')}.` : '';
    const firm = (flagged.length || A.weakShare >= 0.1) && A.firmTotal > 0 && n > 1 ? ` Without the flagged values the sum is α ≈ ${sci(A.firmTotal, 1)} m⁻¹, a 1/e length of ≈ ${pathText(1 / A.firmTotal, 1)}.` : '';
    return `<p class="xs-who-take">${lead}${sum}${rough}${firm}${left}${scope}</p>`;
}
/** The fold under the air table: the mole fraction of every gas of the air view, dry and at this humidity, with its source. */
function airFold(A, rh, open) {
    const w = A.water; const gases = ['N2', 'O2', 'Ar', ...AIR_GASES.filter((k) => k !== 'N2' && k !== 'O2')];
    const src = (k) => { const s = AIR_SOURCES[k]; return `${esc(s.label)}: ${esc(s.what)}`; };
    const rows = gases.map((k) => {
        if (k === 'H2O') return `<tr><td>${F('H2O')}</td><td class="num">—</td><td class="num">${fractionText(w)}</td><td class="tc-state">Relative humidity ${esc(state.rh.trim())} % at ${AIR.T} K: saturation pressure ${sci(waterSaturation(AIR.T))} Pa, from the Antoine equation of the NIST Chemistry WebBook</td></tr>`;
        if (k === 'Ar') return `<tr><td>${F('Ar')}</td><td class="num">${fractionText(AIR_ARGON)}</td><td class="num">${fractionText(AIR_ARGON * (1 - w))}</td><td class="tc-state">${src('ussa3')}. No cross sections in the five collections, so argon is never in the table</td></tr>`;
        const [x, s] = AIR_DRY[k];
        return `<tr><td>${F(byKey.has(k) ? byKey.get(k).f : k)}</td><td class="num">${fractionText(x, 3)}</td><td class="num">${fractionText(x * (1 - w), 3)}</td><td class="tc-state">${src(s)}</td></tr>`;
    }).join('');
    const total = AIR_ARGON + Object.values(AIR_DRY).reduce((s, v) => s + v[0], 0);
    return `<details class="xs-fold xs-air-fold"${open ? ' open' : ''}><summary>Mole fractions used, and their sources</summary>
    <div class="tc-table-scroll"><table class="tc-table xs-air-x"><thead><tr><th>Gas</th><th class="num">Dry air</th><th class="num">This air</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint">“This air” is the dry-air share times 1 − x(H₂O), since water vapor displaces dry air. The shares are not renormalized: with the 2026 CO₂ value the dry-air column adds up to ${total.toFixed(4)}. CO, O₃, NO₂, NO, SO₂ and NH₃ vary with place and time; their 1976 values stand for clean air near the surface. α scales with the share, so for other air multiply α by the ratio of the shares.</p></details>`;
}
/**
 * The reverse lookup at the wavelength of "At a laser line": one dataset per molecule (chosen by the build), strongest
 * first. At a preset line the values are those of the laser-line table; anywhere else, means over a 2 nm bin. The air
 * view weights each σ by the gas's share of the air (airAbsorption) and opens ordered by that.
 */
function renderWho() {
    const out = $('xs-who'); const lam = num(state.lam);
    const ok = !numError(state.lam, 'wavelength') && lam > 0;
    $('xs-who-badge').textContent = ok ? `${lam} nm` : '';
    if (!ok) { out.innerHTML = '<p class="tc-msg">Enter a wavelength under “At a laser line”.</p>'; return; }
    const key = lineKey(lam); const name = key ? 'who' : 'coarse';
    if (whoState[name] !== 'ok') {
        loadWho(name);
        out.innerHTML = whoState[name] === 'missing' ? '<p class="tc-msg">This copy of the data has no table for the reverse lookup. Pick a molecule at the top of the page to read its value here.</p>' : '<p class="tc-msg">Loading the table…</p>';
        return;
    }
    const all = (key ? whoAtLine(who, key) : whoCoarse(coarse, lam)).filter((r) => byKey.has(r.k));
    const air = state.who !== 'all'; const view = whoView(all, air);
    const had = out.contains(document.activeElement) ? document.activeElement.dataset : {};   // the button that had focus is rebuilt below
    // the air view: each σ weighted by the gas's share of air at 1 atm and 296 K, and ordered by that unless the reader asks for σ
    const rh = num(state.rh);
    const rhErr = !air ? '' : numError(state.rh, 'relative humidity') || (rh == null || rh < 0 || rh > 100 ? 'Enter a relative humidity from 0 to 100 %.' : '');
    const A = air && !rhErr ? airAbsorption(view.rows, rh) : null;
    const inAir = A ? new Map(A.rows.map((r) => [r.k, r])) : null;
    const byAir = !!A && state.ws !== 'sig';
    const foldOpen = !!out.querySelector('.xs-air-fold')?.open;
    const shown = A ? (byAir ? A.rows : view.rows.map((r) => inAir.get(r.k))) : whoAll || air ? view.rows : view.rows.slice(0, WHO_TOP);
    const chips = `<div class="xs-quick xs-who-view" role="group" aria-label="Which molecules to list">${[['air', 'Air and common gases'], ['all', 'All molecules']].map(([k, l]) => `<button type="button" data-who-view="${k}" aria-pressed="${(k === 'air') === air}">${l}</button>`).join('')}</div>`;
    const sort = A ? `<div class="xs-quick xs-who-sort" role="group" aria-label="Order of the list">${[['', 'By absorption in air'], ['sig', 'By σ per molecule']].map(([k, l]) => `<button type="button" data-who-sort="${k}" aria-pressed="${(k === 'sig') !== byAir}">${l}</button>`).join('')}</div>` : '';
    const noteOf = (r) => [...whoNotes(r), r.out ? 'not in the sum for air' : ''].filter(Boolean).join('; ');
    // a flagged value keeps its flag in every column made from it: ≤ for an upper limit (so ≥ for its 1/e length), and ≈ with
    // two figures for a 2 nm mean and for any other row with a note
    const airCells = (r) => {
        const soft = r.approx || r.weak; const mark = r.alpha > 0 && (r.approx || (r.weak && !r.ul)) ? '≈ ' : '';
        return `<td role="cell" class="num xs-w-x" data-l="in air">${fractionText(r.x)}</td><td role="cell" class="num xs-w-a" data-l="α">${r.ul ? '≤ ' : ''}${mark}${sci(r.alpha, soft ? 1 : 2)}</td><td role="cell" class="num xs-w-L" data-l="1/e length">${r.L == null ? '—' : `${r.ul ? '≥ ' : ''}${mark}${pathText(r.L, soft ? 1 : 2)}`}</td>`;
    };
    const notes = shown.some(noteOf);   // the Note column only when a row has something to say
    const rows = shown.map((r, i) => {
        const s = byKey.get(r.k); const cur = r.k === state.k;
        const note = noteOf(r);
        return `<tr role="row"${cur ? ' class="xs-w-cur"' : ''}><td role="cell" class="num xs-w-n">${i + 1}</td><td role="cell" class="xs-w-mol"><button type="button" class="xs-w-pick" data-who-k="${esc(r.k)}" data-who-f="${esc(r.f)}" title="Show ${esc(s.n || s.f)} with this dataset"${cur ? ' aria-current="true"' : ''}><span class="xs-w-f">${F(s.f)}</span>${s.n ? ` <span class="xs-l-name">${esc(s.n)}</span>` : ''}</button></td><td role="cell" class="num xs-w-sig">${r.ul ? '≤ ' : ''}${r.approx ? `≈ ${sci(r.sigma, 1)}` : sci(r.sigma)}</td>${A ? airCells(r) : ''}<td role="cell" class="xs-w-ref">${esc(r.label)}${r.iso ? `, ${esc(r.iso)}` : ''}${r.rec ? ' <span class="tc-tag xs-rec">rec.</span>' : ''} <span class="tc-state">${esc(srcName(r.src))}</span></td><td role="cell" class="num xs-w-T">${esc(tText(r.T))}</td>${notes ? `<td role="cell" class="tc-state xs-w-note">${esc(note)}</td>` : ''}</tr>`;
    }).join('');
    const names = (ks) => { const f = ks.map((k) => F(byKey.has(k) ? byKey.get(k).f : k)); return f.length > 1 ? `${f.slice(0, -1).join(', ')} and ${f[f.length - 1]}` : f[0]; };
    const count = air
        ? `${view.rows.length} of these ${AIR_GASES.length} gases ${view.rows.length === 1 ? 'has' : 'have'} data at ${lam} nm.${view.missing.length ? ` No data here for ${names(view.missing)}: no table in the five collections reaches this wavelength for ${view.missing.length === 1 ? 'it' : 'them'}. That is not the same as no absorption.` : ''} Argon, ${fractionText(AIR_ARGON)} of dry air, is in none of the five collections.`
        : `${view.rows.length} of the ${species.length} molecules ${view.rows.length === 1 ? 'has' : 'have'} data at ${lam} nm${shown.length < view.rows.length ? `; the ${shown.length} strongest are listed` : ''}. A molecule that is not listed has no data here, which is not the same as no absorption.`;
    const more = shown.length < view.rows.length ? `<div class="tc-actions"><button type="button" class="btn btn-secondary btn-sm" data-who-more="1">Show all ${view.rows.length}</button></div>` : '';
    const kind = !all.length ? '' : key
        ? 'Point values at this preset line, from each dataset’s full spectrum: the number the table above gives once the molecule is loaded.'
        : `${lam} nm is not a preset line, so these are coarse values: the mean of σ from ${all[0].lo} to ${all[0].hi} nm in each dataset, to two figures. Load a molecule for its value at ${lam} nm itself.`;
    // explicit roles: on a phone the stylesheet lays the rows out as cards, which would otherwise drop the table semantics
    const th = (label, num) => `<th role="columnheader" scope="col"${num ? ' class="num"' : ''}>${label}</th>`;
    const table = shown.length ? `<div class="xs-who-wrap"><table class="tc-table xs-who${A ? ' xs-who-air' : ''}" role="table" aria-labelledby="xs-who-h"><thead role="rowgroup"><tr role="row">${th('#', 1)}${th('Molecule')}${th('σ, cm²', 1)}${A ? `${th('In air', 1)}${th('α, m⁻¹', 1)}${th('1/e length', 1)}` : ''}${th('Dataset')}${th('T', 1)}${notes ? th('Note') : ''}</tr></thead><tbody role="rowgroup">${rows}</tbody></table></div>` : '';
    const loaded = whoFrom && whoFrom === state.k && whoLam === state.lam ? `<p class="hint xs-who-msg" role="status">${F(byKey.get(state.k).f)} is loaded with that dataset: its values are in the table above, its spectrum is in <a href="#xs-plot-h">the plot</a>.</p>` : '';
    const take = A ? airTakeaway(A, lam, view.missing) : rhErr ? bad(rhErr) : '';
    const cond = A && shown.length ? `<p class="hint xs-air-cond">Air at 1 atm and ${AIR.T} K as an ideal gas, n = ${sci(A.n)} cm⁻³, at ${esc(state.rh.trim())} % <a href="#xs-rh">relative humidity</a> (${A.water > 0 ? `${fractionText(A.water)} water vapor` : 'dry air'}). α = σ × mole fraction × n, and the 1/e length is 1/α.${byAir ? '' : ' The list is in the order of σ per molecule.'}</p>` : '';
    $('xs-air-ctl').hidden = !air;
    out.innerHTML = `${chips}${sort}${loaded}${take}${table}${more}${cond}${A ? airFold(A, rh, foldOpen) : ''}<p class="hint">${count}</p><p class="hint">${kind}${kind && num(state.fw) > 0 ? ' The line width is not applied in this table.' : ''}${shown.length ? ` Press a molecule to load it${shown.some((r) => r.k === state.k) ? '; the shaded row is the one on the plot' : ''}.` : ''}</p>`;
    // the molecule that was pressed is loaded in steps, and each one draws this table again: its button keeps the focus
    const back = had.whoK || (whoFocus && (document.activeElement === document.body || !document.activeElement) ? whoFocus : '');
    if (whoFocus && whoFocus === state.k) whoFocus = '';
    if (back) out.querySelector(`button[data-who-k="${CSS.escape(back)}"]`)?.focus({ preventScroll: true });
    else if (had.whoView) out.querySelector(`button[data-who-view="${CSS.escape(had.whoView)}"]`)?.focus({ preventScroll: true });
    else if (had.whoSort != null) out.querySelector(`button[data-who-sort="${CSS.escape(had.whoSort)}"]`)?.focus({ preventScroll: true });
    else if (had.whoMore) out.querySelector(`.xs-who tr:nth-child(${WHO_TOP + 1}) button`)?.focus({ preventScroll: true });
}
document.addEventListener('click', (e) => {
    const v = e.target.closest('button[data-who-view]');
    if (v) { state.who = v.dataset.whoView === 'all' ? 'all' : 'air'; whoAll = false; renderWho(); writeURL(); return; }
    const o = e.target.closest('button[data-who-sort]');
    if (o) { state.ws = o.dataset.whoSort === 'sig' ? 'sig' : ''; renderWho(); writeURL(); return; }
    if (e.target.closest('button[data-who-more]')) { whoAll = true; renderWho(); return; }
    const b = e.target.closest('button[data-who-k]');
    if (b) { whoFrom = b.dataset.whoK; whoLam = state.lam; whoFocus = b.dataset.whoK; choose(b.dataset.whoK, false, b.dataset.whoF); }
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
    const m = meta;
    $('xs-src').innerHTML = `<p>${species.length} molecules and ${m.sets ?? species.reduce((a, s) => a + s.ns, 0)} datasets, built ${esc(m.built || '')}. Each dataset above is listed with the reference its source gives: the paper's authors and title where the source has them, otherwise the source's own citation text. Please cite the original paper, and the compilation it came through, for any value you use.</p>
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
        const r = x.meta.ref || {}; const src = (meta.sources || {})[x.meta.src] || {};
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
    const rh = num(state.rh); $('xs-rh').setAttribute('aria-invalid', rh == null || rh < 0 || rh > 100 ? 'true' : 'false');
}
function renderAll() { markFields(); renderPlot(); renderAt(); renderWho(); renderCalc(); renderConv(); writeURL(); }
async function boot() {
    readURL(); const hash = location.hash;
    if (state.who !== 'all') state.who = 'air';
    if (state.ws !== 'sig') state.ws = '';
    const k0 = state.k; state.k = '';   // the molecule of the link is shown once its datasets are loaded (choose)
    // the first molecule's own file is asked for now, beside the species list, when its key can be its file name
    const guess = k0 || 'O3';
    if (/^[A-Za-z0-9+_-]+$/.test(guess)) { early = { file: guess, req: getJSON(`./data/sp/${encodeURIComponent(guess)}.json`) }; early.req.catch(() => {}); }
    $('xs-y').innerHTML = Object.entries(SIGMA_UNITS).map(([k, u]) => `<option value="${k}">${esc(u.label)}</option>`).join('');
    $('xs-cu').innerHTML = Object.entries(SIGMA_UNITS).map(([k, u]) => `<option value="${k}">${esc(u.label)}</option>`).join('');
    const bind = (id, k, ev = 'input', fn = renderAll) => { const el = $(id); if (el.type === 'checkbox') el.checked = !!state[k]; else el.value = state[k]; el.addEventListener(ev, () => { state[k] = el.type === 'checkbox' ? el.checked : el.value; fn(); }); };
    if (!X_AXES[state.x]) state.x = 'nm';
    bind('xs-x', 'x', 'change', () => { syncLims(); renderAll(); }); bind('xs-y', 'y', 'change'); bind('xs-log', 'log', 'change'); bind('xs-lines', 'lines', 'change');
    bind('xs-lam', 'lam'); bind('xs-fw', 'fw');
    bind('xs-rh', 'rh', 'input', () => { markFields(); renderWho(); writeURL(); });   // the humidity of the air view
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
    // The species list is all the search and the molecule buttons need. A copy of the data without it (built before
    // the list existed) is read from index.json, which holds every species' datasets too.
    try {
        const d = await getJSON('./data/species.json');
        if (!d || !d.meta || !Array.isArray(d.species) || !d.species.length) throw new Error('empty');
        meta = d.meta; species = d.species.map(([k, f, n, cas, ns, file]) => ({ k, f, n: n || '', cas: cas || '', ns, file: file || k, sets: null }));
    } catch {
        try {
            full = getJSON('./data/index.json'); const d = await full;
            meta = d.meta; species = d.species.map((s) => ({ ...s, ns: s.sets.length, file: s.k }));
        } catch (err) { $('xs-sets').innerHTML = `<p class="tc-msg tc-bad">Could not load the dataset index (${esc(err.message)}).</p>`; return; }
    }
    byKey = new Map(species.map((s) => [s.k, s]));
    $('xs-quick').innerHTML = QUICK.map((f) => species.find((s) => s.f === f)).filter(Boolean).map((s) => `<button type="button" data-k="${esc(s.k)}">${F(s.f)}</button>`).join('');
    $('xs-quick').addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) choose(b.dataset.k); });
    initCombo(); renderSources();
    renderWho();   // the reverse lookup needs only the species list and its own table, not the first molecule
    $('xs-csv').addEventListener('click', downloadCSV);
    $('xs-reset').addEventListener('click', () => { try { history.replaceState(null, '', location.pathname); } catch { /* sandbox */ } location.reload(); });   // the page without a query is the page as first opened
    $('xs-link').addEventListener('click', async (e) => { try { await navigator.clipboard.writeText(location.href); e.target.textContent = 'Copied'; } catch { prompt('Copy this link:', location.href); } setTimeout(() => { e.target.textContent = 'Copy link'; }, 1500); });
    const first = byKey.has(k0) ? k0 : (species.find((s) => s.f === 'O3') || species[0]).k;
    await choose(first, byKey.has(k0) && state.on.length > 0);
    const target = hash && /^#[\w-]+$/.test(hash) ? document.getElementById(hash.slice(1)) : null; if (target) target.scrollIntoView();   // the browser scrolled before the list and chart existed
    window.__xsec = { index: () => ({ meta, species }), who: () => ({ who, coarse }), cache, state };
}
boot();
