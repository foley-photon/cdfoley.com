// Runs the real module worker (beta/ion-optics/js/workers/engine-worker.js) under node:worker_threads:
// defines the `self` the worker expects, then imports it. Used by wp3-worker.test.mjs:
//   new Worker(new URL('./worker-shim.mjs', import.meta.url))
// With workerData { checkTransfers: true } every reply is followed by { type: '__transfer', of, id, buffers, listed,
// unlisted, detached }: the ArrayBuffers in the reply, how many were in the transfer list, the unlisted ones larger
// than 1 kB, and whether every listed buffer was detached by postMessage (transferred, not copied).
import { parentPort, workerData } from 'node:worker_threads';

function buffersIn(v, out = new Set(), seen = new Set()) {
    if (!v || typeof v !== 'object' || seen.has(v)) return out;
    seen.add(v);
    if (ArrayBuffer.isView(v)) { out.add(v.buffer); return out; }
    if (v instanceof ArrayBuffer) { out.add(v); return out; }
    for (const k of Object.keys(v)) buffersIn(v[k], out, seen);
    return out;
}

const check = !!(workerData && workerData.checkTransfers);
globalThis.self = {
    postMessage: (m, t) => {
        if (!check) { parentPort.postMessage(m, t); return; }
        const all = [...buffersIn(m)];
        const list = t || [];
        parentPort.postMessage(m, list);
        parentPort.postMessage({
            type: '__transfer', of: m && m.type, id: m && m.id, buffers: all.length, listed: list.length,
            unlisted: all.filter((b) => !list.includes(b) && b.byteLength > 1024).length,
            detached: list.every((b) => b.byteLength === 0),
        });
    },
    set onmessage(fn) { parentPort.on('message', (d) => fn({ data: d })); },
};
await import('../../beta/ion-optics/js/workers/engine-worker.js');
