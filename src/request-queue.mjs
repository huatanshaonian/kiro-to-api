export class RequestQueue {
  constructor(limit = 2, maxWaiting = 8, waitMs = 30000) { this.limit = limit; this.maxWaiting = maxWaiting; this.waitMs = waitMs; this.active = 0; this.waiting = []; }
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('Client disconnected.'), { status: 499 }));
    if (this.active < this.limit) { this.active++; return Promise.resolve(this.releaseOnce()); }
    if (this.waiting.length >= this.maxWaiting) return Promise.reject(Object.assign(new Error('Gateway request queue is full.'), { status: 429 }));
    return new Promise((resolve, reject) => {
      const entry = { grant: () => { cleanup(); this.active++; resolve(this.releaseOnce()); } };
      const fail = (status, message) => { this.waiting = this.waiting.filter(item => item !== entry); cleanup(); reject(Object.assign(new Error(message), { status })); };
      const abort = () => fail(499, 'Client disconnected while waiting.');
      const timer = setTimeout(() => fail(429, 'Gateway request queue timed out.'), this.waitMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.waiting.push(entry); signal?.addEventListener('abort', abort, { once: true });
    });
  }
  releaseOnce() {
    let released = false;
    return () => { if (released) return; released = true; this.active--; this.waiting.shift()?.grant(); };
  }
}
