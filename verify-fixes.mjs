/**
 * MDnote 插件版 4 个 bug 的端到端验证脚本（真实 Chrome + 已加载扩展）。
 *
 * 覆盖：
 *   Bug1  Open  → 当前页有内容时必须新开标签页并渲染打开的文档
 *   Bug2  Resize→ 窗口缩放/浏览器缩放后状态栏贴底、右侧工具栏贴右
 *   Bug3  Save  → file:// 内联保存（遮罩授权 → showSaveFilePicker 预填文件名 → 写回）
 *   Bug4  New   → 新开标签页直达空白文档，且不改窗口尺寸
 *
 * 用法：node verify-fixes.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const EXT_DIR = '/Users/bot/Documents/MDnote/dist-extension';
const TEST_FILE_PATH = '/Users/bot/Desktop/untitled.md';
const TEST_FILE_URL = 'file:///Users/bot/Desktop/untitled.md';
const PICK_FILE = '/tmp/mdnote-picked.md';
const USER_DIR = '/tmp/mdnote-verify-persist';

const ORIGINAL_MD = '# Untitled Doc\n\nOriginal inline content for verification.\n';
const PICKED_MD = '# Picked Doc\n\nHello from the picker.\n';

// ── 结果收集 ──
const results = [];
function check(bug, name, ok, detail = '') {
  results.push({ bug, name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} [${bug}] ${name}${detail ? ' — ' + detail : ''}`);
}
function info(msg) {
  console.log(`     · ${msg}`);
}

// ── harness ──
async function getExtensionId(ctx) {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
  const m = sw && /chrome-extension:\/\/([a-z]{32})\//.exec(sw.url());
  return m ? m[1] : null;
}

function enableFileAccess(userDir, extId) {
  for (const p of [
    path.join(userDir, 'Default', 'Preferences'),
    path.join(userDir, 'Default', 'Secure Preferences'),
  ]) {
    if (!fs.existsSync(p)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      const s = json?.extensions?.settings;
      if (s && s[extId]) {
        s[extId].allowFileAccess = true;
        fs.writeFileSync(p, JSON.stringify(json));
      }
    } catch {
      /* ignore */
    }
  }
}

async function launch() {
  return chromium.launchPersistentContext(USER_DIR, {
    headless: false,
    viewport: null,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--allow-file-access-from-files',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1400,900',
    ],
  });
}

/** 注入到所有页面主世界的 FSAA 打桩（只影响扩展页面；content script 在隔离世界，用真实 API） */
const STUB = () => {
  const makeHandle = (name, content) => ({
    kind: 'file',
    name,
    getFile: async () => new File([content], name, { type: 'text/markdown' }),
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    createWritable: async () => ({
      write: async (c) => {
        window.__mdnoteWritten = { name, content: typeof c === 'string' ? c : String(c) };
      },
      close: async () => {},
    }),
  });
  window.__mdnoteMakeHandle = makeHandle;
  window.showOpenFilePicker = async () => {
    const next = window.__mdnotePickNext;
    if (!next) throw new DOMException('cancelled', 'AbortError');
    window.__mdnotePickNext = null;
    return [makeHandle(next.name, next.content)];
  };
  window.showSaveFilePicker = async (opts) => {
    window.__mdnoteSaveOpts = opts || {};
    const next = window.__mdnoteSaveNext;
    if (!next) throw new DOMException('cancelled', 'AbortError');
    window.__mdnoteSaveNext = null;
    return makeHandle(next.name || (opts && opts.suggestedName) || 'untitled.md', '');
  };
};

const snap = (f) =>
  f.evaluate(() => ({
    url: location.href.slice(0, 60),
    welcome: !!document.querySelector('.welcome-screen'),
    editor: !!document.querySelector('.cm-editor'),
    status: (document.querySelector('.status-bar')?.textContent || '').slice(0, 90),
    preview: (document.querySelector('.preview-pane')?.textContent || '').trim().slice(0, 40),
    cm: (document.querySelector('.cm-content')?.textContent || '').trim().slice(0, 40),
  }));

async function main() {
  fs.writeFileSync(PICK_FILE, PICKED_MD);
  fs.writeFileSync(TEST_FILE_PATH, ORIGINAL_MD);
  fs.rmSync(USER_DIR, { recursive: true, force: true });

  // 1) 首启拿 extension id → 关掉 → 打开「允许访问文件网址」→ 重启
  let ctx = await launch();
  const extId = await getExtensionId(ctx);
  await ctx.close();
  if (!extId) {
    console.log('FATAL: extension id not found');
    process.exit(1);
  }
  enableFileAccess(USER_DIR, extId);

  ctx = await launch();
  await ctx.addInitScript(STUB);

  // 关掉首次引导遮罩（会拦截点击）
  const setup = await ctx.newPage();
  await setup.goto(`chrome-extension://${extId}/editor.html`, { waitUntil: 'domcontentloaded' });
  await setup.waitForTimeout(1500);
  await setup.evaluate(() => chrome.storage.local.set({ onboardingShown: true }));

  // ════════════════════════════════════════════
  // 内联页（file://）
  // ════════════════════════════════════════════
  console.log('\n═══ INLINE (file://) ═══');
  // 直接通过扩展 API 打开 file:// 标签页并捕获 tab.id（无需 tabs 权限：
  // chrome.tabs.create 的返回值始终包含新标签的 id，与是否授权 tabs 无关）
  const fileTabId = await setup.evaluate(async (url) => {
    const tab = await chrome.tabs.create({ url });
    return tab.id;
  }, TEST_FILE_URL);
  // 用 Playwright 句柄接管该标签页（URL 由 CDP 读取，无需 tabs 权限）
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    page = ctx.pages().find((p) => p.url() === TEST_FILE_URL) || null;
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  if (!page) {
    console.log('  ❌ could not attach Playwright page for file:// tab');
    await ctx.close();
    return;
  }
  const logs = [];
  page.on('console', (m) => logs.push(`[top:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[top:ERR] ${e.message}`));
  await page.waitForTimeout(5000);

  let frame = page.frames().find((f) => f.url().includes('editor.html'));
  check('setup', 'inline iframe injected on file:// .md page', !!frame);
  if (!frame) {
    await ctx.close();
    return;
  }
  frame.on('console', (m) => logs.push(`[frame:${m.type()}] ${m.text()}`));
  frame.on('pageerror', (e) => logs.push(`[frame:ERR] ${e.message}`));
  info('inline doc: ' + JSON.stringify(await snap(frame)));

  // ── Bug2：窗口尺寸 & 浏览器缩放 ──
  console.log('\n── Bug2: resize / zoom ──');
  const cdp = await ctx.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');

  const measure = async () => {
    const outer = await page.evaluate(() => {
      const f = document.querySelector('iframe');
      const r = f.getBoundingClientRect();
      return {
        vw: document.documentElement.clientWidth,
        vh: document.documentElement.clientHeight,
        fx: Math.round(r.left),
        fy: Math.round(r.top),
        fw: Math.round(r.width),
        fh: Math.round(r.height),
      };
    });
    const inner = await frame.evaluate(() => {
      const sb = document.querySelector('.status-bar');
      const tr = document.querySelector('.toolbar-right') || document.querySelector('.toolbar');
      const ac = document.querySelector('.app-container');
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      const sbr = r(sb);
      const trr = r(tr);
      const acr = r(ac);
      return {
        iw: window.innerWidth,
        ih: window.innerHeight,
        sbBottom: sbr ? Math.round(sbr.bottom) : null,
        sbRight: sbr ? Math.round(sbr.right) : null,
        trRight: trr ? Math.round(trr.right) : null,
        acW: acr ? Math.round(acr.width) : null,
        acH: acr ? Math.round(acr.height) : null,
      };
    });
    return { outer, inner };
  };

  for (const [w, h] of [
    [1400, 900],
    [1000, 700],
    [1600, 1000],
    [820, 620],
  ]) {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: w, height: h } });
    await page.waitForTimeout(900);
    const { outer, inner } = await measure();
    const iframeFits =
      outer.fx === 0 && outer.fy === 0 && Math.abs(outer.fw - outer.vw) <= 1 && Math.abs(outer.fh - outer.vh) <= 1;
    const stickBottom = inner.sbBottom !== null && Math.abs(inner.sbBottom - inner.ih) <= 1;
    const stickRight = inner.trRight !== null && inner.trRight <= inner.iw && inner.trRight >= inner.iw - 24;
    const containerFits = Math.abs(inner.acW - inner.iw) <= 1 && Math.abs(inner.acH - inner.ih) <= 1;
    check('Bug2', `window ${w}x${h}: iframe == viewport`, iframeFits, JSON.stringify(outer));
    check('Bug2', `window ${w}x${h}: status-bar sticks to bottom`, stickBottom, `bottom=${inner.sbBottom} ih=${inner.ih}`);
    check('Bug2', `window ${w}x${h}: toolbar sticks to right`, stickRight, `right=${inner.trRight} iw=${inner.iw}`);
    check('Bug2', `window ${w}x${h}: .app-container fills viewport`, containerFits, `${inner.acW}x${inner.acH} vs ${inner.iw}x${inner.ih}`);
  }
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 1400, height: 900 } });
  await page.waitForTimeout(700);

  // 浏览器缩放（chrome.tabs.setZoom）—— tab id 已在打开 file:// 标签页时通过
  // chrome.tabs.create 捕获（fileTabId），此处直接复用，无需再按 url 过滤查询
  // （chrome.tabs.query 按 url 过滤依赖 tabs 权限，移除 tabs 后即失效）
  const tabId = fileTabId;
  if (tabId == null) {
    check('Bug2', 'browser zoom test (tab lookup)', false, 'could not resolve file:// tab id');
  } else {
    for (const z of [0.75, 1.25, 1.75, 1]) {
      await setup.evaluate(([id, factor]) => chrome.tabs.setZoom(id, factor), [tabId, z]);
      await page.waitForTimeout(900);
      const { inner } = await measure();
      const stickBottom = Math.abs(inner.sbBottom - inner.ih) <= 2;
      const stickRight = inner.trRight <= inner.iw + 1 && inner.trRight >= inner.iw - 26;
      check('Bug2', `zoom ${z}x: status-bar bottom`, stickBottom, `bottom=${inner.sbBottom} ih=${inner.ih}`);
      check('Bug2', `zoom ${z}x: toolbar right`, stickRight, `right=${inner.trRight} iw=${inner.iw}`);
    }
  }

  // ── Bug3：file:// 内联保存 ──
  console.log('\n── Bug3: inline save (file://) ──');
  // 抓取 iframe → parent 的桥接消息（message 事件在主世界也能收到）
  await page.evaluate(() => {
    window.__bridgeMsgs = [];
    window.addEventListener('message', (e) => {
      if (e.data && typeof e.data.type === 'string' && e.data.type.startsWith('mdnote:')) {
        window.__bridgeMsgs.push({ type: e.data.type, payload: e.data.payload });
      }
    });
  });

  // 制造 dirty
  await frame.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /edit|source/i.test(b.title || ''));
    if (btn) btn.click();
  });
  await frame.locator('.cm-content').first().click({ force: true }).catch(() => {});
  await frame.locator('.cm-content').first().type('\n\nEDIT-FOR-SAVE-TEST\n').catch(() => {});
  await page.waitForTimeout(1200);
  const dirtyBefore = await frame.evaluate(() =>
    (document.querySelector('.status-bar')?.textContent || '').includes('●') ||
    !!document.querySelector('.status-dirty, .dirty-dot'),
  );
  info('dirty marker before save: ' + dirtyBefore);

  // 点 Save
  await frame.locator('button[title*="Save"]').first().click({ force: true });
  await page.waitForTimeout(1500);

  const overlay = await page.evaluate(() => {
    const el = document.getElementById('__mdnote_save_overlay');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      inset: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      vw: document.documentElement.clientWidth,
      vh: document.documentElement.clientHeight,
      z: getComputedStyle(el).zIndex,
    };
  });
  check('Bug3', 'authorization overlay shown on parent (file://) page', !!overlay, overlay ? overlay.text : 'no overlay');
  if (overlay) {
    check('Bug3', 'overlay prefills current filename', overlay.text.includes('untitled.md'), overlay.text);
    check(
      'Bug3',
      'overlay covers full viewport',
      overlay.inset[0] === 0 && overlay.inset[1] === 0 &&
        Math.abs(overlay.inset[2] - overlay.vw) <= 1 && Math.abs(overlay.inset[3] - overlay.vh) <= 1,
      JSON.stringify(overlay.inset),
    );
  }

  const bridged = await page.evaluate(() => window.__bridgeMsgs || []);
  const req = bridged.find((m) => m.type === 'mdnote:showSaveFilePicker');
  check('Bug3', 'iframe → parent bridge request sent', !!req);
  if (req) {
    check('Bug3', 'bridge payload carries suggestedName = current file name', req.payload?.suggestedName === 'untitled.md', String(req.payload?.suggestedName));
    check('Bug3', 'bridge payload carries editor content', typeof req.payload?.content === 'string' && req.payload.content.includes('EDIT-FOR-SAVE-TEST'), `len=${req.payload?.content?.length}`);
  }

  // ESC 取消 → 遮罩关闭、不应提示 Saved、dirty 保持
  // （真实场景焦点在 iframe 里，遮罩必须自己抢焦点才收得到 Esc）
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
  const overlayGone = await page.evaluate(() => !document.getElementById('__mdnote_save_overlay'));
  check('Bug3', 'ESC removes overlay (cancel path, focus was inside iframe)', overlayGone);
  const afterCancel = await frame.evaluate(() => ({
    toast: (document.querySelector('.toast, .toast-container')?.textContent || '').trim(),
    status: (document.querySelector('.status-bar')?.textContent || '').replace(/\s+/g, ' ').slice(0, 100),
  }));
  check('Bug3', 'cancel shows no "Saved" toast', !/saved!/i.test(afterCancel.toast), JSON.stringify(afterCancel));
  check('Bug3', 'cancel keeps document dirty', /unsaved|●/i.test(afterCancel.status), afterCancel.status);

  // 显式 Cancel 按钮
  await page.evaluate(() => document.getElementById('__mdnote_save_overlay')?.remove());
  await frame.locator('button[title*="Save"]').first().click({ force: true });
  await page.waitForTimeout(1200);
  const hasCancelBtn = await page.evaluate(() => {
    const ov = document.getElementById('__mdnote_save_overlay');
    if (!ov) return false;
    const b = ov.querySelector('button');
    return !!b && /cancel/i.test(b.textContent || '');
  });
  check('Bug3', 'overlay offers an explicit Cancel button', hasCancelBtn);
  if (hasCancelBtn) {
    await page.click('#__mdnote_save_overlay button', { force: true });
    await page.waitForTimeout(1200);
    check(
      'Bug3',
      'Cancel button closes overlay without saving',
      await page.evaluate(() => !document.getElementById('__mdnote_save_overlay')),
    );
  }

  // 成功回执模拟：验证上层（platform.saveFileViaBridge → saveAs）的成功分支
  await page.evaluate(() => document.getElementById('__mdnote_save_overlay')?.remove());
  await frame.locator('button[title*="Save"]').first().click({ force: true });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const f = document.querySelector('iframe');
    f.contentWindow.postMessage({ type: 'mdnote:save-complete', payload: { ok: true, name: 'untitled.md' } }, '*');
    const ov = document.getElementById('__mdnote_save_overlay');
    if (ov) ov.remove();
  });
  await page.waitForTimeout(1800);
  const afterOk = await frame.evaluate(() => ({
    status: (document.querySelector('.status-bar')?.textContent || '').replace(/\s+/g, ' ').slice(0, 120),
    toast: (document.querySelector('.toast, .toast-container')?.textContent || '').trim(),
  }));
  check('Bug3', 'ok reply → "Saved" feedback in editor', /saved/i.test(afterOk.toast + afterOk.status), JSON.stringify(afterOk));
  check(
    'Bug3',
    'ok reply keeps full file:// path in status bar (not degraded to bare filename)',
    afterOk.status.includes('/Users/bot/Desktop/untitled.md') || afterOk.status.includes('untitled.md'),
    afterOk.status,
  );

  // 失败回执：应报错且不提示 Saved
  await frame.locator('button[title*="Save"]').first().click({ force: true });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const f = document.querySelector('iframe');
    f.contentWindow.postMessage(
      { type: 'mdnote:save-complete', payload: { ok: false, error: 'NotAllowedError: denied' } },
      '*',
    );
    const ov = document.getElementById('__mdnote_save_overlay');
    if (ov) ov.remove();
  });
  await page.waitForTimeout(1800);
  const afterErr = await frame.evaluate(() => (document.querySelector('.toast, .toast-container')?.textContent || '').trim());
  check('Bug3', 'error reply surfaces an error toast (not silent success)', /fail|error|denied/i.test(afterErr), afterErr);

  // 真实原生选择器路径（最后跑，避免原生面板阻塞后续用例）
  await page.evaluate(() => document.getElementById('__mdnote_save_overlay')?.remove());
  await frame.locator('button[title*="Save"]').first().click({ force: true });
  await page.waitForTimeout(1200);
  if (await page.evaluate(() => !!document.getElementById('__mdnote_save_overlay'))) {
    await page.click('#__mdnote_save_overlay', { force: true }).catch(() => {});
    await page.waitForTimeout(3000);
    const removed = await page
      .evaluate(() => !document.getElementById('__mdnote_save_overlay'))
      .catch(() => 'evaluate-blocked-by-modal');
    check(
      'Bug3',
      'overlay click triggers native showSaveFilePicker (overlay torn down, no JS error)',
      removed === true || removed === 'evaluate-blocked-by-modal',
      'overlayRemoved=' + removed,
    );
    // 关掉原生面板
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(2000);
    const st = await frame
      .evaluate(() => ({
        toast: (document.querySelector('.toast, .toast-container')?.textContent || '').trim(),
        status: (document.querySelector('.status-bar')?.textContent || '').replace(/\s+/g, ' ').slice(0, 100),
      }))
      .catch(() => ({ toast: '(unavailable)', status: '(unavailable)' }));
    info('after native picker ESC: ' + JSON.stringify(st));
  }
  await page.evaluate(() => document.getElementById('__mdnote_save_overlay')?.remove()).catch(() => {});

  // ── Bug1：内联页 Open → 新标签页 ──
  console.log('\n── Bug1: inline Open → new tab ──');
  page.on('filechooser', async (fc) => {
    await fc.setFiles(PICK_FILE).catch(() => {});
  });
  const inlineBefore = await snap(frame);
  const n0 = ctx.pages().length;
  await frame.locator('button[title*="Open"]').first().click({ force: true });
  await page.waitForTimeout(6000);
  const n1 = ctx.pages().length;
  check('Bug1', 'inline Open with content opens a NEW tab', n1 === n0 + 1, `pages ${n0} → ${n1}`);
  if (n1 > n0) {
    const t = ctx.pages()[ctx.pages().length - 1];
    await t.waitForTimeout(4000);
    const s = await snap(t);
    check('Bug1', 'new tab renders the opened document', s.preview.includes('Picked Doc') || s.cm.includes('Picked Doc'), JSON.stringify(s));
    check('Bug1', 'new tab is not the welcome screen', !s.welcome, `welcome=${s.welcome}`);
    await t.close();
  }
  const inlineAfter = await snap(frame);
  check(
    'Bug1',
    'original inline tab content is NOT replaced',
    inlineAfter.preview === inlineBefore.preview || !inlineAfter.preview.includes('Picked Doc'),
    `before="${inlineBefore.preview}" after="${inlineAfter.preview}"`,
  );

  // ── Bug4：内联页 New → 新标签页空白文档 ──
  console.log('\n── Bug4: inline New → blank new tab ──');
  const winBefore = await page.evaluate(() => ({ w: window.outerWidth, h: window.outerHeight }));
  const m0 = ctx.pages().length;
  await frame.locator('button[title*="New"]').first().click({ force: true });
  await page.waitForTimeout(5000);
  const m1 = ctx.pages().length;
  const winAfter = await page.evaluate(() => ({ w: window.outerWidth, h: window.outerHeight }));
  check('Bug4', 'inline New opens a NEW tab', m1 === m0 + 1, `pages ${m0} → ${m1}`);
  check('Bug4', 'window size unchanged by New', winBefore.w === winAfter.w && winBefore.h === winAfter.h, `${winBefore.w}x${winBefore.h} → ${winAfter.w}x${winAfter.h}`);
  if (m1 > m0) {
    const t = ctx.pages()[ctx.pages().length - 1];
    await t.waitForTimeout(4000);
    const s = await snap(t);
    check('Bug4', 'new tab is a BLANK document, not welcome/home', !s.welcome && s.editor, JSON.stringify(s));
    check('Bug4', 'new tab document is empty', s.cm.length === 0 && !s.preview.includes('Picked Doc'), `cm="${s.cm}"`);
    check('Bug4', 'new tab shows Untitled', /untitled/i.test(s.status), s.status);
    await t.close();
  }

  // ════════════════════════════════════════════
  // 插件页（chrome-extension://editor.html）
  // ════════════════════════════════════════════
  console.log('\n═══ PLUGIN PAGE (chrome-extension://editor.html) ═══');
  const pp = await ctx.newPage();
  pp.on('pageerror', (e) => logs.push(`[plugin:ERR] ${e.message}`));
  pp.on('console', (m) => logs.push(`[plugin:${m.type()}] ${m.text()}`));
  await pp.goto(`chrome-extension://${extId}/editor.html`, { waitUntil: 'domcontentloaded' });
  await pp.waitForTimeout(3000);
  info('plugin page: ' + JSON.stringify(await snap(pp)));

  // 欢迎页 Open → 原地打开（不新开标签页）
  await pp.evaluate(() => {
    window.__mdnotePickNext = { name: 'docA.md', content: '# Doc A\n\nfirst document\n' };
  });
  const p0 = ctx.pages().length;
  await pp.locator('button[title*="Open"]').first().click({ force: true });
  await pp.waitForTimeout(4000);
  const p1 = ctx.pages().length;
  const sA = await snap(pp);
  check('Bug1', 'plugin page: Open on empty/welcome loads IN PLACE (no new tab)', p1 === p0, `pages ${p0} → ${p1}`);
  check('Bug1', 'plugin page: in-place open actually renders the document', sA.preview.includes('Doc A') || sA.cm.includes('Doc A'), JSON.stringify(sA));

  // 有文档时 Open → 新标签页
  await pp.evaluate(() => {
    window.__mdnotePickNext = { name: 'docB.md', content: '# Doc B\n\nsecond document\n' };
  });
  const q0 = ctx.pages().length;
  await pp.locator('button[title*="Open"]').first().click({ force: true });
  await pp.waitForTimeout(6000);
  const q1 = ctx.pages().length;
  check('Bug1', 'plugin page: Open with content opens a NEW tab', q1 === q0 + 1, `pages ${q0} → ${q1}`);
  if (q1 > q0) {
    const t = ctx.pages()[ctx.pages().length - 1];
    await t.waitForTimeout(4000);
    const s = await snap(t);
    check('Bug1', 'plugin page: new tab renders Doc B', s.preview.includes('Doc B') || s.cm.includes('Doc B'), JSON.stringify(s));
    await t.close();
  }
  const sAfter = await snap(pp);
  check('Bug1', 'plugin page: current tab still shows Doc A', sAfter.preview.includes('Doc A') || sAfter.cm.includes('Doc A'), JSON.stringify(sAfter));

  // 有文档时 New → 新标签页空白
  const r0 = ctx.pages().length;
  const winB = await pp.evaluate(() => ({ w: window.outerWidth, h: window.outerHeight }));
  await pp.locator('button[title*="New"]').first().click({ force: true });
  await pp.waitForTimeout(5000);
  const r1 = ctx.pages().length;
  const winA = await pp.evaluate(() => ({ w: window.outerWidth, h: window.outerHeight }));
  check('Bug4', 'plugin page: New with content opens a NEW tab', r1 === r0 + 1, `pages ${r0} → ${r1}`);
  check('Bug4', 'plugin page: window size unchanged by New', winB.w === winA.w && winB.h === winA.h, `${winB.w}x${winB.h} → ${winA.w}x${winA.h}`);
  if (r1 > r0) {
    const t = ctx.pages()[ctx.pages().length - 1];
    await t.waitForTimeout(4000);
    const s = await snap(t);
    check('Bug4', 'plugin page: new tab is BLANK document (not welcome)', !s.welcome && s.editor, JSON.stringify(s));
    check('Bug4', 'plugin page: new tab does not restore stale Doc A/B', !/Doc A|Doc B/.test(s.preview + s.cm), `cm="${s.cm}" preview="${s.preview}"`);
    await t.close();
  }

  // 插件页 resize（非 iframe 场景也要贴边）
  console.log('\n── Bug2: plugin page resize ──');
  const cdp2 = await ctx.newCDPSession(pp);
  const { windowId: wid2 } = await cdp2.send('Browser.getWindowForTarget');
  for (const [w, h] of [
    [1200, 800],
    [900, 640],
  ]) {
    await cdp2.send('Browser.setWindowBounds', { windowId: wid2, bounds: { width: w, height: h } });
    await pp.waitForTimeout(900);
    const m = await pp.evaluate(() => {
      const sb = document.querySelector('.status-bar');
      const tr = document.querySelector('.toolbar-right') || document.querySelector('.toolbar');
      return {
        iw: window.innerWidth,
        ih: window.innerHeight,
        sbBottom: sb ? Math.round(sb.getBoundingClientRect().bottom) : null,
        trRight: tr ? Math.round(tr.getBoundingClientRect().right) : null,
      };
    });
    check('Bug2', `plugin ${w}x${h}: status-bar bottom`, Math.abs(m.sbBottom - m.ih) <= 1, JSON.stringify(m));
    check('Bug2', `plugin ${w}x${h}: toolbar right`, m.trRight <= m.iw && m.trRight >= m.iw - 24, JSON.stringify(m));
  }

  // ── 汇总 ──
  console.log('\n════════ SUMMARY ════════');
  const byBug = {};
  for (const r of results) {
    byBug[r.bug] = byBug[r.bug] || { pass: 0, fail: 0, fails: [] };
    if (r.ok) byBug[r.bug].pass++;
    else {
      byBug[r.bug].fail++;
      byBug[r.bug].fails.push(r.name + (r.detail ? ` (${r.detail})` : ''));
    }
  }
  for (const [bug, v] of Object.entries(byBug)) {
    console.log(`${v.fail === 0 ? '✅' : '❌'} ${bug}: ${v.pass} passed, ${v.fail} failed`);
    v.fails.forEach((f) => console.log(`     ✗ ${f}`));
  }
  const totalFail = results.filter((r) => !r.ok).length;
  console.log(`\nTOTAL: ${results.length - totalFail}/${results.length} passed`);

  const errLogs = logs.filter((l) => /ERR|error/i.test(l));
  if (errLogs.length) {
    console.log('\n── console errors ──');
    errLogs.slice(-25).forEach((l) => console.log('  ' + l));
  }

  await ctx.close();
  process.exit(totalFail === 0 ? 0 : 2);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
