import { chromium } from 'playwright';

const URL = 'http://localhost:1420/';
const log = (...a) => console.log('[repro]', ...a);

const browser = await chromium.launch();
const page = await browser.newPage();

const consoleMsgs = [];
const pageErrors = [];
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => pageErrors.push(String((e && e.stack) || e)));

log('goto', URL);
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.toolbar', { timeout: 15000 });
await page.waitForTimeout(800);

const read = () => page.evaluate(() => {
  const root = document.documentElement;
  const preview = document.querySelector('.preview-pane');
  const cm = document.querySelector('.cm-content');
  const ls = localStorage.getItem('mdnote-settings');
  let parsed = null; try { parsed = ls ? JSON.parse(ls) : null; } catch {}
  return {
    inlineFontSize: root.style.getPropertyValue('--editor-font-size'),
    inlineFontFamily: root.style.getPropertyValue('--editor-font-family'),
    inlineLineHeight: root.style.getPropertyValue('--editor-line-height'),
    inlineParaSpacing: root.style.getPropertyValue('--preview-paragraph-spacing'),
    previewComputedFontSize: preview ? getComputedStyle(preview).fontSize : 'NO_PREVIEW',
    cmComputedFontSize: cm ? getComputedStyle(cm).fontSize : 'NO_CM',
    hasEditor: !!document.querySelector('.cm-editor'),
    hasWelcome: !!document.querySelector('.welcome-screen'),
    ls: parsed,
  };
});

log('INITIAL', JSON.stringify(await read(), null, 2));

// ---- open Settings ----
log('open Settings');
await page.click('.toolbar-right button[title="Settings"]');
await page.waitForSelector('.settings-dialog', { timeout: 8000 });
await page.waitForTimeout(300);

// change font size slider to 24
log('set font size -> 24');
await page.evaluate(() => {
  const s = document.querySelector('.settings-slider');
  s.value = '24';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(400);

// change paragraph spacing to 2em
log('set paragraph spacing -> 2em');
await page.evaluate(() => {
  const sel = document.querySelectorAll('.settings-select');
  // find the paragraph spacing select (Preview Style section, last select)
  // Easier: match by current value default '1em'
  let target = null;
  for (const s of sel) {
    for (const o of s.options) {
      if (o.value === '2em') { target = s; break; }
    }
    if (target) break;
  }
  if (target) {
    target.value = '2em';
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
await page.waitForTimeout(400);

// change line height to 2.0
log('set line height -> 2.0');
await page.evaluate(() => {
  const sel = document.querySelectorAll('.settings-select');
  let target = null;
  for (const s of sel) {
    for (const o of s.options) {
      if (o.value === '2') { target = s; break; }
    }
    if (target) break;
  }
  if (target) {
    target.value = '2';
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
await page.waitForTimeout(400);

// close settings
log('close Settings');
await page.click('.settings-btn-primary');
await page.waitForTimeout(600);

const afterChange = await read();
log('AFTER_CHANGE', JSON.stringify(afterChange, null, 2));

// ---- try to mount editor via New Document ----
log('try New Document to mount editor');
try {
  await page.click('.toolbar-file-ops button[title="New Document (⌘N)"]');
  await page.waitForSelector('.cm-editor', { timeout: 8000 });
  log('editor mounted');
  await page.waitForTimeout(500);
  // change font size again now that editor is mounted
  await page.click('.toolbar-right button[title="Settings"]');
  await page.waitForSelector('.settings-dialog', { timeout: 8000 });
  await page.evaluate(() => {
    const s = document.querySelector('.settings-slider');
    s.value = '20';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  await page.click('.settings-btn-primary');
  await page.waitForTimeout(500);
  const afterEditorChange = await read();
  log('AFTER_EDITOR_CHANGE', JSON.stringify(afterEditorChange, null, 2));
} catch (e) {
  log('editor mount/change failed:', e.message);
  log('DOM after New Document attempt:', JSON.stringify(await read(), null, 2));
}

log('===== CONSOLE (error/warn) =====');
consoleMsgs.filter(m => /error|warn/i.test(m)).slice(0, 30).forEach(m => log('  ', m));
log('===== PAGE ERRORS =====');
pageErrors.slice(0, 30).forEach(e => log('  ', e.split('\n').slice(0,4).join('\n')));

await browser.close();
log('done');
