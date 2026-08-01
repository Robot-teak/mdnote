import { create } from 'zustand';
import type { ViewMode, Theme, TocItem, EditorSettings } from '../types';
import { DEFAULT_EDITOR_SETTINGS } from '../types';
import { isExtension } from '../lib/platform';

// ──────────────────────────────────────────────
// 保存状态类型（Q26 三态）
// ──────────────────────────────────────────────

/** 文档保存状态三态（供 StatusBar UI 展示） */
export type SaveState = 'clean' | 'dirty' | 'draft-saved' | 'disk-saved';

// ──────────────────────────────────────────────
// 持久化存储适配
// ──────────────────────────────────────────────

/**
 * 同步读取存储（localStorage，桌面版 + 插件版首帧兜底）。
 * @param key 存储键
 * @returns 存储值，不存在返回 null
 */
function syncGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * 同步写入存储（localStorage）。
 * @param key 存储键
 * @param value 存储值
 */
function syncSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors
  }
}

/**
 * 异步读取存储（插件版 chrome.storage.local，桌面版降级 localStorage）。
 * @param key 存储键
 * @returns 存储值，不存在返回 null
 */
async function asyncGetItem(key: string): Promise<string | null> {
  if (isExtension && typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const result = await chrome.storage.local.get(key);
      return (result[key] as string) ?? null;
    } catch {
      return syncGetItem(key);
    }
  }
  return syncGetItem(key);
}

/**
 * 异步写入存储（插件版 chrome.storage.local，桌面版降级 localStorage）。
 * @param key 存储键
 * @param value 存储值
 */
async function asyncSetItem(key: string, value: string): Promise<void> {
  if (isExtension && typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      await chrome.storage.local.set({ [key]: value });
      return;
    } catch {
      // 降级到 localStorage
    }
  }
  syncSetItem(key, value);
}

// ──────────────────────────────────────────────
// Hydrate 状态追踪（S0-3 结论）
// ──────────────────────────────────────────────

/** Store 是否已完成异步 hydrate */
let storeHydrated = !isExtension; // 桌面版同步 hydrate，始终为 true
const hydrateListeners = new Set<() => void>();

/** 标记 hydrate 完成 */
function markHydrated(): void {
  if (storeHydrated) return;
  storeHydrated = true;
  hydrateListeners.forEach((fn) => fn());
  hydrateListeners.clear();
}

/**
 * React hook：返回 store 是否已 hydrate。
 * 插件版：异步 chrome.storage hydrate 完成前返回 false，阻塞渲染。
 * 桌面版：始终返回 true（localStorage 同步）。
 */
export function useHydrated(): boolean {
  // 简化实现：直接返回模块级状态
  // React 组件中配合 useEffect 订阅变化
  return storeHydrated;
}

/**
 * 订阅 hydrate 完成（供 React useEffect 使用）。
 * @param listener 回调
 * @returns 取消订阅函数
 */
export function onHydrated(listener: () => void): () => void {
  if (storeHydrated) {
    listener();
    return () => {};
  }
  hydrateListeners.add(listener);
  return () => hydrateListeners.delete(listener);
}

// ──────────────────────────────────────────────
// 设置加载/保存
// ──────────────────────────────────────────────

/** Load settings from localStorage, falling back to defaults */
function loadSettings(): EditorSettings {
  try {
    const raw = syncGetItem('mdnote-settings');
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<EditorSettings>;
      return { ...DEFAULT_EDITOR_SETTINGS, ...parsed };
    }
  } catch {
    // Ignore parse errors
  }
  return { ...DEFAULT_EDITOR_SETTINGS };
}

/** Save settings to storage */
function saveSettings(settings: EditorSettings): void {
  syncSetItem('mdnote-settings', JSON.stringify(settings));
}

// ──────────────────────────────────────────────
// Store 类型定义
// ──────────────────────────────────────────────

interface AppState {
  /** Current document content (raw markdown) */
  content: string;
  /** Full file path on disk, null = unsaved new document */
  filePath: string | null;
  /** File handle (插件版 FileSystemFileHandle，桌面版 null) */
  fileHandle: unknown;
  /** Draft ID for IndexedDB tracking (插件版) */
  draftId: string | null;
  /** Whether there are unsaved changes */
  isDirty: boolean;
  /** 文档保存状态三态（Q26） */
  saveState: SaveState;
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
  /** Saved scroll position (0-indexed) for PreviewPane scroll restoration */
  savedScrollTop: number;
  /** Editor customization settings */
  settings: EditorSettings;
  /** S22: 磁盘写入是否失败（仅 saveNow Q21 降级路径设置，区分正常草稿保存与权限失效） */
  diskWriteFailed: boolean;

  // Actions
  setContent: (content: string) => void;
  setFilePath: (path: string | null) => void;
  setFileHandle: (handle: unknown) => void;
  setDraftId: (id: string | null) => void;
  setDirty: (dirty: boolean) => void;
  setSaveState: (state: SaveState) => void;
  setDiskWriteFailed: (failed: boolean) => void;
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
  setSavedScrollTop: (top: number) => void;
  updateSettings: (partial: Partial<EditorSettings>) => void;
  resetSettings: () => void;

  /** Reset all state to defaults (new document), and exit welcome mode */
  resetState: () => void;
}

// ──────────────────────────────────────────────
// 初始状态
// ──────────────────────────────────────────────

const initialState = {
  content: '',
  filePath: null as string | null,
  fileHandle: null as unknown,
  draftId: null as string | null,
  isDirty: false,
  saveState: 'clean' as SaveState,
  fileName: 'Untitled',
  viewMode: 'split' as ViewMode,
  theme: (syncGetItem('mdnote-theme') as Theme) || 'light',
  tocVisible: true,
  tocItems: [] as TocItem[],
  htmlPreview: '',
  isPreviewLoading: false,
  isWelcome: true,
  autoSaveEnabled: true,
  savedScrollTop: 0,
  settings: loadSettings(),
  diskWriteFailed: false,
};

// ──────────────────────────────────────────────
// Store 创建
// ──────────────────────────────────────────────

export const useAppStore = create<AppState>((set, get) => ({
  ...initialState,

  setContent: (content: string) => set({ content, isWelcome: false }),
  setFilePath: (path: string | null) => {
    set({
      filePath: path,
      fileName: path ? path.split('/').pop() || path.split('\\').pop() || 'Untitled' : 'Untitled',
    });
  },
  setFileHandle: (handle: unknown) => set({ fileHandle: handle }),
  setDraftId: (id: string | null) => set({ draftId: id }),
  setDirty: (dirty: boolean) => set({ isDirty: dirty, saveState: dirty ? 'dirty' : get().saveState }),
  setSaveState: (saveState: SaveState) => set({ saveState }),
  setDiskWriteFailed: (failed: boolean) => set({ diskWriteFailed: failed }),
  setFileName: (name: string) => set({ fileName: name }),
  setViewMode: (mode: ViewMode) => set({ viewMode: mode }),

  toggleTheme: () => {
    const current = get().theme;
    const next: Theme = current === 'light' ? 'dark' : 'light';
    syncSetItem('mdnote-theme', next);
    // 插件版同时写入 chrome.storage（异步）
    if (isExtension) {
      asyncSetItem('mdnote-theme', next).catch(() => {});
    }
    document.documentElement.setAttribute('data-theme', next);
    set({ theme: next });
  },

  setTheme: (theme: Theme) => {
    syncSetItem('mdnote-theme', theme);
    // 插件版同时写入 chrome.storage（异步）
    if (isExtension) {
      asyncSetItem('mdnote-theme', theme).catch(() => {});
    }
    document.documentElement.setAttribute('data-theme', theme);
    set({ theme });
  },

  toggleTOC: () => set((s) => ({ tocVisible: !s.tocVisible })),
  setTocVisible: (visible: boolean) => set({ tocVisible: visible }),
  setTocItems: (items: TocItem[]) => set({ tocItems: items }),
  setHtmlPreview: (html: string) => set({ htmlPreview: html, isPreviewLoading: false }),
  setIsPreviewLoading: (loading: boolean) => set({ isPreviewLoading: loading }),
  setAutoSaveEnabled: (enabled: boolean) => set({ autoSaveEnabled: enabled }),
  setSavedScrollTop: (top: number) => set({ savedScrollTop: top }),

  updateSettings: (partial: Partial<EditorSettings>) => {
    const current = get().settings;
    const next = { ...current, ...partial };
    saveSettings(next);
    // 插件版同时写入 chrome.storage（异步）
    if (isExtension) {
      asyncSetItem('mdnote-settings', JSON.stringify(next)).catch(() => {});
    }
    set({ settings: next });
  },

  resetSettings: () => {
    saveSettings({ ...DEFAULT_EDITOR_SETTINGS });
    if (isExtension) {
      asyncSetItem('mdnote-settings', JSON.stringify({ ...DEFAULT_EDITOR_SETTINGS })).catch(() => {});
    }
    set({ settings: { ...DEFAULT_EDITOR_SETTINGS } });
  },

  resetState: () => set((state) => ({
    ...initialState,
    theme: state.theme, // ← 保留当前主题，不随 reset 丢失
    settings: state.settings, // ← 保留设置
    isWelcome: false,
    viewMode: 'split',
  })),
}));

// ──────────────────────────────────────────────
// 插件版异步 hydrate（S0-3 结论）
// ──────────────────────────────────────────────

/**
 * 插件版启动时从 chrome.storage 异步加载持久化状态。
 * 桌面版不需要调用（localStorage 同步已加载）。
 */
export async function hydrateFromStorage(): Promise<void> {
  if (!isExtension) {
    markHydrated();
    return;
  }

  try {
    // 异步读取主题和设置
    const [themeVal, settingsVal] = await Promise.all([
      asyncGetItem('mdnote-theme'),
      asyncGetItem('mdnote-settings'),
    ]);

    if (themeVal === 'light' || themeVal === 'dark') {
      const current = useAppStore.getState().theme;
      if (current !== themeVal) {
        useAppStore.setState({ theme: themeVal });
        document.documentElement.setAttribute('data-theme', themeVal);
      }
    }

    if (settingsVal) {
      try {
        const parsed = JSON.parse(settingsVal) as Partial<EditorSettings>;
        const next = { ...DEFAULT_EDITOR_SETTINGS, ...parsed };
        useAppStore.setState({ settings: next });
      } catch {
        // Ignore parse errors
      }
    }
  } catch {
    // hydrate 失败时降级使用默认值
  }

  markHydrated();
}
