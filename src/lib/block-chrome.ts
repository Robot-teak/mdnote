/**
 * 预览块「顶部类型条」共享模块（Fix 7）
 *
 * 代码块（`.preview-codeblock`）需要一条顶部横条：**左侧显示语言类型**、
 * **右侧放操作**（复制按钮）。mermaid 容器也有一条外观一致的
 * `.preview-mermaid-bar`。为避免两处各写一套 DOM 构建逻辑、样式各自漂移，
 * 这里抽出唯一的构建入口。
 *
 * ⚠️ 本模块的**导出接口是对外冻结契约**（team-lead 2026-09-19 裁定）：
 * 三个 class 常量与 `createBlockBar` / `readCodeLang` 的签名一旦被其它模块
 * （如后续把 mermaid 条也切过来）引用即不可随意改。
 *
 * 设计约束：
 * - **零依赖**：只用 DOM API，可在主线程 / 测试 / 探针环境运行。
 * - 结构靠 class 常量对外暴露，**样式集中在 `globals.css`**（不写内联样式）。
 * - 类型标签是**字面量**（无 i18n）：`js` / `python` 等语言标识跨语言一致，
 *   不做本地化。
 *
 * @module block-chrome
 */

/** 类型条容器 class（CSS 见 `globals.css`「预览代码块顶部类型条」） */
export const BLOCK_BAR_CLASS = 'preview-block-bar';

/** 类型条左侧「语言类型」标签 class */
export const BLOCK_KIND_CLASS = 'preview-block-kind';

/** 类型条右侧「操作区」容器 class（复制按钮等统一放这里） */
export const BLOCK_ACTIONS_CLASS = 'preview-block-actions';

/** 代码块语言属性名（由 `md-worker.ts` 的 fence 规则写到 `<pre>` 上） */
const LANG_ATTR = 'data-lang';

/** 读不到语言标识时的兜底标签（无信息围栏 / 缩进代码块） */
const FALLBACK_KIND = 'text';

/**
 * 读取代码块围栏语言标识。
 *
 * 优先读 `<pre>` 自身的 `data-lang`，其次回退到内层 `<code>`（兼容其它渲染器
 * 可能把语言挂在 `<code class="language-js">` 上的形态，即使当前 worker 用不到）。
 *
 * @param pre 代码块 `<pre>` 元素
 * @returns 语言标识（已去首尾空白）；无 / 空串 → `null`
 */
export function readCodeLang(pre: HTMLElement): string | null {
  const raw =
    pre.getAttribute(LANG_ATTR) ??
    pre.querySelector('code')?.getAttribute(LANG_ATTR) ??
    null;
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 创建一条块顶部类型条（左侧类型标签 + 右侧操作区）。
 *
 * 调用方负责把返回的 `bar` 插入到目标块，并把操作（如复制按钮）
 * 追加到 `actions`。
 *
 * @param kind 左侧展示的类型文案（如 `js` / `python` / `text`）；空串 → 兜底 `text`
 * @returns `bar`（整条，待插入）+ `actions`（操作区容器，供调用方填充）
 */
export function createBlockBar(kind: string): { bar: HTMLElement; actions: HTMLElement } {
  const bar = document.createElement('div');
  bar.className = BLOCK_BAR_CLASS;

  const kindEl = document.createElement('span');
  kindEl.className = BLOCK_KIND_CLASS;
  const label = kind.trim();
  kindEl.textContent = label === '' ? FALLBACK_KIND : label;
  bar.appendChild(kindEl);

  const actions = document.createElement('div');
  actions.className = BLOCK_ACTIONS_CLASS;
  bar.appendChild(actions);

  return { bar, actions };
}
