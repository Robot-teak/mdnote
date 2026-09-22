// @vitest-environment jsdom
/**
 * **跨端锚点契约测试**（R1 引擎层 ↔ md-worker 生产者）
 *
 * 为什么单独开一个文件：`mermaid-renderer.test.ts` 那 16 条用 **markdown-it 真实解析出的
 * fence map** 当黄金标准，但它**不解析 worker 的实际输出** —— 也就是说 `md-worker`
 * 哪天改了锚点口径，那 16 条不会红。**两端各自测过、接缝没人测**，正是本轮反复出现的洞。
 *
 * 这里锁的就是那条缝：
 * > 对同一批样例文档，`md-worker` 渲染出的围栏 `<pre>` 上的 `data-source-line`
 * > 必须等于 `extractMermaidBlocks()[i].fenceStartLine`；
 * > `data-source-line-end`（若存在）必须等于 `fenceEndLine`。
 *
 * 两条硬性做法：
 * 1. **驱动真实 worker**（接管 `self.postMessage`，与 `md-worker.test.ts` 同手法），
 *    不复刻一份 md 实例 —— 复刻品会失去「两端对齐」的意义
 * 2. **样例文档里只放 mermaid 围栏**，保证 `<pre>` 与 `extractMermaidBlocks()`
 *    严格 1:1 配对，不靠「猜哪个 pre 对应哪个块」来对齐
 *
 * 判别力：见文件末尾 `describe('判别力自检')` —— 那里显式钉住
 * `fenceStartLine !== startLine`，任何人把 off-by-one「修回去」都会红。
 * 另外本文件在交付前做过一次**真实破坏性验证**（把 renderer 的 `fenceStartLine`
 * 临时改成 `startLine` 语义），结果记录在实现日志「批次 B-5」。
 */

import { describe, it, expect, vi } from 'vitest';

// 必须在 **导入 worker 之前** 说明：worker 模块顶层执行 `self.onmessage = …`，
// jsdom 下 `self === window`，赋值与调用都成立。
import '../../workers/md-worker';

// 只顶掉真正会去 `import('mermaid')` 的渲染函数，其余全部走真实实现：
// 下面「端到端接缝」用例要验的是 **锚点从 worker → DOM 容器的搬运**，
// 与 mermaid 运行时无关，桩掉可让用例确定且快。
vi.mock('../mermaid-renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mermaid-renderer')>();
  return {
    ...actual,
    renderMermaidSvg: async () => '<svg viewBox="0 0 1 1"><style>.node rect{fill:#fff}</style></svg>',
  };
});

import {
  extractMermaidBlocks,
  buildMermaidBlockHtml,
  MERMAID_BLOCK_CLASS,
  type MermaidBlock,
} from '../mermaid-renderer';
import { mountMermaidBlocks, MERMAID_HOST_CLASS } from '../mermaid-preview';
import { sanitizeHtml } from '../sanitize';
import { enhancePreviewContent } from '../preview-enhance';

// ──────────────────────────────────────────────
// 驱动真实 worker
// ──────────────────────────────────────────────

/** worker 回包形态（只关心 RENDER_DONE） */
interface PostedMessage {
  type: string;
  html?: string;
  message?: string;
}

/** 把 worker 的宿主对象（`self`）转成可直接驱动的形状 */
const workerHost = self as unknown as {
  onmessage: ((event: MessageEvent) => Promise<void>) | null;
  postMessage: ((message: PostedMessage) => void) | null;
};

/**
 * 驱动 **真实的 md-worker** 渲染一段 Markdown，返回产物 HTML。
 *
 * @param src Markdown 源码
 * @returns worker 的 RENDER_DONE 产物
 */
async function renderMarkdown(src: string): Promise<string> {
  const posted: PostedMessage[] = [];
  const originalPostMessage = workerHost.postMessage;
  workerHost.postMessage = (message: PostedMessage) => {
    posted.push(message);
  };

  try {
    await workerHost.onmessage?.({
      data: { type: 'RENDER', payload: src },
    } as unknown as MessageEvent);
  } finally {
    workerHost.postMessage = originalPostMessage;
  }

  const done = posted.find((message) => message.type === 'RENDER_DONE');
  if (!done || typeof done.html !== 'string') {
    throw new Error(`worker 没有回 RENDER_DONE：${JSON.stringify(posted)}`);
  }
  return done.html;
}

// ──────────────────────────────────────────────
// HTML 侧解析
// ──────────────────────────────────────────────

/** 从 HTML 里按出现顺序抽出所有 `<pre …>` 开标签 */
function matchPreTags(html: string): string[] {
  return html.match(/<pre\b[^>]*>/g) ?? [];
}

/** 把一个开标签解析成属性表 */
function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

/** 从容器 HTML（buildMermaidBlockHtml 的产物）里抽外层 div 的属性表 */
function parseContainerAttrs(html: string): Record<string, string> {
  const open = html.match(/^<div\b[^>]*>/);
  if (!open) throw new Error(`容器 HTML 不以 <div> 开头：${html.slice(0, 80)}`);
  return parseAttrs(open[0]);
}

/** 一个占位 SVG（本文件只比属性，不比图内容） */
const PLACEHOLDER_SVG = '<svg viewBox="0 0 1 1"></svg>';

// ──────────────────────────────────────────────
// 样例矩阵
// ──────────────────────────────────────────────

/**
 * 样例矩阵。
 *
 * ⚠️ 每条样例**只含 mermaid 围栏**，确保 `<pre>` 与 `extractMermaidBlocks()` 1:1 配对。
 * 覆盖：围栏在文档开头 / 不在开头、末尾换行 0/1/2 个、未闭合围栏、
 * 波浪号围栏、3 空格缩进、围栏前后空行、文档里多个 mermaid 块。
 */
const CASES: Array<{ name: string; src: string }> = [
  { name: '围栏在文档开头（后面还有正文）', src: '```mermaid\nflowchart LR\n  A --> B\n```\ntail\n' },
  { name: '围栏不在文档开头', src: '# t\n\n```mermaid\nflowchart LR\n```\n' },
  { name: '末尾 0 个换行', src: '```mermaid\nA\n```' },
  { name: '末尾 1 个换行', src: '```mermaid\nA\n```\n' },
  { name: '末尾 2 个换行', src: '```mermaid\nA\n```\n\n' },
  { name: '未闭合围栏（无末尾换行）', src: '```mermaid\nA\nB' },
  { name: '未闭合围栏（有末尾换行）', src: '```mermaid\nA\nB\n' },
  { name: '波浪号围栏', src: '~~~mermaid\nA\n~~~\n' },
  { name: '3 空格缩进围栏', src: '  ```mermaid\n  A\n  ```\n' },
  { name: '围栏前后有空行', src: '\n\n```mermaid\nA\n```\n\n\n' },
  { name: '文档里 2 个 mermaid 块', src: '```mermaid\nA\n```\n\nmid\n\n```mermaid\nB\n```\n' },
  {
    name: '文档里 3 个 mermaid 块（反引号与波浪号混用）',
    src: '```mermaid\nA\n```\ntext\n```mermaid\nB\n```\ntext\n~~~mermaid\nC\n~~~\n',
  },
];

// ──────────────────────────────────────────────
// 契约断言
// ──────────────────────────────────────────────

describe('跨端锚点契约：worker 的 <pre> 锚点 === 引擎的 fence 行号', () => {
  for (const { name, src } of CASES) {
    it(name, async () => {
      const html = await renderMarkdown(src);
      const blocks = extractMermaidBlocks(src);
      const pres = matchPreTags(html);

      // 前置：样例只含 mermaid 围栏，才能 1:1 配对
      expect(pres.length).toBe(blocks.length);
      expect(blocks.length).toBeGreaterThan(0);

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const attrs = parseAttrs(pres[i]);

        // ① data-source-line 必须等于 fenceStartLine（不是 startLine）
        expect(attrs['data-source-line']).toBe(String(block.fenceStartLine));

        // ② data-source-line-end：有则必须等于 fenceEndLine
        const endRaw = attrs['data-source-line-end'];
        if (endRaw !== undefined) {
          expect(endRaw).toBe(String(block.fenceEndLine));
        } else {
          // worker 只在多行块上打 -end，此时引擎侧也必须判定为单行
          expect(block.fenceEndLine - block.fenceStartLine).toBe(1);
        }
      }
    });
  }

  it('每个样例都真的产出了围栏 <pre>（防样例写错导致空跑）', async () => {
    for (const { name, src } of CASES) {
      const html = await renderMarkdown(src);
      expect(matchPreTags(html).length, name).toBeGreaterThan(0);
    }
  });
});

describe('跨端锚点契约：buildMermaidBlockHtml() 复现 worker 的锚点', () => {
  /**
   * 这条是「UI 层替换 <pre> 后锚点不跳行」的直接保证：
   * 引擎造出来的容器，锚点必须与 worker 打在原 `<pre>` 上的**逐字相同**。
   */
  for (const { name, src } of CASES) {
    it(`容器锚点 === worker 锚点 —— ${name}`, async () => {
      const html = await renderMarkdown(src);
      const blocks = extractMermaidBlocks(src);
      const pres = matchPreTags(html);
      expect(pres.length).toBe(blocks.length);

      for (let i = 0; i < blocks.length; i++) {
        const preAttrs = parseAttrs(pres[i]);
        const containerAttrs = parseContainerAttrs(
          buildMermaidBlockHtml(blocks[i], PLACEHOLDER_SVG),
        );

        expect(containerAttrs['data-source-line']).toBe(preAttrs['data-source-line']);
        expect(containerAttrs['data-source-line-end']).toBe(preAttrs['data-source-line-end']);
        expect(containerAttrs['class']).toContain(MERMAID_BLOCK_CLASS);
      }
    });
  }
});

describe('data-line-anchor 根标记：围栏是首个顶层块时不能丢', () => {
  it('mermaid 围栏是文档首个顶层块 → <pre> 上带 data-line-anchor', async () => {
    const src = '```mermaid\nflowchart LR\n  A --> B\n```\ntail\n';
    const html = await renderMarkdown(src);

    const preAttrs = parseAttrs(matchPreTags(html)[0]);
    // ⚠️ 判别点：这个属性是 md-worker 打在**首个顶层块**上的（md-worker.ts:368-375）。
    // UI 层替换 <pre> 时若漏搬，readLineAnchorMode() 会返回 null，
    // R3 静默退化成块级锚点，行级 span 白做。
    expect(preAttrs['data-line-anchor']).toBe('row');
  });

  it('buildMermaidBlockHtml 能把它原样搬到新容器上', async () => {
    const src = '```mermaid\nflowchart LR\n  A --> B\n```\ntail\n';
    const html = await renderMarkdown(src);
    const block = extractMermaidBlocks(src)[0];

    const rootAnchor = parseAttrs(matchPreTags(html)[0])['data-line-anchor'];
    const containerAttrs = parseContainerAttrs(
      buildMermaidBlockHtml(block, PLACEHOLDER_SVG, { rootAnchor: rootAnchor as 'row' | 'block' }),
    );
    expect(containerAttrs['data-line-anchor']).toBe(rootAnchor);
  });

  it('围栏不是首个顶层块 → <pre> 上不带 data-line-anchor（不该凭空造一个）', async () => {
    const src = '# t\n\n```mermaid\nA\n```\n';
    const html = await renderMarkdown(src);

    const preAttrs = parseAttrs(matchPreTags(html)[0]);
    expect(preAttrs['data-line-anchor']).toBeUndefined();
    // 根标记落在标题上，不是围栏上
    expect(html).toContain('data-line-anchor="row"');
  });

  it('多块文档里根标记只在第一块上，容器也只该搬第一块', async () => {
    const src = '```mermaid\nA\n```\n\nmid\n\n```mermaid\nB\n```\n';
    const html = await renderMarkdown(src);
    const pres = matchPreTags(html);

    expect(parseAttrs(pres[0])['data-line-anchor']).toBe('row');
    expect(parseAttrs(pres[1])['data-line-anchor']).toBeUndefined();
  });
});

describe('判别力自检：防止有人把 off-by-one「修回去」', () => {
  it('fenceStartLine 与 startLine 必须相差 1（两者不是同一个东西）', async () => {
    // 若哪天有人把 fenceStartLine 改成 startLine 语义，上面所有契约用例会先红；
    // 这条额外钉住「两个字段本就不同」，避免有人用「合并成一个字段」的方式让契约通过。
    const src = '```mermaid\nflowchart LR\n  A --> B\n```\n';
    const block = extractMermaidBlocks(src)[0];

    expect(block.startLine - block.fenceStartLine).toBe(1);
    expect(block.fenceEndLine - block.endLine).toBe(1);
  });

  it('契约对“锚点值”敏感：手工构造一个错位块，断言必须被抓出来', async () => {
    const src = '```mermaid\nA\n```\n';
    const html = await renderMarkdown(src);
    const preAttrs = parseAttrs(matchPreTags(html)[0]);

    const good: MermaidBlock = {
      code: 'A',
      startLine: 1,
      endLine: 2,
      fenceStartLine: 0,
      fenceEndLine: 3,
      info: 'mermaid',
    };
    // 把 fenceStartLine 换成 startLine 语义 —— 这正是 UI 层最容易犯的错
    const bad: MermaidBlock = { ...good, fenceStartLine: good.startLine };

    expect(parseContainerAttrs(buildMermaidBlockHtml(good, PLACEHOLDER_SVG))['data-source-line'])
      .toBe(preAttrs['data-source-line']);
    expect(parseContainerAttrs(buildMermaidBlockHtml(bad, PLACEHOLDER_SVG))['data-source-line'])
      .not.toBe(preAttrs['data-source-line']);
  });
});

// ──────────────────────────────────────────────
// 端到端接缝：worker → sanitize → C3 包裹 → mount（真机顺序）
// ──────────────────────────────────────────────

/**
 * 前面几组把「worker 产物」和「引擎的容器 HTML」**分别**钉住了，但真机里
 * 两者之间还夹着两步 DOM 处理，谁都没测：
 *   worker HTML → `sanitizeHtml` → `innerHTML` → `enhancePreviewContent`
 *   （把 `<pre>` 包进 `.preview-codeblock`）→ `mountMermaidBlocks`
 *
 * 插件版「mermaid 不渲染」的 P0 就出在这一段：`buildMermaidHost` 只处理了
 * 「裸 `<pre>`」，一旦前面套了 `.preview-codeblock` 包裹层，`codeNode` 变成
 * 包裹层本身，插入 host 时 `insertBefore(host, parent)` 抛 NotFoundError，
 * 被静默吞掉 → 锚点被删、容器没建。**这组用例走完整真机顺序，老代码下必红。**
 */
describe('端到端接缝：worker → sanitize → enhance → mount（锚点必须落到容器上）', () => {
  for (const { name, src } of CASES) {
    it(`真机顺序下 mermaid 块升级为容器 —— ${name}`, async () => {
      const html = await renderMarkdown(src);
      const blocks = extractMermaidBlocks(src);
      expect(blocks.length).toBeGreaterThan(0);

      // ① 真机 DOM 处理链：sanitize → innerHTML → C3 包裹
      const root = document.createElement('div');
      root.className = 'preview-content';
      root.innerHTML = sanitizeHtml(html);
      enhancePreviewContent(root);
      // 前置：确认 `<pre>` 已被 C3 包进 `.preview-codeblock`（这条用例的判别点）
      expect(root.querySelector(`.${'preview-codeblock'} pre`)).not.toBeNull();

      // ② 挂载（同步部分即完成容器构建 + 锚点搬运）
      const count = mountMermaidBlocks(root, {
        markdown: src, theme: 'light', enabled: true, onZoom: () => {},
      });
      expect(count).toBe(blocks.length);

      // ③ 每个块的锚点都必须落在容器上（值与 worker 打在 <pre> 上的 fenceStartLine 一致）
      const hosts = Array.from(root.querySelectorAll(`.${MERMAID_HOST_CLASS}`));
      expect(hosts).toHaveLength(blocks.length);
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const host = hosts[i] as HTMLElement;
        expect(host.getAttribute('data-source-line')).toBe(String(block.fenceStartLine));
        const endAttr = host.getAttribute('data-source-line-end');
        if (block.fenceEndLine - block.fenceStartLine > 1) {
          expect(endAttr).toBe(String(block.fenceEndLine));
        }
        // 搬而不复制：容器上恰好一个该值锚点，原 <pre> 不再残留
        expect(root.querySelectorAll(`[data-source-line="${block.fenceStartLine}"]`))
          .toHaveLength(1);
        // 源码块（含复制按钮）仍保留在容器内，Source 态可用
        expect(host.querySelector('pre')).not.toBeNull();
      }
    });
  }

  it('判别力自检：直接对「裸 <pre>」挂载也必须成功（两种形态都要支持）', async () => {
    const src = '```mermaid\nflowchart LR\n  A --> B\n```\n';
    const html = await renderMarkdown(src);
    const root = document.createElement('div');
    root.className = 'preview-content';
    // 不走 enhance（裸 <pre>）—— 这是唯一被 mermaid-preview.test.ts 覆盖过的形态
    root.innerHTML = sanitizeHtml(html);

    const count = mountMermaidBlocks(root, {
      markdown: src, theme: 'light', enabled: true, onZoom: () => {},
    });
    expect(count).toBe(1);
    const host = root.querySelector(`.${MERMAID_HOST_CLASS}`) as HTMLElement;
    expect(host.getAttribute('data-source-line')).toBe('0');
  });
});
