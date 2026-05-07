import { useEffect, useRef, useLayoutEffect } from 'react';
import { useAppStore } from '../store/useAppStore';

/**
 * Preview pane — renders HTML output from the Markdown parser.
 * Uses dangerouslySetInnerHTML for the rendered Markdown.
 * Supports both light and dark themes via data-theme.
 */
export default function PreviewPane() {
  const { htmlPreview, isPreviewLoading, theme, savedScrollTop } = useAppStore();
  const containerRef = useRef<HTMLDivElement>(null);
  // 保存预览区滚动位置的 ref（用于 handleScroll 时捕获最新位置）
  const scrollPosRef = useRef(0);

  // 监听滚动事件，实时保存滚动位置
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleScroll = () => { scrollPosRef.current = el.scrollTop; };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // 修复问题3：savedScrollTop > 0 时恢复滚动（来自 store，updatePreview 在防抖开始时写入）
  // 注意：savedScrollTop 在 setHtmlPreview 后被 updatePreview 的 requestAnimationFrame 消费，
  // 此处作为兜底——如果 requestAnimationFrame 未执行（异常情况），仍能恢复
  useLayoutEffect(() => {
    if (savedScrollTop > 0) {
      const el = containerRef.current;
      if (el) el.scrollTop = savedScrollTop;
    }
  }, [savedScrollTop]);

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

  // F1: 编辑→预览同步滚动监听
  useEffect(() => {
    const handler = (e: Event) => {
      const el = containerRef.current;
      if (!el) return;

      const line = (e as CustomEvent<{ line: number }>).detail?.line;
      if (typeof line !== 'number') return;

      // 查找最近的 data-source-line ≤ line 的元素（精确匹配）
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
        // 300ms 高亮效果
        target.classList.add('sync-highlight');
        setTimeout(() => target?.classList.remove('sync-highlight'), 300);
      }
    };

    window.addEventListener('editor:scroll-preview', handler);
    return () => window.removeEventListener('editor:scroll-preview', handler);
  }, []);

  // Bug 3: 预览模式查找结果跳转（不带高亮效果）
  useEffect(() => {
    const handler = (e: Event) => {
      const el = containerRef.current;
      if (!el) return;

      const line = (e as CustomEvent<{ line: number }>).detail?.line;
      if (typeof line !== 'number') return;

      // 查找最近的 data-source-line ≤ line 的元素
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
