// WP6 clean-room check (spec H1, H2, §5.3): no file under beta/ or _tests/ionoptics/ names the commercial incumbent,
// its file formats or its vocabulary, in its contents or its file name. The patterns are built from character codes so
// that this file does not match itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIRS = ['beta', '_tests/ionoptics'];
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.pdf', '.zip', '.gz', '.npy', '.bin']);
const c = (...codes) => String.fromCharCode(...codes);
const W = { s: c(115, 105, 109, 105, 111, 110), f: c(102, 108, 121), p: c(112, 97), m: c(109), sp: c(115, 112, 108, 97, 116), fa: c(102, 97, 115, 116), ad: c(97, 100, 106, 117, 115, 116) };

/** Content patterns of spec §5.3. */
const CONTENT = [
    { name: 'incumbent name', re: new RegExp(W.s, 'i') },
    { name: 'flight-definition format', re: new RegExp('\\b' + W.f + '2\\b', 'i') },
    { name: 'array-file extension', re: new RegExp('\\.' + W.p + '[#0-9]\\b', 'i') },
    { name: 'run command', re: new RegExp(W.f + "'?" + W.m + '\\b', 'i') },
    { name: 'hit-recording term', re: new RegExp('\\b' + W.sp, 'i') },
    { name: 'voltage-update feature', re: new RegExp(W.fa + ' ' + W.ad, 'i') },
];
/** File-name patterns: the same words, and the incumbent's file extensions (H2). */
const NAMES = [
    ...CONTENT,
    { name: 'incumbent file extension', re: new RegExp('\\.(' + [c(103, 101, 109), c(105, 111, 110), c(105, 111, 98), W.f + '2', W.p + '[#0-9]*'].join('|') + ')$', 'i') },
];

function walk(dir, out) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
}

const FILES = DIRS.flatMap((d) => walk(join(ROOT, d), []));

test('the scan covers the beta folder and the tests', () => {
    const rel = FILES.map((f) => relative(ROOT, f).replace(/\\/g, '/'));
    assert.ok(rel.includes('beta/ion-optics/help/index.html'), 'help page scanned');
    assert.ok(rel.includes('beta/ion-optics/js/presets/index.js'), 'presets scanned');
    assert.ok(rel.includes('_tests/ionoptics/wp6-cleanroom.test.mjs'), 'this file scanned');
    assert.ok(FILES.length > 50, `only ${FILES.length} files found`);
});

test('the patterns catch what they must (self-check)', () => {
    const probe = (s) => CONTENT.some((p) => p.re.test(s));
    assert.ok(probe(W.s.toUpperCase() + ' 8'));
    assert.ok(probe('load a.' + W.p + '0 file'));
    assert.ok(probe('a ' + W.f + '2 file'));
    assert.ok(probe(W.f + "'" + W.m + ' button'));
    assert.ok(probe(W.sp + ' points'));
    assert.ok(probe(W.fa + ' ' + W.ad + ' mode'));
    assert.ok(!probe('ion optics workbench, flight time, fly to the detector, adjustable fast run, page 2'));
    assert.ok(NAMES.some((p) => p.re.test('lens.' + c(105, 111, 110))));
    assert.ok(!NAMES.some((p) => p.re.test('presets.js')));
});

test('no file under beta/ or _tests/ionoptics/ names the incumbent or its formats', () => {
    const hits = [];
    for (const f of FILES) {
        const rel = relative(ROOT, f).replace(/\\/g, '/');
        const base = rel.split('/').pop();
        for (const p of NAMES) if (p.re.test(base)) hits.push(`${rel}: file name (${p.name})`);
        if (BINARY.has(extname(f).toLowerCase())) continue;
        const text = readFileSync(f, 'utf8');
        const lines = text.split(/\r?\n/);
        for (const p of CONTENT) {
            if (!p.re.test(text)) continue;
            lines.forEach((line, i) => { if (p.re.test(line)) hits.push(`${rel}:${i + 1}: ${p.name}`); });
        }
    }
    assert.deepEqual(hits, [], hits.join('\n'));
});
