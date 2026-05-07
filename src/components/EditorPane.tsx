import { useRef, useEffect } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection, dropCursor, highlightActiveLine, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, selectAll } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { oneDarkTheme } from '@codemirror/theme-one-dark';
import { search, setSearchQuery, getSearchQuery, SearchQuery } from '@codemirror/search';
import { useAppStore } from '../store/useAppStore';

// AutoFill 已禁用 - 如需启用请恢复 closeBrackets 和 closeBracketsKeymap
// import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';

interface EditorPaneProps {
  /** Debounced callback when content changes */
  onContentChange: (content: string) => void;
}

/**
 * CodeMirror 6 editor pane.
 * Manages its own CM6 instance via ref to avoid re-creating on every render.
 */
export default function EditorPane({ onContentChange }: EditorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { content, theme, setContent, setDirty } = useAppStore();

  // 标记：是否是程序性更新（非用户输入）
  const isExternalUpdate = useRef(false);
  // CM6 主题 Compartment，用于动态切换亮/暗主题
  const themeCompartment = useRef(new Compartment());
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 问题4修复：在 contenteditable 上，浏览器 mousedown 默认行为可能先设置 DOM Selection，
  // 触发 selectionchange → applyDOMChange。而 applyDOMChange 中，如果
  // lastSelectionOrigin == "select"（由 keydown 设置），就会 scrollIntoView=true，
  // 导致视图跳到旧光标位置。修复方式：在 capture 阶段提前将 lastSelectionOrigin 设为
  // "select.pointer"，这样 applyDOMChange 就不会设置 scrollIntoView。
  const pointerScrollFixRef = useRef<{ view: EditorView; cleanup: () => void } | null>(null);

  // Initialize editor once
  useEffect(() => {
    if (!containerRef.current || viewRef.current) return;

    const isDark = theme === 'dark';

    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      highlightActiveLine(),
      highlightSpecialChars(),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      // F3: CM6 search facet
      search(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      keymap.of([
        // B3 修复：显式注册剪贴板和全选快捷键（macOS WebView 兜底）
        { key: 'Mod-a', run: selectAll },
        { key: 'Mod-x', run: (view: EditorView) => {
          const { from, to } = view.state.selection.main;
          if (from === to) return false;
          const text = view.state.sliceDoc(from, to);
          navigator.clipboard.writeText(text).catch(() => {});
          view.dispatch({ changes: { from, to }, selection: { anchor: from } });
          return true;
        }},
        { key: 'Mod-c', run: (view: EditorView) => {
          const { from, to } = view.state.selection.main;
          if (from === to) return false;
          const text = view.state.sliceDoc(from, to);
          navigator.clipboard.writeText(text).catch(() => {});
          return true;
        }},
        { key: 'Mod-v', run: (view: EditorView) => {
          navigator.clipboard.readText().then(text => {
            view.dispatch({
              changes: { from: view.state.selection.main.from, insert: text },
            });
          }).catch(() => {});
          return true;
        }},
        // F3: 抑制 CM6 内置 Cmd+F（由前端 useShortcuts 处理）
        { key: 'Mod-f', run: () => true },
      ]),
      EditorView.lineWrapping,
      // Theme extension via Compartment (dynamic reconfigure)
      themeCompartment.current.of(isDark ? oneDarkTheme : []),
      // Listen for changes → update store + notify parent
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          // 如果是程序性更新（打开文件、新建文档），不标记为 dirty
          if (isExternalUpdate.current) return;
          const newContent = update.state.doc.toString();
          setContent(newContent);
          setDirty(true);
        }
      }),
      // 鼠标事件处理（用于同步预览）
      EditorView.domEventHandlers({
        click(_event: MouseEvent, view: EditorView) {
          // 同步预览（仅双屏模式）
          if (useAppStore.getState().viewMode !== 'split') return false;
          const line = view.state.doc.lineAt(view.state.selection.main.head).number;
          const line0 = line - 1;
          if (syncTimer.current) clearTimeout(syncTimer.current);
          syncTimer.current = setTimeout(() => {
            window.dispatchEvent(new CustomEvent('editor:scroll-preview', { detail: { line: line0 } }));
          }, 100);
          return false;
        },
      }),
      // Minimal custom theme for light mode base styles
      EditorView.theme({
        '&': { height: '100%', fontSize: '14px', fontFamily: '"SF Mono", "Fira Code", Consolas, monospace' },
        '.cm-scroller': { overflow: 'auto', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
        '.cm-content': { padding: '16px 24px', minHeight: '100%' },
        '.cm-focused': { outline: 'none' },
        '.cm-gutters': { backgroundColor: 'var(--mf-bg-secondary)', borderRight: '1px solid var(--mf-border)', color: 'var(--mf-text-muted)' },
        '.cm-activeLineGutter': { backgroundColor: 'var(--mf-bg-tertiary)' },
        '.cm-activeLine': { backgroundColor: 'rgba(0,0,0,0.04)' },
        '&.cm-dark .cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.06)' },
      }),
    ];

    const state = EditorState.create({
      doc: content,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current!,
    });

    viewRef.current = view;

    // 问题4修复：滚动后点击编辑区时防止视图跳回旧光标位置
    // 根因分析：
    //   CM6 的 keydown handler 会将 inputState.lastSelectionOrigin 设为 "select"，
    //   而在 applyDOMChange 中，如果 lastSelectionOrigin == "select" 且在 50ms 内，
    //   会设置 scrollIntoView=true，导致视图滚动到旧光标位置。
    //   正常的 MouseSelection.select() 不带 scrollIntoView，但浏览器的 mousedown
    //   默认行为可能先触发 selectionchange → applyDOMChange → scrollIntoView。
    // 修复方式：
    //   1. 在 capture 阶段将 lastSelectionOrigin 改为 "select.pointer"
    //      （阻止 applyDOMChange 的 scrollIntoView=true）
    //   2. 检测滚动操作后，在 mousedown 时短暂锁定 scrollTop 作为兜底
    const contentDOM = view.contentDOM;
    const scroller = view.scrollDOM;
    let scrollLockTop: number | null = null;
    let scrollLockTimer: ReturnType<typeof setTimeout> | null = null;
    let lastScrollTop = scroller.scrollTop;
    let scrolledRecently = false;
    let scrolledTimer: ReturnType<typeof setTimeout> | null = null;

    // 检测滚动操作（滚动条拖动、鼠标滚轮等）
    const handleScrollDetect = () => {
      if (Math.abs(scroller.scrollTop - lastScrollTop) > 1) {
        lastScrollTop = scroller.scrollTop;
        scrolledRecently = true;
        if (scrolledTimer) clearTimeout(scrolledTimer);
        // 1秒内没有新的滚动则标记为"不再最近滚动"
        scrolledTimer = setTimeout(() => { scrolledRecently = false; }, 1000);
      }
    };

    // 在 scroll 事件中锁定 scrollTop（仅在锁定生效期间）
    const handleScrollLock = () => {
      handleScrollDetect();
      if (scrollLockTop !== null && Math.abs(scroller.scrollTop - scrollLockTop) > 1) {
        scroller.scrollTop = scrollLockTop;
      }
    };

    // mouseup 时延迟一小段时间后解除锁定
    const handleMouseUp = () => {
      if (scrollLockTimer) clearTimeout(scrollLockTimer);
      scrollLockTimer = setTimeout(() => {
        scrollLockTop = null;
        scrollLockTimer = null;
      }, 50);
    };

    const handleMouseDownCapture = () => {
      // 措施1：覆盖 lastSelectionOrigin 为 "select.pointer"
      // @ts-ignore - 访问 CM6 内部 inputState
      const inputState = view.inputState;
      if (inputState) {
        inputState.lastSelectionOrigin = 'select.pointer';
        inputState.lastSelectionTime = Date.now();
      }

      // 措施2：只在最近有滚动操作时才锁定 scrollTop
      if (scrolledRecently) {
        scrollLockTop = scroller.scrollTop;
        if (scrollLockTimer) clearTimeout(scrollLockTimer);
        scrollLockTimer = setTimeout(() => {
          scrollLockTop = null;
          scrollLockTimer = null;
        }, 150);
      }
    };

    contentDOM.addEventListener('mousedown', handleMouseDownCapture, true);
    contentDOM.addEventListener('mouseup', handleMouseUp, true);
    scroller.addEventListener('scroll', handleScrollLock, true);

    pointerScrollFixRef.current = {
      view,
      cleanup: () => {
        contentDOM.removeEventListener('mousedown', handleMouseDownCapture, true);
        contentDOM.removeEventListener('mouseup', handleMouseUp, true);
        scroller.removeEventListener('scroll', handleScrollLock, true);
        if (scrollLockTimer) clearTimeout(scrollLockTimer);
        if (scrolledTimer) clearTimeout(scrolledTimer);
      },
    };

    return () => {
      pointerScrollFixRef.current?.cleanup();
      pointerScrollFixRef.current = null;
      view.destroy();
      viewRef.current = null;
    };
  }, []); // Only run once on mount

  // Sync external content changes (e.g., file open)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentContent = view.state.doc.toString();
    if (currentContent !== content) {
      // 标记为程序性更新，避免 setDirty(true)
      isExternalUpdate.current = true;
      view.dispatch({
        changes: {
          from: 0,
          to: currentContent.length,
          insert: content,
        },
      });
      // 下一帧重置标志
      requestAnimationFrame(() => {
        isExternalUpdate.current = false;
      });
    }
  }, [content]);

  // B2 修复：主题变化时动态 reconfigure CM6 主题
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(
        theme === 'dark' ? oneDarkTheme : []
      ),
    });
  }, [theme]);

  // Listen for TOC click events → scroll to line
  useEffect(() => {
    const handler = (e: Event) => {
      const view = viewRef.current;
      const detail = (e as CustomEvent<{ line: number }>).detail;
      const line = detail?.line;
      if (typeof line !== 'number' || !view) return;

      // Scroll to the target line
      const pos = view.state.doc.line(line + 1).from; // CM6 lines are 1-indexed, our TOC is 0-indexed
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
      view.focus();
    };

    window.addEventListener('editor:goto-line', handler);
    return () => window.removeEventListener('editor:goto-line', handler);
  }, []);

  // F3: 查找与替换事件处理
  useEffect(() => {
    // 存储当前搜索的匹配列表和当前索引
    let currentMatches: Array<{ from: number; to: number; line: number }> = [];
    let currentMatchIdx = -1;

    const performSearch = (query: string) => {
      const view = viewRef.current;
      if (!view || !query) return;

      // 使用 setSearchQuery 设置搜索状态（会自动高亮所有匹配）
      const searchQuery = new SearchQuery({ search: query });
      view.dispatch({ effects: setSearchQuery.of(searchQuery) });

      // 用 SearchQuery.getCursor 遍历所有匹配
      const matches: Array<{ from: number; to: number; line: number }> = [];
      try {
        const cursor = searchQuery.getCursor(view.state);
        let iterResult = cursor.next();
        while (!iterResult.done) {
          const val = iterResult.value as { from: number; to: number };
          matches.push({
            from: val.from,
            to: val.to,
            line: view.state.doc.lineAt(val.from).number,
          });
          iterResult = cursor.next();
          if (matches.length >= 200) break;
        }
      } catch {
        // SearchCursor may fail on some patterns
      }

      currentMatches = matches;
      currentMatchIdx = matches.length > 0 ? 0 : -1;

      // 跳转到第一个匹配
      if (matches.length > 0) {
        view.dispatch({
          selection: { anchor: matches[0].from, head: matches[0].to },
          effects: EditorView.scrollIntoView(matches[0].from, { y: 'center' }),
        });
        view.focus();
      }

      sendResults(view, matches, 0);
    };

    const sendResults = (view: EditorView, matches: Array<{ from: number; to: number; line: number }>, idx: number) => {
      const results = matches.map((m) => {
        const lineInfo = view.state.doc.line(m.line);
        return {
          line: m.line,
          col: m.from - lineInfo.from,
          text: lineInfo.text,
          matchStart: m.from - lineInfo.from,
          matchEnd: m.to - lineInfo.from,
        };
      });
      window.dispatchEvent(new CustomEvent('editor:find-results', {
        detail: { results, currentIndex: idx, totalCount: matches.length },
      }));
    };

    const goNext = () => {
      const view = viewRef.current;
      if (!view || currentMatches.length === 0) return;
      currentMatchIdx = (currentMatchIdx + 1) % currentMatches.length;
      const m = currentMatches[currentMatchIdx];
      view.dispatch({
        selection: { anchor: m.from, head: m.to },
        effects: EditorView.scrollIntoView(m.from, { y: 'center' }),
      });
      view.focus();
      sendResults(view, currentMatches, currentMatchIdx);
    };

    const goPrev = () => {
      const view = viewRef.current;
      if (!view || currentMatches.length === 0) return;
      currentMatchIdx = currentMatchIdx <= 0 ? currentMatches.length - 1 : currentMatchIdx - 1;
      const m = currentMatches[currentMatchIdx];
      view.dispatch({
        selection: { anchor: m.from, head: m.to },
        effects: EditorView.scrollIntoView(m.from, { y: 'center' }),
      });
      view.focus();
      sendResults(view, currentMatches, currentMatchIdx);
    };

    const gotoMatch = (e: Event) => {
      const view = viewRef.current;
      const idx = (e as CustomEvent<{ index: number }>).detail?.index;
      if (typeof idx !== 'number' || !view || idx < 0 || idx >= currentMatches.length) return;
      currentMatchIdx = idx;
      const m = currentMatches[idx];
      view.dispatch({
        selection: { anchor: m.from, head: m.to },
        effects: EditorView.scrollIntoView(m.from, { y: 'center' }),
      });
      view.focus();
    };

    // Bug 6 修复：替换后跳转到下一个匹配，而不是跳回第一个
    const doReplaceNext = (e: Event) => {
      const view = viewRef.current;
      if (!view || currentMatches.length === 0 || currentMatchIdx < 0) return;
      const replacement = (e as CustomEvent<{ replacement: string }>).detail?.replacement || '';
      const m = currentMatches[currentMatchIdx];
      const replaceEnd = m.from + replacement.length;

      isExternalUpdate.current = true;
      view.dispatch({ changes: { from: m.from, to: m.to, insert: replacement } });
      requestAnimationFrame(() => { isExternalUpdate.current = false; });

      // 替换后重新搜索，但跳到替换位置之后的匹配
      setTimeout(() => {
        const q = getSearchQuery(view.state);
        if (!q || !q.search) return;

        const searchQuery = new SearchQuery({ search: q.search });
        view.dispatch({ effects: setSearchQuery.of(searchQuery) });

        // 重新收集所有匹配
        const matches: Array<{ from: number; to: number; line: number }> = [];
        try {
          const cursor = searchQuery.getCursor(view.state);
          let iterResult = cursor.next();
          while (!iterResult.done) {
            const val = iterResult.value as { from: number; to: number };
            matches.push({
              from: val.from,
              to: val.to,
              line: view.state.doc.lineAt(val.from).number,
            });
            iterResult = cursor.next();
            if (matches.length >= 200) break;
          }
        } catch {}

        currentMatches = matches;

        if (matches.length > 0) {
          // 找到替换位置之后的第一个匹配
          let nextIdx = matches.findIndex(match => match.from >= replaceEnd);
          if (nextIdx === -1) nextIdx = 0; // 没有后续匹配，循环回第一个
          currentMatchIdx = nextIdx;

          const nextMatch = matches[nextIdx];
          view.dispatch({
            selection: { anchor: nextMatch.from, head: nextMatch.to },
            effects: EditorView.scrollIntoView(nextMatch.from, { y: 'center' }),
          });
          view.focus();
          sendResults(view, matches, nextIdx);
        } else {
          currentMatchIdx = -1;
          sendResults(view, [], -1);
        }
      }, 0);
    };

    const doReplaceAll = (e: Event) => {
      const view = viewRef.current;
      if (!view || currentMatches.length === 0) return;
      const replacement = (e as CustomEvent<{ replacement: string }>).detail?.replacement || '';
      isExternalUpdate.current = true;
      // 从后往前替换，避免偏移
      const sorted = [...currentMatches].sort((a, b) => b.from - a.from);
      for (const m of sorted) {
        view.dispatch({ changes: { from: m.from, to: m.to, insert: replacement } });
      }
      requestAnimationFrame(() => { isExternalUpdate.current = false; });
      // 清除搜索状态
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
      window.dispatchEvent(new CustomEvent('editor:find-results', {
        detail: { results: [], currentIndex: -1, totalCount: 0, replaceCount: currentMatches.length },
      }));
    };

    const handlers: Array<[string, EventListener]> = [
      ['editor:find', ((e: Event) => {
        const query = (e as CustomEvent<{ query: string }>).detail?.query || '';
        performSearch(query);
      }) as EventListener],
      ['editor:find-next', goNext as EventListener],
      ['editor:find-prev', goPrev as EventListener],
      ['editor:goto-match', gotoMatch as EventListener],
      ['editor:replace-next', doReplaceNext as EventListener],
      ['editor:replace-all', doReplaceAll as EventListener],
    ];

    for (const [event, handler] of handlers) {
      window.addEventListener(event, handler);
    }
    return () => {
      for (const [event, handler] of handlers) {
        window.removeEventListener(event, handler);
      }
    };
  }, []);

  // Notify parent of content changes (for preview + TOC)
  useEffect(() => {
    onContentChange(content);
  }, [content, onContentChange]);

  return <div ref={containerRef} className="editor-pane" />;
}
