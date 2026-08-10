import { chromium } from 'playwright';
const URL = 'http://localhost:1420/';
const log = (...a) => console.log('[fs]', ...a);

const browser = await chromium.launch();
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.toolbar', { timeout: 15000 });
await page.waitForTimeout(600);

const read = () => page.evaluate(() => ({
  inlineFontSize: document.documentElement.style.getPropertyValue('--editor-font-size'),
  lsFontSize: (() => { try { return JSON.parse(localStorage.getItem('mdnote-settings')).fontSize; } catch { return 'NONE'; } })(),
  previewFontSize: (() => { const p = document.querySelector('.preview-pane'); return p ? getComputedStyle(p).fontSize : 'NO_PREVIEW'; })(),
}));

log('INITIAL', JSON.stringify(await read()));

await page.click('.toolbar-right button[title="Settings"]');
await page.waitForSelector('.settings-dialog', { timeout: 8000 });
await page.waitForTimeout(300);

// METHOD 1: Playwright native fill (handles React value tracker)
let method = 'fill';
try {
  await page.locator('.settings-slider').fill('22');
} catch (e) {
  log('fill failed:', e.message, '-> fallback to keyboard');
  method = 'keyboard';
  const slider = page.locator('.settings-slider');
  await slider.focus();
  // move to min then arrow up to 22 (min=12, so 10 arrows)
  await page.keyboard.press('Home');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
}
await page.waitForTimeout(300);
log('after interaction (method=' + method + ')', JSON.stringify(await read()));

// close and re-open to ensure persisted
await page.click('.settings-btn-primary');
await page.waitForTimeout(400);
log('AFTER_CLOSE', JSON.stringify(await read()));

// reopen and check the slider reflects 22
await page.click('.toolbar-right button[title="Settings"]');
await page.waitForSelector('.settings-dialog', { timeout: 8000 });
const sliderVal = await page.evaluate(() => document.querySelector('.settings-slider').value);
const displayVal = await page.evaluate(() => document.querySelector('.settings-value')?.textContent);
log('slider value now:', sliderVal, '| display:', displayVal);
await page.click('.settings-btn-primary');

log('PAGE ERRORS:', errs.length ? errs.slice(0,5) : 'none');
await browser.close();
log('done');
