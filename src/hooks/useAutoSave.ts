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
  const filePath = useAppStore((s) => s.filePath);
  const fileHandle = useAppStore((s) => s.fileHandle);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSavedHash = useRef<string>('');

  /**
   * 插件版：自动保存。
   * 1) 有磁盘句柄且权限有效 → 直接写回原文件（用户期望"自动保存=保存到原文件"）
   * 2) 无句柄/写盘失败 → 降级保存草稿到 IndexedDB（权限过期时提示重新授权）
   */
  const saveDraftToIndexedDB = useCallback(async () => {
    const state = useAppStore.getState();
    if (!state.content) return;

    // 用内容哈希跳过重复保存
    const contentHash = state.content.length + ':' + state.content.slice(0, 64);
    if (contentHash === lastSavedHash.current) return;

    try {
      const { generateFileId } = await import('../lib/platform');

      // 使用已有 draftId 或生成新的（以路径为种子，确保确定性、避免重复记录）
      let draftId = state.draftId;
      if (!draftId) {
        draftId = generateFileId(state.filePath || state.fileName);
        state.setDraftId(draftId);
      }

      // 有句柄 → 尝试直接写回磁盘原文件（用户期望：自动保存 = 保存到原文件）
      if (state.fileHandle) {
        try {
          await writeFile(state.fileHandle, state.content);
          lastSavedHash.current = contentHash;
          state.setDirty(false);
          state.setSaveState('disk-saved');
          state.setDiskWriteFailed(false);
          return; // 磁盘已保存，无需再存草稿
        } catch (err) {
          // 写盘失败（权限过期/被占用等）→ 降级草稿 + 标记磁盘写入失败
          console.warn('[AutoSave] Disk write failed, falling back to draft:', err);
          state.setDiskWriteFailed(true);
        }
      }

      // 降级：保存草稿到 IndexedDB
      const { saveDraft, addRecent } = await import('../lib/indexeddb');
      await saveDraft(draftId, state.content, {
        name: state.fileName,
        hasHandle: !!state.fileHandle,
        filePath: state.filePath || undefined,
      });

      lastSavedHash.current = contentHash;
      // 更新保存状态：草稿已保存到 IndexedDB（磁盘文件未更新，为 draft-saved）
      state.setSaveState('draft-saved');

      // 更新最近文件列表
      addRecent(draftId, state.fileName, !!state.fileHandle, state.content.length).catch(() => {});
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

    // 插件版：只要有内容就自动保存草稿（不需要 filePath）
    // 桌面版：需要 filePath 才保存
    const shouldAutoSave = isExtension
      ? (autoSaveEnabled && useAppStore.getState().content.length > 0)
      : (autoSaveEnabled && !!filePath);

    if (!shouldAutoSave) return;

    // 开启时立即保存一次
    performSave();

    // 之后每 60 秒保存一次
    intervalRef.current = setInterval(performSave, AUTO_SAVE_INTERVAL);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoSaveEnabled, filePath, fileHandle, performSave]);

  return { saveNow };
}
