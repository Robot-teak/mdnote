import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { AUTO_SAVE_INTERVAL } from '../lib/constants';

/**
 * Auto-save hook.
 * Only active when autoSaveEnabled is true.
 * When first enabled: saves immediately once, then every 60s.
 * Only saves when isDirty && filePath exists.
 * Does NOT re-trigger on every content change.
 */
export function useAutoSave() {
  const autoSaveEnabled = useAppStore((s) => s.autoSaveEnabled);
  const filePath = useAppStore((s) => s.filePath);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSavedHash = useRef<string>('');

  /** 实时从 store 读取状态并保存 — 不依赖 content，不会因打字而重建 */
  const performSave = useCallback(async () => {
    const state = useAppStore.getState();
    if (!state.filePath || !state.isDirty) return;

    // 用内容哈希跳过重复保存
    const contentHash = state.content.length + ':' + state.content.slice(0, 64);
    if (contentHash === lastSavedHash.current) return;

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('write_file', { path: state.filePath, content: state.content });
      lastSavedHash.current = contentHash;
      state.setDirty(false);
    } catch (err) {
      console.error('[AutoSave] Failed:', err);
    }
  }, []);

  /** 手动保存（⌘S） */
  const saveNow = useCallback(async () => {
    const state = useAppStore.getState();
    if (!state.filePath || !state.isDirty) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('write_file', { path: state.filePath, content: state.content });
      const contentHash = state.content.length + ':' + state.content.slice(0, 64);
      lastSavedHash.current = contentHash;
      state.setDirty(false);
    } catch (err) {
      console.error('[Save] Failed:', err);
    }
  }, []);

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (!autoSaveEnabled || !filePath) return;

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
  }, [autoSaveEnabled, filePath, performSave]);

  return { saveNow };
}
