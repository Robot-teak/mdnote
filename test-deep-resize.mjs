/**
 * 严格测试 inline editor 缩放：检查 iframe 内 React #root 尺寸
 */
import { chromium } from 'playwright';

const EXT_DIR = '/Users/bot/Documents/MDnote/dist-extension';
const TEST_FILE = 'file:///Users/bot/Documents/MDnote/CHANGELOG.md';

async function main() {
  const userDataDir = '/tmp/mdnote-deep-resize-' + Date.now();
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
  await page.waitForTimeout(6000); // 等 iframe 加载 + React 渲染

  // 用 Playwright frame API 访问跨域 iframe 内容
  async function checkLayout(label) {
    const iframe = page.locator('iframe').first();
    const iframeBox = await iframe.boundingBox();
    const viewport = page.viewportSize();

    const frames = page.frames();
    const iframeDoc = frames.find(f => f.url().includes('editor.html'));
    
    if (iframeDoc) {
      const rootSize = await iframeDoc.evaluate(() => {
        const root = document.getElementById('root');
        const app = document.querySelector('.app-container');
        const toolbar = document.querySelector('.toolbar');
        const main = document.querySelector('.editor-preview-container');
        return {
          root: root ? { w: root.getBoundingClientRect().width, h: root.getBoundingClientRect().height } : null,
          app: app ? { w: app.getBoundingClientRect().width, h: app.getBoundingClientRect().height } : null,
          toolbar: toolbar ? { w: toolbar.getBoundingClientRect().width, h: toolbar.getBoundingClientRect().height } : null,
          main: main ? { w: main.getBoundingClientRect().width, h: main.getBoundingClientRect().height } : null,
        };
      });
      console.log(`\n[${label}] vp=${viewport.width}x${viewport.height} iframe=${Math.round(iframeBox.width)}x${Math.round(iframeBox.height)}`);
      if (rootSize.root) console.log(`  root=${Math.round(rootSize.root.w)}x${Math.round(rootSize.root.h)} fills: ${Math.abs(rootSize.root.w - viewport.width) < 10 ? '✅' : '❌'}x${Math.abs(rootSize.root.h - viewport.height) < 10 ? '✅' : '❌'}`);
      if (rootSize.app) console.log(`  app=${Math.round(rootSize.app.w)}x${Math.round(rootSize.app.h)}`);
      if (rootSize.toolbar) console.log(`  toolbar=${Math.round(rootSize.toolbar.w)}x${Math.round(rootSize.toolbar.h)}`);
      if (rootSize.main) console.log(`  editor-preview=${Math.round(rootSize.main.w)}x${Math.round(rootSize.main.h)}`);
    } else {
      console.log(`\n[${label}] iframe frame NOT FOUND ❌`);
    }
    await page.screenshot({ path: `/tmp/mdnote-deep-${label}.png` });
  }

  await checkLayout('1-initial-1400x900');
  
  await page.setViewportSize({ width: 800, height: 600 });
  await page.waitForTimeout(1500);
  await checkLayout('2-small-800x600');
  
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.waitForTimeout(1500);
  await checkLayout('3-large-1800x1100');

  console.log('\n[test] ✅ Done. Browser stays open.');
  await new Promise(() => {});
}

main().catch(err => { console.error('[test] Fatal:', err.message); process.exit(1); });
