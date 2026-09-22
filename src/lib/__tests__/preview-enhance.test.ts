/**
 * preview-enhance.ts 单元测试（C3 / C4 / C5）
 *
 * 验证预览区 DOM 增强的三项能力：
 * - C3：代码块包裹 + 复制按钮插入 + 待复制文本提取 + 剪贴板降级链
 * - C4：表格滚动包裹层 + 源行锚点属性搬运
 * - C5：锚点目标查找（显式 id / name / 标题 slug，含中文）+ 点击事件归属
 *
 * 说明：`.preview-content` 的 DOM 由 PreviewPane 用 innerHTML 重建，
 * 逐块绑定监听会丢失，因此交互统一走 `handlePreviewClick` 委托 ——
 * 本文件对「哪些点击被消费、哪些放行」做了显式断言，防止 C5/C3 与
 * 后续批次 B 的 R2「点击预览跳编辑器」互相抢事件。
 *
 * ⚠️ 关于全量基线（2026-09-19 实测，QA 严过关）
 * 本迭代验收基线：**125 条用例 / 113 通过 / 12 失败**。
 * 那 12 条失败**与本迭代（预览增强 桌面 0.5.0 / 插件 0.3.0）无关**，是历史遗留：
 *   - `fileSystem.test.ts` ×6：jsdom 未实现 `URL.createObjectURL`（5 条）
 *     + `generateFileId` 唯一性断言自相矛盾（1 条）
 *   - `indexeddb.test.ts` ×6：handles CRUD 4 条 + integration 2 条，
 *     测试数据把 vitest mock 函数当 FileSystemFileHandle 存，
 *     fake-indexeddb@6 的结构化克隆直接拒绝（DataCloneError）
 * 判定口径：**不得比基线更差**（通过数不降、失败数不升）。
 * 修这 12 条不在本轮范围，别把它们误判成回归。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CODE_BLOCK_CLASS,
  COPY_BTN_CLASS,
  TABLE_WRAP_CLASS,
  enhanceCodeBlocks,
  enhanceTables,
  enhancePreviewContent,
  getCodeBlockText,
  findAnchorTarget,
  scrollToAnchor,
  writeToClipboard,
  handlePreviewClick,
  readLineAnchorMode,
  resolvePreviewLineTarget,
  resolveClickSourceLine,
  scrollPreviewToLine,
} from '../preview-enhance';
import { resetNavBridge } from '../nav-bridge';

// ──────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────

/**
 * 建一个**游离**（未插入 document）的临时预览容器。
 *
 * 刻意不挂进 document.body：jsdom 对 `<a href="https://…">` 的 click
 * 会尝试导航并抛 "Not implemented: navigation" 噪音；游离节点上的
 * dispatchEvent 行为一致但不会触发导航副作用。
 */
function makeRoot(html: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'preview-content';
  root.innerHTML = html;
  return root;
}

/**
 * 造一个**已派发**的 click 事件。
 *
 * 必须真的 dispatch：未派发的 MouseEvent 其 `target` 是 null，
 * `handlePreviewClick` 里的 `target.closest(...)` 会直接短路返回 false，
 * 断言会假通过。派发后 `event.target` 才指向被点击的元素。
 */
function dispatchClick(el: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

/**
 * 抑制 jsdom 对 `<a href>` 的导航尝试。
 *
 * jsdom 不实现导航，外链 click 会往 stderr 打 "Not implemented: navigation"。
 * 这里由**测试自己**调 preventDefault（在 handler 之外），既消掉噪音，
 * 又不影响断言 —— `vi.spyOn` 是在 dispatch **之后**装的，看不到这次调用。
 */
function suppressNavigation(el: Element): void {
  el.addEventListener('click', (e) => e.preventDefault());
}

/** 替换 navigator.clipboard（jsdom 默认不提供） */
function setClipboard(writeText: ((text: string) => Promise<void>) | undefined): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
    writable: true,
  });
}

/** 替换 document.execCommand（jsdom 默认不提供，实现里用作降级兜底） */
function setExecCommand(result: boolean | undefined): void {
  const doc = document as unknown as Record<string, unknown>;
  if (result === undefined) {
    delete doc.execCommand;
  } else {
    doc.execCommand = vi.fn(() => result);
  }
}

/**
 * 造一个**可滚动**的容器（`.preview-pane`）。
 *
 * jsdom 不做布局，`getBoundingClientRect()` 全是 0，R3 的 nearest 判定需要
 * 自己喂几何值，见 `stubRect`。
 */
function makeScroller(): HTMLElement {
  const scroller = document.createElement('div');
  scroller.className = 'preview-pane';
  scroller.scrollTo = vi.fn();
  return scroller;
}

/**
 * 给元素喂一个几何矩形（jsdom 不做布局，只能手动喂）。
 * @param el 元素
 * @param top 顶部纵坐标
 * @param height 高度
 */
function stubRect(el: HTMLElement, top: number, height: number): void {
  el.getBoundingClientRect = () => ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetNavBridge();
  // jsdom 不实现 scrollIntoView，C5 的滚动断言需要它存在
  Element.prototype.scrollIntoView = vi.fn();
  setClipboard(undefined);
  setExecCommand(undefined);
});

afterEach(() => {
  document.body.innerHTML = '';
  resetNavBridge();
  setClipboard(undefined);
  setExecCommand(undefined);
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────
// C3：代码块包裹
// ──────────────────────────────────────────────

describe('C3 enhanceCodeBlocks', () => {
  it('wraps every pre and injects a copy button', () => {
    const root = makeRoot('<pre><code>const a = 1;</code></pre>');
    enhanceCodeBlocks(root);

    const wrappers = root.querySelectorAll(`.${CODE_BLOCK_CLASS}`);
    expect(wrappers).toHaveLength(1);
    // pre 真的被搬进包裹层
    expect(wrappers[0].querySelector('pre')).not.toBeNull();

    const btn = wrappers[0].querySelector(`.${COPY_BTN_CLASS}`);
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Copy');
    expect(btn!.getAttribute('aria-label')).toBe('Copy code');
    expect((btn as HTMLButtonElement).type).toBe('button');
  });

  it('injects a top bar: kind label on the left, copy button inside actions (Fix 7)', () => {
    const root = makeRoot('<pre data-lang="ts"><code>x</code></pre>');
    enhanceCodeBlocks(root);

    const wrap = root.querySelector(`.${CODE_BLOCK_CLASS}`)!;
    const bar = wrap.querySelector('.preview-block-bar')!;
    expect(bar).not.toBeNull();
    expect(bar.querySelector('.preview-block-kind')!.textContent).toBe('ts');
    const actions = bar.querySelector('.preview-block-actions')!;
    // 复制按钮位于「操作区」内（不再直接挂包裹层右上角）
    const btn = actions.querySelector(`.${COPY_BTN_CLASS}`);
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Copy');
  });

  it('bar kind falls back to "text" when the fence has no info string', () => {
    const root = makeRoot('<pre><code>x</code></pre>');
    enhanceCodeBlocks(root);
    expect(root.querySelector('.preview-block-kind')!.textContent).toBe('text');
  });

  it('is idempotent — a second pass does not double-wrap', () => {
    const root = makeRoot('<pre><code>x</code></pre>');
    enhanceCodeBlocks(root);
    enhanceCodeBlocks(root);

    expect(root.querySelectorAll(`.${CODE_BLOCK_CLASS}`)).toHaveLength(1);
    expect(root.querySelectorAll(`.${COPY_BTN_CLASS}`)).toHaveLength(1);
  });

  it('wraps multiple code blocks independently', () => {
    const root = makeRoot('<pre><code>a</code></pre><p>mid</p><pre><code>b</code></pre>');
    enhanceCodeBlocks(root);
    expect(root.querySelectorAll(`.${CODE_BLOCK_CLASS}`)).toHaveLength(2);
  });
});

describe('C3 getCodeBlockText', () => {
  it('strips leading and trailing blank lines only', () => {
    const pre = document.createElement('pre');
    pre.textContent = '\n\nline1\nline2\n\n';
    expect(getCodeBlockText(pre)).toBe('line1\nline2');
  });

  it('keeps inner indentation and trailing spaces (no trim)', () => {
    const pre = document.createElement('pre');
    pre.textContent = '  indented  ';
    expect(getCodeBlockText(pre)).toBe('  indented  ');
  });

  it('returns empty string for an empty code block', () => {
    const pre = document.createElement('pre');
    pre.textContent = '';
    expect(getCodeBlockText(pre)).toBe('');
  });

  it('returns empty string for a whitespace-only block', () => {
    const pre = document.createElement('pre');
    pre.textContent = '\n\n';
    expect(getCodeBlockText(pre)).toBe('');
  });
});

// ──────────────────────────────────────────────
// C3：剪贴板
// ──────────────────────────────────────────────

describe('C3 writeToClipboard', () => {
  it('uses navigator.clipboard when available', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard(writeText);

    const ok = await writeToClipboard('hello');
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when clipboard rejects', async () => {
    setClipboard(() => Promise.reject(new Error('NotAllowedError')));
    setExecCommand(true);

    const ok = await writeToClipboard('hello');
    expect(ok).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  it('falls back to execCommand when clipboard is unavailable', async () => {
    setClipboard(undefined);
    setExecCommand(true);

    expect(await writeToClipboard('hello')).toBe(true);
  });

  it('returns false when both paths fail', async () => {
    setClipboard(() => Promise.reject(new Error('nope')));
    setExecCommand(false);

    expect(await writeToClipboard('hello')).toBe(false);
  });

  it('returns false when execCommand throws (jsdom default)', async () => {
    setClipboard(undefined);
    setExecCommand(undefined); // document.execCommand 不存在 → 抛 TypeError，被兜底捕获

    expect(await writeToClipboard('hello')).toBe(false);
  });
});

// ──────────────────────────────────────────────
// C4：表格包裹
// ──────────────────────────────────────────────

describe('C4 enhanceTables', () => {
  it('wraps every table in a scroll container', () => {
    const root = makeRoot('<table><tr><td>a</td></tr></table>');
    enhanceTables(root);

    const wraps = root.querySelectorAll(`.${TABLE_WRAP_CLASS}`);
    expect(wraps).toHaveLength(1);
    expect(wraps[0].querySelector('table')).not.toBeNull();
  });

  it('moves data-source-line from the table to the wrapper', () => {
    const root = makeRoot('<table data-source-line="42"><tr><td>a</td></tr></table>');
    enhanceTables(root);

    const wrap = root.querySelector(`.${TABLE_WRAP_CLASS}`) as HTMLElement;
    const table = root.querySelector('table') as HTMLElement;
    expect(wrap.getAttribute('data-source-line')).toBe('42');
    // 搬走而不是复制：避免 R2/R3 按 [data-source-line] 查找时命中两个元素
    expect(table.hasAttribute('data-source-line')).toBe(false);
  });

  it('is idempotent — a second pass does not double-wrap', () => {
    const root = makeRoot('<table><tr><td>a</td></tr></table>');
    enhanceTables(root);
    enhanceTables(root);

    expect(root.querySelectorAll(`.${TABLE_WRAP_CLASS}`)).toHaveLength(1);
  });

  it('wraps nested tables (inside blockquote / li) as well', () => {
    const root = makeRoot('<blockquote><table><tr><td>a</td></tr></table></blockquote>');
    enhanceTables(root);

    expect(root.querySelectorAll(`.${TABLE_WRAP_CLASS}`)).toHaveLength(1);
  });
});

describe('C3/C4 enhancePreviewContent', () => {
  it('enhances tables and code blocks in one pass', () => {
    const root = makeRoot('<table><tr><td>a</td></tr></table><pre><code>x</code></pre>');
    enhancePreviewContent(root);

    expect(root.querySelectorAll(`.${TABLE_WRAP_CLASS}`)).toHaveLength(1);
    expect(root.querySelectorAll(`.${CODE_BLOCK_CLASS}`)).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────
// C5：锚点查找
// ──────────────────────────────────────────────

describe('C5 findAnchorTarget', () => {
  it('matches an explicit id', () => {
    const root = makeRoot('<h2 id="some-heading">Some Heading</h2>');
    expect(findAnchorTarget(root, 'some-heading')).toBe(root.querySelector('h2'));
  });

  it('matches an <a name> anchor', () => {
    const root = makeRoot('<a name="top"></a><p>body</p>');
    expect(findAnchorTarget(root, 'top')).toBe(root.querySelector('a'));
  });

  it('falls back to heading slug (english, punctuation stripped)', () => {
    const root = makeRoot('<h2>Install MDnote (macOS)</h2>');
    expect(findAnchorTarget(root, 'install-mdnote-macos')).toBe(root.querySelector('h2'));
  });

  it('falls back to heading slug (chinese, unencoded href)', () => {
    const root = makeRoot('<h2>使用说明</h2>');
    expect(findAnchorTarget(root, '使用说明')).toBe(root.querySelector('h2'));
  });

  it('falls back to heading slug (chinese, percent-encoded href)', () => {
    // markdown-it 对中文锚点的实际输出形态
    const root = makeRoot('<h2>使用说明</h2>');
    const encoded = encodeURIComponent('使用说明');
    expect(encoded).toBe('%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E');
    expect(findAnchorTarget(root, encoded)).toBe(root.querySelector('h2'));
  });

  it('falls back to heading slug (mixed chinese + english)', () => {
    const root = makeRoot('<h3>安装 MDnote 并配置</h3>');
    expect(findAnchorTarget(root, '安装-mdnote-并配置')).toBe(root.querySelector('h3'));
  });

  it('returns null when nothing matches', () => {
    const root = makeRoot('<h2>Real Heading</h2>');
    expect(findAnchorTarget(root, 'nope')).toBeNull();
  });

  it('does not throw on a malformed percent sequence', () => {
    const root = makeRoot('<h2>Heading</h2>');
    expect(() => findAnchorTarget(root, '%E4%BD')).not.toThrow();
    expect(findAnchorTarget(root, '%E4%BD')).toBeNull();
  });

  it('is case-insensitive', () => {
    const root = makeRoot('<h2 id="Some-Heading">x</h2>');
    expect(findAnchorTarget(root, 'some-heading')).toBe(root.querySelector('h2'));
  });
});

describe('C5 scrollToAnchor', () => {
  it('scrolls to the target and applies the 600ms flash class', () => {
    const root = makeRoot('<h2 id="target">Target</h2>');
    const heading = root.querySelector('h2') as HTMLElement;

    scrollToAnchor(root, 'target');

    expect(heading.classList.contains('sync-highlight')).toBe(true);
    expect(heading.scrollIntoView).toHaveBeenCalled();
  });

  it('does nothing when the target is missing (no scroll, no flash, no crash)', () => {
    // QA A15 判据第 5 条：未命中时必须是「什么都不发生」——
    // 不滚（更不能滚到顶部）、不闪、不抛异常。
    const root = makeRoot('<h2>Other</h2>');
    const heading = root.querySelector('h2') as HTMLElement;

    expect(() => scrollToAnchor(root, 'missing')).not.toThrow();
    expect(heading.classList.contains('sync-highlight')).toBe(false);
    expect(heading.scrollIntoView).not.toHaveBeenCalled();
  });

  it('keeps a full 600ms flash when the same anchor is clicked twice', () => {
    // QA A15 判据第 2 条：闪一次、约 600ms 后自动消失。
    // 连续点击时，第一次的 timer 不能提前摘掉第二次的 class。
    vi.useFakeTimers();
    try {
      const root = makeRoot('<h2 id="target">Target</h2>');
      const heading = root.querySelector('h2') as HTMLElement;

      scrollToAnchor(root, 'target'); // t=0：第一次点击，timer 定在 t=600
      vi.advanceTimersByTime(300);
      scrollToAnchor(root, 'target'); // t=300：第二次点击，timer 应重排到 t=900

      // t=750：距第二次 450ms，仍应亮着。
      // 这一条是**判别点** —— 若前一次的 timer 没被清掉，它会在 t=600 就把 class
      // 摘掉（第二次只剩 300ms），此处就会拿到 false。
      vi.advanceTimersByTime(450);
      expect(heading.classList.contains('sync-highlight')).toBe(true);

      // t=901：越过第二次的 600ms，应已自动熄灭（不长亮）
      vi.advanceTimersByTime(151);
      expect(heading.classList.contains('sync-highlight')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hits the same element for a chinese heading and its slug anchor', () => {
    // QA A15 判据第 4 条：`#使用说明` 必须命中 `## 使用说明` 那个 h2 本身
    const root = makeRoot('<h1>标题</h1><h2>使用说明</h2><h2>其它</h2>');
    const target = root.querySelectorAll('h2')[0] as HTMLElement;
    const other = root.querySelectorAll('h2')[1] as HTMLElement;

    const hit = findAnchorTarget(root, '使用说明');
    expect(hit).toBe(target);
    expect(hit).not.toBe(other);
    expect(hit).not.toBe(root.querySelector('h1'));
  });
});

// ──────────────────────────────────────────────
// 事件归属：C3/C5 消费，其余放行（与批次 B 的 R2 隔离）
// ──────────────────────────────────────────────

describe('handlePreviewClick event ownership', () => {
  it('consumes a copy-button click and stops propagation', () => {
    const root = makeRoot('<pre><code>x</code></pre>');
    enhanceCodeBlocks(root);
    const btn = root.querySelector(`.${COPY_BTN_CLASS}`) as HTMLElement;

    const event = dispatchClick(btn);
    const preventDefault = vi.spyOn(event, 'preventDefault');
    const stopPropagation = vi.spyOn(event, 'stopPropagation');

    expect(handlePreviewClick(event, root)).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('consumes an in-page anchor click and stops propagation', () => {
    const root = makeRoot('<a href="#some-heading">jump</a><h2 id="some-heading">H</h2>');
    const link = root.querySelector('a') as HTMLElement;

    const event = dispatchClick(link);
    const preventDefault = vi.spyOn(event, 'preventDefault');
    const stopPropagation = vi.spyOn(event, 'stopPropagation');

    expect(handlePreviewClick(event, root)).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('does NOT intercept external links', () => {
    const root = makeRoot('<a href="https://example.com">out</a>');
    const link = root.querySelector('a') as HTMLElement;
    suppressNavigation(link);

    const event = dispatchClick(link);
    const preventDefault = vi.spyOn(event, 'preventDefault');

    expect(handlePreviewClick(event, root)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('does NOT intercept mailto / other protocols', () => {
    const root = makeRoot('<a href="mailto:a@b.com">mail</a>');
    const link = root.querySelector('a') as HTMLElement;
    suppressNavigation(link);

    const event = dispatchClick(link);
    expect(handlePreviewClick(event, root)).toBe(false);
  });

  it('still swallows a bare "#" link (no hash change, no crash)', () => {
    const root = makeRoot('<a href="#">top</a>');
    const link = root.querySelector('a') as HTMLElement;

    const event = dispatchClick(link);
    const preventDefault = vi.spyOn(event, 'preventDefault');

    expect(handlePreviewClick(event, root)).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
  });

  it('does NOT consume clicks on ordinary elements', () => {
    const root = makeRoot('<p>plain text</p>');
    const p = root.querySelector('p') as HTMLElement;

    const event = dispatchClick(p);
    const preventDefault = vi.spyOn(event, 'preventDefault');
    const stopPropagation = vi.spyOn(event, 'stopPropagation');

    expect(handlePreviewClick(event, root)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// R3 消费侧：源行 → 预览 DOM 目标点
// ──────────────────────────────────────────────

describe('R3 readLineAnchorMode', () => {
  it('reads the root marker', () => {
    expect(readLineAnchorMode(makeRoot('<p data-line-anchor="row">x</p>'))).toBe('row');
    expect(readLineAnchorMode(makeRoot('<p data-line-anchor="block">x</p>'))).toBe('block');
  });

  it('returns null when nothing has been rendered yet', () => {
    expect(readLineAnchorMode(makeRoot('<p>x</p>'))).toBeNull();
  });
});

describe('R3 resolvePreviewLineTarget', () => {
  it('B 档：行级 span 精确命中', () => {
    const root = makeRoot(
      '<div data-line-anchor="row">'
      + '<p data-source-line="2"><span data-line-row="2">a</span></p>'
      + '<p data-source-line="7"><span data-line-row="7">b</span></p>'
      + '</div>',
    );

    const target = resolvePreviewLineTarget(root, 7);
    expect(target).not.toBeNull();
    expect(target!.el.getAttribute('data-line-row')).toBe('7');
    // 行级命中不需要块内插值
    expect(target!.ratio).toBe(0);
  });

  it('B 档：没有精确行时回退到最近的前一个行级 span', () => {
    const root = makeRoot(
      '<div data-line-anchor="row">'
      + '<p data-source-line="2"><span data-line-row="2">a</span></p>'
      + '<p data-source-line="7"><span data-line-row="7">b</span></p>'
      + '</div>',
    );

    const target = resolvePreviewLineTarget(root, 5);
    expect(target!.el.getAttribute('data-line-row')).toBe('2');
  });

  it('A 档：只有块属性时在块内插值（比例 = (line-start)/(end-start)）', () => {
    const root = makeRoot(
      '<div data-line-anchor="block">'
      + '<p data-source-line="0" data-source-line-end="10">x</p>'
      + '<p data-source-line="10" data-source-line-end="20">y</p>'
      + '</div>',
    );

    const target = resolvePreviewLineTarget(root, 5);
    expect(target!.el.getAttribute('data-source-line')).toBe('0');
    expect(target!.ratio).toBeCloseTo(0.5);

    // 下一块的起始行优先（start ≤ line 里 start 最大的那个）
    const second = resolvePreviewLineTarget(root, 10);
    expect(second!.el.getAttribute('data-source-line')).toBe('10');
    expect(second!.ratio).toBe(0);
  });

  it('A 档：读不到 data-source-line-end 时按 start+1 兜底，比例为 0', () => {
    // worker 端契约：单行块不打 end 属性，下游按 start+1 处理
    const root = makeRoot('<div data-line-anchor="block"><p data-source-line="3">x</p></div>');

    const target = resolvePreviewLineTarget(root, 5);
    expect(target!.el.getAttribute('data-source-line')).toBe('3');
    expect(target!.ratio).toBe(0);
  });

  it('returns null when there is no anchor at all (no scroll, no crash)', () => {
    const root = makeRoot('<p>plain</p>');
    expect(resolvePreviewLineTarget(root, 3)).toBeNull();
  });

  it('returns null for an out-of-range line instead of jumping to the top', () => {
    const root = makeRoot('<div data-line-anchor="block"><p data-source-line="10">x</p></div>');
    expect(resolvePreviewLineTarget(root, 2)).toBeNull();
  });
});

describe('R3 scrollPreviewToLine', () => {
  it('does NOT scroll when the target is already inside the viewport (within margin)', () => {
    // 滚动容器：视口 0–500；目标在 100，高度 50 → 完全可见
    const scroller = makeScroller();
    stubRect(scroller, 0, 500);
    const root = makeRoot('<div data-line-anchor="block"><p data-source-line="0">x</p></div>');
    const p = root.querySelector('p') as HTMLElement;
    stubRect(p, 100, 50);

    const hit = scrollPreviewToLine(root, scroller, 0);

    expect(hit).toBe(true);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    // 不滚也要闪，否则用户没有任何反馈
    expect(p.classList.contains('sync-highlight')).toBe(true);
  });

  it('scrolls to the VERTICAL CENTER when the target is below the viewport', () => {
    const scroller = makeScroller();
    stubRect(scroller, 0, 500); // 中点 = 250
    const root = makeRoot('<div data-line-anchor="block"><p data-source-line="0">x</p></div>');
    const p = root.querySelector('p') as HTMLElement;
    stubRect(p, 900, 50); // targetY = 900

    scrollPreviewToLine(root, scroller, 0);

    // delta = targetY - 视口中点 = 900 - 250 = 650
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 650, behavior: 'smooth' });
  });

  it('scrolls to the VERTICAL CENTER when the target is above the viewport', () => {
    const scroller = makeScroller();
    stubRect(scroller, 1000, 500); // 中点 = 1250
    const root = makeRoot('<div data-line-anchor="block"><p data-source-line="0">x</p></div>');
    const p = root.querySelector('p') as HTMLElement;
    stubRect(p, 200, 50); // targetY = 200

    scrollPreviewToLine(root, scroller, 0);

    // delta = 200 - 1250 = -1050
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: -1050, behavior: 'smooth' });
  });

  it('applies the in-block ratio to the centered offset (A 档块内插值)', () => {
    const scroller = makeScroller();
    stubRect(scroller, 0, 500); // 中点 = 250
    const root = makeRoot(
      '<div data-line-anchor="block"><p data-source-line="0" data-source-line-end="10">x</p></div>',
    );
    const p = root.querySelector('p') as HTMLElement;
    stubRect(p, 900, 200); // 目标点 = 900 + 0.5×200 = 1000

    scrollPreviewToLine(root, scroller, 5);

    // delta = 1000 - 250 = 750
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 750, behavior: 'smooth' });
  });

  it('aligns the block TOP (not center) when the block is taller than the viewport', () => {
    const scroller = makeScroller();
    stubRect(scroller, 0, 500);
    const root = makeRoot('<div data-line-anchor="block"><p data-source-line="0">x</p></div>');
    const p = root.querySelector('p') as HTMLElement;
    stubRect(p, 800, 900); // 块高 900 > 视口 500 → 居中没有意义

    scrollPreviewToLine(root, scroller, 0);

    // 对齐块首：delta = elRect.top - viewRect.top = 800 - 0 = 800
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 800, behavior: 'smooth' });
  });

  it('can skip the flash (find-replace 用)', () => {
    const scroller = makeScroller();
    stubRect(scroller, 0, 500);
    const root = makeRoot('<div data-line-anchor="block"><p data-source-line="0">x</p></div>');
    const p = root.querySelector('p') as HTMLElement;
    stubRect(p, 100, 50);

    scrollPreviewToLine(root, scroller, 0, { flash: false });

    expect(p.classList.contains('sync-highlight')).toBe(false);
  });

  it('returns false and does nothing when the line has no anchor', () => {
    const scroller = makeScroller();
    stubRect(scroller, 0, 500);
    const root = makeRoot('<p>plain</p>');

    expect(scrollPreviewToLine(root, scroller, 3)).toBe(false);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// R2：预览点击 → 源行 → 跳编辑器
// ──────────────────────────────────────────────

describe('R2 resolveClickSourceLine', () => {
  it('reads the row anchor in B 档 (pixel-precise)', () => {
    const root = makeRoot(
      '<div data-line-anchor="row"><p data-source-line="4"><span data-line-row="4">t</span></p></div>',
    );
    const span = root.querySelector('span') as HTMLElement;

    const event = dispatchClick(span);
    expect(resolveClickSourceLine(event, root)).toBe(4);
  });

  it('falls back to the block anchor when there is no row span (code block / A 档)', () => {
    const root = makeRoot(
      '<div data-line-anchor="row"><pre data-source-line="4"><code>t</code></pre></div>',
    );
    const pre = root.querySelector('pre') as HTMLElement;

    const event = dispatchClick(pre);
    expect(resolveClickSourceLine(event, root)).toBe(4);
  });

  it('interpolates inside a multi-line block by click position (A 档)', () => {
    const root = makeRoot(
      '<div data-line-anchor="block"><p data-source-line="10" data-source-line-end="20">t</p></div>',
    );
    const p = root.querySelector('p') as HTMLElement;
    stubRect(p, 100, 200);

    // 点在块正中 → 比例 0.5 → 第 15 行
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, clientY: 200 });
    p.dispatchEvent(event);

    expect(resolveClickSourceLine(event, root)).toBe(15);
  });

  it('clamps the interpolated line inside the block range', () => {
    const root = makeRoot(
      '<div data-line-anchor="block"><p data-source-line="10" data-source-line-end="14">t</p></div>',
    );
    const p = root.querySelector('p') as HTMLElement;
    stubRect(p, 0, 100);

    const beyond = new MouseEvent('click', { bubbles: true, cancelable: true, clientY: 9999 });
    p.dispatchEvent(beyond);
    // 末行是 end-1 = 13，不会溢出到下一块
    expect(resolveClickSourceLine(beyond, root)).toBe(13);
  });

  it('returns null when the click has no anchor at all', () => {
    const root = makeRoot('<p>plain</p>');
    const event = dispatchClick(root.querySelector('p') as HTMLElement);
    expect(resolveClickSourceLine(event, root)).toBeNull();
  });
});

describe('R2 handlePreviewClick → editor:goto-line', () => {
  /** 监听 editor:goto-line，返回收到的行号数组 */
  function listenGotoLine(): number[] {
    const lines: number[] = [];
    window.addEventListener('editor:goto-line', (e: Event) => {
      lines.push((e as CustomEvent<{ line: number }>).detail.line);
    });
    return lines;
  }

  it('dispatches editor:goto-line with the nearest source line', () => {
    const lines = listenGotoLine();
    const root = makeRoot(
      '<div data-line-anchor="row"><p data-source-line="3"><span data-line-row="3">t</span></p></div>',
    );

    const event = dispatchClick(root.querySelector('span') as HTMLElement);
    const handled = handlePreviewClick(event, root);

    expect(handled).toBe(true);
    expect(lines).toEqual([3]);
  });

  it('does NOT stopPropagation — text selection and default behaviour survive', () => {
    const root = makeRoot(
      '<div data-line-anchor="row"><p data-source-line="3"><span data-line-row="3">t</span></p></div>',
    );
    const event = dispatchClick(root.querySelector('span') as HTMLElement);
    const preventDefault = vi.spyOn(event, 'preventDefault');
    const stopPropagation = vi.spyOn(event, 'stopPropagation');

    handlePreviewClick(event, root);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it('does NOT jump to the editor for external links / mailto', () => {
    const lines = listenGotoLine();
    const root = makeRoot(
      '<div data-line-anchor="row"><p data-source-line="1">'
      + '<a href="https://example.com">out</a>'
      + '<a href="mailto:a@b.com">mail</a>'
      + '</p></div>',
    );

    for (const link of Array.from(root.querySelectorAll('a'))) {
      suppressNavigation(link);
    }

    const external = dispatchClick(root.querySelectorAll('a')[0]);
    expect(handlePreviewClick(external, root)).toBe(false);
    const mailto = dispatchClick(root.querySelectorAll('a')[1]);
    expect(handlePreviewClick(mailto, root)).toBe(false);

    expect(lines).toEqual([]);
  });

  it('does nothing when the click has no source-line anchor', () => {
    const lines = listenGotoLine();
    const root = makeRoot('<p>plain text</p>');

    const event = dispatchClick(root.querySelector('p') as HTMLElement);
    expect(handlePreviewClick(event, root)).toBe(false);
    expect(lines).toEqual([]);
  });

  it('does NOT jump while the user is selecting text (selection would be lost)', () => {
    const lines = listenGotoLine();
    const root = makeRoot(
      '<div data-line-anchor="row"><p data-source-line="3"><span data-line-row="3">t</span></p></div>',
    );
    const span = root.querySelector('span') as HTMLElement;

    // 造一个未折叠的选区：拖选文字后 mouseup 也会派发 click。
    // ⚠️ jsdom 的 Selection 只认**已插入 document** 的节点，游离节点上
    // addRange 会被忽略（isCollapsed 恒为 true，断言会假通过）。
    document.body.appendChild(root);
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.isCollapsed).toBe(false);

    const event = dispatchClick(span);
    expect(handlePreviewClick(event, root)).toBe(false);
    expect(lines).toEqual([]);

    selection?.removeAllRanges();
  });

  it('does NOT jump on a non-primary button (right click)', () => {
    const lines = listenGotoLine();
    const root = makeRoot(
      '<div data-line-anchor="row"><p data-source-line="3"><span data-line-row="3">t</span></p></div>',
    );
    const span = root.querySelector('span') as HTMLElement;

    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 2 });
    span.dispatchEvent(event);

    expect(handlePreviewClick(event, root)).toBe(false);
    expect(lines).toEqual([]);
  });

  it('still lets C3 swallow the copy button before R2 sees the click', () => {
    const lines = listenGotoLine();
    const root = makeRoot(
      '<div data-line-anchor="row"><pre data-source-line="2"><code>x</code></pre></div>',
    );
    enhanceCodeBlocks(root);
    const btn = root.querySelector(`.${COPY_BTN_CLASS}`) as HTMLElement;

    const event = dispatchClick(btn);
    expect(handlePreviewClick(event, root)).toBe(true);
    // 复制按钮归 C3，不该同时把编辑器跳走
    expect(lines).toEqual([]);
  });
});
