/**
 * 验证 FSAA 在 iframe 内可用性：需要真实用户手势
 */
import { chromium } from 'playwright';

const EXT_DIR = '/Users/bot/Documents/MDnote/dist-extension';
const TEST_FILE = 'file:///Users/bot/Documents/MDnote/CHANGELOG.md';

async function main() {
  const ctx = await chromium.launchPersistentContext('/tmp/mdnote-fsaa2-' + Date.now(), {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--allow-file-access-from-files'],
  });
  const page = await ctx.newPage();
  await page.goto(TEST_FILE, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(6000);
  const iframe = page.frames().find(f => f.url().includes('editor.html'));
  if (!iframe) { console.log('NO iframe'); await ctx.close(); return; }

  // Inject test button in iframe
  await iframe.evaluate(() => {
    const btn = document.createElement('button');
    btn.id = '__fsaa_test_save';
    btn.textContent = 'TEST SAVE FSAA';
    btn.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;padding:10px;background:red;color:white;';
    document.body.appendChild(btn);
    btn.onclick = async () => {
      try {
        // @ts-ignore
        const h = await window.showSaveFilePicker({ suggestedName: 'test.md' });
        btn.textContent = 'OK: ' + h.name;
        btn.style.background = 'green';
      } catch (e) {
        btn.textContent = 'ERR: ' + (e instanceof DOMException ? e.name : String(e));
        btn.style.background = 'orange';
      }
    };
  });

  console.log('[test] Clicking FSAA test button...');
  await iframe.locator('#__fsaa_test_save').click();
  await page.waitForTimeout(500);

  const result = await iframe.locator('#__fsaa_test_save').textContent();
  console.log(`[test] Save result: ${result}`);

  await ctx.close();
}
main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
