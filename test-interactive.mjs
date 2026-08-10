/**
 * 交互式测试：Open、Save、New、Resize
 */
import { chromium } from 'playwright';

const EXT_DIR = '/Users/bot/Documents/MDnote/dist-extension';
const TEST_FILE = 'file:///Users/bot/Documents/MDnote/CHANGELOG.md';

async function main() {
  const userDataDir = '/tmp/mdnote-interactive-' + Date.now();
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

  // Capture ALL console from ALL frames
  const logs = [];
  page.on('console', msg => {
    const frame = msg.location()?.url || page.url();
    logs.push(`[main:${msg.type()}] ${msg.text()}`);
  });
  // Also capture from iframe
  const frames = page.frames.bind(page);

  await page.goto(TEST_FILE, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(6000);

  // Find iframe frame
  const iframeFrame = page.frames().find(f => f.url().includes('editor.html'));
  if (iframeFrame) {
    iframeFrame.on('console', msg => {
      logs.push(`[iframe:${msg.type()}] ${msg.text()}`);
    });
  }

  console.log('[test] Page loaded. Now testing:');

  // === TEST 1: Resize ===
  await page.setViewportSize({ width: 800, height: 600 });
  await page.waitForTimeout(1000);
  if (iframeFrame) {
    const size = await iframeFrame.evaluate(() => {
      const r = document.getElementById('root');
      return r ? `${r.getBoundingClientRect().width}x${r.getBoundingClientRect().height}` : 'N/A';
    });
    console.log(`[test] After resize to 800x600: root=${size} (expected ~800x600)`);
  }

  // === TEST 2: Click Save ===
  console.log('[test] Clicking Save button (⌘S)...');
  if (iframeFrame) {
    await iframeFrame.evaluate(() => {
      // Dispatch Cmd+S
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 's', code: 'KeyS', metaKey: true, bubbles: true
      }));
    });
    await page.waitForTimeout(2000);
    const toast = await iframeFrame.evaluate(() => {
      const t = document.querySelector('.toast');
      return t ? t.textContent : 'no toast';
    });
    console.log(`[test] Toast after Save: "${toast}"`);
    
    // Check if download was initiated
    const downloads = await context.pages();
    console.log(`[test] Open pages after save: ${downloads.length}`);
  }

  // === TEST 3: Click Open ===
  console.log('[test] Clicking Open button...');
  if (iframeFrame) {
    // Find Open button
    const openBtn = await iframeFrame.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        if (b.textContent?.includes('Open')) return b.textContent;
      }
      return 'NOT FOUND';
    });
    console.log(`[test] Open button text: "${openBtn}"`);
  }

  // === TEST 4: NEW ===
  console.log('[test] Clicking New button...');
  if (iframeFrame) {
    await iframeFrame.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        if (b.textContent?.includes('New')) { b.click(); break; }
      }
    });
    await page.waitForTimeout(2000);
    const allPages = context.pages();
    console.log(`[test] Pages after New: ${allPages.length}`);
    for (const p of allPages) {
      console.log(`[test]   Page: ${p.url().substring(0, 80)}`);
    }
  }

  // === FINAL: Logs ===
  console.log(`\n[test] Console logs (${logs.length}):`);
  logs.filter(l => l.includes('MDnote') || l.includes('ERROR')).forEach(l => console.log(`  ${l}`));
  logs.slice(-5).forEach(l => console.log(`  ${l}`));

  console.log('\n[test] ✅ Browser stays open.');
  await new Promise(() => {});
}

main().catch(err => { console.error('[test] Fatal:', err.message); process.exit(1); });
