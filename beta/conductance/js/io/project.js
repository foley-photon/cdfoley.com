// CAD project files (spec §2.10): JSON with the welded mesh as base64 typed arrays (little-endian), the ports, the
// gas conditions, the run settings and, optionally, the results of the last run. serializeProject writes the keys
// in a fixed order and pretty-prints with two spaces, so save → open → save gives the same bytes. Built-in
// geometries store their name and parameters instead of the mesh (loading regenerates it).
// Pure module: no DOM; runs in the page, in workers and in Node (H7, H8).

export const PROJECT_FORMAT = 'cdfoley-conductance-cad';
export const PROJECT_VERSION = 1;

const ROLES = ['inlet', 'outlet', 'pump', 'closed'];
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = (() => { const t = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i; return t; })();
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function fail(message) { throw new RangeError(message); }

// Bytes of a typed array in little-endian order (a copy only on big-endian machines).
function leBytes(ta) {
  const bytes = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength);
  const w = ta.BYTES_PER_ELEMENT || 1;
  if (LITTLE || w === 1) return bytes;
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += w) for (let k = 0; k < w; k++) out[i + k] = bytes[i + w - 1 - k];
  return out;
}

/**
 * Base64 of a typed array's bytes in little-endian order. Works in chunks, so arrays of tens of megabytes do not
 * overflow the call stack.
 */
export function toBase64(typedArray) {
  if (!typedArray || !(ArrayBuffer.isView(typedArray) || typedArray instanceof ArrayBuffer)) fail('Only typed arrays can be encoded.');
  const bytes = typedArray instanceof ArrayBuffer ? new Uint8Array(typedArray) : leBytes(typedArray);
  const n = bytes.length, out = new Uint8Array(4 * Math.ceil(n / 3));
  let o = 0, i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = B64.charCodeAt(v >>> 18); out[o++] = B64.charCodeAt((v >>> 12) & 63);
    out[o++] = B64.charCodeAt((v >>> 6) & 63); out[o++] = B64.charCodeAt(v & 63);
  }
  if (i < n) {
    const v = (bytes[i] << 16) | ((i + 1 < n ? bytes[i + 1] : 0) << 8);
    out[o++] = B64.charCodeAt(v >>> 18); out[o++] = B64.charCodeAt((v >>> 12) & 63);
    out[o++] = i + 1 < n ? B64.charCodeAt((v >>> 6) & 63) : 61;
    out[o++] = 61;
  }
  const parts = [];
  for (let k = 0; k < out.length; k += 0x8000) parts.push(String.fromCharCode.apply(null, out.subarray(k, k + 0x8000)));
  return parts.join('');
}

/** Decodes base64 (little-endian bytes) into a new typed array of the given type. */
export function fromBase64(str, ArrayType) {
  if (typeof str !== 'string') fail('The encoded data must be a text string.');
  const T = ArrayType || Uint8Array;
  const w = T.BYTES_PER_ELEMENT || 1;
  let len = str.length;
  while (len > 0 && str.charCodeAt(len - 1) === 61) len--;
  if (str.length % 4 !== 0 || str.length - len > 2) fail('The encoded data are damaged (bad base64 length).');
  const nBytes = Math.floor(len * 3 / 4);
  if (nBytes % w !== 0) fail('The encoded data do not hold whole numbers of ' + w + '-byte values.');
  const bytes = new Uint8Array(nBytes);
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < len; i++) {
    const c = str.charCodeAt(i), v = c < 128 ? B64_INV[c] : -1;
    if (v < 0) fail('The encoded data are damaged (character "' + str[i] + '" is not base64).');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; if (o < nBytes) bytes[o++] = (acc >>> bits) & 255; }
    acc &= (1 << bits) - 1;
  }
  if (!LITTLE && w > 1) for (let i = 0; i < nBytes; i += w) bytes.subarray(i, i + w).reverse();
  return new T(bytes.buffer, 0, nBytes / w);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nullOr = (v, f) => (v === null || v === undefined ? null : f(v));
const plainNum = (v) => (isNum(v) ? v : null);

function savedNow() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

function portOut(p) {
  const o = { id: p.id, name: p.name, kind: p.kind };
  if (p.kind === 'region') o.tris = p.tris ? toBase64(p.tris instanceof Uint32Array ? p.tris : Uint32Array.from(p.tris)) : null;
  else o.loops = p.loops ? p.loops.map((g) => Array.from(g, Number)) : null;
  o.role = p.role;
  o.stick = p.stick ?? null;
  o.speed = p.speed ?? null;
  return o;
}

function resultsOut(r) {
  if (!r) return null;
  const o = {
    perSource: (r.perSource || []).map((s) => ({
      port: s.port, n: s.n, absorbed: Array.from(s.absorbed || [], Number), leaks: s.leaks, stuck: s.stuck, casts: s.casts,
    })),
    hits: r.hits ? toBase64(r.hits instanceof Uint32Array ? r.hits : Uint32Array.from(r.hits)) : null,
    ms: r.ms ?? null,
    stopped: !!r.stopped,
  };
  for (const k of Object.keys(r)) if (!(k in o)) o[k] = r[k];   // extra plain-JSON fields are kept
  return o;
}

/**
 * Project state → JSON text (2-space indentation, fixed key order). state = { saved?, units: { file, scaleToMeters },
 * source: { kind: 'file', name, format } | { kind: 'builtin', name, params }, mesh: null | { vertices: Float32Array,
 * triangles: Uint32Array }, weldTol, ports: PortSpec[], conditions: { gas, T, custom }, run: { target, maxTime,
 * seed, allocation }, results: null | { perSource, hits, ms, stopped } }. `saved` defaults to now.
 */
export function serializeProject(state) {
  if (!isObj(state)) fail('There is no project to save.');
  const src = state.source || { kind: 'file', name: '', format: '' };
  const source = src.kind === 'builtin'
    ? { kind: 'builtin', name: src.name, params: src.params ? { ...src.params } : {} }
    : { kind: 'file', name: src.name ?? '', format: src.format ?? '' };
  let mesh = null;
  if (state.mesh) {
    const v = state.mesh.vertices instanceof Float32Array ? state.mesh.vertices : Float32Array.from(state.mesh.vertices);
    const t = state.mesh.triangles instanceof Uint32Array ? state.mesh.triangles : Uint32Array.from(state.mesh.triangles);
    mesh = { nVert: v.length / 3, nTri: t.length / 3, vertices: toBase64(v), triangles: toBase64(t) };
  }
  const units = state.units || {};
  const cond = state.conditions || {};
  const run = state.run || {};
  const out = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    saved: typeof state.saved === 'string' && state.saved ? state.saved : savedNow(),
    units: { file: units.file ?? 'mm', scaleToMeters: units.scaleToMeters ?? 0.001 },
    source,
    mesh,
    weldTol: state.weldTol ?? null,
    ports: (state.ports || []).map(portOut),
    conditions: { gas: cond.gas ?? 'N2', T: cond.T ?? 293.15, custom: cond.custom ?? null },
    run: {
      target: run.target ?? 0.01, maxTime: isNum(run.maxTime) ? run.maxTime : null,
      seed: run.seed ?? null, allocation: run.allocation ?? 'equal',
    },
    results: resultsOut(state.results),
  };
  return JSON.stringify(out, null, 2);
}

/**
 * JSON text → project state (the shape serializeProject takes, with typed arrays decoded). Throws RangeError with
 * a readable message for text that is not a project of this version, or whose data are damaged.
 */
export function parseProject(text) {
  if (typeof text !== 'string') fail('The project file could not be read as text.');
  let j;
  try { j = JSON.parse(text); } catch (err) { fail('This file is not a Conductance Lab project (it is not valid JSON).'); }
  if (!isObj(j) || j.format !== PROJECT_FORMAT) fail('This file is not a Conductance Lab CAD project.');
  if (j.version !== PROJECT_VERSION) {
    if (isNum(j.version) && j.version > PROJECT_VERSION) fail('This project was saved by a newer version of Conductance Lab (file version ' + j.version + '); this page reads version ' + PROJECT_VERSION + '.');
    fail('This project file has an unknown version (' + String(j.version) + ').');
  }
  if (!isObj(j.units) || !(isNum(j.units.scaleToMeters) && j.units.scaleToMeters > 0)) fail('The project file has no valid unit (units.scaleToMeters).');
  if (!isObj(j.source) || (j.source.kind !== 'file' && j.source.kind !== 'builtin')) fail('The project file does not say where its geometry comes from (source.kind).');
  let mesh = null;
  if (j.source.kind === 'builtin') {
    if (typeof j.source.name !== 'string' || !j.source.name) fail('The project names no built-in geometry.');
    if (j.source.params !== undefined && !isObj(j.source.params)) fail('The built-in parameters of the project are damaged.');
  }
  if (j.mesh !== null && j.mesh !== undefined) {
    const m = j.mesh;
    if (!isObj(m) || !Number.isInteger(m.nVert) || !Number.isInteger(m.nTri) || m.nVert < 3 || m.nTri < 1) fail('The mesh in the project file is incomplete.');
    const vertices = fromBase64(m.vertices, Float32Array), triangles = fromBase64(m.triangles, Uint32Array);
    if (vertices.length !== 3 * m.nVert) fail('The mesh in the project file is damaged: it should have ' + m.nVert + ' vertices.');
    if (triangles.length !== 3 * m.nTri) fail('The mesh in the project file is damaged: it should have ' + m.nTri + ' triangles.');
    for (let i = 0; i < vertices.length; i++) if (!Number.isFinite(vertices[i])) fail('The mesh in the project file has a vertex that is not a finite number.');
    for (let i = 0; i < triangles.length; i++) if (triangles[i] >= m.nVert) fail('The mesh in the project file refers to a vertex that does not exist.');
    mesh = { nVert: m.nVert, nTri: m.nTri, vertices, triangles };
  } else if (j.source.kind === 'file') fail('The project file has no mesh.');
  if (j.weldTol !== null && j.weldTol !== undefined && !(isNum(j.weldTol) && j.weldTol >= 0)) fail('The merge tolerance in the project file is not valid.');
  if (!Array.isArray(j.ports)) fail('The project file has no list of openings.');
  const ids = new Set();
  const ports = j.ports.map((p, k) => {
    if (!isObj(p)) fail('Opening ' + (k + 1) + ' in the project file is damaged.');
    if (!(Number.isInteger(p.id) && p.id >= 0 && p.id <= 32767) || ids.has(p.id)) fail('Opening ' + (k + 1) + ' in the project file has a missing or repeated id.');
    ids.add(p.id);
    if (!ROLES.includes(p.role)) fail('Opening ' + (k + 1) + ' in the project file has an unknown role "' + String(p.role) + '".');
    if (p.kind !== 'loop' && p.kind !== 'region') fail('Opening ' + (k + 1) + ' in the project file has an unknown kind.');
    let loops = null, tris = null;
    if (p.kind === 'loop') {
      if (!Array.isArray(p.loops) || !p.loops.every((g) => Array.isArray(g) && g.length && g.every((x) => Number.isInteger(x) && x >= 0))) {
        fail('Opening ' + (k + 1) + ' in the project file has damaged edge loops.');
      }
      loops = p.loops.map((g) => g.slice());
    } else {
      if (typeof p.tris !== 'string') fail('Opening ' + (k + 1) + ' in the project file has no triangles.');
      tris = fromBase64(p.tris, Uint32Array);
    }
    const stick = nullOr(p.stick, (v) => { if (!(isNum(v) && v >= 0 && v <= 1)) fail('Opening ' + (k + 1) + ' has a sticking coefficient outside 0 to 1.'); return v; });
    const speed = nullOr(p.speed, (v) => { if (!(isNum(v) && v > 0)) fail('Opening ' + (k + 1) + ' has a pumping speed that is not a positive number.'); return v; });
    return { id: p.id, name: typeof p.name === 'string' ? p.name : 'Opening ' + (k + 1), kind: p.kind, loops, tris, role: p.role, stick, speed };
  });
  const c = isObj(j.conditions) ? j.conditions : {};
  if (c.T !== undefined && !(isNum(c.T) && c.T > 0)) fail('The temperature in the project file is not valid.');
  const conditions = { gas: typeof c.gas === 'string' ? c.gas : 'N2', T: isNum(c.T) ? c.T : 293.15, custom: isObj(c.custom) ? { ...c.custom } : null };
  const r = isObj(j.run) ? j.run : {};
  const run = {
    target: isNum(r.target) ? r.target : 0.01, maxTime: plainNum(r.maxTime),
    seed: isNum(r.seed) ? r.seed : null, allocation: r.allocation === 'favor-small' ? 'favor-small' : 'equal',
  };
  let results = null;
  if (j.results !== null && j.results !== undefined) {
    const R = j.results;
    if (!isObj(R) || !Array.isArray(R.perSource)) fail('The stored results in the project file are damaged.');
    const perSource = R.perSource.map((s, k) => {
      if (!isObj(s) || !Number.isInteger(s.port) || !isNum(s.n) || !Array.isArray(s.absorbed) || !s.absorbed.every(isNum)) {
        fail('The stored results in the project file are damaged (source ' + (k + 1) + ').');
      }
      return { port: s.port, n: s.n, absorbed: s.absorbed.slice(), leaks: s.leaks ?? 0, stuck: s.stuck ?? 0, casts: s.casts ?? 0 };
    });
    results = { perSource, hits: typeof R.hits === 'string' ? fromBase64(R.hits, Uint32Array) : null, ms: R.ms ?? null, stopped: !!R.stopped };
    for (const k of Object.keys(R)) if (!(k in results)) results[k] = R[k];
  }
  const source = j.source.kind === 'builtin'
    ? { kind: 'builtin', name: j.source.name, params: isObj(j.source.params) ? { ...j.source.params } : {} }
    : { kind: 'file', name: typeof j.source.name === 'string' ? j.source.name : '', format: typeof j.source.format === 'string' ? j.source.format : '' };
  return {
    format: j.format, version: j.version, saved: typeof j.saved === 'string' ? j.saved : '',
    units: { file: typeof j.units.file === 'string' ? j.units.file : 'mm', scaleToMeters: j.units.scaleToMeters },
    source, mesh, weldTol: isNum(j.weldTol) ? j.weldTol : null, ports, conditions, run, results,
  };
}
