import { useRef, useEffect } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { oneDarkTheme } from '@codemirror/theme-one-dark';
import { useAppStore } from '../store/useAppStore';

import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';

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
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSpecialChars(),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      EditorView.lineWrapping,
      // Theme extension (oneDark for dark mode)
      isDark ? oneDarkTheme : [],
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

    return () => {
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

  // Notify parent of content changes (for preview + TOC)
  useEffect(() => {
    onContentChange(content);
  }, [content, onContentChange]);

  return <div ref={containerRef} className="editor-pane" />;
}
