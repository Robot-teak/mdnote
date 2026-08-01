import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useToast } from './Toast';
import { isExtension } from '../lib/platform';
import type { DraftRecord } from '../lib/indexeddb';

/**
 * 草稿恢复提示条（#3 测试反馈：自动保存后关闭找不到内容）。
 *
 * 插件版欢迎页（isWelcome）时检测 IndexedDB 中"无磁盘句柄"的最新草稿
 * （新建文档/无法写盘的文档，最容易丢失），提示用户恢复或丢弃。
 * 有句柄的草稿可通过左侧栏"最近文件"恢复，不在此打扰。
 *
 * 判据：最新草稿内容非空 && 无句柄 && 更新于 24 小时内。
 */
export default function DraftRecoveryBar() {
  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const { showToast } = useToast();

  // 欢迎页时检测未保存草稿
  useEffect(() => {
    if (!isExtension) return;
    let cancelled = false;
    (async () => {
      try {
        const { listDrafts } = await import('../lib/indexeddb');
        const drafts = await listDrafts();
        if (cancelled || drafts.length === 0) return;
        const latest = drafts[0];
        // 只提示：无句柄（纯草稿）且内容非空且 24 小时内更新
        if (latest.meta.hasHandle) return;
        if (!latest.content || latest.content.trim().length === 0) return;
        if (Date.now() - latest.updatedAt > 24 * 60 * 60 * 1000) return;
        setDraft(latest);
      } catch {
        // 忽略 IndexedDB 错误
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 恢复草稿到编辑器 */
  const handleRestore = useCallback(async () => {
    if (!draft) return;
    try {
      const state = useAppStore.getState();
      state.setContent(draft.content);
      state.setFilePath(draft.meta.filePath ?? draft.meta.name);
      state.setDraftId(draft.id);
      state.setDirty(false);
      state.setSaveState('draft-saved');
      state.setViewMode('preview');

      const { renderMarkdown, extractTocFromWorker } = await import('../lib/markdown-parser');
      const [html, toc] = await Promise.all([
        renderMarkdown(draft.content),
        extractTocFromWorker(draft.content),
      ]);
      state.setHtmlPreview(html);
      state.setTocItems(toc);
      showToast('Draft restored — remember to Save to keep it on disk', 'success');
    } catch (err) {
      console.error('[MDnote] Draft restore failed:', err);
      showToast('Failed to restore draft', 'error');
    }
  }, [draft, showToast]);

  /** 丢弃草稿 */
  const handleDiscard = useCallback(async () => {
    if (!draft) return;
    try {
      const { deleteDraft } = await import('../lib/indexeddb');
      await deleteDraft(draft.id);
      setDraft(null);
      showToast('Draft discarded', 'info');
    } catch (err) {
      console.error('[MDnote] Draft discard failed:', err);
    }
  }, [draft, showToast]);

  if (!draft) return null;

  const timeStr = new Date(draft.updatedAt).toLocaleString();

  return (
    <div className="draft-recovery-bar" role="alert">
      <span className="draft-recovery-icon">📝</span>
      <span className="draft-recovery-text">
        检测到未保存的草稿：<strong>{draft.meta.name}</strong>
        <span className="draft-recovery-time">（{timeStr}）</span>
        <span className="draft-recovery-hint">草稿仅保存在浏览器本地，尚未写入磁盘文件</span>
      </span>
      <span className="draft-recovery-actions">
        <button className="draft-recovery-btn primary" onClick={handleRestore}>
          恢复草稿
        </button>
        <button className="draft-recovery-btn" onClick={handleDiscard}>
          丢弃
        </button>
      </span>
    </div>
  );
}
