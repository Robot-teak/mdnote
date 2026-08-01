import { isExtension } from '../lib/platform';
import { openUrl } from '../lib/platform';

// 插件版独立版本线（v0.1.8 起，不沿用桌面版版本号）；桌面版沿用各自版本
const CURRENT_VERSION = isExtension ? '0.1.8' : '0.4.1';
const GITHUB_REPO = 'https://github.com/Robot-teak/mdnote';
const GITHUB_AUTHOR = 'https://github.com/Robot-teak';

interface AboutDialogProps {
  onClose: () => void;
}

async function openLink(url: string) {
  await openUrl(url);
}

export default function AboutDialog({ onClose }: AboutDialogProps) {
  return (
    <div className="about-overlay" onClick={onClose}>
      <div className="about-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Close button */}
        <button className="about-close" onClick={onClose} title="Close">✕</button>

        {/* Icon & Title */}
        <img src={isExtension ? './icon.png' : '/icon.png'} alt="MDnote" className="about-icon" />
        <h1 className="about-title">MDnote</h1>
        {isExtension && <p className="about-subtitle">Chrome Extensions</p>}
        <p className="about-version">Version {CURRENT_VERSION}</p>

        {/* Description（插件版/桌面版分别说明，均为英文） */}
        <p className="about-description">
          {isExtension
            ? 'A clean Markdown editor for Chrome — edit, preview and export Markdown with live rendering.'
            : 'A lightweight, high-performance macOS Markdown editor.'}
          <br />
          {isExtension
            ? 'Built with Chrome Extensions (MV3) + React 18.'
            : 'Built with Tauri 2.0 + React 18.'}
        </p>

        {/* Tech stack */}
        <div className="about-tech">
          {isExtension ? (
            <>
              <span>Chrome MV3</span>
              <span>React 18</span>
              <span>CodeMirror 6</span>
              <span>markdown-it</span>
            </>
          ) : (
            <>
              <span>Tauri 2.0</span>
              <span>React 18</span>
              <span>CodeMirror 6</span>
              <span>markdown-it</span>
            </>
          )}
        </div>

        {/* Links */}
        <div className="about-links">
          <button className="about-link-btn" onClick={() => openLink(GITHUB_REPO)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            GitHub
          </button>
          <button className="about-link-btn" onClick={() => openLink(GITHUB_AUTHOR)}>
            👤 Robot-teak
          </button>
        </div>

        {/* Footer */}
        <p className="about-footer">
          {isExtension
            ? 'Made with ❤️ using Chrome Extensions + React'
            : 'Made with ❤️ using Tauri + React'}
        </p>
      </div>
    </div>
  );
}
