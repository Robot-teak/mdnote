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

// Bug2 修复：给 heading 标签添加 data-source-line 属性
// 用于 TOC 点击时精确跳转到对应 heading
md.core.ruler.push('source_line_attr', (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'heading_open') {
      // token.map[0] 是源码行号（0-indexed）
      const line = token.map?.[0];
      if (typeof line === 'number') {
        token.attrSet('data-source-line', String(line));
      }
    }
  }
});

// Configure highlight.js as the code block renderer
md.options.highlight = function (code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang }).value}</code></pre>`;
    } catch {
      // Fall through to auto-detection
    }
  }

  // 不自动检测，直接转义（加快速度）
  return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
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

// Message handler — dispatches based on message type
self.onmessage = async (e: MessageEvent<WorkerIncomingMessage>): Promise<void> => {
  const msg = e.data;

  try {
    switch (msg.type) {
      case 'RENDER': {
        const html = md.render(msg.payload);
        self.postMessage({ type: 'RENDER_DONE', html } as WorkerOutgoingMessage);
        break;
      }

      case 'EXTRACT_TOC': {
        const items = extractTOC(msg.payload);
        self.postMessage({ type: 'EXTRACT_TOC_DONE', items } as WorkerOutgoingMessage);
        break;
      }

      case 'EXPORT_HTML': {
        const bodyHtml = md.render(msg.payload.md);
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
