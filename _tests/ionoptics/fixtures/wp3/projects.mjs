// WP3 fixtures: one minimal project per preset type of spec §4.14 (P1-P11), written from the descriptions there
// (generic device types, our own dimensions). Used by the WP3 schema, hash, io, pipeline, worker and jobs tests.
// These are not the WP6 presets; they only need to exercise every schema feature a preset type uses.

const ME_U = 9.1093837139e-31 / 1.66053906892e-27;

function base(type, name, preset) {
    return {
        format: 'ion-optics-project', version: 1,
        meta: { name, notes: '', created: '2026-10-12T12:00:00Z', modified: '2026-10-12T12:00:00Z', engine: '0.1.0', preset },
        params: [], domain: null,
        electrodes: [{ id: 'gnd', name: 'Ground', ground: true, color: '#64748b' }],
        shapes: [], magnets: [], idealFields: [], sources: [],
        recording: { planes: [], trajectories: { store: true, maxPoints: 2000 }, timeMarkers: null },
        tracer: { integrator: 'auto', quality: 'normal', custom: null, fieldInterp: 'cubic', relativistic: true, tMax: 1000, maxSteps: 500000, maxDrift: 10000, drag: null },
        solver: { boundary: 'subgrid', method: 'auto', tol: 1e-10, maxCycles: 60, maxIterations: 200, maxSweeps: 100000 },
        analysis: { lens: null, scan: null, optimize: null, waist: null },
        view: { center: [0, 0], scale: 6, displayTime: 0, projection: 'xy', colormap: 'auto', contourLevels: null,
            layers: { potential: true, contours: 20, field: false, electrodes: true, trajectories: 'source', planes: true, hits: true, grid: 'auto', mirror: true, markers: false } },
        _type: type,
    };
}
const gndEdges = (cyl) => ({ xmin: { bc: 'dirichlet', electrode: 'gnd' }, xmax: { bc: 'dirichlet', electrode: 'gnd' },
    ymin: cyl ? { bc: 'axis' } : { bc: 'dirichlet', electrode: 'gnd' }, ymax: { bc: 'dirichlet', electrode: 'gnd' } });
const stop = { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' };
const species = (label, mass, charge = 1, fraction = 1) => ({ label, mass, charge, fraction });

/** P1 Einzel lens: the JSON of spec §2.2.1. */
export function einzel() {
    const p = base('cyl2d', 'Einzel lens', 'einzel');
    p.params = [{ name: 'D', value: 20, dim: 'length', note: 'tube inner diameter' },
        { name: 'Vc', value: 850, dim: 'voltage', slider: { min: -10000, max: 1000, step: 5 } }];
    p.domain = { type: 'cyl2d', cell: 0.25, x: [-60, 140], y: [0, 16], edges: gndEdges(true), mirror: { x: false, y: false },
        beyond: { xmin: 'stop', xmax: 'drift', ymin: 'stop', ymax: 'stop' } };
    p.electrodes.push({ id: 'outer', name: 'Outer tubes', kind: 'solid', v: 0, wave: null, color: '#2563eb' },
        { id: 'centre', name: 'Centre tube', kind: 'solid', v: 'Vc', wave: null, color: '#ea580c' });
    p.shapes = [{ id: 's1', type: 'tube', electrode: 'outer', x0: -55, x1: '-0.3*D', rIn: 'D/2', rOut: 'D/2+1' },
        { id: 's2', type: 'tube', electrode: 'centre', x0: '-0.2*D', x1: '0.2*D', rIn: 'D/2', rOut: 'D/2+1' },
        { id: 's3', type: 'tube', electrode: 'outer', x0: '0.3*D', x1: 55, rIn: 'D/2', rOut: 'D/2+1' }];
    p.sources = [{ id: 'b1', name: 'Parallel beam', enabled: true, color: 'auto', count: 21, sampling: 'grid', seed: 1, species: [species('m/z 100', 100)],
        position: { type: 'line', p0: [-52, -3, 0], p1: [-52, 3, 0], n: 21 }, direction: { type: 'fixed', dir: [1, 0, 0] },
        energy: { type: 'mono', ke: 1000 }, time: { type: 'fixed', t: 0 } }];
    p.recording.planes = [{ id: 'p1', name: 'Image plane', kind: 'x', at: 135, limits: null, radius: null, terminate: true, side: 'forward', record: 'first' }];
    p.tracer.tMax = 1000;
    p.analysis.waist = { plane: 'p1' };
    p.view.center = [40, 0];
    delete p._type;
    return p;
}

/** P2 Two-tube immersion lens, NBS deep-gap geometry. */
export function twoTube() {
    const p = base('cyl2d', 'Two-tube lens', 'two-tube');
    p.domain = { type: 'cyl2d', cell: 0.25, x: [-90, 70], y: [0, 35],
        edges: { xmin: { bc: 'dirichlet', electrode: 'T1' }, xmax: { bc: 'dirichlet', electrode: 'T2' }, ymin: { bc: 'axis' },
            ymax: { bc: 'profile', segments: [{ from: -90, to: -1, electrode: 'T1' }, { from: -1, to: 1, ramp: ['T1', 'T2'] }, { from: 1, to: 70, electrode: 'T2' }] } },
        mirror: { x: false, y: false }, beyond: { xmin: 'stop', xmax: 'drift', ymin: 'stop', ymax: 'stop' } };
    p.electrodes.push({ id: 'T1', name: 'Tube 1', kind: 'solid', v: 0, wave: null, color: '#2563eb' }, { id: 'T2', name: 'Tube 2', kind: 'solid', v: -4000, wave: null, color: '#ea580c' });
    p.shapes = [{ id: 's1', type: 'box', electrode: 'T1', x0: -90, x1: -1, y0: 10, y1: 35 }, { id: 's2', type: 'box', electrode: 'T2', x0: 1, x1: 70, y0: 10, y1: 35 }];
    p.sources = [{ id: 'b1', name: 'Axis point', enabled: true, color: 'auto', count: 11, sampling: 'grid', seed: 1, species: [species('Ar⁺', 39.962)],
        position: { type: 'point', p: [-80, 0, 0] }, direction: { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: -1, to: 1, n: 11 },
        energy: { type: 'mono', ke: 1000 }, time: { type: 'fixed', t: 0 } }];
    p.analysis.lens = { refX: 0, D: 20, xStart: -60, xEnd: 60, mass: 39.962, charge: 1, keLeft: 1000, heights: [0.02, 0.03, 0.04, 0.05, 0.06, 0.08], side: 'both' };
    delete p._type;
    return p;
}

/** P3 Two-aperture lens with zero-thickness apertures. */
export function apertureLens() {
    const p = base('cyl2d', 'Two-aperture lens', 'aperture-lens');
    p.domain = { type: 'cyl2d', cell: 0.25, x: [-80, 80], y: [0, 25],
        edges: { xmin: { bc: 'dirichlet', electrode: 'A1' }, xmax: { bc: 'dirichlet', electrode: 'A2' }, ymin: { bc: 'axis' },
            ymax: { bc: 'profile', segments: [{ from: -80, to: -2.5, electrode: 'A1' }, { from: -2.5, to: 2.5, ramp: ['A1', 'A2'] }, { from: 2.5, to: 80, electrode: 'A2' }] } },
        mirror: { x: false, y: false }, beyond: stop };
    p.electrodes.push({ id: 'A1', name: 'Aperture 1', kind: 'solid', v: 0, wave: null, color: '#2563eb' }, { id: 'A2', name: 'Aperture 2', kind: 'solid', v: -9000, wave: null, color: '#ea580c' });
    p.shapes = [{ id: 's1', type: 'polyline', electrode: 'A1', points: [[-2.5, 5], [-2.5, 25]] }, { id: 's2', type: 'polyline', electrode: 'A2', points: [[2.5, 5], [2.5, 25]] }];
    p.sources = [{ id: 'b1', name: 'Parallel beam', enabled: true, color: 'auto', count: 11, sampling: 'grid', seed: 1, species: [species('m/z 100', 100)],
        position: { type: 'line', p0: [-75, -1, 0], p1: [-75, 1, 0], n: 11 }, direction: { type: 'fixed', dir: [1, 0, 0] },
        energy: { type: 'mono', ke: 1000 }, time: { type: 'fixed', t: 0 } }];
    delete p._type;
    return p;
}

/** P4 Parallel-plate mirror behind a node-aligned mesh. */
export function plateMirror() {
    const p = base('planar2d', 'Parallel-plate mirror', 'plate-mirror');
    p.domain = { type: 'planar2d', cell: 0.25, x: [-10, 70], y: [-10, 22],
        edges: { xmin: { bc: 'neumann' }, xmax: { bc: 'neumann' }, ymin: { bc: 'dirichlet', electrode: 'gnd' }, ymax: { bc: 'dirichlet', electrode: 'back' } },
        mirror: { x: false, y: false }, beyond: stop };
    p.electrodes.push({ id: 'mesh', name: 'Mesh', kind: 'grid', transmission: 1, v: 0, wave: null, color: '#16a34a' },
        { id: 'back', name: 'Back plate', kind: 'solid', v: 1000, wave: null, color: '#ea580c' });
    p.shapes = [{ id: 's1', type: 'polyline', electrode: 'mesh', points: [[-10, 0], [70, 0]] }, { id: 's2', type: 'box', electrode: 'back', x0: -10, x1: 70, y0: 20, y1: 22 }];
    p.sources = [{ id: 'b1', name: 'Fan', enabled: true, color: 'auto', count: 7, sampling: 'grid', seed: 1, species: [species('m/z 100', 100)],
        position: { type: 'point', p: [0, 1e-6, 0] }, direction: { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: 30, to: 60, n: 7 },
        energy: { type: 'mono', ke: 1000 }, time: { type: 'fixed', t: 0 } }];
    p.recording.planes = [{ id: 'mesh0', name: 'Mesh plane', kind: 'y', at: 0, limits: null, radius: null, terminate: false, side: 'backward', record: 'first' },
        { id: 'det', name: 'Detector', kind: 'y', at: -5, limits: null, radius: null, terminate: true, side: 'both', record: 'first' }];
    delete p._type;
    return p;
}

/** P5 127° cylindrical deflector. */
export function cda127() {
    const p = base('planar2d', '127° cylindrical deflector', 'cda-127');
    p.domain = { type: 'planar2d', cell: 0.5, x: [-70, 70], y: [-30, 70], edges: gndEdges(false), mirror: { x: false, y: false }, beyond: stop };
    p.electrodes.push({ id: 'inner', name: 'Inner', kind: 'solid', v: -44.629, wave: null, color: '#2563eb' }, { id: 'outer', name: 'Outer', kind: 'solid', v: 36.464, wave: null, color: '#ea580c' });
    const ray = (deg, r0, r1) => { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return [[r0 * c, r0 * s], [r1 * c, r1 * s]]; };
    p.shapes = [{ id: 's1', type: 'annulus', electrode: 'inner', cx: 0, cy: 0, rIn: 38, rOut: 40, a0: 0, a1: 127.28 },
        { id: 's2', type: 'annulus', electrode: 'outer', cx: 0, cy: 0, rIn: 60, rOut: 62, a0: 0, a1: 127.28 },
        { id: 's3', type: 'polyline', electrode: 'gnd', points: ray(-4, 34, 49) }, { id: 's4', type: 'polyline', electrode: 'gnd', points: ray(-4, 51, 66) },
        { id: 's5', type: 'polyline', electrode: 'gnd', points: ray(131.28, 34, 49) }, { id: 's6', type: 'polyline', electrode: 'gnd', points: ray(131.28, 51, 66) }];
    p.sources = [{ id: 'b1', name: 'Fan', enabled: true, color: 'auto', count: 15, sampling: 'grid', seed: 1, species: [species('m/z 100', 100)],
        position: { type: 'point', p: [50, -2, 0] }, direction: { type: 'fan', axis: [0, 1, 0], normal: [0, 0, 1], from: -2, to: 2, n: 5 },
        energy: { type: 'list', values: [99, 100, 101] }, time: { type: 'fixed', t: 0 } }];
    const c = Math.cos(140 * Math.PI / 180), s = Math.sin(140 * Math.PI / 180);
    p.recording.planes = [{ id: 'det', name: 'Detector', kind: 'segment', p0: [40 * c, 40 * s], p1: [60 * c, 60 * s], limits: null, radius: null, terminate: true, side: 'both', record: 'first' }];
    delete p._type;
    return p;
}

/** P6 Hemispherical analyzer (electrons). */
export function hemisphere() {
    const p = base('cyl2d', 'Hemispherical analyzer', 'hemisphere');
    p.params = [{ name: 'Ep', value: 100, dim: 'energy', note: 'pass energy' }];
    p.domain = { type: 'cyl2d', cell: 0.5, x: [-6, 130], y: [0, 130], edges: gndEdges(true), mirror: { x: false, y: false }, beyond: stop };
    p.electrodes.push({ id: 'inner', name: 'Inner hemisphere', kind: 'solid', v: '2*Ep*(100/80-1)', wave: null, color: '#2563eb' },
        { id: 'outer', name: 'Outer hemisphere', kind: 'solid', v: '2*Ep*(100/120-1)', wave: null, color: '#ea580c' });
    p.shapes = [{ id: 's1', type: 'annulus', electrode: 'inner', cx: 0, cy: 0, rIn: 75, rOut: 80, a0: 0, a1: 90 },
        { id: 's2', type: 'annulus', electrode: 'outer', cx: 0, cy: 0, rIn: 120, rOut: 125, a0: 0, a1: 90 },
        { id: 's3', type: 'box', electrode: 'gnd', x0: -2, x1: -1, y0: 0, y1: 130 },
        { id: 's4', type: 'box', electrode: null, x0: -2, x1: -1, y0: 97, y1: 103 }];
    p.sources = [{ id: 'b1', name: 'Electrons', enabled: true, color: 'auto', count: 15, sampling: 'grid', seed: 1, species: [species('e⁻', ME_U, -1)],
        position: { type: 'point', p: [-3.5, -100, 0] }, direction: { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: -1, to: 1, n: 5 },
        energy: { type: 'list', values: [99, 100, 101] }, time: { type: 'fixed', t: 0 } }];
    p.recording.planes = [{ id: 'det', name: 'Detector', kind: 'x', at: -4.5, limits: null, radius: null, terminate: true, side: 'backward', record: 'first' }];
    delete p._type;
    return p;
}

/** P7 Reflectron TOF (209k nodes, 500 ions). */
export function reflectron() {
    const p = base('planar2d', 'Reflectron TOF', 'reflectron');
    p.params = [{ name: 'Vrep', value: 2400, dim: 'voltage' }, { name: 'Vback', value: 1269.8, dim: 'voltage', slider: { min: 1150, max: 1400, step: 0.5 } }];
    const prof = (side) => ({ bc: 'profile', segments: [{ from: -10, to: 400, electrode: 'gnd' }, { from: 400, to: 600, ramp: ['gnd', 'back'] }, { from: 600, to: 640, electrode: 'back' }] });
    p.domain = { type: 'planar2d', cell: 0.5, x: [-10, 640], y: [-40, 40],
        edges: { xmin: { bc: 'dirichlet', electrode: 'gnd' }, xmax: { bc: 'dirichlet', electrode: 'back' }, ymin: prof('ymin'), ymax: prof('ymax') },
        mirror: { x: false, y: false }, beyond: stop };
    p.electrodes.push({ id: 'rep', name: 'Repeller', kind: 'solid', v: 'Vrep', wave: null, color: '#ea580c' },
        { id: 'ext', name: 'Extraction mesh', kind: 'grid', transmission: 1, v: 0, wave: null, color: '#16a34a' },
        { id: 'ment', name: 'Mirror entrance mesh', kind: 'grid', transmission: 1, v: 0, wave: null, color: '#0891b2' },
        { id: 'back', name: 'Back plate', kind: 'solid', v: 'Vback', wave: null, color: '#9333ea' });
    p.shapes = [{ id: 's1', type: 'box', electrode: 'rep', x0: -4, x1: -2, y0: -38, y1: 38 },
        { id: 's2', type: 'polyline', electrode: 'ext', points: [[10, -40], [10, 40]] },
        { id: 's3', type: 'polyline', electrode: 'ment', points: [[400, -40], [400, 40]] },
        { id: 's4', type: 'box', electrode: 'back', x0: 600, x1: 602, y0: -40, y1: 40 }];
    p.sources = [{ id: 'b1', name: 'Ions', enabled: true, color: 'auto', count: 500, sampling: 'random', seed: 1, species: [species('m 100', 100), species('m 101', 101)],
        position: { type: 'rect', center: [4, 0, 0], u: [1, 0, 0], v: [0, 1, 0], halfU: 0.1, halfV: 1 }, direction: { type: 'fixed', dir: [0, 1, 0] },
        energy: { type: 'mono', ke: 0.5 }, time: { type: 'fixed', t: 0 } }];
    p.recording.planes = [{ id: 'det', name: 'Detector', kind: 'segment', p0: [22, 20], p1: [22, 39], limits: null, radius: null, terminate: true, side: 'both', record: 'first' }];
    p.analysis.scan = { variable: { kind: 'param', id: 'Vback' }, values: { from: 1250, to: 1290, n: 9 }, metric: { type: 'resolvingPower', plane: 'det' } };
    delete p._type;
    return p;
}

/** P8 RF quadrupole cross-section (quarter domain, two mirrors, quadric rods, one RF channel). */
export function rfQuadrupole() {
    const p = base('planar2d', 'RF quadrupole', 'rf-quadrupole');
    p.params = [{ name: 'V', value: 136.783, dim: 'voltage' }, { name: 'Uratio', value: 0.15945, dim: 'none' }, { name: 'U', value: 'Uratio*V', dim: 'voltage' }];
    p.domain = { type: 'planar2d', cell: 0.1, x: [0, 14], y: [0, 14],
        edges: { xmin: { bc: 'neumann' }, xmax: { bc: 'dirichlet', electrode: 'gnd' }, ymin: { bc: 'neumann' }, ymax: { bc: 'dirichlet', electrode: 'gnd' } },
        mirror: { x: true, y: true }, beyond: stop };
    p.electrodes.push({ id: 'rodsX', name: 'X rods', kind: 'solid', v: 'U', wave: { terms: [{ type: 'cos', amp: '-V', freq: 1.1, phase: 0 }] }, color: '#2563eb' },
        { id: 'rodsY', name: 'Y rods', kind: 'solid', v: '-U', wave: { terms: [{ type: 'cos', amp: 'V', freq: 1.1, phase: 0 }] }, color: '#ea580c' });
    p.shapes = [{ id: 's1', type: 'quadric', electrode: 'rodsX', A: 1, B: -1, C: 16, cx: 0, cy: 0, clip: [0, 11.2, 0, 11.2] },
        { id: 's2', type: 'quadric', electrode: 'rodsY', A: -1, B: 1, C: 16, cx: 0, cy: 0, clip: [0, 11.2, 0, 11.2] }];
    p.sources = [{ id: 'b1', name: 'Ions', enabled: true, color: 'auto', count: 300, sampling: 'random', seed: 1,
        species: [species('m 90', 90), species('m 100', 100), species('m 110', 110)],
        position: { type: 'disc', center: [0, 0, 0], normal: [0, 0, 1], radius: 0.3 }, direction: { type: 'fixed', dir: [0, 0, 1] },
        energy: { type: 'mono', ke: 10 }, time: { type: 'rfPhase', freq: 1.1 } }];
    p.recording.planes = [{ id: 'det', name: 'Detector', kind: 'z', at: 320, limits: null, radius: null, terminate: true, side: 'forward', record: 'first' }];
    p.tracer.tMax = 200;
    delete p._type;
    return p;
}

/** P9 Paul trap (cylindrical with mirror x, quadric ring and end cap, RF on the ring). */
export function paulTrap() {
    const p = base('cyl2d', 'Paul trap', 'paul-trap');
    p.domain = { type: 'cyl2d', cell: 0.1, x: [0, 15], y: [0, 15],
        edges: { xmin: { bc: 'neumann' }, xmax: { bc: 'dirichlet', electrode: 'gnd' }, ymin: { bc: 'axis' }, ymax: { bc: 'dirichlet', electrode: 'gnd' } },
        mirror: { x: true, y: false }, beyond: stop };
    p.electrodes.push({ id: 'ring', name: 'Ring', kind: 'solid', v: 0, wave: { terms: [{ type: 'cos', amp: 500, freq: 1.0, phase: 0 }] }, color: '#2563eb' });
    p.shapes = [{ id: 's1', type: 'quadric', electrode: 'ring', A: -2, B: 1, C: 49.985, cx: 0, cy: 0, clip: [0, 15, 0, 15] },
        { id: 's2', type: 'quadric', electrode: 'gnd', A: 2, B: -1, C: 50, cx: 0, cy: 0, clip: [0, 15, 0, 15] }];
    p.sources = [{ id: 'b1', name: 'Ions', enabled: true, color: 'auto', count: 100, sampling: 'random', seed: 1,
        species: [species('m 120', 120), species('m 100', 100)],
        position: { type: 'gaussian', center: [0, 0, 0], sigma: [0.2, 0.2, 0.2] }, direction: { type: 'isotropic', axis: [1, 0, 0], beta: 0 },
        energy: { type: 'mono', ke: 0.05 }, time: { type: 'rfPhase', freq: 1.0 } }];
    p.tracer.tMax = 200;
    delete p._type;
    return p;
}

/** P10 Magnetic sector (no electrodes besides ground: nothing is solved). */
export function magneticSector() {
    const p = base('planar2d', 'Magnetic sector', 'magnetic-sector');
    p.domain = { type: 'planar2d', cell: 1, x: [-150, 150], y: [-150, 150], edges: gndEdges(false), mirror: { x: false, y: false }, beyond: stop };
    p.magnets = [{ id: 'm1', name: 'Sector field', enabled: true, type: 'region', B: [0, 0, -0.455286], region: { type: 'annulus', cx: 0, cy: 0, rIn: 50, rOut: 150, a0: 0, a1: 90 } }];
    p.sources = [{ id: 'b1', name: 'Ions', enabled: true, color: 'auto', count: 15, sampling: 'grid', seed: 1,
        species: [species('m 99', 99), species('m 100', 100), species('m 101', 101)],
        position: { type: 'point', p: [100, -100, 0] }, direction: { type: 'fan', axis: [0, 1, 0], normal: [0, 0, 1], from: -1, to: 1, n: 5 },
        energy: { type: 'mono', ke: 1000 }, time: { type: 'fixed', t: 0 } }];
    p.recording.planes = [{ id: 'det', name: 'Detector', kind: 'x', at: -100, limits: null, radius: null, terminate: true, side: 'backward', record: 'first' }];
    delete p._type;
    return p;
}

/** P11 Velocity-map imaging lens (three plates, grid sampling with class indices). */
export function vmi() {
    const p = base('cyl2d', 'Velocity-map imaging lens', 'vmi');
    p.params = [{ name: 'Vrep', value: 3000, dim: 'voltage' }, { name: 'ratio', value: 0.695, dim: 'none', slider: { min: 0.55, max: 0.85, step: 0.005 } }];
    p.domain = { type: 'cyl2d', cell: 0.25, x: [-5, 155], y: [0, 50], edges: gndEdges(true), mirror: { x: false, y: false },
        beyond: { xmin: 'stop', xmax: 'drift', ymin: 'stop', ymax: 'stop' } };
    p.electrodes.push({ id: 'rep', name: 'Repeller', kind: 'solid', v: 'Vrep', wave: null, color: '#ea580c' },
        { id: 'ext', name: 'Extractor', kind: 'solid', v: 'ratio*Vrep', wave: null, color: '#2563eb' });
    p.shapes = [{ id: 's1', type: 'plate', electrode: 'rep', x: -0.5, t: 1, rHole: 0, rOut: 40 },
        { id: 's2', type: 'plate', electrode: 'ext', x: 15.5, t: 1, rHole: 10, rOut: 40 },
        { id: 's3', type: 'plate', electrode: 'gnd', x: 30.5, t: 1, rHole: 10, rOut: 40 }];
    p.sources = [{ id: 'b1', name: 'Fragments', enabled: true, color: 'auto', count: 0, sampling: 'grid', seed: 1, species: [species('O⁺', 15.995)],
        position: { type: 'rect', center: [7.5, 0, 0], u: [1, 0, 0], v: [0, 1, 0], halfU: 0.5, halfV: 1.0, n: [3, 5] },
        direction: { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: 0, to: 330, n: 12 },
        energy: { type: 'list', values: [1, 2] }, time: { type: 'fixed', t: 0 } }];
    p.recording.planes = [{ id: 'det', name: 'Detector', kind: 'x', at: 400, limits: null, radius: 45, terminate: true, side: 'forward', record: 'first' }];
    p.analysis.optimize = { variables: [{ kind: 'param', id: 'ratio', lower: 0.6, upper: 0.8, step: 0.01 }], metric: { type: 'groupedBlur', plane: 'det' }, goal: 'min', maxEval: 40 };
    delete p._type;
    return p;
}

/** Every fixture by preset id. */
export const FIXTURES = Object.freeze({
    einzel, 'two-tube': twoTube, 'aperture-lens': apertureLens, 'plate-mirror': plateMirror, 'cda-127': cda127, hemisphere,
    reflectron, 'rf-quadrupole': rfQuadrupole, 'paul-trap': paulTrap, 'magnetic-sector': magneticSector, vmi,
});
