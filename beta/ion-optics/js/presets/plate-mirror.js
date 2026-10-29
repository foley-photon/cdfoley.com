/* ==========================================================================
   Ion optics presets: plate-mirror.js
   P4 Parallel-plate mirror (spec §4.14): a transparent mesh at 0 V on a
   node row and a back plate at +1000 V, 20 mm above it, give a uniform
   retarding field of 50 V/mm. 1000 eV ions launched at angle θ above the
   mesh follow parabolas: range 4·(KE/qE)·sin θ cos θ (34.641 mm at 30° and
   60°, 40.000 mm at 45°) and depth (KE/qE)·sin²θ (10.000 mm at 45°):
   projectile motion in a uniform field, the principle of the parallel-plate
   energy analyzer. The node-aligned mesh exercises the same-side field rule
   (gate T1).
   ========================================================================== */
import { newProject } from '../engine/schema.js';

function build() {
    const p = newProject('planar2d');
    p.meta = {
        ...p.meta, name: 'Parallel-plate mirror', preset: 'plate-mirror',
        notes: 'A transparent mesh at 0 V along y = 0 and a back plate at +1000 V from y = 20 to 22 mm make a uniform retarding field of 50 V/mm. '
            + 'Seven ions of m/z 100 at 1000 eV start just above the mesh at angles from 30 to 60 degrees. Each follows a parabola and comes back '
            + 'through the mesh: at 45 degrees it returns 40.000 mm away after rising 10.000 mm; at 30 and 60 degrees it returns at 34.641 mm.\n'
            + 'The Planes tab lists the return points (plane "Mesh plane"); the detector at y = -5 mm stops the ions below the mesh.',
    };
    p.params = [];
    p.domain = {
        type: 'planar2d', cell: 0.25, x: [-10, 70], y: [-10, 22],
        edges: { xmin: { bc: 'neumann' }, xmax: { bc: 'neumann' }, ymin: { bc: 'dirichlet', electrode: 'gnd' }, ymax: { bc: 'dirichlet', electrode: 'back' } },
        mirror: { x: false, y: false }, beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' },
    };
    p.electrodes = [
        { id: 'gnd', name: 'Ground', ground: true, color: '#64748b' },
        { id: 'mesh', name: 'Mesh', kind: 'grid', transmission: 1, v: 0, wave: null, color: '#16a34a' },
        { id: 'back', name: 'Back plate', kind: 'solid', v: 1000, wave: null, color: '#ea580c' },
    ];
    p.shapes = [
        { id: 's1', type: 'polyline', electrode: 'mesh', points: [[-10, 0], [70, 0]] },
        { id: 's2', type: 'box', electrode: 'back', x0: -10, x1: 70, y0: 20, y1: 22 },
    ];
    p.magnets = [];
    p.idealFields = [];
    p.sources = [{
        id: 'b1', name: 'Fan 30° to 60°', enabled: true, color: 'auto', count: 7, sampling: 'grid', seed: 1,
        species: [{ label: 'm/z 100', mass: 100, charge: 1, fraction: 1 }],
        position: { type: 'point', p: [0, 1e-6, 0] }, direction: { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: 30, to: 60, n: 7 },
        energy: { type: 'mono', ke: 1000 }, time: { type: 'fixed', t: 0 },
    }];
    p.recording = {
        planes: [
            { id: 'mesh0', name: 'Mesh plane', kind: 'y', at: 0, limits: null, radius: null, terminate: false, side: 'backward', record: 'first' },
            { id: 'det', name: 'Detector', kind: 'y', at: -5, limits: null, radius: null, terminate: true, side: 'both', record: 'first' },
        ],
        trajectories: { store: true, maxPoints: 2000 }, timeMarkers: null,
    };
    // a tighter tolerance than 'normal' keeps the energy error of the steps that cross the mesh (a jump in the field) below the warning level
    p.tracer = { ...p.tracer, quality: 'custom', custom: { rtol: 1e-10, maxStepCells: 0.5, nearStepCells: 0.1, rfStepsPerPeriod: 32, borisStepsPerGyration: 128 } };
    p.view = { ...p.view, center: [30, 6], scale: 9 };
    return p;
}

const RANGE = 'Closed form 4·(KE/qE)·sin θ·cos θ for KE = 1000 eV, E = 50 V/mm';

export default Object.freeze({
    id: 'plate-mirror',
    title: 'Parallel-plate mirror',
    order: 40,
    domainType: 'planar2d',
    tags: ['mirror'],
    blurb: 'A uniform retarding field between a mesh and a back plate turns ions back along parabolas.',
    tryThis: 'Change the back-plate voltage and read the new return points in the Planes tab; set the mesh transmission below 1.',
    build,
    expect: Object.freeze([
        { id: 'range30', label: 'Return point at 30°', metric: 'planeCoord', plane: 'mesh0', coord: 'x', select: { dir: 0 }, target: 34.641, tol: 2e-3, unit: 'mm', check: 34.641, measured: 34.64102, source: RANGE },
        { id: 'range45', label: 'Return point at 45°', metric: 'planeCoord', plane: 'mesh0', coord: 'x', select: { dir: 3 }, target: 40.000, tol: 2e-3, unit: 'mm', check: 40.000, measured: 40.0, source: RANGE },
        { id: 'range60', label: 'Return point at 60°', metric: 'planeCoord', plane: 'mesh0', coord: 'x', select: { dir: 6 }, target: 34.641, tol: 2e-3, unit: 'mm', check: 34.641, measured: 34.64102, source: RANGE },
        { id: 'depth45', label: 'Turning depth at 45°', metric: 'trajectoryMax', coord: 'y', select: { dir: 3 }, target: 10.000, tol: 2e-3, unit: 'mm', check: 10.000, measured: 10.0,
            source: 'Closed form (KE/qE)·sin²θ' },
        { id: 'detected', label: 'All 7 ions reach the detector', metric: 'transmission', plane: 'det', min: 1, check: 1, measured: 1 },
    ]),
    guide: null,
});
