import { createService } from '../engine/prep-service.js';
const svc = createService((msg, transfer) => self.postMessage(msg, transfer || []));
self.onmessage = (e) => svc.onMessage(e.data);
