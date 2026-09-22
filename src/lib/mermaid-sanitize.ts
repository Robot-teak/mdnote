/**
 * mermaid SVG 专用清洗模块（TB-01 采纳方案 A+B 合体）
 *
 * ⛔ **不要改 `src/lib/sanitize.ts` 的全局白名单** —— 方案 C「扩展全局白名单」
 * 已被 02 验证报告否决。本文件用 **DOMPurify 独立第二实例** 处理 mermaid 产出的
 * SVG 片段，与 Markdown 主体清洗零污染。
 *
 * 关键结论（dompurify 3.2.0 实测，见 02 验证报告 TB-01）：
 * 1. ESM 默认导出本身是工厂函数：`DOMPurify(root)` → **全新独立实例**
 *    （源码 `const DOMPurify = root => createDOMPurify(root);`）
 *    新实例有独立 CONFIG / hooks，与 Markdown 主体实例零污染。
 * 2. **不能用 `USE_PROFILES: { svg: true }`**：DOMPurify 启用 svg profile 时会
 *    强制把 `svgDisallowed`（含 foreignObject / use / animate / set / script …）
 *    塞进 FORBID_TAGS，而 mermaid 的 htmlLabels 依赖 foreignObject →
 *    会出现"标签莫名消失"。因此本文件用**显式白名单**，不用 profile。
 * 3. 白名单来源：对 11 种保留图的真实渲染 SVG 做标签/属性全量盘点（21 个标签 /
 *    62 个属性），白名单 = 实际用到 ∪ 极小安全余量，其余一律不放行。
 *
 * @module mermaid-sanitize
 */

import DOMPurify from 'dompurify';

// ──────────────────────────────────────────────
// 独立第二实例
// ──────────────────────────────────────────────

/**
 * mermaid SVG 专用 Purify 实例。
 *
 * `DOMPurify(window)` 返回**全新实例**（不是单例），因此下面所有 setConfig /
 * addHook 都只作用于本实例，不影响 `src/lib/sanitize.ts` 的 Markdown 主体清洗强度。
 * 双实例隔离已由 TB-01 实测（调用本模块前后，Markdown 实例输出完全一致）。
 */
const svgPurify = DOMPurify(window);

/**
 * 从 `setConfig` 的形参反推配置类型。
 *
 * 为什么不直接写 `DOMPurify.Config`：本机同时存在 dompurify 3.2.0 **自带**的
 * `dist/purify.es.d.mts` 与 `@types/dompurify@3.0.5`，后者带 `export as namespace DOMPurify`
 * 会注册一个 UMD 全局命名空间 —— 直接写 `DOMPurify.Config` 会解析到 `@types` 那份，
 * 与 `setConfig` 形参用的自带那份不是同一个类型（实测 `PARSER_MEDIA_TYPE` 冲突）。
 * 从形参反推可保证与运行时真正消费的类型一致。
 */
type PurifyConfig = Parameters<typeof svgPurify.setConfig>[0];

/**
 * `setConfig` 的形参类型尚未收录这三个键（dompurify 3.2 支持但类型未声明）。
 * 单独扩展出来，避免用 `as unknown as` 把整份配置的类型安全一起丢掉。
 */
type SvgPurifyConfig = PurifyConfig & {
  /**
   * ⚠️ 必须是**对象**而不是数组：DOMPurify 这里是 `cfg.X || 默认值` 直接赋值
   * （不做 addToSet），传数组会让 `HTML_INTEGRATION_POINTS['foreignobject']` 恒为 undefined。
   */
  HTML_INTEGRATION_POINTS?: Record<string, boolean>;
  MATHML_TEXT_INTEGRATION_POINTS?: Record<string, boolean>;
  SAFE_FOR_XML?: boolean;
};

// ──────────────────────────────────────────────
// CSS 值收敛
// ──────────────────────────────────────────────

/**
 * 收敛 CSS 值：去掉外联 `url()` / `@import` / `expression()`，
 * **保留同文档片段 `url(#id)`**（mermaid 的渐变与滤镜依赖它，TB-01 风险 #3 明确为有意为之）。
 *
 * @param css 原始 CSS 文本（`style=` 属性值或 `<style>` 元素正文）
 * @returns 收敛后的 CSS 文本
 */
export function sanitizeCssValue(css: string): string {
  if (!css) return css;
  return css
    .replace(/@import\s+[^;]*;?/gi, '')                                    // @import
    .replace(/url\(\s*['"]?\s*(?!#)\s*[a-z0-9.+-]*:\/\/[^)]*\)/gi, 'none')  // url(http…)
    .replace(/url\(\s*['"]?\s*(?!#)\s*\/\/[^)]*\)/gi, 'none')               // url(//evil)
    .replace(/url\(\s*['"]?\s*(?!#)\s*data:[^)]*\)/gi, 'none')              // url(data:…)
    .replace(/\bexpression\s*\((?:[^()]|\([^()]*\))*\)/gi, 'none')           // IE expression()
    .replace(/-moz-binding\s*:[^;]*;?/gi, '')
    .replace(/behavior\s*:[^;]*;?/gi, '');
}

// ──────────────────────────────────────────────
// 白名单（显式，不用 USE_PROFILES）
// ──────────────────────────────────────────────

/** mermaid 11 种保留图实际用到的标签 ∪ 安全余量 */
export const SVG_ALLOWED_TAGS: string[] = [
  // 根与结构
  'svg', 'g', 'defs', 'symbol', 'switch', 'title', 'desc', 'style',
  'marker', 'clippath', 'mask', 'pattern',
  'lineargradient', 'radialgradient', 'stop',
  // 图形
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  // 文本
  'text', 'tspan', 'textpath',
  // 滤镜（mermaid 的 drop-shadow）
  'filter', 'fedropshadow', 'fegaussianblur', 'feoffset', 'femerge',
  'femergenode', 'feblend', 'fecolormatrix', 'feflood', 'fecomposite',
  // foreignObject 与其中的 HTML 子集（mermaid htmlLabels 依赖）
  'foreignobject', 'div', 'span', 'p', 'br', 'b', 'i', 'em', 'strong',
  'sub', 'sup', 'ul', 'ol', 'li', 'a', 'img',
];

/** mermaid 11 种保留图实际用到的属性 ∪ 安全余量 */
export const SVG_ALLOWED_ATTR: string[] = [
  // 通用
  'id', 'class', 'style', 'xmlns', 'xmlns:xlink', 'xlink:href', 'href',
  'role', 'tabindex', 'lang', 'dir', 'title', 'name', 'target', 'rel',
  'aria-label', 'aria-hidden', 'aria-roledescription',
  'aria-describedby', 'aria-labelledby',
  // 几何
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'width', 'height', 'points', 'd', 'transform', 'transform-origin',
  'viewbox', 'preserveaspectratio', 'overflow', 'opacity',
  // 描边填充
  'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap',
  'stroke-linejoin', 'stroke-opacity', 'clip-rule', 'clip-path', 'mask',
  // 文本
  'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'dominant-baseline', 'alignment-baseline',
  'dx', 'dy', 'letter-spacing', 'word-spacing', 'xml:space', 'xml:lang',
  'text-decoration', 'white-space', 'paint-order',
  // marker
  'marker-start', 'marker-mid', 'marker-end',
  'markerwidth', 'markerheight', 'markerunits', 'refx', 'refy', 'orient',
  // 渐变 / pattern
  'offset', 'stop-color', 'stop-opacity', 'gradientunits',
  'gradienttransform', 'patternunits', 'patterntransform',
  // 滤镜
  'stddeviation', 'flood-color', 'flood-opacity', 'in', 'in2', 'result',
  'mode', 'type', 'values', 'filterunits', 'primitiveunits',
  // 矢量特效（允许，非动画）
  'vector-effect', 'shape-rendering',
  // HTML 子集（foreignObject 内）
  'colspan', 'rowspan', 'scope', 'alt', 'src', 'srcset', 'loading',
];

/** 显式禁止的标签（白名单之外的二次兜底） */
export const SVG_FORBID_TAGS: string[] = [
  // 脚本与执行面
  'script', 'iframe', 'object', 'embed', 'applet', 'frame', 'frameset',
  'base', 'meta', 'link', 'template', 'noscript',
  // 表单
  'form', 'input', 'button', 'textarea', 'select', 'option', 'label',
  // 外联 / 引用
  'use', 'cursor', 'font-face-uri', 'audio', 'video', 'source', 'track',
  // SMIL 动画：事件属性 / href 篡改的载体，mermaid 不使用
  'animate', 'animatecolor', 'animatemotion', 'animatetransform',
  'set', 'discard', 'handler', 'mpath',
  // 文档级标签
  'html', 'head', 'body',
];

const SVG_CONFIG: SvgPurifyConfig = {
  ALLOWED_TAGS: SVG_ALLOWED_TAGS,
  ALLOWED_ATTR: SVG_ALLOWED_ATTR,
  FORBID_TAGS: SVG_FORBID_TAGS,
  FORBID_ATTR: ['formaction', 'autofocus', 'srcdoc'],
  ALLOW_DATA_ATTR: true,
  ALLOW_ARIA_ATTR: true,
  // SVG 内一律不放行 data: / javascript: / vbscript:
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  // ⚠️ 必须为 true：DOMPurify 只在 KEEP_CONTENT=true 时把 '#text' 加入白名单，
  // 设为 false 会把**所有文本节点删光**（实测：gantt 8820B→2774B，<style> 被清空）。
  // 未知标签仍由白名单移除；FORBID_CONTENTS 仅对"不在白名单"的标签生效，
  // <style>/<title>/<foreignObject> 均在白名单内，内容不受影响。
  KEEP_CONTENT: true,
  SAFE_FOR_XML: true,
  SAFE_FOR_TEMPLATES: false,
  WHOLE_DOCUMENT: false,
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  NAMESPACE: 'http://www.w3.org/1999/xhtml',
  // ⚠️ 关键：DOMPurify 3.2 的 HTML_INTEGRATION_POINTS 只认 annotation-xml，
  // 不认 foreignObject → 不补这一项，foreignObject 里的 <div>/<span>/<p>
  // 会被 _checkValidNamespace 判为"命名空间非法"整棵删掉（实测已复现）。
  HTML_INTEGRATION_POINTS: { 'annotation-xml': true, foreignobject: true },
  MATHML_TEXT_INTEGRATION_POINTS: { mi: true, mo: true, mn: true, ms: true, mtext: true },
};

svgPurify.setConfig(SVG_CONFIG);

// 钩子 1：style 属性 CSS 收敛 + 任意属性的危险值兜底清理
svgPurify.addHook('afterSanitizeAttributes', (node: Element): void => {
  const el = node;
  if (el.nodeType !== 1 || !el.tagName) return;

  if (el.hasAttribute('style')) {
    el.setAttribute('style', sanitizeCssValue(el.getAttribute('style') ?? ''));
  }

  const attrs = el.attributes;
  for (let i = attrs.length - 1; i >= 0; i--) {
    const name = attrs[i].name;
    const value = attrs[i].value || '';
    if (/^on/i.test(name)) { el.removeAttribute(name); continue; }                 // on*
    if (/^\s*(javascript|vbscript|livescript|data)\s*:/i.test(value)) { el.removeAttribute(name); continue; }
    if (/expression\s*\(/i.test(value)) { el.removeAttribute(name); continue; }
  }
});

// 钩子 2：<style> 元素正文收敛（@import / 外联 url()）
svgPurify.addHook('afterSanitizeAttributes', (node: Element): void => {
  const el = node;
  if (el.nodeType !== 1) return;
  if (String(el.tagName).toLowerCase() === 'style') {
    el.textContent = sanitizeCssValue(el.textContent ?? '');
  }
});

/**
 * 清洗 mermaid 渲染产出的 SVG 字符串。
 *
 * 只应在「mermaid 已渲染出 SVG、准备塞回预览 DOM」这一步调用；
 * Markdown 主体 HTML 仍走 `src/lib/sanitize.ts` 的 `sanitizeHtml()`。
 *
 * @param svg mermaid `render()` 返回的原始 SVG 字符串
 * @returns 清洗后的安全 SVG 字符串
 */
export function sanitizeMermaidSvg(svg: string): string {
  if (!svg) return '';
  return svgPurify.sanitize(svg);
}
