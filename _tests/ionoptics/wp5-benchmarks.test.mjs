// WP5 validation suite in Node (spec 5.4, 7.6 acceptance 4 and 6; round-2 plan §2.3): the registry is complete
// (55 gates, 7 info, 2 planned; every case with a reference URL, tolerances for both levels, a timeout and a setup
// that validates); every gate runs as its own test at the level from IONOPTICS_LEVEL (quick by default); info cases
// print; planned cases are skipped; a final table prints ID, value, reference, deviation, tolerance and status.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { BENCHMARKS, runBenchmark, caseProject } from '../../beta/ion-optics/js/engine/bench/cases.js';
import { TARGETS } from '../../beta/ion-optics/js/engine/bench/targets.js';
import { validate } from '../../beta/ion-optics/js/engine/schema.js';

const LEVEL = process.env.IONOPTICS_LEVEL === 'full' ? 'full' : 'quick';
const results = [];

test('registry: 55 gates (K 11, S 13, T 21, L 6, D 2, P 2), 7 info, 2 planned; references, levels, timeouts, valid setups', () => {
    const ids = BENCHMARKS.map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length, 'unique ids');
    assert.equal(BENCHMARKS.length, 64);
    const gates = BENCHMARKS.filter((b) => b.kind === 'gate');
    assert.equal(gates.length, 55);
    for (const [g, n] of [['K', 11], ['S', 13], ['T', 21], ['L', 6], ['D', 2], ['I', 0], ['P', 2]]) assert.equal(gates.filter((b) => b.group === g).length, n, `group ${g}`);
    assert.deepEqual(BENCHMARKS.filter((b) => b.kind === 'info').map((b) => b.id), ['L5', 'L6', 'L7', 'I1', 'I2', 'I3', 'I4']);
    assert.deepEqual(BENCHMARKS.filter((b) => b.kind === 'planned').map((b) => b.id), ['P1', 'P3']);
    // the round-2 gates of the improvement plan (§2.3), including the four promoted on the field-analysis helpers, are all gates
    for (const id of ['K3d', 'K6b', 'T8b', 'T16', 'T17', 'T18', 'T19', 'T20', 'S11', 'S12', 'S13', 'L8', 'L9', 'D1', 'D2', 'P2', 'P4']) assert.equal(BENCHMARKS.find((b) => b.id === id).kind, 'gate', `${id} is a gate`);
    // every group of the registry is a known group in a fixed order
    assert.deepEqual([...new Set(BENCHMARKS.map((b) => b.group))], ['K', 'S', 'T', 'L', 'D', 'I', 'P']);
    for (const b of BENCHMARKS) {
        assert.ok(b.title && b.description, `${b.id} title and description`);
        // closed-form references carry no link (a link to an unrelated page would not support the result)
        assert.ok(b.reference && b.reference.text && (/^https?:\/\//.test(b.reference.url) || (b.reference.url === null && /closed form/.test(b.reference.text))), `${b.id} reference with URL`);
        assert.ok(!(b.reference.url === 'https://physics.nist.gov/cuu/Constants/' && !/CODATA/.test(b.reference.text)), `${b.id}: the CODATA link only for constants`);
        assert.ok(TARGETS[b.id], `${b.id} targets`);
        for (const lv of ['quick', 'full']) assert.ok(b.levels[lv] && b.levels[lv].setup && b.levels[lv].tolerance, `${b.id} ${lv} level`);
        assert.ok(b.timeoutMs >= 10000, `${b.id} timeout`);
        if (b.kind === 'planned') { assert.equal(caseProject(b.id, 'quick'), null); continue; }
        for (const lv of ['quick', 'full']) {
            const p = caseProject(b.id, lv);
            assert.ok(p && p.format === 'ion-optics-project', `${b.id} ${lv} project`);
            const v = validate(p);
            assert.deepEqual(v.errors, [], `${b.id} ${lv} setup validates`);
            assert.ok(JSON.stringify(p).length < 1e6, 'setups stay small');
        }
    }
});

for (const b of BENCHMARKS) {
    if (b.kind === 'planned') {
        test(`${b.id} ${b.title} (planned)`, { skip: 'planned for a later phase' }, () => {});
        continue;
    }
    test(`${b.id} ${b.title} [${LEVEL}${b.kind === 'info' ? ', informational' : ''}]`, { timeout: b.timeoutMs }, async () => {
        const r = await runBenchmark(b.id, LEVEL);
        results.push(r);
        assert.notEqual(r.status, 'error', `${b.id} error: ${JSON.stringify(r.details)}`);
        assert.ok(r.checks.length > 0, 'checks');
        for (const c of r.checks) assert.ok('label' in c && 'target' in c && 'value' in c && 'tol' in c && 'tolKind' in c && 'deviation' in c && 'pass' in c);
        if (b.kind === 'info') {
            assert.equal(r.status, 'info');
            return;
        }
        const bad = r.checks.filter((c) => !c.pass).map((c) => `${c.label}: ${c.value} vs ${c.target} (tol ${JSON.stringify(c.tol)} ${c.tolKind})`);
        assert.equal(r.status, 'pass', bad.join('; '));
    });
}

test('runBenchmark of a planned case returns an info result without running anything', async () => {
    const r = await runBenchmark('P1', 'quick');
    assert.equal(r.status, 'info');
    assert.ok(r.details.planned);
    const u = await runBenchmark('NOPE', 'quick');
    assert.equal(u.status, 'error');
});

const fmt = (v) => (typeof v === 'number' ? (Number.isFinite(v) && v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e6) ? v.toExponential(3) : String(+v.toPrecision(8))) : String(v));
after(() => {
    if (!results.length) return;
    const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
    const lines = [`Validation suite (${LEVEL}): ID, worst check, value, reference, deviation, tolerance, status`];
    for (const r of results) {
        let w = null, ws = -1;
        for (const c of r.checks) {
            const s = !c.pass ? Infinity : (c.tolKind === 'bracket' || !(c.tol > 0) ? 0 : Math.abs(c.deviation) / c.tol);
            if (s > ws) { ws = s; w = c; }
        }
        lines.push(`${pad(r.id, 5)}${pad(w ? w.label : '', 48)} ${pad(w ? fmt(w.value) : '', 14)} ${pad(w ? fmt(w.target) : '', 14)} ${pad(w ? fmt(w.deviation) : '', 12)} ${pad(w ? (Array.isArray(w.tol) ? `[${w.tol}]` : `${w.tolKind} ${fmt(w.tol)}`) : '', 18)} ${r.status} ${(r.ms / 1000).toFixed(2)} s`);
    }
    process.stdout.write(lines.join('\n') + '\n');
});
