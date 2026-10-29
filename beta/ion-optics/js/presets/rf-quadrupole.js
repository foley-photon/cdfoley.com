/* ==========================================================================
   Ion optics presets: rf-quadrupole.js
   P8 RF quadrupole mass filter, cross-section (spec §4.14). Hyperbolic rods
   with r₀ = 4 mm carry ±(U − V cos Ωt) at 1.1 MHz; in the ideal field the
   transverse motion obeys Mathieu's equation with a = 8qU/(mr₀²Ω²) and
   q = 4qV/(mr₀²Ω²) (Paul, Rev. Mod. Phys. 62, 531 (1990); Dawson,
   Quadrupole Mass Spectrometry (1976); McLachlan, Theory and Application of
   Mathieu Functions (1947)). V = 136.783 V and U/V = 0.15945 put m/z 100 at
   the center of the stable band at a/q = 0.95 × the apex ratio (masses
   96.7–103.5 pass); m/z 90 and 110 grow by ×100 within 7 and 13 RF cycles.
   The quarter domain with two mirror planes holds one quadrant of each rod;
   ions travel along z (free in the planar model) for 320 mm, about 80 cycles.
   ========================================================================== */
import { newProject } from '../engine/schema.js';

function build() {
    const p = newProject('planar2d');
    p.meta = {
        ...p.meta, name: 'RF quadrupole mass filter', preset: 'rf-quadrupole',
        notes: 'Cross-section of a quadrupole mass filter: four hyperbolic rods (r0 = 4 mm; one quadrant is solved, the other three follow by '
            + 'symmetry). The x rods carry U - V cos(2 pi f t) and the y rods the negative of it, at f = 1.1 MHz.\n'
            + 'Ions of m/z 90, 100 and 110 enter at 10 eV within 0.3 mm of the axis at random RF phases and travel along z, out of the plane, to a '
            + 'detector at z = 320 mm (about 80 RF cycles). With V = 136.78 V and U/V = 0.15945 only masses near 100 have stable orbits; the others '
            + 'oscillate with growing amplitude and strike the rods. The canvas shows the ions\' paths projected on the cross-section.\n'
            + 'Try a scan of V from 125 to 150 V against the m/z 100 transmission, or set Uratio = 0 (RF only: every mass above about 76 passes).',
    };
    p.params = [
        { name: 'V', value: 136.783, dim: 'voltage', note: 'RF amplitude on each rod pair', slider: { min: 100, max: 180, step: 0.1 } },
        { name: 'Uratio', value: 0.15945, dim: 'none', note: 'U/V (0 = RF only)', slider: { min: 0, max: 0.2, step: 0.0005 } },
        { name: 'U', value: 'Uratio*V', dim: 'voltage', note: 'DC voltage on the rods' },
    ];
    p.domain = {
        type: 'planar2d', cell: 0.1, x: [0, 14], y: [0, 14],
        edges: { xmin: { bc: 'neumann' }, xmax: { bc: 'dirichlet', electrode: 'gnd' }, ymin: { bc: 'neumann' }, ymax: { bc: 'dirichlet', electrode: 'gnd' } },
        mirror: { x: true, y: true }, beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' },
    };
    p.electrodes = [
        { id: 'gnd', name: 'Ground', ground: true, color: '#64748b' },
        { id: 'rodsX', name: 'X rods', kind: 'solid', v: 'U', wave: { terms: [{ type: 'cos', amp: '-V', freq: 1.1, phase: 0 }] }, color: '#2563eb' },
        { id: 'rodsY', name: 'Y rods', kind: 'solid', v: '-U', wave: { terms: [{ type: 'cos', amp: 'V', freq: 1.1, phase: 0 }] }, color: '#ea580c' },
    ];
    p.shapes = [
        { id: 's1', type: 'quadric', electrode: 'rodsX', name: 'X rod (hyperbolic)', A: 1, B: -1, C: 16, cx: 0, cy: 0, clip: [0, 11.2, 0, 11.2] },
        { id: 's2', type: 'quadric', electrode: 'rodsY', name: 'Y rod (hyperbolic)', A: -1, B: 1, C: 16, cx: 0, cy: 0, clip: [0, 11.2, 0, 11.2] },
    ];
    p.magnets = [];
    p.idealFields = [];
    p.sources = [{
        id: 'b1', name: 'Ions m/z 90, 100, 110', enabled: true, color: 'auto', count: 300, sampling: 'random', seed: 1,
        species: [{ label: 'm/z 90', mass: 90, charge: 1, fraction: 1 }, { label: 'm/z 100', mass: 100, charge: 1, fraction: 1 }, { label: 'm/z 110', mass: 110, charge: 1, fraction: 1 }],
        position: { type: 'disc', center: [0, 0, 0], normal: [0, 0, 1], radius: 0.3 }, direction: { type: 'fixed', dir: [0, 0, 1] },
        energy: { type: 'mono', ke: 10 }, time: { type: 'rfPhase', freq: 1.1 },
    }];
    p.recording = {
        planes: [{ id: 'det', name: 'Detector (z = 320 mm)', kind: 'z', at: 320, limits: null, radius: null, terminate: true, side: 'forward', record: 'first' }],
        trajectories: { store: true, maxPoints: 2000 }, timeMarkers: null,
    };
    p.tracer = { ...p.tracer, tMax: 200 };
    p.analysis = {
        lens: null, optimize: null, waist: null,
        scan: { variable: { kind: 'param', id: 'V' }, values: { from: 125, to: 150, n: 26 }, metric: { type: 'transmission', plane: 'det', species: 'm/z 100' } },
    };
    p.view = { ...p.view, center: [0, 0], scale: 25,
        layers: { ...p.view.layers, trajectories: 'species' } };
    return p;
}

export default Object.freeze({
    id: 'rf-quadrupole',
    title: 'RF quadrupole mass filter',
    order: 80,
    domainType: 'planar2d',
    tags: ['rf'],
    blurb: 'Hyperbolic rods with RF and DC voltages pass m/z 100 and reject m/z 90 and 110.',
    tryThis: 'Scan V from 125 to 150 V against the m/z 100 transmission; set Uratio = 0 for RF-only mode.',
    build,
    expect: Object.freeze([
        { id: 'pass100', label: 'm/z 100 transmitted', metric: 'transmission', plane: 'det', species: 'm/z 100', min: 0.9, check: null, measured: 1 },
        { id: 'reject90', label: 'm/z 90 transmitted', metric: 'transmission', plane: 'det', species: 'm/z 90', max: 0, check: 0, measured: 0 },
        { id: 'reject110', label: 'm/z 110 transmitted', metric: 'transmission', plane: 'det', species: 'm/z 110', max: 0, check: 0, measured: 0 },
    ]),
    guide: Object.freeze({
        id: 'rf-quadrupole-tour',
        title: 'Mass filter',
        steps: [
            { target: 'rail:params', open: { rail: 'params' }, title: 'Rod voltages',
                text: 'The rods carry U − V cos(2πft) at 1.1 MHz. V and Uratio = U/V are parameters: raise V and heavier masses pass; set Uratio to 0 and every mass above about 76 passes.' },
            { target: 'dock:scan', title: 'Scan the filter',
                text: 'Scan & tune can step V from 125 to 150 V and plot the m/z 100 transmission: the pass band of the filter.' },
        ],
    }),
});
