/**
 * 测试 inline editor：加载扩展，打开 file://.md，检查 iframe 是否注入
 */
import { chromium } from 'playwright';

const EXT_DIR = '/Users/bot/Documents/MDnote/dist-extension';
const TEST_FILE = 'file:///Users/bot/Documents/MDnote/CHANGELOG.md';

async function main() {
  // 使用 persistent context 加载扩展
  const userDataDir = '/tmp/mdnote-test-profile-' + Date.now();

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--allow-file-access-from-files',
    ],
  });

  console.log('[test] Browser launched with extension');

  // 等待扩展加载（需要一点时间让 SW 启动）
  await new Promise(r => setTimeout(r, 3000));

  // 捕获控制台日志
  const page = await context.newPage();
  const logs = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[MDnote]') || text.includes('mdnote')) {
      logs.push(`[${msg.type()}] ${text}`);
    }
  });
  page.on('pageerror', err => {
    logs.push(`[PAGE_ERROR] ${err.message}`);
  });

  // 导航到 .md 文件
  console.log(`[test] Navigating to ${TEST_FILE}`);
  await page.goto(TEST_FILE, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // 等待 iframe 注入（content script 运行在 document_idle）
  await page.waitForTimeout(5000);

  // 截图
  await page.screenshot({ path: '/tmp/mdnote-test-screenshot.png', fullPage: false });
  console.log('[test] Screenshot saved to /tmp/mdnote-test-screenshot.png');

  // 检查 iframe 是否注入
  const iframeCount = await page.locator('iframe').count();
  console.log(`[test] iframe count: ${iframeCount}`);
  if (iframeCount > 0) {
    const iframeSrc = await page.locator('iframe').first().getAttribute('src');
    console.log(`[test] iframe src: ${iframeSrc}`);
  }

  // 检查 body 内容
  const bodyHTML = await page.evaluate(() => document.body.innerHTML.substring(0, 500));
  console.log(`[test] body HTML (first 500 chars): ${bodyHTML}`);

  // 检查 opacity
  const opacity = await page.evaluate(() => document.documentElement.style.opacity);
  console.log(`[test] documentElement opacity: "${opacity}"`);

  // 打印控制台日志
  console.log(`\n[test] Console logs (${logs.length}):`);
  logs.forEach(l => console.log('  ' + l));

  // 等待 iframe ready（最多 10 秒）
  console.log('[test] Waiting for iframe ready signal...');
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    const op = await page.evaluate(() => document.documentElement.style.opacity);
    if (op !== '0') {
      console.log(`[test] ✅ opacity restored at t+${i + 6}s: "${op}"`);
      break;
    }
  }

  // 最终截图
  await page.screenshot({ path: '/tmp/mdnote-test-final.png', fullPage: false });
  console.log('[test] Final screenshot saved');

  console.log('[test] ✅ Browser stays open. Close Chrome manually when done.');
  // Keep browser alive — do NOT close
  await new Promise(() => {});
}

main().catch(err => {
  console.error('[test] Fatal:', err.message);
  process.exit(1);
});
