/**
 * S0-1 Worker CSP Spike — ES module worker.
 * Responds to PING with ES_OK to confirm the ES module worker loaded.
 */

self.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg && msg.type === 'PING') {
    self.postMessage('ES_OK: module worker alive');
  }
});
