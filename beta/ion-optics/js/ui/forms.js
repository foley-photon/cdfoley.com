/* ==========================================================================
   Ion optics UI: forms.js
   Numeric forms generated from the schema's UI descriptors
   ({ key, label, dim, kind, options?, min?, max?, help }, spec §2.2.5 META).
   Every numeric input accepts a number, a number with a unit ("2 kV") or an
   expression over parameters; invalid entries are flagged (aria-invalid, red
   border, message) and never reach the project, so the last valid value
   stays. Edits go through a committer that validates the edited project
   first and refuses changes that would add errors. FALLBACK_META describes
   every object type for the case where the schema's table lacks an entry.
   The parsing, path, locator and committer helpers are pure; the builders
   need a DOM.
   ========================================================================== */
import { parseQuantity, unitOf, formatNumber, dimOf, formatPretty } from './units.js';

// ---------------------------------------------------------------- descriptor table (fallback)
const L = (key, label, extra = {}) => ({ key, label, kind: 'number', dim: 'length', ...extra });
const N = (key, label, dim, extra = {}) => ({ key, label, kind: 'number', dim, ...extra });
const SEL = (key, label, options, extra = {}) => ({ key, label, kind: 'select', options, ...extra });
const BOOL = (key, label, extra = {}) => ({ key, label, kind: 'bool', ...extra });
const TXT = (key, label, extra = {}) => ({ key, label, kind: 'text', ...extra });
const V3 = (key, label, dim, extra = {}) => ({ key, label, kind: 'vec3', dim, ...extra });
const V2 = (key, label, dim, extra = {}) => ({ key, label, kind: 'vec2', dim, ...extra });
const INT = (key, label, extra = {}) => ({ key, label, kind: 'int', dim: 'none', min: 1, ...extra });
const REF = (key, label, ref, extra = {}) => ({ key, label, kind: 'ref', ref, ...extra });

/** Descriptor table used when the schema has no entry for an object type. */
export const FALLBACK_META = Object.freeze({
    meta: [TXT('name', 'Project name'), { key: 'notes', label: 'Notes', kind: 'textarea', optional: true }],
    param: [TXT('name', 'Name', { pattern: '^[A-Za-z_]\\w*$' }), { key: 'value', label: 'Value', kind: 'number', dimFrom: 'dim' },
        SEL('dim', 'Dimension', ['length', 'voltage', 'energy', 'mass', 'charge', 'angle', 'time', 'freq', 'field', 'none']), TXT('note', 'Note', { optional: true })],
    slider: [N('min', 'Slider minimum', 'none'), N('max', 'Slider maximum', 'none'), N('step', 'Slider step', 'none', { gt: 0 })],
    domain: [
        SEL('type', 'Domain type', [{ value: 'planar2d', label: 'Planar (x, y)' }, { value: 'cyl2d', label: 'Cylindrical (x, r)' }]),
        L('cell', 'Cell size', { gt: 0, help: 'Square cells; the solver works on (extent / cell + 1) nodes per direction.' }),
        { key: 'x', label: 'x extent [start, end]', kind: 'range2', dim: 'length' },
        { key: 'y', label: 'y or r extent [start, end]', kind: 'range2', dim: 'length' },
    ],
    edge: [
        SEL('bc', 'Boundary', [{ value: 'dirichlet', label: 'Fixed voltage (electrode)' }, { value: 'neumann', label: 'Zero normal field (Neumann)' }, { value: 'axis', label: 'Symmetry axis' }, { value: 'profile', label: 'Profile (segments and ramps)' }]),
        REF('electrode', 'Electrode', 'electrode'),
    ],
    segment: [L('from', 'From'), L('to', 'To'), REF('electrode', 'Electrode', 'electrode', { nullable: true, nullLabel: 'Ramp' }),
        { key: 'ramp', label: 'Ramp [from electrode, to electrode]', kind: 'refpair', ref: 'electrode' }],
    mirror: [BOOL('x', 'Mirror in x', { help: 'The domain covers x ≥ 0; needs a Neumann xmin edge at 0.' }),
        BOOL('y', 'Mirror in y', { help: 'Planar only; needs a Neumann ymin edge at 0.', when: ['planar2d'] })],
    beyond: ['xmin', 'xmax', 'ymin', 'ymax'].map((e) => SEL(e, `Beyond ${e}`, [{ value: 'stop', label: 'Stop' }, { value: 'drift', label: 'Field-free drift' }])),
    electrode: [
        TXT('name', 'Name'),
        { key: 'color', label: 'Color', kind: 'color' },
        SEL('kind', 'Kind', [{ value: 'solid', label: 'Solid' }, { value: 'grid', label: 'Mesh (transparent)' }]),
        N('transmission', 'Transmission', 'none', { min: 0, max: 1, showIf: { kind: 'grid' }, help: 'Fraction of particles that pass the mesh.' }),
        N('v', 'Voltage', 'voltage'),
    ],
    'term.cos': [N('amp', 'Amplitude', 'voltage'), N('freq', 'Frequency', 'freq', { min: 0 }), N('phase', 'Phase', 'angle')],
    'term.pulse': [N('amp', 'Amplitude', 'voltage'), N('t0', 'Start', 'time'), N('rise', 'Rise', 'time', { min: 0 }), N('width', 'Width', 'time', { min: 0 }), N('fall', 'Fall', 'time', { min: 0 }), N('period', 'Period', 'time', { nullable: true, help: 'Empty: a single pulse.' })],
    'term.table': [{ key: 'points', label: 'Points (t µs, V)', kind: 'points', dims: ['time', 'voltage'], minItems: 1 }, N('period', 'Period', 'time', { nullable: true })],
    shape: [TXT('name', 'Name', { optional: true }), REF('electrode', 'Electrode', 'electrode', { nullable: true, nullLabel: 'Void', help: 'Void carves free space out of earlier shapes.' }),
        BOOL('enabled', 'Enabled'), BOOL('locked', 'Locked')],
    'shape.box': [L('x0', 'x start'), L('x1', 'x end'), L('y0', 'y or r start'), L('y1', 'y or r end')],
    'shape.tube': [L('x0', 'x start'), L('x1', 'x end'), L('rIn', 'Inner radius', { min: 0 }), L('rOut', 'Outer radius', { min: 0 })],
    'shape.plate': [L('x', 'Position x'), L('t', 'Thickness', { min: 0 }), L('rHole', 'Hole radius', { min: 0 }), L('rOut', 'Outer radius', { min: 0 })],
    'shape.disc': [L('x', 'Position x'), L('t', 'Thickness', { min: 0 }), L('r', 'Radius', { min: 0 })],
    'shape.circle': [L('cx', 'Center x'), L('cy', 'Center y or r'), L('r', 'Radius', { min: 0 })],
    'shape.annulus': [L('cx', 'Center x'), L('cy', 'Center y or r'), L('rIn', 'Inner radius', { min: 0 }), L('rOut', 'Outer radius', { min: 0 }), N('a0', 'Start angle', 'angle'), N('a1', 'End angle', 'angle')],
    'shape.polygon': [{ key: 'points', label: 'Vertices (x, y per line)', kind: 'points', dims: ['length', 'length'], minItems: 3 }],
    'shape.polyline': [{ key: 'points', label: 'Points (x, y per line)', kind: 'points', dims: ['length', 'length'], minItems: 2, help: 'Zero thickness: a sheet or a mesh line.' }],
    'shape.quadric': [N('A', 'A', 'none'), N('B', 'B', 'none'), N('C', 'C', 'none', { help: 'Inside: A(x−cx)² + B(y−cy)² ≥ C within the clip box.' }), L('cx', 'Center x'), L('cy', 'Center y'), { key: 'clip', label: 'Clip box [x0, x1, y0, y1]', kind: 'vec4', dim: 'length' }],
    transform: [V2('translate', 'Translate [dx, dy]', 'length'), N('rotate', 'Rotate', 'angle'), V2('about', 'Pivot [x, y]', 'length'), SEL('mirror', 'Mirror', [{ value: 'none', label: 'None' }, { value: 'x', label: 'Flip x' }, { value: 'y', label: 'Flip y' }, { value: 'xy', label: 'Flip both' }])],
    magnet: [TXT('name', 'Name', { optional: true }), BOOL('enabled', 'Enabled'), SEL('type', 'Type', [{ value: 'uniform', label: 'Uniform field' }, { value: 'region', label: 'Field region (sharp edges)' }, { value: 'loop', label: 'Current loop' }])],
    'magnet.uniform': [V3('B', 'B [Bx, By, Bz]', 'flux')],
    'magnet.region': [V3('B', 'B [Bx, By, Bz]', 'flux', { help: 'Cylindrical domains allow Bx only.' })],
    'region.box': [L('x0', 'x start'), L('x1', 'x end'), L('y0', 'y start'), L('y1', 'y end')],
    'region.polygon': [{ key: 'points', label: 'Vertices (x, y per line)', kind: 'points', dims: ['length', 'length'], minItems: 3 }],
    'region.annulus': [L('cx', 'Center x'), L('cy', 'Center y'), L('rIn', 'Inner radius', { min: 0 }), L('rOut', 'Outer radius', { min: 0 }), N('a0', 'Start angle', 'angle'), N('a1', 'End angle', 'angle')],
    'magnet.loop': [V3('center', 'Center [x, y, z]', 'length'), V3('normal', 'Normal [x, y, z]', 'none'), L('radius', 'Radius', { gt: 0 }), N('turns', 'Turns', 'none', { gt: 0 }), N('current', 'Current', 'current', { help: 'Positive: counter-clockwise seen from +normal.' })],
    idealField: [BOOL('enabled', 'Enabled'), SEL('type', 'Type', [{ value: 'uniformE', label: 'Uniform E' }, { value: 'quadrupole2d', label: 'Quadrupole (2D)' }, { value: 'quadrupole3d', label: 'Quadrupole (3D, axis x)' }, { value: 'coax', label: 'Coaxial (log)' }, { value: 'sphere', label: 'Spherical (A + B/r)' }])],
    'ideal.uniformE': [V3('E', 'E [Ex, Ey, Ez]', 'field'), V3('ref', 'Zero-potential point', 'length')],
    'ideal.quadrupole2d': [V2('center', 'Center [x, y]', 'length'), L('r0', 'r₀', { gt: 0 }), N('U', 'U (DC)', 'voltage'), N('V', 'V (RF amplitude)', 'voltage'), N('freq', 'Frequency', 'freq', { min: 0 }), N('phase', 'Phase', 'angle')],
    'ideal.quadrupole3d': [V3('center', 'Center [x, y, z]', 'length'), L('r0', 'r₀', { gt: 0 }), L('z0', 'z₀', { min: 0 }), N('U', 'U (DC)', 'voltage'), N('V', 'V (RF amplitude)', 'voltage'), N('freq', 'Frequency', 'freq', { min: 0 }), N('phase', 'Phase', 'angle')],
    'ideal.coax': [V2('center', 'Center [x, y]', 'length'), L('a', 'Inner radius', { gt: 0 }), L('b', 'Outer radius', { gt: 0 }), N('Va', 'Inner voltage', 'voltage'), N('Vb', 'Outer voltage', 'voltage')],
    'ideal.sphere': [V3('center', 'Center [x, y, z]', 'length'), L('R1', 'Inner radius', { gt: 0 }), L('R2', 'Outer radius', { gt: 0 }), N('V1', 'Inner voltage', 'voltage'), N('V2', 'Outer voltage', 'voltage')],
    source: [TXT('name', 'Name'), BOOL('enabled', 'Enabled'), { key: 'color', label: 'Color', kind: 'color', auto: true },
        SEL('sampling', 'Sampling', [{ value: 'random', label: 'Random' }, { value: 'grid', label: 'Grid (Cartesian product)' }]),
        INT('count', 'Particles', { min: 0, showIf: { sampling: 'random' }, help: 'Grid sampling derives the count from the cards below.' }), INT('seed', 'Seed', { min: 0 })],
    species: [TXT('label', 'Label'), N('mass', 'Mass', 'mass', { gt: 0 }), N('charge', 'Charge', 'charge'), N('fraction', 'Fraction', 'none', { min: 0 })],
    'position.point': [V3('p', 'Point [x, y, z]', 'length')],
    'position.line': [V3('p0', 'Start [x, y, z]', 'length'), V3('p1', 'End [x, y, z]', 'length'), INT('n', 'Points (grid)')],
    'position.disc': [V3('center', 'Center [x, y, z]', 'length'), V3('normal', 'Normal [x, y, z]', 'none'), L('radius', 'Radius', { min: 0 }), INT('n', 'Points (grid)')],
    'position.rect': [V3('center', 'Center [x, y, z]', 'length'), V3('u', 'u direction', 'none'), V3('v', 'v direction', 'none'), L('halfU', 'Half-size along u', { min: 0 }), L('halfV', 'Half-size along v', { min: 0 }), { key: 'n', label: 'Points (grid) [nu, nv]', kind: 'vec2', dim: 'none', integer: true }],
    'position.gaussian': [V3('center', 'Center [x, y, z]', 'length'), V3('sigma', 'σ [x, y, z]', 'length')],
    'position.list': [{ key: 'points', label: 'Points (x, y, z per line)', kind: 'points', dims: ['length', 'length', 'length'], minItems: 1 }],
    'direction.fixed': [V3('dir', 'Direction [x, y, z]', 'none')],
    'direction.cone': [V3('axis', 'Axis [x, y, z]', 'none'), N('halfAngle', 'Half-angle', 'angle', { min: 0, max: 180 }), SEL('fill', 'Fill', [{ value: 'solid', label: 'Solid angle' }, { value: 'angle', label: 'Uniform angle' }, { value: 'lambert', label: 'Lambert (cosine)' }]), INT('n', 'Directions (grid)')],
    'direction.fan': [V3('axis', 'Axis [x, y, z]', 'none'), V3('normal', 'Fan normal [x, y, z]', 'none'), N('from', 'From', 'angle'), N('to', 'To', 'angle'), INT('n', 'Directions (grid)')],
    'direction.isotropic': [V3('axis', 'Axis [x, y, z]', 'none'), N('beta', 'β', 'none', { min: -1, max: 2 }), INT('n', 'Directions (grid)')],
    'energy.mono': [N('ke', 'Kinetic energy', 'energy', { min: 0 })],
    'energy.uniform': [N('min', 'Minimum', 'energy', { min: 0 }), N('max', 'Maximum', 'energy', { min: 0 }), INT('n', 'Energies (grid)')],
    'energy.gaussian': [N('mean', 'Mean', 'energy', { gt: 0 }), N('fwhm', 'FWHM', 'energy', { min: 0 })],
    'energy.list': [{ key: 'values', label: 'Energies', kind: 'list', dim: 'energy', minItems: 1 }],
    'time.fixed': [N('t', 'Birth time', 'time')],
    'time.uniform': [N('t0', 'From', 'time'), N('t1', 'To', 'time'), INT('n', 'Times (grid)')],
    'time.rfPhase': [N('freq', 'RF frequency', 'freq', { gt: 0 }), INT('n', 'Phases (grid)')],
    'time.list': [{ key: 'values', label: 'Birth times', kind: 'list', dim: 'time', minItems: 1 }],
    plane: [TXT('name', 'Name'), SEL('kind', 'Kind', [{ value: 'x', label: 'x = const' }, { value: 'y', label: 'y = const' }, { value: 'z', label: 'z = const' }, { value: 'r', label: 'Cylinder r = const' }, { value: 'segment', label: 'Segment' }]),
        L('at', 'Position'), V2('p0', 'Segment start [x, y]', 'length'), V2('p1', 'Segment end [x, y]', 'length'),
        L('radius', 'Radius limit', { nullable: true, gt: 0 }),
        BOOL('terminate', 'Detector (stops particles)'), SEL('side', 'Direction', [{ value: 'both', label: 'Both' }, { value: 'forward', label: 'Forward' }, { value: 'backward', label: 'Backward' }]),
        SEL('record', 'Record', [{ value: 'first', label: 'First crossing' }, { value: 'all', label: 'All crossings' }])],
    trajectories: [BOOL('store', 'Store trajectories'), INT('maxPoints', 'Points per particle', { min: 2 })],
    timeMarkers: [N('dt', 'Marker interval', 'time', { gt: 0 })],
    tracer: [SEL('integrator', 'Integrator', [{ value: 'auto', label: 'Automatic' }, { value: 'rk45', label: 'Dormand–Prince 5(4)' }, { value: 'boris', label: 'Boris (magnetic)' }, { value: 'rk4', label: 'Runge–Kutta 4 (fixed step)' }]),
        SEL('quality', 'Trajectory accuracy', [{ value: 'draft', label: 'Draft' }, { value: 'normal', label: 'Normal' }, { value: 'fine', label: 'Fine' }, { value: 'custom', label: 'Custom' }]),
        SEL('fieldInterp', 'Field interpolation', [{ value: 'cubic', label: 'Cubic (smooth, conservative)' }, { value: 'linear', label: 'Linear' }]),
        BOOL('relativistic', 'Relativistic'), N('tMax', 'Time limit', 'time', { gt: 0 }), INT('maxSteps', 'Step limit'), L('maxDrift', 'Drift limit', { gt: 0 })],
    custom: [N('rtol', 'Relative tolerance', 'none', { gt: 0 }), N('maxStepCells', 'Max step (cells)', 'none', { gt: 0, max: 1 }), N('nearStepCells', 'Max step near electrodes (cells)', 'none', { gt: 0, max: 1 }),
        N('rfStepsPerPeriod', 'Steps per RF period', 'none', { gt: 0 }), N('borisStepsPerGyration', 'Boris steps per gyration', 'none', { gt: 0 })],
    solver: [SEL('boundary', 'Boundary method', [{ value: 'subgrid', label: 'Sub-grid (Shortley–Weller)' }, { value: 'staircase', label: 'Staircase' }]),
        SEL('method', 'Solver', [{ value: 'auto', label: 'Automatic' }, { value: 'multigrid', label: 'Multigrid' }, { value: 'krylov', label: 'Krylov (BiCGSTAB)' }, { value: 'sor', label: 'SOR' }]),
        N('tol', 'Tolerance', 'none', { gt: 0 }), INT('maxCycles', 'Multigrid cycles'), INT('maxIterations', 'Krylov iterations'), INT('maxSweeps', 'SOR sweeps')],
});

/**
 * Descriptors of an object type from the schema's META (several key conventions accepted), else the fallback.
 * @param {object|null} META schema.META
 * @param {string} kind e.g. 'shape', 'position', 'domain'
 * @param {string} [sub] subtype e.g. 'box', 'line'
 * @returns {object[]} normalised descriptors
 */
export function metaFor(META, kind, sub = null) {
    const fromTable = (T) => {
        if (!T || typeof T !== 'object') return null;
        const keys = sub ? [`${kind}.${sub}`, `${kind}:${sub}`, `${kind}/${sub}`] : [kind];
        for (const k of keys) if (okList(T[k])) return T[k];
        if (sub) {
            for (const k of [kind, kind + 's']) {
                const g = T[k];
                if (g && typeof g === 'object' && !Array.isArray(g)) {
                    if (okList(g[sub])) return g[sub];
                    if (g[sub] && okList(g[sub].fields)) return g[sub].fields;
                }
            }
        } else if (T[kind] && okList(T[kind].fields)) return T[kind].fields;
        return null;
    };
    const list = fromTable(META) || fromTable(FALLBACK_META) || [];
    return list.map(normaliseDescriptor);
}

function okList(v) { return Array.isArray(v) && v.length > 0 && v.every((d) => d && typeof d === 'object' && typeof d.key === 'string'); }

/**
 * Fills in kind/dim defaults for a descriptor from any source. Platform kinds are mapped to the builder's:
 * 'point' (size n) → 'vec2'|'vec3'|'vec4' ('range2' for [start, end] extents), 'points' (size 1) → 'list',
 * 'select' with `ref` → 'ref' ('refpair' with `multiple`), 'text' with format 'color' → 'color',
 * 'text' with `multiline` → 'textarea', `onlyKind` → showIf.kind.
 * @param {object} d
 * @returns {object}
 */
export function normaliseDescriptor(d) {
    const o = { ...d };
    if (!o.kind) {
        if (Array.isArray(o.options)) o.kind = 'select';
        else if (o.type) o.kind = o.type;
        else if (o.dim) o.kind = 'number';
        else o.kind = 'text';
    }
    if (o.kind === 'integer') o.kind = 'int';
    if (o.kind === 'boolean' || o.kind === 'checkbox') o.kind = 'bool';
    if (o.kind === 'enum') o.kind = 'select';
    if (o.kind === 'string') o.kind = 'text';
    if (o.kind === 'vector' || o.kind === 'vec') o.kind = 'vec3';
    if (o.kind === 'point') {
        const n = o.size || 3;
        o.kind = n === 2 && /extent|\[start, end\]/i.test(o.label || '') ? 'range2' : n === 2 ? 'vec2' : n === 4 ? 'vec4' : 'vec3';
    } else if (o.kind === 'points') {
        const n = o.size || (Array.isArray(o.dims) ? o.dims.length : 2);
        if (n === 1) o.kind = 'list';
        else if (!Array.isArray(o.dims) || o.dims.length !== n) o.dims = new Array(n).fill(o.dim || 'none');
    } else if (o.kind === 'select' && o.ref) {
        o.kind = o.multiple ? 'refpair' : 'ref';
    } else if (o.kind === 'electrode') {
        o.kind = 'ref'; o.ref = 'electrode';
        if (o.allowVoid) { o.nullable = true; o.nullLabel = o.nullLabel || 'Void'; }
    } else if (o.kind === 'text' && o.format === 'color') {
        o.kind = 'color';
    } else if (o.kind === 'text' && o.multiline) {
        o.kind = 'textarea';
    }
    if (o.kind === 'color' && o.auto === undefined && typeof o.help === 'string' && /"auto"/.test(o.help)) o.auto = true;
    if ((o.kind === 'points' || o.kind === 'list') && !o.minItems) { o.minItems = typeof o.min === 'number' ? o.min : 1; }
    if (o.kind === 'points' || o.kind === 'list') delete o.min;
    if (o.onlyKind) o.showIf = { ...(o.showIf || {}), kind: o.onlyKind };
    if (!o.label) o.label = o.key;
    if (o.options) o.options = o.options.map((x) => (typeof x === 'object' && x !== null ? { value: x.value, label: x.label ?? String(x.value) } : { value: x, label: String(x) }));
    return o;
}

// ---------------------------------------------------------------- paths
/** Splits 'a.b[2].c' into ['a', 'b', 2, 'c']. */
export function splitPath(path) {
    if (Array.isArray(path)) return path;
    const out = [];
    String(path).replace(/[^.[\]]+|\[(\d+)\]/g, (m, idx) => { out.push(idx !== undefined ? Number(idx) : m); return m; });
    return out;
}

/** Value at a path (undefined when missing). */
export function getPath(obj, path) {
    let o = obj;
    for (const k of splitPath(path)) { if (o === null || o === undefined) return undefined; o = o[k]; }
    return o;
}

/** Sets a value at a path, creating plain objects on the way. Returns obj. */
export function setPath(obj, path, value) {
    const p = splitPath(path);
    let o = obj;
    for (let i = 0; i < p.length - 1; i++) {
        if (p[i] === '__proto__' || p[i] === 'constructor' || p[i] === 'prototype') return obj;
        if (o[p[i]] === null || o[p[i]] === undefined || typeof o[p[i]] !== 'object') o[p[i]] = typeof p[i + 1] === 'number' ? [] : {};
        o = o[p[i]];
    }
    const last = p[p.length - 1];
    if (last === '__proto__' || last === 'constructor' || last === 'prototype') return obj;
    o[last] = value;
    return obj;
}

/** Joins path parts into the 'a.b[2].c' form used in validation issues. */
export function joinPath(...parts) {
    let s = '';
    for (const part of parts.flatMap((x) => (x === '' || x === null || x === undefined ? [] : splitPath(x)))) s += typeof part === 'number' ? `[${part}]` : (s ? '.' : '') + part;
    return s;
}

// ---------------------------------------------------------------- object locators
/** Where each selectable kind lives in a project. Params are keyed by name, everything else by id. */
export const KIND_LISTS = Object.freeze({
    electrode: 'electrodes', shape: 'shapes', source: 'sources', plane: 'recording.planes',
    magnet: 'magnets', idealField: 'idealFields', param: 'params',
});

/**
 * Finds an object of a kind by id (name for params) in a project or resolved project.
 * @returns {{ obj: object, index: number, path: string } | null}
 */
export function locate(project, kind, id) {
    const listPath = KIND_LISTS[kind];
    if (!project || !listPath) return null;
    const list = getPath(project, listPath);
    if (!Array.isArray(list)) return null;
    const key = kind === 'param' ? 'name' : 'id';
    const index = list.findIndex((o) => o && o[key] === id);
    if (index < 0) return null;
    return { obj: list[index], index, path: `${listPath}[${index}]` };
}

/** The first id `prefix<n>` not used in `list` (objects with `id`). */
export function nextId(list, prefix) {
    const used = new Set((Array.isArray(list) ? list : []).map((o) => o && o.id));
    for (let n = 1; ; n++) if (!used.has(prefix + n)) return prefix + n;
}

/** The first parameter name `prefix<n>` not used in `params`. */
export function nextParamName(params, prefix = 'p') {
    const used = new Set((Array.isArray(params) ? params : []).map((o) => o && o.name));
    for (let n = 1; ; n++) if (!used.has(prefix + n)) return prefix + n;
}

/** Options for reference selects: { electrode, plane, param, source } as [{ value, label }]. */
export function refOptions(project) {
    const p = project || {};
    const named = (list, key = 'id') => (Array.isArray(list) ? list : []).filter((o) => o && typeof o[key] === 'string')
        .map((o) => ({ value: o[key], label: o.name && key === 'id' ? `${o.name} (${o[key]})` : o[key] }));
    return {
        electrode: named(p.electrodes),
        plane: named(p.recording && p.recording.planes),
        source: named(p.sources),
        param: named(p.params, 'name'),
    };
}

/** First validation message for a path (exact, then any child of it), from an issue list. */
export function issueAt(issues, path, { childrenToo = false, severity = 'error' } = {}) {
    if (!Array.isArray(issues) || !path) return null;
    for (const i of issues) if (i && i.path === path && (!severity || (i.severity || 'error') === severity)) return i.message;
    if (childrenToo) for (const i of issues) if (i && typeof i.path === 'string' && (i.path.startsWith(path + '.') || i.path.startsWith(path + '[')) && (!severity || (i.severity || 'error') === severity)) return i.message;
    return null;
}

/**
 * A committer: applies a mutator to a copy of the project, validates the copy, and writes it through the store
 * only if it adds no validation error, so an invalid edit never reaches the project and the last valid value
 * stays (spec §4.3). Errors that were already present (a project loaded with errors) do not block edits.
 * @param {{ store: object, schema: object }} deps
 * @returns {(mutator: (draft: object) => (object|void), opts?: { label?: string, merge?: string|null, force?: boolean }) => { ok: boolean, error?: string, path?: string }}
 */
export function createCommitter({ store, schema }) {
    const key = (i) => `${i.path}|${i.code}`;
    return function commit(mutator, opts = {}) {
        const st = store.get();
        let draft;
        try { draft = structuredClone(st.project); } catch (e) { draft = JSON.parse(JSON.stringify(st.project)); }
        let next;
        try {
            const ret = mutator(draft);
            next = ret && typeof ret === 'object' ? ret : draft;
        } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e) };
        }
        if (!opts.force && schema && typeof schema.validate === 'function') {
            let after, before;
            try { after = schema.validate(next).errors || []; } catch (e) { after = []; }
            if (after.length) {
                const prev = Array.isArray(st.issues) ? st.issues.filter((i) => (i.severity || 'error') === 'error') : (st.issues && st.issues.errors) || [];
                before = new Set(prev.map(key));
                const added = after.filter((i) => !before.has(key(i)));
                if (added.length) return { ok: false, error: added[0].message, path: added[0].path, issues: added };
            }
        }
        store.update(() => next, { label: opts.label || 'Edit', merge: opts.merge === undefined ? null : opts.merge });
        return { ok: true };
    };
}

/** Walks every string in the numeric fields of a project (keys that hold names, ids and enums are skipped). */
const NON_EXPR_KEYS = new Set(['id', 'name', 'type', 'kind', 'electrode', 'bc', 'color', 'label', 'sampling', 'fill', 'side', 'record', 'integrator',
    'quality', 'fieldInterp', 'boundary', 'method', 'mirror', 'notes', 'format', 'created', 'modified', 'engine', 'preset', 'colormap',
    'projection', 'trajectories', 'grid', 'note', 'dim', 'metric', 'goal', 'variable', 'plane', 'species', 'source', 'ramp', 'xmin', 'xmax',
    'ymin', 'ymax', 'title', 'isotope', 'region']);

/**
 * Renames a parameter and every reference to it in expressions (token-aware). Returns the number of expressions changed.
 * @param {object} project mutated in place
 * @param {string} from @param {string} to
 * @param {(src: string) => { deps: string[] }} parseExpr
 */
export function renameParamRefs(project, from, to, parseExpr) {
    let changed = 0;
    const re = new RegExp(`(^|[^A-Za-z0-9_.])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_(])`, 'g');
    const visit = (node, key) => {
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                if (typeof node[i] === 'string') { const r = fix(node[i], key); if (r !== node[i]) { node[i] = r; changed++; } } else visit(node[i], key);
            }
        } else if (node && typeof node === 'object') {
            for (const k of Object.keys(node)) {
                if (k === 'meta' || k === 'view') continue;
                const v = node[k];
                if (typeof v === 'string') { const r = fix(v, k); if (r !== v) { node[k] = r; changed++; } } else visit(v, k);
            }
        }
    };
    const fix = (s, key) => {
        if (NON_EXPR_KEYS.has(key)) return s;
        let deps;
        try { deps = parseExpr(s).deps; } catch (e) { return s; }
        if (!deps.includes(from)) return s;
        return s.replace(re, (m, pre) => pre + to);
    };
    visit(project, '');
    return changed;
}

// ---------------------------------------------------------------- parsing of one input
/**
 * Parses one scalar entry for a descriptor.
 * @param {object} desc normalised descriptor
 * @param {string} text user text
 * @param {{ evalExpr?: (src: string) => { ok: boolean, value?: number, error?: string }, dim?: string }} [ctx]
 * @returns {{ ok: true, value: number|string|null, number: number|null } | { ok: false, error: string }}
 *   value is what goes into the project (number, expression string or null); number its numeric value.
 */
export function parseScalar(desc, text, ctx = {}) {
    const dim = ctx.dim || desc.dim || 'none';
    const q = parseQuantity(text, dim);
    if (q.kind === 'empty') {
        if (desc.nullable) return { ok: true, value: null, number: null };
        return { ok: false, error: 'A value is required.' };
    }
    if (q.kind === 'error') return { ok: false, error: q.message };
    let value, number;
    if (q.kind === 'number') { value = q.value; number = q.value; }
    else {
        if (desc.noExpr) return { ok: false, error: 'Enter a number.' };
        if (!ctx.evalExpr) { value = q.expr; number = NaN; }
        else {
            const r = ctx.evalExpr(q.expr);
            if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Invalid expression.' };
            value = q.expr; number = r.value;
        }
    }
    if (number === number) {
        if (!Number.isFinite(number)) return { ok: false, error: 'Not a finite number.' };
        if ((desc.kind === 'int' || desc.integer) && Math.abs(number - Math.round(number)) > 1e-9) return { ok: false, error: 'Enter a whole number.' };
        if (typeof desc.min === 'number' && number < desc.min) return { ok: false, error: `Must be at least ${formatPretty(desc.min, dim)}.` };
        if (typeof desc.gt === 'number' && !(number > desc.gt)) return { ok: false, error: `Must be greater than ${formatPretty(desc.gt, dim)}.` };
        if (typeof desc.max === 'number' && number > desc.max) return { ok: false, error: `Must be at most ${formatPretty(desc.max, dim)}.` };
        if ((desc.kind === 'int' || desc.integer) && typeof value === 'number') value = Math.round(value);
    }
    return { ok: true, value, number };
}

/** Text shown in an input for a project value (expressions verbatim, numbers tidy). */
export function displayValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return formatNumber(v);
    return String(v);
}

/**
 * Parses a list of points ("x, y" per line; separators: comma, semicolon, spaces).
 * @returns {{ ok: true, value: Array<Array<number|string>> } | { ok: false, error: string, line?: number }}
 */
export function parsePoints(text, dims = ['length', 'length'], ctx = {}, minCount = 1) {
    const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (let li = 0; li < lines.length; li++) {
        const toks = lines[li].replace(/[[\]()]/g, ' ').split(/\s*[,;]\s*|\s+(?=[-+.\d])/).filter(Boolean);
        if (toks.length !== dims.length) return { ok: false, error: `Line ${li + 1}: expected ${dims.length} values.`, line: li + 1 };
        const row = [];
        for (let c = 0; c < dims.length; c++) {
            const r = parseScalar({ kind: 'number', dim: dims[c] }, toks[c], { ...ctx, dim: dims[c] });
            if (!r.ok) return { ok: false, error: `Line ${li + 1}: ${r.error}`, line: li + 1 };
            row.push(r.value);
        }
        out.push(row);
    }
    if (out.length < minCount) return { ok: false, error: `At least ${minCount} point${minCount === 1 ? '' : 's'} needed.` };
    return { ok: true, value: out };
}

/** Text of a point list for the textarea. */
export function pointsText(points) {
    if (!Array.isArray(points)) return '';
    return points.map((p) => (Array.isArray(p) ? p.map(displayValue).join(', ') : '')).join('\n');
}

/** Parses a comma-separated number list. */
export function parseList(text, dim = 'none', ctx = {}, minCount = 1) {
    const src = String(text);
    // commas, semicolons and whitespace before a number separate values, so units stay attached ("1 keV 2 keV")
    const toks = src.split(/[,;]/).flatMap((part) => part.trim().split(/\s+(?=[-+.\d−])/)).map((s) => s.trim()).filter(Boolean);
    if (toks.length < minCount) return { ok: false, error: minCount === 1 ? 'At least one value is needed.' : `At least ${minCount} values are needed.` };
    const out = [];
    for (const t of toks) {
        const r = parseScalar({ kind: 'number', dim }, t, { ...ctx, dim });
        if (!r.ok) return { ok: false, error: `"${t}": ${r.error}` };
        out.push(r.value);
    }
    return { ok: true, value: out };
}

/** True when a descriptor's showIf / when conditions hold for an object (and domain type). */
export function visibleFor(desc, obj, domainType = null) {
    if (Array.isArray(desc.when) && domainType && !desc.when.includes(domainType)) return false;
    if (!desc.showIf) return true;
    for (const k of Object.keys(desc.showIf)) {
        const want = desc.showIf[k], have = getPath(obj, k);
        if (Array.isArray(want) ? !want.includes(have) : have !== want) return false;
    }
    return true;
}

/** Default nudge step of a numeric descriptor at a value (one unit in the second significant digit, at least 1e-9). */
export function nudgeStep(desc, value) {
    if (typeof desc.step === 'number' && desc.step > 0) return desc.step;
    if (desc.kind === 'int') return 1;
    const a = Math.abs(value);
    if (!(a > 0)) return dimOf(desc.dim) === 'voltage' ? 1 : 0.1;
    return Math.max(1e-9, Math.pow(10, Math.floor(Math.log10(a)) - 1));
}

/**
 * Expression evaluator for form previews: parses with the platform's parser and evaluates over the
 * resolved parameter values. Returns null when no parser is available.
 * @param {{ parseExpr: Function }|null} exprModule
 * @param {() => object} vars current parameter values
 */
export function makeEvalExpr(exprModule, vars) {
    if (!exprModule || typeof exprModule.parseExpr !== 'function') return null;
    return (src) => {
        try {
            const v = exprModule.parseExpr(src).evaluate(vars() || {});
            if (!Number.isFinite(v)) return { ok: false, error: 'The expression is not a finite number.' };
            return { ok: true, value: v };
        } catch (e) {
            return { ok: false, error: e && e.message ? e.message : 'Invalid expression.' };
        }
    };
}

// ---------------------------------------------------------------- DOM builders
let fid = 0;
const nextFieldId = (p) => `${p || 'io-f'}-${++fid}`;

/**
 * One form field for a descriptor.
 * opts: { value, number (resolved), onCommit(value, { merge? }) → (result|void), evalExpr, refs: () => ({ electrode: [...], … }),
 *   idPrefix, issue (message from validation), wheel }
 * onCommit may return { ok: false, error } to refuse the value; the field then shows the error and keeps the old value.
 * @returns {{ el: HTMLElement, sync(value, number?, issue?): void, setError(msg|null): void, focus(): void, desc: object, input: HTMLElement }}
 */
export function createField(desc, opts = {}) {
    desc = normaliseDescriptor(desc);
    const id = nextFieldId(opts.idPrefix);
    const wrap = document.createElement('div');
    wrap.className = 'field io-field io-field-' + desc.kind;
    wrap.dataset.key = desc.key;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = desc.label;
    const msg = document.createElement('div');
    msg.className = 'io-field-msg';
    msg.id = id + '-msg';
    msg.setAttribute('role', 'alert');
    msg.hidden = true;
    const hintId = desc.help ? id + '-hint' : null;
    let input = null, current = opts.value;
    const inputs = [];
    const dim = desc.dimFrom && opts.dimOf ? opts.dimOf() : desc.dim;
    const describedBy = [msg.id, hintId].filter(Boolean).join(' ');
    const refs = () => (typeof opts.refs === 'function' ? opts.refs() : (opts.refs || {}));

    // a refused entry keeps its text and message until the user edits it or the project value changes
    let localErr = false;
    const setError = (m, local = true) => {
        const bad = !!m;
        localErr = bad && local;
        msg.hidden = !bad; msg.textContent = bad ? m : '';
        for (const el of (input ? [input] : inputs)) { if (bad) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); }
        wrap.classList.toggle('io-invalid', bad);
    };
    const evalCtx = { evalExpr: opts.evalExpr, dim };
    /** Sends a value; a refusal shows its error. Returns true when accepted. */
    const send = (v, o = {}) => {
        if (!opts.onCommit) { current = v; return true; }
        const r = opts.onCommit(v, o);
        if (r && r.ok === false) { setError(r.error || 'This value is not allowed.'); return false; }
        current = v;
        setError(null);
        return true;
    };

    if (desc.kind === 'number' || desc.kind === 'int') {
        const control = document.createElement('div');
        control.className = 'input-unit';
        input = document.createElement('input');
        input.type = 'text'; input.id = id; input.spellcheck = false; input.autocomplete = 'off';
        input.setAttribute('inputmode', 'decimal');
        input.setAttribute('aria-describedby', describedBy);
        control.appendChild(input);
        const u = unitOf(dim);
        if (u) { const span = document.createElement('span'); span.className = 'unit'; span.textContent = u; span.setAttribute('aria-hidden', 'true'); control.appendChild(span); label.appendChild(srUnit(u)); }
        const resolvedHint = document.createElement('div');
        resolvedHint.className = 'io-field-eval';
        resolvedHint.hidden = true;
        wrap.__evalHint = resolvedHint;
        const commit = () => {
            const r = parseScalar(desc, input.value, evalCtx);
            if (!r.ok) { setError(r.error); return; }
            if (sameValue(r.value, current)) { setError(null); input.value = displayValue(current); return; }
            if (send(r.value, {}) && typeof r.value === 'number') input.value = displayValue(r.value);
        };
        input.addEventListener('change', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { commit(); e.preventDefault(); }
            else if (e.key === 'Escape') { if (input.value !== displayValue(current)) { input.value = displayValue(current); setError(null); e.stopPropagation(); } }
            else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && typeof current === 'number') {
                e.preventDefault();
                const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
                const step = nudgeStep(desc, current) * mult;
                const v = tidyNum(current + (e.key === 'ArrowUp' ? step : -step));
                const r = parseScalar(desc, String(v), evalCtx);
                if (!r.ok) { setError(r.error); return; }
                if (send(r.value, { merge: 'nudge:' + desc.key })) input.value = displayValue(r.value);
            }
        });
        input.addEventListener('input', () => {
            const r = parseScalar(desc, input.value, evalCtx);
            if (r.ok) setError(null);
        });
        if (opts.wheel) {
            input.addEventListener('wheel', (e) => {
                if (document.activeElement !== input || typeof current !== 'number') return;
                e.preventDefault();
                const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
                const step = nudgeStep(desc, current) * mult;
                const v = tidyNum(current + (e.deltaY < 0 ? step : -step));
                const r = parseScalar(desc, String(v), evalCtx);
                if (!r.ok) return;
                if (send(r.value, { merge: 'wheel:' + desc.key })) input.value = displayValue(r.value);
            }, { passive: false });
        }
        wrap.append(label, control, resolvedHint, msg);
    } else if (desc.kind === 'select' || desc.kind === 'ref') {
        input = document.createElement('select');
        input.id = id; input.className = 'input io-select';
        input.setAttribute('aria-describedby', describedBy);
        const fill = () => {
            const want = input.value;
            while (input.firstChild) input.removeChild(input.firstChild);
            const options = desc.kind === 'ref'
                ? [...(desc.nullable ? [{ value: '', label: desc.nullLabel || 'None' }] : []), ...((refs()[desc.ref]) || [])]
                : desc.options || [];
            for (const o of options) { const op = document.createElement('option'); op.value = String(o.value); op.textContent = o.label; input.appendChild(op); }
            input.value = want;
        };
        fill();
        wrap.__refill = fill;
        input.addEventListener('change', () => {
            let v = input.value;
            if (desc.kind === 'ref' && v === '') v = null;
            const opt = (desc.options || []).find((o) => String(o.value) === input.value);
            if (opt && typeof opt.value !== 'string') v = opt.value;
            if (!send(v, {})) input.value = current === null || current === undefined ? '' : String(current);
        });
        wrap.append(label, input, msg);
    } else if (desc.kind === 'refpair') {
        const control = document.createElement('div');
        control.className = 'io-vec io-vec2';
        control.setAttribute('role', 'group');
        label.id = id + '-lbl';
        label.removeAttribute('for');
        control.setAttribute('aria-labelledby', label.id);
        const fill = () => {
            for (const sel of inputs) {
                const want = sel.value;
                while (sel.firstChild) sel.removeChild(sel.firstChild);
                const none = document.createElement('option'); none.value = ''; none.textContent = '—'; sel.appendChild(none);
                for (const o of (refs()[desc.ref] || [])) { const op = document.createElement('option'); op.value = String(o.value); op.textContent = o.label; sel.appendChild(op); }
                sel.value = want;
            }
        };
        ['from', 'to'].forEach((name, c) => {
            const sel = document.createElement('select');
            sel.className = 'input io-select';
            sel.setAttribute('aria-label', `${desc.label}: ${name}`);
            if (c === 0) sel.id = id;
            sel.addEventListener('change', () => {
                const a = inputs[0].value, b = inputs[1].value;
                const v = a && b ? [a, b] : null;
                if (!send(v, {})) { const cur = Array.isArray(current) ? current : ['', '']; inputs[0].value = cur[0] || ''; inputs[1].value = cur[1] || ''; }
            });
            inputs.push(sel);
            control.appendChild(sel);
        });
        fill();
        wrap.__refill = fill;
        wrap.append(label, control, msg);
    } else if (desc.kind === 'bool') {
        wrap.classList.add('io-field-check');
        input = document.createElement('input');
        input.type = 'checkbox'; input.id = id;
        input.setAttribute('aria-describedby', describedBy);
        input.addEventListener('change', () => { if (!send(input.checked, {})) input.checked = !!current; });
        label.prepend(input);
        wrap.append(label, msg);
    } else if (desc.kind === 'color') {
        const control = document.createElement('div');
        control.className = 'io-color-row';
        input = document.createElement('input');
        input.type = 'color'; input.id = id; input.className = 'io-color';
        input.addEventListener('change', () => { if (!send(input.value, { merge: 'color:' + desc.key })) input.value = colorValue(current); });
        control.appendChild(input);
        if (desc.auto) {
            const autoId = id + '-auto';
            const auto = document.createElement('input');
            auto.type = 'checkbox'; auto.id = autoId;
            const al = document.createElement('label');
            al.htmlFor = autoId; al.className = 'io-check';
            al.append(auto, document.createTextNode('Automatic'));
            auto.addEventListener('change', () => {
                const v = auto.checked ? 'auto' : input.value;
                if (!send(v, {})) auto.checked = current === 'auto';
                input.disabled = auto.checked;
            });
            wrap.__auto = auto;
            control.appendChild(al);
        }
        wrap.append(label, control, msg);
    } else if (desc.kind === 'textarea' || desc.kind === 'points') {
        input = document.createElement('textarea');
        input.id = id; input.className = 'input io-textarea'; input.rows = desc.kind === 'points' ? 4 : 5; input.spellcheck = desc.kind === 'textarea';
        input.setAttribute('aria-describedby', describedBy);
        input.addEventListener('change', () => {
            if (desc.kind === 'textarea') { send(input.value, {}); return; }
            const r = parsePoints(input.value, desc.dims || ['length', 'length'], evalCtx, desc.minItems || 1);
            if (!r.ok) { setError(r.error); return; }
            send(r.value, {});
        });
        wrap.append(label, input, msg);
    } else if (desc.kind === 'list') {
        input = document.createElement('input');
        input.type = 'text'; input.id = id; input.className = 'input'; input.spellcheck = false;
        input.setAttribute('aria-describedby', describedBy);
        input.addEventListener('change', () => {
            const r = parseList(input.value, desc.dim, evalCtx, desc.minItems || 1);
            if (!r.ok) { setError(r.error); return; }
            send(r.value, {});
        });
        const u = unitOf(desc.dim);
        if (u) label.appendChild(srUnit(u));
        wrap.append(label, input, msg);
    } else if (desc.kind === 'vec2' || desc.kind === 'vec3' || desc.kind === 'vec4' || desc.kind === 'range2') {
        const n = desc.kind === 'vec2' || desc.kind === 'range2' ? 2 : desc.kind === 'vec3' ? 3 : 4;
        const names = desc.kind === 'range2' ? ['from', 'to'] : n === 4 ? ['x₀', 'x₁', 'y₀', 'y₁'] : ['x', 'y', 'z'];
        const control = document.createElement('div');
        control.className = 'io-vec io-vec' + n;
        control.setAttribute('role', 'group');
        control.setAttribute('aria-labelledby', id + '-lbl');
        label.id = id + '-lbl';
        label.removeAttribute('for');
        const u = unitOf(dim);
        if (u) label.appendChild(srUnit(u));
        for (let c = 0; c < n; c++) {
            const inp = document.createElement('input');
            inp.type = 'text'; inp.className = 'input io-vec-in'; inp.spellcheck = false; inp.autocomplete = 'off';
            inp.setAttribute('inputmode', 'decimal');
            inp.setAttribute('aria-label', `${desc.label} ${names[c]}`);
            inp.setAttribute('aria-describedby', describedBy);
            if (c === 0) inp.id = id;
            inp.addEventListener('change', () => {
                const r = parseScalar({ ...desc, kind: desc.integer ? 'int' : 'number', min: desc.kind === 'range2' ? undefined : desc.min, max: desc.kind === 'range2' ? undefined : desc.max }, inp.value, evalCtx);
                if (!r.ok) { setError(`${names[c]}: ${r.error}`); inp.setAttribute('aria-invalid', 'true'); return; }
                const next = Array.isArray(current) ? current.slice() : new Array(n).fill(0);
                while (next.length < n) next.push(0);
                next[c] = r.value;
                if (desc.kind === 'range2') {
                    const a = typeof next[0] === 'number' ? next[0] : NaN, b = typeof next[1] === 'number' ? next[1] : NaN;
                    if (a === a && b === b && !(b > a)) { setError('The end must be greater than the start.'); inp.setAttribute('aria-invalid', 'true'); return; }
                }
                if (!send(next, {})) { inp.setAttribute('aria-invalid', 'true'); return; }
                inputs.forEach((x) => x.removeAttribute('aria-invalid'));
            });
            inputs.push(inp);
            control.appendChild(inp);
        }
        wrap.append(label, control, msg);
    } else {
        input = document.createElement('input');
        input.type = 'text'; input.id = id; input.className = 'input';
        input.setAttribute('aria-describedby', describedBy);
        if (desc.maxLength) input.maxLength = desc.maxLength;
        input.addEventListener('change', () => {
            const v = input.value.trim();
            if (desc.pattern && !new RegExp(desc.pattern).test(v)) { setError('Use letters, digits and underscores, starting with a letter.'); return; }
            if (!v && !desc.optional) { setError('A value is required.'); return; }
            if (!send(v, {})) return;
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.dispatchEvent(new Event('change')); e.preventDefault(); } });
        wrap.append(label, input, msg);
    }
    if (desc.help) {
        const hint = document.createElement('div');
        hint.className = 'hint'; hint.id = hintId; hint.textContent = desc.help;
        wrap.appendChild(hint);
    }

    function sync(value, number, issue) {
        if (value === undefined && (desc.kind === 'bool' || desc.kind === 'select') && Object.prototype.hasOwnProperty.call(IMPLIED_DEFAULTS, desc.key)) value = IMPLIED_DEFAULTS[desc.key];
        const keepEntry = localErr && sameValue(value, current);
        current = value;
        const focused = (el) => el && document.activeElement === el;
        if (keepEntry) return;
        if (desc.kind === 'number' || desc.kind === 'int') {
            if (!focused(input)) input.value = displayValue(value);
            const hint = wrap.__evalHint;
            if (hint) {
                const isExpr = typeof value === 'string';
                hint.hidden = !isExpr;
                if (isExpr) hint.textContent = typeof number === 'number' && Number.isFinite(number) ? '= ' + formatPretty(number, dim, 6) : '';
            }
        } else if (desc.kind === 'select' || desc.kind === 'ref') {
            if (wrap.__refill && desc.kind === 'ref') wrap.__refill();
            if (!focused(input)) input.value = value === null || value === undefined ? '' : String(value);
        } else if (desc.kind === 'refpair') {
            if (wrap.__refill) wrap.__refill();
            const arr = Array.isArray(value) ? value : ['', ''];
            inputs.forEach((sel, c) => { if (!focused(sel)) sel.value = arr[c] || ''; });
        } else if (desc.kind === 'bool') input.checked = !!value;
        else if (desc.kind === 'color') {
            input.value = colorValue(value);
            if (wrap.__auto) { wrap.__auto.checked = value === 'auto'; input.disabled = value === 'auto'; }
        } else if (desc.kind === 'points') { if (!focused(input)) input.value = pointsText(value); }
        else if (desc.kind === 'textarea') { if (!focused(input)) input.value = value == null ? '' : String(value); }
        else if (desc.kind === 'list') { if (!focused(input)) input.value = Array.isArray(value) ? value.map(displayValue).join(', ') : ''; }
        else if (inputs.length) {
            const arr = Array.isArray(value) ? value : [];
            inputs.forEach((inp, c) => { if (!focused(inp)) inp.value = displayValue(arr[c]); });
        } else if (input && !focused(input)) input.value = value == null ? '' : String(value);
        if (issue !== undefined) setError(issue || null, false);
    }
    sync(opts.value, opts.number, opts.issue);
    return { el: wrap, sync, setError, focus: () => (input || inputs[0]) && (input || inputs[0]).focus(), desc, get input() { return input || inputs[0]; } };
}

function colorValue(v) { return /^#[0-9a-f]{6}$/i.test(v || '') ? v : '#888888'; }

/** Values that a missing key stands for (the schema's defaults for optional switches and choices). */
export const IMPLIED_DEFAULTS = Object.freeze({ enabled: true, locked: false, relativistic: true, terminate: false, store: true, kind: 'solid', sampling: 'random', side: 'both', record: 'first', mirror: 'none', fill: 'solid' });

function srUnit(u) {
    const s = document.createElement('span');
    s.className = 'sym';
    s.textContent = u;
    return s;
}

function tidyNum(v) { const r = parseFloat(v.toPrecision(12)); return Object.is(r, -0) ? 0 : r; }

function sameValue(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
    return false;
}

/**
 * A form for one object. get(path) and getResolved(path) read the current values; commit(path, value, opts)
 * writes through the store and may return { ok: false, error } to refuse; issueAt(path) returns a validation
 * message or null; refs() gives the reference options; domainType() the current domain type (for `when`).
 * @returns {{ el: HTMLElement, sync(): void, fields: Map<string, object> }}
 */
export function buildForm(descs, { get, getResolved = () => undefined, commit, issueAt: issueFor = () => null, evalExpr, refs = () => ({}), domainType = () => null, idPrefix = 'io-f', dimOf: dimOfFn = null, className = 'io-form', hide = null } = {}) {
    const el = document.createElement('div');
    el.className = className;
    const fields = new Map();
    for (const d0 of descs) {
        const d = normaliseDescriptor(d0);
        const f = createField(d, {
            value: get(d.key), number: getResolved(d.key), evalExpr, refs, idPrefix,
            dimOf: d.dimFrom ? () => (dimOfFn ? dimOfFn(d) : get(d.dimFrom)) : null,
            onCommit: (v, o) => commit(d.key, v, o),
            wheel: dimOf(d.dim) === 'voltage',
        });
        fields.set(d.key, f);
        el.appendChild(f.el);
    }
    const sync = () => {
        const obj = get('') || {};
        const dt = domainType();
        for (const [key, f] of fields) {
            f.el.hidden = !visibleFor(f.desc, obj, dt) || !!(hide && hide(key, obj));
            f.sync(get(key), getResolved(key), issueFor(key));
        }
    };
    sync();
    return { el, sync, fields };
}

// ---------------------------------------------------------------- store-bound forms
/**
 * Evaluator over the current parameter values of the store (for "= value" hints and validation of expressions).
 * @param {object} ctx panel context ({ store, engine: { expr } })
 */
export function storeEvalExpr(ctx) {
    return makeEvalExpr(ctx.engine && ctx.engine.expr, () => {
        const st = ctx.store.get();
        const r = st.resolved || st.lastResolved;
        return (r && r.paramValues) || {};
    });
}

/**
 * A META-driven form bound to one object of the project. Values are read from the project, "= value" hints from the
 * resolved project, issues from the store, and edits are written through the validating committer.
 * spec: { kind, sub?, descs?, locate: (project) => { obj, path } | null, resolved?: (resolved) => object | null,
 *   label?, merge?: (key) => string|null, hide?: (key, obj) => boolean, intercept?: (key, value, draft, loc) => boolean,
 *   idPrefix?, className? }
 * `intercept` may apply an edit itself (return true), e.g. a type change that replaces the object.
 * @param {object} ctx panel context ({ store, engine: { schema, expr }, commit? })
 * @returns {{ el: HTMLElement, sync(): void, fields: Map<string, object>, exists(): boolean }}
 */
export function bindForm(ctx, spec) {
    const { store } = ctx;
    const schema = ctx.engine && ctx.engine.schema;
    const commit = ctx.commit || createCommitter({ store, schema });
    const descs = (spec.descs || metaFor(schema && schema.META, spec.kind, spec.sub || null)).map(normaliseDescriptor);
    const loc = () => spec.locate(store.get().project);
    const res = () => {
        if (!spec.resolved) return null;
        const st = store.get();
        const r = st.resolved || st.lastResolved;
        return r ? spec.resolved(r) : null;
    };
    const get = (key) => {
        const L = loc();
        if (!L) return undefined;
        return key === '' ? L.obj : getPath(L.obj, key);
    };
    const form = buildForm(descs, {
        get,
        getResolved: (key) => { const o = res(); return o ? getPath(o, key) : undefined; },
        commit: (key, value, o = {}) => commit((draft) => {
            const L = spec.locate(draft);
            if (!L) throw new Error('This object no longer exists.');
            if (spec.intercept && spec.intercept(key, value, draft, L)) return;
            setPath(L.obj, key, value);
        }, { label: spec.label || 'Edit', merge: o.merge || (spec.merge ? spec.merge(key) : null) }),
        issueAt: (key) => {
            const L = loc();
            return L ? issueAt(store.get().issues, joinPath(L.path, key)) : null;
        },
        evalExpr: storeEvalExpr(ctx),
        refs: () => refOptions(store.get().project),
        domainType: () => { const p = store.get().project; return p && p.domain ? p.domain.type : null; },
        dimOf: (d) => (d.dimFrom ? (get(d.dimFrom) || 'none') : d.dim),
        idPrefix: spec.idPrefix || 'io-f',
        className: spec.className || 'io-form',
        hide: spec.hide || null,
    });
    return { ...form, exists: () => !!loc() };
}
