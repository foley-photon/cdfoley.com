/* ==========================================================================
   Ion optics engine: schema.js
   Project JSON (version 1): defaults, UI form descriptors (META), migration,
   validation and resolution into a numbers-only "resolved" project
   (spec §2.2).

   resolve = migrate → validate → parameters → expressions → ids to indices
   (gnd = 0) → grid sizes (nx = round((x1 − x0)/h) + 1; an edge moved by more
   than 1e-6 cell gives W_EXTENT_ROUNDED and the resolved x1 = x0 + (nx − 1)h)
   → drop disabled items → particle counts. validate() runs the same pass, so
   the two always agree. Neither throws on user error. Unknown keys are kept.

   Sources: the physical rules checked here are those of the specification
   (§2.2.2, §2.2.4); the particle-count rules follow the Cartesian-product
   definition of grid sampling (§2.2.2); emission anisotropy bounds
   −1 ≤ β ≤ 2 keep 1 + β·P₂(cos θ) ≥ 0 (Zare, Mol. Photochem. 4, 1 (1972)).
   ========================================================================== */
import { EngineError, evaluateParams, parseExpr, isIdentifier } from './expr.js';
import { ENGINE_VERSION, PROJECT_FORMAT } from './version.js';
import { C_MMUS, K_ACC, UC2_EV } from './constants.js';

export { EngineError };

/** Current project schema version. */
export const SCHEMA_VERSION = 1;

/** Allowed values of every enumerated field. */
export const ENUMS = Object.freeze({
    domainType: ['planar2d', 'cyl2d'],
    bc: ['dirichlet', 'neumann', 'axis', 'profile'],
    beyond: ['stop', 'drift'],
    electrodeKind: ['solid', 'grid'],
    termType: ['cos', 'pulse', 'table'],
    shapeType: ['box', 'tube', 'plate', 'disc', 'circle', 'annulus', 'polygon', 'polyline', 'quadric'],
    mirror: ['none', 'x', 'y', 'xy'],
    magnetType: ['uniform', 'region', 'loop', 'poles'],
    regionType: ['box', 'polygon', 'annulus'],
    poleBoundary: ['neumann', 'zero'],
    idealType: ['uniformE', 'quadrupole2d', 'quadrupole3d', 'coax', 'sphere'],
    sourceType: ['sampled', 'rows'],
    sampling: ['random', 'grid'],
    positionType: ['point', 'line', 'disc', 'rect', 'gaussian', 'list'],
    directionType: ['fixed', 'cone', 'fan', 'isotropic'],
    coneFill: ['solid', 'angle', 'lambert'],
    energyType: ['mono', 'uniform', 'gaussian', 'list'],
    timeType: ['fixed', 'uniform', 'rfPhase', 'list'],
    planeKind: ['x', 'y', 'z', 'r', 'segment', 'sphere'],
    side: ['both', 'forward', 'backward'],
    spaceChargeModel: ['coulomb'],
    gasModel: ['hardSphere'],
    record: ['first', 'all'],
    integrator: ['auto', 'rk45', 'boris', 'rk4'],
    quality: ['draft', 'normal', 'fine', 'custom'],
    fieldInterp: ['cubic', 'linear'],
    boundary: ['subgrid', 'staircase'],
    method: ['auto', 'multigrid', 'krylov', 'sor'],
    dim: ['length', 'voltage', 'energy', 'mass', 'charge', 'angle', 'time', 'freq', 'field', 'none'],
    projection: ['xy', 'xrho'],
    colormap: ['auto', 'diverging', 'viridis', 'cividis', 'gray'],
    trajColor: ['source', 'species', 'energy', 'status', 'time'],
    metricType: ['transmission', 'spotRms', 'waistPos', 'meanTof', 'tofFwhm', 'resolvingPower', 'meanKE', 'groupedBlur'],
    variableKind: ['param', 'electrode', 'sourceEnergy'],
    goal: ['min', 'max'],
    lensSide: ['both', 'left', 'right'],
});

/** Limits (spec §2.2.4). Phone = width < 760 px or deviceMemory ≤ 2. */
export const LIMITS = Object.freeze({
    desktop: Object.freeze({ warnNodes: 1e6, maxNodes: 4e6, maxParticles: 1e6, pointBudget: 2e6, warnMemMB: 600, maxMemMB: 1500 }),
    mobile: Object.freeze({ warnNodes: 4e5, maxNodes: 4e5, maxParticles: 2e4, pointBudget: 2e5, warnMemMB: 300, maxMemMB: 300 }),
    electrodes: 32, shapes: 2000, sources: 50, planes: 32, magnets: 32, idealFields: 32, params: 500,
    timeChannels: 7,           // waveform channels besides DC (8 including DC)
    projectBytes: 5 * 1024 * 1024, linkBytes: 64 * 1024,
    polygonPoints: 100000, listItems: 1000000, tableKnots: 100000,
    rows: 1000000,             // particle rows of one 'rows' source (the particle limit above also applies)
    poles: 64,                 // pole pieces of one 'poles' magnet
    spaceChargeParticles: 2000,   // direct-summation space charge (coulomb.js)
});

/** Tracer quality presets (spec §3.8): rtol, maxStepCells, nearStepCells, rfStepsPerPeriod, borisStepsPerGyration. */
export const QUALITY = Object.freeze({
    draft: Object.freeze({ rtol: 1e-6, maxStepCells: 1.0, nearStepCells: 0.25, rfStepsPerPeriod: 24, borisStepsPerGyration: 64 }),
    normal: Object.freeze({ rtol: 1e-8, maxStepCells: 0.5, nearStepCells: 0.1, rfStepsPerPeriod: 32, borisStepsPerGyration: 128 }),
    fine: Object.freeze({ rtol: 1e-10, maxStepCells: 0.25, nearStepCells: 0.05, rfStepsPerPeriod: 64, borisStepsPerGyration: 256 }),
});

const HAS = Object.prototype.hasOwnProperty;
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ======================================================================== defaults

const ELECTRODE_COLORS = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#dc2626', '#0891b2', '#ca8a04', '#db2777'];

function nowISO() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function defaultDomain(type) {
    const cyl = type !== 'planar2d';
    return {
        type: cyl ? 'cyl2d' : 'planar2d', cell: 0.25, x: [-50, 50], y: cyl ? [0, 20] : [-20, 20],
        edges: {
            xmin: { bc: 'dirichlet', electrode: 'gnd' }, xmax: { bc: 'dirichlet', electrode: 'gnd' },
            ymin: cyl ? { bc: 'axis' } : { bc: 'dirichlet', electrode: 'gnd' }, ymax: { bc: 'dirichlet', electrode: 'gnd' },
        },
        mirror: { x: false, y: false },
        antimirror: { x: false, y: false },
        charge: '',
        beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' },
    };
}

function defaultView(type) {
    return {
        center: [0, type === 'planar2d' ? 0 : 0], scale: 6, displayTime: 0, projection: 'xy', colormap: 'auto', contourLevels: null,
        layers: { potential: true, contours: 20, field: false, electrodes: true, trajectories: 'source', planes: true, hits: true, grid: 'auto', mirror: true, markers: false },
    };
}

const DEFAULT_SHAPES = {
    box: { x0: -5, x1: 5, y0: 5, y1: 7 },
    tube: { x0: -10, x1: 10, rIn: 5, rOut: 6 },
    plate: { x: 0, t: 1, rHole: 2, rOut: 10 },
    disc: { x: 0, t: 1, r: 5 },
    circle: { cx: 0, cy: 5, r: 1 },
    annulus: { cx: 0, cy: 0, rIn: 8, rOut: 10, a0: 0, a1: 90 },
    polygon: { points: [[-2, 4], [2, 4], [0, 7]] },
    polyline: { points: [[0, 0], [0, 10]] },
    quadric: { A: 1, B: -1, C: 16, cx: 0, cy: 0, clip: [0, 10, 0, 10] },
};

const DEFAULT_TERMS = {
    cos: { type: 'cos', amp: 100, freq: 1, phase: 0 },
    pulse: { type: 'pulse', amp: 100, t0: 0, rise: 0.01, width: 1, fall: 0.01, period: null },
    table: { type: 'table', points: [[0, 0], [1, 100]], period: null },
};

const DEFAULT_MAGNETS = {
    uniform: (cyl) => ({ id: 'm1', name: 'Uniform field', enabled: true, type: 'uniform', B: cyl ? [0.01, 0, 0] : [0, 0, 0.01] }),
    region: (cyl) => ({ id: 'm1', name: 'Field region', enabled: true, type: 'region', B: cyl ? [0.01, 0, 0] : [0, 0, 0.01],
        region: { type: 'box', x0: -10, x1: 10, y0: cyl ? 0 : -10, y1: 10 } }),
    loop: () => ({ id: 'm1', name: 'Current loop', enabled: true, type: 'loop', center: [0, 0, 0], normal: [1, 0, 0], radius: 10, turns: 1, current: 1 }),
    poles: (cyl) => ({ id: 'm1', name: 'Pole pieces', enabled: true, type: 'poles', boundary: 'neumann',
        pieces: [{ region: { type: 'box', x0: -10, x1: 10, y0: 5, y1: 8 }, psi: 1 }, { region: { type: 'box', x0: -10, x1: 10, y0: cyl ? 12 : -8, y1: cyl ? 15 : -5 }, psi: cyl ? 0 : -1 }] }),
};
const DEFAULT_POLE = { region: { type: 'box', x0: -10, x1: 10, y0: 5, y1: 8 }, psi: 1 };

/** One particle row of a 'rows' source: [mass u, charge e, x, y, z mm, dx, dy, dz, KE eV, t0 µs] (velocity rows: [m, q, x, y, z, vx, vy, vz mm/µs, t0]). */
export const ROW_COLUMNS = Object.freeze(['mass', 'charge', 'x', 'y', 'z', 'dx', 'dy', 'dz', 'ke', 't0']);
export const ROW_COLUMNS_VELOCITY = Object.freeze(['mass', 'charge', 'x', 'y', 'z', 'vx', 'vy', 'vz', 't0']);
const DEFAULT_ROW = [100, 1, 0, 0, 0, 1, 0, 0, 100, 0];

const DEFAULT_REGIONS = {
    box: { type: 'box', x0: -10, x1: 10, y0: 0, y1: 10 },
    polygon: { type: 'polygon', points: [[0, 0], [20, 0], [0, 20]] },
    annulus: { type: 'annulus', cx: 0, cy: 0, rIn: 50, rOut: 150, a0: 0, a1: 90 },
};

const DEFAULT_IDEAL = {
    uniformE: { id: 'f1', enabled: true, type: 'uniformE', E: [1, 0, 0], ref: [0, 0, 0], box: null },
    quadrupole2d: { id: 'f1', enabled: true, type: 'quadrupole2d', center: [0, 0], r0: 4, U: 0, V: 100, freq: 1, phase: 0 },
    quadrupole3d: { id: 'f1', enabled: true, type: 'quadrupole3d', center: [0, 0, 0], r0: 7, z0: 5, U: 0, V: 100, freq: 1, phase: 0 },
    coax: { id: 'f1', enabled: true, type: 'coax', center: [0, 0], a: 10, b: 20, Va: 100, Vb: 0 },
    sphere: { id: 'f1', enabled: true, type: 'sphere', center: [0, 0, 0], R1: 10, R2: 20, V1: 100, V2: 0 },
};

const DEFAULT_POSITION = {
    point: { type: 'point', p: [0, 0, 0] },
    line: { type: 'line', p0: [0, -1, 0], p1: [0, 1, 0], n: 5 },
    disc: { type: 'disc', center: [0, 0, 0], normal: [1, 0, 0], radius: 1, n: 7 },
    rect: { type: 'rect', center: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], halfU: 1, halfV: 1, n: [3, 3] },
    gaussian: { type: 'gaussian', center: [0, 0, 0], sigma: [0.1, 0.1, 0.1] },
    list: { type: 'list', points: [[0, 0, 0]] },
};
const DEFAULT_DIRECTION = {
    fixed: { type: 'fixed', dir: [1, 0, 0] },
    cone: { type: 'cone', axis: [1, 0, 0], halfAngle: 5, fill: 'solid', n: 7 },
    fan: { type: 'fan', axis: [1, 0, 0], normal: [0, 0, 1], from: -5, to: 5, n: 5 },
    isotropic: { type: 'isotropic', axis: [1, 0, 0], beta: 0, n: 20 },
};
const DEFAULT_ENERGY = {
    mono: { type: 'mono', ke: 100 },
    uniform: { type: 'uniform', min: 90, max: 110, n: 3 },
    gaussian: { type: 'gaussian', mean: 100, fwhm: 1 },
    list: { type: 'list', values: [100] },
};
const DEFAULT_TIME = {
    fixed: { type: 'fixed', t: 0 },
    uniform: { type: 'uniform', t0: 0, t1: 1, n: 3 },
    rfPhase: { type: 'rfPhase', freq: 1, n: 8 },
    list: { type: 'list', values: [0] },
};

/**
 * A fresh object of the given kind, valid in a new project of `domainType`.
 * Kinds: 'project', 'meta', 'param', 'domain', 'edge', 'segment', 'electrode', 'gnd', 'transform',
 * '<shape type>' or 'shape.<type>', 'term' / 'term.<cos|pulse|table>', 'magnet' / 'magnet.<type>',
 * 'region.<type>', 'idealField' / 'ideal.<type>', 'source', 'species', 'position.<type>',
 * 'direction.<type>', 'energy.<type>', 'time.<type>', 'source.rows' / 'rows' / 'row' (particle lists), 'plane',
 * 'recording', 'trajectories', 'timeMarkers', 'tracer', 'custom', 'drag', 'spaceCharge', 'gas', 'antimirror', 'pole',
 * 'solver', 'analysis', 'lens', 'scan', 'optimize', 'waist', 'metric', 'view', 'layers', 'slider'.
 * @param {string} kind @param {'planar2d'|'cyl2d'} [domainType]
 * @returns {object}
 */
export function defaults(kind, domainType = 'cyl2d') {
    const type = domainType === 'planar2d' ? 'planar2d' : 'cyl2d';
    const cyl = type === 'cyl2d';
    let k = String(kind || '');
    if (k.startsWith('shape.')) k = k.slice(6);
    if (ENUMS.shapeType.includes(k)) {
        return { id: 's1', type: k, electrode: 'gnd', enabled: true, locked: false, ...clone(DEFAULT_SHAPES[k]) };
    }
    const dot = k.indexOf('.');
    const head = dot >= 0 ? k.slice(0, dot) : k, tail = dot >= 0 ? k.slice(dot + 1) : '';
    switch (head) {
        case 'project': return newProject(type);
        case 'meta': { const t = nowISO(); return { name: 'Untitled project', notes: '', created: t, modified: t, engine: ENGINE_VERSION }; }
        case 'param': return { name: 'p1', value: 0, dim: 'none', note: '' };
        case 'slider': return { min: 0, max: 100, step: 1 };
        case 'domain': return defaultDomain(type);
        case 'edge': return { bc: 'dirichlet', electrode: 'gnd' };
        case 'segment': return { from: 0, to: 1, electrode: 'gnd' };
        case 'electrode': return { id: 'e1', name: 'Electrode 1', kind: 'solid', v: 0, wave: null, color: ELECTRODE_COLORS[0] };
        case 'gnd': return { id: 'gnd', name: 'Ground', ground: true, color: '#64748b' };
        case 'transform': return { translate: [0, 0], rotate: 0, about: [0, 0], mirror: 'none' };
        case 'term': return clone(DEFAULT_TERMS[tail] || DEFAULT_TERMS.cos);
        case 'wave': return { terms: [clone(DEFAULT_TERMS.cos)] };
        case 'magnet': return (DEFAULT_MAGNETS[tail] || DEFAULT_MAGNETS.uniform)(cyl);
        case 'region': return clone(DEFAULT_REGIONS[tail] || DEFAULT_REGIONS.box);
        case 'idealField': case 'ideal': return clone(DEFAULT_IDEAL[tail] || DEFAULT_IDEAL.uniformE);
        case 'source':
            if (tail === 'rows') return { id: 'b1', name: 'Particle list', enabled: true, color: 'auto', type: 'rows', weight: 1, species: [], velocity: false, rows: [DEFAULT_ROW.slice()] };
            return {
                id: 'b1', name: 'Beam 1', enabled: true, color: 'auto', type: 'sampled', weight: 1, count: 10, sampling: 'random', seed: 1,
                species: [{ label: 'm/z 100', mass: 100, charge: 1, fraction: 1 }],
                position: clone(DEFAULT_POSITION.point), direction: clone(DEFAULT_DIRECTION.fixed),
                energy: clone(DEFAULT_ENERGY.mono), time: clone(DEFAULT_TIME.fixed),
            };
        case 'rows': return { type: 'rows', weight: 1, species: [], velocity: false, rows: [DEFAULT_ROW.slice()] };
        case 'row': return DEFAULT_ROW.slice();
        case 'species': return { label: 'm/z 100', mass: 100, charge: 1, fraction: 1 };
        case 'position': return clone(DEFAULT_POSITION[tail] || DEFAULT_POSITION.point);
        case 'direction': return clone(DEFAULT_DIRECTION[tail] || DEFAULT_DIRECTION.fixed);
        case 'energy': return clone(DEFAULT_ENERGY[tail] || DEFAULT_ENERGY.mono);
        case 'time': return clone(DEFAULT_TIME[tail] || DEFAULT_TIME.fixed);
        case 'plane': return { id: 'p1', name: 'Plane 1', kind: 'x', at: 0, limits: null, radius: null, terminate: false, side: 'both', record: 'first' };
        case 'recording': return { planes: [], trajectories: { store: true, maxPoints: 2000 }, timeMarkers: null };
        case 'trajectories': return { store: true, maxPoints: 2000 };
        case 'timeMarkers': return { dt: 0.1 };
        case 'tracer': return { integrator: 'auto', quality: 'normal', custom: null, fieldInterp: 'cubic', relativistic: true, tMax: 1000, maxSteps: 500000, maxDrift: 10000, drag: null, spaceCharge: null, gas: null };
        case 'custom': return { ...QUALITY.normal };
        case 'drag': return { type: 'stokes', mobility: 1, gasVelocity: [0, 0, 0] };
        case 'spaceCharge': return { enabled: true, model: 'coulomb', softening: 1e-4, maxParticles: LIMITS.spaceChargeParticles, factor: 1 };
        case 'gas': return { enabled: true, model: 'hardSphere', pressure: 0.1, temperature: 293.15, mass: 4.002602, diameter: 2.2, ionDiameter: null, velocity: [0, 0, 0] };
        case 'pole': return clone(DEFAULT_POLE);
        case 'antimirror': return { x: false, y: false };
        case 'solver': return { boundary: 'subgrid', method: 'auto', tol: 1e-10, maxCycles: 60, maxIterations: 200, maxSweeps: 100000 };
        case 'analysis': return { lens: null, scan: null, optimize: null, waist: null };
        case 'lens': return { refX: 0, D: 10, xStart: -40, xEnd: 40, mass: 100, charge: 1, keLeft: 1000, heights: [0.02, 0.03, 0.04, 0.05, 0.06, 0.08], side: 'both' };
        case 'metric': return { type: 'transmission', plane: null };
        case 'scan': return { variable: { kind: 'param', id: null }, values: { from: 0, to: 1, n: 11 }, metric: { type: 'transmission', plane: null } };
        case 'optimize': return { variables: [], metric: { type: 'spotRms', plane: null }, goal: 'min', maxEval: 60 };
        case 'waist': return { plane: null };
        case 'view': return defaultView(type);
        case 'layers': return defaultView(type).layers;
        default: throw new EngineError('E_INTERNAL', `Unknown kind "${kind}"`);
    }
}

/**
 * A minimal valid project: the ground electrode, an empty geometry, default settings.
 * @param {'planar2d'|'cyl2d'} [domainType]
 */
export function newProject(domainType = 'cyl2d') {
    const type = domainType === 'planar2d' ? 'planar2d' : 'cyl2d';
    return {
        format: PROJECT_FORMAT, version: SCHEMA_VERSION,
        meta: defaults('meta', type),
        params: [],
        domain: defaultDomain(type),
        electrodes: [defaults('gnd', type)],
        shapes: [], magnets: [], idealFields: [], sources: [],
        recording: defaults('recording', type),
        tracer: defaults('tracer', type),
        solver: defaults('solver', type),
        analysis: defaults('analysis', type),
        view: defaultView(type),
    };
}

/**
 * The first id `prefix<n>` not used in `list` (objects with `id`). For new electrodes, shapes, sources, planes.
 * @param {Array<{id?: string}>} list @param {string} prefix
 */
export function nextId(list, prefix) {
    const used = new Set((list || []).map((o) => o && o.id));
    for (let n = 1; ; n++) if (!used.has(prefix + n)) return prefix + n;
}

// ======================================================================== META (UI form descriptors)

const opt = (values, labels) => values.map((v, i) => ({ value: v, label: labels ? labels[i] : v }));
const N = (key, label, dim, help, o) => ({ key, label, dim, kind: 'number', help, ...(o || {}) });
const I = (key, label, help, o) => ({ key, label, dim: 'none', kind: 'int', help, ...(o || {}) });
const B = (key, label, help, o) => ({ key, label, dim: 'none', kind: 'bool', help, ...(o || {}) });
const T = (key, label, help, o) => ({ key, label, dim: 'none', kind: 'text', help, ...(o || {}) });
const TA = (key, label, help, o) => ({ key, label, dim: 'none', kind: 'textarea', help, ...(o || {}) });
const C = (key, label, help, o) => ({ key, label, dim: 'none', kind: 'color', help, ...(o || {}) });
const S = (key, label, options, help, o) => ({ key, label, dim: 'none', kind: 'select', options, help, ...(o || {}) });
const EL = (key, label, help, o) => ({ key, label, dim: 'none', kind: 'electrode', ref: 'electrode', help, ...(o || {}) });
const V = (key, label, dim, size, help, o) => ({ key, label, dim, kind: `vec${size}`, size, help, ...(o || {}) });
const R2 = (key, label, dim, help, o) => ({ key, label, dim, kind: 'range2', size: 2, help, ...(o || {}) });
const PS = (key, label, dims, minItems, help, o) => ({ key, label, dim: dims[0], dims, kind: 'points', size: dims.length, min: minItems, minItems, help, ...(o || {}) });
const LIST = (key, label, dim, help, o) => ({ key, label, dim, kind: 'list', size: 1, min: 1, minItems: 1, help, ...(o || {}) });
const REF = (key, label, ref, help, o) => ({ key, label, dim: 'none', kind: 'select', options: null, ref, help, ...(o || {}) });

const SHAPE_META = {
    box: [N('x0', 'x start', 'length', 'Left edge.'), N('x1', 'x end', 'length', 'Right edge.'),
        N('y0', 'y or r start', 'length', 'Lower edge (inner radius when revolved).'), N('y1', 'y or r end', 'length', 'Upper edge (outer radius when revolved).')],
    tube: [N('x0', 'x start', 'length', 'Tube start.'), N('x1', 'x end', 'length', 'Tube end.'),
        N('rIn', 'Inner radius', 'length', 'Inner radius (half-gap in planar domains).', { min: 0 }), N('rOut', 'Outer radius', 'length', 'Outer radius.', { min: 0 })],
    plate: [N('x', 'Position x', 'length', 'Center of the plate.'), N('t', 'Thickness', 'length', 'Plate thickness.', { min: 0 }),
        N('rHole', 'Hole radius', 'length', 'Aperture radius (half-width of the slit in planar domains).', { min: 0 }), N('rOut', 'Outer radius', 'length', 'Outer radius.', { min: 0 })],
    disc: [N('x', 'Position x', 'length', 'Center of the disc.'), N('t', 'Thickness', 'length', 'Disc thickness.', { min: 0 }), N('r', 'Radius', 'length', 'Disc radius.', { min: 0 })],
    circle: [N('cx', 'Center x', 'length', 'Center x.'), N('cy', 'Center y or r', 'length', 'Center y (r when revolved; a sphere if 0).'), N('r', 'Radius', 'length', 'Radius.', { min: 0 })],
    annulus: [N('cx', 'Center x', 'length', 'Center x.'), N('cy', 'Center y or r', 'length', 'Center y (r when revolved; a spherical shell if 0).'),
        N('rIn', 'Inner radius', 'length', 'Inner radius.', { min: 0 }), N('rOut', 'Outer radius', 'length', 'Outer radius.', { min: 0 }),
        N('a0', 'Start angle', 'angle', 'Sector start, degrees counter-clockwise from +x.'), N('a1', 'End angle', 'angle', 'Sector end, degrees counter-clockwise from +x.')],
    polygon: [PS('points', 'Vertices (x, y per line)', ['length', 'length'], 3, 'Closed outline (at least 3 vertices; even–odd rule).')],
    polyline: [PS('points', 'Points (x, y per line)', ['length', 'length'], 2, 'Open zero-thickness line (at least 2 points): a sheet or a mesh line.')],
    quadric: [N('A', 'A', 'none', 'Coefficient of (x − cx)².'), N('B', 'B', 'none', 'Coefficient of (y − cy)².'), N('C', 'C', 'none', 'Inside where A(x−cx)² + B(y−cy)² ≥ C.'),
        N('cx', 'Center x', 'length', 'Center x.'), N('cy', 'Center y', 'length', 'Center y.'),
        V('clip', 'Clip box [x0, x1, y0, y1]', 'length', 4, 'Only the part inside this box (it selects the branch).')],
};

const PLANE_AXIAL = ['x', 'y', 'z', 'r'];
const CUSTOM_META = [N('rtol', 'Relative tolerance', 'none', 'Error tolerance per step.', { gt: 0, max: 0.01 }),
    N('maxStepCells', 'Max step (cells)', 'none', 'At most 1 cell.', { gt: 0, max: 1 }),
    N('nearStepCells', 'Max step near electrodes (cells)', 'none', 'At most the maximum step.', { gt: 0, max: 1 }),
    N('rfStepsPerPeriod', 'Steps per RF period', 'none', 'Step limit in time-dependent fields.', { gt: 0 }),
    N('borisStepsPerGyration', 'Boris steps per gyration', 'none', 'Step count per cyclotron period.', { gt: 0 }),
    N('dt', 'Fixed step (RK4)', 'time', 'Optional fixed time step.', { nullable: true, gt: 0 })];
const SPACE_CHARGE_META = [B('enabled', 'Space charge on', 'Particle–particle Coulomb forces by direct summation: an onset estimator, not a self-consistent solution.'),
    S('model', 'Model', opt(ENUMS.spaceChargeModel, ['Coulomb (pairwise)']), 'Pairwise forces between the particles in flight at the same time.'),
    N('softening', 'Softening ε', 'length', 'Plummer softening length of the pair force. For a beam about a tenth of the mean particle spacing (halve it to check); for a few-body problem far below the separation.', { gt: 0 }),
    I('maxParticles', 'Particle cap', `Direct summation is limited to ${LIMITS.spaceChargeParticles} particles per run.`, { min: 1, max: LIMITS.spaceChargeParticles }),
    N('factor', 'Charge factor', 'none', 'Multiplies every particle\'s charge in the pair forces (each simulated particle stands for this many).', { min: 0 }),
    N('pairStep', 'Pair step', 'none', 'Fraction of the smallest pair time scale per lockstep step (empty: 0.05 draft, 0.02 normal, 0.005 fine).', { nullable: true, gt: 0, max: 0.5 })];
const GAS_META = [B('enabled', 'Gas on', 'Hard-sphere collisions with a background gas.'),
    S('model', 'Model', opt(ENUMS.gasModel, ['Hard sphere']), 'Elastic ion–neutral collisions with a Maxwell–Boltzmann gas.'),
    N('pressure', 'Pressure', 'none', 'Gas pressure, Pa (1 mTorr = 0.1333 Pa); 0 turns collisions off.', { min: 0 }),
    N('temperature', 'Temperature', 'none', 'Gas temperature, K.', { gt: 0 }),
    N('mass', 'Gas mass', 'mass', 'Mass of a gas atom or molecule.', { gt: 0 }),
    N('diameter', 'Gas diameter', 'none', 'Collision diameter of the gas, Å.', { gt: 0 }),
    N('ionDiameter', 'Ion diameter', 'none', 'Collision diameter of the ions, Å (empty: a sphere of density 1 g/cm³, (6m/πρ)^(1/3)).', { nullable: true, gt: 0 }),
    V('velocity', 'Gas velocity', 'none', 3, 'Bulk gas flow, mm/µs.')];
const IDEAL_COMMON = [B('enabled', 'Enabled', 'Disabled fields are ignored.'),
    S('type', 'Type', opt(ENUMS.idealType, ['Uniform E', 'Quadrupole (2D)', 'Quadrupole (3D, axis x)', 'Coaxial (log)', 'Spherical (A + B/r)']), 'Analytic field added to the solved field.')];

/**
 * Form descriptors per object type: { key, label, dim, kind, options?, min?, max?, help }.
 * kind: 'number' (accepts expressions and units) | 'int' | 'bool' | 'select' | 'text' | 'textarea' | 'color' |
 * 'electrode' (an electrode id; `allowVoid`/`nullable` add Void = null) | 'vec2' | 'vec3' | 'vec4' (fixed-size vectors) |
 * 'range2' ([start, end]) | 'points' (one point per line; `dims` per component, `min` = fewest points) | 'list' (values).
 * A 'select' with `ref` ('plane' | 'param' | 'source') takes its options from the project. Keys may be paths into the
 * object ('mirror.x'). `showIf: { key: value | [values] }` shows a field only for those values; `when` lists the domain
 * types a field applies to. `gt` (strictly greater) mirrors the schema check. Dimensions follow spec §2.1.1; 'efield'
 * is V/mm and 'flux' tesla.
 */
export const META = Object.freeze({
    meta: [T('name', 'Project name', 'Shown in the app bar and used as the file name.', { maxLength: 200 }),
        TA('notes', 'Notes', 'Plain-text notes saved with the project.', { maxLength: 100000 })],
    param: [T('name', 'Name', 'Letters, digits and "_"; starts with a letter. Usable in any numeric field.', { pattern: '^[A-Za-z_]\\w*$' }),
        N('value', 'Value', 'none', 'A number or an expression of other parameters.', { dimFrom: 'dim' }),
        S('dim', 'Dimension', opt(ENUMS.dim, ['Length (mm)', 'Voltage (V)', 'Energy (eV)', 'Mass (u)', 'Charge (e)', 'Angle (°)', 'Time (µs)', 'Frequency (MHz)', 'Field (V/mm)', 'None']), 'Sets the unit shown and accepted.'),
        T('note', 'Note', 'Optional description.', { optional: true })],
    slider: [N('min', 'Slider minimum', 'none', 'Lower end of the slider.'), N('max', 'Slider maximum', 'none', 'Upper end of the slider.'), N('step', 'Slider step', 'none', 'Slider step.', { gt: 0 })],
    domain: [S('type', 'Domain type', opt(ENUMS.domainType, ['Planar (x, y)', 'Cylindrical (x, r)']), 'Cylindrical domains are bodies of revolution about the x axis.'),
        R2('x', 'x extent', 'length', 'Domain extent along x.'),
        R2('y', 'y (or r) extent', 'length', 'Domain extent along y (r from 0 when cylindrical).'),
        N('cell', 'Cell size', 'length', 'Grid spacing h (square cells); the grid has (extent / cell + 1) nodes per direction.', { gt: 0 }),
        B('mirror.x', 'Mirror at x = 0', 'The domain covers x ≥ 0 and is mirrored (needs x start = 0 and a Neumann xmin edge).'),
        B('mirror.y', 'Mirror at y = 0', 'Planar only: the domain covers y ≥ 0 and is mirrored (needs y start = 0 and a Neumann ymin edge).', { when: ['planar2d'] }),
        B('antimirror.x', 'Anti-mirror at x = 0', 'The domain covers x ≥ 0; the potential is odd in x: φ(−x) = −φ(x), φ = 0 on the plane (needs x start = 0 and a grounded xmin edge).'),
        B('antimirror.y', 'Anti-mirror at y = 0', 'Planar only: the potential is odd in y (hexapoles, bipolar magnets); needs y start = 0 and a grounded ymin edge.', { when: ['planar2d'] }),
        T('charge', 'Space-charge density ρ(x, y)', 'Optional expression in x, y (r in cylindrical domains), z and the parameters, C/m³; empty: Laplace. Adds a Poisson term to the solve.', { optional: true })],
    antimirror: [B('x', 'Anti-mirror in x', 'φ(−x) = −φ(x): the domain covers x ≥ 0 with φ = 0 on the plane (needs x start = 0 and a grounded xmin edge).'),
        B('y', 'Anti-mirror in y', 'Planar only: φ(−y) = −φ(y); needs y start = 0 and a grounded ymin edge.', { when: ['planar2d'] })],
    edge: [S('bc', 'Boundary', opt(ENUMS.bc, ['Fixed voltage (electrode)', 'Zero normal field (Neumann)', 'Symmetry axis', 'Profile (segments and ramps)']), 'Boundary condition on this domain edge.'),
        EL('electrode', 'Electrode', 'Electrode whose voltage the edge takes.', { showIf: { bc: 'dirichlet' } })],
    segment: [N('from', 'From', 'length', 'Start of the segment along the edge.'), N('to', 'To', 'length', 'End of the segment along the edge.'),
        EL('electrode', 'Electrode', 'Electrode on this segment (or use a ramp between two electrodes).'),
        { key: 'ramp', label: 'Ramp [from electrode, to electrode]', dim: 'none', kind: 'electrode', ref: 'electrode', multiple: 2, nullable: true, help: 'Voltage interpolated linearly along the segment: an ideal divider.' }],
    mirror: [B('x', 'Mirror in x', 'The domain covers x ≥ 0 and is mirrored (needs x start = 0 and a Neumann xmin edge).'),
        B('y', 'Mirror in y', 'Planar only: the domain covers y ≥ 0 and is mirrored (needs y start = 0 and a Neumann ymin edge).', { when: ['planar2d'] })],
    beyond: ['xmin', 'xmax', 'ymin', 'ymax'].map((e) => S(e, `Beyond ${e}`, opt(ENUMS.beyond, ['Stop', 'Field-free drift']), 'What happens to particles leaving through this edge.')),
    electrode: [T('name', 'Name', 'Electrode name.'), C('color', 'Color', 'Color on the canvas.'),
        N('v', 'Voltage', 'voltage', 'DC voltage (a number or an expression).'),
        S('kind', 'Kind', opt(ENUMS.electrodeKind, ['Solid', 'Mesh (transparent)']), 'A mesh is a Dirichlet surface for the field that particles can pass.'),
        N('transmission', 'Transmission', 'none', 'Fraction of particles that pass the mesh (0 to 1).', { min: 0, max: 1, showIf: { kind: 'grid' } })],
    'term.cos': [N('amp', 'Amplitude', 'voltage', 'Peak voltage.'), N('freq', 'Frequency', 'freq', 'Frequency.', { min: 0 }), N('phase', 'Phase', 'angle', 'Phase at t = 0.')],
    'term.pulse': [N('amp', 'Amplitude', 'voltage', 'Pulse height.'), N('t0', 'Start', 'time', 'Start of the rise.'), N('rise', 'Rise time', 'time', 'Rise time.', { min: 0 }),
        N('width', 'Width', 'time', 'Time at full amplitude.', { min: 0 }), N('fall', 'Fall time', 'time', 'Fall time.', { min: 0 }),
        N('period', 'Period', 'time', 'Repeat period (empty: a single pulse).', { nullable: true, gt: 0 })],
    'term.table': [PS('points', 'Points (t µs, V per line)', ['time', 'voltage'], 1, 'Piecewise-linear voltage; times increasing.'),
        N('period', 'Period', 'time', 'Repeat period (empty: hold the end values).', { nullable: true, gt: 0 })],
    shape: [T('name', 'Name', 'Optional shape name.', { optional: true }),
        EL('electrode', 'Electrode', 'Electrode this shape belongs to; Void carves free space out of earlier shapes.', { allowVoid: true, nullable: true, nullLabel: 'Void' }),
        B('enabled', 'Enabled', 'Disabled shapes are ignored.'), B('locked', 'Locked', 'Locked shapes cannot be moved on the canvas.')],
    'shape.box': SHAPE_META.box, 'shape.tube': SHAPE_META.tube, 'shape.plate': SHAPE_META.plate, 'shape.disc': SHAPE_META.disc,
    'shape.circle': SHAPE_META.circle, 'shape.annulus': SHAPE_META.annulus, 'shape.polygon': SHAPE_META.polygon,
    'shape.polyline': SHAPE_META.polyline, 'shape.quadric': SHAPE_META.quadric,
    transform: [V('translate', 'Translate [dx, dy]', 'length', 2, 'Shift after mirroring and rotating.'), N('rotate', 'Rotate', 'angle', 'Rotation about the pivot, degrees counter-clockwise (quadrics: multiples of 90°).'),
        V('about', 'Pivot [x, y]', 'length', 2, 'Center of rotation and mirroring.'),
        S('mirror', 'Mirror', opt(ENUMS.mirror, ['None', 'Flip x', 'Flip y', 'Flip both']), 'Applied first (about the pivot).')],
    magnet: [T('name', 'Name', 'Magnet name.', { optional: true }), B('enabled', 'Enabled', 'Disabled magnets are ignored.'),
        S('type', 'Type', opt(ENUMS.magnetType, ['Uniform field', 'Field region (sharp edges)', 'Current loop', 'Pole pieces (scalar potential)']), 'Kind of magnetic field.')],
    'magnet.poles': [S('boundary', 'Domain edges', opt(ENUMS.poleBoundary, ['Zero normal field (Neumann)', 'ψ = 0']), 'Condition for the magnetic scalar potential ψ on the open domain edges.')],
    pole: [S('region.type', 'Piece shape', opt(ENUMS.regionType, ['Box', 'Polygon', 'Annulus sector']), 'Pole piece in plane coordinates, extruded (planar) or revolved (cylindrical).'),
        N('psi', 'Scalar potential ψ', 'none', 'Magnetic scalar potential of the piece, T·mm: B = −∇ψ, so a gap g between pieces at ψ₁ and ψ₂ carries |B| ≈ |ψ₁ − ψ₂|/g.')],
    'magnet.uniform': [V('B', 'B [Bx, By, Bz]', 'flux', 3, 'Uniform flux density everywhere (also outside the grid), tesla.')],
    'magnet.region': [V('B', 'B [Bx, By, Bz]', 'flux', 3, 'Flux density inside the region, tesla (cylindrical domains: Bx only).'),
        S('region.type', 'Region shape', opt(ENUMS.regionType, ['Box', 'Polygon', 'Annulus sector']), 'Region in plane coordinates, extruded (planar) or revolved (cylindrical).')],
    'magnet.loop': [V('center', 'Center [x, y, z]', 'length', 3, 'Loop center.'), V('normal', 'Normal [x, y, z]', 'none', 3, 'Loop axis; positive current is counter-clockwise seen from +normal.'),
        N('radius', 'Radius', 'length', 'Loop radius.', { gt: 0 }), N('turns', 'Turns', 'none', 'Number of turns.', { gt: 0 }), N('current', 'Current', 'current', 'Current per turn, amperes.')],
    'region.box': [N('x0', 'x start', 'length', ''), N('x1', 'x end', 'length', ''), N('y0', 'y start', 'length', ''), N('y1', 'y end', 'length', '')],
    'region.polygon': [PS('points', 'Vertices (x, y per line)', ['length', 'length'], 3, 'Closed outline (even–odd rule).')],
    'region.annulus': [N('cx', 'Center x', 'length', ''), N('cy', 'Center y', 'length', ''), N('rIn', 'Inner radius', 'length', '', { min: 0 }),
        N('rOut', 'Outer radius', 'length', '', { gt: 0 }), N('a0', 'Start angle', 'angle', ''), N('a1', 'End angle', 'angle', '')],
    idealField: IDEAL_COMMON,
    ideal: IDEAL_COMMON,
    'ideal.uniformE': [V('E', 'E [Ex, Ey, Ez]', 'efield', 3, 'Field vector, V/mm.'), V('ref', 'Zero-potential point', 'length', 3, 'Point where this field\'s potential is 0.')],
    'ideal.quadrupole2d': [V('center', 'Center [x, y]', 'length', 2, ''), N('r0', 'r₀', 'length', 'Field radius.', { gt: 0 }), N('U', 'U (DC)', 'voltage', ''), N('V', 'V (RF amplitude)', 'voltage', ''),
        N('freq', 'Frequency', 'freq', '', { min: 0 }), N('phase', 'Phase', 'angle', '')],
    'ideal.quadrupole3d': [V('center', 'Center [x, y, z]', 'length', 3, ''), N('r0', 'r₀', 'length', 'Ring radius.', { gt: 0 }), N('z0', 'z₀', 'length', 'End-cap half distance.', { min: 0 }),
        N('U', 'U (DC)', 'voltage', ''), N('V', 'V (RF amplitude)', 'voltage', ''), N('freq', 'Frequency', 'freq', '', { min: 0 }), N('phase', 'Phase', 'angle', '')],
    'ideal.coax': [V('center', 'Center [x, y]', 'length', 2, ''), N('a', 'Inner radius', 'length', '', { gt: 0 }), N('b', 'Outer radius', 'length', '', { gt: 0 }),
        N('Va', 'Inner voltage', 'voltage', ''), N('Vb', 'Outer voltage', 'voltage', '')],
    'ideal.sphere': [V('center', 'Center [x, y, z]', 'length', 3, ''), N('R1', 'Inner radius', 'length', '', { gt: 0 }), N('R2', 'Outer radius', 'length', '', { gt: 0 }),
        N('V1', 'Inner voltage', 'voltage', ''), N('V2', 'Outer voltage', 'voltage', '')],
    source: [T('name', 'Name', 'Source name.'), B('enabled', 'Enabled', 'Disabled sources are not run.'),
        T('color', 'Color', '"auto" or #rrggbb.', { format: 'color', optional: true }),
        S('type', 'Source type', opt(ENUMS.sourceType, ['Sampled (species and distributions)', 'Particle list (one row per particle)']), 'A sampled source draws particles from the cards below; a particle list gives every particle explicitly.'),
        N('weight', 'Weight', 'none', 'Statistical weight of each particle of this source (default 1): weighted counts, transmission and histograms.', { gt: 0 }),
        S('sampling', 'Sampling', opt(ENUMS.sampling, ['Random', 'Grid (every combination)']), 'Grid sampling takes every combination of the listed classes.'),
        I('count', 'Particles', 'Number of particles (random sampling; grid sampling derives it).', { min: 0, showIf: { sampling: 'random' } }),
        I('seed', 'Seed', 'Random seed; the same seed gives the same particles.', { min: 0 })],
    'source.rows': [B('velocity', 'Velocity columns', 'Off: columns 6–8 are a direction and column 9 the kinetic energy. On: columns 6–8 are the velocity in mm/µs (9 columns, no energy column).'),
        PS('rows', 'Particles (one per line)', ['mass', 'charge', 'length', 'length', 'length', 'none', 'none', 'none', 'energy', 'time'], 1,
            'mass u, charge e, x, y, z mm, direction dx, dy, dz, kinetic energy eV, birth time µs.')],
    rows: [PS('rows', 'Particles (one per line)', ['mass', 'charge', 'length', 'length', 'length', 'none', 'none', 'none', 'energy', 'time'], 1,
        'mass u, charge e, x, y, z mm, direction dx, dy, dz, kinetic energy eV, birth time µs.')],
    'rows.velocity': [PS('rows', 'Particles (one per line)', ['mass', 'charge', 'length', 'length', 'length', 'none', 'none', 'none', 'time'], 1,
        'mass u, charge e, x, y, z mm, velocity vx, vy, vz mm/µs, birth time µs.')],
    species: [T('label', 'Label', 'Species label.'), N('mass', 'Mass', 'mass', 'Mass in u.', { gt: 0 }), N('charge', 'Charge', 'charge', 'Charge in e (signed, not zero).'),
        N('fraction', 'Fraction', 'none', 'Relative abundance (random sampling).', { min: 0 })],
    'position.point': [V('p', 'Point [x, y, z]', 'length', 3, '')],
    'position.line': [V('p0', 'Start [x, y, z]', 'length', 3, ''), V('p1', 'End [x, y, z]', 'length', 3, ''), I('n', 'Points (grid)', 'Points including both ends.', { min: 1 })],
    'position.disc': [V('center', 'Center [x, y, z]', 'length', 3, ''), V('normal', 'Normal [x, y, z]', 'none', 3, ''), N('radius', 'Radius', 'length', '', { min: 0 }), I('n', 'Points (grid)', 'Spiral points.', { min: 1 })],
    'position.rect': [V('center', 'Center [x, y, z]', 'length', 3, ''), V('u', 'u direction', 'none', 3, ''), V('v', 'v direction', 'none', 3, ''),
        N('halfU', 'Half-size along u', 'length', '', { min: 0 }), N('halfV', 'Half-size along v', 'length', '', { min: 0 }),
        V('n', 'Points (grid) [nu, nv]', 'none', 2, 'Cell centers along u and v.', { integer: true, min: 1 })],
    'position.gaussian': [V('center', 'Center [x, y, z]', 'length', 3, ''), V('sigma', 'σ [x, y, z]', 'length', 3, 'Standard deviations (random sampling, truncated at 4σ).', { min: 0 })],
    'position.list': [PS('points', 'Points (x, y, z per line)', ['length', 'length', 'length'], 1, '')],
    'direction.fixed': [V('dir', 'Direction [x, y, z]', 'none', 3, '')],
    'direction.cone': [V('axis', 'Axis [x, y, z]', 'none', 3, ''), N('halfAngle', 'Half-angle', 'angle', '', { min: 0, max: 180 }),
        S('fill', 'Fill', opt(ENUMS.coneFill, ['Solid angle', 'Uniform angle', 'Lambert (cosine)']), ''), I('n', 'Directions (grid)', '', { min: 1 })],
    'direction.fan': [V('axis', 'Axis [x, y, z]', 'none', 3, 'Angle 0.'), V('normal', 'Fan normal [x, y, z]', 'none', 3, 'The fan lies in the plane perpendicular to this.'),
        N('from', 'From', 'angle', ''), N('to', 'To', 'angle', ''), I('n', 'Directions (grid)', 'Including both ends.', { min: 1 })],
    'direction.isotropic': [V('axis', 'Axis [x, y, z]', 'none', 3, 'Symmetry axis of the anisotropy.'), N('beta', 'β', 'none', 'P(θ) ∝ 1 + β·P₂(cos θ), −1 ≤ β ≤ 2.', { min: -1, max: 2 }),
        I('n', 'Directions (grid)', '', { min: 1 })],
    'energy.mono': [N('ke', 'Kinetic energy', 'energy', '', { min: 0 })],
    'energy.uniform': [N('min', 'Minimum', 'energy', '', { min: 0 }), N('max', 'Maximum', 'energy', '', { min: 0 }), I('n', 'Energies (grid)', 'Including both ends.', { min: 1 })],
    'energy.gaussian': [N('mean', 'Mean', 'energy', '', { gt: 0 }), N('fwhm', 'FWHM', 'energy', 'Random sampling only.', { min: 0 })],
    'energy.list': [LIST('values', 'Energies', 'energy', '')],
    'time.fixed': [N('t', 'Birth time', 'time', '')],
    'time.uniform': [N('t0', 'From', 'time', ''), N('t1', 'To', 'time', ''), I('n', 'Times (grid)', '', { min: 1 })],
    'time.rfPhase': [N('freq', 'RF frequency', 'freq', 'Birth times spread over one RF period.', { gt: 0 }), I('n', 'Phases (grid)', '', { min: 1 })],
    'time.list': [LIST('values', 'Birth times', 'time', '')],
    plane: [T('name', 'Name', ''), S('kind', 'Kind', opt(ENUMS.planeKind, ['x = const', 'y = const', 'z = const', 'Cylinder r = const', 'Segment', 'Sphere']), 'Test plane or detector.'),
        N('at', 'Position', 'length', 'Coordinate of the plane (radius for r and sphere).', { showIf: { kind: [...PLANE_AXIAL, 'sphere'] } }),
        V('center', 'Sphere center [x, y, z]', 'length', 3, 'Sphere planes only.', { showIf: { kind: 'sphere' } }),
        V('p0', 'Segment start [x, y]', 'length', 2, 'Segment planes only.', { showIf: { kind: 'segment' } }),
        V('p1', 'Segment end [x, y]', 'length', 2, 'Forward normal = (end − start) rotated −90°.', { showIf: { kind: 'segment' } }),
        N('radius', 'Radius limit', 'length', 'Only crossings within this distance of the axis (empty: no limit).', { nullable: true, gt: 0, showIf: { kind: ['x', 'y', 'z'] } }),
        B('terminate', 'Detector (stops particles)', 'A detector records and stops the particle.'),
        S('side', 'Direction', opt(ENUMS.side, ['Both', 'Forward', 'Backward']), 'Which crossing directions count.'),
        S('record', 'Record', opt(ENUMS.record, ['First crossing', 'All crossings']), 'All keeps up to 1000 crossings per particle.')],
    recording: [B('trajectories.store', 'Store trajectories', 'Keep trajectory points for drawing and export.'),
        I('trajectories.maxPoints', 'Points per trajectory', 'Upper limit per particle.', { min: 2 }),
        N('timeMarkers.dt', 'Time markers every', 'time', 'Empty: no markers.', { nullable: true, gt: 0 })],
    trajectories: [B('store', 'Store trajectories', 'Keep trajectory points for drawing and export.'), I('maxPoints', 'Points per particle', 'Upper limit per particle.', { min: 2 })],
    timeMarkers: [N('dt', 'Marker interval', 'time', 'Time markers along trajectories.', { gt: 0 })],
    tracer: [S('integrator', 'Integrator', opt(ENUMS.integrator, ['Automatic', 'Dormand–Prince 5(4)', 'Boris (magnetic)', 'Runge–Kutta 4 (fixed step)']), 'Automatic uses Boris for long magnetic runs, else Dormand–Prince.'),
        S('quality', 'Trajectory accuracy', opt(ENUMS.quality, ['Draft', 'Normal', 'Fine', 'Custom']), 'Tolerance and step limits.'),
        S('fieldInterp', 'Field interpolation', opt(ENUMS.fieldInterp, ['Cubic (smooth, conservative)', 'Linear (coarse grids)']), 'Cubic is more accurate at 32 or more cells per aperture radius; linear can be better below 16.'),
        B('relativistic', 'Relativistic', 'Relativistic equations of motion.'),
        N('tMax', 'Time limit', 'time', 'Maximum flight time per particle.', { gt: 0 }), I('maxSteps', 'Step limit', 'Maximum steps per particle.', { min: 1 }),
        N('maxDrift', 'Drift limit', 'length', 'Maximum field-free drift outside the grid.', { gt: 0 })],
    custom: CUSTOM_META,
    'tracer.custom': CUSTOM_META,
    drag: [N('mobility', 'Mobility', 'none', 'cm²/(V·s); qualitative Stokes drag.', { gt: 0 }), V('gasVelocity', 'Gas velocity', 'none', 3, 'mm/µs.')],
    spaceCharge: SPACE_CHARGE_META,
    'tracer.spaceCharge': SPACE_CHARGE_META,
    gas: GAS_META,
    'tracer.gas': GAS_META,
    solver: [S('boundary', 'Electrode surfaces', opt(ENUMS.boundary, ['Sub-grid (Shortley–Weller)', 'Staircase']), 'Sub-grid boundaries are second-order accurate on curved surfaces.'),
        S('method', 'Solver', opt(ENUMS.method, ['Automatic (multigrid → BiCGSTAB → SOR)', 'Multigrid', 'Multigrid-preconditioned BiCGSTAB', 'Adaptive SOR']), 'Automatic tries multigrid, then BiCGSTAB, then SOR.'),
        N('tol', 'Tolerance', 'none', 'Estimated error per volt (floor 1e-12).', { gt: 0, max: 1e-3 }),
        I('maxCycles', 'Multigrid cycles', '', { min: 1 }), I('maxIterations', 'Krylov iterations', '', { min: 1 }), I('maxSweeps', 'SOR sweeps', '', { min: 1 })],
    lens: [N('refX', 'Reference plane x', 'length', ''), N('D', 'Reference diameter D', 'length', '', { gt: 0 }), N('xStart', 'Left field-free x', 'length', ''),
        N('xEnd', 'Right field-free x', 'length', ''), N('mass', 'Mass', 'mass', '', { gt: 0 }), N('charge', 'Charge', 'charge', ''),
        N('keLeft', 'Kinetic energy (left)', 'energy', '', { gt: 0 }),
        LIST('heights', 'Ray heights (× D)', 'none', 'At least two heights.', { min: 2, minItems: 2 }),
        S('side', 'Rays', opt(ENUMS.lensSide, ['Both directions', 'Left to right', 'Right to left']), '')],
    metric: [S('type', 'Metric', opt(ENUMS.metricType, ['Transmission', 'Spot rms', 'Waist position', 'Mean TOF', 'TOF FWHM', 'Resolving power', 'Mean kinetic energy', 'Grouped blur']), ''),
        REF('plane', 'Plane', 'plane', '', { nullable: true }), T('species', 'Species', 'Optional species label.', { optional: true }), REF('source', 'Source', 'source', '', { nullable: true })],
    view: [V('center', 'View center', 'length', 2, ''), N('scale', 'Zoom (px/mm)', 'none', '', { gt: 0 }), N('displayTime', 'Display time', 'time', '', { min: 0 }),
        S('projection', 'Projection', opt(ENUMS.projection, ['x–y', 'x–r (folded)']), ''),
        S('colormap', 'Color map', opt(ENUMS.colormap, ['Automatic', 'Diverging', 'Viridis-like', 'Cividis', 'Gray']), ''),
        N('aspect', 'Vertical stretch (y ×)', 'none', 'Draws y this many times longer than x (Layers menu); 1 = true proportions.', { gt: 0, optional: true }),
        N('relief', 'Surface relief (×)', 'none', 'Height scale of the potential-energy surface view.', { min: 0.25, max: 4, optional: true })],
});

// ======================================================================== migrate

const TOP_DEFAULTS = ['meta', 'params', 'domain', 'electrodes', 'shapes', 'magnets', 'idealFields', 'sources', 'recording', 'tracer', 'solver', 'analysis', 'view'];

/**
 * Brings a project to the current version: a deep copy with missing top-level sections filled in.
 * Throws only on non-objects or a foreign `format` (EngineError E_BAD_PROJECT); a newer `version` is kept
 * (validate() reports it).
 * @param {object} json
 * @returns {object} Project
 */
/**
 * Does a JSON object look like a project (files and links)? Either it carries the format tag and a numeric version, or it
 * has the domain, electrodes and shapes sections (a hand-written project). migrate() fills in everything else, so without
 * this test any object, e.g. {"a": 1}, would open as an empty project.
 */
export function isProjectLike(json) {
    if (!isObj(json)) return false;
    if (json.format === PROJECT_FORMAT && typeof json.version === 'number' && Number.isFinite(json.version)) return true;
    return HAS.call(json, 'domain') && HAS.call(json, 'electrodes') && HAS.call(json, 'shapes');
}

export function migrate(json) {
    if (!isObj(json)) throw new EngineError('E_BAD_PROJECT', 'A project must be a JSON object.', '');
    if (json.format !== undefined && json.format !== PROJECT_FORMAT) throw new EngineError('E_BAD_PROJECT', `Not a project file (format "${String(json.format).slice(0, 40)}").`, 'format');
    let p;
    try { p = clone(json); } catch (e) { throw new EngineError('E_BAD_PROJECT', 'The project is not plain JSON data.', ''); }
    if (p.format === undefined) p.format = PROJECT_FORMAT;
    if (p.version === undefined) p.version = SCHEMA_VERSION;
    const type = isObj(p.domain) && p.domain.type === 'planar2d' ? 'planar2d' : 'cyl2d';
    for (const key of TOP_DEFAULTS) {
        if (p[key] !== undefined) continue;
        switch (key) {
            case 'params': case 'shapes': case 'magnets': case 'idealFields': case 'sources': p[key] = []; break;
            case 'electrodes': p[key] = [defaults('gnd', type)]; break;
            case 'meta': p[key] = defaults('meta', type); break;
            case 'view': p[key] = defaultView(type); break;
            default: p[key] = defaults(key, type);
        }
    }
    return p;
}

// ======================================================================== validation and resolution pass

class Pass {
    constructor(vars) {
        this.vars = vars;
        this.errors = [];
        this.warnings = [];
        this.soft = 0;   // > 0: errors are reported as warnings (disabled items, analysis, view)
        this.declared = new Set();   // parameter names, including those whose own value has an error
    }
    error(path, code, message) { (this.soft > 0 ? this.warnings : this.errors).push({ path, code, message }); }
    warn(path, code, message) { this.warnings.push({ path, code, message }); }
    /** Evaluates a number or expression; records errors; returns NaN on error. */
    value(v, path, o = {}) {
        let x;
        if (typeof v === 'number') x = v;
        else if (typeof v === 'string') {
            try { x = parseExpr(v).evaluate(this.vars); } catch (e) {
                const unknown = e && e.detail && e.detail.kind === 'unknown';
                // a parameter that exists but failed to evaluate is reported where it is defined; here only the dependency
                if (unknown && this.declared.has(e.detail.name)) this.error(path, 'E_PARAM_DEPENDS', `Depends on parameter "${e.detail.name}", which has an error.`);
                else this.error(path, unknown ? 'E_EXPR_UNKNOWN' : 'E_EXPR_SYNTAX', e && e.message ? e.message : 'Invalid expression.');
                return NaN;
            }
        } else {
            this.error(path, 'E_TYPE', 'Expected a number or an expression.');
            return NaN;
        }
        if (!Number.isFinite(x)) { this.error(path, 'E_NOT_FINITE', `The value is ${x}, not a finite number.`); return NaN; }
        if (o.int) {
            const r = Math.round(x);
            if (Math.abs(x - r) > 1e-9 * Math.max(1, Math.abs(x))) { this.error(path, 'E_NOT_INTEGER', 'The value must be a whole number.'); return NaN; }
            x = r;
        }
        if (o.min !== undefined && x < o.min) { this.error(path, 'E_RANGE', `The value must be at least ${o.min}.`); return NaN; }
        if (o.max !== undefined && x > o.max) { this.error(path, 'E_RANGE', `The value must be at most ${o.max}.`); return NaN; }
        if (o.gt !== undefined && !(x > o.gt)) { this.error(path, 'E_RANGE', `The value must be greater than ${o.gt}.`); return NaN; }
        if (o.lt !== undefined && !(x < o.lt)) { this.error(path, 'E_RANGE', `The value must be less than ${o.lt}.`); return NaN; }
        if (o.nonzero && x === 0) { this.error(path, 'E_RANGE', 'The value must not be zero.'); return NaN; }
        return x;
    }
    /** Numeric field obj[key]; `def` used when missing; `nullable` allows null (returns null). */
    num(obj, key, base, o = {}) {
        const path = base ? `${base}.${key}` : key;
        const v = isObj(obj) ? obj[key] : undefined;
        if (v === undefined || (v === null && !o.nullable)) {
            if (HAS.call(o, 'def')) return o.def;
            this.error(path, 'E_REQUIRED', `"${key}" is required.`);
            return NaN;
        }
        if (v === null) return null;
        return this.value(v, path, o);
    }
    /** Fixed-length numeric vector; `pad3` accepts 2 elements for a 3-vector (z = 0). */
    vec(obj, key, base, n, o = {}) {
        const path = base ? `${base}.${key}` : key;
        let v = isObj(obj) ? obj[key] : undefined;
        if (v === undefined || v === null) {
            if (HAS.call(o, 'def')) return o.def === null ? null : o.def.slice();
            this.error(path, 'E_REQUIRED', `"${key}" is required.`);
            return new Array(n).fill(NaN);
        }
        if (!Array.isArray(v) || !(v.length === n || (n === 3 && v.length === 2 && o.pad3 !== false))) {
            this.error(path, 'E_TYPE', `"${key}" must be a list of ${n} numbers.`);
            return new Array(n).fill(NaN);
        }
        if (v.length === 2 && n === 3) v = [v[0], v[1], 0];
        const eo = { ...o };
        delete eo.nonzero; delete eo.def; delete eo.pad3;
        const out = v.map((x, i) => this.value(x, `${path}[${i}]`, eo));
        if (o.nonzero && out.every((x) => x === 0)) this.error(path, 'E_RANGE', `"${key}" must not be the zero vector.`);
        return out;
    }
    /** List of n-vectors (points). */
    points(obj, key, base, n, o = {}) {
        const path = base ? `${base}.${key}` : key;
        const v = isObj(obj) ? obj[key] : undefined;
        if (!Array.isArray(v)) { this.error(path, v === undefined ? 'E_REQUIRED' : 'E_TYPE', `"${key}" must be a list of points.`); return []; }
        if (o.minItems && v.length < o.minItems) { this.error(path, 'E_RANGE', `"${key}" needs at least ${o.minItems} entries.`); }
        if (o.maxItems && v.length > o.maxItems) { this.error(path, 'E_LIMIT', `"${key}" has more than ${o.maxItems} entries.`); return []; }
        const out = new Array(v.length);
        for (let i = 0; i < v.length; i++) {
            const p = v[i];
            if (n === 1) { out[i] = this.value(p, `${path}[${i}]`, o); continue; }
            if (!Array.isArray(p) || !(p.length === n || (n === 3 && p.length === 2))) { this.error(`${path}[${i}]`, 'E_TYPE', `Each entry must be a list of ${n} numbers.`); out[i] = new Array(n).fill(NaN); continue; }
            const q = p.length === n ? p : [p[0], p[1], 0];
            out[i] = q.map((x, c) => this.value(x, `${path}[${i}][${c}]`, o));
        }
        return out;
    }
    enumv(obj, key, base, options, def) {
        const path = base ? `${base}.${key}` : key;
        const v = isObj(obj) ? obj[key] : undefined;
        if (v === undefined || v === null) {
            if (def !== undefined) return def;
            this.error(path, 'E_REQUIRED', `"${key}" is required.`);
            return options[0];
        }
        if (!options.includes(v)) { this.error(path, 'E_ENUM', `"${key}" must be one of: ${options.join(', ')}.`); return def !== undefined ? def : options[0]; }
        return v;
    }
    bool(obj, key, base, def) {
        const path = base ? `${base}.${key}` : key;
        const v = isObj(obj) ? obj[key] : undefined;
        if (v === undefined || v === null) return def;
        if (typeof v !== 'boolean') { this.error(path, 'E_TYPE', `"${key}" must be true or false.`); return def; }
        return v;
    }
    str(obj, key, base, o = {}) {
        const path = base ? `${base}.${key}` : key;
        const v = isObj(obj) ? obj[key] : undefined;
        if (v === undefined || v === null) {
            if (HAS.call(o, 'def')) return o.def;
            this.error(path, 'E_REQUIRED', `"${key}" is required.`);
            return '';
        }
        if (typeof v !== 'string') { this.error(path, 'E_TYPE', `"${key}" must be text.`); return HAS.call(o, 'def') ? o.def : ''; }
        if (o.max && v.length > o.max) { this.error(path, 'E_LIMIT', `"${key}" is longer than ${o.max} characters.`); return v.slice(0, o.max); }
        return v;
    }
    obj(parent, key, base, o = {}) {
        const path = base ? `${base}.${key}` : key;
        const v = isObj(parent) ? parent[key] : undefined;
        if (v === undefined || v === null) {
            if (o.nullable) return null;
            this.error(path, 'E_REQUIRED', `"${key}" is required.`);
            return null;
        }
        if (!isObj(v)) { this.error(path, 'E_TYPE', `"${key}" must be an object.`); return null; }
        return v;
    }
    list(parent, key, base, max) {
        const path = base ? `${base}.${key}` : key;
        const v = isObj(parent) ? parent[key] : undefined;
        if (v === undefined || v === null) return [];
        if (!Array.isArray(v)) { this.error(path, 'E_TYPE', `"${key}" must be a list.`); return []; }
        if (max !== undefined && v.length > max) this.error(path, 'E_LIMIT', `At most ${max} entries are allowed in "${key}" (found ${v.length}).`);
        return v;
    }
    id(obj, base, seen, what) {
        const path = `${base}.id`;
        const v = isObj(obj) ? obj.id : undefined;
        if (typeof v !== 'string' || !ID_RE.test(v)) { this.error(path, 'E_ID', `A ${what} id is 1–64 characters: letters, digits, "_", ".", ":" or "-".`); return null; }
        if (seen.has(v)) { this.error(path, 'E_DUPLICATE_ID', `The ${what} id "${v}" is used twice.`); return v; }
        seen.add(v);
        return v;
    }
    color(obj, key, base, allowAuto) {
        const v = isObj(obj) ? obj[key] : undefined;
        if (v === undefined || v === null) return v;
        if (typeof v !== 'string' || !(COLOR_RE.test(v) || (allowAuto && v === 'auto'))) this.warn(`${base}.${key}`, 'W_COLOR', `"${key}" should be ${allowAuto ? '"auto" or ' : ''}a #rrggbb color.`);
        return v;
    }
}

// ---------------------------------------------------------------- domain

function resolveDomain(pass, d, out) {
    const base = 'domain';
    if (!isObj(d)) { pass.error(base, 'E_REQUIRED', 'The project needs a domain.'); return null; }
    let type = d.type;
    if (type === 'planar3d') { pass.error(`${base}.type`, 'E_UNSUPPORTED', '3D domains are not available in this beta.'); type = 'planar2d'; }
    else type = pass.enumv(d, 'type', base, ENUMS.domainType);
    const cyl = type === 'cyl2d';
    const h = pass.num(d, 'cell', base, { gt: 0 });
    const x = pass.vec(d, 'x', base, 2, { pad3: false });
    const y = pass.vec(d, 'y', base, 2, { pad3: false });
    const ok = Number.isFinite(h) && x.every(Number.isFinite) && y.every(Number.isFinite);
    if (Number.isFinite(x[0]) && Number.isFinite(x[1]) && !(x[1] > x[0])) pass.error(`${base}.x`, 'E_RANGE', 'The x extent must end after it starts.');
    if (Number.isFinite(y[0]) && Number.isFinite(y[1]) && !(y[1] > y[0])) pass.error(`${base}.y`, 'E_RANGE', 'The y extent must end after it starts.');
    if (cyl && Number.isFinite(y[0]) && y[0] !== 0) pass.error(`${base}.y[0]`, 'E_DOMAIN_AXIS', 'A cylindrical domain starts at r = 0 (the symmetry axis).');
    const mirror = { x: false, y: false };
    if (isObj(d.mirror)) { mirror.x = pass.bool(d.mirror, 'x', `${base}.mirror`, false); mirror.y = pass.bool(d.mirror, 'y', `${base}.mirror`, false); }
    else if (d.mirror !== undefined && d.mirror !== null) pass.error(`${base}.mirror`, 'E_TYPE', '"mirror" must be an object { x, y }.');
    if (cyl && mirror.y) pass.error(`${base}.mirror.y`, 'E_MIRROR', 'Cylindrical domains are already symmetric about the axis; mirror y is for planar domains.');
    // anti-mirror planes (odd reflection, φ = 0 on the plane): same shape as mirror; never both on one plane
    const antimirror = { x: false, y: false };
    if (isObj(d.antimirror)) { antimirror.x = pass.bool(d.antimirror, 'x', `${base}.antimirror`, false); antimirror.y = pass.bool(d.antimirror, 'y', `${base}.antimirror`, false); }
    else if (d.antimirror !== undefined && d.antimirror !== null) pass.error(`${base}.antimirror`, 'E_TYPE', '"antimirror" must be an object { x, y }.');
    if (cyl && antimirror.y) pass.error(`${base}.antimirror.y`, 'E_MIRROR', 'Cylindrical domains are already symmetric about the axis; anti-mirror y is for planar domains.');
    for (const ax of ['x', 'y']) if (mirror[ax] && antimirror[ax]) pass.error(`${base}.antimirror.${ax}`, 'E_MIRROR', `The ${ax} = 0 plane cannot be both a mirror and an anti-mirror.`);
    // analytic space-charge density ρ(x, y, z): an expression in the plane coordinates and the parameters; '' = Laplace.
    // It is probed below, once the grid is known, where the solver samples it.
    let charge = null, chargeEx = null, chargeSrc = '';
    if (d.charge !== undefined && d.charge !== null && d.charge !== '') {
        if (typeof d.charge !== 'string') pass.error(`${base}.charge`, 'E_TYPE', '"charge" must be an expression string (C/m³) or empty.');
        else {
            const src = d.charge.trim();
            if (src) {
                try {
                    const ex = parseExpr(src);
                    const unknown = ex.deps.filter((n) => !CHARGE_VARS.includes(n) && !pass.declared.has(n));
                    if (unknown.length) pass.error(`${base}.charge`, 'E_EXPR_UNKNOWN', `Unknown name "${unknown[0]}" in the charge density; use x, y, z, r or a parameter.`);
                    else { chargeEx = ex; chargeSrc = src; }
                } catch (e) { pass.error(`${base}.charge`, 'E_EXPR_SYNTAX', e && e.message ? e.message : 'Invalid expression.'); }
            }
        }
    }
    const beyond = {};
    for (const e of ['xmin', 'xmax', 'ymin', 'ymax']) beyond[e] = pass.enumv(isObj(d.beyond) ? d.beyond : null, e, `${base}.beyond`, ENUMS.beyond, 'stop');
    let nx = NaN, ny = NaN, x1 = x[1], y1 = y[1];
    if (ok && x[1] > x[0] && y[1] > y[0] && !((x[1] - x[0]) / h < 1e9 && (y[1] - y[0]) / h < 1e9)) {
        // absurd extents (a node count that is not even a finite number) would slip past the node limit below
        pass.error(`${base}.cell`, 'E_GRID_TOO_LARGE', 'The domain is far too large for this cell size.');
    } else if (ok && x[1] > x[0] && y[1] > y[0]) {
        nx = Math.round((x[1] - x[0]) / h) + 1;
        ny = Math.round((y[1] - y[0]) / h) + 1;
        if (nx < 3 || ny < 3) pass.error(`${base}.cell`, 'E_RANGE', 'The domain needs at least 3 nodes along each side; use a smaller cell.');
        const rx = x[0] + (nx - 1) * h, ry = y[0] + (ny - 1) * h;
        if (Math.abs(rx - x[1]) > 1e-6 * h) {
            pass.warn(`${base}.x`, 'W_EXTENT_ROUNDED', `The x extent is not a whole number of cells; the grid ends at x = ${+rx.toPrecision(10)}.`);
            x1 = rx;
        }
        if (Math.abs(ry - y[1]) > 1e-6 * h) {
            pass.warn(`${base}.y`, 'W_EXTENT_ROUNDED', `The y extent is not a whole number of cells; the grid ends at ${cyl ? 'r' : 'y'} = ${+ry.toPrecision(10)}.`);
            y1 = ry;
        }
    }
    if (chargeEx) {
        let at = null, failed = null;
        try { at = chargeProbe(chargeEx, pass.vars, x, y, h, nx, ny); } catch (e) { failed = e; }
        if (failed) pass.error(`${base}.charge`, failed.code === 'E_EXPR_UNKNOWN' ? 'E_PARAM_DEPENDS' : 'E_EXPR_SYNTAX', failed.message || 'The charge density cannot be evaluated.');
        else if (at) pass.error(`${base}.charge`, 'E_NOT_FINITE', `The charge density is not finite at (${at[0]}, ${at[1]}).`);
        else {
            charge = chargeSrc;
            // the solver samples ρ on the solved half only; across an anti-mirror plane the potential is odd, so the image half carries −ρ
            if ((antimirror.x && !mirror.x) || (!cyl && antimirror.y && !mirror.y)) {
                pass.warn(`${base}.charge`, 'W_CHARGE_ANTIMIRROR', 'Across an anti-mirror plane the charge density is mirrored with the opposite sign: the image half carries −ρ. A beam centered on the plane needs the full domain or a mirror plane.');
            }
        }
    }
    out.type = type;
    out.cell = h; out.h = h;
    out.x = [x[0], x1]; out.y = [y[0], y1];
    out.xUser = x.slice(); out.yUser = y.slice();
    out.nx = nx; out.ny = ny; out.N = nx * ny;
    out.mirror = mirror;
    out.antimirror = antimirror;
    out.charge = charge;
    out.beyond = beyond;
    return { type, cyl, h, x, y, nx, ny, mirror, antimirror };
}

/** Names the charge-density expression may use besides the parameters: plane coordinates (y = r in cyl2d), z and r. */
const CHARGE_VARS = ['x', 'y', 'z', 'r'];

/**
 * First point where a charge-density expression is not finite, or null: the domain corner and a lattice of 9 × 9
 * cell centers (both ends included, evenly spread), where the solver samples the density (operator.chargeSource).
 * @returns {number[]|null} [x, y] rounded for messages
 */
function chargeProbe(ex, vars, x, y, h, nx, ny) {
    const v = { ...vars, z: 0 };
    const pts = [];
    if (Number.isFinite(x[0]) && Number.isFinite(y[0])) pts.push([x[0], y[0]]);
    if (Number.isFinite(nx) && Number.isFinite(ny) && nx >= 2 && ny >= 2 && h > 0) {
        const pick = (cells) => { const out = []; for (let k = 0; k <= 8; k++) { const i = Math.round(k * (cells - 1) / 8); if (!out.includes(i)) out.push(i); } return out; };
        const ci = pick(nx - 1), cj = pick(ny - 1);
        for (const j of cj) for (const i of ci) pts.push([x[0] + (i + 0.5) * h, y[0] + (j + 0.5) * h]);
    }
    for (const [px, py] of pts) {
        v.x = px; v.y = py; v.r = py;
        if (!Number.isFinite(ex.evaluate(v))) return [+px.toPrecision(10), +py.toPrecision(10)];
    }
    return null;
}

function resolveEdges(pass, d, out, dom, eIndex) {
    const base = 'domain.edges';
    const edges = isObj(d) && isObj(d.edges) ? d.edges : {};
    if (isObj(d) && d.edges !== undefined && !isObj(d.edges)) pass.error(base, 'E_TYPE', '"edges" must be an object.');
    const res = {};
    const ref = (id, path) => {
        if (id === undefined || id === null) return 0;
        if (typeof id !== 'string' || !eIndex.has(id)) { pass.error(path, 'E_REF', `Unknown electrode "${String(id)}".`); return 0; }
        return eIndex.get(id);
    };
    for (const key of ['xmin', 'xmax', 'ymin', 'ymax']) {
        const e = edges[key];
        const path = `${base}.${key}`;
        const axisEdge = dom.cyl && key === 'ymin';
        if (e === undefined || e === null) {
            res[key] = axisEdge ? { bc: 'axis' } : { bc: 'dirichlet', electrode: 'gnd', electrodeIndex: 0 };
            continue;
        }
        if (!isObj(e)) { pass.error(path, 'E_TYPE', 'An edge must be an object { bc, … }.'); res[key] = { bc: 'dirichlet', electrode: 'gnd', electrodeIndex: 0 }; continue; }
        const bc = pass.enumv(e, 'bc', path, ENUMS.bc, 'dirichlet');
        if (axisEdge && bc !== 'axis') pass.error(`${path}.bc`, 'E_EDGE', 'The r = 0 edge of a cylindrical domain is the symmetry axis.');
        if (!axisEdge && bc === 'axis') pass.error(`${path}.bc`, 'E_EDGE', 'Only the r = 0 edge of a cylindrical domain can be the axis.');
        if (bc === 'dirichlet') {
            const id = e.electrode === undefined || e.electrode === null ? 'gnd' : e.electrode;
            res[key] = { ...e, bc, electrode: id, electrodeIndex: ref(id, `${path}.electrode`) };
        } else if (bc === 'profile') {
            const along = key === 'xmin' || key === 'xmax' ? dom.y : dom.x;
            const lo = along[0], hi = along[1];
            const segs = pass.list(e, 'segments', path, 1000);
            if (!segs.length) pass.error(`${path}.segments`, 'E_PROFILE', 'A profile edge needs at least one segment.');
            const rs = [];
            segs.forEach((s, i) => {
                const sp = `${path}.segments[${i}]`;
                if (!isObj(s)) { pass.error(sp, 'E_TYPE', 'A segment must be an object { from, to, electrode | ramp }.'); return; }
                const from = pass.num(s, 'from', sp), to = pass.num(s, 'to', sp);
                if (Number.isFinite(from) && Number.isFinite(to) && !(to > from)) pass.error(sp, 'E_PROFILE', 'A segment must end after it starts.');
                if (s.ramp !== undefined && s.ramp !== null) {
                    if (!Array.isArray(s.ramp) || s.ramp.length !== 2) { pass.error(`${sp}.ramp`, 'E_TYPE', '"ramp" must be [electrode A, electrode B].'); return; }
                    rs.push({ ...s, from, to, ramp: s.ramp.slice(), rampIndex: [ref(s.ramp[0], `${sp}.ramp[0]`), ref(s.ramp[1], `${sp}.ramp[1]`)] });
                } else {
                    const id = s.electrode === undefined || s.electrode === null ? 'gnd' : s.electrode;
                    rs.push({ ...s, from, to, electrode: id, electrodeIndex: ref(id, `${sp}.electrode`) });
                }
            });
            const sorted = rs.filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to)).sort((a, b) => a.from - b.from);
            if (sorted.length === rs.length && sorted.length > 0 && Number.isFinite(lo) && Number.isFinite(hi)) {
                const tol = 1e-6 * (Number.isFinite(dom.h) ? dom.h : 1) + 1e-9 * Math.abs(hi - lo);
                let good = Math.abs(sorted[0].from - lo) <= tol && Math.abs(sorted[sorted.length - 1].to - hi) <= tol;
                for (let i = 1; i < sorted.length && good; i++) if (Math.abs(sorted[i].from - sorted[i - 1].to) > tol) good = false;
                if (!good) pass.error(`${path}.segments`, 'E_PROFILE', `Profile segments must tile the edge exactly, from ${lo} to ${hi}, without gaps or overlaps.`);
            }
            res[key] = { ...e, bc, segments: sorted };
        } else res[key] = { ...e, bc };
    }
    // mirrors need the mirrored edge at 0 and a Neumann condition there
    if (dom.mirror.x) {
        if (dom.x[0] !== 0) pass.error('domain.x[0]', 'E_MIRROR', 'Mirror in x needs the domain to start at x = 0.');
        if (res.xmin.bc !== 'neumann') pass.error('domain.edges.xmin.bc', 'E_MIRROR', 'Mirror in x needs a Neumann (zero normal field) xmin edge.');
    }
    if (dom.mirror.y && !dom.cyl) {
        if (dom.y[0] !== 0) pass.error('domain.y[0]', 'E_MIRROR', 'Mirror in y needs the domain to start at y = 0.');
        if (res.ymin.bc !== 'neumann') pass.error('domain.edges.ymin.bc', 'E_MIRROR', 'Mirror in y needs a Neumann (zero normal field) ymin edge.');
    }
    // anti-mirrors need the plane at 0 and φ = 0 there: a grounded Dirichlet edge
    const am = dom.antimirror || { x: false, y: false };
    const grounded = (e) => e && e.bc === 'dirichlet' && e.electrodeIndex === 0;
    if (am.x) {
        if (dom.x[0] !== 0) pass.error('domain.x[0]', 'E_MIRROR', 'Anti-mirror in x needs the domain to start at x = 0.');
        if (!grounded(res.xmin)) pass.error('domain.edges.xmin', 'E_MIRROR', 'Anti-mirror in x needs a grounded (0 V) xmin edge: the potential is zero on the plane.');
    }
    if (am.y && !dom.cyl) {
        if (dom.y[0] !== 0) pass.error('domain.y[0]', 'E_MIRROR', 'Anti-mirror in y needs the domain to start at y = 0.');
        if (!grounded(res.ymin)) pass.error('domain.edges.ymin', 'E_MIRROR', 'Anti-mirror in y needs a grounded (0 V) ymin edge: the potential is zero on the plane.');
    }
    out.edges = res;
}

// ---------------------------------------------------------------- electrodes and waveforms

/** Canonical key of a waveform term (time channels: terms equal except for amplitude share one). */
function termKey(t) {
    if (!t) return null;
    if (t.type === 'cos') {
        let f = t.freq, p = t.phase || 0;
        if (f === 0) return null;
        if (f < 0) { f = -f; p = -p; }
        p = ((p % 360) + 360) % 360;
        if (p >= 180) p -= 180;
        return `cos|${f}|${p}`;
    }
    if (t.type === 'pulse') return `pulse|${t.t0}|${t.rise}|${t.width}|${t.fall}|${t.period}`;
    if (t.type === 'table') {
        let scale = 0;
        for (const q of t.points) if (Math.abs(q[1]) > Math.abs(scale)) scale = q[1];
        if (scale === 0) return null;
        return `table|${t.period}|${t.points.map((q) => q[0] + ':' + q[1] / scale).join(',')}`;
    }
    return null;
}

function resolveTerm(pass, t, path) {
    if (!isObj(t)) { pass.error(path, 'E_TYPE', 'A waveform term must be an object.'); return null; }
    const type = pass.enumv(t, 'type', path, ENUMS.termType);
    if (type === 'cos') {
        return { ...t, type, amp: pass.num(t, 'amp', path), freq: pass.num(t, 'freq', path, { min: 0 }), phase: pass.num(t, 'phase', path, { def: 0 }) };
    }
    if (type === 'pulse') {
        const r = { ...t, type, amp: pass.num(t, 'amp', path), t0: pass.num(t, 't0', path, { def: 0 }), rise: pass.num(t, 'rise', path, { min: 0 }),
            width: pass.num(t, 'width', path, { min: 0 }), fall: pass.num(t, 'fall', path, { min: 0 }), period: pass.num(t, 'period', path, { nullable: true, def: null, gt: 0 }) };
        if (r.period !== null && Number.isFinite(r.period) && r.period < r.rise + r.width + r.fall) pass.warn(`${path}.period`, 'W_PULSE_PERIOD', 'The period is shorter than the pulse, so the pulse does not repeat.');
        return r;
    }
    const pts = pass.points(t, 'points', path, 2, { minItems: 1, maxItems: LIMITS.tableKnots });
    for (let i = 1; i < pts.length; i++) if (Number.isFinite(pts[i][0]) && Number.isFinite(pts[i - 1][0]) && !(pts[i][0] > pts[i - 1][0])) { pass.error(`${path}.points[${i}][0]`, 'E_RANGE', 'Table times must increase.'); break; }
    return { ...t, type, points: pts, period: pass.num(t, 'period', path, { nullable: true, def: null, gt: 0 }) };
}

function resolveElectrodes(pass, list, out) {
    const eIndex = new Map();
    const seen = new Set();
    const res = [];
    if (!list.length) {
        pass.error('electrodes', 'E_GND', 'The electrode list must start with the ground electrode { id: "gnd", ground: true }.');
        eIndex.set('gnd', 0);
        out.electrodes = [{ id: 'gnd', name: 'Ground', ground: true, index: 0, kind: 'solid', v: 0, dc: 0, terms: [], transparent: false, transmission: 0 }];
        return eIndex;
    }
    if (list.length > LIMITS.electrodes) pass.error('electrodes', 'E_LIMIT', `At most ${LIMITS.electrodes} electrodes (including ground) are allowed.`);
    const channelKeys = new Set();
    list.forEach((e, i) => {
        const base = `electrodes[${i}]`;
        if (!isObj(e)) { pass.error(base, 'E_TYPE', 'An electrode must be an object.'); res.push({ id: `#${i}`, index: i, kind: 'solid', v: 0, dc: 0, terms: [], transparent: false, transmission: 0 }); return; }
        const id = pass.id(e, base, seen, 'electrode');
        if (id !== null && !eIndex.has(id)) eIndex.set(id, i);
        pass.str(e, 'name', base, { def: '', max: 200 });
        pass.color(e, 'color', base, false);
        if (i === 0) {
            if (id !== 'gnd' || e.ground !== true) pass.error(base, 'E_GND', 'The first electrode must be the ground electrode { id: "gnd", ground: true }.');
            if (e.v !== undefined && e.v !== 0 && e.v !== '0') pass.warn(`${base}.v`, 'W_GND_VOLTAGE', 'The ground electrode is always at 0 V; its voltage is ignored.');
            res.push({ ...e, index: 0, kind: 'solid', v: 0, dc: 0, terms: [], transparent: false, transmission: 0, wave: null });
            return;
        }
        if (id === 'gnd' || e.ground === true) pass.error(base, 'E_GND', 'Only the first electrode can be the ground electrode.');
        const kind = pass.enumv(e, 'kind', base, ENUMS.electrodeKind, 'solid');
        const transmission = pass.num(e, 'transmission', base, { def: 1, min: 0, max: 1 });
        const v = pass.num(e, 'v', base, { def: 0 });
        let terms = [];
        if (e.wave !== undefined && e.wave !== null) {
            if (!isObj(e.wave)) pass.error(`${base}.wave`, 'E_TYPE', '"wave" must be null or { terms: [...] }.');
            else {
                const tl = pass.list(e.wave, 'terms', `${base}.wave`, 16);
                terms = tl.map((t, j) => resolveTerm(pass, t, `${base}.wave.terms[${j}]`)).filter(Boolean);
            }
        }
        for (const t of terms) { const k = termKey(t); if (k !== null && Number.isFinite(t.amp) && t.amp !== 0) channelKeys.add(k); }
        res.push({ ...e, index: i, kind, transmission: kind === 'grid' ? transmission : 0, v, dc: v, terms, transparent: kind === 'grid', wave: terms.length ? { ...e.wave, terms } : null });
    });
    if (channelKeys.size > LIMITS.timeChannels) pass.error('electrodes', 'E_CHANNELS', `At most ${LIMITS.timeChannels} different waveform shapes (time channels) are allowed; found ${channelKeys.size}.`);
    out.electrodes = res;
    out.channelCount = channelKeys.size;
    return eIndex;
}

/**
 * Quasistatic check (spec §3.7, R16): the field follows the voltages instantly, which needs the device to be small compared
 * with the wavelength. W_QUASISTATIC when 2π·f_max·L/c > 0.05, with f_max (MHz) the largest of the cosine frequencies
 * (electrodes and ideal fields), the inverse periods of repeating pulses and tables, and the inverse of the shortest
 * non-zero pulse edge or table step (a zero-length edge is an ideal step and is not counted), and L (mm) the diagonal of the
 * domain (both halves when mirrored) or the z extent of the sources and planes, whichever is larger.
 */
export const QUASISTATIC_LIMIT = 0.05;
function quasistaticCheck(pass, out) {
    let fMax = 0, where = null;
    const take = (f, path) => { if (Number.isFinite(f) && Math.abs(f) > fMax) { fMax = Math.abs(f); where = path; } };
    (out.electrodes || []).forEach((e, i) => (e.terms || []).forEach((t, j) => {
        const p = `electrodes[${i}].wave.terms[${j}]`;
        if (!t || !(Number.isFinite(t.amp) ? t.amp !== 0 : true)) return;
        if (t.type === 'cos') take(t.freq, `${p}.freq`);
        else if (t.type === 'pulse') {
            if (t.period > 0) take(1 / t.period, `${p}.period`);
            for (const k of ['rise', 'fall']) if (t[k] > 0) take(1 / t[k], `${p}.${k}`);
        } else if (t.type === 'table' && Array.isArray(t.points)) {
            if (t.period > 0) take(1 / t.period, `${p}.period`);
            for (let q = 1; q < t.points.length; q++) {
                const dt = t.points[q][0] - t.points[q - 1][0];
                if (dt > 0 && t.points[q][1] !== t.points[q - 1][1]) take(1 / dt, `${p}.points[${q}]`);
            }
        }
    }));
    (out.idealFields || []).forEach((f) => { if (f && (f.type === 'quadrupole2d' || f.type === 'quadrupole3d') && f.V) take(f.freq, `idealFields[${f.srcIndex}].freq`); });
    if (!(fMax > 0) || !where) return;
    const d = out.domain || {};
    if (!Array.isArray(d.x) || !Array.isArray(d.y)) return;
    const mx = d.mirror && d.mirror.x ? 2 : 1, my = d.mirror && d.mirror.y ? 2 : 1;
    const lx = mx * Math.abs(d.x[1] - d.x[0]), ly = (d.type === 'cyl2d' ? 2 : my) * Math.abs(d.y[1] - d.y[0]);
    let L = Math.hypot(lx, ly);
    // planar: particles move freely in z; the z extent of the sources and planes is part of the device
    if (d.type === 'planar2d') {
        let z0 = Infinity, z1 = -Infinity;
        const zs = (v) => { if (Array.isArray(v) && Number.isFinite(v[2])) { z0 = Math.min(z0, v[2]); z1 = Math.max(z1, v[2]); } };
        for (const s of out.sources || []) { const ps = s.position || {}; zs(ps.p); zs(ps.p0); zs(ps.p1); zs(ps.center); }
        for (const pl of (out.recording && out.recording.planes) || []) if (pl.kind === 'z' && Number.isFinite(pl.at)) { z0 = Math.min(z0, pl.at); z1 = Math.max(z1, pl.at); }
        if (z1 > z0) L = Math.max(L, z1 - z0);
    }
    if (!(L > 0)) return;
    const x = 2 * Math.PI * fMax * L / C_MMUS;
    if (x > QUASISTATIC_LIMIT) {
        pass.warn(where, 'W_QUASISTATIC', `At ${+fMax.toPrecision(4)} MHz the device (${+L.toPrecision(4)} mm) is not small compared with the wavelength (2πfL/c = ${x.toPrecision(2)} > ${QUASISTATIC_LIMIT}): the quasistatic field, which follows the voltages instantly, is only approximate.`);
    }
}

// ---------------------------------------------------------------- shapes

function resolveTransform(pass, t, path, isQuadric) {
    if (t === undefined || t === null) return null;
    if (!isObj(t)) { pass.error(path, 'E_TYPE', '"transform" must be an object.'); return null; }
    const r = {
        ...t,
        translate: pass.vec(t, 'translate', path, 2, { def: [0, 0], pad3: false }),
        rotate: pass.num(t, 'rotate', path, { def: 0 }),
        about: pass.vec(t, 'about', path, 2, { def: [0, 0], pad3: false }),
        mirror: pass.enumv(t, 'mirror', path, ENUMS.mirror, 'none'),
    };
    if (isQuadric && Number.isFinite(r.rotate)) {
        const q = r.rotate / 90;
        if (Math.abs(q - Math.round(q)) > 1e-9) pass.error(`${path}.rotate`, 'E_QUADRIC_ROTATION', 'Quadrics accept only rotations by multiples of 90°.');
    }
    if (r.translate[0] === 0 && r.translate[1] === 0 && r.rotate === 0 && r.mirror === 'none') return null;
    return r;
}

function resolveShape(pass, s, i, eIndex, dom) {
    const base = `shapes[${i}]`;
    const type = pass.enumv(s, 'type', base, ENUMS.shapeType);
    const r = { ...s, type };
    let el = -1;
    if (s.electrode !== null && s.electrode !== undefined) {
        if (typeof s.electrode !== 'string' || !eIndex.has(s.electrode)) pass.error(`${base}.electrode`, 'E_REF', `Unknown electrode "${String(s.electrode)}".`);
        else el = eIndex.get(s.electrode);
    } else if (s.electrode === undefined) pass.error(`${base}.electrode`, 'E_REQUIRED', '"electrode" is required (null makes the shape a void).');
    r.electrode = s.electrode === undefined ? null : s.electrode;
    r.electrodeIndex = el;
    r.enabled = pass.bool(s, 'enabled', base, true);
    r.locked = pass.bool(s, 'locked', base, false);
    pass.str(s, 'name', base, { def: '', max: 200 });
    r.transform = resolveTransform(pass, s.transform, `${base}.transform`, type === 'quadric');
    const nonneg = { min: 0 };
    switch (type) {
        case 'box':
            r.x0 = pass.num(s, 'x0', base); r.x1 = pass.num(s, 'x1', base); r.y0 = pass.num(s, 'y0', base); r.y1 = pass.num(s, 'y1', base);
            if (r.x0 === r.x1 || r.y0 === r.y1) pass.warn(base, 'W_EMPTY_SHAPE', 'This box has zero width or height; use a line for zero-thickness sheets.');
            break;   // parts below the axis: W_CLIPPED_AXIS from geometryWarnings (every shape type)
        case 'tube':
            r.x0 = pass.num(s, 'x0', base); r.x1 = pass.num(s, 'x1', base); r.rIn = pass.num(s, 'rIn', base, nonneg); r.rOut = pass.num(s, 'rOut', base, nonneg);
            if (r.rOut < r.rIn) pass.error(`${base}.rOut`, 'E_RANGE', 'The outer radius must be at least the inner radius.');
            break;
        case 'plate':
            r.x = pass.num(s, 'x', base); r.t = pass.num(s, 't', base, nonneg); r.rHole = pass.num(s, 'rHole', base, nonneg); r.rOut = pass.num(s, 'rOut', base, nonneg);
            if (r.rOut < r.rHole) pass.error(`${base}.rOut`, 'E_RANGE', 'The outer radius must be at least the hole radius.');
            break;
        case 'disc':
            r.x = pass.num(s, 'x', base); r.t = pass.num(s, 't', base, nonneg); r.r = pass.num(s, 'r', base, nonneg);
            break;
        case 'circle':
            r.cx = pass.num(s, 'cx', base); r.cy = pass.num(s, 'cy', base); r.r = pass.num(s, 'r', base, nonneg);
            break;
        case 'annulus':
            r.cx = pass.num(s, 'cx', base); r.cy = pass.num(s, 'cy', base); r.rIn = pass.num(s, 'rIn', base, nonneg); r.rOut = pass.num(s, 'rOut', base, nonneg);
            r.a0 = pass.num(s, 'a0', base, { def: 0 }); r.a1 = pass.num(s, 'a1', base, { def: 360 });
            if (r.rOut < r.rIn) pass.error(`${base}.rOut`, 'E_RANGE', 'The outer radius must be at least the inner radius.');
            break;
        case 'polygon':
            r.points = pass.points(s, 'points', base, 2, { minItems: 3, maxItems: LIMITS.polygonPoints });
            break;
        case 'polyline':
            r.points = pass.points(s, 'points', base, 2, { minItems: 2, maxItems: LIMITS.polygonPoints });
            break;
        case 'quadric':
            r.A = pass.num(s, 'A', base); r.B = pass.num(s, 'B', base); r.C = pass.num(s, 'C', base);
            r.cx = pass.num(s, 'cx', base, { def: 0 }); r.cy = pass.num(s, 'cy', base, { def: 0 });
            r.clip = pass.vec(s, 'clip', base, 4);
            if (r.clip.every(Number.isFinite) && !(r.clip[1] > r.clip[0] && r.clip[3] > r.clip[2])) pass.error(`${base}.clip`, 'E_RANGE', 'The clip box must be [x0, x1, y0, y1] with x1 > x0 and y1 > y0.');
            if (r.A === 0 && r.B === 0) pass.error(base, 'E_RANGE', 'A and B cannot both be zero.');
            break;
        default: break;
    }
    return r;
}

// ---------------------------------------------------------------- magnets and ideal fields

function resolveRegion(pass, g, path) {
    if (!isObj(g)) { pass.error(path, 'E_REQUIRED', 'A field region needs a shape { type: "box" | "polygon" | "annulus", … }.'); return null; }
    const inferred = g.type || (Array.isArray(g.points) ? 'polygon' : (g.rOut !== undefined ? 'annulus' : 'box'));
    const type = ENUMS.regionType.includes(inferred) ? inferred : pass.enumv(g, 'type', path, ENUMS.regionType);
    if (type === 'box') {
        const r = { ...g, type, x0: pass.num(g, 'x0', path), x1: pass.num(g, 'x1', path), y0: pass.num(g, 'y0', path), y1: pass.num(g, 'y1', path) };
        if (r.x0 === r.x1 || r.y0 === r.y1) pass.warn(path, 'W_EMPTY_SHAPE', 'This region has zero area.');
        return r;
    }
    if (type === 'polygon') return { ...g, type, points: pass.points(g, 'points', path, 2, { minItems: 3, maxItems: LIMITS.polygonPoints }) };
    const r = { ...g, type, cx: pass.num(g, 'cx', path, { def: 0 }), cy: pass.num(g, 'cy', path, { def: 0 }), rIn: pass.num(g, 'rIn', path, { def: 0, min: 0 }),
        rOut: pass.num(g, 'rOut', path, { gt: 0 }), a0: pass.num(g, 'a0', path, { def: 0 }), a1: pass.num(g, 'a1', path, { def: 360 }) };
    if (r.rOut < r.rIn) pass.error(`${path}.rOut`, 'E_RANGE', 'The outer radius must be at least the inner radius.');
    return r;
}

function resolveMagnet(pass, m, i, dom) {
    const base = `magnets[${i}]`;
    const type = pass.enumv(m, 'type', base, ENUMS.magnetType);
    const r = { ...m, type, enabled: pass.bool(m, 'enabled', base, true) };
    pass.str(m, 'name', base, { def: '', max: 200 });
    if (type === 'uniform') r.B = pass.vec(m, 'B', base, 3, { pad3: false });
    else if (type === 'region') {
        r.B = pass.vec(m, 'B', base, 3, { pad3: false });
        if (dom.cyl && (r.B[1] !== 0 || r.B[2] !== 0)) pass.error(`${base}.B`, 'E_REGION_AXIAL', 'In a cylindrical domain a field region can only carry an axial field B = [Bx, 0, 0].');
        r.region = resolveRegion(pass, m.region, `${base}.region`);
    } else if (type === 'poles') {
        // magnetic scalar potential ψ (T·mm) on pole pieces; B = −∇ψ is solved on the domain grid
        r.boundary = pass.enumv(m, 'boundary', base, ENUMS.poleBoundary, 'neumann');
        const pieces = pass.list(m, 'pieces', base, LIMITS.poles);
        if (!pieces.length) pass.error(`${base}.pieces`, 'E_REQUIRED', 'Pole pieces need at least one piece { region, psi }.');
        r.pieces = pieces.map((pc, j) => {
            const p = `${base}.pieces[${j}]`;
            if (!isObj(pc)) { pass.error(p, 'E_TYPE', 'A pole piece must be an object { region, psi }.'); return null; }
            return { ...pc, region: resolveRegion(pass, pc.region, `${p}.region`), psi: pass.num(pc, 'psi', p) };
        }).filter(Boolean);
    } else {
        r.center = pass.vec(m, 'center', base, 3, { def: [0, 0, 0] });
        r.normal = pass.vec(m, 'normal', base, 3, { def: [1, 0, 0], nonzero: true });
        r.radius = pass.num(m, 'radius', base, { gt: 0 });
        r.turns = pass.num(m, 'turns', base, { def: 1, gt: 0 });
        r.current = pass.num(m, 'current', base);
        if (dom.cyl && (r.center[1] !== 0 || r.center[2] !== 0 || r.normal[1] !== 0 || r.normal[2] !== 0)) pass.warn(base, 'W_LOOP_NOT_COAXIAL', 'This loop is not on the symmetry axis, so its field is not axisymmetric.');
    }
    return r;
}

function resolveIdeal(pass, f, i) {
    const base = `idealFields[${i}]`;
    const type = pass.enumv(f, 'type', base, ENUMS.idealType);
    const r = { ...f, type, enabled: pass.bool(f, 'enabled', base, true) };
    switch (type) {
        case 'uniformE': {
            r.E = pass.vec(f, 'E', base, 3); r.ref = pass.vec(f, 'ref', base, 3, { def: [0, 0, 0] });
            if (f.box === undefined || f.box === null) r.box = null;
            else if (!isObj(f.box)) { pass.error(`${base}.box`, 'E_TYPE', '"box" must be null or { min, max }.'); r.box = null; }
            else r.box = { ...f.box, min: pass.vec(f.box, 'min', `${base}.box`, 3), max: pass.vec(f.box, 'max', `${base}.box`, 3) };
            break;
        }
        case 'quadrupole2d':
            r.center = pass.vec(f, 'center', base, 2, { def: [0, 0], pad3: false }); r.r0 = pass.num(f, 'r0', base, { gt: 0 });
            r.U = pass.num(f, 'U', base, { def: 0 }); r.V = pass.num(f, 'V', base, { def: 0 }); r.freq = pass.num(f, 'freq', base, { def: 0, min: 0 }); r.phase = pass.num(f, 'phase', base, { def: 0 });
            break;
        case 'quadrupole3d':
            r.center = pass.vec(f, 'center', base, 3, { def: [0, 0, 0] }); r.r0 = pass.num(f, 'r0', base, { gt: 0 }); r.z0 = pass.num(f, 'z0', base, { def: 0, min: 0 });
            r.U = pass.num(f, 'U', base, { def: 0 }); r.V = pass.num(f, 'V', base, { def: 0 }); r.freq = pass.num(f, 'freq', base, { def: 0, min: 0 }); r.phase = pass.num(f, 'phase', base, { def: 0 });
            break;
        case 'coax':
            r.center = pass.vec(f, 'center', base, 2, { def: [0, 0], pad3: false }); r.a = pass.num(f, 'a', base, { gt: 0 }); r.b = pass.num(f, 'b', base, { gt: 0 });
            r.Va = pass.num(f, 'Va', base, { def: 0 }); r.Vb = pass.num(f, 'Vb', base, { def: 0 });
            if (r.b <= r.a) pass.error(`${base}.b`, 'E_RANGE', 'The outer radius must exceed the inner radius.');
            break;
        case 'sphere':
            r.center = pass.vec(f, 'center', base, 3, { def: [0, 0, 0] }); r.R1 = pass.num(f, 'R1', base, { gt: 0 }); r.R2 = pass.num(f, 'R2', base, { gt: 0 });
            r.V1 = pass.num(f, 'V1', base, { def: 0 }); r.V2 = pass.num(f, 'V2', base, { def: 0 });
            if (r.R2 <= r.R1) pass.error(`${base}.R2`, 'E_RANGE', 'The outer radius must exceed the inner radius.');
            break;
        default: break;
    }
    return r;
}

// ---------------------------------------------------------------- sources

/** Class count `n` (evaluated in both modes so the resolved object holds numbers; counts only in grid mode). */
function classCount(pass, o, path, grid, q) {
    const n = pass.num(o, 'n', path, { def: 1, int: true, min: 1 });
    if (o && o.n !== undefined && o.n !== null) q.n = n;
    else if (grid) q.n = n;
    return grid ? n : 1;
}

/** Species entries { label, mass, charge, fraction } of a source. */
function resolveSpecies(pass, list, base) {
    return list.map((x, j) => {
        const p = `${base}.species[${j}]`;
        if (!isObj(x)) { pass.error(p, 'E_TYPE', 'A species must be an object { label, mass, charge, fraction }.'); return { label: '', mass: NaN, charge: NaN, fraction: 0 }; }
        const mass = pass.num(x, 'mass', p, { gt: 0 });
        return { ...x, label: pass.str(x, 'label', p, { def: speciesLabel(mass, x.charge), max: 100 }), mass,
            charge: pass.num(x, 'charge', p, { nonzero: true }), fraction: pass.num(x, 'fraction', p, { def: 1, min: 0 }) };
    });
}
function speciesLabel(mass, charge) {
    if (!Number.isFinite(mass)) return '';
    const q = typeof charge === 'number' && Number.isFinite(charge) && charge !== 0 ? charge : 1;
    return Math.abs(q) === 1 ? `m/z ${+mass.toPrecision(6)}` : `m/z ${+(mass / Math.abs(q)).toPrecision(6)} (${q > 0 ? '+' : '−'}${Math.abs(q)}e)`;
}

const MAX_ROW_ERRORS = 50;

/**
 * A 'rows' source: one array per particle, [mass, charge, x, y, z, dx, dy, dz, ke, t0] (10 columns) or, with
 * `velocity: true`, [mass, charge, x, y, z, vx, vy, vz, t0] (9 columns, mm/µs). The resolved rows are always the
 * 10-column form with a unit direction (a direction already unit to 1e-9 in |d|² is kept bit for bit, so a frozen
 * sampled source reproduces its run exactly) and the kinetic energy of a velocity row from |v| with the run's
 * relativistic flag. `species` is optional; every (mass, charge) of the rows that is not listed is appended with
 * a default label, so the resolved species list covers every row.
 */
function resolveRowsSource(pass, s, r, base, ctx) {
    const velocity = pass.bool(s, 'velocity', base, false);
    r.velocity = velocity;
    const ncol = velocity ? 9 : 10;
    const cols = velocity ? ROW_COLUMNS_VELOCITY : ROW_COLUMNS;
    if (s.rows === undefined || s.rows === null) pass.error(`${base}.rows`, 'E_REQUIRED', 'A particle list needs "rows": one array per particle.');
    const list = pass.list(s, 'rows', base, LIMITS.rows);
    const spIn = s.species === undefined || s.species === null ? [] : pass.list(s, 'species', base, 64);
    const species = resolveSpecies(pass, spIn, base);
    const spKey = new Map();
    species.forEach((sp, k) => { const key = `${sp.mass}|${sp.charge}`; if (!spKey.has(key)) spKey.set(key, k); });
    const rel = ctx.relativistic !== false;
    const silent = new Pass(pass.vars);   // after MAX_ROW_ERRORS reported rows, further rows are checked without reports
    let bad = 0, shown = 0;
    const rows = [];
    const points = [];
    let dirAll = null, sameDir = true;
    for (let j = 0; j < list.length; j++) {
        const row = list[j], p = `${base}.rows[${j}]`;
        const P = shown < MAX_ROW_ERRORS ? pass : silent;
        const e0 = P.errors.length;
        if (!Array.isArray(row) || row.length !== ncol) {
            P.error(p, 'E_TYPE', `Each row needs ${ncol} values: ${cols.join(', ')}.`);
        } else {
            const m = P.value(row[0], `${p}[0]`, { gt: 0 }), q = P.value(row[1], `${p}[1]`, { nonzero: true });
            const x = P.value(row[2], `${p}[2]`), y = P.value(row[3], `${p}[3]`), z = P.value(row[4], `${p}[4]`);
            let a = P.value(row[5], `${p}[5]`), b = P.value(row[6], `${p}[6]`), c = P.value(row[7], `${p}[7]`);
            let ke, t0;
            const n2 = a * a + b * b + c * c;
            if (velocity) {
                t0 = P.value(row[8], `${p}[8]`);
                if (n2 === 0) P.error(`${p}[5]`, 'E_RANGE', 'The velocity must not be zero.');
                else if (Number.isFinite(n2)) {
                    const v = Math.sqrt(n2), beta = v / C_MMUS;
                    if (rel && beta >= 1) P.error(`${p}[5]`, 'E_RANGE', 'The speed must be below c (299792.458 mm/µs).');
                    else {
                        ke = rel ? (1 / Math.sqrt(1 - beta * beta) - 1) * m * UC2_EV : m * n2 / (2 * K_ACC);
                        a /= v; b /= v; c /= v;
                    }
                }
            } else {
                ke = P.value(row[8], `${p}[8]`, { min: 0 }); t0 = P.value(row[9], `${p}[9]`);
                if (n2 === 0) P.error(`${p}[5]`, 'E_RANGE', 'The direction must not be the zero vector.');
                else if (Number.isFinite(n2) && Math.abs(n2 - 1) > 1e-9) { const n = Math.sqrt(n2); a /= n; b /= n; c /= n; }
            }
            if (P.errors.length === e0 && [m, q, x, y, z, a, b, c, ke, t0].every(Number.isFinite)) {
                rows.push([m, q, x, y, z, a, b, c, ke, t0]);
                const key = `${m}|${q}`;
                if (!spKey.has(key)) { spKey.set(key, species.length); species.push({ label: speciesLabel(m, q), mass: m, charge: q, fraction: 1 }); }
                if (points.length < 2000) points.push([x, y, z]);
                if (dirAll === null) dirAll = [a, b, c];
                else if (sameDir && (Math.abs(a - dirAll[0]) > 1e-12 || Math.abs(b - dirAll[1]) > 1e-12 || Math.abs(c - dirAll[2]) > 1e-12)) sameDir = false;
                continue;
            }
        }
        bad++;
        if (P === pass) shown++;
    }
    if (bad > shown) pass.error(`${base}.rows`, 'E_ROWS', `${bad} rows have errors (the first ${shown} are listed).`);
    if (!list.length && Array.isArray(s.rows)) pass.error(`${base}.rows`, 'E_RANGE', 'A particle list needs at least one row.');
    // class indices of a list frozen from a sampled source ('random', or one [position, direction, energy] per row, −1 for
    // none): the grouped metrics use them instead of guessing classes from repeated values. A list whose row count no
    // longer matches (rows added or removed) falls back to the guess.
    if (s.classes !== undefined) {   // the key is left out of lists without it, so their keys do not change
        r.classes = null;
        if (s.classes === 'random') r.classes = 'random';
        else if (Array.isArray(s.classes)) {
            const okCls = s.classes.every((c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= -1));
            if (!okCls) pass.warn(`${base}.classes`, 'W_CLASSES', 'The class indices of the list are not one [position, direction, energy] triple of whole numbers per row; they are ignored.');
            else if (s.classes.length === list.length && rows.length === list.length) r.classes = s.classes;
        } else if (s.classes !== null) pass.warn(`${base}.classes`, 'W_CLASSES', '"classes" must be "random" or one [position, direction, energy] triple per row; it is ignored.');
    }
    r.species = species;
    r.rows = rows;
    r.count = rows.length;
    // canvas preview and summaries: the row positions as a point list, a common direction when all rows share one
    r.position = { type: 'list', points, preview: true };
    r.direction = sameDir && dirAll ? { type: 'fixed', dir: dirAll } : null;
    r.energy = null;
    r.time = null;
    r.sampling = 'rows';
    return r;
}

function resolveSource(pass, s, i, ctx = {}) {
    const base = `sources[${i}]`;
    const r = { ...s };
    r.enabled = pass.bool(s, 'enabled', base, true);
    pass.str(s, 'name', base, { def: '', max: 200 });
    pass.color(s, 'color', base, true);
    r.type = pass.enumv(s, 'type', base, ENUMS.sourceType, 'sampled');
    r.weight = pass.num(s, 'weight', base, { def: 1, gt: 0 });
    if (r.type === 'rows') return resolveRowsSource(pass, s, r, base, ctx);
    r.sampling = pass.enumv(s, 'sampling', base, ENUMS.sampling, 'random');
    const grid = r.sampling === 'grid';
    r.seed = pass.num(s, 'seed', base, { def: 1, int: true, min: 0 });
    // species
    const sp = pass.list(s, 'species', base, 64);
    if (!sp.length) pass.error(`${base}.species`, 'E_REQUIRED', 'A source needs at least one species.');
    r.species = resolveSpecies(pass, sp, base);
    if (!grid && r.species.length > 1 && r.species.every((x) => x.fraction === 0)) pass.error(`${base}.species`, 'E_RANGE', 'At least one species needs a fraction above zero.');
    // position
    let nPos = 1, nDir = 1, nE = 1, nT = 1;
    const pos = pass.obj(s, 'position', base);
    if (pos) {
        const p = `${base}.position`;
        const type = pass.enumv(pos, 'type', p, ENUMS.positionType);
        const q = { ...pos, type };
        switch (type) {
            case 'point': q.p = pass.vec(pos, 'p', p, 3); break;
            case 'line': q.p0 = pass.vec(pos, 'p0', p, 3); q.p1 = pass.vec(pos, 'p1', p, 3); nPos = classCount(pass, pos, p, grid, q); break;
            case 'disc': q.center = pass.vec(pos, 'center', p, 3); q.normal = pass.vec(pos, 'normal', p, 3, { nonzero: true }); q.radius = pass.num(pos, 'radius', p, { min: 0 });
                nPos = classCount(pass, pos, p, grid, q); break;
            case 'rect': {
                q.center = pass.vec(pos, 'center', p, 3); q.u = pass.vec(pos, 'u', p, 3, { nonzero: true }); q.v = pass.vec(pos, 'v', p, 3, { nonzero: true });
                q.halfU = pass.num(pos, 'halfU', p, { min: 0 }); q.halfV = pass.num(pos, 'halfV', p, { min: 0 });
                if (grid || (pos.n !== undefined && pos.n !== null)) {
                    let n = pos.n;
                    if (n === undefined || n === null) n = [1, 1];
                    else if (!Array.isArray(n)) n = [n, n];
                    const nn = n.length === 2 ? n.map((v, c) => pass.value(v, `${p}.n[${c}]`, { int: true, min: 1 })) : (pass.error(`${p}.n`, 'E_TYPE', '"n" must be [nu, nv].'), [1, 1]);
                    q.n = nn;
                    if (grid) nPos = nn[0] * nn[1];
                }
                break;
            }
            case 'gaussian':
                q.center = pass.vec(pos, 'center', p, 3); q.sigma = pass.vec(pos, 'sigma', p, 3, { min: 0 });
                if (grid) pass.error(`${p}.type`, 'E_SAMPLING', 'Gaussian positions need random sampling.');
                break;
            case 'list':
                q.points = pass.points(pos, 'points', p, 3, { minItems: 1, maxItems: LIMITS.listItems });
                if (grid) nPos = Math.max(1, q.points.length);
                break;
            default: break;
        }
        r.position = q;
    }
    const dir = pass.obj(s, 'direction', base);
    if (dir) {
        const p = `${base}.direction`;
        const type = pass.enumv(dir, 'type', p, ENUMS.directionType);
        const q = { ...dir, type };
        switch (type) {
            case 'fixed': q.dir = pass.vec(dir, 'dir', p, 3, { nonzero: true }); break;
            case 'cone': q.axis = pass.vec(dir, 'axis', p, 3, { nonzero: true }); q.halfAngle = pass.num(dir, 'halfAngle', p, { min: 0, max: 180 });
                q.fill = pass.enumv(dir, 'fill', p, ENUMS.coneFill, 'solid'); nDir = classCount(pass, dir, p, grid, q); break;
            case 'fan': q.axis = pass.vec(dir, 'axis', p, 3, { nonzero: true }); q.normal = pass.vec(dir, 'normal', p, 3, { nonzero: true });
                q.from = pass.num(dir, 'from', p); q.to = pass.num(dir, 'to', p); nDir = classCount(pass, dir, p, grid, q); break;
            case 'isotropic': q.axis = pass.vec(dir, 'axis', p, 3, { def: [1, 0, 0], nonzero: true }); q.beta = pass.num(dir, 'beta', p, { def: 0, min: -1, max: 2 });
                nDir = classCount(pass, dir, p, grid, q); break;
            default: break;
        }
        r.direction = q;
    }
    const en = pass.obj(s, 'energy', base);
    if (en) {
        const p = `${base}.energy`;
        const type = pass.enumv(en, 'type', p, ENUMS.energyType);
        const q = { ...en, type };
        switch (type) {
            case 'mono': q.ke = pass.num(en, 'ke', p, { min: 0 }); break;
            case 'uniform': q.min = pass.num(en, 'min', p, { min: 0 }); q.max = pass.num(en, 'max', p, { min: 0 });
                if (q.max < q.min) pass.error(`${p}.max`, 'E_RANGE', 'The maximum energy must be at least the minimum.');
                nE = classCount(pass, en, p, grid, q); break;
            case 'gaussian': q.mean = pass.num(en, 'mean', p, { gt: 0 }); q.fwhm = pass.num(en, 'fwhm', p, { min: 0 });
                if (grid) pass.error(`${p}.type`, 'E_SAMPLING', 'Gaussian energies need random sampling.');
                break;
            case 'list': q.values = pass.points(en, 'values', p, 1, { minItems: 1, maxItems: LIMITS.listItems, min: 0 }); if (grid) nE = Math.max(1, q.values.length); break;
            default: break;
        }
        r.energy = q;
    }
    const tm = pass.obj(s, 'time', base, { nullable: true });
    if (tm) {
        const p = `${base}.time`;
        const type = pass.enumv(tm, 'type', p, ENUMS.timeType);
        const q = { ...tm, type };
        switch (type) {
            case 'fixed': q.t = pass.num(tm, 't', p, { def: 0 }); break;
            case 'uniform': q.t0 = pass.num(tm, 't0', p); q.t1 = pass.num(tm, 't1', p);
                if (q.t1 < q.t0) pass.error(`${p}.t1`, 'E_RANGE', 'The end time must not be before the start.');
                nT = classCount(pass, tm, p, grid, q); break;
            case 'rfPhase': q.freq = pass.num(tm, 'freq', p, { gt: 0 }); nT = classCount(pass, tm, p, grid, q); break;
            case 'list': q.values = pass.points(tm, 'values', p, 1, { minItems: 1, maxItems: LIMITS.listItems }); if (grid) nT = Math.max(1, q.values.length); break;
            default: break;
        }
        r.time = q;
    } else r.time = { type: 'fixed', t: 0 };
    if (grid) {
        const c = r.species.length * nPos * nDir * nE * nT;
        r.count = Number.isFinite(c) ? c : 0;
    } else r.count = pass.num(s, 'count', base, { int: true, min: 0 });
    if (!Number.isFinite(r.count)) r.count = 0;
    return r;
}

// ---------------------------------------------------------------- recording, tracer, solver

function resolvePlanes(pass, list, dom) {
    const seen = new Set();
    return list.map((pl, i) => {
        const base = `recording.planes[${i}]`;
        if (!isObj(pl)) { pass.error(base, 'E_TYPE', 'A plane must be an object.'); return null; }
        pass.id(pl, base, seen, 'plane');
        pass.str(pl, 'name', base, { def: '', max: 200 });
        const kind = pass.enumv(pl, 'kind', base, ENUMS.planeKind);
        const r = { ...pl, index: i, kind };
        if (kind === 'segment') {
            r.p0 = pass.vec(pl, 'p0', base, 2, { pad3: false }); r.p1 = pass.vec(pl, 'p1', base, 2, { pad3: false });
            if (r.p0[0] === r.p1[0] && r.p0[1] === r.p1[1]) pass.error(base, 'E_RANGE', 'A segment plane needs two different end points.');
        } else if (kind === 'sphere') {
            // spherical test surface |P − center| = at (radius)
            r.at = pass.num(pl, 'at', base, { gt: 0 });
            r.center = pass.vec(pl, 'center', base, 3, { def: [0, 0, 0] });
        } else {
            r.at = pass.num(pl, 'at', base, kind === 'r' ? { gt: 0 } : {});
            if (kind === 'r' && !dom.cyl) pass.error(`${base}.kind`, 'E_ENUM', 'Cylinder planes (r = const) need a cylindrical domain.');
        }
        if (pl.limits === undefined || pl.limits === null) r.limits = null;
        else if (!isObj(pl.limits)) { pass.error(`${base}.limits`, 'E_TYPE', '"limits" must be null or { a: [min, max], b: [min, max] }.'); r.limits = null; }
        else {
            const lim = {};
            for (const ax of ['a', 'b']) {
                if (pl.limits[ax] === undefined || pl.limits[ax] === null) continue;
                lim[ax] = pass.vec(pl.limits, ax, `${base}.limits`, 2, { pad3: false });
                if (!(lim[ax][1] >= lim[ax][0])) pass.error(`${base}.limits.${ax}`, 'E_RANGE', 'Limits must be [min, max] with max ≥ min.');
            }
            r.limits = lim;
        }
        r.radius = pass.num(pl, 'radius', base, { nullable: true, def: null, gt: 0 });
        r.terminate = pass.bool(pl, 'terminate', base, false);
        r.side = pass.enumv(pl, 'side', base, ENUMS.side, 'both');
        r.record = pass.enumv(pl, 'record', base, ENUMS.record, 'first');
        return r;
    }).filter(Boolean);
}

function resolveTracer(pass, t) {
    const base = 'tracer';
    const tr = isObj(t) ? t : {};
    if (t !== undefined && !isObj(t)) pass.error(base, 'E_TYPE', '"tracer" must be an object.');
    const r = { ...tr };
    r.integrator = pass.enumv(tr, 'integrator', base, ENUMS.integrator, 'auto');
    r.quality = pass.enumv(tr, 'quality', base, ENUMS.quality, 'normal');
    r.fieldInterp = pass.enumv(tr, 'fieldInterp', base, ENUMS.fieldInterp, 'cubic');
    r.relativistic = pass.bool(tr, 'relativistic', base, true);
    r.tMax = pass.num(tr, 'tMax', base, { def: 1000, gt: 0 });
    r.maxSteps = pass.num(tr, 'maxSteps', base, { def: 500000, int: true, min: 1, max: 1e9 });
    r.maxDrift = pass.num(tr, 'maxDrift', base, { def: 10000, gt: 0 });
    if (r.quality === 'custom') {
        const c = pass.obj(tr, 'custom', base);
        const p = `${base}.custom`;
        const d = QUALITY.normal;
        const q = c ? {
            rtol: pass.num(c, 'rtol', p, { def: d.rtol, gt: 0, lt: 1 }),
            maxStepCells: pass.num(c, 'maxStepCells', p, { def: d.maxStepCells, gt: 0, max: 1 }),
            nearStepCells: pass.num(c, 'nearStepCells', p, { def: d.nearStepCells, gt: 0, max: 1 }),
            rfStepsPerPeriod: pass.num(c, 'rfStepsPerPeriod', p, { def: d.rfStepsPerPeriod, gt: 0 }),
            borisStepsPerGyration: pass.num(c, 'borisStepsPerGyration', p, { def: d.borisStepsPerGyration, gt: 0 }),
        } : { ...d };
        if (c) { const dt = pass.num(c, 'dt', p, { nullable: true, def: null, gt: 0 }); if (dt !== null) q.dt = dt; }
        if (q.nearStepCells > q.maxStepCells) pass.error(`${p}.nearStepCells`, 'E_RANGE', 'The step near electrodes must not exceed the maximum step.');
        r.custom = c ? { ...c, ...q } : null;
        r.q = q;
    } else {
        if (tr.custom !== undefined && tr.custom !== null && !isObj(tr.custom)) pass.error(`${base}.custom`, 'E_TYPE', '"custom" must be null or an object.');
        r.q = { ...QUALITY[r.quality] };
    }
    if (tr.drag === undefined || tr.drag === null) r.drag = null;
    else if (!isObj(tr.drag)) { pass.error(`${base}.drag`, 'E_TYPE', '"drag" must be null or { type: "stokes", mobility, gasVelocity }.'); r.drag = null; }
    else r.drag = { ...tr.drag, type: pass.enumv(tr.drag, 'type', `${base}.drag`, ['stokes'], 'stokes'), mobility: pass.num(tr.drag, 'mobility', `${base}.drag`, { gt: 0 }),
        gasVelocity: pass.vec(tr.drag, 'gasVelocity', `${base}.drag`, 3, { def: [0, 0, 0] }) };
    // physics plug-ins: null (or enabled: false) in the resolved project means off
    r.spaceCharge = null;
    if (tr.spaceCharge !== undefined && tr.spaceCharge !== null) {
        const p = `${base}.spaceCharge`, sc = tr.spaceCharge;
        if (!isObj(sc)) pass.error(p, 'E_TYPE', '"spaceCharge" must be null or { enabled, model, softening, maxParticles, factor }.');
        else {
            const soft = sc.enabled === false;   // settings of a switched-off plug-in are only checked softly
            if (soft) pass.soft++;
            const q = { ...sc, enabled: pass.bool(sc, 'enabled', p, true), model: pass.enumv(sc, 'model', p, ENUMS.spaceChargeModel, 'coulomb'),
                softening: pass.num(sc, 'softening', p, { def: 1e-4, gt: 0 }),
                maxParticles: pass.num(sc, 'maxParticles', p, { def: LIMITS.spaceChargeParticles, int: true, min: 1, max: LIMITS.spaceChargeParticles }),
                factor: pass.num(sc, 'factor', p, { def: 1, min: 0 }),
                pairStep: pass.num(sc, 'pairStep', p, { nullable: true, def: null, gt: 0, max: 0.5 }) };
            if (q.pairStep === null) delete q.pairStep;   // empty: the accuracy preset's pair step (pipeline.PAIR_STEP)
            if (soft) pass.soft--;
            if (q.enabled) r.spaceCharge = q;
        }
    }
    r.gas = null;
    if (tr.gas !== undefined && tr.gas !== null) {
        const p = `${base}.gas`, g = tr.gas;
        if (!isObj(g)) pass.error(p, 'E_TYPE', '"gas" must be null or { enabled, model, pressure, temperature, mass, diameter, ionDiameter, velocity }.');
        else {
            const soft = g.enabled === false;
            if (soft) pass.soft++;
            const q = { ...g, enabled: pass.bool(g, 'enabled', p, true), model: pass.enumv(g, 'model', p, ENUMS.gasModel, 'hardSphere'),
                pressure: pass.num(g, 'pressure', p, { min: 0 }), temperature: pass.num(g, 'temperature', p, { def: 293.15, gt: 0 }),
                mass: pass.num(g, 'mass', p, { gt: 0 }), diameter: pass.num(g, 'diameter', p, { gt: 0 }),
                ionDiameter: pass.num(g, 'ionDiameter', p, { nullable: true, def: null, gt: 0 }),
                velocity: pass.vec(g, 'velocity', p, 3, { def: [0, 0, 0] }) };
            if (soft) pass.soft--;
            if (q.enabled) r.gas = q;
        }
    }
    return r;
}

function resolveSolver(pass, s) {
    const base = 'solver';
    const so = isObj(s) ? s : {};
    if (s !== undefined && !isObj(s)) pass.error(base, 'E_TYPE', '"solver" must be an object.');
    const r = { ...so };
    r.boundary = pass.enumv(so, 'boundary', base, ENUMS.boundary, 'subgrid');
    r.method = pass.enumv(so, 'method', base, ENUMS.method, 'auto');
    let tol = pass.num(so, 'tol', base, { def: 1e-10, gt: 0, lt: 1 });
    if (tol < 1e-12) { pass.warn(`${base}.tol`, 'W_TOL_FLOOR', 'The solver tolerance cannot go below 1e-12; 1e-12 is used.'); tol = 1e-12; }
    r.tol = tol;
    r.maxCycles = pass.num(so, 'maxCycles', base, { def: 60, int: true, min: 1, max: 10000 });
    r.maxIterations = pass.num(so, 'maxIterations', base, { def: 200, int: true, min: 1, max: 100000 });
    r.maxSweeps = pass.num(so, 'maxSweeps', base, { def: 100000, int: true, min: 1, max: 10000000 });
    return r;
}

// ---------------------------------------------------------------- analysis, view, meta (soft: warnings only)

function resolveMetric(pass, m, path, refs) {
    if (!isObj(m)) { pass.error(path, 'E_TYPE', 'A metric must be an object { type, plane }.'); return null; }
    const r = { ...m, type: pass.enumv(m, 'type', path, ENUMS.metricType) };
    if (m.plane !== undefined && m.plane !== null && !refs.planes.has(m.plane)) pass.error(`${path}.plane`, 'W_REF', `Unknown plane "${String(m.plane)}".`);
    if (m.source !== undefined && m.source !== null && !refs.sources.has(m.source)) pass.error(`${path}.source`, 'W_REF', `Unknown source "${String(m.source)}".`);
    return r;
}

function resolveVariable(pass, v, path, refs) {
    if (!isObj(v)) { pass.error(path, 'E_TYPE', 'A variable must be an object { kind, id }.'); return null; }
    const kind = pass.enumv(v, 'kind', path, ENUMS.variableKind);
    const set = kind === 'param' ? refs.params : kind === 'electrode' ? refs.electrodes : refs.sources;
    if (v.id !== null && v.id !== undefined && !set.has(v.id)) pass.error(`${path}.id`, 'W_REF', `Unknown ${kind === 'sourceEnergy' ? 'source' : kind} "${String(v.id)}".`);
    return { ...v, kind };
}

function resolveAnalysis(pass, a, refs) {
    const base = 'analysis';
    const an = isObj(a) ? a : {};
    const r = { ...an };
    pass.soft++;
    if (a !== undefined && a !== null && !isObj(a)) pass.error(base, 'E_TYPE', '"analysis" must be an object.');
    if (isObj(an.lens)) {
        const l = an.lens, p = `${base}.lens`;
        r.lens = { ...l, refX: pass.num(l, 'refX', p, { def: 0 }), D: pass.num(l, 'D', p, { gt: 0 }), xStart: pass.num(l, 'xStart', p), xEnd: pass.num(l, 'xEnd', p),
            mass: pass.num(l, 'mass', p, { gt: 0 }), charge: pass.num(l, 'charge', p, { nonzero: true }), keLeft: pass.num(l, 'keLeft', p, { gt: 0 }),
            heights: l.heights === undefined ? [0.02, 0.03, 0.04, 0.05, 0.06, 0.08] : pass.points(l, 'heights', p, 1, { minItems: 2, maxItems: 64, gt: 0 }),
            side: pass.enumv(l, 'side', p, ENUMS.lensSide, 'both') };
    } else if (an.lens !== undefined && an.lens !== null) pass.error(`${base}.lens`, 'E_TYPE', '"lens" must be null or an object.');
    else r.lens = null;
    if (isObj(an.scan)) {
        const s = an.scan, p = `${base}.scan`;
        const values = isObj(s.values) ? (Array.isArray(s.values.list)
            ? { ...s.values, list: pass.points(s.values, 'list', `${p}.values`, 1, { minItems: 1, maxItems: 1000 }) }
            : { ...s.values, from: pass.num(s.values, 'from', `${p}.values`), to: pass.num(s.values, 'to', `${p}.values`), n: pass.num(s.values, 'n', `${p}.values`, { int: true, min: 1, max: 1000 }) })
            : (pass.error(`${p}.values`, 'E_REQUIRED', 'A scan needs values { from, to, n } or { list }.'), null);
        r.scan = { ...s, variable: resolveVariable(pass, s.variable, `${p}.variable`, refs), values, metric: resolveMetric(pass, s.metric, `${p}.metric`, refs) };
    } else r.scan = an.scan === undefined ? null : an.scan;
    if (isObj(an.optimize)) {
        const o = an.optimize, p = `${base}.optimize`;
        const vars = pass.list(o, 'variables', p, 4);
        r.optimize = { ...o, variables: vars.map((v, i) => {
            const vp = `${p}.variables[${i}]`;
            const vv = resolveVariable(pass, v, vp, refs);
            if (!vv) return null;
            return { ...vv, lower: pass.num(v, 'lower', vp), upper: pass.num(v, 'upper', vp), step: pass.num(v, 'step', vp, { nullable: true, def: null, gt: 0 }) };
        }), metric: resolveMetric(pass, o.metric, `${p}.metric`, refs), goal: pass.enumv(o, 'goal', p, ENUMS.goal, 'min'),
        maxEval: pass.num(o, 'maxEval', p, { def: 60, int: true, min: 1, max: 1000 }) };
    } else r.optimize = an.optimize === undefined ? null : an.optimize;
    if (isObj(an.waist)) {
        const w = an.waist;
        if (w.plane !== undefined && w.plane !== null && !refs.planes.has(w.plane)) pass.error(`${base}.waist.plane`, 'W_REF', `Unknown plane "${String(w.plane)}".`);
        r.waist = { ...w };
    } else r.waist = an.waist === undefined ? null : an.waist;
    pass.soft--;
    return r;
}

function resolveView(pass, v) {
    const base = 'view';
    if (v === undefined || v === null) return null;
    pass.soft++;
    let r = null;
    if (!isObj(v)) pass.error(base, 'E_TYPE', '"view" must be an object.');
    else {
        r = { ...v };
        if (v.center !== undefined) r.center = pass.vec(v, 'center', base, 2, { pad3: false });
        if (v.scale !== undefined) r.scale = pass.num(v, 'scale', base, { gt: 0 });
        if (v.displayTime !== undefined) r.displayTime = pass.num(v, 'displayTime', base, { min: 0 });
        if (v.projection !== undefined) r.projection = pass.enumv(v, 'projection', base, ENUMS.projection, 'xy');
        if (v.colormap !== undefined) r.colormap = pass.enumv(v, 'colormap', base, ENUMS.colormap, 'auto');
        if (v.aspect !== undefined) r.aspect = pass.num(v, 'aspect', base, { gt: 0 });
        if (v.relief !== undefined) r.relief = pass.num(v, 'relief', base, { min: 0.25, max: 4 });
        if (v.contourLevels !== undefined && v.contourLevels !== null) r.contourLevels = pass.points(v, 'contourLevels', base, 1, { maxItems: 1000 });
        if (v.layers !== undefined && !isObj(v.layers)) pass.error(`${base}.layers`, 'E_TYPE', '"layers" must be an object.');
    }
    pass.soft--;
    return r;
}

function resolveMeta(pass, m) {
    if (m === undefined || m === null) return {};
    if (!isObj(m)) { pass.error('meta', 'E_TYPE', '"meta" must be an object.'); return {}; }
    pass.soft++;
    pass.str(m, 'name', 'meta', { def: '', max: 200 });
    pass.str(m, 'notes', 'meta', { def: '', max: 100000 });
    for (const k of ['created', 'modified', 'engine', 'preset']) pass.str(m, k, 'meta', { def: '', max: 100 });
    pass.soft--;
    return { ...m };
}

function resolveParamsMeta(pass, params) {
    params.forEach((p, i) => {
        if (!isObj(p)) return;
        const base = `params[${i}]`;
        pass.soft++;
        if (p.dim !== undefined) pass.enumv(p, 'dim', base, ENUMS.dim, 'none');
        pass.str(p, 'note', base, { def: '', max: 1000 });
        pass.soft--;
        if (p.slider !== undefined && p.slider !== null) {
            if (!isObj(p.slider)) pass.error(`${base}.slider`, 'E_TYPE', '"slider" must be null or { min, max, step }.');
            else {
                pass.soft++;
                const mn = pass.num(p.slider, 'min', `${base}.slider`), mx = pass.num(p.slider, 'max', `${base}.slider`);
                pass.num(p.slider, 'step', `${base}.slider`, { def: 1, gt: 0 });
                if (mx <= mn) pass.error(`${base}.slider.max`, 'E_RANGE', 'The slider maximum must exceed its minimum.');
                pass.soft--;
            }
        }
    });
}

// ---------------------------------------------------------------- the pass

function runPass(project, { mobile = false } = {}) {
    const lim = mobile ? LIMITS.mobile : LIMITS.desktop;
    const early = new Pass({});
    let p;
    try { p = migrate(project); } catch (e) {
        early.error(e.path || '', 'E_BAD_PROJECT', e.message);
        return { resolved: null, errors: early.errors, warnings: early.warnings };
    }
    if (typeof p.version !== 'number' || !Number.isInteger(p.version) || p.version < 1) early.error('version', 'E_VERSION', 'Unknown project version.');
    else if (p.version > SCHEMA_VERSION) early.error('version', 'E_VERSION', `This project was saved by a newer version (format ${p.version}); reload the page to update.`);
    // parameters
    const params = Array.isArray(p.params) ? p.params : [];
    if (!Array.isArray(p.params)) early.error('params', 'E_TYPE', '"params" must be a list.');
    if (params.length > LIMITS.params) early.error('params', 'E_LIMIT', `At most ${LIMITS.params} parameters are allowed.`);
    const pv = evaluateParams(params);
    const pass = new Pass(pv.values);
    for (const q of params) if (isObj(q) && typeof q.name === 'string') pass.declared.add(q.name);
    pass.errors.push(...early.errors, ...pv.errors);
    pass.warnings.push(...early.warnings);
    resolveParamsMeta(pass, params);
    const out = { format: p.format, version: p.version };
    for (const k of Object.keys(p)) if (!HAS.call(out, k)) out[k] = p[k];   // unknown keys kept
    out.paramValues = { ...pv.values };
    out.params = params.map((q) => (isObj(q) ? { ...q, value: typeof q.name === 'string' && HAS.call(pv.values, q.name) ? pv.values[q.name] : NaN } : q));
    out.meta = resolveMeta(pass, p.meta);
    // domain and electrodes
    const dOut = {};
    const dom = resolveDomain(pass, p.domain, dOut) || { type: 'cyl2d', cyl: true, h: NaN, x: [NaN, NaN], y: [0, NaN], nx: NaN, ny: NaN, mirror: { x: false, y: false } };
    const eList = Array.isArray(p.electrodes) ? p.electrodes : [];
    if (!Array.isArray(p.electrodes)) pass.error('electrodes', 'E_TYPE', '"electrodes" must be a list.');
    const eIndex = resolveElectrodes(pass, eList, out);
    resolveEdges(pass, p.domain, dOut, dom, eIndex);
    out.domain = { ...(isObj(p.domain) ? p.domain : {}), ...dOut };
    if (Number.isFinite(out.domain.N)) {
        if (out.domain.N > lim.maxNodes) pass.error('domain.cell', 'E_GRID_TOO_LARGE', `The grid has ${out.domain.N.toLocaleString('en-US')} nodes; the limit${mobile ? ' on phones' : ''} is ${lim.maxNodes.toLocaleString('en-US')}. Use a larger cell or a smaller domain.`);
        else if (out.domain.N > lim.warnNodes) pass.warn('domain.cell', 'W_GRID_LARGE', `The grid has ${out.domain.N.toLocaleString('en-US')} nodes; solving will be slow and memory-hungry.`);
    }
    // shapes
    const shapes = pass.list(p, 'shapes', '', LIMITS.shapes);
    const shapeIds = new Set();
    const rShapes = [];
    shapes.forEach((s, i) => {
        if (!isObj(s)) { pass.error(`shapes[${i}]`, 'E_TYPE', 'A shape must be an object.'); return; }
        const soft = s.enabled === false;
        if (soft) pass.soft++;
        pass.id(s, `shapes[${i}]`, shapeIds, 'shape');
        const r = resolveShape(pass, s, i, eIndex, dom);
        if (soft) pass.soft--;
        if (r.enabled !== false) rShapes.push({ ...r, srcIndex: i });
    });
    out.shapes = rShapes;
    // magnets and ideal fields
    const mags = pass.list(p, 'magnets', '', LIMITS.magnets);
    const magIds = new Set();
    const rMags = [];
    mags.forEach((m, i) => {
        if (!isObj(m)) { pass.error(`magnets[${i}]`, 'E_TYPE', 'A magnet must be an object.'); return; }
        const soft = m.enabled === false;
        if (soft) pass.soft++;
        pass.id(m, `magnets[${i}]`, magIds, 'magnet');
        const r = resolveMagnet(pass, m, i, dom);
        if (soft) pass.soft--;
        if (r.enabled !== false) rMags.push({ ...r, srcIndex: i });
    });
    if (rMags.filter((m) => m.type === 'region').length > 32) pass.error('magnets', 'E_LIMIT', 'At most 32 field regions are allowed.');
    out.magnets = rMags;
    const ideal = pass.list(p, 'idealFields', '', LIMITS.idealFields);
    const fIds = new Set();
    const rIdeal = [];
    ideal.forEach((f, i) => {
        if (!isObj(f)) { pass.error(`idealFields[${i}]`, 'E_TYPE', 'An ideal field must be an object.'); return; }
        const soft = f.enabled === false;
        if (soft) pass.soft++;
        if (f.id !== undefined) pass.id(f, `idealFields[${i}]`, fIds, 'field');
        const r = resolveIdeal(pass, f, i);
        if (soft) pass.soft--;
        if (r.enabled !== false) rIdeal.push({ ...r, srcIndex: i });
    });
    out.idealFields = rIdeal;
    // sources
    const sources = pass.list(p, 'sources', '', LIMITS.sources);
    const srcIds = new Set();
    const rSrc = [];
    const srcCtx = { relativistic: !(isObj(p.tracer) && p.tracer.relativistic === false) };
    sources.forEach((s, i) => {
        if (!isObj(s)) { pass.error(`sources[${i}]`, 'E_TYPE', 'A source must be an object.'); return; }
        const soft = s.enabled === false;
        if (soft) pass.soft++;
        pass.id(s, `sources[${i}]`, srcIds, 'source');
        const r = resolveSource(pass, s, i, srcCtx);
        if (soft) pass.soft--;
        if (r.enabled !== false) rSrc.push({ ...r, srcIndex: i });
    });
    let firstId = 0;
    rSrc.forEach((s, k) => { s.index = k; s.firstId = firstId; firstId += s.count; });
    out.sources = rSrc;
    out.particleCount = firstId;
    if (firstId > lim.maxParticles) pass.error('sources', 'E_LIMIT', `The run has ${firstId.toLocaleString('en-US')} particles; the limit${mobile ? ' on phones' : ''} is ${lim.maxParticles.toLocaleString('en-US')}.`);
    // recording
    const rec = isObj(p.recording) ? p.recording : {};
    if (p.recording !== undefined && !isObj(p.recording)) pass.error('recording', 'E_TYPE', '"recording" must be an object.');
    const planeList = pass.list(rec, 'planes', 'recording', LIMITS.planes);
    const planes = resolvePlanes(pass, planeList, dom);
    const trj = isObj(rec.trajectories) ? rec.trajectories : {};
    if (rec.trajectories !== undefined && rec.trajectories !== null && !isObj(rec.trajectories)) pass.error('recording.trajectories', 'E_TYPE', '"trajectories" must be an object { store, maxPoints }.');
    const trajectories = { ...trj, store: pass.bool(trj, 'store', 'recording.trajectories', true), maxPoints: pass.num(trj, 'maxPoints', 'recording.trajectories', { def: 2000, int: true, min: 2, max: 1e6 }) };
    let timeMarkers = null;
    if (rec.timeMarkers !== undefined && rec.timeMarkers !== null) {
        if (!isObj(rec.timeMarkers)) pass.error('recording.timeMarkers', 'E_TYPE', '"timeMarkers" must be null or { dt }.');
        else timeMarkers = { ...rec.timeMarkers, dt: pass.num(rec.timeMarkers, 'dt', 'recording.timeMarkers', { gt: 0 }) };
    }
    out.recording = { ...rec, planes, trajectories, timeMarkers };
    if (trajectories.store && firstId * trajectories.maxPoints > lim.pointBudget) {
        pass.warn('recording.trajectories.maxPoints', 'W_TRAJ_THINNED', `Stored trajectories are thinned to about ${Math.max(2, Math.floor(lim.pointBudget / Math.max(1, firstId)))} points per particle to stay within ${lim.pointBudget.toLocaleString('en-US')} points.`);
    }
    quasistaticCheck(pass, out);
    out.tracer = resolveTracer(pass, p.tracer);
    if (out.tracer.spaceCharge && firstId > out.tracer.spaceCharge.maxParticles) {
        pass.error('tracer.spaceCharge.maxParticles', 'E_LIMIT', `Space-charge runs trace at most ${out.tracer.spaceCharge.maxParticles.toLocaleString('en-US')} particles together; the sources give ${firstId.toLocaleString('en-US')}.`);
    }
    out.solver = resolveSolver(pass, p.solver);
    const refs = {
        planes: new Set(planes.map((x) => x.id)), sources: new Set(sources.filter(isObj).map((x) => x.id)),
        params: new Set(params.filter(isObj).map((x) => x.name)), electrodes: new Set(eIndex.keys()),
    };
    out.analysis = resolveAnalysis(pass, p.analysis, refs);
    out.view = resolveView(pass, p.view);
    out.limits = { ...lim, mobile: !!mobile };
    return { resolved: pass.errors.length ? null : out, errors: pass.errors, warnings: pass.warnings, partial: out };
}

/**
 * Checks a project. Never throws on user error.
 * @param {object} project
 * @param {{ mobile?: boolean }} [opts]
 * @returns {{ errors: Array<{path: string, code: string, message: string}>, warnings: Array<{path: string, code: string, message: string}> }}
 */
export function validate(project, opts = {}) {
    try {
        const r = runPass(project, opts);
        return { errors: r.errors, warnings: r.warnings };
    } catch (e) {
        return { errors: [{ path: '', code: 'E_INTERNAL', message: `Internal error while reading the project: ${e && e.message ? e.message : e}` }], warnings: [] };
    }
}

/**
 * Resolves a project into numbers, indices and grid sizes (spec §2.2.5). Never throws on user error;
 * `resolved` is null when there are errors.
 * @param {object} project
 * @param {{ mobile?: boolean }} [opts]
 * @returns {{ resolved: object|null, errors: object[], warnings: object[] }}
 */
export function resolve(project, { mobile = false } = {}) {
    try {
        const r = runPass(project, { mobile });
        return { resolved: r.resolved, errors: r.errors, warnings: r.warnings };
    } catch (e) {
        return { resolved: null, errors: [{ path: '', code: 'E_INTERNAL', message: `Internal error while reading the project: ${e && e.message ? e.message : e}` }], warnings: [] };
    }
}

/**
 * Maps a path in the resolved project (where disabled items were dropped) to the path in the project,
 * e.g. 'shapes[2].x1' → 'shapes[5].x1'. Paths of other sections are returned unchanged.
 * @param {object} resolved @param {string} path
 */
export function projectPath(resolved, path) {
    if (!resolved || typeof path !== 'string') return path;
    const m = /^(shapes|sources|magnets|idealFields)\[(\d+)\](.*)$/.exec(path);
    if (!m) return path;
    const item = resolved[m[1]] && resolved[m[1]][+m[2]];
    return item && typeof item.srcIndex === 'number' ? `${m[1]}[${item.srcIndex}]${m[3]}` : path;
}

/**
 * The value at a path such as 'shapes[3].x1' or 'domain.edges.ymax.segments[0].from' (undefined if absent).
 * @param {object} obj @param {string} path
 */
export function getPath(obj, path) {
    let cur = obj;
    for (const part of splitPath(path)) {
        if (cur === null || cur === undefined) return undefined;
        cur = cur[part];
    }
    return cur;
}

/**
 * Sets the value at a path (creating plain objects on the way); returns obj.
 * @param {object} obj @param {string} path @param {*} value
 */
export function setPath(obj, path, value) {
    const parts = splitPath(path);
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw new EngineError('E_BAD_PROJECT', 'Invalid path.');
        if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = typeof parts[i + 1] === 'number' ? [] : {};
        cur = cur[k];
    }
    const last = parts[parts.length - 1];
    if (last === '__proto__' || last === 'constructor' || last === 'prototype') throw new EngineError('E_BAD_PROJECT', 'Invalid path.');
    cur[last] = value;
    return obj;
}

function splitPath(path) {
    const out = [];
    const re = /([^.[\]]+)|\[(\d+)\]/g;
    let m;
    while ((m = re.exec(String(path))) !== null) out.push(m[2] !== undefined ? +m[2] : m[1]);
    return out;
}

/** True if `name` can be used as a parameter name. */
export { isIdentifier };
