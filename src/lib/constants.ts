/** Keyboard shortcut key definitions */
export const SHORTCUTS = {
  VIEW_EDITOR: { key: '1', ctrl: true, alt: true, meta: true },
  VIEW_SPLIT: { key: '2', ctrl: true, alt: true, meta: true },
  VIEW_PREVIEW: { key: '3', ctrl: true, alt: true, meta: true },
  TOGGLE_THEME: { key: 't', ctrl: true, shift: true, meta: true },
  SAVE_AS: { key: 's', ctrl: true, shift: true, meta: true },
  EXPORT_HTML: { key: 'h', ctrl: true, shift: true, meta: true },
  EXPORT_PDF: { key: 'p', ctrl: true, shift: true, meta: true },
} as const;

/** Auto-save interval: 1 minute */
export const AUTO_SAVE_INTERVAL = 60_000;

/** Preview render debounce in ms */
export const PREVIEW_DEBOUNCE = 100;

/** Max lines for TOC extraction safety limit */
export const TOC_MAX_ITEMS = 10_000;

/** Virtual scroll overscan buffer (items above/below viewport) */
export const VIRTUAL_SCROLL_OVERSCAN = 5;

/** Default window title */
export const APP_NAME = 'MDnote';

/** Supported file extensions for open dialog */
export const SUPPORTED_EXTENSIONS = ['md', 'txt', 'markdown'];
