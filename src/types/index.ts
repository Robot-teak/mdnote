/** View mode for the editor/preview layout */
export type ViewMode = 'split' | 'editor' | 'preview';

/** Theme options */
export type Theme = 'light' | 'dark';

/**
 * Split-view layout direction.
 * - 'editor-left'  : 编辑器在左、预览在右（默认，历史行为）
 * - 'editor-right' : 编辑器在右、预览在左（CSS `.split-reversed` 实现）
 */
export type SplitLayout = 'editor-left' | 'editor-right';

/** Editor settings persisted to localStorage */
export interface EditorSettings {
  fontFamily: string;           // 默认 'SF Mono'
  fontSize: number;             // 默认 14 (px)
  lineHeight: number;           // 默认 1.5
  indentUnit: '2spaces' | '4spaces' | 'tab';  // 默认 '2spaces'
  codeBlockTheme: string;       // 默认 'github'
  codeBlockThemeManuallySet: boolean;  // 用户是否手动选择过代码块主题
  previewParagraphSpacing: string; // 默认 '1em'
  autoWrap: boolean;            // 默认 true
  showLineNumbers: boolean;     // 默认 true
  autoThemeFollow: boolean;     // 默认 true

  // ── v0.2.1 新增（老配置缺字段时由 DEFAULT_EDITOR_SETTINGS 兜底，无需迁移脚本）──

  /** 双屏模式下编辑器/预览的左右顺序，默认 'editor-left' */
  splitLayout: SplitLayout;
  /**
   * 自动保存间隔（毫秒）。**0 = 完全不自动保存**（周期保存与 3s 快捷保存一并停）。
   * 这是自动保存开关的唯一真源，StatusBar 勾选框只是它的派生视图。
   */
  autoSaveInterval: number;
  /** 预览区字号（px），独立于编辑器字号，默认 16 */
  previewFontSize: number;
  /**
   * 预览区字体族 token（见 constants.PREVIEW_FONT_OPTIONS），默认 'system'。
   * 'editor' 表示跟随编辑器字体（v0.2.1 之前的历史行为）。
   */
  previewFontFamily: string;
}

/** Default editor settings */
export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontFamily: 'SF Mono',
  fontSize: 14,
  lineHeight: 1.5,
  indentUnit: '2spaces',
  codeBlockTheme: 'github',
  codeBlockThemeManuallySet: false,
  previewParagraphSpacing: '1em',
  autoWrap: true,
  showLineNumbers: true,
  autoThemeFollow: true,
  splitLayout: 'editor-left',
  autoSaveInterval: 60_000,
  previewFontSize: 16,
  previewFontFamily: 'system',
};

/** Table of Contents item extracted from Markdown headings */
export interface TocItem {
  id: string;
  level: number; // 1-6
  text: string;
  line: number;
  position: number;
}

/** TOC tree node (for hierarchical rendering) */
export interface TocTreeNode extends TocItem {
  children: TocTreeNode[];
  collapsed: boolean;
}

/** File metadata for recent files */
export interface FileMeta {
  name: string;
  path: string;
  modified: number;
}

/** Worker incoming messages (main → worker) */
export type WorkerIncomingMessage =
  | { type: 'RENDER'; payload: string }
  | { type: 'EXTRACT_TOC'; payload: string }
  | { type: 'EXPORT_HTML'; payload: { md: string; theme: Theme } };

/** Worker outgoing messages (worker → main) */
export type WorkerOutgoingMessage =
  | { type: 'RENDER_DONE'; html: string }
  | { type: 'EXTRACT_TOC_DONE'; items: TocItem[] }
  | { type: 'EXPORT_HTML_DONE'; html: string }
  | { type: 'ERROR'; message: string };
