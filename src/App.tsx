import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from './store/useAppStore';
import './styles/globals.css';

// 安全组件
import WelcomeScreen from './components/WelcomeScreen';
import AboutDialog from './components/AboutDialog';
import { ToastProvider, useToast } from './components/Toast';
import StatusBar from './components/StatusBar';

// hooks（内部已用动态 import @tauri-apps/api）
import { useFileOps } from './hooks/useFileOps';
import { useAutoSave } from './hooks/useAutoSave';
import { useUnsavedConfirm } from './hooks/useUnsavedConfirm';
import { useShortcuts } from './hooks/useShortcuts';

// 子组件
import Toolbar from './components/Toolbar';
import TocSidebar from './components/TocSidebar';
import PreviewPane from './components/PreviewPane';

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

// ─── 通过文件路径打开文件的公共方法 ───

async function openFileByPath(path: string) {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // 去掉 file:// 前缀和可能的引号
    let cleanPath = path;
    if (cleanPath.startsWith('file://')) {
      cleanPath = decodeURIComponent(cleanPath.replace('file://', ''));
    }
    // macOS file:///path → /path（三个斜杠变一个）
    cleanPath = cleanPath.replace(/^\/+/, '/');
    // Tauri event payload 可能带引号
    cleanPath = cleanPath.replace(/^"|"$/g, '');
    console.log('[MDnote] Opening file from path:', cleanPath);
    const fileContent = await invoke<string>('read_file', { path: cleanPath });
    const { renderMarkdown, extractTocFromWorker } = await import('./lib/markdown-parser');
    const { useAppStore: store } = await import('./store/useAppStore');

    store.getState().setFilePath(cleanPath);
    store.getState().setContent(fileContent);
    store.getState().setDirty(false);
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
    const { invoke } = await import('@tauri-apps/api/core');
    let title = 'MDnote';
    if (filePath) {
      // 提取文件名（只显示文件名，不要后面的 -MDnote）
      const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Untitled';
      title = `${fileName}${isDirty ? ' ●' : ''}`;
    }
    await invoke('set_window_title', { title });
  } catch (err) {
    console.error('[MDnote] Failed to update window title:', err);
  }
}

// ─── AppInner: 所有业务逻辑在这里（在 ToastProvider 内部）───

function AppInner() {
  const viewMode = useAppStore((s) => s.viewMode);
  const theme = useAppStore((s) => s.theme);
  const isWelcome = useAppStore((s) => s.isWelcome);
  const filePath = useAppStore((s) => s.filePath);
  const isDirty = useAppStore((s) => s.isDirty);
  const { showToast } = useToast();
  const [aboutOpen, setAboutOpen] = useState(false);

  // 注册全局函数，供 Rust 端 window.eval() 调用
  useEffect(() => {
    (window as any).__openFileByPath = (path: string) => {
      console.log('[MDnote] __openFileByPath called from Rust eval:', path);
      openFileByPath(path);
    };
    return () => { delete (window as any).__openFileByPath; };
  }, []);

  // ─── 监听 macOS 原生 About 菜单事件 ───
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen('show-about-dialog', () => {
          setAboutOpen(true);
        });
      } catch (e) {
        console.warn('[MDnote] Could not listen for show-about-dialog:', e);
      }
    })();
    return () => { unlisten?.(); };
  }, []);

  // 所有 hooks 正常调用
  const { openFile, newDocument, saveAs, directSave, updatePreview } = useFileOps();
  const { saveNow } = useAutoSave();

  useUnsavedConfirm();

  useShortcuts({ onSave: saveNow });

  // ─── 监听 macOS 文件关联打开事件 ───
  useEffect(() => {
    let mounted = true;

    async function setupFileOpenListener() {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        
        // 1. 立即查询 pending file（应用刚通过"打开方式"启动时）
        const pendingFile = await invoke<string | null>('get_pending_file').catch(() => null);
        if (pendingFile && mounted) {
          console.log('[MDnote] Found pending file on startup:', pendingFile);
          openFileByPath(pendingFile);
        }

        // 2. 注册 emit 事件监听（应用已在运行时，再打开新文件）
        try {
          const tauri = (window as any).__TAURI__;
          if (tauri?.event?.listen) {
            await tauri.event.listen('open-file-path', (event: any) => {
              if (!mounted) return;
              const payload = event.payload;
              console.log('[MDnote] Received open-file-path event:', payload);
              if (payload) openFileByPath(String(payload));
            });
          } else {
            const { listen } = await import('@tauri-apps/api/event');
            await listen<string>('open-file-path', (event) => {
              if (!mounted) return;
              if (event.payload) openFileByPath(event.payload);
            });
          }
        } catch (e) {
          console.warn('[MDnote] Could not set up event listener:', e);
        }

        // 3. 轮询检查（每2秒，最多10次）—— 作为 emit 事件的兜底
        let pollCount = 0;
        const MAX_POLL_COUNT = 10;
        const pollInterval = setInterval(async () => {
          if (!mounted) { clearInterval(pollInterval); return; }
          pollCount++;
          if (pollCount > MAX_POLL_COUNT) {
            console.log('[MDnote] Poll limit reached, stopping polling');
            clearInterval(pollInterval);
            return;
          }
          try {
            const file = await invoke<string | null>('get_pending_file').catch(() => null);
            if (file && mounted) {
              console.log('[MDnote] Poll found pending file:', file);
              clearInterval(pollInterval); // 找到文件后停止轮询
              openFileByPath(file);
            }
          } catch {}
        }, 2000);

        // 4. 监听拖拽文件
        try {
          const { listen } = await import('@tauri-apps/api/event');
          await listen<string[]>('tauri://file-drop', (event) => {
            if (!mounted) return;
            const files = event.payload;
            if (files && files.length > 0) {
              const file = files[0];
              if (file.endsWith('.md') || file.endsWith('.markdown') || file.endsWith('.txt') || file.endsWith('.mkd')) {
                openFileByPath(file);
              }
            }
          });
        } catch {}

        // 5. 检查启动参数
        const args = await invoke<string[]>('get_cli_args').catch(() => null);
        if (args && args.length > 1 && !pendingFile) {
          for (let i = 1; i < args.length; i++) {
            const arg = args[i];
            if (arg.endsWith('.md') || arg.endsWith('.markdown') || arg.endsWith('.txt')) {
              openFileByPath(arg);
              break;
            }
          }
        }
      } catch (e) {
        console.error('[MDnote] setupFileOpenListener failed:', e);
      }
    }

    setupFileOpenListener();
    return () => { mounted = false; };
  }, []);

  // 监听文件路径和脏状态变化，更新窗口标题
  useEffect(() => {
    updateWindowTitle(filePath, isDirty);
  }, [filePath, isDirty]);

  // 智能保存
  const handleSave = useCallback(async () => {
    try {
      if (filePath) {
        await directSave();
        showToast('Saved!', 'success');
      } else {
        await saveAs();
      }
    } catch (err) {
      console.error('[MDnote] Save failed:', err);
      showToast('Save failed', 'error');
    }
  }, [filePath, directSave, saveAs, showToast]);

  // 内容变化 → 预览+TOC 更新（150ms 防抖）
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleContentChange = useCallback((newContent: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      updatePreview(newContent);
    }, 150);
  }, [updatePreview]);

  // TOC 点击跳转
  const handleTocJump = useCallback((line: number) => {
    window.dispatchEvent(new CustomEvent('editor:goto-line', { detail: { line } }));
    window.dispatchEvent(new CustomEvent('preview:scroll-to-heading', { detail: { line } }));
  }, []);

  return (
    <div className="app-container" data-view-mode={viewMode} data-theme={theme}>
      {/* 工具栏 */}
      <Toolbar onSave={handleSave} hasFile={!!filePath} isDirty={isDirty} onAboutOpen={setAboutOpen} />

      <div className="main-area">
        {/* TOC 侧栏 */}
        <TocSidebar onHeadingClick={handleTocJump} />

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

      {/* About Dialog — 从 Toolbar 或 macOS 菜单触发 */}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
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
