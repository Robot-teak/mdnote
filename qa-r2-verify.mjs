/**
 * MDnote 插件版 —— 第 2 轮（终轮）QA 端到端验收。
 *
 * 断言清单（来自用户原始需求）：
 *   A1  打开的内容渲染在 file:// 文档页（走 content-md 内联注入），不是 chrome-extension:// 独立 tab
 *   A2  Open 不替换当前页面已有内容（当前 tab 有内容 → 新开 tab）
 *   B1  Save 不弹系统「另存为」选择器（不发 mdnote:showSaveFilePicker）
 *   B2b 授权弹窗显示原本的完整路径 + 原文件名
 *   B3a 保存请求携带原文件路径
 *   B3b 一次确认后直接写回原文件，不再弹系统面板二次选择
 *   R1  回归：窗口缩放 / 浏览器缩放贴边
 *   R2  回归：New 空白标签
 *
 * 环境约束（已探明，见 qa-r2-probe.mjs）：
 *   - FSAA 原生目录面板经 CDP 拦截后只能被「取消」，无法被程序填充 → 真实磁盘落盘
 *     这一步无法在无人值守自动化里完成。
 *   - 因此 B3b 拆成两层：
 *       B3b-1（真实）：真实点授权 → 统计原生面板调起次数，必须恰好 1 次且类型为
 *                      目录选择器（不是另存为面板）；不得出现第二次面板。
 *       B3b-2（插桩）：在扩展 content script 的隔离世界里给 showDirectoryPicker 打桩，
 *                      放行后完整跑通产品自身的写回逻辑，断言它对
 *                      **原文件名** 调 getFileHandle(name,{create:false})、
 *                      并用 createWritable() 写入**编辑后的完整内容**；
 *                      随后再次 Save 必须 0 次面板（会话内静默直写）。
 *
 * 运行：node qa-r2-verify.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const EXT_DIR = '/Users/bot/Documents/MDnote/dist-extension';
const DESKTOP = '/Users/bot/Desktop';
const ORIG_PATH = path.join(DESKTOP, 'qa-original.md');
const PICK_PATH = path.join(DESKTOP, 'qa-picked.md');
const ORIG_URL = 'file://' + ORIG_PATH;
const DIR_URL = 'file://' + DESKTOP + '/';
const USER_DIR = '/tmp/mdnote-qa-r2';

const ORIG_MD = '# QA Original Doc\n\nQA-ORIGINAL-MARKER original inline content.\n';
const PICKED_MD = '# QA Picked Doc\n\nQA-PICKED-MARKER content opened via the Open flow.\n';
const EDIT_MARKER = 'QA-EDIT-MARKER-FOR-SAVE';
const EDIT_MARKER_2 = 'QA-SECOND-EDIT-MARKER';

// ── 结果收集 ──
const results = [];
function check(group, name, ok, detail = '') {
  results.push({ group, name, ok, detail });
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'} [${group}] ${name}${detail ? '\n           → ' + detail : ''}`);
}
function blocked(group, name, detail) {
  results.push({ group, name, ok: null, detail });
  console.log(`  ⚠️  BLOCKED [${group}] ${name}\n           → ${detail}`);
}
const info = (m) => console.log(`     · ${m}`);
const section = (t) => console.log(`\n═══ ${t} ═══`);

// ── harness ──
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

const launch = () =>
  chromium.launchPersistentContext(USER_DIR, {
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

const snap = (f) =>
  f.evaluate(() => ({
    url: location.href,
    welcome: !!document.querySelector('.welcome-screen'),
    status: (document.querySelector('.status-bar')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    preview: (document.querySelector('.preview-pane')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    cm: (document.querySelector('.cm-content')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140),
  }));

async function findRenderingPage(ctx, marker) {
  for (const p of ctx.pages()) {
    for (const f of p.frames()) {
      const hit = await f
        .evaluate((m) => (document.body?.innerText || '').includes(m), marker)
        .catch(() => false);
      if (hit) return { pageUrl: p.url(), frameUrl: f.url(), page: p, frame: f };
    }
  }
  return null;
}

/** 在扩展 content script 的隔离世界里执行表达式 */
async function evalInIsolated(cdp, contextId, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
    userGesture: false,
  });
  if (r.exceptionDetails) throw new Error('isolated eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
}

async function main() {
  fs.writeFileSync(ORIG_PATH, ORIG_MD);
  fs.writeFileSync(PICK_PATH, PICKED_MD);
  fs.rmSync(USER_DIR, { recursive: true, force: true });

  let ctx = await launch();
  const sw0 = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  const extId = /chrome-extension:\/\/([a-z]{32})\//.exec(sw0.url())[1];
  await ctx.close();
  enableFileAccess(USER_DIR, extId);
  info('extension id: ' + extId);

  ctx = await launch();
  const setup = await ctx.newPage();
  await setup.goto(`chrome-extension://${extId}/editor.html`, { waitUntil: 'domcontentloaded' });
  await setup.waitForTimeout(1500);
  await setup.evaluate(() => chrome.storage.local.set({ onboardingShown: true }));
  await setup.evaluate(() => chrome.storage.local.remove(['mdnote-pending-open', 'mdnote-pending-new']));

  const fileTabId = await setup.evaluate(async (url) => (await chrome.tabs.create({ url })).id, ORIG_URL);

  let page = null;
  for (let i = 0; i < 80 && !page; i++) {
    page = ctx.pages().find((p) => p.url() === ORIG_URL) || null;
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  if (!page) { console.log('FATAL: cannot attach to file:// tab'); await ctx.close(); process.exit(2); }

  const logs = [];
  page.on('console', (m) => logs.push(`[top:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[top:ERR] ${e.message}`));
  await page.waitForTimeout(5000);

  let frame = page.frames().find((f) => f.url().includes('editor.html'));
  check('SETUP', 'file:// .md 页注入 inline iframe 编辑器', !!frame);
  if (!frame) { console.log(logs.join('\n')); await ctx.close(); process.exit(2); }
  frame.on('console', (m) => logs.push(`[frame:${m.type()}] ${m.text()}`));

  const before = await snap(frame);
  info('inline 初始状态: ' + JSON.stringify(before));
  check('SETUP', 'inline 编辑器已渲染原文档内容',
    (before.preview + before.cm).includes('QA-ORIGINAL-MARKER'), before.preview || before.cm);

  // 主世界桥接消息记录器
  const installBridgeRecorder = (p) => p.evaluate(() => {
    if (window.__bridgeInstalled) { window.__bridgeMsgs = []; return; }
    window.__bridgeInstalled = true;
    window.__bridgeMsgs = [];
    window.addEventListener('message', (e) => {
      if (e.data && typeof e.data.type === 'string' && e.data.type.startsWith('mdnote')) {
        window.__bridgeMsgs.push({ type: e.data.type, payload: e.data.payload });
      }
    });
  });
  await installBridgeRecorder(page);

  // ══════════════════════════════════════════
  // A. Open
  // ══════════════════════════════════════════
  section('A. Open —— 内容必须落在 file:// 文档页，且不替换当前页');

  let inputChooserFired = false;
  page.on('filechooser', async (fc) => { inputChooserFired = true; await fc.setFiles([]).catch(() => {}); });

  const urlsBefore = ctx.pages().map((p) => p.url());
  info('Open 前标签页: ' + JSON.stringify(urlsBefore));

  await frame.locator('button[title*="Open File"]').first().click({ force: true });
  await page.waitForTimeout(3500);

  const bridgedA = await page.evaluate(() => (window.__bridgeMsgs || []).map((m) => m.type));
  info('Open 桥接消息: ' + JSON.stringify(bridgedA));

  const urlsAfter = ctx.pages().map((p) => p.url());
  info('Open 后标签页: ' + JSON.stringify(urlsAfter));

  // 注意：不能用 startsWith(DIR_URL) —— 原文档页 file://.../Desktop/qa-original.md
  // 同样以目录 URL 开头，会误判成目录列表页（第 1 版脚本的测试 Bug）。
  let dirPage = null;
  for (let i = 0; i < 40 && !dirPage; i++) {
    dirPage = ctx.pages().find((p) => p !== page && p.url() === DIR_URL) || null;
    if (!dirPage) await new Promise((r) => setTimeout(r, 150));
  }
  check('A0', 'Open 在新标签页打开了 file:// 目录列表（未使用 <input type=file> 兜底）',
    !!dirPage && !inputChooserFired,
    `dirTab=${dirPage ? dirPage.url() : '(无)'}, inputChooserFired=${inputChooserFired}`);

  // A2：当前页内容未被替换（此刻即可判定）
  const origAfterOpen = await snap(frame).catch(() => null);
  check('A2', 'Open 不替换当前页面已有内容（原 file:// 页仍是原文档）',
    !!origAfterOpen && (origAfterOpen.preview + origAfterOpen.cm).includes('QA-ORIGINAL-MARKER'),
    origAfterOpen ? `preview="${origAfterOpen.preview}"` : 'frame 失效');
  check('A2b', '原 file:// 标签页未被关闭',
    ctx.pages().some((p) => p.url() === ORIG_URL), JSON.stringify(ctx.pages().map((p) => p.url())));

  // A1：在目录列表里选中目标 .md → 必须落在 file:// 文档页并内联渲染
  let hostUrl = '(未产生渲染)';
  if (dirPage) {
    await dirPage.waitForTimeout(800);
    const links = await dirPage.evaluate(() =>
      [...document.querySelectorAll('a')].map((a) => a.href).filter((h) => /qa-picked\.md$/i.test(h)));
    info('目录列表中的目标条目: ' + JSON.stringify(links));
    check('A0b', '目录列表条目是真实 file:// 绝对 URL（点击即进 file:// 文档页）',
      links.length > 0 && links[0].startsWith('file://'), JSON.stringify(links));
    if (links.length) {
      await dirPage.goto(links[0], { waitUntil: 'domcontentloaded' }).catch(() => {});
      await dirPage.waitForTimeout(5000);
    }
  }
  const rendering = await findRenderingPage(ctx, 'QA-PICKED-MARKER');
  hostUrl = rendering?.pageUrl || '(未产生渲染)';
  check('A3', 'Open 选中的文档确实被渲染出来（未静默失败）', !!rendering, `page=${hostUrl}`);
  check('A1', '打开的内容渲染在 file:// 文档页（而非 chrome-extension:// 插件独立 tab）',
    hostUrl.startsWith('file://'),
    `实际承载页=${hostUrl}；内联 iframe=${rendering?.frameUrl || '(none)'}`);

  const origStillOk = await snap(frame).catch(() => null);
  check('A2c', '目标文档渲染后，原文档页内容依然未被替换',
    !!origStillOk && (origStillOk.preview + origStillOk.cm).includes('QA-ORIGINAL-MARKER'),
    origStillOk ? origStillOk.preview : 'frame 失效');

  for (const p of ctx.pages()) {
    if (p !== page && p !== setup && p.url() !== ORIG_URL) await p.close().catch(() => {});
  }
  await page.waitForTimeout(600);

  // ══════════════════════════════════════════
  // R1. 回归：缩放贴边
  // ══════════════════════════════════════════
  section('R1. 回归：窗口 / 浏览器缩放贴边');
  frame = page.frames().find((f) => f.url().includes('editor.html')) || frame;
  const cdp = await ctx.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');

  const measure = async () => {
    const outer = await page.evaluate(() => {
      const f = document.querySelector('iframe');
      const r = f.getBoundingClientRect();
      return { vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight,
        fx: Math.round(r.left), fy: Math.round(r.top), fw: Math.round(r.width), fh: Math.round(r.height) };
    });
    const inner = await frame.evaluate(() => {
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      const sbr = r(document.querySelector('.status-bar'));
      const trr = r(document.querySelector('.toolbar-right') || document.querySelector('.toolbar'));
      return { iw: window.innerWidth, ih: window.innerHeight,
        sbBottom: sbr ? Math.round(sbr.bottom) : null, trRight: trr ? Math.round(trr.right) : null };
    });
    return { outer, inner };
  };

  for (const [w, h] of [[1400, 900], [1000, 700], [820, 620]]) {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: w, height: h } });
    await page.waitForTimeout(900);
    const { outer, inner } = await measure();
    check('R1', `窗口 ${w}x${h}：iframe 铺满视口`,
      outer.fx === 0 && outer.fy === 0 && Math.abs(outer.fw - outer.vw) <= 1 && Math.abs(outer.fh - outer.vh) <= 1,
      JSON.stringify(outer));
    check('R1', `窗口 ${w}x${h}：状态栏贴底 + 工具栏贴右`,
      inner.sbBottom !== null && Math.abs(inner.sbBottom - inner.ih) <= 1 &&
      inner.trRight <= inner.iw + 1 && inner.trRight >= inner.iw - 24,
      `sbBottom=${inner.sbBottom}/ih=${inner.ih}, trRight=${inner.trRight}/iw=${inner.iw}`);
  }
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 1400, height: 900 } });
  await page.waitForTimeout(700);
  for (const z of [0.75, 1.5, 1]) {
    await setup.evaluate(([id, factor]) => chrome.tabs.setZoom(id, factor), [fileTabId, z]);
    await page.waitForTimeout(900);
    const { inner } = await measure();
    check('R1', `浏览器缩放 ${z}x：状态栏贴底 + 工具栏贴右`,
      Math.abs(inner.sbBottom - inner.ih) <= 2 && inner.trRight <= inner.iw + 1 && inner.trRight >= inner.iw - 26,
      `sbBottom=${inner.sbBottom}/ih=${inner.ih}, trRight=${inner.trRight}/iw=${inner.iw}`);
  }

  // ══════════════════════════════════════════
  // R2. 回归：New 空白标签
  // ══════════════════════════════════════════
  section('R2. 回归：New 新建空白标签');
  const nBefore = ctx.pages().length;
  await frame.locator('button[title*="New Document"]').first().click({ force: true });
  await page.waitForTimeout(4000);
  const newPage = ctx.pages().find((p) => p !== page && p !== setup && p.url().includes('editor.html'));
  check('R2', 'New 打开了新标签页', ctx.pages().length > nBefore && !!newPage,
    JSON.stringify(ctx.pages().map((p) => p.url())));
  if (newPage) {
    await newPage.waitForTimeout(1500);
    const s = await snap(newPage.mainFrame()).catch(() => null);
    info('New 标签页状态: ' + JSON.stringify(s));
    check('R2', 'New 标签页是空白文档（不是欢迎页、不是上一篇文档）',
      !!s && !s.welcome && !s.preview.includes('QA-ORIGINAL-MARKER') && !s.preview.includes('QA-PICKED-MARKER'),
      s ? `welcome=${s.welcome} preview="${s.preview}"` : 'null');
    await newPage.close().catch(() => {});
  }
  const afterNew = await snap(frame).catch(() => null);
  check('R2', 'New 不替换当前 file:// 页内容',
    !!afterNew && (afterNew.preview + afterNew.cm).includes('QA-ORIGINAL-MARKER'),
    afterNew ? afterNew.preview : 'null');

  // ══════════════════════════════════════════
  // B. Save
  // ══════════════════════════════════════════
  section('B. Save —— 授权弹窗显示原路径原文件名 → 一次确认 → 直写原文件');

  const diskBefore = fs.readFileSync(ORIG_PATH, 'utf8');
  info('磁盘原始内容: ' + JSON.stringify(diskBefore));

  // 制造 dirty
  await frame.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /editor only/i.test(b.title || ''));
    if (btn) btn.click();
  });
  await page.waitForTimeout(600);
  await frame.locator('.cm-content').first().click({ force: true }).catch(() => {});
  await frame.locator('.cm-content').first().type('\n\n' + EDIT_MARKER + '\n').catch(() => {});
  await page.waitForTimeout(1500);
  info('编辑后状态: ' + JSON.stringify(await snap(frame)));

  // ── CDP：统计原生文件面板调起次数 ──
  const nativePickers = [];
  cdp.on('Page.fileChooserOpened', (e) => nativePickers.push({ t: Date.now(), ...e }));
  await cdp.send('Page.enable');
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });

  await page.evaluate(() => { window.__bridgeMsgs = []; });
  await frame.locator('button[title*="Save"]').first().click({ force: true });
  await page.waitForTimeout(2500);

  const overlay = await page.evaluate(() => {
    const el = document.getElementById('__mdnote_save_overlay');
    return el ? { text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      buttons: [...el.querySelectorAll('button')].map((b) => b.textContent) } : null;
  });
  const bridgedB = await page.evaluate(() => window.__bridgeMsgs || []);
  info('桥接消息: ' + JSON.stringify(bridgedB.map((m) => m.type)));
  info('授权弹窗: ' + (overlay ? JSON.stringify(overlay.text) : '(无弹窗)'));

  const legacySavePicker = bridgedB.find((m) => m.type === 'mdnote:showSaveFilePicker');
  const saveReq = bridgedB.find((m) => m.type === 'mdnote:save-to-original');

  check('B1', 'Save 不发 mdnote:showSaveFilePicker（不走系统「另存为」选择器路径）',
    !legacySavePicker,
    legacySavePicker ? `仍发出 showSaveFilePicker，payload=${JSON.stringify(legacySavePicker.payload).slice(0, 160)}`
      : '未发出，符合预期');

  check('B2-a', '授权弹窗显示原本的文件名（qa-original.md）',
    !!overlay && overlay.text.includes('qa-original.md'), overlay ? overlay.text : '(无弹窗)');
  check('B2-b', `授权弹窗显示原本的完整路径（${ORIG_PATH}）`,
    !!overlay && overlay.text.includes(ORIG_PATH), overlay ? overlay.text : '(无弹窗)');

  check('B3-a', '保存请求（mdnote:save-to-original）携带原文件绝对路径',
    !!saveReq && JSON.stringify(saveReq.payload || {}).includes(ORIG_PATH),
    saveReq ? `payload=${JSON.stringify(saveReq.payload).slice(0, 220)}` : '(无 mdnote:save-to-original 请求)');

  // ── B3-b-1（真实）：点一次授权 → 原生面板恰好 1 次，且不是「另存为」面板 ──
  nativePickers.length = 0;
  if (overlay) {
    info('点击「Authorize & Save」（模拟用户一次确认）…');
    await page.click('#__mdnote_save_overlay button', { force: true }).catch(() => {});
    await page.waitForTimeout(6000);
  }
  info('原生面板事件: ' + JSON.stringify(nativePickers));
  check('B3-b-1', '一次确认只调起 1 次系统面板（目录授权），不再弹第二次系统面板',
    nativePickers.length === 1,
    `实际调起 ${nativePickers.length} 次：${JSON.stringify(nativePickers.map((p) => p.mode))}`);

  const diskAfterReal = fs.readFileSync(ORIG_PATH, 'utf8');
  check('B3-b-0', '系统面板被取消时不误写磁盘（取消语义正确）',
    diskAfterReal === diskBefore, `磁盘${diskAfterReal === diskBefore ? '未变（正确）' : '被改写（异常）'}`);

  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});

  // ── B3-b-2（插桩）：给隔离世界的 showDirectoryPicker 打桩，放行产品自身的写回逻辑 ──
  section('B3-b-2. 放行授权后，验证产品「写回原文件」的真实逻辑');
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  await cdp.send('Runtime.enable');
  await page.waitForTimeout(800);
  const iso = contexts.find((c) => c.auxData?.isDefault === false && String(c.origin).includes(extId));
  check('B3-b-2-setup', '可在扩展 content script 隔离世界注入探针', !!iso,
    iso ? `contextId=${iso.id} name="${iso.name}"` : '未找到隔离世界，插桩验证无法进行');

  let stubReport = null;
  if (iso) {
    await evalInIsolated(cdp, iso.id, `(() => {
      window.__qa = { pickers: [], getFileHandleCalls: [], writes: [], expectName: 'qa-original.md' };
      window.showDirectoryPicker = async (opts) => {
        window.__qa.pickers.push({ kind: 'directory', opts: JSON.parse(JSON.stringify(opts || {})) });
        return {
          name: 'Desktop', kind: 'directory',
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
          getFileHandle: async (name, options) => {
            window.__qa.getFileHandleCalls.push({ name, options: JSON.parse(JSON.stringify(options || {})) });
            if (name !== window.__qa.expectName) { const e = new Error('nf'); e.name = 'NotFoundError'; throw e; }
            return {
              name, kind: 'file',
              queryPermission: async () => 'granted',
              requestPermission: async () => 'granted',
              createWritable: async () => {
                let buf = '';
                return {
                  write: async (d) => { buf += (typeof d === 'string' ? d : String(d)); },
                  close: async () => { window.__qa.writes.push({ name, text: buf }); },
                };
              },
            };
          },
        };
      };
      window.showSaveFilePicker = async (o) => { window.__qa.pickers.push({ kind: 'save', opts: o }); const e = new Error('s'); e.name = 'AbortError'; throw e; };
      window.showOpenFilePicker = async (o) => { window.__qa.pickers.push({ kind: 'open', opts: o }); const e = new Error('s'); e.name = 'AbortError'; throw e; };
      return 'ok';
    })()`);

    // 再点一次 Save（上一次因面板被取消而中止）
    await page.evaluate(() => { window.__bridgeMsgs = []; });
    await frame.locator('button[title*="Save"]').first().click({ force: true });
    await page.waitForTimeout(2000);
    const ov2 = await page.evaluate(() => !!document.getElementById('__mdnote_save_overlay'));
    if (ov2) {
      await page.click('#__mdnote_save_overlay button', { force: true }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    stubReport = await evalInIsolated(cdp, iso.id, 'JSON.stringify(window.__qa)');
    const qa = JSON.parse(stubReport);
    info('插桩记录: ' + JSON.stringify({
      pickers: qa.pickers.map((p) => p.kind + ':' + JSON.stringify(p.opts)),
      getFileHandleCalls: qa.getFileHandleCalls,
      writes: qa.writes.map((w) => ({ name: w.name, len: w.text.length })),
    }));

    check('B3-b-2a', '授权用的是「目录授权」而非「另存为」面板（mode=readwrite）',
      qa.pickers.length === 1 && qa.pickers[0].kind === 'directory' && qa.pickers[0].opts.mode === 'readwrite',
      JSON.stringify(qa.pickers));
    check('B3-b-2b', `授权后按**原文件名**取原文件句柄（getFileHandle('qa-original.md', {create:false})）`,
      qa.getFileHandleCalls.length >= 1 && qa.getFileHandleCalls[0].name === 'qa-original.md' &&
      qa.getFileHandleCalls[0].options.create === false,
      JSON.stringify(qa.getFileHandleCalls));
    check('B3-b-2c', '写入内容 = 编辑器当前完整内容（含本次编辑）',
      qa.writes.length >= 1 && qa.writes[0].text.includes(EDIT_MARKER) &&
      qa.writes[0].text.includes('QA-ORIGINAL-MARKER'),
      qa.writes.length ? JSON.stringify(qa.writes[0].text.slice(0, 140)) : '(无写入)');
    check('B3-b-2d', '整个保存过程 0 次「另存为 / 打开文件」系统面板',
      !qa.pickers.some((p) => p.kind === 'save' || p.kind === 'open'), JSON.stringify(qa.pickers.map((p) => p.kind)));

    const savedSnap = await snap(frame);
    info('保存后编辑器状态: ' + JSON.stringify(savedSnap));
    check('B3-b-2e', '保存后状态栏仍显示**原绝对路径**（未退化成裸文件名）',
      savedSnap.status.includes(ORIG_PATH), savedSnap.status);

    // 第二次保存：会话内应静默直写，0 弹窗
    await frame.locator('.cm-content').first().click({ force: true }).catch(() => {});
    await frame.locator('.cm-content').first().type('\n' + EDIT_MARKER_2 + '\n').catch(() => {});
    await page.waitForTimeout(1200);
    await frame.locator('button[title*="Save"]').first().click({ force: true });
    await page.waitForTimeout(2500);
    const ov3 = await page.evaluate(() => !!document.getElementById('__mdnote_save_overlay'));
    const qa2 = JSON.parse(await evalInIsolated(cdp, iso.id, 'JSON.stringify(window.__qa)'));
    check('B3-b-2f', '同一会话再次 Save：无授权弹窗、无系统面板，静默直写原文件',
      !ov3 && qa2.pickers.length === 1 && qa2.writes.length >= 2 &&
      qa2.writes[qa2.writes.length - 1].text.includes(EDIT_MARKER_2),
      `overlay=${ov3}, pickers=${qa2.pickers.length}, writes=${qa2.writes.length}`);
  }

  // B3-b 真实落盘：环境限制说明
  blocked('B3-b-3', '真实磁盘落盘（原文件字节被覆盖）',
    'FSAA 原生目录面板经 CDP 拦截后只能取消、无法程序填充；macOS 辅助功能权限被拒，无法用 AppleScript 驱动原生面板。' +
    '故「真实 OS 级写入」这一步无法无人值守自动化。已由 B3-b-1/2a~2f 覆盖到调用 createWritable() 之前的全部产品逻辑；' +
    '剩余部分为 Chrome 自身 FileSystemWritableFileStream 实现。');

  // ── B4 静态构建物 ──
  const contentJs = fs.readFileSync(path.join(EXT_DIR, 'content-md.js'), 'utf8');
  check('B4', '构建产物 content-md.js 已移除 showSaveFilePicker（另存为）逻辑',
    !contentJs.includes('showSaveFilePicker'),
    contentJs.includes('showSaveFilePicker') ? '仍包含' : '已移除');
  check('B4b', 'content-md.js 使用目录授权直写（showDirectoryPicker + getFileHandle + createWritable）',
    contentJs.includes('showDirectoryPicker') && contentJs.includes('getFileHandle') && contentJs.includes('createWritable'),
    'showDirectoryPicker=' + contentJs.includes('showDirectoryPicker'));

  // ── 汇总 ──
  section('汇总');
  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  const blk = results.filter((r) => r.ok === null).length;
  console.log(`总计 ${results.length}：通过 ${pass}，失败 ${fail}，受环境阻塞 ${blk}`);
  if (fail) {
    console.log('\n失败用例：');
    for (const r of results.filter((x) => x.ok === false)) console.log(`  ❌ [${r.group}] ${r.name}\n       ${r.detail}`);
  }
  console.log('\n控制台日志（尾部 20 条）：');
  console.log(logs.slice(-20).join('\n'));

  fs.writeFileSync('/tmp/qa-r2-results.json', JSON.stringify({ pass, fail, blocked: blk, total: results.length, results }, null, 2));
  await ctx.close().catch(() => {});
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
