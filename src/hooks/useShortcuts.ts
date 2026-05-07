import { useCallback, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';

/**
 * Global keyboard shortcut handler.
 * Registers keydown listener for all app-wide shortcuts.
 *
 * macOS uses Meta/Cmd as the primary modifier,
 * so we map Ctrl to Cmd for consistency with macOS conventions.
 */
export function useShortcuts({ onSave }: { onSave: () => void }) {
  const { setViewMode, toggleTheme, toggleTOC } = useAppStore();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const meta = e.metaKey; // macOS Cmd
      const shift = e.shiftKey;
      const alt = e.altKey;
      const key = e.key.toLowerCase();

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
