// To-scale schematic of a pumping line as an SVG string (spec 4.4). Pure: no DOM, deterministic output, no colour
// literals (every colour is a CSS variable, a color-mix() of variables, or a class styled in conductance.css).
//   renderSchematic(analysis, { mode: 'scale' | 'compressed', basis: 'op' | 'mol', fmtLen, fmtP, fmtSpeed, items })
//     -> { svg, width, height, items: [{ path, x0, x1 }] }
// items (the model's Item[]) is required for the geometry, which the AnalysisResult does not carry.

const BORE_PX = 120;                 // the largest bore is drawn this tall (viewBox units)
const SIDE = 14, TOP = 6, BOTTOM = 6, BADGE_ROW = 22, DIM_ROW = 15, ROWS = 3;
const CHAMBER_W = 96, PUMP_NECK = 10, BUS_GAP = 10, LANE_LABEL = 16, LANE_PAD = 5, LANE_GAP = 6;
const CHAR_W = 6.2;                  // label width estimate per character at 11 px

/** Share steps (upper bounds) and the mix percentages of var(--c2) into var(--surface) (spec 4.4). */
export const SHARE_STEPS = Object.freeze([0.05, 0.15, 0.30, 0.50]);
export const SHARE_MIX = Object.freeze([12, 30, 50, 70, 90]);
export const SHARE_LEGEND = Object.freeze(['0–5 %', '5–15 %', '15–30 %', '30–50 %', '> 50 %']);

/** Step index 0…4 of a share of the total resistance. */
export function shareStep(share) {
    const s = Number.isFinite(share) ? share : 0;
    let k = 0;
    while (k < SHARE_STEPS.length && s > SHARE_STEPS[k]) k++;
    return k;
}

/** Inline style of the fill for a share. */
export function shareFill(share) {
    return `fill: color-mix(in srgb, var(--c2) ${SHARE_MIX[shareStep(share)]}%, var(--surface))`;
}

/** Compressed axial length (spec 4.4): min(l, 3D) + D ln(1 + max(0, l − 3D)/D). */
export function compressLength(l, D) {
    return Math.min(l, 3 * D) + D * Math.log1p(Math.max(0, l - 3 * D) / D);
}

const GEOMETRIC = new Set(['tube', 'orifice', 'slit', 'rect', 'annulus', 'cone', 'elbow', 'bbox']);
const NOUN = { tube: 'tube', orifice: 'orifice', slit: 'slit', rect: 'duct', annulus: 'annulus', cone: 'cone', elbow: 'elbow', bbox: 'black box', chamber: 'chamber', parallel: 'parallel group', pump: 'pump' };

/** Drawn height (m) of an item: its bore; the short side for ducts and slits. */
export function boreOf(it) {
    switch (it && it.t) {
        case 'tube': case 'elbow': case 'bbox': case 'pump': return it.d;
        case 'cone': return Math.max(it.d1, it.d2);
        case 'annulus': return it.do;
        case 'rect': return Math.min(it.a, it.b);
        case 'slit': return Math.min(it.h, it.w);
        case 'orifice': return it.shape === 'rect' ? Math.min(it.w, it.h) : it.d;
        default: return 0;
    }
}

// Axial length (m) drawn for an item (the black box is drawn as long as its bore).
function axialOf(it) {
    switch (it.t) {
        case 'tube': case 'cone': case 'annulus': case 'rect': case 'slit': return it.L;
        case 'elbow': return it.A + it.B;
        case 'bbox': return it.d;
        default: return 0;
    }
}

const pos = (x) => (Number.isFinite(x) && x > 0 ? x : 0);

/** The largest bore (m) of a line: geometric items, branch items and the pump. */
export function largestBore(items) {
    let D = 0;
    for (const it of items || []) {
        if (!it) continue;
        if (it.t === 'parallel') for (const br of it.branches || []) for (const s of br || []) D = Math.max(D, pos(boreOf(s)));
        else D = Math.max(D, pos(boreOf(it)));
    }
    return D;
}

/** Total axial length (m) of the top-level run (a parallel group counts its longest branch). */
export function totalLength(items) {
    let L = 0;
    for (const it of items || []) {
        if (!it) continue;
        if (it.t === 'parallel') L += Math.max(0, ...(it.branches || []).map((br) => (br || []).reduce((s, x) => s + (x && GEOMETRIC.has(x.t) ? pos(axialOf(x)) : 0), 0)));
        else if (GEOMETRIC.has(it.t)) L += pos(axialOf(it));
    }
    return L;
}

/** The default horizontal mode: compressed when the total length exceeds 12 × the largest bore. */
export function defaultMode(items) {
    const D = largestBore(items);
    return D > 0 && totalLength(items) > 12 * D ? 'compressed' : 'scale';
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '');
const pathNum = (p) => String(p).split('.').map((x) => Number(x) + 1).join('.');
const pctInt = (s) => (Number.isFinite(s) ? Math.round(s * 100) + ' %' : '—');
const pct3 = (s) => (Number.isFinite(s) ? String(Number((s * 100).toPrecision(3))) + ' %' : '—');
const FMT_LEN = (m) => String(Number((m * 1000).toPrecision(4))) + ' mm';
const FMT_P = (p) => String(Number(p.toPrecision(3))) + ' Pa';
const FMT_SPEED = (s) => String(Number((s * 1000).toPrecision(4))) + ' L/s';

// "Ø100 × 200 mm": numbers from fmtLen with the unit written once
function dims(fmtLen, vals, build) {
    const parts = vals.map((v) => { const s = fmtLen(v), m = /^(.*?)\s+(\S+)$/.exec(s); return m ? [m[1], m[2]] : [s, '']; });
    const unit = parts.every((p) => p[1] === parts[0][1]) ? parts[0][1] : '';
    const n = parts.map((p) => (unit ? p[0] : p.join(' ').trim()));
    return build(n) + (unit ? ' ' + unit : '');
}

function dimText(it, fmtLen, fmtSpeed) {
    switch (it.t) {
        case 'tube': return dims(fmtLen, [it.d, it.L], (n) => `Ø${n[0]} × ${n[1]}`);
        case 'cone': return dims(fmtLen, [it.d1, it.d2, it.L], (n) => `Ø${n[0]} → Ø${n[1]} × ${n[2]}`);
        case 'annulus': return dims(fmtLen, [it.do, it.di, it.L], (n) => `Ø${n[0]}/Ø${n[1]} × ${n[2]}`);
        case 'rect': return dims(fmtLen, [Math.min(it.a, it.b), Math.max(it.a, it.b), it.L], (n) => `${n[0]} × ${n[1]}, L ${n[2]}`);
        case 'slit': return dims(fmtLen, [it.h, it.w, it.L], (n) => `${n[0]} × ${n[1]}, L ${n[2]}`);
        case 'elbow': return dims(fmtLen, [it.d, it.A, it.B], (n) => `Ø${n[0]}, legs ${n[1]}/${n[2]}`);
        case 'orifice': return it.shape === 'rect' ? dims(fmtLen, [it.w, it.h], (n) => `${n[0]} × ${n[1]}`) : dims(fmtLen, [it.d], (n) => `Ø${n[0]}`);
        case 'bbox': return `${labelOf(it, 'Black box')}: ${fmtSpeed(it.C)}`;
        case 'pump': return `${labelOf(it, 'Pump')}: ${fmtSpeed(it.S)}`;
        default: return '';
    }
}
const labelOf = (it, fallback) => (typeof it.label === 'string' && it.label.trim() ? it.label.replace(/_/g, ' ').trim() : fallback);

// Map from item path ('3', '4.1.2') to the index of the analysis element that covers it (merged elements included).
function coverage(analysis) {
    const map = new Map();
    (analysis.elements || []).forEach((e, k) => {
        const parts = String(e.path).split('.');
        const idx = (e.mergedFrom && e.mergedFrom.length ? e.mergedFrom : [Number(parts[parts.length - 1])]);
        for (const j of idx) map.set(parts.length === 1 ? String(j) : `${parts[0]}.${parts[1]}.${j}`, k);
    });
    return map;
}

// Label rows: place [x0, x1] in the first of ROWS rows where it does not overlap; -1 when none is free.
function placer() {
    const ends = new Array(ROWS).fill(-Infinity);
    return (x0, x1) => {
        for (let r = 0; r < ROWS; r++) if (x0 >= ends[r] + 4) { ends[r] = x1; return r; }
        return -1;
    };
}

/**
 * Renders the schematic. analysis: an AnalysisResult with ok: true; opts.items: the model's items (required).
 * Returns { svg, width, height, items: [{ path, x0, x1 }] } in viewBox units (1 unit = 1 px at full size).
 */
export function renderSchematic(analysis, opts = {}) {
    const items = opts.items || analysis.items || [];
    const mode = opts.mode === 'compressed' ? 'compressed' : 'scale';
    const basis = opts.basis === 'mol' ? 'mol' : 'op';
    const fmtLen = opts.fmtLen || FMT_LEN, fmtP = opts.fmtP || FMT_P, fmtSpeed = opts.fmtSpeed || FMT_SPEED;
    const pumpMode = !analysis.bc || analysis.bc.mode !== 'dp';
    const D = largestBore(items) || 0.01;
    const k = BORE_PX / D;
    const hpx = (m) => pos(m) * k;
    const wpx = (m) => (mode === 'scale' ? pos(m) : compressLength(pos(m), D)) * k;
    const cover = coverage(analysis);
    const els = analysis.elements || [];
    const shareOfEl = (i) => (basis === 'mol' ? (analysis.shareMol || [])[i] : (els[i] || {}).share);
    const pumpShare = analysis.pump ? (basis === 'mol' ? analysis.pump.shareMol : analysis.pump.share) : null;
    const basisText = basis === 'mol' ? 'in molecular flow' : 'at this pressure';

    // ---- parts of the main row
    const parts = [];
    const chamberH = Math.max(1.4 * D * k, 40);
    parts.push({ kind: 'start', w: CHAMBER_W, half: chamberH / 2 });
    items.forEach((it, i) => {
        if (!it || !ELEMENT_KINDS.has(it.t)) return;
        const path = String(i);
        if (it.t === 'pump') {
            const r = Math.max(hpx(it.d) / 2, 18);
            parts.push({ kind: 'pump', it, path, w: PUMP_NECK + 2 * r + 2, half: r, r });
        } else if (it.t === 'chamber') {
            parts.push({ kind: 'chamber', it, path, w: Math.max(40, Math.min(CHAMBER_W, 0.6 * chamberH)), half: chamberH / 2 });
        } else if (it.t === 'parallel') {
            const lanes = (it.branches || []).map((br, b) => {
                const subs = (br || []).filter((s) => s && GEOMETRIC.has(s.t)).map((s) => ({ it: s, path: `${i}.${b}.${br.indexOf(s)}`, w: elemW(s), h: Math.max(hpx(boreOf(s)), 2) }));
                const hMax = Math.max(4, ...subs.map((s) => s.h));
                return { subs, len: subs.reduce((a, s) => a + s.w, 0), hMax, height: LANE_LABEL + hMax + LANE_PAD };
            });
            const total = lanes.reduce((a, l) => a + l.height, 0) + LANE_GAP * Math.max(0, lanes.length - 1);
            parts.push({ kind: 'group', it, path, lanes, w: 2 * BUS_GAP + Math.max(20, ...lanes.map((l) => l.len)), half: total / 2 });
        } else {
            parts.push({ kind: 'el', it, path, w: elemW(it), half: Math.max(hpx(boreOf(it)), 2) / 2 });
        }
    });
    if (!pumpMode) parts.push({ kind: 'end', w: CHAMBER_W, half: chamberH / 2 });

    function elemW(it) {
        if (it.t === 'orifice') return 3;
        return Math.max(4, wpx(axialOf(it)));
    }

    const half = Math.max(...parts.map((p) => p.half));
    const top = TOP + BADGE_ROW * 2;
    const cy = top + half;
    const height = Math.round(cy + half + DIM_ROW * ROWS + BOTTOM);
    let x = SIDE;
    for (const p of parts) { p.x0 = x; x += p.w; p.x1 = x; }
    const width = Math.round(x + SIDE);

    // ---- drawing
    const body = [], labels = [], out = [];
    const badgeRow = placer(), dimRow = placer();
    const badge = (p, xc, text) => {
        const w = Math.max(18, text.length * 7 + 8), r = badgeRow(xc - w / 2, xc + w / 2);
        if (r < 0) return;
        const y = top - BADGE_ROW * (r + 0.5) - 2;
        labels.push(`<g class="cl-sch-badge" aria-hidden="true"><rect x="${f1(xc - w / 2)}" y="${f1(y - 8)}" width="${f1(w)}" height="16" rx="8"/><text x="${f1(xc)}" y="${f1(y + 3.5)}" text-anchor="middle">${esc(text)}</text></g>`);
        if (r > 0) labels.push(`<line class="cl-sch-leader" x1="${f1(xc)}" y1="${f1(y + 8)}" x2="${f1(xc)}" y2="${f1(cy - p.half - 2)}"/>`);
    };
    const dimLabel = (xc, text) => {
        if (!text) return;
        const w = text.length * CHAR_W, r = dimRow(xc - w / 2, xc + w / 2);
        if (r < 0) return;
        labels.push(`<text class="cl-sch-dim" x="${f1(xc)}" y="${f1(cy + half + DIM_ROW * (r + 0.8))}" text-anchor="middle">${esc(text)}</text>`);
    };
    const titleFor = (path, it, ei) => {
        const name = `Element ${pathNum(path)} (${it.t === 'bbox' ? labelOf(it, 'black box') : NOUN[it.t]})`;
        if (ei === undefined) return `${name}: no flow results`;
        const e = els[ei], merged = e.mergedFrom && e.mergedFrom.length > 1 ? ', merged for the calculation' : '';
        if (e.flags && e.flags.includes('no-effect')) return `${name}: no effect (at least as large as the bore before it)`;
        const C = basis === 'mol' ? e.Cmol : (e.Cop ?? e.Cmol);
        return `${name}${merged}: ${pct3(shareOfEl(ei))} of the total resistance ${basisText}; C = ${fmtSpeed(C)}`;
    };

    // one geometric element at [x0, x0 + w] on axis y; prevH: drawn bore before it (for orifice plates)
    const drawEl = (it, path, x0, w, y, prevH, nextH) => {
        const ei = cover.get(path), style = shareFill(ei === undefined ? 0 : shareOfEl(ei));
        const h = Math.max(hpx(boreOf(it)), 2), x1 = x0 + w, s = [];
        const rect = (yy, hh, cls = 'cl-sch-shape') => `<rect class="${cls}" x="${f1(x0)}" y="${f1(yy)}" width="${f1(w)}" height="${f1(hh)}" style="${style}"/>`;
        switch (it.t) {
            case 'tube': case 'rect': case 'slit': s.push(rect(y - h / 2, h)); break;
            case 'bbox': s.push(rect(y - h / 2, h, 'cl-sch-shape cl-sch-bbox')); break;
            case 'annulus': {
                const hi = Math.max(hpx(it.di), 1);
                s.push(rect(y - h / 2, h));
                s.push(`<rect class="cl-sch-rod" x="${f1(x0)}" y="${f1(y - hi / 2)}" width="${f1(w)}" height="${f1(hi)}"/>`);
                s.push(`<rect class="cl-sch-hatch" x="${f1(x0)}" y="${f1(y - hi / 2)}" width="${f1(w)}" height="${f1(hi)}" fill="url(#cl-sch-hatch)"/>`);
                break;
            }
            case 'cone': {
                const h1 = Math.max(hpx(it.d1), 2) / 2, h2 = Math.max(hpx(it.d2), 2) / 2;
                s.push(`<path class="cl-sch-shape" d="M${f1(x0)},${f1(y - h1)}L${f1(x1)},${f1(y - h2)}L${f1(x1)},${f1(y + h2)}L${f1(x0)},${f1(y + h1)}Z" style="${style}"/>`);
                break;
            }
            case 'elbow': {
                s.push(rect(y - h / 2, h));
                const xa = x0 + w * (it.A / (it.A + it.B)), r = Math.min(h * 0.35, 12, w / 2);
                s.push(`<path class="cl-sch-bend" d="M${f1(xa - r)},${f1(y)}A${f1(r)},${f1(r)} 0 0 1 ${f1(xa)},${f1(y - r)}M${f1(xa)},${f1(y - h / 2)}V${f1(y + h / 2)}"/>`);
                break;
            }
            case 'orifice': {
                const outer = Math.max(prevH || nextH || h * 1.6, h) / 2;
                if (outer - h / 2 < 0.5) s.push(`<line class="cl-sch-noeffect" x1="${f1(x0 + 1.5)}" y1="${f1(y - h / 2)}" x2="${f1(x0 + 1.5)}" y2="${f1(y + h / 2)}"/>`);
                else {
                    s.push(`<rect class="cl-sch-plate" x="${f1(x0)}" y="${f1(y - outer)}" width="3" height="${f1(outer - h / 2)}" style="${style}"/>`);
                    s.push(`<rect class="cl-sch-plate" x="${f1(x0)}" y="${f1(y + h / 2)}" width="3" height="${f1(outer - h / 2)}" style="${style}"/>`);
                }
                break;
            }
            default: break;
        }
        const len = it.t === 'elbow' ? it.A + it.B : axialOf(it);
        if (mode === 'compressed' && it.t !== 'orifice' && it.t !== 'bbox' && len > 3 * D) {
            const xm = x0 + w / 2, hh = h / 2 + 4;
            s.push(`<path class="cl-sch-break" d="M${f1(xm - 5)},${f1(y + hh)}L${f1(xm - 1)},${f1(y - hh)}M${f1(xm + 1)},${f1(y + hh)}L${f1(xm + 5)},${f1(y - hh)}"/>`);
        }
        const title = titleFor(path, it, ei);
        out.push({ path, x0: Math.round(x0 * 10) / 10, x1: Math.round(x1 * 10) / 10 });
        return `<g class="cl-sch-el" data-path="${path}" tabindex="0" role="button" aria-label="${esc(title)}"><title>${esc(title)}</title>${s.join('')}</g>`;
    };

    let prevH = chamberH;
    parts.forEach((p, idx) => {
        const next = parts[idx + 1];
        const nextH = next && next.kind === 'el' ? Math.max(hpx(boreOf(next.it)), 2) : 0;
        if (p.kind === 'start' || p.kind === 'end' || p.kind === 'chamber') {
            const h = 2 * p.half, label = p.kind === 'end' ? 'Downstream' : 'Chamber';
            const pText = p.kind === 'start' ? fmtP(analysis.bc.p0) : p.kind === 'end' ? fmtP(analysis.bc.p1) : '';
            const g = [`<rect class="cl-sch-plenum" x="${f1(p.x0)}" y="${f1(cy - p.half)}" width="${f1(p.w)}" height="${f1(h)}" rx="10"/>`,
                `<text class="cl-sch-plenum-t" x="${f1(p.x0 + p.w / 2)}" y="${f1(cy - (pText ? 3 : -4))}" text-anchor="middle">${label}</text>`];
            if (pText) g.push(`<text class="cl-sch-plenum-p" x="${f1(p.x0 + p.w / 2)}" y="${f1(cy + 13)}" text-anchor="middle">${esc((p.kind === 'end' ? 'p₂ ' : pumpMode ? 'p₀ ' : 'p₁ ') + pText)}</text>`);
            if (p.kind === 'chamber') {
                const title = `Element ${pathNum(p.path)}: chamber (a large volume, an ideal mixing plenum)`;
                body.push(`<g class="cl-sch-el" data-path="${p.path}" tabindex="0" role="button" aria-label="${esc(title)}"><title>${esc(title)}</title>${g.join('')}</g>`);
                out.push({ path: p.path, x0: p.x0, x1: p.x1 });
                badge(p, p.x0 + p.w / 2, pathNum(p.path));
            } else body.push(`<g class="cl-sch-end" aria-hidden="true">${g.join('')}</g>`);
            prevH = h;
            return;
        }
        if (p.kind === 'el') {
            body.push(drawEl(p.it, p.path, p.x0, p.w, cy, prevH, nextH));
            badge(p, p.x0 + p.w / 2, pathNum(p.path));
            dimLabel(p.x0 + p.w / 2, dimText(p.it, fmtLen, fmtSpeed));
            prevH = p.it.t === 'orifice' ? Math.max(hpx(boreOf(p.it)), 2)
                : p.it.t === 'cone' ? Math.max(hpx(p.it.d2), 2) : Math.max(hpx(boreOf(p.it)), 2);
            return;
        }
        if (p.kind === 'group') {
            const g = [], yTop = cy - p.half, xIn = p.x0, xOut = p.x1;
            g.push(`<line class="cl-sch-bus" x1="${f1(xIn)}" y1="${f1(yTop)}" x2="${f1(xIn)}" y2="${f1(cy + p.half)}"/>`);
            g.push(`<line class="cl-sch-bus" x1="${f1(xOut)}" y1="${f1(yTop)}" x2="${f1(xOut)}" y2="${f1(cy + p.half)}"/>`);
            let yy = yTop;
            for (const lane of p.lanes) {
                const yl = yy + LANE_LABEL + lane.hMax / 2;
                let xx = xIn + BUS_GAP, ph = 0;
                g.push(`<line class="cl-sch-thin" x1="${f1(xIn)}" y1="${f1(yl)}" x2="${f1(xx)}" y2="${f1(yl)}"/>`);
                lane.subs.forEach((s, j) => {
                    const nh = lane.subs[j + 1] ? lane.subs[j + 1].h : 0;
                    g.push(drawEl(s.it, s.path, xx, s.w, yl, ph || lane.hMax + 6, nh));
                    g.push(`<text class="cl-sch-lane" x="${f1(xx + s.w / 2)}" y="${f1(yy + LANE_LABEL - 4)}" text-anchor="middle" aria-hidden="true">${esc(pathNum(s.path))}</text>`);
                    ph = s.it.t === 'cone' ? Math.max(hpx(s.it.d2), 2) : s.h;
                    xx += s.w;
                });
                if (xx < xOut) g.push(`<line class="cl-sch-thin" x1="${f1(xx)}" y1="${f1(yl)}" x2="${f1(xOut)}" y2="${f1(yl)}"/>`);
                yy += lane.height + LANE_GAP;
            }
            body.push(`<g class="cl-sch-group" data-path="${p.path}">${g.join('')}</g>`);
            badge(p, p.x0 + p.w / 2, pathNum(p.path));
            dimLabel(p.x0 + p.w / 2, `${p.lanes.length} branches`);
            prevH = 0;
            return;
        }
        if (p.kind === 'pump') {
            const r = p.r, cxp = p.x0 + PUMP_NECK + r, neck = Math.min(Math.max(hpx(p.it.d), 2), 2 * r);
            const style = shareFill(pumpShare);
            const tri = `M${f1(cxp + 0.78 * r)},${f1(cy)}L${f1(cxp - 0.39 * r)},${f1(cy - 0.675 * r)}L${f1(cxp - 0.39 * r)},${f1(cy + 0.675 * r)}Z`;
            const title = `Element ${pathNum(p.path)} (pump): ${pct3(pumpShare)} of the total resistance ${basisText}; S = ${fmtSpeed(p.it.S)}`;
            body.push(`<g class="cl-sch-el cl-sch-pump" data-path="${p.path}" tabindex="0" role="button" aria-label="${esc(title)}"><title>${esc(title)}</title>`
                + `<rect class="cl-sch-shape" x="${f1(p.x0)}" y="${f1(cy - neck / 2)}" width="${PUMP_NECK}" height="${f1(neck)}" style="${style}"/>`
                + `<circle class="cl-sch-shape" cx="${f1(cxp)}" cy="${f1(cy)}" r="${f1(r)}" style="${style}"/><path class="cl-sch-pump-tri" d="${tri}"/></g>`);
            out.push({ path: p.path, x0: p.x0, x1: Math.round(p.x1 * 10) / 10 });
            badge(p, cxp, pathNum(p.path));
            dimLabel(cxp, dimText(p.it, fmtLen, fmtSpeed));
        }
    });

    // ---- text alternative
    const nEl = items.filter((it) => it && (GEOMETRIC.has(it.t) || it.t === 'parallel' || it.t === 'chamber')).length;
    const lead = pumpMode
        ? `Pumping line of ${nEl} element${nEl === 1 ? '' : 's'}${analysis.pump ? ' and a pump' : ''}`
        : `Line of ${nEl} element${nEl === 1 ? '' : 's'} between two pressures`;
    let best = -1;
    els.forEach((e, i) => { if (best < 0 || (shareOfEl(i) || 0) > (shareOfEl(best) || 0)) best = i; });
    let tail;
    if (best >= 0) {
        const e = els[best];
        const noun = e.t === 'bbox' ? (e.label ? e.label.replace(/_/g, ' ') : 'black box') : NOUN[e.t];
        tail = `element ${pathNum(e.path)}, the ${noun}, takes ${pctInt(shareOfEl(best))} of the total resistance`;
        if (pumpShare !== null && pumpShare > (shareOfEl(best) || 0)) tail += `, and the pump ${pctInt(pumpShare)}`;
    } else tail = analysis.pump ? 'the pump sits directly on the chamber' : 'there are no elements';
    const desc = `${lead}; ${tail}${basis === 'mol' ? ' (molecular-flow limit)' : ''}.`;
    const title = `Schematic of the pumping line (${mode === 'scale' ? 'to scale' : 'lengths compressed'})`;

    // never drawn below 1:1, so the 11 px labels stay 11 px; a long line scrolls in .cl-schematic-scroll instead (v2.2)
    const minW = width;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" class="cl-schematic" viewBox="0 0 ${width} ${height}" width="100%" `
        + `style="max-width: ${width}px; min-width: ${minW}px" role="group" aria-labelledby="cl-sch-title" aria-describedby="cl-sch-desc">`
        + `<title id="cl-sch-title">${esc(title)}</title><desc id="cl-sch-desc">${esc(desc)}</desc>`
        + `<defs><pattern id="cl-sch-hatch" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">`
        + `<line class="cl-sch-hatch-line" x1="0" y1="0" x2="0" y2="5"/></pattern></defs>`
        + body.join('') + labels.join('') + '</svg>';
    return { svg, width, height, items: out, desc };
}

const ELEMENT_KINDS = new Set([...GEOMETRIC, 'chamber', 'parallel', 'pump']);
