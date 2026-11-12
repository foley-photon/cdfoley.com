// Thermochemistry Lab: small pieces of the page's logic that need no document, so the Node tests can check them
// (tests/view.test.mjs). app.js draws with what these return.

/** The state keys each tab's Reset button restores; the energy unit at the top of the page is not one of them. */
export const TAB_KEYS = {
    channels: ['ch', 'nm', 'ee', 'mode', 'three', 'lab', 'ex', 'fine'],
    recoil: ['rc', 'rnm', 'rn', 'rpi', 'rpp', 'rL', 'rV', 'rN', 'rE', 'rpr'],
    collide: ['cp', 'ct', 'ce', 'cthree', 'cion', 'clab'],
    reaction: ['rx', 'rxo'],
    diagram: ['dg'],
    species: ['sp'],
    units: ['uv', 'uu'],
};

/** Put one tab's keys back to their defaults (deep copies, so the defaults stay untouched). Returns the keys set. */
export function resetTab(state, defaults, tab) {
    const keys = TAB_KEYS[tab] || [];
    for (const k of keys) state[k] = structuredClone(defaults[k]);
    return keys;
}

/** The noun in "Opens this … with the same inputs." under a Copy link button. */
export function shareWhat(tab) {
    return {
        channels: 'channel list', diagram: 'diagram', recoil: 'recoil calculation', collide: 'collision', species: 'lookup',
        units: 'conversion', reaction: 'reaction',
    }[tab] || 'view';
}

/** The search time is worth a sentence only when the search was slow enough to notice. */
export const searchNote = (ms) => (ms > 100 ? ` Search took ${ms.toFixed(0)} ms.` : '');

/**
 * Summary line of the recoil tab's "Imaging and detection" block, so that the values in use show while it is closed.
 * `g` holds the parsed numbers (null where the field is empty or unusable): L in mm, V in volts, N, F in V/cm, pr in nm.
 */
export function geoSummary(g) {
    const ok = (x) => x != null && Number.isFinite(x) && x > 0;
    const n = (x) => String(+x.toPrecision(6));
    if (!ok(g.L) || !ok(g.V)) return 'Imaging and detection (optional): enter a flight length and a voltage for ring radii';
    const parts = [`L = ${n(g.L)} mm`, `V = ${n(g.V)} V`];
    if (ok(g.N) && g.N !== 1) parts.push(`N = ${n(g.N)}`);
    if (ok(g.F)) parts.push(`E = ${n(g.F)} V/cm`);
    if (ok(g.pr)) parts.push(`probe ${n(g.pr)} nm`);
    return `Imaging and detection: using ${parts.join(', ')}`;
}

/**
 * What a channel list (sorted by 0 K energy, each with h0 in kJ/mol) does at the energy `ein` (kJ/mol): how many
 * channels are open, the lowest open one and the first one still closed. Channels for which `skip` is true (an
 * unbound anion) are counted apart and never reported as open.
 */
export function channelSummary(list, ein, skip = () => false) {
    const real = list.filter((c) => !skip(c));
    const open = real.filter((c) => c.h0 <= ein);
    const closed = real.filter((c) => c.h0 > ein);
    return {
        total: list.length, nOpen: open.length, nSkipped: list.filter((c) => skip(c) && c.h0 <= ein).length,
        lowest: open[0] || null, next: closed[0] || null,
    };
}

const ARROW = /\s*(?:<=>|<->|->|→|⟶|=>|=)\s*/;
/** "CH4 -> CH3 + H" as ['CH4', 'CH3 + H'] (photon tokens dropped), or null when the text is not one reaction. */
export function splitReaction(text) {
    const parts = String(text || '').split(ARROW);
    if (parts.length !== 2) return null;
    const clean = (s) => s.split(/\s+\+\s+/).map((x) => x.trim()).filter((x) => x && !/^(hv|hν|hnu|photon|γ)$/i.test(x)).join(' + ');
    const l = clean(parts[0]); const r = clean(parts[1]);
    return l && r ? [l, r] : null;
}

/**
 * The diagram state after "diagram ›" on a reaction: when the diagram already has these reactants the product line is
 * added to it (once, at most 20 lines), otherwise a new diagram starts with this one channel.
 */
export function diagramHandoff(dg, lhs, rhs) {
    const same = String(dg.r || '').trim() === lhs;
    if (!same) return { r: lhs, p: [rhs], l: [], nm: '', c: 'fan' };
    const have = dg.p.map((x) => x.trim()).filter(Boolean);
    return { ...dg, p: have.includes(rhs) ? have : [...have, rhs].slice(0, 20) };
}
