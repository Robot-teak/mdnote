/**
 * 用 untitled.md 精确测试 Save + Resize
 */
import { chromium } from 'playwright';
const EXT_DIR = '/Users/bot/Documents/MDnote/dist-extension';

async function main() {
  const ctx = await chromium.launchPersistentContext('/tmp/mdnote-real-' + Date.now(), {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--allow-file-access-from-files'],
    // NO viewport setting — let window size be natural
  });
  const page = await ctx.newPage();

  // === Open test file ===
  const TEST = 'file:///Users/bot/Desktop/untitled.md';
  console.log(`[test] Opening ${TEST}`);
  await page.goto(TEST, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(6000);

  const iframe = page.frames().find(f => f.url().includes('editor.html'));
  if (!iframe) { console.log('NO iframe'); await ctx.close(); return; }

  // === TEST 1: Resize by changing viewport (simulating drag) ===
  console.log('\n--- RESIZE TEST ---');
  for (const [w, h] of [[1200, 800], [700, 500], [1600, 1000]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(800);
    const dims = await iframe.evaluate(() => ({
      iw: window.innerWidth, ih: window.innerHeight,
      rootW: document.getElementById('root')?.getBoundingClientRect().width,
      rootH: document.getElementById('root')?.getBoundingClientRect().height,
      appW: document.querySelector('.app-container')?.getBoundingClientRect().width,
      appH: document.querySelector('.app-container')?.getBoundingClientRect().height,
      sbBottom: document.querySelector('.status-bar')?.getBoundingClientRect().bottom,
      tbRight: document.querySelector('.toolbar')?.getBoundingClientRect().right,
    }));
    const sbOk = dims.sbBottom === dims.ih;
    const tbOk = dims.tbRight === dims.iw;
    console.log(`  ${w}x${h}: inner=${dims.iw}x${dims.ih} root=${dims.rootW}x${dims.rootH} app=${dims.appW}x${dims.appH} | sb=${dims.sbBottom} ${sbOk?'✅':'❌'} tb=${dims.tbRight} ${tbOk?'✅':'❌'}`);
  }

  // === TEST 2: Save (⌘S) ===
  console.log('\n--- SAVE TEST ---');
  // First modify content to make it dirty
  await iframe.evaluate(() => {
    // Trigger save via keyboard
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', metaKey: true, bubbles: true }));
  });
  await page.waitForTimeout(1000);
  
  // Check for overlay in parent page (content script creates it)
  // 注意：用稳定的 id 选择器。旧写法按 z-index 2147483648 匹配已失效
  // （z-index 上限是 int32 的 2147483647，现在遮罩用的就是 2147483647）。
  const overlay = await page.evaluate(() => {
    const el = document.getElementById('__mdnote_save_overlay');
    return el ? el.textContent?.substring(0, 100) : null;
  });
  console.log(`  Overlay: ${overlay || 'NOT FOUND'}`);

  // Check toast in iframe
  const toast = await iframe.evaluate(() => {
    const t = document.querySelector('.toast, [class*="toast"]');
    return t?.textContent || 'no toast';
  });
  console.log(`  Toast: "${toast}"`);

  // Click overlay
  if (overlay) {
    const overlayEl = page.locator('#__mdnote_save_overlay');
    if (await overlayEl.count() > 0) {
      console.log('  Clicking overlay...');
      await overlayEl.click();
      await page.waitForTimeout(2000);
      const toast2 = await iframe.evaluate(() => {
        const t = document.querySelector('.toast, [class*="toast"]');
        return t?.textContent || 'no toast';
      });
      console.log(`  After click toast: "${toast2}"`);
    }
  }

  // === TEST 3: New button ===
  console.log('\n--- NEW TEST ---');
  const beforeCount = ctx.pages().length;
  await iframe.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const b of btns) { if (b.textContent?.includes('New')) { b.click(); break; } }
  });
  await page.waitForTimeout(3000);
  const afterCount = ctx.pages().length;
  console.log(`  Pages: ${beforeCount} → ${afterCount}`);
  
  // Check new tab state
  const newPage = ctx.pages()[ctx.pages().length - 1];
  console.log(`  New tab URL: ${newPage.url().substring(0,80)}`);

  console.log('\n[test] ✅ Browser stays open.');
  await new Promise(() => {});
}
main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
