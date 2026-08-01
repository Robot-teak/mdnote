import { useEffect, useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { EditorSettings } from '../types';

interface SettingsDialogProps {
  onClose: () => void;
}

const FONT_OPTIONS = [
  'SF Mono',
  'Fira Code',
  'JetBrains Mono',
  'Menlo',
  'Monaco',
  'Consolas',
  'monospace',  // System monospace
  'custom',     // Custom font
];

const LINE_HEIGHT_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1.2, label: '1.2' },
  { value: 1.5, label: '1.5' },
  { value: 1.8, label: '1.8' },
  { value: 2.0, label: '2.0' },
];

const CODE_THEME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'github', label: 'GitHub' },
  { value: 'github-dark', label: 'GitHub Dark' },
  { value: 'monokai', label: 'Monokai' },
  { value: 'atom-one-dark', label: 'Atom One Dark' },
  { value: 'vs', label: 'VS' },
  { value: 'vs2015', label: 'VS 2015' },
];

const PARAGRAPH_SPACING_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '0.5em', label: 'Compact (0.5em)' },
  { value: '1em', label: 'Standard (1em)' },
  { value: '1.5em', label: 'Relaxed (1.5em)' },
  { value: '2em', label: 'Spacious (2em)' },
];

const INDENT_OPTIONS: Array<{ value: EditorSettings['indentUnit']; label: string }> = [
  { value: '2spaces', label: '2 Spaces' },
  { value: '4spaces', label: '4 Spaces' },
  { value: 'tab', label: 'Tab' },
];

/**
 * Settings dialog — modal panel for editor customization.
 * Style follows AboutDialog's overlay/dialog pattern using CSS variables.
 */
export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const resetSettings = useAppStore((s) => s.resetSettings);

  // Close on Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleReset = useCallback(() => {
    resetSettings();
  }, [resetSettings]);

  const handleCustomFontConfirm = useCallback((customFont: string) => {
    if (customFont.trim()) {
      updateSettings({ fontFamily: customFont.trim() });
    }
  }, [updateSettings]);

  const isCustomFont = !FONT_OPTIONS.slice(0, -1).includes(settings.fontFamily);

  return (
    <div className="about-overlay" onClick={onClose}>
      <div
        className="settings-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 480, textAlign: 'left' }}
      >
        {/* Close button */}
        <button className="about-close" onClick={onClose} title="Close">✕</button>

        <h2 style={{
          fontSize: 18,
          fontWeight: 700,
          color: 'var(--mf-text-primary)',
          margin: '0 0 20px',
          textAlign: 'center',
        }}>
          Settings
        </h2>

        {/* ── Editor Style ── */}
        <fieldset className="settings-section">
          <legend className="settings-section-title">Editor Style</legend>

          {/* Font */}
          <label className="settings-row">
            <span className="settings-label">Font</span>
            <div className="settings-control">
              <select
                className="settings-select"
                value={isCustomFont ? 'custom' : settings.fontFamily}
                onChange={(e) => {
                  if (e.target.value === 'custom') {
                    const custom = prompt('Enter custom font name:', settings.fontFamily);
                    if (custom) handleCustomFontConfirm(custom);
                  } else {
                    updateSettings({ fontFamily: e.target.value });
                  }
                }}
              >
                {FONT_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {f === 'monospace' ? 'System Monospace' : f === 'custom' ? 'Custom Font…' : f}
                  </option>
                ))}
              </select>
              {isCustomFont && (
                <span className="settings-hint">Current: {settings.fontFamily}</span>
              )}
            </div>
          </label>

          {/* Font Size */}
          <label className="settings-row">
            <span className="settings-label">Font Size</span>
            <div className="settings-control">
              <input
                type="range"
                min={12}
                max={24}
                step={1}
                value={settings.fontSize}
                onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
                className="settings-slider"
              />
              <span className="settings-value">{settings.fontSize}px</span>
            </div>
          </label>

          {/* Line Height */}
          <label className="settings-row">
            <span className="settings-label">Line Height</span>
            <div className="settings-control">
              <select
                className="settings-select"
                value={LINE_HEIGHT_OPTIONS.some((o) => o.value === settings.lineHeight) ? settings.lineHeight : 'custom'}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === 'custom') {
                    const custom = prompt('Enter custom line height (e.g. 1.6):', String(settings.lineHeight));
                    if (custom) {
                      const num = parseFloat(custom);
                      if (!isNaN(num) && num >= 1 && num <= 3) {
                        updateSettings({ lineHeight: num });
                      }
                    }
                  } else {
                    updateSettings({ lineHeight: Number(val) });
                  }
                }}
              >
                {LINE_HEIGHT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
                <option value="custom">Custom…</option>
              </select>
              {!LINE_HEIGHT_OPTIONS.some((o) => o.value === settings.lineHeight) && (
                <span className="settings-hint">Current: {settings.lineHeight}</span>
              )}
            </div>
          </label>

          {/* Code Block Theme */}
          <label className="settings-row">
            <span className="settings-label">Code Theme</span>
            <div className="settings-control">
              <select
                className="settings-select"
                value={settings.codeBlockTheme}
                onChange={(e) => updateSettings({ codeBlockTheme: e.target.value, codeBlockThemeManuallySet: true })}
              >
                {CODE_THEME_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </label>

          {/* Follow System Theme */}
          <label className="settings-row settings-row-checkbox">
            <span className="settings-label">Follow System Theme</span>
            <div className="settings-control">
              <input
                type="checkbox"
                checked={settings.autoThemeFollow}
                onChange={(e) => updateSettings({ autoThemeFollow: e.target.checked })}
                className="settings-checkbox"
              />
            </div>
          </label>
        </fieldset>

        {/* ── Preview Style ── */}
        <fieldset className="settings-section">
          <legend className="settings-section-title">Preview Style</legend>

          {/* Paragraph Spacing */}
          <label className="settings-row">
            <span className="settings-label">Paragraph Spacing</span>
            <div className="settings-control">
              <select
                className="settings-select"
                value={settings.previewParagraphSpacing}
                onChange={(e) => updateSettings({ previewParagraphSpacing: e.target.value })}
              >
                {PARAGRAPH_SPACING_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </label>
        </fieldset>

        {/* ── Editor Behavior ── */}
        <fieldset className="settings-section">
          <legend className="settings-section-title">Editor Behavior</legend>

          {/* Indent */}
          <label className="settings-row">
            <span className="settings-label">Indent</span>
            <div className="settings-control">
              <select
                className="settings-select"
                value={settings.indentUnit}
                onChange={(e) => updateSettings({ indentUnit: e.target.value as EditorSettings['indentUnit'] })}
              >
                {INDENT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </label>

          {/* Word Wrap */}
          <label className="settings-row settings-row-checkbox">
            <span className="settings-label">Word Wrap</span>
            <div className="settings-control">
              <input
                type="checkbox"
                checked={settings.autoWrap}
                onChange={(e) => updateSettings({ autoWrap: e.target.checked })}
                className="settings-checkbox"
              />
            </div>
          </label>

          {/* Show Line Numbers */}
          <label className="settings-row settings-row-checkbox">
            <span className="settings-label">Line Numbers</span>
            <div className="settings-control">
              <input
                type="checkbox"
                checked={settings.showLineNumbers}
                onChange={(e) => updateSettings({ showLineNumbers: e.target.checked })}
                className="settings-checkbox"
              />
            </div>
          </label>
        </fieldset>

        {/* ── Footer ── */}
        <div className="settings-footer">
          <button className="settings-btn-secondary" onClick={handleReset}>
            Reset Defaults
          </button>
          <button className="settings-btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
