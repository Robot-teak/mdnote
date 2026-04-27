import { useAppStore } from '../store/useAppStore';

/**
 * Status bar at the bottom of the window.
 * Shows auto-save toggle, file path (click to reveal in Finder), word count, line count, and save status.
 */
export default function StatusBar() {
  const { content, isDirty, filePath, autoSaveEnabled, setAutoSaveEnabled } = useAppStore();

  const lineCount = content ? content.split('\n').length : 0;
  const charCount = content?.length || 0;
  const wordCount = content ? content.trim().split(/\s+/).filter(Boolean).length : 0;

  // Truncate path in the middle, keeping start and end visible
  const truncatePath = (path: string | null, maxLen: number = 50): string => {
    if (!path) return 'Untitled';
    if (path.length <= maxLen) return path;
    const start = path.slice(0, Math.floor(maxLen / 2) - 2);
    const end = path.slice(-Math.ceil(maxLen / 2) + 3);
    return `${start}...${end}`;
  };

  // Open file location in Finder
  const handleRevealInFinder = async () => {
    if (!filePath) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('reveal_in_finder', { path: filePath });
    } catch (err) {
      console.error('[MDnote] Reveal in Finder failed:', err);
    }
  };

  return (
    <footer className="status-bar">
      <div className="status-left">
        <span className="status-item file-path" title={filePath || 'Untitled'}>
          <button
            className="file-path-btn"
            onClick={handleRevealInFinder}
            title="Click to reveal in Finder"
            disabled={!filePath}
          >
            {truncatePath(filePath)}{isDirty ? ' ●' : ''}
          </button>
        </span>
        <span className="status-separator">|</span>
        <span className="status-item lines">{lineCount} lines</span>
        <span className="status-item words">{wordCount} words</span>
        <span className="status-item chars">{charCount.toLocaleString()} chars</span>
      </div>

      <div className="status-right">
        <label className="status-item auto-save-toggle" title="Auto-save (3s delay after changes)">
          <input
            type="checkbox"
            checked={autoSaveEnabled}
            onChange={(e) => setAutoSaveEnabled(e.target.checked)}
          />
          <span>Auto-save</span>
        </label>
        <span className="status-separator">|</span>
        <span className="status-item save-status">
          {isDirty ? 'Unsaved' : 'Saved'}
        </span>
      </div>
    </footer>
  );
}
