/**
 * md-worker 行锚点档位测试（R3 生产者侧 / v0.5.0）
 *
 * 为什么要有这个文件：**`nesting === 0` 那处改动有过一次静默退化的陷阱**。
 *
 * `inline` token 也是 `nesting === 0` 且有 map。如果把条件写成
 * `nesting === 1 || nesting === 0 || type.endsWith('_open')`，
 * `inline` 会先撞进「块级开标签」分支并 `continue`，分支②（B 档行级 span）
 * **永远执行不到** —— 而根标记仍旧写着 `data-line-anchor="row"`。
 * 表现是：B 档看起来在工作，实际一个 `data-line-row` 都不打，
 * 消费侧静默退化成 A 档精度。本机探针已复现。
 *
 * 因此这里用**真实的 worker 渲染产物**做断言（不是另写一份逻辑来模拟）：
 * - B 档必须真的有 `data-line-row`（且数量 > 0）；
 * - A 档必须**一个都没有**；
 * - 两档都要有块属性，且围栏代码块 `<pre>` 上必须带 `data-source-line`
 *   （markdown-it 的 fence renderer 在 highlight 返回 `<pre…>` 时会丢 attrs，
 *   本轮为此接管了 fence 渲染规则）。
 */

import { describe, it, expect, beforeAll } from 'vitest';

// 需要在 **导入 worker 之前** 说明：worker 模块在顶层执行
// `self.onmessage = …`，jsdom 环境下 `self === window`，赋值与调用都成立。
// 下面用 `postMessage` 接管回包来驱动它。
import '../md-worker';

/** worker 回包形态（只关心 RENDER_DONE / ERROR） */
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
 * 驱动 worker 渲染一段 Markdown，返回产物 HTML。
 * @param src Markdown 源码
 * @returns 渲染结果 HTML
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

/** 统计 HTML 中某个子串出现次数 */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * B 档用的小样例（源码远小于 256KB）。
 *
 * 行号（0-based）：
 * 0 `# Title` / 1 空 / 2 段落 / 3 空 / 4 ```` ```js ```` / 5 代码 /
 * 6 代码 / 7 ```` ``` ```` / 8 空 / 9 `---` / 10 空 / 11 `End.`
 */
const SMALL_SRC = [
  '# Title',
  '',
  'Paragraph text.',
  '',
  '```js',
  'const a = 1;',
  'console.log(a);',
  '```',
  '',
  '---',
  '',
  'End.',
].join('\n');

/** A 档用的大样例：源码 UTF-8 字节数 > 256KB */
const BIG_SRC = Array.from({ length: 12_000 }, (_unused, index) => `line ${index} 中文填充内容`).join('\n');

beforeAll(() => {
  // 断言前置：确认样例真的跨过了档位阈值。
  // ⚠️ 阈值判的是 **UTF-8 字节数**，不是 `.length` —— 中文 1 字 3 字节，
  // 光看长度会误判档位（QA 用 `new Blob([src]).size` 复核，同一口径）。
  const byteLength = (value: string): number => new TextEncoder().encode(value).length;
  expect(byteLength(BIG_SRC)).toBeGreaterThan(256 * 1024);
  expect(byteLength(SMALL_SRC)).toBeLessThan(256 * 1024);
});

describe('md-worker 行锚点档位（R3 生产者侧）', () => {
  it('B 档：根标记为 row，且真的打出了行级 span', async () => {
    const html = await renderMarkdown(SMALL_SRC);

    expect(html).toContain('data-line-anchor="row"');
    // ⚠️ 判别点：如果 nesting===0 没排除 inline，这里会是 0（静默退化）
    expect(countOf(html, 'data-line-row=')).toBeGreaterThan(0);
  });

  it('B 档：围栏代码块拿到源行锚点（fence renderer 已保留 attrs）', async () => {
    const html = await renderMarkdown(SMALL_SRC);

    // 围栏从第 4 行开始（0-based），到 ```` ``` ```` 收尾（第 8 行，不含）
    expect(html).toContain('data-source-line="4"');
    expect(html).toContain('data-source-line-end="8"');
    // 锚点必须落在 <pre> 上，而不是被 highlight 的返回值整个丢掉
    const pre = html.match(/<pre[^>]*>/);
    expect(pre).not.toBeNull();
    expect(pre![0]).toContain('data-source-line="4"');
    // 输出形态保持不变，避免 hljs 主题失效
    expect(pre![0]).toContain('class="hljs"');
  });

  it('B 档：分隔线（hr）也拿到源行锚点', async () => {
    const html = await renderMarkdown(SMALL_SRC);
    const hr = html.match(/<hr[^>]*>/);
    expect(hr).not.toBeNull();
    expect(hr![0]).toContain('data-source-line="9"');
  });

  it('A 档：根标记为 block，一个行级 span 都不打（零 DOM 膨胀）', async () => {
    const html = await renderMarkdown(BIG_SRC);

    expect(html).toContain('data-line-anchor="block"');
    expect(countOf(html, 'data-line-row=')).toBe(0);
    // 但块属性必须还在，否则消费侧无从插值
    expect(countOf(html, 'data-source-line=')).toBeGreaterThan(0);
  });

  it('A 档：多行块仍然带 data-source-line-end（块内插值的前提）', async () => {
    const html = await renderMarkdown(BIG_SRC);
    expect(countOf(html, 'data-source-line-end=')).toBeGreaterThan(0);
  });
});

/**
 * md-worker 代码块语言类型（Fix 7 · `data-lang` 生产者侧）
 *
 * 为什么锁在这里：「worker 到底产了什么」本迭代已被问过三次（锚点 → 行号 → data-lang），
 * 每次都要翻产物猜；而 Fix 7 的顶部类型条**完全依赖** `<pre data-lang="…">` ——
 * 一旦 worker 侧不再输出，预览只会静默显示 `text`（无报错、无异常），
 * 极难在真机上发现。故必须用**真 worker 产物**把这张契约钉死。
 */
describe('md-worker 代码块语言类型（Fix 7 · data-lang）', () => {
  /** 取产物中第一个 `<pre …>` 开标签 */
  const firstPre = (html: string): string => {
    const match = html.match(/<pre[^>]*>/);
    expect(match).not.toBeNull();
    return match![0];
  };

  it('围栏语言写到 <pre>：```js → data-lang="js"（且与 data-source-line 锚点共存）', async () => {
    const html = await renderMarkdown(['```js', 'const a = 1;', '```'].join('\n'));
    const pre = firstPre(html);
    expect(pre).toContain('data-lang="js"');
    // 锚点与语言属性必须在同一个 <pre> 上（fence renderer 保留了 token.attrs）
    expect(pre).toContain('data-source-line=');
  });

  it('```mermaid → data-lang="mermaid"（预览据它决定是否建图容器）', async () => {
    const html = await renderMarkdown(['```mermaid', 'flowchart LR', '  A --> B', '```'].join('\n'));
    expect(firstPre(html)).toContain('data-lang="mermaid"');
  });

  it('无信息围栏（``` 后无语言）→ <pre> 完全不带 data-lang', async () => {
    const html = await renderMarkdown(['```', 'plain text', '```'].join('\n'));
    expect(firstPre(html)).not.toContain('data-lang');
  });

  it('缩进代码块（无 info）→ <pre> 完全不带 data-lang', async () => {
    const html = await renderMarkdown(['    indented = true', '    second line'].join('\n'));
    expect(firstPre(html)).not.toContain('data-lang');
  });

  it('围栏带附加信息 → 只取首个词：```js title="demo.js" → data-lang="js"', async () => {
    const html = await renderMarkdown(['```js title="demo.js"', 'const a = 1;', '```'].join('\n'));
    expect(firstPre(html)).toContain('data-lang="js"');
  });

  it('语言值经转义（防属性注入）：```a"b<c → data-lang="a&quot;b&lt;c"', async () => {
    const html = await renderMarkdown(['```a"b<c', 'x', '```'].join('\n'));
    expect(firstPre(html)).toContain('data-lang="a&quot;b&lt;c"');
  });
});
