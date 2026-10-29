/* ==========================================================================
   Ion optics presets: two-tube.js
   P2 Two-tube immersion lens in the deep-gap geometry of the NBS lens
   studies (spec §4.14): Natali, Di Chio & Kuyatt, J. Res. Natl. Bur. Stand.
   76A, 27 (1972) closed the gap between two tubes of diameter D with a deep
   slot of width 0.1 D; DiChio, Natali & Kuyatt, Rev. Sci. Instrum. 45, 559 (1974),
   Table I, list the cardinal elements (F1, F2, f1, f2 in units of D) against
   the kinetic-potential ratio V2/V1. Here D = 20 mm, tube 2 at −4000 V,
   1000 eV singly charged argon ions: V2/V1 = 5. Newton's lens equation
   with the ratio-5 row puts the image of an axial point 80 mm before the gap
   at 161.5 mm, magnification −1.43.
   ========================================================================== */
import { newProject } from '../engine/schema.js';

function build() {
    const p = newProject('cyl2d');
    p.meta = {
        ...p.meta, name: 'Two-tube immersion lens', preset: 'two-tube',
        notes: 'Two tubes of inner diameter D = 20 mm separated by a gap of 0.1 D, closed by a deep slot as in the NBS lens studies '
            + '(Natali, Di Chio and Kuyatt 1972; DiChio, Natali and Kuyatt 1974). Tube 1 is at 0 V and tube 2 at -4000 V, so 1000 eV '
            + 'singly charged argon ions are accelerated to 5000 eV: the kinetic-potential ratio V2/V1 is 5.\n'
            + 'The Lens tab (D = 20 mm, reference plane x = 0) reproduces the published ratio-5 focal properties. Rays from an axial point at '
            + 'x = -80 mm come to an image near x = 161.5 mm, beyond the solved region; they continue there in straight lines (field-free drift).',
    };
    p.params = [];
    p.domain = {
        type: 'cyl2d', cell: 0.25, x: [-90, 70], y: [0, 35],
        edges: {
            xmin: { bc: 'dirichlet', electrode: 'T1' }, xmax: { bc: 'dirichlet', electrode: 'T2' }, ymin: { bc: 'axis' },
            ymax: { bc: 'profile', segments: [{ from: -90, to: -1, electrode: 'T1' }, { from: -1, to: 1, ramp: ['T1', 'T2'] }, { from: 1, to: 70, electrode: 'T2' }] },
        },
        mirror: { x: false, y: false }, beyond: { xmin: 'stop', xmax: 'drift', ymin: 'stop', ymax: 'stop' },
    };
    p.electrodes = [
        { id: 'gnd', name: 'Ground', ground: true, color: '#64748b' },
        { id: 'T1', name: 'Tube 1', kind: 'solid', v: 0, wave: null, color: '#2563eb' },
        { id: 'T2', name: 'Tube 2', kind: 'solid', v: -4000, wave: null, color: '#ea580c' },
    ];
    p.shapes = [
        { id: 's1', type: 'box', electrode: 'T1', x0: -90, x1: -1, y0: 10, y1: 35 },
        { id: 's2', type: 'box', electrode: 'T2', x0: 1, x1: 70, y0: 10, y1: 35 },
    ];
    p.magnets = [];
    p.idealFields = [];
    p.sources = [{
        id: 'b1', name: 'Axial point', enabled: true, color: 'auto', count: 11, sampling: 'grid', seed: 1,
        species: [{ label: 'Ar⁺', mass: 39.962, charge: 1, fraction: 1 }],
        position: { type: 'point', p: [-80, 0, 0] }, direction: { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: -1, to: 1, n: 11 },
        energy: { type: 'mono', ke: 1000 }, time: { type: 'fixed', t: 0 },
    }];
    p.recording = {
        planes: [{ id: 'img', name: 'Image plane', kind: 'x', at: 161.5, limits: null, radius: null, terminate: true, side: 'forward', record: 'first' }],
        trajectories: { store: true, maxPoints: 2000 }, timeMarkers: null,
    };
    p.analysis = {
        lens: { refX: 0, D: 20, xStart: -89.5, xEnd: 69.5, mass: 39.962, charge: 1, keLeft: 1000, heights: [0.02, 0.03, 0.04, 0.05, 0.06, 0.08], side: 'both' },
        scan: null, optimize: null, waist: { plane: 'img' },
    };
    p.view = { ...p.view, center: [-10, 0], scale: 5 };
    return p;
}

// DiChio, Natali & Kuyatt (1974), Table I, V2/V1 = 5; tolerance max(0.35 %·|ref|, 0.003 D) as gate L3 (spec §5.2)
const LENS_REF = 'DiChio, Natali & Kuyatt, Rev. Sci. Instrum. 45, 559 (1974), Table I, V2/V1 = 5';

export default Object.freeze({
    id: 'two-tube',
    title: 'Two-tube immersion lens',
    order: 20,
    domainType: 'cyl2d',
    tags: ['lens'],
    blurb: 'Two tubes with a 0.1 D gap accelerate argon ions fivefold; the Lens tab reproduces published focal properties.',
    tryThis: 'Open the Lens tab and compute F1, F2, f1 and f2; set Tube 2 to −9000 V for a voltage ratio of 10.',
    build,
    expect: Object.freeze([
        { id: 'transmission', label: 'All 11 rays reach the image plane', metric: 'transmission', plane: 'img', min: 1, check: 1, measured: 1 },
        { id: 'F1', label: 'F1 (units of D)', metric: 'lens', key: 'F1', target: -2.7683, rel: 0.0035, tol: 0.003, unit: 'D', check: -2.7683, measured: -2.766153, source: LENS_REF },
        { id: 'F2', label: 'F2 (units of D)', metric: 'lens', key: 'F2', target: 2.4659, rel: 0.0035, tol: 0.003, unit: 'D', check: 2.4659, measured: 2.46212, source: LENS_REF },
        { id: 'f1', label: 'f1 (units of D)', metric: 'lens', key: 'f1', target: -1.7573, rel: 0.0035, tol: 0.003, unit: 'D', check: -1.7573, measured: -1.755385, source: LENS_REF },
        { id: 'f2', label: 'f2 (units of D)', metric: 'lens', key: 'f2', target: 3.9296, rel: 0.0035, tol: 0.003, unit: 'D', check: 3.9296, measured: 3.925197, source: LENS_REF },
        { id: 'identity', label: 'Lagrange–Helmholtz identity |f1/f2|·√(V2/V1) − 1', metric: 'lens', key: 'identity', target: 0, tol: 2e-4, check: 0, measured: -9.0994e-06 },
        { id: 'image', label: 'Image of the axial point (±0.25° rays)', metric: 'imageX', objectX: -80, angles: [-0.25, 0.25], xEnd: 69.5,
            target: 161.5, rel: 0.02, unit: 'mm', check: 161.5, measured: 160.7229, note: 'Newton\'s lens equation with the ratio-5 row: 8.07 D, magnification −1.43.' },
    ]),
    guide: null,
});
