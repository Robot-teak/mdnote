import { useAppStore } from '../store/useAppStore';

/**
 * Status bar at the bottom of the window.
 * Shows auto-save toggle, word count, line count, save status, and current view mode.
 */
export default function StatusBar() {
  const { content, isDirty, fileName, viewMode, theme, autoSaveEnabled, setAutoSaveEnabled } = useAppStore();

  const lineCount = content ? content.split('\n').length : 0;
  const charCount = content?.length || 0;
  const wordCount = content ? content.trim().split(/\s+/).filter(Boolean).length : 0;

  const viewLabel =
    viewMode === 'split' ? 'Split View' :
    viewMode === 'editor' ? 'Editor Only' : 'Preview Only';

  return (
    <footer className="status-bar">
      <div className="status-left">
        <label className="status-item auto-save-toggle" title="Auto-save (3s delay after changes)">
          <input
            type="checkbox"
            checked={autoSaveEnabled}
            onChange={(e) => setAutoSaveEnabled(e.target.checked)}
          />
          <span>Auto-save</span>
        </label>
        <span className="status-separator">|</span>
        <span className="status-item filename" title={fileName}>
          {fileName}{isDirty ? ' ●' : ''}
        </span>
        <span className="status-separator">|</span>
        <span className="status-item lines">{lineCount} lines</span>
        <span className="status-item words">{wordCount} words</span>
        <span className="status-item chars">{charCount.toLocaleString()} chars</span>
      </div>

      <div className="status-right">
        <span className="status-item save-status">
          {isDirty ? 'Unsaved' : 'Saved'}
        </span>
        <span className="status-separator">|</span>
        <span className="status-item view-mode">{viewLabel}</span>
        <span className="status-separator">|</span>
        <span className="status-item theme-name">
          {theme === 'dark' ? '🌙 Dark' : '☀️ Light'}
        </span>
      </div>
    </footer>
  );
}
