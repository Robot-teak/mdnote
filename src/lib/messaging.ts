/**
 * 标签页通信封装 + 文件锁协议（N05 + S19）
 *
 * 提供标签页间消息通信和文件锁协议：
 * - sendToTabs / onMessage：chrome.runtime.sendMessage / onMessage 封装
 * - 文件锁（S19）：同一文件多标签页打开时，只允许一个标签页持有写权限
 *   锁状态通过 chrome.storage.session 同步（会话级，标签页关闭自动释放）
 *
 * 桌面版：单窗口模式，文件锁不适用，函数为空操作。
 *
 * @module messaging
 */

import { isExtension } from './platform';

// ──────────────────────────────────────────────
// 消息类型
// ──────────────────────────────────────────────

/** 消息类型常量 */
export const MessageType = {
  DIRTY_CHANGE: 'dirty-change',
  RECENT_UPDATE: 'recent-update',
  OPEN_FILE: 'open-file',
  GET_STATE: 'get-state',
  FILE_LOCK_ACQUIRE: 'file-lock-acquire',
  FILE_LOCK_RELEASE: 'file-lock-release',
  FILE_LOCK_QUERY: 'file-lock-query',
} as const;

/** 标签页间消息 */
export interface TabMessage {
  type: typeof MessageType[keyof typeof MessageType];
  payload?: unknown;
  /** 发送者标签页 ID */
  senderTabId?: number;
}

/** 消息处理器 */
export type MessageHandler = (message: TabMessage, sender: chrome.runtime.MessageSender) => void | Promise<void>;

// ──────────────────────────────────────────────
// 消息通信
// ──────────────────────────────────────────────

/**
 * 向所有标签页（通过 background SW 中转）发送消息。
 * 桌面版为空操作。
 * @param message 消息对象
 */
export async function sendToTabs(message: TabMessage): Promise<void> {
  if (!isExtension || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return;
  }
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // background SW 可能未就绪，忽略
  }
}

/**
 * 注册消息监听器。
 * @param handler 消息处理函数
 * @returns 取消监听函数
 */
export function onMessage(handler: MessageHandler): () => void {
  if (!isExtension || typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
    return () => {};
  }

  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    if (typeof message === 'object' && message !== null && 'type' in message) {
      const msg = message as TabMessage;
      const result = handler(msg, sender);
      // 如果 handler 返回 Promise，异步响应
      if (result instanceof Promise) {
        result.then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
        return true; // 异步响应
      }
      sendResponse({ ok: true });
    }
    return false;
  };

  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

// ──────────────────────────────────────────────
// 文件锁协议（S19）
// ──────────────────────────────────────────────

/** chrome.storage.session 中的文件锁键前缀 */
const FILE_LOCK_PREFIX = 'file-lock:';

/** 文件锁记录 */
interface FileLockRecord {
  /** 持有锁的标签页 ID */
  tabId: number;
  /** 获取锁的时间戳 */
  acquiredAt: number;
}

/**
 * 获取当前标签页 ID。
 * @returns 标签页 ID，不可用时返回 -1
 */
async function getCurrentTabId(): Promise<number> {
  if (!isExtension || typeof chrome === 'undefined' || !chrome.tabs) {
    return -1;
  }
  try {
    const tab = await chrome.tabs.getCurrent();
    return tab?.id ?? -1;
  } catch {
    return -1;
  }
}

/**
 * 请求文件写锁。
 *
 * 如果文件未被其他标签页锁定，获取锁并返回 true。
 * 如果已被其他标签页锁定，返回 false。
 * 如果当前标签页已持有锁，返回 true（幂等）。
 *
 * @param fileId 文件唯一标识
 * @returns 是否成功获取锁
 */
export async function acquireFileLock(fileId: string): Promise<boolean> {
  if (!isExtension || typeof chrome === 'undefined' || !chrome.storage?.session) {
    return true; // 桌面版无需文件锁
  }

  const key = FILE_LOCK_PREFIX + fileId;
  const currentTabId = await getCurrentTabId();

  try {
    const result = await chrome.storage.session.get(key);
    const existing = result[key] as FileLockRecord | undefined;

    if (existing) {
      // 已被当前标签页锁定 → 幂等返回 true
      if (existing.tabId === currentTabId) {
        return true;
      }
      // 已被其他标签页锁定 → 检查是否过期（30 分钟超时）
      const now = Date.now();
      if (now - existing.acquiredAt > 30 * 60 * 1000) {
        // 过期锁，强制获取
        await chrome.storage.session.set({
          [key]: { tabId: currentTabId, acquiredAt: now } satisfies FileLockRecord,
        });
        return true;
      }
      return false;
    }

    // 无锁，获取
    await chrome.storage.session.set({
      [key]: { tabId: currentTabId, acquiredAt: Date.now() } satisfies FileLockRecord,
    });
    return true;
  } catch {
    // storage 不可用时降级为允许写入
    return true;
  }
}

/**
 * 释放文件写锁。
 * @param fileId 文件唯一标识
 */
export async function releaseFileLock(fileId: string): Promise<void> {
  if (!isExtension || typeof chrome === 'undefined' || !chrome.storage?.session) {
    return;
  }

  const key = FILE_LOCK_PREFIX + fileId;
  try {
    const result = await chrome.storage.session.get(key);
    const existing = result[key] as FileLockRecord | undefined;
    if (existing && existing.tabId === await getCurrentTabId()) {
      await chrome.storage.session.remove(key);
    }
  } catch {
    // 忽略
  }
}

/**
 * 检查文件是否被其他标签页锁定。
 * @param fileId 文件唯一标识
 * @returns 是否被其他标签页锁定
 */
export async function isFileLocked(fileId: string): Promise<boolean> {
  if (!isExtension || typeof chrome === 'undefined' || !chrome.storage?.session) {
    return false;
  }

  const key = FILE_LOCK_PREFIX + fileId;
  const currentTabId = await getCurrentTabId();

  try {
    const result = await chrome.storage.session.get(key);
    const existing = result[key] as FileLockRecord | undefined;

    if (!existing) return false;
    if (existing.tabId === currentTabId) return false; // 自己持有，不算被锁

    // 检查过期
    const now = Date.now();
    if (now - existing.acquiredAt > 30 * 60 * 1000) {
      return false; // 过期锁
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * 清理所有当前标签页持有的文件锁。
 * 在标签页关闭时调用（beforeunload）。
 */
export async function releaseAllLocks(): Promise<void> {
  if (!isExtension || typeof chrome === 'undefined' || !chrome.storage?.session) {
    return;
  }

  const currentTabId = await getCurrentTabId();
  if (currentTabId < 0) return;

  try {
    const all = await chrome.storage.session.get(null);
    const keysToRemove: string[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(FILE_LOCK_PREFIX)) {
        const record = value as FileLockRecord;
        if (record.tabId === currentTabId) {
          keysToRemove.push(key);
        }
      }
    }
    if (keysToRemove.length > 0) {
      await chrome.storage.session.remove(keysToRemove);
    }
  } catch {
    // 忽略
  }
}
