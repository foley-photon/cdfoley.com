/* ==========================================================================
   Ion optics engine: io.js
   CSV export of runs, share-link codec and project-file text.

   - CSV: RFC 4180 (Shafranovich, IETF RFC 4180 (2005)): CRLF line ends,
     fields with commas, quotes or line breaks quoted, quotes doubled; '.'
     decimals; numbers with 10 significant digits (float32 trajectory data:
     the shortest decimal that round-trips to the stored float32).
   - Particle lists: particlesToCSV / parseParticlesCSV read and write the
     rows of a 'rows' source at full precision (shortest round-trip decimals),
     in the direction + kinetic-energy form or the velocity form, and accept
     this tool's hits table as end states.
   - Share links: '#p=' + base64url(deflate-raw(canonical JSON)) with the
     DEFLATE format of Deutsch, IETF RFC 1951 (1996), and base64url of
     Josefsson, IETF RFC 4648 §5 (2006); '#pj=' + base64url(JSON) where
     CompressionStream is unavailable. Links are data only: decoded size is
     capped at 64 kB, the JSON is validated, and run sizes are clamped.
   ========================================================================== */
import {
    S_STRIDE, S_ID, S_STATUS, S_WHERE, S_T, S_X, S_Y, S_Z, S_VX, S_VY, S_VZ, S_KE, S_TOF, S_STEPS, S_PATH,
    S_DE_END, S_DE_MAX, S_WORK, S_SRC, S_SPECIES, S_KE0, S_T0,
    C_STRIDE, C_ID, C_PLANE, C_T, C_X, C_Y, C_Z, C_VX, C_VY, C_VZ, C_KE, C_DIR, C_K, C_KIND, C_ELEC,
    P_STRIDE, P_MASS, P_CHARGE, P_X, P_Y, P_Z, STATUS,
} from './layout.js';
import { generate } from './particles.js';
import { canonicalJSON } from './hash.js';
import { EngineError, migrate, validate, LIMITS, isProjectLike } from './schema.js';
import { C_MMUS, K_ACC, UC2_EV, speedFromKE } from './constants.js';

// ======================================================================== CSV

function fmtNum(v) {
    if (typeof v !== 'number') return v === null || v === undefined ? '' : String(v);
    if (v !== v) return '';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
    return String(+v.toPrecision(10));
}
function fmtF32(v) {
    if (v !== v) return '';
    if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
    if (Number.isInteger(v) && Math.abs(v) < 1e7) return String(v);
    for (let p = 6; p <= 9; p++) {
        const s = +v.toPrecision(p);
        if (Math.fround(s) === v) return String(s);
    }
    return String(v);
}
/** Text that a spreadsheet would read as a formula (=, +, -, @, tab or CR first) gets a leading ' (OWASP CSV-injection advice). */
export function neutralizeFormula(s) {
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}
function quote(s) {
    s = neutralizeFormula(s);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function field(v) {
    return typeof v === 'number' ? fmtNum(v) : quote(v === null || v === undefined ? '' : String(v));
}

/**
 * RFC 4180 CSV text: one header line and one line per row; numbers with 10 significant digits.
 * @param {string[]} header
 * @param {Array<Array<number|string>|ArrayLike<number>>} rows
 * @returns {string}
 */
export function toCSV(header, rows) {
    const lines = [header.map((h) => quote(String(h))).join(',')];
    for (const row of rows || []) {
        const cells = new Array(row.length);
        for (let i = 0; i < row.length; i++) cells[i] = field(row[i]);
        lines.push(cells.join(','));
    }
    return lines.join('\r\n') + '\r\n';
}

export const HITS_COLUMNS = Object.freeze(['id', 'source', 'species', 'mass_u', 'charge_e', 't0_us', 'x0_mm', 'y0_mm', 'z0_mm', 'ke0_eV', 'status', 'where',
    't_us', 'tof_us', 'x_mm', 'y_mm', 'z_mm', 'vx_mm_us', 'vy_mm_us', 'vz_mm_us', 'ke_eV', 'dE_end_eV', 'dE_max_eV', 'work_eV', 'steps', 'path_mm']);
export const CROSSINGS_COLUMNS = Object.freeze(['id', 'plane', 'kind', 'k', 'dir', 't_us', 'x_mm', 'y_mm', 'z_mm', 'vx_mm_us', 'vy_mm_us', 'vz_mm_us', 'ke_eV']);
export const POINTS_COLUMNS = Object.freeze(['id', 't_us', 'x_mm', 'y_mm', 'z_mm']);

const STATUS_TEXT = ['flying', 'hit', 'detected', 'exit', 'tmax', 'steps', 'absorbed', 'drift_end', 'num_error', 'born_inside', 'cancelled'];
const EDGE_TEXT = ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax', 'rmax', 'drift_limit'];

/** Text of a run's status code (lower case, e.g. 'detected'). */
export function statusText(code) {
    return STATUS_TEXT[code] || String(code);
}

/** Text of the S_WHERE column: electrode id, plane id or domain edge. */
export function whereText(status, where, resolved) {
    if (!(where >= 0)) return '';
    if (status === STATUS.HIT || status === STATUS.ABSORBED || status === STATUS.BORN_INSIDE) {
        const e = resolved && resolved.electrodes && resolved.electrodes[where];
        return e && e.id !== undefined ? String(e.id) : String(where);
    }
    if (status === STATUS.DETECTED) {
        const p = resolved && resolved.recording && resolved.recording.planes && resolved.recording.planes[where];
        return p && p.id !== undefined ? String(p.id) : String(where);
    }
    if (status === STATUS.EXIT || status === STATUS.DRIFT_END) return EDGE_TEXT[where] || String(where);
    return String(where);
}

function lineOf(cells) {
    return cells.join(',');
}

/**
 * CSV of a run (columns: spec §4.7).
 * @param {object} result TraceResult
 * @param {'hits'|'crossings'|'trajectories'|'markers'} which
 * @param {object} resolved the resolved project of the run (ids, labels; start positions are regenerated)
 * @returns {string}
 */
export function runToCSV(result, which, resolved) {
    const res = resolved || {};
    const sources = res.sources || [];
    if (which === 'hits') {
        const S = result.summary, n = result.n;
        const lines = [HITS_COLUMNS.join(',')];
        // start positions and species data come from the (deterministic) particle generator, in id ranges
        const CH = 4096;
        let gen = null, g0 = 0, g1 = 0;
        for (let i = 0; i < n; i++) {
            const o = i * S_STRIDE, id = S[o + S_ID];
            if (gen === null || id < g0 || id >= g1) {
                g0 = id; g1 = id + CH;
                try { gen = generate(sources, g0, g1, { domainType: res.domain && res.domain.type, relativistic: !res.tracer || res.tracer.relativistic !== false }); } catch (e) { gen = new Float64Array(0); }
                g1 = g0 + Math.floor(gen.length / P_STRIDE);
            }
            const q = (id - g0) * P_STRIDE;
            const have = id >= g0 && id < g1;
            const src = S[o + S_SRC], sp = S[o + S_SPECIES];
            const s = sources[src];
            const spec = s && s.species ? s.species[sp] : null;
            const st = S[o + S_STATUS];
            lines.push(lineOf([
                fmtNum(id), quote(s && s.id !== undefined ? String(s.id) : String(src)), quote(spec && spec.label !== undefined ? String(spec.label) : String(sp)),
                fmtNum(have ? gen[q + P_MASS] : (spec ? spec.mass : NaN)), fmtNum(have ? gen[q + P_CHARGE] : (spec ? spec.charge : NaN)),
                fmtNum(S[o + S_T0]), fmtNum(have ? gen[q + P_X] : NaN), fmtNum(have ? gen[q + P_Y] : NaN), fmtNum(have ? gen[q + P_Z] : NaN),
                fmtNum(S[o + S_KE0]), statusText(st), quote(whereText(st, S[o + S_WHERE], res)),
                fmtNum(S[o + S_T]), fmtNum(S[o + S_TOF]), fmtNum(S[o + S_X]), fmtNum(S[o + S_Y]), fmtNum(S[o + S_Z]),
                fmtNum(S[o + S_VX]), fmtNum(S[o + S_VY]), fmtNum(S[o + S_VZ]), fmtNum(S[o + S_KE]),
                fmtNum(S[o + S_DE_END]), fmtNum(S[o + S_DE_MAX]), fmtNum(S[o + S_WORK]), fmtNum(S[o + S_STEPS]), fmtNum(S[o + S_PATH]),
            ]));
        }
        return lines.join('\r\n') + '\r\n';
    }
    if (which === 'crossings') {
        const C = result.crossings, nc = result.nCross;
        const planes = (res.recording && res.recording.planes) || [];
        const els = res.electrodes || [];
        const lines = [CROSSINGS_COLUMNS.join(',')];
        for (let c = 0; c < nc; c++) {
            const b = c * C_STRIDE, mesh = C[b + C_KIND] === 1;
            let name;
            if (mesh) { const e = els[C[b + C_ELEC]]; name = e && e.id !== undefined ? String(e.id) : String(C[b + C_ELEC]); }
            else { const p = planes[C[b + C_PLANE]]; name = p && p.id !== undefined ? String(p.id) : String(C[b + C_PLANE]); }
            lines.push(lineOf([
                fmtNum(C[b + C_ID]), quote(name), mesh ? 'mesh' : 'plane', fmtNum(C[b + C_K]), fmtNum(C[b + C_DIR]), fmtNum(C[b + C_T]),
                fmtNum(C[b + C_X]), fmtNum(C[b + C_Y]), fmtNum(C[b + C_Z]), fmtNum(C[b + C_VX]), fmtNum(C[b + C_VY]), fmtNum(C[b + C_VZ]), fmtNum(C[b + C_KE]),
            ]));
        }
        return lines.join('\r\n') + '\r\n';
    }
    if (which === 'trajectories') {
        const lines = [POINTS_COLUMNS.join(',')];
        const tr = result.traj;
        if (tr && tr.offsets && tr.pts) {
            const S = result.summary, pts = tr.pts;
            for (let i = 0; i < result.n; i++) {
                const id = fmtNum(S[i * S_STRIDE + S_ID]);
                for (let k = tr.offsets[i]; k < tr.offsets[i + 1]; k++) {
                    const q = 4 * k;
                    lines.push(lineOf([id, fmtF32(pts[q + 3]), fmtF32(pts[q]), fmtF32(pts[q + 1]), fmtF32(pts[q + 2])]));
                }
            }
        }
        return lines.join('\r\n') + '\r\n';
    }
    if (which === 'markers') {
        const lines = [POINTS_COLUMNS.join(',')];
        const m = result.markers;
        if (m) for (let q = 0; q + 4 < m.length; q += 5) lines.push(lineOf([fmtNum(m[q]), fmtF32(m[q + 1]), fmtF32(m[q + 2]), fmtF32(m[q + 3]), fmtF32(m[q + 4])]));
        return lines.join('\r\n') + '\r\n';
    }
    throw new EngineError('E_UNSUPPORTED', `Unknown CSV table "${which}".`);
}

// ======================================================================== particle lists (CSV)

/** Columns of a particle CSV (direction form) and of the velocity form. */
export const PARTICLE_COLUMNS = Object.freeze(['mass_u', 'charge_e', 'x_mm', 'y_mm', 'z_mm', 'dx', 'dy', 'dz', 'ke_eV', 't0_us']);
export const PARTICLE_COLUMNS_VELOCITY = Object.freeze(['mass_u', 'charge_e', 'x_mm', 'y_mm', 'z_mm', 'vx_mm_us', 'vy_mm_us', 'vz_mm_us', 'ke_eV', 't0_us']);

/** Shortest decimal that reads back to the same double (full precision, unlike the 10-digit run tables). */
function fmtExact(v) {
    if (typeof v !== 'number') return v === null || v === undefined ? '' : String(v);
    if (v !== v) return '';
    if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
    return Object.is(v, -0) ? '0' : String(v);
}

/**
 * CSV of particle rows ([mass, charge, x, y, z, dx, dy, dz, ke, t0] per particle) at full precision, so that
 * parseParticlesCSV gives the rows back bit for bit. With `velocity`, the direction columns are replaced by the
 * velocity (mm/µs, from the kinetic energy with the given relativistic flag) and ke_eV is kept.
 * @param {number[][]} rows
 * @param {{ velocity?: boolean, relativistic?: boolean }} [opts]
 * @returns {string}
 */
export function particlesToCSV(rows, { velocity = false, relativistic = true } = {}) {
    const lines = [(velocity ? PARTICLE_COLUMNS_VELOCITY : PARTICLE_COLUMNS).join(',')];
    for (const r of rows || []) {
        if (!Array.isArray(r)) continue;
        let a = r[5], b = r[6], c = r[7];
        if (velocity) {
            const m = +r[0], ke = +r[8];
            const v = relativistic ? velocityFromKE(ke, m) : speedFromKE(ke, m, false);
            a = v * r[5]; b = v * r[6]; c = v * r[7];
        }
        lines.push([r[0], r[1], r[2], r[3], r[4], a, b, c, r[8], r[9]].map(fmtExact).join(','));
    }
    return lines.join('\r\n') + '\r\n';
}

/** |v| (mm/µs) of a relativistic particle of kinetic energy ke (eV) and mass m (u). */
function velocityFromKE(ke, m) {
    const g = 1 + Math.max(0, ke) / (m * UC2_EV);
    return C_MMUS * Math.sqrt(Math.max(0, 1 - 1 / (g * g)));
}

const COLUMN_ALIASES = {
    mass: ['mass_u', 'mass', 'm', 'm_u', 'mass (u)'], charge: ['charge_e', 'charge', 'q', 'q_e', 'charge (e)'],
    x: ['x_mm', 'x', 'x0_mm', 'x0'], y: ['y_mm', 'y', 'y0_mm', 'y0'], z: ['z_mm', 'z', 'z0_mm', 'z0'],
    dx: ['dx', 'ux', 'nx', 'dirx', 'dir_x'], dy: ['dy', 'uy', 'ny', 'diry', 'dir_y'], dz: ['dz', 'uz', 'nz', 'dirz', 'dir_z'],
    vx: ['vx_mm_us', 'vx', 'vx_mm/us', 'vx (mm/us)'], vy: ['vy_mm_us', 'vy', 'vy_mm/us', 'vy (mm/us)'], vz: ['vz_mm_us', 'vz', 'vz_mm/us', 'vz (mm/us)'],
    ke: ['ke_ev', 'ke', 'ke0_ev', 'ke0', 'energy', 'energy_ev', 'kinetic energy (ev)'], t0: ['t0_us', 't0', 'tob', 'birth', 't_birth_us', 'time of birth'],
};

/** Splits one CSV line (RFC 4180 quotes; comma, semicolon or tab separated). */
function splitCSVLine(line, sep) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
            if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
            else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === sep) { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
}

function toNumber(s) {
    const t = String(s).trim().replace(/^'/, '').replace(/−/g, '-');
    if (t === '') return NaN;
    if (/^[-+]?inf(inity)?$/i.test(t)) return t[0] === '-' ? -Infinity : Infinity;
    const v = Number(t);
    return Number.isFinite(v) ? v : NaN;
}

/**
 * Reads a particle CSV into canonical rows [mass, charge, x, y, z, dx, dy, dz, ke, t0].
 * Accepted: a header line with the columns of PARTICLE_COLUMNS (direction) or PARTICLE_COLUMNS_VELOCITY (velocity, from
 * which the direction and, when ke_eV is absent, the kinetic energy are taken), common aliases (x, y, z, vx, …, ke, t0),
 * extra columns ignored (so a hits table exported by this tool imports as the end states, see `fromHits`); or a
 * headerless table of 10 (direction) or 9 (velocity, `[m, q, x, y, z, vx, vy, vz, t0]`) numbers per line. Separator: comma,
 * semicolon or tab. Lines starting with # are comments; blank lines are skipped. Rows with errors are reported, not kept.
 * @param {string} text
 * @param {{ relativistic?: boolean, reverse?: boolean, maxRows?: number }} [opts] reverse: v → −v for velocity columns
 * @returns {{ rows: number[][], velocity: boolean, columns: string[], errors: Array<{ line: number, message: string }>, skipped: number, fromHits: boolean }}
 * @throws {EngineError} E_BAD_PROJECT when no particle columns can be identified
 */
export function parseParticlesCSV(text, { relativistic = true, reverse = false, maxRows = LIMITS.rows } = {}) {
    const src = String(text || '').replace(/^﻿/, '');
    const lines = src.split(/\r?\n/);
    const errors = [];
    let first = -1;
    for (let i = 0; i < lines.length; i++) { const t = lines[i].trim(); if (t && !t.startsWith('#')) { first = i; break; } }
    if (first < 0) throw new EngineError('E_BAD_PROJECT', 'The file has no particle rows.');
    const sample = lines[first];
    const sep = (sample.match(/\t/g) || []).length >= (sample.match(/[,;]/g) || []).length ? (sample.includes('\t') ? '\t' : (sample.includes(';') && !sample.includes(',') ? ';' : ',')) : (sample.includes(';') && !sample.includes(',') ? ';' : ',');
    const head = splitCSVLine(sample, sep);
    const numericHead = head.length && head.every((h) => h === '' || Number.isFinite(toNumber(h)));
    let idx = null, velocity = false, start = first, fromHits = false, columns;
    if (!numericHead) {
        const norm = head.map((h) => h.toLowerCase().replace(/^'/, '').trim());
        const find = (names) => { for (const n of names) { const k = norm.indexOf(n); if (k >= 0) return k; } return -1; };
        const col = {}; for (const key of Object.keys(COLUMN_ALIASES)) col[key] = find(COLUMN_ALIASES[key]);
        const haveDir = col.dx >= 0 && col.dy >= 0 && col.dz >= 0, haveVel = col.vx >= 0 && col.vy >= 0 && col.vz >= 0;
        fromHits = norm.includes('status') && norm.includes('x0_mm');
        if (fromHits) {   // a hits table: end position and velocity, mass and charge columns
            col.x = norm.indexOf('x_mm'); col.y = norm.indexOf('y_mm'); col.z = norm.indexOf('z_mm'); col.ke = norm.indexOf('ke_ev'); col.t0 = -1;
        }
        const missing = ['mass', 'charge', 'x', 'y', 'z'].filter((k) => col[k] < 0);
        if (missing.length || !(haveDir || haveVel) || (haveDir && !haveVel && col.ke < 0)) {
            throw new EngineError('E_BAD_PROJECT', `The header lacks particle columns (${missing.length ? 'missing ' + missing.join(', ') : haveDir ? 'missing ke_eV' : 'missing dx, dy, dz or vx_mm_us, vy_mm_us, vz_mm_us'}); expected ${PARTICLE_COLUMNS.join(', ')}.`);
        }
        velocity = haveVel && !haveDir;
        if (haveVel && haveDir) velocity = false;   // both given: the direction wins, ke required
        if (velocity && reverse) { /* handled per row */ }
        idx = col; start = first + 1; columns = head;
    } else {
        const n = head.length;
        if (n !== 10 && n !== 9) throw new EngineError('E_BAD_PROJECT', `A headerless particle table needs 10 columns (${PARTICLE_COLUMNS.join(', ')}) or 9 (velocity form); found ${n}.`);
        velocity = n === 9;
        idx = velocity ? { mass: 0, charge: 1, x: 2, y: 3, z: 4, vx: 5, vy: 6, vz: 7, ke: -1, t0: 8 } : { mass: 0, charge: 1, x: 2, y: 3, z: 4, dx: 5, dy: 6, dz: 7, ke: 8, t0: 9 };
        columns = (velocity ? ['mass_u', 'charge_e', 'x_mm', 'y_mm', 'z_mm', 'vx_mm_us', 'vy_mm_us', 'vz_mm_us', 't0_us'] : PARTICLE_COLUMNS).slice();
    }
    const rows = [];
    let skipped = 0;
    const get = (cells, k) => (k >= 0 && k < cells.length ? toNumber(cells[k]) : NaN);
    for (let i = start; i < lines.length; i++) {
        const raw = lines[i].trim();
        if (!raw || raw.startsWith('#')) continue;
        if (rows.length >= maxRows) { skipped++; continue; }
        const cells = splitCSVLine(raw, sep);
        const m = get(cells, idx.mass), q = get(cells, idx.charge), x = get(cells, idx.x), y = get(cells, idx.y), z = get(cells, idx.z);
        let t0 = idx.t0 >= 0 ? get(cells, idx.t0) : 0;
        if (idx.t0 >= 0 && cells[idx.t0] === '') t0 = 0;
        let a, b, c, ke;
        const bad = (msg) => { errors.push({ line: i + 1, message: msg }); };
        if (!(m > 0 && m < Infinity)) { bad('mass must be a positive number'); continue; }
        if (!Number.isFinite(q) || q === 0) { bad('charge must be a non-zero number'); continue; }
        if (![x, y, z].every(Number.isFinite)) { bad('x, y, z must be numbers'); continue; }
        if (!Number.isFinite(t0)) { bad('t0 must be a number'); continue; }
        if (velocity) {
            const vx = get(cells, idx.vx), vy = get(cells, idx.vy), vz = get(cells, idx.vz);
            if (![vx, vy, vz].every(Number.isFinite)) { bad('vx, vy, vz must be numbers'); continue; }
            const v = Math.hypot(vx, vy, vz);
            const keCol = idx.ke >= 0 ? get(cells, idx.ke) : NaN;
            if (keCol === Infinity) { bad('ke must be a finite number ≥ 0'); continue; }
            if (v === 0) {
                if (!(keCol >= 0)) { bad('the velocity is zero and no kinetic energy is given'); continue; }
                a = reverse ? -1 : 1; b = 0; c = 0; ke = keCol;
            } else {
                const s = (reverse ? -1 : 1) / v;
                a = vx * s; b = vy * s; c = vz * s;
                if (keCol >= 0) ke = keCol;
                else if (relativistic) {
                    const beta = v / C_MMUS;
                    if (beta >= 1) { bad('the speed must be below c'); continue; }
                    ke = (1 / Math.sqrt(1 - beta * beta) - 1) * m * UC2_EV;
                } else ke = m * v * v / (2 * K_ACC);
            }
        } else {
            a = get(cells, idx.dx); b = get(cells, idx.dy); c = get(cells, idx.dz); ke = get(cells, idx.ke);
            if (![a, b, c].every(Number.isFinite) || (a === 0 && b === 0 && c === 0)) { bad('dx, dy, dz must be numbers and not all zero'); continue; }
            if (!(ke >= 0 && ke < Infinity)) { bad('ke must be a finite number ≥ 0'); continue; }
            if (reverse) { a = -a; b = -b; c = -c; }
        }
        rows.push([m, q, x, y, z, a, b, c, ke, t0]);
    }
    return { rows, velocity, columns, errors, skipped, fromHits };
}

// ======================================================================== base64url

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64REV = (() => { const t = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i; return t; })();

/** base64url without padding (RFC 4648 §5). @param {Uint8Array} bytes @returns {string} */
export function base64urlEncode(bytes) {
    let out = '';
    const n = bytes.length;
    let i = 0;
    for (; i + 2 < n; i += 3) {
        const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    }
    if (i < n) {
        const v = (bytes[i] << 16) | ((i + 1 < n ? bytes[i + 1] : 0) << 8);
        out += B64[v >> 18] + B64[(v >> 12) & 63];
        if (i + 1 < n) out += B64[(v >> 6) & 63];
    }
    return out;
}

/** Decodes base64url (padding optional). @param {string} s @returns {Uint8Array} @throws {EngineError} */
export function base64urlDecode(s) {
    let str = String(s).replace(/=+$/, '');
    if (str.length % 4 === 1) throw new EngineError('E_BAD_PROJECT', 'The link is damaged (bad length).');
    const out = new Uint8Array(Math.floor(str.length * 3 / 4));
    let o = 0, acc = 0, bits = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        const v = c < 128 ? B64REV[c] : -1;
        if (v < 0) throw new EngineError('E_BAD_PROJECT', 'The link is damaged (invalid characters).');
        acc = (acc << 6) | v; bits += 6;
        if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
    }
    return out.subarray(0, o);
}

// ======================================================================== deflate-raw through CompressionStream

function hasCompression() {
    try {
        if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function') return false;
        new CompressionStream('deflate-raw');   // throws where the format is unsupported
        return true;
    } catch (e) { return false; }
}

async function pump(transform, bytes, maxOut) {
    const writer = transform.writable.getWriter();
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});
    const reader = transform.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxOut) {
            try { await reader.cancel(); } catch (e) { /* stream already closed */ }
            throw new EngineError('E_BAD_PROJECT', `The link holds more than ${Math.round(maxOut / 1024)} kB of data.`);
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
}

async function deflateRaw(bytes) {
    return pump(new CompressionStream('deflate-raw'), bytes, Infinity);
}
async function inflateRaw(bytes, maxOut) {
    try {
        return await pump(new DecompressionStream('deflate-raw'), bytes, maxOut);
    } catch (e) {
        if (e instanceof EngineError) throw e;
        throw new EngineError('E_BAD_PROJECT', 'The link is damaged (cannot be decompressed).');
    }
}

// ======================================================================== share links

/** Run-size clamps applied to projects from links (value → limit). */
const LINK_CLAMPS = [
    ['tracer.maxSteps', 5e6], ['solver.maxSweeps', 1e6], ['solver.maxCycles', 1000], ['solver.maxIterations', 10000],
    ['recording.trajectories.maxPoints', 1e5],
];

function clampProject(p) {
    const notes = [];
    const at = (path) => { let c = p; for (const k of path.split('.')) { if (!c || typeof c !== 'object') return undefined; c = c[k]; } return c; };
    const set = (path, v) => { const ks = path.split('.'); let c = p; for (let i = 0; i < ks.length - 1; i++) c = c[ks[i]]; c[ks[ks.length - 1]] = v; };
    for (const [path, lim] of LINK_CLAMPS) {
        const v = at(path);
        if (typeof v === 'number' && v > lim) { set(path, lim); notes.push({ path, code: 'W_CLAMPED', message: `${path} was reduced from ${v} to ${lim}.` }); }
    }
    if (Array.isArray(p.sources)) {
        p.sources.forEach((s, i) => {
            if (s && typeof s === 'object' && typeof s.count === 'number' && s.count > LIMITS.desktop.maxParticles) {
                notes.push({ path: `sources[${i}].count`, code: 'W_CLAMPED', message: `sources[${i}].count was reduced from ${s.count} to ${LIMITS.desktop.maxParticles}.` });
                s.count = LIMITS.desktop.maxParticles;
            }
            if (s && typeof s === 'object' && s.type === 'rows' && Array.isArray(s.rows) && s.rows.length > LIMITS.desktop.maxParticles) {
                notes.push({ path: `sources[${i}].rows`, code: 'W_CLAMPED', message: `sources[${i}].rows was cut from ${s.rows.length} to ${LIMITS.desktop.maxParticles} particles.` });
                s.rows.length = LIMITS.desktop.maxParticles;
            }
        });
    }
    if (p.meta && typeof p.meta === 'object') {
        if (typeof p.meta.name === 'string' && p.meta.name.length > 200) { p.meta.name = p.meta.name.slice(0, 200); notes.push({ path: 'meta.name', code: 'W_CLAMPED', message: 'The project name was shortened.' }); }
        if (typeof p.meta.notes === 'string' && p.meta.notes.length > 20000) { p.meta.notes = p.meta.notes.slice(0, 20000); notes.push({ path: 'meta.notes', code: 'W_CLAMPED', message: 'The notes were shortened.' }); }
    }
    return notes;
}

/**
 * Share-link fragment for a project: 'p=' + base64url(deflate-raw(canonical JSON)), or 'pj=' + base64url(JSON) when
 * CompressionStream (deflate-raw) is unavailable.
 * @param {object} project
 * @returns {Promise<string>}
 * @throws {EngineError} E_BAD_PROJECT if the project is larger than a link may hold (64 kB of JSON)
 */
export async function encodeShare(project) {
    const json = canonicalJSON(project);
    const bytes = new TextEncoder().encode(json);
    if (bytes.length > LIMITS.linkBytes) {
        throw new EngineError('E_BAD_PROJECT', `This project is too large for a link (${Math.ceil(bytes.length / 1024)} kB of data, the limit is ${LIMITS.linkBytes / 1024} kB); save it as a file instead.`);
    }
    if (hasCompression()) {
        try { return 'p=' + base64urlEncode(await deflateRaw(bytes)); } catch (e) { /* fall through to the uncompressed form */ }
    }
    return 'pj=' + base64urlEncode(bytes);
}

/** Splits a location hash into the share payload: { kind: 'p'|'pj', data } or null. */
export function parseShareHash(hash) {
    const h = String(hash || '').replace(/^#/, '');
    for (const part of h.split('&')) {
        if (part.startsWith('p=')) return { kind: 'p', data: part.slice(2) };
        if (part.startsWith('pj=')) return { kind: 'pj', data: part.slice(3) };
    }
    return null;
}

/**
 * Decodes a share link with details: the project, the clamps applied and validation warnings.
 * @param {string} hash '#p=…', 'p=…', '#pj=…' or 'pj=…'
 * @returns {Promise<{ project: object, clamped: object[], warnings: object[] }>}
 * @throws {EngineError} E_BAD_PROJECT for damaged, oversized or invalid links
 */
export async function decodeShareDetailed(hash) {
    const part = parseShareHash(hash);
    if (!part) throw new EngineError('E_BAD_PROJECT', 'The link does not contain a project.');
    const maxChars = Math.ceil(LIMITS.linkBytes * 4 / 3) + 16;
    if (part.data.length > maxChars) throw new EngineError('E_BAD_PROJECT', 'The link is too long to hold a project.');
    const raw = base64urlDecode(part.data);
    let bytes;
    if (part.kind === 'p') {
        if (typeof DecompressionStream !== 'function') throw new EngineError('E_UNSUPPORTED', 'This browser cannot read compressed links; ask for a file instead.');
        bytes = await inflateRaw(raw, LIMITS.linkBytes);
    } else {
        if (raw.length > LIMITS.linkBytes) throw new EngineError('E_BAD_PROJECT', `The link holds more than ${LIMITS.linkBytes / 1024} kB of data.`);
        bytes = raw;
    }
    let json;
    try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (e) {
        throw new EngineError('E_BAD_PROJECT', 'The link is damaged (the project data cannot be read).');
    }
    // non-objects and foreign formats get migrate's own message; any other object must look like a project
    const plainObject = json && typeof json === 'object' && !Array.isArray(json);
    if (plainObject && json.format === undefined && !isProjectLike(json)) throw new EngineError('E_BAD_PROJECT', 'This link does not contain an ion-optics project.');
    if (plainObject && json.format === 'ion-optics-project' && !isProjectLike(json)) throw new EngineError('E_BAD_PROJECT', 'This link does not contain an ion-optics project (no version).');
    let project;
    try { project = migrate(json); } catch (e) { throw new EngineError('E_BAD_PROJECT', e.message || 'The link does not contain a project.'); }
    const clamped = clampProject(project);
    const v = validate(project);
    if (v.errors.length) {
        const first = v.errors[0];
        throw new EngineError('E_BAD_PROJECT', `The linked project is not valid: ${first.path ? first.path + ': ' : ''}${first.message}`, first.path, { errors: v.errors.slice(0, 50) });
    }
    return { project, clamped, warnings: v.warnings };
}

/**
 * Decodes a share link into a validated, clamped project.
 * @param {string} hash
 * @returns {Promise<object>} Project
 * @throws {EngineError} E_BAD_PROJECT
 */
export async function decodeShare(hash) {
    return (await decodeShareDetailed(hash)).project;
}

// ======================================================================== project files

/**
 * Project file text: stable, indented canonical JSON (save → load → save is byte-identical).
 * @param {object} project
 * @returns {string}
 */
export function serializeProject(project) {
    return canonicalJSON(project, 2) + '\n';
}

/**
 * Reads project file text (≤ 5 MB): parse, migrate. Validation is left to the caller (store/UI show issues).
 * @param {string} text
 * @returns {object} Project
 * @throws {EngineError} E_BAD_PROJECT
 */
export function parseProject(text) {
    const s = String(text);
    if (s.length > LIMITS.projectBytes) throw new EngineError('E_BAD_PROJECT', `The file is larger than ${LIMITS.projectBytes / 1048576} MB.`);
    let json;
    try { json = JSON.parse(s); } catch (e) { throw new EngineError('E_BAD_PROJECT', 'The file is not valid JSON.'); }
    // non-objects and foreign formats get migrate's own message; any other object must look like a project
    const plainObject = json && typeof json === 'object' && !Array.isArray(json);
    if (plainObject && (json.format === undefined || json.format === 'ion-optics-project') && !isProjectLike(json)) throw new EngineError('E_BAD_PROJECT', 'This is not an ion-optics project file.');
    return migrate(json);
}

/** File name for a project: '<name>.ionopt.json' with unsafe characters replaced. */
export function projectFileName(project) {
    const raw = project && project.meta && typeof project.meta.name === 'string' ? project.meta.name : '';
    const name = raw.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 80) || 'project';
    return name + '.ionopt.json';
}
