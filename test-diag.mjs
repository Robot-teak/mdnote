import { chromium } from 'playwright';
const EXT_DIR = '/Users/bot/Documents/MDnote/dist-extension';
async function main() {
  const ctx = await chromium.launchPersistentContext('/tmp/mdnote-diag-' + Date.now(), {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--allow-file-access-from-files'],
  });
  const page = await ctx.newPage();

  // Capture ALL console
  page.on('console', m => console.log(`[P:${m.type()}] ${m.text()}`));

  await page.goto('file:///Users/bot/Desktop/untitled.md', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(7000);

  const iframe = page.frames().find(f => f.url().includes('editor.html'));
  if (iframe) iframe.on('console', m => console.log(`[F:${m.type()}] ${m.text()}`));

  // Inject diag code in iframe to trace save flow
  if (iframe) {
    await iframe.evaluate(() => {
      const orig = window.parent.postMessage.bind(window.parent);
      window.parent.postMessage = function(data, origin) {
        console.log('[DIAG] postMessage sent:', data?.type || 'NO_TYPE');
        return orig(data, origin);
      };
      console.log('[DIAG] iframe diag injected');
    });
  }

  // Inject diag in content script page
  await page.evaluate(() => {
    const orig = window.addEventListener.bind(window);
    window.addEventListener = function(type, handler, options) {
      if (type === 'message') {
        const wrapped = function(e) {
          console.log('[P-DIAG] message received:', e.data?.type || 'NO_TYPE');
          return handler(e);
        };
        return orig(type, wrapped, options);
      }
      return orig(type, handler, options);
    };
  });

  // Click Save button  
  console.log('[TEST] Clicking Save...');
  const saveBtn = iframe.locator('button:has-text("Save")');
  console.log(`[TEST] Save btn count: ${await saveBtn.count()}`);
  await saveBtn.first().click();
  await page.waitForTimeout(3000);

  console.log('[TEST] Done. Browser open.');
  await new Promise(() => {});
}
main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
