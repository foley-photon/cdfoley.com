// WP3 acceptance (4): lossless share round trips, preset links ≤ 4 kB, corrupt or oversized links rejected or clamped;
// RFC 4180 CSV with the §4.7 columns; project files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import * as io from '../../beta/ion-optics/js/engine/io.js';
import { canonicalJSON } from '../../beta/ion-optics/js/engine/hash.js';
import { migrate, resolve } from '../../beta/ion-optics/js/engine/schema.js';
import { runProject } from '../../beta/ion-optics/js/engine/pipeline.js';
import { S_STRIDE, S_ID, S_X, S_KE, C_STRIDE } from '../../beta/ion-optics/js/engine/layout.js';
import { FIXTURES, einzel, plateMirror } from './fixtures/wp3/projects.mjs';

const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
async function rejects(hash, re = null) {
    await assert.rejects(io.decodeShare(hash), (e) => {
        assert.equal(e.name, 'EngineError');
        assert.ok(['E_BAD_PROJECT', 'E_UNSUPPORTED'].includes(e.code), e.code);
        if (re) assert.match(e.message, re);
        return true;
    });
}
/** Runs fn with CompressionStream hidden (browsers without deflate-raw). */
async function withoutCompression(fn) {
    const C = globalThis.CompressionStream;
    try { delete globalThis.CompressionStream; return await fn(); } finally { globalThis.CompressionStream = C; }
}

test('toCSV: RFC 4180 quoting, CRLF, 10 significant digits', () => {
    const csv = io.toCSV(['a', 'b,c', 'd'], [[1, 'x,y', 'he said "hi"'], [0.1 + 0.2, 'line\nbreak', null], [NaN, Infinity, 123456789012], [1 / 3, -2.5e-12, 5e21]]);
    assert.equal(csv, 'a,"b,c",d\r\n1,"x,y","he said ""hi"""\r\n0.3,"line\nbreak",\r\n,Infinity,123456789012\r\n0.3333333333,-2.5e-12,5e+21\r\n');
    assert.equal(io.toCSV(['x'], []), 'x\r\n');
    assert.equal(io.toCSV(['x'], [new Float64Array([1.5])]), 'x\r\n1.5\r\n');
});

test('runToCSV: hits, crossings, trajectories and markers with the spec columns', () => {
    const p = plateMirror();
    p.recording.timeMarkers = { dt: 0.5 };
    const { resolved, result } = runProject(p);
    const hits = io.runToCSV(result, 'hits', resolved).split('\r\n');
    assert.equal(hits[0], 'id,source,species,mass_u,charge_e,t0_us,x0_mm,y0_mm,z0_mm,ke0_eV,status,where,t_us,tof_us,x_mm,y_mm,z_mm,vx_mm_us,vy_mm_us,vz_mm_us,ke_eV,dE_end_eV,dE_max_eV,work_eV,steps,path_mm');
    assert.equal(hits.length, result.n + 2, 'header, one line per particle, final CRLF');
    const row = hits[1].split(',');
    assert.equal(row.length, 26);
    assert.equal(row[0], String(result.summary[S_ID]));
    assert.deepEqual([row[1], row[2], row[3], row[4]], ['b1', 'm/z 100', '100', '1']);
    assert.deepEqual([row[6], row[8]], ['0', '0']);
    assert.equal(row[10], 'detected');
    assert.equal(row[11], 'det', 'where = the detector id');
    assert.ok(Math.abs(+row[14] - result.summary[S_X]) <= 1e-9 * Math.abs(result.summary[S_X]) + 1e-12);
    assert.ok(Math.abs(+row[20] - result.summary[S_KE]) < 1e-6);
    const cr = io.runToCSV(result, 'crossings', resolved).split('\r\n');
    assert.equal(cr[0], 'id,plane,kind,k,dir,t_us,x_mm,y_mm,z_mm,vx_mm_us,vy_mm_us,vz_mm_us,ke_eV');
    assert.equal(cr.length, result.nCross + 2);
    assert.ok(cr.slice(1, -1).every((l) => l.split(',').length === 13));
    assert.ok(cr.slice(1, -1).some((l) => l.split(',')[1] === 'mesh0' && l.split(',')[2] === 'plane'));
    const tj = io.runToCSV(result, 'trajectories', resolved).split('\r\n');
    assert.equal(tj[0], 'id,t_us,x_mm,y_mm,z_mm');
    assert.equal(tj.length, result.traj.pts.length / 4 + 2);
    const first = tj[1].split(',').map(Number);
    assert.equal(Math.fround(first[2]), result.traj.pts[0], 'float32 values round-trip');
    const mk = io.runToCSV(result, 'markers', resolved).split('\r\n');
    assert.equal(mk[0], 'id,t_us,x_mm,y_mm,z_mm');
    assert.equal(mk.length, result.markers.length / 5 + 2);
    assert.throws(() => io.runToCSV(result, 'nonsense', resolved), (e) => e.code === 'E_UNSUPPORTED');
    assert.equal(C_STRIDE, 14); assert.equal(S_STRIDE, 24);
});

test('share links round-trip losslessly; preset links are at most 4 kB', async () => {
    for (const [id, make] of Object.entries(FIXTURES)) {
        const p = make();
        p.meta.notes = 'Ünïcödé — ✓ µs';
        const link = await io.encodeShare(p);
        assert.ok(link.startsWith('p='), `${id}: deflate-raw is available in Node`);
        assert.ok(link.length + 1 <= 4096, `${id}: ${link.length} characters`);
        const back = await io.decodeShare('#' + link);
        assert.equal(canonicalJSON(back), canonicalJSON(migrate(p)), id);
        assert.equal(canonicalJSON(await io.decodeShare(link)), canonicalJSON(back), `${id}: without '#'`);
        assert.equal(canonicalJSON(await io.decodeShare(`#x=1&${link}&y=2`)), canonicalJSON(back), `${id}: among other parameters`);
    }
});

test("the 'pj=' form round-trips where CompressionStream is unavailable", async () => {
    const p = einzel();
    const link = await withoutCompression(() => io.encodeShare(p));
    assert.ok(link.startsWith('pj='));
    assert.equal(Buffer.from(link.slice(3), 'base64url').toString('utf8'), canonicalJSON(p));
    assert.equal(canonicalJSON(await io.decodeShare('#' + link)), canonicalJSON(p));
    // compressed links need DecompressionStream
    const D = globalThis.DecompressionStream;
    const c = await io.encodeShare(p);
    try { delete globalThis.DecompressionStream; await rejects('#' + c, /cannot read compressed links/); } finally { globalThis.DecompressionStream = D; }
});

test('corrupt links are rejected', async () => {
    const good = await io.encodeShare(einzel());
    await rejects('#nothing-here', /does not contain a project/);
    await rejects('#p=abc$def', /invalid characters/);
    await rejects('#p=a', /bad length/);
    await rejects('#' + good.slice(0, Math.floor(good.length / 2)), /damaged/);
    await rejects('#p=' + b64u(Buffer.from('not deflate data at all, just text')), /damaged/);
    await rejects('#p=' + b64u(deflateRawSync(Buffer.from('{"format":"ion-optics-project",'))), /damaged/);
    await rejects('#pj=' + b64u(Buffer.from([0xff, 0xfe, 0x00])), /damaged/);
    await rejects('#pj=' + b64u(Buffer.from('[1,2,3]')), /JSON object/);
    await rejects('#pj=' + b64u(Buffer.from('{"format":"spreadsheet"}')), /Not a project file/);
    const invalid = einzel(); invalid.domain.cell = -1;
    await assert.rejects(io.decodeShare('#pj=' + b64u(Buffer.from(JSON.stringify(invalid)))), (e) => e.code === 'E_BAD_PROJECT' && e.path === 'domain.cell' && Array.isArray(e.detail.errors));
    // a link is data only: functions or code in strings stay inert strings that fail validation
    const evil = einzel(); evil.shapes[0].x0 = 'constructor.constructor("return 1")()';
    await rejects('#pj=' + b64u(Buffer.from(JSON.stringify(evil))), /not valid/);
});

test('oversized links are rejected without inflating them; run sizes are clamped', async () => {
    const big = einzel();
    big.meta.notes = 'x'.repeat(70 * 1024);
    await assert.rejects(io.encodeShare(big), (e) => e.code === 'E_BAD_PROJECT' && /too large for a link/.test(e.message));
    // a small link that inflates to 2 MB is cut off at 64 kB
    const bomb = deflateRawSync(Buffer.from('{"format":"ion-optics-project","meta":{"notes":"' + ' '.repeat(2 * 1024 * 1024) + '"}}'));
    assert.ok(bomb.length < 10000);
    const t0 = performance.now();
    await rejects('#p=' + b64u(bomb), /more than 64 kB/);
    assert.ok(performance.now() - t0 < 2000);
    await rejects('#pj=' + 'A'.repeat(100000), /too long/);
    // clamps
    const huge = einzel();
    huge.tracer.maxSteps = 1e9; huge.solver.maxSweeps = 1e7; huge.recording.trajectories.maxPoints = 1e6; huge.meta.name = 'n'.repeat(500);
    const d = await io.decodeShareDetailed('#' + await io.encodeShare(huge));
    assert.equal(d.project.tracer.maxSteps, 5e6);
    assert.equal(d.project.solver.maxSweeps, 1e6);
    assert.equal(d.project.recording.trajectories.maxPoints, 1e5);
    assert.equal(d.project.meta.name.length, 200);
    assert.deepEqual(d.clamped.map((c) => c.path).sort(), ['meta.name', 'recording.trajectories.maxPoints', 'solver.maxSweeps', 'tracer.maxSteps']);
    assert.ok(d.clamped.every((c) => c.code === 'W_CLAMPED'));
    assert.deepEqual(resolve(d.project).errors, []);
});

test('base64url codec', () => {
    for (let n = 0; n < 40; n++) {
        const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n * 11) & 255);
        const s = io.base64urlEncode(bytes);
        assert.equal(s, Buffer.from(bytes).toString('base64url'), `n = ${n}`);
        assert.deepEqual([...io.base64urlDecode(s)], [...bytes]);
        assert.deepEqual([...io.base64urlDecode(s + '=='.slice(0, (4 - (s.length % 4)) % 4))], [...bytes], 'padding accepted');
    }
    assert.deepEqual(io.parseShareHash('#a=1&pj=xyz'), { kind: 'pj', data: 'xyz' });
    assert.deepEqual(io.parseShareHash('p=abc'), { kind: 'p', data: 'abc' });
    assert.equal(io.parseShareHash('#other'), null);
});

test('project files: stable text, size limit, names', () => {
    const p = einzel();
    const text = io.serializeProject(p);
    assert.ok(text.endsWith('}\n'));
    assert.ok(text.includes('\n  "domain": {'), 'indented');
    assert.equal(io.serializeProject(io.parseProject(text)), text);
    assert.deepEqual(io.parseProject(text), migrate(p));
    assert.throws(() => io.parseProject('{ not json'), (e) => e.code === 'E_BAD_PROJECT' && /not valid JSON/.test(e.message));
    assert.throws(() => io.parseProject(' '.repeat(5 * 1024 * 1024 + 1)), (e) => e.code === 'E_BAD_PROJECT' && /larger than 5 MB/.test(e.message));
    assert.throws(() => io.parseProject('{"format":"other"}'), (e) => e.code === 'E_BAD_PROJECT');
    assert.equal(io.projectFileName(p), 'Einzel lens.ionopt.json');
    assert.equal(io.projectFileName({ meta: { name: 'a/b:c*?"<>|\u0001.' } }), 'a_b_c_.ionopt.json');
    assert.equal(io.projectFileName({}), 'project.ionopt.json');
});
