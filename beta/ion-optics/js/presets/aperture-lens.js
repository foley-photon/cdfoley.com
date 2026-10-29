/* ==========================================================================
   Ion optics presets: aperture-lens.js
   P3 Two-aperture lens (spec §4.14): two zero-thickness apertures of
   diameter D = 10 mm, 5 mm apart (A/D 0.5), closed by a linear potential
   ramp at r = 5 D. Aperture 2 at −9000 V accelerates 1000 eV ions tenfold
   (V2/V1 = 10). Two- and three-aperture lenses are tabulated by Harting &
   Read, Electrostatic Lenses (1976); with zero-thickness apertures and this
   ramp closure our model runs 3 to 6 % above their f2/D (benchmark L6,
   informational), so the expectation records our own value.
   ========================================================================== */
import { newProject } from '../engine/schema.js';

function build() {
    const p = newProject('cyl2d');
    p.meta = {
        ...p.meta, name: 'Two-aperture lens', preset: 'aperture-lens',
        notes: 'Two thin apertures of diameter D = 10 mm, 5 mm apart, drawn as zero-thickness lines (sheets). Aperture 1 is at 0 V and '
            + 'aperture 2 at -9000 V, so 1000 eV ions leave with 10000 eV (V2/V1 = 10). The outer wall at r = 25 mm carries a linear '
            + 'potential ramp between the two voltages, an ideal closure of the lens.\n'
            + 'A parallel beam 2 mm wide comes to a focus to the right of the lens. The Lens tab gives f2/D near 3.35; the tables of '
            + 'Harting and Read (1976) give 3.20. This zero-thickness model with a ramp closure runs 3 to 6 % above their values, a model '
            + 'difference that does not shrink on finer grids (informational benchmark L6).',
    };
    p.params = [];
    p.domain = {
        type: 'cyl2d', cell: 0.25, x: [-80, 80], y: [0, 25],
        edges: {
            xmin: { bc: 'dirichlet', electrode: 'A1' }, xmax: { bc: 'dirichlet', electrode: 'A2' }, ymin: { bc: 'axis' },
            ymax: { bc: 'profile', segments: [{ from: -80, to: -2.5, electrode: 'A1' }, { from: -2.5, to: 2.5, ramp: ['A1', 'A2'] }, { from: 2.5, to: 80, electrode: 'A2' }] },
        },
        mirror: { x: false, y: false }, beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' },
    };
    p.electrodes = [
        { id: 'gnd', name: 'Ground', ground: true, color: '#64748b' },
        { id: 'A1', name: 'Aperture 1', kind: 'solid', v: 0, wave: null, color: '#2563eb' },
        { id: 'A2', name: 'Aperture 2', kind: 'solid', v: -9000, wave: null, color: '#ea580c' },
    ];
    p.shapes = [
        { id: 's1', type: 'polyline', electrode: 'A1', points: [[-2.5, 5], [-2.5, 25]] },
        { id: 's2', type: 'polyline', electrode: 'A2', points: [[2.5, 5], [2.5, 25]] },
    ];
    p.magnets = [];
    p.idealFields = [];
    p.sources = [{
        id: 'b1', name: 'Parallel beam', enabled: true, color: 'auto', count: 11, sampling: 'grid', seed: 1,
        species: [{ label: 'm/z 100', mass: 100, charge: 1, fraction: 1 }],
        position: { type: 'line', p0: [-75, -1, 0], p1: [-75, 1, 0], n: 11 }, direction: { type: 'fixed', dir: [1, 0, 0] },
        energy: { type: 'mono', ke: 1000 }, time: { type: 'fixed', t: 0 },
    }];
    p.recording = {
        planes: [{ id: 'det', name: 'End plane', kind: 'x', at: 78, limits: null, radius: null, terminate: true, side: 'forward', record: 'first' }],
        trajectories: { store: true, maxPoints: 2000 }, timeMarkers: null,
    };
    p.analysis = {
        lens: { refX: 0, D: 10, xStart: -79.5, xEnd: 79.5, mass: 100, charge: 1, keLeft: 1000, heights: [0.02, 0.03, 0.04, 0.05, 0.06, 0.08], side: 'right' },
        scan: null, optimize: null, waist: { plane: 'det' },
    };
    p.view = { ...p.view, center: [0, 0], scale: 5 };
    return p;
}

export default Object.freeze({
    id: 'aperture-lens',
    title: 'Two-aperture lens',
    order: 30,
    domainType: 'cyl2d',
    tags: ['lens'],
    blurb: 'Two thin apertures, the second at −9000 V, focus a parallel beam while accelerating it tenfold.',
    tryThis: 'Open the Lens tab (f2 from left-to-right rays); change Aperture 2 and watch the focus move.',
    build,
    expect: Object.freeze([
        { id: 'transmission', label: 'All 11 rays reach the end plane', metric: 'transmission', plane: 'det', min: 1, check: 1, measured: 1 },
        { id: 'f2', label: 'f2/D (recorded value ±1 %)', metric: 'lens', key: 'f2', target: null, rel: 0.01, unit: 'D', check: 3.35, measured: 3.355081,
            note: 'Zero-thickness apertures run 3–6 % above Harting & Read\'s 3.20 (benchmark L6, informational).' },
    ]),
    guide: null,
});
