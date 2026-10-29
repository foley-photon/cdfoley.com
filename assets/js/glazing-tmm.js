/* ==========================================================================
   cdfoley.com — glazing-tmm.js
   Normal-incidence thin-film optics for the open-data glazing model.

   stackRT: reflectance and transmittance of a stack of thin, coherent layers by the characteristic-matrix
   method, with the complex index N = n − ik (H. A. Macleod, Thin-Film Optical Filters, 4th ed., CRC Press,
   2010, ch. 2): δ = 2πNd/λ, M = Π [[cos δ, i sin δ/N], [iN sin δ, cos δ]] over the layers in the order light
   meets them, [B; C] = M [1; ηs], r = (η0 B − C)/(η0 B + C), R = |r|², T = 4 η0 ηs / |η0 B + C|².

   filmSpectra: a coating on the 5 nm grid, seen from air (Tc, Rc) and from inside the glass (Rg).

   combine: the coated film plus the thick glass, added incoherently (intensities, not amplitudes), with
   the glass-side film reflectance Rg used for light inside the glass (B. Harbecke, Coherent and incoherent
   reflection and transmission of multilayer structures, Appl. Phys. B 39, 165-170 (1986)).

   Pure functions on plain arrays; no DOM. Classic script (UMD): window.GlazingTMM, or module.exports.
   ========================================================================== */
(function (root) {
    'use strict';

    // R and T of a thin-film stack at one wavelength.
    // n[], k[], d[] (nm) list the layers in the order light meets them; lam in nm; n0: incident medium,
    // ns: exit medium (both real). T is the power fraction carried into the exit medium.
    function stackRT(n, k, d, lam, n0, ns) {
        // M = [[a, b], [c, e]], complex numbers stored as (re, im) pairs
        var a = 1, ai = 0, b = 0, bi = 0, c = 0, ci = 0, e = 1, ei = 0;
        for (var j = 0; j < n.length; j++) {
            var nr = n[j], ni = -k[j];                                                         // N = n − ik
            var dr = 2 * Math.PI * nr * d[j] / lam, di = 2 * Math.PI * ni * d[j] / lam;       // δ = 2πNd/λ
            var cr = Math.cos(dr) * Math.cosh(di), cim = -Math.sin(dr) * Math.sinh(di);       // cos δ
            var sr = Math.sin(dr) * Math.cosh(di), sim = Math.cos(dr) * Math.sinh(di);        // sin δ
            var den = nr * nr + ni * ni;
            var qr = (sr * nr + sim * ni) / den, qi = (sim * nr - sr * ni) / den;             // sin δ / N
            var a12r = -qi, a12i = qr;                                                         // i sin δ / N
            var pr = nr * sr - ni * sim, pi = nr * sim + ni * sr;                              // N sin δ
            var a21r = -pi, a21i = pr;                                                         // i N sin δ
            // M ← M · [[cos δ, i sin δ/N], [i N sin δ, cos δ]]
            var na = a * cr - ai * cim + b * a21r - bi * a21i, nai = a * cim + ai * cr + b * a21i + bi * a21r;
            var nb = a * a12r - ai * a12i + b * cr - bi * cim, nbi = a * a12i + ai * a12r + b * cim + bi * cr;
            var nc = c * cr - ci * cim + e * a21r - ei * a21i, nci = c * cim + ci * cr + e * a21i + ei * a21r;
            var ne = c * a12r - ci * a12i + e * cr - ei * cim, nei = c * a12i + ci * a12r + e * cim + ei * cr;
            a = na; ai = nai; b = nb; bi = nbi; c = nc; ci = nci; e = ne; ei = nei;
        }
        // [B; C] = M [1; ηs]
        var Br = a + b * ns, Bi = ai + bi * ns, Cr = c + e * ns, Ci = ci + ei * ns;
        var Dr = n0 * Br + Cr, Di = n0 * Bi + Ci;            // η0 B + C
        var Nr = n0 * Br - Cr, Ni = n0 * Bi - Ci;            // η0 B − C
        var dd = Dr * Dr + Di * Di;
        return { R: (Nr * Nr + Ni * Ni) / dd, T: 4 * n0 * ns / dd };
    }

    // Film spectra on a wavelength grid. layers: [{ n: [], k: [] | 0, d: nm }] listed from the glass outward
    // (the deposition order). ng: the substrate's real index at each grid point (its k, below 1e-5, is
    // ignored at the interface). Returns Float64Arrays: Tc (film transmittance, the same in both
    // directions), Rc (reflectance from air on the coated face), Rg (reflectance seen from inside the glass).
    function filmSpectra(layers, lam, ng) {
        var N = lam.length, Tc = new Float64Array(N), Rc = new Float64Array(N), Rg = new Float64Array(N);
        var m = layers.length;
        var nA = new Array(m), kA = new Array(m), dA = new Array(m), nB = new Array(m), kB = new Array(m), dB = new Array(m);
        for (var i = 0; i < N; i++) {
            for (var j = 0; j < m; j++) {
                var L = layers[j], nn = L.n[i], kk = L.k ? L.k[i] : 0;
                nB[j] = nn; kB[j] = kk; dB[j] = L.d;                           // from the glass: deposition order
                nA[m - 1 - j] = nn; kA[m - 1 - j] = kk; dA[m - 1 - j] = L.d;   // from air: reversed
            }
            var fa = stackRT(nA, kA, dA, lam[i], 1, ng[i]);
            var fg = stackRT(nB, kB, dB, lam[i], ng[i], 1);
            Tc[i] = fa.T; Rc[i] = fa.R; Rg[i] = fg.R;
        }
        return { Tc: Tc, Rc: Rc, Rg: Rg };
    }

    // A coated or bare pane from the film spectra (or null) and the substrate: R0 = bare glass/air interface
    // reflectance, tau = internal transmittance of the full thickness (arrays on the same grid).
    // side 'front': the coating faces outdoors (Rf is the coated face); 'back': it faces indoors.
    function combine(film, R0, tau, side) {
        var N = R0.length, T = new Float64Array(N), Rf = new Float64Array(N), Rb = new Float64Array(N);
        for (var i = 0; i < N; i++) {
            var r = R0[i], t = tau[i], t2 = t * t;
            if (!film) {
                var den0 = 1 - r * r * t2;
                T[i] = (1 - r) * (1 - r) * t / den0;
                Rf[i] = Rb[i] = r + (1 - r) * (1 - r) * r * t2 / den0;
                continue;
            }
            var Tc = film.Tc[i], Rc = film.Rc[i], Rg = film.Rg[i];
            var den = 1 - Rg * r * t2;
            T[i] = Tc * (1 - r) * t / den;
            var Rcoat = Rc + Tc * Tc * r * t2 / den;                  // light arriving on the coated face
            var Rglass = r + (1 - r) * (1 - r) * Rg * t2 / den;       // light arriving on the bare face
            if (side === 'back') { Rf[i] = Rglass; Rb[i] = Rcoat; } else { Rf[i] = Rcoat; Rb[i] = Rglass; }
        }
        return { T: T, Rf: Rf, Rb: Rb };
    }

    var api = { stackRT: stackRT, filmSpectra: filmSpectra, combine: combine };
    root.GlazingTMM = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
