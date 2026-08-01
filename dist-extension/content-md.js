/**
 * MDnote content script — 浏览器直接打开 .md 文件时的接管入口（#1）
 *
 * 作用：在 file:// 或 http(s):// 的 Markdown 文件页面上注入一个
 * 「用 MDnote 打开」浮动按钮，点击后读取文件内容并转交给
 * background，由 background 打开 MDnote 编辑器标签页。
 *
 * 前置条件：
 * - file:// 文件需用户在 chrome://extensions → MDnote → 勾选「允许访问文件网址」
 * - 本脚本由 manifest.json content_scripts 注入（matches 限定 .md 后缀）
 *
 * 说明：这是普通脚本（非 ES module），在页面上下文中运行，IIFE 包裹避免污染全局。
 */
(() => {
  'use strict';

  // 双保险：仅处理 Markdown 文件页（matches 已过滤，这里再校验一次）
  const path = (location.pathname || '').toLowerCase();
  if (!/\.(md|markdown|mdown|mkd)$/.test(path)) return;

  // 防止重复注入
  if (document.getElementById('mdnote-open-btn')) return;

  // 扩展不可用时（content script 已注入说明扩展存在）静默退出
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  const BTN_ID = 'mdnote-open-btn';

  const btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.textContent = 'MDnote';
  btn.title = '用 MDnote 打开此 Markdown 文件';

  const baseStyle = {
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
  };
  Object.assign(btn.style, baseStyle);

  btn.addEventListener('mouseenter', () => { btn.style.background = '#1d4ed8'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = '#2563eb'; });

  const resetBtn = () => {
    btn.disabled = false;
    btn.textContent = 'MDnote';
  };

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '打开中…';

    try {
      // 读取文件内容：file:// 需开启"允许访问文件网址"；http(s) 页面为同源读取
      const resp = await fetch(location.href);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const content = await resp.text();

      const name = path.split('/').pop() || 'Opened File.md';
      const res = await chrome.runtime.sendMessage({
        type: 'md-file-open',
        payload: { name, content, url: location.href },
      });

      if (!res || !res.ok) throw new Error('extension open failed');

      // 打开成功：新标签页已打开编辑器，本页保留
      btn.textContent = '已打开 MDnote ✓';
      setTimeout(resetBtn, 1500);
    } catch (err) {
      console.warn('[MDnote] Failed to open file from content script:', err);
      btn.textContent = '打开失败';
      btn.title =
        '读取文件失败：请确认已在 chrome://extensions → MDnote 详情 → 勾选「允许访问文件网址」，然后重试';
      setTimeout(resetBtn, 3000);
    }
  });

  // 挂载到页面
  (document.body || document.documentElement).appendChild(btn);
})();
