/**
 * MV3 Service Worker — 后台脚本（N03）
 *
 * 职责：
 * 1. chrome.action.onClicked — 点击工具栏图标打开编辑器标签页
 * 2. chrome.commands.onCommand — 全局快捷键打开编辑器标签页
 * 3. chrome.runtime.onMessage — 路由标签页间消息（dirty-change / recent-update / open-file）
 * 4. chrome.contextMenus — 右键菜单声明
 *
 * 设计权衡（Q05）：
 * 当前使用 action.onClicked 直接打开编辑器标签页，不设 default_popup。
 * 这样点击图标立即响应（零延迟），适合单入口场景。
 * 未来若需要 popup 菜单（如最近文件列表快速打开），改为设置 default_popup，
 * 但会引入一次额外点击（popup → 选择 → 打开）。
 *
 * 注意：MV3 service worker 是非持久的，会在空闲后被挂起。
 * 所有状态必须持久化到 chrome.storage，不能依赖 service worker 内存。
 *
 * #4 inline editor（iframe 注入）消息桥接说明：
 * - broadcastToAllTabs 通过 chrome.tabs.sendMessage 广播消息给各标签页的 content script。
 * - 对于 file:// .md 页面：content-md.ts（#1 iframe 注入）接收消息后通过 postMessage
 *   转发给 iframe 内的 App.tsx。
 * - 对于 chrome-extension:// editor.html 页面：无 content script 运行，
 *   sendMessage 静默失败（Chrome 不报错），消息丢失是可接受的。
 *
 * @module background
 */

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────

/** 编辑器页面 URL */
const EDITOR_URL = chrome.runtime.getURL('editor.html');

/** 消息类型常量（与 messaging.ts 保持一致，N05 批次5 会正式定义） */
const MessageType = {
  DIRTY_CHANGE: 'dirty-change',
  RECENT_UPDATE: 'recent-update',
  OPEN_FILE: 'open-file',
  GET_STATE: 'get-state',
  OPEN_EDITOR_TAB: 'open-editor-tab',
  TAB_ALIVE: 'tab-alive',
  MD_FILE_OPEN: 'md-file-open',
  /**
   * #1 Open 分流：content script 选中文件后请求「在新标签页打开该文件本身」。
   * 负载 {name, size, headHash, currentDir} → 回执 {ok:true, absPath} | {ok:false, reason}。
   */
  OPEN_PICKED_FILE: 'open-picked-file',
} as const;

/** 右键菜单 ID */
const CONTEXT_MENU_ID = 'mdnote-open-editor';

/** 文件锁 key 前缀（与 messaging.ts 保持一致，S19） */
const FILE_LOCK_PREFIX = 'file-lock:';

/** 待打开文件暂存 key（#1 内容脚本 / #4 新标签页打开文件共用） */
const PENDING_OPEN_KEY = 'mdnote-pending-open';

/**
 * 历史命中过的目录（最近优先），Open 探测时排在候选表前列。
 * 命中一次就记一次，下次跨目录 Open 基本一发命中。
 */
const OPEN_DIRS_KEY = 'mdnote-open-dirs';

/** 历史命中目录保留上限 */
const OPEN_DIRS_LIMIT = 8;

/** 单次 Open 最多探测的候选目录数（防止无谓 fetch 风暴） */
const CANDIDATE_DIR_LIMIT = 16;

/** 指纹取样的字符数（content-md.ts 侧同名常量必须相同） */
const HEAD_HASH_CHARS = 4096;

/** 整个候选目录探测流程的总超时（超时按 not-found 处理） */
const PROBE_TIMEOUT_MS = 3000;

/**
 * 「允许访问文件网址」未勾选时回给调用方的统一提示（R10）。
 * content-md.ts 收到 ok:false 后会降级为「当前页直接打开选中文件」。
 */
const FILE_ACCESS_HINT =
  '请在 chrome://extensions 的 MDnote 项勾选「允许访问文件网址」，才能在新标签页打开目录';

/**
 * 探测扩展是否已获得「允许访问文件网址」（chrome://extensions 里的开关）。
 *
 * R10 根因：开关未勾选时 Chrome **静默拦截** tabs.create(file://) —— 既不
 * reject 也不抛错，只是把新标签页落在 about:blank / chrome-error://。
 * 因此只靠 try/catch 会把失败当成功回 ok:true，用户看到的就是
 * 「点了 Open 什么都没发生」。
 *
 * chrome.extension.isAllowedFileSchemeAccess 是这件事的**权威判据**，且不需要
 * 任何额外权限。它不可用（老版本 Chrome / 非 MV3）时返回 null 表示"无法判定"，
 * 调用方按"不阻断"处理，改由落地 URL 校验兜底。
 *
 * @returns true=已允许；false=未允许；null=无法判定
 */
async function isFileSchemeAllowed(): Promise<boolean | null> {
  try {
    const probe = chrome.extension?.isAllowedFileSchemeAccess;
    if (typeof probe !== 'function') return null;
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// Open 绝对路径探测（配合 content-md.ts 的 open-picked-file）
// ──────────────────────────────────────────────
//
// 为什么要探测：MV3 里 chrome.fileSystem 不存在（manifest 声明会被静默丢弃），
// FileSystemFileHandle 与 File 都不带路径，所以 showOpenFilePicker 选完之后
// **拿不到绝对路径**。而新标签页必须用所选文件的真实绝对路径打开（拿「当前目录 +
// 文件名」硬拼是历史 bug，跨目录必 404）。
//
// 做法：content script 给出 name + size + 内容指纹，这里拿一小组**有序候选目录**
// 逐个 fetch('file://<dir>/<name>')，指纹相等即命中。
// 明确不做：不递归扫目录树、不解析 Chrome 目录列表 HTML、不新增 host_permissions
// （扩展能否读 file:// 只取决于用户的「允许访问文件网址」开关）。

/**
 * FNV-1a 32 位哈希（纯函数，无依赖）。
 *
 * 必须与 content-md.ts 的同名实现逐字一致 —— 两侧算出的指纹不同就永远 miss。
 *
 * @param input 待哈希字符串
 * @returns 无符号 32 位哈希值
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 拼接目录与文件名，避免根目录 '/' 拼出 '//name'。
 *
 * @param dir 目录绝对路径
 * @param name 文件名
 * @returns 文件绝对路径
 */
function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

/**
 * 读取历史命中目录列表（最近优先）。
 *
 * @returns 绝对路径数组；读不到或格式异常回空数组
 */
async function readOpenDirs(): Promise<string[]> {
  try {
    const stored = await chrome.storage.local.get(OPEN_DIRS_KEY);
    const list = stored?.[OPEN_DIRS_KEY];
    if (!Array.isArray(list)) return [];
    return list.filter((d): d is string => typeof d === 'string' && d.startsWith('/'));
  } catch {
    return [];
  }
}

/**
 * 把命中目录写回历史（去重、最近优先、上限 OPEN_DIRS_LIMIT）。
 *
 * @param dir 本次命中的目录绝对路径
 */
async function rememberOpenDir(dir: string): Promise<void> {
  try {
    const prev = await readOpenDirs();
    const next = [dir, ...prev.filter((d) => d !== dir)].slice(0, OPEN_DIRS_LIMIT);
    await chrome.storage.local.set({ [OPEN_DIRS_KEY]: next });
  } catch {
    // 历史记录只是加速手段，写失败不影响本次结果
  }
}

/**
 * 构造有序去重的候选目录表。
 *
 * 顺序即优先级：当前文档目录 → 历史命中目录 → 家目录下 Desktop/Documents/Downloads
 * → 家目录本身。截断到 CANDIDATE_DIR_LIMIT 个。
 *
 * @param currentDir 当前 file:// 文档所在目录
 * @param historyDirs 历史命中目录（最近优先）
 * @returns 候选目录绝对路径数组
 */
function buildCandidateDirs(currentDir: string, historyDirs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  /**
   * 归一化后入表（非绝对路径、重复项直接丢弃）。
   * @param dir 候选目录
   */
  const push = (dir: string): void => {
    if (!dir) return;
    // 去掉末尾多余的 '/'（根目录 '/' 保留）
    const norm = dir.length > 1 && dir.endsWith('/') ? dir.replace(/\/+$/, '') || '/' : dir;
    if (!norm.startsWith('/') || seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  };

  push(currentDir);
  for (const dir of historyDirs) push(dir);

  // 家目录常用位置（匹配不到家目录就整组跳过）
  const home = /^(\/Users\/[^/]+)/.exec(currentDir)?.[1];
  if (home) {
    push(home + '/Desktop');
    push(home + '/Documents');
    push(home + '/Downloads');
    push(home);
  }

  return out.slice(0, CANDIDATE_DIR_LIMIT);
}

/**
 * 探测单个候选目录下是否存在指纹匹配的目标文件。
 *
 * 注意：file:// 的 Response.status 可能是 200 也可能是 0（opaque-ish），
 * 因此**不能只判 res.ok**，一律以能否读到 body 且指纹是否相等为准。
 * 目录 URL 也会返回 HTML body，但指纹对不上，天然被排除。
 *
 * @param dir 候选目录
 * @param name 文件名
 * @param size 选中文件字节数（0 表示不参与粗筛）
 * @param headHash content script 侧算出的头部指纹
 * @returns 命中返回 true
 */
async function probeCandidateDir(
  dir: string,
  name: string,
  size: number,
  headHash: number,
): Promise<boolean> {
  const url = 'file://' + encodeURI(joinPath(dir, name));
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.text();
    if (!body) return false;
    // 粗筛：UTF-8 字节数恒 >= UTF-16 code unit 数，所以 body.length > size 必不是同一文件。
    // （size 是字节、body.length 是字符，中文文件两者不等，故只能做单向粗筛，不能做等值判据。）
    if (size > 0 && body.length > size) return false;
    return fnv1a32(body.slice(0, HEAD_HASH_CHARS)) === headHash;
  } catch {
    // 文件不存在 / 无权限 → fetch reject，视为未命中
    return false;
  }
}

/**
 * 顺序遍历候选目录，返回第一个命中的目录。
 *
 * @param candidates 候选目录（已按优先级排序）
 * @param name 文件名
 * @param size 选中文件字节数
 * @param headHash 头部指纹
 * @returns 命中目录；全 miss 返回 null
 */
async function locateFileDir(
  candidates: string[],
  name: string,
  size: number,
  headHash: number,
): Promise<string | null> {
  for (const dir of candidates) {
    if (await probeCandidateDir(dir, name, size, headHash)) return dir;
  }
  return null;
}

/**
 * 给 Promise 套总超时（超时回 fallback，不 reject）。
 *
 * @param task 待执行的 Promise
 * @param timeoutMs 超时毫秒数
 * @param fallback 超时返回值
 * @returns task 结果或 fallback
 */
function withTimeout<T>(task: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    task
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

// ──────────────────────────────────────────────
// 1. 工具栏图标点击 → 打开编辑器标签页
// ──────────────────────────────────────────────

/**
 * 点击扩展工具栏图标时触发。
 * 检查是否已有打开的编辑器标签页：
 * - 有则聚焦该标签页（避免重复打开）
 * - 无则创建新标签页
 *
 * 注意：此处需要 tabs 权限来查询已有标签页，但当前 permissions 未包含 tabs。
 * 降级方案：直接创建新标签页（每次点击都开新标签页）。
 * 若未来需要"聚焦已有标签页"行为，需在 manifest 中添加 tabs 权限。
 */
chrome.action.onClicked.addListener(async (_tab: chrome.tabs.Tab) => {
  // 降级方案：直接打开新标签页（无 tabs 权限）
  await chrome.tabs.create({ url: EDITOR_URL });
});

// ──────────────────────────────────────────────
// 2. 全局快捷键 → 打开编辑器标签页
// ──────────────────────────────────────────────

/**
 * 全局快捷键触发时调用。
 * manifest.json 中定义了 "open-editor" 命令（Ctrl+Shift+M / Cmd+Shift+M）。
 */
chrome.commands.onCommand.addListener(async (command: string) => {
  if (command === 'open-editor') {
    await chrome.tabs.create({ url: EDITOR_URL });
  }
});

// ──────────────────────────────────────────────
// 3. 消息路由 — 标签页间通信
// ──────────────────────────────────────────────

/**
 * 扩展内消息路由。
 *
 * 消息类型：
 * - DIRTY_CHANGE: 编辑器内容变更（dirty 状态同步给其他标签页）
 * - RECENT_UPDATE: 最近文件列表更新（广播给所有标签页）
 * - OPEN_FILE: 请求打开文件（从其他标签页触发）
 * - GET_STATE: 查询当前状态（用于新标签页初始化）
 *
 * 当前实现为消息转发（广播到所有标签页）。
 * 批次5 N05 messaging.ts 会提供更完善的封装（含文件锁协议 Q19）。
 *
 * #4 inline editor 消息桥接：
 * broadcastToAllTabs 发送的消息由 content-md.ts 接收并通过 postMessage
 * 转发给 iframe 内的 App.tsx。详见 content-md.ts 中的消息桥接代码。
 */
chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    // 类型守卫：确保 message 是带 type 字段的对象
    if (typeof message !== 'object' || message === null || !('type' in message)) {
      sendResponse({ ok: false, error: 'Invalid message format' });
      return false;
    }

    const msg = message as { type: string; payload?: unknown };
    const senderTabId = sender.tab?.id;

    switch (msg.type) {
      case MessageType.DIRTY_CHANGE: {
        // 广播 dirty 状态变更给所有其他标签页
        broadcastToOtherTabs(senderTabId, message);
        sendResponse({ ok: true });
        break;
      }

      case MessageType.RECENT_UPDATE: {
        // 广播最近文件列表更新给所有标签页。
        // #4 inline editor: content-md.ts（iframe 注入的 .md 页面）会接收此广播
        // 并通过 postMessage 转发给 iframe 内的 App.tsx。
        broadcastToAllTabs(message);
        sendResponse({ ok: true });
        break;
      }

      case MessageType.OPEN_FILE: {
        // 打开文件请求：创建新标签页打开编辑器（带文件信息）
        // 批次5 N05 会完善文件锁协议，当前仅创建标签页
        chrome.tabs.create({ url: EDITOR_URL }).then((tab) => {
          // 新标签页创建后，发送文件信息（标签页 ready 后接收）
          // 使用 chrome.tabs.sendMessage 在批次5 实现
          sendResponse({ ok: true, tabId: tab.id });
        });
        return true; // 异步响应
      }

      case MessageType.OPEN_EDITOR_TAB: {
        // #4 多标签页：请求打开新的编辑器标签页（New/Open 不替换当前窗口）
        chrome.tabs.create({ url: EDITOR_URL }).then((tab) => {
          sendResponse({ ok: true, tabId: tab.id });
        });
        return true; // 异步响应
      }

      case MessageType.OPEN_PICKED_FILE: {
        // #1 Open（inline 模式，当前页非空）：在新标签页打开**用户刚选中的那个文件**。
        //
        // content script 不能直接调 chrome.tabs，也拿不到选中文件的绝对路径
        // （MV3 无 chrome.fileSystem；FileSystemFileHandle / File 均不带路径），
        // 因此它只能给出 name + size + 内容指纹，由这里探测出真实绝对路径再开页签。
        //
        // 回执契约：
        //   命中 → { ok: true, absPath }
        //   失败 → { ok: false, reason: 'file-access-disabled' | 'not-found'
        //                              | 'bad-request' | 'tab-create-failed' }
        // content script 收到 ok:false 会降级为「就地加载 + warn 提示」，绝不静默。
        const openPayload = msg.payload as
          | { name?: string; size?: number; headHash?: number; currentDir?: string }
          | undefined;
        const pickedName = typeof openPayload?.name === 'string' ? openPayload.name : '';
        const pickedHash = typeof openPayload?.headHash === 'number' ? openPayload.headHash : NaN;
        const pickedSize =
          typeof openPayload?.size === 'number' && openPayload.size > 0 ? openPayload.size : 0;
        const currentDir = typeof openPayload?.currentDir === 'string' ? openPayload.currentDir : '';

        (async () => {
          if (!pickedName || Number.isNaN(pickedHash)) {
            sendResponse({ ok: false, reason: 'bad-request' });
            return;
          }

          // ── ①：先查「允许访问文件网址」开关（权威判据）──────────────────
          // 未勾选时 fetch('file://…') 读不到内容、tabs.create(file://) 还会被
          // **静默拦截**（不 reject、不抛错）。提前如实回失败，调用方好给出
          // 「去 chrome://extensions 打开开关」的准确提示，而不是含糊的失败。
          const allowed = await isFileSchemeAllowed();
          if (allowed === false) {
            sendResponse({ ok: false, reason: 'file-access-disabled', error: FILE_ACCESS_HINT });
            return;
          }

          // ── ②：有序候选目录探测（总超时 3s，超时按 not-found 处理）────────
          const history = await readOpenDirs();
          const candidates = buildCandidateDirs(currentDir, history);
          const hitDir = await withTimeout(
            locateFileDir(candidates, pickedName, pickedSize, pickedHash),
            PROBE_TIMEOUT_MS,
            null,
          );
          if (!hitDir) {
            sendResponse({ ok: false, reason: 'not-found' });
            return;
          }

          // ── ③：用**真实绝对路径**开新标签页 ─────────────────────────────
          const absPath = joinPath(hitDir, pickedName);
          try {
            const tab = await chrome.tabs.create({ url: 'file://' + encodeURI(absPath) });

            // 校验**真实落地的 URL**（二道防线）。
            // tabs 权限已申请，实测 tabs.create 立即返回 {url:"", pendingUrl:"file://…"}，
            // 稍后 url 会补齐为 file:// —— 也就是说 landed URL 通常**看得见**。
            // 但仍保留空值放行：拿不到值只说明"看不见"，不代表"落错了"，
            // 若把空值判成失败会误伤已勾选开关的用户。只有在看得见 landed URL
            // 且它确实不是 file:// 时（about:blank / chrome-error://）才判失败。
            const landed = tab?.url || tab?.pendingUrl || '';
            if (landed && !landed.startsWith('file://')) {
              sendResponse({ ok: false, reason: 'file-access-disabled', error: FILE_ACCESS_HINT });
              return;
            }

            // 命中目录写回历史，下次同目录 Open 一发命中
            void rememberOpenDir(hitDir);
            sendResponse({ ok: true, absPath, tabId: tab.id });
          } catch (err) {
            sendResponse({ ok: false, reason: 'tab-create-failed', error: String(err) });
          }
        })();
        return true; // 异步响应
      }

      case MessageType.TAB_ALIVE: {
        // #5 文件锁：查询锁主标签页是否仍存活（tabs.get 不需要 tabs 权限）
        const tabId = (msg.payload as { tabId?: number } | undefined)?.tabId;
        if (typeof tabId !== 'number' || tabId < 0) {
          sendResponse({ ok: true, alive: false });
          return false;
        }
        chrome.tabs.get(tabId)
          .then(() => sendResponse({ ok: true, alive: true }))
          .catch(() => sendResponse({ ok: true, alive: false }));
        return true; // 异步响应
      }

      case MessageType.MD_FILE_OPEN: {
        // #1 内容脚本接管：浏览器打开 .md 文件时，暂存内容、打开编辑器标签页、
        // 然后关闭原来的纯文本标签页（避免残留）。
        //
        // 注意：#4 inline editor（iframe 注入）模式下，content-md.ts 不再发送
        // md-file-open 消息。此 handler 保留作为备用路径：
        // - 旧版 content script（未更新的用户）仍会发送此消息
        // - 未来可能作为降级方案（iframe 加载失败时回退到标签页跳转）
        const payload = msg.payload as { name?: string; content?: string; url?: string } | undefined;
        if (payload && typeof payload.content === 'string') {
          chrome.storage.local
            .set({
              [PENDING_OPEN_KEY]: {
                name: payload.name || 'Opened File.md',
                content: payload.content,
                fromUrl: true,
                url: payload.url || '',
                createdAt: Date.now(),
              },
            })
            .then(() => chrome.tabs.create({ url: EDITOR_URL }))
            .then((tab) => {
              // Close the original plain-text .md tab
              if (senderTabId !== undefined) {
                chrome.tabs.remove(senderTabId).catch(() => {});
              }
              sendResponse({ ok: true, tabId: tab.id });
            })
            .catch(() => sendResponse({ ok: false, error: 'storage write failed' }));
          return true; // 异步响应
        }
        sendResponse({ ok: false, error: 'no content' });
        break;
      }

      case MessageType.GET_STATE: {
        // 查询状态：从 chrome.storage 读取持久化状态
        chrome.storage.local.get(['mdnote-recent', 'mdnote-settings'], (result) => {
          sendResponse({ ok: true, state: result });
        });
        return true; // 异步响应
      }

      default: {
        // 未知消息类型：转发给所有标签页（兼容未来扩展）
        broadcastToOtherTabs(senderTabId, message);
        sendResponse({ ok: true });
        break;
      }
    }

    return false; // 同步响应完成
  },
);

// ──────────────────────────────────────────────
// 4. 标签页关闭 → 清理该标签页持有的文件锁（#5）
// ──────────────────────────────────────────────

/**
 * 监听标签页关闭（tabs.onRemoved 不需要 tabs 权限）。
 * 标签页关闭时立即清除其持有的所有文件锁，
 * 避免"窗口已关闭但文件仍显示只读"的误报（原 30 分钟超时太慢）。
 */
chrome.tabs.onRemoved.addListener((tabId: number) => {
  try {
    chrome.storage.session.get(null).then((all) => {
      const keysToRemove: string[] = [];
      for (const [key, value] of Object.entries(all)) {
        if (key.startsWith(FILE_LOCK_PREFIX)) {
          const record = value as { tabId?: number };
          if (record.tabId === tabId) {
            keysToRemove.push(key);
          }
        }
      }
      if (keysToRemove.length > 0) {
        chrome.storage.session.remove(keysToRemove).catch(() => {});
      }
    }).catch(() => {});
  } catch {
    // 忽略
  }
});

// ──────────────────────────────────────────────
// 5. 右键菜单
// ──────────────────────────────────────────────

/**
 * 安装时创建右键菜单。
 * 提供"在新标签页中打开 MDnote 编辑器"选项。
 */
chrome.runtime.onInstalled.addListener(() => {
  // 清除旧菜单（避免重复创建）
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Open MDnote Editor',
      contexts: ['page'],
    });
  });
});

/**
 * 右键菜单点击 → 打开编辑器标签页。
 */
chrome.contextMenus.onClicked.addListener(async (info: chrome.contextMenus.OnClickData, _tab?: chrome.tabs.Tab) => {
  if (info.menuItemId === CONTEXT_MENU_ID) {
    await chrome.tabs.create({ url: EDITOR_URL });
  }
});

// ──────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────

/**
 * 向所有标签页广播消息（包括发送者自身）。
 *
 * #4 inline editor 消息桥接：
 * - file:// .md 页面：消息由 content-md.ts 接收，通过 postMessage 转发给
 *   iframe 内的 App.tsx（详见 content-md.ts 的消息桥接代码）。
 * - chrome-extension:// editor.html 页面：无 content script，sendMessage
 *   静默失败（Chrome 不报错）。
 *
 * @param message 消息对象
 */
async function broadcastToAllTabs(message: unknown): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id !== undefined) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {
          // 标签页可能未加载 content script，忽略错误
        });
      }
    }
  } catch {
    // tabs.query 需要 tabs 权限，当前未申请时静默降级
  }
}

/**
 * 向除发送者外的所有标签页广播消息。
 * @param excludeTabId 排除的标签页 ID（发送者）
 * @param message 消息对象
 */
async function broadcastToOtherTabs(
  excludeTabId: number | undefined,
  message: unknown,
): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id !== undefined && tab.id !== excludeTabId) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {
          // 标签页可能未加载 content script，忽略错误
        });
      }
    }
  } catch {
    // tabs.query 需要 tabs 权限，当前未申请时静默降级
  }
}
