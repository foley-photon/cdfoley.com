/* ==========================================================================
   Ion optics presets: reflectron.js
   P7 Reflectron time-of-flight spectrometer (spec §4.14). A single-field
   source (repeller at Vrep, extraction mesh 12 mm away) gives ions born
   6 mm before the mesh about 1200 eV, with a first-order space focus at
   2 × 6 mm beyond the mesh (Wiley & McLaren, Rev. Sci. Instrum. 26, 1150
   (1955)). A gridded single-stage ion mirror (mesh at x = 400 mm, uniform
   field to the back plate at x = 600 mm, made ideal by linear potential
   ramps on the side walls) compensates the energy spread when the
   field-free path is four times the penetration depth (Mamyrin et al.,
   Sov. Phys. JETP 37, 45 (1973)): L = 2(400 − 22) = 756 mm, d = 189 mm,
   E = 6.349 V/mm, Vback = 1269.8 V. The ions also carry 0.5 eV across the
   axis, so they return beside the source onto a detector at the space
   focus (x = 22 mm, y 20–39 mm) after about 32 µs. The meshes end 1 mm
   short of the side walls so that no mesh node touches a wall node of
   another electrode (both are at 0 V; nothing changes along the ion path).
   ========================================================================== */
import { newProject } from '../engine/schema.js';

function build() {
    const p = newProject('planar2d');
    p.meta = {
        ...p.meta, name: 'Reflectron TOF', preset: 'reflectron',
        notes: 'Ions of m/z 100 and 101 start at rest along x in a 0.2 x 2 mm region 6 mm before the extraction mesh (x = 10 mm), between a repeller '
            + 'at Vrep = 2400 V and the mesh at 0 V, and gain about 1200 eV. They fly to the ion mirror (entrance mesh at x = 400 mm, back plate at '
            + 'x = 600 mm at Vback) and return to a detector at x = 22 mm, the space focus of the source. A small sideways energy (0.5 eV along y) '
            + 'carries them past the source to the detector at y = 20-39 mm.\n'
            + 'A single-stage mirror compensates the energy spread when the field-free path is four times the penetration depth: '
            + 'Vback = 1269.8 V in the one-dimensional design, which also gives the narrowest arrival-time peaks here (rms width about 0.3 ns). '
            + 'The TOF tab shows the two mass peaks and their resolving power. Each peak rises steeply at its leading edge, so its width at half '
            + 'maximum is not well defined (it shrinks with the histogram bin width); the TOF tab therefore leads with R = t/(2 x 2.3548 sigma) from '
            + 'the rms width (about 21,000 here), which Scan & tune also uses. A scan of Vback against it peaks at 1270 V, the one-dimensional design value.',
    };
    p.params = [
        { name: 'Vrep', value: 2400, dim: 'voltage', note: 'repeller voltage (source field Vrep/12 mm)', slider: { min: 1800, max: 3000, step: 5 } },
        { name: 'Vback', value: 1269.8, dim: 'voltage', note: 'ion-mirror back plate', slider: { min: 1150, max: 1400, step: 0.1 } },
    ];
    const wall = { bc: 'profile', segments: [{ from: -10, to: 400, electrode: 'gnd' }, { from: 400, to: 600, ramp: ['gnd', 'back'] }, { from: 600, to: 640, electrode: 'back' }] };
    p.domain = {
        type: 'planar2d', cell: 0.5, x: [-10, 640], y: [-40, 40],
        edges: { xmin: { bc: 'dirichlet', electrode: 'gnd' }, xmax: { bc: 'dirichlet', electrode: 'back' }, ymin: wall, ymax: JSON.parse(JSON.stringify(wall)) },
        mirror: { x: false, y: false }, beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' },
    };
    p.electrodes = [
        { id: 'gnd', name: 'Ground', ground: true, color: '#64748b' },
        { id: 'rep', name: 'Repeller', kind: 'solid', v: 'Vrep', wave: null, color: '#ea580c' },
        { id: 'ext', name: 'Extraction mesh', kind: 'grid', transmission: 1, v: 0, wave: null, color: '#16a34a' },
        { id: 'ment', name: 'Mirror entrance mesh', kind: 'grid', transmission: 1, v: 0, wave: null, color: '#0891b2' },
        { id: 'back', name: 'Back plate', kind: 'solid', v: 'Vback', wave: null, color: '#9333ea' },
    ];
    p.shapes = [
        { id: 's1', type: 'box', electrode: 'rep', x0: -4, x1: -2, y0: -38, y1: 38 },
        { id: 's2', type: 'polyline', electrode: 'ext', points: [[10, -39], [10, 39]] },
        { id: 's3', type: 'polyline', electrode: 'ment', points: [[400, -39], [400, 39]] },
        { id: 's4', type: 'box', electrode: 'back', x0: 600, x1: 602, y0: -40, y1: 40 },
    ];
    p.magnets = [];
    p.idealFields = [];
    p.sources = [{
        id: 'b1', name: 'Ions m/z 100 and 101', enabled: true, color: 'auto', count: 500, sampling: 'random', seed: 1,
        species: [{ label: 'm/z 100', mass: 100, charge: 1, fraction: 1 }, { label: 'm/z 101', mass: 101, charge: 1, fraction: 1 }],
        position: { type: 'rect', center: [4, 0, 0], u: [1, 0, 0], v: [0, 1, 0], halfU: 0.1, halfV: 1 },
        direction: { type: 'fixed', dir: [0, 1, 0] }, energy: { type: 'mono', ke: 0.5 }, time: { type: 'fixed', t: 0 },
    }];
    p.recording = {
        planes: [{ id: 'det', name: 'Detector', kind: 'segment', p0: [22, 20], p1: [22, 39], limits: null, radius: null, terminate: true, side: 'both', record: 'first' }],
        trajectories: { store: true, maxPoints: 2000 }, timeMarkers: null,
    };
    // a tighter tolerance than 'normal' keeps the energy error of the steps that cross the meshes (jumps in the field) below the warning level
    p.tracer = { ...p.tracer, quality: 'custom', custom: { rtol: 1e-10, maxStepCells: 0.5, nearStepCells: 0.1, rfStepsPerPeriod: 32, borisStepsPerGyration: 128 } };
    p.analysis = {
        lens: null, optimize: null, waist: null,
        scan: { variable: { kind: 'param', id: 'Vback' }, values: { from: 1250, to: 1290, n: 21 }, metric: { type: 'resolvingPower', plane: 'det', species: 'm/z 100' } },
    };
    p.view = { ...p.view, center: [315, 0], scale: 1.3,
        layers: { ...p.view.layers, trajectories: 'species' } };
    return p;
}

// 1D reference (exact.reflectronTof): source gap 6 mm at Vrep/12 V/mm, drift 390 mm out, uniform mirror Vback/200 V/mm, 378 mm back
const TOF_1D = { sMm: 6, eSrcVMm: 'Vrep/12', outMm: 390, backMm: 378, eMirrorVMm: 'Vback/200' };

export default Object.freeze({
    id: 'reflectron',
    title: 'Reflectron TOF',
    order: 70,
    domainType: 'planar2d',
    tags: ['tof', 'mirror'],
    blurb: 'A gridded ion mirror folds the flight path and resolves m/z 100 from 101 by time of flight.',
    tryThis: 'Open the TOF tab; scan Vback against the resolving power in Scan & tune.',
    build,
    expect: Object.freeze([
        { id: 'detected', label: 'Ions reaching the detector', metric: 'transmission', plane: 'det', min: 0.95, check: null, measured: 1 },
        { id: 'tof100', label: 'Mean time of flight of m/z 100 vs the 1D model', metric: 'meanTof', plane: 'det', species: 'm/z 100', reference: { model: 'reflectron1D', args: TOF_1D },
            rel: 0.01, unit: 'µs', check: 31.9, measured: 31.92029 },
        { id: 'optimum', label: 'Back-plate voltage of the best resolving power t/(2·2.3548σ) (m/z 100, 1 V steps)', metric: 'scanOptimum', param: 'Vback',
            scan: { full: { from: 1250, to: 1290, step: 1 } }, objective: { metric: 'resolvingPower', plane: 'det', species: 'm/z 100' }, goal: 'max',
            info: true, unit: 'V', check: 1269.8, measured: 1270,
            note: 'Recorded optimum of the rms-based resolving power (full level): 1270 V, the 1D design value 1269.8 V (rms width 0.319 ns, R 21,234; '
                + '0.443 ns and R 15,345 at 1265 V). The width at half maximum is not used: most ions of a peak arrive within a fraction of a '
                + 'nanosecond of the first, so a histogram FWHM follows the bin width and the ion count instead of the physics. '
                + 'The gated checks below hold across ±2 V of the recorded optimum.' },
        { id: 'R100', label: 'Resolving power t/(2·2.3548σ) of m/z 100, recorded optimum ±2 V (worst)', metric: 'resolvingPower', plane: 'det', species: 'm/z 100',
            at: 'optimum', offsets: [-2, 0, 2], min: 500, check: null, measured: 19651.27 },
        { id: 'separation', label: 'Separation of the m/z 100 and 101 peaks in units of 2.3548σ, recorded optimum ±2 V (worst)', metric: 'peakSeparation', plane: 'det',
            species: ['m/z 100', 'm/z 101'], at: 'optimum', offsets: [-2, 0, 2], min: 2, check: null, measured: 185.3957 },
    ]),
    guide: Object.freeze({
        id: 'reflectron-tour',
        title: 'Reflectron',
        steps: [
            { target: 'dock:tof', open: { dock: 'tof' }, title: 'Arrival times',
                text: 'The TOF tab shows when the ions reach the detector: one peak each for m/z 100 and 101, with the resolving power R. Tune Vback (Params, or a scan in Scan & tune) for the sharpest peaks.' },
        ],
    }),
});
