/**
 * S0-1 Worker CSP Spike — classic worker (non-module).
 * Responds to PING with CLASSIC_OK.
 */

self.addEventListener('message', (e) => {
  var msg = e.data;
  if (msg && msg.type === 'PING') {
    self.postMessage('CLASSIC_OK: classic worker alive');
  }
});
