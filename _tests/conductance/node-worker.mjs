// Browser-Worker-compatible adapter over node:worker_threads, so the main-thread McRunner (DOM-free, worker
// factory injected) runs unchanged in Node (spec §2.14, §5.4).
//
//   import { createNodeRunner } from './node-worker.mjs';
//   const mc = createNodeRunner({ workers: 4 });   // McRunner on tpmc-node-worker.mjs threads
//   ... await mc.runChain(plan, G, opts) ...
//   mc.dispose();                                  // terminate the threads (idle threads are unref'd anyway)
//
// Exports: NodeWorker (postMessage, onmessage, onerror, terminate, addEventListener, ref, unref),
// TPMC_WORKER_URL, createTpmcWorker(), defaultWorkerCount(), createNodeRunner({ workers }).
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { McRunner } from '../../beta/conductance/js/engine/mc-runner.js';

export const TPMC_WORKER_URL = new URL('./tpmc-node-worker.mjs', import.meta.url);

/** A worker_threads Worker with the browser Worker interface: onmessage receives { data }, onerror { message }. */
export class NodeWorker {
  constructor(url = TPMC_WORKER_URL, options = {}) {
    this.onmessage = null;
    this.onerror = null;
    this._listeners = { message: new Set(), error: new Set() };
    this._terminated = false;
    this._w = new Worker(url instanceof URL ? url : new URL(String(url), import.meta.url), options);
    this._w.on('message', (data) => this._emit('message', { data }));
    this._w.on('error', (err) => this._emit('error', { message: err && err.message ? err.message : String(err), error: err }));
    this._w.on('messageerror', (err) => this._emit('error', { message: 'A message could not be read: ' + (err && err.message ? err.message : String(err)) }));
    this._w.on('exit', (code) => {
      if (!this._terminated && code !== 0) this._emit('error', { message: 'The worker thread stopped (exit code ' + code + ').' });
    });
  }
  _emit(type, ev) {
    const h = type === 'message' ? this.onmessage : this.onerror;
    if (typeof h === 'function') h(ev);
    for (const fn of this._listeners[type]) fn(ev);
  }
  postMessage(msg, transfer) { this._w.postMessage(msg, transfer || []); }
  addEventListener(type, fn) { if (this._listeners[type]) this._listeners[type].add(fn); }
  removeEventListener(type, fn) { if (this._listeners[type]) this._listeners[type].delete(fn); }
  terminate() { this._terminated = true; return this._w.terminate(); }
  ref() { this._w.ref(); }
  unref() { this._w.unref(); }
}

/** A TPMC worker thread (tpmc-node-worker.mjs). */
export function createTpmcWorker() {
  return new NodeWorker(TPMC_WORKER_URL);
}

/** Default thread count for Node runs: CPUs − 1, between 1 and 11 (§5.4, §6). */
export function defaultWorkerCount() {
  const n = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(11, n - 1));
}

/** An McRunner whose workers are Node threads. */
export function createNodeRunner({ workers = defaultWorkerCount() } = {}) {
  return new McRunner({ createWorker: createTpmcWorker, workers });
}
