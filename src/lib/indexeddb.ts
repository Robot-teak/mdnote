/**
 * IndexedDB 封装（N07）— 草稿/句柄/目录句柄持久化
 *
 * 为 Chrome MV3 插件版提供本地数据持久化，替代 Tauri 的文件系统存储。
 * 基于 IndexedDB 结构化克隆算法，支持直接存储 FileSystemFileHandle。
 *
 * 数据结构：
 * - drafts store：文档草稿自动保存（id, content, meta, schema_version, updatedAt）
 * - handles store：文件句柄持久化（id, handle, meta, schema_version, savedAt）
 * - recent store：**已废弃**（R5 已删除最近文件列表的全部读写，仅保留 object store
 *   定义以维持 DB_VERSION=2，避免改动老用户本地数据库；见决策 D9）
 * - dirs store：已授权目录句柄（id, handle, name, savedAt）
 *
 * 版本管理：schema_version 字段供后续 migration（O28）使用。
 *
 * @module indexeddb
 */

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

/**
 * 数据库配置常量。
 */
export const DB_NAME = 'mdnote-ext';
export const DB_VERSION = 2;

/** Store 名称 */
export const STORE_DRAFTS = 'drafts';
export const STORE_HANDLES = 'handles';
/**
 * 最近文件 store —— **已废弃**（R5）。
 *
 * 最近文件列表功能已于 v0.3.0（插件版）整体移除：所有 CRUD 与调用点已删除，
 * 本常量与下方 `onupgradeneeded` 中的建表逻辑**故意保留**，使数据库结构维持
 * v2 不变 —— 升版本会改动已有用户的本地数据库，风险大于收益（决策 D9）。
 * 请勿新增对本 store 的读写。
 */
export const STORE_RECENT = 'recent';
export const STORE_DIRS = 'dirs';

/** 当前 schema 版本号 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * 草稿记录结构。
 */
export interface DraftRecord {
  /** 唯一标识（generateFileId 生成） */
  id: string;
  /** 文档内容（Markdown 文本） */
  content: string;
  /** 文件元数据 */
  meta: DraftMeta;
  /** Schema 版本号 */
  schema_version: number;
  /** 最后更新时间戳（ms） */
  updatedAt: number;
  /** 内容长度（冗余字段，便于列表展示） */
  contentLength: number;
}

/**
 * 草稿元数据。
 */
export interface DraftMeta {
  /** 文件名 */
  name: string;
  /** 是否有对应磁盘文件句柄 */
  hasHandle: boolean;
  /** 原始文件路径（桌面版兼容，插件版可能为空） */
  filePath?: string;
}

/**
 * 句柄记录结构。
 */
export interface HandleRecord {
  /** 唯一标识（与 draft id 关联） */
  id: string;
  /** 文件句柄（结构化克隆存储） */
  handle: FileSystemFileHandle;
  /** 文件名 */
  name: string;
  /** Schema 版本号 */
  schema_version: number;
  /** 保存时间戳（ms） */
  savedAt: number;
}

// ──────────────────────────────────────────────
// 数据库初始化
// ──────────────────────────────────────────────

/** 数据库实例缓存 */
let dbInstance: IDBDatabase | null = null;

/**
 * 打开/初始化 IndexedDB 数据库。
 *
 * 创建四个 object store：drafts / handles / recent / dirs，
 * 每个以 'id' 为主键。handles store 依赖结构化克隆算法存储 FileSystemFileHandle。
 * 其中 recent store 自 R5 起已废弃（仅保留建表，见 STORE_RECENT 注释）。
 *
 * @returns Promise<IDBDatabase>
 * @throws {Error} IndexedDB 不可用
 */
export function openDB(): Promise<IDBDatabase> {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this environment.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error(`Failed to open IndexedDB: ${request.error?.message || 'unknown error'}`));
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      // 连接意外关闭时重置缓存
      dbInstance.onclose = () => {
        dbInstance = null;
      };
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
      };
      resolve(dbInstance);
    };

    request.onupgradeneeded = (_event) => {
      const db = request.result;

      // drafts store：文档草稿
      if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
        const draftsStore = db.createObjectStore(STORE_DRAFTS, { keyPath: 'id' });
        draftsStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        draftsStore.createIndex('name', 'meta.name', { unique: false });
      }

      // handles store：文件句柄
      if (!db.objectStoreNames.contains(STORE_HANDLES)) {
        const handlesStore = db.createObjectStore(STORE_HANDLES, { keyPath: 'id' });
        handlesStore.createIndex('name', 'name', { unique: false });
        handlesStore.createIndex('savedAt', 'savedAt', { unique: false });
      }

      // recent store（**已废弃**，见 STORE_RECENT 的说明）：
      // 保留建表逻辑以维持 DB_VERSION=2；R5 之后无任何代码读写该 store。
      if (!db.objectStoreNames.contains(STORE_RECENT)) {
        const recentStore = db.createObjectStore(STORE_RECENT, { keyPath: 'id' });
        recentStore.createIndex('lastAccessed', 'lastAccessed', { unique: false });
      }

      // dirs store：已授权目录句柄（目录内文件保存免弹窗直写原文件，v0.1.8）
      if (!db.objectStoreNames.contains(STORE_DIRS)) {
        db.createObjectStore(STORE_DIRS, { keyPath: 'id' });
      }
    };
  });
}

/**
 * 关闭数据库连接（主要用于测试清理）。
 */
export function closeDB(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * 获取事务中的指定 store。
 * @param db 数据库实例
 * @param storeName store 名称
 * @param mode 事务模式
 * @returns IDBObjectStore
 */
function getStore(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
): IDBObjectStore {
  const tx = db.transaction(storeName, mode);
  return tx.objectStore(storeName);
}

/**
 * 将 IDBRequest 封装为 Promise。
 * @param request IDBRequest
 * @returns Promise<T>
 */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 等待事务完成。
 * @param store object store（从中获取事务）
 * @returns Promise<void>
 */
function waitForTransaction(store: IDBObjectStore): Promise<void> {
  return new Promise((resolve, reject) => {
    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error);
    store.transaction.onabort = () => reject(store.transaction.error);
  });
}

// ──────────────────────────────────────────────
// 草稿 CRUD（drafts store）
// ──────────────────────────────────────────────

/**
 * 保存文档草稿到 IndexedDB。
 *
 * @param id 草稿唯一标识
 * @param content 文档内容
 * @param meta 文件元数据
 * @returns 保存后的记录
 * @throws {Error} 保存失败（如配额超限 QuotaExceededError）
 */
export async function saveDraft(
  id: string,
  content: string,
  meta: DraftMeta,
): Promise<DraftRecord> {
  const db = await openDB();
  const store = getStore(db, STORE_DRAFTS, 'readwrite');

  const record: DraftRecord = {
    id,
    content,
    meta,
    schema_version: CURRENT_SCHEMA_VERSION,
    updatedAt: Date.now(),
    contentLength: content.length,
  };

  store.put(record);
  await waitForTransaction(store);
  return record;
}

/**
 * 获取指定草稿。
 * @param id 草稿 ID
 * @returns 草稿记录，不存在返回 null
 */
export async function getDraft(id: string): Promise<DraftRecord | null> {
  const db = await openDB();
  const store = getStore(db, STORE_DRAFTS, 'readonly');
  const result = await requestToPromise(store.get(id));
  return result ?? null;
}

/**
 * 列出所有草稿（按更新时间降序排列）。
 * @returns 草稿记录数组
 */
export async function listDrafts(): Promise<DraftRecord[]> {
  const db = await openDB();
  const store = getStore(db, STORE_DRAFTS, 'readonly');

  return new Promise((resolve, reject) => {
    const results: DraftRecord[] = [];
    const cursorRequest = store.index('updatedAt').openCursor(null, 'prev');

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        results.push(cursor.value as DraftRecord);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });
}

/**
 * 删除指定草稿。
 * @param id 草稿 ID
 */
export async function deleteDraft(id: string): Promise<void> {
  const db = await openDB();
  const store = getStore(db, STORE_DRAFTS, 'readwrite');
  store.delete(id);
  await waitForTransaction(store);
}

/**
 * 清空所有草稿（谨慎使用，主要用于测试和重置）。
 */
export async function clearAllDrafts(): Promise<void> {
  const db = await openDB();
  const store = getStore(db, STORE_DRAFTS, 'readwrite');
  store.clear();
  await waitForTransaction(store);
}

// ──────────────────────────────────────────────
// 句柄 CRUD（handles store）
// ──────────────────────────────────────────────

/**
 * 保存文件句柄到 IndexedDB。
 *
 * 利用 IndexedDB 结构化克隆算法直接存储 FileSystemFileHandle。
 * 句柄在重启后仍可恢复（但权限可能需要重新授权，参见 verifyPermission）。
 *
 * @param id 句柄唯一标识（与草稿 ID 关联）
 * @param handle 文件句柄
 * @param name 文件名
 * @returns 保存后的记录
 * @throws {Error} 存储失败（句柄不支持结构化克隆时抛 DataCloneError）
 */
export async function saveHandle(
  id: string,
  handle: FileSystemFileHandle,
  name: string,
): Promise<HandleRecord> {
  const db = await openDB();
  const store = getStore(db, STORE_HANDLES, 'readwrite');

  const record: HandleRecord = {
    id,
    handle,
    name,
    schema_version: CURRENT_SCHEMA_VERSION,
    savedAt: Date.now(),
  };

  store.put(record);
  await waitForTransaction(store);
  return record;
}

/**
 * 获取文件句柄。
 * @param id 句柄 ID
 * @returns 句柄记录，不存在返回 null
 */
export async function getHandle(id: string): Promise<HandleRecord | null> {
  const db = await openDB();
  const store = getStore(db, STORE_HANDLES, 'readonly');
  const result = await requestToPromise(store.get(id));
  return result ?? null;
}

/**
 * 删除文件句柄。
 * @param id 句柄 ID
 */
export async function deleteHandle(id: string): Promise<void> {
  const db = await openDB();
  const store = getStore(db, STORE_HANDLES, 'readwrite');
  store.delete(id);
  await waitForTransaction(store);
}

/**
 * 清空所有句柄。
 */
export async function clearAllHandles(): Promise<void> {
  const db = await openDB();
  const store = getStore(db, STORE_HANDLES, 'readwrite');
  store.clear();
  await waitForTransaction(store);
}

// ──────────────────────────────────────────────
// 数据迁移支持（O28）
// ──────────────────────────────────────────────

/**
 * 获取数据库 schema 版本信息。
 * 检查所有 store 中的记录 schema_version，返回最低版本。
 * @returns 当前数据最低 schema 版本（无数据返回 CURRENT_SCHEMA_VERSION）
 */
export async function getDataSchemaVersion(): Promise<number> {
  const db = await openDB();
  const draftsStore = getStore(db, STORE_DRAFTS, 'readonly');
  const draftVersion = await requestToPromise(draftsStore.count());

  if (draftVersion === 0) {
    return CURRENT_SCHEMA_VERSION;
  }

  // 取第一条记录的 schema_version 作为参考
  return new Promise((resolve, reject) => {
    const cursorRequest = draftsStore.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        const record = cursor.value as DraftRecord;
        resolve(record.schema_version ?? 1);
      } else {
        resolve(CURRENT_SCHEMA_VERSION);
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });
}

/**
 * 检查是否需要数据迁移。
 * @returns 是否需要迁移（当前数据版本 < CURRENT_SCHEMA_VERSION）
 */
export async function needsMigration(): Promise<boolean> {
  const dataVersion = await getDataSchemaVersion();
  return dataVersion < CURRENT_SCHEMA_VERSION;
}

// ──────────────────────────────────────────────
// 已授权目录句柄 CRUD（dirs store，v0.1.8）
// ──────────────────────────────────────────────

/** 目录句柄记录 */
export interface DirRecord {
  /** 唯一标识（固定 'default'，单目录授权） */
  id: string;
  /** 目录句柄（结构化克隆存储） */
  handle: FileSystemDirectoryHandle;
  /** 目录名 */
  name: string;
  /** 授权时间戳 */
  savedAt: number;
}

/** 目录句柄存储键 */
export const DIR_KEY = 'default';

/**
 * 保存已授权目录句柄（保存目录内文件时免弹窗直写原文件）。
 * @param handle 目录句柄
 * @returns 保存后的记录
 */
export async function saveDirHandle(handle: FileSystemDirectoryHandle): Promise<DirRecord> {
  const db = await openDB();
  const store = getStore(db, STORE_DIRS, 'readwrite');
  const record: DirRecord = {
    id: DIR_KEY,
    handle,
    name: handle.name,
    savedAt: Date.now(),
  };
  store.put(record);
  await waitForTransaction(store);
  return record;
}

/**
 * 获取已授权目录句柄。
 * @returns 目录记录，不存在返回 null
 */
export async function getDirHandle(): Promise<DirRecord | null> {
  const db = await openDB();
  const store = getStore(db, STORE_DIRS, 'readonly');
  const result = await requestToPromise(store.get(DIR_KEY));
  return (result as DirRecord) ?? null;
}

/**
 * 删除已授权目录句柄。
 */
export async function clearDirHandle(): Promise<void> {
  const db = await openDB();
  const store = getStore(db, STORE_DIRS, 'readwrite');
  store.delete(DIR_KEY);
  await waitForTransaction(store);
}
