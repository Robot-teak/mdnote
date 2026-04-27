

/**
 * Welcome screen shown when no file is open.
 * Provides quick-start actions and keyboard shortcut hints.
 */
interface WelcomeScreenProps {
  onOpenFile: () => void;
  onNewDocument: () => void;
}

export default function WelcomeScreen({ onOpenFile, onNewDocument }: WelcomeScreenProps) {
  return (
    <div className="welcome-screen">
      <div className="welcome-content">
        <div className="welcome-logo">📝</div>
        <h1 className="welcome-title">Welcome to MDnote</h1>
        <p className="welcome-subtitle">
          A lightweight, fast Markdown editor for macOS.
        </p>

        <div className="welcome-actions">
          <button className="btn btn-primary" onClick={onOpenFile}>
            📂 Open File
          </button>
          <button className="btn btn-secondary" onClick={onNewDocument}>
            ➕ New Document
          </button>
        </div>

        <div className="welcome-shortcuts">
          <h3>Keyboard Shortcuts</h3>
          <dl className="shortcut-list">
            <dt>⌘⌥1 / ⌘⌥2 / ⌘⌥3</dt><dd>Editor / Split / Preview</dd>
            <dt>⌘⇧T</dt><dd>Toggle Theme</dd>
            <dt>⌘S</dt><dd>Auto-save (or Save As if unsaved)</dd>
            <dt>⌘⇧H</dt><dd>Export as HTML</dd>
            <dt>⌘⇧P</dt><dd>Print / Export as PDF</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
