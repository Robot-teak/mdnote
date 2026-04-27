import { useState, useCallback, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { tocToTree } from '../lib/toc-extractor';
import type { TocTreeNode } from '../types';

interface TocSidebarProps {
  onHeadingClick?: (line: number) => void;
}

/**
 * Table of Contents sidebar.
 * Displays a hierarchical tree of headings extracted from the document.
 * Clicking a item scrolls both editor and preview to that heading.
 */
export default function TocSidebar({ onHeadingClick }: TocSidebarProps) {
  const { tocItems, tocVisible, setTocVisible } = useAppStore();
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  const tocTree = useMemo(() => tocToTree(tocItems), [tocItems]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Bug5 修复：不再按 viewMode 隐藏，仅由 tocVisible 控制
  if (!tocVisible) {
    return null;
  }

  return (
    <aside className="toc-sidebar" data-toc-visible={tocVisible}>
      <div className="toc-header">
        <span className="toc-title">Outline</span>
        <button
          className="toc-close-btn"
          onClick={() => setTocVisible(false)}
          title="Close Outline"
          aria-label="Close outline panel"
        >
          ✕
        </button>
      </div>

      <div className="toc-body">
        {tocTree.length === 0 ? (
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
      {/* Bug1 修复：cursor 放在 toc-link 上，整行不再有 pointer */}
      <div className="toc-item-row">
        {hasChildren && (
          <button
            className={`toc-toggle ${isCollapsed ? 'collapsed' : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggle(node.id); }}
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
          >
            ▸
          </button>
        )}
        {!hasChildren && <span className="toc-toggle-spacer" />}
        {/* 只有文字区域可点击，有 pointer cursor */}
        <span
          className="toc-link"
          title={`Jump to: ${node.text}`}
          role="button"
          tabIndex={0}
          onClick={handleClick}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } }}
        >
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
