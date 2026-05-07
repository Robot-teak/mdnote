import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';

interface SearchResultItem {
  line: number;     // 1-indexed
  col: number;      // 0-indexed column
  text: string;     // matched line text
  matchStart: number;
  matchEnd: number;
}

/** 虚拟滚动常量 */
const ITEM_HEIGHT = 40;
const BUFFER_SIZE = 5;

/**
 * Find & Replace panel.
 * Uses CM6 search API via window events to communicate with EditorPane.
 * Bug 3: In preview mode, performs text search on raw markdown content directly.
 */
export default function FindReplace() {
  const viewMode = useAppStore((s) => s.viewMode);
  const content = useAppStore((s) => s.content);
  const isEditable = viewMode !== 'preview';

  const [searchText, setSearchText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);

  // Bug 5 修复：查找内容变化时重置 hasSearched，让 Next 按钮变回 Find
  useEffect(() => {
    setHasSearched(false);
    setMatchCount(null);
    setResults([]);
    setCurrentMatchIndex(-1);
  }, [searchText]);

  // 修复问题1：切换模式后清除搜索（viewMode 变化时清空搜索状态）
  useEffect(() => {
    setSearchText('');
    setReplaceText('');
    setHasSearched(false);
    setMatchCount(null);
    setResults([]);
    setCurrentMatchIndex(-1);
  }, [viewMode]);

  // Bug 3: 预览模式下的纯文本搜索
  const performPreviewSearch = useCallback((query: string) => {
    if (!query) {
      setMatchCount(null);
      setResults([]);
      setCurrentMatchIndex(-1);
      return;
    }

    const lines = content.split('\n');
    const searchResults: SearchResultItem[] = [];
    const maxResults = 200;

    for (let i = 0; i < lines.length && searchResults.length < maxResults; i++) {
      const line = lines[i];
      let searchPos = 0;
      let idx = line.indexOf(query, searchPos);
      while (idx !== -1 && searchResults.length < maxResults) {
        searchResults.push({
          line: i + 1,
          col: idx,
          text: line,
          matchStart: idx,
          matchEnd: idx + query.length,
        });
        searchPos = idx + 1;
        idx = line.indexOf(query, searchPos);
      }
    }

    const matchIdx = searchResults.length > 0 ? 0 : -1;
    setResults(searchResults);
    setCurrentMatchIndex(matchIdx);
    setMatchCount(searchResults.length);
    setHasSearched(true);

    // 跳转到第一个匹配
    if (searchResults.length > 0) {
      window.dispatchEvent(new CustomEvent('preview:scroll-to-line', {
        detail: { line: searchResults[0].line - 1 },
      }));
    }
  }, [content]);

  // 执行搜索
  const doSearch = useCallback(() => {
    if (!searchText) {
      setMatchCount(null);
      setResults([]);
      setHasSearched(false);
      setCurrentMatchIndex(-1);
      return;
    }

    if (viewMode === 'preview') {
      // Bug 3: 预览模式使用纯文本搜索
      performPreviewSearch(searchText);
      return;
    }

    window.dispatchEvent(new CustomEvent('editor:find', {
      detail: { query: searchText },
    }));
    setHasSearched(true);
  }, [searchText, viewMode, performPreviewSearch]);

  // 输入框 Enter 键
  const onSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        if (viewMode === 'preview') {
          // Bug 3: 预览模式 Prev
          findPrevPreview();
        } else {
          window.dispatchEvent(new CustomEvent('editor:find-prev'));
        }
      } else if (hasSearched) {
        if (viewMode === 'preview') {
          findNextPreview();
        } else {
          window.dispatchEvent(new CustomEvent('editor:find-next'));
        }
      } else {
        doSearch();
      }
    }
  }, [hasSearched, doSearch, viewMode]);

  const onReplaceKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doReplace();
    }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('editor:find-prev'));
    }
  }, []);

  // Bug 3: 预览模式查找下一个
  const findNextPreview = useCallback(() => {
    if (results.length === 0) return;
    const nextIdx = (currentMatchIndex + 1) % results.length;
    setCurrentMatchIndex(nextIdx);
    window.dispatchEvent(new CustomEvent('preview:scroll-to-line', {
      detail: { line: results[nextIdx].line - 1 },
    }));
  }, [results, currentMatchIndex]);

  // Bug 3: 预览模式查找上一个
  const findPrevPreview = useCallback(() => {
    if (results.length === 0) return;
    const prevIdx = currentMatchIndex <= 0 ? results.length - 1 : currentMatchIndex - 1;
    setCurrentMatchIndex(prevIdx);
    window.dispatchEvent(new CustomEvent('preview:scroll-to-line', {
      detail: { line: results[prevIdx].line - 1 },
    }));
  }, [results, currentMatchIndex]);

  // 查找下一个
  const findNext = useCallback(() => {
    if (!hasSearched && searchText) doSearch();
    else if (viewMode === 'preview') findNextPreview();
    else window.dispatchEvent(new CustomEvent('editor:find-next'));
  }, [hasSearched, searchText, doSearch, viewMode, findNextPreview]);

  // 查找上一个
  const findPrev = useCallback(() => {
    if (!hasSearched && searchText) doSearch();
    else if (viewMode === 'preview') findPrevPreview();
    else window.dispatchEvent(new CustomEvent('editor:find-prev'));
  }, [hasSearched, searchText, doSearch, viewMode, findPrevPreview]);

  // 替换当前
  const doReplace = useCallback(() => {
    if (!isEditable || !searchText) return;
    window.dispatchEvent(new CustomEvent('editor:replace-next', {
      detail: { replacement: replaceText },
    }));
  }, [isEditable, searchText, replaceText]);

  // 全部替换
  const doReplaceAll = useCallback(() => {
    if (!isEditable || !searchText) return;
    window.dispatchEvent(new CustomEvent('editor:replace-all', {
      detail: { replacement: replaceText },
    }));
  }, [isEditable, searchText, replaceText]);

  // 监听编辑器返回的搜索结果
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{
        results: SearchResultItem[];
        currentIndex: number;
        totalCount: number;
      }>).detail;
      if (detail) {
        setResults(detail.results);
        setCurrentMatchIndex(detail.currentIndex);
        setMatchCount(detail.totalCount);
      }
    };
    window.addEventListener('editor:find-results', handler);
    return () => window.removeEventListener('editor:find-results', handler);
  }, []);

  // 点击结果项跳转
  const onResultClick = useCallback((index: number) => {
    if (viewMode === 'preview') {
      // Bug 3: 预览模式跳转
      setCurrentMatchIndex(index);
      window.dispatchEvent(new CustomEvent('preview:scroll-to-line', {
        detail: { line: results[index].line - 1 },
      }));
      return;
    }
    window.dispatchEvent(new CustomEvent('editor:goto-match', { detail: { index } }));
    setCurrentMatchIndex(index);
  }, [viewMode, results]);

  // 自动聚焦输入框
  useEffect(() => {
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);

  // 虚拟滚动参数
  const [scrollTop, setScrollTop] = useState(0);
  const totalHeight = results.length * ITEM_HEIGHT;
  const visibleCount = Math.min(results.length, 200);
  const containerHeight = Math.min(visibleCount * ITEM_HEIGHT, 320);
  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_SIZE);
  const endIndex = Math.min(visibleCount, Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + BUFFER_SIZE);

  const visibleItems = useMemo(() =>
    results.slice(startIndex, endIndex).map((item, i) => ({
      ...item,
      globalIndex: startIndex + i,
    })),
    [results, startIndex, endIndex]
  );

  return (
    <div className="find-panel">
      {/* 查找输入 */}
      <div className="find-input-group">
        <div className="find-input-row">
          <span className="find-input-icon">Q</span>
          <input
            ref={searchInputRef}
            type="text"
            className="find-input"
            placeholder="Find..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={onSearchKeyDown}
            spellCheck={false}
          />
        </div>
        {isEditable && (
          <div className="find-input-row">
            <span className="find-input-icon">R</span>
            <input
              ref={replaceInputRef}
              type="text"
              className="find-input"
              placeholder="Replace..."
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              onKeyDown={onReplaceKeyDown}
              spellCheck={false}
            />
          </div>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="find-actions">
        {!hasSearched ? (
          <button className="find-btn find-btn-primary" onClick={doSearch} disabled={!searchText}>
            Find
          </button>
        ) : (
          <button className="find-btn find-btn-primary" onClick={findNext}>
            Next
          </button>
        )}
        <button className="find-btn" onClick={findPrev} disabled={!hasSearched}>
          Prev
        </button>
        {isEditable && (
          <>
            <button className="find-btn find-btn-accent" onClick={doReplace} disabled={!hasSearched || !replaceText}>
              Replace
            </button>
            <button className="find-btn find-btn-accent" onClick={doReplaceAll} disabled={!hasSearched || !replaceText}>
              All
            </button>
          </>
        )}
      </div>

      {/* 匹配计数 */}
      {matchCount !== null && (
        <div className="find-result-count">
          {matchCount === 0
            ? 'No matches found'
            : `${matchCount} match${matchCount > 1 ? 'es' : ''} found`}
        </div>
      )}

      {/* 结果列表（虚拟滚动） */}
      {results.length > 0 && (
        <div
          className="find-result-list"
          ref={listContainerRef}
          style={{ height: containerHeight }}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        >
          <div style={{ height: totalHeight, position: 'relative' }}>
            {visibleItems.map((item) => (
              <button
                key={item.globalIndex}
                className={`find-result-item ${item.globalIndex === currentMatchIndex ? 'active' : ''}`}
                style={{
                  position: 'absolute',
                  top: item.globalIndex * ITEM_HEIGHT,
                  height: ITEM_HEIGHT,
                  width: '100%',
                }}
                onClick={() => onResultClick(item.globalIndex)}
              >
                <span className="find-result-line">{item.line}</span>
                <span className="find-result-text">
                  {highlightMatch(item.text, item.matchStart, item.matchEnd)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 高亮匹配文本 */
function highlightMatch(text: string, start: number, end: number): React.ReactNode {
  if (start < 0 || end <= start || start > text.length) return text;
  const before = text.slice(0, start);
  const match = text.slice(start, end);
  const after = text.slice(end);
  return (
    <>
      {truncate(before, 10, 'left')}
      <mark className="find-highlight">{match}</mark>
      {truncate(after, 20, 'right')}
    </>
  );
}

/** 截断过长文本 */
function truncate(text: string, maxLen: number, side: 'left' | 'right'): string {
  if (text.length <= maxLen) return text;
  if (side === 'left') {
    return '...' + text.slice(-maxLen);
  }
  return text.slice(0, maxLen) + '...';
}
