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
  OPEN_FILE_URL: 'open-file-url',
} as const;

/** 右键菜单 ID */
const CONTEXT_MENU_ID = 'mdnote-open-editor';

/** 文件锁 key 前缀（与 messaging.ts 保持一致，S19） */
const FILE_LOCK_PREFIX = 'file-lock:';

/** 待打开文件暂存 key（#1 内容脚本 / #4 新标签页打开文件共用） */
const PENDING_OPEN_KEY = 'mdnote-pending-open';

/**
 * 最近一次内联打开的 file:// 文档所在目录（#1 Open 的浏览起点）。
 * 由 content-md.ts 在渲染 file:// 文档时写入。
 */
const LAST_DIR_URL_KEY = 'mdnote-last-dir-url';

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

      case MessageType.OPEN_FILE_URL: {
        // #1 Open（inline 模式）：在新标签页打开 file:// URL。
        //
        // content script 不能直接调用 chrome.tabs，由此处代劳。
        // 用途：打开当前文档所在目录的 file:// 目录列表，用户点中的 .md
        // 会导航成 file:// 文档页并由 content-md.js 内联渲染 ——
        // 这样「打开的内容渲染在 file:// 文档页」，且新标签页不会替换
        // 当前标签页已有内容。
        //
        // 独立 editor.html 标签页也会直接发这条消息（它没有 file:// 父页面，
        // postMessage 无人接收）。它可能不知道该从哪个目录开始浏览，
        // 因此 url 缺失时回落到最近一次内联打开的目录，再不行就用根目录。
        //
        // 安全：只允许 file:// 前缀（不做任意 URL 跳转）。
        // 前置条件：chrome://extensions → MDnote → 勾选「允许访问文件网址」，
        // 否则 tabs.create 会失败，调用方侧会降级到文件选择器。
        const requestedUrl = (msg.payload as { url?: string } | undefined)?.url;
        const hasValidUrl = typeof requestedUrl === 'string' && requestedUrl.startsWith('file://');

        (async () => {
          let targetUrl = hasValidUrl ? (requestedUrl as string) : '';
          if (!targetUrl) {
            try {
              const stored = await chrome.storage.local.get(LAST_DIR_URL_KEY);
              const lastDir = stored?.[LAST_DIR_URL_KEY];
              targetUrl =
                typeof lastDir === 'string' && lastDir.startsWith('file://') ? lastDir : 'file:///';
            } catch {
              targetUrl = 'file:///';
            }
          }
          // ── R10 ①：先查「允许访问文件网址」开关（权威判据）──────────────
          // 未勾选时 tabs.create(file://) 会被**静默拦截**（不 reject、不抛错），
          // 旧实现的 try/catch 因此永远走 ok:true，调用方误判成功 → 用户点
          // Open 什么都没发生。这里提前如实回失败，调用方好走降级。
          const allowed = await isFileSchemeAllowed();
          if (allowed === false) {
            sendResponse({ ok: false, error: FILE_ACCESS_HINT });
            return;
          }

          try {
            const tab = await chrome.tabs.create({ url: targetUrl });

            // ── R10 ②：校验**真实落地的 URL**（二道防线）────────────────
            // 注意 manifest 未申请 "tabs" 权限，Chrome 会把 url/pendingUrl
            // 抹成 undefined。那是"看不到"而不是"落错了"—— 若把空值判成失败，
            // 已勾选开关的用户也会被误伤。因此只有在**看得见** landed URL
            // 且它确实不是 file:// 时（about:blank / chrome-error://）才判失败。
            const landed = tab?.url || tab?.pendingUrl || '';
            const isFileTab = landed.startsWith('file://');
            if (landed && !isFileTab) {
              sendResponse({ ok: false, error: FILE_ACCESS_HINT });
              return;
            }

            sendResponse({ ok: true, tabId: tab.id, url: targetUrl });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
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
