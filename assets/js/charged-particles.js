/* ==========================================================================
   cdfoley.com — charged-particles.js
   Shared data for the charged-particle tools (ion time of flight, cyclotron
   radius, plasma parameters). Load after calc.js (both deferred).

   ChargedParticles.SPECIES: preset particles. Atomic and molecular ions carry
   the neutral mass M (u) and their ion mass is M − z·mₑ (electron binding
   energies, at most a few hundred eV here, change it by under 10⁻⁶ u and are
   left out); bare particles carry their own mass m.
   Masses: CODATA 2022 (electron, proton, deuteron, alpha particle; Mohr et al.,
   Rev. Mod. Phys. 97, 025002 (2025)) and AME2020 atomic masses (Wang et al.,
   Chin. Phys. C 45, 030003 (2021)), the same values as the Ion Optics
   Workbench (beta/ion-optics/js/engine/particles.js).

   It also adds the unit dimensions these pages need to Calc.UNITS (each only
   if calc.js does not already define it): voltage, magnetic flux density,
   kinetic energy (SI value in J), number density, and a temperature given as
   an energy (SI value in eV, the plasma convention).
   ========================================================================== */
(function () {
    'use strict';
    var ME_U = 5.485799090441e-4;          // electron mass in u (CODATA 2022)
    var H1 = 1.007825031898, C12 = 12, N14 = 14.003074004251, O16 = 15.994914619257;   // AME2020 atomic masses (u)
    var SPECIES = [
        { id: 'e',    label: 'Electron (e⁻)',               m: ME_U,            z: -1, fixed: true },
        { id: 'p',    label: 'Proton (p, H⁺)',              m: 1.0072764665789, z: 1,  fixed: true },
        { id: 'd',    label: 'Deuteron (d, D⁺)',            m: 2.013553212544,  z: 1,  fixed: true },
        { id: 'a',    label: 'Alpha particle (⁴He²⁺)',      m: 4.001506179129,  z: 2,  fixed: true },
        { id: 'h2',   label: 'H₂⁺',                         M: 2 * H1,          z: 1 },
        { id: 'h3',   label: 'H₃⁺',                         M: 3 * H1,          z: 1 },
        { id: 'he',   label: 'Helium ion (⁴He⁺)',           M: 4.00260325413,   z: 1 },
        { id: 'c',    label: 'Carbon ion (¹²C⁺)',           M: C12,             z: 1 },
        { id: 'n',    label: 'Nitrogen ion (¹⁴N⁺)',         M: N14,             z: 1 },
        { id: 'o',    label: 'Oxygen ion (¹⁶O⁺)',           M: O16,             z: 1 },
        { id: 'h2o',  label: 'Water ion (H₂¹⁶O⁺)',          M: 2 * H1 + O16,    z: 1 },
        { id: 'n2',   label: 'Nitrogen molecular ion (¹⁴N₂⁺)', M: 2 * N14,      z: 1 },
        { id: 'o2',   label: 'Oxygen molecular ion (¹⁶O₂⁺)',  M: 2 * O16,       z: 1 },
        { id: 'ar',   label: 'Argon ion (⁴⁰Ar⁺)',           M: 39.96238312204,  z: 1 },
        { id: 'co2',  label: 'Carbon dioxide ion (¹²C¹⁶O₂⁺)', M: C12 + 2 * O16, z: 1 },
        { id: 'ga',   label: 'Gallium ion (⁶⁹Ga⁺)',         M: 68.9255735,      z: 1 },
        { id: 'kr',   label: 'Krypton ion (⁸⁴Kr⁺)',         M: 83.91149772708,  z: 1 },
        { id: 'xe',   label: 'Xenon ion (¹³²Xe⁺)',          M: 131.90415508346, z: 1 },
        { id: 'cs',   label: 'Cesium ion (¹³³Cs⁺)',         M: 132.905451958,   z: 1 },
        { id: 'c60',  label: 'Fullerene ion (¹²C₆₀⁺)',      M: 60 * C12,        z: 1 }
    ];
    var BY_ID = {};
    SPECIES.forEach(function (s) { BY_ID[s.id] = s; });

    // the mass (u) of a preset with charge number z: a bare particle keeps its own mass, an ion loses z electrons
    function massOf(id, z) {
        var s = BY_ID[id];
        if (!s) return NaN;
        return s.m !== undefined ? s.m : s.M - z * ME_U;
    }
    // <option> list for a species select; skip: ids to leave out (the plasma page has no use for the electron as an ion)
    function options(selected, skip) {
        return SPECIES.filter(function (s) { return !skip || skip.indexOf(s.id) === -1; }).map(function (s) {
            return '<option value="' + s.id + '"' + (s.id === selected ? ' selected' : '') + '>' + s.label + '</option>';
        }).join('') + '<option value="custom">Custom (enter mass and charge)</option>';
    }

    // Wire a species select to mass and charge inputs: picking a preset fills both; changing the charge of an atomic
    // or molecular preset updates its mass (one electron mass per charge); editing the mass, or the charge of a bare
    // particle, switches the select to Custom.
    function bind(sel, massIn, zIn) {
        var close = function (a, b) { return Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(b)); };
        sel.addEventListener('change', function () {
            var s = BY_ID[sel.value];
            if (!s) return;
            zIn.value = s.z;
            massIn.value = Calc.fmt.plain(massOf(s.id, s.z), 12);
        });
        zIn.addEventListener('input', function () {
            var s = BY_ID[sel.value], z = Calc.parseNum(zIn.value);
            if (!s) return;
            if (s.fixed) { if (z !== s.z) sel.value = 'custom'; return; }
            if (isFinite(z) && z !== 0) massIn.value = Calc.fmt.plain(massOf(s.id, z), 12);
        });
        massIn.addEventListener('input', function () {
            var s = BY_ID[sel.value];
            if (s && !close(Calc.parseNum(massIn.value), massOf(s.id, Calc.parseNum(zIn.value)))) sel.value = 'custom';
        });
    }

    var DIMS = {
        voltage:  { 'mV': 1e-3, 'V': 1, 'kV': 1e3, 'MV': 1e6 },
        bfield:   { 'µT': 1e-6, 'mT': 1e-3, 'T': 1, 'G': 1e-4, 'kG': 0.1 },
        kenergy:  { 'meV': 1.602176634e-22, 'eV': 1.602176634e-19, 'keV': 1.602176634e-16, 'MeV': 1.602176634e-13, 'GeV': 1.602176634e-10 },
        ndensity: { 'cm⁻³': 1e6, 'm⁻³': 1 },
        tempev:   { 'eV': 1, 'K': 1.380649e-23 / 1.602176634e-19 }
    };
    if (window.Calc) Object.keys(DIMS).forEach(function (k) { if (!Calc.UNITS[k]) Calc.UNITS[k] = DIMS[k]; });

    window.ChargedParticles = { SPECIES: SPECIES, ME_U: ME_U, massOf: massOf, options: options, bind: bind, byId: BY_ID };
})();
