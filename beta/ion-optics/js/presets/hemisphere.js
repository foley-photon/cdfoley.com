/* ==========================================================================
   Ion optics presets: hemisphere.js
   P6 Hemispherical analyzer for electrons (spec §4.14). Between concentric
   spheres the potential is V(ρ) = A + B/ρ; for a central orbit of radius
   R₀ = 100 mm at pass energy E_p, V(ρ) = 2E_p(R₀/ρ − 1) per unit charge and
   |E(R₀)| = 2E_p/R₀, and electrons leaving a point refocus after 180°
   (Purcell, Phys. Rev. 54, 818 (1938); Kuyatt & Simpson, Rev. Sci.
   Instrum. 38, 103 (1967)). Spheres of radius 75–80 and 120–125 mm, a
   grounded base plane with an annular slit at ρ = 97–103 mm and a 1 mm gap
   below the hemispheres. The energy dispersion at the exit is 2R₀ per unit
   ΔE/E, 2.0 mm per 1 %. The base plane cuts the ideal field off; four
   corrector rings in it, each at the ideal potential of its mid radius,
   restore it (the "Try" of the notes, checked below as CORRECTORS).
   ========================================================================== */
import { newProject } from '../engine/schema.js';

// electron mass in u from CODATA 2022 (m_e / m_u)
const ME_U = 9.1093837139e-31 / 1.66053906892e-27;

// The "Try": widen the slit void to r 80–120 mm (free gaps around the rings), then add four rings in the base plane at
// 2·Ep·(100/r_mid − 1): +36.69, +16.22, −13.95 and −26.84 V. Applied by the preset test as a variant (`set`).
const RINGS = [[81, 88], [89, 96], [104, 111], [112, 119]];
const RING_COLORS = ['#0d9488', '#65a30d', '#b45309', '#be123c'];
const CORRECTORS = Object.freeze({
    shapes: { s4: { y0: 80, y1: 120 } },
    add: {
        electrodes: RINGS.map(([a, b], k) => ({ id: `c${k + 1}`, name: `Corrector ${k + 1}`, kind: 'solid', v: `2*Ep*(100/${(a + b) / 2}-1)`, wave: null, color: RING_COLORS[k] })),
        shapes: RINGS.map(([a, b], k) => ({ id: `r${k + 1}`, type: 'box', electrode: `c${k + 1}`, name: `Corrector ring ${k + 1}`, x0: -2, x1: -1, y0: a, y1: b })),
    },
});

function build() {
    const p = newProject('cyl2d');
    p.meta = {
        ...p.meta, name: 'Hemispherical analyzer', preset: 'hemisphere',
        notes: 'Two concentric hemispheres (radii 75-80 and 120-125 mm) seen in a meridional plane; the axis of revolution is the pole axis x. '
            + 'Electrons of the pass energy Ep follow the central orbit of radius 100 mm: the inner hemisphere is at 2 Ep (100/80 - 1) = +50 V '
            + 'and the outer at 2 Ep (100/120 - 1) = -33.33 V for Ep = 100 eV.\n'
            + 'Fifteen electrons (±1 degree, 99, 100 and 101 eV) enter through the annular slit in the grounded base plane at r = 100 mm, '
            + 'travel over the pole and land on the far side of the axis. Each 1 % of energy moves the landing point by about 2 mm. '
            + 'The base plane cuts off the ideal field of the spheres. Try correcting it: widen the slit (the Void shape) to r = 80-120 mm, then '
            + 'add four corrector rings as later shapes (x from -2 to -1 mm; r 81-88, 89-96, 104-111 and 112-119 mm), each on its own electrode '
            + 'at 2*Ep*(100/rmid-1), that is +36.69, +16.22, -13.95 and -26.84 V: the spread of the ±1 degree fan drops from about 1.4 mm to 0.5 mm.\n'
            + 'The two outermost rays pass close to the slit edges, through grid cells cut by the base plate, where the field is only first-order '
            + 'accurate; the Summary tab flags them with energy errors of 1e-4 to 2e-4 of their energy.',
    };
    p.params = [{ name: 'Ep', value: 100, dim: 'energy', note: 'pass energy of the central orbit (eV per unit charge)', slider: { min: 50, max: 150, step: 0.5 } }];
    p.domain = {
        type: 'cyl2d', cell: 0.5, x: [-6, 130], y: [0, 130],
        edges: { xmin: { bc: 'dirichlet', electrode: 'gnd' }, xmax: { bc: 'dirichlet', electrode: 'gnd' }, ymin: { bc: 'axis' }, ymax: { bc: 'dirichlet', electrode: 'gnd' } },
        mirror: { x: false, y: false }, beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' },
    };
    p.electrodes = [
        { id: 'gnd', name: 'Ground', ground: true, color: '#64748b' },
        { id: 'inner', name: 'Inner hemisphere', kind: 'solid', v: '2*Ep*(100/80-1)', wave: null, color: '#2563eb' },
        { id: 'outer', name: 'Outer hemisphere', kind: 'solid', v: '2*Ep*(100/120-1)', wave: null, color: '#ea580c' },
    ];
    p.shapes = [
        { id: 's1', type: 'annulus', electrode: 'inner', cx: 0, cy: 0, rIn: 75, rOut: 80, a0: 0, a1: 90 },
        { id: 's2', type: 'annulus', electrode: 'outer', cx: 0, cy: 0, rIn: 120, rOut: 125, a0: 0, a1: 90 },
        { id: 's3', type: 'box', electrode: 'gnd', name: 'Base plate', x0: -2, x1: -1, y0: 0, y1: 130 },
        { id: 's4', type: 'box', electrode: null, name: 'Entrance and exit slit', x0: -2, x1: -1, y0: 97, y1: 103 },
    ];
    p.magnets = [];
    p.idealFields = [];
    p.sources = [{
        id: 'b1', name: 'Electrons ±1°, 99–101 eV', enabled: true, color: 'auto', count: 15, sampling: 'grid', seed: 1,
        species: [{ label: 'e⁻', mass: ME_U, charge: -1, fraction: 1 }],
        position: { type: 'point', p: [-3.5, -100, 0] }, direction: { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: -1, to: 1, n: 5 },
        energy: { type: 'list', values: [99, 100, 101] }, time: { type: 'fixed', t: 0 },
    }];
    p.recording = {
        planes: [{ id: 'det', name: 'Detector', kind: 'x', at: -4.5, limits: null, radius: null, terminate: true, side: 'backward', record: 'first' }],
        trajectories: { store: true, maxPoints: 2000 }, timeMarkers: null,
    };
    p.view = { ...p.view, center: [62, 0], scale: 2.4,
        layers: { ...p.view.layers, trajectories: 'energy' } };
    return p;
}

export default Object.freeze({
    id: 'hemisphere',
    title: 'Hemispherical analyzer',
    order: 60,
    domainType: 'cyl2d',
    tags: ['analyzer'],
    blurb: 'Concentric hemispheres sort 99, 100 and 101 eV electrons by energy after a 180° turn.',
    tryThis: 'Widen the slit and add four corrector rings in the base plane (see the project notes): the ±1° spread shrinks from 1.4 to 0.5 mm.',
    build,
    expect: Object.freeze([
        { id: 'landing', label: 'Landing point of the 100 eV central ray', metric: 'planeCoord', plane: 'det', coord: 'y', select: { energy: 100, dir: 'center' },
            target: 100.0, tol: 0.5, unit: 'mm', check: 100.07, measured: 100.0562 },
        { id: 'dispersion', label: 'Energy dispersion (99 → 101 eV central rays, per 1 % of the 100 eV pass energy)', metric: 'dispersion', plane: 'det', coord: 'y',
            a: { energy: 99, dir: 'center' }, b: { energy: 101, dir: 'center' }, eRef: 100, target: 2.0, tol: 0.1, unit: 'mm per 1 %', check: 2.02, measured: 2.019736 },
        { id: 'spread', label: 'Spread of the ±1° fan at 100 eV', metric: 'planeSpread', plane: 'det', coord: 'y', select: { energy: 100 },
            max: 2.0, unit: 'mm', check: 1.38, measured: 1.373887, note: 'Dominated by the uncorrected fringe field at the base plane.' },
        { id: 'passed', label: 'Rays through the exit slit (of 15)', metric: 'detectedCount', plane: 'det', min: 13, check: null, measured: 15 },
        { id: 'corrected', label: 'Spread of the ±1° fan at 100 eV with the four corrector rings of the notes', metric: 'planeSpread', plane: 'det', coord: 'y',
            select: { energy: 100 }, set: CORRECTORS, target: 0.5, tol: 0.1, unit: 'mm', check: 0.504, measured: 0.5064561,
            note: 'Slit void widened to r 80–120 mm, rings at r 81–88, 89–96, 104–111 and 112–119 mm. Without the gaps the rings would touch the grounded plate.' },
    ]),
    guide: null,
});
