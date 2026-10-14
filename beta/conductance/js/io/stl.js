// STL reading and writing (spec §2.16, §3.6.7; research §4). Binary STL is an 80-byte header, a uint32 triangle
// count and 50 bytes per triangle (normal, three vertices, a uint16 attribute), little-endian. A file is read as
// binary when its size is exactly 84 + 50·N, even if its header starts with "solid" (many exporters do that);
// otherwise as ASCII when it starts with "solid". Stored facet normals are never used: the vertex order defines
// each triangle, and every later step recomputes normals from it. STL carries no unit: positions are returned in
// file units and the caller scales them.
// Pure module: no DOM; runs in the page, in workers and in Node (H7, H8).

const HEADER_BYTES = 80;
const RECORD_BYTES = 50;

const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;

function fail(message) { throw new RangeError(message); }

// Normal of one triangle (unnormalized) from 9 numbers starting at o.
function triNormal(p, o) {
  const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2];
  const vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

// Counts facets whose stored normal is non-zero and points against the vertex order (dot < 0).
function countFlipped(positions, stored, n) {
  let flipped = 0;
  for (let t = 0; t < n; t++) {
    const sx = stored[3 * t], sy = stored[3 * t + 1], sz = stored[3 * t + 2];
    if (sx === 0 && sy === 0 && sz === 0) continue;
    const c = triNormal(positions, 9 * t);
    if (c[0] * sx + c[1] * sy + c[2] * sz < 0) flipped++;
  }
  return flipped;
}

function flippedWarning(k) {
  return k + (k === 1 ? ' facet normal in the file points' : ' facet normals in the file point')
    + ' against the vertex order; the vertex order is used.';
}

function parseBinary(buf, n, warnings) {
  const dv = new DataView(buf);
  const positions = new Float32Array(9 * n);
  const stored = new Float32Array(3 * n);
  let o = HEADER_BYTES + 4;
  for (let t = 0; t < n; t++, o += RECORD_BYTES) {
    stored[3 * t] = dv.getFloat32(o, true);
    stored[3 * t + 1] = dv.getFloat32(o + 4, true);
    stored[3 * t + 2] = dv.getFloat32(o + 8, true);
    const p = 9 * t;
    for (let k = 0; k < 9; k++) {
      const x = dv.getFloat32(o + 12 + 4 * k, true);
      if (!Number.isFinite(x)) fail('Triangle ' + (t + 1) + ' has a coordinate that is not a finite number.');
      positions[p + k] = x;
    }
  }
  const flipped = countFlipped(positions, stored, n);
  if (flipped) warnings.push(flippedWarning(flipped));
  return positions;
}

// True when the first bytes (after optional whitespace and a UTF-8 byte-order mark) spell "solid".
function startsWithSolid(bytes) {
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && isWs(bytes[i])) i++;
  if (i + 5 > bytes.length) return false;
  const w = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]).toLowerCase();
  return w === 'solid';
}

// True when the bytes look like binary data (NUL or control bytes other than whitespace).
function looksBinary(bytes, from, to) {
  for (let i = from; i < Math.min(to, bytes.length); i++) {
    const c = bytes[i];
    if (c === 0 || (c < 32 && !isWs(c))) return true;
  }
  return false;
}

function decodeText(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}

// ASCII STL: "solid name / facet [normal nx ny nz] / outer loop / vertex x y z ×3 / endloop / endfacet / endsolid".
// Tokens may be separated by any whitespace. Facets without "normal" are accepted; a loop with more than three
// vertices is split into a fan (with a warning). Several solids in one file are read one after the other.
function parseAscii(text, warnings) {
  const out = [];
  const storedN = [];
  const len = text.length;
  let i = 0, line = 1;
  let tokLine = 1;
  const next = () => {
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 10) { line++; i++; } else if (isWs(c) || c === 0xfeff) i++; else break;
    }
    if (i >= len) return null;
    const s = i;
    tokLine = line;
    while (i < len && !isWs(text.charCodeAt(i))) i++;
    return text.slice(s, i);
  };
  const skipLine = () => { while (i < len && text.charCodeAt(i) !== 10) i++; };
  const number = (what) => {
    const t = next();
    if (t === null) fail('The STL file ends in the middle of a ' + what + ' (line ' + line + ').');
    const x = Number(t);
    if (t === '' || Number.isNaN(x)) fail('Line ' + tokLine + ': "' + t.slice(0, 20) + '" is not a number.');
    if (!Number.isFinite(x)) fail('Line ' + tokLine + ': the coordinate "' + t.slice(0, 20) + '" is not a finite number.');
    return x;
  };
  let loop = null, normal = [0, 0, 0], inFacet = false, polygons = 0, unknown = 0, sawSolid = false;
  for (;;) {
    const t = next();
    if (t === null) break;
    const w = t.toLowerCase();
    if (w === 'solid') { sawSolid = true; skipLine(); continue; }
    if (w === 'endsolid') { skipLine(); continue; }
    if (w === 'facet') {
      inFacet = true;
      normal = [0, 0, 0];
      loop = null;
      // optional "normal nx ny nz"
      const save = i, saveLine = line;
      const t2 = next();
      if (t2 !== null && t2.toLowerCase() === 'normal') normal = [number('facet normal'), number('facet normal'), number('facet normal')];
      else { i = save; line = saveLine; }
      continue;
    }
    if (w === 'outer') {
      const t2 = next();
      if (t2 === null || t2.toLowerCase() !== 'loop') fail('Line ' + tokLine + ': "outer" must be followed by "loop".');
      loop = [];
      continue;
    }
    if (w === 'vertex') {
      if (!loop) loop = [];
      loop.push(number('vertex'), number('vertex'), number('vertex'));
      continue;
    }
    if (w === 'endloop' || w === 'endfacet') {
      if (loop) {
        const nv = loop.length / 3;
        if (nv < 3) fail('Line ' + tokLine + ': a facet needs three vertices, but this one has ' + nv + '.');
        if (nv > 3) polygons++;
        for (let k = 1; k + 1 < nv; k++) {
          out.push(loop[0], loop[1], loop[2], loop[3 * k], loop[3 * k + 1], loop[3 * k + 2],
            loop[3 * k + 3], loop[3 * k + 4], loop[3 * k + 5]);
          storedN.push(normal[0], normal[1], normal[2]);
        }
        loop = null;
      }
      if (w === 'endfacet') inFacet = false;
      continue;
    }
    if (!inFacet && !sawSolid) fail('This is not an STL file: it starts with "' + t.slice(0, 20) + '".');
    unknown++;
  }
  if (loop && loop.length) fail('The STL file ends in the middle of a facet (line ' + line + ').');
  if (polygons) warnings.push(polygons + (polygons === 1 ? ' facet has' : ' facets have') + ' more than three vertices and ' + (polygons === 1 ? 'was' : 'were') + ' split into triangles.');
  if (unknown) warnings.push(unknown + ' unknown ' + (unknown === 1 ? 'word was' : 'words were') + ' ignored.');
  const positions = Float32Array.from(out);
  const n = positions.length / 9;
  for (let k = 0; k < positions.length; k++) {
    if (!Number.isFinite(positions[k])) fail('Triangle ' + (Math.floor(k / 9) + 1) + ' has a coordinate that is too large for single precision.');
  }
  const flipped = countFlipped(positions, storedN, n);
  if (flipped) warnings.push(flippedWarning(flipped));
  return positions;
}

/**
 * Reads a binary or ASCII STL file.
 * Returns { positions: Float32Array (9 per triangle, file units), nTri, format: 'stl-binary' | 'stl-ascii', warnings }.
 * Throws RangeError with a readable message for empty, truncated, non-STL or non-finite data.
 */
export function parseSTL(arrayBuffer) {
  let buf = arrayBuffer;
  if (ArrayBuffer.isView(buf)) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (!(buf instanceof ArrayBuffer) && !(buf && typeof buf.byteLength === 'number' && typeof buf.slice === 'function')) {
    fail('The STL data must be an ArrayBuffer.');
  }
  const size = buf.byteLength;
  if (size === 0) fail('The STL file is empty.');
  const bytes = new Uint8Array(buf);
  const warnings = [];
  const nBin = size >= HEADER_BYTES + 4 ? new DataView(buf).getUint32(HEADER_BYTES, true) : -1;
  const expected = nBin >= 0 ? HEADER_BYTES + 4 + RECORD_BYTES * nBin : -1;
  let positions, format;
  if (nBin >= 0 && size === expected) {
    if (nBin === 0) fail('The STL file contains no triangles.');
    positions = parseBinary(buf, nBin, warnings);
    format = 'stl-binary';
  } else if (startsWithSolid(bytes) && !looksBinary(bytes, 0, 4096)) {
    positions = parseAscii(decodeText(bytes), warnings);
    format = 'stl-ascii';
  } else if (nBin > 0 && size > expected) {
    warnings.push('The file has ' + (size - expected) + ' extra bytes after the last triangle; they were ignored.');
    positions = parseBinary(buf, nBin, warnings);
    format = 'stl-binary';
  } else if (nBin >= 0 && size < expected) {
    if (!looksBinary(bytes, 0, 4096)) fail('This is not an STL file (it is text, but it does not start with "solid").');
    fail('The STL file is truncated: its header announces ' + nBin + ' triangles (' + expected + ' bytes), but the file has '
      + size + ' bytes.');
  } else if (nBin === 0) {
    fail('The STL file contains no triangles.');
  } else {
    fail('This is not an STL file (it is too short and does not start with "solid").');
  }
  const nTri = positions.length / 9;
  if (!nTri) fail('The STL file contains no triangles.');
  return { positions, nTri, format, warnings };
}

/**
 * Writes a binary STL (little-endian) from positions (9 numbers per triangle). The stored normal of each facet is
 * the unit normal of its vertex order (zero for a degenerate triangle). The header text is cut to 80 bytes; a
 * header starting with "solid" is prefixed with a space, so readers do not take the file for ASCII.
 */
export function writeBinarySTL(positions, header = 'cdfoley.com conductance') {
  const n = Math.floor(positions.length / 9);
  if (n * 9 !== positions.length) fail('The triangle list must have 9 numbers per triangle.');
  const buf = new ArrayBuffer(HEADER_BYTES + 4 + RECORD_BYTES * n);
  const dv = new DataView(buf);
  let h = String(header == null ? '' : header);
  if (/^\s*solid/i.test(h)) h = ' ' + h;
  for (let k = 0; k < HEADER_BYTES; k++) dv.setUint8(k, k < h.length ? (h.charCodeAt(k) & 0x7f) : 32);
  dv.setUint32(HEADER_BYTES, n, true);
  let o = HEADER_BYTES + 4;
  const f = new Float32Array(9);
  for (let t = 0; t < n; t++, o += RECORD_BYTES) {
    for (let k = 0; k < 9; k++) f[k] = positions[9 * t + k];
    const c = triNormal(f, 0);
    const l = Math.hypot(c[0], c[1], c[2]);
    const s = l > 0 ? 1 / l : 0;
    dv.setFloat32(o, c[0] * s, true);
    dv.setFloat32(o + 4, c[1] * s, true);
    dv.setFloat32(o + 8, c[2] * s, true);
    for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + 4 * k, f[k], true);
    dv.setUint16(o + 48, 0, true);
  }
  return buf;
}
