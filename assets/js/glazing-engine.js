/* ==========================================================================
   cdfoley.com — glazing-engine.js
   Center-of-glass optical and thermal performance of glazing systems.

   Optics: each pane is described by spectral T, Rf, Rb on the 5 nm grid of
   glazing-weights.js. Generic panes are built from a soda-lime glass model
   (refractive index + iron absorption) and parametric low-e coatings; imported
   panes use measured spectra. Panes are combined with the incoherent
   multiple-reflection (net radiation) method, which also gives the solar
   absorptance of each pane.

   Thermal: one-dimensional ISO 15099 center-of-glass model. Gap convection
   uses the ISO 15099 vertical-cavity Nusselt correlations, radiation uses the
   surface emissivities, and a vacuum gap conducts only through its support
   pillars (Collins & Simko). U-factor at NFRC 100 winter conditions; SHGC at
   NFRC 200 summer conditions.
   ========================================================================== */
(function (root) {
    'use strict';
    var Wt = root.GlazingWeights;
    var N = Wt.grid.n, L0 = Wt.grid.start, DL = Wt.grid.step;
    var LAM = []; for (var i = 0; i < N; i++) LAM.push(L0 + i * DL);   // nm
    var SIG = 5.670374419e-8, RG = 8.314462618, G = 9.80665;

    /* ── Glass substrates ─────────────────────────────────────────────── */
    // Absorption coefficient (1/mm): constant base + Fe²⁺ band near 1.05 µm (Gaussian in photon
    // energy) + ultraviolet absorption edge (Fe³⁺ charge transfer and the silicate network).
    var GLASS = {
        clear:   { label: 'Clear float',            base: 0.0040, fe2: 0.0460, uv: 0.0340 },
        lowiron: { label: 'Low-iron (extra-clear)', base: 0.0006, fe2: 0.0045, uv: 0.0110 }
    };
    function nGlass(nm) { var um = nm / 1000; return 1.5085 + 0.0042 / (um * um); }
    function alpha(g, nm) {
        var E = 1239.84 / nm;
        return g.base + g.fe2 * Math.exp(-0.5 * Math.pow((E - 1.13) / 0.38, 2)) + g.uv * Math.exp((E - 3.55) / 0.20);
    }

    /* ── Generic low-e coatings ───────────────────────────────────────── */
    // Film-only reflectance rises from Rv (visible) to Rir (near-infrared) around λc with width w, with a
    // small blue reflection band from the dielectric layers; absorptance rises from Av to Air and the
    // stack absorbs ultraviolet (uv). eps is the hemispherical emissivity of the coated surface.
    var COATINGS = {
        hard:   { label: 'Pyrolytic hard-coat low-e', Rv: 0.060, blue: 0.02, Rir: 0.62, lc: 2050, w: 330, Av: 0.035, Air: 0.10, uv: 0.40, eps: 0.15 },
        single: { label: 'Single-silver low-e',       Rv: 0.030, blue: 0.02, Rir: 0.80, lc: 1150, w: 210, Av: 0.050, Air: 0.10, uv: 0.60, eps: 0.040 },
        double: { label: 'Double-silver low-e',       Rv: 0.022, blue: 0.06, Rir: 0.92, lc: 745,  w: 22,  Av: 0.080, Air: 0.06, uv: 0.85, eps: 0.025 },
        triple: { label: 'Triple-silver low-e',       Rv: 0.030, blue: 0.07, Rir: 0.95, lc: 710,  w: 18,  Av: 0.120, Air: 0.05, uv: 0.90, eps: 0.015 }
    };
    var EPS_GLASS = 0.84, K_GLASS = 1.0;

    function arr() { return new Float64Array(N); }

    // Bare or coated generic pane. side: 'front' (faces outdoors) or 'back'
    function pane(glassKey, tmm, coatKey, side) {
        var g = GLASS[glassKey], c = coatKey && coatKey !== 'none' ? COATINGS[coatKey] : null;
        var T = arr(), Rf = arr(), Rb = arr();
        for (var i = 0; i < N; i++) {
            var n = nGlass(LAM[i]), R0 = Math.pow((n - 1) / (n + 1), 2);
            var tau = Math.exp(-alpha(g, LAM[i]) * tmm), t2 = tau * tau;
            if (!c) {
                var den = 1 - R0 * R0 * t2;
                T[i] = (1 - R0) * (1 - R0) * tau / den;
                Rf[i] = Rb[i] = R0 + (1 - R0) * (1 - R0) * R0 * t2 / den;
                continue;
            }
            var S = 1 / (1 + Math.exp(-(LAM[i] - c.lc) / c.w));
            var Rc = c.Rv + c.blue * Math.exp(-Math.pow((LAM[i] - 445) / 45, 2)) + (c.Rir - c.Rv) * S;
            var Ac = c.Av + (c.Air - c.Av) * S + c.uv * Math.exp(-(LAM[i] - 300) / 45), Tc = Math.max(0, 1 - Rc - Ac);
            var dc = 1 - Rc * R0 * t2;
            var Tt = Tc * (1 - R0) * tau / dc;
            var Rcoat = Rc + Tc * Tc * R0 * t2 / dc;
            var Rglass = R0 + (1 - R0) * (1 - R0) * Rc * t2 / dc;
            T[i] = Tt;
            if (side === 'back') { Rf[i] = Rglass; Rb[i] = Rcoat; } else { Rf[i] = Rcoat; Rb[i] = Rglass; }
        }
        var ef = c && side !== 'back' ? c.eps : EPS_GLASS, eb = c && side === 'back' ? c.eps : EPS_GLASS;
        return { T: T, Rf: Rf, Rb: Rb, ef: ef, eb: eb, t: tmm / 1000, k: K_GLASS };
    }

    // Measured product: wavelengths (nm), T, Rf, Rb sampled on the product's own grid
    function imported(p, flipped) {
        var T = arr(), Rf = arr(), Rb = arr(), x = p.wl;
        function at(ys, nm) {
            if (nm <= x[0]) return ys[0];
            if (nm >= x[x.length - 1]) return ys[ys.length - 1];
            var lo = 0, hi = x.length - 1;
            while (hi - lo > 1) { var m = (lo + hi) >> 1; if (x[m] <= nm) lo = m; else hi = m; }
            var f = (nm - x[lo]) / (x[hi] - x[lo]);
            return ys[lo] + f * (ys[hi] - ys[lo]);
        }
        for (var i = 0; i < N; i++) {
            T[i] = at(p.T, LAM[i]);
            var a = at(p.Rf, LAM[i]), b = at(p.Rb, LAM[i]);
            Rf[i] = flipped ? b : a; Rb[i] = flipped ? a : b;
        }
        return { T: T, Rf: Rf, Rb: Rb, ef: flipped ? p.eb : p.ef, eb: flipped ? p.ef : p.eb, t: p.thickness / 1000, k: p.k || K_GLASS };
    }

    /* ── Multilayer optics (net radiation method) ─────────────────────── */
    // Returns system T, R (from outside), and absorptance of each pane for light incident from outside.
    function solveFlux(Ts, Rfs, Rbs) {
        var n = Ts.length, up = new Array(n + 1), dn = new Array(n + 1);   // dn[j]: inward flux after layer j−1; up[j]: outward flux in gap j
        for (var j = 0; j <= n; j++) { up[j] = 0; dn[j] = 0; }
        dn[0] = 1;
        for (var it = 0; it < 200; it++) {
            var change = 0;
            for (var k = 0; k < n; k++) {
                var nd = Ts[k] * dn[k] + Rbs[k] * up[k + 1];
                var nu = Rfs[k] * dn[k] + Ts[k] * up[k + 1];
                change += Math.abs(nd - dn[k + 1]) + Math.abs(nu - up[k]);
                dn[k + 1] = nd; up[k] = nu;
            }
            if (change < 1e-12) break;
        }
        var A = [];
        for (var m = 0; m < n; m++) A.push(dn[m] + up[m + 1] - dn[m + 1] - up[m]);
        return { T: dn[n], R: up[0], A: A };
    }
    function system(layers) {
        var n = layers.length, T = arr(), Rf = arr(), Rb = arr(), A = layers.map(arr);
        for (var i = 0; i < N; i++) {
            var f = solveFlux(layers.map(function (l) { return l.T[i]; }), layers.map(function (l) { return l.Rf[i]; }), layers.map(function (l) { return l.Rb[i]; }));
            var b = solveFlux(layers.slice().reverse().map(function (l) { return l.T[i]; }), layers.slice().reverse().map(function (l) { return l.Rb[i]; }), layers.slice().reverse().map(function (l) { return l.Rf[i]; }));
            T[i] = f.T; Rf[i] = f.R; Rb[i] = b.R;
            for (var k = 0; k < n; k++) A[k][i] = f.A[k];
        }
        return { T: T, Rf: Rf, Rb: Rb, A: A };
    }

    function avg(s, w) { var t = 0; for (var i = 0; i < N; i++) t += s[i] * w[i]; return t; }
    function rangeAvg(s, w, lo, hi) {
        var t = 0, ws = 0;
        for (var i = 0; i < N; i++) if (LAM[i] >= lo && LAM[i] <= hi) { t += s[i] * w[i]; ws += w[i]; }
        return ws ? t / ws : 0;
    }

    // CIELAB (D65, 2°) and an sRGB swatch for a spectral transmittance or reflectance
    function color(s) {
        var X = avg(s, Wt.X), Y = avg(s, Wt.Y), Z = avg(s, Wt.Z);
        var Xn = 0, Zn = 0; for (var i = 0; i < N; i++) { Xn += Wt.X[i]; Zn += Wt.Z[i]; }
        function f(t) { return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116; }
        var fx = f(X / Xn), fy = f(Y), fz = f(Z / Zn);
        var lin = [3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z];
        var rgb = lin.map(function (c) { c = Math.max(0, Math.min(1, c)); return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); });
        return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz), rgb: rgb };
    }

    /* ── Gases (ISO 15099 Annex B: property = a + b·T) ─────────────────── */
    var GAS = {
        air:     { M: 28.97,  k: [2.873e-3, 7.760e-5], mu: [3.723e-6, 4.940e-8], cp: [1002.737, 1.2324e-2] },
        argon:   { M: 39.948, k: [2.285e-3, 5.149e-5], mu: [3.379e-6, 6.451e-8], cp: [521.9285, 0] },
        krypton: { M: 83.80,  k: [9.443e-4, 2.826e-5], mu: [2.213e-6, 7.777e-8], cp: [248.0907, 0] },
        xenon:   { M: 131.30, k: [4.538e-4, 1.723e-5], mu: [1.069e-6, 7.414e-8], cp: [158.3397, 0] }
    };
    var FILLS = {
        air:       { label: 'Air',                 mix: [['air', 1]] },
        argon:     { label: 'Argon (90 %, air)',   mix: [['argon', 0.9], ['air', 0.1]] },
        krypton:   { label: 'Krypton (90 %, air)', mix: [['krypton', 0.9], ['air', 0.1]] },
        xenon:     { label: 'Xenon (90 %, air)',   mix: [['xenon', 0.9], ['air', 0.1]] },
        vacuum:    { label: 'Vacuum (VIG)',        vacuum: true }
    };
    // Mole-fraction mixing (adequate for the 90/10 fills used here)
    function gasProps(fill, T, p) {
        var k = 0, mu = 0, M = 0, cpm = 0;
        FILLS[fill].mix.forEach(function (m) {
            var g = GAS[m[0]], x = m[1];
            k += x * (g.k[0] + g.k[1] * T); mu += x * (g.mu[0] + g.mu[1] * T);
            M += x * g.M; cpm += x * g.M * (g.cp[0] + g.cp[1] * T);
        });
        var cp = cpm / M, rho = p * M / 1000 / (RG * T);
        return { k: k, mu: mu, cp: cp, rho: rho };
    }
    // ISO 15099 vertical cavity Nusselt number
    function nusseltGap(Ra, A) {
        var nu1 = Ra > 5e4 ? 0.0673838 * Math.pow(Ra, 1 / 3) : Ra > 1e4 ? 0.028154 * Math.pow(Ra, 0.4134) : 1 + 1.7596678e-10 * Math.pow(Ra, 2.2984755);
        var nu2 = 0.242 * Math.pow(Ra / A, 0.272);
        return Math.max(nu1, nu2);
    }
    // Free convection on the indoor surface, ISO 15099 laminar form for a vertical window of height H: Nu = 0.56 Ra^¼
    function hcIndoor(Ts, Ti, H) {
        var Tf = (Ts + Ti) / 2, a = gasProps('air', Tf, 101325);
        var dT = Math.abs(Ts - Ti); if (dT < 1e-3) dT = 1e-3;
        var nu = a.mu / a.rho, al = a.k / (a.rho * a.cp), Pr = nu / al;
        var Ra = G * dT * H * H * H / (Tf * nu * al);
        var Nu = 0.56 * Math.pow(Ra, 0.25);
        return Nu * a.k / H;
    }

    var CONDITIONS = {
        winter: { label: 'NFRC 100 winter', To: 255.15, Ti: 294.15, hco: 4 + 4 * 5.5, I: 0 },
        summer: { label: 'NFRC 200 summer', To: 305.15, Ti: 297.15, hco: 4 + 4 * 2.75, I: 783 }
    };

    // layers: [{ef, eb, t, k}], gaps: [{fill, width (m), pillarSpacing (m), pillarRadius (m)}], S: absorbed solar per layer (W/m²)
    function thermal(layers, gaps, cond, S, H) {
        H = H || 1.0;
        var n = layers.length, m = 2 * n, T = new Float64Array(m);
        for (var j = 0; j < m; j++) T[j] = cond.To + (cond.Ti - cond.To) * (j + 0.5) / m;
        var hin = 0, gapH = [];
        for (var it = 0; it < 100; it++) {
            var a = new Float64Array(m), b = new Float64Array(m), c = new Float64Array(m), d = new Float64Array(m);
            // outdoor surface
            var Tf0 = T[0], hro = layers[0].ef * SIG * (Tf0 * Tf0 + cond.To * cond.To) * (Tf0 + cond.To);
            var ho = cond.hco + hro;
            gapH = [];
            for (var k = 0; k < n; k++) {
                var cond_k = layers[k].k / layers[k].t, f = 2 * k, bk = 2 * k + 1, s2 = (S ? S[k] : 0) / 2;
                // front node of pane k
                if (k === 0) { b[f] = -(ho + cond_k); c[f] = cond_k; d[f] = -(ho * cond.To + s2); }
                else {
                    var hg = gapH[k - 1];
                    a[f] = hg; b[f] = -(hg + cond_k); c[f] = cond_k; d[f] = -s2;
                }
                // back node of pane k
                if (k === n - 1) {
                    var Tb = T[bk], hri = layers[k].eb * SIG * (Tb * Tb + cond.Ti * cond.Ti) * (Tb + cond.Ti);
                    hin = hcIndoor(Tb, cond.Ti, H) + hri;
                    a[bk] = cond_k; b[bk] = -(cond_k + hin); d[bk] = -(hin * cond.Ti + s2);
                } else {
                    var g = gaps[k], T1 = T[bk], T2 = T[bk + 2], Tm = (T1 + T2) / 2;
                    var hr = SIG * (T1 * T1 + T2 * T2) * (T1 + T2) / (1 / layers[k].eb + 1 / layers[k + 1].ef - 1);
                    var hcv = 0;
                    if (FILLS[g.fill].vacuum) {
                        hcv = 2 * K_GLASS * g.pillarRadius / (g.pillarSpacing * g.pillarSpacing);   // pillar conduction
                    } else {
                        var gp = gasProps(g.fill, Tm, 101325), dT = Math.max(Math.abs(T1 - T2), 1e-3);
                        var Ra = gp.rho * gp.rho * Math.pow(g.width, 3) * G * gp.cp * dT / (gp.mu * gp.k * Tm);
                        hcv = nusseltGap(Ra, H / g.width) * gp.k / g.width;
                    }
                    var hgap = hr + hcv; gapH.push(hgap);
                    a[bk] = cond_k; b[bk] = -(cond_k + hgap); c[bk] = hgap; d[bk] = -s2;
                }
            }
            // Thomas algorithm
            var cp_ = new Float64Array(m), dp = new Float64Array(m), X = new Float64Array(m);
            cp_[0] = c[0] / b[0]; dp[0] = d[0] / b[0];
            for (var r = 1; r < m; r++) { var den = b[r] - a[r] * cp_[r - 1]; cp_[r] = c[r] / den; dp[r] = (d[r] - a[r] * dp[r - 1]) / den; }
            X[m - 1] = dp[m - 1];
            for (var q = m - 2; q >= 0; q--) X[q] = dp[q] - cp_[q] * X[q + 1];
            var delta = 0; for (var z = 0; z < m; z++) { delta = Math.max(delta, Math.abs(X[z] - T[z])); T[z] = 0.5 * T[z] + 0.5 * X[z]; }
            if (delta < 1e-7 && it > 3) break;
        }
        var qRoom = hin * (T[m - 1] - cond.Ti);   // heat flow into the room, W/m²
        return { temps: Array.prototype.slice.call(T), qRoom: qRoom, hin: hin, gapH: gapH };
    }

    // Full evaluation of a glazing system
    function evaluate(layers, gaps, H) {
        var sys = system(layers);
        var Tsol = avg(sys.T, Wt.solar), Rsol = avg(sys.Rf, Wt.solar), RsolIn = avg(sys.Rb, Wt.solar);
        var Asol = sys.A.map(function (a) { return avg(a, Wt.solar); });
        var w = thermal(layers, gaps, CONDITIONS.winter, null, H);
        var U = -w.qRoom / (CONDITIONS.winter.Ti - CONDITIONS.winter.To);
        var sc = CONDITIONS.summer;
        var dark = thermal(layers, gaps, sc, null, H);
        var sunny = thermal(layers, gaps, sc, Asol.map(function (x) { return x * sc.I; }), H);
        var shgc = Tsol + (sunny.qRoom - dark.qRoom) / sc.I;
        return {
            sys: sys, Tvis: avg(sys.T, Wt.vis), Rvis: avg(sys.Rf, Wt.vis), RvisIn: avg(sys.Rb, Wt.vis),
            Tsol: Tsol, Rsol: Rsol, RsolIn: RsolIn, Asol: Asol,
            Tuv: rangeAvg(sys.T, Wt.solar, 300, 380),
            U: U, SHGC: shgc, winter: w, summer: sunny,
            colorT: color(sys.T), colorR: color(sys.Rf), colorRin: color(sys.Rb)
        };
    }

    var api = { LAM: LAM, GLASS: GLASS, COATINGS: COATINGS, FILLS: FILLS, CONDITIONS: CONDITIONS, EPS_GLASS: EPS_GLASS,
        pane: pane, imported: imported, system: system, avg: avg, color: color, thermal: thermal, evaluate: evaluate };
    root.GlazingEngine = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
