/**
 * QA R10 独立验收 —— background.js OPEN_FILE_URL 行为驱动器
 *
 * 不读源码、不看工程师结论，直接把 **构建产物** dist-extension/background.js
 * 载入 Node，用桩 chrome API 驱动 chrome.runtime.onMessage，断言真实回执。
 *
 * 重点覆盖 R10 根因与其"过度修复"反向风险：
 *  - 开关未勾选 → 必须 ok:false（不能再静默 ok:true）
 *  - 无 tabs 权限导致 tab.url 恒 undefined → **必须仍然 ok:true**（防误伤）
 *  - 落地 URL 可见且非 file:// → ok:false
 */

const HINT = '请在 chrome://extensions 的 MDnote 项勾选「允许访问文件网址」，才能在新标签页打开目录';

let listener = null;
let calls = null;

function installChromeStub({ allowed, createImpl, storage = {} }) {
  calls = { create: [], storageGet: [] };
  globalThis.chrome = {
    runtime: {
      getURL: (p) => 'chrome-extension://qa-stub/' + p,
      onMessage: { addListener: (fn) => { listener = fn; } },
      onInstalled: { addListener() {} },
      lastError: undefined,
    },
    action: { onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    contextMenus: { create() {}, onClicked: { addListener() {} }, removeAll(cb) { cb && cb(); } },
    tabs: {
      create: async (opts) => { calls.create.push(opts); return createImpl ? createImpl(opts) : { id: 1 }; },
      get: async () => ({ id: 1 }),
      query: async () => [],
      sendMessage: async () => {},
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    storage: {
      local: {
        get: async (k) => { calls.storageGet.push(k); return storage; },
        set: async () => {},
        remove: async () => {},
      },
      session: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
      onChanged: { addListener() {} },
    },
    extension: allowed === 'ABSENT'
      ? {}
      : { isAllowedFileSchemeAccess: allowed === 'THROW'
          ? async () => { throw new Error('boom'); }
          : async () => allowed },
  };
}

/** 驱动一次 OPEN_FILE_URL，返回 background 的回执 */
function sendOpenFileUrl(payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TIMEOUT: background 未回执（静默失败！）')), 3000);
    const ret = listener(
      { type: 'open-file-url', payload },
      { tab: { id: 99 } },
      (res) => { clearTimeout(timer); resolve(res); },
    );
    if (ret !== true) {
      clearTimeout(timer);
      reject(new Error('handler 未返回 true，异步 sendResponse 会被 Chrome 丢弃'));
    }
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <<< ' + detail}`);
}

async function scenario(title, cfg, payload) {
  installChromeStub(cfg);
  // 每个场景重新载入产物（cache-bust），保证监听器是干净的
  await import('./dist-extension/background.js?v=' + Math.random());
  const res = await sendOpenFileUrl(payload);
  return { res, calls };
}

console.log('=== QA R10 background.js OPEN_FILE_URL 行为验收 ===\n');

// A. 开关未勾选 → 必须如实回失败，且不应白开一个页签
{
  const { res, calls: c } = await scenario('A', { allowed: false }, { url: 'file:///Users/x/dir/' });
  check('A1 开关未勾选 → ok:false', res && res.ok === false, JSON.stringify(res));
  check('A2 开关未勾选 → error 为「允许访问文件网址」提示', res && res.error === HINT, JSON.stringify(res && res.error));
  check('A3 开关未勾选 → 不调用 tabs.create（不留空白页签）', c.create.length === 0, `create 被调用 ${c.create.length} 次`);
}

// B. 【防误伤核心】开关已勾选 + 无 tabs 权限（url/pendingUrl 均 undefined）→ 必须 ok:true
{
  const { res } = await scenario('B', { allowed: true, createImpl: () => ({ id: 7 }) }, { url: 'file:///Users/x/dir/' });
  check('B1 已勾选且 tab.url 不可见 → ok:true（不得误判失败）', res && res.ok === true, JSON.stringify(res));
  check('B2 回执带 tabId', res && res.tabId === 7, JSON.stringify(res));
}

// C. 落地 about:blank → 二道防线判失败
{
  const { res } = await scenario('C', { allowed: true, createImpl: () => ({ id: 8, url: 'about:blank' }) }, { url: 'file:///Users/x/dir/' });
  check('C1 落地 about:blank → ok:false', res && res.ok === false, JSON.stringify(res));
}

// D. 落地 chrome-error:// (走 pendingUrl) → 判失败
{
  const { res } = await scenario('D', { allowed: true, createImpl: () => ({ id: 9, pendingUrl: 'chrome-error://chromewebdata/' }) }, { url: 'file:///Users/x/dir/' });
  check('D1 pendingUrl 为 chrome-error → ok:false', res && res.ok === false, JSON.stringify(res));
}

// E. 落地 file:// → 成功
{
  const { res } = await scenario('E', { allowed: true, createImpl: () => ({ id: 10, url: 'file:///Users/x/dir/' }) }, { url: 'file:///Users/x/dir/' });
  check('E1 落地 file:// → ok:true', res && res.ok === true, JSON.stringify(res));
}

// F. 老浏览器无 isAllowedFileSchemeAccess → 无法判定，不得阻断
{
  const { res, calls: c } = await scenario('F', { allowed: 'ABSENT', createImpl: () => ({ id: 11 }) }, { url: 'file:///Users/x/dir/' });
  check('F1 API 不可用 → 不阻断，仍尝试开页签', c.create.length === 1, `create ${c.create.length} 次`);
  check('F2 API 不可用 → ok:true', res && res.ok === true, JSON.stringify(res));
}

// G. 探测抛错 → 同样不阻断
{
  const { res } = await scenario('G', { allowed: 'THROW', createImpl: () => ({ id: 12 }) }, { url: 'file:///Users/x/dir/' });
  check('G1 探测抛错 → 降级为不阻断，ok:true', res && res.ok === true, JSON.stringify(res));
}

// H. tabs.create reject → ok:false（原有 try/catch 仍在）
{
  const { res } = await scenario('H', { allowed: true, createImpl: () => { throw new Error('denied'); } }, { url: 'file:///Users/x/dir/' });
  check('H1 tabs.create 抛错 → ok:false', res && res.ok === false, JSON.stringify(res));
}

// I. 无 url → 回落 storage 里的最近目录
{
  const { res, calls: c } = await scenario('I',
    { allowed: true, createImpl: (o) => ({ id: 13, url: o.url }), storage: { 'mdnote-last-dir-url': 'file:///Users/x/last/' } },
    {});
  check('I1 缺 url → 回落最近目录', c.create[0] && c.create[0].url === 'file:///Users/x/last/', JSON.stringify(c.create[0]));
  check('I2 回落后 ok:true', res && res.ok === true, JSON.stringify(res));
}

// J. 安全：非 file:// 的 url 不得被直接使用
{
  const { calls: c } = await scenario('J',
    { allowed: true, createImpl: (o) => ({ id: 14, url: o.url }), storage: {} },
    { url: 'https://evil.example.com/' });
  check('J1 非 file:// URL 被拒绝，未跳转到该地址',
    c.create[0] && !String(c.create[0].url).startsWith('https://evil'),
    JSON.stringify(c.create[0]));
  check('J2 回落到 file:/// 根目录', c.create[0] && c.create[0].url === 'file:///', JSON.stringify(c.create[0]));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== 合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length} ===`);
if (failed.length) {
  console.log('失败项：');
  failed.forEach((f) => console.log(' - ' + f.name + ' :: ' + f.detail));
}
process.exit(failed.length ? 1 : 0);
