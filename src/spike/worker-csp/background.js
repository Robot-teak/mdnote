/**
 * S0-1 Worker CSP Spike — background service worker.
 *
 * Opens index.html in a new tab when the toolbar icon is clicked.
 * The index.html page then attempts to instantiate an ES module Worker
 * via `new Worker(new URL('./md-worker.js', import.meta.url), { type: 'module' })`.
 */

/** @param {chrome.tabs.Tab} _tab */
function openSpikeTab(_tab) {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
}

chrome.action.onClicked.addListener(openSpikeTab);
