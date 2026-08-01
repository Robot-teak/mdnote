import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { isExtension } from '../lib/platform';
import { releaseAllLocks } from '../lib/messaging';

/**
 * Hook to prevent window/tab close when there are unsaved changes.
 *
 * 双产物线：
 * - 插件版：window.addEventListener('beforeunload') 拦截标签页关闭
 * - 桌面版：Tauri onCloseRequested + Rust confirm_close（原逻辑保留）
 *
 * 插件版在 beforeunload 时同时释放所有文件锁（S19）。
 */
export function useUnsavedConfirm() {
  const isDirty = useAppStore((s) => s.isDirty);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // ─── 插件版：beforeunload 拦截 ───
    if (isExtension) {
      const handleBeforeUnload = (e: BeforeUnloadEvent) => {
        // 释放所有文件锁（S19）
        releaseAllLocks().catch(() => {});

        if (isDirty) {
          e.preventDefault();
          e.returnValue = '';
        }
      };

      window.addEventListener('beforeunload', handleBeforeUnload);
      return () => {
        window.removeEventListener('beforeunload', handleBeforeUnload);
      };
    }

    // ─── 桌面版：Tauri onCloseRequested + beforeunload 安全网 ───
    let cancelled = false;

    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();

        // 清理旧的监听
        if (unlistenRef.current) {
          unlistenRef.current();
          unlistenRef.current = null;
        }

        if (cancelled) return;

        // 注册 close-requested 监听
        const unlisten = await currentWindow.onCloseRequested(async (event) => {
          const { isDirty: dirty } = useAppStore.getState();
          if (!dirty) return; // 无未保存变更，允许关闭

          // 阻止默认关闭行为
          event.preventDefault();

          try {
            const { invoke } = await import('@tauri-apps/api/core');
            const confirmed = await invoke<boolean>('confirm_close', { hasUnsavedChanges: dirty });
            if (confirmed) {
              try {
                await currentWindow.destroy();
              } catch (destroyErr) {
                console.warn('[useUnsavedConfirm] destroy failed, trying close:', destroyErr);
                try {
                  await currentWindow.close();
                } catch (closeErr) {
                  console.error('[useUnsavedConfirm] close also failed:', closeErr);
                }
              }
            }
          } catch (invokeErr) {
            console.warn('[useUnsavedConfirm] confirm_close failed:', invokeErr);
            if (window.confirm('You have unsaved changes. Close anyway?')) {
              try {
                await currentWindow.destroy();
              } catch {
                try { await currentWindow.close(); } catch {}
              }
            }
          }
        });

        if (cancelled) {
          unlisten();
          return;
        }

        unlistenRef.current = unlisten;
      } catch (e) {
        console.warn('[useUnsavedConfirm] Tauri API not available:', e);
      }
    })();

    // beforeunload safety net (桌面版也保留)
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      cancelled = true;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isDirty]);
}
