import { chromium } from 'playwright';
const EXT_DIR = '/Users/bot/Documents/MDnote/dist-extension';
async function main() {
  const ctx = await chromium.launchPersistentContext('/tmp/mdnote-s2-' + Date.now(), {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--allow-file-access-from-files'],
  });
  const page = await ctx.newPage();
  page.on('console', m => console.log(`[${m.type()}] ${m.text()}`));
  await page.goto('file:///Users/bot/Desktop/untitled.md', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(7000);
  const iframe = page.frames().find(f => f.url().includes('editor.html'));

  // Dismiss onboarding
  const gotIt = iframe?.locator('button:has-text("Got it")');
  if (await gotIt?.count() > 0) { await gotIt.click(); await page.waitForTimeout(1000); }

  // Click Save
  await iframe?.locator('button:has-text("Save")').first().click();
  await page.waitForTimeout(2000);

  // Check all body children
  const bodyKids = await page.evaluate(() => {
    const kids = document.body.children;
    const result = [];
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      result.push({
        tag: el.tagName,
        id: el.id,
        style: el.getAttribute('style')?.substring(0, 100),
        text: el.textContent?.substring(0, 80),
        zIndex: getComputedStyle(el).zIndex,
      });
    }
    return result;
  });
  console.log(`Body children: ${bodyKids.length}`);
  bodyKids.forEach((k, i) => console.log(`  [${i}] ${k.tag}#${k.id} z=${k.zIndex} text="${k.text}"`));

  console.log('Browser open.');
  await new Promise(() => {});
}
main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
