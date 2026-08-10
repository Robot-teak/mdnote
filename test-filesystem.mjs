/**
 * Standalone test: fileSystem.ts
 * Uses mock window object for File System Access API.
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'url';
import { resolve } from 'path';
import fs from 'fs';

const projectRoot = resolve('.');
const results = { passed: 0, failed: 0, failures: [] };

function assert(condition, message) {
  if (condition) {
    results.passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${message}`);
  } else {
    results.failed++;
    results.failures.push(message);
    console.log(`  \x1b[31m✗\x1b[0m ${message}`);
  }
}

// DOMException polyfill
if (typeof globalThis.DOMException === 'undefined') {
  globalThis.DOMException = class DOMException extends Error {
    constructor(message, name) { super(message); this.name = name || 'Error'; }
  };
}

// Blob polyfill
if (typeof globalThis.Blob === 'undefined') {
  globalThis.Blob = class Blob {
    constructor(parts, options) {
      this.parts = parts || [];
      this.type = options?.type || '';
      this.size = this.parts.reduce((s, p) => s + (p?.length || p?.size || 0), 0);
    }
    async text() { return this.parts.map(p => String(p)).join(''); }
  };
}

// URL polyfill
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = () => `blob:fake-${Date.now()}-${Math.random()}`;
  globalThis.URL.revokeObjectURL = () => {};
}

async function main() {
  console.log(`\n\x1b[1m━━━ fileSystem.ts tests ━━━\x1b[0m`);

  // Build the module
  const outFile = `/tmp/mdnote-fs-${Date.now()}.mjs`;
  await build({
    entryPoints: [resolve(projectRoot, 'src/lib/fileSystem.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: outFile,
    sourcemap: true,
    define: { 'import.meta.env.MODE': '"test"' },
  });

  const mod = await import(pathToFileURL(outFile).href + '?t=' + Date.now());

  const {
    isFileSystemAccessSupported,
    isDirectoryPickerSupported,
    generateFileId,
    openMarkdownFile,
    saveMarkdownFile,
    verifyPermission,
    checkPermission,
    serializeHandle,
    deserializeHandle,
    isSameFile,
    getDirectoryHandle,
    verifyDirectoryPermission,
    readImageAsBlob,
    openImageFile,
    revokeBlobUrl,
  } = mod;

  // ─── Helper: create mock file handle ───
  function createMockFileHandle(name, content) {
    return {
      kind: 'file',
      name,
      getFile: () => Promise.resolve({
        name,
        text: () => Promise.resolve(content),
        type: 'text/markdown',
        size: content.length,
      }),
      createWritable: () => Promise.resolve({
        write: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
      queryPermission: (opts) => Promise.resolve('granted'),
      requestPermission: (opts) => Promise.resolve('granted'),
      isSameEntry: (other) => Promise.resolve(other === this),
    };
  }

  function createMockDirHandle(name) {
    return {
      kind: 'directory',
      name,
      values: async function* () {},
      getDirectoryHandle: () => Promise.resolve(createMockDirHandle('sub')),
      getFileHandle: () => Promise.resolve(createMockFileHandle('file', '')),
      queryPermission: () => Promise.resolve('granted'),
      requestPermission: () => Promise.resolve('granted'),
    };
  }

  // ─── isFileSystemAccessSupported ───
  console.log('\n  isFileSystemAccessSupported');
  {
    // With APIs present
    globalThis.window = {
      showOpenFilePicker: () => {},
      showSaveFilePicker: () => {},
    };
    assert(isFileSystemAccessSupported() === true, 'should return true when APIs exist');

    // Without APIs
    globalThis.window = {};
    assert(isFileSystemAccessSupported() === false, 'should return false when APIs missing');

    // Partial
    globalThis.window = { showOpenFilePicker: () => {} };
    assert(isFileSystemAccessSupported() === false, 'should return false when only one API exists');
  }

  // ─── isDirectoryPickerSupported ───
  console.log('\n  isDirectoryPickerSupported');
  {
    globalThis.window = { showDirectoryPicker: () => {} };
    assert(isDirectoryPickerSupported() === true, 'should return true when showDirectoryPicker exists');

    globalThis.window = {};
    assert(isDirectoryPickerSupported() === false, 'should return false when showDirectoryPicker missing');
  }

  // ─── generateFileId ───
  console.log('\n  generateFileId');
  {
    const id1 = generateFileId('test.md');
    const id2 = generateFileId('test.md');
    assert(id1 !== id2, 'should generate unique IDs for same name');
    assert(id1.includes('test_md'), 'should contain sanitized name');

    const id3 = generateFileId('my file (1).md');
    assert(!id3.includes(' '), 'should not contain spaces');
    assert(!id3.includes('('), 'should not contain parens');
    assert(!id3.includes(')'), 'should not contain parens');
  }

  // ─── openMarkdownFile ───
  console.log('\n  openMarkdownFile');
  {
    const mockHandle = createMockFileHandle('test.md', '# Hello');
    globalThis.window = {
      showOpenFilePicker: () => Promise.resolve([mockHandle]),
      showSaveFilePicker: () => {},
    };

    const result = await openMarkdownFile();
    assert(result !== null, 'should return non-null result');
    assert(result.name === 'test.md', 'should return correct file name');
    assert(result.content === '# Hello', 'should return correct content');
    assert(result.handle === mockHandle, 'should return the handle');

    // User cancels
    globalThis.window = {
      showOpenFilePicker: () => Promise.reject(new DOMException('Cancelled', 'AbortError')),
      showSaveFilePicker: () => {},
    };
    const cancelled = await openMarkdownFile();
    assert(cancelled === null, 'should return null when user cancels');

    // Not supported
    globalThis.window = {};
    let threw = false;
    try { await openMarkdownFile(); } catch(e) { threw = e.message.includes('not supported'); }
    assert(threw, 'should throw when API not supported');
  }

  // ─── saveMarkdownFile ───
  console.log('\n  saveMarkdownFile');
  {
    const mockHandle = createMockFileHandle('existing.md', 'old');
    globalThis.window = {
      showOpenFilePicker: () => {},
      showSaveFilePicker: () => {},
    };

    // Save to existing handle
    const result = await saveMarkdownFile('new content', mockHandle);
    assert(result.handle === mockHandle, 'should return same handle');
    assert(result.name === 'existing.md', 'should return correct name');

    // Save as (no handle)
    const newHandle = createMockFileHandle('new.md', '');
    globalThis.window = {
      showOpenFilePicker: () => {},
      showSaveFilePicker: () => Promise.resolve(newHandle),
    };
    const saveAsResult = await saveMarkdownFile('content', null, 'new.md');
    assert(saveAsResult.handle === newHandle, 'should return new handle from save picker');
    assert(saveAsResult.name === 'new.md', 'should return correct name from save picker');

    // User cancels save
    globalThis.window = {
      showOpenFilePicker: () => {},
      showSaveFilePicker: () => Promise.reject(new DOMException('Cancelled', 'AbortError')),
    };
    let saveCancelled = false;
    try { await saveMarkdownFile('content', null); } catch(e) { saveCancelled = e.name === 'AbortError'; }
    assert(saveCancelled, 'should throw AbortError when user cancels save');

    // Not supported
    globalThis.window = {};
    let saveThrew = false;
    try { await saveMarkdownFile('content', null); } catch(e) { saveThrew = e.message.includes('not supported'); }
    assert(saveThrew, 'should throw when API not supported');
  }

  // ─── verifyPermission ───
  console.log('\n  verifyPermission');
  {
    // Already granted
    const handle1 = {
      queryPermission: () => Promise.resolve('granted'),
      requestPermission: () => Promise.resolve('granted'),
    };
    const r1 = await verifyPermission(handle1, 'readwrite');
    assert(r1 === true, 'should return true when permission already granted');

    // Need to request
    const handle2 = {
      queryPermission: () => Promise.resolve('prompt'),
      requestPermission: (opts) => { handle2._lastRequest = opts; return Promise.resolve('granted'); },
    };
    const r2 = await verifyPermission(handle2, 'readwrite');
    assert(r2 === true, 'should return true when permission requested and granted');
    assert(handle2._lastRequest?.mode === 'readwrite', 'should request with correct mode');

    // Denied
    const handle3 = {
      queryPermission: () => Promise.resolve('prompt'),
      requestPermission: () => Promise.resolve('denied'),
    };
    const r3 = await verifyPermission(handle3, 'readwrite');
    assert(r3 === false, 'should return false when permission denied');

    // Missing queryPermission/requestPermission
    const handle4 = {};
    const r4 = await verifyPermission(handle4, 'read');
    assert(r4 === true, 'should return true when queryPermission missing (fallback)');
  }

  // ─── checkPermission ───
  console.log('\n  checkPermission');
  {
    const handle = {
      queryPermission: () => Promise.resolve('granted'),
    };
    const perm = await checkPermission(handle, 'read');
    assert(perm === 'granted', 'should return current permission state');

    const handle2 = {};
    const perm2 = await checkPermission(handle2, 'read');
    assert(perm2 === 'granted', 'should return granted when queryPermission missing');
  }

  // ─── serializeHandle / deserializeHandle ───
  console.log('\n  serializeHandle / deserializeHandle');
  {
    const mockHandle = createMockFileHandle('test.md', 'content');
    const serialized = serializeHandle(mockHandle);
    const deserialized = deserializeHandle(serialized);
    assert(deserialized === mockHandle, 'should pass through handle (identity)');
  }

  // ─── isSameFile ───
  console.log('\n  isSameFile');
  {
    const mockHandle = {
      isSameEntry: (other) => Promise.resolve(other === mockHandle),
    };
    const r1 = await isSameFile(mockHandle, mockHandle);
    assert(r1 === true, 'should return true when handles point to same file');

    const r2 = await isSameFile({}, {});
    assert(r2 === false, 'should return false when isSameEntry is missing');
  }

  // ─── getDirectoryHandle ───
  console.log('\n  getDirectoryHandle');
  {
    const mockDir = createMockDirHandle('docs');
    globalThis.window = { showDirectoryPicker: () => Promise.resolve(mockDir) };

    const result = await getDirectoryHandle();
    assert(result === mockDir, 'should return directory handle');

    // User cancels
    globalThis.window = { showDirectoryPicker: () => Promise.reject(new DOMException('Cancelled', 'AbortError')) };
    const cancelled = await getDirectoryHandle();
    assert(cancelled === null, 'should return null when user cancels');

    // Not supported
    globalThis.window = {};
    let threw = false;
    try { await getDirectoryHandle(); } catch(e) { threw = e.message.includes('not supported'); }
    assert(threw, 'should throw when not supported');
  }

  // ─── readImageAsBlob ───
  console.log('\n  readImageAsBlob');
  {
    const mockFileHandle = createMockFileHandle('photo.png', '');
    const mockSubDir = {
      kind: 'directory',
      name: 'images',
      getDirectoryHandle: () => Promise.resolve(mockSubDir),
      getFileHandle: () => Promise.resolve(mockFileHandle),
      queryPermission: () => Promise.resolve('granted'),
      requestPermission: () => Promise.resolve('granted'),
    };
    const mockDir = {
      kind: 'directory',
      name: 'docs',
      getDirectoryHandle: () => Promise.resolve(mockSubDir),
      getFileHandle: () => Promise.resolve(mockFileHandle),
      queryPermission: () => Promise.resolve('granted'),
      requestPermission: () => Promise.resolve('granted'),
    };

    // Read image
    const url = await readImageAsBlob(mockDir, 'photo.png');
    assert(url !== null, 'should return Blob URL');
    assert(url?.startsWith('blob:'), 'should return URL starting with blob:');

    // Nested path
    const nestedUrl = await readImageAsBlob(mockDir, 'images/logo.png');
    assert(nestedUrl !== null, 'should handle nested directory paths');
    assert(nestedUrl?.startsWith('blob:'), 'nested path should return blob URL');

    // Normalize leading ./
    const normalizedUrl = await readImageAsBlob(mockDir, './photo.png');
    assert(normalizedUrl !== null, 'should normalize leading ./');

    // Empty path
    const emptyUrl = await readImageAsBlob(mockDir, '');
    assert(emptyUrl === null, 'should return null for empty path');

    // File not found
    const notFoundDir = {
      kind: 'directory',
      name: 'docs',
      getFileHandle: () => Promise.reject(new DOMException('Not found', 'NotFoundError')),
      queryPermission: () => Promise.resolve('granted'),
      requestPermission: () => Promise.resolve('granted'),
    };
    const notFoundUrl = await readImageAsBlob(notFoundDir, 'missing.png');
    assert(notFoundUrl === null, 'should return null when file not found');

    // Permission denied
    const noPermDir = {
      kind: 'directory',
      name: 'docs',
      queryPermission: () => Promise.resolve('denied'),
      requestPermission: () => Promise.resolve('denied'),
    };
    let permThrew = false;
    try { await readImageAsBlob(noPermDir, 'photo.png'); } catch(e) { permThrew = e.message.includes('permission'); }
    assert(permThrew, 'should throw when permission denied');
  }

  // ─── openImageFile ───
  console.log('\n  openImageFile');
  {
    const mockHandle = createMockFileHandle('photo.jpg', '');
    globalThis.window = {
      showOpenFilePicker: () => Promise.resolve([mockHandle]),
      showSaveFilePicker: () => {},
    };

    const result = await openImageFile();
    assert(result !== null, 'should return non-null result');
    assert(result.name === 'photo.jpg', 'should return correct name');
    assert(result.url.startsWith('blob:'), 'should return blob URL');

    // Cancel
    globalThis.window = {
      showOpenFilePicker: () => Promise.reject(new DOMException('Cancelled', 'AbortError')),
      showSaveFilePicker: () => {},
    };
    const cancelled = await openImageFile();
    assert(cancelled === null, 'should return null when cancelled');
  }

  // ─── revokeBlobUrl ───
  console.log('\n  revokeBlobUrl');
  {
    let noError = true;
    try { revokeBlobUrl('blob:fake-url'); } catch(e) { noError = false; }
    assert(noError, 'should revoke blob URLs without error');

    noError = true;
    try { revokeBlobUrl('https://example.com'); } catch(e) { noError = false; }
    assert(noError, 'should ignore non-blob URLs');
  }

  // Cleanup
  try { fs.unlinkSync(outFile); } catch {}
  try { fs.unlinkSync(outFile + '.map'); } catch {}

  console.log(`\n  \x1b[1mResult: ${results.passed} passed, ${results.failed} failed\x1b[0m`);
  return results;
}

main().then(r => {
  process.exit(r.failed > 0 ? 1 : 0);
}).catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
