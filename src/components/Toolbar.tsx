import { useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { ViewMode } from '../types';
import { useToast } from './Toast';
import { useFileOps } from '../hooks/useFileOps';

interface ToolbarProps {
  onSave?: () => void | Promise<void>;
  onSaveAs?: () => void | Promise<void>;
  hasFile?: boolean;
  isDirty?: boolean;
}

/**
 * Top toolbar with view mode toggle buttons,
 * theme switch, export menu, and save button.
 */
export default function Toolbar({ onSave, hasFile = false, isDirty = false }: ToolbarProps) {
  const {
    viewMode, setViewMode,
    theme, toggleTheme,
    tocVisible, toggleTOC,
  } = useAppStore();
  const { showToast } = useToast();
  const { openFile, newDocument } = useFileOps();

  const handleExportHTML = useCallback(async () => {
    try {
      const { exportAsHTML } = await import('../lib/markdown-parser');
      const { content: mdContent } = useAppStore.getState();
      const html = await exportAsHTML(mdContent, theme);

      const { invoke } = await import('@tauri-apps/api/core');
      const path = await invoke<string | null>('save_dialog', { defaultName: 'document.html' });
      if (path) {
        // Bug8 修复：确保文件后缀是 .html
        const htmlPath = path.replace(/\.(md|markdown|txt)$/i, '.html');
        await invoke('write_file', { path: htmlPath, content: html });
        showToast('HTML exported!', 'success');
      }
    } catch (err) {
      console.error('[MDnote] Export HTML failed:', err);
      showToast('Failed to export HTML', 'error');
    }
  }, [theme, showToast]);

  // 导出 PDF：先生成带打印样式的 HTML，保存为临时文件，用系统浏览器打开让用户打印为 PDF
  const handleExportPDF = useCallback(async () => {
    try {
      const { exportAsHTML } = await import('../lib/markdown-parser');
      const { invoke } = await import('@tauri-apps/api/core');
      const { content: mdContent, theme: currentTheme } = useAppStore.getState();
      
      // 生成带打印样式的完整 HTML
      const html = await exportAsHTML(mdContent, currentTheme);
      
      // 添加打印专用 CSS
      const printHtml = html.replace(
        '</head>',
        `<style>
          @media print {
            body { margin: 0; padding: 20px; }
          }
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        </style></head>`
      );

      // 调用 Rust 端导出：打开浏览器打印对话框
      await invoke('export_pdf', { html: printHtml, outputPath: 'unused' });
      // 准确提示：已在浏览器中打开，用户可在浏览器中选择"Save as PDF"
      showToast('Opened in browser — use Print → Save as PDF', 'info');
    } catch (err) {
      console.error('[MDnote] Export PDF failed:', err);
      showToast('Failed to export PDF: ' + String(err), 'error');
    }
  }, [showToast]);

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        {/* App logo / name */}
        <span className="toolbar-logo">MDnote</span>

        {/* File operations */}
        <div className="toolbar-file-ops" role="group" aria-label="File operations">
          <button className="toolbar-btn" onClick={newDocument} title="New Document (⌘N)">
            📄 New
          </button>
          <button className="toolbar-btn" onClick={openFile} title="Open File (⌘O)">
            📂 Open
          </button>
          {onSave && (
            <button
              className={`toolbar-btn ${isDirty ? 'dirty' : ''}`}
              onClick={onSave}
              title={hasFile ? 'Save (⌘S)' : 'Save As…'}
            >
              💾 {hasFile ? 'Save' : 'Save…'}
            </button>
          )}
        </div>
      </div>

      <div className="toolbar-center">
        {/* View mode toggle group */}
        <div className="view-toggle-group" role="group" aria-label="View mode">
          <button
            className={`toolbar-btn ${viewMode === 'editor' ? 'active' : ''}`}
            onClick={() => setViewMode('editor' as ViewMode)}
            title="Editor Only (⌘⌥1)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5"/>
              <line x1="5" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1"/>
              <line x1="5" y1="9" x2="10" y2="9" stroke="currentColor" strokeWidth="1"/>
            </svg>
          </button>
          <button
            className={`toolbar-btn ${viewMode === 'split' ? 'active' : ''}`}
            onClick={() => setViewMode('split' as ViewMode)}
            title="Split View (⌘⌥2)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5"/>
              <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="1"/>
            </svg>
          </button>
          <button
            className={`toolbar-btn ${viewMode === 'preview' ? 'active' : ''}`}
            onClick={() => setViewMode('preview' as ViewMode)}
            title="Preview Only (⌘⌥3)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5"/>
              <circle cx="7" cy="6" r="2" fill="currentColor" opacity="0.4"/>
              <rect x="4" y="9" width="8" height="2" rx="0.5" fill="currentColor" opacity="0.3"/>
              <rect x="5" y="12" width="6" height="1" rx="0.25" fill="currentColor" opacity="0.2"/>
            </svg>
          </button>
        </div>

        {/* TOC toggle */}
        <button
          className={`toolbar-btn ${tocVisible ? 'active' : ''}`}
          onClick={toggleTOC}
          title="Toggle Outline (Sidebar)"
        >
          ☰
        </button>
      </div>

      <div className="toolbar-right">
        {/* Theme toggle */}
        <button
          className="toolbar-btn"
          onClick={toggleTheme}
          title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} theme (⌘⇧T)`}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>

        {/* Export dropdown */}
        <div className="toolbar-dropdown">
          <button className="toolbar-btn" title="Export document">
            ⬇ Export
          </button>
          <div className="dropdown-menu">
            <button className="dropdown-item" onClick={handleExportHTML}>
              📄 Export as HTML (⌘⇧H)
            </button>
            <button className="dropdown-item" onClick={handleExportPDF}>
              🖨 Export as PDF (⌘⇧P)
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
