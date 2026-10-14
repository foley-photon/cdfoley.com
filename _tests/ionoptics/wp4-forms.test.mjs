// WP4 forms: descriptors from META (and the fallback table), parsing of numbers, units and expressions, the
// validating committer (an invalid edit never reaches the project), locators, references and parameter renames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const F = await import('../../beta/ion-optics/js/ui/forms.js');

const SUPPORTED = new Set(['number', 'int', 'select', 'ref', 'refpair', 'bool', 'color', 'textarea', 'points', 'list', 'vec2', 'vec3', 'vec4', 'range2', 'text']);

test('descriptor normalisation maps the platform kinds to builder kinds', () => {
    const n = F.normaliseDescriptor;
    assert.equal(n({ key: 'p', kind: 'point', size: 3, dim: 'length' }).kind, 'vec3');
    assert.equal(n({ key: 'c', kind: 'point', size: 2 }).kind, 'vec2');
    assert.equal(n({ key: 'x', label: 'x extent [start, end]', kind: 'point', size: 2 }).kind, 'range2');
    assert.equal(n({ key: 'clip', kind: 'point', size: 4 }).kind, 'vec4');
    const pts = n({ key: 'points', kind: 'points', size: 2, dim: 'length', minItems: 3 });
    assert.equal(pts.kind, 'points'); assert.deepEqual(pts.dims, ['length', 'length']); assert.equal(pts.minItems, 3);
    assert.equal(n({ key: 'values', kind: 'points', size: 1, dim: 'energy' }).kind, 'list');
    const ref = n({ key: 'electrode', kind: 'select', options: null, ref: 'electrode', nullable: true, nullLabel: 'Void' });
    assert.equal(ref.kind, 'ref'); assert.equal(ref.nullLabel, 'Void');
    assert.equal(n({ key: 'ramp', kind: 'select', ref: 'electrode', multiple: 2 }).kind, 'refpair');
    assert.equal(n({ key: 'color', kind: 'text', format: 'color' }).kind, 'color');
    assert.equal(n({ key: 'color', kind: 'text', format: 'color', help: '"auto" or #rrggbb.' }).auto, true);
    assert.equal(n({ key: 'notes', kind: 'text', multiline: true }).kind, 'textarea');
    assert.deepEqual(n({ key: 'transmission', kind: 'number', onlyKind: 'grid' }).showIf, { kind: 'grid' });
    assert.equal(n({ key: 'a', kind: 'integer' }).kind, 'int');
    assert.deepEqual(n({ key: 'k', options: ['a', 'b'] }).options, [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }]);
    // the fallback table: every descriptor normalises to a supported kind
    for (const [kind, list] of Object.entries(F.FALLBACK_META)) for (const d of list) assert.ok(SUPPORTED.has(n(d).kind), `fallback ${kind}.${d.key}: ${n(d).kind}`);
});

test('the platform schema META (when present) normalises completely', async () => {
    const path = fileURLToPath(new URL('../../beta/ion-optics/js/engine/schema.js', import.meta.url));
    if (!existsSync(path)) return;
    const schema = await import('../../beta/ion-optics/js/engine/schema.js');
    if (!schema.META) return;
    let count = 0;
    for (const [kind, list] of Object.entries(schema.META)) {
        if (!Array.isArray(list)) continue;
        for (const d of list) { const k = F.normaliseDescriptor(d).kind; assert.ok(SUPPORTED.has(k), `META ${kind}.${d.key}: ${k}`); count++; }
    }
    assert.ok(count > 50);
    // lookups used by the panels resolve
    for (const [k, s] of [['shape', 'box'], ['shape', 'quadric'], ['position', 'line'], ['direction', 'fan'], ['energy', 'list'], ['time', 'rfPhase'], ['term', 'cos'], ['magnet', 'region'], ['region', 'annulus'], ['ideal', 'quadrupole2d']]) {
        assert.ok(F.metaFor(schema.META, k, s).length > 0, `${k}.${s}`);
    }
    for (const k of ['electrode', 'source', 'species', 'plane', 'tracer', 'solver', 'domain', 'param', 'transform', 'trajectories', 'timeMarkers', 'mirror', 'beyond']) assert.ok(F.metaFor(schema.META, k).length > 0, k);
});

test('metaFor prefers the schema table and falls back', () => {
    const META = { 'shape.box': [{ key: 'x0', label: 'Left', kind: 'number', dim: 'length' }], position: { line: [{ key: 'p0', kind: 'point', size: 3 }] } };
    assert.equal(F.metaFor(META, 'shape', 'box')[0].label, 'Left');
    assert.equal(F.metaFor(META, 'position', 'line')[0].kind, 'vec3');
    assert.ok(F.metaFor(META, 'shape', 'tube').some((d) => d.key === 'rIn'), 'fallback for missing entries');
    assert.deepEqual(F.metaFor(null, 'nothing-here'), []);
});

test('parseScalar: numbers, units, expressions, limits', () => {
    const ev = F.makeEvalExpr({ parseExpr: (s) => ({ evaluate: (v) => { if (s === 'D/2') return v.D / 2; if (s === 'bad') throw new Error('Unknown parameter "bad"'); return NaN; } }) }, () => ({ D: 20 }));
    const L = { kind: 'number', dim: 'length' };
    assert.deepEqual(F.parseScalar(L, '2 cm'), { ok: true, value: 20, number: 20 });
    assert.deepEqual(F.parseScalar(L, 'D/2', { evalExpr: ev }), { ok: true, value: 'D/2', number: 10 });
    assert.equal(F.parseScalar(L, 'bad', { evalExpr: ev }).ok, false);
    assert.equal(F.parseScalar(L, 'D/2').value, 'D/2', 'without an evaluator the expression is kept');
    assert.equal(F.parseScalar({ ...L, min: 0 }, '-1').ok, false);
    assert.equal(F.parseScalar({ ...L, gt: 0 }, '0').ok, false);
    assert.equal(F.parseScalar({ ...L, gt: 0 }, '1e-9').ok, true);
    assert.equal(F.parseScalar({ ...L, max: 1 }, '2').ok, false);
    assert.equal(F.parseScalar({ kind: 'int' }, '2.5').ok, false);
    assert.equal(F.parseScalar({ kind: 'int' }, '3').value, 3);
    assert.equal(F.parseScalar(L, '').ok, false);
    assert.deepEqual(F.parseScalar({ ...L, nullable: true }, ''), { ok: true, value: null, number: null });
    assert.equal(F.parseScalar({ ...L, noExpr: true }, 'D/2').ok, false);
    assert.equal(F.parseScalar({ kind: 'number', dim: 'voltage' }, '2 kV').value, 2000);
    assert.equal(F.parseScalar(L, '3 kV').ok, false);
});

test('point lists and number lists round-trip', () => {
    const r = F.parsePoints('1, 2\n-3.5 4\n[5; 6]', ['length', 'length']);
    assert.ok(r.ok);
    assert.deepEqual(r.value, [[1, 2], [-3.5, 4], [5, 6]]);
    assert.deepEqual(F.parsePoints(F.pointsText(r.value)).value, r.value);
    assert.equal(F.parsePoints('1, 2\n3', ['length', 'length']).ok, false);
    assert.equal(F.parsePoints('1, 2', ['length', 'length'], {}, 3).ok, false);
    assert.deepEqual(F.parseList('99, 100 101', 'energy').value, [99, 100, 101]);
    assert.deepEqual(F.parseList('1 keV, 2keV', 'energy').value, [1000, 2000]);
    assert.equal(F.parseList('', 'energy').ok, false);
    assert.equal(F.displayValue(0.1 + 0.2), '0.3');
    assert.equal(F.displayValue('D/2'), 'D/2');
    assert.equal(F.displayValue(null), '');
});

test('visibility, paths, nudges and ids', () => {
    assert.equal(F.visibleFor({ showIf: { kind: 'grid' } }, { kind: 'solid' }), false);
    assert.equal(F.visibleFor({ showIf: { kind: ['x', 'y'] } }, { kind: 'y' }), true);
    assert.equal(F.visibleFor({ when: ['planar2d'] }, {}, 'cyl2d'), false);
    assert.equal(F.visibleFor({ when: ['planar2d'] }, {}, 'planar2d'), true);
    assert.deepEqual(F.splitPath('shapes[3].points[2][0]'), ['shapes', 3, 'points', 2, 0]);
    const o = {};
    F.setPath(o, 'a.b[1].c', 5);
    assert.equal(F.getPath(o, 'a.b[1].c'), 5);
    assert.ok(Array.isArray(o.a.b));
    F.setPath(o, '__proto__.polluted', 1);
    assert.equal(({}).polluted, undefined);
    assert.equal(F.joinPath('shapes[2]', 'transform.translate[0]'), 'shapes[2].transform.translate[0]');
    assert.equal(F.nudgeStep({ kind: 'number', dim: 'voltage' }, 850), 10);
    assert.equal(F.nudgeStep({ kind: 'number', dim: 'length' }, 0.25), 0.01);
    assert.equal(F.nudgeStep({ kind: 'int' }, 7), 1);
    assert.equal(F.nextId([{ id: 's1' }, { id: 's3' }], 's'), 's2');
    assert.equal(F.nextParamName([{ name: 'p1' }], 'p'), 'p2');
});

const PROJECT = () => ({
    params: [{ name: 'D', value: 20 }, { name: 'Vc', value: 850 }],
    electrodes: [{ id: 'gnd', name: 'Ground' }, { id: 'centre', name: 'Centre tube', v: 'Vc' }],
    shapes: [{ id: 's1', type: 'tube', electrode: 'centre', x0: '-0.2*D', x1: '0.2*D', rIn: 'D/2', rOut: 'D/2+1' }],
    sources: [{ id: 'b1' }], recording: { planes: [{ id: 'p1', name: 'Image' }] }, magnets: [], idealFields: [],
});

test('locators, reference options and issue lookup', () => {
    const p = PROJECT();
    assert.deepEqual(F.locate(p, 'shape', 's1').path, 'shapes[0]');
    assert.equal(F.locate(p, 'param', 'Vc').path, 'params[1]');
    assert.equal(F.locate(p, 'plane', 'p1').path, 'recording.planes[0]');
    assert.equal(F.locate(p, 'shape', 'nope'), null);
    const refs = F.refOptions(p);
    assert.deepEqual(refs.electrode.map((x) => x.value), ['gnd', 'centre']);
    assert.equal(refs.electrode[1].label, 'Centre tube (centre)');
    assert.deepEqual(refs.param.map((x) => x.value), ['D', 'Vc']);
    const issues = [{ path: 'shapes[0].rIn', message: 'too big', severity: 'error' }, { path: 'shapes[0]', message: 'w', severity: 'warning' }];
    assert.equal(F.issueAt(issues, 'shapes[0].rIn'), 'too big');
    assert.equal(F.issueAt(issues, 'shapes[0]'), null, 'warnings are not errors');
    assert.equal(F.issueAt(issues, 'shapes[0]', { childrenToo: true }), 'too big');
});

test('the committer refuses edits that add validation errors and keeps the last valid project', () => {
    let project = PROJECT();
    const updates = [];
    const store = {
        get: () => ({ project, issues: [] }),
        update: (mut, o) => { const d = structuredClone(project); const r = mut(d); project = r && typeof r === 'object' ? r : d; updates.push(o); },
    };
    const schema = { validate: (p) => ({ errors: (p.shapes || []).filter((s) => typeof s.rIn === 'number' && typeof s.rOut === 'number' && s.rIn >= s.rOut).map((s, i) => ({ path: `shapes[${i}].rIn`, code: 'E_RANGE', message: 'rIn must be below rOut' })) }) };
    const commit = F.createCommitter({ store, schema });
    const ok = commit((d) => { d.shapes[0].rOut = 12; }, { label: 'Edit', merge: 'shape:s1:rOut' });
    assert.equal(ok.ok, true);
    assert.equal(project.shapes[0].rOut, 12);
    assert.deepEqual(updates[0], { label: 'Edit', merge: 'shape:s1:rOut' });
    const bad = commit((d) => { d.shapes[0].rIn = 15; });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'rIn must be below rOut');
    assert.equal(bad.path, 'shapes[0].rIn');
    assert.equal(project.shapes[0].rIn, 'D/2', 'the last valid value stays');
    assert.equal(updates.length, 1);
    // errors that were already there do not block other edits
    project.shapes[0].rIn = 20;
    const store2 = { ...store, get: () => ({ project, issues: [{ path: 'shapes[0].rIn', code: 'E_RANGE', message: 'x', severity: 'error' }] }) };
    const c2 = F.createCommitter({ store: store2, schema });
    assert.equal(c2((d) => { d.params[0].value = 30; }).ok, true);
    // a throwing mutator is refused with its message
    assert.deepEqual(c2(() => { throw new Error('gone'); }), { ok: false, error: 'gone' });
});

test('renaming a parameter rewrites only the expressions that use it', () => {
    const p = PROJECT();
    p.electrodes.push({ id: 'Vc', name: 'Vc', v: '2*Vc' });
    const deps = (s) => ({ deps: (s.match(/[A-Za-z_]\w*(?!\s*\()/g) || []).filter((n) => !['sqrt', 'pi'].includes(n)) });
    const n = F.renameParamRefs(p, 'Vc', 'Vcentre', deps);
    assert.equal(n, 2);
    assert.equal(p.electrodes[1].v, 'Vcentre');
    assert.equal(p.electrodes[2].v, '2*Vcentre');
    assert.equal(p.electrodes[2].id, 'Vc', 'ids are not expressions');
    assert.equal(p.electrodes[2].name, 'Vc');
    const q = PROJECT();
    F.renameParamRefs(q, 'D', 'Dia', deps);
    assert.deepEqual([q.shapes[0].x0, q.shapes[0].rIn, q.shapes[0].rOut], ['-0.2*Dia', 'Dia/2', 'Dia/2+1']);
});
