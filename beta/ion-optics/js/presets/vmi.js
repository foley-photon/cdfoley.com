/* ==========================================================================
   Ion optics presets: vmi.js
   P11 Velocity-map imaging lens in the style of Eppink & Parker, Rev. Sci.
   Instrum. 68, 3477 (1997): a solid repeller, an open extractor at
   ratio × Vrep and a grounded plate. At the right ratio the lens maps every
   ion with the same initial velocity vector onto the same detector point,
   whatever its starting position, so fragments of one kinetic energy form a
   sharp ring of radius R ∝ √E. Our dimensions are generic, not those of the
   paper: plates 1 mm thick at x = 0, 15 and 30 mm, holes of radius 10 mm,
   O⁺ fragments at 1 and 2 eV from a 1 × 2 mm source volume, a detector
   400 mm away (field-free drift beyond the solved region).
   ========================================================================== */
import { newProject } from '../engine/schema.js';

function build() {
    const p = newProject('cyl2d');
    p.meta = {
        ...p.meta, name: 'Velocity-map imaging lens', preset: 'vmi',
        notes: 'Three plates in the style of Eppink and Parker (1997): a solid repeller at Vrep = 3000 V, an extractor with a 20 mm hole at '
            + 'ratio x Vrep and a grounded plate with a 20 mm hole. Fragment ions (O+, 1 and 2 eV) start in all directions in the plane from a '
            + 'source volume 1 mm long and 2 mm high between the first two plates and drift to a detector 400 mm away.\n'
            + 'At ratio = 0.695 ions with equal velocity vectors land on the same spot whatever their starting point, so each energy forms a sharp '
            + 'ring whose radius grows as the square root of the energy. Move the ratio away from 0.695 and the rings blur. '
            + 'Try a scan of ratio from 0.60 to 0.80 against the grouped blur in Scan & tune. The dimensions are generic, not those of the paper.',
    };
    p.params = [
        { name: 'Vrep', value: 3000, dim: 'voltage', note: 'repeller voltage', slider: { min: 500, max: 5000, step: 10 } },
        { name: 'ratio', value: 0.695, dim: 'none', note: 'extractor voltage / repeller voltage', slider: { min: 0.55, max: 0.85, step: 0.005 } },
    ];
    p.domain = {
        type: 'cyl2d', cell: 0.25, x: [-5, 155], y: [0, 50],
        edges: { xmin: { bc: 'dirichlet', electrode: 'gnd' }, xmax: { bc: 'dirichlet', electrode: 'gnd' }, ymin: { bc: 'axis' }, ymax: { bc: 'dirichlet', electrode: 'gnd' } },
        mirror: { x: false, y: false }, beyond: { xmin: 'stop', xmax: 'drift', ymin: 'stop', ymax: 'stop' },
    };
    p.electrodes = [
        { id: 'gnd', name: 'Ground', ground: true, color: '#64748b' },
        { id: 'rep', name: 'Repeller', kind: 'solid', v: 'Vrep', wave: null, color: '#ea580c' },
        { id: 'ext', name: 'Extractor', kind: 'solid', v: 'ratio*Vrep', wave: null, color: '#2563eb' },
    ];
    p.shapes = [
        { id: 's1', type: 'plate', electrode: 'rep', name: 'Repeller', x: -0.5, t: 1, rHole: 0, rOut: 40 },
        { id: 's2', type: 'plate', electrode: 'ext', name: 'Extractor', x: 15.5, t: 1, rHole: 10, rOut: 40 },
        { id: 's3', type: 'plate', electrode: 'gnd', name: 'Ground plate', x: 30.5, t: 1, rHole: 10, rOut: 40 },
    ];
    p.magnets = [];
    p.idealFields = [];
    p.sources = [{
        id: 'b1', name: 'O⁺ fragments, 1 and 2 eV', enabled: true, color: 'auto', count: 360, sampling: 'grid', seed: 1,
        species: [{ label: 'O⁺', mass: 15.995, charge: 1, fraction: 1 }],
        position: { type: 'rect', center: [7.5, 0, 0], u: [1, 0, 0], v: [0, 1, 0], halfU: 0.5, halfV: 1.0, n: [3, 5] },
        direction: { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: 0, to: 330, n: 12 },
        energy: { type: 'list', values: [1, 2] }, time: { type: 'fixed', t: 0 },
    }];
    p.recording = {
        planes: [{ id: 'det', name: 'Detector (x = 400 mm)', kind: 'x', at: 400, limits: null, radius: 45, terminate: true, side: 'forward', record: 'first' }],
        trajectories: { store: true, maxPoints: 2000 }, timeMarkers: null,
    };
    p.analysis = {
        lens: null, waist: null,
        scan: { variable: { kind: 'param', id: 'ratio' }, values: { from: 0.6, to: 0.8, n: 41 }, metric: { type: 'groupedBlur', plane: 'det' } },
        optimize: { variables: [{ kind: 'param', id: 'ratio', lower: 0.6, upper: 0.8, step: 0.01 }], metric: { type: 'groupedBlur', plane: 'det' }, goal: 'min', maxEval: 40 },
    };
    p.view = { ...p.view, center: [75, 0], scale: 5,
        layers: { ...p.view.layers, trajectories: 'energy' } };
    return p;
}

export default Object.freeze({
    id: 'vmi',
    title: 'Velocity-map imaging lens',
    order: 110,
    domainType: 'cyl2d',
    tags: ['imaging'],
    blurb: 'Three plates map ions of equal velocity to one detector point, giving sharp rings for each fragment energy.',
    tryThis: 'Scan ratio from 0.60 to 0.80 against the grouped blur; the minimum near 0.695 is the velocity-map focus.',
    build,
    expect: Object.freeze([
        { id: 'R1', label: 'Ring radius at 1 eV', metric: 'ringRadius', plane: 'det', energy: 1, target: 10.86, tol: 0.3, unit: 'mm', check: 10.86, measured: 10.86295 },
        { id: 'ratio21', label: 'Radius ratio R(2 eV)/R(1 eV)', metric: 'ringRatio', plane: 'det', energies: [1, 2], target: Math.SQRT2, rel: 0.005, check: 1.4136, measured: 1.41363,
            source: 'Velocity mapping: R ∝ √E' },
        { id: 'best', label: 'Best extractor ratio of a 0.005-step scan (grouped blur)', metric: 'scanOptimum', param: 'ratio',
            scan: { quick: { from: 0.665, to: 0.725, step: 0.005 }, full: { from: 0.6, to: 0.8, step: 0.005 } },
            objective: { metric: 'groupedBlur', plane: 'det' }, goal: 'min', min: 0.685, max: 0.705, check: 0.695, measured: 0.695 },
        { id: 'width', label: 'Rms width of the 1 eV ring / its radius, at the best ratio', metric: 'ringWidth', plane: 'det', energy: 1, at: 'optimum',
            max: 0.015, check: 0.0077, measured: 0.004682981 },
        { id: 'blur', label: 'Grouped blur at ratio 0.55 / at the best ratio', metric: 'blurRatio', plane: 'det', param: 'ratio', other: 0.55, at: 'optimum',
            min: 10, check: 33, measured: 39.03933 },
    ]),
    guide: Object.freeze({
        id: 'vmi-tour',
        title: 'Velocity mapping',
        steps: [
            { target: 'rail:params', open: { rail: 'params' }, title: 'Extractor ratio',
                text: 'The extractor sits at ratio × Vrep. Drag ratio: near 0.695 every ion with the same velocity lands on the same spot and the rings on the detector are sharp.' },
            { target: 'dock:scan', title: 'Find the best ratio',
                text: 'Scan & tune can step the ratio from 0.60 to 0.80 against the grouped blur; the minimum is the velocity-map focus. The Planes tab shows the detector image.' },
        ],
    }),
});
