/**
 * Error handler — 白屏调试（外部引用，满足 MV3 CSP script-src 'self'）
 *
 * 最早捕获所有错误并显示在页面上，帮助调试白屏/加载失败问题。
 * 必须在 React/模块脚本加载前执行（editor.html 中排在 main.tsx 之前）。
 */
(function () {
  'use strict';

  /**
   * 创建错误显示元素并附加到 body。
   * @param {string} text 错误文本
   */
  function showErrorBanner(text) {
    var d = document.createElement('div');
    d.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:99999;' +
      'background:#fee;color:#c00;padding:12px;font-size:13px;' +
      'font-family:monospace;white-space:pre-wrap;' +
      'border-bottom:2px solid #c00;max-height:50vh;overflow:auto;';
    d.textContent = text;
    document.body.appendChild(d);
  }

  // 捕获同步错误
  window.addEventListener('error', function (e) {
    showErrorBanner(
      '[ERROR] ' + e.message + ' at ' + e.filename + ':' + e.lineno + ':' + e.colno,
    );
  });

  // 捕获未处理的 Promise rejection
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    var text = reason && reason.stack ? reason.stack : String(reason);
    showErrorBanner('[UNHANDLED] ' + text);
  });
})();
