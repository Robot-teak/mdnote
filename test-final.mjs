/**
 * 最终验证：布局截图 + New 空白页
 */
import { chromium } from 'playwright';
const EXT_DIR = '/Users/bot/Documents/MDnote/dist-extension';
const TEST_FILE = 'file:///Users/bot/Documents/MDnote/CHANGELOG.md';

async function main() {
  const ctx = await chromium.launchPersistentContext('/tmp/mdnote-final-' + Date.now(), {
    headless: false, viewport: { width: 1400, height: 900 },
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--allow-file-access-from-files'],
  });
  const page = await ctx.newPage();
  await page.goto(TEST_FILE, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(6000);
  const iframe = page.frames().find(f => f.url().includes('editor.html'));
  if (!iframe) { console.log('NO iframe'); await ctx.close(); return; }

  // 初始截图
  await page.screenshot({ path: '/tmp/mdnote-final-1400x900.png' });
  console.log('[1] 1400x900 screenshot saved');

  // Resize to small
  await page.setViewportSize({ width: 800, height: 600 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/mdnote-final-800x600.png' });
  
  // 检查关键元素位置
  const el = await iframe.evaluate(() => {
    const statusBar = document.querySelector('.status-bar');
    const toolbar = document.querySelector('.toolbar');
    const exportBtn = document.querySelector('[title*="Export"]') || document.querySelector('button:has-text("Export")');
    return {
      statusBar: statusBar ? { bottom: statusBar.getBoundingClientRect().bottom, left: statusBar.getBoundingClientRect().left, width: statusBar.getBoundingClientRect().width } : null,
      toolbar: toolbar ? { right: toolbar.getBoundingClientRect().right, width: toolbar.getBoundingClientRect().width } : null,
      vh: window.innerHeight,
      vw: window.innerWidth,
    };
  });
  console.log(`[2] 800x600: vh=${el.vh} vw=${el.vw}`);
  if (el.statusBar) {
    const sbBottom = Math.round(el.statusBar.bottom);
    const ok = sbBottom === el.vh;
    console.log(`  statusBar bottom=${sbBottom} expected=${el.vh} ${ok ? '✅' : '❌'}`);
  }
  if (el.toolbar) {
    const trRight = Math.round(el.toolbar.right);
    const ok = trRight === el.vw;
    console.log(`  toolbar right=${trRight} expected=${el.vw} ${ok ? '✅' : '❌'}`);
  }

  // Test New: 点击 New → 新标签页应是空白文档
  if (iframe) {
    await iframe.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        if (b.textContent?.includes('New')) { b.click(); break; }
      }
    });
    await page.waitForTimeout(3000);
    const newPage = ctx.pages()[ctx.pages().length - 1];
    console.log(`[3] New tab URL: ${newPage.url().substring(0,80)}`);
    
    // 检查新标签页的 React 内容
    const newFrame = newPage.frames()[0];
    if (newFrame) {
      const isWelcome = await newFrame.evaluate(() => {
        return !!document.querySelector('.welcome-screen');
      });
      const isBlank = await newFrame.evaluate(() => {
        return document.querySelector('.app-container') && !document.querySelector('.welcome-screen') && document.querySelector('.editor-preview-container');
      });
      console.log(`[3] New tab: welcome=${isWelcome} blank-editor=${isBlank}`);
    }
  }

  console.log('[test] ✅ Browser stays open.');
  await new Promise(() => {});
}
main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
