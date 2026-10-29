// Wavefront OBJ reading (spec §2.16; research §4). Reads `v` and `f` statements: faces may be polygons (split into
// fans), use negative (relative) indices, and the v, v/vt, v//vn and v/vt/vn forms. `g` and `o` statements start
// groups; comments, blank lines, line continuations (a trailing backslash) and other statements (vt, vn, s,
// usemtl, mtllib, ...) are accepted. Point and line elements (p, l) are ignored with a warning. Positions are in
// file units (OBJ carries no unit).
// Pure module: no DOM; runs in the page, in workers and in Node (H7, H8).

function fail(message) { throw new RangeError(message); }

/**
 * Parses OBJ text. Returns { positions: Float32Array (9 per triangle, file units), nTri,
 * groups: [{ name, start, count }] (triangle ranges), warnings }.
 * Throws RangeError with the line number for a malformed vertex or face index.
 */
export function parseOBJ(text) {
  if (typeof text !== 'string') {
    if (text && (text instanceof ArrayBuffer || ArrayBuffer.isView(text))) {
      const bytes = text instanceof ArrayBuffer ? new Uint8Array(text) : new Uint8Array(text.buffer, text.byteOffset, text.byteLength);
      text = new TextDecoder('utf-8').decode(bytes);
    } else fail('The OBJ data must be text.');
  }
  const verts = [];               // x, y, z
  const faces = [];               // flat list of absolute (1-based) vertex indices, -1 terminated
  const faceLine = [];            // line number per face (for messages)
  const groups = [];
  const warnings = [];
  let group = null, nTri = 0, skippedElems = 0, nonTriFaces = 0;
  const startGroup = (name) => {
    if (group && group.count === 0) groups.pop();
    group = { name, start: nTri, count: 0 };
    groups.push(group);
  };
  const lines = text.split(/\r\n|\n|\r/);
  for (let li = 0; li < lines.length; li++) {
    let s = lines[li];
    const lineNo = li + 1;
    // line continuation
    while (/\\\s*$/.test(s) && li + 1 < lines.length) { s = s.replace(/\\\s*$/, ' ') + lines[++li]; }
    const hash = s.indexOf('#');
    if (hash >= 0) s = s.slice(0, hash);
    s = s.trim();
    if (!s) continue;
    const parts = s.split(/\s+/);
    const kw = parts[0];
    if (kw === 'v') {
      if (parts.length < 4) fail('Line ' + lineNo + ': a vertex needs three coordinates.');
      for (let k = 1; k <= 3; k++) {
        const x = Number(parts[k]);
        if (!Number.isFinite(x)) fail('Line ' + lineNo + ': "' + parts[k].slice(0, 20) + '" is not a valid coordinate.');
        verts.push(x);
      }
    } else if (kw === 'f' || kw === 'fo') {
      const nv = parts.length - 1;
      if (nv < 3) fail('Line ' + lineNo + ': a face needs at least three vertices.');
      const current = verts.length / 3;
      for (let k = 1; k <= nv; k++) {
        const tok = parts[k];
        const slash = tok.indexOf('/');
        const vs = slash >= 0 ? tok.slice(0, slash) : tok;
        if (!/^[+-]?\d+$/.test(vs)) fail('Line ' + lineNo + ': "' + tok.slice(0, 20) + '" is not a valid face index.');
        let idx = parseInt(vs, 10);
        if (idx === 0) fail('Line ' + lineNo + ': face index 0 is not valid (OBJ indices start at 1).');
        if (idx < 0) {
          const abs = current + 1 + idx;
          if (abs < 1) fail('Line ' + lineNo + ': face index ' + idx + ' refers to a vertex before the first one (only ' + current + ' defined so far).');
          idx = abs;
        }
        faces.push(idx);
      }
      faces.push(-1);
      faceLine.push(lineNo);
      if (!group) startGroup('default');
      group.count += nv - 2;
      nTri += nv - 2;
      if (nv > 3) nonTriFaces++;
    } else if (kw === 'g' || kw === 'o') {
      startGroup(parts.slice(1).join(' ') || (kw === 'g' ? 'group' : 'object'));
    } else if (kw === 'p' || kw === 'l') {
      skippedElems++;
    }
    // vt, vn, vp, s, usemtl, mtllib, cstype, ... are ignored
  }
  if (group && group.count === 0) groups.pop();
  const nV = verts.length / 3;
  if (!nTri) fail(nV ? 'The OBJ file has vertices but no faces.' : 'The OBJ file contains no faces.');
  const positions = new Float32Array(9 * nTri);
  let o = 0, f = 0, poly = [];
  for (let k = 0; k < faces.length; k++) {
    const idx = faces[k];
    if (idx !== -1) {
      if (idx > nV) fail('Line ' + faceLine[f] + ': face index ' + idx + ' refers to a vertex that does not exist (the file has ' + nV + ' vertices).');
      poly.push(idx - 1);
      continue;
    }
    for (let j = 1; j + 1 < poly.length; j++) {
      for (const v of [poly[0], poly[j], poly[j + 1]]) {
        positions[o++] = verts[3 * v]; positions[o++] = verts[3 * v + 1]; positions[o++] = verts[3 * v + 2];
      }
    }
    poly = [];
    f++;
  }
  for (let k = 0; k < positions.length; k++) {
    if (!Number.isFinite(positions[k])) fail('A vertex coordinate is too large for single precision.');
  }
  if (nonTriFaces) warnings.push(nonTriFaces + (nonTriFaces === 1 ? ' polygon was' : ' polygons were') + ' split into triangles (fans).');
  if (skippedElems) warnings.push(skippedElems + (skippedElems === 1 ? ' point or line element was' : ' point or line elements were') + ' ignored.');
  return { positions, nTri, groups, warnings };
}
