// Thermochemistry Lab (beta): UI. Data: ./data/atct-current.json names the ATcT table and covariance files of one TN
// version (both retrieved from the ATcT API by _scripts/atct_sync.py); the table is loaded at start, the covariances and
// the NIST excited states only when a view needs them. Engine: ./engine.js.
import {
    buildDB, payloadFromCSV, search, resolveToken, parseReaction, resolveReaction, balance, reactionEnthalpy,
    findChannels, ionizationEnergies, electronAffinities, protonAffinities, sameComposition, coreFormula,
    attachCov, attachExcited, excitedStates, excitedThresholds, excitedTerms, bestU, stateText,
    stateToken, unboundAnion, parseNum, uncertaintyBudget, UNITS, KJ_NM, toKJ, fromKJ, kjToNm, nmToKJ,
} from './engine.js';
import { photofragments, vmi, dopplerShift, collisionFrame, collisionChannels, labForCM } from './kinematics.js';
import { buildDiagram, KINDS as DKINDS } from './diagram.js';
import { CASES, KINDS, HAND_TN, runCase, extraChecks } from './selftest.js';

const $ = (id) => document.getElementById(id);
const CURRENT_URL = './data/atct-current.json';   // { version, fetched, doi, files: { table, cov }, ... }
const EXC_URL = './data/excited-states.json';
let current = null;
const dataURL = (f) => `./data/${encodeURIComponent(f)}`;
const atctBase = () => `https://atct.anl.gov/Thermochemical%20Data/version%20${encodeURIComponent(current ? current.version : (shipped && shipped.meta.tn_version) || '')}/`;
const TABS = ['channels', 'recoil', 'collide', 'reaction', 'diagram', 'species', 'units', 'selftest', 'data'];
const DIGITS = { 'kJ/mol': 3, 'kcal/mol': 3, 'eV': 4, 'cm⁻¹': 1, 'K': 0, 'Eh': 6 };
const DG_DEFAULT = { r: 'CH2O', p: ['H + HCO', 'H2 + CO', 'H + H + CO'], l: [], nm: '', c: 'fan' };

let shipped = null;   // payload as shipped
let db = null;
let unit = 'kJ/mol';
const state = {
    tab: 'channels', sp: '', rx: 'CH2O -> H + HCO', rxo: {}, ch: '50-00-0*0', nm: '', ee: '', mode: 'neutral', three: false, lab: false,
    ex: false, fine: true, uv: '30328.5', uu: 'cm⁻¹', dg: structuredClone(DG_DEFAULT),
    rc: 'CH3I -> CH3 + I', rnm: '266', rn: '1', rpi: '', rpp: '', rL: '500', rV: '3000', rN: '1', rE: '', rpr: '',
    cp: '14158-23-7*0', ct: '7782-44-7*0', ce: '10', cthree: false, cion: false, clab: false,
};
const RC_KEYS = ['rc', 'rnm', 'rn', 'rpi', 'rpp', 'rL', 'rV', 'rN', 'rE', 'rpr'];
const RC_DEFAULT = Object.fromEntries(RC_KEYS.map((k) => [k, state[k]]));
const CL_KEYS = ['cp', 'ct', 'ce'];

/* ── lazy data ──────────────────────────────────────────────────────── */
// Each extra file is fetched once, on first need. The covariances belong to ATcT's IDs and version, so they attach to
// the shipped table only; the excited states attach to any table by ATcT ID.
const extra = { cov: null, exc: null };
const extraErr = {};
const pending = {};
let covFileTN = null;   // tn_version of the covariance file as loaded, attached or not (for the self-test)
function need(kind) {
    if (!db || extra[kind] === false) return;
    if (kind !== 'exc' && !db.isShipped) return;
    if (extra[kind]) { if (!db[kind]) attachTo(db, kind); return; }
    if (pending[kind]) return;
    if (kind === 'cov' && !(current && current.files && current.files.cov)) { extra.cov = false; extraErr.cov = 'not listed in atct-current.json'; return; }
    const url = kind === 'cov' ? dataURL(current.files.cov) : EXC_URL;
    pending[kind] = fetch(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((j) => { extra[kind] = j; attachTo(db, kind); rerender(); })
        .catch((err) => { extra[kind] = false; extraErr[kind] = err.message; rerender(); });
}
function attachTo(d, kind) {
    if (!extra[kind]) return;
    if (kind === 'cov' && d.isShipped) {
        covFileTN = extra.cov.tn_version;
        // engine.attachCov refuses a file of another TN version than the table: say why instead of waiting for it
        if (!attachCov(d, extra.cov)) {
            extraErr.cov = `the covariance file is TN ${covFileTN}, the table TN ${d.meta.tn_version || '?'}, and versions are not mixed`;
            extra.cov = false;
        }
    }
    if (kind === 'exc') attachExcited(d, extra.exc);
}
const covLoading = () => db && db.isShipped && !db.cov && extra.cov === null;
/** Files each tab needs; requested only while that tab is shown, so the default view loads just the main table. */
function needFor(t) {
    if (!db) return;
    if (t === 'species') need('exc');
    if (t === 'reaction' || t === 'diagram' || t === 'selftest') { need('cov'); need('exc'); }
    if (t === 'channels') { need('cov'); if (state.ex) need('exc'); }
    if (t === 'recoil') { need('cov'); need('exc'); }
    if (t === 'collide') need('cov');
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
const atctLink = (s) => (s.n && !s.isElectron ? `${atctBase()}species/?species_number=${s.n}` : null);
const txt = (s) => (s.isElectron ? 'e-' : `${s.formula}${s.plainState ? '' : `(${s.state})`}`);

/* ── URL state ──────────────────────────────────────────────────────── */
function readURL() {
    const p = new URLSearchParams(location.search);
    if (TABS.includes(p.get('tab'))) state.tab = p.get('tab');
    for (const k of ['sp', 'rx', 'ch', 'nm', 'ee', 'mode', 'uv', 'uu', ...RC_KEYS, ...CL_KEYS]) if (p.has(k)) state[k] = p.get(k);
    if (!['1', '2', '3', '4'].includes(state.rn)) state.rn = '1';
    state.cthree = p.get('cthree') === '1'; state.cion = p.get('cion') === '1'; state.clab = p.get('clab') === '1';
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
    if (tab === 'recoil') for (const k of RC_KEYS) if (k === 'rc' || k === 'rnm' || state[k] !== RC_DEFAULT[k]) p.set(k, state[k]);
    if (tab === 'collide') {
        for (const k of CL_KEYS) if (state[k]) p.set(k, state[k]);
        if (state.cthree) p.set('cthree', '1'); if (state.cion) p.set('cion', '1'); if (state.clab) p.set('clab', '1');
    }
    return `${location.pathname}?${p.toString()}`;
}
const writeURL = () => { try { history.replaceState(null, '', urlFor(state.tab)); } catch { /* file:// or sandbox */ } };
function shareBox(tab) {
    const url = new URL(urlFor(tab), location.href).href;
    const what = { channels: 'channel list', diagram: 'diagram', recoil: 'recoil calculation', collide: 'collision', species: 'lookup' }[tab] || tab;
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
    if (t === 'recoil' && db) renderRecoil();
    if (t === 'collide' && db) renderCollide();
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
        <div class="tc-card-head"><h2>${esc(s.name)}</h2>${sp(s)}${link ? `<a class="btn btn-secondary btn-sm" href="${link}" target="_blank" rel="noopener">Full entry and provenance on ATcT ↗</a>` : ''}</div>
        <div class="tc-results" style="margin-top:1rem">
            <div class="tc-res"><h3>Δ<sub>f</sub>H°(0 K)</h3><div class="tc-big">${E(s.h0)}</div><div class="tc-alt">${s.h0 == null ? 'not given for this phase' : `± ${E(s.u)} (95 %, the 298.15 K value)`}</div></div>
            <div class="tc-res"><h3>Δ<sub>f</sub>H°(298.15 K)</h3><div class="tc-big">${E(s.h298)}</div><div class="tc-alt">± ${E(s.u)} (95 %, 298.15 K)<br>${s.mass != null ? `${s.mass} g/mol` : ''}</div>${s.q ? '<p class="tc-note">Ion: stationary-electron convention at 298.15 K.</p>' : ''}</div>
            ${rel(ies, 'Adiabatic ionization energy', (x) => `<div class="tc-alt">→ ${sp(x.ion)}: <strong>${E(x.kj, x.u, 'eV')}</strong><br>${ieAlt(x.kj)}</div>`)}
            ${rel(eas, 'Electron affinity', (x) => `<div class="tc-alt">${sp(x.ion)}: <strong>${E(x.kj, x.u, 'eV')}</strong><br>${E(x.kj, null, 'cm⁻¹')}</div>`)}
            ${rel(pas, 'Proton affinity (298.15 K)', (x) => `<div class="tc-alt">→ ${sp(x.ion)}: <strong>${E(x.kj, x.u)}</strong></div>`)}
        </div>
        <p class="hint">Values of ATcT ${esc(db.meta.tn_version || '')}${db.isShipped && current && current.fetched ? `, retrieved from the ATcT API on ${esc(current.fetched.slice(0, 10))}` : ''}. The ± is ATcT's 95 % uncertainty of Δ<sub>f</sub>H°(298.15 K); ATcT tabulates no separate 0 K uncertainty, so the same value is shown at 0 K (see “Uncertainty” below the tool). The ionization energy, electron affinity and proton affinity are differences computed here. Names, identifiers and the measurements behind the value are on ATcT's page.</p>
        <div class="tc-actions">
            ${s.gas && s.h0 != null ? '<button type="button" class="btn btn-primary btn-sm" id="sp-ch">Bonds and photolysis</button><button type="button" class="btn btn-secondary btn-sm" id="sp-cl">Collide a beam with it</button>' : ''}
            <button type="button" class="btn btn-secondary btn-sm" id="sp-rx">Use in a reaction</button>
        </div>
        ${shareBox('species')}
    </div></div>
    ${exs.length ? `<div class="panel"><div class="panel-head"><h2>Low-lying electronic states</h2><span class="badge">${exs.length}</span></div><div class="panel-body tc-table-scroll"><table class="tc-table"><thead><tr><th>State</th><th class="num">T₀, cm⁻¹</th><th class="num">± cm⁻¹</th><th class="num">${unit}</th><th class="num">Δ<sub>f</sub>H°(0 K), ${unit}</th><th>Source</th></tr></thead><tbody>${exs.map((x) => `<tr><td>${F(x.species)}(${stHTML(x)})${x.note && !x.atom ? ` <span class="tc-state">${esc(x.note)}</span>` : ''}${x.fine ? ' <span class="tc-tag">fine structure</span>' : ''}</td><td class="num">${num(fromKJ(x.kj, 'cm⁻¹'), 1)}</td><td class="num">${x.atct ? '<span class="tc-state">ATcT</span>' : x.uCm1 ? (x.uCm1 < 0.0005 ? '&lt; 0.001' : num(x.uCm1, x.uCm1 < 0.1 ? 3 : 1)) : '—'}</td><td class="num">${num(fromKJ(x.kj, unit), DIGITS[unit])}</td><td class="num">${num(fromKJ(x.h0, unit), DIGITS[unit])}</td><td class="tc-state">${srcHTML(x)}</td></tr>`).join('')}</tbody></table><p class="hint">Term values T₀ above the lowest level of ${esc(s.formula)}. Where ATcT lists the state, ATcT's value is used (the NIST value is shown in brackets); otherwise Δ<sub>f</sub>H°(0 K) = ATcT ground state + NIST T₀. “± cm⁻¹” is the term value's own uncertainty where the source gives one, plus an allowance where the source refers the state to a level other than the lowest (a multiplet centre, a hypothetical J = 0 level; see the notes); “—” means the source gives none, and the value is taken as exact. Sources are in the <a href="#" data-tab="data">Data &amp; citation</a> tab.</p></div></div>` : ''}
    ${same.length ? `<div class="panel"><div class="panel-body"><details class="tc-more"><summary>Same composition: ${same.length} other isomer${same.length === 1 ? '' : 's'}, state${same.length === 1 ? '' : 's'} or phase${same.length === 1 ? '' : 's'}, with relative energies</summary><div class="tc-table-scroll"><table class="tc-table"><thead><tr><th>Species</th><th>Name</th><th class="num">Δ<sub>f</sub>H°(0 K)</th><th class="num">Δ<sub>f</sub>H°(298 K)</th><th class="num">± (95 %, 298.15 K)</th><th class="num">Relative, 0 K</th></tr></thead><tbody>${same.map((x) => `<tr><td><a href="#" data-sp="${esc(x.id)}">${sp(x)}</a></td><td>${esc(x.name)}</td><td class="num">${num(x.h0 != null ? fromKJ(x.h0, unit) : null, DIGITS[unit])}</td><td class="num">${num(fromKJ(x.h298, unit), DIGITS[unit])}</td><td class="num">${U(x.u)}</td><td class="num">${x.h0 != null && s.h0 != null ? num(fromKJ(x.h0 - s.h0, unit), DIGITS[unit]) : '—'}</td></tr>`).join('')}</tbody></table><p class="hint">Energies in ${unit}. “Relative” is the 0 K energy above ${esc(s.formula)} (${esc(s.state)}).</p></div></details></div></div>` : ''}`;
    if ($('sp-ch')) $('sp-ch').onclick = () => { state.ch = s.id; $('ch-q').value = s.formula; renderChannels(); showTab('channels'); };
    if ($('sp-cl')) $('sp-cl').onclick = () => { state.ct = s.id; $('cl-t').value = s.formula; renderCollide(); showTab('collide'); };
    $('sp-rx').onclick = () => { state.rx = `${s.formula}${s.plainState ? '' : `(${s.state})`} -> `; $('rx-in').value = state.rx; state.rxo = {}; showTab('reaction'); $('rx-in').focus(); renderReaction(); };
    writeURL();
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
        return `<p class="tc-note">Used: independent errors. Correlated: not available, because ${miss || 'a species'} ${c.missing.length > 1 ? 'are' : 'is'} not in the covariance file (${db.cov.ids.length} gas-phase species of TN ${esc(c.tn)}).</p>`;
    }
    const dd = (u) => Math.max(dig, uDigits(fromKJ(u, unit)));   // as many digits as the headline value shows
    const val = (u, lt) => (u != null ? `± ${E(u, null, unit, dd(u))}` : `< ${E(lt, null, unit, dd(lt))}`);
    return `<table class="tc-utable"><tbody>
        <tr><th>Correlated <span class="tc-tag">used</span></th><td class="num">${val(c.u, c.lt)}</td></tr>
        <tr><th>Independent errors</th><td class="num">± ${E(h.u, null, unit, dd(h.u))}</td></tr></tbody></table>
        <p class="tc-note">95 % uncertainties. Correlated = √(νᵀCν) with ATcT's covariances of TN ${esc(c.tn)}, the version of the values (Δ<sub>f</sub>H° at ${c.T} K). It is applied to the 0 K values too, as ATcT tabulates only the 298.15 K uncertainty${xterm ? '; the term-value uncertainty of a NIST state is added independently' : ''}.${c.u == null ? ' The terms cancel to below the precision of the stored correlations, so only a bound is given.' : ''}</p>`;
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
    <div class="panel"><div class="panel-head"><h2>Result</h2></div><div class="panel-body">${res}${shareBox('reaction')}</div></div>
    ${h && bal.ok ? budgetPanel(r.terms) : ''}`;
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
        return `<tr class="${op === false ? 'tc-closed' : ''}"><td>${label}${x.states.some((st) => st && st.fine) ? ' <span class="tc-tag">fine structure</span>' : ''}</td><td class="num">${num(fromKJ(x.kj, unit), DIGITS[unit])}</td><td class="num">${num(fromKJ(x.h0, unit), DIGITS[unit])}</td><td class="num">${num(fromKJ(x.h0, 'eV'), 4)}</td>${dea ? '' : `<td class="num">${xthr ? num(xthr, 1) : '—'}</td>`}<td class="num">${PM(bu).replace(/^± /, '')}${bu.how === 'correlated' ? CMARK : ''}</td>${ein != null ? `<td class="num">${op ? num(fromKJ(ein - x.h0, unit), DIGITS[unit]) : 'closed'}</td>` : ''}<td class="tc-state">${esc(srcs.join(', '))}${flagHTML(notes)}</td><td><a class="tc-go" href="?tab=reaction&amp;rx=${encodeURIComponent(xrx)}" data-rx="${esc(xrx)}">reaction ›</a>${rcLink(c, xrx, x.h0)}</td></tr>`;
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
        return `<tr class="${open === false ? 'tc-closed' : ''}"><td>${c.products.map(sp).join(' + ')}${tag}</td><td class="num">${num(fromKJ(c.h0, unit), DIGITS[unit])}</td><td class="num">${num(fromKJ(c.h0, 'eV'), 4)}</td><td class="num">${num(fromKJ(c.h0, 'cm⁻¹'), 0)}</td>${dea ? '' : `<td class="num">${thr ? num(thr, 1) : '—'}</td>`}<td class="num">${num(fromKJ(c.h298, unit), DIGITS[unit])}</td><td class="num">${uCell}</td>${ein != null ? `<td class="num">${open ? num(fromKJ(ein - c.h0, unit), DIGITS[unit]) : 'closed'}</td>` : ''}<td><a class="tc-go" href="?tab=reaction&amp;rx=${encodeURIComponent(rx)}" data-rx="${esc(rx)}">reaction ›</a>${rcLink(c, rx, c.h0)}</td></tr>${exRow}`;
    }).join('');
    const nUnb = ein == null ? 0 : list.filter((c) => c.h0 <= ein && unbound(c)).length;
    const inMsg = ein != null ? `<p class="tc-msg">${dea ? `${num(inNum, 3)} eV electron` : `${num(inNum, inNum < 10 ? 3 : 1)} nm photon`}: ${E(ein)} = ${E(ein, null, 'eV')} = ${E(ein, null, 'cm⁻¹')}. ${openText(list.filter((c) => c.h0 <= ein && !unbound(c)).length)}${nUnb ? ` (Not counted: ${nUnb} with an unbound anion.)` : ''}${state.ex && db.exc ? ` ${nOpenEx === 1 ? '1 excited-product threshold is' : `${nOpenEx} excited-product thresholds are`} open.` : ''}</p>` : '';
    const anyCorr = list.some((c) => bestU(c).how === 'correlated');
    const hintMode = {
        dpi: 'Rows tagged IE are the adiabatic ionization energy of the parent; “isomeric ion” rows lead to a cation of the same composition but a different structure (for example [HCOH]⁺ from CH₂O), so they are not the IE; rows tagged AE are appearance energies of a fragment ion.',
        dea: 'Thresholds for AB + e⁻ → A + B⁻ at 0 K: the incident electron energy needed with a cold parent. A negative value means attachment is exothermic and the channel is open at zero energy; attachment resonances usually peak well above the threshold. The “attachment (−EA)” row is the parent anion itself. ATcT also lists some anions that lie above their neutral (negative electron affinity); rows with such an unbound anion are tagged and not counted as open.',
        ionpair: 'Ion-pair thresholds A⁺ + B⁻ at 0 K, for photons or for electron impact (AB + e⁻ → A⁺ + B⁻ + e⁻ has the same threshold).',
    }[state.mode] || '';
    const uHint = anyCorr ? `; <sup>c</sup> marks the correlated value from ATcT's covariances (TN ${esc(db.meta.tn_version || '')}, the version of the values), otherwise errors are taken as independent; “<” marks a correlated value that is only a bound` : covLoading() ? ' (loading ATcT covariances…)' : ', with errors taken as independent';
    out.innerHTML = `<div class="panel"><div class="panel-head"><h2>${MODE_LABEL[state.mode]} of ${esc(parent.name)}</h2><span class="badge">${list.length} found</span></div><div class="panel-body">
        ${inBad}${exWait}${inMsg}
        <div class="tc-table-scroll"><table class="tc-table"><thead><tr><th>Products</th><th class="num">${dea ? 'ΔH(0 K)' : 'D₀ / ΔH(0 K)'}, ${unit}</th><th class="num">eV</th><th class="num">cm⁻¹</th>${dea ? '' : '<th class="num">λ max (nm)</th>'}<th class="num">ΔH(298 K)</th><th class="num">±</th>${ein != null ? '<th class="num">Available</th>' : ''}<th></th></tr></thead><tbody>${rows || `<tr><td colspan="${ncol}">No channels: ATcT has no matching fragments.</td></tr>`}</tbody></table></div>
        <p class="hint">Sorted by 0 K energy, in ${unit} unless marked. ${dea ? '' : `“λ max” is the longest wavelength that can open the channel from cold ${esc(parent.formula)} without a barrier; `}“Available” is the ${dea ? 'electron' : 'photon'} energy minus the threshold. ± is the 95 % uncertainty (ATcT's 298.15 K value, also used at 0 K)${uHint}. ${hintMode} ${state.ex ? 'Excited products: ATcT’s own entry where ATcT lists the state, otherwise the NIST term value added to the ATcT ground state (sources in the Data &amp; citation tab).' : ''} Search took ${ms.toFixed(0)} ms.</p>
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

/** "recoil ›" for a two-body photon channel (photodissociation, photoionization, ion pair) open at the chosen wavelength. */
function rcLink(c, rx, h0) {
    if (state.mode === 'dea' || c.products.length !== 2) return '';
    const nm = parseNum(state.nm); const open = nm != null && nm > 0 && nmToKJ(nm) >= h0;
    if (!open) return '';
    return `<br><a class="tc-go" href="?tab=recoil&amp;rc=${encodeURIComponent(rx)}&amp;rnm=${encodeURIComponent(state.nm)}" data-rc="${esc(rx)}">recoil ›</a>`;
}
document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-rc]'); if (!a) return;
    e.preventDefault(); state.rc = a.dataset.rc; state.rnm = String(state.nm || '').trim(); state.rn = '1'; state.rpi = ''; state.rpp = ''; renderRecoil(); showTab('recoil');
});

const openText = (n) => (n === 0 ? 'No channel is open.' : n === 1 ? '1 channel is open.' : `${n} channels are open.`);

/* ── Uncertainty budget (Reaction tab) ─────────────────────────────── */
function budgetPanel(terms) {
    if (covLoading()) return '<div class="panel"><div class="panel-head"><h2>Uncertainty budget</h2></div><div class="panel-body"><p class="tc-note">Loading ATcT covariances…</p></div></div>';
    const b = uncertaintyBudget(db, terms);
    if (!b || !b.rows.length) return '';
    const fmtU = (u) => E(u, null, unit, Math.max(DIGITS[unit], uDigits(fromKJ(u, unit))));
    const rows = b.rows.slice();
    if (!b.bound && b.total > 0) rows.sort((x, y) => Math.abs(y.share) - Math.abs(x.share));
    const maxShare = Math.max(...rows.map((r) => Math.abs(r.share || 0)), 1e-300);
    const pct = (r) => (b.bound || !(b.total > 0) ? '—' : `${num(100 * r.share / b.total, 1)} %`);
    const bar = (r) => (b.bound || !(b.total > 0) ? '' : `<span class="tc-bar-fill${r.share < 0 ? ' tc-neg' : ''}" style="width:${Math.max(2, 100 * Math.abs(r.share) / maxShare).toFixed(1)}%"></span>`);
    const top = rows[0];
    let summ = '';
    if (b.bound) summ = 'The correlated uncertainty cancels to below the precision of the stored correlations, so it is only a bound and the shares are not shown.';
    else if (rows.length === 1) summ = `Only ${esc(top.species.formula)} carries uncertainty here.`;
    else {
        const same = fmtU(Math.sqrt(b.total)) === fmtU(top.without);
        const lead = `<strong>${esc(top.species.formula)}</strong> carries ${pct(top)} of the variance; ${same ? `knowing it exactly would barely change ±${fmtU(Math.sqrt(b.total))}` : `knowing it exactly would take ±${fmtU(Math.sqrt(b.total))} to ±${fmtU(top.without)}`}.`;
        const cut = b.how === 'correlated' && b.indepTotal > b.total * 1.0001
            ? ` ATcT's correlations already cut the independent-error estimate, ±${fmtU(Math.sqrt(b.indepTotal))}, to ±${fmtU(Math.sqrt(b.total))}.` : '';
        const neg = rows.some((r) => r.share < 0) ? ' A negative share (green) means that species is correlated with the others so that its errors cancel part of theirs.' : '';
        summ = lead + cut + neg;
    }
    return `<div class="panel"><div class="panel-head"><h2>Uncertainty budget</h2><span class="badge">${b.how === 'correlated' ? 'correlated' : 'independent errors'}</span></div><div class="panel-body">
        <p class="tc-summary">${summ}</p>
        <div class="tc-table-scroll"><table class="tc-table"><thead><tr><th>Species</th><th class="num">ν</th><th class="num">± Δ<sub>f</sub>H°(298.15 K) (95 %)</th><th class="num">Share of variance</th><th class="tc-bar-cell"></th><th class="num">± if this species were exact</th><th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td><a href="#" data-sp="${esc(r.species.id)}">${sp(r.species)}</a><br><span class="tc-state">${esc(r.species.name)}</span></td><td class="num">${num(r.nu, Number.isInteger(r.nu) ? 0 : 3)}</td><td class="num">${U(r.u)}</td><td class="num">${pct(r)}</td><td class="tc-bar-cell">${bar(r)}</td><td class="num">${r.without != null ? fmtU(r.without) : '—'}</td><td>${atctLink(r.species) ? `<a class="tc-go" href="${atctLink(r.species)}" target="_blank" rel="noopener">provenance ↗</a>` : ''}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="hint">${b.how === 'correlated' ? `Shares of νᵀCν, the correlated variance (ATcT covariances of TN ${esc(db.meta.tn_version || '')}); they add up to 100 %.` : 'Shares of Σ(νU)², the independent-error variance, because not every species is in the ATcT covariance file.'} Each species' share includes half a last printed digit of rounding and, for a NIST excited state, its term-value uncertainty. “If exact” is the uncertainty left if a new measurement pinned that species, with the species correlated to it moving along. The provenance link shows which measurements and calculations ATcT used for that species: the place to look for what would improve this result.</p>
    </div></div>`;
}

/* ── Photofragment recoil ─────────────────────────────────────────── */
const RC_EXAMPLES = [['CH3I -> CH3 + I', '266'], ['CH3I -> CH3 + I(2P1/2)', '266'], ['O3 -> O(1D) + O2(a1Δg)', '248'], ['H2O -> H + OH', '157.6'], ['HBr -> H + Br', '243'], ['NO -> NO+ + e-', '118.2']];
const cm1ToKJ = (x) => toKJ(x, 'cm⁻¹');
function rcInput(id, key, min, max, what) {
    const raw = String(state[key] || '').trim();
    const x = parseNum(raw);
    if (x == null) return { v: null, err: '' };
    if (!Number.isFinite(x) || x < min || x > max) return { v: null, err: `“${esc(raw)}” is not a usable ${what}.` };
    return { v: x, err: '' };
}
function renderRecoil() {
    const out = $('rc-out');
    for (const [id, k] of [['rc-in', 'rc'], ['rc-nm', 'rnm'], ['rc-pi', 'rpi'], ['rc-pp', 'rpp'], ['rc-L', 'rL'], ['rc-V', 'rV'], ['rc-N', 'rN'], ['rc-E', 'rE'], ['rc-pr', 'rpr']]) if ($(id).value !== state[k]) $(id).value = state[k];
    $('rc-n').value = state.rn;
    if (state.tab === 'recoil') needFor('recoil');
    const p = parseReaction(state.rc);
    if (p.error) { out.innerHTML = `<div class="tc-msg tc-bad">${esc(p.error)}</div>`; writeURL(); return; }
    const r = resolveReaction(db, p);
    if (r.errors.length) {
        const waitEx = /\(/.test(state.rc) && !db.exc && extra.exc !== false ? ' (loading the excited-state list…)' : '';
        out.innerHTML = `<div class="tc-msg tc-bad">${esc([...new Set(r.errors)].join('; '))}${waitEx}</div>`; writeURL(); return;
    }
    if (!balance(r.terms).ok) { out.innerHTML = '<div class="tc-msg tc-bad">Not balanced: the products must add up to the parent (add e- for a photoionization).</div>'; writeURL(); return; }
    const nm = rcInput('rc-nm', 'rnm', 1, 1e6, 'wavelength: enter nanometres from 1 to 1 000 000');
    const pi = rcInput('rc-pi', 'rpi', 0, 1e6, 'parent internal energy (cm⁻¹, 0 or more)');
    const pp = rcInput('rc-pp', 'rpp', 0, 1e6, 'product internal energy (cm⁻¹, 0 or more)');
    const errs = [nm.err, pi.err, pp.err].filter(Boolean);
    if (nm.v == null) { out.innerHTML = `${errs.map((e) => `<p class="tc-msg tc-bad">${e}</p>`).join('')}<div class="tc-msg">Enter the photon wavelength.</div>`; writeURL(); return; }
    const n = +state.rn || 1;
    const res = photofragments(db, r.terms, { photonKJ: nmToKJ(nm.v), nPhoton: n, eIntParent: cm1ToKJ(pi.v || 0), eIntProducts: cm1ToKJ(pp.v || 0) });
    if (res.error) { out.innerHTML = `<div class="tc-msg tc-bad">${esc(res.error)}</div>`; writeURL(); return; }
    const bu = bestU(res.h);
    const hv = n * nmToKJ(nm.v);
    const alt = (kj) => ['eV', 'cm⁻¹', 'kJ/mol'].filter((u) => u !== unit).slice(0, 2).map((u) => E(kj, null, u)).join('<br>');   // two other units
    const lamMax = res.h.h0 > 0 ? (n * KJ_NM) / (res.h.h0 - cm1ToKJ(pi.v || 0)) : null;
    let status = '';
    if (res.eAvail < 0) status = `<div class="tc-msg tc-bad">Closed: ${n === 1 ? 'one photon' : `${n} photons`} at ${num(nm.v, 2)} nm carry ${E(hv, null, 'eV')}, less than the ${E(res.h.h0 - cm1ToKJ(pi.v || 0), null, 'eV')} this channel needs${lamMax && lamMax > 0 ? `; it opens below ${num(lamMax, 1)} nm` : ''}.</div>`;
    else if (res.eT <= 0) status = '<div class="tc-msg tc-bad">The energy kept by the products is more than the available energy: nothing is left for translation.</div>';
    const geo = { L: parseNum(state.rL), V: parseNum(state.rV), N: parseNum(state.rN), F: parseNum(state.rE), pr: parseNum(state.rpr) };
    const okp = (x) => x != null && Number.isFinite(x) && x > 0;
    for (const [k, what] of [['rL', 'flight length'], ['rV', 'voltage'], ['rN', 'magnification'], ['rE', 'extraction field'], ['rpr', 'probe wavelength']]) {
        if (String(state[k] || '').trim() && !okp(parseNum(state[k]))) errs.push(`“${esc(state[k])}” is not a usable ${what}: enter a positive number. It is ignored.`);
    }
    const showImg = okp(geo.L) && okp(geo.V);
    const showDt = okp(geo.F);
    const showDop = okp(geo.pr);
    const fr = res.frags.map((f) => {
        const q = f.species.q ? Math.abs(f.species.q) : 1;
        const im = vmi({ ke: f.ke, v: f.v, m: f.m, q, L: okp(geo.L) ? geo.L / 1000 : 0, V: okp(geo.V) ? geo.V : 0, N: okp(geo.N) ? geo.N : 1, field: showDt ? geo.F * 100 : null });
        const neutral = !f.species.isElectron && !f.species.q;
        const dop = showDop && neutral ? dopplerShift(f.v, geo.pr) : null;
        const share = res.eT > 0 ? f.ke / res.eT : 0;
        return `<tr><td>${sp(f.species)}${f.species.isElectron ? ' <span class="tc-tag">photoelectron</span>' : ''}</td><td class="num">${f.species.isElectron ? num(f.m, 7) : num(f.m, 3)}</td><td class="num">${num(100 * share, 2)} %</td><td class="num">${num(fromKJ(f.ke, unit), DIGITS[unit])}</td>${unit === 'eV' ? '' : `<td class="num">${num(fromKJ(f.ke, 'eV'), 4)}</td>`}<td class="num">${num(f.v, 0)}</td>${showImg ? `<td class="num">${im.R != null ? num(im.R * 1000, 2) : '—'}</td><td class="num">${im.t != null ? num(im.t * 1e6, f.species.isElectron ? 4 : 3) : '—'}</td>` : ''}${showDt ? `<td class="num">± ${num(im.dt * 1e9 / 2, 2)}</td>` : ''}${showDop ? `<td class="num">${dop != null ? `± ${num(dop, 3)}` : '—'}</td>` : ''}</tr>`;
    }).join('');
    const geoNote = showImg ? ` Imaging: a neutral fragment is taken as ionized once (q = 1), an ion keeps its charge; each gains energy qV with V = ${num(geo.V, 0)} V, after L = ${num(geo.L, 1)} mm, magnification ${num(okp(geo.N) ? geo.N : 1, 3)}; R ≈ N·L·√(KE/qV) and t ≈ L·√(m/2qV), so R depends on the kinetic energy only.` : ' Open “Imaging and detection” for ring radii on a velocity-map imaging detector, arrival times and Doppler widths.';
    const dtNote = showDt ? ` “Arrival spread” is half the turnaround time, ±m·v/qE in ${num(geo.F, 1)} V/cm: a fragment recoiling toward the detector arrives that much early, one recoiling away that much late.` : '';
    const dopNote = showDop ? ` Doppler: largest shift ±ν̃·v/c of a ${num(geo.pr, 3)} nm transition (${num(1e7 / geo.pr, 1)} cm⁻¹), for neutral fragments; an isotropic speed shell gives a flat-topped profile this wide on each side.` : '';
    out.innerHTML = `${errs.map((e) => `<p class="tc-msg tc-bad">${e}</p>`).join('')}
    <div class="panel"><div class="panel-head"><h2>Energy balance</h2></div><div class="panel-body">${status}
        <div class="tc-results">
            <div class="tc-res"><h3>${n === 1 ? 'Photon' : `${n} photons`}, ${num(nm.v, nm.v < 10 ? 3 : 2)} nm</h3><div class="tc-big">${E(hv)}</div><div class="tc-alt">${alt(hv)}</div></div>
            <div class="tc-res"><h3>Threshold Δ<sub>r</sub>H°(0 K)</h3><div class="tc-big">${E(res.h.h0)}</div><div class="tc-alt">${PM(bu)} ${unit} (95 %, ${bu.how})<br>${alt(res.h.h0).split('<br>')[0]}${lamMax && lamMax > 0 ? `<br>opens below ${num(lamMax, 1)} nm (${n === 1 ? 'one photon' : `${n} photons`})` : ''}</div></div>
            <div class="tc-res"><h3>Available energy</h3><div class="tc-big">${E(res.eAvail)}</div><div class="tc-alt">± ${U(bu.u ?? 0)} ${unit}<br>${alt(res.eAvail)}</div><p class="tc-note">${n === 1 ? '' : `${n}`}hν${pi.v ? ' + E<sub>int</sub>(parent)' : ''} − threshold</p></div>
            <div class="tc-res"><h3>Translational energy</h3><div class="tc-big">${E(Math.max(res.eT, 0))}</div><div class="tc-alt">${alt(Math.max(res.eT, 0))}</div><p class="tc-note">${res.eAvail < 0 ? 'the channel is closed' : pp.v ? 'available energy minus what the products keep' : 'all of the available energy: the fastest fragments'}</p></div>
        </div></div></div>
    ${res.eT > 0 ? `<div class="panel"><div class="panel-head"><h2>Fragments</h2></div><div class="panel-body"><div class="tc-table-scroll"><table class="tc-table"><thead><tr><th>Fragment</th><th class="num">Mass, u</th><th class="num">Share of E<sub>T</sub></th><th class="num">KE, ${unit}</th>${unit === 'eV' ? '' : '<th class="num">KE, eV</th>'}<th class="num">Speed, m/s</th>${showImg ? '<th class="num">VMI radius, mm</th><th class="num">Arrival, µs</th>' : ''}${showDt ? '<th class="num">Arrival spread, ns</th>' : ''}${showDop ? '<th class="num">Doppler, cm⁻¹</th>' : ''}</tr></thead><tbody>${fr}</tbody></table></div>
        <p class="hint">Centre-of-mass frame of the parent: equal and opposite momenta, so the lighter fragment takes the larger share, m<sub>other</sub>/(m<sub>A</sub> + m<sub>B</sub>). Masses are ATcT's molar masses. The kinetic energies carry the threshold's uncertainty in proportion to their shares.${geoNote}${dtNote}${dopNote}</p></div></div>` : ''}
    <div class="panel"><div class="panel-body"><p class="hint">Thermochemistry gives the energy; how it divides between translation, rotation and vibration is set by the dynamics. Enter the products' internal energy to see slower fragments, or pick an excited product state in the reaction. For the energetics of every channel at this wavelength, see <a href="#" data-tab="channels">Bonds &amp; photolysis</a>; for a Wiley–McLaren spectrometer, the <a href="/tools/ion-time-of-flight/">ion time-of-flight calculator</a>.</p>${shareBox('recoil')}</div></div>`;
    writeURL();
}

/* ── Beam collisions ──────────────────────────────────────────────── */
const CL_EXAMPLES = [['N+', 'O2', '10'], ['O+', 'N2', '20'], ['Ar+', 'H2', '5'], ['O', 'N2', '5'], ['H+', 'CH4', '30'], ['O+', 'CH4', '1']];
function renderCollide() {
    const out = $('cl-out');
    $('cl-three').checked = state.cthree; $('cl-ion').checked = state.cion; $('cl-lab').checked = state.clab;
    if ($('cl-e').value !== state.ce) $('cl-e').value = state.ce;
    if (state.tab === 'collide') needFor('collide');
    const P = db.byId.get(state.cp); const T = db.byId.get(state.ct);
    if (!P || !T) { out.innerHTML = '<div class="tc-msg">Pick a projectile and a target.</div>'; writeURL(); return; }
    if (P.isElectron || T.isElectron) { out.innerHTML = '<div class="tc-msg tc-bad">Electron impact is not modelled in this tab. For electron attachment and ion-pair thresholds, use the electron channels in <a href="#" data-tab="channels">Bonds &amp; photolysis</a>.</div>'; writeURL(); return; }
    const bad = [P, T].find((s) => !s.gas || s.h0 == null);
    if (bad) { out.innerHTML = `<div class="tc-msg tc-bad">${esc(bad.formula)} (${esc(bad.state)}) is not a gas-phase entry with a 0 K value.</div>`; writeURL(); return; }
    const eRaw = String(state.ce || '').trim(); const eV = parseNum(eRaw);
    const eOk = eV != null && Number.isFinite(eV) && eV >= 0 && eV <= 1e6;
    const eLab = eOk ? toKJ(eV, 'eV') : null;
    const f = eOk ? collisionFrame(P.mass, T.mass, eLab) : null;
    const t0 = performance.now();
    const list = collisionChannels(db, P, T, { three: state.cthree, ionize: state.cion, labeled: state.clab, limit: 300 });
    const ms = performance.now() - t0;
    const lhs = `${txt(P)} + ${txt(T)}`;
    const nOpen = f ? list.filter((c) => c.h0 <= f.eCM).length : 0;
    const rows = list.map((c) => {
        const open = f ? c.h0 <= f.eCM : null;
        const bu = bestU(c);
        const rx = `${lhs} -> ${c.products.map(txt).join(' + ')}`;
        const lab = c.h0 > 0 ? num(fromKJ(labForCM(c.h0, P.mass, T.mass), 'eV'), 3) : '0';
        return `<tr class="${open === false ? 'tc-closed' : ''}"><td>${c.products.map(sp).join(' + ')}</td><td><span class="tc-tag">${esc(c.kind)}</span></td><td class="num">${num(fromKJ(c.h0, unit), DIGITS[unit])}</td><td class="num">${num(fromKJ(c.h0, 'eV'), 3)}</td><td class="num">${lab}</td><td class="num">${PM(bu).replace(/^± /, '')}${bu.how === 'correlated' ? CMARK : ''}</td>${f ? `<td class="num">${open ? num(fromKJ(f.eCM - c.h0, unit), DIGITS[unit]) : 'closed'}</td>` : ''}<td><a class="tc-go" href="?tab=reaction&amp;rx=${encodeURIComponent(rx)}" data-rx="${esc(rx)}">reaction ›</a></td></tr>`;
    }).join('');
    const frame = f ? `<div class="tc-results">
            <div class="tc-res"><h3>Centre-of-mass energy</h3><div class="tc-big">${E(f.eCM, null, 'eV')}</div><div class="tc-alt">${E(f.eCM)}${unit !== 'cm⁻¹' ? `<br>${E(f.eCM, null, 'cm⁻¹')}` : ''}<br>${num(100 * T.mass / (P.mass + T.mass), 1)} % of E<sub>lab</sub></div></div>
            <div class="tc-res"><h3>Speeds</h3><dl class="tc-kv"><dt>Projectile</dt><dd>${num(f.vp, 0)} m/s</dd><dt>Centre of mass</dt><dd>${num(f.vcm, 0)} m/s</dd></dl></div>
            <div class="tc-res"><h3>Masses</h3><dl class="tc-kv"><dt>${F(P.formula)}</dt><dd>${num(P.mass, 3)} u</dd><dt>${F(T.formula)}</dt><dd>${num(T.mass, 3)} u</dd><dt>Reduced mass μ</dt><dd>${num(f.mu, 3)} u</dd></dl></div>
            <div class="tc-res"><h3>Largest elastic transfer</h3><div class="tc-big">${E(f.tMax, null, 'eV')}</div><div class="tc-alt">to ${F(T.formula)} in a head-on collision, 4m<sub>p</sub>m<sub>t</sub>/(m<sub>p</sub> + m<sub>t</sub>)²·E<sub>lab</sub></div></div>
        </div>` : `<p class="tc-msg tc-bad">${eRaw ? `“${esc(eRaw)}” is not a usable energy: enter electronvolts from 0 to 1 000 000.` : 'Enter the lab kinetic energy to see which channels are open.'}</p>`;
    out.innerHTML = `<div class="panel"><div class="panel-head"><h2>${esc(P.name)} + ${esc(T.name)}${f ? ` at ${num(eV, eV < 10 ? 3 : 1)} eV (lab)` : ''}</h2></div><div class="panel-body">${frame}</div></div>
    <div class="panel"><div class="panel-head"><h2>Product channels</h2><span class="badge">${list.total > list.length ? `lowest ${list.length} of ${list.total}` : `${list.length} found`}${list.truncated ? '+' : ''}</span></div><div class="panel-body">
        ${f ? `<p class="tc-msg">${openText(nOpen)} E<sub>cm</sub> = ${E(f.eCM, null, 'eV')}.</p>` : ''}
        <div class="tc-table-scroll"><table class="tc-table"><thead><tr><th>Products</th><th>Kind</th><th class="num">Δ<sub>r</sub>H°(0 K), ${unit}</th><th class="num">eV</th><th class="num">Lab threshold, eV</th><th class="num">±</th>${f ? `<th class="num">Excess, ${unit}</th>` : ''}<th></th></tr></thead><tbody>${rows || '<tr><td colspan="8">No channels: ATcT has no matching products.</td></tr>'}</tbody></table></div>
        <p class="hint">Sorted by 0 K reaction enthalpy, the centre-of-mass threshold of an endothermic channel; exothermic channels are open at any energy unless a barrier intervenes. “Lab threshold” is the projectile energy that reaches it with the target at rest; “Excess” is E<sub>cm</sub> − Δ<sub>r</sub>H°, shared by the products' translation and internal energy. Kinds: charge transfer (the charge moves, nothing else), ion pair (neutral reactants to a cation and an anion), transfer (an atom, ion or group changes partner), excitation (same fragments in another ATcT state or isomer), association (one product: needs a third body or emission), dissociation (three or more heavy products), ionization (electrons released). Ion energies follow the stationary-electron convention at 0 K. ± is the 95 % uncertainty (from ATcT's 298.15 K uncertainties, also used at 0 K)${list.some((c) => bestU(c).how === 'correlated') ? '; <sup>c</sup> marks ATcT correlated values' : ''}. Search took ${ms.toFixed(0)} ms.</p>
        ${shareBox('collide')}</div></div>`;
    writeURL();
}

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
    const waiting = ['cov', 'exc'].filter((k) => (k === 'exc' || db.isShipped) && !db[k] && extra[k] !== false);
    const res = CASES.map((c) => runCase(db, c));
    const ext = extraChecks(db, db.isShipped ? { version: current ? current.version : null, covTN: covFileTN, covError: extra.cov === false ? extraErr.cov || 'not loaded' : null } : {});
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
    const caseRow = (r) => `<tr><th scope="row">${r.title}<br><span class="tc-state tc-mono">${esc(r.rxn)}</span></th><td class="num">${showVal(r)}</td><td class="num">${minus(String(r.ref.v))} ± ${r.ref.u} ${r.ref.unit}<br>${num(r.refKJ, 4)} kJ/mol</td><td class="num">${num(r.diff, 4)}</td><td class="num">± ${num(r.tol, 4)}</td><td>${badge(r.pass)}${r.pass !== null && !r.tableOk ? `<br><span class="tc-state">${r.handOk ? 'table value changed' : `hand value is TN ${HAND_TN}, not compared`}</span>` : ''}</td><td class="tc-state">${r.href ? `<a href="${esc(r.href)}" target="_blank" rel="noopener">${esc(r.src)}</a>` : esc(r.src)}${r.tolNote ? `<br>Tolerance: ${esc(r.tolNote)}.` : ''}${KINDS[r.kind] ? `<br><span class="tc-tag">${esc(KINDS[r.kind])}</span>` : ''}</td></tr>`;
    const groups = [['units', 'Unit factors (CODATA 2022)'], ['lookup', 'Formula, ion and state-label lookup'], ['balance', 'Balance and uncertainty (ATcT covariances)'], ['excited', 'Excited-state and electron-attachment bookkeeping'], ['diagram', 'Energy diagram and data version'], ['kinematics', 'Recoil, collisions and uncertainty budget']];
    root.innerHTML = `<div class="panel"><div class="panel-head"><h2>Self-test</h2><span class="badge ${nPass === nAll ? 'badge-ok' : 'badge-bad'}">${nPass} / ${nAll}</span></div><div class="panel-body">
        <p class="tc-st-summary">${nPass} of ${nAll} checks passed with the loaded table (ATcT TN ${esc(db.meta.tn_version || '?')})${nNA ? `; ${nNA} not applicable to this table` : ''}${waiting.length ? ` (still loading: ${waiting.join(', ')})` : ''}.</p>
        <p class="hint">Each reaction is recomputed from the loaded table and checked twice. First against the value hand-computed from ATcT TN 1.228 on 2026-11-06 (plus, for excited products, the NIST term value) to 0.0015 kJ/mol, which catches data, parsing and arithmetic errors; with a table of another TN version that first check is skipped and marked.${String(db.meta.tn_version || HAND_TN) !== HAND_TN ? ` <strong>The loaded table is TN ${esc(db.meta.tn_version)}</strong>, so only the reference checks count.` : ''} Then against a reference value, passing when |Δ| ≤ √(U<sub>tool</sub>² + U<sub>ref</sub>²) at 95 %; for a threshold quoted to a rounded wavelength or energy, U<sub>ref</sub> is that rounding.</p>
        <p class="hint"><strong>Most references are not independent tests of ATcT.</strong> Seven are measurements that ATcT itself uses as inputs (its 1.228 species pages list them), and D₀(H–CH₃) comes from an ATcT-group analysis of such inputs, so agreement is expected. H₂CO → H₂ + CO is compared with ATcT's own values and covariances (TN 1.228 via the API), so it checks the arithmetic and the covariance file only. IE(H) can agree only to ATcT's printed rounding. The “quoted” thresholds (O₃ at ≈310 nm, N₂O at 341 nm, and all three H₂O + e⁻ asymptotes of Haxton et al.: 3.56, 4.35 and 8.38 eV) come from other groups, who computed them from older thermochemistry and quote them rounded; each row states the tolerance used and why, so they test the bookkeeping of excited products and attached electrons, not the last digit. H₂O → H + OH(A) adds the same NIST term value the tool adds, so it checks bookkeeping only. The checks show that this tool reproduces ATcT and its sources, not that they are right.</p>
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
    const cur = db.isShipped && current ? current : null;
    $('dt-meta').innerHTML = `${esc(m.source || '')}, Thermochemical Network version <strong>${esc(m.tn_version || '?')}</strong>${m.as_of ? ` (as of ${esc(m.as_of)})` : ''}${cur && cur.fetched ? `, retrieved from the ATcT API on ${esc(cur.fetched.slice(0, 10))} at ${esc(cur.fetched.slice(11, 16))} UTC` : m.downloaded ? `, downloaded ${esc(m.downloaded)}` : ''}. ${db.species.length} species; ${db.species.filter((s) => s.gas).length} in the gas phase${cur && cur.cov_species ? `; covariances for ${cur.cov_species} of them, from the same version` : ''}. ${m.url ? `ATcT's <a href="${esc(m.url)}" target="_blank" rel="noopener">table of this version</a>${cur && cur.doi ? `; dataset <a href="https://doi.org/${esc(cur.doi)}" target="_blank" rel="noopener">doi:${esc(cur.doi)}</a>` : ''}.` : ''}`;
    $('dt-cite').innerHTML = (m.citation || []).map((c) => `<li>${esc(c).replace(/doi:(\S+)/, (x, d) => `<a href="https://doi.org/${esc(d)}" target="_blank" rel="noopener">doi:${esc(d)}</a>`)}</li>`).join('') || '<li>Cite the source of the table you loaded.</li>';
    $('tc-source').innerHTML = `Values: <strong>ATcT ${esc(m.tn_version || '')}</strong>${cur && cur.fetched ? `, retrieved from the ATcT API ${esc(cur.fetched.slice(0, 10))}` : m.as_of ? ` (${esc(m.as_of)})` : ''}, Argonne National Laboratory. Uncertainties are 95 %, those of Δ<sub>f</sub>H°(298.15 K). <a href="#" id="tc-cite-link">How to cite</a>`;
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
            $('dt-status').textContent = `Loaded ${payload.rows.length} species from ${f.name}.${skip} Results now use your table (without ATcT covariances); the citation is yours to supply.`;

            $('dt-reset').hidden = false; rerender();
        } catch (err) { $('dt-status').textContent = `Could not read ${f.name}: ${err.message}.`; }
    });
    $('dt-reset').addEventListener('click', () => { db = shippedDB(); $('dt-reset').hidden = true; $('dt-status').textContent = `Back to the shipped ATcT TN ${shipped.meta.tn_version || ''} table.`; rerender(); });
}
function shippedDB() {
    const d = buildDB(shipped); d.isShipped = true;
    for (const k of ['cov', 'exc']) attachTo(d, k);
    return d;
}

function rerender() {
    renderData(); renderSpecies(); renderReaction(); renderChannels(); renderUnits(); renderRecoil(); renderCollide();
    if (state.tab === 'selftest') renderSelfTest();
    if (state.tab === 'diagram') renderDiagram();
}

/** Version, retrieval date, counts and dataset DOI from atct-current.json into the page's static text. */
function fillCurrent() {
    if (!current) return;
    const all = (k) => document.querySelectorAll(`[data-atct="${k}"]`);
    const set = (k, v) => { if (v != null && v !== '') for (const el of all(k)) el.textContent = String(v); };
    set('version', current.version); set('fetched', (current.fetched || '').slice(0, 10));
    set('species', current.species); set('cov_species', current.cov_species); set('cov_target', current.cov_target);
    for (const el of all('year')) el.textContent = current.dataset_year ? ` (${current.dataset_year})` : '';
    for (const el of all('doi-wrap')) el.hidden = !current.doi;
    if (current.doi) for (const a of all('doi')) { a.href = `https://doi.org/${current.doi}`; a.textContent = `doi:${current.doi}`; }
    for (const a of all('page')) a.href = `${atctBase()}index.php`;
    // text with numbers of a fixed TN version (examples, typical values) says so once the data have moved on
    for (const el of document.querySelectorAll('[data-atct-pinned]')) el.hidden = String(current.version) === el.dataset.atctPinned;
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
    $('rc-examples').innerHTML = RC_EXAMPLES.map(([x, nm]) => `<button type="button" data-nm="${nm}">${esc(x)} <span class="tc-state">${nm} nm</span></button>`).join('');
    $('rc-examples').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || !db) return; state.rc = b.firstChild.textContent.trim(); state.rnm = b.dataset.nm; state.rn = '1'; renderRecoil(); });
    let rtmr = 0;
    for (const [id, k] of [['rc-in', 'rc'], ['rc-nm', 'rnm'], ['rc-pi', 'rpi'], ['rc-pp', 'rpp'], ['rc-L', 'rL'], ['rc-V', 'rV'], ['rc-N', 'rN'], ['rc-E', 'rE'], ['rc-pr', 'rpr']]) {
        $(id).addEventListener('input', () => { state[k] = $(id).value; clearTimeout(rtmr); rtmr = setTimeout(() => { if (db) renderRecoil(); }, 200); });
    }
    $('rc-n').addEventListener('change', () => { state.rn = $('rc-n').value; if (db) renderRecoil(); });
    if (['rE', 'rpr'].some((k) => state[k]) || new URLSearchParams(location.search).has('rL')) $('rc-geo').open = true;
    $('cl-examples').innerHTML = CL_EXAMPLES.map(([p, tg, e]) => `<button type="button" data-p="${esc(p)}" data-t="${esc(tg)}" data-e="${e}">${esc(p)} + ${esc(tg)} <span class="tc-state">${e} eV</span></button>`).join('');
    $('cl-examples').addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b || !db) return;
        const P = resolveToken(db, b.dataset.p).species; const T = resolveToken(db, b.dataset.t).species; if (!P || !T) return;
        state.cp = P.id; state.ct = T.id; state.ce = b.dataset.e; $('cl-p').value = P.formula; $('cl-t').value = T.formula; renderCollide();
    });
    $('cl-e').addEventListener('input', () => { state.ce = $('cl-e').value; clearTimeout(rtmr); rtmr = setTimeout(() => { if (db) renderCollide(); }, 200); });
    $('cl-three').addEventListener('change', () => { state.cthree = $('cl-three').checked; renderCollide(); });
    $('cl-ion').addEventListener('change', () => { state.cion = $('cl-ion').checked; renderCollide(); });
    $('cl-lab').addEventListener('change', () => { state.clab = $('cl-lab').checked; renderCollide(); });
    initData();
    initDiagram();
    showTab(state.tab);
    try {
        const rc = await fetch(CURRENT_URL);
        if (!rc.ok) throw new Error(`atct-current.json: HTTP ${rc.status}`);
        current = await rc.json();
        fillCurrent();
        const r = await fetch(dataURL(current.files.table));
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
    const clMiss = (side) => (q, s) => { $('cl-out').innerHTML = `<div class="tc-msg tc-bad">${s && s.isElectron ? 'Electron impact is not modelled in this tab; the electron channels in Bonds &amp; photolysis give attachment and ion-pair thresholds.' : s ? `${esc(s.formula)} (${esc(s.state)}) is not a gas-phase entry with a 0 K value.` : `“${esc(q)}” was not found in ATcT ${esc(db.meta.tn_version || '')}. Try a formula (N+, O2), a name or a CAS number.`}</div>`; state[side] = ''; writeURL(); };
    combo($('cl-p'), $('cl-p-list'), (s) => { state.cp = s.id; $('cl-p').value = s.formula; renderCollide(); }, (s) => s.gas && s.h0 != null, clMiss('cp'));
    combo($('cl-t'), $('cl-t-list'), (s) => { state.ct = s.id; $('cl-t').value = s.formula; renderCollide(); }, (s) => s.gas && s.h0 != null, clMiss('ct'));
    for (const [id, k] of [['cl-p', 'cp'], ['cl-t', 'ct']]) { const s = db.byId.get(state[k]); $(id).value = s ? s.formula : ''; }
    if (!state.sp) state.sp = '50-00-0*0';
    const s0 = db.byId.get(state.sp); $('sp-q').value = s0 ? s0.formula : '';
    const c0 = db.byId.get(state.ch); $('ch-q').value = c0 ? c0.formula : '';
    rerender();
    window.__thermochem = { db: () => db, CASES, runCase, extraChecks, extra: () => extra, current: () => current, state };
}
boot();
