/**
 * R1 UI 层：把 mermaid 引擎接进预览区
 *
 * 职责边界（`mermaid-renderer.ts` 是引擎层，**只管渲染/清洗/缓存**）：
 * - 把 ```mermaid 围栏的 `<pre>` 换成「容器 + 工具栏 + 图/源码双态」
 * - 逐块独立的 **Diagram ⟷ Source** 分段控件
 * - 图的 `<style>` 做 **CSS scoping**，不污染预览区全局样式（不用 iframe）
 * - 异步渲染的**陈旧渲染校验**（内容被重写后回来的旧图必须丢弃）
 * - 失败 / 未启用 / 关闭开关 → 一律降级为源码块，不崩不白屏
 * - 导出 HTML 时把已渲染的 SVG 内联进去（所见即所得）
 *
 * 三条来自 B2 的接缝约束（team-lead 2026-09-19 批准）：
 * 1. **锚点必须留在容器上**：`<div class="preview-mermaid" data-source-line=N
 *    data-source-line-end=M>`。否则 R2 的 `closest('[data-source-line]')` 扑空、
 *    R3 会退到前一个块定位，整个偏掉。锚点值取 `block.fenceStartLine`
 *    （= markdown-it fence token 的 `map[0]`，与 md-worker 打在 `<pre>` 上的同源），
 *    **不是** `block.startLine`（那是图源码首行，差 1）。
 * 2. **不用 iframe**：预览区是 innerHTML + 事件委托（C3/C5/R2 全挂在
 *    `.preview-content` 的捕获监听上），iframe 会把整套交互切断。
 * 3. **异步注入必须带陈旧渲染校验**，否则慢图会插进新 DOM。
 *
 * @module mermaid-preview
 */
import {
  MERMAID_LANG,
  hasMermaidBlock,
  extractMermaidBlocks,
  renderMermaidSvg,
  toMermaidErrorMessage,
  parseMermaidError,
} from './mermaid-renderer';
import type { MermaidBlock } from './mermaid-renderer';
import {
  CODE_BLOCK_CLASS,
  getCodeBlockText,
  setMermaidClickHandler,
  writeToClipboard,
} from './preview-enhance';
import {
  BLOCK_ACTIONS_CLASS,
  BLOCK_BAR_CLASS,
  BLOCK_KIND_CLASS,
  createBlockBar,
  readCodeLang,
} from './block-chrome';
import { isExtension } from './platform';
import type { Theme } from '../types';

// ──────────────────────────────────────────────
// 类名（CSS 见 globals.css「R1 mermaid 预览」；验收要 grep 产物）
// ──────────────────────────────────────────────

/** mermaid 容器（承载源行锚点） */
export const MERMAID_HOST_CLASS = 'preview-mermaid';
/** 分段控件容器（放进统一条 `.preview-block-actions` 内） */
export const MERMAID_SEG_CLASS = 'preview-mermaid-seg';
/** 分段控件按钮 */
export const MERMAID_SEG_BTN_CLASS = 'preview-mermaid-seg-btn';
/**
 * Copy 按钮 class（放进统一条 `.preview-block-actions` 内）。
 *
 * ⚠️ 刻意**不复用** C3 的 `.preview-copy-btn`：`preview-enhance.handlePreviewClick`
 * 会**优先拦截**该 class（`closest('.preview-copy-btn')` → `handleCopyClick`），而
 * `handleCopyClick` 的目标靠 `closest('.preview-codeblock')` 解析；本按钮在 host 层
 * （不在 codeblock 内）会失配（点一下只会显示 `Copy failed`）。
 * 故用独立 class，在 mermaid 的点击委托里自处理 —— 复用导出的
 * `writeToClipboard` / `getCodeBlockText`，不改 `preview-enhance.ts`。
 */
export const MERMAID_COPY_BTN_CLASS = 'preview-mermaid-copy';
/** 图的包裹层（Diagram 态显示） */
export const MERMAID_FIGURE_CLASS = 'preview-mermaid-figure';
/** 渲染失败提示（块上方） */
export const MERMAID_ERROR_CLASS = 'preview-mermaid-error';
/** 放大浮层（C2） */
export const MERMAID_ZOOM_CLASS = 'preview-mermaid-zoom';
/** 浮层遮罩 */
export const MERMAID_ZOOM_MASK_CLASS = 'preview-mermaid-zoom-mask';
/**
 * 浮层里承载 SVG 的容器 class（放大图 CSS 作用域目标）。
 *
 * 浮层的内联 SVG 必须把 `<style>` **重新作用域到本 class**（见
 * {@link MERMAID_HOST_CLASS} 之外的第二处 scope）：浮层不在
 * `.preview-mermaid[data-mermaid-scope]` 子树内，直接塞预览侧那份作用域化 SVG
 * 会导致整份图 CSS 失配（线不显示、形状变形、颜色错）。
 */
export const MERMAID_ZOOM_BODY_CLASS = 'preview-mermaid-zoom-body';

// （容器状态写在 `data-mermaid-state` 上：`loading` | `diagram` | `source` | `error`，
//   便于调试与人工点测断言；不额外定义类型，避免与 dataset 的字符串取值打架）

/** 放大浮层需要的数据 */
export interface MermaidZoomPayload {
  /**
   * 已清洗的 SVG 字符串（整段 `<svg …>…</svg>`），其 `<style>` 已**重新作用域**到
   * 浮层容器 {@link MERMAID_ZOOM_BODY_CLASS}，可**直接**内联进浮层（不要再过
   * `sanitizeHtml`，白名单不含 svg）。
   */
  svgHtml: string;
  /**
   * **未作用域化**的 SVG（补齐了 `xmlns` 等可独立打开所需的命名空间）。
   *
   * ⚠️ Download 必须用**这一份**，不能用 {@link svgHtml}：后者把图 CSS 选择器加成了
   * `.preview-mermaid-zoom-body .node rect {…}` 这类**带浮层祖先**的形式，一旦脱离浮层
   * （用户把文件存到磁盘、再用浏览器单独打开），那个祖先不存在 → **整份图 CSS 失配**
   * → 节点回到无样式的默认填充（实为黑块）。用户实测就是这个现象。
   */
  rawSvgHtml: string;
  /** 该图对应围栏首行的 0-based 源码行号（浮层元信息 / 调试用） */
  line: number;
}

/** 挂载选项 */
export interface MountMermaidOptions {
  /** 当前 Markdown 源码（用于抽 mermaid 块） */
  markdown: string;
  /** 应用主题（进缓存 key，切换会重渲染） */
  theme: Theme;
  /** 预览字体族（进缓存 key） */
  fontFamily?: string;
  /** 设置项「Mermaid 渲染」总开关；false 时不加载 mermaid、直接渲染为源码块 */
  enabled: boolean;
  /** 点击图本体时的回调（打开放大浮层） */
  onZoom: (payload: MermaidZoomPayload) => void;
}

/** 已渲染成功的图：`fenceStartLine → { svg, showingSource }`，导出内联用 */
const renderedBlocks = new Map<number, { svg: string; showingSource: boolean }>();

/**
 * 容器 → **未作用域化**的原始 SVG（浮层放大用）。
 *
 * 为什么单独存一份：预览 figure 里放的是 `scopeSvgStyles(svg, '.preview-mermaid[data-mermaid-scope=…]')`
 * 作用域化后的副本；若浮层直接拿 `host.querySelector('svg').outerHTML` 再作用域化，
 * 会**二次加前缀**（`.zoom-body .preview-mermaid[data-mermaid-scope] …`），在浮层里永不匹配。
 * 因此必须保留引擎产出的原图，浮层按需重新作用域到浮层容器。
 *
 * 用 WeakMap：容器被 `innerHTML` 冲掉 / `unwrapMermaidHosts` 移除后自动回收，无需手动清理。
 */
const rawSvgByHost = new WeakMap<HTMLElement, string>();

/** 挂载世代号：每次 mountMermaidBlocks 自增，异步回调据此判定是否陈旧 */
let generation = 0;

/** scope id 计数器（CSS scoping 用，保证同页唯一） */
let scopeSeq = 0;

// ──────────────────────────────────────────────
// 纯函数
// ──────────────────────────────────────────────

/**
 * 判定围栏的 info 串是不是 mermaid（**大小写不敏感**，PRD §1.1）。
 * @param info 围栏语言信息串（如 `mermaid`、`Mermaid`、`js`）
 * @returns 是否为 mermaid 块
 */
export function isMermaidInfo(info: string): boolean {
  // ⚠️ 刻意与引擎层 `hasMermaidBlock` / `extractMermaidBlocks` 的判等**完全一致**
  // （`info.trim().toLowerCase() === 'mermaid'`），不能自行放宽成「取首个 token」：
  // 若这里更宽松，会出现 `hasMermaidBlock` 闸门返回 false、UI 层却认定为
  // mermaid 的不一致，图永远渲染不出来。
  return (info ?? '').trim().toLowerCase() === MERMAID_LANG;
}

/**
 * 给一段 CSS 的所有选择器加作用域前缀（CSS scoping）。
 *
 * mermaid 生成的 SVG 里带 `<style>`，选择器形如 `.node rect` / `.edgePath path`
 * / `text` —— 直接进预览区会**污染全局**（把标题、表格的字体一起改掉），
 * 所以每个选择器都套上一层 `.preview-mermaid[data-mermaid-scope="mm-3"]`。
 *
 * 刻意用「扫描括号深度」而不是正则替换，两个原因：
 * - `@keyframes` 体内的 `0%` / `from` / `to` **不是选择器**，加前缀会变成
 *   `.scope 0% {}` 这种非法规则（mermaid 的流程图动画确实带 keyframes）；
 * - `@media` / `@supports` 这类 at-rule 的 prelude 本身不能被加前缀。
 *
 * @param css 原始 CSS 文本
 * @param scope 作用域选择器（如 `.preview-mermaid[data-mermaid-scope="mm-3"]`）
 * @returns 加完前缀的 CSS
 */
export function scopeMermaidCss(css: string, scope: string): string {
  const out: string[] = [];
  let prelude = '';
  let depth = 0;
  // 当前处于某个 @keyframes 体的深度（该层及其内部一律不加前缀）
  let keyframesBodyDepth: number | null = null;

  for (let i = 0; i < css.length; i++) {
    const ch = css[i];

    if (ch === '{') {
      const isKeyframesPrelude = /^@(-webkit-)?keyframes/i.test(prelude.trim());
      const inKeyframesBody = keyframesBodyDepth !== null && depth >= keyframesBodyDepth;
      if (isKeyframesPrelude) {
        keyframesBodyDepth = depth + 1;
        out.push(prelude);
      } else if (inKeyframesBody) {
        out.push(prelude);
      } else {
        out.push(prefixSelectors(prelude, scope));
      }
      out.push('{');
      prelude = '';
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;
      if (keyframesBodyDepth !== null && depth < keyframesBodyDepth) {
        keyframesBodyDepth = null;
      }
      out.push(prelude);
      out.push('}');
      prelude = '';
      continue;
    }

    prelude += ch;
  }

  out.push(prelude);
  return out.join('');
}

/**
 * 给一条 CSS prelude（可能含逗号分隔的多个选择器）加作用域前缀。
 * at-rule 的 prelude（`@media …` / `@supports …`）原样返回。
 * @param prelude CSS prelude
 * @param scope 作用域选择器
 * @returns 处理后的 prelude
 */
function prefixSelectors(prelude: string, scope: string): string {
  const trimmed = prelude.trim();
  if (trimmed === '') return prelude;
  // at-rule（@media / @supports …）不能加前缀，否则变成非法规则
  if (trimmed.startsWith('@')) return prelude;

  const scoped = trimmed
    .split(',')
    .map((part) => {
      const sel = part.trim();
      if (sel === '') return sel;
      return `${scope} ${sel}`;
    })
    .join(', ');

  // 保留原缩进形态（多行选择器列表）
  const leading = prelude.slice(0, prelude.length - prelude.trimStart().length);
  const trailing = prelude.slice(trimmed.length + leading.length);
  return `${leading}${scoped}${trailing}`;
}

/**
 * 把一段 SVG 里的 `<style>` 内容做 CSS scoping。
 *
 * 用 DOMParser 解析后再改写，避免用正则去匹配 HTML。
 * @param svgHtml SVG 字符串
 * @param scope 作用域选择器
 * @returns 处理后的 SVG 字符串
 */
export function scopeSvgStyles(svgHtml: string, scope: string): string {
  if (!svgHtml.includes('<style')) return svgHtml;

  const doc = new DOMParser().parseFromString(svgHtml, 'image/svg+xml');
  const styles = doc.querySelectorAll('style');
  if (styles.length === 0) return svgHtml;

  for (const style of Array.from(styles)) {
    const raw = style.textContent ?? '';
    if (raw.trim() === '') continue;
    style.textContent = scopeMermaidCss(raw, scope);
  }

  const svg = doc.querySelector('svg');
  if (!svg) return svgHtml;
  return svg.outerHTML;
}

/**
 * 把 SVG 变成**能脱离页面独立打开**的形态：补齐 `xmlns` 命名空间。
 *
 * 为什么需要：内联进 HTML 时缺 `xmlns` 也能渲染（浏览器按 HTML 解析）；但一旦**存成
 * `.svg` 文件单独打开**，浏览器就按 XML 严格解析 —— 缺命名空间会解析失败，或落到无
 * 样式的默认填充（用户实测的「下载的图是一片黑块」成因之一）。
 *
 * @param svgHtml 已清洗的 SVG 字符串
 * @returns 补齐命名空间后的 SVG 字符串（已带 xmlns 则原样返回）
 */
export function toStandaloneSvg(svgHtml: string): string {
  if (!/<svg\b/i.test(svgHtml) || svgHtml.includes('xmlns=')) return svgHtml;
  return svgHtml.replace(
    /<svg\b/i,
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"',
  );
}

// ──────────────────────────────────────────────
// DOM 构建 / 还原
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// 顶部统一条（#5）：复用 block-chrome 的 bar + 图类型标签
// ──────────────────────────────────────────────

/**
 * 被收编的原 C3 `.preview-copy-btn`：`bar → 原按钮`。
 *
 * 复用 C3 那条 bar 时，先把它自带的复制按钮摘下来暂存（它在 host 层会失配，
 * 见 {@link MERMAID_COPY_BTN_CLASS}），`unwrapMermaidHosts` 时再原样放回，
 * 让「退回普通代码块」的外观不变。
 */
const stashedCopyBtnByBar = new WeakMap<HTMLElement, HTMLElement>();

/**
 * 从 mermaid 块解析「图类型」（**不 import 引擎**）。
 *
 * 类型取**图定义首行首个 token**（`flowchart` / `sequenceDiagram` / `mindmap` …），
 * 而非 {@link MermaidBlock.info}（那只是围栏语言串 `mermaid`）。解析不出时兜底 `mermaid`。
 *
 * @param block mermaid 块
 * @returns 图类型名（保留原文大小写与 `-v2` 等后缀）
 */
function diagramKindOf(block: MermaidBlock): string {
  const first = block.code.split('\n').find((line) => line.trim().length > 0) ?? '';
  const token = first.trim().match(/^([A-Za-z][\w-]*)/)?.[1] ?? '';
  return token !== '' ? token : MERMAID_LANG;
}

/**
 * 造 Diagram ⟷ Source 分段控件。
 * @returns 分段控件容器（含两个按钮）
 */
function buildViewSeg(): HTMLElement {
  const seg = document.createElement('div');
  seg.className = MERMAID_SEG_CLASS;
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Mermaid view');
  for (const view of ['diagram', 'source'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${MERMAID_SEG_BTN_CLASS}${view === 'diagram' ? ' is-active' : ''}`;
    button.dataset.mermaidView = view;
    button.textContent = view === 'diagram' ? 'Diagram' : 'Source';
    seg.appendChild(button);
  }
  return seg;
}

/**
 * 取（或建）统一顶部条。
 *
 * 优先**复用** C3 已在 `codeNode`（`.preview-codeblock`）里建好的
 * `.preview-block-bar`：改类型标签为**图类型**（第三轮反馈：不再拼 `mermaid · ` 前缀，
 * 容器本身就是 mermaid，再说一遍是冗余）、摘掉原 `.preview-copy-btn`
 * （暂存见 {@link stashedCopyBtnByBar}）。找不到才用 `createBlockBar` 新建 ——
 * 两种来源结构一致（同一工厂），但**只会存在一条**。
 *
 * @param codeNode 源码块（`.preview-codeblock` 或裸 `<pre>`）
 * @param block mermaid 块
 * @returns `bar` 与它的操作区 `actions`
 */
function resolveBlockBar(
  codeNode: HTMLElement,
  block: MermaidBlock,
): { bar: HTMLElement; actions: HTMLElement } {
  const kindLabel = diagramKindOf(block);
  const existing = codeNode.querySelector(`.${BLOCK_BAR_CLASS}`) as HTMLElement | null;

  if (existing) {
    // 摘掉 C3 的复制按钮：它在 host 层会失配（见 MERMAID_COPY_BTN_CLASS），
    // 由本模块自己的 Copy 按钮统一接管；unwrap 时放回。
    const c3Copy = existing.querySelector('.preview-copy-btn');
    if (c3Copy instanceof HTMLElement) {
      stashedCopyBtnByBar.set(existing, c3Copy);
      c3Copy.remove();
    }
    const kindEl = existing.querySelector(`.${BLOCK_KIND_CLASS}`);
    if (kindEl) kindEl.textContent = kindLabel;
    const actions = existing.querySelector(`.${BLOCK_ACTIONS_CLASS}`);
    if (actions instanceof HTMLElement) return { bar: existing, actions };
    const fallback = document.createElement('div');
    fallback.className = BLOCK_ACTIONS_CLASS;
    existing.appendChild(fallback);
    return { bar: existing, actions: fallback };
  }

  return createBlockBar(kindLabel);
}

/**
 * 把 mermaid 的 `<pre>`（或其 C3 包裹层）搬进新建的容器。
 *
 * 锚点属性**搬而不复制**：同一块若同时存在两个 `[data-source-line]` 值相同的
 * 元素，R3 的块扫描会命中两个、R2 的 `closest` 也会因 DOM 顺序产生歧义。
 *
 * @param pre 源 `<pre>`
 * @param block 对应的 mermaid 块
 * @returns 新建的容器
 */
function buildMermaidHost(pre: HTMLElement, block: MermaidBlock): HTMLElement {
  const parent = pre.parentElement;
  if (!parent) throw new Error('mermaid <pre> has no parent');

  // C3 已把 `<pre>` 包进 `.preview-codeblock`（含复制按钮）→ 整层搬进去，
  // Source 态才能复用 hljs 样式与复制按钮。
  const codeNode: HTMLElement =
    parent.classList.contains(CODE_BLOCK_CLASS) ? parent : pre;

  const scopeId = `mm-${(scopeSeq += 1)}`;
  const host = document.createElement('div');
  host.className = MERMAID_HOST_CLASS;
  host.dataset.sourceLine = String(block.fenceStartLine);
  // 多行块才打 end（与 md-worker 端契约一致：读不到时下游按 start+1 兜底）
  if (block.fenceEndLine - block.fenceStartLine > 1) {
    host.dataset.sourceLineEnd = String(block.fenceEndLine);
  }
  host.dataset.mermaidScope = scopeId;
  host.dataset.mermaidState = 'loading';

  for (const attr of ['data-source-line', 'data-source-line-end']) {
    const value = pre.getAttribute(attr) ?? codeNode.getAttribute(attr);
    if (value !== null) {
      pre.removeAttribute(attr);
      codeNode.removeAttribute(attr);
    }
  }

  // 顶部统一条（**流内首行**，放在最前）：优先复用 C3 给 codeNode 建的那条
  // `.preview-block-bar`（block-chrome.createBlockBar 产物），把类型标签改成图类型，
  // 并把 [Diagram|Source] 分段控件 + Copy 按钮都塞进它的 `.preview-block-actions`。
  // 复用而非新建 → `.preview-mermaid` 内**恰好一条** bar（不并存两套）。
  const { bar, actions } = resolveBlockBar(codeNode, block);

  // ⚠️ 操作区顺序：**Copy 在左、Diagram|Source 在右**（第三轮点测反馈）。
  // 复制是主操作且两类视图都用得上，放最左；视图切换是次操作，靠右。
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = MERMAID_COPY_BTN_CLASS;
  copyBtn.textContent = 'Copy';
  copyBtn.setAttribute('aria-label', 'Copy diagram or source');
  actions.appendChild(copyBtn);

  const seg = buildViewSeg();
  actions.appendChild(seg);

  // 图包裹层（渲染成功后填内容）
  const figure = document.createElement('div');
  figure.className = MERMAID_FIGURE_CLASS;

  // ⚠️ 插入位置必须按 `codeNode` 的**实际父节点**算，不能一律用 `parent`。
  //
  // `codeNode` 有两种形态：
  //   - 裸 `<pre>`（未被 C3 包裹）→ parent 就是 `<pre>` 的父节点；
  //   - `.preview-codeblock` 包裹层（C3 已跑过）→ `codeNode === parent` 本身。
  //
  // 后者**在生产里必然发生**：`PreviewPane` 在 `useLayoutEffect` 里先
  // `innerHTML = processedHtml` 再 `enhancePreviewContent(el)`（把 `<pre>` 包进
  // `.preview-codeblock`），随后 R1 的 `useEffect` 才调 `mountMermaidBlocks`。
  // 若仍写成 `parent.insertBefore(host, codeNode)`，当 `codeNode === parent` 时
  // 就等价于「把 host 插到 parent 自己前面」——parent 不是自己的子节点，浏览器
  // 抛 `NotFoundError: The node before which the new node is to be inserted is not
  // a child of this node.`。
  //
  // 致命之处在于这一句**紧跟在「锚点删除」之后**：异常被 `mountMermaidBlocks`
  // 的 `catch { continue; }` 静默吞掉 → `<pre>` 的 `data-source-line` 被抹掉、
  // 容器却没建出来 → 预览里既没有图、也定位不了行（真机插件版实测复现，
  // 见 `qa-mermaid-ext-repro.mjs`）。jsdom 单测因样例是「裸 `<pre>`」从未覆盖此分支。
  const insertionParent: HTMLElement | null =
    codeNode === pre ? parent : parent.parentElement;
  if (!insertionParent) {
    throw new Error('mermaid 代码块缺少可插入的父节点');
  }
  insertionParent.insertBefore(host, codeNode);

  host.appendChild(bar);
  host.appendChild(figure);
  host.appendChild(codeNode);

  return host;
}

/**
 * 还原所有 mermaid 容器为原始源码块（幂等的前置步骤）。
 *
 * 三个用途：① mount 前先还原，保证重复调用不嵌套；② 关闭开关时退回源码块；
 * ③ 主题切换重渲染前先还原。
 * @param root 预览内容容器
 */
export function unwrapMermaidHosts(root: HTMLElement): void {
  renderedBlocks.clear();
  const hosts = Array.from(root.querySelectorAll(`.${MERMAID_HOST_CLASS}`));
  for (const host of hosts) {
    const parent = host.parentElement;
    if (!parent) continue;

    const figure = host.querySelector(`.${MERMAID_FIGURE_CLASS}`);
    figure?.remove();
    host.querySelector(`.${MERMAID_ERROR_CLASS}`)?.remove();

    // 源码块（C3 包裹层或裸 pre）—— findCodeNode 会跳过统一条与 figure
    const codeNode = findCodeNode(host as HTMLElement);

    // 统一条处理：
    // - **复用的**（有暂存的原 C3 复制按钮）→ 还原成代码块原样（移除本模块加的
    //   分段控件 / Copy，放回原 C3 复制按钮，改回语言标签）后塞回 codeNode；
    // - **自建的**（host 层新建、无 C3 出身）→ 直接丢弃。
    const bar = host.querySelector(`.${BLOCK_BAR_CLASS}`) as HTMLElement | null;
    if (bar) {
      const stashed = stashedCopyBtnByBar.get(bar);
      if (stashed) {
        bar.querySelector(`.${MERMAID_SEG_CLASS}`)?.remove();
        bar.querySelector(`.${MERMAID_COPY_BTN_CLASS}`)?.remove();
        const actions = bar.querySelector(`.${BLOCK_ACTIONS_CLASS}`) ?? bar;
        actions.appendChild(stashed);
        stashedCopyBtnByBar.delete(bar);
        const pre = codeNode?.matches('pre') ? codeNode : codeNode?.querySelector('pre');
        const kindEl = bar.querySelector(`.${BLOCK_KIND_CLASS}`);
        if (kindEl && pre) kindEl.textContent = readCodeLang(pre) ?? 'text';
        codeNode?.insertBefore(bar, codeNode.firstChild);
      } else {
        bar.remove();
      }
    }

    // 剩下的就是源码块：搬回 host 的位置并恢复锚点
    if (codeNode) {
      const pre = codeNode.matches('pre') ? codeNode : codeNode.querySelector('pre');
      const target = (pre as HTMLElement | null) ?? codeNode;
      const line = host.getAttribute('data-source-line');
      if (line !== null) target.setAttribute('data-source-line', line);
      const lineEnd = host.getAttribute('data-source-line-end');
      if (lineEnd !== null) target.setAttribute('data-source-line-end', lineEnd);
      parent.insertBefore(codeNode, host);
    }
    host.remove();
  }
}

/**
 * 取容器里承载源码块的元素（C3 包裹层或裸 `<pre>`）。
 * @param host mermaid 容器
 * @returns 源码块元素
 */
function findCodeNode(host: HTMLElement): HTMLElement | null {
  const figure = host.querySelector(`.${MERMAID_FIGURE_CLASS}`);
  for (const child of Array.from(host.children)) {
    if (child === figure) continue;
    if (child.classList.contains(BLOCK_BAR_CLASS)) continue;
    if (child.classList.contains(MERMAID_ERROR_CLASS)) continue;
    return child as HTMLElement;
  }
  return null;
}

/**
 * 切换某一块的 Diagram / Source 视图（**逐块独立**）。
 * @param host mermaid 容器
 * @param view 目标视图
 */
export function setMermaidView(host: HTMLElement, view: 'diagram' | 'source'): void {
  const figure = host.querySelector(`.${MERMAID_FIGURE_CLASS}`) as HTMLElement | null;
  const codeNode = findCodeNode(host);
  const hasSvg = !!figure?.querySelector('svg');
  const line = Number(host.dataset.sourceLine ?? '-1');

  // 没有可显示的图（加载中 / 失败 / 被裁）→ Source 是唯一可选
  const effective: 'diagram' | 'source' = view === 'diagram' && hasSvg ? 'diagram' : 'source';

  if (figure) figure.hidden = effective !== 'diagram';
  if (codeNode) codeNode.hidden = effective === 'diagram';

  for (const button of Array.from(host.querySelectorAll(`.${MERMAID_SEG_BTN_CLASS}`))) {
    const isActive = (button as HTMLElement).dataset.mermaidView === effective;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  }

  if (effective === 'source') {
    // `error` 是**粘性**状态：失败后退回源码块时不能把它覆盖成 'source'，
    // 否则调试 / 点测看不出这块其实是渲染失败。只有下一次成功渲染才会改写。
    if (host.dataset.mermaidState !== 'error') host.dataset.mermaidState = 'source';
  } else if (host.dataset.mermaidState !== 'error') {
    host.dataset.mermaidState = 'diagram';
  }

  const entry = renderedBlocks.get(line);
  if (entry) entry.showingSource = effective === 'source';
}

/**
 * 渲染失败：显示提示 + 退回源码块。
 * @param host mermaid 容器
 * @param message 面向用户的错误文案
 */
function showMermaidError(host: HTMLElement, message: string): void {
  let tip = host.querySelector(`.${MERMAID_ERROR_CLASS}`) as HTMLElement | null;
  if (!tip) {
    tip = document.createElement('p');
    tip.className = MERMAID_ERROR_CLASS;
    // 插在最前（控制条之后、源码块之前）—— 规格要求「块上方」
    const codeNode = findCodeNode(host);
    if (codeNode) {
      host.insertBefore(tip, codeNode);
    } else {
      host.appendChild(tip);
    }
  }
  tip.textContent = message;
  host.dataset.mermaidState = 'error';
  const line = Number(host.dataset.sourceLine ?? '-1');
  renderedBlocks.delete(line);
  setMermaidView(host, 'source');
}

/**
 * 生成 mermaid 报错的**用户可见文案**（i18n + 去除内部引用）。
 *
 * 两条硬规则：
 * 1. **按平台选语言**：`extension === true`（插件版）全英文 —— 本轮 requirement；
 *    `false`（桌面版）中文。两套措辞都**不得**出现「PRD §1.2」「构建产物体积」
 *    这类内部引用（与语言无关，任何语言下都不该透）。
 * 2. **判定不在这里**：是否属于「能力未启用」完全交给引擎层
 *    {@link parseMermaidError}（语言中立标记），本函数只负责措辞。
 *
 * 刻意做成**纯函数**（平台作为入参而非读模块级 `isExtension`）：两个分支都能被
 * 单测确定性地覆盖，不需要 mock 模块。
 *
 * @param message {@link toMermaidErrorMessage} 产出的原始消息
 * @param extension 是否插件版（true = 英文，false = 中文）
 * @returns 面向用户的文案
 */
export function formatMermaidError(message: string, extension: boolean): string {
  const info = parseMermaidError(message);
  if (info.kind === 'diagram-disabled') {
    const type = info.diagram || 'unknown';
    return extension
      ? `Diagram type '${type}' is not included in this build.`
      : `图类型 '${type}' 未包含在此构建中。`;
  }
  if (info.kind === 'katex-disabled') {
    return extension
      ? 'Math formulas (KaTeX) are not included in this build.'
      : '数学公式（KaTeX）未包含在此构建中。';
  }
  return extension ? `Mermaid render failed: ${message}` : `Mermaid 渲染失败：${message}`;
}

// ──────────────────────────────────────────────
// 挂载入口
// ──────────────────────────────────────────────

/**
 * 扫描预览 DOM，把所有 mermaid 围栏块升级为「图 / 源码」双态容器。
 *
 * **同步**部分只做 DOM 包裹；SVG 渲染是异步的，每个异步回调都会先做
 * 陈旧校验（世代号 + 节点是否仍在文档中），避免慢图插进已被重写的新 DOM。
 *
 * @param root 预览内容容器（`.preview-content`）
 * @param options 挂载选项
 * @returns 本次**成功升级为容器**的块数（0 = 文档里没有 mermaid 块 / 开关关闭 /
 *          锚点缺失或容器构建失败）
 */
export function mountMermaidBlocks(root: HTMLElement, options: MountMermaidOptions): number {
  // 幂等：先把上一轮的容器还原成源码块
  unwrapMermaidHosts(root);

  // 内容还没写进 DOM（首次挂载 / 换文档瞬间：`PreviewPane` 的 `useLayoutEffect`
  // 尚未把 `processedHtml` 写入容器）——此时根本没有可升级的目标，静默返回。
  // ⚠️ 不加这道闸，首挂会对着**空容器**发一串「未找到锚点」的假警告（真机实测 4 条），
  // 把真正的失败淹没在噪音里，反而让刚加的失败留痕失效。
  if (root.childElementCount === 0) return 0;

  const { markdown, enabled } = options;
  if (!enabled) return 0;

  // 闸门：文档里没有 mermaid 块时**完全不 import** mermaid（PRD §1.1 零加载成本）
  if (!hasMermaidBlock(markdown)) return 0;

  const blocks = extractMermaidBlocks(markdown).filter((block) => isMermaidInfo(block.info));
  if (blocks.length === 0) return 0;

  const myGeneration = (generation += 1);
  let upgraded = 0;

  for (const block of blocks) {
    const pre = root.querySelector(
      `pre[data-source-line="${block.fenceStartLine}"]`,
    ) as HTMLElement | null;
    if (!pre) {
      // ⚠️ 不能静默跳过。锚点找不到 = 这一块永远不会升成图，用户只看到源码块，
      // 而且**没有任何痕迹**。明确报出期望锚点，避免「图不显示且无日志」重演。
      console.warn(
        `[MDnote] mermaid: 未找到锚点 pre[data-source-line="${block.fenceStartLine}"]，`
        + '已跳过该块（预览将只显示源码块）。',
      );
      continue;
    }

    let host: HTMLElement;
    try {
      host = buildMermaidHost(pre, block);
    } catch (err) {
      // ⚠️ 这里原来只 `catch { continue; }`：一次异常（例如插入位置算错导致的
      // NotFoundError）会被完全吞掉 —— 锚点已被删除、容器却没建出来，表现就是
      // 「mermaid 图不渲染、控制台一片安静」。本轮 P0 的根因正是被这里掩盖的。
      // 现在必须留痕，任何构建失败都能在控制台第一眼看到。
      console.warn('[MDnote] mermaid: 容器构建失败，该块降级为源码块。', err);
      continue;
    }

    upgraded += 1;
    void renderIntoHost(host, block, options, myGeneration);
  }

  // 总闸告警：明明检测到 mermaid 块，却一个都没升级成功（锚点缺失 / 构建失败）
  if (blocks.length > 0 && upgraded === 0) {
    console.warn(
      `[MDnote] mermaid: 检测到 ${blocks.length} 个 mermaid 块，但全部未能升级为图`
      + '（锚点缺失或容器构建失败），预览将只有源码块。',
    );
  }

  return upgraded;
}

/**
 * 异步渲染单个块并写入容器（带陈旧校验）。
 * @param host 容器
 * @param block mermaid 块
 * @param options 挂载选项
 * @param myGeneration 本次挂载的世代号
 */
async function renderIntoHost(
  host: HTMLElement,
  block: MermaidBlock,
  options: MountMermaidOptions,
  myGeneration: number,
): Promise<void> {
  const scope = `.${MERMAID_HOST_CLASS}[data-mermaid-scope="${host.dataset.mermaidScope ?? ''}"]`;

  try {
    const svg = await renderMermaidSvg(block.code, {
      theme: options.theme,
      fontFamily: options.fontFamily,
    });

    // 陈旧校验 ①：又挂载了一轮（内容变了 / 主题变了）
    if (myGeneration !== generation) return;
    // 陈旧校验 ②：容器已被 innerHTML 重写冲掉
    if (!host.isConnected) return;

    const figure = host.querySelector(`.${MERMAID_FIGURE_CLASS}`) as HTMLElement | null;
    if (!figure) return;

    const scoped = scopeSvgStyles(svg, scope);
    figure.innerHTML = scoped;

    // 保留**未作用域化**的原图，供放大浮层按需重新作用域（不能复用 figure 里那份，见 rawSvgByHost）
    rawSvgByHost.set(host, svg);

    const line = Number(host.dataset.sourceLine ?? '-1');
    renderedBlocks.set(line, { svg: scoped, showingSource: false });

    host.dataset.mermaidState = 'diagram';
    setMermaidView(host, 'diagram');
  } catch (error) {
    if (myGeneration !== generation) return;
    if (!host.isConnected) return;

    const message = toMermaidErrorMessage(error);
    // 判定与文案分离：引擎层产出**语言中立**标记，这里按平台生成用户可见文案
    showMermaidError(host, formatMermaidError(message, isExtension));
  }
}

// ──────────────────────────────────────────────
// 点击归属（U1）
// ──────────────────────────────────────────────

/** 当前挂载时的放大回调（模块级，供委托处理器使用） */
let zoomHandler: ((payload: MermaidZoomPayload) => void) | null = null;

/**
 * 记录本次挂载的放大回调。
 * @param handler 回调；传 null 表示卸载
 */
export function setMermaidZoomHandler(
  handler: ((payload: MermaidZoomPayload) => void) | null,
): void {
  zoomHandler = handler;
}

/** Copy 反馈保持时长（ms）——与 C3 的 `.preview-copy-btn` 对齐 */
const COPY_FEEDBACK_MS = 1500;

/** Copy 反馈计时器（连点重置；WeakMap 随按钮回收） */
const copyTimers = new WeakMap<HTMLElement, number>();

/**
 * 在 Copy 按钮上打反馈态（`is-copied` / `is-failed`），1.5s 后复位。
 * 文案与 C3 一致（`✓ Copied` / `Copy failed`）。
 * @param button Copy 按钮
 * @param ok 是否成功
 */
function setCopyFeedback(button: HTMLElement, ok: boolean): void {
  const prev = copyTimers.get(button);
  if (prev !== undefined) window.clearTimeout(prev);

  button.classList.remove('is-copied', 'is-failed');
  button.classList.add(ok ? 'is-copied' : 'is-failed');
  button.textContent = ok ? '✓ Copied' : 'Copy failed';

  const timer = window.setTimeout(() => {
    button.classList.remove('is-copied', 'is-failed');
    button.textContent = 'Copy';
    copyTimers.delete(button);
  }, COPY_FEEDBACK_MS);
  copyTimers.set(button, timer);
}

/**
 * 处理统一条里 Copy 按钮的点击（#6）：**目标随当前视图变** ——
 * - Diagram 态：复制**未作用域化的原始 SVG**（对用户最可用，见 rawSvgByHost）；
 * - Source 态：复制源码文本（与 C3 一致，复用 `getCodeBlockText`）。
 * 写剪贴板复用 `writeToClipboard`（C3 同一实现，含 execCommand 兜底）。
 *
 * @param host mermaid 容器
 * @param button 被点击的 Copy 按钮
 */
async function handleMermaidCopy(host: HTMLElement, button: HTMLElement): Promise<void> {
  let text = '';
  if (host.dataset.mermaidState === 'diagram') {
    const raw = rawSvgByHost.get(host);
    const svg = host.querySelector('svg');
    text = raw ?? svg?.outerHTML ?? '';
  } else {
    const codeNode = findCodeNode(host);
    const pre = codeNode?.matches('pre') ? codeNode : codeNode?.querySelector('pre');
    if (pre) text = getCodeBlockText(pre as HTMLElement);
  }
  const ok = text !== '' && (await writeToClipboard(text));
  setCopyFeedback(button, ok);
}

/**
 * mermaid 容器的点击归属（由 `preview-enhance.handlePreviewClick` 在 C3/C5
 * 之后、R2 之前调用）：
 *
 * - **分段控件** → 消费（切换视图）
 * - **Copy 按钮** → 消费（按视图复制 SVG / 源码文本）
 * - **统一条留白** → 消费（不冒泡，别让 R2 跳编辑器）
 * - **图本体**（`svg` 内）→ 消费，打开放大浮层
 * - **容器留白** → **不消费**，放行给 R2「按源行跳编辑器」
 *
 * @param event 鼠标事件
 * @param target 点击命中的元素
 * @returns 是否消费该事件（false = 不在 mermaid 图内，或在容器留白上）
 */
function handleMermaidClick(event: MouseEvent, target: Element): boolean {
  const host = target.closest(`.${MERMAID_HOST_CLASS}`);
  if (!(host instanceof HTMLElement)) return false;

  // ① 分段控件按钮
  const segButton = target.closest(`.${MERMAID_SEG_BTN_CLASS}`);
  if (segButton instanceof HTMLElement) {
    event.preventDefault();
    event.stopPropagation();
    setMermaidView(host, segButton.dataset.mermaidView === 'source' ? 'source' : 'diagram');
    return true;
  }

  // ①b Copy 按钮（#6）：目标随视图变（Diagram→SVG，Source→源码文本）
  const copyButton = target.closest(`.${MERMAID_COPY_BTN_CLASS}`);
  if (copyButton instanceof HTMLElement) {
    event.preventDefault();
    event.stopPropagation();
    void handleMermaidCopy(host, copyButton);
    return true;
  }

  // ② 统一条（含按钮留白）：吞掉，别让 R2 把编辑器跳走
  if (target.closest(`.${BLOCK_BAR_CLASS}`)) {
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  // ③ 图本体 → 放大浮层
  if (target.closest('svg')) {
    event.preventDefault();
    event.stopPropagation();
    const svg = host.querySelector('svg');
    if (svg && zoomHandler) {
      // 浮层不在预览 figure 的 scope 子树内 → 必须把图的 `<style>` **重新作用域**
      // 到浮层容器。用 rawSvgByHost 里的**原始未作用域** SVG：figure 里那份已带
      // `.preview-mermaid[data-mermaid-scope]` 前缀，再作用域一次会二次加前缀、浮层里失配。
      // 极端兜底：拿不到原始图（不应发生）时退化为预览那份（至少不白屏）。
      const rawSvg = rawSvgByHost.get(host);
      const baseSvg = rawSvg ?? svg.outerHTML;
      zoomHandler({
        svgHtml: rawSvg
          ? scopeSvgStyles(rawSvg, `.${MERMAID_ZOOM_BODY_CLASS}`)
          : svg.outerHTML,
        // ⚠️ Download 必须用**未作用域**的这份：上面那份把图 CSS 加成了
        // `.preview-mermaid-zoom-body .node rect{…}`，用户把文件存到磁盘单独打开时
        // 该祖先不存在 → 整份图 CSS 失配 → 黑块（见 MermaidZoomPayload.rawSvgHtml）。
        // Copy 同理走 `rawSvgByHost`（:handleMermaidCopy），两处口径一致。
        rawSvgHtml: toStandaloneSvg(baseSvg),
        line: Number(host.dataset.sourceLine ?? '-1'),
      });
    }
    return true;
  }

  // ④ 容器留白 → 放行给 R2
  return false;
}

// 注册到 preview-enhance 的统一委托（避免两个监听器抢事件）
setMermaidClickHandler(handleMermaidClick);

// ──────────────────────────────────────────────
// 导出 HTML：所见即所得（D3 / C6）
// ──────────────────────────────────────────────

/**
 * 把导出 HTML 里的 mermaid 源码块替换成**已渲染的 SVG**（所见即所得）。
 *
 * 规则：
 * - 预览里该块正显示为**图** → 内联那张 SVG；
 * - 预览里是**源码块**（用户切到 Source / 渲染失败 / 开关关闭 / 还没渲染出来）
 *   → 保持源码块原样。
 *
 * @param html 导出的完整 HTML 字符串
 * @returns 处理后的 HTML；没有可替换内容时原样返回
 */
export function inlineMermaidIntoHtml(html: string): string {
  if (renderedBlocks.size === 0) return html;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  let replaced = 0;

  for (const [line, entry] of renderedBlocks) {
    if (entry.showingSource) continue;
    const pre = doc.querySelector(`pre[data-source-line="${line}"]`);
    if (!pre) continue;

    const wrap = doc.createElement('div');
    wrap.className = MERMAID_HOST_CLASS;
    wrap.dataset.sourceLine = String(line);
    wrap.innerHTML = entry.svg;
    pre.replaceWith(wrap);
    replaced += 1;
  }

  if (replaced === 0) return html;
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

/**
 * 清空已渲染图登记表（换文档 / 关闭开关时调用）。
 *
 * 不主动清会让「上一份文档渲染过的图」被内联进下一份文档的导出里。
 */
export function clearRenderedMermaid(): void {
  renderedBlocks.clear();
}
