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
 * Uses dangerouslySetInnerHTML for the rendered Markdown (sanitized via DOMPurify).
 * Supports both light and dark themes via data-theme.
 *
 * M04 改造：
 * - 移除直接 convertFileSrc 调用，改用 platform.convertFileSrc
 * - 渲染前调 sanitize.sanitizeHtml 过滤（P0 XSS 加固）
 * - 同步滚动逻辑（data-source-line）保持不变
 */
export default function PreviewPane() {
  const { htmlPreview, isPreviewLoading, theme, savedScrollTop, settings, filePath } = useAppStore();
  const containerRef = useRef<HTMLDivElement>(null);
  // 保存预览区滚动位置的 ref
  const scrollPosRef = useRef(0);
  // 追踪当前加载的 hljs 主题 link 元素
  const currentThemeLinkRef = useRef<HTMLLinkElement | null>(null);

  // 监听滚动事件，实时保存滚动位置
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleScroll = () => { scrollPosRef.current = el.scrollTop; };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // savedScrollTop > 0 时恢复滚动
  useLayoutEffect(() => {
    if (savedScrollTop > 0) {
      const el = containerRef.current;
      if (el) el.scrollTop = savedScrollTop;
    }
  }, [savedScrollTop]);

  // 动态加载/切换 hljs 主题 CSS
  useEffect(() => {
    let themeName = settings.codeBlockTheme;

    // 如果设置了跟随系统主题且用户没有手动选择
    if (settings.autoThemeFollow && !settings.codeBlockThemeManuallySet) {
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
  }, [settings.codeBlockTheme, theme, settings.autoThemeFollow, settings.codeBlockThemeManuallySet]);

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

  if (isPreviewLoading) {
    return (
      <div className="preview-pane loading">
        <div className="preview-loading-indicator">
          <span className="loading-spinner" />
          Rendering...
        </div>
      </div>
    );
  }

  if (!htmlPreview) {
    return (
      <div className="preview-pane empty">
        <div className="preview-empty-hint">
          Start typing to see the preview…
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`preview-pane ${theme}`} dangerouslySetInnerHTML={{ __html: processedHtml }} />
  );
}
