/* ==========================================================================
   Ion optics engine: bench/targets.js
   Reference values of the validation suite (specification §5) with their
   open-literature sources. Values keep their printed precision (strings
   where the tolerance is "half a unit in the last printed digit").
   calibration.observed holds the deviations measured in the design-phase
   time-domain calibration (§5.5) and, after integration, on this engine.

   Sources: CODATA 2022 (NIST); Natali, DiChio, Uva & Kuyatt, J. Res. NBS
   76A, 27 (1972); DiChio, Natali & Kuyatt, Rev. Sci. Instrum. 45, 559
   (1974); Adams & Read, J. Phys. E 5, 150 (1972) and Harting & Read,
   Electrostatic Lenses (1976), both as tabulated by Gillespie & Brown;
   Hughes & Rojansky, Phys. Rev. 34, 284 (1929); Purcell, Phys. Rev. 54, 818
   (1938); Wiley & McLaren, Rev. Sci. Instrum. 26, 1150 (1955); Mamyrin et
   al., Sov. Phys. JETP 37, 45 (1973); Paul, Rev. Mod. Phys. 62, 531 (1990);
   Simpson, Lane, Immer & Youngquist, NASA (2001); Davisson & Calbick, Phys.
   Rev. 42, 580 (1932); Langmuir, Phys. Rev. 2, 450 (1913).
   ========================================================================== */

const CODATA = { text: 'CODATA 2022 recommended values (NIST); closed-form kinematics', url: 'https://physics.nist.gov/cuu/Constants/' };
const NBS1972 = { text: 'Natali, DiChio, Uva & Kuyatt, J. Res. NBS 76A, 27 (1972), Table 2', url: 'https://nvlpubs.nist.gov/nistpubs/jres/76A/jresv76An1p27_A1b.pdf' };
const DNK1974 = { text: 'DiChio, Natali & Kuyatt, Rev. Sci. Instrum. 45, 559 (1974), Table I', url: 'https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=620059' };

/** Reference values by case id: { values, units, source: { text, url }, note, calibration: { level, observed: { quick, full }, design } }. */
export const TARGETS = Object.freeze({
    K1: {
        values: { tRest: '0.455286', vRest: '43.9284', t10: '0.412028' }, units: { tRest: 'µs', vRest: 'mm/µs', t10: 'µs' },
        source: CODATA, note: 't = √(2dm/(qE)) for 100 u, +1 e across 10 mm and 1000 V; 10 eV start along the field.',
        calibration: { level: 'integration', observed: { quick: 2.6e-5, full: 2.6e-5 }, design: { tRest: 6e-11 } },
    },
    K2: {
        values: { m1: '2.28532', m28: '12.04574', m100: '22.7643', m1000: '71.98705' }, units: { m1: 'µs', m28: 'µs', m100: 'µs', m1000: 'µs' },
        source: CODATA, note: 'Field-free drift of 1 m at 1000 eV, t = L/√(2KE/m), masses 1.00782503207, 28, 100, 1000 u.',
        calibration: { level: 'integration', observed: { quick: -3.7e-6, full: -3.7e-6 }, design: null },
    },
    K3: {
        values: { rA: '91.0572', fA: '76.7806', rB: '33.7213', fB: '27.99249', rC: '33.7229', fC: '27.98701' },
        units: { rA: 'mm', fA: 'kHz', rB: 'mm', fB: 'MHz', rC: 'mm', fC: 'MHz' },
        source: { text: 'Cyclotron radius and frequency r = γmv/(|q|B), f = |q|B/(2πγm) (CODATA 2022); signed relativistic Boris rotation: Zenitani & Umeda, Phys. Plasmas 25, 112110 (2018)', url: 'https://doi.org/10.1063/1.5051077' },
        note: '(a) 100 u, 1 keV, 0.5 T; (b) electron 100 eV, 1 mT, nonrelativistic; (c) the same, relativistic. Boris at 128 steps per gyration: |r/r_ref − 1| ≤ 2.5e-4 and step positions on the circle of radius r·(θ/2)/sin(θ/2).',
        calibration: { level: 'integration', observed: { quick: 4.9e-5, full: 4.9e-5 }, design: { boris: 1.0e-4 } },
    },
    K4: {
        values: { ion: -1, electron: 1 }, units: { ion: 'y_c/r', electron: 'y_c/r' },
        source: { text: 'Lorentz force F = q v × B: for B = +z and motion along +x a positive ion turns toward −y', url: 'https://doi.org/10.1063/1.5051077' },
        note: 'Center of gyration at (0, −r) for an ion and (0, +r) for an electron, with Dormand–Prince and Boris.',
        calibration: { level: 'integration', observed: { quick: 5.6e-9, full: 5.6e-9 }, design: null },
    },
    K5: {
        values: { angle: 180 }, units: { angle: '°' }, source: CODATA,
        note: 'First-order focus of a homogeneous magnetic field after 180° (0.5 T, 100 u, 1 keV, ±1 mrad, rtol 1e-11).',
        calibration: { level: 'integration', observed: { quick: 0, full: 0 }, design: { angle: 1e-5 } },
    },
    K6: {
        values: { l90: '100.000', l60: '173.205' }, units: { l90: 'mm', l60: 'mm' },
        source: { text: 'Symmetric sector-field imaging (Barber\'s rule) l = l′ = r/tan(φ/2) for normal entry and exit; H. Wollnik, Optics of Charged Particles (Academic Press, 1987), sector-field imaging', url: 'https://shop.elsevier.com/books/optics-of-charged-particles/wollnik/978-0-12-762130-2' },
        note: 'Hard-edged annular sector r 50–150 mm, B = −0.455286 T ẑ (r = 100 mm for 100 u at 1 keV), φ = 90° and 60°; no accepted step may change the region signature.',
        calibration: { level: 'integration', observed: { quick: 4.6e-7, full: 4.6e-7 }, design: { l90: 2e-4 } },
    },
    K7: {
        values: { m10: '76.780588', m100: '7.678059', m1000: '0.767806' }, units: { m10: 'mm', m100: 'mm', m1000: 'mm' },
        source: CODATA, note: 'E(t) = E₀ sin Ωt, E₀ = 100 V/mm, 1 MHz, at rest at t = 0: x = (qE₀/(mΩ²))(Ωt − sin Ωt) at t = 0.5 µs.',
        calibration: { level: 'integration', observed: { quick: -3.6e-7, full: -3.6e-7 }, design: null },
    },
    K8: {
        values: {}, units: { x: 'mm' }, source: CODATA,
        note: 'Trapezoidal pulse 2100 V on a 210 mm capacitor (t0 0.2, rise 0.1, width 10, fall 0.1 µs); position at 1.0 µs from the exact piecewise integral.',
        calibration: { level: 'integration', observed: { quick: 7.8e-13, full: 7.8e-13 }, design: { x: 1e-9 } },
    },
    K9: {
        values: { gamma: '2.000000', beta: '0.866025', r: '29.523' }, units: { gamma: '', beta: '', r: 'mm' },
        source: CODATA, note: 'Electron with kinetic energy mₑc² (γ = 2) in 0.1 T, relativistic.',
        calibration: { level: 'integration', observed: { quick: 4e-7, full: 4e-7 }, design: null },
    },
    S1: {
        values: { 12.5: '67.807191', 15: '41.503750', 17.5: '19.264508', E15: '9.617967' }, units: { V: 'V', E: 'V/mm' },
        source: { text: 'Coaxial cylinders a = 10 mm (100 V), b = 20 mm (0 V): V = Va + (Vb − Va)ln(r/a)/ln(b/a)', url: 'http://hyperphysics.phy-astr.gsu.edu/hbase/electric/capcyl.html' },
        note: 'Planar quarter domain with mirrors; potential at r = 12.5, 15, 17.5 mm (0°, 30°, 45°) and |E(15 mm)|.',
        calibration: { level: 'integration', observed: { quick: -0.00097, full: -0.00025 }, design: { quickV: 9.7e-4, fullV: 2.5e-4, quickE: 1.1e-5, fullE: 2.8e-6 } },
    },
    S2: {
        values: { 90: '222.222222', 100: '0.000000', 110: '-181.818182', E100: '20' }, units: { V: 'V', E: 'V/mm' },
        source: { text: 'Concentric spheres R1 = 80 mm (+500 V), R2 = 120 mm (−333.333 V): V = 200000/r − 2000', url: 'http://hyperphysics.phy-astr.gsu.edu/hbase/electric/capsph.html' },
        note: 'Cylindrical domain mirrored at x = 0; polar angles 10°, 45°, 80°.',
        calibration: { level: 'integration', observed: { quick: 0.012, full: 0.0029 }, design: { quickV: 1.2e-2, fullV: 3.0e-3, quickE: 1.3e-5, fullE: 3.5e-6 } },
    },
    S3: {
        values: { 0.1: '0.370599', 0.2: '0.258334', 0.3: '0.171921', 0.4: '0.110938', 0.5: '0.070253', 0.6: '0.044009', 0.8: '0.017006', 1.0: '0.006520', 1.5: '0.000589', 2.0: '0.000053' },
        units: { V: 'V/V' }, source: NBS1972,
        note: 'Two zero-gap tubes (0 V | 1 V), axial potential at z/D into the 0 V tube; the table equals the Bessel series S = 1 − Σ exp(−jₙζ)/(jₙJ₁(jₙ)).',
        calibration: { level: 'integration', observed: { quick: -4.6e-5, full: -1.1e-5 }, design: { quick: 4.7e-5, full: 1.2e-5 } },
    },
    S4: {
        values: { 0.1: '0.371399', 0.2: '0.259528', 0.3: '0.173079', 0.4: '0.111851', 0.5: '0.070897', 0.6: '0.044436', 0.8: '0.017178', 1.0: '0.006586' },
        units: { V: 'V/V' }, source: NBS1972,
        note: 'Two tubes with a 0.1D deep gap (the NBS geometry, closed by a linear ramp at r = 3.5R).',
        calibration: { level: 'integration', observed: { quick: -6.4e-5, full: 7e-5 }, design: { quick: 6.4e-5, full: 7.0e-5 } },
    },
    S5: {
        values: { p: 2 }, units: { p: '' },
        source: { text: 'Second-order convergence of Shortley–Weller differences (Shortley & Weller, J. Appl. Phys. 9, 334 (1938))', url: 'https://doi.org/10.1063/1.1710426' },
        note: 'Axial error of the zero-gap einzel lens (A/D 0.5, ratio 9) against the exact series, R = 20, 40 (80) cells.',
        calibration: { level: 'integration', observed: { quick: -0.0052, full: -0.0052 }, design: { p: 1.99 } },
    },
    S6: {
        values: { err: 0 }, units: { err: 'V' },
        source: { text: 'Shortley–Weller stencils reproduce harmonic quadratics exactly (Shortley & Weller, J. Appl. Phys. 9, 334 (1938))', url: 'https://doi.org/10.1063/1.1710426' },
        note: 'Boundary values from 1 + 0.3x − 0.2y + 0.05(x² − y²) + 0.02xy (planar) and 1 + 0.3x + 0.05(x² − ρ²/2) (cylindrical), solver tolerance 1e-12.',
        calibration: { level: 'integration', observed: { quick: 1.3e-11, full: 1.3e-11 }, design: { planar: 3.5e-12, cyl: 1.7e-12 } },
    },
    S7: {
        values: { err: 0 }, units: { err: 'V/V' },
        source: { text: 'Linearity of Laplace\'s equation (superposition of unit-voltage basis fields)', url: 'https://doi.org/10.1137/1.9780898719505' },
        note: 'Three-electrode thin-wall einzel lens with a ramp edge; random voltages; direct solve at tolerance 1e-12.',
        calibration: { level: 'integration', observed: { quick: 5.5e-13, full: 5.5e-13 }, design: { err: 2.6e-13 } },
    },
    S8: {
        values: { err: 0 }, units: { err: 'V/V' },
        source: { text: 'Multigrid, MG-preconditioned BiCGSTAB and adaptive SOR solve the same discrete system (Briggs, Henson & McCormick, A Multigrid Tutorial (2000); van der Vorst, SIAM J. Sci. Stat. Comput. 13, 631 (1992))', url: 'https://doi.org/10.1137/1.9780898719505' },
        note: 'Forced methods on a thin-wall einzel lens and a thin-plate two-aperture lens.',
        calibration: { level: 'integration', observed: { quick: 8.9e-11, full: 8.9e-11 }, design: { einzel: 4.3e-11, aperture: 3.3e-11 } },
    },
    S9: {
        values: { rho: 0.35 }, units: { rho: '/cycle' },
        source: { text: 'Geometric multigrid with exact interval painting on every level (Trottenberg, Oosterlee & Schüller, Multigrid (2001))', url: 'https://doi.org/10.1137/1.9780898719505' },
        note: '404 × 98 two-aperture fixture: plates 0.3 cell thick between nodes and 1 cell off the coarse lattice; far edges off-lattice.',
        calibration: { level: 'integration', observed: { quick: 4.7e-11, full: 4.7e-11 }, design: { rho: 0.251 } },
    },
    S10: {
        values: { p: 2 }, units: { p: '' },
        source: { text: 'Shortley & Weller, J. Appl. Phys. 9, 334 (1938): second order on curved boundaries; staircase first order', url: 'https://doi.org/10.1063/1.1710426' },
        note: 'Concentric spheres with the inner radius resolved by 20, 40 (80) cells.',
        calibration: { level: 'integration', observed: { quick: -0.056, full: -0.056 }, design: { p: 1.97 } },
    },
    T1: {
        values: { r30: '34.641', r45: '40.000', r60: '34.641', depth: '10.000' }, units: { r: 'mm' },
        source: { text: 'Parallel-plate mirror: range L = 2d(KE/qV)sin 2θ, depth d(KE/qV)sin²θ (closed form: uniform deceleration, no external reference needed)', url: null },
        note: 'Entry through a node-aligned mesh, 20 mm gap, +1000 V back plate, 1000 eV, 30°/45°/60°.',
        calibration: { level: 'integration', observed: { quick: 1.8e-5, full: 1.8e-5 }, design: { range: 1.7e-6 } },
    },
    T2: {
        values: { ke: 500 }, units: { ke: 'eV' },
        source: { text: 'Energy gain q·ΔV across a uniform gap (500 eV from rest 5 mm before the exit mesh of a 600 V, 6 mm gap; closed form: work–energy theorem, no external reference needed)', url: null },
        note: 'Mesh (a) on a node column and (b) zero-thickness between nodes.',
        calibration: { level: 'integration', observed: { quick: 9.1e-9, full: 9.1e-9 }, design: { a: 9.1e-9, b: 9.2e-9 } },
    },
    T3: {
        values: { d: 0 }, units: { d: '' },
        source: { text: 'Wiley & McLaren, Rev. Sci. Instrum. 26, 1150 (1955): space focus at a drift of 2s₀ for a single-field source', url: 'https://doi.org/10.1063/1.1715212' },
        note: '100 V/mm, mesh exit, s₀ = 5 mm (1 ± 1e-3), detector 2s₀ after the mesh; ∂lnT/∂lns at s₀.',
        calibration: { level: 'integration', observed: { quick: -1.5e-7, full: -1.5e-7 }, design: null },
    },
    T4: {
        values: { d: 0 }, units: { d: '' },
        source: { text: 'Mamyrin et al., Sov. Phys. JETP 37, 45 (1973): first-order energy focus of a single-stage reflectron at L = 4·d_pen', url: 'http://www.jetp.ras.ru/cgi-bin/e/index/e/37/1/p45?a=list' },
        note: 'Drift 0–100 mm, mesh at 100 mm, uniform mirror 100–300 mm (4000 V back plate: d_pen 50 mm, L 200 mm), KE 1000(1 ± 1e-3) eV.',
        calibration: { level: 'integration', observed: { quick: -1.4e-7, full: -1.4e-7 }, design: null },
    },
    T5: {
        values: { dE: 0 }, units: { dE: '' },
        source: { text: 'Energy conservation in a static field; C¹ Hermite potential makes the force conservative (Hairer, Nørsett & Wanner, Solving ODEs I)', url: 'https://doi.org/10.1007/978-3-540-78862-1' },
        note: 'Zero-gap einzel lens, A/D 0.5, ratio 9, R = 40 cells; meridional rays r₀ 0.05–0.5R and two skew rays.',
        calibration: { level: 'integration', observed: { quick: 8.8e-8, full: 8.8e-8 }, design: { dE: 4.5e-7 } },
    },
    T6: {
        values: { dr: 0 }, units: { dr: 'R' },
        source: { text: 'Time reversibility of motion in a static electric field', url: 'https://doi.org/10.1007/978-3-540-78862-1' },
        note: 'Same lens, rtol 1e-12, trajectories reversed at the exit and traced back to the start plane.',
        calibration: { level: 'integration', observed: { quick: 1.5e-9, full: 1.5e-9 }, design: { dr: 2.5e-8 } },
    },
    T7: {
        values: { angle: 127.279 }, units: { angle: '°', dr: 'mm' },
        source: { text: 'Hughes & Rojansky, Phys. Rev. 34, 284 (1929): cylindrical analyzer focus at π/√2 = 127.279°', url: 'https://doi.org/10.1103/PhysRev.34.284' },
        note: 'S1 field; q −1, 1 u, 72.1348 eV at r₀ = 15 mm, nonrelativistic, rtol 1e-11, ±1 mrad.',
        calibration: { level: 'integration', observed: { quick: 0.00019, full: 4.8e-5 }, design: { quick: 1e-4, full: 0, drQuick: 1.9e-4, drFull: 4.7e-5 } },
    },
    T8: {
        values: { angle: 180 }, units: { angle: '°', dr: 'mm' },
        source: { text: 'Purcell, Phys. Rev. 54, 818 (1938): spherical analyzer focus at 180°', url: 'https://doi.org/10.1103/PhysRev.54.818' },
        note: 'S2 field; q −1, 1 u, 1000 eV at r₀ = 100 mm from (0, 100) along +x, ±1 mrad.',
        calibration: { level: 'integration', observed: { quick: -0.01, full: -0.0025 }, design: { quick: -0.0104, full: -0.0025, drQuick: 1.2e-3, drFull: 3.1e-4 } },
    },
    T9: {
        values: {}, units: { beta: '' },
        source: { text: 'Floquet theory of the Mathieu equation (NIST DLMF §28.2, §28.29); quadrupole: Paul, Rev. Mod. Phys. 62, 531 (1990)', url: 'https://dlmf.nist.gov/28.29' },
        note: 'Solved hyperbolic-rod quadrupole (r₀ 4 mm), RF only at 1.1 MHz, 100 u; β from the stroboscopic recurrence against β(q·A₂).',
        calibration: { level: 'integration', observed: { quick: 9e-10, full: 3.2e-11 }, design: { beta: 1e-11 } },
    },
    T10: {
        values: {}, units: {},
        source: { text: 'Edge of the first stability region at q = 0.908 (a = 0) (NIST DLMF §28.17)', url: 'https://dlmf.nist.gov/28.17' },
        note: 'Solved quadrupole, 0.05r₀ at rest, 16 RF phases, 200 cycles: q 0.89 bounded below 0.9r₀, q 0.93 lost.',
        calibration: { level: 'integration', observed: { quick: 0, full: 0 }, design: { q089: 11.6 } },
    },
    T11: {
        values: { Vq: '179.826', U: '23.467', V: '139.813' }, units: { U: 'V', V: 'V' },
        source: { text: 'Quadrupole mass filter stability diagram, apex (0.706, 0.23699), q* = 0.908046 (Paul, Rev. Mod. Phys. 62, 531 (1990); NIST DLMF §28.17)', url: 'https://doi.org/10.1103/RevModPhys.62.531' },
        note: 'Ideal quadrupole field; (a, q) = (0.230, 0.706) stable and (0.244, 0.706) unstable over 200 cycles; m/z 100, r₀ 4 mm, 1.1 MHz.',
        calibration: { level: 'integration', observed: { quick: -0.00047, full: -0.00047 }, design: null },
    },
    T12: {
        values: { lmco: '107.7' }, units: { lmco: 'u' },
        source: { text: 'Paul-trap low-mass cut-off |q_z| = 0.908 (Paul, Rev. Mod. Phys. 62, 531 (1990))', url: 'https://doi.org/10.1103/RevModPhys.62.531' },
        note: 'Solved hyperbolic trap (r₀ 7.07, z₀ 5 mm), ring 500 V at 1 MHz; m 120 trapped, m 100 lost over 200 cycles.',
        calibration: { level: 'integration', observed: { quick: -0.024, full: -0.024 }, design: { m120: 5.15 } },
    },
    T13: {
        values: { helmholtz: '0.899176', loop: '4.49588' }, units: { helmholtz: 'mT', loop: 'µT' },
        source: { text: 'Simpson, Lane, Immer & Youngquist, Simple analytic expressions for the magnetic field of a circular current loop (NASA, 2001)', url: 'https://ntrs.nasa.gov/citations/20010038494' },
        note: 'Helmholtz pair N 100, 1 A, R 100 mm at x = ±50 mm: B at the center; one loop: B on the axis 50 mm from its center.',
        calibration: { level: 'integration', observed: { quick: 2.9e-7, full: 2.9e-7 }, design: { helmholtz: 1e-9 } },
    },
    T14: {
        values: {}, units: {},
        source: { text: 'Counter-based random numbers make every particle independent of batching (Salmon et al., SC11 (2011))', url: 'https://doi.org/10.1145/2063384.2063405' },
        note: 'Velocity-map-imaging lens; traced in chunks of 1, 7 and 64 particles and merged: identical bits.',
        calibration: { level: 'integration', observed: { quick: 0, full: 0 }, design: null },
    },
    T15: {
        values: { a: 0 }, units: { a: 'mm' },
        source: { text: 'Exact ray–surface intersection (dense-output sub-chords and bisection; Hairer, Nørsett & Wanner, Solving ODEs I)', url: 'https://doi.org/10.1007/978-3-540-78862-1' },
        note: '(a) ray onto a plate inclined at 30°; (b) a 0.2-cell plate at 45°, 100 random rays; (c) a zero-thickness line, 10⁴ rays.',
        calibration: { level: 'integration', observed: { quick: 2.1e-10, full: 2.1e-10 }, design: { a: 1e-10 } },
    },
    L1: {
        values: { 2: { F1: -13.0527, F2: 12.9229, f1: -10.923, f2: 15.4474 }, 5: { F1: -2.7531, F2: 2.4512, f1: -1.7473, f2: 3.9071 },
            10: { F1: -1.6066, F2: 1.1737, f1: -0.7952, f2: 2.5147 }, 20: { F1: -1.1939, F2: 0.6295, f1: -0.4528, f2: 2.0249 } },
        units: { F: 'D' },
        source: { text: 'Exact paraxial properties of two zero-gap tubes from the Bessel-series axial potential (our exact.js; Natali et al., J. Res. NBS 76A, 27 (1972))', url: NBS1972.url },
        note: 'Two zero-gap thin-wall tubes; lens tool with T² + T⁴ fits; ratios 2, 5, 10, 20; R = 32 (64) cells.',
        calibration: { level: 'integration', observed: { quick: 0.00033, full: 9e-5 }, design: { quick: 3.4e-4, full: 9.0e-5, idQuick: 7.5e-5, idFull: 6.5e-6 } },
    },
    L2: {
        values: { '-0.5': 0.6061, 0: 2.7724, 0.8: 139.2295, 2: 11.0939, 9: 1.3015 }, units: { f: 'D' },
        source: { text: 'Exact paraxial focal length of the zero-gap einzel lens, A/D 0.5 (Bessel-series potential; our exact.js)', url: NBS1972.url },
        note: 'Three-segment wall profile; R = 40 (80) cells.',
        calibration: { level: 'integration', observed: { quick: 0.00021, full: 5.2e-5 }, design: { quick: 2.1e-4, full: 5.2e-5 } },
    },
    L3: {
        values: {
            2: { F1: -13.133, F2: 13.006, f1: -10.992, f2: 15.544, H1: -2.1412, H2: -2.5384 },
            5: { F1: -2.7683, F2: 2.4659, f1: -1.7573, f2: 3.9296, H1: -1.0109, H2: -1.4637 },
            10: { F1: -1.6146, F2: 1.18, f1: -0.79931, f2: 2.5276, H1: -0.8153, H2: -1.3477 },
            20: { F1: -1.1994, F2: 0.6322, f1: -0.45479, f2: 2.0339, H1: -0.74466, H2: -1.4017 },
            40: { F1: -1.021, F2: 0.32085, f1: -0.2988, f2: 1.8898, H1: -0.72223, H2: -1.569 },
            100: { F1: -0.91711, F2: 0.041104, f1: -0.20163, f2: 2.0163, H1: -0.71547, H2: -1.9752 },
        },
        units: { F: 'D' }, source: DNK1974,
        note: 'Two tubes with a 0.1D gap in the NBS deep-gap geometry; tolerance max(0.35%·|ref|, 0.003 D).',
        calibration: { level: 'integration', observed: { quick: -0.002, full: -0.0018 }, design: { quick: 0.00211, full: 0.0019, smallestMargin: 2.0 } },
    },
    L4: {
        values: { id: 0 }, units: { id: '' }, source: DNK1974,
        note: 'Lagrange–Helmholtz identity |f1/f2|·√(V2/V1) − 1 on the L3 rays (the paper states |f2/f1| = √(V2/V1) to < 0.003%).',
        calibration: { level: 'integration', observed: { quick: 5.5e-5, full: 2.1e-5 }, design: { quick: 4.6e-5, full: 1.4e-4 } },
    },
    L5: {
        values: { '-0.5': 0.628, 0: 2.843, 0.8: 141.752, 2: 11.261, 9: 1.312 }, units: { f: 'D' },
        source: { text: 'Adams & Read, J. Phys. E 5, 150 (1972), as tabulated by Gillespie & Brown, PAC\'97 paper 8P084, Table 1', url: 'https://epaper.kek.jp/pac97/papers/pdf/8P084.PDF' },
        note: 'Informational: geometry assumed (A/D 0.5, G/D 0.1, linear-ramp gaps); band ±2%.',
        calibration: { level: 'integration', observed: { quick: -0.014, full: -0.014 }, design: { range: [-0.012, -0.0026] } },
    },
    L6: {
        values: { 0.5: { 0.5: 13.41, 2: 18.96, 10: 3.2, 40: 2.54, 90: 2.79 }, 1.0: { 0.5: 15.95, 2: 22.55, 10: 3.59, 40: 2.68, 90: 2.83 } }, units: { f: 'D' },
        source: { text: 'Harting & Read, Electrostatic Lenses (1976), as tabulated by Gillespie & Brown, UCRL-JC-130384 (1998), Table 1', url: 'https://www.osti.gov/biblio/293605' },
        note: 'Informational: zero-thickness apertures with a ramp closure at 5D run +3 to +6% above the table (a model difference that grows with resolution).',
        calibration: { level: 'integration', observed: { quick: 0.042, full: 0.053 }, design: { range: [0.033, 0.058] } },
    },
    L7: {
        values: { f: 80 }, units: { f: 'mm' },
        source: { text: 'Davisson & Calbick, Phys. Rev. 42, 580 (1932): thin aperture f = 4V/(E2 − E1)', url: 'https://doi.org/10.1103/PhysRev.42.580' },
        note: 'Informational: 1 mm hole between a field-free region and a 50 V/mm accelerating field, 1000 eV (f = 80 mm); band ±10%.',
        calibration: { level: 'integration', observed: { quick: 0.02, full: 0.02 }, design: null },
    },
    P1: {
        values: { J: 738.06 }, units: { J: 'A/m²' },
        source: { text: 'Langmuir, Phys. Rev. 2, 450 (1913): Child–Langmuir space-charge-limited current', url: 'https://doi.org/10.1103/PhysRev.2.450' },
        note: 'Planned: needs a Poisson solver (space charge).', calibration: { level: 'planned', observed: null },
    },
    P2: {
        values: { each: 0.719982 }, units: { each: 'meV' }, source: CODATA,
        note: 'Planned: two protons released from rest 1 µm apart (direct Coulomb interaction).', calibration: { level: 'planned', observed: null },
    },
    P3: {
        values: {}, units: {}, source: { text: 'Coaxial cylinders and concentric spheres in three dimensions', url: 'http://hyperphysics.phy-astr.gsu.edu/hbase/electric/capcyl.html' },
        note: 'Planned for the 3D solver (Phase 2).', calibration: { level: 'planned', observed: null },
    },
    P4: {
        values: { coax: 80.2607, sphere: 26.7036 }, units: { coax: 'pF/m', sphere: 'pF' }, source: CODATA,
        note: 'Planned: capacitance by Gauss flux (coax a 10, b 20 mm; spheres 80/120 mm).', calibration: { level: 'planned', observed: null },
    },
});

/** Short citations for compact tables (the full text and link are in TARGETS[id].source). */
export const SHORT_REFS = Object.freeze({
    K1: 'CODATA 2022', K2: 'CODATA 2022', K3: 'CODATA 2022; Zenitani & Umeda 2018', K4: 'Lorentz force', K5: 'Homogeneous-field focus', K6: 'Barber’s rule', K7: 'CODATA 2022',
    K8: 'Exact integral', K9: 'CODATA 2022', S1: 'Coaxial capacitor', S2: 'Spherical capacitor', S3: 'NBS 1972, Table 2', S4: 'NBS 1972, Table 2', S5: 'Shortley & Weller 1938',
    S6: 'Shortley & Weller 1938', S7: 'Superposition', S8: 'Briggs et al. 2000', S9: 'Briggs et al. 2000', S10: 'Shortley & Weller 1938', T1: 'Mirror range (closed form)',
    T2: 'Energy gain qΔV', T3: 'Wiley & McLaren 1955', T4: 'Mamyrin et al. 1973', T5: 'Energy conservation', T6: 'Time reversal', T7: 'Hughes & Rojansky 1929', T8: 'Purcell 1938',
    T9: 'NIST DLMF §28.29', T10: 'NIST DLMF §28.17', T11: 'Paul 1990', T12: 'Paul 1990', T13: 'Simpson et al. 2001', T14: 'Salmon et al. 2011', T15: 'Exact intersection',
    L1: 'Exact (Bessel series)', L2: 'Exact (Bessel series)', L3: 'DiChio et al. 1974', L4: 'DiChio et al. 1974', L5: 'Adams & Read 1972', L6: 'Harting & Read 1976',
    L7: 'Davisson & Calbick 1932', P1: 'Langmuir 1913', P2: 'CODATA 2022', P3: 'Closed form', P4: 'CODATA 2022',
});
