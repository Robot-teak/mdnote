/** 探测：Playwright/CDP 能否拦截 FSAA 的 showDirectoryPicker / showOpenFilePicker */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const EXT_DIR = '/Users/bot/Documents/MDnote/dist-extension';
const USER_DIR = '/tmp/mdnote-qa-probe2';
const URL = 'file:///Users/bot/Desktop/qa-original.md';

function enableFileAccess(userDir, extId) {
  for (const p of [
    path.join(userDir, 'Default', 'Preferences'),
    path.join(userDir, 'Default', 'Secure Preferences'),
  ]) {
    if (!fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j?.extensions?.settings?.[extId]) {
        j.extensions.settings[extId].allowFileAccess = true;
        fs.writeFileSync(p, JSON.stringify(j));
      }
    } catch {}
  }
}
const launch = () =>
  chromium.launchPersistentContext(USER_DIR, {
    headless: false,
    viewport: null,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--allow-file-access-from-files',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

const r = {};
let ctx = await launch();
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
const extId = /chrome-extension:\/\/([a-z]{32})\//.exec(sw.url())[1];
await ctx.close();
enableFileAccess(USER_DIR, extId);

ctx = await launch();
const p = await ctx.newPage();
await p.goto('file:///Users/bot/Desktop/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1000);

// 1) Playwright filechooser 事件是否对 FSAA 生效
let fcFired = null;
p.on('filechooser', (fc) => { fcFired = { multiple: fc.isMultiple() }; });

const cdp = await ctx.newCDPSession(p);
let cdpEvent = null;
await cdp.send('Page.enable');
cdp.on('Page.fileChooserOpened', (e) => { cdpEvent = e; });
try {
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
  r.interceptSupported = true;
} catch (e) {
  r.interceptSupported = 'ERR: ' + e.message.slice(0, 80);
}

// showOpenFilePicker（需 user activation → 用真实点击触发）
await p.evaluate(() => {
  window.__res = null;
  const b = document.createElement('button');
  b.id = 'probeOpen';
  b.textContent = 'open';
  b.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99999;padding:20px';
  b.onclick = async () => {
    try {
      const h = await window.showOpenFilePicker({ multiple: false });
      window.__res = { ok: true, name: h?.[0]?.name };
    } catch (err) { window.__res = { ok: false, err: err.name + ':' + err.message }; }
  };
  document.body.appendChild(b);
});
await p.click('#probeOpen');
await p.waitForTimeout(2500);
r.openPicker = { fcFired, cdpEvent: cdpEvent ? { mode: cdpEvent.mode } : null, res: await p.evaluate(() => window.__res) };

// 取消掉可能打开的原生框
await p.keyboard.press('Escape').catch(() => {});
await p.waitForTimeout(1200);

fcFired = null; cdpEvent = null;
await p.evaluate(() => {
  window.__res2 = null;
  const b = document.createElement('button');
  b.id = 'probeDir';
  b.textContent = 'dir';
  b.style.cssText = 'position:fixed;top:80px;left:10px;z-index:99999;padding:20px';
  b.onclick = async () => {
    try {
      const d = await window.showDirectoryPicker({ mode: 'readwrite' });
      window.__res2 = { ok: true, name: d?.name };
    } catch (err) { window.__res2 = { ok: false, err: err.name + ':' + err.message }; }
  };
  document.body.appendChild(b);
});
await p.click('#probeDir');
await p.waitForTimeout(2500);
r.dirPicker = { fcFired, cdpEvent: cdpEvent ? { mode: cdpEvent.mode } : null, res: await p.evaluate(() => window.__res2) };

console.log(JSON.stringify(r, null, 2));
await ctx.close().catch(() => {});
process.exit(0);
