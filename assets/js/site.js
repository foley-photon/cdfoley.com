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
        { id: 'vision',  title: 'Machine Vision & Imaging',     blurb: 'Lens selection, field of view, depth of field, resolution, and motion blur.' },
        { id: 'quality', title: 'Quality & Manufacturing',      blurb: 'Process capability, control charts, sigma level, OEE, and takt time.' }
    ];

    var TOOLS = [
        // Photon energy & spectroscopy
        { slug: 'energy-converter',      cat: 'photon',  title: 'Energy & Wavelength Converter',  desc: 'Convert between nm, cm⁻¹, eV, Hartree, kJ/mol, kcal/mol, K, Hz, and J. Every field is live.', keys: 'hartree wavenumber electronvolt rydberg frequency photon energy units spectroscopy' },
        { slug: 'photon-flux',           cat: 'photon',  title: 'Photon Energy & Flux',           desc: 'Photons per second and per pulse from optical power, pulse energy, and wavelength.', keys: 'photon count photons per second quantum efficiency detector' },
        { slug: 'blackbody',             cat: 'photon',  title: 'Blackbody Radiation',            desc: 'Planck spectrum, Wien peak, Stefan–Boltzmann exitance, and in-band power fraction.', keys: 'planck wien stefan boltzmann plasma temperature emission spectrum radiance' },
        { slug: 'doppler-broadening',    cat: 'photon',  title: 'Spectral Line Broadening',       desc: 'Doppler (Gaussian) and natural (Lorentzian) linewidths, and the Voigt FWHM.', keys: 'doppler natural linewidth voigt temperature lifetime plasma spectroscopy' },
        { slug: 'grating-equation',      cat: 'photon',  title: 'Diffraction Grating & Spectrometer', desc: 'Diffraction angle, angular and linear dispersion, resolving power, and spectral bandpass.', keys: 'grating equation spectrometer czerny turner dispersion resolution littrow blaze' },
        // Gaussian beams & optics
        { slug: 'focused-spot',          cat: 'beam',    title: 'Focused Spot Size',              desc: 'Focused 1/e² diameter from wavelength, focal length, input beam, M², and aperture truncation.', keys: 'beam waist spot diameter focus gaussian m2 truncation apodization' },
        { slug: 'gaussian-beam',         cat: 'beam',    title: 'Gaussian Beam Propagation',      desc: 'Rayleigh range, beam radius, wavefront curvature, Gouy phase, and divergence vs. distance.', keys: 'rayleigh range depth of focus divergence propagation w(z) gouy' },
        { slug: 'beam-expander',         cat: 'beam',    title: 'Beam Expander',                  desc: 'Output diameter and divergence for Galilean or Keplerian expanders, and the effect on spot size.', keys: 'telescope galilean keplerian magnification collimation' },
        { slug: 'f-theta-lens',          cat: 'beam',    title: 'F-Theta Scan Lens',              desc: 'Scan field, spot size, and depth of focus for galvanometer scanning systems.', keys: 'galvo scanner scan field telecentric marking' },
        { slug: 'aperture-transmission', cat: 'beam',    title: 'Gaussian Beam Clipping',         desc: 'Power transmitted through a circular aperture and the aperture needed for a target throughput.', keys: 'aperture iris clipping truncation transmission pinhole' },
        { slug: 'fresnel-equations',     cat: 'beam',    title: 'Fresnel Reflection & Brewster Angle', desc: 's- and p-polarized reflectance vs. angle, Brewster angle, and total internal reflection.', keys: 'fresnel reflectance brewster critical angle snell refraction polarization' },
        { slug: 'glazing-performance',   cat: 'beam',    title: 'Glazing Performance Calculator', desc: 'U-factor, SHGC, visible and solar transmittance, reflectance, and color for single, double, triple, and vacuum glazing with low-e coatings.', keys: 'window glass glazing igu insulating low-e coating u-factor u-value shgc solar heat gain visible transmittance vt argon krypton vacuum vig nfrc lbnl window', featured: true },
        { slug: 'optical-density',       cat: 'beam',    title: 'Optical Density & Attenuation',  desc: 'Convert between OD, transmission, absorbance, and dB, and stack filters.', keys: 'od transmission attenuation neutral density filter db absorbance' },
        // Laser processing
        { slug: 'pulse-energy',          cat: 'process', title: 'Pulse Energy & Peak Power',      desc: 'Interconvert average power, repetition rate, pulse energy, peak power, and duty cycle.', keys: 'pulse energy peak power duty cycle repetition rate average power' },
        { slug: 'fluence',               cat: 'process', title: 'Fluence & Irradiance',           desc: 'Peak and average fluence and irradiance for a Gaussian spot—the parameters that drive ablation.', keys: 'fluence irradiance intensity energy density power density' },
        { slug: 'pulse-overlap',         cat: 'process', title: 'Pulse & Hatch Overlap',          desc: 'Pulse-to-pulse and line-to-line overlap, pulses per spot, and area coverage rate for scanning.', keys: 'overlap scan speed hatch pitch pulses per spot scribing marking' },
        { slug: 'ablation-depth',        cat: 'process', title: 'Ablation Depth & Threshold',     desc: 'Logarithmic ablation model, threshold from crater diameters (Liu method), and incubation.', keys: 'ablation threshold depth liu method incubation penetration depth' },
        { slug: 'lidt',                  cat: 'process', title: 'Damage Threshold (LIDT) Scaling',desc: 'Scale a laser-induced damage threshold to a new pulse duration, wavelength, and beam size.', keys: 'lidt damage threshold optics coating scaling' },
        { slug: 'thermal-diffusion',     cat: 'process', title: 'Thermal Diffusion & Heat Accumulation', desc: 'Thermal diffusion length, heat-affected zone estimates, and the repetition rate where heat builds up.', keys: 'thermal diffusivity diffusion length heat affected zone haz accumulation' },
        // Vacuum
        { slug: 'pressure-converter',    cat: 'vacuum',  title: 'Pressure Unit Converter',        desc: 'Pa, mbar, Torr, mTorr, atm, psi, bar, and inHg, with the vacuum regime for each value.', keys: 'pressure torr mbar pascal atm psi vacuum units' },
        { slug: 'mean-free-path',        cat: 'vacuum',  title: 'Mean Free Path & Gas Kinetics',  desc: 'Mean free path, Knudsen number, flow regime, number density, impingement rate, and monolayer time.', keys: 'mean free path knudsen flow regime molecular viscous number density monolayer' },
        { slug: 'pumpdown',              cat: 'vacuum',  title: 'Conductance & Pump-Down Time',   desc: 'Tube and orifice conductance, effective pumping speed, and pump-down time for a chamber.', keys: 'conductance pumping speed pump down time effective speed tube orifice' },
        // Machine vision
        { slug: 'vision-system-configurator', cat: 'vision', title: 'Vision System Configurator', desc: 'Pick a sensor and lens for your field of view and defect size, see the setup drawn, and check depth of field, motion blur, bandwidth, and lighting.', keys: 'camera sensor lens configurator sony imx onsemi gpixel pregius working distance lighting interface gige usb3 coaxpress', featured: true },
        { slug: 'machine-vision-lens',   cat: 'vision',  title: 'Machine Vision Lens Selection',  desc: 'Magnification, field of view, depth of field, pixel resolution, and smallest detectable defect.', keys: 'fov field of view magnification depth of field focal length sensor resolution camera' },
        { slug: 'motion-blur',           cat: 'vision',  title: 'Motion Blur & Exposure',         desc: 'Maximum exposure or strobe time for a moving part, and line-scan rate for a conveyor.', keys: 'motion blur exposure strobe conveyor line scan speed' },
        // Quality & manufacturing
        { slug: 'process-capability',    cat: 'quality', title: 'Process Capability (Cp, Cpk)',   desc: 'Cp, Cpk, Pp, Ppk, and expected PPM from raw data or summary statistics, with a histogram.', keys: 'cpk ppk cp pp capability spc six sigma ppm specification' },
        { slug: 'control-chart',         cat: 'quality', title: 'Control Chart Limits',           desc: 'X̄–R, X̄–S, and I–MR control limits from your data, with out-of-control points flagged.', keys: 'control chart spc xbar r s individuals moving range ucl lcl western electric' },
        { slug: 'sigma-level',           cat: 'quality', title: 'DPMO, Yield & Sigma Level',      desc: 'Convert between defects per million, yield, and sigma level, and compute rolled throughput yield.', keys: 'dpmo sigma level yield rolled throughput rty six sigma defects' },
        { slug: 'oee-takt',              cat: 'quality', title: 'OEE & Takt Time',                desc: 'Overall equipment effectiveness from availability, performance, and quality, plus takt time.', keys: 'oee takt time cycle time availability performance quality lean' }
    ];

    var ARTICLES = [
        { slug: 'gaussian-beam-optics',     title: 'Gaussian Beam Optics for Engineers',          desc: 'Waist, Rayleigh range, M², and how to choose optics for the spot size you need.', topic: 'Optics', mins: 8 },
        { slug: 'laser-ablation-process-windows', title: 'Laser Ablation Process Windows',       desc: 'Fluence, threshold, incubation, and overlap—how to build a robust ablation process.', topic: 'Laser processing', mins: 10 },
        { slug: 'vacuum-fundamentals',      title: 'Vacuum Fundamentals',                          desc: 'Pressure regimes, gas loads, conductance, and why the pump is rarely the bottleneck.', topic: 'Vacuum', mins: 11 },
        { slug: 'spc-for-laser-processes',  title: 'SPC and Process Capability in Production',     desc: 'Control charts, Cpk, and measurement systems for a high-yield laser process.', topic: 'Quality', mins: 9 },
        { slug: 'laser-sustained-plasma',   title: 'Laser-Sustained Plasma Light Sources',         desc: 'How a focused laser sustains a plasma, and why it makes a bright broadband UV source.', topic: 'Light sources', mins: 10 },
        { slug: 'machine-vision-optics',    title: 'Machine Vision Optics for Inspection',         desc: 'Resolution, contrast, depth of field, and lighting for detecting small defects.', topic: 'Imaging', mins: 8 },
        { slug: 'spectroscopic-units',      title: 'Energy Units in Spectroscopy',                 desc: 'Why spectroscopists use wavenumbers, and how to convert between eV, cm⁻¹, and nm.', topic: 'Spectroscopy', mins: 6 }
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
        '<defs><linearGradient id="bm-g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#6ea8fe"/><stop offset=".5" stop-color="#22d3ee"/><stop offset="1" stop-color="#34d399"/></linearGradient></defs>' +
        '<rect width="32" height="32" rx="7" fill="#0b1220"/>' +
        '<path d="M4 8.5C11 14 21 14 28 8.5M4 23.5C11 18 21 18 28 23.5" fill="none" stroke="url(#bm-g)" stroke-width="2.2" stroke-linecap="round"/>' +
        '<path d="M4 16h24" stroke="#94a3b8" stroke-width="1" stroke-dasharray="1.5 2.5" opacity=".7"/>' +
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
        { href: '/resume/',       label: 'Resume',       section: 'resume' }
    ];

    function renderHeader() {
        var slot = document.getElementById('site-header');
        if (!slot) return;
        var section = document.body.dataset.section || '';
        var links = NAV.map(function (n) {
            var current = n.section === section && n.section !== 'home' ? ' aria-current="page"' : '';
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
        menuBtn.addEventListener('click', function () {
            var open = navLinks.classList.toggle('open');
            menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        navLinks.addEventListener('click', function (e) {
            if (e.target.closest('a')) { navLinks.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); }
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
                '<div><h4>Resources</h4><ul>' +
                  '<li><a href="/tools/">All ' + TOOLS.length + ' tools</a></li>' +
                  '<li><a href="/tools/vision-system-configurator/">Vision system configurator</a></li>' +
                  '<li><a href="/formulas/">Formula reference</a></li>' +
                  '<li><a href="/learn/">Knowledge center</a></li>' +
                '</ul></div>' +
                '<div><h4>About</h4><ul>' +
                  '<li><a href="/#about">About me</a></li>' +
                  '<li><a href="/#work">Selected work</a></li>' +
                  '<li><a href="/publications/">Publications</a></li>' +
                  '<li><a href="/resume/">Resume</a></li>' +
                '</ul></div>' +
                '<div><h4>Contact</h4><ul>' +
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

    /* ── Listings ───────────────────────────────────────────────────────── */
    function toolCard(t) {
        return '<a class="card tool-card" href="/tools/' + t.slug + '/" data-cat="' + t.cat + '" data-search="' +
            esc((t.title + ' ' + t.desc + ' ' + t.keys + ' ' + catTitle(t.cat)).toLowerCase()) + '">' +
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
                '<h2>' + esc(c.title) + ' <span class="count">' + items.length + '</span></h2>' +
                '<div class="grid grid-3">' + items.map(toolCard).join('') + '</div></section>';
        }).join('');
        hub.innerHTML =
            '<div class="tool-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
            '<input type="search" placeholder="Search ' + TOOLS.length + ' calculators — e.g. “Rayleigh”, “Cpk”, “Torr”" aria-label="Search tools" autocomplete="off"></div>' +
            cats + groups + '<p class="empty-state">No tools match that search.</p>';

        var input = hub.querySelector('input[type="search"]');
        var filter = '';
        function apply() {
            var q = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
            var any = false;
            hub.querySelectorAll('.tool-group').forEach(function (g) {
                var shown = 0;
                g.querySelectorAll('.tool-card').forEach(function (card) {
                    var ok = (!filter || card.dataset.cat === filter) &&
                        q.every(function (w) { return card.dataset.search.indexOf(w) !== -1; });
                    card.style.display = ok ? '' : 'none';
                    if (ok) shown++;
                });
                g.style.display = shown ? '' : 'none';
                if (shown) any = true;
            });
            hub.querySelector('.empty-state').style.display = any ? 'none' : 'block';
        }
        input.addEventListener('input', apply);
        hub.querySelectorAll('[data-filter]').forEach(function (b) {
            b.addEventListener('click', function () {
                filter = b.dataset.filter;
                hub.querySelectorAll('[data-filter]').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
                apply();
            });
        });
        var q0 = new URLSearchParams(location.search).get('q');
        if (q0) { input.value = q0; apply(); }
        if (location.hash) {
            var pre = hub.querySelector('[data-filter="' + location.hash.slice(1) + '"]');
            if (pre) pre.click();
        }
    }

    // <div data-tool-cats></div>: one tile per category listing its tools
    function renderToolCats() {
        document.querySelectorAll('[data-tool-cats]').forEach(function (box) {
            box.classList.add('grid', 'grid-3');
            box.innerHTML = CATEGORIES.map(function (c) {
                var items = TOOLS.filter(function (t) { return t.cat === c.id; });
                return '<div class="card cat-card"><h3><a href="/tools/#' + c.id + '">' + esc(c.title) + '</a><span class="count">' + items.length + '</span></h3>' +
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
        theme: currentTheme, renderMath: renderMath
    };
})();
