/* ==========================================================================
   Ion optics engine: analytic-fields.js
   Ideal (formula) electric fields added to the solved grid field, and
   formula-backed FieldGrid objects for tests.

   Ideal fields (φ in V, E = −∇φ in V/mm, t in µs, f in MHz, phase in deg):
     uniformE     φ = −E·(r − ref), optionally limited to a box (hard edge)
     quadrupole2d φ = (U − V cos(2π f t + phase))((x−cx)² − (y−cy)²)/r0²
     quadrupole3d φ = (U − V cos(…))((y−cy)² + (z−cz)² − 2(x−cx)²)/(r0² + 2 z0²)
                  (axis x; Paul, Rev. Mod. Phys. 62, 531 (1990))
     coax         φ = Va + (Vb − Va) ln(r/a)/ln(b/a) for a ≤ r ≤ b (axis along z)
     sphere       φ = A + B/r between R1 and R2 (concentric spheres)
   Outside their electrodes (r < a or r > b, r < R1 or r > R2) coax and sphere
   hold the electrode potential with E = 0. Formulas: Jackson, Classical
   Electrodynamics, 3rd ed., ch. 1-2.
   ========================================================================== */

const DEG = Math.PI / 180;

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
function vec(v, n, d = 0) { const out = []; for (let i = 0; i < n; i++) out.push(num(v && v[i], d)); return out; }

/**
 * Compiles the enabled ideal fields; null if there are none.
 * E(t, x, y, z, out3, boxSig = −1) ADDS E to out3 and returns the added potential;
 * with boxSig ≥ 0 the membership of the uniformE boxes is taken from its bits (frozen across a step).
 * @param {Array<object>} list
 */
export function compileIdealFields(list) {
    const items = (list || []).filter((f) => f && f.enabled !== false);
    if (!items.length) return null;
    const uni = [], q2 = [], q3 = [], coax = [], sph = [];
    let timeDependent = false, minPeriod = Infinity, nBoxes = 0;
    for (const f of items) {
        switch (f.type) {
            case 'uniformE': {
                const E = vec(f.E, 3), ref = vec(f.ref, 3);
                let box = null;
                if (f.box && f.box.min && f.box.max) {
                    const mn = vec(f.box.min, 3, -Infinity), mx = vec(f.box.max, 3, Infinity);
                    box = { min: mn.map((v, i) => Math.min(v, mx[i])), max: mx.map((v, i) => Math.max(v, mn[i])), bit: nBoxes++ };
                }
                uni.push({ ex: E[0], ey: E[1], ez: E[2], rx: ref[0], ry: ref[1], rz: ref[2], box });
                break;
            }
            case 'quadrupole2d': {
                const c = vec(f.center, 2), r0 = num(f.r0, 1), V = num(f.V), fr = num(f.freq);
                q2.push({ cx: c[0], cy: c[1], ir2: 1 / (r0 * r0), U: num(f.U), V, w: 2 * Math.PI * fr, ph: num(f.phase) * DEG });
                if (V !== 0 && fr !== 0) { timeDependent = true; minPeriod = Math.min(minPeriod, 1 / Math.abs(fr)); }
                break;
            }
            case 'quadrupole3d': {
                const c = vec(f.center, 3), r0 = num(f.r0, 1), z0 = num(f.z0), V = num(f.V), fr = num(f.freq);
                q3.push({ cx: c[0], cy: c[1], cz: c[2], id: 1 / (r0 * r0 + 2 * z0 * z0), U: num(f.U), V, w: 2 * Math.PI * fr, ph: num(f.phase) * DEG });
                if (V !== 0 && fr !== 0) { timeDependent = true; minPeriod = Math.min(minPeriod, 1 / Math.abs(fr)); }
                break;
            }
            case 'coax': {
                const c = vec(f.center, 2), a = num(f.a), b = num(f.b), Va = num(f.Va), Vb = num(f.Vb);
                coax.push({ cx: c[0], cy: c[1], a, b, Va, Vb, k: (Vb - Va) / Math.log(b / a) });
                break;
            }
            case 'sphere': {
                const c = vec(f.center, 3), R1 = num(f.R1), R2 = num(f.R2), V1 = num(f.V1), V2 = num(f.V2);
                const B = (V1 - V2) / (1 / R1 - 1 / R2);
                sph.push({ cx: c[0], cy: c[1], cz: c[2], R1, R2, V1, V2, A: V1 - B / R1, B });
                break;
            }
            default: break;
        }
    }
    // uniform fields without a box add a constant E and a linear φ = c0 − (ux x + uy y + uz z)
    let ux = 0, uy = 0, uz = 0, c0 = 0;
    const boxed = [];
    for (const u of uni) {
        if (u.box === null) { ux += u.ex; uy += u.ey; uz += u.ez; c0 += u.ex * u.rx + u.ey * u.ry + u.ez * u.rz; } else boxed.push(u);
    }
    const nB = boxed.length, nQ2 = q2.length, nQ3 = q3.length, nC = coax.length, nS = sph.length;
    const constOnly = nB === 0 && nQ2 === 0 && nQ3 === 0 && nC === 0 && nS === 0;

    const inBox = (b, x, y, z) => x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2];

    // vector-argument form (no boxed doubles on the call or the return): P = [t, x, y, z];
    // ADDS E to out4[0..2] and φ to out4[3]
    function Ev(P, out4, boxSig) {
        const t = P[0], x = P[1], y = P[2], z = P[3];
        out4[0] += ux; out4[1] += uy; out4[2] += uz;
        if (constOnly) { out4[3] += c0 - (ux * x + uy * y + uz * z); return; }
        const out3 = out4;
        let phi = c0 - (ux * x + uy * y + uz * z);
        for (let i = 0; i < nB; i++) {
            const u = boxed[i];
            const inside = boxSig >= 0 ? Math.floor(boxSig / 2 ** u.box.bit) % 2 === 1 : inBox(u.box, x, y, z);
            if (!inside) continue;
            out3[0] += u.ex; out3[1] += u.ey; out3[2] += u.ez;
            phi -= u.ex * (x - u.rx) + u.ey * (y - u.ry) + u.ez * (z - u.rz);
        }
        for (let i = 0; i < nQ2; i++) {
            const q = q2[i], s = (q.U - q.V * Math.cos(q.w * t + q.ph)) * q.ir2, dx = x - q.cx, dy = y - q.cy;
            phi += s * (dx * dx - dy * dy);
            out3[0] -= 2 * s * dx; out3[1] += 2 * s * dy;
        }
        for (let i = 0; i < nQ3; i++) {
            const q = q3[i], s = (q.U - q.V * Math.cos(q.w * t + q.ph)) * q.id, dx = x - q.cx, dy = y - q.cy, dz = z - q.cz;
            phi += s * (dy * dy + dz * dz - 2 * dx * dx);
            out3[0] += 4 * s * dx; out3[1] -= 2 * s * dy; out3[2] -= 2 * s * dz;
        }
        for (let i = 0; i < nC; i++) {
            const c = coax[i], dx = x - c.cx, dy = y - c.cy, r = Math.sqrt(dx * dx + dy * dy);
            if (r <= c.a) { phi += c.Va; continue; }
            if (r >= c.b) { phi += c.Vb; continue; }
            phi += c.Va + c.k * Math.log(r / c.a);
            const er = -c.k / r;   // E_r = −dφ/dr
            out3[0] += er * dx / r; out3[1] += er * dy / r;
        }
        for (let i = 0; i < nS; i++) {
            const s = sph[i], dx = x - s.cx, dy = y - s.cy, dz = z - s.cz, r = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (r <= s.R1) { phi += s.V1; continue; }
            if (r >= s.R2) { phi += s.V2; continue; }
            phi += s.A + s.B / r;
            const er = s.B / (r * r * r);   // E = B r̂ / r²
            out3[0] += er * dx; out3[1] += er * dy; out3[2] += er * dz;
        }
        out4[3] += phi;
    }

    const PV = new Float64Array(4), S4 = new Float64Array(4);
    /** Adds E at (t, x, y, z) to out3 and returns the added potential (spec §2.3). */
    function E(t, x, y, z, out3, boxSig = -1) {
        PV[0] = t; PV[1] = x; PV[2] = y; PV[3] = z;
        S4[0] = out3[0]; S4[1] = out3[1]; S4[2] = out3[2]; S4[3] = 0;
        Ev(PV, S4, boxSig);
        out3[0] = S4[0]; out3[1] = S4[1]; out3[2] = S4[2];
        return S4[3];
    }

    const boxSig = (x, y, z) => {
        if (nBoxes === 0) return 0;
        let s = 0;
        for (let i = 0; i < nB; i++) { const b = boxed[i].box; if (inBox(b, x, y, z)) s += 2 ** b.bit; }
        return s;
    };

    return { timeDependent, minPeriod, nBoxes, E, Ev, regionSig: boxSig, nextBreak: () => Infinity };
}

function normBounds(bounds) {
    if (Array.isArray(bounds)) return { x0: +bounds[0], x1: +bounds[1], y0: +bounds[2], y1: +bounds[3] };
    const b = bounds || {};
    if (Array.isArray(b.x) && Array.isArray(b.y)) return { x0: +b.x[0], x1: +b.x[1], y0: +b.y[0], y1: +b.y[1] };
    return { x0: +b.x0, x1: +b.x1, y0: +b.y0, y1: +b.y1 };
}

/**
 * Formula-backed FieldGrid with one channel (tests of WP2/WP5 without a solve).
 * phi(x, y) → V; grad(x, y, out2) → fills out2 = [∂φ/∂x, ∂φ/∂y] (or returns such an array); when grad is
 * omitted it is taken by central differences. In cyl mode (x, y) = (x, ρ) and Ey is E_ρ.
 * Optional near(x, y) → bool and cellType(x, y) → 0..3 describe the electrode band; without `near`
 * the grid reports no band (nearKnown = false) and the FieldModel tests hits on every step if a
 * geometry is present.
 * @param {{ phi: (x: number, y: number) => number, grad?: (x: number, y: number, out2: Float64Array) => (number[]|Float64Array|void), bounds: object|number[], h: number, cyl?: boolean, near?: (x: number, y: number) => boolean, cellType?: (x: number, y: number) => number }} spec
 */
export function analyticGrid({ phi, grad = null, bounds, h, cyl = false, near = null, cellType = null }) {
    const b = normBounds(bounds);
    const nx = Math.round((b.x1 - b.x0) / h) + 1, ny = Math.round((b.y1 - b.y0) / h) + 1;
    const g2 = new Float64Array(2);
    const fd = 1e-4 * h;
    const gradAt = (x, y) => {
        if (grad) {
            const r = grad(x, y, g2);
            if (r && r !== g2) { g2[0] = r[0]; g2[1] = r[1]; }
        } else {
            g2[0] = (phi(x + fd, y) - phi(x - fd, y)) / (2 * fd);
            g2[1] = (phi(x, y + fd) - phi(x, y - fd)) / (2 * fd);
        }
        return g2;
    };
    const eps = 1e-9 * h;
    const inside = (x, y) => x >= b.x0 - eps && x <= b.x1 + eps && y >= b.y0 - eps && y <= b.y1 + eps;
    return {
        interp: 'analytic', analytic: true, nearKnown: typeof near === 'function', cyl: !!cyl,
        nx, ny, h, x0: b.x0, y0: b.y0, bounds: { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 }, nChannels: 1,
        setChannels() {},
        evalChannels(x, y, out) {
            if (!inside(x, y)) { out[0] = NaN; out[1] = 0; out[2] = 0; return 3; }
            out[0] = phi(x, y);
            const g = gradAt(x, y);
            out[1] = -g[0]; out[2] = -g[1];
            return cellType ? cellType(x, y) : 0;
        },
        cellTypeAt(x, y) { return !inside(x, y) ? 3 : (cellType ? cellType(x, y) : 0); },
        nearAt(x, y) { return near && inside(x, y) && near(x, y) ? 1 : 0; },
        nodal(c) {
            const i = c % nx, j = (c - i) / nx, x = b.x0 + i * h, y = b.y0 + j * h;
            const p = phi(x, y), g = gradAt(x, y), px = g[0], py = g[1];
            const gp = gradAt(x + fd, y)[1], gm = gradAt(x - fd, y)[1];
            return { phi: p, px, py, pxy: (gp - gm) / (2 * fd) };
        },
        bytes() { return 0; },
    };
}
