/**
 * 主题初始化脚本（外部引用，满足 MV3 CSP script-src 'self'）
 *
 * 替代 index.html 中的内联主题检测脚本。
 *
 * 策略：
 * 1. 首帧同步：用 prefers-color-scheme 媒体查询设置初始主题（消除大部分闪烁）
 * 2. 异步覆盖：读取 chrome.storage.local 中的用户持久化主题，加载后切换
 *
 * 已知妥协：
 * - chrome.storage.local 是异步的，首帧到异步读取完成之间可能有一次主题闪烁
 *   （例如系统是 light 但用户偏好 dark）。这是 MV3 的固有限制，无法完全消除。
 * - localStorage 在 MV3 扩展页面中仍可用（同 origin），但跨上下文状态应使用
 *   chrome.storage（M08 分层存储策略）。此处优先 chrome.storage，降级 localStorage。
 */

(function () {
  'use strict';

  /**
   * 首帧同步设置主题：优先 localStorage（同步），降级 prefers-color-scheme。
   * 这一步必须在 React 加载前完成，避免主题闪烁。
   */
  function setInitialTheme() {
    var theme = null;

    // 1. 尝试 localStorage（同步，桌面版遗留兼容）
    try {
      theme = localStorage.getItem('mdnote-theme');
    } catch (e) {
      // localStorage 可能不可用（隐私模式等）
    }

    // 2. 降级：用系统偏好
    if (!theme) {
      var prefersDark = window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;
      theme = prefersDark ? 'dark' : 'light';
    }

    document.documentElement.setAttribute('data-theme', theme);
  }

  /**
   * 异步从 chrome.storage 读取用户持久化主题，覆盖首帧同步设置。
   * 仅在 chrome.storage 可用时执行（扩展环境），否则跳过。
   */
  function applyPersistedTheme() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      return;
    }

    try {
      chrome.storage.local.get('mdnote-theme', function (result) {
        var storedTheme = result && result['mdnote-theme'];
        if (storedTheme && (storedTheme === 'light' || storedTheme === 'dark')) {
          document.documentElement.setAttribute('data-theme', storedTheme);
        }
      });
    } catch (e) {
      // chrome.storage 异常时静默降级，首帧同步设置已足够
    }
  }

  // 执行
  setInitialTheme();
  applyPersistedTheme();
})();
