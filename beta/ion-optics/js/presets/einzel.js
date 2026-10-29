/* ==========================================================================
   Ion optics presets: einzel.js
   P1 Einzel lens, the default project (spec §2.2.1, §4.14). Three coaxial
   tubes of inner diameter D = 20 mm with gaps of 0.1 D and a center tube of
   length 0.5 D (generic dimensions of our own choosing); outer tubes at 0 V,
   center tube at Vc = +850 V; a parallel beam of 21 rays of m/z 100 at
   1000 eV. Three-element cylinder lenses of this kind are tabulated by
   Adams & Read, J. Phys. E 5, 150 (1972); the spherical aberration that puts
   the waist before the paraxial focus is discussed by Harting & Read,
   Electrostatic Lenses (1976).
   Expectations come from the design-phase checks (spec §4.14, §5.5) and are
   re-measured on the integrated engine (`measured`).
   ========================================================================== */
import { newProject } from '../engine/schema.js';

/** Builds a fresh project (new timestamps on every call). */
function build() {
    const p = newProject('cyl2d');
    p.meta = {
        ...p.meta, name: 'Einzel lens', preset: 'einzel',
        notes: 'Three coaxial tubes (inner diameter D = 20 mm, wall 1 mm). The outer tubes are at 0 V and the center tube at Vc. '
            + 'A parallel beam of 21 rays of m/z 100 at 1000 eV enters from the left; the image plane at x = 135 mm stops the rays.\n'
            + 'At Vc = +850 V the lens decelerates and refocuses the beam: the waist (smallest rms size) lies near x = 79 mm, before the '
            + 'near-axis focus near x = 92 mm because of spherical aberration. Try Vc = -8000 V for an accelerating lens with a much shorter focal length.\n'
            + 'Dimensions are generic, not taken from a publication.',
    };
    p.params = [
        { name: 'D', value: 20, dim: 'length', note: 'tube inner diameter' },
        { name: 'Vc', value: 850, dim: 'voltage', slider: { min: -10000, max: 1000, step: 5 } },
    ];
    p.domain = {
        type: 'cyl2d', cell: 0.25, x: [-60, 140], y: [0, 16],
        edges: { xmin: { bc: 'dirichlet', electrode: 'gnd' }, xmax: { bc: 'dirichlet', electrode: 'gnd' }, ymin: { bc: 'axis' }, ymax: { bc: 'dirichlet', electrode: 'gnd' } },
        mirror: { x: false, y: false }, beyond: { xmin: 'stop', xmax: 'drift', ymin: 'stop', ymax: 'stop' },
    };
    p.electrodes = [
        { id: 'gnd', name: 'Ground', ground: true, color: '#64748b' },
        { id: 'outer', name: 'Outer tubes', kind: 'solid', v: 0, wave: null, color: '#2563eb' },
        { id: 'centre', name: 'Center tube', kind: 'solid', v: 'Vc', wave: null, color: '#ea580c' },
    ];
    p.shapes = [
        { id: 's1', type: 'tube', electrode: 'outer', x0: -55, x1: '-0.3*D', rIn: 'D/2', rOut: 'D/2+1' },
        { id: 's2', type: 'tube', electrode: 'centre', x0: '-0.2*D', x1: '0.2*D', rIn: 'D/2', rOut: 'D/2+1' },
        { id: 's3', type: 'tube', electrode: 'outer', x0: '0.3*D', x1: 55, rIn: 'D/2', rOut: 'D/2+1' },
    ];
    p.magnets = [];
    p.idealFields = [];
    p.sources = [{
        id: 'b1', name: 'Parallel beam', enabled: true, color: 'auto', count: 21, sampling: 'grid', seed: 1,
        species: [{ label: 'm/z 100', mass: 100, charge: 1, fraction: 1 }],
        position: { type: 'line', p0: [-52, -3, 0], p1: [-52, 3, 0], n: 21 }, direction: { type: 'fixed', dir: [1, 0, 0] },
        energy: { type: 'mono', ke: 1000 }, time: { type: 'fixed', t: 0 },
    }];
    p.recording = {
        planes: [{ id: 'p1', name: 'Image plane', kind: 'x', at: 135, limits: null, radius: null, terminate: true, side: 'forward', record: 'first' }],
        trajectories: { store: true, maxPoints: 2000 }, timeMarkers: null,
    };
    p.tracer = { integrator: 'auto', quality: 'normal', custom: null, fieldInterp: 'cubic', relativistic: true, tMax: 1000, maxSteps: 500000, maxDrift: 10000, drag: null };
    p.solver = { boundary: 'subgrid', method: 'auto', tol: 1e-10, maxCycles: 60, maxIterations: 200, maxSweeps: 100000 };
    p.analysis = { lens: null, scan: null, optimize: null, waist: { plane: 'p1' } };
    p.view = { ...p.view, center: [40, 0], scale: 6, displayTime: 0, projection: 'xy', colormap: 'auto', contourLevels: null,
        layers: { ...p.view.layers, potential: true, contours: 20, field: false, electrodes: true, trajectories: 'source', planes: true, hits: true, grid: 'auto', mirror: true, markers: false } };
    return p;
}

export default Object.freeze({
    id: 'einzel',
    title: 'Einzel lens',
    order: 10,
    domainType: 'cyl2d',
    tags: ['lens'],
    blurb: 'Three coaxial tubes focus a parallel beam of ions. The default project.',
    tryThis: 'Drag Vc and watch the focus move; set Vc = −8000 V for an accelerating lens; open the Lens tab for focal lengths.',
    build,
    expect: Object.freeze([
        { id: 'transmission', label: 'All 21 rays reach the image plane', metric: 'transmission', plane: 'p1', min: 1, check: 1, measured: 1 },
        { id: 'waist', label: 'Waist (minimum rms size) position', metric: 'waist', plane: 'p1', target: 78.9, tol: 2, unit: 'mm', check: 78.91, measured: 78.91445 },
        { id: 'focus', label: 'Near-axis focus (two innermost rays)', metric: 'axisCrossing', plane: 'p1', target: 91.7, tol: 1.5, unit: 'mm', check: 91.65, measured: 91.6495,
            note: 'The zero-gap model gives 89.5 mm.' },
        { id: 'energy', label: 'Largest endpoint energy error |ΔE|/E', metric: 'energyError', max: 1e-6, check: null, measured: 3.4311e-09 },
        { id: 'waist-accel', label: 'Waist with Vc = −8000 V (ratio 9)', metric: 'waist', plane: 'p1', set: { params: { Vc: -8000 } }, target: 21.5, tol: 1.5, unit: 'mm', check: 21.45, measured: 21.45277 },
    ]),
    guide: Object.freeze({
        id: 'einzel-tour',
        title: 'Quick tour',
        steps: [
            { target: 'electrode:centre', open: { rail: 'electrodes' }, title: 'Drag a voltage',
                text: 'This slider sets the center tube voltage (parameter Vc). Drag it: the 21 rays run again as you move, and the focus slides along the axis.' },
            { target: 'dock:lens', title: 'Measure the lens',
                text: 'The Lens tab traces rays parallel to the axis and reports the focal lengths and principal planes. The Summary tab shows the waist position and the rms spot size.' },
            { target: 'toolbar:presets', title: 'Try other devices',
                text: 'Presets opens ten more devices: lenses, a mirror, energy analyzers, a reflectron time-of-flight spectrometer, an RF quadrupole, a Paul trap, a magnetic sector and a velocity-map imaging lens.' },
        ],
    }),
});
