// @vitest-environment jsdom
/**
 * **R4 预览块级稀疏行号** 单测（`applyPreviewLineNumbers` / `enhancePreviewContent`）
 *
 * 这个文件守的是 A12 十条判据里**能被单测覆盖**的那几条：
 *  - 第 2 条：数字必须与编辑器 gutter **同一套 1-based 编号**（「差 1」即 Fail）
 *  - 第 2b 条：**块级稀疏**（每块首一个数字），不是每行都有
 *  - 第 4 条（**2026-09-19 作废**）：~~代码块左侧不出现行号数字~~ → 代码块 / 表格 /
 *    mermaid 容器**都显示**行号（真机点测要求，见 task A）
 *  - 第 6 条：导出的 HTML 里**没有任何行号**（跨端守卫：驱动真实 worker 的 EXPORT_HTML）
 *  - 第 10 条：表格行号画在 `.preview-table-wrap` 包裹层上，不在 `<table>` 上
 *
 * 视觉类判据（步骤 3/4/5/7/9 的字号、配色、闪烁、打印）无法单测，由 QA 点测。
 */

import { describe, it, expect, vi } from 'vitest';

// 必须在导入 worker 之前说明：worker 模块顶层执行 `self.onmessage = …`，
// jsdom 下 `self === window`，赋值与调用都成立。
import '../../workers/md-worker';
import {
  applyPreviewLineNumbers,
  enhancePreviewContent,
  PREVIEW_MERMAID_CLASS,
} from '../preview-enhance';
import { mountMermaidBlocks, MERMAID_HOST_CLASS } from '../mermaid-preview';
import { sanitizeHtml } from '../sanitize';

// ⑩ 端到端接缝用例要让 `mountMermaidBlocks` 真正跑完**同步**挂载，但不引真 mermaid 运行时：
// 只桩掉会去 `import('mermaid')` 的渲染函数，其余全部走真实实现（EXPORT_HTML 路径不受影响，
// 它本就不调 `renderMermaidSvg`）。
vi.mock('../mermaid-renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mermaid-renderer')>();
  return {
    ...actual,
    renderMermaidSvg: async () =>
      '<svg viewBox="0 0 1 1"><style>.node rect{fill:#fff}</style></svg>',
  };
});

const LINE_NO = 'data-line-no';
const SOURCE_LINE = 'data-source-line';

/** 造一个挂在 document 上的预览内容容器 */
function makeRoot(html: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'preview-content';
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

/** 读某元素的 `data-line-no`（null = 没有） */
function lineNo(el: Element | null): string | null {
  return el?.getAttribute(LINE_NO) ?? null;
}

// ──────────────────────────────────────────────
// ① 1-based 换算
// ──────────────────────────────────────────────

describe('R4 ① data-line-no = data-source-line + 1（A12 第 2 条）', () => {
  it('0 → 1（边界：预览第一行不能显示 0）', () => {
    const root = makeRoot('<h1 data-source-line="0">t</h1>');
    applyPreviewLineNumbers(root, true);
    expect(lineNo(root.querySelector('h1'))).toBe('1');
  });

  it('25 → 26', () => {
    const root = makeRoot('<p data-source-line="25">t</p>');
    applyPreviewLineNumbers(root, true);
    expect(lineNo(root.querySelector('p'))).toBe('26');
  });

  it('**不改** data-source-line 本身（保持 0-based，R2/R3 按 0-based 比较）', () => {
    const root = makeRoot('<p data-source-line="7">t</p>');
    applyPreviewLineNumbers(root, true);
    expect(root.querySelector('p')!.getAttribute(SOURCE_LINE)).toBe('7');
    expect(lineNo(root.querySelector('p'))).toBe('8');
  });
});

// ──────────────────────────────────────────────
// ② 代码块也要显示行号（A12 第 4 条 2026-09-19 作废）
// ──────────────────────────────────────────────

describe('R4 ② 代码块也要显示行号（team-lead 2026-09-19 裁决）', () => {
  it('pre 上也写 data-line-no，且 data-source-line / -end 原样保留（R2/R3 锚点不动）', () => {
    const root = makeRoot(
      '<p data-source-line="0">para</p>' +
        '<pre class="hljs" data-source-line="2" data-source-line-end="5"><code>x</code></pre>',
    );
    applyPreviewLineNumbers(root, true);

    const pre = root.querySelector('pre')!;
    // 判别点：若旧「跳过 PRE」还在，这里会是 null
    expect(lineNo(pre)).toBe('3'); // 2 + 1
    expect(pre.getAttribute(SOURCE_LINE)).toBe('2');
    expect(pre.getAttribute('data-source-line-end')).toBe('5');
    // 段落照常拿号
    expect(lineNo(root.querySelector('p'))).toBe('1');
  });

  it('pre 上残留的旧 data-line-no 会被**重算**（而非清掉，因为 pre 现在也合法带号）', () => {
    const root = makeRoot('<pre data-source-line="2" data-line-no="99"><code>x</code></pre>');
    applyPreviewLineNumbers(root, true);
    expect(lineNo(root.querySelector('pre'))).toBe('3');
  });
});

// ──────────────────────────────────────────────
// ③ 嵌套去重
// ──────────────────────────────────────────────

describe('R4 ③ 嵌套块去重（否则一个列表/表格刷出 5–6 个数字）', () => {
  it('ul + li：只有 ul 拿到号', () => {
    const root = makeRoot(
      '<ul data-source-line="8" data-source-line-end="12">' +
        '<li data-source-line="8">a</li><li data-source-line="9">b</li></ul>',
    );
    applyPreviewLineNumbers(root, true);

    expect(lineNo(root.querySelector('ul'))).toBe('9');
    for (const li of root.querySelectorAll('li')) expect(lineNo(li)).toBeNull();
  });

  it('table + thead/tbody/tr：只有 table 拿到号', () => {
    const root = makeRoot(
      '<table data-source-line="12" data-source-line-end="15">' +
        '<thead data-source-line="12"><tr data-source-line="12"><th>x</th></tr></thead>' +
        '<tbody data-source-line="14"><tr data-source-line="14"><td>y</td></tr></tbody></table>',
    );
    applyPreviewLineNumbers(root, true);

    expect(lineNo(root.querySelector('table'))).toBe('13');
    for (const el of root.querySelectorAll('thead, tbody, tr')) expect(lineNo(el)).toBeNull();
  });

  it('blockquote + 内层 p：只有 blockquote 拿到号', () => {
    const root = makeRoot(
      '<blockquote data-source-line="22" data-source-line-end="24">' +
        '<p data-source-line="22" data-source-line-end="24">q</p></blockquote>',
    );
    applyPreviewLineNumbers(root, true);

    expect(lineNo(root.querySelector('blockquote'))).toBe('23');
    expect(lineNo(root.querySelector('blockquote p'))).toBeNull();
  });

  it('块级稀疏：源码行号跳跃，几个块就只有几个数字', () => {
    const root = makeRoot(
      '<h1 data-source-line="0">h</h1>' +
        '<p data-source-line="2" data-source-line-end="5">p</p>' +
        '<pre data-source-line="16" data-source-line-end="19"><code>c</code></pre>' +
        '<p data-source-line="25">tail</p>',
    );
    applyPreviewLineNumbers(root, true);

    const numbers = Array.from(root.querySelectorAll(`[${LINE_NO}]`)).map(
      (el) => el.getAttribute(LINE_NO),
    );
    // 4 个块 → 4 个数字（含 pre，2026-09-19 起代码块也带号），且是 1 / 3 / 17 / 26 这种**跳跃**序列
    expect(numbers).toEqual(['1', '3', '17', '26']);
  });
});

// ──────────────────────────────────────────────
// ④⑤⑥ enabled 语义 / 幂等 / 异常输入
// ──────────────────────────────────────────────

describe('R4 ④⑤⑥ 幂等、关闭时清干净、异常输入不崩', () => {
  it('④ 重复调用结果一致（幂等）', () => {
    const root = makeRoot('<p data-source-line="0">a</p><p data-source-line="4">b</p>');
    applyPreviewLineNumbers(root, true);
    const first = root.innerHTML;
    applyPreviewLineNumbers(root, true);
    expect(root.innerHTML).toBe(first);
  });

  it('⑤ enabled=false 把已有的 data-line-no 全部清除', () => {
    const root = makeRoot('<h1 data-source-line="0">h</h1><p data-source-line="3">p</p>');
    applyPreviewLineNumbers(root, true);
    expect(root.querySelectorAll(`[${LINE_NO}]`).length).toBe(2);

    applyPreviewLineNumbers(root, false);
    expect(root.querySelectorAll(`[${LINE_NO}]`).length).toBe(0);
    // 锚点本身不受影响
    expect(root.querySelectorAll(`[${SOURCE_LINE}]`).length).toBe(2);
  });

  it('⑥ 非数字锚点：不写、不补 0、不占位', () => {
    const root = makeRoot(
      '<p data-source-line="abc">a</p>' +
        // ⚠️ 这两个是 `Number()` 的经典陷阱：`Number('')` 与 `Number('  ')` 都是 **0**，
        // 用 `Number.isFinite(Number(raw))` 判空属性会被静默当成第 0 行、显示成 `1`。
        // 实现里必须用 `/^\d+$/` 判字面量（本用例就是这条的守卫）。
        '<p data-source-line="">b</p>' +
        '<p data-source-line="  ">c</p>' +
        '<p data-source-line="-3">d</p>',
    );
    applyPreviewLineNumbers(root, true);
    expect(root.querySelectorAll(`[${LINE_NO}]`).length).toBe(0);
  });

  it('⑥ 只有旧 data-line-no、没有 data-source-line 的残留元素会被清掉', () => {
    const root = makeRoot('<p data-line-no="9">stale</p>');
    applyPreviewLineNumbers(root, true);
    expect(root.querySelectorAll(`[${LINE_NO}]`).length).toBe(0);
  });

  it('⑥ 空容器不崩', () => {
    const root = makeRoot('');
    expect(() => applyPreviewLineNumbers(root, true)).not.toThrow();
  });
});

// ──────────────────────────────────────────────
// ⑦ enhancePreviewContent 的顺序契约 + 默认关闭
// ──────────────────────────────────────────────

describe('R4 ⑦ enhancePreviewContent 的开关与顺序', () => {
  const TABLE_HTML =
    '<table data-source-line="12" data-source-line-end="15">' +
    '<thead data-source-line="12"><tr data-source-line="12"><th>x</th></tr></thead>' +
    '<tbody data-source-line="14"><tr data-source-line="14"><td>y</td></tr></tbody></table>';

  it('不传 options 时一个 data-line-no 都不写（默认关，行为与 R4 之前一致）', () => {
    const root = makeRoot('<p data-source-line="0">a</p>');
    enhancePreviewContent(root);
    expect(root.querySelectorAll(`[${LINE_NO}]`).length).toBe(0);
  });

  it('显式 lineNumbers:false 同样不写', () => {
    const root = makeRoot('<p data-source-line="0">a</p>');
    enhancePreviewContent(root, { lineNumbers: false });
    expect(root.querySelectorAll(`[${LINE_NO}]`).length).toBe(0);
  });

  it('⑦ 表格：C4 包裹层拿号，<table> 拿不到（A12 第 10 条）', () => {
    const root = makeRoot(TABLE_HTML);
    enhancePreviewContent(root, { lineNumbers: true });

    const wrap = root.querySelector('.preview-table-wrap')!;
    expect(wrap).not.toBeNull();
    expect(lineNo(wrap)).toBe('13'); // 12 + 1
    expect(lineNo(root.querySelector('table'))).toBeNull();
    // 包裹层外侧才画得到数字（不落在 overflow-x 容器的左溢出区）
    expect(root.querySelector(`[${SOURCE_LINE}]`)).toBe(wrap);
  });

  it('⑦ 代码块：包裹层拿号（与 mermaid 一样画在标题行高度），内层 pre 不拿号但锚点保留', () => {
    const root = makeRoot(
      '<pre class="hljs" data-source-line="2" data-source-line-end="5"><code>x</code></pre>',
    );
    enhancePreviewContent(root, { lineNumbers: true });

    const wrap = root.querySelector('.preview-codeblock')!;
    expect(wrap).not.toBeNull();
    // 第三轮反馈：行号宿主从 <pre> 上移到**包裹层**，这样它落在标题行那一行的高度上，
    // 与 mermaid 容器的行号一致（画在 <pre> 上会跟着 pre 的 padding 低一截）。
    expect(lineNo(wrap)).toBe('3');
    // pre 作为「祖先已有 data-line-no 的后代」被跳过 → 不再重复拿号
    expect(lineNo(root.querySelector('pre'))).toBeNull();
    // ⚠️ pre 上的锚点**必须保留**（R2/R3 定位与 mermaid 挂载都依赖它，删了是回归）
    expect(root.querySelector('pre')!.getAttribute(SOURCE_LINE)).toBe('2');
    // 包裹层上也是同一份锚点（复制而来，不是搬走）
    expect(wrap.getAttribute(SOURCE_LINE)).toBe('2');
  });
});

// ──────────────────────────────────────────────
// ⑧ mermaid 容器显示行号（team-lead 2026-09-19 裁决，作废旧「容器不显示」）
// ──────────────────────────────────────────────

describe('R4 ⑧ mermaid 容器显示行号（team-lead 2026-09-19 裁决）', () => {
  it('容器本体拿到号；容器内被搬进来的源码 pre 靠嵌套去重不重复出号；兄弟块照常', () => {
    const root = makeRoot(
      '<p data-source-line="0">before</p>' +
        `<div class="${PREVIEW_MERMAID_CLASS}" data-source-line="2" data-source-line-end="6">` +
        '<div class="preview-mermaid-bar"></div>' +
        '<pre class="hljs" data-source-line="2" data-source-line-end="6"><code>flowchart LR</code></pre>' +
        '</div>' +
        '<p data-source-line="8">after</p>',
    );
    applyPreviewLineNumbers(root, true);

    // 判别点：若旧「跳过 .preview-mermaid」还在，容器这里会是 null
    expect(lineNo(root.querySelector(`.${PREVIEW_MERMAID_CLASS}`))).toBe('3'); // 2 + 1
    // 容器内的源码 pre：祖先已有号 → 嵌套去重，不重复出号（否则一块两号）
    expect(lineNo(root.querySelector(`.${PREVIEW_MERMAID_CLASS} pre`))).toBeNull();
    // 不误伤兄弟块
    expect(lineNo(root.querySelectorAll('p')[0])).toBe('1');
    expect(lineNo(root.querySelectorAll('p')[1])).toBe('9');
  });

  it('漂移守卫：PREVIEW_MERMAID_CLASS 必须与 mermaid-preview 的 MERMAID_HOST_CLASS 一致', () => {
    // preview-enhance 刻意重复了字面量（反向 import 会形成循环依赖），
    // 这条断言就是防两处漂移的唯一手段。改名时这里会立刻红。
    expect(PREVIEW_MERMAID_CLASS).toBe(MERMAID_HOST_CLASS);
    expect(PREVIEW_MERMAID_CLASS).toBe('preview-mermaid');
  });
});

// ──────────────────────────────────────────────
// ⑨ 跨端守卫：导出的 HTML 不含任何行号
// ──────────────────────────────────────────────

/** worker 回包形态（只关心 EXPORT_HTML_DONE） */
interface PostedMessage {
  type: string;
  html?: string;
  message?: string;
}

const workerHost = self as unknown as {
  onmessage: ((event: MessageEvent) => Promise<void>) | null;
  postMessage: ((message: PostedMessage) => void) | null;
};

/** 驱动**真实 worker** 导出 HTML（与预览渲染共用同一份渲染函数） */
async function exportHtml(md: string): Promise<string> {
  const posted: PostedMessage[] = [];
  const original = workerHost.postMessage;
  workerHost.postMessage = (message: PostedMessage) => {
    posted.push(message);
  };
  try {
    await workerHost.onmessage?.({
      data: { type: 'EXPORT_HTML', payload: { md, theme: 'light' } },
    } as unknown as MessageEvent);
  } finally {
    workerHost.postMessage = original;
  }
  const done = posted.find((message) => message.type === 'EXPORT_HTML_DONE');
  if (!done || typeof done.html !== 'string') {
    throw new Error(`worker 没有回 EXPORT_HTML_DONE：${JSON.stringify(posted)}`);
  }
  return done.html;
}

describe('R4 ⑨ 导出 HTML 里没有任何行号（A12 第 6 条）', () => {
  it('EXPORT_HTML 产物既无 data-line-no 属性，也无行号 CSS', async () => {
    const md = '# t\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\npara\n\n```js\nconst a = 1\n```\n';
    const html = await exportHtml(md);

    // ① 属性层面：worker 从不产出 data-line-no（行号是预览后处理写的 DOM 属性）
    expect(html).not.toContain(LINE_NO);
    // ② 样式层面：导出物用的是 buildFullHTML 自带 <style>，不含 R4 的行号规则
    expect(html).not.toContain('show-line-numbers');
    expect(html).not.toContain('data-line-no');
    // ③ 反向确认导出确实带了块级锚点（说明上面的「不含」不是因为整份文档没锚点）
    expect(html).toContain(SOURCE_LINE);
  });

  it('EXPORT_HTML 也带 data-lang（Fix 7 副作用；行号仍为零）——记录已知行为', async () => {
    // Fix 7 让 worker 的 fence 规则给 `<pre>` 写 data-lang，导出与预览共用同一渲染函数，
    // 故导出物自然带上该属性。**头号目标（行号不进导出）不受影响**，此断言只为固定契约。
    const html = await exportHtml('```js\nconst a = 1\n```\n');
    expect(html).toContain('data-lang="js"');
    expect(html).not.toContain(LINE_NO);
  });
});

// ──────────────────────────────────────────────
// ⑩ 端到端接缝：worker → sanitize → enhance(行号开) → mount → 挂载后再落号
// ──────────────────────────────────────────────

/**
 * 前 9 组把「worker 产物」「applyPreviewLineNumbers」「enhancePreviewContent」**各自**
 * 钉住了，但真机里它们之间还夹着 `innerHTML` + C3/C4 包裹，且**顺序**固定为：
 *
 *   worker HTML → sanitizeHtml → innerHTML →
 *   enhancePreviewContent({ lineNumbers: true })   ← C3 先包 .preview-codeblock、
 *                                                     C4 再包 .preview-table-wrap、
 *                                                     R4 落 data-line-no
 *   → mountMermaidBlocks                           ← 把 mermaid 围栏 <pre> 换成 .preview-mermaid
 *   → applyPreviewLineNumbers（**挂载后**再落一次，见 PreviewPane 的 mermaid effect）
 *
 * ⚠️ 最后一步（挂载后再落号）是 2026-09-19 起新增的**真机真实顺序**：mermaid 容器是
 * mount 时才新建的宿主，容器取而代之成为该块的锚点 —— 若只在 mount 前落号，容器拿不到号、
 * 被搬进容器的源码 pre 还会残留旧号。前 9 组要么没走 mount、要么手工拼的 DOM 与 worker
 * 真实产物不同构，故这条缝是唯一能一次性验证四类块终态的形态。
 */
describe('R4 ⑩ 端到端接缝：真机顺序下 mermaid 容器有号、普通块有号、代码块有号', () => {
  /**
   * 驱动**真实 worker** 渲染 Markdown（与预览共用同一渲染函数），返回 RENDER_DONE 产物。
   * 复用本文件顶部的 `workerHost`（与 ⑨ 的 exportHtml 同手法，不跨文件 import helper）。
   * @param src Markdown 源码
   * @returns worker 的 RENDER_DONE 产物 HTML
   */
  async function renderMarkdown(src: string): Promise<string> {
    const posted: PostedMessage[] = [];
    const original = workerHost.postMessage;
    workerHost.postMessage = (message: PostedMessage) => {
      posted.push(message);
    };
    try {
      await workerHost.onmessage?.({
        data: { type: 'RENDER', payload: src },
      } as unknown as MessageEvent);
    } finally {
      workerHost.postMessage = original;
    }
    const done = posted.find((message) => message.type === 'RENDER_DONE');
    if (!done || typeof done.html !== 'string') {
      throw new Error(`worker 没有回 RENDER_DONE：${JSON.stringify(posted)}`);
    }
    return done.html;
  }

  // 含 mermaid 围栏（fenceStartLine = 2）、普通段落、表格、代码块，覆盖四类形态
  const MD =
    '# Title\n\n' +
    '```mermaid\nflowchart LR\n  A --> B\n```\n\n' +
    'para\n\n' +
    '| a | b |\n| - | - |\n| 1 | 2 |\n\n' +
    '```js\nconst a = 1\n```\n';

  it('走完整真机链：mermaid 容器有号、普通块有号、代码块有号、容器内源码 pre 被清号', async () => {
    const html = await renderMarkdown(MD);

    // ① 真机 DOM 处理链：sanitize → innerHTML → C3/C4 包裹 + R4 落号（mount 之前）
    const root = document.createElement('div');
    root.className = 'preview-content';
    root.innerHTML = sanitizeHtml(html);
    enhancePreviewContent(root, { lineNumbers: true });
    // 前置：确认确实进了「C3 已包裹」的真机形态（这条用例的判别点之一）
    expect(root.querySelector('.preview-codeblock pre')).not.toBeNull();

    // ② 挂载（同步部分即完成容器构建 + 锚点搬运）
    const count = mountMermaidBlocks(root, {
      markdown: MD,
      theme: 'light',
      enabled: true,
      onZoom: () => {},
    });
    expect(count).toBe(1);

    // ③ ⚠️ 复刻 PreviewPane 的 mermaid effect：挂载**之后**再落一次号
    //    （容器是 mount 时才新建的宿主）。缺了这步就测不到真机终态。
    applyPreviewLineNumbers(root, true);

    // ④ mermaid 容器**显示**行号（容器本体现为块锚点）；容器内源码 pre 号被清（一块一号）
    const host = root.querySelector(`.${MERMAID_HOST_CLASS}`) as HTMLElement | null;
    expect(host).not.toBeNull();
    expect(host!.getAttribute(LINE_NO)).not.toBeNull();
    // R2/R3 的定位锚点必须**原样还在**（R4 绝不误伤 data-source-line）
    expect(host!.getAttribute(SOURCE_LINE)).not.toBeNull();
    const hostSourcePre = host!.querySelector('pre');
    expect(hostSourcePre).not.toBeNull();
    expect(hostSourcePre!.getAttribute(LINE_NO)).toBeNull();

    // ⑤ 普通块（标题 / 段落）拿到了行号
    const h1 = root.querySelector('h1');
    expect(h1).not.toBeNull();
    expect(h1!.getAttribute(LINE_NO)).not.toBeNull();
    const para = root.querySelector('p');
    expect(para).not.toBeNull();
    expect(para!.getAttribute(LINE_NO)).not.toBeNull();

    // ⑥ 表格：号画在 C4 包裹层上，`<table>` 上拿不到（第 10 条）
    const wrap = root.querySelector('.preview-table-wrap');
    expect(wrap).not.toBeNull();
    expect(wrap!.getAttribute(LINE_NO)).not.toBeNull();
    expect(root.querySelector('table')!.getAttribute(LINE_NO)).toBeNull();

    // ⑦ 代码块显示行号（第 4 条作废后）—— 号在**包裹层**上（第三轮反馈改宿主）；
    // 同时端到端证明 worker 的 data-lang 穿过 sanitize
    const jsPre = root.querySelector('pre[data-lang="js"]') as HTMLElement | null;
    expect(jsPre).not.toBeNull();
    const jsWrap = jsPre!.closest('.preview-codeblock') as HTMLElement | null;
    expect(jsWrap).not.toBeNull();
    expect(jsWrap!.getAttribute(LINE_NO)).not.toBeNull();
    // 类型条随之出现，语言标签 = js（字面量）
    const jsKind = jsPre!.closest('.preview-codeblock')?.querySelector('.preview-block-kind');
    expect(jsKind?.textContent).toBe('js');
  });

  it('判别力：关掉 lineNumbers 后一个号都没有（区分「真落号」与「碰巧断言为真」）', async () => {
    const html = await renderMarkdown(MD);
    const root = document.createElement('div');
    root.className = 'preview-content';
    root.innerHTML = sanitizeHtml(html);
    enhancePreviewContent(root, { lineNumbers: false });
    mountMermaidBlocks(root, { markdown: MD, theme: 'light', enabled: true, onZoom: () => {} });
    applyPreviewLineNumbers(root, false);

    expect(root.querySelectorAll(`[${LINE_NO}]`).length).toBe(0);
    // 反向确认锚点仍在（「没有号」不是因为整份文档没锚点）
    expect(root.querySelector(`[${SOURCE_LINE}]`)).not.toBeNull();
  });
});
