/**
 * 预览区 DOM 增强（C3 / C4 / C5 / R2 / R3 消费侧）
 *
 * `.preview-content` 的内容由 PreviewPane 用 `innerHTML` 整体写入，
 * React 不接管其子节点。因此所有能力都做成**渲染后的 DOM 后处理**：
 *
 * - **C3 代码块复制按钮**：给每个 `<pre>` 包一层 `.preview-codeblock`，
 *   并在顶部插入一条**类型条**（`.preview-block-bar`：左「语言类型」/ 右「操作区」），
 *   复制按钮（`.preview-copy-btn`）放进操作区（覆盖所有代码块，含 Source 态的
 *   mermaid 块）。类型条结构由共享模块 `block-chrome.ts` 构建。
 *   点击走**事件委托**（`handlePreviewClick`），
 *   不逐块 addEventListener —— DOM 每次重渲染都会重建，逐块绑定必然丢监听。
 * - **C4 宽表格横向滚动**：给每个 `<table>` 包一层 `.preview-table-wrap`
 *   （`overflow-x: auto`），表格自身不再撑破预览区。清洗白名单里 `table`
 *   本就放行，包裹层在渲染后插入，不需要改 sanitize。
 * - **C5 预览内锚点跳转**：点击 `#heading` 链接时 `preventDefault`
 *   （不改地址栏 hash、不刷新），滚到目标标题并套用 `.sync-highlight` 闪烁。
 *   外链（http/https/mailto…）一律不拦截，保持现状行为。
 * - **R3 消费侧**：按根标记 `data-line-anchor` 分档定位源行——B 档读行级
 *   `data-line-row`（像素级），A 档只有块属性，按 `data-source-line-end`
 *   在块内插值；滚动策略为「视口内不滚 / 越界滚到垂直中央」（见 `scrollPreviewToLine`）。
 * - **R2 预览→编辑跳转**：点击预览任意元素，取最近源行锚点，走
 *   `nav-bridge.requestEditorGotoLine` 通知编辑器（外链短路，不跳编辑器）。
 * - **R4 预览块级稀疏行号**：给块级锚点元素写 1-based 的 `data-line-no`，
 *   由纯 CSS 伪元素（`globals.css`「预览块级稀疏行号（R4）」）画在区块左外侧 gutter。
 *   由 `enabled` 开关控制，默认关（裁决 D4）。**行号不进导出**（导出走 worker 的
 *   独立 HTML，完全不经过本模块）。
 *
 * 所有函数对同一 DOM 重复执行是**幂等**的（已包裹则跳过），
 * 内容未变时 PreviewPane 不会重写 innerHTML，本模块也不会被反复调用。
 *
 * @module preview-enhance
 */

import { requestEditorGotoLine } from './nav-bridge';
import { createBlockBar, readCodeLang } from './block-chrome';

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────

/** 代码块包裹层 class（CSS 见 globals.css「预览代码块复制按钮（C3）」） */
export const CODE_BLOCK_CLASS = 'preview-codeblock';
/** 复制按钮 class */
export const COPY_BTN_CLASS = 'preview-copy-btn';
/** 表格横向滚动包裹层 class（CSS 见 globals.css「宽表格横向滚动容器（C4）」） */
export const TABLE_WRAP_CLASS = 'preview-table-wrap';
/** 闪烁高亮 class（与编辑→预览同步共用，`editor:scroll-preview` 也在用） */
const FLASH_CLASS = 'sync-highlight';

/** 复制按钮：默认 / 成功 / 失败文案（英文，UI 规格 §11） */
const COPY_LABEL = 'Copy';
const COPIED_LABEL = '✓ Copied';
const FAILED_LABEL = 'Copy failed';

/** 复制反馈态保持时长（ms），UI 规格 §4.3 */
const FEEDBACK_DURATION_MS = 1500;

/** 锚点跳转后的闪烁时长（ms）—— C1/C5：双向统一为 600ms */
const FLASH_DURATION_MS = 600;

/** 源行锚点属性（C4 需把它从 `<table>` 搬到包裹层，见 UI 规格 §7.2 / §13.2 约束 3） */
const SOURCE_LINE_ATTR = 'data-source-line';
/** 行号显示值（R4 后处理写入，= `data-source-line` + 1；C4 一并搬运，见 UI 规格 §13.2 约束 2） */
const LINE_NO_ATTR = 'data-line-no';

/**
 * mermaid 块容器 class。
 *
 * 用途：仅作 `mermaid-preview.ts` 的 `MERMAID_HOST_CLASS` 的**漂移守卫锚点**
 * （见 `preview-line-numbers.test.ts`）。R4 现已**不再**跳过 mermaid 容器
 * （2026-09-19 team-lead 裁决：容器也要显示行号），故本模块内部不再引用它，
 * 但保留导出让守卫断言继续锁住两处字面量一致。
 *
 * ⚠️ **刻意重复字面量**，不从 `mermaid-preview.ts` import：那边已经 import 了本模块
 * （`CODE_BLOCK_CLASS` / `setMermaidClickHandler`），反向 import 会形成**循环依赖**。
 */
export const PREVIEW_MERMAID_CLASS = 'preview-mermaid';

/** 块级**结束行**（不含），A/B 两档都打；A 档块内插值靠它（PRD §3.1） */
const SOURCE_LINE_END_ATTR = 'data-source-line-end';
/** 行级 span 锚点，只打在 B 档（源码 ≤ 256KB）的 `<span>` 上 */
const ROW_LINE_ATTR = 'data-line-row';
/** 根标记属性，取值为 `"row"` | `"block"`，打在首个顶层块元素上 */
const LINE_ANCHOR_ATTR = 'data-line-anchor';

/** nearest 滚动的安全边距（px）：目标点距视口上下沿不足此值才滚 */
const NEAREST_MARGIN_PX = 24;
/** 判定「不需要滚动」的最小位移（px），避免 1px 抖动也要滚一次 */
const MIN_SCROLL_DELTA_PX = 1;

/** 每个按钮的反馈态计时器，避免连点互相打断 */
const feedbackTimers = new WeakMap<HTMLElement, number>();
/** 每个元素的高亮计时器，避免连续点击时前一次的 timer 提前摘掉后一次的闪烁 */
const flashTimers = new WeakMap<HTMLElement, number>();

/**
 * mermaid 容器的点击处理器（R1 UI 层注册）。
 *
 * 签名刻意是 `(event, target)` 而不是 `(event, host)`：这样本模块**不需要**
 * 知道 mermaid 的类名，也不会与 `mermaid-preview` 形成循环依赖
 * （`mermaid-preview` → 本模块 单向）。
 *
 * 返回 true = 已消费（本模块直接 return）；返回 false = 放行给下面的 R2。
 */
type MermaidClickHandler = (event: MouseEvent, target: Element) => boolean;
let mermaidClickHandler: MermaidClickHandler | null = null;

/**
 * 注册 / 注销 mermaid 容器的点击处理器。
 * @param handler 处理器；null 表示注销
 */
export function setMermaidClickHandler(handler: MermaidClickHandler | null): void {
  mermaidClickHandler = handler;
}

// ──────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────-

/**
 * 安全解码（URI 组件），畸形输入时原样返回。
 * @param raw 原始字符串
 * @returns 解码后的字符串
 */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 归一化锚点 id：解码 + 去首尾空白 + 转小写（HTML id 大小写敏感，
 * 但 Markdown 里手写锚点普遍是小写，放宽匹配成功率更高）。
 * @param raw 原始 id
 * @returns 归一化后的 id
 */
function normalizeAnchorId(raw: string): string {
  return safeDecode(raw).trim().toLowerCase();
}

/**
 * GitHub 风格的标题 slug（markdown-it 未装 anchor 插件，标题没有 id，
 * 只能拿标题文本 slug 与锚点比对）。
 * 保留 Unicode 字母/数字（中文标题可用）、连字符与下划线，其余标点丢弃，
 * 空白折叠为单个连字符。
 * @param text 标题文本
 * @returns slug
 */
function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

/**
 * 闪烁高亮某个元素（600ms），与 `editor:scroll-preview` 的表现一致。
 *
 * 计时器按元素记录：连续点击同一锚点时，**前一次的 timer 会被清掉**，
 * 否则它会在后一次闪烁进行到一半时把 class 摘掉，表现为「第二次只闪了一下」。
 * @param el 目标元素
 */
function flashElement(el: HTMLElement): void {
  const prev = flashTimers.get(el);
  if (prev !== undefined) {
    window.clearTimeout(prev);
  }

  el.classList.remove(FLASH_CLASS);
  // 强制一次重排：连续点击同一目标时动画才会重新播放
  void el.offsetWidth;
  el.classList.add(FLASH_CLASS);

  const timer = window.setTimeout(() => {
    el.classList.remove(FLASH_CLASS);
    flashTimers.delete(el);
  }, FLASH_DURATION_MS);
  flashTimers.set(el, timer);
}

// ──────────────────────────────────────────────
// C3：代码块包裹 + 复制
// ──────────────────────────────────────────────

/**
 * 给每个 `<pre>` 包一层 `.preview-codeblock`，并在顶部插入一条**类型条**
 * （左：语言类型 / 右：复制按钮）。幂等：已包裹的直接跳过。
 *
 * **Fix 7**：类型条由共享模块 `block-chrome.ts` 的 `createBlockBar()` 构建，
 * 语言取自 md-worker 写在 `<pre>` 上的 `data-lang`（无信息围栏 / 缩进代码块 → `text`）。
 * 复制按钮放进类型条的 `actions` 操作区，不再单独绝对定位在包裹层右上角。
 *
 * @param root 预览内容容器
 */
export function enhanceCodeBlocks(root: HTMLElement): void {
  const blocks = Array.from(root.querySelectorAll('pre'));
  for (const pre of blocks) {
    const parent = pre.parentElement;
    if (!parent) continue;
    // 已包裹（重复调用 / 上游已自行包裹）→ 跳过
    if (parent.classList.contains(CODE_BLOCK_CLASS)) continue;

    const wrapper = document.createElement('div');
    wrapper.className = CODE_BLOCK_CLASS;
    parent.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    // 行号宿主下沉到**包裹层**：把锚点**复制**一份给 wrapper（`<pre>` 上那份保留不动 ——
    // R2/R3 的定位、mermaid 的挂载都还依赖它，删了就是回归）。
    //
    // applyPreviewLineNumbers 按**文档序**遍历：wrapper 是 pre 的父节点，先被处理并拿到
    // `data-line-no`；pre 随后因「祖先已有 data-line-no」被跳过 → 行号画在包裹层左上角，
    // 与 mermaid 容器的行号一样落在**标题行那一行的高度**上（第三轮反馈要求两者一致）。
    // 若画在 <pre> 上，会跟着 pre 自己的 padding 往下走，比 mermaid 的低一截。
    const srcLine = pre.getAttribute('data-source-line');
    if (srcLine !== null) wrapper.setAttribute('data-source-line', srcLine);

    // 顶部类型条：左「语言类型」+ 右「操作区」。无语言信息 → 'text'（字面量，不走 i18n）。
    const { bar, actions } = createBlockBar(readCodeLang(pre) ?? 'text');
    wrapper.insertBefore(bar, pre);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = COPY_BTN_CLASS;
    button.textContent = COPY_LABEL;
    button.setAttribute('aria-label', 'Copy code');
    actions.appendChild(button);
  }
}

/**
 * 取出代码块要复制的纯文本：不含围栏、不含行号、不含首尾多余空行。
 * @param pre 代码块元素
 * @returns 待复制文本
 */
export function getCodeBlockText(pre: HTMLElement): string {
  return (pre.textContent ?? '').replace(/^[\r\n]+|[\r\n]+$/g, '');
}

/**
 * 复制成功的反馈态（`.is-copied` → `✓ Copied`），1.5s 后复位。
 * @param button 按钮元素
 */
function markCopied(button: HTMLElement): void {
  setFeedback(button, true);
}

/**
 * 复制失败的反馈态（`.is-failed` → `Copy failed`），1.5s 后复位。
 * @param button 按钮元素
 */
function markFailed(button: HTMLElement): void {
  setFeedback(button, false);
}

/**
 * 设置按钮反馈态并在 1.5s 后复位（连点会重置计时）。
 * @param button 按钮元素
 * @param ok 是否成功
 */
function setFeedback(button: HTMLElement, ok: boolean): void {
  const prev = feedbackTimers.get(button);
  if (prev !== undefined) {
    window.clearTimeout(prev);
  }

  button.classList.remove('is-copied', 'is-failed');
  button.classList.add(ok ? 'is-copied' : 'is-failed');
  button.textContent = ok ? COPIED_LABEL : FAILED_LABEL;

  const timer = window.setTimeout(() => {
    button.classList.remove('is-copied', 'is-failed');
    button.textContent = COPY_LABEL;
    feedbackTimers.delete(button);
  }, FEEDBACK_DURATION_MS);
  feedbackTimers.set(button, timer);
}

/**
 * `document.execCommand('copy')` 兜底：非安全上下文（http）或
 * `navigator.clipboard` 不可用时仍可复制。
 * @param text 待复制文本
 * @returns 是否成功
 */
function copyViaExecCommand(text: string): boolean {
  let ok = false;
  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    // 移出视口但保持可聚焦（display:none / visibility:hidden 会导致 select 失败）
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    textarea?.remove();
  }
  return ok;
}

/**
 * 写入剪贴板：`navigator.clipboard` 优先，失败降级 `execCommand`。
 * @param text 待复制文本
 * @returns 是否成功
 */
export async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒 / 非安全上下文 → 走兜底
  }
  return copyViaExecCommand(text);
}

/**
 * 处理复制按钮点击：取代码文本 → 写剪贴板 → 按钮反馈。
 * 失败只在按钮上反馈，**不弹 toast**（UI 规格 §4.4，避免噪音）。
 * @param button 被点击的按钮
 */
async function handleCopyClick(button: HTMLElement): Promise<void> {
  const wrapper = button.closest(`.${CODE_BLOCK_CLASS}`);
  const pre = wrapper?.querySelector('pre') ?? null;
  if (!pre) {
    markFailed(button);
    return;
  }
  const text = getCodeBlockText(pre);
  const ok = await writeToClipboard(text);
  if (ok) {
    markCopied(button);
  } else {
    markFailed(button);
  }
}

// ──────────────────────────────────────────────
// C4：宽表格横向滚动包裹
// ──────────────────────────────────────────────

/**
 * 给每个 `<table>` 包一层 `.preview-table-wrap`（`overflow-x: auto`）。
 *
 * 同时把源行锚点属性（`data-source-line` / `data-line-no`）**从 table 搬到
 * 包裹层**：行号伪元素画在元素盒子左外侧，若宿主是 `overflow-x` 容器内的
 * `<table>`，数字会落在容器的左侧溢出区被永久裁掉（UI 规格 §7.2 / §13.2）。
 *
 * 幂等：已包裹的直接跳过。
 * @param root 预览内容容器
 */
export function enhanceTables(root: HTMLElement): void {
  const tables = Array.from(root.querySelectorAll('table'));
  for (const table of tables) {
    const parent = table.parentElement;
    if (!parent) continue;
    if (parent.classList.contains(TABLE_WRAP_CLASS)) continue;

    const wrap = document.createElement('div');
    wrap.className = TABLE_WRAP_CLASS;
    parent.insertBefore(wrap, table);
    wrap.appendChild(table);

    for (const attr of [SOURCE_LINE_ATTR, LINE_NO_ATTR]) {
      const value = table.getAttribute(attr);
      if (value !== null) {
        wrap.setAttribute(attr, value);
        table.removeAttribute(attr);
      }
    }
  }
}

// ──────────────────────────────────────────────
// R4：预览块级稀疏行号
// ──────────────────────────────────────────────

/**
 * 判断一个元素是否**应该**带上 `data-line-no`（即是否在 gutter 上显示数字）。
 *
 * 两类跳过：
 *  1. `enabled === false` —— 设置关闭，一个都不写
 *  2. 已有 `data-line-no` 祖先的后代 —— 嵌套去重。实测一个 `<ul>` 会连带 2 个 `<li>`、
 *     一个 `<table>` 会连带 `<thead>`/`<tbody>`/`<tr>`，不去重会一次刷出 5–6 个数字
 *     （UI 规格 §5.2 的 `[data-source-line] [data-source-line]::before { content: none }`
 *     就是干这个；这里挪到 JS 做，换来 CSS 侧可以用最简单的单属性选择器）
 *
 * ⚠️ **2026-09-19 team-lead 打磨裁决**：原先这里还跳过 `<pre>`（A12 第 4 条）与
 * mermaid 容器（`.preview-mermaid`）。真机点测要求**代码块、表格、mermaid 容器都显示
 * 行号**，两条跳过**全部作废**：
 *  - `<pre>`：`data-source-line` 仍在 `<pre>` 上（R2/R3 定位锚点不受影响），只是**也**写号；
 *  - mermaid 容器：容器本体（`<div class="preview-mermaid">`）即该块的锚点，显示一个号；
 *    容器内被搬进来的源码 `<pre>` 已无 `data-source-line`（`buildMermaidHost` 搬走了锚点），
 *    会被下面的第 2 条（或「无合法锚点」分支）清掉，天然只留容器一个号。
 *
 * @param el 候选元素
 * @param enabled 设置是否开启
 * @returns true = 应跳过（不写 `data-line-no`，并清掉可能残留的旧值）
 */
function shouldSkipLineNumber(el: Element, enabled: boolean): boolean {
  if (!enabled) return true;
  return el.parentElement?.closest(`[${LINE_NO_ATTR}]`) !== null;
}

/**
 * **R4**：为块级锚点元素写入 1-based 行号（`data-line-no`），供 CSS `attr()` 消费。
 *
 * 为什么是「后处理写属性」而不是「让 worker 直接吐 `data-line-no`」：
 * worker 输出同时供**预览**与**导出 HTML** 使用，写进去会 ① 增加 `htmlPreview` 体积
 * （每块约 18 字节，大文档几十万块）；② **漏进导出产物**，违反 R4「行号不进入导出」。
 * 后处理只写 DOM 属性，零 HTML 体积成本，且天然不进导出（UI 规格 §5.6 / §10 推论）。
 *
 * 为什么行号由 CSS 伪元素画、而不是 JS 插 gutter 节点：`.preview-content` 的 children
 * 每次渲染都被 `innerHTML` 整体重写，插节点必须每次重建、还会被 C3/C4 的包裹层连带搬移，
 * 并可能成为 R2/R3 的 `closest` / `querySelectorAll` 的额外候选。伪元素不在 DOM 里，
 * 以上问题全部不存在。详见 04 实现日志「批次 B-6」。
 *
 * **幂等**：同一 DOM 重复调用结果一致；`enabled=false` 会把已有的 `data-line-no` 清干净
 * （设置切回关闭时不留残值）。
 *
 * @param root 预览内容容器（`.preview-content`）
 * @param enabled 设置 `EditorSettings.previewLineNumbers`
 */
export function applyPreviewLineNumbers(root: HTMLElement, enabled: boolean): void {
  // 两类候选一起取：该有数字的（有 data-source-line）+ 可能残留的（只有 data-line-no）。
  // `querySelectorAll` 返回**文档序**，祖先必然排在后代之前 —— 这是第 4 条去重能生效的前提。
  const candidates = Array.from(
    root.querySelectorAll(`[${SOURCE_LINE_ATTR}], [${LINE_NO_ATTR}]`),
  );

  for (const el of candidates) {
    if (shouldSkipLineNumber(el, enabled)) {
      // 清残值：设置关闭、或元素身份变了（如 `unwrapMermaidHosts` 之后）都要清干净
      el.removeAttribute(LINE_NO_ATTR);
      continue;
    }

    const raw = el.getAttribute(SOURCE_LINE_ATTR);
    // ⚠️ 必须用 `^\d+$` 而不是 `Number.isFinite(Number(raw))`：
    // `Number('')` === 0、`Number('  ')` === 0，空属性会被静默当成第 0 行并显示成 `1`。
    // 行号只可能是非负整数字面量，其余一律视为无锚点（UI 规格 §5.4：不补 0、不占位）。
    if (raw === null || !/^\d+$/.test(raw)) {
      el.removeAttribute(LINE_NO_ATTR);
      continue;
    }
    const startLine = Number(raw);

    // ⛔ 显示 1-based（与编辑器 gutter 同一套编号），但 `data-source-line` 本身
    //    保持 0-based 不动 —— R2/R3 的跳转算法按 0-based 比较（UI 规格 §13.2 约束 2）
    el.setAttribute(LINE_NO_ATTR, String(startLine + 1));
  }
}

// ──────────────────────────────────────────────
// C5：预览内锚点跳转
// ──────────────────────────────────────────────

/**
 * 按锚点 id 找目标元素。
 * ① 先找显式 `id` / `<a name>`；② 再退回「标题文本 slug」匹配
 * （markdown-it 未装 anchor 插件，标题默认没有 id）。
 * @param root 预览内容容器
 * @param rawId 锚点 id（不含前导 `#`）
 * @returns 目标元素，找不到返回 null
 */
export function findAnchorTarget(root: HTMLElement, rawId: string): HTMLElement | null {
  const wanted = normalizeAnchorId(rawId);
  if (!wanted) return null;

  const withId = Array.from(root.querySelectorAll<HTMLElement>('[id], a[name]'));
  for (const el of withId) {
    if (el.id && normalizeAnchorId(el.id) === wanted) return el;
    const name = el.getAttribute('name');
    if (name && normalizeAnchorId(name) === wanted) return el;
  }

  const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'));
  for (const heading of headings) {
    if (slugifyHeading(heading.textContent ?? '') === wanted) return heading;
  }
  return null;
}

/**
 * 滚动到锚点目标并闪烁 600ms。找不到目标则什么都不做。
 * @param root 预览内容容器
 * @param rawId 锚点 id（不含前导 `#`）
 */
export function scrollToAnchor(root: HTMLElement, rawId: string): void {
  const target = findAnchorTarget(root, rawId);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  flashElement(target);
}

// ──────────────────────────────────────────────
// R3 消费侧：按档位把「源行」解析成预览 DOM 里的目标点
// ──────────────────────────────────────────────

/**
 * 把数值夹到 [min, max] 区间。
 * @param value 原值
 * @param min 下界
 * @param max 上界
 * @returns 夹取后的值
 */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 把数值夹到 [0, 1]。
 * @param value 原值
 * @returns 夹取后的值
 */
function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * 读取元素上的整数型行号属性，缺失或非法返回 null。
 * @param el 元素
 * @param attr 属性名
 * @returns 行号（0-based），非法返回 null
 */
function readLineAttr(el: Element, attr: string): number | null {
  const raw = el.getAttribute(attr);
  if (raw === null || raw === '') return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * 读根标记，判断本次渲染用的是哪一档锚点。
 *
 * 只打在首个顶层块元素上（worker 端刻意只打一处，避免大文档 HTML 膨胀），
 * 因此用 `querySelector` 取第一个即可。
 *
 * @param root 预览内容容器
 * @returns `'row'`（B 增强档）/ `'block'`（A 基线档）/ `null`（没渲染过或没有锚点）
 */
export function readLineAnchorMode(root: HTMLElement): 'row' | 'block' | null {
  const marked = root.querySelector(`[${LINE_ANCHOR_ATTR}]`);
  const value = marked?.getAttribute(LINE_ANCHOR_ATTR);
  if (value === 'row' || value === 'block') return value;
  return null;
}

/**
 * R3 消费侧核心：把 0-based 源行号解析成「目标元素 + 块内比例」。
 *
 * - **B 档（row）**：先找 `data-line-row` 精确等于该行的 span；行级 span 缺失时
 *   （例如点在代码块、表格里）退回块级锚点。
 * - **A 档（block）**：只有块属性。取「起始行 ≤ 目标行」里起始行最大的块，
 *   再按 `(line - start) / (end - start)` 算块内比例，**读不到
 *   `data-source-line-end` 时结束行按 `start + 1` 兜底**（worker 端契约）。
 *
 * 该函数是**纯 DOM 读**，不滚动、不闪烁，便于单元测试。
 *
 * @param root 预览内容容器
 * @param line 0-based 源行号
 * @returns 目标点；找不到返回 null
 */
export function resolvePreviewLineTarget(
  root: HTMLElement,
  line: number,
): { el: HTMLElement; ratio: number } | null {
  if (!Number.isFinite(line) || line < 0) return null;

  // ① B 档：行级 span 精确命中
  if (readLineAnchorMode(root) === 'row') {
    const rows = root.querySelectorAll(`[${ROW_LINE_ATTR}]`);
    let fallback: HTMLElement | null = null;
    let fallbackLine = -1;
    for (const el of rows) {
      const rowLine = readLineAttr(el, ROW_LINE_ATTR);
      if (rowLine === null) continue;
      if (rowLine === line) return { el: el as HTMLElement, ratio: 0 };
      if (rowLine < line && rowLine > fallbackLine) {
        fallbackLine = rowLine;
        fallback = el as HTMLElement;
      }
    }
    if (fallback) return { el: fallback, ratio: 0 };
  }

  // ② 块级：取「start ≤ line」中 start 最大的块 + 块内插值
  const blocks = root.querySelectorAll(`[${SOURCE_LINE_ATTR}]`);
  let best: HTMLElement | null = null;
  let bestStart = -1;
  let bestEnd = -1;
  for (const el of blocks) {
    const start = readLineAttr(el, SOURCE_LINE_ATTR);
    if (start === null || start > line) continue;
    const endRaw = readLineAttr(el, SOURCE_LINE_END_ATTR);
    const end = endRaw !== null && endRaw > start ? endRaw : start + 1;
    if (start > bestStart) {
      bestStart = start;
      bestEnd = end;
      best = el as HTMLElement;
    }
  }
  if (!best) return null;

  // 单行块（end === start + 1）无插值余地，比例恒为 0
  const ratio = bestEnd > bestStart + 1 ? clamp01((line - bestStart) / (bestEnd - bestStart)) : 0;
  return { el: best, ratio };
}

/**
 * 把预览滚动到指定源行（R3 消费侧入口）。
 *
 * 滚动策略（2026-09-19 team-lead 打磨裁决，修复「双屏下点编辑区、预览没居中」）：
 *  - 目标点**已在视口内**（上下各留 `NEAREST_MARGIN_PX` 安全边距）→ **不滚**
 *    （跟随式同步若每点一下都重新居中，跳动明显，这是 R3 的核心价值）；
 *  - 目标点**越界**时 → 滚到视口**垂直中央**：`delta = targetY - 视口纵向中点`，
 *    让被定位的块尽量居中呈现（原实现是「贴到最近边沿」，明显偏在一角）；
 *  - 目标块**比视口还高**时 → 居中没有意义（块中点在视口外），改为把**块首**
 *    对齐到视口上沿。
 *
 * ⚠️ TOC 目录跳转（`preview:scroll-to-heading`）走的是另一条路径，**始终** `center`，
 * 与本函数（跟随式同步）语义不同，不要合并。
 *
 * @param root 预览内容容器
 * @param scroller 滚动容器（`.preview-pane`），为 null 时退回原生 `scrollIntoView`
 * @param line 0-based 源行号
 * @param options `flash` 是否套 600ms 闪烁（默认 true）
 * @returns 是否命中并定位（false = 没找到锚点，什么都不做）
 */
export function scrollPreviewToLine(
  root: HTMLElement,
  scroller: HTMLElement | null,
  line: number,
  options: { flash?: boolean } = {},
): boolean {
  const flash = options.flash !== false;
  const target = resolvePreviewLineTarget(root, line);
  if (!target) return false;

  const { el, ratio } = target;

  if (scroller) {
    const viewRect = scroller.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    // 块内插值：目标点 = 元素顶部 + 比例 × 元素高度
    const targetY = elRect.top + ratio * elRect.height;

    // 已在视口内（上下各留安全边距）→ 不滚
    const withinView =
      targetY >= viewRect.top + NEAREST_MARGIN_PX &&
      targetY <= viewRect.bottom - NEAREST_MARGIN_PX;

    if (!withinView) {
      let delta: number;
      if (elRect.height > viewRect.height) {
        // 目标块比视口还高：居中没有意义 → 把块首对齐到视口上沿
        delta = elRect.top - viewRect.top;
      } else {
        // 越界 → 滚到视口垂直中央
        delta = targetY - (viewRect.top + viewRect.height / 2);
      }

      if (Math.abs(delta) > MIN_SCROLL_DELTA_PX) {
        const top = scroller.scrollTop + delta;
        if (typeof scroller.scrollTo === 'function') {
          scroller.scrollTo({ top, behavior: 'smooth' });
        } else {
          // jsdom / 老环境没有 scrollTo → 直接赋值（无动画，但不报错）
          scroller.scrollTop = top;
        }
      }
    }
  } else {
    // 无滚动容器：退回原生，语义对齐新策略（居中）
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  if (flash) flashElement(el);
  return true;
}

// ──────────────────────────────────────────────
// R2：预览点击 → 取最近源行锚点 → 跳编辑器
// ──────────────────────────────────────────────

/**
 * 由点击事件反推它落在哪个源行上。
 *
 * - B 档优先读 `data-line-row`（行级，精确）；
 * - 落在代码块 / 表格等没有行级 span 的地方，或处于 A 档时，退到块级锚点，
 *   并按点击的**纵向位置**在块内插值（A 档没有行级信息，只能这样逼近）。
 *
 * @param event 鼠标事件（需要 `clientY` 做块内插值）
 * @param root 预览内容容器
 * @returns 0-based 源行号，取不到返回 null
 */
export function resolveClickSourceLine(event: MouseEvent, root: HTMLElement): number | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;

  // ① B 档行级 span
  if (readLineAnchorMode(root) === 'row') {
    const rowEl = target.closest(`[${ROW_LINE_ATTR}]`);
    const rowLine = rowEl ? readLineAttr(rowEl, ROW_LINE_ATTR) : null;
    if (rowLine !== null) return rowLine;
  }

  // ② 块级锚点（A/B 通用）
  const blockEl = target.closest(`[${SOURCE_LINE_ATTR}]`);
  if (!blockEl) return null;
  const start = readLineAttr(blockEl, SOURCE_LINE_ATTR);
  if (start === null) return null;

  const endRaw = readLineAttr(blockEl, SOURCE_LINE_END_ATTR);
  const end = endRaw !== null && endRaw > start ? endRaw : start + 1;
  if (end <= start + 1) return start;

  const rect = blockEl.getBoundingClientRect();
  // 高度为 0（jsdom / 未布局）→ 无法插值，直接给块起始行
  if (rect.height <= 0) return start;

  const ratio = clamp01((event.clientY - rect.top) / rect.height);
  return clamp(Math.floor(start + ratio * (end - start)), start, end - 1);
}

// ──────────────────────────────────────────────
// 统一入口
// ──────────────────────────────────────────────

/** `enhancePreviewContent` 的可选行为开关 */
export interface EnhancePreviewOptions {
  /**
   * **R4**：是否显示块级稀疏行号。
   * 默认 `false` —— 不传时行为与 R4 之前**完全一致**（不写任何 `data-line-no`）。
   */
  lineNumbers?: boolean;
}

/**
 * 渲染后统一增强：表格包裹（C4）→ 代码块包裹（C3）→ 行号（R4）。
 * 顺序无关，但先包表格可让后续代码块包裹面对的 DOM 更稳定。
 *
 * ⚠️ `applyPreviewLineNumbers` 必须放在**最后**：此时 C4 已把 `<table>` 的锚点
 * 搬到 `.preview-table-wrap` 上，于是「表格包裹层拿数字、`<table>` 拿不到」
 * 这条规则天然成立（UI 规格 §13.2 约束 3 / A12 第 10 条），不需要任何特判。
 *
 * @param root 预览内容容器（`.preview-content`）
 * @param options 可选行为开关（R4 行号）；不传则与历史行为一致
 */
export function enhancePreviewContent(
  root: HTMLElement,
  options: EnhancePreviewOptions = {},
): void {
  enhanceTables(root);
  enhanceCodeBlocks(root);
  applyPreviewLineNumbers(root, options.lineNumbers === true);
}

/**
 * 预览区点击委托处理器（C3 复制按钮 → C5 内部锚点 → R2 预览跳编辑）。
 *
 * 由 PreviewPane 以**捕获阶段**挂在 `.preview-content` 上。
 *
 * 短路顺序即优先级（同处一个监听，前面的分支 return 后后面的不会执行）：
 *   1. **C3 复制按钮**：`preventDefault` + `stopPropagation`，事件到此为止；
 *   2. **C5 内部锚点**（`href` 以 `#` 开头）：同上，且**不改地址栏 hash**；
 *   3. **R1 mermaid 容器**：图本体 → 放大浮层（消费）；分段控件 / 控制条 →
 *      消费；**容器留白 → 不消费**，放行给下面的 R2；
 *   4. **R2 外链短路**：`a[href]` 不以 `#` 开头（http / mailto / 其它协议）
 *      → **不跳编辑器**，交还浏览器默认行为；
 *   5. **R2 预览 → 编辑**：取最近源行锚点，派发 `editor:goto-line`。
 *      取不到锚点就什么都不做（不滚、不跳、不抛）。
 *      R2 只派事件，**不 preventDefault / 不 stopPropagation** —— 文本选中、
 *      拖拽等默认行为要保留。
 *
 * 另有三道 R2 前置短路：非主键单击、选区未折叠（拖选中）、外链。
 *
 * @param event 鼠标事件
 * @param root 预览内容容器
 * @returns 是否由本模块处理（true = 已处理；只有 C3 / C5 会吞掉事件）
 */
export function handlePreviewClick(event: MouseEvent, root: HTMLElement): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;

  // C3：复制按钮
  const copyButton = target.closest(`.${COPY_BTN_CLASS}`);
  if (copyButton instanceof HTMLElement) {
    event.preventDefault();
    event.stopPropagation();
    void handleCopyClick(copyButton);
    return true;
  }

  // C5：内部锚点链接（#heading）。外链 / mailto / 其它协议不拦截。
  const anchor = target.closest('a');
  if (anchor instanceof HTMLAnchorElement) {
    const href = anchor.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      event.preventDefault();
      event.stopPropagation();
      scrollToAnchor(root, href.slice(1));
      return true;
    }
  }

  // R1：mermaid 容器（图本体 → 放大浮层；分段控件 → 切视图；容器留白 → 放行给 R2）。
  // 必须排在 R2 **之前**：图本体命中后会 stopPropagation，R2 就不会再跳编辑器。
  if (mermaidClickHandler && mermaidClickHandler(event, target)) return true;

  // R2 短路：外链 / mailto / 任何非 `#` 协议的链接 → 浏览器自己处理，不跳编辑器。
  // （`href` 缺失的 `<a>` 不是链接，按普通元素走下面的跳转。）
  if (anchor instanceof HTMLAnchorElement) {
    const href = anchor.getAttribute('href');
    if (href !== null && !href.startsWith('#')) return false;
  }

  // R2 短路：只认主键单击。右键（button !== 0）不该把编辑器跳走。
  if (event.button !== 0) return false;

  // R2 短路：**拖选文字时不跳**。否则用户在预览里选中一段文字，mouseup 触发
  // click → 编辑器跳过去抢焦点 → 选区当场丢失。单击会先把选区折叠，
  // 因此这里只在「选区未折叠」时让路。
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
  if (selection && !selection.isCollapsed && selection.toString().length > 0) return false;

  // R2：预览 → 编辑
  const line = resolveClickSourceLine(event, root);
  if (line === null) return false;
  requestEditorGotoLine(line);
  return true;
}
