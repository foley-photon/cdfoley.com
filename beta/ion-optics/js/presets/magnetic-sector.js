/* ==========================================================================
   Ion optics presets: magnetic-sector.js
   P10 90° magnetic sector (spec §4.14). A hard-edged uniform field
   B = −0.455286 T ẑ in the annulus r 50–150 mm, 0°–90°, bends 1000 eV ions
   of m/z 100 on a 100 mm radius (r = p/(qB)). With normal entry and exit
   the sector images a point at l = r/tan(φ/2) = 100 mm before it onto a
   point the same distance after it (Barber's rule for a sector with normal
   entry and exit), and m/z 99 and 101 land 1.0 mm to either side
   (dispersion 2r·Δm/(2m)). No electrode besides ground: nothing is solved,
   and fringe fields are not modeled (sharp field edges).
   ========================================================================== */
import { newProject } from '../engine/schema.js';

function build() {
    const p = newProject('planar2d');
    p.meta = {
        ...p.meta, name: '90° magnetic sector', preset: 'magnetic-sector',
        notes: 'A uniform magnetic field of 0.455 T (pointing into the screen) fills a 90 degree sector between r = 50 and 150 mm. Singly charged '
            + 'ions at 1000 eV move on circles of radius 100 mm x sqrt(m/100) inside it.\n'
            + 'A fan of ±1 degree from x = 100, y = -100 mm is focused onto the detector line x = -100 mm, as far after the sector as the source '
            + 'is before it; masses 99, 100 and 101 land about 1 mm apart. There are no electrodes, so no field solve is needed. The field edges are '
            + 'sharp (no fringe fields).',
    };
    p.params = [];
    p.domain = {
        type: 'planar2d', cell: 1, x: [-150, 150], y: [-150, 150],
        edges: { xmin: { bc: 'dirichlet', electrode: 'gnd' }, xmax: { bc: 'dirichlet', electrode: 'gnd' }, ymin: { bc: 'dirichlet', electrode: 'gnd' }, ymax: { bc: 'dirichlet', electrode: 'gnd' } },
        mirror: { x: false, y: false }, beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' },
    };
    p.electrodes = [{ id: 'gnd', name: 'Ground', ground: true, color: '#64748b' }];
    p.shapes = [];
    p.magnets = [{
        id: 'm1', name: 'Sector field', enabled: true, type: 'region', B: [0, 0, -0.455286],
        region: { type: 'annulus', cx: 0, cy: 0, rIn: 50, rOut: 150, a0: 0, a1: 90 },
    }];
    p.idealFields = [];
    p.sources = [{
        id: 'b1', name: 'Ions m/z 99–101, ±1°', enabled: true, color: 'auto', count: 15, sampling: 'grid', seed: 1,
        species: [{ label: 'm/z 99', mass: 99, charge: 1, fraction: 1 }, { label: 'm/z 100', mass: 100, charge: 1, fraction: 1 }, { label: 'm/z 101', mass: 101, charge: 1, fraction: 1 }],
        position: { type: 'point', p: [100, -100, 0] }, direction: { type: 'fan', axis: [0, 1, 0], normal: [0, 0, 1], from: -1, to: 1, n: 5 },
        energy: { type: 'mono', ke: 1000 }, time: { type: 'fixed', t: 0 },
    }];
    p.recording = {
        planes: [{ id: 'det', name: 'Detector (x = −100 mm)', kind: 'x', at: -100, limits: null, radius: null, terminate: true, side: 'backward', record: 'first' }],
        trajectories: { store: true, maxPoints: 2000 }, timeMarkers: null,
    };
    // 50 µs covers the 8 µs flight; it also keeps the automatic integrator choice on Dormand–Prince (few gyrations)
    p.tracer = { ...p.tracer, tMax: 50 };
    p.view = { ...p.view, center: [0, 0], scale: 1.5,
        layers: { ...p.view.layers, trajectories: 'species' } };
    return p;
}

const SECTOR = 'Exact circular arcs in a hard-edged 90° sector (Barber\'s rule), r = 100 mm for m/z 100 at 1000 eV';

export default Object.freeze({
    id: 'magnetic-sector',
    title: '90° magnetic sector',
    order: 100,
    domainType: 'planar2d',
    tags: ['magnetic'],
    blurb: 'A 90° sector magnet focuses a ±1° fan and separates m/z 99, 100 and 101 by 1 mm.',
    tryThis: 'Change the field strength in the Fields tab and watch the image move; add more masses to the source.',
    build,
    expect: Object.freeze([
        { id: 'image100', label: 'Image of m/z 100 (mean landing y)', metric: 'planeCoord', plane: 'det', coord: 'y', select: { species: 'm/z 100' },
            target: 100.00, tol: 0.3, unit: 'mm', check: 99.985, measured: 99.98479, source: SECTOR },
        { id: 'spread100', label: 'Spread of the m/z 100 fan at the detector', metric: 'planeSpread', plane: 'det', coord: 'y', select: { species: 'm/z 100' },
            max: 0.1, unit: 'mm', check: 0.031, measured: 0.03127083, source: SECTOR },
        { id: 'image99', label: 'Image of m/z 99 (mean landing y)', metric: 'planeCoord', plane: 'det', coord: 'y', select: { species: 'm/z 99' },
            target: 99.0, tol: 0.1, unit: 'mm', check: 98.978, measured: 98.97829, source: SECTOR },
        { id: 'image101', label: 'Image of m/z 101 (mean landing y)', metric: 'planeCoord', plane: 'det', coord: 'y', select: { species: 'm/z 101' },
            target: 101.0, tol: 0.1, unit: 'mm', check: 100.979, measured: 100.9788, source: SECTOR },
    ]),
    guide: null,
});
