// worker_threads entry for Node runs: wires parentPort to the TPMC service (spec §2.13), exactly as
// js/workers/tpmc-worker.js wires self.onmessage in the browser.
import { parentPort } from 'node:worker_threads';
import { createService } from '../../beta/conductance/js/engine/tpmc-service.js';

const svc = createService((msg, transfer) => parentPort.postMessage(msg, transfer || []));
parentPort.on('message', (data) => svc.onMessage(data));
