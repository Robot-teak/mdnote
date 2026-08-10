/**
 * Standalone test: indexeddb.ts
 * Uses fake-indexeddb for IndexedDB environment.
 * Uses esbuild to transpile the TS module to JS.
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

async function assertThrows(fn, expectedMsg) {
  try {
    await fn();
    assert(false, `Expected to throw but did not: ${expectedMsg}`);
  } catch (e) {
    if (expectedMsg && !e.message.includes(expectedMsg)) {
      assert(false, `Expected error containing "${expectedMsg}", got "${e.message}"`);
    } else {
      results.passed++;
      console.log(`  \x1b[32m✓\x1b[0m Expected throw: ${expectedMsg || 'threw correctly'}`);
    }
  }
}

async function main() {
  // Load fake-indexeddb BEFORE importing the module
  await import('fake-indexeddb/auto');
  console.log(`\n\x1b[1m━━━ indexeddb.ts tests ━━━\x1b[0m`);

  // Build the module
  const outFile = `/tmp/mdnote-indexeddb-${Date.now()}.mjs`;
  await build({
    entryPoints: [resolve(projectRoot, 'src/lib/indexeddb.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: outFile,
    sourcemap: true,
    define: { 'import.meta.env.MODE': '"test"' },
  });

  const mod = await import(pathToFileURL(outFile).href + '?t=' + Date.now());

  const {
    DB_NAME, DB_VERSION, STORE_DRAFTS, STORE_HANDLES, STORE_RECENT,
    CURRENT_SCHEMA_VERSION, MAX_RECENT_FILES,
    openDB, closeDB,
    saveDraft, getDraft, listDrafts, deleteDraft, clearAllDrafts,
    saveHandle, getHandle, deleteHandle, clearAllHandles,
    addRecent, listRecent, removeRecent, clearRecent,
    getDataSchemaVersion, needsMigration,
  } = mod;

  // ─── Helper: reset DB ───
  async function resetDB() {
    closeDB();
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    await openDB();
  }

  await resetDB();

  // ─── Database initialization ───
  console.log('\n  Database initialization');
  {
    const db = await openDB();
    assert(db.name === DB_NAME, `should create database with correct name (got ${db.name})`);
    assert(db.version === DB_VERSION, `should create database with correct version (got ${db.version})`);
    assert(db.objectStoreNames.contains(STORE_DRAFTS), 'should create drafts store');
    assert(db.objectStoreNames.contains(STORE_HANDLES), 'should create handles store');
    assert(db.objectStoreNames.contains(STORE_RECENT), 'should create recent store');
  }

  // ─── Drafts CRUD ───
  console.log('\n  Drafts CRUD');
  await resetDB();
  {
    // save + get
    const testMeta = { name: 'test.md', hasHandle: false };
    const record = await saveDraft('draft-1', '# Hello', testMeta);
    assert(record.id === 'draft-1', 'should save draft with correct id');
    assert(record.content === '# Hello', 'should save draft with correct content');
    assert(record.meta.name === 'test.md', 'should save draft with correct meta');
    assert(record.schema_version === CURRENT_SCHEMA_VERSION, 'should save draft with correct schema_version');
    assert(record.contentLength === 7, 'should save draft with correct contentLength');

    const retrieved = await getDraft('draft-1');
    assert(retrieved !== null, 'should retrieve saved draft');
    assert(retrieved.content === '# Hello', 'retrieved content should match');
    assert(retrieved.meta.name === 'test.md', 'retrieved meta should match');

    // non-existent
    const nonExist = await getDraft('non-existent');
    assert(nonExist === null, 'should return null for non-existent draft');

    // update
    await saveDraft('draft-1', 'new content', testMeta);
    const updated = await getDraft('draft-1');
    assert(updated.content === 'new content', 'should update draft when saving with same id');

    // list sorted by updatedAt descending
    await resetDB();
    await saveDraft('draft-1', 'first', { name: 'a.md', hasHandle: false });
    await new Promise(r => setTimeout(r, 5));
    await saveDraft('draft-2', 'second', { name: 'b.md', hasHandle: false });
    await new Promise(r => setTimeout(r, 5));
    await saveDraft('draft-3', 'third', { name: 'c.md', hasHandle: false });
    const drafts = await listDrafts();
    assert(drafts.length === 3, `should list 3 drafts (got ${drafts.length})`);
    assert(drafts[0].content === 'third', 'should list newest first');
    assert(drafts[2].content === 'first', 'should list oldest last');

    // empty list
    await resetDB();
    const empty = await listDrafts();
    assert(empty.length === 0, 'should return empty array when no drafts');

    // delete
    await saveDraft('draft-1', 'content', testMeta);
    await deleteDraft('draft-1');
    const deleted = await getDraft('draft-1');
    assert(deleted === null, 'should delete draft by id');

    // delete non-existent (should not throw)
    try {
      await deleteDraft('non-existent');
      assert(true, 'should not throw when deleting non-existent draft');
    } catch(e) {
      assert(false, `should not throw when deleting non-existent draft (got: ${e.message})`);
    }

    // clear all
    await saveDraft('draft-1', 'a', testMeta);
    await saveDraft('draft-2', 'b', testMeta);
    await clearAllDrafts();
    const afterClear = await listDrafts();
    assert(afterClear.length === 0, 'should clear all drafts');

    // contentLength
    const longContent = 'x'.repeat(1000);
    const longRecord = await saveDraft('draft-1', longContent, testMeta);
    assert(longRecord.contentLength === 1000, 'should store correct contentLength');
    const retrievedLong = await getDraft('draft-1');
    assert(retrievedLong.contentLength === 1000, 'retrieved contentLength should match');
  }

  // ─── Handles CRUD ───
  console.log('\n  Handles CRUD');
  await resetDB();
  {
    // Use a plain object that's structured-clone compatible (no functions)
    const mockHandle = {
      kind: 'file',
      name: 'doc.md',
    };

    // save + get
    await saveHandle('handle-1', mockHandle, 'doc.md');
    const retrieved = await getHandle('handle-1');
    assert(retrieved !== null, 'should save and retrieve handle');
    assert(retrieved.id === 'handle-1', 'retrieved handle id matches');
    assert(retrieved.name === 'doc.md', 'retrieved handle name matches');
    assert(retrieved.handle.kind === 'file', 'retrieved handle kind matches');
    assert(retrieved.handle.name === 'doc.md', 'retrieved handle name matches');
    assert(retrieved.schema_version === CURRENT_SCHEMA_VERSION, 'handle has correct schema_version');

    // non-existent
    const nonExist = await getHandle('non-existent');
    assert(nonExist === null, 'should return null for non-existent handle');

    // update
    const handle2 = { kind: 'file', name: 'v2.md' };
    await saveHandle('handle-1', handle2, 'v2.md');
    const updated = await getHandle('handle-1');
    assert(updated.name === 'v2.md', 'should update handle when saving with same id');

    // delete
    await deleteHandle('handle-1');
    const deleted = await getHandle('handle-1');
    assert(deleted === null, 'should delete handle by id');

    // clear all
    await saveHandle('h1', mockHandle, 'a.md');
    await saveHandle('h2', mockHandle, 'b.md');
    await clearAllHandles();
    assert((await getHandle('h1')) === null, 'should clear all handles (h1)');
    assert((await getHandle('h2')) === null, 'should clear all handles (h2)');
  }

  // ─── Recent files CRUD ───
  console.log('\n  Recent files CRUD');
  await resetDB();
  {
    // add + list
    await addRecent('file-1', 'doc.md', true, 1024);
    const recent = await listRecent();
    assert(recent.length === 1, 'should add and list 1 recent file');
    assert(recent[0].id === 'file-1', 'recent file id matches');
    assert(recent[0].name === 'doc.md', 'recent file name matches');
    assert(recent[0].hasHandle === true, 'recent file hasHandle matches');
    assert(recent[0].size === 1024, 'recent file size matches');

    // sorted by lastAccessed descending
    await resetDB();
    await addRecent('file-1', 'a.md', false, 100);
    await new Promise(r => setTimeout(r, 5));
    await addRecent('file-2', 'b.md', false, 200);
    await new Promise(r => setTimeout(r, 5));
    await addRecent('file-3', 'c.md', true, 300);
    const sorted = await listRecent();
    assert(sorted.length === 3, 'should list 3 recent files');
    assert(sorted[0].id === 'file-3', 'should list newest first (file-3)');
    assert(sorted[1].id === 'file-2', 'should list second newest (file-2)');
    assert(sorted[2].id === 'file-1', 'should list oldest last (file-1)');

    // update lastAccessed when adding same id
    await resetDB();
    await addRecent('file-1', 'doc.md', false, 100);
    await new Promise(r => setTimeout(r, 10));
    await addRecent('file-1', 'doc.md', true, 200);
    const updated = await listRecent();
    assert(updated.length === 1, 'should have 1 recent file after update');
    assert(updated[0].hasHandle === true, 'updated hasHandle should be true');
    assert(updated[0].size === 200, 'updated size should be 200');

    // limit
    await resetDB();
    for (let i = 0; i < 5; i++) {
      await addRecent(`file-${i}`, `doc${i}.md`, false, 100);
      await new Promise(r => setTimeout(r, 5));
    }
    const limited = await listRecent(3);
    assert(limited.length === 3, `should limit to 3 results (got ${limited.length})`);

    // remove
    await resetDB();
    await addRecent('file-1', 'doc.md', false, 100);
    await removeRecent('file-1');
    const afterRemove = await listRecent();
    assert(afterRemove.length === 0, 'should remove recent file by id');

    // clear
    await resetDB();
    await addRecent('file-1', 'a.md', false, 100);
    await addRecent('file-2', 'b.md', false, 200);
    await clearRecent();
    const afterClear = await listRecent();
    assert(afterClear.length === 0, 'should clear all recent files');

    // trim to MAX_RECENT_FILES
    await resetDB();
    for (let i = 0; i < MAX_RECENT_FILES + 5; i++) {
      await addRecent(`file-${i}`, `doc${i}.md`, false, 100);
      await new Promise(r => setTimeout(r, 2));
    }
    const trimmed = await listRecent();
    assert(trimmed.length <= MAX_RECENT_FILES, `should trim to MAX_RECENT_FILES=${MAX_RECENT_FILES} (got ${trimmed.length})`);

    // schema_version in recent records
    await resetDB();
    await addRecent('file-1', 'doc.md', false, 100);
    const db = await openDB();
    const tx = db.transaction(STORE_RECENT, 'readonly');
    const store = tx.objectStore(STORE_RECENT);
    const rawRecord = await new Promise((resolve) => {
      const req = store.get('file-1');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    assert(rawRecord?.schema_version === CURRENT_SCHEMA_VERSION, 'recent record should have correct schema_version');
  }

  // ─── Migration support ───
  console.log('\n  Migration support');
  await resetDB();
  {
    const version = await getDataSchemaVersion();
    assert(version === CURRENT_SCHEMA_VERSION, 'should return CURRENT_SCHEMA_VERSION when no data exists');

    await saveDraft('draft-1', 'content', { name: 'test.md', hasHandle: false });
    const versionWith = await getDataSchemaVersion();
    assert(versionWith === CURRENT_SCHEMA_VERSION, 'should return data schema version from existing drafts');

    const needs = await needsMigration();
    assert(needs === false, 'should return false for needsMigration with current data');

    await resetDB();
    const needsEmpty = await needsMigration();
    assert(needsEmpty === false, 'should return false for needsMigration with no data');
  }

  // ─── Integration scenario ───
  console.log('\n  Integration scenarios');
  await resetDB();
  {
    const mockHandle = {
      kind: 'file',
      name: 'project.md',
    };

    // draft + handle + recent together
    const draft = await saveDraft('doc-1', '# Project', { name: 'project.md', hasHandle: true });
    assert(draft.id === 'doc-1', 'integration: draft saved');

    await saveHandle('doc-1', mockHandle, 'project.md');
    await addRecent('doc-1', 'project.md', true, 9);

    const d = await getDraft('doc-1');
    const h = await getHandle('doc-1');
    const r = await listRecent();
    assert(d.content === '# Project', 'integration: draft content correct');
    assert(h.name === 'project.md', 'integration: handle name correct');
    assert(r.length === 1 && r[0].name === 'project.md', 'integration: recent file correct');

    // clear all stores independently
    await resetDB();
    await saveDraft('d1', 'content', { name: 'a.md', hasHandle: false });
    await saveHandle('h1', mockHandle, 'b.md');
    await addRecent('r1', 'c.md', false, 100);

    await clearAllDrafts();
    assert((await listDrafts()).length === 0, 'integration: drafts cleared');
    assert((await getHandle('h1')) !== null, 'integration: handles NOT cleared');
    assert((await listRecent()).length === 1, 'integration: recent NOT cleared');

    await clearAllHandles();
    assert((await getHandle('h1')) === null, 'integration: handles cleared');

    await clearRecent();
    assert((await listRecent()).length === 0, 'integration: recent cleared');
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
