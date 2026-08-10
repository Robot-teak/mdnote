/**
 * 第 2 轮 QA 前置探针：确定 B3-b（一次确认后直写原文件）能否自动化验证。
 *
 * 探测项：
 *  P1  file:// 顶级文档里 showDirectoryPicker() 是否真能调起（不抛 SecurityError）
 *  P2  CDP Page.setInterceptFileChooserDialog 能否拦截 FSAA 目录选择器
 *  P3  能否通过 CDP Runtime.evaluate 在「扩展 content script 隔离世界」里执行代码
 *      （用于给 showDirectoryPicker 打桩，或直接观测保存流程）
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const EXT_DIR = '/Users/bot/Documents/MDnote/dist-extension';
const ORIG_PATH = '/Users/bot/Desktop/qa-original.md';
const ORIG_URL = 'file:///Users/bot/Desktop/qa-original.md';
const USER_DIR = '/tmp/mdnote-qa-r2probe';

const log = (...a) => console.log(...a);

function enableFileAccess(userDir, extId) {
  for (const p of [
    path.join(userDir, 'Default', 'Preferences'),
    path.join(userDir, 'Default', 'Secure Preferences'),
  ]) {
    if (!fs.existsSync(p)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      const s = json?.extensions?.settings;
      if (s && s[extId]) {
        s[extId].allowFileAccess = true;
        fs.writeFileSync(p, JSON.stringify(json));
      }
    } catch {
      /* ignore */
    }
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
      '--window-size=1200,800',
    ],
  });

async function main() {
  fs.writeFileSync(ORIG_PATH, '# QA Original Doc\n\nQA-ORIGINAL-MARKER original inline content.\n');
  fs.rmSync(USER_DIR, { recursive: true, force: true });

  let ctx = await launch();
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  const extId = /chrome-extension:\/\/([a-z]{32})\//.exec(sw.url())[1];
  await ctx.close();
  enableFileAccess(USER_DIR, extId);
  log('extId =', extId);

  ctx = await launch();
  const setup = await ctx.newPage();
  await setup.goto(`chrome-extension://${extId}/editor.html`, { waitUntil: 'domcontentloaded' });
  await setup.waitForTimeout(1200);
  await setup.evaluate(() => chrome.storage.local.set({ onboardingShown: true }));

  await setup.evaluate((u) => chrome.tabs.create({ url: u }), ORIG_URL);
  let page = null;
  for (let i = 0; i < 80 && !page; i++) {
    page = ctx.pages().find((p) => p.url() === ORIG_URL) || null;
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  if (!page) { log('FATAL no file page'); await ctx.close(); process.exit(2); }
  await page.waitForTimeout(4000);

  const cdp = await ctx.newCDPSession(page);

  // ── P3: 找 content script 隔离世界的 executionContextId ──
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  await cdp.send('Runtime.enable');
  await page.waitForTimeout(800);
  log('\n─ P3 执行上下文 ─');
  for (const c of contexts) {
    log(`   id=${c.id} name="${c.name}" origin=${c.origin} aux=${JSON.stringify(c.auxData)}`);
  }
  const isolated = contexts.find(
    (c) => c.auxData && c.auxData.isDefault === false && String(c.origin).startsWith('chrome-extension'),
  ) || contexts.find((c) => c.auxData && c.auxData.isDefault === false);
  log('   → 选中的隔离世界:', isolated ? `id=${isolated.id} name="${isolated.name}"` : '(未找到)');

  if (isolated) {
    const r = await cdp
      .send('Runtime.evaluate', {
        expression: 'typeof window.showDirectoryPicker + "|" + (typeof cachedDirHandle)',
        contextId: isolated.id,
        returnByValue: true,
      })
      .catch((e) => ({ error: e.message }));
    log('   → 隔离世界内 eval 结果:', JSON.stringify(r?.result?.value ?? r));
  }

  // ── P2: 开启 filechooser 拦截，观察 FSAA 目录选择器是否触发事件 ──
  log('\n─ P2 CDP 拦截 FSAA 目录选择器 ─');
  let chooserEvent = null;
  cdp.on('Page.fileChooserOpened', (e) => { chooserEvent = e; });
  await cdp.send('Page.enable');
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });

  // ── P1: 主世界内以真实用户手势调用 showDirectoryPicker ──
  log('\n─ P1 file:// 顶级文档调用 showDirectoryPicker ─');
  await page.evaluate(() => {
    window.__probeResult = 'pending';
    const b = document.createElement('button');
    b.id = '__probe_btn';
    b.textContent = 'probe';
    b.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;width:200px;height:60px';
    b.addEventListener('click', async () => {
      try {
        const d = await window.showDirectoryPicker({ mode: 'readwrite' });
        window.__probeResult = 'granted:' + d.name;
      } catch (e) {
        window.__probeResult = 'threw:' + e.name + ':' + e.message;
      }
    });
    document.body.appendChild(b);
  });
  await page.click('#__probe_btn', { force: true });
  await page.waitForTimeout(3500);

  const probeResult = await page.evaluate(() => window.__probeResult).catch((e) => 'renderer-blocked:' + e.message);
  log('   → showDirectoryPicker 结果:', probeResult);
  log('   → CDP Page.fileChooserOpened 事件:', chooserEvent ? JSON.stringify(chooserEvent) : '(未触发 → 无法用 CDP 自动化原生面板)');

  // 若原生面板挂着，尝试用 CDP 取消
  if (chooserEvent) {
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }

  log('\n─ 结论 ─');
  log('P1 showDirectoryPicker 可用:', String(probeResult).startsWith('granted') || String(probeResult) === 'pending');
  log('P2 CDP 可拦截原生目录面板:', !!chooserEvent);
  log('P3 可在 content script 隔离世界执行代码:', !!isolated);

  fs.writeFileSync('/tmp/qa-r2-probe.json', JSON.stringify({ probeResult, chooserEvent, isolated: isolated || null, contexts }, null, 2));

  await ctx.close().catch(() => {});
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
