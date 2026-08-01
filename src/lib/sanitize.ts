/**
 * DOMPurify 封装（N06）— HTML XSS 过滤模块
 *
 * 在 markdown-it 渲染输出 HTML 之后、PreviewPane 注入 DOM 之前，
 * 通过 DOMPurify 过滤不安全内容，防止 XSS 攻击。
 *
 * 策略（基于 S0-2 结论）：
 * - 常规文档（< 2MB）：主线程同步执行，延迟 < 100ms 无感知
 * - 超大文档（≥ 2MB）：触发阈值警告，可后续扩展为 Worker 异步执行
 *
 * 白名单：允许 Markdown 常用标签，禁用 script/iframe/object/embed 等
 * 危险标签，移除所有 on* 事件属性。
 *
 * @module sanitize
 */

import DOMPurify from 'dompurify';

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────

/**
 * 触发 Worker 降级的大小阈值（2MB）。
 * 超过此大小的 HTML 输入，sanitize 延迟可能 > 200ms，
 * 后续可扩展为 Worker 异步执行。
 */
export const SANITIZE_WORKER_THRESHOLD = 2 * 1024 * 1024;

/**
 * DOMPurify 允许的标签白名单。
 * 覆盖 markdown-it 渲染输出的所有常见 HTML 标签。
 */
const ALLOWED_TAGS: string[] = [
  // 文本结构
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'span', 'div', 'br', 'hr',
  // 文本格式
  'em', 'strong', 'del', 's', 'strike', 'sub', 'sup',
  'mark', 'ins', 'u', 'small', 'b', 'i',
  // 列表
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // 代码
  'code', 'pre', 'kbd', 'samp', 'var',
  // 引用
  'blockquote', 'q', 'cite',
  // 链接与图片
  'a', 'img',
  // 表格
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'caption', 'colgroup', 'col',
  // 其他
  'abbr', 'address', 'bdi', 'bdo', 'dfn', 'figure', 'figcaption',
  'details', 'summary', 'ruby', 'rt', 'rp',
];

/**
 * DOMPurify 允许的属性白名单。
 */
const ALLOWED_ATTR: string[] = [
  // 通用
  'class', 'id', 'title', 'lang', 'dir',
  // 链接
  'href', 'target', 'rel', 'download',
  // 图片
  'src', 'alt', 'width', 'height', 'srcset', 'sizes', 'loading',
  // 表格
  'colspan', 'rowspan', 'scope', 'headers', 'abbr',
  // 代码
  'data-language', 'data-line',
  // 锚点
  'name',
  // 其他
  'datetime', 'cite', 'start', 'type', 'value', 'reversed',
  'open', 'aria-label', 'aria-hidden', 'role',
];

/**
 * 危险标签列表（显式禁止，即使不在白名单也会被 DOMPurify 移除）。
 */
const FORBIDDEN_TAGS: string[] = [
  'script', 'iframe', 'object', 'embed', 'form',
  'input', 'button', 'textarea', 'select', 'option',
  'applet', 'frame', 'frameset', 'base', 'meta', 'link', 'style',
];

/**
 * 危险属性前缀（on* 事件属性、javascript: 协议等）。
 * DOMPurify 默认会移除这些，此处显式声明用于 containsDangerousContent 检测。
 */
export const FORBIDDEN_ATTR_PATTERNS: RegExp[] = [
  /^on/i,           // 所有 on* 事件属性
  /^formaction$/i,  // formaction 可注入 javascript:
];

// ──────────────────────────────────────────────
// DOMPurify 配置
// ──────────────────────────────────────────────

/**
 * 初始化 DOMPurify 配置。
 * 在模块加载时执行一次，后续调用复用配置。
 */
let purifyConfigured = false;

/**
 * 配置 DOMPurify 实例。
 * 设置白名单标签/属性，禁用危险标签，移除 on* 事件属性。
 */
function configurePurify(): void {
  if (purifyConfigured) return;

  DOMPurify.setConfig({
    // 允许的标签（白名单模式）
    ALLOWED_TAGS,
    // 允许的属性
    ALLOWED_ATTR,
    // 允许的 URI 协议
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data:image\/(?:png|jpeg|gif|webp|svg\+xml)|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    // 保留被移除标签的内容（默认 true）。
    // ⚠️ 切勿设为 false：DOMPurify 在移除不在白名单的根标签（<html>/<body>）时，
    // 会一并删除其所有文字内容，导致预览区只剩空标签、文字全部消失。
    // <script>/<style> 等危险标签的内容由 DOMPurify 默认特殊丢弃，不依赖此项。
    KEEP_CONTENT: true,
    // 允许自定义 data-* 属性
    ALLOW_DATA_ATTR: true,
    // 禁止添加 target="_blank" 的安全 rel（我们自己控制）
    ADD_ATTR: ['target'],
    // 强制移除危险标签
    FORBID_TAGS: FORBIDDEN_TAGS,
    // 强制移除危险属性
    FORBID_ATTR: ['style', 'formaction'],
  });

  // 添加钩子：处理 <a> 标签，确保安全 rel 属性
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    // node 类型为 Node，但 afterSanitizeAttributes 钩子中实际传入的是 Element
    const el = node as Element;
    if (el.nodeType !== 1 || !el.tagName) return; // 仅处理元素节点

    // 为所有 <a target="_blank"> 添加 rel="noopener noreferrer"
    if (el.tagName === 'A' && el.getAttribute('target') === '_blank') {
      const existingRel = el.getAttribute('rel') || '';
      const relParts = existingRel.split(/\s+/).filter(Boolean);
      if (!relParts.includes('noopener')) relParts.push('noopener');
      if (!relParts.includes('noreferrer')) relParts.push('noreferrer');
      el.setAttribute('rel', relParts.join(' '));
    }

    // 移除所有 on* 事件属性（双重保险）
    const attrs = el.attributes;
    for (let i = attrs.length - 1; i >= 0; i--) {
      const attrName = attrs[i].name;
      if (/^on/i.test(attrName)) {
        el.removeAttribute(attrName);
      }
    }
  });

  purifyConfigured = true;
}

// 模块加载时配置
configurePurify();

// ──────────────────────────────────────────────
// 核心 API
// ──────────────────────────────────────────────

/**
 * 过滤 HTML，移除不安全内容。
 *
 * 使用 DOMPurify 白名单模式：仅保留 ALLOWED_TAGS 中的标签和 ALLOWED_ATTR
 * 中的属性，移除所有 script/iframe/object/embed 等危险标签及 on* 事件属性。
 *
 * 性能（基于 S0-2 结论）：
 * - 常规文档（< 2MB）：主线程同步执行，延迟 < 100ms
 * - 超大文档（≥ 2MB）：触发阈值警告（console.warn），当前仍同步执行
 *
 * @param dirty 待过滤的 HTML 字符串（通常是 markdown-it 渲染输出）
 * @returns 过滤后的安全 HTML 字符串
 *
 * @example
 * ```ts
 * import { renderMarkdown } from './markdown-parser';
 * import { sanitizeHtml } from './sanitize';
 *
 * const dirtyHtml = await renderMarkdown(mdContent);
 * const safeHtml = sanitizeHtml(dirtyHtml);
 * element.innerHTML = safeHtml;
 * ```
 */
export function sanitizeHtml(dirty: string): string {
  if (!dirty || dirty.length === 0) {
    return '';
  }

  // 大文档阈值警告（S0-2 结论：> 2MB 可能超 200ms）
  if (dirty.length > SANITIZE_WORKER_THRESHOLD) {
    console.warn(
      `[sanitize] Input size ${dirty.length} bytes exceeds threshold ${SANITIZE_WORKER_THRESHOLD}. ` +
      `Sanitization may take > 200ms on main thread. Consider Worker-based sanitization for large documents.`,
    );
  }

  // 确保配置已初始化（幂等）
  configurePurify();

  // 执行过滤（默认返回 string，配置已通过 setConfig 设置）
  const clean: string = DOMPurify.sanitize(dirty) as unknown as string;

  return clean;
}

/**
 * 检查 HTML 是否包含危险内容（不修改，仅检测）。
 * 用于调试和测试。
 * @param html 待检测的 HTML 字符串
 * @returns 是否包含危险内容
 */
export function containsDangerousContent(html: string): boolean {
  if (!html) return false;

  // 检测危险标签
  for (const tag of FORBIDDEN_TAGS) {
    const regex = new RegExp(`<${tag}[\\s>]`, 'i');
    if (regex.test(html)) return true;
  }

  // 检测 on* 事件属性（使用 FORBIDDEN_ATTR_PATTERNS）
  for (const pattern of FORBIDDEN_ATTR_PATTERNS) {
    // 移除 ^ 锚点：pattern.source 为 "^on"，在 \s 后作为字面量 ^ 永远无法匹配
    const fixedSource = pattern.source.replace(/^\^/, '');
    const attrRegex = new RegExp(`\\s${fixedSource}\\w*\\s*=`, 'i');
    if (attrRegex.test(html)) return true;
  }

  // 检测 javascript: 协议
  if (/javascript:/i.test(html)) return true;

  return false;
}

/**
 * 获取当前 DOMPurify 配置摘要（用于调试）。
 * @returns 配置信息对象
 */
export function getSanitizeConfig(): {
  allowedTags: string[];
  allowedAttr: string[];
  forbiddenTags: string[];
  threshold: number;
} {
  return {
    allowedTags: [...ALLOWED_TAGS],
    allowedAttr: [...ALLOWED_ATTR],
    forbiddenTags: [...FORBIDDEN_TAGS],
    threshold: SANITIZE_WORKER_THRESHOLD,
  };
}

/**
 * 重置 DOMPurify 配置（主要用于测试隔离）。
 * 允许测试用例重新配置 DOMPurify。
 */
export function resetSanitizeConfig(): void {
  purifyConfigured = false;
  DOMPurify.clearConfig();
  configurePurify();
}
