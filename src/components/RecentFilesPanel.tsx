import type { RecentItem } from '../lib/indexeddb';

interface RecentFilesPanelProps {
  /** 最近文件列表（由父组件 TocSidebar 加载与维护） */
  files: RecentItem[];
  /** 点击某条最近文件：父组件负责读取草稿并恢复 */
  onOpen: (file: RecentItem) => void;
  /** 清空全部 */
  onClearAll: () => void;
  /** 删除单条 */
  onRemove: (id: string) => void;
}

/**
 * 最近文件列表面板（展示型组件）。
 * 数据加载、打开/删除/清空的副作用由父组件 TocSidebar 负责。
 */
export default function RecentFilesPanel({ files, onOpen, onClearAll, onRemove }: RecentFilesPanelProps) {
  const formatTime = (timestamp: number): string => {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  return (
    <div className="welcome-recent">
      <div className="welcome-recent-header">
        <h3>Recent Files</h3>
        {files.length > 0 && (
          <button className="recent-clear-btn" onClick={onClearAll} title="Clear all recent files">
            Clear All
          </button>
        )}
      </div>
      {files.length === 0 ? (
        <div className="recent-empty">No recent files yet.</div>
      ) : (
        <ul className="recent-list">
          {files.map((file) => (
            <li key={file.id}>
              <button
                className="recent-file-btn"
                onClick={() => onOpen(file)}
                title={file.hasHandle ? 'Click to restore from draft' : 'Click to restore'}
              >
                <span className="recent-file-name">📄 {file.name}</span>
                <span className="recent-file-time">{formatTime(file.lastAccessed)}</span>
              </button>
              <button
                className="recent-remove-btn"
                onClick={() => onRemove(file.id)}
                title="Remove from list"
                aria-label={`Remove ${file.name}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
