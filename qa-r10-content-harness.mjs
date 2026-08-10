/**
 * QA R10 独立验收 —— content-md.js Open 分流 / 降级路径端到端驱动器
 *
 * R9 验收的教训：只 grep + 读码，漏掉了"回执 ok 但页没开"的静默失败。
 * 这次直接把 **构建产物** dist-extension/content-md.js 载入 Node，
 * 用最小 DOM 桩把 IIFE 跑起来，再从 iframe 侧发 `mdnote:open-file-request`，
 * 断言父页面回传的 `mdnote:file-picked` 负载。
 *
 * 覆盖：
 *  - 非空文档 + background 回 ok:false → 必须**降级**（content + warn），不能只报错
 *  - 非空文档 + background **不回执**（R10 根因场景）→ 必须降级，不能假装成功
 *  - 非空文档 + background 回 ok:true → 必须 {openedInNewTab:true}，当前页不动
 *  - 空文档 → 就地加载、**无 warn**（R8 行为不得回归）
 *  - 降级后按 Save → 必须能用缓存句柄写回刚选中的文件
 */

let savePickerCalls = [];
let openPickerCalls = [];

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <<< ' + detail}`);
}

/** 搭一套刚好够跑 content script 的最小 DOM / chrome 环境 */
function makeEnv({ sendMessageImpl, pickerImpl }) {
  const posted = [];   // 父页面 → iframe 的所有消息
  const listeners = {};
  const writes = [];   // 句柄实际写入内容

  const mkStyle = () => ({ cssText: '', opacity: '' });
  const mkEl = (tag) => ({
    tagName: tag, id: '', tabIndex: 0, src: '', allow: '', title: '', type: '', textContent: '',
    style: mkStyle(), children: [],
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    addEventListener() {}, removeEventListener() {}, remove() {}, focus() {},
    contentWindow: {
      postMessage: (m) => posted.push(m),
      focus() {},
    },
  });

  const body = mkEl('body');
  body.innerHTML = '';
  body.innerText = '# 当前页已有内容\n\n这是原文件正文。';

  // Node 22 的 globalThis.navigator 是只读 getter，必须 defineProperty 覆盖
  const setGlobal = (k, v) =>
    Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });

  setGlobal('location', {
    pathname: '/Users/qa/docs/note.md',
    href: 'file:///Users/qa/docs/note.md',
    protocol: 'file:',
    ancestorOrigins: { length: 0 },
  });
  setGlobal('document', {
    documentElement: { style: mkStyle() },
    body,
    createElement: mkEl,
    addEventListener() {}, removeEventListener() {},
  });
  setGlobal('navigator', { userActivation: { isActive: true } });
  setGlobal('fetch', async () => { throw new Error('file:// fetch blocked'); });
  setGlobal('window', {
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    removeEventListener: () => {},
    showOpenFilePicker: (...a) => { openPickerCalls.push(a[0]); return pickerImpl(...a); },
    showSaveFilePicker: async (opts) => {
      savePickerCalls.push(opts);
      return makeHandle(opts?.suggestedName || 'saved.md', '', writes);
    },
    navigator: globalThis.navigator,
    location: globalThis.location,
    focus() {},
  });
  setGlobal('chrome', {
    runtime: {
      id: 'qa-stub-id',
      getURL: (p) => 'chrome-extension://qa/' + p,
      onMessage: { addListener() {} },
      sendMessage: sendMessageImpl,
    },
    storage: { local: { set: async () => {}, get: async () => ({}), remove: async () => {} } },
  });

  return {
    posted,
    writes,
    /** 模拟 iframe 内编辑器 postMessage 上来 */
    emit: async (data) => {
      for (const fn of listeners.message || []) await fn({ data });
    },
    hasMessageListener: () => (listeners.message || []).length > 0,
    /** body 里是否被塞进了手势遮罩（R8：正常 Open 路径必须无遮罩） */
    overlayIds: () => body.children.map((c) => c.id).filter(Boolean),
    bodyChildCount: () => body.children.length,
  };
}

/** 造一个可读可写的文件句柄桩 */
function makeHandle(name, text, writes) {
  return {
    name,
    kind: 'file',
    getFile: async () => ({ name, text: async () => text }),
    createWritable: async () => ({
      write: async (t) => { writes.push(t); },
      close: async () => {},
    }),
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
  };
}

/** 载入产物并跑到"消息桥接已就绪" */
async function boot(env) {
  await import('./dist-extension/content-md.js?v=' + Math.random());
  // IIFE 内部有若干 await（readPageContent / storage.set），让微任务跑完
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
  if (!env.hasMessageListener()) throw new Error('content script 未注册 message 监听器，桩环境不足');
}

/** 发一次 Open 请求，等回执 */
async function doOpen(env, docEmpty) {
  env.posted.length = 0;
  await env.emit({ type: 'mdnote:open-file-request', payload: { docEmpty } });
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
  return env.posted.find((m) => m && m.type === 'mdnote:file-picked');
}

console.log('=== QA R10 content-md.js Open 分流 / 降级 端到端验收 ===\n');

const HINT_KEY = '允许访问文件网址';

// ── 场景 1：非空文档 + background 明确回 ok:false（开关未勾选）→ 必须降级 ──
{
  const writes = [];
  const env = makeEnv({
    sendMessageImpl: async () => ({ ok: false, error: '请勾选「允许访问文件网址」' }),
    pickerImpl: async () => [makeHandle('picked.md', 'PICKED CONTENT', writes)],
  });
  env.writes.push = writes.push.bind(writes);
  await boot(env);

  const ack = env.posted.length; // boot 后清零前先不管
  const res = await doOpen(env, false);
  check('S1-1 有回执且是 mdnote:file-picked', !!res, JSON.stringify(env.posted));
  const p = res && res.payload;
  check('S1-2 降级：回传了选中文件内容', p && p.content === 'PICKED CONTENT', JSON.stringify(p));
  check('S1-3 降级：回传了文件名', p && p.name === 'picked.md', JSON.stringify(p));
  check('S1-4 降级：带 warn 且含「允许访问文件网址」', p && typeof p.warn === 'string' && p.warn.includes(HINT_KEY), JSON.stringify(p && p.warn));
  check('S1-5 降级：**不得**带 openedInNewTab（否则编辑器会当成已开新页而不加载）', p && p.openedInNewTab === undefined, JSON.stringify(p));
  check('S1-6 降级：**不得**带 error（否则 platform 会塌缩成 error 分支、内容丢失）', p && p.error === undefined, JSON.stringify(p));
  check('S1-R8 正常 Open 路径无中间手势遮罩（R8 不回归）',
    !env.overlayIds().includes('__mdnote_open_gesture'),
    'body 内元素 id: ' + JSON.stringify(env.overlayIds()));

  // 场景 4（承接）：降级后按 Save，必须能用缓存句柄写回刚选中的文件
  env.posted.length = 0;
  await env.emit({ type: 'mdnote:save-to-original', payload: { content: 'EDITED BY USER', requestId: 'r1' } });
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
  const saveRes = env.posted.find((m) => m && m.type === 'mdnote:save-complete');
  check('S1-7 降级后 Save：有 save-complete 回执', !!saveRes, JSON.stringify(env.posted));
  check('S1-8 降级后 Save：ok:true（句柄已缓存，不再弹选择器）', saveRes && saveRes.payload && saveRes.payload.ok === true, JSON.stringify(saveRes && saveRes.payload));
  check('S1-9 降级后 Save：内容真的写进了刚选中的文件', writes.length === 1 && writes[0] === 'EDITED BY USER', JSON.stringify(writes));
  check('S1-10 降级后 Save：requestId 原样回传（RACE-01 不退化）', saveRes && saveRes.payload && saveRes.payload.requestId === 'r1', JSON.stringify(saveRes && saveRes.payload));
}

// ── 场景 2：非空文档 + background **不回执**（R10 根因：静默拦截）→ 必须降级 ──
{
  const writes = [];
  const env = makeEnv({
    sendMessageImpl: async () => undefined,
    pickerImpl: async () => [makeHandle('silent.md', 'SILENT CASE', writes)],
  });
  await boot(env);
  const res = await doOpen(env, false);
  const p = res && res.payload;
  check('S2-1 无回执 → 仍然降级回传内容（不再"啥都没发生"）', p && p.content === 'SILENT CASE', JSON.stringify(p));
  check('S2-2 无回执 → 带 warn', p && typeof p.warn === 'string' && p.warn.includes(HINT_KEY), JSON.stringify(p && p.warn));
  check('S2-3 无回执 → 不得判成 openedInNewTab', p && p.openedInNewTab === undefined, JSON.stringify(p));
}

// ── 场景 3：非空文档 + background 回 ok:true → 当前页必须一字不动 ──
{
  const writes = [];
  const env = makeEnv({
    sendMessageImpl: async () => ({ ok: true, tabId: 5 }),
    pickerImpl: async () => [makeHandle('newtab.md', 'SHOULD NOT LOAD', writes)],
  });
  await boot(env);
  const res = await doOpen(env, false);
  const p = res && res.payload;
  check('S3-1 成功开新页 → openedInNewTab:true', p && p.openedInNewTab === true, JSON.stringify(p));
  check('S3-2 成功开新页 → **不回传** content（当前页未保存内容必须保留）', p && p.content === undefined, JSON.stringify(p));
  check('S3-3 成功开新页 → 无 warn', p && p.warn === undefined, JSON.stringify(p));

  // 且此分支刻意不缓存句柄：Save 应仍写回"当前页原文件"，而不是新选的文件
  env.posted.length = 0;
  await env.emit({ type: 'mdnote:save-to-original', payload: { content: 'X', silentOnly: true } });
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
  const sc = env.posted.find((m) => m && m.type === 'mdnote:save-complete');
  check('S3-4 成功开新页 → 未污染 Save 句柄（自动保存回 needsAuth，未写入新选文件）',
    writes.length === 0 && sc && sc.payload && sc.payload.needsAuth === true,
    'writes=' + JSON.stringify(writes) + ' resp=' + JSON.stringify(sc && sc.payload));
}

// ── 场景 4：空文档 → 就地加载，且**无 warn**（R8 既有行为不得回归）──
{
  const writes = [];
  let sendCalled = 0;
  const env = makeEnv({
    sendMessageImpl: async () => { sendCalled++; return { ok: true }; },
    pickerImpl: async () => [makeHandle('empty-case.md', 'LOADED IN PLACE', writes)],
  });
  await boot(env);
  const res = await doOpen(env, true);
  const p = res && res.payload;
  check('S4-1 空文档 → 就地加载内容', p && p.content === 'LOADED IN PLACE', JSON.stringify(p));
  check('S4-2 空文档 → 无 warn toast', p && p.warn === undefined, JSON.stringify(p));
  check('S4-3 空文档 → 不走开新页签（未调 background）', sendCalled === 0, 'sendMessage 调用 ' + sendCalled + ' 次');
}

// ── 场景 5：用户取消选择器 → cancelled，且不得误报 warn/error ──
{
  const env = makeEnv({
    sendMessageImpl: async () => ({ ok: true }),
    pickerImpl: async () => { const e = new Error('abort'); e.name = 'AbortError'; throw e; },
  });
  await boot(env);
  const res = await doOpen(env, false);
  const p = res && res.payload;
  check('S5-1 取消 → cancelled:true', p && p.cancelled === true, JSON.stringify(p));
  check('S5-2 取消 → 无 warn', p && p.warn === undefined, JSON.stringify(p));
}

// ── 场景 6：sendMessage 抛错（background 不在/未装 handler）→ 降级 ──
{
  const writes = [];
  const env = makeEnv({
    sendMessageImpl: async () => { throw new Error('Receiving end does not exist'); },
    pickerImpl: async () => [makeHandle('throw.md', 'THROW CASE', writes)],
  });
  await boot(env);
  const res = await doOpen(env, false);
  const p = res && res.payload;
  check('S6-1 sendMessage 抛错 → 仍降级回传内容', p && p.content === 'THROW CASE', JSON.stringify(p));
  check('S6-2 sendMessage 抛错 → 带 warn', p && typeof p.warn === 'string' && p.warn.includes(HINT_KEY), JSON.stringify(p && p.warn));
}

// ── 场景 7（R7 回归）：冷启动显式 Save（从未走过 Open，无缓存句柄）──
//    必须弹 showSaveFilePicker（另存为），带 suggestedName + startIn，
//    且**绝不**弹 showOpenFilePicker（那是 R7 之前的错误行为）。
{
  const writes = [];
  const env = makeEnv({
    sendMessageImpl: async () => ({ ok: true }),
    pickerImpl: async () => [makeHandle('should-not-open.md', '', writes)],
  });
  savePickerCalls = [];
  openPickerCalls = [];
  await boot(env);

  env.posted.length = 0;
  await env.emit({ type: 'mdnote:save-to-original', payload: { content: 'COLD START SAVE', requestId: 'cs1' } });
  for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
  const sc = env.posted.find((m) => m && m.type === 'mdnote:save-complete');

  check('S7-1 冷启动 Save → 弹的是 showSaveFilePicker（另存为）', savePickerCalls.length === 1, '调用 ' + savePickerCalls.length + ' 次');
  check('S7-2 冷启动 Save → **未**弹 showOpenFilePicker', openPickerCalls.length === 0, '调用 ' + openPickerCalls.length + ' 次');
  check('S7-3 冷启动 Save → 预填原文件名 note.md', savePickerCalls[0] && savePickerCalls[0].suggestedName === 'note.md', JSON.stringify(savePickerCalls[0]));
  check('S7-4 冷启动 Save → 传了 startIn（按目录智能定位）', savePickerCalls[0] && savePickerCalls[0].startIn !== undefined, JSON.stringify(savePickerCalls[0]));
  check('S7-5 冷启动 Save → 刻意不传 id（避免覆盖 startIn）', savePickerCalls[0] && savePickerCalls[0].id === undefined, JSON.stringify(savePickerCalls[0]));
  check('S7-6 冷启动 Save → 写盘成功并回执 ok', sc && sc.payload && sc.payload.ok === true, JSON.stringify(sc && sc.payload));
  check('S7-7 冷启动 Save → requestId 原样回传', sc && sc.payload && sc.payload.requestId === 'cs1', JSON.stringify(sc && sc.payload));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== 合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length} ===`);
if (failed.length) {
  console.log('失败项：');
  failed.forEach((f) => console.log(' - ' + f.name + ' :: ' + f.detail));
}
process.exit(failed.length ? 1 : 0);
