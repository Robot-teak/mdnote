/**
 * indexeddb.ts 单元测试（N07）
 *
 * 验证 IndexedDB 封装的 CRUD 操作：
 * - 草稿保存/获取/列表/删除
 * - 句柄保存/获取/删除
 * - schema_version 字段
 *
 * R5：最近文件（recent store）的 CRUD 与用例已随功能一并移除；
 * recent object store 本身仍保留（DB_VERSION 维持 v2，见决策 D9）。
 *
 * 使用 fake-indexeddb 模拟 IndexedDB 环境。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  DB_NAME,
  DB_VERSION,
  STORE_DRAFTS,
  STORE_HANDLES,
  STORE_RECENT,
  CURRENT_SCHEMA_VERSION,
  openDB,
  closeDB,
  saveDraft,
  getDraft,
  listDrafts,
  deleteDraft,
  clearAllDrafts,
  saveHandle,
  getHandle,
  deleteHandle,
  clearAllHandles,
  getDataSchemaVersion,
  needsMigration,
} from '../indexeddb';
import type { DraftMeta } from '../indexeddb';

// Mock FileSystemFileHandle for handle storage tests
function createMockFileHandle(name: string): FileSystemFileHandle {
  return {
    kind: 'file',
    name,
    getFile: vi.fn().mockResolvedValue({ name, text: () => Promise.resolve(''), type: '' }),
    createWritable: vi.fn().mockResolvedValue({ write: vi.fn(), close: vi.fn() }),
  } as unknown as FileSystemFileHandle;
}

describe('indexeddb.ts', () => {
  beforeEach(async () => {
    closeDB();
    // 删除并重建数据库以确保测试隔离
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    await openDB();
  });

  afterEach(() => {
    closeDB();
  });

  // ── 数据库初始化 ──

  describe('database initialization', () => {
    it('should create database with correct name and version', async () => {
      const db = await openDB();
      expect(db.name).toBe(DB_NAME);
      // R5 后 DB_VERSION 仍为 2（决策 D9：不升版本，recent store 保留）
      expect(db.version).toBe(DB_VERSION);
    });

    it('should create all three object stores', async () => {
      const db = await openDB();
      expect(db.objectStoreNames.contains(STORE_DRAFTS)).toBe(true);
      expect(db.objectStoreNames.contains(STORE_HANDLES)).toBe(true);
      expect(db.objectStoreNames.contains(STORE_RECENT)).toBe(true);
    });
  });

  // ── 草稿 CRUD ──

  describe('drafts CRUD', () => {
    const testMeta: DraftMeta = { name: 'test.md', hasHandle: false };

    it('should save a draft and retrieve it by id', async () => {
      const record = await saveDraft('draft-1', '# Hello', testMeta);
      expect(record.id).toBe('draft-1');
      expect(record.content).toBe('# Hello');
      expect(record.meta.name).toBe('test.md');
      expect(record.schema_version).toBe(CURRENT_SCHEMA_VERSION);
      expect(record.contentLength).toBe(7);

      const retrieved = await getDraft('draft-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.content).toBe('# Hello');
      expect(retrieved!.meta.name).toBe('test.md');
    });

    it('should return null for non-existent draft', async () => {
      const result = await getDraft('non-existent');
      expect(result).toBeNull();
    });

    it('should update draft when saving with same id', async () => {
      await saveDraft('draft-1', 'old content', testMeta);
      await saveDraft('draft-1', 'new content', testMeta);

      const retrieved = await getDraft('draft-1');
      expect(retrieved!.content).toBe('new content');
    });

    it('should list all drafts sorted by updatedAt descending', async () => {
      await saveDraft('draft-1', 'first', { name: 'a.md', hasHandle: false });
      // 确保时间戳不同
      await new Promise((r) => setTimeout(r, 5));
      await saveDraft('draft-2', 'second', { name: 'b.md', hasHandle: false });
      await new Promise((r) => setTimeout(r, 5));
      await saveDraft('draft-3', 'third', { name: 'c.md', hasHandle: false });

      const drafts = await listDrafts();
      expect(drafts).toHaveLength(3);
      // 最新的在前
      expect(drafts[0].content).toBe('third');
      expect(drafts[2].content).toBe('first');
    });

    it('should return empty array when no drafts exist', async () => {
      const drafts = await listDrafts();
      expect(drafts).toHaveLength(0);
    });

    it('should delete a draft by id', async () => {
      await saveDraft('draft-1', 'content', testMeta);
      await deleteDraft('draft-1');

      const result = await getDraft('draft-1');
      expect(result).toBeNull();
    });

    it('should not throw when deleting non-existent draft', async () => {
      await expect(deleteDraft('non-existent')).resolves.not.toThrow();
    });

    it('should clear all drafts', async () => {
      await saveDraft('draft-1', 'a', testMeta);
      await saveDraft('draft-2', 'b', testMeta);
      await clearAllDrafts();

      const drafts = await listDrafts();
      expect(drafts).toHaveLength(0);
    });

    it('should store contentLength correctly', async () => {
      const longContent = 'x'.repeat(1000);
      const record = await saveDraft('draft-1', longContent, testMeta);
      expect(record.contentLength).toBe(1000);

      const retrieved = await getDraft('draft-1');
      expect(retrieved!.contentLength).toBe(1000);
    });
  });

  // ── 句柄 CRUD ──

  describe('handles CRUD', () => {
    it('should save a file handle and retrieve it', async () => {
      const mockHandle = createMockFileHandle('doc.md');
      await saveHandle('handle-1', mockHandle, 'doc.md');

      const retrieved = await getHandle('handle-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe('handle-1');
      expect(retrieved!.name).toBe('doc.md');
      expect(retrieved!.handle).toBe(mockHandle);
      expect(retrieved!.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    });

    it('should return null for non-existent handle', async () => {
      const result = await getHandle('non-existent');
      expect(result).toBeNull();
    });

    it('should update handle when saving with same id', async () => {
      const handle1 = createMockFileHandle('v1.md');
      const handle2 = createMockFileHandle('v2.md');

      await saveHandle('handle-1', handle1, 'v1.md');
      await saveHandle('handle-1', handle2, 'v2.md');

      const retrieved = await getHandle('handle-1');
      expect(retrieved!.name).toBe('v2.md');
      expect(retrieved!.handle).toBe(handle2);
    });

    it('should delete a handle by id', async () => {
      const mockHandle = createMockFileHandle('doc.md');
      await saveHandle('handle-1', mockHandle, 'doc.md');
      await deleteHandle('handle-1');

      const result = await getHandle('handle-1');
      expect(result).toBeNull();
    });

    it('should clear all handles', async () => {
      const h1 = createMockFileHandle('a.md');
      const h2 = createMockFileHandle('b.md');
      await saveHandle('h1', h1, 'a.md');
      await saveHandle('h2', h2, 'b.md');
      await clearAllHandles();

      const r1 = await getHandle('h1');
      const r2 = await getHandle('h2');
      expect(r1).toBeNull();
      expect(r2).toBeNull();
    });
  });

  // ── 迁移支持 ──

  describe('migration support', () => {
    it('should return CURRENT_SCHEMA_VERSION when no data exists', async () => {
      const version = await getDataSchemaVersion();
      expect(version).toBe(CURRENT_SCHEMA_VERSION);
    });

    it('should return data schema version from existing drafts', async () => {
      await saveDraft('draft-1', 'content', { name: 'test.md', hasHandle: false });
      const version = await getDataSchemaVersion();
      expect(version).toBe(CURRENT_SCHEMA_VERSION);
    });

    it('should return false for needsMigration with current data', async () => {
      await saveDraft('draft-1', 'content', { name: 'test.md', hasHandle: false });
      const needs = await needsMigration();
      expect(needs).toBe(false);
    });

    it('should return false for needsMigration with no data', async () => {
      const needs = await needsMigration();
      expect(needs).toBe(false);
    });
  });

  // ── 综合场景 ──

  describe('integration scenarios', () => {
    it('should handle draft + handle together', async () => {
      const mockHandle = createMockFileHandle('project.md');

      // 保存草稿
      const draft = await saveDraft('doc-1', '# Project', { name: 'project.md', hasHandle: true });
      expect(draft.id).toBe('doc-1');

      // 保存句柄
      await saveHandle('doc-1', mockHandle, 'project.md');

      // 验证全部可读
      const d = await getDraft('doc-1');
      const h = await getHandle('doc-1');

      expect(d!.content).toBe('# Project');
      expect(h!.name).toBe('project.md');
    });

    it('should handle clearing all stores independently', async () => {
      await saveDraft('d1', 'content', { name: 'a.md', hasHandle: false });
      await saveHandle('h1', createMockFileHandle('b.md'), 'b.md');

      await clearAllDrafts();
      expect((await listDrafts())).toHaveLength(0);
      expect((await getHandle('h1'))).not.toBeNull();

      await clearAllHandles();
      expect((await getHandle('h1'))).toBeNull();
    });
  });
});
