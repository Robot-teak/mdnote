import { create } from 'zustand';
import type { ViewMode, Theme, TocItem } from '../types';

interface AppState {
  /** Current document content (raw markdown) */
  content: string;
  /** Full file path on disk, null = unsaved new document */
  filePath: string | null;
  /** Whether there are unsaved changes */
  isDirty: boolean;
  /** Display file name (derived from path or "Untitled") */
  fileName: string;
  /** Current view layout mode */
  viewMode: ViewMode;
  /** Current theme */
  theme: Theme;
  /** Whether the TOC sidebar is visible */
  tocVisible: boolean;
  /** Extracted table of contents */
  tocItems: TocItem[];
  /** Rendered HTML preview */
  htmlPreview: string;
  /** Is the preview currently loading/rendering */
  isPreviewLoading: boolean;
  /** Whether to show the welcome screen (true = initial launch, no user action yet) */
  isWelcome: boolean;
  /** Whether auto-save is enabled (default: false) */
  autoSaveEnabled: boolean;

  // Actions
  setContent: (content: string) => void;
  setFilePath: (path: string | null) => void;
  setDirty: (dirty: boolean) => void;
  setFileName: (name: string) => void;
  setViewMode: (mode: ViewMode) => void;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  toggleTOC: () => void;
  setTocVisible: (visible: boolean) => void;
  setTocItems: (items: TocItem[]) => void;
  setHtmlPreview: (html: string) => void;
  setIsPreviewLoading: (loading: boolean) => void;
  setAutoSaveEnabled: (enabled: boolean) => void;

  /** Reset all state to defaults (new document), and exit welcome mode */
  resetState: () => void;
}

const initialState = {
  content: '',
  filePath: null as string | null,
  isDirty: false,
  fileName: 'Untitled',
  viewMode: 'split' as ViewMode,
  theme: (localStorage.getItem('mdnote-theme') as Theme) || 'light',
  tocVisible: true,
  tocItems: [] as TocItem[],
  htmlPreview: '',
  isPreviewLoading: false,
  isWelcome: true,
  autoSaveEnabled: false,
};

export const useAppStore = create<AppState>((set, get) => ({
  ...initialState,

  setContent: (content: string) => set({ content, isWelcome: false }),
  setFilePath: (path: string | null) => {
    set({
      filePath: path,
      fileName: path ? path.split('/').pop() || path.split('\\').pop() || 'Untitled' : 'Untitled',
    });
  },
  setDirty: (dirty: boolean) => set({ isDirty: dirty }),
  setFileName: (name: string) => set({ fileName: name }),
  setViewMode: (mode: ViewMode) => set({ viewMode: mode }),

  toggleTheme: () => {
    const current = get().theme;
    const next: Theme = current === 'light' ? 'dark' : 'light';
    localStorage.setItem('mdnote-theme', next);
    document.documentElement.setAttribute('data-theme', next);
    set({ theme: next });
  },

  setTheme: (theme: Theme) => {
    localStorage.setItem('mdnote-theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    set({ theme });
  },

  toggleTOC: () => set((s) => ({ tocVisible: !s.tocVisible })),
  setTocVisible: (visible: boolean) => set({ tocVisible: visible }),
  setTocItems: (items: TocItem[]) => set({ tocItems: items }),
  setHtmlPreview: (html: string) => set({ htmlPreview: html, isPreviewLoading: false }),
  setIsPreviewLoading: (loading: boolean) => set({ isPreviewLoading: loading }),
  setAutoSaveEnabled: (enabled: boolean) => set({ autoSaveEnabled: enabled }),

  resetState: () => set({ ...initialState, isWelcome: false, viewMode: 'split' }),
}));
