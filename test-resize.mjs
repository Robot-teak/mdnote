/**
 * 测试 inline editor 窗口缩放
 */
import { chromium } from 'playwright';

const EXT_DIR = '/Users/bot/Documents/MDnote/dist-extension';
const TEST_FILE = 'file:///Users/bot/Documents/MDnote/CHANGELOG.md';

async function main() {
  const userDataDir = '/tmp/mdnote-resize-test-' + Date.now();

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--allow-file-access-from-files',
    ],
  });

  const page = await context.newPage();
  await page.goto(TEST_FILE, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(5000); // wait for iframe injection + editor load

  // Screenshot 1: initial size
  await page.screenshot({ path: '/tmp/mdnote-resize-1-initial.png' });
  console.log('[test] Screenshot 1: 1400x900');

  // Resize to smaller
  await page.setViewportSize({ width: 800, height: 600 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/mdnote-resize-2-small.png' });
  console.log('[test] Screenshot 2: 800x600');

  // Resize to larger
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/mdnote-resize-3-large.png' });
  console.log('[test] Screenshot 3: 1800x1100');

  // Check if iframe has correct size
  const iframeBox = await page.locator('iframe').first().boundingBox();
  console.log(`[test] iframe size: ${iframeBox?.width}x${iframeBox?.height}`);

  // Check if iframe fits viewport
  const viewport = page.viewportSize();
  console.log(`[test] viewport: ${viewport?.width}x${viewport?.height}`);
  if (iframeBox && viewport) {
    const wOk = Math.abs(iframeBox.width - viewport.width) < 5;
    const hOk = Math.abs(iframeBox.height - viewport.height) < 5;
    console.log(`[test] iframe fills viewport: ${wOk && hOk ? 'YES ✅' : `NO ❌ (diff: ${Math.round(iframeBox.width - viewport.width)}, ${Math.round(iframeBox.height - viewport.height)})`}`);
  }

  console.log('[test] ✅ Browser stays open. Close Chrome manually when done.');
  await new Promise(() => {});
}

main().catch(err => { console.error('[test] Fatal:', err.message); process.exit(1); });
