import { useState, useCallback, useMemo, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { tocToTree } from '../lib/toc-extractor';
import type { TocTreeNode } from '../types';
import FindReplace from './FindReplace';

interface TocSidebarProps {
  onHeadingClick?: (line: number) => void;
}

type SidebarTab = 'toc' | 'find';

/**
 * Sidebar panel with two tabs: Outline (TOC) and Find & Replace.
 */
export default function TocSidebar({ onHeadingClick }: TocSidebarProps) {
  const { tocItems, tocVisible, setTocVisible } = useAppStore();
  const [activeTab, setActiveTab] = useState<SidebarTab>('toc');
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  const tocTree = useMemo(() => tocToTree(tocItems), [tocItems]);

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
          <button
            className={`find-tab ${activeTab === 'find' ? 'active' : ''}`}
            onClick={() => setActiveTab('find')}
          >
            Find
          </button>
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
        {activeTab === 'toc' ? (
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
