import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore, useHydrated, onHydrated, hydrateFromStorage } from './store/useAppStore';
import './styles/globals.css';

// 安全组件
import WelcomeScreen from './components/WelcomeScreen';
import AboutDialog from './components/AboutDialog';
import SettingsDialog from './components/SettingsDialog';
import { ToastProvider, useToast } from './components/Toast';
import StatusBar from './components/StatusBar';

// hooks
import { useFileOps } from './hooks/useFileOps';
import { useAutoSave } from './hooks/useAutoSave';
import { useUnsavedConfirm } from './hooks/useUnsavedConfirm';
import { useShortcuts } from './hooks/useShortcuts';

// 子组件
import Toolbar from './components/Toolbar';
import TocSidebar from './components/TocSidebar';
import PreviewPane from './components/PreviewPane';
import Onboarding from './components/Onboarding';
import DraftRecoveryBar from './components/DraftRecoveryBar';

// platform 抽象层
import {
  isExtension,
  isDesktop,
  readFile,
  setWindowTitle,
  setupFileOpenListener,
  setupAboutListener,
  readClipboard,
  writeClipboard,
} from './lib/platform';

// ─── EditorPane 懒加载（CodeMirror 564KB）───

function LazyEditorPane(props: { onContentChange: (c: string) => void }) {
  const [C, setC] = useState<React.ComponentType<typeof props> | null>(null);
  useEffect(() => { import('./components/EditorPane').then(m => setC(() => m.default)); }, []);
  if (!C) return (
    <div className="pane editor-wrapper" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
      Loading editor…
    </div>
  );
  return <C {...props} />;
}

// ─── 错误边界 ───

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(p: { children: React.ReactNode }) {
    super(p);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(e: Error) {
    return { hasError: true, error: e };
  }
  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div style={{ padding: 20, color: '#c00', fontSize: 12, fontFamily: 'monospace', background: '#fff', minHeight: '100vh' }}>
        <h2>⚠️ MDnote Render Error</h2>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, background: '#f5f5f5', padding: 10, borderRadius: 4 }}>
          {this.state.error?.name}: {this.state.error?.message}
          {'\n\n'}
          {this.state.error?.stack}
        </pre>
      </div>
    );
  }
}

// ─── 通过文件路径打开文件（桌面版） / 通过内容打开（插件版）───

let lastOpenFilePath = '';
let lastOpenFileTime = 0;

/**
 * 通过文件路径打开文件（桌面版）。
 * 插件版不使用此函数（使用 openFileByContent）。
 */
async function openFileByPath(path: string) {
  try {
    // 去掉 file:// 前缀和可能的引号
    let cleanPath = path;
    if (cleanPath.startsWith('file://')) {
      cleanPath = decodeURIComponent(cleanPath.replace('file://', ''));
    }
    cleanPath = cleanPath.replace(/^\/+/, '/');
    cleanPath = cleanPath.replace(/^"|"$/g, '');

    // 2秒内同一路径的去重
    const now = Date.now();
    if (cleanPath === lastOpenFilePath && now - lastOpenFileTime < 2000) {
      console.log('[MDnote] Skipping duplicate file open:', cleanPath);
      if (isDesktop) {
        const { invoke } = await import('@tauri-apps/api/core');
        invoke('get_pending_file').catch(() => {});
      }
      return;
    }
    lastOpenFilePath = cleanPath;
    lastOpenFileTime = now;

    console.log('[MDnote] Opening file from path:', cleanPath);

    // 桌面版：当前窗口有内容 → 在新窗口打开
    const { useAppStore: store } = await import('./store/useAppStore');
    const state = store.getState();
    if (state.filePath === cleanPath) return;

    const hasContent = !state.isWelcome && (state.filePath !== null || state.content.length > 0);
    if (hasContent && isDesktop) {
      const theme = state.theme;
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_file_in_new_window', { path: cleanPath, theme });
      return;
    }

    // 使用 platform.readFile 读取文件
    const fileContent = await readFile(cleanPath);
    const { renderMarkdown, extractTocFromWorker } = await import('./lib/markdown-parser');

    store.getState().setFilePath(cleanPath);
    store.getState().setContent(fileContent);
    store.getState().setDirty(false);
    store.getState().setSaveState('disk-saved');
    store.getState().setViewMode('preview');

    const [html, tocItems] = await Promise.all([
      renderMarkdown(fileContent),
      extractTocFromWorker(fileContent),
    ]);
    store.getState().setHtmlPreview(html);
    store.getState().setTocItems(tocItems);
  } catch (err) {
    console.error('[MDnote] Failed to open file from path:', path, err);
  }
}

// ─── 更新窗口标题 ───

async function updateWindowTitle(filePath: string | null, isDirty: boolean) {
  try {
    let title = 'MDnote';
    if (filePath) {
      const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Untitled';
      title = `${fileName}${isDirty ? ' ●' : ''}`;
    }
    await setWindowTitle(title);
  } catch (err) {
    console.error('[MDnote] Failed to update window title:', err);
  }
}

// ─── AppInner: 所有业务逻辑 ───

function applySettingsToCSS(settings: {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  previewParagraphSpacing: string;
}): void {
  const root = document.documentElement;
  root.style.setProperty('--editor-font-family', `'${settings.fontFamily}', Menlo, monospace`);
  root.style.setProperty('--editor-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--editor-line-height', String(settings.lineHeight));
  root.style.setProperty('--preview-paragraph-spacing', settings.previewParagraphSpacing);
}

function AppInner() {
  const viewMode = useAppStore((s) => s.viewMode);
  const theme = useAppStore((s) => s.theme);
  const isWelcome = useAppStore((s) => s.isWelcome);
  const filePath = useAppStore((s) => s.filePath);
  const isDirty = useAppStore((s) => s.isDirty);
  const settings = useAppStore((s) => s.settings);
  const { showToast } = useToast();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 插件版：hydrate 阻塞渲染（S0-3 结论）
  const [hydrated, setHydrated] = useState(useHydrated());
  useEffect(() => {
    if (!hydrated) {
      const unsub = onHydrated(() => setHydrated(true));
      return unsub;
    }
  }, [hydrated]);

  // 插件版：启动时触发异步 hydrate
  useEffect(() => {
    if (isExtension) {
      hydrateFromStorage();
    }
  }, []);

  // Global: apply settings CSS variables
  useEffect(() => {
    applySettingsToCSS(settings);
  }, [settings]);

  // 桌面版：注册全局函数供 Rust eval() 调用
  useEffect(() => {
    if (!isDesktop) return;

    (window as any).__openFileByPath = (path: string) => {
      console.log('[MDnote] __openFileByPath called from Rust eval:', path);
      openFileByPath(path);
    };

    // macOS Edit 菜单事件处理
    (window as any).__handleEditCommand = async (cmd: string) => {
      const active = document.activeElement as HTMLElement;

      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        if (cmd === 'paste') {
          try {
            const text = await readClipboard();
            const input = active as HTMLInputElement;
            const start = input.selectionStart || 0;
            const end = input.selectionEnd || 0;
            const value = input.value;
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            )?.set || Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype, 'value'
            )?.set;
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(input, value.slice(0, start) + text + value.slice(end));
            } else {
              input.value = value.slice(0, start) + text + value.slice(end);
            }
            input.selectionStart = input.selectionEnd = start + text.length;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          } catch {}
        } else if (cmd === 'select-all') {
          document.execCommand('selectAll');
        } else {
          document.execCommand(cmd);
        }
        return;
      }

      // CM6 编辑器命令
      const cmEl = document.querySelector('.cm-editor') as any;
      if (cmEl && cmEl.cmView) {
        const view = cmEl.cmView.view;
        const { from, to } = view.state.selection.main;

        switch (cmd) {
          case 'copy': {
            if (from !== to) {
              const text = view.state.sliceDoc(from, to);
              try {
                await writeClipboard(text);
              } catch {
                navigator.clipboard.writeText(text).catch(() => {});
              }
            }
            break;
          }
          case 'cut': {
            if (from !== to) {
              const text = view.state.sliceDoc(from, to);
              try {
                await writeClipboard(text);
              } catch {
                navigator.clipboard.writeText(text).catch(() => {});
              }
              view.dispatch({ changes: { from, to }, selection: { anchor: from } });
            }
            break;
          }
          case 'paste': {
            try {
              const text = await readClipboard();
              view.dispatch({
                changes: { from: view.state.selection.main.from, insert: text },
              });
            } catch {
              navigator.clipboard.readText().then(text => {
                view.dispatch({
                  changes: { from: view.state.selection.main.from, insert: text },
                });
              }).catch(() => {});
            }
            break;
          }
          case 'undo': {
            const { undo } = await import('@codemirror/commands');
            undo(view);
            break;
          }
          case 'redo': {
            const { redo } = await import('@codemirror/commands');
            redo(view);
            break;
          }
          case 'select-all': {
            view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
            break;
          }
        }
      }
    };

    return () => {
      delete (window as any).__openFileByPath;
      delete (window as any).__handleEditCommand;
    };
  }, []);

  // 获取 file ops（含 openFileByContent 用于插件版）
  const { openFile, openFileByContent, newDocument, saveAs, directSave, updatePreview } = useFileOps();
  // 自动保存：60s 周期 + 内容变化后 3s 快速保存（快捷键保存统一走 handleSave，见下）
  const { scheduleQuickSave } = useAutoSave();

  // 插件版：新标签页恢复"待打开文件"（#1 内容脚本接管 .md / #4 New·Open 多标签页）
  useEffect(() => {
    if (!isExtension || !hydrated) return;
    let cancelled = false;
    (async () => {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
        const res = await chrome.storage.local.get('mdnote-pending-open');
        const pending = res['mdnote-pending-open'] as
          | { draftId?: string; name?: string; content?: string; path?: string; url?: string }
          | undefined;
        if (!pending || cancelled) return;
        await chrome.storage.local.remove('mdnote-pending-open');

        if (pending.draftId) {
          // #4：从 IndexedDB 恢复内容 + 句柄
          const { getDraft, getHandle } = await import('./lib/indexeddb');
          const draft = await getDraft(pending.draftId);
          const h = await getHandle(pending.draftId);
          if (!draft || cancelled) return;
          const state = useAppStore.getState();
          state.setContent(draft.content);
          state.setFilePath(pending.path ?? draft.meta.filePath ?? draft.meta.name);
          state.setFileHandle(h?.handle ?? null);
          state.setDraftId(pending.draftId);
          state.setDirty(false);
          state.setSaveState('disk-saved');
          state.setViewMode('preview');
          const { renderMarkdown, extractTocFromWorker } = await import('./lib/markdown-parser');
          const [html, toc] = await Promise.all([
            renderMarkdown(draft.content),
            extractTocFromWorker(draft.content),
          ]);
          state.setHtmlPreview(html);
          state.setTocItems(toc);
        } else if (typeof pending.content === 'string') {
          // #1：内容脚本读取的 .md 文件内容（从 URL 解析完整路径供左下角显示）
          let fullPath: string | undefined;
          if (typeof pending.url === 'string' && pending.url.startsWith('file://')) {
            try {
              fullPath = decodeURIComponent(pending.url.replace('file://', ''));
            } catch {
              fullPath = undefined;
            }
          }
          await openFileByContent(pending.content, pending.name || 'Opened File.md', fullPath);
        }
      } catch (err) {
        console.error('[MDnote] Pending open restore failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrated, openFileByContent]);

  useUnsavedConfirm();
  // 快捷键保存走 handleSave（与工具栏一致：有句柄写回、无句柄另存为）
  // 注意：不能直接用 saveNow——它无句柄时只存草稿，与工具栏保存行为不一致
  // useShortcuts({ onSave: saveNow });（移到 handleSave 定义之后）

  // 文件打开监听（双产物线：platform.setupFileOpenListener）
  useEffect(() => {
    let mounted = true;
    let cleanup: (() => void) | null = null;

    setupFileOpenListener((pathOrContent: string, isContent: boolean) => {
      if (!mounted) return;
      if (isContent) {
        // 插件版：通过内容打开
        openFileByContent(pathOrContent, 'Opened File.md');
      } else {
        // 桌面版：通过路径打开
        openFileByPath(pathOrContent);
      }
    }).then((fn) => {
      cleanup = fn;
    }).catch((err) => {
      console.warn('[MDnote] File open listener setup failed:', err);
    });

    // 桌面版：检查启动参数
    if (isDesktop) {
      (async () => {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const args = await invoke<string[]>('get_cli_args').catch(() => null);
          if (args && args.length > 1) {
            for (let i = 1; i < args.length; i++) {
              const arg = args[i];
              if (arg.endsWith('.md') || arg.endsWith('.markdown') || arg.endsWith('.txt')) {
                openFileByPath(arg);
                break;
              }
            }
          }
        } catch {}
      })();
    }

    // 桌面版：URL 参数处理（F2 新窗口）
    if (isDesktop) {
      const params = new URLSearchParams(window.location.search);
      const filePathParam = params.get('file');
      const themeParam = params.get('theme');
      if (themeParam === 'dark' || themeParam === 'light') {
        useAppStore.getState().setTheme(themeParam);
      }
      if (filePathParam) {
        const cleanPath = decodeURIComponent(filePathParam);
        console.log('[MDnote] Opening file from URL param:', cleanPath);
        openFileByPath(cleanPath);
      }
    }

    return () => {
      mounted = false;
      cleanup?.();
    };
  }, []);

  // About 对话框监听（双产物线：platform.setupAboutListener）
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    setupAboutListener(() => {
      setAboutOpen(true);
    }).then((fn) => {
      cleanup = fn;
    }).catch(() => {});
    return () => cleanup?.();
  }, []);

  // 监听文件路径和脏状态变化，更新窗口标题
  useEffect(() => {
    updateWindowTitle(filePath, isDirty);
  }, [filePath, isDirty]);

  // 智能保存
  const handleSave = useCallback(async () => {
    try {
      let ok = false;
      if (filePath) {
        ok = await directSave();
      } else {
        ok = await saveAs();
      }
      // 用户取消保存时不提示"Saved!"（问题 3：取消后不应显示已保存）
      if (ok) {
        showToast('Saved!', 'success');
      } else {
        showToast('Save cancelled', 'info');
      }
    } catch (err) {
      console.error('[MDnote] Save failed:', err);
      showToast('Save failed', 'error');
    }
  }, [filePath, directSave, saveAs, showToast]);

  // 快捷键保存（与工具栏行为一致）
  useShortcuts({ onSave: handleSave });

  // 内容变化 → 预览+TOC 更新（150ms 防抖）
  // 注意：不要在这里 setDirty——dirty 只由 EditorPane 的 updateListener（用户编辑）
  // 设置。否则打开文件/切换视图模式挂载编辑器时会误置"未保存"。
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleContentChange = useCallback((newContent: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const scrollEl = document.querySelector('.preview-pane');
    const currentScrollTop = scrollEl ? scrollEl.scrollTop : 0;
    const { setSavedScrollTop } = useAppStore.getState();
    setSavedScrollTop(currentScrollTop);

    debounceRef.current = setTimeout(() => {
      updatePreview(newContent);
    }, 150);

    // 内容变化 → 3s 后快速自动保存（草稿/写盘），防刷新丢内容（performSave 内部有 isDirty 检查）
    scheduleQuickSave();
  }, [updatePreview, scheduleQuickSave]);

  // TOC 点击跳转
  const handleTocJump = useCallback((line: number) => {
    window.dispatchEvent(new CustomEvent('editor:goto-line', { detail: { line } }));
    window.dispatchEvent(new CustomEvent('preview:scroll-to-heading', { detail: { line } }));
  }, []);

  // 插件版：hydrate 未完成时显示加载界面
  if (isExtension && !hydrated) {
    return (
      <div className="app-container" data-theme={theme} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <div style={{ color: '#999', fontSize: 14 }}>Loading MDnote…</div>
      </div>
    );
  }

  return (
    <div className="app-container" data-view-mode={viewMode} data-theme={theme}>
      {/* 工具栏 */}
      <Toolbar onSave={handleSave} hasFile={!!filePath} isDirty={isDirty} onAboutOpen={setAboutOpen} onSettingsOpen={setSettingsOpen} />

      {/* 草稿恢复提示条（#3，插件版欢迎页） */}
      {isExtension && isWelcome && <DraftRecoveryBar />}

      <div className="main-area">
        {/* TOC 侧栏 */}
        <TocSidebar onHeadingClick={handleTocJump} onOpenFile={openFile} onOpenFileByContent={openFileByContent} />

        {/* 主内容 */}
        <main className="editor-preview-container">
          {isWelcome ? (
            <WelcomeScreen onOpenFile={openFile} onNewDocument={newDocument} />
          ) : (
            <>
              {/* 编辑器 */}
              {viewMode !== 'preview' && (
                <div className="pane editor-wrapper">
                  <LazyEditorPane onContentChange={handleContentChange} />
                </div>
              )}
              {/* 预览 */}
              {viewMode !== 'editor' && (
                <div className="pane preview-wrapper">
                  <PreviewPane />
                </div>
              )}
            </>
          )}
        </main>
      </div>

      <StatusBar />

      {/* About Dialog */}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}

      {/* Settings Dialog */}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}

      {/* Onboarding 首次引导（仅插件版） */}
      <Onboarding />
    </div>
  );
}

// ─── App: 只负责包 ToastProvider + ErrorBoundary ───

export default function App() {
  return (
    <AppErrorBoundary>
      <ToastProvider>
        <AppInner />
      </ToastProvider>
    </AppErrorBoundary>
  );
}
