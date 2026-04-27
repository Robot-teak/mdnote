/**
 * Markdown parser wrapper — manages the Web Worker lifecycle
 * and provides a clean API for rendering / TOC extraction / export.
 */
import type { TocItem, Theme, WorkerIncomingMessage, WorkerOutgoingMessage } from '../types';

let workerInstance: Worker | null = null;

/** Get or create the singleton MD worker */
function getWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new Worker(
      new URL('../workers/md-worker.ts', import.meta.url),
      { type: 'module' },
    );
  }
  return workerInstance;
}

/**
 * Send a message to the worker and wait for the response.
 * Uses a Promise wrapper around postMessage/onmessage.
 */
function sendToWorker<T extends WorkerOutgoingMessage['type']>(
  expectedType: T,
  message: WorkerIncomingMessage,
): Promise<Extract<WorkerOutgoingMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const worker = getWorker();
    const handler = (e: MessageEvent<WorkerOutgoingMessage>) => {
      if (e.data.type === 'ERROR') {
        worker.removeEventListener('message', handler);
        reject(new Error(e.data.message));
        return;
      }
      if (e.data.type === expectedType) {
        worker.removeEventListener('message', handler);
        resolve(e.data as Extract<WorkerOutgoingMessage, { type: T }>);
      }
    };

    worker.addEventListener('message', handler);
    worker.postMessage(message);

    // Safety timeout after 15s
    setTimeout(() => {
      worker.removeEventListener('message', handler);
      reject(new Error('Worker response timed out'));
    }, 15_000);
  });
}

/**
 * Render Markdown content → HTML string.
 */
export function renderMarkdown(content: string): Promise<string> {
  return sendToWorker(
    'RENDER_DONE',
    { type: 'RENDER', payload: content },
  ).then((r) => r.html);
}

/**
 * Extract table of contents from Markdown content.
 */
export function extractTocFromWorker(content: string): Promise<TocItem[]> {
  return sendToWorker(
    'EXTRACT_TOC_DONE',
    { type: 'EXTRACT_TOC', payload: content },
  ).then((r) => r.items);
}

/**
 * Export Markdown as a full standalone HTML document.
 */
export function exportAsHTML(mdContent: string, theme: Theme): Promise<string> {
  return sendToWorker(
    'EXPORT_HTML_DONE',
    { type: 'EXPORT_HTML', payload: { md: mdContent, theme } },
  ).then((r) => r.html);
}

/**
 * Terminate the worker (call on app cleanup).
 */
export function terminateWorker(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
  }
}
