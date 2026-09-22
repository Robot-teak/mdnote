import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useToast } from './Toast';
import type { DraftRecord } from '../lib/indexeddb';

/**
 * 首页未存档草稿列表（R6）。
 *
 * 插件版欢迎卡片内部展示 IndexedDB 中**从未保存到任何文件**的草稿：
 * 三列（Name / Last updated / Actions），每行 Restore / Discard 两个按钮。
 *
 * 与旧版 `DraftRecoveryBar`（顶部横幅，只显示最新 1 条）的差异：
 * 1. 形态由横幅改为表格列表，列出**全部**未存档草稿；
 * 2. 判据由「无句柄」升级为「无句柄 **且** 无路径」（`!hasHandle && !filePath`），
 *    其余记录（句柄写盘失败稿 / 有路径写回失败稿 / 新标签页交接暂存稿）
 *    在挂载时由 `purgeNonPureDrafts()` 一次性清理；
 * 3. 移除 24 小时过期判定 —— 只有用户手动 Discard 才会消失；
 * 4. 文案全英文（插件版红线）。
 *
 * 生效范围：插件版（桌面版草稿走 writeFile 直写磁盘，不进 IndexedDB）。
 */

/** `meta.name` 缺失时的兜底显示名 */
const FALLBACK_NAME = 'Untitled.md';

/** 底部说明文案（英文） */
const LIST_NOTE =
  'These drafts are stored in this browser only — they have never been saved to a file.';

/**
 * 会话级标记：启动清理每个会话只执行一次。
 * 组件会因「恢复草稿 → 回到首页」而重复挂载，清理一次即可。
 */
let hasPurgedThisSession = false;

/**
 * 是否为「纯草稿」：从未保存到任何文件（无句柄、无路径）。
 * @param record 草稿记录
 */
function isPureDraft(record: DraftRecord): boolean {
  return !record.meta.hasHandle && !record.meta.filePath;
}

/**
 * 是否应出现在列表中：纯草稿且内容非空。
 * @param record 草稿记录
 */
function isListableDraft(record: DraftRecord): boolean {
  return isPureDraft(record) && record.content.trim().length > 0;
}

/**
 * 启动时清理非纯草稿（PRD §6.2 / D8）。
 *
 * 判据：`meta.hasHandle === true || meta.filePath` 非空 → 删除。
 * 逐条 `deleteDraft()` 并发执行，`Promise.allSettled` 兜底，
 * 失败**静默**（不 toast、不阻断列表渲染），下一轮挂载再清。
 */
async function purgeNonPureDrafts(): Promise<void> {
  try {
    const { listDrafts, deleteDraft } = await import('../lib/indexeddb');
    const all = await listDrafts();
    const stale = all.filter((record) => !isPureDraft(record));
    if (stale.length === 0) return;
    await Promise.allSettled(stale.map((record) => deleteDraft(record.id)));
  } catch {
    // 静默：IndexedDB 不可用时不阻断首页
  }
}

export default function DraftRecoveryList() {
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  /** 正在操作的行 ID（用于该行按钮置灰防连点） */
  const [busyId, setBusyId] = useState<string | null>(null);
  const { showToast } = useToast();

  /** 重新拉取列表（保持 updatedAt 倒序，由 listDrafts 游标保证） */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { listDrafts } = await import('../lib/indexeddb');
      const all = await listDrafts();
      setDrafts(all.filter(isListableDraft));
    } catch {
      // 静默：listDrafts 抛错时整块不渲染
      setDrafts([]);
    }
  }, []);

  // 挂载：先清理非纯草稿（静默），再拉取列表
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!hasPurgedThisSession) {
        hasPurgedThisSession = true;
        await purgeNonPureDrafts();
      }
      if (cancelled) return;
      await refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  /** 恢复草稿到编辑器（不删除草稿，下次首页仍可见） */
  const handleRestore = useCallback(
    async (record: DraftRecord): Promise<void> => {
      setBusyId(record.id);
      try {
        const state = useAppStore.getState();
        state.setContent(record.content);
        state.setFilePath(record.meta.filePath ?? record.meta.name ?? FALLBACK_NAME);
        state.setDraftId(record.id);
        state.setDirty(false);
        state.setSaveState('draft-saved');
        state.setViewMode('preview');

        const { renderMarkdown, extractTocFromWorker } = await import('../lib/markdown-parser');
        const [html, toc] = await Promise.all([
          renderMarkdown(record.content),
          extractTocFromWorker(record.content),
        ]);
        state.setHtmlPreview(html);
        state.setTocItems(toc);
        showToast('Draft restored — remember to Save to keep it on disk', 'success');
      } catch (err) {
        console.error('[MDnote] Draft restore failed:', err);
        showToast('Failed to restore draft', 'error');
      } finally {
        setBusyId(null);
      }
    },
    [showToast],
  );

  /** 丢弃草稿（无二次确认：点击即删 + toast，失败则该行保留） */
  const handleDiscard = useCallback(
    async (record: DraftRecord): Promise<void> => {
      setBusyId(record.id);
      try {
        const { deleteDraft } = await import('../lib/indexeddb');
        await deleteDraft(record.id);
        showToast('Draft discarded', 'info');
        await refresh();
      } catch (err) {
        console.error('[MDnote] Draft discard failed:', err);
        showToast('Failed to discard draft', 'error');
      } finally {
        setBusyId(null);
      }
    },
    [refresh, showToast],
  );

  // 无草稿（或加载中 / listDrafts 抛错）→ 整块不渲染
  if (drafts.length === 0) return null;

  return (
    <section className="draft-list" aria-label="Unsaved drafts">
      <h3 className="draft-list-title">Unsaved Drafts</h3>

      <div className="draft-table-wrap">
        <table className="draft-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Last updated</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((record) => {
              const name = record.meta.name || FALLBACK_NAME;
              const timeStr = new Date(record.updatedAt).toLocaleString();
              const isBusy = busyId === record.id;
              return (
                <tr key={record.id}>
                  <td className="draft-cell-name" title={name}>
                    {name}
                  </td>
                  <td className="draft-cell-time" title={timeStr}>
                    {timeStr}
                  </td>
                  <td className="draft-cell-actions">
                    <button
                      type="button"
                      className="draft-btn primary"
                      onClick={() => void handleRestore(record)}
                      disabled={isBusy}
                      aria-label={`Restore "${name}"`}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      className="draft-btn"
                      onClick={() => void handleDiscard(record)}
                      disabled={isBusy}
                      aria-label={`Discard "${name}"`}
                    >
                      Discard
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="draft-list-note">{LIST_NOTE}</p>
    </section>
  );
}
