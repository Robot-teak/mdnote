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
} as const;

/** 右键菜单 ID */
const CONTEXT_MENU_ID = 'mdnote-open-editor';

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
        // 广播最近文件列表更新给所有标签页
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
// 4. 右键菜单
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
