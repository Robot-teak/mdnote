/**
 * mermaid-preview.ts 单元测试（R1 UI 层）
 *
 * 覆盖四块：
 * - `isMermaidInfo`：与引擎层闸门一致的判等（大小写不敏感）
 * - `scopeMermaidCss` / `scopeSvgStyles`：CSS scoping，含 **@keyframes 体内不加前缀**
 *   这个判别点（正则替换会把 `0%` 变成 `.scope 0%` 这种非法规则）
 * - 容器构建 / 还原：锚点**搬而不复制**、幂等、锚点值取 `fenceStartLine`
 * - 点击归属（U1）：分段控件 / 控制条 / 图本体 → 消费；容器留白 → 放行给 R2
 * - 导出内联：显示为图 → 内联 SVG；显示为源码块 → 保持源码块
 *
 * ⚠️ 本文件**不**真的渲染 mermaid（不 import 引擎的 mermaid chunk）：
 * 渲染相关用 `vi.mock` 顶掉 `renderMermaidSvg`。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── 引擎层打桩（在 import 被测模块之前） ───
const renderMermaidSvgMock = vi.fn();
const extractMermaidBlocksMock = vi.fn();
const hasMermaidBlockMock = vi.fn();

vi.mock('../mermaid-renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mermaid-renderer')>();
  return {
    ...actual,
    hasMermaidBlock: (md: string) => hasMermaidBlockMock(md),
    extractMermaidBlocks: (md: string) => extractMermaidBlocksMock(md),
    renderMermaidSvg: (
      code: string,
      options: { theme: string; fontFamily?: string },
    ) => renderMermaidSvgMock(code, options),
  };
});

import {
  MERMAID_HOST_CLASS,
  MERMAID_SEG_CLASS,
  MERMAID_SEG_BTN_CLASS,
  MERMAID_COPY_BTN_CLASS,
  MERMAID_FIGURE_CLASS,
  MERMAID_ERROR_CLASS,
  MERMAID_ZOOM_BODY_CLASS,
  isMermaidInfo,
  scopeMermaidCss,
  scopeSvgStyles,
  mountMermaidBlocks,
  unwrapMermaidHosts,
  clearRenderedMermaid,
  inlineMermaidIntoHtml,
  setMermaidZoomHandler,
} from '../mermaid-preview';
import type { MermaidZoomPayload } from '../mermaid-preview';
import { BLOCK_ACTIONS_CLASS, BLOCK_BAR_CLASS, BLOCK_KIND_CLASS } from '../block-chrome';
import { enhancePreviewContent, handlePreviewClick } from '../preview-enhance';

// ──────────────────────────────────────────────
// 辅助
// ─────────────────────────────────────────────-

/** 一段带 mermaid 围栏的 Markdown（行号见下方注释） */
const MD = [
  '# Title',        // 0
  '',               // 1
  '```mermaid',     // 2  ← fenceStartLine = 2
  'flowchart LR',   // 3  ← startLine（图源码首行，差 1）
  '  A --> B',      // 4
  '```',            // 5  ← endLine；fenceEndLine = 6
  '',               // 6
  'tail',           // 7
].join('\n');

/** 造一个预览容器：一个 mermaid `<pre>`（带锚点）+ 一个普通段落 */
function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  root.className = 'preview-content';
  root.innerHTML =
    '<div data-line-anchor="row">'
    + '<pre data-source-line="2" data-source-line-end="6"><code>flowchart LR\n  A --&gt; B</code></pre>'
    + '<p data-source-line="7">tail</p>'
    + '</div>';
  document.body.appendChild(root);
  return root;
}

/** 让引擎层桩返回「有一个 mermaid 块」 */
function stubEngine(kind: 'ok' | 'fail' = 'ok', message = 'boom'): void {
  hasMermaidBlockMock.mockReturnValue(true);
  extractMermaidBlocksMock.mockReturnValue([
    { code: 'flowchart LR\n  A --> B', startLine: 3, endLine: 5, fenceStartLine: 2, fenceEndLine: 6, info: 'mermaid' },
  ]);
  if (kind === 'ok') {
    renderMermaidSvgMock.mockResolvedValue('<svg><style>.node rect{fill:#fff}</style></svg>');
  } else {
    renderMermaidSvgMock.mockRejectedValue(new Error(message));
  }
}

/** 派发一个真实 click（不派发则 event.target 为 null，负向断言会假通过） */
function dispatchClick(el: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

const noopZoom = () => {};

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  clearRenderedMermaid();
  hasMermaidBlockMock.mockReturnValue(false);
  extractMermaidBlocksMock.mockReturnValue([]);
  // jsdom 不实现 scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────
// 判等
// ──────────────────────────────────────────────

describe('R1 isMermaidInfo', () => {
  it('accepts lower / upper / mixed case', () => {
    expect(isMermaidInfo('mermaid')).toBe(true);
    expect(isMermaidInfo('Mermaid')).toBe(true);
    expect(isMermaidInfo('MERMAID')).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(isMermaidInfo('  mermaid ')).toBe(true);
  });

  it('rejects other languages and empty info', () => {
    expect(isMermaidInfo('js')).toBe(false);
    expect(isMermaidInfo('')).toBe(false);
  });

  it('matches the engine gate — a trailing attribute is NOT mermaid', () => {
    // 与 hasMermaidBlock 的 `info.trim().toLowerCase() === 'mermaid'` 保持一致：
    // 若这里放宽成「取首 token」，闸门返回 false 而 UI 认定是图，图永远出不来
    expect(isMermaidInfo('mermaid extra')).toBe(false);
  });
});

// ──────────────────────────────────────────────
// CSS scoping
// ──────────────────────────────────────────────

describe('R1 scopeMermaidCss', () => {
  const scope = '.preview-mermaid[data-mermaid-scope="mm-1"]';

  it('prefixes plain selectors', () => {
    expect(scopeMermaidCss('.node rect{fill:#fff}', scope))
      .toBe(`${scope} .node rect{fill:#fff}`);
  });

  it('prefixes every comma-separated selector', () => {
    expect(scopeMermaidCss('.a, .b{color:red}', scope))
      .toBe(`${scope} .a, ${scope} .b{color:red}`);
  });

  it('leaves at-rule preludes untouched but scopes their inner rules', () => {
    const out = scopeMermaidCss('@media (max-width:100px){ .a{color:red} }', scope);
    expect(out).toContain('@media (max-width:100px){');
    expect(out).toContain(`${scope} .a{color:red}`);
  });

  it('does NOT prefix inside @keyframes (0% / from / to are not selectors)', () => {
    // ⚠️ 判别点：正则替换会把 `0%` 变成 `.scope 0% {}` 这类非法规则
    const css = '@keyframes dash{ from{stroke-dashoffset:10} to{stroke-dashoffset:0} }';
    const out = scopeMermaidCss(css, scope);
    expect(out).toContain('from{stroke-dashoffset:10}');
    expect(out).toContain('to{stroke-dashoffset:0}');
    expect(out).not.toContain(`${scope} from`);
    expect(out).not.toContain(`${scope} to`);
  });

  it('does NOT prefix percentage keyframe stops', () => {
    const out = scopeMermaidCss('@keyframes k{ 0%{opacity:0} 100%{opacity:1} }', scope);
    expect(out).toContain('0%{opacity:0}');
    expect(out).toContain('100%{opacity:1}');
    expect(out).not.toContain(`${scope} 0%`);
  });

  it('scopes rules that follow a @keyframes block again', () => {
    const css = '@keyframes k{ 0%{opacity:0} }.after{color:blue}';
    const out = scopeMermaidCss(css, scope);
    expect(out).toContain(`${scope} .after{color:blue}`);
    expect(out).toContain('0%{opacity:0}');
  });

  it('keeps @font-face / @supports preludes intact', () => {
    expect(scopeMermaidCss('@font-face{font-family:x}', scope))
      .toBe('@font-face{font-family:x}');
  });

  it('returns empty / selector-less input unchanged', () => {
    expect(scopeMermaidCss('', scope)).toBe('');
  });
});

describe('R1 scopeSvgStyles', () => {
  it('rewrites the <style> inside an SVG and keeps the svg node', () => {
    const svg = '<svg><style>.edgePath path{stroke:#333}</style><g/></svg>';
    const out = scopeSvgStyles(svg, '.preview-mermaid[data-mermaid-scope="mm-2"]');
    expect(out).toContain('.preview-mermaid[data-mermaid-scope="mm-2"] .edgePath path');
    expect(out.startsWith('<svg')).toBe(true);
  });

  it('returns the input untouched when there is no <style>', () => {
    const svg = '<svg><g/></svg>';
    expect(scopeSvgStyles(svg, '.x')).toBe(svg);
  });
});

// ──────────────────────────────────────────────
// 容器构建 / 还原
// ──────────────────────────────────────────────

describe('R1 mountMermaidBlocks', () => {
  it('does nothing (and never loads mermaid) when the doc has no mermaid block', () => {
    const root = makeRoot();
    hasMermaidBlockMock.mockReturnValue(false);

    const count = mountMermaidBlocks(root, {
      markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom,
    });

    expect(count).toBe(0);
    expect(root.querySelectorAll(`.${MERMAID_HOST_CLASS}`)).toHaveLength(0);
    expect(renderMermaidSvgMock).not.toHaveBeenCalled();
  });

  it('does nothing when the setting is off — stays a plain source block', () => {
    const root = makeRoot();
    stubEngine();

    const count = mountMermaidBlocks(root, {
      markdown: MD, theme: 'light', enabled: false, onZoom: noopZoom,
    });

    expect(count).toBe(0);
    expect(root.querySelector('pre[data-source-line="2"]')).not.toBeNull();
    expect(renderMermaidSvgMock).not.toHaveBeenCalled();
  });

  it('moves the anchor onto the host — fenceStartLine, not startLine', async () => {
    const root = makeRoot();
    stubEngine();

    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });

    const host = root.querySelector(`.${MERMAID_HOST_CLASS}`) as HTMLElement;
    expect(host).not.toBeNull();
    // ✅ 锚点取 fenceStartLine=2；误用 startLine 会写成 3（整体偏移 1 行）
    expect(host.getAttribute('data-source-line')).toBe('2');
    expect(host.getAttribute('data-source-line-end')).toBe('6');
    // 搬而不复制：同一个块不能留下第二个同值锚点
    expect(root.querySelectorAll('[data-source-line="2"]')).toHaveLength(1);

    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_FIGURE_CLASS} svg`)).not.toBeNull();
    });
    expect(host.dataset.mermaidState).toBe('diagram');
  });

  it('is idempotent — mounting twice does not nest hosts', () => {
    const root = makeRoot();
    stubEngine();

    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });
    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });

    expect(root.querySelectorAll(`.${MERMAID_HOST_CLASS}`)).toHaveLength(1);
    expect(root.querySelectorAll(`.${MERMAID_HOST_CLASS} .${MERMAID_HOST_CLASS}`)).toHaveLength(0);
  });

  it('renders the SVG with scoped styles (no global leak)', async () => {
    const root = makeRoot();
    stubEngine();

    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });

    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_FIGURE_CLASS} svg`)).not.toBeNull();
    });
    const style = root.querySelector(`.${MERMAID_FIGURE_CLASS} style`);
    expect(style?.textContent ?? '').toContain('data-mermaid-scope');
  });

  it('falls back to the source block + a tip above it when rendering fails', async () => {
    const root = makeRoot();
    stubEngine('fail', 'No diagram type detected');

    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });

    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_ERROR_CLASS}`)).not.toBeNull();
    });
    const host = root.querySelector(`.${MERMAID_HOST_CLASS}`) as HTMLElement;
    expect(host.dataset.mermaidState).toBe('error');
    expect(host.querySelector(`.${MERMAID_ERROR_CLASS}`)?.textContent).toContain('No diagram type detected');
    // 源码块仍在（降级不白屏），且排在最下方（提示在块上方）
    const codeNode = host.querySelector('pre');
    expect(codeNode).not.toBeNull();
    expect(codeNode!.hidden).toBe(false);
  });

  it('drops a stale render that lands after a newer mount (generation guard)', async () => {
    const root = makeRoot();
    stubEngine();

    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });
    // 立刻再挂一轮（等价内容被重写）：第一轮的异步结果必须被丢弃
    mountMermaidBlocks(root, { markdown: MD, theme: 'dark', enabled: true, onZoom: noopZoom });

    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_FIGURE_CLASS} svg`)).not.toBeNull();
    });
    // 只有一个容器、一张图 —— 旧世代没有插进新 DOM
    expect(root.querySelectorAll(`.${MERMAID_HOST_CLASS}`)).toHaveLength(1);
    expect(root.querySelectorAll(`.${MERMAID_FIGURE_CLASS} svg`)).toHaveLength(1);
  });
});

describe('R1 unwrapMermaidHosts', () => {
  it('restores the plain source block and its anchor', async () => {
    const root = makeRoot();
    stubEngine();

    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });
    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_FIGURE_CLASS} svg`)).not.toBeNull();
    });

    unwrapMermaidHosts(root);

    expect(root.querySelectorAll(`.${MERMAID_HOST_CLASS}`)).toHaveLength(0);
    const pre = root.querySelector('pre[data-source-line="2"]') as HTMLElement;
    expect(pre).not.toBeNull();
    expect(pre.getAttribute('data-source-line-end')).toBe('6');
  });
});

// ──────────────────────────────────────────────
// 回归：C3 包裹层存在时的真实生产顺序（本文件其它用例只覆盖「裸 <pre>」）
// ──────────────────────────────────────────────

/**
 * 为什么单开一组：上面的 `makeRoot()` 造的是**裸 `<pre>`**，而生产里
 * `PreviewPane` 在 `useLayoutEffect` 中先 `innerHTML = processedHtml`、再
 * `enhancePreviewContent(el)`（把每个 `<pre>` 包进 `.preview-codeblock`），
 * R1 的 `mountMermaidBlocks` 在**其后**才跑。也就是说真机上 `buildMermaidHost`
 * 拿到的 `pre.parentElement` **一定是 `.preview-codeblock`**，`codeNode === parent`。
 * 老代码在那条分支上会 `parent.insertBefore(host, parent)` 抛 NotFoundError，
 * 且异常紧跟「锚点删除」之后、被 `catch { continue }` 吞掉 ——
 * 结果就是「预览里 mermaid 图不显示、锚点消失、控制台无日志」。
 *
 * 这组用例走**真实封装顺序**（enhance → mount），老代码下必然红。
 */
describe('R1 回归：C3 已包裹（.preview-codeblock）时仍必须建出容器', () => {
  /** 按生产顺序造 root：先 innerHTML，再走真实的 enhancePreviewContent 包裹 */
  function makeWrappedRoot(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'preview-content';
    root.innerHTML =
      '<h1 data-line-anchor="row"><span data-line-row="0">Title</span></h1>'
      + '<pre class="hljs" data-source-line="2" data-source-line-end="6"><code>flowchart LR\n  A --&gt; B</code></pre>';
    document.body.appendChild(root);
    // ← 生产里 useLayoutEffect 会做这一步；其它用例都漏了它
    enhancePreviewContent(root);
    return root;
  }

  it('enhance 包裹后 mount 仍能升级为容器，且锚点搬到容器上', async () => {
    const root = makeWrappedRoot();
    stubEngine();

    // 前置：确认真的被 C3 包住了（否则这条用例就退化成「裸 <pre>」的旧用例）
    expect(root.querySelector('.preview-codeblock pre[data-source-line="2"]')).not.toBeNull();

    const count = mountMermaidBlocks(root, {
      markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom,
    });

    // 老代码这里会是 0（容器构建抛错被吞），并且 <pre> 锚点已被抹掉
    expect(count).toBe(1);

    const host = root.querySelector(`.${MERMAID_HOST_CLASS}`) as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.getAttribute('data-source-line')).toBe('2');
    expect(host.getAttribute('data-source-line-end')).toBe('6');
    // 搬而不复制：锚点在容器上、原 <pre> 上不再残留
    expect(root.querySelectorAll('[data-source-line="2"]')).toHaveLength(1);
    // 源码块（含复制按钮的包裹层）仍保留在容器内，Source 态可用
    expect(host.querySelector('.preview-codeblock pre')).not.toBeNull();

    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_FIGURE_CLASS} svg`)).not.toBeNull();
    });
    expect(host.dataset.mermaidState).toBe('diagram');
  });

  it('enhance 包裹路径下 unwrap 能把锚点还回原 <pre>（可反复挂载）', async () => {
    const root = makeWrappedRoot();
    stubEngine();

    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });
    unwrapMermaidHosts(root);

    expect(root.querySelectorAll(`.${MERMAID_HOST_CLASS}`)).toHaveLength(0);
    const pre = root.querySelector('pre[data-source-line="2"]') as HTMLElement;
    expect(pre).not.toBeNull();
    expect(pre.getAttribute('data-source-line-end')).toBe('6');
  });
});

// ──────────────────────────────────────────────
// 回归：静默失败必须留痕（P0 根因曾被 `catch { continue }` 完全吞掉）
// ──────────────────────────────────────────────

describe('R1 回归：任何未能升级的 mermaid 块都要有 console.warn 痕迹', () => {
  it('容器还是空的（processedHtml 尚未写入）→ 静默返回 0，不发假警告', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 空容器 = 首挂 / 换文档瞬间，PreviewPane 的 useLayoutEffect 还没写 innerHTML
      const root = document.createElement('div');
      root.className = 'preview-content';
      document.body.appendChild(root);
      stubEngine(); // markdown 里确实有 mermaid 块

      const count = mountMermaidBlocks(root, {
        markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom,
      });

      // 没有可升级的目标 → 返回 0，且**不能**报「未找到锚点」（那是假警报）
      expect(count).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('锚点缺失时报警（含期望锚点），且不静默', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const root = document.createElement('div');
      root.className = 'preview-content';
      // 故意放一个**不带锚点**的 pre，模拟「锚点丢了」
      root.innerHTML = '<pre class="hljs"><code>flowchart LR</code></pre>';
      document.body.appendChild(root);
      stubEngine();

      const count = mountMermaidBlocks(root, {
        markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom,
      });

      expect(count).toBe(0);
      const joined = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(joined).toContain('未找到锚点');
      expect(joined).toContain('data-source-line="2"');
    } finally {
      warn.mockRestore();
    }
  });

  it('容器构建抛错时报警，而不是静默吞掉', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 容器里**有内容**（越过空容器守卫），但让 querySelector 返回一个**孤立 pre**
      // （parentElement === null）→ buildMermaidHost 第一步即抛「no parent」
      const root = document.createElement('div');
      root.className = 'preview-content';
      root.innerHTML = '<p>not a code block</p>';
      document.body.appendChild(root);
      const orphan = document.createElement('pre');
      orphan.setAttribute('data-source-line', '2');
      const spy = vi.spyOn(root, 'querySelector').mockReturnValue(orphan as unknown as Element);
      stubEngine();

      const count = mountMermaidBlocks(root, {
        markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom,
      });
      spy.mockRestore();

      expect(count).toBe(0);
      const joined = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(joined).toContain('容器构建失败');
    } finally {
      warn.mockRestore();
    }
  });
});

// ──────────────────────────────────────────────
// 点击归属（U1）
// ──────────────────────────────────────────────

describe('R1 click ownership (U1)', () => {
  /** 挂载并等到渲染完成，返回 host */
  async function mountReady(): Promise<HTMLElement> {
    const root = makeRoot();
    stubEngine();
    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });
    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_FIGURE_CLASS} svg`)).not.toBeNull();
    });
    return root.querySelector(`.${MERMAID_HOST_CLASS}`) as HTMLElement;
  }

  it('clicking the diagram body opens the zoom overlay and swallows the event', async () => {
    const zoomed: Array<{ svgHtml: string; line: number }> = [];
    setMermaidZoomHandler((payload) => zoomed.push(payload));
    const host = await mountReady();

    const svg = host.querySelector('svg') as Element;
    const event = dispatchClick(svg);
    const handled = handlePreviewClick(event, host.closest('.preview-content') as HTMLElement);

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(zoomed).toHaveLength(1);
    expect(zoomed[0].line).toBe(2);
    expect(zoomed[0].svgHtml).toContain('<svg');
    setMermaidZoomHandler(null);
  });

  it('clicking the segment control switches the view and does NOT zoom / jump', async () => {
    const zoomed: unknown[] = [];
    setMermaidZoomHandler((p) => zoomed.push(p));
    const lines: number[] = [];
    window.addEventListener('editor:goto-line', (e) => {
      lines.push((e as CustomEvent<{ line: number }>).detail.line);
    });

    const host = await mountReady();
    const sourceBtn = host.querySelector(
      `.${MERMAID_SEG_BTN_CLASS}[data-mermaid-view="source"]`,
    ) as HTMLElement;

    const event = dispatchClick(sourceBtn);
    expect(handlePreviewClick(event, host.closest('.preview-content') as HTMLElement)).toBe(true);

    expect(zoomed).toHaveLength(0);
    expect(lines).toEqual([]);
    expect(host.dataset.mermaidState).toBe('source');
    expect(host.querySelector('pre')?.hidden).toBe(false);
    setMermaidZoomHandler(null);
  });

  it('clicking the bar (not a button) is swallowed — no zoom, no editor jump', async () => {
    const zoomed: unknown[] = [];
    setMermaidZoomHandler((p) => zoomed.push(p));
    const lines: number[] = [];
    window.addEventListener('editor:goto-line', (e) => {
      lines.push((e as CustomEvent<{ line: number }>).detail.line);
    });

    const host = await mountReady();
    const bar = host.querySelector(`.${BLOCK_BAR_CLASS}`) as HTMLElement;
    const event = dispatchClick(bar);

    expect(handlePreviewClick(event, host.closest('.preview-content') as HTMLElement)).toBe(true);
    expect(zoomed).toHaveLength(0);
    expect(lines).toEqual([]);
    setMermaidZoomHandler(null);
  });

  it('clicking the container blank area falls through to R2 (jumps to the source line)', async () => {
    const zoomed: unknown[] = [];
    setMermaidZoomHandler((p) => zoomed.push(p));
    const lines: number[] = [];
    window.addEventListener('editor:goto-line', (e) => {
      lines.push((e as CustomEvent<{ line: number }>).detail.line);
    });

    const host = await mountReady();
    const event = dispatchClick(host); // 点容器本身（留白）

    const handled = handlePreviewClick(event, host.closest('.preview-content') as HTMLElement);

    // 交给 R2：不放大，跳编辑器到围栏首行
    expect(handled).toBe(true);
    expect(zoomed).toHaveLength(0);
    expect(lines).toEqual([2]);
    setMermaidZoomHandler(null);
  });
});

// ──────────────────────────────────────────────
// 回归（真机点测反馈）：视图切换必须真正隐藏图
// ──────────────────────────────────────────────

describe('R1 回归：切 Source 必须真正隐藏图（真机反馈 #4）', () => {
  it('切到 source：figure.hidden=true、源码块可见；切回 diagram 复原', async () => {
    const root = makeRoot();
    stubEngine();
    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });
    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_FIGURE_CLASS} svg`)).not.toBeNull();
    });
    const host = root.querySelector(`.${MERMAID_HOST_CLASS}`) as HTMLElement;
    const figure = host.querySelector(`.${MERMAID_FIGURE_CLASS}`) as HTMLElement;
    const container = host.closest('.preview-content') as HTMLElement;

    // Diagram 态：图可见、源码块隐藏
    expect(figure.hidden).toBe(false);
    expect(host.querySelector('pre')?.hidden).toBe(true);

    // 切 Source
    const sourceBtn = host.querySelector(
      `.${MERMAID_SEG_BTN_CLASS}[data-mermaid-view="source"]`,
    ) as HTMLElement;
    handlePreviewClick(dispatchClick(sourceBtn), container);
    expect(figure.hidden).toBe(true);
    expect(host.querySelector('pre')?.hidden).toBe(false);

    // 切回 Diagram
    const diagramBtn = host.querySelector(
      `.${MERMAID_SEG_BTN_CLASS}[data-mermaid-view="diagram"]`,
    ) as HTMLElement;
    handlePreviewClick(dispatchClick(diagramBtn), container);
    expect(figure.hidden).toBe(false);
    expect(host.querySelector('pre')?.hidden).toBe(true);
  });

  // ⚠️ 结构断言（hidden===true）**不足以**守住此 bug：作者样式 `.preview-mermaid-figure{display:flex}`
  //    会压过 UA `[hidden]{display:none}`，即使 hidden 置了 true，图在真实浏览器里**仍然可见**。
  //    这正是当初漏掉它的原因。真正的判据是「渲染盒高度为 0」，只能由真机探针给出：
  //    `qa-mermaid-interaction-run.mjs`（断言 `figure.getBoundingClientRect().height === 0`），
  //    且把 globals.css 的全局 `[hidden]{display:none!important}` 回退后该探针必须变红。
});

// ──────────────────────────────────────────────
// 回归（真机点测反馈）：放大浮层的 SVG 必须重新作用域到浮层容器
// ──────────────────────────────────────────────

describe('R1 回归：放大浮层 SVG 重新作用域（真机反馈 #8）', () => {
  it('传给 zoomHandler 的 svgHtml 作用域到浮层容器，且不残留预览 scope', async () => {
    const zoomed: MermaidZoomPayload[] = [];
    setMermaidZoomHandler((p) => zoomed.push(p));

    const root = makeRoot();
    stubEngine(); // 桩 SVG 带 `<style>.node rect{fill:#fff}</style>`
    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });
    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_FIGURE_CLASS} svg`)).not.toBeNull();
    });
    const host = root.querySelector(`.${MERMAID_HOST_CLASS}`) as HTMLElement;

    // 前置：预览 figure 里的 <style> 确实被作用域到预览容器（说明「已作用域化」是真实状态）
    expect(host.querySelector('style')?.textContent ?? '').toContain('data-mermaid-scope');

    handlePreviewClick(
      dispatchClick(host.querySelector('svg') as Element),
      host.closest('.preview-content') as HTMLElement,
    );

    expect(zoomed).toHaveLength(1);
    // 浮层那份：选择器前缀是浮层容器；**不能**含预览 scope
    // （旧实现直接拿 figure 里已作用域化的 `svg.outerHTML`，二次加前缀 → 浮层里失配）
    expect(zoomed[0].svgHtml).toContain(`.${MERMAID_ZOOM_BODY_CLASS} .node rect`);
    expect(zoomed[0].svgHtml).not.toContain('data-mermaid-scope');
    expect(zoomed[0].svgHtml).toContain('<svg');
    setMermaidZoomHandler(null);
  });
});

// ──────────────────────────────────────────────
// 回归（真机点测反馈）：统一条 + Copy（#5 / #6）
// ──────────────────────────────────────────────

describe('R1 回归：统一条与 Copy（真机反馈 #5 / #6）', () => {
  /** 造一个「C3 已包裹」的 root（生产里 host 收编的就是这种；带 data-lang 模拟 md-worker 产出） */
  function makeWrappedRoot(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'preview-content';
    root.innerHTML =
      '<pre class="hljs" data-source-line="2" data-source-line-end="6" data-lang="mermaid">'
      + '<code>flowchart LR\n  A --&gt; B</code></pre>';
    document.body.appendChild(root);
    enhancePreviewContent(root);
    return root;
  }

  /** 桩剪贴板，返回被写入内容的收集数组 */
  function stubClipboard(): string[] {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } },
    });
    return written;
  }

  it('#5 host 内恰好 1 条 bar（复用 C3 那条），kind=flowchart（不带 mermaid 前缀），seg+copy 同一 actions', async () => {
    const root = makeWrappedRoot();
    stubEngine();
    // 前置：C3 已建过一条 bar
    expect(root.querySelector(`.${BLOCK_BAR_CLASS}`)).not.toBeNull();

    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });
    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_FIGURE_CLASS} svg`)).not.toBeNull();
    });
    const host = root.querySelector(`.${MERMAID_HOST_CLASS}`) as HTMLElement;

    // 恰好一条 bar，且在 host 第一个子元素（figure / 源码块之前）
    const bars = host.querySelectorAll(`.${BLOCK_BAR_CLASS}`);
    expect(bars).toHaveLength(1);
    expect(host.firstElementChild).toBe(bars[0]);
    // kind 只显示图类型（第三轮反馈：容器本身已是 mermaid，再拼 'mermaid · ' 是冗余），
    // 且不是 readCodeLang 的 'mermaid'
    expect(bars[0].querySelector(`.${BLOCK_KIND_CLASS}`)?.textContent).toBe('flowchart');
    // seg 与 copy 在同一 actions 容器内
    const actions = bars[0].querySelector(`.${BLOCK_ACTIONS_CLASS}`) as HTMLElement;
    const seg = actions.querySelector(`.${MERMAID_SEG_CLASS}`);
    const copy = actions.querySelector(`.${MERMAID_COPY_BTN_CLASS}`);
    expect(seg).not.toBeNull();
    expect(copy).not.toBeNull();
    // 第三轮反馈：Copy 在左、Diagram|Source 在右（copy.following(seg) 成立）
    expect(copy!.compareDocumentPosition(seg!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('#9 下载用的 rawSvgHtml 不带浮层作用域前缀且已补 xmlns（否则用户单独打开是黑块）', async () => {
    const zoomed: MermaidZoomPayload[] = [];
    setMermaidZoomHandler((p) => zoomed.push(p));

    const root = makeWrappedRoot();
    stubEngine();
    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });
    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_FIGURE_CLASS} svg`)).not.toBeNull();
    });
    const host = root.querySelector(`.${MERMAID_HOST_CLASS}`) as HTMLElement;

    handlePreviewClick(
      dispatchClick(host.querySelector('svg') as Element),
      host.closest('.preview-content') as HTMLElement,
    );

    expect(zoomed).toHaveLength(1);
    // 显示用的那份：作用域到浮层容器（是对的）
    expect(zoomed[0].svgHtml).toContain(`.${MERMAID_ZOOM_BODY_CLASS}`);
    // 下载用的那份：**不能**带浮层 scope，也不能残留预览 scope
    expect(zoomed[0].rawSvgHtml).not.toContain(MERMAID_ZOOM_BODY_CLASS);
    expect(zoomed[0].rawSvgHtml).not.toContain('data-mermaid-scope');
    // 且必须能脱离页面独立打开（按 XML 解析需要 xmlns）
    expect(zoomed[0].rawSvgHtml).toContain('xmlns=');
    setMermaidZoomHandler(null);
  });

  it('#6 Diagram 态 Copy 复制未作用域的原始 SVG，成功反馈 is-copied', async () => {
    const written = stubClipboard();
    const root = makeWrappedRoot();
    stubEngine();
    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });
    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_FIGURE_CLASS} svg`)).not.toBeNull();
    });
    const host = root.querySelector(`.${MERMAID_HOST_CLASS}`) as HTMLElement;
    const btn = host.querySelector(`.${MERMAID_COPY_BTN_CLASS}`) as HTMLElement;

    expect(host.dataset.mermaidState).toBe('diagram');
    handlePreviewClick(dispatchClick(btn), root);
    await vi.waitFor(() => { expect(written).toHaveLength(1); });

    expect(written[0]).toContain('<svg');
    expect(written[0]).toContain('node rect'); // 原始（未作用域）SVG
    expect(written[0]).not.toContain('data-mermaid-scope');
    // 反馈态在剪贴板写入**之后**才落类，故等待类本身（判别点：写盘成功 → is-copied）
    await vi.waitFor(() => { expect(btn.classList.contains('is-copied')).toBe(true); });
  });

  it('#6 Source 态 Copy 复制源码文本（复用 getCodeBlockText）', async () => {
    const written = stubClipboard();
    const root = makeWrappedRoot();
    stubEngine();
    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });
    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_FIGURE_CLASS} svg`)).not.toBeNull();
    });
    const host = root.querySelector(`.${MERMAID_HOST_CLASS}`) as HTMLElement;

    handlePreviewClick(
      dispatchClick(
        host.querySelector(`.${MERMAID_SEG_BTN_CLASS}[data-mermaid-view="source"]`) as Element,
      ),
      root,
    );
    expect(host.dataset.mermaidState).toBe('source');

    const btn = host.querySelector(`.${MERMAID_COPY_BTN_CLASS}`) as HTMLElement;
    handlePreviewClick(dispatchClick(btn), root);
    await vi.waitFor(() => { expect(written).toHaveLength(1); });

    expect(written[0]).toBe('flowchart LR\n  A --> B');
    // 反馈态在写盘之后落类 → 等待类本身
    await vi.waitFor(() => { expect(btn.classList.contains('is-copied')).toBe(true); });
  });

  it('unwrap 后：复用条还原回 codeNode（C3 复制按钮回归、本模块 seg/copy 移除）', async () => {
    const root = makeWrappedRoot();
    stubEngine();
    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });
    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_FIGURE_CLASS} svg`)).not.toBeNull();
    });
    unwrapMermaidHosts(root);

    expect(root.querySelector(`.${MERMAID_HOST_CLASS}`)).toBeNull();
    const codeblock = root.querySelector('.preview-codeblock') as HTMLElement;
    expect(codeblock).not.toBeNull();
    expect(codeblock.querySelector(`.${BLOCK_BAR_CLASS}`)).not.toBeNull();
    expect(codeblock.querySelector('.preview-copy-btn')).not.toBeNull();
    expect(codeblock.querySelector(`.${MERMAID_COPY_BTN_CLASS}`)).toBeNull();
    expect(codeblock.querySelector(`.${MERMAID_SEG_CLASS}`)).toBeNull();
  });
});

// ──────────────────────────────────────────────
// 导出（D3 / C6 所见即所得）
// ──────────────────────────────────────────────

describe('R1 inlineMermaidIntoHtml', () => {
  it('inlines the rendered SVG when the block shows a diagram', async () => {
    const root = makeRoot();
    stubEngine();
    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });
    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_FIGURE_CLASS} svg`)).not.toBeNull();
    });

    const html = '<html><body><pre data-source-line="2"><code>flowchart LR</code></pre></body></html>';
    const out = inlineMermaidIntoHtml(html);

    expect(out).toContain(`class="${MERMAID_HOST_CLASS}"`);
    expect(out).toContain('<svg');
    expect(out).not.toContain('<pre data-source-line="2">');
  });

  it('keeps the source block when the user switched that block to Source', async () => {
    const root = makeRoot();
    stubEngine();
    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: noopZoom });
    await vi.waitFor(() => {
      expect(root.querySelector(`.${MERMAID_FIGURE_CLASS} svg`)).not.toBeNull();
    });

    const host = root.querySelector(`.${MERMAID_HOST_CLASS}`) as HTMLElement;
    const sourceBtn = host.querySelector(
      `.${MERMAID_SEG_BTN_CLASS}[data-mermaid-view="source"]`,
    ) as HTMLElement;
    const event = dispatchClick(sourceBtn);
    // ⚠️ 必须把**派发后**的那个 event 交给 handlePreviewClick：
    // 另造一个 MouseEvent 的 target 是 null，断言会静默假通过
    expect(handlePreviewClick(event, host.closest('.preview-content') as HTMLElement)).toBe(true);

    const html = '<html><body><pre data-source-line="2"><code>flowchart LR</code></pre></body></html>';
    // 该块当前显示源码 → 导出保持源码块
    expect(inlineMermaidIntoHtml(html)).toBe(html);
  });

  it('returns the html untouched when nothing has been rendered', () => {
    const html = '<html><body><pre data-source-line="2"><code>x</code></pre></body></html>';
    clearRenderedMermaid();
    expect(inlineMermaidIntoHtml(html)).toBe(html);
  });
});
