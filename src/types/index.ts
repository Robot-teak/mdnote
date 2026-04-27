/** View mode for the editor/preview layout */
export type ViewMode = 'split' | 'editor' | 'preview';

/** Theme options */
export type Theme = 'light' | 'dark';

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
