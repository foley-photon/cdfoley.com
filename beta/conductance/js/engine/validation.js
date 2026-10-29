// Validation case runner and tolerance logic (spec 2.8, 5.1), shared by Node (run-validation.mjs) and the
// Self-test tab. Pure module.
//
// Case = { id, group: 'formula' | 'chain-mc' | 'mesh-mc' | 'negative', title, source: { label, url }, ref, refSigma,
//          tol, quick, unit?, catchRel?, run: (ctx) => number | outcome | Promise<outcome> }
// tol:   { rel } passes when |value/ref - 1| <= rel; { abs } when |value - ref| <= abs;
//        { sigmas, plusRel } when |value - ref| <= sigmas sqrt(sigma^2 + refSigma^2) + plusRel |ref|;
//        { sigmas, plusAbs } the same with an absolute allowance (deviation shown as a difference, not a ratio);
//        { band: true } when ref lies in [value (1 + lo), value (1 + hi)] for the outcome's band { lo, hi };
//        negative controls (group 'negative') are caught when |value/ref - 1| > catchRel (case or tol property).
// outcome: a number, or { value, sigma?, band?, caught?, error? }; a thrown error fails the row.

const MINUS = '−';
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const trim = (v) => String(Number(v.toPrecision(3)));

function pctText(x) {
    if (!Number.isFinite(x)) return String(x);
    const v = Math.abs(x) * 100;
    const s = v === 0 ? '0' : v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toPrecision(2);
    return (x < 0 ? MINUS : x > 0 ? '+' : '') + s + ' %';
}

function absText(x) {
    if (!Number.isFinite(x)) return String(x);
    const s = Math.abs(x) === 0 ? '0' : Math.abs(x) < 1e-3 || Math.abs(x) >= 1e4 ? Math.abs(x).toExponential(2) : Math.abs(x).toPrecision(3);
    return (x < 0 ? MINUS : x > 0 ? '+' : '') + s.replace('-', MINUS);
}

function catchRelOf(c) {
    if (Number.isFinite(c.catchRel)) return c.catchRel;
    if (c.tol && Number.isFinite(c.tol.catchRel)) return c.tol.catchRel;
    return null;
}

/** Tolerance text of a case, e.g. "±0.1 %", "3σ + 0.4 %", "caught if |dev| > 5 %". */
function tolText(c, band = null) {
    const t = c.tol || {};
    if (c.group === 'negative') { const cr = catchRelOf(c); return cr === null ? 'caught' : `caught if |dev| > ${trim(cr * 100)} %`; }
    if (Number.isFinite(t.rel)) return `±${trim(t.rel * 100)} %`;
    if (Number.isFinite(t.abs)) return `±${absText(t.abs).replace(/^\+/, '')}`;
    if (Number.isFinite(t.sigmas) && Number.isFinite(t.plusAbs)) return `${t.sigmas}σ + ${trim(t.plusAbs)}` + (c.unit === '%' ? ' pp' : c.unit ? ' ' + c.unit : '');
    if (Number.isFinite(t.sigmas)) return `${t.sigmas}σ` + (t.plusRel ? ` + ${trim(t.plusRel * 100)} %` : '');
    if (t.band) return band ? `reference inside ${pctText(band.lo)} … ${pctText(band.hi)}` : 'reference inside the band';
    return '';
}

/** Turns a case and its outcome into a result Row (spec 2.8). */
export function evaluate(caseObj, outcome) {
    const c = caseObj, o = typeof outcome === 'number' ? { value: outcome } : (outcome || {});
    const ref = c.ref, refSigma = Number.isFinite(c.refSigma) ? c.refSigma : 0;
    const value = Number.isFinite(o.value) ? o.value : NaN, sigma = Number.isFinite(o.sigma) ? o.sigma : 0;
    const t = c.tol || {}, negative = c.group === 'negative';
    const row = {
        id: c.id, group: c.group, title: c.title, source: c.source, ref, refSigma, unit: c.unit || '',
        value, sigma, dev: NaN, devText: '', tolText: tolText(c, o.band || null), pass: false, caught: negative ? false : null,
        ms: Number.isFinite(o.ms) ? o.ms : 0,
    };
    if (o.error !== undefined || !Number.isFinite(value)) {
        row.devText = o.error !== undefined ? `Error: ${o.error}` : 'No result';
        // a negative control that reports its own verdict (e.g. "the run stopped with the leak message") keeps it
        if (negative && o.error === undefined && typeof o.caught === 'boolean') row.pass = row.caught = o.caught;
        return row;
    }
    const useAbs = Number.isFinite(t.abs) || Number.isFinite(t.plusAbs) || ref === 0;
    if (t.band && o.band) {
        row.dev = ref / value - 1;                       // position of the reference relative to the formula value
        row.devText = pctText(row.dev);
        row.pass = ref >= value * (1 + o.band.lo) && ref <= value * (1 + o.band.hi);
    } else {
        row.dev = useAbs ? value - ref : value / ref - 1;
        row.devText = useAbs ? absText(row.dev) + (Number.isFinite(t.plusAbs) && c.unit === '%' ? ' pp' : '') : pctText(row.dev);
        if (negative) {
            const cr = catchRelOf(c);
            row.caught = typeof o.caught === 'boolean' ? o.caught : cr !== null && Math.abs(row.dev) > cr;
            row.pass = row.caught;
        } else if (Number.isFinite(t.rel)) {
            row.pass = Math.abs(value / ref - 1) <= t.rel;
        } else if (Number.isFinite(t.abs)) {
            row.pass = Math.abs(value - ref) <= t.abs;
        } else if (Number.isFinite(t.sigmas)) {
            row.pass = Math.abs(value - ref) <= t.sigmas * Math.sqrt(sigma * sigma + refSigma * refSigma) + (t.plusRel || 0) * Math.abs(ref) + (t.plusAbs || 0);
        }
    }
    if (typeof o.pass === 'boolean' && !negative) row.pass = row.pass && o.pass;
    return row;
}

/**
 * Runs cases one after another; onRow(row, index) after each; an aborted signal stops between cases.
 * ctx is passed to each case's run (the browser and Node pass { mc: McRunner }). Returns the rows.
 */
export async function runCases(cases, ctx, onRow, signal) {
    ctx = ctx || {};
    const rows = [];
    for (const c of cases) {
        if (signal && signal.aborted) break;
        const t0 = now();
        let outcome;
        try {
            outcome = await c.run(ctx);
        } catch (err) {
            outcome = { error: err && err.message ? err.message : String(err) };
        }
        const row = evaluate(c, outcome);
        row.ms = now() - t0;
        rows.push(row);
        if (onRow) onRow(row, rows.length - 1);
    }
    return rows;
}

/** Counts { formula: [passed, total], mc: [passed, total], negative: [caught, total] }. */
export function summarize(rows) {
    const count = (f, ok) => { const r = rows.filter(f); return [r.filter(ok).length, r.length]; };
    return {
        formula: count((r) => r.group === 'formula', (r) => r.pass),
        mc: count((r) => r.group === 'chain-mc' || r.group === 'mesh-mc', (r) => r.pass),
        negative: count((r) => r.group === 'negative', (r) => r.caught === true),
    };
}
