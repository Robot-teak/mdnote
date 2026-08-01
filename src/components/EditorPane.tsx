import { useRef, useEffect } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection, dropCursor, highlightActiveLine, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, selectAll } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap, indentUnit } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { oneDarkTheme } from '@codemirror/theme-one-dark';
import { search, setSearchQuery, getSearchQuery, SearchQuery } from '@codemirror/search';
import { autocompletion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { useAppStore } from '../store/useAppStore';
import { isExtension } from '../lib/platform';
import { readClipboard, writeClipboard } from '../lib/platform';
import { revokeBlobUrl } from '../lib/fileSystem';

// 模块级 Blob URL 跟踪（供 imageCompletionSource 和组件 cleanup 共享）
const trackedBlobUrls = new Set<string>();

/** 跟踪 Blob URL 以便后续清理 */
function trackBlobUrl(url: string): void {
  if (url.startsWith('blob:')) {
    trackedBlobUrls.add(url);
  }
}

/** 释放所有已跟踪的 Blob URL */
function revokeAllBlobUrls(): void {
  trackedBlobUrls.forEach((url) => revokeBlobUrl(url));
  trackedBlobUrls.clear();
}

// ─── F1: `[` 自动补全链接格式 ───

/** 判断光标是否在 `[]` 内部（空括号） */
function isInsideEmptyBrackets(view: EditorView, pos: number): boolean {
  const doc = view.state.doc;
  const before = doc.sliceString(Math.max(0, pos - 1), pos);
  const after = doc.sliceString(pos, pos + 1);
  return before === '[' && after === ']';
}

/** 判断光标是否在 `[]()` 结构的 `()` 内部且 `()` 为空 */
function isInsideEmptyParen(view: EditorView, pos: number): boolean {
  const doc = view.state.doc;
  // 向后查找 )( 模式
  const before = doc.sliceString(Math.max(0, pos - 50), pos + 1);
  const matchIdx = before.lastIndexOf('](');
  if (matchIdx === -1) return false;
  const parenStart = Math.max(0, pos - 50) + matchIdx + 2;
  if (pos < parenStart) return false;
  // 检查从 ( 到 ) 之间是否为空
  const afterParen = doc.sliceString(parenStart, parenStart + 100);
  const closeIdx = afterParen.indexOf(')');
  if (closeIdx < 0) return false;
  const content = afterParen.substring(0, closeIdx);
  return pos <= parenStart + closeIdx && content.trim() === '';
}

/** 判断光标是否在 `[]` 内部（无论有无内容）
 *  向后找 `[`，向前找 `]`，确保光标在两者之间
 */
function isInsideBrackets(view: EditorView, pos: number): boolean {
  const doc = view.state.doc;
  const line = doc.lineAt(pos);
  const lineText = line.text;
  const lineStart = line.from;

  // 在当前行内查找所有 `[` 和 `]` 的位置
  let openIdx = -1;
  for (let i = pos - lineStart - 1; i >= 0; i--) {
    if (lineText[i] === '[') {
      openIdx = i;
      break;
    }
    if (lineText[i] === ']') break; // 已在 [] 外
  }
  if (openIdx === -1) return false;

  for (let i = pos - lineStart; i < lineText.length; i++) {
    if (lineText[i] === ']') {
      // pos 在 [ 和 ] 之间
      return true;
    }
    if (lineText[i] === '[') break; // 嵌套的 [，不算
  }
  return false;
}

/** 判断光标是否在 `[]()` 结构的 `()` 内部（无论有无内容）
 *  查找前方的 `](` 模式，然后找到配对的 `)`
 */
function isInsideParen(view: EditorView, pos: number): boolean {
  const doc = view.state.doc;
  const line = doc.lineAt(pos);
  const lineText = line.text;
  const lineStart = line.from;
  const col = pos - lineStart;

  // 在当前行找 ]( 模式
  for (let i = col; i >= 0; i--) {
    if (i + 1 < lineText.length && lineText[i] === ']' && lineText[i + 1] === '(') {
      const parenOpen = i + 1; // ( 的列位置
      // 从 ( 开始找配对的 )
      let depth = 0;
      for (let j = parenOpen + 1; j < lineText.length; j++) {
        if (lineText[j] === '(') depth++;
        if (lineText[j] === ')') {
          if (depth === 0) {
            // 找到配对的 )
            return col > parenOpen && col < j;
          }
          depth--;
        }
      }
      break;
    }
  }
  return false;
}

/** F1: 拦截 `[` 按键，插入 `[]()` 并定位光标到 [] 内
 *  如果前一个字符是 `!`，则保留 `!`，在光标位置插入 `[]()` 并定位到 `[]` 内
 *  同时触发图片路径补全面板
 */
function handleOpenBracket(view: EditorView): boolean {
  const { from } = view.state.selection.main;
  const doc = view.state.doc;
  const charBefore = from > 0 ? doc.sliceString(from - 1, from) : '';

  if (charBefore === '!') {
    // `![` 模式：保留 `!`，在光标位置插入 `[]()` 并定位到 `[]` 内
    view.dispatch({
      changes: { from, insert: '[]()' },
      selection: { anchor: from + 1 },
    });
    // F2: 延迟触发图片补全面板
    const v = view;
    setTimeout(() => {
      try {
        import('@codemirror/autocomplete').then(({ startCompletion }) => {
          try { startCompletion(v); } catch { /* view may be destroyed */ }
        });
      } catch { /* ignore */ }
    }, 10);
    return true;
  }

  // 普通 `[` 模式：插入 `[]()` 并定位到 [] 内
  view.dispatch({
    changes: { from, insert: '[]()' },
    selection: { anchor: from + 1 },
  });
  return true;
}

/** F1: `]` 在空 `[]` 内时跳到 `()` 内 */
function handleCloseBracket(view: EditorView): boolean {
  const pos = view.state.selection.main.head;
  const doc = view.state.doc;

  if (isInsideEmptyBrackets(view, pos)) {
    const afterBracket = doc.sliceString(pos + 1, pos + 3);
    if (afterBracket === '()') {
      // 在空 [] 内输入 ]，跳到 () 内
      view.dispatch({
        changes: { from: pos, to: pos + 1, insert: ']' },
        selection: { anchor: pos + 2 },
      });
      return true;
    }
  }
  return false;
}

/** F1: Tab 在 `[]` 内跳到 `()` 内；在 `()` 内跳出 `)`
 *  支持有内容和无内容两种情况
 */
function handleTabJump(view: EditorView): boolean {
  const pos = view.state.selection.main.head;
  const doc = view.state.doc;

  // ── 在 `[]` 内 → 跳到 `()` 内 ──
  // 先检查空括号（快速路径）
  if (isInsideEmptyBrackets(view, pos)) {
    const afterBracket = doc.sliceString(pos + 1, pos + 3);
    if (afterBracket === '()') {
      view.dispatch({ selection: { anchor: pos + 2 } });
      return true;
    }
  }

  // 非空 [] 内 → 找到 ]( 后跳到 ( 内部
  if (isInsideBrackets(view, pos)) {
    const line = doc.lineAt(pos);
    const lineText = line.text;
    const col = pos - line.from;

    // 从光标位置向前找 ](
    for (let i = col; i < lineText.length; i++) {
      if (lineText[i] === ']' && i + 1 < lineText.length && lineText[i + 1] === '(') {
        // 跳到 ( 内部（即 ]( 之后的第一个字符位置）
        const targetPos = line.from + i + 2;
        view.dispatch({ selection: { anchor: targetPos } });
        return true;
      }
    }
  }

  // ── 在 `()` 内 → 跳出 `)` ──
  // 先检查空括号（快速路径）
  if (isInsideEmptyParen(view, pos)) {
    const afterCursor = doc.sliceString(pos, pos + 1);
    if (afterCursor === ')') {
      view.dispatch({ selection: { anchor: pos + 1 } });
      return true;
    }
  }

  // 非空 () 内 → 找到配对的 ) 后跳出
  if (isInsideParen(view, pos)) {
    const line = doc.lineAt(pos);
    const lineText = line.text;
    const col = pos - line.from;

    // 找到 ]( 模式，然后找配对的 )
    for (let i = col; i >= 0; i--) {
      if (i + 1 < lineText.length && lineText[i] === ']' && lineText[i + 1] === '(') {
        const parenOpen = i + 1;
        let depth = 0;
        for (let j = parenOpen + 1; j < lineText.length; j++) {
          if (lineText[j] === '(') depth++;
          if (lineText[j] === ')') {
            if (depth === 0) {
              // 找到配对的 )，跳到它后面
              view.dispatch({ selection: { anchor: line.from + j + 1 } });
              return true;
            }
            depth--;
          }
        }
        break;
      }
    }
  }

  return false;
}

// ─── F2: `![` 自动提示图片路径 ───

/** 从 localStorage 获取最近使用的图片路径 */
function getRecentImages(): string[] {
  try {
    const raw = localStorage.getItem('mdnote-recent-images');
    if (raw) return JSON.parse(raw) as string[];
  } catch { /* ignore */ }
  return [];
}

/** 保存图片路径到 localStorage（最近 10 条） */
function addRecentImage(path: string): void {
  const recent = getRecentImages().filter(p => p !== path);
  recent.unshift(path);
  if (recent.length > 10) recent.length = 10;
  try {
    localStorage.setItem('mdnote-recent-images', JSON.stringify(recent));
  } catch { /* ignore */ }
}

/** 计算相对路径或绝对路径 */
function resolveImagePath(absolutePath: string): string {
  try {
    const currentFilePath = useAppStore.getState().filePath;
    if (currentFilePath) {
      const currentDir = currentFilePath.substring(0, currentFilePath.lastIndexOf('/'));
      if (absolutePath.startsWith(currentDir + '/')) {
        return absolutePath.substring(currentDir.length + 1);
      }
    }
  } catch { /* ignore */ }
  return absolutePath;
}

/** F2: `![` 图片补全源
 *  检测光标是否在 ![] 内部（空方括号），且后方跟着 ()
 *  from 只覆盖 [] 内部（光标位置），apply 函数自定义插入逻辑
 */
function imageCompletionSource(context: CompletionContext): CompletionResult | null {
  const pos = context.pos;
  const doc = context.state.doc;

  // 检查光标前是否是 ![，光标后是否是 ]()
  const before2 = doc.sliceString(Math.max(0, pos - 2), pos);
  if (before2 !== '![') return null;

  const after3 = doc.sliceString(pos, pos + 3);
  if (after3 !== ']()') return null;

  const recentImages = getRecentImages();

  const options = [
    {
      label: '📁 选择图片文件…',
      detail: '从文件对话框选择',
      apply: (view: EditorView, _completion: any, _from: number, _to: number) => {
        // 删除整个 ![]() 结构，异步打开文件对话框后重新插入
        const currentPos = view.state.selection.main.head;
        const before = view.state.doc.sliceString(Math.max(0, currentPos - 2), currentPos);
        if (before !== '![') return;
        // 找到 ![ 的位置，覆盖到 ) 之后
        const bangPos = currentPos - 2;
        const closeParenPos = bangPos + 5; // ![]() 共 5 字符
        view.dispatch({
          changes: { from: bangPos, to: closeParenPos, insert: '' },
        });
        // 异步打开文件对话框
        (async () => {
          try {
            if (isExtension) {
              // 插件版：fileSystem.openImageFile
              const { openImageFile } = await import('../lib/fileSystem');
              const result = await openImageFile();
              if (result) {
                const fileName = result.name;
                // 插件版：无目录句柄时用 blob URL 作为 src（临时），提示用户
                addRecentImage(fileName);
                // 跟踪 Blob URL 以便后续清理
                trackBlobUrl(result.url);
                view.dispatch({
                  changes: { from: bangPos, insert: `![${fileName}](${result.url})` },
                  selection: { anchor: bangPos + 2 + fileName.length + 3 + result.url.length },
                });
              } else {
                // 用户取消，恢复 ![]()
                view.dispatch({
                  changes: { from: bangPos, insert: '![]()' },
                  selection: { anchor: bangPos + 2 },
                });
              }
            } else {
              // 桌面版：@tauri-apps/plugin-dialog
              const { open } = await import('@tauri-apps/plugin-dialog');
              const selected = await open({
                multiple: false,
                filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'] }],
              });
              if (selected) {
                const path = typeof selected === 'string' ? selected : selected;
                const relativePath = resolveImagePath(path);
                addRecentImage(path);
                const fileName = path.split('/').pop() || 'image';
                view.dispatch({
                  changes: { from: bangPos, insert: `![${fileName}](${relativePath})` },
                  selection: { anchor: bangPos + 2 + fileName.length + 3 + relativePath.length },
                });
              } else {
                // 用户取消，恢复 ![]()
                view.dispatch({
                  changes: { from: bangPos, insert: '![]()' },
                  selection: { anchor: bangPos + 2 },
                });
              }
            }
          } catch (err) {
            console.error('[MDnote] Image dialog failed:', err);
            // 出错也恢复 ![]()
            view.dispatch({
              changes: { from: bangPos, insert: '![]()' },
              selection: { anchor: bangPos + 2 },
            });
          }
        })();
      },
      type: 'function' as const,
    },
    ...recentImages.map(p => {
      const fileName = p.split('/').pop() || p;
      const relativePath = resolveImagePath(p);
      return {
        label: fileName,
        detail: p,
        apply: (view: EditorView, _completion: any, _from: number, _to: number) => {
          const currentPos = view.state.selection.main.head;
          const bangPos = currentPos - 2;
          const closeParenPos = bangPos + 5;
          view.dispatch({
            changes: { from: bangPos, to: closeParenPos, insert: `![${fileName}](${relativePath})` },
            selection: { anchor: bangPos + 2 + fileName.length + 3 + relativePath.length },
          });
        },
        type: 'function' as const,
      };
    }),
  ];

  return {
    from: pos,
    options: options as any,
    filter: false,
    validFor: () => true,
  };
}

// ─── F3: 表格快速生成 ───

/** F3: Enter 键在表头行时自动生成分隔线和内容行 */
function handleTableEnter(view: EditorView): boolean {
  const state = view.state;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const lineText = line.text;

  // 判断当前行是否是表头格式：包含 | 且不是分隔线行
  if (!lineText.includes('|')) return false;

  // 分隔线行匹配：| --- | --- | 或 |---|---| 等
  const strippedLine = lineText.replace(/\s/g, '');
  if (/^\|?[-:]+(\|[-:]+)*\|?$/.test(strippedLine)) return false;

  // 计算列数
  const pipeCount = (lineText.match(/\|/g) || []).length;
  let colCount: number;
  if (lineText.startsWith('|') && lineText.endsWith('|')) {
    colCount = pipeCount - 1;
  } else if (lineText.startsWith('|') || lineText.endsWith('|')) {
    colCount = pipeCount;
  } else {
    colCount = pipeCount + 1;
  }

  if (colCount < 1) return false;

  // 生成分隔线行和内容行
  const startsWithPipe = lineText.trimStart().startsWith('|');
  const endsWithPipe = lineText.trimEnd().endsWith('|');

  const separatorCells = Array(colCount).fill(' --- ');
  const contentCells = Array(colCount).fill('  ');

  let separatorLine: string;
  let contentLine: string;

  if (startsWithPipe && endsWithPipe) {
    separatorLine = '|' + separatorCells.join('|') + '|';
    contentLine = '|' + contentCells.join('|') + '|';
  } else if (startsWithPipe) {
    separatorLine = '|' + separatorCells.join('|');
    contentLine = '|' + contentCells.join('|');
  } else if (endsWithPipe) {
    separatorLine = separatorCells.join('|') + '|';
    contentLine = contentCells.join('|') + '|';
  } else {
    separatorLine = separatorCells.join('|');
    contentLine = contentCells.join('|');
  }

  const insert = '\n' + separatorLine + '\n' + contentLine;
  const insertPos = line.to;
  const contentLineStart = insertPos + 1 + separatorLine.length + 1;
  const firstCellOffset = startsWithPipe ? 1 : 0;
  const cursorPos = contentLineStart + firstCellOffset + 1;

  view.dispatch({
    changes: { from: insertPos, insert },
    selection: { anchor: cursorPos },
  });

  return true;
}

// ─── F4/F6: 设置相关的辅助函数 ───

/** 根据设置值获取缩进字符串 */
function getIndentStr(unit: string): string {
  switch (unit) {
    case '4spaces': return '    ';
    case 'tab': return '\t';
    default: return '  ';
  }
}

// applySettingsToCSS moved to App.tsx (global scope, always runs)

/** 根据 settings 生成 CM6 styleCompartment 的 theme 对象（直接用具体值，不用 CSS 变量）
 *  注意：不设置 whiteSpace — 让 CM6 的 lineWrapping 扩展处理换行控制
 */
function buildEditorStyleTheme(settings: { fontFamily: string; fontSize: number; lineHeight: number }) {
  return EditorView.theme({
    '&': {
      height: '100%',
      fontSize: `${settings.fontSize}px`,
      fontFamily: `'${settings.fontFamily}', Menlo, monospace`,
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: `'${settings.fontFamily}', Menlo, monospace`,
    },
    '.cm-content': {
      padding: '16px 24px',
      minHeight: '100%',
      lineHeight: String(settings.lineHeight),
    },
  });
}

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
  const settings = useAppStore((s) => s.settings);

  // 标记：是否是程序性更新（非用户输入）
  const isExternalUpdate = useRef(false);
  // CM6 主题 Compartment，用于动态切换亮/暗主题
  const themeCompartment = useRef(new Compartment());
  // F4: 字体/字号/行高 Compartment
  const styleCompartment = useRef(new Compartment());
  // F6: 缩进量 Compartment
  const indentCompartment = useRef(new Compartment());
  // F6: 自动换行 Compartment
  const lineWrappingCompartment = useRef(new Compartment());
  // F6: 行号 Compartment
  const lineNumbersCompartment = useRef(new Compartment());
  // F2: 自动补全 Compartment
  const autocompleteCompartment = useRef(new Compartment());

  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerScrollFixRef = useRef<{ view: EditorView; cleanup: () => void } | null>(null);

  // Initialize editor once
  useEffect(() => {
    if (!containerRef.current || viewRef.current) return;

    const isDark = theme === 'dark';
    const currentSettings = useAppStore.getState().settings;

    // applySettingsToCSS handled globally in App.tsx

    const extensions = [
      // F6: 行号 Compartment
      lineNumbersCompartment.current.of(currentSettings.showLineNumbers ? lineNumbers() : []),
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
      search(),
      // F3: 表格快速生成 Enter 拦截（必须在 defaultKeymap 之前，优先拦截）
      keymap.of([
        { key: 'Enter', run: handleTableEnter },
      ]),
      // F1: Tab 跳转 keymap（必须放在 indentWithTab 之前）
      keymap.of([
        { key: 'Tab', run: handleTabJump },
      ]),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      // F1: `[` 和 `]` 拦截 keymap
      keymap.of([
        { key: '[', run: handleOpenBracket },
        { key: ']', run: handleCloseBracket },
      ]),
      keymap.of([
        { key: 'Mod-a', run: selectAll },
        { key: 'Mod-x', run: (view: EditorView) => {
          const { from, to } = view.state.selection.main;
          if (from === to) return false;
          const text = view.state.sliceDoc(from, to);
          writeClipboard(text).catch(() => {
            navigator.clipboard.writeText(text).catch(() => {});
          });
          view.dispatch({ changes: { from, to }, selection: { anchor: from } });
          return true;
        }},
        { key: 'Mod-c', run: (view: EditorView) => {
          const { from, to } = view.state.selection.main;
          if (from === to) return false;
          const text = view.state.sliceDoc(from, to);
          writeClipboard(text).catch(() => {
            navigator.clipboard.writeText(text).catch(() => {});
          });
          return true;
        }},
        { key: 'Mod-v', run: (view: EditorView) => {
          const from = view.state.selection.main.from;
          readClipboard().then(text => {
            view.dispatch({
              changes: { from, insert: text },
              selection: { anchor: from + text.length },
            });
          }).catch(() => {
            navigator.clipboard.readText().then(text => {
              view.dispatch({
                changes: { from, insert: text },
                selection: { anchor: from + text.length },
              });
            }).catch(() => {});
          });
          return true;
        }},
        { key: 'Mod-f', run: () => true },
      ]),
      // F6: 自动换行 Compartment
      lineWrappingCompartment.current.of(currentSettings.autoWrap ? EditorView.lineWrapping : []),
      // F6: 缩进量 Compartment
      indentCompartment.current.of(indentUnit.of(getIndentStr(currentSettings.indentUnit))),
      // F4: 字体/字号/行高 Compartment（用具体值而非 CSS 变量，确保 CM6 正确渲染）
      styleCompartment.current.of(buildEditorStyleTheme(currentSettings)),
      // F2: 图片补全 Compartment
      autocompleteCompartment.current.of(autocompletion({
        override: [imageCompletionSource],
        activateOnTyping: true,
      })),
      // Theme extension via Compartment (dynamic reconfigure)
      themeCompartment.current.of(isDark ? oneDarkTheme : []),
      // Listen for changes → update store + notify parent
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          if (isExternalUpdate.current) return;
          const newContent = update.state.doc.toString();
          setContent(newContent);
          setDirty(true);
        }
      }),
      // 鼠标事件处理（用于同步预览 + Bug 7 修复右键选中整行问题）
      EditorView.domEventHandlers({
        click(_event: MouseEvent, view: EditorView) {
          if (useAppStore.getState().viewMode !== 'split') return false;
          const line = view.state.doc.lineAt(view.state.selection.main.head).number;
          const line0 = line - 1;
          if (syncTimer.current) clearTimeout(syncTimer.current);
          syncTimer.current = setTimeout(() => {
            window.dispatchEvent(new CustomEvent('editor:scroll-preview', { detail: { line: line0 } }));
          }, 100);
          return false;
        },
        mousedown(event: MouseEvent, _view: EditorView) {
          if (event.button === 2) {
            return true;
          }
          return false;
        },
      }),
      // 静态主题样式（不随设置变化的）
      EditorView.theme({
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
    const contentDOM = view.contentDOM;
    const scroller = view.scrollDOM;
    let scrollLockTop: number | null = null;
    let scrollLockTimer: ReturnType<typeof setTimeout> | null = null;
    let lastScrollTop = scroller.scrollTop;
    let scrolledRecently = false;
    let scrolledTimer: ReturnType<typeof setTimeout> | null = null;

    const handleScrollDetect = () => {
      if (Math.abs(scroller.scrollTop - lastScrollTop) > 1) {
        lastScrollTop = scroller.scrollTop;
        scrolledRecently = true;
        if (scrolledTimer) clearTimeout(scrolledTimer);
        scrolledTimer = setTimeout(() => { scrolledRecently = false; }, 1000);
      }
    };

    const handleScrollLock = () => {
      handleScrollDetect();
      if (scrollLockTop !== null && Math.abs(scroller.scrollTop - scrollLockTop) > 1) {
        scroller.scrollTop = scrollLockTop;
      }
    };

    const handleMouseUp = () => {
      if (scrollLockTimer) clearTimeout(scrollLockTimer);
      scrollLockTimer = setTimeout(() => {
        scrollLockTop = null;
        scrollLockTimer = null;
      }, 50);
    };

    let rightClickActive = false;

    const handleMouseDownCapture = (event: MouseEvent) => {
      if (event.button === 2) {
        event.preventDefault();
        event.stopImmediatePropagation();
        rightClickActive = true;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos !== null) {
          const { from, to } = view.state.selection.main;
          if (pos < from || pos > to) {
            view.dispatch({ selection: { anchor: pos } });
          }
        }
        setTimeout(() => { rightClickActive = false; }, 300);
        return;
      }

      // @ts-ignore
      const inputState = view.inputState;
      if (inputState) {
        inputState.lastSelectionOrigin = 'select.pointer';
        inputState.lastSelectionTime = Date.now();
      }

      if (scrolledRecently) {
        scrollLockTop = scroller.scrollTop;
        if (scrollLockTimer) clearTimeout(scrollLockTimer);
        scrollLockTimer = setTimeout(() => {
          scrollLockTop = null;
          scrollLockTimer = null;
        }, 150);
      }
    };

    const handleSelectStart = (event: Event) => {
      if (rightClickActive) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    contentDOM.addEventListener('mousedown', handleMouseDownCapture, true);
    contentDOM.addEventListener('selectstart', handleSelectStart, true);
    contentDOM.addEventListener('mouseup', handleMouseUp, true);
    scroller.addEventListener('scroll', handleScrollLock, true);

    pointerScrollFixRef.current = {
      view,
      cleanup: () => {
        contentDOM.removeEventListener('mousedown', handleMouseDownCapture, true);
        contentDOM.removeEventListener('selectstart', handleSelectStart, true);
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
      // 清理所有 Blob URL（防止内存泄漏）
      revokeAllBlobUrls();
    };
  }, []); // Only run once on mount

  // Sync external content changes (e.g., file open)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentContent = view.state.doc.toString();
    if (currentContent !== content) {
      isExternalUpdate.current = true;
      view.dispatch({
        changes: {
          from: 0,
          to: currentContent.length,
          insert: content,
        },
      });
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

  // F4/F6: 设置变化时动态 reconfigure CM6 扩展
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    // applySettingsToCSS handled globally in App.tsx

    // F4: 重新配置字体/字号/行高（用具体值，不用 CSS 变量）
    view.dispatch({
      effects: styleCompartment.current.reconfigure(buildEditorStyleTheme(settings)),
    });

    // F6: 重新配置缩进量
    view.dispatch({
      effects: indentCompartment.current.reconfigure(
        indentUnit.of(getIndentStr(settings.indentUnit))
      ),
    });

    // F6: 重新配置自动换行
    view.dispatch({
      effects: lineWrappingCompartment.current.reconfigure(
        settings.autoWrap ? EditorView.lineWrapping : []
      ),
    });

    // F6: 重新配置行号
    view.dispatch({
      effects: lineNumbersCompartment.current.reconfigure(
        settings.showLineNumbers ? lineNumbers() : []
      ),
    });
  }, [settings]);

  // Listen for TOC click events → scroll to line
  useEffect(() => {
    const handler = (e: Event) => {
      const view = viewRef.current;
      const detail = (e as CustomEvent<{ line: number }>).detail;
      const line = detail?.line;
      if (typeof line !== 'number' || !view) return;

      const pos = view.state.doc.line(line + 1).from;
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
    let currentMatches: Array<{ from: number; to: number; line: number }> = [];
    let currentMatchIdx = -1;

    const performSearch = (query: string) => {
      const view = viewRef.current;
      if (!view || !query) return;

      const searchQuery = new SearchQuery({ search: query });
      view.dispatch({ effects: setSearchQuery.of(searchQuery) });

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
      if (!view) return;
      if (currentMatches.length === 0) {
        const q = getSearchQuery(view.state);
        if (q && q.search) {
          performSearch(q.search);
        }
        return;
      }
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
      if (!view) return;
      if (currentMatches.length === 0) {
        const q = getSearchQuery(view.state);
        if (q && q.search) {
          performSearch(q.search);
        }
        return;
      }
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

    const doReplaceNext = (e: Event) => {
      const view = viewRef.current;
      if (!view || currentMatches.length === 0 || currentMatchIdx < 0) return;
      const replacement = (e as CustomEvent<{ replacement: string }>).detail?.replacement || '';
      const m = currentMatches[currentMatchIdx];

      const currentText = view.state.sliceDoc(m.from, m.to);
      const q = getSearchQuery(view.state);
      if (q && q.search && currentText !== q.search) {
        performSearch(q.search);
        return;
      }

      const replaceEnd = m.from + replacement.length;

      isExternalUpdate.current = true;
      view.dispatch({ changes: { from: m.from, to: m.to, insert: replacement } });

      const newContent = view.state.doc.toString();
      setContent(newContent);
      setDirty(true);

      requestAnimationFrame(() => { isExternalUpdate.current = false; });

      setTimeout(() => {
        const q = getSearchQuery(view.state);
        if (!q || !q.search) return;

        const searchQuery = new SearchQuery({ search: q.search });
        view.dispatch({ effects: setSearchQuery.of(searchQuery) });

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
          let nextIdx = matches.findIndex(match => match.from >= replaceEnd);
          if (nextIdx === -1) nextIdx = 0;
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
      const sorted = [...currentMatches].sort((a, b) => b.from - a.from);
      for (const m of sorted) {
        view.dispatch({ changes: { from: m.from, to: m.to, insert: replacement } });
      }

      const newContent = view.state.doc.toString();
      setContent(newContent);
      setDirty(true);

      requestAnimationFrame(() => { isExternalUpdate.current = false; });

      const q = getSearchQuery(view.state);
      if (q && q.search) {
        const searchQuery = new SearchQuery({ search: q.search });
        view.dispatch({ effects: setSearchQuery.of(searchQuery) });

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
        currentMatchIdx = matches.length > 0 ? 0 : -1;
        sendResults(view, matches, currentMatchIdx);
      } else {
        currentMatches = [];
        currentMatchIdx = -1;
        view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
        window.dispatchEvent(new CustomEvent('editor:find-results', {
          detail: { results: [], currentIndex: -1, totalCount: 0 },
        }));
      }
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
