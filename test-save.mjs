import { chromium } from 'playwright';
const EXT_DIR = '/Users/bot/Documents/MDnote/dist-extension';

async function main() {
  const ctx = await chromium.launchPersistentContext('/tmp/mdnote-save-' + Date.now(), {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--allow-file-access-from-files'],
  });
  const page = await ctx.newPage();
  await page.goto('file:///Users/bot/Desktop/untitled.md', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(6000);
  const iframe = page.frames().find(f => f.url().includes('editor.html'));
  if (!iframe) { console.log('NO iframe'); await ctx.close(); return; }

  // Collect logs
  page.on('console', m => { if (m.text().includes('MDnote') || m.text().includes('save')) console.log('[main]', m.text()); });
  iframe.on('console', m => { if (m.text().includes('MDnote') || m.text().includes('save')) console.log('[iframe]', m.text()); });

  // Dismiss onboarding first (it intercepts clicks)
  const onboarding = iframe.locator('.onboarding-overlay');
  if (await onboarding.count() > 0) {
    console.log('Dismissing onboarding...');
    const gotIt = iframe.locator('button:has-text("Got it")');
    if (await gotIt.count() > 0) await gotIt.click();
    else await onboarding.evaluate(el => el.remove());
    await page.waitForTimeout(1000);
  }

  // Click Save button
  console.log('Looking for Save button...');
  const saveBtn = iframe.locator('button:has-text("Save")');
  const count = await saveBtn.count();
  console.log(`Save buttons found: ${count}`);
  
  if (count > 0) {
    await saveBtn.first().click();
    await page.waitForTimeout(2000);
    
    // Check for overlay
    const overlay = page.locator('#__mdnote_save_overlay');
    const ovCount = await overlay.count();
    console.log(`Overlay elements: ${ovCount}`);
    if (ovCount > 0) {
      const text = await overlay.first().textContent();
      console.log(`Overlay text: "${text?.substring(0, 100)}"`);
      await overlay.first().click();
      await page.waitForTimeout(3000);
    }
  }

  console.log('Browser stays open.');
  await new Promise(() => {});
}
main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
