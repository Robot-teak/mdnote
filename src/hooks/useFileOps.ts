import { useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { TocItem } from '../types';
import { renderMarkdown, extractTocFromWorker } from '../lib/markdown-parser';
import { useToast as useToastComp } from '../components/Toast';
import {
  isExtension,
  isDesktop,
  openDialog,
  saveDialog,
  writeFile,
} from '../lib/platform';
import { acquireFileLock, releaseFileLock, isFileLocked, openEditorInNewTab } from '../lib/messaging';

/**
 * File operation hooks: open, new, save-as, and preview rendering.
 *
 * 双产物线：通过 platform.ts 切换 Tauri invoke（桌面版）/ File System Access API（插件版）。
 * 桌面版逻辑完整保留不破坏。
 */

/** 判断当前窗口是否已加载文档（决定 New/Open 是复用窗口还是开新窗口/新标签页） */
function hasDocumentLoaded(): boolean {
  const state = useAppStore.getState();
  return !state.isWelcome && (state.filePath !== null || state.content.length > 0);
}

/**
 * 判断 New/Open 是否应在新窗口（桌面版）/ 新标签页（插件版）打开。
 * - 桌面版：多窗口，已加载文档时开新窗口
 * - 插件版：多标签页，已加载文档时开新标签页（#4，不替换当前内容）
 */
function shouldOpenNewWindow(): boolean {
  return hasDocumentLoaded();
}

export function useFileOps() {
  const { showToast } = useToastComp();
  const {
    setContent,
    setFilePath,
    setFileHandle,
    setDraftId,
    setDirty,
    setSaveState,
    resetState,
    setHtmlPreview,
    setIsPreviewLoading,
    setTocItems,
  } = useAppStore();

  /**
   * Open a file: show dialog, read content, populate editor + preview.
   * 插件版：File System Access API + 句柄存储 IndexedDB
   * 桌面版：Tauri invoke + 多窗口支持
   */
  const openFile = useCallback(async () => {
    try {
      const result = await openDialog();
      if (!result) return; // User cancelled

      // 当前窗口有文档 → 新窗口（桌面版）/ 新标签页（插件版）打开，不替换当前内容（#4）
      if (shouldOpenNewWindow()) {
        if (useAppStore.getState().filePath === result.path) {
          return; // 同一文件跳过
        }
        const theme = useAppStore.getState().theme;
        if (isDesktop) {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('open_file_in_new_window', { path: result.path, theme });
          return;
        }
        // 插件版：暂存文件数据（内容 + 句柄），让新标签页恢复
        try {
          const { generateFileId } = await import('../lib/platform');
          const { saveDraft, saveHandle } = await import('../lib/indexeddb');
          const draftId = generateFileId(result.path);
          await saveDraft(draftId, result.content, {
            name: result.name,
            hasHandle: !!result.handle,
            filePath: result.path,
          });
          if (result.handle) {
            await saveHandle(draftId, result.handle as FileSystemFileHandle, result.name);
          }
          if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            await chrome.storage.local.set({
              'mdnote-pending-open': {
                draftId,
                name: result.name,
                path: result.path,
                createdAt: Date.now(),
              },
            });
          }
          await openEditorInNewTab();
        } catch (err) {
          console.error('[MDnote] Failed to hand off file to new tab:', err);
          showToast('Failed to open in new tab', 'error');
        }
        return;
      }

      setIsPreviewLoading(true);

      // S19 文件锁：释放前一个文件的锁
      if (isExtension) {
        const prevDraftId = useAppStore.getState().draftId;
        if (prevDraftId) {
          await releaseFileLock(prevDraftId).catch(() => {});
        }
      }

      // 更新 store
      setFilePath(result.path);
      setContent(result.content);
      setFileHandle(result.handle);
      setDirty(false);
      setSaveState('disk-saved');

      // 插件版：生成 draftId 并保存到 IndexedDB
      if (isExtension && result.handle) {
        const { generateFileId } = await import('../lib/platform');
        const { saveHandle, addRecent } = await import('../lib/indexeddb');
        const draftId = generateFileId(result.path);
        setDraftId(draftId);
        // 存储句柄到 IndexedDB（结构化克隆）
        saveHandle(draftId, result.handle as FileSystemFileHandle, result.name).catch(() => {});
        addRecent(draftId, result.name, true, result.content.length).catch(() => {});

        // S19 文件锁：尝试获取写锁
        const lockAcquired = await acquireFileLock(draftId);
        if (!lockAcquired) {
          showToast('File is open in another tab — opening read-only', 'warning');
        }
      }

      // 打开文件默认使用预览模式
      const { setViewMode } = useAppStore.getState();
      setViewMode('preview');

      // Render preview in worker
      const html = await renderMarkdown(result.content);
      setHtmlPreview(html);

      // Extract TOC
      const tocItems: TocItem[] = await extractTocFromWorker(result.content);
      setTocItems(tocItems);
    } catch (err) {
      // Q21 降级闭环：用户拒绝授权 → 自动转草稿模式
      if (isExtension && err instanceof DOMException && err.name === 'AbortError') {
        showToast('File open cancelled', 'info');
      } else {
        showToast('Failed to open file', 'error');
      }
      setIsPreviewLoading(false);
    }
  }, [setContent, setFilePath, setFileHandle, setDraftId, setDirty, setSaveState, setHtmlPreview, setIsPreviewLoading, setTocItems, showToast]);

  /**
   * 通过内容打开文件（插件版拖拽 / chrome.runtime.onMessage）。
   * @param content 文件内容
   * @param name 文件名
   */
  const openFileByContent = useCallback(async (content: string, name: string) => {
    try {
      setIsPreviewLoading(true);
      setFilePath(name);
      setContent(content);
      setFileHandle(null);
      setDirty(false);
      setSaveState('disk-saved');

      // 插件版：记录到最近文件（#3：拖拽/草稿恢复打开的文件也要能在最近列表找回）
      if (isExtension) {
        const { generateFileId } = await import('../lib/platform');
        const { addRecent } = await import('../lib/indexeddb');
        const draftId = generateFileId(name);
        addRecent(draftId, name, false, content.length).catch(() => {});
      }

      const { setViewMode } = useAppStore.getState();
      setViewMode('preview');

      const [html, tocItems] = await Promise.all([
        renderMarkdown(content),
        extractTocFromWorker(content),
      ]);
      setHtmlPreview(html);
      setTocItems(tocItems);
    } catch (err) {
      showToast('Failed to open file', 'error');
      setIsPreviewLoading(false);
    }
  }, [setContent, setFilePath, setFileHandle, setDirty, setSaveState, setHtmlPreview, setIsPreviewLoading, setTocItems, showToast]);

  /**
   * Create new blank document.
   * 桌面版：当前窗口有内容时开新窗口
   * 插件版：当前窗口有文档时开新标签页（#4，不替换当前内容）；欢迎页/空文档时直接新建
   */
  const newDocument = useCallback(async () => {
    if (shouldOpenNewWindow()) {
      if (isDesktop) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const theme = useAppStore.getState().theme;
          await invoke('create_new_window', { theme });
        } catch (err) {
          console.error('[MDnote] Failed to create new window:', err);
        }
      } else {
        // 插件版：开新标签页（空白编辑器），当前窗口内容不受影响
        await openEditorInNewTab();
      }
      return;
    }
    // S19 文件锁：释放当前文件的锁
    if (isExtension) {
      const currentDraftId = useAppStore.getState().draftId;
      if (currentDraftId) {
        await releaseFileLock(currentDraftId).catch(() => {});
      }
    }
    resetState();
    setFileHandle(null);
    setDraftId(null);
    setHtmlPreview('');
    setTocItems([]);
  }, [resetState, setFileHandle, setDraftId, setHtmlPreview, setTocItems]);

  /**
   * Save As: show dialog, then write to chosen location.
   * 插件版：showSaveFilePicker + createWritable
   * 桌面版：invoke('save_dialog') + invoke('write_file')
   */
  const saveAs = useCallback(async () => {
    try {
      const fileName =
        useAppStore.getState().fileName !== 'Untitled'
          ? useAppStore.getState().fileName
          : 'untitled.md';

      const result = await saveDialog(useAppStore.getState().content, { suggestedName: fileName });
      if (!result) return;

      // 更新 store
      setFilePath(result.path);
      setFileHandle(result.handle);
      setDirty(false);
      setSaveState('disk-saved');

      // 插件版：保存句柄到 IndexedDB
      if (isExtension && result.handle) {
        const { generateFileId } = await import('../lib/platform');
        const { saveHandle, addRecent, deleteDraft, deleteHandle } = await import('../lib/indexeddb');
        const oldDraftId = useAppStore.getState().draftId;
        const draftId = oldDraftId || generateFileId(result.path);
        setDraftId(draftId);
        saveHandle(draftId, result.handle as FileSystemFileHandle, result.name).catch(() => {});
        addRecent(draftId, result.name, true, useAppStore.getState().content.length).catch(() => {});
        // 保存成功后清理旧草稿（如新建 Untitled 文档的临时草稿，#3 用户要求）
        if (oldDraftId && oldDraftId !== draftId) {
          deleteDraft(oldDraftId).catch(() => {});
          deleteHandle(oldDraftId).catch(() => {});
        }
      }

      showToast('File saved!', 'success');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return; // 用户取消
      }
      console.error('[MDnote] saveAs failed:', err);
      showToast('Failed to save file: ' + String(err), 'error');
    }
  }, [setFilePath, setFileHandle, setDraftId, setDirty, setSaveState, showToast]);

  /**
   * Direct save to existing file path/handle (no dialog).
   * 插件版：用句柄 createWritable 写回；无句柄则触发 saveAs
   * 桌面版：invoke('write_file')
   */
  const directSave = useCallback(async () => {
    try {
      const state = useAppStore.getState();

      // 插件版：有句柄直接写回，无句柄触发 saveAs
      if (isExtension) {
        if (state.fileHandle) {
          // S19 文件锁：检查是否被其他标签页锁定
          if (state.draftId) {
            const locked = await isFileLocked(state.draftId);
            if (locked) {
              showToast('File is locked by another tab — cannot save', 'error');
              return false;
            }
          }
          await writeFile(state.fileHandle, state.content);
          setDirty(false);
          setSaveState('disk-saved');
          useAppStore.getState().setDiskWriteFailed(false); // S22: 清除失败标志
          return true;
        }
        // 无句柄 → 另存为
        await saveAs();
        return true;
      }

      // 桌面版
      if (!state.filePath) return false;
      await writeFile(state.filePath, state.content);
      setDirty(false);
      setSaveState('disk-saved');
      return true;
    } catch (err) {
      // Q21 降级：权限失效 → 提示重新授权
      if (isExtension && err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        showToast('File permission expired. Please use "Save As" to re-authorize.', 'warning');
        // 降级为草稿模式
        setSaveState('draft-saved');
        useAppStore.getState().setDiskWriteFailed(true); // S22: 标记磁盘写入失败
        return false;
      }
      showToast('Failed to save file', 'error');
      return false;
    }
  }, [setDirty, setSaveState, saveAs, showToast]);

  /**
   * Render preview and TOC from current content.
   * Called by the EditorPane's onContentChange callback (debounced externally).
   */
  const updatePreview = useCallback(
    async (markdownContent: string) => {
      if (!markdownContent) {
        setHtmlPreview('');
        setTocItems([]);
        return;
      }

      try {
        setIsPreviewLoading(true);
        const [html, toc] = await Promise.all([
          renderMarkdown(markdownContent),
          extractTocFromWorker(markdownContent),
        ]);
        setHtmlPreview(html);
        // 等 React 渲染完成后恢复滚动位置
        const savedScroll = useAppStore.getState().savedScrollTop;
        if (savedScroll > 0) {
          requestAnimationFrame(() => {
            const el = document.querySelector('.preview-pane');
            if (el) el.scrollTop = savedScroll;
          });
        }
        setTocItems(toc);
      } catch (err) {
        showToast('Failed to render preview', 'error');
        setIsPreviewLoading(false);
      }
    },
    [setHtmlPreview, setTocItems, setIsPreviewLoading, showToast],
  );

  return { openFile, openFileByContent, newDocument, saveAs, directSave, updatePreview };
}
