import { useState, useEffect } from 'react';
import { isExtension } from '../lib/platform';

/**
 * Onboarding 首次引导组件（S25）
 *
 * 首次打开 editor.html 时显示引导：
 * - 工具栏图标位置说明
 * - 如何打开文件
 * - 快捷键提示
 *
 * 首次标记存 chrome.storage.local（onboardingShown: true），仅显示一次。
 * 仅插件版显示（isExtension 守卫）。
 */
export default function Onboarding() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isExtension) return;

    let cancelled = false;
    (async () => {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
        const result = await chrome.storage.local.get('onboardingShown');
        if (!cancelled && !result.onboardingShown) {
          setShow(true);
        }
      } catch {
        // chrome.storage 不可用时跳过引导
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleDismiss = async () => {
    setShow(false);
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({ onboardingShown: true });
      }
    } catch {
      // 忽略
    }
  };

  if (!show) return null;

  return (
    <div
      className="onboarding-overlay"
      onClick={handleDismiss}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        zIndex: 99998,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--mf-bg-primary, #fff)',
          borderRadius: 12,
          padding: '32px 40px',
          maxWidth: 460,
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
          color: 'var(--mf-text-primary, #1a1a2e)',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <h2 style={{ fontSize: '1.4rem', marginBottom: 16 }}>
          Welcome to MDnote! 👋
        </h2>

        <div style={{ fontSize: '0.9rem', lineHeight: 1.7, marginBottom: 20 }}>
          <p style={{ marginBottom: 12 }}>
            <strong>📂 Open a file:</strong> Click the <strong>Open</strong> button in the toolbar,
            or drag a <code>.md</code> file onto this page.
          </p>
          <p style={{ marginBottom: 12 }}>
            <strong>⌨️ Quick start:</strong>
          </p>
          <ul style={{ listStyle: 'none', padding: 0, marginBottom: 12 }}>
            <li style={{ padding: '4px 0' }}>
              <kbd style={kbdStyle}>⌘O</kbd> Open file &nbsp;·&nbsp;
              <kbd style={kbdStyle}>⌘S</kbd> Save
            </li>
            <li style={{ padding: '4px 0' }}>
              <kbd style={kbdStyle}>⌘⌥1/2/3</kbd> Editor / Split / Preview
            </li>
            <li style={{ padding: '4px 0' }}>
              <kbd style={kbdStyle}>⌘⇧T</kbd> Toggle theme &nbsp;·&nbsp;
              <kbd style={kbdStyle}>⌘⇧P</kbd> Print / PDF
            </li>
            <li style={{ padding: '4px 0' }}>
              <kbd style={kbdStyle}>⌘⇧M</kbd> Open MDnote (global shortcut)
            </li>
          </ul>
          <p style={{ marginBottom: 0, color: 'var(--mf-text-muted, #666)', fontSize: '0.8rem' }}>
            💡 Your drafts auto-save every 60 seconds. No internet connection required —
            everything works offline.
          </p>
        </div>

        <button
          onClick={handleDismiss}
          style={{
            width: '100%',
            padding: '10px 20px',
            background: 'var(--mf-accent, #3b82f6)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            fontSize: '0.9rem',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Got it, let's start! ✨
        </button>
      </div>
    </div>
  );
}

const kbdStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 6px',
  background: 'var(--mf-bg-tertiary, #f0f0f0)',
  border: '1px solid var(--mf-border, #ddd)',
  borderRadius: 4,
  fontSize: '0.75rem',
  fontFamily: 'monospace',
  margin: '0 2px',
};
