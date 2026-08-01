import { useCallback, useState, useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { ViewMode } from '../types';
import { useToast } from './Toast';
import { useFileOps } from '../hooks/useFileOps';
import { isExtension } from '../lib/platform';

interface ToolbarProps {
  onSave?: () => void | Promise<void>;
  onSaveAs?: () => void | Promise<void>;
  hasFile?: boolean;
  isDirty?: boolean;
  onAboutOpen?: (open: boolean) => void;
  onSettingsOpen?: (open: boolean) => void;
}

/**
 * Top toolbar with view mode toggle buttons,
 * theme switch, export menu, and save button.
 */
export default function Toolbar({ onSave, hasFile = false, isDirty = false, onAboutOpen, onSettingsOpen }: ToolbarProps) {
  const {
    viewMode, setViewMode,
    theme, toggleTheme,
    tocVisible, toggleTOC,
  } = useAppStore();
  const { showToast } = useToast();
  const { openFile, newDocument } = useFileOps();

  // Export dropdown open state
  const [exportDropdownOpen, setExportDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setExportDropdownOpen(false);
      }
    }

    if (exportDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [exportDropdownOpen]);

  // Close dropdown on Escape key
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setExportDropdownOpen(false);
      }
    }

    if (exportDropdownOpen) {
      document.addEventListener('keydown', handleEscape);
    }
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [exportDropdownOpen]);

  const handleExportHTML = useCallback(async () => {
    setExportDropdownOpen(false);
    try {
      const { exportAsHTML } = await import('../lib/markdown-parser');
      const { content: mdContent } = useAppStore.getState();
      const html = await exportAsHTML(mdContent, theme);

      if (isExtension) {
        // 插件版：Blob + chrome.downloads.download
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        if (typeof chrome !== 'undefined' && chrome.downloads) {
          await chrome.downloads.download({
            url,
            filename: 'document.html',
            saveAs: true,
          });
        } else {
          // 降级：打开新窗口
          window.open(url, '_blank');
        }
        // 延迟释放（下载需要时间）
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        showToast('HTML exported!', 'success');
      } else {
        // 桌面版：save_dialog + write_file
        const { saveDialog } = await import('../lib/platform');
        const result = await saveDialog(html, { suggestedName: 'document.html' });
        if (result) {
          showToast('HTML exported!', 'success');
        }
      }
    } catch (err) {
      console.error('[MDnote] Export HTML failed:', err);
      showToast('Failed to export HTML', 'error');
    }
  }, [theme, showToast]);

  // 导出 PDF：插件版用 window.print()；桌面版用原 invoke('export_pdf')
  const handleExportPDF = useCallback(async () => {
    setExportDropdownOpen(false);
    try {
      const { exportAsHTML } = await import('../lib/markdown-parser');
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

      if (isExtension) {
        // 插件版：打开新窗口 + 调用 print
        const printWindow = window.open('', '_blank');
        if (printWindow) {
          printWindow.document.write(printHtml);
          printWindow.document.close();
          printWindow.focus();
          setTimeout(() => printWindow.print(), 300);
          showToast('Print dialog opened — use Save as PDF', 'info');
        } else {
          showToast('Please allow popups to export PDF', 'warning');
        }
      } else {
        // 桌面版：调用 Rust 端导出
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('export_pdf', { html: printHtml, outputPath: 'unused' });
        showToast('Opened in browser — use Print → Save as PDF', 'info');
      }
    } catch (err) {
      console.error('[MDnote] Export PDF failed:', err);
      showToast('Failed to export PDF: ' + String(err), 'error');
    }
  }, [showToast]);

  const handleExportToggle = () => {
    setExportDropdownOpen(!exportDropdownOpen);
  };

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        {/* App logo / name — click to show About */}
        <span className="toolbar-logo" onClick={() => onAboutOpen?.(true)} title="About MDnote">MDnote</span>

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
        {/* Settings button */}
        <button
          className="toolbar-btn"
          onClick={() => onSettingsOpen?.(true)}
          title="Settings"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6.968 0L6.24 2.676a5.5 5.5 0 00-1.098.634L2.522 2.16.49 5.676l2.058 1.62a5.5 5.5 0 000 1.268L.49 10.184l2.032 3.516 2.62-1.15a5.5 5.5 0 001.098.634L6.968 15.86h2.064l.728-2.676a5.5 5.5 0 001.098-.634l2.62 1.15 2.032-3.516-2.058-1.62a5.5 5.5 0 000-1.268l2.058-1.62-2.032-3.516-2.62 1.15a5.5 5.5 0 00-1.098-.634L9.032 0H6.968zM8 5.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5z"/>
          </svg>
        </button>

        {/* Theme toggle */}
        <button
          className="toolbar-btn"
          onClick={toggleTheme}
          title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} theme (⌘⇧T)`}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>

        {/* Export dropdown - click to show, click outside to hide */}
        <div className="toolbar-dropdown" ref={dropdownRef}>
          <button 
            className={`toolbar-btn ${exportDropdownOpen ? 'active' : ''}`}
            onClick={handleExportToggle}
            title="Export document"
          >
            ⬇ Export
          </button>
          {exportDropdownOpen && (
            <div className="dropdown-menu">
              <button className="dropdown-item" onClick={handleExportHTML}>
                📄 Export as HTML (⌘⇧H)
              </button>
              <button className="dropdown-item" onClick={handleExportPDF}>
                🖨 Export as PDF (⌘⇧P)
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
