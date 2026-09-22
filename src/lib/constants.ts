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

/** Auto-save interval: 1 minute（DEFAULT_EDITOR_SETTINGS.autoSaveInterval 的默认值） */
export const AUTO_SAVE_INTERVAL = 60_000;

/**
 * 自动保存间隔可选档位。
 *
 * 最短 10s：5s 档已移除——inline（iframe）模式的静默保存走 postMessage 桥接、
 * 超时 15s，5s 间隔会让在途请求叠加堆积（架构评审 R3）。
 * `value: 0` 表示「不自动保存」，周期保存与 3s 快捷保存一并停止。
 */
export const AUTO_SAVE_INTERVAL_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 10_000, label: 'Every 10 seconds' },
  { value: 30_000, label: 'Every 30 seconds' },
  { value: 60_000, label: 'Every 1 minute' },
  { value: 120_000, label: 'Every 2 minutes' },
  { value: 180_000, label: 'Every 3 minutes' },
  { value: 300_000, label: 'Every 5 minutes' },
  { value: 0, label: 'Never (off)' },
];

/**
 * inline（iframe）模式下的自动保存间隔下限。
 * `saveInlineToOriginal` 桥接父页面写盘的超时是 15s，间隔必须 ≥ 超时，
 * 否则会出现多条静默保存请求在途重叠（架构评审 R3）。
 */
export const INLINE_AUTO_SAVE_MIN_INTERVAL = 15_000;

/**
 * 计算实际生效的自动保存间隔。
 *
 * @param interval 用户配置的间隔（ms），0 表示关闭
 * @param isInlineMode 是否为插件 inline（iframe）模式
 * @returns 实际生效间隔（ms），0 表示关闭
 */
export function getEffectiveAutoSaveInterval(interval: number, isInlineMode: boolean): number {
  if (!Number.isFinite(interval) || interval <= 0) return 0;
  return isInlineMode ? Math.max(interval, INLINE_AUTO_SAVE_MIN_INTERVAL) : interval;
}

/**
 * 把自动保存间隔格式化为 StatusBar 短标签。
 *
 * @param interval 间隔（ms），0 表示关闭
 * @returns 'OFF' / '10s' / '1m' 之类的短文案
 */
export function formatAutoSaveInterval(interval: number): string {
  if (!Number.isFinite(interval) || interval <= 0) return 'OFF';
  if (interval < 60_000) return `${Math.round(interval / 1000)}s`;
  const minutes = interval / 60_000;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
}

/**
 * 预览区字体族 token → 实际 CSS font-family 栈。
 * 存 token 而非完整字体栈，便于后续调整栈内容而不破坏已持久化的设置。
 */
export const PREVIEW_FONT_STACKS: Readonly<Record<string, string>> = {
  system: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', sans-serif`,
  sans: `'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif`,
  serif: `Georgia, 'Times New Roman', 'Songti SC', 'SimSun', serif`,
  mono: `'SF Mono', Menlo, Consolas, 'Courier New', monospace`,
};

/** 预览字体下拉选项（'editor' = 跟随编辑器字体，v0.2.1 之前的历史行为） */
export const PREVIEW_FONT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'system', label: 'System Default' },
  { value: 'sans', label: 'Sans-serif (Helvetica)' },
  { value: 'serif', label: 'Serif (Georgia)' },
  { value: 'mono', label: 'Monospace (SF Mono)' },
  { value: 'editor', label: 'Same as Editor' },
];

/**
 * 解析预览字体 token 为可直接写入 CSS 变量的字体栈。
 *
 * @param token `EditorSettings.previewFontFamily`
 * @param editorFontFamily `EditorSettings.fontFamily`（token 为 'editor' 时使用）
 * @returns CSS font-family 值
 */
export function resolvePreviewFontStack(token: string, editorFontFamily: string): string {
  if (token === 'editor') return `'${editorFontFamily}', Menlo, monospace`;
  return PREVIEW_FONT_STACKS[token] ?? PREVIEW_FONT_STACKS.system;
}

/** 预览字号可选范围（px） */
export const PREVIEW_FONT_SIZE_MIN = 12;
export const PREVIEW_FONT_SIZE_MAX = 24;

/**
 * Preview render debounce in ms.
 * 保持 150ms —— Bug 6 的闪烁根因是 isPreviewLoading 早返回换 DOM（已修），
 * 不是防抖太短；拉长到 400ms 只会让预览「跟不上手」。
 */
export const PREVIEW_DEBOUNCE = 150;

/** Max lines for TOC extraction safety limit */
export const TOC_MAX_ITEMS = 10_000;

/**
 * R3「编辑→预览定位精度」两档策略的判定阈值（PRD §3.1 / §3.3，决策 D1）。
 *
 * 判定维度是**源码字节数**（不是渲染后 HTML 大小、也不是行数）：
 * 渲染前即已知（worker 内可判），且与行数强相关；用渲染后大小会让
 * 同一文档在两档之间抖动。
 *
 * - 源码 ≤ 256KB → **B 增强档**：打行级 span 锚点（`data-line-row`），像素级精确
 * - 源码 >  256KB → **A 基线档**：只打块属性（`data-source-line` / `data-source-line-end`），
 *   块内按行比例插值定位，**零 DOM 膨胀**（20MB 文档必须走这档）
 *
 * 256KB ≈ 4,000–6,000 行 Markdown（平均行长 40–60 字符）。
 * 每次渲染重新判定，跨阈值自动切换，用户无感知、无需配置（PRD §3.3）。
 */
export const LINE_ANCHOR_MAX_SOURCE_BYTES = 256 * 1024;

/** Virtual scroll overscan buffer (items above/below viewport) */
export const VIRTUAL_SCROLL_OVERSCAN = 5;

/** Default window title */
export const APP_NAME = 'MDnote';

/** Supported file extensions for open dialog */
export const SUPPORTED_EXTENSIONS = ['md', 'txt', 'markdown'];
