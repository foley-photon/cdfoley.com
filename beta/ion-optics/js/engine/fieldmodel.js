/* ==========================================================================
   Ion optics engine: fieldmodel.js
   Maps the 2D solved field (a FieldGrid in plane coordinates) to the 3D
   particle space, combines the superposition time channels, adds ideal fields
   and magnets, and answers geometry queries for the tracer.

   Mapping (spec §3.6.5): planar2d φ(x, y), E_z = 0, mirrored halves by
   evaluating at |x| or |y| and flipping that E component; cyl2d φ(x, ρ),
   ρ = √(y² + z²), E_y = E_ρ y/ρ, E_z = E_ρ z/ρ (0 for ρ < 1e-12 mm).
   Time dependence: E(t) = E0 + Σ_c f_c(t) E_c (Laplace superposition of the
   electrode basis fields), then ideal fields are added. Outside the domain the
   field is zero (field-free drift) and φ is NaN; magnets apply everywhere.
   ========================================================================== */
import { compileMagnets } from './magnet.js';
import { compileIdealFields } from './analytic-fields.js';
import { EDGE } from './layout.js';

const TWO32 = 4294967296;
const NEAR_NONE = 0, NEAR_GRID = 1, NEAR_RASTER = 2, NEAR_ALWAYS = 3;

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * @param {{ resolved: object, grid?: object|null, raster0?: object|null, geometry?: object|null,
 *   channelFns?: Array<object|null>|null, magnets?: object|Array|null, ideal?: object|Array|null }} spec
 */
export function createFieldModel({ resolved = null, grid = null, raster0 = null, geometry = null, channelFns = null, magnets = null, ideal = null } = {}) {
    const dom = (resolved && resolved.domain) || {};
    const type = dom.type || (grid && grid.cyl ? 'cyl2d' : 'planar2d');
    const cyl = type === 'cyl2d';
    const rg = raster0 && raster0.grid;
    const h = num(dom.h, num(dom.cell, grid ? grid.h : (rg ? rg.h : 1)));
    let X0, X1, Y0, Y1;
    if (Array.isArray(dom.x) && Array.isArray(dom.y)) {
        X0 = num(dom.x[0]); Y0 = num(dom.y[0]);
        X1 = typeof dom.nx === 'number' ? X0 + (dom.nx - 1) * h : num(dom.x[1]);
        Y1 = typeof dom.ny === 'number' ? Y0 + (dom.ny - 1) * h : num(dom.y[1]);
    } else if (grid) {
        X0 = grid.x0; Y0 = grid.y0; X1 = grid.x0 + (grid.nx - 1) * grid.h; Y1 = grid.y0 + (grid.ny - 1) * grid.h;
    } else if (rg) {
        X0 = rg.x0; Y0 = rg.y0; X1 = rg.x0 + (rg.nx - 1) * rg.h; Y1 = rg.y0 + (rg.ny - 1) * rg.h;
    } else { X0 = -Infinity; X1 = Infinity; Y0 = cyl ? 0 : -Infinity; Y1 = Infinity; }
    if (cyl) Y0 = Math.max(0, Y0);
    const mirror = dom.mirror || {};
    const mx = !!mirror.x, my = !cyl && !!mirror.y;
    const eps = 1e-9 * h;
    const XLO = X0 - eps, XHI = X1 + eps, YLO = Y0 - eps, YHI = Y1 + eps, RHI2 = YHI * YHI;

    // 3D box including mirrored halves
    const box = {
        xmin: mx ? -X1 : X0, xmax: X1,
        ymin: cyl ? -Y1 : (my ? -Y1 : Y0), ymax: Y1,
        zmin: cyl ? -Y1 : -Infinity, zmax: cyl ? Y1 : Infinity,
        rmax: cyl ? Y1 : Infinity,
    };
    box.min = [box.xmin, box.ymin, box.zmin]; box.max = [box.xmax, box.ymax, box.zmax];

    // magnets and ideal fields (compiled objects or raw lists)
    const mag = magnets && typeof magnets.add === 'function' ? magnets
        : compileMagnets(Array.isArray(magnets) ? magnets : ((resolved && resolved.magnets) || []), type);
    const idl = ideal && typeof ideal.E === 'function' ? ideal
        : compileIdealFields(Array.isArray(ideal) ? ideal : ((resolved && resolved.idealFields) || []));
    const hasB = !!mag.any;
    const magAddV = typeof mag.addV === 'function' ? mag.addV : (P, out3, sig) => mag.add(P[1], P[2], P[3], out3, sig);
    const idlEv = idl === null ? null : (typeof idl.Ev === 'function' ? idl.Ev : (P, out4, s) => { out4[3] += idl.E(P[0], P[1], P[2], P[3], out4, s); });
    const nBoxes = idl ? (idl.nBoxes | 0) : 0;
    const hasRegions = !!mag.hasRegions || nBoxes > 0;

    // channels: the count is read from the grid at evaluation time (a FieldGrid learns it in setChannels)
    const hasGrid = !!(grid && typeof grid.evalChannels === 'function');
    const nFn = Math.max(16, Array.isArray(channelFns) ? channelFns.length : 0, hasGrid ? grid.nChannels | 0 : 0);
    const fns = [];
    for (let c = 0; c < nFn; c++) fns.push(Array.isArray(channelFns) && channelFns[c] ? channelFns[c] : null);
    const fn0 = fns[0];
    const allDC = fns.every((f) => f === null);
    let buf = new Float64Array(3 * nFn);
    let timeDependent = !allDC || !!(idl && idl.timeDependent);
    let minPeriod = idl ? num(idl.minPeriod, Infinity) : Infinity;
    for (const f of fns) if (f) minPeriod = Math.min(minPeriod, num(f.minPeriod, Infinity));
    if (!(minPeriod > 0)) minPeriod = Infinity;

    // electrodes: transparency, transmission, potential span
    const elist = (resolved && resolved.electrodes) || [];
    const nE = Math.max(elist.length, geometry ? (geometry.nElectrodes | 0) : 0);
    const transparent = new Uint8Array(nE), transmission = new Float64Array(nE);
    let vMin = 0, vMax = 0;
    for (let k = 0; k < nE; k++) {
        const e = elist[k] || {};
        const tr = (geometry && geometry.transparent && geometry.transparent[k]) || e.transparent || e.kind === 'grid';
        transparent[k] = tr ? 1 : 0;
        transmission[k] = tr ? Math.min(1, Math.max(0, num(e.transmission, 1))) : 0;
        let v = num(e.dc, num(e.v)), sw = 0;
        const terms = Array.isArray(e.terms) ? e.terms : (e.wave && Array.isArray(e.wave.terms) ? e.wave.terms : []);
        for (const t of terms) {
            if (t && t.type === 'table') { for (const p of t.points || []) sw = Math.max(sw, Math.abs(num(p[1]))); } else if (t) sw += Math.abs(num(t.amp));
        }
        vMin = Math.min(vMin, v - sw); vMax = Math.max(vMax, v + sw);
    }

    // electrode band ("near") source
    const hasGeom = !!(geometry && typeof geometry.classify === 'function' && (!geometry.prims || geometry.prims.length > 0));
    let nearMode = NEAR_NONE;
    if (hasGeom) {
        if (grid && typeof grid.nearAt === 'function' && !(grid.analytic && !grid.nearKnown)) nearMode = NEAR_GRID;
        else if (raster0 && raster0.near && rg) nearMode = NEAR_RASTER;
        else nearMode = NEAR_ALWAYS;
    }
    const rnx = rg ? rg.nx : 0, rny = rg ? rg.ny : 0, rx0 = rg ? rg.x0 : 0, ry0 = rg ? rg.y0 : 0, rh = rg ? rg.h : 1;
    const rnear = raster0 && raster0.near;

    // ---- coordinate mapping helpers (results in mX, mY; flips in msx, msy)
    let mX = 0, mY = 0;
    function mapXY(x, y, z) {
        mX = mx && x < 0 ? -x : x;
        if (cyl) mY = Math.sqrt(y * y + z * z);
        else mY = my && y < 0 ? -y : y;
        return mX >= XLO && mX <= XHI && mY >= YLO && mY <= YHI;
    }

    /**
     * Vector-argument form of E (used by the tracer: doubles passed in a typed array are never boxed):
     * field at P = [t, x, y, z] into out4 = [Ex, Ey, Ez, φ]; returns 0 regular, 1 boundary, 2 solid, 3 outside.
     * sig ≥ 0 freezes the ideal-field boxes (high part of the region signature); left = true takes
     * waveform left limits (used for the stages that end exactly on a breakpoint).
     */
    function Ev(P, out4, sig, left) {
        const t = P[0], x = P[1], y = P[2], z = P[3];
        const X = mx && x < 0 ? -x : x;
        let Y, rho = 0;
        if (cyl) { rho = Math.sqrt(y * y + z * z); Y = rho; } else Y = my && y < 0 ? -y : y;
        if (!(X >= XLO && X <= XHI && Y >= YLO && Y <= YHI)) {
            out4[0] = 0; out4[1] = 0; out4[2] = 0; out4[3] = NaN;
            return 3;
        }
        let ex = 0, ey = 0, phi = 0, where = 0;
        if (hasGrid) {
            const nCh = grid.nChannels | 0;
            if (nCh > 0) {
                if (3 * nCh > buf.length) buf = new Float64Array(3 * nCh);
                where = grid.evalChannels(X, Y, buf);
                if (nCh === 1) {
                    const w = fn0 === null ? 1 : (left ? fn0.valueLeft(t) : fn0.value(t));
                    phi = w * buf[0]; ex = w * buf[1]; ey = w * buf[2];
                } else {
                    for (let c = 0, o = 0; c < nCh; c++, o += 3) {
                        const f = c < fns.length ? fns[c] : null;
                        const w = f === null ? 1 : (left ? f.valueLeft(t) : f.value(t));
                        if (w !== 0) { phi += w * buf[o]; ex += w * buf[o + 1]; ey += w * buf[o + 2]; }
                    }
                }
                if (mx && x < 0) ex = -ex;
            } else where = grid.cellTypeAt(X, Y);
        }
        out4[0] = ex;
        if (cyl) {
            if (rho >= 1e-12) { const s = ey / rho; out4[1] = s * y; out4[2] = s * z; } else { out4[1] = 0; out4[2] = 0; }
        } else {
            out4[1] = my && y < 0 ? -ey : ey; out4[2] = 0;
        }
        out4[3] = phi;
        if (idl !== null) idlEv(P, out4, sig >= 0 ? Math.floor(sig / TWO32) : -1);
        return where;
    }

    const PE = new Float64Array(4);
    /**
     * Field at (t, x, y, z): out4 = [Ex, Ey, Ez, φ]. Returns 0 regular, 1 boundary, 2 solid, 3 outside.
     * sig ≥ 0 freezes the ideal-field boxes; left = true takes waveform left limits.
     */
    function E(t, x, y, z, out4, sig = -1, left = false) { PE[0] = t; PE[1] = x; PE[2] = y; PE[3] = z; return Ev(PE, out4, sig, left); }

    /** Magnetic flux density (T) at P = [t, x, y, z] into out3 (overwritten). sig ≥ 0 freezes the field regions. */
    function Bv(P, out3, sig) {
        out3[0] = 0; out3[1] = 0; out3[2] = 0;
        if (hasB) magAddV(P, out3, sig >= 0 ? sig % TWO32 : -1);
        return out3;
    }
    const PB = new Float64Array(4);
    /** Magnetic flux density (T) at (x, y, z) into out3 (overwritten). sig ≥ 0 freezes the field regions. */
    function B(x, y, z, out3, sig = -1) { PB[1] = x; PB[2] = y; PB[3] = z; return Bv(PB, out3, sig); }

    const e4 = new Float64Array(4);
    function potential(t, x, y, z) { E(t, x, y, z, e4); return e4[3]; }

    /** inside() for P = [t, x, y, z]. */
    function insideV(P) { return inside(P[1], P[2], P[3]); }

    function inside(x, y, z) {
        if (x < box.xmin - eps || x > box.xmax + eps) return false;
        if (cyl) return y * y + z * z <= RHI2;
        return y >= box.ymin - eps && y <= box.ymax + eps;
    }

    /** EDGE code of the face a point outside the box has crossed (largest relative violation). */
    function faceOf(x, y, z) {
        let best = -1, code = -1;
        const span = Math.max(box.xmax - box.xmin, cyl ? 2 * Y1 : box.ymax - box.ymin, h);
        const test = (d, c) => { if (d > best) { best = d; code = c; } };
        test((box.xmin - x) / span, EDGE.XMIN); test((x - box.xmax) / span, EDGE.XMAX);
        if (cyl) test((Math.sqrt(y * y + z * z) - Y1) / span, EDGE.RMAX);
        else { test((box.ymin - y) / span, EDGE.YMIN); test((y - box.ymax) / span, EDGE.YMAX); }
        return code;
    }
    /** The domain edge whose `beyond` setting applies at an EDGE code (mirrors map to the far edge). */
    function beyondKey(code) {
        switch (code) {
            case EDGE.XMIN: return mx ? 'xmax' : 'xmin';
            case EDGE.XMAX: return 'xmax';
            case EDGE.YMIN: return my ? 'ymax' : 'ymin';
            case EDGE.YMAX: case EDGE.RMAX: return 'ymax';
            default: return 'xmax';
        }
    }

    function nearV(P) { return near(P[1], P[2], P[3]); }
    function near(x, y, z) {
        if (nearMode === NEAR_NONE) return false;
        if (!mapXY(x, y, z)) return false;
        if (nearMode === NEAR_ALWAYS) return true;
        if (nearMode === NEAR_GRID) return grid.nearAt(mX, mY) > 0;
        let i = Math.floor((mX - rx0) / rh), j = Math.floor((mY - ry0) / rh);
        if (i < 0) i = 0; else if (i > rnx - 2) i = rnx - 2;
        if (j < 0) j = 0; else if (j > rny - 2) j = rny - 2;
        return rnear[j * (rnx - 1) + i] > 0;
    }

    function ownerAt(x, y, z) {
        if (!hasGeom) return -1;
        if (!mapXY(x, y, z)) return -1;
        return geometry.classify(mX, mY);
    }

    function cellTypeAt(x, y, z) {
        if (!mapXY(x, y, z)) return 3;
        if (grid && typeof grid.cellTypeAt === 'function') return grid.cellTypeAt(mX, mY);
        return 0;
    }

    // first non-free point on the chord between two plane points; t in [0, 1] of that chord
    function chord(px, py, qx, qy, skip) {
        if (typeof geometry.firstNonFree === 'function') return geometry.firstNonFree(px, py, qx, qy, skip);
        return null;
    }

    // plane coordinates of the 3D chord point at parameter u (into mX, mY, without mirror folding)
    let cX = 0, cY = 0;
    function chordPoint(x0, y0, z0, x1, y1, z1, u) {
        cX = x0 + u * (x1 - x0);
        if (cyl) { const y = y0 + u * (y1 - y0), z = z0 + u * (z1 - z0); cY = Math.sqrt(y * y + z * z); } else cY = y0 + u * (y1 - y0);
    }
    const cuts = new Float64Array(4);

    /**
     * First electrode piece on the straight chord (x0, y0, z0) → (x1, y1, z1), mapped to plane coordinates
     * (cyl2d: (x, ρ) joined straight, split where the chord passes closest to the axis; mirrored halves split
     * at the mirror plane). u is the parameter along the 3D chord.
     * @returns {null | { u: number, electrode: number, transparent: boolean }}
     */
    function firstHit(x0, y0, z0, x1, y1, z1, skipTransparent = false) {
        if (!hasGeom) return null;
        let nc = 0;
        if (mx && (x0 < 0) !== (x1 < 0) && x0 !== x1) { const u = x0 / (x0 - x1); if (u > 0 && u < 1) cuts[nc++] = u; }
        if (my && (y0 < 0) !== (y1 < 0) && y0 !== y1) { const u = y0 / (y0 - y1); if (u > 0 && u < 1) cuts[nc++] = u; }
        if (cyl) {
            const dy = y1 - y0, dz = z1 - z0, d2 = dy * dy + dz * dz;
            if (d2 > 0) { const u = -(y0 * dy + z0 * dz) / d2; if (u > 1e-12 && u < 1 - 1e-12) cuts[nc++] = u; }
        }
        // sort the (≤ 3) cuts and close with 1
        for (let i = 1; i < nc; i++) { const v = cuts[i]; let j = i - 1; while (j >= 0 && cuts[j] > v) { cuts[j + 1] = cuts[j]; j--; } cuts[j + 1] = v; }
        cuts[nc++] = 1;
        let u0 = 0;
        chordPoint(x0, y0, z0, x1, y1, z1, 0);
        let pxa = cX, pya = cY;
        for (let k = 0; k < nc; k++) {
            const u1 = cuts[k];
            chordPoint(x0, y0, z0, x1, y1, z1, u1);
            const pxb = cX, pyb = cY;
            const r = chord(mx ? Math.abs(pxa) : pxa, my ? Math.abs(pya) : pya, mx ? Math.abs(pxb) : pxb, my ? Math.abs(pyb) : pyb, skipTransparent);
            if (r) {
                const e = r.electrode;
                return { u: u0 + r.t * (u1 - u0), electrode: e, transparent: !!(r.transparent || transparent[e]) };
            }
            u0 = u1; pxa = pxb; pya = pyb;
        }
        return null;
    }

    function regionSigV(P) { return regionSig(P[1], P[2], P[3]); }
    function regionSig(x, y, z) {
        let s = mag.hasRegions ? mag.regionSig(x, y, z) : 0;
        if (nBoxes > 0) s += TWO32 * idl.regionSig(x, y, z);
        return s;
    }

    function nextBreak(t0, t1) {
        let b = Infinity;
        for (const f of fns) if (f) { const v = f.nextBreak(t0, t1); if (v < b) b = v; }
        if (idl && typeof idl.nextBreak === 'function') { const v = idl.nextBreak(t0, t1); if (v < b) b = v; }
        return b;
    }

    return {
        type, cyl, h, timeDependent, hasB, hasRegions, bMax: hasB ? mag.bMax : 0, box,
        interp: grid ? grid.interp : 'none', get nChannels() { return hasGrid ? grid.nChannels | 0 : 0; }, mirror: { x: mx, y: my },
        transparent, transmission, vSpan: vMax - vMin, hasGeometry: hasGeom, nearMode,
        // an electric field can act (electrode voltages, or ideal fields): the automatic integrator choice keeps DP45 then
        hasE: !!idl || (hasGrid && (elist.length === 0 || vMax - vMin > 0)),
        warnings: mag.warnings || [],
        E, B, potential, inside, near, ownerAt, cellTypeAt, firstHit, regionSig, nextBreak, minPeriod,
        Ev, Bv, insideV, nearV, regionSigV,
        faceOf, beyondKey,
    };
}
