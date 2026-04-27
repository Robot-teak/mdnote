import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';

/**
 * Preview pane — renders HTML output from the Markdown parser.
 * Uses dangerouslySetInnerHTML for the rendered Markdown.
 * Supports both light and dark themes via data-theme.
 */
export default function PreviewPane() {
  const { htmlPreview, isPreviewLoading, theme } = useAppStore();
  const containerRef = useRef<HTMLDivElement>(null);

  // TOC 跳转监听：直接用 containerRef，每次事件时实时查找 DOM
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
    <div ref={containerRef} className={`preview-pane ${theme}`} dangerouslySetInnerHTML={{ __html: htmlPreview }} />
  );
}
