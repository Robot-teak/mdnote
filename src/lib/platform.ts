/**
 * Platform 抽象层 — 双产物线核心（P1-2）
 *
 * 根据 `import.meta.env.MODE === 'extension'` 切换后端：
 * - 桌面版（MODE='production'/'development'）：走 Tauri invoke（保留现有逻辑）
 * - 插件版（MODE='extension'）：走 File System Access API / navigator.clipboard / Blob URL
 *
 * M01-M04 调用 platform.ts 而非直接 Tauri invoke，桌面版逻辑不破坏。
 *
 * @module platform
 */

import {
  openMarkdownFile,
  saveMarkdownFile,
  verifyPermission,
  generateFileId,
} from './fileSystem';

// v0.1.8：目录授权直写（目录内文件保存免弹窗写回原文件）
export { authorizeDirectory, tryWriteFileViaDir, getFileHandleViaDir, pickOriginalFileHandle } from './fileSystem';

// ──────────────────────────────────────────────
// 常量与类型
// ──────────────────────────────────────────────

/** 当前是否为插件模式 */
export const isExtension: boolean = import.meta.env.MODE === 'extension';

/** 当前是否为桌面模式 */
export const isDesktop: boolean = !isExtension;

/** 打开文件结果（统一接口） */
export interface PlatformOpenFileResult {
  /** 文件内容 */
  content: string;
  /** 文件名 */
  name: string;
  /** 文件路径（桌面版有，插件版用 name 替代） */
  path: string;
  /** 文件句柄（仅插件版有，桌面版为 null） */
  handle: unknown;
}

/** 保存文件选项 */
export interface PlatformSaveOptions {
  /** 建议文件名 */
  suggestedName?: string;
  /** 已有文件路径（桌面版）或句柄（插件版） */
  path?: string | null;
  handle?: unknown;
}

// ──────────────────────────────────────────────
// 文件 I/O
// ──────────────────────────────────────────────

/**
 * 读取文件内容。
 *
 * - 桌面版：invoke('read_file', { path })
 * - 插件版：从 FileSystemFileHandle 读取（handle 必须提供）
 *
 * @param pathOrHandle 文件路径（桌面版）或文件句柄（插件版）
 * @returns 文件内容
 */
export async function readFile(pathOrHandle: string | unknown): Promise<string> {
  if (isExtension) {
    const handle = pathOrHandle as FileSystemFileHandle;
    const file = await handle.getFile();
    return file.text();
  }

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('read_file', { path: pathOrHandle as string });
}

/**
 * 写入文件内容。
 *
 * - 桌面版：invoke('write_file', { path, content })
 * - 插件版：用 FileSystemFileHandle.createWritable 写回
 *
 * @param pathOrHandle 文件路径（桌面版）或文件句柄（插件版）
 * @param content 文件内容
 */
export async function writeFile(
  pathOrHandle: string | unknown,
  content: string,
): Promise<void> {
  if (isExtension) {
    const handle = pathOrHandle as FileSystemFileHandle;
    const writable = await handle.createWritable();
    try {
      await writable.write(content);
    } finally {
      await writable.close();
    }
    return;
  }

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('write_file', { path: pathOrHandle as string, content });
}

/**
 * 打开文件选择对话框。
 *
 * - 桌面版：invoke('open_dialog') 返回文件路径
 * - 插件版：showOpenFilePicker 返回句柄 + 内容
 *
 * @returns 打开结果（path/handle/content/name），用户取消返回 null
 */
export async function openDialog(): Promise<PlatformOpenFileResult | null> {
  if (isExtension) {
    const result = await openMarkdownFile();
    if (!result) return null;
    return {
      content: result.content,
      name: result.name,
      path: result.name, // 插件版无绝对路径，用文件名替代
      handle: result.handle,
    };
  }

  const { invoke } = await import('@tauri-apps/api/core');
  const path = await invoke<string | null>('open_dialog');
  if (!path) return null;
  const content = await invoke<string>('read_file', { path });
  const name = path.split('/').pop() || path.split('\\').pop() || 'Untitled';
  return { content, name, path, handle: null };
}

/**
 * 保存文件对话框（另存为）。
 *
 * - 桌面版：invoke('save_dialog') + invoke('write_file')
 * - 插件版：showSaveFilePicker + createWritable
 *
 * @param content 文件内容
 * @param options 保存选项
 * @returns 保存结果（path/name/handle）
 */
export async function saveDialog(
  content: string,
  options?: PlatformSaveOptions,
): Promise<{ path: string; name: string; handle: unknown } | null> {
  const suggestedName = options?.suggestedName || 'untitled.md';

  if (isExtension) {
    const result = await saveMarkdownFile(content, null, suggestedName);
    return { path: result.name, name: result.name, handle: result.handle };
  }

  const { invoke } = await import('@tauri-apps/api/core');
  const path = await invoke<string | null>('save_dialog', { defaultName: suggestedName });
  if (!path) return null;
  await invoke('write_file', { path, content });
  const name = path.split('/').pop() || path.split('\\').pop() || 'Untitled';
  return { path, name, handle: null };
}

/**
 * 验证文件句柄权限（仅插件版有效）。
 * 桌面版始终返回 true。
 *
 * @param handle 文件句柄
 * @param mode 权限模式
 * @returns 是否有权限
 */
export async function checkFilePermission(
  handle: unknown,
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<boolean> {
  if (isExtension && handle) {
    return verifyPermission(handle as FileSystemHandle, mode);
  }
  return true;
}

// ──────────────────────────────────────────────
// 剪贴板
// ──────────────────────────────────────────────

/**
 * 读取剪贴板文本。
 *
 * - 桌面版：invoke('read_clipboard')
 * - 插件版：navigator.clipboard.readText()
 */
export async function readClipboard(): Promise<string> {
  if (isExtension) {
    return navigator.clipboard.readText();
  }

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('read_clipboard');
}

/**
 * 写入剪贴板文本。
 *
 * - 桌面版：invoke('write_clipboard', { text })
 * - 插件版：navigator.clipboard.writeText()
 */
export async function writeClipboard(text: string): Promise<void> {
  if (isExtension) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('write_clipboard', { text });
}

// ──────────────────────────────────────────────
// URL 打开
// ──────────────────────────────────────────────

/**
 * 在系统默认浏览器中打开 URL（M14）。
 *
 * - 桌面版：invoke('open_url', { url })
 * - 插件版：window.open(url, '_blank')
 */
export async function openUrl(url: string): Promise<void> {
  if (isExtension) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_url', { url });
}

// ──────────────────────────────────────────────
// 文件资源 URL 转换
// ──────────────────────────────────────────────

/** 资源 URL 缓存（避免重复转换） */
const assetUrlCache = new Map<string, string>();

/**
 * 将本地文件路径转换为可加载的资源 URL（M04 图片处理）。
 *
 * - 桌面版：Tauri convertFileSrc（asset:// 协议）
 * - 插件版：远程图片保留原 URL；本地图片返回空字符串（需通过目录句柄 readImageAsBlob 处理）
 *
 * @param absolutePath 文件绝对路径
 * @returns 可加载的 URL，或空字符串（插件版本地图片无法直接加载）
 */
export function convertFileSrc(absolutePath: string): string {
  // 远程 URL 直接返回
  if (
    absolutePath.startsWith('http://') ||
    absolutePath.startsWith('https://') ||
    absolutePath.startsWith('data:') ||
    absolutePath.startsWith('blob:')
  ) {
    return absolutePath;
  }

  // 检查缓存
  const cached = assetUrlCache.get(absolutePath);
  if (cached) return cached;

  let result: string;

  if (isExtension) {
    // 插件版：本地文件无法直接通过路径加载，需通过目录句柄 readImageAsBlob
    // 返回空字符串，PreviewPane 会显示占位提示
    result = '';
  } else {
    // 桌面版：使用 Tauri convertFileSrc
    try {
      const tauri = (window as unknown as { __TAURI__?: { core?: { convertFileSrc?: (p: string) => string } } }).__TAURI__;
      if (tauri?.core?.convertFileSrc) {
        result = tauri.core.convertFileSrc(absolutePath);
      } else {
        // Fallback: asset 协议
        result = `https://asset.localhost/${absolutePath.replace(/^\//, '')}`;
      }
    } catch {
      result = `https://asset.localhost/${absolutePath.replace(/^\//, '')}`;
    }
  }

  // 只缓存非空结果
  if (result) {
    assetUrlCache.set(absolutePath, result);
  }
  return result;
}

/**
 * 清除资源 URL 缓存（主要用于测试）。
 */
export function clearAssetUrlCache(): void {
  assetUrlCache.clear();
}

// ──────────────────────────────────────────────
// 窗口标题
// ──────────────────────────────────────────────

/**
 * 设置窗口/标签页标题（R05）。
 *
 * - 桌面版：invoke('set_window_title', { title })
 * - 插件版：document.title = title
 */
export async function setWindowTitle(title: string): Promise<void> {
  if (isExtension) {
    document.title = title;
    return;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_window_title', { title });
  } catch {
    // 降级：设置 document.title
    document.title = title;
  }
}

// ──────────────────────────────────────────────
// 事件监听（文件打开 / About 菜单）
// ──────────────────────────────────────────────

/**
 * 注册文件打开监听器。
 *
 * - 桌面版：Tauri event listen('open-file-path') + get_pending_file 轮询 + tauri://file-drop
 * - 插件版：chrome.runtime.onMessage 监听 'open-file' 消息 + window dragover/drop
 *
 * @param onOpenFile 文件打开回调（接收文件路径或内容）
 * @returns 清理函数
 */
export async function setupFileOpenListener(
  onOpenFile: (pathOrContent: string, isContent: boolean) => void,
): Promise<() => void> {
  const cleanups: Array<() => void> = [];

  if (isExtension) {
    // 插件版：chrome.runtime.onMessage
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      const handler = (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          (message as { type: string }).type === 'open-file'
        ) {
          const payload = (message as { payload?: { content?: string; path?: string } }).payload;
          if (payload?.content) {
            onOpenFile(payload.content, true);
          } else if (payload?.path) {
            onOpenFile(payload.path, false);
          }
        }
      };
      chrome.runtime.onMessage.addListener(handler);
      cleanups.push(() => chrome.runtime.onMessage.removeListener(handler));
    }

    // 插件版：HTML5 拖拽（M15）
    const dragOverHandler = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const dropHandler = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const file = files[0];
        const ext = file.name.split('.').pop()?.toLowerCase();
        if (ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === 'mkd') {
          const reader = new FileReader();
          reader.onload = () => {
            onOpenFile(reader.result as string, true);
          };
          reader.readAsText(file);
        }
      }
    };
    window.addEventListener('dragover', dragOverHandler);
    window.addEventListener('drop', dropHandler);
    cleanups.push(() => {
      window.removeEventListener('dragover', dragOverHandler);
      window.removeEventListener('drop', dropHandler);
    });

    return () => cleanups.forEach((fn) => fn());
  }

  // 桌面版：Tauri event listen
  try {
    const { invoke } = await import('@tauri-apps/api/core');

    // 1. pending file
    const pendingFile = await invoke<string | null>('get_pending_file').catch(() => null);
    if (pendingFile) {
      onOpenFile(pendingFile, false);
    }

    // 2. event listen
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten1 = await listen<string>('open-file-path', (event) => {
      if (event.payload) {
        invoke('get_pending_file').catch(() => {});
        onOpenFile(event.payload, false);
      }
    });
    cleanups.push(unlisten1);

    // 3. file drop
    const unlisten2 = await listen<string[]>('tauri://file-drop', (event) => {
      const files = event.payload;
      if (files && files.length > 0) {
        const file = files[0];
        if (file.endsWith('.md') || file.endsWith('.markdown') || file.endsWith('.txt') || file.endsWith('.mkd')) {
          onOpenFile(file, false);
        }
      }
    });
    cleanups.push(unlisten2);
  } catch {
    // Tauri 不可用时降级
  }

  return () => cleanups.forEach((fn) => fn());
}

/**
 * 注册 About 对话框事件监听。
 *
 * - 桌面版：Tauri event listen('show-about-dialog')
 * - 插件版：无原生菜单，通过 chrome.runtime.onMessage 'show-about' 触发
 *
 * @param onShowAbout 显示 About 对话框回调
 * @returns 清理函数
 */
export async function setupAboutListener(
  onShowAbout: () => void,
): Promise<() => void> {
  if (isExtension) {
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      const handler = (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          (message as { type: string }).type === 'show-about'
        ) {
          onShowAbout();
        }
      };
      chrome.runtime.onMessage.addListener(handler);
      return () => chrome.runtime.onMessage.removeListener(handler);
    }
    return () => {};
  }

  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen('show-about-dialog', () => {
      onShowAbout();
    });
    return unlisten;
  } catch {
    return () => {};
  }
}

// ──────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────

/**
 * 生成文件 ID（统一接口）。
 */
export { generateFileId };
