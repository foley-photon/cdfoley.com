// Entry point of /beta/conductance/ (spec 4.1): conditions bar, tabs, lazy tab mounting, the URL hash and the
// single shared Monte Carlo runner. No console output (H13); the default load starts no workers and no WebGL.

import { store, currentGas } from './store.js';
import * as format from './format.js';
import { decode, encode } from './url-state.js';
import { mount as mountComponents } from './components-ui.js';
import { GASES, GAS_IDS } from '../engine/gas.js';

export const APP_NAME = 'Conductance Lab';

const $ = (id) => document.getElementById(id);
const TABS = ['components', 'cad', 'selftest'];
const PHONE = '(max-width: 860px)';
const CUSTOM_FIELDS = [   // input id, custom key, display -> SI factor
    ['cl-gM', 'M', 1e-3], ['cl-geta', 'eta20', 1e-6], ['cl-gom', 'omega', 1], ['cl-gga', 'gamma', 1], ['cl-gcd', 'Cd', 1],
];

// ------------------------------------------------------------------ shared Monte Carlo runner
let runnerPromise = null;
/** The single shared McRunner, created on first use (a Promise; the engine module loads lazily). */
export function getRunner() {
    if (!runnerPromise) {
        runnerPromise = import('../engine/mc-runner.js').then(({ McRunner }) => {
            const phone = typeof matchMedia === 'function' && matchMedia(PHONE).matches;
            const workers = phone ? 2 : Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
            return new McRunner({ workers, createWorker: () => new Worker(new URL('../workers/tpmc-worker.js', import.meta.url), { type: 'module' }) });
        });
        runnerPromise.catch(() => { runnerPromise = null; });
    }
    return runnerPromise;
}

/** Resolves true when a module worker starts and answers, false otherwise (spec 4.1, R8). */
export function probeWorkers(timeoutMs = 4000) {
    return new Promise((resolve) => {
        let w = null, done = false;
        const finish = (ok) => { if (done) return; done = true; clearTimeout(t); try { if (w) w.terminate(); } catch (_) { /* gone */ } resolve(ok); };
        const t = setTimeout(() => finish(false), timeoutMs);
        try {
            w = new Worker(new URL('../workers/tpmc-worker.js', import.meta.url), { type: 'module' });
            w.addEventListener('error', () => finish(false));
            w.addEventListener('message', () => finish(true));
            w.postMessage({ type: 'unload', job: -1 });
        } catch (_) {
            finish(false);
        }
    });
}

// ------------------------------------------------------------------ boot
const initial = decode(location.hash);
const st = initial.state;
store.set({ gas: st.model.gas.id, T: st.model.gas.T, custom: st.model.gas.custom, Cd: st.model.Cd, ...st.units });

let tab = st.tab;
let hashTimer = 0, comp = null;
const mounted = { cad: null, selftest: null };

// true when any number in v is not finite (a field that does not parse holds NaN until it is fixed)
const hasNaN = (v) => (typeof v === 'number' ? !Number.isFinite(v) : v && typeof v === 'object' ? Object.values(v).some(hasNaN) : false);
let lastHash = null;
function writeHash() {
    clearTimeout(hashTimer);
    if (!comp) return;
    const s = store.get(), m = comp.getModel();
    const model = { ...m, gas: { id: s.gas, T: s.T, custom: s.gas === 'custom' ? s.custom : null }, Cd: s.Cd };
    // an unreadable field keeps the last good link (encode would write NaN, which a shared link turns into a default)
    if (hasNaN(model)) { if (lastHash) history.replaceState(null, '', lastHash); return; }
    lastHash = '#' + encode({ tab, model, units: { lu: s.lu, su: s.su, pu: s.pu } });
    history.replaceState(null, '', lastHash);
}
const scheduleHash = () => { clearTimeout(hashTimer); hashTimer = setTimeout(writeHash, 300); };

// ------------------------------------------------------------------ conditions bar
const gasSel = $('cl-gas'), tIn = $('cl-T'), tUnit = $('cl-T-unit'), cdIn = $('cl-cd'), cdAssumed = $('cl-cd-assumed'), cdDefault = $('cl-cd-default');
const customRow = $('cl-custom'), gasErr = $('cl-gas-error');
const unitSel = { lu: $('cl-lu'), su: $('cl-su'), pu: $('cl-pu') };

const formula = (id) => id.replace(/(\d)/g, (d) => '₀₁₂₃₄₅₆₇₈₉'[d]);
gasSel.innerHTML = GAS_IDS.map((id) => `<option value="${id}">${GASES[id].name}${id === 'air' ? '' : ` (${formula(id)})`}</option>`).join('')
    + '<option value="custom">Custom gas</option>';
const show = (x, sig = 6) => format.editText(x, sig);

function fillConditions() {
    const s = store.get();
    gasSel.value = s.gas;
    if (document.activeElement !== tIn) tIn.value = Number.isFinite(s.T) ? show(format.fromSI('temperature', tUnit.value, s.T), 6) : tIn.value;
    const def = s.gas === 'custom' ? (s.custom && s.custom.Cd) : GASES[s.gas] && GASES[s.gas].Cd;
    if (document.activeElement !== cdIn) cdIn.value = s.Cd !== null && s.Cd !== undefined ? (Number.isFinite(s.Cd) ? show(s.Cd, 4) : cdIn.value) : (Number.isFinite(def) ? show(def, 4) : '');
    cdAssumed.hidden = !(s.Cd === null && s.gas !== 'custom' && GASES[s.gas] && GASES[s.gas].assumedCd);
    cdDefault.hidden = s.Cd === null || s.Cd === undefined;
    customRow.hidden = s.gas !== 'custom';
    if (s.gas === 'custom' && s.custom) {
        for (const [id, k, f] of CUSTOM_FIELDS) {
            const inp = $(id);
            if (document.activeElement !== inp && Number.isFinite(s.custom[k])) inp.value = show(s.custom[k] / f, 6);
        }
    }
    for (const k of Object.keys(unitSel)) unitSel[k].value = s[k];
    checkGas();
}

function checkGas() {
    [gasSel, tIn, cdIn, ...CUSTOM_FIELDS.map(([id]) => $(id))].forEach((n) => n.removeAttribute('aria-invalid'));
    try {
        currentGas();
        gasErr.classList.remove('show');
        gasErr.textContent = '';
    } catch (err) {
        const map = { T: tIn, Cd: store.get().gas === 'custom' && store.get().Cd === null ? $('cl-gcd') : cdIn, id: gasSel, M: $('cl-gM'), eta20: $('cl-geta'), omega: $('cl-gom'), gamma: $('cl-gga') };
        const n = map[err.field];
        if (n) n.setAttribute('aria-invalid', 'true');
        gasErr.textContent = err.message;
        gasErr.classList.add('show');
    }
}

gasSel.addEventListener('change', () => {
    const s = store.get(), id = gasSel.value;
    const patch = { gas: id };
    if (id === 'custom' && !s.custom) {
        const g = GASES[s.gas] || GASES.N2;
        patch.custom = { M: g.M, eta20: g.eta20, omega: g.omega, gamma: g.gamma, Cd: g.Cd };
    }
    store.set(patch);
});
tIn.addEventListener('input', () => {
    const v = format.parseInput(tIn.value);
    store.set({ T: Number.isFinite(v) ? format.toSI('temperature', tUnit.value, v) : NaN });
});
tUnit.addEventListener('change', () => {
    const T = store.get().T;
    if (Number.isFinite(T)) tIn.value = show(format.fromSI('temperature', tUnit.value, T), 6);
});
cdIn.addEventListener('input', () => {   // an empty box restores the gas value
    const v = format.parseInput(cdIn.value);
    store.set({ Cd: cdIn.value.trim() === '' ? null : Number.isFinite(v) ? v : NaN });
});
cdIn.addEventListener('blur', () => { if (store.get().Cd === null) fillConditions(); });
cdDefault.addEventListener('click', () => { store.set({ Cd: null }); cdIn.value = ''; fillConditions(); });
for (const [id, k, f] of CUSTOM_FIELDS) {
    $(id).addEventListener('input', (ev) => {
        const v = format.parseInput(ev.target.value);
        store.set({ custom: { ...(store.get().custom || {}), [k]: Number.isFinite(v) ? v * f : NaN } });
    });
}
for (const [k, sel] of Object.entries(unitSel)) sel.addEventListener('change', () => store.set({ [k]: sel.value }));

store.subscribe(() => { fillConditions(); scheduleHash(); });
fillConditions();

// ------------------------------------------------------------------ tabs
const tabBtns = TABS.map((t) => $('tabbtn-' + t));
const panels = TABS.map((t) => $('tab-' + t));

async function ensureMounted(t) {
    const shared = { store, format, getRunner, openInComponents };
    if (t === 'cad' && !mounted.cad) {
        const rootEl = $('cad-root');
        mounted.cad = 'loading';
        try {
            const m = await import('./cad-ui.js');
            mounted.cad = m.mount(rootEl, shared) || true;
        } catch (_) {
            mounted.cad = null;
            rootEl.innerHTML = '<p class="callout callout-warn">The 3D viewer could not be loaded (no connection to cdnjs.cloudflare.com). The Components tab still works.</p>';
        }
    }
    if (t === 'selftest' && !mounted.selftest) {
        const rootEl = $('selftest-root');
        mounted.selftest = 'loading';
        try {
            const m = await import('./selftest-ui.js');
            mounted.selftest = m.mount(rootEl, shared) || true;
        } catch (_) {
            mounted.selftest = null;
            rootEl.innerHTML = '<p class="callout callout-warn">The self-test could not be loaded. Reload the page to try again; the Components tab still works.</p>';
        }
    }
}

function selectTab(t, { focus = false, write = true } = {}) {
    if (!TABS.includes(t)) t = 'components';
    tab = t;
    TABS.forEach((name, k) => {
        const on = name === t;
        tabBtns[k].setAttribute('aria-selected', on ? 'true' : 'false');
        tabBtns[k].tabIndex = on ? 0 : -1;
        panels[k].hidden = !on;
    });
    if (focus) tabBtns[TABS.indexOf(t)].focus();
    ensureMounted(t);
    if (write) writeHash();
}

tabBtns.forEach((b, k) => {
    b.addEventListener('click', () => selectTab(TABS[k]));
    b.addEventListener('keydown', (ev) => {
        let to = null;
        if (ev.key === 'ArrowRight') to = (k + 1) % TABS.length;
        else if (ev.key === 'ArrowLeft') to = (k + TABS.length - 1) % TABS.length;
        else if (ev.key === 'Home') to = 0;
        else if (ev.key === 'End') to = TABS.length - 1;
        else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectTab(TABS[k]); return; }
        if (to === null) return;
        ev.preventDefault();
        tabBtns.forEach((x, j) => { x.tabIndex = j === to ? 0 : -1; });
        tabBtns[to].focus();
    });
});

function openInComponents(items) {
    if (comp) comp.setItems(items);
    selectTab('components', { focus: true });
}

// ------------------------------------------------------------------ Components tab
comp = mountComponents($('tab-components'), {
    store, getRunner, probeWorkers, initial: st.model, notice: initial.notice, onChange: scheduleHash,
});
selectTab(tab, { write: initial.kind === 'model' || initial.kind === 'bad' });

// a link pasted into the address bar of an open page; plain anchors such as #how are left alone
addEventListener('hashchange', () => {
    const d = decode(location.hash);
    // a plain anchor (the skip link, #how) replaced the model hash: put the model back without moving the page, so
    // that "Copy link" still shares the model
    if (d.kind === 'anchor' || d.kind === 'empty') { writeHash(); return; }
    if (d.kind === 'tab') { selectTab(d.state.tab); return; }
    const m = d.state.model;
    store.set({ gas: m.gas.id, T: m.gas.T, custom: m.gas.custom, Cd: m.Cd, ...d.state.units });
    comp.setModel(m, { notice: d.notice });
    selectTab(d.state.tab);
});
