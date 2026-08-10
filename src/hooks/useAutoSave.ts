import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { getEffectiveAutoSaveInterval } from '../lib/constants';
import {
  isExtension,
  isIframe,
  writeFile,
  saveInlineToOriginal,
  isInteractiveInlineSaveInFlight,
} from '../lib/platform';

/** 内容变化后快速保存的防抖时长（ms） */
const QUICK_SAVE_DELAY = 3000;

/**
 * Auto-save hook.
 *
 * 双产物线：
 * - 插件版：IndexedDB 草稿自动保存（无感无需授权）+ 显式"保存到磁盘"用 platform.writeFile
 * - 桌面版：invoke('write_file') 写原文件（保留原逻辑）
 *
 * 三态状态数据层（Q26）：dirty / draft-saved / disk-saved，供 StatusBar UI 展示。
 *
 * v0.2.1（自动保存频率可配）：
 * - 间隔由 `settings.autoSaveInterval` 决定，**它是自动保存开关的唯一真源**
 *   （0 = 关闭）。store 里原来那个非持久化的 `autoSaveEnabled` boolean 已移除，
 *   避免「设置里选了 OFF、重启后勾选框又自己勾上」这类双状态源不一致。
 * - 关闭时**周期保存与 3s 快捷保存一并停**：用户既然说了不自动保存，
 *   后台就不应再落盘。
 * - inline（iframe）模式对间隔取 15s 下限护栏：桥接静默保存超时 15s，
 *   更短的间隔会让在途请求叠加堆积。
 */
export function useAutoSave() {
  const autoSaveInterval = useAppStore((s) => s.settings.autoSaveInterval);
  // 实际生效间隔（inline 模式下有 15s 下限）；0 = 关闭
  const effectiveInterval = getEffectiveAutoSaveInterval(
    autoSaveInterval,
    isExtension && isIframe,
  );
  const autoSaveEnabled = effectiveInterval > 0;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSavedHash = useRef<string>('');

  /**
   * 插件版自动保存（按用户规则 v0.1.8）：
   * - 没有修改（isDirty=false）→ 不保存，状态不动（打开文件未编辑不触发保存）
   * - 有句柄（应用内打开的文件）→ 写回磁盘原文件，不存草稿
   * - 有路径无句柄（浏览器打开的文件）→ 不存草稿；修改后自动保存时
   *   查缓存句柄直写，无缓存则弹一次"定位原文件"拿句柄写回原路径，之后直写
   * - 无路径（新建文档）→ 存临时草稿
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
      const { generateFileId, writeFile: writeFileSafe, pickOriginalFileHandle } = await import('../lib/platform');

      // 确保 draftId（句柄缓存键）
      let draftId = state.draftId;
      if (!draftId) {
        draftId = generateFileId(state.filePath || state.fileName);
        state.setDraftId(draftId);
      }

      // 有句柄 → 写回磁盘原文件（不存草稿）
      if (state.fileHandle) {
        try {
          await writeFileSafe(state.fileHandle, state.content);
          lastSavedHash.current = contentHash;
          state.setDirty(false);
          state.setSaveState('disk-saved');
          state.setDiskWriteFailed(false);
          return;
        } catch (err) {
          // 写盘失败（权限过期等）→ 草稿兜底防丢 + 标记
          console.warn('[AutoSave] Disk write failed:', err);
          state.setDiskWriteFailed(true);
        }
      }

      // inline editor（iframe 模式）：桥接父页面静默直写原文件。
      // silentOnly=true —— 只有用户此前已授权过（会话内有句柄）才写，
      // 未授权时什么都不做，绝不在自动保存时弹授权遮罩打断编辑。
      if (state.filePath && isIframe) {
        // 并发抑制：用户主动触发的显式 Save 可能正停在系统文件选择框 / Chrome
        // 授权提示上（冷启动首存尤其久）。此时插一条静默保存毫无意义——冷启动
        // 此刻必然还没有授权句柄，只会换回一条 needsAuth。让位给正在进行的显式
        // 保存：保持 dirty，由它写盘并更新状态。
        if (isInteractiveInlineSaveInFlight()) return;
        const res = await saveInlineToOriginal(
          state.content,
          state.fileName,
          state.filePath,
          { silentOnly: true },
        );
        if (res.ok) {
          lastSavedHash.current = contentHash;
          state.setDirty(false);
          state.setSaveState('disk-saved');
          state.setDiskWriteFailed(false);
        }
        return;
      }

      // 有路径无句柄（浏览器打开的文件）：修改后保存到原路径（不存草稿）
      if (state.filePath) {
        const { getHandle, saveHandle } = await import('../lib/indexeddb');
        let handle: unknown = null;
        try {
          const cached = await getHandle(draftId);
          handle = cached?.handle ?? null;
        } catch {
          // ignore
        }
        if (!handle) {
          // 首次：弹一次选择器让用户定位原文件，拿到写回原路径的句柄
          handle = await pickOriginalFileHandle();
          if (!handle) return; // 用户取消 → 本次不保存（保持 dirty，下次再试/手动保存）
          saveHandle(draftId, handle as FileSystemFileHandle, state.fileName).catch(() => {});
        }
        try {
          await writeFileSafe(handle, state.content);
          lastSavedHash.current = contentHash;
          state.setDirty(false);
          state.setSaveState('disk-saved');
          state.setDiskWriteFailed(false);
          return;
        } catch (err) {
          console.warn('[AutoSave] write-back to original path failed:', err);
          state.setDiskWriteFailed(true);
        }
      }

      // 无路径（新建文档）→ 存临时草稿
      const { saveDraft, addRecent } = await import('../lib/indexeddb');
      await saveDraft(draftId, state.content, {
        name: state.fileName,
        hasHandle: !!state.fileHandle,
        filePath: state.filePath || undefined,
      });

      lastSavedHash.current = contentHash;
      state.setSaveState('draft-saved');

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

    // interval = 0（用户选了「不自动保存」）→ 不建定时器，完全不落盘
    if (!autoSaveEnabled) return;

    // 定时器常驻：每 effectiveInterval 检查一次（performSave 内部通过 contentHash
    // 跳过空内容/重复内容）。不依赖 filePath/content——新建文档输入内容后
    // 也能在下一个周期自动保存（修复：new 后 interval 被清导致草稿不保存）
    intervalRef.current = setInterval(performSave, effectiveInterval);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoSaveEnabled, effectiveInterval, performSave]);

  // 内容变化后快速保存（防抖 3s）：避免等待整个周期——编辑后停顿几秒即落盘/存草稿，
  // 刷新或关闭标签页时内容基本已保存（performSave 内部有 isDirty + contentHash 检查，无修改不动作）。
  // 自动保存关闭时一并停：用户明确表示不要自动落盘。
  const quickSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleQuickSave = useCallback(() => {
    if (quickSaveTimer.current) {
      clearTimeout(quickSaveTimer.current);
      quickSaveTimer.current = null;
    }
    if (!autoSaveEnabled) return;
    quickSaveTimer.current = setTimeout(() => {
      quickSaveTimer.current = null;
      performSave();
    }, QUICK_SAVE_DELAY);
  }, [autoSaveEnabled, performSave]);

  // 卸载 / 关闭自动保存时清掉在途的快捷保存定时器，避免关掉开关后还落一次盘
  useEffect(() => {
    if (autoSaveEnabled) return;
    if (quickSaveTimer.current) {
      clearTimeout(quickSaveTimer.current);
      quickSaveTimer.current = null;
    }
  }, [autoSaveEnabled]);

  useEffect(() => () => {
    if (quickSaveTimer.current) {
      clearTimeout(quickSaveTimer.current);
      quickSaveTimer.current = null;
    }
  }, []);

  return { saveNow, scheduleQuickSave };
}
