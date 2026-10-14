// WP3 performance probe (spec §6; not part of node --test). Prints the measured times of the geometry and file
// steps against their budgets. Usage: node _tests/conductance/wp3-perf.mjs
import { parseSTL, writeBinarySTL } from '../../beta/conductance/js/io/stl.js';
import { parseOBJ } from '../../beta/conductance/js/io/obj.js';
import { serializeProject, parseProject } from '../../beta/conductance/js/io/project.js';
import { prepareMesh, facetRegions } from '../../beta/conductance/js/engine/mesh.js';
import { buildScene } from '../../beta/conductance/js/engine/ports.js';
import { triangulatePolygon } from '../../beta/conductance/js/engine/triangulate.js';
import { prepareBuiltin, BUILTINS } from '../../beta/conductance/js/engine/testgeom.js';
import { createService } from '../../beta/conductance/js/engine/prep-service.js';
import { gasState } from '../../beta/conductance/js/engine/gas.js';

const N2 = gasState('N2', 293.15);
const rows = [];
function time(label, fn, { runs = 3, budget = null } = {}) {
  fn();                                                            // warm-up
  let best = Infinity, out;
  for (let k = 0; k < runs; k++) { const t0 = performance.now(); out = fn(); best = Math.min(best, performance.now() - t0); }
  rows.push({ label, ms: best, budget });
  return out;
}

// an open tube of n sides and m rings, 2·n·m triangles (metres)
function tube(n, m, R = 0.02, L = 0.2) {
  const pos = new Float32Array(18 * n * m);
  const P = (k, j) => [R * Math.cos(2 * Math.PI * (k % n) / n), R * Math.sin(2 * Math.PI * (k % n) / n), L * j / m];
  let o = 0;
  const put = (p) => { pos[o++] = p[0]; pos[o++] = p[1]; pos[o++] = p[2]; };
  for (let j = 0; j < m; j++) for (let k = 0; k < n; k++) { const a = P(k, j), b = P(k + 1, j), c = P(k + 1, j + 1), d = P(k, j + 1); put(a); put(b); put(c); put(a); put(c); put(d); }
  return pos;
}

const t100 = tube(250, 200);                                       // 100 000 triangles
const t26 = tube(128, 101);                                        // 25 856 triangles (the prototype's 26 k tube)
const t250 = tube(400, 313);                                       // 250 400 triangles
const bin100 = writeBinarySTL(t100);
time('STL parse, binary, 100 k triangles', () => parseSTL(bin100), { budget: 300 });
let ascii = 'solid perf\n';
{
  const parts = [];
  for (let t = 0; t < 100000; t++) {
    const o = 9 * t;
    parts.push(`facet normal 0 0 0\n outer loop\n  vertex ${t100[o]} ${t100[o + 1]} ${t100[o + 2]}\n  vertex ${t100[o + 3]} ${t100[o + 4]} ${t100[o + 5]}\n  vertex ${t100[o + 6]} ${t100[o + 7]} ${t100[o + 8]}\n endloop\nendfacet\n`);
  }
  ascii += parts.join('') + 'endsolid perf\n';
}
const asciiBuf = new TextEncoder().encode(ascii).buffer;
time('STL parse, ASCII, 100 k triangles (' + (asciiBuf.byteLength / 1e6).toFixed(0) + ' MB)', () => parseSTL(asciiBuf), { runs: 2 });
{
  const lines = [];
  for (let i = 0; i < t100.length; i += 3) lines.push(`v ${t100[i]} ${t100[i + 1]} ${t100[i + 2]}`);
  for (let t = 0; t < 100000; t++) lines.push(`f ${3 * t + 1} ${3 * t + 2} ${3 * t + 3}`);
  const objText = lines.join('\n');
  time('OBJ parse, 100 k triangles (unwelded)', () => parseOBJ(objText), { runs: 2 });
}
const p100 = time('Weld, validate and detect loops (prepareMesh), 100 k triangles', () => prepareMesh(t100), { budget: 600 });
time('prepareMesh, 250 k triangles', () => prepareMesh(t250), { runs: 2 });
const p26 = prepareMesh(t26);
time('buildScene (caps, BVH, inward normals), 26 k triangles', () => buildScene(p26.mesh, p26.autoPorts, N2));
time('buildScene, 100 k triangles', () => buildScene(p100.mesh, p100.autoPorts, N2), { runs: 2 });
const p250 = prepareMesh(t250);
time('buildScene, 250 k triangles', () => buildScene(p250.mesh, p250.autoPorts, N2), { runs: 2 });
time('facetRegions, 100 k triangles', () => facetRegions(p100.mesh), { runs: 2 });
{
  const n = 3000, poly = new Float64Array(2 * n), hole = new Float64Array(2 * 1000);
  for (let k = 0; k < n; k++) { poly[2 * k] = Math.cos(2 * Math.PI * k / n) * (1 + 0.2 * Math.cos(40 * Math.PI * k / n)); poly[2 * k + 1] = Math.sin(2 * Math.PI * k / n) * (1 + 0.2 * Math.cos(40 * Math.PI * k / n)); }
  for (let k = 0; k < 1000; k++) { hole[2 * k] = 0.3 * Math.cos(-2 * Math.PI * k / 1000); hole[2 * k + 1] = 0.3 * Math.sin(-2 * Math.PI * k / 1000); }
  time('Ear clipping, 3000-vertex wavy loop with a 1000-vertex hole', () => triangulatePolygon(poly, [hole]));
}
for (const name of Object.keys(BUILTINS)) time('Built-in "' + name + '": generate and prepare', () => prepareBuiltin(name));
{
  const b = prepareBuiltin('elbow');
  time('CAD default elbow: builtin + scene through the prep service', () => {
    const out = [];
    const svc = createService((m) => out.push(m));
    svc.onMessage({ type: 'builtin', id: 1, name: 'elbow', params: {} });
    svc.onMessage({ type: 'scene', id: 2, ports: out[0].autoPorts, G: N2 });
    return out;
  });
  const state = {
    saved: '2026-10-12T10:00:00Z', units: { file: 'mm', scaleToMeters: 0.001 }, source: { kind: 'file', name: 'perf.stl', format: 'stl-binary' },
    mesh: { vertices: Float32Array.from(p100.mesh.vertices), triangles: Uint32Array.from(p100.mesh.tris) }, weldTol: null, ports: b.suggestedPorts,
    conditions: { gas: 'N2', T: 293.15, custom: null }, run: { target: 0.01, maxTime: 60, seed: 1, allocation: 'equal' }, results: null,
  };
  const text = time('Project save, 100 k-triangle mesh', () => serializeProject(state));
  time('Project open, 100 k-triangle mesh (' + (text.length / 1e6).toFixed(1) + ' MB)', () => parseProject(text));
}

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
let out = 'WP3 performance (Node ' + process.version + ', best of runs after a warm-up)\n\n';
out += pad('Step', 72) + pad('ms', 10) + 'Budget\n' + '-'.repeat(96) + '\n';
for (const r of rows) out += pad(r.label, 72) + pad(r.ms.toFixed(1), 10) + (r.budget ? '≤ ' + r.budget + ' ms ' + (r.ms <= r.budget ? 'OK' : 'OVER') : '') + '\n';
out += '\nbuildScene includes the BVH build of WP2 (budget ≤ 250 ms at 26 k and ≤ 3 s at 250 k triangles, §6).\n';
process.stdout.write(out);
