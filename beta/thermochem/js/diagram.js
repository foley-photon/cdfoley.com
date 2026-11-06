// Energy level diagram: lays out reactants, user-named intermediates / transition states / roaming saddles and
// product channels on an energy axis and returns a self-contained SVG string. Pure functions, no DOM; usable from
// Node for tests. Energies are kJ/mol relative to the reactants; the axis is drawn in the chosen unit.

import { fromKJ, toKJ, kjToNm } from './engine.js';

export const KINDS = Object.freeze({
    reactant: 'Reactants',
    intermediate: 'Intermediate',
    ts: 'Transition state',
    roaming: 'Roaming saddle',
    product: 'Products',
});
const DIGITS = { 'kJ/mol': 1, 'kcal/mol': 1, 'eV': 3, 'cm⁻¹': 0, 'K': 0, 'Eh': 4 };

const escX = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (x, d) => { const v = Math.abs(x) < 0.5 * 10 ** -d ? 0 : x; return v.toFixed(d).replace(/^-/, '−'); };

/** "Nice" tick step for a span divided into about n intervals. */
export function niceStep(span, n = 6) {
    const raw = span / n; const p = 10 ** Math.floor(Math.log10(raw)); const f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

/**
 * Chemical text to SVG tspans: digits after an element or bracket become subscripts, a trailing charge on a formula
 * token becomes a superscript ("CH3+" → CH₃⁺). Words in parentheses (state labels) are left as typed.
 */
export function formulaTspans(text) {
    return String(text).split(/(\s+)/).map((tok) => {
        if (/^\s+$/.test(tok) || tok === '+') return escX(tok);
        const m = /^(.*?[A-Za-z0-9)\]])((?:\+|-|−)\d?)$/.exec(tok);
        const core = m && /[A-Z]/.test(m[1]) ? m[1] : tok; const ch = m && /[A-Z]/.test(m[1]) ? m[2].replace('-', '−') : '';
        // subscripts only outside parentheses (keep "O(1D)" readable as typed)
        let out = ''; let depth = 0;
        for (let i = 0; i < core.length; i++) {
            const c = core[i];
            if (c === '(') depth++; else if (c === ')') depth = Math.max(0, depth - 1);
            if (/\d/.test(c) && depth === 0 && i > 0 && /[A-Za-z)\]\d]/.test(core[i - 1]) && !/^\d/.test(core)) {
                let j = i; while (j < core.length && /\d/.test(core[j])) j++;
                out += `<tspan baseline-shift="sub" font-size="75%">${core.slice(i, j)}</tspan>`; i = j - 1; continue;
            }
            out += escX(c);
        }
        return out + (ch ? `<tspan baseline-shift="super" font-size="70%">${escX(ch)}</tspan>` : '');
    }).join('');
}

/**
 * Build the SVG. model: {
 *   unit, title?,
 *   levels: [{ label, kj, kind, plain? }]  (kj relative to the reactants; the first level is normally the reactants;
 *             plain: draw the label as typed, without formula subscripts, as for user-named levels like "TS1"),
 *   photon: { kj, label } | null, connect: 'none' | 'fan' | 'chain',
 * }
 * opts: { width (available px), colors: {bg, text, muted, grid, reactant, product, intermediate, ts, roaming, photon} }.
 * Returns { svg, width, height, columns: [{x, y, kj, label, kind}] }.
 */
export function buildDiagram(model, opts = {}) {
    const C = { bg: '#ffffff', text: '#1f2937', muted: '#6b7280', grid: '#e5e7eb', reactant: '#1f2937', product: '#2563eb', intermediate: '#7c3aed', ts: '#dc2626', roaming: '#d97706', photon: '#059669', ...(opts.colors || {}) };
    const unit = model.unit || 'kJ/mol';
    const levels = (model.levels || []).filter((l) => Number.isFinite(l.kj));
    const d = DIGITS[unit] ?? 2;
    const font = 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    const labelChars = Math.max(6, ...levels.map((l) => String(l.label).length));
    const left = 64; const right = 16; const top = 30; const bottom = 34;
    const avail = Math.max(300, opts.width || 720);
    // on a narrow screen the columns stay near 70 px and long labels are cut with an ellipsis (full text in a tooltip)
    const narrow = (opts.width || 720) < 600;
    const colMin = narrow ? 70 : Math.min(220, Math.max(92, labelChars * 6.4 + 18));
    const n = Math.max(1, levels.length);
    const colW = Math.max(colMin, (avail - left - right) / n);
    const W = Math.round(left + right + n * colW);
    const H = Math.round(opts.height || Math.max(300, Math.min(520, W * 0.6)));
    const vals = levels.map((l) => l.kj).concat([0]);
    if (model.photon && Number.isFinite(model.photon.kj)) vals.push(model.photon.kj);
    let lo = Math.min(...vals); let hi = Math.max(...vals);
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad * 1.4;
    const y = (kj) => top + (H - top - bottom) * (1 - (kj - lo) / (hi - lo));
    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${font}" font-size="12" role="img" aria-label="${escX(model.title || 'Energy level diagram')}">`);
    out.push(`<title>${escX(model.title || 'Energy level diagram')}</title>`);
    out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>`);
    // text drawn over lines gets a halo in the background colour, so dashed connectors and the photon line never cross it
    const HALO = `stroke="${C.bg}" stroke-width="4" stroke-linejoin="round" paint-order="stroke"`;
    const fit = (t, px) => { const n = Math.max(3, Math.floor((px - 6) / 6.4)); const str = String(t); return str.length > n ? `${str.slice(0, n - 1)}…` : str; };
    // axis and grid in the chosen unit
    const uLo = fromKJ(lo, unit); const uHi = fromKJ(hi, unit);
    const step = niceStep(uHi - uLo, 6);
    const sd = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    for (let t = Math.ceil(uLo / step) * step; t <= uHi + 1e-9; t += step) {
        const yy = y(toKJ(t, unit)).toFixed(1);
        out.push(`<line x1="${left}" x2="${W - right}" y1="${yy}" y2="${yy}" stroke="${C.grid}" stroke-width="1"/>`);
        out.push(`<text x="${left - 6}" y="${(+yy + 4).toFixed(1)}" text-anchor="end" fill="${C.muted}" font-size="11">${fmt(t, sd)}</text>`);
    }
    out.push(`<line x1="${left}" x2="${left}" y1="${top - 6}" y2="${H - bottom}" stroke="${C.muted}" stroke-width="1"/>`);
    out.push(`<text transform="translate(14 ${((top + H - bottom) / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" fill="${C.muted}" font-size="11">Energy relative to reactants, ${escX(unit)} (0 K)</text>`);
    // photon line
    if (model.photon && Number.isFinite(model.photon.kj)) {
        const yy = y(model.photon.kj).toFixed(1);
        out.push(`<line x1="${left}" x2="${W - right}" y1="${yy}" y2="${yy}" stroke="${C.photon}" stroke-width="1.5" stroke-dasharray="6 4"/>`);
        out.push(`<text x="${W - right - 4}" y="${(+yy - 5).toFixed(1)}" text-anchor="end" fill="${C.photon}" font-size="11.5" font-weight="600" ${HALO}>${escX(model.photon.label || 'hν')}</text>`);
    }
    // levels
    const cols = levels.map((l, i) => {
        const cx = left + colW * (i + 0.5);
        const bw = Math.min(colW * 0.68, 120);
        return { ...l, x1: cx - bw / 2, x2: cx + bw / 2, cx, y: y(l.kj) };
    });
    // connectors (drawn first, under the bars)
    const conn = (a, b) => out.push(`<line x1="${a.x2.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x1.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${C.muted}" stroke-width="1" stroke-dasharray="3 3"/>`);
    const R = cols.filter((c) => c.kind === 'reactant');
    const mid = cols.filter((c) => c.kind !== 'reactant' && c.kind !== 'product');
    const P = cols.filter((c) => c.kind === 'product');
    if (R.length && model.connect === 'fan') for (const c of [...mid, ...P]) conn(R[0], c);
    if (R.length && model.connect === 'chain') {
        let prev = R[0];
        for (const c of mid) { conn(prev, c); prev = c; }
        for (const c of P) conn(prev, c);
    }
    for (const c of cols) {
        const col = C[c.kind] || C.text;
        out.push(`<line x1="${c.x1.toFixed(1)}" x2="${c.x2.toFixed(1)}" y1="${c.y.toFixed(1)}" y2="${c.y.toFixed(1)}" stroke="${col}" stroke-width="3" stroke-linecap="round"/>`);
        const lab = narrow ? fit(c.label, colW) : String(c.label);
        const tip = lab !== String(c.label) ? `<title>${escX(c.label)}</title>` : '';
        out.push(`<text x="${c.cx.toFixed(1)}" y="${(c.y - 8).toFixed(1)}" text-anchor="middle" fill="${C.text}" font-weight="600" ${HALO}>${tip}${c.plain || lab !== String(c.label) ? escX(lab) : formulaTspans(lab)}</text>`);
        const kind = c.kind !== 'reactant' && c.kind !== 'product' ? ` · ${KINDS[c.kind] || ''}` : '';
        const val = `${fmt(fromKJ(c.kj, unit), d)}${narrow ? '' : kind}`;
        out.push(`<text x="${c.cx.toFixed(1)}" y="${(c.y + 16).toFixed(1)}" text-anchor="middle" fill="${C.muted}" font-size="11" ${HALO}>${escX(val)}</text>`);
    }
    // legend
    const used = [...new Set(cols.map((c) => c.kind))].filter((k) => k !== 'reactant');
    let lx = left + 4;
    for (const k of used) {
        out.push(`<line x1="${lx}" x2="${lx + 16}" y1="${H - 12}" y2="${H - 12}" stroke="${C[k]}" stroke-width="3" stroke-linecap="round"/>`);
        out.push(`<text x="${lx + 21}" y="${H - 8}" fill="${C.muted}" font-size="11">${escX(KINDS[k])}</text>`);
        lx += 30 + KINDS[k].length * 6.2;
    }
    if (model.photon && Number.isFinite(model.photon.kj) && model.photon.kj > 0) {
        const nm = kjToNm(model.photon.kj);
        out.push(`<desc>Photon ${nm ? nm.toFixed(1) + ' nm' : ''}</desc>`);
    }
    out.push('</svg>');
    return { svg: out.join(''), width: W, height: H, columns: cols };
}
