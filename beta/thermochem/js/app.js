// Thermochemistry Lab (beta): UI. Data: ATcT TN 1.228 (./data/atct-tn1.228.json), loaded at start; the ATcT covariances
// (TN 1.220), NIST excited states and the TN 1.220 version diff are loaded only when a view needs them. Engine: ./engine.js.
import {
    buildDB, payloadFromCSV, search, resolveToken, parseReaction, resolveReaction, balance, reactionEnthalpy,
    findChannels, ionizationEnergies, electronAffinities, protonAffinities, sameComposition, coreFormula,
    attachCov, attachExcited, attachDiff, excitedStates, excitedThresholds, excitedTerms, versionChange, bestU, stateText,
    stateToken, unboundAnion, parseNum, UNITS, toKJ, fromKJ, kjToNm, nmToKJ,
} from './engine.js';
import { buildDiagram, KINDS as DKINDS } from './diagram.js';
import { CASES, KINDS, runCase, extraChecks } from './selftest.js';

const $ = (id) => document.getElementById(id);
const DATA_URL = './data/atct-tn1.228.json';
const COV_URL = './data/atct-cov-tn1.220.json';
const EXC_URL = './data/excited-states.json';
const DIFF_URL = './data/atct-tn1.220-diff.json';
const ATCT_BASE = 'https://atct.anl.gov/Thermochemical%20Data/version%201.228/';
const TABS = ['species', 'reaction', 'channels', 'diagram', 'units', 'selftest', 'data'];
const DIGITS = { 'kJ/mol': 3, 'kcal/mol': 3, 'eV': 4, 'cm⁻¹': 1, 'K': 0, 'Eh': 6 };
const DG_DEFAULT = { r: 'CH2O', p: ['H + HCO', 'H2 + CO', 'H + H + CO'], l: [], nm: '', c: 'fan' };

let shipped = null;   // payload as shipped
let db = null;
let unit = 'kJ/mol';
const state = {
    tab: 'species', sp: '', rx: 'CH2O -> H + HCO', rxo: {}, ch: '50-00-0*0', nm: '', ee: '', mode: 'neutral', three: false, lab: false,
    ex: false, fine: true, uv: '30328.5', uu: 'cm⁻¹', dg: structuredClone(DG_DEFAULT),
};

/* ── lazy data ──────────────────────────────────────────────────────── */
// Each extra file is fetched once, on first need. Covariances and the version diff belong to ATcT's IDs and versions,
// so they attach to the shipped table only; the excited states attach to any table by ATcT ID.
const extra = { cov: null, exc: null, diff: null };
const extraErr = {};
const pending = {};
function need(kind) {
    if (!db || extra[kind] === false) return;
    if (kind !== 'exc' && !db.isShipped) return;
    if (extra[kind]) { if (!db[kind]) attachTo(db, kind); return; }
    if (pending[kind]) return;
    const url = { cov: COV_URL, exc: EXC_URL, diff: DIFF_URL }[kind];
    pending[kind] = fetch(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((j) => { extra[kind] = j; attachTo(db, kind); rerender(); })
        .catch((err) => { extra[kind] = false; extraErr[kind] = err.message; rerender(); });
}
function attachTo(d, kind) {
    if (!extra[kind]) return;
    if (kind === 'cov' && d.isShipped) attachCov(d, extra.cov);
    if (kind === 'exc') attachExcited(d, extra.exc);
    if (kind === 'diff' && d.isShipped) attachDiff(d, extra.diff);
}
// the correlated uncertainty needs the version diff too (it scales the species whose uncertainty changed)
const covLoading = () => db && db.isShipped && ((!db.cov && extra.cov !== false) || (!db.diff && extra.diff !== false));
/** Files each tab needs; requested only while that tab is shown, so the default view loads just the main table. */
function needFor(t) {
    if (!db) return;
    if (t === 'species') { need('diff'); need('exc'); }
    if (t === 'reaction' || t === 'diagram' || t === 'selftest') { need('cov'); need('diff'); need('exc'); }
    if (t === 'channels') { need('cov'); need('diff'); if (state.ex) need('exc'); }
}

/* ── formatting ─────────────────────────────────────────────────────── */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const minus = (s) => s.replace(/^-/, '−');
function num(x, d) { if (x == null || !Number.isFinite(x)) return '—'; const v = Math.abs(x) < 0.5 * 10 ** -d ? 0 : x; return minus(v.toFixed(d)); }
/** Energy in the chosen unit: "362.804 ± 0.110 kJ/mol". */
function E(kj, u = null, un = unit, d = null) {
    if (kj == null) return '—';
    const dd = d ?? DIGITS[un];
    const s = num(fromKJ(kj, un), dd);
    return u != null ? `${s} ± ${num(fromKJ(u, un), Math.max(dd, uDigits(fromKJ(u, un))))} ${un}` : `${s} ${un}`;
}
const uDigits = (u) => (u > 0 && u < 1 ? Math.min(6, Math.ceil(-Math.log10(u)) + 1) : 0);
/** Uncertainty in the chosen unit with enough digits to show it. */
const U = (kj, un = unit) => num(fromKJ(kj, un), Math.max(DIGITS[un], uDigits(fromKJ(kj, un))));
/** "± 0.0066" or, for a correlated value that is only a bound, "< 0.0001". */
const PM = (bu, un = unit) => (bu.u == null ? '—' : `${bu.lt ? '<' : '±'} ${U(bu.u, un)}`);
/** Superscript c marking a correlated uncertainty, with its meaning for screen readers. */
const CMARK = '<sup class="tc-ucor" aria-hidden="true">c</sup><span class="visually-hidden"> (correlated)</span>';
/** A caution marker: a button that shows its note as text (title-only notes are invisible on touch screens). */
let noteSeq = 0;
function flagHTML(notes) {
    if (!notes.length) return '';
    const id = `tc-note-${++noteSeq}`;
    return ` <button type="button" class="tc-flag" aria-expanded="false" aria-controls="${id}">note</button><span class="tc-flagtext" id="${id}" hidden>${esc(notes.join('; '))}</span>`;
}
document.addEventListener('click', (e) => {
    const b = e.target.closest('button.tc-flag'); if (!b) return;
    const t = document.getElementById(b.getAttribute('aria-controls')); if (!t) return;
    const open = b.getAttribute('aria-expanded') !== 'true';
    b.setAttribute('aria-expanded', String(open)); t.hidden = !open;
});
/** ATcT formula to HTML: digits subscripted, trailing charge superscripted. */
function F(f) {
    if (f === 'e⁻') return 'e<sup>−</sup>';
    let core = f; let charge = '';
    const m = /^(.*?)(\]?)([+-]\d?|\+\+|--)$/.exec(f);
    if (m && (m[2] || /[A-Za-z0-9)]$/.test(m[1]))) { core = m[1] + m[2]; charge = m[3]; }
    const body = esc(core).replace(/([A-Za-z)\]])(\d+)/g, '$1<sub>$2</sub>');
    const ch = charge ? `<sup>${esc(charge.replace('-', '−').replace(/^([+−])(\d)$/, '$2$1'))}</sup>` : '';
    return `<span class="tc-formula">${body}${ch}</span>`;
}
/** Excited-state label as HTML: "A ²Σ⁺", "a ¹Δ<sub>g</sub>", "¹D₂". */
const stHTML = (st) => esc(stateText(st)).replace(/([ΣΠΔΦ])([gu])/g, '$1<sub>$2</sub>');
const stateTag = (s) => (s.isElectron || s.excited ? '' : ` <span class="tc-state">(${esc(s.state)})</span>`);
const sp = (s) => (s.excited && s.base ? `${F(s.base.formula)}(${stHTML(s.excited)}) <span class="tc-state">(NIST)</span>` : `${F(s.formula)}${stateTag(s)}`);
const atctLink = (s) => (s.n && !s.isElectron ? `${ATCT_BASE}species/?species_number=${s.n}` : null);
const txt = (s) => (s.isElectron ? 'e-' : `${s.formula}${s.plainState ? '' : `(${s.state})`}`);

/* ── URL state ──────────────────────────────────────────────────────── */
function readURL() {
    const p = new URLSearchParams(location.search);
    if (TABS.includes(p.get('tab'))) state.tab = p.get('tab');
    for (const k of ['sp', 'rx', 'ch', 'nm', 'ee', 'mode', 'uv', 'uu']) if (p.has(k)) state[k] = p.get(k);
    if (!['neutral', 'dpi', 'ionpair', 'dea'].includes(state.mode)) state.mode = 'neutral';
    state.three = p.get('three') === '1'; state.lab = p.get('lab') === '1'; state.ex = p.get('ex') === '1'; state.fine = p.get('fine') !== '0';
    if (p.has('u') && UNITS.includes(p.get('u')) && [...$('tc-unit').options].some((o) => o.value === p.get('u'))) unit = p.get('u');
    try { state.rxo = JSON.parse(p.get('rxo') || '{}') || {}; } catch { state.rxo = {}; }
    if (p.has('dg')) {
        try {
            const d = JSON.parse(p.get('dg'));
            state.dg = {
                r: String(d.r || ''), p: Array.isArray(d.p) ? d.p.map(String).slice(0, 20) : [], nm: String(d.nm || ''), c: ['none', 'fan', 'chain'].includes(d.c) ? d.c : 'fan',
                l: Array.isArray(d.l) ? d.l.slice(0, 20).filter(Array.isArray).map((x) => [String(x[0] || '').slice(0, 60), String(x[1] ?? '').slice(0, 30), UNITS.includes(x[2]) ? x[2] : 'kJ/mol', ['ts', 'intermediate', 'roaming'].includes(x[3]) ? x[3] : 'ts']) : [],
            };
        } catch { state.dg = structuredClone(DG_DEFAULT); }
    }
}
function urlFor(tab) {
    const p = new URLSearchParams();
    p.set('tab', tab);
    if (unit !== 'kJ/mol') p.set('u', unit);
    if (tab === 'species' && state.sp) p.set('sp', state.sp);
    if (tab === 'reaction') { p.set('rx', state.rx); if (Object.keys(state.rxo).length) p.set('rxo', JSON.stringify(state.rxo)); }
    if (tab === 'channels') {
        p.set('ch', state.ch); if (state.mode !== 'neutral') p.set('mode', state.mode);
        if (state.mode === 'dea') { if (state.ee) p.set('ee', state.ee); } else if (state.nm) p.set('nm', state.nm);
        if (state.three) p.set('three', '1'); if (state.lab) p.set('lab', '1'); if (state.ex) p.set('ex', '1'); if (!state.fine) p.set('fine', '0');
    }
    if (tab === 'diagram') p.set('dg', JSON.stringify(state.dg));
    if (tab === 'units') { p.set('uv', state.uv); p.set('uu', state.uu); }
    return `${location.pathname}?${p.toString()}`;
}
const writeURL = () => { try { history.replaceState(null, '', urlFor(state.tab)); } catch { /* file:// or sandbox */ } };
function shareBox(tab) {
    const url = new URL(urlFor(tab), location.href).href;
    const what = { channels: 'channel list', diagram: 'diagram' }[tab] || tab;
    return `<div class="tc-share"><button type="button" class="btn btn-secondary btn-sm" data-copy="${esc(url)}">Copy link</button><span class="hint">Opens this ${what} with the same inputs.</span></div>`;
}
document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]'); if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { prompt('Copy this link:', b.dataset.copy); }
    setTimeout(() => { b.textContent = 'Copy link'; }, 1500);
});

/* ── tabs ───────────────────────────────────────────────────────────── */
function showTab(t, focus = false) {
    state.tab = t;
    for (const x of TABS) {
        const btn = $(`tabbtn-${x}`); const pnl = $(`tab-${x}`);
        const on = x === t; btn.setAttribute('aria-selected', on); btn.tabIndex = on ? 0 : -1; pnl.hidden = !on;
        if (on && focus) btn.focus();
    }
    needFor(t);
    if (t === 'selftest') renderSelfTest();
    if (t === 'diagram' && db) renderDiagram();
    writeURL();
}
function initTabs() {
    for (const t of TABS) $(`tabbtn-${t}`).addEventListener('click', () => showTab(t));
    document.querySelector('.tc-tabs').addEventListener('keydown', (e) => {
        const i = TABS.indexOf(state.tab);
        if (e.key === 'ArrowRight') showTab(TABS[(i + 1) % TABS.length], true);
        else if (e.key === 'ArrowLeft') showTab(TABS[(i - 1 + TABS.length) % TABS.length], true);
        else if (e.key === 'Home') showTab(TABS[0], true);
        else if (e.key === 'End') showTab(TABS[TABS.length - 1], true);
        else return;
        e.preventDefault();
    });
}

/* ── combobox ───────────────────────────────────────────────────────── */
function combo(input, list, onPick, filter = () => true, onMiss = () => {}) {
    let items = []; let act = -1;
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); act = -1; };
    const paint = () => [...list.children].forEach((li, i) => li.setAttribute('aria-selected', i === act));
    const open = () => {
        if (!db) return;
        // derived NIST states (base set) belong to their ground species' card, not to the list
        items = search(db, input.value, 40).filter((s) => !s.base && filter(s)).slice(0, 20);
        if (!items.length) { close(); return; }
        list.innerHTML = items.map((s, i) => `<li role="option" id="${list.id}-${i}" aria-selected="false" data-i="${i}"><span>${sp(s)}</span><span class="tc-l-name">${esc(s.name)}</span><span class="tc-l-h">${num(s.h298, 3)}</span></li>`).join('');
        list.hidden = false; input.setAttribute('aria-expanded', 'true'); act = -1;
    };
    const pick = (i) => { const s = items[i]; if (!s) return; close(); onPick(s.base || s); };
    input.addEventListener('input', open);
    input.addEventListener('focus', () => { if (input.value) open(); });
    input.addEventListener('keydown', (e) => {
        if (list.hidden && (e.key === 'ArrowDown')) { open(); return; }
        if (e.key === 'ArrowDown') { act = Math.min(items.length - 1, act + 1); paint(); input.setAttribute('aria-activedescendant', `${list.id}-${act}`); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { act = Math.max(0, act - 1); paint(); input.setAttribute('aria-activedescendant', `${list.id}-${act}`); e.preventDefault(); }
        else if (e.key === 'Enter') {
            if (!list.hidden) { pick(act >= 0 ? act : 0); e.preventDefault(); return; }
            if (!input.value.trim()) return;
            const r = resolveToken(db, input.value); const s = r.species ? r.species.base || r.species : null;
            if (s && filter(s)) onPick(s); else onMiss(input.value.trim(), s);
        }
        else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
    input.addEventListener('blur', () => setTimeout(close, 120));
}

/* ── Species ────────────────────────────────────────────────────────── */
function renderSpecies() {
    const s = db.byId.get(state.sp);
    const root = $('sp-card');
    if (!s) { root.innerHTML = ''; return; }
    if (state.tab === 'species') needFor('species');
    const rel = (arr, label, fmt) => (arr.length ? `<div class="tc-res"><h3>${label}</h3>${arr.slice(0, 6).map(fmt).join('')}</div>` : '');
    const ies = ionizationEnergies(db, s); const eas = electronAffinities(db, s); const pas = protonAffinities(db, s);
    const same = sameComposition(db, s).slice(0, 30);
    const link = atctLink(s);
    const exs = excitedStates(db, s);
    root.innerHTML = `
    <div class="panel"><div class="panel-body">
        <div class="tc-card-head"><h2>${esc(s.name)}</h2>${sp(s)}</div>
        <dl class="tc-ids">
            <dt>ATcT ID</dt><dd>${esc(s.id)}</dd><dt>CAS RN</dt><dd>${esc(s.cas || '—')}</dd>
            <dt>SMILES</dt><dd>${esc(s.smiles || '—')}</dd><dt>InChIKey</dt><dd>${esc(s.inchikey || '—')}</dd>
            <dt>Molar mass</dt><dd>${s.mass != null ? s.mass + ' g/mol' : '—'}</dd><dt>Charge</dt><dd>${s.q}</dd>
            ${s.hill ? `<dt>Hill formula</dt><dd>${F(s.hill)}</dd>` : ''}
            ${s.syn.length ? `<dt>Also called</dt><dd>${esc(s.syn.slice(0, 12).join('; '))}${s.syn.length > 12 ? ` (and ${s.syn.length - 12} more)` : ''}</dd>` : ''}
        </dl>
        <div class="tc-results" style="margin-top:1rem">
            <div class="tc-res"><h3>Δ<sub>f</sub>H°(0 K)</h3><div class="tc-big">${E(s.h0)}</div><div class="tc-alt">${s.h0 == null ? 'not given for this phase' : UNITS.filter((x) => x !== unit && x !== 'Eh').map((x) => E(s.h0, null, x)).join('<br>')}</div></div>
            <div class="tc-res"><h3>Δ<sub>f</sub>H°(298.15 K)</h3><div class="tc-big">${E(s.h298)}</div><div class="tc-alt">± ${E(s.u)} (95 %)<br>${UNITS.filter((x) => x !== unit && x !== 'Eh').map((x) => E(s.h298, null, x)).join('<br>')}</div>${s.q ? '<p class="tc-note">Ion: stationary-electron convention at 298.15 K.</p>' : ''}</div>
            ${rel(ies, 'Adiabatic ionization energy', (x) => `<div class="tc-alt">→ ${sp(x.ion)}: <strong>${E(x.kj, x.u, 'eV')}</strong><br>${ieAlt(x.kj)}</div>`)}
            ${rel(eas, 'Electron affinity', (x) => `<div class="tc-alt">${sp(x.ion)}: <strong>${E(x.kj, x.u, 'eV')}</strong><br>${E(x.kj, null, 'cm⁻¹')}</div>`)}
            ${rel(pas, 'Proton affinity (298.15 K)', (x) => `<div class="tc-alt">→ ${sp(x.ion)}: <strong>${E(x.kj, x.u)}</strong></div>`)}
        </div>
        ${versionBlock(s)}
        <div class="tc-actions">
            <button type="button" class="btn btn-primary btn-sm" id="sp-ch">Find dissociation channels</button>
            <button type="button" class="btn btn-secondary btn-sm" id="sp-rx">Use in a reaction</button>
            ${link ? `<a class="btn btn-ghost btn-sm" href="${link}" target="_blank" rel="noopener">Provenance on ATcT ↗</a>` : ''}
        </div>
        ${shareBox('species')}
    </div></div>
    ${exs.length ? `<div class="panel"><div class="panel-head"><h2>Low-lying electronic states</h2><span class="badge">${exs.length}</span></div><div class="panel-body tc-table-scroll"><table class="tc-table"><thead><tr><th>State</th><th class="num">T₀, cm⁻¹</th><th class="num">± cm⁻¹</th><th class="num">${unit}</th><th class="num">Δ<sub>f</sub>H°(0 K), ${unit}</th><th>Source</th></tr></thead><tbody>${exs.map((x) => `<tr><td>${F(x.species)}(${stHTML(x)})${x.note && !x.atom ? ` <span class="tc-state">${esc(x.note)}</span>` : ''}${x.fine ? ' <span class="tc-tag">fine structure</span>' : ''}</td><td class="num">${num(fromKJ(x.kj, 'cm⁻¹'), 1)}</td><td class="num">${x.atct ? '<span class="tc-state">ATcT</span>' : x.uCm1 ? (x.uCm1 < 0.0005 ? '&lt; 0.001' : num(x.uCm1, x.uCm1 < 0.1 ? 3 : 1)) : '—'}</td><td class="num">${num(fromKJ(x.kj, unit), DIGITS[unit])}</td><td class="num">${num(fromKJ(x.h0, unit), DIGITS[unit])}</td><td class="tc-state">${srcHTML(x)}</td></tr>`).join('')}</tbody></table><p class="hint">Term values T₀ above the lowest level of ${esc(s.formula)}. Where ATcT lists the state, ATcT's value is used (the NIST value is shown in brackets); otherwise Δ<sub>f</sub>H°(0 K) = ATcT ground state + NIST T₀. “± cm⁻¹” is the term value's own uncertainty where the source gives one, plus an allowance where the source refers the state to a level other than the lowest (a multiplet centre, a hypothetical J = 0 level; see the notes); “—” means the source gives none, and the value is taken as exact. Sources are in the <a href="#" data-tab="data">Data &amp; citation</a> tab.</p></div></div>` : ''}
    ${same.length ? `<div class="panel"><div class="panel-head"><h2>Same composition: isomers, states and phases</h2></div><div class="panel-body tc-table-scroll"><table class="tc-table"><thead><tr><th>Species</th><th>Name</th><th class="num">Δ<sub>f</sub>H°(0 K)</th><th class="num">Δ<sub>f</sub>H°(298 K)</th><th class="num">± (95 %)</th><th class="num">Relative, 0 K</th></tr></thead><tbody>${same.map((x) => `<tr><td><a href="#" data-sp="${esc(x.id)}">${sp(x)}</a></td><td>${esc(x.name)}</td><td class="num">${num(x.h0 != null ? fromKJ(x.h0, unit) : null, DIGITS[unit])}</td><td class="num">${num(fromKJ(x.h298, unit), DIGITS[unit])}</td><td class="num">${U(x.u)}</td><td class="num">${x.h0 != null && s.h0 != null ? num(fromKJ(x.h0 - s.h0, unit), DIGITS[unit]) : '—'}</td></tr>`).join('')}</tbody></table><p class="hint">Energies in ${unit}. “Relative” is the 0 K energy above ${esc(s.formula)} (${esc(s.state)}).</p></div></div>` : ''}`;
    $('sp-ch').onclick = () => { state.ch = s.id; $('ch-q').value = s.formula; renderChannels(); showTab('channels'); };
    $('sp-rx').onclick = () => { state.rx = `${s.formula}${s.plainState ? '' : `(${s.state})`} -> `; $('rx-in').value = state.rx; state.rxo = {}; showTab('reaction'); $('rx-in').focus(); renderReaction(); };
    writeURL();
}
/** The species' TN 1.220 values when they differ from TN 1.228 (from the ATcT API dump). */
function versionBlock(s) {
    if (!db.isShipped) return '';
    if (!db.diff) return extra.diff === false ? '' : '<p class="tc-note tc-ver">Checking the previous ATcT version…</p>';
    const v = versionChange(db, s);
    if (!v) return '<p class="tc-note tc-ver">Unchanged since ATcT TN 1.220, the version the ATcT API serves.</p>';
    if (v.isNew) return '<p class="tc-note tc-ver"><span class="tc-tag">new in TN 1.228</span> Not in TN 1.220.</p>';
    const d = (a, b) => {
        if (a == null || b == null) return '';
        const t = num(Math.abs(fromKJ(b - a, unit)), DIGITS[unit]);
        return /^[0.]+$/.test(t) ? '' : ` (${b - a >= 0 ? '+' : '−'}${t})`;
    };
    return `<div class="tc-ver"><h3>Changed since TN 1.220</h3><div class="tc-table-scroll"><table class="tc-table tc-ver-table"><thead><tr><th></th><th class="num">TN 1.220</th><th class="num">TN 1.228 (shown)</th></tr></thead><tbody>
        <tr><th>Δ<sub>f</sub>H°(0 K)</th><td class="num">${num(v.h0 != null ? fromKJ(v.h0, unit) : null, DIGITS[unit])}</td><td class="num">${num(s.h0 != null ? fromKJ(s.h0, unit) : null, DIGITS[unit])}${d(v.h0, s.h0)}</td></tr>
        <tr><th>Δ<sub>f</sub>H°(298.15 K)</th><td class="num">${num(v.h298 != null ? fromKJ(v.h298, unit) : null, DIGITS[unit])}</td><td class="num">${num(fromKJ(s.h298, unit), DIGITS[unit])}${d(v.h298, s.h298)}</td></tr>
        <tr><th>± (95 %)</th><td class="num">${v.u != null ? U(v.u) : '—'}</td><td class="num">${U(s.u)}</td></tr></tbody></table></div>
        <p class="hint">${unit}. TN 1.220 values from the ATcT API (<code>/api/v1/all/</code>, downloaded 2026-11-06). ATcT solves the whole network again for each version, so values move as new measurements and calculations enter.</p></div>`;
}
document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-sp]'); if (!a) return;
    e.preventDefault(); state.sp = a.dataset.sp; const s = db.byId.get(state.sp); $('sp-q').value = s ? s.formula : ''; showTab('species'); renderSpecies();
});
document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-tab]'); if (!a) return;
    e.preventDefault(); showTab(a.dataset.tab, true);
});

/** Secondary units for an IE line already shown in eV: cm⁻¹ plus the chosen unit, never the same unit twice. */
function ieAlt(kj) {
    const us = ['cm⁻¹', unit === 'eV' || unit === 'cm⁻¹' ? 'kJ/mol' : unit];
    return us.map((u) => E(kj, null, u)).join(' · ');
}

/* ── sources and flags of excited states ───────────────────────────── */
const SRC_NAME = { ASD: 'NIST ASD', HH: 'Huber & Herzberg', JACOX: 'Jacox' };
const FLAG_TEXT = {
    chained_nu00: 'T₀ chained through a lower excited state',
    excited_multiplet_center_not_lowest_level: 'multiplet centre, not the lowest sublevel',
    pi_ground_state_reference_convention: 'Huber & Herzberg refer this band origin to a level of the ²Π ground state other than the lowest one',
    converted_from_hill_van_vleck_zero: 'Huber & Herzberg give the band origin from the Hill–Van Vleck zero point; converted here to the lowest levels with their spin-orbit and rotational constants',
    parenthesized_uncertain: 'marked uncertain by Huber & Herzberg',
    Te_not_T0: 'Tₑ, not T₀',
    ref_u56_unresolved: 'one ASD reference page could not be retrieved',
    predissociated: 'predissociated state',
    computed_Te_plus_ZPE: 'T₀ = Tₑ + G′(0) − G″(0)',
    fine_structure_Te: 'spin-orbit Tₑ',
    extrapolated: 'extrapolated',
    value_from_HH_note: 'from a Huber & Herzberg note',
    Te_parenthesized: 'Tₑ marked uncertain',
    vibrational_numbering_uncertain: 'vibrational numbering uncertain',
};
function flagNotes(st) {
    const out = st.flags.map((f) => FLAG_TEXT[f] || (/^Te\+ZPE_check_differs_by_(-?[\d.]+)/.test(f) ? `Tₑ + ZPE check differs by ${f.match(/by_(-?[\d.]+)/)[1]} cm⁻¹` : null)).filter(Boolean);
    if (!st.atct && st.sysCm1) out.push(`±${num(st.sysCm1, 1)} cm⁻¹ allowance for the reference level is included in the uncertainty`);
    return out;
}
function srcHTML(st) {
    const base = st.atct ? `ATcT ${esc(db.meta.tn_version || '')} <span class="tc-state">[${esc(SRC_NAME[st.src] || st.src)}: ${num(st.cm1, 1)} cm⁻¹]</span>` : esc(SRC_NAME[st.src] || st.src);
    return `${base}${flagHTML(flagNotes(st))}`;
}

/* ── Reaction ───────────────────────────────────────────────────────── */
const EXAMPLES = ['H2O -> H + OH', 'CH4 -> CH3 + H', 'CH2O -> H + HCO', 'CH2O -> H2 + CO', 'O2 -> 2 O', 'O3 -> O2 + O', 'O3 -> O(1D) + O2(a1Δg)', 'H2O -> H + OH(A)', '1/2 O2 -> O', 'CH3OH -> CH3 + OH', 'CH4 -> CH3+ + H + e-', 'H2O + e- -> H- + OH', 'NO2 -> NO + O', 'CH4 + 2 O2 -> CO2 + 2 H2O'];
/** The uncertainty block of a result: correlated and independent, which one is used, and why. */
function uncBlock(h, xterm = false) {
    const c = h.ucorr;
    const dig = Math.max(DIGITS[unit], 4);
    if (!c || covLoading()) {
        if (covLoading()) return '<p class="tc-note">Used: independent errors. Loading ATcT covariances…</p>';
        return `<p class="tc-note">Used: independent errors. ${db.isShipped ? `Correlated uncertainty unavailable${extraErr.cov ? ` (covariance file: ${esc(extraErr.cov)})` : ''}.` : 'No ATcT covariances for a user table.'}</p>`;
    }
    if (!c.covered) {
        const miss = c.missing.map((id) => db.byId.get(id)).filter(Boolean).map((s) => esc(s.formula)).join(', ');
        return `<p class="tc-note">Used: independent errors. Correlated: not available, because ${miss || 'a species'} ${c.missing.length > 1 ? 'are' : 'is'} not in the covariance file (1874 gas-phase species of TN ${esc(c.tn)}).</p>`;
    }
    const names = (ids) => ids.map((id) => db.byId.get(id)).filter(Boolean).map((s) => esc(s.formula)).join(', ');
    const stale = names(c.stale); const scaled = names(c.scaled || []);
    const dd = (u) => Math.max(dig, uDigits(fromKJ(u, unit)));   // as many digits as the headline value shows
    const val = (u, lt) => (u != null ? `± ${E(u, null, unit, dd(u))}` : `< ${E(lt, null, unit, dd(lt))}`);
    return `<table class="tc-utable"><tbody>
        <tr><th>Correlated <span class="tc-tag">used</span></th><td class="num">${val(c.u, c.lt)}</td></tr>
        <tr><th>Independent errors</th><td class="num">± ${E(h.u, null, unit, dd(h.u))}</td></tr>
        <tr><th>TN ${esc(c.tn)} covariances as served</th><td class="num">${val(c.u220, c.u220lt)}</td></tr></tbody></table>
        <p class="tc-note">Correlated = √(νᵀCν) with ATcT's covariances from TN ${esc(c.tn)} (the version the ATcT API serves; Δ<sub>f</sub>H° at ${c.T} K)${scaled && !c.fallback ? `, with the rows of ${scaled} scaled to the TN ${esc(db.meta.tn_version || '')} uncertainty, because their printed uncertainty changed between the versions` : ''}. It is applied to the 0 K values too, as ATcT gives one uncertainty for both${xterm ? '; the term-value uncertainty of a NIST state is added independently' : ''}.${c.fallback ? ` Scaling ${scaled} to TN ${esc(db.meta.tn_version || '')} would leave less than 0.1 % of the covariance sum (the terms cancel), so the TN ${esc(c.tn)} value as served is used.` : ''}${c.u == null ? ' The terms cancel to below the precision of the stored correlations, so only a bound is given.' : ''}${stale ? ` <strong>Caution:</strong> the printed uncertainty of ${stale} changed by more than ×1.5 between TN 1.220 and 1.228, so its correlations may be out of date.` : ''}</p>`;
}
function renderReaction() {
    const out = $('rx-out');
    state.rx = $('rx-in').value;
    if (state.tab === 'reaction') needFor('reaction');
    const p = parseReaction(state.rx);
    if (p.error) { out.innerHTML = `<div class="tc-msg tc-bad">${esc(p.error)}</div>`; writeURL(); return; }
    const r = resolveReaction(db, p, state.rxo);
    const bal = balance(r.terms);
    const h = r.errors.length ? null : reactionEnthalpy(db, r.terms);
    const rows = r.terms.map((t) => {
        const s = t.species;
        const choose = t.alts.length > 1 ? `<select class="input" data-key="${t.key}" aria-label="State of ${esc(t.token)}">${t.alts.map((a) => `<option value="${esc(a.id)}"${s && a.id === s.id ? ' selected' : ''}>${esc(a.formula)} (${esc(a.state)}) ${esc(a.name)}</option>`).join('')}</select>` : '';
        const viaNote = s && t.via === 'composition' ? `<br><span class="tc-state">“${esc(t.token)}” read by composition${t.alts.some((a) => a.formula !== s.formula) ? '; other isomers are in the list' : ''}</span>`
            : s && s.excited ? `<br><span class="tc-state">ATcT ground state + ${num(s.excited.cm1, 2)}${s.excited.uCm1 >= 0.0005 ? ` ± ${num(s.excited.uCm1, s.excited.uCm1 < 0.1 ? 3 : 1)}` : ''} cm⁻¹ (${esc(SRC_NAME[s.excited.src] || s.excited.src)})</span>${flagHTML(flagNotes(s.excited))}` : '';
        const waitEx = !s && /\(/.test(t.token) && !db.exc ? (extra.exc === false ? ` (the excited-state list could not be loaded${extraErr.exc ? `: ${extraErr.exc}` : ''})` : ' (loading the excited-state list…)') : '';
        return `<tr><td class="num">${t.nu > 0 ? '+' : '−'}${num(Math.abs(t.nu), Number.isInteger(t.nu) ? 0 : 3)}</td><td>${s ? `<a href="#" data-sp="${esc(s.base ? s.base.id : s.id)}">${sp(s)}</a><br><span class="tc-state">${esc(s.name)}</span>${viaNote}` : `<span class="tc-msg tc-bad">${esc(t.error)}${waitEx}</span>`}${choose ? `<br>${choose}` : ''}</td><td class="num">${s ? num(s.h0 != null ? fromKJ(s.h0, unit) : null, DIGITS[unit]) : ''}</td><td class="num">${s ? num(s.h298 != null ? fromKJ(s.h298, unit) : null, DIGITS[unit]) : ''}</td><td class="num">${s ? U(s.u) : ''}</td></tr>`;
    }).join('');
    let res = '';
    if (!bal.ok && !r.errors.length) {
        const off = Object.entries(bal.elements).map(([e, n]) => `${n > 0 ? '+' : '−'}${Math.abs(n)} ${e}`).concat(bal.charge ? [`charge ${bal.charge > 0 ? '+' : '−'}${Math.abs(bal.charge)}${bal.charge > 0 ? ' (add e- to the products?)' : ''}`] : []);
        res = `<div class="tc-msg tc-bad">Not balanced: products minus reactants = ${esc(off.join(', '))}.</div>`;
    } else if (h) {
        const thr = h.h0 != null && h.h0 > 0 ? kjToNm(h.h0) : null;
        const eIn = r.terms.some((t) => t.species && t.species.isElectron && t.nu < 0);
        const nElectrons = r.terms.filter((t) => t.species && t.species.isElectron).reduce((a, t) => a + t.nu, 0);   // net produced
        const eNote = Math.abs(nElectrons) > 1e-9 ? `<p class="tc-note">Stationary-electron convention: the electron carries no enthalpy at 298.15 K. For a thermal electron gas (5/2 RT = 6.197 kJ/mol per electron) ${nElectrons > 0 ? `add ${E(nElectrons * 6.197, null)} for the ${num(nElectrons, Number.isInteger(nElectrons) ? 0 : 3)} electron${nElectrons === 1 ? '' : 's'} produced` : `subtract ${E(-nElectrons * 6.197, null)} for the ${num(-nElectrons, Number.isInteger(nElectrons) ? 0 : 3)} electron${nElectrons === -1 ? '' : 's'} consumed`}.</p>` : '';
        const bu = bestU(h);
        const nist = r.terms.some((t) => t.species && t.species.excited);
        const thrBig = eIn ? (h.h0 != null ? E(Math.max(h.h0, 0), null, 'eV') : '—') : thr ? `${num(thr, 2)} nm` : '—';
        const thrAlt = eIn ? (h.h0 != null && h.h0 <= 0 ? 'exothermic attachment: open at zero electron energy' : h.h0 != null ? E(h.h0, null, 'cm⁻¹') : '')
            : thr ? `${E(h.h0, null, 'cm⁻¹')}<br>${E(h.h0, null, 'eV')}` : h.h0 != null ? 'exothermic or thermoneutral at 0 K: any onset is set by a barrier, not by thermochemistry' : '';
        const thrNote = eIn ? '<p class="tc-note">Thermochemical onset for a cold molecule; attachment resonances usually peak well above it.</p>' : thr ? '<p class="tc-note">Vacuum wavelength for a cold molecule, no barrier. See <a href="/learn/spectroscopic-units/">spectroscopic units</a>.</p>' : '';
        res = `<div class="tc-msg tc-ok">Balanced.</div>
        <div class="tc-results">
            <div class="tc-res"><h3>Δ<sub>r</sub>H°(0 K)</h3><div class="tc-big">${h.h0 != null ? E(h.h0) : '—'}</div><div class="tc-alt">${h.h0 != null ? `${PM(bu)} ${unit} (95 %, ${bu.how})<br>` + UNITS.filter((x) => x !== unit && x !== 'Eh').map((x) => E(h.h0, null, x)).join('<br>') : 'a species has no 0 K value (condensed or aqueous)'}</div>${h.h0 != null ? uncBlock(h, r.terms.some((t) => t.species && t.species.base && t.species.uTerm)) : ''}</div>
            <div class="tc-res"><h3>Δ<sub>r</sub>H°(298.15 K)</h3><div class="tc-big">${h.h298 != null ? E(h.h298) : '—'}</div><div class="tc-alt">${h.h298 != null ? `${PM(bu)} ${unit} (95 %, ${bu.how})<br>${UNITS.filter((x) => x !== unit && x !== 'Eh').map((x) => E(h.h298, null, x)).join('<br>')}` : 'not given: the NIST excited-state energies are 0 K term values'}</div>${eNote}</div>
            <div class="tc-res"><h3>${eIn ? 'Electron-energy threshold' : 'One-photon threshold'}</h3><div class="tc-big">${thrBig}</div><div class="tc-alt">${thrAlt}</div>${thrNote}</div>
        </div>${nist ? '<p class="tc-note">A product state comes from the NIST excited-state list: its energy is the ATcT ground state plus the NIST term value. Its uncertainty combines the ground state’s ATcT uncertainty with the term value’s own (where the source gives one) and, where the source refers the state to a level other than the lowest, an allowance for that offset (see the note on the species row).</p>' : ''}`;
    }
    out.innerHTML = `<div class="panel"><div class="panel-head"><h2>Species</h2></div><div class="panel-body tc-table-scroll"><table class="tc-table"><thead><tr><th class="num">ν</th><th>Species</th><th class="num">Δ<sub>f</sub>H°(0 K)</th><th class="num">Δ<sub>f</sub>H°(298 K)</th><th class="num">±</th></tr></thead><tbody>${rows}</tbody></table><p class="hint">Energies in ${unit}. Where ATcT lists several states of a formula, pick one; the gas-phase ground state is the default.</p></div></div>
    <div class="panel"><div class="panel-head"><h2>Result</h2></div><div class="panel-body">${res}${shareBox('reaction')}</div></div>`;
    out.querySelectorAll('select[data-key]').forEach((sel) => sel.addEventListener('change', () => { state.rxo[sel.dataset.key] = sel.value; renderReaction(); }));
    writeURL();
}

/* ── Channels ───────────────────────────────────────────────────────── */
const MODE_LABEL = {
    neutral: 'Neutral channels', dpi: 'Ionization and dissociative ionization', ionpair: 'Ion-pair channels',
    dea: 'Dissociative electron attachment',
};
function energyInput() {
    const dea = state.mode === 'dea';
    $('ch-nm-label').innerHTML = dea ? 'Electron energy <span class="sym">E</span>' : 'Photon wavelength <span class="sym">λ</span>';
    $('ch-nm-unit').textContent = dea ? 'eV' : 'nm';
    if ($('ch-nm').value !== (dea ? state.ee : state.nm)) $('ch-nm').value = dea ? state.ee : state.nm;
    $('ch-nm-hint').textContent = dea
        ? 'Open channels and the energy left for the products at this incident electron energy (0 to 10 000 eV).'
        : 'Open channels and the energy left for the products. Common lasers: 157, 193, 248, 266, 308, 355 nm.';
}
const exAll = new Set();   // channels whose excited list is shown in full ("Show all")
const chKey = (c) => c.products.map((s) => s.id).join('+');
function excitedRows(c, ein, lhs, dea, ncol, open1) {
    const key = chKey(c); const full = exAll.has(key);
    const all = excitedThresholds(db, c, { fine: state.fine, limit: full ? 400 : 80 });
    if (!all.length) return { html: '', nOpen: 0 };
    const nOpen = ein == null ? 0 : all.filter((x) => x.h0 <= ein).length;
    const show = full ? all : ein == null ? all.slice(0, 12) : all.slice(0, Math.max(nOpen + 3, 6));
    const rows = show.map((x) => {
        const op = ein == null ? null : ein >= x.h0;
        const label = c.products.map((s, i) => (x.states[i] ? `${F(s.formula)}(${stHTML(x.states[i])})` : sp(s))).join(' + ');
        const xrx = `${lhs} -> ${c.products.map((s, i) => (x.states[i] ? stateToken(db, x.states[i]) : txt(s))).join(' + ')}`;
        const srcs = [...new Set(x.states.filter(Boolean).map((st) => (st.atct ? `ATcT ${db.meta.tn_version || ''}` : SRC_NAME[st.src] || st.src)))];
        const notes = [...new Set(x.states.filter(Boolean).flatMap(flagNotes))];
        const xthr = kjToNm(x.h0);
        const bu = bestU(reactionEnthalpy(db, excitedTerms(db, c, x.states)));
        return `<tr class="${op === false ? 'tc-closed' : ''}"><td>${label}${x.states.some((st) => st && st.fine) ? ' <span class="tc-tag">fine structure</span>' : ''}</td><td class="num">${num(fromKJ(x.kj, unit), DIGITS[unit])}</td><td class="num">${num(fromKJ(x.h0, unit), DIGITS[unit])}</td><td class="num">${num(fromKJ(x.h0, 'eV'), 4)}</td>${dea ? '' : `<td class="num">${xthr ? num(xthr, 1) : '—'}</td>`}<td class="num">${PM(bu).replace(/^± /, '')}${bu.how === 'correlated' ? CMARK : ''}</td>${ein != null ? `<td class="num">${op ? num(fromKJ(ein - x.h0, unit), DIGITS[unit]) : 'closed'}</td>` : ''}<td class="tc-state">${esc(srcs.join(', '))}${flagHTML(notes)}</td><td><a class="tc-go" href="?tab=reaction&amp;rx=${encodeURIComponent(xrx)}" data-rx="${esc(xrx)}">reaction ›</a></td></tr>`;
    }).join('');
    const lowest = kjToNm(all[0].h0);
    const summ = `${all.length}${!full && all.length >= 80 ? '+' : ''} excited-product threshold${all.length === 1 ? '' : 's'}${ein != null ? `, ${nOpen} open` : ''}; lowest ${dea ? `${num(fromKJ(all[0].h0, 'eV'), 3)} eV` : lowest ? `${num(lowest, 1)} nm` : '—'}`;
    const more = show.length < all.length || full
        ? `<p class="hint">${full ? `All ${all.length} shown.` : `Lowest ${show.length} of ${all.length}${all.length >= 80 ? '+' : ''} shown${ein == null ? '; enter a photon or electron energy to list every open one' : ''}.`} <button type="button" class="btn btn-ghost btn-sm" data-exall="${esc(key)}">${full ? 'Show fewer' : 'Show all'}</button></p>` : '';
    const html = `<tr class="tc-exrow"><td colspan="${ncol}"><details${open1 || full ? ' open' : ''}><summary>${summ}</summary><div class="tc-table-scroll"><table class="tc-table tc-extable"><thead><tr><th>Products, with states</th><th class="num">Excitation, ${unit}</th><th class="num">Threshold, ${unit}</th><th class="num">eV</th>${dea ? '' : '<th class="num">λ max (nm)</th>'}<th class="num">±</th>${ein != null ? '<th class="num">Available</th>' : ''}<th>Source</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${more}</details></td></tr>`;
    return { html, nOpen };
}
document.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-exall]'); if (!b) return;
    const k = b.dataset.exall; if (exAll.has(k)) exAll.delete(k); else exAll.add(k);
    renderChannels();
    const nb = [...document.querySelectorAll('button[data-exall]')].find((x) => x.dataset.exall === k); if (nb) nb.focus();
});
function renderChannels() {
    const out = $('ch-out');
    const parent = db.byId.get(state.ch);
    $('ch-mode').value = state.mode; $('ch-three').checked = state.three; $('ch-labeled').checked = state.lab;
    $('ch-ex').checked = state.ex; $('ch-fine').checked = state.fine; $('ch-fine').disabled = !state.ex;
    energyInput();
    if (!parent) { out.innerHTML = '<div class="tc-msg">Pick a gas-phase parent molecule.</div>'; writeURL(); return; }
    if (!parent.gas || parent.h0 == null) { out.innerHTML = `<div class="tc-msg tc-bad">${esc(parent.formula)} (${esc(parent.state)}) is not a gas-phase entry with a 0 K value.</div>`; writeURL(); return; }
    if (state.tab === 'channels') needFor('channels');
    const dea = state.mode === 'dea';
    const inText = String((dea ? state.ee : state.nm) || '').trim();
    const inNum = parseNum(inText);
    const inOk = inNum != null && Number.isFinite(inNum) && (dea ? inNum >= 0 && inNum <= 1e4 : inNum >= 1 && inNum <= 1e6);
    const ein = inOk ? (dea ? toKJ(inNum, 'eV') : nmToKJ(inNum)) : null;
    const inBad = inText && ein == null ? `<p class="tc-msg tc-bad">“${esc(inText)}” is not a usable ${dea ? 'electron energy: enter a number of electronvolts from 0 to 10 000' : 'wavelength: enter a number of nanometres from 1 to 1 000 000'}. The channels below are shown without it.</p>` : '';
    const exWait = state.ex && !db.exc ? (extra.exc === false ? `<p class="tc-msg tc-bad">The excited-state list could not be loaded${extraErr.exc ? ` (${esc(extraErr.exc)})` : ''}, so no excited-product thresholds are shown.</p>` : '<p class="tc-msg">Loading the excited-state list…</p>') : '';
    const t0 = performance.now();
    const list = findChannels(db, parent, state.mode, { three: state.three, labeled: state.lab, excited: state.ex && !!db.exc, fine: state.fine, limit: 300 });
    const ms = performance.now() - t0;
    const ncol = 8 + (ein != null ? 1 : 0) - (dea ? 1 : 0);
    const lhs = dea ? `${txt(parent)} + e-` : txt(parent);
    let nOpenEx = 0; let nEx = 0;
    const unbound = (c) => c.products.some((s) => unboundAnion(db, s));
    const rows = list.map((c) => {
        const open = ein == null ? null : ein >= c.h0;
        const rx = `${lhs} -> ${c.products.map(txt).join(' + ')}`;
        const thr = kjToNm(c.h0);
        let tag = '';
        if (state.mode === 'dpi') {
            const heavy = c.products.filter((s) => !s.isElectron);
            tag = heavy.length > 1 ? 'AE' : coreFormula(heavy[0].formula) === coreFormula(parent.formula) ? 'IE' : 'isomeric ion';
            tag = ` <span class="tc-tag">${tag}</span>`;
        }
        if (dea && c.products.length === 1) tag = ` <span class="tc-tag">${coreFormula(c.products[0].formula) === coreFormula(parent.formula) ? 'attachment (−EA)' : 'isomeric anion'}</span>`;
        if (unbound(c)) tag += ` <span class="tc-tag">${c.products.length === 1 && c.h0 > 0 ? 'EA < 0: anion unbound (temporary anion)' : 'unbound anion (EA < 0), not a stable product'}</span>`;
        const bu = bestU(c);
        const uCell = `${PM(bu).replace(/^± /, '')}${bu.how === 'correlated' ? CMARK : ''}`;
        let exRow = '';
        if (state.ex && db.exc) {
            const x = excitedRows(c, ein, lhs, dea, ncol, nEx < 2);
            if (x.html) nEx++;
            exRow = x.html; nOpenEx += x.nOpen;
        }
        return `<tr class="${open === false ? 'tc-closed' : ''}"><td>${c.products.map(sp).join(' + ')}${tag}</td><td class="num">${num(fromKJ(c.h0, unit), DIGITS[unit])}</td><td class="num">${num(fromKJ(c.h0, 'eV'), 4)}</td><td class="num">${num(fromKJ(c.h0, 'cm⁻¹'), 0)}</td>${dea ? '' : `<td class="num">${thr ? num(thr, 1) : '—'}</td>`}<td class="num">${num(fromKJ(c.h298, unit), DIGITS[unit])}</td><td class="num">${uCell}</td>${ein != null ? `<td class="num">${open ? num(fromKJ(ein - c.h0, unit), DIGITS[unit]) : 'closed'}</td>` : ''}<td><a class="tc-go" href="?tab=reaction&amp;rx=${encodeURIComponent(rx)}" data-rx="${esc(rx)}">reaction ›</a></td></tr>${exRow}`;
    }).join('');
    const nUnb = ein == null ? 0 : list.filter((c) => c.h0 <= ein && unbound(c)).length;
    const inMsg = ein != null ? `<p class="tc-msg">${dea ? `${num(inNum, 3)} eV electron` : `${num(inNum, inNum < 10 ? 3 : 1)} nm photon`}: ${E(ein)} = ${E(ein, null, 'eV')} = ${E(ein, null, 'cm⁻¹')}. ${openText(list.filter((c) => c.h0 <= ein && !unbound(c)).length)}${nUnb ? ` (Not counted: ${nUnb} with an unbound anion.)` : ''}${state.ex && db.exc ? ` ${nOpenEx === 1 ? '1 excited-product threshold is' : `${nOpenEx} excited-product thresholds are`} open.` : ''}</p>` : '';
    const anyCorr = list.some((c) => bestU(c).how === 'correlated');
    const hintMode = {
        dpi: 'Rows tagged IE are the adiabatic ionization energy of the parent; “isomeric ion” rows lead to a cation of the same composition but a different structure (for example [HCOH]⁺ from CH₂O), so they are not the IE; rows tagged AE are appearance energies of a fragment ion.',
        dea: 'Thresholds for AB + e⁻ → A + B⁻ at 0 K: the incident electron energy needed with a cold parent. A negative value means attachment is exothermic and the channel is open at zero energy; attachment resonances usually peak well above the threshold. The “attachment (−EA)” row is the parent anion itself. ATcT also lists some anions that lie above their neutral (negative electron affinity); rows with such an unbound anion are tagged and not counted as open.',
        ionpair: 'Ion-pair thresholds A⁺ + B⁻ at 0 K, for photons or for electron impact (AB + e⁻ → A⁺ + B⁻ + e⁻ has the same threshold).',
    }[state.mode] || '';
    const uHint = anyCorr ? '; <sup>c</sup> marks the correlated value from ATcT covariances (TN 1.220, with species whose uncertainty changed scaled to TN 1.228), otherwise errors are taken as independent; “<” marks a correlated value that is only a bound' : covLoading() ? ' (loading ATcT covariances…)' : ', with errors taken as independent';
    out.innerHTML = `<div class="panel"><div class="panel-head"><h2>${MODE_LABEL[state.mode]} of ${esc(parent.name)}</h2><span class="badge">${list.length} found</span></div><div class="panel-body">
        ${inBad}${exWait}${inMsg}
        <div class="tc-table-scroll"><table class="tc-table"><thead><tr><th>Products</th><th class="num">${dea ? 'ΔH(0 K)' : 'D₀ / ΔH(0 K)'}, ${unit}</th><th class="num">eV</th><th class="num">cm⁻¹</th>${dea ? '' : '<th class="num">λ max (nm)</th>'}<th class="num">ΔH(298 K)</th><th class="num">±</th>${ein != null ? '<th class="num">Available</th>' : ''}<th></th></tr></thead><tbody>${rows || `<tr><td colspan="${ncol}">No channels: ATcT has no matching fragments.</td></tr>`}</tbody></table></div>
        <p class="hint">Sorted by 0 K energy, in ${unit} unless marked. ${dea ? '' : `“λ max” is the longest wavelength that can open the channel from cold ${esc(parent.formula)} without a barrier; `}“Available” is the ${dea ? 'electron' : 'photon'} energy minus the threshold. ± is the 95 % uncertainty${uHint}. ${hintMode} ${state.ex ? 'Excited products: ATcT’s own entry where ATcT lists the state, otherwise the NIST term value added to the ATcT ground state (sources in the Data &amp; citation tab).' : ''} Search took ${ms.toFixed(0)} ms.</p>
        ${shareBox('channels')}</div></div>`;
    writeURL();
}
/** Message under the parent field when a typed name is not found or not a gas-phase parent. */
function chMiss(q, s) {
    $('ch-out').innerHTML = `<div class="tc-msg tc-bad">${s ? `${esc(s.formula)} (${esc(s.state)}) is not a gas-phase entry with a 0 K value.` : `“${esc(q)}” was not found in ATcT ${esc(db.meta.tn_version || '')}. Try a formula (CH2O), a name or a CAS number.`}</div>`;
}
document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-rx]'); if (!a) return;
    e.preventDefault(); state.rx = a.dataset.rx; state.rxo = {}; $('rx-in').value = state.rx; renderReaction(); showTab('reaction');
});

const openText = (n) => (n === 0 ? 'No channel is open.' : n === 1 ? '1 channel is open.' : `${n} channels are open.`);

/* ── Energy diagram ─────────────────────────────────────────────────── */
let lastSVG = null;
function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, f) => (cs.getPropertyValue(n) || '').trim() || f;
    return {
        bg: v('--surface', '#ffffff'), text: v('--text', '#0f172a'), muted: v('--muted', '#5f6b7e'), grid: v('--border', '#e2e8f0'),
        reactant: v('--text', '#0f172a'), product: v('--c1', '#1d4ed8'), intermediate: v('--c4', '#7c3aed'), ts: v('--c5', '#dc2626'), roaming: v('--c2', '#c2410c'), photon: v('--c3', '#047857'),
    };
}
/** Resolve the diagram inputs: reactants, user levels and product channels, in kJ/mol relative to the reactants. */
function diagramModel() {
    const d = state.dg; const levels = []; const msgs = [];
    const rtext = d.r.trim();
    if (!rtext) return { levels, msgs: ['Enter the reactants.'], ok: false };
    const pr = parseReaction(`${rtext} -> ${rtext}`);   // resolves the reactant side with the reaction parser
    if (pr.error) return { levels, msgs: [pr.error], ok: false };
    const rr = resolveReaction(db, pr);
    if (rr.errors.length) return { levels, msgs: [...new Set(rr.errors)].map((x) => `Reactants: ${x}`), ok: false };
    if (rr.terms.some((t) => t.species && t.species.h0 == null)) return { levels, msgs: ['Reactants: a species has no 0 K value.'], ok: false };
    levels.push({ label: rtext, kj: 0, kind: 'reactant' });
    d.l.forEach(([name, val, un, kind], i) => {
        const x = parseNum(val);
        if (x == null || !Number.isFinite(x)) { msgs.push(`Level ${i + 1}${name ? ` (“${name}”)` : ''}: ${x == null ? 'enter an energy' : `“${val}” is not a number (use a point for decimals, no thousands separators)`}.`); return; }
        levels.push({ label: name || DKINDS[kind], kj: toKJ(x, un), kind, user: true, plain: true });
    });
    const prods = [];
    if (d.p.filter((x) => x.trim()).length > 20) msgs.push('The share link keeps only the first 20 product lines.');
    for (const line of d.p) {
        const t = line.trim(); if (!t) continue;
        const p = parseReaction(`${rtext} -> ${t}`);
        if (p.error) { msgs.push(`“${t}”: ${p.error}`); continue; }
        const r = resolveReaction(db, p);
        if (r.errors.length) { msgs.push(`“${t}”: ${r.errors.join('; ')}`); continue; }
        if (!balance(r.terms).ok) { msgs.push(`“${t}” does not balance against ${rtext}.`); continue; }
        const h = reactionEnthalpy(db, r.terms);
        if (!h || h.h0 == null) { msgs.push(`“${t}”: a species has no 0 K value.`); continue; }
        const bu = bestU(h);
        prods.push({ label: t, kj: h.h0, kind: 'product', u: bu.u, lt: bu.lt, how: bu.how, nist: r.terms.some((x) => x.species && x.species.excited) });
    }
    prods.sort((a, b) => a.kj - b.kj);
    levels.push(...prods);
    const nm = parseNum(d.nm);
    const photon = nm != null && Number.isFinite(nm) && nm >= 1 && nm <= 1e6 ? { kj: nmToKJ(nm), label: `hν ${num(nm, nm < 10 ? 3 : 1)} nm` } : null;
    if (d.nm && !photon) msgs.push(`“${d.nm}” is not a usable wavelength: enter a number of nanometres from 1 to 1 000 000.`);
    return { levels, msgs, photon, ok: true };
}
function renderDiagramInputs() {
    const d = state.dg;
    $('dg-r').value = d.r; $('dg-p').value = d.p.join('\n'); $('dg-nm').value = d.nm; $('dg-c').value = d.c;
    $('dg-levels').innerHTML = d.l.map(([name, val, un, kind], i) => `<div class="tc-lvl" data-i="${i}">
        <input class="input" data-f="0" aria-label="Level ${i + 1} name" placeholder="name, e.g. TS1" value="${esc(name)}" spellcheck="false">
        <input class="input tc-mono" data-f="1" aria-label="Level ${i + 1} energy relative to the reactants" inputmode="decimal" placeholder="energy" value="${esc(val)}">
        <select class="input" data-f="2" aria-label="Level ${i + 1} unit">${UNITS.map((u) => `<option value="${esc(u)}"${u === un ? ' selected' : ''}>${u === 'Eh' ? 'hartree' : esc(u)}</option>`).join('')}</select>
        <select class="input" data-f="3" aria-label="Level ${i + 1} kind">${['ts', 'intermediate', 'roaming'].map((k) => `<option value="${k}"${k === kind ? ' selected' : ''}>${DKINDS[k]}</option>`).join('')}</select>
        <button type="button" class="btn btn-ghost btn-sm" data-del="${i}" aria-label="Remove level ${i + 1}">Remove</button></div>`).join('');
}
function renderDiagram() {
    if (!db) return;
    needFor('diagram');
    const m = diagramModel();
    const wrap = $('dg-svg-wrap');
    const avail = Math.max(300, wrap.clientWidth || 640);
    const msgs = m.msgs.map((x) => `<p class="tc-msg tc-bad">${esc(x)}</p>`).join('');
    $('dg-share').innerHTML = shareBox('diagram');
    if (!m.ok || m.levels.length < 2) {
        lastSVG = null;
        wrap.innerHTML = ''; $('dg-msgs').innerHTML = msgs || '<p class="tc-msg">Add at least one product channel or level.</p>'; $('dg-table').innerHTML = '';
        $('dg-dl-svg').disabled = true; $('dg-dl-png').disabled = true; writeURL(); return;
    }
    const dg = buildDiagram({ unit, levels: m.levels, photon: m.photon, connect: state.dg.c, title: `Energy diagram: ${state.dg.r}` }, { width: avail, colors: themeColors() });
    lastSVG = dg;
    wrap.innerHTML = dg.svg;
    $('dg-msgs').innerHTML = msgs;
    $('dg-dl-svg').disabled = false; $('dg-dl-png').disabled = false;
    const u2 = unit === 'eV' ? 'cm⁻¹' : 'eV'; const d2 = unit === 'eV' ? 1 : 4;
    $('dg-table').innerHTML = `<div class="tc-table-scroll"><table class="tc-table"><thead><tr><th>Level</th><th>Kind</th><th class="num">${unit}</th><th class="num">${u2}</th><th class="num">±</th><th>Source</th></tr></thead><tbody>${m.levels.map((l) => `<tr><td>${esc(l.label)}</td><td>${esc(DKINDS[l.kind])}</td><td class="num">${num(fromKJ(l.kj, unit), DIGITS[unit])}</td><td class="num">${num(fromKJ(l.kj, u2), d2)}</td><td class="num">${l.u != null ? PM({ u: l.u, lt: l.lt }).replace(/^± /, '') + (l.how === 'correlated' ? CMARK : '') : '—'}</td><td class="tc-state">${l.kind === 'reactant' ? 'zero of the scale' : l.user ? 'your input' : `ATcT ${esc(db.meta.tn_version || '')}${l.nist ? ' + NIST term value' : ''}, 0 K`}</td></tr>`).join('')}${m.photon ? `<tr><td>${esc(m.photon.label)}</td><td>Photon</td><td class="num">${num(fromKJ(m.photon.kj, unit), DIGITS[unit])}</td><td class="num">${num(fromKJ(m.photon.kj, u2), d2)}</td><td></td><td class="tc-state">N<sub>A</sub>hc/λ</td></tr>` : ''}</tbody></table></div>${m.levels.some((l) => l.how === 'correlated') ? '<p class="hint"><sup>c</sup> correlated uncertainty from ATcT covariances; “<” a correlated value that is only a bound.</p>' : ''}`;
    writeURL();
}
function download(name, blob) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
const dgName = () => `energy-diagram-${(state.dg.r || 'reactants').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 30)}`;
function downloadPNG() {
    if (!lastSVG) return;
    const scale = 2; const d = lastSVG;
    const img = new Image();
    const url = URL.createObjectURL(new Blob([d.svg], { type: 'image/svg+xml' }));
    img.onload = () => {
        const cv = document.createElement('canvas'); cv.width = d.width * scale; cv.height = d.height * scale;
        const cx = cv.getContext('2d'); cx.scale(scale, scale); cx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        cv.toBlob((b) => { if (b) download(`${dgName()}.png`, b); }, 'image/png');
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
}
function initDiagram() {
    const upd = () => renderDiagram();
    let tmr = 0;
    const later = () => { clearTimeout(tmr); tmr = setTimeout(upd, 200); };
    $('dg-r').addEventListener('input', () => { state.dg.r = $('dg-r').value; later(); });
    $('dg-p').addEventListener('input', () => { state.dg.p = $('dg-p').value.split('\n'); later(); });
    $('dg-nm').addEventListener('input', () => { state.dg.nm = $('dg-nm').value.trim(); later(); });
    $('dg-c').addEventListener('change', () => { state.dg.c = $('dg-c').value; upd(); });
    $('dg-add').addEventListener('click', () => {
        if (state.dg.l.length >= 20) { $('dg-msgs').insertAdjacentHTML('afterbegin', '<p class="tc-msg tc-bad">At most 20 levels.</p>'); return; }
        state.dg.l.push(['', '', unit, 'ts']); renderDiagramInputs(); upd();
        const r = $('dg-levels').lastElementChild; if (r) r.querySelector('input').focus();
    });
    $('dg-levels').addEventListener('input', (e) => {
        const row = e.target.closest('.tc-lvl'); if (!row || e.target.tagName !== 'INPUT') return;
        state.dg.l[+row.dataset.i][+e.target.dataset.f] = e.target.value; later();
    });
    $('dg-levels').addEventListener('change', (e) => {
        const row = e.target.closest('.tc-lvl'); if (!row || e.target.tagName !== 'SELECT') return;
        state.dg.l[+row.dataset.i][+e.target.dataset.f] = e.target.value; upd();
    });
    $('dg-levels').addEventListener('click', (e) => {
        const b = e.target.closest('[data-del]'); if (!b) return;
        const i = +b.dataset.del;
        state.dg.l.splice(i, 1); renderDiagramInputs(); upd();
        // keep keyboard focus in the list: the next Remove button, else Add a level
        const n = state.dg.l.length;
        const next = n ? $('dg-levels').querySelector(`[data-del="${Math.min(i, n - 1)}"]`) : null;
        (next || $('dg-add')).focus();
    });
    $('dg-fill').addEventListener('click', () => {
        if (!db) return;
        const r = resolveToken(db, state.dg.r.trim());
        if (!r.species || !r.species.gas || r.species.h0 == null) { $('dg-msgs').innerHTML = '<p class="tc-msg tc-bad">“Add the lowest channels” needs a single gas-phase reactant.</p>'; return; }
        const have = new Set(state.dg.p.map((x) => x.trim()).filter(Boolean));
        const add = findChannels(db, r.species, 'neutral', { limit: 8 }).map((c) => c.products.map(txt).join(' + ')).filter((x) => !have.has(x)).slice(0, 4);
        state.dg.p = [...have, ...add];
        renderDiagramInputs(); upd();
    });
    $('dg-reset').addEventListener('click', () => { state.dg = structuredClone(DG_DEFAULT); renderDiagramInputs(); upd(); });
    $('dg-dl-svg').addEventListener('click', () => { if (lastSVG) download(`${dgName()}.svg`, new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${lastSVG.svg}`], { type: 'image/svg+xml' })); });
    $('dg-dl-png').addEventListener('click', downloadPNG);
    // redraw on a theme change and on a width change
    const redraw = () => { if (state.tab === 'diagram' && db) renderDiagram(); };
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw); } catch { /* older browsers */ }
    new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    let rt = 0; let lastW = window.innerWidth;
    window.addEventListener('resize', () => { if (window.innerWidth === lastW) return; lastW = window.innerWidth; clearTimeout(rt); rt = setTimeout(redraw, 150); });
    renderDiagramInputs();
}

/* ── Units ──────────────────────────────────────────────────────────── */
function renderUnits() {
    state.uv = $('un-v').value; state.uu = $('un-u').value;
    const v = parseFloat(state.uv.replace(/−/g, '-'));
    const out = $('un-out');
    if (!Number.isFinite(v)) { out.innerHTML = '<div class="tc-msg tc-bad">Enter a number.</div>'; writeURL(); return; }
    const kj = state.uu === 'nm' ? nmToKJ(v) : toKJ(v, state.uu);
    if (kj == null) { out.innerHTML = '<div class="tc-msg tc-bad">A wavelength must be positive.</div>'; writeURL(); return; }
    const rows = [...UNITS.map((u) => [u === 'Eh' ? 'hartree' : u, num(fromKJ(kj, u), Math.max(DIGITS[u] + 2, 4))]), ['nm (photon, vacuum)', kj > 0 ? num(kjToNm(kj), 3) : '—'], ['aJ per molecule (10⁻¹⁸ J)', num(kj / 6.02214076e23 * 1e21, 6)]];
    out.innerHTML = `<div class="tc-table-scroll"><table class="tc-table"><tbody>${rows.map(([u, s]) => `<tr><th>${u}</th><td class="num">${s}</td></tr>`).join('')}</tbody></table></div>${shareBox('units')}`;
    writeURL();
}

/* ── Self-test ──────────────────────────────────────────────────────── */
function renderSelfTest() {
    const root = $('st-root');
    if (!db) { root.innerHTML = '<p class="hint">Loading the ATcT table…</p>'; return; }
    needFor('selftest');
    const waiting = ['cov', 'exc', 'diff'].filter((k) => (k === 'exc' || db.isShipped) && !db[k] && extra[k] !== false);
    const res = CASES.map((c) => runCase(db, c));
    const ext = extraChecks(db);
    const counted = [...res, ...ext].filter((x) => x.pass !== null);
    const nPass = counted.filter((x) => x.pass).length;
    const nAll = counted.length;
    const nNA = res.length + ext.length - nAll;
    const badge = (ok) => (ok === null ? '<span class="badge">N/A</span>' : `<span class="badge ${ok ? 'badge-ok' : 'badge-bad'}">${ok ? 'PASS' : 'FAIL'}</span>`);
    const showVal = (r) => {
        if (r.value == null) return esc(r.errors.join('; '));
        const main = r.show === 'nm' ? `${num(kjToNm(r.value), 2)} nm` : `${num(fromKJ(r.value, r.show), DIGITS[r.show] + 1)} ${r.show}`;
        return `${main}<br>${num(r.value, 3)} kJ/mol${r.nm ? `<br>${num(kjToNm(r.value), 2)} nm` : ''}`;
    };
    const caseRow = (r) => `<tr><th scope="row">${r.title}<br><span class="tc-state tc-mono">${esc(r.rxn)}</span></th><td class="num">${showVal(r)}</td><td class="num">${minus(String(r.ref.v))} ± ${r.ref.u} ${r.ref.unit}<br>${num(r.refKJ, 4)} kJ/mol</td><td class="num">${num(r.diff, 4)}</td><td class="num">± ${num(r.tol, 4)}</td><td>${badge(r.pass)}${r.pass !== null && !r.tableOk ? '<br><span class="tc-state">table value changed</span>' : ''}</td><td class="tc-state">${r.href ? `<a href="${esc(r.href)}" target="_blank" rel="noopener">${esc(r.src)}</a>` : esc(r.src)}${r.tolNote ? `<br>Tolerance: ${esc(r.tolNote)}.` : ''}${KINDS[r.kind] ? `<br><span class="tc-tag">${esc(KINDS[r.kind])}</span>` : ''}</td></tr>`;
    const groups = [['units', 'Unit factors (CODATA 2022)'], ['lookup', 'Formula, ion and state-label lookup'], ['balance', 'Balance and uncertainty (ATcT covariances)'], ['excited', 'Excited-state and electron-attachment bookkeeping'], ['diagram', 'Energy diagram and version diff']];
    root.innerHTML = `<div class="panel"><div class="panel-head"><h2>Self-test</h2><span class="badge ${nPass === nAll ? 'badge-ok' : 'badge-bad'}">${nPass} / ${nAll}</span></div><div class="panel-body">
        <p class="tc-st-summary">${nPass} of ${nAll} checks passed with the loaded table (ATcT TN ${esc(db.meta.tn_version || '?')})${nNA ? `; ${nNA} not applicable to this table` : ''}${waiting.length ? ` (still loading: ${waiting.join(', ')})` : ''}.</p>
        <p class="hint">Each reaction is recomputed from the loaded table and checked twice. First against the value hand-computed from ATcT TN 1.228 (plus, for excited products, the NIST term value) to 0.0015 kJ/mol, which catches data, parsing and arithmetic errors. Then against a reference value, passing when |Δ| ≤ √(U<sub>tool</sub>² + U<sub>ref</sub>²) at 95 %; for a threshold quoted to a rounded wavelength or energy, U<sub>ref</sub> is that rounding.</p>
        <p class="hint"><strong>Most references are not independent tests of ATcT.</strong> Seven are measurements that ATcT itself uses as inputs (its 1.228 species pages list them), and D₀(H–CH₃) comes from an ATcT-group analysis of such inputs, so agreement is expected. H₂CO → H₂ + CO is compared with the previous ATcT version (TN 1.220). IE(H) can agree only to ATcT's printed rounding. The “quoted” thresholds (O₃ at ≈310 nm, N₂O at 341 nm, and all three H₂O + e⁻ asymptotes of Haxton et al.: 3.56, 4.35 and 8.38 eV) come from other groups, who computed them from older thermochemistry and quote them rounded; each row states the tolerance used and why, so they test the bookkeeping of excited products and attached electrons, not the last digit. H₂O → H + OH(A) adds the same NIST term value the tool adds, so it checks bookkeeping only. The checks show that this tool reproduces ATcT and its sources, not that they are right.</p>
        <div class="tc-table-scroll"><table class="tc-table tc-st-table"><thead><tr><th>Check</th><th class="num">This tool</th><th class="num">Reference</th><th class="num">Δ</th><th class="num">Tolerance</th><th>Result</th><th>Source</th></tr></thead><tbody>
        <tr class="tc-st-group"><th colspan="7">Bond, ionization and appearance energies (0 K)</th></tr>
        ${res.filter((r) => r.group !== 'excited').map(caseRow).join('')}
        <tr class="tc-st-group"><th colspan="7">Excited products and electron attachment (0 K)</th></tr>
        ${res.filter((r) => r.group === 'excited').map(caseRow).join('')}
        ${groups.map(([g, label]) => `<tr class="tc-st-group"><th colspan="7">${label}</th></tr>
        ${ext.filter((x) => x.group === g).map((x) => `<tr><th scope="row">${esc(x.title)}</th><td colspan="4" class="tc-state">${esc(x.detail)}</td><td>${badge(x.pass)}</td><td></td></tr>`).join('')}`).join('')}
        </tbody></table></div><p class="hint">Δ and tolerance in kJ/mol.</p></div></div>`;
}

/* ── Data tab ───────────────────────────────────────────────────────── */
function renderData() {
    const m = db.meta;
    $('dt-meta').innerHTML = `${esc(m.source || '')}, Thermochemical Network version <strong>${esc(m.tn_version || '?')}</strong>${m.as_of ? ` (as of ${esc(m.as_of)})` : ''}${m.downloaded ? `, downloaded ${esc(m.downloaded)}` : ''}. ${db.species.length} species; ${db.species.filter((s) => s.gas).length} in the gas phase. ${m.url ? `Source: <a href="${esc(m.url)}" target="_blank" rel="noopener">ATcT table</a>.` : ''}`;
    $('dt-cite').innerHTML = (m.citation || []).map((c) => `<li>${esc(c).replace(/doi:(\S+)/, (x, d) => `<a href="https://doi.org/${esc(d)}" target="_blank" rel="noopener">doi:${esc(d)}</a>`)}</li>`).join('') || '<li>Cite the source of the table you loaded.</li>';
    $('tc-source').innerHTML = `Values: <strong>ATcT ${esc(m.tn_version || '')}</strong>${m.as_of ? ` (${esc(m.as_of)})` : ''}, Argonne National Laboratory. Uncertainties are 95 %. <a href="#" id="tc-cite-link">How to cite</a>`;
    $('tc-cite-link').onclick = (e) => { e.preventDefault(); showTab('data', true); };
    renderExcitedRefs();
}
/** Per-state primary references of the NIST excited-state list (they come with the list). */
function renderExcitedRefs() {
    const el = $('dt-exrefs'); if (!el) return;
    if (!db.exc) {
        el.innerHTML = extra.exc === false ? `<p class="hint">The excited-state list could not be loaded${extraErr.exc ? ` (${esc(extraErr.exc)})` : ''}.</p>` : '<p><button type="button" class="btn btn-ghost btn-sm" id="dt-exload">Show the primary reference for each state</button></p>';
        const b = $('dt-exload'); if (b) b.onclick = () => { focusExRefs = true; b.textContent = 'Loading…'; need('exc'); };
        return;
    }
    const byKey = new Map();
    for (const l of db.exc.byGround.values()) for (const st of l) for (const k of st.refs) push2(byKey, k, `${st.species}(${stateText(st)})`);
    const refs = db.exc.refs;
    const wasFocus = focusExRefs; focusExRefs = false;
    el.innerHTML = `<details${wasFocus ? ' open' : ''}><summary>Primary reference for each state (${byKey.size} papers)</summary><ol class="refs tc-exrefs">${[...byKey.entries()].map(([k, sts]) => { const r = refs[k]; if (!r) return ''; const link = r[1] ? ` <a href="https://doi.org/${esc(r[1])}" target="_blank" rel="noopener">doi:${esc(r[1])}</a>` : r[2] ? ` <a href="${esc(r[2])}" target="_blank" rel="noopener">link</a>` : ''; return `<li>${esc(r[0])}${link} <span class="tc-state">(${esc(sts.join(', '))})</span></li>`; }).join('')}</ol></details>`;
    if (wasFocus) { const sm = el.querySelector('summary'); if (sm) sm.focus(); }
}
let focusExRefs = false;
function push2(map, k, v) { const a = map.get(k); if (a) { if (!a.includes(v)) a.push(v); } else map.set(k, [v]); }
function initData() {
    $('dt-file').addEventListener('change', async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try {
            const payload = payloadFromCSV(await f.text(), `User CSV “${f.name}”`);
            if (!payload.rows.length) throw new Error(payload.meta.skipped ? `no usable rows: all ${payload.meta.skipped} rows lack a readable composition, charge or ΔfH°(298.15 K)` : 'no usable rows');

            db = buildDB(payload);
            attachTo(db, 'exc');
            const skip = payload.meta.skipped ? ` Skipped ${payload.meta.skipped} row(s) whose composition, charge or ΔfH°(298.15 K) could not be read.` : '';
            $('dt-status').textContent = `Loaded ${payload.rows.length} species from ${f.name}.${skip} Results now use your table (without ATcT covariances or the version diff); the citation is yours to supply.`;

            $('dt-reset').hidden = false; rerender();
        } catch (err) { $('dt-status').textContent = `Could not read ${f.name}: ${err.message}.`; }
    });
    $('dt-reset').addEventListener('click', () => { db = shippedDB(); $('dt-reset').hidden = true; $('dt-status').textContent = 'Back to the shipped ATcT TN 1.228 table.'; rerender(); });
}
function shippedDB() {
    const d = buildDB(shipped); d.isShipped = true;
    for (const k of ['cov', 'exc', 'diff']) attachTo(d, k);
    return d;
}

function rerender() {
    renderData(); renderSpecies(); renderReaction(); renderChannels(); renderUnits();
    if (state.tab === 'selftest') renderSelfTest();
    if (state.tab === 'diagram') renderDiagram();
}

/* ── boot ───────────────────────────────────────────────────────────── */
async function boot() {
    readURL();
    initTabs();
    $('tc-unit').value = unit;
    $('tc-unit').addEventListener('change', () => { unit = $('tc-unit').value; rerender(); });
    $('rx-in').value = state.rx;
    $('un-v').value = state.uv; $('un-u').value = state.uu;
    $('rx-examples').innerHTML = EXAMPLES.map((x) => `<button type="button">${esc(x)}</button>`).join('');
    $('rx-examples').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; $('rx-in').value = b.textContent; state.rxo = {}; renderReaction(); });
    let tmr = 0;
    $('rx-in').addEventListener('input', () => { clearTimeout(tmr); state.rxo = {}; tmr = setTimeout(renderReaction, 200); });
    $('un-v').addEventListener('input', renderUnits); $('un-u').addEventListener('change', renderUnits);
    $('ch-nm').addEventListener('input', () => { if (state.mode === 'dea') state.ee = $('ch-nm').value; else state.nm = $('ch-nm').value; clearTimeout(tmr); tmr = setTimeout(renderChannels, 200); });
    $('ch-mode').addEventListener('change', () => { state.mode = $('ch-mode').value; renderChannels(); });
    $('ch-three').addEventListener('change', () => { state.three = $('ch-three').checked; renderChannels(); });
    $('ch-labeled').addEventListener('change', () => { state.lab = $('ch-labeled').checked; renderChannels(); });
    $('ch-ex').addEventListener('change', () => { state.ex = $('ch-ex').checked; renderChannels(); });
    $('ch-fine').addEventListener('change', () => { state.fine = $('ch-fine').checked; renderChannels(); });
    initData();
    initDiagram();
    showTab(state.tab);
    try {
        const r = await fetch(DATA_URL);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        shipped = await r.json();
        db = shippedDB();
    } catch (err) {
        $('tc-source').innerHTML = `Could not load the ATcT table (${esc(err.message)}). Load a CSV in the <a href="?tab=data">Data &amp; citation</a> tab.`;
        return;
    }
    combo($('sp-q'), $('sp-list'), (s) => { state.sp = s.id; $('sp-q').value = s.formula; renderSpecies(); },
        () => true, (q) => { state.sp = ''; $('sp-card').innerHTML = `<div class="tc-msg tc-bad">“${esc(q)}” was not found in ATcT ${esc(db.meta.tn_version || '')}. Try a formula (CH2O), a name, a CAS number or an InChIKey.</div>`; writeURL(); });
    combo($('ch-q'), $('ch-list'), (s) => { state.ch = s.id; $('ch-q').value = s.formula; renderChannels(); }, (s) => s.gas && s.h0 != null, chMiss);
    if (!state.sp) state.sp = '50-00-0*0';
    const s0 = db.byId.get(state.sp); $('sp-q').value = s0 ? s0.formula : '';
    const c0 = db.byId.get(state.ch); $('ch-q').value = c0 ? c0.formula : '';
    rerender();
    window.__thermochem = { db: () => db, CASES, runCase, extraChecks, extra: () => extra };
}
boot();
