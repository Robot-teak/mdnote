import { useAppStore } from '../store/useAppStore';
import { isExtension, isDesktop } from '../lib/platform';

/**
 * Status bar at the bottom of the window.
 * Shows file path, word count, line count, save status (三态), and auto-save toggle.
 *
 * M09/R02/S22 改造：
 * - 移除 reveal_in_finder 按钮（R02，插件版无对应 API）
 * - 显示三态保存状态（Q26：dirty / draft-saved / disk-saved）
 * - S22 句柄失效时显示"需重新授权"提示
 */
export default function StatusBar() {
  const { content, isDirty, filePath, autoSaveEnabled, setAutoSaveEnabled, saveState, fileHandle, diskWriteFailed } = useAppStore();

  const lineCount = content ? content.split('\n').length : 0;
  const charCount = content?.length || 0;
  const wordCount = content ? content.trim().split(/\s+/).filter(Boolean).length : 0;

  // Truncate path in the middle
  const truncatePath = (path: string | null, maxLen: number = 50): string => {
    if (!path) return 'Untitled';
    if (path.length <= maxLen) return path;
    const start = path.slice(0, Math.floor(maxLen / 2) - 2);
    const end = path.slice(-Math.ceil(maxLen / 2) + 3);
    return `${start}...${end}`;
  };

  // 三态保存状态显示文案
  const getSaveStatusText = (): string => {
    if (saveState === 'dirty') return 'Unsaved';
    if (saveState === 'draft-saved') return 'Draft saved';
    if (saveState === 'disk-saved') return 'Saved';
    return isDirty ? 'Unsaved' : 'Saved';
  };

  // S22: 句柄失效检测（仅 saveNow Q21 降级路径设置 diskWriteFailed=true）
  // 正常自动保存（saveDraftToIndexedDB）不会设置此标志，避免误报
  const needsReauth = isExtension && !!fileHandle && diskWriteFailed;

  // 桌面版：保留 reveal_in Finder（仅桌面版）
  const handleRevealInFinder = async () => {
    if (!isDesktop || !filePath) return;
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
          {isDesktop && filePath ? (
            <button
              className="file-path-btn"
              onClick={handleRevealInFinder}
              title="Click to reveal in Finder"
            >
              {truncatePath(filePath)}{isDirty ? ' ●' : ''}
            </button>
          ) : (
            <span className="file-path-text">
              {truncatePath(filePath)}{isDirty ? ' ●' : ''}
            </span>
          )}
        </span>
        <span className="status-separator">|</span>
        <span className="status-item lines">{lineCount} lines</span>
        <span className="status-item words">{wordCount} words</span>
        <span className="status-item chars">{charCount.toLocaleString()} chars</span>
      </div>

      <div className="status-right">
        {/* S22: 句柄失效提示 */}
        {needsReauth && (
          <span className="status-item reauth-warning" title="File permission expired. Use Save As to re-authorize.">
            ⚠️ Re-auth needed
          </span>
        )}
        <label className="status-item auto-save-toggle" title="Auto-save (60s interval)">
          <input
            type="checkbox"
            checked={autoSaveEnabled}
            onChange={(e) => setAutoSaveEnabled(e.target.checked)}
          />
          <span>Auto-save</span>
        </label>
        <span className="status-separator">|</span>
        <span className={`status-item save-status save-${saveState}`}>
          {getSaveStatusText()}
        </span>
      </div>
    </footer>
  );
}
