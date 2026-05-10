import { useCallback, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';

/**
 * Global keyboard shortcut handler.
 * Registers keydown listener for all app-wide shortcuts.
 *
 * macOS uses Meta/Cmd as the primary modifier,
 * so we map Ctrl to Cmd for consistency with macOS conventions.
 *
 * Bug 5 修复：为 INPUT/TEXTAREA 元素显式处理剪贴板快捷键，
 * 因为 macOS WebView 中没有 Edit 菜单时原生剪贴板快捷键可能失效。
 */
export function useShortcuts({ onSave }: { onSave: () => void }) {
  const { setViewMode, toggleTheme, toggleTOC } = useAppStore();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const meta = e.metaKey; // macOS Cmd
      const shift = e.shiftKey;
      const alt = e.altKey;
      const key = e.key.toLowerCase();

      // Bug 5 修复：为输入框/文本域提供剪贴板快捷键支持
      // 在 macOS WebView 中，没有 Edit 菜单时 Cmd+C/V/X/A 在 input 中可能不工作
      if (meta && !alt) {
        const target = e.target as HTMLElement;
        const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

        if (isInput) {
          if (!shift && key === 'c') {
            // ⌘C → Copy in input
            e.preventDefault();
            document.execCommand('copy');
            return;
          }
          if (!shift && key === 'v') {
            // ⌘V → Paste in input（使用 Tauri IPC 避免权限弹窗）
            e.preventDefault();
            (async () => {
              try {
                const { invoke } = await import('@tauri-apps/api/core');
                const text = await invoke<string>('read_clipboard');
                const input = target as HTMLInputElement;
                const start = input.selectionStart || 0;
                const end = input.selectionEnd || 0;
                const value = input.value;
                // 使用 React 兼容的方式更新 input 值
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                  window.HTMLInputElement.prototype, 'value'
                )?.set || Object.getOwnPropertyDescriptor(
                  window.HTMLTextAreaElement.prototype, 'value'
                )?.set;
                if (nativeInputValueSetter) {
                  nativeInputValueSetter.call(input, value.slice(0, start) + text + value.slice(end));
                } else {
                  input.value = value.slice(0, start) + text + value.slice(end);
                }
                input.selectionStart = input.selectionEnd = start + text.length;
                input.dispatchEvent(new Event('input', { bubbles: true }));
              } catch (err) {
                // 回退到 navigator.clipboard
                try {
                  const text = await navigator.clipboard.readText();
                  const input = target as HTMLInputElement;
                  const start = input.selectionStart || 0;
                  const end = input.selectionEnd || 0;
                  const value = input.value;
                  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                  )?.set || Object.getOwnPropertyDescriptor(
                    window.HTMLTextAreaElement.prototype, 'value'
                  )?.set;
                  if (nativeInputValueSetter) {
                    nativeInputValueSetter.call(input, value.slice(0, start) + text + value.slice(end));
                  } else {
                    input.value = value.slice(0, start) + text + value.slice(end);
                  }
                  input.selectionStart = input.selectionEnd = start + text.length;
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                } catch {}
              }
            })();
            return;
          }
          if (!shift && key === 'x') {
            // ⌘X → Cut in input
            e.preventDefault();
            document.execCommand('cut');
            return;
          }
          if (!shift && key === 'a') {
            // ⌘A → Select All in input
            e.preventDefault();
            document.execCommand('selectAll');
            return;
          }
        }
      }

      // Use meta (Cmd) on macOS for shortcuts
      // ⌘⌥1 → Editor only
      if (meta && alt && key === '1') {
        e.preventDefault();
        setViewMode('editor');
        return;
      }

      // ⌘⌥2 → Split
      if (meta && alt && key === '2') {
        e.preventDefault();
        setViewMode('split');
        return;
      }

      // ⌘⌥3 → Preview only
      if (meta && alt && key === '3') {
        e.preventDefault();
        setViewMode('preview');
        return;
      }

      // ⌘⇧T → Toggle theme
      if (meta && shift && key === 't') {
        e.preventDefault();
        toggleTheme();
        return;
      }

      // ⌘S → Save (prevent default browser save)
      if (meta && !shift && key === 's') {
        e.preventDefault();
        onSave();
        return;
      }

      // ⌘⇧O → Open file
      if (meta && shift && key === 'o') {
        e.preventDefault();
        // Emit custom event for open-file action
        window.dispatchEvent(new CustomEvent('app:open-file'));
        return;
      }

      // ⌘⇧H → Export HTML
      if (meta && shift && key === 'h') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('app:export-html'));
        return;
      }

      // ⌘⇧P → Export PDF / Print
      if (meta && shift && key === 'p') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('app:export-pdf'));
        return;
      }

      // ⌘\ → Toggle TOC sidebar
      if (meta && key === '\\') {
        e.preventDefault();
        toggleTOC();
        return;
      }

      // F3: ⌘F → 打开查找面板
      if (meta && !shift && key === 'f') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('app:toggle-find'));
        return;
      }
    },
    [setViewMode, toggleTheme, toggleTOC, onSave],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
