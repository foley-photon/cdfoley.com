// Prep-worker message handler (spec §2.13): parses STL/OBJ files, prepares meshes (weld, validate, openings), makes
// built-in geometries, selects coplanar regions and builds the Monte Carlo scene. The worker file wires it to
// self.postMessage / self.onmessage; Node tests drive it directly.
//
//   request                                                          reply
//   { type: 'parse', id, name, buffer, format: 'auto'|'stl'|'obj',   { type: 'parsed', id, nTri, format, warnings,
//     scale }  (buffer transferred; scale = metres per file unit;      bbox (metres) }
//     a parse without a buffer re-scales the last file)
//   { type: 'prepare', id, weldTol: null | m, scale? }               { type: 'prepared', id, positions (Float32Array,
//     (uses the last parse; scale, when given, re-scales it)           transferred, prepared order), report, autoPorts }
//   { type: 'builtin', id, name, params }                            'prepared' reply plus reference
//   { type: 'loadMesh', id, vertices, triangles, weldTol }           'prepared' reply
//   { type: 'region', id, seedTri, angleDeg = 0.5, distTol = null }  { type: 'region', id, tris, plane, area }
//   { type: 'scene', id, ports, G? }  (G: GasState, needed only       { type: 'scene', id, scene, capPositions,
//     to turn a pump port's speed into a sticking coefficient)          triPort, ms }  (buffers transferred)
//   { type: 'export', id }                                           { type: 'exported', id, vertices, triangles }
//   (any failure)                                                    { type: 'error', id, message }
// Pure module: no DOM, no bare imports (H7). SI units.
import { parseSTL } from '../io/stl.js';
import { parseOBJ } from '../io/obj.js';
import { prepareMesh, regionFrom } from './mesh.js';
import { buildScene } from './ports.js';
import { prepareBuiltin } from './testgeom.js';

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function fail(message) { throw new RangeError(message); }

function bboxOf(p) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return [x0, y0, z0, x1, y1, z1];
}

// Non-indexed positions (Float32Array, 9 per triangle) of a mesh, in its triangle order.
function soupOf(mesh) {
  const V = mesh.vertices, T = mesh.tris, out = new Float32Array(3 * T.length);
  for (let k = 0; k < T.length; k++) { const v = 3 * T[k]; out[3 * k] = V[v]; out[3 * k + 1] = V[v + 1]; out[3 * k + 2] = V[v + 2]; }
  return out;
}

function scaled(file, scale) {
  if (!(Number.isFinite(scale) && scale > 0)) fail('Pick the unit of the file.');
  const out = new Float32Array(file.length);
  for (let i = 0; i < file.length; i++) out[i] = file[i] * scale;
  return out;
}

function sceneTransfers(scene, extra) {
  const set = new Set();
  for (const k of ['tri', 'normal', 'area', 'port', 'origTri', 'box', 'meta']) if (scene[k] && scene[k].buffer) set.add(scene[k].buffer);
  for (const p of scene.ports) { if (p.slots) set.add(p.slots.buffer); if (p.cdf) set.add(p.cdf.buffer); }
  for (const a of extra) if (a && a.buffer) set.add(a.buffer);
  return [...set];
}

const errText = (err) => (err && err.message ? err.message : String(err));

/** Creates a prep service; post(msg, transfer) sends a message to the main thread. Returns { onMessage(msg) }. */
export function createService(post) {
  const st = { file: null, prep: null };     // file: { name, format, positions (file units), warnings, scale }

  function preparedReply(id, prep, extra = {}) {
    const positions = soupOf(prep.mesh);
    post({ type: 'prepared', id, positions, report: prep.report, autoPorts: prep.autoPorts, ...extra }, [positions.buffer]);
  }

  const handlers = {
    parse(msg) {
      // the loaded model changes only when the whole request succeeds
      let file = st.file;
      if (msg.buffer) {
        const fmt = msg.format && msg.format !== 'auto' ? msg.format
          : /\.obj$/i.test(msg.name || '') ? 'obj' : /\.stl$/i.test(msg.name || '') ? 'stl' : sniff(msg.buffer);
        let r;
        if (fmt === 'stl') r = parseSTL(msg.buffer);
        else if (fmt === 'obj') r = { ...parseOBJ(msg.buffer), format: 'obj' };
        else fail('Choose an STL or OBJ file.');
        file = { name: msg.name || '', format: r.format, positions: r.positions, warnings: r.warnings || [], scale: null };
      } else if (!file) {
        fail('Load a file first.');
      }
      const scale = msg.scale ?? file.scale ?? 0.001;
      const m = scaled(file.positions, scale);
      file.scale = scale;
      if (file !== st.file) { st.file = file; st.prep = null; }
      post({ type: 'parsed', id: msg.id, nTri: m.length / 9, format: file.format, warnings: file.warnings.slice(), bbox: bboxOf(m) }, []);
    },
    prepare(msg) {
      if (!st.file) fail('Load a file first.');
      const scale = msg.scale ?? st.file.scale ?? 0.001;
      const prep = prepareMesh(scaled(st.file.positions, scale), msg.weldTol ?? null);
      st.file.scale = scale;
      st.prep = { mesh: prep.mesh, report: prep.report, autoPorts: prep.autoPorts };
      preparedReply(msg.id, prep);
    },
    builtin(msg) {
      const b = prepareBuiltin(msg.name, msg.params || {});
      st.prep = { mesh: b.prep.mesh, report: b.prep.report, autoPorts: b.suggestedPorts };
      preparedReply(msg.id, st.prep, { reference: b.reference });
    },
    loadMesh(msg) {
      const V = msg.vertices, T = msg.triangles;
      if (!V || !T || !(V.length >= 9) || V.length % 3 || !(T.length >= 3) || T.length % 3) fail('The saved mesh is incomplete.');
      const nV = V.length / 3, soup = new Float32Array(3 * T.length);
      for (let k = 0; k < T.length; k++) {
        const v = T[k];
        if (!(v < nV)) fail('The saved mesh refers to a vertex that does not exist.');
        soup[3 * k] = V[3 * v]; soup[3 * k + 1] = V[3 * v + 1]; soup[3 * k + 2] = V[3 * v + 2];
      }
      const prep = prepareMesh(soup, msg.weldTol ?? null);
      st.prep = { mesh: prep.mesh, report: prep.report, autoPorts: prep.autoPorts };
      preparedReply(msg.id, prep);
    },
    region(msg) {
      if (!st.prep) fail('Load a model first.');
      const nT = st.prep.mesh.tris.length / 3;
      if (Number.isInteger(msg.seedTri) && msg.seedTri >= nT) fail('That face closes an opening; pick a face of the model itself.');
      const r = regionFrom(st.prep.mesh, msg.seedTri, msg.angleDeg ?? 0.5, msg.distTol ?? null);
      post({ type: 'region', id: msg.id, tris: r.tris, plane: r.plane, area: r.area }, [r.tris.buffer]);
    },
    scene(msg) {
      if (!st.prep) fail('Load a model first.');
      const t0 = now();
      const r = buildScene(st.prep.mesh, msg.ports || [], msg.G || msg.gas || null);
      post({ type: 'scene', id: msg.id, scene: r.scene, capPositions: r.capPositions, triPort: r.triPort, ms: now() - t0 },
        sceneTransfers(r.scene, [r.capPositions, r.triPort]));
    },
    export(msg) {
      if (!st.prep) fail('Load a model first.');
      const vertices = Float32Array.from(st.prep.mesh.vertices), triangles = Uint32Array.from(st.prep.mesh.tris);
      post({ type: 'exported', id: msg.id, vertices, triangles }, [vertices.buffer, triangles.buffer]);
    },
  };

  function onMessage(msg) {
    const id = msg && msg.id !== undefined ? msg.id : null;
    try {
      const h = msg && Object.prototype.hasOwnProperty.call(handlers, msg.type) ? handlers[msg.type] : null;
      if (!h) fail('Unknown request "' + (msg && msg.type) + '".');
      h(msg);
    } catch (err) {
      post({ type: 'error', id, message: errText(err) }, []);
    }
  }

  return { onMessage };
}

// 'stl' or 'obj' from the first bytes of a file without a telling name.
function sniff(buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096));
  if (buffer.byteLength >= 84) {
    const n = new DataView(buffer).getUint32(80, true);
    if (buffer.byteLength === 84 + 50 * n) return 'stl';
  }
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  if (/^\s*solid\b/i.test(text)) return 'stl';
  if (/^\s*(?:#.*\n\s*)*(?:v|vn|vt|o|g|mtllib|f)\s/m.test(text)) return 'obj';
  return 'stl';
}
