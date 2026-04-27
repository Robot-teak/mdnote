import { useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { TocItem } from '../types';
import { renderMarkdown, extractTocFromWorker } from '../lib/markdown-parser';
import { useToast as useToastComp } from '../components/Toast';

/**
 * File operation hooks: open, new, save-as, and preview rendering.
 * 
 * NOTE: @tauri-apps/api uses dynamic import() to avoid top-level initialization
 * that causes white-screen issues in Tauri 2 WKWebView.
 */
export function useFileOps() {
  const { showToast } = useToastComp();
  const {
    setContent,
    setFilePath,
    setDirty,
    resetState,
    setHtmlPreview,
    setIsPreviewLoading,
    setTocItems,
  } = useAppStore();

  /**
   * Open a file: show system dialog, read via Rust IPC, populate editor + preview.
   */
  const openFile = useCallback(async () => {
    try {
      // 动态 import Tauri API
      const { invoke } = await import('@tauri-apps/api/core');
      
      const path = await invoke<string | null>('open_dialog');
      if (!path) return; // User cancelled

      setIsPreviewLoading(true);
      const fileContent = await invoke<string>('read_file', { path });

      // Update store
      setFilePath(path);
      setContent(fileContent);
      setDirty(false);
      // 打开文件默认使用预览模式
      const { setViewMode } = useAppStore.getState();
      setViewMode('preview');

      // Render preview in worker
      const html = await renderMarkdown(fileContent);
      setHtmlPreview(html);

      // Extract TOC
      const tocItems: TocItem[] = await extractTocFromWorker(fileContent);
      setTocItems(tocItems);
    } catch (err) {
      showToast('Failed to open file', 'error');
      setIsPreviewLoading(false);
    }
  }, [setContent, setFilePath, setDirty, setHtmlPreview, setIsPreviewLoading, setTocItems, showToast]);

  /**
   * Create new blank document.
   * resetState sets isWelcome=false, so the editor will show.
   */
  const newDocument = useCallback(() => {
    resetState();
    setHtmlPreview('');
    setTocItems([]);
  }, [resetState, setHtmlPreview, setTocItems]);

  /**
   * Save As: show dialog, then write to chosen location.
   */
  const saveAs = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      
      const fileName =
        useAppStore.getState().fileName !== 'Untitled'
          ? useAppStore.getState().fileName
          : 'untitled.md';

      console.log('[MDnote] saveAs: opening dialog, defaultName:', fileName);
      const path = await invoke<string | null>('save_dialog', { defaultName: fileName });
      console.log('[MDnote] saveAs: dialog returned path:', path);
      if (!path) return;

      const currentContent = useAppStore.getState().content;
      console.log('[MDnote] saveAs: writing to path:', path, 'content length:', currentContent.length);
      await invoke('write_file', { path, content: currentContent });
      setFilePath(path);
      setDirty(false);
      showToast('File saved!', 'success');
    } catch (err) {
      console.error('[MDnote] saveAs failed:', err);
      showToast('Failed to save file: ' + String(err), 'error');
    }
  }, [setFilePath, setDirty, showToast]);

  /**
   * Direct save to existing file path (no dialog).
   */
  const directSave = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const state = useAppStore.getState();
      
      if (!state.filePath) return false;
      await invoke('write_file', { path: state.filePath, content: state.content });
      setDirty(false);
      return true;
    } catch (err) {
      showToast('Failed to save file', 'error');
      return false;
    }
  }, [setDirty, showToast]);

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
        setTocItems(toc);
      } catch (err) {
        showToast('Failed to render preview', 'error');
        setIsPreviewLoading(false);
      }
    },
    [setHtmlPreview, setTocItems, setIsPreviewLoading, showToast],
  );

  return { openFile, newDocument, saveAs, directSave, updatePreview };
}
