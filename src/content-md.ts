/**
 * MDnote content script（#1）— 浏览器打开 .md 文件时自动跳转编辑器
 *
 * 由 esbuild 打包为 IIFE 格式的 content-md.js（scripts/build-content.mjs），
 * 内联 markdown-it（仅用于轻量解析文件名等，主要职责是读取内容），无外部 import。
 *
 * 行为（按用户要求：不要渲染步骤，直接打开编辑器）：
 * 1. 检测当前页面为 Markdown 文件（file:// 或 http(s)://）
 * 2. 读取文件内容（fetch 优先，失败兜底读页面纯文本）
 * 3. 自动发送 md-file-open 消息 → background 打开 MDnote 编辑器标签页并注入内容
 *    （相当于用户自动点击了「用 MDnote 编辑」按钮）
 *
 * 前置条件：
 * - file:// 文件需用户在 chrome://extensions → MDnote → 勾选「允许访问文件网址」
 */

// ──────────────────────────────────────────────
// 主流程（自执行）
// ──────────────────────────────────────────────

(() => {
  'use strict';

  // 仅处理 Markdown 文件页
  const path = (location.pathname || '').toLowerCase();
  if (!/\.(md|markdown|mdown|mkd)$/.test(path)) return;
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
  // 防止重复触发（页面可能被多次注入）
  if ((window as unknown as { __mdnoteAutoOpened?: boolean }).__mdnoteAutoOpened) return;
  (window as unknown as { __mdnoteAutoOpened?: boolean }).__mdnoteAutoOpened = true;

  /** 读取页面 Markdown 内容 */
  async function readPageContent(): Promise<string> {
    // 优先 fetch（http/https 同源读取；file:// 已授权时部分可用）
    try {
      const resp = await fetch(location.href, { cache: 'no-store' });
      if (resp.ok) {
        const text = await resp.text();
        if (text && text.trim().length > 0) return text;
      }
    } catch {
      // fall through
    }
    // 兜底：file:// 等 fetch 受 CORS 限制时，读取 Chrome 已渲染的纯文本
    const bodyText = document.body?.innerText || document.body?.textContent || '';
    if (bodyText && bodyText.trim().length > 0) {
      return bodyText;
    }
    throw new Error('cannot read file content');
  }

  (async () => {
    try {
      const content = await readPageContent();
      const name = path.split('/').pop() || 'Opened File.md';

      const res = await chrome.runtime.sendMessage({
        type: 'md-file-open',
        payload: { name, content, url: location.href },
      });

      if (!res || !res.ok) {
        console.warn('[MDnote] Failed to open in editor:', res?.error || 'no response');
      }
      // Background will open editor tab and close this plain-text tab
    } catch (err) {
      console.warn('[MDnote] Auto-open failed:', err);
    }
  })();
})();
