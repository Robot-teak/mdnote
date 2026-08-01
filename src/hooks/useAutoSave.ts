import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { AUTO_SAVE_INTERVAL } from '../lib/constants';
import { isExtension, writeFile } from '../lib/platform';

/**
 * Auto-save hook.
 *
 * 双产物线：
 * - 插件版：IndexedDB 草稿自动保存（60s 间隔，无感无需授权）+ 显式"保存到磁盘"用 platform.writeFile
 * - 桌面版：60s invoke('write_file') 写原文件（保留原逻辑）
 *
 * 三态状态数据层（Q26）：dirty / draft-saved / disk-saved，供 StatusBar UI 展示。
 */
export function useAutoSave() {
  const autoSaveEnabled = useAppStore((s) => s.autoSaveEnabled);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSavedHash = useRef<string>('');

  /**
   * 插件版自动保存（按用户规则）：
   * - 没有修改（isDirty=false）→ 不保存，状态不动（打开文件未编辑不触发保存）
   * - 有句柄（应用内打开的文件）→ 写回磁盘原文件，不存草稿
   * - 写盘失败 → 降级存草稿兜底 + 标记磁盘写入失败（防内容丢失）
   * - 无句柄且无本地路径（新建文档）→ 存临时草稿
   * - 无句柄但有路径（浏览器打开的 file://）→ 不存草稿，保持待保存状态
   */
  const saveDraftToIndexedDB = useCallback(async () => {
    const state = useAppStore.getState();
    if (!state.content) return;
    // 核心：没修改就不保存（打开文件什么都没做，不触发任何保存动作）
    if (!state.isDirty) return;

    // 用内容哈希跳过重复保存
    const contentHash = state.content.length + ':' + state.content.slice(0, 64);
    if (contentHash === lastSavedHash.current) return;

    try {
      // 有句柄 → 写回磁盘原文件（有路径的文件不乱存草稿）
      if (state.fileHandle) {
        try {
          await writeFile(state.fileHandle, state.content);
          lastSavedHash.current = contentHash;
          state.setDirty(false);
          state.setSaveState('disk-saved');
          state.setDiskWriteFailed(false);
          return;
        } catch (err) {
          // 写盘失败（权限过期等）→ 草稿兜底防丢 + 提示重新授权
          console.warn('[AutoSave] Disk write failed, saving draft fallback:', err);
          state.setDiskWriteFailed(true);
        }
      }

      // 仅"无本地路径"的新建文档才存临时草稿（用户规则 2）
      if (state.filePath) {
        // 有路径但无句柄（如浏览器打开的文件）→ 不存草稿，保持编辑状态
        return;
      }

      const { generateFileId } = await import('../lib/platform');
      const { saveDraft, addRecent } = await import('../lib/indexeddb');

      let draftId = state.draftId;
      if (!draftId) {
        draftId = generateFileId(state.filePath || state.fileName);
        state.setDraftId(draftId);
      }

      await saveDraft(draftId, state.content, {
        name: state.fileName,
        hasHandle: false,
        filePath: undefined,
      });

      lastSavedHash.current = contentHash;
      state.setSaveState('draft-saved');

      addRecent(draftId, state.fileName, false, state.content.length).catch(() => {});
    } catch (err) {
      console.error('[AutoSave/Draft] Failed:', err);
      // IndexedDB 失败不影响编辑，状态保持 dirty
    }
  }, []);

  /**
   * 桌面版：保存到磁盘文件（原逻辑）。
   */
  const performDesktopSave = useCallback(async () => {
    const state = useAppStore.getState();
    if (!state.filePath || !state.isDirty) return;

    const contentHash = state.content.length + ':' + state.content.slice(0, 64);
    if (contentHash === lastSavedHash.current) return;

    try {
      await writeFile(state.filePath, state.content);
      lastSavedHash.current = contentHash;
      state.setDirty(false);
      state.setSaveState('disk-saved');
    } catch (err) {
      console.error('[AutoSave/Desktop] Failed:', err);
    }
  }, []);

  /** 自动保存执行函数（根据模式切换） */
  const performSave = useCallback(async () => {
    if (isExtension) {
      await saveDraftToIndexedDB();
    } else {
      await performDesktopSave();
    }
  }, [saveDraftToIndexedDB, performDesktopSave]);

  /**
   * 手动保存（⌘S）— 即使 isDirty 为 false 也执行保存。
   * 插件版：有句柄写磁盘，无句柄保存草稿
   * 桌面版：写磁盘文件
   */
  const saveNow = useCallback(async () => {
    const state = useAppStore.getState();
    if (isExtension) {
      // 插件版：有句柄 → 写磁盘；无句柄 → 保存草稿
      if (state.fileHandle) {
        try {
          await writeFile(state.fileHandle, state.content);
          const contentHash = state.content.length + ':' + state.content.slice(0, 64);
          lastSavedHash.current = contentHash;
          state.setDirty(false);
          state.setSaveState('disk-saved');
          state.setDiskWriteFailed(false); // 清除失败标志
        } catch (err) {
          // Q21 降级：权限失效 → 保存草稿
          console.error('[Save] Disk save failed, falling back to draft:', err);
          state.setDiskWriteFailed(true); // 标记磁盘写入失败（S22 区分正常草稿保存与权限失效）
          await saveDraftToIndexedDB();
        }
      } else {
        // 无句柄 → 保存草稿
        await saveDraftToIndexedDB();
      }
      return;
    }

    // 桌面版
    if (!state.filePath) return;
    try {
      await writeFile(state.filePath, state.content);
      const contentHash = state.content.length + ':' + state.content.slice(0, 64);
      lastSavedHash.current = contentHash;
      state.setDirty(false);
      state.setSaveState('disk-saved');
    } catch (err) {
      console.error('[Save] Failed:', err);
    }
  }, [saveDraftToIndexedDB]);

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (!autoSaveEnabled) return;

    // 定时器常驻：每 60s 检查一次（performSave 内部通过 contentHash 跳过
    // 空内容/重复内容）。不依赖 filePath/content——新建文档输入内容后
    // 也能在下一个周期自动保存（修复：new 后 interval 被清导致草稿不保存）
    intervalRef.current = setInterval(performSave, AUTO_SAVE_INTERVAL);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoSaveEnabled, performSave]);

  // 内容变化后快速保存（防抖 3s）：避免等待 60s 周期——编辑后停顿几秒即落盘/存草稿，
  // 刷新或关闭标签页时内容基本已保存（performSave 内部有 isDirty + contentHash 检查，无修改不动作）
  const quickSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleQuickSave = useCallback(() => {
    if (!autoSaveEnabled) return;
    if (quickSaveTimer.current) clearTimeout(quickSaveTimer.current);
    quickSaveTimer.current = setTimeout(() => {
      quickSaveTimer.current = null;
      performSave();
    }, 3000);
  }, [autoSaveEnabled, performSave]);

  return { saveNow, scheduleQuickSave };
}
