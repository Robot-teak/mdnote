import { useEffect, useRef, useLayoutEffect, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { convertFileSrc, isExtension } from '../lib/platform';
import { sanitizeHtml } from '../lib/sanitize';

/** Map of codeBlockTheme setting → CSS filename in public/hljs-themes/ */
const HLJS_THEME_MAP: Record<string, string> = {
  'github': 'github.min.css',
  'github-dark': 'github-dark.min.css',
  'monokai': 'monokai.min.css',
  'atom-one-dark': 'atom-one-dark.min.css',
  'vs': 'vs.min.css',
  'vs2015': 'vs2015.min.css',
};

/** Get recommended theme based on light/dark mode */
function getDefaultThemeForMode(theme: string): string {
  return theme === 'dark' ? 'github-dark' : 'github';
}

/**
 * Post-process HTML to convert local image paths to loadable URLs.
 *
 * 双产物线：
 * - 桌面版：使用 platform.convertFileSrc（Tauri asset:// 协议）
 * - 插件版：远程图片保留原 URL；本地图片 convertFileSrc 返回空，显示占位提示
 *   （有目录句柄时可通过 readImageAsBlob 转 Blob URL，需 M06 EditorPane 配合）
 *
 * @param html 渲染后的 HTML
 * @param filePath 当前文件路径
 * @returns 处理后的 HTML
 */
function processImageUrls(html: string, filePath: string | null): string {
  // Only process if there are img tags with local paths
  if (!html.includes('<img ')) return html;

  return html.replace(/(<img\s[^>]*src=["'])([^"']+)(["'][^>]*>)/g, (
    _match: string,
    prefix: string,
    src: string,
    suffix: string,
  ) => {
    // Skip URLs that are already web URLs, data URLs, or asset protocol URLs
    if (src.startsWith('http://') || src.startsWith('https://') ||
        src.startsWith('data:') || src.startsWith('asset://') ||
        src.startsWith('blob:') ||
        src.startsWith('https://asset.localhost')) {
      return prefix + src + suffix;
    }

    // Resolve relative paths against the current file's directory
    let absolutePath = src;
    if (!src.startsWith('/') && filePath) {
      const dir = filePath.substring(0, filePath.lastIndexOf('/'));
      // Handle ./ and ../ relative paths
      const parts = dir.split('/');
      const srcParts = src.split('/');
      for (const part of srcParts) {
        if (part === '..') {
          parts.pop();
        } else if (part !== '.') {
          parts.push(part);
        }
      }
      absolutePath = parts.join('/');
    }

    // 使用 platform.convertFileSrc 转换
    const assetUrl = convertFileSrc(absolutePath);

    if (assetUrl) {
      return prefix + assetUrl + suffix;
    }

    // 插件版本地图片无法直接加载 → 显示占位提示
    if (isExtension) {
      const placeholderText = `[Image: ${src}]`;
      return `<span style="display:inline-block;padding:8px 12px;background:#f0f0f0;border:1px dashed #ccc;border-radius:4px;color:#999;font-size:13px;">${placeholderText}</span>`;
    }

    // 桌面版 fallback：asset 协议
    return prefix + `https://asset.localhost/${absolutePath.replace(/^\//, '')}` + suffix;
  });
}

/**
 * Preview pane — renders HTML output from the Markdown parser.
 *
 * M04 改造：
 * - 移除直接 convertFileSrc 调用，改用 platform.convertFileSrc
 * - 渲染前调 sanitize.sanitizeHtml 过滤（P0 XSS 加固）
 * - 同步滚动逻辑（data-source-line）保持不变
 *
 * v0.2.1（Bug 6 防闪烁）改造 —— 结构从「早返回换整棵子树」改为「恒定容器 + 覆盖层」：
 * - 滚动容器 `.preview-pane` 与内容容器 `.preview-content` 分离，两者**永不卸载**；
 *   loading / empty 变成绝对定位覆盖层，不再替换 DOM。
 * - HTML 用 `useLayoutEffect` 手动写 innerHTML，前后原子保存/恢复 scrollTop，
 *   浏览器绘制前完成，用户看不到中间态。
 * - 内容未变化时直接跳过写入；切换文档时滚动回顶部。
 * - store 改用逐项 selector 订阅（原为无 selector 全量订阅，任意 store 变更都重渲染）。
 *
 * 注意：`.preview-content` 的 children 完全由 innerHTML 接管，
 * 不能在其中再放任何 JSX 子元素，否则 React 与手动 DOM 写入会互相踩踏。
 */
export default function PreviewPane() {
  // 逐项 selector 订阅：避免无关 store 变更触发重渲染
  const htmlPreview = useAppStore((s) => s.htmlPreview);
  const isPreviewLoading = useAppStore((s) => s.isPreviewLoading);
  const theme = useAppStore((s) => s.theme);
  const filePath = useAppStore((s) => s.filePath);
  const codeBlockTheme = useAppStore((s) => s.settings.codeBlockTheme);
  const autoThemeFollow = useAppStore((s) => s.settings.autoThemeFollow);
  const codeBlockThemeManuallySet = useAppStore((s) => s.settings.codeBlockThemeManuallySet);

  /** 滚动容器（`.preview-pane`），承载 overflow-y:auto */
  const scrollerRef = useRef<HTMLDivElement>(null);
  /** 内容容器（`.preview-content`），children 由 innerHTML 接管 */
  const containerRef = useRef<HTMLDivElement>(null);
  // 保存预览区滚动位置的 ref
  const scrollPosRef = useRef(0);
  // 追踪当前加载的 hljs 主题 link 元素
  const currentThemeLinkRef = useRef<HTMLLinkElement | null>(null);

  // 监听滚动事件，实时保存滚动位置。
  // 容器现在恒定存在，挂载时一定拿得到节点（旧实现在 isPreviewLoading=true
  // 时早返回，containerRef 为 null，监听器永远挂不上）。
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const handleScroll = () => { scrollPosRef.current = el.scrollTop; };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // 动态加载/切换 hljs 主题 CSS
  useEffect(() => {
    let themeName = codeBlockTheme;

    // 如果设置了跟随系统主题且用户没有手动选择
    if (autoThemeFollow && !codeBlockThemeManuallySet) {
      themeName = getDefaultThemeForMode(theme);
    }

    const cssFile = HLJS_THEME_MAP[themeName] || HLJS_THEME_MAP['github'];

    // 移除旧的 link 元素
    if (currentThemeLinkRef.current) {
      currentThemeLinkRef.current.remove();
    }

    // 创建新的 link 元素
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    // 插件版用相对路径（base: './'），桌面版用绝对路径
    link.href = isExtension ? `./hljs-themes/${cssFile}` : `/hljs-themes/${cssFile}`;
    document.head.appendChild(link);
    currentThemeLinkRef.current = link;

    return () => {
      if (currentThemeLinkRef.current === link) {
        link.remove();
        currentThemeLinkRef.current = null;
      }
    };
  }, [codeBlockTheme, theme, autoThemeFollow, codeBlockThemeManuallySet]);

  // TOC 跳转监听：直接用 containerRef
  useEffect(() => {
    const handler = (e: Event) => {
      const el = containerRef.current;
      if (!el) return;

      const detail = (e as CustomEvent<{ line: number; text?: string }>).detail;
      const line = detail?.line;
      if (typeof line !== 'number') return;

      // 优先按 data-source-line 匹配
      const target = el.querySelector(`[data-source-line="${line}"]`) as HTMLElement | null;
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      // 回退：按文本内容匹配
      if (detail.text) {
        const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6');
        for (const h of headings) {
          if (h.textContent?.trim() === detail.text.trim()) {
            (h as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
          }
        }
      }
    };

    window.addEventListener('preview:scroll-to-heading', handler);
    return () => window.removeEventListener('preview:scroll-to-heading', handler);
  }, []);

  // 编辑→预览同步滚动监听
  useEffect(() => {
    const handler = (e: Event) => {
      const el = containerRef.current;
      if (!el) return;

      const line = (e as CustomEvent<{ line: number }>).detail?.line;
      if (typeof line !== 'number') return;

      const allElements = el.querySelectorAll('[data-source-line]');
      let target: HTMLElement | null = null;
      let bestLine = -1;
      for (const elem of allElements) {
        const elemLine = parseInt((elem as HTMLElement).dataset.sourceLine || '-1', 10);
        if (elemLine <= line && elemLine > bestLine) {
          bestLine = elemLine;
          target = elem as HTMLElement;
        }
      }
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('sync-highlight');
        setTimeout(() => target?.classList.remove('sync-highlight'), 300);
      }
    };

    window.addEventListener('editor:scroll-preview', handler);
    return () => window.removeEventListener('editor:scroll-preview', handler);
  }, []);

  // 预览模式查找结果跳转
  useEffect(() => {
    const handler = (e: Event) => {
      const el = containerRef.current;
      if (!el) return;

      const line = (e as CustomEvent<{ line: number }>).detail?.line;
      if (typeof line !== 'number') return;

      const allElements = el.querySelectorAll('[data-source-line]');
      let target: HTMLElement | null = null;
      let bestLine = -1;
      for (const elem of allElements) {
        const elemLine = parseInt((elem as HTMLElement).dataset.sourceLine || '-1', 10);
        if (elemLine <= line && elemLine > bestLine) {
          bestLine = elemLine;
          target = elem as HTMLElement;
        }
      }
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };

    window.addEventListener('preview:scroll-to-line', handler);
    return () => window.removeEventListener('preview:scroll-to-line', handler);
  }, []);

  // M04: Post-process HTML — 图片 URL 转换 + XSS 过滤（sanitize）
  const processedHtml = useMemo(() => {
    if (!htmlPreview) return '';

    // 1. 图片 URL 处理（桌面版 convertFileSrc / 插件版占位提示）
    const withImages = processImageUrls(htmlPreview, filePath);

    // 2. XSS 过滤（P0 安全加固 — DOMPurify 白名单模式）
    const sanitized = sanitizeHtml(withImages);

    return sanitized;
  }, [htmlPreview, filePath]);

  /**
   * 手动写入 innerHTML（替代 dangerouslySetInnerHTML）。
   *
   * 用 useLayoutEffect 而非 useEffect：DOM 写入与滚动恢复都在浏览器绘制前完成，
   * 用户看不到任何中间态。
   *
   * 用 `lastHtmlRef` 而不是读 `el.innerHTML` 来判重：innerHTML 的 getter 会把整棵
   * DOM 重新序列化（大文档上很贵），且浏览器会规范化属性/自闭合标签，
   * 序列化结果常常与写入的字符串不相等，判重会失效导致每次都重写。
   */
  const lastHtmlRef = useRef<string | null>(null);
  const lastFilePathRef = useRef<string | null>(filePath);

  useLayoutEffect(() => {
    const el = containerRef.current;
    const scroller = scrollerRef.current;
    if (!el) return;

    const fileChanged = lastFilePathRef.current !== filePath;
    // 同一文档且内容没变 → 完全不碰 DOM
    if (!fileChanged && lastHtmlRef.current === processedHtml) return;

    const prevScrollTop = scroller ? scroller.scrollTop : 0;
    el.innerHTML = processedHtml;
    lastHtmlRef.current = processedHtml;

    if (scroller) {
      // 换文档 → 回到顶部（否则新文档会停在上一个文档的滚动位置）；
      // 同一文档的增量更新 → 原地保住滚动位置，绘制前完成，无跳动。
      scroller.scrollTop = fileChanged ? 0 : prevScrollTop;
    }
    lastFilePathRef.current = filePath;
  }, [processedHtml, filePath]);

  // 首次加载（还没有任何已渲染内容）才显示 Rendering 覆盖层。
  // 打字时的增量更新不再置 isPreviewLoading，因此不会闪。
  const showLoadingOverlay = isPreviewLoading && !htmlPreview;
  const showEmptyOverlay = !isPreviewLoading && !htmlPreview;

  return (
    <div ref={scrollerRef} className={`preview-pane ${theme}`}>
      {/* 内容容器：children 由 useLayoutEffect 的 innerHTML 独占，勿放 JSX 子元素 */}
      <div ref={containerRef} className="preview-content" />

      {showLoadingOverlay && (
        <div className="preview-overlay" role="status" aria-live="polite">
          <span className="loading-spinner" />
          Rendering...
        </div>
      )}

      {showEmptyOverlay && (
        <div className="preview-overlay">
          Start typing to see the preview…
        </div>
      )}
    </div>
  );
}
