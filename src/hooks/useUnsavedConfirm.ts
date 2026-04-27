import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';

/**
 * Hook to prevent window close when there are unsaved changes.
 * Uses Tauri's onCloseRequested event + Rust confirm_close command.
 */
export function useUnsavedConfirm() {
  const isDirty = useAppStore((s) => s.isDirty);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
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

          // 使用 Rust 端的 confirm_close（已用 spawn_blocking 避免死锁）
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            const confirmed = await invoke<boolean>('confirm_close', { hasUnsavedChanges: dirty });
            if (confirmed) {
              // 用户确认关闭 → 强制销毁窗口
              try {
                await currentWindow.destroy();
              } catch (destroyErr) {
                // destroy 失败，尝试 close
                console.warn('[useUnsavedConfirm] destroy failed, trying close:', destroyErr);
                try {
                  await currentWindow.close();
                } catch (closeErr) {
                  console.error('[useUnsavedConfirm] close also failed:', closeErr);
                }
              }
            }
            // 用户取消 → 什么都不做，窗口保持打开
          } catch (invokeErr) {
            // Rust 命令失败，用 window.confirm 回退
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

    // Also listen for beforeunload as safety net
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
