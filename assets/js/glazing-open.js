/* ==========================================================================
   cdfoley.com — glazing-open.js
   The "open data" material model for glazing-engine.js, built only from openly licensed data.

   Glass: measured optical constants n, k of soda-lime glass (M. Rubin, Optical properties of soda lime
   silica glasses, Sol. Energy Mater. 12, 275-288 (1985), via the refractiveindex.info database, CC0).
   Interface reflectance R0 = |N − 1|²/|N + 1|², internal transmittance τ = exp(−4πkd/λ).

   Coatings: thin-film stacks of CC0 optical constants (glazing-materials.js) evaluated at normal incidence
   with the characteristic matrix (glazing-tmm.js). The layer thicknesses and the coated-face emissivity
   come from glazing-coatings.js, fitted offline only to published manufacturer datasheet values. The stacks
   are effective models, not any manufacturer's actual design.

   Registers itself as GlazingEngine model 'open': GlazingEngine.pane(glass, mm, coating, side, 'open').
   Load order: glazing-weights.js, glazing-engine.js, glazing-materials.js, glazing-tmm.js,
   glazing-coatings.js, then this file. Classic script (UMD): window.GlazingOpen, or module.exports.
   ========================================================================== */
(function (root) {
    'use strict';
    var E = root.GlazingEngine, M = root.GlazingMaterials, TMM = root.GlazingTMM, C = root.GlazingCoatings;
    if (!E || !M || !TMM || typeof E.registerModel !== 'function' || !M.materials) {
        throw new Error('glazing-open.js: load glazing-engine.js, glazing-materials.js and glazing-tmm.js first');
    }
    var LAM = E.LAM, N = LAM.length;
    if (!M.grid || M.grid.n !== N || M.grid.start !== LAM[0] || M.grid.step !== LAM[1] - LAM[0]) {
        throw new Error('glazing-open.js: the material grid does not match the engine grid');
    }
    var EPS_GLASS = E.EPS_GLASS, K_GLASS = 1.0;

    var GLASS = {
        clear:   { label: 'Clear float (Rubin 1985)', mat: 'glass_clear' },
        lowiron: { label: 'Low-iron (Rubin 1985)',    mat: 'glass_lowiron' },
        green:   { label: 'Green tint (Rubin 1985)',  mat: 'glass_green' },
        grey:    { label: 'Gray tint (Rubin 1985)',   mat: 'glass_grey' },
        bronze:  { label: 'Bronze tint (Rubin 1985)', mat: 'glass_bronze' }
    };
    var COATINGS = (C && C.coatings) || {};

    function has(o, key) { return Object.prototype.hasOwnProperty.call(o, key); }

    function material(id) {
        if (!has(M.materials, id)) throw new Error('glazing-open.js: unknown material ' + id);
        return M.materials[id];
    }

    // Substrate optics, computed once per glass type: real index n, bare interface reflectance R0 and
    // absorption coefficient alpha (1/mm) = 4πk·1e6/λ[nm].
    var glassCache = {};
    function glass(key) {
        if (has(glassCache, key)) return glassCache[key];
        if (!has(GLASS, key)) throw new Error('glazing-open.js: unknown glass ' + key);
        var m = material(GLASS[key].mat), ng = new Float64Array(N), R0 = new Float64Array(N), a = new Float64Array(N);
        for (var i = 0; i < N; i++) {
            var n = m.n[i], k = m.k ? m.k[i] : 0;
            ng[i] = n;
            R0[i] = ((n - 1) * (n - 1) + k * k) / ((n + 1) * (n + 1) + k * k);
            a[i] = 4 * Math.PI * k * 1e6 / LAM[i];
        }
        return (glassCache[key] = { n: ng, R0: R0, alpha: a });
    }
    // Internal transmittance of mm of glass (recomputed per call; cheap).
    function tau(key, mm) {
        var g = glass(key), t = new Float64Array(N);
        for (var i = 0; i < N; i++) t[i] = Math.exp(-g.alpha[i] * mm);
        return t;
    }

    // Film spectra { Tc, Rc, Rg } of a stack on the given glass. layers: [{ m: material id, d: nm }] (or
    // [{ n: [], k: [] | 0, d }] for explicit constants), listed from the glass outward.
    function film(layers, glassKey) {
        var g = glass(glassKey);
        var L = layers.map(function (x) {
            var src = x.n ? x : material(x.m);
            return { n: src.n, k: src.k, d: x.d };
        });
        return TMM.filmSpectra(L, LAM, g.n);
    }

    // A pane with an explicit stack (calibration and custom stacks). eps: emissivity of the coated face.
    // side 'front': the coating faces outdoors; 'back': indoors. With a cacheKey the film spectra are kept
    // per cacheKey|glassKey (the caller promises that the key always names the same stack).
    var filmCache = {};
    function stackPane(glassKey, mm, layers, eps, side, cacheKey) {
        var g = glass(glassKey), f = null;
        if (layers && layers.length) {
            var key = cacheKey ? cacheKey + '|' + glassKey : null;
            if (key && has(filmCache, key)) f = filmCache[key];
            else {
                f = film(layers, glassKey);
                if (key) filmCache[key] = f;
            }
        }
        var r = TMM.combine(f, g.R0, tau(glassKey, mm), side);
        var ef = f && side !== 'back' ? eps : EPS_GLASS, eb = f && side === 'back' ? eps : EPS_GLASS;
        return { T: r.T, Rf: r.Rf, Rb: r.Rb, ef: ef, eb: eb, t: mm / 1000, k: K_GLASS };
    }

    // The engine's material-model entry point: a generic pane with a calibrated coating (or none).
    function pane(glassKey, mm, coatKey, side) {
        if (!has(GLASS, glassKey)) throw new Error('glazing-open.js: unknown glass ' + glassKey);
        var c = null;
        if (coatKey && coatKey !== 'none') {
            if (!has(COATINGS, coatKey)) throw new Error('glazing-open.js: unknown coating ' + coatKey);
            c = COATINGS[coatKey];
        }
        return stackPane(glassKey, mm, c ? c.layers : null, c ? c.eps : EPS_GLASS, side, c ? 'coat:' + coatKey : null);
    }

    // Approximate hemispherical emissivity of a silver stack from its total silver thickness (nm), for custom
    // stacks. Sheet resistance Rs = rho_eff / t with rho_eff = 7.2e-8 ohm·m, the mean effective resistivity
    // implied by the calibrated silver stacks; normal emissivity of a thin conducting film
    // en = 4y/(2 + y)², y = Z0/Rs; hemispherical from the EN 12898 ratio table. About ±30 %.
    var RHO_EFF = 7.2e-8, Z0 = 376.730313;
    var EN12898 = [[0.03, 1.22], [0.05, 1.18], [0.1, 1.14], [0.2, 1.10], [0.3, 1.06], [0.4, 1.03], [0.5, 1.00],
        [0.6, 0.98], [0.7, 0.96], [0.8, 0.95], [0.89, 0.94]];
    function hemispherical(en) {
        var P = root.GlazingProducts;
        if (P && typeof P.hemispherical === 'function') return P.hemispherical(en);
        var t = EN12898;                                  // the same table, if glazing-products.js is absent
        if (en <= t[0][0]) return en * t[0][1];
        if (en >= t[t.length - 1][0]) return en * t[t.length - 1][1];
        for (var i = 1; i < t.length; i++) {
            if (en <= t[i][0]) {
                var f = (en - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
                return en * (t[i - 1][1] + f * (t[i][1] - t[i - 1][1]));
            }
        }
        return en * t[t.length - 1][1];
    }
    function epsFromSilver(totalAgNm) {
        if (!(totalAgNm > 0)) throw new Error('glazing-open.js: the total silver thickness must be positive');
        var rs = RHO_EFF / (totalAgNm * 1e-9), y = Z0 / rs, en = 4 * y / ((2 + y) * (2 + y));
        return { rs: rs, en: en, eh: hemispherical(en) };
    }

    var api = {
        label: 'Open data (Rubin glass, thin-film coatings)',
        GLASS: GLASS, COATINGS: COATINGS,
        pane: pane, stackPane: stackPane, film: film, glass: glass, material: material, epsFromSilver: epsFromSilver
    };
    E.registerModel('open', api);
    root.GlazingOpen = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
