/** View mode for the editor/preview layout */
export type ViewMode = 'split' | 'editor' | 'preview';

/** Theme options */
export type Theme = 'light' | 'dark';

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
