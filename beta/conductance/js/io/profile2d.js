// Axisymmetric 2D profiles (spec §3.6.8, P2): an SVG or DXF drawing of the passage in the (z, r) half-plane (z the
// flow axis, r ≥ 0 the radius) becomes a Components item list: constant-radius stretches are tubes, sloped ones
// cones, stretches over a rod of constant radius annuli, and a down-step followed at once by an up-step (a plate of
// zero thickness) a thin orifice. Steps in radius need no item (the network and the chain handle contractions and
// expansions). Our own small readers: SVG elements path (M L H V Z C S Q T A, absolute and relative), polyline,
// polygon, line and rect, with transforms; DXF entities LINE, LWPOLYLINE (with bulges), POLYLINE/VERTEX and ARC,
// with $INSUNITS. Curves are flattened to chords that turn by at most 0.5°.
// Pure module: no DOM; runs in the page, in workers and in Node (H7, H8).

const DEG = Math.PI / 180;
const MAX_TURN = 0.5 * DEG;
export const PROFILE_REFUSAL = 'This profile is not a simple axisymmetric passage; export the 3D model as STL instead.';

function fail(message) { throw new RangeError(message); }
const refuse = () => fail(PROFILE_REFUSAL);

// ---------------------------------------------------------------- SVG

const NUM_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

function numbers(s) { return (String(s || '').match(NUM_RE) || []).map(Number); }

function attrs(src) {
  const out = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  // style="stroke: …; transform: …" is not used; presentation attributes only
  return out;
}

// 2D affine matrices [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f
const I2 = [1, 0, 0, 1, 0, 0];
function mul(m, n) {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
function parseTransform(s) {
  let m = I2.slice();
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(s))) {
    const v = numbers(t[2]);
    let n = I2;
    switch (t[1]) {
      case 'matrix': if (v.length === 6) n = v; break;
      case 'translate': n = [1, 0, 0, 1, v[0] || 0, v[1] || 0]; break;
      case 'scale': n = [v[0] ?? 1, 0, 0, v.length > 1 ? v[1] : (v[0] ?? 1), 0, 0]; break;
      case 'rotate': {
        const a = (v[0] || 0) * DEG, c = Math.cos(a), sn = Math.sin(a);
        n = [c, sn, -sn, c, 0, 0];
        if (v.length >= 3) n = mul(mul([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]]);
        break;
      }
      case 'skewX': n = [1, 0, Math.tan((v[0] || 0) * DEG), 1, 0, 0]; break;
      case 'skewY': n = [1, Math.tan((v[0] || 0) * DEG), 0, 1, 0, 0]; break;
      default: break;
    }
    m = mul(m, n);
  }
  return m;
}

// Flattening of Bézier curves by subdivision until neighbouring chords turn by at most 0.5°.
function turn(ax, ay, bx, by, cx, cy) {
  const u = Math.atan2(by - ay, bx - ax), w = Math.atan2(cy - by, cx - bx);
  let d = Math.abs(w - u);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}
function flattenCubic(out, p0, p1, p2, p3, depth = 0) {
  // midpoint split (de Casteljau)
  const m01 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2], m12 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const m23 = [(p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2];
  const a = [(m01[0] + m12[0]) / 2, (m01[1] + m12[1]) / 2], b = [(m12[0] + m23[0]) / 2, (m12[1] + m23[1]) / 2];
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const flat = turn(p0[0], p0[1], mid[0], mid[1], p3[0], p3[1]) <= MAX_TURN
    && turn(p0[0], p0[1], p1[0], p1[1], p3[0], p3[1]) <= MAX_TURN && turn(p0[0], p0[1], p2[0], p2[1], p3[0], p3[1]) <= MAX_TURN;
  if (depth >= 16 || (depth >= 1 && flat)) { out.push(p3[0], p3[1]); return; }
  flattenCubic(out, p0, m01, a, mid, depth + 1);
  flattenCubic(out, mid, b, m23, p3, depth + 1);
}

// SVG elliptical arc (endpoint parameterization → centre parameterization, SVG 1.1 implementation notes F.6.5).
function flattenArc(out, x1, y1, rx, ry, phiDeg, large, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return;
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry) { out.push(x2, y2); return; }
  const phi = phiDeg * DEG, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / MAX_TURN));
  for (let k = 1; k <= n; k++) {
    if (k === n) { out.push(x2, y2); break; }
    const t = t1 + dt * k / n;
    out.push(cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp);
  }
}

// Path data → subpaths (arrays of x, y in user units). A cursor tokenizer: numbers may run together ("1.5.5",
// "1-2"), and arc flags are single characters that may be glued to what follows ("a1 1 0 01 1 1").
const NUM_Y = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const CMD = 'MmLlHhVvZzCcSsQqTtAa';

function pathSubpaths(d) {
  const s = String(d || ''), n = s.length;
  let i = 0;
  const skip = () => { while (i < n) { const c = s.charCodeAt(i); if (c === 32 || c === 44 || (c >= 9 && c <= 13)) i++; else break; } };
  const hasNum = () => { skip(); if (i >= n) return false; const c = s[i]; return (c >= '0' && c <= '9') || c === '.' || c === '-' || c === '+'; };
  const num = () => {
    skip();
    NUM_Y.lastIndex = i;
    const m = NUM_Y.exec(s);
    if (!m) fail('The SVG path data are malformed near "' + s.slice(i, i + 12) + '".');
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = () => {
    skip();
    const c = s[i];
    if (c !== '0' && c !== '1') fail('The SVG arc flags are malformed near "' + s.slice(i, i + 12) + '".');
    i++;
    return c === '1';
  };
  const subs = [];
  let cur = null, x = 0, y = 0, sx = 0, sy = 0, lastC = null, lastQ = null;
  const start = () => { cur = [x, y]; subs.push(cur); };
  const lineTo = () => { if (!cur) start(); else cur.push(x, y); };
  for (;;) {
    skip();
    if (i >= n) break;
    const cmd = s[i];
    if (CMD.indexOf(cmd) < 0) fail('The SVG path data are malformed near "' + s.slice(i, i + 12) + '".');
    i++;
    const rel = cmd >= 'a', C = cmd.toUpperCase();
    if (C === 'Z') {
      if (cur) { cur.push(sx, sy); cur = null; }
      x = sx; y = sy; lastC = lastQ = null;
      continue;
    }
    let first = true;
    do {
      const ox = rel ? x : 0, oy = rel ? y : 0;
      switch (C) {
        case 'M':
          x = ox + num(); y = oy + num();
          if (first) { sx = x; sy = y; start(); } else lineTo();
          lastC = lastQ = null;
          break;
        case 'L': x = ox + num(); y = oy + num(); lineTo(); lastC = lastQ = null; break;
        case 'H': x = ox + num(); lineTo(); lastC = lastQ = null; break;
        case 'V': y = oy + num(); lineTo(); lastC = lastQ = null; break;
        case 'C': case 'S': {
          let c1;
          if (C === 'C') c1 = [ox + num(), oy + num()];
          else c1 = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y];
          const c2 = [ox + num(), oy + num()], p = [ox + num(), oy + num()];
          if (!cur) start();
          flattenCubic(cur, [x, y], c1, c2, p);
          lastC = c2; lastQ = null; x = p[0]; y = p[1];
          break;
        }
        case 'Q': case 'T': {
          let q;
          if (C === 'Q') q = [ox + num(), oy + num()];
          else q = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
          const p = [ox + num(), oy + num()];
          if (!cur) start();
          flattenCubic(cur, [x, y], [x + 2 / 3 * (q[0] - x), y + 2 / 3 * (q[1] - y)], [p[0] + 2 / 3 * (q[0] - p[0]), p[1] + 2 / 3 * (q[1] - p[1])], p);
          lastQ = q; lastC = null; x = p[0]; y = p[1];
          break;
        }
        case 'A': {
          const rx = num(), ry = num(), phi = num(), large = flag(), sweep = flag();
          const p = [ox + num(), oy + num()];
          if (!cur) start();
          flattenArc(cur, x, y, rx, ry, phi, large, sweep, p[0], p[1]);
          x = p[0]; y = p[1];
          lastC = lastQ = null;
          break;
        }
        default: break;
      }
      first = false;
    } while (hasNum());
  }
  return subs.filter((sp) => sp.length >= 4);
}

const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96 };

function parseLength(s) {
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(String(s || ''));
  if (!m) return null;
  return { v: Number(m[1]), unit: m[2].toLowerCase() };
}

/**
 * Reads an SVG drawing of an axisymmetric profile. Returns { paths: Float64Array[] (z, r pairs: z = x, r = −y, so
 * up on screen is +r), unitHint: 'mm' | 'in' | null, warnings }. With width and height in absolute units and a
 * viewBox, user units are converted to millimetres (mm, cm) or inches (in, pt, pc, px); otherwise the paths stay
 * in user units and unitHint is null.
 */
export function parseSVGProfile(text) {
  if (typeof text !== 'string') fail('The SVG file could not be read as text.');
  const src = text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ').replace(/<\?[\s\S]*?\?>/g, ' ').replace(/<!DOCTYPE[^>]*>/gi, ' ');
  const tagRe = /<\s*(\/?)\s*([a-zA-Z][\w:.-]*)([^>]*?)(\/?)\s*>/g;
  const warnings = [];
  const raw = [];
  const stack = [I2];
  let root = null, m, skipped = 0;
  while ((m = tagRe.exec(src))) {
    const closing = m[1] === '/', name = m[2].toLowerCase().replace(/^svg:/, ''), a = closing ? null : attrs(m[3]), selfClosing = m[4] === '/';
    const group = name === 'g' || name === 'svg' || name === 'a' || name === 'symbol' || name === 'defs' || name === 'clippath' || name === 'mask' || name === 'pattern' || name === 'marker';
    if (closing) { if (group && stack.length > 1) stack.pop(); continue; }
    const parent = stack[stack.length - 1];
    if (parent === null) { if (group && !selfClosing) stack.push(null); continue; }   // inside <defs>, <symbol>, …
    const M = mul(parent, parseTransform(a.transform));
    if (name === 'svg') {
      if (!root) root = a;
      if (!selfClosing) stack.push(M);
      continue;
    }
    if (group) { if (!selfClosing) stack.push(name === 'g' || name === 'a' ? M : null); continue; }
    let subs = [];
    if (name === 'path') subs = pathSubpaths(a.d || '');
    else if (name === 'polyline' || name === 'polygon') {
      const v = numbers(a.points);
      if (v.length >= 4) { const s = v.slice(0, v.length - (v.length % 2)); if (name === 'polygon') s.push(s[0], s[1]); subs = [s]; }
    } else if (name === 'line') subs = [[+a.x1 || 0, +a.y1 || 0, +a.x2 || 0, +a.y2 || 0]];
    else if (name === 'rect') {
      const x = +a.x || 0, y = +a.y || 0, w = +a.width || 0, h = +a.height || 0;
      if (w > 0 && h > 0) subs = [[x, y, x + w, y, x + w, y + h, x, y + h, x, y]];
    } else if (name === 'circle' || name === 'ellipse' || name === 'text' || name === 'image') { skipped++; continue; }
    else continue;
    for (const s of subs) {
      const out = new Float64Array(s.length);
      for (let k = 0; k < s.length; k += 2) { out[k] = M[0] * s[k] + M[2] * s[k + 1] + M[4]; out[k + 1] = M[1] * s[k] + M[3] * s[k + 1] + M[5]; }
      raw.push(out);
    }
  }
  if (!root) fail('This is not an SVG file (it has no <svg> element).');
  if (skipped) warnings.push(skipped + (skipped === 1 ? ' circle, ellipse, text or image was' : ' circles, ellipses, texts or images were') + ' ignored.');
  // units: width/height in absolute units with a viewBox
  let unitHint = null, f = 1;
  const vb = numbers(root.viewbox);
  const W = parseLength(root.width), H = parseLength(root.height);
  if (vb.length === 4 && vb[2] > 0 && W && UNIT_MM[W.unit] !== undefined && W.v > 0) {
    const mmPerUser = W.v * UNIT_MM[W.unit] / vb[2];
    if (H && UNIT_MM[H.unit] !== undefined && vb[3] > 0) {
      const mmPerUserY = H.v * UNIT_MM[H.unit] / vb[3];
      if (Math.abs(mmPerUserY / mmPerUser - 1) > 1e-6) warnings.push('The drawing is scaled differently across and down; the horizontal scale is used.');
    }
    if (W.unit === 'mm' || W.unit === 'cm') { unitHint = 'mm'; f = mmPerUser; } else { unitHint = 'in'; f = mmPerUser / 25.4; }
  }
  const paths = raw.filter((p) => p.length >= 4).map((p) => {
    const out = new Float64Array(p.length);
    for (let k = 0; k < p.length; k += 2) { out[k] = p[k] * f; out[k + 1] = -p[k + 1] * f + 0; }
    return out;
  });
  if (!paths.length) fail('The SVG drawing contains no lines or paths.');
  return { paths, unitHint, warnings };
}

// ---------------------------------------------------------------- DXF

function flattenBulge(out, x1, y1, x2, y2, bulge) {
  if (!bulge) { out.push(x2, y2); return; }
  const theta = 4 * Math.atan(bulge);                     // included angle, positive = counterclockwise
  const c = Math.hypot(x2 - x1, y2 - y1);
  if (!(c > 0)) return;
  const r = c / (2 * Math.sin(Math.abs(theta) / 2));
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const h = r * Math.cos(Math.abs(theta) / 2);            // negative for an arc longer than a half circle
  // centre lies to the left of the chord for a counterclockwise arc
  const ux = (x2 - x1) / c, uy = (y2 - y1) / c;
  const s = theta > 0 ? 1 : -1;
  const cx = mx - s * uy * h, cy = my + s * ux * h;
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  const n = Math.max(1, Math.ceil(Math.abs(theta) / MAX_TURN));
  for (let k = 1; k <= n; k++) {
    if (k === n) { out.push(x2, y2); break; }
    const a = a1 + theta * k / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}

/**
 * Reads an ASCII DXF drawing of an axisymmetric profile: LINE, LWPOLYLINE (bulges), POLYLINE/VERTEX and ARC in the
 * ENTITIES section. Returns { paths: Float64Array[] (z = x, r = y), unitHint: 'mm' | 'in' | null, warnings };
 * $INSUNITS 4 (mm), 5 (cm, converted to mm), 6 (m, converted to mm) and 1 (in) set the unit.
 */
export function parseDXFProfile(text) {
  if (typeof text !== 'string') fail('The DXF file could not be read as text.');
  const lines = text.split(/\r\n|\n|\r/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(code)) {
      if (lines[i].trim() === '' && i + 1 >= lines.length - 1) break;
      fail('The DXF file is malformed at line ' + (i + 1) + ' (a group code was expected).');
    }
    pairs.push([code, lines[i + 1].trim()]);
  }
  if (!pairs.some((p) => p[0] === 0 && p[1] === 'SECTION')) fail('This is not an ASCII DXF file (it has no SECTION).');
  const warnings = [];
  let insunits = 0, section = null;
  const ents = [];
  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 0 && v === 'SECTION') { const n = pairs[i + 1]; section = n && n[0] === 2 ? n[1] : null; i++; continue; }
    if (c === 0 && v === 'ENDSEC') { section = null; continue; }
    if (section === 'HEADER' && c === 9 && v === '$INSUNITS') {
      const n = pairs[i + 1];
      if (n && n[0] === 70) insunits = parseInt(n[1], 10) || 0;
      continue;
    }
    if (section === 'ENTITIES' && c === 0) {
      const e = { type: v, g: [] };
      for (let j = i + 1; j < pairs.length && pairs[j][0] !== 0; j++) e.g.push(pairs[j]);
      ents.push(e);
    }
  }
  const val = (e, code, dflt = 0) => { const p = e.g.find((q) => q[0] === code); return p ? Number(p[1]) : dflt; };
  const paths = [], ignored = {};
  for (let k = 0; k < ents.length; k++) {
    const e = ents[k];
    if (e.type === 'LINE') {
      paths.push([val(e, 10), val(e, 20), val(e, 11), val(e, 21)]);
    } else if (e.type === 'LWPOLYLINE') {
      const verts = [];
      for (const [c, v] of e.g) {
        if (c === 10) verts.push({ x: Number(v), y: 0, b: 0 });
        else if (c === 20 && verts.length) verts[verts.length - 1].y = Number(v);
        else if (c === 42 && verts.length) verts[verts.length - 1].b = Number(v);
      }
      const closed = (val(e, 70) & 1) === 1;
      if (verts.length >= 2) {
        const out = [verts[0].x, verts[0].y];
        const n = closed ? verts.length : verts.length - 1;
        for (let j = 0; j < n; j++) { const a = verts[j], b = verts[(j + 1) % verts.length]; flattenBulge(out, a.x, a.y, b.x, b.y, a.b); }
        paths.push(out);
      }
    } else if (e.type === 'POLYLINE') {
      const closed = (val(e, 70) & 1) === 1, verts = [];
      while (k + 1 < ents.length && ents[k + 1].type === 'VERTEX') { k++; verts.push({ x: val(ents[k], 10), y: val(ents[k], 20), b: val(ents[k], 42) }); }
      if (k + 1 < ents.length && ents[k + 1].type === 'SEQEND') k++;
      if (verts.length >= 2) {
        const out = [verts[0].x, verts[0].y];
        const n = closed ? verts.length : verts.length - 1;
        for (let j = 0; j < n; j++) { const a = verts[j], b = verts[(j + 1) % verts.length]; flattenBulge(out, a.x, a.y, b.x, b.y, a.b); }
        paths.push(out);
      }
    } else if (e.type === 'ARC') {
      const cx = val(e, 10), cy = val(e, 20), r = val(e, 40), a0 = val(e, 50) * DEG;
      let a1 = val(e, 51) * DEG;
      while (a1 <= a0) a1 += 2 * Math.PI;
      const n = Math.max(1, Math.ceil((a1 - a0) / MAX_TURN)), out = [];
      for (let j = 0; j <= n; j++) { const a = a0 + (a1 - a0) * j / n; out.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
      if (r > 0) paths.push(out);
    } else if (e.type !== 'VERTEX' && e.type !== 'SEQEND') {
      ignored[e.type] = (ignored[e.type] || 0) + 1;
    }
  }
  const names = Object.keys(ignored).filter((t) => !['POINT', 'TEXT', 'MTEXT', 'DIMENSION', 'HATCH', 'VIEWPORT', 'ATTRIB', 'ATTDEF'].includes(t));
  if (names.length) warnings.push('Ignored ' + names.map((t) => ignored[t] + ' ' + t).join(', ') + '.');
  let unitHint = null, f = 1;
  if (insunits === 1) unitHint = 'in';
  else if (insunits === 4) unitHint = 'mm';
  else if (insunits === 5) { unitHint = 'mm'; f = 10; }
  else if (insunits === 6) { unitHint = 'mm'; f = 1000; }
  else if (insunits !== 0) warnings.push('The drawing unit ($INSUNITS = ' + insunits + ') is not supported; pick the unit.');
  const out = paths.filter((p) => p.length >= 4 && p.every(Number.isFinite)).map((p) => Float64Array.from(p, (x) => x * f));
  if (!out.length) fail('The DXF drawing contains no lines, polylines or arcs.');
  return { paths: out, unitHint, warnings };
}

// ---------------------------------------------------------------- profile → items

const round = (x) => Number(x.toPrecision(10));

/**
 * Converts profile paths (z, r pairs in file units) into Components items (SI): { items, lathe }.
 *   scale: metres per file unit; axis: 'min' (the axis is the lowest r in the drawing) or 'zero' (the axis is r = 0).
 *   lathe: Float64Array of (r, z) pairs in metres for display, z from the inlet: the outer wall from the inlet to
 *          the outlet, then, after a (NaN, NaN) separator, each inner body.
 * The axis line and the end faces (vertical lines at the first and last z) are the openings and are dropped. The
 * rest must be one outer wall running from the inlet to the outlet without turning back in z, plus optional inner
 * bodies (rods) of constant radius. A plate of zero thickness may be drawn inside the wall's polyline (down and
 * straight back up) or as a single vertical line hanging from the wall. Anything else throws
 * RangeError(PROFILE_REFUSAL).
 */
export function profileToItems(paths, { scale, axis }) {
  if (!Array.isArray(paths) || !paths.length) fail('The profile has no lines.');
  if (!(Number.isFinite(scale) && scale > 0)) fail('Pick the unit of the drawing.');
  const mode = axis === 'zero' ? 'zero' : 'min';
  let zMin = Infinity, zMax = -Infinity, rMin = Infinity, rMax = -Infinity;
  for (const p of paths) {
    for (let k = 0; k + 1 < p.length; k += 2) {
      if (!(Number.isFinite(p[k]) && Number.isFinite(p[k + 1]))) fail('The profile has a point that is not a finite number.');
      zMin = Math.min(zMin, p[k]); zMax = Math.max(zMax, p[k]); rMin = Math.min(rMin, p[k + 1]); rMax = Math.max(rMax, p[k + 1]);
    }
  }
  const ext = Math.max(zMax - zMin, rMax - rMin);
  if (!(ext > 0)) refuse();
  const tol = 1e-6 * ext;
  const near = (x, y) => Math.abs(x - y) <= tol;
  let r0 = 0, sgn = 1;
  if (mode === 'min') r0 = rMin;
  else if (rMin < -tol && rMax > tol) refuse();               // drawn on both sides of the axis
  else if (rMax <= tol) sgn = -1;                             // drawn below the axis
  const polys = paths.map((p) => {
    const q = [];
    for (let k = 0; k + 1 < p.length; k += 2) {
      const pt = [p[k], sgn * p[k + 1] - r0];
      if (pt[1] < 0 && pt[1] > -tol) pt[1] = 0;
      const last = q[q.length - 1];
      if (!last || Math.hypot(pt[0] - last[0], pt[1] - last[1]) > tol) q.push(pt);
    }
    return q;
  });
  const onAxis = (a, b) => a[1] <= tol && b[1] <= tol;
  let z0 = Infinity, z1 = -Infinity;
  for (const q of polys) for (let k = 1; k < q.length; k++) if (!onAxis(q[k - 1], q[k])) { z0 = Math.min(z0, q[k - 1][0], q[k][0]); z1 = Math.max(z1, q[k - 1][0], q[k][0]); }
  if (!(z1 - z0 > tol)) refuse();
  const endFace = (a, b) => near(a[0], b[0]) && (near(a[0], z0) || near(a[0], z1));
  // pieces: the polylines with the axis and the end faces cut out (each keeps its own order)
  let pieces = [];
  for (const q of polys) {
    let cur = [];
    for (let k = 1; k < q.length; k++) {
      const a = q[k - 1], b = q[k];
      if (onAxis(a, b) || endFace(a, b)) { if (cur.length >= 2) pieces.push(cur); cur = []; continue; }
      if (!cur.length) cur.push(a);
      cur.push(b);
    }
    if (cur.length >= 2) pieces.push(cur);
  }
  if (!pieces.length) refuse();
  const key = (p) => Math.round(p[0] / tol) + ',' + Math.round(p[1] / tol);
  const isVertical = (pc) => pc.every((p) => near(p[0], pc[0][0]));
  // the same vertical line drawn twice (down and back up) counts once
  const sig = (pc) => [key(pc[0]), key(pc[pc.length - 1])].sort().join('|');
  const seen = new Set();
  pieces = pieces.filter((pc) => { if (!isVertical(pc) || pc.length !== 2) return true; const s = sig(pc); if (seen.has(s)) return false; seen.add(s); return true; });
  const degree = () => {
    const d = new Map();
    for (const pc of pieces) for (const e of [pc[0], pc[pc.length - 1]]) { const k = key(e); d.set(k, (d.get(k) || 0) + 1); }
    return d;
  };
  // plates drawn as one vertical line hanging from a wall vertex: one free end (below), one on a junction of three
  const plates = [];                                                   // { z, r } of zero-thickness plates
  {
    const d = degree();
    pieces = pieces.filter((pc) => {
      if (!isVertical(pc)) return true;
      const a = pc[0], b = pc[pc.length - 1], lo = a[1] < b[1] ? a : b, hi = lo === a ? b : a;
      if (d.get(key(lo)) === 1 && d.get(key(hi)) === 3) { plates.push({ z: hi[0], r: lo[1] }); return false; }
      return true;
    });
  }
  // join pieces end to end where exactly two ends meet
  const d = degree();
  for (const v of d.values()) if (v > 2) refuse();                 // a branch or a crossing
  const used = new Uint8Array(pieces.length), chains = [];
  const ends = new Map();
  pieces.forEach((pc, i) => { for (const e of [0, 1]) { const k = key(e ? pc[pc.length - 1] : pc[0]); if (!ends.has(k)) ends.set(k, []); ends.get(k).push([i, e]); } });
  const extend = (chain, atEndKey) => {
    for (;;) {
      const nxt = (ends.get(atEndKey) || []).find(([j]) => !used[j]);
      if (!nxt) return chain;
      const [j, e] = nxt;
      used[j] = 1;
      const pc = e === 0 ? pieces[j] : pieces[j].slice().reverse();
      for (let k = 1; k < pc.length; k++) chain.push(pc[k]);
      atEndKey = key(pc[pc.length - 1]);
    }
  };
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const fwd = extend(pieces[i].slice(), key(pieces[i][pieces[i].length - 1]));
    const back = extend([pieces[i][0]], key(pieces[i][0]));
    chains.push([...back.slice(1).reverse(), ...fwd]);
  }
  // the outer wall: the chain that reaches the largest radius, oriented from the inlet to the outlet
  const maxR = (c) => c.reduce((m, p) => Math.max(m, p[1]), -Infinity);
  let wi = 0;
  chains.forEach((c, k) => { if (maxR(c) > maxR(chains[wi])) wi = k; });
  let wall = chains[wi];
  if (wall[0][0] > wall[wall.length - 1][0]) wall = wall.slice().reverse();
  for (let k = 1; k < wall.length; k++) if (wall[k][0] < wall[k - 1][0] - tol) refuse();   // doubles back in z
  if (!near(wall[0][0], z0) || !near(wall[wall.length - 1][0], z1)) refuse();
  for (const p of wall) if (!(p[1] > tol)) refuse();
  // lines hanging from the middle of a wall segment are plates too; any other purely vertical line is refused
  const onWall = (p) => {
    for (let k = 1; k < wall.length; k++) {
      const a = wall[k - 1], b = wall[k];
      if (b[0] - a[0] > tol && p[0] >= a[0] - tol && p[0] <= b[0] + tol && near(a[1] + (b[1] - a[1]) * (p[0] - a[0]) / (b[0] - a[0]), p[1])) return true;
    }
    return wall.some((q) => near(q[0], p[0]) && near(q[1], p[1]));
  };
  const innerChains = [];
  chains.forEach((c, k) => {
    if (k === wi) return;
    if (c.every((p) => near(p[0], c[0][0]))) {
      const lo = c.reduce((m, p) => (p[1] < m[1] ? p : m), c[0]), hi = c.reduce((m, p) => (p[1] > m[1] ? p : m), c[0]);
      if (!onWall(hi)) refuse();
      plates.push({ z: hi[0], r: lo[1] });
      return;
    }
    innerChains.push(c[0][0] > c[c.length - 1][0] ? c.slice().reverse() : c);
  });
  // inner bodies: horizontal stretches joined by vertical steps
  const inner = [];
  for (const c of innerChains) {
    for (let k = 1; k < c.length; k++) {
      const a = c[k - 1], b = c[k];
      if (b[0] < a[0] - tol) refuse();
      if (near(a[0], b[0])) continue;
      if (!near(a[1], b[1])) refuse();                                // a sloped inner body
      inner.push({ za: a[0], zb: b[0], r: (a[1] + b[1]) / 2 });
    }
  }
  inner.sort((p, q) => p.za - q.za);
  for (let k = 1; k < inner.length; k++) if (inner[k].za < inner[k - 1].zb - tol) refuse();
  const rodAt = (z) => { for (const s of inner) if (z > s.za + tol && z < s.zb - tol) return s.r; return 0; };
  const wallAt = (z) => {
    let best = NaN;
    for (let k = 1; k < wall.length; k++) {
      const a = wall[k - 1], b = wall[k];
      if (b[0] - a[0] > tol && z >= a[0] - tol && z <= b[0] + tol) { const r = a[1] + (b[1] - a[1]) * (z - a[0]) / (b[0] - a[0]); if (!(r >= best)) best = r; }
    }
    return best;
  };
  for (const s of inner) if (!(s.r < wallAt((s.za + s.zb) / 2) - tol)) refuse();
  plates.sort((p, q) => p.z - q.z);
  for (const pl of plates) if (!(pl.r > tol) || rodAt(pl.z) > 0) refuse();
  const cuts = [...inner.flatMap((s) => [s.za, s.zb]), ...plates.map((pl) => pl.z)];

  // walk the wall
  const items = [];
  const push = (it) => {
    const last = items[items.length - 1];
    if (last && last.t === it.t) {
      if (it.t === 'tube' && near(last.d, it.d)) { last.L += it.L; return; }
      if (it.t === 'annulus' && near(last.do, it.do) && near(last.di, it.di)) { last.L += it.L; return; }
      if (it.t === 'cone' && near(last.d2, it.d1) && Math.abs((last.d2 - last.d1) / last.L - (it.d2 - it.d1) / it.L) <= 1e-6) {
        last.d2 = it.d2; last.L += it.L; return;
      }
    }
    items.push(it);
  };
  let pi = 0;
  const platesUpTo = (z) => { while (pi < plates.length && plates[pi].z <= z + tol) push({ t: 'orifice', shape: 'circle', d: 2 * plates[pi++].r }); };
  for (let k = 1; k < wall.length; k++) {
    const a = wall[k - 1], b = wall[k];
    if (b[0] - a[0] <= tol) {
      // a down-step followed at once by an up-step at the same z is a plate of zero thickness
      const c = wall[k + 1];
      if (c && c[0] - b[0] <= tol && b[1] < a[1] - tol && c[1] > b[1] + tol) {
        if (rodAt(b[0]) > 0) refuse();
        push({ t: 'orifice', shape: 'circle', d: 2 * b[1] });
      }
      continue;
    }
    const zs = [a[0], ...cuts.filter((z) => z > a[0] + tol && z < b[0] - tol).sort((p, q) => p - q), b[0]];
    for (let j = 1; j < zs.length; j++) {
      const za = zs[j - 1], zb = zs[j], L = zb - za;
      platesUpTo(za);
      if (L <= tol) continue;
      const ra = a[1] + (b[1] - a[1]) * (za - a[0]) / (b[0] - a[0]), rb = a[1] + (b[1] - a[1]) * (zb - a[0]) / (b[0] - a[0]);
      const ri = rodAt((za + zb) / 2);
      if (near(ra, rb)) {
        const r = (ra + rb) / 2;
        if (ri > 0) push({ t: 'annulus', di: 2 * ri, do: 2 * r, L }); else push({ t: 'tube', d: 2 * r, L });
      } else {
        if (ri > 0) refuse();                                         // a sloped wall over a rod has no element
        push({ t: 'cone', d1: 2 * ra, d2: 2 * rb, L });
      }
    }
  }
  platesUpTo(z1);
  if (!items.length || pi < plates.length) refuse();
  const S = (x) => round(x * scale);
  const out = items.map((it) => {
    if (it.t === 'tube') return { t: 'tube', d: S(it.d), L: S(it.L) };
    if (it.t === 'cone') return { t: 'cone', d1: S(it.d1), d2: S(it.d2), L: S(it.L) };
    if (it.t === 'annulus') return { t: 'annulus', di: S(it.di), do: S(it.do), L: S(it.L) };
    return { t: 'orifice', shape: 'circle', d: S(it.d) };
  });
  const lathe = [];
  for (const p of wall) lathe.push(p[1] * scale, (p[0] - z0) * scale);
  for (const c of innerChains) { lathe.push(NaN, NaN); for (const p of c) lathe.push(p[1] * scale, (p[0] - z0) * scale); }
  return { items: out, lathe: Float64Array.from(lathe) };
}
