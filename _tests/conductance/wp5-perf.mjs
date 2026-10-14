// WP5 performance probe (spec 6, 7.6 acceptance 7). Not part of node --test. DOM timing is excluded.
//   node _tests/conductance/wp5-perf.mjs
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { analyze, sweep } from '../../beta/conductance/js/engine/network.js';
import { renderSchematic } from '../../beta/conductance/js/ui/schematic.js';
import { presetModel, PRESETS } from '../../beta/conductance/js/ui/components-ui.js';
import { encode, decode } from '../../beta/conductance/js/ui/url-state.js';

const now = () => performance.now();
function time(fn, n) { for (let k = 0; k < 3; k++) fn(); const t0 = now(); for (let k = 0; k < n; k++) fn(); return (now() - t0) / n; }
const rows = [];
let worstSch = 0, worstRecompute = 0;
PRESETS.forEach((p, k) => {
    const m = presetModel(k), a = analyze(m);
    const tSch = Math.max(time(() => renderSchematic(a, { items: m.items, mode: 'scale' }), 50), time(() => renderSchematic(a, { items: m.items, mode: 'compressed' }), 50));
    const tAll = time(() => { const r = analyze(m); sweep(m, m.bc.mode === 'dp' ? 'dp' : 'Seff'); sweep(m, 'C'); renderSchematic(r, { items: m.items }); }, 10);
    worstSch = Math.max(worstSch, tSch); worstRecompute = Math.max(worstRecompute, tAll);
    rows.push([`preset ${k + 1} (${p.label})`, tSch.toFixed(3) + ' ms', tAll.toFixed(2) + ' ms']);
});
// 40-element model with two parallel groups
const items = [];
for (let k = 0; k < 37; k++) items.push(k % 3 === 0 ? { t: 'elbow', d: 0.05, A: 0.06, B: 0.06 } : k % 3 === 1 ? { t: 'cone', d1: 0.05, d2: 0.04, L: 0.05 } : { t: 'tube', d: 0.04, L: 0.1 });
items.splice(10, 1, { t: 'parallel', branches: [[{ t: 'tube', d: 0.02, L: 0.2 }], [{ t: 'tube', d: 0.03, L: 0.3 }, { t: 'elbow', d: 0.03, A: 0.05, B: 0.05 }]] });
items.splice(20, 1, { t: 'parallel', branches: [[{ t: 'tube', d: 0.02, L: 0.2 }], [{ t: 'tube', d: 0.03, L: 0.3 }], [{ t: 'cone', d1: 0.03, d2: 0.02, L: 0.1 }]] });
items.push({ t: 'tube', d: 0.05, L: 0.1 }, { t: 'tube', d: 0.06, L: 0.1 }, { t: 'pump', S: 0.2, d: 0.1, label: 'Turbo' });
const big = { ...presetModel(0), items, bc: { mode: 'pump', p0: 1e5 } };
const ab = analyze(big);
const tBigSch = time(() => renderSchematic(ab, { items, mode: 'compressed' }), 20);
const tBig = time(() => { const r = analyze(big); sweep(big, 'Seff'); sweep(big, 'C'); renderSchematic(r, { items }); }, 3);
const st = { tab: 'components', model: big, units: { lu: 'mm', su: 'L/s', pu: 'mbar' } };
const tHash = time(() => decode(encode(st)), 200);

const files = ['ui/app.js', 'ui/store.js', 'ui/format.js', 'ui/url-state.js', 'ui/components-ui.js', 'ui/schematic.js',
    'engine/gas.js', 'engine/interp.js', 'engine/tables.js', 'engine/molecular.js', 'engine/flow.js', 'engine/elements.js', 'engine/network.js'];
const lazy = ['engine/chain-scene.js', 'engine/chain-mc.js', 'engine/stats.js', 'engine/rng.js'];
const size = (list) => list.reduce((s, f) => s + statSync(new URL('../../beta/conductance/js/' + f, import.meta.url)).size, 0);
const gz = (list) => list.reduce((s, f) => s + gzipSync(readFileSync(new URL('../../beta/conductance/js/' + f, import.meta.url))).length, 0);
const ui = files.filter((f) => f.startsWith('ui/')), eng = files.filter((f) => f.startsWith('engine/'));
const css = statSync(new URL('../../beta/conductance/conductance.css', import.meta.url)).size;

const out = [];
out.push('WP5 perf (Node ' + process.version + ')');
out.push('preset | schematic (worst mode) | analyze + 2 sweeps + schematic');
for (const r of rows) out.push(r.join(' | '));
out.push(`40-element model (2 parallel groups, 1 bar): schematic ${tBigSch.toFixed(2)} ms; recompute ${tBig.toFixed(1)} ms (budget 400 ms desktop); hash encode+decode ${tHash.toFixed(3)} ms; hash ${encode(st).length} bytes`);
out.push(`schematic, worst preset: ${worstSch.toFixed(3)} ms (budget 5 ms) ${worstSch <= 5 ? 'OK' : 'OVER'}`);
out.push(`recompute without DOM, worst preset: ${worstRecompute.toFixed(2)} ms (budget 50 ms desktop incl. DOM) ${worstRecompute <= 50 ? 'OK' : 'OVER'}`);
out.push(`Components-tab JS (preloaded): UI ${(size(ui) / 1000).toFixed(1)} kB + engine ${(size(eng) / 1000).toFixed(1)} kB = ${(size(files) / 1000).toFixed(1)} kB (budget 140 kB); gzip ${(gz(files) / 1000).toFixed(1)} kB`);
out.push(`lazily loaded after first render (MC planner): ${(size(lazy) / 1000).toFixed(1)} kB; conductance.css ${(css / 1000).toFixed(1)} kB (budget 20 kB)`);
process.stdout.write(out.join('\n') + '\n');
