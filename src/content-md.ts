/**
 * MDnote content script（#1）— 浏览器直接打开 .md 文件时的自动接管
 *
 * 由 esbuild 打包为 IIFE 格式的 content-md.js（scripts/build-content.mjs），
 * 内联 markdown-it + highlight.js，无任何外部 import —— 规避 content script
 * 动态 import 扩展模块的兼容性问题。
 *
 * 行为：
 * 1. 检测当前页面为 Markdown 文件（file:// 或 http(s)://）
 * 2. 读取页面内容 → markdown-it 渲染 → 替换页面为渲染样式（MarkView 模式）
 * 3. 注入「MDnote ✎ 编辑」浮动按钮：点击把内容交给 background 打开编辑器
 *
 * 前置条件：
 * - file:// 文件需用户在 chrome://extensions → MDnote → 勾选「允许访问文件网址」
 */

import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('java', java);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('yaml', yaml);

/** markdown-it 实例（html: false 防 XSS，代码块 hljs 高亮） */
const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        // fall through
      }
    }
    return `<pre class="mdnote-code-plain"><code>${md.utils.escapeHtml(code)}</code></pre>`;
  },
});

// ──────────────────────────────────────────────
// 主流程（自执行）
// ──────────────────────────────────────────────

(() => {
  'use strict';

  // 仅处理 Markdown 文件页
  const path = (location.pathname || '').toLowerCase();
  if (!/\.(md|markdown|mdown|mkd)$/.test(path)) return;
  if (document.getElementById('mdnote-open-btn')) return;
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  let originalContent: string | null = null;

  /** 注入 hljs 主题 CSS */
  function injectHljsTheme(): void {
    try {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('hljs-themes/github.min.css');
      document.head?.appendChild(link);
    } catch {
      // 忽略
    }
  }

  /** 注入「MDnote ✎ 编辑」按钮 */
  function injectOpenButton(): void {
    if (document.getElementById('mdnote-open-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'mdnote-open-btn';
    btn.textContent = 'MDnote ✎ 编辑';
    btn.title = '用 MDnote 打开此 Markdown 文件编辑';

    Object.assign(btn.style, {
      position: 'fixed',
      top: '16px',
      right: '16px',
      zIndex: '2147483647',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '8px 14px',
      borderRadius: '8px',
      border: 'none',
      background: '#2563eb',
      color: '#ffffff',
      fontSize: '13px',
      fontWeight: 600,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      cursor: 'pointer',
      boxShadow: '0 2px 10px rgba(0, 0, 0, 0.25)',
      transition: 'background 0.15s ease',
      lineHeight: 1,
    });

    btn.addEventListener('mouseenter', () => { btn.style.background = '#1d4ed8'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#2563eb'; });

    const resetBtn = () => {
      btn.disabled = false;
      btn.textContent = 'MDnote ✎ 编辑';
    };

    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '打开中…';
      try {
        const content = originalContent ?? (await fetch(location.href, { cache: 'no-store' }).then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        }));
        const name = path.split('/').pop() || 'Opened File.md';
        const res = await chrome.runtime.sendMessage({
          type: 'md-file-open',
          payload: { name, content, url: location.href },
        });
        if (!res || !res.ok) throw new Error('extension open failed');
        btn.textContent = '已打开 MDnote ✓';
        setTimeout(resetBtn, 1500);
      } catch (err) {
        console.warn('[MDnote] Failed to open file from content script:', err);
        btn.textContent = '打开失败';
        btn.title = '读取文件失败：请确认已在 chrome://extensions → MDnote 详情 → 勾选「允许访问文件网址」，然后重试';
        setTimeout(resetBtn, 3000);
      }
    });

    (document.body || document.documentElement).appendChild(btn);
  }

  /** 渲染页面 */
  function renderPage(content: string): void {
    injectHljsTheme();

    const style = document.createElement('style');
    style.textContent = `
      #mdnote-rendered { max-width: 860px; margin: 48px auto 64px; padding: 0 24px;
        font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #1f2328; word-wrap: break-word; }
      #mdnote-rendered h1, #mdnote-rendered h2, #mdnote-rendered h3 {
        line-height: 1.3; margin: 1.4em 0 .6em; padding-bottom: .3em; border-bottom: 1px solid #d8dee4; }
      #mdnote-rendered h1 { font-size: 1.9em; } #mdnote-rendered h2 { font-size: 1.5em; } #mdnote-rendered h3 { font-size: 1.25em; }
      #mdnote-rendered a { color: #0969da; text-decoration: none; } #mdnote-rendered a:hover { text-decoration: underline; }
      #mdnote-rendered code { background: #eff1f3; border-radius: 4px; padding: .15em .35em; font: 13px/1.5 SFMono-Regular, Consolas, monospace; }
      #mdnote-rendered pre { background: #f6f8fa; border: 1px solid #d8dee4; border-radius: 6px; padding: 12px 16px; overflow-x: auto; }
      #mdnote-rendered pre code { background: none; padding: 0; font-size: 13.5px; }
      #mdnote-rendered blockquote { margin: 1em 0; padding: .2em 1em; color: #57606a; border-left: 4px solid #d0d7de; }
      #mdnote-rendered table { border-collapse: collapse; margin: 1em 0; }
      #mdnote-rendered th, #mdnote-rendered td { border: 1px solid #d8dee4; padding: 6px 13px; }
      #mdnote-rendered th { background: #f6f8fa; }
      #mdnote-rendered img { max-width: 100%; }
      #mdnote-rendered hr { border: none; border-top: 1px solid #d8dee4; margin: 2em 0; }
      #mdnote-rendered ul, #mdnote-rendered ol { padding-left: 1.8em; }
      @media (prefers-color-scheme: dark) {
        body { background: #0d1117; }
        #mdnote-rendered { color: #c9d1d9; }
        #mdnote-rendered h1, #mdnote-rendered h2, #mdnote-rendered h3 { border-bottom-color: #30363d; }
        #mdnote-rendered a { color: #58a6ff; }
        #mdnote-rendered code { background: #161b22; }
        #mdnote-rendered pre { background: #161b22; border-color: #30363d; }
        #mdnote-rendered blockquote { color: #8b949e; border-left-color: #30363d; }
        #mdnote-rendered th, #mdnote-rendered td { border-color: #30363d; }
        #mdnote-rendered th { background: #161b22; }
      }`;

    const topBar = document.createElement('div');
    topBar.id = 'mdnote-topbar';
    topBar.textContent = '由 MDnote 渲染';
    topBar.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:2147483646;padding:6px 16px;' +
      'background:#2563eb;color:#fff;font:600 12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;' +
      'text-align:center;box-shadow:0 1px 6px rgba(0,0,0,.2);';

    const wrapper = document.createElement('article');
    wrapper.id = 'mdnote-rendered';
    wrapper.innerHTML = md.render(content);

    document.documentElement.lang = 'zh-CN';
    document.head.appendChild(style);
    document.body.innerHTML = '';
    document.body.appendChild(wrapper);
    document.body.appendChild(topBar);
    document.title = (path.split('/').pop() || 'Markdown').replace(/\.(md|markdown|mdown|mkd)$/i, '');
  }

  // 主流程：读取 → 渲染 → 按钮（渲染失败降级为仅按钮）
  (async () => {
    try {
      const resp = await fetch(location.href, { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      originalContent = await resp.text();
      renderPage(originalContent);
    } catch (err) {
      console.warn('[MDnote] Auto-render failed, button-only mode:', err);
    }
    injectOpenButton();
  })();
})();
