import { useState, useCallback, useMemo, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { tocToTree } from '../lib/toc-extractor';
import type { TocTreeNode } from '../types';
import type { RecentItem } from '../lib/indexeddb';
import FindReplace from './FindReplace';
import RecentFilesPanel from './RecentFilesPanel';
import { isExtension } from '../lib/platform';

interface TocSidebarProps {
  onHeadingClick?: (line: number) => void;
  /** 首页最近文件恢复（插件版） */
  onOpenFile?: () => void;
  onOpenFileByContent?: (content: string, name: string) => void;
}

type SidebarTab = 'toc' | 'find';

/**
 * Sidebar panel with two tabs: Outline (TOC) and Find & Replace.
 * 首页（无打开文件）时：插件版在 Outline 区显示最近文件，并隐藏无意义的 Find 标签。
 */
export default function TocSidebar({ onHeadingClick, onOpenFile, onOpenFileByContent }: TocSidebarProps) {
  const { tocItems, tocVisible, setTocVisible, isWelcome } = useAppStore();
  const [activeTab, setActiveTab] = useState<SidebarTab>('toc');
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  const tocTree = useMemo(() => tocToTree(tocItems), [tocItems]);

  // 首页 + 插件版：目录区域改为展示最近文件
  const isHomeExtension = isWelcome && isExtension;

  // 首页最近文件数据（仅插件版 + 首页需要），由本组件加载与维护
  const [recentFiles, setRecentFiles] = useState<RecentItem[]>([]);
  useEffect(() => {
    if (!isHomeExtension) return;
    let cancelled = false;
    (async () => {
      try {
        const { listRecent } = await import('../lib/indexeddb');
        const files = await listRecent(10);
        if (!cancelled) setRecentFiles(files);
      } catch {
        /* IndexedDB 不可用时静默 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isHomeExtension]);

  // 点击最近文件：读取草稿内容恢复；失败则降级为文件选择器
  const handleOpenRecent = useCallback(
    async (file: RecentItem) => {
      try {
        const { getDraft } = await import('../lib/indexeddb');
        const draft = await getDraft(file.id);
        if (draft && draft.content) {
          onOpenFileByContent?.(draft.content, file.name);
          return;
        }
      } catch {
        /* 读取草稿失败，降级 */
      }
      onOpenFile?.();
    },
    [onOpenFile, onOpenFileByContent],
  );

  const handleClearRecent = useCallback(async () => {
    try {
      const { clearRecent } = await import('../lib/indexeddb');
      await clearRecent();
      setRecentFiles([]);
    } catch {
      /* 静默 */
    }
  }, []);

  const handleRemoveRecent = useCallback(async (id: string) => {
    try {
      const { removeRecent } = await import('../lib/indexeddb');
      await removeRecent(id);
      setRecentFiles((prev) => prev.filter((f) => f.id !== id));
    } catch {
      /* 静默 */
    }
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Listen for Cmd+F to switch to Find tab
  useEffect(() => {
    const handler = () => {
      setTocVisible(true);
      setActiveTab('find');
    };
    window.addEventListener('app:toggle-find', handler);
    return () => window.removeEventListener('app:toggle-find', handler);
  }, [setTocVisible]);

  // Bug5 修复：不再按 viewMode 隐藏，仅由 tocVisible 控制
  if (!tocVisible) {
    return null;
  }

  // 首页（无打开文件）且无最近文件时：不显示左侧栏（默认关闭）
  if (isHomeExtension && recentFiles.length === 0) {
    return null;
  }

  return (
    <aside className="toc-sidebar" data-toc-visible={tocVisible}>
      <div className="toc-header">
        {/* Tab 栏 */}
        <div className="find-tabs">
          <button
            className={`find-tab ${activeTab === 'toc' ? 'active' : ''}`}
            onClick={() => setActiveTab('toc')}
          >
            Outline
          </button>
          {!isHomeExtension && (
            <button
              className={`find-tab ${activeTab === 'find' ? 'active' : ''}`}
              onClick={() => setActiveTab('find')}
            >
              Find
            </button>
          )}
        </div>
        <button
          className="toc-close-btn"
          onClick={() => setTocVisible(false)}
          title="Close Panel"
          aria-label="Close panel"
        >
          X
        </button>
      </div>

      <div className="toc-body">
        {isHomeExtension ? (
          <RecentFilesPanel
            files={recentFiles}
            onOpen={handleOpenRecent}
            onClearAll={handleClearRecent}
            onRemove={handleRemoveRecent}
          />
        ) : activeTab === 'toc' ? (
          tocTree.length === 0 ? (
            <div className="toc-empty">
              No headings found.
              <br />
              <small>Add some # headings to see them here.</small>
            </div>
          ) : (
            <ul className="toc-list">
              {tocTree.map((node) => (
                <TocItemNode
                  key={node.id}
                  node={node}
                  collapsedIds={collapsedIds}
                  onToggle={toggleCollapse}
                  onHeadingClick={onHeadingClick}
                />
              ))}
            </ul>
          )
        ) : (
          <FindReplace />
        )}
      </div>
    </aside>
  );
}

/** Recursive TOC item node renderer */
function TocItemNode({
  node,
  collapsedIds,
  onToggle,
  onHeadingClick,
}: {
  node: TocTreeNode;
  collapsedIds: Set<string>;
  onToggle: (id: string) => void;
  onHeadingClick?: (line: number) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsedIds.has(node.id);

  const handleClick = useCallback(() => {
    if (onHeadingClick) onHeadingClick(node.line);
  }, [node.line, onHeadingClick]);

  return (
    <li className={`toc-item level-${node.level}`}>
      <div
        className="toc-item-row"
        role="button"
        tabIndex={0}
        title={`Jump to: ${node.text}`}
        onClick={handleClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } }}
      >
        {hasChildren && (
          <button
            className={`toc-toggle ${isCollapsed ? 'collapsed' : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggle(node.id); }}
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
          >
            &#9656;
          </button>
        )}
        {!hasChildren && <span className="toc-toggle-spacer" />}
        <span className="toc-link">
          {node.text}
        </span>
      </div>

      {hasChildren && !isCollapsed && (
        <ul className="toc-children">
          {node.children.map((child) => (
            <TocItemNode
              key={child.id}
              node={child}
              collapsedIds={collapsedIds}
              onToggle={onToggle}
              onHeadingClick={onHeadingClick}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
