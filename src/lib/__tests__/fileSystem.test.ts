/**
 * fileSystem.ts 单元测试（N04a + N04b）
 *
 * 由于 File System Access API 依赖浏览器环境（showOpenFilePicker 等），
 * 测试通过 mock 这些全局 API 来验证逻辑分支。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock File System Access API 类型与全局对象
type MockFileHandle = {
  kind: 'file';
  name: string;
  getFile: () => Promise<{ name: string; text: () => Promise<string>; type: string }>;
  createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
  queryPermission?: (opts: { mode: string }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: string }) => Promise<PermissionState>;
  isSameEntry?: (other: unknown) => Promise<boolean>;
};

type MockDirHandle = {
  kind: 'directory';
  name: string;
  values: () => AsyncIterableIterator<MockFileHandle | MockDirHandle>;
  getDirectoryHandle: (name: string, opts?: { create?: boolean }) => Promise<MockDirHandle>;
  getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<MockFileHandle>;
  queryPermission?: (opts: { mode: string }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: string }) => Promise<PermissionState>;
};

function createMockFileHandle(name: string, content: string): MockFileHandle {
  return {
    kind: 'file',
    name,
    getFile: vi.fn().mockResolvedValue({
      name,
      text: vi.fn().mockResolvedValue(content),
      type: 'text/markdown',
    }),
    createWritable: vi.fn().mockResolvedValue({
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    queryPermission: vi.fn().mockResolvedValue('granted'),
    requestPermission: vi.fn().mockResolvedValue('granted'),
    isSameEntry: vi.fn().mockResolvedValue(false),
  };
}

describe('fileSystem.ts', () => {
  let originalShowOpen: unknown;
  let originalShowSave: unknown;
  let originalShowDir: unknown;

  beforeEach(() => {
    originalShowOpen = (window as unknown as Record<string, unknown>).showOpenFilePicker;
    originalShowSave = (window as unknown as Record<string, unknown>).showSaveFilePicker;
    originalShowDir = (window as unknown as Record<string, unknown>).showDirectoryPicker;
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>).showOpenFilePicker = originalShowOpen;
    (window as unknown as Record<string, unknown>).showSaveFilePicker = originalShowSave;
    (window as unknown as Record<string, unknown>).showDirectoryPicker = originalShowDir;
    vi.restoreAllMocks();
  });

  // ── isFileSystemAccessSupported ──

  describe('isFileSystemAccessSupported', () => {
    it('should return true when showOpenFilePicker and showSaveFilePicker exist', async () => {
      const { isFileSystemAccessSupported } = await import('../fileSystem');
      (window as unknown as Record<string, unknown>).showOpenFilePicker = vi.fn();
      (window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn();
      expect(isFileSystemAccessSupported()).toBe(true);
    });

    it('should return false when APIs are missing', async () => {
      const { isFileSystemAccessSupported } = await import('../fileSystem');
      delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
      delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
      expect(isFileSystemAccessSupported()).toBe(false);
    });
  });

  describe('isDirectoryPickerSupported', () => {
    it('should return true when showDirectoryPicker exists', async () => {
      const { isDirectoryPickerSupported } = await import('../fileSystem');
      (window as unknown as Record<string, unknown>).showDirectoryPicker = vi.fn();
      expect(isDirectoryPickerSupported()).toBe(true);
    });

    it('should return false when showDirectoryPicker is missing', async () => {
      const { isDirectoryPickerSupported } = await import('../fileSystem');
      delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
      expect(isDirectoryPickerSupported()).toBe(false);
    });
  });

  // ── generateFileId ──

  describe('generateFileId', () => {
    it('should generate unique IDs for the same name', async () => {
      const { generateFileId } = await import('../fileSystem');
      const id1 = generateFileId('test.md');
      const id2 = generateFileId('test.md');
      expect(id1).not.toBe(id2);
      expect(id1).toContain('test_md');
    });

    it('should sanitize special characters in name', async () => {
      const { generateFileId } = await import('../fileSystem');
      const id = generateFileId('my file (1).md');
      expect(id).not.toContain(' ');
      expect(id).not.toContain('(');
      expect(id).not.toContain(')');
    });
  });

  // ── openMarkdownFile ──

  describe('openMarkdownFile', () => {
    it('should return handle, content, and name when user selects a file', async () => {
      const { openMarkdownFile } = await import('../fileSystem');
      const mockHandle = createMockFileHandle('test.md', '# Hello');
      (window as unknown as Record<string, unknown>).showOpenFilePicker = vi
        .fn()
        .mockResolvedValue([mockHandle]);
      (window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn();

      const result = await openMarkdownFile();
      expect(result).not.toBeNull();
      expect(result!.name).toBe('test.md');
      expect(result!.content).toBe('# Hello');
      expect(result!.handle).toBe(mockHandle);
    });

    it('should return null when user cancels (AbortError)', async () => {
      const { openMarkdownFile } = await import('../fileSystem');
      (window as unknown as Record<string, unknown>).showOpenFilePicker = vi
        .fn()
        .mockRejectedValue(new DOMException('User cancelled', 'AbortError'));
      (window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn();

      const result = await openMarkdownFile();
      expect(result).toBeNull();
    });

    it('should throw when API is not supported', async () => {
      const { openMarkdownFile } = await import('../fileSystem');
      delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
      delete (window as unknown as Record<string, unknown>).showSaveFilePicker;

      await expect(openMarkdownFile()).rejects.toThrow('not supported');
    });
  });

  // ── saveMarkdownFile ──

  describe('saveMarkdownFile', () => {
    it('should write to existing handle when provided', async () => {
      const { saveMarkdownFile } = await import('../fileSystem');
      const mockHandle = createMockFileHandle('existing.md', 'old');
      (window as unknown as Record<string, unknown>).showOpenFilePicker = vi.fn();
      (window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn();

      const result = await saveMarkdownFile('new content', mockHandle as unknown as FileSystemFileHandle);
      expect(result.handle).toBe(mockHandle);
      expect(result.name).toBe('existing.md');
      expect(mockHandle.createWritable).toHaveBeenCalled();
    });

    it('should show save picker when no handle provided', async () => {
      const { saveMarkdownFile } = await import('../fileSystem');
      const mockHandle = createMockFileHandle('new.md', '');
      (window as unknown as Record<string, unknown>).showOpenFilePicker = vi.fn();
      (window as unknown as Record<string, unknown>).showSaveFilePicker = vi
        .fn()
        .mockResolvedValue(mockHandle);

      const result = await saveMarkdownFile('content', null, 'new.md');
      expect(result.handle).toBe(mockHandle);
      expect(result.name).toBe('new.md');
      expect(mockHandle.createWritable).toHaveBeenCalled();
    });

    it('should throw AbortError when user cancels save picker', async () => {
      const { saveMarkdownFile } = await import('../fileSystem');
      (window as unknown as Record<string, unknown>).showOpenFilePicker = vi.fn();
      (window as unknown as Record<string, unknown>).showSaveFilePicker = vi
        .fn()
        .mockRejectedValue(new DOMException('Cancelled', 'AbortError'));

      await expect(saveMarkdownFile('content', null)).rejects.toThrow();
    });
  });

  // ── verifyPermission ──

  describe('verifyPermission', () => {
    it('should return true when permission is already granted', async () => {
      const { verifyPermission } = await import('../fileSystem');
      const mockHandle = {
        queryPermission: vi.fn().mockResolvedValue('granted'),
        requestPermission: vi.fn(),
      };

      const result = await verifyPermission(mockHandle as unknown as FileSystemHandle, 'readwrite');
      expect(result).toBe(true);
      expect(mockHandle.requestPermission).not.toHaveBeenCalled();
    });

    it('should request permission when not granted', async () => {
      const { verifyPermission } = await import('../fileSystem');
      const mockHandle = {
        queryPermission: vi.fn().mockResolvedValue('prompt'),
        requestPermission: vi.fn().mockResolvedValue('granted'),
      };

      const result = await verifyPermission(mockHandle as unknown as FileSystemHandle, 'readwrite');
      expect(result).toBe(true);
      expect(mockHandle.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    });

    it('should return false when permission is denied', async () => {
      const { verifyPermission } = await import('../fileSystem');
      const mockHandle = {
        queryPermission: vi.fn().mockResolvedValue('prompt'),
        requestPermission: vi.fn().mockResolvedValue('denied'),
      };

      const result = await verifyPermission(mockHandle as unknown as FileSystemHandle, 'readwrite');
      expect(result).toBe(false);
    });

    it('should return true when queryPermission/requestPermission are missing', async () => {
      const { verifyPermission } = await import('../fileSystem');
      const mockHandle = {};

      const result = await verifyPermission(mockHandle as unknown as FileSystemHandle, 'read');
      expect(result).toBe(true);
    });
  });

  // ── serializeHandle / deserializeHandle ──

  describe('serializeHandle / deserializeHandle', () => {
    it('should return the same handle (pass-through)', async () => {
      const { serializeHandle, deserializeHandle } = await import('../fileSystem');
      const mockHandle = createMockFileHandle('test.md', 'content');

      const serialized = serializeHandle(mockHandle as unknown as FileSystemFileHandle);
      const deserialized = deserializeHandle(serialized);
      expect(deserialized).toBe(mockHandle);
    });
  });

  // ── isSameFile ──

  describe('isSameFile', () => {
    it('should return true when handles point to same file', async () => {
      const { isSameFile } = await import('../fileSystem');
      const mockHandle = {
        isSameEntry: vi.fn().mockResolvedValue(true),
      };

      const result = await isSameFile(
        mockHandle as unknown as FileSystemHandle,
        mockHandle as unknown as FileSystemHandle,
      );
      expect(result).toBe(true);
    });

    it('should return false when isSameEntry is missing', async () => {
      const { isSameFile } = await import('../fileSystem');
      const result = await isSameFile(
        {} as unknown as FileSystemHandle,
        {} as unknown as FileSystemHandle,
      );
      expect(result).toBe(false);
    });
  });

  // ── getDirectoryHandle (N04b) ──

  describe('getDirectoryHandle', () => {
    it('should return directory handle when user selects a directory', async () => {
      const { getDirectoryHandle } = await import('../fileSystem');
      const mockDir: MockDirHandle = {
        kind: 'directory',
        name: 'docs',
        values: vi.fn(),
        getDirectoryHandle: vi.fn(),
        getFileHandle: vi.fn(),
        queryPermission: vi.fn().mockResolvedValue('granted'),
        requestPermission: vi.fn().mockResolvedValue('granted'),
      };
      (window as unknown as Record<string, unknown>).showDirectoryPicker = vi
        .fn()
        .mockResolvedValue(mockDir);

      const result = await getDirectoryHandle();
      expect(result).toBe(mockDir);
    });

    it('should return null when user cancels', async () => {
      const { getDirectoryHandle } = await import('../fileSystem');
      (window as unknown as Record<string, unknown>).showDirectoryPicker = vi
        .fn()
        .mockRejectedValue(new DOMException('Cancelled', 'AbortError'));

      const result = await getDirectoryHandle();
      expect(result).toBeNull();
    });

    it('should throw when not supported', async () => {
      const { getDirectoryHandle } = await import('../fileSystem');
      delete (window as unknown as Record<string, unknown>).showDirectoryPicker;

      await expect(getDirectoryHandle()).rejects.toThrow('not supported');
    });
  });

  // ── readImageAsBlob (N04b) ──

  describe('readImageAsBlob', () => {
    it('should read image file and return Blob URL', async () => {
      const { readImageAsBlob } = await import('../fileSystem');
      const mockFileHandle = createMockFileHandle('photo.png', '');
      const mockDir: MockDirHandle = {
        kind: 'directory',
        name: 'docs',
        values: vi.fn(),
        getDirectoryHandle: vi.fn(),
        getFileHandle: vi.fn().mockResolvedValue(mockFileHandle),
        queryPermission: vi.fn().mockResolvedValue('granted'),
        requestPermission: vi.fn().mockResolvedValue('granted'),
      };

      const url = await readImageAsBlob(
        mockDir as unknown as FileSystemDirectoryHandle,
        'photo.png',
      );
      expect(url).not.toBeNull();
      expect(url).toMatch(/^blob:/);
      URL.revokeObjectURL(url!);
    });

    it('should handle nested directory paths', async () => {
      const { readImageAsBlob } = await import('../fileSystem');
      const mockFileHandle = createMockFileHandle('logo.png', '');
      const mockSubDir: MockDirHandle = {
        kind: 'directory',
        name: 'images',
        values: vi.fn(),
        getDirectoryHandle: vi.fn(),
        getFileHandle: vi.fn().mockResolvedValue(mockFileHandle),
        queryPermission: vi.fn().mockResolvedValue('granted'),
        requestPermission: vi.fn().mockResolvedValue('granted'),
      };
      const mockRootDir: MockDirHandle = {
        kind: 'directory',
        name: 'docs',
        values: vi.fn(),
        getDirectoryHandle: vi.fn().mockResolvedValue(mockSubDir),
        getFileHandle: vi.fn(),
        queryPermission: vi.fn().mockResolvedValue('granted'),
        requestPermission: vi.fn().mockResolvedValue('granted'),
      };

      const url = await readImageAsBlob(
        mockRootDir as unknown as FileSystemDirectoryHandle,
        'images/logo.png',
      );
      expect(url).not.toBeNull();
      expect(url).toMatch(/^blob:/);
      URL.revokeObjectURL(url!);
    });

    it('should return null when file not found', async () => {
      const { readImageAsBlob } = await import('../fileSystem');
      const mockDir: MockDirHandle = {
        kind: 'directory',
        name: 'docs',
        values: vi.fn(),
        getDirectoryHandle: vi.fn(),
        getFileHandle: vi.fn().mockRejectedValue(new DOMException('Not found', 'NotFoundError')),
        queryPermission: vi.fn().mockResolvedValue('granted'),
        requestPermission: vi.fn().mockResolvedValue('granted'),
      };

      const url = await readImageAsBlob(
        mockDir as unknown as FileSystemDirectoryHandle,
        'missing.png',
      );
      expect(url).toBeNull();
    });

    it('should normalize leading ./ in path', async () => {
      const { readImageAsBlob } = await import('../fileSystem');
      const mockFileHandle = createMockFileHandle('photo.png', '');
      const mockDir: MockDirHandle = {
        kind: 'directory',
        name: 'docs',
        values: vi.fn(),
        getDirectoryHandle: vi.fn(),
        getFileHandle: vi.fn().mockResolvedValue(mockFileHandle),
        queryPermission: vi.fn().mockResolvedValue('granted'),
        requestPermission: vi.fn().mockResolvedValue('granted'),
      };

      const url = await readImageAsBlob(
        mockDir as unknown as FileSystemDirectoryHandle,
        './photo.png',
      );
      expect(url).not.toBeNull();
      URL.revokeObjectURL(url!);
    });

    it('should return null for empty path', async () => {
      const { readImageAsBlob } = await import('../fileSystem');
      const mockDir: MockDirHandle = {
        kind: 'directory',
        name: 'docs',
        values: vi.fn(),
        getDirectoryHandle: vi.fn(),
        getFileHandle: vi.fn(),
        queryPermission: vi.fn().mockResolvedValue('granted'),
        requestPermission: vi.fn().mockResolvedValue('granted'),
      };

      const url = await readImageAsBlob(
        mockDir as unknown as FileSystemDirectoryHandle,
        '',
      );
      expect(url).toBeNull();
    });
  });

  // ── openImageFile ──

  describe('openImageFile', () => {
    it('should return blob URL and name when user selects an image', async () => {
      const { openImageFile } = await import('../fileSystem');
      const mockHandle = createMockFileHandle('photo.jpg', '');
      (window as unknown as Record<string, unknown>).showOpenFilePicker = vi
        .fn()
        .mockResolvedValue([mockHandle]);
      (window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn();

      const result = await openImageFile();
      expect(result).not.toBeNull();
      expect(result!.name).toBe('photo.jpg');
      expect(result!.url).toMatch(/^blob:/);
      URL.revokeObjectURL(result!.url);
    });

    it('should return null when user cancels', async () => {
      const { openImageFile } = await import('../fileSystem');
      (window as unknown as Record<string, unknown>).showOpenFilePicker = vi
        .fn()
        .mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
      (window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn();

      const result = await openImageFile();
      expect(result).toBeNull();
    });
  });

  // ── revokeBlobUrl ──

  describe('revokeBlobUrl', () => {
    it('should revoke blob URLs without error', async () => {
      const { revokeBlobUrl } = await import('../fileSystem');
      const blob = new Blob(['test'], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      expect(() => revokeBlobUrl(url)).not.toThrow();
    });

    it('should ignore non-blob URLs', async () => {
      const { revokeBlobUrl } = await import('../fileSystem');
      expect(() => revokeBlobUrl('https://example.com')).not.toThrow();
    });
  });
});
