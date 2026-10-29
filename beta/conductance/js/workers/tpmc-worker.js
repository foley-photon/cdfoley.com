import { createService } from '../engine/tpmc-service.js';
const svc = createService((msg, transfer) => self.postMessage(msg, transfer || []));
self.onmessage = (e) => svc.onMessage(e.data);
