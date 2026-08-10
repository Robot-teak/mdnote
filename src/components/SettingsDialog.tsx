import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { EditorSettings, SplitLayout } from '../types';
import {
  AUTO_SAVE_INTERVAL_OPTIONS,
  INLINE_AUTO_SAVE_MIN_INTERVAL,
  PREVIEW_FONT_OPTIONS,
  PREVIEW_FONT_SIZE_MAX,
  PREVIEW_FONT_SIZE_MIN,
  formatAutoSaveInterval,
} from '../lib/constants';
import { isExtension, isIframe } from '../lib/platform';

interface SettingsDialogProps {
  onClose: () => void;
}

/** Tab 标识 */
type TabKey = 'editor' | 'preview' | 'behavior' | 'autosave';

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'editor', label: 'Editor' },
  { key: 'preview', label: 'Preview' },
  { key: 'behavior', label: 'Behavior' },
  { key: 'autosave', label: 'Auto-Save' },
];

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

const SPLIT_LAYOUT_OPTIONS: Array<{ value: SplitLayout; label: string }> = [
  { value: 'editor-left', label: 'Editor Left · Preview Right' },
  { value: 'editor-right', label: 'Preview Left · Editor Right' },
];

/**
 * Settings dialog — modal panel for editor customization.
 *
 * v0.2.1：从单页长表单重构为 4 个 tab（Editor / Preview / Behavior / Auto-Save），
 * 遵循 WAI-ARIA tabs 模式（role=tablist/tab/tabpanel + 左右方向键导航）。
 * Style follows AboutDialog's overlay/dialog pattern using CSS variables.
 */
export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const resetSettings = useAppStore((s) => s.resetSettings);

  const [activeTab, setActiveTab] = useState<TabKey>('editor');
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({
    editor: null,
    preview: null,
    behavior: null,
    autosave: null,
  });

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

  /** tablist 左右方向键导航（WAI-ARIA tabs 模式） */
  const handleTabKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') {
      return;
    }
    e.preventDefault();
    const currentIndex = TABS.findIndex((t) => t.key === activeTab);
    let nextIndex = currentIndex;
    if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
    else if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % TABS.length;
    else if (e.key === 'Home') nextIndex = 0;
    else nextIndex = TABS.length - 1;

    const nextKey = TABS[nextIndex].key;
    setActiveTab(nextKey);
    tabRefs.current[nextKey]?.focus();
  }, [activeTab]);

  const isCustomFont = !FONT_OPTIONS.slice(0, -1).includes(settings.fontFamily);

  // inline（iframe）模式下自动保存间隔有 15s 下限护栏，需要向用户说明
  const inlineFloorApplies =
    isExtension && isIframe &&
    settings.autoSaveInterval > 0 &&
    settings.autoSaveInterval < INLINE_AUTO_SAVE_MIN_INTERVAL;

  return (
    <div className="about-overlay" onClick={onClose}>
      <div
        className="settings-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        style={{ width: 520, textAlign: 'left' }}
      >
        {/* Close button */}
        <button className="about-close" onClick={onClose} title="Close">✕</button>

        <h2 className="settings-title">Settings</h2>

        {/* ── Tab navigation ── */}
        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              ref={(el) => { tabRefs.current[tab.key] = el; }}
              type="button"
              role="tab"
              id={`settings-tab-${tab.key}`}
              aria-selected={activeTab === tab.key}
              aria-controls={`settings-panel-${tab.key}`}
              tabIndex={activeTab === tab.key ? 0 : -1}
              className={`settings-tab${activeTab === tab.key ? ' active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
              onKeyDown={handleTabKeyDown}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Editor tab ── */}
        {activeTab === 'editor' && (
          <div
            className="settings-tabpanel"
            role="tabpanel"
            id="settings-panel-editor"
            aria-labelledby="settings-tab-editor"
          >
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
          </div>
        )}

        {/* ── Preview tab ── */}
        {activeTab === 'preview' && (
          <div
            className="settings-tabpanel"
            role="tabpanel"
            id="settings-panel-preview"
            aria-labelledby="settings-tab-preview"
          >
            {/* Preview Font Family */}
            <label className="settings-row">
              <span className="settings-label">Preview Font</span>
              <div className="settings-control">
                <select
                  className="settings-select"
                  value={settings.previewFontFamily}
                  onChange={(e) => updateSettings({ previewFontFamily: e.target.value })}
                >
                  {PREVIEW_FONT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </label>

            {/* Preview Font Size */}
            <label className="settings-row">
              <span className="settings-label">Preview Font Size</span>
              <div className="settings-control">
                <input
                  type="range"
                  min={PREVIEW_FONT_SIZE_MIN}
                  max={PREVIEW_FONT_SIZE_MAX}
                  step={1}
                  value={settings.previewFontSize}
                  onChange={(e) => updateSettings({ previewFontSize: Number(e.target.value) })}
                  className="settings-slider"
                />
                <span className="settings-value">{settings.previewFontSize}px</span>
              </div>
            </label>

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

            <p className="settings-note">
              Code blocks and tables scale with the preview font size.
            </p>
          </div>
        )}

        {/* ── Behavior tab ── */}
        {activeTab === 'behavior' && (
          <div
            className="settings-tabpanel"
            role="tabpanel"
            id="settings-panel-behavior"
            aria-labelledby="settings-tab-behavior"
          >
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

            {/* Split Layout */}
            <label className="settings-row">
              <span className="settings-label">Split Layout</span>
              <div className="settings-control">
                <select
                  className="settings-select"
                  value={settings.splitLayout}
                  onChange={(e) => updateSettings({ splitLayout: e.target.value as SplitLayout })}
                >
                  {SPLIT_LAYOUT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </label>

            <p className="settings-note">
              Split layout applies to Split view only — switch to Split (⌘⌥2) to see it.
            </p>
          </div>
        )}

        {/* ── Auto-Save tab ── */}
        {activeTab === 'autosave' && (
          <div
            className="settings-tabpanel"
            role="tabpanel"
            id="settings-panel-autosave"
            aria-labelledby="settings-tab-autosave"
          >
            <label className="settings-row">
              <span className="settings-label">Auto-Save</span>
              <div className="settings-control">
                <select
                  className="settings-select"
                  value={settings.autoSaveInterval}
                  onChange={(e) => updateSettings({ autoSaveInterval: Number(e.target.value) })}
                >
                  {AUTO_SAVE_INTERVAL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </label>

            <p className="settings-note">
              {settings.autoSaveInterval > 0
                ? `Documents are saved automatically every ${formatAutoSaveInterval(settings.autoSaveInterval)}, plus 3s after you stop typing.`
                : 'Auto-save is off — nothing is written to disk until you save manually (⌘S).'}
            </p>

            {inlineFloorApplies && (
              <p className="settings-note settings-note-warning">
                In the embedded (in-page) editor the interval is clamped to{' '}
                {formatAutoSaveInterval(INLINE_AUTO_SAVE_MIN_INTERVAL)} because saving goes
                through the page bridge, which times out after 15s.
              </p>
            )}
          </div>
        )}

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
