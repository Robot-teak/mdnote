/**
 * File System Access API 封装（N04a + N04b 合并）
 *
 * 为 Chrome MV3 插件版提供文件读写能力，替代 Tauri 的 Rust invoke。
 * 基于 W3C File System Access API（showOpenFilePicker / showSaveFilePicker /
 * showDirectoryPicker），Chrome 102+ 支持。
 *
 * 功能：
 * - openMarkdownFile()：打开 .md 文件，返回句柄+内容+文件名
 * - saveMarkdownFile()：保存到已有句柄或另存为新文件
 * - verifyPermission()：请求文件句柄读写权限（需用户手势上下文）
 * - serializeHandle() / deserializeHandle()：句柄序列化/反序列化（用于 IndexedDB 持久化）
 * - getDirectoryHandle()：获取目录句柄（N04b，用于读取同目录图片）
 * - readImageAsBlob()：从目录句柄读取图片为 Blob URL
 *
 * @module fileSystem
 */

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

/**
 * 打开文件返回的结果。
 */
export interface OpenFileResult {
  /** 文件句柄，可用于后续保存或权限验证 */
  handle: FileSystemFileHandle;
  /** 文件文本内容 */
  content: string;
  /** 文件名（不含路径） */
  name: string;
}

/**
 * 保存文件的返回结果。
 */
export interface SaveFileResult {
  /** 保存后文件句柄（已有句柄则原样返回，另存为则返回新句柄） */
  handle: FileSystemFileHandle;
  /** 文件名 */
  name: string;
}

/**
 * 文件元数据（用于最近文件列表）。
 */
export interface FileHandleMeta {
  /** 唯一标识（基于句柄名 + 时间戳） */
  id: string;
  /** 文件名 */
  name: string;
  /** 最后访问时间戳（ms） */
  lastAccessed: number;
  /** 文件大小（字节，可能为 0 表示未知） */
  size: number;
}

/**
 * 权限模式。
 */
export type PermissionMode = 'read' | 'readwrite';

/**
 * File System Access API 全局类型声明补充。
 * Chrome 102+ 支持，TypeScript lib.dom.d.ts 在较新版本中已包含。
 * 此处补充确保类型安全。
 */
declare global {
  interface Window {
    showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
    showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }

  interface OpenFilePickerOptions {
    types?: FilePickerAcceptType[];
    excludeAcceptAllOption?: boolean;
    multiple?: boolean;
  }

  interface SaveFilePickerOptions {
    suggestedName?: string;
    types?: FilePickerAcceptType[];
    excludeAcceptAllOption?: boolean;
  }

  interface DirectoryPickerOptions {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: FileSystemHandle | string;
  }

  interface FilePickerAcceptType {
    description?: string;
    accept: Record<string, string[]>;
  }

  interface FileSystemHandle {
    queryPermission?(descriptor?: { mode?: PermissionMode }): Promise<PermissionState>;
    requestPermission?(descriptor?: { mode?: PermissionMode }): Promise<PermissionState>;
  }

  interface FileSystemFileHandle {
    queryPermission?(descriptor?: { mode?: PermissionMode }): Promise<PermissionState>;
    requestPermission?(descriptor?: { mode?: PermissionMode }): Promise<PermissionState>;
  }

  interface FileSystemDirectoryHandle {
    queryPermission?(descriptor?: { mode?: PermissionMode }): Promise<PermissionState>;
    requestPermission?(descriptor?: { mode?: PermissionMode }): Promise<PermissionState>;
    values(): AsyncIterableIterator<FileSystemHandle>;
    getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
    removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
    keys(): AsyncIterableIterator<string>;
  }
}

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────

/** Markdown 文件接受类型 */
const MARKDOWN_ACCEPT_TYPES: Record<string, string[]> = {
  'text/markdown': ['.md', '.markdown', '.mdown', '.txt'],
  'text/plain': ['.md', '.markdown', '.txt'],
};

/** 图片文件接受类型（用于图片选择） */
const IMAGE_ACCEPT_TYPES: Record<string, string[]> = {
  'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'],
};

/** 默认文件名 */
const DEFAULT_FILENAME = 'untitled.md';

// ──────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────

/**
 * 检测当前环境是否支持 File System Access API。
 * Chrome 102+ 在安全上下文（https/extension）中支持。
 * @returns 是否支持
 */
export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.showOpenFilePicker === 'function' &&
    typeof window.showSaveFilePicker === 'function'
  );
}

/**
 * 检测当前环境是否支持目录选择器。
 * @returns 是否支持
 */
export function isDirectoryPickerSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/**
 * 生成唯一 ID（基于文件名 + 时间戳 + 随机数）。
 * @param name 文件名
 * @returns 唯一 ID
 */
/**
 * 生成稳定的文件 ID（确定性）。
 *
 * 注意：必须确定性——相同输入始终得到相同 ID。
 * 否则「打开文件」(useFileOps) 与「自动保存」(useAutoSave) 会各自生成不同的
 * 随机 ID，导致同一文件在「最近文件」里出现重复记录。
 * 以文件路径作为种子：同一文件每次打开都映射到同一条记录。
 *
 * @param path 文件路径（或文件名的稳定字符串）
 * @returns 确定性唯一 ID
 */
export function generateFileId(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) {
    h = (Math.imul(31, h) + path.charCodeAt(i)) | 0;
  }
  const hash = (h >>> 0).toString(36);
  const safeName = path.replace(/[^a-zA-Z0-9]/g, '_').slice(-24);
  return `f_${hash}_${safeName}`;
}

// ──────────────────────────────────────────────
// N04a：文件打开/保存/权限
// ──────────────────────────────────────────────

/**
 * 打开 Markdown 文件（showOpenFilePicker）。
 *
 * 弹出系统文件选择器，用户选择 .md 文件后读取文本内容。
 * 返回文件句柄，可用于后续直接保存（无需再次弹出对话框）。
 *
 * @returns 打开结果（句柄 + 内容 + 文件名），用户取消返回 null
 * @throws {Error} 浏览器不支持 File System Access API
 * @throws {Error} 用户拒绝授权
 */
export async function openMarkdownFile(): Promise<OpenFileResult | null> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API is not supported in this browser. Requires Chrome 102+.');
  }

  let handles: FileSystemFileHandle[];
  try {
    handles = await window.showOpenFilePicker!({
      types: [
        {
          description: 'Markdown files',
          accept: MARKDOWN_ACCEPT_TYPES,
        },
      ],
      multiple: false,
      excludeAcceptAllOption: false,
    });
  } catch (err) {
    // 用户取消选择（AbortError）
    if (err instanceof DOMException && err.name === 'AbortError') {
      return null;
    }
    throw err;
  }

  const handle = handles[0];
  if (!handle) return null;

  const file = await handle.getFile();
  const content = await file.text();

  return {
    handle,
    content,
    name: file.name,
  };
}

/**
 * 保存 Markdown 文件。
 *
 * - 有句柄（handle 不为 null）：直接 createWritable 写回原文件
 * - 无句柄（handle 为 null）：弹出 showSaveFilePicker 另存为新文件
 *
 * @param content 文件文本内容
 * @param handle 已有文件句柄（可选，null 则另存为）
 * @param suggestedName 另存为时的建议文件名（可选）
 * @returns 保存结果（句柄 + 文件名）
 * @throws {Error} 浏览器不支持 File System Access API
 * @throws {Error} 写入失败
 */
export async function saveMarkdownFile(
  content: string,
  handle?: FileSystemFileHandle | null,
  suggestedName?: string,
): Promise<SaveFileResult> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API is not supported in this browser. Requires Chrome 102+.');
  }

  // 有句柄 → 直接写回
  if (handle) {
    // 验证写权限
    const hasPermission = await verifyPermission(handle, 'readwrite');
    if (!hasPermission) {
      throw new Error('Write permission denied for this file handle. Please re-authorize.');
    }

    const writable = await handle.createWritable();
    try {
      await writable.write(content);
    } finally {
      await writable.close();
    }

    return { handle, name: handle.name };
  }

  // 无句柄 → 另存为
  const name = suggestedName || DEFAULT_FILENAME;
  let newHandle: FileSystemFileHandle;
  try {
    newHandle = await window.showSaveFilePicker!({
      suggestedName: name,
      types: [
        {
          description: 'Markdown files',
          accept: MARKDOWN_ACCEPT_TYPES,
        },
      ],
      excludeAcceptAllOption: false,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new DOMException('Save cancelled by user', 'AbortError');
    }
    throw err;
  }

  const writable = await newHandle.createWritable();
  try {
    await writable.write(content);
  } finally {
    await writable.close();
  }

  return { handle: newHandle, name: newHandle.name };
}

/**
 * 验证并请求文件句柄权限。
 *
 * 先查询当前权限，若不足则请求授权。
 * **注意**：requestPermission 必须在用户手势上下文中调用
 * （如点击事件回调内），否则会被浏览器拒绝。
 *
 * @param handle 文件或目录句柄
 * @param mode 需要的权限模式
 * @returns 是否已获得所需权限
 */
export async function verifyPermission(
  handle: FileSystemHandle,
  mode: PermissionMode,
): Promise<boolean> {
  // 兼容性检查：部分浏览器 queryPermission/requestPermission 可能不存在
  if (!handle.queryPermission || !handle.requestPermission) {
    // 无法查询权限时，假设有权限（createWritable/getFile 会抛出实际错误）
    return true;
  }

  // 先查询当前权限
  const currentPerm = await handle.queryPermission({ mode });
  if (currentPerm === 'granted') {
    return true;
  }

  // 权限不足，请求授权（需用户手势上下文）
  const requestedPerm = await handle.requestPermission({ mode });
  return requestedPerm === 'granted';
}

/**
 * 检查句柄是否有指定权限（仅查询，不请求）。
 * @param handle 文件或目录句柄
 * @param mode 权限模式
 * @returns 当前权限状态
 */
export async function checkPermission(
  handle: FileSystemHandle,
  mode: PermissionMode,
): Promise<PermissionState> {
  if (!handle.queryPermission) {
    return 'granted'; // 无法查询时假设有权限
  }
  return handle.queryPermission({ mode });
}

// ──────────────────────────────────────────────
// 句柄序列化/反序列化
// ──────────────────────────────────────────────

/**
 * 序列化文件句柄为可存储格式。
 *
 * FileSystemFileHandle 是结构化克隆对象，不能 JSON.stringify，
 * 但可以通过 IndexedDB 的结构化克隆算法直接存储。
 * 此函数用于需要传输句柄的场景（如 postMessage），返回原始句柄供
 * 结构化克隆使用。
 *
 * 注意：句柄不可跨 origin 传输，仅在同一扩展内有效。
 *
 * @param handle 文件句柄
 * @returns 句柄引用（供结构化克隆存储）
 */
export function serializeHandle(handle: FileSystemFileHandle): FileSystemFileHandle {
  // FileSystemFileHandle 本身就是结构化克隆兼容的
  // IndexedDB 直接存储即可，无需额外序列化
  return handle;
}

/**
 * 反序列化文件句柄。
 *
 * 从 IndexedDB 取出的句柄直接即可使用，此函数仅为 API 对称性提供。
 *
 * @param handle 存储的文件句柄
 * @returns 文件句柄
 */
export function deserializeHandle(handle: FileSystemFileHandle): FileSystemFileHandle {
  return handle;
}

/**
 * 判断两个文件句柄是否指向同一文件。
 * 使用 isSameEntry API 比较。
 * @param a 句柄 A
 * @param b 句柄 B
 * @returns 是否同一文件
 */
export async function isSameFile(
  a: FileSystemHandle,
  b: FileSystemHandle,
): Promise<boolean> {
  if (!a.isSameEntry || !b.isSameEntry) return false;
  try {
    return await a.isSameEntry(b);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────
// N04b：目录句柄获取与图片读取
// ──────────────────────────────────────────────

/**
 * 获取目录句柄（showDirectoryPicker）。
 *
 * 用于读取 Markdown 文件同目录下的图片资源。
 * 用户选择目录后返回句柄，可持久化到 IndexedDB 供后续使用。
 *
 * @param startIn 起始目录（可选，句柄或已知目录名如 'documents'）
 * @returns 目录句柄，用户取消返回 null
 * @throws {Error} 浏览器不支持目录选择器
 */
export async function getDirectoryHandle(
  startIn?: FileSystemHandle | string,
): Promise<FileSystemDirectoryHandle | null> {
  if (!isDirectoryPickerSupported()) {
    throw new Error('Directory picker is not supported. Requires Chrome 102+.');
  }

  let dirHandle: FileSystemDirectoryHandle;
  try {
    dirHandle = await window.showDirectoryPicker!({
      mode: 'read',
      startIn,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return null;
    }
    throw err;
  }

  return dirHandle;
}

/**
 * 验证目录句柄权限。
 * @param dirHandle 目录句柄
 * @param mode 权限模式
 * @returns 是否已获得权限
 */
export async function verifyDirectoryPermission(
  dirHandle: FileSystemDirectoryHandle,
  mode: PermissionMode,
): Promise<boolean> {
  return verifyPermission(dirHandle, mode);
}

/**
 * 从目录句柄中读取图片为 Blob URL。
 *
 * 支持：
 * - 相对路径（如 "images/photo.png"、"./images/photo.png"）
 * - 嵌套子目录（递归遍历）
 * - 文件名直接匹配
 *
 * @param dirHandle 目录句柄
 * @param relPath 相对路径（如 "images/photo.png" 或 "photo.png"）
 * @returns Blob URL（调用方负责 revokeObjectURL 释放），文件不存在返回 null
 * @throws {Error} 权限不足
 */
export async function readImageAsBlob(
  dirHandle: FileSystemDirectoryHandle,
  relPath: string,
): Promise<string | null> {
  // 验证读权限
  const hasPermission = await verifyDirectoryPermission(dirHandle, 'read');
  if (!hasPermission) {
    throw new Error('Read permission denied for directory handle.');
  }

  // 规范化路径：移除前导 ./ 和 /
  const normalizedPath = relPath.replace(/^\.?\//, '').trim();
  if (!normalizedPath) return null;

  // 按目录层级拆分
  const parts = normalizedPath.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  const fileName = parts[parts.length - 1];

  try {
    // 递归进入子目录
    let currentDir = dirHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      currentDir = await currentDir.getDirectoryHandle(parts[i], { create: false });
    }

    // 获取文件句柄并读取
    const fileHandle = await currentDir.getFileHandle(fileName, { create: false });
    const file = await fileHandle.getFile();
    const blob = new Blob([file], { type: file.type || 'image/*' });
    return URL.createObjectURL(blob);
  } catch (err) {
    // 文件不存在（NotFoundError）或其他错误
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      return null;
    }
    // 类型不匹配（不是文件而是目录等）
    if (err instanceof DOMException && err.name === 'TypeMismatchError') {
      return null;
    }
    throw err;
  }
}

/**
 * 打开图片文件选择器（用于编辑器插入图片）。
 * @returns 图片 Blob URL + 文件名，用户取消返回 null
 */
export async function openImageFile(): Promise<{ url: string; name: string } | null> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API is not supported. Requires Chrome 102+.');
  }

  let handles: FileSystemFileHandle[];
  try {
    handles = await window.showOpenFilePicker!({
      types: [
        {
          description: 'Image files',
          accept: IMAGE_ACCEPT_TYPES,
        },
      ],
      multiple: false,
      excludeAcceptAllOption: false,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return null;
    }
    throw err;
  }

  const handle = handles[0];
  if (!handle) return null;

  const file = await handle.getFile();
  const blob = new Blob([file], { type: file.type || 'image/*' });
  const url = URL.createObjectURL(blob);

  return { url, name: file.name };
}

/**
 * 列出目录中的所有文件句柄（用于最近文件等场景）。
 * @param dirHandle 目录句柄
 * @returns 文件名→文件句柄的映射数组
 */
export async function listDirectoryFiles(
  dirHandle: FileSystemDirectoryHandle,
): Promise<{ name: string; handle: FileSystemFileHandle }[]> {
  const hasPermission = await verifyDirectoryPermission(dirHandle, 'read');
  if (!hasPermission) {
    throw new Error('Read permission denied for directory handle.');
  }

  const results: { name: string; handle: FileSystemFileHandle }[] = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      results.push({ name: entry.name, handle: entry as FileSystemFileHandle });
    }
  }
  return results;
}

/**
 * 释放 Blob URL 资源。
 * @param url Blob URL
 */
export function revokeBlobUrl(url: string): void {
  if (url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

// ──────────────────────────────────────────────
// 目录授权直写（v0.1.8：目录内文件保存免弹窗写回原文件）
// ──────────────────────────────────────────────

/**
 * 授权文件所在目录并缓存（保存/自动保存时免弹窗直接写回原文件）。
 * 插件版专用；桌面版无此 API，返回 null。
 * @returns 授权后的目录句柄，取消/失败返回 null
 */
export async function authorizeDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!isDirectoryPickerSupported()) return null;
  try {
    const dirHandle = await window.showDirectoryPicker!({ mode: 'readwrite' });
    const ok = await verifyDirectoryPermission(dirHandle, 'readwrite');
    if (!ok) return null;
    const { saveDirHandle } = await import('./indexeddb');
    await saveDirHandle(dirHandle);
    return dirHandle;
  } catch {
    return null; // 用户取消
  }
}

/**
 * 用已授权目录按文件名写回文件（免弹窗直写原文件）。
 * @param fileName 目标文件名
 * @param content 内容
 * @returns 是否写回成功（未授权目录/找不到文件/失败返回 false）
 */
export async function tryWriteFileViaDir(fileName: string, content: string): Promise<boolean> {
  if (!fileName || !isFileSystemAccessSupported()) return false;
  try {
    const { getDirHandle } = await import('./indexeddb');
    const rec = await getDirHandle();
    if (!rec) return false;
    const ok = await verifyDirectoryPermission(rec.handle, 'readwrite');
    if (!ok) return false;
    const fileHandle = await rec.handle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(content);
    } finally {
      await writable.close();
    }
    return true;
  } catch (err) {
    console.warn('[MDnote] tryWriteFileViaDir failed:', err);
    return false;
  }
}

/**
 * 用已授权目录按文件名获取文件句柄（浏览器打开的 file:// 文件，目录已授权时绑定句柄）。
 * @param fileName 目标文件名
 * @returns 文件句柄，未授权/不存在返回 null
 */
export async function getFileHandleViaDir(fileName: string): Promise<FileSystemFileHandle | null> {
  if (!fileName || !isFileSystemAccessSupported()) return null;
  try {
    const { getDirHandle } = await import('./indexeddb');
    const rec = await getDirHandle();
    if (!rec) return null;
    const ok = await verifyDirectoryPermission(rec.handle, 'readwrite');
    if (!ok) return null;
    return await rec.handle.getFileHandle(fileName, { create: false });
  } catch {
    return null;
  }
}
