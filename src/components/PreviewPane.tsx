import { useEffect, useRef, useLayoutEffect, useMemo, useState, useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import { convertFileSrc, isExtension } from '../lib/platform';
import { sanitizeHtml } from '../lib/sanitize';
import { resolvePreviewFontStack } from '../lib/constants';
import {
  applyPreviewLineNumbers,
  enhancePreviewContent,
  handlePreviewClick,
  scrollPreviewToLine,
} from '../lib/preview-enhance';
import { consumePendingPreviewLine, markPreviewLineHandled } from '../lib/nav-bridge';
import {
  mountMermaidBlocks,
  clearRenderedMermaid,
  setMermaidZoomHandler,
} from '../lib/mermaid-preview';
import type { MermaidZoomPayload } from '../lib/mermaid-preview';
import MermaidZoomOverlay from './MermaidZoomOverlay';
import type { MermaidZoomState } from './MermaidZoomOverlay';

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
 *
 * C3 / C4 / C5（v0.5.0）改造：
 * - 渲染后调 `preview-enhance.enhancePreviewContent(el)` 做 DOM 包裹
 *   （代码块加复制按钮、表格套横向滚动容器）；
 * - 交互用一个**捕获阶段**的委托 click 监听承载（复制 / 内部锚点跳转），
 *   因为 children 每次重渲染都会重建，逐块绑定监听器必然丢失。
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
  // R1：mermaid 渲染开关 + 预览字体（进缓存 key，变化要重渲染）
  const mermaidEnabled = useAppStore((s) => s.settings.mermaidEnabled);
  const previewFontFamily = useAppStore((s) => s.settings.previewFontFamily);
  const editorFontFamily = useAppStore((s) => s.settings.fontFamily);
  // R4：预览块级稀疏行号开关。内容无关（只改 DOM 属性），刻意**不进**任何
  // 渲染 effect 的 deps —— 切换走下方独立 layout effect，避免重写 innerHTML。
  const previewLineNumbers = useAppStore((s) => s.settings.previewLineNumbers);

  /** 预览字体栈（mermaid 缓存 key 的一部分） */
  const previewFontStack = useMemo(
    () => resolvePreviewFontStack(previewFontFamily, editorFontFamily),
    [previewFontFamily, editorFontFamily],
  );

  /** C2 放大浮层状态 */
  const [zoom, setZoom] = useState<MermaidZoomState | null>(null);

  /** 打开放大浮层（由 mermaid 容器的点击处理器回调） */
  const openMermaidZoom = useCallback((payload: MermaidZoomPayload) => {
    // svgHtml 已由 UI 层重新作用域到浮层容器，用于内联显示；
    // rawSvgHtml 是未作用域、可独立打开的那份，**下载必须用后者**（否则用户存的
    // .svg 单独打开会因选择器失配而显示成黑块）。line 仅作浮层元信息，此处不需要。
    setZoom({ svgHtml: payload.svgHtml, rawSvgHtml: payload.rawSvgHtml });
  }, []);

  /** 关闭浮层 */
  const closeMermaidZoom = useCallback(() => setZoom(null), []);

  /** Download SVG：纯前端 Blob，不依赖后端 */
  const downloadMermaidSvg = useCallback((svgHtml: string) => {
    try {
      const blob = new Blob([svgHtml], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'diagram.svg';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // 延迟释放（部分浏览器下载是异步起手的）
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      console.error('[MDnote] Download SVG failed:', error);
    }
  }, []);

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

  // C3 复制按钮 + C5 内部锚点跳转：单个**捕获阶段**委托监听。
  //
  // 用捕获而非冒泡：命中复制按钮 / 内部锚点时 handler 内部会 stopPropagation，
  // 事件既到不了目标元素本身、也到不了祖先，从而与后续批次 B 的
  // R2「点击预览任意元素 → 跳编辑器」天然隔离（互不干扰、无需互相感知）。
  // 容器恒定存在（Bug 6 结构），监听一次即可，不会被 innerHTML 重建冲掉。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (event: MouseEvent) => {
      handlePreviewClick(event, el);
    };
    el.addEventListener('click', handler, true);
    return () => el.removeEventListener('click', handler, true);
  }, []);

  // 把放大回调注册给 mermaid UI 层（模块级单例，随组件挂载刷新）
  useEffect(() => {
    setMermaidZoomHandler(openMermaidZoom);
    return () => setMermaidZoomHandler(null);
  }, [openMermaidZoom]);

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
        // ⚠️ 刻意保持 `center`，不要改成 nearest。
        // 点目录是**显式**跳转（用户明确要"去看这个标题"），居中比最小滚动更
        // 符合预期；R3 的 nearest（最小滚动、减少跳动）只适用于编辑→预览的
        // **跟随式**同步，两者语义不同。批次 B2 已裁定保留（team-lead 2026-09-19）。
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      // 回退：按文本内容匹配
      if (detail.text) {
        const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6');
        for (const h of headings) {
          if (h.textContent?.trim() === detail.text.trim()) {
            // 同上：刻意保持 center
            (h as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
          }
        }
      }
    };

    window.addEventListener('preview:scroll-to-heading', handler);
    return () => window.removeEventListener('preview:scroll-to-heading', handler);
  }, []);

  // 编辑→预览同步滚动监听（R3 消费侧）
  //
  // 定位交给 `scrollPreviewToLine`：按根标记 `data-line-anchor` 分档
  // （B 档行级 span 精确命中 / A 档块内插值），滚动策略是 nearest，
  // 目标已在视口内就不滚，避免每次点编辑区预览都重新居中。
  useEffect(() => {
    const handler = (e: Event) => {
      const el = containerRef.current;
      if (!el) return;

      const line = (e as CustomEvent<{ line: number }>).detail?.line;
      if (typeof line !== 'number') return;

      // 已挂载即已消费 → 清掉 pending，避免切回分屏时重复滚一次
      markPreviewLineHandled();
      scrollPreviewToLine(el, scrollerRef.current, line, { flash: true });
    };

    window.addEventListener('editor:scroll-preview', handler);
    return () => window.removeEventListener('editor:scroll-preview', handler);
  }, []);

  // 独占模式 pending（R3）：编辑器在「仅编辑」模式下点过的行，
  // 切回分屏 / 仅预览时在这里补一次滚动。
  //
  // 用 useEffect 而非 useLayoutEffect：写 innerHTML 的 layout effect 先跑完，
  // 这里拿到的 DOM 已经是新内容，锚点可读。
  useEffect(() => {
    const line = consumePendingPreviewLine();
    if (line === null) return;
    const el = containerRef.current;
    if (!el) return;
    scrollPreviewToLine(el, scrollerRef.current, line, { flash: false });
  }, []);

  // 预览模式查找结果跳转（FindReplace）
  useEffect(() => {
    const handler = (e: Event) => {
      const el = containerRef.current;
      if (!el) return;

      const line = (e as CustomEvent<{ line: number }>).detail?.line;
      if (typeof line !== 'number') return;

      scrollPreviewToLine(el, scrollerRef.current, line, { flash: false });
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

    // C3/C4 渲染后增强：表格套横向滚动容器、代码块套复制按钮包裹层。
    // 必须在这里做 —— `.preview-content` 的 children 由 innerHTML 独占，
    // 每帧重建，逐块绑定事件监听器必然丢失，故只做 DOM 包裹，
    // 交互统一走下方挂在容器上的委托监听。
    //
    // R4：把行号开关透进来 —— 「内容变化」这条路径在这里首次落号（先于 mermaid 挂载）。
    enhancePreviewContent(el, { lineNumbers: previewLineNumbers });

    if (scroller) {
      // 换文档 → 回到顶部（否则新文档会停在上一个文档的滚动位置）；
      // 同一文档的增量更新 → 原地保住滚动位置，绘制前完成，无跳动。
      scroller.scrollTop = fileChanged ? 0 : prevScrollTop;
    }
    lastFilePathRef.current = filePath;
  }, [processedHtml, filePath]);

  // R1：mermaid 挂载（图 / 源码双态容器）
  //
  // 依赖里带上 theme / previewFontStack / mermaidEnabled：这三者变化时
  // `processedHtml` 可能没变（innerHTML 不会被重写），必须**显式**重挂载，
  // 否则图会停留在旧主题上（缓存 key 含主题，重渲染会 miss 一次后重新缓存）。
  //
  // `mountMermaidBlocks` 内部会先 `unwrapMermaidHosts` 还原，因此重复调用
  // 不会嵌套；markdown 源码用 `getState()` 读而非订阅，避免每次按键都重渲染。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // 换文档：清掉上一份文档的已渲染图登记表（否则导出会把旧图内联进去）
    clearRenderedMermaid();

    const { content } = useAppStore.getState();
    mountMermaidBlocks(el, {
      markdown: content,
      theme,
      fontFamily: previewFontStack,
      enabled: mermaidEnabled,
      onZoom: openMermaidZoom,
    });

    // R4：mermaid 容器是 **mount 时才新建**的宿主（围栏 `<pre>` 被搬进容器、锚点随之
    // 搬到容器上）。行号必须在**挂载之后**再落一次：
    //  · 容器本体（`<div class="preview-mermaid">`）取而代之成为该块的锚点 → 需要拿号；
    //  · 被搬进容器的源码 `<pre>` 已丢失 `data-source-line` → 会连带清掉 mount 前写下的旧号。
    // 幂等、且只写属性不碰 innerHTML，不影响已渲染的图。
    // 用 `getState()` 读设置而非加进 deps：切开关由上面那条 `[previewLineNumbers]` 专效处理，
    // 这里只是补一次「挂载后」的落号，避免把 previewLineNumbers 塞进本 effect 的依赖。
    applyPreviewLineNumbers(el, useAppStore.getState().settings.previewLineNumbers);
  }, [processedHtml, filePath, theme, previewFontStack, mermaidEnabled, openMermaidZoom]);

  // R4：行号开关的**实时切换** —— 独立的轻量 layout effect。
  //
  // 刻意与上面两条 effect 解耦：这里**绝不写 innerHTML**、不调 `enhancePreviewContent`、
  // 不调 `clearRenderedMermaid`，只重写 `data-line-no` 属性（`applyPreviewLineNumbers`
  // 幂等，重复调用安全）。原因（team-lead 2026-09-19 裁定，取代原「进 deps + 改早退守卫」方案）：
  // 若把 `previewLineNumbers` 塞进内容 effect 的 deps，就必须放开内容 effect 的
  // `if (!fileChanged && lastHtmlRef.current === processedHtml) return;` 早退守卫；
  // 那会执行 `el.innerHTML = processedHtml` 重建整棵子树 —— 而 mermaid effect 的 deps 里
  // `processedHtml` 没变 → **不会重挂** → 用户切开关的瞬间已渲染的图被永久冲掉。
  // 本 effect 不碰 innerHTML，图 / 表格包裹层原样保留，开关即时生效。
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    applyPreviewLineNumbers(el, previewLineNumbers);
  }, [previewLineNumbers]);

  // 首次加载（还没有任何已渲染内容）才显示 Rendering 覆盖层。
  // 打字时的增量更新不再置 isPreviewLoading，因此不会闪。
  const showLoadingOverlay = isPreviewLoading && !htmlPreview;
  const showEmptyOverlay = !isPreviewLoading && !htmlPreview;

  return (
    <div
      ref={scrollerRef}
      className={`preview-pane ${theme}${previewLineNumbers ? ' show-line-numbers' : ''}`}
    >
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

      {/* C2：mermaid 放大浮层（图本体点击触发） */}
      <MermaidZoomOverlay
        state={zoom}
        onClose={closeMermaidZoom}
        onDownload={downloadMermaidSvg}
      />
    </div>
  );
}
