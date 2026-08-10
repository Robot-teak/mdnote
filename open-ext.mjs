// 仅用于手动测试：用 Playwright headless:false 启动 Chromium 并加载 MDnote 扩展，
// 自动开启 "Allow access to file URLs"，打开两个标签后保持窗口打开（不自动点击）。
// 用法：node open-ext.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const EXT = '/Users/bot/Documents/MDnote/dist-extension';
const TEST_FILE = 'file:///Users/bot/Desktop/untitled.md';
const USER_DIR = '/tmp/mdnote-manual-profile';

fs.rmSync(USER_DIR, { recursive: true, force: true });

async function getExtId(ctx) {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
  const m = sw && /chrome-extension:\/\/([a-z]{32})\//.exec(sw.url());
  return m ? m[1] : null;
}
function enableFileAccess(dir, extId) {
  for (const p of [path.join(dir, 'Default', 'Preferences'), path.join(dir, 'Default', 'Secure Preferences')]) {
    if (!fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const s = j?.extensions?.settings;
      if (s && s[extId]) { s[extId].allowFileAccess = true; fs.writeFileSync(p, JSON.stringify(j)); }
    } catch { /* ignore */ }
  }
}
const LOG = '/tmp/mdnote-open-ext.log';
const wlog = (s) => { fs.appendFileSync(LOG, s + '\n'); console.log(s); };
fs.writeFileSync(LOG, '');

async function launch() {
  return chromium.launchPersistentContext(USER_DIR, {
    headless: false,
    viewport: null,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--allow-file-access-from-files',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1400,900',
    ],
  });
}

// 1) 首启拿扩展 id
wlog('[1] 首次启动获取扩展 id...');
let ctx = await launch();
wlog('[1] 浏览器已启动');
const extId = await getExtId(ctx);
await ctx.close();
if (!extId) { wlog('FATAL: extension id not found'); process.exit(1); }
wlog('Extension id: ' + extId);
// 2) 自动开启 file:// 访问授权
enableFileAccess(USER_DIR, extId);
wlog('已开启 Allow access to file URLs');

// 3) 重启 + 打开标签，保持窗口
ctx = await launch();
wlog('[3] 重启完成，打开标签');
const setup = await ctx.newPage();
await setup.goto(`chrome-extension://${extId}/editor.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await setup.evaluate(() => chrome.tabs.create({ url: 'chrome://extensions' })).catch(() => {});
await setup.evaluate(async (url) => { await chrome.tabs.create({ url }); }, TEST_FILE).catch(() => {});
wlog('✅ 浏览器已打开，扩展已加载，Allow access to file URLs=ON。请手动测试；关掉窗口即结束。');
await new Promise(() => {}); // 保持进程/窗口常驻
