/**
 * 缺陷复现：inline Save 桥接缺少请求关联（request id），自动保存的回执会
 * 抢先「解决」用户手动 Save 的 pending Promise，导致授权遮罩还开着就弹出
 * 红色错误 Toast「Failed to save to the original file」。
 *
 * 根因：
 *   src/lib/platform.ts  saveInlineToOriginal() 监听的是无标识的
 *                        `mdnote:save-complete`，先到先得。
 *   src/content-md.ts    replySave() 回的也是无标识的 `mdnote:save-complete`。
 *   → useAutoSave（silentOnly:true）与 useFileOps.directSave（silentOnly:false）
 *     两条并发请求的回执会互相串台。
 *
 * 复现方式：手动 Save 弹出授权遮罩后，由 iframe 发出一条与 useAutoSave 完全
 * 相同的 silentOnly 保存请求（产品自身 60s 定时器发的就是这条消息）。
 *
 * 运行：node qa-r2-race-repro.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const EXT_DIR = '/Users/bot/Documents/MDnote/dist-extension';
const ORIG_PATH = '/Users/bot/Desktop/qa-race.md';
const ORIG_URL = 'file://' + ORIG_PATH;
const USER_DIR = '/tmp/mdnote-qa-race';

function enableFileAccess(userDir, extId) {
  for (const p of [
    path.join(userDir, 'Default', 'Preferences'),
    path.join(userDir, 'Default', 'Secure Preferences'),
  ]) {
    if (!fs.existsSync(p)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      const s = json?.extensions?.settings;
      if (s && s[extId]) { s[extId].allowFileAccess = true; fs.writeFileSync(p, JSON.stringify(json)); }
    } catch { /* ignore */ }
  }
}

const launch = () =>
  chromium.launchPersistentContext(USER_DIR, {
    headless: false, viewport: null,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`,
      '--allow-file-access-from-files', '--no-first-run', '--no-default-browser-check', '--window-size=1300,850'],
  });

async function main() {
  fs.writeFileSync(ORIG_PATH, '# Race\n\nRACE-ORIGINAL body.\n');
  fs.rmSync(USER_DIR, { recursive: true, force: true });

  let ctx = await launch();
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  const extId = /chrome-extension:\/\/([a-z]{32})\//.exec(sw.url())[1];
  await ctx.close();
  enableFileAccess(USER_DIR, extId);

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
  await page.waitForTimeout(5000);
  const frame = page.frames().find((f) => f.url().includes('editor.html'));
  if (!frame) { console.log('FATAL: no inline frame'); await ctx.close(); process.exit(2); }

  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));

  // 制造 dirty
  await frame.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /editor only/i.test(x.title || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(500);
  await frame.locator('.cm-content').first().click({ force: true }).catch(() => {});
  await frame.locator('.cm-content').first().type('\n\nRACE-EDIT\n').catch(() => {});
  await page.waitForTimeout(1200);

  // 1) 点 Save → 授权遮罩弹出，manual save 的 Promise 处于 pending
  await frame.locator('button[title*="Save"]').first().click({ force: true });
  await page.waitForTimeout(1500);
  const overlayOpen = await page.evaluate(() => !!document.getElementById('__mdnote_save_overlay'));
  console.log('① 手动 Save → 授权遮罩已弹出:', overlayOpen);

  const toastBefore = await frame.evaluate(() =>
    [...document.querySelectorAll('.toast-message')].map((e) => e.textContent));
  console.log('   此时 Toast:', JSON.stringify(toastBefore));

  // 2) 模拟 useAutoSave 的 60s 定时器：发出与产品完全相同的 silentOnly 保存请求
  await frame.evaluate(() => {
    window.parent.postMessage({
      type: 'mdnote:save-to-original',
      payload: {
        content: 'AUTOSAVE-SNAPSHOT',
        fileName: 'qa-race.md',
        filePath: '/Users/bot/Desktop/qa-race.md',
        silentOnly: true,          // ← useAutoSave 传的就是 true
      },
    }, '*');
  });
  await page.waitForTimeout(2000);

  const overlayStillOpen = await page.evaluate(() => !!document.getElementById('__mdnote_save_overlay'));
  const toastAfter = await frame.evaluate(() =>
    [...document.querySelectorAll('.toast-message')].map((e) => e.textContent));
  const toastTypes = await frame.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((e) => e.className));

  console.log('② 自动保存回执到达后：');
  console.log('   授权遮罩仍然开着:', overlayStillOpen);
  console.log('   Toast:', JSON.stringify(toastAfter));
  console.log('   Toast className:', JSON.stringify(toastTypes));
  console.log('   控制台:', JSON.stringify(logs.filter((l) => l.includes('MDnote'))));

  const bug = overlayStillOpen && toastAfter.some((t) => /fail/i.test(t || ''));
  console.log('\n结论：' + (bug
    ? '❌ 复现成功 —— 授权遮罩还开着，用户已看到「保存失败」红色 Toast（假失败）。'
    : '✅ 未复现'));

  fs.writeFileSync('/tmp/qa-r2-race.json', JSON.stringify(
    { overlayOpen, overlayStillOpen, toastBefore, toastAfter, toastTypes, logs, reproduced: bug }, null, 2));
  await ctx.close().catch(() => {});
  process.exit(bug ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
