import { createHandler } from '../engine/worker-core.js';
const handle = createHandler({ post: (m, t) => self.postMessage(m, t || []) });
self.onmessage = (e) => handle(e.data);
