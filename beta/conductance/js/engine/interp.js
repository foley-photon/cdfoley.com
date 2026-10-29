// Interpolation machinery (spec 2.2, 3.4): monotone PCHIP, q-tables for ducts, the cone kappa table and the
// three-point tail fit. Pure module. PCHIP follows Fritsch & Carlson (1980) with Fritsch-Butland interior slopes
// and SciPy's PchipInterpolator end rules; outside the nodes it extrapolates linearly with the end slope.

const DEG = Math.PI / 180;

function checkNodes(x, y) {
    const n = x.length;
    if (!(n >= 2) || y.length !== n) throw new RangeError('PCHIP needs at least two nodes with matching x and y.');
    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) throw new RangeError('PCHIP nodes must be finite numbers.');
        if (i > 0 && !(x[i] > x[i - 1])) throw new RangeError('PCHIP nodes must be strictly increasing in x.');
    }
}

function slopesInto(x, y, d) {
    const n = x.length;
    if (n === 2) { d[0] = d[1] = (y[1] - y[0]) / (x[1] - x[0]); return d; }
    let h0 = x[1] - x[0], m0 = (y[1] - y[0]) / h0;
    const hA = h0, mA = m0;
    let h1 = 0, m1 = 0;
    for (let i = 1; i < n - 1; i++) {
        h1 = x[i + 1] - x[i]; m1 = (y[i + 1] - y[i]) / h1;
        if (m0 * m1 <= 0) d[i] = 0;
        else { const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0; d[i] = (w1 + w2) / (w1 / m0 + w2 / m1); }
        if (i === 1) { d[0] = endSlope(hA, h1, mA, m1); }
        h0 = h1; m0 = m1;
    }
    // last interval: h0, m0 = final secant; previous secant needed for the end rule
    const hB = x[n - 1] - x[n - 2], mB = (y[n - 1] - y[n - 2]) / hB;
    const hC = x[n - 2] - x[n - 3], mC = (y[n - 2] - y[n - 3]) / hC;
    d[n - 1] = endSlope(hB, hC, mB, mC);
    return d;
}

// One-sided three-point end slope with SciPy's shape-preserving limits.
function endSlope(h0, h1, m0, m1) {
    let d = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
    if (Math.sign(d) !== Math.sign(m0)) d = 0;
    else if (Math.sign(m0) !== Math.sign(m1) && Math.abs(d) > Math.abs(3 * m0)) d = 3 * m0;
    return d;
}

/** PCHIP node slopes (Float64Array). x strictly increasing, n >= 2. */
export function pchipSlopes(x, y) {
    checkNodes(x, y);
    return slopesInto(x, y, new Float64Array(x.length));
}

/** Index i with x[i] <= t < x[i+1], clamped to [0, n-2]. */
export function findInterval(x, t) {
    const n = x.length;
    if (!(t >= x[1])) return 0;
    if (t >= x[n - 2]) return n - 2;
    let lo = 1, hi = n - 2;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x[m] <= t) lo = m; else hi = m; }
    return lo;
}

function hermite(x, y, d, t) {
    const n = x.length;
    if (t <= x[0]) return y[0] + d[0] * (t - x[0]);
    if (t >= x[n - 1]) return y[n - 1] + d[n - 1] * (t - x[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x[m] <= t) lo = m; else hi = m; }
    const hh = x[hi] - x[lo], s = (t - x[lo]) / hh, s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * y[lo] + (s3 - 2 * s2 + s) * hh * d[lo] + (-2 * s3 + 3 * s2) * y[hi] + (s3 - s2) * hh * d[hi];
}

/** Monotone cubic interpolant through (x, y); linear extrapolation with the end slopes. */
export function makePchip(x, y) {
    checkNodes(x, y);
    const X = Float64Array.from(x), Y = Float64Array.from(y), D = slopesInto(X, Y, new Float64Array(X.length));
    return (t) => hermite(X, Y, D, t);
}

/** q(l) = c0 + (c1 + c2 ln l)/l through the three points (ls[k], qs[k]) (spec 3.4.2). */
export function fitTail3(ls, qs) {
    if (ls.length !== 3 || qs.length !== 3) throw new RangeError('The tail fit needs exactly three points.');
    const M = [0, 1, 2].map((k) => [1, 1 / ls[k], Math.log(ls[k]) / ls[k], qs[k]]);
    for (let c = 0; c < 3; c++) {
        for (let r = c + 1; r < 3; r++) {
            const f = M[r][c] / M[c][c];
            for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
        }
    }
    const x = [0, 0, 0];
    for (let r = 2; r >= 0; r--) {
        let s = M[r][3];
        for (let k = r + 1; k < 3; k++) s -= M[r][k] * x[k];
        x[r] = s / M[r][r];
    }
    if (!x.every(Number.isFinite)) throw new RangeError('The tail fit points are degenerate.');
    const [c0, c1, c2] = x;
    return (l) => c0 + (c1 + c2 * Math.log(l)) / l;
}

const qOf = (a, l) => (1 / a - 1) / l;

/**
 * Two-dimensional q-table (RECT, ANNULUS). rows: row coordinates (increasing); cols: relative lengths l;
 * alpha[i][j]: transmission probabilities; special: { rowIndex: (l) => alpha } for rows given by a function.
 * Returns (rowX, l) => alpha: per row PCHIP of q = (1/alpha - 1)/l in ln l, q held below cols[0], three-point tail
 * above the last column; then PCHIP across rows in rowX; alpha = 1/(1 + q l) clamped to (0, 1].
 */
export function makeQTable({ rows, cols, alpha, special = {} }) {
    checkNodes(rows, rows);
    checkNodes(cols, cols);
    if (alpha.length !== rows.length || alpha.some((r) => r.length !== cols.length)) {
        throw new RangeError('The q-table needs one alpha row per row coordinate and one entry per column.');
    }
    const nr = rows.length, nc = cols.length, lmin = cols[0], lmax = cols[nc - 1];
    const lnc = cols.map(Math.log);
    const rowF = [], tails = [], q0 = [];
    for (let i = 0; i < nr; i++) {
        const q = alpha[i].map((a, j) => qOf(a, cols[j]));
        rowF.push(makePchip(lnc, q));
        tails.push(fitTail3(cols.slice(-3), q.slice(-3)));
        q0.push(q[0]);
    }
    const R = Float64Array.from(rows), ys = new Float64Array(nr), ds = new Float64Array(nr);
    const rowQ = (i, l) => {
        if (special[i]) return qOf(special[i](l), l);
        if (l < lmin) return q0[i];
        if (l > lmax) return tails[i](l);
        return rowF[i](Math.log(l));
    };
    return (rowX, l) => {
        if (!(l > 0)) return 1;
        for (let i = 0; i < nr; i++) ys[i] = rowQ(i, l);
        slopesInto(R, ys, ds);
        const q = hermite(R, ys, ds, rowX);
        return Math.min(1, Math.max(1e-300, 1 / (1 + q * l)));
    };
}

/** rho = R_small/R_large of a diverging cone of half-angle betaDeg and l = L/R_small. */
export function coneRho(betaDeg, l) { return 1 / (1 + l * Math.tan(betaDeg * DEG)); }

/** Entrance-corrected long-duct estimate of a diverging cone (spec 3.2.6); equals Dushman for beta = 0. */
export function coneBase(betaDeg, l) {
    if (betaDeg >= 90) return 1;
    const r = coneRho(betaDeg, l), al = 16 / (3 * l * r * (1 + r));
    return al / (1 + al);
}

/**
 * Diverging-cone transmission (spec 3.2.6) from the CONE table. rows: half-angles in degrees (0 = tube row,
 * 90 = flat row), cols: l = L/R_small, alpha: table, tubeAlpha: (L/d) => alpha. Returns (betaDeg, l) => alpha,
 * referred to the small end: min(1, kappa(beta, l) base(beta, l)).
 */
export function makeKappaCone({ rows, cols, alpha, tubeAlpha }) {
    checkNodes(rows, rows);
    checkNodes(cols, cols);
    if (alpha.length !== rows.length || alpha.some((r) => r.length !== cols.length)) {
        throw new RangeError('The cone table needs one alpha row per angle and one entry per column.');
    }
    const nr = rows.length, nc = cols.length, lmin = cols[0], lmax = cols[nc - 1];
    const lnc = cols.map(Math.log);
    const kTube = (l) => tubeAlpha(l / 2) / coneBase(0, l);
    const rowF = rows.map((b, i) => (b === 0 || b === 90) ? null : makePchip(lnc, alpha[i].map((a, j) => a / coneBase(b, cols[j]))));
    const k01 = rows.map((b, i) => (b === 0 || b === 90) ? null : alpha[i][0] / coneBase(b, lmin));
    const R = Float64Array.from(rows), ks = new Float64Array(nr), ds = new Float64Array(nr);
    const rowK = (i, l) => {
        const b = rows[i];
        if (b === 0) return kTube(l);
        if (b === 90) return 1;
        if (l < lmin) return 1 + (k01[i] - 1) * l / lmin;
        return rowF[i](Math.log(l));
    };
    return (betaDeg, l) => {
        if (!(l > 0)) return 1;
        if (betaDeg <= 0) return tubeAlpha(l / 2);
        if (betaDeg >= 90) return 1;
        const lq = Math.min(l, lmax);
        for (let i = 0; i < nr; i++) ks[i] = rowK(i, lq);
        slopesInto(R, ks, ds);
        let k = hermite(R, ks, ds, betaDeg);
        if (l > lmax) k *= Math.pow(kTube(l) / kTube(lmax), coneRho(betaDeg, lmax));
        return Math.min(1, k * coneBase(betaDeg, l));
    };
}
