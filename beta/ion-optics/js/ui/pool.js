/* ==========================================================================
   Ion optics workbench: ui/pool.js
   Pool of engine module workers (spec §2.4, §2.5): version handshake,
   prioritised dynamic dispatch (0 preview, 1 normal, 2 benchmark) with
   affinity for workers that already hold a field, per-job setup messages
   (bases and fields are sent only to workers that lack them, and resent once
   when a worker reports it lost them), cancellation by group (terminate and
   respawn lazily; queued-only cancellation for superseded previews), and a
   main-thread fallback that runs the same worker core when module workers are
   unavailable or silent for 5 s (a single failed worker is retired instead
   when others answered). No SharedArrayBuffer; results arrive as transferred
   ArrayBuffers.
   ========================================================================== */
import { ENGINE_VERSION, PROTOCOL_VERSION } from '../engine/version.js';
import { EngineError } from '../engine/schema.js';

const TERMINAL = new Set(['done', 'loaded', 'fieldReady', 'traceResult', 'benchResult', 'hello', 'error']);
const FIELD_LRU = 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Runs the worker core on the main thread with the Worker interface (fallback and tests). */
export class InlineWorker {
    constructor(handlerFactory) {
        this.onmessage = null;
        this.onerror = null;
        this.closed = false;
        const factory = handlerFactory || ((post) => import('../engine/worker-core.js').then((m) => m.createHandler({ post })));
        const post = (msg) => {
            if (this.closed) return;
            setTimeout(() => { if (!this.closed && this.onmessage) this.onmessage({ data: msg }); }, 0);
        };
        this.ready = Promise.resolve(factory(post)).then((h) => { this.handle = h; }, (e) => {
            setTimeout(() => { if (!this.closed && this.onerror) this.onerror({ message: String(e && e.message ? e.message : e) }); }, 0);
        });
    }
    postMessage(msg) {
        if (this.closed) return;
        this.ready.then(() => {
            setTimeout(() => {
                if (this.closed || !this.handle) return;
                try { this.handle(msg); } catch (e) { if (this.onerror) this.onerror({ message: String(e && e.message ? e.message : e) }); }
            }, 0);
        });
    }
    terminate() { this.closed = true; }
}

/**
 * Creates the worker pool.
 * @param {{ url?: string|URL, size?: number, reservePreview?: boolean, WorkerImpl?: Function, mobile?: boolean,
 *   helloTimeoutMs?: number, inline?: boolean, inlineFactory?: Function }} [opts]
 * @returns {object} Pool: size, ready, versionOk, fallback, exec, broadcast, holding, holders, cancel, terminate, on, stats
 */
export function createPool(opts = {}) {
    const hc = (globalThis.navigator && globalThis.navigator.hardwareConcurrency) || 4;
    const size = Math.max(1, opts.size ? Math.floor(opts.size) : clamp(hc - 1, 1, opts.mobile ? 2 : 8));
    const reserve = opts.reservePreview === undefined ? size >= 3 : !!opts.reservePreview && size >= 2;
    const url = opts.url || new URL('../workers/engine-worker.js', import.meta.url);
    const helloTimeoutMs = opts.helloTimeoutMs === undefined ? 5000 : opts.helloTimeoutMs;
    const listeners = new Map();
    let inline = !!opts.inline;
    let seq = 0;
    let closed = false;
    const queue = [];
    const slots = [];
    let readyResolve;
    const pool = {
        size, reservePreview: reserve, versionOk: true, fallback: inline,
        ready: new Promise((r) => { readyResolve = r; }),
    };

    let constructing = true;
    function emit(evt, payload) {
        // events raised while the pool is being created reach listeners subscribed right after createPool returns
        if (constructing) { setTimeout(() => emit(evt, payload), 0); return; }
        const set = listeners.get(evt);
        if (set) for (const fn of [...set]) { try { fn(payload); } catch (e) { /* listener errors must not break the pool */ } }
    }

    function freshHolds() { return { geomKey: null, fields: [], runKeys: [] }; }
    for (let i = 0; i < size; i++) slots.push({ index: i, worker: null, state: 'dead', gen: 0, job: null, holds: freshHolds(), timer: null });

    function makeWorker() {
        if (inline) return new InlineWorker(opts.inlineFactory);
        const W = opts.WorkerImpl || globalThis.Worker;
        if (typeof W !== 'function') throw new Error('Workers are not available.');
        return new W(url, { type: 'module' });
    }

    function checkReady() {
        if (slots.every((s) => s.state === 'ready' || s.state === 'broken') || closed) readyResolve({ versionOk: pool.versionOk, fallback: pool.fallback, size });
    }

    function spawn(slot) {
        let w;
        try { w = makeWorker(); } catch (e) { goInline(e); return; }
        slot.gen++;
        const gen = slot.gen;
        slot.worker = w;
        slot.state = 'starting';
        slot.holds = freshHolds();
        w.onmessage = (ev) => onMessage(slot, gen, ev && ev.data);
        w.onerror = (ev) => onCrash(slot, gen, ev);
        try { w.postMessage({ v: PROTOCOL_VERSION, type: 'hello', id: `hello:${slot.index}:${gen}` }); } catch (e) { onCrash(slot, gen, e); return; }
        if (helloTimeoutMs > 0 && !inline) {
            slot.timer = setTimeout(() => { if (slot.gen === gen && slot.state === 'starting') startFailed(slot, new Error('The engine worker did not answer within 5 s.')); }, helloTimeoutMs);
        }
    }

    /** A worker failed before its handshake: retire that slot if others work, else run on the main thread. */
    function startFailed(slot, reason) {
        if (!inline && slots.some((s) => s !== slot && s.state === 'ready')) {
            killSlot(slot);
            slot.state = 'broken';
            emit('crash', { index: slot.index, message: reason && reason.message ? reason.message : String(reason) });
            checkReady();
            dispatch();
            return;
        }
        goInline(reason);
    }

    function killSlot(slot) {
        if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
        if (slot.worker) { try { slot.worker.terminate(); } catch (e) { /* already gone */ } }
        slot.worker = null;
        slot.gen++;
        slot.state = 'dead';
        slot.holds = freshHolds();
    }

    function goInline(reason) {
        if (inline) {
            // the inline worker itself failed: nothing else to fall back to
            for (const s of slots) if (s.state === 'starting') { s.state = 'broken'; }
            failAll(new EngineError('E_INTERNAL', `The engine could not start: ${reason && reason.message ? reason.message : reason}`));
            checkReady();
            return;
        }
        inline = true;
        pool.fallback = true;
        emit('fallback', { reason: reason && reason.message ? reason.message : String(reason) });
        const running = [];
        for (const s of slots) { if (s.job) running.push(s.job); s.job = null; killSlot(s); }
        // requeue the jobs that were running on the failed workers
        for (const j of running) { rewind(j); queue.unshift(j); }
        // all inline "workers" share the main thread: one is enough
        for (let i = 1; i < slots.length; i++) slots[i].state = 'broken';
        spawn(slots[0]);
    }

    function failAll(err) {
        while (queue.length) { const j = queue.shift(); j.reject(err); }
        for (const s of slots) if (s.job) { const j = s.job; s.job = null; j.reject(err); }
    }

    function onCrash(slot, gen, ev) {
        if (slot.gen !== gen) return;
        const message = ev && ev.message ? ev.message : 'The engine worker stopped unexpectedly.';
        if (slot.state === 'starting') { startFailed(slot, new Error(message)); return; }
        const job = slot.job;
        slot.job = null;
        killSlot(slot);
        emit('crash', { index: slot.index, message });
        if (job) job.reject(new EngineError('E_INTERNAL', `The engine worker stopped: ${message}`));
        dispatch();
    }

    function remember(slot, msg, reply) {
        const h = slot.holds;
        if (reply.type === 'loaded') {
            h.geomKey = reply.geomKey;
            h.fields = h.fields.filter((f) => f.geomKey === reply.geomKey);
        } else if (reply.type === 'fieldReady') {
            h.fields = h.fields.filter((f) => f.fieldKey !== reply.fieldKey);
            h.fields.push({ fieldKey: reply.fieldKey, geomKey: msg.geomKey, runKey: reply.runKey });
            while (h.fields.length > FIELD_LRU) h.fields.shift();
            h.runKeys = h.runKeys.filter((k) => k !== reply.runKey);
            h.runKeys.push(reply.runKey);
            while (h.runKeys.length > 4) h.runKeys.shift();
            if (!h.geomKey) h.geomKey = msg.geomKey;
        }
    }

    function onMessage(slot, gen, msg) {
        if (slot.gen !== gen || !msg || typeof msg !== 'object') return;
        if (msg.type === 'hello' && slot.state === 'starting') {
            if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
            if (msg.engine !== ENGINE_VERSION || msg.protocol !== PROTOCOL_VERSION) {
                pool.versionOk = false;
                slot.state = 'broken';
                emit('version', { page: { engine: ENGINE_VERSION, protocol: PROTOCOL_VERSION }, worker: { engine: msg.engine, protocol: msg.protocol } });
                failAll(new EngineError('E_VERSION', 'This page was updated while open. Reload to continue.'));
                try { slot.worker.terminate(); } catch (e) { /* ignore */ }
                checkReady();
                return;
            }
            slot.state = 'ready';
            checkReady();
            dispatch();
            return;
        }
        if (msg.type === 'log') emit('log', msg);
        const job = slot.job;
        if (!job) return;
        const step = job.steps ? job.steps.get(msg.id) : null;
        if (step) {
            // reply to a setup message (loadBases / setField) sent ahead of the job
            if (msg.type === 'error') {
                if (retryAfterMissing(slot, job, msg)) return;
                slot.job = null;
                job.reject(Object.assign(new EngineError(msg.code || 'E_INTERNAL', msg.message || 'Setup failed.', msg.path, msg.detail), { workerStack: msg.stack || '' }));
                dispatch();
                return;
            }
            if (TERMINAL.has(msg.type)) { remember(slot, step, msg); job.steps.delete(msg.id); }
            return;
        }
        if (msg.id !== undefined && msg.id !== null && msg.id !== job.id && msg.type !== 'log') return;   // stray message from an earlier job
        if (msg.type === 'error') {
            if (retryAfterMissing(slot, job, msg)) return;
            slot.job = null;
            const err = new EngineError(msg.code || 'E_INTERNAL', msg.message || 'Engine error.', msg.path, msg.detail);
            if (msg.stack) err.workerStack = msg.stack;
            job.reject(err);
            dispatch();
            return;
        }
        if (TERMINAL.has(msg.type)) {
            remember(slot, job.msg, msg);
            slot.job = null;
            job.resolve(msg);
            dispatch();
            return;
        }
        if (job.onMessage) { try { job.onMessage(msg, slot.index); } catch (e) { /* caller bugs must not stall the pool */ } }
    }

    /**
     * A worker that lost state the pool thought it held (bases, field or run settings) answers with detail.missing:
     * forget what the slot holds and run the job once more with full setup messages.
     */
    function retryAfterMissing(slot, job, msg) {
        if (!(msg.detail && msg.detail.missing) || job.retried || typeof job.setup !== 'function') return false;
        job.retried = true;
        slot.job = null;
        slot.holds = freshHolds();
        // a new message id, so late replies to the failed attempt are ignored as strays
        job.id = `${job.id}~r`;
        rewind(job);
        queue.unshift(job);
        dispatch();
        return true;
    }

    /** Prepares a job for another attempt: transferred payloads left with the first one, so the spare copy goes instead. */
    function rewind(job) {
        if (job.spare) { job.msg = { ...job.spare, id: job.id }; job.transfer = []; job.spare = null; }
        else job.msg = { ...job.msg, id: job.id };
    }

    function eligible(slot, job) {
        if (job.pin !== undefined && job.pin !== null) return job.pin === slot.index;
        if (reserve && !inline) {
            // the reservation holds only while both sides have a live worker; a broken side hands its jobs to the other
            const preview = slots[0].state !== 'broken';
            const others = slots.some((s) => s.index !== 0 && s.state !== 'broken');
            if (job.priority === 0) return preview ? slot.index === 0 : true;
            return others ? slot.index !== 0 : true;
        }
        return true;
    }

    function holdsField(slot, key) { return !!key && slot.holds.fields.some((f) => f.fieldKey === key); }

    function pick(slot) {
        let best = -1;
        for (let q = 0; q < queue.length; q++) {
            const j = queue[q];
            if (!eligible(slot, j)) continue;
            if (best < 0) { best = q; continue; }
            const b = queue[best];
            if (j.priority !== b.priority) { if (j.priority < b.priority) best = q; continue; }
            const ja = holdsField(slot, j.affinity) ? 0 : 1, ba = holdsField(slot, b.affinity) ? 0 : 1;
            if (ja !== ba) { if (ja < ba) best = q; continue; }
            if (j.seq < b.seq) best = q;
        }
        return best;
    }

    function start(slot, job) {
        slot.job = job;
        job.slot = slot.index;
        job.steps = new Map();
        // a job keeps a copy of what it transfers away (small: one chunk of particle rows), for a retry or a requeue
        if (!job.spare && job.transfer && job.transfer.length && typeof structuredClone === 'function') {
            try { job.spare = structuredClone(job.msg); } catch (e) { job.spare = null; }
        }
        let setup = [];
        if (typeof job.setup === 'function') {
            try { setup = job.setup({ index: slot.index, holds: slot.holds, inline }) || []; } catch (e) { slot.job = null; job.reject(e); return false; }
        }
        try {
            for (const s of setup) {
                const id = `s${++seq}`;
                const m = { v: PROTOCOL_VERSION, ...s.msg, id };
                job.steps.set(id, m);
                slot.worker.postMessage(m, s.transfer || []);
            }
            slot.worker.postMessage(job.msg, job.transfer || []);
        } catch (e) {
            slot.job = null;
            job.reject(new EngineError('E_INTERNAL', `Could not send the job: ${e && e.message ? e.message : e}`));
            return false;
        }
        return true;
    }

    function dispatch() {
        if (closed) return;
        for (const slot of slots) {
            if (slot.job || slot.state === 'broken' || slot.state === 'starting') continue;
            if (!queue.length) return;
            const q = pick(slot);
            if (q < 0) continue;
            if (slot.state === 'dead') { spawn(slot); continue; }   // the job starts after the handshake
            const job = queue.splice(q, 1)[0];
            if (!start(slot, job)) continue;
        }
    }

    /**
     * Runs one message on a worker. Resolves with the final reply (done, loaded, fieldReady, traceResult, benchResult,
     * hello); rejects with EngineError on an error reply, a crash or cancellation.
     * @param {object} msg
     * @param {{ transfer?: ArrayBuffer[], onMessage?: (m: object, worker: number) => void, priority?: number, affinity?: string,
     *   group?: string, pin?: number, setup?: (slot: { index: number, holds: object, inline: boolean }) => Array<{ msg: object, transfer?: ArrayBuffer[] }> }} [o]
     * @returns {Promise<object>}
     */
    pool.exec = function exec(msg, o = {}) {
        if (closed) return Promise.reject(new EngineError('E_CANCELLED', 'The worker pool was closed.'));
        if (!pool.versionOk) return Promise.reject(new EngineError('E_VERSION', 'This page was updated while open. Reload to continue.'));
        const id = msg.id === undefined || msg.id === null ? `j${++seq}` : msg.id;
        const job = { id, msg: { v: PROTOCOL_VERSION, ...msg, id }, transfer: o.transfer || [], onMessage: o.onMessage || null,
            priority: o.priority === undefined ? 1 : o.priority, affinity: o.affinity || null, group: o.group || null,
            pin: o.pin, setup: o.setup || null, seq: ++seq, resolve: null, reject: null, slot: -1 };
        const p = new Promise((res, rej) => { job.resolve = res; job.reject = rej; });
        queue.push(job);
        dispatch();
        return p;
    };

    /**
     * Sends a message to every live worker. 'drop' messages have no reply (resolved at once); others resolve per worker.
     * @returns {Promise<object>[]}
     */
    pool.broadcast = function broadcast(msg, o = {}) {
        if (msg && msg.type === 'drop') {
            for (const s of slots) {
                if (!s.worker || s.state !== 'ready') continue;
                try { s.worker.postMessage({ v: PROTOCOL_VERSION, ...msg }); } catch (e) { /* worker gone */ }
                if (msg.fieldKey) s.holds.fields = s.holds.fields.filter((f) => f.fieldKey !== msg.fieldKey);
                if (msg.geomKey && s.holds.geomKey === msg.geomKey) { s.holds.geomKey = null; s.holds.fields = s.holds.fields.filter((f) => f.geomKey !== msg.geomKey); }
                if (msg.all) s.holds = freshHolds();
            }
            return [Promise.resolve(null)];
        }
        return slots.filter((s) => s.state !== 'broken').map((s) => pool.exec({ ...msg, id: undefined }, { ...o, pin: s.index, priority: o.priority === undefined ? -1 : o.priority }));
    };

    /** Number of workers holding the field `fieldKey`. */
    pool.holding = function holding(fieldKey) { return slots.filter((s) => holdsField(s, fieldKey)).length; };
    /** Indices of the workers holding the field `fieldKey`. */
    pool.holders = function holders(fieldKey) { return slots.filter((s) => holdsField(s, fieldKey)).map((s) => s.index); };

    /**
     * Rejects the queued (not yet started) jobs of `group` with E_CANCELLED; running jobs continue. Superseded live
     * previews use it: they are dropped from the queue, never interrupted.
     * @returns {number} jobs removed
     */
    pool.cancelQueued = function cancelQueued(group) {
        const err = new EngineError('E_CANCELLED', 'Superseded.');
        let n = 0;
        for (let q = queue.length - 1; q >= 0; q--) if (queue[q].group === group) { const j = queue.splice(q, 1)[0]; j.reject(err); n++; }
        return n;
    };

    /** Cancels every queued and running job of `group`: running workers are terminated and respawned on demand. */
    pool.cancel = function cancel(group) {
        const err = new EngineError('E_CANCELLED', 'Stopped.');
        for (let q = queue.length - 1; q >= 0; q--) if (queue[q].group === group) { const j = queue.splice(q, 1)[0]; j.reject(err); }
        for (const s of slots) {
            if (s.job && s.job.group === group) {
                const j = s.job;
                s.job = null;
                if (inline) {
                    // the main-thread core cannot be interrupted; drop the result when it arrives
                    s.gen++;
                    const w = s.worker; const g = s.gen;
                    if (w) w.onmessage = (ev) => onMessage(s, g, ev && ev.data);
                } else killSlot(s);
                j.reject(err);
            }
        }
        dispatch();
    };

    /** Terminates every worker and rejects all jobs. */
    pool.terminate = function terminate() {
        closed = true;
        failAll(new EngineError('E_CANCELLED', 'The worker pool was closed.'));
        for (const s of slots) killSlot(s);
        readyResolve({ versionOk: pool.versionOk, fallback: pool.fallback, size });
    };

    /** Subscribes to 'version', 'fallback', 'crash' or 'log'. @returns {() => void} */
    pool.on = function on(evt, fn) {
        if (!listeners.has(evt)) listeners.set(evt, new Set());
        listeners.get(evt).add(fn);
        return () => listeners.get(evt).delete(fn);
    };

    /** Diagnostics: worker states, queue length, fallback flag. */
    pool.stats = function stats() {
        return { size, inline, fallback: pool.fallback, queued: queue.length, busy: slots.filter((s) => s.job).length,
            workers: slots.map((s) => ({ index: s.index, state: s.state, busy: !!s.job, group: s.job ? s.job.group : null, holds: { geomKey: s.holds.geomKey, fields: s.holds.fields.map((f) => f.fieldKey) } })) };
    };

    /** Workers that run full runs and benchmarks (all but the reserved preview worker). */
    pool.traceWorkers = function traceWorkers() {
        if (inline) return 1;
        const live = slots.filter((s) => s.state !== 'broken' && !(reserve && s.index === 0)).length;
        return Math.max(1, live);
    };

    for (const s of slots) {
        if (inline && s.index > 0) { s.state = 'broken'; continue; }
        spawn(s);
    }
    checkReady();
    constructing = false;
    return pool;
}
