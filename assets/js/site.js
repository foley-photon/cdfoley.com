/* ==========================================================================
   cdfoley.com — site.js
   Load in <head> without defer: sets the theme before first paint, then on
   DOMContentLoaded injects the shared header/footer, renders KaTeX (if the
   page loaded it), builds article TOCs, and renders tool/article listings.
   The TOOLS and ARTICLES registries below are the single source of truth for
   the tools hub, the learn hub, related links, and the footer.
   ========================================================================== */
(function () {
    'use strict';

    /* ── Theme (runs immediately) ───────────────────────────────────────── */
    var root = document.documentElement;
    try {
        var saved = localStorage.getItem('theme');
        if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
    } catch (e) { /* storage unavailable */ }

    function currentTheme() {
        if (root.dataset.theme) return root.dataset.theme;
        return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    function toggleTheme() {
        var next = currentTheme() === 'dark' ? 'light' : 'dark';
        root.dataset.theme = next;
        try { localStorage.setItem('theme', next); } catch (e) { /* ignore */ }
        document.dispatchEvent(new CustomEvent('themechange', { detail: next }));
    }

    /* ── Registries ─────────────────────────────────────────────────────── */
    var CATEGORIES = [
        { id: 'photon',  title: 'Photon Energy & Spectroscopy', blurb: 'Energy-unit conversion, photon flux, blackbody emission, line broadening, and spectrometer design.' },
        { id: 'beam',    title: 'Optics & Glazing',             blurb: 'Focusing, propagation, beam expansion, scan lenses, apertures, Fresnel reflection, and window glazing performance.' },
        { id: 'process', title: 'Laser Processing',             blurb: 'Pulse energy, fluence, overlap, ablation, damage thresholds, and heat accumulation.' },
        { id: 'vacuum',  title: 'Vacuum Technology',            blurb: 'Pressure units, gas kinetics, conductance, and pump-down estimates.' },
        { id: 'vision',  title: 'Vision, Imaging & Color',      blurb: 'Camera and lens selection, field of view, motion blur, color spaces, and color measurement.' },
        { id: 'quality', title: 'Quality & Manufacturing',      blurb: 'Process capability, control charts, sigma level, OEE, and takt time.' }
    ];

    var TOOLS = [
        // Photon energy & spectroscopy
        { slug: 'energy-converter',      cat: 'photon',  title: 'Energy & Wavelength Converter',  desc: 'Convert between nm, cm⁻¹, eV, Hartree, kJ/mol, kcal/mol, K, Hz, and J. Every field is live.', keys: 'hartree wavenumber wave number electronvolt electron volt rydberg frequency photon energy units spectroscopy nm to ev cm-1 wavelength kj/mol kcal/mol joule kelvin' },
        { slug: 'photon-flux',           cat: 'photon',  title: 'Photon Energy & Flux',           desc: 'Photons per second and per pulse from optical power, pulse energy, and wavelength.', keys: 'photon count photons per second quantum efficiency detector flux energy pulse photocurrent responsivity laser' },
        { slug: 'blackbody',             cat: 'photon',  title: 'Blackbody Radiation',            desc: 'Planck spectrum, Wien peak, Stefan–Boltzmann exitance, and in-band power fraction.', keys: 'planck wien stefan boltzmann plasma temperature emission spectrum radiance plancks law displacement stefan-boltzmann spectral emissivity gray body' },
        { slug: 'doppler-broadening',    cat: 'photon',  title: 'Spectral Line Broadening',       desc: 'Doppler (Gaussian) and natural (Lorentzian) linewidths, and the Voigt FWHM.', keys: 'doppler natural linewidth line width voigt temperature lifetime plasma spectroscopy broadening fwhm lorentzian gaussian profile' },
        { slug: 'grating-equation',      cat: 'photon',  title: 'Diffraction Grating & Spectrometer', desc: 'Diffraction angle, angular and linear dispersion, resolving power, and spectral bandpass.', keys: 'grating equation spectrometer monochromator czerny turner dispersion resolution littrow blaze diffraction calculator linear resolving power bandpass free spectral range' },
        // Gaussian beams & optics
        { slug: 'focused-spot',          cat: 'beam',    title: 'Focused Spot Size',              desc: 'Focused 1/e² diameter from wavelength, focal length, input beam, M², and aperture truncation.', keys: 'beam waist spot diameter focus gaussian m2 beam quality truncation apodization laser size focused calculator diffraction limited' },
        { slug: 'gaussian-beam',         cat: 'beam',    title: 'Gaussian Beam Propagation',      desc: 'Rayleigh range, beam radius, wavefront curvature, Gouy phase, and divergence vs. distance.', keys: 'rayleigh range depth of focus divergence propagation w(z) gouy gaussian beam calculator waist radius laser m2 beam quality bpp beam parameter product dof' },
        { slug: 'beam-expander',         cat: 'beam',    title: 'Beam Expander',                  desc: 'Output diameter and divergence for Galilean or Keplerian expanders, and the effect on spot size.', keys: 'telescope galilean keplerian magnification collimation beam expander lens spacing laser collimator m2' },
        { slug: 'f-theta-lens',          cat: 'beam',    title: 'F-Theta Scan Lens',              desc: 'Scan field, spot size, and depth of focus for galvanometer scanning systems.', keys: 'galvo scanner scan field telecentric marking f-theta ftheta lens spot size resolution angle laser corner diagonal optical mechanical telecentricity scan head' },
        { slug: 'aperture-transmission', cat: 'beam',    title: 'Gaussian Beam Clipping',         desc: 'Power transmitted through a circular aperture, slit, or past a knife edge, and the size needed for a target throughput.', keys: 'aperture iris clipping truncation transmission pinhole gaussian beam slit knife edge profile spatial filter laser 10-90 16-84 d4sigma clip level diffraction ripple' },
        { slug: 'fresnel-equations',     cat: 'beam',    title: 'Fresnel Reflection & Brewster Angle', desc: 's- and p-polarized reflectance vs. angle, Brewster angle, and total internal reflection.', keys: 'fresnel reflectance brewster critical angle snell refraction polarization total internal reflection tir loss s p evanescent refractive index germanium silicon znse sapphire window' },
        { slug: 'glazing-performance',   cat: 'beam',    title: 'Glazing Performance Calculator', desc: 'U-factor, SHGC, visible and solar transmittance, reflectance, and color for single, double, triple, and vacuum glazing with low-e coatings.', keys: 'window glass glazing igu insulating low-e coating u-factor u-value shgc solar heat gain visible transmittance vt argon krypton vacuum vig nfrc lbnl window calculator', featured: true },
        { slug: 'low-e-sheet-resistance', cat: 'beam',   title: 'Low-E Sheet Resistance & Emissivity', desc: 'Ohms per square to emissivity, silver thickness, RF attenuation, and U-factor, with typical values for each low-e coating family.', keys: 'sheet resistance ohms per square low-e emissivity silver ito fto tin oxide four point probe eddy current rf shielding coating calculator', featured: true },
        { slug: 'optical-density',       cat: 'beam',    title: 'Optical Density & Attenuation',  desc: 'Convert between OD, transmittance, dB, and percent blocked, stack ND filters, and find the OD needed for a target power.', keys: 'od transmission attenuation neutral density filter db absorbance optical calculator nd to laser inconel eyewear mpe en 207' },
        // Laser processing
        { slug: 'pulse-energy',          cat: 'process', title: 'Pulse Energy & Peak Power',      desc: 'Interconvert average power, repetition rate, pulse energy, peak power, and duty cycle.', keys: 'pulse energy peak power duty cycle repetition rate average power calculator sech2 gaussian laser' },
        { slug: 'fluence',               cat: 'process', title: 'Fluence & Irradiance',           desc: 'Peak and average fluence, peak irradiance, and the diameter above an ablation threshold for Gaussian and top-hat spots.', keys: 'fluence irradiance intensity energy density power density laser peak j/cm2 w/cm2' },
        { slug: 'pulse-overlap',         cat: 'process', title: 'Pulse & Hatch Overlap',          desc: 'Pulse-to-pulse and line-to-line overlap, pulses per spot, and area coverage rate for scanning.', keys: 'overlap scan speed hatch pitch pulses per spot scribing marking pulse calculator distance rep rate laser' },
        { slug: 'ablation-depth',        cat: 'process', title: 'Ablation Threshold & Depth',     desc: 'Logarithmic ablation model, threshold from crater diameters (Liu method), and incubation.', keys: 'ablation threshold depth liu method incubation penetration depth rate d2 crater diameter fluence laser calculator' },
        { slug: 'lidt',                  cat: 'process', title: 'Damage Threshold (LIDT) Scaling',desc: 'Scale a laser-induced damage threshold to your pulse duration and wavelength, and check the margin at your fluence or CW power density.', keys: 'lidt damage threshold optics coating scaling laser induced pulse duration' },
        { slug: 'thermal-diffusion',     cat: 'process', title: 'Thermal Diffusion & Heat Accumulation', desc: 'Thermal diffusion length, heat-affected zone estimates, and the repetition rate where heat builds up.', keys: 'thermal diffusivity diffusion length heat affected zone haz accumulation laser pulsed' },
        // Vacuum
        { slug: 'pressure-converter',    cat: 'vacuum',  title: 'Pressure Unit Converter',        desc: 'Pa, mbar, Torr, mTorr, atm, psi, bar, and inHg, with the vacuum regime for each value.', keys: 'pressure torr mbar pascal atm psi vacuum units to pa mtorr mmhg inhg kpa bar converter' },
        { slug: 'mean-free-path',        cat: 'vacuum',  title: 'Mean Free Path & Gas Kinetics',  desc: 'Mean free path, Knudsen number, flow regime, number density, impingement rate, and monolayer time.', keys: 'mean free path knudsen flow regime molecular viscous number density monolayer calculator gas kinetics' },
        { slug: 'pumpdown',              cat: 'vacuum',  title: 'Conductance & Pump-Down Time',   desc: 'Tube and orifice conductance, effective pumping speed, and pump-down time for a chamber.', keys: 'conductance pumping speed pump down time effective speed tube orifice calculator vacuum pumpdown outgassing base pressure' },
        // Machine vision
        { slug: 'vision-system-configurator', cat: 'vision', title: 'Vision System Configurator', desc: 'Pick a sensor and lens for your field of view and defect size, see the setup drawn, and check depth of field, motion blur, bandwidth, and lighting.', keys: 'camera sensor lens configurator sony imx onsemi gpixel pregius working distance pixel size lighting interface gige usb3 coaxpress machine vision selection', featured: true },
        { slug: 'machine-vision-lens',   cat: 'vision',  title: 'Machine Vision Lens Selection',  desc: 'Magnification, field of view, depth of field, pixel resolution, and smallest detectable defect.', keys: 'fov field of view magnification depth of field dof focal length sensor resolution pixel size camera lens calculator working distance' },
        { slug: 'color-converter',       cat: 'vision',  title: 'Color Converter & Color Measurement', desc: 'HEX, RGB, HSV, HSL, CMYK, XYZ, xyY, CIELAB, and LCh conversions, ΔE00 and ΔE*ab, spectra to color, and how cameras and spectrophotometers measure color.', keys: 'color colour hex rgb srgb hsv hsl cmyk cielab lab lch xyz xyy delta e 2000 ΔE2000 ciede2000 de2000 de00 chromaticity spectrophotometer camera low-e coating color measurement color difference calculator', featured: true },
        { slug: 'motion-blur',           cat: 'vision',  title: 'Motion Blur & Exposure',         desc: 'Maximum exposure or strobe time for a moving part, blur at a given exposure, and the frame or line-scan rate for a conveyor.', keys: 'motion blur exposure strobe conveyor line scan speed time calculator rate frame' },
        // Quality & manufacturing
        { slug: 'process-capability',    cat: 'quality', title: 'Process Capability (Cp, Cpk)',   desc: 'Cp, Cpk, Pp, Ppk, Cpm, and expected PPM from raw data or summary statistics, with a histogram, probability plot, and normality test.', keys: 'cpk ppk cp pp capability spc six sigma ppm specification calculator process index cpm z.bench anderson darling normality probability plot pooled standard deviation sbar rbar c4 d2 cw cwk aiag vda ppap bissell confidence interval' },
        { slug: 'control-chart',         cat: 'quality', title: 'Control Chart Limits',           desc: 'X̄–R, X̄–S, and I–MR control limits from your data, with out-of-control points and run-rule signals flagged.', keys: 'control chart spc xbar r s individuals moving range ucl lcl western electric nelson run rules zone trend arl average run length phase i phase ii shewhart xmr limits calculator x-bar i-mr' },
        { slug: 'sigma-level',           cat: 'quality', title: 'DPMO, Yield & Sigma Level',      desc: 'Convert between defects per million, yield, and sigma level, with or without the 1.5σ shift, and compute first-pass and rolled throughput yield.', keys: 'dpmo sigma level yield rolled throughput rty six sigma defects calculator dpu dpo first pass yield fpy 1.5 sigma shift z score normalized yield tdpu rule of three zero defects poisson yield' },
        { slug: 'oee-takt',              cat: 'quality', title: 'OEE & Takt Time',                desc: 'Overall equipment effectiveness from availability, performance, and quality, plus takt time, minimum stations, and line balance.', keys: 'oee takt time cycle time availability performance quality lean overall equipment effectiveness line balancing six big losses tpm teep utilization planned cycle time operator balance chart yamazumi balance delay iso 22400 semi e79' }
    ];

    var ARTICLES = [
        { slug: 'gaussian-beam-optics',     title: 'Gaussian Beam Optics for Engineers',          desc: 'Waist, Rayleigh range, M², apertures, and how to choose a lens and beam size for the spot you need.', topic: 'Optics', mins: 10 },
        { slug: 'laser-ablation-process-windows', title: 'Laser Ablation Process Windows',       desc: 'Threshold fluence, incubation, pulse overlap, heat accumulation, and designed experiments for a robust ablation process.', topic: 'Laser processing', mins: 14 },
        { slug: 'vacuum-fundamentals',      title: 'Vacuum Fundamentals',                          desc: 'Pressure ranges, gas kinetics, conductance, outgassing, leaks, and why a bigger pump rarely fixes a slow pump-down.', topic: 'Vacuum', mins: 14 },
        { slug: 'spc-for-laser-processes',  title: 'SPC and Process Capability in Production',     desc: 'Control charts, run rules, Cpk, and measurement systems for a high-yield laser process.', topic: 'Quality', mins: 13 },
        { slug: 'machine-vision-optics',    title: 'Machine Vision Optics for Inspection',         desc: 'Resolution, contrast, depth of field, telecentric lenses, lighting, and validation for detecting small defects.', topic: 'Imaging', mins: 12 },
        { slug: 'spectroscopic-units',      title: 'Energy Units in Spectroscopy',                 desc: 'Which energy unit for which job, why spectroscopists use wavenumbers, and how to convert line positions and widths.', topic: 'Spectroscopy', mins: 8 }
    ];

    var CONTACT = {
        email: 'foley.photon@gmail.com',
        linkedin: 'https://www.linkedin.com/in/cdfoley',
        scholar: 'https://scholar.google.com/citations?hl=en&user=vwZJ8iIAAAAJ'
    };

    /* ── Icons ──────────────────────────────────────────────────────────── */
    var ICONS = {
        moon: '<svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
        sun: '<svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v2.5M12 20v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M1.5 12H4M20 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/></svg>',
        menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
        mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
        linkedin: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"/></svg>',
        scholar: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 24a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm0-24L0 9.5l4.84 3.94A8 8 0 0 1 12 9a8 8 0 0 1 7.16 4.44L24 9.5z"/></svg>',
        doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>'
    };
    var BRAND_MARK =
        '<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">' +
        '<defs><linearGradient id="bm-g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#8b5cf6"/><stop offset=".5" stop-color="#a855f7"/><stop offset="1" stop-color="#c084fc"/></linearGradient></defs>' +
        '<rect width="32" height="32" rx="7" fill="#0b1220"/><path d="M4.00 10.08 L4.50 10.31 L5.00 10.53 L5.50 10.76 L6.00 10.98 L6.50 11.20 L7.00 11.42 L7.50 11.64 L8.00 11.86 L8.50 12.07 L9.00 12.28 L9.50 12.49 L10.00 12.70 L10.50 12.90 L11.00 13.09 L11.50 13.28 L12.00 13.46 L12.50 13.63 L13.00 13.79 L13.50 13.93 L14.00 14.06 L14.50 14.16 L15.00 14.24 L15.50 14.28 L16.00 14.30 L16.50 14.28 L17.00 14.24 L17.50 14.16 L18.00 14.06 L18.50 13.93 L19.00 13.79 L19.50 13.63 L20.00 13.46 L20.50 13.28 L21.00 13.09 L21.50 12.90 L22.00 12.70 L22.50 12.49 L23.00 12.28 L23.50 12.07 L24.00 11.86 L24.50 11.64 L25.00 11.42 L25.50 11.20 L26.00 10.98 L26.50 10.76 L27.00 10.53 L27.50 10.31 L28.00 10.08 L28.00 21.92 L27.50 21.69 L27.00 21.47 L26.50 21.24 L26.00 21.02 L25.50 20.80 L25.00 20.58 L24.50 20.36 L24.00 20.14 L23.50 19.93 L23.00 19.72 L22.50 19.51 L22.00 19.30 L21.50 19.10 L21.00 18.91 L20.50 18.72 L20.00 18.54 L19.50 18.37 L19.00 18.21 L18.50 18.07 L18.00 17.94 L17.50 17.84 L17.00 17.76 L16.50 17.72 L16.00 17.70 L15.50 17.72 L15.00 17.76 L14.50 17.84 L14.00 17.94 L13.50 18.07 L13.00 18.21 L12.50 18.37 L12.00 18.54 L11.50 18.72 L11.00 18.91 L10.50 19.10 L10.00 19.30 L9.50 19.51 L9.00 19.72 L8.50 19.93 L8.00 20.14 L7.50 20.36 L7.00 20.58 L6.50 20.80 L6.00 21.02 L5.50 21.24 L5.00 21.47 L4.50 21.69 L4.00 21.92Z" fill="url(#bm-g)" opacity="0.28"/><path d="M4.00 10.08 L4.50 10.31 L5.00 10.53 L5.50 10.76 L6.00 10.98 L6.50 11.20 L7.00 11.42 L7.50 11.64 L8.00 11.86 L8.50 12.07 L9.00 12.28 L9.50 12.49 L10.00 12.70 L10.50 12.90 L11.00 13.09 L11.50 13.28 L12.00 13.46 L12.50 13.63 L13.00 13.79 L13.50 13.93 L14.00 14.06 L14.50 14.16 L15.00 14.24 L15.50 14.28 L16.00 14.30 L16.50 14.28 L17.00 14.24 L17.50 14.16 L18.00 14.06 L18.50 13.93 L19.00 13.79 L19.50 13.63 L20.00 13.46 L20.50 13.28 L21.00 13.09 L21.50 12.90 L22.00 12.70 L22.50 12.49 L23.00 12.28 L23.50 12.07 L24.00 11.86 L24.50 11.64 L25.00 11.42 L25.50 11.20 L26.00 10.98 L26.50 10.76 L27.00 10.53 L27.50 10.31 L28.00 10.08 M4.00 21.92 L4.50 21.69 L5.00 21.47 L5.50 21.24 L6.00 21.02 L6.50 20.80 L7.00 20.58 L7.50 20.36 L8.00 20.14 L8.50 19.93 L9.00 19.72 L9.50 19.51 L10.00 19.30 L10.50 19.10 L11.00 18.91 L11.50 18.72 L12.00 18.54 L12.50 18.37 L13.00 18.21 L13.50 18.07 L14.00 17.94 L14.50 17.84 L15.00 17.76 L15.50 17.72 L16.00 17.70 L16.50 17.72 L17.00 17.76 L17.50 17.84 L18.00 17.94 L18.50 18.07 L19.00 18.21 L19.50 18.37 L20.00 18.54 L20.50 18.72 L21.00 18.91 L21.50 19.10 L22.00 19.30 L22.50 19.51 L23.00 19.72 L23.50 19.93 L24.00 20.14 L24.50 20.36 L25.00 20.58 L25.50 20.80 L26.00 21.02 L26.50 21.24 L27.00 21.47 L27.50 21.69 L28.00 21.92" fill="none" stroke="url(#bm-g)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>';

    /* ── Helpers ────────────────────────────────────────────────────────── */
    function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function toolBySlug(s) { for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].slug === s) return TOOLS[i]; return null; }
    function articleBySlug(s) { for (var i = 0; i < ARTICLES.length; i++) if (ARTICLES[i].slug === s) return ARTICLES[i]; return null; }
    function catTitle(id) { for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i].title; return ''; }

    /* ── Header / footer ────────────────────────────────────────────────── */
    var NAV = [
        { href: '/tools/',        label: 'Tools',        section: 'tools' },
        { href: '/learn/',        label: 'Learn',        section: 'learn' },
        { href: '/formulas/',     label: 'Formulas',     section: 'formulas' },
        { href: '/publications/', label: 'Publications', section: 'publications' },
        { href: '/#about',        label: 'About',        section: 'home' },
        { href: '/resume/',       label: 'Resume',       section: 'resume' },
        { href: '/games/',        label: 'Games',        section: 'games' }
    ];

    function renderHeader() {
        var slot = document.getElementById('site-header');
        if (!slot) return;
        var section = document.body.dataset.section || '';
        var here = location.pathname.replace(/index\.html$/, '');
        var links = NAV.map(function (n) {
            // The link to this very page is the current page; on a page inside a section (a tool, an article, a game)
            // the section link is highlighted but marked only as the current item, so it doesn't claim to be this page.
            var current = '';
            if (n.section !== 'home') {
                if (here === n.href) current = ' aria-current="page"';
                else if (n.section === section) current = ' class="active" aria-current="true"';
            }
            return '<a href="' + n.href + '"' + current + '>' + n.label + '</a>';
        }).join('');
        var header = el(
            '<header class="site-header">' +
              '<div class="wrap nav">' +
                '<a class="brand" href="/">' + BRAND_MARK + '<span>Casey D. Foley<span class="brand-sub">, PhD</span></span></a>' +
                '<nav class="nav-links" id="nav-links" aria-label="Primary">' + links + '</nav>' +
                '<button class="icon-btn theme-toggle" type="button" aria-label="Toggle dark mode">' + ICONS.moon + ICONS.sun + '</button>' +
                '<button class="icon-btn menu-toggle" type="button" aria-label="Menu" aria-expanded="false" aria-controls="nav-links">' + ICONS.menu + '</button>' +
              '</div>' +
            '</header>');
        slot.replaceWith(header);
        header.querySelector('.theme-toggle').addEventListener('click', toggleTheme);
        var menuBtn = header.querySelector('.menu-toggle');
        var navLinks = header.querySelector('.nav-links');
        function setMenu(open) {
            navLinks.classList.toggle('open', open);
            menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        menuBtn.addEventListener('click', function (e) {
            var open = !navLinks.classList.contains('open');
            setMenu(open);
            // Opened from the keyboard (detail 0): the links come before this button in tab order, so start there
            if (open && e.detail === 0) navLinks.querySelector('a').focus();
        });
        navLinks.addEventListener('click', function (e) {
            if (e.target.closest('a')) setMenu(false);
        });
        // Close the mobile menu with Escape, by clicking or tapping outside the header, or by tabbing out of it
        document.addEventListener('keydown', function (e) {
            if ((e.key === 'Escape' || e.key === 'Esc') && navLinks.classList.contains('open')) { setMenu(false); menuBtn.focus(); }
        });
        function outside(e) { if (navLinks.classList.contains('open') && !header.contains(e.target)) setMenu(false); }
        document.addEventListener('pointerdown', outside);    // iOS Safari sends no click for taps on plain text
        document.addEventListener('click', outside);
        header.addEventListener('focusout', function (e) {
            if (navLinks.classList.contains('open') && e.relatedTarget && !header.contains(e.relatedTarget)) setMenu(false);
        });
    }

    function renderFooter() {
        var slot = document.getElementById('site-footer');
        if (!slot) return;
        var year = new Date().getFullYear();
        var footer = el(
            '<footer class="site-footer">' +
              '<div class="wrap footer-grid">' +
                '<div>' +
                  '<div class="footer-name">Casey D. Foley, PhD</div>' +
                  '<p style="margin:0 0 1rem;max-width:36ch">Free engineering tools and explainers for lasers, optics, vacuum, machine vision, and quality.</p>' +
                '</div>' +
                '<div><h2>Resources</h2><ul>' +
                  '<li><a href="/tools/">All ' + TOOLS.length + ' tools</a></li>' +
                  '<li><a href="/tools/vision-system-configurator/">Vision system configurator</a></li>' +
                  '<li><a href="/formulas/">Formula reference</a></li>' +
                  '<li><a href="/learn/">Knowledge center</a></li>' +
                  '<li><a href="/games/">Games</a></li>' +
                '</ul></div>' +
                '<div><h2>About</h2><ul>' +
                  '<li><a href="/#about">About me</a></li>' +
                  '<li><a href="/#work">Selected work</a></li>' +
                  '<li><a href="/publications/">Publications</a></li>' +
                  '<li><a href="/resume/">Resume</a></li>' +
                '</ul></div>' +
                '<div><h2>Contact</h2><ul>' +
                  '<li><a href="mailto:' + CONTACT.email + '">Email</a></li>' +
                  '<li><a href="' + CONTACT.linkedin + '" rel="noopener" target="_blank">LinkedIn</a></li>' +
                  '<li><a href="' + CONTACT.scholar + '" rel="noopener" target="_blank">Google Scholar</a></li>' +
                '</ul></div>' +
              '</div>' +
              '<div class="wrap footer-bottom">' +
                '<span>© ' + year + ' Casey D. Foley</span>' +
                '<span>Calculators are for education and estimation. Verify critical results and follow ANSI Z136 / IEC 60825 laser-safety practice.</span>' +
              '</div>' +
            '</footer>');
        slot.replaceWith(footer);
    }

    /* ── Search ─────────────────────────────────────────────────────────── */
    // Text folded for matching: lower case, no accents, superscripts as plain digits (M² → m2, J/cm² → j cm2,
    // cm⁻¹ → cm 1), possessives dropped (Planck's → planck), and other punctuation turned into spaces.
    function fold(s) {
        s = String(s).toLowerCase();
        if (s.normalize) s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        return s.replace(/['\u2019]s\b/g, '').replace(/['\u2019^]/g, '').replace(/[^a-z0-9\u0370-\u03ff]+/g, ' ').trim();
    }
    // Words that don't narrow the search: every tool is a free online calculator ("fluence calculator", "how to convert torr to mbar")
    var STOP = ' a an and the of for to in on at by with from or vs versus how what is are do does i my calculator calculators calculate calculating calculation calculations calc compute tool tools online free convert converting conversion conversions formula formulas equation equations law laws ';
    function queryWords(q) {
        return fold(q).split(' ').filter(function (w) { return w && STOP.indexOf(' ' + w + ' ') === -1; });
    }
    // Each query word must begin a word of the text ("ev" finds "eV" but not "level"); a one-letter word must be a
    // whole word, and a plural also finds its singular ("lasers" → "laser", "lenses" → "lens").
    function hasWords(text, words) {
        var hay = ' ' + text + ' ';
        return words.every(function (w) {
            if (w.length === 1) return hay.indexOf(' ' + w + ' ') !== -1;
            if (hay.indexOf(' ' + w) !== -1) return true;
            if (w.length >= 5 && w.slice(-1) === 's' && hay.indexOf(' ' + w.slice(0, -1)) !== -1) return true;
            return w.length >= 6 && w.slice(-2) === 'es' && hay.indexOf(' ' + w.slice(0, -2)) !== -1;
        });
    }
    function toolText(t) { return fold([t.title, t.desc, t.keys, t.slug, catTitle(t.cat)].join(' ')); }
    function articleText(a) { return fold([a.title, a.desc, a.topic, a.slug].join(' ')); }
    // Tools and articles matching every word of a query (none for an empty query)
    function findTools(q) { var w = queryWords(q); return w.length ? TOOLS.filter(function (t) { return hasWords(toolText(t), w); }) : []; }
    function findArticles(q) { var w = queryWords(q); return w.length ? ARTICLES.filter(function (a) { return hasWords(articleText(a), w); }) : []; }

    /* ── Listings ───────────────────────────────────────────────────────── */
    function toolCard(t) {
        return '<a class="card tool-card" href="/tools/' + t.slug + '/" data-cat="' + t.cat + '" data-search="' + esc(toolText(t)) + '">' +
            '<h3>' + esc(t.title) + '</h3><p>' + esc(t.desc) + '</p>' +
            '<div class="card-meta">' + esc(catTitle(t.cat)) + '</div></a>';
    }
    function articleCard(a) {
        return '<a class="card tool-card" href="/learn/' + a.slug + '/">' +
            '<div class="card-meta" style="margin:0 0 .4rem">' + esc(a.topic) + ' · ' + a.mins + ' min read</div>' +
            '<h3>' + esc(a.title) + '</h3><p>' + esc(a.desc) + '</p></a>';
    }

    // <div data-related="slug,slug,article:slug"></div>
    function renderRelated() {
        document.querySelectorAll('[data-related]').forEach(function (box) {
            var html = box.dataset.related.split(',').map(function (s) {
                s = s.trim();
                if (s.indexOf('article:') === 0) { var a = articleBySlug(s.slice(8)); return a ? articleCard(a) : ''; }
                var t = toolBySlug(s); return t ? toolCard(t) : '';
            }).join('');
            box.classList.add('grid', 'grid-3');
            box.innerHTML = html;
        });
    }

    // <div data-tool-hub></div> on /tools/
    function renderToolHub() {
        var hub = document.querySelector('[data-tool-hub]');
        if (!hub) return;
        var cats = '<div class="tool-cats" role="group" aria-label="Filter by category"><button type="button" aria-pressed="true" data-filter="">All</button>' +
            CATEGORIES.map(function (c) { return '<button type="button" aria-pressed="false" data-filter="' + c.id + '">' + esc(c.title) + '</button>'; }).join('') + '</div>';
        var groups = CATEGORIES.map(function (c) {
            var items = TOOLS.filter(function (t) { return t.cat === c.id; });
            return '<section class="tool-group" data-group="' + c.id + '" id="' + c.id + '">' +
                '<h2>' + esc(c.title) + ' <span class="count">' + items.length + '<span class="visually-hidden"> tools</span></span></h2>' +
                '<div class="grid grid-3">' + items.map(toolCard).join('') + '</div></section>';
        }).join('');
        hub.innerHTML =
            '<div class="tool-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
            '<input type="search" placeholder="Search ' + TOOLS.length + ' calculators — e.g. “Rayleigh”, “Cpk”, “Torr”" aria-label="Search tools" autocomplete="off"></div>' +
            cats + groups + '<p class="empty-state"></p><p class="visually-hidden" role="status"></p>';

        var input = hub.querySelector('input[type="search"]');
        var buttons = hub.querySelectorAll('[data-filter]');
        var empty = hub.querySelector('.empty-state'), status = hub.querySelector('[role="status"]');
        var filter = '';
        function apply() {
            var words = queryWords(input.value);
            var shown = 0, elsewhere = 0;
            hub.querySelectorAll('.tool-group').forEach(function (g) {
                var n = 0;
                g.querySelectorAll('.tool-card').forEach(function (card) {
                    var hit = hasWords(card.dataset.search, words);
                    var ok = hit && (!filter || card.dataset.cat === filter);
                    if (hit && !ok) elsewhere++;
                    card.style.display = ok ? '' : 'none';
                    if (ok) n++;
                });
                g.style.display = n ? '' : 'none';
                shown += n;
            });
            empty.innerHTML = filter && elsewhere
                ? 'No tools in ' + esc(catTitle(filter)) + ' match that search. <button type="button" class="btn btn-secondary btn-sm" data-show-all>Show ' +
                  elsewhere + (elsewhere === 1 ? ' match' : ' matches') + ' in all categories</button>'
                : 'No tools match that search.';
            empty.style.display = shown ? 'none' : 'block';
            status.textContent = words.length || filter ? (shown === 1 ? '1 tool' : shown + ' tools') + ' shown' : '';
        }
        function setFilter(id) {
            var known = Array.prototype.some.call(buttons, function (x) { return x.dataset.filter === id; });
            if (!known) return;
            filter = id;
            buttons.forEach(function (x) { x.setAttribute('aria-pressed', x.dataset.filter === id ? 'true' : 'false'); });
            apply();
        }
        // Keep the search and the category in the address, so Back, reload, and shared links show the same list
        function syncUrl() {
            var p = new URLSearchParams(location.search), q = input.value.trim();
            if (q) p.set('q', q); else p.delete('q');
            var s = p.toString(), url = location.pathname + (s ? '?' + s : '') + (filter ? '#' + filter : '');
            if (url !== location.pathname + location.search + location.hash) {
                try { history.replaceState(history.state, '', url); } catch (e) { /* ignore */ }
            }
        }
        input.addEventListener('input', function () { apply(); syncUrl(); });
        buttons.forEach(function (b) {
            b.addEventListener('click', function () { setFilter(b.dataset.filter); syncUrl(); });
        });
        hub.addEventListener('click', function (e) {
            if (e.target.closest('[data-show-all]')) { setFilter(''); syncUrl(); input.focus(); }
        });
        window.addEventListener('hashchange', function () { setFilter(location.hash.slice(1)); });
        var q0 = new URLSearchParams(location.search).get('q');
        if (q0) input.value = q0;
        if (location.hash) setFilter(location.hash.slice(1));
        apply();
    }

    // <div data-tool-cats></div>: one tile per category listing its tools
    function renderToolCats() {
        document.querySelectorAll('[data-tool-cats]').forEach(function (box) {
            box.classList.add('grid', 'grid-3');
            box.innerHTML = CATEGORIES.map(function (c) {
                var items = TOOLS.filter(function (t) { return t.cat === c.id; });
                return '<div class="card cat-card"><h3><a href="/tools/#' + c.id + '">' + esc(c.title) + '</a> <span class="count">' + items.length + '<span class="visually-hidden"> tools</span></span></h3>' +
                    '<p>' + esc(c.blurb) + '</p><ul>' + items.map(function (t) {
                        return '<li><a href="/tools/' + t.slug + '/">' + esc(t.title) + '</a></li>';
                    }).join('') + '</ul></div>';
            }).join('');
        });
    }

    // <div data-article-hub></div> on /learn/
    function renderArticleHub() {
        var hub = document.querySelector('[data-article-hub]');
        if (!hub) return;
        hub.classList.add('grid', 'grid-3');
        hub.innerHTML = ARTICLES.map(articleCard).join('');
    }

    // <div data-tool-count></div> / <span data-article-count></span>
    function renderCounts() {
        document.querySelectorAll('[data-tool-count]').forEach(function (n) { n.textContent = TOOLS.length; });
        document.querySelectorAll('[data-article-count]').forEach(function (n) { n.textContent = ARTICLES.length; });
    }

    /* ── Article table of contents ──────────────────────────────────────── */
    function renderToc() {
        var toc = document.querySelector('[data-toc]');
        var prose = document.querySelector('.prose');
        if (!toc || !prose) return;
        var heads = prose.querySelectorAll('h2');
        if (!heads.length) { toc.remove(); return; }
        var items = [];
        heads.forEach(function (h, i) {
            if (!h.id) h.id = h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || ('s' + i);
            items.push('<li><a href="#' + h.id + '">' + esc(h.textContent) + '</a></li>');
        });
        toc.innerHTML = '<h2>On this page</h2><ol>' + items.join('') + '</ol>';
        if ('IntersectionObserver' in window) {
            var links = toc.querySelectorAll('a');
            var obs = new IntersectionObserver(function (entries) {
                entries.forEach(function (e) {
                    if (e.isIntersecting) links.forEach(function (a) { a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id); });
                });
            }, { rootMargin: '-20% 0px -70% 0px' });
            heads.forEach(function (h) { obs.observe(h); });
        }
    }

    /* ── Math ───────────────────────────────────────────────────────────── */
    function renderMath() {
        if (typeof window.renderMathInElement !== 'function') return;
        window.renderMathInElement(document.body, {
            delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '\\[', right: '\\]', display: true },
                { left: '\\(', right: '\\)', display: false }
            ],
            ignoredClasses: ['no-math'],
            throwOnError: false
        });
        // Keep punctuation on the line of its formula: browsers may wrap between KaTeX's inline-block boxes and a
        // following "," or "." (or after a "(" before the formula). Such a formula and its punctuation go in a nowrap
        // span; the breaks KaTeX allows inside a long formula, between its .base boxes, stay as wrappable zero-width spaces.
        document.querySelectorAll('.katex').forEach(function (k) {
            var w = k.parentNode;
            if (k.closest('.katex-display') || w.parentNode.classList.contains('math-nb')) return;
            var n = w.nextSibling, p = w.previousSibling;
            var after = n && n.nodeType === 3 ? (n.nodeValue.match(/^[,.;:!?)\]]+/) || [''])[0] : '';
            var before = p && p.nodeType === 3 ? (p.nodeValue.match(/[(\[]$/) || [''])[0] : '';
            if (!after && !before) return;
            var s = document.createElement('span');
            s.className = 'math-nb'; s.style.whiteSpace = 'nowrap';
            w.parentNode.insertBefore(s, w);
            if (before) { p.nodeValue = p.nodeValue.slice(0, -before.length); s.appendChild(document.createTextNode(before)); }
            s.appendChild(w);
            if (after) { n.nodeValue = n.nodeValue.slice(after.length); s.appendChild(document.createTextNode(after)); }
            var bases = k.querySelectorAll('.katex-html > .base');
            for (var i = 0; i < bases.length - 1; i++) {
                var z = document.createElement('span');
                z.style.whiteSpace = 'normal'; z.textContent = '\u200b';
                bases[i].parentNode.insertBefore(z, bases[i].nextSibling);
            }
        });
    }

    /* ── Boot ───────────────────────────────────────────────────────────── */
    function boot() {
        renderHeader();
        renderFooter();
        renderToolHub();
        renderToolCats();
        renderArticleHub();
        renderRelated();
        renderCounts();
        renderToc();
        renderMath();
        document.dispatchEvent(new Event('site:ready'));
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    window.Site = {
        tools: TOOLS, articles: ARTICLES, categories: CATEGORIES, contact: CONTACT, icons: ICONS,
        toolBySlug: toolBySlug, articleBySlug: articleBySlug, catTitle: catTitle,
        searchWords: queryWords, findTools: findTools, findArticles: findArticles,
        theme: currentTheme, renderMath: renderMath
    };
})();
