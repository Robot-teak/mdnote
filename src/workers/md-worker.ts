/**
 * Web Worker for Markdown parsing and rendering.
 * Runs markdown-it + highlight.js off the main thread.
 *
 * Uses highlight.js/lib/core + common languages only to reduce bundle size.
 */
import MarkdownIt from 'markdown-it';
// 只导入核心 + 常用语言，避免导入全部 190+ 语言
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import shell from 'highlight.js/lib/languages/shell';
import go from 'highlight.js/lib/languages/go';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';
import diff from 'highlight.js/lib/languages/diff';

import type { WorkerIncomingMessage, WorkerOutgoingMessage, TocItem } from '../types';
import { LINE_ANCHOR_MAX_SOURCE_BYTES } from '../lib/constants';

// 注册常用语言
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('java', java);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('sh', shell);
hljs.registerLanguage('go', go);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('kt', kotlin);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('diff', diff);

// Initialize markdown-it with GFM support and syntax highlighting
const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true,  // 识别单个换行符为 <br>
});

// GFM Task List 支持：将 [ ] 和 [x] 渲染为 checkbox
md.core.ruler.push('task_list', (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'inline' && token.children) {
      // 检查是否是列表项，内容以 [ ] 或 [x] 开头
      for (let j = 0; j < token.children.length; j++) {
        const child = token.children[j];
        if (child.type === 'text') {
          const match = child.content.match(/^\[([ xX])\]\s*/);
          if (match) {
            const checked = match[1] !== ' ';
            // 替换文本为 checkbox + 剩余文本
            child.content = child.content.slice(match[0].length);
            // 在文本前插入 checkbox token
            const checkbox = new state.Token('html_inline', '', 0);
            checkbox.content = `<input type="checkbox" ${checked ? 'checked' : ''} disabled /> `;
            token.children.splice(j, 0, checkbox);
            break;
          }
        }
      }
    }
  }
});

// ──────────────────────────────────────────────
// R3：编辑→预览定位锚点（PRD §3.1 / §3.3，决策 D1）
// ──────────────────────────────────────────────

/**
 * 行锚点档位。
 * - `row`   = B 增强档：额外打行级 span 锚点 `data-line-row`（源码 ≤ 256KB）
 * - `block` = A 基线档：只打块属性，块内按行比例插值（源码 > 256KB，零 DOM 膨胀）
 */
type LineAnchorMode = 'row' | 'block';

/** markdown-it Token 类型（从实例反推，避免依赖深层 d.mts 路径） */
type MdToken = ReturnType<typeof md.parse>[number];

/** markdown-it core rule 的 state 类型 */
type MdStateCore = Parameters<Parameters<typeof md.core.ruler.push>[1]>[0];

/**
 * 计算字符串的 UTF-8 字节数。
 *
 * 只在「UTF-16 长度 ≤ 阈值」时调用（UTF-8 字节数恒 ≥ UTF-16 长度，
 * 长度超阈值即可直接判为 A 档），因此最坏也只是扫 256K 个字符，开销可忽略；
 * 20MB 文档走长度短路，不会进这个函数。
 *
 * @param str 输入字符串
 * @returns UTF-8 字节数
 */
function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      // 代理对（high + low surrogate）→ 4 字节，低代理位不再单独计
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * 判定本次渲染走哪一档（PRD §3.1 / §3.2）。
 *
 * 判定维度是**源码字节数**：渲染前即已知，且与行数强相关；
 * 若改用渲染后 HTML 大小，同一文档会在两档之间抖动。
 *
 * @param src Markdown 源码
 * @returns true = B 增强档（行级 span 锚点）
 */
function shouldUseRowAnchors(src: string): boolean {
  // UTF-8 字节数恒 ≥ UTF-16 code unit 数，长度超阈值必然字节也超 → 直接短路，
  // 避免对 20MB 文档做无谓的全量扫描。
  if (src.length > LINE_ANCHOR_MAX_SOURCE_BYTES) return false;
  return utf8ByteLength(src) <= LINE_ANCHOR_MAX_SOURCE_BYTES;
}

/**
 * 判断 inline 子 token 区间 [from, to) 是否是「自平衡」的。
 *
 * 自平衡 = 区间内 nesting 累加为 0，且任意前缀累加都 ≥ 0。
 * 只有自平衡的区间才能被 `<span>` 包起来，否则会出现
 * `<span><em>a</span>b</em>` 这类标签交叉错配（DOM 会被浏览器纠错、结构被拆散）。
 *
 * @param children inline token 的子 token 数组
 * @param from 区间起始下标（含）
 * @param to 区间结束下标（不含）
 * @returns 该区间能否安全地整体包一层 span
 */
function isBalancedRange(children: MdToken[], from: number, to: number): boolean {
  let depth = 0;
  for (let i = from; i < to; i++) {
    depth += children[i].nesting;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * B 增强档：把 inline token 内按源码行切开，逐行包 `<span data-line-row="N">`。
 *
 * 思路（markdown-it 的 inline token 本身不给「每行」的映射，只能自己推）：
 * - 块解析器给 `inline` token 填了 `map = [startLine, endLine]`（表格单元格的
 *   inline 没有 map，退化为继承最近外层块级 token 的 map）
 * - inline 内部每遇到一个 `softbreak` / `hardbreak` 叶子 token，就等于跨过一条源码行
 * - 因此：从 `map[0]` 起，每越过一个 break 行号 +1，把 break 之间的 token 分组，
 *   逐组包一层 span
 *
 * 安全性（关键）：
 * 1. 只在**自平衡**的分组外打 span —— 例如 `**foo [link\ntext](/x) bar**` 这种
 *    「开标签跨行」的结构，分组不平衡，直接跳过不打，宁可少一个锚点也不拆坏 DOM
 * 2. `softbreak` / `hardbreak` 本身留在 span **外面**，不进任何 span
 * 3. 代码块（`fence` / `code_block`）根本没有 inline token，天然不会被插入 span
 * 4. 表格只在每个单元格的 inline 内部打 span，`<table>` / `<tr>` 结构完全不动
 *
 * @param state markdown-it core state（用于构造 Token）
 * @param inlineToken 待处理的 inline token
 * @param startLine 该 inline 的起始源码行（0-based，含）
 * @param endLine 该 inline 的结束源码行（0-based，不含）
 */
function wrapInlineLinesBySourceLine(
  state: MdStateCore,
  inlineToken: MdToken,
  startLine: number,
  endLine: number,
): void {
  const children = inlineToken.children;
  if (!children || children.length === 0) return;

  if (endLine <= startLine) endLine = startLine + 1;

  // 收集所有行边界（softbreak = 软换行，hardbreak = 行尾两空格 / 反斜杠）
  const breakIdx: number[] = [];
  for (let i = 0; i < children.length; i++) {
    if (children[i].type === 'softbreak' || children[i].type === 'hardbreak') {
      breakIdx.push(i);
    }
  }

  // 单行块（标题、表格单元格、列表项…）：整段包一个 span，无需切分
  if (breakIdx.length === 0) {
    if (isBalancedRange(children, 0, children.length)) {
      const open = new state.Token('html_inline', '', 0);
      open.content = `<span data-line-row="${startLine}">`;
      const close = new state.Token('html_inline', '', 0);
      close.content = '</span>';
      children.unshift(open);
      children.push(close);
    }
    return;
  }

  const newChildren: MdToken[] = [];
  let cursor = 0;
  let line = startLine;

  for (let bi = 0; bi <= breakIdx.length; bi++) {
    const groupStart = cursor;
    const groupEnd = bi < breakIdx.length ? breakIdx[bi] : children.length;

    // 行号不得超过块结束行；分组必须自平衡，否则不打 span（宁缺毋坏）
    const canWrap = line < endLine && isBalancedRange(children, groupStart, groupEnd);

    if (canWrap && groupEnd > groupStart) {
      const open = new state.Token('html_inline', '', 0);
      open.content = `<span data-line-row="${line}">`;
      newChildren.push(open);
    }
    for (let i = groupStart; i < groupEnd; i++) newChildren.push(children[i]);
    if (canWrap && groupEnd > groupStart) {
      const close = new state.Token('html_inline', '', 0);
      close.content = '</span>';
      newChildren.push(close);
    }

    // break token 本身留在 span 之间
    if (bi < breakIdx.length) {
      newChildren.push(children[breakIdx[bi]]);
      cursor = breakIdx[bi] + 1;
    }
    line += 1;
  }

  inlineToken.children = newChildren;
}

/**
 * F1 / R3：给块级 token 打定位锚点属性，并在 B 档额外打行级 span 锚点。
 *
 * 输出契约（供 PreviewPane 消费）：
 * - `data-source-line`     块级**起始行**，0-based（语义与取值保持原样，不动）
 * - `data-source-line-end` 块级**结束行**（不含），0-based；A/B 两档都打，供 A 档块内插值
 * - `data-line-row`        **行级**锚点（0-based），只打在 B 档的 `<span>` 上；
 *                          刻意不复用 `data-source-line`，避免 R4 行号 gutter 的
 *                          `[data-source-line]` 纯属性选择器把满屏数字画出来（07 §13.2 约束 1）
 * - `data-line-anchor`     根标记，`"row"` | `"block"`，打在首个顶层块元素上
 *
 * 档位由 `env.lineAnchorRows` 决定（每次渲染重新判定）。
 */
md.core.ruler.push('source_line_attr', (state) => {
  const tokens = state.tokens;
  const rowMode: boolean = state.env?.lineAnchorRows === true;

  // 块级 map 栈：表格单元格（th/td）的 inline token 没有 map，
  // 需要继承最近外层块级 token 的行范围。
  // 每个 nesting===1 的 token 都入栈（没有 map 的继承栈顶），nesting===-1 出栈。
  // 用扁平 number[] 存 [start, end] 对，避免为每个块 token 分配一个数组
  // （20MB 文档有上百万个块 token，逐个 new Array 会明显增加 GC 压力）。
  const blockMapStack: number[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const hasMap: boolean = !!token.map && typeof token.map[0] === 'number';

    if (token.nesting === 1) {
      if (hasMap) {
        const startLine = token.map![0];
        const endLine = typeof token.map![1] === 'number' && token.map![1] > startLine
          ? token.map![1]
          : startLine + 1;
        blockMapStack.push(startLine, endLine);
      } else if (blockMapStack.length >= 2) {
        // 没有 map（如 <th> / <td>）：继承栈顶那一对
        blockMapStack.push(
          blockMapStack[blockMapStack.length - 2],
          blockMapStack[blockMapStack.length - 1],
        );
      } else {
        blockMapStack.push(-1, -1); // 无行信息
      }
    } else if (token.nesting === -1) {
      blockMapStack.length -= 2;
      if (blockMapStack.length < 0) blockMapStack.length = 0;
    }

    // ① 块级开标签：打 data-source-line / data-source-line-end（A/B 两档都打）
    //
    // `nesting === 0` 是 v0.5.0 补的：围栏代码块（`fence`）、缩进代码块
    // （`code_block`）、分隔线（`hr`）在 markdown-it 里都是 **nesting===0** 的
    // 独立块，此前拿不到源行锚点，R3/R2 在代码块与 `---` 上会退化成「找不到锚点」。
    //
    // ⚠️ 必须排除 `inline` 与 `html_block`：
    //   - `inline` 同样是 nesting===0 且有 map，一旦进这个分支就 `continue`，
    //     分支②（B 档行级 span）永远执行不到 —— 根标记仍写着 `row`，
    //     实际一个 `data-line-row` 都不打，B 档会**静默退化**（实测复现）。
    //   - `html_block` 的 renderer 直接吐 `token.content`、不渲染 attrs，
    //     打了也进不了 DOM，纯属浪费体积。
    if (hasMap && token.type !== 'inline' && token.type !== 'html_block'
        && (token.nesting === 1 || token.nesting === 0 || token.type.endsWith('_open'))) {
      const startLine = token.map![0];
      const endLine = typeof token.map![1] === 'number' && token.map![1] > startLine
        ? token.map![1]
        : startLine + 1;
      token.attrSet('data-source-line', String(startLine));
      // 单行块（标题 / 列表项 / 表格行…）的结束行恒为 start+1，下游可直接推导，
      // 因此**不打**这个属性。
      // 实测（20MB 文档）：无条件给每个块级 token 都打会让 HTML 从 75.9MB 涨到
      // 125.9MB（+66%），20MB 渲染 9.3s → 28.2s（本机 4GB 内存，还叠加了 swap）。
      // 只给多行块打，A 档体积与耗时回到基线附近（见 04 实现日志 §性能）。
      // ⚠️ 下游契约：读不到 data-source-line-end 时，结束行按 start + 1 处理。
      if (endLine - startLine > 1) {
        token.attrSet('data-source-line-end', String(endLine));
      }
      continue;
    }

    // ② 行级 span 锚点（仅 B 增强档）
    if (rowMode && token.type === 'inline') {
      if (hasMap) {
        const startLine = token.map![0];
        const endLine = typeof token.map![1] === 'number' && token.map![1] > startLine
          ? token.map![1]
          : startLine + 1;
        wrapInlineLinesBySourceLine(state, token, startLine, endLine);
      } else if (blockMapStack.length >= 2) {
        const startLine = blockMapStack[blockMapStack.length - 2];
        const endLine = blockMapStack[blockMapStack.length - 1];
        if (startLine >= 0) {
          wrapInlineLinesBySourceLine(state, token, startLine, endLine);
        }
      }
    }
  }

  // ③ 根标记：打在第一个顶层块元素上（只打一处，避免大文档 HTML 体积膨胀）
  const mode: LineAnchorMode = rowMode ? 'row' : 'block';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // html_block 的 renderer 直接吐 token.content、不渲染 attrs，跳过它
    if (token.level === 0 && token.nesting !== -1 && token.type !== 'html_block') {
      token.attrSet('data-line-anchor', mode);
      break;
    }
  }
});

/**
 * 高亮为**内层 HTML**（不含 `<pre>` / `<code>` 外壳）。
 *
 * 刻意不拼 `<pre>`：markdown-it 的 fence renderer 一旦发现
 * `options.highlight()` 的返回值以 `<pre` 开头，就直接 `return highlighted`
 * （renderer.mjs:48-51），**token.attrs 被整体丢弃** —— 也就是说
 * `data-source-line` 永远到不了围栏代码块的 DOM 上（实测确认）。
 * 所以「拼 `<pre>` 并带上 attrs」的职责收归下面的自定义 fence 规则，
 * 这里只负责吐内层。
 *
 * @param code 代码原文
 * @param lang 围栏语言标识（可能为空）
 * @returns 内层 HTML（已转义或已高亮）
 */
function highlightToInnerHtml(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value;
    } catch {
      // 高亮失败 → 走下面的纯转义
    }
  }
  // 不自动检测，直接转义（加快速度）
  return escapeHtml(code);
}

// Configure highlight.js as the code block renderer
md.options.highlight = function (code: string, lang: string): string {
  // Fix 7：把语言写到 `<pre>` 上供预览类型条读取（缩进代码块无 lang → 不写）。
  const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
  return `<pre class="hljs"${langAttr}><code>${highlightToInnerHtml(code, lang)}</code></pre>`;
};

/**
 * 接管 fence（``` 围栏代码块）渲染：自己拼 `<pre>`，**保留 token.attrs**。
 *
 * ⚠️ 为什么必须接管（否则上面那处 `nesting === 0` 对 fence 是空转）：
 * markdown-it 的 fence renderer 一旦发现 `options.highlight()` 的返回值以
 * `<pre` 开头就 `return highlighted` —— **token.attrs 被整体丢弃**
 * （`node_modules/markdown-it/lib/renderer.mjs:48-51`）。而 `md.options.highlight`
 * 返回的正是 `<pre class="hljs">…`，所以围栏代码块**从来没拿到过**
 * `data-source-line`，R2 点代码块 / R3 定位代码块都无从下手。
 *
 * 只有这样才能让 `data-source-line`（以及后续 R4 的 `data-line-no`）落在
 * `<pre>` 上。R1 的 mermaid 容器锚点也依赖它（`fenceStartLine` 同源）。
 *
 * 输出形态与原默认渲染器保持一致（`<pre class="hljs"><code>…</code></pre>`），
 * 只是多带了 attrs，避免 hljs 主题（`.hljs`）与既有样式失效。
 *
 * ✅ 已由 team-lead 于批次 B2（2026-09-19）批准。
 */
md.renderer.rules.fence = function (tokens, idx, _options, _env, self) {
  const token = tokens[idx];
  const langName = token.info ? md.utils.unescapeAll(token.info).trim().split(/\s+/)[0] : '';
  const attrs = self.renderAttrs(token);
  // fence token 自身不带 class（默认渲染器是本地临时拼的），这里补回 `.hljs`；
  // 万一上游给它挂了 class，就不要重复输出第二个 class 属性。
  const preClass = /\sclass=/.test(attrs) ? '' : ' class="hljs"';
  // Fix 7：把围栏语言写到 `<pre>` 上（`data-lang`），供预览类型条读取；
  // 只在有语言时输出（无信息围栏不写 → 预览侧兜底 'text'）。escapeHtml 防引号/标签注入。
  const langAttr = langName ? ` data-lang="${escapeHtml(langName)}"` : '';
  return `<pre${preClass}${langAttr}${attrs}><code>${highlightToInnerHtml(token.content, langName)}</code></pre>\n`;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Check if a line is inside a code block (fenced ``` or indented) */
function isInsideCodeBlock(content: string, lineNum: number): boolean {
  const lines = content.split('\n');
  
  let fencedBlockStart = -1;
  
  // 首先找到 lineNum 之前最近的 fenced block 开始/结束位置
  for (let i = 0; i <= lineNum; i++) {
    const line = lines[i];
    const fencedMatch = line.match(/^(```|~~~)/);
    if (fencedMatch) {
      if (fencedBlockStart >= 0) {
        fencedBlockStart = -1;
      } else {
        fencedBlockStart = i;
      }
    }
  }
  
  if (fencedBlockStart >= 0) {
    return lineNum > fencedBlockStart;
  }
  
  return false;
}

/** 去掉标题中的 inline markdown 格式（加粗、斜体、链接等）*/
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **加粗** → 加粗
    .replace(/__(.+?)__/g, '$1')         // __加粗__ → 加粗
    .replace(/\*(.+?)\*/g, '$1')         // *斜体* → 斜体
    .replace(/_(.+?)_/g, '$1')           // _斜体_ → 斜体
    .replace(/~~(.+?)~~/g, '$1')         // ~~删除线~~ → 删除线
    .replace(/`(.+?)`/g, '$1')           // `行内代码` → 行内代码
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')  // [链接](url) → 链接
    .replace(/!\[.*?\]\(.+?\)/g, '')     // ![图片](url) → 空
    .trim();
}

/** Extract TOC from raw content, excluding headings inside code blocks */
function extractTOC(content: string): TocItem[] {
  const lines = content.split('\n');
  const items: TocItem[] = [];
  const HEADING_REGEX = /^(#{1,6})\s+(.+)$/;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    // Skip lines inside code blocks
    if (isInsideCodeBlock(content, lineNum)) continue;

    const match = lines[lineNum].match(HEADING_REGEX);
    if (!match) continue;

    const level = match[1].length;
    const text = stripInlineMarkdown(match[2].trim());

    let position = 0;
    for (let i = 0; i < lineNum; i++) {
      position += lines[i].length + 1;
    }

    items.push({
      id: `heading-${items.length}-${lineNum}`,
      level,
      text,
      line: lineNum,
      position: position + match[1].length + 1,
    });

    if (items.length >= 10_000) break;
  }

  return items;
}

/** Build a complete standalone HTML document with inline styles */
function buildFullHTML(bodyHtml: string, theme: 'light' | 'dark'): string {
  const bgColor = theme === 'dark' ? '#1e1e1e' : '#ffffff';
  const textColor = theme === 'dark' ? '#d4d4d4' : '#1a1a1a';
  const codeBg = theme === 'dark' ? '#2d2d30' : '#f5f5f5';
  const headingColor = theme === 'dark' ? '#569cd6' : '#1a1a2e';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MDnote Export</title>
<style>
  body { margin: 0; padding: 40px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: ${bgColor}; color: ${textColor}; line-height: 1.7; max-width: 860px; margin-left: auto; margin-right: auto; }
  h1, h2, h3, h4, h5, h6 { color: ${headingColor}; margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 600; line-height: 1.3; }
  h1 { font-size: 2.2em; border-bottom: 2px solid #e0e0e0; padding-bottom: 0.3em; }
  h2 { font-size: 1.75em; border-bottom: 1px solid #e0e0e0; padding-bottom: 0.3em; }
  h3 { font-size: 1.4em; }
  p { margin: 0 0 1em; }
  pre { background: ${codeBg}; border-radius: 6px; padding: 16px; overflow-x: auto; margin: 0 0 1em; white-space: pre-wrap; word-break: break-all; }
  code { font-family: "SF Mono", "Fira Code", Consolas, monospace; font-size: 0.9em; background: ${codeBg}; padding: 2px 6px; border-radius: 3px; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #569cd6; margin: 0 0 1em; padding: 0.5em 1em; color: #888; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 1em; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  img { max-width: 100%; height: auto; }
  a { color: #0366d6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  hr { border: none; border-top: 2px solid #eee; margin: 2em 0; }
  ul, ol { padding-left: 2em; margin: 0 0 1em; }
  li { margin-bottom: 0.25em; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/**
 * 渲染 Markdown → HTML，并按源码大小自动选择定位锚点档位（PRD §3.3）。
 *
 * @param src Markdown 源码
 * @param allowRowAnchors 是否允许 B 增强档（行级 span 锚点）。
 *                        预览渲染传 `shouldUseRowAnchors(src)`（每次重新判定）；
 *                        导出 HTML 固定传 false —— 导出物是静态文件，
 *                        行级 span 对它是纯负担（且 PRD R4 明确「行号不进入导出」）。
 * @returns 带锚点的 HTML
 */
function renderWithLineAnchors(src: string, allowRowAnchors: boolean): string {
  return md.render(src, { lineAnchorRows: allowRowAnchors });
}

// Message handler — dispatches based on message type
self.onmessage = async (e: MessageEvent<WorkerIncomingMessage>): Promise<void> => {
  const msg = e.data;

  try {
    switch (msg.type) {
      case 'RENDER': {
        const html = renderWithLineAnchors(msg.payload, shouldUseRowAnchors(msg.payload));
        self.postMessage({ type: 'RENDER_DONE', html } as WorkerOutgoingMessage);
        break;
      }

      case 'EXTRACT_TOC': {
        const items = extractTOC(msg.payload);
        self.postMessage({ type: 'EXTRACT_TOC_DONE', items } as WorkerOutgoingMessage);
        break;
      }

      case 'EXPORT_HTML': {
        const bodyHtml = renderWithLineAnchors(msg.payload.md, false);
        const fullHtml = buildFullHTML(bodyHtml, msg.payload.theme);
        self.postMessage({ type: 'EXPORT_HTML_DONE', html: fullHtml } as WorkerOutgoingMessage);
        break;
      }

      default: {
        self.postMessage({
          type: 'ERROR',
          message: `Unknown worker message type: ${(msg as { type: string }).type}`,
        } as WorkerOutgoingMessage);
      }
    }
  } catch (error) {
    self.postMessage({
      type: 'ERROR',
      message: error instanceof Error ? error.message : String(error),
    } as WorkerOutgoingMessage);
  }
};
