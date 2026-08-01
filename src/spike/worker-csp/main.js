/**
 * S0-1 Worker CSP Spike — main page script (ES module).
 *
 * Attempts three worker strategies and reports results:
 *   1. ES module worker via new URL()  (Vite worker:{format:'es'} equivalent)
 *   2. Blob worker (fallback candidate)
 *   3. Classic worker (degradation candidate)
 */

const resultEl = document.getElementById('result');
const log = [];

/** @param {string} msg @param {string} [cls] */
function append(msg, cls) {
  const span = cls ? `<span class="${cls}">${msg}</span>` : msg;
  log.push(span);
  resultEl.innerHTML = log.join('\n');
}

/**
 * Test 1: ES module worker via new URL().
 * This is what Vite emits when worker.format === 'es'.
 * @returns {Promise<string>}
 */
function testEsWorker() {
  return new Promise((resolve) => {
    try {
      const worker = new Worker(
        new URL('./md-worker.js', import.meta.url),
        { type: 'module' },
      );
      const timer = setTimeout(() => {
        worker.terminate();
        resolve('TIMEOUT (no response in 5s)');
      }, 5000);
      worker.addEventListener('message', (e) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(String(e.data));
      });
      worker.addEventListener('error', (e) => {
        clearTimeout(timer);
        worker.terminate();
        resolve('ERROR: ' + (e.message || 'unknown'));
      });
      worker.postMessage({ type: 'PING' });
    } catch (err) {
      resolve('THROW: ' + (err && err.message ? err.message : String(err)));
    }
  });
}

/**
 * Test 2: Blob worker — create from a Blob URL.
 * @returns {Promise<string>}
 */
function testBlobWorker() {
  return new Promise((resolve) => {
    try {
      const blob = new Blob(
        [`self.onmessage = (e) => { self.postMessage('BLOB_OK: ' + e.data.type); };`],
        { type: 'application/javascript' },
      );
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      const timer = setTimeout(() => {
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve('TIMEOUT (no response in 5s)');
      }, 5000);
      worker.addEventListener('message', (e) => {
        clearTimeout(timer);
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve(String(e.data));
      });
      worker.addEventListener('error', (e) => {
        clearTimeout(timer);
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve('ERROR: ' + (e.message || 'unknown'));
      });
      worker.postMessage({ type: 'PING' });
    } catch (err) {
      resolve('THROW: ' + (err && err.message ? err.message : String(err)));
    }
  });
}

/**
 * Test 3: Classic worker via relative path.
 * @returns {Promise<string>}
 */
function testClassicWorker() {
  return new Promise((resolve) => {
    try {
      const worker = new Worker('./md-worker-classic.js');
      const timer = setTimeout(() => {
        worker.terminate();
        resolve('TIMEOUT (no response in 5s)');
      }, 5000);
      worker.addEventListener('message', (e) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(String(e.data));
      });
      worker.addEventListener('error', (e) => {
        clearTimeout(timer);
        worker.terminate();
        resolve('ERROR: ' + (e.message || 'unknown'));
      });
      worker.postMessage({ type: 'PING' });
    } catch (err) {
      resolve('THROW: ' + (err && err.message ? err.message : String(err)));
    }
  });
}

async function run() {
  append('=== S0-1 Worker CSP Spike ===');
  append('');
  append('Test 1: ES module worker (new URL + type:module)...', 'info');
  const r1 = await testEsWorker();
  append('  Result: ' + r1, r1.startsWith('ES_OK') ? 'ok' : 'fail');
  append('');

  append('Test 2: Blob worker (URL.createObjectURL)...', 'info');
  const r2 = await testBlobWorker();
  append('  Result: ' + r2, r2.startsWith('BLOB_OK') ? 'ok' : 'fail');
  append('');

  append('Test 3: Classic worker (relative path)...', 'info');
  const r3 = await testClassicWorker();
  append('  Result: ' + r3, r3.startsWith('CLASSIC_OK') ? 'ok' : 'fail');
  append('');

  append('=== Done ===');
}

run();
