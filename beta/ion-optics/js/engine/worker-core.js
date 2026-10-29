/* ==========================================================================
   Ion optics engine: worker-core.js
   Message handler of the engine worker (protocol version 1, spec §2.4).
   Pure: it talks to the outside only through `post(message, transfer)`, so
   the same code runs in a module worker, under node:worker_threads, and on
   the main thread as a fallback.

   Messages (M→W): hello, solve, loadBases, setField, trace, bench, drop.
   Replies (W→M): hello, progress (≤ 10 per second per job), raster, basis,
   done, loaded, fieldReady, traceResult, benchResult, error, log.
   Caches: one multigrid hierarchy (by geomKey; `drop {hierarchy}` after a
   solve batch), one basis set (by geomKey), two field interpolant/model pairs
   (LRU by fieldKey) and up to four run settings (by runKey). A request that
   needs state this worker does not hold is answered with an error whose
   detail.missing is 'bases', 'field' or 'run', so the pool can resend the
   set-up. Combined channels sent without bases are used with a level-0
   raster made here when none was loaded.

   No external sources (message plumbing around pipeline.js).
   ========================================================================== */
import { ENGINE_VERSION, PROTOCOL_VERSION } from './version.js';
import { ENGINE, makePipeline, solverOptions, basisElectrodes } from './pipeline.js';
import { EngineError } from './schema.js';

/** Real engine namespaces plus the lazy benchmark loader. */
export const DEFAULT_ENGINE = Object.freeze({ ...ENGINE, loadBench: () => import('./bench/cases.js') });

const PROGRESS_MS = 100;
const FIELD_CACHE = 2;
const RUN_CACHE = 4;

function errorMessage(id, e) {
    const code = e && typeof e.code === 'string' ? e.code : 'E_INTERNAL';
    const msg = { v: PROTOCOL_VERSION, type: 'error', id: id === undefined ? null : id, code, message: e && e.message ? String(e.message) : String(e), stack: e && e.stack ? String(e.stack) : '' };
    if (e && e.path !== undefined) msg.path = e.path;
    if (e && e.detail !== undefined) {
        try { msg.detail = JSON.parse(JSON.stringify(e.detail)); } catch (err) { /* detail is not plain data */ }
    }
    return msg;
}

/**
 * Creates the message handler.
 * @param {{ post: (msg: object, transfer?: ArrayBuffer[]) => void, engine?: object }} args
 * @returns {(msg: object) => void|Promise<void>}
 */
export function createHandler({ post, engine = DEFAULT_ENGINE }) {
    const E = engine;
    const pipe = makePipeline(E);
    const send = (m, t) => post(m, t || []);
    const V = PROTOCOL_VERSION;

    let hier = null;          // { geomKey, geometry, H }
    let basisSet = null;      // { geomKey, raster0, geometry, bases: Map, bytes }
    let ownRaster = null;     // { geomKey, raster0, geometry }: rasterised here (channels sent without loadBases)
    const fields = new Map(); // fieldKey -> { fieldKey, geomKey, runKey, resolved, field }
    const runs = new Map();   // runKey -> resolved

    function throttle(id, type, extra) {
        let last = -Infinity;
        return (payload, force = false) => {
            const t = performance.now();
            if (!force && t - last < PROGRESS_MS) return;
            last = t;
            send({ v: V, type, id, ...extra, ...payload });
        };
    }

    function geometryFor(geomKey, resolved) {
        if (hier && hier.geomKey === geomKey) return hier.geometry;
        if (basisSet && basisSet.geomKey === geomKey && basisSet.geometry) return basisSet.geometry;
        if (ownRaster && ownRaster.geomKey === geomKey) return ownRaster.geometry;
        const g = E.geometry.compileGeometry(resolved);
        if (basisSet && basisSet.geomKey === geomKey) basisSet.geometry = g;
        return g;
    }

    function raster0For(geomKey) {
        if (basisSet && basisSet.geomKey === geomKey && basisSet.raster0) return basisSet.raster0;
        if (hier && hier.geomKey === geomKey && hier.H) return hier.H[0].raster;
        if (ownRaster && ownRaster.geomKey === geomKey) return ownRaster.raster0;
        return null;
    }

    /** Level-0 raster of a geometry, rasterised here when no solve or loadBases provided one (same code, same result). */
    function rasterHere(geomKey, resolved, geometry) {
        const have = raster0For(geomKey);
        if (have) return have;
        const grid = E.raster.makeGrid(resolved.domain, 0);
        const raster0 = E.raster.rasterize(geometry, grid, resolved, { boundary: (resolved.solver && resolved.solver.boundary) || 'subgrid', snapTheta: 1e-3 });
        ownRaster = { geomKey, raster0, geometry };
        return raster0;
    }

    function missing(what, message) {
        return new EngineError('E_INTERNAL', message, undefined, { missing: what });
    }

    function onSolve(msg) {
        const { id, geomKey, resolved } = msg;
        const ks = Array.isArray(msg.electrodes) ? msg.electrodes : basisElectrodes(resolved);
        const progress = throttle(id, 'progress');
        if (!hier || hier.geomKey !== geomKey) {
            hier = null;
            progress({ phase: 'raster', k: ks.length ? ks[0] : 0, frac: 0, cycle: 0, estErr: null, scaledResidual: null }, true);
            const geometry = E.geometry.compileGeometry(resolved);
            const boundary = (resolved.solver && resolved.solver.boundary) || 'subgrid';
            const H = ks.length ? E.operator.buildHierarchy(geometry, resolved, { boundary }) : null;
            hier = { geomKey, geometry, H };
        }
        if (msg.wantRaster) {
            const r0 = hier.H ? hier.H[0].raster : rasterHere(geomKey, resolved, hier.geometry);
            const packed = E.raster.packRaster(r0);
            send({ v: V, type: 'raster', id, geomKey, packed }, packed.buffers.slice());
        }
        const sopts = solverOptions(resolved, msg.opts || {});
        for (let q = 0; q < ks.length; q++) {
            const k = ks[q];
            const r = E.solve.solveBasis(hier.H, k, sopts, {
                progressEveryMs: PROGRESS_MS,
                onProgress: (p) => progress({ phase: 'solve', k, frac: (q + Math.max(0, Math.min(1, (p && p.frac) || 0))) / ks.length, cycle: p ? (p.cycle ?? p.iteration ?? p.sweep ?? 0) : 0,
                    estErr: p ? p.estErr ?? null : null, scaledResidual: p ? p.scaledResidual ?? null : null, method: p ? p.phase : undefined }),
            });
            send({ v: V, type: 'basis', id, geomKey, k, phi: r.phi, stats: r.stats }, [r.phi.buffer]);
        }
        send({ v: V, type: 'done', id });
    }

    function onLoadBases(msg) {
        const { geomKey } = msg;
        let raster0 = null;
        if (msg.packedRaster) raster0 = E.raster.unpackRaster(msg.packedRaster);
        else raster0 = raster0For(geomKey);
        const bases = new Map();
        let bytes = 0;
        for (const b of msg.bases || []) {
            const phi = b.phi instanceof Float64Array ? b.phi : new Float64Array(b.phi);
            bases.set(b.k, phi);
            bytes += phi.byteLength;
        }
        const keepGeometry = basisSet && basisSet.geomKey === geomKey ? basisSet.geometry : null;
        basisSet = { geomKey, raster0, geometry: keepGeometry, bases, bytes };
        if (ownRaster && ownRaster.geomKey !== geomKey) ownRaster = null;
        // fields built on another geometry are out of date (the same geomKey always gives the same bases)
        for (const [fk, f] of fields) if (f.geomKey !== geomKey) fields.delete(fk);
        send({ v: V, type: 'loaded', id: msg.id ?? null, geomKey, bytes });
    }

    function onSetField(msg) {
        const t0 = performance.now();
        const { fieldKey, runKey, geomKey, resolved } = msg;
        if (!resolved || typeof resolved !== 'object') throw new EngineError('E_BAD_PROJECT', 'setField needs the resolved project.');
        if (runKey) { runs.delete(runKey); runs.set(runKey, resolved); while (runs.size > RUN_CACHE) runs.delete(runs.keys().next().value); }
        let entry = fields.get(fieldKey);
        if (!entry) {
            const ks = basisElectrodes(resolved);
            const geometry = geometryFor(geomKey, resolved);
            let solved;
            if (Array.isArray(msg.channels) && msg.channels.length) {
                // combined channel potentials (bases too large to hold here)
                solved = { geometry, raster0: rasterHere(geomKey, resolved, geometry), bases: new Map(),
                    channels: msg.channels.map((c) => ({ phi: c.phi instanceof Float64Array ? c.phi : new Float64Array(c.phi) })) };
            } else if (ks.length === 0) {
                solved = { geometry, raster0: rasterHere(geomKey, resolved, geometry), bases: new Map() };
            } else {
                if (!basisSet || basisSet.geomKey !== geomKey || basisSet.bases.size === 0) throw missing('bases', 'The basis fields for this geometry are not loaded; send loadBases or channels.');
                solved = { geometry, raster0: basisSet.raster0 || rasterHere(geomKey, resolved, geometry), bases: basisSet.bases };
            }
            const f = pipe.buildField(resolved, solved);
            entry = { fieldKey, geomKey, runKey, resolved, field: f };
            fields.set(fieldKey, entry);
            while (fields.size > FIELD_CACHE) fields.delete(fields.keys().next().value);
        } else {
            fields.delete(fieldKey); fields.set(fieldKey, entry);   // LRU touch
            entry.runKey = runKey; entry.resolved = resolved;
        }
        send({ v: V, type: 'fieldReady', id: msg.id ?? null, fieldKey, runKey, ms: performance.now() - t0 });
    }

    function onTrace(msg) {
        const { id, fieldKey, runKey } = msg;
        const entry = fields.get(fieldKey);
        if (!entry) throw missing('field', 'No field for this key; send setField first.');
        const resolved = runs.get(runKey) || (entry.runKey === runKey ? entry.resolved : null);
        if (!resolved) throw missing('run', 'No run settings for this key; send setField first.');
        const progress = throttle(id, 'progress');
        let range;
        if (msg.particles) {
            const parts = msg.particles instanceof Float64Array ? msg.particles : new Float64Array(msg.particles);
            range = { particles: parts, overrides: msg.overrides || {}, total: msg.total || null };
        } else {
            const [i0, i1] = Array.isArray(msg.range) ? msg.range : [0, resolved.particleCount];
            range = { i0, i1, overrides: msg.overrides || {}, total: msg.total || resolved.particleCount };
        }
        const result = pipe.traceProject(resolved, entry.field, range, { progressEveryMs: PROGRESS_MS, onProgress: (p) => progress({ done: p.done, total: p.total }) });
        const i0 = msg.particles ? result.i0 : range.i0;
        send({ v: V, type: 'traceResult', id, i0, result }, E.trace.resultTransferables(result));
    }

    async function onBench(msg) {
        const { id, caseId, level } = msg;
        const progress = throttle(id, 'progress');
        let mod;
        try { mod = await E.loadBench(); } catch (e) { throw new EngineError('E_UNSUPPORTED', 'The benchmark cases are not available in this build.'); }
        const result = await mod.runBenchmark(caseId, level || 'quick', {
            onProgress: (frac, text) => progress({ frac: typeof frac === 'number' ? frac : (frac && frac.frac) || 0, msg: text || (frac && frac.msg) || '' }),
            log: (level2, message) => send({ v: V, type: 'log', id, level: level2 || 'info', message: String(message) }),
        });
        send({ v: V, type: 'benchResult', id, result });
    }

    function onDrop(msg) {
        // hierarchy: true (any) or a geomKey (only that geometry's); geomKey: every cache of that geometry
        if (hier && (msg.hierarchy === true || (typeof msg.hierarchy === 'string' && hier.geomKey === msg.hierarchy) || (msg.geomKey && hier.geomKey === msg.geomKey))) hier = null;
        if (msg.geomKey && basisSet && basisSet.geomKey === msg.geomKey) basisSet = null;
        if (msg.geomKey && ownRaster && ownRaster.geomKey === msg.geomKey) ownRaster = null;
        if (msg.geomKey) for (const [fk, f] of fields) if (f.geomKey === msg.geomKey) fields.delete(fk);
        if (msg.fieldKey) fields.delete(msg.fieldKey);
        if (msg.all) { hier = null; basisSet = null; ownRaster = null; fields.clear(); runs.clear(); }
    }

    return function handle(msg) {
        if (!msg || typeof msg !== 'object') return undefined;
        const id = msg.id;
        try {
            if (msg.v !== undefined && msg.v !== PROTOCOL_VERSION) throw new EngineError('E_VERSION', `Unsupported protocol version ${msg.v}.`);
            switch (msg.type) {
                case 'hello': send({ v: V, type: 'hello', id: id ?? null, engine: ENGINE_VERSION, protocol: PROTOCOL_VERSION }); return undefined;
                case 'solve': onSolve(msg); return undefined;
                case 'loadBases': onLoadBases(msg); return undefined;
                case 'setField': onSetField(msg); return undefined;
                case 'trace': onTrace(msg); return undefined;
                case 'bench': return onBench(msg).catch((e) => send(errorMessage(id, e)));
                case 'drop': onDrop(msg); return undefined;
                default: throw new EngineError('E_UNSUPPORTED', `Unknown message type "${String(msg.type)}".`);
            }
        } catch (e) {
            send(errorMessage(id, e));
            return undefined;
        }
    };
}
